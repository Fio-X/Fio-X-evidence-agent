# v1.13 Completion Audit

Status: `1.13.0-rc1`

## Completed

### Production qualification contract

`config/production-host.json` now defines the final runtime contract instead of leaving it implicit across README notes and workflow YAML. The contract names the pinned/minimum Node, Rust, DuckDB, Pi, Python and browser expectations, all required dependency locks, CPU/GPU browser requirements and the cold-story threshold.

`production_preflight.py` reports every blocker in one machine-readable artifact. On the current host it correctly identifies Node 22.16.0, missing Rust/Cargo, missing DuckDB, missing Pi, missing dependency locks, missing WebGL2 and missing provider credentials. Python 3.13, Chromium 144 and the sandboxed CPU browser lane pass.

### Rust/Pi tool-surface closure

Clean-source execution discovered three tools that existed in the Pi extension but were absent from the Rust CLI allowlist: `newsroom_story_graph`, `newsroom_basemap_prepare` and `newsroom_network_reduce`. They are now exposed through Rust. The audit module no longer duplicates the full tool list; `newsroom_*` tools plus the small core data-tool set are counted by rule.

`check_runtime_contract.py` now parses all `registerScopedTool(...)` registrations and requires exact set equality with `NEWSROOM_TOOLS`. Current count: 49 registered / 49 allowed.

### Live browser-publication qualification contract

The live provider scenario now explicitly requires `newsroom_story_graph` and the trusted browser publication path after the approved InfographicSpec. A provider must create at least two evidence-bound browser modules, render production packaging and pass sandboxed CPU `newsroom_publication_qa` with zero external requests and accessibility metadata.

`write_qualification.py` now treats a passing evidence-bound publication manifest plus passing browser QA as the `browser_publication_passed` final-live check.

### Dependency-lock workflow

Added:

- `scripts/generate_dependency_locks.sh`,
- `scripts/verify_dependency_locks.py`,
- `.github/workflows/generate-locks.yml`.

The workflow generates `Cargo.lock` plus package locks for web, Sigma, map and D3 runtimes on the pinned Node/Rust toolchains. Live Rust builds now use `cargo build --locked`; specialist Node images already use `npm ci`.

The current host cannot acquire missing package metadata and has no Cargo, so the five required locks remain intentionally absent and the lock gate is `BLOCKED` rather than fabricated.

### Hermetic PR gate

A clean `outputs/` run exposed an ordering defect: `test_publication_schema_v19.py` consumed generated v1.9 publication fixtures before the profile produced them. The PR profile now runs the browser fixture producer and trusted-publication producer before schema validation.

After deleting `outputs/`, the complete PR profile passes.

### Stable release provenance

`build_release_manifest.py` no longer includes `release-manifest.json` in its own source-tree hash and no longer includes wall-clock generation time in `manifest_sha256`. It emits a separate `source_tree.sha256`.

A regression builds the manifest twice with a time gap and requires identical source-tree and manifest digests. The test passes.

### Production browser evidence

The v1.13 production browser qualification passes the CPU lane with:

- sandbox enabled,
- zero external HTTP requests,
- trusted production HTML about 14 KB before the content-addressed local Plotly asset,
- accessibility checks passing.

The same artifact intentionally fails the GPU lane with `webgl2_unavailable` on this host. GPU specialist promotion remains fail-closed.

### Structured cold-story gate

The historical real-story evidence is now represented by `config/cold-story-ledger.json` instead of prose-only summaries. Current audited coverage:

- 7 passing cases,
- 5 news cases,
- 7 topology families,
- 0 silent semantic errors,
- 1 correct advanced-visual abstention.

The final requirement remains 12 / 6 / 8 / 0 / >=1 respectively, so this gate is intentionally `BLOCKED`.

### Final qualification dossier

`final_qualification.py` combines production preflight, standard-host RC evidence, cold-story coverage, provider-backed live qualification, human review, release manifest and dependency-lock state.

On the current host it returns `BLOCKED`; it cannot be changed to PASS by editing one readiness flag.

## RC regression status

The PR profile is PASS from a clean outputs directory. The monolithic visual smoke again exceeds the interactive host's single-command budget. Its log reached and passed the AI visual compiler stage; the remaining v1.9/v1.10/trusted-browser stages were executed separately and passed, including expected D3/WebGL fail-closed probes. `outputs/v113-rc-segmented.json` therefore records `PASS_SEGMENTED` for development evidence, while final promotion still requires a standard-host monolithic RC PASS.

## Intentionally incomplete final gates

The current host cannot prove final readiness because:

- Node is 22.16.0 rather than >=22.19.0,
- Rust/Cargo are absent,
- DuckDB CLI is absent,
- Pi CLI/provider credentials are absent,
- all five production dependency locks are absent,
- WebGL2 GPU browser qualification fails,
- cold-story coverage is 7/12 and 5/6 news cases,
- no provider-backed `investigate -> continue -> verify --recompute` artifact exists for v1.13,
- no qualified-human attestation exists,
- the standard-host monolithic RC gate has not been run in this container.

These are release blockers, not skipped assertions.
