# v1.1 Iteration Plan: Awards-Informed Editorial Infographic System

## Goal

Upgrade the v1.0 magazine composer from a deterministic multi-module page assembler into an awards-informed editorial composition system. The release must preserve verified provenance and responsive rendering while making editorial intent, hierarchy, pacing, explanatory illustration and candidate-layout reasoning observable and testable.

The plan is informed by Information is Beautiful Awards, Society for News Design, Sigma Awards, Online Journalism Awards, SCMP production practice, Delayed Gratification editorial practice and layout-generation research. Competition rubrics are used as engineering signals, not as claims that a deterministic score predicts an actual jury result.

## Gate 1: Editorial intent protocol

Deliver:
- `InfographicSpec 1.1`
- page fields: `intent`, `primary_message`, `story_arc`, `audience`, `quality_target`
- module fields: `story_role`, `priority`, `emphasis`
- backward-compatible validation for legacy 1.0 plans

Acceptance:
- award-target 1.1 plans require intent, primary message, story arc and audience
- module priority is constrained to 1–5
- narrative roles use a fixed editorial vocabulary
- existing claim/visual provenance requirements remain unchanged

Status: **PASS**.

## Gate 2: Candidate layout generation and ranking

Deliver:
- deterministic desktop candidates: `balanced`, `anchor`, `rhythm`
- order-preserving layout alternatives
- candidate scoring for row utilization, visual-anchor position, priority placement, dense runs and orphan/support blocks
- selected strategy and candidate scores recorded in render metadata

Acceptance:
- at least three candidates are evaluated for a 1.1 feature
- identical inputs produce identical selected strategy and bytes
- priority-1 hero visuals cannot be buried without a critic penalty
- legacy 1.0 pages remain renderable

Status: **PASS**.

## Gate 3: Awards-informed page critic

Deliver ten machine-checkable proxy dimensions:
- impact/story focus
- engagement
- clarity/information flow
- effectiveness
- hierarchy
- editorial rhythm
- inclusion/accessibility
- responsive execution
- craft/geometry
- originality/visual variety

Acceptance:
- critic returns dimension scores and overall score
- `quality_target=award` uses a stricter threshold than `publishable`
- critical dimensions have explicit floors so a high average cannot hide a weak hierarchy or reading flow
- a syntactically valid but editorially flat page receives `REVISE`
- a coherent award-target fixture passes

Status: **PASS**.

## Gate 4: Semantic explanatory graphic adapter

Deliver:
- deterministic `newsroom_explainer_plan -> lint -> render -> critic`
- four semantic views: `cutaway`, `exploded`, `anatomy`, `system`
- mandatory `SCHEMATIC / NOT TO SCALE` disclosure
- verified-claim binding for factual parts
- desktop/mobile SVG variants
- first-class `illustration` module in `InfographicSpec 1.1`

Acceptance:
- all four views pass semantic and raster smoke
- unknown relationships, unverified claim IDs and missing schematic disclosure are rejected
- magazine composer embeds an explanatory asset without bypassing its manifest/critic
- standalone explanatory assets participate in integrity verification and adversarial mutation tests

Status: **PASS**.

## Gate 5: Editorial visual treatment and responsive composition

Deliver:
- explicit visual-anchor treatment
- reduced chrome for hero/primary modules
- story-role-aware spacing
- density-run reset spacing
- clear section transitions
- desktop/mobile preserved semantic reading order
- raster review for final page and explanatory assets

Acceptance:
- no module overlap or clipping
- source/method strip remains visible
- CJK wrapping remains green
- desktop/mobile feature preserve the same governed evidence
- visual hierarchy remains legible after rasterization

Status: **PASS**.

## Gate 6: Real-data feature and release regression

Upgrade the EIA 2024 magazine feature to the 1.1 narrative protocol and embed a semantic energy-balance cutaway alongside verified quantitative visuals.

Acceptance:
- desktop/mobile real-data feature passes lint and award critic
- candidate layout diagnostics are recorded
- explanatory illustration provenance is verified
- legacy 21 visualization families remain green
- competition engineering evaluator reaches 20/20
- 14 adversarial integrity mutations are rejected
- infographic p95 remains below 15 ms
- standalone explanatory pipeline p95 remains below 8 ms
- full deterministic smoke stays below one minute

Status: **PASS in deterministic/local runtime**. Live Rust/Pi/provider/DuckDB qualification remains a separate environment-dependent release gate.

## Release boundary

v1.1 implements a deterministic semantic explanatory layer; it does not claim bespoke SCMP-equivalent human illustration, engineering-accurate cutaways, photorealistic reconstruction, photography-aware art direction or a vision model capable of replacing an art director. The award critic is a structured preflight against known editorial failure modes. Human or image-aware review remains required for emotional coherence, illustration quality and competition-level finish.
