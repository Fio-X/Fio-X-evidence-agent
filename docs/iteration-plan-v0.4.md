# v0.4 Iteration Plan and Status

Goal: turn the newsroom visualization prototype into a tested editorial visualization subsystem without weakening provenance or the Pi agent loop.

## Gate 1 — Protocol and CI — COMPLETE

- `NewsroomVizSpec` promoted to `schemas/newsroom-viz-spec.schema.json`.
- Draft 2020-12 schema tests added.
- visualization semantic tests, SVG snapshots and performance benchmark added to CI.
- competition evaluator fixture migrated to the editorial visualization pipeline.
- Rust allowlist/audit/runtime contract checker added.

## Gate 2 — Editorial semantics — COMPLETE FOR V0.4

- first-class `annotations[]`, `highlight_values`, and `direct_labels` fields added.
- point annotations require a verified claim id and a real row target.
- point annotations render on the core comparison/trend families.
- accessible SVG title/description and source footer remain mandatory.
- mixed reference periods remain a blocking deterministic rule unless explicitly separated.

## Gate 3 — Critic and iterative repair — COMPLETE FOR V0.4

- `newsroom_viz_critic` added after render.
- critic evaluates hierarchy, density, highlighting, annotations, direct-label behavior, accessibility, and source visibility.
- critic artifacts persist score, issues and repair suggestions.
- investigation prompt now requires a bounded revise → lint → render → critic loop.

The current critic is structural/editorial and deterministic. A later multimodal critic can be added behind the same tool contract without replacing the hard lint rules.

## Gate 4 — Performance and regression hardening — COMPLETE LOCALLY

- all 10 chart families covered by the in-memory benchmark.
- representative SVG snapshot hashes cover dumbbell, multi-line and heatmap.
- renderer remains dependency-free and CPU-only.
- latest overall p95 for lint + render + critic is ~0.33 ms versus a 25 ms CI budget.

## External acceptance gate — PENDING ENVIRONMENT

The current container lacks Rust/Cargo, Pi CLI and DuckDB CLI. Full Rust → Pi → DuckDB end-to-end acceptance and Rust compiler/clippy checks must run in CI or a development machine with those dependencies installed.
