# v1.2 Completion Audit

## Executive assessment

v1.2 closes the architectural gap between deterministic magazine composition and a visual-editor Agent loop. The existing composer remains authoritative for story structure and responsive geometry. New capability surrounds it with exact-pixel observation, bounded multimodal critique and a provenance-aware richer-illustration boundary. The release also upgrades provider qualification so the required evidence is the full newsroom sequence rather than a generic model conversation.

Recommended completion estimates after the deterministic implementation:

- core agent/evidence architecture: **95%**;
- deterministic visualization and magazine presentation: **95%**;
- visual-editor automation: **91%**;
- competition engineering readiness: **94%**;
- external competition submission readiness: **86% pending real-provider evidence**;
- production readiness: **72% pending pinned-runtime/provider/load evidence**.

## What was implemented

### Provenance-aware rich illustration

`runtime/pi/illustration.mjs` defines the 0.2 rich-illustration protocol. The core validates editorial intent, subject, alt text, source/credit, origin policy, verified claim IDs and evidence references before it calls an adapter. External adapters are intentionally minimal: executable path plus JSON arguments, JSON request via stdin, JSON response via stdout.

The runtime normalizes provider metadata, digital source type, origin, disclosure, model/system/version, prompt hash, license and content-credential metadata. Generated SVG is sanitized against active content and then annotated with provenance/accessibility markers. The artifact verifier rechecks evidence references, claims, hashes, disclosure and critic status independently.

The contract supports human, software and generated-media workflows. This matters because current SND rules prohibit generative-AI imagery in editorial illustration and information-graphics categories, while Reuters prohibits generative AI visual imagery in visual journalism. A publisher can therefore select a stricter origin policy without changing page composition code.

### Exact-pixel image-aware review

`newsroom_infographic_preview` rasterizes the exact desktop/mobile SVG variants only after the deterministic infographic critic passes. A content-addressed preview manifest records the source SVG hashes and PNG hashes. The same active Pi session receives those PNGs as image content, so the reviewer observes the rendered page rather than only reading the plan.

`newsroom_infographic_vision_critic` accepts a ten-dimension visual review covering hierarchy, legibility, composition, coherence, typography, source legibility, responsive quality, illustration integration, color contrast and editorial distinctiveness. Its proposed machine-actionable patches are constrained to span, emphasis, priority and relative ordering. It has no authority to change SQL, claims, values, evidence or provenance.

The artifact verifier treats the image-aware review as required evidence only for new pages carrying `visual_review_required: true`, which keeps legacy v1.1 artifacts verifiable while making the stronger v1.2 path fail closed.

### Provider E2E qualification harness

The live scenario now requires a controlled blocked localhost fetch followed by recovery, deterministic analysis, verified claims, two responsive visualizations, a semantic explainer, rich illustration, magazine composition, deterministic page critique, raster preview, image-aware critique and a second mobile-first editorial pass. `write_qualification.py` turns those traces into a versioned qualification artifact and fails if the required chain was not actually observed.

`scripts/provider_matrix.sh` executes the same scenario against multiple provider/model pairs and `scripts/compare_qualifications.py` records quality/reliability/cost-latency evidence when Pi exposes it. This changes provider choice from a configuration decision into an empirical acceptance test.

### Release/integrity gates

The competition evaluator now has 22 checks and includes rich illustration plus image-aware page review. The independent verifier validates the new asset lineage. The runtime contract test confirms the Rust allowlist, audit surface, embedded runtime assets and Pi extension remain synchronized.

CairoSVG 2.8.2 is now part of the pinned release baseline because exact-pixel preview has become runtime qualification infrastructure rather than an optional test-only convenience.

## Research-backed product decision

A second Infographic Composer or second page layout engine would have low value and high architectural cost. SCMP-style work depends on a dominant explanatory visual, strong supporting modules and art direction, while Delayed Gratification demonstrates stable visual grammar and two-speed reading. Those needs map onto the existing v1.1 intent/story-role/priority/emphasis system plus candidate ranking. The missing feedback loop was pixel observation and richer artwork.

The deterministic explanatory adapter should stay. It provides a factual schematic mode with verified claims and visible not-to-scale disclosure. Rich illustration is an additional lane selected when the story and publisher policy justify it.

The visual critic is deliberately advisory inside a fail-closed system. VisJudge-Bench's ICLR 2026 results show that even strong general multimodal models still diverge materially from expert visualization judgments. The runtime therefore lets the model diagnose visible problems while deterministic rules and the verifier remain authoritative for factual and provenance integrity.

Research record: `docs/visual-editor-research-v1.2.md`.

## Deterministic evidence completed locally

The v1.2 smoke suite has passed the new illustration contract, visual-critic contract, exact-pixel preview, existing visualization families, explanatory graphics, infographic composer, evaluator, adversarial verifier and performance budgets. The synthetic competition fixture reaches **22/22**.

The local environment still lacks Cargo/Rust, DuckDB CLI, Pi CLI and provider API credentials. Real `Rust CLI -> Pi -> real multimodal provider -> newsroom tools -> DuckDB -> visual editor loop -> verify --recompute` qualification could not be executed truthfully here. The manual GitHub workflow and provider-matrix runner are prepared for that environment.

## Remaining release risk

### Real providers

The highest-priority outstanding evidence is two successful live multimodal provider runs using the identical qualification scenario. Their qualification artifacts should be retained with provider/model identifiers, wall time, tool failures/recovery, plan revisions and usage/cost data where available.

### Real rich-illustration backend

The bundled mock adapter qualifies protocol behavior, sanitization, provenance and page integration. It does not qualify image quality or an external generative-image service. A production deployment should connect an approved human/vector/image backend through the same contract and run the same provenance and visual-review gates.

### Cryptographic Content Credentials

The current manifest records C2PA/IPTC-aligned provenance fields and hashes. It does not create a signed C2PA Content Credential. Adding a C2PA claim generator, signing credential lifecycle and independent C2PA validation is a separate production-hardening project.

### Human art direction

The image-aware critic increases coverage of visible failures but is not a substitute for a senior visual editor. Competition entry, bespoke illustration quality, emotional tone, publication voice and sensitive visual framing still require human editorial judgment.

## Go / no-go

- deterministic v1.2 engineering release: **GO**;
- internal visual-editor demonstrations: **GO**;
- connect a real illustration backend behind the adapter: **GO with outlet policy review**;
- claim two-provider E2E qualification: **NO-GO until live runs exist**;
- claim signed C2PA Content Credentials: **NO-GO**;
- claim autonomous SCMP-equivalent art direction: **NO-GO**.

## Next investment after provider qualification

Do not add another page engine. First collect real provider traces and identify the dominant repair pattern. If repeated traces show that agents waste turns translating vision-critic suggestions into page-plan edits, add a tiny deterministic revision executor that applies validated patches, rerenders and rechecks. If the dominant failure is illustration quality, invest instead in a real vector/image adapter plus human approval and C2PA signing. Let measured qualification traces choose between these branches.
