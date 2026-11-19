/**
 * 06 — Hot path after startup: per-call cost of `run` and the MCP tools against
 * a real local sshd (warm ControlMaster), plus a deterministic count of the
 * processes each call spawns on the remote side.
 *
 * Run:
 *   bun run build
 *   bun run bench/06-hot-path.ts
 *
 * Everything is isolated: a throwaway sshd on 127.0.0.1, a temporary HOME,
 * connection store, control-socket directory, and known_hosts (the same fixture
 * the e2e suite uses). ~/.sshya and ~/.ssh are never read or written.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  REPO_ROOT,
  createIsolation,
  startSshd,
  stopSshd,
  type Isolation,
  type SshdHandle,
} from '../e2e/harness';
import { createFakeSsh } from './lib/harness';

const NODE = process.execPath;
const DIST = path.join(REPO_ROOT, 'dist/index.js');
const ITERATIONS = 20;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

const round = (value: number): number => Number(value.toFixed(2));

interface Row {
  step: string;
  n: number;
  medianMs: number;
  p95Ms: number;
  note?: string;
}

const runCli = (
  iso: Isolation,
  args: string[],
): { status: number | null; stdout: string; stderr: string; wallMs: number; durationMs?: number } => {
  const started = performance.now();
  const result = spawnSync(NODE, [DIST, ...args], {
    cwd: REPO_ROOT,
    env: iso.env(),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const wallMs = performance.now() - started;
  let durationMs: number | undefined;
  try {
    durationMs = Number(JSON.parse(result.stdout ?? '').durationMs);
  } catch {
    durationMs = undefined;
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', wallMs, durationMs };
};

const timeCli = (iso: Isolation, label: string, args: string[], n: number, note?: string): Row => {
  runCli(iso, args);
  const walls: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const result = runCli(iso, args);
    if (result.status !== 0) {
      throw new Error(`${label} failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    walls.push(result.wallMs);
  }
  return { step: label, n, medianMs: round(median(walls)), p95Ms: round(percentile(walls, 95)), note };
};

interface McpSession {
  client: Client;
  close: () => Promise<void>;
}

const startMcp = async (iso: Isolation): Promise<McpSession> => {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [DIST, 'mcp'],
    cwd: REPO_ROOT,
    env: iso.env() as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'sshya-hot-path-bench', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
};

const callTool = async (session: McpSession, name: string, args: Record<string, unknown>): Promise<void> => {
  const result = await session.client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
};

const timeMcp = async (
  session: McpSession,
  label: string,
  name: string,
  args: () => Record<string, unknown>,
  n: number,
  note?: string,
): Promise<Row> => {
  for (let index = 0; index < 3; index += 1) {
    await callTool(session, name, args());
  }
  const samples: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const started = performance.now();
    await callTool(session, name, args());
    samples.push(performance.now() - started);
  }
  return { step: label, n, medianMs: round(median(samples)), p95Ms: round(percentile(samples, 95)), note };
};

interface TracedSession {
  call: (name: string, args: Record<string, unknown>) => Promise<void>;
  execCount: () => number;
  close: () => Promise<void>;
}

/**
 * A minimal JSON-RPC client over a `strace -f -e trace=execve` server. It counts
 * execve calls. The fake ssh used here (`FAKE_SSH_EXEC=1`) runs the remote
 * command locally, so remote-side `stat`/`sed`/`grep` spawns land in the same
 * trace: the count is deterministic and does not depend on timing.
 */
