# Reproducibility

v1.3.0 retains the explicit live-qualification baseline and separates release version from protocol versions in `versions.json`.

| Component | v1.3 baseline | Role |
| --- | --- | --- |
| Rust | 1.98.1 | Rust CLI build and tests |
| Node.js | 22.19.0+ | Pi runtime baseline |
| Pi coding agent | 0.85.1 | agent runtime and RPC |
| DuckDB | 1.5.5 | deterministic SQL and replay |
| Python | 3.13 in CI | verifier, smoke, raster and evaluation |
| CairoSVG | 2.8.2 | exact-pixel infographic preview/raster qualification |
| News Artifact | 0.7.0 | immutable evidence/provenance protocol |
| NewsroomVizSpec | 0.9.0 | chart/network/spatial visualization protocol |
| InfographicSpec | 1.2.0 | magazine composition, competition profile and mobile-order protocol |
| Explanatory graphic | 0.1.0 | semantic illustration protocol |
| Rich illustration | 0.2.0 | external provenance-aware illustration protocol |
| Vision critic | 0.1.0 | image-aware bounded visual-review protocol |

`rust-toolchain.toml` pins Rust. Standard CI installs the pinned Pi/DuckDB packages. `Dockerfile.live` defines a containerized live baseline. `scripts/bootstrap_live_env.sh --check` and `news doctor --strict --json` provide machine-readable readiness gates.

## Cargo dependency lock

`Cargo.lock` remains mandatory before the final competition/production tag. The current execution container cannot generate it because Rust/Cargo cannot be installed from the blocked external distribution hosts. Generate it in the first Rust-enabled environment:

```bash
cargo generate-lockfile
cargo check --locked
cargo test --locked
cargo clippy --locked -- -D warnings
```

Commit the lockfile before final qualification.

## Deterministic visual reproducibility

The release locks three presentation layers independently:

- Newsroom visual SVG snapshots for statistical/complex/spatial visual families;
- explanatory SVG snapshots plus XML/raster smoke for cutaway/exploded/anatomy/system;
- infographic desktop/mobile SVG snapshots plus XML/raster smoke and real EIA magazine feature.

Infographic layout selection is deterministic: InfographicSpec 1.2 records the `balanced`, `anchor` and `rhythm` candidate scores and selected strategy. Approved visual/explainer/rich-illustration assets are embedded by hash, so page recomposition cannot silently change their evidence. v1.3 preview manifests additionally bind exact PNG previews to source SVG hashes, and `visual_review_required` pages must carry a passing image-aware critic referencing those exact previews.

## Verification layers

Fast integrity verification:

```bash
news verify .newsroom/artifacts/<id>
```

Computation replay:

```bash
news verify .newsroom/artifacts/<id> --recompute
```

Provider/live qualification:

```bash
NEWSROOM_NEWS_BIN=./target/release/news \
NEWSROOM_PROVIDER=<provider> \
NEWSROOM_MODEL=<model> \
./scripts/agentic_qualification.sh

NEWSROOM_NEWS_BIN=./target/release/news \
NEWSROOM_PROVIDER=<provider> \
NEWSROOM_MODEL=<model> \
./scripts/integration_qualification.sh
```

Two-provider comparison:

```bash
NEWSROOM_PROVIDER_MATRIX="provider-a:model-a,provider-b:model-b" ./scripts/provider_matrix.sh
```

The manual GitHub workflow performs the same class of run when repository secrets are configured. Rich-illustration qualification uses the bundled contract mock unless `NEWSROOM_ILLUSTRATION_ADAPTER` is explicitly set to a real approved backend.

## Current-container evidence

The current container is documented rather than treated as equivalent to the pinned live environment. The v1.3 readiness JSON records the local Node/Pi/Rust/DuckDB state. This preserves the distinction between deterministic engineering smoke and a real provider qualification artifact.

## Competition-profile and revision reproducibility

InfographicSpec 1.2 stores an explicit `competition_profile` and an explicit `mobile_module_order`. Profile score floors are internal operational proxies and are versioned in `runtime/pi/competition.mjs`; they are not jury predictions. The profile source URLs and manual requirements are stored with preflight output so a later reviewer can distinguish automated checks from human eligibility and editorial judgments.

Image-aware revision is reproducible at the plan level. `newsroom_infographic_revise` records the source plan, bounded patch list, immutable editorial-evidence projection hash and revised plan. The independent verifier recomputes the protected projection and replays every patch from the source plan. A stored audit and critic cannot jointly rewrite evidence while remaining valid unless the reconstructed final plan is byte-equivalent at the semantic JSON level.

