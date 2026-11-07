import chalk from 'chalk';
import path from 'path';
import { spawn } from 'child_process';
import { expandHomePath, getConnectionByAlias, recordConnectionUsage, type Connection } from '../database';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';
import { jsonEnabled, printJson } from '../output';

export interface CopyOptions {
    download?: boolean;
    recursive?: boolean;
    preserve?: boolean;
    json?: boolean;
    /** Abort the transfer after this many milliseconds. */
    timeoutMs?: number;
}

interface NormalizedCopyArgs {
    alias?: string;
    source?: string;
    destination?: string;
}

export interface CopyResult {
    alias: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
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
    options: Pick<CopyOptions, 'download' | 'recursive' | 'preserve'> = {},
): string[] => {
    const args: string[] = [];
    if (connection.key_path) {
        args.push('-i', expandHomePath(connection.key_path) ?? connection.key_path);
    }
    if (connection.port) {
        args.push('-P', String(connection.port));
    }
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
    const args = buildCopyArgs(connection, source, destination, options);

    return new Promise<CopyResult>((resolve) => {
        const child = spawn('scp', args, {
            stdio: mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        if (mode === 'capture') {
            child.stdout?.on('data', (chunk: Buffer | string) => {
                stdout += chunk.toString();
            });
            child.stderr?.on('data', (chunk: Buffer | string) => {
                stderr += chunk.toString();
            });
        }

        let killTimer: NodeJS.Timeout | undefined;
        let forceKillTimer: NodeJS.Timeout | undefined;

        if (options.timeoutMs && options.timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
                forceKillTimer.unref?.();
            }, options.timeoutMs);
        }

        const finish = (exitCode: number | null, extraStderr?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            if (extraStderr) {
                stderr += extraStderr;
            }
            resolve({
                alias: connection.alias,
                exitCode,
                stdout,
                stderr,
                timedOut,
                durationMs: Date.now() - startedAt,
            });
        };

        child.on('error', (error: Error) => finish(-1, error.message));
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
        { download, recursive, preserve, timeoutMs: options.timeoutMs },
        json ? 'capture' : 'inherit',
    );

    if (json) {
        printJson({ ok: result.exitCode === 0 && !result.timedOut, ...result });
    } else if (result.timedOut) {
        console.error(chalk.red(`Transfer timed out after ${options.timeoutMs}ms`));
    } else if (result.exitCode === -1 && result.stderr.trim()) {
        console.error(chalk.red(result.stderr.trim()));
    } else if (result.exitCode !== 0) {
        console.error(chalk.red(`scp exited with code ${result.exitCode}`));
    }

    process.exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
}
