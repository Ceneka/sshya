import chalk from 'chalk';
import fs from 'fs';
import { getConnections } from '../database';

export const exportConnectionsPrompt = (file: string = 'sshm-export.json') => {
    const connections = getConnections();
    if (connections.length === 0) {
        console.log(chalk.yellow('No connections to export.'));
        process.exit(1);
    }
    fs.writeFileSync(file, JSON.stringify(connections, null, 2));
    console.log(chalk.green(`Successfully exported ${connections.length} connections to ${file}`));
    process.exit(0);
};
