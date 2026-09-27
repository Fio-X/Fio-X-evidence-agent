---
name: pygmt-scientific
description: Use for terrain, bathymetry, contours, gridded scientific surfaces, projection-heavy global maps, and other GMT-native cartographic tasks when the PyGMT runtime is available. Treat PyGMT as a specialist backend rather than a default map renderer; keep source grids and region/projection parameters explicit.
---

# PyGMT Scientific

## Workflow
1. Confirm `viz-pygmt` is `AVAILABLE` and GMT/PyGMT versions pass health checks.
2. Use source grids with explicit units, coverage, resolution, and license.
3. Record region and projection in the backend render request.
4. Use GMT/PyGMT for coastline, relief, bathymetry, contours, masking, and scientific gridding.
5. Export PDF/PNG/SVG as supported and run projection/data-fidelity QA.

Use another backend for dense editorial labels or product-map interactions.
