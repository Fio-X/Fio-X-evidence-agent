# 16 — Run-metrics scope

## Hypothesis

`pi_rpc` fields in `run-metrics.jsonl` may aggregate the whole artifact event log rather than only the current operation, which could bias A/B comparisons across retries or continuations.

## Commands and measurements

- Read `AGENTS.md`, `local-codex/task.md`, `experiments/system-one/README.md`, and the named manifest entry.
- Recorded branch/SHA: `exp/system-one-r1-16-run-metrics-scope` / `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Inspected `src/artifact.rs`, `src/pi.rs`, and investigate/continue call sites with `rg`, `sed`, and `nl`.
- Replayed the reducer against its two-event fixture values using Python 3.14.6; checked source immutability with `git diff --exit-code -- src`.

## Observed values

`append_run_metric` calls `read_rpc_metrics(&self.events_path)` before appending each row. The reducer scans all `newsroom_rpc_metrics` events and:

- sums `calls`, `rpc_ms`, `startup_ms`, attempts, prompt bytes, and token counters;
- computes first-text min/max over all events;
- takes maximum tool count and a cumulative distinct profile list.

For the fixture’s first event (`rpc_ms=100`, `startup_ms=12`, prompt bytes `50`, input tokens `120`), the emitted aggregate is `calls=1`, `rpc_ms_total=100`, `startup_ms_total=12`.

After the second event (`rpc_ms=80`, `startup_ms=8`, prompt bytes `30`, input tokens `80`), the next aggregate is `calls=2`, `rpc_ms_total=180`, `startup_ms_total=20`, `prompt_bytes_total=80`, and `tokens_input_total=200`.

The enclosing row’s `duration_ms` is supplied from the current command’s `run_started.elapsed()`, so operation duration is local while `pi_rpc` is cumulative. Metric events are written only after a non-empty successful Pi answer; failed RPCs do not emit `newsroom_rpc_metrics` from this path.

## Limitations

This was a read-only source audit and deterministic reducer replay; no provider route or live Pi run was attempted, and the Rust test suite was not run. The replay validates reducer semantics but not wall-clock behavior. Failed-session coverage is a separate observability gap.

## Classification

PROMOTE

The scope mismatch is directly evidenced and can materially confound round-2 A/B measurements. A bounded follow-up should add operation-local deltas or an explicit cumulative baseline while preserving the existing evidence gates.
