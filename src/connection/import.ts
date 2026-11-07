import chalk from 'chalk';
import fs from 'fs';
import inquirer from 'inquirer';
import { addConnection, connectionSchema, getConnectionByAlias, updateConnection } from '../database';
import { enableEscapeExit } from '../helpers/escExit';
import { jsonEnabled, printJson } from '../output';

export type ImportStrategy = 'ask' | 'skip' | 'overwrite' | 'error';

export interface ImportOptions {
    /**
     * How to handle aliases that already exist.
     * `error` (the non-interactive default) refuses to write anything.
     */
    strategy?: ImportStrategy;
    json?: boolean;
}

interface ImportSummary {
    ok: boolean;
    total: number;
    imported: number;
    updated: number;
    skipped: number;
    invalid: number;
    errors: string[];
}

export const importConnectionsPrompt = async (file: string, options: ImportOptions = {}) => {
    const json = jsonEnabled(options.json);

    const validStrategies: ImportStrategy[] = ['ask', 'skip', 'overwrite', 'error'];
    if (options.strategy !== undefined && !validStrategies.includes(options.strategy)) {
        const message = `Invalid strategy "${options.strategy}". Use ask, skip, overwrite, or error.`;
        if (json) {
            printJson({ ok: false, error: message });
        } else {
            console.error(chalk.red(message));
        }
        process.exit(1);
    }

    if (file === '-' && process.stdin.isTTY) {
        const message = 'Refusing to read from an interactive terminal. Pipe JSON into stdin or pass a file path.';
        if (json) {
            printJson({ ok: false, error: message });
        } else {
            console.error(chalk.red(message));
        }
        process.exit(1);
    }

    const input = file === '-' ? fs.readFileSync(0, 'utf-8') : (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined);
    if (input === undefined) {
        const message = `File not found: ${file}`;
        if (json) {
            printJson({ ok: false, error: message });
        } else {
            console.error(chalk.red(message));
        }
        process.exit(1);
    }

    let connectionsToImport: unknown;
    try {
        connectionsToImport = JSON.parse(input);
    } catch (err) {
        const message = `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
        if (json) {
            printJson({ ok: false, error: message });
        } else {
            console.error(chalk.red(message));
        }
        process.exit(1);
    }

    if (!Array.isArray(connectionsToImport)) {
        const message = 'Invalid file format. Expected a JSON array of connections.';
        if (json) {
            printJson({ ok: false, error: message });
        } else {
            console.error(chalk.red(message));
        }
        process.exit(1);
    }

    const requestedStrategy: ImportStrategy = options.strategy ?? 'ask';
    // Interactive prompting is impossible without a TTY, so fall back to strict.
    const strategy: ImportStrategy = requestedStrategy === 'ask' && !process.stdin.isTTY
        ? 'error'
        : requestedStrategy;

    const valid: Array<ReturnType<typeof connectionSchema.parse>> = [];
    const summary: ImportSummary = {
        ok: true,
        total: connectionsToImport.length,
        imported: 0,
        updated: 0,
        skipped: 0,
        invalid: 0,
        errors: [],
    };

    for (const conn of connectionsToImport) {
        const validation = connectionSchema.safeParse(conn);
        if (!validation.success) {
            summary.invalid++;
            summary.errors.push(`Skipping invalid connection object: ${JSON.stringify(conn)}`);
            continue;
        }
        valid.push(validation.data);
    }

    // Fail before touching the store when the caller asked for strict handling.
    if (strategy === 'error') {
        const conflicts = valid.filter(conn => getConnectionByAlias(conn.alias));
        if (conflicts.length > 0) {
            summary.ok = false;
            for (const conflict of conflicts) {
                summary.errors.push(`Connection with alias "${conflict.alias}" already exists.`);
            }
            if (json) {
                printJson(summary);
            } else {
                for (const message of summary.errors) {
                    console.error(chalk.red(message));
                }
            }
            process.exit(1);
        }
    }

    if (!json) {
        console.log(`Found ${connectionsToImport.length} connections to import.`);
    }

    const cleanup = strategy === 'ask' ? enableEscapeExit() : () => {};
    try {
        for (const parsedConn of valid) {
            const existingConn = getConnectionByAlias(parsedConn.alias);

            if (existingConn) {
                let action: 'Skip' | 'Overwrite' = 'Skip';

                if (strategy === 'ask') {
                    const answer = await inquirer.prompt([
                        {
                            type: 'select',
                            name: 'action',
                            message: `Connection with alias "${parsedConn.alias}" already exists. What do you want to do?`,
                            choices: ['Skip', 'Overwrite'],
                        },
                    ]);
                    action = answer.action as 'Skip' | 'Overwrite';
                } else if (strategy === 'overwrite') {
                    action = 'Overwrite';
                }

                if (action === 'Skip') {
                    summary.skipped++;
                    continue;
                }

                updateConnection(
                    parsedConn.alias,
                    parsedConn.user,
                    parsedConn.host,
                    parsedConn.key_path ?? '',
                    parsedConn.port ? String(parsedConn.port) : undefined,
                    parsedConn.remote_path,
                );
                summary.updated++;
                continue;
            }

            addConnection(
                parsedConn.alias,
                parsedConn.user,
                parsedConn.host,
                parsedConn.key_path,
                parsedConn.port ? String(parsedConn.port) : undefined,
                parsedConn.remote_path,
            );
            summary.imported++;
        }
    } catch (err) {
        summary.ok = false;
        summary.errors.push(err instanceof Error ? err.message : String(err));
    } finally {
        cleanup();
    }

    if (summary.invalid > 0) {
        summary.ok = false;
    }

    if (json) {
        printJson(summary);
    } else {
        for (const message of summary.errors) {
            console.error(chalk.yellow(message));
        }
        console.log(chalk.green('\nImport complete!'));
        console.log(`- ${summary.imported} new connections added.`);
        console.log(`- ${summary.updated} connections overwritten.`);
        console.log(`- ${summary.skipped} connections skipped.`);
        console.log(`- ${summary.invalid} invalid connections skipped.`);
    }

    process.exitCode = summary.ok ? 0 : 1;
};
