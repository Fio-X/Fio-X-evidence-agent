# r5-01-token-observability-foundation

- Tested commit: `05a08fb0863535aa5dd506c4885d8c29bf8f9ac0` (detached HEAD; baseline contract commit).
- Environment: macOS 27.0; rustc/cargo 1.98.1; Node v24.14.1; Python 3.14.6.
- Inputs inspected only with `git show`/`git diff`: `origin/exp/system-one-r3-01-observability-foundation`, `origin/exp/system-one-r3-01b-rpc-watchdog-stability`, `origin/exp/system-one-r4-01-fixed-token-benchmark`, and `origin/exp/system-one-r4-02-tool-result-telemetry`.

## Checks

- PASS — `cargo fmt --check`.
- PASS — `cargo test --locked` (87 passed, 1 ignored).
- PASS — `cargo build --release --locked`.
- PASS — `node scripts/test_tool_result_telemetry.mjs` (UTF-8 byte count 16; returned text unchanged; artifact bytes 99; truncation false).
- PASS — `node scripts/test_run_tool_result_metrics.mjs` (numeric tool-result aggregation fixture: visible 12, artifact 42, truncated count 1).
- PASS — `python3 scripts/test_rpc_waits.py target/release/news` (14 mock modes; no watchdog timeout; provider-error persistence `secret_hits=0`).
- PASS — 20 warm mock benchmark runs via `scripts/system_one_token_benchmark.py`; median E2E 87.72 ms, p95 94.78 ms, one RPC/run, prompt bytes 5523/run. Summary: `/var/folders/gs/f0tb98zx3g78t4342yqhxxh40000gn/T/r5-01-token-observability-irst2vad/summary.json`.

## Implementation/evidence

The opt-in/measurement-only foundation now records sanitized success/failure RPC terminal metrics, cumulative and operation-local RPC totals, and per-tool numeric metadata (`tool_name`, model-visible UTF-8 bytes, optional artifact bytes, truncation, wall time, success). Returned tool text is unchanged and raw result bodies are not copied into telemetry. Existing evidence, provenance, verification, completion, publication, and browser-QA paths were not weakened; no auto-repair or background service was added.

The repeated mock benchmark exercised no tool calls, so its run-level tool-result total was correctly observed as zero. The focused deterministic fixture validates aggregation, but a full provider-free end-to-end tool-exercising harness was not available within the allowlist. Token counters were available as zero from the mock; active-context bytes were not inferred from prompt bytes.

No secrets were copied into this report.

HOLD
