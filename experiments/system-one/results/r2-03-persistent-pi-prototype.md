# r2-03 persistent Pi process prototype

## Classification

PROMOTE

## Tested revision

- Branch: `exp/system-one-r2-03-persistent-pi-prototype`
- Commit: `4965767bdbd6880f1b21ecd846ba2e3abde55044`
- Environment: macOS 27.0; rustc/cargo 1.98.1; Python 3.14.6

## Checks

- PASS `cargo fmt --check`
- PASS `cargo test --locked` — 87 passed, 1 ignored
- PASS `cargo build --release --locked`
- PASS `bash scripts/test_control_plane.sh` — existing artifact verification/evidence gates passed; opt-in sequence reported `prompt_count=2`
- PASS `python3 scripts/test_rpc_waits.py target/release/news` with the prototype flag unset — bounded waits, cleanup, and provider-error redaction passed

## Observed A/B values

Deterministic `scripts/mock_pi.py` fixture, release binary, one continuation invocation per case:

| case | child launches | prompt_count | startup_ms | rpc_ms | measured E2E |
|---|---:|---:|---:|---:|---:|
| baseline | 1 | 1 | 429 | 430 | 487.7 ms |
| opt-in sequence | 1 | 2 | 73 | 73 | 139.6 ms |

The variant used one child for the initial-plus-follow-up prompt sequence and emitted one final metrics event. The timing delta is directional only: the mock is stateful and the runs were not a production-provider benchmark.

## Diff scope and safeguards

- `src/pi.rs`: bounded `run_prompt_sequence`; default `run_prompt` remains one prompt; existing timeout, redaction, final-text, stats, and process-group cleanup paths remain authoritative.
- `src/commands/continue_investigation.rs`: opt-in `NEWSROOM_PERSISTENT_PI_PROTOTYPE=1` branch only.
- `scripts/test_control_plane.sh`: deterministic opt-in sequence assertion.
- No provider-specific dependency, evidence/verification/publication gate change, or generated artifact was committed.

## Limitations and artifacts

The prototype reconstructs a bounded initial context prompt inside the continuation command; it does not yet persist a live child across separate CLI invocations. Real-provider behavior was not exercised. Temporary mock artifacts and logs were written outside the repository and were not retained.

No secrets were copied into this report.
