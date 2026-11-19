#!/usr/bin/env bun

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import pkg from './package.json' with { type: "json" };
import { initDB } from './src/database';
import { parseByteSize, type CaptureMode } from './src/helpers/capture';
import type { HostKeyChecking } from './src/helpers/ssh';

const version = pkg?.version ?? '1.0.0';

// Startup hot path: only commander and the tiny helpers above are evaluated up
// front. Interactive terminal setup is skipped entirely for piped runs.
if (process.stdin.isTTY && process.stdout.isTTY) {
  const { enableEscapeExit } = await import('./src/helpers/escExit');
  enableEscapeExit();
}

const program = new Command();

// Initialize the store lazily, only when a command actually runs. `--version`,
// `--help`, and a bare `sshya` must not create or rewrite the database.
program.hook('preAction', (_thisCommand, actionCommand) => {
  const commandName = actionCommand.name();
  if (commandName === 'about' || commandName === 'path') {
    return;
  }
  initDB();
});

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

const parseByteSizeOption = (value: string): number => {
  const bytes = parseByteSize(value);
  if (!bytes) {
    throw new InvalidArgumentError('Expected a size such as 64k, 1m, or 65536.');
  }
  return bytes;
};

const parseTruncateMode = (value: string): CaptureMode => {
  const mode = value.trim().toLowerCase();
  if (mode !== 'head' && mode !== 'tail' && mode !== 'headtail') {
    throw new InvalidArgumentError('Expected head, tail, or headtail.');
  }
  return mode;
};

/**
 * Validate `run --timeout` before the 120 s safety net is resolved. Falling
 * through to "no timeout" on a typo would silently disable that safety net.
 */
const parseTimeoutSeconds = (value: string): string => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new InvalidArgumentError('Expected a non-negative number of seconds (0 disables the timeout).');
  }
  return value;
};

const resolveHostKeyChecking = async (options: {
  acceptNewHostKey?: boolean;
  strictHostKey?: boolean;
}): Promise<HostKeyChecking | undefined> => {
  if (options.acceptNewHostKey && options.strictHostKey) {
    const { default: chalk } = await import('chalk');
    console.error(chalk.red('--accept-new-host-key and --strict-host-key are mutually exclusive.'));
    process.exit(1);
  }
  if (options.acceptNewHostKey) {
    return 'accept-new';
  }
  if (options.strictHostKey) {
    return 'strict';
  }
  return undefined;
};

program
  .version(version)
  .description('A simple CLI to manage your SSH connections');

program
  .command('connect [alias]')
  .aliases(['ssh', 'go'])
  .description('Connect to an SSH connection by alias')
  .action(async (alias?: string) => {
    const { connectConnectionPrompt } = await import('./src/connection/connect');
    return connectConnectionPrompt(alias);
  });

