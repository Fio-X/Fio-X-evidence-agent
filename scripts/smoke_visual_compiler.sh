#!/usr/bin/env bash
set -euo pipefail
node --check runtime/visual/runtime_registry.mjs
node --check runtime/visual/backend_policy.mjs
node --check runtime/visual/visual_recipe_v2.mjs
node --check runtime/visual/backend_router_v2.mjs
node --check runtime/visual/visual_compiler_v2.mjs
node --check runtime/visual/backend_executor.mjs
node --check runtime/visual/render_cache.mjs
node --check runtime/visual/semantic_contract.mjs
node --check runtime/visual/model_spec.mjs
node --check runtime/visual/capability_registry.mjs
node --check runtime/web/publication.mjs
node --check runtime/web/plotly_editorial.mjs
node --check runtime/web/d3_editorial.mjs
node --check runtime/visual/measure_semantics.mjs
node --check runtime/visual/editorial_semantics.mjs
node --check runtime/pi/measure_semantics.mjs
node --check runtime/pi/editorial_semantics.mjs
node --check runtime/pi/story_graph.mjs
node --check runtime/pi/infographic.mjs
node --check runtime/visual/backend_priors.mjs
node --check runtime/visual/runtime_executor.mjs
node --check runtime/visual/warm_worker_client.mjs
node --check runtime/visual/design_systems.mjs
node --check runtime/visual/visual_qa.mjs
node --check runtime/visual/art_direction_replay.mjs
node --check runtime/graph/backend_registry.mjs
node --check runtime/web/sigma_graph.mjs
node --check runtime/web/maplibre_deckgl.mjs
node --check runtime/web/render_request.mjs
node --check runtime/web/echarts_editorial.mjs
python3 -m py_compile runtime/browser/browser_qa.py runtime/browser/networkx_analyze.py runtime/browser/plotly_render.py scripts/test_publication_schema_v19.py scripts/test_model_spec_v19.py scripts/visual_qa_probe.py scripts/test_visual_qa_v133.py scripts/test_design_system_schema_v132.py scripts/test_art_direction_schema_v134.py runtime/gis/style_tokens.py scripts/runtime_health.py scripts/build_backend_priors.py scripts/promote_visual_runtime_locks.py scripts/test_runtime_promotion_v126.py scripts/test_python_editorial_extensions_v128.py scripts/test_backend_priors_v129.py scripts/build_benchmark_derivatives_v128.py scripts/test_blind_review_v129.py runtime/gis/python_publication_request.py runtime/gis/python_flow_map.py runtime/gis/qgis_publication_map.py runtime/gis/pygmt_publication_map.py runtime/gis/datashader_density.py runtime/graph/python_adjacency_matrix.py runtime/graph/graphrag_to_evidence.py runtime/graph/graphrag_request.py runtime/worker/python_worker.py scripts/test_python_warm_worker_v131.py
python3 scripts/runtime_health.py --output outputs/runtime-health.json >/dev/null
python3 scripts/test_runtime_foundation_v116.py
python3 scripts/test_runtime_build_plan_v116.py
python3 scripts/test_runtime_promotion_v126.py
python3 scripts/test_python_warm_worker_v131.py
python3 scripts/test_design_system_schema_v132.py
node scripts/test_design_systems_v132.mjs
node scripts/test_editorial_design_bundle_v132.mjs
python3 scripts/test_visual_qa_v133.py
python3 scripts/test_art_direction_schema_v134.py
node scripts/test_art_direction_replay_v134.mjs
node scripts/test_qualification_design_qa_v134.mjs
node scripts/test_art_direction_replay_render_v134.mjs
node scripts/test_warm_worker_client_v131.mjs
node scripts/test_runtime_executor_v126.mjs
node scripts/test_semantic_contract_v127.mjs
node scripts/test_editorial_semantics_v17.mjs
node scripts/test_editorial_semantics_adversarial_v17.mjs
node scripts/test_cold_story_editorial_semantics_v17.mjs
node scripts/test_runtime_editorial_semantics_v17.mjs
node scripts/test_runtime_visual_synthesis_v18.mjs
node scripts/test_visual_synthesis_v18.mjs
node scripts/test_benchmark_corpus_v128.mjs
python3 scripts/test_python_editorial_extensions_v128.py
node scripts/test_echarts_extensions_v128.mjs
python3 scripts/test_blind_review_v129.py
python3 scripts/test_backend_priors_v129.py scripts/build_benchmark_derivatives_v128.py
node scripts/test_evidence_router_v130.mjs
python3 scripts/test_visual_recipe_schema_v117.py
node scripts/test_visual_recipe_v117.mjs
node scripts/test_graph_backend_v120.mjs
node scripts/test_web_runtime_contract_v120.mjs
python3 scripts/test_adjacency_backend_v120.py
python3 scripts/test_graph_extraction_v125.py
node scripts/test_echarts_editorial_v121.mjs
node scripts/test_backend_executor_v118.mjs
python3 scripts/test_backend_priors_v122.py
node scripts/test_backend_router_v123.mjs
node scripts/test_render_cache_v124.mjs
node scripts/test_gis_backend_v115.mjs
node scripts/test_ai_visual_compiler_v115.mjs
python3 scripts/test_python_gis_backend_v115.py
node scripts/generate_backend_qualification_plan.mjs >/dev/null

