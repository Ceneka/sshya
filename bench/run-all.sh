#!/usr/bin/env bash
# Reproduce every measurement in bench/REPORT.md.
#
# No network, no remote hosts, no ~/.sshya or ~/.ssh access: each script uses
# SSHYA_DB/SSHYA_CONTROL_DIR under a temp dir and a local fake ssh binary.
# 06-hot-path.ts additionally starts the throwaway local sshd fixture from e2e/
# (skipped when sshd or dist/ is unavailable).
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

if [[ -x "${SSHYA_E2E_SSHD:-/usr/sbin/sshd}" ]] && command -v strace >/dev/null 2>&1; then
  if [ ! -f ../dist/index.js ]; then
    (cd .. && bun run build)
  fi
  bun run 06-hot-path.ts
else
  echo "06-hot-path.ts skipped: a local sshd and strace are required"
fi

echo
echo "results written to bench/results/*.json"
