/**
 * 02 — Per-call response cost.
 *
 * Every call goes through the real MCP server over InMemoryTransport with a fake
 * `ssh` binary and an isolated store. Measures the bytes/tokens the model
 * actually sees in content[0].text, plus the raw JSON-RPC payload.
 *
 * Since round 2 the shipped response shape is already compact/minified; the
 * `compact*` columns are kept only as the round-1 projection for the historical
 * tables. The file-tool scenarios run the fake ssh in FAKE_SSH_EXEC mode so
 * sed/awk/grep/stat/cksum see real local files (still no network).
 *
 * Run: bun run bench/02-call-cost.ts
 */
import fs from 'fs';
import path from 'path';
import { makeNginxConf } from './lib/fixtures';
import {
  clearHostFixtures,
  createBenchEnv,
  seedConnections,
  startBenchClient,
  writeHostFixture,
  writeResults,
  type BenchClient,
} from './lib/harness';
import { fmt, pct, sizeOf, tokens, TOKENIZER_NAME } from './lib/tokenizer';

interface ScenarioRow {
  name: string;
  calls: number;
  rawWireChars: number;
  textChars: number;
  textTokens: number;
  minifiedChars: number;
  minifiedTokens: number;
  compactChars: number;
  compactTokens: number;
  hasStructuredContent: boolean;
  contentDuplicatesStructured: boolean;
  metadataTokens: number;
  missing?: boolean;
}

const parseText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Proposed compact shape for a single run result. */
const compactRun = (value: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = { ok: value.ok };
  if (value.error) out.error = value.error;
  if (value.exitCode !== 0) out.exit = value.exitCode;
  if (typeof value.stdout === 'string' && value.stdout.length > 0) out.stdout = value.stdout;
  if (typeof value.stderr === 'string' && value.stderr.length > 0) out.stderr = value.stderr;
  if (value.timedOut) out.timedOut = true;
  if (value.stdoutTruncated) out.truncated = { stream: 'stdout', kept: value.stdoutBytes, unit: 'bytes', mode: 'head' };
  if (value.stderrTruncated) out.truncatedStderr = { kept: value.stderrBytes };
  if (value.errorKind) out.errorKind = value.errorKind;
  if (value.hint) out.hint = value.hint;
  if (value.reused) out.reused = true;
  return out;
};

const compactMany = (value: Record<string, any>): Record<string, any> => {
  const results = Array.isArray(value.results) ? value.results : [];
  return {
    ok: value.ok,
    failed: results.filter((row: any) => !row.ok).length,
    results: results.map((row: any) => {
      if (row.error && !row.exitCode) return { alias: row.alias, ok: false, error: row.error };
      return { alias: row.alias, ...compactRun(row) };
    }),
  };
};

const compactConnection = (connection: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {
    alias: connection.alias,
    target: `${connection.user}@${connection.host}${connection.port ? `:${connection.port}` : ''}`,
  };
  if (connection.remote_path) out.path = connection.remote_path;
  if (connection.key_path) out.key = connection.key_path;
  return out;
};

