import fs from 'fs';
import { expandHomePath, getConnections, replaceConnections, type Connection, type ConnectionLink } from '../database';
import {
  DEFAULT_KEY_MAP,
  loadLinkConfig,
  readLinkState,
  resolveLocalKeyPath,
  writeLinkState,
  type KeyMapEntry,
  type LinkConfig,
} from './config';
import { ensureDeviceKey, readDeviceKey, type DeviceKey } from './deviceKey';
import {
  fetchLazybackupSnapshot,
  LinkFetchError,
  updateAuthorizedKey,
  type FetchLike,
  type LazybackupServer,
  type LazybackupSnapshot,
} from './lazybackup';

export interface SyncWarning {
  alias: string;
  kind: 'missing_key' | 'vault_key' | 'inline_key' | 'password_auth' | 'authorize_failed';
  message: string;
  errorKind?: string;
}

/** A key-auth server with no usable local key: lazybackup can install ours. */
export interface PendingAuthorization {
  serverId: string;
  alias: string;
  name: string;
}

export interface SyncConflict {
  alias: string;
  name: string;
  reason: string;
}

export interface SyncReport {
  ok: true;
  url: string;
  total: number;
  added: string[];
  updated: string[];
  removed: string[];
  adopted: string[];
  unchanged: number;
  conflicts: SyncConflict[];
  warnings: SyncWarning[];
  /** Aliases where lazybackup just installed this machine's sshya key. */
  authorized: string[];
}

/** lazybackup server names are free text; aliases should be shell-friendly. */
export const aliasFromName = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'server';
};

const portString = (port?: number | null): string | undefined =>
  port && port !== 22 ? String(port) : undefined;

const sameTarget = (a: Pick<Connection, 'user' | 'host' | 'port'>, b: Pick<Connection, 'user' | 'host' | 'port'>): boolean =>
  a.user === b.user && a.host === b.host && (a.port ?? '22') === (b.port ?? '22');

interface Desired {
  server: LazybackupServer;
  alias: string;
  user: string;
  host: string;
  port?: string;
  keyPath?: string;
  warning?: SyncWarning;
  /** No local key resolved for a key-auth server. */
  needsDeviceKey: boolean;
}

const describeKey = (
  server: LazybackupServer,
  alias: string,
  snapshot: LazybackupSnapshot,
  keyMap: KeyMapEntry[],
  exists: (file: string) => boolean = fs.existsSync,
  vaultKeys: Record<string, string> = {},
): { keyPath?: string; warning?: SyncWarning } => {
  if (server.authType === 'password') {
    return {
      warning: {
        alias,
        kind: 'password_auth',
        message: 'Uses password auth in lazybackup: interactive connect prompts for it, `run` needs --allow-password.',
      },
    };
  }
  const mapped = server.sshKeyId ? vaultKeys[server.sshKeyId] : undefined;
  if (mapped) {
    const keyPath = expandHomePath(mapped) ?? mapped;
    if (exists(keyPath)) {
      return { keyPath };
    }
    return {
      warning: {
        alias,
        kind: 'missing_key',
        message: `Mapped key ${mapped} does not exist on this machine; fix it with \`sshya link key ${server.sshKeyId} <path>\`.`,
      },
    };
  }
  const remoteKeyPath = server.systemKeyPath
    || (server.sshKeyId ? snapshot.keys.find(key => key.id === server.sshKeyId)?.privateKeyPath ?? undefined : undefined);
  if (remoteKeyPath) {
    const keyPath = resolveLocalKeyPath(remoteKeyPath, keyMap, exists);
    return keyPath
      ? { keyPath }
      : {
          warning: {
            alias,
            kind: 'missing_key',
            message: `Key ${remoteKeyPath} has no local match; ssh falls back to your agent/default keys. Set one with \`sshya update ${alias} --key <path>\`.`,
          },
        };
  }
  if (server.sshKeyId) {
    return {
      warning: {
        alias,
        kind: 'vault_key',
        message: `Key "${snapshot.keys.find(key => key.id === server.sshKeyId)?.name ?? server.sshKeyId}" is stored inside lazybackup and is never exported; map it once with \`sshya link key ${server.sshKeyId} <path>\` (or use your ssh-agent).`,
      },
    };
  }
  return {
    warning: {
      alias,
      kind: 'inline_key',
      message: `Key was pasted into lazybackup and is never exported; run \`sshya update ${alias} --key <path>\` or use your ssh-agent.`,
    },
  };
};

