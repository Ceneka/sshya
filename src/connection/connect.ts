import chalk from 'chalk';
import { spawn } from 'child_process';
import { recordConnectionUsage } from '../database';
import { buildInteractiveSshArgs } from '../helpers/ssh';
import { resolveAliasForCommand, selectAlias } from '../helpers/selectAlias';

export async function connectConnectionPrompt(alias?: string): Promise<void> {
    if (!alias) {
        alias = await selectAlias('Select a connection to connect');
    }

    // `connect` is interactive by nature: a typo may fuzzy-match when both
    // stdin and stdout are TTYs. JSON mode and pipes stay exact-only.
    const lookup = await resolveAliasForCommand(alias);

    if (!lookup.ok) {
        console.error(chalk.red(`Alias not found: ${alias}`));
        if (lookup.suggestions.length > 0) {
            console.error(chalk.grey(`Did you mean: ${lookup.suggestions.join(', ')}?`));
        }
        process.exit(1);
    }

    const connection = lookup.connection;
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
