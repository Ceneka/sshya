import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDB, upsertConnection } from '../database';
import { buildAtomicWriteCommand } from './fileTools';
import { createMcpServer, type McpServerOptions } from './server';

type JsonResult<T> = {
  isError: boolean;
  data: T;
};

type ToolError = {
  ok: false;
  error: string;
  errorKind: string;
  hint?: string;
};

type ReadResult = {
  ok: boolean;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
};

type ReplaceResult = {
  ok: boolean;
  path: string;
  replacements: number;
  diff: string;
  mode?: string;
};

type GrepResult = {
  ok: boolean;
  matches: string[];
  truncated: boolean;
};

type StatResult = {
  ok: boolean;
  entries: Array<{ path: string; type: string; size?: number; mode?: string; mtime?: number }>;
  truncated: boolean;
};

let tempDir: string;
let counter = 0;
let previousDb: string | undefined;
let previousAllow: string | undefined;
let previousReadOnly: string | undefined;
let previousSshBin: string | undefined;

const writeScript = (name: string, body: string): string => {
  const file = path.join(tempDir, `${counter++}-${name}`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

/** Execute the final ssh argument locally, ignoring all connection flags. */
const useLocalShell = (): void => {
  process.env.SSHYA_SSH_BIN = writeScript('ssh-local.sh', 'for last; do :; done; exec sh -c "$last"');
};

const workDir = (): string => fs.mkdtempSync(path.join(tempDir, 'work-'));

const seed = (alias: string, remotePath?: string, readonly?: boolean): void => {
  upsertConnection({
    alias,
    user: 'tester',
    host: '127.0.0.1',
    port: '22',
    remote_path: remotePath,
    readonly,
  });
};

const openServer = async (options: McpServerOptions = {}) => {
  const server = await createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sshya-files-test', version: '0.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

const withServer = async (
  options: McpServerOptions,
  run: (client: Client) => Promise<void>,
): Promise<void> => {
  const { client, close } = await openServer(options);
  try {
    await run(client);
  } finally {
    await close();
  }
};

const callJson = async <T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<JsonResult<T>> => {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find(entry => entry.type === 'text')?.text;
  if (text === undefined) {
    throw new Error(`Tool ${name} returned no text content`);
  }
  return { isError: result.isError === true, data: JSON.parse(text) as T };
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map(tool => tool.name).sort();

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-filetools-test-'));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousDb = process.env.SSHYA_DB;
  previousAllow = process.env.SSHYA_MCP_ALLOW;
  previousReadOnly = process.env.SSHYA_MCP_READ_ONLY;
  previousSshBin = process.env.SSHYA_SSH_BIN;

  process.env.SSHYA_DB = path.join(tempDir, `sshm-${counter++}-${Date.now()}.json`);
  delete process.env.SSHYA_MCP_ALLOW;
  delete process.env.SSHYA_MCP_READ_ONLY;
  delete process.env.SSHYA_SSH_BIN;
  initDB();
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore('SSHYA_DB', previousDb);
  restore('SSHYA_MCP_ALLOW', previousAllow);
  restore('SSHYA_MCP_READ_ONLY', previousReadOnly);
  restore('SSHYA_SSH_BIN', previousSshBin);
});

describe('read_remote_file', () => {
  test('reads a line range with numbers and reports totals', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(
      path.join(dir, 'app.conf'),
      Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n') + '\n',
    );
    seed('web', dir);

    await withServer({}, async (client) => {
      const range = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'app.conf',
        offset: 3,
        limit: 4,
      });

      expect(range.isError).toBe(false);
      expect(range.data).toMatchObject({
        ok: true,
        path: 'app.conf',
        startLine: 3,
        endLine: 6,
        totalLines: 10,
        truncated: true,
      });
      expect(range.data.content).toBe(
        '   3\tline 3\n   4\tline 4\n   5\tline 5\n   6\tline 6\n',
      );

      const all = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'app.conf',
      });
      expect(all.data.startLine).toBe(1);
      expect(all.data.endLine).toBe(10);
      expect(all.data.truncated).toBe(false);
      expect(all.data.content.split('\n')[0]).toBe('   1\tline 1');
    });
  });

  test('can omit line numbers and honors maxBytes', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(
      path.join(dir, 'long.txt'),
      ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)].join('\n') + '\n',
    );
    seed('web', dir);

    await withServer({}, async (client) => {
      const plain = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'long.txt',
        lineNumbers: false,
      });
      expect(plain.data.content.startsWith('a'.repeat(100))).toBe(true);
      expect(plain.data.totalLines).toBe(3);

      const capped = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'long.txt',
        maxBytes: 64,
      });
      expect(capped.data.truncated).toBe(true);
      expect(capped.data.endLine).toBeLessThan(3);
      expect(Buffer.byteLength(capped.data.content, 'utf8')).toBeLessThan(200);
    });
  });

  test('preserves multibyte UTF-8 content', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'utf8.txt'), 'café 😀\nüber\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'utf8.txt',
      });
      expect(result.isError).toBe(false);
      expect(result.data.content).toBe('   1\tcafé 😀\n   2\tüber\n');
    });
  });

  test('handles files without a trailing newline and empty files', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'noeol.txt'), 'first\nsecond');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    seed('web', dir);

    await withServer({}, async (client) => {
      const noeol = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'noeol.txt',
      });
      expect(noeol.data).toMatchObject({ totalLines: 2, startLine: 1, endLine: 2, truncated: false });
      expect(noeol.data.content).toBe('   1\tfirst\n   2\tsecond');

      const empty = await callJson<ReadResult>(client, 'read_remote_file', {
        alias: 'web',
        path: 'empty.txt',
      });
      expect(empty.data).toMatchObject({ totalLines: 0, content: '', endLine: 0, truncated: false });
    });
  });

  test('reports missing files and directories', async () => {
    useLocalShell();
    const dir = workDir();
    seed('web', dir);

    await withServer({}, async (client) => {
      const missing = await callJson<ToolError>(client, 'read_remote_file', {
        alias: 'web',
        path: 'nope.conf',
      });
      expect(missing.isError).toBe(true);
      expect(missing.data.errorKind).toBe('not_found');
      expect(missing.data.hint).toContain('remote_path');

      const directory = await callJson<ToolError>(client, 'read_remote_file', {
        alias: 'web',
        path: '.',
      });
      expect(directory.isError).toBe(true);
      expect(directory.data.errorKind).toBe('is_a_directory');
    });
  });

  test('refuses binary files', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x41]));
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ToolError>(client, 'read_remote_file', {
        alias: 'web',
        path: 'blob.bin',
      });
      expect(result.isError).toBe(true);
      expect(result.data.errorKind).toBe('binary_file');
    });
  });

  test('reports permission denied', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'secret.conf');
    fs.writeFileSync(file, 'secret\n');
    fs.chmodSync(file, 0o000);
    seed('web', dir);

    try {
      await withServer({}, async (client) => {
        const result = await callJson<ToolError>(client, 'read_remote_file', {
          alias: 'web',
          path: 'secret.conf',
        });
        expect(result.isError).toBe(true);
        expect(result.data.errorKind).toBe('permission_denied');
      });
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });
});

