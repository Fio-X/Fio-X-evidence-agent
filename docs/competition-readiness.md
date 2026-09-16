# Competition readiness

v1.3 maps the project to major visual-journalism and data-visualization competition criteria while keeping three evidence classes separate: deterministic engineering evidence, live-provider behavior, and manual jury/eligibility judgment.

## Engineering gate

The engineering evaluator checks 24 conditions. In addition to persistent context, plan revision, tool-loop evidence, deterministic computation, verified claims, responsive visualization, explanatory graphics, rich illustration, magazine composition, deterministic page critique, exact-pixel preview and image-aware critique, v1.3 requires a bounded visual revision with evidence preservation plus a final competition-profile preflight. The synthetic qualification fixture passes 24/24. The adversarial integrity suite contains 16 mutations, including coordinated critic/revision tampering and forged competition pass state; all must be rejected before scoring.

## Competition profiles

InfographicSpec 1.2 declares one of five profiles: `editorial`, `snd47_infographics`, `oja2026_visual`, `sigma2026`, or `iib_awards`. The runtime stores source URLs, internal operational score floors, known machine-checkable origin restrictions and manual requirements. Internal floors are explicitly labelled as implementation proxies, not official jury cutoffs.

SND47 is the strictest current origin policy in this set. Its published rules reject final images or video created wholly or partly with generative AI in editorial illustration, information graphics and multimedia categories. The `snd47_infographics` profile therefore rejects rich-illustration assets whose recorded origin is `generative_ai` or `mixed`, and it retains human-authorship attestation as a manual submission requirement.

OJA 2026 emphasizes the quality and impact of visuals, media selection, storytelling effectiveness, originality, innovation and work that is truly native to digital and mobile platforms. Sigma 2026 emphasizes rigorous data collection and analysis in the public interest, strong visual/interactive storytelling, public service and ideas that advance the field. The Information is Beautiful rubric spans impact, engagement, analysis clarity, innovation, inclusion/accessibility, effectiveness and beauty. INMA similarly rewards clear, engaging visual transformation of information and creative use of design and technology. These rubrics overlap strongly but do not share one eligibility policy, which is why v1.3 makes competition policy explicit instead of treating `award` as one universal mode.

## Visual-editor evidence

The deterministic page critic remains the first gate. Exact desktop/mobile SVG output is rasterized and hash-bound to PNG previews before the multimodal critic sees it. The critic can propose only `span`, `emphasis`, `priority`, `move_before` and `mobile_move_before` changes. The revision executor applies those bounded fields and records the source and result.

The independent verifier replays every revision from its source plan and compares the reconstructed result with the final plan. It also recomputes an immutable editorial-evidence projection hash that excludes only allowed layout fields. This makes coordinated tampering with a stored critic and revision audit insufficient to validate a changed claim, SQL statement, source reference or textual evidence.

Mobile reading order is now explicit. A narrow viewport may sequence modules differently when the visual hierarchy requires it, while the desktop module sequence remains unchanged. Desktop still evaluates `balanced`, `anchor` and `rhythm` candidates. This adds responsive art direction without creating a second composition model.

## Illustration boundary

The deterministic semantic explainer remains suitable for schematic cutaway, exploded, anatomy and system views bound to verified claims. The richer external illustration adapter carries origin, digital source type, source note, credit, disclosure, provider/model/version metadata, prompt hash, evidence references and final content hashes. Active SVG content is rejected. Publisher or competition policy can select `human_only`, `ai_disclosed` or `software_only` behavior without changing the page engine.

The bundled mock illustration adapter proves contract and provenance plumbing only. It does not establish artistic quality or qualify an external image-generation provider. Signed C2PA Content Credentials also remain outside the current release boundary.

## Current status and release decision

The deterministic v1.3 engineering gate can be completed in the local environment. A final live release claim still requires at least two real multimodal-provider qualifications on the pinned Rust/Pi/DuckDB/CairoSVG environment, including controlled tool recovery, evidence-driven planning, two responsive visuals, semantic explanation, approved rich illustration, magazine composition, exact preview, image-aware critique, a justified bounded revision, final competition preflight and SQL recomputation.

The competition recording should show the live tool/recovery trace, verified computation and claims, responsive visuals, explanatory and illustration assets with provenance, InfographicSpec 1.2 planning, before/after exact previews, the bounded revision audit, final deterministic and visual critics, final competition preflight and independent `news verify --recompute` result. Human eligibility attestations and jury-quality judgments must remain visibly separate from automated checks.

Final competition recording status: conditional GO after two live multimodal-provider qualifications on the pinned environment and manual review of the selected competition's current rules.
