export const escapeSingleQuotes = (value: string): string => value.replace(/'/g, "'\\''");

export const wrapInSingleQuotes = (value: string): string => `'${escapeSingleQuotes(value)}'`;

const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const quoteShellArg = (value: string): string => {
    if (value.length === 0) {
        return "''";
    }
    if (SAFE_SHELL_ARG.test(value)) {
        return value;
    }
    return wrapInSingleQuotes(value);
};

/**
 * Quote a remote path while keeping `~` expansion working. Single quotes would
 * turn `~/x` into a literal directory named `~`, which is never what a caller
 * means.
 */
export const quoteRemotePath = (value: string): string => {
    if (value === '~') {
        return '"$HOME"';
    }
    if (value.startsWith('~/')) {
        const rest = value.slice(2);
        return rest.length === 0 ? '"$HOME"' : `"$HOME"/${quoteShellArg(rest)}`;
    }
    return quoteShellArg(value);
};

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
        commands.push(`cd ${quoteRemotePath(remotePath.trim())}`);
    }
    if (postCommand && postCommand.trim().length > 0) {
        commands.push(postCommand.trim());
    }
    if (commands.length === 0) {
        return undefined;
    }
    return commands.join(' && ');
};

