# Infographic Composer Design Spec 1.3

## Purpose

`InfographicSpec` is the provider-independent contract for turning verified claims, approved responsive visualizations and approved semantic explanatory graphics into a coherent magazine feature. It is a presentation protocol. Arithmetic, source truth and claim verification remain upstream in the News Artifact evidence graph.

## Pipeline

```text
verified claims + passed visual/explainer manifests
  -> editorial discovery
  -> VisualConcept tournament
  -> asset plan + semantic novelty gate
  -> InfographicSpec 1.3
  -> deterministic page lint
  -> candidate layouts: balanced | anchor | rhythm
  -> deterministic candidate ranking
  -> desktop/mobile composition
  -> awards-informed page critic
  -> raster review / revision / publish
```

## Editorial intent

A 1.3 feature declares:

- `intent`: what the page should accomplish;
- `primary_message`: the governing takeaway;
- `story_arc`: `explain`, `compare`, `chronology`, `system`, `question_answer` or `profile`;
- `audience`: `general`, `informed` or `specialist`;
- `quality_target`: `publishable` or `award`.

These fields are inputs to layout and critique rather than decorative metadata.

## Module semantics

Every 1.3 module may declare:

- `story_role`: `hook`, `context`, `evidence`, `turn`, `explanation`, `resolution` or `method`;
- `priority`: integer 1–5, where 1 is most editorially important;
- `emphasis`: `hero`, `primary`, `secondary` or `support`.

An award-target feature should have one clear visual anchor, an early hook/evidence path and a readable resolution/explanation path. The composer preserves semantic order while allowing different geometry on desktop and mobile.

## Module types

### `section_header`

Introduces a story act and resets editorial density.

### `hero_stat`

Displays a verified quantitative takeaway. Governed values bind to verified `claim_id` values.

### `visual`

Embeds an already approved `NewsroomVizSpec` render manifest. The page composer never re-computes visual data. Desktop and mobile select the approved viewport from the same canonical evidence.

### `illustration`

Embeds an approved semantic explanatory-graphic manifest produced by `newsroom_explainer_*`. Required fields include `asset_ref`, meaningful `alt`, `credit` and verified `claim_ids` where factual parts are governed. The asset must have a passing explainer critic and mandatory schematic disclosure.

### `text`

Short explanatory copy. Governed factual assertions bind to verified claims.

### `pull_quote`

Highlights a governing editorial takeaway. Claim-bearing copy must bind to verified claims.

## Semantic explanatory graphics

The v1.1 explanatory adapter supports four deterministic views:

- `cutaway`: layered semantic sections with callouts;
- `exploded`: separated component cards along a shared axis;
- `anatomy`: parts arranged around a central subject/spine;
- `system`: verified nodes and explicit relationships.

The adapter encodes semantic parts and relationships, not engineering geometry. Every output must visibly include `SCHEMATIC / NOT TO SCALE`. Factual parts can bind to verified claim IDs. The current adapter is suitable for conceptual systems, policy mechanisms and layered explanations; it does not claim photorealistic reconstruction, exact physical dimensions or bespoke hand illustration.

## Candidate layout system

Desktop composition generates three deterministic, order-preserving candidates:

- `balanced`: favors even row utilization;
- `anchor`: privileges the page's hero/primary module;
- `rhythm`: favors alternation between dense evidence and lighter editorial modules.

Candidates are scored for row utilization, buried high-priority modules, visual-anchor position, dense runs and orphaned support blocks. The chosen strategy and all candidate scores are written to the render artifact so the Agent can explain or revise the layout decision.

Mobile remains a semantic single-column layout with story/emphasis-aware spacing, but 1.2 may declare `mobile_module_order` as an exact permutation of module IDs. Responsive composition can therefore change narrow-screen reading sequence and geometry while leaving desktop order, evidence and claims unchanged.

## Two-speed reading

Magazine features should offer:

1. a fast scan layer: headline, deck, hero stat/visual, section headers and prominent annotations;
2. a deep reading layer: supporting visuals, explainer callouts, body copy, methodology and sources.

Long runs of equally dense modules receive editorial-rhythm penalties. Whitespace and lighter modules are treated as information-design tools rather than unused space.

## Awards-informed critic

For `InfographicSpec 1.3`, the deterministic critic reports ten dimensions:

1. `impact_story_focus`
2. `engagement`
3. `clarity_information_flow`
4. `effectiveness`
5. `hierarchy`
6. `editorial_rhythm`
7. `inclusion_accessibility`
8. `responsive_execution`
9. `craft_geometry`
10. `originality_variety`

`quality_target=award` uses a stricter total threshold and critical-dimension floors. A high average score cannot compensate for weak clarity, hierarchy, rhythm, effectiveness or accessibility. Existing provenance and geometry blockers remain hard gates regardless of aesthetic score.

The rubric is informed by published IIB, SND, Sigma and OJA criteria and by newsroom/editorial practice. It is a deterministic preflight for known failure modes, not a claim that software can predict a human awards jury.

## Provenance requirements

A publishable page must satisfy all of the following:

