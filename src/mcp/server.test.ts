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
      expect(guide).toContain('not the remote host');
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
