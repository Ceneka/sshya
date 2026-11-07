import chalk from 'chalk';
import inquirer from 'inquirer';
import { connectionSchema, getConnectionByAlias, upsertConnection, type Connection } from '../database';
import { enableEscapeExit } from '../helpers/escExit';
import { jsonEnabled, printJson } from '../output';
import { testConnection } from './test';

export interface AddOptions {
  user?: string;
  host?: string;
  port?: string;
  key?: string;
  remotePath?: string;
  /** Replace an existing alias instead of failing. */
  force?: boolean;
  /** Run a connectivity test after saving. */
  test?: boolean;
  json?: boolean;
}

const parseTarget = (target?: string): { user?: string; host?: string } => {
  if (!target) {
    return {};
  }
  const at = target.lastIndexOf('@');
  if (at > 0) {
    return { user: target.slice(0, at), host: target.slice(at + 1) };
  }
  return { host: target };
};

const normalizeAddInput = (
  alias: string,
  target: string | undefined,
  options: AddOptions,
): { alias: string; user: string; host: string; port?: string; key_path?: string; remote_path?: string } => {
  const parsedTarget = parseTarget(target);
  const parsed = connectionSchema.safeParse({
    alias,
    user: options.user ?? parsedTarget.user ?? 'root',
    host: options.host ?? parsedTarget.host,
    port: options.port,
    key_path: options.key,
    remote_path: options.remotePath,
  });

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

const runPostSaveTest = async (connection: Connection, json: boolean): Promise<boolean> => {
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

export async function addConnectionPrompt(
  alias?: string,
  target?: string,
  options: AddOptions = {},
): Promise<void> {
  const json = jsonEnabled(options.json);
  const parsedTarget = parseTarget(target);
  const canSkipPrompt = Boolean(alias && (options.host ?? parsedTarget.host));

  if (!canSkipPrompt) {
    if (!process.stdin.isTTY) {
      const message = 'Alias and host are required when stdin is not a TTY.';
      if (json) {
        printJson({ ok: false, error: message });
      } else {
        console.error(chalk.red(message));
        console.error(chalk.grey('Usage: sshya add <alias> <user@host> [--port 22] [--key ~/.ssh/id_ed25519] [--json]'));
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
          default: alias,
        },
        {
          type: 'input',
          name: 'user',
          message: 'User:',
          default: options.user ?? parsedTarget.user ?? 'root',
        },
        {
          type: 'input',
          name: 'host',
          message: 'Host/IP:',
          default: options.host ?? parsedTarget.host,
        },
        {
          type: 'input',
          name: 'port',
          message: 'Port (optional):',
          default: options.port,
        },
        {
          type: 'input',
          name: 'key_path',
          message: 'Path to key (optional):',
          default: options.key,
        },
        {
          type: 'input',
          name: 'remote_path',
          message: 'Remote working directory (optional):',
          default: options.remotePath,
        },
      ]);

      alias = (answers.alias as string)?.trim();
      if (!alias) {
        console.error(chalk.red('Alias is required.'));
        process.exitCode = 1;
        return;
      }

      const connection = saveConnection(alias, String(answers.host ?? ''), {
        user: answers.user as string | undefined,
        port: answers.port as string | undefined,
        key: answers.key_path as string | undefined,
        remotePath: answers.remote_path as string | undefined,
        force: options.force,
      }, json);

      if (!connection) {
        return;
      }

      const { test } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'test',
          message: 'Do you want to test the new connection now?',
          default: true,
        },
      ]);

      if (test) {
        const ok = await runPostSaveTest(connection, json);
        if (!ok) {
          process.exitCode = 1;
        }
      }
    } finally {
      cleanup();
    }
    return;
  }

  const connection = saveConnection(alias!, target, options, json);
  if (!connection) {
    return;
  }

  if (options.test) {
    const ok = await runPostSaveTest(connection, json);
    if (!ok) {
      process.exitCode = 1;
    }
  }
}

const saveConnection = (
  alias: string,
  target: string | undefined,
  options: AddOptions,
  json: boolean,
): Connection | undefined => {
  try {
    const input = normalizeAddInput(alias, target, options);
    const existed = Boolean(getConnectionByAlias(input.alias));
    const connection = upsertConnection(input, options.force === true);

    if (json) {
      printJson({ ok: true, created: !existed, connection });
    } else {
      console.log(chalk.green(
        existed
          ? `Connection "${connection.alias}" updated successfully`
          : 'Connection added successfully',
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
