import chalk from "chalk";
import { getConnectionByAlias } from "../database";
import { runSSH } from "../ssh";
import { selectAlias } from "./selectAlias";

/**
 * Helper to prompt user to select a connection and then connect
 */
export async function connectInteractive(alias?: string) {
  if (!alias) {
    alias = await selectAlias('Select a connection');
  }
  const connection = getConnectionByAlias(alias);
  if (connection) {
    const { user, host, key_path, port } = connection;
    runSSH(alias, user, host, key_path, port);
  } else {
    console.error(chalk.red('Alias not found'));
  }
}
