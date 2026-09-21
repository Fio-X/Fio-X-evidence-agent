# r4-09-complex-classifier-split

Classification: HOLD

## Identity

- Branch: `exp/system-one-r4-09-complex-classifier-split`
- Tested commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- Environment: macOS 27.0; Rust/cargo 1.98.1; Python 3.14.6
- No origin/input branches were listed for this experiment; no external branch was inspected or merged.

## Change

- Added `VisualDeliveryRequirements` and `visual_delivery_requirements` to represent HTML/PNG/mobile/self-contained/interactive delivery constraints separately.
- Added opt-in `has_multi_module_analytical_complexity` and `is_complex_visual_request_split`; the existing default `is_complex_visual_request` and production routing are unchanged.
- Added a temporary-harness-based fixed 24-case A/B matrix in `scripts/test_visual_routing_matrix.py`.
- No evidence, provenance, verification, publication, or browser-QA gate was changed; no artifact/data repair was added.

## Checks

| Check | Result | Evidence |
|---|---|---|
| `cargo fmt --check` | PASS | clean |
| `python3 scripts/test_visual_routing_matrix.py` | PASS | 24 cases; baseline 10 candidates, split 7, 9 routing changes |
| `cargo test --locked prompt::tests` | PASS | 5 passed, 0 failed |
| `cargo test --locked` | PASS | 88 passed, 1 ignored, 0 failed |
| `cargo build --release --locked` | PASS | release binary built; only opt-in dead-code warnings |

## Measurements

- Single chart with mobile/self-contained HTML: baseline candidate `true`, split `false`.
- Interactive Sankey alone: baseline `true`, split `false`.
- Map + Sankey + trend: baseline `false`, split `true`.
- Four analytical modules: baseline `false`, split `true`.
- The matrix demonstrates the intended routing distinction, but the opt-in classifier is not wired into production routing in this experiment.

## Blockers and invariants

- No user action required.
- HOLD is required because the acceptance hypothesis concerns actual routing/cost impact, while this experiment is intentionally opt-in and measurement-only; no production-path reduction was measured.
- Full artifact/data/computation behavior is untouched. No daemon or cross-CLI service was introduced.
- No secrets were copied into this report.
