import type { LinkConfig } from './config';

/** A lazybackup `servers` row as `GET /api/servers` returns it (secrets redacted). */
export interface LazybackupServer {
  id: string;
  name: string;
  host: string;
  port?: number | null;
  username: string;
  authType: 'password' | 'key';
  sshKeyId?: string | null;
  systemKeyPath?: string | null;
  hasPrivateKey?: boolean;
}

/** A lazybackup `ssh_keys` row as `GET /api/ssh-keys` returns it. */
export interface LazybackupSshKey {
  id: string;
  name?: string;
  privateKeyPath?: string | null;
  hasPrivateKeyContent?: boolean;
}

export interface LazybackupSnapshot {
  servers: LazybackupServer[];
  keys: LazybackupSshKey[];
}

export class LinkFetchError extends Error {
  constructor(
    message: string,
    readonly errorKind: 'link_unreachable' | 'link_unauthorized' | 'link_access_blocked' | 'link_bad_response',
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LinkFetchError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const buildHeaders = (config: LinkConfig): Record<string, string> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }
  if (config.cfAccessClientId && config.cfAccessClientSecret) {
    headers['CF-Access-Client-Id'] = config.cfAccessClientId;
    headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
  }
  return headers;
};

const getJson = async (
  config: LinkConfig,
  pathname: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<unknown> => {
  const url = `${config.url}${pathname}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: buildHeaders(config),
      // A CF Access login redirect must surface as an error, not as HTML.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new LinkFetchError(
      `Could not reach lazybackup at ${config.url}: ${reason}`,
      'link_unreachable',
      'Check the URL and your network; sshya keeps using the cached connections.',
    );
  }

  const location = response.headers.get('location') ?? '';
  if ((response.status >= 300 && response.status < 400) || location.includes('cloudflareaccess.com')) {
    throw new LinkFetchError(
      `lazybackup request was redirected (${response.status}${location ? ` → ${location}` : ''}).`,
      'link_access_blocked',
      'Cloudflare Access is probably in front of it: create a service token and run `sshya link set <url> --cf-client-id <id> --cf-client-secret <secret>`.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    // lazybackup answers its own 401/403 with JSON; Cloudflare Access with HTML.
    const contentType = response.headers.get('content-type') ?? '';
    const blockedByAccess = response.headers.has('cf-access-domain') || !contentType.includes('json');
    throw new LinkFetchError(
      `lazybackup refused the request (${response.status}).`,
      blockedByAccess ? 'link_access_blocked' : 'link_unauthorized',
      blockedByAccess
        ? 'Cloudflare Access denied the request: check the service token and that the Access policy allows it.'
        : 'Create an API token in lazybackup (Settings → API / MCP; read_only is enough) and run `sshya link set <url> --token <token>`.',
    );
  }
  if (!response.ok) {
    throw new LinkFetchError(`lazybackup returned HTTP ${response.status} for ${pathname}.`, 'link_bad_response');
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LinkFetchError(
      `lazybackup returned non-JSON for ${pathname}.`,
      text.trimStart().startsWith('<') ? 'link_access_blocked' : 'link_bad_response',
      'An HTML page usually means a login wall (Cloudflare Access or the lazybackup password) answered instead of the API.',
    );
  }
};

const isServer = (value: unknown): value is LazybackupServer => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.host === 'string' && typeof row.username === 'string';
};

/** Fetch servers plus stored keys (to resolve `sshKeyId` → a key path). */
export const fetchLazybackupSnapshot = async (
  config: LinkConfig,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<LazybackupSnapshot> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const serversRaw = await getJson(config, '/api/servers', timeoutMs, fetchImpl);
  if (!Array.isArray(serversRaw)) {
    throw new LinkFetchError('lazybackup /api/servers did not return a list.', 'link_bad_response');
  }
  const servers = serversRaw.filter(isServer);

  let keys: LazybackupSshKey[] = [];
  if (servers.some(server => server.sshKeyId)) {
    try {
      const keysRaw = await getJson(config, '/api/ssh-keys', timeoutMs, fetchImpl) as { storedKeys?: unknown };
      if (Array.isArray(keysRaw?.storedKeys)) {
        keys = keysRaw.storedKeys.filter(
          (key): key is LazybackupSshKey => Boolean(key) && typeof (key as LazybackupSshKey).id === 'string',
        );
      }
    } catch {
      // Keys only improve key-path resolution; servers still sync without them.
    }
  }

  return { servers, keys };
};
