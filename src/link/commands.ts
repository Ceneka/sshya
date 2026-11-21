import chalk from '../lib/color';
import { getConnections, replaceConnections } from '../database';
import { jsonEnabled, printJson } from '../output';
import {
  DEFAULT_TTL_SECONDS,
  deleteLinkConfig,
  getLinkConfigPath,
  loadLinkConfig,
  maskSecret,
  readLinkState,
  readStoredLinkConfig,
  saveLinkConfig,
  type LinkConfig,
} from './config';
import fs from 'fs';
import { expandHomePath } from '../database';
import { getDeviceKeyPath, readDeviceKey } from './deviceKey';
import { fetchLazybackupSnapshot, LinkFetchError, updateAuthorizedKey, type LazybackupSshKey } from './lazybackup';
import { autoSync, syncLink, type SyncReport } from './sync';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
};

const failLink = (json: boolean, err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  const errorKind = err instanceof LinkFetchError ? err.errorKind : 'link_error';
  const hint = err instanceof LinkFetchError ? err.hint : undefined;
  if (json) {
    printJson({ ok: false, errorKind, error: message, ...(hint ? { hint } : {}) });
  } else {
    console.error(chalk.red(message));
    if (hint) {
      console.error(chalk.grey(hint));
    }
  }
  process.exitCode = 1;
};

const printReport = (report: SyncReport): void => {
  const changes = [
    report.added.length ? chalk.green(`+${report.added.length} added`) : '',
    report.updated.length ? chalk.cyan(`~${report.updated.length} updated`) : '',
    report.adopted.length ? chalk.cyan(`${report.adopted.length} adopted`) : '',
    report.removed.length ? chalk.red(`-${report.removed.length} removed`) : '',
    report.authorized.length ? chalk.green(`${report.authorized.length} key(s) authorized`) : '',
  ].filter(Boolean);
  console.log(
    `Synced ${report.total} server(s) from ${report.url}: ${changes.length ? changes.join(', ') : 'no changes'}`,
  );
  for (const alias of report.added) console.log(chalk.green(`  + ${alias}`));
  for (const alias of report.updated) console.log(chalk.cyan(`  ~ ${alias}`));
  for (const alias of report.adopted) console.log(chalk.cyan(`  = ${alias} (existing local connection now linked)`));
  for (const alias of report.removed) console.log(chalk.red(`  - ${alias}`));
  for (const alias of report.authorized) {
    console.log(chalk.green(`  🔑 ${alias} (lazybackup installed ${getDeviceKeyPath()}.pub)`));
  }
  for (const conflict of report.conflicts) {
    console.log(chalk.yellow(`  ! ${conflict.alias} (${conflict.name}): ${conflict.reason}`));
  }
  for (const warning of report.warnings) {
    console.log(chalk.grey(`  · ${warning.alias}: ${warning.message}`));
  }
};

export interface LinkSetOptions {
  token?: string;
  tokenStdin?: boolean;
  cfClientId?: string;
  cfClientSecret?: string;
  ttl?: string;
  /** undefined keeps the stored choice (default on). */
  authorize?: boolean;
  sync?: boolean;
  json?: boolean;
}

