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

  test('explains how sshya constrains agent keys on auth failures', () => {
    const result = classifySshError('Received disconnect: Too many authentication failures', { exitCode: 255 });
    expect(result?.kind).toBe('auth');
    expect(result?.hint).toContain('IdentitiesOnly=yes');
    expect(result?.hint).not.toContain('IdentitiesOnly is not set');
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

  test('classifies sudo tty requirements with an MCP-friendly hint', () => {
    const terminal = classifySshError(
      'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper',
      { exitCode: 1 },
    );
    expect(terminal?.kind).toBe('tty');
    expect(terminal?.hint).toContain('tty: true');
    expect(terminal?.hint).toContain('sudo -n');

    const noTty = classifySshError(
      'sudo: no tty present and no askpass program specified',
      { exitCode: 1 },
    );
    expect(noTty?.kind).toBe('tty');
  });

  test('classifies sudo password prompts apart from tty failures', () => {
    const password = classifySshError('sudo: a password is required', { exitCode: 1 });
    expect(password?.kind).toBe('sudo_password');
    expect(password?.hint).toContain('sudo -n');
    expect(password?.hint).toContain('NOPASSWD');
  });

  test('does not leave CLI-only flags in generic hints', () => {
    const unknown = classifySshError('something unexpected', { exitCode: 1 });
    expect(unknown?.kind).toBe('unknown');
    expect(unknown?.hint).toContain('timeoutMs');
    expect(unknown?.hint).toContain('--timeout');
  });
});
