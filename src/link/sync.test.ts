import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addConnection,
  getConnectionByAlias,
  getConnections,
  initDB,
  LinkedConnectionError,
  removeConnection,
  replaceConnections,
  updateConnection,
  type Connection,
} from '../database';
import { loadLinkConfig, readLinkState, resolveLocalKeyPath, saveLinkConfig } from './config';
import { fetchLazybackupSnapshot, LinkFetchError, type FetchLike, type LazybackupServer } from './lazybackup';
import { aliasFromName, autoSync, planSync, syncLink } from './sync';
import { ensureDeviceKey, getDeviceKeyPath, publicKeyFingerprint, readDeviceKey } from './deviceKey';
import { execFileSync } from 'child_process';

const ENV_KEYS = ['SSHYA_DB', 'SSHYA_LINK_URL', 'SSHYA_LINK_TOKEN', 'SSHYA_LINK_TTL', 'SSHYA_LINK_AUTO', 'SSHYA_LINK_AUTHORIZE'] as const;
let savedEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshya-link-test-'));
  process.env.SSHYA_DB = path.join(tempDir, 'sshm.json');
  initDB();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const server = (overrides: Partial<LazybackupServer> = {}): LazybackupServer => ({
  id: 'srv1',
  name: 'Web Prod',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authType: 'key',
  systemKeyPath: '/root/.ssh/id_web',
  ...overrides,
});

const noFiles = () => false;
const onlyFiles = (...files: string[]) => (file: string) => files.includes(file);
const home = os.homedir();

describe('aliasFromName', () => {
  test('slugifies free-text names', () => {
    expect(aliasFromName('Web Prod')).toBe('web-prod');
    expect(aliasFromName('  Señal / DB #2 ')).toBe('senal-db-2');
    expect(aliasFromName('api.example.com')).toBe('api.example.com');
    expect(aliasFromName('!!!')).toBe('server');
  });
});

describe('resolveLocalKeyPath', () => {
  test('maps the container mount to ~/.ssh', () => {
    const want = path.join(home, '.ssh', 'id_web');
    expect(resolveLocalKeyPath('/root/.ssh/id_web', undefined, onlyFiles(want))).toBe(want);
  });

  test('falls back to ~/.ssh/<basename> for unknown prefixes', () => {
    const want = path.join(home, '.ssh', 'deploy');
    expect(resolveLocalKeyPath('/srv/keys/deploy', undefined, onlyFiles(want))).toBe(want);
  });

  test('returns undefined when nothing exists locally', () => {
    expect(resolveLocalKeyPath('/root/.ssh/id_web', undefined, noFiles)).toBeUndefined();
  });
});

