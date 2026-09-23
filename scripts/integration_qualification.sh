#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEWS_BIN="${NEWSROOM_NEWS_BIN:-$ROOT/target/release/news}"
PROVIDER="${NEWSROOM_PROVIDER:-}"
MODEL="${NEWSROOM_MODEL:-}"
FIXTURE="${NEWSROOM_FIXTURE:-$ROOT/fixtures/world-bank-renewable-latest.csv}"
OUT="${NEWSROOM_LIVE_OUT:-$ROOT/.newsroom/live-qualification}"
ILLUSTRATION_ADAPTER="${NEWSROOM_ILLUSTRATION_ADAPTER:-$ROOT/scripts/mock_illustration_adapter.py}"
export NEWSROOM_ILLUSTRATION_ADAPTER="$ILLUSTRATION_ADAPTER"

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

before="$(find "$OUT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
"$NEWS_BIN" investigate \
  --tool-profile competition \
  --out "$OUT" \
  --data "$FIXTURE" \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  "Run the full visual-editor qualification on the local renewable-energy fixture. Start with one harmless controlled resilience probe: call fetch_url on http://127.0.0.1/qualification-probe, expect the local-host safety block, record the failure in the plan, then recover and continue. Use deterministic SQL to test whether a latest-country ranking is defensible when reference years differ, and record evidence-backed verified claims. Call newsroom_story_graph to bind the reader question, visual thesis, verified claims, explanatory relations and answer nodes before composing the visual story. Produce at least two distinct responsive newsroom visualizations and pass their deterministic critics. Produce one deterministic semantic explainer and pass its critic. Produce one provenance-aware rich illustration with origin_policy=ai_disclosed through the configured illustration adapter and pass its provenance critic. Compose an award-target responsive magazine infographic with competition_profile=oja2026_visual, a clear hook, evidence, explanation and resolution using the verified assets. Pass the deterministic infographic critic, call newsroom_infographic_preview to observe the exact desktop and mobile pixels, then call newsroom_infographic_vision_critic with concrete visible evidence. Exercise the bounded revision path at least once using a justified layout patch from the vision critic: call newsroom_infographic_revise rather than manually rewriting the plan, then repeat lint, render, deterministic critic, preview and vision critic. Use mobile_move_before when a finding is genuinely mobile-specific. Run no more than two repair cycles. Preserve source notes, mobile readability, provenance disclosures and mixed-reference-year caveats throughout. After the final candidate passes both critics, call newsroom_competition_preflight and keep its manual requirements explicit. Then exercise the trusted browser publication path on that exact approved story: use newsroom_publication_plan with the same StoryGraph and InfographicSpec, bind at least two data-bearing modules to immutable computations and verified claim IDs, use production packaging, call newsroom_publication_render, and run newsroom_publication_qa with profile=cpu. The browser publication must be evidence-bound, sandbox-qualified, accessibility-complete, and make zero external requests. Do not invent a patch merely to satisfy the qualification; if no evidence-backed patch is warranted, mark the qualification incomplete."

after="$(find "$OUT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [[ -z "$after" || "$after" == "$before" ]]; then
  echo "could not identify the newly created investigation artifact" >&2
  exit 3
fi
ARTIFACT="$after"

"$NEWS_BIN" continue \
  --tool-profile competition \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  "$ARTIFACT" \
  "Perform the second editorial pass as a mobile-first visual editor. Re-open the current infographic evidence and its image-aware critique, revise the observable plan, and fix any remaining mobile hierarchy, legibility, source-strip or illustration-integration weakness only through newsroom_infographic_revise using concrete bounded patches. Prefer mobile_move_before for mobile-only sequence changes. Re-run page lint/render/deterministic critic, observe fresh desktop and mobile previews, and persist a final passing image-aware vision critic. Then run newsroom_competition_preflight on that exact final plan/manifest/critic set and preserve every manual requirement in the qualification evidence. Re-open the trusted browser publication from the first pass, confirm it still binds the same StoryGraph/InfographicSpec and immutable evidence, re-render only if the bounded infographic revision changed a referenced module, and finish with a passing newsroom_publication_qa CPU report. Preserve the mixed-reference-year limitation and all provenance disclosures."

"$NEWS_BIN" verify "$ARTIFACT" --recompute
"$NEWS_BIN" inspect "$ARTIFACT" | tee "$ARTIFACT/inspect.txt"
python3 "$ROOT/scripts/evaluate_artifact.py" "$ARTIFACT" | tee "$ARTIFACT/competition-gate.txt"
python3 "$ROOT/scripts/write_qualification.py" "$ARTIFACT" --provider "$PROVIDER" --model "$MODEL"
cp "$ARTIFACT/qualification.json" "$OUT/qualification.json"

echo "integration qualification artifact: $ARTIFACT"
