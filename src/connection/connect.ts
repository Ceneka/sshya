import chalk from 'chalk';
import { spawn } from 'child_process';
import { getConnectionByAlias, recordConnectionUsage } from '../database';
import { buildInteractiveSshArgs } from '../helpers/ssh';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';

export async function connectConnectionPrompt(alias?: string): Promise<void> {
    if (!alias) {
        alias = await selectAlias('Select a connection to connect');
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
        console.error(chalk.red(`Alias not found: ${alias}`));
        process.exit(1);
    }

    const args = buildInteractiveSshArgs(connection);

    recordConnectionUsage(connection.alias);

    const child = spawn('ssh', args, { stdio: 'inherit' });
    child.on('error', (error) => {
        console.error(chalk.red(`Failed to start ssh: ${error.message}`));
        process.exit(1);
    });
    child.on('close', (code) => {
        process.exit(code ?? 1);
    });
}
