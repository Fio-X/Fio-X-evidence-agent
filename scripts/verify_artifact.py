#!/usr/bin/env python3
"""Independent integrity verifier for Agentic Data Newsroom artifacts."""
from __future__ import annotations

import argparse
import functools
import hashlib
import json
import math
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath


RENDER_QA_REPORT_SCHEMA_VERSION = "render-qa/1.0.0"


def strict_readers() -> bool:
    """NEWSROOM_VERIFY_STRICT_READERS=1 (exact, default off): read JSON the way news verify does and refuse values the
    verifier used to skip or coerce (non-finite numbers, non-ASCII digits, unreadable reports, non-object blocks)."""
    return os.environ.get("NEWSROOM_VERIFY_STRICT_READERS") == "1"


def load_json(path: Path):
    text = path.read_text(encoding="utf-8")
    return strict_loads(text) if strict_readers() else json.loads(text)


def finite_number(value):
    """The value as a float when it is a finite JSON number (not a bool, not a numeric string), else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_rows_json(value) -> str:
    """Canonical row wire form shared with runtime/pi/viz.mjs and Rust.

    Python, V8 and serde_json do not always emit the same shortest decimal
    spelling or halfway rounding for an IEEE-754 value. Non-integral row
    numbers therefore become six-decimal strings using explicit half-away-
    from-zero rounding; integral values remain numbers.
    """
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not (value == value and abs(value) != float("inf")):
            return "null"
        if value.is_integer() and abs(value) <= 9_007_199_254_740_991:
            return str(int(value))
        magnitude = math.floor(abs(value) * 1_000_000 + 0.5)
        if math.isfinite(magnitude) and magnitude <= 9_007_199_254_740_991:
            sign = "-" if value < 0 else ""
            fixed = f"{sign}{magnitude // 1_000_000}.{magnitude % 1_000_000:06d}"
            return json.dumps(fixed, ensure_ascii=False, separators=(",", ":"))
        return json.dumps(f"{value:.6f}", ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_rows_json(item) for item in value) + "]"
    if isinstance(value, dict):
        body = ",".join(
            json.dumps(str(key), ensure_ascii=False, separators=(",", ":"))
            + ":"
            + canonical_rows_json(value[key])
            for key in sorted(value)
        )
        return "{" + body + "}"
    return canonical_json(value)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()



EDITORIAL_DISCOVERY_VERSION = "0.1.0"
VISUAL_CONCEPT_SET_VERSION = "0.1.0"
SEMANTIC_NOVELTY_VERSION = "0.1.0"
ASSET_PLAN_VERSION = "0.1.0"
REFERENCE_CORPUS_VERSION = "0.1.0"
EXPERT_PREFERENCE_VERSION = "0.1.0"
AWARD_MODE_STATUS_VERSION = "0.1.0"
EDITORIAL_DIMENSIONS = {"trend", "rank", "spatial", "mechanism", "comparison", "distribution", "uncertainty", "human_scale", "method", "context"}
CONCEPT_FRAMINGS = {"spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal"}

def editorial_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("content_hash", None)
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()

def replay_discovery_decision(discovery: dict) -> str:
    questions = list(dict.fromkeys(str(v).strip() for v in discovery.get("candidate_questions") or [] if str(v).strip()))
    blocking = [item for item in discovery.get("missing_reporting") or [] if isinstance(item, dict) and item.get("blocking") is True]
    if discovery.get("kill_reasons") and len(questions) < 2:
        return "KILL"
    if blocking:
        return "RESEARCH_MORE"
    dimensions = [discovery.get("surprises"), discovery.get("human_scale_refs"), discovery.get("spatial_dimensions"), discovery.get("temporal_dimensions"), discovery.get("mechanisms"), discovery.get("uncertainties")]
    if len(questions) < 3 or not any(bool(items) for items in dimensions):
        return "REVISE"
    return "CONTINUE"

def score_visual_concept(concept: dict) -> int:
    evidence = set(str(x) for x in (concept.get("hero_evidence_refs") or []) + (concept.get("supporting_evidence_refs") or []))
    media = [str(x) for x in concept.get("media_mix") or []]
    distinctive = sum(1 for item in media if re.search(r"map|gis|illustration|photo|object|scene|3d|cutaway|timeline", item, re.I))
    assets = concept.get("asset_requirements") or []
    blocking = sum(1 for a in assets if isinstance(a, dict) and a.get("blocking") is True and a.get("available") is False)
    unavailable = sum(1 for a in assets if isinstance(a, dict) and a.get("available") is False)
    score = 38 + min(16, len(evidence) * 3) + min(14, distinctive * 4)
    score += 6 if concept.get("framing") in CONCEPT_FRAMINGS else 0
    score += 5 if len(str(concept.get("surprise") or "").strip()) >= 24 else 0
    score += 5 if len(str(concept.get("mobile_treatment") or "").strip()) >= 35 else 0
    score += 6 if len(str(concept.get("why_memorable") or "").strip()) >= 35 else 0
    score += 4 if len(str(concept.get("editorial_premise") or "").strip()) >= 40 else 0
    generic = re.search(r"dashboard|collection of charts|clean data story|magazine layout|standard charts|generic infographic", f"{concept.get('visual_metaphor','')} {concept.get('hero_scene','')}", re.I)
    score -= 18 if generic else 0
    score -= blocking * 24
    score -= max(0, unavailable - blocking) * 4
    score -= len(concept.get("risk_flags") or []) * 2
    return max(0, min(100, round(score)))

def replay_concept_finalists(concepts: list[dict]) -> list[str]:
    ranked = sorted(concepts, key=lambda c: (-score_visual_concept(c), str(c.get("concept_id", ""))))
    return [str(c.get("concept_id")) for c in ranked[: min(3, len(ranked))]]

def _tokens(value) -> set[str]:
    return {token for token in re.sub(r"[^a-z0-9\u00c0-\uffff]+", " ", str(value or "").lower()).split() if len(token) >= 3}

def _jaccard(a, b) -> float:
    aa, bb = set(a), set(b)
    if not aa and not bb:
        return 0.0
    return len(aa & bb) / max(1, len(aa | bb))

def replay_novelty(modules: list[dict]) -> tuple[list[dict], bool]:
    decisions = []
    high = 0
    for i, current in enumerate(modules):
        max_overlap = 0.0
        max_prior = None
        for prior in modules[:i]:
            q = 1.0 if str(current.get("reader_question_id", "")) == str(prior.get("reader_question_id", "")) else 0.0
            claims = _jaccard(current.get("claim_set") or [], prior.get("claim_set") or [])
            words = _jaccard(_tokens(current.get("new_information")), _tokens(prior.get("new_information")))
            dim = 1.0 if current.get("explanatory_dimension") == prior.get("explanatory_dimension") else 0.0
            overlap = 0.45*q + 0.35*claims + 0.15*words + 0.05*dim
            if str(prior.get("id")) in [str(x) for x in current.get("dependency_on") or []] and current.get("explanatory_dimension") != prior.get("explanatory_dimension"):
                overlap = max(0.0, overlap - 0.25)
            overlap = round(overlap, 4)
            if overlap > max_overlap:
                max_overlap, max_prior = overlap, str(prior.get("id"))
        level = "high" if max_overlap >= 0.72 else "medium" if max_overlap >= 0.58 else "low"
        action = "REMOVE_OR_JUSTIFY" if level == "high" else "DEMOTE_OR_JUSTIFY" if level == "medium" else "KEEP"
        if level == "high" and str(current.get("justification") or "").strip():
            action = "KEEP_WITH_JUSTIFICATION"
        elif level == "high":
            high += 1
        decisions.append({"module_id": str(current.get("id")), "max_overlap": round(max_overlap,4), "overlaps_most_with": max_prior, "redundancy": level, "action": action})
    return decisions, high == 0

PROGRAM_STATUS_SOURCE = "program_review_records"


def program_review_ok(root: Path, ref: str, baseline_ref: str, candidate_ref: str):
    """A review record the program saved itself, or None. Mirrors programReviewFromRecord in art_direction.mjs."""
    if not isinstance(ref, str) or not ref.startswith("editorial/human-reviews/"):
        return None
    try:
        record = load_json(safe_ref(root, ref))
    except Exception:
        return None
    if not isinstance(record, dict) or record.get("kind") != "program_saved_review" or record.get("saved_by") != "program":
        return None
    body = {k: v for k, v in record.items() if k != "content_hash"}
    if record.get("content_hash") != editorial_hash(body):
        return None
    if record.get("baseline_ref") != baseline_ref or record.get("candidate_ref") != candidate_ref:
        return None
    if record.get("preference") not in ("baseline", "candidate", "tie") or not re.fullmatch(r"[a-fA-F0-9]{16,64}", str(record.get("reviewer_id_hash") or "")):
        return None
    return record


def replay_program_preference(root: Path, item: dict) -> tuple[str, float, int]:
    records = [program_review_ok(root, ref, item.get("baseline_ref"), item.get("candidate_ref")) for ref in item.get("review_record_refs") or []]
    records = [r for r in records if r is not None]
    candidate = sum(1 for r in records if r["preference"] == "candidate")
    baseline = sum(1 for r in records if r["preference"] == "baseline")
    decisive = candidate + baseline
    share = candidate / decisive if decisive else 0.0
    minimum = int(item.get("minimum_reviewers") or 3)
    threshold = float(item.get("candidate_threshold") or 0.7)
    status = "PENDING" if len(records) < minimum else ("PASS" if share >= threshold else "FAIL")
    return status, round(share, 4), len(records)


def replay_asset_plan_decision(item: dict) -> str:
    reqs = item.get("requirements") or []
    if any(r.get("status") == "blocking" and r.get("available") is not True for r in reqs if isinstance(r, dict)):
        return "RESEARCH_MORE"
    if any(r.get("status") == "required" and r.get("available") is not True for r in reqs if isinstance(r, dict)):
        return "REVISE"
    return "CONTINUE"

def replay_preference_status(item: dict) -> tuple[str, float]:
    reviews = item.get("reviews") or []
    minimum = int(item.get("minimum_reviewers") or 3)
    if strict_readers():
        threshold = item.get("candidate_threshold")
        if threshold is None:
            threshold = 0.7  # only a missing or null threshold gets the default; 0, false, "", [] and {} are refused below
        # runtime/pi/art_direction.mjs has no range check; here a threshold must be a finite share in (0, 1], else a
        # negative or -inf one would turn any vote count into PASS.
        threshold = finite_number(threshold)
        if threshold is None or not 0 < threshold <= 1:
            raise ValueError("candidate_threshold must be a finite number in (0, 1]")
    else:
        threshold = float(item.get("candidate_threshold") or 0.7)
    candidate = sum(1 for r in reviews if isinstance(r, dict) and r.get("qualified") is True and r.get("preference") == "candidate")
    baseline = sum(1 for r in reviews if isinstance(r, dict) and r.get("qualified") is True and r.get("preference") == "baseline")
    decisive = candidate + baseline
    share = candidate / decisive if decisive else 0.0
    status = "PENDING" if len(reviews) < minimum else ("PASS" if share >= threshold else "FAIL")
    return status, round(share, 4)

# runtime/pi/infographic.mjs's own INFOGRAPHIC_SCHEMA_VERSIONS constant
# (infographic.mjs:18). Kept in sync by hand - the runtime module cannot be
# imported from this verifier's own process.
INFOGRAPHIC_SCHEMA_VERSIONS = {"1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"}
INFOGRAPHIC_COMPETITION_PROFILES = {
    "editorial", "snd47_infographics", "oja2026_visual", "sigma2026", "iib_awards"
}
VISION_PATCH_FIELDS = {"span", "emphasis", "priority", "move_before", "mobile_move_before"}
# Mirrors runtime/pi/vision.mjs PLAN_EDIT_MODULE_FIELDS / PLAN_EDIT_SCENE_FIELDS / PLAN_EDIT_MAX_OPS.
PLAN_EDIT_MODULE_FIELDS = VISION_PATCH_FIELDS
PLAN_EDIT_SCENE_FIELDS = ("pattern", "anchor_module_id", "sidecar_module_ids")

# K258 lean gates: the scene graph of a storyboard page is derived from its panels. Mirrors runtime/pi/storyboard.mjs
# deriveSceneGraphFromPanels (PANEL_SCENE_GOALS, hero_with_rail, one sidecar); scripts/test_lean_gates_verify.py runs both on the
# same fixture and they must agree.
PANEL_SCENE_GOALS = {"lead_in": "ORIENT", "scale": "MEASURE", "cause": "EXPLAIN", "space": "COMPARE", "compare": "COMPARE", "basis": "MEASURE"}
# EXPLAIN only for a mechanism chart body; other bodies fall back by visual grammar (mirrors storyboard.mjs panelSceneGoal).
EXPLAIN_EVIDENCE_GRAMMARS = ("mechanism",)
EXPLAIN_FALLBACK_GOALS = {"composition": "COMPARE", "rank": "COMPARE", "benchmark": "COMPARE", "distribution": "COMPARE", "spatial": "COMPARE", "change": "MEASURE", "trend": "MEASURE", "sequence": "MEASURE", "flow": "MEASURE"}
EXPLAIN_FALLBACK_DEFAULT = "MEASURE"


def panel_scene_goal(panel_kind, body: dict) -> str:
    goal = PANEL_SCENE_GOALS.get(panel_kind, "EXPLAIN")
    grammar = str(body.get("visual_grammar"))
    if goal != "EXPLAIN" or grammar in EXPLAIN_EVIDENCE_GRAMMARS:
        return goal
    return EXPLAIN_FALLBACK_GOALS.get(grammar, EXPLAIN_FALLBACK_DEFAULT)


def _module_claim_ids(module: dict) -> list[str]:
    seen: list[str] = []
    for value in [module.get("claim_id"), *(module.get("claim_ids") or []), *(module.get("claim_set") or [])]:
        if value and str(value) not in seen:
            seen.append(str(value))
    return seen


def derive_scene_graph(plan: dict) -> tuple[dict | None, list[str]]:
    errors: list[str] = []
    modules = plan.get("modules") or []
    by_id = {str(m.get("id")): m for m in modules}
    panels = sorted((m for m in modules if m.get("type") == "panel"), key=lambda m: (m.get("panel_no") or 0, str(m.get("id"))))
    scenes = []
    for panel in panels:
        body, note = by_id.get(str(panel.get("body_module_id") or "")), by_id.get(str(panel.get("note_module_id") or ""))
        if body is None or note is None:
            errors.append(f"panel '{panel.get('id')}' body_module_id or note_module_id is not a module of the page")
            continue
        if body.get("type") not in ("visual", "illustration"):
            continue
        claims: list[str] = []
        for member in (body, note):
            for claim in _module_claim_ids(member):
                if claim not in claims:
                    claims.append(claim)
        scenes.append({
            "id": f"scene-{panel.get('id')}",
            "pattern": "hero_with_rail",
            "anchor_module_id": str(body.get("id")),
            "sidecar_module_ids": [str(note.get("id"))],
            "primary_cognitive_goal": panel_scene_goal(panel.get("panel_kind"), body),
            "hero_object_id": str(body.get("id")),
            "supporting_claim_ids": _module_claim_ids(body),
            "scene_budget": {
                "max_supporting_objects": 1,
                "max_annotations": min(8, sum(len(m.get("annotations") or []) for m in (body, note))),
                "max_claims": min(12, max(1, len(claims))),
            },
        })
    if not errors and not scenes:
        errors.append("no panel has a visual or illustration body, so there is no scene to derive")
    if len(scenes) > 6:
        errors.append(f"{len(scenes)} panels have a visual or illustration body; a scene graph holds at most 6 scenes")
    return (None, errors) if errors else ({"schema_version": "0.2.0", "scenes": scenes}, errors)


def lean_scene_graph_issues(plan: dict) -> list[str]:
    """Lean page with panels: the plan's scene graph must be the one the panels give. pattern, anchor and sidecars are the three
    fields a recorded plan edit may change (PLAN_EDIT_SCENE_FIELDS), so they are left out of the comparison; the edit chain checks them."""
    derived, errors = derive_scene_graph(plan)
    if derived is None:
        return [f"scene graph cannot be derived from the panels: {'; '.join(errors)}"]
    given = plan.get("scene_graph")
    if not isinstance(given, dict) or not isinstance(given.get("scenes"), list):
        return ["lean page plan has no scene_graph to match the panels"]
    def strip(graph: dict) -> dict:
        return {**graph, "scenes": [{k: v for k, v in scene.items() if k not in PLAN_EDIT_SCENE_FIELDS} for scene in graph["scenes"]]}
    return [] if strip(given) == strip(derived) else ["scene_graph does not match the one the panels derive (lean gates: it is generated from the panels, not written)"]
PLAN_EDIT_MAX_OPS = 12
COMPETITION_POLICY_FLOORS = {
    "editorial": {
        "deterministic_score": 88, "vision_score": 80,
        "deterministic": {}, "vision": {"legibility": 75, "source_legibility": 75, "responsive_quality": 75},
        "forbidden_origins": set(),
    },
    "snd47_infographics": {
        "deterministic_score": 92, "vision_score": 84,
        "deterministic": {"clarity_information_flow": 88, "hierarchy": 86, "inclusion_accessibility": 86, "responsive_execution": 86, "craft_geometry": 84},
        "vision": {"hierarchy": 82, "legibility": 84, "composition": 82, "source_legibility": 84, "responsive_quality": 84, "editorial_distinctiveness": 78},
        "forbidden_origins": {"generative_ai", "mixed"},
    },
    "oja2026_visual": {
        "deterministic_score": 92, "vision_score": 85,
        "deterministic": {"impact_story_focus": 85, "clarity_information_flow": 86, "effectiveness": 86, "responsive_execution": 88, "originality_variety": 78},
        "vision": {"hierarchy": 82, "legibility": 84, "composition": 84, "responsive_quality": 88, "editorial_distinctiveness": 82},
        "forbidden_origins": set(),
    },
    "sigma2026": {
        "deterministic_score": 90, "vision_score": 82,
        "deterministic": {"impact_story_focus": 84, "clarity_information_flow": 86, "effectiveness": 86, "originality_variety": 78},
        "vision": {"legibility": 82, "composition": 80, "source_legibility": 82, "editorial_distinctiveness": 78},
        "forbidden_origins": set(),
    },
    "iib_awards": {
        "deterministic_score": 92, "vision_score": 84,
        "deterministic": {"impact_story_focus": 85, "engagement": 82, "clarity_information_flow": 88, "effectiveness": 86, "inclusion_accessibility": 85, "originality_variety": 80},
        "vision": {"legibility": 84, "composition": 84, "visual_coherence": 82, "color_contrast": 82, "editorial_distinctiveness": 82},
        "forbidden_origins": set(),
    },
}


def normalize_revision_source(plan: dict) -> dict:
    normalized = json.loads(json.dumps(plan))
    normalized.pop("content_hash", None)
    if normalized.get("schema_version") == "1.1.0":
        normalized["schema_version"] = "1.2.0"
    if normalized.get("schema_version") in {"1.2.0", "1.3.0"} and not normalized.get("competition_profile"):
        normalized["competition_profile"] = "editorial"
    return normalized


def infographic_immutable_projection(plan: dict) -> dict:
    projected = normalize_revision_source(plan)
    projected.pop("mobile_module_order", None)
    modules = []
    for module in projected.get("modules") or []:
        item = dict(module)
        for key in ("span", "emphasis", "priority"):
            item.pop(key, None)
        modules.append(item)
    projected["modules"] = sorted(modules, key=lambda item: str(item.get("id", "")))
    return projected


def infographic_immutable_hash(plan: dict) -> str:
    payload = canonical_json(infographic_immutable_projection(plan)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _move_before(order: list[str], target: str, before: str) -> list[str]:
    if target == before or target not in order or before not in order:
        raise ValueError(f"invalid move_before patch {target!r} -> {before!r}")
    next_order = [item for item in order if item != target]
    next_order.insert(next_order.index(before), target)
    return next_order


def replay_infographic_patches(source: dict, patches: list[dict]) -> dict:
    next_plan = normalize_revision_source(source)
    ids = [str(module.get("id")) for module in next_plan.get("modules") or []]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("source infographic modules must have unique ids")
    mobile_order = list(next_plan.get("mobile_module_order") or ids)
    if sorted(mobile_order) != sorted(ids) or len(mobile_order) != len(ids):
        raise ValueError("source mobile_module_order is not an exact module permutation")
    seen = set()
    for patch in patches:
        target = str(patch.get("target_module_id", ""))
        field = patch.get("field")
        value = str(patch.get("value", ""))
        if target not in ids or field not in VISION_PATCH_FIELDS:
            raise ValueError(f"invalid visual revision patch: {patch!r}")
        pair = (target, field)
        if pair in seen:
            raise ValueError(f"duplicate visual revision patch: {pair!r}")
        seen.add(pair)
        if field == "span" and value not in {"full", "half", "two_thirds", "third"}:
            raise ValueError(f"invalid span patch: {value!r}")
        if field == "emphasis" and value not in {"hero", "primary", "secondary", "support"}:
            raise ValueError(f"invalid emphasis patch: {value!r}")
        if field == "priority" and value not in {"1", "2", "3", "4", "5"}:
            raise ValueError(f"invalid priority patch: {value!r}")
        if field in {"move_before", "mobile_move_before"} and value not in ids:
            raise ValueError(f"invalid move target: {value!r}")
        by_id = {str(module.get("id")): module for module in next_plan.get("modules") or []}
        if field == "span":
            by_id[target]["span"] = value
        elif field == "emphasis":
            by_id[target]["emphasis"] = value
        elif field == "priority":
            by_id[target]["priority"] = int(value)
        elif field == "move_before":
            order = [str(module.get("id")) for module in next_plan.get("modules") or []]
            order = _move_before(order, target, value)
            next_plan["modules"] = [by_id[item] for item in order]
        elif field == "mobile_move_before":
            mobile_order = _move_before(mobile_order, target, value)
    next_plan["mobile_module_order"] = mobile_order
    return next_plan


def _js_json(value):
    # JSON.stringify prints an integral number without ".0".
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _js_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_js_json(v) for v in value]
    return value


def infographic_plan_content_hash(plan: dict) -> str:
    core = {k: v for k, v in plan.items() if k != "content_hash"}
    text = json.dumps(_js_json(core), separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def replay_plan_edits(source: dict, ops: list) -> dict:
    """Independent replay of newsroom_infographic_edit: only the module and scene fields the tool exposes."""
    if not isinstance(ops, list) or not 1 <= len(ops) <= PLAN_EDIT_MAX_OPS:
        raise ValueError(f"applied_edits must hold 1..{PLAN_EDIT_MAX_OPS} items")
    plan = json.loads(json.dumps(source))
    plan.pop("content_hash", None)
    modules = plan.get("modules") or []
    ids = [str(m.get("id")) for m in modules]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("source infographic modules must have unique ids")
    scenes = (plan.get("scene_graph") or {}).get("scenes") or []
    scene_ids = {str(sc.get("id")) for sc in scenes}
    mobile_order = list(plan["mobile_module_order"]) if isinstance(plan.get("mobile_module_order"), list) and len(plan["mobile_module_order"]) == len(ids) else None
    seen = set()
    for op in ops:
        if not isinstance(op, dict) or set(op) != {"scope", "id", "field", "value"}:
            raise ValueError(f"invalid plan edit: {op!r}")
        scope, field, value, target = op["scope"], op["field"], op["value"], str(op["id"])
        if scope not in ("module", "scene"):
            raise ValueError(f"invalid plan edit scope: {scope!r}")
        if field not in (PLAN_EDIT_MODULE_FIELDS if scope == "module" else PLAN_EDIT_SCENE_FIELDS):
            raise ValueError(f"field {field!r} is not editable on a {scope}")
        if target not in (set(ids) if scope == "module" else scene_ids):
            raise ValueError(f"plan edit refers to unknown {scope} {target!r}")
        key = (scope, target, field)
        if key in seen:
            raise ValueError(f"duplicate plan edit: {key!r}")
        seen.add(key)
        if field == "span" and value not in {"full", "half", "two_thirds", "third"}:
            raise ValueError(f"invalid span: {value!r}")
        if field == "emphasis" and value not in {"hero", "primary", "secondary", "support"}:
            raise ValueError(f"invalid emphasis: {value!r}")
        if field == "priority" and not (isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 5):
            raise ValueError(f"invalid priority: {value!r}")
        if field in {"move_before", "mobile_move_before", "anchor_module_id"} and not (isinstance(value, str) and value in ids):
            raise ValueError(f"{field} must name an existing module: {value!r}")
        if field == "pattern" and value not in {"hero_sidecar_stack", "hero_with_rail"}:
            raise ValueError(f"invalid scene pattern: {value!r}")
        if field == "sidecar_module_ids" and not (isinstance(value, list) and 1 <= len(value) <= 3 and len(set(value)) == len(value) and all(isinstance(v, str) and v in ids for v in value)):
            raise ValueError(f"invalid sidecar_module_ids: {value!r}")
        by_id = {str(m.get("id")): m for m in plan["modules"]}
        if scope == "scene":
            next(sc for sc in scenes if str(sc.get("id")) == target)[field] = json.loads(json.dumps(value))
        elif field == "move_before":
            order = _move_before([str(m.get("id")) for m in plan["modules"]], target, value)
            plan["modules"] = [by_id[i] for i in order]
        elif field == "mobile_move_before":
            mobile_order = _move_before(mobile_order if mobile_order is not None else ids, target, value)
        else:
            by_id[target][field] = value
    if mobile_order is not None:
        plan["mobile_module_order"] = mobile_order
    return plan


def plan_edit_immutable_hash(plan: dict) -> str:
    projected = infographic_immutable_projection(plan)
    scene_graph = projected.get("scene_graph")
    if isinstance(scene_graph, dict) and isinstance(scene_graph.get("scenes"), list):
        projected["scene_graph"] = {**scene_graph, "scenes": [{k: v for k, v in sc.items() if k not in PLAN_EDIT_SCENE_FIELDS} for sc in scene_graph["scenes"]]}
    return hashlib.sha256(canonical_json(projected).encode("utf-8")).hexdigest()


def competition_non_finite_values(profile: str, deterministic: dict, vision: dict) -> list[str]:
    """Critic score and floor-rubric fields that are present and not null but not a finite JSON number.

    A missing or null value stays "below the floor" in the recomputation (the runtime's numeric() does the same and JS
    writes NaN as null); any other non-number (a string, bool, list, object) is an integrity failure whatever the
    preflight's machine_passed says, because it would otherwise make the recomputed pass and a forged one agree.
    """
    policy = COMPETITION_POLICY_FLOORS.get(profile)
    if not policy:
        return []
    problems = []
    for name, critic, floors in (("deterministic", deterministic, policy["deterministic"]), ("vision", vision, policy["vision"])):
        rubric = critic.get("rubric")
        fields = [("score", critic.get("score"))] + [(f"rubric.{key}", rubric.get(key) if isinstance(rubric, dict) else None) for key in floors]
        for field, value in fields:
            if value is not None and finite_number(value) is None:
                problems.append(f"{name}.{field}")
    return problems


def recompute_competition_machine_pass(profile: str, deterministic: dict, vision: dict, origins: list[str]) -> tuple[bool, list[str]]:
    policy = COMPETITION_POLICY_FLOORS.get(profile)
    if not policy:
        return False, ["unknown_profile"]
    failures = []
    if deterministic.get("passed") is not True:
        failures.append("deterministic_critic_not_passing")
    if vision.get("passed") is not True:
        failures.append("vision_critic_not_passing")
    # The runtime writes critic scores as finite JSON numbers (competition.mjs numeric(), vision.mjs Number()); anything
    # else (NaN compares False with every floor, "inf" and 1e400 parse as infinity) counts as below the floor.
    def below(value, floor):
        if strict_readers():
            number = finite_number(value)
            return number is None or number < floor
        try:
            return float(value) < floor
        except (TypeError, ValueError):
            return True

    if below(deterministic.get("score"), policy["deterministic_score"]):
        failures.append("deterministic_score_below_profile")
    if below(vision.get("score"), policy["vision_score"]):
        failures.append("vision_score_below_profile")
    for key, floor in policy["deterministic"].items():
        if below((deterministic.get("rubric") or {}).get(key), floor):
            failures.append(f"deterministic_rubric_floor:{key}")
    for key, floor in policy["vision"].items():
        if below((vision.get("rubric") or {}).get(key), floor):
            failures.append(f"vision_rubric_floor:{key}")
    if any(origin in policy["forbidden_origins"] for origin in origins):
        failures.append("illustration_origin_ineligible")
    return not failures, failures


@functools.lru_cache(maxsize=32)
def _resolved_root(root: Path) -> Path:
    # Artifact roots are immutable for the duration of one verifier process.
    # Cache only the root canonicalization; child refs are still resolved on
    # every check so symlink/path escape mutations remain fail-closed.
    return root.resolve()


def page_binding_matches_manifest(root: Path, binding: dict, svg_ref: str, infographic_plan_ref: str) -> bool:
    """A `page` evidence binding: the raw svg bytes hash to hashes.desktop_sha256 of the infographic render manifest named by
    manifest_ref (naming this svg as variants.desktop). The manifest must be the top-level render manifest
    infographics/<key>.json beside infographics/<key>.svg (the shape resolveEmbeddedPage in runtime/pi/newsroom.ts accepts, via
    findTopLevelInfographicManifestByPlanRef) with plan_ref equal to the publication plan's infographic_plan_ref. Mirrors src/verify.rs."""
    manifest_ref = binding.get("manifest_ref")
    m = re.fullmatch(r"infographics/([^/]+)\.svg", svg_ref) if isinstance(svg_ref, str) else None
    if not m or manifest_ref != f"infographics/{m.group(1)}.json":
        return False
    if not isinstance(infographic_plan_ref, str) or not infographic_plan_ref:
        return False
    try:
        manifest = load_json(safe_ref(root, manifest_ref))
        if not isinstance(manifest, dict) or manifest.get("plan_ref") != infographic_plan_ref:
            return False
        if (manifest.get("variants") or {}).get("desktop") != svg_ref:
            return False
        expected = (manifest.get("hashes") or {}).get("desktop_sha256")
        return isinstance(expected, str) and sha256_file(safe_ref(root, svg_ref)) == expected
    except Exception:
        return False


