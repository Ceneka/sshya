# SSHya CLI - SSH Connection Manager

**Purpose**: CLI tool for managing SSH connections with aliases, interactive prompts, optional fzf selection, and an agent-friendly JSON + MCP interface.

## Core Features
- **Connection Management**: Add, remove, update, list, show SSH connections with custom aliases
- **Remote Execution**: Run non-interactive commands over a stored connection (`run`)
- **Import/Export**: JSON-based connection backup and restore (stdin/stdout supported)
- **Agent Interface**: Non-interactive flags, `--json`, meaningful exit codes, and `sshya mcp`

## Architecture
- **Runtime**: Node.js >= 20 for the published CLI; Bun >= 1.2 for development, tests, and builds
- **Language**: TypeScript
- **Packaging**: `scripts/build.ts` runs `bun build --target node` and writes `dist/index.js` / `dist/s.js` with a `#!/usr/bin/env node` shebang; local modules are bundled and dependencies stay external

## Key Components

### Database (`src/database.ts`)
- `Connection` interface with id, alias, user, host, key_path, port, remote_path, lastUsed, and optional `readonly`
- `upsertConnection()` for idempotent add-or-replace
- `getDbPath()` honors `SSHYA_DB` so tests and agents can use an isolated store
- Cache is keyed on file mtime/size so a long-running MCP server sees external edits

### SSH argv (`src/helpers/ssh.ts`)
- Single source of truth for `-i`, `-p`, `-t`/`-T`, `BatchMode`, `ConnectTimeout`, keepalives, host-key policy, ControlMaster, and `cd <remote_path> && <command>`
- `buildSshArgs()` for non-interactive/agent use, `buildInteractiveSshArgs()` for a login shell
- `buildSshOptionArgs()` is shared with scp (which uses `-P` for the port)

### Connection pool (`src/helpers/control.ts`, `src/connection/pool.ts`)
- Deterministic `ControlPath` under `$XDG_RUNTIME_DIR/sshya-<uid>/pool` (falls back to the temp dir, 0700)
- `ControlMaster=auto` + `ControlPersist` (default 300s, `SSHYA_CONTROL_PERSIST`)
- Reuse is on for `run`/`test`/`copy`, off for `connect`; disabled with `SSHYA_REUSE=0` or `--no-reuse`
- `sshya pool list|close` inspects or drops masters with `ssh -O check|exit`

### Output and errors (`src/helpers/capture.ts`, `src/helpers/errors.ts`)
- `ByteCapture` caps each stream (default 64 KiB), counts bytes/lines, preserves UTF-8 boundaries, and emits a truncation marker
- `classifySshError()` maps stderr to `errorKind` plus an actionable `hint`; timeouts win over other patterns, and sudo failures split into `tty` (`tty: true` / `sudo -n`) and `sudo_password` (NOPASSWD / `sudo -n`)

### Commands (`index.ts` / `s.ts`)
- `add`/`remove`/`update`/`list`/`show`: Manage connections
- `run [alias] -- <command...>`: Non-interactive remote command, streams or captures output; `--max-output`, `--tail`, `--no-reuse`, `--accept-new-host-key`
  - Non-interactive runs (`--json` or non-TTY stdout) default to a 120 s timeout; `--timeout 0` disables it
  - In capture/JSON mode a non-TTY stdin is streamed to the remote command; `--no-stdin` or `</dev/null` forces it off
- Alias resolution is centralized in `resolveAliasForCommand()` (`src/helpers/selectAlias.ts`): exact matches always win, fuzzy matching only for interactive TTYs outside JSON mode, and failures return up to three suggestions
- `print [alias]`: Output an interactive SSH command string for scripting/fzf
- `import`/`export`: JSON file or stdin/stdout operations; import has `--strategy ask|skip|overwrite|error`
- `test [alias]`: Exits non-zero on failure and reports stderr/hint
- `pool [list|close]`: Inspect or close pooled SSH masters
- `doctor [--probe]`: Checks ssh/scp, keys, agent, DB, pool, and optionally every alias
- `fzf`: In-process fzf picker that connects to the selected alias
- `s`: Shortcut entrypoint that always runs `connect` (interactive picker or alias)
- `mcp`: Starts the stdio MCP server (`--aliases a,b`, `--read-only`)

### Output (`src/output.ts`)
- `jsonEnabled()` returns true for `--json` or `SSHYA_JSON=1`
- Human messages use chalk; JSON mode never mixes styling into the payload
- Errors go to stderr; machine-readable error objects are emitted in JSON mode

