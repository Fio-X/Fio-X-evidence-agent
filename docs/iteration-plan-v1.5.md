# Iteration Plan v1.5

## Theme

**Cartographic Flow Engine**

v1.5 targets the largest remaining production-tool gap exposed by the SCMP / Delayed Gratification comparison: evidence-grounded geographic movement. The existing `geo_flow_map` stays as an explicitly schematic compatibility path. A new `cartographic_flow_map` carries real basemap geometry, projection metadata, route semantics, route provenance and bounded density policy into NewsroomVizSpec.

The architectural rule remains unchanged: one evidence graph, one visualization runtime and one Infographic Composer. Cartography is a visualization adapter feeding the existing SceneGraph, not a second page engine.

## Execution status

Milestones A-E are complete as a deterministic engineering baseline. NewsroomVizSpec advances to 1.0.0. The release implements typed movement semantics, EPSG:4326 geometry binding, Natural Earth 1 projection, provenance-bound Natural Earth Admin 0 geometry, abstract-OD route optimization, great-circle reference paths, supplied route/trajectory/network geometry lanes, density fail-closed rules, real EIA and World Bank regressions, raster QA and SceneGraph magazine integration.

Milestone F remains an external data/runtime qualification: the `observed_trajectory` contract is implemented and requires temporal metadata, but this repository does not claim a full-scale OpenSky ADS-B or NOAA AIS production ingestion benchmark. OpenSky publishes state-vector and trajectory datasets and NOAA publishes large AIS archives; those operational workloads need a separate data-acquisition/cache benchmark rather than being silently simulated.

## Product objective

A cartographic flow visualization must make a reader able to distinguish the factual meaning of a line before interpreting its shape. The minimum supported semantic classes are:

- `abstract_od`: a statistical origin-destination relationship. Geometry is editorial routing and has no physical-path claim.
- `great_circle_reference`: a geodesic baseline between coordinate anchors. It is not a filed or observed route.
- `verified_route`: a sourced route geometry representing a published route/path.
- `observed_trajectory`: a sourced observed path with temporal metadata.
- `network_constrained`: a sourced or deterministically derived path constrained to a real network.

No route may inherit stronger physical meaning merely because it is drawn over a geographic basemap.

## Milestone A: route-semantics and provenance contract

### Deliverables

- NewsroomVizSpec 1.0.0 `cartographic_flow_map`.
- `geometry_semantics` enum above.
- explicit `geometry_crs`, projection and basemap provenance.
- `route_geometry_field`, `route_provenance_note`, optional per-row provenance field and `time_field`.
- schema, runtime, Rust materializer and Pi tool contract alignment.

### Acceptance criteria

- `geometry_crs` is `EPSG:4326` for v1.5.
- observed trajectories require route geometry, route provenance and `time_field`.
- verified/network route semantics require route geometry and provenance.
- abstract OD and great-circle paths require verified coordinate fields.
- mutated basemap hash fails closed.

**Status: COMPLETE.**

## Milestone B: publisher-grade static cartographic substrate

### Deliverables

- content-addressed 1:110m Natural Earth Admin 0 GeoJSON bundled in the controlled runtime;
- deterministic Natural Earth 1 projection plus equirectangular fallback;
- dateline-aware projected paths;
- direction key, width encoding, direct labels and mandatory semantics disclosure;
- projection regression that checks center, east-west symmetry and world coverage.

### Acceptance criteria

- basemap bytes are hash-bound to the spec;
- source URL and public-domain license metadata are required;
- world geometry is centered and symmetric under Natural Earth 1;
- desktop/mobile rasterization succeeds without map clipping.

**Status: COMPLETE.** A raster regression caught and fixed an incorrect Natural Earth 1 x-polynomial term that compressed the world into the left side of the frame.

## Milestone C: bounded flow routing and density policy

### Deliverables

- width encoding by quantitative value;
- fixed-size direction markers;
- bounded quadratic-Bezier candidate search for `abstract_od`;
- great-circle interpolation for `great_circle_reference`;
- direct rendering of supplied route geometry for physical/observed/network semantics;
- `none` and `top_n` aggregation policies;
- route density warning/blocker thresholds.

