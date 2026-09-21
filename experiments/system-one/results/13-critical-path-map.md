# Experiment 13: E2E critical-path map

## Hypothesis

An investigate run is dominated by serial Pi RPC time; local preparation and persistence are smaller, while complex-visual completion retries can append additional serial RPCs. Therefore, round-2 optimization should target RPC/session control and retry avoidance before local parallelism.

## Commands / measurements

- Read-only source inspection of `src/commands/investigate.rs`, `src/pi.rs`, `src/runtime.rs`, and `src/artifact.rs` at HEAD `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Built the implementation with `cargo build --release --locked`.
- Ran `target/release/news investigate --out <temporary-dir> --pi-bin scripts/perf_mock_pi.py ...` five times with the normal deterministic mock and five times with `PERF_MOCK_MODE=tool PERF_MOCK_DELAY=.2`. All temporary artifacts were outside the repository.
- Inspected each generated `events.jsonl` and `run-metrics.jsonl`; no provider credentials or diagnostics were collected.

## Observed values

- Normal mock, five runs: `startup_ms` 46–53 ms (one earlier cold run: 401 ms), `rpc_ms` 47–54 ms, `first_model_text_ms` 47–53 ms, `runtime_initialization_ms` 13–17 ms, `persistence_ms` 1 ms, and `end_to_end_ms` 65–70 ms. Median values were 48 ms RPC and 68 ms end-to-end.
- Tool mock with a controlled 200 ms delay, five runs: median `startup_ms` 52 ms, median `rpc_ms` 262 ms, and median `end_to_end_ms` 280 ms. The observed RPC range was 261–394 ms and end-to-end range 278–428 ms.
- The added 200 ms tool delay increased median RPC time by 214 ms and median end-to-end time by 212 ms, demonstrating that in-RPC model/tool work remains serial on the request path.
- The normal artifact recorded one `pi_rpc` call, `prompt_attempts=1`, `tool_profile=investigate`, `tool_count=14`, and zero mock token counters. The mock run ended with status `incomplete` because it emitted no tool evidence; this is expected for this timing harness.
- Code path: preparation creates/imports the bundle, builds the prompt, and writes the initial manifest; runtime initialization materializes the extension; one initial `run_prompt` then performs child startup, event processing, settlement, and final text/session-stat queries; persistence writes answer/stats, builds the audit, writes metrics/manifest, and selects the artifact. Complex visual gaps can trigger up to two sequential continuation RPCs after the initial RPC. Prompt rejection recovery also retries serially.

## Limitations

The mock has no real model latency, network latency, tool execution, or evidence production. Millisecond values are host/process scheduling measurements and showed one cold-start outlier. The run did not exercise complex-visual completion retries, local-data import, real tools, or provider-backed correctness. Thus this maps control-flow serialization and mock timing, not production end-to-end latency or quality.

## Final classification

PROMOTE
