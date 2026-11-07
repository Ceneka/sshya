import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

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
}

export const connectionSchema = z.object({
  alias: z.string().min(1),
  user: z.string().min(1),
  host: z.string().min(1),
  key_path: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
  remote_path: z.string().optional(),
});

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

  if (!fs.existsSync(dbFilePath)) {
    connectionCache = [];
    cachePath = dbFilePath;
    cacheMtimeMs = -1;
    cacheSize = -1;
    return connectionCache;
  }

  const stat = fs.statSync(dbFilePath);
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
  fs.writeFileSync(getDbPath(), JSON.stringify(data, null, 2));

  // Invalidate cache when data is written
  connectionCache = null;
  cachePath = null;
  cacheMtimeMs = -1;
  cacheSize = -1;
};

export const initDB = () => {
  const dbDir = getDbDir();
  // Create base directory if it doesn't exist
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize empty database file if it does not exist
  if (!fs.existsSync(getDbPath())) {
    writeDB([]);
    return;
  }

  // Normalize any existing data on disk once during init
  const existingData = readDB();
  writeDB(existingData);
};

export const addConnection = (
  alias: string,
  user: string,
  host: string,
  key_path?: string,
  port?: string,
  remote_path?: string,
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

  connection.alias = normalizedAlias;
  connection.user = newUser.trim();
  connection.host = newHost.trim();
  connection.key_path = expandHomePath(normalizeOptionalString(newKeyPath));
  connection.port = normalizeOptionalString(newPort);
  connection.remote_path = normalizeOptionalString(newRemotePath);
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
  },
  overwrite: boolean = false,
) => {
  const existing = getConnectionByAlias(data.alias);
  if (existing) {
    if (!overwrite) {
      throw new Error(`Connection with alias "${data.alias}" already exists. Use overwrite/--force to replace it.`);
    }
    updateConnection(data.alias, data.user, data.host, data.key_path, data.port, data.remote_path);
    return getConnectionByAlias(data.alias)!;
  }
  return addConnection(data.alias, data.user, data.host, data.key_path, data.port, data.remote_path);
};

export const recordConnectionUsage = (alias: string) => {
  const connections = readDB();
  const connection = connections.find(c => c.alias === alias);
  if (connection) {
    connection.lastUsed = Date.now();
    writeDB(connections);
  }
};
