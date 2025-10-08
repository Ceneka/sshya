import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const dbDir = path.join(os.homedir(), '.sshya');
const dbFilePath = path.join(dbDir, 'sshm.json');

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

export const expandHomePath = (input?: string): string | undefined => {
  if (!input) {
    return undefined;
  }
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
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

const readDB = (): Connection[] => {
  if (!fs.existsSync(dbFilePath)) {
    return [];
  }
  const data = fs.readFileSync(dbFilePath, 'utf-8');
  const parsed: Connection[] = JSON.parse(data);
  return parsed.map(normalizeConnection);
};

const writeDB = (data: Connection[]) => {
  // Ensure the directory exists before writing
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2));
};

export const initDB = () => {
  // Create base directory if it doesn't exist
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize empty database file if it does not exist
  if (!fs.existsSync(dbFilePath)) {
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
  writeDB(newConnections);
};

export const updateConnection = (
  alias: string,
  newUser: string,
  newHost: string,
  newKeyPath?: string,
  newPort?: string,
  newRemotePath?: string,
) => {
  const connections = readDB();
  const connection = connections.find(c => c.alias === alias);
  if (connection) {
    connection.user = newUser.trim();
    connection.host = newHost.trim();
    connection.key_path = expandHomePath(normalizeOptionalString(newKeyPath));
    connection.port = normalizeOptionalString(newPort);
    connection.remote_path = normalizeOptionalString(newRemotePath);
    writeDB(connections);
  }
};

export const recordConnectionUsage = (alias: string) => {
  const connections = readDB();
  const connection = connections.find(c => c.alias === alias);
  if (connection) {
    connection.lastUsed = Date.now();
    writeDB(connections);
  }
};
