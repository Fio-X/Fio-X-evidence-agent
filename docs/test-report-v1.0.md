# v1.0 Test Report

## Release result

**PASS for deterministic/repository release testing.** The final local smoke suite completed in **22.31 seconds**. The current sandbox still cannot execute the real Rust/Pi/DuckDB/provider chain; that limitation is recorded separately in `docs/live-readiness-v1.0.json`.

Protocol baseline:

- release: `1.0.0`
- News Artifact: `0.7.0`
- NewsroomVizSpec: `0.9.0`
- InfographicSpec: `1.0.0`

## Magazine composer

The synthetic magazine regression passed schema validation, page lint, desktop/mobile composition, page critic, upstream-critic enforcement, deterministic snapshots, XML parsing, and CairoSVG rasterization.

- balanced page critic: **100/100 PASS**
- deliberately cluttered page: **88/100 REVISE**
- upstream failed visual critic: **blocked**
- desktop reference page: responsive 1440-wide composition
- mobile reference page: responsive 720-wide recomposition
- XML/raster smoke: **4/4 PASS**

The real-data EIA 2024 feature also passed:

- desktop page: **1440 x 3531**
- mobile page: **720 x 4024**
- page critic: **100/100**
- source mix, Sankey, geo-flow map, hero statistics, pull quote, section hierarchy, and consolidated sources/methods all render as one feature page.

## Competition and integrity gates

The synthetic complete artifact passes **18/18** engineering gates. These include the original agent/context/tool/provenance requirements plus magazine infographic output, pipeline, critic, and measured agent wall time.

The integrity adversarial suite rejects **12/12** mutations:

- dataset hash mismatch;
- source content hash mismatch;
- source trust-boundary tamper;
- computation result hash mismatch;
- input fingerprint tamper;
- non-content-addressed source;
- non-content-addressed computation;
- missing mobile visualization;
- unsafe/path-traversal claim reference;
- invalid run metric;
- infographic page SVG hash mismatch;
- infographic references missing upstream visualization.

SQL replay protocol smoke accepts a matching recomputation and rejects a deliberately mismatching result.

## Control plane

The Pi-compatible RPC mock passes failure -> recovery -> resume behavior. Rust binary control-plane acceptance is **SKIPPED in this sandbox** because Cargo is unavailable. CI remains responsible for the real Rust binary acceptance.

## Performance

Final v1.0 local measurements:

| Pipeline | p50 | p95 | Budget |
| --- | ---: | ---: | ---: |
| 10 statistical responsive visual families | 0.206 ms | **0.514 ms** | 10 ms |
| 8 v0.8 complex visual cases | 0.301 ms | **0.767 ms** | 18 ms |
| 4 v0.9 spatial/explanatory forms | 0.126 ms | **0.304 ms** | 22 ms |
| v1.0 magazine composer, desktop + mobile + critic | 0.311 ms | **0.560 ms** | 12 ms |
| small artifact verifier, 113 checks/run | 2.624 ms | **2.954 ms** | 15 ms |
| 41-computation verifier, 473 checks/run | 5.931 ms | **7.169 ms** | 40 ms |

The deterministic page composer is not a performance bottleneck. Live system latency will continue to be dominated by model inference, network acquisition, and real DuckDB work.

## Regression coverage

The final smoke suite includes:

- release baseline/version checks;
- News Artifact, NewsroomVizSpec, and InfographicSpec schema tests;
- legacy statistical visual tests and snapshots;
- complex flow/network/hierarchy/temporal tests;
- spatial/explanatory tests;
- OWID/Ember, World Bank, EIA, and Titanic real-data visual regressions;
- synthetic and real-data magazine feature composition;
- standard XML parse and rasterization;
- competition evaluator self-test;
- integrity adversarial suite;
- SQL recomputation protocol smoke;
- qualification summary contract;
- verifier benchmarks;
- Pi RPC mock failure/recovery;
- visual and page performance benchmarks.

## Known test limitation

`docs/live-readiness-v1.0.json` reports `live_ready=false`: the sandbox has Node 22.16.0, while the pinned Pi baseline requires Node 22.19.0+, and Pi, DuckDB, Rust/Cargo, and model credentials are absent. The deterministic release evidence therefore cannot be presented as proof of a real `Rust -> Pi -> LLM -> DuckDB` run.
