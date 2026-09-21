# Round-1 experiment: 15-session-continuation-cost

Tested commit: `7188f692fb8d849bc2b4fea02af64d0a3423d00e`  
Branch: `exp/system-one-r1-15-session-continuation-cost`

## Hypothesis

Reusing a persistent Pi session through `continue_session` should reduce continuation startup/RPC latency and prompt payload relative to a new initial investigation.

## Commands and measurements

- Built the unchanged commit outside the repository: `CARGO_TARGET_DIR=/tmp/system-one-15-build.seuXRK cargo build --release --locked --bin news` — PASS.
- Ran one initial `investigate` and one same-artifact `continue` with `scripts/perf_mock_pi.py`, then repeated five paired flows. Temporary artifacts/logs: `/tmp/system-one-15-run.h3jDNr` and `/tmp/system-one-15-repeats.cazYTK`.
- Extracted `newsroom_rpc_metrics` from each artifact's `events.jsonl`; checked `continue_session` flags and `tool_count`.

## Observed values

Five paired warm-mock flows (initial → continuation; median):

| Metric | Initial | Continuation | Change |
|---|---:|---:|---:|
| startup_ms | 53 | 53 | 0 ms (0%) |
| rpc_ms | 53 | 53 | 0 ms (0%) |
| first_model_text_ms | 53 | 53 | 0 ms (0%) |
| prompt_bytes | 5,527 | 549 | -4,978 bytes (-90.1%) |

All initial metrics had `continue_session=false`; all continuation metrics had `continue_session=true`; `tool_count` remained 14. Each operation emitted one RPC metric, while the cumulative `run-metrics.jsonl` after continuation reported `calls=2`.

The first cold pair was 241 ms initial versus 42 ms continuation, but subsequent initial runs were 42–56 ms, so that result is treated as cold-process noise rather than a repeatable persistence benefit.

## Limitations

The deterministic mock emits no model/provider work, tool calls, or realistic session-token/cache behavior. It cannot establish live-provider latency or token-cost savings. The measured continuation still launches a new Pi child process; the evidence therefore supports prompt-payload reduction, not process-persistence latency reduction.

## Classification

HOLD
