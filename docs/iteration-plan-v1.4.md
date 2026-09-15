# Iteration Plan v1.4

## Theme

**Editorial Intelligence + Scene Art Direction**

v1.4 moves the primary optimization target upstream. v1.3.1 already demonstrates a trustworthy production substrate: evidence-bound claims, deterministic rendering, responsive composition, exact-pixel review, bounded visual revision, competition policy and independent verification. The dominant gap to SCMP-, Delayed Gratification-, National Geographic- and top SND/IIB-level work is now concept discovery, reporting depth, story-specific visual language and scene-level synthesis.

The release should therefore improve the quality of decisions made before polished rendering, then give the existing Infographic Composer enough scene-level primitives to execute those decisions without creating a second editorial authority.

## Execution status

Deterministic execution completed through Milestones A-D and the infrastructure portion of Milestone E. EditorialDiscovery, 8-candidate VisualConcept search/pruning, semantic novelty, reporting-gap asset planning, two bounded SceneGraph prototypes, Natural Earth GIS provenance intake, abstract reference retrieval, expert-preference capture and a slow-award status artifact are implemented. NASA, EIA energy-flow and Titanic editorial regressions exercise the new upstream logic.

Milestone E's external human preference result remains `PENDING`: the project records and independently verifies qualified judgments but no reviewer votes were fabricated in this environment. Milestone F's deterministic smoke/integrity/performance work is complete; two-provider Rust/Pi/DuckDB qualification remains blocked by the local runtime/credential gap recorded in `docs/live-readiness-v1.4.json`. The release may therefore be treated as a deterministic engineering baseline and internal art-direction R&D build, not as autonomous award-mode qualification.

## Product objective

For `quality_target=award`, the system should be able to:

1. discover several materially different editorial premises from the same evidence package;
2. identify missing reporting or assets that would materially improve the visual story;
3. generate and reject multiple story-specific visual concepts before selecting a composition;
4. detect semantically redundant modules before they consume page area;
5. compose one dominant visual scene with attached sidecars, callouts and evidence modules;
6. preserve all existing provenance, competition-policy and independent-verification guarantees;
7. expose human art-director checkpoints where machine judgment is intrinsically weak;
8. demonstrate measurable improvement over v1.3.1 on expert preference, memorability proxies, semantic novelty and page integration without material performance regression.

## Architectural principle

Keep one evidence graph and one Infographic Composer.

The new pipeline should be:

```text
reporting package + verified evidence
  -> editorial discovery
  -> reporting-gap analysis
  -> VisualConcept candidate set
  -> concept pruning / restart
  -> selected VisualConcept
  -> scene-aware InfographicSpec
  -> deterministic lint + candidate generation
  -> raster preview
  -> image-aware / expert-preference critique
  -> bounded revision
  -> independent verification
  -> competition preflight
```

`VisualConcept` sits before `InfographicSpec`; scene primitives extend the existing composer rather than creating a parallel page engine.

## Priority 0: run the missing real-provider qualification

### Why

Real multimodal provider behavior remains an unclosed evidence gap. Before attributing every remaining limitation to architecture, run at least two providers on the same award-target scenario and measure whether they can reliably generate, prune and revise concepts under the existing tool contract.

### Deliverables

- pinned Rust / Pi / DuckDB / CairoSVG runtime;
- identical provider-matrix scenario across at least two multimodal providers;
- trace capture for tool errors, retries, plan revisions, cost, latency and visual-critic patches;
- retained qualification artifacts bound to provider/model identifiers.

### Acceptance criteria

- two complete end-to-end qualification traces;
- controlled failure/recovery observed;
- exact raster preview observed;
- at least one justified bounded revision observed;
- final independent verification passes;
- result comparison clearly separates provider limitations from architecture limitations.

### Release rule

Provider qualification is evidence gathering and should not block deterministic development of the remaining v1.4 items, but v1.4 must not claim autonomous award-mode readiness without it.

## Priority 1: Editorial Discovery engine

### Goal

Move story selection into a first-class machine-readable stage before chart selection and page layout.

