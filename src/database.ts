import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_DB_FILE = path.join(os.homedir(), '.sshya', 'sshm.json');

/**
 * Resolve the database file path.
 *
 * `SSHYA_DB` lets agents and tests point at an isolated store without touching
 * the user's real `~/.sshya/sshm.json`.
 */
export const getDbPath = (): string => {
  const override = process.env.SSHYA_DB?.trim();
  return override ? path.resolve(override) : DEFAULT_DB_FILE;
};

const getDbDir = (): string => path.dirname(getDbPath());

export interface Connection {
  id: number;
  alias: string;
  user: string;
  host: string;
  key_path?: string;
  port?: string;
  remote_path?: string;
  lastUsed?: number;
  /**
   * When true, agent-facing write helpers (MCP `write_remote_file` and
   * `copy_file` uploads) refuse to modify this host. It is not an SSH-level
   * restriction: `run_command` remains arbitrary.
   */
  readonly?: boolean;
  /**
   * Present when the connection is managed by a linked lazybackup instance
   * (see `src/link/`). The web UI is the source of truth for alias, user, host,
   * and port; only local overlay fields (`key_path`, `remote_path`, `readonly`,
   * `lastUsed`) may be changed here.
   */
  link?: ConnectionLink;
}

export interface ConnectionLink {
  source: 'lazybackup';
  /** lazybackup `servers.id`. */
  id: string;
  /** Display name in lazybackup (the alias is derived from it). */
  name?: string;
  /** lazybackup auth type; password servers cannot run in BatchMode. */
  auth?: 'key' | 'password';
  /** True once the key path was overridden locally; sync stops touching it. */
  localKey?: boolean;
  /**
   * Fingerprint (`SHA256:…`) of this machine's sshya key once lazybackup
   * installed it in the server's authorized_keys (`src/link/deviceKey.ts`).
   */
  deviceKey?: string;
}

/** Thrown when a local mutation targets a field owned by the linked store. */
export class LinkedConnectionError extends Error {
  readonly errorKind = 'linked_connection';
  constructor(alias: string, action: string) {
    super(
      `Connection "${alias}" is managed by lazybackup; ${action} must be done in the lazybackup web UI. ` +
        'Locally you can only change key_path, remote_path, and readonly.',
    );
    this.name = 'LinkedConnectionError';
  }
}

const normalizeLink = (link: unknown): ConnectionLink | undefined => {
  if (!link || typeof link !== 'object') {
    return undefined;
  }
  const value = link as Partial<ConnectionLink>;
  if (value.source !== 'lazybackup' || typeof value.id !== 'string' || !value.id) {
    return undefined;
  }
  return {
    source: 'lazybackup',
    id: value.id,
    ...(typeof value.name === 'string' && value.name ? { name: value.name } : {}),
    ...(value.auth === 'key' || value.auth === 'password' ? { auth: value.auth } : {}),
    ...(value.localKey === true ? { localKey: true } : {}),
    ...(typeof value.deviceKey === 'string' && value.deviceKey ? { deviceKey: value.deviceKey } : {}),
  };
};

const normalizeOptionalString = (value?: string | number | null): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// Cache home directory for performance
let homeDirCache: string | null = null;

export const expandHomePath = (input?: string): string | undefined => {
  if (!input) {
    return undefined;
  }

  // Cache home directory
  if (!homeDirCache) {
    homeDirCache = os.homedir();
  }

  if (input === '~') {
    return homeDirCache;
  }
  if (input.startsWith('~/')) {
    return path.join(homeDirCache, input.slice(2));
  }
  return input;
};

const normalizeConnection = (connection: Connection): Connection => {
  const normalizedKeyPath = expandHomePath(normalizeOptionalString(connection.key_path));
  const normalizedPort = normalizeOptionalString(connection.port);
  const normalizedRemotePath = normalizeOptionalString(connection.remote_path);

  return {
    ...connection,
    alias: connection.alias.trim(),
    user: connection.user.trim(),
    host: connection.host.trim(),
    key_path: normalizedKeyPath,
    port: normalizedPort,
    remote_path: normalizedRemotePath,
    readonly: connection.readonly === true ? true : undefined,
    link: normalizeLink(connection.link),
  };
};

