# Modern chart and professional Pi comparison

This is a historical implementation note for the `cf64d52` chart experiment.
It is kept to explain why the renderer changed; it is not a qualification,
competition score, or release-readiness claim.

## Before the iteration

The first ECharts experiment used a purple page gradient, a multi-colour series
gradient, drop shadows, rounded cards, elastic animation, and an interaction
footer. It accepted only labels and values, so the output had no required unit
or source-note contract. Those choices made the page look generic and made it
easy to mistake decoration for evidence.

The professional Pi path already produced evidence-backed SVG artifacts and
remains the publication path for complex newsroom visuals. The small ECharts
tool was useful for quick interactive comparisons, but it was not a substitute
for the evidence pipeline.

## Current contract

`create_modern_chart` now produces a deterministic bar or line page with:

- paper/ink/line tokens and one solid accent colour;
- direct values, a truthful value axis, optional factual subtitle, unit, and
  explicit source-note status;
- input validation for non-empty labels, numeric finite values, chart family,
  and title;
- a content-addressed output name, escaped HTML and script data, and an inline
  SVG fallback for offline or JavaScript-disabled viewing;
- responsive layout and reduced-motion handling. Hover is supplementary and
  never the only place an essential value appears.

Sankey/alluvial, network, distribution, timeline, and geographic stories stay
on the mature `viz.mjs`, `infographic.mjs`, Plotly/D3, or professional Pi path.
Their semantic and provenance requirements are documented in
[`docs/visualization-best-practices.md`](visualization-best-practices.md) and
`skills/editorial-chart/SKILL.md`.

## Verification

The Rust tests check malformed input rejection, deterministic IDs, escaping,
source/unit handling, and the absence of gradients, shadows, and elastic
motion. Browser screenshots and the strict local Anthropic wire mock are
diagnostic evidence only; they do not establish publication readiness or
qualification.