- every referenced visual or illustration manifest exists;
- upstream lint/critic passed;
- desktop/mobile asset bytes match recorded hashes;
- referenced claims exist and are verified;
- explainer parts use only verified claim IDs when governed;
- `SCHEMATIC / NOT TO SCALE` is present on semantic explanatory assets;
- page plan/lint/manifest/critic references are present;
- page desktop/mobile hashes match the manifest;
- `news verify` accepts the complete artifact.

## Accessibility and responsive quality

Alt text is required for governed visual assets. Mobile output is recomposed rather than merely scaled. The critic checks reading order, source visibility, page geometry and density. Raster smoke remains mandatory because valid SVG structure cannot fully establish visual legibility.

## Competition profile and visual revision

A 1.3 feature declares `competition_profile`: `editorial`, `snd47_infographics`, `oja2026_visual`, `sigma2026`, or `iib_awards`. Profiles carry versioned operational score floors, published source URLs, machine-checkable illustration-origin restrictions and explicit manual requirements. Operational floors are implementation heuristics and must never be presented as official jury thresholds.

After exact desktop/mobile raster preview, the image-aware critic may propose only `span`, `emphasis`, `priority`, `move_before`, or `mobile_move_before`. `newsroom_infographic_revise` applies those fields and records an immutable editorial-evidence hash. The independent verifier replays every patch from the source plan and rejects a final plan that cannot be reconstructed or that changes protected evidence fields.

A final `newsroom_competition_preflight` is bound to the final plan, manifest, deterministic critic and image-aware critic. The independent verifier recomputes machine pass/fail from those artifacts and rich-illustration provenance. Manual requirements remain outstanding even when the machine gate passes.

## Known limits

v1.2 retains the deterministic explanatory layer and adds provenance-aware rich illustration, exact-pixel image review, bounded visual revision and competition-aware preflight. It still does not automate unrestricted bespoke human art direction, photography-aware collage, exact 3D reconstruction or signed C2PA credentials. Live model/provider behavior remains subject to the separate real-runtime qualification gate.


## v1.4 upstream editorial intelligence

Award mode now requires four content-addressed upstream references before composition: `editorial_discovery_ref`, `visual_concept_ref`, `novelty_ref`, and `asset_plan_ref`, plus `selected_concept_id`. Editorial discovery is allowed to stop production with `RESEARCH_MORE`, `REVISE`, or `KILL`. A concept tournament explores 8-20 premises across at least three framings and keeps at most three finalists. The semantic novelty pass makes every planned module state the reader question, claim set, new information and explanatory dimension so repeated reader answers can be removed before they consume page area. The asset plan blocks a finalist when essential GIS, photography, diagrams, expert explanation, coordinates, human-scale reference or verified 3D evidence is missing.

This layer does not alter verified claims. Its role is to decide what deserves to be visualized, which premise has enough reporting support, and which modules add genuinely new understanding. All four upstream artifacts are content-addressed; the independent verifier replays discovery decisions, concept ranking, semantic-overlap decisions and asset-plan state.

## SceneGraph 0.1

InfographicSpec 1.3 adds one bounded scene layer inside the existing composer. A scene references modules already present in the page and never creates a second source of editorial truth. The first two patterns are `hero_sidecar_stack`, which gives an 8-column anchor a 4-column sidecar rail, and `hero_with_rail`, which places a full-width anchor over one to three supporting modules. Scene members retain their original claim and asset references. Desktop may integrate them spatially while mobile continues to use the explicit authored `mobile_module_order`.

The renderer records scene IDs and roles in the output, and module numbering uses canonical editorial order rather than physical geometry order. This prevents viewport-specific numbering drift when a scene places its anchor before a sidecar. Scene membership is validated for unique module ownership, a visual/illustration anchor, bounded sidecar count and supported pattern. Freeform coordinates, arbitrary overlap and unrestricted canvas mutation remain outside the contract.

## Reporting assets, reference patterns and human preference

Reader-facing bespoke assets continue through the provenance-aware illustration boundary. v1.4 adds an asset planner before layout and demonstrates a deterministic `gis_render` lane using public-domain Natural Earth vectors under `software_only`. The source URL, license, credit, source hash and output hash are retained, and the rendered map explicitly states what it does not encode. Human/vector, photography, verified 3D and disclosed generated lanes remain distinct origin classes. Competition policy can reject ineligible origins before composition.

Abstract precedent retrieval stores transferable design patterns and source URLs without storing award artwork bytes. Retrieved patterns must include a differentiation rule so reference use guides problem solving rather than imitation. Qualified-human pairwise preference is stored separately from model scores. A review set with fewer than its predeclared minimum reviewers remains `PENDING`; multimodal critique cannot satisfy that human evidence gate.

## v1.4 release boundary

The deterministic engineering path can be released when prior provenance/integrity gates, new editorial replay tests, SceneGraph geometry tests, real-data NASA regression and performance budgets are green. Autonomous award-mode readiness additionally requires real multimodal-provider qualification and a predeclared qualified-human preference study. Those external evidence gates must remain visible rather than being inferred from deterministic critic scores.
