# SSHya CLI - SSH Connection Manager

**Purpose**: CLI tool for managing SSH connections with aliases, interactive prompts, optional fzf selection, and an agent-friendly JSON + MCP interface.

## Core Features
- **Connection Management**: Add, remove, update, list, show SSH connections with custom aliases
- **Remote Execution**: Run non-interactive commands over a stored connection (`run`)
- **Import/Export**: JSON-based connection backup and restore (stdin/stdout supported)
- **Agent Interface**: Non-interactive flags, `--json`, meaningful exit codes, and `sshya mcp`

## Architecture
- **Runtime**: Bun (JavaScript runtime)
- **Language**: TypeScript

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
- `classifySshError()` maps stderr to `errorKind` plus an actionable `hint`; timeouts win over other patterns

### Commands (`index.ts` / `s.ts`)
- `add`/`remove`/`update`/`list`/`show`: Manage connections
- `run [alias] -- <command...>`: Non-interactive remote command, streams or captures output; `--max-output`, `--tail`, `--no-reuse`, `--accept-new-host-key`
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
- Resources: `sshya://connections` (JSON store) and `sshya://guide` (agent conventions plus the active policy)
- MCP defaults: `acceptNewHostKey=true` (TOFU), `reuse=true`, output capped, `cwd=true`
- Guardrails: `--aliases`/`SSHYA_MCP_ALLOW` allowlist (simple `*`/`?` globs) makes alias-target tools refuse with `errorKind: 'alias_not_allowed'`, filters list/resource output, and constrains add/import
- Guardrails: `--read-only`/`SSHYA_MCP_READ_ONLY=1` skips `add_connection`, `update_connection`, `remove_connection`, `import_connections`, and `write_remote_file`, and restricts `copy_file` to downloads. `run_command`/`run_on_many` stay because they are arbitrary remote execution; read-only protects the sshya store and sshya file writes, not the remote host
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
- `package.json` bins: `sshya` → `index.ts`, `s` → `s.ts`
- Usage tracking via `lastUsed` timestamps
- Interactive commands guard on `process.stdin.isTTY`; no-TTY runs fail instead of hanging
- `run`/`test` default to `BatchMode=yes`, `-T`, and a connect timeout
- Timeout exit code is `124`; otherwise SSH's exit code is passed through
- Always includes `-t` for interactive sessions (required for a proper pseudo-terminal)
- Timeouts kill the whole ssh process group (including helpers) and resolve even if pipes stay open
- Output is captured through `ByteCapture`; JSON callers never get an unbounded stdout/stderr
- Import validates every entry with zod before writing; `--strategy error` refuses to write partially
- File writes are plain JSON at `~/.sshya/sshm.json` by default
- Typecheck with `bun run typecheck`, tests with `bun test`

This tool prioritizes developer experience with fast, keyboard-driven workflows while remaining predictable for automated agents and MCP clients.
