//! The answer plan (v5 design works/v5-answer-plan-design.md; on the flow through the knowledge group's split_ask and
//! answer_plan requests, the shape step of next_flow prepare_claims): a Chinese
//! question read by rule, with no model, into the places, the years, the quantity and the relation the page has to prove,
//! and the one sentence the page has to prove with its numbers left as placeholders (the program fills them from the
//! fetched rows, as it fills every number). The relations are the owner's nine of 2026-11-13, after the FT Visual
//! Vocabulary: what the question asks the page to show, not which chart draws it. A plan holds blocks, one sentence each;
//! a question takes one block unless the model answers one of the many-block shapes. The replay below prints the plans of a
//! question list, so they are judged against the rubrics before any flow code changes.

use serde::{Deserialize, Serialize};

use crate::l5geo::{
    asked_zh, asked_zh_in_order, group_aggregate_zh, listed_aggregates, question_span,
    rank_asked_zh, Catalog, Place,
};

/// The years a question names (l5geo question_span, the knowledge group's own reading): from a year to a year, or on to
/// the latest (None); none named. The last n years (近十年, 过去 5 年) are read here as from n before the latest, written
/// (-n, None).
pub type Years = Option<(i32, Option<i32>)>;

/// The years of a question: question_span's, else the last n years the question asks, as (-n, None); none named (the
/// latest) for 最近一年 (owner 11-16 13:1x item 1: the latest year, not a change over one year). A question that asks the
/// last n years and names one year inside them (近二十年 … 2015 年那一年) asks the span, the year a point in it (item 2).
pub fn years_of(question: &str) -> Years {
    let q: String = question.chars().filter(|c| !c.is_whitespace()).collect();
    let last = last_years(&q);
    match question_span(question) {
        Some((a, Some(b))) if a == b && last.is_some_and(|n| n > 1) => {}
        Some(span) => return Some(span),
        None => {}
    }
    match last {
        Some(n) if n > 0 => Some((-n, None)),
        _ => None,
    }
}

/// The last n years a question asks: a count of years after 近, 过去 or 最近 (近十年, 过去 5 年), or before 年来, 年变化 or
/// 年的变化 (十年来, 五年来, 十年变化; owner 11-16 13:1x item 2); 0 for 最近一年, the latest year. A count is one or two
/// digits or Chinese numerals, so a calendar year (2010 年来) is none.
fn last_years(q: &str) -> Option<i32> {
    const NUMERALS: &str = "一二两三四五六七八九十";
    let count = |num: &str| -> Option<i32> {
        if num.chars().all(|c| c.is_ascii_digit()) {
            return num.parse::<i32>().ok().filter(|_| num.len() <= 2);
        }
        let d = |c: char| {
            "零一二三四五六七八九"
                .find(c)
                .map(|i| (i / 3) as i32)
                .or((c == '两').then_some(2))
        };
        let c: Vec<char> = num.chars().collect();
        match c.as_slice() {
            ['十'] => Some(10),
            [a] => d(*a),
            ['十', b] => d(*b).map(|b| 10 + b),
            [a, '十'] => d(*a).map(|a| a * 10),
            [a, '十', b] => Some(d(*a)? * 10 + d(*b)?),
            _ => None,
        }
    };
    let is_num = |c: char| c.is_ascii_digit() || NUMERALS.contains(c);
    for mark in ["最近", "过去", "近"] {
        let Some(i) = q.find(mark) else { continue };
        let rest = &q[i + mark.len()..];
        let num: String = rest.chars().take_while(|c| is_num(*c)).collect();
        if num.is_empty() || !rest[num.len()..].starts_with('年') {
            continue;
        }
        if let Some(n) = count(&num) {
            return Some(if mark == "最近" && n == 1 { 0 } else { n });
        }
    }
    for tail in ["年来", "年变化", "年的变化"] {
        for (i, _) in q.match_indices(tail) {
            let before: Vec<char> = q[..i].chars().rev().take_while(|c| is_num(*c)).collect();
            let num: String = before.into_iter().rev().collect();
            if let Some(n) = (!num.is_empty()).then(|| count(&num)).flatten() {
                return Some(n);
            }
        }
    }
    None
}

/// What a question asks the page to show (the owner's list, 11-13): one place against each of the others, a ranking or a
/// place's position in it, a change over time, the year a place catches up with another or crosses a line, the parts of a
/// whole, a total, a spread, a flow between stages, where on a map.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

/// The relation a page recipe answers (shape_registry::Relation) for each of these that a recipe draws: the table the
/// flow gives a block's page picks its recipe by it (a rank block is drawn as a ranking, not as the change its rows also
/// hold). A relation with no row here leaves the recipe to the table step's relation.
pub const RECIPE_RELATIONS: [(Rel, crate::shape_registry::Relation); 6] = [
    (Rel::Ranking, crate::shape_registry::Relation::Ranking),
    (Rel::Change, crate::shape_registry::Relation::Change),
    (
        Rel::Composition,
        crate::shape_registry::Relation::Composition,
    ),
    (Rel::Flow, crate::shape_registry::Relation::Flow),
    (Rel::Location, crate::shape_registry::Relation::Map),
    (
        Rel::Distribution,
        crate::shape_registry::Relation::Distribution,
    ),
];

/// What the block's sentence asserts within its relation: the highest, the lowest, both, the first n, one named place's
/// position, every place's own value or change, the largest rise or fall, the first year past a line, the largest part or
/// flow, the total.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

/// A later 名次对照 block's focus: the first block's highest place (plan_for), whose place the block's page says.
pub const FIRST_LEADER: &str = "{b1.max.name}";

/// One block: what it proves and the sentence it proves, numbers as {placeholders}.
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plan {
    pub blocks: Vec<Block>,
    /// One block for a question the shapes did not take (a none reply, or slots the question cannot fill): the page says
    /// it answers only part of the question.
    pub partial: bool,
}

