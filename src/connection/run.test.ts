import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeSshCommand } from './run';
import type { Connection } from '../database';

const connection: Connection = {
  id: 1,
  alias: 'fake',
  user: 'tester',
  host: '127.0.0.1',
  port: '2222',
};

let previousSshBinary: string | undefined;
let tempDir: string;

const writeScript = (name: string, body: string): string => {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

beforeAll(() => {
  previousSshBinary = process.env.SSHYA_SSH_BIN;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-run-test-'));
});

afterAll(() => {
  if (previousSshBinary === undefined) {
    delete process.env.SSHYA_SSH_BIN;
  } else {
    process.env.SSHYA_SSH_BIN = previousSshBinary;
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
});
