---
name: editorial-chart
description: Use for recurring newsroom statistical chart families such as bars, dots, slopes, lines, distributions, scatterplots, small multiples, timelines, and chart-tables. Select a mature grammar or template backend and preserve a consistent ADN editorial theme, direct labeling, source notes, mobile behavior, and deterministic export rather than hand-coding a new renderer for each chart.
---

# Editorial Chart

## Workflow
1. Identify the analytical job before the chart family.
2. Prefer mature declarative grammars/templates; use R editorial helpers for static publication and ECharts for interactive standard charts.
3. Use direct labels, explicit units, source notes, truthful baselines, and mobile sibling states.
4. Avoid detached legends when direct labeling is practical and avoid decorative motion or generated imagery without analytical meaning.
5. Export deterministically and run source/value checks plus screenshot QA.

Do not expand the custom renderer catalog when an existing grammar already expresses the chart.
## ADN v1.32-v1.34 contracts
- Consume the versioned `design_system` returned by backend planning; do not invent a new palette or spacing system inside the renderer.
- Treat screenshot QA as diagnostic only. `PASS` never means competition-ready.
- Apply human art-direction changes only through ArtDirectionPatch v2 presentation fields. If semantic or design-system hashes change, invalidate the patch and request review.

