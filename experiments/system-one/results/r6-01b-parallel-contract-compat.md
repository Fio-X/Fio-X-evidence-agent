# r6-01b parallel contract compatibility

## Revision and environment

- Tested commit: `e61fb6da72bcc2854c592a80b10f6eb57379c918`
- Branch: `exp/system-one-r6-01b-parallel-contract-compat`
- OS: Darwin 27.0.0 arm64
- Tools: rustc 1.98.1, cargo 1.98.1, Node v24.14.1, Python 3.14.6

## Change

Updated `scripts/test_parallel_tool_contract.mjs` only. Replaced stale exact unbudgeted runner literals with structural contract assertions covering:

- `local_text` path mapping and bounded `maxBytes` forwarding;
- `sqlite_query` path + SQL mapping and bounded `maxBytes`/`maxRows` forwarding;
- `result_budget` normalization through `modelResultBudget`;
- empty option objects for the no-budget/default-compatible path;
- existing supported-kind, scheduler, artifact-root, event logging, read-only, and local-backend checks.

No runtime/product source was modified.

## Required checks

- PASS — `node scripts/test_parallel_tool_contract.mjs`
  - registration count: 1
  - supported kinds: 6
- PASS — `node scripts/test_parallel_result_budget.mjs`
  - 12 tasks; batch truncation and full replay artifact verified; 32,768-byte batch limit
- PASS — `node scripts/test_tool_result_budget_integration.mjs`
  - baseline: 942,143 model-visible bytes
  - budgeted: 30,544 bytes
  - reduction: 96.76%
  - default behavior opt-in; full artifacts referenced
- PASS — `node scripts/test_phase_tool_scope_v112.mjs`
  - visual-story counts: all=47, discover=7, verify=7, design=25
- PASS — `node scripts/test_phase_runtime_surface.mjs`
  - visual-story all/discover/verify/design counts: 47/7/7/25
- PASS — `python3 scripts/test_phase_env_plumbing.py`
  - valid, invalid-fallback, and unset cases passed
- PASS — `python3 scripts/test_visual_routing_matrix.py`
  - 24 cases; 9 intended routing changes
- PASS — `python3 scripts/test_visual_routing_cost.py`
  - 24 cases; delivery-only reductions and true multi-module retention verified
- PASS — `python3 scripts/test_round6_combined.py`
  - 96.76% result-byte reduction; canonical phase inheritance; routing and gate markers passed
- PASS — `cargo fmt --check`
- PASS — `cargo test --locked`
  - 88 passed, 1 ignored
- PASS — `cargo build --release --locked`
- PASS — `git diff --check`

Additional required-by-harness command: `cargo build --locked` was run to refresh `target/debug/news` before the phase environment check. The first phase-plumbing attempt used a stale debug binary and failed its invalid-phase assertion; after the debug rebuild, the same check passed with the expected `core` fallback.

## Evidence and blockers

- Round 6 HOLD blocker: resolved. The stale parallel-tool validator now checks the current semantic budget-aware contract.
- Allowlisted modifications only: `scripts/test_parallel_tool_contract.mjs` and this result file.
- No user action, authentication, browser login, or external provider access was required.
- No non-sensitive generated artifacts were required for handoff.
- No secrets, credentials, cookies, tokens, or provider diagnostics were copied into this report.

Classification: PROMOTE
