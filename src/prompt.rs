const INVESTIGATE_TEMPLATE: &str = include_str!("../prompts/investigate.md");

/// Build the investigation prompt using the requested classifier variant.
/// The split variant is intentionally opt-in; callers that do not select it
/// retain the established delivery-oriented classifier.
#[allow(dead_code)] // kept for scripts/test_visual_routing_cost.py, which includes this file
pub fn investigation_with_classifier(
    topic: &str,
    local_data: &[String],
    split_classifier: bool,
) -> String {
    investigation_with_options(
        topic,
        local_data,
        split_classifier,
        false,
        PromptSpeed::default(),
    )
}

/// Prompt additions that cut model turns. Every field of the struct's own `Default` is off (the environment turns on `numword_prompt` unless it is "0"),
/// and with all of them off the prompt is byte-identical to the baseline.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PromptSpeed {
    /// `NEWSROOM_SPEED_PARALLEL_HINTS=1`: tell the model to send independent
    /// tool calls in one assistant message.
    pub parallel_hints: bool,
    /// `NEWSROOM_SPEED_COMPUTE_BATCH=1`: tell the model to batch independent
    /// duckdb_query calls, then their record_claim calls, one batch per turn.
    pub compute_batch: bool,
    /// `NEWSROOM_SPEED_CHAIN_VIZ=1`: expose `newsroom_viz_chain`, which runs
    /// plan -> lint -> render -> critic in one call. The prompt adds a short
    /// paragraph saying the chain is the same chart path in one call, because
    /// the base prompt names the four steps as the only chart path.
    pub chain_viz: bool,
    /// `NEWSROOM_SPEED_CHAIN_INFOGRAPHIC=1`: expose `newsroom_infographic_chain`
    /// (plan -> lint -> render -> critic -> preview in one call). The prompt adds
    /// a short paragraph saying the chain is the same page path in one call.
    pub chain_infographic: bool,
    /// `NEWSROOM_SPEED_PREFLIGHT=1`: the runtime lists every unmet page-stage
    /// precondition at once and fills a reference only when exactly one
    /// existing artifact is bound to what the call already names. Tool
    /// guidance is added by the runtime; the base prompt does not change.
    pub preflight: bool,
    /// `NEWSROOM_SPEED_PLAN_EDIT=1`: a runtime-only tool changes a page plan's
    /// layout fields (module span/emphasis/priority/order, scene
    /// pattern/anchor/sidecars) without re-sending the plan. The edited plan
    /// passes every plan validation again. The tool carries its own guidance.
    pub plan_edit: bool,
    /// `NEWSROOM_SPEED_INLINE_CLAIM=1` (only with `chain_viz`): a chart's claim
    /// is passed to the chart tools as a template. The runtime fills the numbers
    /// from that chart's own SQL rows and records the claim through
    /// `record_claim`'s gates, so no `record_claim` turn comes first. The prompt
    /// adds a short paragraph saying so; tool guidance is added by the runtime.
    pub inline_claim: bool,
    /// `NEWSROOM_SPEED_PLAN_PATCH=1` (only with atomic writes): offer
    /// `newsroom_infographic_plan_patch`, which re-runs a refused plan call with
    /// an RFC 6902 patch. The tool carries its own guidance; the prompt does not change.
    pub plan_patch: bool,
    /// `NEWSROOM_SPEED_CHAIN_PATCH=1` (only with atomic writes and the page
    /// chain): offer `newsroom_infographic_chain_patch`, the same for the page chain.
    pub chain_patch: bool,
    /// `NEWSROOM_SPEED_REPORT_ALL=1`: the plan and the page chain report every
    /// independent grammar and hero problem together. Runtime only.
    pub report_all: bool,
    /// `NEWSROOM_SPEED_FILL_COPIED_REFS=1`: the runtime copies a reference the
    /// call left out when exactly one artifact can be meant. Runtime only.
    pub fill_copied_refs: bool,
    /// `NEWSROOM_SPEED_FIRST_TRY_TEXT=1`: extra rule text in some tool
    /// descriptions. Runtime only.
    pub first_try_text: bool,
    /// `NEWSROOM_SPEED_DATA_PROFILE=1`: the caller appends a program-measured
    /// profile of the local CSV files (columns, ranges, first rows) to the
    /// prompt. The prompt text here does not change; the profile is not evidence.
    pub data_profile: bool,
    /// `NEWSROOM_SPEED_RECIPES=1`: the caller appends at most one method recipe, picked by the
    /// program from the measured table shape, to the prompt. The prompt text here does not change.
    pub recipes: bool,
    /// `NEWSROOM_SPEED_COMPOSE_ANSWER=1`: the caller lets the CLI compose the
    /// closing text of a plain single-chart run. The prompt text does not change.
    pub compose_answer: bool,
    /// `NEWSROOM_SPEED_PLAN_PROGRESS=1`: the CLI writes routine plan progress to
    /// `plan-progress.json` from real tool events, and the parallel-tool paragraph is on with it.
    /// This module adds nothing itself; the runtime adds one tool guideline.
    pub plan_progress: bool,
    /// On unless `NEWSROOM_NUMWORD_PROMPT=0`: in complex visual requests the "say it in words" sentence is replaced by a rule that tells the model,
    /// before it writes, where a number word or digit is refused. No check changes; the refusal texts stay as they are.
    pub numword_prompt: bool,
    /// `NEWSROOM_LEAN_GATES=1`: the concept tournament, novelty check and asset plan are gone, so the complex visual contract no longer sends the model
    /// to those tools and the editorial_grammar sentence says the program derives most of it. Off: the contract is the same bytes as before.
    pub lean_gates: bool,
}

const PARALLEL_HINTS_PARAGRAPH: &str = "\n\nParallel tool calls: put tool calls that do not depend on each other in the same assistant message so they run together, for example several candidate sources to fetch_url or download_data, or newsroom_update_plan together with the first research calls. Only split calls across turns when a call's parameters come from an earlier result. The up to three fallback URLs above are independent and can be requested in one turn. Never send the same call twice in one turn.\n";

