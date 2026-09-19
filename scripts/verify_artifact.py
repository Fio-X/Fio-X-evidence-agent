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


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


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
    threshold = float(item.get("candidate_threshold") or 0.7)
    candidate = sum(1 for r in reviews if isinstance(r, dict) and r.get("qualified") is True and r.get("preference") == "candidate")
    baseline = sum(1 for r in reviews if isinstance(r, dict) and r.get("qualified") is True and r.get("preference") == "baseline")
    decisive = candidate + baseline
    share = candidate / decisive if decisive else 0.0
    status = "PENDING" if len(reviews) < minimum else ("PASS" if share >= threshold else "FAIL")
    return status, round(share, 4)

INFOGRAPHIC_COMPETITION_PROFILES = {
    "editorial", "snd47_infographics", "oja2026_visual", "sigma2026", "iib_awards"
}
VISION_PATCH_FIELDS = {"span", "emphasis", "priority", "move_before", "mobile_move_before"}
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


def recompute_competition_machine_pass(profile: str, deterministic: dict, vision: dict, origins: list[str]) -> tuple[bool, list[str]]:
    policy = COMPETITION_POLICY_FLOORS.get(profile)
    if not policy:
        return False, ["unknown_profile"]
    failures = []
    if deterministic.get("passed") is not True:
        failures.append("deterministic_critic_not_passing")
    if vision.get("passed") is not True:
        failures.append("vision_critic_not_passing")
    try:
        if float(deterministic.get("score")) < policy["deterministic_score"]:
            failures.append("deterministic_score_below_profile")
    except (TypeError, ValueError):
        failures.append("deterministic_score_below_profile")
    try:
        if float(vision.get("score")) < policy["vision_score"]:
            failures.append("vision_score_below_profile")
    except (TypeError, ValueError):
        failures.append("vision_score_below_profile")
    for key, floor in policy["deterministic"].items():
        try:
            if float((deterministic.get("rubric") or {}).get(key)) < floor:
                failures.append(f"deterministic_rubric_floor:{key}")
        except (TypeError, ValueError):
            failures.append(f"deterministic_rubric_floor:{key}")
    for key, floor in policy["vision"].items():
        try:
            if float((vision.get("rubric") or {}).get(key)) < floor:
                failures.append(f"vision_rubric_floor:{key}")
        except (TypeError, ValueError):
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


