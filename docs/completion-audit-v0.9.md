# v0.9 Completion Audit

## Audit conclusion

v0.9 closes the spatial/categorical-flow gap identified after v0.8. The deterministic visual runtime now covers **21 rendered forms**: ten statistical forms, seven v0.8 complex forms and four v0.9 spatial/explanatory forms.

Estimated release status:

- core agent/control/evidence architecture: 92%;
- deterministic evidence/provenance: 94%;
- statistical visual journalism: 93%;
- complex relationship visual journalism: 90%;
- spatial/explanatory deterministic visualization: 78%;
- live provider qualification: unchanged and environment/credential dependent;
- competition engineering readiness: approximately 88%, with a real provider qualification artifact and measured business-value comparison still required.

## Implemented in v0.9

- dedicated Parallel Sets over 2-5 categorical dimensions;
- Chord relationship view;
- schematic geographic flow map from verified coordinates;
- process schematic over an acyclic process graph;
- new `categorical_flow`, `geo_edges` and `process_graph` data topologies;
- topology-aware lint and critic rules;
- responsive desktop/mobile layouts;
- real EIA geographic-flow and Titanic categorical-flow regression fixtures.

NewsroomVizSpec advances to 0.9.0. News Artifact remains 0.7.0 because provenance semantics did not need a breaking change.

## Release evidence

Final unified smoke passes 15/15 engineering gates and rejects all ten integrity adversaries. Legacy statistical and v0.8 complex snapshot suites remain green. The new spatial/explanatory pipeline records 0.399 ms p95 in the final local run. The 41-computation verifier remains at 7.134 ms p95.

## Remaining boundaries

`geo_flow_map` is intentionally a schematic coordinate projection. It does not claim country boundaries, coastlines, geodesic routes or a GIS-quality basemap. Those require published geographic geometry and a dedicated spatial adapter.

`chord` currently uses deterministic weighted center curves with node arcs; a full filled ribbon optimizer is future work. Process schematic handles verified DAG structure but does not generate semantic illustration, cutaways or exploded views. Photorealistic or illustration-heavy SCMP-style explanatory graphics remain outside the deterministic SVG renderer.

The current container still lacks the pinned Rust/Pi/DuckDB toolchain and model credentials. A recorded live `Rust -> Pi -> model -> tools -> DuckDB -> verify --recompute` run remains mandatory before final competition submission.
