# v0.8 Completion Audit

## Audit conclusion

v0.8 closes the largest visualization-capability gap identified after the v0.7 real-data review. The agent can now represent several non-tabular structures while preserving the existing evidence, lint, responsive rendering and verification boundaries.

Estimated status for this release:

- core agent/control/evidence architecture: 92%;
- deterministic evidence/provenance: 94%;
- statistical visual journalism: 92%;
- complex relationship visual journalism implemented in v0.8: 82%;
- live provider qualification: unchanged from v0.7 and still environment/credential dependent;
- final competition readiness: approximately 85% engineering-ready, with real-provider qualification and business-value measurement still required.

## Implemented complex visual surface

The release supports 17 rendered forms in total: the previous ten statistical families plus Sankey, alluvial, node-link, adjacency matrix, hierarchy tree, timeline and streamgraph. Log scatter and explicit axes address the principal real-data scatter defect found in v0.7.

`NewsroomVizSpec 0.8` adds explicit data topology and complexity budget. This is a protocol change in the visualization layer only; the audited News Artifact evidence protocol remains 0.7.0.

## Audit evidence

The final unified local smoke passes. The complex suite verifies positive and negative cases for flow, graph, hierarchy, timeline, streamgraph and log-scale scatter. EIA 2024 aggregate energy flow passes strict conservation and both desktop/mobile critics. OWID/Ember and World Bank real-data regressions also pass.

Performance remains comfortably within budget. Final complex-pipeline p95 is 0.714 ms across eight complex cases; Sankey p95 is 0.990 ms. The legacy 10-family responsive pipeline remains at 0.552 ms p95.

## Defects found during iterative smoke

Four material defects were discovered by the v0.8 test loop and fixed before release:

1. Sankey node annotations could overlap highlighted nodes;
2. timeline date/event text competed for the same visual lane;
3. crossing estimation on a cyclic flow could enter unbounded level propagation before cycle short-circuiting;
4. log-scatter direct labels and annotations could overlap on the same highlighted point.

These failures illustrate why deterministic unit checks, real-data raster review and performance smoke all remain release gates.

## Remaining capability gaps

The current `alluvial` form shares the Sankey DAG layout core and is not a dedicated multi-axis categorical parallel-sets optimizer. Chord/ribbon diagrams are not implemented. Geographic flow maps require verified geographic boundary/projection support. Explanatory cutaway, exploded-view and illustration-heavy compositions require a separate semantic drawing adapter. These items should not be represented as current v0.8 capabilities.

The live system limitation also remains (`docs/live-readiness-v0.8.json` records `live_ready=false`): this container cannot install or execute the pinned Rust/Pi/DuckDB toolchain and has no provider credential. The project therefore still needs a recorded real `Rust -> Pi -> model -> tools -> DuckDB` qualification artifact before final competition submission.
