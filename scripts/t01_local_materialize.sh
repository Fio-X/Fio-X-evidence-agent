#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:?usage: $0 /path/to/t01-core-text-v3.tar.xz [--commit] [--push]}"
DO_COMMIT=false
DO_PUSH=false
for arg in "${@:2}"; do
  case "$arg" in
    --commit) DO_COMMIT=true ;;
    --push) DO_PUSH=true ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

EXPECTED_BRANCH="iteration-next"
EXPECTED_SHA="79219f59ba7667e8e540b83f14be74eddce2e97edd14febe61e446ac591a2d8a"
EXPECTED_BYTES=592736
EXPECTED_FILES=657
PLOTLY_SHA="9666a0e617e211ef2fbab8e9c9e07b224de1a67f56802d532ad59a42d5822df3"

CURRENT_BRANCH="$(git branch --show-current)"
test "$CURRENT_BRANCH" = "$EXPECTED_BRANCH" || {
  echo "expected branch $EXPECTED_BRANCH, got ${CURRENT_BRANCH:-DETACHED}" >&2
  exit 64
}

test -f "$ARCHIVE" || { echo "archive not found: $ARCHIVE" >&2; exit 66; }
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
ACTUAL_BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
ACTUAL_FILES="$(tar -tJf "$ARCHIVE" | wc -l | tr -d ' ')"

test "$ACTUAL_SHA" = "$EXPECTED_SHA" || { echo "archive sha mismatch: $ACTUAL_SHA" >&2; exit 2; }
test "$ACTUAL_BYTES" = "$EXPECTED_BYTES" || { echo "archive byte mismatch: $ACTUAL_BYTES" >&2; exit 2; }
test "$ACTUAL_FILES" = "$EXPECTED_FILES" || { echo "archive file count mismatch: $ACTUAL_FILES" >&2; exit 2; }

TMPDIR_T01="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T01"' EXIT

python3 -m pip install --disable-pip-version-check --user pyogrio==0.12.1 networkx==3.6.1 pyshp==2.3.1
python3 - "$TMPDIR_T01" <<'PY'
from pathlib import Path
import sys
import pyogrio

out = Path(sys.argv[1])
root = Path(pyogrio.__file__).resolve().parent
hits = list(root.rglob('tests/fixtures/naturalearth_lowres/naturalearth_lowres.shp'))
if len(hits) != 1:
    raise SystemExit(f'expected one Natural Earth fixture, found {len(hits)}')
(out / 'natural-earth-dir.txt').write_text(str(hits[0].parent))
PY

curl --fail --location --silent --show-error \
  https://cdn.plot.ly/plotly-3.3.1.min.js \
  -o "$TMPDIR_T01/plotly-3.3.1.min.js"
printf '%s  %s\n' "$PLOTLY_SHA" "$TMPDIR_T01/plotly-3.3.1.min.js" | shasum -a 256 -c -

python3 scripts/materialize_release_source.py \
  --root . \
  --archive "$ARCHIVE" \
  --plotly-source "$TMPDIR_T01/plotly-3.3.1.min.js" \
  --natural-earth-dir "$(cat "$TMPDIR_T01/natural-earth-dir.txt")"

python3 scripts/check_source_integrity.py \
  --root . \
  --manifest source-integrity.json \
  --archive "$ARCHIVE"

rm -rf bootstrap-staging
rm -f config/t01-comment-transport.json
python3 scripts/check_source_integrity.py --root . --manifest source-integrity.json

for path in \
  src/main.rs \
  src/audit.rs \
  src/artifact.rs \
  runtime/pi/newsroom.ts \
  runtime/pi/local_backend.mjs \
  runtime/pi/parallel_scheduler.mjs \
  runtime/pi/browser_qa.py \
  schemas/news-artifact.schema.json \
  scripts/release_check.py \
  scripts/integration_qualification.sh \
  scripts/agentic_qualification.sh \
  fixtures/v110-systems/large-network-5000.json \
  fixtures/v110-systems/world-outline.json; do
  test -f "$path" || { echo "missing release path after materialization: $path" >&2; exit 2; }
done

test ! -d bootstrap-staging
test ! -f config/t01-comment-transport.json

python3 - <<'PY'
import json
from pathlib import Path

path = Path('config/t01-blocker.json')
if path.is_file():
    data = json.loads(path.read_text())
    data['status'] = 'RESOLVED_LOCAL_MATERIALIZATION'
    data['resolved_via'] = 'local-authenticated-git-materialization'
    data['next_action'] = 'push iteration-next and let GitHub CI validate T02/T03/T04/T18'
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
PY

if $DO_COMMIT; then
  git add -A
  if git diff --cached --quiet; then
    echo "no materialization changes to commit"
  else
    git commit -m "Materialize complete hardened release source"
  fi
fi

if $DO_PUSH; then
  git push origin HEAD:iteration-next
fi

echo "T01 local materialization: PASS"
echo "archive sha256: $ACTUAL_SHA"
echo "archive bytes: $ACTUAL_BYTES"
echo "archive files: $ACTUAL_FILES"
