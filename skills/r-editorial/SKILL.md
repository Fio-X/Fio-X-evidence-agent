---
name: r-editorial
description: Use for publication-quality static charts, thematic maps, and small-to-medium graph/network graphics when R is available, especially when ggplot2, mapsf, ggraph, sf, ggrepel, or sfnetworks fit the analytical task. Use ADN theme helpers instead of inventing styling on every run; do not use as a generic fallback when the runtime health check is unavailable.
---

# R Editorial

## Workflow
1. Confirm `viz-r` is `AVAILABLE`.
2. Use `sf` for spatial geometry, `ggplot2`/`mapsf` for publication maps, `ggraph` for static networks, `sfnetworks` for spatial networks, and `ggrepel`/mapsf labeling before inventing custom placement logic.
3. Source `runtime/gis/adnplot.R` and use ADN theme/finalization helpers so typography, source notes, and export stay consistent.
4. Export vector SVG/PDF where possible.
5. Run data-fidelity and visual-regression checks; never reinterpret a contextual relation as causal.

## Routing
Use QGIS when PAL labeling or complex print layout dominates; use Sigma for interactive graph exploration; use Datashader for million-mark density.
## ADN v1.32-v1.34 contracts
Consume the same versioned `design_system` contract used by other backends so blind qualification compares rendering craft rather than unrelated palettes. Preserve evidence and semantic fingerprints across human finishing.

