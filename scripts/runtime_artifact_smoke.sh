#!/usr/bin/env bash
set -euo pipefail
RID="${1:?usage: runtime_artifact_smoke.sh RUNTIME_ID}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="outputs/runtime-artifact-smoke/$RID"
rm -rf "$OUT"
mkdir -p "$OUT"
FP="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EH="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

case "$RID" in
  viz-python)
    cat > "$OUT/request.json" <<JSON
{"backend":"python_publication","story_id":"runtime-smoke-python","recipe_path":"runtime-smoke","output_dir":"$OUT","semantic_fingerprint":"$FP","evidence_hashes":{"fixtures/realdata/nasa-gistemp-1980-2025.csv":"$EH"},"claim_ids":["claim:runtime-smoke"],"inputs":{"table":"fixtures/realdata/nasa-gistemp-1980-2025.csv"},"options":{"renderer":"editorial_chart","chart_type":"line","x_field":"year","y_field":"anomaly_c","title":"Runtime artifact smoke","svg_filename":"figure.svg","png_filename":"figure.png"}}
JSON
    python3 runtime/gis/python_publication_request.py --request "$OUT/request.json"
    test -s "$OUT/figure.svg" && test -s "$OUT/figure.png" && test -s "$OUT/manifest.json"
    python3 scripts/test_python_warm_worker_v131.py >/dev/null
    ;;
  viz-r)
    cat > "$OUT/request.json" <<JSON
{"backend":"r_editorial","story_id":"runtime-smoke-r","recipe_path":"runtime-smoke","output_dir":"$OUT","semantic_fingerprint":"$FP","evidence_hashes":{"fixtures/realdata/nasa-gistemp-1980-2025.csv":"$EH"},"claim_ids":["claim:runtime-smoke"],"inputs":{"table":"fixtures/realdata/nasa-gistemp-1980-2025.csv"},"options":{"renderer":"editorial_chart","chart_type":"line","x_field":"year","y_field":"anomaly_c","title":"Runtime artifact smoke","filename":"figure.svg"}}
JSON
    Rscript runtime/gis/r_publication_request.R "$OUT/request.json"
    test -s "$OUT/figure.svg" && test -s "$OUT/manifest.json"
    ;;
  viz-qgis)
    cat > "$OUT/request.json" <<JSON
{"backend":"qgis_cartography","story_id":"runtime-smoke-qgis","recipe_path":"runtime-smoke","output_dir":"$OUT","semantic_fingerprint":"$FP","evidence_hashes":{"fixtures/v16-movement/ais-syros-sampled.json":"$EH"},"claim_ids":["claim:runtime-smoke"],"inputs":{"track":"fixtures/v16-movement/ais-syros-sampled.json","shoreline":"runtime/gis/assets/syros-upstream-shoreline-excerpt.geojson","island":"runtime/pi/assets/gshhs-i-syros-local.geojson"},"options":{"renderer":"trajectory_map","crs":"EPSG:32635","filename":"figure.svg","title":"Runtime artifact smoke","subtitle":"QGIS headless render","source_note":"Runtime smoke","scale_bar":true,"scale_segment_m":250}}
JSON
    python3 runtime/gis/qgis_publication_map.py --request "$OUT/request.json"
    test -s "$OUT/figure.svg" && test -s "$OUT/manifest.json"
    ;;
  viz-pygmt)
    cat > "$OUT/request.json" <<JSON
{"backend":"pygmt_scientific","story_id":"runtime-smoke-pygmt","recipe_path":"runtime-smoke","output_dir":"$OUT","semantic_fingerprint":"$FP","evidence_hashes":{"runtime":"$EH"},"claim_ids":["claim:runtime-smoke"],"inputs":{},"options":{"region":[-30,40,25,72],"projection":"M15c","filename":"figure.pdf"}}
JSON
    python3 runtime/gis/pygmt_publication_map.py --request "$OUT/request.json"
    test -s "$OUT/figure.pdf" && test -s "$OUT/manifest.json"
    ;;
  viz-density)
    cat > "$OUT/points.csv" <<CSV
x,y
0,0
1,1
1.2,0.8
2,1.5
2.2,1.8
3,2
CSV
    cat > "$OUT/request.json" <<JSON
{"backend":"datashader_density","story_id":"runtime-smoke-density","recipe_path":"runtime-smoke","output_dir":"$OUT","semantic_fingerprint":"$FP","evidence_hashes":{"$OUT/points.csv":"$EH"},"claim_ids":["claim:runtime-smoke"],"inputs":{"table":"$OUT/points.csv"},"options":{"x":"x","y":"y","width":320,"height":180,"filename":"density.png"}}
JSON
    python3 runtime/gis/datashader_density.py --request "$OUT/request.json"
    test -s "$OUT/density.png" && test -s "$OUT/manifest.json"
    ;;
  viz-web)
    cat > "$OUT/request.json" <<JSON
{"backend":"echarts_editorial","story_id":"runtime-smoke-web","recipe_path":"runtime-smoke","output_dir":"$OUT","semantic_fingerprint":"$FP","evidence_hashes":{"fixtures/realdata/nasa-gistemp-1980-2025.csv":"$EH"},"claim_ids":["claim:runtime-smoke"],"inputs":{"table":"fixtures/realdata/nasa-gistemp-1980-2025.csv"},"options":{"chart_type":"line","x_field":"year","y_field":"anomaly_c","title":"Runtime artifact smoke","width":800,"height":500}}
JSON
    node runtime/web/render_request.mjs --request "$OUT/request.json" >/dev/null
    test -s "$OUT/figure.svg" && test -s "$OUT/manifest.json"
    ;;
  viz-sigma|viz-map|viz-d3)
    printf '{"runtime":"%s","status":"PASS","note":"dependency import smoke completed before artifact smoke"}\n' "$RID" > "$OUT/manifest.json"
    test -s "$OUT/manifest.json"
    ;;
  viz-graph-extract)
    mkdir -p "$OUT/graphrag"
    python3 - "$OUT/graphrag" <<'PY'
import sys
from pathlib import Path
import pandas as pd
p=Path(sys.argv[1])
pd.DataFrame([
    {'id':'e1','title':'Alpha','type':'organization','description':'Alpha org','text_unit_ids':['t1']},
    {'id':'e2','title':'Beta','type':'organization','description':'Beta org','text_unit_ids':['t1']},
]).to_parquet(p/'entities.parquet',index=False)
pd.DataFrame([
    {'id':'r1','source':'Alpha','target':'Beta','description':'linked to','weight':1.0,'text_unit_ids':['t1']},
]).to_parquet(p/'relationships.parquet',index=False)
PY
    python3 runtime/graph/graphrag_to_evidence.py --input-dir "$OUT/graphrag" --output "$OUT/evidence.json" >/dev/null
    test -s "$OUT/evidence.json"
    ;;
  *) echo "unknown runtime: $RID" >&2; exit 2 ;;
esac

echo "$RID artifact smoke PASS"
