import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDB } from './database';

let previousDb: string | undefined;
let tempDir: string;
let dbPath: string;

beforeEach(() => {
  previousDb = process.env.SSHYA_DB;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-db-test-'));
  dbPath = path.join(tempDir, 'sshm.json');
  process.env.SSHYA_DB = dbPath;
});

afterEach(() => {
  if (previousDb === undefined) {
    delete process.env.SSHYA_DB;
  } else {
    process.env.SSHYA_DB = previousDb;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('initDB', () => {
  test('does not rewrite an already normalized store', () => {
    fs.writeFileSync(
      dbPath,
      JSON.stringify([{ id: 1, alias: 'lab', user: 'cnk', host: '127.0.0.1', port: '22' }], null, 2),
      'utf8',
    );

    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(dbPath, old, old);

    initDB();

    expect(fs.statSync(dbPath).mtimeMs).toBe(old.getTime());
  });

  test('normalizes a store once when a field needs coercion', () => {
    fs.writeFileSync(
      dbPath,
      JSON.stringify([{ id: 1, alias: 'lab', user: 'cnk', host: '127.0.0.1', port: 22 }], null, 2),
      'utf8',
    );

    initDB();

    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8')) as Array<{ port: string }>;
    expect(parsed[0]?.port).toBe('22');
  });
});
