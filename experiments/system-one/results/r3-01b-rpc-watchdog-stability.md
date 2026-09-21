# R3-01b RPC watchdog stability

Classification: **PROMOTE**

## Revision and environment

- Branch: `exp/system-one-r3-01b-rpc-watchdog-stability`
- Tested commit: `fa6b26ea04d1b1b7fa372c12a1a196da28c3041d`
- Baseline named by task: `30b5d3fe823e794b9120a987349bdc0e2d0c4dfa`
- OS: Darwin 27.0.0, arm64
- Rust: `rustc 1.98.1 (48a229cea 2026-09-01)`
- Cargo: `1.98.1 (797e8a9bc 2026-08-05)`
- Python: `3.14.6`

## Change

Changed only `scripts/test_rpc_waits.py`: the existing `fragment` fixture now uses a 300 ms idle watchdog margin; all other modes remain at 150 ms. The fixture emits each JSON record in two pieces with a 70 ms pause, so its deliberate inter-chunk interval is 140 ms. This separates fixture timing from the watchdog without changing runtime code, weakening the fragment case, or suppressing failures.

## Measurements

Before the change, 25 direct fragment runs with the existing 150 ms margin produced 20 successes and 5 failures (80%); successful wall time median was 853.3 ms and maximum was 870.5 ms.

After the change, 50 direct fragment runs were executed as two 25-run batches:

- 50/50 successful; 0 failures
- Wall time: minimum 812.0 ms, batch medians 853.2 ms and 852.8 ms, batch p95 values 864.4 ms and 865.6 ms, maximum 872.6 ms

The full watchdog script was run 10 times after the change. All 10 runs passed, including the fragment case and provider-error persistence/redaction assertion. Fragment wall times across those runs were 839.9–874.0 ms, median 849.4 ms, p95 866.7 ms; every redaction check reported `secret_hits=0`.

## Required checks

- PASS — `cargo fmt --check`
- PASS — 50 direct fragment-case repetitions after the change
- PASS — `python3 scripts/test_rpc_waits.py target/release/news`, 10 repetitions
- PASS — `cargo test --locked` (87 passed, 1 ignored, 0 failed)
- PASS — `cargo build --release --locked`
- PASS — `git diff --check`

## Commands and artifacts

Commands executed included the direct fragment measurement harness, the full watchdog command above, `cargo fmt --check`, `cargo test --locked`, `cargo build --release --locked`, and `git diff --check`.

Non-sensitive temporary JSON outputs were written under `/tmp/r3-01b-full-*.json`; no repository-generated artifacts were added. The final repository diff is limited to the allowed script and this result file.

No authentication, browser login, macOS permission, or other user action was required. No secrets were copied into this report.
