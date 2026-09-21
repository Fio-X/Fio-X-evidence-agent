# r4-01-fixed-token-benchmark

## Classification

PROMOTE

## Contract and implementation

- Tested commit: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`
- Branch: `exp/system-one-r4-01-fixed-token-benchmark`
- Added only `scripts/system_one_token_benchmark.py`; product/runtime behavior is unchanged.
- Fixed goal: map + flow + trend complex visual, self-contained HTML, and desktop/mobile outputs.
- Uses only `scripts/perf_mock_pi.py`; no network or provider dependency.
- Three runs write machine-readable JSON and a tab-separated table under a temporary output directory. Each run retains its complete artifact directory for replay.

## Checks

| Check | Result |
|---|---|
| `cargo fmt --check` | PASS |
| `cargo test --locked` | PASS — 87 passed, 1 ignored |
| `cargo build --release --locked` | PASS |
| `python3 -m py_compile scripts/system_one_token_benchmark.py` | PASS |
| `python3 scripts/system_one_token_benchmark.py --runs 3` | PASS |

## Measurements

| Metric | Three-run result |
|---|---:|
| median / p95 E2E | 243.12 / 243.41 ms |
| median prompt bytes | 11,896 |
| median full artifact bytes | 33,657,929 |
| Pi RPC count | 3 every run |
| completion retries | 2 every run |
| effective tools / profile | 47 / `visual-story` |
| model-visible result bytes | unavailable; baseline has no generic result telemetry |
| tool schema bytes | unavailable; no schema-byte metric in baseline run artifact |
| token input/output | unavailable; deterministic mock reports zero counters |

The per-RPC prompt byte sequence was `[9428, 1234, 1234]` on each run. The mock returned no tool calls, so the run failed closed with `qa.status=failed`; evidence, publication, and visual QA were not reported as passing. No gate was weakened and no output was substituted for the missing visual artifacts.

## Evidence locations

- JSON summary: `/var/folders/gs/f0tb98zx3g78t4342yqhxxh40000gn/T/r4-01-token-benchmark-xzbr647d/summary.json`
- Human-readable table: `/var/folders/gs/f0tb98zx3g78t4342yqhxxh40000gn/T/r4-01-token-benchmark-xzbr647d/summary.txt`
- Full per-run artifacts: the `run-1`, `run-2`, and `run-3` directories below that temporary root.

No secrets were copied into the report or benchmark summaries.

PROMOTE
