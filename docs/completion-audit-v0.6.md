# v0.6 Completion Audit

## Executive assessment

v0.6 closes the highest-risk findings from the v0.5 audit: the competition evaluator can no longer pass a missing-provenance artifact, source/data/computation identities are content-addressed, immutable writes reject byte collisions, computation snapshots carry verifiable input fingerprints, CJK layout is covered, and network bodies are bounded while streaming.

Current completion estimates use three different denominators:

| Scope | Estimated completion | Interpretation |
| --- | ---: | --- |
| Core architecture and implemented feature set | 88% | Rust/Pi contracts, newsroom tools, provenance, responsive visualization and independent verification are present in source |
| Competition engineering readiness | 84% | Local deterministic evidence is strong; real Pi/provider/DuckDB and business-value measurements remain |
| Final submission readiness | 76% | A definitive live artifact, multi-provider qualification and recorded metrics are still required |
| Production readiness | 58% | Needs SQL replay, whole-bundle attestation/signing, container isolation, real network/provider stress and operational telemetry |

The project should proceed to live qualification. It should not yet be described as production-ready or as having completed real end-to-end provider/DuckDB validation.

## Closed v0.5 audit findings

### Competition-gate false positives

Closed. The competition evaluator now calls the independent artifact verifier first. The valid synthetic artifact passes 14/14 only after integrity verification, while nine adversarial integrity mutations are rejected.

### Mutable evidence snapshots

Closed for source, dataset and computation evidence. Sources/datasets are content-addressed; computations bind SQL, input fingerprint set, input snapshot hash and canonical result hash. Create-only immutable writes compare exact bytes and reject collisions.

### Opaque computation input snapshot

Closed. Each computation stores a sorted `input_fingerprints` list and the verifier independently recomputes `input_snapshot_hash` while checking exact referenced source/data hashes.

### CJK newsroom rendering

Closed for the tested title/layout path. Chinese text wraps on CJK-aware boundaries while Latin word groups remain intact, and responsive snapshot tests remain green.

### Unbounded response buffering

Closed for newsroom network tools. Source and dataset bodies use bounded incremental readers; over-limit dataset downloads cancel and fail before unbounded buffering.

### Runtime module drift

Closed by the runtime contract. `newsroom.ts`, `viz.mjs`, `net.mjs` and `provenance.mjs` are all embedded/materialized by Rust and checked against Pi imports/tool registration.

## Remaining high-priority gaps

### P0: Real live E2E qualification

The current environment cannot execute Cargo/Rust, Pi or DuckDB. Mock RPC verifies the Rust-facing protocol contract in CI when Cargo is present, but the final submission still needs one real run through:

```text
Rust CLI -> Pi -> real model -> newsroom tool calls -> DuckDB -> verified claim -> responsive visualization -> news verify
```

### P0: Cargo.lock and Rust compilation evidence

`rust-toolchain.toml` pins Rust 1.98.1, but `Cargo.lock` is absent because this environment cannot resolve crates. Generate/commit it, then run fmt/check/test/clippy with `--locked` before a release tag.

### P1: Computation replay

`news verify` establishes artifact integrity and provenance consistency. It does not currently re-execute stored SQL. A malicious actor capable of rewriting an entire self-consistent artifact tree could fabricate rows and matching hashes. Live qualification should replay recorded SQL against the bound snapshots and compare canonical `result_hash` values. A future `news verify --recompute` is the natural production-grade extension.

### P1: Whole-bundle attestation

Content addressing protects individual evidence identities and detects tested mutations, but v0.6 does not sign a root manifest. Production hardening should add a Merkle/root digest and optional signature/attestation so an attacker cannot replace an entire self-consistent tree undetected.

### P1: Provider qualification

Provider configuration is portable, but OpenAI/Anthropic/DeepSeek/Kimi/GLM/gateway support has not been benchmark-qualified through the same real tool-loop scenario. At least two providers should be measured for success rate, schema/tool-call failures, recovery, latency, cost and artifact validity.

### P1: Business-value evidence

The competition score still lacks measured human-vs-agent outcomes. Record time to first defensible chart, total completion time, retained primary sources, verified claims, provenance defects, tool recovery and token/cost metrics.

### P2: Runtime isolation

The newsroom tool surface is narrow and network/DuckDB boundaries are constrained, but production claims should wait for a container/micro-VM profile with explicit filesystem, process and network policies.

## Final v0.6 smoke baseline

The final local smoke run completed every executable gate and skipped only the Rust control-plane acceptance because Cargo is unavailable:

- competition evaluator: 14/14 after integrity PASS
- integrity adversaries: 9/9 rejected
- responsive visualization p95: 0.565 ms
- small verifier: 69 checks/run, p95 2.771 ms
- scale verifier: 41 computations, 589 checks/run, p95 15.035 ms
- bounded streaming, CJK layout, content addressing, schema contracts, snapshots and mock Pi: PASS

These are deterministic component metrics. They do not represent end-to-end model/network/DuckDB latency.

## Go / no-go

- Continue engineering: **GO**
- Internal competition rehearsal: **GO**
- Generate real qualification artifact: **GO, next priority**
- Record definitive final submission video before live qualification: **NO-GO**
- Production-ready claim: **NO-GO**

The next iteration should be v0.7 Live Qualification rather than another feature-expansion cycle.
