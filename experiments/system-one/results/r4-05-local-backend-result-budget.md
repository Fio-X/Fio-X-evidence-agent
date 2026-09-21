# r4-05-local-backend-result-budget

## Scope and implementation

- Branch: `exp/system-one-r4-05-local-backend-result-budget`
- Tested commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- No origin/exp input branches were listed for this manifest entry; none were merged.
- Added an opt-in `result_budget` to `newsroom_parallel_tasks`. Defaults remain unchanged.
- Local text previews are capped at 64 KiB through the newsroom layer.
- SQLite previews are bounded by rows and bytes and report `total_rows`, `preview_bytes`, and `truncated`; sandbox path resolution and read-only SQL validation remain authoritative.
- No Fact, Claim, SQL, or Evidence auto-repair, gate weakening, daemon, or cross-CLI state was added.

## Checks and measurements

Environment: Darwin 27.0.0 arm64; Node v24.14.1; Rust 1.98.1; Cargo 1.98.1; Python 3.14.6; SQLite 3.54.0.

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored, 0 failed)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_local_result_budget.mjs`
- PASS — `node scripts/test_parallel_tool_contract.mjs`
- PASS — `node scripts/test_parallel_scheduler.mjs`
- PASS — `git diff --check`

Focused synthetic A/B: local text baseline 368,898 bytes; bounded preview 65,536 bytes; reduction 82.23%. SQLite query returned 200 total rows, 3 preview rows, 91 preview bytes, and `truncated: true`; read-only rejection for `DELETE` passed. Full source/database files were not copied into a new store.

Temporary fixtures were created under the system temporary directory by the focused test and were not committed. No credentials, tokens, cookies, or other secrets were copied into this report.

PROMOTE
