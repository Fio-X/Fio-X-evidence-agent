# Cartographic Flow Design and Research v1.5

## Core design decision

A line on a map is a factual claim about movement semantics. v1.5 therefore separates statistical relationships from physical routes at the schema level. `abstract_od`, `great_circle_reference`, `verified_route`, `observed_trajectory` and `network_constrained` use different rendering/provenance rules and different reader disclosures.

The old `geo_flow_map` remains a schematic form. `cartographic_flow_map` is the new provenance-aware static cartographic lane.

## Cartographic substrate

The runtime bundles a content-addressed low-resolution Natural Earth Admin 0 polygon file and uses Natural Earth 1 as the default static world projection. The local geometry bytes are bound by SHA-256. Current Natural Earth upstream lists the 1:110m Admin 0 Countries theme as version 5.1.1, but the checked-in fixture is not retroactively labeled with an upstream release number that cannot be proven from its exact local bytes.

Primary sources:

- Natural Earth 1:110m cultural vectors: https://www.naturalearthdata.com/downloads/110m-cultural-vectors/
- Natural Earth Admin 0 Countries: https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/
- Natural Earth terms: https://www.naturalearthdata.com/about/terms-of-use/

Natural Earth uses de-facto boundary representation by default and documents point-of-view variants. A publisher should therefore treat political-boundary policy as an editorial configuration when a story enters disputed-territory detail.

## Flow-layout principles

Professional origin-destination flow-map research supports several defaults used here: curve routes when that improves separation, encode quantity with line width, make direction unambiguous, minimize line-line and line-node overlap, avoid sharp bends and acute crossings, and distribute flows cleanly around nodes. The v1.5 optimizer is deliberately bounded and dependency-light; it searches a small set of quadratic-Bezier candidates rather than claiming the full quality of a dedicated force-directed cartographic layout system.

Research references:

- Bernhard Jenny et al., "Design principles for origin-destination flow maps," Cartography and Geographic Information Science.
- Bernhard Jenny et al., force-directed flow-map layout work using quadratic Bézier curves to reduce flow/flow and flow/node overlap.

## Real-data semantics

### EIA crude imports

The EIA regression uses selected 2024 crude-oil import quantities. Country anchors locate statistical origins. The arcs are `abstract_od`: they describe supplier-to-U.S. relationships and do not represent tanker voyages or pipelines.

Source family: https://www.eia.gov/petroleum/data.php#imports

### World Bank remittance corridors

The World Bank regression uses published 2021 bilateral-remittance corridor estimates including U.S.-Mexico, UAE-India, Saudi Arabia-India and U.S.-India. Representative capital coordinates are used only as cartographic anchors. The money-flow arcs are statistical bilateral relationships.

Source: https://blogs.worldbank.org/en/peoplemove/bilateral-remittance-matrix-new

## Observed trajectories

OpenSky publishes scientific air-traffic datasets with timestamped state vectors containing latitude/longitude, velocity, heading and aircraft identifiers, as well as cleaned trajectory datasets. These are appropriate future `observed_trajectory` inputs. v1.5 requires temporal metadata for that semantic class so a static LineString alone cannot silently acquire an observed-motion claim.

Source: https://opensky-network.org/data/scientific

NOAA Marine Cadastre publishes historical AIS vessel traffic data with vessel position/time fields suitable for a future ship-trajectory benchmark. This workload is intentionally left outside the release package because production archives are large and need an explicit acquisition/cache/simplification strategy rather than a tiny synthetic substitute.

Source: https://marinecadastre.gov/ais/

## Architectural consequence

Cartographic flow remains below SceneGraph. A magazine page can use a flow map as a shared spatial scaffold and attach statistics, method notes, inset diagrams or Sankey views without duplicating source truth. Browser/WebGL execution can be added later as another rendering target when a story needs time animation, zoom-dependent aggregation or route exploration.

## Known limitations

- only Natural Earth 1 and equirectangular projections are exposed;
- bundled basemap is 1:110m and unsuitable for detailed local geography;
- density handling stops at `top_n`; no hierarchical clustering or edge bundling yet;
- no automatic road/rail/shipping-lane routing;
- no large AIS/ADS-B ingestion benchmark in the release artifact;
- static rendering has no time animation;
- political-boundary point-of-view policy is not yet a first-class profile;
- supplied physical route geometry is trusted only after provenance/lint; the engine does not independently reconstruct route truth.
