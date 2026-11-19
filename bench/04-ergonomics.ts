/**
 * 04 — Agent ergonomics: realistic tasks, measured calls and tokens.
 *
 * Each task is executed through the real MCP server against the fake ssh. The
 * table counts (a) MCP calls, (b) response tokens the model must read, and
 * (c) where relevant, tokens the model must *emit* (rewriting a whole file).
 *
 * Run: bun run bench/04-ergonomics.ts
 */
import fs from 'fs';
import {
  clearHostFixtures,
  createBenchEnv,
  seedConnections,
  startBenchClient,
  writeHostFixture,
  writeResults,
  type BenchClient,
} from './lib/harness';
import { fmt, pct, tokens, TOKENIZER_NAME } from './lib/tokenizer';

interface TaskRow {
  task: string;
  calls: number;
  responseTokens: number;
  outputTokens: number;
  totalTokens: number;
  idealCalls: number;
  idealTokens: number;
  savingPct: number;
  note: string;
}

const nginxLine = (i: number) =>
  `2026/11/18 14:02:${String(i % 60).padStart(2, '0')} [error] 4242#4242: *${100000 + i} upstream timed out (110: Connection timed out) while reading response header from upstream, client: 203.0.113.${i % 255}, server: api.example.com, request: "GET /v1/orders?page=${i} HTTP/1.1", upstream: "http://10.0.0.12:8080/v1/orders?page=${i}", host: "api.example.com"\n`;

const makeLog = (lines: number): string => {
  let text = '';
  for (let i = 0; i < lines; i += 1) text += nginxLine(i);
  return text;
};

const makeNginxConf = (targetBytes: number): string => {
  const block = (i: number) => `server {
    listen 80;
    server_name app${i}.example.com;
    access_log /var/log/nginx/app${i}.access.log;
    location / {
        proxy_pass http://10.0.0.${(i % 200) + 10}:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}

`;
  let config = '# managed by sshya bench\n';
  for (let i = 0; config.length < targetBytes; i += 1) config += block(i);
  return config;
};

/** Same projection used by 02-call-cost.ts, kept local to avoid coupling. */
const compactRun = (value: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = { ok: value.ok };
  if (value.error) out.error = value.error;
  if (value.exitCode !== 0) out.exit = value.exitCode;
  if (typeof value.stdout === 'string' && value.stdout.length > 0) out.stdout = value.stdout;
  if (typeof value.stderr === 'string' && value.stderr.length > 0) out.stderr = value.stderr;
  if (value.timedOut) out.timedOut = true;
  if (value.stdoutTruncated) out.truncated = { stream: 'stdout', kept: value.stdoutBytes, mode: 'head' };
  if (value.errorKind) out.errorKind = value.errorKind;
  if (value.hint) out.hint = value.hint;
  if (value.reused) out.reused = true;
  return out;
};

const compactMany = (value: Record<string, any>): Record<string, any> => ({
  ok: value.ok,
  failed: (value.results as any[]).filter(row => !row.ok).length,
  results: (value.results as any[]).map(row => (row.error && !row.exitCode
    ? { alias: row.alias, ok: false, error: row.error }
    : { alias: row.alias, ...compactRun(row) })),
});

const compactConnection = (connection: Record<string, any>): Record<string, any> => ({
  alias: connection.alias,
  target: `${connection.user}@${connection.host}${connection.port ? `:${connection.port}` : ''}`,
  ...(connection.remote_path ? { path: connection.remote_path } : {}),
});

