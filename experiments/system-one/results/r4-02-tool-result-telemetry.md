# r4-02-tool-result-telemetry

- Tested commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- Branch: `exp/system-one-r4-02-tool-result-telemetry`
- Baseline: `origin/feat/system-one-observability-codex-handoff` at the tested commit
- Listed input branches: none for this manifest entry; no origin/experiment branch was integrated.
- Environment: Darwin arm64, `rustc 1.98.1`, Node `v24.14.1`, Cargo `1.98.1`.

## Changes

`textResult` now records UTF-8 `model_visible_result_bytes` in `details` while returning the original text unchanged. Optional scalar `artifact_bytes` and `truncated_for_model` metadata are accepted through the telemetry argument. No source body is copied into telemetry, and no evidence or trust behavior was changed.

## Checks

- PASS — `cargo fmt --check`
- PASS — `cargo test --locked` (`87 passed`, `1 ignored`, `0 failed`)
- PASS — `cargo build --release --locked`
- PASS — `node scripts/test_tool_result_telemetry.mjs`
- PASS — `git diff --check`
- PASS — final changed paths are exactly `runtime/pi/newsroom.ts`, `scripts/test_tool_result_telemetry.mjs`, and this result file.

## Measurements

The focused synthetic harness reports:

- small result: `12` model-visible bytes;
- Unicode result: byte count matched `Buffer.byteLength(..., "utf8")`;
- large result: `262144` model-visible bytes for a 256 KiB result;
- optional artifact size: `1048576` bytes;
- optional `truncated_for_model`: `true`;
- returned large-result text was byte-for-byte unchanged;
- telemetry contained no duplicated `text` field or raw source body.

Full artifacts remain available because this change only annotates the returned result and does not truncate or replace content. No user action or external provider access was required. No secrets were copied into this report.

Classification: HOLD
