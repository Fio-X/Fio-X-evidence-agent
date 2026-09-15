# v1.12 Test Report

Release candidate: `1.12.0-rc1`

## Trusted publication

`test_trusted_publication_v112.mjs`: PASS.

The deterministic fixture binds three computation rows to a result hash, compiles the Plotly figure from the bound fields, rejects inline view data, rejects raw fallback SVG, rejects scripted SVG and active URI references, and produces both archive and production packages.

Observed package sizes:

- archive HTML: 4,852,790 bytes
- production HTML: 13,907 bytes
- production runtime asset: content-addressed local Plotly.js

`test_publication_schema_v19.py`: PASS for legacy PublicationSpec 0.1 and trusted PublicationSpec 0.3.

## Browser qualification

Trusted archive CPU profile: PASS.
Trusted production CPU profile: PASS.

Both use privilege drop plus Chromium sandboxing, have zero external HTTP requests and zero accessibility errors at their declared breakpoints.

GPU profile: expected FAIL. Errors are `webgl2_unavailable` at the tested viewports. This is a release gate rather than a regression.

Cross-version secure browser QA remains PASS for v1.9 energy Sankey, network, linked views, and v1.10 Nature map, uncertainty, linked geography and large-network diagnostic fixtures.

## Map and network

`test_multiscale_map_v112.mjs`: PASS. Prepared local GSHHG asset uses intermediate detail and 64 physical line features on the current host. Forced low detail blocks. Rainbow encoding blocks.

`test_map_schema_v112.py`: PASS.

`test_network_overview_v112.py`: PASS. Current seeded fixture contains 5,000 nodes and 9,985 edges, reduces to seven communities and 16 displayed meta-edges, retains all cross-community weight in this fixture, and keeps full graph status `SPECIALIST_RENDERER_REQUIRED`.

## Runtime and tool scope

`check_runtime_contract.py`: PASS. Rust allowlist/audit/runtime materialization remains aligned with Pi tooling.

`test_phase_tool_scope_v112.mjs`: PASS for 47 tools across seven phases.

`test_source_distribution_v112.py`: PASS with more than 600 source files outside outputs.

## Cross-version regression

PASS in segmented execution:

- v1.7 semantic contract, editorial semantics, 20 adversarial semantic cases, seven grammar cases and six backend matrices
- v1.7 Saudi/Hormuz cold-story semantic regression
- v1.8 StoryGraph and visual synthesis, closure 100%, critic 98
- backend executor, backend router, render cache, GIS router and AI visual compiler
- v1.9 ModelSpec, model gate, capability registry, advanced-engine compile contracts, D3/WebGL fail-closed tests and advanced router
- v1.10 functional style mapping, Nature scientific map and advanced systems
- v1.12 label layout, source distribution, MapSpec 0.2 and runtime contract

Two legacy fixtures were updated for capability/runtime additions, without weakening production rules.

## Release profile status

PR profile: PASS.

Final profile: expected FAIL before commands because these required files are absent:

- Cargo.lock
- runtime/web/package-lock.json
- runtime/sigma/package-lock.json
- runtime/map/package-lock.json
- runtime/d3/package-lock.json

Final also retains manual gates for provider-backed SQL recomputation, GPU qualification, 12 cold stories and qualified-human review.

The monolithic RC visual smoke exceeded the interactive host's single-command execution budget. The same critical suites were executed in segments and passed, but the official RC profile remains an external-runner gate.