const main = async () => {
  const paths = createBenchEnv('sshya-bench-ergo');
  seedConnections(paths.db, { count: 10 });
  const bench: BenchClient = await startBenchClient(paths);
  const tasks: TaskRow[] = [];

  const row = (
    task: string,
    calls: number,
    responseTokens: number,
    idealCalls: number,
    idealTokens: number,
    note: string,
    outputTokens = 0,
  ): TaskRow => {
    const totalTokens = responseTokens + outputTokens;
    return {
      task,
      calls,
      responseTokens,
      outputTokens,
      totalTokens,
      idealCalls,
      idealTokens,
      savingPct: Number((((totalTokens - idealTokens) / Math.max(1, totalTokens)) * 100).toFixed(1)),
      note,
    };
  };

  try {
    const hosts5 = ['web01', 'web02', 'web03', 'web04', 'web05'];
    const hosts10 = Array.from({ length: 10 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);

    // --- Task 1: check disk on five hosts -----------------------------------
    clearHostFixtures(paths.sshDir);
    for (const host of hosts5) {
      writeHostFixture(paths.sshDir, host, { out: '/dev/sda1        98G   41G   52G  45% /\n' });
    }
    seedConnections(paths.db, { count: 5 });
    const discover = await bench.callTool('list_connections', {});
    const disk5 = await bench.callTool('run_on_many', { aliases: hosts5, command: 'df -h /' });
    const disk5Single = await bench.callTool('run_command', { alias: 'web01', command: 'df -h /' });

    const disk5Tokens = tokens(discover.text) + tokens(disk5.text);
    const compactList5 = tokens(JSON.stringify((JSON.parse(discover.text) as any[]).map(compactConnection)));
    const disk5Projected = tokens(JSON.stringify(compactMany(JSON.parse(disk5.text))));
    tasks.push(row(
      'check disk on 5 hosts (discover + fan out)',
      2,
      disk5Tokens,
      2,
      compactList5 + disk5Projected,
      `run_on_many already saves 5 calls; response metadata still costs ~${fmt(tokens(disk5.text))} tok. `
      + `Compact list + compact fan-out would cost ${fmt(compactList5 + disk5Projected)} tok. `
      + `Calling run_command per host would cost ${fmt(tokens(disk5Single.text))} tok/host (${fmt(tokens(disk5Single.text) * 5)} tok, 5 calls).`,
    ));

    // --- Task 2: tail a log --------------------------------------------------
    clearHostFixtures(paths.sshDir);
    const bigLog = makeLog(300); // ~55 KiB
    writeHostFixture(paths.sshDir, '_default', { out: bigLog });
    seedConnections(paths.db, { count: 10 });

    const catLog = await bench.callTool('run_command', { alias: 'web01', command: 'cat /var/log/nginx/error.log' });

    // A real ssh returns only the lines `tail` selected; mirror that here.
    const logLines = bigLog.trimEnd().split('\n');
    writeHostFixture(paths.sshDir, '_default', { out: `${logLines.slice(-50).join('\n')}\n` });
    const tail50 = await bench.callTool('run_command', { alias: 'web01', command: 'tail -n 50 /var/log/nginx/error.log' });
    writeHostFixture(paths.sshDir, '_default', { out: `${logLines.slice(-20).join('\n')}\n` });
    const tail20 = await bench.callTool('run_command', { alias: 'web01', command: 'tail -n 20 /var/log/nginx/error.log' });

    tasks.push(row(
      'tail a log (agent asks for last 50 lines)',
      1,
      tokens(tail50.text),
      1,
      tokens(tail20.text),
      `Works today with "| tail -n 50". Without tail in the command, the default cap returns ${fmt(tokens(catLog.text))} tok `
      + `(${fmt(catLog.text.length)} chars, truncated at 64 KiB). 50 lines already costs ${fmt(tokens(tail50.text))} tok; `
      + `20 lines costs ${fmt(tokens(tail20.text))} tok.`,
    ));

    // --- Task 3: edit a config file -----------------------------------------
    clearHostFixtures(paths.sshDir);
    const config = makeNginxConf(20 * 1024);
    writeHostFixture(paths.sshDir, '_default', { out: config });
    const readConfig = await bench.callTool('run_command', { alias: 'web01', command: 'cat -n /srv/app/nginx.conf' });
    writeHostFixture(paths.sshDir, '_default', { out: '' });
    const writeConfig = await bench.callTool('write_remote_file', {
      alias: 'web01',
      path: '/srv/app/nginx.conf',
      content: config.replace('proxy_read_timeout 60s', 'proxy_read_timeout 120s'),
    });
    writeHostFixture(paths.sshDir, '_default', { out: 'nginx: configuration file /srv/app/nginx.conf test is successful\n' });
    const verifyConfig = await bench.callTool('run_command', { alias: 'web01', command: 'nginx -t' });

    const configTokens = tokens(config);
    const editResponse = tokens(readConfig.text) + tokens(writeConfig.text) + tokens(verifyConfig.text);
    tasks.push(row(
      'edit one line in a 20 KiB config',
      3,
      editResponse,
      2,
      650,
      `No read/edit tool: the agent cats ${fmt(configTokens)} tok, emits the whole file (${fmt(configTokens)} tok output), rewrites it, then verifies. `
      + `A read_remote_file(offset,limit) + replace_in_remote_file would need ~40 lines + ~20 tok ack + verify.`,
      configTokens,
    ));

    // --- Task 4: restart a service and verify --------------------------------
    clearHostFixtures(paths.sshDir);
    writeHostFixture(paths.sshDir, '_default', { out: 'active\n' });
    const restart = await bench.callTool('run_command', {
      alias: 'web01',
      command: 'systemctl restart nginx && systemctl is-active nginx',
    });

    writeHostFixture(paths.sshDir, '_default', {
      out: '',
      err: 'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\n',
      exit: 1,
    });
    const restartFail = await bench.callTool('run_command', {
      alias: 'web01',
      command: 'sudo systemctl restart nginx',
    });

    tasks.push(row(
      'restart a service and verify',
      1,
      tokens(restart.text),
      1,
      tokens(restart.text),
      `One compound command works without sudo. With sudo the failure (${fmt(tokens(restartFail.text))} tok) is classified as `
      + `"${(JSON.parse(restartFail.text) as any).errorKind ?? '?'}" and the hint does not mention tty:true; retrying with tty burns a timeout.`,
    ));

    // --- Task 5: find which host has an error --------------------------------
    clearHostFixtures(paths.sshDir);
    for (const host of hosts10) writeHostFixture(paths.sshDir, host, { out: '0\n' });
    writeHostFixture(paths.sshDir, 'web04', { out: '7\n' });
    const find5 = await bench.callTool('run_on_many', {
      aliases: hosts10,
      command: 'grep -c ERROR /var/log/app.log || true',
    });

    const hosts50 = Array.from({ length: 50 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);
    seedConnections(paths.db, { count: 50 });
    for (const host of hosts50) writeHostFixture(paths.sshDir, host, { out: '0\n' });
    writeHostFixture(paths.sshDir, 'web37', { out: '7\n' });
    const find50 = await bench.callTool('run_on_many', {
      aliases: hosts50,
      command: 'grep -c ERROR /var/log/app.log || true',
    });

    const find5Json = JSON.parse(find5.text) as Record<string, any>;
    const find5Compact = tokens(JSON.stringify(compactMany(find5Json)));
    tasks.push(row(
      'find which of 10 hosts has an error',
      1,
      tokens(find5.text),
      1,
      20,
      `Answer is one alias, but every host carries ~19 fields. Compact = ${fmt(find5Compact)} tok; `
      + `a matched-only reply ({matched:[{alias:"web04",count:7}]}) is ~20 tok. 50 hosts costs ${fmt(tokens(find50.text))} tok `
      + `(${fmt(find50.text.length)} chars) for an answer that is a list of failing aliases.`,
    ));

    // --- Task 6: read a line range of a big file -----------------------------
    clearHostFixtures(paths.sshDir);
    const bigFile = makeLog(500);
    writeHostFixture(paths.sshDir, '_default', { out: bigFile.split('\n').slice(199, 240).join('\n') });
    seedConnections(paths.db, { count: 10 });
    const range = await bench.callTool('run_command', {
      alias: 'web01',
      command: "sed -n '200,240p' /var/log/app.log",
    });
    tasks.push(row(
      'read lines 200-240 of a log',
      1,
      tokens(range.text),
      1,
      tokens(range.text),
      `sed works (${fmt(tokens(range.text))} tok). No read_remote_file means the agent must know sed/awk and shell-quote; `
      + `a read_remote_file(offset,limit) would be discoverable and would not mangle binary data.`,
    ));

    // --- Task 7: recover from a typo'd alias ---------------------------------
    clearHostFixtures(paths.sshDir);
    writeHostFixture(paths.sshDir, '_default', { out: ' 14:02:01 up 12 days\n' });
    const missing = await bench.callTool('run_command', { alias: 'webb01', command: 'uptime' });
    const recoveryList = await bench.callTool('list_connections', {});
    const recoveryCompact = tokens(JSON.stringify((JSON.parse(recoveryList.text) as any[]).map(compactConnection)));
    tasks.push(row(
      'recover from a typo in an alias',
      2,
      tokens(missing.text) + tokens(recoveryList.text),
      1,
      60,
      `"Alias not found" returns no hint, no candidates and no errorKind; the agent must list the store `
      + `(${fmt(tokens(recoveryList.text))} tok for 10 connections; compact list ${fmt(recoveryCompact)} tok) or guess again. `
      + `Three closest aliases in the error would cost ~20 tok.`,
    ));

    // --- Task 8: fleet check across 50 hosts ---------------------------------
    clearHostFixtures(paths.sshDir);
    seedConnections(paths.db, { count: 50 });
    for (const host of hosts50) writeHostFixture(paths.sshDir, host, { out: 'active\n' });
    const fleet50 = await bench.callTool('run_on_many', { aliases: hosts50, command: 'systemctl is-active nginx' });
    const fleet50Json = JSON.parse(fleet50.text) as Record<string, any>;
    const fleet50FailuresOnly = tokens(JSON.stringify({
      ok: fleet50Json.ok,
      total: fleet50Json.summary.total,
      failed: fleet50Json.summary.failed,
      results: [],
    }));
    const fleet50Compact = tokens(JSON.stringify(compactMany(fleet50Json)));
    tasks.push(row(
      'fleet check (50 hosts, one line each)',
      1,
      tokens(fleet50.text),
      1,
      fleet50FailuresOnly,
      `${fmt(tokens(fleet50.text))} tok for 50 one-word answers; compact results = ${fmt(fleet50Compact)} tok; `
      + `a failures-only summary = ${fmt(fleet50FailuresOnly)} tok.`,
    ));

    // --- Parameter and error friction (measured on real responses) -----------
    const single = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
    const singleJson = JSON.parse(single.text) as Record<string, any>;
    const metadataKeys = ['command', 'remoteCommand', 'target', 'cwd', 'signal', 'stdoutBytes', 'stderrBytes', 'stdoutLines', 'stderrLines', 'stdoutTruncated', 'stderrTruncated', 'timedOut', 'durationMs'];
    const metadataChars = metadataKeys
      .filter(key => key in singleJson)
      .map(key => `${JSON.stringify(key)}:${JSON.stringify(singleJson[key])}`)
      .join(',').length;
    const outputChars = (singleJson.stdout ?? '').length + (singleJson.stderr ?? '').length;

    const aliasError = JSON.parse(missing.text);
    const restartError = JSON.parse(restartFail.text);

    const friction = {
      responseMeta: {
        totalChars: single.text.length,
        metadataChars,
        outputChars,
        metadataShare: pct(metadataChars, single.text.length),
      },
      aliasError: {
        ...aliasError,
        tokens: tokens(missing.text),
        hasHint: 'hint' in aliasError,
        hasCandidates: 'candidates' in aliasError,
        hasErrorKind: 'errorKind' in aliasError,
      },
      sudoError: {
        errorKind: restartError.errorKind,
        hint: restartError.hint,
        tokens: tokens(restartFail.text),
      },
      cliFlagsInHints: [
        '`--accept-new-host-key`',
        '`--timeout`',
        '`--no-cwd`',
        '`sshya show <alias>`',
        '`sshya doctor --probe`',
      ],
      toolParamMismatches: [
        { mcp: 'write_remote_file.path', store: 'connection.remote_path', note: 'same concept, different name' },
        { mcp: 'run_command.cwd (boolean)', note: 'returns cwd as a string in the result; the boolean reads like a path' },
        { mcp: 'run_command.maxOutputBytes', cli: '--max-output', note: 'no maxOutputBytes on run_on_many docs even though it exists' },
        { mcp: 'run_command.timeoutMs', cli: '--timeout', note: 'CLI accepts seconds, MCP milliseconds' },
        { mcp: 'run_on_many', note: 'no tty, stdin, or reuse params: cannot run sudo or pipe data across a fleet' },
        { mcp: 'run_command.tail (boolean)', note: 'only switches which end is kept when truncating; does not add `tail -n`' },
      ],
    };

    const result = {
      tokenizer: TOKENIZER_NAME,
      tasks,
      totals: {
        measuredTaskTokens: tasks.reduce((sum, task) => sum + task.totalTokens, 0),
        idealTokens: tasks.reduce((sum, task) => sum + task.idealTokens, 0),
        savingsPct: Number(((
          (tasks.reduce((sum, task) => sum + task.totalTokens, 0) - tasks.reduce((sum, task) => sum + task.idealTokens, 0))
          / Math.max(1, tasks.reduce((sum, task) => sum + task.totalTokens, 0))
        ) * 100).toFixed(1)),
        calls: tasks.reduce((sum, task) => sum + task.calls, 0),
        idealCalls: tasks.reduce((sum, task) => sum + task.idealCalls, 0),
      },
      friction,
      projections: {
        note: 'Computed from the measured responses; no product change.',
        compactMany10: tokens(JSON.stringify(compactMany(JSON.parse(find5.text)))),
        matched10: tokens(JSON.stringify({
          matched: (JSON.parse(find5.text).results as any[])
            .filter(result => typeof result.stdout === 'string' && result.stdout.trim() !== '0')
            .map(result => ({ alias: result.alias, count: Number(result.stdout.trim()) })),
        })),
        fleet50FailuresOnly,
        compactList10: recoveryCompact,
      },
      fixtures: { logLines: 300, configBytes: config.length, bigFileLines: 500 },
    };
    const file = writeResults('ergonomics.json', result);

    console.log('AGENT TASKS (measured over MCP, fake ssh)\n');
    console.log('task'.padEnd(46) + 'calls'.padStart(6) + 'resp tok'.padStart(10) + 'out tok'.padStart(9) + 'ideal'.padStart(9) + 'save'.padStart(8));
    for (const task of tasks) {
      console.log(
        task.task.padEnd(46)
        + String(task.calls).padStart(6)
        + fmt(task.responseTokens).padStart(10)
        + fmt(task.outputTokens).padStart(9)
        + fmt(task.idealTokens).padStart(9)
        + `${task.savingPct}%`.padStart(8),
      );
    }
    console.log('\nnotes');
    for (const task of tasks) {
      console.log(`- ${task.task}: ${task.note}`);
    }
    console.log('\nfriction');
    console.log(`  run_command small: ${friction.responseMeta.metadataShare} of response is metadata (${friction.responseMeta.metadataChars}/${friction.responseMeta.totalChars} chars)`);
    console.log(`  alias error: ${friction.aliasError.tokens} tok, hint=${friction.aliasError.hasHint}, candidates=${friction.aliasError.hasCandidates}, errorKind=${friction.aliasError.hasErrorKind}`);
    console.log(`  sudo error: errorKind=${friction.sudoError.errorKind}, hint="${friction.sudoError.hint}"`);
    console.log(`\ntotals: ${fmt(result.totals.measuredTaskTokens)} tok across ${result.totals.calls} calls; ideal ${fmt(result.totals.idealTokens)} tok in ${result.totals.idealCalls} calls (${result.totals.savingsPct}% savings)`);
    console.log(`wrote ${file}`);
  } finally {
    await bench.close();
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
};

await main();