/// Words that are a measure's name and hold a change or total word that is no change or total asked (人口增长率 is a level).
const LEVEL_NAMES_ZH: [&str; 10] = [
    "增速",
    "增长率",
    "增长速度",
    "总和生育率",
    "降水",
    "降雨",
    "减贫",
    "增加值",
    "涨幅榜",
    "最低工资",
];
const THRESHOLD_ZH: [&str; 7] = ["跨过", "越过", "突破", "过线", "追上", "赶上", "首次超过"];
const FLOW_ZH: [&str; 7] = [
    "流向",
    "去向",
    "流到",
    "用到哪",
    "从哪来",
    "来源到",
    "到各部门",
];
const COMPOSITION_ZH: [&str; 7] = [
    "构成",
    "结构",
    "组成",
    "由哪些",
    "各占",
    "份额",
    "占多大比重",
];
const MAGNITUDE_ZH: [&str; 5] = ["合计", "总共", "一共", "加起来", "加在一起"];
const DEVIATION_ZH: [&str; 12] = [
    "多多少",
    "少多少",
    "差多少",
    "差几",
    "高多少",
    "低多少",
    "长多少",
    "短多少",
    "高出",
    "相差",
    "长寿多少",
    "领先多少",
];
const CHANGE_ZH: [&str; 16] = [
    "变化",
    "怎么变",
    "变了",
    "以来",
    "走势",
    "趋势",
    "涨",
    "降",
    "增",
    "减",
    "升",
    "跌",
    "提高",
    "扩大",
    "缩小",
    "翻",
];
const LOCATION_ZH: [&str; 3] = ["地图", "地理分布", "分布在哪"];
const DISTRIBUTION_ZH: [&str; 2] = ["分布", "差异多大"];
/// The second place at the top or at the bottom a question compares with (asks_second).
const SECOND_HIGH_ZH: [&str; 5] = ["第二高", "第二多", "第二大", "第二快", "次高"];
/// A second place named with no end: the end the question asks about (the bottom's when it asks for the lowest).
const SECOND_ANY_ZH: [&str; 2] = ["第二名", "第二位"];
const SECOND_LOW_ZH: [&str; 5] = ["倒数第二", "第二低", "第二少", "第二小", "次低"];
const MAX_ZH: [&str; 10] = [
    "最高", "最多", "最大", "最快", "最长", "最贵", "最富", "领先", "居首", "第一",
];
const MIN_ZH: [&str; 8] = [
    "最低",
    "最少",
    "最小",
    "最慢",
    "最短",
    "最便宜",
    "最穷",
    "垫底",
];
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

/// The count a question's characters spell from `at` on (3, 十二, 两): its digits or its Chinese numerals up to 九十九,
/// with the number of characters it took; None when no count starts there.
fn count_at(chars: &[char], at: usize) -> Option<(usize, usize)> {
    let digit = |c: char| {
        "零一二三四五六七八九"
            .find(c)
            .map(|i| i / 3)
            .or((c == '两').then_some(2))
    };
    let rest: String = chars
        .get(at..)?
        .iter()
        .take_while(|c| c.is_ascii_digit() || "一二两三四五六七八九十".contains(**c))
        .collect();
    let len = rest.chars().count();
    if len == 0 {
        return None;
    }
    if let Ok(n) = rest.parse::<usize>() {
        return Some((n, len));
    }
    let r: Vec<char> = rest.chars().collect();
    match r.as_slice() {
        ['十'] => Some(10),
        [a] => digit(*a),
        ['十', b] => digit(*b).map(|b| 10 + b),
        [a, '十'] => digit(*a).map(|a| a * 10),
        [a, '十', b] => digit(*a).zip(digit(*b)).map(|(a, b)| a * 10 + b),
        _ => None,
    }
    .map(|n| (n, len))
}

/// The first count after 前 or 后 (前五, 前 3), as in a top or bottom n.
fn count_after(q: &str, mark: char) -> Option<usize> {
    let chars: Vec<char> = q.chars().collect();
    chars
        .iter()
        .enumerate()
        .filter(|(_, c)| **c == mark)
        .find_map(|(i, _)| count_at(&chars, i + 1).map(|(n, _)| n))
}

/// The count right after a highest or lowest word, with a counter after it (最高的三个, 最低的五个, 最慢的 3 个): the
/// first n at one end, and whether it is the low end. A count without a counter ("最高的 2023 年") is not one.
fn count_after_extreme(q: &str) -> Option<(usize, bool)> {
    let chars: Vec<char> = q.chars().collect();
    let ends = MAX_ZH
        .iter()
        .map(|w| (w, false))
        .chain(MIN_ZH.iter().map(|w| (w, true)));
    ends.filter_map(|(w, low)| {
        q.find(w)
            .map(|b| (q[..b].chars().count() + w.chars().count(), low))
    })
    .find_map(|(at, low)| {
        let at = at + usize::from(chars.get(at) == Some(&'的'));
        let (n, len) = count_at(&chars, at)?;
        "个名位国家"
            .contains(*chars.get(at + len)?)
            .then_some((n, low))
    })
}

/// The relation a question asks, by its words, in a fixed order: a line or catching up first, then a flow, the parts of a
/// whole, a total, one place against the others, a change, a map, a spread; a ranking when none of them is asked.
pub fn relation(question: &str) -> Rel {
    let q = plain(question);
    let year_range = matches!(years_of(question), Some((a, Some(b))) if a < b)
        || matches!(years_of(question), Some((_, None)));
    if any(&q, &THRESHOLD_ZH) || (q.contains("哪年") && any(&q, &["超过", "达到", "高于", "低于"]))
    {
        Rel::Threshold
    } else if any(&q, &FLOW_ZH) {
        Rel::Flow
    } else if any(&q, &COMPOSITION_ZH) {
        Rel::Composition
    } else if any(&q, &MAGNITUDE_ZH) {
        Rel::Magnitude
    } else if any(&q, &DEVIATION_ZH) {
        Rel::Deviation
    } else if any(&q, &CHANGE_ZH) || (year_range && !q.contains("各年") && !q.contains("每年"))
    {
        Rel::Change
    } else if any(&q, &LOCATION_ZH) {
        Rel::Location
    } else if any(&q, &DISTRIBUTION_ZH) {
        Rel::Distribution
    } else {
        Rel::Ranking
    }
}