describe('planSync', () => {
  const opts = { url: 'https://lb.test', exists: onlyFiles(path.join(home, '.ssh', 'id_web')) };

  test('adds new servers with derived alias, port, and key', () => {
    const { next, report } = planSync([], { servers: [server({ port: 2222 })], keys: [] }, opts);
    expect(report.added).toEqual(['web-prod']);
    expect(next[0]).toMatchObject({
      alias: 'web-prod',
      user: 'root',
      host: '10.0.0.1',
      port: '2222',
      key_path: path.join(home, '.ssh', 'id_web'),
      link: { source: 'lazybackup', id: 'srv1', name: 'Web Prod', auth: 'key' },
    });
  });

  test('follows renames and target changes but keeps local overlay fields', () => {
    const local: Connection[] = [{
      id: 7, alias: 'web-prod', user: 'root', host: '10.0.0.1', remote_path: '/srv/app', readonly: true, lastUsed: 42,
      link: { source: 'lazybackup', id: 'srv1' },
    }];
    const { next, report } = planSync(local, { servers: [server({ name: 'Web', host: '10.0.0.9' })], keys: [] }, opts);
    expect(report.updated).toEqual(['web']);
    expect(next[0]).toMatchObject({ id: 7, alias: 'web', host: '10.0.0.9', remote_path: '/srv/app', readonly: true, lastUsed: 42 });
  });

  test('keeps a locally overridden key', () => {
    const local: Connection[] = [{
      id: 1, alias: 'web-prod', user: 'root', host: '10.0.0.1', key_path: '/keys/mine',
      link: { source: 'lazybackup', id: 'srv1', name: 'Web Prod', auth: 'key', localKey: true },
    }];
    const { next, report } = planSync(local, { servers: [server()], keys: [] }, opts);
    expect(next[0]?.key_path).toBe('/keys/mine');
    expect(report.unchanged).toBe(1);
  });

  test('removes linked connections deleted in lazybackup, never local ones', () => {
    const local: Connection[] = [
      { id: 1, alias: 'gone', user: 'u', host: 'h', link: { source: 'lazybackup', id: 'old' } },
      { id: 2, alias: 'mine', user: 'u', host: 'h' },
    ];
    const { next, report } = planSync(local, { servers: [], keys: [] }, opts);
    expect(report.removed).toEqual(['gone']);
    expect(next.map(c => c.alias)).toEqual(['mine']);
  });

  test('adopts a local connection with the same alias and target', () => {
    const local: Connection[] = [{ id: 3, alias: 'web-prod', user: 'root', host: '10.0.0.1', port: '22', remote_path: '/x', lastUsed: 9 }];
    const { next, report } = planSync(local, { servers: [server()], keys: [] }, opts);
    expect(report.adopted).toEqual(['web-prod']);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 3, remote_path: '/x', lastUsed: 9, link: { id: 'srv1' } });
  });

  test('reports a conflict instead of clobbering a different local target', () => {
    const local: Connection[] = [{ id: 3, alias: 'web-prod', user: 'deploy', host: 'elsewhere' }];
    const { next, report } = planSync(local, { servers: [server()], keys: [] }, opts);
    expect(report.conflicts).toHaveLength(1);
    expect(next).toEqual(local);
  });

  test('disambiguates duplicate names deterministically', () => {
    const servers = [server({ id: 'b', name: 'db' }), server({ id: 'a', name: 'db' })];
    const { next } = planSync([], { servers, keys: [] }, opts);
    expect(next.map(c => [c.link?.id, c.alias])).toEqual([['a', 'db'], ['b', 'db-2']]);
  });

  test('resolves vault keys by path and warns about pasted or password auth', () => {
    const keyFile = path.join(home, '.ssh', 'vault_key');
    const { next, report } = planSync([], {
      servers: [
        server({ id: 'v', name: 'vault', systemKeyPath: null, sshKeyId: 'k1' }),
        server({ id: 'p', name: 'pasted', systemKeyPath: null, hasPrivateKey: true }),
        server({ id: 'w', name: 'pw', systemKeyPath: null, authType: 'password' }),
      ],
      keys: [{ id: 'k1', privateKeyPath: '/root/.ssh/vault_key' }],
    }, { url: 'x', exists: onlyFiles(keyFile) });
    expect(next.find(c => c.alias === 'vault')?.key_path).toBe(keyFile);
    expect(report.warnings.map(w => [w.alias, w.kind])).toEqual([['pasted', 'inline_key'], ['pw', 'password_auth']]);
  });
});

describe('vault key mapping', () => {
  const vaultServer = server({ id: 'v', name: 'vault', systemKeyPath: null, sshKeyId: 'k1' });

  test('a mapped vault key applies to every server using it', () => {
    const keyFile = path.join(home, '.ssh', 'mine');
    const { next, report } = planSync([], {
      servers: [vaultServer, server({ id: 'v2', name: 'vault2', systemKeyPath: null, sshKeyId: 'k1' })],
      keys: [{ id: 'k1', name: 'LazyBackup', hasPrivateKeyContent: true }],
    }, { url: 'x', vaultKeys: { k1: '~/.ssh/mine' }, exists: onlyFiles(keyFile) });
    expect(next.map(c => c.key_path)).toEqual([keyFile, keyFile]);
    expect(report.warnings).toEqual([]);
  });

  test('warns when the mapped file is missing, and names unmapped keys', () => {
    const missing = planSync([], { servers: [vaultServer], keys: [] }, { url: 'x', vaultKeys: { k1: '/nope' }, exists: noFiles });
    expect(missing.report.warnings[0]?.kind).toBe('missing_key');
    const unmapped = planSync([], { servers: [vaultServer], keys: [{ id: 'k1', name: 'LazyBackup' }] }, { url: 'x', exists: noFiles });
    expect(unmapped.report.warnings[0]).toMatchObject({ kind: 'vault_key' });
    expect(unmapped.report.warnings[0]?.message).toContain('sshya link key k1');
  });
});

