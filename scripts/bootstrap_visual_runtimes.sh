#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${CONTAINER_ENGINE:-}"
DRY=0
ONLY=""
if [[ -z "$ENGINE" ]]; then
  if command -v docker >/dev/null 2>&1; then ENGINE=docker; elif command -v podman >/dev/null 2>&1; then ENGINE=podman; else ENGINE=""; fi
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --runtime) ONLY="${2:-}"; shift 2 ;;
    --engine) ENGINE="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
python3 - "$ROOT" "$ONLY" "$ENGINE" "$DRY" <<'PY'
import json,sys,subprocess,shlex
from pathlib import Path
root=Path(sys.argv[1]); only=sys.argv[2]; engine=sys.argv[3]; dry=int(sys.argv[4])
matrix=json.loads((root/'runtimes/build-matrix.json').read_text())['runtimes']
if only and only not in matrix: raise SystemExit(f'unknown runtime: {only}')
rows=[]
for rid,spec in matrix.items():
    if only and rid!=only: continue
    cmd=[engine or '<container-engine>','build','-f',spec['definition'],'-t',spec['image'],'.']
    rows.append({'runtime':rid,'image':spec['image'],'command':' '.join(shlex.quote(x) for x in cmd)})
    print(f"[{rid}] {' '.join(shlex.quote(x) for x in cmd)}")
    if not dry:
        if not engine: raise SystemExit('docker/podman not found; rerun on a networked image-build host or use --dry-run')
        subprocess.run(cmd,cwd=root,check=True)
print(json.dumps({'schema_version':'1.0.0','dry_run':bool(dry),'engine':engine or None,'builds':rows},indent=2))
PY