### New object: `EditorialDiscovery`

Recommended fields:

- `reader_problem`
- `candidate_questions[]`
- `surprises[]`
- `counterintuitive_findings[]`
- `human_scale_refs[]`
- `spatial_dimensions[]`
- `temporal_dimensions[]`
- `mechanisms[]`
- `uncertainties[]`
- `missing_reporting[]`
- `kill_reasons[]`

The engine should search for facts that change the reader's mental model instead of merely ranking statistically strong claims.

### Required behaviors

- generate 5 to 12 candidate reader questions for award mode;
- identify which questions are already obvious from the headline data;
- surface surprising contrasts, mechanisms, spatial structure and human-scale references;
- explicitly return `RESEARCH_MORE`, `REVISE`, `KILL` or `CONTINUE` decisions;
- request missing data/assets when the strongest visual premise cannot be supported by the current evidence package.

### Acceptance criteria

- NASA fixture produces at least three materially different viable story premises;
- at least one premise requires additional spatial/reporting input rather than recycling the annual trend;
- a deliberately thin dataset triggers `RESEARCH_MORE` instead of a forced magazine page;
- discovery output is deterministic-schema validated and content-addressed.

## Priority 2: VisualConcept Studio

### Goal

Create the missing abstraction between editorial premise and page composition.

### New object: `VisualConcept`

Each concept should contain:

- `concept_id`
- `reader_question`
- `editorial_premise`
- `surprise`
- `visual_metaphor`
- `hero_scene`
- `hero_evidence_refs[]`
- `supporting_evidence_refs[]`
- `asset_requirements[]`
- `media_mix[]`
- `information_hierarchy`
- `mobile_treatment`
- `risk_flags[]`
- `reporting_gaps[]`
- `why_memorable`
- `why_reject`

### Award-mode search budget

Generate 8 to 20 concept candidates. Require diversity across at least three dimensions such as spatial vs temporal framing, object/scene vs abstract chart grammar, comparison vs mechanism, static vs progressive reveal. Prune to 2 to 3 finalists before any polished page rendering.

### Concept tournament

Use pairwise comparison rather than one absolute rubric score. Evaluate:

- story specificity;
- information gain;
- visual distinctiveness;
- evidence coverage;
- medium fit;
- memorability potential;
- feasibility with available assets;
- competition eligibility;
- mobile viability.

The system should be rewarded for killing a technically adequate but generic concept.

### Acceptance criteria

- NASA award mode never proceeds directly from claims to the current generic module stack;
- at least 8 concepts are generated, at least 5 are rejected with explicit reasons, and no more than 3 reach page prototyping;
- pairwise result is replayable from stored concept inputs and comparison output;
- concept selection cannot modify verified claims or source provenance.

## Priority 3: Semantic novelty and redundancy scorer

### Goal

Make every module earn its page area by adding a new explanatory dimension.

### Proposed model

Every planned module declares:

- `reader_question_id`
- `claim_set`
- `new_information`
- `explanatory_dimension`: `trend | rank | spatial | mechanism | comparison | distribution | uncertainty | human_scale | method | context`
- `dependency_on[]`

Compute pairwise semantic overlap between modules. Penalize repeated claim sets and repeated reader answers even when chart marks differ. Reward complementary dimensions.

### Practical rule

For award mode, any module whose primary message is already recoverable from a prior module with high confidence should either:

- be removed;
- be demoted to an inset;
- or justify itself through a genuinely different explanatory dimension.

### Acceptance criteria

- NASA line + top-ten ranking is flagged as materially redundant;
- replacing the ranking with a spatial/baseline/mechanism module increases novelty score;
- false positives are bounded through fixtures where repeated claims are intentionally needed for overview/detail transitions;
- scorer is deterministic or uses a model only for candidate judgment with a deterministic stored decision boundary.

## Priority 4: Scene-level art direction inside the existing Composer

### Goal

Allow the page to become one authored visual object rather than a sequence of self-contained cards.

### Add a `SceneGraph` layer to InfographicSpec

Initial primitives should stay deliberately small:

