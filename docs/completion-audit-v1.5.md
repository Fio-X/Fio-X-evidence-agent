# v1.5 Completion Audit

## Executive assessment

v1.5 closes the first large cartographic gap identified after the SCMP / Delayed Gratification comparison. The project can now produce provenance-aware static flow maps where the factual meaning of a line is explicit and machine-checkable. The older schematic `geo_flow_map` remains available; `cartographic_flow_map` adds a real basemap, projection, route semantics, route provenance, directional marks, density policy and SceneGraph integration.

This is a deterministic static-cartography release. It is not yet a production qualification for large observed aircraft or vessel trajectories, browser multiscale interaction, route bundling at thousands of edges or high-resolution local GIS.

## Implemented

### NewsroomVizSpec 1.0 route meaning

Five geometry semantics are first-class: `abstract_od`, `great_circle_reference`, `verified_route`, `observed_trajectory` and `network_constrained`. WGS84 `EPSG:4326` is the accepted input CRS. Abstract/geodesic paths require coordinate fields; physical/network route semantics require route geometry and an explicit provenance note; observed trajectories additionally require a time field.

The renderer writes `data-geometry-semantics` into output and always adds a reader-facing disclosure. An abstract OD arc can therefore never silently acquire the meaning of an actual aircraft, vessel, pipeline or money-transfer route.

### Provenance-bound basemap and projection

`runtime/pi/cartography.mjs` and `runtime/pi/assets/naturalearth-admin0-110m.geojson` are embedded into the Rust-controlled runtime. The spec must match the expected basemap identifier, upstream URL, public-domain license label and exact SHA-256 `eb485f15dece54e2a188e65839b4a15539e4b2a58716732634253a831e085be1`.

Natural Earth 1 is the default world projection with equirectangular fallback. Raster QA found an initial Natural Earth 1 x-polynomial defect; a regression now checks center, symmetry and world coverage.

### Flow routing

`abstract_od` uses bounded quadratic-Bezier candidate search with penalties for crossings/node intrusion. `great_circle_reference` uses geodesic interpolation. `verified_route`, `observed_trajectory` and `network_constrained` project their supplied route geometry. Routes crossing the antimeridian are segmented in projected space. Quantity controls line width and direction is visually explicit.

Density remains intentionally bounded. More than 80 unaggregated routes is a blocker. `top_n` is the only v1.5 aggregation strategy; clustering and bundling remain future work.

### Real OD qualification

The existing real EIA 2024 crude-import fixture now renders through the cartographic engine. Canada remains the dominant selected source at about 4,061.8 thousand b/d. The map explicitly states that arcs encode source-to-U.S. relationships and do not represent tanker or pipeline paths.

A new World Bank fixture covers four large 2021 remittance corridors, including U.S.-Mexico, UAE-India, Saudi Arabia-India and U.S.-India. Representative capital coordinates are used only as geographic anchors, and the map explicitly rejects a physical money-route interpretation.

### Magazine SceneGraph integration

The EIA cartographic map is used as a hero spatial scaffold with a Canada sidecar and route-semantics note, followed by the existing domestic energy Sankey. The result is 1440 x 2788 desktop and 720 x 3430 mobile with page critic 95/100.

## Integrity and regression result

The final work tree passes the NewsroomVizSpec 1.0 schema, runtime materialization contract, all prior visual snapshots, EIA/World Bank cartographic regressions, cartographic raster smoke, existing explanatory/rich-illustration/image-critic paths, 24/24 competition engineering checks, 16/16 legacy integrity adversaries and 4/4 v1.4 editorial adversaries.

Cartographic negative cases reject missing route geometry/provenance, missing observed-trajectory time metadata, bad basemap hash and excessive unaggregated density.

## Performance

Cartographic flow on the six-route EIA workload records p50 3.112 ms, p95 4.105 ms and max 5.961 ms under an 8 ms p95 budget. Existing major steady-state p95 values remain healthy: ordinary verifier 7.196 ms, scale verifier 11.022 ms, editorial verifier 10.216 ms, statistical visualization 0.361 ms, complex visualization 0.597 ms, legacy spatial/process visualization 0.290 ms, Infographic Composer 0.670 ms, semantic novelty 2.337 ms and SceneGraph 0.649 ms.

## Remaining external gates

### Real observed trajectory workload

The release contract can represent observed trajectories, but the packaged physical-route examples are deliberately illustrative. OpenSky publishes timestamped ADS-B/state-vector and cleaned trajectory datasets; NOAA Marine Cadastre publishes large AIS archives. A future qualification should ingest one retained real flight and one retained real vessel trajectory, preserve source hashes/time windows, simplify geometry deterministically and compare source positions against rendered paths.

### High-density flow generalization

`top_n` prevents unreadable dense maps but cannot yet answer the publisher problem of hundreds or thousands of flows. The next cartographic algorithm investment should be clustering/aggregation and flow bundling with stable provenance back to member records.

### Local/high-resolution cartography

The 1:110m world basemap is unsuitable for street, port, airport, pipeline or local-disaster detail. High-resolution 1:50m/1:10m Natural Earth, authoritative transport networks and publisher political-boundary policy should be added only for stories that require them.

### Browser interaction

Static SVG remains sufficient for the release benchmark. Time animation, zoom-dependent aggregation and interactive route inspection belong in a future web rendering target over the same cartographic spec.

### Real provider and human award gates

The existing external gates remain unchanged. Local live readiness is false because the pinned Rust/Pi/DuckDB/Node/provider environment is unavailable. Qualified-human award preference remains a separate evidence layer.

## Go / no-go

- deterministic v1.5 cartographic engineering release: **GO**;
- real EIA / World Bank abstract-OD maps: **GO**;
- static magazine SceneGraph integration: **GO**;
- claim sourced verified/observed/network route semantics from supplied geometry: **GO when the caller supplies qualifying provenance**;
- claim full-scale real ADS-B/AIS ingestion qualification: **NO-GO**;
- claim high-density browser flow-map parity with leading interactive newsrooms: **NO-GO**;
- claim real-provider autonomous award-mode qualification: **NO-GO**.
