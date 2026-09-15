# v1.10 Completion Audit

Release candidate: `1.10.0-rc1`

## Scope completed

v1.10 promotes four previously weak areas into auditable production contracts: functional style mapping, scientific spatial maps, uncertainty graphics and linked geographic views. It also makes a deliberate negative decision for large graphs: a browser renderer that can technically draw thousands of nodes does not qualify as an editorial large-network renderer when the result is an unreadable hairball.

`StyleProfile 0.2` maps editorial intent and topology to functional tokens for typography, density, annotation intensity, geometry, motion restraint, surface and interaction depth. The qualified profiles are `analytical_precision`, `systems_explainer`, `investigative_network`, `uncertainty_forecast`, `spatial_monitor` and `nature_scientific_map`. Compatibility is fail-closed. An uncertainty story requesting the investigative-network style is blocked rather than cosmetically restyled.

`MapSpec 0.1` is implemented as a provider-independent scientific spatial contract. It requires EPSG:4326 input coordinates, a qualified projection, explicit geographic extent, a provenance-bound basemap, declared task scale, scale-bar semantics and typed observation layers. Basemap adequacy is checked against task scale. The scientific profile rejects rainbow colour scales.

The first executable `nature_scientific_map` publication path uses local Natural Earth Admin0 geometry and Plotly. It produces self-contained HTML with zero external requests. A USGS observation fixture passes browser QA at 390, 768, 1024 and 1440 px with no Plotly text clipping, scatter-label collision or page overflow. A local-scale map forced onto the 1:110m basemap blocks, as does a rainbow-scale map.

`ModelSpec 0.2` adds qualified probabilistic interval semantics. Coverage and coverage meaning are first-class fields and every interval must satisfy `lower <= central <= upper`. The NHC 2026 historical forecast-error envelope passes with empirical two-thirds coverage semantics. Inverted intervals fail.

The linked geographic fixture coordinates a self-contained spatial view with a statistical view. It passes all four browser breakpoints and interaction replay with zero external requests. A narrow-screen map regression that previously produced impossible latitude ticks was corrected by constraining the Plotly coordinate domain.

## Large-network decision

The 5,000-node / 9,996-edge stress graph renders in roughly 0.24–0.27 seconds on the native Canvas path and passes technical browser QA. The resulting overview is an editorial hairball. The production compiler therefore returns `UNRESOLVED` with `final_renderer_unavailable`, and the qualification record is `FAIL_HAIRBALL_SPECIALIST_REQUIRED`.

This is intentional. Browser speed is not treated as evidence of visual usefulness. Sigma/Graphology or another specialist renderer must pass an executable, deterministic qualification before the large-network route can become READY.

Attempts to install the pinned Sigma/Graphology runtime in this host exceeded the execution budget and left no usable local runtime. `viz-web` therefore remains UNAVAILABLE. D3, Sigma/Graphology, MapLibre/deck.gl and Vega-Lite remain fail-closed on this host rather than being inferred from source-level support.

## Production-runtime closure

The v1.9/v1.10 tools are now wired through the controlled agent path rather than existing only as test utilities. The Rust tool allowlist, audit matcher and runtime materializer include:

- `newsroom_model_validate`
- `newsroom_map_validate`
- `newsroom_style_map`
- `newsroom_publication_plan`
- `newsroom_publication_render`
- `newsroom_publication_qa`
- `newsroom_network_analyze`

The Pi materialized bundle now includes StyleProfile, MapSpec, scientific-map renderer, basemap registry and browser publication dependencies. `scripts/check_runtime_contract.py` passes and verifies allowlist/audit/tool/materializer alignment.

## Browser qualification

Qualified four-width cold-load paths:

- Nature scientific map: PASS at 390 / 768 / 1024 / 1440
- uncertainty forecast: PASS at 390 / 768 / 1024 / 1440
- linked map + chart: PASS at 390 / 768 / 1024 / 1440
- native Canvas 5k network: technical PASS at all widths, editorial FAIL by design

All three production-qualified publication fixtures use self-contained HTML and make zero external HTTP requests during Chromium QA.

## Compatibility

Selected v1.7, v1.8 and v1.9 regressions are green after the v1.10 changes: editorial semantics, runtime/visual synthesis, infographic composer, capability registry, PublicationSpec, ModelSpec, advanced router, cold advanced topologies, backend router/executor and runtime contract.

The full legacy monolithic smoke is not represented as one uninterrupted pass because this host imposes a bounded command execution budget. The relevant legacy and v1.10 suites were run in segmented deterministic commands. `scripts/smoke_visual_compiler.sh` now contains the v1.10 style, MapSpec, advanced-system and four-viewport browser gates.

## Open release gates

This host still lacks Cargo and the DuckDB CLI. Node is 22.16.0 while the pinned web/Pi baseline is 22.19.0 or newer. `viz-web` also lacks executable local D3, Sigma/Graphology, MapLibre/deck.gl, Vega-Lite and related packages. Real provider/Pi execution, DuckDB recomputation, specialist large-graph qualification, richer multiscale scientific basemaps and qualified-human review remain external gates before final release.
