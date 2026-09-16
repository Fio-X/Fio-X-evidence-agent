# v1.3 Completion Audit

## Decision

v1.3 completes the highest-value engineering work that can be validated without a real Pi/provider environment: competition-aware policy, verifier-replayable image-aware revision, mobile-specific editorial order, independently recomputed competition preflight, upgraded qualification requirements and performance/integrity hardening. The release should remain a conditional engineering baseline until real multimodal-provider qualification is executed.

No second Infographic Composer or second page-layout engine was added. The existing composer remains the single authority for editorial intent, story roles, responsive modules and deterministic candidate ranking. This decision is supported by both competition criteria and newsroom practice: quality is judged across story, clarity, craft, responsiveness, accessibility and originality, while eligibility rules can vary by competition. Adding policy and controlled revision around the existing composition model delivers more value than duplicating layout logic.

## Implemented architecture

`InfographicSpec 1.2` adds `competition_profile` and `mobile_module_order`. Desktop output still ranks three deterministic candidates: `balanced`, `anchor` and `rhythm`. Mobile can declare its own module sequence when narrow-screen hierarchy requires it, while the desktop story sequence remains unchanged.

`runtime/pi/competition.mjs` introduces five profiles: baseline `editorial`, `snd47_infographics`, `oja2026_visual`, `sigma2026` and `iib_awards`. Each profile stores published source URLs, internal operational score floors, known machine-checkable origin constraints and manual requirements. The SND47 profile fails closed for generative-AI or mixed-origin rich illustrations. Automated floors are explicitly labelled as proxies and are not presented as jury predictions.

The image-aware patch language is now `span`, `emphasis`, `priority`, `move_before` and `mobile_move_before`. `newsroom_infographic_revise` applies a maximum bounded patch set and records an immutable editorial-evidence projection hash. The Python verifier independently replays patches from the source plan and requires the reconstructed plan to equal the stored final plan. Claims, SQL, source references and evidence prose cannot be changed through this revision path.

`newsroom_competition_preflight` binds final plan, manifest, deterministic critic and image-aware critic. The independent verifier recomputes machine pass/fail from the final metrics and illustration provenance, so a forged preflight result fails verification. Manual requirements remain visible after machine pass.

The live qualification scenario now requires at least one justified bounded visual revision and a final competition-profile preflight. The bundled scenario uses OJA 2026 because its mock rich illustration records generated origin; using that mock under the SND47 information-graphics profile would be knowingly ineligible. Provider-matrix summaries now include competition profile and required new tools.

## Defects found and fixed during iteration

The first InfographicSpec 1.2 implementation accidentally disabled three-candidate desktop ranking because a version branch matched only 1.1. This was caught by regression testing, fixed, and covered with an explicit 1.2 test.

The release metadata initially had `versions.json=1.3.0` while `Cargo.toml=1.2.0`. The release-baseline checker failed as designed. `Cargo.toml` is now 1.3.0 and the checker passes.

The final shell orchestration also exposed the intended behavior of `live_readiness.py`: it exits nonzero when the live environment is incomplete. The final workflow records that JSON separately and runs deterministic smoke independently, preserving the distinction between engineering evidence and live-provider evidence.

## Verification outcome

The final deterministic smoke exits zero. Competition engineering gate: **24/24 PASS**. Integrity adversarial suite: **16/16 rejected**. Exact raster preview, semantic explainer, rich illustration contract, competition policy, mobile-specific revision, SQL recomputation protocol, qualification summaries and mock Pi failure/recovery all pass.

The independent verifier now performs 351 checks/run in the synthetic full-path benchmark at p95 7.480 ms, compared with 202 checks/run at p95 4.854 ms on the v1.2 baseline in the same environment. The 41-computation scale artifact performs 711 checks/run at p95 10.166 ms, compared with 562 checks/run at p95 8.027 ms in v1.2. Both remain well inside their 15 ms and 40 ms p95 budgets. New bounded revision p95 is 0.309 ms and competition preflight p95 is 0.00284 ms.

## Remaining release blockers

Real provider qualification is still missing. The local environment has Node 22.16.0 instead of the pinned 22.19.0 and lacks Pi, DuckDB, Rust/Cargo and model credentials. `live_ready=false` is therefore the correct outcome. Two real multimodal providers should run the identical qualification scenario before a production/competition claim is made.

A real rich-illustration backend is also not qualified. The bundled mock proves protocol, provenance and policy enforcement only. SND-targeted output additionally needs a human-authorship intake/review path for final illustration assets. Signed C2PA Content Credentials remain future production integration because the current project records C2PA/IPTC-aware metadata and content hashes without signing a C2PA claim.

## Next decision gate

Do not add another composer before examining real-provider traces. If providers routinely produce useful bounded patches and remaining failures are browser-specific, build a thin semantic HTML/SVG publication adapter with Playwright device capture, screenshot diff, accessibility and performance checks, following the Reuters Spectre/NYT ai2html/Scrollama class of practice. If the dominant weakness is visual asset quality, invest instead in human-illustration intake, richer approved asset adapters, art-director review and optional signed provenance. This ordering keeps the system simple and lets observed failures determine the next architecture layer.
