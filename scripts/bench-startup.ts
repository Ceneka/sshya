#!/usr/bin/env bun
/**
 * Reproducible CLI startup benchmark for the published Node build.
 *
 * Measures wall time for the commands an agent loop invokes most often:
 * `--version`, `--help`, `list --json`, and a pooled `run ... --json -- true`.
 *
 * The run case starts a throwaway sshd on 127.0.0.1 (the same harness the e2e
 * suite uses), stores one connection in a temporary `SSHYA_DB`, warms a
 * ControlMaster, and then measures reuse. Nothing under ~/.sshya or ~/.ssh is
 * read or written.
 *
 * Usage:
 *   bun run scripts/bench-startup.ts [--runs 10] [--warmup 2] [--label before]
 *     [--dist dist/index.js] [--json] [--out file.json]
 *
 * Report the median. Means hide scheduler noise; the median is what an agent
 * loop actually pays most of the time.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolation, REPO_ROOT, startSshd, stopSshd, type SshdHandle } from '../e2e/harness';

interface BenchCase {
  name: string;
  args: string[];
}

interface CaseResult {
  name: string;
  runs: number[];
  median: number;
  min: number;
  p90: number;
}

interface Report {
  label: string;
  dist: string;
  distBytes: number;
  runs: number;
  warmup: number;
  cases: CaseResult[];
  nodeFloor: number;
}

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name: string): boolean => argv.includes(name);

const runs = Number(option('--runs') ?? 10);
const warmup = Number(option('--warmup') ?? 2);
const label = option('--label') ?? 'current';
const dist = path.resolve(REPO_ROOT, option('--dist') ?? 'dist/index.js');
const jsonOut = flag('--json');
const outFile = option('--out');

if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('--runs must be a positive integer');
}
if (!Number.isInteger(warmup) || warmup < 0) {
  throw new Error('--warmup must be a non-negative integer');
}
if (!fs.existsSync(dist)) {
  throw new Error(`${path.relative(REPO_ROOT, dist)} does not exist; run \`bun run build\` first`);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
};

const round = (value: number): number => Math.round(value * 10) / 10;

const timeOnce = (command: string, args: string[], env: NodeJS.ProcessEnv): number => {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const duration = performance.now() - startedAt;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (status=${result.status})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return duration;
};

const measure = (command: string, args: string[], env: NodeJS.ProcessEnv): number[] => {
  for (let i = 0; i < warmup; i++) {
    timeOnce(command, args, env);
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    samples.push(timeOnce(command, args, env));
  }
  return samples;
};

const distBytes = (() => {
  let total = 0;
  for (const entry of fs.readdirSync(path.dirname(dist), { withFileTypes: true })) {
    if (entry.isFile()) {
      total += fs.statSync(path.join(path.dirname(dist), entry.name)).size;
    }
  }
  return total;
})();

let sshd: SshdHandle | undefined;
let tempParent: string | undefined;
try {
  sshd = await startSshd();
  const base = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();
  tempParent = fs.mkdtempSync(path.join(base, 'sshya-startup-'));
  const isolation = createIsolation(tempParent, 'bench', sshd);

  const cli = (args: string[], input?: string): number => {
    const result = spawnSync('node', [dist, ...args], {
      cwd: REPO_ROOT,
      env: isolation.env(),
      encoding: 'utf8',
      input,
      timeout: 60_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `setup: node ${dist} ${args.join(' ')} failed (status=${result.status})\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    return result.status ?? 0;
  };

  cli([
    'add', 'bench',
    '--user', sshd.user,
    '--host', sshd.host,
    '--port', String(sshd.port),
    '--key', sshd.clientKeyPath,
    '--json',
  ]);
  // Establish the ControlMaster before timing anything.
  const warm = spawnSync('node', [dist, 'run', 'bench', '--json', '--', 'true'], {
    cwd: REPO_ROOT,
    env: isolation.env(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (warm.status !== 0) {
    throw new Error(
      `pooled run warm-up failed (status=${warm.status})\nstdout:\n${warm.stdout}\nstderr:\n${warm.stderr}`,
    );
  }

  const cases: BenchCase[] = [
    { name: '--version', args: ['--version'] },
    { name: '--help', args: ['--help'] },
    { name: 'list --json', args: ['list', '--json'] },
    { name: 'run (pooled)', args: ['run', 'bench', '--json', '--', 'true'] },
  ];

  const results: CaseResult[] = [];
  for (const benchCase of cases) {
    const samples = measure('node', [dist, ...benchCase.args], isolation.env());
    results.push({
      name: benchCase.name,
      runs: samples.map(round),
      median: round(median(samples)),
      min: round(Math.min(...samples)),
      p90: round(percentile(samples, 0.9)),
    });
  }

  const nodeFloor = round(median(measure('node', ['-e', '0'], isolation.env())));

  const report: Report = {
    label,
    dist: path.relative(REPO_ROOT, dist),
    distBytes,
    runs,
    warmup,
    cases: results,
    nodeFloor,
  };

  if (outFile) {
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${label}: node ${report.dist} (${(distBytes / 1024).toFixed(0)} KiB), ${runs} runs, median ms`);
    console.log(`node floor: ${nodeFloor}`);
    const header = ['case', 'median', 'min', 'p90'];
    const rows = results.map(result => [result.name, result.median, result.min, result.p90].map(String));
    const widths = header.map((title, column) =>
      Math.max(title.length, ...rows.map(row => (row[column] ?? '').length)));
    const render = (row: string[]): string => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ');
    console.log(render(header));
    console.log(render(widths.map(width => '-'.repeat(width))));
    for (const row of rows) {
      console.log(render(row));
    }
    console.log(`\nraw: ${JSON.stringify(Object.fromEntries(results.map(r => [r.name, r.runs])))}`);
  }
} finally {
  if (sshd) {
    await stopSshd(sshd);
    fs.rmSync(sshd.root, { recursive: true, force: true });
  }
  if (tempParent) {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
}
