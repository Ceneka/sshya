import chalk from "chalk";
import Fuse from "fuse.js";
import inquirer from "inquirer";
import { getConnectionByAlias, getConnections, type Connection } from "../database";
import { jsonEnabled } from "../output";
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
 * Top fuzzy candidates for an unknown alias. These are hints only: callers must
 * never execute against them unless an interactive human explicitly chose one.
 */
export const findAliasSuggestions = (term: string, limit: number = 3): string[] => {
    if (term.trim().length === 0) {
        return [];
    }
    return searchAliasChoices(term)
        .slice(0, Math.max(0, limit))
        .map(choice => choice.value);
};

export interface AliasResolution {
    ok: true;
    /** Exact alias, or the fuzzy match a human approved in a TTY. */
    alias: string;
    connection: Connection;
    /** True when Fuse resolved a typo instead of an exact alias. */
    fuzzy: boolean;
}

export interface AliasResolutionFailure {
    ok: false;
    /** Top fuzzy candidates so agents can correct the typo themselves. */
    suggestions: string[];
}

export type AliasResolutionResult = AliasResolution | AliasResolutionFailure;

export interface ResolveAliasOptions {
    json?: boolean;
    /** Override TTY detection (tests and interactive-only callers). */
    interactive?: boolean;
}

const hasInteractiveTerminal = (): boolean =>
    Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Resolve an alias for a command.
 *
 * Exact matches always win. Fuzzy matching is a human convenience and is only
 * allowed when both stdin and stdout are TTYs and JSON output is off (including
 * `SSHYA_JSON`). Agents get a failure with suggestions instead, because a
 * near-match could send the command to a different host.
 */
export const resolveAliasForCommand = (
    term: string,
    options: ResolveAliasOptions = {},
): AliasResolutionResult => {
    const exact = getConnectionByAlias(term);
    if (exact) {
        return { ok: true, alias: exact.alias, connection: exact, fuzzy: false };
    }

    const json = jsonEnabled(options.json);
    const interactive = options.interactive ?? hasInteractiveTerminal();

    if (json || !interactive) {
        return { ok: false, suggestions: findAliasSuggestions(term) };
    }

    const matchedAlias = findAliasBySearchTerm(term);
    const connection = matchedAlias ? getConnectionByAlias(matchedAlias) : undefined;
    if (!connection) {
        return { ok: false, suggestions: findAliasSuggestions(term) };
    }

    console.error(chalk.grey(`Using alias "${connection.alias}" for "${term}"`));
    return { ok: true, alias: connection.alias, connection, fuzzy: true };
};

/**
 * Prompt user to choose a connection alias using fuzzy search.
 * Aborts the process if user presses ESC or if no connections are available.
 * @param message Prompt message to display
 * @returns selected alias as string
 */
export async function selectAlias(message: string = "Select a connection"): Promise<string> {
    if (!process.stdin.isTTY) {
        console.error(chalk.red('No alias provided and stdin is not a TTY.'));
        console.error(chalk.grey('Pass an alias, or run this command in an interactive terminal.'));
        process.exit(1);
    }

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
