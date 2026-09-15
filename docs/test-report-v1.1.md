# v1.1 Test Report

## Release under test

- Release: `1.1.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `0.9.0`
- InfographicSpec: `1.1.0`
- Semantic explanatory graphic protocol: `0.1.0`

The final deterministic smoke completed in **24.25 seconds** in the current container. Rust/Pi/DuckDB live acceptance remains environment-gated because the pinned binaries are unavailable locally; the control-plane test therefore reports an explicit `SKIP` rather than a pass.

## Final gates

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| Runtime allowlist/audit/materialization contract | PASS |
| NewsroomVizSpec schema | PASS |
| News Artifact schema | PASS |
| InfographicSpec 1.1 schema + conditional modules | PASS |
| Legacy statistical visualization regression | PASS |
| v0.8 complex relationship regression | PASS |
| v0.9 spatial/categorical/process regression | PASS |
| Semantic explanatory graphic four-view tests | PASS |
| Explanatory XML + raster regression | PASS, 8 files |
| Infographic legacy + awards-informed tests | PASS |
| EIA real-data magazine feature | PASS |
| Infographic XML + raster regression | PASS, 6 files |
| Competition engineering evaluator | **20/20 PASS** |
| Integrity adversarial suite | **14/14 rejected** |
| SQL replay protocol | PASS |
| Qualification-summary contract | PASS |
| Mock Pi failure/recovery/resume | PASS |
| Real Rust control-plane binary | SKIP, Cargo unavailable locally |

## Awards-informed page tests

The v1.1 fixture exercises explicit intent, primary message, audience, story arc, module story roles/priorities/emphasis and three deterministic desktop layout candidates.

- coherent award-target fixture: **97/100, PASS**
- deliberately flat/weak-hierarchy fixture: **93/100, REVISE** because critical-dimension floors prevent a high average from hiding weak editorial structure
- real EIA magazine feature: **99/100, PASS**

EIA rubric:

```json
{
  "impact_story_focus": 100,
  "engagement": 97,
  "clarity_information_flow": 100,
  "effectiveness": 100,
  "hierarchy": 100,
  "editorial_rhythm": 100,
  "inclusion_accessibility": 100,
  "responsive_execution": 100,
  "craft_geometry": 91,
  "originality_variety": 95
}
```

The selected EIA strategy is `balanced`; all candidate scores are retained in the page artifact.

## Semantic explanatory graphics

Four deterministic semantic views are covered:

- `cutaway`
- `exploded`
- `anatomy`
- `system`

Tests confirm mandatory `SCHEMATIC / NOT TO SCALE`, verified-claim gating, relationship validation, responsive desktop/mobile output, SVG snapshots and real rasterization. Missing/unknown relationships, false scale claims and unverified part claims are rejected.

The EIA feature embeds a semantic cutaway titled `Four layers of the energy balance` as a first-class illustration module. The page verifier checks the explainer manifest, critic, SVG hashes, disclosure and claim references before publication.

## Integrity/adversarial coverage

Fourteen tested mutations are rejected. In addition to the existing dataset/source/computation/path/run-metric attacks, v1.1 rejects:

- infographic SVG hash tampering;
- missing upstream visualization;
- explanatory asset disclosure/hash tampering;
- missing upstream explanatory illustration.

This keeps magazine composition downstream of evidence rather than creating a separate unverified publication path.

## Performance

### Statistical visualization pipeline

10 families × 120 iterations, including lint + desktop/mobile render + dual critic:

- p50: **0.192 ms**
- p95: **0.388 ms**
- max: **4.165 ms**
- budget: 10 ms p95

### Complex relationship visualization pipeline

8 families × 100 iterations:

- p50: **0.304 ms**
- p95: **0.789 ms**
- max: **4.888 ms**
- budget: 18 ms p95

### Spatial/categorical/process visualization pipeline

4 families × 140 iterations:

- p50: **0.125 ms**
- p95: **0.302 ms**
- max: **0.959 ms**
- budget: 22 ms p95

### Semantic explanatory pipeline

400 iterations of render + critic:

- p50: **0.098 ms**
- p95: **0.259 ms**
- max: **0.588 ms**
- budget: 8 ms p95

### Magazine infographic composer

240 iterations, three desktop candidates per iteration:

- p50: **0.499 ms**
- p95: **0.865 ms**
- max: **1.139 ms**
- budget: 15 ms p95

### Artifact verifier

Small artifact, 145 checks/run, 400 iterations:

- p50: **3.436 ms**
- p95: **5.070 ms**
- max: **14.780 ms**
- budget: 15 ms p95

Scale artifact, 41 computations / 505 checks/run, 100 iterations:

- p50: **6.700 ms**
- p95: **9.270 ms**
- max: **11.735 ms**
- budget: 40 ms p95

These are deterministic subsystem microbenchmarks. They do not represent live Agent end-to-end latency, which is recorded separately in `run-metrics.jsonl` when Pi/model/network/DuckDB are available.

## Current environment limitation

`docs/live-readiness-v1.1.json` reports `live_ready=false`. The current container has Node 22.16.0 and Python 3.13.5 but lacks the pinned Pi, DuckDB, Rust and Cargo runtime. Real `Rust -> Pi -> provider -> tools -> DuckDB` qualification must therefore be run through the pinned CI/Docker/live environment with model credentials before the final competition recording.
