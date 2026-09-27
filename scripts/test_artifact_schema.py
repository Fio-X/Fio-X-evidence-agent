#!/usr/bin/env python3
from __future__ import annotations

import json
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

print("news artifact schema: PASS")
print("draft: 2020-12")
print("valid synthetic story: PASS")
