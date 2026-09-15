# Visualization Engine Design Spec 0.1

## Goal

Replace the regression-oriented `newsroom_chart` renderer with a newsroom-grade visualization editing subsystem that can plan, generate, lint, critique, revise and publish evidence-grounded graphics.

## Pipeline

```text
story claim
    ↓
viz_plan
    ↓
newsroom viz spec
    ↓
constraint ranking
    ↓
renderer
    ↓
deterministic lint
    ↓
visual critic
    ↓
patch / revise
    ↓
publishable SVG/PNG/HTML + provenance
```

## First-class objects

### Story intent

```json
{
  "task": "ranking | comparison | change | distribution | correlation | part_to_whole | spatial | flow",
  "claim_id": "claim-...",
  "reader_question": "Which countries changed fastest?",
  "takeaway": "...",
  "audience": "general_news",
  "medium": "web | mobile | print | social"
}
```

### Visualization spec

```json
{
  "mark": "dot",
  "encoding": {},
  "layers": [],
  "facets": [],
  "annotations": [],
  "highlights": [],
  "reference_lines": [],
  "uncertainty": {},
  "text": {
    "title": "...",
    "dek": "...",
    "source": "...",
    "note": "...",
    "alt": "..."
  },
  "responsive": {
    "desktop": {},
    "mobile": {}
  },
  "provenance": {
    "claim_id": "...",
    "computation_id": "...",
    "dataset_id": "..."
  }
}
```

## Required v0.4 chart families

1. ordered horizontal bar
2. dot plot
3. range/dumbbell/thermometer
4. slope
5. line
6. highlighted multi-line
7. small multiples
8. scatter + trend
9. histogram
10. strip/beeswarm
11. stacked and 100% stacked bar
12. interval / uncertainty band
13. heatmap
14. waterfall / diverging bar

## Hard lint rules

- Bar quantitative baseline must include zero.
- No rotated category labels.
- Units required when quantitative meaning is not self-evident.
- Source required.
- Alt description required.
- Title claim must reference a verified `claim_id`.
- Chart values must hash-match deterministic query output.
- Mixed reference periods require explicit separation or warning.
- Dual-axis zero lines must align when both cross zero.
- No private or missing provenance URLs in publishable output.
- Minimum text size and contrast thresholds.

## Soft design constraints

- Prefer common-position judgments for accurate quantitative comparison.
- Prefer direct labels when series count is small.
- Prefer horizontal forms for long category labels.
- Prefer small multiples when many series compete in one plot.
- Use highlight color for editorial focus and mute context series.
- Keep persistent categorical colors stable across related views.
- Avoid more than six simultaneously discriminated hues.
- Use annotation near data for local facts and title/dek for global takeaways.

## Critic dimensions

- semantic faithfulness
- perceptual effectiveness
- hierarchy
- annotation quality
- clutter
- accessibility
- mobile legibility
- misleading implication risk
- newsroom polish

## Revision protocol

`viz_critic` returns JSON patches with priority and reason. Maximum three refinement loops by default. Deterministic lint errors block publish regardless of visual critic score.

## Reference library

Store abstract patterns and synthetic examples. Do not copy copyrighted newsroom artwork or proprietary fonts. Each reference contains `task`, `data_shape`, `pattern`, `strengths`, `failure_modes`, `annotation_strategy`, `mobile_strategy` and `source_inspiration` metadata.

## Evaluation

Every benchmark case should have:

- dataset
- target reader task
- verified claim
- expected constraints
- at least one acceptable chart family
- prohibited failure modes
- rendered image
- deterministic lint result
- visual critic result
- human reviewer score when available

Competition demo target: one case where the first draft fails a deterministic or semantic check, the Agent revises the plan, and the final artifact passes all gates.


## v0.8 topology extension

The renderer is no longer limited to row-oriented statistical charts. `NewsroomVizSpec 0.8` introduces `visual_family`, `data_topology` and `complexity_budget`. Supported topology-aware forms are Sankey, alluvial, node-link, adjacency matrix, hierarchy tree, timeline and streamgraph, while existing statistical families remain compatible.

Planning must map reader task to topology before choosing a form. Flow edges receive conservation/cycle/negative-flow checks; graph edges receive node/edge/density checks; hierarchy data receive root/parent/cycle checks; events receive sequence checks; log scales require strictly positive values. These rules remain deterministic so an LLM cannot waive a factual or structural blocker through prose.

The first alluvial implementation deliberately shares the acyclic Sankey layout core. Dedicated multi-axis categorical alluvial/parallel-sets optimization, geographic flow maps, chord/ribbon layouts and illustration/cutaway composition are separate future adapters.

## v0.9 spatial and explanatory extension

v0.9 adds three first-class data topologies and four renderers:

- `categorical_flow` -> `parallel_sets` using two to five dimensions plus a non-negative weight;
- `graph_edges` -> `chord` for compact many-to-many relationship summaries;
- `geo_edges` -> `geo_flow_map` using verified source/target coordinates and non-negative route weights;
- `process_graph` -> `process_schematic` for acyclic explanatory sequences with optional edge labels.

The geographic renderer is deliberately schematic. It uses an equirectangular coordinate frame and always discloses that relationship curves are approximate. Publisher-quality basemaps require a future adapter with published geometry and projection metadata.

Topology-aware lint is mandatory before rendering. Missing/blank numeric coordinates are blockers, latitude/longitude ranges are validated, categorical-flow axes have cardinality budgets, Chord relationships have density caps, and process graphs must be acyclic.

## v1.5 cartographic flow extension

NewsroomVizSpec 1.0 introduces `cartographic_flow_map` as a provenance-aware geographic movement form. It does not replace the v0.9 schematic `geo_flow_map`.

The new form requires `geometry_semantics` and `geometry_crs`. v1.5 accepts WGS84 / `EPSG:4326` input and distinguishes `abstract_od`, `great_circle_reference`, `verified_route`, `observed_trajectory` and `network_constrained`. Abstract OD and great-circle views use verified endpoint coordinates. Physical, observed and network-constrained views require supplied route geometry plus a route-provenance note. Observed trajectories additionally require a time field.

A hash-bound Natural Earth Admin 0 basemap is projected with Natural Earth 1 by default. Reader-facing disclosures state whether paths are abstract relationships, geodesic references or sourced route geometries. An 81-route unaggregated fixture fails closed; `top_n` is the only v1.5 density-reduction policy. This keeps the first release deterministic and inspectable while leaving clustering, bundling, browser zoom and large trajectory ingestion for later adapters.
