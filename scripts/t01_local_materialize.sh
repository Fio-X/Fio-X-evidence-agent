#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:?usage: $0 /path/to/source-archive.tar.xz-or.zip [--commit] [--push]}"
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
EXPECTED_ZIP_SHA="aeadda6880610411d9527d1eb2d7377229f0345305177ebd42dabc8fab89ffed"
EXPECTED_ZIP_BYTES=7050029
EXPECTED_ZIP_ENTRIES=778
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
ARCHIVE_INFO="$(python3 - "$ARCHIVE" <<'PY'
from pathlib import Path
import sys
import tarfile
import zipfile

archive = Path(sys.argv[1])
if zipfile.is_zipfile(archive):
    with zipfile.ZipFile(archive) as zf:
        print(f"zip\t{len(zf.infolist())}")
elif tarfile.is_tarfile(archive):
    with tarfile.open(archive, "r:*") as tf:
        print(f"tar\t{len(tf.getmembers())}")
else:
    raise SystemExit(f"unsupported source archive format: {archive}")
PY
)"
ARCHIVE_FORMAT="${ARCHIVE_INFO%%$'\t'*}"
ACTUAL_FILES="${ARCHIVE_INFO#*$'\t'}"

case "$ARCHIVE_FORMAT" in
  tar)
    test "$ACTUAL_SHA" = "$EXPECTED_SHA" || { echo "archive sha mismatch: $ACTUAL_SHA" >&2; exit 2; }
    test "$ACTUAL_BYTES" = "$EXPECTED_BYTES" || { echo "archive byte mismatch: $ACTUAL_BYTES" >&2; exit 2; }
    test "$ACTUAL_FILES" = "$EXPECTED_FILES" || { echo "archive entry count mismatch: $ACTUAL_FILES" >&2; exit 2; }
    ;;
  zip)
    test "$ACTUAL_SHA" = "$EXPECTED_ZIP_SHA" || { echo "ZIP archive sha mismatch: $ACTUAL_SHA" >&2; exit 2; }
    test "$ACTUAL_BYTES" = "$EXPECTED_ZIP_BYTES" || { echo "ZIP archive byte count mismatch: $ACTUAL_BYTES" >&2; exit 2; }
    test "$ACTUAL_FILES" = "$EXPECTED_ZIP_ENTRIES" || { echo "ZIP archive entry count mismatch: $ACTUAL_FILES" >&2; exit 2; }
    ;;
  *)
    echo "unsupported source archive format: $ARCHIVE_FORMAT" >&2
    exit 2
    ;;
esac

TMPDIR_T01="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T01"' EXIT
python3 -m venv "$TMPDIR_T01/venv"
T01_PYTHON="$TMPDIR_T01/venv/bin/python"

if [ "$ARCHIVE_FORMAT" = "zip" ]; then
  "$T01_PYTHON" -m pip install --disable-pip-version-check networkx==3.6.1 pyshp==2.3.1 numpy==2.5.3
  "$T01_PYTHON" - "$ARCHIVE" "$TMPDIR_T01" <<'PY'
from pathlib import Path, PurePosixPath
import sys
import zipfile

archive = Path(sys.argv[1])
out = Path(sys.argv[2])
required = {
    'runtime/pi/vendor/plotly-3.3.1.min.js': out / 'plotly-3.3.1.min.js',
    'fixtures/external/naturalearth_lowres/naturalearth_lowres.dbf': out / 'natural-earth' / 'naturalearth_lowres.dbf',
    'fixtures/external/naturalearth_lowres/naturalearth_lowres.shp': out / 'natural-earth' / 'naturalearth_lowres.shp',
    'fixtures/external/naturalearth_lowres/naturalearth_lowres.shx': out / 'natural-earth' / 'naturalearth_lowres.shx',
}

def safe_rel(name: str, prefix: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise SystemExit(f'unsafe ZIP member: {name}')
    parts = list(path.parts)
    if parts and parts[0] == prefix:
        parts = parts[1:]
    return PurePosixPath(*parts).as_posix() if parts else ''

with zipfile.ZipFile(archive) as zf:
    infos = [info for info in zf.infolist() if not info.is_dir()]
    prefixes = {PurePosixPath(info.filename).parts[0] for info in infos if PurePosixPath(info.filename).parts}
    prefix = next(iter(prefixes)) if len(prefixes) == 1 else ''
    matches = {}
    for info in infos:
        rel = safe_rel(info.filename, prefix)
        if rel in required:
            if rel in matches:
                raise SystemExit(f'duplicate required ZIP member: {rel}')
            matches[rel] = info
    missing = sorted(set(required) - set(matches))
    if missing:
        raise SystemExit(f'missing required ZIP members: {missing}')
    for rel, destination in required.items():
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(matches[rel]) as source, destination.open('wb') as target:
            target.write(source.read())
    (out / 'natural-earth-dir.txt').write_text(str(out / 'natural-earth'))
PY
else
  "$T01_PYTHON" -m pip install --disable-pip-version-check pyogrio==0.12.1 networkx==3.6.1 pyshp==2.3.1 numpy==2.5.3
  "$T01_PYTHON" - "$TMPDIR_T01" <<'PY'
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
fi

printf '%s  %s\n' "$PLOTLY_SHA" "$TMPDIR_T01/plotly-3.3.1.min.js" | shasum -a 256 -c -

"$T01_PYTHON" scripts/materialize_release_source.py \
  --root . \
  --archive "$ARCHIVE" \
  --plotly-source "$TMPDIR_T01/plotly-3.3.1.min.js" \
  --natural-earth-dir "$(cat "$TMPDIR_T01/natural-earth-dir.txt")"

"$T01_PYTHON" scripts/check_source_integrity.py \
  --root . \
  --manifest source-integrity.json \
  --archive "$ARCHIVE"

rm -rf bootstrap-staging
rm -f config/t01-comment-transport.json
"$T01_PYTHON" scripts/check_source_integrity.py --root . --manifest source-integrity.json

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

"$T01_PYTHON" - <<'PY'
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
