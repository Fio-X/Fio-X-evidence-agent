# v1.2 Test Report

## Release under test

- Release: `1.2.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `0.9.0`
- InfographicSpec: `1.1.0`
- Semantic explanatory protocol: `0.1.0`
- Rich illustration protocol: `0.2.0`
- Image-aware visual critic protocol: `0.1.0`
- CairoSVG preview runtime: `2.8.2`

The final deterministic/local smoke passed. The environment cannot execute the pinned Rust/Pi/DuckDB live path because Rust/Cargo, Pi and DuckDB are unavailable and no provider credentials are present. The real control-plane test therefore reports an explicit `SKIP`, and live-provider qualification remains pending rather than being reported as a pass.

## Final gates

| Gate | Result |
| --- | --- |
| Release/version baseline | PASS |
| Runtime allowlist/audit/materialization contract | PASS |
| NewsroomVizSpec schema | PASS |
| News Artifact schema | PASS |
| InfographicSpec 1.1 schema | PASS |
| Rich illustration contract | PASS |
| Rich illustration active-content/origin-policy rejection | PASS |
| Image-aware critic bounded-patch contract | PASS |
| Exact infographic preview rasterization | PASS |
| Existing 21 visualization families | PASS |
| Semantic explanatory four-view pipeline | PASS |
| EIA magazine feature regression | PASS |
| Competition engineering evaluator | **22/22 PASS** |
| Integrity adversarial suite | **14/14 rejected** |
| SQL recompute protocol | PASS |
| Qualification-summary contract | PASS |
| Mock Pi failure/recovery/resume | PASS |
| Real Rust/Pi/provider control plane | SKIP, runtime unavailable locally |

## New visual-editor gates

### Rich illustration

The test adapter is executed through stdin JSON / stdout JSON. Contract tests confirm a valid provenance-aware SVG is accepted and annotated, `human_only` rejects generated output, and SVG containing active script content is rejected. This proves the external-adapter boundary, policy enforcement and sanitization behavior. It does not prove the quality of any real image-generation service.

### Exact-pixel preview

The preview test rasterizes the exact infographic SVG through CairoSVG and validates the produced PNG. In the Agent runtime the preview manifest binds desktop/mobile PNG hashes to the current desktop/mobile SVG hashes so an image-aware critic cannot satisfy the release gate using a stale page image.

### Image-aware critic

Contract tests cover a valid ten-dimension critique, a blocker case, unknown module IDs and forbidden patch fields. Machine-actionable changes are restricted to span, emphasis, priority and `move_before`. The independent verifier requires score >= 80, every dimension >= 60, no blocker, a passing deterministic critic and preview hashes matching the current page.

### Competition engineering evaluator

The synthetic full-path artifact passes **22/22** checks. The new checks are provenance-aware rich illustration and image-aware infographic review. Existing integrity, autonomy, computation, visualization, explanatory and magazine-composition requirements remain in the same gate.

## Integrity/adversarial coverage

All fourteen adversarial mutations are rejected:

1. dataset hash mismatch;
2. source content hash mismatch;
3. source trust-boundary tamper;
4. computation result hash mismatch;
5. input fingerprint tamper;
6. non-content-addressed source path;
7. non-content-addressed computation path;
8. missing mobile SVG;
9. unsafe claim reference;
10. invalid run metric;
11. infographic SVG hash mismatch;
12. missing upstream visualization;
13. illustration disclosure/hash tamper;
14. missing upstream illustration.

The verifier additionally checks image-aware review lineage for any page marked `visual_review_required: true`.

## Performance

### Statistical visualization pipeline

10 families x 120 iterations, including lint + desktop/mobile render + dual critic:

- p50: **0.189 ms**
- p95: **0.392 ms**
- max: **1.071 ms**
- budget: **10 ms p95**

### Complex relationship visualization pipeline

8 families x 100 iterations:

- p50: **0.276 ms**
- p95: **0.602 ms**
- max: **1.603 ms**
- budget: **18 ms p95**

### Spatial/categorical/process visualization pipeline

4 families x 140 iterations:

- p50: **0.125 ms**
- p95: **0.306 ms**
- max: **0.668 ms**
- budget: **22 ms p95**

### Semantic explanatory pipeline

400 iterations:

- p50: **0.091 ms**
- p95: **0.224 ms**
- max: **0.650 ms**
- budget: **8 ms p95**

### Magazine infographic composer

240 iterations with three desktop candidates per iteration:

- p50: **0.428 ms**
- p95: **0.672 ms**
- max: **0.947 ms**
- budget: **15 ms p95**

### Artifact verifier

Small artifact, 202 checks/run, 400 iterations:

- p50: **3.706 ms**
- p95: **4.255 ms**
- max: **7.649 ms**
- budget: **15 ms p95**

Scale artifact, 41 computations / 562 checks/run, 100 iterations:

- p50: **6.504 ms**
- p95: **7.075 ms**
- max: **10.266 ms**
- budget: **40 ms p95**

These are deterministic subsystem microbenchmarks. Live provider latency, image-token cost and repair-cycle behavior are captured separately by `qualification.json` when the pinned runtime and model credentials are available.

## Live-readiness result

`docs/live-readiness-v1.2.json` records `live_ready=false`. The current container has Node 22.16.0 and Python 3.13.5; the pinned baseline requires Node 22.19.0 and also needs Pi 0.85.1, DuckDB 1.5.5, Rust 1.98.1 and Cargo. No supported provider API credential or Pi auth file is present.

The correct next release gate is therefore to run `scripts/provider_matrix.sh` with at least two real multimodal provider/model pairs in the pinned CI/Docker environment, retain each `qualification.json`, and review `provider-comparison.md` for pass rate, tool recovery, plan revisions, wall time and usage/cost metrics.
