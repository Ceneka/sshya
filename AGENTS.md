# SSHya CLI - SSH Connection Manager

**Purpose**: CLI tool for managing SSH connections with aliases, interactive prompts, and optional fzf selection.

## Core Features
- **Connection Management**: Add, remove, update, list SSH connections with custom aliases
- **Import/Export**: JSON-based connection backup and restore

## Architecture
- **Runtime**: Bun (JavaScript runtime)
- **Language**: TypeScript

## Key Components

### Database (`src/database.ts`)
- `Connection` interface with id, alias, user, host, key_path, port, remote_path

### Commands (`index.ts` / `s.ts`)
- `add`/`remove`/`update`/`list`: Manage connections
- `print [alias]`: Output SSH command for scripting
- `import`/`export`: JSON file operations
- `fzf`: In-process fzf picker that connects to the selected alias
- `s`: Shortcut entrypoint that always runs `connect` (interactive picker or alias)

## Usage Patterns
1. **Direct**: `sshya add` → Interactive prompt flow
2. **Fast connect**: `s` or `sshya connect` → built-in fuzzy picker (no shell rc changes)
3. **fzf**: `sshya fzf` → fzf-based selection, then the same connect flow
4. **Scripting**: `sshya print my-server` → Outputs `ssh -p 2222 -t -i ~/.ssh/key user@host`

## Notable Implementation Details
- `package.json` bins: `sshya` → `index.ts`, `s` → `s.ts`
- Usage tracking via `lastUsed` timestamps
- Always includes `-t` flag for proper pseudo-terminal allocation
- **High-performance optimizations**: ~0.2ms processing time for 8 connections with caching and pre-computation

This tool prioritizes developer experience with fast, keyboard-driven workflows while maintaining robust error handling and cross-platform compatibility.
