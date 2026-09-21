# r2-05 sparse checkpoint prototype

Classification: HOLD

## Provenance

- Commit under test: `4965767bdbd6880f1b21ecd846ba2e3abde55044`
- Branch: `exp/system-one-r2-05-sparse-checkpoint-prototype`
- Environment: Darwin 27.0.0 arm64; rustc/cargo 1.98.1; Python 3.14.6; Node v24.14.1
- Diff scope: `src/commands/investigate.rs`, `src/prompt.rs`, and the opt-in focused harness `scripts/test_system_one_checkpoints.py`.

## Prototype

Added an opt-in `NEWSROOM_SPARSE_CHECKPOINTS=1` controller. It records exactly three `newsroom_macro_checkpoint` events around the existing investigation path: `RESEARCH`, `DESIGN`, and `PUBLISH`. Events contain scope, elapsed milliseconds, reason codes, and pass/fail. The default path emits no checkpoint events and receives no checkpoint prompt contract. Existing audit, evidence, verification, completion, and publication decisions remain unchanged and authoritative.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored)
- PASS — `cargo build --release --locked`
- PASS — `python3 scripts/test_system_one_checkpoints.py target/release/news`
- PASS — `python3 -m py_compile scripts/test_system_one_checkpoints.py`
- PASS — `node scripts/test_evidence_gate.mjs`
- PASS — `python3 scripts/test_rpc_waits.py target/release/news`
- PASS — `git diff --check`

## Mock A/B measurement

Three baseline and three variant runs used `scripts/perf_mock_pi.py`; reported values are medians.

| Metric | Baseline | Variant |
|---|---:|---:|
| E2E duration | 67 ms | 72 ms |
| prompt bytes | 5,530 | 5,885 |
| Pi RPC count | 1 | 1 |
| retries | 0 | 0 |
| checkpoints | 0 | `RESEARCH`, `DESIGN`, `PUBLISH` |

The variant adds 355 prompt bytes and 5 ms in this local mock, with no RPC or retry reduction. All three variant checkpoints passed in the measured case.

## Limitations and artifacts

This is a measurement/instrumentation prototype, not a semantic optimizer. The A/B result is limited to the deterministic local mock and does not establish provider-model quality, real evidence throughput, or production latency. Checkpoint events are not themselves evidence or verification grants. Temporary mock artifacts were created under `/tmp/newsroom-sparse-checkpoint-*` and removed by the harness; the release binary is `target/release/news`. No secrets were copied into this report.
