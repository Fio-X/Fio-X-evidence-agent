# Local Codex task: System One R6 production review follow-up

Task ID: `system-one-r6-production-review-followup`

Expected branch: `fix/system-one-r6-production-review-blockers`

Current reviewed commit: `dad5b0e31b90e650950c085bb4b9dc9c8cd51a1f`

Parent production-candidate PR: #29
Target fix PR: #30

## Objective

Resolve the two remaining PR #30 review findings without changing architecture or adding any new System One mechanism.

The classifier/completion fix is accepted. The budgeted parallel replay direction is accepted. Preserve both.

## Finding 1: restore strict opt-in behavior for parallel local_text

Current PR #30 wiring calls:

`localText(required("path"), { full: true })`

for every parallel local_text task, including when public `result_budget` is unset.

That changes the default/unset path relative to the production-candidate baseline, whose helper-level local_text behavior used the existing default cap.

Required behavior:

- If `result_budget` is present, the parallel runner must request the complete helper result before scheduler model-visible compaction.
- If `result_budget` is absent, preserve the pre-existing default local_text helper behavior.
- The scheduler remains the only model-visible budget owner for the opt-in result-budget path.
- Do not change the public `result_budget` schema.
- Do not change the scheduler.
- SQLite should continue returning its complete successful query result to the scheduler within its existing execution safety bound.
- Do not reintroduce `maxRows` helper truncation.

The intended local_text wiring is semantically equivalent to:

`resultBudget ? localText(path, { full: true }) : localText(path)`

Exact syntax is your choice.

## Finding 2: reconcile stale local result-budget test

`scripts/test_local_result_budget.mjs` still asserts that `runtime/pi/local_backend.mjs` contains the removed `maxRows` helper mechanism.

Update this test to the current semantic contract:

- default local_text behavior remains bounded/default-compatible;
- explicit bounded `maxBytes` behavior remains bounded;
- full mode returns the complete local text result for the opt-in parallel data-plane path;
- SQLite remains read-only;
- helper-level `maxRows` truncation is absent.

Prefer behavior assertions over source-literal assertions where practical.

## Result report

Update `local-codex/result.md` to reflect the follow-up run.

Do not classify HOLD solely because the Codex sandbox cannot write the outer worktree Git metadata. The user can perform commit/push after validation. Classification must reflect implementation/test quality.

If all required checks pass and no product blocker remains, classify PROMOTE.

## Allowed modifications

- `runtime/pi/newsroom.ts`
- `scripts/test_parallel_tool_contract.mjs`
- `scripts/test_parallel_replay_wiring.mjs`
- `scripts/test_local_result_budget.mjs`
- `local-codex/result.md`

Do not modify any other file.

In particular, do not modify:

- `runtime/pi/local_backend.mjs`
- `runtime/pi/parallel_scheduler.mjs`
- `src/commands/investigate.rs`
- `src/prompt.rs`
- phase registry/policy files
- evidence/claim/fact/SQL gate implementations
- publication/browser-QA implementations

The current GitHub CI Clippy failure in `src/prompt.rs` is inherited from PR #29 and will be handled in a separate task branch. Do not fix it in this task.

## Required validation

Run:

- `node scripts/test_local_result_budget.mjs`
- `node scripts/test_parallel_tool_contract.mjs`
- `node scripts/test_parallel_result_budget.mjs`
- `node scripts/test_parallel_replay_wiring.mjs`
- `node scripts/test_tool_result_budget_integration.mjs`
- `python3 scripts/test_visual_routing_matrix.py`
- `python3 scripts/test_round6_combined.py`
- `cargo fmt --check`
- `cargo test --locked`
- `cargo build --release --locked`
- `git diff --check`

Also confirm:

- routing remains exactly 24 cases / 9 intended changes;
- model-visible measurement remains 942143 -> 30544 (96.76%) unless the actual measured fixture changes;
- budgeted parallel replay still preserves the complete 96000-byte text result and 240 SQLite rows, or equivalent complete fixtures;
- unset parallel local_text follows the previous default helper behavior;
- no evidence/provenance/verification/completion/publication/browser-QA gate changed.

End `local-codex/result.md` with exactly one classification: PROMOTE, HOLD, REJECT, or INCONCLUSIVE.

Do not merge any PR.
Do not mark any Draft PR Ready for Review.
