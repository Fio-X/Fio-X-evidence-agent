//! The answer plan (v5 design works/v5-answer-plan-design.md; a measurement prototype, built for tests only): a Chinese
//! question read by rule, with no model, into the places, the years, the quantity and the relation the page has to prove,
//! and the one sentence the page has to prove with its numbers left as placeholders (the program fills them from the
//! fetched rows, as it fills every number). The relations are the owner's nine of 2026-11-13, after the FT Visual
//! Vocabulary: what the question asks the page to show, not which chart draws it. A plan holds blocks, one sentence each;
//! a question gives one block for now (complex pages will give more). Not on the flow: the replay below prints the plans of
//! a question list, so they are judged against the rubrics before any flow code changes.

use crate::l5geo::{asked_zh, listed_aggregates, question_span, rank_asked_zh, Catalog, Place};

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

/// A plan: the blocks in reading order. One for every question for now.
#[derive(Clone, Debug)]
pub struct Plan {
    pub blocks: Vec<Block>,
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
    }
}

/// The plan of a question on the catalogue `c`: one block.
pub fn plan(c: &Catalog, question: &str) -> Plan {
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
    Plan { blocks: vec![Block { rel, focus, places, place_words: words, years, quantity, sentence }] }
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

    /// The plans of Q_CASES rows (qid, question) on the real catalogue, one line each: qid, relation number, focus, places,
    /// place words, years, quantity ids, sentence.
    /// L5GEO_DIR=<registry>/l5geo/catalog Q_CASES=<cases.tsv> cargo test answer_plan::tests::replay_answer_plans -- --include-ignored --nocapture
    #[test]
    #[ignore]
    fn replay_answer_plans() {
        let dir = std::path::PathBuf::from(std::env::var("L5GEO_DIR").expect("L5GEO_DIR"));
        let cases = std::fs::read_to_string(std::env::var("Q_CASES").expect("Q_CASES")).unwrap();
        let c = Catalog::load(&dir).unwrap();
        for line in cases.lines().filter(|l| !l.starts_with('#')) {
            let Some((qid, q)) = line.split_once('\t') else { panic!("Q_CASES row without a tab: {line}") };
            for b in plan(&c, q).blocks {
                let years = match b.years {
                    Some((a, Some(z))) => format!("{a}-{z}"),
                    Some((a, None)) if a < 0 => format!("last{}", -a),
                    Some((a, None)) => format!("{a}-latest"),
                    None => "latest".into(),
                };
                println!(
                    "PLAN\t{qid}\t{}\t{:?}\t{}\t{}\t{years}\t{}\t{}",
                    b.rel as u8,
                    b.focus,
                    b.places.join(","),
                    b.place_words.join(","),
                    b.quantity.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join(","),
                    b.sentence
                );
            }
        }
    }
}