# v1.9 browser-publication and advanced-engine qualification
node scripts/test_browser_publication_v19.mjs
python3 scripts/test_publication_schema_v19.py
python3 scripts/test_model_spec_v19.py
node scripts/test_model_gate_v19.mjs
node scripts/test_capability_registry_v19.mjs
node scripts/test_advanced_visual_engines_v19.mjs
node scripts/test_d3_fail_closed_v19.mjs
node scripts/test_webgl_fail_closed_v19.mjs
python3 scripts/runtime_health.py --output outputs/v19-browser/runtime-health.json >/dev/null
node scripts/test_advanced_router_v19.mjs
python3 runtime/browser/browser_qa.py --html outputs/v19-browser/energy.html --spec outputs/v19-browser/energy-publication.json --output outputs/v19-browser/energy-qa >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v19-browser/network.html --spec outputs/v19-browser/network-publication.json --output outputs/v19-browser/network-qa >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v19-browser/advanced.html --spec outputs/v19-browser/advanced-publication.json --output outputs/v19-browser/advanced-qa >/dev/null
set +e
python3 runtime/browser/browser_qa.py --html outputs/v19-browser/d3-unqualified.html --spec outputs/v19-browser/d3-unqualified-publication.json --output outputs/v19-browser/d3-unqualified-qa >/dev/null
d3_code=$?
set -e
if [ "$d3_code" -ne 2 ]; then echo "Expected D3 fail-closed probe to exit 2, got $d3_code" >&2; exit 1; fi
python3 - <<'PYD3'
import json
r=json.load(open('outputs/v19-browser/d3-unqualified-qa/browser-qa.json'))
assert r['status']=='FAIL' and any(str(x).startswith('blocked_modules:') for x in r['errors'])
print('v1.9 D3 fail-closed PASS')
PYD3
set +e
python3 runtime/browser/browser_qa.py --html outputs/v19-browser/webgl-unqualified.html --spec outputs/v19-browser/webgl-unqualified-publication.json --output outputs/v19-browser/webgl-unqualified-qa >/dev/null
webgl_code=$?
set -e
if [ "$webgl_code" -ne 2 ]; then echo "Expected WebGL fail-closed probe to exit 2, got $webgl_code" >&2; exit 1; fi
python3 - <<'PY2'
import json
r=json.load(open('outputs/v19-browser/webgl-unqualified-qa/browser-qa.json'))
assert r['status']=='FAIL' and any(str(x).startswith('webgl_unavailable:') for x in r['errors'])
print('v1.9 browser qualification PASS')
PY2

