//! The answer plan (v5 design works/v5-answer-plan-design.md; a measurement prototype, built for tests only): a Chinese
//! question read by rule, with no model, into the places, the years, the quantity and the relation the page has to prove,
//! and the one sentence the page has to prove with its numbers left as placeholders (the program fills them from the
//! fetched rows, as it fills every number). The relations are the owner's nine of 2026-11-13, after the FT Visual
//! Vocabulary: what the question asks the page to show, not which chart draws it. A plan holds blocks, one sentence each;
//! a question gives one block for now (complex pages will give more). Not on the flow: the replay below prints the plans of
//! a question list, so they are judged against the rubrics before any flow code changes.

use crate::l5geo::{asked_zh, asked_zh_in_order, group_aggregate_zh, listed_aggregates, question_span, rank_asked_zh, Catalog, Place};

/// The years a question names (l5geo question_span, the knowledge group's own reading): from a year to a year, or on to
/// the latest (None); none named. The last n years (近十年, 过去 5 年) are read here as from n before the latest, written
/// (-n, None).
pub type Years = Option<(i32, Option<i32>)>;

/// The years of a question: question_span's, else the last n years after 近, 过去 or 最近 (a count, then 年), as (-n, None).
pub fn years_of(question: &str) -> Years {
    if let Some(span) = question_span(question) {
        return Some(span);
    }
    let q: String = question.chars().filter(|c| !c.is_whitespace()).collect();
    for mark in ["最近", "过去", "近"] {
        let Some(i) = q.find(mark) else { continue };
        let rest = &q[i + mark.len()..];
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || "一二两三四五六七八九十".contains(*c)).collect();
        if num.is_empty() || !rest[num.len()..].starts_with('年') {
            continue;
        }
        let n = num.parse::<i32>().ok().or_else(|| {
            let d = |c: char| "零一二三四五六七八九".find(c).map(|i| (i / 3) as i32).or((c == '两').then_some(2));
            let c: Vec<char> = num.chars().collect();
            match c.as_slice() {
                ['十'] => Some(10),
                [a] => d(*a),
                ['十', b] => d(*b).map(|b| 10 + b),
                [a, '十'] => d(*a).map(|a| a * 10),
                [a, '十', b] => Some(d(*a)? * 10 + d(*b)?),
                _ => None,
            }
        });
        if let Some(n) = n {
            return Some((-n, None));
        }
    }
    None
}

/// What a question asks the page to show (the owner's list, 11-13): one place against each of the others, a ranking or a
/// place's position in it, a change over time, the year a place catches up with another or crosses a line, the parts of a
/// whole, a total, a spread, a flow between stages, where on a map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rel {
    Deviation = 1,
    Ranking = 2,
    Change = 3,
    Threshold = 4,
    Composition = 5,
    Magnitude = 6,
    Distribution = 7,
    Flow = 8,
    Location = 9,
}

/// What the block's sentence asserts within its relation: the highest, the lowest, both, the first n, one named place's
/// position, every place's own value or change, the largest rise or fall, the first year past a line, the largest part or
/// flow, the total.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Focus {
    Max,
    Min,
    MaxMin,
    Top(usize),
    Bottom(usize),
    Position(String),
    Each,
    MostUp,
    MostDown,
    MostMoved,
    FirstPast,
    LargestPart,
    LargestFlow,
    Total,
    Against(String),
    /// A group's own whole, the year it first passed the line (a block of a many-block plan).
    WholeFirstPast,
    /// Each member's year past the line: how many were past it at the first year, how many crossed after.
    EachFirstPast,
    /// The members still below the line at the last year: the nearest and the lowest.
    BelowRest,
}

/// One block: what it proves and the sentence it proves, numbers as {placeholders}.
#[derive(Clone, Debug)]
pub struct Block {
    pub rel: Rel,
    pub focus: Focus,
    /// The places read (iso2, or a World Bank aggregate's code), in question order.
    pub places: Vec<String>,
    /// The words the question names them with.
    pub place_words: Vec<String>,
    /// The years named: from and to (None: on to the latest), or none (the table's latest).
    pub years: Years,
    /// The quantity families asked (measure-families.json ids) and their printed names.
    pub quantity: Vec<(String, String)>,
    pub sentence: String,
}

/// A plan: the blocks in reading order. One block, unless the question takes one of the three many-block shapes (Shape).
#[derive(Clone, Debug)]
pub struct Plan {
    pub blocks: Vec<Block>,
    /// One block for a question the shapes did not take (a none reply, or slots the question cannot fill): the page says
    /// it answers only part of the question.
    pub partial: bool,
}

