# sshya → LLM agent: context cost and ergonomics

Measured on 2026-11-19 with Bun 1.4.4, `@modelcontextprotocol/sdk` 1.32.2, and
`gpt-tokenizer` 3.4.0 (`o200k_base`, the GPT-4o-family encoding). Every MCP number
comes from the real `createMcpServer()` over the SDK's `InMemoryTransport`; the
ssh side is a local fake binary. **No remote host was contacted, no local sshd
was used, and `~/.sshya` / `~/.ssh` were not modified.** Reproduce with
[`bench/run-all.sh`](./run-all.sh); raw numbers are in [`bench/results/`](./results).

`chars/4` is shown for comparison but is not used for conclusions. JSON and log
lines tokenize worse than that rule: the 64 KiB log is 3.0 chars/token, so
`chars/4` under-counts it by 26%.

---

## 1. Fixed context cost

What an agent pays before its first command. Store contents do not affect this
section (the seed is 5 connections; the tool list is static):

| Component | Chars | Tokens | chars/4 | Share of always-on |
| --- | ---: | ---: | ---: | ---: |
| `initialize.instructions` | 727 | **146** | 182 | 5.3% |
| `tools/list` (12 definitions) | 11,566 | **2,592** | 2,892 | 94.7% |
| Always-on total (instructions + tools) | 12,293 | **2,738** | 3,074 | 100% |
| `resources/list` (names only) | 344 | 76 | 86 | — |
| `sshya://guide` (on demand) | 1,734 | 454 | 434 | — |
| Instructions + tools + guide | 14,027 | **3,192** | 3,507 | — |

The JSON-RPC envelope and string escaping add bytes on the wire but not tokens to
the parsed text, so they are excluded here.

### Per-tool cost

| Tool | Chars | chars/4 | Description tok | Schema tok | Total tok | Params | Param-description tok |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `run_command` | 2,069 | 518 | 160 | 277 | **464** | 10 | 104 |
| `write_remote_file` | 1,626 | 407 | 92 | 266 | **385** | 9 | 91 |
| `run_on_many` | 1,525 | 382 | 64 | 252 | **345** | 9 | 70 |
| `copy_file` | 1,123 | 281 | 40 | 182 | **249** | 9 | 38 |
| `add_connection` | 921 | 231 | 21 | 161 | 209 | 7 | 43 |
| `test_connection` | 937 | 235 | 51 | 124 | 209 | 4 | 37 |
| `import_connections` | 842 | 211 | 25 | 130 | 180 | 2 | 9 |
| `update_connection` | 679 | 170 | 26 | 101 | 153 | 7 | 10 |
| `print_ssh_command` | 655 | 164 | 35 | 66 | 137 | 2 | 15 |
| `get_connection` | 398 | 100 | 10 | 44 | 88 | 1 | 3 |
| `remove_connection` | 402 | 101 | 8 | 44 | 86 | 1 | 3 |
| `list_connections` | 366 | 92 | 26 | 24 | **83** | 0 | 0 |

Top four tools are 1,443 tok, 55.7% of `tools/list`. The two biggest levers are
`run_command` (6-sentence description plus 10 params) and `write_remote_file`
(9 params, 91 tok of param prose). `list_connections` proves that a tool does not
need a long description: 26 tok is enough.

### Redundancy

| Item | Occurrences | Tokens |
| --- | ---: | ---: |
| Description text, all tools | — | 558 |
| JSON Schema, all tools | — | 1,671 |
| — of which parameter descriptions | — | 423 |
| SDK `$schema` URL per tool | 12 | 132 |
| SDK `execution.taskSupport` per tool | 12 | 84 |
| `title` (mostly repeats the name) | 12 | 50 |
| `annotations` (readOnly/destructive hints) | 5 | 42 |
| `maximum: 9007199254740991` on ints | 5 | 30 |
| Exact repeated sentences | 3 | 57 wasted |
| Repeated parameter sentences (`Exact connection alias` ×7, TOFU ×3, reuse ×3, timeout ×2) | — | 75 wasted |

The repetition itself is small (≤132 tok). The real cost is that the same facts
appear in three places: tool description, parameter description, and
`initialize.instructions` (plus the guide). For example the TOFU sentence and
the pooling sentence each appear three times; `run_command` says "default
64 KiB", "default true", "default true" again in its schema.

### Projection: a leaner `tools/list` (no product change)

The measured `tools/list` JSON was transformed in memory:

| Variant | Tools/list tok | Always-on tok | Saving vs today |
| --- | ---: | ---: | ---: |
| Current | 2,592 | 2,738 | — |
| First sentence + no titles + 40-char param descriptions | 2,025 | 2,171 | **567 tok (20.7%)** |
| Same, no parameter descriptions at all | 1,539 | 1,685 | **1,053 tok (38.5%)** |

The conservative variant saves 20.7% and is realistic: keep a one-sentence
"what/when" description, keep the names of required params, move defaults,
pooling, TOFU, and edge cases to `sshya://guide`. The aggressive 38.5% bound
shows the ceiling; it would hurt discoverability of optional params.

---

## 2. Per-call response cost

All scenarios use the isolated store and fake ssh. "Compact" is a projected
response shape (echo fields removed, empty/null/zero/false fields omitted,
minified); it is computed from the measured JSON, not implemented.

