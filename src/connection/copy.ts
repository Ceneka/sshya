import chalk from 'chalk';
import path from 'path';
import { spawn } from 'child_process';
import { expandHomePath, getConnectionByAlias, recordConnectionUsage, type Connection } from '../database';
import { ByteCapture, defaultMaxOutputBytes } from '../helpers/capture';
import { classifySshError, spawnFailure, type SshErrorKind } from '../helpers/errors';
import { resolveAliasForCommand, selectAlias } from '../helpers/selectAlias';
import { buildSshOptionArgs, type HostKeyChecking } from '../helpers/ssh';
import { clampTimeoutMs } from '../helpers/timer';
import { jsonEnabled, printJson } from '../output';

export interface CopyOptions {
    download?: boolean;
    recursive?: boolean;
    preserve?: boolean;
    json?: boolean;
    /** Abort the transfer after this many milliseconds. */
    timeoutMs?: number;
    /** Fail instead of prompting for a password. Defaults to true. */
    batchMode?: boolean;
    /** Reuse a pooled ControlMaster connection. Defaults to true. */
    reuse?: boolean;
    /** First-contact host key policy. */
    hostKeyChecking?: HostKeyChecking;
}

interface NormalizedCopyArgs {
    alias?: string;
    source?: string;
    destination?: string;
}

export interface CopyResult {
    ok: boolean;
    alias: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
    errorKind?: SshErrorKind;
    hint?: string;
}

const isAbsoluteRemotePath = (value: string): boolean => {
    return value.startsWith('/') || value.startsWith('~/') || value === '~';
};

const resolveRemotePath = (connection: Connection, value: string): string => {
    const remotePath = value.trim();
    const remoteBase = connection.remote_path?.trim();

    if (!remoteBase || isAbsoluteRemotePath(remotePath)) {
        return remotePath;
    }

    return path.posix.join(remoteBase, remotePath);
};

const buildRemoteSpec = (connection: Connection, remotePath: string): string => {
    return `${connection.user}@${connection.host}:${resolveRemotePath(connection, remotePath)}`;
};

/**
 * scp decides whether an operand is remote by looking for a colon before any
 * slash (`[user@]host:path`). sshya builds the remote side itself, so a *local*
 * operand with that shape would make scp open an SSH connection to a second
 * host — which turns a read-only "download" into an upload to an arbitrary
 * host. Reject those operands instead of letting scp reinterpret them.
 */
export const looksLikeRemoteCopyOperand = (value: string): boolean => {
    // Windows drive paths are local even though they contain a colon.
    if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(value)) {
        return false;
    }
    const colon = value.indexOf(':');
    if (colon <= 0) {
        return false;
    }
    const slash = value.indexOf('/');
    return slash === -1 || colon < slash;
};

export const copyLocalOperandProblem = (
    value: string,
    role: 'source' | 'destination',
): string | undefined => {
    if (value.startsWith('-')) {
        return `Refusing ${role} "${value}": a local path cannot start with "-" (prefix it with "./" if it is a real file name).`;
    }
    if (looksLikeRemoteCopyOperand(value)) {
        return `Refusing ${role} "${value}": it looks like a remote scp target (host:path). Local paths cannot contain ":" before a "/"; prefix it with "./" to force a local path.`;
    }
    return undefined;
};

export const buildCopyArgs = (
    connection: Connection,
    source: string,
    destination: string,
    options: Pick<CopyOptions, 'download' | 'recursive' | 'preserve' | 'batchMode' | 'reuse' | 'hostKeyChecking'> = {},
): string[] => {
    const args: string[] = [];
    if (connection.key_path) {
        args.push('-i', expandHomePath(connection.key_path) ?? connection.key_path);
    }
    if (connection.port) {
        args.push('-P', String(connection.port));
    }
    args.push(...buildSshOptionArgs(connection, {
        batchMode: options.batchMode ?? true,
        connectTimeout: 10,
        reuse: options.reuse,
        hostKeyChecking: options.hostKeyChecking,
    }));
    if (options.recursive) {
        args.push('-r');
    }
    if (options.preserve) {
        args.push('-p');
    }

    if (options.download) {
        args.push(buildRemoteSpec(connection, source), destination);
    } else {
        args.push(source, buildRemoteSpec(connection, destination));
    }

    return args;
};

