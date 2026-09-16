# v1.7 Iteration Plan: Editorial Semantics Qualification

## Objective

Move the visualization system from renderer correctness to analytical-editorial correctness. Every quantitative comparison used by the v1.7 statistical planning path must declare what each measure means, what claim the visual is intended to establish, and which visual grammar encodes that claim. Backend selection must reject incompatible topology/capability combinations before any probabilistic or heuristic scoring.

## Milestone A — MeasureSemantics contract — COMPLETE

`runtime/visual/measure_semantics.mjs` introduces MeasureSemantics 1.0 with explicit phenomenon, unit, measure kind, temporal basis, observation status, aggregation, denominator, adjustment, price basis, seasonal adjustment, base period, scope, evidence reference, and optional scalar value.

The comparability evaluator returns only `DIRECT`, `CONTEXTUAL`, or `INCOMPATIBLE`.

Release behavior:

- `INCOMPATIBLE` blocks compilation before backend routing.
- `CONTEXTUAL` permits composition only with explicitly differentiated visual roles.
- `DIRECT` permits peer encoding.

Acceptance: the adversarial corpus has zero false negatives for its declared incompatible cases.

## Milestone B — ClaimSpec and editorial grammar — COMPLETE

`runtime/visual/editorial_semantics.mjs` introduces ClaimSpec 1.0 and the editorial grammar planner. ClaimSpec binds a verified claim to target/baseline/context measures, a reader task, a claim relation, and an optional deterministic derived metric.

The current deterministic derived metrics are percentage change, absolute change, percentage-point change, and ratio. The grammar planner maps claim relations to a bounded family of newsroom forms rather than letting backend/render preferences choose the story structure.

Acceptance: the Saudi/Hormuz replay computes `(7 - 125) / 125 = -94.4%` and selects `change -> dumbbell/slope` with a required primary change annotation.

## Milestone C — semantic release gate in the agent runtime — COMPLETE

`newsroom_viz_plan` accepts `measure_semantics` and `claim_spec`, evaluates them before persisting a visualization plan, and rejects semantic or grammar violations. Ranking, comparison, change, distribution, correlation, and part-to-whole reader tasks now require the semantic declaration.

Acceptance:

- missing declarations fail with `SEMANTIC_DECLARATION_REQUIRED`;
- incompatible comparisons fail with `SEMANTIC_COMPARISON_BLOCKED`;
- strong claim grammars fail with `EDITORIAL_GRAMMAR_BLOCKED` when the chosen chart family conflicts with the claim.

## Milestone D — backend hard capability filter — COMPLETE

Backend selection now runs:

`topology -> artifact mode -> required capabilities -> allow/deny -> runtime health -> score/prior -> softmax`

The backend registry declares accepted topologies and artifact modes. Scoring cannot make a backend eligible after a hard rejection.

Acceptance: a tabular print comparison cannot surface `adjacency_matrix`, `sigma_graph`, or QGIS simply because of vector/print scoring. Dense graph, spatial-network, interactive-network, and interactive-geography specialists remain eligible only for their matching topologies.

## Milestone E — adversarial and cold-story regression — COMPLETE

Permanent regressions include:

- 20 semantic traps covering stock/flow, actual/capacity, observed/forecast, point-in-time/annual-average, rate/level, share/count, per-capita/total, nominal/real, seasonal-adjustment mismatch, index-base mismatch, aggregation mismatch, currency/unit mismatch, cumulative/flow, target/observed, and adjustment mismatch;
- 7 claim-grammar fixtures;
- 6 backend eligibility matrices;
- the 2026-09-14 Saudi/Hormuz cold-story replay with one expected READY visual and one expected BLOCKED visual.

## Milestone F — real networked cold-story qualification — EXTERNAL RELEASE GATE

This RC does not claim live autonomous qualification because the current qualification host does not provide the full pinned Rust/Pi/DuckDB and multi-backend runtime stack.

Before final v1.7 release, run at least 10 same-day English-language cold stories spanning at least five story families through the complete path:

`investigate -> source discovery -> verified SQL -> MeasureSemantics -> ClaimSpec -> semantic gate -> editorial grammar -> backend hard filter -> render -> critic/revision -> continue -> verify --recompute`

Final acceptance target: at least 9/10 complete verified publication packages, zero silent semantic errors, every blocked story recorded as either a semantic block or correct evidence abstention, and every executed challenger satisfying its hard backend contract.
