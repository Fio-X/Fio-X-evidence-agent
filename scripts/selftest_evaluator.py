#!/usr/bin/env python3
"""Regression-test evaluator integrity with valid and adversarial synthetic artifacts."""
from __future__ import annotations

import base64
import hashlib
import math
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVALUATOR = ROOT / "scripts" / "evaluate_artifact.py"
from verify_artifact import infographic_immutable_hash


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def canonical_rows(value):
    if value is None or isinstance(value, bool) or isinstance(value, str): return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int): return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")): return "null"
        if value.is_integer() and abs(value) <= 9_007_199_254_740_991: return str(int(value))
        magnitude = math.floor(abs(value) * 1_000_000 + 0.5)
        if math.isfinite(magnitude) and magnitude <= 9_007_199_254_740_991:
            sign = "-" if value < 0 else ""
            return json.dumps(f"{sign}{magnitude // 1_000_000}.{magnitude % 1_000_000:06d}", ensure_ascii=False, separators=(",", ":"))
        return json.dumps(f"{value:.6f}", ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list): return "[" + ",".join(canonical_rows(item) for item in value) + "]"
    if isinstance(value, dict): return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + canonical_rows(value[k]) for k in sorted(value)) + "}"
    return canonical(value)


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def build_valid(root: Path):
    for child in ("data", "sources", "computations", "visualizations/plans", "visualizations/lints", "visualizations/critics", "infographics/plans", "infographics/lints", "infographics/critics", "session"):
        (root / child).mkdir(parents=True, exist_ok=True)
    for name, text in {
        "prompt.md": "Investigate fixture\n",
        "answer.md": "Verified answer\n",
        "conversation.md": "User + assistant\n",
        "events.jsonl": "{}\n",
    }.items():
        write_text(root / name, text)
    write_json(root / "session-stats.json", {"userMessages": 2})
    write_text(root / "run-metrics.jsonl", json.dumps({"schema_version": "0.7.0", "operation": "investigate", "status": "draft", "duration_ms": 1200}) + "\n" + json.dumps({"schema_version": "0.7.0", "operation": "continue", "status": "draft", "duration_ms": 900}) + "\n")
    write_json(root / "plan.json", {"revision": 2, "steps": [{"id": "1", "action": "inspect", "status": "completed"}]})
    write_json(root / "tools.json", {
        "tools": {"artifact_inventory": 1, "duckdb_query": 2, "newsroom_viz_plan": 1, "newsroom_viz_lint": 1, "newsroom_viz_render": 1, "newsroom_viz_critic": 1, "newsroom_explainer_plan": 1, "newsroom_explainer_lint": 1, "newsroom_explainer_render": 1, "newsroom_explainer_critic": 1, "newsroom_illustration_plan": 1, "newsroom_illustration_lint": 1, "newsroom_illustration_generate": 1, "newsroom_illustration_critic": 1, "newsroom_infographic_plan": 1, "newsroom_infographic_lint": 2, "newsroom_infographic_render": 2, "newsroom_infographic_critic": 2, "newsroom_infographic_preview": 2, "newsroom_infographic_vision_critic": 2, "newsroom_infographic_revise": 1, "newsroom_competition_preflight": 1, "record_claim": 1, "fetch_url": 1},
        "failed_tool_calls": 1,
    })

    data = b"country,year,value\nA,2024,1\nB,2024,2\n"
    data_hash = sha_bytes(data)
    data_ref = f"data/{data_hash}.csv"
    write_text(root / data_ref, data.decode())
    write_json(root / f"{data_ref}.meta.json", {"schema_version": "0.7.0", "file": data_ref, "sha256": data_hash, "bytes": len(data)})

    source_payload = {"content_type": "text/plain", "final_url": "https://example.test/data", "status": 200, "text": "Fixture source", "truncated": False}
    source_hash = sha_bytes(canonical(source_payload).encode())
    source = {"schema_version": "0.7.0", **source_payload, "content_hash": source_hash, "trust": "untrusted_external_content"}
    source_ref = f"sources/{source_hash}.json"
    write_json(root / source_ref, source)

    rows = [{"country": "A", "value": 1}, {"country": "B", "value": 2}]
    result_hash = sha_bytes(canonical_rows(rows).encode())
    sql = "select country,value"
    fingerprints = sorted([f"data:{data_ref}:{data_hash}", f"source:{Path(source_ref).name}:{source_hash}"])
    input_hash = sha_bytes("\n".join(fingerprints).encode())
    comp_key = sha_bytes(f"{sql}\n{input_hash}\n{result_hash}".encode())
    comp_ref = f"computations/{comp_key}.json"
    write_json(root / comp_ref, {"schema_version": "0.7.0", "sql": sql, "input_snapshot_hash": input_hash, "input_fingerprints": fingerprints, "result_hash": result_hash, "rows": rows})

    claim_id = "claim-valid"
    write_text(root / "claims.jsonl", json.dumps({"claim_id": claim_id, "status": "verified", "source_refs": [source_ref, data_ref], "computation_refs": [comp_ref]}) + "\n")

    plan_ref = "visualizations/plans/chart.json"
    lint_ref = "visualizations/lints/chart.json"
    manifest_ref = "visualizations/chart.json"
    desktop_ref = "visualizations/chart.svg"
    mobile_ref = "visualizations/chart.mobile.svg"
    write_json(root / plan_ref, {"claim_id": claim_id, "chart_type": "horizontal_bar", "title": "Fixture", "sql": "select country,value"})
    write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": result_hash, "blockers": []})
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img"><title>Fixture chart</title><desc>Accessible fixture chart for integrity tests.</desc><rect width="640" height="400" fill="white"/><text x="20" y="40">Source: fixture</text></svg>\n'
    write_text(root / desktop_ref, svg)
    write_text(root / mobile_ref, svg.replace("640 400", "480 400"))
    write_json(root / manifest_ref, {"schema_version": "0.7.0", "plan_ref": plan_ref, "lint_ref": lint_ref, "computation_ref": comp_ref, "claim_id": claim_id, "data_hash": result_hash, "variants": {"desktop": desktop_ref, "mobile": mobile_ref}})
    write_json(root / "visualizations/critics/chart.json", {"passed": True, "score": 98, "manifest_ref": manifest_ref})

    expl_plan_ref = "visualizations/illustrations/plans/page.json"
    expl_lint_ref = "visualizations/illustrations/lints/page.json"
    expl_manifest_ref = "visualizations/illustrations/page.json"
    expl_desktop_ref = "visualizations/illustrations/page.svg"
    expl_mobile_ref = "visualizations/illustrations/page.mobile.svg"
    expl_critic_ref = "visualizations/illustrations/critics/page.json"
    write_json(root / expl_plan_ref, {"schema_version": "0.1.0", "title": "Fixture explainer", "subject": "Fixture system", "view": "cutaway", "alt": "A schematic cutaway fixture used to test explanatory graphic integrity.", "source_note": "Fixture source", "not_to_scale": True, "parts": [{"id": "a", "label": "Input", "claim_ids": [claim_id]}, {"id": "b", "label": "Output", "claim_ids": [claim_id]}], "relationships": []})
    write_json(root / expl_lint_ref, {"schema_version": "0.1.0", "passed": True, "plan_ref": expl_plan_ref, "blockers": []})
    expl_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 600" role="img" data-explainer-version="0.1.0"><title>Fixture explainer</title><desc>A schematic explanatory graphic fixture with accessible labels.</desc><rect width="1040" height="600" fill="white"/><text x="40" y="80">Input</text><text x="40" y="130">Output</text><text x="40" y="560">SCHEMATIC / NOT TO SCALE</text></svg>\n'
    expl_mobile_svg = expl_svg.replace('1040 600', '640 700').replace('width="1040" height="600"', 'width="640" height="700"')
    write_text(root / expl_desktop_ref, expl_svg); write_text(root / expl_mobile_ref, expl_mobile_svg)
    write_json(root / expl_manifest_ref, {"schema_version": "0.1.0", "plan_ref": expl_plan_ref, "lint_ref": expl_lint_ref, "title": "Fixture explainer", "alt": "A schematic cutaway fixture used to test explanatory graphic integrity.", "view": "cutaway", "source_note": "Fixture source", "claim_ids": [claim_id], "not_to_scale": True, "variants": {"desktop": expl_desktop_ref, "mobile": expl_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(expl_svg.encode()), "mobile_sha256": sha_bytes(expl_mobile_svg.encode())}})
    write_json(root / expl_critic_ref, {"schema_version": "0.1.0", "passed": True, "score": 96, "manifest_ref": expl_manifest_ref})

    rich_plan_ref = "visualizations/illustrations/plans/rich.json"
    rich_lint_ref = "visualizations/illustrations/lints/rich.json"
    rich_manifest_ref = "visualizations/illustrations/rich.json"
    rich_desktop_ref = "visualizations/illustrations/rich.svg"
    rich_mobile_ref = "visualizations/illustrations/rich.mobile.svg"
    rich_critic_ref = "visualizations/illustrations/critics/rich.json"
    write_json(root / rich_plan_ref, {"schema_version": "0.2.0", "title": "Fixture rich illustration", "subject": "Evidence flow", "intent": "Exercise provenance-aware illustration verification.", "alt": "A provenance-aware editorial illustration used to test responsive rich illustration integrity.", "style_direction": "Restrained editorial vector art", "aspect_ratio": "adaptive", "origin_policy": "ai_disclosed", "source_note": "Fixture source", "credit": "Synthetic fixture", "claim_ids": [claim_id], "evidence_refs": [source_ref, comp_ref], "factual_elements": [{"id": "flow", "label": "Evidence flow", "claim_ids": [claim_id]}], "constraints": []})
    write_json(root / rich_lint_ref, {"schema_version": "0.2.0", "passed": True, "plan_ref": rich_plan_ref, "blockers": []})
    rich_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700" role="img" data-rich-illustration-version="0.2.0" data-origin="generative_ai" data-digital-source-type="trainedAlgorithmicMedia"><title>Fixture rich illustration</title><desc>A provenance-aware responsive editorial illustration fixture.</desc><rect width="1200" height="700" fill="white"/><circle cx="420" cy="350" r="160" fill="#d9dde1"/><path d="M 580 260 L 940 350 L 580 440 Z" fill="#c9473d"/></svg>\n'
    rich_mobile_svg = rich_svg.replace('1200 700', '640 760').replace('width="1200" height="700"', 'width="640" height="760"')
    write_text(root / rich_desktop_ref, rich_svg); write_text(root / rich_mobile_ref, rich_mobile_svg)
    write_json(root / rich_manifest_ref, {"schema_version": "0.2.0", "kind": "rich_illustration", "plan_ref": rich_plan_ref, "lint_ref": rich_lint_ref, "title": "Fixture rich illustration", "alt": "A provenance-aware editorial illustration used to test responsive rich illustration integrity.", "source_note": "Fixture source", "credit": "Synthetic fixture", "claim_ids": [claim_id], "evidence_refs": [source_ref, comp_ref], "origin_policy": "ai_disclosed", "not_to_scale": False, "variants": {"desktop": rich_desktop_ref, "mobile": rich_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(rich_svg.encode()), "mobile_sha256": sha_bytes(rich_mobile_svg.encode())}, "provenance": {"origin": "generative_ai", "digital_source_type": "trainedAlgorithmicMedia", "provider": "fixture-provider", "model": "fixture-image-model", "version": "1", "disclosure": "AI-generated illustration for a synthetic integrity fixture.", "request_hash": "a" * 64, "evidence_snapshot_hash": "b" * 64}})
    write_json(root / rich_critic_ref, {"schema_version": "0.2.0", "passed": True, "score": 98, "manifest_ref": rich_manifest_ref, "origin": "generative_ai", "digital_source_type": "trainedAlgorithmicMedia"})

    source_info_plan_ref = "infographics/plans/page-before.json"
    info_plan_ref = "infographics/plans/page.json"
    source_info_lint_ref = "infographics/lints/page-before.json"
    info_lint_ref = "infographics/lints/page.json"
    source_info_manifest_ref = "infographics/page-before.json"
    info_manifest_ref = "infographics/page.json"
    source_info_desktop_ref = "infographics/page-before.svg"
    source_info_mobile_ref = "infographics/page-before.mobile.svg"
    info_desktop_ref = "infographics/page.svg"
    info_mobile_ref = "infographics/page.mobile.svg"
    info_modules = [
        {"id": "v1", "type": "visual", "manifest_ref": manifest_ref, "span": "half", "story_role": "evidence", "priority": 1, "emphasis": "hero"},
        {"id": "v2", "type": "visual", "manifest_ref": manifest_ref, "span": "half", "story_role": "evidence", "priority": 2, "emphasis": "primary"},
        {"id": "i1", "type": "illustration", "asset_ref": expl_manifest_ref, "critic_ref": expl_critic_ref, "alt": "A schematic cutaway fixture used to test explanatory graphic integrity.", "credit": "Synthetic fixture", "claim_ids": [claim_id], "span": "full", "story_role": "explanation", "priority": 2, "emphasis": "primary"},
        {"id": "i2", "type": "illustration", "asset_ref": rich_manifest_ref, "critic_ref": rich_critic_ref, "alt": "A provenance-aware editorial illustration fixture for integrity testing.", "credit": "Synthetic fixture", "claim_ids": [claim_id], "span": "full", "story_role": "resolution", "priority": 3, "emphasis": "support"},
        {"id": "s1", "type": "hero_stat", "value": "2", "label": "Fixture value", "claim_id": claim_id, "span": "third", "story_role": "hook", "priority": 1, "emphasis": "primary"},
    ]
    source_info_plan = {"schema_version": "1.2.0", "title": "Fixture feature", "dek": "A responsive magazine fixture.", "alt": "A magazine fixture used for integrity and competition-gate regression tests.", "intent": "Exercise competition-aware visual revision and final preflight gates.", "primary_message": "Verified modules remain traceable after responsive magazine composition.", "story_arc": "explain", "audience": "informed", "quality_target": "award", "competition_profile": "oja2026_visual", "modules": info_modules}
    revised_info_plan = json.loads(json.dumps(source_info_plan))
    revised_info_plan["modules"][0]["span"] = "full"
    revised_info_plan["mobile_module_order"] = ["v2", "v1", "i1", "i2", "s1"]
    write_json(root / source_info_plan_ref, source_info_plan)
    write_json(root / info_plan_ref, revised_info_plan)
    write_json(root / source_info_lint_ref, {"schema_version": "1.2.0", "passed": True, "plan_ref": source_info_plan_ref, "blockers": []})
    write_json(root / info_lint_ref, {"schema_version": "1.2.0", "passed": True, "plan_ref": info_plan_ref, "blockers": []})
    info_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1200" role="img" data-infographic-version="1.2.0"><title>Fixture magazine feature</title><desc>Accessible magazine infographic fixture with multiple verified visuals.</desc><rect width="1440" height="1200" fill="white"/><text x="40" y="80">Magazine fixture</text><rect x="40" y="120" width="360" height="180" fill="#f2f3f4"/><text x="60" y="170">Verified hero statistic</text><rect x="430" y="120" width="930" height="420" fill="#ffffff" stroke="#d9dde1"/><text x="460" y="170">Embedded verified visualization one</text><rect x="40" y="570" width="1320" height="420" fill="#ffffff" stroke="#d9dde1"/><text x="70" y="620">Embedded verified visualization two with responsive composition and source provenance.</text><text x="70" y="670">This synthetic page is intentionally verbose enough to exercise the magazine artifact verifier.</text><g data-rich-illustration-version="0.2.0"><rect x="70" y="720" width="280" height="160" fill="#f4f2ee"/></g><rect data-role="illustration-credit" x="70" y="890" width="1" height="1" fill="none"/><text x="70" y="910">Synthetic fixture · AI-generated illustration disclosed.</text><text x="40" y="1140">SOURCES &amp; METHODS</text></svg>\n'
    info_mobile_svg = info_svg.replace('1440 1200', '720 1400').replace('width="1440" height="1200"', 'width="720" height="1400"')
    for ref, text in [(source_info_desktop_ref, info_svg), (source_info_mobile_ref, info_mobile_svg), (info_desktop_ref, info_svg), (info_mobile_ref, info_mobile_svg)]:
        write_text(root / ref, text)
    info_hashes = {"desktop_sha256": sha_bytes(info_svg.encode()), "mobile_sha256": sha_bytes(info_mobile_svg.encode())}
    source_manifest = {"schema_version": "1.2.0", "plan_ref": source_info_plan_ref, "lint_ref": source_info_lint_ref, "visual_manifest_refs": [manifest_ref, manifest_ref], "illustration_manifest_refs": [expl_manifest_ref, rich_manifest_ref], "claim_ids": [claim_id], "variants": {"desktop": source_info_desktop_ref, "mobile": source_info_mobile_ref}, "hashes": info_hashes, "visual_review_required": True}
    final_manifest = {"schema_version": "1.2.0", "plan_ref": info_plan_ref, "lint_ref": info_lint_ref, "visual_manifest_refs": [manifest_ref, manifest_ref], "illustration_manifest_refs": [expl_manifest_ref, rich_manifest_ref], "claim_ids": [claim_id], "variants": {"desktop": info_desktop_ref, "mobile": info_mobile_ref}, "hashes": info_hashes, "visual_review_required": True}
    write_json(root / source_info_manifest_ref, source_manifest)
    write_json(root / info_manifest_ref, final_manifest)
    rubric = {"impact_story_focus": 96, "engagement": 94, "clarity_information_flow": 98, "effectiveness": 96, "hierarchy": 95, "editorial_rhythm": 94, "inclusion_accessibility": 98, "responsive_execution": 98, "craft_geometry": 94, "originality_variety": 90}
    source_deterministic_critic_ref = "infographics/critics/page-before.json"
    deterministic_critic_ref = "infographics/critics/page.json"
    write_json(root / source_deterministic_critic_ref, {"schema_version": "1.2.0", "passed": True, "score": 96, "rubric": rubric, "manifest_ref": source_info_manifest_ref})
    write_json(root / deterministic_critic_ref, {"schema_version": "1.2.0", "passed": True, "score": 96, "rubric": rubric, "manifest_ref": info_manifest_ref})
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+T+Z1AAAAAElFTkSuQmCC")
    source_preview_desktop_ref = "infographics/previews/desktop-before.png"
    source_preview_mobile_ref = "infographics/previews/mobile-before.png"
    preview_desktop_ref = "infographics/previews/desktop.png"
    preview_mobile_ref = "infographics/previews/mobile.png"
    for ref in (source_preview_desktop_ref, source_preview_mobile_ref, preview_desktop_ref, preview_mobile_ref):
        (root / ref).parent.mkdir(parents=True, exist_ok=True)
        (root / ref).write_bytes(png)
    source_preview_ref = "infographics/previews/page-before.json"
    preview_ref = "infographics/previews/page.json"
    write_json(root / source_preview_ref, {"schema_version": "0.1.0", "kind": "infographic_visual_preview", "manifest_ref": source_info_manifest_ref, "deterministic_critic_ref": source_deterministic_critic_ref, "source_hashes": info_hashes, "variants": {"desktop": source_preview_desktop_ref, "mobile": source_preview_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(png), "mobile_sha256": sha_bytes(png)}, "rasterizer": {"engine": "fixture"}})
    write_json(root / preview_ref, {"schema_version": "0.1.0", "kind": "infographic_visual_preview", "manifest_ref": info_manifest_ref, "deterministic_critic_ref": deterministic_critic_ref, "source_hashes": info_hashes, "variants": {"desktop": preview_desktop_ref, "mobile": preview_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(png), "mobile_sha256": sha_bytes(png)}, "rasterizer": {"engine": "fixture"}})
    vision_rubric = {"hierarchy": 92, "legibility": 94, "composition": 91, "visual_coherence": 93, "typography": 90, "source_legibility": 94, "responsive_quality": 92, "illustration_integration": 90, "color_contrast": 95, "editorial_distinctiveness": 88}
    source_vision_critic_ref = "infographics/vision-critics/page-before.json"
    vision_critic_ref = "infographics/vision-critics/page.json"
    revision_patches = [{"target_module_id": "v1", "field": "span", "value": "full"}, {"target_module_id": "v2", "field": "mobile_move_before", "value": "v1"}]
    write_json(root / source_vision_critic_ref, {"schema_version": "0.2.0", "kind": "image_aware_model", "passed": True, "score": 92, "confidence": 0.9, "rubric": vision_rubric, "issues": [{"severity": "warning", "viewport": "mobile", "code": "reading_order", "module_id": "v2", "evidence": "The secondary visual lands too late on mobile.", "recommendation": "Move it before the first visual on mobile."}], "patches": revision_patches, "manifest_ref": source_info_manifest_ref, "preview_ref": source_preview_ref, "deterministic_critic_ref": source_deterministic_critic_ref, "provider": "fixture", "model": "fixture-vision"})
    write_json(root / vision_critic_ref, {"schema_version": "0.2.0", "kind": "image_aware_model", "passed": True, "score": 92, "confidence": 0.9, "rubric": vision_rubric, "issues": [], "patches": [], "manifest_ref": info_manifest_ref, "preview_ref": preview_ref, "deterministic_critic_ref": deterministic_critic_ref, "provider": "fixture", "model": "fixture-vision"})
    revision_ref = "infographics/revisions/page.json"
    write_json(root / revision_ref, {"schema_version": "0.1.0", "source_plan_ref": source_info_plan_ref, "vision_critic_ref": source_vision_critic_ref, "revised_plan_ref": info_plan_ref, "applied_patches": revision_patches, "safety": {"immutable_projection_sha256": infographic_immutable_hash(source_info_plan), "evidence_fields_preserved": True, "source_schema_version": "1.2.0", "revised_schema_version": "1.2.0", "allowed_patch_fields": ["span", "emphasis", "priority", "move_before", "mobile_move_before"]}})
    preflight_ref = "infographics/competition-preflight/page.json"
    write_json(root / preflight_ref, {"schema_version": "0.1.0", "profile": "oja2026_visual", "label": "OJA 2026 Excellence in Visual Digital Storytelling", "threshold_basis": "internal_operational_proxy_not_official_jury_cutoff", "source_urls": ["https://awards.journalists.org/awards/visual-digital-storytelling/"], "machine_passed": True, "submission_ready": False, "blockers": [], "warnings": [], "manual_requirements": ["Human editor must confirm the chosen media and interaction are materially effective for the story topic.", "Human editor must confirm originality is genuinely digital/mobile-native rather than a cosmetic format conversion."], "evidence": [{"kind": "rich_illustration_origin", "ref": rich_manifest_ref, "origin": "generative_ai"}], "observed": {"deterministic_score": 96, "vision_score": 92, "deterministic_rubric": rubric, "vision_rubric": vision_rubric}, "plan_ref": info_plan_ref, "manifest_ref": info_manifest_ref, "deterministic_critic_ref": deterministic_critic_ref, "vision_critic_ref": vision_critic_ref})

    files = {"prompt": "prompt.md", "latest_answer": "answer.md", "conversation": "conversation.md", "events": "events.jsonl", "tool_audit": "tools.json", "session_stats": "session-stats.json", "run_metrics": "run-metrics.jsonl", "plan": "plan.json", "claims": "claims.jsonl"}
    evidence = {
        "searches": [],
        "sources": [source_ref],
        "datasets": [data_ref, f"{data_ref}.meta.json"],
        "computations": [comp_ref],
        "claims": [{"claim_id": claim_id, "status": "verified"}],
        "visualizations": [plan_ref, lint_ref, manifest_ref, desktop_ref, mobile_ref, "visualizations/critics/chart.json", expl_plan_ref, expl_lint_ref, expl_manifest_ref, expl_desktop_ref, expl_mobile_ref, expl_critic_ref, rich_plan_ref, rich_lint_ref, rich_manifest_ref, rich_desktop_ref, rich_mobile_ref, rich_critic_ref],
        "infographics": [source_info_plan_ref, source_info_lint_ref, source_info_manifest_ref, source_info_desktop_ref, source_info_mobile_ref, source_deterministic_critic_ref, source_preview_ref, source_preview_desktop_ref, source_preview_mobile_ref, source_vision_critic_ref, info_plan_ref, info_lint_ref, info_manifest_ref, info_desktop_ref, info_mobile_ref, deterministic_critic_ref, preview_ref, preview_desktop_ref, preview_mobile_ref, vision_critic_ref, revision_ref, preflight_ref],
    }
    write_json(root / "story.json", {
        "schema_version": "0.7.0", "id": "synthetic", "kind": "investigation", "created_at": "2026-09-12T00:00:00Z", "updated_at": "2026-09-12T00:00:00Z", "topic": "fixture", "status": "draft",
        "runtime": {"backend": "pi-rpc", "provider": None, "model": None, "session_dir": "session/"},
        "files": files,
        "autonomy": {"persistent_session": True, "session_resumed": True, "multi_turn_context": True, "observable_planning": True, "agent_loop_observed": True, "autonomous_execution_observed": True, "adaptive_replanning_observed": True, "tool_failure_recovery_observed": True, "follow_up_replanning_observed": True, "user_messages": 2, "turns": 3, "tool_calls": 12, "capability_tool_calls": 11, "successful_capability_tool_calls": 10, "distinct_tools": 11, "distinct_capability_classes": 4, "plan_revisions": 2, "successful_plan_calls": 2, "follow_up_goals": 1, "failed_tool_calls": 1, "automatic_retries": 0},
        "evidence": evidence,
    })


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="newsroom-evaluator-valid-") as tmp:
        root = Path(tmp)
        build_valid(root)
        valid = subprocess.run([sys.executable, str(EVALUATOR), str(root)], check=False)
        if valid.returncode != 0:
            print("FAIL: valid synthetic artifact did not pass", file=sys.stderr)
            return valid.returncode

        # Adversarial regression: references point at missing artifacts, while unrelated files exist.
        claim = json.loads((root / "claims.jsonl").read_text())
        claim["source_refs"] = ["sources/DOES-NOT-EXIST.json"]
        claim["computation_refs"] = ["computations/DOES-NOT-EXIST.json"]
        write_text(root / "claims.jsonl", json.dumps(claim) + "\n")
        fake = subprocess.run([sys.executable, str(EVALUATOR), str(root)], check=False, stdout=subprocess.PIPE, text=True)
        if fake.returncode == 0:
            print(fake.stdout)
            print("FAIL: adversarial missing provenance still passed evaluator", file=sys.stderr)
            return 3

    print("PASS: evaluator accepts valid artifact and rejects missing-provenance adversary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
