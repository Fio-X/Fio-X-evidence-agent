# System One Round 1 summary

Baseline: `7188f692fb8d849bc2b4fea02af64d0a3423d00e`

All 20 isolated Luna experiments completed and pushed results.

## Classification

- PROMOTE (15): 01, 03, 04, 05, 06, 07, 08, 12, 13, 14, 16, 17, 18, 19, 20
- HOLD (3): 10, 11, 15
- INCONCLUSIVE (2): 02, 09
- REJECT (0)

## Strongest measured signals

1. Phase/tool surface: visual-story exposes 47 tools / 40,355 parameter-schema bytes at all phases. Design-only exposure is 25 tools / 22,594 bytes, a 44.0% schema-byte reduction. Full design is 48.2% smaller than full/all.
2. Context: the migration fixture's JSON IR is about 146 KB compact; a refs+hashes+reason-codes packet estimate is about 1.7 KB. A consumer-aware Stage Packet projection estimated 85.3–97.3% boundary-byte reduction.
3. Pi process lifecycle: each successful `run_prompt` launches a fresh child. Initial + continuation produced two launches; complex visual paths can reach three.
4. Critical path: a controlled 200 ms in-RPC delay increased E2E by about 212 ms. RPC/model/tool work is serial on the request path.
5. Local DAG: the supported read-only scheduler benchmark measured about 4.98x speedup on 12 local hashing tasks at concurrency 6.
6. Measurement gaps: `run-metrics.jsonl` Pi RPC aggregation is cumulative while command duration is operation-local; failed RPCs currently emit no terminal RPC metric.
7. Tool metric gap: `tool_count` records profile count and can substantially overstate effective phase-scoped registration.
8. Prompt pressure: complex visual routing adds about 3.5–3.9 KB over the base prompt; deterministic routing decisions are candidates for structured control metadata.

## Round 2 ordering

Round 2 first restores measurement trust, then tests high-value mechanisms in isolated branches. No experiment may weaken evidence, provenance, verification, publication, or browser-QA gates.

Selected experiments:

1. `r2-01-rpc-metric-correctness`: operation-local + failure-terminal RPC observability.
2. `r2-02-phase-surface-observability`: record effective phase/profile tool surface and schema bytes; validate phase-scoped runtime contracts.
3. `r2-03-persistent-pi-prototype`: bounded persistent Pi process/session prototype for initial + continuation mock flows.
4. `r2-04-stage-packet-prototype`: typed content-addressed Stage Packet with fail-closed hash/ref resolution.
5. `r2-05-sparse-checkpoint-prototype`: experimental, opt-in RESEARCH/DESIGN/PUBLISH checkpoint controller using existing IR and deterministic gates.

The local DAG result is retained as a known capability rather than immediately integrated: Round 1 critical-path evidence says local parallelism is secondary when serial RPC/model/tool work dominates.
