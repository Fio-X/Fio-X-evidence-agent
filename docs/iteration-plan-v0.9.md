# v0.9 Iteration Plan — Spatial + Explanatory Visual Journalism

Status: completed

## Release intent

Expand the visualization runtime from statistical/relational graphics into spatial and explanatory visual journalism while preserving the audited evidence pipeline and v0.8 compatibility.

## Gate 1 — Visual topology protocol

- Upgrade NewsroomVizSpec to 0.9.0 while accepting 0.7/0.8 specs.
- Add chart forms: `geo_flow_map`, `parallel_sets`, `chord`, `process_schematic`.
- Add data topologies: `geo_edges`, `categorical_flow`, `process_graph`.
- Add topology fields for coordinates and categorical dimensions.
- Extend Pi planner enums, defaults, and prompt guidance.
- Contract tests must prove Pi planner, schema, renderer, and runtime agree.

## Gate 2 — Renderers + deterministic lint

- `geo_flow_map`: longitude/latitude projected routes, route width by value, labels, responsive reflow, and schematic map disclosure when no boundary layer is present.
- `parallel_sets`: two-to-five categorical axes with weighted ribbons, deterministic category ordering and density guardrails.
- `chord`: circular relationship matrix with weighted ribbons, node arcs, direct labels, density limits.
- `process_schematic`: acyclic process graph with stages, arrows, optional quantitative weights, annotations, and responsive vertical mobile composition.
- Add lint rules for coordinate ranges, missing endpoints, negative weights, category cardinality, relationship density, process cycles, and complexity budgets.

## Gate 3 — Editorial QA and real-data fixtures

- Add desktop/mobile snapshots for all new forms.
- Add paired positive/negative semantic smoke tests.
- Add at least one real spatial-flow fixture and one real categorical-flow fixture.
- Rasterize outputs and perform manual visual inspection for clipping, collisions, directionality, and mobile readability.
- Extend critic with topology-specific editorial warnings.

## Gate 4 — Performance + regression

- Preserve the v0.8 legacy and complex test suites.
- Add a spatial/explanatory benchmark covering lint + desktop + mobile + dual critic.
- Budget: <= 22 ms p95 for new complex forms in this environment.
- Run the full smoke suite and record release baseline.

## Explicit non-goals for v0.9

- Photorealistic illustration generation.
- Geographic polygon joins or tile-server dependencies inside the deterministic renderer.
- Force-directed graph physics.
- 3D visualization.
- Automatically imitating any publisher's proprietary style.

## Completion record

All four gates passed in the final unified smoke. v0.9 adds four renderer families and three data topologies while retaining the previous 17 rendered forms. Real-data regressions use EIA 2024 U.S. crude-oil import flows for geographic flow and the R `datasets::Titanic` contingency table for categorical parallel sets. The deterministic renderer intentionally remains schematic for geography because polygon/tile geometry is outside this release.

Final local performance: legacy statistical pipeline p95 0.411 ms; v0.8 complex pipeline p95 0.793 ms; v0.9 spatial/explanatory pipeline p95 0.399 ms; 41-computation artifact verifier p95 7.134 ms. Full smoke elapsed 19.30 seconds.
