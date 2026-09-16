# GIS / Python / R / AI Visual Compiler Strategy

## Executive decision

The newsroom should stop expanding a home-grown cartographic renderer as the default production path. The system's proprietary value is evidence semantics, provenance, editorial reasoning, validation, reproducible recipes, and art-direction orchestration. Projection, geometry predicates, spatial I/O, high-density rasterization, cartographic label placement, vector-tile rendering, and publication map layout already have mature specialist engines.

The target architecture is therefore an **AI visual compiler**. An AI model produces a typed visual recipe and editorial intent. Mature GIS/scientific engines compute data-bearing geometry. Deterministic renderers create SVG/PDF/PNG/HTML. A screenshot QA loop can ask the AI to critique rendered output and modify parameters or recipe structure, but the model does not fabricate coordinates or quantitative marks in pixels.

For static editorial cartography, the primary production paths should be:

- Python: GeoPandas + Shapely/GEOS + pyproj/PROJ + Pyogrio/GDAL, followed by PyGMT or Matplotlib for composition.
- R: sf + ggplot2/tmap/mapsf, with ggrepel/mapsf for labels and sfnetworks/ggraph for spatial networks.
- QGIS: difficult labels, rule-based styling, cartographic finishing, and print layouts.
- Datashader: hundreds of thousands to millions of points/segments and trajectory density.
- MapLibre + deck.gl: vector-tiled, high-volume interactive maps and animated trips.
- Quarto: reproducible narrative packaging when the deliverable is a report or article rather than the newsroom's own web shell.

Generative image models can participate in illustration layers, textures, concept exploration, and non-quantitative explanatory art. They should not own data-bearing geometry, geographic boundaries, axes, scales, route positions, or numeric labels.

## Why the legacy custom SVG path hits a ceiling

The legacy renderer combines several responsibilities that professional GIS stacks deliberately separate: geographic data acquisition, CRS/projection, spatial clipping, line construction, label placement, page composition, and SVG serialization. Each custom implementation creates another place where geographic scale, geodesic distance, topology, antimeridian behavior, label collision, or generalization can silently fail.

This is visible in the Syros case. The older renderer could pass the internal critic while still displaying a coarse shoreline because the critic was testing the existence and provenance of a basemap, not whether the source geometry was detailed enough to explain the harbor. The upstream AIS repository already ships a much denser `syros.json` geometry for its study area. Its own workflow uses GeoPandas, pyproj, Shapely and GIS CRS handling for land masking, density grids, filtering and trajectory processing. Reusing that asset and toolchain is a more faithful implementation of the source project than inventing another local coastline abstraction.

The rule for v1.15+ is simple: **semantic geometry remains ours; cartographic geometry is delegated**.

## Community patterns worth adopting directly

### Python spatial core

GeoPandas now defaults to Pyogrio for file I/O. Its documentation recommends `use_arrow=True` when PyArrow is available and reports roughly 2–4× faster I/O; the migration guide notes that bulk Pyogrio operations can show speedups above 5–20× in many cases. This is a strong reason to use GeoPackage/GeoParquet/FlatGeobuf through GDAL/Pyogrio as the canonical exchange layer instead of parsing large GeoJSON blobs in Node.

Shapely/GEOS should own clipping, buffering, intersection, validity repair, simplification, spatial predicates and line/polygon operations. pyproj/PROJ should own CRS transformation. The newsroom should never calculate local metric scale from raw longitude and latitude when an established projected CRS is available.

### Publication cartography with PyGMT

PyGMT wraps Generic Mapping Tools, which is designed around spatial processing and publication-quality static maps. GMT uses a vector/PostScript-oriented pipeline and can export publication formats such as PDF, PNG and JPG. PyGMT integrates with NumPy, pandas, xarray and GeoPandas. It is a better candidate than hand-authored SVG for terrain, gridding, masking, contours, scientific/geophysical maps, and precise publication maps.

### Massive trajectories with Datashader

Datashader's core abstraction is rasterization/aggregation rather than drawing one DOM/SVG object per record. Its trajectory documentation demonstrates plotting a one-million-point trajectory without downsampling, and the project states that billion-point data can be aggregated rapidly on commodity hardware. This should replace any attempt to emit hundreds of thousands of SVG paths. The rasterized density field can then be composited under vector annotations and labels.

### QGIS for the last cartographic mile

QGIS already has a mature smart-labeling system with placement, masks, buffers, callouts, priority and obstacles. Its Print Layout can export SVG, PDF and images and can compose maps, legends, scale bars, north arrows, tables, charts, elevation profiles and atlases. For static maps with dozens or hundreds of labels, a QGIS template controlled by parameters is a stronger production backend than a new newsroom-specific label solver.

