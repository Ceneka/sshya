import chalk from 'chalk';
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
import { LinkFetchError } from './lazybackup';
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
  ].filter(Boolean);
  console.log(
    `Synced ${report.total} server(s) from ${report.url}: ${changes.length ? changes.join(', ') : 'no changes'}`,
  );
  for (const alias of report.added) console.log(chalk.green(`  + ${alias}`));
  for (const alias of report.updated) console.log(chalk.cyan(`  ~ ${alias}`));
  for (const alias of report.adopted) console.log(chalk.cyan(`  = ${alias} (existing local connection now linked)`));
  for (const alias of report.removed) console.log(chalk.red(`  - ${alias}`));
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
  const linked = getConnections().filter(connection => connection.link).length;
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
  console.log(chalk.grey(`  connections: ${linked} linked`));
  console.log(chalk.grey(`  last sync:   ${payload.lastSyncAt ?? 'never'}`));
  if (payload.lastError) {
    console.log(chalk.yellow(`  last error:  ${payload.lastError}`));
  }
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
