//! Flow side, the page's measure words: a chart's measure as the fetched table gives it (Measure), the measure kind of a unit
//! code and its short Chinese form (the unit-short-zh registry), the story dimension of a candidate kind, and the page title
//! naming its scope. Pure: no tool runs here, and nothing is filled that the run does not hold.

use crate::shape_registry::Axis;

/// The story dimension of a candidate kind (story_graph.mjs STORY_DIMENSIONS).
pub(crate) fn dimension(kind: &str) -> Option<&'static str> {
    match kind {
        "rank_top" | "rank_bottom" => Some("rank"),
        "extreme_gap"
        | "top_to_bottom_ratio"
        | "cut_top_share"
        | "cut_members_share"
        | "share_of_total" => Some("comparison"),
        "change_largest_rise"
        | "change_largest_fall"
        | "change_total"
        | "cut_members_largest_change"
        | "cut_total_change" => Some("trend"),
        _ => None,
    }
}

/// The tools' counts (story_graph.mjs, editorial.mjs, newsroom.ts schemas); not loosened here.
pub(crate) const MIN_NODES: usize = 3;
/// The page title's longest form (design_pack.mjs LIMITS.page_title).
const PAGE_TITLE_MAX: usize = 40;

/// The page title naming its scope: the place words the catalogue read in the question, each added only when the title
/// lacks it, as 「…（欧盟）」. The words are the catalogue's reading of the question (no model text); a title they would push past PAGE_TITLE_MAX stays
/// as it is. No year: page.title has no result rows to fill a placeholder from, so a typed year would be refused there.
pub fn scoped_title(title: &str, places_zh: &[String]) -> String {
    let mut scope: Vec<&str> = Vec::new();
    for place in places_zh
        .iter()
        .map(String::as_str)
        .filter(|p| !p.is_empty() && !title.contains(p))
    {
        if !scope.contains(&place) {
            scope.push(place);
        }
    }
    if scope.is_empty() {
        return title.to_string();
    }
    let scoped = format!("{title}（{}）", scope.join("，"));
    if scoped.chars().count() > PAGE_TITLE_MAX {
        title.to_string()
    } else {
        scoped
    }
}

/// What the fetched table says about a chart's measure: its catalogue title, the draft of its Chinese name, and the one
/// unit code it was fetched in with
/// that code's catalogue label (None when the fetch did not fix one unit).
#[derive(Clone, Debug, PartialEq)]
pub struct Measure {
    pub title: String,
    /// The title with its trailing "by …" breakdown swapped for the labels of the codes the fetch fixed (the model names
    /// the measure from this, so it never names a breakdown the chart does not draw).
    pub name: String,
    pub unit_code: Option<String>,
    pub unit_label: Option<String>,
    /// The measure kind of the unit (measure_semantics.mjs MEASURE_KINDS): a Eurostat code's by measure_kind, a World Bank
    /// indicator's as wb-units.tsv registers it; None when neither reads one.
    pub kind: Option<&'static str>,
    /// The time values the chart's series draws, sorted, no repeats.
    pub times: Vec<String>,
    /// What the chart lists along its category.
    pub axis: Axis,
    /// The chart's source line from the catalogue: the publisher, the table's id and title, and the years the chart draws.
    /// None when the catalogue does not list the table (the pack then writes its line from the data files).
    pub source: Option<String>,
}

/// The measure kind of a Eurostat unit code (measure_semantics.mjs MEASURE_KINDS), by the prefixes classify.rs
/// unit_additive reads; None for a code these do not cover, which is named, not guessed.
pub(crate) fn measure_kind(code: &str) -> Option<&'static str> {
    const COUNTS: [&str; 2] = ["NR", "PER"];
    const AMOUNTS: [&str; 5] = ["T", "KTOE", "TJ", "GWH", "EUR"];
    let base = ["THS_", "MIO_", "BN_"]
        .iter()
        .find_map(|p| code.strip_prefix(p))
        .unwrap_or(code);
    // An energy amount in a stated basis (TJ_GCV, TJ_NCV, KTOE_...) is still an amount; per inhabitant (_HAB) is not.
    let energy =
        ["KTOE_", "TJ_", "GWH_"].iter().any(|p| base.starts_with(p)) && !base.contains("HAB");
    let index = code.len() > 3
        && code.starts_with('I')
        && code[1..3].bytes().all(|b| b.is_ascii_digit())
        && &code[3..4] == "_";
    if code.starts_with("PCH") || code.starts_with("RCH") {
        Some("change")
    } else if code == "PC" || code == "PC_TOT" {
        // A part of its whole; another PC_ code (of GDP, of the population) is a ratio to something else, not guessed.
        Some("share")
    } else if code.starts_with("RT") || code.starts_with("P_") {
        Some("rate")
    } else if index {
        Some("index")
    } else if COUNTS.contains(&base) {
        Some("count")
    } else if AMOUNTS.contains(&base) || energy || code.starts_with("CLV") {
        Some("level")
    } else {
        None
    }
}

/// The registry of the short Chinese unit a chart label writes for a unit code (code, short form, rule), built offline from the
/// codes the catalogues give; compiled in, so a broken file fails its test, not a run.
const UNIT_SHORT_ZH: &str = include_str!("../runtime/pi/assets/unit-short-zh.tsv");