def safe_ref(root: Path, ref: str) -> Path:
    p = PurePosixPath(ref)
    if not ref or p.is_absolute() or ".." in p.parts:
        raise ValueError(f"unsafe relative artifact reference: {ref!r}")
    full = root.joinpath(*p.parts)
    try:
        full.resolve().relative_to(_resolved_root(root))
    except ValueError as exc:
        raise ValueError(f"artifact reference escapes root: {ref!r}") from exc
    return full


def _pdf_page_markers(text: str) -> list[tuple[int, int, int]]:
    """Finds every `[page N]\\n` marker runtime/pi/pdf_extract.mjs's
    formatPagesWithMarkers writes into a saved PDF source's text. Returns
    (page_number, marker_start, content_start) triples in order; a plain
    substring scan, not a regex, since the marker is a fixed ASCII literal."""
    marks: list[tuple[int, int, int]] = []
    search_from = 0
    while True:
        start = text.find("[page ", search_from)
        if start == -1:
            break
        digits_start = start + len("[page ")
        end = digits_start
        while end < len(text) and text[end].isdigit():
            end += 1
        if end > digits_start and text[end:end + 2] == "]\n":
            marks.append((int(text[digits_start:end]), start, end + 2))
        search_from = start + len("[page ")
    return marks


def source_page_text(text: str, page: int) -> str | None:
    """A source with no `[page N]` markers (HTML/plain-text extraction, which
    has no page concept) collapses to a single implicit page 1, so a
    source_quote module is shaped identically whether or not its source
    happens to be a paginated PDF."""
    marks = _pdf_page_markers(text)
    if not marks:
        return text if page == 1 else None
    for index, (mark_page, _start, content_start) in enumerate(marks):
        if mark_page != page:
            continue
        content_end = marks[index + 1][1] if index + 1 < len(marks) else len(text)
        return text[content_start:content_end]
    return None


def normalize_source_quote_text(value: str) -> str:
    """Whitespace-collapse and line-break-hyphenation joins only - nothing
    semantic - mirroring runtime/pi/infographic.mjs's
    normalizeSourceQuoteText and the Rust verifier's
    normalize_source_quote_text exactly, so all three verbatim-quote checks
    accept and reject the same inputs."""
    return " ".join(str(value or "").replace("-\n", "").split())


SOURCE_QUOTE_PROSE_MAX_CHARS = 60


def _is_source_quote_prose_digit_or_percent(ch: str) -> bool:
    # ASCII digit, full-width digit (U+FF10-U+FF19), or '%' - mirrors
    # runtime/pi/infographic.mjs's SOURCE_QUOTE_PROSE_FORBIDDEN and
    # src/verify.rs's is_source_quote_prose_digit_or_percent exactly.
    return ch.isascii() and ch.isdigit() or "０" <= ch <= "９" or ch == "%"


def check_source_quote_prose_field(report: "Report", manifest_ref: str, module_id, field: str, value: str) -> None:
    # A text module's body/heading are bound to neither its source_quote
    # nor any claim, so free prose sitting next to a source-only quote must
    # stay short and free of anything that could pass for a verified figure.
    report.check(
        len(value) <= SOURCE_QUOTE_PROSE_MAX_CHARS,
        f"infographic {manifest_ref} text module '{module_id}' source_quote {field} must be at most {SOURCE_QUOTE_PROSE_MAX_CHARS} characters",
    )
    report.check(
        not any(_is_source_quote_prose_digit_or_percent(ch) for ch in value),
        f"infographic {manifest_ref} text module '{module_id}' source_quote {field} must not contain digits or a percent sign: a source-only note must never look like a verified figure",
    )


def verify_infographic_source_quotes(root: Path, manifest_ref: str, plan: dict, plan_language: str, desktop_svg_ref, report: "Report") -> None:
    """Rechecks every text module's source_quote (runtime/pi/infographic.mjs's
    InfographicSpec extension) against the saved source's own bytes, read
    fresh from artifacts here - never trusted from the plan or the lint
    record - so an edited quote, a wrong page, or a source swapped after
    planning fails verification even if lint once passed. Also confirms the
    rendered desktop SVG visibly carries the page number and, on a zh page,
    the 译述 translation label, so a source-only note can never look
    indistinguishable from a verified finding. Mirrors
    verify_infographic_source_quotes in src/verify.rs."""
    desktop_svg_text = None
    if isinstance(desktop_svg_ref, str):
        try:
            svg_path = safe_ref(root, desktop_svg_ref)
            if svg_path.is_file():
                desktop_svg_text = svg_path.read_text(encoding="utf-8")
        except Exception:
            desktop_svg_text = None
    for module in plan.get("modules") or []:
        if not isinstance(module, dict) or module.get("type") != "text":
            continue
        sq = module.get("source_quote")
        if not sq:
            continue
        module_id = module.get("id", "?")
        body = module.get("body")
        if isinstance(body, str) and body.strip():
            check_source_quote_prose_field(report, manifest_ref, module_id, "body", body)
        heading = module.get("heading")
        if isinstance(heading, str) and heading.strip():
            check_source_quote_prose_field(report, manifest_ref, module_id, "heading", heading)
        source_ref = sq.get("source_ref")
        page = sq.get("page")
        quote = sq.get("quote")
        translation = sq.get("translation")
        if not isinstance(page, int) or isinstance(page, bool) or page < 1:
            report.check(False, f"infographic {manifest_ref} text module '{module_id}' source_quote has no integer page")
            continue
        try:
            source_path = safe_ref(root, str(source_ref))
        except Exception as exc:
            report.check(False, f"infographic {manifest_ref} text module '{module_id}' source_quote has an unsafe source_ref: {exc}")
            continue
        if not source_path.is_file():
            report.check(False, f"infographic {manifest_ref} text module '{module_id}' source_quote references missing source: {source_ref}")
            continue
        try:
            source = load_json(source_path)
        except Exception as exc:
            report.check(False, f"infographic {manifest_ref} text module '{module_id}' source_quote source is not valid JSON: {exc}")
            continue
        payload = {
            "content_type": source.get("content_type"),
            "final_url": source.get("final_url"),
            "status": source.get("status"),
            "text": source.get("text"),
            "truncated": source.get("truncated"),
        }
        expected_hash = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
        recorded_hash = source.get("content_hash")
        report.check(recorded_hash == expected_hash, f"infographic {manifest_ref} text module '{module_id}' source_quote source content_hash mismatch: {source_ref}")
        source_text = str(source.get("text") or "")
        page_text = source_page_text(source_text, page)
        needle = normalize_source_quote_text(quote or "")
        matched = bool(needle) and page_text is not None and needle in normalize_source_quote_text(page_text)
        report.check(matched, f"infographic {manifest_ref} text module '{module_id}' source_quote text does not appear verbatim on page {page} of {source_ref}")
        if desktop_svg_text is None:
            report.check(False, f"infographic {manifest_ref} text module '{module_id}' has a source_quote but the desktop SVG could not be read to confirm its labels")
            continue
        report.check(str(page) in desktop_svg_text, f"infographic {manifest_ref} text module '{module_id}' rendered page does not show the source_quote page number")
        if plan_language == "zh":
            report.check(bool(translation), f"infographic {manifest_ref} text module '{module_id}' zh page source_quote is missing its required translation")
        if translation:
            report.check("译述" in desktop_svg_text, f"infographic {manifest_ref} text module '{module_id}' has a translation but the rendered page has no 译述 label")


def concept_min_count() -> int:
    # NEWSROOM_CONCEPT_COUNT_3=1 (exact) relaxes only the lower bound of the concept count, 8 -> 3; runtime/pi/newsroom.ts conceptMinCount() is the same rule.
    return 3 if os.environ.get("NEWSROOM_CONCEPT_COUNT_3") == "1" else 8


def replay_award_mode_status(item: dict) -> tuple[str, list[str]]:
    refs = item.get("refs") or {}
    metrics = item.get("metrics") or {}
    required_refs = ["discovery_ref", "concepts_ref", "asset_plan_ref", "novelty_ref", "page_ref"]
    missing_refs = [key for key in required_refs if not str(refs.get(key) or "").strip()]
    concepts_generated = int(metrics.get("concepts_generated") or 0)
    concepts_killed = int(metrics.get("concepts_killed") or 0)
    concept_ok = concept_min_count() <= concepts_generated <= 20 and concepts_killed >= ((concepts_generated + 1) // 2)
    prototype_ok = int(metrics.get("prototype_count") or 0) >= 2
    raster_ok = int(metrics.get("raster_revision_count") or 0) >= 1
    blockers = []
    if missing_refs:
        blockers.append("missing_refs:" + ",".join(missing_refs))
    if not concept_ok:
        blockers.append("concept_search_budget_not_met")
    if not prototype_ok:
        blockers.append("prototype_budget_not_met")
    if not raster_ok:
        blockers.append("raster_review_not_observed")
    preference = str(item.get("preference_status") or "PENDING").upper()
    if blockers:
        return "BLOCKED", blockers
    if preference == "FAIL":
        return "FAIL", blockers
    if preference == "PASS":
        return "PASS", blockers
    return "READY_FOR_HUMAN", blockers


@dataclass
class Report:
    checks: int = 0
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def check(self, ok: bool, message: str):
        self.checks += 1
        if not ok:
            self.errors.append(message)

    @property
    def passed(self) -> bool:
        return not self.errors


def verify_input_fingerprint(root: Path, fingerprint: str, report: Report, cache: set[str] | None = None):
    if cache is not None and fingerprint in cache:
        return
    if fingerprint.startswith("data:"):
        body = fingerprint[len("data:"):]
        if ":" not in body:
            report.check(False, f"malformed data input fingerprint: {fingerprint}")
            return
        ref, expected = body.rsplit(":", 1)
        try:
            path = safe_ref(root, ref)
            report.check(path.is_file(), f"input fingerprint dataset missing: {ref}")
            if path.is_file():
                report.check(sha256_file(path) == expected, f"input fingerprint dataset hash mismatch: {ref}")
        except Exception as exc:
            report.check(False, f"unsafe data input fingerprint {fingerprint}: {exc}")
        if cache is not None:
            cache.add(fingerprint)
        return
    if fingerprint.startswith("source:"):
        body = fingerprint[len("source:"):]
        if ":" not in body:
            report.check(False, f"malformed source input fingerprint: {fingerprint}")
            return
        filename, expected = body.rsplit(":", 1)
        try:
            path = safe_ref(root, f"sources/{filename}")
            report.check(path.is_file(), f"input fingerprint source missing: sources/{filename}")
            if path.is_file():
                source = load_json(path)
                report.check(source.get("content_hash") == expected, f"input fingerprint source hash mismatch: sources/{filename}")
        except Exception as exc:
            report.check(False, f"unsafe source input fingerprint {fingerprint}: {exc}")
        if cache is not None:
            cache.add(fingerprint)
        return
    report.check(False, f"unknown input fingerprint kind: {fingerprint}")

def jsonl(path: Path):
    rows = []
    if not path.is_file():
        return rows
    for no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(strict_loads(line) if strict_readers() else json.loads(line))
        except (json.JSONDecodeError, ClaimsLineRefused) as exc:
            rows.append({"__parse_error__": f"line {no}: {exc}"})
    return rows


# Rust's str::trim() strips Unicode White_Space only; Python's str.strip() also strips U+001C..U+001F, so a line of
# those would be skipped as blank here but refused by `news verify`.
RUST_WHITESPACE = frozenset("\t\n\x0b\x0c\r \x85\xa0\u1680\u2028\u2029\u202f\u205f\u3000") | frozenset(chr(c) for c in range(0x2000, 0x200B))
# serde_json's recursion limit: a line nested 128 containers deep is refused, 127 is read.
CLAIMS_MAX_NESTING = 127


class ClaimsLineRefused(ValueError):
    """A JSON text Rust's serde_json refuses; a ValueError so every existing JSON-error handler reports it."""


def _claims_refuse_constant(name):
    raise ClaimsLineRefused(f"{name} is not valid JSON")


def _claims_float(text):
    value = float(text)
    if value in (float("inf"), float("-inf")):
        raise ClaimsLineRefused(f"number {text[:20]}... is out of range")
    return value


def _claims_int(text):
    # Rust reads an integer past 64 bits as f64 and refuses it when that overflows (about 309 digits); an in-range
    # integer stays an exact Python int.
    if len(text) > 19:
        _claims_float(text)
    return int(text)


def _claims_check_nesting(line):
    depth = 0
    in_string = False
    escaped = False
    for char in line:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "[{":
            depth += 1
            if depth > CLAIMS_MAX_NESTING:
                raise ClaimsLineRefused("JSON is nested too deeply")
        elif char in "]}":
            depth -= 1


def _claims_no_lone_surrogates(value):
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if any("\ud800" <= char <= "\udfff" for char in item):
                raise ClaimsLineRefused("string holds a lone surrogate")
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, dict):
            for key, child in item.items():
                stack.append(key)
                stack.append(child)


