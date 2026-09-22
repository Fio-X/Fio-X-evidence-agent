#!/usr/bin/env bash
set -euo pipefail
RID="${1:?usage: runtime_image_health.sh RUNTIME_ID}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
case "$RID" in
  viz-python)
    python3 - <<'PY'
import geopandas,shapely,pyproj,pyogrio,matplotlib
print('viz-python',geopandas.__version__,shapely.__version__,pyproj.__version__,pyogrio.__version__,matplotlib.__version__)
PY
    ;;
  viz-r)
    Rscript -e "stopifnot(getRversion() >= '4.6.1'); pkgs <- c('sf','terra','stars','ggplot2','ggrepel','mapsf','tmap','tidygraph','igraph','ggraph','sfnetworks','ragg','svglite','arrow','jsonlite','ggalluvial','geosphere'); invisible(lapply(pkgs, requireNamespace, quietly=FALSE)); cat('viz-r PASS\n')"
    ;;
  viz-qgis)
    qgis_process --version
    python3 -c "from qgis.core import QgsApplication; print('PyQGIS PASS')"
    ;;
  viz-pygmt)
    gmt --version
    python3 - <<'PY'
import pygmt
print('PyGMT',pygmt.__version__)
PY
    ;;
  viz-density)
    python3 - <<'PY'
import datashader,dask,xarray
print('viz-density',datashader.__version__,dask.__version__,xarray.__version__)
PY
    ;;
  viz-web)
    ( cd runtime/web
    node --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
const pkg=JSON.parse(readFileSync('package.json','utf8'));
for(const name of ['sigma','graphology','maplibre-gl','@deck.gl/core','echarts']){
  console.log(name,import.meta.resolve(name));
}
console.log('viz-web PASS',process.version,pkg.version);
JS
    )
    ;;
  viz-sigma)
    ( cd runtime/sigma
      node --input-type=module -e "for(const name of ['graphology','sigma']) console.log(name,import.meta.resolve(name)); console.log('viz-sigma PASS')"
    )
    ;;
  viz-map)
    ( cd runtime/map
      node --input-type=module -e "for(const name of ['maplibre-gl','@deck.gl/core']) console.log(name,import.meta.resolve(name)); console.log('viz-map PASS')"
    )
    ;;
  viz-d3)
    ( cd runtime/d3
      node -e "Promise.all([import('d3'),import('vega-lite')]).then(()=>console.log('viz-d3 PASS')).catch(e=>{console.error(e);process.exit(1)})"
    )
    ;;
  viz-graph-extract)
    python3 - <<'PY'
import importlib.metadata as m,pyarrow,pandas
print('viz-graph-extract',m.version('graphrag'),pyarrow.__version__,pandas.__version__)
assert m.version('graphrag')=='3.1.2'
PY
    ;;
  *) echo "unknown runtime: $RID" >&2; exit 2 ;;
esac

"$ROOT/scripts/runtime_artifact_smoke.sh" "$RID"
