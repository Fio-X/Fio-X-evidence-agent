# r5-05-classifier-routing-cost-ab

- Tested commit: `05a08fb0863535aa5dd506c4885d8c29bf8f9ac0` (detached HEAD; expected branch was not checked out).
- Host/tools: Darwin arm64; rustc/cargo 1.98.1; Python 3.14.6; Node v24.14.1.
- Input evidence inspected only from `origin/exp/system-one-r4-09-complex-classifier-split` with `git log`/`git diff`.

## Implementation

Added the smallest opt-in route switch: `NEWSROOM_COMPLEX_VISUAL_ROUTING_AB=split`. It drives both investigation prompt construction and effective `visual`/`visual-story` profile selection. Unset/default behavior uses the existing classifier. The split preserves the visual delivery contract and explicit visual-mode completion gates; it only changes the complex visual route predicate. Added fixed matrix and cost harnesses.

## Checks

- PASS — `cargo fmt --check`.
- PASS — `cargo test --locked`: 88 passed, 0 failed, 1 ignored.
- PASS — `cargo build --release --locked` (three non-fatal dead-code warnings from standalone/production compilation).
- PASS — `python3 scripts/test_visual_routing_matrix.py`: 24 fixed cases, 9 route changes.
- PASS — `python3 scripts/test_visual_routing_cost.py`: prompt UTF-8 bytes and effective inherited profile counts reported for every case.
- PASS — dry-run A/B: default `interactive Sankey` emitted the complex contract; split variant did not.
- PASS — repeated measurements: 20 matrix runs and 20 cost runs; every run reported 24 cases and 9 route changes.
- PASS — `git diff --check`.

## Observed metrics

Effective tool-count proxy (canonical `visual-story -> visual` inheritance): `investigate=14`, `visual=36`, `visual-story=47`.

Changed routes were six delivery-only cases from `visual-story` to `visual` and three true multi-module cases from `visual` to `visual-story`. Delivery-only prompt bytes decreased, for example `interactive Sankey` 9,231 -> 7,356 and mobile self-contained single chart 9,085 -> 7,377. Multi-module prompt bytes increased because the required complex contract is added, for example map+Sankey+trend 7,360 -> 10,173. No requested visual mode or evidence/completion gate was removed.

Artifacts: `/tmp/r5-05-matrix.json`, `/tmp/r5-05-cost.json`, and repeated `/tmp/r5-05-{matrix,cost}-*.json` measurement outputs. No repository-generated artifacts were added.

No blockers or user action required. No secrets were copied into this report.

Classification: PROMOTE
