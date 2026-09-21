const INVESTIGATE_TEMPLATE: &str = include_str!("../prompts/investigate.md");

pub fn investigation(topic: &str, local_data: &[String]) -> String {
    let mut prompt = INVESTIGATE_TEMPLATE.replace("{{TOPIC}}", topic);
    if sparse_checkpoints_enabled() {
        prompt.push_str(sparse_checkpoint_contract());
    }
    prompt.push_str(language_instruction(topic));
    if is_visual_request(topic) {
        prompt.push_str(
            "\n\nVisual delivery contract: the user asked for a visual artifact. If no local dataset is present, first discover and download a credible machine-readable source, then profile it and compute the rows with DuckDB. Do not invent values. The final artifact may be a self-contained SVG/PNG or self-contained HTML; choose the smallest format that satisfies the request. Loading a visual skill does not require a claim: omit claim_id for exploratory work, which produces a clearly labeled non-publishable draft; bind a supported recorded claim for publication and let the runtime grant verified only after source validation and deterministic computation replay. Never request or assert verified status yourself. Classify every recorded claim with claim_kind. Data calculations can verify descriptive, quantitative, comparative, and uncertainty claims, but cannot verify causal explanations, motives, policy effects, crisis/war drivers, or labels such as labour migration unless an explicit supporting source and a separate support-review contract exist; keep such interpretation out of publishable claims. Every DuckDB result that is ordered must use a total deterministic ORDER BY with secondary tie-breakers, so replay produces the same row sequence. For evidence-bound chart modules, inspect the computation schema and bind label_field and value_field(s) explicitly whenever the metric is not named value/y/amount; never let year/id/rank become a measure, and use two value_fields for a scatter or multiple fields for a multi-series trend. In the visual tool profile, use newsroom_lieflat_catalog followed by newsroom_lieflat_render as the pinned Lieflat Charts fallback when the richer renderer is unavailable. If no credible evidence can be acquired after bounded alternatives, report EVIDENCE_BLOCKED and do not produce a factual chart.\n",
        );
        if is_complex_visual_request(topic) {
            prompt.push_str(
            "\nComplex visual delivery contract: this is a multi-module infographic/publication request. After the story graph and individual visual critics pass, complete the required editorial preflight in order: newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements. Pass those four returned editorial/* artifact refs to newsroom_infographic_plan; never substitute a computation, visualization, or story-graph ref for them. Then use the complete newsroom_infographic_plan/lint/render/critic chain followed by newsroom_publication_plan → newsroom_publication_render → newsroom_publication_qa. The portable publication fallback is insufficient for this request and must not be used. The primary delivery must be an HTML page or one composed SVG; individual chart assets and JSON manifests are supporting files only. Preserve every explicitly requested evidence mode; do not replace a requested map, Sankey, trend, comparison, or network with prose because one attempted renderer rejects a form—route it to another qualified renderer. Compose complementary chart grammars into one visual argument and preserve hook/context/evidence/turn/resolution order. For editorial_grammar, provide the factual evidence features, cognitive goals, renderer capabilities, primary and supporting choices only; the tool computes candidate scores and decision records. newsroom_publication_qa saves full-page PNG screenshots at every declared viewport, so use it to satisfy desktop/mobile PNG requests. If the user requests PNG or screenshots, the run is incomplete until both desktop and mobile PNGs exist. Never report story.json or a manifest as the visual itself.\n",
            );
            prompt.push_str(&visual_mode_contract(topic));
        }
    }
    if !local_data.is_empty() {
        prompt
            .push_str("\nUser-supplied local data already available inside this investigation:\n");
        for path in local_data {
            prompt.push_str(&format!("- {path}\n"));
        }
        prompt.push_str("Use artifact_inventory if you need to inspect available files before querying them. Treat local files as evidence inputs and profile their schema before drawing conclusions.\n");
    }
    prompt
}

/// Opt-in research instrumentation.  It describes macro boundaries without
/// asking Pi to decide verification, publication, or evidence status.
pub fn sparse_checkpoints_enabled() -> bool {
    std::env::var("NEWSROOM_SPARSE_CHECKPOINTS")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn sparse_checkpoint_contract() -> &'static str {
    "\n\nExperimental macro checkpoint contract (instrumentation only): work is observed at RESEARCH, DESIGN, and PUBLISH boundaries. Keep semantic choices and tool work in the existing agent loop. The control plane remains authoritative for evidence, verification, completion, and publication gates; never claim a gate passed because a checkpoint was recorded.\n"
}

