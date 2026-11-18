import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
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
import { buildInteractiveSshArgs, buildSshArgs, formatShellCommand, quoteRemotePath } from '../helpers/ssh';
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
      description: 'Open a batched, non-interactive SSH session and run `true`. Fails fast instead of prompting for a password. By default it trusts an unknown host key once (TOFU); pass acceptNewHostKey=false to keep strict host key checking.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        timeoutMs: z.number().int().positive().optional().describe('Overall timeout in milliseconds (default 5000)'),
        reuse: z.boolean().optional().describe('Reuse a pooled connection when available (default true)'),
        acceptNewHostKey: z.boolean().optional().describe('Trust a previously unknown host key on first contact (default true)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, timeoutMs, reuse, acceptNewHostKey }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }
      const result = await testConnection(connection, {
        timeoutMs: timeoutMs ?? 5000,
        reuse: reuse !== false,
        hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
      });
      return ok(result, !result.ok);
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run a command over SSH',
      description: [
        'Run a one-shot, non-interactive command on a stored connection and return stdout, stderr, and the exit code.',
        'The command is interpreted by the remote login shell, so pipes, redirection, and && work; there is no persistent shell between calls.',
        'Commands run from remotePath unless cwd=false. Each call is stateless: pass an explicit cd or use cwd.',
        'Connections are pooled, so the first call pays the handshake and later calls are fast; pass reuse=false to force a fresh one.',
        'Output is capped (default 64 KiB per stream) and truncation is reported; use maxOutputBytes or tail for large logs.',
        'On failure, errorKind and hint explain the likely fix. Unknown host keys are trusted once by default; set acceptNewHostKey=false for strict checking.',
      ].join(' '),
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        command: z.string().min(1).describe('Command to run on the remote host (interpreted by the remote shell)'),
        cwd: z.boolean().optional().describe('cd into the connection remotePath first (default true)'),
        tty: z.boolean().optional().describe('Allocate a remote TTY (default false)'),
        timeoutMs: z.number().int().positive().optional().describe('Abort after this many milliseconds (default 120000)'),
        maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024).optional().describe('Cap captured bytes per stream (default 65536)'),
        tail: z.boolean().optional().describe('When truncated, keep the end instead of the start of the stream'),
        reuse: z.boolean().optional().describe('Reuse a pooled connection when available (default true)'),
        acceptNewHostKey: z.boolean().optional().describe('Trust a previously unknown host key on first contact (default true)'),
        stdin: z.string().max(2 * 1024 * 1024).optional().describe('Data to pipe into the remote command'),
      },
    },
    async ({ alias, command, cwd, tty, timeoutMs, maxOutputBytes, tail, reuse, acceptNewHostKey, stdin }) => {
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
        maxOutputBytes,
        outputMode: tail ? 'tail' : 'head',
        reuse: reuse !== false,
        hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
        stdin,
      });

      return ok(result, !result.ok);
    },
  );

  server.registerTool(
    'run_on_many',
    {
      title: 'Run a command on several connections',
      description: [
        'Fan out one non-interactive command to several stored connections in a single call (max 50 aliases, default concurrency 4).',
        'Results keep the input order and include stdout, stderr, exit code, truncation flags, errorKind, and hint.',
        'Use this for fleet checks instead of one run_command call per host.',
      ].join(' '),
      inputSchema: {
        aliases: z.array(z.string().min(1)).min(1).max(50).describe('Aliases to target'),
        command: z.string().min(1).describe('Command to run on every host'),
        cwd: z.boolean().optional().describe('cd into each connection remotePath first (default true)'),
        timeoutMs: z.number().int().positive().optional().describe('Per-host timeout in milliseconds (default 120000)'),
        concurrency: z.number().int().min(1).max(16).optional().describe('Parallel hosts (default 4)'),
        maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024).optional().describe('Cap captured bytes per stream per host'),
        tail: z.boolean().optional().describe('Keep the end of truncated output'),
        acceptNewHostKey: z.boolean().optional().describe('Trust unknown host keys on first contact (default true)'),
        failFast: z.boolean().optional().describe('Stop scheduling new hosts after the first failure'),
      },
    },
    async ({ aliases, command, cwd, timeoutMs, concurrency, maxOutputBytes, tail, acceptNewHostKey, failFast }) => {
      const uniqueAliases = [...new Set(aliases)];
      const results = new Array<unknown>(uniqueAliases.length);
      let cursor = 0;
      let stop = false;

      const worker = async () => {
        while (!stop && cursor < uniqueAliases.length) {
          const index = cursor;
          cursor += 1;
          const alias = uniqueAliases[index]!;
          const connection = getConnectionByAlias(alias);

          if (!connection) {
            results[index] = { ok: false, alias, error: `Alias not found: ${alias}` };
            if (failFast) {
              stop = true;
            }
            continue;
          }

          recordConnectionUsage(alias);
          const result = await executeSshCommand(connection, command, {
            batchMode: true,
            cwd: cwd !== false,
            timeoutMs: timeoutMs ?? 120000,
            maxOutputBytes,
            outputMode: tail ? 'tail' : 'head',
            reuse: true,
            hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
          });
          results[index] = result;
          if (!result.ok && failFast) {
            stop = true;
          }
        }
      };

      const workers = Math.min(concurrency ?? 4, uniqueAliases.length);
      await Promise.all(Array.from({ length: workers }, worker));

      // Workers always fill every slot unless failFast stopped them.
      for (let index = 0; index < results.length; index += 1) {
        if (results[index] === undefined) {
          results[index] = {
            ok: false,
            alias: uniqueAliases[index],
            error: 'Skipped because failFast stopped the batch',
          };
        }
      }

      const settled = results as Array<{ ok: boolean }>;
      const succeeded = settled.filter(result => result.ok).length;
      const summary = {
        total: uniqueAliases.length,
        succeeded,
        failed: uniqueAliases.length - succeeded,
      };

      return ok(
        { ok: summary.failed === 0, summary, results },
        summary.failed > 0,
      );
    },
  );

  server.registerTool(
    'write_remote_file',
    {
      title: 'Write a remote file',
      description: [
        'Write a file on a stored connection by piping bytes through SSH (no scp temp file).',
        'Content is UTF-8 by default; set encoding=base64 for binary data. Paths are relative to remotePath unless absolute.',
        'Pass append=true to append, createParents=true to mkdir -p first, and mode to chmod afterwards.',
        'The write is not atomic: a failed transfer can leave a partial file. Use run_command with a temporary path when that matters.',
      ].join(' '),
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        path: z.string().min(1).describe('Remote path (absolute, or relative to remotePath)'),
        content: z.string().max(2 * 1024 * 1024).describe('File contents (UTF-8 text, or base64 when encoding=base64)'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('How to decode content (default utf8)'),
        append: z.boolean().optional().describe('Append instead of truncating (default false)'),
        createParents: z.boolean().optional().describe('Run mkdir -p on the parent directory first'),
        mode: z.string().regex(/^[0-7]{3,4}$/).optional().describe('chmod mode such as 600 or 0644'),
        timeoutMs: z.number().int().positive().optional().describe('Abort after this many milliseconds (default 120000)'),
        acceptNewHostKey: z.boolean().optional().describe('Trust an unknown host key on first contact (default true)'),
      },
    },
    async ({ alias, path: remotePath, content, encoding, append, createParents, mode, timeoutMs, acceptNewHostKey }) => {
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }

      let data: Buffer;
      try {
        data = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
      } catch (error) {
        return failResult(`Invalid ${encoding ?? 'utf8'} content: ${error instanceof Error ? error.message : String(error)}`);
      }

      const quotedPath = quoteRemotePath(remotePath);
      const parent = path.posix.dirname(remotePath);
      const commands: string[] = [];

      if (createParents && parent !== '.' && parent !== '/') {
        commands.push(`mkdir -p -- ${quoteRemotePath(parent)}`);
      }

      commands.push(`cat ${append ? '>>' : '>'} ${quotedPath}`);
      if (mode) {
        commands.push(`chmod ${mode} -- ${quotedPath}`);
      }

      recordConnectionUsage(alias);
      const result = await executeSshCommand(connection, commands.join(' && '), {
        batchMode: true,
        cwd: true,
        timeoutMs: timeoutMs ?? 120000,
        reuse: true,
        hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
        stdin: data,
        maxOutputBytes: 16 * 1024,
      });

      return ok(
        {
          ok: result.ok,
          alias,
          path: remotePath,
          bytesWritten: result.ok ? data.byteLength : 0,
          encoding: encoding ?? 'utf8',
          appended: append === true,
          reused: result.reused,
          durationMs: result.durationMs,
          ...(result.ok ? {} : { errorKind: result.errorKind, hint: result.hint, stderr: result.stderr }),
        },
        !result.ok,
      );
    },
  );

  server.registerTool(
    'copy_file',
    {
      title: 'Copy a file over SCP',
      description: 'Upload or download a file or directory using a stored connection. Unknown host keys are trusted once by default (TOFU); set acceptNewHostKey=false for strict checking. Connections are pooled when possible.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        source: z.string().min(1),
        destination: z.string().min(1),
        direction: z.enum(['upload', 'download']).describe('upload = local to remote, download = remote to local'),
        recursive: z.boolean().optional(),
        preserve: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        reuse: z.boolean().optional().describe('Reuse a pooled connection when available (default true)'),
        acceptNewHostKey: z.boolean().optional().describe('Trust a previously unknown host key on first contact (default true)'),
      },
    },
    async ({ alias, source, destination, direction, recursive, preserve, timeoutMs, reuse, acceptNewHostKey }) => {
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
        reuse: reuse !== false,
        hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
      });

      return ok(result, !result.ok);
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

  server.registerResource(
    'guide',
    'sshya://guide',
    {
      title: 'Using sshya from an agent',
      description: 'Conventions and recipes for calling sshya over MCP.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: [
          '# sshya for agents',
          '',
          '## Mental model',
          '- Each `run_command` is an independent, non-interactive shell. There is no live shell between calls: `cd` and exports do not persist.',
          '- Pass `cwd: true` (the default) to start in the stored `remote_path`, or include `cd /path && ...` in the command.',
          '- Connections are pooled with OpenSSH ControlMaster. The first call pays the handshake; later calls usually attach to a warm session (`reused: true`).',
          '- `BatchMode=yes`, `-T`, and a connect timeout are always on. Password prompts fail instead of hanging.',
          '',
          '## Output',
          '- stdout and stderr are capped (64 KiB per stream by default). Every result reports `stdoutBytes`, `stderrBytes`, and `*Truncated`.',
          '- For logs, either add `| tail -n 100` to the command or pass `tail: true` / `maxOutputBytes`.',
          '- `ok` is true only when the remote exit code is 0 and the command did not time out.',
          '',
          '## Failure handling',
          '- `errorKind` is stable: `host-key`, `host-key-changed`, `dns`, `refused`, `timeout`, `auth`, `key`, `network`, `remote-permission`, `remote-command`, `shell`, `unknown`, `ssh-missing`.',
          '- Read `hint` before retrying. Common fixes: `acceptNewHostKey: true` for first contact, a corrected `keyPath`, a different port, or `tty: true` for sudo.',
          '- `test_connection` is a cheap `true` probe. `run_on_many` checks a fleet in one call.',
          '',
          '## Files',
          '- `copy_file` uses scp for uploads/downloads.',
          '- `write_remote_file` pipes bytes through SSH; it is convenient for configs and small binary payloads but is not atomic.',
          '',
          '## Safety',
          '- Unknown host keys are trusted once (TOFU) by default in MCP. Pass `acceptNewHostKey: false` when that is not acceptable.',
          '- Connection details are stored locally in `~/.sshya/sshm.json`; set `SSHYA_DB` to isolate an agent workspace.',
        ].join('\n'),
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
        'run_command is a one-shot non-interactive shell; state does not persist between calls. Set cwd or include cd in the command.',
        'Connections are pooled, so repeated calls reuse a warm SSH session; pass reuse=false to force a fresh one.',
        'Output is capped and reports truncation; use maxOutputBytes or tail for large logs.',
        'On failure read errorKind and hint before retrying; unknown host keys are trusted once by default (acceptNewHostKey=false disables that).',
        'Use run_on_many for fleet checks, copy_file for transfers, and write_remote_file for small config writes.',
        'Read the sshya://guide resource for conventions and examples.',
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
