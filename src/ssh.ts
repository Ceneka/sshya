import type { Connection } from './database';

export function buildSSHArgs(connection: Connection) {
    const args: (string | number)[] = [];
    if (connection.key_path) args.push('-i', connection.key_path);
    if (connection.port) args.push('-p', connection.port);
    args.push(`${connection.user}@${connection.host}`);
    return args.map(String);
}
