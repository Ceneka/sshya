/**
 * Child process for 05-stdin-epipe.ts. Deliberately runs one MCP call against a
 * fake ssh that exits without draining stdin, then reports what happened.
 *
 * Not a benchmark by itself; spawned by the parent so a crash cannot take the
 * measurement process down.
 */
import { createBenchEnv, seedConnections, startBenchClient, writeHostFixture } from '../lib/harness';

const mode = process.env.EPIPE_MODE === 'run-stdin' ? 'run-stdin' : 'write';
const bytes = Number(process.env.EPIPE_BYTES ?? 256 * 1024);

const paths = createBenchEnv(`sshya-epipe-${mode}`);
seedConnections(paths.db, { count: 1 });
writeHostFixture(paths.sshDir, '_default', { out: '' });

// The harness preserves an explicit value; default is to drain.
if (process.env.EPIPE_DRAIN === '0') {
  process.env.FAKE_SSH_DRAIN_STDIN = '0';
} else {
  process.env.FAKE_SSH_DRAIN_STDIN = '1';
}

const bench = await startBenchClient(paths);
console.log('CALL_START');

const result = mode === 'write'
  ? await bench.callTool('write_remote_file', {
    alias: 'web01',
    path: '/tmp/bench-payload',
    content: 'y'.repeat(bytes),
  })
  : await bench.callTool('run_command', {
    alias: 'web01',
    command: 'head -c 10',
    stdin: 'y'.repeat(bytes),
  });

const parsed = JSON.parse(result.text) as Record<string, unknown>;
console.log('TOOL_RETURNED', JSON.stringify({ ok: parsed.ok, keys: Object.keys(parsed) }));
console.log('CALL_DONE');
await bench.close();
console.log('CLEAN_EXIT');
