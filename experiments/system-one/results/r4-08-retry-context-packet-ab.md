# r4-08-retry-context-packet-ab

Final classification: PROMOTE

## Identity and scope

- Branch: `exp/system-one-r4-08-retry-context-packet-ab`
- Tested commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- OS/tools: Darwin 27.0 arm64; cargo/rustc 1.98.1; Python 3.14.6; Node v24.14.1
- Inspected inputs only: `origin/exp/system-one-r3-02-single-invocation-persistent-pi` and `origin/exp/system-one-r3-03-stage-packet-boundary-ab`
- Changes were limited to the five manifest allowlisted files and this result file. The packet path is opt-in via `NEWSROOM_RETRY_CONTEXT_PACKET_EXPERIMENT=1`; default behavior is unchanged.

## Implementation and measurements

- Added a bounded finite prompt sequence to the existing Pi RPC lifecycle. The opt-in retry packet contains only the goal, relative refs, SHA-256 hashes, passed-gate list, remaining gaps, and required visual modes; no evidence bodies are copied.
- Full artifacts remain in the investigation bundle. The packet resolver rejects invalid schema/hash/packet-hash, unsafe, missing, and tampered refs.
- Focused packet fixture: 431 model-visible bytes versus 100,025 full artifact bytes, 99.57% reduction; tampered and missing refs failed closed.
- Ten mock complex-visual repetitions per variant:

| Variant | Median prompt bytes | Child launches | Pi RPCs | Completion retries | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Baseline | 11,951 | 3 | 3 | 2 | fail-closed incomplete mock |
| Packet + persistent child | 10,671 | 1 | 1 | 2 | fail-closed incomplete mock |

- Prompt-byte reduction: 10.71%. Both variants returned nonzero because the deterministic mock intentionally omitted required completion artifacts; no completion gate was weakened.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (87 passed, 1 ignored, 0 failed)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_stage_packet.mjs`
- PASS — `python3 -m py_compile scripts/test_retry_context_packet.py`
- PASS — `python3 scripts/test_retry_context_packet.py`
- PASS — `git diff --check`
- PASS — allowlist audit; no unrelated tracked or untracked files were added

## Blockers and artifacts

- No blocker; no user action required. Measurements are deterministic local-mock evidence, not provider-token measurements.
- Temporary measurement directories were created outside the repository and cleaned up by the harness. No generated artifacts, screenshots, traces, credentials, or raw provider diagnostics were retained.
- No secrets were copied into this report.
