# Experiment 14: Pi process count

## Hypothesis

Each `run_prompt` call launches a fresh Pi OS process, including continuation calls; a normal investigation plus continuation therefore launches two Pi processes, while bounded retry paths can launch more.

## Commands and measurements

- `cargo build --release --locked` — PASS; built `target/release/news`.
- `scripts/test_control_plane.sh` — PASS; canonical mock investigation/continuation acceptance passed, including `user_messages=2` and resumed-session evidence.
- Ran `target/release/news investigate` with `scripts/mock_pi.py`, then `target/release/news continue` against the temporary artifact. Counted `type=newsroom_rpc_metrics` records in `events.jsonl`.
- Inspected Rust call sites in `src/pi.rs`, `src/commands/investigate.rs`, `src/commands/continue_investigation.rs`, and `src/commands/investigate_v2.rs`.

## Observed values

The representative initial-plus-continuation flow produced 2 metric records and therefore 2 Pi process launches:

| operation | launches | continue_session | startup_ms | rpc_ms | prompt_bytes |
|---|---:|---|---:|---:|---:|
| initial investigate | 1 | false | 159 | 170 | 5530 |
| continue | 1 | true | 119 | 120 | 546 |

The Rust call graph shows:

- ordinary investigate: 1 launch, with one bounded empty-response recovery retry (up to 2);
- complex visual investigate: 1 initial launch plus up to 2 completion-gate retries (up to 3 total), all setting `continue_session=true` after the first;
- `continue`: 1 launch;
- direct visual-story runner: 1 launch plus at most 1 corrective turn (up to 2).

## Limitations

The mock validates control flow and recorded metrics, not real Pi startup or provider latency. Process counts are inferred from the one metric event emitted per successful `run_prompt` and corroborated by the `run_prompt` spawn path; failed launches do not emit a successful metric event. The direct visual-story runner was not executed because its bundled mock cannot produce the required publication artifacts.

## Classification

PROMOTE
