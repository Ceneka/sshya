/**
 * Structured remote file tools.
 *
 * `run_command` can read, edit, and grep files, but the caller has to know
 * sed/awk/grep syntax, quote paths, and parse unlabeled output. Worse, editing a
 * config means pulling the whole file into the model's context and emitting it
 * again. These tools keep the round trip small:
 *
 * - `read_remote_file` returns a numbered line range plus the total line count.
 * - `replace_in_remote_file` downloads, replaces an exact string, verifies the
 *   match count and file fingerprint, and writes back atomically.
 * - `grep_remote` returns compact `file:line:text` matches.
 * - `stat_remote` reports size/mode/mtime/type without parsing `ls -l`.
 *
 * Everything runs through `executeSshCommand` (batch mode, pooling, TOFU) and
 * respects the alias allowlist, read-only mode, and per-connection `readonly`.
 * Remote commands target POSIX sh and avoid GNU-only flags; GNU/BSD `stat` is
 * detected at runtime where it is the only practical option.
 */
import { randomUUID } from 'crypto';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeSshCommand, type RunResult } from '../connection/run';
import { getConnectionByAlias, recordConnectionUsage, type Connection } from '../database';
import { quoteRemotePath, quoteShellArg } from '../helpers/shell';
import type { McpPolicy } from './policy';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * File-tool responses are minified like every other MCP response: the model
 * pays for whitespace too.
 */
const ok = (data: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) ?? 'null' }],
  ...(isError ? { isError: true } : {}),
});

const failResult = (message: string, errorKind?: string, hint?: string): ToolResult =>
  ok(
    {
      ok: false,
      error: message,
      ...(errorKind ? { errorKind } : {}),
      ...(hint ? { hint } : {}),
    },
    true,
  );

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

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_READ_MAX_BYTES = 16 * 1024;
const MAX_READ_MAX_BYTES = 1024 * 1024;
const MAX_READ_LINES = 5000;
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
const WRITE_CAPTURE_BYTES = 16 * 1024;

/** Tag every response with a per-call sentinel so file content cannot spoof it. */
const newSentinel = (): string => `__sshya_mcp_${randomUUID().replace(/-/g, '')}__`;

/**
 * Quote a path for a remote command. Relative operands that start with `-` get
 * a `./` prefix so utilities cannot mistake them for options (the remote shell
 * is not guaranteed to support `--`).
 */
const remoteOperand = (value: string): string => {
  const needsDotSlash = !path.posix.isAbsolute(value) && value.startsWith('-');
  return quoteRemotePath(needsDotSlash ? `./${value}` : value);
};

/** Temp file next to the target so the final `mv` is a same-filesystem rename. */
const atomicTempPath = (target: string): string => {
  const dir = path.posix.dirname(target);
  const base = path.posix.basename(target);
  // A JS-generated suffix keeps concurrent edits apart. `$$` cannot do that
  // here: quoteRemotePath single-quotes the name because of `$`, so the remote
  // shell would see a literal "$$" and every call would share one temp path.
  return path.posix.join(dir, `.${base}.sshya-tmp.${randomUUID().replace(/-/g, '').slice(0, 12)}`);
};

const isMode = (value: string | undefined): value is string =>
  value !== undefined && /^[0-7]{1,4}$/.test(value);

const isNumeric = (value: string | undefined): value is string =>
  value !== undefined && /^\d+$/.test(value);

export interface AtomicWriteOptions {
  /** Remote target path (absolute, or relative to the connection remote_path). */
  target: string;
  /** Append the piped bytes to the existing file before the rename. */
  append?: boolean;
  /** Explicit chmod mode; when omitted the target's current mode is reused. */
  mode?: string;
  /** Refuse the rename unless the temp file has exactly this many bytes. */
  expectedBytes?: number;
}

