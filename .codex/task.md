# Local Codex task: System One observability baseline

Task ID: `system-one-observability-baseline-v1`

Expected branch: `feat/system-one-observability-codex-handoff`

## Objective

Validate the first low-risk System One preparation slice. This slice must preserve current agent behavior while making existing Pi RPC timing/token signals machine-readable and establishing a reproducible local handoff.

Do not modify product source for this task. If you identify a defect, record it in `.codex/result.md`.

## Required checks

1. Record the current branch and commit SHA.
2. Record versions for `rustc`, `cargo`, `node`, `python3`, and `codex`. Record `pi --version` when available.
3. Run:
   - `cargo fmt --check`
   - `cargo test --locked`
   - `cargo build --release --locked`
   - `python3 scripts/test_rpc_waits.py target/release/news`
4. Create `perf-results/` if necessary, then run:
   - `python3 scripts/perf_measure.py target/release/news perf-results/system-one-observability.json`
5. Run one mock investigation with `scripts/perf_mock_pi.py`. Inspect the resulting investigation artifact and verify:
   - `events.jsonl` contains a `newsroom_rpc_metrics` event for a successful Pi RPC invocation.
   - the event contains `startup_ms`, `rpc_ms`, `first_model_text_ms`, `prompt_attempts`, `tool_profile`, `tool_count`, and token counters when the mock provides them.
   - `run-metrics.jsonl` contains aggregate Pi RPC fields derived from those structured events.
6. If a real Pi/provider route is already configured, run only a minimal no-tool live request needed to determine whether the provider is usable. Do not expose credentials. If login or another human action is required, ask the user and mark the check BLOCKED until they complete it. Do not expand into the flagship visual run in this task.
7. Do not commit `perf-results/`, temporary investigation outputs, provider logs, or screenshots.

## Result

Replace the contents of `.codex/result.md` with a concise report using its template. Include exact PASS/FAIL/SKIP/BLOCKED states and the paths to any local, non-sensitive evidence.

If a failure appears to require a code change, include:
- failing command
- shortest useful error excerpt
- suspected file/function
- smallest proposed fix
