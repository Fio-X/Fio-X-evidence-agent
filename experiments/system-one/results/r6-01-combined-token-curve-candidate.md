# r6-01-combined-token-curve-candidate

## Tested revision

- Commit: 16a0f49e95e65c25ecb236b6a1438d4bf2d12a13
- Branch: detached HEAD (the requested candidate worktree)
- OS: Darwin 27.0.0 arm64
- Tools: rustc 1.98.1, cargo 1.98.1, Node v24.14.1, Python 3.14.6

## Changes

Manually integrated the three named R5 inputs. runtime/pi/newsroom.ts combines the opt-in result-budget envelope/replay references with validated phase normalization and phase metrics. The Rust launcher forwards only validated phase values. The split visual classifier remains opt-in through NEWSROOM_COMPLEX_VISUAL_ROUTING_AB. No default behavior or evidence/publication gate was removed.

## Checks

- PASS — cargo fmt --check
- PASS — cargo test --locked (88 passed, 1 ignored)
- PASS — cargo build --release --locked
- PASS — cargo build --locked (debug binary required by phase plumbing)
- PASS — result-budget focused checks: DuckDB, fetch, local, parallel, and integration
- PASS — phase registry, phase runtime surface, and Rust phase environment plumbing
- PASS — visual routing matrix and routing-cost checks
- PASS — scripts/test_round6_combined.py
- PASS — runtime contract, visual-story routing, and git diff --check
- FAIL (extra legacy compatibility check) — node scripts/test_parallel_tool_contract.mjs

The legacy check requires the literal unbudgeted runner mapping localText(required("path")); the integrated opt-in implementation correctly passes a budget options object, so that unallowlisted validator is stale relative to R5-02. It was not modified because it is outside the round-6 allowlist.

## Combined A/B evidence

- Model-visible tool-result bytes: 942,143 baseline; 30,544 combined; 96.76% reduction.
- Full source/data/computation and parallel-batch replay references remain emitted.
- Default behavior is opt-in when result budgets and classifier routing are unset.
- Canonical inherited tool counts: all=47, discover=7, verify=7, design=25.
- Measured TypeBox schema bytes: all=41,168 (+813), discover=2,127 (+267), verify=3,216 (+546), design=22,594 (+0) versus the R5 canonical values. The deltas are the three added opt-in result_budget schema fields.
- Routing matrix: 24 cases, 9 intended changes; delivery-only cases leave visual-story, while true multi-module cases retain it.
- Evidence, completion, publication, and browser-QA markers remain present; no model output grants verification.

## Artifacts and blockers

- Phase metrics: /var/folders/gs/f0tb98zx3g78t4342yqhxxh40000gn/T/news-phase-surface-iIbKgZ
- No provider, browser login, authentication, or user action was required.
- Blocker: the unallowlisted legacy parallel-tool validator must be reconciled by the coordinating source change before promotion.
- No secrets, credentials, cookies, tokens, or provider diagnostics were copied into this report.

Classification: HOLD
