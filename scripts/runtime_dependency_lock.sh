#!/usr/bin/env bash
set -euo pipefail
RID="${1:?usage: runtime_dependency_lock.sh RUNTIME_ID}"
echo "runtime=$RID"
case "$RID" in
  viz-r)
    Rscript -e "ip<-installed.packages()[,c('Package','Version')]; ip<-ip[order(ip[,'Package']),,drop=FALSE]; apply(ip,1,function(x)cat(x[[1]],'==',x[[2]],'\n',sep=''))"
    ;;
  viz-qgis)
    qgis_process --version
    python3 -c "from qgis.core import Qgis; print('PyQGIS=='+Qgis.QGIS_VERSION)"
    ;;
  viz-pygmt)
    gmt --version | sed 's/^/GMT==/'
    python3 -m pip freeze | LC_ALL=C sort
    ;;
  viz-web)
    cd runtime/web
    node --version | sed 's/^/node==/'
    npm ls --all --json
    ;;
  viz-python|viz-density|viz-graph-extract)
    python3 --version
    python3 -m pip freeze | LC_ALL=C sort
    ;;
  *) echo "unknown runtime: $RID" >&2; exit 2 ;;
esac
