import chalk from "chalk";
import { getConnectionByAlias } from "../database";
import { buildSSHArgs, runSSH } from "../ssh";
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
    runSSH(alias, connection);
  } else {
    console.error(chalk.red('Alias not found'));
  }
}

export async function printConnectionsPrompt(alias?: string) {
  if (!alias) {
    alias = await selectAlias('Select a connection');
  }
  const connection = getConnectionByAlias(alias);
  if (connection) {
    let args = buildSSHArgs(connection);
    console.log(args.join(' '));
  } else {
    console.error(chalk.red('Alias not found'));
  }
}
