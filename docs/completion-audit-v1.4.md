# v1.4 Completion Audit

## Executive assessment

v1.4 successfully moves the award-mode bottleneck upstream from chart production toward editorial discovery, concept search, semantic economy and bounded scene-level art direction. The existing evidence graph, visualization runtime, Infographic Composer and independent verifier remain authoritative. No second page engine was introduced.

The release is a deterministic engineering and internal art-direction R&D baseline. It is not an autonomous award-mode qualification. Qualified-human preference is explicitly `PENDING`, and real Rust/Pi/DuckDB multimodal-provider qualification cannot run in the current environment.

## Implemented

### Editorial Discovery and VisualConcept search

`runtime/pi/editorial.mjs` adds content-addressed EditorialDiscovery, VisualConcept tournament and semantic novelty artifacts. Discovery can return `RESEARCH_MORE`, `REVISE`, `KILL` or `CONTINUE`. Award concept sets require 8-20 candidates and at least three framings; deterministic replay retains at most three finalists.

The NASA regression generates eight concepts, rejects five and retains three finalists. A deliberately thin spatial premise exercises `RESEARCH_MORE` rather than forcing a page from insufficient evidence.

### Semantic economy

Every award module can declare a reader question, claim set, new information, explanatory dimension and dependency. The novelty scorer combines reader-question identity, claim overlap, text overlap and explanatory dimension. High-overlap modules require removal or explicit overview/detail justification.

NASA's top-ten annual-temperature ranking overlaps the long-run trend by 0.8265 and is removed from the final page. The final page keeps distinct temporal, monthly-distribution, measurement-method, baseline-context and spatial-context functions. An explicit overview/detail fixture verifies that justified repetition remains possible rather than turning the scorer into a blanket de-duplication rule.

Two additional real-data editorial regressions exercise the same behavior. The EIA 2024 energy-flow fixture improves average novelty from 0.6842 to 0.9511 after removing a redundant source-ranking module and adding system/human-scale explanation. The R `datasets::Titanic` fixture improves from 0.6466 to 0.8166 after removing a duplicate aggregate-survival view and retaining intersecting-flow plus human-scale explanation.

### Bounded SceneGraph

InfographicSpec 1.3 adds a single SceneGraph layer inside the existing composer. v1.4 supports `hero_sidecar_stack` and `hero_with_rail`. Scene members are validated against module IDs, duplicate scene membership is rejected, and editorial numbering is derived from canonical story order so desktop/mobile geometry cannot silently renumber the narrative.

The NASA award regression keeps two page prototypes. The selected `hero_sidecar_stack` page binds a sourced geographic scaffold, long-run line, 2025 readout and baseline explanation into one hero scene. The alternate `hero_with_rail` prototype is retained for comparison. The selected desktop raster is 1440 x 2223 versus the v1.3.1 baseline at 1440 x 3076, a 27.7% height reduction while removing the redundant ranking and adding a sourced spatial scaffold. Mobile is 720 x 4057 versus 720 x 4256.

### Reporting-gap and provenance-aware asset planning

`runtime/pi/art_direction.mjs` adds asset plans for published GIS, photography, diagrams, expert explanation, coordinates, historical series, human-scale references, vector illustration and verified 3D. Missing blocking evidence returns `RESEARCH_MORE` before layout.

The NASA hero uses a checked-in Natural Earth low-resolution Admin 0 country-polygon fixture through the existing `software_only` rich-illustration boundary. `fixtures/external/naturalearth_lowres/SOURCE.json` records every local file hash, a bundle hash, public-domain license, official source/terms URLs and the limitation that the installed fixture does not expose an authoritative Natural Earth release number for these exact bytes. The rendered page explicitly states that station positions, station density and anomaly intensity are not encoded.

### Abstract reference retrieval

A ten-pattern reference corpus covers SCMP, Delayed Gratification, National Geographic, Reuters, NYT, The Pudding, SND, Information is Beautiful, OJA and Sigma. Retrieval stores only transferable principles, tags, differentiation rules and source URLs. No award artwork bytes or proprietary typography are required.

### Slow award mode and human boundary

`newsroom_award_mode_status` records concepts generated/killed, reporting-gap requests, prototype count, raster revisions, provider usage, wall time and human-review count. Machine stages can reach `READY_FOR_HUMAN`; only qualified pairwise human preference can produce `PASS`.

The NASA regression generates two bounded page prototypes and one raster-reviewed selected candidate. Its human-preference artifact contains zero fabricated reviews and remains `PENDING`; slow-award status is therefore `READY_FOR_HUMAN`. The independent verifier rejects forged expert-preference and forged award-status `PASS` artifacts even when their content hashes are recomputed.

An instructive result is that the alternate NASA `hero_with_rail` prototype receives deterministic critic 98/100 while the selected compact sidecar prototype receives 97/100. The project intentionally does not treat the one-point rubric difference as proof of aesthetic superiority. This is exactly the distinction the external human preference gate is designed to preserve.

## Integrity and performance

All prior release evidence remains green: competition engineering gate 24/24 and the legacy integrity adversarial suite rejects 16/16 mutations. v1.4 adds four editorial adversaries covering forged concept selection, asset-plan decision, human preference and slow-award status; all are rejected independently.

Steady-state p95 results from the final performance segment are: ordinary verifier 7.270 ms, 41-computation verifier 9.679 ms, editorial-artifact verifier 8.076 ms, statistical responsive visualization 0.395 ms, complex visualization 0.470 ms, spatial/process visualization 0.311 ms, semantic explainer 0.188 ms, Infographic Composer 0.675 ms, bounded visual revision 0.263 ms, competition preflight 0.0028 ms, 30-module semantic novelty 2.324 ms and 12-element SceneGraph composition 0.615 ms. All budgets pass.

The initial isolated editorial-verifier run showed a transient 23.948 ms p95 under container/file-system contention. The budget was not relaxed to hide this result. The benchmark now performs 20 warmup verification passes and retains the 15 ms p95 target; repeated steady runs and the final smoke settle near 8 ms. Cold-start maxima remain reported separately.

## Scope deviation recorded explicitly

The iteration plan proposed a SceneGraph p95 target for 20 scene elements. The current InfographicSpec contract caps page modules at 12, so the implemented benchmark uses the actual contract maximum of 12 scene elements. v1.4 does not claim a 20-element benchmark that the schema cannot currently express.

## Remaining external gates

### Real provider qualification

Local live readiness is false. Node is 22.16.0 instead of the pinned 22.19.0, and Pi, DuckDB, Rust/Cargo and provider credentials are unavailable. Two identical real multimodal-provider qualification traces remain required.

### Qualified human preference

The pairwise preference protocol and independent verification are complete, but no qualified reviewer votes exist in this environment. The NASA comparison therefore remains `PENDING`. The planned >=70% candidate preference threshold must be evaluated externally and cannot be replaced by model self-scores.

### Human/vector/photography production depth

The provenance lanes exist and software GIS is qualified. Real human illustration, photo-collage and verified-3D production quality still need actual external assets and editorial review. Mock or software adapters do not qualify their aesthetic quality.

## Go / no-go

- deterministic v1.4 engineering release: **GO**;
- internal EditorialDiscovery / VisualConcept / SceneGraph experimentation: **GO**;
- sourced GIS scene assets through provenance boundary: **GO**;
- claim qualified human preference improvement: **NO-GO, PENDING external reviewers**;
- claim two-provider real-runtime qualification: **NO-GO**;
- claim autonomous SCMP/SND/IIB-level art direction: **NO-GO**.