| Scenario | Chars | Tokens | Minified | Compact | Compact saving | Metadata tok |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `run_command` — `uptime`, tiny stdout | 491 | **195** | 144 | 49 | 75% | 103 |
| `run_command` — 64 KiB log, **default cap** | 67,549 | **22,710** | 22,659 | 22,571 | 0.6% | 332 |
| `run_command` — same log, cap 16 KiB | 17,284 | 5,856 | 5,805 | 5,717 | 2.4% | 172 |
| `run_command` — same log, cap 8 KiB | 8,904 | 3,029 | 2,978 | 2,890 | 4.6% | 146 |
| `run_on_many` — 10 hosts, 1 failure | 5,748 | **1,897** | 1,341 | 384 | **80%** | 1,341 |
| `test_connection` — success | 128 | 52 | 33 | 5 | 90% | 33 |
| `run_command` — auth failure | 731 | 249 | 194 | 105 | 58% | 157 |
| `run_command` — host-key failure | 750 | 259 | 204 | 115 | 56% | 178 |
| `run_command` — timeout | 689 | 241 | 185 | 98 | 59% | 148 |
| `list_connections` — 5 | 4,064 | 1,356 | 1,106 | 175 | 87% | 1,356 |
| `list_connections` — 50 | 40,570 | **13,506** | 11,006 | 1,705 | **87%** | 13,506 |
| `get_connection` — 1 | 777 | 276 | 227 | 35 | 87% | 227 |
| `write_remote_file` — success | 172 | 64 | 43 | 18 | 72% | 43 |
| `run_command` — alias not found | 53 | **19** | 13 | 13 | — | 13 |

Across all scenarios: 49,709 tok today → 45,938 minified (7.6%) → 33,880 compact
(31.8%). The aggregate is dominated by the unavoidable 64 KiB log body. If the
three log-payload scenarios are excluded, metadata goes from **18,114 tok to
2,702 tok (−85.1%)**.

### Where the bytes go

`run_command` (small success, 195 tok): 103 tok are metadata, 45 are the actual
stdout. The biggest fields are `remoteCommand` (11), `target` (11), `cwd` (7),
and then eleven booleans/counters of 5–7 tok each. `stderr: ""`, `signal: null`,
`stdoutTruncated: false`, `stderrTruncated: false`, `timedOut: false`,
`durationMs`, and the echoed `command` are noise on every success.

`list_connections` (50): **65.6% of the tokens (8,862 / 13,506) are three
ready-to-run command representations** that an MCP agent does not need:

| Field | Chars | Tokens | Char share | Token share |
| --- | ---: | ---: | ---: | ---: |
| `sshArgs` (array of ~20 argv strings) | 7,959 | 3,053 | 19.2% | 22.6% |
| `sshCommand` | 6,962 | 2,554 | 16.8% | 18.9% |
| `interactiveSshCommand` | 8,773 | 3,255 | 21.2% | 24.1% |
| `id` + `lastUsed` | 558 | 239 | 1.4% | 1.8% |
| actual connection fields (`alias`, `user`, `host`, `port`, `key_path`, `remote_path`) | 3,948 | 1,569 | 9.7% | 11.6% |

The remaining ~21% of tokens are JSON keys and punctuation. The three command
representations alone are **8,862 tokens (65.6%)** of the 50-connection response.
That is 270 tok/connection today vs 34 tok/connection in the compact projection.

`run_on_many` (10 hosts, 1 failure, 1,897 tok): per-host metadata repeats
`remoteCommand`, `target`, `command`, `cwd`, four counters, five booleans and
`signal: null`. `stdout` is only 820 chars (13.9% of the response). Per host:
190 tok all-in vs 38 in the compact projection. The top-level `summary` is also
derivable from `results` (it costs ~15 tok, small but redundant).

### Minification alone

`ok()` pretty-prints with `JSON.stringify(data, null, 2)`
(`src/mcp/server.ts:27-30`). Switching to minified JSON is zero-risk for
machine clients and saves:

| Scenario | Pretty | Minified | Saving |
| --- | ---: | ---: | ---: |
| `run_command` tiny | 195 | 144 | 26% |
| `run_on_many` 10 | 1,897 | 1,341 | 29% |
| `list_connections` 5 | 1,356 | 1,106 | 18% |
| `list_connections` 50 | 13,506 | 11,006 | 19% |
| auth failure | 249 | 194 | 22% |
| `write_remote_file` | 64 | 43 | 33% |
| 64 KiB log | 22,710 | 22,659 | 0.2% |

### Head+tail truncation

The default cap is 64 KiB per stream (`src/helpers/capture.ts:19`), and the
default mode keeps the **head**. For a log, that is the least useful end and the
most expensive one: **22,710 tokens in one call**, more than eight times the
entire fixed tool context.

Projection for the same 64 KiB log with first N/2 + last N/2 bytes:

| Cap | Tokens | Saving vs 64 KiB head |
| --- | ---: | ---: |
| 4 KiB (2 + 2) | 1,414 | 94% |
| **8 KiB (4 + 4)** | **2,812** | **88%** |
| 16 KiB (8 + 8) | 5,601 | 75% |

An 8 KiB head+tail default bounds one call to ~3k tokens instead of ~23k, while
still showing the beginning (startup errors, headers) and the end (latest
failures). The current `mode: 'head' | 'tail'` cannot express this.

### Is the JSON sent twice? No.

The raw JSON-RPC result for `run_command` is:

```
resultKeys: ["content"], contentParts: 1,
hasStructuredContent: false, contentChars: 5899, structuredChars: 0
```

There is **no** `outputSchema`/`structuredContent` on this server, so the
`content[0].text` copy is the only copy. If `outputSchema` is added later, the
MCP spec recommends returning both `structuredContent` and a serialized text
fallback; that would double the payload (~5.9k chars / 1.9k tok for the 10-host
call). Do not add `outputSchema` without dropping or truncating the text copy.

---

## 3. Latency

**No local sshd is running on 127.0.0.1:22, so real SSH handshake and
ControlMaster reuse latency were not measured.** The table isolates sshya's
local overhead on top of the fake ssh, which is the part sshya controls.

| Step | Median | p95 | What it includes |
| --- | ---: | ---: | --- |
| Process floor: spawn fake ssh directly | 1.70 ms | 2.05 | OS spawn + `/bin/sh` |
| `executeSshCommand` (cold, small stdout) | 2.08 ms | 3.30 | argv, capture, classify |
| MCP `run_command` (10 connections, cold) | 2.12 ms | 2.44 | + DB usage rewrite, pretty JSON, protocol |
| MCP `run_command` (warm pool flag) | 2.10 ms | 2.58 | `reused:true` bookkeeping only |
| MCP `run_command` (50 connections, cold) | 2.19 ms | 4.57 | store rewrite grows with fleet |
| MCP `list_connections` (5) | 0.09 ms | 0.14 | DB read + serialize |
| MCP `list_connections` (50) | 0.38 ms | 0.43 | 40 KB serialization |
| MCP `run_on_many` (10, concurrency 4) | 8.83 ms | 18.40 | ten processes |
| MCP `run_command` (64 KiB stdout) | 1.92 ms | 2.35 | capture + serialize 22k-token response |

