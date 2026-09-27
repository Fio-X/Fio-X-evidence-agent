#!/usr/bin/env bash
set -euo pipefail
RID="${1:?runtime id required}"
IMAGE="${2:?image tag required}"
OUT="${3:?fragment output required}"
PUSH="${4:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p "$(dirname "$OUT")"
HEALTH_FILE="${OUT%.json}.health.txt"
DEPS_FILE="${OUT%.json}.deps.txt"
# Health is evaluated only inside the built image.
docker run --rm "$IMAGE" ./scripts/runtime_image_health.sh "$RID" > "$HEALTH_FILE" 2>&1
docker run --rm "$IMAGE" ./scripts/runtime_dependency_lock.sh "$RID" > "$DEPS_FILE"
if [[ "$PUSH" == "1" ]]; then
  docker push "$IMAGE" >/dev/null
  REPO_DIGEST="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}')"
  DIGEST="${REPO_DIGEST##*@}"
else
  DIGEST="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
fi
DEF="$(python3 - "$RID" <<'PY'
import json,sys
from pathlib import Path
rid=sys.argv[1]
m=json.loads(Path('runtimes/build-matrix.json').read_text())['runtimes'][rid]
print(m['definition'])
PY
)"
python3 - "$RID" "$IMAGE" "$DIGEST" "$HEALTH_FILE" "$DEPS_FILE" "$DEF" "$OUT" <<'PY'
import hashlib,json,sys
from pathlib import Path
rid,image,digest,health,deps,definition,out=sys.argv[1:]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
row={
 'runtime':rid,'image':image,'image_digest':digest,'health_status':'PASS',
 'health_sha256':sha(health),'deps_sha256':sha(deps),'definition_sha256':sha(definition)
}
Path(out).write_text(json.dumps(row,indent=2)+'\n')
print(json.dumps(row,indent=2))
PY
