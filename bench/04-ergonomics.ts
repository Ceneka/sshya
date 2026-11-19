/**
 * 04 — Agent ergonomics: realistic tasks, measured calls and tokens.
 *
 * Each task is executed through the real MCP server against the fake ssh. The
 * table counts (a) MCP calls, (b) response tokens the model must read, and
 * (c) where relevant, tokens the model must *emit* (rewriting a whole file).
 *
 * The tool mix is the one shipped after all rounds: compact responses, 8 KiB
 * head+tail truncation, and the structured file tools. Tasks that touch files
 * run the fake ssh in FAKE_SSH_EXEC mode so sed/awk/grep/stat/cksum operate on
 * real local files under the bench temp dir.
 *
 * `baseline*` numbers are the original 0.6.0 measurements from REPORT.md §4;
 * they are the "before" column, not a projection.
 *
 * Run: bun run bench/04-ergonomics.ts
 */
import fs from 'fs';
import path from 'path';
import { makeLog, makeNginxConf } from './lib/fixtures';
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
  baselineCalls: number;
  baselineTokens: number;
  savingPct: number;
  note: string;
}

/** Original REPORT.md §4 totals (measured on 0.6.0, prior to every change). */
const BASELINE: Record<string, { calls: number; tokens: number }> = {
  'check disk on 5 hosts (discover + fan out)': { calls: 2, tokens: 2_315 },
  'tail a log (agent asks for last 50 lines)': { calls: 1, tokens: 5_476 },
  'edit one line in a 20 KiB config': { calls: 3, tokens: 12_322 },
  'restart a service and verify': { calls: 1, tokens: 173 },
  'find which of 10 hosts has an error': { calls: 1, tokens: 1_814 },
  'read lines 200-240 of a log': { calls: 1, tokens: 4_525 },
  'recover from a typo in an alias': { calls: 2, tokens: 2_730 },
  'fleet check (50 hosts, one line each)': { calls: 1, tokens: 8_294 },
};