Run-to-run variance is large relative to these numbers (an earlier run measured
a 1.36 ms spawn floor, 1.26 ms direct, and 6.70 ms fan-out). Treat single-call
medians as ~1–2 ms and fan-out as ~7–9 ms. sshya's own overhead is
sub-millisecond: 0.04–0.38 ms for the MCP/direct layers over process spawn,
which dominates. On a real WAN the handshake (~150 ms locally per the README,
more over WAN) and the pooled RTT will dominate by two orders of magnitude. Two
local notes:

- `recordConnectionUsage()` rewrites the whole JSON store on every `run_command`
  (`src/database.ts:274-281`); at 50 connections the median moves
  2.12 → 2.19 ms and p95 2.44 → 4.57 ms. Not a context problem, but avoidable:
  update in place or store usage as a separate append-only file.
- `run_on_many` with 10 hosts is 7–9 ms, so fan-out is cheap. Context, not
  latency, is the reason to prefer it over ten calls.

---

## 4. Agent ergonomics: realistic tasks

Each task was executed over MCP against fixtures. "Ideal" is the best shape
reachable with the measured data (compact responses, matched/failures-only
filters, a read/edit tool), not a product claim.

| Task | Calls | Response tok | Output tok | Total | Ideal calls | Ideal tok | Saving |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Check disk on 5 hosts (discover + fan out) | 2 | 2,315 | 0 | 2,315 | 2 | 296 | 87% |
| Tail a log (last 50 lines; 20 is enough) | 1 | 5,476 | 0 | 5,476 | 1 | 2,296 | 58% |
| Edit one line in a 20 KiB config | 3 | 6,785 | 5,537 | **12,322** | 2 | 650 | **95%** |
| Restart a service and verify | 1 | 173 | 0 | 173 | 1 | 173 | 0% |
| Find which of 10 hosts has an error | 1 | 1,814 | 0 | 1,814 | 1 | 20 | 99% |
| Read lines 200–240 of a log | 1 | 4,525 | 0 | 4,525 | 1 | 4,525 | 0% |
| Recover from a typo in an alias | 2 | 2,730 | 0 | 2,730 | 1 | 60 | 98% |
| Fleet check (50 hosts, one word each) | 1 | 8,294 | 0 | 8,294 | 1 | 16 | **99.8%** |
| **Total** | **12** | **32,112** | **5,537** | **37,649** | **10** | **8,036** | **79%** |

The savings are concentrated, not uniform: `restart` and `read range` are
already efficient, `tail` depends on the agent remembering `| tail -n`, and
`edit` is expensive because there is no range read or in-place edit tool.

### Task-level friction

- **Check disk on 5 hosts.** `run_on_many` already collapses 5 calls into 1.
  But discovery (`list_connections`, 1,356 tok for 5) is 59% of the task, and
  each host repeats ~19 fields. Compact list + compact results: 2,315 → 296 tok.
- **Tail a log.** `tail -n 50` works and costs 5,476 tok because the lines are
  long (~110 tok/line); 20 lines costs 2,296. Forgetting `tail` costs the full
  64 KiB default: **22,710 tok**. `tail: true` only changes which end survives
  truncation; it does not add `tail -n`, which is easy to misread.
- **Edit a 20 KiB config.** There is no `read_remote_file` with offset/limit and
  no edit tool. The agent must `cat -n` the whole file (5,537 tok), emit the
  whole file as output (5,537 tok), `write_remote_file` it, then verify. That is
  ~12.3k tok and a risky non-atomic full rewrite. A range read + a
  `replace_in_remote_file` would be ~650 tok.
- **Restart and verify.** One compound command works: 173 tok. With `sudo` the
  fake error `sudo: a terminal is required...` is classified as **`unknown`**,
  and the hint says "add `--timeout`/`--no-cwd` or run `sshya doctor --probe`" —
  CLI flags an MCP-only agent cannot use, and no mention of `tty: true`. Retrying
  with `tty: true` can block on a password for the full 120 s default timeout.
- **Find the error host.** The answer is one alias, but 10 results cost 1,814 tok
  (153 compact) and 50 results cost 8,294 tok. The response has no
  `onlyFailures`/matched filter, so the model reads every host's full result to
  find one non-zero line.
- **Read a line range.** `sed -n '200,240p'` works in one call (4,525 tok for 41
  long lines), so this is not a capability gap. It is a discoverability and
  binary-safety gap: the agent must know `sed`, quote it correctly, and stdout is
  decoded as UTF-8.
- **Typo recovery.** `Alias not found: webb01` is 19 tok and contains no hint,
  no `errorKind`, and no candidates. The agent then lists the store: 2,710 tok
  for 10 connections, 13,506 tok for 50. A hint with three closest aliases would
  recover in one call for ~60 tok.

### Parameter friction (from the measured schemas)

| Friction | Evidence | Suggested fix |
| --- | --- | --- |
| `cwd` is a boolean but reads like a path | Schema: "cd into the connection remotePath first (default true)"; the result also has `cwd: "/srv/app"` | Rename `useRemotePath`, or accept a string path and drop the boolean |
| `tail` does not tail | Schema: "When truncated, keep the end instead of the start of the stream"; it never adds `tail -n` | Rename `truncate: "head" \| "tail" \| "head+tail"`; add a `tailLines` helper |
| `path` vs `remotePath` | `write_remote_file.path`, `add_connection.remotePath`, store field `remote_path` | Use `remotePath` everywhere (or `path` everywhere) |
| `maxOutputBytes` means different things | Schema says 65536; `stderr` is silently capped at 16 KiB (`run.ts:62`) | Document both caps or apply the same cap |
| `timeoutMs` vs `--timeout` | MCP is milliseconds; the CLI flag is seconds | Keep both names explicit (`timeoutMs`, `--timeout-seconds`) |
| `run_on_many` lacks `tty`, `stdin`, `reuse` | Compared to `run_command` schema | Add them; today a fleet sudo/pipe requires one `run_command` per host |
| `copy_file` needs `direction` | `source`/`destination` do not say which side is local | Infer from `direction`-specific names (`localPath`/`remotePath`) or document with examples |
| `keyPath` vs `key_path` | MCP camelCase, JSON store/CLI snake_case | Normalize at the MCP boundary; agents see the JSON store via `sshya://connections` |

