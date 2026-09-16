# v1.3 Test Report

## Release under test

- Release: `1.3.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `0.9.0`
- InfographicSpec: `1.2.0`
- Semantic explanatory protocol: `0.1.0`
- Rich illustration protocol: `0.2.0`
- Image-aware visual critic protocol: `0.2.0`
- Competition policy protocol: `0.1.0`
- CairoSVG preview runtime: `2.8.2`

The final deterministic/local smoke exits zero. The environment is intentionally reported as `live_ready=false`: local Node is 22.16.0 rather than the pinned 22.19.0, and Pi, DuckDB, Rust/Cargo plus provider credentials are absent. The Rust control-plane acceptance therefore reports an explicit `SKIP`; real-provider qualification remains pending and is not counted as a pass.

## Final gates

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| Runtime allowlist/audit/materialization contract | PASS |
| NewsroomVizSpec schema | PASS |
| News Artifact schema | PASS |
| InfographicSpec 1.2 schema | PASS |
| Rich illustration contract and active-content/origin-policy rejection | PASS |
| Image-aware critic bounded-patch contract | PASS |
| Mobile-specific order contract | PASS |
| Competition policy contract | PASS |
| Exact infographic preview rasterization | PASS |
| Existing statistical/complex/spatial visualization families | PASS |
| Semantic explanatory four-view pipeline | PASS |
| EIA magazine feature regression | PASS |
| Competition engineering evaluator | **24/24 PASS** |
| Integrity adversarial suite | **16/16 rejected** |
| SQL recompute protocol | PASS |
| Qualification-summary contract | PASS |
| Mock Pi failure/recovery/resume | PASS |
| Real Rust/Pi/provider control plane | SKIP, runtime unavailable locally |

## v1.3 regression findings

A real compatibility regression was found during implementation. The first InfographicSpec 1.2 version check caused the desktop composer to skip the three-candidate `balanced`, `anchor`, `rhythm` path and fall back to one balanced layout. The condition was widened to 1.1+ and a regression test now proves that 1.2 keeps three desktop candidates while allowing a separate mobile reading order.

A second release-integrity issue was found by `check_release_baseline.py`: `versions.json` had been advanced to 1.3.0 while `Cargo.toml` still declared 1.2.0. The package version was corrected to 1.3.0 and the release baseline now passes.

The final adversarial suite adds two v1.3 attacks. One modifies both the stored vision critic and the stored revision audit so they agree with each other, but the final plan cannot be reconstructed by independently replaying the allowed patches. The verifier rejects it. The other forges `machine_passed=true` in competition preflight; independent recomputation rejects it.

## Performance

All timings below come from the final `scripts/smoke.sh` run stored in `docs/smoke-v1.3.log`.

| Pipeline | Workload | p50 | p95 | Max | p95 budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| Artifact verifier | 400 iterations, 351 checks/run | 6.683 ms | **7.480 ms** | 15.172 ms | 15 ms |
| Scale artifact verifier | 41 computations, 711 checks/run, 100 iterations | 9.216 ms | **10.166 ms** | 14.159 ms | 40 ms |
| Statistical responsive viz | 10 families x 120 | 0.201 ms | **0.401 ms** | 2.458 ms | 10 ms |
| Complex viz | 8 families x 100 | 0.251 ms | **0.486 ms** | 1.555 ms | 18 ms |
| Spatial/process viz | 4 families x 140 | 0.125 ms | **0.308 ms** | 0.936 ms | 22 ms |
| Semantic explainer | 400 iterations | 0.090 ms | **0.200 ms** | 0.668 ms | 8 ms |
| Infographic composer | 240 iterations, 3 desktop candidates | 0.422 ms | **0.666 ms** | 0.931 ms | 15 ms |
| v1.3 bounded revision | 4,000 iterations, 12 modules, 3 patches | 0.173 ms | **0.309 ms** | 2.747 ms | 2 ms |
| v1.3 competition preflight | 4,000 iterations | 0.0016 ms | **0.00284 ms** | 0.131 ms | 0.5 ms |

The v1.2 baseline measured in the same environment before modification used 202 checks/run at p95 4.854 ms for the normal verifier and 562 checks/run at p95 8.027 ms for the 41-computation verifier. v1.3 raises the normal verifier p95 by about 54% and the scale verifier p95 by about 27% while increasing the checks/run to 351 and 711 respectively. The added cost comes from independent visual-revision replay and competition-preflight recomputation. Both remain far below their p95 budgets. Composer p95 improved from the initial v1.2 run's 0.845 ms to 0.666 ms, which should be treated as normal run-to-run variation because the core composition algorithm was not optimized in this iteration.

## Visual and policy evidence

The EIA real-data magazine regression still produces a 99/100 deterministic page critic with the `balanced` candidate selected. Exact XML/raster smoke passes for explanatory graphics and magazine output. The visual critic contract now allows `mobile_move_before`, and revision tests confirm mobile-only ordering leaves protected evidence unchanged.

Competition policy tests prove the current SND47 information-graphics profile rejects `generative_ai` and `mixed` rich-illustration origins while the OJA profile applies its mobile/visual-quality floors. The competition module marks all numerical thresholds as internal operational proxies rather than official jury cutoffs and preserves manual requirements for claims the system cannot truthfully self-attest.

## Live qualification status

`docs/live-readiness-v1.3.json` is the local environment record. It reports Node 22.16.0, no Pi executable, no DuckDB, no Rust/Cargo and no model credentials. Consequently no claim is made that a real multimodal provider has completed the qualification scenario. The v1.3 harness is ready to run once those dependencies are supplied.
