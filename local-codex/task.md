# Local Codex task: System One R6 production review blockers

Task ID: `system-one-r6-production-review-blockers`

Expected branch: `fix/system-one-r6-production-review-blockers`

Base production-candidate commit: `b326510c825a9c395cf583313329e05693c2f6f9`

Parent production-candidate PR: #29

## Objective

Resolve exactly the two blockers found during the final Production Candidate Review of PR #29.

Do not add any new System One optimization mechanism. Do not redesign architecture. Preserve the existing Sparse Supervisor / Pi Semantic Worker / Deterministic Runtime direction.

The two blockers are:

1. Split visual routing and authoritative completion gates currently use different complex-visual classifiers.
2. Parallel result budgets are applied inside local helper execution before the scheduler persists raw results, so replay refs can preserve already-truncated values instead of the full task result.

The fix must preserve all existing evidence, provenance, verification, completion, publication, browser-QA, and replayability invariants.

## Architecture invariants

- Behavior-changing mechanisms remain opt-in.
- When `NEWSROOM_COMPLEX_VISUAL_ROUTING_AB` is unset, existing routing and completion behavior remains unchanged.
- `result_budget` remains strictly optional.
- When `result_budget` is unset, tool behavior remains default-compatible.
- Model-visible context may be bounded only after the full execution result is available for the data plane.
- Full source/data/computation/parallel results must remain replayable from artifact refs and hashes.
- Never auto-repair Fact, Claim, SQL, or Evidence.
- AutoRepair ∩ {Fact, Claim, SQL, Evidence} = empty.
- Do not introduce a generic RunState, new memory system, daemon, or background service.
- Do not weaken Evidence Ledger, FactGraph, ClaimGraph, StoryGraph, InfographicSpec, claim verification, SQL correctness, completion, publication, or browser-QA gates.
- Model output cannot grant verification status.

## Required fix A: classifier consistency at completion boundary

The split classifier selected by `NEWSROOM_COMPLEX_VISUAL_ROUTING_AB` must drive all three places consistently:

- prompt contract selection
- effective tool-profile routing
- authoritative complex-visual completion-gate selection

Current production-candidate code routes with `is_complex_visual_request(topic, split_classifier)` but `visual_completion_gaps()` still calls the legacy `prompt::is_complex_visual_request(topic)`.

Correct this so the same classifier decision controls completion gates.

Acceptance behavior:

- With split routing disabled, behavior is unchanged.
- With split routing enabled, the fixed 24-case routing matrix still has exactly 9 intended changes.
- Cases routed from `visual-story` to `visual` must not be required to pass complex publication gates solely because the legacy classifier says complex.
- Cases newly retained/promoted as true multi-module `visual-story` requests must still require the existing infographic, publication, and browser-QA gates.
- Do not remove, skip, downgrade, or relabel any existing gate for requests that are complex under the active classifier.

Add behavior-level regression coverage. A test that only searches for a source-code substring is insufficient.

## Required fix B: full parallel replay before model-visible truncation

For `newsroom_parallel_tasks`, `result_budget` must bound the model-visible result only after the complete task result is available to the scheduler/data plane.

Current production-candidate wiring forwards `result_budget` into `localText(... maxBytes ...)` and `localSqliteQuery(... maxBytes/maxRows ...)` before `runTaskDag()` persists `rawValue`. That can make `full_result_ref` and `full_batch_ref` point to already-truncated results.

Correct this contract.

Acceptance behavior:

- A budgeted parallel `local_text` task may return a bounded model preview, while the replay artifact contains the full text result produced by the task.
- A budgeted parallel `sqlite_query` task may return bounded model-visible rows, while the replay artifact preserves the complete query result produced by the task.
- `full_result_ref` / `full_batch_ref` hashes correspond to those complete persisted values.
- The read-only/local backend safety boundary remains unchanged.
- The scheduler remains the single model-visible parallel output-budget mechanism.
- Do not create a second replay store or duplicate budget mechanism.
- If helper-level `maxRows` logic becomes unused after the fix, remove the dead mechanism rather than leaving an alternate truncation path.
- No-budget behavior remains default-compatible.

