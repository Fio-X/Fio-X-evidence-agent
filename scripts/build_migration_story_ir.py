#!/usr/bin/env python3
"""Build deterministic migration story tables and factual IR from locked sources."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

FIXTURE_SHA256 = "b30cc7bc540c78d09ca2203b9e5e467b9e17dff5f1f2768dfb3cac8ec49308a0"
NATURAL_EARTH_SHA256 = "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb"
NATURAL_EARTH_REVISION = "ca96624a56bd078437bca8184e78163e5039ad19"
GENERATOR = "scripts/build_migration_story_ir.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def decimal_text(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.000001')):f}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    parser.add_argument("natural_earth", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if sha256(args.fixture) != FIXTURE_SHA256:
        raise SystemExit("migration fixture SHA-256 mismatch")
    if sha256(args.natural_earth) != NATURAL_EARTH_SHA256:
        raise SystemExit("Natural Earth SHA-256 mismatch")
    args.output.mkdir(parents=True, exist_ok=True)

    with args.fixture.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    natural = json.loads(args.natural_earth.read_text(encoding="utf-8"))
    geography = {}
    for feature in natural["features"]:
        props = feature["properties"]
        for code in (props.get("ISO_A3"), props.get("ADM0_A3")):
            if code and code != "-99":
                geography.setdefault(code, props)
    codes = sorted({row[key] for row in rows for key in ("origin_iso3", "destination_iso3")})
    missing = [code for code in codes if code not in geography]
    if missing:
        raise SystemExit(f"Natural Earth lookup missing ISO3 codes: {missing}")

    country_rows = []
    for code in codes:
        props = geography[code]
        country_rows.append({
            "iso3": code, "name": props.get("ADMIN") or code,
            "continent": props.get("CONTINENT") or "Unknown",
            "region_un": props.get("REGION_UN") or "Unknown",
            "subregion": props.get("SUBREGION") or "Unknown",
            "label_longitude": props["LABEL_X"], "label_latitude": props["LABEL_Y"],
        })
    country_path = args.output / "country-reference.csv"
    write_csv(country_path, country_rows, list(country_rows[0]))

    yearly_rows, region_rows, route_rows = [], [], []
    calculation_inputs = {}
    for year in sorted({int(row["year"]) for row in rows}):
        annual = [row for row in rows if int(row["year"]) == year]
        total = sum((Decimal(row["estimated_flow_mean"]) for row in annual), Decimal(0))
        destinations = defaultdict(Decimal)
        regions = defaultdict(Decimal)
        for row in annual:
            value = Decimal(row["estimated_flow_mean"])
            destinations[row["destination_iso3"]] += value
            origin_geo, destination_geo = geography[row["origin_iso3"]], geography[row["destination_iso3"]]
            regions[(origin_geo["CONTINENT"], destination_geo["CONTINENT"])] += value
            route_rows.append({
                **row,
                "origin_longitude": origin_geo["LABEL_X"], "origin_latitude": origin_geo["LABEL_Y"],
                "destination_longitude": destination_geo["LABEL_X"], "destination_latitude": destination_geo["LABEL_Y"],
                "geometry_semantics": "abstract_origin_destination",
            })
        top_destination, top_destination_value = sorted(destinations.items(), key=lambda item: (-item[1], item[0]))[0]
        yearly_rows.append({
            "year": year, "selection_scope": "top_30_routes_within_year",
            "selected_route_count": len(annual), "selected_estimated_flow_sum": decimal_text(total),
            "highest_ranked_route": f"{annual[0]['origin_iso3']}-{annual[0]['destination_iso3']}",
            "highest_ranked_route_estimate": annual[0]["estimated_flow_mean"],
            "largest_destination_within_selection": top_destination,
            "largest_destination_estimated_flow_sum": decimal_text(top_destination_value),
        })
        calculation_inputs[year] = [f"q-{year}-{int(row['rank_within_year']):02d}" for row in annual]
        for (origin_region, destination_region), value in sorted(regions.items()):
            region_rows.append({"year": year, "origin_continent": origin_region, "destination_continent": destination_region, "selected_estimated_flow_sum": decimal_text(value), "selection_scope": "top_30_routes_within_year"})

    summary_path = args.output / "yearly-top30-summary.csv"
    region_path = args.output / "continent-flows-top30.csv"
    route_path = args.output / "route-coordinates.csv"
    write_csv(summary_path, yearly_rows, list(yearly_rows[0]))
    write_csv(region_path, region_rows, list(region_rows[0]))
    write_csv(route_path, route_rows, list(route_rows[0]))

    fixture_ref = "fixtures/migration/deep-learning-human-migration-top-corridors.csv"
    geo_url = f"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{NATURAL_EARTH_REVISION}/geojson/ne_50m_admin_0_countries.geojson"
    derived = [country_path, summary_path, region_path, route_path]
    ledger = {
        "schema_version": "0.1.0", "ledger_id": "migration-four-decades",
        "sources": [
            {"id": "migration-model-flows", "title": "Deep-learning model estimates of annual bilateral migration flows", "url": "https://doi.org/10.57967/hf/8902", "license": "GPL-3.0", "retrieved_at": "2026-09-19T14:50:57Z", "sha256": FIXTURE_SHA256, "local_ref": fixture_ref, "role": "primary_data"},
            {"id": "natural-earth-countries", "title": "Natural Earth 1:50m Admin 0 countries", "url": geo_url, "license": "Public domain", "retrieved_at": "2026-09-20T00:30:00Z", "sha256": NATURAL_EARTH_SHA256, "local_ref": "external/ne_50m_admin_0_countries.geojson", "role": "geography"},
        ],
        "derived_artifacts": [{"ref": f"fixtures/migration/story-ir/{path.name}", "sha256": sha256(path), "generator": GENERATOR, "source_ids": ["migration-model-flows", "natural-earth-countries"] if path != summary_path else ["migration-model-flows"]} for path in derived],
        "semantic_guards": [
            "Every flow value is a neural-network model estimate, not an observed journey.",
            "The fixture contains the 30 largest estimated corridors in each selected year; sums and shares are selection-bounded and are not global totals.",
            "Migrant stock and stock change are absent and must not be relabelled as migration flow.",
            "Map endpoints use Natural Earth label points and arcs encode abstract origin-destination relationships, not physical routes.",
        ],
    }
    write_json(args.output / "evidence-ledger.json", ledger)

    evidence = [
        {"id": "ev-migration", "source_ref": fixture_ref, "source_sha256": FIXTURE_SHA256, "extraction_method": "structured_import", "extraction_status": "passed", "locator": "all 150 rows", "retrieved_at": "2026-09-19T14:50:57Z"},
        {"id": "ev-geography", "source_ref": geo_url, "source_sha256": NATURAL_EARTH_SHA256, "extraction_method": "structured_import", "extraction_status": "passed", "locator": "ISO_A3/ADM0_A3 and LABEL_X/LABEL_Y", "retrieved_at": "2026-09-20T00:30:00Z"},
    ]
    entities = [{"id": f"country:{row['iso3']}", "kind": "country", "label": row["name"], "evidence_ids": ["ev-migration", "ev-geography"]} for row in country_rows]
    locations = [{"id": f"location:{row['iso3']}", "label": row["name"], "geometry_semantics": "point", "longitude": float(row["label_longitude"]), "latitude": float(row["label_latitude"]), "evidence_ids": ["ev-geography"]} for row in country_rows]
    times = [{"id": f"year:{row['year']}", "kind": "year", "start": f"{row['year']}-01-01", "end": f"{row['year']}-12-31", "label": str(row["year"])} for row in yearly_rows]
    quantities, relations, uncertainties = [], [], []
    for row in rows:
        qid = f"q-{row['year']}-{int(row['rank_within_year']):02d}"
        uid = f"u-{row['year']}-{int(row['rank_within_year']):02d}"
        quantities.append({"id": qid, "phenomenon": "model_estimated_annual_origin_destination_migration_flow", "value": float(row["estimated_flow_mean"]), "unit": "persons_per_year", "origin": "source_extraction", "entity_ids": [f"country:{row['origin_iso3']}", f"country:{row['destination_iso3']}"], "time_ids": [f"year:{row['year']}"], "scale_id": "scale:global-corridor", "evidence_ids": ["ev-migration"], "uncertainty_ids": [uid]})
        relations.append({"id": f"route-{row['year']}-{int(row['rank_within_year']):02d}", "subject_id": f"country:{row['origin_iso3']}", "predicate": "model_estimated_migration_flow_to", "object_id": f"country:{row['destination_iso3']}", "time_ids": [f"year:{row['year']}"], "evidence_ids": ["ev-migration"]})
        uncertainties.append({"id": uid, "kind": "model", "description": f"Model-estimate standard deviation: {row['estimated_flow_std']} persons per year.", "lower": 0, "upper": float(row["estimated_flow_std"])})
    calculations = []
    for row in yearly_rows:
        year = int(row["year"]); cid = f"calc-top30-sum-{year}"
        calculations.append({"id": cid, "operation": f"sum estimated_flow_mean for the ranked top-30 selection in {year}", "input_fact_ids": calculation_inputs[year], "code_ref": GENERATOR, "result_sha256": sha256(summary_path), "replay_status": "passed"})
        quantities.append({"id": f"q-top30-sum-{year}", "phenomenon": "selected_top30_model_estimated_flow_sum", "value": float(row["selected_estimated_flow_sum"]), "unit": "persons_per_year", "origin": "calculation", "time_ids": [f"year:{year}"], "scale_id": "scale:global-selection", "calculation_id": cid, "evidence_ids": ["ev-migration"]})
    fact_graph = {"schema_version": "0.1.0", "fact_graph_id": "migration-four-decades", "entities": entities, "relations": relations, "quantities": quantities, "processes": [{"id": "process:model-estimated-bilateral-migration", "label": "Model-estimated annual bilateral migration", "participant_ids": [entity["id"] for entity in entities], "relation_ids": [relation["id"] for relation in relations], "evidence_ids": ["ev-migration"]}], "locations": locations, "time": times, "scale": [{"id": "scale:global-corridor", "level": "global"}, {"id": "scale:global-selection", "level": "global", "denominator": "30 largest model-estimated routes within each selected year"}], "evidence": evidence, "calculations": calculations, "uncertainty": uncertainties}
    write_json(args.output / "fact-graph.json", fact_graph)

    first, last = yearly_rows[0], yearly_rows[-1]
    pct = (Decimal(last["selected_estimated_flow_sum"]) / Decimal(first["selected_estimated_flow_sum"]) - 1) * 100
    claims = [
        {"id": "claim:selected-scale", "statement": f"Within each year's selected top 30 model-estimated corridors, the summed estimate was {decimal_text(Decimal(first['selected_estimated_flow_sum']))} in 1990 and {decimal_text(Decimal(last['selected_estimated_flow_sum']))} in 2023, a {pct.quantize(Decimal('0.1'))}% increase.", "kind": "comparative", "fact_ids": ["q-top30-sum-1990", "q-top30-sum-2023"], "evidence_ids": ["ev-migration"], "calculation_ids": ["calc-top30-sum-1990", "calc-top30-sum-2023"], "support_status": "supported", "limitations": ["This compares bounded top-30 selections, not total global migration."]},
        {"id": "claim:route-shift", "statement": f"The highest-ranked model-estimated corridor in the bounded fixture changed from {first['highest_ranked_route']} in 1990 to {last['highest_ranked_route']} in 2023.", "kind": "descriptive", "fact_ids": ["q-1990-01", "q-2023-01"], "evidence_ids": ["ev-migration"], "support_status": "supported", "limitations": ["Ranks refer only to the published model estimates."]},
        {"id": "claim:destination-shift", "statement": f"Within the selected routes, the largest destination aggregate changed from {first['largest_destination_within_selection']} in 1990 to {last['largest_destination_within_selection']} in 2023.", "kind": "comparative", "fact_ids": calculation_inputs[1990] + calculation_inputs[2023], "evidence_ids": ["ev-migration"], "calculation_ids": ["calc-top30-sum-1990", "calc-top30-sum-2023"], "support_status": "supported", "limitations": ["Destination aggregates include only routes retained in each year's top-30 selection."]},
        {"id": "claim:model-uncertainty", "statement": "Every corridor value is a model estimate with a supplied standard deviation; none is an observed flow or a migrant-stock change.", "kind": "uncertainty", "fact_ids": ["q-1990-01", "q-2023-01"], "evidence_ids": ["ev-migration"], "support_status": "supported", "limitations": ["The fixture does not contain observed migration flows, migrant stocks, or stock changes."]},
    ]
    claim_graph = {"schema_version": "0.1.0", "claim_graph_id": "migration-four-decades", "fact_graph_ref": "fixtures/migration/story-ir/fact-graph.json", "claims": claims, "edges": [{"from": "claim:model-uncertainty", "to": "claim:selected-scale", "relation": "qualifies"}, {"from": "claim:route-shift", "to": "claim:destination-shift", "relation": "supports"}, {"from": "claim:selected-scale", "to": "claim:destination-shift", "relation": "supports"}]}
    write_json(args.output / "claim-graph.json", claim_graph)

    story_graph = {"schema_version": "0.1.0", "story_id": "migration-four-decades", "reader_question": "How did the geography and scale of model-estimated international migration routes change from 1990 to 2023?", "visual_thesis": "A route-led world view shows that the leading estimated corridor, destination hubs, and bounded top-route scale changed together, while uncertainty remains explicit.", "nodes": [
        {"id": "orient-routes", "kind": "evidence", "summary": "The selected model-estimated corridors form a global origin-destination geography.", "explanatory_dimension": "spatial", "claim_ids": ["claim:route-shift"], "evidence_refs": [fixture_ref], "module_hint": "world flow map"},
        {"id": "zoom-hubs", "kind": "claim", "summary": "Destination concentration within the selected routes changed across the period.", "explanatory_dimension": "distribution", "claim_ids": ["claim:destination-shift"], "evidence_refs": ["fixtures/migration/story-ir/continent-flows-top30.csv"], "module_hint": "continent Sankey"},
        {"id": "measure-scale", "kind": "claim", "summary": "The summed scale of the bounded top-30 selection differs substantially by year.", "explanatory_dimension": "trend", "claim_ids": ["claim:selected-scale"], "evidence_refs": ["fixtures/migration/story-ir/yearly-top30-summary.csv"], "module_hint": "trend and scale translator"},
        {"id": "compare-then-now", "kind": "outcome", "summary": "The leading 1990 and 2023 routes occupy different parts of the network.", "explanatory_dimension": "comparison", "claim_ids": ["claim:route-shift", "claim:destination-shift"], "evidence_refs": [fixture_ref], "module_hint": "then-now comparison"},
        {"id": "qualify-model", "kind": "uncertainty", "summary": "The values are model estimates with standard deviations, not observed movements or stock changes.", "explanatory_dimension": "uncertainty", "claim_ids": ["claim:model-uncertainty"], "evidence_refs": [fixture_ref], "module_hint": "method and uncertainty"}],
        "edges": [{"from": "orient-routes", "to": "zoom-hubs", "relation": "locates"}, {"from": "zoom-hubs", "to": "measure-scale", "relation": "explains"}, {"from": "measure-scale", "to": "compare-then-now", "relation": "precedes"}, {"from": "qualify-model", "to": "compare-then-now", "relation": "qualifies"}], "entry_node_ids": ["orient-routes", "qualify-model"], "answer_node_ids": ["compare-then-now"]}
    write_json(args.output / "story-graph.json", story_graph)

    grammar = {
        "schema_version": "0.1.0", "project_id": "migration-four-decades",
        "primary": "ROUTE_SPINE", "supporting": ["THEN_NOW", "SCALE_TRANSLATOR"],
        "available_renderer_capabilities": ["svg", "canvas2d"],
        "evidence_features": ["origin_destination_relation", "verified_locations", "comparable_timepoints", "quantity", "human_scale_reference"],
        "cognitive_goals": ["ORIENT", "ZOOM", "MEASURE", "COMPARE", "CONSEQUENCE"],
        "candidates": [
            {"grammar": "ROUTE_SPINE", "hard_constraints_passed": True, "renderer_capability_passed": True, "soft_score": 1, "reason_codes": ["evidence_requirements_met", "renderer_available", "cognitive_goal_match"]},
            {"grammar": "THEN_NOW", "hard_constraints_passed": True, "renderer_capability_passed": True, "soft_score": 0.94, "reason_codes": ["evidence_requirements_met", "renderer_available", "cognitive_goal_match"]},
            {"grammar": "SCALE_TRANSLATOR", "hard_constraints_passed": True, "renderer_capability_passed": True, "soft_score": 0.88, "reason_codes": ["evidence_requirements_met", "renderer_available", "cognitive_goal_match"]},
        ],
        "selected": "ROUTE_SPINE",
        "decision_log": [
            {"stage": "hard_constraint", "grammar": "ROUTE_SPINE", "outcome": "pass", "reason_code": "verified_origin_destination_locations"},
            {"stage": "renderer_capability", "grammar": "ROUTE_SPINE", "outcome": "pass", "reason_code": "svg_canvas_available"},
            {"stage": "final_selection", "grammar": "ROUTE_SPINE", "outcome": "select", "reason_code": "highest_eligible_score"},
        ],
    }
    write_json(args.output / "editorial-grammar-selection.json", grammar)

    quantitative = {"quantity_kind": "estimated_flow", "mark_semantics": "flow_width", "scale_type": "linear", "baseline_policy": "not_applicable", "uncertainty_disclosed": True, "disclosure": "Model-estimated annual flow means are shown; the source provides a standard deviation for every corridor."}
    modules = [
        {"id": "world-routes", "type": "visual", "span": "full", "manifest_ref": "visualizations/migration-world-routes.json", "caption": "Abstract arcs connect Natural Earth label points; width encodes model-estimated annual flow.", "story_role": "hook", "priority": 1, "emphasis": "hero", "claim_set": ["claim:route-shift"], "story_node_ids": ["orient-routes"], "visual_grammar": "spatial", "graphic_object_ids": ["route-spine"], "annotations": [{"id": "route-semantics", "target_object_id": "route-spine", "text": "Arcs encode origin-destination relationships, not physical journeys.", "claim_id": "claim:route-shift"}], "visual_channels": [{"channel": "size", "field": "estimated_flow_mean", "role": "quantitative"}, {"channel": "connection", "field": "origin_destination", "role": "identity"}], "quantitative_encoding": quantitative},
        {"id": "continent-flow", "type": "visual", "span": "two_thirds", "manifest_ref": "visualizations/migration-continent-sankey.json", "caption": "Continent aggregates are calculated only from each year's selected top 30 routes.", "story_role": "evidence", "priority": 2, "emphasis": "primary", "claim_set": ["claim:destination-shift"], "story_node_ids": ["zoom-hubs"], "visual_grammar": "flow", "graphic_object_ids": ["continent-links"], "visual_channels": [{"channel": "length", "field": "selected_estimated_flow_sum", "role": "quantitative"}, {"channel": "connection", "field": "origin_destination_continent", "role": "identity"}], "quantitative_encoding": quantitative},
        {"id": "selected-scale", "type": "visual", "span": "half", "manifest_ref": "visualizations/migration-selected-scale.json", "caption": "This trend is the sum of a bounded top-30 selection, not a global migration total.", "story_role": "evidence", "priority": 2, "emphasis": "primary", "claim_set": ["claim:selected-scale"], "story_node_ids": ["measure-scale"], "visual_grammar": "trend", "graphic_object_ids": ["selected-scale-line"], "annotations": [{"id": "bounded-selection", "target_object_id": "selected-scale-line", "text": "Every point sums 30 selected model-estimated routes.", "claim_id": "claim:selected-scale"}], "visual_channels": [{"channel": "position", "field": "selected_estimated_flow_sum", "role": "quantitative"}, {"channel": "color", "field": "year", "role": "categorical"}], "quantitative_encoding": {**quantitative, "mark_semantics": "position"}},
        {"id": "then-now", "type": "visual", "span": "half", "manifest_ref": "visualizations/migration-then-now.json", "caption": "The highest-ranked corridors in 1990 and 2023 connect different origin-destination pairs.", "story_role": "turn", "priority": 2, "emphasis": "primary", "claim_set": ["claim:route-shift", "claim:destination-shift"], "story_node_ids": ["compare-then-now"], "visual_grammar": "change", "graphic_object_ids": ["then-now-routes"], "visual_channels": [{"channel": "position", "field": "estimated_flow_mean", "role": "quantitative"}, {"channel": "color", "field": "year", "role": "categorical"}], "quantitative_encoding": {**quantitative, "mark_semantics": "position"}},
        {"id": "method", "type": "text", "span": "third", "heading": "What these flows mean", "body": "These are neural-network model estimates with supplied standard deviations. They are neither observed journeys nor migrant stocks or stock changes. Route and aggregate comparisons remain bounded to the checked-in top-30 fixture.", "claim_ids": ["claim:model-uncertainty"], "story_role": "method", "priority": 1, "emphasis": "support", "claim_set": ["claim:model-uncertainty"], "story_node_ids": ["qualify-model"]},
        {"id": "orient-context", "type": "text", "span": "third", "heading": "Read the routes first", "body": "Start with the origin-destination spine: the map locates the selected corridors before any aggregate comparison.", "claim_ids": ["claim:route-shift"], "story_role": "context", "priority": 3, "emphasis": "support", "claim_set": ["claim:route-shift"], "story_node_ids": ["orient-routes"]},
        {"id": "zoom-context", "type": "text", "span": "third", "heading": "From routes to regions", "body": "The Sankey groups only the selected corridors by continent so destination structure can be compared without implying a global total.", "claim_ids": ["claim:destination-shift"], "story_role": "explanation", "priority": 3, "emphasis": "support", "claim_set": ["claim:destination-shift"], "story_node_ids": ["zoom-hubs"]},
        {"id": "measure-context", "type": "text", "span": "third", "heading": "A bounded scale", "body": "Each point adds the 30 largest model-estimated routes retained for that year; changes may reflect both estimates and selection membership.", "claim_ids": ["claim:selected-scale"], "story_role": "explanation", "priority": 3, "emphasis": "support", "claim_set": ["claim:selected-scale"], "story_node_ids": ["measure-scale"]},
        {"id": "compare-context", "type": "text", "span": "third", "heading": "Then and now", "body": "The leading pair and the largest destination aggregate within the selection differ between the first and last snapshots.", "claim_ids": ["claim:route-shift", "claim:destination-shift"], "story_role": "turn", "priority": 3, "emphasis": "support", "claim_set": ["claim:route-shift", "claim:destination-shift"], "story_node_ids": ["compare-then-now"]},
        {"id": "consequence", "type": "visual", "span": "two_thirds", "manifest_ref": "visualizations/migration-network-detail.json", "caption": "A bounded network detail reconnects route changes to destination structure; it remains a view of model estimates, not observed journeys.", "story_role": "resolution", "priority": 1, "emphasis": "primary", "claim_set": ["claim:route-shift", "claim:destination-shift", "claim:selected-scale", "claim:model-uncertainty"], "story_node_ids": ["compare-then-now", "qualify-model"], "visual_grammar": "network", "graphic_object_ids": ["network-detail"], "visual_channels": [{"channel": "size", "field": "estimated_flow_mean", "role": "quantitative"}, {"channel": "connection", "field": "origin_destination", "role": "identity"}], "quantitative_encoding": {**quantitative, "mark_semantics": "size", "area_proportional": True}},
    ]
    budget = {"max_supporting_objects": 1, "max_annotations": 2, "max_claims": 3}
    infographic = {
        "schema_version": "1.5.0", "kicker": "Model-estimated migration, 1990–2023", "title": "The leading routes moved", "dek": "A route-led view of how the largest model-estimated international migration corridors, destination hubs, and bounded selected scale changed across five snapshots.", "alt": "A world flow map, continent Sankey, bounded trend, then-now comparison, and method panel explain changes in model-estimated annual international migration flows.", "date_label": "Source snapshots retrieved 19–20 September 2026", "layout": "feature", "complexity_budget": "medium", "source_note": "Gaskin and Abel model-estimated annual bilateral flows; Natural Earth label points. Values are estimates, not observations or stock changes.", "intent": "Explain changing migration-route geography while preserving model uncertainty and selection bounds.", "primary_message": "The leading estimated route, destination structure, and summed scale of the selected top corridors changed together.", "story_arc": "question_answer", "audience": "general", "quality_target": "publishable", "competition_profile": "editorial", "reader_question": story_graph["reader_question"], "visual_thesis": story_graph["visual_thesis"], "story_graph_ref": "fixtures/migration/story-ir/story-graph.json", "editorial_discovery_ref": "editorial/discovery/migration-four-decades.json", "visual_concept_ref": "editorial/concepts/migration-four-decades.json", "selected_concept_id": "route-spine", "novelty_ref": "editorial/novelty/migration-four-decades.json", "asset_plan_ref": "editorial/assets/migration-four-decades.json", "editorial_grammar": grammar,
        "mobile_module_order": ["world-routes", "orient-context", "continent-flow", "zoom-context", "selected-scale", "measure-context", "then-now", "compare-context", "consequence", "method"],
        "scene_graph": {"schema_version": "0.2.0", "scenes": [
            {"id": "orient", "pattern": "hero_with_rail", "anchor_module_id": "world-routes", "sidecar_module_ids": ["orient-context"], "primary_cognitive_goal": "ORIENT", "hero_object_id": "route-spine", "supporting_claim_ids": ["claim:route-shift"], "scene_budget": budget},
            {"id": "zoom", "pattern": "hero_sidecar_stack", "anchor_module_id": "continent-flow", "sidecar_module_ids": ["zoom-context"], "primary_cognitive_goal": "ZOOM", "hero_object_id": "continent-links", "supporting_claim_ids": ["claim:destination-shift"], "scene_budget": budget},
            {"id": "measure", "pattern": "hero_with_rail", "anchor_module_id": "selected-scale", "sidecar_module_ids": ["measure-context"], "primary_cognitive_goal": "MEASURE", "hero_object_id": "selected-scale-line", "supporting_claim_ids": ["claim:selected-scale"], "scene_budget": budget},
            {"id": "compare", "pattern": "hero_sidecar_stack", "anchor_module_id": "then-now", "sidecar_module_ids": ["compare-context"], "primary_cognitive_goal": "COMPARE", "hero_object_id": "then-now-routes", "supporting_claim_ids": ["claim:route-shift", "claim:destination-shift"], "scene_budget": budget},
            {"id": "consequence", "pattern": "hero_with_rail", "anchor_module_id": "consequence", "sidecar_module_ids": ["method"], "primary_cognitive_goal": "CONSEQUENCE", "hero_object_id": "network-detail", "supporting_claim_ids": ["claim:route-shift", "claim:destination-shift", "claim:selected-scale", "claim:model-uncertainty"], "scene_budget": {**budget, "max_claims": 4}},
        ]}, "modules": modules,
    }
    write_json(args.output / "infographic-spec.json", infographic)


if __name__ == "__main__":
    main()
