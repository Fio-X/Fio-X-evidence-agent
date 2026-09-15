# Professional Visualization Runtimes

Production requests must not install visualization dependencies dynamically. Build these runtimes on a networked image-build/CI host, pin the resulting image digest, then run `python3 scripts/runtime_health.py` inside the deployment environment.

The repository keeps six capability-isolated runtimes so GDAL/GEOS/PROJ, QGIS, GMT, R and browser dependencies do not have to share one mutable system environment. `scripts/bootstrap_visual_runtimes.sh` summarizes the build inputs. A backend is callable only when its required health probes pass.

Use `runtime/visual/backend_router_v2.mjs` to choose a capable backend from a validated VisualRecipe. Use qualification/challenger mode for comparative rendering; ordinary production should execute only the selected backend.
