# v1.0 Completion Audit

## Executive assessment

v1.0 closes the major presentation gap identified after v0.9: the project can now turn multiple verified visuals and claims into one responsive magazine feature rather than stopping at individual charts. The new capability is integrated into the Pi tool surface, Rust allowlist/runtime materialization, artifact verifier, evaluator, snapshots, raster smoke, and performance suite.

Audit assessment:

- core architecture and evidence system: **93%**
- deterministic visual journalism engine: **94%**
- magazine infographic composition: **88%**
- repository/CI engineering readiness: **92%**
- final competition submission readiness: **84%**
- production readiness: **68%**

The largest remaining uncertainty is live-provider behavior, not deterministic page rendering.

## Completed in v1.0

### InfographicSpec and page planning

`InfographicSpec 1.0` defines page metadata, layout mode, ordered modules, and responsive spans. Page modules are `hero_stat`, `visual`, `text`, `section_header`, and `pull_quote`. Quantitative/page claims remain tied to verified claims; visual modules reference existing responsive visualization manifests rather than recomputing their data.

### Magazine layout engine

The deterministic composer produces a 1440-wide desktop feature and a 720-wide mobile recomposition. It provides display typography, kicker/headline/deck hierarchy, section rhythm, hero statistics, pull quotes, content-driven module heights, a 12-column desktop grid, single-column mobile reading order, page folio, and consolidated sources/methods.

### Page-level quality gate

The infographic critic checks page geometry, visual count, headline/deck density, required source strip, visual embedding, and responsive expectations. A page scores PASS only at 90 or above with no blockers. A deliberately dense regression page now returns 88/100 and REVISE, while the balanced reference and real EIA feature score 100/100.

### Standards-level SVG smoke

The page pipeline is parsed as XML and rasterized through CairoSVG. This caught an actual escaped-ampersand bug that semantic/snapshot tests missed. Raster smoke runs in a temporary directory so release artifacts stay clean.

### Provenance and verification

Infographic manifests retain plan/lint references, upstream visualization manifests, claim IDs, desktop/mobile assets, and SHA-256 hashes. `news verify` independently checks these links and requires a passing infographic critic. The adversarial suite now includes page-byte tampering and missing-upstream-visual attacks.

### Pi/Rust integration

The controlled tool set includes:

- `newsroom_infographic_plan`
- `newsroom_infographic_lint`
- `newsroom_infographic_render`
- `newsroom_infographic_critic`

The Rust runtime embeds/materializes the composer module, the Pi allowlist permits these tools, and the audit capability registry recognizes them. Runtime contract tests check the linkage.

## Real-data evidence

The EIA 2024 reference feature combines three independently verified visual forms with editorial modules:

- primary-energy source mix;
- aggregate energy-flow Sankey;
- selected crude-oil import origins;
- 94.2-quads hero statistic;
- derived 69.5-quads/about-74% pull quote;
- 19.3-quads electrical-system-losses hero statistic;
- section transitions and closing explanation.

The desktop and mobile pages both pass critic and raster smoke after human visual review.

## Final deterministic acceptance

- competition engineering gate: **18/18 PASS**
- integrity adversaries: **12/12 rejected**
- full smoke: **22.31 seconds PASS**
- infographic composer p95: **0.560 ms**
- 41-computation verifier p95: **7.169 ms**

Existing v0.9 capabilities remain green.

## Remaining P0/P1 work

### P0: live provider qualification

The present sandbox cannot run the pinned Rust/Pi/DuckDB stack and has no provider credentials. A final competition claim still requires at least one real two-turn artifact through the actual model/tool loop, followed by `news verify --recompute` and the 18/18 gate.

### P1: Cargo.lock and real Rust compile/clippy

The repository pins Rust but cannot generate `Cargo.lock` here because Cargo is absent. Generate and commit it on the first Rust-enabled environment, then enforce `--locked` in release workflows.

### P1: semantic illustration layer

The v1.0 page composer can combine charts, maps, networks, flows, timelines, and process schematics into magazine pages. It does not generate SCMP-style cutaways, exploded views, architectural sections, or arbitrary semantic illustration. That should be a separate explanatory-graphic adapter with explicit evidence and geometry contracts.

### P1: image-aware editorial critic

The deterministic critic catches structural density and geometry, while XML/raster smoke catches parser/render failures. A future image-aware critic could evaluate visual hierarchy, whitespace, illustration coherence, and subtler collisions that deterministic rules cannot reliably score.

### P1: business-value benchmark

The final competition package still needs a measured human-vs-agent comparison: time to first defensible claim, time to final feature, sources inspected, verified claims, revisions, error/correction rate, provider cost, and total latency.

## Go / no-go

- continue development: **GO**
- deterministic/internal magazine demo: **GO**
- repository/CI release: **GO**
- final competition recording without a live provider artifact: **NO-GO**
- claim of production readiness: **NO-GO**