The right automation model is to maintain reviewed QGIS projects/QML styles/layout templates and let the AI populate layers, data-defined style fields, titles, annotations and viewport parameters. The AI should not generate an entire QGIS project from scratch each time.

### R as a first-class static editorial backend

The R spatial ecosystem is especially strong for publication graphics because its grammar-based APIs are compact and style systems are easy to package.

`sf` provides the canonical spatial data frame and binds GDAL for I/O, GEOS for projected geometry, s2 for spherical geometry and PROJ for CRS transformation. `tmap` provides a layered grammar specifically for thematic maps. `mapsf` has publication-oriented cartographic primitives, including graduated links, non-overlapping labels, leader lines, halos, scale bars, arrows and credits. `ggrepel` is useful for general chart labels. `sfnetworks` and `ggraph` cover geospatial graph/network operations and edge bundling; ggraph's own documentation warns that global force-directed bundling can join unrelated edges, which is exactly the kind of semantic caveat the newsroom needs to preserve.

The BBC Visual and Data Journalism team's `bbplot`/R cookbook is a particularly relevant operational pattern. Their style and export logic is encoded into reusable functions so reporters can generate publication-ready charts reproducibly instead of restyling each chart by hand. We should build the same pattern: `adn_theme()`, `adn_map_theme()`, `adn_finalise_plot()`, and a small library of reviewed editorial recipes.

`rayshader` should be used selectively for terrain where elevation and physical relief are part of the explanation. Its path-traced output can be visually rich, but 3D should stay subordinate to the analytical claim.

### Interactive and very large map layers

MapLibre GL JS is a vector-tile/WebGL map renderer with symbol collision behavior and modern map interaction. deck.gl adds GPU-oriented ArcLayer, TripsLayer, MVTLayer, heatmaps, grids, H3 and other high-volume layers. MVTLayer loads only visible vector tiles, and deck.gl supports WebGL/WebGPU paths for many layers. These engines should own interactive global logistics, flight, vessel and migration layers.

The browser stack should receive already-normalized semantic data from the newsroom. It should not become the canonical computation layer.

## Which output method is best for AI?

The highest-quality approach for AI is not a single drawing library. It is a constrained compilation pipeline in which the model makes decisions at the semantic level and mature deterministic engines make geometric decisions.

| AI output approach | Geometric precision | Visual richness | Reproducibility | AI controllability | Recommended role |
| --- | --- | --- | --- | --- | --- |
| Direct generative image | Low for quantitative/spatial marks | Very high | Low | Medium | Illustration/context only |
| AI writes raw SVG coordinates | Medium | High | High | Low–medium as complexity grows | Small bespoke diagrams only |
| Declarative grammar such as ggplot/tmap/Vega | High for supported forms | Medium–high | Very high | Very high | Default charts/thematic maps |
| AI writes Python/R GIS code | Very high | High | Very high | High | Default bespoke static data graphics |
| AI fills reviewed QGIS/PyGMT templates | Very high | Very high | Very high | High | Publication maps and dense labels |
| AI routes to Datashader + vector overlays | Very high at aggregate level | High | Very high | High | Massive trajectory/density work |
| AI routes to MapLibre/deck.gl | Very high | Very high interactively | High | High | Large interactive geospatial stories |
| Typed visual compiler + specialist backends + screenshot QA | Highest overall | Highest overall | Highest overall | Highest overall | Product architecture |

There are two reasons this compiler approach is particularly suitable for AI.

First, LLMs are strongest when generating and revising structured programs with explicit semantics. A recipe such as “project to UTM 35N, clip shoreline to a 420 m buffer, encode speed by colour, disclose gaps above 30 minutes, keep labels screen-stable” provides many opportunities for schema checks and unit tests. A request such as “draw a beautiful accurate map” leaves the model with too many unobservable geometric degrees of freedom.

Second, richness can be assembled compositionally. The model can choose a main spatial substrate, an inset, a small multiple, a microchart, an annotation field, a source note, a locator, a scale bar, uncertainty marks and direct labels. Every layer can be produced by the backend best suited to it. Richness therefore grows by combining verified layers, rather than asking one renderer or one image model to improvise everything.

## Proposed AI visual compiler contract