/**
 * Compute the next local store from the current one plus a lazybackup
 * snapshot. Pure apart from the `exists` probe, so it is easy to test.
 *
 * - Linked connections (matched by lazybackup id) follow the web: alias,
 *   user, host, port, and (unless overridden locally) key_path.
 * - A local, unlinked connection with the same alias and target is adopted
 *   (keeps lastUsed/remote_path/readonly/key_path).
 * - A local, unlinked connection with the same alias but another target is a
 *   conflict: it is left alone and the server is skipped.
 * - Linked connections that disappeared from lazybackup are removed.
 * - A key-auth server without a usable local key uses this machine's device
 *   key once lazybackup installed it (`link.deviceKey` matches, or the id is
 *   in `authorizedIds`); otherwise it is returned in `pending`.
 */
export const planSync = (
  local: Connection[],
  snapshot: LazybackupSnapshot,
  options: {
    url: string;
    keyMap?: KeyMapEntry[];
    vaultKeys?: Record<string, string>;
    exists?: (file: string) => boolean;
    deviceKey?: Pick<DeviceKey, 'path' | 'fingerprint'>;
    authorizedIds?: ReadonlySet<string>;
  },
): { next: Connection[]; report: SyncReport; pending: PendingAuthorization[] } => {
  const keyMap = options.keyMap ?? DEFAULT_KEY_MAP;
  const report: SyncReport = {
    ok: true,
    url: options.url,
    total: snapshot.servers.length,
    added: [],
    updated: [],
    removed: [],
    adopted: [],
    unchanged: 0,
    conflicts: [],
    warnings: [],
    authorized: [],
  };
  const pending: PendingAuthorization[] = [];
  const deviceKey = options.deviceKey;

  /**
   * Key for a server given the fingerprint recorded on its link. Queues the
   * server for authorization when only the device key could reach it.
   */
  const resolveKey = (want: Desired, recorded: string | undefined, alias: string, queue: boolean) => {
    const fingerprint = deviceKey && options.authorizedIds?.has(want.server.id) ? deviceKey.fingerprint : recorded;
    if (!want.needsDeviceKey) {
      return { keyPath: want.keyPath, warning: want.warning, fingerprint };
    }
    if (deviceKey && fingerprint === deviceKey.fingerprint) {
      return { keyPath: deviceKey.path, warning: undefined, fingerprint };
    }
    if (queue) {
      pending.push({ serverId: want.server.id, alias, name: want.server.name });
    }
    return { keyPath: undefined, warning: want.warning, fingerprint };
  };

  // Stable alias per server: sort by id so duplicate names get the same suffix every time.
  const usedRemoteAliases = new Set<string>();
  const desired: Desired[] = [...snapshot.servers]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(server => {
      const base = aliasFromName(server.name);
      let alias = base;
      for (let n = 2; usedRemoteAliases.has(alias); n++) {
        alias = `${base}-${n}`;
      }
      usedRemoteAliases.add(alias);
      const { keyPath, warning } = describeKey(server, alias, snapshot, keyMap, options.exists, options.vaultKeys);
      return {
        server,
        alias,
        user: server.username.trim(),
        host: server.host.trim(),
        port: portString(server.port),
        keyPath,
        warning,
        needsDeviceKey: !keyPath && server.authType === 'key',
      };
    });

  const remoteIds = new Set(snapshot.servers.map(server => server.id));
  const next: Connection[] = [];
  for (const connection of local) {
    if (connection.link && !remoteIds.has(connection.link.id)) {
      report.removed.push(connection.alias);
      continue;
    }
    next.push({ ...connection, ...(connection.link ? { link: { ...connection.link } } : {}) });
  }

  const byLinkId = new Map(next.filter(c => c.link).map(c => [c.link!.id, c]));
  let nextId = next.reduce((max, c) => Math.max(max, c.id), 0) + 1;

  // Process already-linked servers first so their aliases are claimed before
  // new servers are checked for conflicts.
  const ordered = [
    ...desired.filter(d => byLinkId.has(d.server.id)),
    ...desired.filter(d => !byLinkId.has(d.server.id)),
  ];

  for (const want of ordered) {
    const baseLink: ConnectionLink = {
      source: 'lazybackup',
      id: want.server.id,
      name: want.server.name,
      auth: want.server.authType,
    };
    const withDevice = (fingerprint: string | undefined): ConnectionLink =>
      fingerprint ? { ...baseLink, deviceKey: fingerprint } : baseLink;
    const existing = byLinkId.get(want.server.id);
    const aliasHolder = next.find(c => c.alias === want.alias && c !== existing);

    if (existing) {
      let alias = want.alias;
      if (aliasHolder) {
        // Renamed in the web onto an alias taken locally: keep the old alias.
        report.conflicts.push({ alias: want.alias, name: want.server.name, reason: `alias already used by a local connection; kept "${existing.alias}"` });
        alias = existing.alias;
      }
      const localKey = existing.link?.localKey === true;
      const resolved = resolveKey(want, existing.link?.deviceKey, alias, !localKey);
      const before = JSON.stringify(existing);
      existing.alias = alias;
      existing.user = want.user;
      existing.host = want.host;
      existing.port = want.port;
      existing.key_path = localKey ? existing.key_path : resolved.keyPath;
      existing.link = { ...withDevice(resolved.fingerprint), ...(localKey ? { localKey: true } : {}) };
      if (JSON.stringify(existing) === before) {
        report.unchanged++;
      } else {
        report.updated.push(alias);
      }
      if (resolved.warning && !localKey) {
        report.warnings.push({ ...resolved.warning, alias });
      }
      continue;
    }

    if (aliasHolder) {
      if (!aliasHolder.link && sameTarget(aliasHolder, want)) {
        // Same server already stored locally: adopt it and keep local extras.
        const resolved = resolveKey(want, undefined, want.alias, !aliasHolder.key_path);
        const keepLocalKey = Boolean(aliasHolder.key_path) && aliasHolder.key_path !== resolved.keyPath;
        aliasHolder.key_path = keepLocalKey ? aliasHolder.key_path : resolved.keyPath;
        aliasHolder.port = want.port;
        aliasHolder.link = { ...withDevice(resolved.fingerprint), ...(keepLocalKey ? { localKey: true } : {}) };
        report.adopted.push(want.alias);
        if (resolved.warning && !keepLocalKey) {
          report.warnings.push(resolved.warning);
        }
        continue;
      }
      report.conflicts.push({
        alias: want.alias,
        name: want.server.name,
        reason: aliasHolder.link
          ? 'alias already used by another linked server'
          : `a local connection with this alias points to ${aliasHolder.user}@${aliasHolder.host}; rename or remove it to sync this server`,
      });
      continue;
    }

    const resolved = resolveKey(want, undefined, want.alias, true);
    next.push({
      id: nextId++,
      alias: want.alias,
      user: want.user,
      host: want.host,
      port: want.port,
      key_path: resolved.keyPath,
      link: withDevice(resolved.fingerprint),
    });
    report.added.push(want.alias);
    if (resolved.warning) {
      report.warnings.push(resolved.warning);
    }
  }

  return { next, report, pending };
};

