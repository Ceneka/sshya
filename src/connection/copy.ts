import chalk from 'chalk';
import path from 'path';
import { spawn } from 'child_process';
import { expandHomePath, getConnectionByAlias, recordConnectionUsage, type Connection } from '../database';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';

interface CopyOptions {
    download?: boolean;
    recursive?: boolean;
    preserve?: boolean;
}

interface NormalizedCopyArgs {
    alias?: string;
    source?: string;
    destination?: string;
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
    const { download = false, recursive = false, preserve = false } = options;
    let { alias, source, destination } = normalizeCopyArgs(first, second, third);

    if (!source || !destination) {
        console.error(chalk.red('Source and destination are required'));
        console.error(chalk.grey('Usage: sshya copy [alias] <source> <destination>'));
        console.error(chalk.grey('       sshya copy --download [alias] <remote-source> <local-destination>'));
        process.exit(1);
    }

    if (!alias) {
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
        console.error(chalk.red('Alias not found'));
        process.exit(1);
    }

    const args: string[] = [];
    if (connection.key_path) {
        args.push('-i', expandHomePath(connection.key_path) ?? connection.key_path);
    }
    if (connection.port) {
        args.push('-P', String(connection.port));
    }
    if (recursive) {
        args.push('-r');
    }
    if (preserve) {
        args.push('-p');
    }

    if (download) {
        args.push(buildRemoteSpec(connection, source), destination);
    } else {
        args.push(source, buildRemoteSpec(connection, destination));
    }

    recordConnectionUsage(alias);

    const child = spawn('scp', args, { stdio: 'inherit' });
    child.on('error', (error) => {
        console.error(chalk.red(`Failed to start scp: ${error.message}`));
        process.exit(1);
    });
    child.on('close', (code) => {
        process.exit(code ?? 1);
    });
}
