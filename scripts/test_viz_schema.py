#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "schemas" / "newsroom-viz-spec.schema.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(SCHEMA)
validator = Draft202012Validator(SCHEMA)

valid = {
    "schema_version": "0.7.0",
    "reader_task": "comparison",
    "takeaway": "Observation years differ, so countries should be separated by year.",
    "chart_type": "small_multiples",
    "title": "Countries are split by observation year",
    "subtitle": "Renewable energy share of final energy consumption",
    "alt": "Two panels separate 2021 and 2022 observations to avoid a misleading single ranking.",
    "source_note": "World Bank fixture, EG.FEC.RNEW.ZS",
    "note": "Observation years differ across countries.",
    "claim_id": "claim-fixture-verified",
    "sql": "SELECT country, year, renewable_energy_consumption_pct FROM read_csv_auto('data/world-bank-renewable-latest.csv')",
    "unit": "%",
    "x_field": "country",
    "value_field": "renewable_energy_consumption_pct",
    "facet_field": "year",
    "panel_mark": "dot",
    "reference_period_field": "year",
    "mixed_period_strategy": "facet",
    "sort": "desc",
    "highlight_values": ["Congo, Dem. Rep."],
    "direct_labels": True,
    "annotations": [
        {
            "type": "point",
            "text": "Highest 2021 value in this fixture",
            "claim_id": "claim-fixture-verified",
            "match_field": "country",
            "match_value": "Congo, Dem. Rep.",
        }
    ],
}

errors = sorted(validator.iter_errors(valid), key=lambda e: list(e.path))
if errors:
    raise SystemExit("valid spec failed schema validation: " + " | ".join(error.message for error in errors))

invalid = dict(valid)
invalid["chart_type"] = "scatter"
invalid.pop("y_field", None)
errors = list(validator.iter_errors(invalid))
if not any("y_field" in error.message for error in errors):
    raise SystemExit("invalid scatter spec was not rejected for missing y_field")

bad_annotation = json.loads(json.dumps(valid))
bad_annotation["annotations"][0].pop("claim_id")
errors = list(validator.iter_errors(bad_annotation))
if not any("claim_id" in error.message for error in errors):
    raise SystemExit("annotation without claim_id was not rejected")

draft = json.loads(json.dumps(valid))
draft["verification_mode"] = "draft"
draft.pop("claim_id")
draft["annotations"][0].pop("claim_id")
errors = list(validator.iter_errors(draft))
if errors:
    raise SystemExit("draft spec without claim_id failed schema validation: " + " | ".join(error.message for error in errors))


valid_sankey = {
    "schema_version": "0.8.0",
    "reader_task": "flow",
    "visual_family": "flow",
    "data_topology": "flow_edges",
    "complexity_budget": "medium",
    "takeaway": "Energy flows from sources through a hub to end use.",
    "chart_type": "sankey",
    "title": "Energy flow",
    "subtitle": "Synthetic schema test",
    "alt": "A Sankey diagram shows energy moving from sources to end uses.",
    "source_note": "Synthetic schema fixture",
    "claim_id": "claim-sankey",
    "sql": "SELECT source, target, value FROM flow",
    "unit": "PJ",
    "source_field": "source",
    "target_field": "target",
    "value_field": "value",
    "flow_conservation": "strict",
    "flow_tolerance": 0.01,
    "annotations": [],
    "highlight_values": [],
}
errors = sorted(validator.iter_errors(valid_sankey), key=lambda e: list(e.path))
if errors:
    raise SystemExit("valid sankey spec failed schema validation: " + " | ".join(error.message for error in errors))

invalid_sankey = dict(valid_sankey)
invalid_sankey.pop("target_field")
errors = list(validator.iter_errors(invalid_sankey))
if not any("target_field" in error.message for error in errors):
    raise SystemExit("invalid sankey spec was not rejected for missing target_field")

valid_parallel = {
    **valid_sankey,
    "schema_version": "0.9.0",
    "chart_type": "parallel_sets",
    "data_topology": "categorical_flow",
    "dimension_fields": ["class", "sex", "survived"],
}
valid_parallel.pop("source_field", None)
valid_parallel.pop("target_field", None)
valid_parallel.pop("flow_conservation", None)
valid_parallel.pop("flow_tolerance", None)
errors = list(validator.iter_errors(valid_parallel))
if errors:
    raise SystemExit("valid parallel_sets spec failed schema validation: " + " | ".join(error.message for error in errors))
invalid_parallel = json.loads(json.dumps(valid_parallel))
invalid_parallel["dimension_fields"] = ["class"]
if not list(validator.iter_errors(invalid_parallel)):
    raise SystemExit("parallel_sets with one dimension was not rejected")

valid_geo = {
    **valid_sankey,
    "schema_version": "0.9.0",
    "reader_task": "spatial",
    "visual_family": "spatial",
    "data_topology": "geo_edges",
    "chart_type": "geo_flow_map",
    "source_lat_field": "source_lat",
    "source_lon_field": "source_lon",
    "target_lat_field": "target_lat",
    "target_lon_field": "target_lon",
}
valid_geo.pop("flow_conservation", None)
valid_geo.pop("flow_tolerance", None)
errors = list(validator.iter_errors(valid_geo))
if errors:
    raise SystemExit("valid geo_flow_map spec failed schema validation: " + " | ".join(error.message for error in errors))
