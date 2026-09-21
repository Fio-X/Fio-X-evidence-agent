# 20-macro-checkpoint-boundaries

## Hypothesis

The smallest useful control-plane boundaries are **RESEARCH → DESIGN → PUBLISH**: research gathers and verifies evidence, design turns verified evidence into bounded visual/story artifacts, and publish performs final rendering and publication QA. A checkpoint after each boundary should reduce phase/tool ambiguity while preserving fail-closed evidence gates.

## Commands and measurements

- Read `AGENTS.md`, `experiments/system-one/README.md`, the manifest entry, `src/commands/investigate.rs`, `src/commands/investigate_v2.rs`, `src/agent/core.rs`, `runtime/pi/tool_registry.mjs`, and `runtime/pi/tool_phase_policy.mjs`.
- `node scripts/test_phase_tool_scope_v112.mjs` → PASS; 53 registered tools; phases: `core`, `discover`, `verify`, `synthesize`, `design`, `publish`, `verify_publication`.
- Temporary read-only registry measurement: phase totals were core 5, discover 3, verify 3, synthesize 14, design 22, publish 4, verify_publication 2. Effective profile counts were investigate 14 core/3 discover/3 verify/1 synthesize/5 design; visual-story 14 core/6 synthesize/2 design/3 publish/1 verify_publication; publication 10 core/1 verify/1 synthesize/4 publish/2 verify_publication.
- `node scripts/test_visual_story_completion.mjs` → PASS; fail-closed completion state, run-root path safety, required roles, 4–9 modules, ≥2 visual assets, ≥2 analytical jobs, and publication QA requirement confirmed.
- `cargo test --locked` → PASS: 87 passed, 0 failed, 1 ignored.
- `cargo test --locked completion_tests --lib` → not applicable/FAIL at command level: package has no library target; the full binary test run covered the completion tests and passed.

## Observed values and checkpoint proposal

1. **RESEARCH checkpoint:** complete `discover` (`news_search`, `fetch_url`, `download_data`) and `verify` (`duckdb_query`, `newsroom_parallel_tasks`, `record_claim`), with evidence refs, replayable computations, and supported claims. The existing runtime also records a Story Graph later, but research should not publish.
2. **DESIGN checkpoint:** require synthesis/story planning plus design lint/render/critic. For ordinary investigate, the measured effective surface is 1 synthesis + 5 design tools; for visual-story, synthesis is 6 and design is 2, with backend-specific validation included. Success means the plan is ordered, evidence-bound, and all deterministic critics/lints pass.
3. **PUBLISH checkpoint:** require rendered publication plus `verify_publication` QA. Existing gates require publication HTML verification, publication QA, self-contained output, zero network requests, CSP, and no single-chart fallback. For complex stories, completion additionally requires roles `hook`, `context|evidence`, `turn|explanation`, `resolution`; 4–9 modules; every module source-bound; ≥2 verified visual assets; ≥2 distinct analytical jobs; ≥2 distinct verified findings; and all infographic/publication gates passing.

## Limitations

This is static repository evidence plus deterministic tests, not an end-to-end provider latency or quality experiment. Tool counts describe registration/profile exposure, not actual call frequency. The current implementation does not expose these three macro checkpoints as first-class runtime events, so round-2 success should instrument checkpoint pass/fail, elapsed time, retries, and gate reasons without weakening any existing validator.

## Classification

**PROMOTE**
