# v1.13 Iteration Plan: Production Qualification

Release target: `1.13.0-rc1`

## Problem statement

v1.12 established evidence-bound browser publication, security hardening and unified PR/RC/final profile definitions, but final promotion remained an external checklist. The source tree also exposed three production-control defects during clean-room execution: newly added StoryGraph/basemap/network-reduction tools were present in the Pi extension but absent from the Rust allowlist, the PR gate depended on stale generated outputs for one schema test, and the release manifest included unstable/self-referential inputs.

v1.13 therefore freezes visualization-surface expansion and turns release readiness itself into an auditable product capability.

## P0. Production host contract and preflight

Add `config/production-host.json` and `scripts/production_preflight.py`.

The preflight must report, in one JSON artifact:

- Node >= 22.19.0,
- Rust 1.98.1 and Cargo,
- DuckDB 1.5.5,
- Pi 0.85.1,
- Python 3.13,
- Chromium availability,
- every required Cargo/npm lockfile,
- sandboxed CPU browser qualification,
- WebGL2 GPU browser qualification,
- provider credentials.

Acceptance gate: no missing requirement may be collapsed into a generic `not ready` flag; every blocker must be named.

## P1. Exact agent tool-surface closure

Derive the public tool surface from `registerScopedTool(...)` in the bundled Pi extension and require exact equality with the Rust `NEWSROOM_TOOLS` allowlist. Replace the audit module's hand-maintained long capability enumeration with a `newsroom_*` rule plus the small core data-tool set.

Acceptance gate: adding a Pi tool without exposing it through Rust must fail the PR runtime-contract test.

## P2. Live trusted-publication qualification

Extend the provider-backed qualification path beyond the SVG/magazine layer. The real model must:

1. build a verified StoryGraph,
2. produce the existing responsive visual/infographic package,
3. plan `PublicationSpec 0.3` against the same StoryGraph and InfographicSpec,
4. bind at least two browser modules to immutable computations and verified claims,
5. render production HTML,
6. pass sandboxed CPU browser QA with zero external requests and complete accessibility metadata,
7. survive `news verify --recompute`.

`write_qualification.py` must treat trusted browser publication as a required final-live check.

## P3. Dependency-lock workflow

Final promotion requires reviewed, committed:

- `Cargo.lock`,
- `runtime/web/package-lock.json`,
- `runtime/sigma/package-lock.json`,
- `runtime/map/package-lock.json`,
- `runtime/d3/package-lock.json`.

Add `generate_dependency_locks.sh`, `verify_dependency_locks.py` and a GitHub workflow that creates lock artifacts on the pinned Node/Rust toolchains. Runtime images continue to use `npm ci`, and the live Rust build uses `cargo build --locked`.

Acceptance gate: final release check fails when any lock is missing or inconsistent with its manifest.

## P4. Hermetic PR/RC qualification

PR qualification must run from an empty `outputs/` directory. Producer fixtures must appear before consumer schema tests. Keep the monolithic visual smoke on the standard CI host, while allowing a host-constrained segmented evidence report for interactive development; segmented evidence can never satisfy the standard final RC gate.

Acceptance gate: deleting `outputs/` before PR qualification still produces PASS.

## P5. Stable release provenance

`release-manifest.json` must not hash itself. Produce a stable `source_tree.sha256`, and compute `manifest_sha256` from stable fields rather than the wall-clock generation timestamp. Add a regression that builds the manifest twice and requires identical digests.

Acceptance gate: two consecutive manifest builds over the same source tree have identical source and manifest digests.

## P6. Cold-story dossier

Formalize the real-story qualification threshold:

- >= 12 passing cold cases,
- >= 6 real news cases,
- >= 8 topology families,
- zero silent semantic errors,
- >= 1 correct advanced-visual abstention.

The initial v1.13 ledger imports seven previously qualified cases rather than inventing new evidence. Final stays blocked until the remaining coverage is executed and recorded.

## P7. Final qualification dossier

`final_qualification.py` combines:

- production preflight,
- standard-host RC gate,
- cold-story gate,
- provider-backed live qualification including browser publication,
- dependency-lock state,
- qualified-human artifact attestation,
- release manifest.

Acceptance gate: final status is `PASS` only when every machine and human check is present and passing. Missing evidence yields explicit `BLOCKED` reasons.

## Current-host expected result

This host is expected to qualify the CPU browser path and PR/segmented-RC evidence, while final remains blocked by Node 22.16, missing Rust/Cargo, missing DuckDB/Pi, missing dependency locks, absent WebGL2, absent provider credentials, incomplete cold-story coverage and no qualified-human attestation.
