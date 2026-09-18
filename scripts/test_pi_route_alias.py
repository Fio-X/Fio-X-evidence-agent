#!/usr/bin/env python3
"""Verify the legacy OpenAI env alias selects the DragonCode Pi provider."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "release" / "news"
FIXTURE_KEY = "fixture-key-do-not-print"


MOCK = r'''#!/usr/bin/env python3
import json, os, sys
capture = os.environ["PI_ROUTE_CAPTURE"]
for line in sys.stdin:
    command = json.loads(line)["type"]
    if command == "prompt":
        with open(capture, "w", encoding="utf-8") as handle:
            json.dump({
                "provider": os.environ.get("NEWSROOM_ACTIVE_PROVIDER"),
                "dragoncode_key_present": bool(os.environ.get("DRAGONCODE_API_KEY")),
            }, handle)
        print(json.dumps({"type":"response","command":"prompt","success":True}), flush=True)
        print(json.dumps({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}), flush=True)
        print(json.dumps({"type":"agent_settled"}), flush=True)
    elif command == "get_last_assistant_text":
        print(json.dumps({"type":"response","command":command,"success":True,"data":{"text":"ok"}}), flush=True)
    elif command == "get_session_stats":
        print(json.dumps({"type":"response","command":command,"success":True,"data":{"tokens":{}}}), flush=True)
'''


def main() -> int:
    if not BINARY.is_file():
        raise SystemExit("build target/release/news before running this check")
    with tempfile.TemporaryDirectory(prefix="news-pi-route-") as directory:
        directory = Path(directory)
        mock = directory / "pi_mock.py"
        capture = directory / "capture.json"
        mock.write_text(MOCK, encoding="utf-8")
        mock.chmod(0o755)
        env = os.environ.copy()
        env.update(
            {
                "NEWSROOM_PI_PROVIDER": "openai",
                "NEWSROOM_PI_MODEL": "claude-sonnet-4-6",
                "OPENAI_BASE_URL": "https://dragoncode.codes",
                "OPENAI_API_KEY": FIXTURE_KEY,
                "PI_ROUTE_CAPTURE": str(capture),
                "NEWSROOM_RPC_STARTUP_MS": "3000",
                "NEWSROOM_RPC_IDLE_MS": "3000",
                "NEWSROOM_RPC_FINISH_MS": "3000",
                "NEWSROOM_RPC_TOTAL_MS": "10000",
            }
        )
        env.pop("DRAGONCODE_API_KEY", None)
        result = subprocess.run(
            [str(BINARY), "ask", "--pi-bin", str(mock), "route alias"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, result.stderr + result.stdout
        observed = json.loads(capture.read_text(encoding="utf-8"))
        assert observed == {"provider": "dragoncode", "dragoncode_key_present": True}
        assert FIXTURE_KEY not in result.stdout + result.stderr
    print("Pi DragonCode route alias: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