### Reliability: `write_remote_file` can kill the MCP server

`executeSshCommand` writes stdin with `child.stdin?.end(options.stdin)` and never
attaches an `error` listener (`src/connection/run.ts:152`). If ssh exits
before consuming the payload, the write raises EPIPE, which is an unhandled
error and terminates the process. Reproduced in a child process with a 256 KiB
payload and an ssh that exits immediately:

| Case | stdin drained by ssh | Tool returned | Process exit | EPIPE |
| --- | --- | --- | ---: | --- |
| `write_remote_file` 256 KiB | no | yes | **1** | yes |
| `run_command` with `stdin` 256 KiB | no | yes | **1** | yes |
| `write_remote_file` 256 KiB | yes (control) | yes | 0 | no |
| `run_command` with `stdin` 256 KiB | yes (control) | yes | 0 | no |

In a long-lived MCP server this means the tool result is delivered and then the
server dies; subsequent calls fail. Real triggers: authentication failure midway
through an upload, a remote command such as `head -1` that does not consume all
stdin, or a wrapper that exits early. This is the only finding that causes total
loss of the session, hence recommendation #1.

---

## 5. Recommendations (prioritized)

Each item: change, location, expected effect. Token numbers are measured where
possible; projections are labeled.

### 1. Handle EPIPE on child stdin (critical)

**What:** attach `child.stdin?.on('error', ...)` that ignores `EPIPE` and
`ERR_STREAM_DESTROYED` (and still resolves the existing result), or skip
`.end()` when the stdin stream is already destroyed. Add a regression test with
a fake ssh that exits without reading and a 256 KiB payload.
**Where:** `src/connection/run.ts:152`; test in
`src/connection/run.test.ts`.
**Expected:** prevents a server crash after a `write_remote_file`/`stdin` call
(measured exit 1, EPIPE). No token change; protects every other improvement.

### 2. Add a compact, minified response mode (default for MCP)

**What:** return only fields the agent acts on:

```
success: {ok, alias, exit:0, stdout?, truncated?, reused?}
failure: {ok:false, alias, exit, stderr?, errorKind?, hint?}
```

Omit echoed input (`command`, `remoteCommand`, `target`), `cwd` (unless
non-default), `signal`, `durationMs`, empty `stdout`/`stderr`, zero byte/line
counts, and all `false` truncation flags. Keep `alias` (cheap, needed when calls
are interleaved). Make `verbose: true` restore today's shape. Also switch
`ok()` from `JSON.stringify(data, null, 2)` to minified JSON, or add
`responseFormat: "compact" | "verbose"`.
**Where:** `src/mcp/server.ts:27-30` (`ok`), `src/connection/run.ts:197-218`
(result object), `src/connection/test.ts:45-56`, `src/mcp/server.ts:411-425`
(`write_remote_file`).
**Expected:** `run_command` 195 → ~49–55 tok (72–75%); `run_on_many` 10 hosts
1,897 → 384 (80%); `list_connections` 5 1,356 → 175 (87%); 50 13,506 → 1,705
(87%); metadata-only total −85%. Minification alone is 18–33% on
metadata-heavy responses. Risk: dropping the echoed command/target makes manual
debugging slightly harder, so keep a `verbose` escape hatch for humans.

### 3. Lower the default cap to 8 KiB and truncate head+tail

**What:** `DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024` for MCP (keep 64 KiB for the
CLI if desired), add `CaptureMode = 'head' | 'tail' | 'head+tail'` with two
buffers and a marker like `first 4 KiB + last 4 KiB of 64 KiB`. Default MCP mode
to `head+tail`; if the command matches `/tail|journalctl|docker logs|kubectl logs/`,
use `tail`. Rename the `tail` param to `truncate: "head"|"tail"|"head+tail"` or
document that it only chooses which end survives.
**Where:** `src/helpers/capture.ts:10,19,108-161,184-188`;
`src/connection/run.ts:62,77-78,99-102`; `src/mcp/server.ts:234-235`;
README lines 29-32 and AGENTS line 35.
**Expected:** worst-case one log call 22,710 → 2,812 tok (88% saving) at 8 KiB
head+tail; 16 KiB is 5,601 (75%). Without this, one forgotten `tail` consumes
more context than eight copies of the entire tool list.
**Also:** stderr is hard-capped at 16 KiB (`run.ts:62`) while the README says
64 KiB per stream; document the real cap or align it.

### 4. Make `list_connections` lean

**What:** omit `sshArgs`, `sshCommand`, and `interactiveSshCommand` from the list
response. Keep `alias`, `user`, `host`, `port`, `keyPath`, `remotePath`; drop
`id` and `lastUsed` (or make `lastUsed` an ISO string only in `verbose`). Add
`includeSsh: true` for `get_connection`/`print_ssh_command`. Apply the same
serializer to the `sshya://connections` resource, which currently duplicates the
full payload.
**Where:** `src/mcp/server.ts:34-42` (`serializeConnection`), `:45-54`,
`:566-581` (resource).
**Expected:** 50 connections 13,506 → ~1,705 tok (−87%); 5 connections
1,356 → 175. The three command fields alone are 8,862 tok (65.6%) of the
50-connection response. Discovery drops from 59% of the 5-host disk task to ~9%.

### 5. Give `run_on_many` a failures/matched-only mode and param parity

