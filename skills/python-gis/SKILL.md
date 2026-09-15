---
name: python-gis
description: Use for deterministic static geospatial and editorial maps when the task needs CRS transforms, geometry operations, trajectories, flow maps, choropleths, symbol maps, or vector export and the Python visualization runtime is available. Prefer GeoPandas/Shapely/PROJ over hand-written geographic math; do not use for million-mark density, terrain-specialist, or dense-label QGIS tasks.
---

# Python GIS

## Workflow
1. Read the `VisualRecipe 2.0` and source ledger. Refuse invented or unverified geography.
2. Run `python3 scripts/runtime_health.py`; proceed only when `viz-python` is `AVAILABLE`.
3. Keep source coordinates in their declared CRS and perform distance/area work in an appropriate projected CRS with GeoPandas/Shapely/pyproj.
4. Prefer Pyogrio/Arrow/GeoParquet for substantial I/O. Preserve observation gaps and route semantics.
5. Render through the approved Python adapter or `runtime/gis/python_publication_map.py`. Do not manually project latitude/longitude into SVG coordinates.
6. Export SVG/PDF/PNG as required and run geometry/data-fidelity gates plus screenshot QA.

## Routing
Route terrain/bathymetry to `pygmt-scientific`, dense local labels to `qgis-cartography`, million-mark aggregation to `datashader-density`, and interactive geo to MapLibre/deck.gl.
## ADN v1.32-v1.34 contracts
Use the request `design_system` tokens for publication styling while leaving CRS, geometry, values and evidence untouched. Run deterministic screenshot QA after export. Replayed art-direction patches may alter presentation parameters only and must preserve the semantic fingerprint.