# v1.10 advanced systems, functional style mapping and scientific-map qualification
node scripts/test_style_mapping_v110.mjs
node scripts/test_nature_scientific_map_v110.mjs
node scripts/test_advanced_systems_v110.mjs
python3 runtime/browser/browser_qa.py --html outputs/v110-nature-map/index.html --spec outputs/v110-nature-map/publication-spec.json --output outputs/v110-nature-map/qa >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v110-systems/uncertainty.html --spec outputs/v110-systems/uncertainty-spec.json --output outputs/v110-systems/uncertainty-qa >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v110-systems/linked-geo.html --spec outputs/v110-systems/linked-geo-spec.json --output outputs/v110-systems/linked-geo-qa >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v110-systems/large-network.html --spec outputs/v110-systems/large-network-spec.json --output outputs/v110-systems/large-network-qa >/dev/null
python3 - <<'PYV110'
import json
from pathlib import Path
for p in [
    'outputs/v110-nature-map/qa/browser-qa.json',
    'outputs/v110-systems/uncertainty-qa/browser-qa.json',
    'outputs/v110-systems/linked-geo-qa/browser-qa.json',
    'outputs/v110-systems/large-network-qa/browser-qa.json',
]:
    r=json.loads(Path(p).read_text())
    assert r['status']=='PASS', (p,r.get('errors'))
q=json.loads(Path('outputs/v110-systems/qualification-summary.json').read_text())
assert q['uncertainty']['model']['status']=='PASS'
assert q['linked_geo']['backend']=='plotly_browser'
assert q['large_network']['compile_status']=='UNRESOLVED'
assert q['large_network']['editorial_verdict']=='FAIL_HAIRBALL_SPECIALIST_REQUIRED'
assert 'final_renderer_unavailable' in q['large_network']['unresolved']
assert q['style_negative']['status']=='BLOCK'
print('v1.10 advanced systems qualification PASS (large network remains fail-closed editorially)')
PYV110

# v1.12 trusted publication closure
node scripts/test_trusted_publication_v112.mjs
node scripts/test_phase_tool_scope_v112.mjs
node scripts/test_multiscale_map_v112.mjs
python3 scripts/test_network_overview_v112.py
python3 scripts/check_runtime_contract.py
python3 runtime/browser/browser_qa.py --html outputs/v112-trusted/archive.html --spec outputs/v112-trusted/archive-spec.json --output outputs/v112-trusted/archive-qa --profile cpu >/dev/null
python3 runtime/browser/browser_qa.py --html outputs/v112-trusted/production.html --spec outputs/v112-trusted/production-spec.json --output outputs/v112-trusted/production-qa --profile cpu >/dev/null
set +e
python3 runtime/browser/browser_qa.py --html outputs/v112-trusted/archive.html --spec outputs/v112-trusted/archive-spec.json --output outputs/v112-trusted/gpu-qa --profile gpu >/dev/null
gpu_code=$?
set -e
if [ "$gpu_code" -ne 2 ]; then echo "Expected v1.12 GPU qualification to fail closed on this host, got $gpu_code" >&2; exit 1; fi
python3 - <<'PYV112'
import json
for p in ['outputs/v112-trusted/archive-qa/browser-qa.json','outputs/v112-trusted/production-qa/browser-qa.json']:
 r=json.load(open(p)); assert r['status']=='PASS' and r['security']['sandbox'] is True and not r['accessibility_errors'], (p,r.get('errors'))
g=json.load(open('outputs/v112-trusted/gpu-qa/browser-qa.json')); assert g['status']=='FAIL' and any(str(x).startswith('webgl2_unavailable:') for x in g['errors'])
print('v1.12 trusted publication qualification PASS; GPU remains fail-closed')
PYV112
