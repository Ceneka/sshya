# Project: sshya

This project is a command-line interface (CLI) tool named `sshya` for managing SSH connections.

## Core Functionality
- Add, remove, update, list, and show SSH connection configurations (alias, user, host, port, key path, remote path).
- Connect to saved connections with `s` or `sshya connect` (aliases: `ssh`, `go`).
- Run non-interactive remote commands with `sshya run` (alias: `exec`).
- Copy files through saved connections with `sshya copy` (aliases: `sc`, `scp`).
- Generate SSH command strings for scripting with `sshya print`.
- Import and export connections from/to a JSON file, including stdin/stdout.
- Optional fzf picker with `sshya fzf`.
- Agent interface with non-interactive flags, `--json`, exit codes, and an MCP server (`sshya mcp`).

## Agent / LLM usage

sshya is designed for agents that call it one command at a time:

- **No interactive shell.** `sshya run` executes one command in a fresh remote
  login shell and returns. `cd` and exports do not persist between calls; pass
  `cwd` (default: the connection's `remote_path`) or include `cd ... && ...` in
  the command. This keeps every call reproducible and avoids a fragile
  long-lived shell.
- **Warm connections.** OpenSSH `ControlMaster`/`ControlPersist` is used
  transparently. The first call pays the handshake (~150 ms locally, more over
  WAN); later calls typically take 5-20 ms and report `"reused": true`. The
  master expires after 5 minutes (`SSHYA_CONTROL_PERSIST`), or immediately with
  `sshya pool close <alias>`.
- **Bounded output.** In `--json` mode stdout and stderr are capped at 16 KiB
  per stream by default (`SSHYA_MAX_OUTPUT` or `--max-output` overrides it).
  The cap keeps the first half and the last half (`headtail`, cuts prefer
  newline boundaries); `--truncate head|tail|headtail` picks another cut. Every
  JSON result reports `stdoutBytes`, `stderrBytes`, line counts,
  `stdoutTruncated`/`stderrTruncated`, and, only when something was cut,
  `truncation`. Non-JSON runs stream stdout untouched. The MCP tools default to
  8 KiB stdout + 4 KiB stderr in `headtail` mode.
- **Actionable failures.** JSON results include a stable `errorKind` (`auth`,
  `host-key`, `dns`, `refused`, `timeout`, `network`, `remote-permission`, ...)
  and a `hint` with the concrete next step.
- **No hanging prompts.** `BatchMode=yes`, `-T`, and a connect timeout are on by
  default. Use `--allow-password` only when a human is present. `--tty` allocates
  a remote TTY for commands that need one.

```bash
# Store a connection in one call (idempotent with --force)
sshya add web root@203.0.113.10 --port 2222 --key ~/.ssh/id_ed25519 --json

# Discover / inspect
sshya list --json
sshya show web --json

# Non-interactive execution (JSON includes exit code, truncation, hint)
sshya run web --json -- uptime
sshya run web --json -- 'journalctl -u nginx | tail -n 50'
sshya run web --timeout 30 --max-output 256k --json -- 'du -sh /var/*'

# First contact with an unknown host key: retry with TOFU
sshya run web --accept-new-host-key --json -- hostname

# Reuse is automatic; inspect or drop pooled masters
sshya pool list
sshya pool close web

# Self-diagnosis (optionally probes every alias in parallel)
sshya doctor --json
sshya doctor --probe --accept-new-host-key

# Connectivity check: exits 1 and reports stderr/hint when it fails
sshya test web --json

# Bulk provisioning from stdin
cat connections.json | sshya import - --strategy overwrite --json
```

Notes for scripting:

- A `run` or `copy` timeout exits `124`; a failing remote command passes through
  its SSH exit code. `run --json` sets `"ok": false` and fills `errorKind`/`hint`.
- `--no-reuse` forces a cold connection (useful to verify that a host really
  accepts new sessions, or after changing sshd configuration).
- Host keys are checked by OpenSSH by default. MCP tools trust an unknown key
  once (TOFU) unless `acceptNewHostKey: false`; the CLI opts in with
  `--accept-new-host-key`, and `--strict-host-key` forces an already-known key.
- Set `SSHYA_DB=/path/to/sshm.json` to use an isolated store (useful for tests and
  per-agent workspaces). `SSHYA_JSON=1` forces JSON output.
- Interactive prompts are still used when you omit flags in a terminal. With no
  TTY, a missing alias or field is an error rather than a hang.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SSHYA_DB` | `~/.sshya/sshm.json` | Alternate connection store |
| `SSHYA_JSON` | unset | `1` makes every command emit JSON |
| `SSHYA_REUSE` | on | `0` disables ControlMaster pooling |
| `SSHYA_CONTROL_PERSIST` | `300` | Seconds a pooled master stays alive |
| `SSHYA_CONTROL_DIR` | `$XDG_RUNTIME_DIR/sshya-<uid>/pool` | Socket directory |
| `SSHYA_MAX_OUTPUT` | `16384` | Default CLI/JSON per-stream capture cap (supports `64k`); MCP caps are separate |
| `SSHYA_HOST_KEY_CHECKING` | ssh default | `strict`, `accept-new`, or `ask` |
| `SSHYA_SSH_BIN` / `SSHYA_SCP_BIN` | `ssh` / `scp` | Alternate binaries |
| `SSHYA_MCP_ALLOW` | unset | Alias allowlist for `sshya mcp` (comma-separated, supports `*`/`?` globs) |
| `SSHYA_MCP_READ_ONLY` | unset | `1` removes MCP tools that mutate the store or write files |

### MCP client setup

`sshya mcp` starts a stdio MCP server that exposes the same store and operations
to MCP-capable agents. The published package is plain Node.js, so
`npx -y sshya mcp` works even on machines without Bun.

Claude Code:

```bash
claude mcp add sshya -- npx -y sshya mcp
```

Claude Desktop / Cursor (`mcpServers` config):

```json
{
  "mcpServers": {
    "sshya": {
      "command": "npx",
      "args": ["-y", "sshya", "mcp"]
    }
  }
}
```

Bun alternative:

```json
{
  "mcpServers": {
    "sshya": {
      "command": "bunx",
      "args": ["sshya", "mcp"]
    }
  }
}
```

If sshya is installed globally, `"command": "sshya", "args": ["mcp"]` also
works. Add an `env` block with `SSHYA_DB` to isolate an agent workspace:

```json
{
  "mcpServers": {
    "sshya": {
      "command": "npx",
      "args": ["-y", "sshya", "mcp"],
      "env": { "SSHYA_DB": "/home/me/.sshya/agent-sshm.json" }
    }
  }
}
```

Tools: `list_connections`, `get_connection`, `add_connection`,
`update_connection`, `remove_connection`, `test_connection`, `run_command`,
`run_on_many`, `read_remote_file`, `replace_in_remote_file`, `grep_remote`,
`stat_remote`, `write_remote_file`, `copy_file`, `print_ssh_command`, and
`import_connections` (mutating tools are absent in read-only mode). Resources:
`sshya://connections` (the store) and `sshya://guide` (agent conventions,
recipes, and the active policy).