describe('replace_in_remote_file', () => {
  test('replaces one exact occurrence and returns a small diff', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'app.conf');
    fs.writeFileSync(file, 'server {\n  port 80;\n}\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ReplaceResult>(client, 'replace_in_remote_file', {
        alias: 'web',
        path: 'app.conf',
        oldText: 'port 80',
        newText: 'port 8080',
      });

      expect(result.isError).toBe(false);
      expect(result.data.replacements).toBe(1);
      expect(result.data.diff).toContain('-  port 80;');
      expect(result.data.diff).toContain('+  port 8080;');
      expect(fs.readFileSync(file, 'utf8')).toBe('server {\n  port 8080;\n}\n');
    });
  });

  test('replaces multiple occurrences when expectedCount matches', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'vars.conf');
    fs.writeFileSync(file, 'a=1\nb=2\na=3\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ReplaceResult>(client, 'replace_in_remote_file', {
        alias: 'web',
        path: 'vars.conf',
        oldText: 'a=',
        newText: 'A=',
        expectedCount: 2,
      });

      expect(result.isError).toBe(false);
      expect(result.data.replacements).toBe(2);
      expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nb=2\nA=3\n');
    });
  });

  test('supports deleting text and keeps the original trailing byte', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'delete.conf');
    fs.writeFileSync(file, 'keep\ndrop me\nkeep');
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ReplaceResult>(client, 'replace_in_remote_file', {
        alias: 'web',
        path: 'delete.conf',
        oldText: '\ndrop me',
        newText: '',
      });

      expect(result.isError).toBe(false);
      expect(result.data.replacements).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('keep\nkeep');
    });
  });

  test('fails with match_count and the matching line numbers', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'dupes.conf');
    fs.writeFileSync(file, 'x\ny\nx\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ToolError & { actualCount: number; matchLines: number[] }>(
        client,
        'replace_in_remote_file',
        {
          alias: 'web',
          path: 'dupes.conf',
          oldText: 'x',
          newText: 'z',
        },
      );

      expect(result.isError).toBe(true);
      expect(result.data.errorKind).toBe('match_count');
      expect(result.data.actualCount).toBe(2);
      expect(result.data.matchLines).toEqual([1, 3]);
      expect(fs.readFileSync(file, 'utf8')).toBe('x\ny\nx\n');
    });
  });

  test('detects a concurrent modification and writes nothing', async () => {
    const dir = workDir();
    const file = path.join(dir, 'race.conf');
    fs.writeFileSync(file, 'original\n');
    const countFile = path.join(tempDir, `race-count-${counter++}`);
    process.env.SSHYA_SSH_BIN = writeScript(
      'ssh-drift.sh',
      [
        `__n=0; [ -f '${countFile}' ] && __n=$(cat '${countFile}')`,
        '__n=$((__n + 1))',
        `printf '%s' "$__n" > '${countFile}'`,
        `if [ "$__n" -ge 2 ]; then printf 'drift\\n' >> '${file}'; fi`,
        'for last; do :; done; exec sh -c "$last"',
      ].join('\n'),
    );
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ToolError>(client, 'replace_in_remote_file', {
        alias: 'web',
        path: 'race.conf',
        oldText: 'original',
        newText: 'changed',
      });

      expect(result.isError).toBe(true);
      expect(result.data.errorKind).toBe('conflict');
      expect(fs.readFileSync(file, 'utf8')).toBe('original\ndrift\n');
    });
  });

  test('preserves file mode across an atomic edit', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'mode.conf');
    fs.writeFileSync(file, 'keep me\n');
    fs.chmodSync(file, 0o640);
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<ReplaceResult>(client, 'replace_in_remote_file', {
        alias: 'web',
        path: 'mode.conf',
        oldText: 'keep',
        newText: 'kept',
      });

      expect(result.isError).toBe(false);
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
      expect(fs.readFileSync(file, 'utf8')).toBe('kept me\n');
      expect(fs.readdirSync(dir).filter(name => name.includes('.sshya-tmp'))).toEqual([]);
    });
  });

  test('refuses readonly connections', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'locked.conf');
    fs.writeFileSync(file, 'unchanged\n');
    seed('web', dir, true);

    await withServer({}, async (client) => {
      const result = await callJson<ToolError>(client, 'replace_in_remote_file', {
        alias: 'web',
        path: 'locked.conf',
        oldText: 'unchanged',
        newText: 'changed',
      });

      expect(result.isError).toBe(true);
      expect(result.data.errorKind).toBe('connection_readonly');
      expect(fs.readFileSync(file, 'utf8')).toBe('unchanged\n');
    });
  });

  test('is absent in read-only mode while the read tools remain', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'ro.conf');
    fs.writeFileSync(file, 'one\n');
    seed('web', dir);

    await withServer({ readOnly: true }, async (client) => {
      const names = await toolNames(client);
      expect(names).toContain('read_remote_file');
      expect(names).toContain('grep_remote');
      expect(names).toContain('stat_remote');
      expect(names).not.toContain('replace_in_remote_file');

      const denied = await client.callTool({
        name: 'replace_in_remote_file',
        arguments: { alias: 'web', path: 'ro.conf', oldText: 'one', newText: 'two' },
      });
      expect(denied.isError).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('one\n');
    });
  });
});

