# v1.4 Test Report

## Release under test

- Release: `1.4.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `0.9.0`
- InfographicSpec: `1.3.0`
- EditorialDiscovery / VisualConcept / SemanticNovelty: `0.1.0`
- SceneGraph: `0.1.0`
- Asset plan / reference retrieval / expert preference / slow-award status: `0.1.0`

## Final deterministic result

The canonical `scripts/smoke.sh` was executed as two ordered segments because the container imposes a per-call process timeout. The functional/integrity segment exited 0 and the performance segment exited 0. `docs/smoke-v1.4.log` concatenates both exact outputs and records `Composite smoke result: PASS`.

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| Rust/Pi runtime contract alignment | PASS |
| EditorialDiscovery / concept tournament | PASS |
| Semantic novelty and overview/detail exception | PASS |
| EIA + Titanic editorial-quality regressions | PASS |
| Asset planning / reference retrieval / human preference contract | PASS |
| SceneGraph schema/runtime and stable numbering | PASS |
| Natural Earth software-origin GIS intake | PASS |
| NASA v1.4 award-mode editorial regression | PASS |
| NASA selected desktop/mobile raster | PASS |
| NASA alternate SceneGraph prototype raster | PASS |
| Competition engineering evaluator | 24/24 PASS |
| Legacy integrity adversaries | 16/16 rejected |
| v1.4 editorial adversaries | 4/4 rejected |
| SQL recompute protocol | PASS |
| Mock Pi failure/recovery/resume | PASS |
| Real Rust/Pi/provider control plane | SKIP, runtime unavailable locally |
| Qualified human preference | PENDING, zero fabricated votes |

## Editorial-quality regression evidence

NASA GISTEMP uses eight concept candidates and rejects five before polished composition. The annual top-ten ranking is flagged at 0.8265 semantic overlap with the long-run line and is removed. Two bounded SceneGraph page prototypes are retained. The selected sidecar prototype scores 97/100 and rasterizes to 1440 x 2223 desktop and 720 x 4057 mobile; the full-width rail alternative scores 98/100 and rasterizes to 1440 x 2620 desktop. Human comparison remains `PENDING`.

The EIA 2024 energy-flow regression reads a 94.2 quadrillion-Btu primary-energy total from the checked-in real-data fixture. Removing a duplicate source-ranking view and adding mechanism/human-scale explanation raises average novelty from 0.6842 to 0.9511. The Titanic fixture totals 2,201 represented people and 711 survivors; removing a duplicate aggregate-survival view raises novelty from 0.6466 to 0.8166 while retaining intersection and human-scale dimensions.

## Integrity hardening

The independent verifier now replays or recomputes EditorialDiscovery decisions, VisualConcept finalists, semantic-novelty decisions, asset-plan decision, expert-preference status and slow-award status. Four new adversarial mutations recompute their own stored content hashes after tampering, so success cannot depend on detecting a stale hash alone. All four are rejected.

SceneGraph runtime validation also rejects stale module references. Stable editorial ordinals are derived from canonical module order; desktop and mobile therefore preserve numbering even when SceneGraph geometry traverses anchor/sidecar boxes in a different order.

## Performance

Final steady-state measurements:

| Pipeline | Workload | p50 | p95 | Max | p95 budget |
| --- | --- | ---: | ---: | ---: | ---: |
| Artifact verifier | 400 iterations, 351 checks/run | 6.683 ms | 7.270 ms | 9.390 ms | 15 ms |
| Scale verifier | 41 computations, 711 checks/run | 9.317 ms | 9.679 ms | 10.808 ms | 40 ms |
| Editorial artifact verifier | 200 iterations, 386 checks/run | 7.667 ms | 8.076 ms | 9.626 ms | 15 ms |
| Statistical responsive viz | 10 families x 120 | 0.192 ms | 0.395 ms | 0.894 ms | 10 ms |
| Complex viz | 8 families x 100 | 0.248 ms | 0.470 ms | 1.508 ms | 18 ms |
| Spatial/process viz | 4 families x 140 | 0.123 ms | 0.311 ms | 1.089 ms | 22 ms |
| Semantic explainer | 400 iterations | 0.093 ms | 0.188 ms | 0.280 ms | 8 ms |
| Infographic composer | 240 iterations, 3 candidates | 0.454 ms | 0.675 ms | 0.990 ms | 15 ms |
| Bounded visual revision | 4,000 iterations | 0.171 ms | 0.263 ms | 0.640 ms | 2 ms |
| Competition preflight | 4,000 iterations | 0.00165 ms | 0.00282 ms | 0.143 ms | 0.5 ms |
| Semantic novelty | 30 modules x 2,000 | 2.061 ms | 2.324 ms | 4.250 ms | 5 ms |
| SceneGraph composition | 12 elements x 1,200 | 0.355 ms | 0.615 ms | 6.224 ms | 5 ms |

A first isolated editorial-verifier measurement produced p95 23.948 ms during container/file-system contention. The test was investigated instead of relaxing the budget. With explicit warmup, repeated runs were approximately 7.8-8.9 ms p95; the final performance segment records 8.076 ms under the unchanged 15 ms target.

## External environment boundary

`docs/live-readiness-v1.4.json` reports `live_ready=false`. Node is v22.16.0 versus the pinned v22.19.0; Pi, DuckDB, rustc and Cargo are absent; model credentials are absent. Real provider qualification was therefore not executed or claimed.

The human-preference artifact for the NASA v1.4 comparison has zero reviews, a predeclared minimum of three and status `PENDING`. v1.4 does not substitute multimodal model judgment for that external gate.
