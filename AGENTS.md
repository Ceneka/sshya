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
- `Connection` interface with id, alias, user, host, key_path, port, remote_path, lastUsed
- `upsertConnection()` for idempotent add-or-replace
- `getDbPath()` honors `SSHYA_DB` so tests and agents can use an isolated store
- Cache is keyed on file mtime/size so a long-running MCP server sees external edits

### SSH argv (`src/helpers/ssh.ts`)
- Single source of truth for `-i`, `-p`, `-t`/`-T`, `BatchMode`, `ConnectTimeout`, and `cd <remote_path> && <command>`
- `buildSshArgs()` for non-interactive/agent use, `buildInteractiveSshArgs()` for a login shell

### Commands (`index.ts` / `s.ts`)
- `add`/`remove`/`update`/`list`/`show`: Manage connections
- `run [alias] -- <command...>`: Non-interactive remote command, streams or captures output
- `print [alias]`: Output an interactive SSH command string for scripting/fzf
- `import`/`export`: JSON file or stdin/stdout operations; import has `--strategy ask|skip|overwrite|error`
- `test [alias]`: Exits non-zero on failure and reports stderr
- `fzf`: In-process fzf picker that connects to the selected alias
- `s`: Shortcut entrypoint that always runs `connect` (interactive picker or alias)
- `mcp`: Starts the stdio MCP server

### Output (`src/output.ts`)
- `jsonEnabled()` returns true for `--json` or `SSHYA_JSON=1`
- Human messages use chalk; JSON mode never mixes styling into the payload
- Errors go to stderr; machine-readable error objects are emitted in JSON mode

### MCP (`src/mcp/server.ts`)
- `createMcpServer()` is reusable for tests
- Tools: `list_connections`, `get_connection`, `add_connection`, `update_connection`, `remove_connection`, `test_connection`, `run_command`, `copy_file`, `print_ssh_command`, `import_connections`
- Resource: `sshya://connections`
- Never call `process.exit` from a tool; return `{ ok, error }` with `isError` instead
- Never `console.log` in the MCP process (stdout is the protocol channel)

## Usage Patterns
1. **Direct**: `sshya add` → Interactive prompt flow (TTY only)
2. **Fast connect**: `s` or `sshya connect` → built-in fuzzy picker (no shell rc changes)
3. **Agent store**: `sshya add web root@host --port 22 --json` → one-shot, no prompts
4. **Agent execute**: `sshya run web --json -- uptime` → stdout/stderr/exitCode
5. **MCP**: configure `sshya mcp` as a stdio MCP server
6. **Scripting**: `sshya print my-server` → Outputs `ssh -p 2222 -t -i ~/.ssh/key user@host`
7. **Bulk**: `cat conns.json | sshya import - --strategy overwrite --json`

## Notable Implementation Details
- `package.json` bins: `sshya` → `index.ts`, `s` → `s.ts`
- Usage tracking via `lastUsed` timestamps
- Interactive commands guard on `process.stdin.isTTY`; no-TTY runs fail instead of hanging
- `run`/`test` default to `BatchMode=yes`, `-T`, and a connect timeout
- Timeout exit code is `124`; otherwise SSH's exit code is passed through
- Always includes `-t` for interactive sessions (required for a proper pseudo-terminal)
- Import validates every entry with zod before writing; `--strategy error` refuses to write partially
- File writes are plain JSON at `~/.sshya/sshm.json` by default

This tool prioritizes developer experience with fast, keyboard-driven workflows while remaining predictable for automated agents and MCP clients.
