const INVESTIGATE_TEMPLATE: &str = include_str!("../prompts/investigate.md");

/// Build the investigation prompt using the requested classifier variant.
/// The split variant is intentionally opt-in; callers that do not select it
/// retain the established delivery-oriented classifier.
pub fn investigation_with_classifier(
    topic: &str,
    local_data: &[String],
    split_classifier: bool,
) -> String {
    let mut prompt = INVESTIGATE_TEMPLATE.replace("{{TOPIC}}", topic);
    prompt.push_str(language_instruction(topic));
    if is_visual_request(topic) {
        prompt.push_str(
            "\n\nVisual delivery contract: the user asked for a visual artifact. If no local dataset is present, first discover and download a credible machine-readable source, then profile it and compute the rows with DuckDB. Do not invent values. The final artifact may be a self-contained SVG/PNG or self-contained HTML; choose the smallest format that satisfies the request. Loading a visual skill does not require a claim: omit claim_id for exploratory work, which produces a clearly labeled non-publishable draft; bind a supported recorded claim for publication and let the runtime grant verified only after source validation and deterministic computation replay. Never request or assert verified status yourself. Classify every recorded claim with claim_kind. Data calculations can verify descriptive, quantitative, comparative, and uncertainty claims, but cannot verify causal explanations, motives, policy effects, crisis/war drivers, or labels such as labour migration unless an explicit supporting source and a separate support-review contract exist; keep such interpretation out of publishable claims. Every DuckDB result that is ordered must use a total deterministic ORDER BY with secondary tie-breakers, so replay produces the same row sequence. For evidence-bound chart modules, inspect the computation schema and bind label_field and value_field(s) explicitly whenever the metric is not named value/y/amount; never let year/id/rank become a measure, and use two value_fields for a scatter or multiple fields for a multi-series trend. In the visual tool profile, use newsroom_lieflat_catalog followed by newsroom_lieflat_render as the pinned Lieflat Charts fallback when the richer renderer is unavailable. If no credible evidence can be acquired after bounded alternatives, report EVIDENCE_BLOCKED and do not produce a factual chart.\n",
        );
        let complex = if split_classifier {
            is_complex_visual_request_split(topic)
        } else {
            is_complex_visual_request(topic)
        };
        if complex {
            prompt.push_str(
            "\nComplex visual delivery contract: this is a multi-module infographic/publication request. After the story graph and individual visual critics pass, complete the required editorial preflight in order: newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements. Pass those four returned editorial/* artifact refs to newsroom_infographic_plan; never substitute a computation, visualization, or story-graph ref for them. Then use the complete newsroom_infographic_plan/lint/render/critic chain followed by newsroom_infographic_preview → newsroom_infographic_vision_critic → newsroom_publication_plan → newsroom_publication_render → newsroom_publication_qa. The portable publication fallback is insufficient for this request and must not be used. A page from newsroom_lieflat_render is an unmeasured fallback as well: it carries no measured lint, critic or browser QA, never counts as the delivered page, and cannot complete this request. The primary delivery must be an HTML page or one composed SVG; individual chart assets and JSON manifests are supporting files only. Preserve every explicitly requested evidence mode; do not replace a requested map, Sankey, trend, comparison, or network with prose because one attempted renderer rejects a form—route it to another qualified renderer. Compose complementary chart grammars into one visual argument and preserve hook/context/evidence/turn/resolution order. For editorial_grammar, provide the factual evidence features, cognitive goals, renderer capabilities, primary and supporting choices only; the tool computes candidate scores and decision records. newsroom_publication_qa saves full-page PNG screenshots at every declared viewport, so use it to satisfy PNG or screenshot requests. If the user requests PNG or screenshots, the run is incomplete until a PNG exists for every declared viewport. Never report story.json or a manifest as the visual itself.\n",
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

pub fn is_visual_request(text: &str) -> bool {
    let lower = text.to_lowercase();
    mentions_long_image(&lower)
        || [
            "chart",
            "plot",
            "graph",
            "visual",
            "visualization",
            "visualisation",
            "infographic",
            "dashboard",
            "map",
            "choropleth",
            "cartogram",
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
            "流向图",
            "桑基",
            "网页",
        ]
        .iter()
        .any(|term| lower.contains(term))
}

/// Requests whose deliverable is a composed story page rather than one chart.
/// The heuristics here only ever add completion requirements: a request the
/// text does not flag can still be required to complete through the measured
/// chain when the run uses the visual-story profile.
pub fn is_complex_visual_request(text: &str) -> bool {
    if !is_visual_request(text) {
        return false;
    }
    let lower = text.to_lowercase();
    mentions_long_form_page(&lower)
        || [
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
            // 地图 covers every map phrasing (世界地图, 流向地图, 分级统计地图);
            // 流向地图 stays listed on its own so narrowing the bare word later
            // cannot silently drop flow maps.  The bare English "map" is not
            // listed: a single English map request is routed as a simple visual.
            "地图",
            "流向地图",
            "流向图",
            "flow map",
            "移动端",
            "静态回退",
            "static fallback",
            "self-contained html",
            "自包含 html",
        ]
        .iter()
        .any(|term| lower.contains(term))
}

pub fn has_multi_module_analytical_complexity(text: &str) -> bool {
    if !is_visual_request(text) {
        return false;
    }
    let lower = text.to_lowercase();
    let explicit = [
        "multi-module",
        "multi module",
        "scrollytelling",
        "visual essay",
        "多模块",
        "视觉文章",
    ]
    .iter()
    .any(|term| lower.contains(term))
        || mentions_long_form_page(&lower);
    explicit || required_visual_modes(text).len() >= 3
}

/// A long vertical story deliverable: 长图 / 信息长图 / 长图文 / 長圖 (long
/// image), 长页面 (long page) and the English long-form / long-scroll
/// phrasings.  Expects lower-cased text.
fn mentions_long_form_page(lower: &str) -> bool {
    mentions_long_image(lower)
        || [
            "长页面",
            "長頁面",
            "long infographic",
            "long-scroll",
            "long scroll",
        ]
        .iter()
        .any(|term| lower.contains(term))
        || ["long-form", "longform", "long form"]
            .iter()
            .any(|phrase| contains_phrase(lower, phrase))
}

/// Bare 长图 also sits inside unrelated words: 增长图 / 生长图 (growth chart)
/// and 长图表 / 长图片 / 长图像 / 长图形 / 长图例 (市长图片 "mayor photos",
/// 擅长图表 "good at charts").  Those neighbours are excluded; everything
/// else, including 做成长图 and 生成长图, is a long-image request.
fn mentions_long_image(lower: &str) -> bool {
    let chars: Vec<char> = lower.chars().collect();
    chars.windows(2).enumerate().any(|(index, pair)| {
        if !matches!(pair, ['长' | '長', '图' | '圖']) {
            return false;
        }
        let before = index.checked_sub(1).map(|position| chars[position]);
        let after = chars.get(index + 2).copied();
        !matches!(before, Some('增' | '生'))
            && !matches!(
                after,
                Some(
                    '表' | '片'
                        | '像'
                        | '形'
                        | '例'
                        | '示'
                        | '谱'
                        | '譜'
                        | '册'
                        | '冊'
                        | '标'
                        | '標'
                )
            )
    })
}

/// Whole-phrase match for ASCII phrases, so "long form" does not match
/// "long formula" and "long-form" does not match "long-format data" or
/// "longformer".
fn contains_phrase(lower: &str, phrase: &str) -> bool {
    lower.match_indices(phrase).any(|(start, matched)| {
        let before = lower[..start].chars().next_back();
        let after = lower[start + matched.len()..].chars().next();
        !before.is_some_and(|character| character.is_ascii_alphanumeric())
            && !after.is_some_and(|character| character.is_ascii_alphanumeric())
    })
}

pub fn is_complex_visual_request_split(text: &str) -> bool {
    is_visual_request(text) && has_multi_module_analytical_complexity(text)
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
        let prompt = investigation_with_classifier("制作一个信息图", &[], false);
        assert!(prompt.contains("newsroom_lieflat_catalog"));
        assert!(prompt.contains("EVIDENCE_BLOCKED"));
        assert!(prompt.contains("SVG/PNG or self-contained HTML"));
        assert!(prompt.contains("runtime grant verified"));
    }

    #[test]
    fn plain_text_request_does_not_add_visual_fallback() {
        assert!(!is_visual_request("总结这篇新闻"));
        assert!(!investigation_with_classifier("总结这篇新闻", &[], false)
            .contains("newsroom_lieflat_catalog"));
    }

    #[test]
    fn complex_visual_requests_get_publication_contract() {
        assert!(is_complex_visual_request(
            "制作复杂的多模块信息图并输出 HTML"
        ));
        let prompt = investigation_with_classifier("制作复杂的多模块信息图并输出 HTML", &[], false);
        assert!(prompt.contains("newsroom_publication_qa"));
        assert!(prompt.contains("portable publication fallback is insufficient"));
        assert!(prompt.contains("JSON manifests are supporting files only"));
        assert!(!is_complex_visual_request("制作一个简单图表"));
        assert!(is_complex_visual_request(
            "组合世界流向地图并提供移动端 PNG"
        ));
        assert!(requires_html("制作自包含 HTML"));
        assert!(requires_png("输出桌面和移动 PNG"));
        let routed = investigation_with_classifier(
            "制作自包含 HTML 信息图，组合世界流向地图、地区构成和年代比较",
            &[],
            false,
        );
        assert!(routed
            .contains("map/spatial: include a rendered visual module with visual_grammar spatial"));
        assert!(routed.contains(
            "newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements"
        ));
        assert!(routed.contains(
            "composition: include a rendered visual module with visual_grammar composition"
        ));
        let routed_sankey =
            investigation_with_classifier("制作 HTML，组合世界地图、地区 Sankey 构成", &[], false);
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

    #[test]
    fn split_classifier_separates_delivery_from_analytical_complexity() {
        assert!(requires_html(
            "self-contained HTML mobile interactive Sankey"
        ));
        assert!(!requires_png(
            "self-contained HTML mobile interactive Sankey"
        ));
        assert!(!is_complex_visual_request_split(
            "self-contained HTML mobile single chart"
        ));
        assert!(!is_complex_visual_request_split("interactive Sankey"));
        assert!(is_complex_visual_request_split(
            "map, Sankey, and trend as a scrollytelling story"
        ));
        assert!(is_complex_visual_request_split("map, Sankey, and trend"));
    }

    /// The goal of the production run behind issue #37, verbatim.
    const SCMP_LONG_IMAGE_GOAL: &str = "做一张南华早报（SCMP）风格的中文信息长图：一带一路倡议到2017年的进展——哪些国家参与、中国对沿线国家的投资和贸易规模、代表性项目在哪里。要有地图，数字必须来自可核实的数据。";

    #[test]
    fn scmp_long_image_goal_is_a_complex_visual_request() {
        assert!(is_visual_request(SCMP_LONG_IMAGE_GOAL));
        assert!(is_complex_visual_request(SCMP_LONG_IMAGE_GOAL));
        assert!(is_complex_visual_request_split(SCMP_LONG_IMAGE_GOAL));
        for split in [false, true] {
            let prompt = investigation_with_classifier(SCMP_LONG_IMAGE_GOAL, &[], split);
            assert!(prompt.contains("Complex visual delivery contract"));
            assert!(prompt.contains("newsroom_publication_qa"));
            assert!(prompt.contains(
                "map/spatial: include a rendered visual module with visual_grammar spatial"
            ));
            assert!(prompt.contains("unmeasured fallback"));
        }
        // The long-image wording alone is enough; the map keyword is not what
        // makes this goal complex.
        assert!(is_complex_visual_request(
            "做一张南华早报风格的中文信息长图，讲清楚一带一路的进展"
        ));
    }

    #[test]
    fn long_form_visual_requests_are_complex() {
        for goal in [
            "做一张长图",
            "做一张信息长图，讲清楚能源转型",
            "把调研结果做成长图",
            "生成长图文",
            "制作竖版長圖",
            "做一个长页面的图表专题",
            "SCMP style long infographic about shipping",
            "a long-form infographic on housing",
            "longform visual story with a chart",
            "long scroll infographic of trade routes",
            "a chart with a static fallback",
            "draw a flow map of grain trade",
            "画一张中国地图",
            "资金流向图",
        ] {
            assert!(is_visual_request(goal), "visual: {goal}");
            assert!(is_complex_visual_request(goal), "complex: {goal}");
        }
        for goal in ["做一张信息长图", "制作長圖海报", "long-form infographic"] {
            assert!(is_complex_visual_request_split(goal), "split: {goal}");
        }
    }

    #[test]
    fn long_image_keyword_ignores_words_that_merely_contain_it() {
        for goal in [
            "画一个GDP增长图表",
            "植物生长图表",
            "分析市长图片里的政策信号",
            "擅长图表制作",
            "展示长图例",
            "make a chart from long-format data",
            "chart the longformer attention scores",
            "chart the long formula results",
        ] {
            assert!(!is_complex_visual_request(goal), "complex: {goal}");
            assert!(!is_complex_visual_request_split(goal), "split: {goal}");
        }
        assert!(!is_visual_request("植物的增长图"));
        assert!(!is_visual_request("总结长篇报告"));
    }

    #[test]
    fn routing_keeps_single_english_maps_and_charts_simple() {
        // These are pinned by the routing matrix: only the Chinese bare 地图
        // and phrase-level English terms widen the baseline classifier.
        assert!(is_visual_request("make a map"));
        assert!(!is_complex_visual_request("make a map"));
        assert!(!is_complex_visual_request("make a chart"));
        assert!(is_visual_request("a choropleth of GDP per capita"));
        assert!(!is_complex_visual_request("a choropleth of GDP per capita"));
        assert!(is_visual_request("population cartogram"));
    }
}
