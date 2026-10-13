#!/usr/bin/env python3
"""K56: a source snapshot whose text was cut on an emoji. Cut by the runtime's
sliceWellFormed the record verifies; cut by plain slice (a lone high surrogate
in the file) the strict reader refuses it. Hashes were produced by Node's
sourceContentHash (see scripts/test_source_cut_wellformed.mjs, which pins the
same two values)."""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from verify_artifact import canonical_json, verify

HELPER_HASH = "97d11664003459e55307a9407490fd492853b246c7097eada313805388d10172"
PLAIN_HASH = "e3db4cd4bb38976feae3e84e03bb24e905a832167efe888eb1cfc6d3932bcb59"
URL = "https://example.org/emoji"


def write_snapshot(root: Path, content_hash: str, text: str) -> None:
    record = {
        "schema_version": "0.7.0",
        "final_url": URL,
        "status": 200,
        "content_type": "text/html",
        "truncated": True,
        "content_hash": content_hash,
        "trust": "untrusted_external_content",
        "text": text,
    }
    (root / "sources").mkdir(parents=True, exist_ok=True)
    # ensure_ascii writes the lone surrogate as the escape \ud83d, like JSON.stringify does.
    (root / "sources" / f"{content_hash}.json").write_text(json.dumps(record), encoding="utf-8")


def source_errors(text: str, content_hash: str) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="newsroom-source-cut-") as tmp:
        root = Path(tmp)
        build_valid(root)
        write_snapshot(root, content_hash, text)
        return [e for e in verify(root).errors if "source" in e]


def main() -> int:
    payload = {"content_type": "text/html", "final_url": URL, "status": 200, "text": "abc", "truncated": True}
    assert hashlib.sha256(canonical_json(payload).encode()).hexdigest() == HELPER_HASH, "Python hash must equal Node's"
    errors = source_errors("abc", HELPER_HASH)
    assert not errors, f"a snapshot cut by sliceWellFormed must verify: {errors}"
    errors = source_errors("abc\ud83d", PLAIN_HASH)
    assert errors, "a snapshot ending in a lone high surrogate must be refused"
    print(f"source cut snapshot: PASS (control refused: {errors[0][:80]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
