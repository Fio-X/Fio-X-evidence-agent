# v1.6 Completion Audit

## Executive assessment

v1.6 closes the largest factual gap left by v1.5 cartographic flow: movement geometry can now be treated as time-indexed observed evidence rather than only an origin-destination relationship or pre-supplied route line. The release adds an observed-trajectory contract, explicit source-gap preservation, data-fitted map extents, a locator inset, separately labeled geodesic reference geometry and a shared-axis altitude/speed profile. The existing evidence graph, NewsroomVizSpec, SceneGraph, Infographic Composer and independent verifier remain authoritative.

The strongest result is the public ADS-B DAL1812 regression. The same observation record drives an observed route, a 48.12-minute source gap, a geometric reference, altitude and ground-speed state, and a desktop/mobile magazine feature. The strongest negative result is the public Syros AIS regression: exact local trajectory coordinates can be rendered, but the bundled 1:110m Natural Earth substrate is too coarse to explain harbour-scale geography. That failure is now a deterministic `basemap_detail_mismatch` signal rather than a hidden visual weakness.

This release is a deterministic engineering and real-data visual-validation baseline. It does not qualify production-scale ADS-B/AIS ingestion, authoritative local port/airport cartography, real pipeline geometry, browser interaction, real multimodal providers or qualified human preference.

## Implemented

### Observed trajectory semantics

`runtime/pi/cartography.mjs` adds canonical time-indexed trajectory points with longitude, latitude, elapsed time and explicit segment IDs. Monotonic time is validated and segment changes are preserved as gaps. `runtime/pi/viz.mjs` accepts `trajectory_points_field`, `extent_mode`, `extent_padding_ratio`, optional `great_circle` reference geometry and locator insets. The reference path is visually and semantically distinct from observed geometry.

NewsroomVizSpec advances to 1.1.0. The v1.5 route semantics remain compatible, while observed trajectories may now use canonical point records instead of a single route geometry plus auxiliary time field. Route provenance remains mandatory.

### Linked flight-state graphic

The new `trajectory_profile` view places altitude and ground speed on two aligned panels sharing one elapsed-time axis. Segment gaps remain gaps in both panels. The elapsed-time axis is explicitly zero-anchored after pixel QA caught an initial negative padded tick. This prevents a display artifact from implying observation before the source trace begins.

### Real ADS-B magazine feature

The flagship regression uses selected exact positions from the public `xoolive/traffic` readsb sample for DAL1812 / N899DN. The fixture records upstream source SHA and transformations. The page explicitly states that source coverage begins mid-flight, preserves the roughly 48-minute observation gap and does not call the dashed geodesic a filed ATC route.

The final page combines the route map, 4.0-hour observed duration, missing-data sidecar, shared altitude/speed profile and methods/provenance. Desktop raster is 1440 x 3105, mobile is 720 x 3820 and the deterministic page critic scores 95/100. The individual cartographic map critic scores 100/100 on desktop/mobile.

### Real AIS local-scale diagnostic

The Syros fixture uses selected exact rows from the public vesseltrack-tools testing data, documented upstream as decoded historical AIS based on real vessel movement around Syros. At an extent below one degree the 1:110m basemap does not contain sufficient coastline, harbour, channel, berth or quay detail. The critic emits `basemap_detail_mismatch` and scores the diagnostic 86 rather than falsely treating coordinate correctness as publication readiness.

This test changes the next investment decision: a newsroom-grade movement stack needs a provenance-bound multiscale basemap registry and domain layers before more line styling.

## Gap diagnosis after real trajectories

For movement graphics specifically, the remaining gap is estimated at roughly 55% tooling/data infrastructure, 25% reporting/editorial context and 20% visual craft/human art direction. This is a strategic product estimate, not a measured competition score.

Highest tooling gaps are multiscale 110m/50m/10m/local cartography, high-volume trajectory ingestion and cleaning, scale-dependent feature generalization, dense-flow clustering/bundling, real network-constrained geometry, and linked browser map/profile/time interaction. Highest reporting gaps are domain layers and causal evidence such as airspace, waypoints, weather, ports, channels, bathymetry, pipeline status and contemporaneous restrictions. The remaining art-direction gap is integrating those layers into a singular authored visual premise rather than presenting them as adjacent modules.

## Integrity and performance

The canonical v1.6 smoke was run against the final code tree in four ordered segments because the execution container has a short single-process limit. All segments exit zero. Existing evidence remains green: competition evaluator 24/24, legacy integrity adversaries 16/16 rejected and v1.4 editorial adversaries 4/4 rejected.

Final steady-state p95 results include ordinary artifact verifier 7.112 ms, 41-computation scale verifier 9.863 ms, editorial verifier 8.217 ms, ordinary responsive visualization 0.467 ms, complex visualization 0.471 ms, spatial/explanatory visualization 0.327 ms, v1.5 cartographic flow 3.939 ms, v1.6 observed-trajectory desktop/mobile bundle 7.923 ms, trajectory profile 0.239 ms, semantic explainer 0.204 ms, Infographic Composer 0.766 ms, semantic novelty 2.518 ms and 12-element SceneGraph composition 0.663 ms. All release budgets pass.

## Remaining external gates

- Production-scale OpenSky/ADS-B ingestion, cleaning, segmentation and simplification.
- Production-scale AIS voyage ingestion, density surfaces, clustering and bundling.
- Provenance-bound 1:10m/local port, airport and infrastructure cartography.
- Real EIA/DOT pipeline polyline ingestion and network-constrained magazine qualification.
- Airspace/weather/waypoint and port/channel/bathymetry contextual layers.
- Browser-linked pan/zoom, brushing, timeline playback or scrollytelling.
- Real Rust/Pi/DuckDB multimodal-provider qualification.
- Qualified-human preference evidence for award-mode art direction.

## Go / no-go

- deterministic v1.6 trajectory-cartography engineering release: **GO**;
- real-data ADS-B observed-trajectory demonstration: **GO with partial-coverage disclosure**;
- AIS local-scale diagnostic: **GO as a diagnostic, NO-GO as harbour publication cartography**;
- claim production-scale ADS-B/AIS ingestion: **NO-GO**;
- claim real network-constrained pipeline qualification: **NO-GO**;
- claim autonomous SCMP/Shipmap-level movement journalism: **NO-GO**.