Competition preflight is also independently replayed. The verifier recomputes machine pass/fail from final deterministic and image-aware critic metrics plus rich-illustration origins, then compares that result with the stored preflight. Human attestations, originality judgments and submission screenshots remain manual requirements and are never self-attested by the agent.

## v1.4 editorial-search reproducibility

v1.4 adds deterministic artifacts before page layout: editorial discovery, visual-concept tournament, semantic-novelty report, asset plan, reference-pattern retrieval, expert-preference evidence and slow-award status. Each artifact is content-addressed and independently replayed where a machine decision can be recomputed. Human aesthetic evidence is stored separately and cannot be synthesized from model scores.

The NASA award regression is fully offline after fixture creation. NASA GISTEMP annual/monthly data remain under `fixtures/realdata/`. The geographic scaffold uses the checked-in `fixtures/external/naturalearth_lowres/` vector bytes plus `SOURCE.json`. Those bytes were copied from the installed pyogrio test fixture so CI does not depend on a network download; the manifest records the official Natural Earth Admin 0 lineage while explicitly declining to invent an upstream version for the exact local bytes.

Run the deterministic release evidence in two segments if a constrained CI/container imposes a short process timeout. `scripts/smoke.sh` remains the canonical ordered suite; `docs/smoke-v1.4.log` records a functional/integrity segment and a performance segment, each with exit code zero. This split changes process scheduling only, not the test set.

The v1.4 deterministic budgets are additive to the prior release budgets. Semantic novelty is measured at the contract maximum of 30 modules. Scene composition is benchmarked at the current InfographicSpec maximum of 12 scene elements; the earlier planning target of 20 elements is intentionally not claimed because the page contract caps modules at 12. Editorial-artifact verification includes replay of discovery/concepts/novelty/assets/preferences/award-status and remains under the ordinary 15 ms p95 verifier target after warmup.

Live-readiness remains fail-closed and is captured in `docs/live-readiness-v1.4.json`. The local environment has Node 22.16.0 instead of the pinned 22.19.0 and lacks Pi, DuckDB, Rust/Cargo and provider credentials. Two-provider qualification must therefore be run in the pinned external environment before any provider-readiness claim.

## v1.6 observed-trajectory reproducibility

v1.6 upgrades the cartographic release evidence from origin-destination relationships to time-indexed observed movement. The canonical ADS-B regression uses selected exact points from the public `xoolive/traffic` readsb sample `src/traffic/data/samples/readsb/trace_full_ac671b.json`. The local provenance manifest records the upstream Git blob SHA, aircraft metadata, selected-point transformation and the limitation that the source trace begins mid-flight. A 48.12-minute observation gap remains an explicit gap in both map geometry and the shared altitude/speed profile; no interpolation across the gap is permitted.

The AIS diagnostic uses selected exact rows from `ITSLab-UAegean/vesseltrack-tools/data/testing/00_original/input_ais_sample.csv`, whose repository documentation identifies the sample as decoded historical AIS based on real vessel movement around Syros, Greece. The fixture is used to test local-scale cartography, not vessel identity. Its intentionally tight extent triggers `basemap_detail_mismatch` when combined with the bundled Natural Earth 1:110m substrate.

Run the focused trajectory regressions with:

```bash
node scripts/test_trajectory_cartography_v16.mjs
node scripts/test_trajectory_magazine_v16.mjs
node scripts/test_ais_local_cartography_v16.mjs
python3 scripts/test_trajectory_raster_v16.py
node scripts/benchmark_trajectory_v16.mjs
```

The canonical release suite remains `scripts/smoke.sh`. In constrained execution environments it may be run in ordered segments; `docs/smoke-v1.6.log` records the same final code tree across schema/runtime, feature/integrity, verifier/control-plane and performance segments. Final steady-state p95 is 7.923 ms for the desktop+mobile observed-trajectory cartographic bundle under a 10 ms budget and 0.239 ms for the desktop+mobile trajectory-profile bundle under a 5 ms budget.

Live readiness remains fail-closed and is captured in `docs/live-readiness-v1.6.json`. This local environment has Node 22.16.0 rather than the pinned 22.19.0 and lacks Pi, DuckDB, Rust/Cargo and provider credentials. The release therefore does not claim real-provider control-plane qualification, high-volume ADS-B/AIS ingestion, real pipeline-network qualification or qualified-human preference evidence.
