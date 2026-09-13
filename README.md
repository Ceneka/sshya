# Project: sshya

This project is a command-line interface (CLI) tool named `sshya` for managing SSH connections.

## Core Functionality
- Add, remove, update, and list SSH connection configurations (alias, user, host, port, key path, remote path).
- Connect to saved connections with `s` or `sshya connect` (aliases: `ssh`, `go`).
- Copy files through saved connections with `sshya copy` (aliases: `sc`, `scp`).
- Generate SSH command strings for scripting with `sshya print`.
- Import and export connections from/to a JSON file.
- Optional fzf picker with `sshya fzf`.

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
