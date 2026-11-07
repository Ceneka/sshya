import chalk from 'chalk';
import inquirer from 'inquirer';
import { connectionSchema, getConnectionByAlias, updateConnection, type Connection } from '../database';
import { enableEscapeExit } from '../helpers/escExit';
import { selectAlias } from '../helpers/selectAlias';
import { jsonEnabled, printJson } from '../output';
import { testConnection } from './test';

export interface UpdateOptions {
  user?: string;
  host?: string;
  port?: string;
  key?: string;
  remotePath?: string;
  newAlias?: string;
  /** Run a connectivity test after saving. */
  test?: boolean;
  json?: boolean;
}

const hasUpdates = (options: UpdateOptions): boolean =>
  options.user !== undefined ||
  options.host !== undefined ||
  options.port !== undefined ||
  options.key !== undefined ||
  options.remotePath !== undefined ||
  options.newAlias !== undefined;

const applyUpdates = (
  connection: Connection,
  options: UpdateOptions,
): { alias: string; user: string; host: string; port?: string; key_path?: string; remote_path?: string } => {
  const merged = {
    alias: options.newAlias ?? connection.alias,
    user: options.user ?? connection.user,
    host: options.host ?? connection.host,
    port: options.port !== undefined ? options.port : connection.port,
    key_path: options.key !== undefined ? options.key : connection.key_path,
    remote_path: options.remotePath !== undefined ? options.remotePath : connection.remote_path,
  };

  const parsed = connectionSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(issue => issue.message).join(', '));
  }

  return {
    alias: parsed.data.alias,
    user: parsed.data.user,
    host: parsed.data.host,
    port: parsed.data.port !== undefined ? String(parsed.data.port) : undefined,
    key_path: parsed.data.key_path,
    remote_path: parsed.data.remote_path,
  };
};

const runPostUpdateTest = async (connection: Connection, json: boolean): Promise<boolean> => {
  const result = await testConnection(connection, { json });
  if (!json) {
    if (result.ok) {
      console.log(chalk.green('Connection successful!'));
    } else {
      console.error(chalk.red('Connection failed.'));
      if (result.stderr.trim()) {
        console.error(chalk.grey(result.stderr.trim()));
      }
    }
  }
  return result.ok;
};

export async function updateConnectionPrompt(alias?: string, options: UpdateOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);

  if (!alias) {
    if (!process.stdin.isTTY) {
      const message = 'Alias is required when stdin is not a TTY.';
      if (json) {
        printJson({ ok: false, error: message });
      } else {
        console.error(chalk.red(message));
        console.error(chalk.grey('Usage: sshya update <alias> [--user u] [--host h] [--port p] [--key path] [--remote-path path] [--new-alias name]'));
      }
      process.exit(1);
    }
    alias = await selectAlias('Select a connection to edit');
  }

  const existing = getConnectionByAlias(alias);
  if (!existing) {
    if (json) {
      printJson({ ok: false, error: `Alias not found: ${alias}` });
    } else {
      console.error(chalk.red(`Alias not found: ${alias}`));
    }
    process.exitCode = 1;
    return;
  }

  if (!hasUpdates(options)) {
    if (!process.stdin.isTTY) {
      const message = 'No changes supplied. Pass at least one update flag.';
      if (json) {
        printJson({ ok: false, error: message });
      } else {
        console.error(chalk.red(message));
        console.error(chalk.grey('Example: sshya update my-server --port 2222 --json'));
      }
      process.exit(1);
    }

    const cleanup = enableEscapeExit();
    try {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'alias',
          message: 'Alias:',
          default: existing.alias,
          validate: (input: string) => {
            const trimmed = input.trim();
            if (!trimmed) {
              return 'Alias cannot be empty';
            }
            if (trimmed !== existing.alias && getConnectionByAlias(trimmed)) {
              return `Connection with alias "${trimmed}" already exists.`;
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'user',
          message: 'User:',
          default: existing.user,
        },
        {
          type: 'input',
          name: 'host',
          message: 'Host/IP:',
          default: existing.host,
        },
        {
          type: 'input',
          name: 'port',
          message: 'Port (optional):',
          default: existing.port,
        },
        {
          type: 'input',
          name: 'key_path',
          message: 'Path to key (optional):',
          default: existing.key_path,
        },
        {
          type: 'input',
          name: 'remote_path',
          message: 'Remote working directory (optional):',
          default: existing.remote_path,
        },
      ]);

      const updated = saveUpdate(existing.alias, {
        user: answers.user as string | undefined,
        host: answers.host as string | undefined,
        port: answers.port as string | undefined,
        key: answers.key_path as string | undefined,
        remotePath: answers.remote_path as string | undefined,
        newAlias: answers.alias as string | undefined,
      }, json);

      if (!updated) {
        return;
      }

      const { test } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'test',
          message: 'Do you want to test the updated connection now?',
          default: true,
        },
      ]);

      if (test) {
        const ok = await runPostUpdateTest(updated, json);
        if (!ok) {
          process.exitCode = 1;
        }
      }
    } finally {
      cleanup();
    }
    return;
  }

  const updated = saveUpdate(existing.alias, options, json);
  if (!updated) {
    return;
  }

  if (options.test) {
    const ok = await runPostUpdateTest(updated, json);
    if (!ok) {
      process.exitCode = 1;
    }
  }
}

const saveUpdate = (
  alias: string,
  options: UpdateOptions,
  json: boolean,
): Connection | undefined => {
  try {
    const existing = getConnectionByAlias(alias);
    if (!existing) {
      throw new Error(`Alias not found: ${alias}`);
    }

    const next = applyUpdates(existing, options);
    updateConnection(
      alias,
      next.user,
      next.host,
      next.key_path ?? '',
      next.port,
      next.remote_path,
      next.alias,
    );

    const connection = getConnectionByAlias(next.alias)!;
    if (json) {
      printJson({ ok: true, connection });
    } else {
      const renamed = next.alias !== alias;
      console.log(chalk.green(
        renamed
          ? `Connection updated successfully (renamed to "${next.alias}")`
          : 'Connection updated successfully',
      ));
    }
    return connection;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      printJson({ ok: false, error: message });
    } else {
      console.error(chalk.red(message));
    }
    process.exitCode = 1;
    return undefined;
  }
};
