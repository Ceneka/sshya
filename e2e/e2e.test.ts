import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CLI_VARIANTS,
  REPO_ROOT,
  closeAllPools,
  createIsolation,
  delay,
  expectNoAnsi,
  getFreePort,
  makeTempDir,
  parseJson,
  processesWithMarker,
  runCli,
  runCliWithOpenStdin,
  startSilentTcpServer,
  startSshd,
  stopSshd,
  type CliVariant,
  type CommandResult,
  type Isolation,
  type SilentTcpServer,
  type SshdHandle,
} from './harness';

/**
 * Real end-to-end coverage against a throwaway sshd in user space.
 *
 * Run with `e2e/run.sh` (or `SSHYA_E2E=1 bun test e2e/e2e.test.ts`).
 * Without SSHYA_E2E=1 the whole suite is skipped, so plain `bun test` stays
 * hermetic and never opens a socket.
 */

const E2E_ENABLED = process.env.SSHYA_E2E === '1';
const suite = E2E_ENABLED ? describe : describe.skip;

interface AddPayload {
  ok: boolean;
  created?: boolean;
  connection?: {
    alias: string;
    user: string;
    host: string;
    port?: string;
    key_path?: string;
    remote_path?: string;
  };
  error?: string;
}

interface ShowPayload {
  connection: { alias: string; port?: string; key_path?: string };
  sshArgs: string[];
  sshCommand: string;
  interactiveSshArgs: string[];
  interactiveSshCommand: string;
}

interface PrintPayload {
  alias: string;
  sshArgs: string[];
  sshCommand: string;
  interactiveSshArgs: string[];
  interactiveSshCommand: string;
}

interface RemovePayload {
  ok: boolean;
  removed?: { alias: string };
  error?: string;
}

interface UpdatePayload {
  ok: boolean;
  connection?: { alias: string; remote_path?: string };
  error?: string;
}

interface RefusalPayload {
  ok: false;
  error: string;
  suggestions?: string[];
  alias?: string;
}

interface RunPayload {
  ok: boolean;
  alias: string;
  command: string;
  remoteCommand: string;
  target: string;
  cwd?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLines: number;
  stderrLines: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  timeoutMs: number | null;
  reused: boolean;
  errorKind?: string;
  hint?: string;
}

interface CopyPayload {
  ok: boolean;
  alias: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  errorKind?: string;
  hint?: string;
}

interface PoolEntry {
  alias: string;
  target: string;
  socket: string;
  alive: boolean;
  pid?: number;
}

interface PoolListPayload {
  supported: boolean;
  dir: string;
  entries: PoolEntry[];
}

interface PoolClosePayload {
  ok: boolean;
  results: Array<{ alias: string; closed: boolean; message: string }>;
}

interface DoctorPayload {
  ok: boolean;
  db: { path: string; connections: number };
  checks: Array<{ id: string; status: string; summary: string }>;
  probes?: Array<{ alias: string; ok: boolean; reused: boolean; errorKind?: string }>;
}

let sshd: SshdHandle;
let silentServer: SilentTcpServer;
let refusedPort = 0;
let root = '';
const baseIsolations = new Map<string, Isolation>();
const extraIsolations: Array<{ variant: CliVariant; isolation: Isolation }> = [];
let mcpIsolation: Isolation;

const isoFor = (variant: CliVariant): Isolation => {
  const isolation = baseIsolations.get(variant.name);
  if (!isolation) {
    throw new Error(`Isolation for ${variant.name} is not initialized`);
  }
  return isolation;
};

const toEnvRecord = (
  isolation: Isolation,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(isolation.env(overrides))) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

const addAlias = (
  variant: CliVariant,
  isolation: Isolation,
  alias: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): AddPayload => {
  const portArgs = args.includes('--port') ? [] : ['--port', String(sshd.port)];
  const keyArgs = args.includes('--key') ? [] : ['--key', sshd.clientKeyPath];
  const result = runCli(
    variant,
    isolation,
    ['add', alias, `${sshd.user}@${sshd.host}`, ...portArgs, ...keyArgs, '--force', '--json', ...args],
    { env },
  );
  const payload = parseJson<AddPayload>(result, `add ${alias}`);
  if (result.status !== 0 || !payload.ok) {
    throw new Error(`Could not seed alias ${alias}: ${result.stdout}\n${result.stderr}`);
  }
  return payload;
};

const seedVariant = (variant: CliVariant, isolation: Isolation): void => {
  addAlias(variant, isolation, 'alpha', ['--remote-path', isolation.remoteDir]);
  addAlias(variant, isolation, 'beta', []);
  addAlias(variant, isolation, 'gamma', []);
  addAlias(variant, isolation, 'wrongkey', ['--key', sshd.wrongKeyPath]);
  addAlias(variant, isolation, 'refused', ['--port', String(refusedPort)]);
  addAlias(variant, isolation, 'silent', ['--port', String(silentServer.port)]);
};

const seedMcp = (isolation: Isolation): void => {
  const variant = CLI_VARIANTS[1]!;
  addAlias(variant, isolation, 'alpha', ['--remote-path', isolation.remoteDir]);
  addAlias(variant, isolation, 'beta', []);
  addAlias(variant, isolation, 'gamma', []);
};

