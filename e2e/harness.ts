import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared plumbing for the local-sshd end-to-end suite.
 *
 * Everything here is deliberately self-contained:
 * - sshd listens on 127.0.0.1 with a temporary host key and a temporary
 *   authorized_keys file;
 * - each "isolation" owns a temporary HOME, connection store, control-socket
 *   directory, and known_hosts file;
 * - ssh/scp are wrapped only to inject `UserKnownHostsFile` and
 *   `GlobalKnownHostsFile`. OpenSSH resolves `~/.ssh/known_hosts` from the
 *   passwd entry, not `$HOME`, so setting HOME alone is not enough on Linux.
 *   The wrapper keeps the real ~/.ssh untouched while every other argv item
 *   still comes from sshya.
 */

export const REPO_ROOT = path.resolve(import.meta.dir, '..');

export const SSHD_BIN = process.env.SSHYA_E2E_SSHD?.trim() || '/usr/sbin/sshd';
export const SSH_BIN = process.env.SSHYA_E2E_SSH?.trim() || '/usr/bin/ssh';
export const SCP_BIN = process.env.SSHYA_E2E_SCP?.trim() || '/usr/bin/scp';
const SSH_KEYGEN = 'ssh-keygen';

const TMP_BASE = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

export interface CliVariant {
  name: 'bun' | 'node';
  command: string;
  /** Arguments that precede the sshya subcommand. */
  prefix: string[];
}

export const CLI_VARIANTS: CliVariant[] = [
  { name: 'bun', command: 'bun', prefix: ['run', 'index.ts'] },
  { name: 'node', command: 'node', prefix: ['dist/index.js'] },
];

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunCliOptions {
  input?: string | Buffer;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

const runBinary = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; timeoutMs?: number } = {},
): CommandResult => {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs: Date.now() - startedAt,
  };
};

export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const makeTempDir = (prefix: string): string => fs.mkdtempSync(path.join(TMP_BASE, prefix));

const quoteSh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const writeExecutable = (file: string, body: string): void => {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
};

const requireSuccess = (result: CommandResult, label: string): CommandResult => {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (status=${result.status}, signal=${result.signal})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
};

export const getFreePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      server.close();
      reject(new Error('Could not allocate a local TCP port'));
      return;
    }
    const port = address.port;
    server.close(error => (error ? reject(error) : resolve(port)));
  });
});

export const waitForPort = async (port: number, timeoutMs: number = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let settled = false;

      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(250, () => finish(false));
    });

    if (connected) {
      return;
    }
    await delay(50);
  }

  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
};

export interface SshdHandle {
  root: string;
  host: string;
  port: number;
  user: string;
  hostKeyPath: string;
  clientKeyPath: string;
  wrongKeyPath: string;
  hostPublicKey: string;
  wrongPublicKey: string;
  configPath: string;
  logPath: string;
  process: ChildProcess;
  readLog(): string;
}

