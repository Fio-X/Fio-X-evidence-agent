#!/usr/bin/env bash
set -euo pipefail
for script in scripts/bootstrap_live_env.sh scripts/live_qualification.sh scripts/agentic_qualification.sh scripts/integration_qualification.sh scripts/live_in_docker.sh scripts/test_control_plane.sh scripts/provider_matrix.sh; do bash -n "$script"; done
node --check runtime/pi/viz.mjs
node --check runtime/pi/cartography.mjs
node --check runtime/pi/basemap_registry.mjs
node --check runtime/pi/flow_layout.mjs
node --check runtime/pi/movement_track.mjs
node --check runtime/pi/quality.mjs
node --check runtime/pi/flow_aggregation.mjs
node --check runtime/pi/domain_layers.mjs
node --check runtime/pi/scene.mjs
node --check runtime/pi/scene_solver.mjs
node --check runtime/pi/label_layout.mjs
node --check runtime/pi/render_router.mjs
node --check runtime/gis/backend_registry.mjs
node --check runtime/gis/ai_visual_compiler.mjs
node --check runtime/visual/runtime_registry.mjs
node --check runtime/visual/backend_policy.mjs
node --check runtime/visual/visual_recipe_v2.mjs
node --check runtime/visual/backend_router_v2.mjs
node --check runtime/visual/visual_compiler_v2.mjs
node --check runtime/visual/backend_executor.mjs
node --check runtime/visual/render_cache.mjs
node --check runtime/visual/semantic_contract.mjs
node --check runtime/visual/backend_priors.mjs
node --check runtime/visual/runtime_executor.mjs
node --check runtime/visual/warm_worker_client.mjs
node --check runtime/web/echarts_editorial.mjs
node --check runtime/graph/backend_registry.mjs
node --check runtime/web/sigma_graph.mjs
node --check runtime/web/maplibre_deckgl.mjs
node --check runtime/web/render_request.mjs
node --check runtime/pi/backend_policy.mjs
node --check runtime/pi/visual_backends.mjs
node --check runtime/pi/visual_skill_bundle.mjs
node --check runtime/pi/pro_export.mjs
node --check runtime/pi/net.mjs
node --check runtime/pi/provenance.mjs
node --check runtime/pi/infographic.mjs
node --check runtime/pi/explanatory.mjs
node --check runtime/pi/illustration.mjs
node --check runtime/pi/vision.mjs
node --check runtime/pi/editorial.mjs
node --check runtime/pi/story_graph.mjs
node --check runtime/pi/measure_semantics.mjs
node --check runtime/pi/editorial_semantics.mjs
node --check runtime/pi/art_direction.mjs
node --experimental-strip-types --check runtime/pi/newsroom.ts
python3 -m py_compile runtime/gis/python_publication_map.py runtime/gis/python_publication_request.py runtime/graph/python_adjacency_matrix.py runtime/graph/graphrag_to_evidence.py runtime/graph/graphrag_request.py scripts/test_python_gis_backend_v115.py scripts/test_adjacency_backend_v120.py scripts/test_runtime_build_plan_v116.py scripts/test_visual_recipe_schema_v117.py
python3 -m py_compile runtime/gis/qgis_publication_map.py runtime/gis/pygmt_publication_map.py runtime/gis/datashader_density.py scripts/runtime_health.py scripts/build_backend_priors.py scripts/build_visual_skill_bundle.py scripts/test_runtime_foundation_v116.py scripts/test_backend_priors_v122.py scripts/test_visual_skill_bundle_v116.py runtime/gis/python_flow_map.py runtime/worker/python_worker.py scripts/promote_visual_runtime_locks.py scripts/test_runtime_promotion_v126.py scripts/test_python_warm_worker_v131.py scripts/test_python_editorial_extensions_v128.py scripts/test_blind_review_v129.py scripts/test_backend_priors_v129.py scripts/build_benchmark_derivatives_v128.py
python3 -m py_compile scripts/test_story_graph_schema_v18.py scripts/test_infographic_schema.py scripts/test_infographic_raster.py scripts/test_explanatory_raster.py scripts/verify_artifact.py scripts/evaluate_artifact.py scripts/selftest_evaluator.py scripts/test_integrity_adversarial.py scripts/benchmark_verify.py scripts/benchmark_verify_scale.py scripts/test_artifact_schema.py scripts/check_release_baseline.py scripts/mock_pi.py scripts/live_readiness.py scripts/test_live_readiness.py scripts/test_recompute_protocol.py scripts/write_qualification.py scripts/test_qualification_summary.py scripts/create_recompute_fixture.py scripts/compare_qualifications.py scripts/test_infographic_preview.py runtime/pi/rasterize_svg.py scripts/mock_illustration_adapter.py scripts/natural_earth_map_adapter.py scripts/test_nasa_award_raster_v14.py scripts/test_cartographic_raster_v15.py scripts/test_trajectory_raster_v16.py scripts/test_editorial_verifier_v14.py scripts/benchmark_editorial_verify_v14.py
python3 scripts/check_release_baseline.py
python3 scripts/test_live_readiness.py
python3 scripts/check_runtime_contract.py
python3 scripts/sync_tool_registry.py
node scripts/test_phase_tool_scope_v112.mjs
python3 scripts/test_production_qualification_contract_v113.py
python3 scripts/test_agentic_hardening.py
python3 -m py_compile scripts/evaluate_agentic_artifact.py scripts/agentic_trials.py scripts/business_metrics.py
python3 scripts/test_viz_schema.py
python3 scripts/test_artifact_schema.py
python3 scripts/test_infographic_schema.py
python3 scripts/test_story_graph_schema_v18.py
python3 scripts/verify_fixture.py
node scripts/test_content_addressing.mjs
node scripts/test_stream_limits.mjs
node scripts/test_cjk_viz.mjs
node scripts/test_viz.mjs
node scripts/test_viz_snapshots.mjs
node scripts/test_complex_viz.mjs
node scripts/test_complex_snapshots.mjs
node scripts/test_complex_realdata_viz.mjs
node scripts/test_realdata_viz.mjs
node scripts/test_spatial_explanatory_viz.mjs
node scripts/test_spatial_explanatory_snapshots.mjs
node scripts/test_v09_realdata_viz.mjs
node scripts/test_cartographic_flow_v15.mjs
node scripts/test_cartographic_magazine_v15.mjs
node scripts/test_trajectory_cartography_v16.mjs
node scripts/test_trajectory_magazine_v16.mjs
node scripts/test_ais_local_cartography_v16.mjs
node scripts/test_ais_local_cartography_v17.mjs
node scripts/test_movement_track_v18.mjs
node scripts/test_quality_v161.mjs
node scripts/test_basemap_registry_v17.mjs
node scripts/test_flow_aggregation_v19.mjs
node scripts/test_domain_layers_v110.mjs
node scripts/test_visual_scene_v111.mjs
node scripts/test_label_layout_v112.mjs
node scripts/test_renderer_router_v113.mjs
node scripts/test_gis_backend_v115.mjs
node scripts/test_ai_visual_compiler_v115.mjs
python3 scripts/runtime_health.py --output outputs/runtime-health.json >/dev/null
python3 scripts/test_runtime_foundation_v116.py
python3 scripts/test_runtime_build_plan_v116.py
python3 scripts/test_runtime_promotion_v126.py
python3 scripts/test_python_warm_worker_v131.py
node scripts/test_warm_worker_client_v131.mjs
python3 scripts/test_design_system_schema_v132.py
node scripts/test_design_systems_v132.mjs
node scripts/test_editorial_design_bundle_v132.mjs
python3 scripts/test_visual_qa_v133.py
python3 scripts/test_art_direction_schema_v134.py
node scripts/test_art_direction_replay_v134.mjs
node scripts/test_qualification_design_qa_v134.mjs
node scripts/test_art_direction_replay_render_v134.mjs
node scripts/test_runtime_executor_v126.mjs
node scripts/test_semantic_contract_v127.mjs
node scripts/test_benchmark_corpus_v128.mjs
python3 scripts/test_python_editorial_extensions_v128.py
node scripts/test_echarts_extensions_v128.mjs
python3 scripts/test_blind_review_v129.py
python3 scripts/test_backend_priors_v129.py scripts/build_benchmark_derivatives_v128.py
node scripts/test_evidence_router_v130.mjs
python3 scripts/test_visual_recipe_schema_v117.py
python3 scripts/test_visual_skill_bundle_v116.py
node scripts/test_visual_backend_agent_v116.mjs
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
node scripts/generate_backend_qualification_plan.mjs >/dev/null
python3 scripts/test_python_gis_backend_v115.py
node scripts/test_pro_finish_v114.mjs
python3 scripts/test_cartographic_raster_v15.py
python3 scripts/test_trajectory_raster_v16.py
node scripts/test_explanatory.mjs
node scripts/test_rich_illustration.mjs
node scripts/test_vision_contract.mjs
node scripts/test_competition_policy.mjs
node scripts/test_editorial_intelligence.mjs
node scripts/test_runtime_visual_synthesis_v18.mjs
node scripts/test_visual_synthesis_v18.mjs
node scripts/test_editorial_archetypes_v14.mjs
node scripts/test_art_direction_v14.mjs
python3 scripts/test_explanatory_raster.py
python3 scripts/test_infographic_preview.py runtime/pi/rasterize_svg.py scripts/mock_illustration_adapter.py
node scripts/test_infographic.mjs
node scripts/test_magazine_realdata.mjs
node scripts/test_nasa_magazine_realdata.mjs
node scripts/test_nasa_award_v14.mjs
python3 scripts/test_nasa_award_raster_v14.py
python3 scripts/test_infographic_raster.py
python3 scripts/selftest_evaluator.py
python3 scripts/test_integrity_adversarial.py
python3 scripts/test_editorial_verifier_v14.py
python3 scripts/test_recompute_protocol.py
python3 scripts/test_qualification_summary.py scripts/create_recompute_fixture.py
python3 scripts/benchmark_verify.py
python3 scripts/benchmark_verify_scale.py
python3 scripts/benchmark_editorial_verify_v14.py
python3 scripts/test_mock_pi.py
./scripts/test_control_plane.sh
node scripts/benchmark_viz.mjs
node scripts/benchmark_complex_viz.mjs
node scripts/benchmark_spatial_explanatory_viz.mjs
node scripts/benchmark_cartographic_flow_v15.mjs
node scripts/benchmark_trajectory_v16.mjs
node scripts/benchmark_explanatory.mjs
node scripts/benchmark_infographic.mjs

node scripts/benchmark_visual_editor_v13.mjs
node scripts/benchmark_editorial_v14.mjs
node scripts/benchmark_scene_v14.mjs
