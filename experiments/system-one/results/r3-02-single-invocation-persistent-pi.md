# r3-02-single-invocation-persistent-pi

Classification: PROMOTE

Tested commit: `30b5d3fe823e794b9120a987349bdc0e2d0c4dfa`
Branch: `exp/system-one-r3-02-single-invocation-persistent-pi`
OS: macOS 27.0
Tools: cargo 1.98.1, rustc 1.98.1, Python 3.14.6, Node v24.14.1

## Implementation

- Added a bounded `run_prompt_sequence` in `src/pi.rs`, preserving the existing one-prompt `run_prompt` behavior and timeout, cleanup, provider-error redaction, and final completion checks.
- Added an opt-in `NEWSROOM_PERSISTENT_PI_EXPERIMENT=1` path in `investigate` for complex visual requests only. It sends the initial prompt plus at most two completion prompts through one child.
- Extended `scripts/test_control_plane.sh` with a deterministic launch-count wrapper and 10-repetition A/B measurement.
- No daemon, socket service, background process, or default-path behavior change was introduced.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored)
- PASS — `cargo build --release --locked`
- PASS — `bash scripts/test_control_plane.sh`
- PASS — `python3 scripts/test_rpc_waits.py target/release/news` (the first invocation had one transient normal-case failure; the identical rerun passed)
- PASS — `python3 scripts/test_artifact_completion.py`
- PASS — `git diff --check`

## Repeated mock A/B metrics

Ten repetitions per variant, using the complex visual mock path. The mock intentionally leaves completion gates incomplete, so both variants exit nonzero; this verifies fail-closed completion behavior while measuring lifecycle cost.

| Variant | Median E2E | P95 E2E | Launches/run | RPCs/run | Completion retries/run |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 496.28 ms | 1499.04 ms | 3 | 3 | 2 |
| Opt-in persistent | 304.10 ms | 319.60 ms | 1 | 1 | 2 |

The persistent variant reduced child launches and RPC sessions from 3 to 1 in every repetition. No non-sensitive generated artifacts were retained; harness temporary directories were cleaned up automatically.

## Blockers and invariants

No user action or authentication was required. Evidence, provenance, verification, publication, and browser-QA gates were not weakened. The default investigate path remains unchanged unless the explicit experiment environment flag is set. No secrets were copied into this report.
