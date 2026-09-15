#!/usr/bin/env bash
set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
  echo "control-plane acceptance: SKIP (cargo unavailable in this environment)"
  exit 0
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/artifacts"
mock="$root/scripts/mock_pi.py"

cargo run --quiet --manifest-path "$root/Cargo.toml" -- investigate \
  --pi-bin "$mock" \
  --out "$out" \
  "Mock control-plane acceptance" >/tmp/newsroom-control-plane.out 2>/tmp/newsroom-control-plane.err

artifact="$(find "$out" -mindepth 1 -maxdepth 1 -type d | head -1)"
test -n "$artifact"

cargo run --quiet --manifest-path "$root/Cargo.toml" -- continue \
  --pi-bin "$mock" \
  "$artifact" \
  "Refocus the investigation and revise the plan." >>/tmp/newsroom-control-plane.out 2>>/tmp/newsroom-control-plane.err

cargo run --quiet --manifest-path "$root/Cargo.toml" -- verify "$artifact"
python3 "$root/scripts/evaluate_artifact.py" "$artifact"
cargo run --quiet --manifest-path "$root/Cargo.toml" -- inspect "$artifact" >/tmp/newsroom-control-plane.inspect

python3 - "$artifact" <<'PY'
import json, sys
from pathlib import Path
root=Path(sys.argv[1])
tools=json.loads((root/'tools.json').read_text())
story=json.loads((root/'story.json').read_text())
assert tools['failed_tool_calls'] >= 1, tools
assert tools['tools'].get('fetch_url', 0) >= 1, tools
assert tools['tools'].get('duckdb_query', 0) >= 2, tools
assert tools['plan_revisions'] >= 3, tools
assert story['autonomy']['user_messages'] >= 2, story
assert story['autonomy']['multi_turn_context'] is True, story
assert story['autonomy']['agent_loop_observed'] is True, story
assert story['autonomy']['autonomous_execution_observed'] is True, story
assert story['autonomy']['adaptive_replanning_observed'] is True, story
assert story['autonomy']['tool_failure_recovery_observed'] is True, story
assert story['autonomy']['session_resumed'] is True, story
assert story['autonomy']['follow_up_replanning_observed'] is True, story
print('control-plane failure recovery: PASS')
print(f"failed_tool_calls={tools['failed_tool_calls']} plan_revisions={tools['plan_revisions']} user_messages={story['autonomy']['user_messages']}")
PY

echo "control-plane acceptance: PASS"
