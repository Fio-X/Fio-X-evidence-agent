# v1.9 Test Report

Release: `1.9.0-rc2`

## Browser publication fixtures

### EIA conserved energy flow

Input: bundled EIA 2024 aggregate energy-flow regression data.

Model gate:

- `U.S. primary energy`: incoming 94.2, outgoing 94.2, residual 0
- `End-use sectors`: incoming 74.9, outgoing 74.9, residual 0
- tolerance: `1e-9`

Publication:

- engine: local Plotly.js 3.3.1
- initial HTML: approximately 4.85 MB
- breakpoints: 390, 768, 1024, 1440 px
- browser QA: PASS at all four widths
- external requests: 0
- replay: `focus-losses -> state=losses`
- archival fallback: PNG from the widest qualified viewport

### Dandelion network

NetworkX result:

- version: 3.6.1
- nodes: 49
- edges: 48
- density: 0.0408163265
- connected components: 1
- detected Louvain communities: 7
- layout: deterministic `radial_tree`
- core node position: `[0, 0]`

Publication:

- renderer: browser-native Canvas using the NetworkX artifact
- initial HTML: approximately 22 KB
- breakpoints: 390, 768, 1024, 1440 px
- browser QA: PASS
- external requests: 0
- replay: reset focus PASS

### Coordinated Plotly views

- deterministic observations: 800
- modules: point distribution + summary bar view + context statistic
- linked control updates both the initiating plot and target summary view
- replay verifies target title `Linked view: Cluster A context`
- breakpoints: 390, 768, 1024, 1440 px
- browser QA: PASS
- external requests: 0

### WebGL expected failure

A dedicated scattergl fixture is rendered on the same host. Chromium exposes no WebGL context. QA detects the Plotly warning and fails with:

- `webgl_unavailable:390`
- `webgl_unavailable:1024`

Expected process status: 2. Result: PASS for the fail-closed test. `plotly_webgl` is absent from the active `viz-browser` capability list.

## Advanced-engine contracts

D3 scene compiler PASS for 8 types:

`radial_network`, `radial_hierarchy`, `circle_packing`, `sankey`, `chord`, `edge_bundle`, `beeswarm`, `parallel_coordinates`.

Plotly scene compiler PASS for 9 types:

`statistical`, `sankey`, `scattergl`, `parallel_coordinates`, `sunburst`, `treemap`, `icicle`, `surface3d`, `network`.

Compiler support is distinct from executable host qualification. A D3 radial-network fixture is deliberately rendered without a D3 runtime and browser QA fails with `blocked_modules:390:d3-probe` and `blocked_modules:1024:d3-probe`. Plotly scattergl is compiled but GPU execution is not marked available.

## Runtime health

`viz-browser`: AVAILABLE.

Qualified probes:

- Python 3.13.5
- NetworkX 3.6.1
- Plotly 6.5.2
- Playwright 1.57.0
- Chromium 144.0.7559.96

`viz-web`: UNAVAILABLE.

Observed blockers include Node 22.16.0 below the 22.19.0 pin and missing local `d3`, Sigma/Graphology, MapLibre/deck.gl, ECharts and plotly.js Node packages.

`viz-python`: AVAILABLE with the existing qualified static publication stack.

Cargo: unavailable. DuckDB CLI: unavailable.

## Regression results

PASS:

- editorial semantics adversarial v1.7: 20 semantic cases, 7 grammar cases, 6 backend matrices
- cold-story editorial semantics v1.7
- visual synthesis v1.8 and runtime visual synthesis
- StoryGraph schema and InfographicSpec schema
- infographic composer
- backend router and backend executor
- graph backend and graph extraction
- ECharts editorial/runtime contract
- GIS router and Python GIS publication backend
- publication schema v0.1
- ModelSpec schema v0.1 and conserved-flow PASS/BLOCK gate
- capability registry v0.1
- advanced v1.9 router
- browser qualification fixtures described above

The full visual smoke command hit the host execution timeout after `web runtime contract v1.20 PASS`. Execution resumed from `adjacency backend v1.20`; every remaining legacy test completed successfully. Browser QA runs were then executed separately because launching multiple Chromium sessions in the same bounded command exceeded the host budget.

## Release verdict

`1.9.0-rc2` qualifies the browser publication contract, local Plotly Sankey/interactive SVG path, linked controls, deterministic NetworkX analytics and fail-closed browser QA on this host. It does not claim executable D3/Sigma, WebGL, Gephi Toolkit, RAWGraphs or Flourish qualification. Final promotion still depends on the live Pi/DuckDB environment, broader same-day cold-story coverage and human review.


## RC2 cold advanced-topology addendum

Four real/recent stories were routed and rendered as advanced browser visuals: an AP AI-selloff radial hierarchy, BLS CPI hierarchy treemap, Saudi oil route/chokepoint network after a mixed-unit Sankey was blocked, and an Enbridge/Tallgrass ownership/asset hierarchy. All four pass Chromium QA at 390, 768, 1024 and 1440 px with zero external requests, zero Plotly text clipping and zero scatter-label overlaps.

The batch exposed and fixed four release-relevant defects: Plotly treemap/radial capability under-reporting, presentation requirements incorrectly applied to the NetworkX analysis stage, conserved-flow models accepting mixed units before residual checks, and browser QA missing label-on-label collisions. A negative Plotly label-collision fixture now fails closed as expected. See `docs/cold-advanced-topology-qualification-v1.9.md`.
