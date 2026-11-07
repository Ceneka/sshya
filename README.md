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

## Agent Usage

Every management command works without prompts when you pass its flags, and
`--json` (or `SSHYA_JSON=1`) switches output to a stable, parseable document.
Exit codes are meaningful, so an agent can branch on success instead of parsing
text.

```bash
# Store a connection in one call (idempotent with --force)
sshya add web root@203.0.113.10 --port 2222 --key ~/.ssh/id_ed25519 --json

# Discover / inspect
sshya list --json
sshya show web --json

# Change one field, or rename
sshya update web --port 2200 --json
sshya update web --new-alias prod --json

# Non-interactive remote execution (no TTY; fails instead of prompting for a password)
sshya run web --json -- uptime
sshya run web --timeout 30 -- 'cd /srv/app && git status --short'

# Connectivity check: exits 1 and reports stderr when it fails
sshya test web --json

# Bulk provisioning from stdin
cat connections.json | sshya import - --strategy overwrite --json
```

Notes for scripting:

- `sshya run` uses `BatchMode=yes`, `-T`, and a `ConnectTimeout` by default. Pass
  `--allow-password` only when a human is present. `--tty` allocates a remote TTY.
- By default, commands run from the connection's `remote_path`; pass `--no-cwd`
  to run from the login directory. Relative paths in `sshya copy` are resolved
  the same way.
- A `run` or `copy` timeout exits `124`; a failing remote command passes through
  its SSH exit code.
- Set `SSHYA_DB=/path/to/sshm.json` to use an isolated store (useful for tests and
  per-agent workspaces).
- Interactive prompts are still used when you omit flags in a terminal. With no
  TTY, a missing alias or field is an error rather than a hang.

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
`copy_file`, `print_ssh_command`, and `import_connections`. The full store is
also available as the `sshya://connections` resource. `run_command` returns
stdout, stderr, the exit code, and a timeout flag; it does not allocate a TTY
unless asked.

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
The main application logic is in `index.ts`. SSH arguments are built in-process and passed directly to your system `ssh` binary, avoiding fragile shell string parsing. `src/helpers/ssh.ts` is the single place that assembles key, port, TTY, batch-mode, and remote-command arguments, so the CLI, JSON output, and MCP tools stay consistent.

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
