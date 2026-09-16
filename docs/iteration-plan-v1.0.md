# v1.0 Iteration Plan: Magazine-Grade Infographic Composer

## Goal

Upgrade Agentic Data Newsroom from a single-visual renderer into a magazine-grade editorial composition system. The Agent should be able to turn a set of verified claims and already-linted newsroom visuals into one coherent multi-module infographic with explicit hierarchy, typography, reading order, responsive recomposition, provenance, and an editorial quality gate.

## Non-goals

- No proprietary media style cloning.
- No free-form illustration model in v1.0.
- No unverified text or decorative numbers.
- No raster-only output as the canonical artifact.
- No hidden data transformations inside the composer.

## Gate 1: Infographic protocol and story planner

Deliver:
- `schemas/infographic-spec.schema.json`
- `runtime/pi/infographic.mjs`
- `InfographicSpec 1.0`
- module types: `hero_stat`, `visual`, `text`, `section_header`, `pull_quote`
- spans: `full`, `two_thirds`, `half`, `third`
- layouts: `feature`, `poster`, `briefing`
- deterministic validation and lint

Acceptance:
- verified claims required for quantitative/text modules
- visual modules reference existing visualization manifests
- visual critic status must be passed before a visual can enter a publishable infographic
- module IDs unique
- sensible module-count and text-length budgets

## Gate 2: Magazine layout engine

Deliver desktop and mobile SVGs from the same spec.

Desktop:
- 1440px editorial page
- 12-column grid
- greedy deterministic row packing
- kicker, headline, deck, byline/folio, section rhythm
- hero number modules
- full/2/3/1/2/1/3 visual widths
- consolidated source strip

Mobile:
- 720px page
- single-column reading order
- mobile visual variants embedded automatically
- independent typography and spacing scale

Acceptance:
- minimum type sizes enforced
- no module overlap
- no page-level clipping
- deterministic output bytes for same spec/assets
- CJK-aware title/deck wrapping

## Gate 3: Editorial critic and geometry smoke

Deliver:
- deterministic infographic critic
- geometry checks for page overflow, module overlap, source/footer presence, visual count, headline density, and mobile readability
- visual snapshot regression for desktop/mobile

Acceptance:
- intentionally cluttered page fails or receives REVISE
- balanced feature page passes
- no visual module accepted when its upstream critic failed

## Gate 4: Real-data magazine feature

Build one coherent real-data feature using existing verified EIA fixtures:
- hero stat: 94.2 quadrillion Btu total U.S. energy consumption in 2024
- Sankey: sources to end use/losses
- hero stat: 19.3 quadrillion Btu electrical-system losses
- horizontal bar: primary energy source mix
- Geo Flow Map: selected crude-oil import origins
- short editorial explainer text

Acceptance:
- desktop and mobile feature both render
- every number is traceable to a claim or existing verified visual
- human visual review after rasterization
- output should read as one page, not a stack of unrelated chart cards

## Gate 5: Runtime integration and performance

Deliver Pi tools:
- `newsroom_infographic_plan`
- `newsroom_infographic_lint`
- `newsroom_infographic_render`
- `newsroom_infographic_critic`

Update:
- Rust Pi allowlist
- audit capability registry
- runtime contract tests
- competition evaluator
- main smoke chain

Performance budgets:
- composer desktop+mobile p95 < 12 ms on regression fixture
- infographic critic p95 < 5 ms
- existing visualization benchmark budgets must remain green
- full smoke should remain comfortably below one minute in the local Node/Python environment

## Release criteria

v1.0 may be called magazine-grade only if:
1. one real-data multi-module feature passes lint and critic on desktop/mobile;
2. page composition has explicit hierarchy and responsive recomposition;
3. upstream verified visual provenance is preserved;
4. snapshot and geometry regression tests pass;
5. existing v0.9 visual/provenance tests remain green;
6. known limits are documented, especially semantic illustration/cutaway graphics.

## Execution result

All five implementation gates passed in the final deterministic release smoke.

- Gate 1, protocol/story planner: PASS
- Gate 2, desktop/mobile magazine layout engine: PASS
- Gate 3, page critic + snapshots + XML/raster smoke: PASS
- Gate 4, real-data EIA magazine feature: PASS
- Gate 5, Pi/Rust integration + performance + evaluator: PASS

Final release measurements: competition gate 18/18, integrity adversaries 12/12 rejected, infographic composer p95 0.560 ms, full smoke 22.31 seconds. Live Rust/Pi/DuckDB/provider qualification remains an external release-evidence blocker and is intentionally excluded from these deterministic gate results.
