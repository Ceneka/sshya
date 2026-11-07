import chalk from 'chalk';
import { getConnectionByAlias, type Connection } from '../database';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';
import { printJson } from '../output';
import { executeSshCommand } from './run';

export interface TestOptions {
  timeoutMs?: number;
  json?: boolean;
}

export interface TestResult {
  alias: string;
  ok: boolean;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
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
    timeoutMs: options.timeoutMs,
  });

  return {
    alias: connection.alias,
    ok: result.exitCode === 0 && !result.timedOut,
    exitCode: result.exitCode,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  };
};

const resolveAlias = (term: string): string | undefined => {
  if (getConnectionByAlias(term)) {
    return term;
  }
  return findAliasBySearchTerm(term);
};

export async function testConnectionPrompt(alias?: string, options: TestOptions = {}): Promise<void> {
  const json = options.json === true;

  if (!alias) {
    if (!process.stdin.isTTY) {
      console.error(chalk.red('Alias is required when stdin is not a TTY.'));
      process.exit(1);
    }
    alias = await selectAlias('Select a connection to test');
  }

  const resolvedAlias = resolveAlias(alias);
  const connection = resolvedAlias ? getConnectionByAlias(resolvedAlias) : undefined;

  if (!connection) {
    if (json) {
      printJson({ alias, ok: false, error: 'Alias not found' });
    } else {
      console.error(chalk.red(`Alias not found: ${alias}`));
    }
    process.exitCode = 1;
    return;
  }

  if (!json) {
    console.log(`\nTesting connection to ${chalk.blue(connection.alias)}...`);
  }

  const result = await testConnection(connection, options);

  if (json) {
    printJson(result);
  } else if (result.ok) {
    console.log(chalk.green('Connection successful!'));
  } else {
    console.error(chalk.red('Connection failed.'));
    if (result.stderr.trim()) {
      console.error(chalk.grey(result.stderr.trim()));
    }
  }

  process.exitCode = result.ok ? 0 : 1;
}
