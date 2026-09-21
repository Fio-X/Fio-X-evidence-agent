#!/usr/bin/env python3
"""Verify Rust Pi launch phase propagation with a deterministic child."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "debug" / "news"
if not BINARY.is_file():
    raise SystemExit("build target/debug/news before running this check")

MOCK = r'''#!/usr/bin/env python3
import json, os, sys
capture = os.environ["PHASE_CAPTURE"]
with open(capture, "w", encoding="utf-8") as handle:
    json.dump({"phase": os.environ.get("NEWSROOM_PHASE"), "profile": os.environ.get("NEWSROOM_TOOL_PROFILE")}, handle)
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "prompt":
        print(json.dumps({"type":"response","command":"prompt","success":True}), flush=True)
        print(json.dumps({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}), flush=True)
        print(json.dumps({"type":"agent_settled"}), flush=True)
    elif message.get("type") == "get_last_assistant_text":
        print(json.dumps({"type":"response","command":message["type"],"success":True,"data":{"text":"ok"}}), flush=True)
    elif message.get("type") == "get_session_stats":
        print(json.dumps({"type":"response","command":message["type"],"success":True,"data":{"tokens":{}}}), flush=True)
'''

with tempfile.TemporaryDirectory(prefix="news-phase-") as directory:
    directory = Path(directory)
    mock = directory / "pi_mock.py"
    capture = directory / "capture.json"
    mock.write_text(MOCK, encoding="utf-8")
    mock.chmod(0o755)
    base = os.environ.copy()
    base.update({"PHASE_CAPTURE": str(capture), "NEWSROOM_RPC_STARTUP_MS": "5000", "NEWSROOM_RPC_FINISH_MS": "3000", "NEWSROOM_RPC_TOTAL_MS": "10000"})
    cases = [("verify,design", "verify,design"), ("invalid", "core"), (None, None)]
    observed = []
    for requested, expected in cases:
        env = base.copy()
        if requested is None:
            env.pop("NEWSROOM_PHASE", None)
        else:
            env["NEWSROOM_PHASE"] = requested
        result = subprocess.run([str(BINARY), "ask", "--pi-bin", str(mock), "phase probe"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stdout + result.stderr
        value = json.loads(capture.read_text(encoding="utf-8"))
        assert value["phase"] == expected, (requested, value)
        observed.append(value)
    print(json.dumps({"status": "PASS", "cases": observed}, separators=(",", ":")))
