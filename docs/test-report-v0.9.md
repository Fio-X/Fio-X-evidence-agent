# v0.9 Test Report

## Scope

v0.9 expands the deterministic visualization layer into spatial, categorical-flow and explanatory visual journalism. It preserves the News Artifact 0.7 evidence protocol and accepts NewsroomVizSpec 0.7/0.8 while emitting NewsroomVizSpec 0.9.

## Unified smoke result

`./scripts/smoke.sh` passes. The final run exercises schema validation, runtime contracts, old statistical/complex renderers, the four v0.9 renderers, real-data regressions, snapshots, provenance attacks, SQL-replay protocol, RPC failure recovery and performance budgets.

Engineering competition gate: **15/15 PASS**.

Integrity adversaries: **10/10 rejected**.

The local control-plane binary acceptance remains an explicit SKIP because Cargo is unavailable in this container; CI is configured to run the Rust acceptance when the pinned toolchain is available.

## v0.9 semantic tests

The new suite covers:

- `parallel_sets`: 2-5 categorical dimensions, weighted ribbons, negative-weight rejection and deterministic ordering;
- `chord`: weighted relationships, negative-weight rejection, node/link density warnings and responsive composition;
- `geo_flow_map`: coordinate validation, negative-weight rejection, bounded route density, schematic-projection disclosure and deterministic label avoidance;
- `process_schematic`: DAG layout, cycle rejection, edge labels and vertical mobile reflow;
- numeric missing values: `null`, `undefined` and blank strings no longer coerce to zero in numeric validation.

## Real-data regressions

### EIA 2024 U.S. crude-oil imports

The geographic-flow fixture uses monthly crude-oil import totals from the U.S. Energy Information Administration for Canada, Mexico, Saudi Arabia, Brazil, Colombia and Iraq. Annual totals are converted to average thousand barrels per day. The visual uses representative country coordinates and states explicitly that curves encode relationships rather than physical tanker or pipeline routes.

The renderer direct-labels only the three largest route values when more than four routes are present, reducing label density while retaining route-width encoding for every row.

### R `datasets::Titanic`

The categorical-flow fixture uses the 2,201-observation four-dimensional Titanic contingency table (`Class`, `Sex`, `Age`, `Survived`). The Parallel Sets renderer preserves the full 32-cell table and uses weighted ribbons across four axes.

Both real-data fixtures pass deterministic lint and desktop/mobile critic checks and were rasterized for manual visual inspection.

## Final performance

Final run in this container:

| Pipeline | p50 | p95 | Budget |
| --- | ---: | ---: | ---: |
| 10 statistical responsive families | 0.188 ms | 0.411 ms | 10 ms |
| 8 v0.8 complex cases | 0.354 ms | 0.793 ms | 18 ms |
| 4 v0.9 spatial/explanatory families | 0.133 ms | 0.399 ms | 22 ms |
| Small artifact verifier, 81 checks | 1.940 ms | 2.351 ms | 15 ms |
| 41-computation verifier, 441 checks | 5.116 ms | 7.134 ms | 40 ms |

Full smoke elapsed: **19.30 seconds**.

The renderer remains far below the meaningful end-to-end latency budget. Provider inference, network acquisition and real DuckDB workloads remain the dominant live-system performance variables.

## Defects found and fixed during v0.9

The iterative smoke and raster-review loop caught several issues before release:

1. dense geographic source labels overlapped around nearby countries;
2. Parallel Sets labels lost legibility over ribbons because the first halo treatment was too heavy;
3. zero-weight paths could still receive a visible minimum-width ribbon;
4. all geographic routes were initially value-labeled, creating a label wall in the real EIA fixture;
5. `null` numeric values could be coerced by JavaScript to zero;
6. schema/runtime smoke originally did not prove that all v0.9 planner fields were aligned.

All are covered by the final code or test contracts.
