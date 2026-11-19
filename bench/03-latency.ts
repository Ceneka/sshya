/**
 * 03 — Latency: MCP overhead vs process spawn, and pooled-vs-cold bookkeeping.
 *
 * IMPORTANT: no local sshd is running on 127.0.0.1:22 in this environment, so
 * real SSH handshake / ControlMaster reuse latency was NOT measured. Instead:
 *   - baseline: spawning the same fake ssh directly (process floor)
 *   - sshya direct: executeSshCommand on the fake ssh (spawn + capture + classify)
 *   - sshya MCP:   run_command through the real in-process MCP server (adds DB
 *                  usage write + JSON + protocol)
 *   - "warm flag": pre-create the ControlMaster socket path so hasControlSocket()
 *                  is true. This measures sshya's bookkeeping only; the fake ssh
 *                  still spawns a fresh process.
 *
 * Run: bun run bench/03-latency.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import { executeSshCommand } from '../src/connection/run';
import { controlSocketPath } from '../src/helpers/control';
import {
  createBenchEnv,
  median,
  percentile,
  seedConnections,
  startBenchClient,
  writeHostFixture,
  writeResults,
} from './lib/harness';
import { fmt } from './lib/tokenizer';

const ITERATIONS = 40;

interface Timing {
  label: string;
  iterations: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  note?: string;
}

const timeIt = async (label: string, iterations: number, fn: () => Promise<unknown>, note?: string): Promise<Timing> => {
  // Warmup: JIT, module init, process cache.
  for (let index = 0; index < 3; index += 1) await fn();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return {
    label,
    iterations,
    medianMs: Number(median(samples).toFixed(2)),
    p95Ms: Number(percentile(samples, 95).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
    note,
  };
};

const spawnFloor = async (binary: string, args: string[]): Promise<void> => {
  await new Promise<void>((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
};

const main = async () => {
  const paths = createBenchEnv('sshya-bench-latency');
  const connections = seedConnections(paths.db, { count: 10 });
  const bench = await startBenchClient(paths);
  const rows: Timing[] = [];

  writeHostFixture(paths.sshDir, '_default', {
    out: ' 14:02:01 up 12 days,  3:14,  1 user,  load average: 0.08, 0.11, 0.09\n',
  });

  try {
    rows.push(await timeIt(
      'process floor: spawn fake ssh directly',
      ITERATIONS,
      () => spawnFloor(paths.ssh, ['-T', 'deploy@10.0.0.11']),
      'OS process spawn + /bin/sh script; no sshya code',
    ));

    rows.push(await timeIt(
      'sshya direct: executeSshCommand (cold, small stdout)',
      ITERATIONS,
      () => executeSshCommand(connections[0]!, 'uptime', { reuse: false }),
      'spawn + byte capture + error classification; no MCP, no DB usage write',
    ));

    rows.push(await timeIt(
      'MCP run_command (10 connections, cold)',
      ITERATIONS,
      () => bench.callTool('run_command', { alias: 'web01', command: 'uptime', reuse: false }),
      'adds recordConnectionUsage (rewrites the whole store) + minified compact JSON + protocol',
    ));

    // Warm-flag path: hasControlSocket() true, so reuse is reported even though
    // the fake binary cannot actually multiplex.
    for (const connection of connections) {
      fs.writeFileSync(controlSocketPath(connection), '');
    }
    rows.push(await timeIt(
      'MCP run_command (warm pool flag, 10 connections)',
      ITERATIONS,
      () => bench.callTool('run_command', { alias: 'web01', command: 'uptime' }),
      'reused=true bookkeeping only: the fake ssh still spawns; NOT a real pooled RTT',
    ));

    seedConnections(paths.db, { count: 50 });
    rows.push(await timeIt(
      'MCP run_command (50 connections, cold)',
      20,
      () => bench.callTool('run_command', { alias: 'web01', command: 'uptime', reuse: false }),
      'same work; measures the store rewrite cost as the fleet grows',
    ));

    rows.push(await timeIt(
      'MCP list_connections (50)',
      ITERATIONS,
      () => bench.callTool('list_connections', {}),
      'no ssh spawn; DB read + serialize the compact summary (alias/target/keyPath/remotePath)',
    ));

    rows.push(await timeIt(
      'MCP test_connection (cold)',
      ITERATIONS,
      () => bench.callTool('test_connection', { alias: 'web01', reuse: false }),
      'runs `true` through the same executor',
    ));

    const manyHosts = Array.from({ length: 10 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);
    for (const host of manyHosts) {
      writeHostFixture(paths.sshDir, host, { out: '/dev/sda1        98G   41G   52G  45% /\n' });
    }
    rows.push(await timeIt(
      'MCP run_on_many (10 hosts, concurrency 4)',
      15,
      () => bench.callTool('run_on_many', { aliases: manyHosts, command: 'df -h /' }),
      'ten fake ssh processes, four at a time',
    ));

    // Large response: isolates capture + JSON serialization at the MCP default
    // (8 KiB stdout, head+tail).
    writeHostFixture(paths.sshDir, '_default', { out: 'x'.repeat(64 * 1024) });
    rows.push(await timeIt(
      'MCP run_command (64 KiB stdout, 8 KiB headtail)',
      15,
      () => bench.callTool('run_command', { alias: 'web01', command: 'cat big', reuse: false }),
      'capture 64 KiB, keep 4+4 KiB, minify (~2.8k-token response)',
    ));

    // 5-connection list for a direct apples-to-apples comparison.
    seedConnections(paths.db, { count: 5 });
    const list5 = await timeIt(
      'MCP list_connections (5, reseeded)',
      ITERATIONS,
      () => bench.callTool('list_connections', {}),
    );
    rows.push(list5);

    const direct = rows.find(row => row.label.startsWith('sshya direct'))!;
    const floor = rows.find(row => row.label.startsWith('process floor'))!;
    const mcpCold = rows.find(row => row.label.startsWith('MCP run_command (10'))!;

    const result = {
      environment: {
        platform: process.platform,
        bun: Bun.version,
        localSshd: 'not running on 127.0.0.1:22; real network latency NOT measured',
        iterations: ITERATIONS,
      },
      timings: rows,
      derived: {
        sshyaDirectOverheadMs: Number((direct.medianMs - floor.medianMs).toFixed(2)),
        mcpOverheadOverDirectMs: Number((mcpCold.medianMs - direct.medianMs).toFixed(2)),
        mcpOverheadOverFloorMs: Number((mcpCold.medianMs - floor.medianMs).toFixed(2)),
      },
    };
    const file = writeResults('latency.json', result);

    console.log('LATENCY (median / p95 milliseconds; local fake ssh, no network)\n');
    console.log('step'.padEnd(52) + 'median'.padStart(8) + 'p95'.padStart(8) + 'min'.padStart(8) + 'max'.padStart(8));
    for (const row of rows) {
      console.log(
        row.label.padEnd(52)
        + `${row.medianMs}`.padStart(8)
        + `${row.p95Ms}`.padStart(8)
        + `${row.minMs}`.padStart(8)
        + `${row.maxMs}`.padStart(8),
      );
    }
    console.log('\ninterpretation');
    console.log(`  process spawn floor: ${fmt(floor.medianMs)} ms`);
    console.log(`  sshya direct adds ${fmt(result.derived.sshyaDirectOverheadMs)} ms over spawn`);
    console.log(`  MCP adds ${fmt(result.derived.mcpOverheadOverDirectMs)} ms over direct (DB write + JSON + protocol)`);
    console.log('  real SSH handshake / pooled RTT: NOT MEASURED (no local sshd)');
    console.log(`\nwrote ${file}`);
  } finally {
    await bench.close();
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
};

await main();