**What:** add `output: "all" | "failures" | "summary"` (or `onlyFailures`),
optionally `fields`/`match` for "which hosts have a non-zero count". Add `tty`,
`stdin`, and `reuse` so fleet operations can sudo or pipe data like
`run_command`. Return `{alias, errorKind, error}` for missing aliases instead of
a bare string.
**Where:** `src/mcp/server.ts:264-350` (handler and schema).
**Expected:** fleet check 50 hosts 8,294 → 16 tok failures-only (99.8%); 10-host
error hunt 1,814 → 20 tok matched-only (99%); compact all results 713 tok (91%).
Also removes the only reason to loop `run_command` over a fleet.

### 6. Make errors actionable in MCP terms

**What:** return `{ok:false, errorKind:"alias-not-found", error, hint,
candidates:[...3 closest aliases]}` from every `Alias not found` path. Extend
`failResult` to take a structured object. Replace CLI-only hints (`--timeout`,
`--no-cwd`, `sshya show <alias>`, `sshya doctor --probe`) with MCP parameter
names or include both forms. Add a rule for
`/sudo: a terminal is required|no tty present|must have a tty/i` → kind `tty`,
hint "Retry with `tty: true`; passwordless sudo is preferred for agents."
**Where:** `src/mcp/server.ts:32` and every `failResult` call
(`:67, 98, 113, 136, 150, 166, 182, 205, 244, 377, 384, 448, 479`, plus the
inline missing-alias result at `:299`); `src/helpers/errors.ts` rules at
`:43-133` (auth `:82`, timeout `:143`, unknown `:176`).
**Expected:** typo recovery 2,730 → ~60 tok (98%); one fewer round trip and no
2.7k/13.5k-token store dump. The sudo case avoids a 120 s timeout and a wasted
retry; the hint becomes actionable instead of pointing at a CLI.

### 7. Diet the fixed context: shorter descriptions, detail in the guide

**What:** keep one-sentence tool descriptions ("what/when"), keep full
descriptions only for required params, and move defaults/pooling/TOFU/edge cases
to `sshya://guide` (already read on demand). Consider folding
`print_ssh_command` into `get_connection` (`includeCommand: true`), removing one
tool and 137 tok.
**Where:** `src/mcp/server.ts:45-564` (descriptions + `.describe`),
`:634-643` (instructions), `:583-624` (guide).
**Expected:** `tools/list` 2,592 → 2,025 tok (−22%) with the conservative
variant, or 1,539 (−41%) if optional param prose is dropped; always-on
2,738 → 1,685. The guide costs 454 tok and is only paid when read. This is a
one-time saving per session, unlike #2/#3 which pay on every call.

### 8. Add `read_remote_file` (offset/limit) and an in-place edit tool

**What:** `read_remote_file {alias, path, offset?, limit?, maxBytes?, encoding?}`
returning numbered lines (base64 for binary), and
`replace_in_remote_file {alias, path, old, new, count?}` implemented atomically
(temp file + `mv`, then optional `chmod`). Optionally a structured `stat_remote`
(`size`, `mode`, `owner`, `mtime`), `list_remote_dir`, and
`grep_remote {alias, path, pattern, context?, maxMatches?}` returning only
matching lines with line numbers. `run_command` can do these, but structured
output avoids brittle parsing and shell quoting.
**Where:** new tools in `src/mcp/server.ts` (reuse `executeSshCommand`);
guide section "Files".
**Expected:** editing a 20 KiB config 12,322 → ~650 tok (95%) and 3 → 2 calls;
reading lines 200–240 becomes a discoverable, binary-safe call. A
`grep_remote` avoids `cat | grep` pipelines and returns line numbers; a
`stat`/`ls` tool removes "parse `ls -l` output" failures.

### Worth doing after the top 8

- **Merge `print_ssh_command`** into `get_connection` (−137 tok, one less tool).
- **Drop SDK boilerplate** `$schema` and `execution` if a custom `tools/list`
  handler is acceptable: 216 tok (8% of `tools/list`).
- **Memoize/avoid the full-store rewrite** in `recordConnectionUsage`
  (`src/database.ts:274-281`): 50-connection p95 goes 2.44 → 4.57 ms.
- **Document the real stderr cap** (16 KiB, `run.ts:62`) or raise it to match
  the advertised 64 KiB.
- **Give `run_command` a `stdout`-only success shape** as part of #2; do not
  drop `stderr` on failure (it is the primary diagnostic).

### What not to do

- Do not add `outputSchema`/`structuredContent` while keeping the current
  text copy. Measured today: one copy, 5,748 chars / 1,897 tok for the 10-host
  call. The MCP fallback convention would make it two copies (~2× tokens).
- Do not remove the `hint` field to save ~50 tok; it prevents far more expensive
  retries. Compact the metadata around it instead.
- Do not lower the cap to 1–2 KiB: legitimate command output (a stack trace, a
  config header) would be cut before the agent can act. 8 KiB head+tail is the
  measured sweet spot; 16 KiB if quality matters more than context.

---

## 6. After round 2 (compaction)

Measured on the same machine, tokenizer, and harness after implementing
recommendations 2, 4, 5, 6, and 7: compact/minified MCP responses, lean
`list_connections`/`sshya://connections`, `run_on_many` filters and param
parity, actionable alias/sudo errors, and dieted tool descriptions with details
moved to `sshya://guide`. Re-run `bench/run-all.sh`; the tables below come from
`results/fixed-cost.json`, `results/call-cost.json`, and
`results/ergonomics.json`. No remote host was contacted.

### Fixed context

| Component | Before chars | Before tok | After chars | After tok | Change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `initialize.instructions` | 727 | **146** | 253 | **53** | −63.7% |
| `tools/list` (12 definitions) | 11,566 | **2,592** | 6,648 | **1,595** | **−38.5%** |
| Always-on total (instructions + tools) | 12,293 | **2,738** | 6,901 | **1,648** | **−39.8%** |
| `resources/list` (names only) | 344 | 76 | 400 | 86 | +13.2% |
| `sshya://guide` (on demand) | 1,734 | 454 | 3,568 | 881 | +94.1% |
| Instructions + tools + guide | 14,027 | **3,192** | 10,469 | **2,529** | **−20.8%** |

