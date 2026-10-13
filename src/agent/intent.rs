/// The deliverable is selected once from the original user goal. It is not a
/// model-facing planning step and is never reclassified from an assistant
/// message or a tool result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum VisualDeliverableIntent {
    #[default]
    None,
    SingleChart,
    DataReport,
    IntegratedExplainer,
    VisualEssay,
    BrowserPublication,
}

impl VisualDeliverableIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::SingleChart => "SingleChart",
            Self::DataReport => "DataReport",
            Self::IntegratedExplainer => "IntegratedExplainer",
            Self::VisualEssay => "VisualEssay",
            Self::BrowserPublication => "BrowserPublication",
        }
    }

    pub fn requires_story(self) -> bool {
        matches!(
            self,
            Self::DataReport
                | Self::IntegratedExplainer
                | Self::VisualEssay
                | Self::BrowserPublication
        )
    }
}

fn contains_any(goal: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| goal.contains(term))
}

/// Deterministic intent routing. Keep this vocabulary in sync with the CLI
/// contract and use the original goal only; no extra classifier/planner call
/// is made.
pub fn determine_visual_deliverable_intent(goal: &str) -> VisualDeliverableIntent {
    determine_visual_deliverable_intent_with(goal, intent_longform_enabled())
}

/// NEWSROOM_INTENT_LONGFORM=1 (exact "1", default off): a long information graphic is a report, not a single chart.
fn intent_longform_enabled() -> bool {
    longform_switch_value(std::env::var("NEWSROOM_INTENT_LONGFORM").ok().as_deref())
}

fn longform_switch_value(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Words that name a long, multi-panel information graphic. "信息长图" has no "信息图" run in it, so the report words below never see it.
const LONGFORM_TERMS: [&str; 5] = ["信息长图", "长图", "分镜", "图解", "一图读懂"];

fn determine_visual_deliverable_intent_with(goal: &str, longform: bool) -> VisualDeliverableIntent {
    let lower = goal.to_lowercase();
    let visual_essay = contains_any(
        &lower,
        &[
            "scrollytelling",
            "visual essay",
            "interactive story",
            "滚动叙事",
            "交互长文",
            "视觉文章",
        ],
    );
    let integrated = contains_any(
        &lower,
        &[
            "map",
            "spatial",
            "route",
            "anatomy",
            "mechanism",
            "explainer",
            "地图",
            "空间",
            "路线",
            "建筑",
            "剖面",
            "结构",
            "机制",
            "原理",
            "过程",
            "灾害演变",
        ],
    );
    let mut report = contains_any(
        &lower,
        &[
            "infographic report",
            "data story report",
            "data report",
            "visual report",
            "one-pager",
            "white paper",
            "brief",
            "infographic",
            "information graphic",
            "信息图",
            "数据新闻",
            "数据报告",
            "视觉报告",
            "调研报告",
            "研究报告",
            "年报",
            "月报",
            "白皮书",
            "海报",
        ],
    );
    let browser_explicit = contains_any(
        &lower,
        &[
            "interactive html",
            "browser publication",
            "browser report",
            "web report",
            "网页",
            "浏览器报告",
        ],
    );
    let chart = contains_any(
        &lower,
        &[
            "chart",
            "plot",
            "graph",
            "visualization",
            "visualisation",
            "柱状图",
            "折线图",
            "散点图",
            "图表",
            "图",
        ],
    );
    let browser = browser_explicit || (lower.contains("html") && !chart);
    let explicit_single = contains_any(
        &lower,
        &[
            "single chart",
            "one chart",
            "a chart",
            "one plot",
            "single plot",
            "单图",
            "一张图",
            "一个图",
            "一幅图",
        ],
    );

    // A user who names one chart ("一张图", "单图") still gets the single-chart route.
    if longform && !explicit_single && contains_any(&lower, &LONGFORM_TERMS) {
        report = true;
    }

    if visual_essay {
        VisualDeliverableIntent::VisualEssay
    } else if integrated {
        VisualDeliverableIntent::IntegratedExplainer
    } else if browser && !(explicit_single && !report) {
        VisualDeliverableIntent::BrowserPublication
    } else if report {
        VisualDeliverableIntent::DataReport
    } else if chart {
        VisualDeliverableIntent::SingleChart
    } else {
        VisualDeliverableIntent::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visual_intent_is_deterministic_and_report_strict() {
        assert_eq!(
            determine_visual_deliverable_intent("请做一张经济比较图表"),
            VisualDeliverableIntent::SingleChart
        );
        assert_eq!(
            determine_visual_deliverable_intent("调研主题并生成中文版数据新闻信息图报告"),
            VisualDeliverableIntent::DataReport
        );
        assert_eq!(
            determine_visual_deliverable_intent("制作机制解释网页 HTML 报告"),
            VisualDeliverableIntent::IntegratedExplainer
        );
        assert_eq!(
            determine_visual_deliverable_intent("写一篇 scrollytelling visual essay"),
            VisualDeliverableIntent::VisualEssay
        );
        assert_eq!(
            determine_visual_deliverable_intent("输出 browser publication HTML"),
            VisualDeliverableIntent::BrowserPublication
        );
        assert_eq!(
            determine_visual_deliverable_intent("summarize the latest climate news"),
            VisualDeliverableIntent::None
        );
    }

    #[test]
    fn longform_words_are_a_data_report_only_behind_the_switch() {
        let goal = "做一张信息长图：美国各州人口变化。用分镜讲：开头、原因、依据";
        // Off: "信息长图" has no "信息图" in it, so only "图" matches and the goal is refused as a single chart.
        assert_eq!(
            determine_visual_deliverable_intent_with(goal, false),
            VisualDeliverableIntent::SingleChart
        );
        for goal in [
            "做一张信息长图：美国各州人口变化",
            "做一个长图讲美国各州人口变化",
            "用分镜讲美国各州人口变化",
            "把美国各州人口变化做成图解",
            "一图读懂美国各州人口变化",
        ] {
            assert_eq!(
                determine_visual_deliverable_intent_with(goal, true),
                VisualDeliverableIntent::DataReport,
                "{goal}"
            );
        }
        // Off, the words alone mean nothing.
        assert_eq!(
            determine_visual_deliverable_intent_with("用分镜讲美国各州人口变化", false),
            VisualDeliverableIntent::None
        );
    }

    #[test]
    fn a_named_single_chart_stays_single_with_the_switch_on() {
        for goal in [
            "做一张图解：美国各州人口变化，只要一张图",
            "我要单图，图解美国各州人口变化",
            "一个图读懂美国各州人口变化",
        ] {
            assert_eq!(
                determine_visual_deliverable_intent_with(goal, true),
                VisualDeliverableIntent::SingleChart,
                "{goal}"
            );
        }
    }

    #[test]
    fn the_longform_switch_is_the_exact_value_one() {
        assert!(longform_switch_value(Some("1")));
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some(" 1"),
            Some("01"),
        ] {
            assert!(!longform_switch_value(value), "{value:?}");
        }
    }

    #[test]
    fn the_old_vocabulary_is_unchanged_with_the_switch_on() {
        for goal in [
            "请做一张经济比较图表",
            "调研主题并生成中文版数据新闻信息图报告",
            "制作机制解释网页 HTML 报告",
            "写一篇 scrollytelling visual essay",
            "输出 browser publication HTML",
            "summarize the latest climate news",
        ] {
            assert_eq!(
                determine_visual_deliverable_intent_with(goal, true),
                determine_visual_deliverable_intent_with(goal, false),
                "{goal}"
            );
        }
    }
}