def replay_award_mode_status(item: dict) -> tuple[str, list[str]]:
    refs = item.get("refs") or {}
    metrics = item.get("metrics") or {}
    required_refs = ["discovery_ref", "concepts_ref", "asset_plan_ref", "novelty_ref", "page_ref"]
    missing_refs = [key for key in required_refs if not str(refs.get(key) or "").strip()]
    concepts_generated = int(metrics.get("concepts_generated") or 0)
    concepts_killed = int(metrics.get("concepts_killed") or 0)
    concept_ok = 8 <= concepts_generated <= 20 and concepts_killed >= ((concepts_generated + 1) // 2)
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
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            rows.append({"__parse_error__": f"line {no}: {exc}"})
    return rows


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
                    report.check(isinstance(duration, int) and duration >= 0, f"run metric line {index} has invalid duration_ms")
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

    claims = jsonl(root / "claims.jsonl")
    verified_ids = set()
    for claim in claims:
        if "__parse_error__" in claim:
            report.check(False, f"claims.jsonl parse error: {claim['__parse_error__']}")
            continue
        if claim.get("status") != "verified":
            continue
        claim_id = claim.get("claim_id")
        if claim_id:
            verified_ids.add(str(claim_id))
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
        for path in critic_dir.glob("*.json"):
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
            if not isinstance(manifest.get("variants"), dict) or not manifest.get("plan_ref"):
                continue
            manifest_ref = manifest_path.relative_to(root).as_posix()
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
            for viewport in ("desktop", "mobile"):
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
                    except Exception as exc:
                        report.check(False, f"visualization {manifest_ref} unsafe {viewport} SVG ref: {exc}")
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
                report.check(8 <= len(concepts) <= 20, f"visual concepts {rel} must contain 8..20 candidates")
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
        for path in info_critic_dir.glob("*.json"):
            try:
                infographic_critics.append(load_json(path))
            except Exception as exc:
                report.check(False, f"infographic critic unreadable {path}: {exc}")

    infographic_vision_critics = []
    info_vision_critic_dir = root / "infographics" / "vision-critics"
    if info_vision_critic_dir.is_dir():
        for path in info_vision_critic_dir.glob("*.json"):
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
            if infographic_version not in {"1.0.0", "1.1.0", "1.2.0", "1.3.0"} or not isinstance(manifest.get("variants"), dict):
                continue
            manifest_ref = manifest_path.relative_to(root).as_posix()
            plan_ref, lint_ref = manifest.get("plan_ref"), manifest.get("lint_ref")
            for label, ref, prefix in [("plan", plan_ref, "infographics/plans/"), ("lint", lint_ref, "infographics/lints/")]:
                report.check(isinstance(ref, str) and ref.startswith(prefix), f"infographic {manifest_ref} invalid {label}_ref")
                if isinstance(ref, str):
                    try:
                        report.check(safe_ref(root, ref).is_file(), f"infographic {manifest_ref} missing {label}: {ref}")
                    except Exception as exc:
                        report.check(False, f"infographic {manifest_ref} unsafe {label} ref: {exc}")
            if isinstance(plan_ref, str):
                try:
                    plan_path = safe_ref(root, plan_ref)
                    if plan_path.is_file():
                        plan = load_json(plan_path)
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
                        for viewport, hash_key in [("desktop", "desktop_sha256"), ("mobile", "mobile_sha256")]:
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
            for viewport, hash_key in [("desktop", "desktop_sha256"), ("mobile", "mobile_sha256")]:
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
                            report.check("SOURCES &amp; METHODS" in text, f"infographic {manifest_ref} {viewport} source strip missing")
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
            if infographic_version in {"1.1.0", "1.2.0"} and passing:
                rubric = passing[0].get("rubric") or {}
                expected_rubric = {"impact_story_focus", "engagement", "clarity_information_flow", "effectiveness", "hierarchy", "editorial_rhythm", "inclusion_accessibility", "responsive_execution", "craft_geometry", "originality_variety"}
                report.check(expected_rubric.issubset(rubric.keys()), f"infographic {manifest_ref} 1.1 critic missing award-informed rubric dimensions")
            if manifest.get("visual_review_required") is True:
                linked_vision = [c for c in infographic_vision_critics if c.get("manifest_ref") == manifest_ref]
                report.check(bool(linked_vision), f"infographic {manifest_ref} requires image-aware vision critic")
                passing_vision = [c for c in linked_vision if c.get("passed") is True]
                report.check(bool(passing_vision), f"infographic {manifest_ref} has no passing image-aware vision critic")
                for vision in passing_vision[:1]:
                    report.check(vision.get("schema_version") in {"0.1.0", "0.2.0"} and vision.get("kind") == "image_aware_model", f"infographic {manifest_ref} vision critic schema/kind mismatch")
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
                            for viewport, hash_key in [("desktop", "desktop_sha256"), ("mobile", "mobile_sha256")]:
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
                    source_manifest = load_json(safe_ref(root, vision_manifest_ref))
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
                expected_pass, failures = recompute_competition_machine_pass(profile, deterministic, vision, origins)
                report.check(preflight.get("machine_passed") is expected_pass, f"competition preflight {rel} machine_passed disagrees with independent recomputation: {failures}")
                report.check(isinstance(preflight.get("blockers"), list), f"competition preflight {rel} blockers must be a list")
                report.check(isinstance(preflight.get("source_urls"), list), f"competition preflight {rel} source_urls must be a list")
            except Exception as exc:
                report.check(False, f"competition preflight verification failed {rel}: {exc}")

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
            actual_rows = [] if not text else json.loads(text)
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
