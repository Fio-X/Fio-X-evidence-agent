# Visual Compiler iteration status v1.25

## Scope completed in this checkpoint

This checkpoint continues the v1.16 -> v2.0 migration from custom render math toward an AI visual compiler that orchestrates mature GIS, statistical, graph, and browser visualization engines.

### v1.16 Runtime foundation

- Seven isolated runtime definitions now exist: `viz-python`, `viz-r`, `viz-qgis`, `viz-pygmt`, `viz-density`, `viz-web`, and upstream `viz-graph-extract`.
- `runtimes/build-matrix.json` is executable through `scripts/bootstrap_visual_runtimes.sh`.
- `.github/workflows/visual-runtimes.yml` builds every image independently, runs an in-image health smoke, records the local image identity, and captures the fully resolved dependency list.
- Production-request installation remains prohibited. A backend is enabled only after its runtime health probe succeeds.

### v1.17 VisualRecipe 2.0 and routing

- The stale recipe schema was replaced by a Draft 2020-12 VisualRecipe 2.0 contract.
- `runtime/visual/backend_policy.mjs` is now the canonical backend policy. Pi consumes a generated copy, removing the previous duplicate routing logic.
- Network semantics have precedence over incidental geography, dense graph comparison can route to adjacency matrix, and dense geospatial rendering can compile into a Datashader aggregation stage followed by a publication compositor.

### v1.18-v1.21 backend adapters

- Python publication, trajectory, editorial chart, and adjacency-matrix paths execute in the current environment.
- R editorial, ggraph, sfnetworks, QGIS, PyGMT, Datashader, MapLibre/deck.gl, Sigma/Graphology, and ECharts adapters/contracts are wired behind the same backend request boundary.
- Sigma initial coordinates are deterministic from stable node IDs; `Math.random()` is no longer used.
- ECharts now has a deterministic editorial scene compiler including direct edge-list Sankey input. The EIA energy-flow qualification case is wired to this mature flow renderer instead of adding another custom Sankey implementation.

### v1.22-v1.24 qualification and production routing

- Qualification executes only backends whose runtime is actually `AVAILABLE` and records blocked runtimes explicitly.
- Review artifacts are anonymized into `candidate-A`, `candidate-B`, etc.; the backend key remains under `private/`.
- A standalone blind-review page generator and preference resolver are included. Human records are resolved back to backend IDs only after review.
- Backend priors accept qualified human/editor/designer pairwise records only. Machine critics cannot manufacture winner priors.
- Content-addressed render cache and deterministic Python SVG/PNG hashes remain intact.

### v1.25 graph extraction

- Added an isolated `viz-graph-extract` runtime pinned to Microsoft GraphRAG 3.1.2, PyArrow 25.0.1, and Python 3.13.
- Added the validated project Skill `graph-extraction`.
- Added a strict `graph-extraction-result` EvidenceGraph schema and `graphrag_to_evidence.py` adapter.
- Entity/relationship/community/claim results are deterministically ordered and retain source text-unit identifiers. Relationship endpoints must resolve to normalized entities.
- GraphRAG remains upstream from visualization. Sigma, ggraph, sfnetworks, and matrix views consume the newsroom EvidenceGraph contract rather than GraphRAG Parquet tables directly.
- Pi now exposes `newsroom_graph_extraction_status` and can load the bundled `graph-extraction` guidance while ambient Pi skills remain disabled.

## Runtime health in the current execution environment

`viz-python` is AVAILABLE. `viz-r`, `viz-qgis`, `viz-pygmt`, `viz-density`, `viz-web`, and `viz-graph-extract` are UNAVAILABLE because this container has no R/QGIS/GMT, no Datashader/PyArrow/GraphRAG packages, no web node_modules, and no Docker/Podman or network path to build them locally.

This is treated as a deployment blocker, not a silent fallback. The new image-build workflow is the intended installation path on a networked CI/image-build host.

## Qualification pilot

Six seed cases are wired:

- Syros AIS local trajectory: Python rendered; R/QGIS blocked by runtime.
- DAL1812 flight trajectory: Python rendered; R/QGIS blocked by runtime.
- EIA U.S. energy flow: ECharts and R wired; both blocked by runtime here.
- NASA annual climate trend: Python rendered; R blocked.
- World Bank renewable-energy ranking: Python rendered; R blocked.
- Complex relationship graph: adjacency matrix rendered; ggraph blocked.

No case currently has two actually rendered professional backends, so no blind backend winner or empirical production prior has been generated. That is intentional.

## Verification

The dedicated visual-compiler smoke passes, including recipe/schema, runtime build plan, project Skill bundle, Agent backend integration, GraphRAG normalization, ECharts scene compilation, graph routing, backend executor, human-prior builder, render cache, adjacency matrix, and deterministic Python GIS.

The repository smoke was completed in three execution segments because a single run exceeds the host command window. Together the segments cover every command in `scripts/smoke.sh`. All executed tests and performance budgets pass. The sole environment-level skip is Rust control-plane acceptance because `cargo` is not present in this container; CI remains responsible for the Rust build/check path.

## Open exit gates

- Build and probe the six currently unavailable runtime images on the networked image-build workflow.
- Validate real QGIS `.qpt` templates against the installed LTR before changing their status to READY.
- Execute R, QGIS, ECharts, PyGMT, Datashader, Sigma/MapLibre outputs rather than contract-only tests.
- Expand the qualification corpus from 6 seed cases toward the planned 30-40 real stories.
- Obtain genuine blinded human pairwise evidence before generating story-family backend priors.
- Add warm-worker deployment and registry-digest pinning after CI images are built.
- Integrate general backend screenshot QA and replayable ArtDirectionPatch into the professional-backend qualification path.

v2.0 remains PENDING until those exit gates are satisfied.
