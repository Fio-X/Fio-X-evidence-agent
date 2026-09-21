# r3-01-observability-foundation — HOLD

## Tested revision

- Commit: `30b5d3fe823e794b9120a987349bdc0e2d0c4dfa`
- Branch: `exp/system-one-r3-01-observability-foundation`
- Inputs inspected with `git diff`/`git show`: `origin/exp/system-one-r2-01-rpc-metric-correctness`, `origin/exp/system-one-r2-02-phase-surface-observability`

## Implementation

Integrated the two R2 mechanisms in the six allowlisted files: sanitized terminal success/failure RPC events, cumulative and operation-local RPC aggregates, effective phase/profile tool-surface fields, and a best-effort real-registration phase snapshot. Default `phase=all` behavior and trust gates remain unchanged; no daemon or background service was added.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_phase_tool_scope_v112.mjs` (53 registry tools; investigate profile 14; verify effective surface 5)
- PASS — provider-error mock probe: terminal `newsroom_rpc_metrics` was emitted with `outcome=failed`, `failure_class=provider_error`; `run-metrics.jsonl` contained both cumulative and operation-local aggregates; secret canary hits were 0.
- FAIL — `python3 scripts/test_rpc_waits.py target/release/news`. The existing fragmented-output mock intermittently reaches the hard-coded 150 ms idle timeout (`mode=fragment`, return code 1). A direct isolated run of the same fixture passed; no gate was weakened.

## Repeated A/B measurement

Twenty control/variant warm-mock repetitions were run with temporary artifacts outside the repository:

| Variant | n | Median E2E | p95 E2E | Min–max |
|---|---:|---:|---:|---:|
| HEAD control | 20 | 86.64 ms | 133.51 ms | 79.39–795.93 ms |
| Observability variant | 20 | 88.70 ms | 103.58 ms | 76.90–105.91 ms |

Variant deltas: median +2.05 ms; p95 −29.93 ms. The control p95 includes a single 795.93 ms outlier.

Observed mock metrics included `pi_rpc.calls=1` and `pi_rpc_operation.calls=1` for the first operation; failure runs recorded `failed_calls=1` without exposing provider diagnostics. The normal mock had `tool_profile=investigate`, `tool_count=14`, and `phase=all`; the mock peer does not load the real extension, so the actual registration snapshot requires a runtime-extension harness not present in this checkout.

## Artifacts and blockers

- Temporary measurement artifacts: `/private/tmp/r3-control.WQrV8o`, `/private/tmp/r3-observe-check.YSCypc`, `/private/tmp/r3-failure-check.9wdw2d`
- Blocker: focused RPC watchdog remains timing-sensitive in its fragmented-output case; user action is not required.
- No secrets, credentials, raw provider diagnostics, or sensitive canaries were copied into this report.

## Final classification

HOLD