/// Words that are a measure's name and hold a change or total word that is no change or total asked (人口增长率 is a level).
const LEVEL_NAMES_ZH: [&str; 10] = ["增速", "增长率", "增长速度", "总和生育率", "降水", "降雨", "减贫", "增加值", "涨幅榜", "最低工资"];
const THRESHOLD_ZH: [&str; 7] = ["跨过", "越过", "突破", "过线", "追上", "赶上", "首次超过"];
const FLOW_ZH: [&str; 7] = ["流向", "去向", "流到", "用到哪", "从哪来", "来源到", "到各部门"];
const COMPOSITION_ZH: [&str; 7] = ["构成", "结构", "组成", "由哪些", "各占", "份额", "占多大比重"];
const MAGNITUDE_ZH: [&str; 5] = ["合计", "总共", "一共", "加起来", "加在一起"];
const DEVIATION_ZH: [&str; 12] =
    ["多多少", "少多少", "差多少", "差几", "高多少", "低多少", "长多少", "短多少", "高出", "相差", "长寿多少", "领先多少"];
const CHANGE_ZH: [&str; 16] = [
    "变化", "怎么变", "变了", "以来", "走势", "趋势", "涨", "降", "增", "减", "升", "跌", "提高", "扩大", "缩小", "翻",
];
const LOCATION_ZH: [&str; 3] = ["地图", "地理分布", "分布在哪"];
const DISTRIBUTION_ZH: [&str; 2] = ["分布", "差异多大"];
const MAX_ZH: [&str; 10] = ["最高", "最多", "最大", "最快", "最长", "最贵", "最富", "领先", "居首", "第一"];
const MIN_ZH: [&str; 8] = ["最低", "最少", "最小", "最慢", "最短", "最便宜", "最穷", "垫底"];
const UP_ZH: [&str; 6] = ["涨", "升", "增", "提高", "扩大", "翻"];
const DOWN_ZH: [&str; 5] = ["降", "减", "跌", "缩小", "下滑"];

fn any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// The question without its spaces and without the measure names that hold a change or total word.
fn plain(question: &str) -> String {
    let mut q: String = question.chars().filter(|c| !c.is_whitespace()).collect();
    for n in LEVEL_NAMES_ZH {
        q = q.replace(n, &"\u{3000}".repeat(n.chars().count()));
    }
    q
}

/// The first count after 前 or 后 (前五, 前 3), as in a top or bottom n.
fn count_after(q: &str, mark: char) -> Option<usize> {
    let chars: Vec<char> = q.chars().collect();
    let digit = |c: char| "零一二三四五六七八九".find(c).map(|i| i / 3).or((c == '两').then_some(2));
    for (i, c) in chars.iter().enumerate() {
        if *c != mark {
            continue;
        }
        let rest: String = chars[i + 1..].iter().take_while(|c| c.is_ascii_digit() || "一二两三四五六七八九十".contains(**c)).collect();
        if rest.is_empty() {
            continue;
        }
        if let Ok(n) = rest.parse::<usize>() {
            return Some(n);
        }
        let r: Vec<char> = rest.chars().collect();
        let n = match r.as_slice() {
            ['十'] => Some(10),
            [a] => digit(*a),
            ['十', b] => digit(*b).map(|b| 10 + b),
            _ => None,
        };
        if n.is_some() {
            return n;
        }
    }
    None
}

/// The relation a question asks, by its words, in a fixed order: a line or catching up first, then a flow, the parts of a
/// whole, a total, one place against the others, a change, a map, a spread; a ranking when none of them is asked.
pub fn relation(question: &str) -> Rel {
    let q = plain(question);
    let year_range = matches!(years_of(question), Some((a, Some(b))) if a < b) || matches!(years_of(question), Some((_, None)));
    if any(&q, &THRESHOLD_ZH) || (q.contains("哪年") && any(&q, &["超过", "达到", "高于", "低于"])) {
        Rel::Threshold
    } else if any(&q, &FLOW_ZH) {
        Rel::Flow
    } else if any(&q, &COMPOSITION_ZH) {
        Rel::Composition
    } else if any(&q, &MAGNITUDE_ZH) {
        Rel::Magnitude
    } else if any(&q, &DEVIATION_ZH) {
        Rel::Deviation
    } else if any(&q, &CHANGE_ZH) || (year_range && !q.contains("各年") && !q.contains("每年")) {
        Rel::Change
    } else if any(&q, &LOCATION_ZH) {
        Rel::Location
    } else if any(&q, &DISTRIBUTION_ZH) {
        Rel::Distribution
    } else {
        Rel::Ranking
    }
}