/// Whether the question asks for the lowest of its places (the lowest one or the last n), by its words: the focus of its
/// relation (relation, focus) is Min or Bottom. A question that asks both ends (MaxMin), a change, or anything else: false.
pub fn asks_lowest(question: &str) -> bool {
    matches!(
        focus(question, relation(question), None),
        Focus::Min | Focus::Bottom(_)
    )
}

/// The first n at one end a question asks for (前三, 最高的五个, 倒数后三, 最低的五个), by its words: the focus of its
/// relation is Top(n) or Bottom(n), with whether it is the low end. Anything else (the highest one, both ends, a change): None.
pub fn asks_top(question: &str) -> Option<(usize, bool)> {
    match focus(question, relation(question), None) {
        Focus::Top(n) => Some((n, false)),
        Focus::Bottom(n) => Some((n, true)),
        _ => None,
    }
}

/// Whether the question asks how its places fell (各降了多少, 降得最多, 减少了多少): a change asked (its relation Change) with a
/// falling word (DOWN_ZH) and no rising word (UP_ZH), by its words. A change page leads with the largest fall then, not with a
/// rise that ties or outnumbers the falls (dev e11, rounds 17-19: 各降了多少 over two rises and two falls led with a rise).
pub fn asks_fall(question: &str) -> bool {
    let q = plain(question);
    relation(question) == Rel::Change && any(&q, &DOWN_ZH) && !any(&q, &UP_ZH)
}

/// Whether the question asks where one place stands in its ranking (排第几, 排在, 位置): the focus of its relation is Position.
pub fn asks_position(question: &str) -> bool {
    matches!(
        focus(question, relation(question), None),
        Focus::Position(_)
    )
}

/// Whether the question asks for the total of its places (合计, 总共: the relation Magnitude, its focus Total), by its words.
pub fn asks_total(question: &str) -> bool {
    relation(question) == Rel::Magnitude
}

