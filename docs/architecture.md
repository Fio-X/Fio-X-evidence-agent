# Architecture

`news` separates control, reasoning, evidence acquisition, deterministic computation, verification and presentation. The boundary stays narrow so model providers, renderers and data engines can evolve without changing the investigation artifact contract.

```text
user
  |
  v
news (Rust CLI)
  |
  | strict LF-delimited JSONL + persistent session directory
  v
Pi agent runtime
  |
  | model chooses tools dynamically
  |
  +--> artifact_inventory -> investigation-local evidence only
  +--> newsroom_update_plan
  +--> news_search ------> GDELT DOC 2.0 API
  +--> fetch_url --------> bounded public HTTP/HTTPS evidence stream
  +--> download_data ----> bounded content-addressed dataset snapshot
  +--> duckdb_query -----> DuckDB read-only SQL + verifiable input fingerprints
  +--> newsroom_viz_plan -> NewsroomVizSpec 0.8
  |        -> newsroom_viz_lint -> DuckDB SQL + canonical data hash
  |        -> newsroom_viz_render -> desktop SVG + mobile SVG + manifest
  |        -> newsroom_viz_critic -> dual-viewport score + repair suggestions
  +--> newsroom_chart -> legacy fallback
  +--> record_claim -----> provenance-aware claims.jsonl

news verify
  -> independent hash/reference/provenance/visualization-chain verification
```

## Agent loop

The CLI does not encode a fixed search/fetch/SQL/chart workflow. Pi controls the operational loop:

```text
understand goal
  -> create/refresh observable task plan
  -> choose a capability
  -> observe tool result
  -> decide whether evidence is adequate
       | contradiction / insufficiency / failure
       v
     revise plan and choose another capability
       |
       +-------------------------> repeat
  -> record evidence-backed claims
  -> build and critique responsive visualization when useful
  -> deliver dossier
```

The stored plan contains observable tasks and statuses, not private reasoning. Raw tool lifecycle events remain in the Pi RPC log.

## Multi-turn context

Each investigation owns a Pi `session/` directory. `news continue` resumes that exact session, allowing goal changes to reuse prior conversation and tool state. `session-stats.json`, `events.jsonl` and `tools.json` expose the observable multi-turn/tool loop for audit.

## Content-addressed evidence

The v0.6 foundation, retained through v0.9, turns the evidence layer into immutable identities:

```text
source snapshot
  -> sources/<source-content-hash>.json

dataset bytes
  -> data/<sha256>.<ext>
  -> deterministic .meta.json
  -> acquisition details under data/origins/<hash>.json

SQL result
  -> input_fingerprints[]
  -> input_snapshot_hash
  -> result_hash
  -> computations/SHA256(SQL + input_snapshot_hash + result_hash).json
```

`input_fingerprints` bind each computation to the exact source/data hashes available at computation time. Later evidence can be added to the investigation without invalidating historical computations because their original fingerprint set remains explicit.

Content-addressed files use create-only writes. When the target already exists, the writer compares bytes and raises an immutable-artifact collision if they differ. Timestamps remain only on mutable timeline artifacts such as conversation/plan/claim logs, not inside content-addressed evidence objects.

## Independent verification

`news verify <artifact>` and `scripts/verify_artifact.py` check the stored chain independently of the model:

```text
claim
  -> referenced source/data exists and hashes match
  -> referenced computation exists
       -> rows hash matches result_hash
       -> input fingerprints resolve and hash correctly
       -> computation filename matches SQL/input/result identity
  -> visualization claim is verified
       -> plan + lint + computation linkage
       -> data hash linkage
       -> desktop/mobile SVG assets
       -> passing critic
```

The competition evaluator invokes this integrity layer first. Checklist evidence is therefore insufficient unless its underlying artifact chain is valid.

Fast `news verify` establishes artifact integrity and provenance consistency without requiring DuckDB. The v0.7 replay layer retained in v0.9 adds `news verify --recompute`, which launches the configured DuckDB CLI, re-executes every stored read-only SQL statement against the bound immutable evidence, and compares canonical rows plus `result_hash`. Cryptographic signing of the whole investigation root remains outside the current release, so the current integrity layer protects against accidental mutation and the tested tampering classes rather than a fully malicious actor who can rewrite and re-sign an entire self-consistent artifact tree.

## Complex visual journalism boundary

v0.9 extends visual reasoning by data topology before renderer choice:

```text
verified rows
  -> reader task
  -> data topology
       tabular | flow_edges | graph_edges | hierarchy | events
  -> visual family
       statistical | flow | relationship | hierarchy | temporal
  -> deterministic topology lint
  -> responsive renderer
  -> dual-viewport critic
```

