#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:?usage: $0 /path/to/t01-core-text-v3.tar.xz [--commit --push]}"
DO_COMMIT=false
DO_PUSH=false
for arg in "$@"; do
  case "$arg" in
    --commit) DO_COMMIT=true ;;
    --push) DO_PUSH=true ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

EXPECTED_SHA="79219f59ba7667e8e540b83f14be74eddce2e97edd14febe61e446ac591a2d8a"
EXPECTED_BYTES=592736
EXPECTED_FILES=657

ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
ACTUAL_BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
ACTUAL_FILES="$(tar -tJf "$ARCHIVE" | wc -l | tr -d ' ')"

test "$ACTUAL_SHA" = "$EXPECTED_SHA" || { echo "archive sha mismatch" >&2; exit 2; }
test "$ACTUAL_BYTES" = "$EXPECTED_BYTES" || { echo "archive byte mismatch" >&2; exit 2; }
test "$ACTUAL_FILES" = "$EXPECTED_FILES" || { echo "archive file count mismatch" >&2; exit 2; }

python3 scripts/materialize_release_source.py \
  --root . \
  --archive "$ARCHIVE" \
  --plotly-source "$ARCHIVE" \
  --natural-earth-dir "$ROOT/fixtures/external/naturalearth_lowres"

python3 scripts/check_source_integrity.py --root . --manifest source-integrity.json --archive "$ARCHIVE"

if $DO_COMMIT; then
  git add -A
  git commit -m "Materialize complete hardened release source" || true
fi

if $DO_PUSH; then
  git push origin HEAD
fi

echo "T01 materialization complete"
