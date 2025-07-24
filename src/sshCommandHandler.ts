import chalk from 'chalk';
import inquirer from 'inquirer';
import { addConnection, getConnections } from './database';
import { runSSH } from './ssh';

export interface ParsedSSH {
    user: string;
    host: string;
    key_path?: string;
    port?: string;
}

export function parseSshCommand(args: string[]): ParsedSSH | null {
    if (args[0] === 'ssh') {
        args = args.slice(1);
    }

    let user = '';
    let host = '';
    let key_path: string | undefined;
    let port: string | undefined;

    const userHostArg = args.find(arg => arg.includes('@') && !arg.startsWith('-'));
    if (!userHostArg) return null;

    const parts = userHostArg.split('@');
    if (parts.length < 2) return null;
    user = parts[0] ?? '';
    host = parts[1] ?? '';

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;

        if (arg === '-i' && i + 1 < args.length) {
            key_path = args[i + 1]!;
            i++;
            // Support combined flag and value, e.g. -i/home/key.pem
        } else if (arg.startsWith('-i') && arg.length > 2) {
            key_path = arg.slice(2);
        } else if (arg === '-p' && i + 1 < args.length) {
            port = args[i + 1]!;
            i++;
            // Support combined flag and value, e.g. -p5572
        } else if (arg.startsWith('-p') && arg.length > 2) {
            port = arg.slice(2);
        }
    }

    return { user, host, key_path, port };
}

export async function handleSshCommand(args: string[]) {
    const connectionDetails = parseSshCommand(args);
    if (!connectionDetails) {
        console.error(chalk.red('Could not parse SSH command.'));
        console.log('Expected format: ssh -i <key> user@host -p <port>');
        return;
    }

    const { user, host, key_path, port } = connectionDetails;

    const connections = getConnections();
    const existingConnection = connections.find(c => {
        const dbPort = c.port ? String(c.port) : undefined;
        const dbKeyPath = c.key_path || undefined;
        return c.user === user && c.host === host && dbKeyPath === key_path && dbPort === port;
    });

    if (existingConnection) {
        console.log(chalk.green(`Found existing connection with alias "${existingConnection.alias}". Connecting...`));
        runSSH(existingConnection.alias, user, host, key_path, port);
        return;
    }

    console.log('This looks like a new connection.');
    const { alias } = await inquirer.prompt([
        {
            type: 'input',
            name: 'alias',
            message: 'Enter an alias to save this connection for future use:',
            validate: input => (input ? true : 'Alias cannot be empty.'),
        },
    ]);

    try {
        addConnection(alias, user, host, key_path, port ? String(port) : undefined);
        console.log(chalk.green(`Connection saved as "${alias}". Connecting...`));
        runSSH(alias, user, host, key_path, port);
    } catch (err: any) {
        console.error(chalk.red(err.message));
    }
} 
