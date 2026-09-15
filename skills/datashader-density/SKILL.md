---
name: datashader-density
description: Use for very large point, trajectory, or density datasets where vector marks would be excessive, typically around one million or more marks or when a density/raster representation is the analytical intent. Use Datashader only for aggregation pixels; add labels, annotations, and editorial composition in a downstream renderer.
---

# Datashader Density

## Workflow
1. Confirm `viz-density` is `AVAILABLE`.
2. Use the canonical table/GeoParquet artifact; keep x/y fields, units, aggregation metric, ranges, canvas dimensions, and transform explicit.
3. Aggregate with Datashader. Never downsample merely to make SVG manageable when density is the analytical target.
4. Save the deterministic raster plus a manifest of row count, canvas, fields, ranges, and aggregation.
5. Composite the raster under vector labels and annotations in Python, QGIS, or the web renderer.

Do not use color/motion to imply a quantity that the aggregation does not encode.