- `scene`
- `anchor`
- `sidecar`
- `annotation_rail`
- `shared_coordinate_space`
- `leader`
- `z_index`
- `bleed`
- `crop`
- `mask`
- `nested_callout`
- `text_wrap_zone`

Do not begin with arbitrary freeform canvas mutation. Every primitive needs bounded geometry and evidence references.

### First supported patterns

1. hero map/illustration with attached statistical sidecars;
2. hero timeline with inset mechanism explainer;
3. object/architecture scene with data labels attached directly to parts;
4. map + observation network + mini-chart rail;
5. full-width hero scene with one evidence inset and one methodology rail.

### Candidate ranking upgrades

Add image-aware candidate signals for:

- occupancy quality;
- visual center of gravity;
- eye-path continuity;
- dominant-shape clarity;
- cross-module alignment;
- local density vs breathing-room balance;
- sidecar usefulness;
- source/method visibility.

These scores remain advisory for aesthetics. Geometry, provenance and accessibility stay deterministic blockers.

### Acceptance criteria

- NASA redesign can use one dominant spatial/observation scene with line/heatmap sidecars;
- no independent card title/source box is required when a subview shares one scene-level title and source scope;
- desktop white-space imbalance detected in v1.3.1 can be filled only when a sidecar adds new information, not to maximize occupancy mechanically;
- scene revisions remain replayable and cannot mutate protected evidence.

## Priority 5: Reporting-gap and asset planner

### Goal

Teach the agent to ask for the material that elite visual teams normally acquire before design settles.

### Asset classes

- published GIS / basemap geometry;
- archival photography;
- verified diagrams / engineering drawings;
- human portraits / object photography;
- subject-matter expert explanation;
- geographic coordinates;
- historical comparison series;
- human-scale reference quantities;
- vector illustration brief;
- optional verified 3D asset.

### Required behavior

For every finalist VisualConcept, produce `asset_requirements` with `required`, `optional` and `blocking` status. When a concept depends on unavailable evidence, the system should either request research or reject the concept.

### Acceptance criteria

- no invented map geometry, building structure or physical reconstruction;
- missing spatial evidence can block a spatial concept;
- all accepted external assets carry source, license, credit, origin and content hashes;
- competition profiles can reject ineligible origins before layout work begins.

## Priority 6: Bespoke illustration and human-art production lane

### Goal

Preserve the deterministic explainer for factual schematics while supporting award-level authored art.

### Lanes

- `software_schematic`
- `human_vector`
- `human_illustration`
- `gis_render`
- `photo_collage`
- `verified_3d`
- `generated_disclosed` where publisher and competition policy permit it

### Workflow

`brief -> source pack -> artist/adapter -> asset intake -> origin/license validation -> visual review -> scene placement -> independent verification`

### Acceptance criteria

- human/vector assets can enter without losing provenance;
- SND-target profile rejects generated/mixed final illustration where rules require it;
- credit and source remain visible in page metadata and export;
- mock adapters never qualify art quality.

## Priority 7: Curated abstract reference corpus

### Goal

Give concept generation access to world-class precedent without cloning copyrighted visual identity.

### Reference schema

Store only abstract transferable attributes:

- story problem;
- dominant visual premise;
- evidence topology;
- asset mix;
- density strategy;
- annotation strategy;
- spatial scaffold;
- mobile treatment;
- interaction model;
- memorable device;
- failure modes;
- why it worked;
- source URL and competition/publication metadata.

### Retrieval policy

Retrieve references before concept generation and again during critique. Require the model to state both the transferable principle and how the proposed concept materially differs from the reference.

### Acceptance criteria

- no stored copyrighted artwork bytes are required for concept retrieval;
- concepts cannot pass by simply naming a reference publication;
- duplicate/reference-copy risk is explicitly scored;
- corpus contains representative SND, IIB, OJA, Sigma, SCMP, Delayed Gratification, Reuters, NYT, National Geographic and The Pudding patterns.

## Priority 8: Slow award mode

### Goal

Create a deliberate search budget separate from the fast publishable pipeline.

