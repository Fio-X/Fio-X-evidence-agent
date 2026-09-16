# v1.6 Movement Infographic Gap Analysis

## Executive judgment

The v1.6 real-trajectory tests change the diagnosis again. The project can now represent an observed movement path with explicit provenance, missing coverage, a geometric reference and time-indexed flight state. That closes a major gap between v1.5 origin-destination maps and real movement journalism. It still falls short of the strongest SCMP, National Geographic, Reuters-style and award-winning movement stories because those works combine trajectory data with a much richer geographic substrate, contextual reporting, multiscale generalization, interaction and bespoke art direction.

For movement graphics specifically, the remaining gap is now estimated as roughly 55% tooling/data infrastructure, 25% reporting/editorial context and 20% visual craft/human art direction. This is a product-investment estimate, not an empirical measurement.

## Evidence from the new flight page

The DAL1812 feature is materially more precise than the v1.5 OD pages. It can answer four questions from one evidence chain: where positions were observed, where the source stops observing, how altitude changes, and how ground speed changes. It also separates observed geometry from a geodesic reference.

This is still weaker than SCMP's flight-path work. SCMP's flight-path explanatory package uses real flight-track examples alongside airspace, waypoints, political boundaries, restrictions, fees and other domain context to answer why a route takes the shape it does. v1.6 can faithfully show the shape, but it cannot responsibly explain the cause without those additional datasets and reporting inputs.

## Evidence from the AIS local-scale failure

The Syros AIS sample is the most useful failure case in this release. At local scale the trajectory line is no longer the bottleneck. The 1:110m Natural Earth basemap is. The renderer can place exact coordinates, but a reader cannot understand berth, harbour entrance, channel, quay, local coastline or maritime constraint from the current substrate.

This proves that a single basemap tier is structurally incompatible with a newsroom that wants to cover global shipping, regional rerouting and harbour manoeuvres with the same map engine. A mature system requires scale-dependent geographic sources and cartographic generalization.

## Gap matrix

Scores below are internal maturity proxies from 1 (prototype) to 5 (strong newsroom-grade capability). They are not competition scores.

| Dimension | v1.6 | Top-tier target | Evidence / remaining gap |
| --- | ---: | ---: | --- |
| Route semantics and provenance | 4.5 | 5 | Observed/reference/missing geometry are separated and fail closed. Need broader production data adapters. |
| Global/regional basemap | 3.5 | 5 | Natural Earth works for global/regional context. Need richer relief, water, admin-1 and thematic layers. |
| Local/harbour/airport basemap | 1.5 | 5 | AIS stress case loses coastline/infrastructure detail. Needs 10m/local authoritative GIS and scale selection. |
| Trajectory ingestion and cleaning | 2.5 | 5 | Canonical point model and segment gaps exist. Missing raw high-volume ingestion, cleaning, resampling and simplification pipeline. |
| Dense-flow aggregation | 2 | 5 | Existing caps prevent unreadable output. Missing clustering, density surfaces, route bundles and multiscale aggregation. |
| Temporal movement semantics | 3.5 | 5 | Shared elapsed-time profile and gaps exist. Missing time windows, scrubber, animation and progressive temporal reveal. |
| Cross-view linking | 2.5 | 5 | Map/profile share evidence and labels but are statically separate. Missing hover/brush/scroll synchronization and keyed event anchors. |
| Domain context layers | 2 | 5 | No airway/FIR/weather/jet-stream or port/channel/bathymetry/pipeline layers in the release fixture. |
| Cartographic labeling/generalization | 2.5 | 5 | Direct labels, locator and collision heuristics exist. Missing scale-dependent feature selection, label priority, curved labels and local typography. |
| Scene-level magazine integration | 3.8 | 5 | Hero map + sidecars + linked profile now form one narrative. Still modular compared with bespoke integrated award spreads. |
| Subject-specific illustration / physical explanation | 2 | 5 | No aircraft, vessel, infrastructure cutaway or photography layer in the trajectory story. |
| Mobile-native / interactive execution | 2.5 | 5 | Mobile is reauthored and readable. Missing browser-native pan/zoom, scrollytelling, time animation and accessibility audit. |
| Reporting depth / causal explanation | 2.5 | 5 | Source trace is authoritative for observed state. It cannot answer why the route bends without more reporting/data. |
| Expert visual taste and polish | 3 | 5 | Pixel QA catches real defects; qualified human preference remains external. |

