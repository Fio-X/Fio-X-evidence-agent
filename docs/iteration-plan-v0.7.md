# v0.7 Live Qualification Iteration Plan

## Goal

Move from integrity-hardened v0.6 artifacts to a release that can qualify a real Rust -> Pi -> model -> newsroom tools -> DuckDB run, measure it, and deterministically replay stored SQL.

## Gate 1: Hermetic live environment

- Pin Rust 1.98.1, Node 22.19.0+, Pi 0.85.1, DuckDB 1.5.5.
- Add `scripts/bootstrap_live_env.sh` and `scripts/live_readiness.py`.
- `news doctor --json --strict` must make missing or wrong versions machine-visible.
- Generate and commit `Cargo.lock` in the first Rust-enabled environment.

Acceptance: exact tool versions are reported; strict readiness fails closed when a required runtime is missing.

## Gate 2: Computation replay

- Add `news verify <artifact> --recompute`.
- Re-run every stored read-only SQL statement against immutable investigation-local evidence.
- Compare canonical rows and `result_hash` with the stored computation.
- Preserve ordinary fast integrity verification as the default.

Acceptance: changed query output is rejected even when the artifact tree is internally self-consistent.

## Gate 3: End-to-end performance telemetry

- Record one JSONL run metric per investigate/continue operation.
- Measure wall-clock agent duration and final status.
- Surface aggregate run time in `news inspect`.

Acceptance: live qualification can report agent wall time separately from renderer/verifier microbenchmarks.

## Gate 4: Provider qualification

- Add a provider qualification runner that executes first-turn investigation, follow-up replanning, inspect, integrity verification, and recomputation.
- Record provider/model, duration, tool calls, failures, retries, plan revisions, and final gate status.
- Never mark a provider qualified from configuration alone.

Acceptance: each provider has an evidence-backed qualification JSON, or a precise blocker.

## Gate 5: Live newsroom acceptance

- Use the World Bank fixture as a deterministic offline acceptance dataset.
- Use Ember Europe as the primary online competition-grade scenario when network is available.
- Require a real Pi process, a real model credential, and real DuckDB for the final live gate.

Acceptance: `investigate -> continue -> verify --recompute -> inspect -> evaluator` passes from one recorded artifact.

## Smoke strategy

After every gate run the narrow test first, then `scripts/smoke.sh`. Add separate budgets for recomputation protocol, verifier, and visualization. Mock RPC remains a control-plane test only and is never reported as live model qualification.

## Execution status

| Gate | Status in v0.7 source | Evidence |
| --- | --- | --- |
| G1 Hermetic live environment | PARTIAL | exact pins, strict readiness, bootstrap, Dockerfile and CI are implemented; current container remains `live_ready=false` because external runtime sources are unreachable and no model credential is available |
| G2 Computation replay | IMPLEMENTED | Rust `news verify --recompute`, independent Python replay, match/mismatch protocol smoke, real DuckDB acceptance configured in CI |
| G3 End-to-end telemetry | IMPLEMENTED | `run-metrics.jsonl`, inspect aggregation, 15th competition gate |
| G4 Provider qualification | IMPLEMENTED AS HARNESS | `live_qualification.sh`, `qualification.json`, manual live-model workflow; no provider is claimed qualified from this container |
| G5 Live newsroom acceptance | PENDING REAL RUNTIME | deterministic fixture and complete command sequence exist; requires Rust/Pi/DuckDB plus provider credentials |

## Performance result

During this iteration the scale verifier regressed to roughly 24.7 ms p95 because every computation repeatedly verified the same immutable input fingerprints. Adding a per-run fingerprint verification cache reduced the final scale benchmark to **5.886 ms p95** on 41 computations and 441 checks per run. Final responsive visualization p95 is **0.566 ms**. The final local smoke log is stored in `docs/smoke-v0.7.log`.
