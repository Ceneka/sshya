import chalk from "chalk";
import { getConnections } from "../database";

export async function listConnectionsPrompt() {
    const connections = getConnections();
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