describe('linked connection guards', () => {
  beforeEach(() => {
    replaceConnections([{ id: 1, alias: 'web', user: 'root', host: 'h', link: { source: 'lazybackup', id: 'srv1' } }]);
  });

  test('refuses removal and target edits', () => {
    expect(() => removeConnection('web')).toThrow(LinkedConnectionError);
    expect(() => updateConnection('web', 'root', 'other')).toThrow(LinkedConnectionError);
    expect(() => updateConnection('web', 'root', 'h', undefined, undefined, undefined, 'renamed')).toThrow(LinkedConnectionError);
  });

  test('allows local overlay edits and marks a local key', () => {
    updateConnection('web', 'root', 'h', '/keys/k', undefined, '/srv', undefined, true);
    expect(getConnectionByAlias('web')).toMatchObject({
      key_path: '/keys/k', remote_path: '/srv', readonly: true, link: { localKey: true },
    });
    updateConnection('web', 'root', 'h', '', undefined, '/srv');
    expect(getConnectionByAlias('web')?.link?.localKey).toBeUndefined();
  });
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('fetchLazybackupSnapshot', () => {
  test('sends bearer and Cloudflare Access headers', async () => {
    const seen: Array<[string, Record<string, string>]> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push([url, init?.headers as Record<string, string>]);
      return jsonResponse([server()]);
    };
    const snapshot = await fetchLazybackupSnapshot(
      { url: 'https://lb.test', token: 'tok', cfAccessClientId: 'cid', cfAccessClientSecret: 'sec' },
      { fetchImpl },
    );
    expect(snapshot.servers).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('https://lb.test/api/servers');
    expect(seen[0]?.[1]).toMatchObject({ authorization: 'Bearer tok', 'CF-Access-Client-Id': 'cid', 'CF-Access-Client-Secret': 'sec' });
  });

  test('classifies a Cloudflare Access redirect', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: 'https://me.cloudflareaccess.com/cdn-cgi/access/login' } });
    const err = await fetchLazybackupSnapshot({ url: 'https://lb.test' }, { fetchImpl }).catch(e => e);
    expect(err).toBeInstanceOf(LinkFetchError);
    expect(err.errorKind).toBe('link_access_blocked');
  });

  test('classifies a lazybackup 401', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    const err = await fetchLazybackupSnapshot({ url: 'https://lb.test' }, { fetchImpl }).catch(e => e);
    expect(err.errorKind).toBe('link_unauthorized');
  });
});

describe('syncLink / autoSync', () => {
  test('writes the store, records state, and respects the TTL', async () => {
    saveLinkConfig({ url: 'https://lb.test/', token: 'tok' });
    expect(fs.statSync(path.join(tempDir, 'link.json')).mode & 0o777).toBe(0o600);
    expect(loadLinkConfig()?.url).toBe('https://lb.test');

    addConnection('mine', 'u', 'h');
    let calls = 0;
    const fetchImpl: FetchLike = async url => {
      if (!url.endsWith('/api/servers')) return jsonResponse({ ok: true, status: 'added' });
      calls++;
      return jsonResponse([server()]);
    };

    const report = await syncLink({ fetchImpl });
    expect(report.added).toEqual(['web-prod']);
    expect(getConnections().map(c => c.alias)).toEqual(['mine', 'web-prod']);
    expect(readLinkState().lastSyncAt).toBeNumber();

    expect(await autoSync({ fetchImpl })).toBeUndefined();
    expect(calls).toBe(1);
  });

  test('autoSync swallows failures and backs off', async () => {
    saveLinkConfig({ url: 'https://lb.test', ttlSeconds: 1 });
    let calls = 0;
    const errors: unknown[] = [];
    const fetchImpl: FetchLike = async () => {
      calls++;
      throw new Error('offline');
    };
    expect(await autoSync({ fetchImpl, onError: e => errors.push(e) })).toBeUndefined();
    expect(await autoSync({ fetchImpl, onError: e => errors.push(e) })).toBeUndefined();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(readLinkState().lastError).toContain('offline');
  });

  test('SSHYA_LINK_AUTO=0 disables auto-sync', async () => {
    saveLinkConfig({ url: 'https://lb.test' });
    process.env.SSHYA_LINK_AUTO = '0';
    let calls = 0;
    await autoSync({ fetchImpl: async () => { calls++; return jsonResponse([]); } });
    expect(calls).toBe(0);
  });
});

describe('device key', () => {
  test('is generated once next to the store, 0600, with a matching fingerprint', () => {
    const key = ensureDeviceKey();
    expect(key.path).toBe(path.join(tempDir, 'keys', 'id_ed25519'));
    expect(getDeviceKeyPath()).toBe(key.path);
    expect(fs.statSync(key.path).mode & 0o777).toBe(0o600);
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ sshya(@[A-Za-z0-9._-]+)?$/);
    const expected = execFileSync('ssh-keygen', ['-lf', `${key.path}.pub`], { encoding: 'utf8' }).split(' ')[1]!;
    expect(key.fingerprint).toBe(expected);
    expect(publicKeyFingerprint(key.publicKey)).toBe(expected);
    expect(ensureDeviceKey()).toEqual(key);
  });
});