export async function linkSetCommand(url: string | undefined, options: LinkSetOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  const previous = readStoredLinkConfig();
  const targetUrl = (url ?? previous?.url)?.trim().replace(/\/+$/, '');
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    failLink(json, new Error('A lazybackup URL starting with http:// or https:// is required.'));
    return;
  }

  let token = options.token;
  if (options.tokenStdin) {
    token = await readStdin();
  }

  let ttlSeconds = previous?.ttlSeconds;
  if (options.ttl !== undefined) {
    const ttl = Number(options.ttl);
    if (!Number.isFinite(ttl) || ttl < 0) {
      failLink(json, new Error('--ttl expects a non-negative number of seconds (0 disables auto-sync).'));
      return;
    }
    ttlSeconds = ttl;
  }

  // Same URL: keep secrets that were not passed again.
  const keep = previous && previous.url.replace(/\/+$/, '') === targetUrl ? previous : undefined;
  const config: LinkConfig = {
    url: targetUrl,
    ...(token ?? keep?.token ? { token: token ?? keep?.token } : {}),
    ...(options.cfClientId ?? keep?.cfAccessClientId ? { cfAccessClientId: options.cfClientId ?? keep?.cfAccessClientId } : {}),
    ...(options.cfClientSecret ?? keep?.cfAccessClientSecret
      ? { cfAccessClientSecret: options.cfClientSecret ?? keep?.cfAccessClientSecret }
      : {}),
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    ...(keep?.keyMap ? { keyMap: keep.keyMap } : {}),
    ...(keep?.vaultKeys ? { vaultKeys: keep.vaultKeys } : {}),
    ...((options.authorize ?? previous?.authorizeKeys) === false ? { authorizeKeys: false } : {}),
  };
  if (Boolean(config.cfAccessClientId) !== Boolean(config.cfAccessClientSecret)) {
    failLink(json, new Error('--cf-client-id and --cf-client-secret must be set together.'));
    return;
  }
  saveLinkConfig(config);

  if (options.sync === false) {
    if (json) {
      printJson({ ok: true, url: config.url, configPath: getLinkConfigPath() });
    } else {
      console.log(chalk.green(`Linked to ${config.url}`) + chalk.grey(` (${getLinkConfigPath()})`));
    }
    return;
  }

  try {
    const report = await syncLink();
    if (json) {
      printJson({ ...report, configPath: getLinkConfigPath() });
    } else {
      console.log(chalk.green(`Linked to ${config.url}`) + chalk.grey(` (${getLinkConfigPath()})`));
      printReport(report);
    }
  } catch (err) {
    // Keep the config: the user can fix the network/token and run `sshya sync`.
    failLink(json, err);
  }
}

export async function syncCommand(options: { json?: boolean } = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  try {
    const report = await syncLink();
    if (json) {
      printJson(report);
    } else {
      printReport(report);
    }
  } catch (err) {
    failLink(json, err);
  }
}

export async function linkShowCommand(options: { json?: boolean } = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  const config = loadLinkConfig();
  const state = readLinkState();
  const linkedConnections = getConnections().filter(connection => connection.link);
  const linked = linkedConnections.length;
  const deviceKey = readDeviceKey();
  if (!config) {
    if (json) {
      printJson({ ok: true, linked: false });
    } else {
      console.log('Not linked. Run `sshya link set <url> --token <token>`.');
    }
    return;
  }
  const payload = {
    ok: true,
    linked: true,
    url: config.url,
    configPath: getLinkConfigPath(),
    token: maskSecret(config.token),
    cfAccess: config.cfAccessClientId ? { clientId: config.cfAccessClientId, clientSecret: maskSecret(config.cfAccessClientSecret) } : undefined,
    ttlSeconds: config.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    keyMap: config.keyMap,
    vaultKeys: config.vaultKeys,
    authorizeKeys: config.authorizeKeys !== false,
    deviceKey: deviceKey
      ? {
          path: deviceKey.path,
          fingerprint: deviceKey.fingerprint,
          servers: linkedConnections.filter(c => c.link?.deviceKey === deviceKey.fingerprint).map(c => c.alias),
        }
      : undefined,
    connections: linked,
    lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : undefined,
    lastError: state.lastError,
  };
  if (json) {
    printJson(payload);
    return;
  }
  console.log(`${chalk.bold('lazybackup')} ${config.url}`);
  console.log(chalk.grey(`  config:      ${payload.configPath}`));
  console.log(chalk.grey(`  token:       ${payload.token ?? '(none)'}`));
  if (payload.cfAccess) {
    console.log(chalk.grey(`  CF Access:   ${payload.cfAccess.clientId}`));
  }
  console.log(chalk.grey(`  auto-sync:   ${payload.ttlSeconds ? `every ${payload.ttlSeconds}s` : 'off'}`));
  console.log(chalk.grey(`  key map:     ${(config.keyMap ?? []).map(entry => `${entry.from} → ${entry.to}`).join(', ')}`));
  const vaultCount = Object.keys(config.vaultKeys ?? {}).length;
  if (vaultCount > 0) {
    console.log(chalk.grey(`  vault keys:  ${vaultCount} mapped (sshya link key)`));
  }
  if (payload.deviceKey) {
    console.log(chalk.grey(`  sshya key:   ${payload.deviceKey.path} (${payload.deviceKey.fingerprint})`));
    console.log(chalk.grey(`               installed on ${payload.deviceKey.servers.length} server(s)${payload.authorizeKeys ? '' : '; authorizing is off'}`));
  } else {
    console.log(chalk.grey(`  sshya key:   ${payload.authorizeKeys ? 'created on the first server that needs it' : 'off'}`));
  }
  console.log(chalk.grey(`  connections: ${linked} linked`));
  console.log(chalk.grey(`  last sync:   ${payload.lastSyncAt ?? 'never'}`));
  if (payload.lastError) {
    console.log(chalk.yellow(`  last error:  ${payload.lastError}`));
  }
}