/// What the sentence asserts, by the question's words, within the relation `rel`; `first_place` is the first place word,
/// the one a deviation or a position is of.
pub fn focus(question: &str, rel: Rel, first_place: Option<&str>) -> Focus {
    let q = plain(question);
    let max = any(&q, &MAX_ZH);
    let min = any(&q, &MIN_ZH);
    match rel {
        Rel::Deviation => Focus::Against(first_place.unwrap_or("").to_string()),
        Rel::Threshold => Focus::FirstPast,
        Rel::Composition => Focus::LargestPart,
        Rel::Flow => Focus::LargestFlow,
        Rel::Magnitude => Focus::Total,
        Rel::Change => {
            let up = any(&q, &UP_ZH);
            let down = any(&q, &DOWN_ZH);
            if (max || q.contains("最")) && down && !up {
                Focus::MostDown
            } else if (max || q.contains("最")) && up && !down {
                Focus::MostUp
            } else if max || q.contains("谁") || q.contains("哪") {
                Focus::MostMoved
            } else {
                Focus::Each
            }
        }
        Rel::Ranking | Rel::Distribution | Rel::Location => {
            if q.contains("第几") || q.contains("排第") || q.contains("排在") || q.contains("位置") {
                Focus::Position(first_place.unwrap_or("").to_string())
            } else if let Some(n) = count_after(&q, '前') {
                Focus::Top(n)
            } else if let Some(n) = count_after(&q, '后').filter(|_| q.contains("排名后") || q.contains("倒数")) {
                Focus::Bottom(n)
            } else if max && min || q.contains("高低") && !max && !min {
                Focus::MaxMin
            } else if min {
                Focus::Min
            } else {
                Focus::Max
            }
        }
    }
}

/// The sentence a block proves: every number a placeholder the program fills; the places and the quantity as the question
/// names them.
pub fn sentence(rel: Rel, focus: &Focus, places: &[String], quantity: &str, years: &Years) -> String {
    let who = if places.is_empty() { "各地".to_string() } else { places.join("、") };
    let span = match *years {
        Some((a, Some(b))) if a < b => format!("{a}到{b}年，"),
        Some((a, Some(_))) => format!("{a}年，"),
        Some((a, None)) if a < 0 => format!("近{}年，", -a),
        Some((a, None)) => format!("{a}年到{{last.year}}年，"),
        None => "{year}年，".to_string(),
    };
    match (rel, focus) {
        (_, Focus::Against(x)) => format!("{span}{x}的{quantity}比其余各地分别{{高或低}}{{each.d}}"),
        (_, Focus::FirstPast) => format!("{{first.name}}在{{first.year}}年最早过线{{line}}，到{{last.year}}年仍有{{n.below}}个未过线"),
        (_, Focus::LargestPart) => format!("{span}{who}的{quantity}中，{{part.max}}占{{part.share}}，是最大的部分"),
        (_, Focus::LargestFlow) => format!("{span}最大的一股是{{flow.src}}流向{{flow.dst}}，{{flow.v}}"),
        (_, Focus::Total) => format!("{span}{who}的{quantity}合计{{sum}}"),
        (_, Focus::MostUp) => format!("{span}{who}中{{up.name}}的{quantity}升得最多，{{up.d}}"),
        (_, Focus::MostDown) => format!("{span}{who}中{{down.name}}的{quantity}降得最多，{{down.d}}"),
        (_, Focus::MostMoved) => format!("{span}{who}中{{moved.name}}的{quantity}变化最大，{{moved.d}}"),
        (_, Focus::Each) => format!("{span}{who}的{quantity}各自{{升或降}}{{each.d}}"),
        (_, Focus::Max) => format!("{span}{who}中{{max.name}}的{quantity}最高，为{{max.v}}"),
        (_, Focus::Min) => format!("{span}{who}中{{min.name}}的{quantity}最低，为{{min.v}}"),
        (_, Focus::MaxMin) => format!("{span}{who}的{quantity}最高是{{max.name}}（{{max.v}}），最低是{{min.name}}（{{min.v}}）"),
        (_, Focus::Top(n)) => format!("{span}{quantity}最高的{n}个是{{top.names}}"),
        (_, Focus::Bottom(n)) => format!("{span}{quantity}最低的{n}个是{{bottom.names}}"),
        (_, Focus::Position(x)) => format!("{span}{x}的{quantity}在{{n}}个地方中排第{{rank}}"),
        (_, Focus::WholeFirstPast) => format!("{who}整体在{{whole.year}}年首次过线{{line}}，{{last.year}}年为{{whole.last}}"),
        (_, Focus::EachFirstPast) => {
            "{first.year}年已在线{line}以上的有{n.first}个；此后{n.crossed}个陆续过线，最多的一年是{peak.year}年（{peak.n}个）".to_string()
        }
        (_, Focus::BelowRest) => "到{last.year}年仍未过线的{n.below}个里，{near.name}最接近（{near.v}），{low.name}最低（{low.v}）".to_string(),
    }
}