def strict_loads(text):
    """json.loads that refuses what serde_json refuses: NaN, Infinity, f64 overflow, deep nesting, lone surrogates."""
    _claims_check_nesting(text)
    try:
        record = json.loads(text, parse_constant=_claims_refuse_constant, parse_float=_claims_float, parse_int=_claims_int)
    except ClaimsLineRefused:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ClaimsLineRefused(f"invalid JSON: {exc}")
    _claims_no_lone_surrogates(record)
    return record


def parse_claims_line(raw):
    """Parse one claims.jsonl line (bytes) the way Rust's verify_claims does, or raise ClaimsLineRefused."""
    try:
        line = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ClaimsLineRefused("line is not valid UTF-8")
    return strict_loads(line)


def claims_lines(path):
    """Yield (file line number, bytes) for each non-blank line, splitting at \\n only like BufReader::lines()."""
    data = path.read_bytes()
    parts = data.split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    for line_no, raw in enumerate(parts, 1):
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        try:
            blank = all(char in RUST_WHITESPACE for char in raw.decode("utf-8"))
        except UnicodeDecodeError:
            blank = False
        if not blank:
            yield line_no, raw


def system_verified_claim(claim):
    verification = claim.get("verification")
    if strict_readers():
        if not isinstance(verification, dict):
            return False
    else:
        verification = verification or {}
    return (
        claim.get("status") == "verified"
        and verification.get("authority") == "system"
        and verification.get("rule_id") == "verification.source+extraction+computation+claim.v1"
        and all(verification.get(key) is True for key in ("source_resolved", "extraction_passed", "computation_replayed", "claim_supported", "publishable"))
    )


def verify_qa_screenshot_entry(qa_dir: Path, entry: dict, label: str, manifest_ref: str, report: "Report") -> bool:
    path_field = entry.get("path") if isinstance(entry, dict) else None
    expected_sha = entry.get("sha256") if isinstance(entry, dict) else None
    safe_name = (
        isinstance(path_field, str)
        and bool(path_field)
        and "/" not in path_field
        and "\\" not in path_field
        and path_field not in (".", "..")
    )
    if not safe_name:
        report.check(False, f"publication {manifest_ref} browser QA {label} has an invalid path: {path_field}")
        return False
    shot_path = qa_dir / path_field
    if not shot_path.is_file():
        report.check(False, f"publication {manifest_ref} browser QA {label} file is missing: {path_field}")
        return False
    try:
        actual = sha256_file(shot_path)
    except Exception as exc:
        report.check(False, f"publication {manifest_ref} failed hashing browser QA {label} {path_field}: {exc}")
        return False
    if isinstance(expected_sha, str) and expected_sha and actual == expected_sha:
        return True
    report.check(False, f"publication {manifest_ref} browser QA {label} sha256 mismatch: {path_field}")
    return False


def verify_qa_screenshots(qa_dir: Path, qa_report: dict, manifest_ref: str, report: "Report") -> bool:
    # Verifies every entry in a browser-qa.json report's `screenshots` list
    # and its `archive_fallback`, if present. Returns False (and records
    # specific errors) if any listed file is missing, unsafe, or does not
    # hash to its own claimed sha256. Mirrors the Rust verifier's
    # verify_qa_screenshots/verify_qa_screenshot_entry exactly - see
    # runtime/pi/browser_qa.py's shots.append({"width", "path", "sha256"})
    # and archive dict for the shape being checked.
    ok = True
    screenshots = qa_report.get("screenshots")
    if isinstance(screenshots, list):
        for shot in screenshots:
            if not verify_qa_screenshot_entry(qa_dir, shot, "screenshot", manifest_ref, report):
                ok = False
    archive = qa_report.get("archive_fallback")
    if archive is not None:
        if not verify_qa_screenshot_entry(qa_dir, archive, "archive_fallback", manifest_ref, report):
            ok = False
    return ok


_CHOROPLETH_TAG_ATTR_RE = re.compile(r'([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"')


def _choropleth_tag_attrs(tag: str) -> dict:
    return dict(_CHOROPLETH_TAG_ATTR_RE.findall(tag))


def _choropleth_path_tags_with_role(svg_text: str, role: str) -> list[str]:
    out = []
    for m in re.finditer(r"<path\b[^>]*?/?>", svg_text, re.S):
        tag = m.group(0)
        if _choropleth_tag_attrs(tag).get("data-role") == role:
            out.append(tag)
    return out


def _choropleth_text_nodes_with_role(svg_text: str, roles: tuple[str, ...]) -> list[tuple[str, str]]:
    # Returns (opening_tag, body) pairs for every <text ...>body</text> whose
    # data-role is one of roles.
    out = []
    for m in re.finditer(r"<text\b[^>]*?>(.*?)</text>", svg_text, re.S):
        tag_end = m.start(1) - 1  # rewind past the '>' the (.*?) group starts after
        open_tag = svg_text[m.start(0):tag_end + 1]
        if _choropleth_tag_attrs(open_tag).get("data-role") in roles:
            out.append((open_tag, m.group(1)))
    return out


def _choropleth_label_body_text(body: str) -> str:
    # Prefers the first <tspan>...</tspan>'s inner text (on-map/inset
    # layout, where a second tspan may carry a reference period); otherwise
    # strips any tags from the bare body (margin/overflow layout, where
    # truncation shows up as a literal "…"). Mirrors
    # runtime/pi/render_qa_labels.mjs's labelText, written fresh here rather
    # than shared, and Rust's label_body_text.
    tspan_m = re.search(r"<tspan\b[^>]*>(.*?)</tspan>", body, re.S)
    text = tspan_m.group(1) if tspan_m else body
    return re.sub(r"<[^>]+>", "", text).strip()


_LEADING_NUMBER_RE = re.compile(r"^(-?\d+(?:\.\d+)?)")


def _choropleth_leading_number_with_scale(text: str) -> float | None:
    # Applies a trailing k/m/bn scale suffix exactly like
    # runtime/pi/viz.mjs's choroplethValueText ("1.2m" means 1_200_000, not
    # 1.2); any other trailing suffix (percent sign, currency symbol, bare
    # unit word) leaves the number's own scale alone. Returns None when
    # there is no leading number at all (missing, truncated, or a bare "…").
    m = _LEADING_NUMBER_RE.match(text)
    if not m:
        return None
    number = float(m.group(1))
    rest = text[m.end():].lower()
    if rest.startswith("bn"):
        scale = 1_000_000_000.0
    elif rest.startswith("m"):
        scale = 1_000_000.0
    elif rest.startswith("k"):
        scale = 1_000.0
    else:
        scale = 1.0
    return number * scale


_ZH_SCALE_SUFFIXES = (("万亿", 12), ("亿", 8), ("万", 4))
_ZH_PLAIN_UNIT_LABEL_RE = re.compile(r"^(-?\d+\.\d) (.+)$")
_ZH_UNIT_SCALE_RE = re.compile(r"[万亿千]|百万")
_ZH_INTEGER_LABEL_RE = re.compile(r"^[£$€¥]?(-?\d+)(?![\d.])")
_ZH_LABEL_RE = re.compile(r"^(-?\d+\.\d)(万亿|亿|万)(?![\u4e00-\u9fff])")


