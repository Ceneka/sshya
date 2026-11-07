import { expandHomePath, type Connection } from '../database';
import { buildRemoteCommand, wrapInSingleQuotes } from './shell';

export interface SshArgsOptions {
  /** Allocate a TTY (`-t`). Agents should leave this off (`-T`). */
  tty?: boolean;
  /** Fail instead of prompting for a password. Defaults to false. */
  batchMode?: boolean;
  /** SSH ConnectTimeout in seconds. */
  connectTimeout?: number;
  /** Include the stored port (`-p`). Defaults to true. */
  port?: boolean;
}

export const buildSshArgs = (connection: Connection, options: SshArgsOptions = {}): string[] => {
  const args: string[] = [];

  if (connection.key_path) {
    args.push('-i', expandHomePath(connection.key_path) ?? connection.key_path);
  }
  if (connection.port && options.port !== false) {
    args.push('-p', String(connection.port));
  }

  args.push(options.tty ? '-t' : '-T');

  if (options.batchMode) {
    args.push('-o', 'BatchMode=yes');
  }
  if (options.connectTimeout && options.connectTimeout > 0) {
    args.push('-o', `ConnectTimeout=${Math.floor(options.connectTimeout)}`);
  }

  args.push(`${connection.user}@${connection.host}`);
  return args;
};

export interface RemoteCommandOptions {
  /** Prefix the command with `cd <remote_path>`. Defaults to true. */
  cwd?: boolean;
}

/**
 * Build the single string OpenSSH passes to the remote login shell.
 */
export const buildRemoteCommandLine = (
  connection: Connection,
  command: string,
  options: RemoteCommandOptions = {},
): string => {
  const parts: string[] = [];
  const remotePath = connection.remote_path?.trim();

  if (options.cwd !== false && remotePath) {
    parts.push(`cd ${wrapInSingleQuotes(remotePath)}`);
  }
  if (command.trim().length > 0) {
    parts.push(command);
  }

  return parts.join(' && ');
};

/**
 * Arguments for a normal interactive login session (`sshya connect`).
 */
export const buildInteractiveSshArgs = (connection: Connection): string[] => {
  const args = buildSshArgs(connection, { tty: true });
  const remoteCommand = buildRemoteCommand({
    remotePath: connection.remote_path,
    postCommand: 'exec "$SHELL" -l',
  });
  if (remoteCommand) {
    args.push(remoteCommand);
  }
  return args;
};

const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const quoteShellArg = (value: string): string => {
  if (value.length === 0) {
    return "''";
  }
  if (SAFE_SHELL_ARG.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
};

/** Render an argv array as a copy-pasteable shell command. */
export const formatShellCommand = (command: string, args: string[]): string => {
  return [command, ...args.map(quoteShellArg)].join(' ');
};