/**
 * Build a shell command that reads stdin into a temp file in the target's
 * directory and renames it over the target. Mode/owner are copied from the
 * existing file where the platform allows it.
 *
 * Used by `write_remote_file` (`atomic: true`) and by
 * `replace_in_remote_file`; both keep the target intact if any step fails.
 */
export const buildAtomicWriteCommand = (options: AtomicWriteOptions): string => {
  const target = remoteOperand(options.target);
  const temp = quoteRemotePath(atomicTempPath(options.target));
  const lines: string[] = [
    '{',
    `__sshya_tmp=${temp}`,
    'rm -f "$__sshya_tmp"',
  ];

  if (options.append) {
    lines.push(
      `if [ -f ${target} ]; then cat < ${target} > "$__sshya_tmp" || { rm -f "$__sshya_tmp"; exit 1; }; fi`,
      'cat >> "$__sshya_tmp" || { rm -f "$__sshya_tmp"; exit 1; }',
    );
  } else {
    lines.push('cat > "$__sshya_tmp" || { rm -f "$__sshya_tmp"; exit 1; }');
  }

  if (options.expectedBytes !== undefined) {
    lines.push(
      `[ "$(wc -c < "$__sshya_tmp")" -eq ${Math.floor(options.expectedBytes)} ] || { rm -f "$__sshya_tmp"; exit 1; }`,
    );
  }

  lines.push(...preserveMetadataLines(target, options.mode));
  lines.push(`mv -f "$__sshya_tmp" ${target} || { rm -f "$__sshya_tmp"; exit 1; }`);
  lines.push('}');
  return lines.join('\n');
};

/**
 * Shell lines that copy the target's mode and owner onto `$__sshya_tmp`.
 * GNU `stat -c` and BSD `stat -f` are both tried; failures are non-fatal
 * because a non-root user cannot always chown.
 */
const preserveMetadataLines = (target: string, modeOverride?: string): string[] => {
  // Mode, uid, and gid live in the same inode: read them in one `stat` (two
  // spawns per write saved, which is measurable because the remote host pays a
  // process per invocation). GNU `stat -c` and BSD `stat -f` are both tried;
  // failures are non-fatal because a non-root user cannot always chown.
  return [
    `__sshya_meta=$(stat -c '%a %u %g' ${target} 2>/dev/null || stat -f '%Lp %u %g' ${target} 2>/dev/null) || __sshya_meta=`,
    '__sshya_rest=${__sshya_meta#* }',
    '__sshya_gid=${__sshya_rest#* }',
    '__sshya_uid=${__sshya_rest%% *}',
    modeOverride !== undefined
      ? `__sshya_mode=${quoteShellArg(modeOverride)}`
      : '__sshya_mode=${__sshya_meta%% *}',
    '[ -n "$__sshya_mode" ] && chmod "$__sshya_mode" "$__sshya_tmp" 2>/dev/null || true',
    '[ -n "$__sshya_uid" ] && [ -n "$__sshya_gid" ] && chown "$__sshya_uid:$__sshya_gid" "$__sshya_tmp" 2>/dev/null || true',
  ];
};

interface RemoteRunOptions {
  stdin?: Buffer;
  maxOutputBytes?: number;
}

const runRemote = (
  connection: Connection,
  command: string,
  options: RemoteRunOptions = {},
): Promise<RunResult> => {
  recordConnectionUsage(connection.alias);
  return executeSshCommand(connection, command, {
    batchMode: true,
    cwd: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes,
    reuse: true,
    // MCP defaults to first-contact trust (TOFU), like the other tools.
    hostKeyChecking: 'accept-new',
    stdin: options.stdin,
  });
};

const resultFailure = (result: RunResult): ToolResult =>
  failResult(
    firstLine(result.stderr) || 'The remote command failed.',
    result.errorKind ?? 'unknown',
    result.hint,
  );

const firstLine = (value: string): string => value.trim().split('\n')[0]?.trim() ?? '';

