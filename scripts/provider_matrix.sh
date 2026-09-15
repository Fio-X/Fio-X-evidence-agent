#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX="${NEWSROOM_PROVIDER_MATRIX:-}"
OUT="${NEWSROOM_PROVIDER_MATRIX_OUT:-$ROOT/.newsroom/provider-matrix}"
if [[ -z "$MATRIX" ]]; then
  echo "NEWSROOM_PROVIDER_MATRIX is required, e.g. anthropic:claude-sonnet-4-5,openai:gpt-5" >&2
  exit 64
fi
mkdir -p "$OUT"
IFS=',' read -r -a entries <<< "$MATRIX"
qualifications=()
failures=0
for entry in "${entries[@]}"; do
  provider="${entry%%:*}"
  model="${entry#*:}"
  if [[ -z "$provider" || -z "$model" || "$provider" == "$model" ]]; then
    echo "invalid provider matrix entry: $entry" >&2
    exit 64
  fi
  slug="$(printf '%s-%s' "$provider" "$model" | tr -cs 'A-Za-z0-9._-' '_' | sed 's/_$//')"
  run_out="$OUT/$slug"
  mkdir -p "$run_out"
  echo "== qualifying $provider / $model =="
  if NEWSROOM_PROVIDER="$provider" NEWSROOM_MODEL="$model" NEWSROOM_AGENTIC_OUT="$run_out" "$ROOT/scripts/agentic_qualification.sh"; then
    :
  else
    failures=$((failures+1))
  fi
  latest="$(find "$run_out" -name agentic-qualification.json -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
  if [[ -n "$latest" ]]; then qualifications+=("$latest"); fi
done
if [[ ${#qualifications[@]} -eq 0 ]]; then
  echo "no qualification artifacts were produced" >&2
  exit 3
fi
python3 "$ROOT/scripts/compare_qualifications.py" "${qualifications[@]}" --json-out "$OUT/provider-comparison.json" --markdown-out "$OUT/provider-comparison.md" || failures=$((failures+1))
echo "provider comparison: $OUT/provider-comparison.md"
[[ $failures -eq 0 ]]
