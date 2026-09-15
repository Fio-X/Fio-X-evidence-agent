#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFY = ROOT / "scripts" / "verify_artifact.py"
FAKE = ROOT / "scripts" / "fake_duckdb.py"

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def sha(text: str):
    return hashlib.sha256(text.encode()).hexdigest()

def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")

def build(root: Path):
    for d in ["data", "sources", "computations", "session"]:
        (root / d).mkdir(parents=True, exist_ok=True)
    for name in ["prompt.md", "answer.md", "conversation.md", "events.jsonl", "tools.json", "session-stats.json", "plan.json", "claims.jsonl"]:
        (root / name).write_text("{}\n" if name.endswith((".json", ".jsonl")) else "fixture\n")
    data = "country,value\nA,1\nB,2\n"
    data_hash = hashlib.sha256(data.encode()).hexdigest()
    data_ref = f"data/{data_hash}.csv"
    (root / data_ref).write_text(data)
    write_json(root / f"{data_ref}.meta.json", {"schema_version":"0.7.0","file":data_ref,"sha256":data_hash})
    rows = [{"country":"A","value":1},{"country":"B","value":2}]
    result_hash = sha(canonical(rows))
    fingerprints = [f"data:{data_ref}:{data_hash}"]
    input_hash = sha("\n".join(fingerprints))
    sql = "SELECT country, value FROM read_csv_auto('data/%s.csv') ORDER BY country" % data_hash
    key = sha(f"{sql}\n{input_hash}\n{result_hash}")
    comp_ref = f"computations/{key}.json"
    write_json(root / comp_ref, {"schema_version":"0.7.0","sql":sql,"input_snapshot_hash":input_hash,"input_fingerprints":fingerprints,"result_hash":result_hash,"rows":rows})
    story = {
        "schema_version":"0.7.0","id":"recompute","kind":"investigation","created_at":"2026-09-12T00:00:00Z","updated_at":"2026-09-12T00:00:00Z","topic":"fixture","status":"draft",
        "runtime":{"backend":"pi-rpc","provider":None,"model":None,"session_dir":"session/"},
        "files":{"prompt":"prompt.md","latest_answer":"answer.md","conversation":"conversation.md","events":"events.jsonl","tool_audit":"tools.json","session_stats":"session-stats.json","plan":"plan.json","claims":"claims.jsonl","run_metrics":"run-metrics.jsonl"},
        "autonomy":{"persistent_session":True,"multi_turn_context":False,"observable_planning":True,"agent_loop_observed":False,"user_messages":0,"turns":0,"tool_calls":0,"capability_tool_calls":0,"distinct_tools":0,"plan_revisions":0,"failed_tool_calls":0,"automatic_retries":0},
        "evidence":{"searches":[],"sources":[],"datasets":[data_ref,f"{data_ref}.meta.json"],"computations":[comp_ref],"claims":[],"visualizations":[]}
    }
    (root / "run-metrics.jsonl").write_text(json.dumps({"schema_version":"0.7.0","operation":"investigate","status":"draft","duration_ms":1}) + "\n")
    write_json(root / "story.json", story)

with tempfile.TemporaryDirectory(prefix="newsroom-recompute-") as tmp:
    root = Path(tmp)
    build(root)
    env = os.environ.copy(); env["FAKE_DUCKDB_MODE"] = "match"
    ok = subprocess.run([sys.executable, str(VERIFY), str(root), "--recompute", "--duckdb-bin", str(FAKE)], env=env, capture_output=True, text=True)
    if ok.returncode != 0:
        print(ok.stdout); print(ok.stderr, file=sys.stderr); raise SystemExit("recompute match should pass")
    env["FAKE_DUCKDB_MODE"] = "mismatch"
    bad = subprocess.run([sys.executable, str(VERIFY), str(root), "--recompute", "--duckdb-bin", str(FAKE)], env=env, capture_output=True, text=True)
    if bad.returncode == 0 or "recompute rows mismatch" not in bad.stdout:
        print(bad.stdout); print(bad.stderr, file=sys.stderr); raise SystemExit("recompute mismatch was not rejected")
print("recompute protocol smoke: PASS (match accepted, mismatch rejected)")
