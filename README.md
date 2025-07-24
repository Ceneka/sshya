# Project: sshya

This project is a command-line interface (CLI) tool named `sshya` for managing SSH connections.

## Core Functionality
- Add, remove, update, and list SSH connection configurations (alias, user, host, port, key path).
- Connect to saved SSH connections.
- Import and export connections from/to a JSON file.
- A key feature is the interactive `ssh` connection, which has been optimized to provide a smooth, responsive typing experience and correct terminal resizing behavior.

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
The main application logic is in `index.ts`. It uses `child_process.spawn` to run the `ssh` command. Significant effort was made to fix issues with the interactive SSH session, including:
- Laggy typing and missing keystrokes.
- Incorrect terminal behavior on window resizing.

The final solution involves:
1.  Spawning the `ssh` process with `stdio: 'pipe'`.
2.  Setting the local terminal to `rawMode` (`process.stdin.setRawMode(true)`).
3.  Piping `stdin`, `stdout`, and `stderr` between the main process and the child `ssh` process.
4.  Manually listening for `resize` events on `process.stdout` and forwarding them to the `ssh` child process by sending a `SIGWINCH` signal.
5.  Using specific `ssh` command-line options (`-tt`, `ServerAliveInterval`, etc.) to ensure a stable and responsive interactive session.
