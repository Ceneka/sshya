import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'path';
import pkg from '../../package.json' with { type: 'json' };
import {
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
import { findAliasSuggestions } from '../helpers/selectAlias';
import { executeCopy } from '../connection/copy';
import { executeSshCommand, type RunResult } from '../connection/run';
import { testConnection } from '../connection/test';
import { loadConnectionSchema } from '../schema';
import { registerFileTools, buildAtomicWriteCommand } from './fileTools';
import { resolveMcpPolicy, type McpPolicy, type McpPolicyOptions } from './policy';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * MCP responses are minified: the model pays for whitespace too. Compact
 * payloads are built before they reach this helper.
 */
const ok = (data: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) ?? 'null' }],
  ...(isError ? { isError: true } : {}),
});

const failResult = (message: string, errorKind: string): ToolResult =>
  ok({ ok: false, errorKind, error: message }, true);

const aliasDenial = (policy: McpPolicy, alias: string): ToolResult =>
  failResult(
    `Alias "${alias}" is not allowed by this MCP server. Allowed aliases: ${policy.allowedAliasesLabel()}.`,
    'alias_not_allowed',
  );

const readonlyConnectionDenial = (alias: string, action: string): ToolResult =>
  failResult(
    `Connection "${alias}" is marked readonly; ${action} are refused by this MCP server.`,
    'connection_readonly',
  );

const READ_ONLY_NOTE = [
  'Read-only mode removes store-mutating tools, refuses write_remote_file, and restricts copy_file to downloads.',
  'run_command and run_on_many remain because they are arbitrary remote execution, and copy_file downloads still write local files at the caller-chosen path.',
  'It therefore guards the sshya store against MCP mutations and the remote host against uploads; it does not sandbox the remote host or the local filesystem.',
].join(' ');

/** Agent defaults: one call must not cost more context than the whole tool list. */
const MCP_DEFAULT_STDOUT_BYTES = 8 * 1024;
const MCP_DEFAULT_STDERR_BYTES = 4 * 1024;

/** Fuzzy candidates are hints only: never execute against a suggestion. */
const aliasSuggestions = async (policy: McpPolicy, alias: string): Promise<string[]> =>
  (await findAliasSuggestions(alias, 25))
    .filter(candidate => policy.isAliasAllowed(candidate))
    .slice(0, 3);

const aliasNotFound = async (policy: McpPolicy, alias: string): Promise<ToolResult> => {
  const suggestions = await aliasSuggestions(policy, alias);
  return ok({
    ok: false,
    errorKind: 'alias_not_found',
    error: `Alias not found: ${alias}`,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  }, true);
};

/** Fields accepted by the compact run/test/copy serializer. */
type RunLike = {
  alias?: string;
  ok?: boolean;
  exitCode?: number | null;
  error?: string;
  errorKind?: string;
  hint?: string;
  suggestions?: string[];
  stdout?: string;
  stderr?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutLines?: number;
  stderrLines?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  timeoutMs?: number | null;
  signal?: NodeJS.Signals | null;
  reused?: boolean;
  truncation?: string;
};

/**
 * Drop echoed input, empty streams, zero counters, and false flags. Failure
 * diagnostics (`errorKind`, `hint`, stderr) are always kept.
 */
