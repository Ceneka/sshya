import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findAliasSuggestions, resolveAliasForCommand } from './selectAlias';

let previousDb: string | undefined;
let previousJson: string | undefined;
let tempDir: string;
let dbPath: string;

const writeStore = (aliases: string[]) => {
  const connections = aliases.map((alias, index) => ({
    id: index + 1,
    alias,
    user: 'tester',
    host: '127.0.0.1',
    port: String(2200 + index),
  }));
  fs.writeFileSync(dbPath, JSON.stringify(connections, null, 2), 'utf8');
};

beforeEach(() => {
  previousDb = process.env.SSHYA_DB;
  previousJson = process.env.SSHYA_JSON;
  delete process.env.SSHYA_JSON;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-alias-test-'));
  dbPath = path.join(tempDir, 'sshm.json');
  process.env.SSHYA_DB = dbPath;
  writeStore(['prod-api', 'prod-app', 'prod-db', 'staging-api']);
});

afterEach(() => {
  if (previousDb === undefined) {
    delete process.env.SSHYA_DB;
  } else {
    process.env.SSHYA_DB = previousDb;
  }
  if (previousJson === undefined) {
    delete process.env.SSHYA_JSON;
  } else {
    process.env.SSHYA_JSON = previousJson;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveAliasForCommand', () => {
  test('exact matches always win, even in JSON mode', () => {
    const result = resolveAliasForCommand('prod-api', { json: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an exact match');
    }
    expect(result.alias).toBe('prod-api');
    expect(result.connection.host).toBe('127.0.0.1');
    expect(result.fuzzy).toBe(false);
  });

  test('refuses fuzzy matching with JSON and returns at most three suggestions', () => {
    const result = resolveAliasForCommand('prod', { json: true });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected fuzzy matching to be refused');
    }
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
    expect(result.suggestions).toContain('prod-api');
    expect(result.suggestions).not.toContain('staging-api');
  });

  test('refuses fuzzy matching when the terminal is not interactive', () => {
    const result = resolveAliasForCommand('prodap', { interactive: false });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected fuzzy matching to be refused');
    }
    expect(result.suggestions[0]).toBe('prod-api');
  });

  test('SSHYA_JSON disables fuzzy matching even when forced interactive', () => {
    process.env.SSHYA_JSON = '1';

    const result = resolveAliasForCommand('prodap', { interactive: true });

    expect(result.ok).toBe(false);
  });

  test('allows fuzzy matching for an interactive human and reports the substitution', () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    try {
      const result = resolveAliasForCommand('prodap', { interactive: true });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected an interactive fuzzy match');
      }
      expect(result.alias).toBe('prod-api');
      expect(result.fuzzy).toBe(true);
    } finally {
      console.error = originalError;
    }

    expect(errors.join('\n')).toContain('Using alias "prod-api" for "prodap"');
  });

  test('findAliasSuggestions caps the candidate list', () => {
    writeStore(['prod-api', 'prod-app', 'prod-db', 'prod-web', 'prod-worker']);

    const suggestions = findAliasSuggestions('prod', 3);

    expect(suggestions).toHaveLength(3);
  });
});
