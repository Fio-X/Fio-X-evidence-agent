# v1.6 Test Report

## Release under test

- Release: `1.6.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `1.1.0`
- InfographicSpec: `1.3.0`
- Patch scope: observed-trajectory cartography, real public ADS-B/AIS regression, linked trajectory profile and local-scale map diagnostics

## Result

The canonical v1.6 smoke suite passes on the final code tree. It was executed in four ordered segments to remain within the container's single-command time limit. Segmenting changes scheduling only; the logged sequence covers the canonical schema/runtime, functional/integrity, verifier/control-plane and performance suites.

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| Live-readiness contract | PASS, `live_ready=false` |
| Runtime allowlist/audit/materialization contract | PASS |
| NewsroomVizSpec 1.1 trajectory schema | PASS |
| Legacy visualization regression/snapshots | PASS |
| v1.5 EIA + World Bank cartographic regressions | PASS |
| v1.6 public ADS-B trajectory regression | PASS |
| v1.6 ADS-B magazine raster regression | PASS |
| v1.6 public AIS local-scale diagnostic | PASS, expected `basemap_detail_mismatch` |
| Competition engineering evaluator | 24/24 PASS |
| Legacy integrity adversaries | 16/16 rejected |
| v1.4 editorial adversaries | 4/4 rejected |
| SQL recompute protocol | PASS |
| Mock Pi recovery/resume | PASS |
| Real Rust/Pi/provider control plane | SKIP, runtime unavailable locally |

## Real trajectory evidence

The ADS-B regression preserves the upstream observation gap and never fills it with an invented solid segment. The same gap appears in the map and in the linked altitude/speed profile. A dashed great-circle reference is rendered as a separately labeled geometric reference and is not presented as a filed route. The full page is 1440 x 3105 desktop and 720 x 3820 mobile, with page critic 95/100.

The Syros AIS regression intentionally tests a sub-degree local extent. Exact trajectory geometry renders, while the bundled Natural Earth 1:110m substrate fails the publication-context requirement. The critic reports `basemap_detail_mismatch` and scores 86, establishing a release-visible boundary for harbour/airport-scale work.

## Final performance

| Pipeline | Workload | p50 | p95 | Max | p95 budget |
| --- | --- | ---: | ---: | ---: | ---: |
| Artifact verifier | 400 iterations, 351 checks/run | 6.635 ms | 7.112 ms | 8.857 ms | 15 ms |
| Scale artifact verifier | 41 computations, 711 checks/run, 100 iterations | 9.255 ms | 9.863 ms | 11.937 ms | 40 ms |
| Editorial artifact verifier | 200 iterations, 386 checks/run | 7.597 ms | 8.217 ms | 9.798 ms | 15 ms |
| Statistical responsive viz | 10 families x 120 | 0.208 ms | 0.467 ms | 1.332 ms | 10 ms |
| Complex viz | 8 families x 100 | 0.251 ms | 0.471 ms | 8.864 ms | 18 ms |
| Spatial/process viz | 4 families x 140 | 0.135 ms | 0.327 ms | 1.347 ms | 22 ms |
| v1.5 cartographic flow | 300 iterations | 3.071 ms | 3.939 ms | 22.091 ms | 8 ms |
| v1.6 observed-trajectory cartographic bundle | 300 iterations, desktop + mobile | 6.125 ms | 7.923 ms | 29.770 ms | 10 ms |
| v1.6 trajectory profile bundle | 500 iterations, desktop + mobile | 0.114 ms | 0.239 ms | 2.091 ms | 5 ms |
| Semantic explainer | 400 iterations | 0.092 ms | 0.204 ms | 0.497 ms | 8 ms |
| Infographic Composer | 240 iterations, 3 candidates | 0.470 ms | 0.766 ms | 3.017 ms | 15 ms |
| Bounded visual revision | 4,000 iterations | 0.170 ms | 0.257 ms | 13.180 ms | 2 ms |
| Competition preflight | 4,000 iterations | 0.0017 ms | 0.0028 ms | 0.172 ms | 0.5 ms |
| Semantic novelty | 2,000 iterations, 30 modules | 2.121 ms | 2.518 ms | 24.405 ms | 5 ms |
| SceneGraph | 1,200 iterations, 12 elements | 0.373 ms | 0.663 ms | 6.215 ms | 5 ms |

Every p95 release budget passes. The observed-trajectory bundle is intentionally more expensive than v1.5 OD flow because each iteration renders desktop and mobile data-fitted maps with observed segments, reference geometry, locator and basemap, while remaining below the 10 ms target.

## Environment boundary

Local live readiness remains false. Node is 22.16.0 rather than the pinned 22.19.0; Pi, DuckDB, Rust/Cargo and provider credentials are unavailable. The release makes no claim that real-provider control-plane qualification, production-scale ADS-B/AIS ingestion, real pipeline-network ingestion or qualified-human preference has run.