The renderer surface is split conceptually into four engines while sharing one SVG runtime: the statistical chart engine, flow engine, relationship engine and hierarchy/temporal engine. Sankey/alluvial enforce DAG semantics and optional conservation; relationship graphs can route from node-link toward adjacency matrices when density rises; trees validate parent-child structure; timelines sort events deterministically; streamgraphs reject negative values. `complexity_budget` constrains how much exploratory density the agent may introduce.

Geographic flow maps are part of the NewsroomVizSpec 0.9 contract. v1.1 adds a separate semantic explanatory-graphic adapter for claim-bound cutaway, exploded, anatomy and system views. These explanatory assets are deliberately schematic and cannot claim engineering geometry or physical scale.

## Responsive presentation boundary

One approved `NewsroomVizSpec 0.8` and one canonical row hash generate two deterministic views:

```text
verified rows + spec
  -> desktop SVG (1040-unit viewBox)
  -> mobile SVG (640-unit viewBox)
  -> dual-viewport critic
```

Small multiples reflow for mobile, time-like facets sort deterministically, CJK text wraps by character-aware boundaries, annotation labels use collision-aware lanes and multi-line direct labels are separated when endpoints cluster. Both viewport variants share the same data hash.

## Network and prompt-injection boundary

HTTP tools validate public HTTP/HTTPS destinations and repeat DNS/private-address checks across redirects. Response bodies are consumed incrementally. Source text truncates at its configured budget; dataset downloads hard-fail above 25 MB and cancel the body reader before unbounded buffering.

Fetched content is stored and returned as `untrusted_external_content`. The investigation prompt explicitly prevents instructions inside source material from changing the user goal, tool permissions, operating rules or evidence standard.

## DuckDB boundary

The model does not perform authoritative arithmetic in context. It decides what to calculate; DuckDB performs the calculation. The SQL tool accepts one read-only analytical statement, blocks mutating/extension-loading statements, disables external access/community extensions, constrains allowed directories to the investigation evidence tree, applies resource limits and runs with the artifact directory as its working directory.

## Control-plane acceptance

CI includes a deterministic Pi-compatible RPC mock. With Cargo available, the real Rust binary executes `investigate -> continue -> verify -> inspect` against that process. The mock includes one tool failure followed by successful recovery and a second-turn plan revision. This validates Rust JSONL/session/audit handling without model credentials.

Real Pi + provider + DuckDB remains a distinct live acceptance gate because model/tool behavior cannot be proven by the mock.

## Reproducibility baseline

`versions.json` records the v1.3 release and live-qualification targets: Rust 1.98.1, Node 22.19.0, Pi coding agent 0.85.1, DuckDB 1.5.5, CairoSVG 2.8.2 and Python 3.13 for CI. `rust-toolchain.toml` pins the compiler. `Cargo.lock` remains the outstanding reproducible-build blocker until generated on a Rust-enabled machine. `run-metrics.jsonl` separates live agent wall-clock measurements from renderer/verifier microbenchmarks, while `qualification.json` records provider/model behavior for a completed two-turn acceptance run.

## Future adapters

Data Formulator, CoDA, MultiVis-style validators and Datawrapper remain adapters behind the existing data/provenance/visualization contracts. Their internal APIs should not leak into the Rust CLI.


## v0.9 spatial and explanatory topology layer

The visualization runtime now treats topology as part of the agent contract rather than a renderer-side guess. `categorical_flow` drives Parallel Sets, `geo_edges` drives schematic geographic flow, and `process_graph` drives acyclic process diagrams. Chord reuses verified `graph_edges` while applying a circular relationship encoding.

The spatial renderer deliberately does not fetch map tiles or invent geographic boundaries. It consumes verified latitude/longitude fields, validates ranges, renders a disclosed equirectangular schematic and keeps relationship curves semantically separate from physical routes. A future GIS adapter can replace that projection while keeping the same evidence and claim contract.

All new forms remain behind `newsroom_viz_lint`, use the same verified-claim binding, emit desktop/mobile SVG from the same canonical rows, and enter the same critic/revision loop.


## v1.1 magazine-grade composition layer

The v1.1 presentation layer sits above the evidence and visualization protocols:

```text
verified claims
  -> approved charts/maps/networks
  -> approved semantic explanatory graphics
  -> editorial intent / audience / story arc
  -> InfographicSpec 1.2
  -> deterministic page lint
  -> layout candidates: balanced | anchor | rhythm
  -> priority-aware candidate ranking
  -> desktop/mobile magazine SVG
  -> awards-informed page critic
  -> raster review / revise / publish
```

