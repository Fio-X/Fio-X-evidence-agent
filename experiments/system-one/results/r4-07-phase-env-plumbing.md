# r4-07-phase-env-plumbing

Classification: PROMOTE

## Tested revision

- Branch: `exp/system-one-r4-07-phase-env-plumbing`
- Commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- macOS 27.0; rustc/cargo 1.98.1; Node v24.14.1; Python 3.14.6

## Implementation

Rust now validates and injects `NEWSROOM_PHASE` into the Pi child when present. Unset remains unset and therefore preserves runtime `phase=all`; malformed values normalize to the fail-closed `core` phase. The extension applies the same canonical validation. `NEWSROOM_PHASE_METRICS=1` emits bounded per-tool phase/profile/schema-byte events; it is measurement-only and opt-in.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (88 passed, 1 ignored)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_phase_tool_scope_v112.mjs`
- PASS — `python3 scripts/test_phase_env_plumbing.py` (valid `verify,design`, invalid→`core`, unset→unset)
- PASS — `git diff --check`

## Measurements

The focused scope harness reported 53 registered tools and 14 investigate-profile tools. Effective tool count / bounded scope-schema bytes:

| Profile | discover | verify | design |
| --- | ---: | ---: | ---: |
| investigate | 5 / 373 | 5 / 382 | 7 / 525 |
| visual | 6 / 447 | 6 / 456 | 23 / 1863 |
| visual-story | 2 / 158 | 2 / 158 | 4 / 327 |

The Rust-launched child captured `NEWSROOM_PHASE` exactly for the valid request, normalized malformed input to `core`, and received no phase variable when unset. No provider, network, artifact, evidence, verification, publication, or browser-QA route was exercised or weakened.

Non-sensitive measurement output: `/tmp/r4-07-phase-scope.json`.

No secrets were copied into this report.