const main = async () => {
  const paths = createBenchEnv('sshya-bench-ergo');
  seedConnections(paths.db, { count: 10 });
  const bench: BenchClient = await startBenchClient(paths);
  const tasks: TaskRow[] = [];

  const row = (
    task: string,
    calls: number,
    responseTokens: number,
    note: string,
    outputTokens = 0,
  ): TaskRow => {
    const totalTokens = responseTokens + outputTokens;
    const baseline = BASELINE[task] ?? { calls, tokens: totalTokens };
    return {
      task,
      calls,
      responseTokens,
      outputTokens,
      totalTokens,
      baselineCalls: baseline.calls,
      baselineTokens: baseline.tokens,
      savingPct: Number((((baseline.tokens - totalTokens) / Math.max(1, baseline.tokens)) * 100).toFixed(1)),
      note,
    };
  };

  try {
    const hosts5 = ['web01', 'web02', 'web03', 'web04', 'web05'];
    const hosts10 = Array.from({ length: 10 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);
    const hosts50 = Array.from({ length: 50 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);

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
    tasks.push(row(
      'check disk on 5 hosts (discover + fan out)',
      2,
      disk5Tokens,
      `one list_connections (${fmt(tokens(discover.text))} tok) + one run_on_many (${fmt(tokens(disk5.text))} tok). `
      + `Calling run_command per host would cost ${fmt(tokens(disk5Single.text))} tok/host over 5 calls.`,
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

    const tail50Bytes = Buffer.byteLength(`${logLines.slice(-50).join('\n')}\n`);
    tasks.push(row(
      'tail a log (agent asks for last 50 lines)',
      1,
      tokens(tail50.text),
      `50 log lines are ${fmt(tail50Bytes)} bytes, so the 8 KiB default keeps head+tail (${fmt(tokens(tail50.text))} tok); `
      + `20 lines fit under the cap (${fmt(tokens(tail20.text))} tok). Forgetting tail now costs the same 8 KiB `
      + `(${fmt(tokens(catLog.text))} tok) instead of the old 64 KiB head (22,577 tok).`,
    ));

    // --- Task 3: edit one line in a 20 KiB config ---------------------------
    clearHostFixtures(paths.sshDir);
    const workspace = path.join(paths.root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const configPath = path.join(workspace, 'nginx.conf');
    const config = makeNginxConf(20 * 1024);
    fs.writeFileSync(configPath, config);
    seedConnections(paths.db, { count: 10, remotePath: workspace });
    process.env.FAKE_SSH_EXEC = '1';

    const oldText = 'server_name app0.example.com';
    const newText = 'server_name app0.internal.example.com';
    let readConfig;
    let replaceConfig;
    let verifyConfig;
    try {
      readConfig = await bench.callTool('read_remote_file', {
        alias: 'web01',
        path: 'nginx.conf',
        offset: 1,
        limit: 10,
      });
      replaceConfig = await bench.callTool('replace_in_remote_file', {
        alias: 'web01',
        path: 'nginx.conf',
        oldText,
        newText,
      });
      verifyConfig = await bench.callTool('grep_remote', {
        alias: 'web01',
        pattern: 'app0\\.internal',
        path: 'nginx.conf',
      });
    } finally {
      delete process.env.FAKE_SSH_EXEC;
    }

    const editResponse = tokens(readConfig.text) + tokens(replaceConfig.text) + tokens(verifyConfig.text);
    tasks.push(row(
      'edit one line in a 20 KiB config',
      3,
      editResponse,
      `read_remote_file(1,10) + replace_in_remote_file + grep_remote verify = ${fmt(editResponse)} tok. `
      + `The old path cat the whole ${fmt(tokens(config))} tok file, re-emitted it, rewrote it non-atomically, then verified. `
      + `New responses: read ${fmt(tokens(readConfig.text))}, replace ${fmt(tokens(replaceConfig.text))}, verify ${fmt(tokens(verifyConfig.text))} tok.`,
      tokens(oldText) + tokens(newText),
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
      `One compound command works without sudo. With sudo the failure (${fmt(tokens(restartFail.text))} tok) is classified as `
      + `"${(JSON.parse(restartFail.text) as any).errorKind ?? '?'}" and the hint names tty:true / sudo -n.`,
    ));

    // --- Task 5: find which host has an error --------------------------------
    clearHostFixtures(paths.sshDir);
    for (const host of hosts10) writeHostFixture(paths.sshDir, host, { out: '0\n' });
    writeHostFixture(paths.sshDir, 'web04', { out: '7\n' });
    const find5 = await bench.callTool('run_on_many', {
      aliases: hosts10,
      command: 'grep -c ERROR /var/log/app.log || true',
      match: '[1-9]',
    });
    const find5All = await bench.callTool('run_on_many', {
      aliases: hosts10,
      command: 'grep -c ERROR /var/log/app.log || true',
    });

    tasks.push(row(
      'find which of 10 hosts has an error',
      1,
      tokens(find5.text),
      `match: "[1-9]" returns only web04's matching line; the summary still says total=10, failed=0. `
      + `The all-results reply costs ${fmt(tokens(find5All.text))} tok for the same answer.`,
    ));

    // --- Task 6: read a line range of a big file -----------------------------
    clearHostFixtures(paths.sshDir);
    const rangeWorkspace = path.join(paths.root, 'range');
    fs.mkdirSync(rangeWorkspace, { recursive: true });
    const bigFile = makeLog(500);
    fs.writeFileSync(path.join(rangeWorkspace, 'app.log'), bigFile);
    seedConnections(paths.db, { count: 10, remotePath: rangeWorkspace });
    process.env.FAKE_SSH_EXEC = '1';
    let range;
    try {
      range = await bench.callTool('read_remote_file', {
        alias: 'web01',
        path: 'app.log',
        offset: 200,
        limit: 41,
      });
    } finally {
      delete process.env.FAKE_SSH_EXEC;
    }
    tasks.push(row(
      'read lines 200-240 of a log',
      1,
      tokens(range.text),
      `read_remote_file(offset:200, limit:41) adds numbered lines and totalLines. The response is payload-bound; `
      + `the gain is a discoverable schema, binary refusal, and no sed quoting, not fewer tokens.`,
    ));

    // --- Task 7: recover from a typo'd alias ---------------------------------
    clearHostFixtures(paths.sshDir);
    writeHostFixture(paths.sshDir, '_default', { out: ' 14:02:01 up 12 days\n' });
    seedConnections(paths.db, { count: 10 });
    const missing = await bench.callTool('run_command', { alias: 'webb01', command: 'uptime' });
    const retry = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
    const aliasError = JSON.parse(missing.text) as Record<string, any>;
    tasks.push(row(
      'recover from a typo in an alias',
      2,
      tokens(missing.text) + tokens(retry.text),
      `The error now carries errorKind, a hint, and ${Array.isArray(aliasError.suggestions) ? aliasError.suggestions.length : 0} suggestions, `
      + `so the retry is immediate: ${fmt(tokens(missing.text))} + ${fmt(tokens(retry.text))} tok. `
      + `The old path was error + a full list_connections (2,710 tok at 10 connections).`,
    ));

    // --- Task 8: fleet check across 50 hosts ---------------------------------
    clearHostFixtures(paths.sshDir);
    seedConnections(paths.db, { count: 50 });
    for (const host of hosts50) writeHostFixture(paths.sshDir, host, { out: 'active\n' });
    const fleet50 = await bench.callTool('run_on_many', {
      aliases: hosts50,
      command: 'systemctl is-active nginx',
      concurrency: 8,
      only: 'failures',
    });
    const fleet50All = await bench.callTool('run_on_many', {
      aliases: hosts50,
      command: 'systemctl is-active nginx',
      concurrency: 8,
    });
    tasks.push(row(
      'fleet check (50 hosts, one line each)',
      1,
      tokens(fleet50.text),
      `only:"failures" returns the summary with no result rows (${fmt(tokens(fleet50.text))} tok). `
      + `All 50 results cost ${fmt(tokens(fleet50All.text))} tok.`,
    ));

    // --- Parameter and error friction (measured on real responses) -----------
    seedConnections(paths.db, { count: 10 });
    const single = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
    const singleJson = JSON.parse(single.text) as Record<string, any>;
    const outputChars = (singleJson.stdout ?? '').length + (singleJson.stderr ?? '').length;
    const metadataChars = Math.max(0, single.text.length - outputChars);

    const restartError = JSON.parse(restartFail.text);

    const friction = {
      responseMeta: {
        totalChars: single.text.length,
        metadataChars,
        outputChars,
        metadataShare: pct(metadataChars, single.text.length),
        keys: Object.keys(singleJson),
      },
      aliasError: {
        ...aliasError,
        tokens: tokens(missing.text),
        hasHint: 'hint' in aliasError,
        hasSuggestions: 'suggestions' in aliasError,
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
    };

    const measured = tasks.reduce((sum, task) => sum + task.totalTokens, 0);
    const baseline = tasks.reduce((sum, task) => sum + task.baselineTokens, 0);
    const result = {
      tokenizer: TOKENIZER_NAME,
      note: 'baseline* is REPORT.md §4 (0.6.0); measured is the final tree. File tasks use FAKE_SSH_EXEC on local temp files.',
      tasks,
      totals: {
        measuredTaskTokens: measured,
        measuredCalls: tasks.reduce((sum, task) => sum + task.calls, 0),
        baselineTaskTokens: baseline,
        baselineCalls: tasks.reduce((sum, task) => sum + task.baselineCalls, 0),
        savingPct: Number((((baseline - measured) / Math.max(1, baseline)) * 100).toFixed(1)),
      },
      friction,
      fixtures: { logLines: 300, configBytes: config.length, bigFileLines: 500 },
    };
    const file = writeResults('ergonomics.json', result);

    console.log('AGENT TASKS (measured over MCP, fake ssh; baseline = REPORT §4)\n');
    console.log(
      'task'.padEnd(46) + 'calls'.padStart(6) + 'resp tok'.padStart(10) + 'out tok'.padStart(9)
      + 'total'.padStart(9) + 'before'.padStart(9) + 'save'.padStart(8),
    );
    for (const task of tasks) {
      console.log(
        task.task.padEnd(46)
        + String(task.calls).padStart(6)
        + fmt(task.responseTokens).padStart(10)
        + fmt(task.outputTokens).padStart(9)
        + fmt(task.totalTokens).padStart(9)
        + fmt(task.baselineTokens).padStart(9)
        + `${task.savingPct}%`.padStart(8),
      );
    }
    console.log('\nnotes');
    for (const task of tasks) {
      console.log(`- ${task.task}: ${task.note}`);
    }
    console.log('\nfriction');
    console.log(`  run_command small: ${friction.responseMeta.metadataShare} of response is metadata (${friction.responseMeta.metadataChars}/${friction.responseMeta.totalChars} chars)`);
    console.log(`  alias error: ${friction.aliasError.tokens} tok, hint=${friction.aliasError.hasHint}, suggestions=${friction.aliasError.hasSuggestions}, errorKind=${friction.aliasError.hasErrorKind}`);
    console.log(`  sudo error: errorKind=${friction.sudoError.errorKind}, hint="${friction.sudoError.hint}"`);
    console.log(`\ntotals: ${fmt(measured)} tok across ${result.totals.measuredCalls} calls; before ${fmt(baseline)} tok across ${result.totals.baselineCalls} calls (${result.totals.savingPct}% savings)`);
    console.log(`wrote ${file}`);
  } finally {
    await bench.close();
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
};

await main();