/// Words after which a question asks whether the first quantity's leader also leads the others (是不是也最富).
const ALSO_ZH: [&str; 4] = ["是不是也", "是否也", "是不是同样", "也是不是"];
/// Words that ask where a whole comes from and, beside them, where it goes.
const FROM_ZH: [&str; 3] = ["从哪来", "从哪里来", "来自哪"];
const TO_ZH: [&str; 6] = ["到哪去", "用到哪", "用在哪", "去了哪", "去向", "流向"];
/// Words that a threshold question asks of each member of a group.
const EACH_ZH: [&str; 4] = ["各国", "各成员国", "各成员", "每个成员国"];

/// The three many-block shapes (owner 2026-11-14 16:0x item 5; works/complex-split/design.md). The model answers only a
/// shape number and its slots; the blocks, each block's quantity and the common year are the template's. The main chart
/// of each block is not named here: the sketch compare lists the nodes registered for the block's relation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// The first quantity's leader and its position in the others (sample A).
    RankCompare = 1,
    /// A line, the year a group and each member passed it, the members still below (sample B).
    ThresholdTime = 2,
    /// A whole: its total, its parts, its flows (sample C).
    TotalToParts = 3,
}

pub const SHAPES: [Shape; 3] = [Shape::RankCompare, Shape::ThresholdTime, Shape::TotalToParts];

impl Shape {
    pub fn number(self) -> u8 {
        self as u8
    }
    pub fn from_number(n: u8) -> Option<Shape> {
        SHAPES.into_iter().find(|s| s.number() == n)
    }
    pub fn name_zh(self) -> &'static str {
        match self {
            Shape::RankCompare => "名次对照",
            Shape::ThresholdTime => "过线和时间",
            Shape::TotalToParts => "由总到分",
        }
    }
}

/// The shape request: the shapes in the order offered (the preselected one first, with the words that matched), and the
/// quantities the question names, in its order, as the slot values a reply picks from by index.
#[derive(Clone, Debug)]
pub struct ShapeAsk {
    pub offered: Vec<(Shape, Option<&'static str>)>,
    pub quantities: Vec<(String, String)>,
}

/// A reply: a shape number (0: none of them) and, for the shape, the quantities by their index in the request, in the
/// order the blocks take them (empty: the question's order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShapeReply {
    pub shape: u8,
    pub quantities: Vec<usize>,
}

/// The shape the question's words point to, and the words: the program's preselection, offered first; not a decision.
pub fn preselect(c: &Catalog, question: &str) -> Option<(Shape, &'static str)> {
    let q = plain(question);
    if let Some(w) = ALSO_ZH.iter().copied().find(|w| q.contains(w)) {
        if asked_zh_in_order(question).len() >= 2 {
            return Some((Shape::RankCompare, w));
        }
    }
    let first = one_block(c, question).blocks.first().map(|b| b.rel);
    if first == Some(Rel::Threshold) {
        if let Some(w) = EACH_ZH.iter().copied().find(|w| q.contains(w)) {
            return Some((Shape::ThresholdTime, w));
        }
    }
    if let (Some(_), Some(w)) = (FROM_ZH.iter().copied().find(|w| q.contains(w)), TO_ZH.iter().copied().find(|w| q.contains(w))) {
        return Some((Shape::TotalToParts, w));
    }
    None
}

