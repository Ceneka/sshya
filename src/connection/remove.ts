import chalk from "chalk";
import { removeConnection } from "../database";
import { selectAlias } from "../helpers/selectAlias";

export async function removeConnectionPrompt(alias?: string) {
    if (!alias) {
        alias = await selectAlias('Select a connection to remove');
    }
    removeConnection(alias);
    console.log(chalk.green('Connection removed successfully'));
}
