# v1.10 Iteration Plan: Advanced Systems, Style Mapping and Scientific Spatial Maps

Release target: `1.10.0-rc1`

## Problem

v1.9 established self-contained HTML publication and advanced browser primitives, but three high-value story topologies were still weakly qualified: uncertainty, linked geography, and large graphs. A fourth gap emerged during review: rendering engines had no explicit functional style mapping, and scientific spatial stories needed stronger cartographic semantics than a generic web map.

## P0. Functional StyleProfile mapping

Add versioned style profiles that map editorial intent and story topology to typography hierarchy, density, annotation intensity, geometry, motion restraint, surface and interaction depth. Profiles include analytical precision, systems explainer, investigative network, uncertainty forecast, spatial monitor and nature scientific map. Style compatibility is release-blocking; an incompatible requested profile cannot override semantic requirements.

Acceptance: automatic and explicit style mapping are deterministic; incompatible dimension/topology combinations BLOCK.

## P1. MapSpec 0.1

Create a provider-independent scientific spatial contract with explicit CRS, projection, extent, basemap identity/provenance, task scale, scale bar semantics, graticule and typed observation layers. Basemap adequacy must be checked against task scale. Rainbow colour scales are disallowed for the scientific profile.

Acceptance: a regional USGS fixture passes; the same 1:110m basemap fails when forced into a local task; a rainbow scale fails.

## P2. Nature scientific map publication profile

Add `nature_scientific_map` as a functional style profile inspired by scientific-figure production constraints rather than publisher trade dress. Require standard sans-serif type, restrained colour, fine line weights, editable browser text, explicit coordinates and scale semantics. The first executable path uses local Natural Earth data and Plotly without external tile requests.

Acceptance: 390/768/1024/1440 cold browser loads pass with zero external requests, no text clipping and no label overlap.

## P3. Uncertainty qualification

Extend ModelSpec to `probabilistic_interval_series`. Coverage and coverage semantics are mandatory; every row must satisfy lower <= central <= upper. Route qualified interactive uncertainty stories to a backend with interval-band support.

Acceptance: NHC 2026 operational historical-error envelope passes; an inverted interval fails.

## P4. Linked map + chart qualification

Require a single interaction state to update spatial and statistical modules together. Geographic context must be local/self-contained in qualification mode.

Acceptance: the USGS past-day sample passes at all four viewport widths with zero external requests.

## P5. Large-network editorial threshold

Separate technical rendering capacity from editorial usefulness. Native Canvas may serve as a medium-network fallback but must not qualify a 5,000-node overview merely because it renders quickly. Beyond the audited threshold the router must require a specialist final renderer.

Acceptance: the 5,000-node stress graph loads quickly but the production route is `UNRESOLVED / final_renderer_unavailable`; it is recorded as `FAIL_HAIRBALL_SPECIALIST_REQUIRED`.

## P6. Specialist runtime decision

Attempt to qualify pinned Sigma/Graphology and MapLibre/deck.gl runtimes. If the host cannot install or execute them reproducibly, retain fail-closed status. Gephi Toolkit remains a challenger until Java-side deterministic wrapper and blinded comparison exist.

## Release gate

- style registry valid
- MapSpec positive and negative tests pass
- scientific map four-viewport browser QA passes
- uncertainty and linked-geo four-viewport QA passes
- large-network technical QA may pass, but editorial status remains FAIL and routing UNRESOLVED
- v1.7 semantic, v1.8 synthesis and v1.9 browser regressions remain green
- specialist backends are only marked executable when their actual runtime is present