const main = async () => {
  const paths = createBenchEnv('sshya-bench-calls');
  seedConnections(paths.db, { count: 50 });
  const bench: BenchClient = await startBenchClient(paths);
  const rows: ScenarioRow[] = [];

  const record = async (
    name: string,
    run: () => Promise<{ result: Record<string, any>; text: string; wireBytes: number }>,
    compact: (value: any) => unknown,
  ) => {
    const { result, text, wireBytes } = await run();
    const parsed = parseText(text);
    const minified = JSON.stringify(parsed ?? text);
    const compacted = JSON.stringify(compact(parsed));
    const structured = (result as any).structuredContent;
    const contentText = text;
    const contentDuplicatesStructured = structured !== undefined
      && JSON.stringify(structured) === JSON.stringify(parsed);

    let metadataTokens = tokens(minified);
    if (isPlainObject(parsed)) {
      const body = [
        parsed.stdout,
        parsed.stderr,
        parsed.content,
        parsed.diff,
        Array.isArray(parsed.matches) ? parsed.matches.join('\n') : undefined,
      ]
        .filter(part => typeof part === 'string')
        .join('');
      metadataTokens = Math.max(0, tokens(minified) - tokens(body));
    }

    rows.push({
      name,
      calls: 1,
      rawWireChars: wireBytes,
      textChars: text.length,
      textTokens: tokens(text),
      minifiedChars: minified.length,
      minifiedTokens: tokens(minified),
      compactChars: compacted.length,
      compactTokens: tokens(compacted),
      hasStructuredContent: structured !== undefined,
      contentDuplicatesStructured,
      metadataTokens,
    });
  };

  try {
    // --- Success, tiny output -------------------------------------------------
    clearHostFixtures(paths.sshDir);
    writeHostFixture(paths.sshDir, '_default', {
      out: ' 14:02:01 up 12 days,  3:14,  1 user,  load average: 0.08, 0.11, 0.09\n',
    });

    await record('run_command: uptime (tiny)', async () => {
      const call = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
      return call;
    }, compactRun);

    // --- Large log output -----------------------------------------------------
    const line = (i: number) =>
      `2026/11/18 14:02:${String(i % 60).padStart(2, '0')} [error] 4242#4242: *${100000 + i} upstream timed out (110: Connection timed out) while reading response header from upstream, client: 203.0.113.${i % 255}, server: api.example.com, request: "GET /v1/orders?page=${i} HTTP/1.1", upstream: "http://10.0.0.12:8080/v1/orders?page=${i}", host: "api.example.com"\n`;
    let big = '';
    for (let i = 0; big.length < 64 * 1024; i += 1) big += line(i);
    writeHostFixture(paths.sshDir, '_default', { out: big });

    // The shipped MCP default: 8 KiB stdout kept as head+tail.
    await record('run_command: 64KiB log, MCP default (8KiB headtail)', async () => {
      const call = await bench.callTool('run_command', {
        alias: 'web01',
        command: 'cat /var/log/nginx/error.log',
      });
      return call;
    }, compactRun);

    // The pre-round-3 shape: the same log at the old 64 KiB head-only default.
    await record('run_command: 64KiB log, 64KiB head (old default)', async () => {
      const call = await bench.callTool('run_command', {
        alias: 'web01',
        command: 'cat /var/log/nginx/error.log',
        maxOutputBytes: 65536,
        truncate: 'head',
      });
      return call;
    }, compactRun);

    for (const cap of [65536, 16384]) {
      await record(`run_command: 64KiB log, cap ${cap / 1024}KiB headtail`, async () => {
        const call = await bench.callTool('run_command', {
          alias: 'web01',
          command: 'cat /var/log/nginx/error.log',
          maxOutputBytes: cap,
        });
        return call;
      }, compactRun);
    }

    // --- Fleet fan-out --------------------------------------------------------
    clearHostFixtures(paths.sshDir);
    const hosts = Array.from({ length: 10 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);
    for (const host of hosts) {
      writeHostFixture(paths.sshDir, host, {
        out: '/dev/sda1        98G   41G   52G  45% /\n',
      });
    }
    writeHostFixture(paths.sshDir, 'web07', {
      out: '',
      err: 'df: /mnt/backup: Permission denied\n',
      exit: 1,
    });

    await record('run_on_many: 10 hosts, 1 failure', async () => {
      const call = await bench.callTool('run_on_many', {
        aliases: hosts,
        command: 'df -h /',
      });
      return call;
    }, compactMany);

    // --- Fleet filters --------------------------------------------------------
    clearHostFixtures(paths.sshDir);
    for (const host of hosts) writeHostFixture(paths.sshDir, host, { out: '0\n' });
    writeHostFixture(paths.sshDir, 'web04', { out: '7\n' });
    const errorHunt = 'grep -c ERROR /var/log/app.log || true';

    await record('run_on_many: 10 hosts, 1 error (all results)', async () => {
      const call = await bench.callTool('run_on_many', { aliases: hosts, command: errorHunt });
      return call;
    }, compactMany);

    await record('run_on_many: 10 hosts, 1 error, only=failures', async () => {
      const call = await bench.callTool('run_on_many', {
        aliases: hosts,
        command: errorHunt,
        only: 'failures',
      });
      return call;
    }, compactMany);

    await record('run_on_many: 10 hosts, 1 error, match [1-9]', async () => {
      const call = await bench.callTool('run_on_many', {
        aliases: hosts,
        command: errorHunt,
        match: '[1-9]',
      });
      return call;
    }, compactMany);

    const hosts50 = Array.from({ length: 50 }, (_, index) => `web${String(index + 1).padStart(2, '0')}`);
    clearHostFixtures(paths.sshDir);
    seedConnections(paths.db, { count: 50 });
    for (const host of hosts50) writeHostFixture(paths.sshDir, host, { out: 'active\n' });

    await record('run_on_many: 50 hosts, all active (all results)', async () => {
      const call = await bench.callTool('run_on_many', {
        aliases: hosts50,
        command: 'systemctl is-active nginx',
        concurrency: 8,
      });
      return call;
    }, compactMany);

    await record('run_on_many: 50 hosts, all active, only=failures', async () => {
      const call = await bench.callTool('run_on_many', {
        aliases: hosts50,
        command: 'systemctl is-active nginx',
        concurrency: 8,
        only: 'failures',
      });
      return call;
    }, compactMany);

    // --- Connection test ------------------------------------------------------
    writeHostFixture(paths.sshDir, '_default', { out: '' });
    await record('test_connection: success', async () => {
      const call = await bench.callTool('test_connection', { alias: 'web01' });
      return call;
    }, compactRun);

    // --- Failures -------------------------------------------------------------
    writeHostFixture(paths.sshDir, '_default', {
      err: 'deploy@10.0.0.11: Permission denied (publickey).\n',
      exit: 255,
    });
    await record('run_command: auth failure', async () => {
      const call = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
      return call;
    }, compactRun);

    writeHostFixture(paths.sshDir, '_default', {
      err: 'Host key verification failed.\n',
      exit: 255,
    });
    await record('run_command: host key failure', async () => {
      const call = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
      return call;
    }, compactRun);

    writeHostFixture(paths.sshDir, '_default', { sleep: 5 });
    await record('run_command: timeout', async () => {
      const call = await bench.callTool('run_command', { alias: 'web01', command: 'sleep 60', timeoutMs: 300 });
      return call;
    }, compactRun);

    // --- Store inspection -----------------------------------------------------
    clearHostFixtures(paths.sshDir);
    seedConnections(paths.db, { count: 5 });
    await record('list_connections: 5', async () => {
      const call = await bench.callTool('list_connections', {});
      return call;
    }, (value: any) => ({ connections: value.map(compactConnection) }));

    seedConnections(paths.db, { count: 50 });
    await record('list_connections: 50', async () => {
      const call = await bench.callTool('list_connections', {});
      return call;
    }, (value: any) => ({ connections: value.map(compactConnection) }));

    await record('get_connection: 1', async () => {
      const call = await bench.callTool('get_connection', { alias: 'web01' });
      return call;
    }, compactConnection);

    // --- Write and missing alias ---------------------------------------------
    writeHostFixture(paths.sshDir, '_default', { out: '' });
    await record('write_remote_file: success', async () => {
      const call = await bench.callTool('write_remote_file', {
        alias: 'web01',
        path: '/srv/app/config.yml',
        content: 'port: 8080\nworkers: 4\n',
      });
      return call;
    }, (value: any) => ({
      ok: value.ok,
      path: value.path,
      bytesWritten: value.bytesWritten,
      ...(value.reused ? { reused: true } : {}),
    }));

    await record('run_command: alias not found', async () => {
      const call = await bench.callTool('run_command', { alias: 'nope', command: 'uptime' });
      return call;
    }, compactRun);

    // --- Structured file tools (real local files through FAKE_SSH_EXEC) ------
    const filesRoot = path.join(paths.root, 'remote-files');
    fs.mkdirSync(filesRoot, { recursive: true });
    fs.writeFileSync(path.join(filesRoot, 'nginx.conf'), makeNginxConf(20 * 1024));
    fs.mkdirSync(path.join(filesRoot, 'sites'), { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      fs.writeFileSync(
        path.join(filesRoot, 'sites', `site${String(index).padStart(2, '0')}.conf`),
        `server_name app${index}.internal;\nproxy_read_timeout 60s;\n`,
      );
    }
    seedConnections(paths.db, { count: 10, remotePath: filesRoot });
    process.env.FAKE_SSH_EXEC = '1';

    try {
      await record('read_remote_file: 40 lines of 20KiB config', async () => {
        const call = await bench.callTool('read_remote_file', {
          alias: 'web01',
          path: 'nginx.conf',
          offset: 1,
          limit: 40,
        });
        return call;
      }, (value: any) => value);

      await record('grep_remote: 1 match in 40 site files', async () => {
        const call = await bench.callTool('grep_remote', {
          alias: 'web01',
          pattern: 'app7\\.',
          path: 'sites',
        });
        return call;
      }, (value: any) => value);

      await record('stat_remote: 3 paths', async () => {
        const call = await bench.callTool('stat_remote', {
          alias: 'web01',
          paths: ['nginx.conf', 'sites', 'missing.conf'],
        });
        return call;
      }, (value: any) => value);

      await record('replace_in_remote_file: one line in 20KiB config', async () => {
        const call = await bench.callTool('replace_in_remote_file', {
          alias: 'web01',
          path: 'nginx.conf',
          oldText: 'server_name app0.example.com',
          newText: 'server_name app0.internal.example.com',
        });
        return call;
      }, (value: any) => value);

      await record('write_remote_file: atomic=true', async () => {
        const call = await bench.callTool('write_remote_file', {
          alias: 'web01',
          path: 'atomic.conf',
          content: 'port: 8080\nworkers: 4\n',
          atomic: true,
        });
        return call;
      }, (value: any) => value);
    } finally {
      delete process.env.FAKE_SSH_EXEC;
    }

    // --- Field-level costs ----------------------------------------------------
    seedConnections(paths.db, { count: 50 });
    const list50 = await bench.callTool('list_connections', {});
    const list50Text = list50.text;
    const list50Json = JSON.parse(list50Text) as Array<Record<string, any>>;
    const listFieldNames = [...new Set(list50Json.flatMap(connection => Object.keys(connection)))];
    const listFields = listFieldNames.map(field => {
      const value = list50Json.map(connection => JSON.stringify(connection[field] ?? null));
      const text = `"${field}":${value.join(',')}`;
      return {
        field,
        chars: text.length,
        tokens: tokens(text),
        shareOfResponse: pct(text.length, list50Text.length),
      };
    });

    // Small run, field-by-field.
    writeHostFixture(paths.sshDir, '_default', {
      out: ' 14:02:01 up 12 days,  3:14,  1 user,  load average: 0.08, 0.11, 0.09\n',
    });
    seedConnections(paths.db, { count: 10 });
    const single = await bench.callTool('run_command', { alias: 'web01', command: 'uptime' });
    const singleJson = JSON.parse(single.text) as Record<string, any>;
    const singleFields = Object.entries(singleJson).map(([field, value]) => {
      const text = `${JSON.stringify(field)}:${JSON.stringify(value)}`;
      return { field, chars: text.length, tokens: tokens(text), shareOfResponse: pct(text.length, single.text.length) };
    }).sort((a, b) => b.chars - a.chars);

    // run_on_many field costs: how often does each key appear and what does it cost?
    const many = await bench.callTool('run_on_many', { aliases: hosts, command: 'df -h /' });
    const manyJson = JSON.parse(many.text) as Record<string, any>;
    const resultKeys = new Map<string, { occurrences: number; chars: number }>();
    for (const result of manyJson.results as Array<Record<string, any>>) {
      for (const [key, value] of Object.entries(result)) {
        const entry = resultKeys.get(key) ?? { occurrences: 0, chars: 0 };
        entry.occurrences += 1;
        entry.chars += `${JSON.stringify(key)}:${JSON.stringify(value)}`.length;
        resultKeys.set(key, entry);
      }
    }
    const manyFields = [...resultKeys.entries()]
      .map(([field, entry]) => ({ field, ...entry, shareOfResponse: pct(entry.chars, many.text.length) }))
      .sort((a, b) => b.chars - a.chars);

    // --- Wire duplication check ----------------------------------------------
    const rawToolResponse = bench.lastResultWire() as any;
    const rawResult = rawToolResponse?.result ?? {};
    const wireShape = {
      resultKeys: Object.keys(rawResult),
      contentParts: Array.isArray(rawResult.content) ? rawResult.content.length : 0,
      hasStructuredContent: rawResult.structuredContent !== undefined,
      contentChars: rawResult.content?.[0]?.text?.length ?? 0,
      structuredChars: rawResult.structuredContent !== undefined
        ? JSON.stringify(rawResult.structuredContent).length
        : 0,
      duplicateChars: rawResult.structuredContent !== undefined
        ? (rawResult.content?.[0]?.text?.length ?? 0) + JSON.stringify(rawResult.structuredContent).length
        : 0,
    };

    const totalNow = rows.reduce((sum, row) => sum + row.textTokens, 0);
    const totalMinified = rows.reduce((sum, row) => sum + row.minifiedTokens, 0);
    const totalCompact = rows.reduce((sum, row) => sum + row.compactTokens, 0);

    // Head+tail check for the shipped default. The old shape is the explicit
    // 64 KiB head row above; this shows what the first/last split costs.
    const headTail = (bytes: number) => {
      const half = Math.floor(bytes / 2);
      const marker = '\n… [sshya] truncated: showing first+last bytes …\n';
      const text = big.slice(0, half) + marker + big.slice(-half);
      return { bytes, chars: text.length, tokens: tokens(text) };
    };
    const headTailProjection = [4096, 8192, 16384].map(headTail);
    const oldHeadRow = rows.find(row => row.name === 'run_command: 64KiB log, 64KiB head (old default)');
    const defaultRow = rows.find(row => row.name === 'run_command: 64KiB log, MCP default (8KiB headtail)');

    const result = {
      tokenizer: TOKENIZER_NAME,
      scenarios: rows,
      totals: {
        textTokens: totalNow,
        minifiedTokens: totalMinified,
        minifiedSavingsPct: totalNow === 0 ? 0 : Number((((totalNow - totalMinified) / totalNow) * 100).toFixed(1)),
        compactTokens: totalCompact,
        compactSavingsPct: totalNow === 0 ? 0 : Number((((totalNow - totalCompact) / totalNow) * 100).toFixed(1)),
      },
      listConnections50Fields: listFields,
      runCommandFields: singleFields,
      runOnManyFields: manyFields,
      headTailProjection,
      wireShape,
      findings: {
        defaultCapBytes: 8 * 1024,
        defaultMode: 'headtail',
        oldShapeTokens: oldHeadRow?.textTokens ?? null,
        defaultTokens: defaultRow?.textTokens ?? null,
        bytesPerTokenLog: Math.round((64 * 1024) / Math.max(1, oldHeadRow?.textTokens ?? 1)),
      },
    };
    const file = writeResults('call-cost.json', result);

    console.log(`tokenizer: ${TOKENIZER_NAME}\n`);
    console.log('PER-CALL RESPONSE COST (content[0].text, shipped minified JSON)');
    console.log('scenario'.padEnd(52) + 'chars'.padStart(9) + 'tokens'.padStart(9) + 'meta tok'.padStart(10));
    for (const row of rows) {
      console.log(
        row.name.padEnd(52)
        + fmt(row.textChars).padStart(9)
        + fmt(row.textTokens).padStart(9)
        + fmt(row.metadataTokens).padStart(10),
      );
    }
    console.log('\nTOTALS across scenarios');
    console.log(`measured ${fmt(totalNow)} tok; the minified/compact projection columns are historical (the response already is that shape)`);

    console.log('\nlist_connections (50) FIELD SHARE');
    for (const row of listFields) {
      console.log(`  ${row.field.padEnd(24)} ${fmt(row.chars).padStart(8)} ch  ${fmt(row.tokens).padStart(7)} tok  ${row.shareOfResponse.padStart(6)}`);
    }

    console.log('\nrun_command (small) FIELD SHARE');
    for (const row of singleFields.slice(0, 10)) {
      console.log(`  ${row.field.padEnd(24)} ${fmt(row.chars).padStart(8)} ch  ${fmt(row.tokens).padStart(7)} tok  ${row.shareOfResponse.padStart(6)}`);
    }

    console.log('\nrun_on_many RESULT-KEY OCCURRENCES');
    for (const row of manyFields) {
      console.log(`  ${row.field.padEnd(24)} x${String(row.occurrences).padEnd(3)} ${fmt(row.chars).padStart(8)} ch  ${row.shareOfResponse.padStart(6)}`);
    }

    console.log('\nWIRE SHAPE');
    console.log(JSON.stringify(wireShape, null, 2));
    console.log('\nHEAD+TAIL CHECK (64 KiB log, no truncation applied)');
    for (const row of headTailProjection) {
      console.log(`  ${String(row.bytes).padStart(6)} bytes -> ${fmt(row.tokens)} tok (old 64 KiB head default: ${fmt(oldHeadRow?.textTokens ?? 0)} tok; shipped default: ${fmt(defaultRow?.textTokens ?? 0)} tok)`);
    }
    console.log(`\nwrote ${file}`);
  } finally {
    await bench.close();
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
};

await main();