`tools/list` is now 1,595 tok, under the 1,800 target. The guide grew by 427 tok
because TOFU, pooling, statelessness, compact-response rules, and truncation
advice moved out of the always-on schemas; the always-on saving (1,090 tok)
pays for it more than twice, and the guide is only read on demand.

Biggest per-tool reductions: `run_command` 464 → 202 tok, `write_remote_file`
385 → 173, `run_on_many` 345 → 285 (it gained six params: `tty`, `stdin`, `reuse`,
`only`, `match`, and `verbose` — see below), `copy_file` 249 → 163,
`test_connection` 209 → 106. Titles were dropped (50 tok) and parameter prose
went from 423 → 42 tok.

### Per-call responses

Compact/minified values are now the real response, not a projection.

| Scenario | Before tok | After tok | Saving |
| --- | ---: | ---: | ---: |
| `run_command` — `uptime`, tiny stdout | 195 | **59** | 69.7% |
| `run_command` — 64 KiB log, **default cap** | 22,710 | 22,577 | 0.6% |
| `run_command` — same log, cap 16 KiB | 5,856 | 5,723 | 2.3% |
| `run_command` — same log, cap 8 KiB | 3,029 | 2,896 | 4.4% |
| `run_on_many` — 10 hosts, 1 failure | 1,897 | **440** | **76.8%** |
| `test_connection` — success | 52 | **15** | 71.2% |
| `run_command` — auth failure | 249 | 120 | 51.8% |
| `run_command` — host-key failure | 259 | 120 | 53.7% |
| `run_command` — timeout | 241 | 133 | 44.8% |
| `list_connections` — 5 | 1,356 | **183** | **86.5%** |
| `list_connections` — 50 | 13,506 | **1,803** | **86.7%** |
| `get_connection` — 1 | 276 | 227 | 17.8% |
| `write_remote_file` — success | 64 | **23** | 64.1% |
| `run_command` — alias not found | 19 | 20 | −5.3% |

Across all scenarios: 49,709 → **34,339 tok** (−30.9%). The aggregate is still
dominated by the unavoidable 64 KiB log body. Excluding the three log-payload
scenarios, metadata goes from **18,114 → 3,143 tok (−82.6%)**, against the
report's 2,702-tok compact projection. The remaining gap is deliberate:
`alias` and `exitCode` are always kept, `get_connection` stays detailed (227
tok), and the compact `list_connections` row is 36 tok/connection versus 34 in
the projection.

`get_connection` is the only response that did not shrink materially: it is the
escape hatch that still returns `sshArgs`, `sshCommand`, and
`interactiveSshCommand`. `print_ssh_command` covers the same need in 79 tok of
tool context instead of 227 tok per lookup.

The alias-not-found response is flat in tokens (19 → 20) but now carries
`errorKind: "alias_not_found"` and up to three fuzzy `suggestions`, which
removes the follow-up `list_connections` call: typo recovery went from 2,730 tok
across two calls to **397 tok** in the ergonomics run (−85.5%), and one call
fewer. No suggestion is ever executed automatically.

### `run_on_many` filters (measured, same harness)

| Query | All results | `only: "failures"` | `match` |
| --- | ---: | ---: | ---: |
| 10 hosts, one `7` among `0`s | 214 tok | 23 tok (none failed) | **42 tok** (`match: "[1-9]"`, one host, 126 chars) |
| 50 hosts, all `active` | 974 tok | **23 tok** | — |

The summary `{total, succeeded, failed}` is always present, so filtered calls
stay self-describing. Before this change the 10-host error hunt cost 1,814 tok;
the matched reply is 42 tok (−97.7%), and the 50-host fleet check drops from
8,294 tok to 23 tok (−99.7%) when nothing failed.

### Agent tasks after round 2

| Task | Before total tok | After total tok | Saving |
| --- | ---: | ---: | ---: |
| Check disk on 5 hosts (discover + fan out) | 2,315 | 407 | 82.4% |
| Tail a log (last 50 lines) | 5,476 | 5,318 | 2.9% |
| Edit one line in a 20 KiB config | 12,322 | 11,990 | 2.7% |
| Restart a service and verify | 173 | 20 | 88.4% |
| Find which of 10 hosts has an error | 1,814 | 214 | 88.2% |
| Read lines 200–240 of a log | 4,525 | 4,363 | 3.6% |
| Recover from a typo in an alias | 2,730 | 397 | 85.5% |
| Fleet check (50 hosts, one word each) | 8,294 | 974 | 88.3% |
| **Total** | **37,649** | **23,683** | **37.1%** |

The remaining large tasks are payload-bound (tail, range read) or capability
gaps (no `read_remote_file`/edit tool), which round 2 did not target. Sudo
failures now classify as `tty` with a `tty: true`/`sudo -n` hint instead of
`unknown` with a CLI-only hint.

### Latency

No regression; the smaller payloads mostly remove serialization work. Medians
from the same run: `list_connections` (50) 0.38 → **0.12 ms** (p95 0.43 →
0.14), `run_command` (10 connections, cold) 2.12 → 2.07 ms, `run_command`
(64 KiB stdout) 1.92 → 1.98 ms, `run_on_many` (10 hosts) 8.83 → 8.43 ms.
Everything is still bounded by process spawn (~1.9 ms floor), and run-to-run
variance is larger than these deltas.

The rerun also confirms the round-1 EPIPE fix: all four
`results/stdin-epipe.json` cases now exit 0 with no EPIPE, including a
non-draining fake ssh and a 256 KiB payload.

### What this round did not change

- The default output cap and head-only truncation are still in place, so one
  forgotten `| tail -n` still costs ~22.6k tok. That is the largest single
  remaining lever (recommendation 3).
- Text content remains the only copy: `resultKeys: ["content"]`,
  `hasStructuredContent: false`. No `outputSchema` was added, so no payload is
  duplicated.
