import chalk from 'chalk';
import fs from 'fs';
import inquirer from 'inquirer';
import { addConnection, connectionSchema, getConnectionByAlias, updateConnection } from '../database';

export const importConnectionsPrompt = async (file: string) => {
    if (!fs.existsSync(file)) {
        console.error(chalk.red(`File not found: ${file}`));
        process.exit(1);
    }

    try {
        const fileContent = fs.readFileSync(file, 'utf-8');
        const connectionsToImport = JSON.parse(fileContent);

        if (!Array.isArray(connectionsToImport)) {
            console.error(chalk.red('Invalid file format. Expected a JSON array of connections.'));
            process.exit(1);
        }

        let importedCount = 0;
        let skippedCount = 0;
        let updatedCount = 0;

        console.log(`Found ${connectionsToImport.length} connections to import.`);

        for (const conn of connectionsToImport) {
            const validation = connectionSchema.safeParse(conn);
            if (!validation.success) {
                console.log(chalk.yellow(`Skipping invalid connection object: ${JSON.stringify(conn)}`));
                skippedCount++;
                continue;
            }
            const parsedConn = validation.data;

            const existingConn = getConnectionByAlias(parsedConn.alias);
            if (existingConn) {
                const { action } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'action',
                        message: `Connection with alias "${parsedConn.alias}" already exists. What do you want to do?`,
                        choices: ['Skip', 'Overwrite'],
                    },
                ]);

                if (action === 'Skip') {
                    skippedCount++;
                    continue;
                }

                if (action === 'Overwrite') {
                    updateConnection(parsedConn.alias, parsedConn.user, parsedConn.host, parsedConn.key_path ?? '', parsedConn.port ? String(parsedConn.port) : undefined);
                    updatedCount++;
                }
            } else {
                addConnection(parsedConn.alias, parsedConn.user, parsedConn.host, parsedConn.key_path, parsedConn.port ? String(parsedConn.port) : undefined);
                importedCount++;
            }
        }

        console.log(chalk.green('\nImport complete!'));
        console.log(`- ${importedCount} new connections added.`);
        console.log(`- ${updatedCount} connections overwritten.`);
        console.log(`- ${skippedCount} connections skipped.`);
    } catch (err: any) {
        console.error(chalk.red(`Error reading or parsing file: ${err instanceof Error ? err.message : String(err)}`));
    }
    process.exit(0);
}; 