describe('file tool responses', () => {
  test('are minified like the rest of the MCP surface', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'mini.conf'), 'one\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const read = await client.callTool({ name: 'read_remote_file', arguments: { alias: 'web', path: 'mini.conf' } });
      const readText = (read.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(readText).toBe(JSON.stringify(JSON.parse(readText)));
      expect(readText).not.toContain('\n');

      // Regressions for the same contract on the other file tools.
      const stat = await client.callTool({ name: 'stat_remote', arguments: { alias: 'web', paths: ['mini.conf'] } });
      const statText = (stat.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(statText).toBe(JSON.stringify(JSON.parse(statText)));

      const missing = await client.callTool({ name: 'read_remote_file', arguments: { alias: 'web', path: 'gone' } });
      const missingText = (missing.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(missingText).toBe(JSON.stringify(JSON.parse(missingText)));
      expect(missing.isError).toBe(true);
    });
  });
});

describe('grep_remote', () => {
  test('returns compact file:line:text matches and honors glob and limits', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'a.conf'), 'alpha\nneedle here\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'needle too\n');
    fs.writeFileSync(path.join(dir, 'many.log'), 'needle 1\nneedle 2\nneedle 3\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const all = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'needle',
      });
      expect(all.isError).toBe(false);
      expect(all.data.truncated).toBe(false);
      expect(all.data.matches.sort()).toEqual([
        'a.conf:2:needle here',
        'b.txt:1:needle too',
        'many.log:1:needle 1',
        'many.log:2:needle 2',
        'many.log:3:needle 3',
      ]);

      const globbed = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'needle',
        glob: '*.conf',
      });
      expect(globbed.data.matches).toEqual(['a.conf:2:needle here']);

      const limited = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'needle',
        path: 'many.log',
        maxMatches: 2,
      });
      expect(limited.data.matches).toHaveLength(2);
      expect(limited.data.truncated).toBe(true);

      const none = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'absent',
      });
      expect(none.isError).toBe(false);
      expect(none.data.matches).toEqual([]);
    });
  });

  test('keeps the file name when the search path is a single file', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'one.conf'), 'needle\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'needle',
        path: 'one.conf',
      });
      expect(result.isError).toBe(false);
      // GNU grep drops the file name for a lone file operand unless -H is set.
      expect(result.data.matches).toEqual(['one.conf:1:needle']);
    });
  });

  test('supports ignoreCase and fixed strings', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'patterns.txt'), 'a.b\naxb\nNEEDLE\n');
    seed('web', dir);

    await withServer({}, async (client) => {
      const regex = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'a.b',
        fixed: false,
      });
      expect(regex.data.matches.sort()).toEqual(['patterns.txt:1:a.b', 'patterns.txt:2:axb']);

      const fixed = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'a.b',
        fixed: true,
      });
      expect(fixed.data.matches).toEqual(['patterns.txt:1:a.b']);

      const insensitive = await callJson<GrepResult>(client, 'grep_remote', {
        alias: 'web',
        pattern: 'needle',
        ignoreCase: true,
      });
      expect(insensitive.data.matches).toEqual(['patterns.txt:3:NEEDLE']);
    });
  });
});

