import { spawnSync } from 'child_process';
import chalk from '../lib/color';
import { getConnections, type Connection } from '../database';
import {
  controlSocketPath,
  controlTarget,
  getControlDir,
  isMultiplexingSupported,
} from '../helpers/control';
import { jsonEnabled, printJson } from '../output';

export interface PoolEntry {
  alias: string;
  target: string;
  socket: string;
  alive: boolean;
  pid?: number;
}

export interface PoolStatus {
  supported: boolean;
  dir: string;
  entries: PoolEntry[];
}

const sshBinary = (): string => process.env.SSHYA_SSH_BIN?.trim() || 'ssh';

const inspect = (connection: Connection): PoolEntry => {
  const socket = controlSocketPath(connection);
  const target = controlTarget(connection);

  const result = spawnSync(sshBinary(), ['-S', socket, '-O', 'check', target], {
    encoding: 'utf8',
    timeout: 3000,
  });

  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  const pidMatch = /pid=(\d+)/.exec(output);

  return {
    alias: connection.alias,
    target,
    socket,
    alive: result.status === 0,
    ...(pidMatch?.[1] ? { pid: Number(pidMatch[1]) } : {}),
  };
};

export const poolStatus = (): PoolStatus => ({
  supported: isMultiplexingSupported(),
  dir: getControlDir(),
  entries: getConnections().map(inspect),
});

const closeOne = (alias: string): { alias: string; closed: boolean; message: string } => {
  const connection = getConnections().find(candidate => candidate.alias === alias);
  if (!connection) {
    return { alias, closed: false, message: `Alias not found: ${alias}` };
  }

  const socket = controlSocketPath(connection);
  const result = spawnSync(
    sshBinary(),
    ['-S', socket, '-O', 'exit', controlTarget(connection)],
    { encoding: 'utf8', timeout: 5000 },
  );

  const message = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  return {
    alias,
    closed: result.status === 0,
    message: message || (result.status === 0 ? 'Exit request sent.' : 'No pooled connection.'),
  };
};

export interface PoolCommandOptions {
  json?: boolean;
  all?: boolean;
}

export async function poolCommand(
  action: string | undefined,
  alias: string | undefined,
  options: PoolCommandOptions = {},
): Promise<void> {
  const json = jsonEnabled(options.json);
  const normalizedAction = (action ?? 'list').toLowerCase();

  if (normalizedAction === 'list' || normalizedAction === 'status') {
    const status = poolStatus();
    if (json) {
      printJson(status);
      return;
    }

    if (!status.supported) {
      console.log(chalk.yellow('Connection pooling is not supported on this platform.'));
      return;
    }

    const active = status.entries.filter(entry => entry.alive);
    if (status.entries.length === 0) {
      console.log(chalk.yellow('No connections configured. Add one with "sshya add".'));
      return;
    }

    console.log(chalk.bold(`Control sockets: ${status.dir}`));
    for (const entry of status.entries) {
      const state = entry.alive ? chalk.green('active') : chalk.grey('idle');
      const pid = entry.pid ? chalk.grey(` pid=${entry.pid}`) : '';
      console.log(`${entry.alias.padEnd(24)} ${state}${pid}`);
    }
    console.log(chalk.grey(`${active.length} active of ${status.entries.length}`));
    return;
  }

  if (normalizedAction === 'close' || normalizedAction === 'stop') {
    const aliases = options.all
      ? getConnections().map(connection => connection.alias)
      : alias
        ? [alias]
        : [];

    if (aliases.length === 0) {
      if (!options.all) {
        console.error(chalk.red('Specify an alias, or pass --all.'));
        process.exitCode = 1;
        return;
      }

      if (json) {
        printJson({ ok: true, results: [] });
      } else {
        console.log(chalk.yellow('No connections configured.'));
      }
      return;
    }

    const results = aliases.map(closeOne);
    const ok = results.every(result => result.closed || !result.message.startsWith('Alias not found'));

    if (json) {
      printJson({ ok, results });
    } else {
      for (const result of results) {
        const label = result.closed ? chalk.green('closed') : chalk.grey('not pooled');
        console.log(`${result.alias}: ${label}${result.closed ? '' : chalk.grey(` (${result.message})`)}`);
      }
    }

    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.error(chalk.red(`Unknown pool action: ${action}`));
  console.error(chalk.grey('Usage: sshya pool [list|close] [alias] [--all]'));
  process.exitCode = 1;
}
