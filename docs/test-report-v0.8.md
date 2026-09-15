# v0.8 Test Report

## Scope

v0.8 extends the visualization subsystem from statistical graphics into topology-aware flow, relationship, hierarchy and temporal graphics. It keeps the v0.7 evidence and live-qualification boundaries intact.

## Unified smoke result

`./scripts/smoke.sh` passes after adding the v0.8 suites. The run includes:

- release and runtime contract checks;
- NewsroomVizSpec 0.8 schema checks;
- legacy 10-family statistical regression tests and snapshots;
- complex topology semantic tests and snapshots;
- EIA 2024 real-data Sankey regression;
- OWID/Ember and World Bank real-data regressions;
- provenance and adversarial integrity suites;
- replay protocol and provider-qualification contracts;
- old and complex visualization performance suites.

The competition engineering gate remains 15/15 on the valid synthetic artifact. The ten provenance tampering cases continue to be rejected.

## Complex topology smoke

PASS conditions include:

- valid Sankey render;
- negative Sankey flow rejected;
- cyclic Sankey rejected before DAG layout and direct render fails closed;
- strict flow conservation mismatch rejected;
- node-link and adjacency matrix render;
- dense node-link graph emits matrix-routing warning;
- hierarchy requires one root and rejects cycles;
- timeline and streamgraph render;
- streamgraph negative values rejected;
- positive log-scale scatter renders and zero value on a log axis is rejected.

## Real EIA flow regression

The fixture uses EIA 2024 aggregate U.S. energy data. The deterministic conservation assertions are:

- primary source input: 94.2 quadrillion Btu;
- U.S. primary-energy outgoing aggregate: 94.2 quadrillion Btu;
- end-use sector split: 74.9 quadrillion Btu.

Desktop and mobile critics both score 96 and pass. The test note explicitly states that the aggregate fixture does not imply source-specific allocation across end-use sectors.

## Final performance from the first full v0.8 smoke

Legacy responsive statistical pipeline, 10 families x 120 iterations:

- p50: 0.210 ms
- p95: 0.552 ms
- max: 1.734 ms
- budget: 10 ms p95, PASS

Complex visual pipeline, 8 cases x 100 iterations:

- p50: 0.314 ms
- p95: 0.714 ms
- max: 5.169 ms
- budget: 18 ms p95, PASS

The more expensive complex families remain far below the local renderer budget. The Sankey case was 0.990 ms p95 in the final run. The adjacency-matrix case had the highest complex-family p95 at 1.809 ms and still remained far below budget.

Artifact verifier performance in the same smoke remained within prior budgets:

- small artifact verifier p95: 2.246 ms;
- 41-computation scale verifier p95: 5.927 ms.

These are deterministic subsystem microbenchmarks. They still exclude real model inference, network acquisition and live DuckDB query latency.

## Visual inspection findings

Human raster review remains mandatory because structural critic scores do not detect every editorial layout problem. This iteration found and fixed:

- Sankey node annotation overlapping a highlighted node;
- desktop timeline date/event text competing for the same lane;
- Sankey cycle analysis entering an unbounded level-propagation loop before DAG short-circuiting was added;
- log-scatter direct labels competing with multi-line annotations before both were moved into one collision layout.

The fixed states are stored in complex SVG snapshots and raster fixtures.