describe('stat_remote', () => {
  test('reports type, size, mode, and mtime for each path', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'stat.conf');
    fs.writeFileSync(file, '12345\n');
    fs.chmodSync(file, 0o644);
    fs.mkdirSync(path.join(dir, 'nested'));
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<StatResult>(client, 'stat_remote', {
        alias: 'web',
        paths: ['stat.conf', 'nested', 'missing.conf'],
      });

      expect(result.isError).toBe(false);
      const [fileEntry, dirEntry, missing] = result.data.entries;
      expect(fileEntry).toMatchObject({ path: 'stat.conf', type: 'file', size: 6, mode: '644' });
      expect(fileEntry?.mtime).toBeGreaterThan(0);
      expect(dirEntry).toMatchObject({ path: 'nested', type: 'directory' });
      expect(missing).toEqual({ path: 'missing.conf', type: 'missing' });
      expect(result.data.truncated).toBe(false);
    });
  });
});

describe('atomic write_remote_file', () => {
  test('uses a unique temp path per call so concurrent edits cannot collide', () => {
    const tempOf = (command: string): string => /__sshya_tmp=(.+)/.exec(command)?.[1] ?? '';
    const first = tempOf(buildAtomicWriteCommand({ target: '/srv/app.conf' }));
    const second = tempOf(buildAtomicWriteCommand({ target: '/srv/app.conf' }));

    expect(first).not.toBe('');
    expect(second).not.toBe('');
    expect(first).not.toBe(second);
    // A literal `$$` would be single-quoted by quoteRemotePath and never
    // expanded, which is the bug this test pins.
    expect(first).not.toContain('$$');
    expect(first.startsWith('/srv/.app.conf.sshya-tmp.')).toBe(true);
  });

  test('reads mode, uid, and gid with a single stat invocation', () => {
    // Each remote `stat` is its own process. Three of them per write showed up
    // clearly against a real sshd, so keep this at one. Fields are split with
    // parameter expansion because login shells such as zsh do not word-split
    // unquoted expansions.
    const command = buildAtomicWriteCommand({ target: '/srv/app.conf' });
    expect(command.match(/stat -c /g)?.length).toBe(1);
    expect(command).toContain('__sshya_uid=${__sshya_rest%% *}');
    expect(command).not.toContain('set --');
  });

  test('renames a temp file into place and preserves the mode', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'atomic.conf');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<{ ok: boolean; bytesWritten: number; atomic: boolean }>(
        client,
        'write_remote_file',
        {
          alias: 'web',
          path: 'atomic.conf',
          content: 'new\n',
          atomic: true,
        },
      );

      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({ ok: true, bytesWritten: 4, atomic: true });
      expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
      expect(fs.readdirSync(dir).filter(name => name.includes('.sshya-tmp'))).toEqual([]);
    });
  });

  test('creates a new file atomically', async () => {
    useLocalShell();
    const dir = workDir();
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<{ ok: boolean }>(client, 'write_remote_file', {
        alias: 'web',
        path: 'fresh.conf',
        content: 'hello\n',
        atomic: true,
      });

      expect(result.isError).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'fresh.conf'), 'utf8')).toBe('hello\n');
    });
  });

  test('appends atomically without losing the existing bytes', async () => {
    useLocalShell();
    const dir = workDir();
    const file = path.join(dir, 'append.conf');
    fs.writeFileSync(file, 'one\n');
    fs.chmodSync(file, 0o600);
    seed('web', dir);

    await withServer({}, async (client) => {
      const result = await callJson<{ ok: boolean }>(client, 'write_remote_file', {
        alias: 'web',
        path: 'append.conf',
        content: 'two\n',
        append: true,
        atomic: true,
      });

      expect(result.isError).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});

describe('file tool policy', () => {
  test('refuses aliases outside the allowlist before touching the host', async () => {
    useLocalShell();
    const dir = workDir();
    fs.writeFileSync(path.join(dir, 'x.conf'), 'x\n');
    seed('web', dir);
    seed('db', dir);

    await withServer({ aliases: ['web'] }, async (client) => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['read_remote_file', { alias: 'db', path: 'x.conf' }],
        ['replace_in_remote_file', { alias: 'db', path: 'x.conf', oldText: 'x', newText: 'y' }],
        ['grep_remote', { alias: 'db', pattern: 'x' }],
        ['stat_remote', { alias: 'db', paths: ['x.conf'] }],
      ];

      for (const [name, args] of calls) {
        const result = await callJson<ToolError>(client, name, args);
        expect({ name, isError: result.isError }).toEqual({ name, isError: true });
        expect({ name, errorKind: result.data.errorKind }).toEqual({ name, errorKind: 'alias_not_allowed' });
      }
    });
  });
});