const startTracedMcp = async (env: NodeJS.ProcessEnv, traceFile: string): Promise<TracedSession> => {
  const child = spawn('strace', ['-f', '-e', 'trace=execve', '-qq', '-o', traceFile, NODE, DIST, 'mcp'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let buffer = '';
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)!(message);
          pending.delete(message.id);
        }
      } catch {
        // Ignore non-JSON output.
      }
    }
  });

  let nextId = 1;
  const rpc = (method: string, params: unknown): Promise<unknown> => new Promise((resolve) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sshya-hot-path-bench', version: '0.0.0' },
  });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const execCount = (): number => {
    try {
      return fs.readFileSync(traceFile, 'utf8')
        .split('\n')
        .filter(line => line.includes('execve(') && !line.includes('= -1'))
        .length;
    } catch {
      return 0;
    }
  };

  return {
    call: async (name, args) => {
      await rpc('tools/call', { name, arguments: args });
    },
    execCount,
    close: async () => {
      child.stdin!.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
};

const main = async () => {
  if (!fs.existsSync(DIST)) {
    throw new Error(`${DIST} is missing; run "bun run build" first`);
  }

  const tmpBase = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();
  const root = fs.mkdtempSync(path.join(tmpBase, 'sshya-hot-path-'));
  const sshd: SshdHandle = await startSshd();
  const iso = createIsolation(root, 'hot-path', sshd);
  const rows: Row[] = [];
  const spawnRows: Array<{ step: string; execPerCall: number }> = [];

  try {
    const seed = spawnSync(
      NODE,
      [DIST, 'add', 'local', `${sshd.user}@${sshd.host}`, '-p', String(sshd.port), '-k', sshd.clientKeyPath, '-r', iso.remoteDir, '--json'],
      { cwd: REPO_ROOT, env: iso.env(), encoding: 'utf8' },
    );
    if (seed.status !== 0) {
      throw new Error(`could not seed the store: ${seed.stdout}\n${seed.stderr}`);
    }

    const file = path.join(iso.remoteDir, 'app.conf');
    fs.writeFileSync(file, Array.from({ length: 120 }, (_, index) => `line_${index + 1}=${'x'.repeat(20)}`).join('\n') + '\n');
    const target = path.join(iso.remoteDir, 'target.conf');
    fs.writeFileSync(target, 'alpha=1\nbeta=2\ngamma=3\n');
    const paths = Array.from({ length: 10 }, (_, index) => {
      const filePath = path.join(iso.remoteDir, `stat_${index}.conf`);
      fs.writeFileSync(filePath, 'x'.repeat(100));
      return filePath;
    });
    const bigFile = path.join(iso.remoteDir, 'big.conf');
    fs.writeFileSync(bigFile, Array.from({ length: 200_000 }, (_, index) => `line_${index}=${'y'.repeat(20)}`).join('\n') + '\n');

    // --- CLI ---
    const coldWalls: number[] = [];
    let coldInner = 0;
    for (let index = 0; index < 5; index += 1) {
      runCli(iso, ['pool', 'close', '--all', '--json']);
      const result = runCli(iso, ['run', 'local', '--json', '--', 'true']);
      if (result.status !== 0) throw new Error(`cold run failed: ${result.stdout} ${result.stderr}`);
      coldWalls.push(result.wallMs);
      coldInner = result.durationMs ?? 0;
    }
    rows.push({
      step: 'CLI run --json cold (first ControlMaster)',
      n: coldWalls.length,
      medianMs: round(median(coldWalls)),
      p95Ms: round(percentile(coldWalls, 95)),
      note: `last in-process durationMs=${coldInner}`,
    });
    rows.push(timeCli(iso, 'CLI run --json warm pooled', ['run', 'local', '--json', '--', 'true'], ITERATIONS, 'includes ~160 ms Node startup'));
    rows.push(timeCli(
      iso,
      'CLI run --json warm, 4 KiB stdout',
      ['run', 'local', '--json', '--', 'head -c 4096 /dev/zero | tr "\\0" x'],
      10,
    ));

    // --- MCP (real stdio server, real sshd) ---
    const session = await startMcp(iso);
    try {
      // Establish the pool through the server itself.
      await callTool(session, 'run_command', { alias: 'local', command: 'true' });
      rows.push(await timeMcp(session, 'MCP run_command true (warm pool)', 'run_command', () => ({ alias: 'local', command: 'true' }), 30));
      rows.push(await timeMcp(
        session,
        'MCP run_command 4 KiB stdout',
        'run_command',
        () => ({ alias: 'local', command: 'head -c 4096 /dev/zero | tr "\\0" x' }),
        15,
      ));
      rows.push(await timeMcp(session, 'MCP read_remote_file (120-line file)', 'read_remote_file', () => ({ alias: 'local', path: file }), 15));
      rows.push(await timeMcp(session, 'MCP read_remote_file (200k-line file)', 'read_remote_file', () => ({ alias: 'local', path: bigFile, limit: 50 }), 10));
      rows.push(await timeMcp(session, 'MCP stat_remote (1 path)', 'stat_remote', () => ({ alias: 'local', paths: [file] }), 15));
      rows.push(await timeMcp(session, 'MCP stat_remote (10 paths)', 'stat_remote', () => ({ alias: 'local', paths }), 10));
      rows.push(await timeMcp(session, 'MCP grep_remote (single file)', 'grep_remote', () => ({ alias: 'local', pattern: 'line_1', path: file }), 10));
      let counter = 0;
      rows.push(await timeMcp(
        session,
        'MCP replace_in_remote_file',
        'replace_in_remote_file',
        () => {
          counter += 1;
          const current = fs.readFileSync(target, 'utf8');
          const oldText = /beta=\d+/.exec(current)![0];
          return { alias: 'local', path: target, oldText, newText: `beta=${counter}` };
        },
        10,
      ));
      let writeCounter = 0;
      rows.push(await timeMcp(
        session,
        'MCP write_remote_file atomic=true',
        'write_remote_file',
        () => {
          writeCounter += 1;
          return { alias: 'local', path: path.join(iso.remoteDir, 'write.conf'), content: `v=${writeCounter}\n`, atomic: true };
        },
        10,
      ));
      rows.push(await timeMcp(session, 'MCP list_connections (no ssh)', 'list_connections', () => ({}), 20));
    } finally {
      await session.close();
    }

    // --- Deterministic process count per call (strace execve) ---
    // The fake ssh executes the remote command locally, so remote tool spawns
    // are visible to strace. `run_command true` is the fixed cost (fake ssh +
    // `/bin/sh -c`); the other rows report that same baseline plus the remote
    // processes the tool needs.
    if (spawnSync('strace', ['-V']).status === 0) {
      const fake = createFakeSsh(root);
      const traceFile = path.join(root, 'execve.log');
      const traced = await startTracedMcp(
        iso.env({ SSHYA_SSH_BIN: fake.ssh, FAKE_SSH_EXEC: '1', FAKE_SSH_DIR: fake.sshDir }),
        traceFile,
      );
      try {
        const countFor = async (step: string, name: string, args: Record<string, unknown>, n: number) => {
          await traced.call(name, args);
          const before = traced.execCount();
          for (let index = 0; index < n; index += 1) await traced.call(name, args);
          const after = traced.execCount();
          spawnRows.push({ step, execPerCall: (after - before) / n });
        };
        await countFor('run_command true', 'run_command', { alias: 'local', command: 'true' }, 5);
        await countFor('read_remote_file', 'read_remote_file', { alias: 'local', path: file }, 3);
        await countFor('stat_remote (1 path)', 'stat_remote', { alias: 'local', paths: [file] }, 3);
        await countFor('stat_remote (10 paths)', 'stat_remote', { alias: 'local', paths }, 2);
        await countFor('replace_in_remote_file', 'replace_in_remote_file', { alias: 'local', path: target, oldText: 'alpha=1', newText: 'alpha=1' }, 2);
        await countFor('write_remote_file atomic', 'write_remote_file', { alias: 'local', path: path.join(iso.remoteDir, 'traced.conf'), content: 'x\n', atomic: true }, 2);
      } finally {
        await traced.close();
      }
    } else {
      console.log('strace not available: skipping the per-call process count');
    }

    const result = {
      environment: {
        platform: process.platform,
        node: process.version,
        sshd: `${sshd.host}:${sshd.port}`,
        iterations: ITERATIONS,
        note: 'real local sshd; CLI wall time includes Node startup',
      },
      cliAndMcp: rows,
      execPerCall: spawnRows,
    };

    const resultsDir = path.join(REPO_ROOT, 'bench', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const outFile = path.join(resultsDir, 'hot-path.json');
    fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);

    console.log('\nHOT PATH (median / p95 ms; real local sshd, warm ControlMaster)\n');
    console.log('step'.padEnd(46) + 'n'.padStart(4) + 'median'.padStart(9) + 'p95'.padStart(9));
    for (const row of rows) {
      console.log(
        row.step.padEnd(46)
        + String(row.n).padStart(4)
        + `${row.medianMs}`.padStart(9)
        + `${row.p95Ms}`.padStart(9)
        + (row.note ? `  (${row.note})` : ''),
      );
    }
    if (spawnRows.length > 0) {
      console.log('\nEXECVE PER CALL (fake exec ssh; `run_command true` is the 2-process baseline)\n');
      for (const row of spawnRows) {
        console.log(row.step.padEnd(34) + `${row.execPerCall}`.padStart(4));
      }
    }
    console.log(`\nwrote ${outFile}`);
  } finally {
    runCli(iso, ['pool', 'close', '--all', '--json']);
    await stopSshd(sshd);
    fs.rmSync(root, { recursive: true, force: true });
  }
};

await main();
