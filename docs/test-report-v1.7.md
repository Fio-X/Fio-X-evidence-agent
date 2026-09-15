# v1.7 RC Test Report

Release: `1.7.0-rc1`

## New release-blocking regressions

- `node scripts/test_editorial_semantics_v17.mjs` — PASS
- `node scripts/test_editorial_semantics_adversarial_v17.mjs` — PASS: 20 semantic cases, 7 grammar cases, 6 backend matrices
- `node scripts/test_cold_story_editorial_semantics_v17.mjs` — PASS: 2026-09-14 Saudi/Hormuz replay, 2 cases
- `node scripts/test_backend_router_v123.mjs` — PASS with tabular adjacency negative assertion
- `python3 scripts/test_visual_recipe_schema_v117.py` — PASS with semantic fields
- `node scripts/test_semantic_contract_v127.mjs` — PASS with MeasureSemantics/ClaimSpec fingerprint coverage

## Compatibility/regression checks

The existing VisualRecipe, evidence router, backend agent, graph, web/ECharts, renderer, cache, GIS compiler, and Python publication tests used by `scripts/smoke_visual_compiler.sh` pass in the current host environment. The first aggregate invocation hit the command time limit after the web-runtime test; execution resumed from the next unexecuted command and the remainder passed.

## Environment boundary

A complete live qualification was not possible on this host. Final v1.7 promotion still requires the pinned Rust/Pi/DuckDB environment, provider credentials, and the 10-story networked cold-story gate described in `docs/iteration-plan-v1.7.md`.
