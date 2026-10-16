#!/usr/bin/env python3
"""A follow-up question on a result made before the review split.

With the split on (the default; only NEWSROOM_REVIEW_SPLIT=0 turns it off), `news continue` on a run folder whose visualization or infographic
manifest still carries a draw-step render-QA record (`render_qa_ref` or `render_qa`, the layout verification fails with the split on) prints one
line and exits 3 before any child starts and before anything is written to the run folder. With the switch exactly "0", a split-layout run, or
a manifest verification would skip for another reason, the follow-up starts as before. No provider, no network: the Pi binary does not exist, so
a refusal that did not happen shows as "continuing:" and a start-up failure, and 0 model requests are possible by construction.
"""
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("NEWS_BIN") or ROOT / "target" / "debug" / "news")
LINE = "This result was made before the review split, so follow-ups of it are refused; start a new run instead"

if not BINARY.is_file():
    raise SystemExit("build target/debug/news before running this check")


def run_folder(base: Path, name: str, kind: str, layout: str) -> Path:
    """kind: viz | info | viz-plain (no plan_ref: verification skips it for another reason). layout: old | split."""
    run = base / name
    (run / "agent-session").mkdir(parents=True)
    (run / "agent-session" / "session.jsonl").write_text("")
    (run / "story.json").write_text(json.dumps({"id": name, "topic": "pre-split topic"}))
    manifest: dict = {"variants": {"desktop": "visualizations/a.svg"}}
    if kind != "viz-plain":
        manifest["plan_ref"] = "visualizations/plans/p.json"
    if kind == "info":
        manifest.update({"schema_version": SCHEMA, "lint_ref": "infographics/lints/l.json"})
    if layout == "old":
        manifest["render_qa_ref"] = "visualizations/qa/q.json"
        manifest["render_qa"] = {"passed": True, "failure_count": 0}
    directory = run / ("infographics" if kind == "info" else "visualizations")
    directory.mkdir()
    (directory / "m.json").write_text(json.dumps(manifest, indent=2))
    return run


def schema_version() -> str:
    # the first value of INFOGRAPHIC_SCHEMA_VERSIONS in src/verify.rs
    text = (ROOT / "src" / "verify.rs").read_text()
    start = text.index("INFOGRAPHIC_SCHEMA_VERSIONS")
    return text[text.index('"', start) + 1:].split('"', 1)[0]


SCHEMA = schema_version()


def snapshot(run: Path):
    return sorted((str(p.relative_to(run)), hashlib.sha256(p.read_bytes()).hexdigest()) for p in run.rglob("*") if p.is_file())


def follow_up(run: Path, switch):
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_")}
    env["NEWSROOM_AGENT"] = "rust"
    env["NEWSROOM_GROUP_HANDOFF"] = "1"  # the Rust agent does not start without the hand-off (K373)
    if switch is not None:
        env["NEWSROOM_REVIEW_SPLIT"] = switch
    return subprocess.run(
        [str(BINARY), "continue", "--pi-bin", "/nonexistent/pi", str(run), "and then?"],
        env=env, capture_output=True, text=True, timeout=60, cwd=run.parent)


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    # refused with the switch unset (and with "1"): old layout on a visualization and on an infographic manifest
    for name, kind, switch in (("viz-unset", "viz", None), ("info-unset", "info", None), ("viz-one", "viz", "1"), ("viz-other", "viz", "true")):
        run = run_folder(base, name, kind, "old")
        before = snapshot(run)
        refused = follow_up(run, switch)
        assert refused.returncode == 3, (name, refused.returncode, refused.stderr[-1500:])
        assert [l for l in refused.stderr.splitlines() if LINE in l] == [LINE], (name, refused.stderr[-1500:])
        assert "continuing:" not in refused.stderr and refused.stdout == "", (name, refused.stdout, refused.stderr[-1500:])
        assert snapshot(run) == before, f"{name}: the run folder changed"

    # not refused: exactly "0" (the old layout is then the right one), a split-layout run, a manifest verification skips for another reason
    for name, kind, layout, switch in (("viz-zero", "viz", "old", "0"), ("info-zero", "info", "old", "0"), ("viz-split", "viz", "split", None), ("info-split", "info", "split", None), ("plain-old", "viz-plain", "old", None)):
        other = follow_up(run_folder(base, name, kind, layout), switch)
        assert LINE not in other.stderr, (name, other.stderr[-1500:])
        assert "continuing: " in other.stderr, (name, other.stderr[-1500:])

print("ok: pre-split follow-up refusal")
