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

cargo build --quiet --manifest-path "$root/Cargo.toml" --bin news
NEWSROOM_TEST_BINARY="$root/target/debug/news" NEWSROOM_TEST_MOCK="$mock" python3 - <<'PY'
import json, os, statistics, subprocess, tempfile, time
from pathlib import Path

root = Path(os.environ["NEWSROOM_TEST_BINARY"]).parents[2]
binary = Path(os.environ["NEWSROOM_TEST_BINARY"])
mock = Path(os.environ["NEWSROOM_TEST_MOCK"])
topic = "Complex interactive publication visual essay with self-contained HTML"

def run_case(persistent):
    with tempfile.TemporaryDirectory(prefix="newsroom-persistent-ab-") as tmp:
        tmp = Path(tmp)
        counter = tmp / "launches"
        wrapper = tmp / "pi-wrapper"
        wrapper.write_text(
            "#!/bin/sh\nprintf x >> \"$NEWSROOM_LAUNCH_COUNTER\"\nexec python3 \"$NEWSROOM_MOCK_PI\" \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        env = os.environ.copy()
        env.update({"NEWSROOM_LAUNCH_COUNTER": str(counter), "NEWSROOM_MOCK_PI": str(mock)})
        if persistent:
            env["NEWSROOM_PERSISTENT_PI_EXPERIMENT"] = "1"
        else:
            env.pop("NEWSROOM_PERSISTENT_PI_EXPERIMENT", None)
        started = time.monotonic()
        process = subprocess.run(
            [str(binary), "investigate", "--pi-bin", str(wrapper), "--out", str(tmp / "out"), topic],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        elapsed_ms = (time.monotonic() - started) * 1000
        artifacts = [path for path in (tmp / "out").iterdir() if path.is_dir()]
        assert len(artifacts) == 1, (persistent, process.returncode, process.stderr)
        events = [json.loads(line) for line in (artifacts[0] / "events.jsonl").read_text().splitlines()]
        metrics = [event for event in events if event.get("type") == "newsroom_rpc_metrics"]
        assert metrics, (persistent, process.stderr)
        return {
            "persistent": persistent,
            "exit_code": process.returncode,
            "e2e_ms": elapsed_ms,
            "launches": len(counter.read_text()),
            "rpc_count": len(metrics),
            "prompt_count": sum(event.get("prompt_count", 1) for event in metrics),
            "retries": sum(event.get("prompt_count", 1) for event in metrics) - 1,
        }

results = {"baseline": [run_case(False) for _ in range(10)], "persistent": [run_case(True) for _ in range(10)]}
for label, cases in results.items():
    values = sorted(case["e2e_ms"] for case in cases)
    median = statistics.median(values)
    p95 = values[ min(len(values) - 1, int(len(values) * 0.95)) ]
    for case in cases:
        assert case["exit_code"] != 0, case
    print(json.dumps({
        "variant": label,
        "repetitions": len(cases),
        "median_e2e_ms": round(median, 2),
        "p95_e2e_ms": round(p95, 2),
        "launches": [case["launches"] for case in cases],
        "rpc_count": [case["rpc_count"] for case in cases],
        "retries": [case["retries"] for case in cases],
    }, sort_keys=True))
assert all(case["launches"] == 3 and case["rpc_count"] == 3 and case["retries"] == 2 for case in results["baseline"])
assert all(case["launches"] == 1 and case["rpc_count"] == 1 and case["retries"] == 2 for case in results["persistent"])
print("persistent Pi repeated A/B: PASS")
PY

echo "control-plane acceptance: PASS"
