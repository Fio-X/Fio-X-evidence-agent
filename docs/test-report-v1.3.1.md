# v1.3.1 Test Report

## Release under test

- Release: `1.3.1`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `0.9.0`
- InfographicSpec: `1.2.0`
- Patch scope: NASA GISTEMP real-data visual regression and pixel-QA renderer hardening

## Result

The final local smoke suite exits zero. The NASA regression is now part of `scripts/smoke.sh`, alongside the existing OWID/Ember, World Bank, EIA and Titanic real-data regressions.

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| NASA GISTEMP real-data regression | PASS |
| Visualization snapshots after intentional renderer change | PASS |
| Infographic XML/raster smoke | PASS |
| Competition engineering evaluator | 24/24 PASS |
| Integrity adversarial suite | 16/16 rejected |
| SQL recompute protocol | PASS |
| Mock Pi failure/recovery/resume | PASS |
| Real Rust/Pi/provider control plane | SKIP, runtime unavailable locally |

## Pixel-QA regression fixes

- Mobile heatmaps keep exact cell values when geometry allows and always include a min/max quantitative color legend.
- Process-schematic edge labels wrap instead of truncating with ellipsis and use mobile-aware placement around converging paths.
- Line annotations near the right plot boundary flip left to preserve annotation width.

The dedicated NASA assertions verify each behavior before the page is composed.

## Final performance

| Pipeline | Workload | p50 | p95 | Max | p95 budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| Artifact verifier | 400 iterations, 351 checks/run | 6.766 ms | 7.495 ms | 11.912 ms | 15 ms |
| Scale artifact verifier | 41 computations, 711 checks/run | 9.431 ms | 10.150 ms | 11.639 ms | 40 ms |
| Statistical responsive viz | 10 families x 120 | 0.196 ms | 0.401 ms | 1.223 ms | 10 ms |
| Complex viz | 8 families x 100 | 0.255 ms | 0.513 ms | 1.566 ms | 18 ms |
| Spatial/process viz | 4 families x 140 | 0.125 ms | 0.296 ms | 0.716 ms | 22 ms |
| Semantic explainer | 400 iterations | 0.093 ms | 0.279 ms | 0.621 ms | 8 ms |
| Infographic composer | 240 iterations, 3 candidates | 0.431 ms | 0.674 ms | 0.860 ms | 15 ms |
| Bounded visual revision | 4,000 iterations | 0.169 ms | 0.291 ms | 1.125 ms | 2 ms |
| Competition preflight | 4,000 iterations | 0.0019 ms | 0.0032 ms | 0.189 ms | 0.5 ms |

## Environment boundary

Local live readiness remains false. Node is 22.16.0 rather than the pinned 22.19.0, and Pi, DuckDB, Rust/Cargo and provider credentials are unavailable. This patch makes no claim that real-provider qualification has run.
