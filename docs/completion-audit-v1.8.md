# v1.8 RC Completion Audit

Release candidate: `1.8.0-rc1`

## Completed

### Story-level synthesis

Implemented `StoryGraph 0.1` in `runtime/pi/story_graph.mjs` with schema `schemas/story-graph.schema.json`. The graph separates narrative composability from numerical comparability and validates reader question, visual thesis, typed nodes, typed relations, entry nodes, answer nodes, reachability, relation diversity and explanatory dimensions.

### InfographicSpec 1.4

Upgraded the infographic contract to require `reader_question`, `visual_thesis`, `story_graph_ref`, concept-selection references and a SceneGraph. Claim-bearing modules map to StoryGraph nodes, and statistical visuals declare module-level `visual_grammar`.

### Synthesis qualification

Added deterministic synthesis evaluation in `runtime/pi/infographic.mjs` with release-blocking checks for:

- StoryGraph availability and pass status
- reader-question and visual-thesis agreement
- invalid module-to-node references
- module grammar versus rendered chart type
- entry-node coverage
- answer-node coverage
- explicit answer resolution
- minimum story-node coverage
- Default Chart Equivalence
- explanatory-dimension breadth
- narrative-relation presence
- minimum claim-bearing module count
- minimum visual/explanatory module count

### Runtime orchestration

Added `newsroom_story_graph`. Infographic-bound visual planning now requires a StoryGraph reference and mapped node IDs. `newsroom_infographic_plan` emits InfographicSpec 1.4 and validates the graph before composition. The Rust runtime materializer now includes `story_graph.mjs`.

### Semantic support

Added `reference` observation status and contextual handling for climatological/historical benchmarks. The July low-pressure-system example, 24 days versus a climatological 13.56 days, is now accepted as a contextual benchmark and deterministically derives a +10.44-day difference.

Added `anomaly` editorial grammar with diverging-bar, dot and small-multiples forms.

### Rendering repair

Horizontal/diverging-bar edge labels now move inside the mark when an outside label would collide with category text. The India monsoon fixture asserts this behavior in desktop and mobile SVG output.

### Cold-story synthesis regression

The India monsoon/food-risk fixture now composes:

- rainfall anomaly visual
- low-pressure-system benchmark visual
- `24 of 36` regional-deficit hero statistic
- `-1.6%` acreage context
- moisture-transport mechanism schematic
- explicit yield-risk and food-price resolution

Observed qualification:

- StoryGraph closure: 100%
- explanatory dimensions: 6
- statistical visual modules: 2
- illustration/mechanism modules: 1
- Default Chart Equivalence: false
- reader-question closure: true
- deterministic infographic critic: 98
- desktop render: 1440 x 2697
- mobile logical render: 720 x 3656
- desktop pixel QA: PASS
- mobile 2x pixel QA: PASS

## Compatibility evidence

The v1.7 editorial-semantic gates remain in place. Existing infographic, editorial-intelligence, magazine, backend-router and visualization contracts remain backward compatible for their declared schema versions. InfographicSpec 1.4 is additive at the schema family level and mandatory only for the new synthesis path.

The visual-compiler smoke suite was executed in segments because the host command budget terminated the long combined run after the ECharts extension stage. Every command completed before the cutoff passed; the remaining commands were resumed from the exact next test and all passed. There was no observed test failure in the segmented run.

## Not qualified on this host

The following gates remain external and are required before a final `1.8.0` promotion:

- Cargo/Rust toolchain is unavailable on this host
- DuckDB CLI is unavailable on this host
- local Node is 22.16.0 while the project baseline is 22.19.0
- real networked Pi/provider qualification was not executed
- independent DuckDB SQL recomputation was not executed
- qualified-human art-direction preference evidence was not collected

The RC must therefore remain an RC even though the deterministic synthesis regression passes.
