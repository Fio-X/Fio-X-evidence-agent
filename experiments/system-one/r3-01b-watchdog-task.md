# R3-01b: RPC watchdog stability

Baseline: `30b5d3fe823e794b9120a987349bdc0e2d0c4dfa`

Objective: make the existing fragmented-output watchdog test deterministic enough to validate the R3-01 observability integration. This task is test-harness-only.

Allowed product changes: none.

Allowed repository change:
- `scripts/test_rpc_waits.py`
- this result file: `experiments/system-one/results/r3-01b-rpc-watchdog-stability.md`

Constraints:
- do not weaken runtime timeouts or product behavior
- do not skip the fragment case
- do not suppress failures
- preserve provider-error redaction assertions
- explain the source of flakiness with measurements
- prefer deterministic scheduling margins or fixture timing separation over arbitrary large sleeps

Required checks:
- run the fragment case repeatedly at least 50 times
- run full `python3 scripts/test_rpc_waits.py target/release/news` at least 10 times after the change
- `cargo fmt --check`
- `cargo test --locked`
- `cargo build --release --locked`
- `git diff --check`

Final classification: PROMOTE / HOLD / REJECT / INCONCLUSIVE.