export const compactRunResult = (result: RunLike): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (result.alias !== undefined) out.alias = result.alias;
  out.ok = result.ok === true;
  if (result.exitCode !== undefined) out.exitCode = result.exitCode;
  if (result.error !== undefined) out.error = result.error;
  if (result.errorKind !== undefined) out.errorKind = result.errorKind;
  if (result.hint !== undefined) out.hint = result.hint;
  if (result.suggestions !== undefined && result.suggestions.length > 0) out.suggestions = result.suggestions;

  if (typeof result.stdout === 'string' && result.stdout.length > 0) out.stdout = result.stdout;
  if (typeof result.stderr === 'string' && result.stderr.length > 0) out.stderr = result.stderr;

  if (result.timedOut === true) {
    out.timedOut = true;
    if (result.timeoutMs !== undefined && result.timeoutMs !== null) out.timeoutMs = result.timeoutMs;
  }
  if (result.signal !== undefined && result.signal !== null) out.signal = result.signal;
  if (typeof result.durationMs === 'number' && (result.durationMs > 5000 || result.timedOut === true)) {
    out.durationMs = result.durationMs;
  }

  // Counters are only meaningful when the stream was cut; otherwise they
  // duplicate information the model can get from stdout/stderr itself.
  if (result.stdoutTruncated === true) {
    out.stdoutTruncated = true;
    if (typeof result.stdoutBytes === 'number' && result.stdoutBytes > 0) out.stdoutBytes = result.stdoutBytes;
    if (typeof result.stdoutLines === 'number' && result.stdoutLines > 0) out.stdoutLines = result.stdoutLines;
  }
  if (result.stderrTruncated === true) {
    out.stderrTruncated = true;
    if (typeof result.stderrBytes === 'number' && result.stderrBytes > 0) out.stderrBytes = result.stderrBytes;
    if (typeof result.stderrLines === 'number' && result.stderrLines > 0) out.stderrLines = result.stderrLines;
  }

  if (result.truncation !== undefined) out.truncation = result.truncation;
  if (result.reused === true) out.reused = true;
  return out;
};

const compactRun = (result: RunResult, verbose: boolean): Record<string, unknown> =>
  verbose ? (result as unknown as Record<string, unknown>) : compactRunResult(result);

const sortByLastUsed = (a: Connection, b: Connection): number =>
  (b.lastUsed ?? 0) - (a.lastUsed ?? 0);

/** List/resource shape: identity plus only the fields an agent acts on. */
const serializeConnectionSummary = (connection: Connection): Record<string, unknown> => ({
  alias: connection.alias,
  target: `${connection.user}@${connection.host}${connection.port ? `:${connection.port}` : ''}`,
  ...(connection.key_path ? { keyPath: connection.key_path } : {}),
  ...(connection.remote_path ? { remotePath: connection.remote_path } : {}),
  ...(connection.readonly === true ? { readonly: true } : {}),
});

const serializeConnection = (connection: Connection) => {
  const sshArgs = buildSshArgs(connection);
  return {
    ...connection,
    sshArgs,
    sshCommand: formatShellCommand('ssh', sshArgs),
    interactiveSshCommand: formatShellCommand('ssh', buildInteractiveSshArgs(connection)),
  };
};

const listAllowedConnections = (policy: McpPolicy): Connection[] =>
  getConnections()
    .filter(connection => policy.isAliasAllowed(connection.alias))
    .sort(sortByLastUsed);

