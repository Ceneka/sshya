#!/usr/bin/env bun

import chalk from 'chalk';
import { Command } from 'commander';
import pkg from './package.json' assert { type: "json" };
import { addConnectionPrompt, exportConnectionsPrompt, importConnectionsPrompt, listConnectionsPrompt, removeConnectionPrompt, testConnectionPrompt, updateConnectionPrompt } from './src/connection';
import { initDB } from './src/database';
import { printConnectionsPrompt } from './src/helpers/connection';
import { enableEscapeExit } from './src/helpers/escExit';
import { printFzfInstructions } from './src/helpers/fzf';
// built-in SSH handler removed

const version = pkg?.version ?? '1.0.0';

if (process.stdin.isTTY && process.stdout.isTTY) {
  enableEscapeExit();
}

initDB();

const program = new Command();

program
  .version(version)
  .description('A simple CLI to manage your SSH connections');

// connect command removed – use system ssh via fzf snippet

program
  .command('print [alias]')
  .description('Print an SSH connection by alias')
  .action(printConnectionsPrompt);

program
  .command('add')
  .aliases(['create', 'new'])
  .description('Add a new SSH connection')
  .action(addConnectionPrompt);

program
  .command('list')
  .aliases(['ps', 'ls'])
  .description('List all SSH connections')
  .option('--oneline', 'Output each connection as ssh args on one line')
  .option('--names', 'Include alias as first column (tab-separated) with --oneline')
  .action((options: { oneline?: boolean; names?: boolean }) => listConnectionsPrompt({ oneline: !!options?.oneline, names: !!options?.names }));

program
  .command('remove [alias]')
  .aliases(['delete', 'rm'])
  .description('Remove an SSH connection by alias')
  .action(removeConnectionPrompt);

program
  .command('update [alias]')
  .aliases(['edit'])
  .description('Update an SSH connection by alias')
  .action(updateConnectionPrompt);

program
  .command('test [alias]')
  .description('Test an SSH connection by alias')
  .action(testConnectionPrompt);

program
  .command('import [file]')
  .description('Import connections from a JSON file')
  .action(importConnectionsPrompt);

program
  .command('export [file]')
  .description('Export connections to a JSON file (default: sshm-export.json)')
  .action(exportConnectionsPrompt);

program
  .command('fzf')
  .aliases(['instructions', 'install'])
  .description('Show instructions to enable fzf-based connection launcher')
  .action(() => {
    printFzfInstructions();
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
  program.parse(argvForCommander);
}

// Only execute when this module is the entrypoint (prevents side effects during tests)
if (import.meta.main) {
  await runFromProcess();
}
