# 10-validator-cost-map

## Hypothesis

Deterministic validators are sufficiently cheap for local gating; if any optimization is justified, it should target the slower semantic/verifier path rather than the mechanical or bounded-presentation checks.

## Commands and measurements

Baseline: branch `exp/system-one-r1-10-validator-cost-map`, commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.

Environment: Darwin arm64, macOS kernel 27.0.0; Rust/Cargo 1.98.1; Node v24.14.1; Python 3.14.6.

Commands were timed with `/usr/bin/time -p`; Cargo artifacts were redirected to `/tmp/validator-cost-map.Xz3TEg/target`.

| Class | Command | Result | Wall time |
|---|---|---:|---:|
| Mechanical Rust/unit validators | `env CARGO_TARGET_DIR=/tmp/validator-cost-map.Xz3TEg/target cargo test --locked` | PASS: 87 passed, 1 ignored, 0 failed | 17.19 s cold; 0.17 s warm |
| Semantic visual validators | `node scripts/test_editorial_semantics_v17.mjs` | PASS | 0.04 s |
| Semantic adversarial matrix | `node scripts/test_editorial_semantics_adversarial_v17.mjs` | PASS: 20 semantic, 8 grammar, 6 backend cases | 0.04 s |
| Bounded-presentation/cognitive validators | `node scripts/test_cognitive_editorial_validators_v15.mjs` | PASS | 0.06 s |
| Evidence gate | `node scripts/test_evidence_gate.mjs` | PASS | 0.04 s |
| Editorial verifier adversaries | `python3 scripts/test_editorial_verifier_v14.py` | PASS: 4 adversarial cases | 0.24 s |

## Observed values

- Warm local validation is sub-second for the measured checks: approximately 0.17 s for all Rust tests and 0.04–0.24 s for focused suites.
- The largest measured steady-state check was the editorial verifier at 0.24 s; it is still small compared with the 17.19 s cold Rust compilation/startup cost.
- The Rust test binary reported 0.05 s test execution time, separating compilation from validator execution.
- No validator failures or correctness/evidence-gate failures were observed in runnable suites.

## Limitations

- `scripts/test_visual_qa_v133.py`, `scripts/test_artifact_schema.py`, and `scripts/test_fact_editorial_contracts.py` were attempted but SKIP/blocked by missing local Python packages (`PIL` and `jsonschema`); packages were not installed.
- Timings are single-process local wall times on one machine, not p95 measurements or end-to-end production timings.
- The cold Cargo result includes dependency compilation and is not representative of steady-state validator cost.
- Measurements were taken from deterministic fixtures and do not establish provider or browser-runtime costs.

## Classification

HOLD

The runnable evidence supports low steady-state validator cost and no immediate optimization target, but the map is incomplete because important Python/schema and visual-QA validators could not run.
