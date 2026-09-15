# Visual Runtime Iteration Status v1.16-v1.24

## Executive status

This checkpoint converts the project from a mostly custom visualization renderer into the control plane for a professional visualization toolchain. The evidence graph, claims, provenance, deterministic verification and newsroom orchestration remain authoritative. Geometry, large-scale aggregation, graph layout and specialist cartography are routed to mature backends through explicit runtime and capability contracts.

The current execution host is offline and contains the Python GIS stack but does not contain R, QGIS, GMT/PyGMT, Datashader/Dask or the browser graph/geospatial node modules. Those backends are therefore represented by reproducible runtime definitions, adapters, health probes and Skills, but remain `UNAVAILABLE` on this host. No missing backend is reported as available and no qualification result is fabricated.

## Release alignment

| Plan stage | Status | Evidence |
|---|---|---|
| v1.16 Runtime Foundation | IMPLEMENTED_AND_EXECUTED | Six runtime manifests, health probes, bootstrap definitions, bundled project Skills, Pi tool integration |
| v1.17 VisualRecipe 2.0 | IMPLEMENTED_AND_EXECUTED | Schema, compiler, capability-aware backend router, production/qualification modes |
| v1.18 Static Editorial Trio | PARTIAL_RUNTIME_AVAILABILITY | Python executes and renders deterministically; R and QGIS adapters/contracts are present but host runtimes are unavailable |
| v1.19 Large Geo & Scientific | CONTRACT_COMPLETE_RUNTIME_PENDING | PyGMT, Datashader and MapLibre/deck.gl runtime definitions/adapters exist; current host lacks required packages |
| v1.20 Graph Visual Compiler | CONTRACT_COMPLETE_RUNTIME_PENDING | GraphRecipe, GraphBackendRegistry, Sigma/Graphology source adapter, ggraph/sfnetworks routing; web/R runtimes unavailable here |
| v1.21 Editorial Chart System | SKILL_AND_ROUTING_FOUNDATION | Editorial chart Skill and routing contract exist; curated production template catalog remains future work |
| v1.22 Qualification Corpus | FOUNDATION_COMPLETE_HUMAN_EVIDENCE_PENDING | Seed real-story corpus, blinded pairwise plan and human-only prior builder implemented |
| v1.23 Backend Router 2.0 | IMPLEMENTED_AND_EXECUTED | Story-family scoring, runtime availability, empirical prior hook, challenger/qualification modes |
| v1.24 Production Optimization | FOUNDATION_COMPLETE | Content-addressed render cache implemented; warm workers and built deployment images remain deployment work |
| v1.25 Art Direction & QA | PENDING | Existing screenshot QA remains available; backend-specific bounded visual revision is not yet qualified |
| v2.0 Product Qualification | PENDING | Requires built professional runtimes, broader real-story corpus and qualified-human blind evidence |

## Runtime architecture

Runtime definitions live under `runtimes/`:

- `viz-python`: GeoPandas, Shapely/GEOS, pyproj/PROJ, Pyogrio, Matplotlib.
- `viz-r`: R, sf, terra, stars, ggplot2, mapsf, tmap, ggraph, sfnetworks and vector exporters.
- `viz-qgis`: QGIS LTR, PyQGIS and headless print-layout execution.
- `viz-pygmt`: GMT/PyGMT scientific and projection-heavy cartography.
- `viz-density`: Datashader/Dask/Xarray aggregation for large point and trajectory workloads.
- `viz-web`: Sigma/Graphology, MapLibre/deck.gl and editorial browser renderers.

`python3 scripts/runtime_health.py` is authoritative for local availability. Adapters must fail explicitly when their runtime is unavailable.

## VisualRecipe 2.0

`schemas/visual-recipe-v2.schema.json` is the common semantic input to rendering. It describes analytical job, story family, artifact mode, data scale, geographic requirements, graph requirements, visual encodings, annotation burden, delivery constraints and backend hints. The recipe does not contain backend-generated coordinates.

