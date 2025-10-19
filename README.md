# Project: sshya

This project is a command-line interface (CLI) tool named `sshya` for managing SSH connections.

## Core Functionality
- Add, remove, update, and list SSH connection configurations (alias, user, host, port, key path).
- Generate SSH command strings for saved connections.
- Import and export connections from/to a JSON file.
- A key feature is the fzf-based launcher that provides fast, keyboard-driven connection selection and execution using your system's SSH client.

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
The main application logic is in `index.ts`. The tool generates SSH command strings that are executed by your system's SSH client, providing a clean separation between connection management and actual SSH execution.

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

- The function displays your connections via `sshya list --oneline --names`, showing:
  - alias, user@host (for display), and a third tab-separated column containing ssh-ready arguments.
- After you pick an entry with `fzf`, it runs `sshya print <alias>` to obtain a single-line command string and then invokes your system `ssh` client.
- Argument splitting is handled per-shell to avoid issues with flags and quoting:
  - zsh: `ssh ${(z)command}`
  - bash: `read -r -a __args <<< "$command"; ssh "${__args[@]}"`

This ensures flags like `-p 2222` and identities like `-i '/path/with spaces/key'` are passed correctly to `ssh`.

### Why system ssh?

When launching from `fzf`, we intentionally use your host `ssh` binary instead of the built-in connect helper to avoid TTY and ZLE interaction problems.

### ZLE/TTY handling (zsh)

The snippet detaches the zsh line editor before starting `ssh` and restores it after:

- Before `ssh`: `zle -I`
- After `ssh`: `zle -R -c`

It also temporarily disables XON/XOFF flow control during selection (enables Ctrl-S) and restores your previous `stty` settings afterward.

### Keybinding

The snippet includes an example zsh binding:

```bash
zle -N fzf_sshya
bindkey '^S' fzf_sshya
```

For bash, see the printed notes (example: `bind -x` with Ctrl-S), and ensure flow control is disabled (`stty -ixon`).

### Troubleshooting

- If typing doesn't work in the remote session, make sure you've reloaded your shell after updating the snippet (it uses `zle -I`, `zle -R -c`, and restores `stty`).
- If the port or key path is ignored, ensure you're on the updated snippet which splits args correctly for zsh/bash and make sure `sshya print <alias>` outputs the expected `-p`/`-i` flags.
