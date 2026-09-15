# v1.9 Completion Audit

Release candidate: `1.9.0-rc2`

## Completed core architecture

`PublicationSpec 0.1` is implemented as a browser-delivery contract bound to an existing StoryGraph and InfographicSpec. Production planning requires `infographic_plan_ref`, `story_graph_ref`, the same reader question and the same visual thesis. Browser modules map back to StoryGraph node IDs and verified claim IDs.

The Pi extension now exposes `newsroom_publication_plan`, `newsroom_publication_render`, `newsroom_publication_qa`, `newsroom_network_analyze` and `newsroom_model_validate`. The Rust materializer embeds the publication renderer, Plotly and D3 compilers, the local Plotly.js bundle, Chromium QA script and NetworkX analytical runtime so these capabilities are part of the controlled agent runtime rather than loose test utilities.

## Qualified browser capabilities

The host-qualified `viz-browser` runtime contains Python 3.13.5, NetworkX 3.6.1, Plotly 6.5.2, Playwright 1.57.0 and Chromium 144.0.7559.96. Active capabilities are self-contained responsive HTML, browser QA, interaction replay, Plotly interaction/Sankey, linked views, and deterministic network analysis/layout/community detection.

A real EIA 2024 aggregate energy-flow fixture passes conserved-flow validation before Sankey rendering. The checked intermediate nodes each have residual zero. The resulting self-contained Sankey passes cold-load QA at 390, 768, 1024 and 1440 px with zero external requests and a replay-tested focus control.

The dandelion network fixture contains 49 nodes and 48 edges. NetworkX produces a seeded radial-tree layout, seven Louvain communities and stable metrics. Canvas publication passes the same four viewports, zero external requests and interaction replay. A mobile label collision found during pixel review was fixed by outward radial labels and a dedicated hub-label rule.

A coordinated Plotly fixture uses 800 deterministic points plus a second summary view. One structured control updates both views; browser replay verifies the target Plotly title changed to the declared linked state.

## Fail-closed evidence

The host Chromium build cannot initialize WebGL. An explicit scattergl fixture therefore produces a visible Plotly WebGL warning. Browser QA now detects that warning and returns FAIL at both tested viewports. `plotly_webgl` was removed from the active host capability set. The compiler contract remains available for future hosts that can actually qualify the GPU path.

The D3 compiler covers radial network/hierarchy, circle packing, Sankey, chord, edge bundling, beeswarm and parallel coordinates, but `viz-web` remains UNAVAILABLE here because the pinned Node baseline and D3/Sigma/ECharts packages are missing. A dedicated D3 radial-network browser fixture is expected to fail with `blocked_modules` at 390 and 1024 px, proving that an unavailable D3 runtime cannot silently substitute another renderer. The project does not claim executable D3 qualification in this RC environment.

Gephi Toolkit, selected RAWGraphs models and Flourish are recorded in `config/external-visual-adapters.json` with status `contract_only`. None are active routing candidates.

## Compatibility

v1.7 semantic adversarial, cold-story semantic, v1.8 StoryGraph/visual-synthesis, infographic composer, backend router/executor, ECharts, graph extraction, GIS and Python publication regressions continue to pass.

The monolithic visual smoke command exceeded the host execution budget after the web-runtime contract stage. Execution resumed from the exact next test. The remaining legacy tests and every new v1.9 browser test passed in segmented runs. This is recorded as an environment execution-budget limitation, not represented as one uninterrupted smoke PASS.

## Open release gates

Cargo and DuckDB are absent from this host. Node is 22.16.0 while the Pi/web pin is 22.19.0. The D3/Sigma Node packages are absent. Real provider/Pi execution, DuckDB recomputation, executable D3 qualification, 12-story live qualification and qualified-human review therefore remain open.


## RC2 cold topology evidence

The same-day advanced batch adds cold-story evidence for radial hierarchy, hierarchical treemap, route/chokepoint network and ownership/asset hierarchy, plus correct abstention from an invalid mixed-unit Sankey. Browser QA now release-blocks Plotly scatter-label overlap in addition to viewport/text clipping. Remaining cold gaps include large-graph rendering, uncertainty graphics, linked map/chart views, event-sequence/scrollytelling and causal-system publication.
