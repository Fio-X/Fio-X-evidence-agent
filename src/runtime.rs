use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const EXTENSION_SOURCE: &str = include_str!("../runtime/pi/newsroom.ts");
const VIZ_RUNTIME: &str = include_str!("../runtime/pi/viz.mjs");
const CARTOGRAPHY_RUNTIME: &str = include_str!("../runtime/pi/cartography.mjs");
const CARTOGRAPHY_BASEMAP: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin0-110m.geojson");
const CARTOGRAPHY_BASEMAP_50M: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin0-50m.geojson");
const GSHHS_BASEMAP: &str = include_str!("../runtime/pi/assets/gshhs-i-syros-local.geojson");
const ECONOMY_NAMES_ASSET: &str = include_str!("../runtime/pi/assets/economy-names.json");
const CURRENCY_NAMES_ASSET: &str = include_str!("../runtime/pi/assets/currency-names.json");
const WB_RANK_BY_ASSET: &str = include_str!("../runtime/pi/assets/wb-rank-by.json");
const ECONOMY_NAMES_RUNTIME: &str = include_str!("../runtime/pi/economy_names.mjs");
const CHOROPLETH_RUNTIME: &str = include_str!("../runtime/pi/choropleth.mjs");
const US_PROJECTION_RUNTIME: &str = include_str!("../runtime/pi/us_projection.mjs");
const US_STATES_RUNTIME: &str = include_str!("../runtime/pi/us_states.mjs");
const RENDER_STYLES_RUNTIME: &str = include_str!("../runtime/pi/render_styles.mjs");
const STORY_FORMS_RUNTIME: &str = include_str!("../runtime/pi/story_forms.mjs");
const STORYBOARD_RUNTIME: &str = include_str!("../runtime/pi/storyboard.mjs");
const FORM_SELECTION_RUNTIME: &str = include_str!("../runtime/pi/form_selection.mjs");
const PALETTE_THEME_RUNTIME: &str = include_str!("../runtime/pi/palette_theme.mjs");
const RENDER_QA_STORY_RUNTIME: &str = include_str!("../runtime/pi/render_qa_story.mjs");
const US_STATE_NAMES_ASSET: &str = include_str!("../runtime/pi/assets/us-state-names.json");
const US_STATES_BASEMAP: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin1-us-110m.geojson");
const US_STATES_ATTRIBUTES_ASSET: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin1-us-110m-attributes.json");
const CHOROPLETH_ATTRIBUTES_ASSET: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin0-50m-attributes.json");
const NET_RUNTIME: &str = include_str!("../runtime/pi/net.mjs");
const PROVENANCE_RUNTIME: &str = include_str!("../runtime/pi/provenance.mjs");
const PDF_EXTRACT_RUNTIME: &str = include_str!("../runtime/pi/pdf_extract.mjs");
const EVIDENCE_GATE_RUNTIME: &str = include_str!("../runtime/pi/evidence_gate.mjs");
const CLAIM_LINT_RUNTIME: &str = include_str!("../runtime/pi/claim_lint.mjs");
const INFOGRAPHIC_RUNTIME: &str = include_str!("../runtime/pi/infographic.mjs");
const EXPLANATORY_RUNTIME: &str = include_str!("../runtime/pi/explanatory.mjs");
const ILLUSTRATION_RUNTIME: &str = include_str!("../runtime/pi/illustration.mjs");
const VISION_RUNTIME: &str = include_str!("../runtime/pi/vision.mjs");
const COMPETITION_RUNTIME: &str = include_str!("../runtime/pi/competition.mjs");
const EDITORIAL_RUNTIME: &str = include_str!("../runtime/pi/editorial.mjs");
const STORY_GRAPH_RUNTIME: &str = include_str!("../runtime/pi/story_graph.mjs");
const FACT_GRAPH_RUNTIME: &str = include_str!("../runtime/pi/fact_graph.mjs");
const EDITORIAL_GRAMMAR_RUNTIME: &str = include_str!("../runtime/pi/editorial_grammar.mjs");
const EDITORIAL_VALIDATORS_RUNTIME: &str = include_str!("../runtime/pi/editorial_validators.mjs");
const ART_DIRECTION_RUNTIME: &str = include_str!("../runtime/pi/art_direction.mjs");
const VISUAL_BACKENDS_RUNTIME: &str = include_str!("../runtime/pi/visual_backends.mjs");
const BACKEND_POLICY_RUNTIME: &str = include_str!("../runtime/pi/backend_policy.mjs");
const MEASURE_SEMANTICS_RUNTIME: &str = include_str!("../runtime/pi/measure_semantics.mjs");
const EDITORIAL_SEMANTICS_RUNTIME: &str = include_str!("../runtime/pi/editorial_semantics.mjs");
const CONTRACT_TEXT_RUNTIME: &str = include_str!("../runtime/pi/contract_text.mjs");
const VISUAL_SKILL_BUNDLE_RUNTIME: &str = include_str!("../runtime/pi/visual_skill_bundle.mjs");
const EDITORIAL_DESIGN_SYSTEM_BUNDLE_RUNTIME: &str =
    include_str!("../runtime/pi/editorial_design_system_bundle.mjs");
