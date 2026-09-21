---
name: editorial-chart
description: Use for recurring newsroom statistical chart families such as bars, dots, slopes, lines, distributions, scatterplots, small multiples, timelines, and chart-tables. Select a mature grammar or template backend and preserve a consistent project editorial theme, direct labeling, source notes, mobile behavior, and deterministic export rather than hand-coding a new renderer for each chart.
---

# Editorial Chart

## Workflow
1. Identify the analytical job before the chart family. Use bars for category comparison, lines for change over an ordered axis, dots for precise comparison, and a chart-table when exact values matter more than shape. Use a Sankey/alluvial only for additive flows between stages, a network/chord only for relationships, and a map only when location is part of the question.
2. Prefer mature declarative grammars/templates; use R editorial helpers for static publication and ECharts for interactive standard charts.
3. Write a conclusion-led title when the evidence supports one. Keep the subtitle factual and pass the measured unit and a source note whenever they are known. Never invent a source, unit, or precision.
4. Use one restrained accent colour per chart, a paper/ink/line token set, direct value labels where they remain legible, and truthful baselines. Do not use gradients, drop shadows, decorative illustrations, 3D effects, or elastic/bouncy motion.
5. Provide a responsive mobile state and honour `prefers-reduced-motion`. Keep essential values in the chart itself; tooltips are supplementary.
6. Export deterministically and run source/value checks plus screenshot QA. A screenshot `PASS` is diagnostic evidence, not a claim that the chart is publication-ready.

## Verification authority

Omit `claim_id` for exploratory visual grammar work and supplied-data
prototypes. The resulting SVG/HTML is explicitly marked `DRAFT`, is not
publishable, and must not be described as verified. For publication, record a
supported claim with source and computation references, then bind the claim ID.
Only the runtime may grant verified status after source validation and
deterministic computation replay; the model must never request or assert it.

## LieFlat-informed template discipline

The project follows the useful parts of the LieFlat workflow without copying its
PolyForm-licensed templates. First decide whether the question is a G22-style
two-end aggregate flow, a B3-style set of queryable paths, an M1/M2 regional
map, or a different grammar. Reuse the nearest tested Fio-X renderer and state
the translation when a composite is needed; do not draw a lookalike chart just
because its silhouette is attractive. A chart carries one governing conclusion,
and every line, dot, area, opacity and label must correspond to a real field or
an explicitly named derived measure.

For more than 50 visible routes, expose a usable hit area, hover/focus the full
route, allow click-to-pin and Escape to release it, and keep the selected state
legible with reduced motion. A map and a Sankey answer different questions, so
the supported composite keeps them as linked panels: the same stable route id
drives both panels, while each layer gets an independent width scale. Never use
one width scale for TWh, tonnes or USD. A static export must retain the active
layer's legend, exact unit, source, period and relationship/route disclosure.

LieFlat's upstream catalog is a design reference rather than a data connector.
It uses native SVG for editorial forms, ECharts for standard interactive maps and
networks, Chart.js for a few simple charts, Playwright for browser smoke tests,
and `IntersectionObserver` for restrained reveal. It does not supply energy,
logistics or capital data. Suitable Fio-X source candidates include Natural
Earth for a fixed basemap, EIA or Energy Institute for energy statistics,
UNCTAD/NGA World Port Index for logistics context, UN Comtrade for bilateral
trade, and IMF portfolio/direct-investment positions or World Bank remittance
estimates for capital relationships. Freeze the source snapshot and hash in the
artifact; treat representative country anchors and great-circle curves as
abstract relationships unless an observed or verified route geometry is bound.

## Complex newsroom forms

- **Sankey / alluvial:** input rows must carry `source`, `target`, `value`, and one explicit unit. Validate non-negative values, conservation where the story claims a conserved system, and acyclicity for Sankey layout. Sort or aggregate dense nodes, keep the largest paths visible, label nodes and key flows directly, and disclose when links are conceptual rather than physical routes.
- **Dandelion-like radial or bubble views:** the project does not treat “dandelion” as a free-form decoration. Use the qualified `beeswarm`, `circle_packing`, or a small-multiple backend only when position, area, and grouping answer a defined question. Label exact values, cap the number of marks, and provide a table or accessible text for close comparisons because circle area is hard to compare.
- **City and geographic maps:** choose a choropleth for a normalized regional rate or pattern, a proportional symbol map for counts, and a cartographic flow map for sourced relationships or observed tracks. Require CRS/projection, basemap provenance and hash, extent, scale/locator context, source date, and route semantics. A coarse world basemap must fail closed for street or harbour interpretation; do not let an arc imply a physical route unless the geometry is sourced as one.

These complex forms are implemented by the existing newsroom runtime (`viz.mjs`,
`infographic.mjs`, Plotly/D3 backends) and the professional Pi tool. The direct
`create_modern_chart` tool intentionally remains limited to checked bar/line
charts; it must not silently approximate a Sankey or a city map.

## `investigate-v2` contract

`create_modern_chart` is the interactive implementation of this skill. Use it only after values have been checked with the calculation/data tools. Pass `source_note` and `unit` when available. If a source is not available, leave it explicit rather than fabricating one. Prefer this tool for small bar and line charts; use the professional Pi tool for publication artifacts that need the full newsroom evidence pipeline. `create_chart` remains a compatibility fallback and is not the default publication renderer.

Do not expand the custom renderer catalog when an existing grammar already expresses the chart.

## ADN v1.32-v1.34 contracts
- Consume the versioned `design_system` returned by backend planning; do not invent a new palette or spacing system inside the renderer.
- Treat screenshot QA as diagnostic only. `PASS` never means competition-ready.
- Apply human art-direction changes only through ArtDirectionPatch v2 presentation fields. If semantic or design-system hashes change, invalidate the patch and request review.
