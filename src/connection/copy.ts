import chalk from 'chalk';
import path from 'path';
import { spawn } from 'child_process';
import { expandHomePath, getConnectionByAlias, recordConnectionUsage, type Connection } from '../database';
import { ByteCapture, defaultMaxOutputBytes } from '../helpers/capture';
import { classifySshError, spawnFailure, type SshErrorKind } from '../helpers/errors';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';
import { buildSshOptionArgs, type HostKeyChecking } from '../helpers/ssh';
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
    const args = buildCopyArgs(connection, source, destination, {
        ...options,
        batchMode: options.batchMode ?? true,
        reuse: options.reuse ?? true,
    });
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

        if (options.timeoutMs && options.timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                killChild('SIGTERM');
                forceKillTimer = setTimeout(() => {
                    killChild('SIGKILL');
                    const settleTimer = setTimeout(() => finish(null), 500);
                    settleTimer.unref?.();
                }, 2000);
                forceKillTimer.unref?.();
            }, options.timeoutMs);
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
                : classifySshError(stderr, { timedOut, exitCode, timeoutMs: options.timeoutMs });

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

    let connection = getConnectionByAlias(alias);
    if (!connection) {
        const matchedAlias = findAliasBySearchTerm(alias);
        if (matchedAlias) {
            alias = matchedAlias;
            connection = getConnectionByAlias(alias);
        }
    }

    if (!connection) {
        if (json) {
            printJson({ ok: false, error: `Alias not found: ${alias}` });
        } else {
            console.error(chalk.red('Alias not found'));
        }
        process.exit(1);
    }

    recordConnectionUsage(alias);

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

    process.exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
}
