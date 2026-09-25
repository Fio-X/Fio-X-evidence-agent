# Local Codex task: observability follow-up

Task ID: `system-one-observability-followup-v2`

Expected branch: `feat/system-one-observability-codex-handoff`

## Objective

Close the two local validation issues found in the first run without changing runtime behavior.

You are allowed to modify exactly one product source file: `src/artifact.rs`, and only by running Rust formatting. Do not make semantic edits.

## Required work

1. Record the current branch and commit SHA.
2. Run `cargo fmt -- src/artifact.rs`.
3. Inspect `git diff -- src/artifact.rs` and confirm the diff is formatting-only. If the diff contains a semantic change, stop and report FAIL.
4. Run:
   - `cargo fmt --check`
   - `cargo test --locked`
   - `cargo build --release --locked`
   - `python3 scripts/test_rpc_waits.py target/release/news`
5. Run one mock investigation with `scripts/perf_mock_pi.py` and verify that:
   - `events.jsonl` contains `newsroom_rpc_metrics`
   - `run-metrics.jsonl` contains the `pi_rpc` aggregate object
6. Do not retry the real provider route in this task. Record it as BLOCKED with the previous observation `provider_error`; do not change provider or authentication code.
7. Do not commit perf outputs, temporary investigation artifacts, logs, screenshots, or credentials.

## Result

Replace `local-codex/result.md` with a concise report.

Include:
- tested branch and SHA
- environment versions
- PASS/FAIL/BLOCKED for each check
- whether `src/artifact.rs` changed only by formatter
- non-sensitive local artifact paths
- blockers
- confirmation that no secrets were copied

Do not modify any product file other than the formatting-only change to `src/artifact.rs`.