- `run_on_many` still executes on every requested host; `match` and
  `only: "failures"` filter the reply, they do not skip work.

---

## 7. Final (all rounds merged)

Measured on 2026-11-19, same machine, tokenizer, harness, and isolated store as
§1–§6, on the tree that merges every round: compact/minified responses, lean
`list_connections`, `run_on_many` filters and param parity, actionable errors,
8 KiB head+tail truncation, and the five structured file tools
(`read_remote_file`, `replace_in_remote_file`, `grep_remote`, `stat_remote`,
and `write_remote_file atomic: true`). **Before** is the original 0.6.0
measurement from §1/§2/§4 — not a projection. **Final** is
`bench/results/*.json` from `./run-all.sh` on this tree.

The file-tool rows run the fake ssh with `FAKE_SSH_EXEC=1`: the last argv (the
remote command) is executed locally through `sh -c`, so `sed`/`awk`/`grep`/
`stat`/`cksum` see real files under the bench temp dir. That measures payload
size, which is what this report is about, not transport. Correctness of the
same tools against a real local sshd (real login shell, real atomic rename,
conflict detection, readonly policy) is covered by `SSHYA_E2E=1 ./e2e/run.sh`.
No remote host was contacted; `~/.sshya` and `~/.ssh` were not read or written.

### Fixed context

| Component | Before chars | Before tok | Final chars | Final tok | Change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `initialize.instructions` | 727 | **146** | 253 | **53** | −63.7% |
| `tools/list` (12 → 16 definitions) | 11,566 | **2,592** | 10,262 | **2,463** | −5.0% |
| Always-on total (instructions + tools) | 12,293 | **2,738** | 10,515 | **2,516** | **−8.1%** |
| `resources/list` (names only) | 344 | 76 | 400 | 86 | +13.2% |
| `sshya://guide` (on demand) | 1,734 | 454 | 4,443 | **1,121** | +147% |
| Instructions + tools + guide | 14,027 | **3,192** | 14,958 | **3,637** | +13.9% |

The four new tools cost 790 tok (`read_remote_file` 221, `replace_in_remote_file`
218, `grep_remote` 211, `stat_remote` 140). The list is still 129 tok below the
original 12-tool list because the description diet on the older tools saved more
than the new schemas add. The always-on total is 222 tok lower than 0.6.0 with
four more capabilities.

The on-demand guide is the one number that grew: file-tool semantics, the
readonly rule, and the compact-response contract moved there, so an agent that
reads it pays 667 tok more than in 0.6.0. It is not always-on; the break-even is
one avoided retry.

### Per-call responses

| Scenario | Before tok | Final tok | Saving |
| --- | ---: | ---: | ---: |
| `run_command` — `uptime`, tiny stdout | 195 | **59** | 69.7% |
| `run_command` — 64 KiB log, **shipped default** (8 KiB head+tail) | 22,710 | **2,818** | **87.6%** |
| `run_command` — same log, `maxOutputBytes: 65536`, head-only (old shape) | 22,710 | 22,583 | 0.6% |
| `run_command` — same log, 64 KiB head+tail (raised cap) | — | 22,425 | — |
| `run_command` — same log, 16 KiB head+tail | 5,856 | 5,574 | 4.8% |
| `test_connection` — success | 52 | **15** | 71.2% |
| `run_command` — auth failure | 249 | 99 | 60.2% |
| `run_command` — host-key failure | 259 | 99 | 61.8% |
| `run_command` — timeout | 241 | 112 | 53.5% |
| `run_command` — alias not found | 19 | 20 | −5.3% |
| `list_connections` — 5 | 1,356 | **183** | 86.5% |
| `list_connections` — 50 | 13,506 | **1,803** | 86.7% |
| `get_connection` — 1 | 276 | 227 | 17.8% |
| `write_remote_file` — success (whole-file) | 64 | **23** | 64.1% |
| `write_remote_file` — `atomic: true` | — | 24 | — |
| `read_remote_file` — 40 lines of a 20 KiB config | — | 492 | — |
| `grep_remote` — 1 match in 40 config files | — | 27 | — |
| `stat_remote` — 3 paths | — | 73 | — |
| `replace_in_remote_file` — one line (with diff) | — | 89 | — |

The 64 KiB log is now bounded by the 8 KiB head+tail default: **2,818 tok
instead of 22,710** for the same call, and the two ends (startup errors and the
latest failures) are both present. Raising `maxOutputBytes` restores the old
cost: the cap, not the mode, dominates once it is raised.

`list_connections` is 36 tok/connection. The four surviving fields are
`alias` (7.3% of the 50-host response), `target` (18.0%), `keyPath` (27.8%),
and `remotePath` (10.0%); the rest is JSON keys and punctuation. `sshArgs`,
`sshCommand`, and `interactiveSshCommand` are only in `get_connection` (227 tok)
and `print_ssh_command` (79 tok of tool context).

The file tools are a new capability, so most rows have no 0.6.0 counterpart: the
`sed -n`/`cat`/`grep`/`ls -l` equivalents were either in the 4,525-tok range read
or in the 12,322-tok edit task below. `read_remote_file` output is payload-bound
(492 tok for 40 real config lines); the gain is the schema, `totalLines`,
numbered lines, binary refusal, and no shell quoting.

### Fleet filters

| Query | Before (all results) | Final all | Final `only: "failures"` | Final `match` |
| --- | ---: | ---: | ---: | ---: |
| 10 hosts, one error among zeros | 1,814 | 214 | 23 | **42** (`match: "[1-9]"`) |
| 50 hosts, all `active` | 8,294 | 974 | **23** | — |

Filters shape the reply; every requested host is still executed (and still
counted in `summary`). The 10-host error hunt is 42 tok, a 97.7% saving; the
50-host fleet check with nothing to report is 23 tok, a 99.7% saving.

### Agent tasks

Same eight tasks as §4, re-run with the shipped tools. "Before" is §4
(0.6.0); the edit and range-read tasks now use the structured file tools.

