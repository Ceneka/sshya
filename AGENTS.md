# SSHya CLI - SSH Connection Manager

**Purpose**: CLI tool for managing SSH connections with aliases, interactive prompts, and fzf integration.

## Core Features
- **Connection Management**: Add, remove, update, list SSH connections with custom aliases
- **Interactive Interface**: Uses inquirer.js for user-friendly prompts
- **fzf Integration**: Fast keyboard-driven connection selection via shell snippets
- **Import/Export**: JSON-based connection backup and restore

## Architecture
- **Runtime**: Bun (JavaScript runtime)
- **Language**: TypeScript with ESM modules
- **Storage**: JSON file at `~/.sshya/sshm.json`
- **Dependencies**: commander, inquirer, chalk, fuse.js, zod

## Key Components

### Database (`src/database.ts`)
- `Connection` interface with id, alias, user, host, key_path, port, remote_path
- Zod schema validation for data integrity
- Home directory expansion for paths (`~` → `/home/user`)
- CRUD operations with automatic normalization

### Commands (`index.ts`)
- `add`/`remove`/`update`/`list`: Manage connections
- `print [alias]`: Output SSH command for scripting/fzf
- `import`/`export`: JSON file operations
- `fzf`/`instructions`: Shell integration setup

### Interactive Features
- Fuzzy search for connection selection (fuse.js)
- Real-time validation with Zod schemas
- Colorized output (chalk)
- Graceful error handling with process.exit codes

## Usage Patterns
1. **Direct**: `sshya add` → Interactive prompt flow
2. **fzf Integration**: Shell function with `sshya print` for fast selection
3. **Scripting**: `sshya print my-server` → Outputs `ssh -p 2222 -t -i ~/.ssh/key user@host`

## Notable Implementation Details
- Interactive prompt handling with raw mode TTY for user input
- Shell-specific argument parsing (zsh vs bash) for fzf integration
- Automatic path normalization and validation
- Usage tracking via `lastUsed` timestamps
- Always includes `-t` flag for proper pseudo-terminal allocation
- Enhanced error handling and debugging for fzf integration issues

## Build & Installation
```bash
bun run build  # Creates bin/sshya binary
sudo mv bin/sshya /usr/local/bin/s  # Global access
```

This tool prioritizes developer experience with fast, keyboard-driven workflows while maintaining robust error handling and cross-platform compatibility.