/// The shape request of a question: the preselected shape first, the others after in number order.
pub fn shape_ask(c: &Catalog, question: &str) -> ShapeAsk {
    let pre = preselect(c, question);
    let mut offered: Vec<(Shape, Option<&'static str>)> = pre.map(|(s, w)| (s, Some(w))).into_iter().collect();
    offered.extend(SHAPES.into_iter().filter(|s| pre.map(|p| p.0) != Some(*s)).map(|s| (s, None)));
    let quantities = asked_zh_in_order(question).into_iter().map(|a| (a.id, a.zh)).collect();
    ShapeAsk { offered, quantities }
}

/// A reply checked against its request: a shape number offered or 0, quantity indexes in range and not repeated, and as
/// many as the shape takes (名次对照 two or more, the others one). A refusal names the allowed values and an example.
pub fn check_reply(ask: &ShapeAsk, reply: &ShapeReply) -> Result<(), String> {
    let allowed = format!(
        "shape: 0 (none of them) or {}; quantities: indexes 0..{} in the order the blocks take them",
        ask.offered.iter().map(|(s, _)| s.number().to_string()).collect::<Vec<_>>().join(", "),
        ask.quantities.len()
    );
    let example = match ask.offered.first() {
        Some((Shape::RankCompare, _)) => format!("{{\"shape\":1,\"quantities\":[{}]}}", (0..ask.quantities.len().max(2)).map(|i| i.to_string()).collect::<Vec<_>>().join(",")),
        Some((s, _)) => format!("{{\"shape\":{},\"quantities\":[0]}}", s.number()),
        None => "{\"shape\":0,\"quantities\":[]}".to_string(),
    };
    let refuse = |why: &str| Err(format!("{why}; allowed: {allowed}; example: {example}"));
    if reply.shape == 0 {
        return Ok(());
    }
    let Some(shape) = Shape::from_number(reply.shape) else { return refuse("no such shape") };
    if reply.quantities.iter().any(|&i| i >= ask.quantities.len()) {
        return refuse("a quantity index past the list");
    }
    let mut seen = reply.quantities.clone();
    seen.sort_unstable();
    seen.dedup();
    if seen.len() != reply.quantities.len() {
        return refuse("a quantity picked twice");
    }
    let n = if reply.quantities.is_empty() { ask.quantities.len() } else { reply.quantities.len() };
    match shape {
        Shape::RankCompare if n < 2 => refuse("名次对照 takes two quantities or more"),
        _ if n == 0 => refuse("the shape takes a quantity and the question names none"),
        _ => Ok(()),
    }
}

/// The plan of a question on the catalogue `c` with the preselected shape taken as the reply (the replay and the tests;
/// on the flow the model's reply is taken, plan_for).
pub fn plan(c: &Catalog, question: &str) -> Plan {
    let shape = preselect(c, question).map_or(0, |(s, _)| s.number());
    plan_for(c, question, &ShapeReply { shape, quantities: vec![] })
}

/// The plan of a question for a checked reply: the shape's template, or, for 0 or a shape whose slots the question cannot
/// fill, its best one block marked partial (the page says it answers only part of the question; graded 没答全).
/// - 名次对照: a block per quantity in the reply's order, the first its highest (or lowest, when the words before the
///   also-word ask the lowest), each later one that place's position;
/// - 过线和时间: the group's own whole when it has rows of its own, each member's year, the members still below at the
///   last year (needs a line: the one block reads a threshold);
/// - 由总到分: its total, its parts, its flows.
pub fn plan_for(c: &Catalog, question: &str, reply: &ShapeReply) -> Plan {
    let mut one = one_block(c, question);
    let Some(b) = one.blocks.first().cloned() else { return one };
    let all: Vec<(String, String)> = asked_zh_in_order(question).into_iter().map(|a| (a.id, a.zh)).collect();
    let picked: Vec<(String, String)> =
        if reply.quantities.is_empty() { all } else { reply.quantities.iter().filter_map(|&i| all.get(i).cloned()).collect() };
    let q = plain(question);
    let with = |rel: Rel, focus: Focus, quantity: Vec<(String, String)>| {
        let name = quantity.first().map_or("{quantity}".to_string(), |(_, zh)| zh.clone());
        let sentence = sentence(rel, &focus, &b.place_words, &name, &b.years);
        Block { rel, focus, quantity, sentence, ..b.clone() }
    };
    let first = |picked: &[(String, String)]| picked.first().map_or(b.quantity.clone(), |x| vec![x.clone()]);
    let blocks = match Shape::from_number(reply.shape) {
        Some(Shape::RankCompare) if picked.len() >= 2 => {
            let head = ALSO_ZH.iter().filter_map(|w| q.find(w)).min().map_or(q.as_str(), |at| &q[..at]);
            let low = any(head, &MIN_ZH) && !any(head, &MAX_ZH);
            let lead = if low { "{b1.min.name}" } else { "{b1.max.name}" };
            let mut blocks = vec![with(Rel::Ranking, if low { Focus::Min } else { Focus::Max }, vec![picked[0].clone()])];
            for a in &picked[1..] {
                blocks.push(with(Rel::Ranking, Focus::Position(lead.to_string()), vec![a.clone()]));
            }
            blocks
        }
        Some(Shape::ThresholdTime) if b.rel == Rel::Threshold => {
            let quantity = first(&picked);
            let mut blocks = Vec::new();
            if group_aggregate_zh(question).is_some() {
                blocks.push(with(Rel::Threshold, Focus::WholeFirstPast, quantity.clone()));
            }
            blocks.push(with(Rel::Threshold, Focus::EachFirstPast, quantity.clone()));
            blocks.push(with(Rel::Ranking, Focus::BelowRest, quantity));
            blocks
        }
        Some(Shape::TotalToParts) if !first(&picked).is_empty() => {
            let quantity = first(&picked);
            vec![
                with(Rel::Magnitude, Focus::Total, quantity.clone()),
                with(Rel::Composition, Focus::LargestPart, quantity.clone()),
                with(Rel::Flow, Focus::LargestFlow, quantity),
            ]
        }
        _ => {
            one.partial = reply.shape != 0 || preselect(c, question).is_some();
            return one;
        }
    };
    Plan { blocks, partial: false }
}

/// The one-block plan of a question on the catalogue `c`.
fn one_block(c: &Catalog, question: &str) -> Plan {
    let (_, words) = c.scope(question);
    let mut places: Vec<String> =
        c.places(question).into_iter().filter_map(|p| if let Place::Country(x) = p { Some(x) } else { None }).collect();
    places.extend(listed_aggregates(question));
    if let Some(r) = rank_asked_zh(question) {
        places.push(format!("rank:{}", r.by));
    }
    let quantity: Vec<(String, String)> = asked_zh(question).into_iter().map(|a| (a.id, a.zh)).collect();
    let years = years_of(question);
    let rel = relation(question);
    let focus = focus(question, rel, words.first().map(String::as_str));
    let q_name = quantity.first().map_or("{quantity}".to_string(), |(_, zh)| zh.clone());
    let sentence = sentence(rel, &focus, &words, &q_name, &years);
    Plan { blocks: vec![Block { rel, focus, places, place_words: words, years, quantity, sentence }], partial: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relation and focus of question shapes the dev set and the exam hold (not their texts).
    #[test]
    fn a_question_reads_as_its_relation_and_focus() {
        let cases: [(&str, Rel, Focus); 12] = [
            ("2010 年到 2020 年各国的总和生育率各降了多少？哪国降得最多？", Rel::Change, Focus::MostDown),
            ("韩国比日本、美国的人均寿命长多少？", Rel::Deviation, Focus::Against("韩国".into())),
            ("欧盟各国哪年跨过 20%？", Rel::Threshold, Focus::FirstPast),
            ("德国的能源从哪来、用到哪去？", Rel::Flow, Focus::LargestFlow),
            ("欧盟各国发电结构", Rel::Composition, Focus::LargestPart),
            ("海合会六国 GDP 合计是多少？", Rel::Magnitude, Focus::Total),
            ("2023 年金砖国家 GDP 增速排名", Rel::Ranking, Focus::Max),
            ("欧盟各国最低工资谁最低？", Rel::Ranking, Focus::Min),
            ("七国集团研发投入占比的高低", Rel::Ranking, Focus::MaxMin),
            ("意大利的青年失业率在欧盟排第几？", Rel::Ranking, Focus::Position("意大利".into())),
            ("人口最多的前五个国家", Rel::Ranking, Focus::Top(5)),
            ("中国的城镇化率 2000 年以来怎么变？", Rel::Change, Focus::Each),
        ];
        for (q, rel, f) in cases {
            assert_eq!(relation(q), rel, "{q}");
            let first = if q.starts_with("韩国") { Some("韩国") } else if q.starts_with("意大利") { Some("意大利") } else { None };
            assert_eq!(focus(q, rel, first), f, "{q}");
        }
        assert!(sentence(Rel::Ranking, &Focus::Max, &["德国".into()], "人口", &None).contains("{max.name}"));
        let s = sentence(Rel::Change, &Focus::MostDown, &[], "人口", &Some((2000, Some(2020))));
        assert_eq!(s, "2000到2020年，各地中{down.name}的人口降得最多，{down.d}", "the question's years and placeholders only");
        assert_eq!(years_of("各国 65 岁以上人口比例近十年变化"), Some((-10, None)));
        assert_eq!(years_of("过去 5 年的房价"), Some((-5, None)));
        assert_eq!(years_of("2015 到 2024 年"), Some((2015, Some(2024))));
        assert_eq!(years_of("各国人口"), None);
    }

    /// The three many-block shapes (works/complex-split/design.md) give the blocks of the hand-written plans of complex
    /// samples A, B and C (works/complex-*/), each with at least one other question of its shape on other data; a
    /// question of none of them keeps its one block.
    #[test]
    fn three_question_shapes_give_the_blocks_of_the_hand_written_plans() {
        let c = crate::l5geo::test_world();
        let blocks = |q: &str| -> Vec<(Rel, Focus, Vec<String>)> {
            plan(&c, q).blocks.into_iter().map(|b| (b.rel, b.focus, b.quantity.into_iter().map(|(id, _)| id).collect())).collect()
        };
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let lead = Focus::Position("{b1.max.name}".into());
        // A: the first quantity's leader, then its position in each later one, in the question's order
        assert_eq!(
            blocks("东盟各国：人最多的，是不是也最富、最城市化？"),
            [
                (Rel::Ranking, Focus::Max, ids(&["population"])),
                (Rel::Ranking, lead.clone(), ids(&["gdp_pc"])),
                (Rel::Ranking, lead.clone(), ids(&["urban_share"])),
            ]
        );
        assert_eq!(
            blocks("金砖国家里人均GDP最高的，是不是也城镇化率最高？"),
            [(Rel::Ranking, Focus::Max, ids(&["gdp_pc"])), (Rel::Ranking, lead, ids(&["urban_share"]))]
        );
        let low = blocks("欧盟里人均GDP最低的，是否也城镇化率最低？");
        assert_eq!((low[0].1.clone(), low[1].1.clone()), (Focus::Min, Focus::Position("{b1.min.name}".into())));
        // B: a threshold asked of each member: the group's whole when it has rows of its own, each member, the rest below
        let b: Vec<(Rel, Focus)> = blocks("欧盟各国哪年跨过 20%？").into_iter().map(|(r, f, _)| (r, f)).collect();
        assert_eq!(b, [(Rel::Threshold, Focus::WholeFirstPast), (Rel::Threshold, Focus::EachFirstPast), (Rel::Ranking, Focus::BelowRest)]);
        let b2 = blocks("欧盟各成员国的人均GDP哪年突破 3 万欧元？");
        assert_eq!(b2.iter().map(|x| x.1.clone()).collect::<Vec<_>>(), [Focus::WholeFirstPast, Focus::EachFirstPast, Focus::BelowRest]);
        assert!(b2.iter().all(|x| x.2 == ids(&["gdp_pc"])), "{b2:?}");
        let asean: Vec<Focus> = blocks("东盟各国哪年城镇化率跨过 50%？").into_iter().map(|x| x.1).collect();
        assert_eq!(asean, [Focus::EachFirstPast, Focus::BelowRest], "a group with no rows of its own has no whole");
        // C: where a whole comes from and where it goes: its total, its parts, its flows
        let three = [(Rel::Magnitude, Focus::Total), (Rel::Composition, Focus::LargestPart), (Rel::Flow, Focus::LargestFlow)];
        for q in ["德国的能源从哪来、用到哪去？", "法国的能源从哪里来，用在哪里？"] {
            let got = blocks(q);
            assert_eq!(got.iter().map(|(r, f, _)| (*r, f.clone())).collect::<Vec<_>>(), three, "{q}");
            assert!(got.iter().all(|x| x.2 == ids(&["energy_balance"])), "{q}: {got:?}");
        }
        // none of the three shapes: one block, as before
        for q in ["德国哪年跨过 20%？", "德国的能源从哪来？", "2023 年金砖国家 GDP 增速排名", "韩国比日本、美国的人均寿命长多少？", "人均GDP最高的是哪国？"] {
            assert_eq!(plan(&c, q).blocks.len(), 1, "{q}");
        }
        // every block's sentence is the program's, numbers as placeholders
        for b in plan(&c, "东盟各国：人最多的，是不是也最富、最城市化？").blocks {
            assert!(!b.sentence.chars().any(|ch| ch.is_ascii_digit()), "{}", b.sentence);
        }
    }

    /// The model answers a shape number and slots (owner 11-14 16:0x item 5): the preselected shape is offered first;
    /// the reply's number is what counts, not the preselection; 0, or a shape the question cannot fill, gives one block
    /// marked partial; a reply out of the offered values is refused with the allowed values and an example.
    #[test]
    fn the_reply_shape_number_picks_the_template() {
        let c = crate::l5geo::test_world();
        let a = "东盟各国：人最多的，是不是也最富、最城市化？";
        assert_eq!(SHAPES.map(Shape::name_zh), ["名次对照", "过线和时间", "由总到分"]);
        let ask = shape_ask(&c, a);
        assert_eq!(ask.offered.iter().map(|(s, _)| s.number()).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(ask.offered[0].1, Some("是不是也"));
        assert_eq!(ask.quantities.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["population", "gdp_pc", "urban_share"]);
        let c_ask = shape_ask(&c, "德国的能源从哪来、用到哪去？");
        assert_eq!(c_ask.offered.iter().map(|(s, _)| s.number()).collect::<Vec<_>>(), [3, 1, 2], "preselected first");
        assert!(shape_ask(&c, "2023 年金砖国家 GDP 增速排名").offered.iter().all(|(_, w)| w.is_none()), "no preselection");
        // the reply's order of quantities is the blocks' order
        let r = ShapeReply { shape: 1, quantities: vec![1, 0] };
        assert_eq!(check_reply(&ask, &r), Ok(()));
        let got: Vec<String> = plan_for(&c, a, &r).blocks.into_iter().map(|b| b.quantity[0].0.clone()).collect();
        assert_eq!(got, ["gdp_pc", "population"]);
        // another shape than the preselected one: that template (由总到分 on the first quantity picked)
        let p = plan_for(&c, a, &ShapeReply { shape: 3, quantities: vec![0] });
        assert_eq!(p.blocks.iter().map(|b| b.rel).collect::<Vec<_>>(), [Rel::Magnitude, Rel::Composition, Rel::Flow]);
        assert!(!p.partial);
        // none of them: the one block, marked partial
        let none = plan_for(&c, a, &ShapeReply { shape: 0, quantities: vec![] });
        assert_eq!((none.blocks.len(), none.partial), (1, true));
        // a shape whose slots the question cannot fill (no line read for 过线和时间): one block, partial
        let unfilled = plan_for(&c, "德国的能源从哪来、用到哪去？", &ShapeReply { shape: 2, quantities: vec![] });
        assert_eq!((unfilled.blocks.len(), unfilled.partial), (1, true));
        // a plain one-block question is not partial
        assert!(!plan(&c, "2023 年金砖国家 GDP 增速排名").partial);
        // refusals carry the allowed values and an example
        for bad in [
            ShapeReply { shape: 7, quantities: vec![] },
            ShapeReply { shape: 1, quantities: vec![5] },
            ShapeReply { shape: 1, quantities: vec![0, 0] },
            ShapeReply { shape: 1, quantities: vec![2] },
        ] {
            let e = check_reply(&ask, &bad).unwrap_err();
            assert!(e.contains("allowed: shape: 0 (none of them) or 1, 2, 3") && e.contains("example: {\"shape\":1,"), "{bad:?}: {e}");
        }
    }

    /// The plans of Q_CASES rows (qid, question, and optionally a shape reply `shape:i,j` — the shape number, then the
    /// quantity indexes; without it the preselected shape is taken) on the real catalogue. Per row an ASK line (qid, the
    /// shapes offered in order with the preselecting words, the quantities offered), a REFUSED line for a reply the check
    /// refuses, and a PLAN line per block: qid, relation number, focus, places, place words, years, quantity ids, sentence,
    /// partial.
    /// L5GEO_DIR=<registry>/l5geo/catalog Q_CASES=<cases.tsv> cargo test answer_plan::tests::replay_answer_plans -- --include-ignored --nocapture
    #[test]
    #[ignore]
    fn replay_answer_plans() {
        let dir = std::path::PathBuf::from(std::env::var("L5GEO_DIR").expect("L5GEO_DIR"));
        let cases = std::fs::read_to_string(std::env::var("Q_CASES").expect("Q_CASES")).unwrap();
        let c = Catalog::load(&dir).unwrap();
        for line in cases.lines().filter(|l| !l.starts_with('#')) {
            let cols: Vec<&str> = line.split('\t').collect();
            let [qid, q, rest @ ..] = cols.as_slice() else { panic!("Q_CASES row without a tab: {line}") };
            let ask = shape_ask(&c, q);
            println!(
                "ASK\t{qid}\t{}\t{}",
                ask.offered.iter().map(|(s, w)| format!("{}{}", s.number(), w.map_or(String::new(), |w| format!("({w})")))).collect::<Vec<_>>().join(","),
                ask.quantities.iter().enumerate().map(|(i, (id, _))| format!("{i}={id}")).collect::<Vec<_>>().join(",")
            );
            let p = match rest.first().filter(|r| !r.is_empty()) {
                None => plan(&c, q),
                Some(r) => {
                    let (n, qs) = r.split_once(':').unwrap_or((*r, ""));
                    let reply = ShapeReply {
                        shape: n.trim().parse().expect("shape number"),
                        quantities: qs.split(',').filter(|x| !x.trim().is_empty()).map(|x| x.trim().parse().expect("quantity index")).collect(),
                    };
                    if let Err(e) = check_reply(&ask, &reply) {
                        println!("REFUSED\t{qid}\t{e}");
                        continue;
                    }
                    plan_for(&c, q, &reply)
                }
            };
            let partial = p.partial;
            for b in p.blocks {
                let years = match b.years {
                    Some((a, Some(z))) => format!("{a}-{z}"),
                    Some((a, None)) if a < 0 => format!("last{}", -a),
                    Some((a, None)) => format!("{a}-latest"),
                    None => "latest".into(),
                };
                println!(
                    "PLAN\t{qid}\t{}\t{:?}\t{}\t{}\t{years}\t{}\t{}\t{}",
                    b.rel as u8,
                    b.focus,
                    b.places.join(","),
                    b.place_words.join(","),
                    b.quantity.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join(","),
                    b.sentence,
                    if partial { "partial" } else { "" }
                );
            }
        }
    }
}
