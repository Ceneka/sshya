export const escapeSingleQuotes = (value: string): string => value.replace(/'/g, "'\\''");

export const wrapInSingleQuotes = (value: string): string => `'${escapeSingleQuotes(value)}'`;

interface RemoteCommandOptions {
    remotePath?: string;
    postCommand?: string;
}

export const buildRemoteCommand = ({
    remotePath,
    postCommand,
}: RemoteCommandOptions): string | undefined => {
    const commands: string[] = [];
    if (typeof remotePath === 'string' && remotePath.trim().length > 0) {
        commands.push(`cd ${wrapInSingleQuotes(remotePath.trim())}`);
    }
    if (postCommand && postCommand.trim().length > 0) {
        commands.push(postCommand.trim());
    }
    if (commands.length === 0) {
        return undefined;
    }
    return commands.join(' && ');
};

