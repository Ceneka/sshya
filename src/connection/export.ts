import chalk from 'chalk';
import fs from 'fs';
import { getConnections } from '../database';
import { jsonEnabled, printJson } from '../output';

export interface ExportOptions {
    json?: boolean;
}

export const exportConnectionsPrompt = (file: string = 'sshm-export.json', options: ExportOptions = {}) => {
    const json = jsonEnabled(options.json);
    const connections = getConnections();

    if (connections.length === 0) {
        if (json) {
            printJson({ ok: false, error: 'No connections to export.' });
        } else {
            console.error(chalk.yellow('No connections to export.'));
        }
        process.exit(1);
    }

    const payload = JSON.stringify(connections, null, 2);

    if (file === '-') {
        // Write only the JSON document to stdout so it can be piped.
        process.stdout.write(`${payload}\n`);
        return;
    }

    fs.writeFileSync(file, payload);

    if (json) {
        printJson({ ok: true, file, count: connections.length });
        return;
    }

    console.log(chalk.green(`Successfully exported ${connections.length} connections to ${file}`));
};
