# v0.5 Iteration Plan and Status

## Objective

Turn the v0.4 editorial visualization pipeline into a competition-ready, regression-tested system that proves the Rust control plane, produces responsive newsroom graphics, and handles dense labels without visual collisions.

## Gate 1 — Rust ↔ Pi control-plane acceptance

Status: IMPLEMENTED; local execution skipped because Cargo is unavailable in this container.

Implemented:

- `scripts/mock_pi.py` implements the subset of Pi RPC required by the Rust client.
- `scripts/test_control_plane.sh` runs the real Rust `investigate`, `continue`, and `inspect` commands against the mock RPC process when Cargo is available.
- The mock emits a failed `fetch_url` call, an automatic retry event, successful deterministic/data-viz capability calls, `turn_end`, and `agent_settled`.
- The follow-up run resumes the same artifact/session and reports `userMessages=2`.
- The acceptance script runs `scripts/evaluate_artifact.py` against the resulting artifact and checks plan revisions, failure recovery, multi-turn context, and agent-loop evidence.
- GitHub Actions now executes this acceptance test after the Rust build/test/clippy gates.

Acceptance status:

- RPC mock protocol: PASS locally with direct JSONL exercise.
- Rust binary against mock RPC: DEFERRED LOCALLY, REQUIRED IN CI.
- Failure/recovery assertions: implemented in the CI acceptance script.

## Gate 2 — Responsive visualization bundle

Status: COMPLETE.

Implemented:

- `renderVizBundle()` emits desktop and mobile SVG variants from one spec and one verified dataset.
- Desktop viewBox width: 1040.
- Mobile viewBox width: 640.
- Small multiples reflow from two columns to one column on mobile.
- Time-like facets are sorted deterministically with `sortX()` rather than input order.
- Mobile plot margins, label columns, title wrapping, subtitle wrapping, and footer wrapping are independent from desktop layout.
- `newsroom_viz_render` writes both variants and records them in `manifest.variants.desktop` and `manifest.variants.mobile`; `manifest.svg` remains the desktop compatibility field.
- `newsroom_viz_critic` evaluates both variants and uses the lower viewport score as the quality gate.

Acceptance:

- Desktop and mobile semantic smoke tests: PASS.
- Desktop/mobile SVG snapshot regression: PASS.
- Manual rasterized visual review: PASS after chronological facet ordering and annotation-width fixes.

## Gate 3 — Collision-aware editorial labels

Status: COMPLETE FOR V0.5.

Implemented:

- Greedy annotation lane placement with left/right boundary checks.
- Automatic inward annotation flipping near frame edges.
- Deterministic direct-label baseline separation for multi-line endpoints.
- Semantic `data-role="annotation"` and `data-role="direct-label"` markers for regression tests.
- Mobile-specific annotation length budget to avoid premature truncation.

Acceptance:

- Three deliberately clustered scatter annotations maintain separate baselines: PASS.
- Three deliberately clustered multi-line direct labels maintain the configured minimum gap: PASS.
- Right-edge annotation remains inside the frame: PASS in visual regression.

## Gate 4 — Smoke, regression, and performance

Status: COMPLETE.

Current smoke suite covers:

- Pi TypeScript and visualization JavaScript syntax.
- Rust allowlist ↔ audit ↔ extension tool contract.
- NewsroomVizSpec Draft 2020-12 schema validation.
- World Bank mixed-year fixture integrity.
- Mixed-reference-period blocking and faceted repair.
- Verified annotation enforcement.
- Responsive desktop/mobile rendering.
- Annotation collision layout.
- Direct-label collision layout.
- Desktop/mobile snapshot regression for dumbbell, multi-line, and heatmap.
- Competition artifact evaluator, now 13/13 including responsive visual output.
- Rust ↔ mock-Pi control-plane acceptance when Cargo is available.
- Responsive visualization performance benchmark.

Latest local performance result:

- workload: deterministic lint + desktop render + mobile render + desktop critic + mobile critic
- chart families: 10
- iterations per family: 120
- overall p50: ~0.18 ms
- overall p95: ~0.50 ms
- observed max: ~1.26 ms in the final full smoke run
- budget: 10 ms p95
- result: PASS

## Bugs found and fixed during v0.5

1. The first responsive small-multiples implementation preserved input facet order, causing 2022 to render before 2021. Facets now use deterministic temporal/numeric sorting.
2. The first mobile annotation budget truncated the governing annotation too aggressively. The mobile small-multiple annotation budget was widened after rasterized review.
3. Desktop snapshots changed after semantic SVG markers and collision-aware placement were introduced. Snapshot regression was intentionally updated and extended to mobile variants.
4. A syntax error was introduced while tightening mobile facet ordering. The semantic smoke test caught it immediately before packaging.

## Explicit non-goals for v0.5

- No additional chart families solely for feature count.
- No browser-only JavaScript renderer.
- No network-dependent CI test against a paid model provider.
- No attempt to replace deterministic lint with a multimodal model.

## Remaining external acceptance

A machine with Cargo/Rust, real Pi, and DuckDB is still required for the final live acceptance:

```bash
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
./scripts/smoke.sh
news doctor
news investigate --data fixtures/world-bank-renewable-latest.csv "$(cat demos/offline-mixed-year.txt)"
```

The mock acceptance closes the Rust/RPC control-plane gap in CI, but it does not substitute for a real model/provider + Pi extension + DuckDB run.