export const executeCopy = (
    connection: Connection,
    source: string,
    destination: string,
    options: CopyOptions = {},
    mode: 'inherit' | 'capture' = 'capture',
): Promise<CopyResult> => {
    const startedAt = Date.now();
    const download = options.download === true;
    const localRole = download ? 'destination' : 'source';
    const localOperand = expandHomePath(download ? destination : source) ?? (download ? destination : source);
    const problem = copyLocalOperandProblem(localOperand, localRole);
    if (problem) {
        return Promise.resolve({
            ok: false,
            alias: connection.alias,
            exitCode: -1,
            stdout: '',
            stderr: `${problem}\n`,
            timedOut: false,
            durationMs: 0,
            errorKind: 'invalid-path',
            hint: problem,
        });
    }

    const args = buildCopyArgs(
        connection,
        download ? source : localOperand,
        download ? localOperand : destination,
        {
            ...options,
            batchMode: options.batchMode ?? true,
            reuse: options.reuse ?? true,
        },
    );
    const timeoutMs = clampTimeoutMs(options.timeoutMs);
    const maxBytes = defaultMaxOutputBytes();
    const stdoutCapture = new ByteCapture({ maxBytes });
    const stderrCapture = new ByteCapture({ maxBytes: Math.min(maxBytes, 16 * 1024) });

    return new Promise<CopyResult>((resolve) => {
        const child = spawn(process.env.SSHYA_SCP_BIN?.trim() || 'scp', args, {
            stdio: mode === 'inherit' ? ['inherit', 'inherit', 'pipe'] : ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });

        const killChild = (signal: NodeJS.Signals) => {
            if (child.pid === undefined) {
                return;
            }
            try {
                if (process.platform !== 'win32') {
                    process.kill(-child.pid, signal);
                } else {
                    child.kill(signal);
                }
            } catch {
                try {
                    child.kill(signal);
                } catch {
                    // The process already exited.
                }
            }
        };

        let timedOut = false;
        let settled = false;
        let spawnError: string | undefined;

        child.stdout?.on('data', (chunk: Buffer | string) => {
            stdoutCapture.write(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
            stderrCapture.write(chunk);
            if (mode === 'inherit') {
                process.stderr.write(chunk);
            }
        });

        let killTimer: NodeJS.Timeout | undefined;
        let forceKillTimer: NodeJS.Timeout | undefined;

        if (timeoutMs) {
            killTimer = setTimeout(() => {
                timedOut = true;
                killChild('SIGTERM');
                forceKillTimer = setTimeout(() => {
                    killChild('SIGKILL');
                    const settleTimer = setTimeout(() => finish(null), 500);
                    settleTimer.unref?.();
                }, 2000);
                forceKillTimer.unref?.();
            }, timeoutMs);
        }

        const finish = (exitCode: number | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            const ok = exitCode === 0 && !timedOut;
            const stderr = stderrCapture.text();
            const failure = spawnError
                ? spawnFailure(spawnError)
                : classifySshError(stderr, { timedOut, exitCode, timeoutMs });

            resolve({
                ok,
                alias: connection.alias,
                exitCode,
                stdout: stdoutCapture.text(),
                stderr,
                timedOut,
                durationMs: Date.now() - startedAt,
                ...(failure ? { errorKind: failure.kind, hint: failure.hint } : {}),
            });
        };

        child.on('error', (error: Error) => {
            spawnError = error.message;
            finish(-1);
        });
        child.on('close', (code) => finish(code));
    });
};

const normalizeCopyArgs = (first?: string, second?: string, third?: string): NormalizedCopyArgs => {
    if (third) {
        return { alias: first, source: second, destination: third };
    }

    if (first && second) {
        const maybeConnection = getConnectionByAlias(first);
        if (maybeConnection) {
            return { alias: first, source: second };
        }

        return { source: first, destination: second };
    }

    return { alias: first, source: second, destination: third };
};

export async function copyConnectionPrompt(
    first?: string,
    second?: string,
    third?: string,
    options: CopyOptions = {},
): Promise<void> {
    const json = jsonEnabled(options.json);
    const { download = false, recursive = false, preserve = false } = options;
    let { alias, source, destination } = normalizeCopyArgs(first, second, third);

    if (!source || !destination) {
        const message = 'Source and destination are required';
        if (json) {
            printJson({ ok: false, error: message });
        } else {
            console.error(chalk.red(message));
            console.error(chalk.grey('Usage: sshya copy [alias] <source> <destination>'));
            console.error(chalk.grey('       sshya copy --download [alias] <remote-source> <local-destination>'));
        }
        process.exit(1);
    }

    if (!alias) {
        if (!process.stdin.isTTY) {
            const message = 'Alias is required when stdin is not a TTY.';
            if (json) {
                printJson({ ok: false, error: message });
            } else {
                console.error(chalk.red(message));
                console.error(chalk.grey('Usage: sshya copy [alias] <source> <destination>'));
            }
            process.exit(1);
        }
        alias = await selectAlias(download ? 'Select a connection to copy from' : 'Select a connection to copy to');
    }

    const lookup = await resolveAliasForCommand(alias, { json });
    if (!lookup.ok) {
        if (json) {
            printJson({
                ok: false,
                error: `Alias not found: ${alias}`,
                suggestions: lookup.suggestions,
            });
        } else {
            console.error(chalk.red(`Alias not found: ${alias}`));
            if (lookup.suggestions.length > 0) {
                console.error(chalk.grey(`Did you mean: ${lookup.suggestions.join(', ')}?`));
            }
        }
        process.exit(1);
    }

    const connection = lookup.connection;
    recordConnectionUsage(connection.alias);

    const result = await executeCopy(
        connection,
        source,
        destination,
        {
            download,
            recursive,
            preserve,
            timeoutMs: options.timeoutMs,
            reuse: options.reuse,
            hostKeyChecking: options.hostKeyChecking,
        },
        json ? 'capture' : 'inherit',
    );

    if (json) {
        printJson(result);
    } else if (result.timedOut) {
        console.error(chalk.red(`Transfer timed out after ${options.timeoutMs}ms`));
        if (result.hint) {
            console.error(chalk.grey(result.hint));
        }
    } else if (!result.ok) {
        console.error(chalk.red(result.exitCode === -1 ? (result.stderr.trim() || 'scp failed.') : `scp exited with code ${result.exitCode}`));
        if (result.hint) {
            console.error(chalk.grey(`Hint: ${result.hint}`));
        }
    }

    process.exitCode = result.timedOut ? 124 : result.exitCode === -1 ? 1 : (result.exitCode ?? 1);
}
