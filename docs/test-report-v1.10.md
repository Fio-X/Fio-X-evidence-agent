# v1.10 Test Report

Release: `1.10.0-rc1`

## Functional style mapping

Qualified profiles:

- `analytical_precision`
- `systems_explainer`
- `investigative_network`
- `uncertainty_forecast`
- `spatial_monitor`
- `nature_scientific_map`

The mapping is functional rather than cosmetic: profiles control font hierarchy, density, module spacing, annotation intensity, geometry, line weight, surface treatment, motion restraint, interaction depth and renderer colourway. Profile selection is checked against story dimensions and topology.

Negative test: an uncertainty/tabular story explicitly requesting `investigative_network` returns `BLOCK` with `dimension:uncertainty` and `topology:tabular` incompatibilities.

## Nature scientific spatial map

Fixture: bundled USGS observation sample plus local Natural Earth Admin0 1:110m context.

Map contract:

- CRS: EPSG:4326
- projection: equirectangular
- explicit regional extent
- provenance-bound Natural Earth basemap
- 500 km scale bar
- longitude/latitude semantics
- typed USGS observation marker
- style intent: `nature_scientific_map`

Positive gate: PASS.

Negative gates:

- forcing the 1:110m basemap into a local task scale: BLOCK
- requesting a rainbow colour scale: BLOCK

Chromium browser QA:

| Width | Status | Ready time | External requests | Text clipping | Scatter label overlaps |
| ---: | :---: | ---: | ---: | ---: | ---: |
| 390 | PASS | 1264.9 ms | 0 | 0 | 0 |
| 768 | PASS | 1249.1 ms | 0 | 0 | 0 |
| 1024 | PASS | 1335.7 ms | 0 | 0 | 0 |
| 1440 | PASS | 1256.0 ms | 0 | 0 | 0 |

## Uncertainty qualification

Fixture: NHC 2026 operational historical track-error envelope.

Model result:

- type: probabilistic interval series
- coverage: 2/3
- coverage semantics: empirical historical error
- horizons: 12, 24, 36, 48, 60, 72, 96, 120 hours
- interval unit: nautical miles
- ordering invariant: `lower <= central <= upper`

Backend: `plotly_browser`.
Style: `uncertainty_forecast`.

Chromium QA passes at all four widths with zero external requests, zero text clipping and zero scatter-label overlap. Mobile legend placement was revised during qualification so the uncertainty band retains useful plot area at 390 px.

## Linked map + chart qualification

Fixture: deterministic local USGS past-day sample with linked spatial/statistical modules.

Backend: `plotly_browser`.
Style: `spatial_monitor`.
Event count: 15.

Chromium QA passes at 390 / 768 / 1024 / 1440 with zero external requests and no Plotly text clipping or label overlap. The linked interaction replay succeeds. A qualification regression corrected the narrow-screen coordinate constraint so latitude ticks remain physically valid.

## Large-network stress qualification

Fixture:

- nodes: 5,000
- edges: 9,996
- maximum degree: 197
- analysis backend: NetworkX
- provisional renderer: native Canvas
- style: `investigative_network`

Browser readiness is fast: approximately 238–267 ms across the qualified widths. Technical browser QA passes. Visual review and the routing policy deliberately reject the overview as a production editorial rendering because it degenerates into a dense hairball.

Production result:

- compile status: `UNRESOLVED`
- unresolved reason: `final_renderer_unavailable`
- editorial verdict: `FAIL_HAIRBALL_SPECIALIST_REQUIRED`

The result is a release gate for Sigma/Graphology or an equivalently qualified specialist renderer. The project does not treat fast Canvas drawing as large-network publication readiness.

## Runtime and agent integration

`viz-browser`: AVAILABLE.

Qualified local components include Python 3.13.5, NetworkX 3.6.1, Plotly 6.5.2, Playwright 1.57.0 and Chromium 144.0.7559.96.

`viz-web`: UNAVAILABLE. Current blockers include Node 22.16.0 below the pinned 22.19.0 baseline and absent local Sigma, Graphology, MapLibre, deck.gl, D3, Vega-Lite, ECharts and plotly.js Node packages.

Cargo: unavailable.
DuckDB CLI: unavailable.

Runtime contract test: PASS. The Rust allowlist, audit tool matcher and Pi materializer agree on the v1.9/v1.10 publication/model/map/style/network tools.

## Regression results

PASS in final segmented regression:

- editorial semantics v1.7
- runtime visual synthesis v1.8
- visual synthesis v1.8, closure 100%, critic 98
- capability registry v1.9
- PublicationSpec schema
- ModelSpec schema
- advanced router v1.9
- cold advanced topologies v1.9, including mixed-unit Sankey abstention
- backend router
- backend executor
- infographic composer
- runtime contract
- StyleProfile v1.10
- MapSpec / Nature scientific map v1.10
- advanced systems v1.10
- visual skill bundle

`scripts/smoke_visual_compiler.sh` now includes the v1.10 deterministic and browser release gates. Browser-heavy qualification remains segmented in this host to stay within the bounded command budget.

## Verdict

`1.10.0-rc1` qualifies functional style mapping, scientific spatial-map semantics, self-contained Nature-style scientific mapping, probabilistic uncertainty presentation and linked map/chart publication on the current browser runtime. Large networks remain intentionally unresolved until a specialist graph renderer is executable and passes editorial qualification. Final promotion still depends on the pinned live Rust/Pi/DuckDB environment, specialist runtime qualification and human editorial review.
