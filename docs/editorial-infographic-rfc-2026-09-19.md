# RFC: Evidence-bound editorial infographic compiler

Date: 2026-09-19
Status: Accepted for staged implementation
Branch: `feat/complex-infographic-audit`

This RFC is the single execution plan for the next iteration. It reconciles
`next-iteration-plan-2026-09-19.md`,
`iteration-3-complex-data-story-plan-2026-09-19.md`, the v1.8 completion audit,
and the supplied editorial-visual-intelligence research. Those documents remain
unchanged as historical inputs.

## Outcome

A normal-language CLI request must be able to produce a traceable, offline,
self-contained data story whose final deliverables are HTML and desktop/mobile
PNG. JSON is an internal contract and audit format, never the final infographic.

The compiler pipeline is:

`Brief -> Evidence Ledger -> FactGraph -> ClaimGraph -> FactSignature -> Editorial Grammar Selection -> Storyboard -> SceneGraph -> RenderPlan -> Capability Routing -> Deterministic Rendering -> Validators -> Local Patch / Incremental Recompile -> Human Review -> Publish`

The invariant across that pipeline is:

`Source -> Fact -> Calculation -> Derived Fact -> Claim -> GraphicObject -> Pixel`

Every published quantitative pixel must be traceable backwards through that
chain. A model may propose references and composition, but it may not invent a
quantity or grant verification status.

## Contract boundaries

`visual_grammar` remains a module-level analytical encoding family such as
`trend`, `flow`, `spatial`, `network`, or `mechanism`.

`editorial_grammar` is a separate project-level composition contract. A project
has exactly one primary grammar and at most two supporting grammars. The MVP
registry contains `CUTAWAY`, `SCALE_TRANSLATOR`, `MECHANISM_FLOW`,
`SPECIMEN_GRID`, `THEN_NOW`, and `ROUTE_SPINE`.

Map, Sankey, network, and trend views may coexist as evidence modes serving one
reader question. They are not four competing heroes, and chart-count diversity
is not a quality gate.

## Staged delivery

### P0 — Baseline and plan convergence

- Preserve uncommitted user files and licensing boundaries.
- Require the main CI and visual-runtime workflows to be green before claiming
  a release baseline.
- Use this RFC as the sole forward execution plan.

### P1 — Fact contracts

- Add FactGraph, ClaimGraph, and FactSignature schemas.
- Permit quantities only from source extraction, database query, deterministic
  calculation, or measurement.
- Compute publish verification from resolved sources, successful extraction,
  replayed computation, and supported claims. Model-authored `verified` flags
  have no authority.

### P2 — Editorial grammar selection

- Maintain a versioned six-grammar registry and compatibility matrix.
- Apply hard constraints, renderer capability filtering, then soft ranking.
- Record exactly three candidates and one final selection with reason codes.
- Lint primary/supporting cardinality, candidate uniqueness, compatibility,
  hard constraints, and renderer availability deterministically.

### P3 — Cognitive storyboard and scenes

- Add `primary_cognitive_goal`, `hero_object_id`, `supporting_claim_ids`, and a
  bounded `scene_budget`.
- Use `ORIENT`, `ZOOM`, `EXPLAIN`, `MEASURE`, `COMPARE`, and `CONSEQUENCE`.
- Default each scene to one cognitive goal and one hero.

### P4 — Validators and severity

Implement `annotation_target_validator`, `visual_channel_owner_validator`,
`misleading_quantitative_validator`, `scene_cognitive_budget_validator`, and
`grammar_compatibility_validator`. Use only `FATAL`, `ERROR`, `WARNING`, and
`INFO`. Run gates in this order: schema, provenance, claims, quantitative,
grammar, narrative, accessibility, layout, misleading visualization,
multimodal critic, human review.

### P5 — System-derived verification

Publication verification is the conjunction of source resolution, extraction,
computation replay, and claim support. Drafts may include unverified material;
publishable factual quantitative visuals may not.

### P6 — Bounded repair

Use replayable, reversible, RFC-6902-like patches addressed to an explicit
scene/object/path and validator rule. Patches may change presentation only;
facts, SQL, claims, and evidence are immutable. Recompile only affected nodes
and viewports.

### P7 — One-prompt flagship acceptance

Run the CLI from a clean output directory with one ordinary user request. The
flagship subject is four decades of international migration. Prefer the public
paper data/code path; otherwise use an authoritative bilateral migrant-stock
source and record why. Keep migrant stock, stock change, and estimated migration
flow semantically distinct.

The proposed project grammar is `ROUTE_SPINE`, supported by `THEN_NOW` and
`SCALE_TRANSLATOR`. The scene sequence is `ORIENT -> ZOOM -> MEASURE -> COMPARE
-> CONSEQUENCE`. The hero is a world GIS route/bubble view; regional composition,
time comparison, and a bounded network detail are supporting evidence modes.

Save command, environment versions, source URL/license/download time/hash, tool
trace, failures and recovery, HTML/SVG/PNG/manifest/QA report, artifact hashes,
and desktop/mobile screenshots. Never hand-edit generated output.

## Release gates

