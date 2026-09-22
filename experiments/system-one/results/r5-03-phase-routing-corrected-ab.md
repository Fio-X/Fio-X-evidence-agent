# r5-03-phase-routing-corrected-ab

- Tested commit: `05a08fb0863535aa5dd506c4885d8c29bf8f9ac0`
- Branch state: detached HEAD at `origin/exp/system-one-r5-03-phase-routing-corrected-ab`; input evidence inspected only from `origin/exp/system-one-r4-07-phase-env-plumbing` with `git show`/`git diff`.
- Environment: macOS; Node `v24.14.1`; Cargo `1.98.1`; Rust `1.98.1`.

## Implementation

The opt-in variant validates `NEWSROOM_PHASE` in Rust and the extension, forwarding valid comma-separated phases and fail-closing invalid values to `core`; unset/`all` preserves the unrestricted surface. Runtime metrics are opt-in (`NEWSROOM_PHASE_METRICS=1`) and record only registered tool name, effective phase/profile, and UTF-8 bytes of the actual TypeBox `parameters` schema. Profile counts use canonical `toolEnabled`, including inheritance.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_phase_tool_scope_v112.mjs`
- PASS — `python3 scripts/test_phase_env_plumbing.py`: valid `verify,design`, invalid `core`, unset preserved.
- PASS — `node scripts/test_phase_runtime_surface.mjs`, repeated 3 times; no provider or authentication route used.
- PASS — `git diff --check`; only allowlisted source/scripts plus this result were changed.

## Measurements

Three repeated runtime runs produced identical values:

| profile / phase | effective tools | schema bytes | reduction vs visual-story/all |
|---|---:|---:|---:|
| visual-story / all | 47 | 40,355 | baseline |
| visual-story / discover | 7 | 1,860 | tools 85.11%, bytes 95.39% |
| visual-story / verify | 7 | 2,670 | tools 85.11%, bytes 93.38% |
| visual-story / design | 25 | 22,594 | tools 46.81%, bytes 44.01% |
| investigate / all | 14 | 13,131 | tools 70.21%, bytes 67.46% |
| investigate / verify | 5 | 2,227 | tools 89.36%, bytes 94.48% |

Canonical inherited visual-story counts are exactly `all=47`, `discover=7`, `verify=7`, `design=25`. Invalid visual-story phase measured as `core` with 4 tools and 1,196 schema bytes. The measurement harness stores temporary JSONL/summary artifacts outside the repository; no generated artifacts were committed.

The variant is opt-in and does not add orchestration or alter evidence, provenance, verification, completion, publication, browser-QA, or deterministic replay gates. No Fact/Claim/SQL/Evidence auto-repair or parallel state store was introduced. No secrets were copied into this report.

PROMOTE