program
  .command('run <alias> [command...]')
  .aliases(['exec'])
  .description('Run a non-interactive command over a stored connection')
  .option('--tty', 'Allocate a remote TTY')
  .option('--allow-password', 'Allow SSH to prompt for a password (BatchMode off)')
  .option('--connect-timeout <seconds>', 'SSH ConnectTimeout in seconds', '10')
  .option('--timeout <seconds>', 'Abort the remote command after this many seconds (0 disables the 120s default)', parseTimeoutSeconds)
  .option('--no-cwd', 'Do not cd into the connection remote path first')
  .option('--no-reuse', 'Open a fresh connection instead of reusing the pooled one')
  .option('--no-stdin', 'Do not forward piped stdin to the remote command')
  .option('--max-output <size>', 'Cap captured output per stream (default 16k in --json mode)', parseByteSizeOption)
  .option('--truncate <mode>', 'Where to cut truncated output: head, tail, or headtail (default headtail in --json mode)', parseTruncateMode)
  .option('--tail', 'Deprecated: keep the end when output is truncated (same as --truncate tail)')
  .option('--accept-new-host-key', 'Trust an unknown host key on first contact (TOFU)')
  .option('--strict-host-key', 'Fail if the host key is not already known')
  .option('--json', 'Machine-readable JSON output')
  .action(async (alias: string, commandParts: string[] | undefined, options: {
    tty?: boolean;
    allowPassword?: boolean;
    connectTimeout?: string;
    timeout?: string;
    cwd?: boolean;
    reuse?: boolean;
    stdin?: boolean;
    maxOutput?: number;
    truncate?: CaptureMode;
    tail?: boolean;
    acceptNewHostKey?: boolean;
    strictHostKey?: boolean;
    json?: boolean;
  }) => {
    const { runConnectionPrompt, resolveRunTimeoutMs } = await import('./src/connection/run');
    return runConnectionPrompt(alias, commandParts ?? [], {
      tty: !!options.tty,
      batchMode: !options.allowPassword,
      connectTimeout: Number(options.connectTimeout) || 10,
      timeoutMs: resolveRunTimeoutMs(options.timeout, { json: options.json }),
      cwd: options.cwd !== false,
      reuse: options.reuse !== false,
      noStdin: options.stdin === false,
      maxOutputBytes: options.maxOutput,
      outputMode: options.truncate ?? (options.tail ? 'tail' : undefined),
      hostKeyChecking: await resolveHostKeyChecking(options),
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
  .option('--no-reuse', 'Open a fresh connection instead of reusing the pooled one')
  .option('--accept-new-host-key', 'Trust an unknown host key on first contact (TOFU)')
  .option('--strict-host-key', 'Fail if the host key is not already known')
  .option('--json', 'Machine-readable JSON output')
  .action(async (alias: string | undefined, source: string | undefined, destination: string | undefined, options: {
    download?: boolean;
    recursive?: boolean;
    preserve?: boolean;
    timeout?: string;
    reuse?: boolean;
    acceptNewHostKey?: boolean;
    strictHostKey?: boolean;
    json?: boolean;
  }) => {
    const { copyConnectionPrompt } = await import('./src/connection/copy');
    return copyConnectionPrompt(alias, source, destination, {
      download: !!options.download,
      recursive: !!options.recursive,
      preserve: !!options.preserve,
      timeoutMs: secondsToMs(options.timeout),
      reuse: options.reuse !== false,
      hostKeyChecking: await resolveHostKeyChecking(options),
      json: !!options.json,
    });
  });

program
  .command('print [alias]')
  .description('Print an SSH connection by alias')
  .option('--json', 'Machine-readable JSON output')
  .action(async (alias: string | undefined, options: { json?: boolean }) => {
    const { printConnectionsPrompt } = await import('./src/helpers/connection');
    return printConnectionsPrompt(alias, options);
  });

program
  .command('show [alias]')
  .aliases(['inspect', 'get'])
  .description('Show one connection with ready-to-run SSH commands')
  .option('--json', 'Machine-readable JSON output')
  .action(async (alias: string | undefined, options: { json?: boolean }) => {
    const { showConnectionPrompt } = await import('./src/connection/show');
    return showConnectionPrompt(alias, options);
  });

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
  .action(async (alias: string | undefined, target: string | undefined, options: {
    user?: string;
    host?: string;
    port?: string;
    key?: string;
    remotePath?: string;
    force?: boolean;
    test?: boolean;
    json?: boolean;
  }) => {
    const { addConnectionPrompt } = await import('./src/connection/add');
    return addConnectionPrompt(alias, target, options);
  });

program
  .command('list')
  .aliases(['ps', 'ls'])
  .description('List all SSH connections')
  .option('--oneline', 'Output each connection as ssh args on one line')
  .option('--names', 'Include alias as first column (tab-separated) with --oneline')
  .option('--json', 'Machine-readable JSON output')
  .action(async (options: { oneline?: boolean; names?: boolean; json?: boolean }) => {
    const { listConnectionsPrompt } = await import('./src/connection/list');
    return listConnectionsPrompt({
      oneline: !!options?.oneline,
      names: !!options?.names,
      json: !!options?.json,
    });
  });

program
  .command('remove [alias]')
  .aliases(['delete', 'rm'])
  .description('Remove an SSH connection by alias')
  .option('--json', 'Machine-readable JSON output')
  .action(async (alias: string | undefined, options: { json?: boolean }) => {
    const { removeConnectionPrompt } = await import('./src/connection/remove');
    return removeConnectionPrompt(alias, options);
  });

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
  .action(async (alias: string | undefined, options: {
    user?: string;
    host?: string;
    port?: string;
    key?: string;
    remotePath?: string;
    newAlias?: string;
    test?: boolean;
    json?: boolean;
  }) => {
    const { updateConnectionPrompt } = await import('./src/connection/update');
    return updateConnectionPrompt(alias, options);
  });

program
  .command('test [alias]')
  .description('Test an SSH connection by alias')
  .option('--timeout <seconds>', 'Abort the test after this many seconds', '5')
  .option('--no-reuse', 'Open a fresh connection instead of reusing the pooled one')
  .option('--accept-new-host-key', 'Trust an unknown host key on first contact (TOFU)')
  .option('--strict-host-key', 'Fail if the host key is not already known')
  .option('--json', 'Machine-readable JSON output')
  .action(async (alias: string | undefined, options: {
    timeout?: string;
    reuse?: boolean;
    acceptNewHostKey?: boolean;
    strictHostKey?: boolean;
    json?: boolean;
  }) => {
    const { testConnectionPrompt } = await import('./src/connection/test');
    return testConnectionPrompt(alias, {
      timeoutMs: secondsToMs(options.timeout) ?? 5000,
      reuse: options.reuse !== false,
      hostKeyChecking: await resolveHostKeyChecking(options),
      json: !!options.json,
    });
  });

program
  .command('pool [action] [alias]')
  .description('Inspect or close pooled SSH connections (list, close)')
  .option('--all', 'Close every pooled connection (with close)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (action: string | undefined, alias: string | undefined, options: { all?: boolean; json?: boolean }) => {
    const { poolCommand } = await import('./src/connection/pool');
    return poolCommand(action, alias, options);
  });

program
  .command('doctor')
  .description('Check the local SSH setup, stored keys, pool, and optionally probe every connection')
  .option('--probe', 'Run `true` on every stored connection')
  .option('--timeout <seconds>', 'Probe timeout in seconds', '5')
  .option('--accept-new-host-key', 'Trust unknown host keys while probing (TOFU)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (options: {
    probe?: boolean;
    timeout?: string;
    acceptNewHostKey?: boolean;
    json?: boolean;
  }) => {
    const { doctorCommand } = await import('./src/connection/doctor');
    return doctorCommand({
      probe: !!options.probe,
      timeoutMs: secondsToMs(options.timeout) ?? 5000,
      acceptNewHostKey: !!options.acceptNewHostKey,
      json: !!options.json,
    });
  });

program
  .command('import [file]')
  .description('Import connections from a JSON file (use - for stdin)')
  .option('--strategy <strategy>', 'Conflict handling: ask, skip, overwrite, or error', 'ask')
  .option('--json', 'Machine-readable JSON output')
  .action(async (file: string | undefined, options: { strategy?: string; json?: boolean }) => {
    if (!file) {
      const { default: chalk } = await import('chalk');
      console.error(chalk.red('File is required. Use - to read from stdin.'));
      process.exit(1);
    }
    const { importConnectionsPrompt } = await import('./src/connection/import');
    return importConnectionsPrompt(file, {
      strategy: options.strategy as 'ask' | 'skip' | 'overwrite' | 'error' | undefined,
      json: !!options.json,
    });
  });

program
  .command('export [file]')
  .description('Export connections to a JSON file (use - for stdout)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (file: string | undefined, options: { json?: boolean }) => {
    const { exportConnectionsPrompt } = await import('./src/connection/export');
    return exportConnectionsPrompt(file ?? 'sshm-export.json', options);
  });