/** Map a remote-side sentinel kind to a stable errorKind plus an actionable hint. */
const kindFailure = (kind: string, remotePath: string): ToolResult => {
  switch (kind) {
    case 'not_found':
      return failResult(
        `Remote path not found: ${remotePath}`,
        'not_found',
        'Relative paths resolve from the connection remote_path. Check the path with stat_remote or run_command.',
      );
    case 'is_a_directory':
      return failResult(
        `Remote path is a directory, not a file: ${remotePath}`,
        'is_a_directory',
        'Pass a file path; use run_command with ls or find to inspect the directory.',
      );
    case 'permission_denied':
      return failResult(
        `The SSH user cannot read or write ${remotePath}.`,
        'permission_denied',
        'Check ownership/mode with stat_remote, or use run_command with tty=true for sudo.',
      );
    case 'binary_file':
      return failResult(
        `Remote file looks binary (NUL bytes in the first 8 KiB): ${remotePath}`,
        'binary_file',
        'These tools handle UTF-8 text. Use copy_file to download binaries, or run_command with base64.',
      );
    case 'file_too_large':
      return failResult(
        `Remote file is larger than the ${MAX_EDIT_FILE_BYTES} byte edit limit: ${remotePath}`,
        'file_too_large',
        'Edit larger files on the host with run_command (sed/perl), or download and upload with copy_file.',
      );
    default:
      return failResult(
        `Remote file operation failed (${kind || 'unknown'}) for ${remotePath}.`,
        'unknown',
      );
  }
};

/** Build the shared "does the file exist, is it text, can we read it" preamble. */
const fileGuardLines = (variable: string, sentinel: string, binaryKind: string): string[] => [
  `if [ -d "$${variable}" ]; then printf '${sentinel}\\nkind\\nis_a_directory\\n'; exit 0; fi`,
  `if [ ! -e "$${variable}" ]; then printf '${sentinel}\\nkind\\nnot_found\\n'; exit 0; fi`,
  `if [ ! -r "$${variable}" ]; then printf '${sentinel}\\nkind\\npermission_denied\\n'; exit 0; fi`,
  // `od -N` caps the read at the same 8 KiB that `dd bs=1024 count=8 | od`
  // produced, without the extra `dd` process. GNU, BSD, and BusyBox od all
  // accept -N and print the same hex layout.
  `if LC_ALL=C od -An -v -tx1 -N 8192 "$${variable}" 2>/dev/null | grep -Eqi '(^| )00( |$)'; then printf '${sentinel}\\nkind\\n${binaryKind}\\n'; exit 0; fi`,
];

/** Drop an incomplete UTF-8 sequence at the end of a byte slice. */
const trimIncompleteTail = (buffer: Buffer): Buffer => {
  let index = buffer.length - 1;
  let continuations = 0;
  while (index >= 0 && (buffer[index]! & 0xc0) === 0x80 && continuations < 3) {
    index -= 1;
    continuations += 1;
  }
  if (index < 0) {
    return buffer;
  }
  const lead = buffer[index]!;
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return continuations + 1 < expected ? buffer.subarray(0, index) : buffer;
};

/** Cut text to a byte budget, preferring a newline boundary and valid UTF-8. */
const truncateToBytes = (text: string, maxBytes: number): string => {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  const slice = buffer.subarray(0, maxBytes);
  const lastNewline = slice.lastIndexOf(0x0a);
  if (lastNewline >= 0) {
    return slice.subarray(0, lastNewline + 1).toString('utf8');
  }
  return trimIncompleteTail(slice).toString('utf8');
};

const lineNumberAt = (text: string, offset: number): number => {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      line += 1;
    }
  }
  return line;
};

export interface EditDiffOptions {
  context?: number;
  maxLines?: number;
  maxChars?: number;
}

/**
 * Small unified-diff-style snippet: common prefix/suffix trimmed, ±context
 * lines around the changed region, capped by line and character count.
 * Used for both edits and is intentionally not a full Myers diff.
 */