describe('planSync with the device key', () => {
  const vault = server({ id: 'v', name: 'vault', systemKeyPath: null, sshKeyId: 'k1' });
  const snapshot = { servers: [vault], keys: [{ id: 'k1', name: 'LazyBackup' }] };
  const deviceKey = { path: '/state/keys/id_ed25519', fingerprint: 'SHA256:dev' };

  test('queues servers without a local key and keeps the warning', () => {
    const { next, report, pending } = planSync([], snapshot, { url: 'x', exists: noFiles, deviceKey });
    expect(pending).toEqual([{ serverId: 'v', alias: 'vault', name: 'vault' }]);
    expect(next[0]?.key_path).toBeUndefined();
    expect(report.warnings[0]?.kind).toBe('vault_key');
  });

  test('uses the device key once authorized, and remembers it', () => {
    const first = planSync([], snapshot, { url: 'x', exists: noFiles, deviceKey, authorizedIds: new Set(['v']) });
    expect(first.pending).toEqual([]);
    expect(first.report.warnings).toEqual([]);
    expect(first.next[0]).toMatchObject({ key_path: deviceKey.path, link: { deviceKey: 'SHA256:dev' } });

    const again = planSync(first.next, snapshot, { url: 'x', exists: noFiles, deviceKey });
    expect(again.pending).toEqual([]);
    expect(again.report.unchanged).toBe(1);
  });

  test('a mapped or local key wins and nothing is queued', () => {
    const keyFile = path.join(home, '.ssh', 'mine');
    const mapped = planSync([], snapshot, { url: 'x', vaultKeys: { k1: keyFile }, exists: onlyFiles(keyFile), deviceKey });
    expect(mapped.pending).toEqual([]);
    expect(mapped.next[0]?.key_path).toBe(keyFile);

    const local: Connection[] = [{
      id: 1, alias: 'vault', user: 'root', host: '10.0.0.1', key_path: '/keys/mine',
      link: { source: 'lazybackup', id: 'v', localKey: true },
    }];
    expect(planSync(local, snapshot, { url: 'x', exists: noFiles, deviceKey }).pending).toEqual([]);
  });

  test('a regenerated device key is queued again', () => {
    const local: Connection[] = [{
      id: 1, alias: 'vault', user: 'root', host: '10.0.0.1', key_path: '/old/key',
      link: { source: 'lazybackup', id: 'v', deviceKey: 'SHA256:old' },
    }];
    const { pending } = planSync(local, snapshot, { url: 'x', exists: noFiles, deviceKey });
    expect(pending.map(item => item.serverId)).toEqual(['v']);
  });

  test('password servers are never queued', () => {
    const { pending } = planSync([], { servers: [server({ authType: 'password', systemKeyPath: null })], keys: [] }, { url: 'x', exists: noFiles, deviceKey });
    expect(pending).toEqual([]);
  });
});

