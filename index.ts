#!/usr/bin/env bun

import chalk from 'chalk';
import { Command } from 'commander';
import pkg from './package.json' with { type: "json" };
import { addConnectionPrompt, connectConnectionPrompt, copyConnectionPrompt, exportConnectionsPrompt, importConnectionsPrompt, listConnectionsPrompt, removeConnectionPrompt, runConnectionPrompt, showConnectionPrompt, testConnectionPrompt, updateConnectionPrompt } from './src/connection';
import { initDB } from './src/database';
import { printConnectionsPrompt } from './src/helpers/connection';
import { enableEscapeExit } from './src/helpers/escExit';
import { runFzfLauncher } from './src/helpers/fzf';

const version = pkg?.version ?? '1.0.0';

if (process.stdin.isTTY && process.stdout.isTTY) {
  enableEscapeExit();
}

initDB();

const program = new Command();

const secondsToMs = (value?: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
};

program
  .version(version)
  .description('A simple CLI to manage your SSH connections');

program
  .command('connect [alias]')
  .aliases(['ssh', 'go'])
  .description('Connect to an SSH connection by alias')
  .action(connectConnectionPrompt);

program
  .command('run <alias> [command...]')
  .aliases(['exec'])
  .description('Run a non-interactive command over a stored connection')
  .option('--tty', 'Allocate a remote TTY')
  .option('--allow-password', 'Allow SSH to prompt for a password (BatchMode off)')
  .option('--connect-timeout <seconds>', 'SSH ConnectTimeout in seconds', '10')
  .option('--timeout <seconds>', 'Abort the remote command after this many seconds')
  .option('--no-cwd', 'Do not cd into the connection remote path first')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string, commandParts: string[] | undefined, options: {
    tty?: boolean;
    allowPassword?: boolean;
    connectTimeout?: string;
    timeout?: string;
    cwd?: boolean;
    json?: boolean;
  }) => {
    return runConnectionPrompt(alias, commandParts ?? [], {
      tty: !!options.tty,
      batchMode: !options.allowPassword,
      connectTimeout: Number(options.connectTimeout) || 10,
      timeoutMs: secondsToMs(options.timeout),
      cwd: options.cwd !== false,
      json: !!options.json,
    });
  });

program
  .command('copy [alias] [source] [destination]')
  .aliases(['sc', 'scp'])
  .description('Copy files using a stored SSH connection')
  .option('-d, --download', 'Copy from the remote host to a local destination')
  .option('-r, --recursive', 'Copy directories recursively')
  .option('-p, --preserve', 'Preserve modification times, access times, and modes')
  .option('--timeout <seconds>', 'Abort the transfer after this many seconds')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, source: string | undefined, destination: string | undefined, options: {
    download?: boolean;
    recursive?: boolean;
    preserve?: boolean;
    timeout?: string;
    json?: boolean;
  }) => {
    return copyConnectionPrompt(alias, source, destination, {
      download: !!options.download,
      recursive: !!options.recursive,
      preserve: !!options.preserve,
      timeoutMs: secondsToMs(options.timeout),
      json: !!options.json,
    });
  });

program
  .command('print [alias]')
  .description('Print an SSH connection by alias')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, options: { json?: boolean }) => printConnectionsPrompt(alias, options));

program
  .command('show [alias]')
  .aliases(['inspect', 'get'])
  .description('Show one connection with ready-to-run SSH commands')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, options: { json?: boolean }) => showConnectionPrompt(alias, options));

program
  .command('add [alias] [target]')
  .aliases(['create', 'new'])
  .description('Add a new SSH connection (interactive when fields are omitted)')
  .option('-u, --user <user>', 'SSH username')
  .option('-H, --host <host>', 'Hostname or IP address')
  .option('-p, --port <port>', 'SSH port')
  .option('-k, --key <path>', 'Path to the private key')
  .option('-r, --remote-path <path>', 'Default remote working directory')
  .option('-f, --force', 'Replace a connection with the same alias')
  .option('--test', 'Test connectivity after saving')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, target: string | undefined, options: {
    user?: string;
    host?: string;
    port?: string;
    key?: string;
    remotePath?: string;
    force?: boolean;
    test?: boolean;
    json?: boolean;
  }) => addConnectionPrompt(alias, target, options));

program
  .command('list')
  .aliases(['ps', 'ls'])
  .description('List all SSH connections')
  .option('--oneline', 'Output each connection as ssh args on one line')
  .option('--names', 'Include alias as first column (tab-separated) with --oneline')
  .option('--json', 'Machine-readable JSON output')
  .action((options: { oneline?: boolean; names?: boolean; json?: boolean }) => listConnectionsPrompt({
    oneline: !!options?.oneline,
    names: !!options?.names,
    json: !!options?.json,
  }));