export const buildEditDiff = (
  before: string,
  after: string,
  options: EditDiffOptions = {},
): string => {
  if (before === after) {
    return '';
  }

  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 60;
  const maxChars = options.maxChars ?? 4000;

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let prefix = 0;
  const maxPrefix = Math.min(beforeLines.length, afterLines.length);
  while (prefix < maxPrefix && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  const maxSuffix = Math.min(beforeLines.length, afterLines.length) - prefix;
  while (
    suffix < maxSuffix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const start = Math.max(0, prefix - context);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + context);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + context);

  const lines: string[] = [
    `@@ -${start + 1},${Math.max(0, beforeEnd - start)} +${start + 1},${Math.max(0, afterEnd - start)} @@`,
  ];

  for (let index = start; index < Math.min(prefix, beforeEnd); index += 1) {
    lines.push(` ${beforeLines[index]}`);
  }
  for (let index = prefix; index < beforeLines.length - suffix; index += 1) {
    lines.push(`-${beforeLines[index]}`);
  }
  for (let index = prefix; index < afterLines.length - suffix; index += 1) {
    lines.push(`+${afterLines[index]}`);
  }
  for (let index = beforeLines.length - suffix; index < beforeEnd; index += 1) {
    lines.push(` ${beforeLines[index]}`);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines.push('… [diff capped]');
  }

  const joined = lines.join('\n');
  if (joined.length > maxChars) {
    return `${Array.from(joined).slice(0, maxChars).join('')}\n… [diff capped]`;
  }
  return joined;
};

const parseTaggedOutput = (
  stdout: string,
  sentinel: string,
): { tag?: string; value?: string } => {
  const parts = stdout.split(`${sentinel}\n`);
  const header = parts[1];
  if (header === undefined) {
    return {};
  }
  const [tag, value] = header.split('\n');
  return { tag, value: value?.trim() };
};

