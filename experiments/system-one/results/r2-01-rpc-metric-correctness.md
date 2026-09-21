# r2-01-rpc-metric-correctness

Classification: PROMOTE

Tested branch/commit: `exp/system-one-r2-01-rpc-metric-correctness` / `4965767bdbd6880f1b21ecd846ba2e3abde55044`

Environment: Darwin 27.0.0 arm64; rustc/cargo 1.98.1; Python 3.14.6; Node v24.14.1.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored)
- PASS — `cargo build --release --locked`
- PASS — `python3 scripts/test_rpc_waits.py target/release/news` (all mock modes, redaction, and initial-plus-continuation assertions)
- PASS — focused Rust tests for structured RPC aggregation and provider-error classification.
- PASS — `git diff --check`.

## Prototype and observed values

- `src/pi.rs`: successful RPC metrics now include `outcome=success`; every failed/spawn-failed RPC emits one sanitized terminal metric with bounded `failure_phase` and `failure_class`. No provider diagnostic payload is written.
- `src/artifact.rs`: existing cumulative `pi_rpc` remains; each run-metric line additionally contains `pi_rpc_operation`, computed as the delta from the previous run metric.
- `scripts/test_rpc_waits.py`: asserts terminal failure metrics/redaction and initial-plus-continuation scope.
- Mock initial/continuation: RPC events `2`; cumulative calls after each run `1, 2`; operation-local calls `1, 1`; `continue_session` values `false, true`.
- Provider-error mock: exactly one failed terminal metric, bounded class `provider_error`, secret hits `0`; cumulative and operation-local `failed_calls` both `1`.
- Comparable watchdog baseline versus variant (14 modes): mean wall time `337.15 ms` versus `343.36 ms`; normal `61.0` versus `59.1 ms`; provider-error `559.0` versus `553.7 ms`; no performance claim is made from this small mock sample.

## Limitations and artifacts

The operation-local delta depends on the prior cumulative run-metric line and does not reconstruct historical per-call first-text minima or tool-profile lists. Real-provider validation was not retried; it remains blocked by the previously observed `provider_error`, with no authentication/provider changes made. Browser-QA is not applicable to this observability-only prototype.

Non-sensitive measurement artifacts: [/private/tmp/r2-01-baseline.json](/private/tmp/r2-01-baseline.json), [/private/tmp/r2-01-variant.json](/private/tmp/r2-01-variant.json), [/private/tmp/r2-01-focused.json](/private/tmp/r2-01-focused.json).

No user action was required. No secrets, credentials, raw provider diagnostics, or cookies were copied into this report.
