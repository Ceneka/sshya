import chalk from "chalk";
import os from "os";
import { getConnections } from "../database";
import { buildRemoteCommand } from "../helpers/shell";

export async function listConnectionsPrompt(options?: { oneline?: boolean; names?: boolean }) {
    let connections = getConnections();
    if (options?.oneline) {
        // Sort by lastUsed descending so most recently used is first in the pipe;
        // fzf's default layout places the first line at the bottom near the cursor.
        if (options?.names) {
            connections = connections.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
        }

        // Pre-compute constants outside the loop
        const TAB = '\t';
        const SPACE = ' ';
        const DASH_I = '-i';
        const DASH_P = '-p';
        const DASH_T = '-t';
        const SINGLE_QUOTE = "'";
        const ESCAPED_QUOTE = "'\\''";

        // Cache home directory for path expansion
        const homeDir = os.homedir();

        // Pre-compute user@host combinations to avoid string concatenation in loop
        const userHostCache = new Map<string, string>();
        for (const c of connections) {
            userHostCache.set(c.alias, `${c.user}@${c.host}`);
        }

        for (const c of connections) {
            // Use cached user@host
            const userHost = userHostCache.get(c.alias)!;

            if (options?.names) {
                console.log(c.alias + TAB + userHost);
            } else {
                // Simple args-only format (even faster)
                const args: string[] = [];

                if (c.key_path) {
                    let expandedKeyPath = c.key_path;
                    if (expandedKeyPath.startsWith('~')) {
                        if (expandedKeyPath === '~') {
                            expandedKeyPath = homeDir;
                        } else if (expandedKeyPath.startsWith('~/')) {
                            expandedKeyPath = homeDir + expandedKeyPath.slice(1);
                        }
                    }

                    const needsEscaping = expandedKeyPath.includes(SINGLE_QUOTE);
                    const quotedKey = needsEscaping
                        ? SINGLE_QUOTE + expandedKeyPath.replace(/'/g, ESCAPED_QUOTE) + SINGLE_QUOTE
                        : SINGLE_QUOTE + expandedKeyPath + SINGLE_QUOTE;

                    args.push(DASH_I, quotedKey);
                }

                if (c.port) {
                    args.push(DASH_P, String(c.port));
                }

                args.push(DASH_T);
                args.push(userHost);

                if (c.remote_path) {
                    const remoteCommand = buildRemoteCommand({
                        remotePath: String(c.remote_path),
                        postCommand: 'exec "$SHELL" -l',
                    });
                    if (remoteCommand) {
                        args.push(remoteCommand);
                    }
                }

                console.log(args.join(SPACE));
            }
        }

        process.exit(0);
    }

    if (connections.length === 0) {
        console.log(chalk.yellow('No connections found. Add one with "sshya add"'));
        return;
    }

    const maxLengths = {
        alias: 'Alias'.length,
        user: 'User'.length,
        host: 'Host'.length,
        port: 'Port'.length,
    };

    for (const c of connections) {
        if (c.alias.length > maxLengths.alias) {
            maxLengths.alias = c.alias.length;
        }
        if (c.user.length > maxLengths.user) {
            maxLengths.user = c.user.length;
        }
        if (c.host.length > maxLengths.host) {
            maxLengths.host = c.host.length;
        }
        if (c.port && String(c.port).length > maxLengths.port) {
            maxLengths.port = String(c.port).length;
        }
    }

    const header =
        chalk.bold('Alias'.padEnd(maxLengths.alias)) +
        '  ' +
        chalk.bold('User'.padEnd(maxLengths.user)) +
        '  ' +
        chalk.bold('Host'.padEnd(maxLengths.host)) +
        '  ' +
        chalk.bold('Port'.padEnd(maxLengths.port));
    console.log(header);

    const separator =
        '-'.repeat(maxLengths.alias) +
        '  ' +
        '-'.repeat(maxLengths.user) +
        '  ' +
        '-'.repeat(maxLengths.host) +
        '  ' +
        '-'.repeat(maxLengths.port);
    console.log(separator);

    for (const c of connections) {
        const port = c.port ? String(c.port) : '';
        const row =
            c.alias.padEnd(maxLengths.alias) +
            '  ' +
            c.user.padEnd(maxLengths.user) +
            '  ' +
            c.host.padEnd(maxLengths.host) +
            '  ' +
            port.padEnd(maxLengths.port);
        console.log(row);
    }

    process.exit(0);
}
