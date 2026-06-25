import chalk from "chalk";
import Fuse from "fuse.js";
import inquirer from "inquirer";
import { getConnections } from "../database";
import { enableEscapeExit } from "./escExit";

const getAliasChoices = () => {
    return getConnections()
        .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
        .map(c => ({ name: c.alias, value: c.alias }));
};

const searchAliasChoices = (term: string) => {
    const choices = getAliasChoices();
    if (term.trim().length === 0) {
        return choices;
    }

    const fuse = new Fuse(choices, {
        keys: ['name'],
        threshold: 0.4,
    });

    return fuse.search(term).map(r => r.item);
};

export const findAliasBySearchTerm = (term: string): string | undefined => {
    return searchAliasChoices(term)[0]?.value;
};

/**
 * Prompt user to choose a connection alias using fuzzy search.
 * Aborts the process if user presses ESC or if no connections are available.
 * @param message Prompt message to display
 * @returns selected alias as string
 */
export async function selectAlias(message: string = "Select a connection"): Promise<string> {
    if (getConnections().length === 0) {
        console.log(chalk.yellow('No connections found. Add one with "sshya add"'));
        process.exit(0);
    }


    const cleanup = enableEscapeExit();
    try {
        const { alias } = await inquirer.prompt([
            {
                type: 'search',
                name: 'alias',
                message,
                // Fuzzy-search the aliases using Fuse.js as the user types.
                // The signature matches the @inquirer/search documentation:
                //   (term: string | void, { signal }: { signal: AbortSignal }) => Promise<Choice[]>
                source: async (term: unknown) => {
                    // When term is undefined or empty, return the full, recently-used-sorted list.
                    if (typeof term !== 'string' || term.trim().length === 0) {
                        return searchAliasChoices('');
                    }

                    return searchAliasChoices(term);
                },
            },
        ]);
        return alias as string;
    } finally {
        cleanup();
    }
} 
