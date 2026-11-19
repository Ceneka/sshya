import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Connection } from '../database';

/**
 * OpenSSH connection multiplexing (ControlMaster/ControlPersist) lets every
 * `sshya run` reuse a warm TCP session instead of paying a full handshake.
 *
 * This is invisible to the caller: the first call opens the master, later calls
 * attach to it, and the master goes away by itself after `ControlPersist`.
 * On Windows, OpenSSH does not support ControlMaster, so reuse is disabled.
 */

const DEFAULT_PERSIST_SECONDS = 300;

const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0);

export const isMultiplexingSupported = (): boolean => process.platform !== 'win32';

export const getControlDir = (): string => {
  const override = process.env.SSHYA_CONTROL_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  const base = runtimeDir && runtimeDir.length > 0 ? runtimeDir : os.tmpdir();
  return path.join(base, `sshya-${currentUid()}`, 'pool');
};

/**
 * Create the socket directory with owner-only permissions. Returns `undefined`
 * when the directory cannot be used, in which case sshya falls back to a normal
 * one-shot connection instead of failing.
 */
export const ensureControlDir = (): string | undefined => {
  const dir = getControlDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch {
    return undefined;
  }
};

/**
 * Whether this invocation may reuse a pooled connection.
 *
 * Precedence: explicit `false` > `SSHYA_REUSE=0` > platform support.
 */
export const reuseEnabled = (explicit?: boolean): boolean => {
  if (explicit === false) {
    return false;
  }

  const env = process.env.SSHYA_REUSE?.trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'no' || env === 'off') {
    return false;
  }

  return isMultiplexingSupported();
};

export const getControlPersistSeconds = (explicit?: number): number => {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  const raw = Number(process.env.SSHYA_CONTROL_PERSIST);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }

  return DEFAULT_PERSIST_SECONDS;
};

/**
 * Deterministic socket path for a connection. The hash keeps `ControlPath`
 * short (OpenSSH has a ~104 byte limit) and avoids exposing host names in the
 * filesystem. Reusing the same target from two aliases shares the master.
 */
export const controlSocketPath = (connection: Connection): string => {
  const identity = [
    connection.user,
    connection.host,
    connection.port ?? '22',
    connection.key_path ?? '',
  ].join('\0');

  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return path.join(getControlDir(), digest);
};

export const hasControlSocket = (connection: Connection): boolean => {
  try {
    return fs.existsSync(controlSocketPath(connection));
  } catch {
    return false;
  }
};

export interface ControlSocketStat {
  inode: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * Metadata for an existing control socket.
 *
 * A master that crashed can leave its socket file behind. `reused` must not
 * trust a bare path: ssh will silently replace a stale socket with a fresh
 * master. Keeping the stat before/after the command lets the caller detect
 * that replacement (the inode/mtime changes) without spawning a separate
 * `ssh -O check` on every run.
 */
export const controlSocketStat = (connection: Connection): ControlSocketStat | undefined => {
  try {
    const stat = fs.statSync(controlSocketPath(connection));
    if (!stat.isSocket()) {
      return undefined;
    }
    return {
      inode: stat.ino,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch {
    return undefined;
  }
};

export const controlTarget = (connection: Connection): string =>
  `${connection.user}@${connection.host}`;