| Task | Calls (before → final) | Before tok | Final tok | Saving |
| --- | --- | ---: | ---: | ---: |
| Check disk on 5 hosts (discover + fan out) | 2 → 2 | 2,315 | 407 | 82.4% |
| Tail a log (last 50 lines) | 1 → 1 | 5,476 | 2,818 | 48.5% |
| **Edit one line in a 20 KiB config** | **3 → 3** | **12,322** | **297** | **97.6%** |
| Restart a service and verify | 1 → 1 | 173 | 20 | 88.4% |
| Find which of 10 hosts has an error | 1 → 1 | 1,814 | 42 | 97.7% |
| Read lines 200–240 of a log | 1 → 1 | 4,525 | 4,502 | 0.5% |
| Recover from a typo in an alias | 2 → 2 | 2,730 | 63 | 97.7% |
| Fleet check (50 hosts, one line each) | 1 → 1 | 8,294 | 23 | 99.7% |
| **Total** | **12 → 12** | **37,649** | **8,172** | **78.3%** |

Task notes:

- **Edit one line (297 tok).** `read_remote_file(offset 1, limit 10)` finds the
  line (166 tok), `replace_in_remote_file` applies an exact-string edit with
  `expectedCount` and returns an 89-tok diff, and `grep_remote` verifies
  (29 tok). The model emits 13 tok (`oldText` + `newText`) instead of
  re-emitting the 5,537-tok file, and the write is atomic with mode/owner
  preserved. Same call count as 0.6.0, 97.6% fewer tokens.
- **Read range (4,502 tok).** `read_remote_file(offset: 200, limit: 41)` is
  within 0.5% of the `sed -n` version because the response is payload-bound
  (41 long log lines). The improvement is discoverability and safety, not cost.
- **Tail (2,818 tok).** 50 log lines are 15.4 KB, so the 8 KiB default now
  returns head+tail; 20 lines fit (2,138 tok). Forgetting `| tail -n` costs the
  same 2,818 tok instead of the old 22,577-tok worst case.
- **Fleet (23 tok).** `only: "failures"` with nothing failed returns the
  summary and no rows; the answer is still `{total: 50, succeeded: 50, failed: 0}`.
- **Typo (63 tok).** The 34-tok error carries `errorKind`, a hint, and three
  suggestions; the retry is 29 tok. 0.6.0 needed a 2,710-tok `list_connections`
  to recover.

### Latency

Same local-overhead picture as §3/§6; no regression from the extra tools. This
run's medians: process floor 1.77 ms, `executeSshCommand` direct 1.73 ms, MCP
`run_command` cold 2.12 ms, warm-pool flag 2.12 ms, `list_connections` (50)
0.11 ms, `run_on_many` 10 hosts 9.32 ms, and the 64 KiB log at the 8 KiB
head+tail default 1.92 ms. The spawn floor and the direct call overlap within
run-to-run noise; the MCP layer adds ~0.4 ms. Everything is bounded by process
spawn, and **real SSH handshake and pooled RTT are still not measured here**;
`reused: true` is bookkeeping only.

The `stdin-epipe.json` rerun is still clean: all four 256 KiB cases exit 0 with
no EPIPE, including a fake ssh that never drains stdin.

### What this round did not measure

- **A model in the loop.** All numbers are o200k_base tokens on the response
  text. They exclude system prompts, reasoning tokens, tool-choice behavior, and
  retry rates; they are not provider-billed tokens.
- **Real SSH transport.** The bench uses a local fake ssh. Handshake, pooled
  RTT, WAN latency, and per-call jitter are not measured. The e2e suite uses a
  real local sshd but asserts correctness, not cost.
- **Large-file transfer.** File-tool payloads are text under the 2 MiB edit
  limit on a local filesystem; the network cost of transferring them, and the
  2 MiB refusal boundary under a slow link, were not measured.
- **Non-Linux remotes.** The BSD `stat -f` fallbacks, BSD `grep -H`/`--include`,
  and a non-POSIX login shell were not exercised; the e2e host is Linux/zsh.
- **Concurrency.** The pool was not measured under parallel agents, and the
  bench's `run_on_many` numbers are response sizes, not wall-clock fan-out.
- **Conflict cost.** `replace_in_remote_file`'s `conflict` path is covered by
  e2e (deterministic drift), but its token cost on real files was not measured.

The two defects found while adding the file-tool e2e tests are fixed in this
tree and are reflected above: file-tool responses were pretty-printed instead of
minified, and `grep_remote` lost the file name when the search path was a single
file (GNU grep needs `-H`).

---

## 8. Caveats

- **Fake ssh, no network.** Latency is local overhead only. Pooled vs cold RTT
  was not measured; `reused:true` was simulated by pre-creating the control
  socket path, and the fake still spawned per call. The README's ~150 ms
  handshake / 5–20 ms pooled figures are the right order of magnitude but were
  not re-verified here. The e2e suite does use a real local sshd, but for
  behaviour, not for timing.
- **Token counts are o200k_base.** `cl100k_base` differs by a few percent on
  these texts; `chars/4` differs by up to 26% on logs. The report uses the real
  tokenizer.
- **Stores are synthetic.** 50 connections with key/remotePath/lastUsed are
  representative, not a specific user's store. A leaner store makes
  `list_connections` cheaper; the per-connection field shares hold regardless.
- **Compact projections are in-memory transforms.** Sections 1–5 show the cost
  of a shape, not the effort or semantic risk of implementing it. Since §6 the
  compact shape is the real response, and §7 measures it directly.
- **Ideal task numbers are best-case.** `restart` and `read range` assume the
  agent writes the right compound command the first time. In §7 the range-read
  tool removes the shell-quoting risk but not the payload cost.

---

## 9. Reproduce

```bash
cd bench
bun install
./run-all.sh
```

Outputs: `bench/results/{fixed-cost,call-cost,latency,ergonomics,stdin-epipe}.json`.
The file-tool scenarios need a POSIX `sh`, `sed`, `awk`, `grep`, `stat`, and
`cksum` on the bench host; they run against files under the bench temp dir.
