# Iteration Plan v1.3

## Objective

Turn the v1.2 visual-editor baseline into a competition-aware, evidence-preserving revision loop. Preserve one Infographic Composer and one evidence graph while adding the minimum mechanisms required for safe visual repair, mobile art direction and competition-specific eligibility/preflight.

## Priority 1: competition-aware policy

Deliver a versioned policy module with explicit profiles for baseline editorial review, SND47 information graphics, OJA 2026 visual digital storytelling, Sigma 2026 and Information is Beautiful. Store source URLs, internal operational score floors, forbidden illustration origins and manual requirements. Mark all score floors as internal proxies rather than jury thresholds. Make SND47 generative/mixed illustration origin a hard machine eligibility failure.

Acceptance criteria: policy contract tests pass; InfographicSpec 1.2 validates profile names; profile output retains source URLs/manual requirements; independent verifier recomputes the machine pass; forged `machine_passed` state fails integrity verification.

Status: implemented.

## Priority 2: bounded image-aware revision executor

Extend the image critic patch language to `span`, `emphasis`, `priority`, `move_before` and `mobile_move_before`. Add an executor that accepts only a current plan and current vision critic, applies a maximum bounded patch set, stores a content-addressed revised plan and revision audit, and requires the full lint/render/deterministic-critic/preview/vision loop to run again.

Acceptance criteria: protected evidence cannot be changed through the patch language; the independent verifier replays patches from the source plan; the revised plan must exactly match independent replay; coordinated critic plus audit tampering still fails; legacy InfographicSpec 1.1 inputs upgrade safely to 1.2 before revision.

Status: implemented.

## Priority 3: mobile-specific editorial order

Add `mobile_module_order` as an exact module-ID permutation in InfographicSpec 1.2. Keep desktop module sequence and three-candidate ranking unchanged. Render mobile geometry from the explicit narrow-screen order.

Acceptance criteria: duplicate/missing module IDs fail schema/runtime lint; desktop `balanced`, `anchor`, `rhythm` candidate ranking remains active for 1.2; a mobile-only order change leaves desktop sequence unchanged; contract and composer regression tests pass.

Status: implemented. A regression found during this iteration showed that the first 1.2 implementation accidentally bypassed three-candidate desktop ranking because the version check matched only 1.1. The condition was corrected and locked with a regression test.

## Priority 4: independent competition preflight

Add a final-candidate preflight bound to plan, page manifest, deterministic critic and image-aware critic. Evaluate profile-specific machine floors and illustration origins, while retaining human-only requirements explicitly.

Acceptance criteria: preflight cannot be generated from stale or mismatched assets; the independent verifier recomputes the result; human authorship, originality and submission evidence remain manual; evaluator requires a passing final preflight.

Status: implemented.

## Priority 5: live qualification scenario

Upgrade live qualification so one provider run must demonstrate controlled failure/recovery, verified SQL, at least two responsive data visuals, semantic explanation, provenance-aware rich illustration, magazine composition, exact preview, image-aware critique, at least one justified bounded revision, final preflight, second-turn mobile-first editorial work and SQL recomputation. Use OJA 2026 as the default qualification profile because the bundled mock rich illustration records AI origin and therefore cannot truthfully qualify the SND47 information-graphics policy.

Acceptance criteria: qualification summary records required tool coverage, revision evidence and competition profile; provider-matrix comparison can compare two or more identical runs; real provider evidence remains separate from deterministic smoke evidence.

Status: harness implemented; real provider execution remains environment-blocked until pinned Rust, Pi, DuckDB and provider credentials are available.

## Priority 6: smoke and performance hardening

Run fast contract tests after every milestone. Finish with the full smoke suite, independent evaluator, adversarial integrity suite, exact raster tests, visualization/explainer benchmarks and verifier benchmarks. Treat any regression in release metadata, schema compatibility, candidate ranking, provenance or p95 performance as a release blocker.

Acceptance criteria: release/runtime contracts pass; competition gate 24/24; adversarial integrity 16/16; no existing visualization benchmark exceeds its budget; full smoke exits zero apart from explicitly documented environment skips.

Status: fast gate complete. Full smoke and final measured results are recorded in `docs/test-report-v1.3.md` after final execution.

## Deliberately deferred

A second Infographic Composer is rejected for this iteration because it would duplicate layout authority. A new page layout engine is also deferred. If real-provider traces show repeated demand for browser-native interactions, the next adapter should translate InfographicSpec into semantic HTML/SVG and add Playwright-style cross-browser screenshot, accessibility and performance QA. Rich illustration should next gain a real human-art intake/approval path and optional production C2PA signing where credentials and key management exist.
