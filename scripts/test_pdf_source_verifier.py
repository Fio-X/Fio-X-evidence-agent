#!/usr/bin/env python3
"""Confirms scripts/verify_artifact.py's source-record checks accept a PDF
source produced by runtime/pi/pdf_extract.mjs's extraction path (both the
successful-extraction case and the honest "PDF text unavailable" cases), and
still reject a source whose text was edited after its content_hash was set.
Mirrors the build_valid()/verify() pattern in test_integrity_adversarial.py.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from verify_artifact import canonical_json, verify


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def write_pdf_source(root: Path, text: str, extraction: dict, truncated: bool) -> str:
    """Writes sources/<hash>.json using the same 5-field payload
    verify_artifact.py's verify() recomputes the hash over. extraction sits
    outside that payload, exactly like the pre-existing trust/schema_version
    fields do, so it never affects whether the hash check passes."""
    payload = {
        "content_type": "application/pdf",
        "final_url": "https://unstats.un.org/sdgs/metadata/files/Metadata-07-02-01.pdf",
        "status": 200,
        "text": text,
        "truncated": truncated,
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
        "extraction": extraction,
    }
    (root / "sources").mkdir(parents=True, exist_ok=True)
    write_json(root / "sources" / f"{content_hash}.json", record)
    return content_hash


def check_extracted_pdf_source_verifies() -> None:
    with tempfile.TemporaryDirectory(prefix="newsroom-pdf-source-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        write_pdf_source(
            root,
            "[page 1]\nALPHA LINE ONE\n\n[page 2]\nBRAVO LINE TWO",
            {"tool": "pdftotext", "version": "26.09.0", "pages": 2},
            False,
        )
        report = verify(root)
        assert report.passed, f"expected extracted-PDF source fixture to verify: {report.errors}"
    print("PASS: extracted PDF source with page markers verifies")


def check_pdftotext_not_found_source_verifies() -> None:
    with tempfile.TemporaryDirectory(prefix="newsroom-pdf-source-nf-") as tmp:
        root = Path(tmp)
        build_valid(root)
        write_pdf_source(
            root,
            "PDF text unavailable: pdftotext_not_found",
            {"tool": "pdftotext", "unavailable_reason": "pdftotext_not_found"},
            False,
        )
        report = verify(root)
        assert report.passed, f"an honest unavailability statement must still verify: {report.errors}"
    print("PASS: pdftotext_not_found source still verifies")


def check_pdf_truncated_source_verifies() -> None:
    with tempfile.TemporaryDirectory(prefix="newsroom-pdf-source-trunc-") as tmp:
        root = Path(tmp)
        build_valid(root)
        write_pdf_source(
            root,
            "PDF text unavailable: pdf_truncated",
            {"tool": "pdftotext", "unavailable_reason": "pdf_truncated"},
            True,
        )
        report = verify(root)
        assert report.passed, f"pdf_truncated source must still verify: {report.errors}"
    print("PASS: pdf_truncated source still verifies")


def check_tampered_pdf_source_fails() -> None:
    with tempfile.TemporaryDirectory(prefix="newsroom-pdf-source-tamper-") as tmp:
        root = Path(tmp)
        build_valid(root)
        content_hash = write_pdf_source(
            root,
            "[page 1]\nALPHA LINE ONE\n\n[page 2]\nBRAVO LINE TWO",
            {"tool": "pdftotext", "version": "26.09.0", "pages": 2},
            False,
        )
        source_path = root / "sources" / f"{content_hash}.json"
        record = json.loads(source_path.read_text(encoding="utf-8"))
        record["text"] = "[page 1]\nTAMPERED\n\n[page 2]\nBRAVO LINE TWO"
        write_json(source_path, record)
        report = verify(root)
        assert not report.passed, "tampering a PDF source's text after hashing must not verify"
        assert any("source content_hash mismatch" in e for e in report.errors), report.errors
    print("PASS: PDF source tampered after hashing fails as intended")


def main() -> int:
    check_extracted_pdf_source_verifies()
    check_pdftotext_not_found_source_verifies()
    check_pdf_truncated_source_verifies()
    check_tampered_pdf_source_fails()
    print("pdf source verifier: PASS (4 cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
