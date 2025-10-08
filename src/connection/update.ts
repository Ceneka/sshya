import chalk from "chalk";
import inquirer from "inquirer";
import { getConnectionByAlias, updateConnection } from "../database";
import { selectAlias } from "../helpers/selectAlias";
import { testConnectionPrompt } from "./test";

export async function updateConnectionPrompt(alias?: string) {
    // If alias is not provided, prompt the user to pick one interactively
    if (!alias) {
        alias = await selectAlias('Select a connection to edit');
    }

    const connection = getConnectionByAlias(alias);
    if (connection) {
        const answers = await inquirer.prompt([
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
        updateConnection(alias, answers.user, answers.host, answers.key_path, answers.port, answers.remote_path);
        console.log(chalk.green('Connection updated successfully'));

        const { test } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'test',
                message: 'Do you want to test the updated connection now?',
                default: true,
            },
        ]);

        if (test) {
            await testConnectionPrompt(alias);
        }
    } else {
        console.error(chalk.red('Alias not found'));
    }
}
