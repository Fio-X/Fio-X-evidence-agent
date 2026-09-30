#!/usr/bin/env python3
"""Confirms scripts/verify_artifact.py's verify_infographic_source_quotes
independently rechecks a text module's source_quote against the saved
source's own bytes (never trusting the plan or lint), and confirms the
rendered desktop SVG visibly carries the page number and (on a zh page) the
译述 translation label. Mirrors src/verify.rs's source_quote_* tests so both
independent verifiers are exercised the same way.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

from verify_artifact import Report, canonical_json, verify_infographic_source_quotes

QUOTE = "fuelwood and charcoal as renewable energy"
TRANSLATION = "将燃料木材和木炭计为可再生能源"


def write_source(root: Path) -> str:
    # A hyphenated line-break on page 2 ("fuel-\nwood") so the
    # hyphenation-join normalization is actually exercised, exactly like the
    # Rust fixture (src/verify.rs's write_source_quote_fixture).
    text = (
        "[page 1]\nALPHA introductory material spans several lines of running text.\n\n"
        "[page 2]\nThis indicator counts fuel-\nwood and charcoal as renewable energy."
    )
    payload = {
        "content_type": "application/pdf",
        "final_url": "https://example.org/metadata.pdf",
        "status": 200,
        "text": text,
        "truncated": False,
    }
    content_hash = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
    record = {
        "schema_version": "0.7.0",
        "final_url": payload["final_url"],
        "status": payload["status"],
        "content_type": payload["content_type"],
        "truncated": payload["truncated"],
        "content_hash": content_hash,
        "trust": "untrusted_external_content",
        "text": text,
    }
    (root / "sources").mkdir(parents=True, exist_ok=True)
    (root / "sources" / f"{content_hash}.json").write_text(json.dumps(record), encoding="utf-8")
    return f"sources/{content_hash}.json"


def build_plan(source_ref: str, page: int, quote: str, translation: str | None, body: str | None = "A scope note from the source metadata.") -> dict:
    module = {
        "id": "definition-note",
        "type": "text",
        "source_quote": {"source_ref": source_ref, "page": page, "quote": quote},
    }
    if body is not None:
        module["body"] = body
    if translation is not None:
        module["source_quote"]["translation"] = translation
    return {"language": "zh", "modules": [module]}


def desktop_svg(page: int, render_translation_label: bool) -> str:
    label = f"资料来源与方法 {page}"
    if render_translation_label:
        label += " 译述：内容"
    return f"<svg xmlns='http://www.w3.org/2000/svg'><text>{label}</text></svg>"


def run_case(name: str, source_ref_override=None, page=2, quote=QUOTE, translation=TRANSLATION, render_translation_label=True, tamper=False, body="A scope note from the source metadata."):
    with tempfile.TemporaryDirectory(prefix="newsroom-source-quote-") as tmp:
        root = Path(tmp)
        source_ref = write_source(root)
        if tamper:
            record = json.loads((root / source_ref).read_text(encoding="utf-8"))
            record["text"] = record["text"].replace("charcoal as renewable energy", "charcoal as fossil energy")
            (root / source_ref).write_text(json.dumps(record), encoding="utf-8")
        used_ref = source_ref_override if source_ref_override is not None else source_ref
        plan = build_plan(used_ref, page, quote, translation, body=body)
        svg_path = root / "infographics" / "page.svg"
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        svg_path.write_text(desktop_svg(page, render_translation_label), encoding="utf-8")
        report = Report()
        verify_infographic_source_quotes(root, "infographics/page.json", plan, "zh", "infographics/page.svg", report)
        print(f"{name}: errors={report.errors}")
        return report


def check_positive_verbatim_quote_passes():
    report = run_case("positive verbatim quote on correct page")
    assert not report.errors, report.errors


def check_non_verbatim_quote_fails():
    report = run_case("non-verbatim quote", quote="fuelwood and charcoal are the main renewable source")
    assert any("does not appear verbatim" in e for e in report.errors), report.errors


def check_wrong_page_fails():
    report = run_case("wrong page", page=1)
    assert any("does not appear verbatim on page 1" in e for e in report.errors), report.errors


def check_missing_translation_label_fails():
    report = run_case("missing 译述 label on render", render_translation_label=False)
    assert any("no 译述 label" in e for e in report.errors), report.errors


def check_tampered_source_after_planning_fails():
    report = run_case("source tampered after planning", tamper=True)
    assert any("content_hash mismatch" in e for e in report.errors), report.errors


def check_missing_source_file_fails():
    report = run_case("references a missing source", source_ref_override="sources/" + "0" * 64 + ".json")
    assert any("references missing source" in e for e in report.errors), report.errors


def check_body_with_a_digit_fails():
    # Body is bound to neither the source_quote nor a claim, so it must
    # never be able to read like a verified figure of its own.
    report = run_case("body with a digit", body="This note cites 3 sources.")
    assert any("source_quote body must not contain digits or a percent sign" in e for e in report.errors), report.errors


def check_body_over_60_chars_fails():
    report = run_case("body over 60 characters", body="x" * 61)
    assert any("source_quote body must be at most 60 characters" in e for e in report.errors), report.errors


def check_no_body_passes():
    # The quote block itself carries the content - body is optional next
    # to a source_quote, and omitting it entirely must still pass.
    report = run_case("no body at all", body=None)
    assert not report.errors, report.errors


def main() -> int:
    check_positive_verbatim_quote_passes()
    check_non_verbatim_quote_fails()
    check_wrong_page_fails()
    check_missing_translation_label_fails()
    check_tampered_source_after_planning_fails()
    check_missing_source_file_fails()
    check_body_with_a_digit_fails()
    check_body_over_60_chars_fails()
    check_no_body_passes()
    print("infographic source_quote verifier: PASS (9 cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