Add a semantic regression test that exercises the actual `newsroom_parallel_tasks` wiring, or an equivalent executable path that proves the runner hands complete values to the scheduler before model-visible truncation. The existing scheduler-only mock test is not sufficient by itself.

## Test strengthening required

Strengthen the current tests so they validate behavior instead of only implementation literals:

- `scripts/test_visual_routing_matrix.py` must assert exactly 24 cases and exactly 9 intended routing changes, including the exact changed-case set.
- `scripts/test_round6_combined.py` must fail if the exact 24/9 contract changes.
- Update `scripts/test_parallel_tool_contract.mjs` so it no longer requires pre-scheduler helper truncation.
- Keep `scripts/test_parallel_result_budget.mjs` for scheduler behavior, but add or adapt a semantic test for the real parallel tool wiring.
- Preserve the existing 96.76% measurement fixture unless the corrected runtime path changes the measured result; if it changes, report the new measured value and explain why. Do not manufacture the old number.

## Allowed modifications

Product/runtime source:

- `src/commands/investigate.rs`
- `runtime/pi/newsroom.ts`
- `runtime/pi/local_backend.mjs`

Tests:

- `scripts/test_parallel_tool_contract.mjs`
- `scripts/test_parallel_result_budget.mjs`
- `scripts/test_tool_result_budget_integration.mjs`
- `scripts/test_visual_routing_matrix.py`
- `scripts/test_visual_routing_cost.py`
- `scripts/test_round6_combined.py`
- one new narrowly scoped test under `scripts/` if required for semantic parallel replay validation

Result report:

- `local-codex/result.md`

Do not modify any other file.

In particular, do not modify:

- `runtime/pi/parallel_scheduler.mjs`
- `runtime/pi/tool_registry.mjs`
- `runtime/pi/tool_phase_policy.mjs`
- `src/prompt.rs`
- evidence/claim/fact/SQL gate implementations
- publication or browser-QA gate implementations
- PR #29 metadata or draft state

If the task cannot be completed within this allowlist, stop and report the smallest additional file that would be required. Do not expand scope yourself.

## Required validation

Run all of the following:

- `node scripts/test_parallel_tool_contract.mjs`
- `node scripts/test_parallel_result_budget.mjs`
- the new/adapted semantic parallel replay test
- `node scripts/test_tool_result_budget_integration.mjs`
- `node scripts/test_phase_tool_scope_v112.mjs`
- `node scripts/test_phase_runtime_surface.mjs`
- `python3 scripts/test_phase_env_plumbing.py`
- `python3 scripts/test_visual_routing_matrix.py`
- `python3 scripts/test_visual_routing_cost.py`
- `python3 scripts/test_round6_combined.py`
- `cargo fmt --check`
- `cargo test --locked`
- `cargo build --release --locked`
- `git diff --check`

If `scripts/test_phase_env_plumbing.py` requires a refreshed debug binary, run `cargo build --locked` first and record that fact.

## Required result report

Replace `local-codex/result.md` with a concise report containing:

- tested branch and final commit SHA
- OS and relevant tool versions
- exact files modified
- exact commands executed
- PASS/FAIL/SKIP for every required validation
- observed routing matrix count and exact changed-case count
- model-visible byte measurement
- proof that budgeted parallel replay refs preserve complete task results
- confirmation that no-budget/default behavior remains compatible
- confirmation that r6-01b validator-only commit remains product/runtime neutral
- blockers and whether user action is required
- confirmation that no secrets, credentials, cookies, tokens, or provider diagnostics were copied

End with exactly one classification:

PROMOTE

HOLD

REJECT

or

INCONCLUSIVE

## Git discipline

Commit and push only the allowlisted files on `fix/system-one-r6-production-review-blockers`.

Do not merge any PR.
Do not mark any Draft PR Ready for Review.
