# 12 — Parallel task speedup

## Hypothesis

For independent, read-only local evidence tasks, `newsroom_parallel_tasks` and its DAG scheduler materially reduce wall time versus sequential execution without violating resource or safety limits.

## Commands and measurements

- `node --version; npm --version; sw_vers; uname -m`
- `node scripts/test_parallel_tool_contract.mjs` — PASS
- `node scripts/test_parallel_scheduler.mjs` — PASS
- `node scripts/macos_parallel_smoke.mjs` — PASS
- Five repetitions of `node scripts/macos_parallel_smoke.mjs` — PASS each

The smoke benchmark hashes twelve 256 KiB local files sequentially and through the supported DAG path (`maxConcurrency: 6`).

## Observed values

- Environment: macOS 27.0, arm64, Node v24.14.1.
- Five-run sequential wall times: 201.134, 216.257, 218.185, 198.768, 205.364 ms; mean **207.942 ms**.
- Five-run parallel wall times: 41.793, 41.620, 40.538, 40.969, 43.906 ms; mean **41.765 ms**.
- Mean sequential/parallel ratio: **4.98×**.
- DAG benchmark maximum observed parallelism: **6**.
- Network smoke maximum same-host concurrency: **2**; cross-host scheduler maximum: **4**.
- Safety/scheduler checks: traversal and symlink escapes rejected; fairness, write-scope isolation, output budgets, failure/blocked-task accounting, and registry contract all passed.

## Limitations

This is a local synthetic benchmark on twelve equal-size files, not an end-to-end newsroom investigation. It does not measure provider/model latency, mixed task sizes, disk contention at production scale, or correctness of external evidence retrieval. The result demonstrates available local fan-out, not a guaranteed application-wide speedup.

## Classification

**PROMOTE**
