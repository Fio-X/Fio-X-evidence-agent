# v0.7 Completion Audit

## Executive assessment

v0.7 is a strong release candidate for the AI-agent competition engineering track, but it is not yet live-qualified in the current container. The core Rust/Pi architecture, bounded tools, evidence model, visualization subsystem, integrity verification, SQL replay contract, run telemetry and qualification harness are implemented. The remaining blocker is empirical: a real Rust -> Pi -> model -> newsroom tools -> DuckDB run must be recorded on an environment that can install the pinned runtimes and has a provider credential.

Recommended completion estimates:

| Dimension | Completion |
| --- | ---: |
| Core architecture and feature implementation | 92% |
| Evidence/provenance and deterministic verification | 94% |
| Visualization/editorial engine | 90% |
| Automated engineering/competition gates | 90% |
| Live provider qualification | 55% |
| Final competition submission readiness | 82% |
| Production readiness | 65% |

The live-provider percentage is deliberately lower because configuration, mock RPC, and CI workflow definitions are not evidence of a real model run.

## Closed findings from the v0.6 audit

### Computation replay

Closed at implementation level. `news verify --recompute` exists and performs real DuckDB CLI replay when DuckDB is available. CI contains a real DuckDB replay job.

### End-to-end timing

Closed at artifact level. Every investigate/continue operation records wall-clock status and duration in `run-metrics.jsonl`; `news inspect` aggregates the values. Synthetic qualification fixtures are required to contain valid metrics, which prevents the test corpus from bypassing the contract.

### Provider qualification

Closed at harness level. `scripts/live_qualification.sh` and the manual live-qualification GitHub workflow require a two-turn investigation, integrity verification, SQL replay and qualification summary. A provider is not considered qualified merely because it appears in configuration.

### Reproducible runtime baseline

Partially closed. Exact target versions are machine-readable in `versions.json`, `rust-toolchain.toml`, CI and `Dockerfile.live`. `Cargo.lock` cannot be generated in this container because Cargo is unavailable. It must be generated and committed in the first Rust-enabled run before the final competition tag.

## Current blocker evidence

`docs/live-readiness-v0.7.json` reports `live_ready=false`. Required failures are Node below the pinned Pi minimum, missing Pi, missing DuckDB, missing rustc and missing Cargo. The container also lacks provider credentials. `docs/bootstrap-v0.7.log` records failed installation attempts caused by inaccessible external distribution hosts.

This is an environment blocker, not a passing live test. The release must remain labelled `live-ready pending external qualification` until the manual workflow or an equivalent workstation run produces a real `qualification.json`.

## Risk register

| Priority | Risk | Current mitigation | Release action |
| --- | --- | --- | --- |
| P0 | No real model qualification artifact yet | manual qualification workflow and strict readiness gate | run at least one strong provider before final recording |
| P0 | No committed Cargo.lock | compiler pin and CI compile | generate/commit lockfile on Rust-enabled runner |
| P1 | Provider behavior can drift | provider qualification is behavioral and artifact-backed | rerun qualification after provider/model upgrades |
| P1 | DuckDB replay can be expensive on large artifacts | default integrity verification remains fast; replay is explicit | benchmark Ember Europe replay and add caching only if measured |
| P1 | External search/source reliability | bounded network tools, failure/replan evidence | run three failure-recovery rehearsals |
| P2 | Visual critic remains deterministic | structural/editorial rules are reproducible | add image-aware critic only after live core is stable |

## Go / no-go

Internal engineering demo: **GO**.

Push to a repository and run normal CI: **GO**.

Run manual real-provider qualification: **GO, required next**.

Record the final competition video before a real qualification artifact exists: **NO-GO**.

Claim production readiness: **NO-GO**.

No additional chart family or new agent role should be added before the live qualification blocker is closed.