const registerTools = async (server: McpServer, policy: McpPolicy): Promise<void> => {
  // Zod is evaluated only for the MCP server (and lazily on first use here),
  // never for the ordinary CLI commands.
  const { z } = await import('zod');
  server.registerTool(
    'list_connections',
    {
      description: 'List stored connections.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(listAllowedConnections(policy).map(serializeConnectionSummary)),
  );

  server.registerTool(
    'get_connection',
    {
      description: 'Get one connection and its ssh commands.',
      inputSchema: { alias: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ alias }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return await aliasNotFound(policy, alias);
      }
      return ok(serializeConnection(connection));
    },
  );

  if (!policy.readOnly) {
    server.registerTool(
      'add_connection',
      {
        description: 'Add a connection; overwrite replaces.',
        inputSchema: {
          alias: z.string().min(1),
          user: z.string().min(1),
          host: z.string().min(1),
          port: z.union([z.string(), z.number()]).optional(),
          keyPath: z.string().optional(),
          remotePath: z.string().optional(),
          readonly: z.boolean().optional(),
          overwrite: z.boolean().optional(),
        },
      },
      async ({ alias, user, host, port, keyPath, remotePath, readonly, overwrite }) => {
        if (!policy.isAliasAllowed(alias)) {
          return aliasDenial(policy, alias);
        }

        const connectionSchema = await loadConnectionSchema();
        const parsed = connectionSchema.safeParse({
          alias,
          user,
          host,
          port,
          key_path: keyPath,
          remote_path: remotePath,
          readonly,
        });
        if (!parsed.success) {
          return failResult(parsed.error.issues.map(issue => issue.message).join(', '), 'invalid_arguments');
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
            readonly: parsed.data.readonly,
          }, overwrite === true);
          return ok({ ok: true, created: !existed, connection: serializeConnection(connection) });
        } catch (err) {
          return failResult(err instanceof Error ? err.message : String(err), 'store_error');
        }
      },
    );

    server.registerTool(
      'update_connection',
      {
        description: 'Update connection fields.',
        inputSchema: {
          alias: z.string().min(1),
          user: z.string().optional(),
          host: z.string().optional(),
          port: z.union([z.string(), z.number()]).optional(),
          keyPath: z.string().optional(),
          remotePath: z.string().optional(),
          readonly: z.boolean().optional(),
          newAlias: z.string().optional(),
        },
      },
      async ({ alias, user, host, port, keyPath, remotePath, readonly, newAlias }) => {
        if (!policy.isAliasAllowed(alias)) {
          return aliasDenial(policy, alias);
        }
        if (newAlias !== undefined && !policy.isAliasAllowed(newAlias)) {
          return aliasDenial(policy, newAlias);
        }

        const existing = getConnectionByAlias(alias);
        if (!existing) {
          return await aliasNotFound(policy, alias);
        }

        const merged = {
          alias: newAlias ?? existing.alias,
          user: user ?? existing.user,
          host: host ?? existing.host,
          port: port !== undefined ? port : existing.port,
          key_path: keyPath !== undefined ? keyPath : existing.key_path,
          remote_path: remotePath !== undefined ? remotePath : existing.remote_path,
          readonly: readonly !== undefined ? readonly : existing.readonly,
        };

        const connectionSchema = await loadConnectionSchema();
        const parsed = connectionSchema.safeParse(merged);
        if (!parsed.success) {
          return failResult(parsed.error.issues.map(issue => issue.message).join(', '), 'invalid_arguments');
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
            parsed.data.readonly,
          );
          const connection = getConnectionByAlias(parsed.data.alias);
          return ok({ ok: true, connection: connection ? serializeConnection(connection) : undefined });
        } catch (err) {
          return failResult(err instanceof Error ? err.message : String(err), 'store_error');
        }
      },
    );

    server.registerTool(
      'remove_connection',
      {
        description: 'Delete a connection.',
        inputSchema: { alias: z.string().min(1) },
        annotations: { destructiveHint: true },
      },
      async ({ alias }) => {
        if (!policy.isAliasAllowed(alias)) {
          return aliasDenial(policy, alias);
        }
        const existing = getConnectionByAlias(alias);
        if (!existing) {
          return await aliasNotFound(policy, alias);
        }
        removeConnection(alias);
        return ok({ ok: true, removed: existing });
      },
    );
  }

  server.registerTool(
    'test_connection',
    {
      description: 'Check SSH connectivity.',
      inputSchema: {
        alias: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
        reuse: z.boolean().optional(),
        acceptNewHostKey: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, timeoutMs, reuse, acceptNewHostKey }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return await aliasNotFound(policy, alias);
      }
      const result = await testConnection(connection, {
        timeoutMs: timeoutMs ?? 5000,
        reuse: reuse !== false,
        hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
      });
      return ok(compactRunResult(result), !result.ok);
    },
  );

  server.registerTool(
    'run_command',
    {
      description: 'Run a non-interactive SSH command.',
      inputSchema: {
        alias: z.string().min(1),
        command: z.string().min(1),
        cwd: z.boolean().optional(),
        tty: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024).optional().describe('stdout cap (default 8192)'),
        truncate: z.enum(['head', 'tail', 'headtail']).optional().describe('Which part survives (default headtail)'),
        tail: z.boolean().optional().describe('Deprecated: truncate="tail"'),
        reuse: z.boolean().optional(),
        acceptNewHostKey: z.boolean().optional(),
        stdin: z.string().max(2 * 1024 * 1024).optional().describe('Remote stdin data'),
        verbose: z.boolean().optional().describe('Full result shape'),
      },
    },
    async ({ alias, command, cwd, tty, timeoutMs, maxOutputBytes, truncate, tail, reuse, acceptNewHostKey, stdin, verbose }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }

      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return await aliasNotFound(policy, alias);
      }

      recordConnectionUsage(alias);
      const stdoutMaxBytes = maxOutputBytes ?? MCP_DEFAULT_STDOUT_BYTES;
      const result = await executeSshCommand(connection, command, {
        batchMode: true,
        tty: tty === true,
        cwd: cwd !== false,
        timeoutMs: timeoutMs ?? 120000,
        maxOutputBytes: stdoutMaxBytes,
        stderrMaxOutputBytes: Math.min(stdoutMaxBytes, MCP_DEFAULT_STDERR_BYTES),
        outputMode: truncate ?? (tail === true ? 'tail' : 'headtail'),
        reuse: reuse !== false,
        hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
        stdin,
      });

      return ok(compactRun(result, verbose === true), !result.ok);
    },
  );

  server.registerTool(
    'run_on_many',
    {
      description: 'Run a command on several hosts.',
      inputSchema: {
        aliases: z.array(z.string().min(1)).min(1).max(50),
        command: z.string().min(1),
        cwd: z.boolean().optional(),
        tty: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        concurrency: z.number().int().min(1).max(16).optional().describe('Parallel hosts'),
        maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024).optional().describe('stdout cap per host (default 8192)'),
        truncate: z.enum(['head', 'tail', 'headtail']).optional().describe('Which part survives (default headtail)'),
        tail: z.boolean().optional().describe('Deprecated: truncate="tail"'),
        reuse: z.boolean().optional(),
        acceptNewHostKey: z.boolean().optional(),
        stdin: z.string().max(2 * 1024 * 1024).optional().describe('Remote stdin data'),
        failFast: z.boolean().optional(),
        only: z.enum(['all', 'failures']).optional().describe('all or failures'),
        match: z.string().min(1).optional().describe('Regex on stdout lines'),
        verbose: z.boolean().optional().describe('Full result shape'),
      },
    },
    async ({
      aliases,
      command,
      cwd,
      tty,
      timeoutMs,
      concurrency,
      maxOutputBytes,
      truncate,
      tail,
      reuse,
      acceptNewHostKey,
      stdin,
      failFast,
      only,
      match,
      verbose,
    }) => {
      const uniqueAliases = [...new Set(aliases)];
      const deniedAlias = uniqueAliases.find(alias => !policy.isAliasAllowed(alias));
      if (deniedAlias !== undefined) {
        return aliasDenial(policy, deniedAlias);
      }

      const stdoutMaxBytes = maxOutputBytes ?? MCP_DEFAULT_STDOUT_BYTES;
      const outputMode = truncate ?? (tail === true ? 'tail' : 'headtail');
      let matcher: RegExp | undefined;
      if (match !== undefined) {
        try {
          matcher = new RegExp(match);
        } catch (error) {
          return failResult(
            `Invalid match regex: ${error instanceof Error ? error.message : String(error)}`,
            'invalid_arguments',
          );
        }
      }

      const results = new Array<RunLike>(uniqueAliases.length);
      let cursor = 0;
      let stop = false;

      const worker = async () => {
        while (!stop && cursor < uniqueAliases.length) {
          const index = cursor;
          cursor += 1;
          const alias = uniqueAliases[index]!;
          const connection = getConnectionByAlias(alias);

          if (!connection) {
            const suggestions = await aliasSuggestions(policy, alias);
            results[index] = {
              ok: false,
              alias,
              errorKind: 'alias_not_found',
              error: `Alias not found: ${alias}`,
              ...(suggestions.length > 0 ? { suggestions } : {}),
            };
            if (failFast) {
              stop = true;
            }
            continue;
          }

          recordConnectionUsage(alias);
          const result = await executeSshCommand(connection, command, {
            batchMode: true,
            tty: tty === true,
            cwd: cwd !== false,
            timeoutMs: timeoutMs ?? 120000,
            maxOutputBytes: stdoutMaxBytes,
            stderrMaxOutputBytes: Math.min(stdoutMaxBytes, MCP_DEFAULT_STDERR_BYTES),
            outputMode,
            reuse: reuse !== false,
            hostKeyChecking: acceptNewHostKey === false ? undefined : 'accept-new',
            stdin,
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
            errorKind: 'skipped',
            error: 'Skipped because failFast stopped the batch',
          };
        }
      }

      const succeeded = results.filter(result => result.ok === true).length;
      const summary = {
        total: uniqueAliases.length,
        succeeded,
        failed: uniqueAliases.length - succeeded,
      };

      const visible: RunLike[] = [];
      for (const result of results) {
        if (only === 'failures' && result.ok === true) {
          continue;
        }
        if (matcher) {
          const stdout = typeof result.stdout === 'string' ? result.stdout : '';
          if (stdout.length === 0) {
            continue;
          }
          const matchingLines = stdout.split('\n').filter(line => matcher!.test(line));
          if (matchingLines.length === 0) {
            continue;
          }
          visible.push({ ...result, stdout: matchingLines.join('\n') });
          continue;
        }
        visible.push(result);
      }

      return ok(
        {
          ok: summary.failed === 0,
          summary,
          results: verbose === true ? visible : visible.map(result => compactRunResult(result)),
        },
        summary.failed > 0,
      );
    },
  );

  if (!policy.readOnly) {
    server.registerTool(
      'write_remote_file',
      {
        description: 'Write a remote file (atomic=true: temp + rename).',
        inputSchema: {
          alias: z.string().min(1),
          path: z.string().min(1),
          content: z.string().max(2 * 1024 * 1024),
          encoding: z.enum(['utf8', 'base64']).optional(),
          append: z.boolean().optional(),
          createParents: z.boolean().optional(),
          mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
          timeoutMs: z.number().int().positive().optional(),
          atomic: z.boolean().optional(),
          acceptNewHostKey: z.boolean().optional(),
        },
      },
      async ({ alias, path: remotePath, content, encoding, append, createParents, mode, atomic, timeoutMs, acceptNewHostKey }) => {
        if (!policy.isAliasAllowed(alias)) {
          return aliasDenial(policy, alias);
        }

        const connection = getConnectionByAlias(alias);
        if (!connection) {
          return await aliasNotFound(policy, alias);
        }
        if (connection.readonly === true) {
          return readonlyConnectionDenial(alias, 'write_remote_file calls');
        }

        let data: Buffer;
        try {
          data = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
        } catch (error) {
          return failResult(
            `Invalid ${encoding ?? 'utf8'} content: ${error instanceof Error ? error.message : String(error)}`,
            'invalid_arguments',
          );
        }

        const quotedPath = quoteRemotePath(remotePath);
        const parent = path.posix.dirname(remotePath);
        const commands: string[] = [];

        if (createParents && parent !== '.' && parent !== '/') {
          commands.push(`mkdir -p -- ${quoteRemotePath(parent)}`);
        }

        if (atomic === true) {
          commands.push(buildAtomicWriteCommand({
            target: remotePath,
            append,
            mode,
            // With append the final size depends on the existing file, so only
            // verify the byte count for a full replacement.
            expectedBytes: append ? undefined : data.byteLength,
          }));
        } else {
          commands.push(`cat ${append ? '>>' : '>'} ${quotedPath}`);
          if (mode) {
            commands.push(`chmod ${mode} -- ${quotedPath}`);
          }
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
            ...(result.ok ? { bytesWritten: data.byteLength } : {}),
            ...(encoding === 'base64' ? { encoding } : {}),
            ...(append === true ? { appended: true } : {}),
            ...(atomic === true ? { atomic: true } : {}),
            ...(result.reused ? { reused: true } : {}),
            ...(result.durationMs > 5000 ? { durationMs: result.durationMs } : {}),
            ...(result.ok
              ? {}
              : {
                exitCode: result.exitCode,
                errorKind: result.errorKind ?? 'unknown',
                hint: result.hint,
                stderr: result.stderr || undefined,
              }),
          },
          !result.ok,
        );
      },
    );
  }

  server.registerTool(
    'copy_file',
    {
      description: policy.readOnly
        ? 'Download with scp; uploads are refused.'
        : 'Copy files with scp.',
      inputSchema: {
        alias: z.string().min(1),
        source: z.string().min(1),
        destination: z.string().min(1),
        direction: z.enum(['upload', 'download']).describe('upload or download'),
        recursive: z.boolean().optional(),
        preserve: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        reuse: z.boolean().optional(),
        acceptNewHostKey: z.boolean().optional(),
      },
    },
    async ({ alias, source, destination, direction, recursive, preserve, timeoutMs, reuse, acceptNewHostKey }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      if (policy.readOnly && direction !== 'download') {
        return failResult(
          'This MCP server is in read-only mode: copy_file only supports direction="download".',
          'read_only',
        );
      }

      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return await aliasNotFound(policy, alias);
      }
      if (connection.readonly === true && direction === 'upload') {
        return readonlyConnectionDenial(alias, 'copy_file uploads');
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

      return ok(compactRunResult(result), !result.ok);
    },
  );

  server.registerTool(
    'print_ssh_command',
    {
      description: 'Print an ssh command line.',
      inputSchema: {
        alias: z.string().min(1),
        interactive: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, interactive }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return await aliasNotFound(policy, alias);
      }
      const args = interactive ? buildInteractiveSshArgs(connection) : buildSshArgs(connection);
      return ok({
        alias: connection.alias,
        args,
        command: formatShellCommand('ssh', args),
      });
    },
  );

  if (!policy.readOnly) {
    server.registerTool(
      'import_connections',
      {
        description: 'Import connections.',
        inputSchema: {
          connections: z.array(z.object({
            alias: z.string().min(1),
            user: z.string().min(1),
            host: z.string().min(1),
            port: z.union([z.string(), z.number()]).optional(),
            keyPath: z.string().optional(),
            remotePath: z.string().optional(),
            readonly: z.boolean().optional(),
          })),
          overwrite: z.boolean().optional(),
        },
      },
      async ({ connections, overwrite }) => {
        const imported: string[] = [];
        const updated: string[] = [];
        const skipped: string[] = [];
        const refused: Array<{ alias: string; error: string; errorKind: 'alias_not_allowed' }> = [];
        const invalid: Array<{ connection: unknown; error: string; errorKind?: string }> = [];

        const connectionSchema = await loadConnectionSchema();
        for (const candidate of connections) {
          const parsed = connectionSchema.safeParse({
            alias: candidate.alias,
            user: candidate.user,
            host: candidate.host,
            port: candidate.port,
            key_path: candidate.keyPath,
            remote_path: candidate.remotePath,
            readonly: candidate.readonly,
          });

          if (!parsed.success) {
            invalid.push({
              connection: candidate,
              error: parsed.error.issues.map(issue => issue.message).join(', '),
              errorKind: 'invalid_arguments',
            });
            continue;
          }

          if (!policy.isAliasAllowed(parsed.data.alias)) {
            const error = `Alias "${parsed.data.alias}" is not allowed by this MCP server. Allowed aliases: ${policy.allowedAliasesLabel()}.`;
            refused.push({ alias: parsed.data.alias, error, errorKind: 'alias_not_allowed' });
            invalid.push({ connection: candidate, error, errorKind: 'alias_not_allowed' });
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
              readonly: parsed.data.readonly,
            }, existed);
            (existed ? updated : imported).push(parsed.data.alias);
          } catch (err) {
            invalid.push({
              connection: candidate,
              error: err instanceof Error ? err.message : String(err),
              errorKind: 'store_error',
            });
          }
        }

        const result = {
          ok: invalid.length === 0,
          imported,
          updated,
          skipped,
          invalid,
          ...(refused.length > 0
            ? { refused, errorKind: 'alias_not_allowed' as const }
            : {}),
        };
        return ok(result, invalid.length > 0);
      },
    );
  }

  await registerFileTools(server, policy);

  server.registerResource(
    'connections',
    'sshya://connections',
    {
      title: 'SSH connections',
      description: 'Stored SSH connections as JSON, filtered to the active policy.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(listAllowedConnections(policy).map(serializeConnectionSummary)),
      }],
    }),
  );

  server.registerResource(
    'guide',
    'sshya://guide',
    {
      title: 'Using sshya from an agent',
      description: 'Conventions and recipes for calling sshya over MCP, including the active policy.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: [
          '# sshya for agents',
          '',
          '## Active policy',
          `- Allowed aliases: ${policy.allowedAliasesLabel()}.`,
          `- Read-only: ${policy.readOnly ? 'yes' : 'no'}.`,
          ...(policy.readOnly ? [`- ${READ_ONLY_NOTE}`] : []),
          ...(policy.hasAliasAllowlist
            ? ['- Tools that target an alias outside this list return `errorKind: "alias_not_allowed"` and do not touch the host.']
            : []),
          '',
          '## Tools',
          policy.readOnly
            ? '- Available: list_connections, get_connection, test_connection, run_command, run_on_many, read_remote_file, grep_remote, stat_remote, copy_file (download only), and print_ssh_command.'
            : '- Available: list_connections, get_connection, add_connection, update_connection, remove_connection, import_connections, test_connection, run_command, run_on_many, read_remote_file, replace_in_remote_file, grep_remote, stat_remote, write_remote_file, copy_file, and print_ssh_command.',
          '',
          '## Mental model',
          '- Each `run_command` is an independent, non-interactive shell. There is no live shell between calls: `cd` and exports do not persist.',
          '- Pass `cwd: true` (the default) to start in the stored `remote_path`, or include `cd /path && ...` in the command.',
          '- Connections are pooled with OpenSSH ControlMaster. The first call pays the handshake; later calls usually attach to a warm session (`reused: true`). Pass `reuse: false` to force a fresh connection.',
          '- `BatchMode=yes`, `-T`, and a connect timeout are always on. Password prompts fail instead of hanging.',
          '',
          '## Responses',
          '- Results are compact by default: echoed input (`command`, `remoteCommand`, `target`, `cwd`), empty streams, zero counters, and false flags are omitted. Pass `verbose: true` to `run_command` or `run_on_many` for the full shape.',
          '- `list_connections` and `sshya://connections` return only `alias`, `target`, and non-empty `keyPath`/`remotePath`/`readonly`, most recently used first. Use `get_connection` or `print_ssh_command` for ssh args and commands.',
          '- `run_on_many` always returns `{total, succeeded, failed}`; use `only: "failures"` or `match` (regex on stdout, matching lines only) to shrink fleet replies.',
          '- `ok` is true only when every host exited 0 and did not time out.',
          '',
          '## Output',
          '- stdout and stderr are capped per stream. Defaults: 8 KiB stdout kept as head+tail (first half + last half) and 4 KiB stderr. Byte/line counters, `*Truncated`, and `truncation` (`head`|`tail`|`headtail`) are reported only when a stream was cut.',
          '- To see more, narrow the command first: `grep`, `sed -n "200,240p"`, or `| tail -n 100`. `truncate` only chooses which part survives; it does not add `tail -n`. Raise `maxOutputBytes` when the extra output is genuinely needed.',
          '',
          '## Failure handling',
          '- `errorKind` is stable: `host-key`, `host-key-changed`, `dns`, `refused`, `timeout`, `auth`, `key`, `network`, `remote-permission`, `remote-command`, `shell`, `tty`, `sudo_password`, `invalid-path`, `unknown`, `ssh-missing`, `not_found`, `is_a_directory`, `permission_denied`, `binary_file`, `file_too_large`, `match_count`, `conflict`, `grep_failed`, `invalid_pattern`, plus `alias_not_found`, `invalid_arguments`, `skipped`, `store_error`, `alias_not_allowed`, `read_only`, and `connection_readonly`.',
          '- An unknown alias returns `errorKind: "alias_not_found"` with up to three `suggestions`; fix the alias and retry, never execute against a suggestion automatically.',
          '- Read `hint` before retrying. Common fixes: `acceptNewHostKey: true` for first contact, a corrected `keyPath`, a different port, or `tty: true` when sudo needs a terminal. Prefer passwordless `sudo -n` for agents.',
          '- `test_connection` is a cheap `true` probe. `run_on_many` checks a fleet in one call.',
          '',
          '## Files',
          '- `read_remote_file` returns a numbered line range (`offset`/`limit`, byte-capped) plus `totalLines`; prefer it over `cat` for large files.',
          '- `replace_in_remote_file` replaces an exact string, verifies `expectedCount`, and writes atomically. It refuses files over 2 MiB and returns `errorKind: "match_count"` or `"conflict"` instead of guessing.',
          '- `grep_remote` returns `file:line:text` matches; `stat_remote` returns size/mode/mtime/type. Both avoid parsing `ls -l` in the model.',
          '- `copy_file` uses scp for uploads/downloads.',
          '- `write_remote_file` pipes bytes through SSH; pass `atomic: true` to write a temp file and rename it into place.',
          '- A connection with `readonly: true` refuses replace_in_remote_file, write_remote_file, and copy_file uploads. The flag does not restrict run_command.',
          '',
          '## Safety',
          '- Unknown host keys are trusted once (TOFU) by default in MCP. Pass `acceptNewHostKey: false` when that is not acceptable.',
          '- Read-only mode guards the sshya store against MCP mutations and the remote host against uploads. It does not sandbox anything: run_command and run_on_many can still change anything the SSH user can, and copy_file downloads still write local files at the chosen path.',
          '- Connection details are stored locally in `~/.sshya/sshm.json`; set `SSHYA_DB` to isolate an agent workspace.',
        ].join('\n'),
      }],
    }),
  );
};

export type McpServerOptions = McpPolicyOptions;

export const createMcpServer = async (options: McpServerOptions = {}): Promise<McpServer> => {
  // Load the MCP SDK lazily so commands other than `sshya mcp` never evaluate
  // its (large) module graph.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const policy = resolveMcpPolicy(options);
  const server = new McpServer(
    {
      name: 'sshya',
      version: pkg.version,
    },
    {
      instructions: [
        'SSH connection manager: call list_connections, then run_command or run_on_many.',
        'Read the sshya://guide resource before the first command for output caps, pooling, truncation advice, and error handling.',
        policy.inlineSummary(),
        ...(policy.readOnly ? [READ_ONLY_NOTE] : []),
        ...(policy.hasAliasAllowlist
          ? ['Aliases outside the allowlist are refused with errorKind "alias_not_allowed"; listings are filtered.']
          : []),
      ].join(' '),
    },
  );

  await registerTools(server, policy);
  return server;
};

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  initDB();
  const server = await createMcpServer(options);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.SSHYA_MCP_DEBUG === '1') {
    console.error(`sshya MCP server ${pkg.version} listening on stdio`);
  }
}
