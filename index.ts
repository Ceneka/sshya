#!/usr/bin/env bun

import chalk from 'chalk';
import { Command } from 'commander';
import { addConnectionPrompt, exportConnectionsPrompt, importConnectionsPrompt, listConnectionsPrompt, removeConnectionPrompt, testConnectionPrompt, updateConnectionPrompt } from './src/connection';
import { initDB } from './src/database';
import { connectInteractive } from './src/helpers/connectInteractive';
import { enableEscapeExit } from './src/helpers/escExit';
import { handleSshCommand } from './src/sshCommandHandler';

import pkg from './package.json' assert { type: "json" };
const version = pkg?.version ?? '1.0.0';

enableEscapeExit();
initDB();

const program = new Command();

program
  .version(version)
  .description('A simple CLI to manage your SSH connections');

program
  .command('connect [alias]')
  .description('Connect to an SSH connection by alias')
  .action(connectInteractive);

program
  .command('add')
  .aliases(['create', 'new'])
  .description('Add a new SSH connection')
  .action(addConnectionPrompt);

program
  .command('list')
  .aliases(['ps', 'ls'])
  .description('List all SSH connections')
  .action(listConnectionsPrompt);

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

// Clean Bun compile shim arguments (e.g., "bun run index.ts") when running the compiled binary
const rawArgs = process.argv.slice(2);
const looksLikeBunShim = rawArgs[0] === 'bun' && rawArgs[1] === 'run';
const userArgs = looksLikeBunShim ? rawArgs.slice(3) : rawArgs;

const isSshCommand = userArgs.length > 0 && (userArgs[0] === 'ssh' || userArgs.some(arg => arg.includes('@')));

if (isSshCommand) {
  await handleSshCommand(userArgs);
} else if (userArgs.length === 0) {
  // No user-specified subcommand -> interactive connect
  await connectInteractive();
} else {
  // Reconstruct argv array expected by commander: [node, script, ...userArgs]
  const argvForCommander: string[] = [process.argv[0] ?? '', process.argv[1] ?? '', ...userArgs];
  program.parse(argvForCommander);
}
