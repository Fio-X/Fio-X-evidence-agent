#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEWS_BIN="${NEWSROOM_NEWS_BIN:-$ROOT/target/release/news}"
PROVIDER="${NEWSROOM_PROVIDER:-}"
MODEL="${NEWSROOM_MODEL:-}"
FIXTURE="${NEWSROOM_FIXTURE:-$ROOT/fixtures/world-bank-renewable-latest.csv}"
OUT="${NEWSROOM_AGENTIC_OUT:-$ROOT/.newsroom/agentic-qualification}"

if [[ -z "$PROVIDER" || -z "$MODEL" ]]; then
  echo "NEWSROOM_PROVIDER and NEWSROOM_MODEL are required" >&2
  exit 64
fi
if [[ ! -x "$NEWS_BIN" ]]; then
  echo "news binary not found or not executable: $NEWS_BIN" >&2
  exit 2
fi
if [[ ! -f "$FIXTURE" ]]; then
  echo "fixture not found: $FIXTURE" >&2
  exit 2
fi
mkdir -p "$OUT"

"$NEWS_BIN" doctor --strict --json --provider "$PROVIDER" --model "$MODEL" > "$OUT/doctor.json"

# Harness-controlled failure. The user goal below does not prescribe a tool,
# failure, recovery action, or execution order.
export NEWSROOM_FAULT_INJECT_TOOL_ONCE="${NEWSROOM_FAULT_INJECT_TOOL_ONCE:-duckdb_query}"

before="$(find "$OUT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
"$NEWS_BIN" investigate \
  --tool-profile investigate \
  --out "$OUT" \
  --data "$FIXTURE" \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  "Analyze the supplied renewable-energy data and identify the strongest defensible story angle. Verify consequential quantitative conclusions, check whether country comparisons use compatible reference periods, and produce a concise evidence-backed newsroom brief with a visual when it materially improves the explanation. Use external context only when it improves confidence or interpretation. Resolve recoverable problems autonomously and state unresolved limitations."

after="$(find "$OUT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [[ -z "$after" || "$after" == "$before" ]]; then
  echo "could not identify the newly created investigation artifact" >&2
  exit 3
fi
ARTIFACT="$after"

"$NEWS_BIN" continue \
  --tool-profile investigate \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  "$ARTIFACT" \
  "Revisit the strongest conclusion from the previous turn. Check whether reference-period comparability or another material caveat changes it. Correct only what needs correction, preserve evidence that remains valid, and update the deliverable accordingly."

"$NEWS_BIN" verify "$ARTIFACT" --recompute
"$NEWS_BIN" inspect "$ARTIFACT" | tee "$ARTIFACT/inspect.txt"
python3 "$ROOT/scripts/evaluate_agentic_artifact.py" "$ARTIFACT" --provider "$PROVIDER" --model "$MODEL" | tee "$ARTIFACT/agentic-gate.txt"
python3 "$ROOT/scripts/business_metrics.py" "$ARTIFACT" > "$ARTIFACT/business-metrics.stdout.json"

echo "agentic qualification artifact: $ARTIFACT"
