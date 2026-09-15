---
name: qgis-cartography
description: Use for professional static cartography with dense labels, local/site maps, callouts, rule-based styling, print layouts, atlas output, or complex map composition when the QGIS runtime and a validated QPT template are available. Keep factual geometry and source layers immutable; use QGIS PAL and layout tools instead of custom label solvers.
---

# QGIS Cartography

## Workflow
1. Require `viz-qgis` health `AVAILABLE`.
2. Select a template from `runtime/qgis/templates/manifest.json` only when its status is `READY`; never treat pending templates as production-ready.
3. Bind immutable source layers and set project CRS, extent, labels, obstacle priorities, scale visibility, masks, callouts, legend, and source note through PyQGIS/template variables.
4. Render headlessly through `runtime/gis/qgis_publication_map.py`.
5. Export vector PDF/SVG for print and PNG for screenshot QA.
6. Reject output when source layers, template version, or projection cannot be replayed.

Keep QGIS as a professional renderer. Do not let it become a second evidence graph.
## ADN v1.32-v1.34 contracts
Map the request `design_system` into QGIS layout typography, context-layer styling and emphasis without overriding authoritative geometry or label facts. Store manual finishing as replayable ArtDirectionPatch v2 operations; invalidate them when semantic or design-system hashes change.