program
  .command('remove [alias]')
  .aliases(['delete', 'rm'])
  .description('Remove an SSH connection by alias')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, options: { json?: boolean }) => removeConnectionPrompt(alias, options));

program
  .command('update [alias]')
  .aliases(['edit'])
  .description('Update an SSH connection by alias')
  .option('-u, --user <user>', 'SSH username')
  .option('-H, --host <host>', 'Hostname or IP address')
  .option('-p, --port <port>', 'SSH port')
  .option('-k, --key <path>', 'Path to the private key')
  .option('-r, --remote-path <path>', 'Default remote working directory')
  .option('--new-alias <alias>', 'Rename the connection')
  .option('--test', 'Test connectivity after saving')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, options: {
    user?: string;
    host?: string;
    port?: string;
    key?: string;
    remotePath?: string;
    newAlias?: string;
    test?: boolean;
    json?: boolean;
  }) => updateConnectionPrompt(alias, options));

program
  .command('test [alias]')
  .description('Test an SSH connection by alias')
  .option('--timeout <seconds>', 'Abort the test after this many seconds', '5')
  .option('--json', 'Machine-readable JSON output')
  .action((alias: string | undefined, options: { timeout?: string; json?: boolean }) => testConnectionPrompt(alias, {
    timeoutMs: secondsToMs(options.timeout) ?? 5000,
    json: !!options.json,
  }));

program
  .command('import [file]')
  .description('Import connections from a JSON file (use - for stdin)')
  .option('--strategy <strategy>', 'Conflict handling: ask, skip, overwrite, or error', 'ask')
  .option('--json', 'Machine-readable JSON output')
  .action((file: string | undefined, options: { strategy?: string; json?: boolean }) => {
    if (!file) {
      console.error(chalk.red('File is required. Use - to read from stdin.'));
      process.exit(1);
    }
    return importConnectionsPrompt(file, {
      strategy: options.strategy as 'ask' | 'skip' | 'overwrite' | 'error' | undefined,
      json: !!options.json,
    });
  });

program
  .command('export [file]')
  .description('Export connections to a JSON file (use - for stdout)')
  .option('--json', 'Machine-readable JSON output')
  .action((file: string | undefined, options: { json?: boolean }) => exportConnectionsPrompt(file ?? 'sshm-export.json', options));

program
  .command('fzf')
  .description('Select a connection with fzf and connect')
  .action(runFzfLauncher);

program
  .command('mcp')
  .description('Start the sshya MCP server on stdio for agent integrations')
  .action(async () => {
    const { runMcpServer } = await import('./src/mcp/server');
    await runMcpServer();
  });

program
  .command('path')
  .description('Provides instructions to make the CLI globally accessible')
  .action(() => {
    console.log(chalk.yellow('To make the ' + chalk.bold('s') + ' command globally accessible:'));
    console.log('\n' + chalk.bold('Option 1: Permanent Installation (Recommended)') + '\n');
    console.log('1. Build the executable: ' + chalk.cyan('bun run build'));
    console.log('2. Move the executable to a PATH directory (e.g., /usr/local/bin):');
    console.log(chalk.cyan('   sudo mv bin/s /usr/local/bin/s'));
    console.log('\n' + chalk.green('After these steps, you should be able to run ' + chalk.bold('s') + ' from any directory.'));

    console.log('\n' + chalk.bold('Option 2: Temporary for Current Session') + '\n');
    console.log('Add the current directory to your PATH for the current terminal session:');
    console.log(chalk.cyan(`   export PATH="$PATH:${process.cwd()}/bin"`));
    console.log('\n' + chalk.green('This will allow you to run ' + chalk.bold('s') + ' from this directory until you close the terminal.'));
    process.exit(0);
  });

program
  .command('about')
  .description('About this CLI')
  .action(() => {
    console.log(chalk.bold('SSHya CLI'));
    console.log(chalk.gray(`Version ${version}`));
    console.log(chalk.gray('https://github.com/ceneka/sshya'));
    process.exit(0);
  });

// Helpers exported for testing primary dispatch logic
export function normalizeUserArgs(rawArgv: string[]): string[] {
  const looksLikeBunShim = rawArgv[0] === 'bun' && rawArgv[1] === 'run';
  return looksLikeBunShim ? rawArgv.slice(3) : rawArgv;
}


async function runFromProcess() {
  // Clean Bun compile shim arguments (e.g., "bun run index.ts") when running the compiled binary
  const rawArgs = process.argv.slice(2);
  const userArgs = normalizeUserArgs(rawArgs);
  // Reconstruct argv array expected by commander: [node, script, ...userArgs]
  const argvForCommander: string[] = [process.argv[0] ?? '', process.argv[1] ?? '', ...userArgs];
  await program.parseAsync(argvForCommander);
}

// Only execute when this module is the entrypoint (prevents side effects during tests)
if (import.meta.main) {
  await runFromProcess();
}