/// Adjustable: one sentence appended to the chart guidance in the visual delivery contract.
const EMPHASIS_GUIDANCE: &str =
    "\nWhen a chart's title names a category or series, put that exact value in highlight_values.";

/// Adjustable: appended after the complex visual delivery contract only.
const HERO_STAT_REFERENCE_GUIDANCE: &str = "\nGive each hero_stat a short reference point in its label or detail, such as the same measure in another period, the total, or the next-ranked item, using only numbers from the rows of the claim it cites; if those rows hold none, leave the reference out instead of adding a number.";

/// Adjustable: appended after the hero_stat guidance, complex visual requests only.
const NUMBER_REPEAT_GUIDANCE: &str = "\nWithin the page's own text (the dek, hero_stat labels and details, notes and body copy; chart labels do not count), state any one number at most twice; where a further mention would only restate it, say it in words or leave it out, and never add a new number to replace it.";

/// Replaces `NUMBER_REPEAT_GUIDANCE` when `numword_prompt` is on (the default): the old sentence told the model to "say it in words", which the checks refuse.
const NUMWORD_GUIDANCE: &str = "\nNumbers in text: a chart's conclusion sentence, the main chart's labels and description, and any text module or heading that quotes the source text may hold no digit and no number word (not \"two-thirds\", \"five\", \"三成\", \"百分之八十\"); write every number as a placeholder of the claim it comes from. Right: \"Coal fell to {last.share} of supply.\" Wrong: \"Coal fell to about two-thirds of supply.\" or \"Coal fell to 68% of supply.\" State any one number at most twice in the page's own text; where a further mention would only restate it, leave it out, and never add a new number to replace it.";

const CHAIN_VIZ_PARAGRAPH: &str = "\n\nChart chain: when `newsroom_viz_chain` is in your tool list it is the same chart path (plan, lint, render, critic) run in one call with the same parameters as `newsroom_viz_plan`; use it for each chart and send the chain calls for independent charts together. The step tools stay available: if the chain stops, follow its 'Call <tool> separately next' line.\n";

const CHAIN_INFOGRAPHIC_PARAGRAPH: &str = "\n\nPage chain: when `newsroom_infographic_chain` is in your tool list it runs the page plan, lint, render, critic and preview in one call with the same parameters as `newsroom_infographic_plan`; use it for the page. The step tools stay available: if the chain stops, follow its 'Call <tool> separately next' line.\n";

const INLINE_CLAIM_PARAGRAPH: &str = "\n\nChart claims: for a chart's own claim, pass `claim` and `claim_kind` to `newsroom_viz_chain` instead of calling `record_claim` first and passing `claim_id`. `claim` is the claim sentence with every number, years included, written as a placeholder that the runtime fills from that chart's own SQL rows; it then records the claim through the same source, computation and claim-support checks as `record_claim`, binds it to the chart, and writes the chart's takeaway and alt from it. A typed number in `claim` is refused. Pass `claim` or `claim_id`, never both. A claim that no chart carries is still recorded with `record_claim`.\n";

const COMPUTE_BATCH_PARAGRAPH: &str = "\n\nCompute batching: send independent duckdb_query calls together in one turn. A record_claim needs the computation_ref returned by its duckdb_query, so once every result is back, send all of the record_claim calls together in the next turn. Never put two identical SQL statements in one turn, and do not run fetch_url or download_data in the same turn as duckdb_query, because new files change what a computation reads. Repair a failing SQL statement on its own; do not merge the repair with other steps.\n";

/// Prompt sentences that name the Lieflat tools. They are dropped when those
/// tools are hidden from the run, so the prompt never points at a tool the
/// model cannot call.
const LIEFLAT_FALLBACK_SENTENCE: &str = " In the visual tool profile, use newsroom_lieflat_catalog followed by newsroom_lieflat_render as the pinned Lieflat Charts fallback when the richer renderer is unavailable.";
const LIEFLAT_UNMEASURED_SENTENCE: &str = " A page from newsroom_lieflat_render is an unmeasured fallback as well: it carries no measured lint, critic or browser QA, never counts as the delivered page, and cannot complete this request.";

/// The complex visual delivery contract. With `lean_gates` (`NEWSROOM_LEAN_GATES=1`) the concept tournament, novelty and asset-plan tools do not exist,
/// so the two sentences that name them change; everything else, and the whole text with the switch off, is the same bytes as before.
const COMPLEX_VISUAL_CONTRACT: &str =
    "\nComplex visual delivery contract: this is a multi-module infographic/publication request. After the story graph and individual visual critics pass, complete the required editorial preflight in order: newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements. Pass those four returned editorial/* artifact refs to newsroom_infographic_plan; never substitute a computation, visualization, or story-graph ref for them. Then use the complete newsroom_infographic_plan/lint/render/critic chain followed by newsroom_infographic_preview → newsroom_infographic_vision_critic → newsroom_publication_plan → newsroom_publication_render → newsroom_publication_qa. The portable publication fallback is insufficient for this request and must not be used. A page from newsroom_lieflat_render is an unmeasured fallback as well: it carries no measured lint, critic or browser QA, never counts as the delivered page, and cannot complete this request. The primary delivery must be an HTML page or one composed SVG; individual chart assets and JSON manifests are supporting files only. Preserve every explicitly requested evidence mode; do not replace a requested map, Sankey, trend, comparison, or network with prose because one attempted renderer rejects a form—route it to another qualified renderer. Compose complementary chart grammars into one visual argument and preserve hook/context/evidence/turn/resolution order. For editorial_grammar, provide the factual evidence features, cognitive goals, renderer capabilities, primary and supporting choices only; the tool computes candidate scores and decision records. newsroom_publication_qa saves full-page PNG screenshots at every declared viewport, so use it to satisfy PNG or screenshot requests. If the user requests PNG or screenshots, the run is incomplete until a PNG exists for every declared viewport. Never report story.json or a manifest as the visual itself.\n";

