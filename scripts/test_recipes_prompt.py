#!/usr/bin/env python3
"""NEWSROOM_SPEED_RECIPES: off leaves the prompt and the manifest as they are; on appends at most one
recipe, picked from the table shape only, with or without the data profile. Offline: dry-run and the mock."""
import hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path
from tmp_helper import make_test_tmp

ROOT = Path(__file__).resolve().parents[1]
BIN = os.environ.get("NEWS_BIN") or (sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "target/release/news"))
if not Path(BIN).exists():
    subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=ROOT, check=True)
MOCK = str(ROOT / "scripts/perf_mock_pi.py")
HEAD = "Recipe for this data shape"
PROFILE = "Program-measured data profile"
LINE = "Entity,Code,Year,Rate\n" + "".join(f"China,CHN,{y},{y - 1900}.5\n" for y in range(1960, 1990))
EDGES = "source,target,value\nA,B,3\nA,C,2\nB,D,3\nC,D,2\n"
PLAIN = "name,score\nx,1.5\ny,2.5\n"
TOPIC = "chart this data"
tmp = Path(make_test_tmp('recipes-prompt-'))
files = {}
for name, text in (("line", LINE), ("edges", EDGES), ("plain", PLAIN)):
    files[name] = tmp / f"{name}.csv"
    files[name].write_text(text)

def env(**extra):
    base = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_SPEED_")}
    base["NEWSROOM_AGENT"] = "pi"
    base["HOME"] = str(tmp)  # no user config is read
    base.update(extra)
    return base

def dry(data, **extra):
    args = [BIN, "investigate", "--dry-run"]
    for d in data:
        args += ["--data", str(files[d])]
    out = subprocess.run(args + [TOPIC], env=env(**extra), capture_output=True, check=True)
    return out.stdout.decode()

ON = {"NEWSROOM_SPEED_RECIPES": "1"}
for data in (["line"], ["edges"], ["plain"], ["line", "edges"], []):
    base = dry(data)
    assert HEAD not in base and PROFILE not in base
    for off in ("0", "true", "1 ", ""):
        assert dry(data, NEWSROOM_SPEED_RECIPES=off) == base, (data, off)  # off: identical bytes, no recipe text
assert "Recipe for" not in dry(["line"], NEWSROOM_SPEED_DATA_PROFILE="1")

# On, no match or ambiguous: the prompt is the off prompt, byte for byte.
for data in (["plain"], ["line", "edges"], []):
    assert dry(data, **ON) == dry(data), data
# On, one match: only the recipe text is appended (the profile switch stays off).
for data, marker in ((["line"], "reader_task 填 change"), (["edges"], "只写终点不会亮")):
    base, on = dry(data), dry(data, **ON)
    assert on.startswith(base) and on[len(base):].startswith("\n" + HEAD), data
    assert marker in on[len(base):] and PROFILE not in on, data
    assert marker not in base
# With the profile switch on too, the profile comes first and the recipe is last.
both = dry(["line"], NEWSROOM_SPEED_DATA_PROFILE="1", NEWSROOM_SPEED_RECIPES="1")
assert both.index(PROFILE) < both.index(HEAD) and both.rstrip().endswith("配方不得授予核实状态。"), both[-300:]
# Two matches of the same recipe still load once.
assert dry(["line", "line"], **ON).count(HEAD) == 1

# Real (mock) run: the manifest records the recipe name and the sha256 of the text sent; off has no such key.
def manifest(**extra):
    out = tmp / ("run-" + hashlib.sha1(json.dumps(extra, sort_keys=True).encode()).hexdigest()[:8])
    subprocess.run([BIN, "investigate", "--pi-bin", MOCK, "--out", str(out), "--data", str(files["line"]), TOPIC],
                   env=env(PERF_MOCK_MODE="normal", NEWSROOM_RPC_TOTAL_MS="5000", **extra), capture_output=True, timeout=60)
    run = next(p for p in out.iterdir() if p.is_dir())
    return json.loads((run / "story.json").read_text()), (run / "prompt.md").read_text()
off_manifest, off_prompt = manifest()
on_manifest, on_prompt = manifest(**ON)
assert "recipe" not in off_manifest and HEAD not in off_prompt
assert set(on_manifest) - set(off_manifest) == {"recipe"} and set(off_manifest) <= set(on_manifest)
assert on_manifest["recipe"]["name"] == "line-over-years"
sent = on_prompt[len(off_prompt):]
assert on_prompt.startswith(off_prompt) and sent.startswith("\n" + HEAD)
assert on_manifest["recipe"]["sha256"] == hashlib.sha256(sent.encode()).hexdigest()
print("PASS recipes: off identical, on picks by shape, profile switch independent, manifest records name and sha")
