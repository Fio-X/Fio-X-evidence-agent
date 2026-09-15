# v1.5 Test Report

## Release under test

- Release: `1.5.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `1.0.0`
- InfographicSpec: `1.3.0`
- Cartography schema: `0.1.0`
- Primary change: provenance-aware cartographic flow rendering and magazine integration

## Final deterministic result

The canonical `scripts/smoke.sh` command is longer than the execution container's 120-second per-call limit, so the exact script order was re-executed as four ordered segments on the final work tree. Every segment completed with exit status 0. `docs/smoke-v1.5.log` concatenates the four outputs and ends with `Composite smoke result: PASS`.

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| Rust/Pi runtime materialization contract | PASS |
| NewsroomVizSpec 1.0 cartographic schema | PASS |
| Legacy statistical/complex/spatial snapshots | PASS |
| EIA 2024 cartographic OD regression | PASS, critic 100/100 |
| World Bank 2021 remittance OD regression | PASS |
| Great-circle semantics contract | PASS |
| Verified-route semantics contract | PASS |
| Observed-trajectory semantics contract | PASS |
| Network-constrained semantics contract | PASS |
| Missing physical route geometry/provenance | rejected |
| Observed trajectory without `time_field` | rejected |
| Mutated basemap hash | rejected |
| 81 unaggregated routes | rejected |
| `top_n` dense-map recovery | PASS |
| Cartographic desktop/mobile raster | PASS |
| EIA SceneGraph magazine integration | PASS, page critic 95/100 |
| Competition engineering evaluator | 24/24 PASS |
| Legacy integrity adversaries | 16/16 rejected |
| v1.4 editorial adversaries | 4/4 rejected |
| SQL recompute protocol | PASS |
| Mock Pi failure/recovery/resume | PASS |
| Real Rust/Pi/provider control plane | SKIP, Cargo/runtime unavailable locally |

## Cartographic pixel QA

The first Natural Earth 1 implementation exposed a projection regression in raster review: the world geometry was compressed toward the left side because the x-polynomial used an incorrect term. The formula was corrected and a release-blocking symmetry/coverage test now checks the projected world center, east-west symmetry and projected width.

Direct-label QA then exposed short-route collisions around Canada/Mexico and UAE/India. Short routes now fold their values into source labels when appropriate, destination/source labels use backed text boxes and separated baselines, and only a bounded set of longer-route values is placed over arcs. Desktop label capacity was widened for country names without changing mobile density policy.

The two authoritative OD maps always display route-semantics disclosure. EIA arcs are described as supplier-to-U.S. relationships rather than tanker or pipeline routes. World Bank remittance arcs are bilateral estimates rather than physical money-transfer paths.

## Magazine integration

`scripts/test_cartographic_magazine_v15.mjs` combines the EIA import map, a Canada sidecar, route-semantics explanation and the existing EIA national energy Sankey through InfographicSpec 1.3 SceneGraph. The final selected page is 1440 x 2788 desktop and 720 x 3430 mobile and receives deterministic page critic 95/100. This proves the cartographic engine is available to magazine composition rather than living as an isolated map renderer.

## Final performance

| Pipeline | Workload | p50 | p95 | Max | p95 budget |
| --- | --- | ---: | ---: | ---: | ---: |
| Artifact verifier | 400 iterations, 351 checks/run | 6.691 ms | 7.196 ms | 11.998 ms | 15 ms |
| Scale verifier | 41 computations, 711 checks/run | 9.751 ms | 11.022 ms | 27.226 ms | 40 ms |
| Editorial artifact verifier | 200 iterations, 386 checks/run | 7.851 ms | 10.216 ms | 28.165 ms | 15 ms |
| Statistical responsive viz | 10 families x 120 | 0.190 ms | 0.361 ms | 1.423 ms | 10 ms |
| Complex viz | 8 families x 100 | 0.266 ms | 0.597 ms | 3.543 ms | 18 ms |
| Legacy spatial/process viz | 4 families x 140 | 0.126 ms | 0.290 ms | 1.427 ms | 22 ms |
| Cartographic flow | 300 iterations, 6 EIA routes | 3.112 ms | 4.105 ms | 5.961 ms | 8 ms |
| Semantic explainer | 400 iterations | 0.097 ms | 0.246 ms | 0.389 ms | 8 ms |
| Infographic composer | 240 iterations, 3 candidates | 0.422 ms | 0.670 ms | 0.936 ms | 15 ms |
| Bounded visual revision | 4,000 iterations | 0.171 ms | 0.299 ms | 2.097 ms | 2 ms |
| Competition preflight | 4,000 iterations | 0.00168 ms | 0.00513 ms | 0.294 ms | 0.5 ms |
| Semantic novelty | 30 modules x 2,000 | 2.072 ms | 2.337 ms | 4.557 ms | 5 ms |
| SceneGraph composition | 12 elements x 1,200 | 0.357 ms | 0.649 ms | 5.904 ms | 5 ms |

The new map engine is materially more expensive than the old schematic `geo_flow_map` because it projects and draws 177-country basemap geometry plus route labels, but its 4.105 ms p95 stays well below the new 8 ms budget and does not change existing renderer budgets.

## External environment boundary

`docs/live-readiness-v1.5.json` reports `live_ready=false`. Local Node is v22.16.0 versus pinned v22.19.0; Pi, DuckDB, rustc and Cargo are absent; model credentials are absent. Real provider qualification therefore remains unexecuted.

The `verified_route`, `observed_trajectory` and `network_constrained` lanes are structurally qualified with clearly labeled illustrative geometry. v1.5 does not claim a real full-scale ADS-B or AIS trajectory benchmark. OpenSky publishes timestamped scientific air-traffic datasets and NOAA Marine Cadastre publishes historical AIS vessel data; production ingestion, simplification and multiscale aggregation remain the next operational qualification.
