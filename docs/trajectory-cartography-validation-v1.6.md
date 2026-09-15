# v1.6 Real-Trajectory Cartography Validation

## Purpose

v1.6 raises the movement-graphics workload above v1.5 origin-destination relationships. The release tests whether the newsroom can preserve the factual semantics of an observed trajectory, expose missing observation coverage, connect geography to measured flight state, and fail visibly when the geographic substrate is too coarse for the requested scale.

The release keeps v1.5 `abstract_od` maps intact. NewsroomVizSpec 1.1 adds trajectory-specific presentation primitives without weakening the existing provenance contract.

## Real public ADS-B/readsb evidence

Primary upstream source:

- Repository: `xoolive/traffic`
- File: `src/traffic/data/samples/readsb/trace_full_ac671b.json`
- Upstream Git blob SHA: `9c610eef4b979d67d5f10ac0971a172869a3a72c`
- Local source manifest: `fixtures/v16-movement/adsb-dal1812-SOURCE.json`
- Local selected exact positions: `fixtures/v16-movement/adsb-dal1812-sampled.json`
- Local profile table: `fixtures/v16-movement/adsb-dal1812-profile.csv`

The source trace identifies the flight as `DAL1812` and contains latitude, longitude, pressure altitude, ground speed, track and ADS-B metadata. The v1.6 fixture stores selected exact source positions rather than interpolating an invented route.

The local fixture begins at `2025-02-04T21:13:42Z` at 16.777359 N, 88.036868 W and ends at the last selected ground observation at `2025-02-05T01:12:26Z` near 44.880993 N, 93.218438 W. This is 238.72 minutes of observation span. It is not represented as the complete flight: the upstream trace begins mid-flight.

A genuine source-data discontinuity is preserved between the last segment-0 point at elapsed 2,155.97 seconds and the first segment-1 point at 5,043.24 seconds. The gap is 48.12 minutes. The renderer breaks the solid observed path at this point instead of drawing a connector. A separately styled dashed geodesic is allowed only as a labeled endpoint-to-endpoint geometric reference.

Within the selected source samples, pressure altitude reaches 36,000 ft and observed ground speed reaches 479 kt. The final selected ground observation records 73 kt. These values are rendered on a shared elapsed-time profile. The fixture is deliberately sparse and does not claim to be a complete high-frequency replay.

## What changed in the cartographic runtime

`runtime/pi/cartography.mjs` now supports:

- `parseTrajectoryPoints`, a canonical time-indexed trajectory-point parser;
- segment-aware `trajectoryLines` so observation gaps remain gaps;
- data-fitted geographic projection through `createProjectionForExtent`;
- minimum local projection spans small enough to expose harbour-scale failures rather than collapsing a local route into one pixel.

`runtime/pi/viz.mjs` adds or extends:

- `trajectory_points_field` for time-indexed observed positions;
- `extent_mode=world|data` and bounded extent padding;
- optional `reference_path=great_circle` for explicitly labeled geometric comparison;
- locator insets;
- automatically derived trajectory markers such as coverage start/resume, maximum observed altitude and coverage end;
- `trajectory_profile`, a two-panel altitude/speed graphic sharing the same elapsed-time axis and the same source-gap encoding;
- a zero-anchored elapsed-time domain for trajectory profiles, preventing padded negative time ticks;
- deterministic `basemap_detail_mismatch` critique when a data-fitted extent below one degree is rendered against the bundled 1:110m basemap.

The new primitives remain presentation-only. They do not infer missing trajectory coordinates or reconstruct a filed route.

## Flight magazine result

`outputs/v16-flight/dal1812-feature.png` is the primary desktop inspection surface. It combines:

1. an observed path as the SceneGraph hero;
2. explicit source coverage and a locator inset;
3. a visible 48-minute observation gap;
4. a dashed geodesic reference whose semantics are separate from the observed path;
5. observed-duration and missing-data sidecars;
6. one shared-axis altitude/ground-speed profile;
7. an explicit trajectory-provenance method block.

The current render is 1440 x 3105 desktop and 720 x 3820 mobile. The deterministic page critic scores 95/100. The individual cartographic map critic scores 100/100 on desktop/mobile, while the separate line regressions score 100 for altitude and 96 for speed.

The important improvement over v1.5 is integration: the reader no longer sees an OD arc followed by unrelated charts. Geography and measured state are two views of the same observation record.

## Real-movement AIS scale stress test

Primary upstream source:

- Repository: `ITSLab-UAegean/vesseltrack-tools`
- File: `data/testing/00_original/input_ais_sample.csv`
- Upstream Git blob SHA: `417b6779fd8c417f9e554c6a5c13a040d57a30d4`
- Repository documentation describes the sample as decoded historical AIS based on real vessel movement around Syros, Greece.
- Local selected exact positions: `fixtures/v16-movement/ais-syros-sampled.json`

The selected diagnostic covers a small local area around approximately 24.9406–24.9438 E and 37.4339–37.4386 N. The source sample is a testing dataset with sample MMSI identifiers and must not be treated as a vessel-identification record.

This is intentionally a failure-oriented cartographic test. The observed trajectory fills the plot correctly after data-fitted projection, but the bundled Natural Earth 1:110m country geometry contains too little local coastline/harbour information at this scale. The image therefore exposes a real production boundary instead of hiding it behind a high deterministic score.

The v1.6 critic reports `basemap_detail_mismatch` and lowers this case to 86/100 while still allowing the diagnostic to render. Publication at harbour scale should require a provenance-bound 1:10m/local coastline, port/quay/channel or equivalent authoritative substrate.

Natural Earth itself describes 1:110m as suitable for small schematic world maps, 1:50m for zoomed-out country/region maps, and 1:10m as its most detailed tier for zoomed-in country/region mapping. This validates the scale mismatch exposed by the AIS test.

## Performance

Dedicated steady-state microbenchmarks render both desktop and mobile variants per iteration.

- observed-trajectory cartographic bundle: p95 around 7.3 ms in the pre-release focused run, budget 10 ms;
- trajectory-profile bundle: p95 around 0.22 ms in the same focused run, budget 5 ms.

Final release values are recorded in `docs/test-report-v1.6.md` and `docs/smoke-v1.6.log` after the complete smoke suite.

## What this validation does not prove

The release does not claim:

- complete origin-to-destination coverage for DAL1812;
- a filed ATC route or airway geometry;
- causal explanations for bends in the flight path;
- weather, jet-stream or airspace attribution;
- production-scale ADS-B ingestion;
- production-scale AIS ingestion;
- vessel identity from the public test MMSI;
- harbour-scale basemap adequacy;
- real U.S. natural-gas pipeline geometry ingestion;
- linked browser interaction, animation or time scrubbing.

These are the next evidence and tooling boundaries, not hidden assumptions.
