#!/usr/bin/env bash
# Reproduce every measurement in bench/REPORT.md.
#
# No network, no remote hosts, no ~/.sshya or ~/.ssh access: each script uses
# SSHYA_DB/SSHYA_CONTROL_DIR under a temp dir and a local fake ssh binary.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/gpt-tokenizer ]; then
  bun install
fi

bun run 01-fixed-cost.ts
bun run 02-call-cost.ts
bun run 03-latency.ts
bun run 04-ergonomics.ts
bun run 05-stdin-epipe.ts

echo
echo "results written to bench/results/*.json"
