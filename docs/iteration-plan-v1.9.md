# v1.9 Iteration Plan: Browser Publication & Advanced Visual Engines

Release target: `1.9.0-rc2`

## Problem statement

v1.8 fixed the story-level failure where an infographic request could collapse into one ordinary chart, but the publication surface was still primarily deterministic SVG. That surface is strong for archival graphics and exact static replay, yet it limits progressive disclosure, linked views, dense networks, interactive flow inspection and highly customized radial or hierarchical structures. At the same time, adding library names directly to model prompts would couple editorial reasoning to vendor/tool quirks.

v1.9 therefore separates three layers. StoryGraph and InfographicSpec remain the editorial authority. PublicationSpec governs delivery and interaction. A capability router selects a rendering or analytical engine from topology, scale, interaction needs and runtime qualification.

## Release objective

A qualified browser story must remain bound to the same reader question, visual thesis, StoryGraph and InfographicSpec as the static editorial artifact. The HTML must be self-contained, responsive, replayable and independently verifiable. Advanced engines may expand expressive range, but unavailable or unqualified runtimes must fail closed rather than trigger silent substitution.

## P0. PublicationSpec 0.1

Create a provider-independent browser-delivery contract with:

- `story_graph_ref` and `infographic_plan_ref`
- reader question and visual thesis binding
- module-level StoryGraph node bindings
- self-contained HTML requirement
- responsive breakpoints
- archival fallback policy
- initial-byte budget
- declared interaction purposes and replay steps

Acceptance gate: browser publication cannot alter or detach from the approved editorial authority.

Status in RC1: implemented.

## P1. Self-contained HTML publication

Add a browser renderer that can mix semantic HTML, SVG-backed Plotly modules and Canvas network modules without CDN requests. Dependencies are embedded only when a module needs them so a Canvas-only network page does not inherit the full Plotly bundle.

Acceptance gate: zero external network requests, no horizontal overflow, and valid output at 390, 768, 1024 and 1440 px cold-load viewports.

Status in RC1: implemented and qualified with EIA Sankey, radial network and coordinated-view fixtures.

## P2. D3 advanced visual kernel

Define advanced D3 visual contracts for:

- radial network
- radial hierarchy
- circle packing
- Sankey
- chord
- edge bundling
- beeswarm
- parallel coordinates

D3 is intentionally downstream of StoryGraph/PublicationSpec. The agent requests a capability such as `radial_network`; it does not use a library name as the editorial abstraction.

Acceptance gate: all scene contracts compile; executable runtime qualification additionally requires a pinned local D3 runtime and browser regressions.

Status in RC1: compile contract PASS. Runtime qualification pending because the host lacks the pinned D3 Node package/runtime set.

## P3. Plotly browser backend

Use local Plotly for qualified interactive statistical views and Sankey. Add structured linked controls so one declared interaction can update more than one view. Keep Plotly assets local and content-addressable.

Acceptance gates:

- interactive Sankey renders at all four breakpoints
- linked-view replay changes the declared target state
- no CDN or remote runtime request
- unsupported GPU/WebGL paths fail browser QA and are removed from active host capabilities

Status in RC1: SVG/DOM interactive plots, Sankey and linked controls PASS. WebGL is explicitly unqualified on this host and has an expected-failure regression.

## P4. NetworkX analytical engine

Add deterministic NetworkX analysis before network rendering. The output records:

- input hash and result hash
- seeded layout coordinates
- weighted degree
- PageRank
- betweenness where bounded
- Louvain communities
- graph summary statistics

A dedicated radial-tree layout supports dandelion-style branching fixtures. NetworkX remains the analysis/layout stage; final publication may use Canvas, D3, Sigma or another qualified surface.

Acceptance gate: identical graph + seed produces the same analytical artifact and publication-ready coordinates.

Status in RC1: implemented with NetworkX 3.6.1 and exposed to the agent as `newsroom_network_analyze`.

## P5. Gephi Toolkit challenger

Define an optional professional network-layout adapter. Activation requires Java 17+, a pinned Toolkit build, deterministic CLI/service wrapper, explicit seed/layout policy, hash-verified export and blinded comparison against the core graph stack.

Status in RC1: contract only. It is not in active routing.

## P6. Selected RAWGraphs models

Use RAWGraphs as a source of selected visual algorithms rather than embedding the full application. Candidate models are beeswarm, circular dendrogram, circle packing, bump chart, Voronoi treemap, circular Sankey, advanced chord and parallel coordinates.

Activation requires vendored, pinned modules and local regressions because the upstream chart package may introduce breaking changes.

Status in RC1: contract only.

## P7. Flourish optional adapter

Flourish may serve as an external publishing adapter for deployments that explicitly provision approved credentials and account capabilities. It must never be required by the core agent. When enabled, the artifact records template, settings, data, version and external provenance.

Status in RC1: contract only.

## P8. Capability Registry

Route from visual intent rather than tool names. Initial intents include:

- interactive Sankey
- radial network
- large network
- linked views
- dense scatter
- scrollytelling

The registry declares topology, analytical stages, required capabilities and preferred backends. Backend eligibility remains a hard filter before scoring.

Status in RC1: implemented. Optional external adapters stay separate from the active backend registry until qualified.

## P9. InteractionSpec

Every interaction must have a reader purpose. The first qualified set includes click/focus/select controls, linked Plotly operations and deterministic replay. Scrollytelling and arbitrary point-to-point linked selection remain later qualification targets.

Status in RC1: bounded controls and linked-view replay implemented; full scrollytelling remains pending.

## P10. Browser QA

Use pinned Chromium through Playwright. Every breakpoint is cold-loaded independently so a desktop initialization cannot mask mobile layout defects. QA checks:

- page and module bounds
- Plotly internal SVG bounds
- console/page errors
- blocked modules
- external requests
- initial-byte budget
- interaction replay
- explicit WebGL initialization failure
- archival PNG fallback

Status in RC1: implemented. WebGL fail-closed regression proves that a visibly empty GPU chart cannot pass.

## P11. Advanced cold-story qualification

Run at least 12 same-day stories with distinct topologies, including conserved flow, hierarchy, large network, linked statistical views, geography, uncertainty, event sequence and mechanism-heavy synthesis. Tool choice should emerge from capabilities rather than fixed templates.

Status in RC1: pending. Existing EIA and synthetic fixtures qualify the engine contracts; they do not replace live newsroom qualification.

## External final-release gates

Promotion from RC to final still requires:

- Rust 1.98.1
- Node 22.19.0 or newer for the pinned Pi/web baseline
- Pi 0.85.1 with configured providers
- DuckDB 1.5.5 recomputation
- executable D3/Sigma web runtime qualification where those backends are claimed
- networked `investigate -> continue -> verify --recompute`
- multi-family same-day cold-story qualification
- qualified-human visual/editorial review
