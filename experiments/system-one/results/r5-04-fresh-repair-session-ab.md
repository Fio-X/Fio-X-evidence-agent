# r5-04 fresh repair session A/B

- Tested commit: `05a08fb0863535aa5dd506c4885d8c29bf8f9ac0` (detached HEAD; expected baseline branch `feat/system-one-observability-codex-handoff`).
- Environment: macOS 27.0; `rustc 1.98.1`; `cargo 1.98.1`; Node `v24.14.1`; Python `3.14.6`.

## Change

Added a bounded opt-in repair strategy switch in the permitted files. Default behavior remains unchanged. `same-child-packet` sends the initial prompt and two bounded packet prompts through one Pi child. `fresh-packet` starts a new session directory for each repair and passes only goal, relative refs, SHA-256 hashes, passed gates, remaining gaps, and required visual modes. The packet resolver rejects packet-hash mismatch, unsafe/missing refs, and artifact hash mismatch; it carries no evidence bodies.

## Checks

- PASS — `cargo fmt --all`; `cargo fmt --check`.
- PASS — `cargo test --locked` (87 passed, 1 ignored).
- PASS — `cargo build --release --locked`.
- PASS — `node scripts/test_stage_packet.mjs`: packet 426 bytes vs full artifact 100,025 bytes; tampered and missing refs fail closed.
- PASS — `python3 scripts/test_repair_session_strategies.py`: 10 deterministic runs per strategy; three strategies compared.
- PASS — `python3 scripts/test_pi_prompt_retry.py` and `node --check runtime/pi/stage_packet.mjs`.
- PASS — local mock CLI smoke for baseline, same-child packet, and fresh packet. Complex visual mock runs remained incomplete and surfaced the authoritative completion failure; no gate was bypassed.

## Measurements

The repeated harness measured protocol shape, not provider latency or active context. Baseline continuation: 3 child launches, 3 RPC prompts, history reused, retry prompt bytes 42, median/p95 0.000792/0.002209 ms. Same-child packet: 1 child, 3 prompts, history reused, 30 retry bytes, 0.000750/0.000875 ms. Fresh packet: 3 children, 3 prompts, history not reused, 30 retry bytes, 0.000688/0.000750 ms. The actual mock CLI emitted `prompt_count=3` for the same-child path and two `history_reused=false` fresh repair attempts. No active-token reduction is claimed.

Non-sensitive artifacts: `/tmp/r5-04-cli-complex-uHOsYZ`; packet fixtures are under each run's `retry-context/` directory. Only the allowlisted source/scripts and this result file were changed; no secrets were copied into this report.

Classification: HOLD
