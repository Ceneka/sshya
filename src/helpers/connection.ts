import chalk from "chalk";
import { expandHomePath, getConnectionByAlias } from "../database";
import { buildRemoteCommand } from "./shell";

export async function printConnectionsPrompt(alias?: string) {
  if (!alias) {
    console.error(chalk.red('Alias is required'));
    process.exit(1);
  }
  const connection = getConnectionByAlias(alias);
  if (!connection) {
    console.error(chalk.red('Alias not found'));
    process.exit(1);
  }
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
  console.log(parts.join(' '));
}