suite('local sshd end to end (SSHYA_E2E=1)', () => {
  beforeAll(async () => {
    const build = spawnSync('bun', ['run', 'build'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (build.status !== 0) {
      throw new Error(`bun run build failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
    }

    sshd = await startSshd();
    silentServer = await startSilentTcpServer();
    refusedPort = await getFreePort();
    root = makeTempDir('sshya-e2e-run-');

    for (const variant of CLI_VARIANTS) {
      const isolation = createIsolation(root, `cli-${variant.name}`, sshd);
      baseIsolations.set(variant.name, isolation);
      seedVariant(variant, isolation);
    }

    mcpIsolation = createIsolation(root, 'mcp', sshd);
    extraIsolations.push({ variant: CLI_VARIANTS[1]!, isolation: mcpIsolation });
    seedMcp(mcpIsolation);
  }, 120_000);

  afterAll(async () => {
    if (root) {
      for (const variant of CLI_VARIANTS) {
        const isolation = baseIsolations.get(variant.name);
        if (isolation) {
          try {
            closeAllPools(variant, isolation);
          } catch {
            // Best effort cleanup.
          }
        }
      }
      for (const entry of extraIsolations) {
        try {
          closeAllPools(entry.variant, entry.isolation);
        } catch {
          // Best effort cleanup.
        }
      }
    }

    if (silentServer) {
      await silentServer.close();
    }
    if (sshd) {
      await stopSshd(sshd);
      fs.rmSync(sshd.root, { recursive: true, force: true });
    }
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  for (const variant of CLI_VARIANTS) {
    const isolation = () => isoFor(variant);

    describe(`[${variant.name}] connection management`, () => {
      test('add, list, show, print, update, and remove with --json', () => {
        const base = isolation();
        const target = `${sshd.user}@${sshd.host}`;

        const added = runCli(variant, base, [
          'add', 'mgmt', target,
          '--port', String(sshd.port),
          '--key', sshd.clientKeyPath,
          '--remote-path', path.join(base.remoteDir, 'mgmt'),
          '--json',
        ]);
        expect(added.status).toBe(0);
        const addPayload = parseJson<AddPayload>(added, 'add mgmt');
        expect(addPayload.ok).toBe(true);
        expect(addPayload.created).toBe(true);
        expect(addPayload.connection?.alias).toBe('mgmt');
        expect(addPayload.connection?.port).toBe(String(sshd.port));
        expect(addPayload.connection?.key_path).toBe(sshd.clientKeyPath);

        const duplicate = runCli(variant, base, [
          'add', 'mgmt', target, '--port', String(sshd.port), '--json',
        ]);
        expect(duplicate.status).toBe(1);
        const duplicatePayload = parseJson<AddPayload>(duplicate, 'duplicate add');
        expect(duplicatePayload.ok).toBe(false);
        expect(duplicatePayload.error).toContain('already exists');

        const forced = runCli(variant, base, [
          'add', 'mgmt', target, '--port', String(sshd.port), '--key', sshd.clientKeyPath, '--force', '--json',
        ]);
        expect(forced.status).toBe(0);
        expect(parseJson<AddPayload>(forced, 'forced add').created).toBe(false);

        const listed = runCli(variant, base, ['list', '--json']);
        expect(listed.status).toBe(0);
        const connections = parseJson<Array<{ alias: string; port?: string }>>(listed, 'list');
        expect(connections.map(connection => connection.alias)).toEqual(
          expect.arrayContaining(['alpha', 'beta', 'gamma', 'mgmt']),
        );
        expect(connections.find(connection => connection.alias === 'mgmt')?.port).toBe(String(sshd.port));

        const shown = runCli(variant, base, ['show', 'mgmt', '--json']);
        expect(shown.status).toBe(0);
        const showPayload = parseJson<ShowPayload>(shown, 'show mgmt');
        expect(showPayload.connection.alias).toBe('mgmt');
        expect(showPayload.sshArgs).toContain('-i');
        expect(showPayload.sshArgs).toContain(sshd.clientKeyPath);
        expect(showPayload.sshArgs).toContain('-p');
        expect(showPayload.sshArgs).toContain(String(sshd.port));
        expect(showPayload.sshArgs).toContain('-T');
        expect(showPayload.sshArgs).toContain(target);
        expect(showPayload.interactiveSshArgs).toContain('-t');
        expect(showPayload.interactiveSshArgs).not.toContain('-T');

        const printed = runCli(variant, base, ['print', 'mgmt', '--json']);
        expect(printed.status).toBe(0);
        const printPayload = parseJson<PrintPayload>(printed, 'print mgmt');
        expect(printPayload.alias).toBe('mgmt');
        expect(printPayload.sshArgs).toEqual(showPayload.sshArgs);
        expect(printPayload.sshCommand.startsWith('ssh ')).toBe(true);
        expect(printPayload.interactiveSshCommand).toContain('-t');

        const renamedPath = path.join(base.remoteDir, 'renamed');
        const updated = runCli(variant, base, [
          'update', 'mgmt', '--new-alias', 'mgmt-renamed', '--remote-path', renamedPath, '--json',
        ]);
        expect(updated.status).toBe(0);
        const updatePayload = parseJson<UpdatePayload>(updated, 'update mgmt');
        expect(updatePayload.ok).toBe(true);
        expect(updatePayload.connection?.alias).toBe('mgmt-renamed');
        expect(updatePayload.connection?.remote_path).toBe(renamedPath);

        const updateMissing = runCli(variant, base, ['update', 'nope', '--port', '1', '--json']);
        expect(updateMissing.status).toBe(1);
        expect(parseJson<UpdatePayload>(updateMissing, 'update missing').ok).toBe(false);

        const removed = runCli(variant, base, ['remove', 'mgmt-renamed', '--json']);
        expect(removed.status).toBe(0);
        const removePayload = parseJson<RemovePayload>(removed, 'remove mgmt-renamed');
        expect(removePayload.ok).toBe(true);
        expect(removePayload.removed?.alias).toBe('mgmt-renamed');

        const removeAgain = runCli(variant, base, ['remove', 'mgmt-renamed', '--json']);
        expect(removeAgain.status).toBe(1);
        expect(parseJson<RemovePayload>(removeAgain, 'remove missing').ok).toBe(false);
      }, 60_000);

      test('refuses non-exact aliases outside a TTY and returns suggestions', () => {
        const base = isolation();
        const localFile = path.join(base.localDir, 'refusal.txt');
        fs.writeFileSync(localFile, 'x');

        const cases: Array<{ label: string; args: string[] }> = [
          { label: 'run', args: ['run', 'alph', '--json', '--', 'true'] },
          { label: 'show', args: ['show', 'alpa', '--json'] },
          { label: 'test', args: ['test', 'alph', '--json'] },
          { label: 'copy', args: ['copy', 'alpa', localFile, path.join(base.remoteDir, 'x'), '--json'] },
        ];

        for (const entry of cases) {
          const result = runCli(variant, base, entry.args);
          expect({ label: entry.label, status: result.status }).toEqual({ label: entry.label, status: 1 });
          const payload = parseJson<RefusalPayload>(result, entry.label);
          expect({ label: entry.label, ok: payload.ok }).toEqual({ label: entry.label, ok: false });
          expect({ label: entry.label, suggestions: payload.suggestions }).toEqual({
            label: entry.label,
            suggestions: expect.arrayContaining(['alpha']),
          });
        }

        const nonJson = runCli(variant, base, ['run', 'alph', '--', 'true']);
        expect(nonJson.status).toBe(1);
        expect(nonJson.stdout).toBe('');
        expect(nonJson.stderr).toContain('Alias not found: alph');
        expect(nonJson.stderr).toContain('Did you mean: alpha');

        const envJson = runCli(variant, base, ['run', 'alph', '--', 'true'], {
          env: { SSHYA_JSON: '1' },
        });
        expect(envJson.status).toBe(1);
        expect(parseJson<RefusalPayload>(envJson, 'SSHYA_JSON refusal').suggestions)
          .toEqual(expect.arrayContaining(['alpha']));

        const exact = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        expect(exact.status).toBe(0);
        expect(parseJson<RunPayload>(exact, 'exact run').ok).toBe(true);

        const printMissing = runCli(variant, base, ['print', 'nope', '--json']);
        expect(printMissing.status).toBe(1);
        expect(parseJson<{ ok: boolean }>(printMissing, 'print missing').ok).toBe(false);
      }, 60_000);
    });

    describe(`[${variant.name}] run`, () => {
      test('runs a command and reports stdout, stderr, exit code, and the default timeout', () => {
        const base = isolation();
        const result = runCli(variant, base, [
          'run', 'alpha', '--json', '--', "printf 'out\\n'; printf 'err\\n' >&2",
        ]);
        expect(result.status).toBe(0);
        const payload = parseJson<RunPayload>(result, 'run happy');
        expect(payload.ok).toBe(true);
        expect(payload.stdout).toBe('out\n');
        expect(payload.stderr).toBe('err\n');
        expect(payload.exitCode).toBe(0);
        expect(payload.timedOut).toBe(false);
        expect(payload.timeoutMs).toBe(120_000);
        expect(payload.cwd).toBe(base.remoteDir);
        expect(payload.target).toBe(`${sshd.user}@${sshd.host}:${sshd.port}`);
      }, 60_000);

      test('passes a remote non-zero exit code through', () => {
        const base = isolation();
        const result = runCli(variant, base, [
          'run', 'alpha', '--json', '--', "printf 'boom\\n' >&2; exit 7",
        ]);
        expect(result.status).toBe(7);
        const payload = parseJson<RunPayload>(result, 'run exit 7');
        expect(payload.ok).toBe(false);
        expect(payload.exitCode).toBe(7);
        expect(payload.stderr).toContain('boom');
      }, 60_000);

      test('caps large output and keeps either the head or the tail', () => {
        const base = isolation();
        const headResult = runCli(variant, base, [
          'run', 'alpha', '--json', '--max-output', '4k', '--', 'seq 1 2000',
        ]);
        expect(headResult.status).toBe(0);
        const head = parseJson<RunPayload>(headResult, 'run head');
        expect(head.stdoutBytes).toBe(8893);
        expect(head.stdoutLines).toBe(2000);
        expect(head.stdoutTruncated).toBe(true);
        expect(head.stdout).toContain('truncated: showing first');
        expect(head.stdout).toContain('1\n2\n');
        expect(head.stdout).not.toContain('2000');

        const tailResult = runCli(variant, base, [
          'run', 'alpha', '--json', '--max-output', '4k', '--tail', '--', 'seq 1 2000',
        ]);
        expect(tailResult.status).toBe(0);
        const tail = parseJson<RunPayload>(tailResult, 'run tail');
        expect(tail.stdoutBytes).toBe(8893);
        expect(tail.stdoutTruncated).toBe(true);
        expect(tail.stdout).toContain('truncated: showing last');
        expect(tail.stdout).toContain('2000');
      }, 60_000);

      test('keeps UTF-8 code points intact at both truncation boundaries', () => {
        const base = isolation();
        const command = "yes '€' | head -n 2000";

        const headResult = runCli(variant, base, [
          'run', 'alpha', '--json', '--max-output', '10', '--', command,
        ]);
        expect(headResult.status).toBe(0);
        const head = parseJson<RunPayload>(headResult, 'run utf8 head');
        expect(head.stdoutBytes).toBe(8000);
        expect(head.stdoutTruncated).toBe(true);
        expect(head.stdout.startsWith('€\n€\n')).toBe(true);
        expect(head.stdout).not.toContain('\uFFFD');

        const tailResult = runCli(variant, base, [
          'run', 'alpha', '--json', '--max-output', '10', '--tail', '--', command,
        ]);
        expect(tailResult.status).toBe(0);
        const tail = parseJson<RunPayload>(tailResult, 'run utf8 tail');
        expect(tail.stdoutBytes).toBe(8000);
        expect(tail.stdoutTruncated).toBe(true);
        expect(tail.stdout).toContain('€');
        expect(tail.stdout).not.toContain('\uFFFD');
      }, 60_000);

      test('times out with exit 124 and leaves no ssh process behind', () => {
        const base = isolation();
        const marker = `sshya-e2e-timeout-${variant.name}-${Date.now()}`;
        const result = runCli(variant, base, [
          'run', 'alpha', '--json', '--timeout', '2', '--no-reuse', '--', `sleep 10 # ${marker}`,
        ]);
        expect(result.status).toBe(124);
        expect(result.durationMs).toBeLessThan(6_000);
        const payload = parseJson<RunPayload>(result, 'run timeout');
        expect(payload.ok).toBe(false);
        expect(payload.timedOut).toBe(true);
        expect(payload.timeoutMs).toBe(2_000);
        expect(payload.errorKind).toBe('timeout');
        expect(payload.hint).toContain('aborted by sshya');
        expect(payload.durationMs).toBeLessThan(6_000);

        const leftovers = processesWithMarker(marker)
          .filter(entry => /\bssh\b/.test(entry.args));
        expect(leftovers).toEqual([]);
      }, 60_000);

      test('forwards piped stdin and honors --no-stdin', () => {
        const base = isolation();
        const forwardedPath = path.join(base.remoteDir, 'stdin-forwarded.txt');
        const forwarded = runCli(variant, base, [
          'run', 'alpha', '--json', '--', `cat > ${forwardedPath}; wc -c < ${forwardedPath}; cat ${forwardedPath}`,
        ], { input: 'hola\n' });
        expect(forwarded.status).toBe(0);
        const forwardedPayload = parseJson<RunPayload>(forwarded, 'run stdin');
        expect(forwardedPayload.stdout).toBe('5\nhola\n');

        const ignoredPath = path.join(base.remoteDir, 'stdin-ignored.txt');
        const ignored = runCli(variant, base, [
          'run', 'alpha', '--json', '--no-stdin', '--', `cat > ${ignoredPath}; wc -c < ${ignoredPath}`,
        ], { input: 'hola\n' });
        expect(ignored.status).toBe(0);
        const ignoredPayload = parseJson<RunPayload>(ignored, 'run no-stdin');
        expect(ignoredPayload.stdout).toBe('0\n');
        expect(fs.existsSync(ignoredPath)).toBe(true);
        expect(fs.readFileSync(ignoredPath, 'utf8')).toBe('');
      }, 60_000);

      test('exits promptly when the command ignores an open stdin pipe', async () => {
        const base = isolation();
        const result = await runCliWithOpenStdin(variant, base, [
          'run', 'alpha', '--json', '--', 'true',
        ]);
        expect(result.hung).toBe(false);
        expect(result.status).toBe(0);
        expect(result.durationMs).toBeLessThan(5_000);
        expect(parseJson<RunPayload>(result, 'open stdin true').ok).toBe(true);
      }, 60_000);

      test('times out when a command waits forever on an open stdin pipe', async () => {
        const base = isolation();
        const result = await runCliWithOpenStdin(variant, base, [
          'run', 'alpha', '--json', '--timeout', '2', '--', 'cat',
        ]);
        expect(result.hung).toBe(false);
        expect(result.status).toBe(124);
        expect(result.durationMs).toBeLessThan(6_000);
        const payload = parseJson<RunPayload>(result, 'open stdin cat');
        expect(payload.timedOut).toBe(true);
        expect(payload.timeoutMs).toBe(2_000);
      }, 60_000);
    });

    describe(`[${variant.name}] host keys and SSH failures`, () => {
      test('reports host-key, host-key-changed, auth, and refused errors with hints', () => {
        const base = isolation();
        const fresh = createIsolation(root, `${variant.name}-hostkey`, sshd, { preloadHostKey: false });
        extraIsolations.push({ variant, isolation: fresh });
        const freshEnv = {
          SSHYA_SSH_BIN: fresh.sshWrapper,
          SSHYA_SCP_BIN: fresh.scpWrapper,
          SSHYA_CONTROL_DIR: fresh.poolDir,
          HOME: fresh.home,
        };

        const strict = runCli(variant, base, ['run', 'alpha', '--json', '--no-reuse', '--', 'true'], {
          env: freshEnv,
        });
        expect(strict.status).toBe(255);
        const strictPayload = parseJson<RunPayload>(strict, 'host-key strict');
        expect(strictPayload.ok).toBe(false);
        expect(strictPayload.errorKind).toBe('host-key');
        expect(strictPayload.hint).toContain('accept-new-host-key');
        expect(fs.readFileSync(fresh.knownHosts, 'utf8')).toBe('');

        const accepted = runCli(variant, base, [
          'run', 'alpha', '--json', '--no-reuse', '--accept-new-host-key', '--', 'true',
        ], { env: freshEnv });
        expect(accepted.status).toBe(0);
        expect(parseJson<RunPayload>(accepted, 'host-key accept-new').ok).toBe(true);
        expect(fs.statSync(fresh.knownHosts).size).toBeGreaterThan(0);

        const known = runCli(variant, base, ['run', 'alpha', '--json', '--no-reuse', '--', 'true'], {
          env: freshEnv,
        });
        expect(known.status).toBe(0);
        expect(parseJson<RunPayload>(known, 'host-key known').ok).toBe(true);

        fs.writeFileSync(
          fresh.knownHosts,
          `[${sshd.host}]:${sshd.port} ${sshd.wrongPublicKey}\n`,
          { mode: 0o600 },
        );
        const changed = runCli(variant, base, ['run', 'alpha', '--json', '--no-reuse', '--', 'true'], {
          env: freshEnv,
        });
        expect(changed.status).toBe(255);
        const changedPayload = parseJson<RunPayload>(changed, 'host-key changed');
        expect(changedPayload.errorKind).toBe('host-key-changed');
        expect(changedPayload.hint).toContain('ssh-keygen -R');

        const auth = runCli(variant, base, [
          'run', 'wrongkey', '--json', '--no-reuse', '--', 'true',
        ]);
        expect(auth.status).toBe(255);
        const authPayload = parseJson<RunPayload>(auth, 'auth failure');
        expect(authPayload.errorKind).toBe('auth');
        expect(authPayload.stderr).toContain('Permission denied');
        expect(authPayload.hint).toContain('Authentication failed');

        const refused = runCli(variant, base, [
          'run', 'refused', '--json', '--no-reuse', '--', 'true',
        ]);
        expect(refused.status).toBe(255);
        const refusedPayload = parseJson<RunPayload>(refused, 'connection refused');
        expect(refusedPayload.errorKind).toBe('refused');
        expect(refusedPayload.hint).toContain('nothing is listening');
      }, 120_000);

      test('times out against a listener that never speaks', () => {
        const base = isolation();
        const startedAt = Date.now();
        const result = runCli(variant, base, [
          'run', 'silent', '--json', '--no-reuse', '--connect-timeout', '5', '--timeout', '2', '--', 'true',
        ]);
        expect(result.status).toBe(124);
        expect(Date.now() - startedAt).toBeLessThan(6_000);
        const payload = parseJson<RunPayload>(result, 'silent listener');
        expect(payload.timedOut).toBe(true);
        expect(payload.timeoutMs).toBe(2_000);
        expect(payload.errorKind).toBe('timeout');
      }, 60_000);

      test('test --json succeeds against the throwaway sshd', () => {
        const base = isolation();
        const result = runCli(variant, base, ['test', 'alpha', '--json']);
        expect(result.status).toBe(0);
        const payload = parseJson<{ ok: boolean; reused: boolean; durationMs: number }>(result, 'test');
        expect(payload.ok).toBe(true);
        expect(typeof payload.reused).toBe('boolean');
      }, 60_000);
    });

    describe(`[${variant.name}] copy`, () => {
      test('uploads and downloads a file', () => {
        const base = isolation();
        const localSource = path.join(base.localDir, 'upload.txt');
        const remotePath = path.join(base.remoteDir, 'copy', 'upload.txt');
        const localDownload = path.join(base.localDir, 'download.txt');
        fs.mkdirSync(path.dirname(remotePath), { recursive: true });
        fs.writeFileSync(localSource, 'hello-copy\n');

        const upload = runCli(variant, base, ['copy', 'alpha', localSource, remotePath, '--json']);
        expect(upload.status).toBe(0);
        const uploadPayload = parseJson<CopyPayload>(upload, 'copy upload');
        expect(uploadPayload.ok).toBe(true);
        expect(uploadPayload.exitCode).toBe(0);

        const remoteContents = runCli(variant, base, ['run', 'alpha', '--json', '--', `cat ${remotePath}`]);
        expect(remoteContents.status).toBe(0);
        expect(parseJson<RunPayload>(remoteContents, 'copy upload verify').stdout).toBe('hello-copy\n');

        const download = runCli(variant, base, [
          'copy', '--download', 'alpha', remotePath, localDownload, '--json',
        ]);
        expect(download.status).toBe(0);
        expect(parseJson<CopyPayload>(download, 'copy download').ok).toBe(true);
        expect(fs.readFileSync(localDownload, 'utf8')).toBe('hello-copy\n');
      }, 60_000);

      test('uploads and downloads a directory with -r', () => {
        const base = isolation();
        const localDir = path.join(base.localDir, 'tree');
        fs.mkdirSync(path.join(localDir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'one\n');
        fs.writeFileSync(path.join(localDir, 'sub', 'b.txt'), 'two\n');

        const remoteParent = path.join(base.remoteDir, 'copy-tree');
        fs.mkdirSync(remoteParent, { recursive: true });
        const upload = runCli(variant, base, ['copy', '-r', 'alpha', localDir, `${remoteParent}/`, '--json']);
        expect(upload.status).toBe(0);
        expect(parseJson<CopyPayload>(upload, 'copy directory upload').ok).toBe(true);

        const verify = runCli(variant, base, ['run', 'alpha', '--json', '--', `cat ${remoteParent}/tree/sub/b.txt`]);
        expect(verify.status).toBe(0);
        expect(parseJson<RunPayload>(verify, 'copy directory verify').stdout).toBe('two\n');

        const downloadParent = path.join(base.localDir, 'downloaded');
        fs.mkdirSync(downloadParent, { recursive: true });
        const download = runCli(variant, base, [
          'copy', '--download', '-r', 'alpha', `${remoteParent}/tree`, `${downloadParent}/`, '--json',
        ]);
        expect(download.status).toBe(0);
        expect(parseJson<CopyPayload>(download, 'copy directory download').ok).toBe(true);
        expect(fs.readFileSync(path.join(downloadParent, 'tree', 'a.txt'), 'utf8')).toBe('one\n');
        expect(fs.readFileSync(path.join(downloadParent, 'tree', 'sub', 'b.txt'), 'utf8')).toBe('two\n');
      }, 60_000);
    });

    describe(`[${variant.name}] doctor`, () => {
      test('--probe --json reports a reachable local connection', () => {
        const base = isolation();
        const doctorDb = path.join(base.root, 'doctor.json');
        const env = { SSHYA_DB: doctorDb };
        addAlias(variant, base, 'alpha', ['--remote-path', base.remoteDir], env);

        const result = runCli(variant, base, ['doctor', '--probe', '--json'], { env });
        expect(result.status).toBe(0);
        const payload = parseJson<DoctorPayload>(result, 'doctor');
        expect(payload.ok).toBe(true);
        expect(payload.db.path).toBe(doctorDb);
        expect(payload.db.connections).toBe(1);
        expect(payload.checks.map(check => check.id)).toEqual(expect.arrayContaining([
          'runtime', 'ssh-binary', 'scp-binary', 'database', 'keys', 'connection-pool', 'probe',
        ]));
        const runtime = payload.checks.find(check => check.id === 'runtime');
        expect(runtime?.summary).toContain(variant.name === 'bun' ? 'Bun' : 'Node');
        expect(payload.probes).toHaveLength(1);
        expect(payload.probes?.[0]?.alias).toBe('alpha');
        expect(payload.probes?.[0]?.ok).toBe(true);
      }, 60_000);
    });

    describe(`[${variant.name}] pooling`, () => {
      test('reuses a master, reports pool state, and honors --no-reuse and SSHYA_REUSE=0', async () => {
        const base = isolation();

        const closed = closeAllPools(variant, base);
        expect(closed.status).toBe(0);
        expect(parseJson<PoolClosePayload>(closed, 'pool close all').ok).toBe(true);

        const first = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        const second = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        const third = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        expect(first.status).toBe(0);
        expect(second.status).toBe(0);
        expect(third.status).toBe(0);
        const firstPayload = parseJson<RunPayload>(first, 'pool first');
        const secondPayload = parseJson<RunPayload>(second, 'pool second');
        const thirdPayload = parseJson<RunPayload>(third, 'pool third');
        expect(firstPayload.reused).toBe(false);
        expect(secondPayload.reused).toBe(true);
        expect(thirdPayload.reused).toBe(true);
        expect(secondPayload.durationMs).toBeLessThan(firstPayload.durationMs);
        expect(secondPayload.durationMs).toBeLessThan(100);

        const listed = runCli(variant, base, ['pool', 'list', '--json']);
        expect(listed.status).toBe(0);
        const listPayload = parseJson<PoolListPayload>(listed, 'pool list');
        expect(listPayload.supported).toBe(true);
        expect(listPayload.dir).toBe(base.poolDir);
        const alphaEntry = listPayload.entries.find(entry => entry.alias === 'alpha');
        expect(alphaEntry?.alive).toBe(true);
        expect(alphaEntry?.socket.startsWith(base.poolDir)).toBe(true);
        expect(typeof alphaEntry?.pid).toBe('number');

        const closedAlpha = runCli(variant, base, ['pool', 'close', 'alpha', '--json']);
        expect(closedAlpha.status).toBe(0);
        const closedPayload = parseJson<PoolClosePayload>(closedAlpha, 'pool close alpha');
        expect(closedPayload.ok).toBe(true);
        expect(closedPayload.results[0]?.alias).toBe('alpha');
        expect(closedPayload.results[0]?.closed).toBe(true);

        const afterClose = parseJson<PoolListPayload>(
          runCli(variant, base, ['pool', 'list', '--json']),
          'pool list after close',
        );
        expect(afterClose.entries.find(entry => entry.alias === 'alpha')?.alive).toBe(false);

        const noReuseCold = runCli(variant, base, ['run', 'alpha', '--json', '--no-reuse', '--', 'true']);
        expect(noReuseCold.status).toBe(0);
        expect(parseJson<RunPayload>(noReuseCold, 'no-reuse cold').reused).toBe(false);

        // Establish a warm master, then verify both switches bypass it without
        // tearing it down.
        const warm = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        expect(parseJson<RunPayload>(warm, 'pool warm').reused).toBe(false);
        const warmSecond = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        expect(parseJson<RunPayload>(warmSecond, 'pool warm second').reused).toBe(true);

        const noReuseWarm = runCli(variant, base, ['run', 'alpha', '--json', '--no-reuse', '--', 'true']);
        expect(parseJson<RunPayload>(noReuseWarm, 'no-reuse warm').reused).toBe(false);

        const envDisabled = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true'], {
          env: { SSHYA_REUSE: '0' },
        });
        expect(envDisabled.status).toBe(0);
        expect(parseJson<RunPayload>(envDisabled, 'SSHYA_REUSE=0').reused).toBe(false);

        const stillPooled = parseJson<PoolListPayload>(
          runCli(variant, base, ['pool', 'list', '--json']),
          'pool list after bypass',
        );
        const stillAlive = stillPooled.entries.find(entry => entry.alias === 'alpha');
        expect(stillAlive?.alive).toBe(true);
        expect(typeof stillAlive?.pid).toBe('number');

        // A crashed master can leave its socket file behind. ssh will replace
        // it, so the next call is cold and must report reused=false.
        process.kill(stillAlive!.pid!, 'SIGKILL');
        await delay(250);
        expect(fs.existsSync(stillAlive!.socket)).toBe(true);

        const staleSocket = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        expect(staleSocket.status).toBe(0);
        expect(parseJson<RunPayload>(staleSocket, 'stale control socket').reused).toBe(false);
        expect(fs.existsSync(stillAlive!.socket)).toBe(true);

        const rewarmed = runCli(variant, base, ['run', 'alpha', '--json', '--', 'true']);
        expect(rewarmed.status).toBe(0);
        expect(parseJson<RunPayload>(rewarmed, 'rewarmed pool').reused).toBe(true);

        console.log(
          `[e2e:${variant.name}:pool] ` +
          `first=${first.durationMs}ms (ssh=${firstPayload.durationMs}ms) ` +
          `warm=${second.durationMs}ms (ssh=${secondPayload.durationMs}ms) ` +
          `warm2=${third.durationMs}ms (ssh=${thirdPayload.durationMs}ms) ` +
          `no-reuse=${noReuseWarm.durationMs}ms ` +
          `env-off=${envDisabled.durationMs}ms`,
        );

        closeAllPools(variant, base);
      }, 120_000);
    });
  }

  describe('[mcp] stdio tools and policies', () => {
    test('runs commands, fans out to three aliases, and keeps protocol output clean', async () => {
      const session = await openMcp(mcpIsolation, []);
      try {
        const tools = (await session.client.listTools()).tools.map(tool => tool.name);
        expect(tools).toEqual(expect.arrayContaining([
          'list_connections',
          'get_connection',
          'add_connection',
          'update_connection',
          'remove_connection',
          'test_connection',
          'run_command',
          'run_on_many',
          'write_remote_file',
          'copy_file',
          'print_ssh_command',
          'import_connections',
        ]));

        const listed = await callToolJson<Array<{ alias: string }>>(session.client, 'list_connections');
        expect(listed.isError).toBe(false);
        expect(listed.data.map(connection => connection.alias)).toEqual(
          expect.arrayContaining(['alpha', 'beta', 'gamma']),
        );

        const run = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha',
          command: "printf 'mcp-hello\\n'",
        });
        expect(run.isError).toBe(false);
        expect(run.data.ok).toBe(true);
        expect(run.data.stdout).toBe('mcp-hello\n');
        expect(run.data.timeoutMs).toBe(120_000);

        const many = await callToolJson<{
          ok: boolean;
          summary: { total: number; succeeded: number; failed: number };
          results: Array<{ ok: boolean; alias: string; stdout: string }>;
        }>(session.client, 'run_on_many', {
          aliases: ['alpha', 'beta', 'gamma'],
          command: "printf 'many-ok\\n'",
          concurrency: 3,
        });
        expect(many.isError).toBe(false);
        expect(many.data.summary).toEqual({ total: 3, succeeded: 3, failed: 0 });
        expect(many.data.results.map(result => result.alias)).toEqual(['alpha', 'beta', 'gamma']);
        for (const result of many.data.results) {
          expect(result.ok).toBe(true);
          expect(result.stdout).toBe('many-ok\n');
        }

        expect(session.stderr()).toBe('');
      } finally {
        await session.close();
      }
    }, 60_000);

    test('writes text, base64, appended, mode-controlled, and nested files', async () => {
      const session = await openMcp(mcpIsolation, []);
      try {
        const configPath = path.join(mcpIsolation.remoteDir, 'mcp', 'sub', 'config.txt');
        const text = await callToolJson<{ ok: boolean; bytesWritten: number }>(
          session.client,
          'write_remote_file',
          { alias: 'alpha', path: configPath, content: 'hello-mcp\n', createParents: true, mode: '640' },
        );
        expect(text.isError).toBe(false);
        expect(text.data.ok).toBe(true);
        expect(text.data.bytesWritten).toBe(10);

        const textVerify = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha',
          command: `cat ${configPath}; stat -c %a ${configPath}`,
        });
        expect(textVerify.data.stdout).toBe('hello-mcp\n640\n');

        const binaryPath = path.join(mcpIsolation.remoteDir, 'mcp', 'bin.dat');
        const binary = await callToolJson<{ ok: boolean; encoding: string }>(
          session.client,
          'write_remote_file',
          {
            alias: 'alpha',
            path: binaryPath,
            content: Buffer.from([0, 1, 2, 255]).toString('base64'),
            encoding: 'base64',
          },
        );
        expect(binary.isError).toBe(false);
        expect(binary.data.ok).toBe(true);
        expect(binary.data.encoding).toBe('base64');

        const binaryVerify = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha',
          command: `od -An -tx1 ${binaryPath}`,
        });
        expect(binaryVerify.data.stdout.trim()).toBe('00 01 02 ff');

        const appendPath = path.join(mcpIsolation.remoteDir, 'mcp', 'append.txt');
        await callToolJson(session.client, 'write_remote_file', {
          alias: 'alpha', path: appendPath, content: 'one',
        });
        const appended = await callToolJson<{ ok: boolean; appended: boolean }>(
          session.client,
          'write_remote_file',
          { alias: 'alpha', path: appendPath, content: 'two', append: true },
        );
        expect(appended.data.ok).toBe(true);
        expect(appended.data.appended).toBe(true);

        const appendVerify = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha',
          command: `cat ${appendPath}`,
        });
        expect(appendVerify.data.stdout).toBe('onetwo');

        const stdinRun = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha',
          command: 'cat',
          stdin: 'piped-through-mcp\n',
        });
        expect(stdinRun.data.ok).toBe(true);
        expect(stdinRun.data.stdout).toBe('piped-through-mcp\n');

        expect(session.stderr()).toBe('');
      } finally {
        await session.close();
      }
    }, 60_000);

    test('copies files and enforces per-connection readonly', async () => {
      const session = await openMcp(mcpIsolation, []);
      try {
        const localSource = path.join(mcpIsolation.localDir, 'mcp-upload.txt');
        const remoteCopy = path.join(mcpIsolation.remoteDir, 'mcp', 'copy.txt');
        const localDownload = path.join(mcpIsolation.localDir, 'mcp-download.txt');
        fs.mkdirSync(path.dirname(remoteCopy), { recursive: true });
        fs.writeFileSync(localSource, 'mcp-copy\n');

        const upload = await callToolJson<CopyPayload>(session.client, 'copy_file', {
          alias: 'alpha', source: localSource, destination: remoteCopy, direction: 'upload',
        });
        expect(upload.isError).toBe(false);
        expect(upload.data.ok).toBe(true);

        const uploadVerify = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha', command: `cat ${remoteCopy}`,
        });
        expect(uploadVerify.data.stdout).toBe('mcp-copy\n');

        const download = await callToolJson<CopyPayload>(session.client, 'copy_file', {
          alias: 'alpha', source: remoteCopy, destination: localDownload, direction: 'download',
        });
        expect(download.isError).toBe(false);
        expect(download.data.ok).toBe(true);
        expect(fs.readFileSync(localDownload, 'utf8')).toBe('mcp-copy\n');

        const added = await callToolJson<{
          ok: boolean;
          created: boolean;
          connection: { alias: string; readonly?: boolean };
        }>(session.client, 'add_connection', {
          alias: 'ro',
          user: sshd.user,
          host: sshd.host,
          port: sshd.port,
          keyPath: sshd.clientKeyPath,
          readonly: true,
        });
        expect(added.isError).toBe(false);
        expect(added.data.created).toBe(true);
        expect(added.data.connection.readonly).toBe(true);

        const refusedWrite = await callToolJson<{ ok: boolean; errorKind: string }>(
          session.client,
          'write_remote_file',
          { alias: 'ro', path: path.join(mcpIsolation.remoteDir, 'mcp', 'nope.txt'), content: 'x' },
        );
        expect(refusedWrite.isError).toBe(true);
        expect(refusedWrite.data.errorKind).toBe('connection_readonly');
        expect(fs.existsSync(path.join(mcpIsolation.remoteDir, 'mcp', 'nope.txt'))).toBe(false);

        const refusedUpload = await callToolJson<{ ok: boolean; errorKind: string }>(
          session.client,
          'copy_file',
          { alias: 'ro', source: localSource, destination: remoteCopy, direction: 'upload' },
        );
        expect(refusedUpload.isError).toBe(true);
        expect(refusedUpload.data.errorKind).toBe('connection_readonly');

        const allowedDownload = await callToolJson<CopyPayload>(session.client, 'copy_file', {
          alias: 'ro',
          source: remoteCopy,
          destination: path.join(mcpIsolation.localDir, 'ro-download.txt'),
          direction: 'download',
        });
        expect(allowedDownload.isError).toBe(false);
        expect(allowedDownload.data.ok).toBe(true);

        const runAllowed = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'ro', command: "printf 'readonly-run\\n'",
        });
        expect(runAllowed.data.ok).toBe(true);
        expect(runAllowed.data.stdout).toBe('readonly-run\n');

        const cleared = await callToolJson<{ ok: boolean; connection: { readonly?: boolean } }>(
          session.client,
          'update_connection',
          { alias: 'ro', readonly: false },
        );
        expect(cleared.isError).toBe(false);
        expect(cleared.data.connection.readonly).toBeUndefined();

        const writeAfterClear = await callToolJson<{ ok: boolean }>(session.client, 'write_remote_file', {
          alias: 'ro', path: path.join(mcpIsolation.remoteDir, 'mcp', 'allowed.txt'), content: 'ok',
        });
        expect(writeAfterClear.isError).toBe(false);
        expect(writeAfterClear.data.ok).toBe(true);

        expect(session.stderr()).toBe('');
      } finally {
        await session.close();
      }
    }, 60_000);

    test('--aliases filters listings and refuses every alias-targeting tool', async () => {
      const session = await openMcp(mcpIsolation, ['--aliases', 'alpha*']);
      try {
        const listed = await callToolJson<Array<{ alias: string }>>(session.client, 'list_connections');
        expect(listed.data.map(connection => connection.alias)).toEqual(['alpha']);

        const guide = await readResourceText(session.client, 'sshya://guide');
        expect(guide).toContain('Allowed aliases: alpha*.');
        expectNoAnsi(guide, 'MCP guide');

        const calls: Array<[string, Record<string, unknown>]> = [
          ['get_connection', { alias: 'beta' }],
          ['test_connection', { alias: 'beta' }],
          ['run_command', { alias: 'beta', command: 'true' }],
          ['run_on_many', { aliases: ['alpha', 'beta'], command: 'true' }],
          ['write_remote_file', { alias: 'beta', path: '/tmp/x', content: 'x' }],
          ['copy_file', { alias: 'beta', source: '/tmp/a', destination: '/tmp/b', direction: 'download' }],
          ['print_ssh_command', { alias: 'beta' }],
          ['update_connection', { alias: 'beta', host: 'changed.example.test' }],
          ['remove_connection', { alias: 'beta' }],
          ['add_connection', { alias: 'prod', user: 'u', host: 'prod.example.test' }],
        ];

        for (const [name, args] of calls) {
          const result = await callToolJson<{ ok: boolean; errorKind?: string }>(session.client, name, args);
          expect({ name, isError: result.isError }).toEqual({ name, isError: true });
          expect({ name, errorKind: result.data.errorKind }).toEqual({ name, errorKind: 'alias_not_allowed' });
        }

        const allowed = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha', command: "printf 'allowed\\n'",
        });
        expect(allowed.isError).toBe(false);
        expect(allowed.data.stdout).toBe('allowed\n');

        expect(session.stderr()).toBe('');
      } finally {
        await session.close();
      }
    }, 60_000);

    test('--read-only removes mutating tools, refuses uploads, and still runs commands', async () => {
      const session = await openMcp(mcpIsolation, ['--read-only']);
      try {
        const tools = (await session.client.listTools()).tools.map(tool => tool.name);
        for (const hidden of [
          'add_connection', 'update_connection', 'remove_connection',
          'import_connections', 'write_remote_file',
        ]) {
          expect(tools).not.toContain(hidden);
        }
        for (const present of [
          'list_connections', 'get_connection', 'test_connection',
          'run_command', 'run_on_many', 'copy_file', 'print_ssh_command',
        ]) {
          expect(tools).toContain(present);
        }

        const upload = await callToolJson<{ ok: boolean; errorKind: string }>(session.client, 'copy_file', {
          alias: 'alpha',
          source: path.join(mcpIsolation.localDir, 'mcp-upload.txt'),
          destination: path.join(mcpIsolation.remoteDir, 'mcp', 'readonly-upload.txt'),
          direction: 'upload',
        });
        expect(upload.isError).toBe(true);
        expect(upload.data.errorKind).toBe('read_only');

        const download = await callToolJson<CopyPayload>(session.client, 'copy_file', {
          alias: 'alpha',
          source: path.join(mcpIsolation.remoteDir, 'mcp', 'copy.txt'),
          destination: path.join(mcpIsolation.localDir, 'readonly-download.txt'),
          direction: 'download',
        });
        expect(download.isError).toBe(false);
        expect(download.data.ok).toBe(true);

        const run = await callToolJson<RunPayload>(session.client, 'run_command', {
          alias: 'alpha', command: "printf 'readonly-ok\\n'",
        });
        expect(run.isError).toBe(false);
        expect(run.data.stdout).toBe('readonly-ok\n');

        const guide = await readResourceText(session.client, 'sshya://guide');
        expect(guide).toContain('Read-only: yes.');
        expect(guide).toContain('not the remote host');

        const missing = await session.client.callTool({
          name: 'write_remote_file',
          arguments: { alias: 'alpha', path: '/tmp/x', content: 'x' },
        }).then(
          result => ({
            unavailable: result.isError === true,
            text: String((result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? ''),
          }),
          (error: unknown) => ({ unavailable: true, text: String(error) }),
        );
        expect(missing.unavailable).toBe(true);

        expect(session.stderr()).toBe('');
      } finally {
        await session.close();
      }
    }, 60_000);

    test('emits only JSON-RPC lines on stdout and no ANSI escapes', async () => {
      const result = await probeRawMcp();
      expect(result.stderr).toBe('');
      expect(result.lines.length).toBeGreaterThanOrEqual(2);
      for (const line of result.lines) {
        expectNoAnsi(line, 'raw MCP stdout');
        expect(() => JSON.parse(line)).not.toThrow();
      }
      const messages = result.lines.map(line => JSON.parse(line) as {
        id?: number;
        result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }> };
      });
      const initialize = messages.find(message => message.id === 1);
      expect(initialize?.result?.serverInfo?.name).toBe('sshya');
      const tools = messages.find(message => message.id === 2);
      expect(Array.isArray(tools?.result?.tools)).toBe(true);
    }, 60_000);
  });
});

