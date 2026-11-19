/**
 * Bench harness: an in-process MCP client/server pair, a fake `ssh` binary, and
 * an isolated connection store. Nothing here touches ~/.sshya, ~/.ssh, or a
 * real remote host.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createMcpServer } from '../../src/mcp/server';
import type { Connection } from '../../src/database';

export interface TempPaths {
  root: string;
  db: string;
  ssh: string;
  sshDir: string;
  controlDir: string;
}

const preferredTmpRoot = '/tmp/opencode';

export const makeTempRoot = (prefix = 'sshya-bench'): string => {
  const base = fs.existsSync(preferredTmpRoot) ? preferredTmpRoot : os.tmpdir();
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
};

/**
 * The fake ssh script. It never opens a socket. Behaviour comes from files in
 * FAKE_SSH_DIR keyed by the host name parsed out of the `user@host` argument:
 *
 *   <host>.out / <host>.err  stream contents
 *   <host>.exit              exit code
 *   <host>.sleep             seconds to sleep (timeout tests)
 *   _default.*               fallback for every host
 *
 * FAKE_SSH_ARGV_LOG appends the argv it received (one JSON array per line) so
 * tests can inspect what sshya actually invokes.
 *
 * FAKE_SSH_EXEC=1 switches to execute mode: the last argument (the remote
 * command) runs locally through `sh -c` with the caller's stdin/stdout/stderr.
 * That is what the structured file tools need (real sed/awk/grep/stat/cksum on
 * real files); fixtures are ignored. It is still a local fake: no socket, no
 * authentication, no network.
 */
const FAKE_SSH_SCRIPT = `#!/bin/sh
# Fake OpenSSH client used by bench/. No network access.
target=""
for a in "$@"; do
  case "$a" in
    *@*) target="$a" ;;
  esac
done
host="\${target#*@}"
host="\${host%%:*}"

if [ -n "\${FAKE_SSH_ARGV_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "\${FAKE_SSH_ARGV_LOG}"
fi

if [ "\${FAKE_SSH_EXEC:-}" = "1" ]; then
  last=""
  for last_arg in "$@"; do last="$last_arg"; done
  if [ -z "$last" ]; then exit 1; fi
  exec sh -c "$last"
fi

dir="\${FAKE_SSH_DIR:-}"
# Drain stdin like a real ssh session forwarding to the remote command. When
# FAKE_SSH_DRAIN_STDIN=0 the script exits without reading, which reproduces the
# EPIPE-on-stdin path measured by 05-stdin-epipe.ts.
if [ "\${FAKE_SSH_DRAIN_STDIN:-1}" = "1" ]; then
  cat >/dev/null 2>&1 || true
fi
emit() {
  key="$1"
  suffix="$2"
  if [ -n "$dir" ] && [ -f "$dir/$host.$key" ]; then
    cat "$dir/$host.$key" >&"$suffix"
  elif [ -n "$dir" ] && [ -f "$dir/_default.$key" ]; then
    cat "$dir/_default.$key" >&"$suffix"
  fi
}

emit out 1
emit err 2

sleep_for=""
if [ -n "$dir" ] && [ -f "$dir/$host.sleep" ]; then
  sleep_for="$(cat "$dir/$host.sleep")"
elif [ -n "$dir" ] && [ -f "$dir/_default.sleep" ]; then
  sleep_for="$(cat "$dir/_default.sleep")"
elif [ -n "\${FAKE_SSH_SLEEP:-}" ]; then
  sleep_for="\${FAKE_SSH_SLEEP}"
fi
if [ -n "$sleep_for" ]; then
  sleep "$sleep_for"
fi

code=0
if [ -n "$dir" ] && [ -f "$dir/$host.exit" ]; then
  code="$(cat "$dir/$host.exit")"
elif [ -n "$dir" ] && [ -f "$dir/_default.exit" ]; then
  code="$(cat "$dir/_default.exit")"
elif [ -n "\${FAKE_SSH_EXIT:-}" ]; then
  code="\${FAKE_SSH_EXIT}"
fi
exit "$code"
`;