// Cache keyed on the file's mtime and size. Unlike a time-based cache this stays
// correct when another process (or an MCP client) edits the store while a
// long-running `sshya mcp` process is reading it.
let connectionCache: Connection[] | null = null;
let cachePath: string | null = null;
let cacheMtimeMs: number = -1;
let cacheSize: number = -1;

const readDB = (): Connection[] => {
  const dbFilePath = getDbPath();

  // One stat instead of existsSync + statSync. Any failure (missing file, an
  // unreadable directory) is treated as an empty store, which is what
  // existsSync-based code did before.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(dbFilePath, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (!stat) {
    connectionCache = [];
    cachePath = dbFilePath;
    cacheMtimeMs = -1;
    cacheSize = -1;
    return connectionCache;
  }

  if (connectionCache && cachePath === dbFilePath && stat.mtimeMs === cacheMtimeMs && stat.size === cacheSize) {
    return connectionCache;
  }

  const data = fs.readFileSync(dbFilePath, 'utf-8');
  const parsed: Connection[] = data.trim().length === 0 ? [] : JSON.parse(data);
  connectionCache = parsed.map(normalizeConnection);
  cachePath = dbFilePath;
  cacheMtimeMs = stat.mtimeMs;
  cacheSize = stat.size;

  return connectionCache;
};

const writeDB = (data: Connection[]) => {
  const dbDir = getDbDir();
  // Ensure the directory exists before writing
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = getDbPath();
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

  // Keep the store hot instead of invalidating it. `recordConnectionUsage` runs
  // on every agent call, and dropping the cache forced the next call to read and
  // parse the whole file again. The mtime/size of what we just wrote keeps the
  // external-edit check intact.
  const stat = fs.statSync(dbPath, { throwIfNoEntry: false });
  connectionCache = data;
  cachePath = dbPath;
  cacheMtimeMs = stat?.mtimeMs ?? -1;
  cacheSize = stat?.size ?? -1;
};

export const initDB = () => {
  const dbDir = getDbDir();
  // Create base directory if it doesn't exist
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = getDbPath();

  // Initialize empty database file if it does not exist
  if (!fs.existsSync(dbPath)) {
    writeDB([]);
    return;
  }

  // Normalize any existing data on disk once during init, but do not rewrite a
  // store that is already normalized. `--version`, `--help`, and read-only
  // commands must not touch the file (and its mtime) just because they loaded.
  const existingData = readDB();
  const normalized = JSON.stringify(existingData, null, 2);
  const raw = fs.readFileSync(dbPath, 'utf-8');
  if (raw !== normalized) {
    writeDB(existingData);
  }
};

export const addConnection = (
  alias: string,
  user: string,
  host: string,
  key_path?: string,
  port?: string,
  remote_path?: string,
  isReadonly?: boolean,
) => {
  const connections = readDB();
  const normalizedAlias = alias.trim();
  if (connections.some(c => c.alias === normalizedAlias)) {
    throw new Error(`Connection with alias "${normalizedAlias}" already exists.`);
  }

  const normalizedUser = user.trim();
  const normalizedHost = host.trim();
  const normalizedKeyPath = expandHomePath(normalizeOptionalString(key_path));
  const normalizedPort = normalizeOptionalString(port);
  const normalizedRemotePath = normalizeOptionalString(remote_path);

  const newConnection: Connection = {
    id: connections.length > 0 ? Math.max(...connections.map(c => c.id)) + 1 : 1,
    alias: normalizedAlias,
    user: normalizedUser,
    host: normalizedHost,
    key_path: normalizedKeyPath,
    port: normalizedPort,
    remote_path: normalizedRemotePath,
    readonly: isReadonly === true ? true : undefined,
  };
  connections.push(newConnection);
  writeDB(connections);
  return newConnection;
};

export const getConnections = () => {
  return readDB();
};

export const getConnectionByAlias = (alias: string) => {
  const connections = readDB();
  return connections.find(c => c.alias === alias);
};