`InfographicSpec 1.2` retains page-level `intent`, `primary_message`, `story_arc`, `audience` and `quality_target`. Each module can declare a `story_role`, `priority` and `emphasis`. Candidate scores and the selected strategy are stored in the artifact so layout reasoning remains observable. The mobile page preserves semantic reading order while recomposing geometry instead of merely scaling the desktop layout.

The page critic exposes ten dimensions: impact/story focus, engagement, clarity/information flow, effectiveness, hierarchy, editorial rhythm, inclusion/accessibility, responsive execution, craft/geometry and originality/visual variety. Provenance and geometry blockers remain hard gates; originality cannot compensate for incorrect evidence or unreadable layout.

## v1.1 semantic explanatory-graphic layer

`runtime/pi/explanatory.mjs` implements a separate deterministic adapter for semantic illustration. Pi receives four bounded tools: `newsroom_explainer_plan`, `newsroom_explainer_lint`, `newsroom_explainer_render` and `newsroom_explainer_critic`. Supported views are `cutaway`, `exploded`, `anatomy` and `system`.

Each explanatory spec names semantic parts and optional relationships, can bind parts to verified claim IDs, and requires `not_to_scale=true`. Every desktop/mobile SVG visibly contains `SCHEMATIC / NOT TO SCALE`. The magazine composer treats the resulting manifest as an `illustration` module and verifies its upstream critic and hashes before embedding. This is intentionally a conceptual explanation layer. Bespoke hand illustration, photorealistic reconstruction, exact engineering sections, photography-aware collage and 3D remain outside the deterministic runtime.

## v1.2 visual-editor and rich-illustration layer

The v1.1 rubric remains the deterministic first gate. v1.2 adds `newsroom_infographic_preview`, which rasterizes the exact current desktop/mobile SVGs into content-addressed PNGs and binds them back to source hashes, followed by `newsroom_infographic_vision_critic`, which lets the active multimodal provider inspect those pixels. Visual feedback is bounded to layout properties such as span, emphasis, priority and relative ordering; it cannot change SQL, claims, values or provenance. New pages can set `visual_review_required=true`, causing the independent verifier to require current previews plus a passing ten-dimension visual critic.

`runtime/pi/illustration.mjs` adds a separate 0.2 rich-illustration protocol with origin policy, digital source type, evidence references, disclosure, model/system metadata, prompt hash and content hashes. Adapters are shell-free executable boundaries using stdin/stdout JSON, so vendor APIs do not enter the core runtime. Active SVG content is rejected. The recorded metadata is C2PA/IPTC-aware, but the release does not claim signed C2PA Content Credentials.

The image-aware critic is a second editorial opinion. Deterministic provenance, geometry and evidence checks remain authoritative because multimodal aesthetic judgment is not sufficiently aligned with expert review to replace them.


## v1.3 competition-aware revision layer

The visual-editor loop now has an executable but narrow mutation boundary. The image-aware critic may request `span`, `emphasis`, `priority`, desktop-relative ordering or mobile-relative ordering changes. `newsroom_infographic_revise` applies only those fields and writes a content-addressed revision audit. A canonical immutable projection removes layout-only fields, sorts modules by identifier and hashes every remaining editorial/evidence field. The independent verifier reconstructs the revision from the source plan and rejects any mismatch or protected-field mutation.

InfographicSpec 1.2 adds `competition_profile` and `mobile_module_order`. The desktop composer still ranks the same three deterministic candidates. Mobile reading order may diverge when a narrow viewport needs a different narrative cadence, while the desktop sequence and evidence remain intact. This avoids making mobile a scaled desktop derivative without creating a second page model.

`runtime/pi/competition.mjs` defines versioned profiles for baseline editorial review, SND47 information graphics, OJA 2026 visual digital storytelling, Sigma 2026 and Information is Beautiful. Profiles express internal rubric floors, explicit manual requirements and published eligibility constraints. `newsroom_competition_preflight` binds its output to the final page plan, manifest and critics. The independent verifier recomputes the machine decision, so the preflight report is evidence rather than authority.

A browser publication engine remains a future adapter. If interactive scrollytelling becomes a release goal, it should translate the same verified plan into HTML/SVG and add real-browser responsive, accessibility and screenshot-diff checks. It should not own a second evidence graph or an independent editorial layout truth.

## v1.4 editorial-intelligence and scene-art-direction layer

v1.4 inserts an explicit editorial search layer ahead of polished composition while preserving the existing evidence graph and Infographic Composer as the only page authority:

```text
verified evidence / reporting package
  -> EditorialDiscovery
  -> VisualConcept tournament
  -> reporting-gap / asset plan
  -> semantic novelty gate
  -> InfographicSpec 1.3 + bounded SceneGraph
  -> deterministic composition
  -> raster / image-aware review
  -> slow-award status + human preference checkpoint
  -> independent verification / competition preflight
```

