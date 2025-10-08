import chalk from "chalk";
import inquirer from "inquirer";
import { addConnection, connectionSchema } from "../database";
import { testConnectionPrompt } from "./test";

export async function addConnectionPrompt() {
    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'alias',
            message: 'Alias:',
        },
        {
            type: 'input',
            name: 'user',
            message: 'User:',
            default: 'root',
        },
        {
            type: 'input',
            name: 'host',
            message: 'Host/IP:',
        },
        {
            type: 'input',
            name: 'port',
            message: 'Port (optional):',
        },
        {
            type: 'input',
            name: 'key_path',
            message: 'Path to key (optional):',
        },
        {
            type: 'input',
            name: 'remote_path',
            message: 'Remote working directory (optional):',
        },
    ]);

    const parsed = connectionSchema.safeParse(answers);
    if (!parsed.success) {
        console.error(chalk.red('Invalid input:'), parsed.error.errors.map(e => e.message).join(', '));
        return;
    }
    const { alias, user, host, key_path, port, remote_path } = parsed.data;

    try {
        addConnection(alias, user, host, key_path, port ? String(port) : undefined, remote_path);
        console.log(chalk.green('Connection added successfully'));

        const { test } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'test',
                message: 'Do you want to test the new connection now?',
                default: true,
            },
        ]);

        if (test) {
            await testConnectionPrompt(alias);
        }
    } catch (err: any) {
        console.error(chalk.red(err.message));
    }
}
