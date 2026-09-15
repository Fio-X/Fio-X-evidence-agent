# Agentic Data Newsroom v1.34 Status

## Overall

v1.32-v1.34 core infrastructure is implemented and locally regression-tested. The current execution environment still exposes only the Python professional runtime, so cross-backend visual qualification and human winner priors remain pending external runtime activation.

## v1.32 Editorial Design Systems

Status: CORE COMPLETE, CROSS-BACKEND RUNTIME QUALIFICATION PENDING.

Implemented:
- `config/editorial-design-systems.json` with six versioned systems.
- JSON Schema and deterministic design-system hashes.
- Shared design-system injection into backend render requests and manifests.
- Python editorial chart, flow map, trajectory map, adjacency matrix styling.
- R, QGIS, and ECharts adapters updated to consume the same contract when their runtimes become available.
- Agent-side bundled design systems integrated into `newsroom_visual_backend_plan`.
- Project visualization Skills updated to require shared design-system consumption.
- 32-case design assignment uses five systems; maximum system share is 0.4688, PASS.
- Current composition signatures remain ADVISORY because `scientific|editorial_chart|bar` is 10/31 rendered artifacts (0.3226).

## v1.33 Visual QA 2.0

Status: DETERMINISTIC CORE COMPLETE, MODEL-ASSISTED CRITIC PENDING.

Implemented:
- Deterministic PNG diagnostics with a dedicated schema.
- Batch QA path, avoiding one Python/Pillow/NumPy startup per figure.
- Explicit `machine_role=diagnostic_only` and `competition_readiness=UNASSESSED`.
- Full 31-artifact local run: 31 PASS, 0 ADVISORY, 0 BLOCK after calibration.
- Composition diversity is evaluated separately so the QA gate does not reward template repetition.

The deterministic QA does not claim aesthetic excellence. Model-assisted screenshot critique and qualified human preference remain separate evidence layers.

## v1.34 Art Direction Replay

Status: CORE COMPLETE, MULTI-BACKEND REPLAY PENDING.

Implemented:
- `ArtDirectionPatch v2` schema and replay engine.
- Protected-evidence boundary and semantic/design-system invalidation.
- Optional `--patch-dir` integration in the qualification runner.
- End-to-end render replay test: presentation hash changes while semantic fingerprint is preserved.
- Agent/Skill guidance updated to require replayable presentation-only finishing.

## Qualification run

Corpus: 32 cases.
Local final artifacts: 31.
Blind-ready cases: 0 because no case currently has two available professional backends.
Design-system diversity: PASS.
Composition diversity: ADVISORY.
Visual QA: PASS for 31 local final artifacts.
External runtime gate: PENDING_EXTERNAL_RUNTIME.

The full 32-case qualification including batched visual QA completes in about 12.46 seconds on the current execution host. This timing is host/workload specific and is not a universal backend performance claim.

## Regression

All newly added v1.32-v1.34 tests pass. Legacy visualization, cartography, infographic, verifier, and performance regressions were executed in ordered segments because the monolithic smoke script exceeds the outer execution window. All executed tests passed. Rust control-plane acceptance remains the only environment SKIP because `cargo` is unavailable in this execution container.

## Next hard gate

Build and promote digest-pinned R, QGIS, Web/ECharts/Sigma, Datashader, PyGMT, and GraphRAG runtime images in the networked build environment. Then rerun the same 32-case semantic corpus and create the first real blind-ready multi-backend cases before learning backend or design-system winners.
