# r4-06-parallel-task-envelope

## Classification

PROMOTE

## Implementation

- Commit under test: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- Branch: `exp/system-one-r4-06-parallel-task-envelope`
- Added opt-in `compact_results` to `newsroom_parallel_tasks`; default text and details remain unchanged.
- Opt-in budgets are bounded (16 KiB per task / 64 KiB batch by default), with caller limits capped by the tool schema.
- Full DAG output remains in the existing immutable `runtime/parallel-results/` artifact with SHA-256 reference; compact response exposes statuses, previews, budget metadata, and `result_ref`.
- No scheduler, network, mutation, nested-tool, evidence, provenance, verification, publication, or browser-QA gate was weakened.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored, 0 failed)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_parallel_result_budget.mjs`
- PASS — `node scripts/test_parallel_scheduler.mjs`
- PASS — `node scripts/test_parallel_tool_contract.mjs`
- PASS — `git diff --check`

## Measurements

The focused A/B used a 12-task synthetic DAG containing six `local_text` and six `sqlite_query`-shaped tasks:

- Baseline serialized model-visible response: 257,374 bytes
- Opt-in compact serialized response: 30,893 bytes
- Reduction: 88.00%
- Full persisted batch artifact: 256,573 bytes
- Compact batch artifact: present, hash-addressed, and replay data retained (local text length 36,000; SQLite-shaped rows 180)
- Status/completion equivalence: PASS; failed tasks 0; blocked tasks 0
- Scheduler fairness/safety: PASS; same-host peak 2; write-scope normalization and no-starvation checks passed

## Environment and artifacts

- macOS 27.0 (26A428), Node v24.14.1, cargo 1.98.1, rustc 1.98.1
- Measurements used temporary system paths only; no generated artifacts were added to the repository.
- No secrets, credentials, provider diagnostics, or raw sensitive data were copied into this report.

PROMOTE
