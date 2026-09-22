#!/usr/bin/env python3
"""Build the deterministic, runtime-embedded newsroom visual-skill bundle.

Normal skills contribute their frontmatter and method body. The pinned
Lieflat skill contributes the complete upstream tree, including binary
previews and templates, as deterministic gzip/base64 payloads. The Rust
runtime embeds the generated module, so a released binary can materialize the
same skill without consulting the checkout, a user's home directory, or the
network.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
LIEFLAT = SKILLS / "lieflat-charts"
UPSTREAM_PATH = LIEFLAT / "UPSTREAM.json"
OUT = ROOT / "runtime" / "pi" / "visual_skill_bundle.mjs"
BUNDLED_INDEX_OUT = ROOT / "config" / "bundled-skills.json"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def parse_skill(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not match:
        raise SystemExit(f"invalid skill frontmatter: {path}")
    frontmatter = match.group(1)
    body = match.group(2).strip()
    name = re.search(r"^name:\s*(.+)$", frontmatter, re.M)
    description = re.search(r"^description:\s*(.+)$", frontmatter, re.M)
    if not name or not description:
        raise SystemExit(f"missing skill name/description: {path}")
    return {
        "name": name.group(1).strip(),
        "description": description.group(1).strip(),
        "body": body,
        "sha256": sha256_bytes(text.encode("utf-8")),
    }


def vendor_files() -> list[Path]:
    if not LIEFLAT.is_dir():
        raise SystemExit(f"vendored Lieflat directory is missing: {LIEFLAT}")
    paths: list[Path] = []
    forbidden_parts = {".git", "__pycache__", ".cache", "node_modules", "tmp", "temp"}
    for path in sorted(LIEFLAT.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(LIEFLAT)
        if forbidden_parts.intersection(relative.parts) or path.name in {".DS_Store"} or path.suffix in {".pyc", ".pyo", ".swp", ".tmp"}:
            raise SystemExit(f"forbidden cache/git file in vendored skill: {path}")
        paths.append(path)
    return paths


def tree_hash(entries: list[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    for entry in entries:
        digest.update(str(entry["path"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(entry["sha256"]).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(entry["bytes"]).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def validate_upstream(entries: list[dict[str, object]]) -> dict[str, object]:
    if not UPSTREAM_PATH.is_file():
        raise SystemExit("skills/lieflat-charts/UPSTREAM.json is missing")
    try:
        metadata = json.loads(UPSTREAM_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid Lieflat UPSTREAM.json: {error}") from error
    expected = {
        "name": "lieflat-charts",
        "repository": "https://github.com/larashero3-dotcom/lieflat-charts",
        "commit": "eace082a317b696c5570c25826a53a7fa113e984",
        "license": "PolyForm Noncommercial License 1.0.0",
        "usage": "personal-noncommercial",
        "vendored": True,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise SystemExit(f"Lieflat upstream metadata mismatch for {key}: {metadata.get(key)!r}")
    if not (LIEFLAT / "LICENSE").is_file():
        raise SystemExit("vendored Lieflat LICENSE is missing")
    if not (LIEFLAT / "THIRD_PARTY_NOTICES.md").is_file():
        raise SystemExit("vendored Lieflat THIRD_PARTY_NOTICES.md is missing")
    actual_tree = tree_hash(entries)
    if metadata.get("source_tree_sha256") != actual_tree:
        raise SystemExit(
            "Lieflat source drift detected: "
            f"expected {metadata.get('source_tree_sha256')}, got {actual_tree}"
        )
    if metadata.get("source_file_count") != len(entries):
        raise SystemExit(
            f"Lieflat source file count drift: expected {metadata.get('source_file_count')}, got {len(entries)}"
        )
    return metadata


def gzip_base64(value: bytes) -> str:
    # Fixed compressor settings keep regenerated bundles byte-for-byte stable.
    compressor = zlib.compressobj(level=9, method=zlib.DEFLATED, wbits=31)
    return base64.b64encode(compressor.compress(value) + compressor.flush()).decode("ascii")


def build_lieflat_payload(metadata: dict[str, object]) -> dict[str, object]:
    entries: list[dict[str, object]] = []
    for path in vendor_files():
        value = path.read_bytes()
        entries.append(
            {
                "path": path.relative_to(LIEFLAT).as_posix(),
                "bytes": len(value),
                "sha256": sha256_bytes(value),
                "encoding": "gzip+base64",
                "data": gzip_base64(value),
            }
        )
    manifest_entries = [{key: entry[key] for key in ("path", "bytes", "sha256")} for entry in entries]
    return {
        "name": "lieflat-charts",
        "repository": metadata["repository"],
        "commit": metadata["commit"],
        "license": metadata["license"],
        "usage": metadata["usage"],
        "vendored": metadata["vendored"],
        "source_tree_sha256": metadata["source_tree_sha256"],
        "source_file_count": metadata["source_file_count"],
        "files": entries,
        "aggregate_sha256": sha256_bytes(
            json.dumps(manifest_entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ),
    }


def main() -> int:
    upstream_entries: list[dict[str, object]] = []
    for path in vendor_files():
        value = path.read_bytes()
        upstream_entries.append(
            {
                "path": path.relative_to(LIEFLAT).as_posix(),
                "bytes": len(value),
                "sha256": sha256_bytes(value),
            }
        )
    # UPSTREAM.json is Fio-X metadata and is deliberately not part of the
    # fixed upstream tree hash. It is included in the runtime payload below.
    upstream_entries_for_lock = [
        entry for entry in upstream_entries if entry["path"] != "UPSTREAM.json"
    ]
    metadata = validate_upstream(upstream_entries_for_lock)

    skills: dict[str, dict[str, object]] = {}
    for path in sorted(SKILLS.glob("*/SKILL.md")):
        skill = parse_skill(path)
        name = str(skill["name"])
        if name in skills:
            raise SystemExit(f"duplicate skill name: {name}")
        skills[name] = skill

    lieflat = build_lieflat_payload(metadata)
    lieflat_file_names = {str(entry["path"]) for entry in lieflat["files"]}  # type: ignore[index]
    index: dict[str, dict[str, object]] = {}
    for skill in skills.values():
        name = str(skill["name"])
        item: dict[str, object] = {
            "name": name,
            "description": skill["description"],
            "sha256": skill["sha256"],
        }
        if name == "lieflat-charts":
            item.update(
                {
                    "catalog_available": "catalog.md" in lieflat_file_names,
                    "report_catalog_available": "report-catalog.md" in lieflat_file_names,
                    "templates_available": any(name.startswith("templates/") for name in lieflat_file_names),
                    "upstream_commit": metadata["commit"],
                    "license": metadata["license"],
                }
            )
        index[name] = item

    payload = {"skills": skills, "skill_index": index, "lieflat": lieflat}
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    output = (
        "// Generated by scripts/build_visual_skill_bundle.py. Do not edit by hand.\n"
        "export const VISUAL_SKILL_BUNDLE = Object.freeze("
        + serialized
        + ");\n"
        "export const VISUAL_SKILLS = Object.freeze(VISUAL_SKILL_BUNDLE.skills);\n"
        "export const VISUAL_SKILL_INDEX = Object.freeze(VISUAL_SKILL_BUNDLE.skill_index);\n"
        "export const LIEFLAT_BUNDLE = Object.freeze(VISUAL_SKILL_BUNDLE.lieflat);\n"
    )
    OUT.write_text(output, encoding="utf-8")
    BUNDLED_INDEX_OUT.write_text(
        json.dumps(
            {
                "schema_version": "1.0.0",
                "bundle_module": "runtime/pi/visual_skill_bundle.mjs",
                "skills": index,
                "lieflat": {
                    "name": lieflat["name"],
                    "repository": lieflat["repository"],
                    "commit": lieflat["commit"],
                    "license": lieflat["license"],
                    "usage": lieflat["usage"],
                    "vendored": lieflat["vendored"],
                    "source_tree_sha256": lieflat["source_tree_sha256"],
                    "source_file_count": lieflat["source_file_count"],
                    "aggregate_sha256": lieflat["aggregate_sha256"],
                    "files": [
                        {key: entry[key] for key in ("path", "bytes", "sha256")}
                        for entry in lieflat["files"]  # type: ignore[index]
                    ],
                },
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"{OUT} ({len(skills)} skills, {len(lieflat['files'])} Lieflat files, aggregate {lieflat['aggregate_sha256']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