Output defaults to 8 KiB stdout + 4 KiB stderr in `headtail` mode;
`maxOutputBytes` raises the stdout cap, and `truncate: "head" | "tail" |
"headtail"` chooses which part survives (`tail: true` is still accepted as a
deprecated alias). Narrow large logs with `grep`,
`sed -n`, or `tail -n` instead of raising the cap.

MCP responses are compact and minified by default: they keep `ok`, `exitCode`,
streams that have content, truncation data, `errorKind`/`hint`, and drop echoed
input (`command`, `remoteCommand`, `target`, `cwd`), empty streams, zero
counters, and false flags. Pass `verbose: true` to `run_command` or
`run_on_many` for the full result. `run_command` still reports everything the
CLI JSON path returns in verbose mode (`durationMs`, `reused`, byte and line
counts, truncation flags).

`list_connections` and `sshya://connections` return only `alias`, `target`
(`user@host[:port]`), and non-empty `keyPath`/`remotePath`/`readonly`, sorted by
most recently used. Use `get_connection` or `print_ssh_command` when you need
ssh args or the copy-pasteable command. `run_on_many` fans one command out to up
to 50 aliases with bounded concurrency and always reports
`{total, succeeded, failed}`; `only: "failures"` and `match` (a regex that keeps
only matching stdout lines) trim fleet replies, and `stdin`, `tty`, and `reuse`
work like `run_command`.