`runtime/visual/backend_router_v2.mjs` scores capable backends and then intersects that preference with runtime availability. Production mode selects one primary backend by default. Qualification and challenger modes may expose multiple candidates.

## Project Skills and Agent integration

Seven project Skills were created and validated:

- `python-gis`
- `r-editorial`
- `qgis-cartography`
- `pygmt-scientific`
- `datashader-density`
- `sigma-network`
- `editorial-chart`

The Rust/Pi launcher intentionally keeps `--no-skills` so ambient user or host Skills cannot silently change newsroom behavior. Project Skills are compiled into `runtime/pi/visual_skill_bundle.mjs` and exposed through explicit newsroom tools:

- `newsroom_visual_backend_status`
- `newsroom_visual_backend_plan`
- `newsroom_visual_skill`

These tools are aligned across the Pi allowlist, audit capability set and runtime materializer.

## Graph integration

The legacy custom `node_link` SVG path remains only for compatibility. New graph routing separates:

- Sigma.js + Graphology for interactive graph exploration.
- ggraph for static editorial networks.
- sfnetworks for spatial networks.
- adjacency matrices for dense relationship comparison when node-link geometry would be misleading.

Graph extraction is kept upstream behind `graph-extraction-result.schema.json`; GraphRAG is not a mandatory renderer dependency.

## Qualification design

`fixtures/benchmarks/v2/manifest.json` seeds qualification with existing real project stories instead of synthetic claims. `scripts/generate_backend_qualification_plan.mjs` generates candidate plans from the same recipes and a runtime-health snapshot.

`build_backend_priors.py` accepts only reviewer classes `qualified_human`, `editor` or `designer`. Machine visual critics cannot create backend winner priors. The initial production prior file remains intentionally empty until blinded human comparisons exist.

## Deterministic Python GIS output

The Python GIS backend now fixes Matplotlib SVG `hashsalt` and removes dynamic SVG timestamps. Two consecutive renders of the same Syros story produce identical bytes:

- SVG SHA-256: `22a09e06565f27b83a13c6045f56e6489fa524f1b0d601c35e4a586c65796ad8`
- PNG SHA-256: `88d993a6bf10224fe503fee1b6af324f044669ec3dacf0c1b847ad4e38867d3e`

The regression test renders twice and asserts both hashes are identical.

## Validation

The dedicated Visual Compiler smoke passes:

- Runtime foundation v1.16
- VisualRecipe v1.17
- Graph backend v1.20
- Backend-prior validation v1.22
- Backend Router v1.23
- Render cache v1.24
- v1.15 compatibility router/compiler
- deterministic Python GIS backend

All seven Skills pass the Skill validator and the runtime contract checker reports allowlist, audit tools and materialization aligned.

A single monolithic `scripts/smoke.sh` invocation exceeded the outer execution time window after completing the new tests and most legacy visual tests. The remaining verifier/control-plane suite and every performance benchmark were then executed separately and passed. The only environment-level skip is Rust compilation/control-plane execution because this host has no `cargo` binary.

## Current host availability

- `viz-python`: AVAILABLE and executed.
- `viz-r`: UNAVAILABLE on this host.
- `viz-qgis`: UNAVAILABLE on this host.
- `viz-pygmt`: UNAVAILABLE on this host.
- `viz-density`: UNAVAILABLE on this host.
- `viz-web`: Node is available, required visualization packages are not installed, so runtime is UNAVAILABLE.

The host has no outbound package-network access, so missing system and package runtimes cannot be installed during this execution. Their reproducible image/environment definitions are part of the repository and should be built on a networked image-build/CI host, then health-checked before production use.

## Next execution gate

The next work should not expand custom rendering algorithms. Build the defined professional runtime images, run their artifact-level health checks, then render the same qualification stories through Python/R/QGIS and specialist candidates. Only after qualified-human pairwise evidence exists should `config/backend-priors.json` influence production selection.
