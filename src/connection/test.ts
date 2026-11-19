import chalk from 'chalk';
import type { Connection } from '../database';
import type { SshErrorKind } from '../helpers/errors';
import { resolveAliasForCommand, selectAlias } from '../helpers/selectAlias';
import type { HostKeyChecking } from '../helpers/ssh';
import { jsonEnabled, printJson } from '../output';
import { executeSshCommand } from './run';

export interface TestOptions {
  timeoutMs?: number;
  /** Reuse a pooled connection. Defaults to true. */
  reuse?: boolean;
  /** First-contact host key policy. */
  hostKeyChecking?: HostKeyChecking;
  json?: boolean;
}

export interface TestResult {
  alias: string;
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  reused: boolean;
  errorKind?: SshErrorKind;
  hint?: string;
}

export const testConnection = async (
  connection: Connection,
  options: TestOptions = {},
): Promise<TestResult> => {
  const result = await executeSshCommand(connection, 'true', {
    batchMode: true,
    tty: false,
    cwd: true,
    connectTimeout: Math.max(1, Math.ceil((options.timeoutMs ?? 5000) / 1000)),
    timeoutMs: options.timeoutMs ?? 5000,
    reuse: options.reuse,
    hostKeyChecking: options.hostKeyChecking,
    maxOutputBytes: 16 * 1024,
  });

  return {
    alias: connection.alias,
    ok: result.ok,
    exitCode: result.exitCode,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    reused: result.reused,
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    ...(result.hint ? { hint: result.hint } : {}),
  };
};

export async function testConnectionPrompt(alias?: string, options: TestOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);

  if (!alias) {
    if (!process.stdin.isTTY) {
      if (json) {
        printJson({ ok: false, error: 'Alias is required when stdin is not a TTY.' });
      } else {
        console.error(chalk.red('Alias is required when stdin is not a TTY.'));
      }
      process.exit(1);
    }
    alias = await selectAlias('Select a connection to test');
  }

  const lookup = resolveAliasForCommand(alias, { json });

  if (!lookup.ok) {
    if (json) {
      printJson({
        alias,
        ok: false,
        error: `Alias not found: ${alias}`,
        suggestions: lookup.suggestions,
      });
    } else {
      console.error(chalk.red(`Alias not found: ${alias}`));
      if (lookup.suggestions.length > 0) {
        console.error(chalk.grey(`Did you mean: ${lookup.suggestions.join(', ')}?`));
      }
    }
    process.exitCode = 1;
    return;
  }

  const connection = lookup.connection;

  if (!json) {
    console.log(`\nTesting connection to ${chalk.blue(connection.alias)}...`);
  }

  const result = await testConnection(connection, options);

  if (json) {
    printJson(result);
  } else if (result.ok) {
    console.log(chalk.green(`Connection successful!${result.reused ? chalk.grey(' (pooled connection)') : ''}`));
  } else {
    console.error(chalk.red('Connection failed.'));
    if (result.stderr.trim()) {
      console.error(chalk.grey(result.stderr.trim()));
    }
    if (result.hint) {
      console.error(chalk.grey(`Hint: ${result.hint}`));
    }
  }

  process.exitCode = result.ok ? 0 : 1;
}
