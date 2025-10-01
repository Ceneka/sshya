import chalk from "chalk";
import { getConnectionByAlias } from "../database";

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
    const quotedKey = `'${String(connection.key_path).replace(/'/g, "'\\''")}'`;
    parts.push('-i', quotedKey);
  }
  if (connection.port) {
    parts.push('-p', String(connection.port));
  }
  parts.push(`${connection.user}@${connection.host}`);
  console.log(parts.join(' '));
}