- FactGraph schema pass: 100%; claim provenance: 100%.
- Unsupported quantitative facts, hard grammar violations, misleading
  quantitative encodings, mobile overflow, blank modules, and unbound
  annotations: zero.
- Exactly one primary editorial grammar and no more than two supporting ones.
- CLI exit code 0; non-empty self-contained HTML and desktop/mobile PNG.
- Valid pixels at 390, 768, 1024, and 1440 px; no external requests or
  unhandled console errors; readable no-JS fallback.
- Every data module binds source, claim, and computation.
- Identical data/configuration produces semantically equivalent output.

Human quality targets are: primary grammar acceptance at least 85%, storyboard
without major restructure at least 80%, first render needing only local repair at
least 70%, and median repair iterations no more than two.

## Explicit deferrals

This iteration does not add a 50-case retrieval corpus, a large multi-agent
system, twenty visual primitives, Blender/3D/Illustrator automation, AI-created
quantitative geometry, a second page-layout engine, or surface imitation of any
publication. Linux-specific expansion is also out of scope.

The iteration proves one chain: `Meaning -> Grammar -> Scene -> Accurate Graphic`.

## Implementation status — 2026-09-21

Completed in the current working tree:

- P0: this RFC is the single forward plan; the two input plans remain preserved.
- P1: FactGraph, ClaimGraph, and FactSignature schemas plus deterministic
  quantity-origin and system-verification runtime gates.
- P2: six-grammar registry, three-candidate selection, compatibility matrix,
  hard-constraint and renderer filters, deterministic soft scoring, and decision
  record lint. Candidate pass flags and scores are recomputed rather than trusted.
- P3: InfographicSpec 1.5 and SceneGraph 0.2 with `primary_cognitive_goal`,
  `hero_object_id`, `supporting_claim_ids`, and bounded scene budgets. Existing
  InfographicSpec 1.0–1.4 and SceneGraph 0.1 inputs remain supported.
- P4 first gate set: annotation target, visual channel owner, misleading
  quantitative encoding, scene cognitive budget, and editorial grammar
  compatibility validators. All emit only `FATAL`, `ERROR`, `WARNING`, or `INFO`.
- P5: `record_claim` no longer exposes `verified`, visualization planning no
  longer exposes a verification-mode selector, computations are replayed before
  the runtime grants publication status, and both Rust and Python artifact
  verifiers reject a bare/model-forged `status: verified`.
- P6: ArtDirectionPatch 2.1 uses validator-addressed scene/object/JSON-path
  operations, presentation-only path allowlists, conflict detection, recorded
  before/after diffs, generated inverse patches, rollback, and affected
  scene/object/viewport recompilation scope.
- Flagship data foundation: a deterministic, source-locked fixture from the
  published 1990–2023 model-estimated migration flows, with stock/stock-change/
  observed-flow semantic guards and a separate GPL-3.0 data boundary.
- P7 has now exercised the real workflow from multiple clean output roots with
  the ordinary Chinese flagship request and the frozen CSV passed through
  `--data`. The deepest run completed deterministic calculations, system-verified
  claims, StoryGraph, and three responsive visual pipelines: world flow map,
  role-qualified regional Sankey, and decade comparison (all three critics scored
  96/100). It also reached editorial discovery and the visual-concept tournament.
  Completion gates correctly rejected attempts to substitute individual SVGs,
  prose, Lieflat fallback, or a simplified publication for the requested composed
  HTML. No generated artifact was hand-edited.
- Real-run blockers closed with runtime fixes and CI regressions include browser
  QA bootstrap/Chrome discovery, explicit requested-visual-mode enforcement,
  unsupported causal copy, role-qualified reciprocal Sankey nodes, DuckDB access
  to computation-envelope rows, actionable editorial-grammar recommendations,
  completion-retry routing context, and explicit editorial-preflight ordering.
  `Sankey 构成` is treated as one flow module answering a composition question,
  rather than forcing an unrelated fourth hero chart.
- Subsequent clean runs are currently externally blocked: the configured
  DragonCode route authenticates as ready, but a minimal no-tool request returns
  HTTP 502 `Upstream access forbidden, please contact administrator`. Pi exhausts
  its bounded internal retries. The CLI now distinguishes that provider failure
  from a genuinely empty successful answer while continuing to suppress raw
  diagnostics and secrets.
- Current automated evidence: 87 Rust tests passing (one external test ignored),
  OpenAI/Anthropic wire mocks passing, control-plane acceptance and recovery
  passing, Fact/Editorial/Migration IR suites passing, manifest reproducibility
  passing, and the PR profile passing all 16 checks under the project test venv
  after installing the same pinned `basemap==2.0.0` and `matplotlib==3.10.8`
  versions used by CI.

Next execution slice:

1. Re-run the unchanged flagship request only after the configured endpoint
   returns a successful minimal no-tool request; retain the clean-output rule.
2. Complete infographic composition, publication rendering, four-viewport browser
   QA, independent recomputation, and offline/network-zero inspection without
   manual artifact edits.
3. Close every remaining post-startup blocker with the same root-cause → minimal
   fix → regression → CI → clean rerun loop.
