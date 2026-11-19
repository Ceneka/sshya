import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from '../lib/color';
import pkg from '../../package.json' with { type: 'json' };
import { getConnections, getDbPath, type Connection } from '../database';
import { defaultMaxOutputBytes } from '../helpers/capture';
import { ensureControlDir, getControlDir, getControlPersistSeconds, isMultiplexingSupported, reuseEnabled } from '../helpers/control';
import { poolStatus } from './pool';
import { executeSshCommand } from './run';
import { jsonEnabled, printJson } from '../output';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  detail?: string;
  hint?: string;
}

export interface ProbeResult {
  alias: string;
  ok: boolean;
  durationMs: number;
  reused: boolean;
  errorKind?: string;
  hint?: string;
}

export interface DoctorOptions {
  json?: boolean;
  probe?: boolean;
  timeoutMs?: number;
  acceptNewHostKey?: boolean;
}

const sshBinary = (): string => process.env.SSHYA_SSH_BIN?.trim() || 'ssh';

const checkSsh = (): DoctorCheck => {
  const result = spawnSync(sshBinary(), ['-V'], { encoding: 'utf8' });
  if (result.error) {
    return {
      id: 'ssh-binary',
      status: 'fail',
      summary: 'OpenSSH client not found',
      hint: 'Install OpenSSH client or set SSHYA_SSH_BIN to the ssh binary.',
    };
  }
  const version = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n')[0] ?? 'ssh';
  return { id: 'ssh-binary', status: 'ok', summary: version };
};

const checkScp = (): DoctorCheck => {
  const result = spawnSync(process.env.SSHYA_SCP_BIN?.trim() || 'scp', ['-V'], { encoding: 'utf8' });
  if (result.error) {
    return {
      id: 'scp-binary',
      status: 'warn',
      summary: 'scp not found',
      hint: 'File copies will fail. Install OpenSSH client.',
    };
  }
  return { id: 'scp-binary', status: 'ok', summary: 'scp available' };
};

const checkDatabase = (): { check: DoctorCheck; connections: Connection[] } => {
  const dbPath = getDbPath();
  const connections = getConnections();
  const dir = path.dirname(dbPath);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return {
      check: {
        id: 'database',
        status: 'ok',
        summary: `${connections.length} connection${connections.length === 1 ? '' : 's'}`,
        detail: dbPath,
      },
      connections,
    };
  } catch (error) {
    return {
      check: {
        id: 'database',
        status: 'fail',
        summary: 'Database directory is not writable',
        detail: error instanceof Error ? error.message : String(error),
        hint: `Check permissions on ${dir}, or set SSHYA_DB to a writable path.`,
      },
      connections,
    };
  }
};

const checkKeys = (connections: Connection[]): DoctorCheck => {
  const problems: string[] = [];

  for (const connection of connections) {
    if (!connection.key_path) {
      continue;
    }
    if (!fs.existsSync(connection.key_path)) {
      problems.push(`${connection.alias}: missing ${connection.key_path}`);
      continue;
    }
    try {
      const mode = fs.statSync(connection.key_path).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        problems.push(`${connection.alias}: ${connection.key_path} has mode ${mode.toString(8)} (chmod 600)`);
      }
    } catch {
      problems.push(`${connection.alias}: cannot stat ${connection.key_path}`);
    }
  }

  if (problems.length === 0) {
    return {
      id: 'keys',
      status: 'ok',
      summary: 'Stored keys are readable',
    };
  }

  return {
    id: 'keys',
    status: 'warn',
    summary: `${problems.length} key issue${problems.length === 1 ? '' : 's'}`,
    detail: problems.join('\n'),
    hint: 'Fix the key path or permissions, or run `sshya doctor --probe` to see which aliases work.',
  };
};

const checkAgent = (): DoctorCheck => {
  const socket = process.env.SSH_AUTH_SOCK?.trim();
  if (!socket) {
    return {
      id: 'ssh-agent',
      status: 'info',
      summary: 'SSH_AUTH_SOCK is not set',
      hint: 'Only needed for passphrase-protected keys or when a key is loaded in the agent.',
    };
  }

  const result = spawnSync('ssh-add', ['-l'], { encoding: 'utf8', timeout: 3000 });
  if (result.error) {
    return {
      id: 'ssh-agent',
      status: 'warn',
      summary: 'ssh-add not available',
      detail: socket,
    };
  }

  if (result.status === 0) {
    const count = (result.stdout ?? '').trim().split('\n').filter(Boolean).length;
    return {
      id: 'ssh-agent',
      status: 'ok',
      summary: `${count} identit${count === 1 ? 'y' : 'ies'} loaded`,
      detail: socket,
    };
  }

  if (result.status === 1) {
    return {
      id: 'ssh-agent',
      status: 'warn',
      summary: 'Agent is running with no identities',
      detail: (result.stderr ?? '').trim() || socket,
      hint: 'Run `ssh-add <key>` if a connection relies on an agent-backed passphrase.',
    };
  }

  return {
    id: 'ssh-agent',
    status: 'warn',
    summary: 'Cannot talk to the SSH agent',
    detail: (result.stderr ?? '').trim() || socket,
  };
};

