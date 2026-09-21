# Local Codex task: System One R6 inherited Clippy cleanup

Task ID: `system-one-r6-clippy-dead-code`

Expected branch: `fix/system-one-r6-clippy-dead-code`

Base commit: `7760d30bb963dff81a8854514c83aa0ecf30c1da`

Parent fix PR: #30

## Objective

Resolve the inherited GitHub CI Clippy failure without changing System One runtime behavior.

The failing command is:

`cargo clippy --all-targets -- -D warnings`

The inherited errors are all in `src/prompt.rs`:

- `investigation` is never used in production
- `VisualDeliveryRequirements` is never constructed in production
- `visual_delivery_requirements` is never used in production

These errors already exist on PR #29 base commit `b326510c825a9c395cf583313329e05693c2f6f9`; do not treat them as a PR #30 regression.

## Required approach

Prefer removing dead compatibility/test-only API over adding `#[allow(dead_code)]`.

- Remove the unused `investigation(topic, local_data)` wrapper.
- Update prompt tests to call the production entrypoint `investigation_with_classifier(topic, local_data, false)` when they need legacy/default classifier behavior.
- Remove `VisualDeliveryRequirements` and `visual_delivery_requirements` because they are test-only and have no production caller.
- Preserve coverage for `requires_html`, `requires_png`, and split classifier semantics directly in tests where useful.
- Do not change the behavior of `investigation_with_classifier`, `is_complex_visual_request`, `is_complex_visual_request_split`, `has_multi_module_analytical_complexity`, `required_visual_modes`, or completion routing.
- Do not weaken or bypass any evidence, verification, completion, publication, browser-QA, or replay gate.

## Allowed modifications

- `src/prompt.rs`
- `local-codex/result.md`

Do not modify any other file.

If another file is genuinely required, stop and report the smallest scope expansion.

## Required validation

Run all of:

- `cargo fmt --check`
- `cargo check --all-targets`
- `cargo test --all-targets`
- `cargo clippy --all-targets -- -D warnings`
- `python3 scripts/test_visual_routing_matrix.py`
- `python3 scripts/test_round6_combined.py`
- `git diff --check`

Also confirm:

- routing remains exactly 24 cases / 9 intended changes;
- no R6 model-visible budget/replay code changed;
- no production prompt/routing semantics changed;
- no secrets, credentials, cookies, tokens, or provider diagnostics are copied.

Update `local-codex/result.md` with exact commands and PASS/FAIL results.

If all required checks pass and no blocker remains, end with:

PROMOTE

Do not merge any PR.
Do not mark any Draft PR Ready for Review.
