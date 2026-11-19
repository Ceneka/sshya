import chalk from 'chalk';
import { getConnectionByAlias, LinkedConnectionError, removeConnection } from '../database';
import { selectAlias } from '../helpers/selectAlias';
import { jsonEnabled, printJson } from '../output';

export interface RemoveOptions {
  json?: boolean;
}

export async function removeConnectionPrompt(alias?: string, options: RemoveOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);

  if (!alias) {
    if (!process.stdin.isTTY) {
      const message = 'Alias is required when stdin is not a TTY.';
      if (json) {
        printJson({ ok: false, error: message });
      } else {
        console.error(chalk.red(message));
        console.error(chalk.grey('Usage: sshya remove <alias> [--json]'));
      }
      process.exit(1);
    }
    alias = await selectAlias('Select a connection to remove');
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

  try {
    removeConnection(alias);
  } catch (err) {
    if (!(err instanceof LinkedConnectionError)) {
      throw err;
    }
    if (json) {
      printJson({ ok: false, errorKind: err.errorKind, error: err.message });
    } else {
      console.error(chalk.red(err.message));
    }
    process.exitCode = 1;
    return;
  }

  if (json) {
    printJson({ ok: true, removed: existing });
  } else {
    console.log(chalk.green(`Connection "${alias}" removed successfully`));
  }
}