const checkPool = (): DoctorCheck => {
  if (!isMultiplexingSupported()) {
    return {
      id: 'connection-pool',
      status: 'info',
      summary: 'ControlMaster is not supported on this platform',
    };
  }

  const dir = ensureControlDir();
  if (!dir) {
    return {
      id: 'connection-pool',
      status: 'warn',
      summary: 'Pool directory is not writable',
      detail: getControlDir(),
      hint: 'Set SSHYA_CONTROL_DIR to a writable directory, or run with --no-reuse.',
    };
  }

  const status = poolStatus();
  const active = status.entries.filter(entry => entry.alive).length;
  return {
    id: 'connection-pool',
    status: 'ok',
    summary: `${active} active of ${status.entries.length}`,
    detail: `${dir} (persist ${getControlPersistSeconds()}s)`,
  };
};

const checkConfig = (): DoctorCheck => {
  return {
    id: 'agent-defaults',
    status: 'info',
    summary: 'Effective automation defaults',
    detail: [
      `reuse=${reuseEnabled() ? 'on' : 'off'}`,
      `maxOutput=${defaultMaxOutputBytes()} bytes`,
      `hostKeyChecking=${process.env.SSHYA_HOST_KEY_CHECKING ?? 'ssh-default'}`,
    ].join(' '),
  };
};

const probeConnections = async (
  connections: Connection[],
  options: DoctorOptions,
): Promise<ProbeResult[]> => {
  const results = new Array<ProbeResult>(connections.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < connections.length) {
      const index = cursor;
      cursor += 1;
      const connection = connections[index]!;
      const result = await executeSshCommand(connection, 'true', {
        batchMode: true,
        cwd: true,
        timeoutMs: options.timeoutMs ?? 5000,
        connectTimeout: 5,
        reuse: true,
        hostKeyChecking: options.acceptNewHostKey ? 'accept-new' : undefined,
        maxOutputBytes: 4096,
      });
      results[index] = {
        alias: connection.alias,
        ok: result.ok,
        durationMs: result.durationMs,
        reused: result.reused,
        ...(result.errorKind ? { errorKind: result.errorKind } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
      };
    }
  };

  const workers = Math.min(4, connections.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
};

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const json = jsonEnabled(options.json);
  const db = checkDatabase();
  const checks: DoctorCheck[] = [
    {
      id: 'runtime',
      status: 'info',
      summary: `${process.versions.bun ? 'Bun' : 'Node'} ${process.versions.bun ?? process.versions.node} on ${process.platform}/${process.arch}`,
    },
    checkSsh(),
    checkScp(),
    db.check,
    checkKeys(db.connections),
    checkAgent(),
    checkPool(),
    checkConfig(),
  ];

  const probes = options.probe && db.connections.length > 0
    ? await probeConnections(db.connections, options)
    : undefined;

  if (probes) {
    const failed = probes.filter(probe => !probe.ok);
    checks.push({
      id: 'probe',
      status: failed.length === 0 ? 'ok' : 'fail',
      summary: `${probes.length - failed.length} of ${probes.length} reachable`,
      ...(failed.length > 0
        ? { detail: failed.map(probe => `${probe.alias}: ${probe.errorKind ?? 'failed'}`).join('\n') }
        : {}),
      ...(failed.length > 0 ? { hint: 'See probes[].hint for the fix, or run `sshya test <alias> --json`.' } : {}),
    });
  }

  const hasFail = checks.some(check => check.status === 'fail');
  const hasWarn = checks.some(check => check.status === 'warn');

  if (json) {
    printJson({
      ok: !hasFail,
      version: pkg.version,
      platform: `${process.platform}/${process.arch}`,
      db: { path: getDbPath(), connections: db.connections.length },
      pool: { supported: isMultiplexingSupported(), dir: getControlDir() },
      checks,
      ...(probes ? { probes } : {}),
      summary: {
        ok: checks.filter(check => check.status === 'ok').length,
        warn: checks.filter(check => check.status === 'warn').length,
        fail: checks.filter(check => check.status === 'fail').length,
        info: checks.filter(check => check.status === 'info').length,
      },
    });
  } else {
    const symbol = (status: CheckStatus): string => {
      if (status === 'ok') return chalk.green('✓');
      if (status === 'warn') return chalk.yellow('!');
      if (status === 'fail') return chalk.red('✗');
      return chalk.blue('i');
    };

    console.log(chalk.bold('sshya doctor'));
    for (const check of checks) {
      console.log(`${symbol(check.status)} ${check.id}: ${check.summary}`);
      if (check.detail) {
        for (const line of check.detail.split('\n')) {
          console.log(chalk.grey(`   ${line}`));
        }
      }
      if (check.hint) {
        console.log(chalk.grey(`   ${check.hint}`));
      }
    }
    console.log(chalk.grey(hasFail ? 'Some checks failed.' : hasWarn ? 'Checks passed with warnings.' : 'All good.'));
  }

  process.exitCode = hasFail ? 1 : 0;
}
