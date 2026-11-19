# sshya context-cost bench

Reproducible measurements of what `sshya` costs an LLM agent in context and
tool calls. This directory is research only: it does not change product code.

The narrative report with numbers and recommendations is
[`REPORT.md`](./REPORT.md).

## Run

```bash
cd bench
bun install        # gpt-tokenizer, used for real BPE counts
./run-all.sh
```

Requires Bun >= 1.2. `run-all.sh` writes `bench/results/*.json` and prints the
same tables that appear in the report.

## What is measured

| Script | Measures |
| --- | --- |
| `01-fixed-cost.ts` | `initialize.instructions`, `tools/list` (per tool: description + schema), `resources/list`, and `sshya://guide` |
| `02-call-cost.ts` | Response size for `run_command` (tiny, 64 KiB log at several caps), `run_on_many` (10/50 hosts, all/failures/match), `test_connection`, `list_connections` (5/50), failures (auth, host key, timeout), `get_connection`, `write_remote_file` (whole-file and atomic), and the four structured file tools |
| `03-latency.ts` | Process-spawn floor vs `executeSshCommand` vs MCP round trip; 10-host fan-out; 64 KiB capture at the 8 KiB head+tail default |
| `04-ergonomics.ts` | Realistic agent tasks with the final tool mix (structured file tools included), compared against the original 0.6.0 totals from `REPORT.md` §4 |
| `05-stdin-epipe.ts` | Child-process reproduction of unhandled EPIPE when ssh exits without draining stdin |

## Method

- **Real server.** Every MCP measurement calls the actual `createMcpServer()`
  through the SDK's `InMemoryTransport` + `Client`. Numbers are not simulated
  from source text.
- **Fake ssh only.** `SSHYA_SSH_BIN` points at `bench/lib/harness.ts`'s shell
  script. It emits fixture stdout/stderr and exit codes keyed by the host in the
  `user@host` argument. It never opens a socket. The structured file tools need
  real `sed`/`awk`/`grep`/`stat`/`cksum`, so those scenarios set
  `FAKE_SSH_EXEC=1`: the fake executes the remote command locally through
  `sh -c` against files under the bench temp dir. Still no socket and no
  network; the e2e suite covers the same tools against a real local sshd.
- **Isolated state.** `SSHYA_DB`, `SSHYA_CONTROL_DIR`, and `FAKE_SSH_DIR` live
  under a fresh `/tmp/opencode/sshya-bench-*` directory. `~/.sshya` and `~/.ssh`
  are never touched.
- **Tokens.** `gpt-tokenizer` 3.4.0 with the `o200k_base` encoding (GPT-4o
  family), plus `cl100k_base` where useful. `chars/4` is reported for comparison;
  for JSON and logs the real count differs materially, so the report uses the
  tokenizer numbers. The reported `tokens` are payload tokens only (the
  `content[0].text` an agent receives), not JSON-RPC envelope bytes.
- **Compact/lean projections.** `compact` results and slimmer tool lists are
  transformations of the *measured* JSON in memory, never product edits. They
  show what a different response shape would cost; they are labeled as
  projections in the report.
- **No sshd on 127.0.0.1:22** in this environment, so real SSH handshake and
  ControlMaster reuse latency were not measured. `03-latency.ts` measures the
  local overhead on top of the fake ssh and says so explicitly.