const RASTERIZE_RUNTIME: &str = include_str!("../runtime/pi/rasterize_svg.py");
const PUBLICATION_RUNTIME: &str = include_str!("../runtime/pi/publication.mjs");
const PLOTLY_EDITORIAL_RUNTIME: &str = include_str!("../runtime/pi/plotly_editorial.mjs");
const D3_EDITORIAL_RUNTIME: &str = include_str!("../runtime/pi/d3_editorial.mjs");
const PLOTLY_VENDOR_RUNTIME: &str = include_str!("../runtime/pi/vendor/plotly-3.3.1.min.js");
const BROWSER_QA_RUNTIME: &str = include_str!("../runtime/pi/browser_qa.py");
const COMPUTATION_ROWS_RUNTIME: &str = include_str!("../runtime/pi/computation_rows.mjs");
const NETWORKX_ANALYZE_RUNTIME: &str = include_str!("../runtime/pi/networkx_analyze.py");
const NETWORKX_REDUCE_RUNTIME: &str = include_str!("../runtime/pi/networkx_reduce.py");
const SCIENTIFIC_BASEMAP_PREPARE_RUNTIME: &str =
    include_str!("../runtime/pi/scientific_basemap_prepare.py");
const MODEL_SPEC_RUNTIME: &str = include_str!("../runtime/pi/model_spec.mjs");
const STYLE_MAPPING_RUNTIME: &str = include_str!("../runtime/pi/style_mapping.mjs");
const MAP_SPEC_RUNTIME: &str = include_str!("../runtime/pi/map_spec.mjs");
const SCIENTIFIC_MAP_RUNTIME: &str = include_str!("../runtime/pi/scientific_map.mjs");
const BASEMAP_REGISTRY_RUNTIME: &str = include_str!("../runtime/pi/basemap_registry.mjs");
const LOCATION_EVIDENCE_RUNTIME: &str = include_str!("../runtime/pi/location_evidence.mjs");
const LOCATION_PROOF_RUNTIME: &str = include_str!("../runtime/pi/location_proof.mjs");
const SYMBOL_MAP_SWITCH_RUNTIME: &str = include_str!("../runtime/pi/symbol_map_switch.mjs");
const FLOW_LAYOUT_RUNTIME: &str = include_str!("../runtime/pi/flow_layout.mjs");
const FLOW_MAP_LABELS_RUNTIME: &str = include_str!("../runtime/pi/flow_map_labels.mjs");
const FLOW_STYLES_RUNTIME: &str = include_str!("../runtime/pi/flow_styles.mjs");
const MAP_REFERENCE_LAYERS_RUNTIME: &str = include_str!("../runtime/pi/map_reference_layers.mjs");
const PUBLICATION_BINDING_RUNTIME: &str = include_str!("../runtime/pi/publication_binding.mjs");
const SVG_SECURITY_RUNTIME: &str = include_str!("../runtime/pi/svg_security.mjs");
const ASOF_PROBE_RUNTIME: &str = include_str!("../runtime/pi/asof_probe.mjs");
const CLAIM_BINDING_RUNTIME: &str = include_str!("../runtime/pi/claim_binding.mjs");
const NUMBER_SHADOW_RUNTIME: &str = include_str!("../runtime/pi/number_shadow.mjs");
const COMPACT_SETUP_RUNTIME: &str = include_str!("../runtime/pi/compact_setup.mjs");
const NUMBER_WORDS_RUNTIME: &str = include_str!("../runtime/pi/number_words.mjs");
const DATA_NOTES_RUNTIME: &str = include_str!("../runtime/pi/data_notes.mjs");
const PREFLIGHT_RUNTIME: &str = include_str!("../runtime/pi/preflight.mjs");
const PATCH_RETRY_RUNTIME: &str = include_str!("../runtime/pi/patch_retry.mjs");
const PAGE_OCR_RUNTIME: &str = include_str!("../runtime/pi/page_ocr.mjs");
const PAGE_OCR_SWIFT: &str = include_str!("../runtime/pi/page_ocr.swift");
const SHADOW_RUNTIME: &str = include_str!("../runtime/pi/shadow.mjs");
const EXTREME_PROBE_RUNTIME: &str = include_str!("../runtime/pi/extreme_probe.mjs");
const EXTREME_PROBE_WRITER_RUNTIME: &str = include_str!("../runtime/pi/extreme_probe_writer.mjs");
const RECORD_ONLY_RUNTIME: &str = include_str!("../runtime/pi/record_only.mjs");
const TOOL_CHAIN_RUNTIME: &str = include_str!("../runtime/pi/tool_chain.mjs");
const DESIGN_PACK_RUNTIME: &str = include_str!("../runtime/pi/design_pack.mjs");
const PAGE_SKELETON_RUNTIME: &str = include_str!("../runtime/pi/page_skeleton.mjs");
const CLAIM_CANDIDATES_RUNTIME: &str = include_str!("../runtime/pi/claim_candidates.mjs");
const TOOL_PHASE_POLICY_RUNTIME: &str = include_str!("../runtime/pi/tool_phase_policy.mjs");
const TOOL_REGISTRY_RUNTIME: &str = include_str!("../runtime/pi/tool_registry.mjs");
const PARALLEL_SCHEDULER_RUNTIME: &str = include_str!("../runtime/pi/parallel_scheduler.mjs");
const LOCAL_BACKEND_RUNTIME: &str = include_str!("../runtime/pi/local_backend.mjs");
const REFS_BLOCK2_RUNTIME: &str = include_str!("../runtime/pi/refs_block2.mjs");
const LIEFLAT_RUNTIME: &str = include_str!("../runtime/pi/lieflat.mjs");
const RENDER_QA_RUNTIME: &str = include_str!("../runtime/pi/render_qa.mjs");
const RENDER_QA_GEOMETRY_RUNTIME: &str = include_str!("../runtime/pi/render_qa_geometry.mjs");
const RENDER_QA_CONTRAST_RUNTIME: &str = include_str!("../runtime/pi/render_qa_contrast.mjs");
const RENDER_QA_SVG_RUNTIME: &str = include_str!("../runtime/pi/render_qa_svg.mjs");
const RENDER_QA_LABELS_RUNTIME: &str = include_str!("../runtime/pi/render_qa_labels.mjs");
const GROUPS_RUNTIME: &str = include_str!("../runtime/pi/groups.mjs");
const KNOWLEDGE_WRITER_RUNTIME: &str = include_str!("../runtime/pi/knowledge_writer.mjs");
const DECISION_WRITER_RUNTIME: &str = include_str!("../runtime/pi/decision_writer.mjs");
const SHADOW_WRITER_RUNTIME: &str = include_str!("../runtime/pi/shadow_writer.mjs");
const REVIEW_REJECT_WRITER_RUNTIME: &str = include_str!("../runtime/pi/review_reject_writer.mjs");
const AGENT_RECORD_WRITER_RUNTIME: &str = include_str!("../runtime/pi/agent_record_writer.mjs");
const PROBE_WRITER_RUNTIME: &str = include_str!("../runtime/pi/probe_writer.mjs");
const FETCH_SPLIT_PROBE_RUNTIME: &str = include_str!("../runtime/pi/fetch_split_probe.mjs");
const GROUPS_LIST: &str = include_str!("../runtime/pi/groups.json");
const RENDER_QA_TICKS_RUNTIME: &str = include_str!("../runtime/pi/render_qa_ticks.mjs");
const NEXT_LAYOUTS_RUNTIME: &str = include_str!("../runtime/pi/next_layouts.mjs");
const EDITORIAL_STYLE_MAPPING_CONFIG: &str =
    include_str!("../config/editorial-style-mappings.json");
