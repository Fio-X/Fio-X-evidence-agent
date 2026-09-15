#!/usr/bin/env python3
"""Deterministic Pi-compatible RPC mock for Rust control-plane acceptance tests.

This does not test model quality or Pi itself. It verifies the Rust JSONL client,
persistent-session wiring, audit trail, follow-up continuation, and artifact gates.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha_bytes(data: bytes):
    import hashlib
    return hashlib.sha256(data).hexdigest()


def ensure_artifacts(resume: bool):
    root_value = os.environ.get("NEWSROOM_ARTIFACT_DIR")
    if not root_value:
        return
    root = Path(root_value)
    root.mkdir(parents=True, exist_ok=True)
    for child in ["data", "sources", "computations", "visualizations/plans", "visualizations/lints", "visualizations/critics", "infographics/plans", "infographics/lints", "infographics/critics"]:
        (root / child).mkdir(parents=True, exist_ok=True)

    revision = 3 if resume else 2
    write_json(root / "plan.json", {
        "schema_version": "0.7.0", "revision": revision, "goal": "Mock acceptance investigation",
        "steps": [{"id": "discover", "status": "done"}, {"id": "compute", "status": "done"}, {"id": "visualize", "status": "done"}],
    })
    data = b"country,value\nA,10\nB,20\n"
    data_hash = sha_bytes(data)
    data_ref = f"data/{data_hash}.csv"
    (root / data_ref).write_bytes(data)
    write_json(root / f"{data_ref}.meta.json", {"schema_version": "0.7.0", "origin": "mock", "file": data_ref, "bytes": len(data), "sha256": data_hash})
    source_payload = {"content_type": "text/plain", "final_url": "https://example.test/source", "status": 200, "text": "mock source", "truncated": False}
    source_hash = sha_bytes(canonical(source_payload).encode())
    source_ref = f"sources/{source_hash}.json"
    write_json(root / source_ref, {"schema_version": "0.7.0", **source_payload, "content_hash": source_hash, "trust": "untrusted_external_content"})
    rows = [{"country": "A", "value": 10}, {"country": "B", "value": 20}]
    result_hash = sha_bytes(canonical(rows).encode())
    sql = f"SELECT * FROM read_csv_auto('{data_ref}')"
    fingerprints = sorted([f"data:{data_ref}:{data_hash}", f"source:{Path(source_ref).name}:{source_hash}"])
    input_hash = sha_bytes("\n".join(fingerprints).encode())
    comp_key = sha_bytes(f"{sql}\n{input_hash}\n{result_hash}".encode())
    comp_ref = f"computations/{comp_key}.json"
    write_json(root / comp_ref, {"schema_version": "0.7.0", "sql": sql, "input_snapshot_hash": input_hash, "input_fingerprints": fingerprints, "result_hash": result_hash, "rows": rows})
    plan_ref = "visualizations/plans/mock.json"
    lint_ref = "visualizations/lints/mock.json"
    manifest_ref = "visualizations/mock.json"
    write_json(root / plan_ref, {"claim_id": "mock-claim", "chart_type": "horizontal_bar", "title": "Mock", "sql": "SELECT 1"})
    write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": result_hash, "blockers": []})
    desktop = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 500" role="img"><title>Mock</title><desc>Mock desktop visualization for acceptance testing.</desc><rect width="1040" height="500" fill="white"/><text x="20" y="30">Source: mock</text></svg>\n'
    mobile = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 500" role="img"><title>Mock</title><desc>Mock mobile visualization for acceptance testing.</desc><rect width="640" height="500" fill="white"/><text x="20" y="30">Source: mock</text></svg>\n'
    (root / "visualizations" / "mock.svg").write_text(desktop, encoding="utf-8")
    (root / "visualizations" / "mock.mobile.svg").write_text(mobile, encoding="utf-8")
    write_json(root / manifest_ref, {"schema_version": "0.7.0", "plan_ref": plan_ref, "lint_ref": lint_ref, "computation_ref": comp_ref, "claim_id": "mock-claim", "data_hash": result_hash, "svg": "visualizations/mock.svg", "variants": {"desktop": "visualizations/mock.svg", "mobile": "visualizations/mock.mobile.svg"}})
    write_json(root / "visualizations/critics/mock.json", {"passed": True, "score": 100, "manifest_ref": manifest_ref})
    expl_plan_ref = "visualizations/illustrations/plans/mock.json"
    expl_lint_ref = "visualizations/illustrations/lints/mock.json"
    expl_manifest_ref = "visualizations/illustrations/mock.json"
    expl_desktop_ref = "visualizations/illustrations/mock.svg"
    expl_mobile_ref = "visualizations/illustrations/mock.mobile.svg"
    expl_critic_ref = "visualizations/illustrations/critics/mock.json"
    write_json(root / expl_plan_ref, {"schema_version": "0.1.0", "title": "Mock explainer", "subject": "Mock system", "view": "cutaway", "alt": "A schematic mock cutaway used to validate the explanatory control plane.", "source_note": "Mock source", "not_to_scale": True, "parts": [{"id": "a", "label": "Input", "claim_ids": ["mock-claim"]}, {"id": "b", "label": "Output", "claim_ids": ["mock-claim"]}], "relationships": []})
    write_json(root / expl_lint_ref, {"schema_version": "0.1.0", "passed": True, "plan_ref": expl_plan_ref, "blockers": []})
    expl_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 600" role="img" data-explainer-version="0.1.0"><title>Mock explainer</title><desc>A schematic mock explanatory graphic with accessible labels.</desc><rect width="1040" height="600" fill="white"/><text x="40" y="80">Input</text><text x="40" y="130">Output</text><text x="40" y="560">SCHEMATIC / NOT TO SCALE</text></svg>\n'
    expl_mobile_svg = expl_svg.replace('1040 600', '640 700').replace('width="1040" height="600"', 'width="640" height="700"')
    (root / expl_desktop_ref).parent.mkdir(parents=True, exist_ok=True)
    (root / expl_desktop_ref).write_text(expl_svg, encoding="utf-8"); (root / expl_mobile_ref).write_text(expl_mobile_svg, encoding="utf-8")
    write_json(root / expl_manifest_ref, {"schema_version": "0.1.0", "plan_ref": expl_plan_ref, "lint_ref": expl_lint_ref, "title": "Mock explainer", "alt": "A schematic mock cutaway used to validate the explanatory control plane.", "view": "cutaway", "source_note": "Mock source", "claim_ids": ["mock-claim"], "not_to_scale": True, "variants": {"desktop": expl_desktop_ref, "mobile": expl_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(expl_svg.encode()), "mobile_sha256": sha_bytes(expl_mobile_svg.encode())}})
    write_json(root / expl_critic_ref, {"schema_version": "0.1.0", "passed": True, "score": 96, "manifest_ref": expl_manifest_ref})
    rich_plan_ref = "visualizations/illustrations/plans/mock-rich.json"
    rich_lint_ref = "visualizations/illustrations/lints/mock-rich.json"
    rich_manifest_ref = "visualizations/illustrations/mock-rich.json"
    rich_desktop_ref = "visualizations/illustrations/mock-rich.svg"
    rich_mobile_ref = "visualizations/illustrations/mock-rich.mobile.svg"
    rich_critic_ref = "visualizations/illustrations/critics/mock-rich.json"
    write_json(root / rich_plan_ref, {"schema_version": "0.2.0", "title": "Mock rich illustration", "subject": "Mock evidence flow", "intent": "Exercise the provenance-aware illustration control plane.", "alt": "A provenance-aware mock illustration used to validate rich illustration artifact integrity.", "style_direction": "Restrained editorial vector art", "aspect_ratio": "adaptive", "origin_policy": "ai_disclosed", "source_note": "Mock source", "credit": "Mock fixture", "claim_ids": ["mock-claim"], "evidence_refs": [source_ref, comp_ref], "factual_elements": [{"id": "flow", "label": "Mock evidence flow", "claim_ids": ["mock-claim"]}], "constraints": []})
    write_json(root / rich_lint_ref, {"schema_version": "0.2.0", "passed": True, "plan_ref": rich_plan_ref, "blockers": []})
    rich_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700" role="img" data-rich-illustration-version="0.2.0" data-origin="generative_ai" data-digital-source-type="trainedAlgorithmicMedia"><title>Mock rich illustration</title><desc>Accessible provenance-aware mock rich illustration.</desc><rect width="1200" height="700" fill="white"/><circle cx="420" cy="350" r="160" fill="#ddd"/><path d="M 580 260 L 940 350 L 580 440 Z" fill="#c9473d"/></svg>\n'
    rich_mobile_svg = rich_svg.replace('1200 700', '640 760').replace('width="1200" height="700"', 'width="640" height="760"')
    (root / rich_desktop_ref).write_text(rich_svg, encoding="utf-8"); (root / rich_mobile_ref).write_text(rich_mobile_svg, encoding="utf-8")
    write_json(root / rich_manifest_ref, {"schema_version": "0.2.0", "kind": "rich_illustration", "plan_ref": rich_plan_ref, "lint_ref": rich_lint_ref, "title": "Mock rich illustration", "alt": "A provenance-aware mock illustration used to validate rich illustration artifact integrity.", "source_note": "Mock source", "credit": "Mock fixture", "claim_ids": ["mock-claim"], "evidence_refs": [source_ref, comp_ref], "origin_policy": "ai_disclosed", "not_to_scale": False, "variants": {"desktop": rich_desktop_ref, "mobile": rich_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(rich_svg.encode()), "mobile_sha256": sha_bytes(rich_mobile_svg.encode())}, "provenance": {"origin": "generative_ai", "digital_source_type": "trainedAlgorithmicMedia", "provider": "mock-provider", "model": "mock-image-model", "version": "1", "disclosure": "AI-generated mock illustration for control-plane testing.", "request_hash": "a" * 64, "evidence_snapshot_hash": "b" * 64}})
    write_json(root / rich_critic_ref, {"schema_version": "0.2.0", "passed": True, "score": 98, "manifest_ref": rich_manifest_ref, "origin": "generative_ai", "digital_source_type": "trainedAlgorithmicMedia"})
    info_plan_ref = "infographics/plans/mock.json"
    info_lint_ref = "infographics/lints/mock.json"
    info_manifest_ref = "infographics/mock.json"
    info_desktop_ref = "infographics/mock.svg"
    info_mobile_ref = "infographics/mock.mobile.svg"
    write_json(root / info_plan_ref, {"schema_version": "1.1.0", "title": "Mock magazine feature", "dek": "Mock responsive feature for control-plane acceptance.", "alt": "A synthetic magazine feature used to validate the Rust control plane and artifact pipeline.", "intent": "Exercise the infographic control-plane acceptance path.", "primary_message": "Responsive composition preserves verified visual provenance.", "story_arc": "explain", "audience": "informed", "quality_target": "award", "modules": [{"id": "v1", "type": "visual", "manifest_ref": manifest_ref, "story_role": "evidence", "priority": 1, "emphasis": "hero"}, {"id": "v2", "type": "visual", "manifest_ref": manifest_ref, "story_role": "evidence", "priority": 2, "emphasis": "primary"}, {"id": "i", "type": "illustration", "asset_ref": expl_manifest_ref, "critic_ref": expl_critic_ref, "alt": "A schematic mock cutaway used to validate the explanatory control plane.", "credit": "Mock fixture", "claim_ids": ["mock-claim"], "story_role": "explanation", "priority": 2, "emphasis": "primary"}, {"id": "ir", "type": "illustration", "asset_ref": rich_manifest_ref, "critic_ref": rich_critic_ref, "alt": "A provenance-aware mock rich illustration used for control-plane testing.", "credit": "Mock fixture", "claim_ids": ["mock-claim"], "story_role": "resolution", "priority": 3, "emphasis": "support"}, {"id": "s", "type": "hero_stat", "value": "20", "label": "Mock value", "claim_id": "mock-claim", "story_role": "hook", "priority": 1, "emphasis": "primary"}]})
    write_json(root / info_lint_ref, {"schema_version": "1.1.0", "passed": True, "plan_ref": info_plan_ref, "blockers": []})
    info_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 1200" role="img" data-infographic-version="1.1.0"><title>Mock magazine feature</title><desc>Responsive mock magazine infographic with verified visual modules.</desc><rect width="1440" height="1200" fill="white"/><text x="40" y="70">Mock magazine feature</text><rect x="40" y="110" width="360" height="190" fill="#f2f3f4"/><text x="60" y="160">Hero statistic: 20</text><rect x="430" y="110" width="930" height="420" fill="white" stroke="#ddd"/><text x="460" y="160">Verified visualization module one</text><rect x="40" y="560" width="1320" height="420" fill="white" stroke="#ddd"/><text x="70" y="610">Verified visualization module two retained with provenance.</text><text x="70" y="660">This page exists to exercise the infographic control-plane and integrity contract.</text><g data-rich-illustration-version="0.2.0"><rect x="70" y="720" width="280" height="160" fill="#eee"/></g><rect data-role="illustration-credit" x="70" y="890" width="1" height="1" fill="none"/><text x="70" y="910">Mock fixture · AI-generated illustration disclosed.</text><text x="40" y="1140">SOURCES &amp; METHODS</text></svg>\n'
    info_mobile_svg = info_svg.replace('1440 1200', '720 1400').replace('width="1440" height="1200"', 'width="720" height="1400"')
    (root / info_desktop_ref).write_text(info_svg, encoding="utf-8")
    (root / info_mobile_ref).write_text(info_mobile_svg, encoding="utf-8")
    info_hashes = {"desktop_sha256": sha_bytes(info_svg.encode()), "mobile_sha256": sha_bytes(info_mobile_svg.encode())}
    write_json(root / info_manifest_ref, {"schema_version": "1.1.0", "plan_ref": info_plan_ref, "lint_ref": info_lint_ref, "visual_manifest_refs": [manifest_ref, manifest_ref], "illustration_manifest_refs": [expl_manifest_ref, rich_manifest_ref], "claim_ids": ["mock-claim"], "variants": {"desktop": info_desktop_ref, "mobile": info_mobile_ref}, "hashes": info_hashes, "visual_review_required": True})
    deterministic_critic_ref = "infographics/critics/mock.json"
    write_json(root / deterministic_critic_ref, {"schema_version": "1.1.0", "passed": True, "score": 96, "rubric": {"impact_story_focus": 96, "engagement": 94, "clarity_information_flow": 98, "effectiveness": 96, "hierarchy": 95, "editorial_rhythm": 94, "inclusion_accessibility": 98, "responsive_execution": 98, "craft_geometry": 94, "originality_variety": 90}, "manifest_ref": info_manifest_ref})
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+T+Z1AAAAAElFTkSuQmCC")
    preview_desktop_ref, preview_mobile_ref = "infographics/previews/mock.png", "infographics/previews/mock.mobile.png"
    (root / preview_desktop_ref).parent.mkdir(parents=True, exist_ok=True)
    (root / preview_desktop_ref).write_bytes(png); (root / preview_mobile_ref).write_bytes(png)
    preview_ref = "infographics/previews/mock.json"
    write_json(root / preview_ref, {"schema_version": "0.1.0", "kind": "infographic_visual_preview", "manifest_ref": info_manifest_ref, "deterministic_critic_ref": deterministic_critic_ref, "source_hashes": info_hashes, "variants": {"desktop": preview_desktop_ref, "mobile": preview_mobile_ref}, "hashes": {"desktop_sha256": sha_bytes(png), "mobile_sha256": sha_bytes(png)}})
    write_json(root / "infographics/vision-critics/mock.json", {"schema_version": "0.1.0", "kind": "image_aware_model", "passed": True, "score": 92, "confidence": 0.9, "rubric": {"hierarchy": 92, "legibility": 94, "composition": 91, "visual_coherence": 93, "typography": 90, "source_legibility": 94, "responsive_quality": 92, "illustration_integration": 90, "color_contrast": 95, "editorial_distinctiveness": 88}, "issues": [], "patches": [], "manifest_ref": info_manifest_ref, "preview_ref": preview_ref, "deterministic_critic_ref": deterministic_critic_ref, "provider": "mock-provider", "model": "mock-model"})
    claim = {"schema_version": "0.7.0", "claim_id": "mock-claim", "claim": "B is higher than A in the deterministic mock fixture.", "status": "verified", "source_refs": [source_ref, data_ref], "computation_refs": [comp_ref]}
    claims_path = root / "claims.jsonl"
    if not claims_path.exists():
        claims_path.write_text(json.dumps(claim) + "\n", encoding="utf-8")


def tool(call_id: str, name: str, args=None, error=False):
    emit({"type": "tool_execution_start", "toolCallId": call_id, "toolName": name, "args": args or {}})
    emit({"type": "tool_execution_end", "toolCallId": call_id, "toolName": name, "isError": error})


def run_rpc():
    resume = "-c" in sys.argv or "--continue" in sys.argv
    ensure_artifacts(resume)
    answer = "Mock follow-up completed with revised plan." if resume else "Mock investigation completed after recovering from one source failure."

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = msg.get("type")
        if kind == "prompt":
            emit({"type": "response", "id": msg.get("id"), "command": "prompt", "success": True})
            if resume:
                tool("p2", "newsroom_update_plan", {"revision": 3, "trigger": "user_followup", "revision_note": "User follow-up changed the verification focus."})
                tool("q2", "duckdb_query", {"sql": "SELECT * FROM data/mock.csv"})
                tool("v2", "newsroom_viz_critic", {"manifest_ref": "visualizations/mock.json"})
            else:
                tool("p1", "newsroom_update_plan", {"revision": 1, "trigger": "initial_goal"})
                tool("i1", "artifact_inventory")
                tool("f1", "fetch_url", {"url": "https://unreachable.invalid/"}, error=True)
                emit({"type": "auto_retry_start", "attempt": 1})
                tool("p1r", "newsroom_update_plan", {"revision": 2, "trigger": "tool_error", "revision_note": "The source fetch failed; continue with deterministic local evidence."})
                tool("q1", "duckdb_query", {"sql": "SELECT * FROM data/mock.csv"})
                tool("vp1", "newsroom_viz_plan", {"claim_id": "mock-claim"})
                tool("vl1", "newsroom_viz_lint", {"plan_ref": "visualizations/plans/mock.json"})
                tool("vr1", "newsroom_viz_render", {"plan_ref": "visualizations/plans/mock.json"})
                tool("vc1", "newsroom_viz_critic", {"manifest_ref": "visualizations/mock.json"})
                tool("ep1", "newsroom_explainer_plan", {"title": "Mock explainer"})
                tool("el1", "newsroom_explainer_lint", {"plan_ref": "visualizations/illustrations/plans/mock.json"})
                tool("er1", "newsroom_explainer_render", {"plan_ref": "visualizations/illustrations/plans/mock.json"})
                tool("ec1", "newsroom_explainer_critic", {"manifest_ref": "visualizations/illustrations/mock.json"})
                tool("rp1", "newsroom_illustration_plan", {"title": "Mock rich illustration"})
                tool("rl1", "newsroom_illustration_lint", {"plan_ref": "visualizations/illustrations/plans/mock-rich.json"})
                tool("rg1", "newsroom_illustration_generate", {"plan_ref": "visualizations/illustrations/plans/mock-rich.json"})
                tool("rc1", "newsroom_illustration_critic", {"manifest_ref": "visualizations/illustrations/mock-rich.json"})
                tool("ip1", "newsroom_infographic_plan", {"title": "Mock magazine feature"})
                tool("il1", "newsroom_infographic_lint", {"plan_ref": "infographics/plans/mock.json"})
                tool("ir1", "newsroom_infographic_render", {"plan_ref": "infographics/plans/mock.json"})
                tool("ic1", "newsroom_infographic_critic", {"manifest_ref": "infographics/mock.json"})
                tool("ivp1", "newsroom_infographic_preview", {"manifest_ref": "infographics/mock.json"})
                tool("ivc1", "newsroom_infographic_vision_critic", {"manifest_ref": "infographics/mock.json"})
            emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": answer}})
            emit({"type": "turn_end"})
            emit({"type": "agent_settled"})
        elif kind == "get_last_assistant_text":
            emit({"type": "response", "id": msg.get("id"), "command": "get_last_assistant_text", "success": True, "data": {"text": answer}})
        elif kind == "get_session_stats":
            emit({"type": "response", "id": msg.get("id"), "command": "get_session_stats", "success": True, "data": {"userMessages": 2 if resume else 1, "assistantMessages": 2 if resume else 1}})
        elif kind == "abort":
            emit({"type": "agent_settled"})


if "--version" in sys.argv:
    print("mock-pi 0.7.0")
    raise SystemExit(0)
run_rpc()
