# Agentic Data Newsroom v1.32-v1.34 Iteration Plan

## Objective

Move the qualification track from backend/runtime infrastructure into editorial differentiation, diagnostic screenshot QA, and reproducible human finishing without weakening evidence fidelity. External professional runtimes remain a hard qualification dependency; no unavailable backend may be represented as rendered or as a human-preference winner.

## v1.32 Editorial Design Systems

Scope:
- Introduce versioned design-system contracts shared across Python, R, QGIS, ECharts, and Agent backend planning.
- Provide six editorial systems: scientific, economic, movement, network, investigative, explainer.
- Separate design tokens/composition from evidence, geometry, values, units, and claims.
- Add design-system hashes to render requests and final manifests.
- Measure design-system and composition-signature diversity across the benchmark corpus.
- Differentiate mature chart grammar where editorially justified, including economic lollipop rankings and investigative contrast bars.

Exit gates:
- Design-system catalog validates against schema.
- Agent backend plan returns a bundled versioned design system.
- At least three systems are exercised by the qualification corpus.
- No single design system exceeds 55% of corpus assignments.
- All presentation changes preserve the semantic fingerprint.

## v1.33 Visual QA 2.0

Scope:
- Add deterministic raster diagnostics after final artifact generation.
- Diagnose resolution, occupied area, outer whitespace, edge density, tonal/color separation, and dark-coverage anomalies.
- Batch screenshot diagnostics in one Python process so QA does not undo warm-worker gains.
- Treat machine QA as correctness/diagnostic evidence only. It must not emit competition readiness.
- Preserve a future model-assisted screenshot critic as a separate human/AI-review layer.

Exit gates:
- Diagnostic schema validates and explicitly fixes competition readiness to UNASSESSED.
- QA batch handles the full local qualification corpus without per-artifact process startup.
- No hard QA blocker on the current deterministic Python baseline.
- Known visual repetition remains a separate composition-diversity advisory, not hidden by the pixel gate.

## v1.34 Art Direction Replay

Scope:
- Introduce ArtDirectionPatch v2 with stable semantic targets and presentation-only operations.
- Permit title size, label count, emphasis, margins, legend placement, label offsets, visibility, line breaks, and composition changes.
- Protect inputs, evidence hashes, claim IDs, semantic fingerprint, data fields, CRS, units, and factual geometry.
- Invalidate patches when story semantics or design-system hashes change.
- Allow qualification runner to replay optional backend-scoped patches.

Exit gates:
- Patch schema rejects protected fields.
- A real render changes artifact bytes while preserving semantic fingerprint.
- Semantic changes invalidate replay.
- Design-system changes invalidate replay.
- Patch application is recorded in request/audit output.

## Deferred by hard gate

The following remain outside qualification-complete status until the networked runtime build environment activates them:
- R editorial runtime
- QGIS runtime
- ECharts/MapLibre/Sigma web runtime
- PyGMT
- Datashader
- GraphRAG extraction

Human backend priors remain PENDING until at least two real professional backends render the same semantic contract and qualified reviewers complete blind pairwise evaluation.
