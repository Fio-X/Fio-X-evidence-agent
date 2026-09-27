#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf outputs/v113-browser
node scripts/test_trusted_publication_v112.mjs
mkdir -p outputs/v113-browser/cpu outputs/v113-browser/gpu
python3 runtime/browser/browser_qa.py \
  --html outputs/v112-trusted/production.html \
  --spec outputs/v112-trusted/production-spec.json \
  --output outputs/v113-browser/cpu --profile cpu >/dev/null
set +e
python3 runtime/browser/browser_qa.py \
  --html outputs/v112-trusted/production.html \
  --spec outputs/v112-trusted/production-spec.json \
  --output outputs/v113-browser/gpu --profile gpu >/dev/null
GPU_CODE=$?
set -e
export GPU_CODE
python3 - <<'PY'
import json
from pathlib import Path
cpu=json.load(open('outputs/v113-browser/cpu/browser-qa.json'))
gpu=json.load(open('outputs/v113-browser/gpu/browser-qa.json'))
assert cpu['status']=='PASS' and cpu['security']['sandbox'] is True and not cpu['external_requests'] and not cpu['accessibility_errors'],cpu.get('errors')
summary={'schema_version':'0.1.0','release':'1.13.0-rc1','cpu_status':cpu['status'],'gpu_status':gpu['status'],'gpu_exit_code':int(__import__('os').environ.get('GPU_CODE','0')),'gpu_errors':gpu.get('errors',[])}
Path('outputs/v113-browser/summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
PY
