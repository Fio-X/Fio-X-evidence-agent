#!/usr/bin/env python3
"""`news interactive` under all five group switches (enforcing, not observing): the stand-in session of test_interactive_cli.py
(local mock agent, no provider) starts, imports data, answers, follows up and stops the visual gate with 0 refusals.

Needs: the hand-off table lists interactive for run_bundle_writer, materialize_writer, knowledge_writer (data import) and
verification_writer, each as a measured pair (K389b: seen in a HANDOFF+OBSERVE+ENFORCE+TOOLS stand-in session).
usage: test_interactive_groups_on.py [news-binary]
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
binary = Path(sys.argv[1] if len(sys.argv) > 1 else root / "target/release/news").resolve()
transcript = Path(tempfile.mkdtemp(prefix="interactive-groups-on-")) / "session.txt"
env = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_GROUP_")}
for name in ("HANDOFF", "ENFORCE", "TOOLS", "CALL_REPORT", "CALL_CHECK"):
    env[f"NEWSROOM_GROUP_{name}"] = "1"
env["INTERACTIVE_TRANSCRIPT"] = str(transcript)
done = subprocess.run(
    [sys.executable, str(root / "scripts/test_interactive_cli.py"), str(binary)],
    cwd=root, env=env, capture_output=True, text=True, timeout=300,
)
text = done.stdout + done.stderr
session = transcript.read_text(encoding="utf-8") if transcript.exists() else ""
refused = [line for line in session.splitlines() if "may not" in line or "could not run" in line]
assert not refused, f"{len(refused)} refusal line(s) in the session: {refused[:3]}"
assert "VERIFIED" in session, "the session never reached its verification line"
assert "may not" not in text, f"a write was refused under the five switches: {text[-1500:]}"
assert done.returncode == 0, f"interactive session failed under the five switches (rc={done.returncode}): {text[-1500:]}"
assert "interactive CLI: PASS" in done.stdout, done.stdout[-500:]
print("interactive under five-on: PASS (0 refusals)")
