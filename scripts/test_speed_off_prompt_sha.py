#!/usr/bin/env python3
"""With every NEWSROOM_SPEED_* switch unset (or set to anything but exactly "1"), the dry-run
investigation prompt must be byte-identical to the 1531ab5 baseline recorded in the fixture."""
import hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "scripts/fixtures/speed-off/dry-run-prompt-sha.json").read_text())
SWITCHES = ["NEWSROOM_SPEED_PLAN_PROGRESS", "NEWSROOM_SPEED_DATA_PROFILE", "NEWSROOM_SPEED_COMPOSE_ANSWER", "NEWSROOM_SPEED_PARALLEL_HINTS"]
binary = os.environ.get("NEWS_BIN") or str(ROOT / "target/release/news")
if not Path(binary).exists():
    subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=ROOT, check=True)

def prompt_sha(topic, extra):
    home = tempfile.mkdtemp()  # no user config is read
    env = {"HOME": home, "PATH": os.environ["PATH"], **extra}
    out = subprocess.run([binary, "investigate", "--dry-run", topic], env=env, capture_output=True, check=True).stdout
    return hashlib.sha256(out).hexdigest()

failures = []
variants = [("all unset", {})]
for name in SWITCHES:
    for value in ("0", "true", "1 ", ""):
        if name == "NEWSROOM_SPEED_PARALLEL_HINTS" and value == "true":
            continue  # already accepted as "on" at the 1531ab5 baseline (pi.rs env_switch), not part of this change
        variants.append((f"{name}={value!r}", {name: value}))
for label, extra in variants:
    for topic, want in FIXTURE["topics"].items():
        got = prompt_sha(topic, extra)
        if got != want:
            failures.append(f"{label} / {topic}: {got[:12]} != {want[:12]}")
if failures:
    print("FAIL\n" + "\n".join(failures)); sys.exit(1)
print(f"PASS speed-off dry-run prompt equals the 1531ab5 baseline ({len(variants)} switch variants x {len(FIXTURE['topics'])} topics)")