/// The short Chinese unit unit-short-zh.tsv registers for a code; None for no row or an empty form.
fn unit_short_zh(code: &str) -> Option<&'static str> {
    UNIT_SHORT_ZH.lines().skip(1).find_map(|line| {
        let mut p = line.trim_end_matches('\r').split('\t');
        (p.next() == Some(code))
            .then(|| p.next())
            .flatten()
            .filter(|s| !s.is_empty())
    })
}

/// The file stem of the short unit registry: where a short form is read from, for a page that names its row.
pub(crate) const UNIT_SHORT_ZH_TABLE: &str = "unit-short-zh";

/// The short form of a unit code: its registered short Chinese form ("%" for a percentage), else "%" for a plain percentage.
pub(crate) fn unit_short(code: &str) -> Option<&'static str> {
    unit_short_zh(code).or((code == "PC").then_some("%"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Why a page always has a second dimension for its text: every table gives CLAIMS_MIN picks or more, and the candidate
    /// sheet has fewer rank kinds than that, so a pick always holds a claim of another dimension. A page whose picks were
    /// all rank would stop at the publication's two-dimension rule with no page; this test is what keeps that from
    /// happening, so a new rank kind, or a kind with no dimension, has to come with a way to give the text another one.
    #[test]
    fn every_candidate_kind_has_a_dimension_and_a_pick_cannot_be_all_rank() {
        let sheet = include_str!("../runtime/pi/claim_candidates.mjs");
        let kinds: BTreeSet<&str> = sheet
            .split("add(\"")
            .skip(1)
            .filter_map(|rest| rest.split_once('"').map(|(kind, _)| kind))
            .collect();
        assert!(
            kinds.len() >= 10 && kinds.contains("rank_top") && kinds.contains("change_total"),
            "{kinds:?}"
        );
        for kind in &kinds {
            assert!(
                dimension(kind).is_some(),
                "candidate kind {kind} has no explanatory dimension"
            );
        }
        let rank: Vec<&&str> = kinds
            .iter()
            .filter(|kind| dimension(kind) == Some("rank"))
            .collect();
        assert!(
            rank.len() < crate::next_flow::CLAIMS_MIN,
            "rank kinds {rank:?} could fill a whole pick of {}",
            crate::next_flow::CLAIMS_MIN
        );
    }
    #[test]
    fn unit_codes_give_a_measure_kind_or_none() {
        let kinds: Vec<Option<&str>> = [
            "PC",
            "PC_GDP",
            "PCH_PRE",
            "RCH_A",
            "RT",
            "P_THAB",
            "I15_A_AVG",
            "THS_PER",
            "NR",
            "MIO_EUR",
            "CLV10_EUR",
            "KG_HAB",
            "TJ_GCV",
            "THS_TJ_NCV",
            "KTOE",
            "TJ_HAB",
        ]
        .iter()
        .map(|c| measure_kind(c))
        .collect();
        assert_eq!(
            kinds,
            [
                Some("share"),
                None,
                Some("change"),
                Some("change"),
                Some("rate"),
                Some("rate"),
                Some("index"),
                Some("count"),
                Some("count"),
                Some("level"),
                Some("level"),
                None,
                Some("level"),
                Some("level"),
                Some("level"),
                None
            ]
        );
        assert_eq!(unit_short("PC"), Some("%"));
        assert_eq!(unit_short("THS_T"), None);
        // A registered short form; a code registered with no sure form has none.
        assert_eq!(unit_short("TCO2E_HAB"), Some("吨二氧化碳当量/人"));
        assert_eq!(unit_short("PC_POP"), Some("%"));
        assert_eq!(unit_short("NR"), None);
    }

    #[test]
    fn unit_short_zh_registers_one_form_per_code_with_its_rule() {
        let mut rows = UNIT_SHORT_ZH.lines();
        assert_eq!(rows.next(), Some("code\tshort_zh\trule"));
        let mut seen = BTreeSet::new();
        for row in rows {
            let p: Vec<&str> = row.split('\t').collect();
            assert_eq!(p.len(), 3, "{row}");
            assert!(seen.insert(p[0]), "{} twice", p[0]);
            assert!(!p[2].is_empty(), "{row}: no rule");
        }
        // Every unit code the World Bank registry gives has a row (a form or a named empty one).
        let wb = include_str!("../runtime/pi/assets/wb-units.tsv");
        for row in wb.lines().skip(1) {
            let code = row.split('\t').nth(2).unwrap_or("");
            assert!(
                code.is_empty() || seen.contains(code),
                "{code}: no unit-short-zh row"
            );
        }
        // The two World Bank bench measures (q4, q5).
        assert_eq!(unit_short_zh("TCO2E_HAB"), Some("吨二氧化碳当量/人"));
        assert_eq!(unit_short_zh("PC_POP"), Some("%"));
    }

    #[test]
    fn the_title_names_the_scope_it_lacks() {
        let eu = ["欧盟".to_string()];
        assert_eq!(
            scoped_title("哪个国家可再生能源占比最高", &eu),
            "哪个国家可再生能源占比最高（欧盟）"
        );
        // what the title already says is not said again
        assert_eq!(
            scoped_title("欧盟各国可再生能源占比", &eu),
            "欧盟各国可再生能源占比"
        );
        assert_eq!(scoped_title("占比", &[]), "占比");
        // too long for the page title: left as written
        let long = "长".repeat(PAGE_TITLE_MAX - 3);
        assert_eq!(scoped_title(&long, &eu), long);
    }
}
