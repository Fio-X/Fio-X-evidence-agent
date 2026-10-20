#!/usr/bin/env python3
"""With the five default-off NEWSROOM_SPEED_* switches unset (or set to anything but exactly "1") and NEWSROOM_SPEED_AUTO_CHECKS=0,
the dry-run investigation prompt must be byte-identical to the 1531ab5 baseline recorded in the fixture.
NEWSROOM_SPEED_AUTO_CHECKS is on unless exactly "0", so its default adds one paragraph: that case is checked on its own below
(default minus the paragraph equals the "0" output; the paragraph's sha256 is pinned by a second fixture key)."""
import hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path
from tmp_helper import make_test_tmp

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "scripts/fixtures/speed-off/dry-run-prompt-sha.json").read_text())
SWITCHES = ["NEWSROOM_SPEED_PLAN_PROGRESS", "NEWSROOM_SPEED_DATA_PROFILE", "NEWSROOM_SPEED_RECIPES", "NEWSROOM_SPEED_COMPOSE_ANSWER", "NEWSROOM_SPEED_PARALLEL_HINTS"]
binary = os.environ.get("NEWS_BIN") or str(ROOT / "target/release/news")
if not Path(binary).exists():
    subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=ROOT, check=True)

AUTO_CHECKS = "NEWSROOM_SPEED_AUTO_CHECKS"

def prompt_bytes(topic, extra):
    home = make_test_tmp('speed-off-sha-')  # no user config is read
    env = {"HOME": home, "PATH": os.environ["PATH"], **extra}
    return subprocess.run([binary, "investigate", "--dry-run", topic], env=env, capture_output=True, check=True).stdout

def prompt_sha(topic, extra):
    return hashlib.sha256(prompt_bytes(topic, {AUTO_CHECKS: "0", **extra})).hexdigest()

failures = []
variants = [("five switches unset, AUTO_CHECKS=0", {})]
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
# AUTO_CHECKS is on unless the value is exactly "0" (pi.rs on_unless_zero): every other value, " 0" and "00" included, inserts the
# paragraph. Located by its heading, not by common prefix or suffix (visual topics end with text that starts with a blank line).
MARKER = b"\n\nAutomatic checks:"
DEFAULT_VALUES = [("unset", None), ("empty", ""), ("true", "true"), ("' 0'", " 0"), ("'00'", "00"), ("false", "false"), ("off", "off"), ("no", "no")]
for topic in FIXTURE["topics"]:
    off = prompt_bytes(topic, {AUTO_CHECKS: "0"})
    for label, value in DEFAULT_VALUES:
        default = prompt_bytes(topic, {} if value is None else {AUTO_CHECKS: value})
        what = f"AUTO_CHECKS {label} / {topic}"
        if default == off or default.count(MARKER) != 1:
            failures.append(f"{what}: the default output does not carry the one automatic-checks paragraph"); continue
        i, k = default.index(MARKER), len(default) - len(off)
        if k <= 0 or default[:i] + default[i + k:] != off:
            failures.append(f"{what}: default minus the paragraph is not the AUTO_CHECKS=0 output"); continue
        if hashlib.sha256(default[i:i + k]).hexdigest() != FIXTURE["auto_checks_paragraph_sha256"]:
            failures.append(f"{what}: the inserted paragraph differs from the pinned sha256")
if failures:
    print("FAIL\n" + "\n".join(failures)); sys.exit(1)
print(f"PASS speed-off dry-run prompt equals the 1531ab5 baseline with AUTO_CHECKS=0 ({len(variants)} switch variants x {len(FIXTURE['topics'])} topics); AUTO_CHECKS default adds exactly the pinned paragraph ({len(DEFAULT_VALUES)} values)")