/// The second place a question compares its end with, by its words (SECOND_HIGH_ZH: the top's; SECOND_LOW_ZH: the
/// bottom's; SECOND_ANY_ZH: the end the question asks about, the bottom's when it asks for the lowest, asks_lowest):
/// Some(false) at the top, Some(true) at the bottom. None when it names no second place, or when it asks for
/// the first n at one end (asks_top: that page draws only those n and says its end against its neighbour).
pub fn asks_second(question: &str) -> Option<bool> {
    if asks_top(question).is_some() {
        return None;
    }
    let q = plain(question);
    if any(&q, &SECOND_LOW_ZH) {
        Some(true)
    } else if any(&q, &SECOND_HIGH_ZH) {
        Some(false)
    } else if any(&q, &SECOND_ANY_ZH) {
        Some(asks_lowest(question))
    } else {
        None
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
            if q.contains("第几") || q.contains("排第") || q.contains("排在") || q.contains("位置")
            {
                Focus::Position(first_place.unwrap_or("").to_string())
            } else if let Some(n) = count_after(&q, '前') {
                Focus::Top(n)
            } else if let Some(n) =
                count_after(&q, '后').filter(|_| q.contains("排名后") || q.contains("倒数"))
            {
                Focus::Bottom(n)
            } else if let Some((n, low)) = count_after_extreme(&q) {
                if low {
                    Focus::Bottom(n)
                } else {
                    Focus::Top(n)
                }
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
pub fn sentence(
    rel: Rel,
    focus: &Focus,
    places: &[String],
    quantity: &str,
    years: &Years,
) -> String {
    let who = if places.is_empty() {
        "各地".to_string()
    } else {
        places.join("、")
    };
    let span = match *years {
        Some((a, Some(b))) if a < b => format!("{a}到{b}年，"),
        Some((a, Some(_))) => format!("{a}年，"),
        Some((a, None)) if a < 0 => format!("近{}年，", -a),
        Some((a, None)) => format!("{a}年到{{last.year}}年，"),
        None => "{year}年，".to_string(),
    };
    match (rel, focus) {
        (_, Focus::Against(x)) => format!("{span}{x}的{quantity}比其余各地分别{{高或低}}{{each.d}}"),
        (_, Focus::FirstPast) => "{first.name}在{first.year}年最早过线{line}，到{last.year}年仍有{n.below}个未过线".to_string(),
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Shape {
    /// The first quantity's leader and its position in the others (sample A).
    RankCompare = 1,
    /// A line, the year a group and each member passed it, the members still below (sample B).
    ThresholdTime = 2,
    /// A whole: its total, its parts, its flows (sample C).
    TotalToParts = 3,
}

pub const SHAPES: [Shape; 3] = [
    Shape::RankCompare,
    Shape::ThresholdTime,
    Shape::TotalToParts,
];

/// Each shape's number, its Chinese name, what it answers (the words the shape request shows the model), and the fewest
/// quantities it takes: the one list both the request's check (the flow group's, which reads it as vocabulary) and
/// check_reply hold a reply against.
pub const SPLIT_TERMS: [(u8, &str, &str, usize); 3] = [
    (1, "名次对照", "the place first (or last) on one quantity, then that place's position on each other quantity the question names", 2),
    (2, "过线和时间", "a line: the year the group and each of its members passed it, and the members still below it at the last year", 1),
    (3, "由总到分", "a whole: its total, the parts it is made of, and where it goes", 1),
];

impl Shape {
    pub fn number(self) -> u8 {
        self as u8
    }
    pub fn from_number(n: u8) -> Option<Shape> {
        SHAPES.into_iter().find(|s| s.number() == n)
    }
}

/// The shape request: the shapes in the order offered (the preselected one first, with the words that matched), and the
/// quantities the question names, in its order, as the slot values a reply picks from by index.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SplitAsk {
    pub offered: Vec<(Shape, Option<&'static str>)>,
    pub quantities: Vec<(String, String)>,
}

/// A reply: a shape number (0: none of them) and, for the shape, the quantities by their index in the request, in the
/// order the blocks take them (empty: the question's order).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SplitReply {
    pub number: u8,
    pub quantities: Vec<usize>,
}

/// The shape the question's words point to, and the words: the program's preselection, offered first; not a decision.
pub fn preselect(c: &Catalog, question: &str) -> Option<(Shape, &'static str)> {
    let q = plain(question);
    // the also-word after a leader asked (人最多的，是不是也最富): a leader's positions; without one (增长快的是不是排放也快),
    // or with 越 (最低气温越低，用电量是不是也越高: 最 there is the measure's name), it is the relation of two quantities,
    // which the scope refusal keeps refusing (works/complex-split/design.md)
    if let Some((at, w)) = ALSO_ZH
        .iter()
        .copied()
        .filter_map(|w| q.find(w).map(|at| (at, w)))
        .min()
    {
        if leader_asked(&q[..at]) && !q.contains('越') && asked_zh_in_order(question).len() >= 2 {
            return Some((Shape::RankCompare, w));
        }
    }
    let first = one_block(c, question).blocks.first().map(|b| b.rel);
    if first == Some(Rel::Threshold) {
        if let Some(w) = EACH_ZH.iter().copied().find(|w| q.contains(w)) {
            return Some((Shape::ThresholdTime, w));
        }
    }
    if let (Some(_), Some(w)) = (
        FROM_ZH.iter().copied().find(|w| q.contains(w)),
        TO_ZH.iter().copied().find(|w| q.contains(w)),
    ) {
        return Some((Shape::TotalToParts, w));
    }
    None
}

/// Whether the words ask for a leader: a 最 followed within four characters by 的 (人最多的, 人均GDP最高的), the place
/// that leads, not a measure named with 最 (最低工资).
fn leader_asked(head: &str) -> bool {
    let chars: Vec<char> = head.chars().collect();
    chars
        .iter()
        .enumerate()
        .any(|(i, &ch)| ch == '最' && chars[i + 1..].iter().take(5).skip(1).any(|&c| c == '的'))
}

/// The shape request of a question: the preselected shape first, the others after in number order.
pub fn split_ask(c: &Catalog, question: &str) -> SplitAsk {
    let pre = preselect(c, question);
    let mut offered: Vec<(Shape, Option<&'static str>)> =
        pre.map(|(s, w)| (s, Some(w))).into_iter().collect();
    offered.extend(
        SHAPES
            .into_iter()
            .filter(|s| pre.map(|p| p.0) != Some(*s))
            .map(|s| (s, None)),
    );
    let quantities = asked_zh_in_order(question)
        .into_iter()
        .map(|a| (a.id, a.zh))
        .collect();
    SplitAsk {
        offered,
        quantities,
    }
}

/// A reply checked against its request: a shape number offered or 0, quantity indexes in range and not repeated, and as
/// many as the shape takes (名次对照 two or more, the others one). A refusal names the allowed values and an example.
pub fn check_reply(ask: &SplitAsk, reply: &SplitReply) -> Result<(), String> {
    let allowed = format!(
        "shape: 0 (none of them) or {}; quantities: indexes 0..{} in the order the blocks take them",
        ask.offered.iter().map(|(s, _)| s.number().to_string()).collect::<Vec<_>>().join(", "),
        ask.quantities.len()
    );
    let example = match ask.offered.first() {
        Some((Shape::RankCompare, _)) => format!(
            "{{\"shape\":1,\"quantities\":[{}]}}",
            (0..ask.quantities.len().max(2))
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ),
        Some((s, _)) => format!("{{\"shape\":{},\"quantities\":[0]}}", s.number()),
        None => "{\"shape\":0,\"quantities\":[]}".to_string(),
    };
    let refuse = |why: &str| Err(format!("{why}; allowed: {allowed}; example: {example}"));
    if reply.number == 0 {
        return Ok(());
    }
    let Some(shape) = Shape::from_number(reply.number) else {
        return refuse("no such shape");
    };
    if reply.quantities.iter().any(|&i| i >= ask.quantities.len()) {
        return refuse("a quantity index past the list");
    }
    let mut seen = reply.quantities.clone();
    seen.sort_unstable();
    seen.dedup();
    if seen.len() != reply.quantities.len() {
        return refuse("a quantity picked twice");
    }
    let n = if reply.quantities.is_empty() {
        ask.quantities.len()
    } else {
        reply.quantities.len()
    };
    let (_, name, _, least) = SPLIT_TERMS
        .into_iter()
        .find(|t| t.0 == shape.number())
        .expect("every shape has its terms");
    if n < least {
        return refuse(&format!(
            "{name} takes {least} quantities or more, and the reply gives {n}"
        ));
    }
    Ok(())
}

/// The plan of a question on the catalogue `c` with the preselected shape taken as the reply (the replay and the tests;
/// on the flow the model's reply is taken, plan_for).
#[cfg(test)]
pub fn plan(c: &Catalog, question: &str) -> Plan {
    let shape = preselect(c, question).map_or(0, |(s, _)| s.number());
    plan_for(
        c,
        question,
        &SplitReply {
            number: shape,
            quantities: vec![],
        },
    )
}

/// The plan of a question for a checked reply: the shape's template, or, for 0 or a shape whose slots the question cannot
/// fill, its best one block marked partial (the page says it answers only part of the question; graded 没答全).
/// - 名次对照: a block per quantity in the reply's order, the first its highest (or lowest, when the words before the
///   also-word ask the lowest), each later one that place's position;
/// - 过线和时间: the group's own whole when it has rows of its own, each member's year, the members still below at the
///   last year (needs a line: the one block reads a threshold);
/// - 由总到分: its total, its parts, its flows.
pub fn plan_for(c: &Catalog, question: &str, reply: &SplitReply) -> Plan {
    let mut one = one_block(c, question);
    let Some(b) = one.blocks.first().cloned() else {
        return one;
    };
    let all: Vec<(String, String)> = asked_zh_in_order(question)
        .into_iter()
        .map(|a| (a.id, a.zh))
        .collect();
    let picked: Vec<(String, String)> = if reply.quantities.is_empty() {
        all
    } else {
        reply
            .quantities
            .iter()
            .filter_map(|&i| all.get(i).cloned())
            .collect()
    };
    let q = plain(question);
    let with = |rel: Rel, focus: Focus, quantity: Vec<(String, String)>| {
        let name = quantity
            .first()
            .map_or("{quantity}".to_string(), |(_, zh)| zh.clone());
        let sentence = sentence(rel, &focus, &b.place_words, &name, &b.years);
        Block {
            rel,
            focus,
            quantity,
            sentence,
            ..b.clone()
        }
    };
    let first = |picked: &[(String, String)]| {
        picked
            .first()
            .map_or(b.quantity.clone(), |x| vec![x.clone()])
    };
    let blocks = match Shape::from_number(reply.number) {
        Some(Shape::RankCompare) if picked.len() >= 2 => {
            let head = ALSO_ZH
                .iter()
                .filter_map(|w| q.find(w))
                .min()
                .map_or(q.as_str(), |at| &q[..at]);
            let low = any(head, &MIN_ZH) && !any(head, &MAX_ZH);
            let lead = if low { "{b1.min.name}" } else { FIRST_LEADER };
            let mut blocks = vec![with(
                Rel::Ranking,
                if low { Focus::Min } else { Focus::Max },
                vec![picked[0].clone()],
            )];
            for a in &picked[1..] {
                blocks.push(with(
                    Rel::Ranking,
                    Focus::Position(lead.to_string()),
                    vec![a.clone()],
                ));
            }
            blocks
        }
        Some(Shape::ThresholdTime) if b.rel == Rel::Threshold => {
            let quantity = first(&picked);
            let mut blocks = Vec::new();
            if group_aggregate_zh(question).is_some() {
                blocks.push(with(
                    Rel::Threshold,
                    Focus::WholeFirstPast,
                    quantity.clone(),
                ));
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
            one.partial = reply.number != 0 || preselect(c, question).is_some();
            return one;
        }
    };
    Plan {
        blocks,
        partial: false,
    }
}

/// The one-block plan of a question on the catalogue `c`.
fn one_block(c: &Catalog, question: &str) -> Plan {
    let (_, words) = c.scope(question);
    let mut places: Vec<String> = c
        .places(question)
        .into_iter()
        .filter_map(|p| {
            if let Place::Country(x) = p {
                Some(x)
            } else {
                None
            }
        })
        .collect();
    places.extend(listed_aggregates(question));
    if let Some(r) = rank_asked_zh(question) {
        places.push(format!("rank:{}", r.by));
    }
    let quantity: Vec<(String, String)> = asked_zh(question)
        .into_iter()
        .map(|a| (a.id, a.zh))
        .collect();
    let years = years_of(question);
    let rel = relation(question);
    let focus = focus(question, rel, words.first().map(String::as_str));
    let q_name = quantity
        .first()
        .map_or("{quantity}".to_string(), |(_, zh)| zh.clone());
    let sentence = sentence(rel, &focus, &words, &q_name, &years);
    Plan {
        blocks: vec![Block {
            rel,
            focus,
            places,
            place_words: words,
            years,
            quantity,
            sentence,
        }],
        partial: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every relation a rank-compare, threshold or whole-to-parts block takes either has its recipe relation or leaves it to
    /// the table step: a rank block is drawn as a ranking (sample A's fourth run drew its rank blocks as changes).
    #[test]
    fn a_rank_block_is_drawn_as_a_ranking() {
        let of = |r: Rel| {
            RECIPE_RELATIONS
                .iter()
                .find(|(x, _)| *x == r)
                .map(|(_, y)| *y)
        };
        assert_eq!(
            of(Rel::Ranking),
            Some(crate::shape_registry::Relation::Ranking)
        );
        assert_eq!(
            of(Rel::Location),
            Some(crate::shape_registry::Relation::Map)
        );
        assert_eq!(
            of(Rel::Threshold),
            None,
            "no recipe answers a threshold yet: the table step's relation stands"
        );
        let rels: Vec<Rel> = RECIPE_RELATIONS.iter().map(|(r, _)| *r).collect();
        assert!(
            rels.iter().enumerate().all(|(i, r)| !rels[..i].contains(r)),
            "a relation once"
        );
    }

    /// A question asks for the lowest when its focus is the lowest one or the last n (sentences written for the test): not
    /// when it asks both ends, the highest, or a change.
    #[test]
    fn a_question_asks_for_the_lowest_by_its_focus() {
        for q in [
            "2024 年欧盟哪个国家的失业率最低？",
            "人均 GDP 排名倒数后五的国家是哪些？",
        ] {
            assert!(asks_lowest(q), "{q}");
        }
        for q in [
            "2024 年欧盟哪个国家的失业率最高？",
            "欧盟各国失业率谁最高谁最低？",
            "2015 年到 2024 年哪国失业率降得最多？",
            "东盟各国人均 GDP 排名",
        ] {
            assert!(!asks_lowest(q), "{q}");
        }
    }

    /// A question asks for the first n at one end by 前n, 倒数后n, or a highest or lowest word with a count and a counter
    /// after it (sentences written for the test, in the bank's wordings): not for the highest or lowest one, both ends, a
    /// year after the word, or a change.
    #[test]
    fn a_question_asks_for_the_first_n_at_one_end() {
        for (q, want) in [
            ("2024 年，经合组织国家里失业率最高的三个是谁？", (3, false)),
            (
                "二十国集团里，2023 年每百人移动电话签约数最高的五个是谁？",
                (5, false),
            ),
            (
                "东盟十国 2024 年的实际经济增长率，最慢的三个是谁？",
                (3, true),
            ),
            (
                "2023 年欧盟各国人均 GDP（按购买力标准）最低的五个是谁？",
                (5, true),
            ),
            ("2024 年欧盟各国高等教育学历的比例，前五是谁？", (5, false)),
            ("人均 GDP 排名倒数后五的国家是哪些？", (5, true)),
            ("欧盟失业率最高的 12 个国家", (12, false)),
            ("欧盟失业率最高的十二个国家", (12, false)),
        ] {
            assert_eq!(asks_top(q), Some(want), "{q}");
        }
        for q in [
            "2024 年欧盟哪个国家的失业率最高？",
            "欧盟各国失业率谁最高谁最低？",
            "失业率最高的 2023 年是哪年？",
            "2015 年到 2023 年，欧盟各国温室气体排放降幅最大的五个是谁？",
            "东盟各国人均 GDP 排名",
        ] {
            assert_eq!(asks_top(q), None, "{q}");
        }
        assert!(asks_lowest(
            "东盟十国 2024 年的实际经济增长率，最慢的三个是谁？"
        ));
    }

    /// A question asks for the total when its relation is Magnitude (合计, 总共; sentences written for the test): not when it
    /// asks a ranking, the lowest or a change.
    #[test]
    fn a_question_asks_for_the_total_by_its_relation() {
        for q in [
            "海合会六国 GDP 合计是多少？",
            "七国集团最近一年的人口合计是多少？",
        ] {
            assert!(asks_total(q), "{q}");
        }
        for q in [
            "2024 年欧盟哪个国家的失业率最低？",
            "东盟各国人均 GDP 排名",
            "2015 年到 2024 年哪国失业率降得最多？",
        ] {
            assert!(!asks_total(q), "{q}");
        }
    }

    /// A question that asks where one place stands in its ranking (排第几) is read as such; the highest, a first n, a
    /// change, a total, or a ranking with no place asked is not.
    #[test]
    fn a_question_asking_where_a_place_stands_is_read_from_its_words() {
        for q in [
            "2024 年人口最多的十个国家里，某国排第几？",
            "欧盟各国失业率，某国排第几？",
            "东盟各国人均 GDP，某国排在第几位？",
        ] {
            assert!(asks_position(q), "{q}");
        }
        for q in [
            "2024 年人口最多的十个国家是哪些？",
            "欧盟各国失业率谁最高？",
            "东盟各国人均 GDP 最高的三个是谁？",
            "2015 年到 2024 年哪国失业率降得最多？",
            "东盟各国人口合计多少？",
        ] {
            assert!(!asks_position(q), "{q}");
        }
    }

    /// A change asked with a falling word and no rising word asks how its places fell (dev e11 over rounds 17-19, n38, vc5);
    /// a rise, both ways, a level, or a falling word inside a measure's name (降水) is not.
    #[test]
    fn a_question_asking_how_places_fell_is_read_from_its_words() {
        for q in [
            "2010 年以来，中国、印度、印尼、泰国的 PM2.5 年均浓度各降了多少？",
            "2000 年到 2023 年，撒哈拉以南非洲、南亚、中东和北非的总和生育率各降了多少？",
            "2015 年到 2023 年，欧盟各国温室气体排放降幅最大的五个是谁？",
            "2015 年到 2024 年哪国失业率降得最多？",
        ] {
            assert!(asks_fall(q), "{q}");
        }
        for q in [
            "2010 年到 2020 年各国人口各增长了多少？",
            "2010 年到 2024 年各国房价的涨跌",
            "撒哈拉以南非洲、南亚、东亚，2000 年到 2023 年能用上电的人口比例各怎么变？",
            "欧盟各国失业率最新排名",
            "2024 年欧盟各国年降水量最多的是哪国？",
        ] {
            assert!(!asks_fall(q), "{q}");
        }
    }

    /// A question that compares its end with the second place (sentences written for the test): the top's or the bottom's,
    /// and none for a question naming no second place or asking for the first n.
    #[test]
    fn a_question_names_the_second_place_it_compares_with() {
        for (q, low) in [
            ("2023 年东盟谁的出口额最高？比第二高的多多少？", false),
            ("北欧五国里人均 GDP 第二名是谁，和第一差多少？", false),
            ("欧盟哪国失业率最低？比倒数第二的低多少？", true),
            ("2024 年欧盟哪国失业率最低？第二名是谁？", true),
        ] {
            assert_eq!(asks_second(q), Some(low), "{q}");
        }
        for q in [
            "2024 年欧盟哪个国家的失业率最低？",
            "七国集团研发投入最高的三个国家",
            "海合会六国 GDP 合计是多少？",
        ] {
            assert_eq!(asks_second(q), None, "{q}");
        }
    }

    /// The relation and focus of question shapes the dev set and the exam hold (not their texts).
    #[test]
    fn a_question_reads_as_its_relation_and_focus() {
        let cases: [(&str, Rel, Focus); 12] = [
            (
                "2010 年到 2020 年各国的总和生育率各降了多少？哪国降得最多？",
                Rel::Change,
                Focus::MostDown,
            ),
            (
                "韩国比日本、美国的人均寿命长多少？",
                Rel::Deviation,
                Focus::Against("韩国".into()),
            ),
            ("欧盟各国哪年跨过 20%？", Rel::Threshold, Focus::FirstPast),
            (
                "德国的能源从哪来、用到哪去？",
                Rel::Flow,
                Focus::LargestFlow,
            ),
            ("欧盟各国发电结构", Rel::Composition, Focus::LargestPart),
            ("海合会六国 GDP 合计是多少？", Rel::Magnitude, Focus::Total),
            ("2023 年金砖国家 GDP 增速排名", Rel::Ranking, Focus::Max),
            ("欧盟各国最低工资谁最低？", Rel::Ranking, Focus::Min),
            ("七国集团研发投入占比的高低", Rel::Ranking, Focus::MaxMin),
            (
                "意大利的青年失业率在欧盟排第几？",
                Rel::Ranking,
                Focus::Position("意大利".into()),
            ),
            ("人口最多的前五个国家", Rel::Ranking, Focus::Top(5)),
            (
                "中国的城镇化率 2000 年以来怎么变？",
                Rel::Change,
                Focus::Each,
            ),
        ];
        for (q, rel, f) in cases {
            assert_eq!(relation(q), rel, "{q}");
            let first = if q.starts_with("韩国") {
                Some("韩国")
            } else if q.starts_with("意大利") {
                Some("意大利")
            } else {
                None
            };
            assert_eq!(focus(q, rel, first), f, "{q}");
        }
        assert!(
            sentence(Rel::Ranking, &Focus::Max, &["德国".into()], "人口", &None)
                .contains("{max.name}")
        );
        let s = sentence(
            Rel::Change,
            &Focus::MostDown,
            &[],
            "人口",
            &Some((2000, Some(2020))),
        );
        assert_eq!(
            s, "2000到2020年，各地中{down.name}的人口降得最多，{down.d}",
            "the question's years and placeholders only"
        );
        assert_eq!(
            years_of("各国 65 岁以上人口比例近十年变化"),
            Some((-10, None))
        );
        assert_eq!(years_of("过去 5 年的房价"), Some((-5, None)));
        assert_eq!(years_of("2015 到 2024 年"), Some((2015, Some(2024))));
        assert_eq!(years_of("各国人口"), None);
        // owner 11-16 13:1x: 最近一年 is the latest year; N 年来 / N 年变化 the last N years; a lone year inside the last N
        // years asked is a point in them, not the span; a calendar year before 年来 is no count
        assert_eq!(years_of("南非、巴西最近一年的通胀率谁高"), None);
        assert_eq!(years_of("最近 1 年的失业率"), None);
        assert_eq!(years_of("欧盟各国出生人数十年来的变化"), Some((-10, None)));
        assert_eq!(
            years_of("德国、法国二十年来的能源进口依存度"),
            Some((-20, None))
        );
        assert_eq!(years_of("欧盟各国房价五年来涨了多少"), Some((-5, None)));
        assert_eq!(
            years_of("各国 65 岁以上人口比例十年变化"),
            Some((-10, None))
        );
        assert_eq!(
            years_of("印尼、越南近二十年的谷物单产怎么变？2015 年那一年有没有往下掉？"),
            Some((-20, None))
        );
        assert_eq!(years_of("2015 年印尼的谷物单产"), Some((2015, Some(2015))));
        assert_eq!(
            years_of("2010 年来的变化"),
            question_span("2010 年来的变化")
        );
        assert_eq!(years_of("近两年的房价"), Some((-2, None)));
    }

    /// The three many-block shapes (works/complex-split/design.md) give the blocks of the hand-written plans of complex
    /// samples A, B and C (works/complex-*/), each with at least one other question of its shape on other data; a
    /// question of none of them keeps its one block.
    #[test]
    fn three_question_shapes_give_the_blocks_of_the_hand_written_plans() {
        let c = crate::l5geo::test_world();
        let blocks = |q: &str| -> Vec<(Rel, Focus, Vec<String>)> {
            plan(&c, q)
                .blocks
                .into_iter()
                .map(|b| {
                    (
                        b.rel,
                        b.focus,
                        b.quantity.into_iter().map(|(id, _)| id).collect(),
                    )
                })
                .collect()
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
            [
                (Rel::Ranking, Focus::Max, ids(&["gdp_pc"])),
                (Rel::Ranking, lead, ids(&["urban_share"]))
            ]
        );
        let low = blocks("欧盟里人均GDP最低的，是否也城镇化率最低？");
        assert_eq!(
            (low[0].1.clone(), low[1].1.clone()),
            (Focus::Min, Focus::Position("{b1.min.name}".into()))
        );
        // B: a threshold asked of each member: the group's whole when it has rows of its own, each member, the rest below
        let b: Vec<(Rel, Focus)> = blocks("欧盟各国哪年跨过 20%？")
            .into_iter()
            .map(|(r, f, _)| (r, f))
            .collect();
        assert_eq!(
            b,
            [
                (Rel::Threshold, Focus::WholeFirstPast),
                (Rel::Threshold, Focus::EachFirstPast),
                (Rel::Ranking, Focus::BelowRest)
            ]
        );
        let b2 = blocks("欧盟各成员国的人均GDP哪年突破 3 万欧元？");
        assert_eq!(
            b2.iter().map(|x| x.1.clone()).collect::<Vec<_>>(),
            [
                Focus::WholeFirstPast,
                Focus::EachFirstPast,
                Focus::BelowRest
            ]
        );
        assert!(b2.iter().all(|x| x.2 == ids(&["gdp_pc"])), "{b2:?}");
        let asean: Vec<Focus> = blocks("东盟各国哪年城镇化率跨过 50%？")
            .into_iter()
            .map(|x| x.1)
            .collect();
        assert_eq!(
            asean,
            [Focus::EachFirstPast, Focus::BelowRest],
            "a group with no rows of its own has no whole"
        );
        // C: where a whole comes from and where it goes: its total, its parts, its flows
        let three = [
            (Rel::Magnitude, Focus::Total),
            (Rel::Composition, Focus::LargestPart),
            (Rel::Flow, Focus::LargestFlow),
        ];
        for q in [
            "德国的能源从哪来、用到哪去？",
            "法国的能源从哪里来，用在哪里？",
        ] {
            let got = blocks(q);
            assert_eq!(
                got.iter()
                    .map(|(r, f, _)| (*r, f.clone()))
                    .collect::<Vec<_>>(),
                three,
                "{q}"
            );
            assert!(
                got.iter().all(|x| x.2 == ids(&["energy_balance"])),
                "{q}: {got:?}"
            );
        }
        // none of the three shapes: one block, as before (the also-word with no 最 word before it asks two quantities'
        // relation, which the scope refusal keeps)
        for q in [
            "经济增长快的国家，是不是碳排放也增长快？",
            "各国最低气温越低，人均用电量是不是也越高？",
            "非洲各国人口越多，粮食进口是不是也越多？",
            "德国哪年跨过 20%？",
            "德国的能源从哪来？",
            "2023 年金砖国家 GDP 增速排名",
            "韩国比日本、美国的人均寿命长多少？",
            "人均GDP最高的是哪国？",
        ] {
            assert_eq!(plan(&c, q).blocks.len(), 1, "{q}");
        }
        // every block's sentence is the program's, numbers as placeholders
        for b in plan(&c, "东盟各国：人最多的，是不是也最富、最城市化？").blocks
        {
            let outside: String = b
                .sentence
                .split('{')
                .map(|part| part.split_once('}').map_or(part, |(_, rest)| rest))
                .collect();
            assert!(
                !outside.chars().any(|ch| ch.is_ascii_digit()),
                "{}",
                b.sentence
            );
        }
    }

    /// The model answers a shape number and slots (owner 11-14 16:0x item 5): the preselected shape is offered first;
    /// the reply's number is what counts, not the preselection; 0, or a shape the question cannot fill, gives one block
    /// marked partial; a reply out of the offered values is refused with the allowed values and an example.
    #[test]
    fn the_reply_shape_number_picks_the_template() {
        let c = crate::l5geo::test_world();
        let a = "东盟各国：人最多的，是不是也最富、最城市化？";
        assert_eq!(
            SPLIT_TERMS.map(|t| t.1),
            ["名次对照", "过线和时间", "由总到分"]
        );
        assert_eq!(
            SPLIT_TERMS.map(|t| t.0),
            SHAPES.map(Shape::number),
            "the terms follow the shapes"
        );
        let ask = split_ask(&c, a);
        assert_eq!(
            ask.offered
                .iter()
                .map(|(s, _)| s.number())
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(ask.offered[0].1, Some("是不是也"));
        assert_eq!(
            ask.quantities
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            ["population", "gdp_pc", "urban_share"]
        );
        let c_ask = split_ask(&c, "德国的能源从哪来、用到哪去？");
        assert_eq!(
            c_ask
                .offered
                .iter()
                .map(|(s, _)| s.number())
                .collect::<Vec<_>>(),
            [3, 1, 2],
            "preselected first"
        );
        assert!(
            split_ask(&c, "2023 年金砖国家 GDP 增速排名")
                .offered
                .iter()
                .all(|(_, w)| w.is_none()),
            "no preselection"
        );
        // the reply's order of quantities is the blocks' order
        let r = SplitReply {
            number: 1,
            quantities: vec![1, 0],
        };
        assert_eq!(check_reply(&ask, &r), Ok(()));
        let got: Vec<String> = plan_for(&c, a, &r)
            .blocks
            .into_iter()
            .map(|b| b.quantity[0].0.clone())
            .collect();
        assert_eq!(got, ["gdp_pc", "population"]);
        // another shape than the preselected one: that template (由总到分 on the first quantity picked)
        let p = plan_for(
            &c,
            a,
            &SplitReply {
                number: 3,
                quantities: vec![0],
            },
        );
        assert_eq!(
            p.blocks.iter().map(|b| b.rel).collect::<Vec<_>>(),
            [Rel::Magnitude, Rel::Composition, Rel::Flow]
        );
        assert!(!p.partial);
        // none of them: the one block, marked partial
        let none = plan_for(
            &c,
            a,
            &SplitReply {
                number: 0,
                quantities: vec![],
            },
        );
        assert_eq!((none.blocks.len(), none.partial), (1, true));
        // a shape whose slots the question cannot fill (no line read for 过线和时间): one block, partial
        let unfilled = plan_for(
            &c,
            "德国的能源从哪来、用到哪去？",
            &SplitReply {
                number: 2,
                quantities: vec![],
            },
        );
        assert_eq!((unfilled.blocks.len(), unfilled.partial), (1, true));
        // a plain one-block question is not partial
        assert!(!plan(&c, "2023 年金砖国家 GDP 增速排名").partial);
        // refusals carry the allowed values and an example
        for bad in [
            SplitReply {
                number: 7,
                quantities: vec![],
            },
            SplitReply {
                number: 1,
                quantities: vec![5],
            },
            SplitReply {
                number: 1,
                quantities: vec![0, 0],
            },
            SplitReply {
                number: 1,
                quantities: vec![2],
            },
        ] {
            let e = check_reply(&ask, &bad).unwrap_err();
            assert!(
                e.contains("allowed: shape: 0 (none of them) or 1, 2, 3")
                    && e.contains("example: {\"shape\":1,"),
                "{bad:?}: {e}"
            );
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
            let [qid, q, rest @ ..] = cols.as_slice() else {
                panic!("Q_CASES row without a tab: {line}")
            };
            let ask = split_ask(&c, q);
            println!(
                "ASK\t{qid}\t{}\t{}",
                ask.offered
                    .iter()
                    .map(|(s, w)| format!(
                        "{}{}",
                        s.number(),
                        w.map_or(String::new(), |w| format!("({w})"))
                    ))
                    .collect::<Vec<_>>()
                    .join(","),
                ask.quantities
                    .iter()
                    .enumerate()
                    .map(|(i, (id, _))| format!("{i}={id}"))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let p = match rest.first().filter(|r| !r.is_empty()) {
                None => plan(&c, q),
                Some(r) => {
                    let (n, qs) = r.split_once(':').unwrap_or((*r, ""));
                    let reply = SplitReply {
                        number: n.trim().parse().expect("shape number"),
                        quantities: qs
                            .split(',')
                            .filter(|x| !x.trim().is_empty())
                            .map(|x| x.trim().parse().expect("quantity index"))
                            .collect(),
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
                    b.quantity
                        .iter()
                        .map(|(id, _)| id.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                    b.sentence,
                    if partial { "partial" } else { "" }
                );
            }
        }
    }
}