interface McpSession {
  client: Client;
  transport: StdioClientTransport;
  stderr(): string;
  close(): Promise<void>;
}

const openMcp = async (
  isolation: Isolation,
  extraArgs: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<McpSession> => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(REPO_ROOT, 'dist', 'index.js'), 'mcp', ...extraArgs],
    env: toEnvRecord(isolation, envOverrides),
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });

  let stderrText = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrText += String(chunk);
  });

  const client = new Client({ name: 'sshya-e2e', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    transport,
    stderr: () => stderrText,
    close: async () => {
      await client.close();
    },
  };
};

interface ToolJson<T> {
  isError: boolean;
  data: T;
  text: string;
}

const callToolJson = async <T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolJson<T>> => {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find(entry => entry.type === 'text')?.text;
  if (text === undefined) {
    throw new Error(`MCP tool ${name} returned no text content`);
  }
  expectNoAnsi(text, `MCP ${name}`);
  return {
    isError: result.isError === true,
    data: JSON.parse(text) as T,
    text,
  };
};

const readResourceText = async (client: Client, uri: string): Promise<string> => {
  const result = await client.readResource({ uri });
  const first = result.contents[0] as { text?: string } | undefined;
  if (!first?.text) {
    throw new Error(`MCP resource ${uri} returned no text`);
  }
  return first.text;
};

