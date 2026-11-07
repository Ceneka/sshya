import chalk from 'chalk';
import { getConnectionByAlias } from '../database';
import { findAliasBySearchTerm, selectAlias } from '../helpers/selectAlias';
import { buildInteractiveSshArgs, buildSshArgs, formatShellCommand } from '../helpers/ssh';
import { jsonEnabled, printJson } from '../output';

export interface ShowOptions {
  json?: boolean;
}

export async function showConnectionPrompt(alias?: string, options: ShowOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);

  if (!alias) {
    if (!process.stdin.isTTY) {
      const message = 'Alias is required when stdin is not a TTY.';
      if (json) {
        printJson({ ok: false, error: message });
      } else {
        console.error(chalk.red(message));
        console.error(chalk.grey('Usage: sshya show <alias> [--json]'));
      }
      process.exit(1);
    }
    alias = await selectAlias('Select a connection to show');
  }

  const resolvedAlias = getConnectionByAlias(alias) ? alias : findAliasBySearchTerm(alias);
  const connection = resolvedAlias ? getConnectionByAlias(resolvedAlias) : undefined;

  if (!connection) {
    if (json) {
      printJson({ ok: false, error: `Alias not found: ${alias}` });
    } else {
      console.error(chalk.red(`Alias not found: ${alias}`));
    }
    process.exitCode = 1;
    return;
  }

  const sshArgs = buildSshArgs(connection);
  const interactiveArgs = buildInteractiveSshArgs(connection);
  const payload = {
    connection,
    sshArgs,
    sshCommand: formatShellCommand('ssh', sshArgs),
    interactiveSshArgs: interactiveArgs,
    interactiveSshCommand: formatShellCommand('ssh', interactiveArgs),
  };

  if (json) {
    printJson(payload);
    return;
  }

  const rows: Array<[string, string | undefined]> = [
    ['Alias', connection.alias],
    ['User', connection.user],
    ['Host', connection.host],
    ['Port', connection.port],
    ['Key', connection.key_path],
    ['Remote path', connection.remote_path],
    ['Last used', connection.lastUsed ? new Date(connection.lastUsed).toISOString() : undefined],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    console.log(`${chalk.bold(label.padEnd(width))}  ${value ?? chalk.grey('-')}`);
  }

  console.log('\n' + chalk.bold('Run a command:'));
  console.log(chalk.grey(`  sshya run ${connection.alias} -- <command>`));
  console.log(chalk.bold('\nInteractive SSH:'));
  console.log(chalk.grey(`  ${payload.interactiveSshCommand}`));
}