export const registerFileTools = (server: McpServer, policy: McpPolicy): void => {
  server.registerTool(
    'read_remote_file',
    {
      title: 'Read a remote file range',
      description: 'Read a line range of a remote text file with numbered lines and totalLines. Prefer over cat.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        path: z.string().min(1).describe('Remote path (relative to remotePath)'),
        offset: z.number().int().min(1).max(10_000_000).optional().describe('First line (default 1)'),
        limit: z.number().int().min(1).max(MAX_READ_LINES).optional().describe('Max lines (default 200)'),
        maxBytes: z.number().int().min(1).max(MAX_READ_MAX_BYTES).optional().describe('Max bytes (default 16384)'),
        lineNumbers: z.boolean().optional().describe('Number lines (default true)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, path: remotePath, offset, limit, maxBytes, lineNumbers }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }

      const startLine = offset ?? 1;
      const endLine = startLine + (limit ?? 200) - 1;
      const byteLimit = maxBytes ?? DEFAULT_READ_MAX_BYTES;
      const sentinel = newSentinel();
      const target = remoteOperand(remotePath);
      // One extra block so a byte-truncated read is detectable locally.
      const ddBlocks = Math.ceil((byteLimit + 1) / 4096);

      const command = [
        `__sshya_p=${target}`,
        ...fileGuardLines('__sshya_p', sentinel, 'binary_file'),
        `printf '${sentinel}\\nmeta\\n'`,
        // `sed -n '$='` is the same line count as `awk 'END { print NR }'` for a
        // final line without a newline, but roughly twice as fast on big files
        // because it does not split records.
        'sed -n \'$=\' < "$__sshya_p"',
        `printf '${sentinel}\\n'`,
        `sed -n '${startLine},${endLine}p' < "$__sshya_p" | LC_ALL=C dd bs=4096 count=${ddBlocks} 2>/dev/null`,
      ].join('\n');

      const result = await runRemote(connection, command, {
        maxOutputBytes: byteLimit + 8192,
      });

      const tag = parseTaggedOutput(result.stdout, sentinel);
      if (tag.tag === 'kind') {
        return kindFailure(tag.value ?? 'unknown', remotePath);
      }
      if (!result.ok) {
        return resultFailure(result);
      }

      const parts = result.stdout.split(`${sentinel}\n`);
      const totalLines = Number(parts[1]?.split('\n')[1]);
      if (!Number.isFinite(totalLines) || totalLines < 0) {
        return failResult(
          `Could not read metadata for ${remotePath}.`,
          'unknown',
          'The remote file may have changed during the read; retry or inspect it with run_command.',
        );
      }

      const rawBody = parts.slice(2).join(`${sentinel}\n`);
      const body = truncateToBytes(rawBody, byteLimit);
      const byteTruncated = body.length !== rawBody.length;
      const endsWithNewline = body.endsWith('\n');
      const lines = body === ''
        ? []
        : body.split('\n').slice(0, endsWithNewline ? -1 : undefined);
      const lastLine = lines.length > 0 ? startLine + lines.length - 1 : startLine - 1;
      const truncated = byteTruncated || (lines.length > 0 && lastLine < totalLines);

      const width = Math.max(4, String(Math.max(lastLine, startLine)).length);
      const content = lineNumbers === false
        ? body
        : lines
          .map((line, index) => `${String(startLine + index).padStart(width)}\t${line}`)
          .join('\n') + (endsWithNewline && lines.length > 0 ? '\n' : '');

      return ok({
        ok: true,
        path: remotePath,
        content,
        startLine,
        endLine: lastLine,
        totalLines,
        truncated,
        ...(startLine > totalLines
          ? { hint: `offset ${startLine} is past the end of the file (${totalLines} lines).` }
          : {}),
      });
    },
  );

  server.registerTool(
    'grep_remote',
    {
      title: 'Search remote files',
      description: 'grep remote files; returns compact file:line:text matches.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        pattern: z.string().min(1).describe('Pattern to search for'),
        path: z.string().min(1).optional().describe('File or directory (default ".")'),
        glob: z.string().min(1).optional().describe('File name glob, e.g. *.conf'),
        maxMatches: z.number().int().min(1).max(1000).optional().describe('Max matches (default 50)'),
        ignoreCase: z.boolean().optional().describe('Case-insensitive search'),
        fixed: z.boolean().optional().describe('Literal string, not regex'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, pattern, path: searchPath, glob, maxMatches, ignoreCase, fixed }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }

      const maximum = maxMatches ?? 50;
      // -H keeps the file name for a single-file search path; without it GNU
      // grep prints only `line:text` and callers cannot tell what matched.
      const tokens = [`grep -Hrn${fixed ? 'F' : 'E'}${ignoreCase ? 'i' : ''}`, '-e', quoteShellArg(pattern)];
      if (glob) {
        tokens.push(quoteShellArg(`--include=${glob}`));
      }
      tokens.push(remoteOperand(searchPath ?? '.'));

      const result = await runRemote(connection, tokens.join(' '), {
        maxOutputBytes: 256 * 1024,
      });

      // grep exits 1 for "no matches", which is a successful search.
      if (result.exitCode === 1 && !result.timedOut) {
        return ok({ ok: true, matches: [], truncated: false });
      }
      if (result.exitCode === 2) {
        const stderr = result.stderr.trim();
        if (/No such file|does not exist/i.test(stderr)) {
          return failResult(
            `Search path not found: ${searchPath ?? '.'}`,
            'not_found',
            'Relative paths resolve from the connection remote_path.',
          );
        }
        return failResult(
          firstLine(stderr) || 'grep failed.',
          /invalid|unmatched|repetition|bracket/i.test(stderr) ? 'invalid_pattern' : 'grep_failed',
          result.hint ?? 'Check the pattern and search path.',
        );
      }
      if (!result.ok) {
        return resultFailure(result);
      }

      const lines = result.stdout
        .split('\n')
        .filter(line => line.length > 0 && line !== '--' && !line.startsWith('… [sshya] truncated:'));
      const matches = lines
        .slice(0, maximum)
        .map(line => line.replace(/^\.\//, ''));
      return ok({
        ok: true,
        matches,
        truncated: result.stdoutTruncated || lines.length > maximum,
      });
    },
  );

  server.registerTool(
    'stat_remote',
    {
      title: 'Stat remote paths',
      description: 'Size, mode, mtime, and type for remote paths (missing paths: type "missing").',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        paths: z.array(z.string().min(1)).min(1).max(50).describe('Remote paths (relative to remotePath)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ alias, paths }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }

      const command = [
        `for __sshya_f in ${paths.map(remoteOperand).join(' ')}; do`,
        'if [ ! -e "$__sshya_f" ] && [ ! -L "$__sshya_f" ]; then printf \'%s\\tmissing\\n\' "$__sshya_f"; continue; fi',
        'if [ -L "$__sshya_f" ]; then __sshya_t=symlink; elif [ -d "$__sshya_f" ]; then __sshya_t=directory; elif [ -f "$__sshya_f" ]; then __sshya_t=file; else __sshya_t=other; fi',
        // One `stat` per path instead of three: callers routinely batch up to
        // 50 paths, and every extra invocation is a process on the remote host.
        // Fields are split with parameter expansion (not `set -- $var`) so this
        // also works when the remote login shell is zsh, which does not word-split
        // unquoted expansions.
        '__sshya_s=$(stat -c \'%s %Y %a\' "$__sshya_f" 2>/dev/null || stat -f \'%z %m %Lp\' "$__sshya_f" 2>/dev/null) || __sshya_s=',
        '__sshya_rest=${__sshya_s#* }',
        '__sshya_sz=${__sshya_s%% *}',
        '__sshya_mt=${__sshya_rest%% *}',
        '__sshya_mode=${__sshya_rest#* }',
        'printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$__sshya_f" "$__sshya_t" "${__sshya_sz:--1}" "${__sshya_mt:--1}" "$__sshya_mode"',
        'done',
      ].join('\n');

      const result = await runRemote(connection, command, {
        maxOutputBytes: 64 * 1024,
      });
      if (!result.ok) {
        return resultFailure(result);
      }

      const rows = result.stdout.split('\n').filter(line => line.length > 0);
      const entries = paths.map((remotePath, index) => {
        const fields = rows[index]?.split('\t');
        if (fields === undefined || fields[1] === undefined) {
          return { path: remotePath, type: 'unknown' };
        }
        const [, type, size, mtime, mode] = fields;
        const sizeNumber = Number(size);
        const mtimeNumber = Number(mtime);
        return {
          path: remotePath,
          type,
          ...(Number.isFinite(sizeNumber) && sizeNumber >= 0 ? { size: sizeNumber } : {}),
          ...(Number.isFinite(mtimeNumber) && mtimeNumber > 0 ? { mtime: mtimeNumber } : {}),
          ...(mode ? { mode } : {}),
        };
      });

      return ok({
        ok: true,
        entries,
        truncated: result.stdoutTruncated || rows.length < paths.length,
      });
    },
  );

  if (policy.readOnly) {
    return;
  }

  server.registerTool(
    'replace_in_remote_file',
    {
      title: 'Replace text in a remote file',
      description: 'Replace exact text in a remote file atomically; fails on match_count or conflict. Returns a diff.',
      inputSchema: {
        alias: z.string().min(1).describe('Exact connection alias'),
        path: z.string().min(1).describe('Remote path (relative to remotePath)'),
        oldText: z.string().min(1).max(1024 * 1024).describe('Exact text to replace (not a regex)'),
        newText: z.string().max(2 * 1024 * 1024).describe('Replacement text (may be empty)'),
        expectedCount: z.number().int().min(1).max(10_000).optional().describe('Required occurrences (default 1)'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ alias, path: remotePath, oldText, newText, expectedCount }) => {
      if (!policy.isAliasAllowed(alias)) {
        return aliasDenial(policy, alias);
      }
      if (policy.readOnly) {
        return failResult('This MCP server is in read-only mode: replace_in_remote_file is disabled.', 'read_only');
      }
      const connection = getConnectionByAlias(alias);
      if (!connection) {
        return failResult(`Alias not found: ${alias}`);
      }
      if (connection.readonly === true) {
        return readonlyConnectionDenial(alias, 'replace_in_remote_file calls');
      }

      const expected = expectedCount ?? 1;
      const sentinel = newSentinel();
      const target = remoteOperand(remotePath);
      const readCommand = [
        `__sshya_p=${target}`,
        ...fileGuardLines('__sshya_p', sentinel, 'binary_file'),
        '__sshya_size=$(wc -c < "$__sshya_p") || { printf \'' + sentinel + '\\nkind\\npermission_denied\\n\'; exit 0; }',
        `if [ "$__sshya_size" -gt ${MAX_EDIT_FILE_BYTES} ]; then printf '${sentinel}\\nkind\\nfile_too_large\\n'; exit 0; fi`,
        // Single stat for mode/uid/gid; see preserveMetadataLines. Parameter
        // expansion keeps this correct under zsh login shells too.
        '__sshya_meta=$(stat -c \'%a %u %g\' "$__sshya_p" 2>/dev/null || stat -f \'%Lp %u %g\' "$__sshya_p" 2>/dev/null) || __sshya_meta=',
        '__sshya_rest=${__sshya_meta#* }',
        '__sshya_mode=${__sshya_meta%% *}',
        '__sshya_uid=${__sshya_rest%% *}',
        '__sshya_gid=${__sshya_rest#* }',
        '__sshya_ck=$(cksum < "$__sshya_p") || __sshya_ck=',
        `printf '${sentinel}\\nmeta\\n%s\\n%s\\n%s\\n%s\\n' "$__sshya_mode" "$__sshya_uid" "$__sshya_gid" "$__sshya_ck"`,
        `printf '${sentinel}\\n'`,
        'cat < "$__sshya_p"',
      ].join('\n');

      const readResult = await runRemote(connection, readCommand, {
        maxOutputBytes: MAX_EDIT_FILE_BYTES + 64 * 1024,
      });

      const tag = parseTaggedOutput(readResult.stdout, sentinel);
      if (tag.tag === 'kind') {
        return kindFailure(tag.value ?? 'unknown', remotePath);
      }
      if (!readResult.ok) {
        return resultFailure(readResult);
      }
      if (readResult.stdoutTruncated) {
        return failResult(
          `The remote read of ${remotePath} was truncated; refusing to edit a partial file.`,
          'file_too_large',
          'Edit this file on the host with run_command.',
        );
      }

      const parts = readResult.stdout.split(`${sentinel}\n`);
      const meta = parts[1]?.split('\n') ?? [];
      const mode = isMode(meta[1]) ? meta[1] : undefined;
      const uid = isNumeric(meta[2]) ? meta[2] : undefined;
      const gid = isNumeric(meta[3]) ? meta[3] : undefined;
      const checksum = meta[4]?.trim() ?? '';
      if (checksum.length === 0) {
        return failResult(
          `Could not fingerprint ${remotePath}; refusing to edit it.`,
          'unknown',
          'Retry, or use run_command to inspect the file.',
        );
      }

      const content = parts.slice(2).join(`${sentinel}\n`);

      const occurrences: number[] = [];
      let cursor = 0;
      while (cursor <= content.length) {
        const index = content.indexOf(oldText, cursor);
        if (index < 0) {
          break;
        }
        occurrences.push(index);
        cursor = index + oldText.length;
      }

      if (occurrences.length !== expected) {
        const matchLines = occurrences
          .slice(0, 20)
          .map(index => lineNumberAt(content, index));
        return ok(
          {
            ok: false,
            path: remotePath,
            error: `oldText occurs ${occurrences.length} time(s) but expectedCount is ${expected}; nothing was written.`,
            errorKind: 'match_count',
            actualCount: occurrences.length,
            expectedCount: expected,
            matchLines,
            ...(occurrences.length > matchLines.length
              ? { matchLinesTruncated: true }
              : {}),
            hint: 'Re-read the file with read_remote_file and adjust oldText or expectedCount.',
          },
          true,
        );
      }

      if (oldText === newText) {
        return ok({
          ok: true,
          path: remotePath,
          replacements: 0,
          diff: '',
          hint: 'oldText and newText are identical; nothing was written.',
        });
      }

      const updated = content.split(oldText).join(newText);
      const diff = buildEditDiff(content, updated);
      const updatedBytes = Buffer.byteLength(updated, 'utf8');
      if (updatedBytes > MAX_EDIT_FILE_BYTES) {
        return failResult(
          `The edited file would be ${updatedBytes} bytes, over the ${MAX_EDIT_FILE_BYTES} byte limit; nothing was written.`,
          'file_too_large',
          'Write the file with write_remote_file or edit it on the host with run_command.',
        );
      }
      const quotedMode = mode !== undefined ? `chmod ${quoteShellArg(mode)} "$__sshya_tmp" 2>/dev/null || true` : 'true';
      const owner = uid !== undefined && gid !== undefined
        ? `chown ${quoteShellArg(`${uid}:${gid}`)} "$__sshya_tmp" 2>/dev/null || true`
        : 'true';

      const writeCommand = [
        '{',
        `__sshya_p=${target}`,
        `__sshya_tmp=${quoteRemotePath(atomicTempPath(remotePath))}`,
        '__sshya_cur=$(cksum < "$__sshya_p" 2>/dev/null) || __sshya_cur=',
        `if [ "$__sshya_cur" != ${quoteShellArg(checksum)} ]; then printf '${sentinel}\\nerr\\nconflict\\n'; exit 0; fi`,
        'rm -f "$__sshya_tmp"',
        `cat > "$__sshya_tmp" || { rm -f "$__sshya_tmp"; printf '${sentinel}\\nerr\\nwrite_failed\\n'; exit 0; }`,
        `[ "$(wc -c < "$__sshya_tmp")" -eq ${updatedBytes} ] || { rm -f "$__sshya_tmp"; printf '${sentinel}\\nerr\\nwrite_failed\\n'; exit 0; }`,
        quotedMode,
        owner,
        `mv -f "$__sshya_tmp" "$__sshya_p" || { rm -f "$__sshya_tmp"; printf '${sentinel}\\nerr\\nmove_failed\\n'; exit 0; }`,
        `printf '${sentinel}\\nok\\n'`,
        '}',
      ].join('\n');

      const writeResult = await runRemote(connection, writeCommand, {
        stdin: Buffer.from(updated, 'utf8'),
        maxOutputBytes: WRITE_CAPTURE_BYTES,
      });

      const writeTag = parseTaggedOutput(writeResult.stdout, sentinel);
      if (writeTag.tag === 'err' && writeTag.value === 'conflict') {
        return failResult(
          `Remote file changed after it was read: ${remotePath}`,
          'conflict',
          'Nothing was written. Re-read the file with read_remote_file and retry the edit.',
        );
      }
      if (writeTag.tag === 'err' && (writeTag.value === 'write_failed' || writeTag.value === 'move_failed')) {
        return failResult(
          `Failed to write ${remotePath} (${writeTag.value}); the original file may be unchanged.`,
          'write_failed',
          'Check free space and directory permissions with stat_remote or run_command.',
        );
      }
      if (writeTag.tag !== 'ok') {
        return resultFailure(writeResult);
      }

      return ok({
        ok: true,
        path: remotePath,
        replacements: occurrences.length,
        diff,
        bytesWritten: updatedBytes,
        ...(mode !== undefined ? { mode } : {}),
      });
    },
  );
};