/**
 * Remove this machine's key from every linked server lazybackup installed it
 * on, and turn authorizing off so the next sync does not put it back.
 */
export async function linkRevokeCommand(options: { json?: boolean } = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  const config = loadLinkConfig();
  const stored = readStoredLinkConfig();
  if (!config || !stored) {
    failLink(json, new Error('No lazybackup link configured. Run `sshya link set <url> --token <token>` first.'));
    return;
  }
  saveLinkConfig({ ...stored, authorizeKeys: false });

  const deviceKey = readDeviceKey();
  const connections = getConnections();
  const targets = deviceKey ? connections.filter(c => c.link?.deviceKey === deviceKey.fingerprint) : [];
  const revoked: string[] = [];
  const failed: Array<{ alias: string; error: string; errorKind?: string }> = [];
  for (const connection of targets) {
    try {
      await updateAuthorizedKey(config, connection.link!.id, deviceKey!.publicKey, 'revoke');
      revoked.push(connection.alias);
      const { deviceKey: _fingerprint, ...rest } = connection.link!;
      connection.link = rest;
      if (!rest.localKey && connection.key_path === deviceKey!.path) {
        connection.key_path = undefined;
      }
    } catch (err) {
      failed.push({
        alias: connection.alias,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof LinkFetchError ? { errorKind: err.errorKind } : {}),
      });
    }
  }
  if (revoked.length > 0) {
    replaceConnections(connections);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
  if (json) {
    printJson({ ok: failed.length === 0, authorizeKeys: false, revoked, failed });
    return;
  }
  if (targets.length === 0) {
    console.log('No linked server has this machine\'s sshya key.');
  }
  for (const alias of revoked) console.log(chalk.green(`  - ${alias}: key removed`));
  for (const item of failed) console.log(chalk.red(`  ! ${item.alias}: ${item.error}`));
  console.log(chalk.grey('Authorizing is now off; turn it back on with `sshya link set --authorize`.'));
}

export async function linkUnsetCommand(options: { purge?: boolean; json?: boolean } = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  const removedConfig = deleteLinkConfig();
  const connections = getConnections();
  const linked = connections.filter(connection => connection.link).map(connection => connection.alias);
  const next = options.purge
    ? connections.filter(connection => !connection.link)
    : connections.map(connection => {
        const { link: _link, ...rest } = connection;
        return rest;
      });
  if (linked.length > 0) {
    replaceConnections(next);
  }
  if (json) {
    printJson({ ok: true, unlinked: removedConfig, [options.purge ? 'removed' : 'detached']: linked });
    return;
  }
  console.log(chalk.green(removedConfig ? 'Link removed.' : 'No link was configured.'));
  if (linked.length > 0) {
    console.log(
      options.purge
        ? chalk.grey(`Removed ${linked.length} linked connection(s).`)
        : chalk.grey(`Kept ${linked.length} connection(s) as local, unmanaged entries.`),
    );
  }
}

