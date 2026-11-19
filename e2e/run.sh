#!/usr/bin/env bash
#
# Local-only end-to-end suite: starts a throwaway sshd on 127.0.0.1 as the
# current user, runs both the Bun entrypoint and the Node build against it, and
# tears everything down again. Nothing outside the temporary directory (and no
# remote host) is touched.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -x "${SSHYA_E2E_SSHD:-/usr/sbin/sshd}" ]]; then
  echo "sshd not found at ${SSHYA_E2E_SSHD:-/usr/sbin/sshd}; set SSHYA_E2E_SSHD to its path" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for the dist build" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required for the dev entrypoint and test runner" >&2
  exit 1
fi

bun run build
SSHYA_E2E=1 exec bun test e2e/e2e.test.ts "$@"