const EDITORIAL_GRAMMAR_REGISTRY_CONFIG: &str =
    include_str!("../config/editorial-grammar-registry.json");

fn write_if_changed(root: &Path, path: &Path, content: &str) -> Result<()> {
    let should_write = match fs::read_to_string(path) {
        Ok(current) => current != content,
        Err(_) => true,
    };
    if should_write {
        crate::group_guard::write(root, path, content)
            .with_context(|| format!("failed to materialize runtime file: {}", path.display()))?;
    }
    Ok(())
}

/// Copies the program's own runtime and config into the run folder. These are the only writes made as the system group's materialize
/// writer (requested_by=materialize); the writes are judged like any other, so only the fixed file names of the materialized_runtime rows pass.
pub fn materialize_extension(artifact_dir: &Path) -> Result<PathBuf> {
    crate::group_guard::as_materialize(|| materialize_extension_unguarded(artifact_dir))
}

fn materialize_extension_unguarded(artifact_dir: &Path) -> Result<PathBuf> {
    let runtime_dir = artifact_dir.join("runtime");
    crate::group_guard::create_dir_all(artifact_dir, &runtime_dir).with_context(|| {
        format!(
            "failed to create runtime directory: {}",
            runtime_dir.display()
        )
    })?;

    write_if_changed(
        artifact_dir,
        &runtime_dir.join("process.mjs"),
        include_str!("../runtime/pi/process.mjs"),
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("tool_api.ts"),
        include_str!("../runtime/pi/tool_api.ts"),
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("tool_host.mjs"),
        include_str!("../runtime/pi/tool_host.mjs"),
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("tool_host_api.mjs"),
        include_str!("../runtime/pi/tool_host_api.mjs"),
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("tool_host_schema.mjs"),
        include_str!("../runtime/pi/tool_host_schema.mjs"),
    )?;
    let extension_path = runtime_dir.join("newsroom.ts");
    let viz_path = runtime_dir.join("viz.mjs");
    let cartography_path = runtime_dir.join("cartography.mjs");
    let assets_dir = runtime_dir.join("assets");
    crate::group_guard::create_dir_all(artifact_dir, &assets_dir).with_context(|| {
        format!(
            "failed to create runtime assets directory: {}",
            assets_dir.display()
        )
    })?;
    let cartography_basemap_path = assets_dir.join("naturalearth-admin0-110m.geojson");
    let cartography_basemap_50m_path = assets_dir.join("naturalearth-admin0-50m.geojson");
    let gshhs_basemap_path = assets_dir.join("gshhs-i-syros-local.geojson");
    let economy_names_asset_path = assets_dir.join("economy-names.json");
    let currency_names_asset_path = assets_dir.join("currency-names.json");
    let wb_rank_by_asset_path = assets_dir.join("wb-rank-by.json");
    let economy_names_path = runtime_dir.join("economy_names.mjs");
    let choropleth_path = runtime_dir.join("choropleth.mjs");
    let us_projection_path = runtime_dir.join("us_projection.mjs");
    let us_states_path = runtime_dir.join("us_states.mjs");
    let render_styles_path = runtime_dir.join("render_styles.mjs");
    let story_forms_path = runtime_dir.join("story_forms.mjs");
    let storyboard_path = runtime_dir.join("storyboard.mjs");
    let form_selection_path = runtime_dir.join("form_selection.mjs");
    let palette_theme_path = runtime_dir.join("palette_theme.mjs");
    let render_qa_story_path = runtime_dir.join("render_qa_story.mjs");
    let us_state_names_asset_path = assets_dir.join("us-state-names.json");
    let us_states_basemap_path = assets_dir.join("naturalearth-admin1-us-110m.geojson");
    let us_states_attributes_asset_path =
        assets_dir.join("naturalearth-admin1-us-110m-attributes.json");
    let choropleth_attributes_asset_path =
        assets_dir.join("naturalearth-admin0-50m-attributes.json");
    let net_path = runtime_dir.join("net.mjs");
    let provenance_path = runtime_dir.join("provenance.mjs");
    let pdf_extract_path = runtime_dir.join("pdf_extract.mjs");
    let evidence_gate_path = runtime_dir.join("evidence_gate.mjs");
    let claim_lint_path = runtime_dir.join("claim_lint.mjs");
    let infographic_path = runtime_dir.join("infographic.mjs");
    let explanatory_path = runtime_dir.join("explanatory.mjs");
    let illustration_path = runtime_dir.join("illustration.mjs");
    let vision_path = runtime_dir.join("vision.mjs");
    let competition_path = runtime_dir.join("competition.mjs");
    let editorial_path = runtime_dir.join("editorial.mjs");
    let story_graph_path = runtime_dir.join("story_graph.mjs");
    let fact_graph_path = runtime_dir.join("fact_graph.mjs");
    let editorial_grammar_path = runtime_dir.join("editorial_grammar.mjs");
    let editorial_validators_path = runtime_dir.join("editorial_validators.mjs");
    let art_direction_path = runtime_dir.join("art_direction.mjs");
    let visual_backends_path = runtime_dir.join("visual_backends.mjs");
    let backend_policy_path = runtime_dir.join("backend_policy.mjs");
    let measure_semantics_path = runtime_dir.join("measure_semantics.mjs");
    let editorial_semantics_path = runtime_dir.join("editorial_semantics.mjs");
    let contract_text_path = runtime_dir.join("contract_text.mjs");
    let visual_skill_bundle_path = runtime_dir.join("visual_skill_bundle.mjs");
    let editorial_design_system_bundle_path =
        runtime_dir.join("editorial_design_system_bundle.mjs");
    let rasterize_path = runtime_dir.join("rasterize_svg.py");
    let publication_path = runtime_dir.join("publication.mjs");
    let plotly_editorial_path = runtime_dir.join("plotly_editorial.mjs");
    let d3_editorial_path = runtime_dir.join("d3_editorial.mjs");
    let vendor_dir = runtime_dir.join("vendor");
    crate::group_guard::create_dir_all(artifact_dir, &vendor_dir).with_context(|| {
        format!(
            "failed to create runtime vendor directory: {}",
            vendor_dir.display()
        )
    })?;
    let plotly_vendor_path = vendor_dir.join("plotly-3.3.1.min.js");
    let browser_qa_path = runtime_dir.join("browser_qa.py");
    let computation_rows_path = runtime_dir.join("computation_rows.mjs");
    let networkx_analyze_path = runtime_dir.join("networkx_analyze.py");
    let networkx_reduce_path = runtime_dir.join("networkx_reduce.py");
    let scientific_basemap_prepare_path = runtime_dir.join("scientific_basemap_prepare.py");
    let model_spec_path = runtime_dir.join("model_spec.mjs");
    let style_mapping_path = runtime_dir.join("style_mapping.mjs");
    let map_spec_path = runtime_dir.join("map_spec.mjs");
    let scientific_map_path = runtime_dir.join("scientific_map.mjs");
    let basemap_registry_path = runtime_dir.join("basemap_registry.mjs");
    let location_evidence_path = runtime_dir.join("location_evidence.mjs");
    let location_proof_path = runtime_dir.join("location_proof.mjs");
    let symbol_map_switch_path = runtime_dir.join("symbol_map_switch.mjs");
    let flow_layout_path = runtime_dir.join("flow_layout.mjs");
    let map_reference_layers_path = runtime_dir.join("map_reference_layers.mjs");
    let publication_binding_path = runtime_dir.join("publication_binding.mjs");
    let svg_security_path = runtime_dir.join("svg_security.mjs");
    let asof_probe_path = runtime_dir.join("asof_probe.mjs");
    let claim_binding_path = runtime_dir.join("claim_binding.mjs");
    let number_shadow_path = runtime_dir.join("number_shadow.mjs");
    let compact_setup_path = runtime_dir.join("compact_setup.mjs");
    let number_words_path = runtime_dir.join("number_words.mjs");
    let data_notes_path = runtime_dir.join("data_notes.mjs");
    let preflight_path = runtime_dir.join("preflight.mjs");
    let patch_retry_path = runtime_dir.join("patch_retry.mjs");
    let page_ocr_path = runtime_dir.join("page_ocr.mjs");
    let page_ocr_swift_path = runtime_dir.join("page_ocr.swift");
    let shadow_path = runtime_dir.join("shadow.mjs");
    let extreme_probe_path = runtime_dir.join("extreme_probe.mjs");
    let extreme_probe_writer_path = runtime_dir.join("extreme_probe_writer.mjs");
    let record_only_path = runtime_dir.join("record_only.mjs");
    let tool_chain_path = runtime_dir.join("tool_chain.mjs");
    let design_pack_path = runtime_dir.join("design_pack.mjs");
    let page_skeleton_path = runtime_dir.join("page_skeleton.mjs");
    let claim_candidates_path = runtime_dir.join("claim_candidates.mjs");
    let tool_phase_policy_path = runtime_dir.join("tool_phase_policy.mjs");
    let tool_registry_path = runtime_dir.join("tool_registry.mjs");
    let parallel_scheduler_path = runtime_dir.join("parallel_scheduler.mjs");
    let local_backend_path = runtime_dir.join("local_backend.mjs");
    let refs_block2_path = runtime_dir.join("refs_block2.mjs");
    let lieflat_path = runtime_dir.join("lieflat.mjs");
    let render_qa_path = runtime_dir.join("render_qa.mjs");
    let render_qa_geometry_path = runtime_dir.join("render_qa_geometry.mjs");
    let render_qa_contrast_path = runtime_dir.join("render_qa_contrast.mjs");
    let render_qa_svg_path = runtime_dir.join("render_qa_svg.mjs");
    let render_qa_labels_path = runtime_dir.join("render_qa_labels.mjs");
    let render_qa_ticks_path = runtime_dir.join("render_qa_ticks.mjs");
    let next_layouts_path = runtime_dir.join("next_layouts.mjs");
    let config_dir = artifact_dir.join("config");
    crate::group_guard::create_dir_all(artifact_dir, &config_dir).with_context(|| {
        format!(
            "failed to create materialized config directory: {}",
            config_dir.display()
        )
    })?;
    let style_mapping_config_path = config_dir.join("editorial-style-mappings.json");
    let editorial_grammar_registry_path = config_dir.join("editorial-grammar-registry.json");
    write_if_changed(artifact_dir, &extension_path, EXTENSION_SOURCE)?;
    write_if_changed(artifact_dir, &viz_path, VIZ_RUNTIME)?;
    write_if_changed(artifact_dir, &cartography_path, CARTOGRAPHY_RUNTIME)?;
    write_if_changed(artifact_dir, &cartography_basemap_path, CARTOGRAPHY_BASEMAP)?;
    write_if_changed(
        artifact_dir,
        &cartography_basemap_50m_path,
        CARTOGRAPHY_BASEMAP_50M,
    )?;
    write_if_changed(artifact_dir, &gshhs_basemap_path, GSHHS_BASEMAP)?;
    write_if_changed(artifact_dir, &economy_names_asset_path, ECONOMY_NAMES_ASSET)?;
    write_if_changed(
        artifact_dir,
        &currency_names_asset_path,
        CURRENCY_NAMES_ASSET,
    )?;
    write_if_changed(artifact_dir, &wb_rank_by_asset_path, WB_RANK_BY_ASSET)?;
    write_if_changed(artifact_dir, &economy_names_path, ECONOMY_NAMES_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &choropleth_attributes_asset_path,
        CHOROPLETH_ATTRIBUTES_ASSET,
    )?;
    write_if_changed(artifact_dir, &choropleth_path, CHOROPLETH_RUNTIME)?;
    write_if_changed(artifact_dir, &us_projection_path, US_PROJECTION_RUNTIME)?;
    write_if_changed(artifact_dir, &us_states_path, US_STATES_RUNTIME)?;
    write_if_changed(artifact_dir, &render_styles_path, RENDER_STYLES_RUNTIME)?;
    write_if_changed(artifact_dir, &story_forms_path, STORY_FORMS_RUNTIME)?;
    write_if_changed(artifact_dir, &storyboard_path, STORYBOARD_RUNTIME)?;
    write_if_changed(artifact_dir, &form_selection_path, FORM_SELECTION_RUNTIME)?;
    write_if_changed(artifact_dir, &palette_theme_path, PALETTE_THEME_RUNTIME)?;
    write_if_changed(artifact_dir, &render_qa_story_path, RENDER_QA_STORY_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &us_state_names_asset_path,
        US_STATE_NAMES_ASSET,
    )?;
    write_if_changed(artifact_dir, &us_states_basemap_path, US_STATES_BASEMAP)?;
    write_if_changed(
        artifact_dir,
        &us_states_attributes_asset_path,
        US_STATES_ATTRIBUTES_ASSET,
    )?;
    write_if_changed(artifact_dir, &net_path, NET_RUNTIME)?;
    write_if_changed(artifact_dir, &provenance_path, PROVENANCE_RUNTIME)?;
    write_if_changed(artifact_dir, &pdf_extract_path, PDF_EXTRACT_RUNTIME)?;
    write_if_changed(artifact_dir, &evidence_gate_path, EVIDENCE_GATE_RUNTIME)?;
    write_if_changed(artifact_dir, &claim_lint_path, CLAIM_LINT_RUNTIME)?;
    write_if_changed(artifact_dir, &infographic_path, INFOGRAPHIC_RUNTIME)?;
    write_if_changed(artifact_dir, &explanatory_path, EXPLANATORY_RUNTIME)?;
    write_if_changed(artifact_dir, &illustration_path, ILLUSTRATION_RUNTIME)?;
    write_if_changed(artifact_dir, &vision_path, VISION_RUNTIME)?;
    write_if_changed(artifact_dir, &competition_path, COMPETITION_RUNTIME)?;
    write_if_changed(artifact_dir, &editorial_path, EDITORIAL_RUNTIME)?;
    write_if_changed(artifact_dir, &story_graph_path, STORY_GRAPH_RUNTIME)?;
    write_if_changed(artifact_dir, &fact_graph_path, FACT_GRAPH_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &editorial_grammar_path,
        EDITORIAL_GRAMMAR_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &editorial_validators_path,
        EDITORIAL_VALIDATORS_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &art_direction_path, ART_DIRECTION_RUNTIME)?;
    write_if_changed(artifact_dir, &visual_backends_path, VISUAL_BACKENDS_RUNTIME)?;
    write_if_changed(artifact_dir, &backend_policy_path, BACKEND_POLICY_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &measure_semantics_path,
        MEASURE_SEMANTICS_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &editorial_semantics_path,
        EDITORIAL_SEMANTICS_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &contract_text_path, CONTRACT_TEXT_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &visual_skill_bundle_path,
        VISUAL_SKILL_BUNDLE_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &editorial_design_system_bundle_path,
        EDITORIAL_DESIGN_SYSTEM_BUNDLE_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &rasterize_path, RASTERIZE_RUNTIME)?;
    write_if_changed(artifact_dir, &publication_path, PUBLICATION_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &plotly_editorial_path,
        PLOTLY_EDITORIAL_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &d3_editorial_path, D3_EDITORIAL_RUNTIME)?;
    write_if_changed(artifact_dir, &plotly_vendor_path, PLOTLY_VENDOR_RUNTIME)?;
    write_if_changed(artifact_dir, &browser_qa_path, BROWSER_QA_RUNTIME)?;
    // The leaf children of the new route's second layer (next_leaf Runner: draw, bake), each by its fixed name.
    let leaves_dir = runtime_dir.join("leaves_py");
    crate::group_guard::create_dir_all(artifact_dir, &leaves_dir)
        .with_context(|| format!("failed to create leaf runtime directory: {}", leaves_dir.display()))?;
    for (path, text) in [
        (runtime_dir.join("leaves_py/bake.py"), include_str!("../runtime/leaves_py/bake.py")),
        (runtime_dir.join("leaves_py/cards.py"), include_str!("../runtime/leaves_py/cards.py")),
        (runtime_dir.join("leaves_py/column.py"), include_str!("../runtime/leaves_py/column.py")),
        (runtime_dir.join("leaves_py/facts.py"), include_str!("../runtime/leaves_py/facts.py")),
        (runtime_dir.join("leaves_py/geo.py"), include_str!("../runtime/leaves_py/geo.py")),
        (runtime_dir.join("leaves_py/illus.py"), include_str!("../runtime/leaves_py/illus.py")),
        (runtime_dir.join("leaves_py/knobs.json"), include_str!("../runtime/leaves_py/knobs.json")),
        (runtime_dir.join("leaves_py/knobs.py"), include_str!("../runtime/leaves_py/knobs.py")),
        (runtime_dir.join("leaves_py/page_knobs.json"), include_str!("../runtime/leaves_py/page_knobs.json")),
        (runtime_dir.join("leaves_py/places.json"), include_str!("../runtime/leaves_py/places.json")),
        (runtime_dir.join("leaves_py/prod.py"), include_str!("../runtime/leaves_py/prod.py")),
        (runtime_dir.join("leaves_py/qa-layers.js"), include_str!("../runtime/leaves_py/qa-layers.js")),
        (runtime_dir.join("leaves_py/qa.js"), include_str!("../runtime/leaves_py/qa.js")),
        (runtime_dir.join("leaves_py/run.py"), include_str!("../runtime/leaves_py/run.py")),
        (runtime_dir.join("leaves_py/scmp.py"), include_str!("../runtime/leaves_py/scmp.py")),
        (runtime_dir.join("leaves_py/text-line-clash.js"), include_str!("../runtime/leaves_py/text-line-clash.js")),
        (runtime_dir.join("leaves_py/text-line-hits.js"), include_str!("../runtime/leaves_py/text-line-hits.js")),
        (runtime_dir.join("leaves_py/tokens.css"), include_str!("../runtime/leaves_py/tokens.css")),
        (runtime_dir.join("leaves_py/words.py"), include_str!("../runtime/leaves_py/words.py")),
        (runtime_dir.join("leaves_py/words.zh.json"), include_str!("../runtime/leaves_py/words.zh.json")),
    ] {
        write_if_changed(artifact_dir, &path, text)?;
    }
    write_if_changed(
        artifact_dir,
        &computation_rows_path,
        COMPUTATION_ROWS_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &networkx_analyze_path,
        NETWORKX_ANALYZE_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &networkx_reduce_path, NETWORKX_REDUCE_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &scientific_basemap_prepare_path,
        SCIENTIFIC_BASEMAP_PREPARE_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &model_spec_path, MODEL_SPEC_RUNTIME)?;
    write_if_changed(artifact_dir, &style_mapping_path, STYLE_MAPPING_RUNTIME)?;
    write_if_changed(artifact_dir, &map_spec_path, MAP_SPEC_RUNTIME)?;
    write_if_changed(artifact_dir, &scientific_map_path, SCIENTIFIC_MAP_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &basemap_registry_path,
        BASEMAP_REGISTRY_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &location_evidence_path,
        LOCATION_EVIDENCE_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &location_proof_path, LOCATION_PROOF_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &symbol_map_switch_path,
        SYMBOL_MAP_SWITCH_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &flow_layout_path, FLOW_LAYOUT_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("flow_map_labels.mjs"),
        FLOW_MAP_LABELS_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("flow_styles.mjs"),
        FLOW_STYLES_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &map_reference_layers_path,
        MAP_REFERENCE_LAYERS_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &publication_binding_path,
        PUBLICATION_BINDING_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &svg_security_path, SVG_SECURITY_RUNTIME)?;
    write_if_changed(artifact_dir, &asof_probe_path, ASOF_PROBE_RUNTIME)?;
    write_if_changed(artifact_dir, &claim_binding_path, CLAIM_BINDING_RUNTIME)?;
    write_if_changed(artifact_dir, &number_shadow_path, NUMBER_SHADOW_RUNTIME)?;
    write_if_changed(artifact_dir, &compact_setup_path, COMPACT_SETUP_RUNTIME)?;
    write_if_changed(artifact_dir, &number_words_path, NUMBER_WORDS_RUNTIME)?;
    write_if_changed(artifact_dir, &data_notes_path, DATA_NOTES_RUNTIME)?;
    write_if_changed(artifact_dir, &preflight_path, PREFLIGHT_RUNTIME)?;
    write_if_changed(artifact_dir, &patch_retry_path, PATCH_RETRY_RUNTIME)?;
    write_if_changed(artifact_dir, &page_ocr_path, PAGE_OCR_RUNTIME)?;
    write_if_changed(artifact_dir, &page_ocr_swift_path, PAGE_OCR_SWIFT)?;
    write_if_changed(artifact_dir, &shadow_path, SHADOW_RUNTIME)?;
    write_if_changed(artifact_dir, &record_only_path, RECORD_ONLY_RUNTIME)?;
    write_if_changed(artifact_dir, &extreme_probe_path, EXTREME_PROBE_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &extreme_probe_writer_path,
        EXTREME_PROBE_WRITER_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &tool_chain_path, TOOL_CHAIN_RUNTIME)?;
    write_if_changed(artifact_dir, &design_pack_path, DESIGN_PACK_RUNTIME)?;
    write_if_changed(artifact_dir, &page_skeleton_path, PAGE_SKELETON_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &claim_candidates_path,
        CLAIM_CANDIDATES_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &tool_phase_policy_path,
        TOOL_PHASE_POLICY_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &tool_registry_path, TOOL_REGISTRY_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &parallel_scheduler_path,
        PARALLEL_SCHEDULER_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &local_backend_path, LOCAL_BACKEND_RUNTIME)?;
    write_if_changed(artifact_dir, &refs_block2_path, REFS_BLOCK2_RUNTIME)?;
    write_if_changed(artifact_dir, &lieflat_path, LIEFLAT_RUNTIME)?;
    write_if_changed(artifact_dir, &render_qa_path, RENDER_QA_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &render_qa_geometry_path,
        RENDER_QA_GEOMETRY_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &render_qa_contrast_path,
        RENDER_QA_CONTRAST_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &render_qa_svg_path, RENDER_QA_SVG_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &render_qa_labels_path,
        RENDER_QA_LABELS_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("groups.mjs"),
        GROUPS_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("knowledge_writer.mjs"),
        KNOWLEDGE_WRITER_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("decision_writer.mjs"),
        DECISION_WRITER_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("shadow_writer.mjs"),
        SHADOW_WRITER_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("review_reject_writer.mjs"),
        REVIEW_REJECT_WRITER_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("agent_record_writer.mjs"),
        AGENT_RECORD_WRITER_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("probe_writer.mjs"),
        PROBE_WRITER_RUNTIME,
    )?;
    write_if_changed(
        artifact_dir,
        &runtime_dir.join("fetch_split_probe.mjs"),
        FETCH_SPLIT_PROBE_RUNTIME,
    )?;
    write_if_changed(artifact_dir, &runtime_dir.join("groups.json"), GROUPS_LIST)?;
    write_if_changed(artifact_dir, &render_qa_ticks_path, RENDER_QA_TICKS_RUNTIME)?;
    write_if_changed(artifact_dir, &next_layouts_path, NEXT_LAYOUTS_RUNTIME)?;
    write_if_changed(
        artifact_dir,
        &style_mapping_config_path,
        EDITORIAL_STYLE_MAPPING_CONFIG,
    )?;
    write_if_changed(
        artifact_dir,
        &editorial_grammar_registry_path,
        EDITORIAL_GRAMMAR_REGISTRY_CONFIG,
    )?;

    Ok(extension_path)
}

