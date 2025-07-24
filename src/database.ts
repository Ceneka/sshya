import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const dbDir = path.join(os.homedir(), '.sshya');
const dbFilePath = path.join(dbDir, 'sshm.json');

interface Connection {
  id: number;
  alias: string;
  user: string;
  host: string;
  key_path?: string;
  port?: string;
  lastUsed?: number;
}

export const connectionSchema = z.object({
  alias: z.string().min(1),
  user: z.string().min(1),
  host: z.string().min(1),
  key_path: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
});

const readDB = (): Connection[] => {
  if (!fs.existsSync(dbFilePath)) {
    return [];
  }
  const data = fs.readFileSync(dbFilePath, 'utf-8');
  return JSON.parse(data);
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
  }
};

export const addConnection = (alias: string, user: string, host: string, key_path?: string, port?: string) => {
  const connections = readDB();
  if (connections.some(c => c.alias === alias)) {
    throw new Error(`Connection with alias "${alias}" already exists.`);
  }
  const newConnection: Connection = {
    id: connections.length > 0 ? Math.max(...connections.map(c => c.id)) + 1 : 1,
    alias,
    user,
    host,
    key_path,
    port,
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

export const updateConnection = (alias: string, newUser: string, newHost: string, newKeyPath: string, newPort?: string) => {
  const connections = readDB();
  const connection = connections.find(c => c.alias === alias);
  if (connection) {
    connection.user = newUser;
    connection.host = newHost;
    connection.key_path = newKeyPath;
    connection.port = newPort;
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
