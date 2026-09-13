import chalk from 'chalk';
import { spawn } from 'child_process';
import { connectConnectionPrompt } from '../connection/connect';
import { getConnections } from '../database';

const FZF_ARGS = [
    '--with-nth=1,2',
    '--nth=1,2',
    '--delimiter=\t',
];

export async function runFzfLauncher(): Promise<void> {
    const connections = getConnections()
        .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));

    if (connections.length === 0) {
        console.log(chalk.yellow('No connections found. Add one with "sshya add"'));
        process.exit(0);
    }

    const input = connections
        .map((c) => `${c.alias}\t${c.user}@${c.host}`)
        .join('\n');

    const alias = await pickAliasWithFzf(input);
    if (!alias) {
        process.exit(0);
    }

    await connectConnectionPrompt(alias);
}

function pickAliasWithFzf(input: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = spawn('fzf', FZF_ARGS, { stdio: ['pipe', 'pipe', 'inherit'] });

        child.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                console.error(chalk.red('fzf is not installed. Use "s" or "sshya connect" instead.'));
                process.exit(1);
            }
            console.error(chalk.red(`Failed to start fzf: ${error.message}`));
            process.exit(1);
        });

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer | string) => {
            stdout += chunk.toString();
        });

        child.stdin.on('error', () => {
            // fzf may close stdin early when the user cancels.
        });
        child.stdin.write(input);
        child.stdin.end();

        child.on('close', (code) => {
            if (code !== 0) {
                resolve(undefined);
                return;
            }

            const alias = stdout.trim().split('\t')[0];
            resolve(alias || undefined);
        });
    });
}
