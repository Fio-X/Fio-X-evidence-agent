#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/test_trusted_publication_v112.mjs
python3 scripts/test_publication_schema_v19.py
rm -rf outputs/v112-trusted/archive-qa outputs/v112-trusted/production-qa outputs/v112-trusted/gpu-qa
python3 runtime/browser/browser_qa.py --html outputs/v112-trusted/archive.html --spec outputs/v112-trusted/archive-spec.json --output outputs/v112-trusted/archive-qa --profile cpu >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v112-trusted/production.html --spec outputs/v112-trusted/production-spec.json --output outputs/v112-trusted/production-qa --profile cpu >/dev/null
set +e
python3 runtime/browser/browser_qa.py --html outputs/v112-trusted/archive.html --spec outputs/v112-trusted/archive-spec.json --output outputs/v112-trusted/gpu-qa --profile gpu >/dev/null
GPU_CODE=$?
set -e
if [ "$GPU_CODE" -ne 2 ]; then echo "Expected GPU qualification to fail closed on this host, got $GPU_CODE" >&2; exit 1; fi
python3 - <<'PY'
import json
for p in ['outputs/v112-trusted/archive-qa/browser-qa.json','outputs/v112-trusted/production-qa/browser-qa.json']:
 d=json.load(open(p)); assert d['status']=='PASS' and d['security']['sandbox'] is True and not d['external_requests'] and not d['accessibility_errors'],(p,d.get('errors'))
g=json.load(open('outputs/v112-trusted/gpu-qa/browser-qa.json')); assert g['status']=='FAIL' and any(str(x).startswith('webgl2_unavailable:') for x in g['errors'])
print('trusted publication v1.12 browser qualification PASS; GPU fail-closed expected')
PY
