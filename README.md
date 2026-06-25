# Project: sshya

This project is a command-line interface (CLI) tool named `sshya` for managing SSH connections.

## Core Functionality
- Add, remove, update, and list SSH connection configurations (alias, user, host, port, key path, remote path).
- Connect to saved connections with `sshya connect` (aliases: `ssh`, `go`).
- Copy files through saved connections with `sshya copy` (aliases: `sc`, `scp`).
- Generate SSH command strings for scripting with `sshya print`.
- Import and export connections from/to a JSON file.
- fzf-based launcher for fast, keyboard-driven connection selection.

## Technology Stack
- **Runtime:** Bun
- **Language:** TypeScript
- **Dependencies:**
    - `commander`: For command-line argument parsing.
    - `inquirer`: For interactive prompts.
    - `chalk`: for terminal string styling.
    - `fuse.js`: for fuzzy searching connections.
    - `zod`: for validating user input and imported data.

## Implementation Details
The main application logic is in `index.ts`. SSH arguments are built in-process and passed directly to your system `ssh` binary, avoiding fragile shell string parsing.

## fzf-based launcher

You can enable a fast, keyboard-driven launcher for your saved connections using `fzf`.

### Quick setup

1. Ensure `fzf` is installed.
2. Print the shell snippet:

   ```bash
   sshya fzf
   # or the aliases
   sshya instructions
   sshya install
   ```

3. Copy the printed snippet into your `~/.zshrc` or `~/.bashrc` and reload your shell.

### How it works

- The function displays your connections via `sshya list --oneline --names`, showing alias and user@host.
- After you pick an entry with `fzf`, it runs `sshya connect <alias>`.
- `sshya connect` builds SSH arguments in-process and spawns your system `ssh` with inherited stdio, so TTY behavior matches typing the command yourself.

### Usage

After adding the snippet to your shell rc and reloading, simply run:

```bash
s
```

This will launch the fzf interface for selecting and connecting to your saved SSH connections.

You can also connect directly without fzf:

```bash
sshya connect my-server
sshya connect          # interactive picker
```

### Copy files

Use stored connections for `scp` uploads and downloads:

```bash
sshya copy my-server ./local.txt /tmp/remote.txt
sshya copy ./local.txt /tmp/remote.txt              # interactive connection picker
sshya copy --download my-server /tmp/remote.txt ./
sshya copy --recursive my-server ./dist /var/www
```

The `copy` command also works as `sshya sc` or `sshya scp`. For a short no-fzf wrapper:

```bash
sc() {
  sshya copy "$@"
}
```

Relative remote paths are resolved from the connection's saved remote working directory when one is configured.
If an exact alias is not found, `connect` and `copy` use the first fuzzy match from the same search used by the interactive picker.

### Troubleshooting

- If fzf filtering looks wrong, reload your shell after updating the snippet. The launcher should call `sshya connect`, not parse `sshya print` output.
- If the port or key path is ignored, verify the connection with `sshya test <alias>`.
