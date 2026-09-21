# Result: system-one-r6-clippy-dead-code

- Tested branch: `fix/system-one-r6-clippy-dead-code`
- Tested commit SHA: `7a682c40fb6ca04672081bda4cd98a8dc903700c`
- OS/tools: Darwin 27.0.0 arm64; Python 3.14.6; rustc 1.98.1; Cargo 1.98.1

## Implementation

- Removed the unused `investigation(topic, local_data)` compatibility wrapper.
- Updated prompt tests to use `investigation_with_classifier(..., false)` for legacy/default classifier behavior.
- Removed the test-only `VisualDeliveryRequirements` type and `visual_delivery_requirements` function.
- Retained direct `requires_html`/`requires_png` coverage and split-classifier coverage.
- Only `src/prompt.rs` and this report were modified. No production prompt, routing, completion, budget, replay, evidence, verification, publication, or browser-QA behavior was changed.

## Required validation

- PASS — `cargo fmt --check`
- PASS — `cargo check --all-targets`
- PASS — `cargo test --all-targets` (88 passed, 0 failed, 1 ignored; example target 7 passed, 0 failed)
- PASS — `cargo clippy --all-targets -- -D warnings`
- PASS — `python3 scripts/test_visual_routing_matrix.py`
- PASS — `python3 scripts/test_round6_combined.py`
- PASS — `git diff --check`

The initial `cargo fmt --check` identified formatting in the edited tests; `cargo fmt` corrected it, and the required final formatter check passed.

## Evidence and metrics

- Routing: exactly 24 cases and 9 intended changes.
- Round-6 combined benchmark: 942143 baseline model-visible bytes to 30544 budgeted bytes; 0.9676 reduction; default behavior remains opt-in.
- Canonical phase inheritance: true; profiles all/discover/verify/design were 47/7/7/25 effective tools.
- Evidence, completion, publication, and browser-QA markers were present.
- No R6 model-visible budget/replay code changed; `git diff --name-only` contains only the allowed source and report files.
- No secrets, credentials, cookies, tokens, proxy data, or provider diagnostics were copied into this report.

## Blockers

- None. No user action is required.
- No commit or push was attempted; no PR was merged and no Draft PR was marked ready.

PROMOTE
