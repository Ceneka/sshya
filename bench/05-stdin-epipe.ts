/**
 * 05 — Robustness: unhandled EPIPE on child stdin.
 *
 * executeSshCommand writes `options.stdin` with `child.stdin.end(...)` but never
 * attaches an 'error' listener. If ssh exits before consuming the payload
 * (authentication failure mid-write, a remote command like `head`, or a fast
 * custom SSH wrapper), the write raises EPIPE. In Bun/Node this is an unhandled
 * error that terminates the process — including a long-lived MCP server.
 *
 * This script runs each case in a child process so the bench survives the crash,
 * and includes a draining-stdin control that exits cleanly.
 *
 * Run: bun run bench/05-stdin-epipe.ts
 */
import fs from 'fs';
import path from 'path';
import { writeResults } from './lib/harness';
import { fmt } from './lib/tokenizer';

const childScript = path.resolve(import.meta.dir, 'cases', 'stdin-epipe-child.ts');

interface CaseResult {
  mode: 'write' | 'run-stdin';
  drainStdin: boolean;
  bytes: number;
  exitCode: number;
  crashed: boolean;
  epipe: boolean;
  toolReturned: boolean;
  cleanExit: boolean;
  elapsedMs: number;
  stderrTail: string;
}

const runCase = async (mode: 'write' | 'run-stdin', drainStdin: boolean, bytes: number): Promise<CaseResult> => {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, 'run', childScript], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      EPIPE_MODE: mode,
      EPIPE_BYTES: String(bytes),
      EPIPE_DRAIN: drainStdin ? '1' : '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  const elapsedMs = Number((performance.now() - started).toFixed(0));

  return {
    mode,
    drainStdin,
    bytes,
    exitCode,
    crashed: exitCode !== 0,
    epipe: /EPIPE|broken pipe/i.test(stderr),
    toolReturned: stdout.includes('TOOL_RETURNED'),
    cleanExit: stdout.includes('CLEAN_EXIT'),
    elapsedMs,
    stderrTail: stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 500),
  };
};

const main = async () => {
  const size = 256 * 1024;
  const cases: CaseResult[] = [
    await runCase('write', false, size),
    await runCase('run-stdin', false, size),
    await runCase('write', true, size),
    await runCase('run-stdin', true, size),
  ];

  const result = {
    description: 'Child stdin write vs an ssh process that exits without reading.',
    payloadBytes: size,
    cases,
  };
  const file = writeResults('stdin-epipe.json', result);

  console.log('STDIN EPIPE (each case is a fresh child process)\n');
  console.log('case'.padEnd(34) + 'drain'.padStart(7) + 'tool ok'.padStart(9) + 'clean'.padStart(7) + 'exit'.padStart(6) + 'EPIPE'.padStart(7) + 'ms'.padStart(6));
  for (const row of cases) {
    const label = row.mode === 'write' ? 'write_remote_file (256 KiB)' : 'run_command stdin (256 KiB)';
    console.log(
      label.padEnd(34)
      + (row.drainStdin ? 'yes' : 'no').padStart(7)
      + String(row.toolReturned).padStart(9)
      + String(row.cleanExit).padStart(7)
      + String(row.exitCode).padStart(6)
      + String(row.epipe).padStart(7)
      + String(row.elapsedMs).padStart(6),
    );
  }
  console.log('\nFinding: with a non-draining ssh, the tool returns a result and then the process');
  console.log('dies with EPIPE (exit 1). Draining stdin is the control and exits cleanly.');
  console.log(`Payload: ${fmt(size)} bytes.`);
  console.log(`\nwrote ${file}`);
};

await main();
