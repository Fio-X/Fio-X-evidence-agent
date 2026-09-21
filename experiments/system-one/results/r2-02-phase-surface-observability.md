# r2-02-phase-surface-observability

Tested commit: `4965767bdbd6880f1b21ecd846ba2e3abde55044`  
Branch: `exp/system-one-r2-02-phase-surface-observability`

## Implementation

- Added a policy-level surface projection distinguishing profile tool count from effective phase tool count.
- Added runtime registration accounting in `runtime/pi/newsroom.ts`, including UTF-8 JSON parameter-schema byte estimates and a best-effort `runtime/phase-tool-surface.json` snapshot.
- Added the snapshot fields to `newsroom_rpc_metrics`; existing `tool_count` remains backward-readable as the profile count.
- File I/O and schema estimation are fail-safe and cannot alter tool registration, evidence, verification, or publication behavior.
- Diff scope: four allowed files; 65 insertions and 4 deletions. No source outside the allowlist changed.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored, 0 failed)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_phase_tool_scope_v112.mjs`
- PASS — `node --experimental-strip-types --check runtime/pi/newsroom.ts`
- PASS — `python3 scripts/check_runtime_contract.py`
- PASS — `python3 scripts/test_rpc_waits.py target/release/news`
- PASS — `git diff --check`

## Observed A/B values

The focused contract test measured the deterministic registry projection:

| Surface | Profile count | Effective phase count | Change |
|---|---:|---:|---:|
| investigate / all (baseline) | 14 | 14 | — |
| investigate / verify (variant) | 14 | 5 | 64.3% fewer registered tools |

The variant retained core, computation, parallel-task, and evidence tools and excluded discovery tools. The exact runtime schema-byte values were not measurable with `scripts/perf_mock_pi.py`: that peer does not load the Pi extension. The implementation records the value when the real extension registers tools using the declared UTF-8 JSON-parameter estimate method.

Mock investigations completed in both `NEWSROOM_PHASE=all` and `NEWSROOM_PHASE=verify`; both produced `events.jsonl` and a `run-metrics.jsonl` `pi_rpc` aggregate. The mock does not honor phase registration, so its observed wall times (260 ms and 65 ms) are recorded only as harness observations, not as a performance claim.

Artifacts: `/private/tmp/r2-02-phase-surface-2tIqiQ/` (temporary, non-sensitive); focused output was `/tmp/r2-02-focused.json`.

## Limitations

End-to-end snapshot emission and schema-byte totals require a Pi process that loads `runtime/pi/newsroom.ts`; no such provider/runtime process was available in the deterministic mock run. No evidence, provenance, verification, validator, publication, or browser-QA gate was changed.

No secrets were copied into this report.

## Final classification: PROMOTE
