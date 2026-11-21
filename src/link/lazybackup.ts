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

export type LinkErrorKind =
  | 'link_unreachable'
  | 'link_unauthorized'
  | 'link_access_blocked'
  | 'link_bad_response'
  /** The token lacks `authorize_keys` (or `remote_exec`). */
  | 'link_forbidden'
  /** lazybackup is too old for the requested endpoint. */
  | 'link_unsupported'
  /** lazybackup could not update the server's authorized_keys. */
  | 'link_authorize_failed';

export class LinkFetchError extends Error {
  constructor(
    message: string,
    readonly errorKind: LinkErrorKind,
    readonly hint?: string,
    readonly status?: number,
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

const errorMessageFrom = (text: string): string | undefined => {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body?.error === 'string' && body.error ? body.error : undefined;
  } catch {
    return undefined;
  }
};

const requestJson = async (
  config: LinkConfig,
  pathname: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  request: { method?: string; body?: unknown } = {},
): Promise<unknown> => {
  const url = `${config.url}${pathname}`;
  const headers = buildHeaders(config);
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method ?? 'GET',
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
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
    const detail = blockedByAccess ? undefined : errorMessageFrom(await response.text().catch(() => ''));
    throw new LinkFetchError(
      `lazybackup refused the request (${response.status}${detail ? `: ${detail}` : ''}).`,
      blockedByAccess ? 'link_access_blocked' : 'link_unauthorized',
      blockedByAccess
        ? 'Cloudflare Access denied the request: check the service token and that the Access policy allows it.'
        : 'Create an API token in lazybackup (Settings → API / MCP; read_only is enough) and run `sshya link set <url> --token <token>`.',
      response.status,
    );
  }
  if (!response.ok) {
    const detail = errorMessageFrom(await response.text().catch(() => ''));
    throw new LinkFetchError(
      `lazybackup returned HTTP ${response.status} for ${pathname}${detail ? `: ${detail}` : '.'}`,
      'link_bad_response',
      undefined,
      response.status,
    );
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
  options: { timeoutMs?: number; fetchImpl?: FetchLike; includeKeys?: boolean } = {},
): Promise<LazybackupSnapshot> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const serversRaw = await requestJson(config, '/api/servers', timeoutMs, fetchImpl);
  if (!Array.isArray(serversRaw)) {
    throw new LinkFetchError('lazybackup /api/servers did not return a list.', 'link_bad_response');
  }
  const servers = serversRaw.filter(isServer);

  let keys: LazybackupSshKey[] = [];
  if (options.includeKeys || servers.some(server => server.sshKeyId)) {
    try {
      const keysRaw = await requestJson(config, '/api/ssh-keys', timeoutMs, fetchImpl) as { storedKeys?: unknown };
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

export interface AuthorizeKeyResult {
  /** authorize: `added` | `present`; revoke: `removed` | `absent`. */
  status: 'added' | 'present' | 'removed' | 'absent';
  fingerprint?: string;
}

const AUTHORIZE_STATUSES = new Set(['added', 'present', 'removed', 'absent']);

/**
 * Ask lazybackup to add (or remove) `publicKey` in a server's authorized_keys
 * with the credentials it stores. Needs a token with `authorize_keys` (or
 * `remote_exec`); a read_only token can carry it too.
 */
export const updateAuthorizedKey = async (
  config: LinkConfig,
  serverId: string,
  publicKey: string,
  action: 'authorize' | 'revoke',
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<AuthorizeKeyResult> => {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const pathname = `/api/servers/${encodeURIComponent(serverId)}/authorize-key`;
  let body: unknown;
  try {
    body = await requestJson(config, pathname, options.timeoutMs ?? 45_000, fetchImpl, {
      method: action === 'authorize' ? 'POST' : 'DELETE',
      body: { publicKey },
    });
  } catch (err) {
    if (!(err instanceof LinkFetchError)) {
      throw err;
    }
    // Only a lazybackup without authorize-key answers a read_only token this way;
    // newer ones let the request through to the route's own permission check.
    if (err.status === 403 && /API token is read_only/.test(err.message)) {
      throw new LinkFetchError(
        'This lazybackup is too old to authorize keys for a read_only token.',
        'link_unsupported',
        'Update lazybackup and create a token with "Allow authorizing SSH keys", or map the key by hand with `sshya link key <id> <path>`.',
        403,
      );
    }
    if (err.errorKind === 'link_unauthorized' && err.status === 403) {
      throw new LinkFetchError(
        'the lazybackup token lacks the authorize_keys permission.',
        'link_forbidden',
        'In lazybackup (Settings → API / MCP) create a token with "Allow authorizing SSH keys" (Read only can stay on), then `sshya link set --token-stdin`. Or map the key by hand with `sshya link key`.',
        403,
      );
    }
    // A missing route is an HTML 404/405; a missing server is a JSON 404 with a message.
    if ((err.status === 404 && !/Server not found/.test(err.message)) || err.status === 405) {
      throw new LinkFetchError(
        `This lazybackup does not support authorizing keys (${err.message}).`,
        'link_unsupported',
        'Update lazybackup, or map the key by hand with `sshya link key <id> <path>`.',
        err.status,
      );
    }
    if (err.errorKind === 'link_bad_response' && err.status !== undefined && err.status >= 500) {
      throw new LinkFetchError(err.message, 'link_authorize_failed', 'lazybackup could not reach or update the server; it retries on the next `sshya sync`.', err.status);
    }
    throw err;
  }
  const result = body as { status?: unknown; fingerprint?: unknown };
  if (typeof result?.status !== 'string' || !AUTHORIZE_STATUSES.has(result.status)) {
    throw new LinkFetchError(`lazybackup returned an unexpected answer for ${pathname}.`, 'link_bad_response');
  }
  return {
    status: result.status as AuthorizeKeyResult['status'],
    ...(typeof result.fingerprint === 'string' ? { fingerprint: result.fingerprint } : {}),
  };
};