/** Match a stored key by id, exact name, or unique id/name prefix (case-insensitive). */
const findKey = (keys: LazybackupSshKey[], query: string): LazybackupSshKey | LazybackupSshKey[] | undefined => {
  const q = query.trim().toLowerCase();
  const exact = keys.find(key => key.id.toLowerCase() === q || (key.name ?? '').toLowerCase() === q);
  if (exact) {
    return exact;
  }
  const partial = keys.filter(key => key.id.toLowerCase().startsWith(q) || (key.name ?? '').toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : partial.length > 1 ? partial : undefined;
};

export interface LinkKeyOptions {
  unset?: boolean;
  json?: boolean;
}

/**
 * `sshya link key` lists lazybackup's stored keys with their local mapping;
 * `sshya link key <key> <path>` maps one (then syncs); `--unset` removes it.
 */
export async function linkKeyCommand(query: string | undefined, keyPath: string | undefined, options: LinkKeyOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  const config = loadLinkConfig();
  const stored = readStoredLinkConfig();
  if (!config || !stored) {
    failLink(json, new Error('No lazybackup link configured. Run `sshya link set <url> --token <token>` first.'));
    return;
  }

  let snapshot;
  try {
    snapshot = await fetchLazybackupSnapshot(config, { includeKeys: true });
  } catch (err) {
    failLink(json, err);
    return;
  }
  const mappings = { ...(stored.vaultKeys ?? {}) };
  const usage = (id: string) => snapshot.servers.filter(server => server.sshKeyId === id).map(server => server.name);

  if (!query) {
    const rows = snapshot.keys.map(key => ({
      id: key.id,
      name: key.name,
      servers: usage(key.id),
      ...(mappings[key.id] ? { localPath: mappings[key.id], exists: fs.existsSync(expandHomePath(mappings[key.id]) ?? '') } : {}),
    }));
    if (json) {
      printJson({ ok: true, keys: rows });
      return;
    }
    if (rows.length === 0) {
      console.log('lazybackup has no stored keys.');
      return;
    }
    for (const row of rows) {
      const mapped = row.localPath
        ? (row.exists ? chalk.green(`→ ${row.localPath}`) : chalk.yellow(`→ ${row.localPath} (missing)`))
        : chalk.grey('(not mapped)');
      console.log(`${chalk.bold(row.name ?? row.id)} ${chalk.grey(row.id)} ${mapped}`);
      if (row.servers.length > 0) {
        console.log(chalk.grey(`    used by: ${row.servers.join(', ')}`));
      }
    }
    console.log(chalk.grey('\nMap one with: sshya link key <id|name> <path>'));
    return;
  }

  const match = findKey(snapshot.keys, query);
  if (!match || Array.isArray(match)) {
    const message = !match
      ? `No lazybackup key matches "${query}".`
      : `"${query}" matches several keys: ${match.map(key => `${key.name ?? ''} (${key.id})`).join(', ')}. Use the id.`;
    failLink(json, new Error(message));
    return;
  }

  if (options.unset) {
    delete mappings[match.id];
  } else {
    if (!keyPath) {
      failLink(json, new Error('A local key path is required (or pass --unset).'));
      return;
    }
    const resolved = expandHomePath(keyPath.trim()) ?? keyPath;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      failLink(json, new Error(`Key file not found: ${resolved}`));
      return;
    }
    mappings[match.id] = resolved;
  }
  saveLinkConfig({ ...stored, vaultKeys: Object.keys(mappings).length > 0 ? mappings : undefined });

  try {
    const report = await syncLink();
    if (json) {
      printJson({ ...report, key: { id: match.id, name: match.name, localPath: mappings[match.id] ?? null, servers: usage(match.id) } });
    } else {
      console.log(chalk.green(
        options.unset
          ? `Unmapped "${match.name ?? match.id}".`
          : `Mapped "${match.name ?? match.id}" → ${mappings[match.id]} (${usage(match.id).length} server(s)).`,
      ));
      printReport(report);
    }
  } catch (err) {
    failLink(json, err);
  }
}

/** preAction hook: refresh linked connections, warn (TTY only) when it fails. */
export const autoSyncForCli = async (json: boolean): Promise<void> => {
  await autoSync({
    onError: err => {
      if (!json && process.stderr.isTTY) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.grey(`sshya: lazybackup sync skipped (${message}); using cached connections.`));
      }
    },
  });
};
