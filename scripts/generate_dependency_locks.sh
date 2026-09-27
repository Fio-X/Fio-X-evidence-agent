#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v cargo >/dev/null 2>&1 || { echo 'cargo is required' >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required' >&2; exit 2; }
node_ver="$(node --version)"
python3 - "$node_ver" <<'PY'
import re,sys
m=re.match(r'v(\d+)\.(\d+)\.(\d+)',sys.argv[1]);
if not m or tuple(map(int,m.groups())) < (22,19,0): raise SystemExit('Node >=22.19.0 is required to generate production locks')
PY
cargo generate-lockfile
for d in runtime/web runtime/sigma runtime/map runtime/d3; do
  (cd "$d" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
done
python3 scripts/verify_dependency_locks.py
