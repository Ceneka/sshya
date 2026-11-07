import { spawn } from 'child_process';
import chalk from 'chalk';
import { getConnectionByAlias, recordConnectionUsage, type Connection } from '../database';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';
import { buildRemoteCommandLine, buildSshArgs } from '../helpers/ssh';
import { printJson } from '../output';

export type OutputMode = 'inherit' | 'capture';

export interface RunOptions {
  /** Allocate a remote TTY. Off by default so commands are script-friendly. */
  tty?: boolean;
  /** Fail instead of prompting for a password. Defaults to true. */
  batchMode?: boolean;
  /** SSH ConnectTimeout in seconds. */
  connectTimeout?: number;
  /** `cd` into the connection's remote_path before running. Defaults to true. */
  cwd?: boolean;
  /** Abort the command after this many milliseconds. */
  timeoutMs?: number;
  json?: boolean;
}

export interface RunResult {
  alias: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run a command over SSH. Capture mode pipes stdout/stderr for JSON/MCP callers;
 * inherit mode streams straight to the terminal.
 */
export const executeSshCommand = (
  connection: Connection,
  command: string,
  options: RunOptions = {},
  mode: OutputMode = 'capture',
): Promise<RunResult> => {
  const startedAt = Date.now();
  const args = buildSshArgs(connection, {
    tty: options.tty,
    batchMode: options.batchMode ?? true,
    connectTimeout: options.connectTimeout ?? 10,
  });

  const remoteCommand = buildRemoteCommandLine(connection, command, { cwd: options.cwd });
  if (remoteCommand) {
    args.push(remoteCommand);
  }

  return new Promise<RunResult>((resolve) => {
    const child = spawn('ssh', args, {
      stdio: mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    if (mode === 'capture') {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    let killTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    if (options.timeoutMs && options.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        forceKillTimer.unref?.();
      }, options.timeoutMs);
    }

    const finish = (exitCode: number | null, extraStderr?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (extraStderr) {
        stderr += extraStderr;
      }
      resolve({
        alias: connection.alias,
        command,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error: Error) => finish(-1, error.message));
    child.on('close', (code) => finish(code));
  });
};

const resolveAlias = (term: string): string | undefined => {
  if (getConnectionByAlias(term)) {
    return term;
  }
  return findAliasBySearchTerm(term);
};

export async function runConnectionPrompt(
  alias?: string,
  commandParts: string[] = [],
  options: RunOptions = {},
): Promise<void> {
  const json = options.json === true;

  if (!alias) {
    if (!process.stdin.isTTY) {
      console.error(chalk.red('Alias is required when stdin is not a TTY.'));
      console.error(chalk.grey('Usage: sshya run <alias> -- <command...>'));
      process.exit(1);
    }
    alias = await selectAlias('Select a connection to run a command on');
  }

  const resolvedAlias = resolveAlias(alias);
  const connection = resolvedAlias ? getConnectionByAlias(resolvedAlias) : undefined;

  if (!connection) {
    console.error(chalk.red(`Alias not found: ${alias}`));
    process.exit(1);
  }

  const command = commandParts.join(' ').trim();
  if (!command) {
    console.error(chalk.red('No command provided.'));
    console.error(chalk.grey('Usage: sshya run <alias> -- <command...>'));
    process.exit(1);
  }

  recordConnectionUsage(connection.alias);

  const result = await executeSshCommand(
    connection,
    command,
    options,
    json ? 'capture' : 'inherit',
  );

  if (json) {
    printJson(result);
  } else if (result.timedOut) {
    console.error(chalk.red(`Command timed out after ${options.timeoutMs}ms`));
  } else if (result.exitCode === -1 && result.stderr.trim()) {
    console.error(chalk.red(result.stderr.trim()));
  } else if (result.exitCode !== 0) {
    console.error(chalk.red(`Remote command exited with code ${result.exitCode}`));
  }

  process.exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
}
