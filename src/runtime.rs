use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const NEWSROOM_EXTENSION: &str = include_str!("../runtime/pi/newsroom.ts");
const VIZ_RUNTIME: &str = include_str!("../runtime/pi/viz.mjs");
const CARTOGRAPHY_RUNTIME: &str = include_str!("../runtime/pi/cartography.mjs");
const CARTOGRAPHY_BASEMAP: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin0-110m.geojson");
const CARTOGRAPHY_BASEMAP_50M: &str =
    include_str!("../runtime/pi/assets/naturalearth-admin0-50m.geojson");
const GSHHS_BASEMAP: &str = include_str!("../runtime/pi/assets/gshhs-i-syros-local.geojson");
const NET_RUNTIME: &str = include_str!("../runtime/pi/net.mjs");
const PROVENANCE_RUNTIME: &str = include_str!("../runtime/pi/provenance.mjs");
const EVIDENCE_GATE_RUNTIME: &str = include_str!("../runtime/pi/evidence_gate.mjs");
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
const FLOW_LAYOUT_RUNTIME: &str = include_str!("../runtime/pi/flow_layout.mjs");
const PUBLICATION_BINDING_RUNTIME: &str = include_str!("../runtime/pi/publication_binding.mjs");
const SVG_SECURITY_RUNTIME: &str = include_str!("../runtime/pi/svg_security.mjs");
const TOOL_PHASE_POLICY_RUNTIME: &str = include_str!("../runtime/pi/tool_phase_policy.mjs");
const TOOL_REGISTRY_RUNTIME: &str = include_str!("../runtime/pi/tool_registry.mjs");
const PARALLEL_SCHEDULER_RUNTIME: &str = include_str!("../runtime/pi/parallel_scheduler.mjs");
const LOCAL_BACKEND_RUNTIME: &str = include_str!("../runtime/pi/local_backend.mjs");
const LIEFLAT_RUNTIME: &str = include_str!("../runtime/pi/lieflat.mjs");
const EDITORIAL_STYLE_MAPPING_CONFIG: &str =
    include_str!("../config/editorial-style-mappings.json");
const EDITORIAL_GRAMMAR_REGISTRY_CONFIG: &str =
    include_str!("../config/editorial-grammar-registry.json");

fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    let should_write = match fs::read_to_string(path) {
        Ok(current) => current != content,
        Err(_) => true,
    };
    if should_write {
        fs::write(path, content)
            .with_context(|| format!("failed to materialize runtime file: {}", path.display()))?;
    }
    Ok(())
}

