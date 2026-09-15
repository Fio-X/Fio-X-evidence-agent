# v1.8 Iteration Plan: Visual Synthesis Qualification

Release target: `1.8.0-rc1`

## Problem statement

The v1.7 semantic layer made single-chart production safer, but the 2026-09-14 India monsoon/food-price cold story exposed a higher-level failure. The requested deliverable was an infographic, yet the qualification path reduced the story to one directly comparable monthly rainfall series and rendered an ordinary chart. The chart passed data, provenance and pixel checks while failing to synthesize the causal, spatial, temporal and outcome structure of the article.

The architectural cause is a layer inversion. Chart grammar was acting as the top-level story decision. Information graphics need a story-level representation first, then module-level charts, illustrations and explanatory text underneath it.

## Release objective

An infographic request must preserve the reader question through the entire visual pipeline. Heterogeneous evidence may be numerically non-comparable and still be narratively composable when the relationship is explicit. A final infographic must close the reader question, use more than one explanatory dimension when the story requires it, and must not silently degrade to a default single chart.

## P0. StoryGraph 0.1

Add a provider-independent story contract above chart planning.

Required fields:

- `reader_question`
- `visual_thesis`
- typed nodes: evidence, claim, mechanism, context, outcome, uncertainty
- typed relations: supports, causes, contributes_to, explains, contrasts_with, qualifies, locates, precedes, benchmarks
- entry nodes and answer nodes
- explanatory dimensions

The graph validator must verify node references, narrative reachability and enough dimensional diversity to justify an infographic. This layer models narrative composability. MeasureSemantics continues to govern numerical comparability inside individual visual modules.

Acceptance gate: all answer nodes must be reachable from at least one entry node and the graph must contain a narrative relation beyond support.

## P1. Reader question and visual thesis binding

Promote `reader_question`, `visual_thesis` and `story_graph_ref` into InfographicSpec 1.4. Every claim-bearing module must map to one or more StoryGraph nodes.

Acceptance gate: the final module set must cover every entry node and every answer node; answer nodes must appear in a resolution or explanation module. Insufficient story-node coverage blocks publication.

## P2. Module-level visual grammar

Move chart grammar below story synthesis. Each statistical visual receives its own `visual_grammar`, while the infographic planner operates on StoryGraph nodes and module roles.

Supported visual grammars include rank, change, trend, anomaly, benchmark, composition, distribution, relationship, uncertainty, flow, spatial, network, mechanism and sequence.

Acceptance gate: the selected asset chart type must be compatible with the module grammar. A valid story can therefore combine an anomaly chart, a benchmark comparison, a spatial statistic and a mechanism schematic without forcing them onto one numerical scale.

## P3. Synthesis gates

Add release-blocking tests that evaluate explanatory completeness rather than only pixel validity.

### Reader Question Closure

The final composition must visibly resolve the StoryGraph answer nodes and cover a majority of the graph. A visually polished page that answers a narrower question than the article is blocked.

### Default Chart Equivalence Test

When the requested deliverable is an infographic, a composition that can be reduced to one ordinary statistical chart without meaningful information loss is blocked. A valid infographic needs at least two visual or explanatory modules and at least two explanatory dimensions, with enough claim-bearing modules to establish a visual narrative.

### Narrative relation gate

The StoryGraph must contain at least one relation that carries explanation, causality, contrast, qualification, location, sequence or benchmarking. A bag of unrelated claims does not qualify as synthesis.

## P4. Orchestration enforcement

Add `newsroom_story_graph` to the Pi runtime. `newsroom_viz_plan` gains an `infographic_module` delivery role and requires a valid StoryGraph reference plus mapped node IDs when used inside an infographic. `newsroom_infographic_plan` always emits InfographicSpec 1.4 and verifies the StoryGraph plus concept-selection chain.

Acceptance gate: an infographic request cannot silently fall back to a standalone chart plan.

## P5. Supporting semantic and rendering fixes

Carry forward two issues exposed by the same cold story.

1. Treat climatological and historical normals as contextual reference measures so an observed value may be compared with a structurally defined benchmark without pretending they are identical observations.
2. Add `anomaly` grammar so a small set of deviations around a meaningful zero reference can prefer a diverging form over a generic time-series line.
3. Keep horizontal/diverging-bar value labels inside the mark at plot edges when an outside label would collide with the category label. Make this a vector-level regression assertion.

## P6. Qualification fixture

Use the 2026-09-14 India monsoon/food-risk story as the permanent synthesis regression. The qualifying composition must include at least:

- monthly rainfall anomaly
- low-pressure-system activity versus climatological normal
- widespread regional rainfall deficit
- acreage context
- a mechanism module linking circulation, moisture transport, uneven rainfall and yield risk
- a resolution that closes the path from weather risk to food-price risk

Target deterministic gates:

- StoryGraph closure: 100%
- at least four explanatory dimensions
- `default_chart_equivalent = false`
- reader-question closure: true
- at least two statistical visual modules
- at least one mechanism/explanatory module
- desktop and mobile pixel QA: PASS
- no v1.7 semantic-regression failures

## External final-release gates

Promotion from RC to final still requires the pinned live environment and evidence that cannot be manufactured locally:

- Rust 1.98.1
- Node 22.19.0 or newer
- Pi 0.85.1 with configured providers
- DuckDB 1.5.5 recomputation
- networked `investigate -> continue -> verify --recompute`
- same-day cold-story qualification across multiple story families
- qualified-human visual/editorial review
