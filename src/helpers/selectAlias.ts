import chalk from "../lib/color";
import { fuzzySearch } from "../lib/fuzzy";
import { getConnectionByAlias, getConnections, type Connection } from "../database";
import { jsonEnabled } from "../output";
import { enableEscapeExit } from "./escExit";

const getAliasChoices = () => {
    return getConnections()
        .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
        .map(c => ({ name: c.alias, value: c.alias }));
};

/**
 * Fuzzy matching uses `src/lib/fuzzy.ts`, a dependency-free port of the
 * Fuse.js 7 scoring sshya used before (keys: ['name'], threshold 0.4), so
 * suggestions and picker ordering are unchanged.
 */
const searchAliasChoices = async (term: string) => {
    const choices = getAliasChoices();
    if (term.trim().length === 0) {
        return choices;
    }

    return fuzzySearch(choices, term, choice => choice.name, { threshold: 0.4 });
};

export const findAliasBySearchTerm = async (term: string): Promise<string | undefined> => {
    return (await searchAliasChoices(term))[0]?.value;
};

/**
 * Top fuzzy candidates for an unknown alias. These are hints only: callers must
 * never execute against them unless an interactive human explicitly chose one.
 */
export const findAliasSuggestions = async (term: string, limit: number = 3): Promise<string[]> => {
    if (term.trim().length === 0) {
        return [];
    }
    return (await searchAliasChoices(term))
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
export const resolveAliasForCommand = async (
    term: string,
    options: ResolveAliasOptions = {},
): Promise<AliasResolutionResult> => {
    const exact = getConnectionByAlias(term);
    if (exact) {
        return { ok: true, alias: exact.alias, connection: exact, fuzzy: false };
    }

    const json = jsonEnabled(options.json);
    const interactive = options.interactive ?? hasInteractiveTerminal();

    if (json || !interactive) {
        return { ok: false, suggestions: await findAliasSuggestions(term) };
    }

    const matchedAlias = await findAliasBySearchTerm(term);
    const connection = matchedAlias ? getConnectionByAlias(matchedAlias) : undefined;
    if (!connection) {
        return { ok: false, suggestions: await findAliasSuggestions(term) };
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
        // Inquirer is a heavy interactive-only dependency; load it only when a
        // human is actually about to be prompted.
        const { default: inquirer } = await import('inquirer');
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