pub fn materialize_extension(artifact_dir: &Path) -> Result<PathBuf> {
    let runtime_dir = artifact_dir.join("runtime");
    fs::create_dir_all(&runtime_dir).with_context(|| {
        format!(
            "failed to create runtime directory: {}",
            runtime_dir.display()
        )
    })?;

    write_if_changed(
        &runtime_dir.join("process.mjs"),
        include_str!("../runtime/pi/process.mjs"),
    )?;
    let extension_path = runtime_dir.join("newsroom.ts");
    let viz_path = runtime_dir.join("viz.mjs");
    let cartography_path = runtime_dir.join("cartography.mjs");
    let assets_dir = runtime_dir.join("assets");
    fs::create_dir_all(&assets_dir).with_context(|| {
        format!(
            "failed to create runtime assets directory: {}",
            assets_dir.display()
        )
    })?;
    let cartography_basemap_path = assets_dir.join("naturalearth-admin0-110m.geojson");
    let cartography_basemap_50m_path = assets_dir.join("naturalearth-admin0-50m.geojson");
    let gshhs_basemap_path = assets_dir.join("gshhs-i-syros-local.geojson");
    let net_path = runtime_dir.join("net.mjs");
    let provenance_path = runtime_dir.join("provenance.mjs");
    let evidence_gate_path = runtime_dir.join("evidence_gate.mjs");
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
    let visual_skill_bundle_path = runtime_dir.join("visual_skill_bundle.mjs");
    let editorial_design_system_bundle_path =
        runtime_dir.join("editorial_design_system_bundle.mjs");
    let rasterize_path = runtime_dir.join("rasterize_svg.py");
    let publication_path = runtime_dir.join("publication.mjs");
    let plotly_editorial_path = runtime_dir.join("plotly_editorial.mjs");
    let d3_editorial_path = runtime_dir.join("d3_editorial.mjs");
    let vendor_dir = runtime_dir.join("vendor");
    fs::create_dir_all(&vendor_dir).with_context(|| {
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
    let flow_layout_path = runtime_dir.join("flow_layout.mjs");
    let publication_binding_path = runtime_dir.join("publication_binding.mjs");
    let svg_security_path = runtime_dir.join("svg_security.mjs");
    let tool_phase_policy_path = runtime_dir.join("tool_phase_policy.mjs");
    let tool_registry_path = runtime_dir.join("tool_registry.mjs");
    let parallel_scheduler_path = runtime_dir.join("parallel_scheduler.mjs");
    let local_backend_path = runtime_dir.join("local_backend.mjs");
    let lieflat_path = runtime_dir.join("lieflat.mjs");
    let config_dir = artifact_dir.join("config");
    fs::create_dir_all(&config_dir).with_context(|| {
        format!(
            "failed to create materialized config directory: {}",
            config_dir.display()
        )
    })?;
    let style_mapping_config_path = config_dir.join("editorial-style-mappings.json");
    let editorial_grammar_registry_path = config_dir.join("editorial-grammar-registry.json");
    write_if_changed(&extension_path, NEWSROOM_EXTENSION)?;
    write_if_changed(&viz_path, VIZ_RUNTIME)?;
    write_if_changed(&cartography_path, CARTOGRAPHY_RUNTIME)?;
    write_if_changed(&cartography_basemap_path, CARTOGRAPHY_BASEMAP)?;
    write_if_changed(&cartography_basemap_50m_path, CARTOGRAPHY_BASEMAP_50M)?;
    write_if_changed(&gshhs_basemap_path, GSHHS_BASEMAP)?;
    write_if_changed(&net_path, NET_RUNTIME)?;
    write_if_changed(&provenance_path, PROVENANCE_RUNTIME)?;
    write_if_changed(&evidence_gate_path, EVIDENCE_GATE_RUNTIME)?;
    write_if_changed(&infographic_path, INFOGRAPHIC_RUNTIME)?;
    write_if_changed(&explanatory_path, EXPLANATORY_RUNTIME)?;
    write_if_changed(&illustration_path, ILLUSTRATION_RUNTIME)?;
    write_if_changed(&vision_path, VISION_RUNTIME)?;
    write_if_changed(&competition_path, COMPETITION_RUNTIME)?;
    write_if_changed(&editorial_path, EDITORIAL_RUNTIME)?;
    write_if_changed(&story_graph_path, STORY_GRAPH_RUNTIME)?;
    write_if_changed(&fact_graph_path, FACT_GRAPH_RUNTIME)?;
    write_if_changed(&editorial_grammar_path, EDITORIAL_GRAMMAR_RUNTIME)?;
    write_if_changed(&editorial_validators_path, EDITORIAL_VALIDATORS_RUNTIME)?;
    write_if_changed(&art_direction_path, ART_DIRECTION_RUNTIME)?;
    write_if_changed(&visual_backends_path, VISUAL_BACKENDS_RUNTIME)?;
    write_if_changed(&backend_policy_path, BACKEND_POLICY_RUNTIME)?;
    write_if_changed(&measure_semantics_path, MEASURE_SEMANTICS_RUNTIME)?;
    write_if_changed(&editorial_semantics_path, EDITORIAL_SEMANTICS_RUNTIME)?;
    write_if_changed(&visual_skill_bundle_path, VISUAL_SKILL_BUNDLE_RUNTIME)?;
    write_if_changed(
        &editorial_design_system_bundle_path,
        EDITORIAL_DESIGN_SYSTEM_BUNDLE_RUNTIME,
    )?;
    write_if_changed(&rasterize_path, RASTERIZE_RUNTIME)?;
    write_if_changed(&publication_path, PUBLICATION_RUNTIME)?;
    write_if_changed(&plotly_editorial_path, PLOTLY_EDITORIAL_RUNTIME)?;
    write_if_changed(&d3_editorial_path, D3_EDITORIAL_RUNTIME)?;
    write_if_changed(&plotly_vendor_path, PLOTLY_VENDOR_RUNTIME)?;
    write_if_changed(&browser_qa_path, BROWSER_QA_RUNTIME)?;
    write_if_changed(&computation_rows_path, COMPUTATION_ROWS_RUNTIME)?;
    write_if_changed(&networkx_analyze_path, NETWORKX_ANALYZE_RUNTIME)?;
    write_if_changed(&networkx_reduce_path, NETWORKX_REDUCE_RUNTIME)?;
    write_if_changed(
        &scientific_basemap_prepare_path,
        SCIENTIFIC_BASEMAP_PREPARE_RUNTIME,
    )?;
    write_if_changed(&model_spec_path, MODEL_SPEC_RUNTIME)?;
    write_if_changed(&style_mapping_path, STYLE_MAPPING_RUNTIME)?;
    write_if_changed(&map_spec_path, MAP_SPEC_RUNTIME)?;
    write_if_changed(&scientific_map_path, SCIENTIFIC_MAP_RUNTIME)?;
    write_if_changed(&basemap_registry_path, BASEMAP_REGISTRY_RUNTIME)?;
    write_if_changed(&flow_layout_path, FLOW_LAYOUT_RUNTIME)?;
    write_if_changed(&publication_binding_path, PUBLICATION_BINDING_RUNTIME)?;
    write_if_changed(&svg_security_path, SVG_SECURITY_RUNTIME)?;
    write_if_changed(&tool_phase_policy_path, TOOL_PHASE_POLICY_RUNTIME)?;
    write_if_changed(&tool_registry_path, TOOL_REGISTRY_RUNTIME)?;
    write_if_changed(&parallel_scheduler_path, PARALLEL_SCHEDULER_RUNTIME)?;
    write_if_changed(&local_backend_path, LOCAL_BACKEND_RUNTIME)?;
    write_if_changed(&lieflat_path, LIEFLAT_RUNTIME)?;
    write_if_changed(&style_mapping_config_path, EDITORIAL_STYLE_MAPPING_CONFIG)?;
    write_if_changed(
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
        let grammar_registry = fs::read_to_string(
            root.path()
                .join("config")
                .join("editorial-grammar-registry.json"),
        )
        .expect("materialized editorial grammar registry");
        assert!(grammar_registry.contains("ROUTE_SPINE"));
    }
}
