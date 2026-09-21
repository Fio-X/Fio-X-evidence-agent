# Experiment 02: first-model-text latency

Hypothesis: model wait, represented by `first_model_text_ms`, is a substantial portion of successful RPC time; if it dominates `rpc_ms`, round-2 optimization should focus on model latency rather than local orchestration.

Commit/branch: `7188f692fb8d849bc2b4fea02af64d0a3423d00e` / `exp/system-one-r1-02-first-model-text`.

Commands and measurements:

- `CARGO_TARGET_DIR=/tmp/system-one-02.8WXME4/target cargo build --release --locked --quiet`
- Ran 30 sequential `news investigate` commands using `scripts/perf_mock_pi.py`, with each artifact written under `/tmp`.
- Parsed the single `newsroom_rpc_metrics` event from each `events.jsonl`; no secrets or provider credentials were used.

Observed values (n=30):

- `first_model_text_ms`: min 46, median 64.5, mean 89.9, p95 212, max 230.
- `rpc_ms`: min 46, median 64.5, mean 90.3, p95 212, max 231.
- `first_model_text_ms / rpc_ms`: median 1.00, mean 0.996, range 0.969–1.00.
- End-to-end wall time: median 100.2 ms, mean 130.7 ms, range 80.4–273.0 ms.
- `startup_ms` matched `first_model_text_ms` in these mock runs (median 64.5 ms); prompt size was 5,523–5,524 bytes and tool count was 14.

Limitations: the mock peer emits no real model tokens and adds no model/network delay, so these measurements establish instrumentation behavior and local process timing, not production model latency. The high variance is therefore not attributable to a real provider. A live-provider sample is required to decide whether model wait dominates in production.

## INCONCLUSIVE
