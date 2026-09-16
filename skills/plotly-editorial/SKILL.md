---
name: plotly-editorial
description: Build self-contained interactive editorial charts, uncertainty views, scientific maps, Sankey diagrams and linked browser visualizations with Plotly while preserving verified data and claim bindings.
---
Use Plotly when the reader benefits from hover, selection, responsive browser layout, linked views, qualified uncertainty bands, scientific spatial views, Sankey flow inspection or standard interactive statistical graphics. Keep figure data derived only from verified rows.

For Sankey, validate conserved-flow semantics and units upstream with ModelSpec. For uncertainty, preserve coverage semantics and interval ordering. For scientific maps, render only after MapSpec passes CRS, projection, extent, basemap adequacy, scale and uncertainty checks. Do not use a generic world scaffold for local geography when the detail class is inadequate, and avoid rainbow scales.

Prefer direct labels and concise hover text. Use the functional StyleProfile colourway/typography unless a verified semantic encoding requires a specific scale. Keep essential values and caveats visible without hover. Use self-contained HTML with the pinned runtime, no CDN requests, and always produce a deterministic static archive through browser QA.