describe('syncLink key authorization', () => {
  const vaultServers = [
    server({ id: 'v1', name: 'vault one', systemKeyPath: null, sshKeyId: 'k1' }),
    server({ id: 'v2', name: 'vault two', systemKeyPath: null, sshKeyId: 'k1' }),
  ];

  const lazybackup = (authorize: (id: string, body: { publicKey: string }, method: string) => Response) => {
    const calls: Array<{ url: string; method: string; body?: { publicKey: string } }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/servers')) return jsonResponse(vaultServers);
      if (url.endsWith('/api/ssh-keys')) return jsonResponse({ storedKeys: [{ id: 'k1', name: 'LazyBackup' }] });
      const match = url.match(/\/api\/servers\/([^/]+)\/authorize-key$/);
      if (match) return authorize(decodeURIComponent(match[1]!), body, method);
      return new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    };
    return { fetchImpl, calls, authorizeCalls: () => calls.filter(call => call.url.includes('/authorize-key')) };
  };

  test('generates the device key, has lazybackup install it, and uses it', async () => {
    saveLinkConfig({ url: 'https://lb.test', token: 'tok' });
    const lb = lazybackup(() => jsonResponse({ ok: true, status: 'added' }));
    const report = await syncLink({ fetchImpl: lb.fetchImpl });

    const key = readDeviceKey();
    expect(key).toBeDefined();
    expect(report.authorized).toEqual(['vault-one', 'vault-two']);
    expect(report.warnings).toEqual([]);
    expect(lb.authorizeCalls().map(call => [call.method, call.body?.publicKey])).toEqual([
      ['POST', key!.publicKey],
      ['POST', key!.publicKey],
    ]);
    expect(getConnections().map(c => [c.alias, c.key_path, c.link?.deviceKey])).toEqual([
      ['vault-one', key!.path, key!.fingerprint],
      ['vault-two', key!.path, key!.fingerprint],
    ]);

    // Already authorized: the next sync makes no authorize calls.
    const before = lb.authorizeCalls().length;
    const second = await syncLink({ fetchImpl: lb.fetchImpl });
    expect(second.authorized).toEqual([]);
    expect(second.unchanged).toBe(2);
    expect(lb.authorizeCalls().length).toBe(before);
  });

  test('a token without authorize_keys fails once, warns, and auto-sync backs off', async () => {
    saveLinkConfig({ url: 'https://lb.test', token: 'tok', ttlSeconds: 1 });
    const lb = lazybackup(() => jsonResponse({ error: 'API token lacks authorize_keys permission.' }, { status: 403 }));
    const report = await syncLink({ fetchImpl: lb.fetchImpl });

    // The first forbidden answer stops the rest.
    expect(lb.authorizeCalls().length).toBeLessThanOrEqual(2);
    expect(report.authorized).toEqual([]);
    expect(report.warnings.map(w => [w.alias, w.kind, w.errorKind])).toEqual([
      ['vault-one', 'authorize_failed', 'link_forbidden'],
      ['vault-two', 'authorize_failed', 'link_forbidden'],
    ]);
    expect(report.warnings[0]?.message).toContain('Allow authorizing SSH keys');
    expect(Object.keys(readLinkState().authorizeFailures ?? {}).sort()).toEqual(['v1', 'v2']);
    expect(getConnections().every(c => c.key_path === undefined)).toBe(true);

    // Auto-sync within the backoff window does not retry; an explicit sync does.
    const calls = lb.authorizeCalls().length;
    const state = readLinkState();
    fs.writeFileSync(path.join(tempDir, 'link-state.json'), JSON.stringify({ ...state, lastSyncAt: 0 }));
    expect(await autoSync({ fetchImpl: lb.fetchImpl })).toBeDefined();
    expect(lb.authorizeCalls().length).toBe(calls);
    await syncLink({ fetchImpl: lb.fetchImpl });
    expect(lb.authorizeCalls().length).toBeGreaterThan(calls);
  });

  test('an old lazybackup that blocks read_only tokens is reported as unsupported', async () => {
    saveLinkConfig({ url: 'https://lb.test', token: 'tok' });
    const lb = lazybackup(() => jsonResponse({ error: 'API token is read_only' }, { status: 403 }));
    const report = await syncLink({ fetchImpl: lb.fetchImpl });
    expect(report.warnings[0]).toMatchObject({ kind: 'authorize_failed', errorKind: 'link_unsupported' });
  });

  test('one unreachable server does not block the others', async () => {
    saveLinkConfig({ url: 'https://lb.test', token: 'tok' });
    const lb = lazybackup(id => id === 'v1'
      ? jsonResponse({ error: 'Could not update authorized_keys on vault one: connect ETIMEDOUT' }, { status: 502 })
      : jsonResponse({ ok: true, status: 'present' }));
    const report = await syncLink({ fetchImpl: lb.fetchImpl });
    expect(report.authorized).toEqual(['vault-two']);
    expect(report.warnings).toMatchObject([{ alias: 'vault-one', kind: 'authorize_failed', errorKind: 'link_authorize_failed' }]);
    expect(report.warnings[0]?.message).toContain('ETIMEDOUT');
  });

  test('authorizeKeys: false and SSHYA_LINK_AUTHORIZE=0 make no requests', async () => {
    saveLinkConfig({ url: 'https://lb.test', token: 'tok', authorizeKeys: false });
    const lb = lazybackup(() => jsonResponse({ ok: true, status: 'added' }));
    await syncLink({ fetchImpl: lb.fetchImpl });
    expect(lb.authorizeCalls()).toEqual([]);
    expect(readDeviceKey()).toBeUndefined();

    saveLinkConfig({ url: 'https://lb.test', token: 'tok' });
    process.env.SSHYA_LINK_AUTHORIZE = '0';
    await syncLink({ fetchImpl: lb.fetchImpl });
    expect(lb.authorizeCalls()).toEqual([]);
  });
});