export async function startSshd(): Promise<SshdHandle> {
  if (!fs.existsSync(SSHD_BIN)) {
    throw new Error(`sshd not found at ${SSHD_BIN}; set SSHYA_E2E_SSHD to override`);
  }

  const root = makeTempDir('sshya-e2e-sshd-');
  const port = await getFreePort();
  const user = os.userInfo().username;
  const hostKeyPath = path.join(root, 'host_key');
  const clientKeyPath = path.join(root, 'client_key');
  const wrongKeyPath = path.join(root, 'wrong_key');
  const authorizedKeysPath = path.join(root, 'authorized_keys');
  const configPath = path.join(root, 'sshd_config');
  const logPath = path.join(root, 'sshd.log');
  const pidPath = path.join(root, 'sshd.pid');

  for (const keyPath of [hostKeyPath, clientKeyPath, wrongKeyPath]) {
    requireSuccess(
      runBinary(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'sshya-e2e', '-f', keyPath]),
      `ssh-keygen ${path.basename(keyPath)}`,
    );
  }

  fs.copyFileSync(`${clientKeyPath}.pub`, authorizedKeysPath);
  fs.chmodSync(clientKeyPath, 0o600);
  fs.chmodSync(wrongKeyPath, 0o600);
  fs.chmodSync(authorizedKeysPath, 0o600);

  const hostPublicKey = requireSuccess(
    runBinary(SSH_KEYGEN, ['-y', '-f', hostKeyPath]),
    'reading the host public key',
  ).stdout.trim();
  const wrongPublicKey = requireSuccess(
    runBinary(SSH_KEYGEN, ['-y', '-f', wrongKeyPath]),
    'reading the wrong host public key',
  ).stdout.trim();

  fs.writeFileSync(configPath, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKeyPath}`,
    `PidFile ${pidPath}`,
    `AuthorizedKeysFile ${authorizedKeysPath}`,
    `AllowUsers ${user}`,
    'UsePAM no',
    'StrictModes no',
    'PasswordAuthentication no',
    'PermitEmptyPasswords no',
    'KbdInteractiveAuthentication no',
    'ChallengeResponseAuthentication no',
    'PubkeyAuthentication yes',
    'AuthenticationMethods publickey',
    'PermitRootLogin no',
    'UseDNS no',
    'PrintMotd no',
    'PrintLastLog no',
    'X11Forwarding no',
    'AllowTcpForwarding no',
    'MaxSessions 32',
    'MaxStartups 20:30:100',
    'Subsystem sftp internal-sftp',
    'AcceptEnv LANG LC_*',
    'LogLevel VERBOSE',
    '',
  ].join('\n'), { mode: 0o600 });

  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(SSHD_BIN, ['-f', configPath, '-D', '-e'], {
    stdio: ['ignore', 'ignore', logFd],
  });
  fs.closeSync(logFd);

  const handle: SshdHandle = {
    root,
    host: '127.0.0.1',
    port,
    user,
    hostKeyPath,
    clientKeyPath,
    wrongKeyPath,
    hostPublicKey,
    wrongPublicKey,
    configPath,
    logPath,
    process: child,
    readLog: () => {
      try {
        return fs.readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
  };

  let ready = false;
  const earlyExit = new Promise<never>((_, reject) => {
    child.once('exit', code => {
      if (!ready) {
        reject(new Error(`sshd exited early (code=${code})\n${handle.readLog()}`));
      }
    });
  });

  try {
    await Promise.race([waitForPort(port, 5_000), earlyExit]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  ready = true;
  // The promise stays pending after a successful start; make sure a teardown
  // exit cannot surface as an unhandled rejection.
  void earlyExit.catch(() => undefined);

  return handle;
}

export async function stopSshd(sshd: SshdHandle): Promise<void> {
  const child = sshd.process;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface SilentTcpServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Accept TCP connections and never write a banner, so SSH waits. */
export async function startSilentTcpServer(): Promise<SilentTcpServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    server.close();
    throw new Error('Could not start the silent TCP listener');
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    close: () => new Promise(resolve => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    }),
  };
}

export interface Isolation {
  label: string;
  root: string;
  home: string;
  knownHosts: string;
  sshWrapper: string;
  scpWrapper: string;
  dbPath: string;
  poolDir: string;
  runtimeDir: string;
  remoteDir: string;
  localDir: string;
  tmpDir: string;
  env(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
}

export interface IsolationOptions {
  /** Preload the throwaway sshd host key into the isolated known_hosts. */
  preloadHostKey?: boolean;
  /** Override the known_hosts file (used by host-key tests). */
  knownHosts?: string;
}

const buildCleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'SSHYA_REUSE',
    'SSHYA_JSON',
    'SSHYA_HOST_KEY_CHECKING',
    'SSHYA_MAX_OUTPUT',
    'SSHYA_CONTROL_PERSIST',
    'SSHYA_MCP_ALLOW',
    'SSHYA_MCP_READ_ONLY',
  ]) {
    delete env[key];
  }
  return env;
};

export const createIsolation = (
  parent: string,
  label: string,
  sshd: SshdHandle,
  options: IsolationOptions = {},
): Isolation => {
  const root = fs.mkdtempSync(path.join(parent, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  const home = path.join(root, 'home');
  const sshDir = path.join(home, '.ssh');
  const poolDir = path.join(root, 'pool');
  const runtimeDir = path.join(root, 'runtime');
  const remoteDir = path.join(root, 'remote');
  const localDir = path.join(root, 'local');
  const tmpDir = path.join(root, 'tmp');
  for (const dir of [home, sshDir, poolDir, runtimeDir, remoteDir, localDir, tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.chmodSync(home, 0o700);
  fs.chmodSync(sshDir, 0o700);
  fs.chmodSync(poolDir, 0o700);

  const knownHosts = options.knownHosts ?? path.join(root, 'known_hosts');
  fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
  const knownHostsLine = `[${sshd.host}]:${sshd.port} ${sshd.hostPublicKey}\n`;
  fs.writeFileSync(knownHosts, options.preloadHostKey === false ? '' : knownHostsLine, { mode: 0o600 });
  fs.chmodSync(knownHosts, 0o600);

  const sshWrapper = path.join(root, 'ssh');
  const scpWrapper = path.join(root, 'scp');
  writeExecutable(sshWrapper, [
    '#!/bin/sh',
    `exec ${quoteSh(SSH_BIN)} -o UserKnownHostsFile=${quoteSh(knownHosts)} -o GlobalKnownHostsFile=/dev/null "$@"`,
    '',
  ].join('\n'));
  writeExecutable(scpWrapper, [
    '#!/bin/sh',
    `exec ${quoteSh(SCP_BIN)} -o UserKnownHostsFile=${quoteSh(knownHosts)} -o GlobalKnownHostsFile=/dev/null "$@"`,
    '',
  ].join('\n'));

  const baseEnv = buildCleanEnv();
  Object.assign(baseEnv, {
    HOME: home,
    TMPDIR: tmpDir,
    XDG_RUNTIME_DIR: runtimeDir,
    SSHYA_DB: path.join(root, 'sshm.json'),
    SSHYA_CONTROL_DIR: poolDir,
    SSHYA_SSH_BIN: sshWrapper,
    SSHYA_SCP_BIN: scpWrapper,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  });

  return {
    label,
    root,
    home,
    knownHosts,
    sshWrapper,
    scpWrapper,
    dbPath: path.join(root, 'sshm.json'),
    poolDir,
    runtimeDir,
    remoteDir,
    localDir,
    tmpDir,
    env: (overrides = {}) => {
      const merged: NodeJS.ProcessEnv = { ...baseEnv };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete merged[key];
        } else {
          merged[key] = value;
        }
      }
      return merged;
    },
  };
};

export const runCli = (
  variant: CliVariant,
  isolation: Isolation,
  args: string[],
  options: RunCliOptions = {},
): CommandResult => runBinary(variant.command, [...variant.prefix, ...args], {
  env: isolation.env(options.env),
  input: options.input,
  timeoutMs: options.timeoutMs ?? 60_000,
});

export interface OpenStdinResult extends CommandResult {
  /** True when the CLI had to be killed after `waitMs`. */
  hung: boolean;
}

/**
 * Spawn the CLI with a pipe on stdin, keep the writer end open, and wait for
 * the CLI itself to exit. This is the agent-harness shape that must not hang.
 */
export const runCliWithOpenStdin = (
  variant: CliVariant,
  isolation: Isolation,
  args: string[],
  options: { waitMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<OpenStdinResult> => new Promise(resolve => {
  const startedAt = Date.now();
  const waitMs = options.waitMs ?? 8_000;
  const child = spawn(variant.command, [...variant.prefix, ...args], {
    cwd: REPO_ROOT,
    env: isolation.env(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let hung = false;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const killGroup = (): void => {
    if (child.pid === undefined) {
      return;
    }
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Already gone.
    }
  };

  const timer = setTimeout(() => {
    hung = true;
    killGroup();
  }, waitMs);

  const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    child.stdin?.destroy();
    resolve({
      status,
      signal,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      hung,
    });
  };

  child.once('close', (status, signal) => finish(status, signal));
  child.once('error', error => {
    stderr += String(error);
    finish(null, null);
  });

  // Deliberately never write to or end child.stdin: the writer stays open.
});

export const parseJson = <T>(result: CommandResult, label: string): T => {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      `${label}: stdout is not JSON (status=${result.status})\n` +
      `error: ${error instanceof Error ? error.message : String(error)}\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
};

export const expectNoAnsi = (text: string, label: string): void => {
  if (text.includes('\u001b[')) {
    throw new Error(`${label}: unexpected ANSI/chalk escape sequence`);
  }
};

export interface ProcessEntry {
  pid: number;
  args: string;
}

export const listProcesses = (): ProcessEntry[] => {
  const result = runBinary('ps', ['-eo', 'pid=,args='], { timeoutMs: 5_000 });
  if (result.status !== 0) {
    return [];
  }
  const entries: ProcessEntry[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      entries.push({ pid: Number(match[1]), args: match[2] });
    }
  }
  return entries;
};

export const processesWithMarker = (marker: string): ProcessEntry[] =>
  listProcesses().filter(entry => entry.args.includes(marker));

export const closeAllPools = (
  variant: CliVariant,
  isolation: Isolation,
  env: Record<string, string | undefined> = {},
): CommandResult => runCli(variant, isolation, ['pool', 'close', '--all', '--json'], {
  env,
  timeoutMs: 30_000,
});

export const formatDuration = (result: CommandResult): string =>
  `${result.durationMs}ms (status=${result.status}, stdout=${result.stdout.length}B, stderr=${result.stderr.length}B)`;
