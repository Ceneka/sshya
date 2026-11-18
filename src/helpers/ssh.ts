import { expandHomePath, type Connection } from '../database';
import {
  controlSocketPath,
  ensureControlDir,
  getControlPersistSeconds,
  reuseEnabled,
} from './control';
import { buildRemoteCommand, quoteRemotePath, quoteShellArg } from './shell';
export { quoteShellArg, quoteRemotePath } from './shell';

export type HostKeyChecking = 'strict' | 'accept-new' | 'ask';

export interface SshOptionArgsOptions {
  /** Fail instead of prompting for a password. */
  batchMode?: boolean;
  /** SSH ConnectTimeout in seconds. */
  connectTimeout?: number;
  /** Reuse a pooled connection via ControlMaster. */
  reuse?: boolean;
  /** Seconds to keep the multiplexed master alive. */
  controlPersist?: number;
  /** First-contact host key policy. */
  hostKeyChecking?: HostKeyChecking;
  /** Keepalive interval in seconds; 0 disables it. */
  serverAliveInterval?: number;
}

export interface SshArgsOptions extends SshOptionArgsOptions {
  /** Allocate a TTY (`-t`). Agents should leave this off (`-T`). */
  tty?: boolean;
  /** Include the stored port (`-p`). Defaults to true. */
  port?: boolean;
}

const envHostKeyChecking = (): HostKeyChecking | undefined => {
  const value = process.env.SSHYA_HOST_KEY_CHECKING?.trim().toLowerCase();
  if (value === 'strict' || value === 'yes') {
    return 'strict';
  }
  if (value === 'accept-new' || value === 'accept_new') {
    return 'accept-new';
  }
  if (value === 'ask') {
    return 'ask';
  }
  return undefined;
};

const hostKeyCheckingValue = (mode: HostKeyChecking): string => {
  if (mode === 'strict') {
    return 'yes';
  }
  return mode;
};

/**
 * Connection-level `-o` options shared by ssh and scp (identity/port flags are
 * added by each caller because scp uses `-P` instead of `-p`).
 */
export const buildSshOptionArgs = (
  connection: Connection,
  options: SshOptionArgsOptions = {},
): string[] => {
  const args: string[] = [];

  if (options.batchMode) {
    args.push('-o', 'BatchMode=yes');
  }

  if (options.connectTimeout && options.connectTimeout > 0) {
    args.push('-o', `ConnectTimeout=${Math.floor(options.connectTimeout)}`);
  }

  const aliveInterval = options.serverAliveInterval ?? 15;
  if (aliveInterval > 0) {
    args.push('-o', `ServerAliveInterval=${Math.floor(aliveInterval)}`);
    args.push('-o', 'ServerAliveCountMax=3');
  }

  // Deterministic auth: when a key is stored, do not let a crowded ssh-agent
  // produce "Too many authentication failures".
  if (connection.key_path) {
    args.push('-o', 'IdentitiesOnly=yes');
  }

  const hostKeyChecking = options.hostKeyChecking ?? envHostKeyChecking();
  if (hostKeyChecking) {
    args.push('-o', `StrictHostKeyChecking=${hostKeyCheckingValue(hostKeyChecking)}`);
  }

  if (options.reuse === true && reuseEnabled(true)) {
    const dir = ensureControlDir();
    if (dir) {
      const socket = controlSocketPath(connection);
      args.push(
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${socket}`,
        '-o', `ControlPersist=${getControlPersistSeconds(options.controlPersist)}`,
      );
    }
  }

  return args;
};

export const buildSshArgs = (connection: Connection, options: SshArgsOptions = {}): string[] => {
  const args: string[] = [];

  if (connection.key_path) {
    args.push('-i', expandHomePath(connection.key_path) ?? connection.key_path);
  }
  if (connection.port && options.port !== false) {
    args.push('-p', String(connection.port));
  }

  args.push(options.tty ? '-t' : '-T');
  args.push(...buildSshOptionArgs(connection, options));

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
    parts.push(`cd ${quoteRemotePath(remotePath)}`);
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
  const args = buildSshArgs(connection, { tty: true, reuse: false });
  const remoteCommand = buildRemoteCommand({
    remotePath: connection.remote_path,
    postCommand: 'exec "$SHELL" -l',
  });
  if (remoteCommand) {
    args.push(remoteCommand);
  }
  return args;
};

/** Render an argv array as a copy-pasteable shell command. */
export const formatShellCommand = (command: string, args: string[]): string => {
  return [command, ...args.map(quoteShellArg)].join(' ');
};
