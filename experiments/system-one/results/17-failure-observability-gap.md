# Experiment 17: failed-RPC observability gap

## Hypothesis

Unsuccessful Pi RPC sessions lose lifecycle and latency metrics because `newsroom_rpc_metrics` is emitted only after a successful, non-empty final answer. A bounded round-2 terminal event could preserve failure-phase, timing, and retry evidence without recording provider diagnostics.

## Commands and measurements

- Read-only source audit of `src/pi.rs`, `src/artifact.rs`, and investigation error paths at commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e` on branch `exp/system-one-r1-17-failure-observability-gap`.
- Built outside the repository: `cargo build --release --locked --target-dir /tmp/newsroom-exp17-build.rhUlfc`.
- Ran `python3 scripts/test_rpc_waits.py /tmp/newsroom-exp17-build.rhUlfc/release/news`.
- Ran temporary `investigate` mock flows with `PERF_MOCK_MODE=provider_error`, `missing_stats`, and `silent`; inspected sanitized `events.jsonl` and `run-metrics.jsonl`.

## Observed values

- The RPC matrix covered 14 modes: 0 watchdog timeouts; normal/tool/thinking/fragment returned success; 10 failure modes returned nonzero. The built-in redaction assertion reported `secret_hits=0` for the provider-error persistence case.
- `provider_error`: 3 sanitized failed prompt responses were recorded, with `provider_error_class=provider_error` and `diagnostic_suppressed=true`; `newsroom_rpc_metrics` events: `0`; `pi_rpc.calls`: `0`; all Pi timing/token totals: `0` or `null`.
- `missing_stats`: events included successful prompt acceptance, message update, `agent_settled`, and successful final-text response, then failed on session statistics; `newsroom_rpc_metrics` events: `0`; `pi_rpc.calls`: `0`; `run_metrics.duration_ms`: `1030`.
- `silent`: only the user-goal event was persisted before timeout; `newsroom_rpc_metrics` events: `0`; `pi_rpc.calls`: `0`.
- Source confirms metric emission occurs after final-answer validation, while failed investigation paths append a run metric whose `pi_rpc` value aggregates only `newsroom_rpc_metrics` events.

## Minimal round-2 proposal

Emit one sanitized terminal RPC event for both success and failure, with existing timing/context fields plus `outcome` (`success`/`failure`), `failure_phase` (for example `startup`, `prompt`, `final_text`, `session_stats`, `timeout`, or `process`), and a bounded `failure_class`. Preserve `provider_error_class`/HTTP status only as already classified fields; never include raw error/data payloads. The existing aggregate can then count failed calls and retain partial `startup_ms`, `first_model_text_ms`, prompt attempts, and elapsed `rpc_ms`.

## Limitations

Measurements use deterministic local mocks and do not establish real-provider distributions. The failure matrix reports wall time and return status, while lifecycle-field availability is established by source inspection and temporary artifact inspection; no production provider or authentication route was exercised.

## Classification

PROMOTE

Evidence supports a small, bounded round-2 observability change: multiple distinct failure phases currently collapse to zero Pi calls and lose partial timing, while existing redaction behavior provides a safe field boundary.

No secrets were copied into this report.