export interface SyncOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  config?: LinkConfig;
  /**
   * `all` (explicit sync) tries every pending server; `auto` skips servers
   * that failed within the last hour and caps the time spent; `off` skips it.
   */
  authorize?: 'all' | 'auto' | 'off';
  /** Test hook: use this key instead of the one next to the store. */
  deviceKey?: DeviceKey;
}

/** After a failed authorization, auto-sync leaves that server alone this long. */
const AUTHORIZE_BACKOFF_MS = 60 * 60_000;
const AUTHORIZE_TIMEOUT_MS = 45_000;
const AUTO_AUTHORIZE_BUDGET_MS = 10_000;
const AUTHORIZE_CONCURRENCY = 4;

interface AuthorizeOutcome {
  ok: Set<string>;
  failed: Map<string, Error>;
}

/**
 * Ask lazybackup to install the device key on each pending server. A missing
 * permission or an old lazybackup fails every server the same way, so the
 * first such error stops further requests.
 */
const authorizeServers = async (
  config: LinkConfig,
  pending: PendingAuthorization[],
  deviceKey: DeviceKey,
  options: { budgetMs?: number; fetchImpl?: FetchLike },
): Promise<AuthorizeOutcome> => {
  const outcome: AuthorizeOutcome = { ok: new Set(), failed: new Map() };
  const deadline = options.budgetMs ? Date.now() + options.budgetMs : undefined;
  let fatal: Error | undefined;
  const queue = [...pending];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const remaining = deadline ? deadline - Date.now() : AUTHORIZE_TIMEOUT_MS;
      if (fatal || remaining <= 0) {
        outcome.failed.set(item.serverId, fatal ?? new Error('Skipped: auto-sync ran out of time; `sshya sync` retries it.'));
        continue;
      }
      try {
        await updateAuthorizedKey(config, item.serverId, deviceKey.publicKey, 'authorize', {
          timeoutMs: Math.min(remaining, AUTHORIZE_TIMEOUT_MS),
          fetchImpl: options.fetchImpl,
        });
        outcome.ok.add(item.serverId);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (err instanceof LinkFetchError && ['link_forbidden', 'link_unsupported', 'link_unauthorized', 'link_access_blocked'].includes(err.errorKind)) {
          fatal = error;
        }
        outcome.failed.set(item.serverId, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AUTHORIZE_CONCURRENCY, pending.length) }, worker));
  return outcome;
};

