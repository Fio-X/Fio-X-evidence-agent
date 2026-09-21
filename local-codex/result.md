# Result: system-one-r6-production-review-blockers

- Tested branch: `fix/system-one-r6-production-review-blockers`
- Tested source commit: `8e03ca802570201905aace6f3d2963fc4dc22532`
- Final commit SHA: not created (Git metadata write blocked)
- OS/tools: macOS 27.0 (26A428); Node v24.14.1; Python 3.14.6; rustc 1.98.1; Cargo 1.98.1; Pi 0.85.1

## Files modified

- `src/commands/investigate.rs`
- `runtime/pi/newsroom.ts`
- `runtime/pi/local_backend.mjs`
- `scripts/test_parallel_tool_contract.mjs`
- `scripts/test_visual_routing_matrix.py`
- `scripts/test_round6_combined.py`
- `scripts/test_parallel_replay_wiring.mjs` (new narrowly scoped semantic test)
- `local-codex/result.md`

## Required validation

PASS — `node scripts/test_parallel_tool_contract.mjs`

PASS — `node scripts/test_parallel_result_budget.mjs`

PASS — `node scripts/test_parallel_replay_wiring.mjs`

PASS — `node scripts/test_tool_result_budget_integration.mjs`

PASS — `node scripts/test_phase_tool_scope_v112.mjs`

PASS — `node scripts/test_phase_runtime_surface.mjs`

PASS — `python3 scripts/test_phase_env_plumbing.py`

PASS — `python3 scripts/test_visual_routing_matrix.py`

PASS — `python3 scripts/test_visual_routing_cost.py`

PASS — `python3 scripts/test_round6_combined.py`

PASS — `cargo fmt --check`

PASS — `cargo test --locked` (88 passed, 0 failed, 1 ignored)

PASS — `cargo build --release --locked` (three existing dead-code warnings)

PASS — `git diff --check`

## Evidence

- Routing matrix: exactly 24 cases and exactly 9 changes. Changed cases: `single Sankey`, `Sankey HTML`, `mobile chart`, `dashboard`, `Chinese mobile`, `Chinese Sankey`, `map + Sankey + trend`, `map + Sankey + trend mobile`, `four modules`.
- Model-visible measurement: 942143 baseline bytes, 30544 budgeted bytes, reduction ratio `0.9676` (96.76%); default behavior remains opt-in.
- Parallel replay: semantic test produced a complete 96000-byte text result and 240 complete SQLite rows. Both per-task `full_result_ref` artifacts and the `full_batch_ref` were readable and preserved complete values while scheduler output was bounded (`per_task_truncated: 2`).
- No-budget/default behavior: local backend default text cap remains intact; parallel wiring uses explicit full-result mode and leaves model-visible truncation to the scheduler.
- `r6-01b` validator-only commit remains product/runtime neutral; no files from that experiment were modified.
- The additional non-required `scripts/test_local_result_budget.mjs` still expects the removed helper-level `maxRows` API. It was not modified because it is outside the task allowlist; all required validations pass.

## Blockers

Commit and push are blocked because Git could not create `/Users/fio/code/.git/worktrees/PJ004/index.lock` (`Operation not permitted`); that Git metadata path is outside the writable workspace root. User action is required to grant Git metadata write access or complete the commit/push from an environment with that access. No secrets, credentials, cookies, tokens, or provider diagnostics were copied into this report.

HOLD
