import fs from 'fs';
import path from 'path';
import { expandHomePath, getDbPath } from '../database';

/**
 * Maps a key path as lazybackup sees it (inside its container) to where the
 * same key lives on this machine. The default matches lazybackup's compose
 * file, which mounts `~/.ssh` at `/root/.ssh`.
 */
export interface KeyMapEntry {
  from: string;
  to: string;
}

export interface LinkConfig {
  /** lazybackup base URL, e.g. https://backup.example.com */
  url: string;
  /** lazybackup API token (Settings → API / MCP). A read_only token is enough. */
  token?: string;
  /** Cloudflare Access service token, when the instance sits behind CF Access. */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  /** Auto-sync freshness window in seconds. 0 disables auto-sync. */
  ttlSeconds?: number;
  keyMap?: KeyMapEntry[];
  /**
   * lazybackup stored-key id → local private key path. Keys pasted into
   * lazybackup are never exported, so each machine maps them once and every
   * server using that key picks it up.
   */
  vaultKeys?: Record<string, string>;
  /**
   * When a server's key is not available locally, ask lazybackup to install
   * this machine's sshya key in its authorized_keys. Default on;
   * `SSHYA_LINK_AUTHORIZE=0` turns it off for one process.
   */
  authorizeKeys?: boolean;
}

export interface LinkState {
  lastSyncAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** lazybackup server id → last failed key authorization (auto-sync backs off). */
  authorizeFailures?: Record<string, { at: number; error: string }>;
}

export const DEFAULT_TTL_SECONDS = 300;
export const DEFAULT_KEY_MAP: KeyMapEntry[] = [{ from: '/root/.ssh', to: '~/.ssh' }];

const linkDir = (): string => path.dirname(getDbPath());
export const getLinkConfigPath = (): string => path.join(linkDir(), 'link.json');
const getLinkStatePath = (): string => path.join(linkDir(), 'link-state.json');

const readJson = <T>(file: string): T | undefined => {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
};

const writeJson = (file: string, value: unknown, mode?: number): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  if (mode) {
    // writeFileSync only applies mode on create; tighten an existing file too.
    fs.chmodSync(file, mode);
  }
};

const envString = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const envFlag = (name: string): boolean | undefined => {
  const value = envString(name)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  return !['0', 'false', 'no', 'off'].includes(value);
};

/** Stored config only (no env overrides). */
export const readStoredLinkConfig = (): LinkConfig | undefined => {
  const stored = readJson<LinkConfig>(getLinkConfigPath());
  return stored && typeof stored.url === 'string' && stored.url ? stored : undefined;
};

/**
 * Effective config: the stored file with `SSHYA_LINK_*` / `SSHYA_CF_ACCESS_*`
 * env overrides. `SSHYA_LINK_URL` alone is enough to link without a file.
 */
export const loadLinkConfig = (): LinkConfig | undefined => {
  const stored = readStoredLinkConfig();
  const url = envString('SSHYA_LINK_URL') ?? stored?.url;
  if (!url) {
    return undefined;
  }
  const ttlEnv = envString('SSHYA_LINK_TTL');
  const ttl = ttlEnv !== undefined ? Number(ttlEnv) : stored?.ttlSeconds;
  return {
    url: url.replace(/\/+$/, ''),
    token: envString('SSHYA_LINK_TOKEN') ?? stored?.token,
    cfAccessClientId: envString('SSHYA_CF_ACCESS_CLIENT_ID') ?? stored?.cfAccessClientId,
    cfAccessClientSecret: envString('SSHYA_CF_ACCESS_CLIENT_SECRET') ?? stored?.cfAccessClientSecret,
    ttlSeconds: ttl !== undefined && Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL_SECONDS,
    keyMap: Array.isArray(stored?.keyMap) && stored.keyMap.length > 0 ? stored.keyMap : DEFAULT_KEY_MAP,
    vaultKeys: stored?.vaultKeys && typeof stored.vaultKeys === 'object' ? stored.vaultKeys : undefined,
    authorizeKeys: envFlag('SSHYA_LINK_AUTHORIZE') ?? stored?.authorizeKeys !== false,
  };
};

/** The config holds secrets: always 0600. */
export const saveLinkConfig = (config: LinkConfig): void => {
  writeJson(getLinkConfigPath(), config, 0o600);
};

export const deleteLinkConfig = (): boolean => {
  const file = getLinkConfigPath();
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  fs.rmSync(getLinkStatePath(), { force: true });
  return existed;
};

export const readLinkState = (): LinkState => readJson<LinkState>(getLinkStatePath()) ?? {};

export const writeLinkState = (state: LinkState): void => {
  writeJson(getLinkStatePath(), state);
};

/** Show that a secret is set without printing it. */
export const maskSecret = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-2)}`;
};

/**
 * Translate a lazybackup key path to a local file that exists, or undefined.
 * Tries each key-map prefix, then the path as-is, then `~/.ssh/<basename>`.
 */
export const resolveLocalKeyPath = (
  remotePath: string | undefined,
  keyMap: KeyMapEntry[] = DEFAULT_KEY_MAP,
  exists: (file: string) => boolean = fs.existsSync,
): string | undefined => {
  if (!remotePath) {
    return undefined;
  }
  const candidates: string[] = [];
  for (const entry of keyMap) {
    const from = entry.from.replace(/\/+$/, '');
    if (remotePath === from || remotePath.startsWith(`${from}/`)) {
      const to = expandHomePath(entry.to.replace(/\/+$/, ''));
      if (to) {
        candidates.push(to + remotePath.slice(from.length));
      }
    }
  }
  candidates.push(expandHomePath(remotePath) ?? remotePath);
  const sshDir = expandHomePath('~/.ssh');
  if (sshDir) {
    candidates.push(path.join(sshDir, path.basename(remotePath)));
  }
  return candidates.find(candidate => exists(candidate));
};
