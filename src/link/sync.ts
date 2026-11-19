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
import {
  fetchLazybackupSnapshot,
  LinkFetchError,
  type FetchLike,
  type LazybackupServer,
  type LazybackupSnapshot,
} from './lazybackup';

export interface SyncWarning {
  alias: string;
  kind: 'missing_key' | 'vault_key' | 'inline_key' | 'password_auth';
  message: string;
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
 */
export const planSync = (
  local: Connection[],
  snapshot: LazybackupSnapshot,
  options: {
    url: string;
    keyMap?: KeyMapEntry[];
    vaultKeys?: Record<string, string>;
    exists?: (file: string) => boolean;
  },
): { next: Connection[]; report: SyncReport } => {
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
    const link: ConnectionLink = {
      source: 'lazybackup',
      id: want.server.id,
      name: want.server.name,
      auth: want.server.authType,
    };
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
      const keyPath = localKey ? existing.key_path : want.keyPath;
      const before = JSON.stringify(existing);
      existing.alias = alias;
      existing.user = want.user;
      existing.host = want.host;
      existing.port = want.port;
      existing.key_path = keyPath;
      existing.link = { ...link, ...(localKey ? { localKey: true } : {}) };
      if (JSON.stringify(existing) === before) {
        report.unchanged++;
      } else {
        report.updated.push(alias);
      }
      if (want.warning && !localKey) {
        report.warnings.push({ ...want.warning, alias });
      }
      continue;
    }

    if (aliasHolder) {
      if (!aliasHolder.link && sameTarget(aliasHolder, want)) {
        // Same server already stored locally: adopt it and keep local extras.
        const keepLocalKey = Boolean(aliasHolder.key_path) && aliasHolder.key_path !== want.keyPath;
        aliasHolder.key_path = keepLocalKey ? aliasHolder.key_path : want.keyPath;
        aliasHolder.port = want.port;
        aliasHolder.link = { ...link, ...(keepLocalKey ? { localKey: true } : {}) };
        report.adopted.push(want.alias);
        if (want.warning && !keepLocalKey) {
          report.warnings.push(want.warning);
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

    next.push({
      id: nextId++,
      alias: want.alias,
      user: want.user,
      host: want.host,
      port: want.port,
      key_path: want.keyPath,
      link,
    });
    report.added.push(want.alias);
    if (want.warning) {
      report.warnings.push(want.warning);
    }
  }

  return { next, report };
};

export interface SyncOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  config?: LinkConfig;
}

/** Fetch from lazybackup and rewrite the local store. Throws LinkFetchError. */
export const syncLink = async (options: SyncOptions = {}): Promise<SyncReport> => {
  const config = options.config ?? loadLinkConfig();
  if (!config) {
    throw new LinkFetchError('No lazybackup link configured.', 'link_unreachable', 'Run `sshya link set <url> --token <token>` first.');
  }
  const attemptAt = Date.now();
  try {
    const snapshot = await fetchLazybackupSnapshot(config, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl });
    const { next, report } = planSync(getConnections(), snapshot, { url: config.url, keyMap: config.keyMap, vaultKeys: config.vaultKeys });
    const changed = report.added.length + report.updated.length + report.removed.length + report.adopted.length > 0;
    if (changed) {
      replaceConnections(next);
    }
    writeLinkState({ lastSyncAt: Date.now(), lastAttemptAt: attemptAt });
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
    return await syncLink({ config, timeoutMs: AUTO_SYNC_TIMEOUT_MS, fetchImpl: options.fetchImpl });
  } catch (err) {
    options.onError?.(err);
    return undefined;
  }
};
