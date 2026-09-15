# v1.2 Iteration Plan: Visual-Editor Qualification Loop

## Goal

Close the three highest-value gaps left by v1.1 without replacing the deterministic magazine composer: real-provider E2E qualification, image-aware visual critique, and provenance-aware richer illustration. The release must make these capabilities part of the artifact evidence chain rather than optional side tools.

## Gate 1: Rich illustration contract and provenance boundary

Deliver a vendor-neutral `newsroom_illustration_plan -> lint -> generate -> critic` pipeline. The external generation boundary is an executable adapter that reads one JSON request on stdin and returns one JSON response on stdout. No shell command interpolation is permitted.

Required controls:
- explicit origin policy: `human_only`, `ai_disclosed`, or `software_only`;
- declared origin: human, generative AI, mixed, or software;
- digital source type and creation system/model/version metadata where applicable;
- verified claim IDs and evidence references for factual elements;
- source note, credit, alt text and reader-facing disclosure;
- prompt hash and final asset content hash;
- active SVG rejection for scripts, event handlers, foreign objects and external/data/file/javascript URLs;
- immutable evidence snapshot between lint and generation.

Acceptance: unit tests must pass for normal generation, human-only rejection of AI output, active SVG rejection and provenance critique. Independent artifact verification must reject missing disclosure, stale/missing evidence and hash mutation.

Status: **PASS in deterministic/local tests**.

## Gate 2: Exact-pixel infographic preview

Add `newsroom_infographic_preview` after the deterministic page critic. It must rasterize the exact desktop and mobile SVG bytes, persist content-addressed PNGs, and create a preview manifest binding each PNG to the current SVG hash.

Acceptance: preview generation refuses pages without a passing deterministic critic; raster output is a valid PNG; independent verification rejects stale preview/source hashes; the preview tool returns both images to the active Pi multimodal context.

Status: **PASS in deterministic/local tests**.

## Gate 3: Image-aware visual critic with bounded authority

Add `newsroom_infographic_vision_critic`. The model evaluates hierarchy, legibility, composition, visual coherence, typography, source legibility, responsive quality, illustration integration, color contrast and editorial distinctiveness from the raster previews.

Machine-actionable repairs are restricted to evidence-preserving page properties: `span`, `emphasis`, `priority`, and `move_before`. Unknown module IDs and unapproved patch fields are rejected. A passing visual review requires overall score >= 80, every rubric dimension >= 60 and no blocker.

Acceptance: valid critiques persist as artifact evidence; blocker and low-dimension cases fail; forbidden patches are rejected; independent verification requires the visual critic for new `visual_review_required` pages and confirms that it references a passing deterministic critic and exact current previews.

Status: **PASS in deterministic/local tests**.

## Gate 4: Full visual-editor qualification scenario

Upgrade live qualification from a generic two-turn artifact to a controlled visual-newsroom scenario:

1. intentionally trigger one harmless blocked localhost fetch and recover;
2. analyze the local fixture with deterministic SQL and preserve the mixed-reference-year limitation;
3. create at least two distinct responsive visualizations and pass their critics;
4. create one semantic explanatory graphic and pass its critic;
5. create one rich illustration through the configured adapter and pass its provenance critic;
6. compose an award-target magazine page;
7. pass deterministic page critique;
8. rasterize exact desktop/mobile previews;
9. run image-aware critique;
10. perform at most two bounded repair cycles;
11. execute a second mobile-first editorial turn;
12. run independent verification and SQL recomputation.

Acceptance: `qualification.json` records provider/model, required tool chain, multi-turn context, tool failure/recovery, plan revisions, final rich-illustration status, final image-aware critic status, wall time and token/cost metrics when exposed by Pi.

Status: **HARNESS PASS; real-provider execution pending environment**.

## Gate 5: Provider matrix and comparative evidence

Add a provider-matrix runner that executes the identical qualification brief for each configured provider/model pair and produces JSON plus Markdown comparison. The comparison records pass/fail, wall time, tool calls, failed calls, retries, plan revisions, token/cost metrics when available and illustration-adapter kind.

Acceptance: at least two real multimodal providers must pass the same scenario before an external release can claim provider-qualified autonomy. A mock Pi session or mock illustration adapter can verify control-plane behavior but cannot satisfy this release claim.

Status: **RUNNER PASS; two-provider evidence pending credentials**.

## Gate 6: Competition policy and provenance semantics

Encode the separation between generated illustration capability and competition eligibility. `human_only` must be available for SND-style human-created illustration requirements. AI/mixed output must always carry visible disclosure and system/model provenance. Reuters-style newsroom policies can disable generated visual imagery entirely by selecting a policy that never invokes the AI adapter.

Record C2PA/IPTC-compatible metadata concepts, but describe the current implementation accurately as provenance-aware and C2PA-ready. Full C2PA requires a real signed Content Credential and remains out of scope for this release.

Status: **PASS**.

## Gate 7: Regression and performance

Full smoke must preserve all existing visualization/explainer/page regressions and add rich-illustration, vision-contract, preview-raster and 22-item competition-gate tests. Deterministic renderer performance must remain well inside existing budgets.

Current local evidence:
- rich illustration contract: PASS;
- vision critic contract: PASS;
- infographic raster preview: PASS;
- competition engineering gate: 22/22 PASS;
- integrity adversarial suite: PASS;
- infographic composer p95: < 1 ms in the latest smoke;
- verifier small-artifact p95: < 5 ms;
- verifier scale-artifact p95: < 11 ms.

Status: **PASS**. Final numbers are recorded in `docs/test-report-v1.2.md` after the release smoke.

## Product decision on composer / explainer / page engine

No new Infographic Composer is required in v1.2. No second page-layout engine is required. The existing `InfographicSpec 1.1` composition system already represents the needed editorial semantics and deterministic candidate ranking. The semantic explanatory adapter should remain as the safe diagram layer. The new rich-illustration adapter fills the art-direction gap without weakening evidence controls.

The next likely high-value extension after real provider qualification is a small `infographic_revise` executor that applies only validated visual-critic patches and rerenders automatically. It should be added only if provider traces show that manual plan revision through existing tools creates measurable latency or reliability cost.
