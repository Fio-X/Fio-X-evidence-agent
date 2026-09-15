# v1.12 Iteration Plan: Trusted Publication Closure

Release target: `1.12.0-rc1`

## Problem statement

The browser publication path acquired advanced rendering, interaction, StyleProfile, MapSpec and large-network capabilities faster than its release-integrity controls matured. The audit found five release-level gaps: browser modules could carry model-authored data without immutable computation binding; raw fallback SVG crossed into HTML without the illustration sanitizer; CPU and GPU browser qualification shared one runner even though `--disable-gpu` made WebGL certification impossible; release gates were fragmented across CI and manual smoke scripts; and dependency locks/source distribution were not strong enough to reproduce an RC independently.

## Release objective

v1.12 makes publication an evidence-consuming delivery layer. Every data-bearing browser module must bind immutable evidence and reverify it at render time. Browser security, accessibility and CPU/GPU qualification become explicit. Release state is computed from one profile manifest. A complete source distribution is separated from qualification evidence. Specialist engines remain fail-closed until their pinned dependency locks and executable runtimes are available.

## P0. PublicationSpec 0.3 evidence binding

Data-bearing modules declare `evidence_binding` with artifact reference, result hash, row count and field mapping. The agent may provide layout and visual settings through `view_spec`, but inline data arrays are rejected. Computation rows are re-read and re-hashed at publication plan time and again at render time. Verified claims must reference the same computation artifact.

Acceptance: a deterministic computation fixture renders from bound rows; an inline-data `view_spec` and mismatched evidence path are blocked before rendering.

## P1. Browser security closure

Raw production `fallback_svg` is removed from PublicationSpec 0.3. SVG publication uses content-addressed `asset_ref`, passes the shared active-SVG sanitizer at plan and render time, and is hash checked. HTML carries a restrictive CSP. Chromium QA prefers privilege drop and sandboxing instead of implicit `--no-sandbox`.

Acceptance: script nodes, active URI references and raw fallback SVG are blocked. Qualified CPU browser runs report `sandbox=true`.

## P2. CPU/GPU browser qualification split

Browser QA has explicit `cpu` and `gpu` profiles. CPU continues to qualify Plotly SVG and Canvas. GPU does not disable GPU and requires WebGL2 initialization. Specialist WebGL engines cannot be promoted from source-code presence alone.

Acceptance: CPU trusted publication passes. The current non-WebGL host must fail the GPU gate with `webgl2_unavailable`, proving fail-closed behaviour.

## P3. Browser QA 2.0 and accessibility

QA checks page/module overflow, Plotly text clipping, label overlap, legend intrusion, plot-area ratio, scientific geographic domains, font readiness, layout stability, interaction replay, blocked modules, external requests, accessibility metadata and initial byte budgets. Data-bearing modules provide summary, long description and an accessible data-table fallback.

Acceptance: trusted archive and production fixtures have zero accessibility errors, zero external requests and stable layouts at declared breakpoints.

## P4. Production and archival packaging

The same PublicationSpec produces two package modes. `archive` remains one self-contained HTML artifact. `production` externalizes pinned browser runtime assets into content-addressed local files while keeping all story data and evidence local.

Acceptance: archive stays reproducible; production trusted fixture reduces initial HTML from roughly 4.85 MB to roughly 14 KB without external HTTP requests.

## P5. Phase-scoped agent capability exposure

Tool exposure is scoped to `discover`, `verify`, `synthesize`, `design`, `publish` and `verify_publication`, with core tools available in every phase. Compatibility mode keeps `NEWSROOM_PHASE=all`.

Acceptance: phase policy covers every registered tool and excludes unrelated tools from a selected phase.

## P6. Release and source integrity

A single `config/release-profiles.json` defines PR, RC and final gates. The source distribution must contain the Rust control plane, Pi runtime, browser runtime, schemas, tests and scripts. `release-manifest.json` hashes the source tree and runtime manifests. Source and qualification evidence are packaged separately.

Final promotion additionally requires real Cargo/npm dependency locks. Missing locks are blockers; lockfiles are never synthesized without the package managers that resolve them.

## P7. Preserve v1.11 capability boundaries

Restore specialist runtime isolation into the complete source tree, including `viz-sigma`, `viz-map` and `viz-d3`. Restore deterministic 5,000-node community reduction and MapSpec 0.2 prepared scientific basemaps. Full large-network exploration remains specialist-only; reduced overview is a separate capability.

Acceptance: 5,000-node fixture reduces deterministically and full graph remains `SPECIALIST_RENDERER_REQUIRED`; local MapSpec accepts intermediate GSHHG detail and blocks low-detail/rainbow variants.

## P8. Release gates

PR requires contract/schema/security/semantic/synthesis/style/map/network/source-distribution tests. RC additionally requires the full visual smoke suite and browser qualification. Final requires RC plus provider-backed `investigate -> continue -> verify --recompute`, complete dependency locks, WebGL2 specialist qualification, 12 cold stories across distinct topologies and qualified-human editorial review.