export const removeConnection = (alias: string) => {
  const connections = readDB();
  const target = connections.find(c => c.alias === alias);
  if (target?.link) {
    throw new LinkedConnectionError(alias, 'removal');
  }
  const newConnections = connections.filter(c => c.alias !== alias);
  if (newConnections.length === connections.length) {
    return false;
  }
  writeDB(newConnections);
  return true;
};

export const updateConnection = (
  alias: string,
  newUser: string,
  newHost: string,
  newKeyPath?: string,
  newPort?: string,
  newRemotePath?: string,
  newAlias?: string,
  newReadonly?: boolean,
) => {
  const connections = readDB();
  const connection = connections.find(c => c.alias === alias);
  if (!connection) {
    return false;
  }

  const normalizedAlias = (newAlias ?? alias).trim();
  if (!normalizedAlias) {
    throw new Error('Alias cannot be empty.');
  }
  if (normalizedAlias !== alias && connections.some(c => c.alias === normalizedAlias)) {
    throw new Error(`Connection with alias "${normalizedAlias}" already exists.`);
  }

  const nextKeyPath = expandHomePath(normalizeOptionalString(newKeyPath));
  const nextPort = normalizeOptionalString(newPort);
  if (connection.link) {
    if (
      normalizedAlias !== connection.alias ||
      newUser.trim() !== connection.user ||
      newHost.trim() !== connection.host ||
      nextPort !== connection.port
    ) {
      throw new LinkedConnectionError(connection.alias, 'changes to alias, user, host, or port');
    }
    if (nextKeyPath !== connection.key_path) {
      // An explicit local key wins over the synced one; clearing it hands the
      // key back to the next sync.
      connection.link = { ...connection.link, localKey: nextKeyPath ? true : undefined };
      if (!connection.link.localKey) {
        delete connection.link.localKey;
      }
    }
  }

  connection.alias = normalizedAlias;
  connection.user = newUser.trim();
  connection.host = newHost.trim();
  connection.key_path = nextKeyPath;
  connection.port = nextPort;
  connection.remote_path = normalizeOptionalString(newRemotePath);
  if (newReadonly !== undefined) {
    connection.readonly = newReadonly === true ? true : undefined;
  }
  writeDB(connections);
  return true;
};

/**
 * Add a connection, or replace an existing alias when `overwrite` is true.
 * Idempotent so agents can declare desired state repeatedly.
 */
export const upsertConnection = (
  data: {
    alias: string;
    user: string;
    host: string;
    key_path?: string;
    port?: string;
    remote_path?: string;
    readonly?: boolean;
  },
  overwrite: boolean = false,
) => {
  const existing = getConnectionByAlias(data.alias);
  if (existing) {
    if (!overwrite) {
      throw new Error(`Connection with alias "${data.alias}" already exists. Use overwrite/--force to replace it.`);
    }
    updateConnection(data.alias, data.user, data.host, data.key_path, data.port, data.remote_path, undefined, data.readonly);
    return getConnectionByAlias(data.alias)!;
  }
  return addConnection(data.alias, data.user, data.host, data.key_path, data.port, data.remote_path, data.readonly);
};

/**
* Replace the whole store. Used by link sync, which computes the next state
 * from the current one plus the remote list in a single pass.
 */
export const replaceConnections = (connections: Connection[]) => {
  writeDB(connections.map(normalizeConnection));
};

/**
 * Record usage for several aliases with a single read/write of the store.
 * `run_on_many` updates up to 50 hosts per call; one write per call keeps the
 * long-lived MCP server from rewriting the whole file once per host.
 */
export const recordConnectionsUsage = (aliases: Iterable<string>) => {
  const wanted = new Set(aliases);
  if (wanted.size === 0) {
    return;
  }

  const connections = readDB();
  const now = Date.now();
  let changed = false;

  for (const connection of connections) {
    if (wanted.has(connection.alias)) {
      connection.lastUsed = now;
      changed = true;
    }
  }

  if (changed) {
    writeDB(connections);
  }
};

export const recordConnectionUsage = (alias: string) => {
  recordConnectionsUsage([alias]);
};
