# Visual Runtime Architecture v1.16

Production requests never install visualization software. Six prebuilt runtimes expose capability manifests and health probes. The orchestrator selects a backend only when its runtime reports `AVAILABLE`.

Runtime boundaries intentionally isolate GDAL/GEOS/PROJ/QGIS/GMT/R dependency stacks. Runtime image digest plus `manifest.json` is the deployment lock. `VisualRecipe 2.0` contains visual semantics; `Backend Render Request` carries file paths and backend-specific execution options.

Qualification may render several candidates. Production defaults to one backend, with challenger mode only for low-confidence, new-family, flagship, or competition stories.