1. **Evidence Pack**: claims, source ledger, units, time windows, raw/clean/publication geometry and uncertainty/gap information.
2. **Canonical Spatial Model**: GeoParquet/GeoPackage/Arrow or an in-memory GeoDataFrame/sf object with explicit CRS and geometry semantics.
3. **Visual Recipe**: analytical job, reading path, map family, context layers, visual encodings, annotation plan, label priority, interaction/export mode and mobile behavior.
4. **Backend Router**: Python/R/QGIS/PyGMT/Datashader/MapLibre/deck.gl selected by scale and artifact mode.
5. **Deterministic Render**: SVG/PDF for vector publication, PNG/raster only where density or imagery requires it, HTML/WebGL for interaction.
6. **Screenshot QA**: AI visually inspects the actual render and proposes recipe/parameter changes. It does not mutate evidence or geometry semantics.
7. **Art-direction patch**: optional human or AI-assisted adjustments to position, emphasis, crop and typography, replayed deterministically.
8. **Qualification**: geometry checks, source/caveat checks, visual regression, pairwise human review and mobile/export checks.

### Data-bearing-pixel rule

Any pixel/vertex/position that encodes a quantitative claim must be generated from deterministic data and geometry. Generated imagery may appear behind, around or beside the visualization only when it does not alter the apparent data value or geographic position.

This policy allows generative models to add explanatory cutaways, textures or editorial illustration without sacrificing auditability.

## Backend routing policy

Use **Python GeoPandas/Shapely/PROJ + Matplotlib** for small-to-medium bespoke static maps where labels are limited and the article needs a custom composition.

Use **R sf + ggplot2/tmap/mapsf** when the output is a static editorial graphic, the data transformations are naturally expressed in tidy workflows, or an established publication theme/recipe can do most of the visual work.

Use **QGIS** when label count, cartographic rules, masks, callouts, map furniture, mixed raster/vector layers or professional print-layout adjustments dominate the difficulty.

Use **PyGMT** when terrain, coastlines, gridding, contours, scientific rasters, projections or high-fidelity publication maps dominate.

Use **Datashader** before the publication renderer when the dataset contains hundreds of thousands or millions of points/segments and the analytical representation is density/aggregate structure.

Use **MapLibre + deck.gl** for interactive global/multiscale flows, animated trajectories, large vector-tile layers and GPU aggregation.

Use **rayshader** only when terrain/relief is evidence-bearing. Do not use 3D to decorate flat relational data.

## What we should delete or demote

The following custom capabilities should become legacy/fallback code rather than the production default:

- hand-written geographic projections for publication maps;
- general-purpose spatial clipping and topology code in Node;
- custom high-density path rendering;
- custom density-grid rasterization;
- a home-grown label engine for difficult publication cartography;
- manually maintained low-detail local coastlines when an authoritative/upstream source exists;
- a single renderer expected to cover static editorial, dense raster and interactive map workloads.

The following newsroom capabilities remain strategically valuable and should be strengthened:

- claim/provenance graph;
- geometry semantics and observed/inferred/schematic distinction;
- MovementTrack raw/clean/publication separation;
- evidence-role semantics for contextual/correlated/mechanistic/reported-causal layers;
- VisualScene/editorial composition specification;
- backend routing and capability manifests;
- deterministic art-direction patches;
- source/method ledger;
- visual regression and human comparison evidence.

## v1.15 implementation completed in this checkpoint

This repository now contains a first real external GIS lane:

- `runtime/gis/python_publication_map.py`: executable GeoPandas/Shapely/PROJ/Matplotlib publication backend.
- `runtime/gis/r_publication_map.R`: R `sf`/ggplot adapter using the same input contract; execution awaits an R runtime in the build image.
- `runtime/gis/backend_registry.mjs`: external backend capability registry and router.
- `runtime/gis/ai_visual_compiler.mjs`: typed AI-level recipe compiler. It enforces deterministic data-bearing pixels and context-only generated imagery.
- `runtime/gis/visual_recipe.schema.json`: the machine-readable recipe boundary.
- `runtime/gis/environment-gis-python.yml`: recommended conda-forge environment including GeoPandas, Shapely, PROJ, Pyogrio, PyArrow, Datashader and PyGMT/GMT.
- `runtime/gis/R-packages.txt`: recommended R spatial/editorial stack.
- `runtime/gis/assets/syros-upstream-shoreline-excerpt.geojson`: exact local coastline coordinates excerpted from the upstream AIS study geometry and bound to the upstream blob SHA.
- `scripts/test_gis_backend_v115.mjs`, `scripts/test_ai_visual_compiler_v115.mjs`, `scripts/test_python_gis_backend_v115.py`: contract and render tests.

The new Syros output is projected to EPSG:32635, uses a real 250 m scale bar, takes the detailed local shoreline from the upstream study geometry, encodes sampled speed, and explicitly renders long observation gaps as discontinuities rather than silently implying observations between samples.