const authorizeWarning = (alias: string, err: Error): SyncWarning => {
  const hint = err instanceof LinkFetchError && err.hint ? ` ${err.hint}` : '';
  return {
    alias,
    kind: 'authorize_failed',
    message: `lazybackup could not install this machine's sshya key: ${err.message}${hint}`,
    ...(err instanceof LinkFetchError ? { errorKind: err.errorKind } : {}),
  };
};

/** Fetch from lazybackup and rewrite the local store. Throws LinkFetchError. */
export const syncLink = async (options: SyncOptions = {}): Promise<SyncReport> => {
  const config = options.config ?? loadLinkConfig();
  if (!config) {
    throw new LinkFetchError('No lazybackup link configured.', 'link_unreachable', 'Run `sshya link set <url> --token <token>` first.');
  }
  const attemptAt = Date.now();
  try {
    const snapshot = await fetchLazybackupSnapshot(config, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl });
    const local = getConnections();
    const planOptions = { url: config.url, keyMap: config.keyMap, vaultKeys: config.vaultKeys };
    let deviceKey = options.deviceKey ?? readDeviceKey();
    let { next, report, pending } = planSync(local, snapshot, { ...planOptions, deviceKey });

    const pendingIds = new Set(pending.map(item => item.serverId));
    const failures = Object.fromEntries(
      Object.entries(readLinkState().authorizeFailures ?? {}).filter(([id]) => pendingIds.has(id)),
    );
    const mode = options.authorize ?? 'all';
    if (mode !== 'off' && config.authorizeKeys !== false && pending.length > 0) {
      const now = Date.now();
      const due = mode === 'auto'
        ? pending.filter(item => !failures[item.serverId] || now - failures[item.serverId]!.at >= AUTHORIZE_BACKOFF_MS)
        : pending;
      if (due.length > 0) {
        let outcome: AuthorizeOutcome;
        try {
          deviceKey = deviceKey ?? ensureDeviceKey();
          outcome = await authorizeServers(config, due, deviceKey, {
            budgetMs: mode === 'auto' ? AUTO_AUTHORIZE_BUDGET_MS : undefined,
            fetchImpl: options.fetchImpl,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          outcome = { ok: new Set(), failed: new Map(due.map(item => [item.serverId, error])) };
        }
        if (outcome.ok.size > 0) {
          ({ next, report } = planSync(local, snapshot, { ...planOptions, deviceKey, authorizedIds: outcome.ok }));
        }
        const at = Date.now();
        for (const item of due) {
          const error = outcome.failed.get(item.serverId);
          if (outcome.ok.has(item.serverId)) {
            report.authorized.push(item.alias);
            delete failures[item.serverId];
          } else if (error) {
            failures[item.serverId] = { at, error: error.message };
            report.warnings = report.warnings.map(warning =>
              warning.alias === item.alias ? authorizeWarning(item.alias, error) : warning,
            );
          }
        }
      }
    }

    const changed = report.added.length + report.updated.length + report.removed.length + report.adopted.length > 0;
    if (changed) {
      replaceConnections(next);
    }
    writeLinkState({
      lastSyncAt: Date.now(),
      lastAttemptAt: attemptAt,
      ...(Object.keys(failures).length > 0 ? { authorizeFailures: failures } : {}),
    });
    return report;
  } catch (err) {
    const previous = readLinkState();
    writeLinkState({
      ...previous,
      lastAttemptAt: attemptAt,
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};

/** After a failed attempt, wait this long before auto-sync tries again. */
const FAILURE_BACKOFF_MS = 60_000;
const AUTO_SYNC_TIMEOUT_MS = 3_000;

const autoSyncDisabled = (): boolean => {
  const value = process.env.SSHYA_LINK_AUTO?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'no';
};

/**
 * Best-effort refresh before commands that read connections. Never throws:
 * when lazybackup is unreachable the cached store keeps working.
 * Returns the report when a sync actually ran.
 */
export const autoSync = async (options: { onError?: (err: unknown) => void; fetchImpl?: FetchLike } = {}): Promise<SyncReport | undefined> => {
  if (autoSyncDisabled()) {
    return undefined;
  }
  const config = loadLinkConfig();
  if (!config || !config.ttlSeconds) {
    return undefined;
  }
  const state = readLinkState();
  const now = Date.now();
  if (state.lastSyncAt && now - state.lastSyncAt < config.ttlSeconds * 1000) {
    return undefined;
  }
  if (state.lastError && state.lastAttemptAt && now - state.lastAttemptAt < FAILURE_BACKOFF_MS) {
    return undefined;
  }
  try {
    return await syncLink({ config, timeoutMs: AUTO_SYNC_TIMEOUT_MS, fetchImpl: options.fetchImpl, authorize: 'auto' });
  } catch (err) {
    options.onError?.(err);
    return undefined;
  }
};
