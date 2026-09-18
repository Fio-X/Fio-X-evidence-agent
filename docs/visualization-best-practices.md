# Newsroom visualization practice

This note records the external references used for the editorial-chart
iteration. It is a design and validation contract, not a claim that a
screenshot is publication-ready.

## What the references agree on

- The Data Visualization Society's [new-to-data-viz guide](https://datavisualizationsociety.org/new-to-data-viz/)
  starts with the question, audience, data, and visual encoding before a tool
  choice. It also points to critique, accessibility, mapping, and reusable
  grammars as part of the workflow.
- The [2025 Sigma shortlist](https://www.sigmaawards.org/announcing-the-sigma-awards-2025-shortlist/)
  and the [2025 winners announcement](https://www.sigmaawards.org/from-flammable-buildings-to-slaverys-hidden-legacy-to-tainted-groundwater-projects-from-10-countries-win-gijns-2025-sigma-awards/)
  show that strong data journalism is judged as reporting: sourcing and
  analysis must support the narrative. Visual polish alone is not evidence.
- [SCMP's infographics](https://www.scmp.com/infographic/) use combinations of
  data, maps, video, illustration, and text for a reported story. The practical
  lesson for this agent is to choose a visual sequence around the story, rather
  than force every question into a bar chart.
- The [Economist's data-visualisation guidance](https://education.economist.com/blog/interviews/tips-for-visualising-data-like-the-economist)
  recommends a simple visual grammar, direct labels, restrained colour, and
  care with area comparisons. A highlighted series should have a clear reason;
  colour should not become decoration.
- The [Metalocus review of the 2016 Information Is Beautiful winners](https://www.metalocus.es/en/news/information-art-best-infographics-year-2016)
  is a useful case index rather than a style template: its categories separate
  data visualisation, infographic, data journalism, interactive, motion, and
  project work. The listed examples include a temperature timeline, a migrant
  map, a flow/network story, a city/road calculation, and a ship map. The
  reusable lesson is to let the evidence structure select the medium and to
  keep interaction or motion in service of a question; an attractive poster
  without a data contract is not promoted by this project.

## Complex chart families

The runtime now treats the following as separate analytical contracts:

| Question | Suitable form | Required checks |
| --- | --- | --- |
| How does a conserved quantity move through stages? | Sankey or alluvial | `source`, `target`, `value`, one unit, non-negative values, conservation/acyclicity when claimed, dense-node policy, direct labels, and a note when a link is conceptual. See [Google's Sankey reference](https://developers.google.com/chart/interactive/docs/gallery/sankey). |
| How are observations distributed inside groups? | Beeswarm, circle packing, or small multiples (a qualified dandelion-like view) | A defined positional and grouping meaning, an exact-value table or text, a mark cap, and a warning that circle area is difficult to compare. Free-form radial decoration is rejected. |
| Where is a rate, count, or sourced movement located? | Choropleth, proportional symbols, or a cartographic flow map | Correct denominator for rates, count/rate choice, CRS/projection, basemap provenance and hash, extent/locator, scale, source date, and route semantics. A coarse world basemap cannot imply a street or harbour route. See [Datawrapper's choropleth guide](https://www.datawrapper.de/academy/what-to-consider-when-creating-choropleth-maps). |

These checks are encoded in `skills/editorial-chart/SKILL.md` and the existing
`viz.mjs`, `infographic.mjs`, Plotly/D3, and professional Pi paths. The small
`create_modern_chart` tool deliberately remains a checked bar/line renderer;
complex forms must use the evidence-backed runtime that can preserve their
metadata and validation.

The implementation therefore has an explicit escalation path: a simple
comparison stays in the deterministic bar/line renderer; a multi-stage flow,
distribution, network, timeline, or geography request is routed to the mature
runtime and must emit its semantic manifest, provenance, and fallback text.
The renderer is not allowed to manufacture a decorative Sankey, radial
“dandelion,” or city route merely because the prompt asks for a fashionable
shape.

## Project acceptance gates

Every generated visual must pass four gates before it is used as evidence:

1. **Data and semantics:** values, units, denominators, joins, flow balance,
   coordinate meaning, and uncertainty are checked before rendering.
2. **Provenance:** source, source date, query/transform, projection/basemap
   identity, and artifact hash are retained. External URLs are not a substitute
   for a reproducible local artifact.
3. **Editorial layout:** conclusion-led title where justified, readable direct
   labels, a restrained palette, truthful axis, source note, mobile layout, and
   an accessible text/table fallback.
4. **Runtime safety:** bounded tools and subprocesses, reduced-motion behavior,
   no prompt/tool-argument leakage, and a screenshot/browser check that is
   reported as diagnostic evidence only.

LieFlat was reviewed as an additional reference ([upstream skill](https://raw.githubusercontent.com/larashero3-dotcom/lieflat-charts/main/SKILL.md)),
but it is not vendored: its [PolyForm Noncommercial license](https://raw.githubusercontent.com/larashero3-dotcom/lieflat-charts/main/LICENSE)
is incompatible with treating upstream files as MIT project code. The project
implements the compatible principles in its own skill instead.
