import { describe, expect, test } from 'bun:test';
import { getControlDir } from './control';
import {
  buildInteractiveSshArgs,
  buildRemoteCommandLine,
  buildSshArgs,
} from './ssh';
import { parseByteSize } from './capture';
import type { Connection } from '../database';

const connection: Connection = {
  id: 1,
  alias: 'web',
  user: 'root',
  host: '203.0.113.10',
  port: '2222',
  key_path: '/home/me/.ssh/id_ed25519',
};

describe('buildSshArgs', () => {
  test('builds a non-interactive command with pooled connection options', () => {
    const args = buildSshArgs(connection, {
      tty: false,
      batchMode: true,
      connectTimeout: 10,
      reuse: true,
      hostKeyChecking: 'accept-new',
    });

    expect(args).toContain('-T');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('IdentitiesOnly=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('ControlMaster=auto');
    const controlPath = args.find(arg => arg.startsWith('ControlPath='));
    expect(controlPath).toBeDefined();
    expect(controlPath!.startsWith(`ControlPath=${getControlDir()}`)).toBe(true);
    expect(args.some(arg => arg.startsWith('ControlPersist='))).toBe(true);
    expect(args.at(-1)).toBe('root@203.0.113.10');
  });

  test('omits ControlMaster when reuse is off', () => {
    const args = buildSshArgs(connection, { reuse: false });
    expect(args.some(arg => arg.startsWith('ControlMaster='))).toBe(false);
  });

  test('does not pool unless the caller asks for it', () => {
    const args = buildSshArgs(connection);
    expect(args.some(arg => arg.startsWith('ControlMaster='))).toBe(false);
  });

  test('interactive sessions allocate a TTY and skip pooling', () => {
    const args = buildInteractiveSshArgs({ ...connection, remote_path: '/srv/app' });
    expect(args).toContain('-t');
    expect(args.some(arg => arg.startsWith('ControlMaster='))).toBe(false);
    expect(args.at(-1)).toBe('cd /srv/app && exec "$SHELL" -l');
  });
});

describe('buildRemoteCommandLine', () => {
  test('quotes the remote path and preserves the command', () => {
    const line = buildRemoteCommandLine({ ...connection, remote_path: "/srv/it's here" }, 'ls -la');
    expect(line).toBe("cd '/srv/it'\\''s here' && ls -la");
  });

  test('can skip cwd', () => {
    expect(buildRemoteCommandLine({ ...connection, remote_path: '/srv' }, 'uptime', { cwd: false }))
      .toBe('uptime');
  });

  test('expands a home-relative remote path instead of quoting the tilde', () => {
    expect(buildRemoteCommandLine({ ...connection, remote_path: '~/srv it' }, 'pwd'))
      .toBe(`cd "$HOME"/'srv it' && pwd`);
  });
});

describe('parseByteSize', () => {
  test('understands common suffixes', () => {
    expect(parseByteSize('1024')).toBe(1024);
    expect(parseByteSize('64k')).toBe(64 * 1024);
    expect(parseByteSize('1.5m')).toBe(Math.floor(1.5 * 1024 * 1024));
    expect(parseByteSize('2GiB')).toBe(2 * 1024 * 1024 * 1024);
  });

  test('rejects junk', () => {
    expect(parseByteSize('abc')).toBeUndefined();
    expect(parseByteSize('0')).toBeUndefined();
  });
});
