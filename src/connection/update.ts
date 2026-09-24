import chalk from "chalk";
import inquirer from "inquirer";
import { connectionSchema, getConnectionByAlias, updateConnection } from "../database";
import { enableEscapeExit } from "../helpers/escExit";
import { selectAlias } from "../helpers/selectAlias";
import { testConnectionPrompt } from "./test";

export async function updateConnectionPrompt(alias?: string) {
    // If alias is not provided, prompt the user to pick one interactively
    if (!alias) {
        alias = await selectAlias('Select a connection to edit');
    }

    const connection = getConnectionByAlias(alias);
    if (connection) {
        const cleanup = enableEscapeExit();
        try {
        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'alias',
                message: 'Alias:',
                default: connection.alias,
                validate: (input: string) => {
                    const trimmed = input.trim();
                    if (!trimmed) {
                        return 'Alias cannot be empty';
                    }
                    if (trimmed !== connection.alias && getConnectionByAlias(trimmed)) {
                        return `Connection with alias "${trimmed}" already exists.`;
                    }
                    return true;
                },
            },
            {
                type: 'input',
                name: 'user',
                message: 'User:',
                default: connection.user,
            },
            {
                type: 'input',
                name: 'host',
                message: 'Host/IP:',
                default: connection.host,
            },
            {
                type: 'input',
                name: 'port',
                message: 'Port (optional):',
                default: connection.port,
            },
            {
                type: 'input',
                name: 'key_path',
                message: 'Path to key (optional):',
                default: connection.key_path,
            },
            {
                type: 'input',
                name: 'remote_path',
                message: 'Remote working directory (optional):',
                default: connection.remote_path,
            },
        ]);

        const parsed = connectionSchema.safeParse(answers);
        if (!parsed.success) {
            console.error(chalk.red('Invalid input:'), parsed.error.issues.map(e => e.message).join(', '));
            return;
        }

        const { alias: newAlias, user, host, key_path, port, remote_path } = parsed.data;

        try {
            updateConnection(
                alias,
                user,
                host,
                key_path,
                port ? String(port) : undefined,
                remote_path,
                newAlias,
            );
            const renamed = newAlias.trim() !== alias;
            console.log(chalk.green(
                renamed
                    ? `Connection updated successfully (renamed to "${newAlias.trim()}")`
                    : 'Connection updated successfully',
            ));

            const { test } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'test',
                    message: 'Do you want to test the updated connection now?',
                    default: true,
                },
            ]);

            if (test) {
                await testConnectionPrompt(newAlias.trim());
            }
        } catch (err: any) {
            console.error(chalk.red(err.message));
        }
        } finally {
            cleanup();
        }
    } else {
        console.error(chalk.red('Alias not found'));
    }
}