const probeRawMcp = (): Promise<{ lines: string[]; stderr: string }> => new Promise((resolve, reject) => {
  const child = spawn('node', [path.join(REPO_ROOT, 'dist', 'index.js'), 'mcp'], {
    cwd: REPO_ROOT,
    env: toEnvRecord(mcpIsolation),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderrText = '';
  const lines: string[] = [];
  let phase = 0;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;

  const finish = (error?: Error): void => {
    if (finished) {
      return;
    }
    finished = true;
    if (timer) {
      clearTimeout(timer);
    }
    child.stdin.end();
    child.kill('SIGTERM');
    if (error) {
      reject(error);
    } else {
      resolve({ lines, stderr: stderrText });
    }
  };

  timer = setTimeout(() => {
    finish(new Error(`raw MCP probe timed out; lines=${JSON.stringify(lines)} stderr=${stderrText}`));
  }, 10_000);

  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrText += chunk; });

  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      let message: { id?: number };
      try {
        message = JSON.parse(line) as { id?: number };
      } catch {
        finish(new Error(`non-JSON stdout line from MCP server: ${JSON.stringify(line)}`));
        return;
      }

      if (message.id === 1 && phase === 0) {
        phase = 1;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (message.id === 2 && phase === 1) {
        phase = 2;
        finish();
        return;
      }
      index = buffer.indexOf('\n');
    }
  });

  child.once('error', error => finish(error));
  child.once('exit', code => {
    if (!finished) {
      finish(new Error(`MCP server exited before the raw probe finished (code=${code})\n${stderrText}`));
    }
  });

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sshya-e2e-raw', version: '0.0.0' },
    },
  });
});
