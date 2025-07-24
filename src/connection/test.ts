import chalk from 'chalk';
import { spawn } from 'child_process';
import { getConnectionByAlias } from '../database';
import { selectAlias } from '../helpers/selectAlias';

export async function testConnectionPrompt(alias?: string): Promise<void> {

    if (!alias) {
        alias = await selectAlias('Select a connection to test');
    }

    const connection = getConnectionByAlias(alias);
    if (!connection) {
        console.error(chalk.red('Alias not found'));
        return;
    }

    const { user, host, key_path, port } = connection;
    console.log(`\nTesting connection to ${chalk.blue(alias)}...`);

    const testPromise = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
        if (key_path) args.push('-i', key_path);
        if (port) args.push('-p', String(port));
        args.push(`${user}@${host}`, 'exit');

        const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (data) => (stderr += data.toString()));
        child.on('close', (code) => resolve({ code, stderr }));
        child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    });

    const { code, stderr } = await testPromise;

    if (code === 0) {
        console.log(chalk.green('Connection successful!'));
        return;
    }

    console.error(chalk.red('Connection failed.'));
    if (stderr) {
        console.error(chalk.grey(stderr.trim()));
    }
    return;
} 
