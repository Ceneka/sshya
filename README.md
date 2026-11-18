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
- **Bounded output.** stdout and stderr are capped at 64 KiB per stream by
  default. Every JSON result reports `stdoutBytes`, `stderrBytes`, line counts,
  and `stdoutTruncated`/`stderrTruncated`; large streams get a visible marker.
  Use `--max-output 256k` or `--tail` when needed.
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
| `SSHYA_MAX_OUTPUT` | `65536` | Default per-stream capture cap (supports `64k`) |
| `SSHYA_HOST_KEY_CHECKING` | ssh default | `strict`, `accept-new`, or `ask` |
| `SSHYA_SSH_BIN` / `SSHYA_SCP_BIN` | `ssh` / `scp` | Alternate binaries |

### MCP server

`sshya mcp` starts a stdio MCP server that exposes the same store and operations
to MCP-capable agents:

```json
{
  "mcpServers": {
    "sshya": {
      "command": "sshya",
      "args": ["mcp"]
    }
  }
}
```

Tools: `list_connections`, `get_connection`, `add_connection`,
`update_connection`, `remove_connection`, `test_connection`, `run_command`,
`run_on_many`, `write_remote_file`, `copy_file`, `print_ssh_command`, and
`import_connections`. Resources: `sshya://connections` (the store) and
`sshya://guide` (agent conventions and recipes).

`run_command` returns a superset of the old result (`ok`, `stdout`, `stderr`,
`exitCode`, `timedOut`, `durationMs`, `reused`, byte counts, truncation flags,
`errorKind`, `hint`). `run_on_many` fans one command out to up to 50 aliases with
bounded concurrency. `write_remote_file` pipes bytes over SSH, so it works
without a local scp target and supports `encoding: base64`, `append`, and
`mode`. Neither tool allocates a TTY unless asked.


## Technology Stack
- **Runtime:** Bun
- **Language:** TypeScript
- **Dependencies:**
    - `commander`: For command-line argument parsing.
    - `inquirer`: For interactive prompts.
    - `chalk`: for terminal string styling.
    - `fuse.js`: for fuzzy searching connections.
    - `zod`: for validating user input and imported data.
    - `@modelcontextprotocol/sdk`: for the `sshya mcp` stdio server.

## Implementation Details
The main application logic is in `index.ts`. SSH arguments are built in-process and passed directly to your system `ssh` binary, avoiding fragile shell string parsing. `src/helpers/ssh.ts` is the single place that assembles key, port, TTY, batch-mode, keepalive, host-key, pooling, and remote-command arguments, so the CLI, JSON output, and MCP tools stay consistent.

Agent-facing behavior lives in three small helpers: `src/helpers/control.ts` (ControlMaster socket paths and lifecycle), `src/helpers/capture.ts` (bounded, UTF-8-safe stream capture with truncation metadata), and `src/helpers/errors.ts` (stable error classes plus actionable hints). `src/connection/run.ts` is the one-shot executor used by both `sshya run` and the MCP `run_command`/`run_on_many` tools.

The MCP server lives in `src/mcp/server.ts`. It reuses the same database and command helpers as the CLI, writes protocol messages to stdout only, and keeps diagnostics off the protocol channel. The connection store can be redirected with `SSHYA_DB`.

## Installation

Requires [Bun](https://bun.sh) >= 1.2.0, since the published entrypoints are TypeScript executed by Bun.

```bash
bun add -g sshya     # installs the `sshya` and `s` commands
```

Or with npm:

```bash
npm install -g sshya
```

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
