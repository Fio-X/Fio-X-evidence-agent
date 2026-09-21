# r5-02 unified-tool-result-budget

Classification: PROMOTE

## Tested implementation

- Commit: `05a08fb0863535aa5dd506c4885d8c29bf8f9ac0`
- Branch: detached `HEAD` (experiment baseline; expected source branch `feat/system-one-observability-codex-handoff`)
- OS: Darwin 27.0.0, arm64
- Tools: Node v24.14.1; Rust 1.98.1; Cargo 1.98.1
- Only changed allowlisted files plus this result file. No secrets copied.

## Implementation

Added one opt-in `result_budget` policy (`max_bytes`, `max_rows`) across DuckDB, fetch URL, and parallel task tools. Local text/SQLite use the same limits. Disabled/omitted policy preserves existing returned content. Budgeted paths retain content-addressed computation/source/full-batch artifacts and expose hashes/references, bounded previews, trust warnings, and consistent model-visible byte/truncation telemetry. Read-only SQLite and evidence verification paths remain authoritative.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (`87 passed, 0 failed, 1 ignored`)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_duckdb_result_budget.mjs`
- PASS — `node scripts/test_fetch_result_budget.mjs` (30K and 80K synthetic sources)
- PASS — `node scripts/test_local_result_budget.mjs` (368,898-byte text fixture; 65,536-byte preview)
- PASS — `node scripts/test_parallel_result_budget.mjs` (12 tasks; replayable full batch artifact)
- PASS — `node scripts/test_tool_result_budget_integration.mjs`
- PASS — JS syntax checks and `git diff --check`

## Repeated measurement

Ten repeated integration runs produced identical deterministic metrics:

- Baseline model-visible bytes: `942143`
- Budgeted model-visible bytes: `30544`
- Reduction: `0.9676` (96.76%), minimum and maximum both `0.9676`
- Combined reduction exceeds the required 75% threshold.

## Evidence and blockers

- DuckDB preview is bounded to 50 rows and retains row hash plus computation artifact reference.
- Fetch preview retains full source snapshot/hash and untrusted-content warning.
- Local text/SQLite remain sandboxed/read-only; SQLite full query output is read before bounded previewing.
- Parallel output retains full hash-addressed batch replay artifact and reports truncation.
- No verification, provenance, completion, publication, browser-QA, or evidence gate was changed; no AutoRepair state or duplicate factual store was introduced.
- No human action or provider authentication was required. Temporary non-sensitive measurement files were written under `/tmp` only and are not repository artifacts.

PROMOTE
