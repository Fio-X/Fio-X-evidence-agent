#!/usr/bin/env python3
"""Evaluate one investigation artifact against competition-observable evidence.

This is an engineering/demo gate, not a substitute for human judging.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from verify_artifact import system_verified_claim, verify as verify_integrity

ROOT = Path(__file__).resolve().parents[1]
TOOL_REGISTRY = json.loads((ROOT / "config" / "tool-registry.json").read_text(encoding="utf-8"))
CAPABILITY_NAMES = {row["name"] for row in TOOL_REGISTRY["tools"] if row["capability_class"] not in {"planning", "meta"}}


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def jsonl(path: Path):
    rows = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    except (OSError, json.JSONDecodeError):
        pass
    return rows


def count_files(root: Path, child: str, suffix: str | None = None) -> int:
    path = root / child
    if not path.is_dir():
        return 0
    return sum(1 for item in path.iterdir() if item.is_file() and (suffix is None or item.suffix == suffix))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    root = args.artifact

    story = load_json(root / "story.json", {})
    tools = load_json(root / "tools.json", {})
    plan = load_json(root / "plan.json", {})
    claims = jsonl(root / "claims.jsonl")
    run_metrics = jsonl(root / "run-metrics.jsonl")

    tool_counts = tools.get("tools") or {}
    capability_used = sorted(name for name in tool_counts if name in CAPABILITY_NAMES)
    verified_claims = [claim for claim in claims if system_verified_claim(claim)]
    verified_with_compute = [
        claim for claim in verified_claims
        if claim.get("source_refs") and claim.get("computation_refs")
    ]

    integrity = verify_integrity(root)
    rubric_keys = {"impact_story_focus", "engagement", "clarity_information_flow", "effectiveness", "hierarchy", "editorial_rhythm", "inclusion_accessibility", "responsive_execution", "craft_geometry", "originality_variety"}
    infographic_critics = []
    critic_dir = root / "infographics" / "critics"
    if critic_dir.is_dir():
        infographic_critics = [load_json(path, {}) for path in critic_dir.glob("*.json")]
    award_critic = any(c.get("passed") is True and rubric_keys.issubset((c.get("rubric") or {}).keys()) for c in infographic_critics)
    vision_rubric_keys = {"hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"}
    vision_critics = []
    vision_critic_dir = root / "infographics" / "vision-critics"
    if vision_critic_dir.is_dir():
        vision_critics = [load_json(path, {}) for path in vision_critic_dir.glob("*.json")]
    image_aware_critic = any(c.get("passed") is True and float(c.get("score") or 0) >= 80 and vision_rubric_keys.issubset((c.get("rubric") or {}).keys()) for c in vision_critics)
    visual_revisions = []
    revision_dir = root / "infographics" / "revisions"
    if revision_dir.is_dir():
        visual_revisions = [load_json(path, {}) for path in revision_dir.glob("*.json")]
    bounded_visual_revision = any(
        r.get("schema_version") == "0.1.0"
        and bool(r.get("applied_patches"))
        and (r.get("safety") or {}).get("evidence_fields_preserved") is True
        for r in visual_revisions
    )
    competition_preflights = []
    preflight_dir = root / "infographics" / "competition-preflight"
    if preflight_dir.is_dir():
        competition_preflights = [load_json(path, {}) for path in preflight_dir.glob("*.json")]
    competition_preflight_passed = any(
        p.get("machine_passed") is True
        and p.get("threshold_basis") == "internal_operational_proxy_not_official_jury_cutoff"
        and isinstance(p.get("manual_requirements"), list)
        for p in competition_preflights
    )

    rich_illustration_critics = []
    illustration_critic_dir = root / "visualizations" / "illustrations" / "critics"
    if illustration_critic_dir.is_dir():
        rich_illustration_critics = [load_json(path, {}) for path in illustration_critic_dir.glob("*.json")]
    rich_manifests = []
    illustration_dir = root / "visualizations" / "illustrations"
    if illustration_dir.is_dir():
        for path in illustration_dir.glob("*.json"):
            manifest = load_json(path, {})
            if manifest.get("kind") == "rich_illustration" and manifest.get("schema_version") == "0.2.0":
                rich_manifests.append((path.relative_to(root).as_posix(), manifest))
    rich_manifest_refs = {ref for ref, _ in rich_manifests}
    rich_illustration_passed = any(c.get("passed") is True and c.get("manifest_ref") in rich_manifest_refs for c in rich_illustration_critics)

    checks = [
        ("artifact integrity", integrity.passed),
        ("persistent context", bool(story.get("autonomy", {}).get("persistent_session"))),
        ("multi-turn demonstrated", bool(story.get("autonomy", {}).get("multi_turn_context")) and bool(story.get("autonomy", {}).get("session_resumed")) and bool(story.get("autonomy", {}).get("follow_up_replanning_observed"))),
        ("observable plan", bool(story.get("autonomy", {}).get("observable_planning")) and bool(plan.get("steps")) and int(plan.get("revision", 0)) >= 1),
        ("plan revised after observable trigger", bool(story.get("autonomy", {}).get("adaptive_replanning_observed"))),
        ("agent loop", bool(story.get("autonomy", {}).get("autonomous_execution_observed")) and bool(story.get("autonomy", {}).get("agent_loop_observed"))),
        ("multiple capability types", int(story.get("autonomy", {}).get("distinct_capability_classes", 0)) >= 3),
        ("dataset snapshot", count_files(root, "data") >= 1),
        ("deterministic computation", count_files(root, "computations", ".json") >= 1),
        ("verified provenance claim", len(verified_with_compute) >= 1),
        ("visual output", count_files(root, "visualizations", ".svg") >= 1),
        ("responsive visual output", any(item.name.endswith(".mobile.svg") for item in (root / "visualizations").glob("*.svg")) if (root / "visualizations").is_dir() else False),
        ("editorial viz pipeline", all(name in tool_counts for name in ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render"])),
        ("editorial viz critic", tool_counts.get("newsroom_viz_critic", 0) >= 1),
        ("explanatory graphic pipeline", all(name in tool_counts for name in ["newsroom_explainer_plan", "newsroom_explainer_lint", "newsroom_explainer_render", "newsroom_explainer_critic"])),
        ("provenance-aware rich illustration", all(name in tool_counts for name in ["newsroom_illustration_plan", "newsroom_illustration_lint", "newsroom_illustration_generate", "newsroom_illustration_critic"]) and rich_illustration_passed),
        ("magazine infographic output", count_files(root, "infographics", ".svg") >= 2 and any(item.name.endswith(".mobile.svg") for item in (root / "infographics").glob("*.svg")) if (root / "infographics").is_dir() else False),
        ("magazine infographic pipeline", all(name in tool_counts for name in ["newsroom_infographic_plan", "newsroom_infographic_lint", "newsroom_infographic_render"])),
        ("magazine infographic critic", tool_counts.get("newsroom_infographic_critic", 0) >= 1),
        ("award-informed infographic rubric", award_critic),
        ("image-aware infographic review", tool_counts.get("newsroom_infographic_preview", 0) >= 1 and tool_counts.get("newsroom_infographic_vision_critic", 0) >= 1 and image_aware_critic),
        ("bounded image-aware revision", tool_counts.get("newsroom_infographic_revise", 0) >= 1 and bounded_visual_revision),
        ("competition-aware final preflight", tool_counts.get("newsroom_competition_preflight", 0) >= 1 and competition_preflight_passed),
        ("measured agent wall time", len(run_metrics) >= 2 and all(isinstance(row.get("duration_ms"), int) and row.get("duration_ms", -1) >= 0 for row in run_metrics)),
    ]

    passed = sum(ok for _, ok in checks)
    print(f"artifact: {root}")
    for label, ok in checks:
        print(f"{'PASS' if ok else 'MISS':4}  {label}")
    print(f"capability tools: {', '.join(capability_used) if capability_used else 'none'}")
    print(f"verified claims with source+computation: {len(verified_with_compute)}")
    print(f"demo gate: {passed}/{len(checks)}")
    if not integrity.passed:
        for error in integrity.errors[:12]:
            print(f"INTEGRITY  {error}")

    if tools.get("failed_tool_calls", 0) == 0:
        print("NOTE  no failure/recovery path was observed in this artifact")

    return 0 if passed == len(checks) else 2


if __name__ == "__main__":
    raise SystemExit(main())