### Proposed stages

1. research expansion;
2. editorial discovery;
3. 8 to 20 concept candidates;
4. thumbnail / wireframe prototypes;
5. pairwise concept tournament;
6. one forced restart if all finalists are generic;
7. two scene-level page candidates;
8. desktop/mobile raster review;
9. bounded art-direction revision;
10. human checkpoint;
11. final verification and competition preflight.

### Budget controls

Track:

- number of concepts generated;
- concepts killed;
- research-gap requests;
- prototype count;
- raster revisions;
- provider tokens/cost;
- wall time;
- human review count.

Award mode should optimize for final concept quality under a bounded budget, not minimum latency.

## Priority 9: Expert-preference evaluation

### Goal

Stop treating rubric totals as the only quality signal.

### Evaluation design

Collect pairwise judgments from experienced information designers / editors on:

- which concept is more story-specific;
- which page has stronger visual hierarchy;
- which page uses space more intentionally;
- which page has more coherent visual voice;
- which page adds more information per area;
- which page is more memorable after a delay;
- which page would be more likely to survive award-jury discussion.

Use deterministic metrics only where objective: overlap, clipping, source visibility, contrast, responsive geometry, performance, provenance. Keep aesthetic preference probabilistic and separately reported.

### Acceptance criteria

- v1.4 NASA redesign wins at least 70% of blinded pairwise comparisons against v1.3.1 among qualified reviewers, with a minimum reviewer count established before testing;
- preference data is stored independently from model self-scores;
- image-aware critic calibration can be compared against human preference rather than absolute rubric totals.

## Priority 10: Real-data benchmark suite for editorial quality

### Goal

Test more than renderer correctness.

Keep NASA GISTEMP, then add at least three archetypes:

1. **spatial causal story**: map plus mechanism plus chronology;
2. **flow/system story**: additive or process network with human-scale explanation;
3. **people/object story**: recognizable subject matter, ranking or comparison attached to physical scale;
4. optional **high-density temporal story**: small multiples / annotated timeline / distribution.

Each benchmark should include:

- source package;
- reporting gaps intentionally left discoverable;
- target reader questions;
- expected redundant modules;
- at least one high-value concept direction;
- prohibited generic treatment;
- desktop/mobile outputs;
- deterministic gate results;
- human pairwise preference result.

NASA becomes the first editorial-quality regression: v1.4 should demonstrate that the ranking is removed or strongly demoted unless it adds new information, and that the main scene integrates at least three evidence types.

## Priority 11: Smoke, integrity and performance hardening

### New smoke layers

Add tests for:

- EditorialDiscovery schema and kill/research paths;
- VisualConcept diversity and pruning;
- redundancy detection;
- SceneGraph geometry and provenance;
- sidecar placement constraints;
- scene-level responsive variants;
- asset-origin policy;
- concept/revision replay;
- forged concept-selection evidence;
- stale/mismatched scene asset references;
- human-checkpoint presence for award mode.

### Performance budgets

Do not optimize the slow award-mode search loop for sub-second completion. Keep strict budgets for deterministic infrastructure:

- module-level renderer p95: preserve current budgets;
- SceneGraph deterministic layout p95: <= 5 ms for 20 scene elements;
- scene verifier p95: <= 20 ms for ordinary artifacts;
- redundancy scorer deterministic pass: <= 5 ms for 30 modules;
- raster preview budget reported separately because it is environment-dependent.

Track model cost and latency as quality-budget metrics rather than renderer performance metrics.

## Milestones

### Milestone A: upstream intelligence

Implement EditorialDiscovery, ReportingGap and VisualConcept schemas, plus concept generation/pruning. No scene-layout changes yet.

**Exit:** NASA produces multiple materially distinct concepts, rejects generic ones, and flags redundant modules.

### Milestone B: semantic economy

Implement novelty/redundancy scoring and integrate it into story planning.

**Exit:** current NASA ranking is rejected/demoted unless independently justified; module count can decrease while information coverage increases.

### Milestone C: scene art direction

