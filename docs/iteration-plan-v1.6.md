# v1.6 Iteration Plan: Real Trajectory and Movement-Graphics Hardening

## Objective

Move the v1.5 Cartographic Flow Engine from origin-destination and route-contract qualification into observed, time-indexed movement graphics. Use real public ADS-B and AIS samples to expose the next production gaps rather than hiding them with synthetic fixtures.

## Milestone A — observed trajectory contract — COMPLETE

- canonical trajectory points with longitude, latitude, elapsed time and explicit segment ID;
- time monotonicity validation;
- observed path split across source-data gaps;
- data-fitted map extent;
- locator inset;
- optional great-circle reference with separate visual semantics;
- trajectory coverage/resume/end markers;
- NewsroomVizSpec 1.1 compatibility while retaining 1.0 v1.5 specs.

Acceptance: no missing segment may be joined by a solid observed line; reference geometry must remain visually and semantically separate.

## Milestone B — linked flight-state graphic — COMPLETE

Add `trajectory_profile` so altitude and ground speed share one elapsed-time axis and the same gap segmentation as the map. Explicitly zero-anchor the elapsed-time axis to avoid misleading negative padded time.

Acceptance: the 48-minute upstream gap is visible in map and profile; altitude/speed never interpolate across it.

## Milestone C — real ADS-B magazine feature — COMPLETE

Use the public `xoolive/traffic` readsb DAL1812 sample and selected exact positions to create a SceneGraph magazine feature. The page must disclose partial coverage and must not call the dashed geodesic a filed route.

Acceptance: desktop and mobile raster smoke; page critic passes; exact route provenance visible; no complete-flight claim.

## Milestone D — real AIS local-scale stress test — COMPLETE

Use selected exact AIS rows from the public Syros vesseltrack-tools testing dataset. Fit the trajectory to the map extent and deliberately evaluate the 1:110m geographic substrate.

Acceptance: trajectory geometry is visible; the critic emits `basemap_detail_mismatch`; the output explicitly disclaims berth/quay/channel/local-coastline interpretation.

## Milestone E — regression and performance hardening — COMPLETE

- add exact raster smoke for flight map, magazine feature and AIS diagnostic;
- add v1.6 schema/runtime markers;
- add trajectory cartography/profile microbenchmarks;
- preserve all v1.5 cartographic regressions.

Focused pre-release p95: observed trajectory bundle ~7.3 ms under a 10 ms budget; trajectory profile ~0.22 ms under a 5 ms budget. Final values are recorded after the complete smoke run.

## Milestone F — production movement data — EXTERNAL / NEXT

Not claimed in v1.6:

- raw high-volume OpenSky/ADS-B ingestion;
- full AIS voyage ingestion and density/route clustering;
- 1:10m/local port or airport GIS publication substrate;
- U.S. EIA/DOT pipeline polyline ingestion and network-constrained magazine feature;
- airspace/weather/waypoint or port/channel/bathymetry contextual layers;
- browser-linked map/profile interaction and timeline playback.

These are intentionally kept outside the release claim until real data and provenance are available.
