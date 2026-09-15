# v1.12 Completion Audit

Status: `1.12.0-rc1`

## Completed

### Complete source distribution restored

The v1.12 working tree is reconstructed from the complete v1.10 source baseline and contains the Rust CLI, Pi extension, browser/GIS/network runtimes, schemas, tests and release scripts. `scripts/test_source_distribution_v112.py` passes with more than 600 non-output source files. This closes the v1.11 audit failure where the available directory contained qualification documents and outputs without the buildable source tree.

### PublicationSpec 0.3 and immutable evidence binding

Browser statistical modules now consume immutable computation artifacts through `evidence_binding`. The plan path verifies stored computation row hashes, requires matching module result hashes and requires verified claims to reference the same computation. Render re-reads the artifact and verifies it again before deterministic field mapping builds the Plotly figure. Model-authored inline data in `view_spec` is rejected.

### Shared SVG security and CSP

Publication and rich-illustration paths share `runtime/visual/svg_security.mjs`. PublicationSpec 0.3 forbids raw `fallback_svg`; static SVG must use an evidence-bound asset reference. Active scripts, `foreignObject`, event handlers and active/external URI references are rejected. Browser HTML emits a restrictive Content Security Policy.

### Secure CPU browser QA and explicit GPU gate

Browser QA 0.2 drops root privileges to `nobody` when possible and runs Chromium with sandboxing. The trusted archive and production fixtures both pass CPU QA with `sandbox=true`, no external requests and no accessibility errors. GPU QA intentionally fails on this host with `webgl2_unavailable`, so GPU specialist availability cannot be inferred from CPU rendering.

### Browser QA 2.0

The browser gate now checks clipping, scatter-label overlap, legend intrusion, plot-area ratio, scientific geographic domains, fonts, layout stability, accessibility metadata, interaction replay, blocked modules, external requests and byte budgets. Data-bearing modules expose an accessible table plus summary and long description.

### Archive and production packaging

The trusted fixture produces a self-contained archive HTML of about 4.85 MB and a production HTML of about 14 KB. Production uses a content-addressed local Plotly asset and performs no external HTTP requests during qualification.

### Phase-scoped tools

The 47 agent tools are mapped to seven phases: core, discover, verify, synthesize, design, publish and verify_publication. `NEWSROOM_PHASE=all` preserves compatibility; scoped production sessions reduce simultaneous tool exposure.

### Unified release profiles

`config/release-profiles.json` and `scripts/release_check.py` define PR, RC and final gates. GitHub CI invokes the PR profile; a separate release workflow exposes PR/RC/final profiles. The current PR profile is PASS.

### Specialist runtime and v1.11 source recovery

The complete source tree now contains independent `viz-sigma`, `viz-map` and `viz-d3` manifests/build definitions. Runtime policy no longer lets the legacy monolithic `viz-web` health state control those engines. The 5,000-node reduction tool and MapSpec 0.2/GSHHG preparation path are present in the agent runtime and Rust materializer.

### Large-network overview and multiscale map regressions

The current deterministic 5,000-node fixture reduces 9,985 edges into seven communities and 16 inter-community relations while retaining 100% of cross-community weight for this fixture. Full graph status remains specialist-required. The MapSpec 0.2 fixture prepares 64 intermediate-detail GSHHG features; a low-detail local map and rainbow encoding both block.

## Regressions fixed during qualification

Two legacy fixtures had encoded pre-split assumptions. `test_backend_router_v123` treated Sigma/MapLibre as part of `viz-web`; it now declares split specialist health states. `test_advanced_visual_engines_v19` omitted Plotly scientific-map and linked-geo capabilities added later; the fixture now covers them. Production routing rules were not relaxed to make either test pass.

## Intentionally incomplete and fail-closed

### Dependency locks

Cargo is unavailable on this host and npm package acquisition is unavailable for the specialist package trees. `Cargo.lock` and the required Node package-lock files are therefore absent. Dockerfiles now require `npm ci`; final release requires real resolved lockfiles and fails before live qualification while they are missing.

### GPU specialist runtimes

The host cannot initialize WebGL2. Sigma/Graphology, MapLibre/deck.gl and other GPU specialist publication remain unqualified. CPU browser publication remains qualified independently.

### Live newsroom qualification

The current host still cannot prove the full provider-backed `investigate -> continue -> verify --recompute` path with pinned Cargo/DuckDB/provider credentials. Twelve independent cold stories and qualified-human review also remain final gates.

### Full monolithic RC smoke in this host

`smoke_visual_compiler.sh` is included in the RC profile and CI workflow. In this interactive host a single invocation exceeds the tool execution budget. Critical cross-version suites and browser qualifications were therefore executed in segments; those segments pass. The monolithic RC profile must still run to completion on the external RC runner before final promotion.