### MCP (`src/mcp/server.ts`, `src/mcp/policy.ts`)
- `createMcpServer(options?)` is reusable for tests; `runMcpServer()` starts stdio
- Tools: `list_connections`, `get_connection`, `add_connection`, `update_connection`, `remove_connection`, `test_connection`, `run_command`, `run_on_many`, `write_remote_file`, `copy_file`, `print_ssh_command`, `import_connections`
- Resources: `sshya://connections` (lean JSON store) and `sshya://guide` (agent conventions, compact-response details, and the active policy)
- Responses are compact and minified: `ok()` uses `JSON.stringify` and `compactRunResult()` omits echoed input (`command`, `remoteCommand`, `target`, `cwd`), empty streams, zero counters, and false flags while always keeping `ok`, `exitCode`, and failure `errorKind`/`hint`. `run_command`/`run_on_many` accept `verbose: true` for the full shape.
- `list_connections` and `sshya://connections` return only `alias`, `target` (`user@host[:port]`), and non-empty `keyPath`/`remotePath`/`readonly`, sorted by `lastUsed` desc. `get_connection`/`print_ssh_command` keep the full detail and ssh argv.
- `run_on_many` supports `only: 'all' | 'failures'`, `match` (regex; matching stdout lines only), and `stdin`/`tty`/`reuse` parity with `run_command`; the summary `{total, succeeded, failed}` always covers every requested host.
- Errors are actionable: unknown aliases return `errorKind: 'alias_not_found'` plus up to three `suggestions`; sudo failures classify as `tty` (`tty: true` / `sudo -n`) or `sudo_password` (NOPASSWD / `sudo -n`). Every `failResult` carries an `errorKind`.
- MCP defaults: `acceptNewHostKey=true` (TOFU), `reuse=true`, output capped, `cwd=true`. Keep tool descriptions to one short sentence and param descriptions to a few words; put details in `sshya://guide` so `tools/list` stays under ~1,800 tokens.
- Guardrails: `--aliases`/`SSHYA_MCP_ALLOW` allowlist (simple `*`/`?` globs) makes alias-target tools refuse with `errorKind: 'alias_not_allowed'`, filters list/resource output, and constrains add/import. An allowlist that parses to zero patterns (for example `--aliases ,`) denies every alias instead of failing open.
- Guardrails: `--read-only`/`SSHYA_MCP_READ_ONLY=1` skips `add_connection`, `update_connection`, `remove_connection`, `import_connections`, and `write_remote_file`, and restricts `copy_file` to downloads. `run_command`/`run_on_many` stay because they are arbitrary remote execution; read-only guards the sshya store against MCP mutations and the remote host against uploads, but `copy_file` downloads still write local files at the caller-chosen path
- Guardrails: `copy`/`copy_file` refuse local operands that scp would interpret as remote (`host:path`) or that start with `-` (`errorKind: 'invalid-path'`), so a read-only download cannot become an upload to another host
- Connections with `readonly: true` refuse `write_remote_file` and `copy_file` uploads (`errorKind: 'connection_readonly'`); `run_command` is not restricted by the flag
- The active policy is exposed in server instructions and `sshya://guide`
- Never call `process.exit` from a tool; return `{ ok, error }` with `isError` instead
- Never `console.log` in the MCP process (stdout is the protocol channel)

## Usage Patterns
1. **Direct**: `sshya add` → Interactive prompt flow (TTY only)
2. **Fast connect**: `s` or `sshya connect` → built-in fuzzy picker (no shell rc changes)
3. **Agent store**: `sshya add web root@host --port 22 --json` → one-shot, no prompts
4. **Agent execute**: `sshya run web --json -- uptime` → ok/stdout/stderr/exitCode/truncation/hint
5. **MCP**: configure `sshya mcp` as a stdio MCP server (`run_command`, `run_on_many`, `write_remote_file`, ...)
6. **Scripting**: `sshya print my-server` → Outputs `ssh -p 2222 -t -i ~/.ssh/key user@host`
7. **Bulk**: `cat conns.json | sshya import - --strategy overwrite --json`
8. **Diagnose**: `sshya doctor --probe --accept-new-host-key` → checks binaries, keys, agent, pool, and reachability

## Notable Implementation Details
- `package.json` bins: `sshya` → `dist/index.js`, `s` → `dist/s.js` (built artifacts; `index.ts` / `s.ts` are the Bun-run dev entrypoints)
- `index.ts` must not read `import.meta.main` directly: Bun's bundler rewrites it into a Bun-only `require` shim that throws under Node. It reads the property dynamically and falls back to comparing `argv[1]` with `import.meta.url`
- Runtime code must stay Node-compatible (no `Bun.*`, `bun:` imports, or `import.meta.dir`); run `bun run build` before `npm pack` / `npm publish`
- Usage tracking via `lastUsed` timestamps
- Interactive commands guard on `process.stdin.isTTY`; no-TTY runs fail instead of hanging
- `run`/`test` default to `BatchMode=yes`, `-T`, and a connect timeout
- Timeout values are clamped to the `setTimeout` maximum (2^31-1 ms), and `run --timeout` rejects non-numeric/negative values instead of silently disabling the default
- Timeout exit code is `124`; otherwise SSH's exit code is passed through
- Always includes `-t` for interactive sessions (required for a proper pseudo-terminal)
- Timeouts kill the whole ssh process group (including helpers) and resolve even if pipes stay open
- Output is captured through `ByteCapture`; JSON callers never get an unbounded stdout/stderr
- Import validates every entry with zod before writing; `--strategy error` refuses to write partially
- File writes are plain JSON at `~/.sshya/sshm.json` by default
- Typecheck with `bun run typecheck`, tests with `bun test`

This tool prioritizes developer experience with fast, keyboard-driven workflows while remaining predictable for automated agents and MCP clients.
