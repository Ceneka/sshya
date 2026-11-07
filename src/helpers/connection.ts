import chalk from "chalk";
import { expandHomePath, getConnectionByAlias, recordConnectionUsage } from "../database";
import { buildInteractiveSshArgs, buildSshArgs, formatShellCommand } from "./ssh";
import { buildRemoteCommand } from "./shell";
import { jsonEnabled, printJson } from "../output";

export interface PrintOptions {
  json?: boolean;
}

export async function printConnectionsPrompt(alias?: string, options: PrintOptions = {}) {
  const json = jsonEnabled(options.json);
  if (!alias) {
    if (json) {
      printJson({ ok: false, error: 'Alias is required' });
    } else {
      console.error(chalk.red('Alias is required'));
    }
    process.exit(1);
  }
  const connection = getConnectionByAlias(alias);
  if (!connection) {
    if (json) {
      printJson({ ok: false, error: `Alias not found: ${alias}` });
    } else {
      console.error(chalk.red('Alias not found'));
    }
    process.exit(1);
  }
  // Record usage when connection is accessed via print (used by fzf)
  recordConnectionUsage(alias);
  const parts: string[] = [];
  if (connection.key_path) {
    const expandedKeyPath = expandHomePath(String(connection.key_path));
    const quotedKey = `'${String(expandedKeyPath).replace(/'/g, "'\\''")}'`;
    parts.push('-i', quotedKey);
  }
  if (connection.port) {
    parts.push('-p', String(connection.port));
  }
  // Always add -t for interactive terminal allocation (required for fzf integration)
  parts.push('-t');
  parts.push(`${connection.user}@${connection.host}`);
  if (connection.remote_path) {
    const remoteCommand = buildRemoteCommand({
      remotePath: String(connection.remote_path),
      postCommand: 'exec "$SHELL" -l',
    });
    if (remoteCommand) {
      parts.push(remoteCommand);
    }
  }

  if (json) {
    const sshArgs = buildSshArgs(connection);
    const interactiveArgs = buildInteractiveSshArgs(connection);
    printJson({
      alias: connection.alias,
      sshArgs,
      sshCommand: formatShellCommand('ssh', sshArgs),
      interactiveSshArgs: interactiveArgs,
      interactiveSshCommand: formatShellCommand('ssh', interactiveArgs),
    });
    return;
  }

  console.log(parts.join(' '));
}