fn complex_visual_contract(lean_gates: bool) -> String {
    if !lean_gates {
        return COMPLEX_VISUAL_CONTRACT.to_string();
    }
    COMPLEX_VISUAL_CONTRACT
        .replace(
            "complete the required editorial preflight in order: newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements. Pass those four returned editorial/* artifact refs to newsroom_infographic_plan; never substitute a computation, visualization, or story-graph ref for them.",
            "complete the required editorial preflight: newsroom_editorial_discovery. Pass its returned editorial/* artifact ref to newsroom_infographic_plan as editorial_discovery_ref; never substitute a computation, visualization, or story-graph ref for it.",
        )
        .replace(
            "For editorial_grammar, provide the factual evidence features, cognitive goals, renderer capabilities, primary and supporting choices only; the tool computes candidate scores and decision records.",
            "For editorial_grammar, give primary and supporting only (both optional); the tool derives the evidence features, cognitive goals and renderer capabilities and computes candidate scores and decision records.",
        )
}

/// `hide_lieflat` mirrors the tool surface of the run: when the Lieflat tools
/// are hidden the prompt must not name them either.
pub fn investigation_with_options(
    topic: &str,
    local_data: &[String],
    split_classifier: bool,
    hide_lieflat: bool,
    speed: PromptSpeed,
) -> String {
    let mut prompt = INVESTIGATE_TEMPLATE.replace("{{TOPIC}}", topic);
    prompt.push_str(language_instruction(topic));
    if speed.parallel_hints {
        prompt.push_str(PARALLEL_HINTS_PARAGRAPH);
    }
    if speed.compute_batch {
        prompt.push_str(COMPUTE_BATCH_PARAGRAPH);
    }
    if speed.chain_viz {
        prompt.push_str(CHAIN_VIZ_PARAGRAPH);
        if speed.inline_claim {
            prompt.push_str(INLINE_CLAIM_PARAGRAPH);
        }
    }
    if speed.chain_infographic {
        prompt.push_str(CHAIN_INFOGRAPHIC_PARAGRAPH);
    }
    if is_visual_request(topic) {
        prompt.push_str(
            "\n\nVisual delivery contract: the user asked for a visual artifact. If no local dataset is present, first discover and download a credible machine-readable source, then profile it and compute the rows with DuckDB. Do not invent values. The final artifact may be a self-contained SVG/PNG or self-contained HTML; choose the smallest format that satisfies the request. Loading a visual skill does not require a claim: omit claim_id for exploratory work, which produces a clearly labeled non-publishable draft; bind a supported recorded claim for publication and let the runtime grant verified only after source validation and deterministic computation replay. Never request or assert verified status yourself. Classify every recorded claim with claim_kind. Data calculations can verify descriptive, quantitative, comparative, and uncertainty claims, but cannot verify causal explanations, motives, policy effects, crisis/war drivers, or labels such as labour migration unless an explicit supporting source and a separate support-review contract exist; keep such interpretation out of publishable claims. Every DuckDB result that is ordered must use a total deterministic ORDER BY with secondary tie-breakers, so replay produces the same row sequence. For evidence-bound chart modules, inspect the computation schema and bind label_field and value_field(s) explicitly whenever the metric is not named value/y/amount; never let year/id/rank become a measure, and use two value_fields for a scatter or multiple fields for a multi-series trend. In the visual tool profile, use newsroom_lieflat_catalog followed by newsroom_lieflat_render as the pinned Lieflat Charts fallback when the richer renderer is unavailable. If no credible evidence can be acquired after bounded alternatives, report EVIDENCE_BLOCKED and do not produce a factual chart.\n",
        );
        prompt.push_str(EMPHASIS_GUIDANCE);
        prompt.push_str(column_chart_notice(topic, column_chart_notice_on()));
        let complex = if split_classifier {
            is_complex_visual_request_split(topic)
        } else {
            is_complex_visual_request(topic)
        };
        if complex {
            prompt.push_str(&complex_visual_contract(speed.lean_gates));
            prompt.push_str(HERO_STAT_REFERENCE_GUIDANCE);
            prompt.push_str(if speed.numword_prompt {
                NUMWORD_GUIDANCE
            } else {
                NUMBER_REPEAT_GUIDANCE
            });
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
    if hide_lieflat {
        prompt = prompt
            .replace(LIEFLAT_FALLBACK_SENTENCE, "")
            .replace(LIEFLAT_UNMEASURED_SENTENCE, "");
    }
    prompt
}

pub fn is_visual_request(text: &str) -> bool {
    let lower = text.to_lowercase();
    mentions_long_image(&lower)
        || mentions_chinese_chart_name(&lower)
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

/// `NEWSROOM_ONE_CHART_ROUTING`: on unless the value is exactly `0`.
const ONE_CHART_ROUTING_ENV: &str = "NEWSROOM_ONE_CHART_ROUTING";

fn one_chart_routing_on() -> bool {
    std::env::var(ONE_CHART_ROUTING_ENV).ok().as_deref() != Some("0")
}

/// Explicit one-chart wording. The list is narrow on purpose.
const ONE_CHART_PHRASES: [&str; 4] = ["只要一张图", "只要一个图", "不要第二张图", "一张图就够"];
const ONE_CHART_PHRASES_EN: [&str; 4] = [
    "one chart only",
    "just one chart",
    "no second chart",
    "no second charts",
];

fn mentions_one_chart_only(text: &str) -> bool {
    let lower = text.to_lowercase();
    // "只要一个图标" / "不只要一张图" are not one-chart wording: skip a phrase that runs into a longer
    // word (图标, 图例, 图案, 图层) or is negated right before it.
    let chinese = ONE_CHART_PHRASES.iter().any(|phrase| {
        lower.match_indices(phrase).any(|(at, _)| {
            let before = lower[..at].trim_end();
            let after = lower[at + phrase.len()..].chars().next();
            !["不", "不是", "并非", "而非"]
                .iter()
                .any(|neg| before.ends_with(neg))
                && !matches!(after, Some('标' | '例' | '案' | '层' | '像'))
        })
    });
    let english = ONE_CHART_PHRASES_EN
        .iter()
        .any(|phrase| contains_phrase(&lower, phrase))
        && !contains_phrase(&lower, "not enough")
        && !contains_phrase(&lower, "not just one chart");
    chinese || english
}

/// The request itself says one chart is wanted and the routing switch is on: the request goes to
/// the single-chart flow even when it also names a page ("长图"). Only the request text is read; nothing
/// the model writes can set this.
fn asks_for_one_chart(text: &str) -> bool {
    // Two or more chart modes named in the same request (a map and a Sankey) are the more specific
    // instruction: the single-chart flow neither renders nor checks them (the mode gaps in
    // investigate.rs run only inside the complex chain), so such a request keeps the page route.
    one_chart_routing_on() && mentions_one_chart_only(text) && required_visual_modes(text).len() < 2
}

/// Requests whose deliverable is a composed story page rather than one chart.
/// The heuristics here only ever add completion requirements: a request the
/// text does not flag can still be required to complete through the measured
/// chain when the run uses the visual-story profile.
pub fn is_complex_visual_request(text: &str) -> bool {
    if !is_visual_request(text) || asks_for_one_chart(text) {
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
            // A single map request ("画一张各省GDP地图") stays on the simple
            // visual profile, symmetric with the bare English "map".  Flow
            // maps are still listed explicitly as complex.
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
    if !is_visual_request(text) || asks_for_one_chart(text) {
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

/// Chinese names of chart forms. Sources: the plan tool's chart_type values and
/// viz spec schema (line, scatter, heatmap, waffle, dumbbell, slope, treemap, stacked
/// bar), plus the pie, donut, area and bar forms a Chinese request names (饼图,
/// 圆环图, 面积图, 柱状图, 柱形图, 条形图). A name that is really the start of 图案
/// (pattern) or 图标 (icon) is not a chart; 案例, 标题, 标签 and the like still
/// are. Expects lower-cased text.
fn mentions_chinese_chart_name(lower: &str) -> bool {
    const NAMES: &[&str] = &[
        "折线图",
        "柱状图",
        "柱形图",
        "条形图",
        "饼图",
        "圆环图",
        "散点图",
        "热力图",
        "面积图",
        "矩形树图",
        "华夫图",
        "哑铃图",
        "斜率图",
    ];
    mentions_chart_named(lower, NAMES)
}

/// Whether any of `names` (each ending in 图) is a chart in `lower`, with the 图案 / 图标 exception of `mentions_chinese_chart_name`.
fn mentions_chart_named(lower: &str, names: &[&str]) -> bool {
    // what follows the name's 图 when the word is 图案 or 图标 instead
    const NOT_CHART: &[&str] = &["案", "标"];
    // continuations that keep the chart reading (案例, 标题, 标注, 标签, 标准, 标识)
    const STILL_CHART: &[&str] = &[
        "案例", "标题", "标注", "标签", "标准", "标识", "标明", "标尺", "标线",
    ];
    names.iter().any(|name| {
        lower.match_indices(name).any(|(at, _)| {
            let rest = &lower[at + name.len()..];
            let icon_or_pattern = NOT_CHART.iter().any(|w| rest.starts_with(w))
                && !STILL_CHART.iter().any(|w| rest.starts_with(w));
            !icon_or_pattern
        })
    })
}

/// What the model is told when the request asks for a column chart: only horizontal bar forms exist.
pub const COLUMN_CHART_NOTICE: &str = "\n\nOnly horizontal bar forms exist. If the user asked for a column chart (柱状图/柱形图), draw the horizontal bar form and say in the answer that vertical columns are not available yet.\n";

/// The request text names a column chart: 柱状图 / 柱形图, or the English column chart / column graph / vertical bar chart. 条形图 alone does not
/// (a bar chart is the horizontal form). The program reads this from the request text only; model text never sets it.
pub fn mentions_column_chart(text: &str) -> bool {
    let lower = text.to_lowercase();
    mentions_chart_named(&lower, &["柱状图", "柱形图"])
        || [
            "column chart",
            "column charts",
            "column graph",
            "column graphs",
            "vertical bar chart",
            "vertical bar charts",
        ]
        .iter()
        .any(|phrase| contains_phrase(&lower, phrase))
}

/// Default on (only the exact "0" turns it off): a request that names a column chart gets the notice that only horizontal bars exist.
pub const COLUMN_CHART_NOTICE_ENV: &str = "NEWSROOM_COLUMN_CHART_NOTICE";

pub fn column_chart_notice_on() -> bool {
    std::env::var(COLUMN_CHART_NOTICE_ENV).ok().as_deref() != Some("0")
}

/// `COLUMN_CHART_NOTICE` when `enabled` and the request names a column chart, else nothing (the text is then byte-identical to before).
pub fn column_chart_notice(text: &str, enabled: bool) -> &'static str {
    if enabled && mentions_column_chart(text) {
        COLUMN_CHART_NOTICE
    } else {
        ""
    }
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
    // Chinese terms and the space-padded " vs " stay plain substrings; other
    // English terms match as whole words so "GISTEMP" does not contain "gis"
    // and "treemap" does not contain "map".  Inflections are listed explicitly.
    let contains_any = |terms: &[&str]| {
        terms.iter().any(|term| {
            if !term.is_ascii() || term.starts_with(' ') || term.ends_with(' ') {
                lower.contains(term)
            } else {
                contains_phrase(&lower, term)
            }
        })
    };
    if contains_any(&[
        "map",
        "maps",
        "basemap",
        "basemaps",
        "地图",
        "gis",
        "geographic",
        "geographical",
        "geographically",
    ]) {
        required.push(("map/spatial", SPATIAL));
    }
    if contains_any(&["sankey", "sankeys", "桑基"]) {
        required.push(("sankey/flow", FLOW));
    }
    if contains_any(&[
        "network graph",
        "network graphs",
        "network diagram",
        "network diagrams",
        "网络图",
        "关系网络",
    ]) {
        required.push(("network", NETWORK));
    }
    if contains_any(&[
        "trend",
        "trends",
        "trending",
        "trendline",
        "trendlines",
        "趋势",
    ]) {
        required.push(("trend", TREND));
    }
    if contains_any(&[
        "composition",
        "compositions",
        "breakdown",
        "breakdowns",
        "构成",
        "组成",
    ]) {
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
        "comparisons",
        "compare",
        "compares",
        "compared",
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
    fn chain_switches_add_only_their_own_paragraph() {
        let off =
            investigation_with_options("制作一个信息图", &[], false, false, PromptSpeed::default());
        let viz = PromptSpeed {
            chain_viz: true,
            ..PromptSpeed::default()
        };
        let page = PromptSpeed {
            chain_infographic: true,
            ..PromptSpeed::default()
        };
        let with_viz = investigation_with_options("制作一个信息图", &[], false, false, viz);
        let with_page = investigation_with_options("制作一个信息图", &[], false, false, page);
        assert_eq!(with_viz.len(), off.len() + CHAIN_VIZ_PARAGRAPH.len());
        assert_eq!(
            with_page.len(),
            off.len() + CHAIN_INFOGRAPHIC_PARAGRAPH.len()
        );
        assert!(
            with_viz.contains("newsroom_viz_chain")
                && !with_viz.contains("newsroom_infographic_chain")
        );
        assert!(
            with_page.contains("newsroom_infographic_chain")
                && !with_page.contains("newsroom_viz_chain")
        );
        assert!(off.contains("newsroom_viz_plan") && !off.contains("_chain"));
    }

    #[test]
    fn inline_claim_adds_one_paragraph_only_with_the_chart_chain() {
        let chain = PromptSpeed {
            chain_viz: true,
            ..PromptSpeed::default()
        };
        let both = PromptSpeed {
            chain_viz: true,
            inline_claim: true,
            ..PromptSpeed::default()
        };
        let alone = PromptSpeed {
            inline_claim: true,
            ..PromptSpeed::default()
        };
        for topic in [
            "summarize the source",
            "制作一个信息图",
            SCMP_LONG_IMAGE_GOAL,
        ] {
            for split in [false, true] {
                let off =
                    investigation_with_options(topic, &[], split, false, PromptSpeed::default());
                let with_chain = investigation_with_options(topic, &[], split, false, chain);
                let with_both = investigation_with_options(topic, &[], split, false, both);
                let without_chain = investigation_with_options(topic, &[], split, false, alone);
                assert_eq!(
                    without_chain, off,
                    "{topic}: inline claim alone changes nothing"
                );
                assert_eq!(
                    with_both.len(),
                    with_chain.len() + INLINE_CLAIM_PARAGRAPH.len(),
                    "{topic}"
                );
                assert_eq!(
                    with_both.replacen(INLINE_CLAIM_PARAGRAPH, "", 1),
                    with_chain,
                    "{topic}"
                );
                assert!(with_both.contains("`claim_kind`") && !with_chain.contains("`claim_kind`"));
                assert!(with_both.contains("still recorded with `record_claim`"));
            }
        }
    }

    #[test]
    fn hero_stat_reference_guidance_only_for_complex_visual_requests() {
        for split in [false, true] {
            let prompt = |topic: &str| investigation_with_classifier(topic, &[], split);
            let complex = prompt(SCMP_LONG_IMAGE_GOAL);
            assert!(complex.contains(HERO_STAT_REFERENCE_GUIDANCE));
            assert!(complex.contains(EMPHASIS_GUIDANCE));
            for topic in ["制作一个信息图", "make a chart", "summarize the source"] {
                if is_complex_visual_request(topic) {
                    continue;
                }
                assert!(
                    !prompt(topic).contains(HERO_STAT_REFERENCE_GUIDANCE),
                    "{topic}"
                );
            }
        }
    }

    #[test]
    fn lean_gates_names_no_removed_tool_and_changes_only_two_sentences() {
        let off = investigation_with_classifier(SCMP_LONG_IMAGE_GOAL, &[], false);
        let lean = investigation_with_options(
            SCMP_LONG_IMAGE_GOAL,
            &[],
            false,
            false,
            PromptSpeed {
                lean_gates: true,
                ..PromptSpeed::default()
            },
        );
        // off: the old chain of four tools and the old grammar sentence, and the whole contract is the constant as written
        assert!(off.contains("newsroom_editorial_discovery → newsroom_visual_concepts → newsroom_semantic_novelty → newsroom_asset_requirements"));
        assert!(off.contains("provide the factual evidence features, cognitive goals, renderer capabilities, primary and supporting choices only"));
        assert!(off.contains(COMPLEX_VISUAL_CONTRACT));
        // lean: none of the removed tools, and the two sentences say what is true now
        for removed in [
            "newsroom_visual_concepts",
            "newsroom_semantic_novelty",
            "newsroom_asset_requirements",
        ] {
            assert!(!lean.contains(removed), "{removed}");
        }
        assert!(lean
            .contains("complete the required editorial preflight: newsroom_editorial_discovery."));
        assert!(lean.contains("give primary and supporting only (both optional)"));
        // the rest of the prompt is untouched
        assert_eq!(
            lean.replacen(&complex_visual_contract(true), "", 1),
            off.replacen(COMPLEX_VISUAL_CONTRACT, "", 1)
        );
        // a simple request has no such contract, so the switch changes nothing
        let simple_off = investigation_with_classifier("make a chart", &[], false);
        let simple_lean = investigation_with_options(
            "make a chart",
            &[],
            false,
            false,
            PromptSpeed {
                lean_gates: true,
                ..PromptSpeed::default()
            },
        );
        assert_eq!(simple_off, simple_lean);
    }

    #[test]
    fn numword_prompt_replaces_the_in_words_sentence_only_when_on() {
        let off = investigation_with_classifier(SCMP_LONG_IMAGE_GOAL, &[], false);
        let on = investigation_with_options(
            SCMP_LONG_IMAGE_GOAL,
            &[],
            false,
            false,
            PromptSpeed {
                numword_prompt: true,
                ..PromptSpeed::default()
            },
        );
        // off: unchanged, still the old sentence
        assert!(off.contains(NUMBER_REPEAT_GUIDANCE) && off.contains("say it in words"));
        assert!(!off.contains(NUMWORD_GUIDANCE));
        // on: the rule, a right and a wrong example, and no "in words" advice left
        assert!(on.contains(NUMWORD_GUIDANCE));
        assert!(!on.contains(NUMBER_REPEAT_GUIDANCE));
        assert!(!on.contains("say it in words"));
        assert!(on.contains("Right:") && on.contains("Wrong:"));
        // the rest of the prompt is untouched
        assert_eq!(
            off.replacen(NUMBER_REPEAT_GUIDANCE, "", 1),
            on.replacen(NUMWORD_GUIDANCE, "", 1)
        );
        // simple requests never get it
        let simple = investigation_with_options(
            "make a chart",
            &[],
            false,
            false,
            PromptSpeed {
                numword_prompt: true,
                ..PromptSpeed::default()
            },
        );
        assert!(!simple.contains(NUMWORD_GUIDANCE));
    }

    #[test]
    fn number_repeat_guidance_only_for_complex_visual_requests() {
        for split in [false, true] {
            let prompt = |topic: &str| investigation_with_classifier(topic, &[], split);
            let complex = prompt(SCMP_LONG_IMAGE_GOAL);
            assert!(complex.contains(NUMBER_REPEAT_GUIDANCE));
            // The sentence is one contiguous insertion: with it removed, the
            // rest of the complex prompt (including the hero_stat guidance
            // right before it) is untouched.
            let without = complex.replacen(NUMBER_REPEAT_GUIDANCE, "", 1);
            assert_eq!(without.len() + NUMBER_REPEAT_GUIDANCE.len(), complex.len());
            assert!(without.contains(HERO_STAT_REFERENCE_GUIDANCE));
            assert!(!without.contains("at most twice"));
            for topic in ["制作一个信息图", "make a chart", "summarize the source"] {
                if is_complex_visual_request(topic) {
                    continue;
                }
                assert!(!prompt(topic).contains(NUMBER_REPEAT_GUIDANCE), "{topic}");
            }
        }
    }

    #[test]
    fn parallel_hints_only_insert_one_paragraph_when_on() {
        let on = PromptSpeed {
            parallel_hints: true,
            ..PromptSpeed::default()
        };
        for topic in [
            "summarize the source",
            "制作一个信息图",
            SCMP_LONG_IMAGE_GOAL,
        ] {
            for split in [false, true] {
                let off =
                    investigation_with_options(topic, &[], split, false, PromptSpeed::default());
                assert_eq!(off, investigation_with_classifier(topic, &[], split));
                let hinted = investigation_with_options(topic, &[], split, false, on);
                assert_eq!(
                    hinted.len(),
                    off.len() + PARALLEL_HINTS_PARAGRAPH.len(),
                    "{topic}"
                );
                assert_eq!(
                    hinted.replacen(PARALLEL_HINTS_PARAGRAPH, "", 1),
                    off,
                    "{topic}"
                );
                assert!(hinted.contains("same assistant message"));
                assert!(!off.contains("same assistant message"));
            }
        }
    }

    #[test]
    fn compute_batch_is_a_separate_paragraph_and_composes_with_parallel_hints() {
        let batch = PromptSpeed {
            compute_batch: true,
            ..PromptSpeed::default()
        };
        let both = PromptSpeed {
            parallel_hints: true,
            compute_batch: true,
            ..PromptSpeed::default()
        };
        for topic in ["summarize the source", SCMP_LONG_IMAGE_GOAL] {
            let off = investigation_with_classifier(topic, &[], false);
            let only = investigation_with_options(topic, &[], false, false, batch);
            assert_eq!(
                only.replacen(COMPUTE_BATCH_PARAGRAPH, "", 1),
                off,
                "{topic}"
            );
            assert!(only.contains("Compute batching") && !only.contains("Parallel tool calls"));
            let all = investigation_with_options(topic, &[], false, false, both);
            let stripped = all.replacen(PARALLEL_HINTS_PARAGRAPH, "", 1).replacen(
                COMPUTE_BATCH_PARAGRAPH,
                "",
                1,
            );
            assert_eq!(stripped, off, "{topic}");
        }
    }

    #[test]
    fn hidden_lieflat_tools_are_not_named_in_visual_prompts() {
        for topic in [
            "制作一个信息图",
            "制作复杂的多模块信息图并输出 HTML",
            SCMP_LONG_IMAGE_GOAL,
        ] {
            for split in [false, true] {
                let shown =
                    investigation_with_options(topic, &[], split, false, PromptSpeed::default());
                assert_eq!(shown, investigation_with_classifier(topic, &[], split));
                let hidden =
                    investigation_with_options(topic, &[], split, true, PromptSpeed::default());
                assert!(!hidden.contains("newsroom_lieflat_"), "{topic}");
                assert!(!hidden.contains("Lieflat"), "{topic}");
                assert!(hidden.len() < shown.len());
            }
        }
        let complex = investigation_with_options(
            SCMP_LONG_IMAGE_GOAL,
            &[],
            false,
            true,
            PromptSpeed::default(),
        );
        assert!(complex.contains("newsroom_infographic_plan"));
        assert!(complex.contains("newsroom_publication_qa"));
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

    fn mode_labels(text: &str) -> Vec<&'static str> {
        required_visual_modes(text)
            .iter()
            .map(|(label, _)| *label)
            .collect()
    }

    #[test]
    fn english_visual_mode_terms_do_not_match_inside_longer_words() {
        for word in [
            "GISTEMP",
            "logistics",
            "registry",
            "legislation",
            "treemap",
            "heatmap",
            "roadmap",
            "bitmap",
        ] {
            assert_eq!(
                mode_labels(&format!("Make a chart from the {word} data")),
                Vec::<&str>::new(),
                "{word} must not trigger a visual mode"
            );
        }
        assert_eq!(
            mode_labels(
                "用本地 NASA GISTEMP 气温距平数据做一张图，说明 1980–2025 年全球气温怎么变化。"
            ),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn english_visual_mode_terms_keep_words_and_inflections() {
        for (text, label) in [
            ("draw a map of GDP", "map/spatial"),
            ("draw maps of GDP", "map/spatial"),
            ("a GIS layer", "map/spatial"),
            ("(GIS)", "map/spatial"),
            ("geographic spread", "map/spatial"),
            ("geographical spread", "map/spatial"),
            ("show the trend", "trend"),
            ("show trends", "trend"),
            ("trending upward", "trend"),
            ("a trendline of GDP", "trend"),
            ("draw trendlines", "trend"),
            ("a basemap of Europe", "map/spatial"),
            ("two basemaps", "map/spatial"),
            ("compared with 2000", "comparison"),
            ("comparisons by year", "comparison"),
            ("compare 2000 and 2020", "comparison"),
            ("a vs b", "comparison"),
            ("sankey breakdowns", "composition"),
        ] {
            assert!(
                mode_labels(text).contains(&label),
                "{text:?} should still require {label}"
            );
        }
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
    fn chinese_chart_form_names_route_to_the_visual_profile() {
        for name in [
            "折线图",
            "柱状图",
            "柱形图",
            "条形图",
            "饼图",
            "圆环图",
            "散点图",
            "热力图",
            "面积图",
            "矩形树图",
            "华夫图",
            "哑铃图",
            "斜率图",
        ] {
            let request = format!("用这份数据画一个{name}");
            assert!(is_visual_request(&request), "visual: {request}");
            // a plain form name stays on the simple visual profile
            assert!(
                !is_complex_visual_request(&request),
                "not complex: {request}"
            );
            assert!(
                !is_complex_visual_request_split(&request),
                "not split: {request}"
            );
        }
        // 图 inside other words, and a pattern or an icon, are not chart requests
        for text in [
            "他在图书馆读了这篇新闻",
            "总结这篇关于意图的文章",
            "植物的增长图",
            "设计柱状图案的壁纸",
            "做一个热力图标",
            "吉他和弦图怎么按",
        ] {
            assert!(!is_visual_request(text), "not visual: {text}");
        }
        // a chart name followed by a title, label, note or case is still a chart request
        for text in [
            "给折线图标题加粗",
            "饼图标签放外面",
            "散点图案例有哪些",
            "热力图标注数字",
        ] {
            assert!(is_visual_request(text), "visual: {text}");
        }
    }

    #[test]
    fn routing_keeps_single_english_maps_and_charts_simple() {
        // These are pinned by the routing matrix: only phrase-level terms
        // (flow map, 长图, ...) widen the baseline classifier; a single map,
        // English or Chinese, stays simple.
        assert!(is_visual_request("画一张各省GDP地图"));
        assert!(!is_complex_visual_request("画一张各省GDP地图"));
        assert!(!is_complex_visual_request("画一张中国地图"));
        assert!(is_complex_visual_request("画一张流向地图"));
        assert!(is_complex_visual_request("画一张流向图"));
        assert!(is_visual_request("make a map"));
        assert!(!is_complex_visual_request("make a map"));
        assert!(!is_complex_visual_request("make a chart"));
        assert!(is_visual_request("a choropleth of GDP per capita"));
        assert!(!is_complex_visual_request("a choropleth of GDP per capita"));
        assert!(is_visual_request("population cartogram"));
    }

    /// Run `body` with `NEWSROOM_ONE_CHART_ROUTING` set to `value` (None: unset); the old value is put back.
    fn with_one_chart_switch(value: Option<&str>, body: impl FnOnce()) {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        struct Restore(Option<String>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(v) => std::env::set_var(ONE_CHART_ROUTING_ENV, v),
                    None => std::env::remove_var(ONE_CHART_ROUTING_ENV),
                }
            }
        }
        let _restore = Restore(std::env::var(ONE_CHART_ROUTING_ENV).ok());
        match value {
            Some(v) => std::env::set_var(ONE_CHART_ROUTING_ENV, v),
            None => std::env::remove_var(ONE_CHART_ROUTING_ENV),
        }
        body();
    }

    const ONE_CHART_REQUESTS: [&str; 7] = [
        "画一张全球气温折线图，只要一张图",
        "画全球气温图表，只要一个图",
        "画全球气温图表，不要第二张图",
        "画全球气温图表，一张图就够",
        "Draw global temperature as a chart, one chart only",
        "Draw global temperature as a chart, just one chart",
        "Draw global temperature as a chart, no second chart",
    ];

    #[test]
    fn one_chart_phrases_route_to_the_single_chart_flow_when_the_switch_is_on() {
        with_one_chart_switch(Some("1"), || {
            for request in ONE_CHART_REQUESTS {
                let long = format!("做成长图。{request}");
                for text in [request, long.as_str()] {
                    assert!(is_visual_request(text), "{text}");
                    assert!(!is_complex_visual_request(text), "{text}");
                    assert!(!is_complex_visual_request_split(text), "{text}");
                    assert!(!has_multi_module_analytical_complexity(text), "{text}");
                }
            }
        });
    }

    #[test]
    fn one_chart_wording_with_a_page_word_goes_single_and_keeps_the_required_modes() {
        let text = "做一张长图，只要一张图，要有地图";
        with_one_chart_switch(Some("1"), || {
            assert!(!is_complex_visual_request(text));
            // The map the user named stays required; only the page route changes.
            assert_eq!(required_visual_modes(text).len(), 1);
            assert!(mentions_one_chart_only("no second charts please"));
        });
        with_one_chart_switch(Some("0"), || {
            assert!(is_complex_visual_request(text));
            assert_eq!(required_visual_modes(text).len(), 1);
        });
    }

    #[test]
    fn two_named_chart_modes_keep_the_page_route_even_with_one_chart_wording() {
        let text = "做一张长图，地图和 Sankey 都要，只要一张图";
        with_one_chart_switch(Some("1"), || {
            assert!(is_complex_visual_request(text));
            assert_eq!(required_visual_modes(text).len(), 2);
        });
    }

    #[test]
    fn a_page_word_alone_stays_a_page_and_a_plain_chart_request_is_unchanged() {
        for value in [None, Some("0"), Some("1")] {
            with_one_chart_switch(value, || {
                assert!(is_complex_visual_request("做成长图，说明全球气温变化"));
                assert!(!is_complex_visual_request("画一张全球气温折线图"));
                assert!(is_visual_request("画一张全球气温折线图"));
                assert!(!is_complex_visual_request("a choropleth of GDP per capita"));
            });
        }
    }

    #[test]
    fn the_switch_is_on_unless_the_value_is_exactly_zero() {
        let text = "做成长图，只要一张图";
        for (value, on) in [
            (None, true),
            (Some(""), true),
            (Some("0"), false),
            (Some("true"), true),
            (Some(" 0"), true),
            (Some("00"), true),
            (Some("1"), true),
        ] {
            with_one_chart_switch(value, || {
                assert_eq!(one_chart_routing_on(), on, "{value:?}");
                assert_eq!(is_complex_visual_request(text), !on, "{value:?}");
            });
        }
    }

    #[test]
    fn near_misses_do_not_count_as_one_chart_wording() {
        with_one_chart_switch(Some("1"), || {
            for text in [
                "做成长图，多画几张图",
                "做成长图，一张图一个结论",
                "make a long infographic, chart only the totals",
                "make a long infographic, just one chartreuse accent",
                "做成长图，只要一个图标",
                "做成长图，只要一个图例",
                "做成长图，不只要一张图",
                "做成长图，不是只要一张图",
                "做成长图，并不是只要一张图",
                "做成长图，并非只要一张图",
                "做成长图，而非只要一张图",
                "make a long infographic, just one chart is not enough",
            ] {
                assert!(is_complex_visual_request(text), "{text}");
            }
        });
    }

    #[test]
    fn only_the_request_text_is_read_for_the_one_chart_route() {
        // The route is a function of the request text alone: the callers outside this module
        // pass the topic or the user's follow-up, never the model's answer or events.
        let commands = [
            include_str!("commands/investigate.rs"),
            include_str!("commands/continue_investigation.rs"),
        ];
        for file in commands {
            assert!(!file.contains("asks_for_one_chart"));
            assert!(!file.contains("mentions_one_chart_only"));
        }
    }

    #[test]
    fn a_column_chart_request_is_told_apart_from_a_bar_request() {
        for text in [
            "做一张柱状图展示各国人口",
            "用柱形图比较各国",
            "Make a column chart of GDP",
            "a vertical bar chart please",
            "条形图和柱状图都要",
        ] {
            assert!(mentions_column_chart(text), "{text}");
            assert_eq!(column_chart_notice(text, true), COLUMN_CHART_NOTICE);
            assert_eq!(column_chart_notice(text, false), "", "{text}");
        }
        for text in [
            "做一张条形图展示各国人口",
            "bar chart of GDP",
            "设计柱状图案的壁纸",
            "画一张折线图",
            "解释一下这批数据",
        ] {
            assert!(!mentions_column_chart(text), "{text}");
            assert_eq!(column_chart_notice(text, true), "", "{text}");
        }
        assert!(COLUMN_CHART_NOTICE.contains("Only horizontal bar forms exist."));
    }

    #[test]
    fn the_first_turn_prompt_carries_the_column_notice_only_for_column_requests_and_zero_removes_it(
    ) {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let name = crate::prompt::COLUMN_CHART_NOTICE_ENV;
        std::env::remove_var(name);
        let build = |topic: &str| {
            investigation_with_options(topic, &[], false, false, PromptSpeed::default())
        };
        assert!(crate::pi::column_chart_notice_on(), "unset is on");
        for not_zero in ["", "1", "false"] {
            std::env::set_var(name, not_zero);
            assert!(crate::pi::column_chart_notice_on(), "{not_zero:?}");
        }
        std::env::remove_var(name);
        let column = "做一张柱状图展示各国人口";
        let with = build(column);
        assert!(with.contains(COLUMN_CHART_NOTICE));
        assert!(!build("做一张条形图展示各国人口").contains("Only horizontal bar forms exist"));
        assert!(!build("画一张各国人口图表").contains("Only horizontal bar forms exist"));
        std::env::set_var(name, "0");
        assert!(!crate::pi::column_chart_notice_on());
        let off = build(column);
        let bar_off = build("做一张条形图展示各国人口");
        std::env::remove_var(name);
        assert_eq!(
            off,
            with.replacen(COLUMN_CHART_NOTICE, "", 1),
            "\"0\" is the prompt without the notice, byte for byte"
        );
        assert_eq!(
            bar_off,
            build("做一张条形图展示各国人口"),
            "a request without column words does not depend on the switch"
        );
    }
}
