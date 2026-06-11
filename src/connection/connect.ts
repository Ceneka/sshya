import chalk from 'chalk';
import { spawn } from 'child_process';
import { expandHomePath, getConnectionByAlias, recordConnectionUsage } from '../database';
import { buildRemoteCommand } from '../helpers/shell';
import { selectAlias } from '../helpers/selectAlias';

export async function connectConnectionPrompt(alias?: string): Promise<void> {
    if (!alias) {
        alias = await selectAlias('Select a connection to connect');
    }

    const connection = getConnectionByAlias(alias);
    if (!connection) {
        console.error(chalk.red('Alias not found'));
        process.exit(1);
    }

    const args: string[] = [];
    if (connection.key_path) {
        args.push('-i', expandHomePath(connection.key_path) ?? connection.key_path);
    }
    if (connection.port) {
        args.push('-p', String(connection.port));
    }

    args.push('-t', `${connection.user}@${connection.host}`);

    if (connection.remote_path) {
        const remoteCommand = buildRemoteCommand({
            remotePath: connection.remote_path,
            postCommand: 'exec "$SHELL" -l',
        });
        if (remoteCommand) {
            args.push(remoteCommand);
        }
    }

    recordConnectionUsage(alias);

    const child = spawn('ssh', args, { stdio: 'inherit' });
    child.on('error', (error) => {
        console.error(chalk.red(`Failed to start ssh: ${error.message}`));
        process.exit(1);
    });
    child.on('close', (code) => {
        process.exit(code ?? 1);
    });
}