def _choropleth_zh_scaled_label_failure(text: str, expected: float, wan_context: bool = False) -> str | None:
    # Exact check of a Chinese 万 / 亿 / 万亿 label (runtime/pi/viz.mjs choroplethValueText with the typeset switch on).
    # The renderer picks the suffix by the raw magnitude of the value and prints value / 10^power to one decimal, rounded
    # half up on the shortest decimal spelling of the value. This re-derives that exact text from data-value with
    # decimal arithmetic and requires the number and suffix to equal it - no tolerance. Returns None when the label
    # carries no 万 / 亿 suffix (the ordinary reader applies), "" when it matches, else a mismatch description.
    from decimal import Decimal, ROUND_HALF_UP
    # A unit that already says 万 / 亿 / 千 / 百万 gets no second scale: the label is the plain one-decimal number, then the unit.
    plain = _ZH_PLAIN_UNIT_LABEL_RE.match(text)
    if plain and _ZH_UNIT_SCALE_RE.search(plain.group(2)):
        want = format(Decimal(repr(abs(expected))).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f")
        want = ("-" if expected < 0 else "") + want
        return "" if plain.group(1) == want else f"expected '{want}'"
    # An integer-form label: on a map that has a value of 1万 or more, a value under 1万 is its half-up integer; otherwise the
    # integer must be the (integer) value itself.
    whole = _ZH_INTEGER_LABEL_RE.match(text)
    if whole:
        magnitude = Decimal(repr(abs(expected)))
        if not math.isfinite(expected):
            return f"expected a finite value, got {expected}"
        if expected != int(expected):
            if not (wan_context and abs(expected) < 10_000):
                return f"expected a one-decimal label for {expected}"
            magnitude = magnitude.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        want = ("-" if expected < 0 and magnitude != 0 else "") + format(magnitude, "f").split(".")[0]
        return "" if whole.group(1) == want else f"expected '{want}'"
    m = _ZH_LABEL_RE.match(text)
    if not m:
        return None
    magnitude = abs(expected)
    suffix, power = next(((sfx, pw) for sfx, pw in _ZH_SCALE_SUFFIXES if magnitude >= 10 ** pw), (None, 0))
    if suffix is None:
        return f"label '{text}' scales a value that is under 1万"
    scaled = (Decimal(repr(magnitude)) / (Decimal(10) ** power)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    want = ("-" if expected < 0 else "") + format(scaled, "f")
    if m.group(1) != want or m.group(2) != suffix:
        return f"expected '{want}{suffix}'"
    return ""


def verify_choropleth_labels_from_svg(svg_text: str) -> list[str]:
    # Independently re-derives the choropleth value-labels proof straight
    # from one rendered viewport's SVG markup - every choropleth-data
    # region's own data-iso3/data-value, and every name/value label's own
    # data-iso3 and rendered text, on the main map or inside a zoom inset -
    # rather than trusting the render_qa report's own value_labels.passed
    # boolean, even though that boolean is itself sha256-bound to these
    # same bytes. Hash-binding only proves the report was computed against
    # these bytes at some point; it does not prove the report's internal
    # check logic ran, or ran correctly, against them. This is a fresh,
    # from-scratch re-implementation - not a call into
    # runtime/pi/render_qa_labels.mjs's own JS checker, and not shared code
    # with the Rust verifier's verify_choropleth_labels_from_svg - so a bug
    # or omission in one does not silently pass through the others.
    failures: list[str] = []
    # NEWSROOM_VERIFY_MAP_FOOTNOTES=1 (default off): also count the numbered-footnote list rows, the same roles
    # render_qa_labels.mjs counts.
    footnotes = os.environ.get("NEWSROOM_VERIFY_MAP_FOOTNOTES") == "1"
    name_roles = ("choropleth-label", "choropleth-inset-label") + (("choropleth-footnote-name",) if footnotes else ())
    value_roles = ("choropleth-label-value", "choropleth-inset-label-value") + (("choropleth-footnote-value",) if footnotes else ())

    data_values: dict[str, list[float]] = {}
    unreadable: set[str] = set()
    for tag in _choropleth_path_tags_with_role(svg_text, "choropleth-data"):
        attrs = _choropleth_tag_attrs(tag)
        iso3 = attrs.get("data-iso3")
        value_str = attrs.get("data-value")
        if not iso3 or value_str is None:
            continue
        # The renderer writes a plain decimal and drops rows whose value is not finite (viz.mjs), so a data-value that is
        # not a finite number is a tampered region, not one to skip: NaN or inf would turn the tolerance check below
        # into a pass for any label.
        if strict_readers():
            value = float(value_str) if re.fullmatch(r"-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value_str) else None
            if value is None or not math.isfinite(value):
                failures.append(f"{iso3}'s choropleth-data region has data-value '{value_str[:40]}', which is not a finite number")
                unreadable.add(iso3)
                continue
        else:
            try:
                value = float(value_str)
            except ValueError:
                continue
        data_values.setdefault(iso3, []).append(value)

    names: dict[str, list[str]] = {}
    for tag, body in _choropleth_text_nodes_with_role(svg_text, name_roles):
        iso3 = _choropleth_tag_attrs(tag).get("data-iso3")
        if iso3:
            names.setdefault(iso3, []).append(_choropleth_label_body_text(body))

    values: dict[str, list[str]] = {}
    for tag, body in _choropleth_text_nodes_with_role(svg_text, value_roles):
        iso3 = _choropleth_tag_attrs(tag).get("data-iso3")
        if iso3:
            values.setdefault(iso3, []).append(_choropleth_label_body_text(body))

    wan_context = any(abs(vals[0]) >= 10_000 for vals in data_values.values() if len(vals) == 1)
    for iso3, vals in data_values.items():
        if iso3 in unreadable:
            continue
        if len(vals) != 1:
            failures.append(f"{iso3} has {len(vals)} choropleth-data regions with conflicting data-value attributes")
            continue
        expected = vals[0]
        name_count = len(names.get(iso3, []))
        if name_count != 1:
            failures.append(f"{iso3} has {name_count} rendered name labels in the SVG (expected exactly 1)")
        value_texts = values.get(iso3, [])
        if len(value_texts) != 1:
            failures.append(f"{iso3} has {len(value_texts)} rendered value labels in the SVG (expected exactly 1)")
            continue
        text = value_texts[0]
        zh_failure = _choropleth_zh_scaled_label_failure(text, expected, wan_context)
        if zh_failure is not None:
            if zh_failure:
                failures.append(f"{iso3}'s rendered value label '{text}' does not match its region's data-value {expected}")
            continue
        shown = _choropleth_leading_number_with_scale(text)
        if shown is None:
            failures.append(f"{iso3}'s rendered value label '{text}' has no readable number (missing, truncated, or malformed)")
        else:
            tolerance = max(abs(expected) * 0.01, 0.05)
            if abs(shown - expected) > tolerance:
                failures.append(f"{iso3}'s rendered value label '{text}' does not match its region's data-value {expected}")

    for iso3 in set(list(names.keys()) + list(values.keys())):
        if iso3 not in data_values and iso3 not in unreadable:
            failures.append(f"{iso3} has a rendered label but no matching choropleth-data region in the SVG")

    return sorted(set(failures))


def _heatmap_leading_number_with_scale(text: str) -> float | None:
    # A heatmap cell prints a bare number, with a trailing zh scale word (wan = 10^4, yi = 10^8) when the
    # renderer scaled it (viz.mjs heatmapFixedDecimals); any other suffix leaves the scale alone.
    m = _LEADING_NUMBER_RE.match(text)
    if not m:
        return None
    number = float(m.group(1))
    rest = text[m.end():]
    if rest.startswith("\u4ebf"):
        return number * 100_000_000.0
    if rest.startswith("\u4e07"):
        return number * 10_000.0
    return number


def verify_heatmap_labels_from_svg(svg_text: str) -> list[str]:
    # NEWSROOM_HEATMAP_VALUE_LABELS=1 only. Independently re-derives the heatmap value-labels proof from one
    # rendered viewport's SVG: every heatmap-cell rect (data-x, data-y, data-value) has exactly one
    # heatmap-cell-value text for the same (x, y) whose number matches the cell's own data-value, is at least
    # 12px, and sits inside the cell; a label with no cell fails. Written fresh - it never calls into
    # runtime/pi/render_qa_labels.mjs - and mirrors Rust's verify_heatmap_labels_from_svg.
    failures: list[str] = []
    cells: dict[tuple[str, str], list[tuple[float, dict]]] = {}
    for m in re.finditer(r"<rect\b[^>]*?/?>", svg_text, re.S):
        attrs = _choropleth_tag_attrs(m.group(0))
        if attrs.get("data-role") != "heatmap-cell":
            continue
        try:
            value = float(attrs.get("data-value", ""))
        except ValueError:
            failures.append(f"a heatmap cell ({attrs.get('data-y')} / {attrs.get('data-x')}) has no readable data-value")
            continue
        cells.setdefault((attrs.get("data-x", ""), attrs.get("data-y", "")), []).append((value, attrs))
    labels: dict[tuple[str, str], list[tuple[str, dict]]] = {}
    for tag, body in _choropleth_text_nodes_with_role(svg_text, ("heatmap-cell-value",)):
        attrs = _choropleth_tag_attrs(tag)
        labels.setdefault((attrs.get("data-x", ""), attrs.get("data-y", "")), []).append((_choropleth_label_body_text(body), attrs))
    if not cells:
        failures.append("the heatmap has no cell with a value to prove")
    for key, found in cells.items():
        name = f"{key[1]} / {key[0]}"
        if len(found) != 1:
            failures.append(f"{name} has {len(found)} heatmap cells (expected exactly 1)")
            continue
        expected, rect = found[0]
        texts = labels.get(key, [])
        if len(texts) != 1:
            failures.append(f"{name} has {len(texts)} rendered value labels (expected exactly 1)")
            continue
        text, tattrs = texts[0]
        shown = _heatmap_leading_number_with_scale(text)
        if shown is None:
            failures.append(f"{name}'s rendered value label '{text}' has no readable number")
        elif abs(shown - expected) > max(abs(expected) * 0.01, 0.05):
            failures.append(f"{name}'s rendered value label '{text}' does not match its cell's data-value {expected}")
        try:
            size = float(tattrs.get("font-size", ""))
            tx, ty = float(tattrs["x"]), float(tattrs["y"])
            cx, cy, cw, ch = (float(rect[k]) for k in ("x", "y", "width", "height"))
        except (KeyError, ValueError):
            failures.append(f"{name}'s value label or cell is missing numeric geometry")
            continue
        if size < 12:
            failures.append(f"{name}'s value label is {size}px, below 12px")
        if not (cx <= tx <= cx + cw and cy <= ty <= cy + ch):
            failures.append(f"{name}'s value label is outside its cell")
    for key in labels:
        if key not in cells:
            failures.append(f"{key[1]} / {key[0]} has a rendered value label but no matching heatmap cell in the SVG")
    return sorted(set(failures))


# --- NEWSROOM_QA_TICK_READBACK=1 (exact "1", default off): bar tick and value-label read-back (K198, K200, K202) ---
# Independently re-derives, from one rendered SVG plus the data rows it was drawn from, that (T1) every axis tick's
# text read through its suffix or the unit line's data-scale equals its data-tick-value to half a displayed digit,
# (T2) every tick sits where that value falls on the scale fitted from the bars, (V1/V2) every value label reads as
# its data-value and names a bar carrying the same value, and (anchor) every bar's data-value equals its data row.
# Written fresh - it shares nothing with runtime/pi/render_qa_ticks.mjs or Rust's verify_tick_readback_from_svg.
TICK_READBACK_COVERED = ("horizontal_bar", "mirrored_bar")
_TICK_POSITION_TOLERANCE = 1.0  # SVG units: ~50x the coordinate rounding, 1/80 of the narrowest grid step
_TICK_LABEL_SLIDE_MAX = 40.0
_TICK_REL = 1e-9
_TICK_ATTR_RE = re.compile(r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_TICK_NUMBER_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_TICK_SHOWN_RE = re.compile(r"^([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?")


def _tick_attrs(tag: str) -> dict:
    return {m.group(1): (m.group(2) if m.group(2) is not None else m.group(3)) for m in _TICK_ATTR_RE.finditer(tag)}


def _tick_body(body: str) -> str:
    text = re.sub(r"<[^>]*>", "", body)
    for entity, char in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&#39;", "'"), ("&amp;", "&")):
        text = text.replace(entity, char)
    return text.strip()


def _tick_num(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if not isinstance(value, str) or not _TICK_NUMBER_RE.match(value.strip()):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _tick_read_shown(text: str):
    text = text.strip()
    m = _TICK_SHOWN_RE.match(text)
    if not m:
        return None
    mantissa = float(("-" if m.group(1) else "") + m.group(2).replace(",", "") + ("." + m.group(3) if m.group(3) else ""))
    rest = text[m.end():]
    suffix = None
    if rest.startswith("万亿"):
        suffix = 1e12
    elif rest.startswith("亿"):
        suffix = 1e8
    elif rest.startswith("万"):
        suffix = 1e4
    else:
        en = re.match(r"(bn|m|k)(?![A-Za-z])", rest)
        if en:
            suffix = {"bn": 1e9, "m": 1e6, "k": 1e3}[en.group(1)]
        # a label that names its own unit (1683%, 9541.8 元) is read as written, the unit line's scale is not applied to it
        elif rest.strip() != "":
            suffix = 1.0
    return mantissa, len(m.group(3) or ""), suffix


def _tick_unit_word_scale(text: str) -> float:
    if "万亿" in text:
        return 1e12
    if "亿" in text:
        return 1e8
    if "万" in text:
        return 1e4
    en = re.search(r"\b(thousand|million|billion|trillion)s?\b", text, re.I)
    if en:
        return {"thousand": 1e3, "million": 1e6, "billion": 1e9, "trillion": 1e12}[en.group(1).lower()]
    return 1.0


def _tick_close(a: float, b: float) -> bool:
    return abs(a - b) <= _TICK_REL * max(1.0, abs(a), abs(b))


def _tick_shown_value(text: str, unit_scale: float):
    shown = _tick_read_shown(text)
    if shown is None:
        return None
    mantissa, decimals, suffix = shown
    mult = suffix if suffix is not None else unit_scale
    return mantissa * mult, 0.5 * 10 ** -decimals * mult


def _tick_key(category, series, period) -> str:
    return json.dumps([str(category if category is not None else ""), str(series if series is not None else ""), str(period if period is not None else "")], ensure_ascii=False, separators=(",", ":"))


def verify_tick_readback_from_svg(svg_text: str, ctx: dict) -> tuple[str, list[tuple[str, str]]]:
    """Returns (status, [(rule, message)]); status is "covered" or "uncovered". Uncovered is never a pass."""
    chart_type = ctx.get("chart_type")
    # zh pages write $B as 亿美元 (x10): the text no longer equals the data unit, the read-back does not cover it yet
    if chart_type not in TICK_READBACK_COVERED or (ctx.get("language") == "zh" and ctx.get("unit") == "$B"):
        return "uncovered", []
    failures: list[tuple[str, str]] = []

    def fail(rule: str, message: str):
        failures.append((rule, message))

    mirrored = chart_type == "mirrored_bar"
    ticks, units, labels, bars = [], [], [], []
    for m in re.finditer(r"<text\b([^>]*)>([\s\S]*?)</text>", svg_text):
        attrs = _tick_attrs(m.group(1))
        role = attrs.get("data-role")
        item = (attrs, _tick_body(m.group(2)))
        if role == "axis-tick-label":
            ticks.append(item)
        elif role == "axis-unit-line":
            units.append(item)
        elif role == "value-label":
            labels.append(item)
    for m in re.finditer(r"<rect\b([^>]*?)/?>", svg_text):
        attrs = _tick_attrs(m.group(1))
        if attrs.get("data-role") == "data-bar":
            bars.append(attrs)

    unit_scale = 1.0
    if len(units) > 1:
        fail("unit_line", f"{len(units)} axis unit lines (expected at most 1)")
    for attrs, text in units[:1]:
        scale = _tick_num(attrs.get("data-scale"))
        if scale is None or scale <= 0:
            fail("unit_line", f"axis unit line '{text}' has no readable positive data-scale")
        elif scale != 1 and not _tick_close(scale, _tick_unit_word_scale(text)):
            fail("unit_line", f"axis unit line '{text}' says scale {_tick_unit_word_scale(text)} but data-scale is {scale}")
        else:
            unit_scale = scale

    bar_value: dict[str, float] = {}
    geo = []
    if not bars:
        fail("bar_attrs", "the chart has no data-bar to read back against")
    for attrs in bars:
        if attrs.get("data-category") is None:
            fail("bar_attrs", "a data-bar has no data-category")
            continue
        key = _tick_key(attrs.get("data-category"), attrs.get("data-series"), attrs.get("data-period"))
        value, x, width = _tick_num(attrs.get("data-value")), _tick_num(attrs.get("x")), _tick_num(attrs.get("width"))
        if value is None:
            fail("bar_attrs", f"bar {key} has no readable data-value")
            continue
        if x is None or width is None:
            fail("bar_attrs", f"bar {key} has no numeric x/width")
            continue
        side = attrs.get("data-side")
        if mirrored and side not in ("left", "right"):
            fail("bar_attrs", f"bar {key} has no data-side left/right")
            continue
        if key in bar_value:
            fail("bar_attrs", f"bar {key} appears twice")
            continue
        bar_value[key] = value
        geo.append((key, value, x, width, side))

    rows = ctx.get("rows")
    category_field, value_field = ctx.get("category_field"), ctx.get("value_field")
    if not isinstance(rows, list) or not category_field or not value_field:
        fail("data_anchor", "no data rows or field names to anchor the bars to")
    else:
        row_value: dict[str, float] = {}
        for row in rows:
            row = row if isinstance(row, dict) else {}
            key = _tick_key(row.get(category_field), row.get(ctx["series_field"]) if ctx.get("series_field") else "", row.get(ctx["period_field"]) if ctx.get("period_field") else "")
            value = _tick_num(row.get(value_field))
            if value is None:
                fail("data_anchor", f"data row {key} has no numeric {value_field}")
            elif key in row_value:
                fail("data_anchor", f"data row key {key} is not unique")
            else:
                row_value[key] = value
        for key, value in bar_value.items():
            if key not in row_value:
                fail("data_anchor", f"bar {key} has no data row")
            elif not _tick_close(value, row_value[key]):
                fail("data_anchor", f"bar {key} data-value {value} differs from its data row {row_value[key]}")
        # a chart draws the current period only (the other may be an outline or absent): rows of a period no bar carries are not drawn
        drawn = {json.loads(key)[2] for key in bar_value}
        for key in row_value:
            if key not in bar_value and not (ctx.get("period_field") and drawn and json.loads(key)[2] not in drawn):
                fail("data_anchor", f"data row {key} has no bar")

    k = None
    origin: dict[str, float] = {}
    usable = [g for g in geo if g[1] != 0]
    if not usable:
        fail("tick_position", "no non-zero bar to fit the scale from")
    else:
        ref = max(usable, key=lambda g: abs(g[1]))
        k = ref[3] / abs(ref[1])
        for key, value, x, width, side in geo:
            if abs(width - k * abs(value)) > _TICK_POSITION_TOLERANCE:
                fail("tick_position", f"bar {key} is {width} wide but its data-value {value} implies {k * abs(value):.2f}")
            if value == 0 and not mirrored:
                continue
            if mirrored:
                zero, slot = (x + width if side == "left" else x), side
            else:
                zero, slot = (x + width if value < 0 else x), "bar"
            if slot not in origin:
                origin[slot] = zero
            elif abs(origin[slot] - zero) > _TICK_POSITION_TOLERANCE:
                fail("tick_position", f"bar {key} starts at {zero}, the others at {origin[slot]}")

    if not ticks:
        fail("tick_attrs", "the chart has no axis-tick-label to read back")
    for attrs, text in ticks:
        tv = _tick_num(attrs.get("data-tick-value"))
        if tv is None:
            fail("tick_attrs", f"tick '{text}' has no readable data-tick-value")
            continue
        shown = _tick_shown_value(text, unit_scale)
        if shown is None:
            fail("tick_text", f"tick '{text}' has no readable number")
            continue
        if abs(shown[0] - tv) > shown[1] * (1 + _TICK_REL) + _TICK_REL * abs(tv):
            fail("tick_text", f"tick '{text}' reads {shown[0]} but data-tick-value is {tv}")
        x = _tick_num(attrs.get("x"))
        tick_x = x if attrs.get("data-tick-x") is None else _tick_num(attrs.get("data-tick-x"))
        if x is None or tick_x is None:
            fail("tick_position", f"tick '{text}' has no numeric position")
            continue
        if abs(x - tick_x) > _TICK_LABEL_SLIDE_MAX:
            fail("tick_position", f"tick '{text}' text sits {abs(x - tick_x):.1f} from its tick")
        side = attrs.get("data-side")
        if mirrored and side not in ("left", "right"):
            fail("tick_attrs", f"tick '{text}' has no data-side left/right")
            continue
        zero = origin.get(side if mirrored else "bar")
        if k is None or zero is None:
            fail("tick_position", f"tick '{text}' position cannot be computed (no bar scale)")
            continue
        expected = zero - k * tv if (mirrored and side == "left") else zero + k * tv
        if abs(tick_x - expected) > _TICK_POSITION_TOLERANCE:
            fail("tick_position", f"tick '{text}' is at {tick_x} but its data-tick-value {tv} belongs at {expected:.2f}")

    for attrs, text in labels:
        if attrs.get("data-category") is None:
            fail("value_label_attrs", f"value label '{text}' has no data-category")
            continue
        key = _tick_key(attrs.get("data-category"), attrs.get("data-series"), attrs.get("data-period"))
        value = _tick_num(attrs.get("data-value"))
        if value is None:
            fail("value_label_attrs", f"value label '{text}' has no readable data-value")
            continue
        shown = _tick_shown_value(text, unit_scale)
        if shown is None:
            fail("value_label_text", f"value label '{text}' has no readable number")
        elif abs(shown[0] - value) > shown[1] * (1 + _TICK_REL) + _TICK_REL * abs(value):
            fail("value_label_text", f"value label '{text}' reads {shown[0]} but data-value is {value}")
        if key not in bar_value:
            fail("value_label_key", f"value label '{text}' names {key}, which is not a bar")
        elif not _tick_close(value, bar_value[key]):
            fail("value_label_key", f"value label '{text}' carries {value} but its bar {key} is {bar_value[key]}")
    return "covered", failures


def verify_tick_readback_for_manifest(root: Path, manifest: dict, manifest_ref: str, computation_map: dict, report: "Report") -> None:
    # NEWSROOM_QA_TICK_READBACK=1 only. Data anchor: the rows come from the computation record the manifest names
    # (its result_hash is bound to the lint and to the manifest.data_hash, and re-hashed against the rows by the
    # computation checks), the field names from the plan the manifest names (content-addressed spec).
    chart_type = manifest.get("chart_type")
    if chart_type not in TICK_READBACK_COVERED:
        report.warnings.append(f"visualization {manifest_ref}: tick read-back not covered for chart type {chart_type}")
        return
    try:
        comp_ref, plan_ref = manifest.get("computation_ref"), manifest.get("plan_ref")
        comp = computation_map.get(comp_ref) or load_json(safe_ref(root, comp_ref))
        plan = load_json(safe_ref(root, plan_ref))
        report.check(comp.get("result_hash") == manifest.get("data_hash"), f"visualization {manifest_ref} tick read-back: computation rows are not the manifest's data")
        ctx = {"chart_type": chart_type, "rows": comp.get("rows"), "category_field": plan.get("category_field"), "value_field": plan.get("value_field"), "series_field": plan.get("series_field"), "period_field": plan.get("period_field"), "unit": plan.get("unit"), "language": plan.get("language")}
        for viewport, ref in (manifest.get("variants") or {}).items():
            svg_path = safe_ref(root, ref)
            if not svg_path.is_file():
                continue
            _status, failures = verify_tick_readback_from_svg(svg_path.read_text(encoding="utf-8"), ctx)
            for rule, message in failures:
                report.check(False, f"visualization {manifest_ref} {viewport} tick read-back {rule}: {message}")
    except Exception as exc:
        report.check(False, f"visualization {manifest_ref} tick read-back could not run: {exc}")


def model_pass_selfreport_enabled() -> bool:
    # NEWSROOM_MODEL_PASS_SELFREPORT=1 (exact "1", default off; K98): mirrors src/verify.rs model_pass_selfreport_enabled.
    return os.environ.get("NEWSROOM_MODEL_PASS_SELFREPORT") == "1"


def review_split_enabled() -> bool:
    """NEWSROOM_REVIEW_SPLIT=1 (exact value): a draw tool writes no render-QA record; a passing critic carries it."""
    return os.environ.get("NEWSROOM_REVIEW_SPLIT") == "1"


def split_render_qa_ref(critics: list, manifest_ref: str, manifest: dict, label: str, report: "Report"):
    """With the review split on: the manifest must carry no render_qa_ref/render_qa (that would be a draw tool writing a review record), and the
    render-QA report ref comes from a passing critic linked to the manifest. None when there is no such critic, so the callers' missing-ref checks fail closed."""
    report.check("render_qa_ref" not in manifest and "render_qa" not in manifest, f"{label} carries a render-QA record written by the draw step; with the review split only the critic writes it")
    for critic in critics:
        if critic.get("manifest_ref") == manifest_ref and critic.get("passed") is True and isinstance(critic.get("render_qa_ref"), str) and critic["render_qa_ref"]:
            return critic["render_qa_ref"]
    return None


def vision_critic_vetoes(critic: dict) -> bool:
    # Mirrors src/verify.rs vision_critic_vetoes: failed, score below 80 (or none) or a blocker issue.
    score = critic.get("score")
    if critic.get("passed") is not True or isinstance(score, bool) or not isinstance(score, (int, float)) or score < 80:
        return True
    return any(isinstance(issue, dict) and issue.get("severity") == "blocker" for issue in (critic.get("issues") or []))


VISION_RUBRIC_KEYS = ("hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness")


def vision_veto_only_enabled() -> bool:
    # NEWSROOM_VISION_VETO_ONLY (default on; only the exact "0" turns it off): mirrors src/verify.rs vision_veto_only_enabled.
    return os.environ.get("NEWSROOM_VISION_VETO_ONLY") != "0"


def _vision_number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def vision_critic_fails(critic: dict) -> bool:
    # Mirrors src/verify.rs vision_critic_fails: re-derived from the record, not from its passed (only passed=false also counts).
    if critic.get("passed") is False:
        return True
    score = _vision_number(critic.get("score"))
    if score is None or score < 80:
        return True
    rubric = critic.get("rubric") if isinstance(critic.get("rubric"), dict) else {}
    for key in VISION_RUBRIC_KEYS:
        value = _vision_number(rubric.get(key))
        if value is None or value < 60:
            return True
    return any(isinstance(issue, dict) and issue.get("severity") == "blocker" for issue in (critic.get("issues") or []))


def verify_publication_infographic_lineage(root: Path, manifest_ref: str, infographic_plan_ref: str, infographic_critics: list, infographic_vision_critics: list, report: "Report") -> None:
    # The gate this worktree adds: a top-level publication's
    # infographic_plan_ref (already confirmed by the caller to resolve to an
    # existing infographics/plans/*.json file) must be the plan_ref of a
    # top-level, non-rejected infographics/<key>.json manifest - scanned
    # exactly like verify()'s own infographics/*.json loop, so
    # infographics/plans, critics, vision-critics, previews, revisions, qa
    # and rejected are never candidates - and that manifest's critic and,
    # whenever it declares visual_review_required (currently unconditional
    # on every rendered page - see newsroom_infographic_render), image-aware
    # vision critic must both be linked by manifest_ref and passed is True,
    # using the exact same linking rule verify()'s own
    # infographic_critics/infographic_vision_critics filters use just below
    # (c.get("manifest_ref") == manifest_ref), never a new one. A plan whose
    # only rendered page was moved to infographics/rejected/<key>/ after
    # either critic failed has no match here at all - the same "no approved
    # lineage exists" signal as a plan that was never rendered. Entries are
    # walked in sorted order and the first match wins, so the result is
    # deterministic even if more than one top-level manifest was ever
    # rendered from the same plan_ref. Mirrors the Rust verifier's
    # verify_publication_infographic_lineage exactly.
    found = None
    info_dir = root / "infographics"
    if info_dir.is_dir():
        for candidate_path in sorted(info_dir.glob("*.json")):
            try:
                candidate = load_json(candidate_path)
            except Exception:
                continue
            if candidate.get("plan_ref") == infographic_plan_ref:
                found = (candidate_path.relative_to(root).as_posix(), candidate)
                break
    if found is None:
        report.check(False, f"publication {manifest_ref} upstream infographic plan {infographic_plan_ref} has no top-level, non-rejected infographic manifest bound to it")
        return
    infographic_ref, infographic_manifest = found
    linked_critics = [c for c in infographic_critics if c.get("manifest_ref") == infographic_ref]
    report.check(any(c.get("passed") is True for c in linked_critics), f"publication {manifest_ref} upstream infographic {infographic_ref} has no passing critic")
    if infographic_manifest.get("visual_review_required") is True:
        linked_vision = [c for c in infographic_vision_critics if c.get("manifest_ref") == infographic_ref]
        if vision_veto_only_enabled():
            report.check(bool(linked_vision), f"publication {manifest_ref} upstream infographic {infographic_ref} has no image-aware vision critic")
            report.check(not any(vision_critic_fails(c) for c in linked_vision), f"publication {manifest_ref} upstream infographic {infographic_ref} failed by an image-aware vision critic")
            return
        report.check(any(c.get("passed") is True for c in linked_vision), f"publication {manifest_ref} upstream infographic {infographic_ref} has no passing image-aware vision critic")
        if model_pass_selfreport_enabled():
            report.check(not any(vision_critic_vetoes(c) for c in linked_vision), f"publication {manifest_ref} upstream infographic {infographic_ref} vetoed by an image-aware vision critic")


def _minified_json_text(text: str) -> str:
    # The compact form of JSON text: whitespace outside strings dropped, every string and key order untouched.
    out: list[str] = []
    in_string = escaped = False
    for ch in text:
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
            out.append(ch)
        elif ch not in " \t\r\n":
            out.append(ch)
    return "".join(out)


def _write_record_only(root: Path, kind: str, key_inputs: dict, record: dict) -> None:
    # Side file shadow/record_<kind>-<key>.json, written once; never read by any check, never raises.
    try:
        key = hashlib.sha256(json.dumps({"kind": kind, **key_inputs}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        target = root / "shadow" / f"record_{kind}-{key}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps({"schema_version": "0.1.0", "kind": f"record_{kind}", "key": key, **record}, indent=2, ensure_ascii=False) + "\n")
    except Exception:
        pass


def record_only_verify(root: Path, story: dict) -> None:
    # NEWSROOM_RECORD_THIN_RESULT=1 and NEWSROOM_RECORD_ORIGIN_HASH=1 (exact, default off). Record only: no check, error,
    # warning, output line or exit code changes. Mirrors Rust's record_only_verify.
    if os.environ.get("NEWSROOM_RECORD_THIN_RESULT") == "1":
        try:
            delivery = story.get("delivery") if isinstance(story.get("delivery"), dict) else {}
            inputs = {
                "data": (root / "data").is_dir(),
                "sources": (root / "sources").is_dir(),
                "computations": (root / "computations").is_dir(),
                "claims": (root / "claims.jsonl").is_file(),
                "visualizations": (root / "visualizations").is_dir(),
                "infographics": (root / "infographics").is_dir(),
                "publications": (root / "publications").is_dir(),
                "delivered_artifact": delivery.get("primary_artifact") is not None,
            }
            skipped = sorted(name for name, present in inputs.items() if not present)
            _write_record_only(root, "thin_result", {"inputs": inputs}, {"inputs_present": inputs, "checks_skipped_for_absent_input": skipped, "counts": {"skipped": len(skipped), "thin_result": 1 if len(skipped) == len(inputs) else 0}, "thin_result": len(skipped) == len(inputs)})
        except Exception:
            pass
    if os.environ.get("NEWSROOM_RECORD_ORIGIN_HASH") == "1":
        try:
            origin_dir = root / "data" / "origins"
            findings = []
            checked = 0
            if origin_dir.is_dir():
                for origin_path in sorted(origin_dir.glob("*.json")):
                    rel = origin_path.relative_to(root).as_posix()
                    checked += 1
                    recomputed = hashlib.sha256(_minified_json_text(origin_path.read_text(encoding="utf-8")).encode()).hexdigest()
                    if recomputed != origin_path.stem:
                        findings.append({"origin": rel, "reason": "record hash differs from its file name"})
                    try:
                        origin = load_json(origin_path)
                        ref, expected = origin.get("file"), origin.get("sha256")
                        payload = safe_ref(root, ref) if isinstance(ref, str) else None
                        if payload is not None and payload.is_file() and isinstance(expected, str) and sha256_file(payload) != expected:
                            findings.append({"origin": rel, "reason": "data file hash differs (already refused by the existing check)"})
                    except Exception:
                        pass
            _write_record_only(root, "origin_hash", {"origins": checked, "findings": findings}, {"counts": {"origins": checked, "mismatches": len(findings)}, "findings": findings})
        except Exception:
            pass


def verify(root: Path) -> Report:
    report = Report()
    if not root.is_dir():
        report.errors.append(f"artifact directory does not exist: {root}")
        return report
    try:
        story = load_json(root / "story.json")
    except Exception as exc:
        report.errors.append(f"story.json unreadable: {exc}")
        return report

    report.check(story.get("kind") == "investigation", "story.json kind must be investigation")

    for key, ref in (story.get("files") or {}).items():
        try:
            path = safe_ref(root, ref)
            report.check(path.is_file(), f"story files.{key} missing: {ref}")
        except Exception as exc:
            report.check(False, f"story files.{key} invalid: {exc}")

    # v0.7 run telemetry must be present and structurally valid so E2E timing is auditable.
    if str(story.get("schema_version", "")) >= "0.7.0":
        metrics_ref = (story.get("files") or {}).get("run_metrics")
        report.check(isinstance(metrics_ref, str) and bool(metrics_ref), "v0.7 story files.run_metrics is missing")
        if isinstance(metrics_ref, str):
            try:
                metrics_path = safe_ref(root, metrics_ref)
                report.check(metrics_path.is_file(), f"run metrics file missing: {metrics_ref}")
                metrics = jsonl(metrics_path)
                report.check(bool(metrics), "v0.7 run metrics must contain at least one operation")
                for index, metric in enumerate(metrics, 1):
                    report.check("__parse_error__" not in metric, f"run metric line {index} is invalid JSON")
                    if "__parse_error__" in metric:
                        continue
                    report.check(metric.get("operation") in {"investigate", "continue"}, f"run metric line {index} has invalid operation")
                    duration = metric.get("duration_ms")
                    report.check(isinstance(duration, int) and (not isinstance(duration, bool) or not strict_readers()) and duration >= 0, f"run metric line {index} has invalid duration_ms")
                    report.check(metric.get("status") in {"draft", "incomplete", "failed", "verified", "published"}, f"run metric line {index} has invalid status")
            except Exception as exc:
                report.check(False, f"run metrics verification failed: {exc}")

    for kind, refs in (story.get("evidence") or {}).items():
        if kind == "claims" or not isinstance(refs, list):
            continue
        for ref in refs:
            if not isinstance(ref, str):
                continue
            try:
                report.check(safe_ref(root, ref).is_file(), f"story evidence.{kind} missing: {ref}")
            except Exception as exc:
                report.check(False, f"story evidence.{kind} invalid ref {ref}: {exc}")

    # Data metadata integrity. Every dataset payload must have metadata.
    if (root / "data").is_dir():
        for data_path in sorted((root / "data").iterdir()):
            if data_path.is_file() and not data_path.name.endswith(".meta.json"):
                report.check(Path(str(data_path) + ".meta.json").is_file(), f"dataset is missing metadata sidecar: {data_path.relative_to(root).as_posix()}")
    for meta_path in sorted((root / "data").glob("*.meta.json")) if (root / "data").is_dir() else []:
        try:
            meta = load_json(meta_path)
            ref, expected = meta.get("file"), meta.get("sha256")
            report.check(isinstance(ref, str) and bool(ref), f"{meta_path.name} missing relative file ref")
            report.check(isinstance(expected, str) and len(expected) == 64, f"{meta_path.name} missing sha256")
            if isinstance(ref, str) and isinstance(expected, str):
                file = safe_ref(root, ref)
                report.check(file.is_file(), f"dataset metadata points to missing file: {ref}")
                if file.is_file():
                    report.check(sha256_file(file) == expected, f"dataset hash mismatch: {ref}")
                    report.check(file.name.startswith(expected + ".") or file.name == expected, f"dataset path is not content-addressed by sha256: {ref}")
        except Exception as exc:
            report.check(False, f"dataset metadata unreadable {meta_path}: {exc}")

    # Dataset acquisition origins are immutable acquisition records pointing at content-addressed payloads.
    origin_dir = root / "data" / "origins"
    if origin_dir.is_dir():
        for origin_path in sorted(origin_dir.glob("*.json")):
            try:
                origin = load_json(origin_path)
                ref, expected = origin.get("file"), origin.get("sha256")
                report.check(len(origin_path.stem) == 64 and all(c in "0123456789abcdef" for c in origin_path.stem), f"dataset origin path is not hash-shaped: {origin_path.relative_to(root).as_posix()}")
                report.check(isinstance(ref, str) and ref.startswith("data/"), f"dataset origin missing data file ref: {origin_path.relative_to(root).as_posix()}")
                report.check(isinstance(expected, str) and len(expected) == 64, f"dataset origin missing sha256: {origin_path.relative_to(root).as_posix()}")
                if isinstance(ref, str) and isinstance(expected, str):
                    payload = safe_ref(root, ref)
                    report.check(payload.is_file(), f"dataset origin points to missing payload: {ref}")
                    if payload.is_file():
                        report.check(sha256_file(payload) == expected, f"dataset origin hash mismatch: {ref}")
            except Exception as exc:
                report.check(False, f"dataset origin unreadable {origin_path}: {exc}")

    # Source snapshot content hashes.
    if (root / "sources").is_dir():
        for source_path in sorted((root / "sources").glob("*.json")):
            try:
                source = load_json(source_path)
                if str(source.get("schema_version", "")) >= "0.7.0":
                    expected = source.get("content_hash")
                    payload = {
                        "content_type": source.get("content_type"),
                        "final_url": source.get("final_url"),
                        "status": source.get("status"),
                        "text": source.get("text"),
                        "truncated": source.get("truncated"),
                    }
                    actual = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
                    report.check(isinstance(expected, str) and expected == actual, f"source content_hash mismatch: {source_path.relative_to(root).as_posix()}")
                    report.check(source.get("trust") == "untrusted_external_content", f"source trust boundary missing or altered: {source_path.relative_to(root).as_posix()}")
                    if isinstance(expected, str):
                        report.check(source_path.stem == expected, f"source path is not content-addressed: {source_path.relative_to(root).as_posix()}")
            except Exception as exc:
                report.check(False, f"source snapshot unreadable {source_path}: {exc}")

    # Computation integrity. Repeated computations commonly bind the same immutable inputs;
    # validate each fingerprint once per artifact to avoid redundant hashing.
    computation_map = {}
    verified_input_fingerprints: set[str] = set()
    for path in sorted((root / "computations").glob("*.json")) if (root / "computations").is_dir() else []:
        try:
            comp = load_json(path)
            rel = path.relative_to(root).as_posix()
            computation_map[rel] = comp
            rows = comp.get("rows")
            report.check(isinstance(rows, list), f"computation rows missing: {rel}")
            if isinstance(rows, list) and comp.get("result_hash"):
                actual = hashlib.sha256(canonical_rows_json(rows).encode()).hexdigest()
                report.check(actual == comp["result_hash"], f"computation result_hash mismatch: {rel}")
            if str(comp.get("schema_version", "")) >= "0.7.0":
                report.check(bool(comp.get("result_hash")), f"v0.7 computation missing result_hash: {rel}")
                report.check(bool(comp.get("input_snapshot_hash")), f"v0.7 computation missing input_snapshot_hash: {rel}")
                fingerprints = comp.get("input_fingerprints")
                report.check(isinstance(fingerprints, list) and all(isinstance(item, str) for item in (fingerprints or [])), f"v0.7 computation missing input_fingerprints: {rel}")
                if isinstance(fingerprints, list) and all(isinstance(item, str) for item in fingerprints):
                    report.check(fingerprints == sorted(set(fingerprints)), f"input_fingerprints must be sorted and unique: {rel}")
                    actual_snapshot_hash = hashlib.sha256("\n".join(fingerprints).encode()).hexdigest()
                    report.check(actual_snapshot_hash == comp.get("input_snapshot_hash"), f"input_snapshot_hash mismatch: {rel}")
                    for fingerprint in fingerprints:
                        verify_input_fingerprint(root, fingerprint, report, verified_input_fingerprints)
                if comp.get("sql") and comp.get("input_snapshot_hash") and comp.get("result_hash"):
                    expected_name = hashlib.sha256(f"{comp['sql']}\n{comp['input_snapshot_hash']}\n{comp['result_hash']}".encode()).hexdigest() + ".json"
                    report.check(path.name == expected_name, f"computation path is not content-addressed: {rel}")
        except Exception as exc:
            report.check(False, f"computation unreadable {path}: {exc}")

    # Every non-blank line must be a JSON object with a non-empty string claim_id, whatever its status; the file line
    # number is reported (jsonl() drops blank lines, so its row index is not the file line).
    claims = []
    claims_path = root / "claims.jsonl"
    if claims_path.is_file():
        if strict_readers():
            claim_lines = claims_lines(claims_path)
        else:
            claim_lines = ((n, text) for n, text in enumerate(claims_path.read_text(encoding="utf-8").splitlines(), 1) if text.strip())
        for line_no, raw in claim_lines:
            try:
                record = parse_claims_line(raw) if strict_readers() else json.loads(raw)
            except (json.JSONDecodeError, ClaimsLineRefused) as exc:
                report.check(False, f"claims.jsonl parse error: line {line_no}: {exc}")
                continue
            if isinstance(record, dict) and "__parse_error__" in record:
                report.check(False, f"claims.jsonl line {line_no} carries the reserved key __parse_error__")
                continue
            claim_id = record.get("claim_id") if isinstance(record, dict) else None
            if not isinstance(claim_id, str) or not claim_id:
                report.check(False, f"claims.jsonl line {line_no} is not a claim record with a non-empty string claim_id")
                continue
            claims.append(record)
    # A claim counts as verified only while its latest record is system-verified (a later non-verified record
    # with the same claim_id revokes it), as in the runtime.
    latest_claims = {claim["claim_id"]: claim for claim in claims}
    verified_ids = {claim_id for claim_id, claim in latest_claims.items() if system_verified_claim(claim)}
    for claim in claims:
        if claim.get("status") != "verified":
            continue
        report.check(system_verified_claim(claim), f"verified claim {claim.get('claim_id')} lacks system-derived verification")
        if not system_verified_claim(claim):
            continue
        claim_id = claim.get("claim_id")
        if strict_readers():
            srcs = claim.get("source_refs")
            comps = claim.get("computation_refs")
            srcs = srcs if isinstance(srcs, list) else []
            comps = comps if isinstance(comps, list) else []
        else:
            srcs = claim.get("source_refs") or []
            comps = claim.get("computation_refs") or []
        report.check(bool(srcs), f"verified claim {claim_id} has no source_refs")
        report.check(bool(comps), f"verified claim {claim_id} has no computation_refs")
        for ref in srcs:
            try:
                path = safe_ref(root, ref)
                report.check(path.is_file(), f"verified claim {claim_id} source missing: {ref}")
                report.check(ref.startswith("sources/") or ref.startswith("data/"), f"verified claim {claim_id} source ref outside evidence dirs: {ref}")
            except Exception as exc:
                report.check(False, f"verified claim {claim_id} invalid source ref {ref}: {exc}")
        for ref in comps:
            try:
                path = safe_ref(root, ref)
                report.check(ref.startswith("computations/"), f"verified claim {claim_id} computation ref outside computations/: {ref}")
                report.check(path.is_file(), f"verified claim {claim_id} computation missing: {ref}")
            except Exception as exc:
                report.check(False, f"verified claim {claim_id} invalid computation ref {ref}: {exc}")

    critics = []
    critic_dir = root / "visualizations" / "critics"
    if critic_dir.is_dir():
        for path in sorted(critic_dir.glob("*.json")):
            try:
                critics.append(load_json(path))
            except Exception as exc:
                report.check(False, f"critic unreadable {path}: {exc}")

    viz_dir = root / "visualizations"
    if viz_dir.is_dir():
        for manifest_path in sorted(viz_dir.glob("*.json")):
            try:
                manifest = load_json(manifest_path)
            except Exception as exc:
                report.check(False, f"visualization manifest unreadable {manifest_path}: {exc}")
                continue
            if manifest.get("kind") == "lieflat_chart":
                # runtime/pi/lieflat.mjs's chart mode writes artifact_status:
                # "VERIFIED" and desktop_qa: "PASS" as renderer constants,
                # with no render_qa_ref, lint_ref or critic at all - never
                # trust this self-issued pair, and give it its own message
                # rather than the generic legacy-newsroom_chart wording
                # below (this manifest does have variants, just no
                # plan_ref, so it would otherwise fall into that generic
                # branch too).
                report.check(False, f"visualization {manifest_path.relative_to(root).as_posix()} is a Lieflat chart whose desktop_qa/artifact_status are renderer constants (kind=lieflat_chart), not measured render QA or critic results")
                continue
            if not isinstance(manifest.get("variants"), dict) or not manifest.get("plan_ref"):
                # Anything under visualizations/ shaped like this bypassed
                # newsroom_viz_plan -> lint -> render entirely - most
                # commonly the legacy newsroom_chart tool, which writes a
                # flat SVG+claim manifest with no plan_ref/variants at all.
                # Fail closed instead of silently skipping it.
                report.check(False, f"visualization {manifest_path.relative_to(root).as_posix()} is not a gated visualization manifest (no plan_ref/variants), e.g. output of the legacy newsroom_chart tool")
                continue
            manifest_ref = manifest_path.relative_to(root).as_posix()
            viz_qa_ref = split_render_qa_ref(critics, manifest_ref, manifest, f"visualization {manifest_ref}", report) if review_split_enabled() else manifest.get("render_qa_ref")
            claim_id = str(manifest.get("claim_id") or "")
            verification_mode = str(manifest.get("verification_mode") or "verified")
            draft = verification_mode == "draft" or manifest.get("artifact_status") == "DRAFT" or manifest.get("publishable") is False
            if draft:
                report.check(not claim_id or claim_id in verified_ids, f"draft visualization {manifest_ref} has an unverified optional claim_id: {claim_id}")
            else:
                report.check(claim_id in verified_ids, f"visualization {manifest_ref} claim_id is not verified: {claim_id}")
            plan_ref, lint_ref = manifest.get("plan_ref"), manifest.get("lint_ref")
            for label, ref, prefix in [("plan", plan_ref, "visualizations/plans/"), ("lint", lint_ref, "visualizations/lints/")]:
                report.check(isinstance(ref, str) and ref.startswith(prefix), f"visualization {manifest_ref} invalid {label}_ref")
                if isinstance(ref, str):
                    try:
                        report.check(safe_ref(root, ref).is_file(), f"visualization {manifest_ref} missing {label}: {ref}")
                    except Exception as exc:
                        report.check(False, f"visualization {manifest_ref} unsafe {label} ref: {exc}")
            # The desktop SVG is required; the compact mobile SVG is optional
            # (rendered only with NEWSROOM_MOBILE_PAGES=1). A listed one is
            # checked the same way, and nothing else may be listed.
            viz_variants = manifest["variants"]
            report.check(set(viz_variants) <= {"desktop", "mobile", "compact"}, f"visualization {manifest_ref} lists an unknown variant: {sorted(set(viz_variants) - {'desktop', 'mobile', 'compact'})}")
            # Optional manifest.hashes: each key present must equal the sha256
            # of the corresponding variant file; a listed compact variant must
            # carry hashes.compact_sha256 (fail closed). Old manifests with no
            # compact variant and no hashes are unaffected.
            viz_hashes = manifest.get("hashes") if isinstance(manifest.get("hashes"), dict) else {}
            report.check("compact_sha256" not in viz_hashes or "compact" in viz_variants, f"visualization {manifest_ref} has hashes.compact_sha256 without a compact variant")
            report.check("compact" not in viz_variants or "compact_sha256" in viz_hashes, f"visualization {manifest_ref} lists a compact variant without hashes.compact_sha256")
            for viewport in ("desktop", "mobile", "compact"):
                if viewport != "desktop" and viewport not in viz_variants:
                    continue
                ref = manifest["variants"].get(viewport)
                report.check(isinstance(ref, str) and bool(ref), f"visualization {manifest_ref} missing {viewport} variant")
                if isinstance(ref, str):
                    try:
                        svg_path = safe_ref(root, ref)
                        report.check(svg_path.is_file(), f"visualization {manifest_ref} missing SVG: {ref}")
                        if svg_path.is_file():
                            text = svg_path.read_text(encoding="utf-8")
                            report.check(len(text) > 120, f"visualization {manifest_ref} {viewport} SVG suspiciously small")
                            report.check(all(token in text for token in ("<svg", "<title", "<desc")), f"visualization {manifest_ref} {viewport} SVG lacks accessibility markup")
                            hash_key = f"{viewport}_sha256"
                            if hash_key in viz_hashes:
                                report.check(viz_hashes[hash_key] == sha256_file(svg_path), f"visualization {manifest_ref} {viewport} hash mismatch against manifest.hashes.{hash_key}")
                    except Exception as exc:
                        report.check(False, f"visualization {manifest_ref} unsafe {viewport} SVG ref: {exc}")
            # Choropleth-only: a choropleth's color channel can only be
            # exempted from the color_only_quantity lint blocker
            # (editorial_validators.mjs's visualChannelOwnerValidator) when
            # its render_qa report independently proves every plotted
            # region's value is shown as complete, exact, legible text.
            # Re-derive that proof from the artifact here too - never trust
            # the manifest's own render_qa summary or the JS lint's
            # "passed" boolean - so a published choropleth cannot carry a
            # missing/failing/stale value_labels check, or one bound to an
            # SVG that no longer matches the file on disk. Rust's
            # check_render_qa_ref enforces this same rule; this is Python's
            # independent re-implementation, scoped to chart_type ==
            # "choropleth" (Python does not yet re-verify render_qa_ref for
            # every chart type the way Rust does - a pre-existing gap, out
            # of scope here).
            # A listed compact variant is bound to render QA for every chart
            # type (viewports.compact.svg_sha256 must equal the file's hash);
            # choropleths get this through the full loop below.
            # Fail closed: a listed compact variant needs a valid render_qa_ref, an
            # existing QA report, and viewports.compact.svg_sha256 - each missing
            # piece is a failure, never a silent skip.
            if "compact" in viz_variants:
                compact_qa_ref = viz_qa_ref
                compact_qa_ok = isinstance(compact_qa_ref, str) and compact_qa_ref.startswith("visualizations/qa/")
                report.check(compact_qa_ok, f"visualization {manifest_ref} lists a compact variant without a valid render_qa_ref")
                if compact_qa_ok:
                    try:
                        compact_qa_path = safe_ref(root, compact_qa_ref)
                        report.check(compact_qa_path.is_file(), f"visualization {manifest_ref} compact variant: render_qa report {compact_qa_ref} does not exist")
                        compact_ref_value = viz_variants.get("compact")
                        compact_svg_path = safe_ref(root, compact_ref_value) if isinstance(compact_ref_value, str) else None
                        if compact_qa_path.is_file() and compact_svg_path is not None and compact_svg_path.is_file():
                            compact_expected = (((load_json(compact_qa_path).get("viewports") or {}).get("compact")) or {}).get("svg_sha256")
                            report.check(isinstance(compact_expected, str), f"visualization {manifest_ref} render_qa report is missing viewports.compact.svg_sha256")
                            if isinstance(compact_expected, str):
                                report.check(sha256_file(compact_svg_path) == compact_expected, f"visualization {manifest_ref} compact SVG hash does not match render_qa report")
                    except Exception as exc:
                        report.check(False, f"visualization {manifest_ref} unsafe compact render_qa binding: {exc}")
            if manifest.get("chart_type") == "choropleth":
                render_qa_ref = viz_qa_ref
                if draft and not isinstance(render_qa_ref, str):
                    pass
                elif not isinstance(render_qa_ref, str) or not render_qa_ref.startswith("visualizations/qa/"):
                    report.check(False, f"choropleth visualization {manifest_ref} missing or invalid render_qa_ref")
                else:
                    try:
                        qa_path = safe_ref(root, render_qa_ref)
                        report.check(qa_path.is_file(), f"choropleth visualization {manifest_ref} render_qa_ref is missing: {render_qa_ref}")
                        if qa_path.is_file():
                            qa = load_json(qa_path)
                            report.check(qa.get("schema_version") == RENDER_QA_REPORT_SCHEMA_VERSION, f"choropleth visualization {manifest_ref} render_qa report has an unknown schema_version")
                            for viewport in ("desktop", "mobile", "compact"):
                                if viewport != "desktop" and viewport not in viz_variants:
                                    continue
                                svg_ref = viz_variants.get(viewport)
                                if not isinstance(svg_ref, str):
                                    continue
                                svg_path = safe_ref(root, svg_ref)
                                if not svg_path.is_file():
                                    continue
                                viewport_report = (qa.get("viewports") or {}).get(viewport) or {}
                                expected_hash = viewport_report.get("svg_sha256")
                                report.check(isinstance(expected_hash, str), f"choropleth visualization {manifest_ref} render_qa report is missing viewports.{viewport}.svg_sha256")
                                if isinstance(expected_hash, str):
                                    report.check(sha256_file(svg_path) == expected_hash, f"choropleth visualization {manifest_ref} {viewport} SVG hash does not match render_qa report")
                                if not draft:
                                    value_labels_passed = ((viewport_report.get("value_labels") or {}).get("passed"))
                                    report.check(value_labels_passed is True, f"choropleth visualization {manifest_ref} render_qa is missing a passing value_labels check for {viewport}")
                                    # Review fix 7: never trust the report's
                                    # own value_labels.passed boolean alone,
                                    # even sha256-bound - independently
                                    # re-derive the same proof from these SVG
                                    # bytes on disk.
                                    try:
                                        svg_text = svg_path.read_text(encoding="utf-8")
                                        for failure in verify_choropleth_labels_from_svg(svg_text):
                                            report.check(False, f"choropleth visualization {manifest_ref} {viewport} independent value-labels re-derivation failed: {failure}")
                                    except Exception as exc:
                                        report.check(False, f"choropleth visualization {manifest_ref} failed reading {viewport} SVG for independent value-labels re-derivation: {exc}")
                    except Exception as exc:
                        report.check(False, f"choropleth visualization {manifest_ref} render_qa_ref verification failed: {exc}")
            # Heatmap-only, NEWSROOM_HEATMAP_VALUE_LABELS=1 (exact "1", default off): a viewport whose render_qa
            # report CLAIMS a passing value_labels proof is re-derived from the SVG bytes on disk and bound to
            # them by sha256 - the JS lint's exemption is never the only gate. Adds strictness only.
            if manifest.get("chart_type") == "heatmap" and os.environ.get("NEWSROOM_HEATMAP_VALUE_LABELS") == "1":
                heat_qa_ref = viz_qa_ref
                if isinstance(heat_qa_ref, str) and heat_qa_ref.startswith("visualizations/qa/"):
                    try:
                        heat_qa_path = safe_ref(root, heat_qa_ref)
                        if heat_qa_path.is_file():
                            heat_viewports = load_json(heat_qa_path).get("viewports") or {}
                            for viewport, heat_report in heat_viewports.items():
                                if not isinstance((heat_report or {}).get("value_labels"), dict) or heat_report["value_labels"].get("passed") is not True:
                                    continue
                                svg_ref = viz_variants.get(viewport)
                                if not isinstance(svg_ref, str):
                                    report.check(False, f"heatmap visualization {manifest_ref} claims value_labels for unlisted viewport {viewport}")
                                    continue
                                svg_path = safe_ref(root, svg_ref)
                                if not svg_path.is_file():
                                    continue
                                report.check(sha256_file(svg_path) == heat_report.get("svg_sha256"), f"heatmap visualization {manifest_ref} {viewport} SVG hash does not match render_qa report")
                                for failure in verify_heatmap_labels_from_svg(svg_path.read_text(encoding="utf-8")):
                                    report.check(False, f"heatmap visualization {manifest_ref} {viewport} independent value-labels re-derivation failed: {failure}")
                    except Exception as exc:
                        report.check(False, f"heatmap visualization {manifest_ref} value-labels re-derivation failed: {exc}")
            if os.environ.get("NEWSROOM_QA_TICK_READBACK") == "1":
                verify_tick_readback_for_manifest(root, manifest, manifest_ref, computation_map, report)
            if isinstance(lint_ref, str):
                try:
                    lint_path = safe_ref(root, lint_ref)
                    if lint_path.is_file():
                        lint = load_json(lint_path)
                        report.check(lint.get("passed") is True, f"visualization {manifest_ref} lint did not pass")
                        report.check(lint.get("plan_ref") == plan_ref, f"visualization {manifest_ref} lint plan_ref mismatch")
                        comp_ref = lint.get("computation_ref")
                        report.check(isinstance(comp_ref, str), f"visualization {manifest_ref} lint missing computation_ref")
                        if isinstance(comp_ref, str):
                            comp_path = safe_ref(root, comp_ref)
                            report.check(comp_path.is_file(), f"visualization {manifest_ref} computation missing: {comp_ref}")
                            comp = computation_map.get(comp_ref) or (load_json(comp_path) if comp_path.is_file() else {})
                            if lint.get("data_hash") and comp.get("result_hash"):
                                report.check(lint["data_hash"] == comp["result_hash"], f"visualization {manifest_ref} lint hash differs from computation")
                                report.check(manifest.get("data_hash") == comp["result_hash"], f"visualization {manifest_ref} manifest hash differs from computation")
                except Exception as exc:
                    report.check(False, f"visualization {manifest_ref} lint verification failed: {exc}")
            linked = [c for c in critics if c.get("manifest_ref") == manifest_ref]
            report.check(bool(linked), f"visualization {manifest_ref} has no critic artifact")
            report.check(any(c.get("passed") is True for c in linked), f"visualization {manifest_ref} has no passing critic")

    # v1.4 editorial-intelligence artifacts are content-addressed and independently replayed.
    discovery_dir = root / "editorial" / "discovery"
    if discovery_dir.is_dir():
        for path in sorted(discovery_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                report.check(item.get("schema_version") == EDITORIAL_DISCOVERY_VERSION, f"editorial discovery {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"editorial discovery {rel} content hash mismatch")
                report.check(item.get("decision") == replay_discovery_decision(item), f"editorial discovery {rel} decision is not independently replayable")
            except Exception as exc:
                report.check(False, f"editorial discovery verification failed {rel}: {exc}")

    concept_dir = root / "editorial" / "concepts"
    if concept_dir.is_dir():
        for path in sorted(concept_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                concepts = item.get("concepts") or []
                report.check(item.get("schema_version") == VISUAL_CONCEPT_SET_VERSION, f"visual concepts {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"visual concepts {rel} content hash mismatch")
                report.check(concept_min_count() <= len(concepts) <= 20, f"visual concepts {rel} must contain 8..20 candidates" if concept_min_count() == 8 else f"visual concepts {rel} must contain {concept_min_count()}..20 candidates")
                report.check(len({str(c.get('framing')) for c in concepts}) >= 3, f"visual concepts {rel} insufficient framing diversity")
                finalists = replay_concept_finalists(concepts)
                report.check(item.get("finalists") == finalists, f"visual concepts {rel} finalists are not independently replayable")
                report.check(item.get("selected_concept_id") == (finalists[0] if finalists else None), f"visual concepts {rel} selected concept mismatch")
                discovery_ref = item.get("discovery_ref")
                report.check(isinstance(discovery_ref, str) and discovery_ref.startswith("editorial/discovery/") and safe_ref(root, discovery_ref).is_file(), f"visual concepts {rel} missing discovery_ref")
            except Exception as exc:
                report.check(False, f"visual concept verification failed {rel}: {exc}")

    novelty_dir = root / "editorial" / "novelty"
    if novelty_dir.is_dir():
        for path in sorted(novelty_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                report.check(item.get("schema_version") == SEMANTIC_NOVELTY_VERSION, f"semantic novelty {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"semantic novelty {rel} content hash mismatch")
                decisions, passed = replay_novelty(item.get("modules") or [])
                report.check(item.get("decisions") == decisions, f"semantic novelty {rel} decisions are not independently replayable")
                report.check(item.get("passed") is passed, f"semantic novelty {rel} pass state mismatch")
                concept_ref = item.get("concept_ref")
                report.check(isinstance(concept_ref, str) and concept_ref.startswith("editorial/concepts/") and safe_ref(root, concept_ref).is_file(), f"semantic novelty {rel} missing concept_ref")
            except Exception as exc:
                report.check(False, f"semantic novelty verification failed {rel}: {exc}")

    asset_plan_dir = root / "editorial" / "assets"
    if asset_plan_dir.is_dir():
        for path in sorted(asset_plan_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                report.check(item.get("schema_version") == ASSET_PLAN_VERSION, f"asset plan {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"asset plan {rel} content hash mismatch")
                report.check(item.get("decision") == replay_asset_plan_decision(item), f"asset plan {rel} decision is not independently replayable")
                concept_ref = item.get("concept_ref")
                report.check(isinstance(concept_ref, str) and concept_ref.startswith("editorial/concepts/") and safe_ref(root, concept_ref).is_file(), f"asset plan {rel} missing concept_ref")
            except Exception as exc:
                report.check(False, f"asset plan verification failed {rel}: {exc}")

    reference_dir = root / "editorial" / "references"
    if reference_dir.is_dir():
        for path in sorted(reference_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                report.check(item.get("schema_version") == REFERENCE_CORPUS_VERSION, f"reference retrieval {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"reference retrieval {rel} content hash mismatch")
                for match in item.get("matches") or []:
                    report.check(bool(match.get("source_url")), f"reference retrieval {rel} match missing source_url")
                    report.check(bool(match.get("differentiation_rule")), f"reference retrieval {rel} match missing differentiation_rule")
            except Exception as exc:
                report.check(False, f"reference retrieval verification failed {rel}: {exc}")

    preference_dir = root / "editorial" / "preferences"
    if preference_dir.is_dir():
        for path in sorted(preference_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                report.check(item.get("schema_version") == EXPERT_PREFERENCE_VERSION, f"expert preference {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"expert preference {rel} content hash mismatch")
                status, share = replay_preference_status(item)
                report.check(item.get("status") == status, f"expert preference {rel} status is not independently replayable")
                report.check(float(item.get("candidate_decisive_share") or 0.0) == share, f"expert preference {rel} candidate share mismatch")
                if item.get("status_source") == PROGRAM_STATUS_SOURCE:
                    # program-computed status: only review records the program saved count; the stored status must follow from them
                    p_status, p_share, p_count = replay_program_preference(root, item)
                    refs_listed = item.get("review_record_refs") or []
                    report.check(p_count == len(refs_listed), f"expert preference {rel} lists a review record the program did not save")
                    report.check(item.get("status") == p_status, f"expert preference {rel} status does not follow from the program's review records")
                    report.check(float(item.get("candidate_decisive_share") or 0.0) == p_share, f"expert preference {rel} share does not follow from the program's review records")
                    report.check(int((item.get("counts") or {}).get("total") or 0) == p_count, f"expert preference {rel} review count does not follow from the program's review records")
                    report.check((item.get("model_reported_reviews") or {}).get("counted") is False, f"expert preference {rel} counted model-reported reviews")
                ids = [str(r.get("reviewer_id_hash")) for r in item.get("reviews") or [] if isinstance(r, dict)]
                report.check(len(ids) == len(set(ids)), f"expert preference {rel} duplicate reviewer ids")
            except Exception as exc:
                report.check(False, f"expert preference verification failed {rel}: {exc}")

    award_run_dir = root / "editorial" / "award-runs"
    if award_run_dir.is_dir():
        for path in sorted(award_run_dir.glob("*.json")):
            rel = path.relative_to(root).as_posix()
            try:
                item = load_json(path)
                report.check(item.get("schema_version") == AWARD_MODE_STATUS_VERSION, f"award mode {rel} schema_version mismatch")
                report.check(item.get("content_hash") == editorial_hash(item), f"award mode {rel} content hash mismatch")
                status, blockers = replay_award_mode_status(item)
                report.check(item.get("status") == status, f"award mode {rel} status is not independently replayable")
                report.check(item.get("blockers") == blockers, f"award mode {rel} blockers are not independently replayable")
                report.check(item.get("human_evidence_required") is True, f"award mode {rel} must retain human evidence boundary")
                if item.get("status_source") == PROGRAM_STATUS_SOURCE:
                    # program-computed status: the preference status and review count come from the program's own preference record
                    pref_item = None
                    pref_path = (item.get("refs") or {}).get("preference_ref")
                    if pref_path:
                        try:
                            candidate_pref = load_json(safe_ref(root, pref_path))
                            if candidate_pref.get("status_source") == PROGRAM_STATUS_SOURCE and candidate_pref.get("content_hash") == editorial_hash(candidate_pref):
                                pref_item = candidate_pref
                        except Exception:
                            pref_item = None
                    expected_pref = pref_item.get("status") if pref_item else "PENDING"
                    expected_count = int((pref_item.get("counts") or {}).get("total") or 0) if pref_item else 0
                    report.check(item.get("preference_status") == expected_pref, f"award mode {rel} preference status does not follow from the program's preference record")
                    report.check(int((item.get("metrics") or {}).get("human_review_count") or 0) == expected_count, f"award mode {rel} human review count does not follow from the program's preference record")
                refs = item.get("refs") or {}
                for field, prefix in [("discovery_ref", "editorial/discovery/"), ("concepts_ref", "editorial/concepts/"), ("asset_plan_ref", "editorial/assets/"), ("novelty_ref", "editorial/novelty/"), ("page_ref", "infographics/")]:
                    ref = refs.get(field)
                    report.check(isinstance(ref, str) and ref.startswith(prefix) and safe_ref(root, ref).is_file(), f"award mode {rel} missing or unsafe {field}")
                pref_ref = refs.get("preference_ref")
                if pref_ref:
                    report.check(isinstance(pref_ref, str) and pref_ref.startswith("editorial/preferences/") and safe_ref(root, pref_ref).is_file(), f"award mode {rel} missing or unsafe preference_ref")
            except Exception as exc:
                report.check(False, f"award mode verification failed {rel}: {exc}")

    # magazine infographic integrity. These are composition artifacts that must
    # preserve upstream visualization provenance and responsive output hashes.
    infographic_critics = []
    info_critic_dir = root / "infographics" / "critics"
    if info_critic_dir.is_dir():
        for path in sorted(info_critic_dir.glob("*.json")):
            try:
                infographic_critics.append(load_json(path))
            except Exception as exc:
                report.check(False, f"infographic critic unreadable {path}: {exc}")

    infographic_vision_critics = []
    info_vision_critic_dir = root / "infographics" / "vision-critics"
    if info_vision_critic_dir.is_dir():
        for path in sorted(info_vision_critic_dir.glob("*.json")):
            try:
                infographic_vision_critics.append(load_json(path))
            except Exception as exc:
                report.check(False, f"infographic vision critic unreadable {path}: {exc}")

    infographic_dir = root / "infographics"
    if infographic_dir.is_dir():
        for manifest_path in sorted(infographic_dir.glob("*.json")):
            try:
                manifest = load_json(manifest_path)
            except Exception as exc:
                report.check(False, f"infographic manifest unreadable {manifest_path}: {exc}")
                continue
            infographic_version = manifest.get("schema_version")
            manifest_ref = manifest_path.relative_to(root).as_posix()
            if infographic_version not in INFOGRAPHIC_SCHEMA_VERSIONS:
                # Every top-level infographics/*.json is verified - never
                # silently skipped, the same failure mode V4 closed for
                # visualizations/*.json. newsroom_infographic_render copies
                # spec.schema_version verbatim into the manifest, so an
                # out-of-range value here means the manifest was never
                # validated by validateInfographicSpec at all.
                report.check(False, f"infographic {manifest_ref} has an unsupported schema_version: {infographic_version}")
                continue
            if not isinstance(manifest.get("variants"), dict) or not manifest.get("plan_ref") or not manifest.get("lint_ref"):
                # Anything shaped like this bypassed newsroom_infographic_plan
                # -> lint -> render entirely, the same silent-skip gap V4
                # closed for visualizations/*.json.
                report.check(False, f"infographic {manifest_ref} is not a gated infographic manifest (no plan_ref/lint_ref/variants)")
                continue
            plan_ref, lint_ref = manifest.get("plan_ref"), manifest.get("lint_ref")
            for label, ref, prefix in [("plan", plan_ref, "infographics/plans/"), ("lint", lint_ref, "infographics/lints/")]:
                report.check(isinstance(ref, str) and ref.startswith(prefix), f"infographic {manifest_ref} invalid {label}_ref")
                if isinstance(ref, str):
                    try:
                        report.check(safe_ref(root, ref).is_file(), f"infographic {manifest_ref} missing {label}: {ref}")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} unsafe {label} ref: {exc}")
            # The source strip's language is read from the hash-bound plan
            # (never from the rendered SVG text itself), so a page can't pass
            # by having any strip at all - it must be the one its own plan
            # asked for. Defaults to "en", matching the runtime's own
            # language: params.language ?? "en" default.
            plan_language = "en"
            if isinstance(plan_ref, str):
                try:
                    plan_path = safe_ref(root, plan_ref)
                    if plan_path.is_file():
                        plan = load_json(plan_path)
                        if plan.get("language") == "zh":
                            plan_language = "zh"
                        report.check(plan.get("schema_version") == infographic_version, f"infographic {manifest_ref} plan schema_version mismatch")
                        if infographic_version in {"1.1.0", "1.2.0", "1.3.0"}:
                            for field in ("intent", "primary_message", "story_arc", "audience", "quality_target"):
                                report.check(bool(plan.get(field)), f"infographic {manifest_ref} {infographic_version} plan missing {field}")
                        if infographic_version in {"1.2.0", "1.3.0"}:
                            report.check(plan.get("competition_profile") in INFOGRAPHIC_COMPETITION_PROFILES, f"infographic {manifest_ref} 1.2 plan has invalid competition_profile")
                            if plan.get("mobile_module_order") is not None:
                                module_ids = [str(module.get("id")) for module in plan.get("modules") or []]
                                mobile_order = [str(item) for item in plan.get("mobile_module_order") or []]
                                report.check(len(mobile_order) == len(module_ids) and len(set(mobile_order)) == len(module_ids) and set(mobile_order) == set(module_ids), f"infographic {manifest_ref} mobile_module_order must be an exact module permutation")
                        if infographic_version in {"1.4.0", "1.5.0"}:
                            # K258: the concept set and selected concept may be missing only when the page manifest records the lean gates
                            # (written by the renderer when NEWSROOM_LEAN_GATES=1); a manifest without that record needs them as before.
                            lean_page = manifest.get("lean_gates") is True
                            for field, prefix in [("visual_concept_ref", "editorial/concepts/")]:
                                ref = plan.get(field)
                                if ref is None and lean_page:
                                    continue
                                report.check(isinstance(ref, str) and ref.startswith(prefix), f"infographic {manifest_ref} {infographic_version} plan invalid {field}")
                                if isinstance(ref, str):
                                    try: report.check(safe_ref(root, ref).is_file(), f"infographic {manifest_ref} missing {field}: {ref}")
                                    except Exception as exc: report.check(False, f"infographic {manifest_ref} unsafe {field}: {exc}")
                            for field, prefix in [("asset_plan_ref", "editorial/assets/"), ("novelty_ref", "editorial/novelty/")]:
                                ref = plan.get(field)
                                if ref is None and lean_page:
                                    continue
                                report.check(isinstance(ref, str) and ref.startswith(prefix), f"infographic {manifest_ref} {infographic_version} plan invalid {field}")
                                if isinstance(ref, str):
                                    try: report.check(safe_ref(root, ref).is_file(), f"infographic {manifest_ref} missing {field}: {ref}")
                                    except Exception as exc: report.check(False, f"infographic {manifest_ref} unsafe {field}: {exc}")
                            if lean_page and any(isinstance(m, dict) and m.get("type") == "panel" for m in plan.get("modules") or []):
                                for message in lean_scene_graph_issues(plan):
                                    report.check(False, f"infographic {manifest_ref} {message}")
                            if not (plan.get("selected_concept_id") is None and lean_page):
                                report.check(isinstance(plan.get("selected_concept_id"), str) and bool(str(plan.get("selected_concept_id")).strip()), f"infographic {manifest_ref} {infographic_version} plan missing selected_concept_id")
                        if infographic_version == "1.3.0" and plan.get("quality_target") == "award":
                            for field, prefix in [("editorial_discovery_ref", "editorial/discovery/"), ("visual_concept_ref", "editorial/concepts/"), ("novelty_ref", "editorial/novelty/"), ("asset_plan_ref", "editorial/assets/")]:
                                ref = plan.get(field)
                                report.check(isinstance(ref, str) and ref.startswith(prefix), f"infographic {manifest_ref} 1.3 award plan invalid {field}")
                                if isinstance(ref, str):
                                    try: report.check(safe_ref(root, ref).is_file(), f"infographic {manifest_ref} missing {field}: {ref}")
                                    except Exception as exc: report.check(False, f"infographic {manifest_ref} unsafe {field}: {exc}")
                            graph = plan.get("scene_graph") or {}
                            report.check(graph.get("schema_version") == "0.1.0" and isinstance(graph.get("scenes"), list) and bool(graph.get("scenes")), f"infographic {manifest_ref} 1.3 award plan missing scene graph")
                            members = set()
                            module_ids_set = set(module_ids)
                            for scene in graph.get("scenes") or []:
                                ids = [str(scene.get("anchor_module_id", ""))] + [str(x) for x in scene.get("sidecar_module_ids") or []]
                                report.check(scene.get("pattern") in {"hero_sidecar_stack", "hero_with_rail"}, f"infographic {manifest_ref} scene has invalid pattern")
                                report.check(all(i in module_ids_set for i in ids), f"infographic {manifest_ref} scene references unknown module")
                                report.check(not any(i in members for i in ids), f"infographic {manifest_ref} module belongs to multiple scenes")
                                members.update(ids)
                        variants_for_quotes = manifest.get("variants") if isinstance(manifest.get("variants"), dict) else {}
                        verify_infographic_source_quotes(root, manifest_ref, plan, plan_language, variants_for_quotes.get("desktop"), report)
                except Exception as exc:
                    report.check(False, f"infographic {manifest_ref} plan verification failed: {exc}")
            visual_refs = manifest.get("visual_manifest_refs") or []
            report.check(isinstance(visual_refs, list) and len(visual_refs) >= 2, f"infographic {manifest_ref} must reference at least two visualization manifests")
            if isinstance(visual_refs, list):
                for ref in visual_refs:
                    try:
                        report.check(isinstance(ref, str) and ref.startswith("visualizations/") and safe_ref(root, ref).is_file(), f"infographic {manifest_ref} missing upstream visualization: {ref}")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} unsafe upstream visualization ref {ref}: {exc}")
            illustration_refs = manifest.get("illustration_manifest_refs") or []
            report.check(isinstance(illustration_refs, list), f"infographic {manifest_ref} illustration_manifest_refs must be a list")
            if isinstance(illustration_refs, list):
                for ref in illustration_refs:
                    try:
                        ok_ref = isinstance(ref, str) and ref.startswith("visualizations/illustrations/")
                        report.check(ok_ref, f"infographic {manifest_ref} invalid illustration ref: {ref}")
                        if not ok_ref:
                            continue
                        illustration_path = safe_ref(root, ref)
                        report.check(illustration_path.is_file(), f"infographic {manifest_ref} missing illustration: {ref}")
                        if not illustration_path.is_file():
                            continue
                        illustration = load_json(illustration_path)
                        illustration_version = illustration.get("schema_version")
                        report.check(illustration_version in {"0.1.0", "0.2.0"}, f"illustration {ref} schema_version mismatch")
                        if illustration_version == "0.1.0":
                            report.check(illustration.get("not_to_scale") is True, f"illustration {ref} must disclose not_to_scale")
                        elif illustration_version == "0.2.0":
                            report.check(illustration.get("kind") == "rich_illustration", f"illustration {ref} 0.2 must declare kind=rich_illustration")
                            provenance = illustration.get("provenance") or {}
                            origin = provenance.get("origin")
                            report.check(origin in {"human", "generative_ai", "mixed", "software"}, f"illustration {ref} has invalid origin provenance")
                            report.check(bool(provenance.get("digital_source_type")), f"illustration {ref} missing digital_source_type")
                            report.check(bool(provenance.get("disclosure")), f"illustration {ref} missing disclosure")
                            if origin in {"generative_ai", "mixed"}:
                                report.check(bool(provenance.get("provider")) and bool(provenance.get("model")), f"illustration {ref} missing AI system provenance")
                            for evidence_ref in illustration.get("evidence_refs") or []:
                                try:
                                    allowed = isinstance(evidence_ref, str) and (evidence_ref.startswith("sources/") or evidence_ref.startswith("data/") or evidence_ref.startswith("computations/"))
                                    report.check(allowed and safe_ref(root, evidence_ref).is_file(), f"illustration {ref} missing evidence ref: {evidence_ref}")
                                except Exception as exc:
                                    report.check(False, f"illustration {ref} invalid evidence ref {evidence_ref}: {exc}")
                        for claim_id in illustration.get("claim_ids") or []:
                            report.check(str(claim_id) in verified_ids, f"illustration {ref} claim_id is not verified: {claim_id}")
                        variants = illustration.get("variants") or {}
                        hashes = illustration.get("hashes") or {}
                        report.check(set(variants) <= {"desktop", "mobile"}, f"illustration {ref} lists an unknown variant: {sorted(set(variants) - {'desktop', 'mobile'})}")
                        report.check("mobile_sha256" not in hashes or "mobile" in variants, f"illustration {ref} has hashes.mobile_sha256 without a mobile variant")
                        for viewport, hash_key in [("desktop", "desktop_sha256"), ("mobile", "mobile_sha256")]:
                            if viewport == "mobile" and "mobile" not in variants:
                                continue
                            svg_ref = variants.get(viewport)
                            report.check(isinstance(svg_ref, str) and svg_ref.startswith("visualizations/illustrations/"), f"illustration {ref} invalid {viewport} variant")
                            if isinstance(svg_ref, str):
                                svg_path = safe_ref(root, svg_ref)
                                report.check(svg_path.is_file(), f"illustration {ref} missing {viewport} SVG")
                                if svg_path.is_file():
                                    text = svg_path.read_text(encoding="utf-8")
                                    if illustration_version == "0.1.0":
                                        expected_tokens = ("<svg", "<title", "<desc", "data-explainer-version=\"0.1.0\"", "SCHEMATIC / NOT TO SCALE")
                                    else:
                                        expected_tokens = ("<svg", "<title", "<desc", "data-rich-illustration-version=\"0.2.0\"", "data-origin=")
                                    report.check(all(token in text for token in expected_tokens), f"illustration {ref} {viewport} lacks provenance/accessibility disclosure")
                                    report.check("<script" not in text.lower() and "<foreignobject" not in text.lower(), f"illustration {ref} {viewport} contains active SVG content")
                                    expected = hashes.get(hash_key)
                                    report.check(isinstance(expected, str) and len(expected) == 64, f"illustration {ref} missing {hash_key}")
                                    if isinstance(expected, str):
                                        report.check(sha256_file(svg_path) == expected, f"illustration {ref} {viewport} hash mismatch")
                        plan_ref_i, lint_ref_i = illustration.get("plan_ref"), illustration.get("lint_ref")
                        report.check(isinstance(plan_ref_i, str) and safe_ref(root, plan_ref_i).is_file(), f"illustration {ref} missing plan")
                        report.check(isinstance(lint_ref_i, str) and safe_ref(root, lint_ref_i).is_file(), f"illustration {ref} missing lint")
                        linked_critics = [c for c in infographic_critics if False]  # keep namespaces separate below
                        illustration_critic_dir = root / "visualizations" / "illustrations" / "critics"
                        passing_illustration_critic = False
                        if illustration_critic_dir.is_dir():
                            for critic_path in illustration_critic_dir.glob("*.json"):
                                try:
                                    critic = load_json(critic_path)
                                    if critic.get("manifest_ref") == ref and critic.get("passed") is True:
                                        passing_illustration_critic = True
                                        break
                                except Exception:
                                    pass
                        report.check(passing_illustration_critic, f"illustration {ref} has no passing critic")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} illustration verification failed for {ref}: {exc}")
            for claim_id in manifest.get("claim_ids") or []:
                report.check(str(claim_id) in verified_ids, f"infographic {manifest_ref} claim_id is not verified: {claim_id}")
            hashes = manifest.get("hashes") or {}
            # The desktop page is required; the mobile page is optional (the
            # runtime renders it only with NEWSROOM_MOBILE_PAGES=1). A listed
            # mobile page is checked exactly like the desktop one, and nothing
            # else may be listed.
            page_variants = manifest["variants"]
            report.check(set(page_variants) <= {"desktop", "mobile"}, f"infographic {manifest_ref} lists an unknown variant: {sorted(set(page_variants) - {'desktop', 'mobile'})}")
            report.check("mobile_sha256" not in hashes or "mobile" in page_variants, f"infographic {manifest_ref} has hashes.mobile_sha256 without a mobile variant")
            for viewport, hash_key in [("desktop", "desktop_sha256"), ("mobile", "mobile_sha256")]:
                if viewport == "mobile" and "mobile" not in page_variants:
                    continue
                ref = manifest["variants"].get(viewport)
                report.check(isinstance(ref, str) and bool(ref), f"infographic {manifest_ref} missing {viewport} variant")
                if isinstance(ref, str):
                    try:
                        svg_path = safe_ref(root, ref)
                        report.check(svg_path.is_file(), f"infographic {manifest_ref} missing SVG: {ref}")
                        if svg_path.is_file():
                            text = svg_path.read_text(encoding="utf-8")
                            report.check(len(text) > 500, f"infographic {manifest_ref} {viewport} SVG suspiciously small")
                            report.check(all(token in text for token in ("<svg", "<title", "<desc", f"data-infographic-version=\"{infographic_version}\"")), f"infographic {manifest_ref} {viewport} SVG lacks magazine/accessibility markup")
                            expected_strip = "资料来源与方法" if plan_language == "zh" else "SOURCES &amp; METHODS"
                            report.check(expected_strip in text, f"infographic {manifest_ref} {viewport} source strip missing or wrong language for plan language={plan_language}")
                            expected = hashes.get(hash_key)
                            report.check(isinstance(expected, str) and len(expected) == 64, f"infographic {manifest_ref} missing {hash_key}")
                            if isinstance(expected, str):
                                report.check(sha256_file(svg_path) == expected, f"infographic {manifest_ref} {viewport} hash mismatch")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} unsafe {viewport} SVG ref: {exc}")
            if isinstance(lint_ref, str):
                try:
                    lint_path = safe_ref(root, lint_ref)
                    if lint_path.is_file():
                        lint = load_json(lint_path)
                        report.check(lint.get("passed") is True, f"infographic {manifest_ref} lint did not pass")
                        report.check(lint.get("plan_ref") == plan_ref, f"infographic {manifest_ref} lint plan_ref mismatch")
                except Exception as exc:
                    report.check(False, f"infographic {manifest_ref} lint verification failed: {exc}")
            linked = [c for c in infographic_critics if c.get("manifest_ref") == manifest_ref]
            report.check(bool(linked), f"infographic {manifest_ref} has no critic artifact")
            passing = [c for c in linked if c.get("passed") is True]
            report.check(bool(passing), f"infographic {manifest_ref} has no passing critic")
            # infographic.mjs's critiqueInfographic dispatches on this exact
            # set (["1.1.0","1.2.0","1.3.0","1.4.0","1.5.0"].includes(spec.schema_version),
            # infographic.mjs:1214): every one of these versions - not just
            # 1.1.0/1.2.0 - gets critiqueAwardOne's full rubric object; only
            # 1.0.0 falls back to critiqueLegacyOne, whose returned critique
            # has no rubric field at all.
            if infographic_version in {"1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"} and passing:
                rubric = passing[0].get("rubric") or {}
                expected_rubric = {"impact_story_focus", "engagement", "clarity_information_flow", "effectiveness", "hierarchy", "editorial_rhythm", "inclusion_accessibility", "responsive_execution", "craft_geometry", "originality_variety"}
                report.check(expected_rubric.issubset(rubric.keys()), f"infographic {manifest_ref} critic missing award-informed rubric dimensions")
            if manifest.get("visual_review_required") is True:
                linked_vision = [c for c in infographic_vision_critics if c.get("manifest_ref") == manifest_ref]
                report.check(bool(linked_vision), f"infographic {manifest_ref} requires image-aware vision critic")
                passing_vision = [c for c in linked_vision if c.get("passed") is True]
                if vision_veto_only_enabled():
                    # NEWSROOM_VISION_VETO_ONLY=1: the model's passed releases nothing; every record is re-derived and gets the chain checks.
                    report.check(not any(vision_critic_fails(c) for c in linked_vision), f"infographic {manifest_ref} failed by an image-aware vision critic (passed false, score below 80, a rubric item below 60 or a blocker)")
                    checked_vision = linked_vision
                else:
                    report.check(bool(passing_vision), f"infographic {manifest_ref} has no passing image-aware vision critic")
                    if model_pass_selfreport_enabled():
                        report.check(not any(vision_critic_vetoes(c) for c in linked_vision), f"infographic {manifest_ref} vetoed by an image-aware vision critic (failed, score below 80 or blocker)")
                    checked_vision = passing_vision[:1]
                for vision in checked_vision:
                    report.check(vision.get("schema_version") in {"0.1.0", "0.2.0"} and vision.get("kind") == "image_aware_model", f"infographic {manifest_ref} vision critic schema/kind mismatch")
                    if strict_readers():
                        vision_score = finite_number(vision.get("score"))
                        report.check(vision_score is not None and 80 <= vision_score <= 100, f"infographic {manifest_ref} vision critic score below 80")
                    else:
                        report.check(float(vision.get("score") or 0) >= 80, f"infographic {manifest_ref} vision critic score below 80")
                    report.check(not any(i.get("severity") == "blocker" for i in vision.get("issues") or []), f"infographic {manifest_ref} vision critic contains blocker")
                    vision_rubric = vision.get("rubric") or {}
                    expected_vision_rubric = {"hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"}
                    report.check(expected_vision_rubric.issubset(vision_rubric.keys()), f"infographic {manifest_ref} vision critic missing rubric dimensions")
                    deterministic_ref = vision.get("deterministic_critic_ref")
                    try:
                        deterministic_path = safe_ref(root, deterministic_ref) if isinstance(deterministic_ref, str) else None
                        report.check(bool(deterministic_path and deterministic_path.is_file() and deterministic_ref.startswith("infographics/critics/")), f"infographic {manifest_ref} vision critic lacks deterministic foundation")
                        if deterministic_path and deterministic_path.is_file():
                            deterministic = load_json(deterministic_path)
                            report.check(deterministic.get("manifest_ref") == manifest_ref and deterministic.get("passed") is True, f"infographic {manifest_ref} vision critic deterministic link mismatch")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} deterministic critic ref invalid: {exc}")
                    preview_ref = vision.get("preview_ref")
                    try:
                        preview_path = safe_ref(root, preview_ref) if isinstance(preview_ref, str) else None
                        report.check(bool(preview_path and preview_path.is_file() and preview_ref.startswith("infographics/previews/")), f"infographic {manifest_ref} vision preview missing")
                        if preview_path and preview_path.is_file():
                            preview = load_json(preview_path)
                            report.check(preview.get("manifest_ref") == manifest_ref, f"infographic {manifest_ref} preview manifest link mismatch")
                            report.check(preview.get("source_hashes") == manifest.get("hashes"), f"infographic {manifest_ref} preview source hashes mismatch")
                            report.check(set(preview.get("variants") or {}) == set(manifest["variants"]), f"infographic {manifest_ref} preview variants do not match the page variants")
                            for viewport, hash_key in [("desktop", "desktop_sha256"), ("mobile", "mobile_sha256")]:
                                if viewport == "mobile" and "mobile" not in manifest["variants"]:
                                    continue
                                png_ref = (preview.get("variants") or {}).get(viewport)
                                report.check(isinstance(png_ref, str) and png_ref.startswith("infographics/previews/"), f"infographic {manifest_ref} preview missing {viewport} PNG ref")
                                if isinstance(png_ref, str):
                                    png_path = safe_ref(root, png_ref)
                                    report.check(png_path.is_file(), f"infographic {manifest_ref} preview missing {viewport} PNG")
                                    if png_path.is_file():
                                        data = png_path.read_bytes()
                                        report.check(data.startswith(b"\x89PNG\r\n\x1a\n"), f"infographic {manifest_ref} {viewport} preview is not PNG")
                                        expected = (preview.get("hashes") or {}).get(hash_key)
                                        report.check(isinstance(expected, str) and sha256_file(png_path) == expected, f"infographic {manifest_ref} {viewport} preview hash mismatch")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} vision preview verification failed: {exc}")

    # v1.3 visual-editor revision audits are independently replayed so the
    # image-aware model cannot use a layout patch as a side door into evidence.
    revision_dir = root / "infographics" / "revisions"
    if revision_dir.is_dir():
        for revision_path in sorted(revision_dir.glob("*.json")):
            rel = revision_path.relative_to(root).as_posix()
            try:
                revision = load_json(revision_path)
                report.check(revision.get("schema_version") == "0.1.0", f"revision {rel} schema_version mismatch")
                source_ref = revision.get("source_plan_ref")
                revised_ref = revision.get("revised_plan_ref")
                vision_ref = revision.get("vision_critic_ref")
                for label, ref, prefix in [
                    ("source plan", source_ref, "infographics/plans/"),
                    ("revised plan", revised_ref, "infographics/plans/"),
                    ("vision critic", vision_ref, "infographics/vision-critics/"),
                ]:
                    report.check(isinstance(ref, str) and ref.startswith(prefix), f"revision {rel} invalid {label} ref")
                    if isinstance(ref, str):
                        report.check(safe_ref(root, ref).is_file(), f"revision {rel} missing {label}: {ref}")
                if not all(isinstance(ref, str) for ref in (source_ref, revised_ref, vision_ref)):
                    continue
                source = load_json(safe_ref(root, source_ref))
                revised = load_json(safe_ref(root, revised_ref))
                vision = load_json(safe_ref(root, vision_ref))
                patches = revision.get("applied_patches")
                report.check(isinstance(patches, list) and 1 <= len(patches) <= 8, f"revision {rel} must contain 1..8 applied_patches")
                if not isinstance(patches, list):
                    continue
                report.check(vision.get("schema_version") == "0.2.0", f"revision {rel} must be founded on vision critic schema 0.2.0")
                report.check(vision.get("patches") == patches, f"revision {rel} applied_patches differ from vision critic")
                vision_manifest_ref = vision.get("manifest_ref")
                if isinstance(vision_manifest_ref, str):
                    top_level_path = safe_ref(root, vision_manifest_ref)
                    source_manifest = None
                    if top_level_path.is_file():
                        source_manifest = load_json(top_level_path)
                    else:
                        # rejectCriticizedManifest (the revision-rejection change) moves a
                        # manifest whose vision critic returned passed:false
                        # from its top-level path to
                        # infographics/rejected/<key>/manifest.json, so the
                        # vision critic's manifest_ref no longer resolves
                        # there once the page it judged is rejected. The
                        # revision must stay bound to the exact manifest the
                        # vision critic saw, so this resolves only to the
                        # rejected copy, and only once that directory's own
                        # rejection.json confirms it is the same manifest
                        # rejected by this exact vision critic - never to
                        # whatever else happens to sit at that conventional
                        # path.
                        key = Path(vision_manifest_ref).stem
                        rejected_manifest_ref = f"infographics/rejected/{key}/manifest.json"
                        rejected_manifest_path = safe_ref(root, rejected_manifest_ref)
                        rejection_path = safe_ref(root, f"infographics/rejected/{key}/rejection.json")
                        found = rejected_manifest_path.is_file() and rejection_path.is_file()
                        report.check(found, f"revision {rel} vision critic manifest_ref is missing at both the top level and {rejected_manifest_ref}")
                        if found:
                            rejection = load_json(rejection_path)
                            bound = rejection.get("manifest_ref") == vision_manifest_ref and rejection.get("critic_ref") == vision_ref
                            report.check(bound, f"revision {rel} rejected manifest at {rejected_manifest_ref} is not bound to this exact vision critic")
                            if bound:
                                source_manifest = load_json(rejected_manifest_path)
                    if source_manifest is not None:
                        report.check(source_manifest.get("plan_ref") == source_ref, f"revision {rel} vision critic does not belong to source plan")
                replayed = replay_infographic_patches(source, patches)
                revised_without_hash = dict(revised)
                revised_without_hash.pop("content_hash", None)
                report.check(canonical_json(replayed) == canonical_json(revised_without_hash), f"revision {rel} revised plan does not equal independently replayed bounded patches")
                source_immutable = infographic_immutable_hash(source)
                revised_immutable = infographic_immutable_hash(revised)
                report.check(source_immutable == revised_immutable, f"revision {rel} changed immutable editorial evidence")
                safety = revision.get("safety") or {}
                report.check(safety.get("evidence_fields_preserved") is True, f"revision {rel} missing evidence-preserved attestation")
                report.check(safety.get("immutable_projection_sha256") == source_immutable, f"revision {rel} immutable projection hash mismatch")
                report.check(set(safety.get("allowed_patch_fields") or []) == VISION_PATCH_FIELDS, f"revision {rel} allowed patch field contract mismatch")
            except Exception as exc:
                report.check(False, f"visual revision verification failed {rel}: {exc}")

    # NEWSROOM_SPEED_PLAN_EDIT records live in their own folder and are replayed
    # against the layout fields newsroom_infographic_edit may change; the vision
    # revision audit above keeps reading only infographics/revisions/.
    plan_edit_dir = root / "infographics" / "plan-edits"
    if plan_edit_dir.is_dir():
        for edit_path in sorted(plan_edit_dir.glob("*.json")):
            rel = edit_path.relative_to(root).as_posix()
            try:
                record = load_json(edit_path)
                report.check(record.get("schema_version") == "0.2.0", f"plan edit {rel} schema_version mismatch")
                report.check(record.get("kind") == "plan_edit", f"plan edit {rel} kind mismatch")
                source_ref = record.get("source_plan_ref")
                revised_ref = record.get("revised_plan_ref")
                for label, ref in [("source plan", source_ref), ("revised plan", revised_ref)]:
                    report.check(isinstance(ref, str) and ref.startswith("infographics/plans/"), f"plan edit {rel} invalid {label} ref")
                    if isinstance(ref, str):
                        report.check(safe_ref(root, ref).is_file(), f"plan edit {rel} missing {label}: {ref}")
                if not all(isinstance(ref, str) and safe_ref(root, ref).is_file() for ref in (source_ref, revised_ref)):
                    continue
                source = load_json(safe_ref(root, source_ref))
                revised = load_json(safe_ref(root, revised_ref))
                report.check(revised.get("content_hash") == infographic_plan_content_hash(revised), f"plan edit {rel} revised plan content_hash mismatch")
                report.check({str(m.get("id")) for m in source.get("modules") or []} == {str(m.get("id")) for m in revised.get("modules") or []}, f"plan edit {rel} changed the module id set")
                replayed = replay_plan_edits(source, record.get("applied_edits"))
                revised_without_hash = {k: v for k, v in revised.items() if k != "content_hash"}
                report.check(canonical_json(replayed) == canonical_json(revised_without_hash), f"plan edit {rel} revised plan does not equal the source plan with only the recorded layout edits applied")
                source_immutable = plan_edit_immutable_hash(source)
                report.check(source_immutable == plan_edit_immutable_hash(revised), f"plan edit {rel} changed immutable editorial evidence")
                safety = record.get("safety") or {}
                report.check(safety.get("evidence_fields_preserved") is True, f"plan edit {rel} missing evidence-preserved attestation")
                report.check(safety.get("immutable_projection_sha256") == source_immutable, f"plan edit {rel} immutable projection hash mismatch")
                report.check(set(safety.get("editable_module_fields") or []) == PLAN_EDIT_MODULE_FIELDS and set(safety.get("editable_scene_fields") or []) == set(PLAN_EDIT_SCENE_FIELDS), f"plan edit {rel} editable field contract mismatch")
            except Exception as exc:
                report.check(False, f"plan edit verification failed {rel}: {exc}")

    # Competition preflight is engineering evidence, not a jury prediction.
    # Recompute its machine-verifiable predicates from the linked final assets.
    preflight_dir = root / "infographics" / "competition-preflight"
    if preflight_dir.is_dir():
        for preflight_path in sorted(preflight_dir.glob("*.json")):
            rel = preflight_path.relative_to(root).as_posix()
            try:
                preflight = load_json(preflight_path)
                report.check(preflight.get("schema_version") == "0.1.0", f"competition preflight {rel} schema_version mismatch")
                profile = preflight.get("profile")
                report.check(profile in INFOGRAPHIC_COMPETITION_PROFILES, f"competition preflight {rel} has unknown profile")
                report.check(preflight.get("threshold_basis") == "internal_operational_proxy_not_official_jury_cutoff", f"competition preflight {rel} must disclose non-official threshold basis")
                report.check(isinstance(preflight.get("manual_requirements"), list), f"competition preflight {rel} manual_requirements must remain explicit")
                refs = {
                    "plan": (preflight.get("plan_ref"), "infographics/plans/"),
                    "manifest": (preflight.get("manifest_ref"), "infographics/"),
                    "deterministic": (preflight.get("deterministic_critic_ref"), "infographics/critics/"),
                    "vision": (preflight.get("vision_critic_ref"), "infographics/vision-critics/"),
                }
                for label, (ref, prefix) in refs.items():
                    report.check(isinstance(ref, str) and ref.startswith(prefix), f"competition preflight {rel} invalid {label} ref")
                    if isinstance(ref, str):
                        report.check(safe_ref(root, ref).is_file(), f"competition preflight {rel} missing {label}: {ref}")
                if not all(isinstance(ref, str) for ref, _ in refs.values()) or profile not in INFOGRAPHIC_COMPETITION_PROFILES:
                    continue
                plan = load_json(safe_ref(root, refs["plan"][0]))
                manifest = load_json(safe_ref(root, refs["manifest"][0]))
                deterministic = load_json(safe_ref(root, refs["deterministic"][0]))
                vision = load_json(safe_ref(root, refs["vision"][0]))
                report.check((plan.get("competition_profile") or "editorial") == profile, f"competition preflight {rel} profile differs from final plan")
                report.check(manifest.get("plan_ref") == refs["plan"][0], f"competition preflight {rel} manifest/plan link mismatch")
                report.check(deterministic.get("manifest_ref") == refs["manifest"][0], f"competition preflight {rel} deterministic critic link mismatch")
                report.check(vision.get("manifest_ref") == refs["manifest"][0] and vision.get("deterministic_critic_ref") == refs["deterministic"][0], f"competition preflight {rel} vision critic link mismatch")
                origins = []
                for illustration_ref in manifest.get("illustration_manifest_refs") or []:
                    illustration = load_json(safe_ref(root, illustration_ref))
                    if illustration.get("kind") == "rich_illustration":
                        origins.append(str((illustration.get("provenance") or {}).get("origin") or "unknown"))
                if strict_readers():
                    non_finite = competition_non_finite_values(profile, deterministic, vision)
                    report.check(not non_finite, f"competition preflight {rel} critic values are not finite numbers: {non_finite}")
                expected_pass, failures = recompute_competition_machine_pass(profile, deterministic, vision, origins)
                report.check(preflight.get("machine_passed") is expected_pass, f"competition preflight {rel} machine_passed disagrees with independent recomputation: {failures}")
                report.check(isinstance(preflight.get("blockers"), list), f"competition preflight {rel} blockers must be a list")
                report.check(isinstance(preflight.get("source_urls"), list), f"competition preflight {rel} source_urls must be a list")
            except Exception as exc:
                report.check(False, f"competition preflight verification failed {rel}: {exc}")

    # Browser publications: PublicationSpec plans -> rendered HTML -> browser
    # QA. Mirrors the Rust verifier's verify_publications with identical
    # semantics. plans/ and qa/ are the plan and browser-qa.json
    # subdirectories newsroom_publication_plan/newsroom_portable_publication
    # and newsroom_publication_qa write into - never publication instances
    # themselves.
    publications_dir = root / "publications"
    if publications_dir.is_dir():
        for entry_path in sorted(publications_dir.iterdir()):
            if not entry_path.is_dir() or entry_path.name in {"plans", "qa", "rejected"}:
                # publications/rejected/<k>/ is where a publication whose
                # browser QA FAILed is moved whole (index.html,
                # manifest.json, assets/, a copy of the QA report,
                # rejection.json) - never a top-level publication instance
                # itself, exactly like plans/ and qa/ above.
                continue
            dir_name = entry_path.name
            manifest_path = entry_path / "manifest.json"
            report.check(manifest_path.is_file(), f"publication {dir_name} is missing manifest.json")
            if not manifest_path.is_file():
                continue
            if strict_readers():
                try:
                    manifest = load_json(manifest_path)
                except Exception as exc:
                    report.check(False, f"publication {dir_name} manifest.json is unreadable: {exc}")
                    continue
            else:
                manifest = load_json(manifest_path)
            manifest_ref = f"publications/{dir_name}/manifest.json"

            if manifest.get("kind") == "lieflat_publication":
                # runtime/pi/lieflat.mjs's report mode writes
                # publications/<key>/qa.json and
                # infographics/<key>/{plan,lint,critic}.json with passed:true
                # and a fixed score:100 - none of it measured. The generic
                # checks below already fail this manifest (its
                # infographic_plan_ref is not a real plan_ref under
                # publications/plans/, and it has no linked
                # publications/qa/*/browser-qa.json), but call it out by name
                # so the report is unambiguous about why.
                report.check(False, f"publication {manifest_ref} is a Lieflat publication (kind=lieflat_publication) whose lint/critic/publication QA are self-issued passed:true/score:100 constants, not measured results")

            html_ref = manifest.get("html_ref")
            actual_html_sha256 = None
            if not isinstance(html_ref, str) or not html_ref:
                report.check(False, f"publication {manifest_ref} missing html_ref")
            else:
                try:
                    html_path = safe_ref(root, html_ref)
                    report.check(html_path.is_file(), f"publication {manifest_ref} missing html: {html_ref}")
                    if html_path.is_file():
                        actual_html_sha256 = sha256_file(html_path)
                        report.check(manifest.get("html_sha256") == actual_html_sha256, f"publication {manifest_ref} html_sha256 mismatch")
                        report.check(dir_name == actual_html_sha256, f"publication {manifest_ref} directory is not content-addressed by its own index.html")
                except Exception as exc:
                    report.check(False, f"publication {manifest_ref} has an unsafe html_ref: {exc}")

            plan_ref = manifest.get("plan_ref")
            plan = None
            if not isinstance(plan_ref, str) or not plan_ref.startswith("publications/plans/"):
                report.check(False, f"publication {manifest_ref} plan_ref must be under publications/plans/")
            else:
                try:
                    plan_path = safe_ref(root, plan_ref)
                    report.check(plan_path.is_file(), f"publication {manifest_ref} missing plan: {plan_ref}")
                    if plan_path.is_file():
                        try:
                            plan = load_json(plan_path)
                        except Exception as exc:
                            report.check(False, f"publication {manifest_ref} plan is not valid JSON: {exc}")
                except Exception as exc:
                    report.check(False, f"publication {manifest_ref} has an unsafe plan_ref: {exc}")

            if plan is not None:
                breakpoints = (plan.get("delivery") or {}).get("breakpoints")
                if isinstance(breakpoints, list) and len(breakpoints) == 1:
                    breakpoints_ok = breakpoints[0] == 1440
                elif isinstance(breakpoints, list):
                    breakpoints_ok = len(breakpoints) >= 2
                else:
                    breakpoints_ok = False
                report.check(breakpoints_ok, f"publication {manifest_ref} plan delivery.breakpoints must be exactly [1440] or at least two widths")

                # newsroom_portable_publication writes the literal sentinel
                # "portable/direct" here instead of a real infographic plan
                # ref, since the portable path never goes through
                # newsroom_infographic_plan - only require this to resolve
                # to an actual file outside that documented exemption.
                infographic_plan_ref = plan.get("infographic_plan_ref")
                if infographic_plan_ref != "portable/direct":
                    ok = isinstance(infographic_plan_ref, str) and infographic_plan_ref.startswith("infographics/plans/")
                    try:
                        ok = ok and safe_ref(root, infographic_plan_ref).is_file()
                    except Exception:
                        ok = False
                    report.check(ok, f"publication {manifest_ref} missing upstream infographic plan: {infographic_plan_ref}")
                    if ok:
                        verify_publication_infographic_lineage(root, manifest_ref, infographic_plan_ref, infographic_critics, infographic_vision_critics, report)

                modules = plan.get("modules")
                for module in (modules if isinstance(modules, list) else []):
                    binding = (module or {}).get("evidence_binding") if isinstance(module, dict) else None
                    if not binding:
                        continue
                    kind = binding.get("kind")
                    module_ref = binding.get("ref")
                    prefix = {
                        "computation": "computations/",
                        "analysis": "visualizations/graph-analysis/",
                        "map": "maps/",
                        "model": "models/",
                        "asset": "visualizations/",
                        "page": "infographics/",  # NEWSROOM_PUBLICATION_EMBED_PAGE: the composed page of the bound infographic
                    }.get(kind)
                    ok = bool(prefix) and isinstance(module_ref, str) and module_ref.startswith(prefix)
                    try:
                        ok = ok and safe_ref(root, module_ref).is_file()
                    except Exception:
                        ok = False
                    report.check(ok, f"publication {manifest_ref} module evidence_binding is missing or invalid: {module_ref}")
                    if kind == "page" and ok:
                        report.check(page_binding_matches_manifest(root, binding, module_ref, infographic_plan_ref), f"publication {manifest_ref} page evidence_binding does not match its infographic render manifest: {module_ref}")

            # A portable_fallback publication is still evidence-bound, but its
            # own tool result says plainly "this does not replace browser QA"
            # - it needs a linked passing browser-qa.json exactly like any
            # other publication, not an exemption.
            if actual_html_sha256 is None:
                continue
            # Every linked report must independently verify - not just the
            # first one iteration happens to reach. iterdir()'s order is
            # filesystem-dependent, so a stale FAIL and a later PASS for the
            # same html would otherwise give an order-dependent verdict;
            # walking in sorted order and requiring all of them to pass
            # makes the result deterministic. The runtime now moves a
            # FAILed publication's whole directory out of the top level
            # (publications/rejected/<k>/, skipped above), so a genuine
            # top-level publication should never have a linked FAIL report
            # in the first place - if one is still linked here, that is
            # itself a fail-closed signal, not something to average away.
            qa_dir = publications_dir / "qa"
            linked = False
            passing = True
            if qa_dir.is_dir():
                for qa_key_dir in sorted(qa_dir.iterdir()):
                    report_path = qa_key_dir / "browser-qa.json"
                    if not report_path.is_file():
                        continue
                    try:
                        qa_report = load_json(report_path)
                    except Exception as exc:
                        # An unreadable report is a failure, not a skip: skipping let a FAIL report that only fails
                        # to parse disappear while a PASS report for the same HTML vouched for the publication.
                        if strict_readers():
                            report.check(False, f"publication {manifest_ref} browser QA report publications/qa/{qa_key_dir.name}/browser-qa.json is unreadable: {exc}")
                        continue
                    if qa_report.get("html_sha256") == actual_html_sha256:
                        linked = True
                        status_ok = qa_report.get("status") == "PASS"
                        screenshots_ok = verify_qa_screenshots(qa_key_dir, qa_report, manifest_ref, report)
                        if not (status_ok and screenshots_ok):
                            passing = False
            report.check(linked, f"publication {manifest_ref} has no linked browser QA report")
            report.check(linked and passing, f"publication {manifest_ref} has no passing browser QA report")

    # story.json delivery.primary_artifact, when set, must be the output of
    # a top-level manifest rather than an orphan file or one moved out of
    # the top level (publications/rejected/<k>/, publications/qa/*/, or a
    # bare SVG/PNG nobody's manifest references). Mirrors the Rust
    # verifier's verify_delivered_artifact exactly. A missing or null
    # primary_artifact is not checked at all. Two backing forms are
    # accepted: publications/<k>/index.html (k not one of the reserved
    # directory names) with a sibling publications/<k>/manifest.json whose
    # own html_ref field equals it exactly - the publications loop above
    # independently re-verifies that whole manifest's hash chain and QA,
    # this only confirms the declared path is not dangling; or an SVG
    # referenced by the variants or svg field of a top-level
    # infographics/*.json or visualizations/*.json manifest (the loops
    # earlier in this function independently re-verify that manifest
    # itself).
    delivery = story.get("delivery")
    delivery = delivery if isinstance(delivery, dict) else {}
    if "primary_artifact" in delivery and delivery.get("primary_artifact") is not None:
        primary = delivery.get("primary_artifact")
        primary_str = primary if isinstance(primary, str) else ""
        parts = primary_str.split("/")
        bound = False
        if len(parts) == 3 and parts[0] == "publications" and parts[2] == "index.html" and parts[1] not in {"plans", "qa", "rejected"}:
            manifest_path = root / "publications" / parts[1] / "manifest.json"
            if manifest_path.is_file():
                try:
                    manifest = load_json(manifest_path)
                    bound = manifest.get("html_ref") == primary_str
                except Exception:
                    bound = False
        else:
            for sub in ("infographics", "visualizations"):
                d = root / sub
                if not d.is_dir():
                    continue
                for manifest_path in sorted(d.glob("*.json")):
                    try:
                        manifest = load_json(manifest_path)
                    except Exception:
                        continue
                    svg_match = manifest.get("svg") == primary_str
                    variants = manifest.get("variants")
                    variant_match = isinstance(variants, dict) and primary_str in variants.values()
                    if svg_match or variant_match:
                        bound = True
                        break
                if bound:
                    break
        report.check(bound, f"delivered artifact {primary_str} is not backed by a verified manifest")

    record_only_verify(root, story)
    return report



def _validate_read_only_sql(sql: str) -> str:
    cleaned = sql.strip().rstrip(";").strip()
    if not cleaned or ";" in cleaned:
        raise ValueError("recompute only accepts one read-only SQL statement")
    if not re.match(r"^(select|with|describe|summarize|from|explain)\b", cleaned, re.I):
        raise ValueError("recompute only accepts read-only analytical SQL")
    if re.search(r"\b(install|load|copy|export|import|attach|detach|create|drop|delete|update|insert|alter|call|pragma|set)\b", cleaned, re.I):
        raise ValueError("recompute blocked a mutating or extension-loading SQL statement")
    return cleaned

def recompute(root: Path, duckdb_bin: str = "duckdb", timeout_seconds: float = 30.0) -> Report:
    report = Report()
    computations = sorted((root / "computations").glob("*.json")) if (root / "computations").is_dir() else []
    for path in computations:
        rel = path.relative_to(root).as_posix()
        try:
            comp = load_json(path)
            sql = _validate_read_only_sql(str(comp.get("sql") or ""))
            stored_rows = comp.get("rows")
            report.check(isinstance(stored_rows, list), f"recompute stored rows missing: {rel}")
            if not isinstance(stored_rows, list):
                continue
            data_dir = str((root / "data").resolve()).replace("'", "''")
            source_dir = str((root / "sources").resolve()).replace("'", "''")
            computation_dir = str((root / "computations").resolve()).replace("'", "''")
            command = [
                duckdb_bin, "-json", ":memory:",
                "-cmd", f"SET allowed_directories = ['{data_dir}', '{source_dir}', '{computation_dir}']",
                "-cmd", "SET enable_external_access = false",
                "-cmd", "SET allow_community_extensions = false",
                "-cmd", "SET memory_limit = '512MB'",
                "-cmd", "SET threads = 2",
                "-cmd", "SET lock_configuration = true",
                "-c", sql,
            ]
            started = time.perf_counter()
            cp = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=timeout_seconds)
            elapsed_ms = (time.perf_counter() - started) * 1000
            report.check(cp.returncode == 0, f"recompute DuckDB failed for {rel}: {cp.stderr.strip()[:500]}")
            if cp.returncode != 0:
                continue
            text = cp.stdout.strip()
            actual_rows = [] if not text else (strict_loads(text) if strict_readers() else json.loads(text))
            if not isinstance(actual_rows, list):
                actual_rows = [actual_rows]
            report.check(canonical_rows_json(actual_rows) == canonical_rows_json(stored_rows), f"recompute rows mismatch: {rel}")
            actual_hash = hashlib.sha256(canonical_rows_json(actual_rows).encode()).hexdigest()
            report.check(actual_hash == comp.get("result_hash"), f"recompute result_hash mismatch: {rel}")
            if elapsed_ms > timeout_seconds * 1000:
                report.check(False, f"recompute exceeded timeout budget: {rel}")
        except subprocess.TimeoutExpired:
            report.check(False, f"recompute timed out after {timeout_seconds:.1f}s: {rel}")
        except Exception as exc:
            report.check(False, f"recompute failed for {rel}: {exc}")
    return report

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--write", action="store_true", help="write verification.json into the artifact")
    parser.add_argument("--recompute", action="store_true", help="re-run every stored SQL statement with DuckDB")
    parser.add_argument("--duckdb-bin", default=os.environ.get("NEWSROOM_DUCKDB_BIN", "duckdb"))
    parser.add_argument("--recompute-timeout", type=float, default=30.0)
    args = parser.parse_args()
    report = verify(args.artifact)
    replay = None
    if args.recompute and report.passed:
        replay = recompute(args.artifact, args.duckdb_bin, args.recompute_timeout)
        report.check(replay.passed, "computation replay failed")
        report.checks += replay.checks
        report.errors.extend(replay.errors)
        report.warnings.extend(replay.warnings)
    if args.write:
        from datetime import datetime, timezone
        payload = {"schema_version": "0.7.0", "verified_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "passed": report.passed, "checks": report.checks, "errors": report.errors, "warnings": report.warnings, "recomputed": bool(args.recompute)}
        (args.artifact / "verification.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps({"passed": report.passed, "checks": report.checks, "errors": report.errors, "warnings": report.warnings}, indent=2))
    else:
        print(f"artifact integrity: {'PASS' if report.passed else 'FAIL'}")
        print(f"checks: {report.checks}")
        for warning in report.warnings:
            print(f"WARN  {warning}")
        for error in report.errors:
            print(f"FAIL  {error}")
    return 0 if report.passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