`EditorialDiscovery` can stop the pipeline with `RESEARCH_MORE`, `REVISE` or `KILL`. Award-mode concept sets contain 8-20 candidates across at least three framings, and a deterministic tournament retains at most three finalists. The novelty layer compares reader-question identity, claim overlap, explanatory dimension and declared new information; high-overlap modules must be removed or carry an explicit overview/detail justification.

SceneGraph 0.1 remains deliberately bounded. `hero_sidecar_stack` and `hero_with_rail` let one sourced visual asset act as the spatial scaffold while supporting evidence shares scene-level hierarchy and source scope. Scene membership is validated against module IDs, one module cannot silently belong to multiple scenes, and stable editorial ordinals are derived from canonical story order rather than geometry traversal. Desktop and mobile can therefore recompose without renumbering the story.

External scene assets enter through the existing provenance-aware rich-illustration boundary. The v1.4 NASA regression uses an offline Natural Earth low-resolution Admin 0 country-polygon fixture under the `software_only` policy. A `SOURCE.json` records the exact local bytes, bundle hash, official upstream lineage, public-domain terms and the fact that the locally installed fixture does not expose a trustworthy Natural Earth release number. The map is explicitly contextual: it does not encode NASA station positions, observation density or temperature-anomaly geography.

The slow-award path records its search budget with `newsroom_award_mode_status`. Machine stages can reach `READY_FOR_HUMAN`; only a separately stored qualified-human pairwise preference artifact can move that evidence to `PASS`. The independent verifier recomputes concept selection, novelty decisions, asset-plan decisions, human-preference status and award-mode status rather than trusting the Agent's stored booleans.

Real provider behavior remains a separate acceptance boundary. The local v1.4 environment cannot run Rust/Pi/DuckDB or provider-backed multimodal qualification, so this release does not claim autonomous award-mode readiness. Likewise, the human preference gate is infrastructure-complete but remains `PENDING` until qualified blinded reviewers are actually supplied.

## v1.5 cartographic-flow layer

`runtime/pi/cartography.mjs` adds a deterministic cartographic substrate underneath `runtime/pi/viz.mjs`. Rust embeds and materializes both the module and the hash-bound Natural Earth Admin 0 asset. NewsroomVizSpec 1.0 can request `cartographic_flow_map`; the older `geo_flow_map` remains explicitly schematic compatibility behavior.

The critical contract is route meaning. `abstract_od` represents a statistical bilateral relationship; `great_circle_reference` is a geodesic reference; `verified_route`, `observed_trajectory` and `network_constrained` consume supplied route geometry with provenance. `observed_trajectory` also requires temporal metadata. This prevents the same decorative arc primitive from silently changing factual meaning across trade, migration, aviation, shipping and infrastructure stories.

Static world maps use Natural Earth 1 or equirectangular projection. The bundled Natural Earth bytes, source URL and public-domain metadata are part of the spec and are revalidated before rendering. Abstract OD uses a bounded curve candidate optimizer; great-circle references are interpolated geodesically; physical/observed/network paths are projected from their supplied coordinates. Density is fail-closed above the release cap unless a declared `top_n` policy is used.

Cartographic output continues into the existing SceneGraph. The EIA regression places the import map in a `hero_sidecar_stack` and follows it with a domestic Sankey, demonstrating that map, system flow and explanatory sidecars share the same evidence/page authority.


## v1.6 observed-trajectory and scale-aware cartography boundary

NewsroomVizSpec 1.1 extends the v1.5 route-semantics contract with a canonical time-indexed trajectory-points lane. `observed_trajectory` may carry segmented points directly, so missing observation intervals remain discontinuities instead of being silently interpolated. Data-fitted projection, a locator inset and an optional geodesic reference remain presentation operations; they do not manufacture a filed route or replace route provenance.

`trajectory_profile` is the first coordinated movement-specific statistical view. It renders altitude and ground speed on separate panels sharing one elapsed-time axis and the same segment gap. The underlying evidence therefore has a stable key across spatial and temporal views even before a browser-linked interaction layer exists.

The real AIS Syros stress test establishes a scale boundary. The embedded 1:110m Natural Earth asset is suitable for world and broad regional context but not harbour interpretation. When a data-fitted extent is below one degree, the v1.6 critic records a `basemap_detail_mismatch` warning and recommends a provenance-bound higher-resolution substrate. A future basemap registry should select 110m/50m/10m or local authoritative layers by editorial scale while keeping source URL, license, version/hash and projection in the artifact.

Large raw AIS/ADS-B ingestion, trajectory cleaning/simplification, density aggregation, network-constrained real pipeline geometry and browser-linked playback remain downstream adapters over the same evidence graph. They must not become independent sources of factual route truth.