export const createFakeSsh = (root: string): { ssh: string; sshDir: string } => {
  const sshDir = path.join(root, 'fake-ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const ssh = path.join(sshDir, 'ssh');
  fs.writeFileSync(ssh, FAKE_SSH_SCRIPT, { mode: 0o755 });
  return { ssh, sshDir };
};

export const writeHostFixture = (
  sshDir: string,
  host: string,
  fixture: { out?: string; err?: string; exit?: number; sleep?: number },
): void => {
  if (fixture.out !== undefined) fs.writeFileSync(path.join(sshDir, `${host}.out`), fixture.out);
  if (fixture.err !== undefined) fs.writeFileSync(path.join(sshDir, `${host}.err`), fixture.err);
  if (fixture.exit !== undefined) fs.writeFileSync(path.join(sshDir, `${host}.exit`), String(fixture.exit));
  if (fixture.sleep !== undefined) fs.writeFileSync(path.join(sshDir, `${host}.sleep`), String(fixture.sleep));
};

export const clearHostFixtures = (sshDir: string): void => {
  for (const entry of fs.readdirSync(sshDir)) {
    if (entry !== 'ssh') {
      fs.rmSync(path.join(sshDir, entry), { force: true });
    }
  }
};

export interface SeedOptions {
  count: number;
  /** Base hostname; aliases become web01, web02, ... */
  prefix?: string;
  withKey?: boolean;
  withRemotePath?: boolean;
  /** Override the stored remote_path (default /srv/app). */
  remotePath?: string;
}

export const seedConnections = (dbPath: string, options: SeedOptions): Connection[] => {
  const prefix = options.prefix ?? 'web';
  const remotePath = options.remotePath
    ?? (options.withRemotePath === false ? undefined : '/srv/app');
  const connections: Connection[] = Array.from({ length: options.count }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return {
      id: index + 1,
      alias: `${prefix}${n}`,
      user: 'deploy',
      // Host == alias so the fake ssh can key fixtures by the host it sees in
      // `user@host` (fixtures are written by alias in the tasks).
      host: `${prefix}${n}`,
      ...(options.withKey === false ? {} : { key_path: '/home/deploy/.ssh/id_ed25519' }),
      port: '2222',
      ...(remotePath !== undefined ? { remote_path: remotePath } : {}),
      ...(index % 3 === 0 ? { lastUsed: 1_760_000_000_000 + index * 1000 } : {}),
    } as Connection;
  });

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(connections, null, 2));
  return connections;
};

export const createBenchEnv = (prefix = 'sshya-bench'): TempPaths => {
  const root = makeTempRoot(prefix);
  const { ssh, sshDir } = createFakeSsh(root);
  const paths: TempPaths = {
    root,
    db: path.join(root, 'sshm.json'),
    ssh,
    sshDir,
    controlDir: path.join(root, 'control'),
  };

  // Isolate every piece of global state that sshya reads.
  process.env.SSHYA_SSH_BIN = ssh;
  process.env.SSHYA_DB = paths.db;
  process.env.SSHYA_CONTROL_DIR = paths.controlDir;
  process.env.SSHYA_REUSE = '1';
  process.env.FAKE_SSH_DIR = paths.sshDir;
  delete process.env.FAKE_SSH_EXEC;
  delete process.env.SSHYA_MAX_OUTPUT;
  delete process.env.SSHYA_CONTROL_PERSIST;

  fs.mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.db, '[]');
  return paths;
};

export interface WireMessage {
  direction: 'client->server' | 'server->client';
  bytes: number;
  message: unknown;
}

export interface BenchClient {
  client: Client;
  paths: TempPaths;
  wire: WireMessage[];
  /** Raw JSON-RPC result payloads observed, newest last. */
  lastResultWire: () => unknown;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{
    ms: number;
    result: Record<string, unknown>;
    text: string;
    wireBytes: number;
  }>;
  close: () => Promise<void>;
}

export const startBenchClient = async (paths: TempPaths): Promise<BenchClient> => {
  process.env.SSHYA_DB = paths.db;
  process.env.SSHYA_SSH_BIN = paths.ssh;

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sshya-bench', version: '0.0.0' }, { capabilities: {} });

  const wire: WireMessage[] = [];
  const patch = (transport: InMemoryTransport, direction: WireMessage['direction']) => {
    const original = transport.send.bind(transport);
    transport.send = async (message: any, options?: any) => {
      wire.push({ direction, bytes: JSON.stringify(message).length, message });
      return original(message, options);
    };
  };
  patch(clientTransport, 'client->server');
  patch(serverTransport, 'server->client');

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const callTool: BenchClient['callTool'] = async (name, args) => {
    const before = wire.length;
    const startedAt = performance.now();
    const result = await client.callTool({ name, arguments: args }) as Record<string, unknown>;
    const ms = performance.now() - startedAt;
    const responses = wire.slice(before).filter(entry => entry.direction === 'server->client');
    const wireBytes = responses.reduce((sum, entry) => sum + entry.bytes, 0);
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find(part => part.type === 'text')?.text ?? '';
    return { ms, result, text, wireBytes };
  };

  return {
    client,
    paths,
    wire,
    lastResultWire: () => {
      for (let index = wire.length - 1; index >= 0; index -= 1) {
        const entry = wire[index]!;
        if (entry.direction === 'server->client') return entry.message;
      }
      return undefined;
    },
    callTool,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

/** Absolute path helper that keeps bench output under the repo. */
export const resultsDir = path.resolve(import.meta.dir, '..', 'results');

export const writeResults = (name: string, data: unknown): string => {
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
};

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

export const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};

/** Field-by-field serialized cost of a flat/nested JSON value. */
export const fieldCosts = (value: unknown, prefix = ''): Array<{ field: string; chars: number; tokens: number }> => {
  const rows: Array<{ field: string; chars: number; tokens: number }> = [];
  const visit = (node: unknown, name: string) => {
    if (node === null || typeof node !== 'object') {
      const text = JSON.stringify(node) ?? 'null';
      rows.push({ field: name, chars: text.length, tokens: 0 });
      return;
    }
    if (Array.isArray(node)) {
      if (node.length === 0) {
        rows.push({ field: name, chars: 2, tokens: 0 });
        return;
      }
      const text = JSON.stringify(node);
      rows.push({ field: `${name}[]`, chars: text.length, tokens: 0 });
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, name ? `${name}.${key}` : key);
    }
  };
  visit(value, prefix);
  return rows;
};
