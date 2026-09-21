#!/usr/bin/env python3
"""A rejected pre-acceptance Pi prompt is retried once without double execution."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "debug" / "news"

MOCK = r'''#!/usr/bin/env python3
import json, os, sys
count = 0
for line in sys.stdin:
    message = json.loads(line)
    command = message["type"]
    if command == "prompt":
        count += 1
        if count == 1:
            print(json.dumps({"type":"response","command":"prompt","success":False,"error":"HTTP 503 secret-must-not-leak"}), flush=True)
        else:
            print(json.dumps({"type":"response","command":"prompt","success":True}), flush=True)
            print(json.dumps({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}), flush=True)
            print(json.dumps({"type":"agent_settled"}), flush=True)
    elif command == "get_last_assistant_text":
        print(json.dumps({"type":"response","command":command,"success":True,"data":{"text":"ok"}}), flush=True)
    elif command == "get_session_stats":
        with open(os.environ["PROMPT_RETRY_CAPTURE"], "w", encoding="utf-8") as handle:
            json.dump({"prompt_count": count}, handle)
        print(json.dumps({"type":"response","command":command,"success":True,"data":{"tokens":{}}}), flush=True)
'''

if not BINARY.is_file():
    raise SystemExit("build target/debug/news before running this check")

with tempfile.TemporaryDirectory(prefix="news-prompt-retry-") as directory:
    directory = Path(directory)
    mock = directory / "pi_mock.py"
    capture = directory / "capture.json"
    mock.write_text(MOCK, encoding="utf-8")
    mock.chmod(0o755)
    env = os.environ.copy()
    env.update({
        "PROMPT_RETRY_CAPTURE": str(capture),
        "NEWSROOM_RPC_STARTUP_MS": "5000",
        "NEWSROOM_RPC_IDLE_MS": "3000",
        "NEWSROOM_RPC_FINISH_MS": "3000",
        "NEWSROOM_RPC_TOTAL_MS": "12000",
    })
    result = subprocess.run(
        [str(BINARY), "ask", "--pi-bin", str(mock), "retry probe"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 0, combined
    assert json.loads(capture.read_text()) == {"prompt_count": 2}
    assert "prompt_not_accepted retry=2/3" in result.stderr
    assert "secret-must-not-leak" not in combined

print("Pi prompt acceptance retry: PASS")
