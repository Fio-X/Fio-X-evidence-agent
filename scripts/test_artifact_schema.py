#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from jsonschema import Draft202012Validator
from selftest_evaluator import build_valid

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "schemas" / "news-artifact.schema.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(SCHEMA)
validator = Draft202012Validator(SCHEMA)

with tempfile.TemporaryDirectory(prefix="newsroom-artifact-schema-") as tmp:
    root = Path(tmp)
    build_valid(root)
    story = json.loads((root / "story.json").read_text(encoding="utf-8"))
    errors = sorted(validator.iter_errors(story), key=lambda e: list(e.path))
    if errors:
        raise SystemExit("valid story failed schema validation: " + " | ".join(error.message for error in errors))

    invalid = json.loads(json.dumps(story))
    invalid["schema_version"] = "0.5.0"
    if not list(validator.iter_errors(invalid)):
        raise SystemExit("artifact schema failed to reject stale schema_version")

    # The backend and its session folder go together: a record that names one backend and the other's folder is rejected.
    for backend, folder in (("pi-rpc", "agent-session/"), ("rust-agent", "session/"), ("rust-agent", "")):
        mismatched = json.loads(json.dumps(story))
        mismatched["runtime"]["backend"] = backend
        mismatched["runtime"]["session_dir"] = folder
        if not list(validator.iter_errors(mismatched)):
            raise SystemExit(f"artifact schema accepted backend {backend!r} with session_dir {folder!r}")
    for backend, folder in (("pi-rpc", "session/"), ("rust-agent", "agent-session/")):
        matched = json.loads(json.dumps(story))
        matched["runtime"]["backend"] = backend
        matched["runtime"]["session_dir"] = folder
        errors = list(validator.iter_errors(matched))
        if errors:
            raise SystemExit(f"artifact schema rejected backend {backend!r} with session_dir {folder!r}: {errors[0].message}")
    unknown = json.loads(json.dumps(story))
    unknown["runtime"]["backend"] = "other"
    if not list(validator.iter_errors(unknown)):
        raise SystemExit("artifact schema accepted an unknown backend")

# What the program really writes must pass the same schema. Needs a built binary (CI builds target/debug/news before this step):
# one `news investigate` against a tiny local RPC peer (Pi path) and one against the stand-in relay (Rust path).
# Without a binary the run is skipped, unless NEWSROOM_REQUIRE_NO_SKIP=1 (CI sets it), which makes a missing binary fail.
MOCK_PI = r'''#!/usr/bin/env python3
import json, sys
def emit(**v): print(json.dumps(v), flush=True)
for line in sys.stdin:
    kind = json.loads(line)["type"]
    if kind == "prompt":
        emit(type="response", command="prompt", success=True)
        emit(type="message_update", assistantMessageEvent={"type": "text_delta", "delta": "mock answer"})
        emit(type="agent_settled")
    elif kind == "get_last_assistant_text":
        emit(type="response", command=kind, success=True, data={"text": "mock answer"})
    elif kind == "get_session_stats":
        emit(type="response", command=kind, success=True, data={"tokens": {"input": 0, "output": 0}})
'''


def written_story(run_dir: Path, backend: str, session_dir: str) -> dict:
    story = json.loads((run_dir / "story.json").read_text(encoding="utf-8"))
    errors = sorted(validator.iter_errors(story), key=lambda e: list(e.path))
    if errors:
        raise SystemExit(f"{backend} run: story.json failed schema validation: " + " | ".join(error.message for error in errors))
    if story["runtime"]["backend"] != backend or story["runtime"]["session_dir"] != session_dir:
        raise SystemExit(f"{backend} run: story.json says {story['runtime']}")
    return story


def run_guard(binary: Path) -> None:
    clean = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_") and not k.endswith(("_API_KEY", "_BASE_URL", "_TOKEN"))}
    with tempfile.TemporaryDirectory(prefix="newsroom-artifact-guard-") as tmp:
        work = Path(tmp)
        mock = work / "mock_pi.py"
        mock.write_text(MOCK_PI, encoding="utf-8")
        mock.chmod(0o755)
        out = work / "pi-out"
        env = {**clean, "NEWSROOM_AGENT": "pi", "NEWSROOM_RPC_TOTAL_MS": "8000", "NEWSROOM_RPC_IDLE_MS": "5000", "NEWSROOM_RPC_FINISH_MS": "3000", "HOME": str(work)}
        subprocess.run([str(binary), "investigate", "--pi-bin", str(mock), "--out", str(out), "schema guard question"], env=env, capture_output=True, timeout=120)
        pi_runs = [p for p in out.glob("*") if (p / "story.json").is_file()]
        if len(pi_runs) != 1:
            raise SystemExit("the Pi mock run did not leave one story.json")
        written_story(pi_runs[0], "pi-rpc", "session/")
        smoke = work / "rust"
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("smoke_rust_agent.py")), str(smoke)], env={**clean, "NEWS_BIN": str(binary)}, capture_output=True, text=True, timeout=600)
        rust_runs = [p for p in (smoke / "out").glob("*") if (p / "story.json").is_file()] if (smoke / "out").is_dir() else []
        if len(rust_runs) != 1:
            raise SystemExit("the stand-in run did not leave one story.json\n" + result.stdout[-600:])
        story = written_story(rust_runs[0], "rust-agent", "agent-session/")
        if story["autonomy"]["persistent_session"] is not ((rust_runs[0] / "agent-session" / "session.jsonl").is_file() and (rust_runs[0] / "agent-session" / "session.jsonl").stat().st_size > 0):
            raise SystemExit("persistent_session does not follow agent-session/session.jsonl")


candidate = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ.get("NEWS_BIN", ROOT / "target" / "debug" / "news"))
if candidate.is_file():
    run_guard(candidate.resolve())
    print("real runs (Pi mock, Rust stand-in): PASS")
elif os.environ.get("NEWSROOM_REQUIRE_NO_SKIP") == "1":
    raise SystemExit(f"no news binary at {candidate}; the real-run guard may not skip")
else:
    print(f"real runs: SKIP (no binary at {candidate})")

print("news artifact schema: PASS")
print("draft: 2020-12")
print("valid synthetic story: PASS")
