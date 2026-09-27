# r3-03-stage-packet-boundary-ab

Final classification: PROMOTE

## Identity and scope

- Branch: `exp/system-one-r3-03-stage-packet-boundary-ab`
- Tested commit: `30b5d3fe823e794b9120a987349bdc0e2d0c4dfa`
- Implementation input inspected: `origin/exp/system-one-r2-04-stage-packet-prototype` (`bd636e5`)
- Allowed changes: `runtime/pi/stage_packet.mjs`, `scripts/test_stage_packet.mjs`, `scripts/test_stage_packet_boundary.mjs`, and this result file.
- No production caller was added; Stage Packet remains test-harness-only in this round.

## Implementation and measurements

- Reused the R2 typed content-addressed packet: schema `0.1.0`, relative refs, SHA-256 content hashes, reason codes, allowed scopes, and packet hash.
- Added bounded scope enforcement at resolution and a fixture-backed boundary A/B harness.
- Research→design: inline `130,079` bytes; packet `664` bytes; reduction `99.49%`; 100 resolutions, median `0.359 ms`, p95 `0.461 ms`; 3 artifacts rehydrated per iteration.
- Design→publish: inline `15,913` bytes; packet `698` bytes; reduction `95.61%`; 100 resolutions, median `0.254 ms`, p95 `0.308 ms`; 3 artifacts rehydrated per iteration.
- Full six-artifact fixture check: `145,991` inline bytes versus `1,147` packet bytes (`99.21%` reduction).
- Packet contains refs, hashes, reason codes, scope, and packet hash only; no FactGraph, ClaimGraph, Evidence, or other full body is duplicated.
- Fail-closed checks passed for tampered content, missing refs, unsafe refs, and scope violation.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (`87 passed`, `1 ignored`, `0 failed`)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_stage_packet.mjs`
- PASS — `node scripts/test_stage_packet_boundary.mjs`
- PASS — `git diff --check`
- PASS — allowlist audit: only the three allowed implementation/test files and this result were changed or added.

## Environment and artifacts

- OS: macOS `27.0`, build `26A428`
- Node: `v24.14.1`; npm: `11.11.0`
- Rust: `rustc 1.98.1`; Cargo: `1.98.1`
- Python: `3.14.6`
- Non-sensitive artifacts: command output only; temporary fixtures were created under the system temp directory by the focused tests and removed or remained outside the repository.
- No blocker; no user action required.
- No secrets were copied into this report.