program
  .command('fzf')
  .description('Select a connection with fzf and connect')
  .action(async () => {
    const { runFzfLauncher } = await import('./src/helpers/fzf');
    return runFzfLauncher();
  });

program
  .command('mcp')
  .description('Start the sshya MCP server on stdio for agent integrations')
  .option('--aliases <patterns>', 'Only expose these aliases (comma-separated, supports simple globs like stg-*)')
  .option('--read-only', 'Expose read-only tools only: no store mutations, remote file writes, or uploads')
  .action(async (options: { aliases?: string; readOnly?: boolean }) => {
    const { runMcpServer } = await import('./src/mcp/server');
    await runMcpServer({
      aliases: options.aliases?.trim() ? options.aliases : undefined,
      readOnly: options.readOnly === true ? true : undefined,
    });
  });

program
  .command('path')
  .description('Provides instructions to make the CLI globally accessible')
  .action(async () => {
    const { default: chalk } = await import('chalk');
    console.log(chalk.yellow('To make the ' + chalk.bold('s') + ' command globally accessible:'));
    console.log('\n' + chalk.bold('Option 1: Permanent Installation (Recommended)') + '\n');
    console.log('1. Install the package globally: ' + chalk.cyan('npm install -g sshya'));
    console.log('2. Both ' + chalk.bold('sshya') + ' and ' + chalk.bold('s') + ' are now on your PATH.');
    console.log('\n' + chalk.green('After this step, you can run ' + chalk.bold('s') + ' from any directory.'));

    console.log('\n' + chalk.bold('Option 2: Run without installing') + '\n');
    console.log('Use npx (Node) or bunx (Bun) directly:');
    console.log(chalk.cyan('   npx -y sshya --help'));
    console.log(chalk.cyan('   bunx sshya --help'));
    console.log('\n' + chalk.green('Both commands run the same published package.'));
    process.exit(0);
  });

program
  .command('about')
  .description('About this CLI')
  .action(async () => {
    const { default: chalk } = await import('chalk');
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

/**
 * True when this module is the process entrypoint.
 *
 * Bun exposes `import.meta.main`, but Node 20 does not, and Bun's bundler
 * rewrites a direct `import.meta.main` read into a Bun-only `require` shim that
 * throws under Node. Read the property dynamically and fall back to comparing
 * `argv[1]` with this module's URL so `dist/index.js` also runs under plain
 * Node. Keeping the Bun check first preserves `bun run index.ts` and future
 * standalone Bun builds.
 */
const isMainModule = (): boolean => {
  // Assign to a variable first: Bun rewrites a direct `import.meta.main` read.
  const meta: ImportMeta & { main?: unknown } = import.meta;
  const main = meta['main'];
  if (typeof main === 'boolean') {
    return main;
  }
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

// Only execute when this module is the entrypoint (prevents side effects during tests)
if (isMainModule()) {
  await runFromProcess();
}
