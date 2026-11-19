import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDB, upsertConnection } from '../database';
import { buildIssueUrl, clearReports, findReport, getReportsPath, readReports, type Report } from '../feedback/store';
import { createMcpServer, type McpServerOptions } from './server';

const ENV_KEYS = ['SSHYA_DB', 'SSHYA_MCP_FEEDBACK', 'SSHYA_MCP_LARGE_RESPONSE', 'SSHYA_SSH_BIN', 'SSHYA_MCP_ALLOW', 'SSHYA_MCP_READ_ONLY'] as const;

let tempDir: string;
let counter = 0;
let saved: Record<string, string | undefined> = {};

const openClient = async (options: McpServerOptions = {}) => {
  const server = await createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'feedback-test', version: '1.2.3' });
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

const texts = (result: unknown): string[] =>
  (((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>).map(item => item.text ?? '');

const sshScript = (body: string): string => {
  const file = path.join(tempDir, `ssh-${counter}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-feedback-test-'));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.SSHYA_DB = path.join(tempDir, `store-${counter}`, 'sshm.json');
  initDB();
  upsertConnection({ alias: 'web', user: 'tester', host: 'web.example.test' });
});

afterEach(() => {
  counter += 1;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('MCP feedback opt-in', () => {
  test('is off by default: no report_issue tool and no notes', async () => {
    process.env.SSHYA_SSH_BIN = sshScript(`head -c 40000 /dev/zero | tr '\\0' x`);
    const { client, close } = await openClient();
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('report_issue');
      const result = await client.callTool({ name: 'run_command', arguments: { alias: 'web', command: 'big', maxOutputBytes: 65536 } });
      expect(texts(result)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test('--feedback and SSHYA_MCP_FEEDBACK=1 both expose report_issue', async () => {
    for (const options of [{ feedback: true }, {}]) {
      if (!('feedback' in options)) {
        process.env.SSHYA_MCP_FEEDBACK = '1';
      }
      const { client, close } = await openClient(options);
      try {
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect(names).toContain('report_issue');
        expect(client.getInstructions()).toContain('report_issue');
      } finally {
        await close();
      }
    }
  });

  test('report_issue saves a local report with call metadata but no arguments or output', async () => {
    process.env.SSHYA_SSH_BIN = sshScript(`printf 'secret-output\\n'; exit 3`);
    const { client, close } = await openClient({ feedback: true });
    try {
      await client.callTool({ name: 'list_connections', arguments: {} });
      await client.callTool({ name: 'run_command', arguments: { alias: 'web', command: 'echo secret-arg' } });
      const result = await client.callTool({
        name: 'report_issue',
        arguments: { category: 'bad_result', summary: 'Exit code looked wrong', details: 'Expected 0.', tool: 'run_command' },
      });
      const reply = JSON.parse(texts(result)[0]!) as { ok: boolean; id: string; savedTo: string };
      expect(reply.ok).toBe(true);

      const reports = readReports();
      expect(reports).toHaveLength(1);
      const report = reports[0]!;
      expect(report.id).toBe(reply.id);
      expect(report.category).toBe('bad_result');
      expect(report.tool).toBe('run_command');
      expect(report.client).toEqual({ name: 'feedback-test', version: '1.2.3' });
      expect(report.recentCalls.map(call => call.tool)).toEqual(['list_connections', 'run_command']);
      expect(report.recentCalls[1]).toMatchObject({ isError: true, errorKind: 'remote' });

      const raw = fs.readFileSync(getReportsPath(), 'utf8');
      expect(raw).not.toContain('secret-output');
      expect(raw).not.toContain('secret-arg');
      expect(fs.statSync(getReportsPath()).mode & 0o777).toBe(0o600);
    } finally {
      await close();
    }
  });

  test('large replies get a size note pointing at report_issue', async () => {
    process.env.SSHYA_MCP_LARGE_RESPONSE = '1024';
    process.env.SSHYA_SSH_BIN = sshScript(`head -c 4000 /dev/zero | tr '\\0' x`);
    const { client, close } = await openClient({ feedback: true });
    try {
      const big = texts(await client.callTool({ name: 'run_command', arguments: { alias: 'web', command: 'big' } }));
      expect(big).toHaveLength(2);
      expect(JSON.parse(big[0]!).ok).toBe(true);
      expect(big[1]).toMatch(/^sshya note: this reply is \d+\.\d KiB \(~\d+ tokens\)/);

      const small = texts(await client.callTool({ name: 'list_connections', arguments: {} }));
      expect(small).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe('report store', () => {
  const sample = (overrides: Partial<Report> = {}): Report => ({
    id: 'abcd1234',
    createdAt: '2026-11-19T00:00:00.000Z',
    version: '0.8.1',
    category: 'large_output',
    summary: 'grep_remote returned 200 KiB for a narrow pattern',
    platform: 'linux-x64',
    node: 'v22.0.0',
    recentCalls: [{ tool: 'grep_remote', at: '2026-11-19T00:00:00.000Z', ms: 12, bytes: 204800, truncated: true }],
    ...overrides,
  });

  test('builds a prefilled GitHub issue URL that stays bounded', () => {
    const url = new URL(buildIssueUrl(sample({ details: 'x'.repeat(20000) })));
    expect(url.origin + url.pathname).toBe('https://github.com/Ceneka/sshya/issues/new');
    expect(url.searchParams.get('title')).toBe('[agent report] grep_remote returned 200 KiB for a narrow pattern');
    const body = url.searchParams.get('body')!;
    expect(body).toContain('**Category:** large_output');
    expect(body).toContain('sshya reports show abcd1234');
    expect(body.length).toBeLessThan(6500);
  });

  test('finds by id prefix, skips torn lines, and clears', () => {
    const file = getReportsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(sample())}\n{torn\n${JSON.stringify(sample({ id: 'ffff0000' }))}\n`);
    expect(readReports().map(r => r.id)).toEqual(['abcd1234', 'ffff0000']);
    expect(findReport('abcd')?.id).toBe('abcd1234');
    expect(clearReports(['abcd1234'])).toBe(1);
    expect(readReports().map(r => r.id)).toEqual(['ffff0000']);
    expect(clearReports()).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
