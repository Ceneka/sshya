import { describe, expect, test } from 'bun:test';
import { classifySshError } from './errors';

describe('classifySshError', () => {
  test('returns undefined for success', () => {
    expect(classifySshError('', { exitCode: 0 })).toBeUndefined();
  });

  test('classifies host key failures with a retry hint', () => {
    const result = classifySshError('Host key verification failed.', { exitCode: 255 });
    expect(result?.kind).toBe('host-key');
    expect(result?.retryable).toBe(true);
    expect(result?.hint).toContain('accept-new-host-key');
  });

  test('classifies authentication failures', () => {
    const result = classifySshError('root@example.com: Permission denied (publickey).', { exitCode: 255 });
    expect(result?.kind).toBe('auth');
  });

  test('classifies DNS and port problems apart', () => {
    expect(classifySshError('ssh: Could not resolve hostname nope: Name or service not known', { exitCode: 255 })?.kind).toBe('dns');
    expect(classifySshError('ssh: connect to host example.com port 22: Connection refused', { exitCode: 255 })?.kind).toBe('refused');
  });

  test('timeouts win over other text', () => {
    const result = classifySshError('Permission denied', { timedOut: true, exitCode: null, timeoutMs: 5000 });
    expect(result?.kind).toBe('timeout');
    expect(result?.hint).toContain('5s');
  });

  test('explains an empty stderr failure', () => {
    const result = classifySshError('', { exitCode: 42 });
    expect(result?.kind).toBe('remote');
    expect(result?.hint).toContain('42');
  });

  test('classifies remote command-not-found', () => {
    expect(classifySshError('bash: line 1: htop: command not found', { exitCode: 127 })?.kind)
      .toBe('remote-command');
  });
});