`read_remote_file` returns a numbered line range plus the file's total line
count in one round trip, so agents do not have to `cat` a large file.
`replace_in_remote_file` replaces an exact string, verifies the occurrence
count, and renames a temp file into place instead of re-uploading the whole file
through the model; it reports `match_count` and `conflict` instead of guessing.
`grep_remote` returns compact `file:line:text` matches, and `stat_remote`
reports size/mode/mtime/type. `write_remote_file` pipes bytes over SSH and
supports `encoding: base64`, `append`, `mode`, and `atomic: true` (temp file
plus rename). None of these tools allocate a TTY unless asked.

An unknown alias fails with `errorKind: "alias_not_found"` and up to three
fuzzy `suggestions` (never executed automatically). sudo failures classify as
`tty` (retry with `tty: true`, or use `sudo -n`) or `sudo_password` (configure
NOPASSWD or use `sudo -n`). Tool descriptions stay short; the
[`sshya://guide`](sshya://guide) resource holds the details on pooling,
truncation, and error handling.

### Restricting the MCP server

Scope the server down before handing it to an LLM:

```json
{
  "mcpServers": {
    "sshya": {
      "command": "sshya",
      "args": ["mcp", "--aliases", "web,stg-*", "--read-only"]
    }
  }
}
```

The equivalent environment variables:

```sh
SSHYA_MCP_ALLOW='web,stg-*' SSHYA_MCP_READ_ONLY=1 sshya mcp
```

- `--aliases` / `SSHYA_MCP_ALLOW` limits which aliases are exposed. Values are
  comma-separated and support simple `*` and `?` globs. Tools that target another
  alias fail with `errorKind: "alias_not_allowed"`; `list_connections` and
  `sshya://connections` only return allowed aliases, and `add_connection` /
  `import_connections` can only create allowed aliases.
- `--read-only` / `SSHYA_MCP_READ_ONLY=1` does not register `add_connection`,
  `update_connection`, `remove_connection`, `import_connections`,
  `write_remote_file`, or `replace_in_remote_file`, and restricts `copy_file` to
  `direction: "download"`. `read_remote_file`, `grep_remote`, and `stat_remote`
  remain available.
- `copy`/`copy_file` refuse a local path that scp would reinterpret as a remote
  target (`host:path`) or that starts with `-`, so a read-only download cannot
  be turned into an upload to another host.
- A connection can be marked `readonly: true` to refuse `replace_in_remote_file`,
  `write_remote_file`, and `copy_file` uploads for that alias
  (`errorKind: "connection_readonly"`). `add_connection`, `update_connection`,
  and `import_connections` accept the flag, and `update_connection` with
  `readonly: false` clears it.

Read-only mode guards the sshya store against MCP mutations and the remote host
against uploads. It does **not** sandbox anything: `run_command` and
`run_on_many` still execute arbitrary commands with the SSH user's permissions,
and `copy_file` downloads still write local files at the caller-chosen path.


## Technology Stack
- **Runtime:** Node.js >= 20 for the published CLI (`dist/`); Bun >= 1.2 for
  development, tests, and building.
- **Language:** TypeScript
- **Build:** `bun build --target node` via `scripts/build.ts`; local modules and
  runtime dependencies are bundled and minified into content-hashed ESM chunks,
  so the published package has no runtime `dependencies`.
- **Dependencies:** bundled into `dist` at build time (listed in
  `devDependencies`):
    - `commander`: For command-line argument parsing.
    - `zod`: for validating user input and imported data.
    - `@modelcontextprotocol/sdk`: for the `sshya mcp` stdio server.
- **In-house replacements** (`src/lib/`, no third-party code): `color.ts`
  (chalk 5 subset, byte-identical output), `fuzzy.ts` (Fuse.js 7 Bitap scoring
  for alias search), and `prompts.ts` (inquirer `input`/`confirm`/`select`/
  `search`). `chalk`, `fuse.js`, and `inquirer` remain dev-only, as references
  for the parity tests next to each module.

## Implementation Details
The main application logic is in `index.ts`. SSH arguments are built in-process and passed directly to your system `ssh` binary, avoiding fragile shell string parsing. `src/helpers/ssh.ts` is the single place that assembles key, port, TTY, batch-mode, keepalive, host-key, pooling, and remote-command arguments, so the CLI, JSON output, and MCP tools stay consistent.

Agent-facing behavior lives in three small helpers: `src/helpers/control.ts` (ControlMaster socket paths and lifecycle), `src/helpers/capture.ts` (bounded, UTF-8-safe stream capture with head/tail/head+tail truncation metadata), and `src/helpers/errors.ts` (stable error classes plus actionable hints). `src/connection/run.ts` is the one-shot executor used by both `sshya run` and the MCP `run_command`/`run_on_many` tools.

The MCP server lives in `src/mcp/server.ts`. It reuses the same database and command helpers as the CLI, writes protocol messages to stdout only, and keeps diagnostics off the protocol channel. The connection store can be redirected with `SSHYA_DB`. Remote file tools (`read_remote_file`, `replace_in_remote_file`, `grep_remote`, `stat_remote`, plus the atomic write helper) live in `src/mcp/fileTools.ts` and share the same SSH executor and policy checks.

## Installation

The published package is plain ESM JavaScript with a `#!/usr/bin/env node`
shebang, so it runs on **Node.js >= 20** without Bun.

```bash
npm install -g sshya       # installs the `sshya` and `s` commands
npx -y sshya --help        # or run it without installing
```

Bun users can install the same package with `bun add -g sshya`, or run it with
`bunx sshya --help`.

### Development

A source checkout uses Bun for the developer workflow; the build output targets
Node:

```bash
bun install
bun run typecheck
bun test
bun run build              # writes dist/index.js and dist/s.js for Node
```

`bun run build` bundles local modules and runtime dependencies with
`bun build --target node`, minifies them, splits dynamic imports (`sshya mcp`)
into a separate chunk, and rewrites the two shebangs to `#!/usr/bin/env node`.
The package ships `dist/` only and has no runtime `dependencies`.
`npm publish` runs typecheck, tests, and the build via `prepublishOnly`.

For startup work, `bun run bench:startup` measures `--version`, `--help`,
`list --json`, and a pooled `run` against a throwaway local sshd (10 runs per
case, median). It uses an isolated `SSHYA_DB` and never touches `~/.sshya` or
`~/.ssh`.

## Connecting

Install exposes two commands: `sshya` for management, and `s` as a shortcut to connect. No shell rc changes are required.

```bash
s                      # interactive picker (type to filter)
s my-server            # connect by alias
sshya connect          # same picker
sshya connect my-server
```

`s` and `sshya connect` use the built-in fuzzy picker. If you prefer fzf:

```bash
sshya fzf
```

That requires `fzf` on your PATH. After you pick an entry, it runs the same in-process `connect` flow and spawns your system `ssh` with inherited stdio.

### Copy files

Use stored connections for `scp` uploads and downloads:

```bash
sshya copy my-server ./local.txt /tmp/remote.txt
sshya copy ./local.txt /tmp/remote.txt              # interactive connection picker
sshya copy --download my-server /tmp/remote.txt ./
sshya copy --recursive my-server ./dist /var/www
```

The `copy` command also works as `sshya sc` or `sshya scp`.

Relative remote paths are resolved from the connection's saved remote working directory when one is configured.
If an exact alias is not found, `connect` and `copy` use the first fuzzy match from the same search used by the interactive picker.

### Troubleshooting

- If `s` is not found, reinstall or relink the package so both bins (`sshya` and `s`) are on your PATH.
- If `s` still opens an old fzf shell function, remove the `s()` snippet from `~/.zshrc` or `~/.bashrc` so the installed binary is used.
- If `sshya fzf` fails, install `fzf` or use `s` / `sshya connect` instead.
- If the port or key path is ignored, verify the connection with `sshya test <alias>`.
- `Host key verification failed`: retry with `sshya run <alias> --accept-new-host-key ...` (or `sshya test <alias> --accept-new-host-key`) after verifying the host out of band. Use `ssh-keygen -R <host>` if the key legitimately changed.
- `Permission denied (publickey)`: run `sshya show <alias> --json` and confirm the stored user/key; ensure the public key is in the remote `~/.ssh/authorized_keys`.
- First command is slow, later ones fast: that is the pool working. `sshya pool list --json` shows active masters; `sshya pool close <alias>` drops one.
- Run `sshya doctor --probe --json` for a single diagnostic document covering binaries, keys, agent, pool, and reachability. Every JSON error includes an `errorKind` and `hint`.