The local execution environment currently contains GeoPandas 1.1.2, Shapely 2.1.2, pyproj 3.7.2, Matplotlib 3.10.8 and Pyogrio 0.12.1. It does not currently contain R, QGIS, Datashader, PyGMT or PyArrow; those adapters are therefore marked as recommended/adapter capabilities rather than falsely qualified backends.

## Next implementation sequence

### Phase A: make external GIS the default for cartographic publication

Replace the production `cartographic_flow_map` static path with a backend call that serializes the existing semantic spec to a canonical GeoPackage/GeoParquet/JSON recipe. Preserve the legacy SVG renderer as a fast fallback and regression reference. Do not translate old SVG layout algorithms into Python; use established spatial operations.

### Phase B: install and qualify PyArrow, Datashader and PyGMT/GMT

Build four scale fixtures: 10k, 100k, 1m and 10m trajectory vertices. Measure preprocess time, aggregate time, memory, raster output and zoom behavior. The result should set empirical routing thresholds rather than arbitrary mark-count constants.

### Phase C: add a QGIS template lane

Create reviewed project/style/layout templates for: global flow, regional route, local harbor, choropleth, locator/inset and dense annotation map. Automate QGIS through `qgis_process`/PyQGIS. Store QML and layout templates under version control. Treat QGIS output as a deterministic compiler backend, then allow Illustrator/Figma only as a replayable art-direction patch stage.

### Phase D: build an R editorial recipe package

Create an internal R package with `adn_theme()`, `adn_map_theme()`, `adn_source_note()`, `adn_direct_label()`, `adn_flow_map()` and `adn_finalise_plot()`. Model the operational philosophy on BBC `bbplot`: design decisions are encoded once and reused by AI and humans.

### Phase E: interactive scale path

Normalize large geographic data into Parquet/GeoParquet, generate MVT/PMTiles where appropriate, render basemap and labels in MapLibre, and use deck.gl for Trips/Arc/aggregation layers. Every interactive story must have a static SVG/PNG fallback representing the same claim.

### Phase F: benchmark richness rather than module count

Create a benchmark set of at least 30 stories across flow, route, local map, global network, density, terrain and mixed map/chart forms. Evaluate each backend on: geographic correctness, label quality, information density, visual hierarchy, source/caveat visibility, visual distinctiveness, mobile adaptation, export quality and time-to-finished-artifact. Use blinded pairwise comparisons rather than a single synthetic award score.

## Sources

1. GeoPandas, “Reading and writing files.” https://geopandas.org/en/stable/docs/user_guide/io.html
2. GeoPandas, “Migration from the Fiona to the Pyogrio read/write engine.” https://docs.geopandas.org/en/latest/docs/user_guide/fiona_to_pyogrio.html
3. PyGMT, “Overview.” https://www.pygmt.org/latest/overview.html
4. Datashader, “Trajectories.” https://datashader.org/user_guide/Trajectories.html
5. Datashader, “Introduction.” https://datashader.org/getting_started/Introduction.html
6. QGIS Documentation, “Setting a label.” https://docs.qgis.org/3.44/en/docs/user_manual/style_library/label_settings.html
7. QGIS Documentation, “Laying out the maps.” https://docs.qgis.org/testing/en/docs/user_manual/print_layout/index.html
8. R Spatial, `sf`, “Simple Features for R.” https://r-spatial.github.io/sf/
9. mapsf, “Plot labels.” https://riatelab.github.io/mapsf/reference/mf_label.html
10. mapsf, “mapsf.” https://riatelab.github.io/mapsf/articles/mapsf.html
11. tmap, “Thematic Maps.” https://r-tmap.github.io/tmap/
12. ggraph, “Bundle edges using force directed edge bundling.” https://ggraph.data-imaginist.com/reference/geom_edge_bundle_force.html
13. rayshader. https://www.rayshader.com/
14. BBC Visual and Data Journalism, “Cookbook for R graphics.” https://bbc.github.io/rcookbook/
15. MapLibre GL JS, “Vector source example / Map API.” https://maplibre.org/maplibre-gl-js/docs/
16. deck.gl, `MVTLayer`, `TripsLayer`, `ArcLayer`. https://deck.gl/docs/
17. OpenAI, `data-visualization` and `geospatial-and-cartographic-visualization` skills. https://github.com/openai/plugins/tree/main/plugins/build-web-data-visualization/skills
18. ITSLab-UAegean, `vesseltrack-tools`. https://github.com/ITSLab-UAegean/vesseltrack-tools
