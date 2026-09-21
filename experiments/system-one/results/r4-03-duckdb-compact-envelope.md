# r4-03-duckdb-compact-envelope

Classification: PROMOTE

## Identity and scope

- Commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- Branch: `exp/system-one-r4-03-duckdb-compact-envelope`
- OS: Darwin 27.0.0 arm64
- Tools: Node v24.14.1; cargo 1.98.1; rustc 1.98.1; DuckDB v1.5.5
- No origin/exp input branches were listed for r4-03, so none were inspected.
- Changed only the manifest-allowed runtime/test files plus this result file.

## Implementation

Added an opt-in `NEWSROOM_DUCKDB_COMPACT_ENVELOPE` branch. Default `duckdb_query` output remains the existing `{row_count, rows, artifact}` envelope. When enabled, model-visible output contains `row_count`, `columns`, up to 50 `preview_rows`, `artifact_ref`, `result_hash`, and `truncated_for_model`. The existing content-addressed computation artifact still stores all rows and the existing evidence check runs before query execution.

## Checks

| Check | Result | Evidence |
|---|---|---|
| `cargo fmt --check` | PASS | exit 0 |
| `cargo test --locked` | PASS | 87 passed, 1 ignored, 0 failed |
| `cargo build --release --locked` | PASS | release binary built |
| `node scripts/test_duckdb_result_budget.mjs` | PASS | 240-row A/B fixture |
| `node scripts/test_computation_row_tables.mjs` | PASS | row-table materialization |
| `node scripts/test_evidence_gate.mjs` | PASS | unsupported claims and synthetic bypass blocked |
| `node scripts/test_phase_tool_scope_v112.mjs` | PASS | 53 tools; 14 investigate tools |
| `git diff --check` | PASS | no whitespace errors |

## Measurements

- Fixture: 240 deterministic rows; preview: 50 rows.
- Baseline model-visible bytes: 34,201.
- Compact model-visible bytes: 7,272.
- Reduction: 26,929 bytes / 78.74%.
- `result_hash`: `402394ce4fc7601bffdcece943e0f14c9d37e8b4e300b0d6075af41106d27ae0`.
- Replay/hash equivalence: PASS; compact envelope hash equals the full-row hash.
- Full computation artifact retention: PASS by source contract; artifact is written before either response envelope is returned.
- Evidence gate behavior: PASS; focused source check confirms `assertInlineRowsHaveEvidence(...)` remains on the query path.

Artifacts are limited to the repository test script and result report; no provider traces, screenshots, or credentials were written. No secrets were copied into this report.

PROMOTE