pub fn is_visual_request(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "chart",
        "plot",
        "graph",
        "visual",
        "visualization",
        "visualisation",
        "infographic",
        "dashboard",
        "map",
        "sankey",
        "svg",
        "png",
        "html",
        "图表",
        "可视化",
        "信息图",
        "图形",
        "图像",
        "图片",
        "数据新闻",
        "看板",
        "地图",
        "桑基",
        "网页",
    ]
    .iter()
    .any(|term| lower.contains(term))
}

pub fn is_complex_visual_request(text: &str) -> bool {
    if !is_visual_request(text) {
        return false;
    }
    let lower = text.to_lowercase();
    [
        "complex",
        "multi-module",
        "multi module",
        "interactive",
        "publication",
        "visual essay",
        "scrollytelling",
        "复杂",
        "多模块",
        "交互",
        "出版",
        "视觉文章",
        "复杂的信息图",
        "组合",
        "流向地图",
        "移动端",
        "静态回退",
        "self-contained html",
        "自包含 html",
    ]
    .iter()
    .any(|term| lower.contains(term))
}

pub fn requires_html(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("html") || lower.contains("网页") || lower.contains("web page")
}

pub fn requires_png(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("png") || lower.contains("截图") || lower.contains("screenshot")
}

/// Visual encoding families that the user explicitly asked the final
/// infographic to preserve.  These are module-level analytical grammars, not
/// project-level editorial grammars.
pub fn required_visual_modes(text: &str) -> Vec<(&'static str, &'static [&'static str])> {
    const SPATIAL: &[&str] = &["spatial"];
    const FLOW: &[&str] = &["flow"];
    const NETWORK: &[&str] = &["network"];
    const TREND: &[&str] = &["trend"];
    const COMPOSITION: &[&str] = &["composition"];
    const COMPOSITION_OR_FLOW: &[&str] = &["composition", "flow"];
    const COMPARISON: &[&str] = &["change", "benchmark"];

    let lower = text.to_lowercase();
    let mut required = Vec::new();
    let contains_any = |terms: &[&str]| terms.iter().any(|term| lower.contains(term));
    if contains_any(&["map", "地图", "gis", "geographic"]) {
        required.push(("map/spatial", SPATIAL));
    }
    if contains_any(&["sankey", "桑基"]) {
        required.push(("sankey/flow", FLOW));
    }
    if contains_any(&["network graph", "network diagram", "网络图", "关系网络"]) {
        required.push(("network", NETWORK));
    }
    if contains_any(&["trend", "趋势"]) {
        required.push(("trend", TREND));
    }
    if contains_any(&["composition", "breakdown", "构成", "组成"]) {
        // “Sankey composition” / “Sankey 构成” describes the question the
        // Sankey answers, not necessarily a second composition chart.  Keep a
        // standalone composition request strict, while allowing the adjacent
        // Sankey flow module to satisfy this coupled phrase.
        let sankey_composition = [
            "sankey composition",
            "sankey breakdown",
            "sankey 构成",
            "sankey 组成",
            "桑基构成",
            "桑基 构成",
            "桑基组成",
            "桑基 组成",
        ]
        .iter()
        .any(|term| lower.contains(term));
        required.push((
            "composition",
            if sankey_composition {
                COMPOSITION_OR_FLOW
            } else {
                COMPOSITION
            },
        ));
    }
    if contains_any(&[
        "comparison",
        "compare",
        "versus",
        " vs ",
        "对比",
        "比较",
        "then-now",
        "then now",
    ]) {
        required.push(("comparison", COMPARISON));
    }
    required
}

/// Repeatable visual-mode guidance used both for the initial request and for
/// completion-gate retries.  Retries must retain the original routing context;
/// otherwise a model can mistake an incompatible selection for a missing
/// renderer and silently downgrade the requested visual forms.
pub fn visual_mode_contract(text: &str) -> String {
    let modes = required_visual_modes(text);
    if modes.is_empty() {
        return String::new();
    }
    let mut contract = String::from(
        "System-extracted required visual modes for the final rendered infographic (release-blocking):\n",
    );
    for (label, grammars) in &modes {
        contract.push_str(&format!(
            "- {label}: include a rendered visual module with visual_grammar {}\n",
            grammars.join(" or ")
        ));
    }
    let labels = modes.iter().map(|(label, _)| *label).collect::<Vec<_>>();
    if labels.contains(&"map/spatial") && labels.contains(&"sankey/flow") {
        contract.push_str("For a route story combining spatial and flow modules, use primary editorial grammar ROUTE_SPINE when its evidence constraints pass. Add THEN_NOW when change/comparison is present; use the remaining supporting slot for SCALE_TRANSLATOR or SPECIMEN_GRID only when a separate composition module still needs coverage. An incompatibility from infographic lint means the current editorial grammar selection is wrong, not that the renderer lacks map or Sankey support. Change the project-level selection instead of relabeling, omitting, or converting a requested visual to an illustration. A regional Sankey can represent reciprocal migration by role-qualifying nodes (for example `origin:Asia` → `destination:Asia`); same geographic names on different source/destination layers are not self-loops.\n");
    }
    contract
}

/// Keep user-facing model prose in the language used for the investigation
/// goal. Tool names, IDs, paths and SQL remain machine-readable.
pub fn language_instruction(text: &str) -> &'static str {
    let cjk = text
        .chars()
        .filter(|character| ('\u{4e00}'..='\u{9fff}').contains(character))
        .count();
    if cjk >= 2 {
        "\n\nLanguage requirement: The user wrote in Chinese. Write all user-facing progress, findings, caveats, and the final dossier in Simplified Chinese. Keep proper nouns, source titles, URLs, tool names, artifact paths, IDs, SQL, and code exactly usable; do not switch to English unless the user asks.\n"
    } else {
        "\n\nLanguage requirement: Match the user's language in all user-facing progress, findings, caveats, and the final dossier. Keep proper nouns, source titles, URLs, tool names, artifact paths, IDs, SQL, and code exactly usable.\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visual_requests_get_data_acquisition_and_lieflat_contract() {
        assert!(is_visual_request("制作一个信息图"));
        let prompt = investigation("制作一个信息图", &[]);
        assert!(prompt.contains("newsroom_lieflat_catalog"));
        assert!(prompt.contains("EVIDENCE_BLOCKED"));
        assert!(prompt.contains("SVG/PNG or self-contained HTML"));
        assert!(prompt.contains("runtime grant verified"));
    }

    #[test]
    fn plain_text_request_does_not_add_visual_fallback() {
        assert!(!is_visual_request("总结这篇新闻"));
        assert!(!investigation("总结这篇新闻", &[]).contains("newsroom_lieflat_catalog"));
    }

    #[test]
    fn complex_visual_requests_get_publication_contract() {
        assert!(is_complex_visual_request(
            "制作复杂的多模块信息图并输出 HTML"
        ));
        let prompt = investigation("制作复杂的多模块信息图并输出 HTML", &[]);
        assert!(prompt.contains("newsroom_publication_qa"));
        assert!(prompt.contains("portable publication fallback is insufficient"));
        assert!(prompt.contains("JSON manifests are supporting files only"));
        assert!(!is_complex_visual_request("制作一个简单图表"));
        assert!(is_complex_visual_request(
            "组合世界流向地图并提供移动端 PNG"
        ));
        assert!(requires_html("制作自包含 HTML"));
        assert!(requires_png("输出桌面和移动 PNG"));
        let routed = investigation(
            "制作自包含 HTML 信息图，组合世界流向地图、地区构成和年代比较",
            &[],
        );
        assert!(routed
            .contains("map/spatial: include a rendered visual module with visual_grammar spatial"));
        assert!(routed.contains(
            "newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements"
        ));
        assert!(routed.contains(
            "composition: include a rendered visual module with visual_grammar composition"
        ));
        let routed_sankey = investigation("制作 HTML，组合世界地图、地区 Sankey 构成", &[]);
        assert!(routed_sankey.contains("origin:Asia"));
        assert!(routed_sankey.contains("ROUTE_SPINE"));
        assert!(routed_sankey.contains("current editorial grammar selection is wrong"));
    }

    #[test]
    fn explicit_visual_modes_are_extracted_without_conflating_editorial_grammar() {
        let modes = required_visual_modes("组合世界流向地图、地区构成和年代比较，并增加 Sankey");
        assert_eq!(
            modes.iter().map(|(label, _)| *label).collect::<Vec<_>>(),
            vec!["map/spatial", "sankey/flow", "composition", "comparison"]
        );
        assert_eq!(required_visual_modes("解释数据并制作信息图"), Vec::new());

        let coupled = required_visual_modes("组合世界地图、地区 Sankey 构成和年代比较");
        let composition = coupled
            .iter()
            .find(|(label, _)| *label == "composition")
            .expect("composition requirement");
        assert_eq!(composition.1, &["composition", "flow"]);

        let retry_contract = visual_mode_contract("世界地图、Sankey 和年代比较");
        assert!(retry_contract.contains("primary editorial grammar ROUTE_SPINE"));
        assert!(retry_contract.contains("Add THEN_NOW"));
    }
}