Implement the minimal SceneGraph primitives and two scene patterns. Preserve one composer.

**Exit:** NASA can be rendered as one dominant scene with integrated supporting evidence on desktop and an authored scene sequence on mobile.

### Milestone D: asset depth

Implement reporting-gap asset requests and human/GIS/vector intake.

**Exit:** one benchmark incorporates a sourced non-chart hero asset with complete provenance and competition-policy validation.

### Milestone E: expert preference loop

Implement pairwise review capture, slow award mode and calibration reports.

**Exit:** blinded reviewers prefer v1.4 NASA output to v1.3.1 baseline at the predefined threshold; model critic agreement is measured rather than assumed.

### Milestone F: release qualification

Run full deterministic smoke, integrity adversaries, real-data benchmark suite and two-provider qualification.

**Exit:** no provenance regression; all prior v1.3.1 release gates remain green; new editorial-quality gates pass; provider traces retained.

## Success metrics

v1.4 should be judged by a mixed scorecard rather than one synthetic award score.

### Correctness floor

- 100% independent verification pass on release fixtures;
- zero protected-evidence mutations through concept/layout revision;
- existing competition and integrity gates remain green.

### Editorial intelligence

- >= 8 concept candidates in award mode;
- >= 50% rejected before polished rendering;
- at least one `RESEARCH_MORE` path exercised in regression;
- measurable reduction in semantic redundancy on NASA and at least two new benchmarks.

### Integration / art direction

- at least one scene-level hero composition per award benchmark;
- at least three evidence types can share one visual scaffold;
- no forced card boundary between every subview;
- mobile can use authored scene sequence rather than pure module stacking.

### Human preference

- >= 70% blinded pairwise preference for v1.4 over v1.3.1 NASA baseline;
- reviewer disagreement retained and reported rather than collapsed into false certainty.

### Efficiency

- deterministic scene/layout/verifier operations remain within stated budgets;
- model token/cost growth is bounded by explicit award-mode budgets;
- fast `publishable` mode preserves the current lightweight path.

## Deliberately deferred

### Second Infographic Composer

Rejected. It would duplicate editorial authority and provenance logic without addressing the dominant gap.

### Large chart-family expansion

Deferred unless a benchmark exposes a reader task that the current visual vocabulary genuinely cannot express.

### Full freeform canvas editor

Deferred. Start with bounded scene primitives that can be verified and replayed.

### Browser/scrollytelling engine

Deferred until a selected concept genuinely requires browser-native interaction. When needed, implement `InfographicSpec/SceneGraph -> semantic HTML/SVG -> Playwright audit` as an output adapter, not a new editorial source of truth.

### General-purpose 3D engine

Deferred. Add verified 3D as an asset lane only when a reporting problem requires physical reconstruction and reliable geometry exists.

### End-to-end autonomous award submission

Rejected as a v1.4 claim. Human originality, authorship, public-interest judgment, sensitive framing and final art direction remain explicit manual checkpoints.

## Recommended implementation order

1. Real-provider qualification in parallel with deterministic development.
2. EditorialDiscovery + ReportingGap schema.
3. VisualConcept generation and tournament.
4. Semantic novelty/redundancy scorer.
5. Minimal SceneGraph + sidecar/annotation-rail primitives.
6. Human/GIS/vector asset intake.
7. Slow award mode.
8. Expert pairwise evaluation and critic calibration.
9. Expand real-data editorial benchmark suite.
10. Only then decide whether browser-native publication or richer 3D/photography tooling is the next bottleneck.

## Go / no-go gates

**GO to v1.4 release** only when:

- previous correctness/provenance gates stay green;
- NASA award-mode output demonstrates concept search and scene-level synthesis;
- redundancy scorer removes at least one low-information module in a real fixture;
- at least one externally sourced visual asset is admitted through the provenance pipeline;
- human preference shows material improvement over v1.3.1;
- no new layout authority bypasses independent verification.

**NO-GO** if the release merely adds more chart types, increases rubric scores without improving human preference, fills whitespace without adding information, or introduces freeform visual edits that cannot be independently replayed.