invalid_geo = dict(valid_geo)
invalid_geo.pop("target_lon_field")
if not list(validator.iter_errors(invalid_geo)):
    raise SystemExit("geo_flow_map without target_lon_field was not rejected")

valid_carto = {
    **valid_geo,
    "schema_version": "1.0.0",
    "chart_type": "cartographic_flow_map",
    "geometry_semantics": "abstract_od",
    "geometry_crs": "EPSG:4326",
    "projection": "natural_earth_1",
    "basemap_id": "naturalearth_admin0_110m",
    "basemap_source_url": "https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/",
    "basemap_license": "Public domain (Natural Earth terms of use)",
    "basemap_content_hash": "e" * 64,
    "aggregation_policy": "none",
}
errors = list(validator.iter_errors(valid_carto))
if errors:
    raise SystemExit("valid cartographic_flow_map spec failed schema validation: " + " | ".join(error.message for error in errors))
invalid_route = dict(valid_carto)
invalid_route["geometry_semantics"] = "observed_trajectory"
for key in ("source_lat_field", "source_lon_field", "target_lat_field", "target_lon_field"):
    invalid_route.pop(key, None)
errors = list(validator.iter_errors(invalid_route))
if not any("route_geometry_field" in error.message or "route_provenance_note" in error.message for error in errors):
    raise SystemExit("observed_trajectory without route geometry/provenance was not rejected")
valid_route = {**invalid_route, "route_geometry_field": "route_geojson", "route_provenance_note": "OpenSky trajectory samples", "time_field": "observed_at"}
errors = list(validator.iter_errors(valid_route))
if errors:
    raise SystemExit("valid observed_trajectory cartographic spec failed schema validation: " + " | ".join(error.message for error in errors))

valid_trajectory_points = {**invalid_route, "schema_version": "1.1.0", "route_provenance_note": "public ADS-B/readsb sample", "trajectory_points_field": "trajectory_points", "extent_mode": "data", "reference_path": "great_circle", "locator_inset": True}
errors = list(validator.iter_errors(valid_trajectory_points))
if errors:
    raise SystemExit("valid v1.1 observed trajectory-points spec failed schema validation: " + " | ".join(error.message for error in errors))
valid_profile = {
    "schema_version": "1.1.0", "reader_task": "change", "visual_family": "temporal", "data_topology": "tabular",
    "chart_type": "trajectory_profile", "title": "Observed flight state", "takeaway": "The observed path changes in altitude and speed over the same elapsed-time axis.", "alt": "Altitude and speed profile over elapsed observed time.",
    "source_note": "Public ADS-B sample.", "claim_id": "claim-profile", "sql": "fixture", "unit": "trajectory state",
    "x_field": "elapsed_min", "altitude_field": "altitude_ft", "speed_field": "ground_speed_kt", "segment_field": "segment"
}
errors = list(validator.iter_errors(valid_profile))
if errors:
    raise SystemExit("valid v1.1 trajectory_profile spec failed schema validation: " + " | ".join(error.message for error in errors))

valid_process = {
    **valid_sankey,
    "schema_version": "0.9.0",
    "reader_task": "process",
    "visual_family": "explanatory",
    "data_topology": "process_graph",
    "chart_type": "process_schematic",
}
valid_process.pop("value_field", None)
valid_process.pop("flow_conservation", None)
valid_process.pop("flow_tolerance", None)
errors = list(validator.iter_errors(valid_process))
if errors:
    raise SystemExit("valid process_schematic spec failed schema validation: " + " | ".join(error.message for error in errors))

valid_chord = {
    **valid_sankey,
    "schema_version": "0.9.0",
    "reader_task": "relationship",
    "visual_family": "relationship",
    "data_topology": "graph_edges",
    "chart_type": "chord",
}
valid_chord.pop("flow_conservation", None)
valid_chord.pop("flow_tolerance", None)
errors = list(validator.iter_errors(valid_chord))
if errors:
    raise SystemExit("valid chord spec failed schema validation: " + " | ".join(error.message for error in errors))

valid_layered = {
    **valid_carto,
    "schema_version": "1.1.0",
    "flow_id_field": "flow_id",
    "flow_layer_field": "flow_layer",
    "flow_unit_field": "flow_unit",
    "flow_period_field": "flow_period",
    "flow_layer_order": ["Energy", "Logistics", "Capital"],
}
errors = list(validator.iter_errors(valid_layered))
if errors:
    raise SystemExit("valid layered cartographic spec failed schema validation: " + " | ".join(error.message for error in errors))
invalid_layered = dict(valid_layered)
invalid_layered.pop("flow_unit_field")
errors = list(validator.iter_errors(invalid_layered))
if not any("flow_unit_field" in error.message for error in errors):
    raise SystemExit("layered cartographic spec without flow_unit_field was not rejected")

print("viz schema: PASS")
print("draft: 2020-12")
print("valid spec: PASS")
print("conditional field checks: PASS")
print("complex topology schema: PASS")
print("v0.9 spatial/explanatory schema: PASS")
print("v1.0 cartographic flow schema: PASS")
print("v1.1 trajectory cartography schema: PASS")
print("v1.1 layered cartographic flow schema: PASS")