### Acceptance criteria

- unaggregated maps above 80 routes fail closed;
- `top_n <= 80` can recover a dense fixture;
- source/destination labels and route-value labels avoid obvious short-route collisions in regression pages;
- line semantics are visible in SVG metadata and reader-facing disclosure.

**Status: COMPLETE.**

## Milestone D: authoritative real-data regressions

### EIA crude imports

Use the existing U.S. Energy Information Administration 2024 selected crude-oil import fixture as `abstract_od`. The map communicates supplier-to-U.S. quantitative relationships and explicitly states that the arcs do not encode tanker or pipeline routes.

### World Bank remittances

Add a World Bank 2021 bilateral-remittance corridor fixture for four large corridors. Representative country anchors are disclosed as cartographic anchors. Arcs communicate bilateral remittance relationships and explicitly do not claim money-transfer infrastructure paths.

### Geometry-semantics contract

Keep small deterministic fixtures for `verified_route`, `observed_trajectory`, `network_constrained` and `great_circle_reference` so route-policy regressions do not depend on large external datasets. These fixtures are labeled illustrative and cannot be presented as real routes.

### Acceptance criteria

- EIA and World Bank desktop/mobile maps pass lint and critic;
- no real-data OD map implies a physical route;
- physical-route contract cases cannot render without geometry provenance;
- observed trajectory cannot render without temporal metadata.

**Status: COMPLETE for real OD and structural route semantics. Full real trajectory qualification remains external.**

## Milestone E: SceneGraph magazine integration

### Goal

Prove cartographic flow is an editorial primitive, not a standalone demo.

### Deliverables

- EIA magazine feature with cartographic import map as the hero spatial scaffold;
- sidecar explanation of Canada and route semantics;
- domestic U.S. energy Sankey as the second explanatory dimension;
- desktop/mobile raster QA.

### Acceptance criteria

- the hero map and sidecars share one SceneGraph;
- source and route-semantics disclosure remain legible;
- map-to-Sankey transition adds a different explanatory dimension rather than repeating the same ranking;
- page critic passes on both desktop and mobile.

**Status: COMPLETE.** Desktop is 1440 x 2788, mobile is 720 x 3430, deterministic page critic is 95/100.

## Milestone F: observed-movement operational qualification

### Next external benchmarks

1. OpenSky ADS-B observed aircraft trajectories, with timestamped positions and trajectory IDs.
2. NOAA Marine Cadastre AIS vessel trajectories, with MMSI/time/lat/lon and vessel-class metadata.
3. A published pipeline or transport-network route dataset for `network_constrained` geometry.
4. A migration OD matrix with explicit stock-vs-flow measurement semantics.
5. A trade OD matrix at enough density to exercise clustering beyond `top_n`.

### Required future capabilities

- streaming/chunked ingestion and trajectory simplification;
- temporal windowing and progressive aggregation;
- route bundling/clustering for hundreds or thousands of flows;
- 1:50m/1:10m and thematic GIS layers when the story requires local detail;
- browser multiscale interaction only after static semantics and provenance are proven.

### Release rule

v1.5 may claim deterministic cartographic-flow engineering readiness and real OD map readiness. It may not claim production-qualified AIS/ADS-B trajectory storytelling until a real observed dataset is retained as release evidence.

## Smoke and performance strategy

Every milestone runs a focused smoke before proceeding. The release smoke contains schema/runtime checks, old spatial regressions, v1.5 cartographic regressions, magazine raster smoke, competition/integrity suites, SQL recomputation and performance benchmarks. Because the execution container has a 120-second per-call limit, the canonical smoke output is retained as ordered functional and performance segments rather than misclassifying executor timeout as a test failure.

New cartographic rendering has an 8 ms p95 budget on the six-route EIA workload. Existing verifier, visualization, composer and editorial budgets remain unchanged.

## Explicit non-goals

v1.5 does not add a second page engine, a generic WebGL globe, unrestricted freeform route drawing, invented physical routes, automatic political-boundary truth, or a browser interaction framework. Those investments only become justified after real observed-trajectory workloads demonstrate a need.
