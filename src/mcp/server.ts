import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import {
  connectionSchema,
  getConnectionByAlias,
  getConnections,
  initDB,
  recordConnectionUsage,
  removeConnection,
  updateConnection,
  upsertConnection,
  type Connection,
} from '../database';
import { buildInteractiveSshArgs, buildSshArgs, formatShellCommand } from '../helpers/ssh';
import { executeCopy } from '../connection/copy';
import { executeSshCommand } from '../connection/run';
import { testConnection } from '../connection/test';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (data: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const failResult = (message: string): ToolResult => ok({ ok: false, error: message }, true);

const serializeConnection = (connection: Connection) => {
  const sshArgs = buildSshArgs(connection);
  return {
    ...connection,
    sshArgs,
    sshCommand: formatShellCommand('ssh', sshArgs),
    interactiveSshCommand: formatShellCommand('ssh', buildInteractiveSshArgs(connection)),
  };
};

const registerTools = (server: McpServer): void => {
  server.registerTool(
    'list_connections',
    {
      title: 'List SSH connections',
      description: 'List every stored SSH connection with its alias, target, port, key path, remote path, and ready-to-run ssh command.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(getConnections().map(serializeConnection)),
  );

  server.registerTool(
    'get_connection',
    {
      title: 'Get an SSH connection',
      description: 'Look up one stored SSH connection by exact alias.',
      inputSchema: { alias: z.string().min(1).describe('Exact connection alias') },
      annotations: { readOnlyHint: true },
    },
    async ({ alias }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }
      return ok(serializeConnection(connection));
    },
  );

  server.registerTool(
    'add_connection',
    {
      title: 'Add an SSH connection',
      description: 'Store a new SSH connection. Set overwrite=true to replace an existing alias (idempotent upsert).',
      inputSchema: {
        alias: z.string().min(1).describe('Short name used to reference the connection'),
        user: z.string().min(1).describe('SSH username'),
        host: z.string().min(1).describe('Hostname or IP address'),
        port: z.union([z.string(), z.number()]).optional().describe('SSH port'),
        keyPath: z.string().optional().describe('Path to the private key, e.g. ~/.ssh/id_ed25519'),
        remotePath: z.string().optional().describe('Default remote working directory'),
        overwrite: z.boolean().optional().describe('Replace the connection if the alias already exists'),
      },
    },
    async ({ alias, user, host, port, keyPath, remotePath, overwrite }) => {
      const parsed = connectionSchema.safeParse({
        alias,
        user,
        host,
        port,
        key_path: keyPath,
        remote_path: remotePath,
      });
      if (!parsed.success) {
        return failResult(parsed.error.issues.map(issue => issue.message).join(', '));
      }

      const existed = Boolean(getConnectionByAlias(parsed.data.alias));
      try {
        const connection = upsertConnection({
          alias: parsed.data.alias,
          user: parsed.data.user,
          host: parsed.data.host,
          port: parsed.data.port !== undefined ? String(parsed.data.port) : undefined,
          key_path: parsed.data.key_path,
          remote_path: parsed.data.remote_path,
        }, overwrite === true);
        return ok({ ok: true, created: !existed, connection: serializeConnection(connection) });
      } catch (err) {
        return failResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'update_connection',
    {
      title: 'Update an SSH connection',
      description: 'Update fields on an existing connection. Only supplied fields change; pass an empty string for keyPath or remotePath to clear them.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact alias of the connection to update'),
        user: z.string().optional(),
        host: z.string().optional(),
        port: z.union([z.string(), z.number()]).optional(),
        keyPath: z.string().optional(),
        remotePath: z.string().optional(),
        newAlias: z.string().optional().describe('Rename the connection'),
      },
    },
    async ({ alias, user, host, port, keyPath, remotePath, newAlias }) => {
      const existing = getConnectionByAlias(alias);
      if (!existing) {
        return failResult(`Alias not found: ${alias}`);
      }

      const merged = {
        alias: newAlias ?? existing.alias,
        user: user ?? existing.user,
        host: host ?? existing.host,
        port: port !== undefined ? port : existing.port,
        key_path: keyPath !== undefined ? keyPath : existing.key_path,
        remote_path: remotePath !== undefined ? remotePath : existing.remote_path,
      };

      const parsed = connectionSchema.safeParse(merged);
      if (!parsed.success) {
        return failResult(parsed.error.issues.map(issue => issue.message).join(', '));
      }

      try {
        updateConnection(
          alias,
          parsed.data.user,
          parsed.data.host,
          parsed.data.key_path ?? '',
          parsed.data.port !== undefined ? String(parsed.data.port) : undefined,
          parsed.data.remote_path,
          parsed.data.alias,
        );
        const connection = getConnectionByAlias(parsed.data.alias);
        return ok({ ok: true, connection: connection ? serializeConnection(connection) : undefined });
      } catch (err) {
        return failResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'remove_connection',
    {
      title: 'Remove an SSH connection',
      description: 'Delete one stored connection by exact alias.',
      inputSchema: { alias: z.string().min(1).describe('Exact connection alias') },
      annotations: { destructiveHint: true },
    },
    async ({ alias }) => {
      const existing = getConnectionByAlias(alias);
      if (!existing) {
        return failResult(`Alias not found: ${alias}`);
      }
      removeConnection(alias);
      return ok({ ok: true, removed: existing });
    },
  );

  server.registerTool(
    'test_connection',
    {
      title: 'Test an SSH connection',
      description: 'Open a batched, non-interactive SSH session and run `true`. Fails fast instead of prompting for a password.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        timeoutMs: z.number().int().positive().optional().describe('Overall timeout in milliseconds (default 5000)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, timeoutMs }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }
      const result = await testConnection(connection, { timeoutMs: timeoutMs ?? 5000 });
      return ok(result, !result.ok);
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run a command over SSH',
      description: 'Run a non-interactive command on a stored connection and return stdout, stderr, and the exit code. The command is interpreted by the remote login shell. A TTY is not allocated unless tty=true.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        command: z.string().min(1).describe('Command to run on the remote host'),
        cwd: z.boolean().optional().describe('cd into the connection remotePath first (default true)'),
        tty: z.boolean().optional().describe('Allocate a remote TTY (default false)'),
        timeoutMs: z.number().int().positive().optional().describe('Abort after this many milliseconds (default 120000)'),
      },
    },
    async ({ alias, command, cwd, tty, timeoutMs }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }

      recordConnectionUsage(alias);
      const result = await executeSshCommand(connection, command, {
        batchMode: true,
        tty: tty === true,
        cwd: cwd !== false,
        timeoutMs: timeoutMs ?? 120000,
      });

      return ok(
        { ok: result.exitCode === 0 && !result.timedOut, ...result },
        result.exitCode !== 0 || result.timedOut,
      );
    },
  );

  server.registerTool(
    'copy_file',
    {
      title: 'Copy a file over SCP',
      description: 'Upload or download a file or directory using a stored connection.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        source: z.string().min(1),
        destination: z.string().min(1),
        direction: z.enum(['upload', 'download']).describe('upload = local to remote, download = remote to local'),
        recursive: z.boolean().optional(),
        preserve: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async ({ alias, source, destination, direction, recursive, preserve, timeoutMs }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }

      recordConnectionUsage(alias);
      const result = await executeCopy(connection, source, destination, {
        download: direction === 'download',
        recursive: recursive === true,
        preserve: preserve === true,
        timeoutMs,
      });

      return ok(
        { ok: result.exitCode === 0 && !result.timedOut, ...result },
        result.exitCode !== 0 || result.timedOut,
      );
    },
  );

  server.registerTool(
    'print_ssh_command',
    {
      title: 'Print an SSH command',
      description: 'Return the ssh argv and a copy-pasteable command for a connection. interactive=false (default) is suitable for running remote commands; interactive=true opens the saved shell session.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        interactive: z.boolean().optional().describe('Return the interactive login command instead of the non-interactive one'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, interactive }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }
      const args = interactive ? buildInteractiveSshArgs(connection) : buildSshArgs(connection);
      return ok({
        alias: connection.alias,
        args,
        command: formatShellCommand('ssh', args),
      });
    },
  );

  server.registerTool(
    'import_connections',
    {
      title: 'Import SSH connections',
      description: 'Bulk-store connections from an array. Existing aliases are skipped unless overwrite=true. Useful for provisioning an agent workspace in one call.',
      inputSchema: {
        connections: z.array(z.object({
          alias: z.string().min(1),
          user: z.string().min(1),
          host: z.string().min(1),
          port: z.union([z.string(), z.number()]).optional(),
          keyPath: z.string().optional(),
          remotePath: z.string().optional(),
        })).describe('Connections to import'),
        overwrite: z.boolean().optional().describe('Replace connections whose alias already exists'),
      },
    },
    async ({ connections, overwrite }) => {
      const imported: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];
      const invalid: Array<{ connection: unknown; error: string }> = [];

      for (const candidate of connections) {
        const parsed = connectionSchema.safeParse({
          alias: candidate.alias,
          user: candidate.user,
          host: candidate.host,
          port: candidate.port,
          key_path: candidate.keyPath,
          remote_path: candidate.remotePath,
        });

        if (!parsed.success) {
          invalid.push({
            connection: candidate,
            error: parsed.error.issues.map(issue => issue.message).join(', '),
          });
          continue;
        }

        const existed = Boolean(getConnectionByAlias(parsed.data.alias));
        if (existed && overwrite !== true) {
          skipped.push(parsed.data.alias);
          continue;
        }

        try {
          upsertConnection({
            alias: parsed.data.alias,
            user: parsed.data.user,
            host: parsed.data.host,
            port: parsed.data.port !== undefined ? String(parsed.data.port) : undefined,
            key_path: parsed.data.key_path,
            remote_path: parsed.data.remote_path,
          }, existed);
          (existed ? updated : imported).push(parsed.data.alias);
        } catch (err) {
          invalid.push({
            connection: candidate,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const result = {
        ok: invalid.length === 0,
        imported,
        updated,
        skipped,
        invalid,
      };
      return ok(result, invalid.length > 0);
    },
  );

  server.registerResource(
    'connections',
    'sshya://connections',
    {
      title: 'SSH connections',
      description: 'All stored SSH connections as JSON.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(getConnections().map(serializeConnection), null, 2),
      }],
    }),
  );
};

export const createMcpServer = (): McpServer => {
  const server = new McpServer(
    {
      name: 'sshya',
      version: pkg.version,
    },
    {
      instructions: [
        'Manage and use stored SSH connections.',
        'Call list_connections to discover aliases before running commands.',
        'Use run_command for non-interactive work; use print_ssh_command with interactive=true only when a human needs a shell.',
        'run_command and test_connection use BatchMode=yes, so password prompts fail instead of hanging.',
      ].join(' '),
    },
  );

  registerTools(server);
  return server;
};

export async function runMcpServer(): Promise<void> {
  initDB();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.SSHYA_MCP_DEBUG === '1') {
    console.error(`sshya MCP server ${pkg.version} listening on stdio`);
  }
}
