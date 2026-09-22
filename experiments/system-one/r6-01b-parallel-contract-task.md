# R6-01b parallel contract compatibility

Goal: resolve the sole Round 6 blocker without changing runtime/product behavior.

Read:
- AGENTS.md
- experiments/system-one/results/r6-01-combined-token-curve-candidate.md
- scripts/test_parallel_tool_contract.mjs
- the newsroom_parallel_tasks implementation in runtime/pi/newsroom.ts

Allowed modifications:
- scripts/test_parallel_tool_contract.mjs
- experiments/system-one/results/r6-01b-parallel-contract-compat.md

Do not modify runtime code.

Required change:
- Replace stale literal assertions that require exactly localText(required("path")) and localSqliteQuery(required("path"), required("sql")).
- Validate the current semantic contract instead:
  - local_text still maps to localText on the required path;
  - sqlite_query still maps to localSqliteQuery on required path + SQL;
  - optional result_budget is normalized through modelResultBudget;
  - budgeted local_text forwards only bounded maxBytes;
  - budgeted sqlite forwards only bounded maxBytes/maxRows;
  - no-budget branch remains valid/default-compatible;
  - scheduler artifactRoot, maxConcurrency, event logging, supported kinds, read-only/local backend boundaries remain checked.
- Do not weaken the validator to generic substring presence if a more specific structural assertion is practical.

Required checks:
- node scripts/test_parallel_tool_contract.mjs
- node scripts/test_parallel_result_budget.mjs
- node scripts/test_tool_result_budget_integration.mjs
- node scripts/test_phase_tool_scope_v112.mjs
- node scripts/test_phase_runtime_surface.mjs
- python3 scripts/test_phase_env_plumbing.py
- python3 scripts/test_visual_routing_matrix.py
- python3 scripts/test_visual_routing_cost.py
- python3 scripts/test_round6_combined.py
- cargo fmt --check
- cargo test --locked
- cargo build --release --locked
- git diff --check

Write the result to experiments/system-one/results/r6-01b-parallel-contract-compat.md.
State whether the Round 6 HOLD blocker is resolved. End with exactly one classification: PROMOTE, HOLD, REJECT, or INCONCLUSIVE.
