# r4-04-fetch-url-compact-envelope

## Tested revision

- Branch: `exp/system-one-r4-04-fetch-url-compact-envelope`
- Commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- Baseline: `feat/system-one-observability-codex-handoff` / `e5ad5a7`
- No origin/exp input branches are listed for this experiment.

## Implementation

- Added an explicitly opt-in `fetch_url` `compact_envelope` variant.
- Default `fetch_url` output is unchanged when the option is absent or false.
- The variant writes the existing full normalized source record to `sources/<content_hash>.json` and returns URL/status/content type, snapshot ref/hash, source length, a 10,000-character excerpt, truncation state, and the existing untrusted-content warning.
- Excerpt target is bounded to 8,000–12,000 characters; default is 10,000.
- No evidence, provenance, verification, publication, or browser-QA gate was changed.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored, 0 failed)
- PASS — `cargo build --release --locked`
- PASS — `node --experimental-strip-types --check runtime/pi/newsroom.ts`
- PASS — `node scripts/test_fetch_result_budget.mjs`
- PASS — `git diff --check`

## Focused measurements

Synthetic normalized bodies were 30,000 and 80,000 characters. Both persisted full source text and content hash in temporary source artifacts; both returned a 10,000-character model excerpt with `truncated_for_model: true` and hash-equivalent replay metadata.

| body chars | artifact bytes | baseline model bytes | compact model bytes | reduction | ratio |
|---:|---:|---:|---:|---:|---:|
| 30,000 | 30,264 | 30,290 | 10,495 | 19,795 | 65.35% |
| 80,000 | 80,264 | 80,290 | 10,495 | 69,795 | 86.93% |

Focused output also confirmed the prompt-injection trust warning remains present.

## Artifacts and environment

- Test output/artifacts: `/var/folders/gs/f0tb98zx3g78t4342yqhxxh40000gn/T/fetch-envelope-KPAr4X`
- OS: Darwin 27.0.0, arm64
- Node: v24.14.1
- Cargo: 1.98.1
- Rustc: 1.98.1

No secrets, credentials, cookies, provider diagnostics, or raw sensitive source material were copied into this report.

PROMOTE
