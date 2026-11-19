import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { DEFAULT_RUN_TIMEOUT_MS, executeSshCommand, resolveRunTimeoutMs } from './run';
import type { Connection } from '../database';

const connection: Connection = {
  id: 1,
  alias: 'fake',
  user: 'tester',
  host: '127.0.0.1',
  port: '2222',
};

let previousSshBinary: string | undefined;
let previousJson: string | undefined;
let tempDir: string;
let cliCounter = 0;

const repoRoot = path.resolve(import.meta.dir, '../..');

const writeScript = (name: string, body: string): string => {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

const writeCliDb = (): string => {
  cliCounter += 1;
  const dbPath = path.join(tempDir, `cli-db-${cliCounter}.json`);
  fs.writeFileSync(
    dbPath,
    JSON.stringify([{ id: 1, alias: 'prod-api', user: 'tester', host: '127.0.0.1', port: '2222' }], null, 2),
    'utf8',
  );
  return dbPath;
};

const cliEnv = (env: Record<string, string>): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SSHYA_REUSE: '0',
    ...env,
  };
  delete childEnv.SSHYA_JSON;
  return childEnv;
};

const runCli = (args: string[], input?: string, env: Record<string, string> = {}) => {
  return spawnSync(process.execPath, [path.resolve(repoRoot, 'index.ts'), ...args], {
    cwd: repoRoot,
    env: cliEnv(env),
    input,
    encoding: 'utf8',
  });
};

beforeAll(() => {
  previousSshBinary = process.env.SSHYA_SSH_BIN;
  previousJson = process.env.SSHYA_JSON;
  delete process.env.SSHYA_JSON;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-run-test-'));
});

