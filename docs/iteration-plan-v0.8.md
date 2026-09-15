# v0.8 Iteration Plan: Complex Visual Journalism Engine

## Objective

Extend the evidence-grounded visualization subsystem beyond ordinary statistical charts into topology-aware visual journalism while preserving the existing provenance, responsive rendering, lint, critic and performance gates.

## Gate 1: Visual topology protocol

Status: PASS.

- `NewsroomVizSpec` advances to 0.8 while accepting 0.7 statistical specs for backward compatibility.
- First-class `visual_family`, `data_topology` and `complexity_budget` fields.
- Supported topologies: `tabular`, `flow_edges`, `graph_edges`, `hierarchy`, `events`.
- Pi planning tool exposes topology fields and scale choices explicitly.
- Project release advances to 0.8.0 while News Artifact integrity protocol remains 0.7.0.

## Gate 2: Complex relationship renderers

Status: PASS.

Added responsive desktop/mobile render paths for:

- Sankey
- Alluvial
- node-link network
- adjacency matrix
- hierarchy tree
- timeline
- streamgraph

Existing ten statistical families remain available. Scatter now supports positive log scales and explicit axis labels.

## Gate 3: Deterministic topology lint and failure handling

Status: PASS.

Flow lint checks negative values, self loops, DAG cycles, flow conservation, graph size and estimated crossing pressure. Cyclic flows short-circuit all DAG-dependent layout analysis and direct rendering fails closed.

Relationship lint checks graph size and density and recommends an adjacency matrix when a node-link view becomes dense. Hierarchy lint validates one root, unique IDs, parent existence and cycles. Streamgraph lint rejects negative values. Log scales reject non-positive data.

## Gate 4: Editorial layout and real-data qualification

Status: PASS for the implemented families.

- Multi-line annotation wrapping and collision-aware point annotations.
- Flow-node annotations are external callouts rather than text painted over nodes.
- Deterministic timeline ordering and separated date/event text lanes.
- Real EIA 2024 U.S. energy-flow fixture exercises strict conservation with published totals.
- OWID/Ember and World Bank real-data regression suite is retained; GDP/life-expectancy scatter now uses log x scale.
- SCMP and Delayed Gratification are represented in a reference corpus as abstract decision patterns, not visual-style templates.

## Gate 5: Smoke, snapshots and performance

Status: PASS.

Main `scripts/smoke.sh` runs legacy visualization tests, complex topology tests, complex snapshots, real EIA Sankey regression, OWID/World Bank real-data regression, integrity/adversarial tests and both performance suites.

Final release numbers are recorded in `docs/test-report.md` and `docs/smoke-v0.8.log`.

## Explicitly deferred

Geographic flow maps require authenticated geographic boundary data and projection logic. Chord/ribbon views, full categorical parallel sets and explanatory illustration/cutaway composition are not claimed by v0.8. The first alluvial renderer shares the Sankey DAG layout core rather than implementing a dedicated multi-axis categorical optimizer.
