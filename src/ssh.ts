import type { Connection } from './database';
import { expandHomePath } from './database';
import { buildRemoteCommand } from './helpers/shell';

export function buildSSHArgs(connection: Connection) {
    const args: (string | number)[] = [];
    if (connection.key_path) {
        const expandedKeyPath = expandHomePath(connection.key_path);
        args.push('-i', expandedKeyPath ?? connection.key_path);
    }
    if (connection.port) args.push('-p', connection.port);
    args.push(`${connection.user}@${connection.host}`);
    if (connection.remote_path) {
        const remoteCommand = buildRemoteCommand({
            remotePath: connection.remote_path,
            postCommand: 'exec "$SHELL" -l',
        });
        if (remoteCommand) {
            args.push('-t', remoteCommand);
        }
    }
    return args.map(String);
}