afterAll(() => {
  if (previousSshBinary === undefined) {
    delete process.env.SSHYA_SSH_BIN;
  } else {
    process.env.SSHYA_SSH_BIN = previousSshBinary;
  }
  if (previousJson === undefined) {
    delete process.env.SSHYA_JSON;
  } else {
    process.env.SSHYA_JSON = previousJson;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('executeSshCommand', () => {
  test('captures stdout, stderr, and a zero exit code', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('ok.sh', "printf 'hello\\n'; printf 'note\\n' >&2; exit 0");

    const result = await executeSshCommand(connection, 'uptime', { reuse: false });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('note\n');
    expect(result.reused).toBe(false);
    expect(result.timeoutMs).toBeNull();
    expect(result.errorKind).toBeUndefined();
  });

  test('reports the exit code and classifies auth failures', async () => {
    process.env.SSHYA_SSH_BIN = writeScript(
      'auth.sh',
      "printf 'Permission denied (publickey).\\n' >&2; exit 255",
    );

    const result = await executeSshCommand(connection, 'true', { reuse: false });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(255);
    expect(result.errorKind).toBe('auth');
    expect(result.hint).toContain('Authentication failed');
  });

  test('caps large output and keeps the tail when asked', async () => {
    process.env.SSHYA_SSH_BIN = writeScript(
      'big.sh',
      "awk 'BEGIN { for (i = 0; i < 5000; i++) printf \"a\" }'",
    );

    const head = await executeSshCommand(connection, 'big', {
      reuse: false,
      maxOutputBytes: 128,
    });
    expect(head.stdoutBytes).toBe(5000);
    expect(head.stdoutTruncated).toBe(true);
    expect(head.stdout).toContain('truncated: showing first 128 B');
    expect(head.stdout).toContain('of 4.9 KiB');

    const tail = await executeSshCommand(connection, 'big', {
      reuse: false,
      maxOutputBytes: 128,
      outputMode: 'tail',
    });
    expect(tail.stdoutTruncated).toBe(true);
    expect(tail.stdout).toContain('truncated: showing last 128 B');
  });

  test('kills the process and reports a timeout', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('slow.sh', 'sleep 10');

    const startedAt = Date.now();
    const result = await executeSshCommand(connection, 'slow', {
      reuse: false,
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.errorKind).toBe('timeout');
    expect(result.timeoutMs).toBe(150);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  test('pipes stdin to the remote process', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('cat.sh', 'cat');

    const result = await executeSshCommand(connection, 'cat', {
      reuse: false,
      stdin: Buffer.from('hola\n'),
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hola\n');
  });

  test('streams a readable stdin without buffering it', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('cat-stream.sh', 'cat');

    const result = await executeSshCommand(connection, 'cat', {
      reuse: false,
      stdinStream: Readable.from(['hola\n', 'mundo\n']),
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hola\nmundo\n');
  });

  test('ignores stdin when noStdin is set', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('cat-nostdin.sh', 'cat');

    const result = await executeSshCommand(connection, 'cat', {
      reuse: false,
      noStdin: true,
      stdinStream: Readable.from(['hola\n']),
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('');
  });

  test('times out even while the stdin stream stays open', async () => {
    process.env.SSHYA_SSH_BIN = writeScript('cat-idle.sh', 'cat');

    const startedAt = Date.now();
    const result = await executeSshCommand(connection, 'cat', {
      reuse: false,
      // An agent harness can hold stdin open without writing anything.
      stdinStream: new Readable({ read() { /* never pushes */ } }),
      timeoutMs: 150,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });
});

describe('resolveRunTimeoutMs', () => {
  test('defaults to 120s for JSON or non-TTY output', () => {
    expect(resolveRunTimeoutMs(undefined, { json: true, stdoutIsTTY: true })).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(resolveRunTimeoutMs(undefined, { json: false, stdoutIsTTY: false })).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  test('leaves interactive runs without a timeout', () => {
    expect(resolveRunTimeoutMs(undefined, { json: false, stdoutIsTTY: true })).toBeUndefined();
  });

  test('honors an explicit timeout and treats 0 as disabled', () => {
    expect(resolveRunTimeoutMs('2', { json: true, stdoutIsTTY: true })).toBe(2000);
    expect(resolveRunTimeoutMs('0.25', { json: true, stdoutIsTTY: true })).toBe(250);
    expect(resolveRunTimeoutMs('0', { json: true, stdoutIsTTY: true })).toBeUndefined();
  });
});

describe('run CLI for agents', () => {
  test('refuses a fuzzy alias in JSON mode and returns suggestions', () => {
    const ssh = writeScript('cli-unused.sh', 'exit 0');

    const result = runCli(
      ['run', 'prodap', '--json', '--no-reuse', '--', 'uptime'],
      undefined,
      { SSHYA_SSH_BIN: ssh, SSHYA_DB: writeCliDb() },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      error: string;
      suggestions: string[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Alias not found: prodap');
    expect(payload.suggestions).toContain('prod-api');
  });

  test('applies the 120s default timeout in JSON mode', () => {
    const ssh = writeScript('cli-ok.sh', 'exit 0');

    const result = runCli(
      ['run', 'prod-api', '--json', '--no-reuse', '--', 'uptime'],
      undefined,
      { SSHYA_SSH_BIN: ssh, SSHYA_DB: writeCliDb() },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; timeoutMs: number | null };
    expect(payload.ok).toBe(true);
    expect(payload.timeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  test('forwards piped stdin to the remote command', () => {
    const ssh = writeScript('cli-cat.sh', 'cat');

    const result = runCli(
      ['run', 'prod-api', '--json', '--no-reuse', '--', 'cat'],
      'hola\n',
      { SSHYA_SSH_BIN: ssh, SSHYA_DB: writeCliDb() },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; stdout: string };
    expect(payload.ok).toBe(true);
    expect(payload.stdout).toBe('hola\n');
  });

  test('--no-stdin keeps piped stdin away from the remote command', () => {
    const ssh = writeScript('cli-cat-no-stdin.sh', 'cat');

    const result = runCli(
      ['run', 'prod-api', '--json', '--no-reuse', '--no-stdin', '--', 'cat'],
      'hola\n',
      { SSHYA_SSH_BIN: ssh, SSHYA_DB: writeCliDb() },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; stdout: string };
    expect(payload.ok).toBe(true);
    expect(payload.stdout).toBe('');
  });

  test('times out and exits 124 while the caller keeps stdin open', async () => {
    const ssh = writeScript('cli-cat-idle.sh', 'cat');
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        path.resolve(repoRoot, 'index.ts'),
        'run',
        'prod-api',
        '--json',
        '--no-reuse',
        '--timeout',
        '0.2',
        '--',
        'cat',
      ],
      cwd: repoRoot,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: cliEnv({ SSHYA_SSH_BIN: ssh, SSHYA_DB: writeCliDb() }),
    });

    // Deliberately never write to child.stdin: an agent harness can hold the
    // pipe open without sending anything, and the timeout must still fire.
    const exitCode = await child.exited;
    const payload = JSON.parse(await new Response(child.stdout).text()) as {
      timedOut: boolean;
      timeoutMs: number | null;
    };

    expect(exitCode).toBe(124);
    expect(payload.timedOut).toBe(true);
    expect(payload.timeoutMs).toBe(200);
  });
});
