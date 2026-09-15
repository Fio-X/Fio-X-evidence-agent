---
name: web-geospatial
description: Use for interactive geospatial stories that need GPU-rendered paths, trips, vector tiles, zoom-dependent styling, map labels, or high-volume browser exploration. Route MapLibre GL JS to basemap/vector-tile/camera/label responsibilities and deck.gl to high-volume analytical layers such as TripsLayer, ArcLayer, PathLayer, MVTLayer, or aggregation. Use only when interaction materially improves the story; keep a deterministic static fallback for essential claims.
---

# Web Geospatial

## Workflow
1. Confirm `viz-web` is `AVAILABLE` and load only locally pinned packages.
2. Keep canonical geography and evidence outside the browser renderer. Use published vector/raster sources and stable feature IDs.
3. Use MapLibre for basemap, vector tiles, camera, label collision, and zoom-dependent cartographic styling.
4. Use deck.gl for high-volume paths, trips, arcs, aggregation, picking, and GPU-heavy overlays.
5. Make essential values, caveats, and source context available without hover. Provide touch, keyboard/focus, reduced-motion, and static export paths.
6. Record camera state, filters, layer parameters, data hashes, and package versions so a view can be regenerated.

Do not use WebGL merely for decoration. Route static print maps to Python/R/QGIS/PyGMT and million-mark static density preprocessing to Datashader.
## ADN v1.32-v1.34 contracts
Use the shared `design_system` contract for data-driven styling and keep data-bearing geometry deterministic. Browser screenshots may be visually diagnosed, but machine QA remains advisory and cannot establish competition readiness.

