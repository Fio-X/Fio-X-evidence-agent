const INVESTIGATE_TEMPLATE: &str = include_str!("../prompts/investigate.md");

pub fn investigation(topic: &str, local_data: &[String]) -> String {
    let mut prompt = INVESTIGATE_TEMPLATE.replace("{{TOPIC}}", topic);
    prompt.push_str(language_instruction(topic));
    if is_visual_request(topic) {
        prompt.push_str(
            "\n\nVisual delivery contract: the user asked for a visual artifact. If no local dataset is present, first discover and download a credible machine-readable source, then profile it and compute the rows with DuckDB. Do not invent values. The final artifact may be a self-contained SVG/PNG or self-contained HTML; choose the smallest format that satisfies the request. Loading a visual skill does not require a claim: for exploratory supplied-data work call newsroom_viz_plan with verification_mode=draft, which produces a clearly labeled non-publishable artifact; use verification_mode=verified plus a recorded claim for publication. Every DuckDB result that is ordered must use a total deterministic ORDER BY with secondary tie-breakers, so replay produces the same row sequence. For evidence-bound chart modules, inspect the computation schema and bind label_field and value_field(s) explicitly whenever the metric is not named value/y/amount; never let year/id/rank become a measure, and use two value_fields for a scatter or multiple fields for a multi-series trend. In the visual tool profile, use newsroom_lieflat_catalog followed by newsroom_lieflat_render as the pinned Lieflat Charts fallback when the richer renderer is unavailable. If no credible evidence can be acquired after bounded alternatives, report EVIDENCE_BLOCKED and do not produce a factual chart.\n",
        );
        if is_complex_visual_request(topic) {
            prompt.push_str(
            "\nComplex visual delivery contract: this is a multi-module infographic/publication request. Prefer newsroom_publication_plan → newsroom_publication_render → newsroom_publication_qa or a Lieflat report. The primary delivery must be an HTML page or one composed SVG; individual chart assets and JSON manifests are supporting files only. Compose complementary chart grammars into one visual argument (trend, comparison, ranking, relationship, resolution) instead of repeating one chart six times, and preserve hook/context/evidence/turn/resolution order. Never report story.json or a manifest as the visual itself.\n",
            );
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
    [
        "chart",
        "plot",
        "graph",
        "visual",
        "visualization",
        "visualisation",
        "infographic",
        "dashboard",
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
    ]
    .iter()
    .any(|term| lower.contains(term))
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
        assert!(prompt.contains("verification_mode=draft"));
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
        assert!(prompt.contains("JSON manifests are supporting files only"));
        assert!(!is_complex_visual_request("制作一个简单图表"));
    }
}
