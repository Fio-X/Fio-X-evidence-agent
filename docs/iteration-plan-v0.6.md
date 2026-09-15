# v0.6 Audit Hardening Iteration Plan and Status

## Goal

Turn v0.5's observable agent demo into an independently verifiable investigation artifact. The release gate is evidence integrity, reproducibility and safe failure behavior before adding more visualization types or agent roles.

## Gate 1 — Artifact integrity verifier — COMPLETE

Implemented:

- `news verify <artifact>` in the Rust CLI
- independent `scripts/verify_artifact.py`
- safe reference/path traversal validation
- dataset/source/computation hash validation
- verified claim source/computation reference validation
- visualization plan/lint/computation/claim/SVG/critic linkage validation
- competition evaluator now requires artifact integrity first
- nine adversarial cases must fail

The v0.5 false-positive class is closed in the independent Python verifier. Rust parity is implemented and remains a compile/CI acceptance item because Cargo is unavailable locally.

## Gate 2 — Immutable/content-addressed evidence — COMPLETE

Implemented:

- fetched source snapshots use a source content hash path
- downloaded/local datasets use payload SHA-256 paths
- deterministic dataset core sidecars plus acquisition records under `data/origins/`
- computations use `SHA256(SQL + input_snapshot_hash + result_hash)` paths
- each computation stores sorted `input_fingerprints`
- verifier recomputes the snapshot hash and checks every fingerprint against exact source/data bytes
- content-addressed writers compare existing bytes and reject collisions
- volatile timestamps were removed from content-addressed objects so identical operations are idempotent

## Gate 3 — CJK-safe newsroom rendering — COMPLETE

Implemented:

- CJK-aware tokenization/wrapping while preserving Latin word groups
- Chinese mobile title smoke test
- full-message preservation assertion
- existing desktop/mobile snapshot suite remains green

## Gate 4 — Bounded streaming network I/O — COMPLETE

Implemented:

- streaming `ReadableStream` readers in `runtime/pi/net.mjs`
- bounded source-text reads with truncation
- hard 25 MB dataset limit before unbounded buffering
- body cancellation at the limit
- redirect/private-network checks retained
- prompt-injection trust markers in fetched source output and investigation prompt
- local stream mocks verify truncation and hard-failure behavior

## Gate 5 — Reproducibility and CI — PARTIALLY COMPLETE

Completed:

- `versions.json` release baseline
- Rust 1.98.1 pinned by `rust-toolchain.toml`
- CI Node.js baseline pinned to 22.19.0
- Pi 0.85.1 and DuckDB 1.5.5 documented as v0.6 qualification baselines
- release-baseline contract added to smoke/CI
- verifier/adversarial/CJK/streaming/content-address tests in smoke/CI
- Rust ↔ Pi mock acceptance retained as a mandatory CI gate

Outstanding:

- `Cargo.lock` cannot be generated in the current environment because Cargo is unavailable
- real Pi + model provider + DuckDB E2E must still be executed on a qualified machine

## Performance gates — COMPLETE FOR LOCAL COMPONENTS

Latest representative results:

- responsive visualization pipeline p95: 0.565 ms, budget 10 ms
- small artifact verifier p95: 2.771 ms, budget 15 ms
- 41-computation / 589-check verifier p95: 15.035 ms, budget 40 ms

These budgets cover local deterministic components. End-to-end latency remains an external acceptance metric.

## Bugs and audit gaps found during v0.6

1. Runtime materialization initially omitted new `net.mjs` and `provenance.mjs`; Rust would have launched an extension with missing imports. The runtime contract now covers every module.
2. A content-address path initially accepted any pre-existing file without comparing bytes. Immutable writes now reject byte mismatches.
3. Content-addressed objects initially included timestamps, defeating byte-level idempotence. Volatile timestamps were removed from immutable objects.
4. Computations initially carried only an opaque `input_snapshot_hash`. They now persist verifiable input fingerprints.
5. The visualization schema still declared v0.4 while runtime plans declared v0.6. The provider-independent schema is now v0.6.
6. The previous competition evaluator could pass missing provenance. Integrity verification is now gate zero.

## Release criteria

Locally satisfied:

1. prior fake artifact class is rejected
2. valid synthetic artifact passes integrity + 14/14 competition gates
3. content addressing primitives are idempotent and content changes alter identities
4. CJK mobile text wraps correctly
5. network stream limits are enforced before unbounded buffering
6. local deterministic performance budgets pass
7. all runnable smoke tests pass

External release blockers:

1. generate and commit `Cargo.lock`
2. compile/test/clippy with Rust 1.98.1
3. run real Pi 0.85.1-compatible agent path with a qualified provider
4. run real DuckDB 1.5.5 analytical path
5. capture one complete live artifact that passes `news verify` and 14/14 evaluator gates
