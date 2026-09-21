# 01-rpc-startup

## Hypothesis

For a successful mock investigation, Pi process/startup time is a material share of RPC wall time; if so, persistent Pi is worth bounded round-2 investigation.

## Commands and measurements

- Read-only checkout at branch `exp/system-one-r1-01-rpc-startup`, commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Built unchanged source with `cargo build --release --locked --target-dir /private/tmp/...` (temporary target outside the repository).
- Ran 20 sequential successful commands equivalent to:
  `news investigate --out <temporary-dir> --pi-bin scripts/perf_mock_pi.py 'rpc-startup experiment'`
  with `PERF_MOCK_MODE=normal` and bounded RPC waits.
- Parsed each temporary artifact's `events.jsonl` for its single `newsroom_rpc_metrics` event; no product files were modified.

## Observed values

| Metric | n | Min | Median | Mean | Max |
|---|---:|---:|---:|---:|---:|
| End-to-end wall time (ms) | 20 | 75.202 | 85.577 | 121.642 | 743.205 |
| `startup_ms` | 20 | 43 | 56.5 | 56.55 | 70 |
| `rpc_ms` | 20 | 43 | 56.5 | 56.75 | 70 |
| `startup_ms / rpc_ms` | 20 | 0.980 | 1.000 | 0.996 | 1.000 |

All 20/20 runs exited successfully and produced 20/20 metrics events. The first wall-time sample was 743.205 ms; the remaining process-inclusive wall times were 75.202–132.824 ms.

## Limitations

The peer is deterministic and does not contact a model/provider; this measures local process/RPC control-path behavior only. The runs launch a fresh Pi process each time, so they do not measure an actual persistent-session implementation or its correctness/evidence gates. The wall-time outlier also shows process scheduling/startup noise. A live-provider comparison and a round-2 persistent-Pi prototype are required before estimating user-visible benefit.

## Classification

**PROMOTE** — startup accounts for essentially all measured successful mock RPC time, providing strong evidence that a bounded persistent-Pi experiment is worthwhile.

No secrets were copied into this report.