#[cfg(test)]
mod tests {
    use super::materialize_extension;
    use std::fs;

    #[test]
    fn materializes_style_mapping_config_for_isolated_runtime() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempfile::tempdir().expect("temporary artifact root");
        let extension = materialize_extension(root.path()).expect("materialize runtime");
        assert!(extension.is_file());
        let config = root
            .path()
            .join("config")
            .join("editorial-style-mappings.json");
        let config_text = fs::read_to_string(config).expect("materialized style mapping config");
        assert!(config_text.contains("japanese_editorial"));
        let style_runtime = fs::read_to_string(root.path().join("runtime/style_mapping.mjs"))
            .expect("materialized style mapping runtime");
        assert!(style_runtime.contains("NEWSROOM_ARTIFACT_DIR"));
        assert!(root.path().join("runtime").join("fact_graph.mjs").is_file());
        assert!(root
            .path()
            .join("runtime")
            .join("editorial_grammar.mjs")
            .is_file());
        assert!(root
            .path()
            .join("runtime")
            .join("editorial_validators.mjs")
            .is_file());
        assert!(root.path().join("runtime").join("render_qa.mjs").is_file());
        for module in [
            "asof_probe.mjs",
            "claim_binding.mjs",
            "compact_setup.mjs",
            "extreme_probe.mjs",
            "extreme_probe_writer.mjs",
            "data_notes.mjs",
            "number_shadow.mjs",
            "number_words.mjs",
            "page_ocr.mjs",
            "page_ocr.swift",
            "patch_retry.mjs",
            "preflight.mjs",
            "shadow.mjs",
            "record_only.mjs",
            "tool_chain.mjs",
            "design_pack.mjs",
            "page_skeleton.mjs",
            "claim_candidates.mjs",
        ] {
            assert!(
                root.path().join("runtime").join(module).is_file(),
                "{module} missing"
            );
        }
        assert!(root
            .path()
            .join("runtime")
            .join("render_qa_geometry.mjs")
            .is_file());
        assert!(root
            .path()
            .join("runtime")
            .join("render_qa_contrast.mjs")
            .is_file());
        assert!(root
            .path()
            .join("runtime")
            .join("render_qa_svg.mjs")
            .is_file());
        assert!(root
            .path()
            .join("runtime")
            .join("render_qa_labels.mjs")
            .is_file());
        let grammar_registry = fs::read_to_string(
            root.path()
                .join("config")
                .join("editorial-grammar-registry.json"),
        )
        .expect("materialized editorial grammar registry");
        assert!(grammar_registry.contains("ROUTE_SPINE"));
        assert!(grammar_registry.contains("THEMATIC_MAP"));
        assert!(grammar_registry.contains("FLOW_LEDGER"));
    }
}