## Why SCMP movement graphics still feel richer

SCMP's flight-path work demonstrates that geography is used as an explanatory mechanism rather than as a coordinate frame. Real tracks can be juxtaposed with airspace constraints, political restrictions, route permissions, waypoints or weather. A bend in a line can therefore become a reported finding.

The current agent has become good at preserving a bend faithfully. It still needs contextual layers to explain that bend. This distinction is the largest remaining intellectual gap in movement journalism.

The same applies to shipping. Shipmap.org combined AIS location/speed with vessel characteristics, computed hourly CO2, a custom bathymetric basemap, ports, route-density layers, filtering and a time controller. The Information is Beautiful Awards gave the project Gold in the 2016 interactive category. A static accurate trajectory line is only one layer of that product.

## Tool problem versus reporting problem

Several gaps can be fixed mainly with engineering:

- provenance-bound multiscale basemap registry;
- 10m/50m/110m and local-source selection by geographic span;
- raw ADS-B/AIS trajectory ingestion, cleaning, segmentation and simplification;
- density and route-clustering algorithms;
- network-constrained geometry ingestion;
- scale-dependent labels;
- linked map/profile interaction;
- browser-native MapLibre/deck.gl or equivalent execution when scale justifies it.

Other gaps require new evidence, not better rendering:

- why an aircraft avoided a piece of airspace;
- whether a ship rerouted because of conflict, weather or port congestion;
- whether a pipeline segment was active during the reported period;
- whether a migration arc represents stock, annual flow, border crossing or modeled estimate.

A renderer must not infer these explanations from shape alone.

The remaining human/art-direction gap is different again: deciding which route segment becomes the visual anchor, what gets annotated, which contextual layer is suppressed, whether a locator is useful, how much of a dense network to show, and when a map should become an illustration or interactive sequence.

## Recommended next sequence

The next implementation should avoid another broad renderer expansion. The highest-value sequence is:

1. build a provenance-bound multiscale basemap registry and make local-scale inadequacy a publication blocker rather than a warning for award/publish modes;
2. add a canonical movement-ingestion stage with raw point cleaning, time-gap segmentation, Douglas-Peucker or equivalent spatial simplification, temporal resampling and coverage statistics;
3. add density/grid and route-clustering/bundling outputs for hundreds or thousands of AIS/ADS-B tracks;
4. qualify a real network-constrained dataset, with the EIA/DOT natural-gas pipeline FeatureServer as a strong candidate;
5. add domain layer adapters for airports/airspace/weather and ports/channels/bathymetry;
6. only then add browser linked interaction and timeline playback, because interaction becomes useful once the data density and contextual layers justify it.

## Reference points

- SCMP, “Why the world’s flight paths are such a mess”: https://multimedia.scmp.com/news/world/article/2165980/flight-paths/
- Shipmap.org: https://www.shipmap.org/
- Information is Beautiful Awards 2016 interactive winners: https://www.informationisbeautifulawards.com/news/195-2016-winners-interactive
- Natural Earth scale guidance: https://www.naturalearthdata.com/downloads/
- Natural Earth 1:10m land: https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/
- xoolive/traffic: https://github.com/xoolive/traffic
- ITSLab-UAegean/vesseltrack-tools: https://github.com/ITSLab-UAegean/vesseltrack-tools
- U.S. DOT/EIA Natural Gas Pipelines FeatureServer: https://geo.dot.gov/server/rest/services/hosted/Natural_Gas_Pipelines_US_EIA/FeatureServer/0
