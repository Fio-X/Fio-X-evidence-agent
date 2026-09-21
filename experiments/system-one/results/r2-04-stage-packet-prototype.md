# r2-04-stage-packet-prototype

Final classification: PROMOTE

## Identity and scope

- Branch: `exp/system-one-r2-04-stage-packet-prototype`
- Tested commit: `4965767bdbd6880f1b21ecd846ba2e3abde55044`
- Allowed product changes: `runtime/pi/stage_packet.mjs`, `scripts/test_stage_packet.mjs`
- No Rust/product control-plane files changed. `git diff --check` passed; final changed paths were limited to the two allowed files and this result.

## Implementation and observed metrics

- Added a typed schema `0.1.0` packet containing six IR refs, six SHA-256 hashes, three reason codes, two allowed-scope entries, and a packet hash.
- Resolution checks schema/packet integrity, rejects unsafe refs, requires the referenced file, and fails closed on missing or mismatched content.
- Migration fixture boundary measurement: full IR `145,991` serialized bytes; packet `1,147` bytes; reduction `99.21%`.
- Focused test observed `artifact_count=6`, `tampered_resolution=FAIL_CLOSED`, and `missing_resolution=FAIL_CLOSED`.
- Packet contains no FactGraph, ClaimGraph, Evidence, or other full-body state; it reuses existing fixture refs and hashes.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (`87 passed`, `1 ignored`, `0 failed`)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_stage_packet.mjs`
- PASS — `node scripts/test_content_addressing.mjs`
- PASS — `node scripts/test_migration_story_ir.mjs`
- BLOCKED — `python3 scripts/test_migration_story_ir.py`; the environment lacks the pre-existing `jsonschema` Python module (`ModuleNotFoundError`). No package was installed.
- PASS — `git diff --check` and allowlist audit.

## Environment and artifacts

- OS: Darwin 27.0.0, arm64
- Node: v24.14.1; npm: 11.11.0
- Rust: `rustc 1.98.1`; Cargo: `1.98.1`
- Python: 3.14.6
- Non-sensitive artifacts: focused test output only; temporary tamper/missing fixtures were created under the system temp directory and removed by the test.
- No user action required. No secrets were copied into this report.

## Limitations

This is an opt-in/test-only module; no production caller is wired to it. The measurement covers the checked-in migration JSON IR and packet metadata, not transport latency, provider calls, or a production end-to-end publication run. The schema-validation Python test remains environment-blocked by the missing dependency.
