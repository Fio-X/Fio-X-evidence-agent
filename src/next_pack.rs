//! Flow side, the page's measure words: a chart's measure as the fetched table gives it (Measure), the measure kind of a unit
//! code and its short Chinese form (the unit-short-zh registry), the story dimension of a candidate kind, and the page title
//! naming its scope. Pure: no tool runs here, and nothing is filled that the run does not hold.

use crate::shape_registry::Axis;
use std::collections::{BTreeMap, BTreeSet};

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
}

/// The measure kind of a Eurostat unit code (measure_semantics.mjs MEASURE_KINDS), by the prefixes classify.rs
/// unit_additive reads; None for a code these do not cover, which is named, not guessed.
/// The measure kind of a unit code that is a change over time (PCH, RCH).
pub(crate) const CHANGE_KIND: &str = "change";

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
        Some(CHANGE_KIND)
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

/// The registry of the short Chinese unit a chart label writes for a unit code (code, short form, rule, additive, the suffix
/// a number prints, source, the catalogue's English label): reviewed rows kept as reviewed, the rest made by
/// scripts/gen_unit_short_zh.py from the catalogue's own unit labels (user 11-05 10:2x); compiled in, so a broken file fails
/// its test, not a run.
pub(crate) const UNIT_SHORT_ZH: &str = include_str!("../runtime/pi/assets/unit-short-zh.tsv");

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

/// What the page's unit line prints for a unit code (the row's line_zh): the short form with a rate of change's comparison
/// basis, read from the catalogue's label by scripts/gen_unit_short_zh.py (user 11-05 16:1x: the basis is on the page and
/// checked, the line printed as this registered name); the short form itself where the row gives no line_zh. None where
/// unit_short is none.
pub(crate) fn unit_line_form(code: &str) -> Option<&'static str> {
    let short = unit_short(code)?;
    let row = UNIT_SHORT_ZH
        .lines()
        .skip(1)
        .find(|l| l.split('\t').next() == Some(code));
    Some(
        row.and_then(|l| l.trim_end_matches('\r').split('\t').nth(7))
            .filter(|s| !s.is_empty())
            .unwrap_or(short),
    )
}

/// What a number prints after it in a unit code (the row's suffix_zh): never a digit, so an index ("指数(2015=100)", its
/// base year printed on the unit line as the registry's marked name) prints none; "%" for a plain percentage. None
/// where unit_short is none.
pub(crate) fn unit_number_suffix(code: &str) -> Option<&'static str> {
    unit_short(code)?;
    let row = UNIT_SHORT_ZH
        .lines()
        .skip(1)
        .find(|l| l.split('\t').next() == Some(code));
    Some(
        row.and_then(|l| l.trim_end_matches('\r').split('\t').nth(4))
            .unwrap_or("%"),
    )
}

/// The unit table's rule of a unit code (its third column: index_base, count, pct_family, ...), the key a node's fmt_change
/// may name a format by (by_rule); None where the table has no row or the row no rule.
pub(crate) fn unit_rule(code: &str) -> Option<&'static str> {
    UNIT_SHORT_ZH.lines().skip(1).find_map(|line| {
        let mut p = line.trim_end_matches('\r').split('\t');
        (p.next() == Some(code))
            .then(|| p.nth(1))
            .flatten()
            .filter(|s| !s.is_empty())
    })
}

/// Whether a unit code's values add up, by the unit table's additive column (USD and NR yes; per head, rates and indices
/// no); None where the table has no row.
pub(crate) fn unit_table_additive(code: &str) -> Option<bool> {
    UNIT_SHORT_ZH.lines().skip(1).find_map(|line| {
        let mut p = line.trim_end_matches('\r').split('\t');
        (p.next() == Some(code))
            .then(|| p.nth(2))
            .flatten()
            .and_then(|a| match a {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            })
    })
}

/// The magnitudes a page may print an amount at, largest first (owner 11-06 22:02: one magnitude for the whole page, chosen
/// by its largest number): the code suffix of the unit table's row that names it, the least value that takes it, and the
/// factor its numbers print at. A unit with no such row prints as the data gives it.
const MAGNITUDES: [(&str, f64, f64); 2] = [("_E12", 1e12, 1e-12), ("_E8", 1e8, 1e-8)];

/// The unit code and factor a page prints amounts in a code at, given the largest absolute value it prints: the first
/// magnitude the value reaches whose row the unit table holds; else the code itself at 1.
pub(crate) fn unit_at_magnitude(code: &str, largest: f64) -> (String, Option<f64>) {
    MAGNITUDES
        .iter()
        .map(|(tag, least, factor)| (format!("{code}{tag}"), *least, *factor))
        .find(|(scaled, least, _)| largest >= *least && unit_short(scaled).is_some())
        .map_or((code.to_string(), None), |(scaled, _, factor)| {
            (scaled, Some(factor))
        })
}

/// Whether amounts in a unit code compare across places: not when each place counts in its own currency (the row's rule
/// amount_own_currency, a World Bank "LCU" amount), so a page of two or more places in it has no common scale.
pub(crate) fn unit_compares_across_places(code: &str) -> bool {
    let row = UNIT_SHORT_ZH
        .lines()
        .skip(1)
        .find(|l| l.split('\t').next() == Some(code));
    row.and_then(|l| l.split('\t').nth(2)) != Some("amount_own_currency")
}

/// The catalogue's English label of a unit code, as the unit registry keeps it (its label_en); None for no row or none.
pub(crate) fn unit_label_en(code: &str) -> Option<&'static str> {
    let row = UNIT_SHORT_ZH
        .lines()
        .skip(1)
        .find(|l| l.split('\t').next() == Some(code))?;
    row.trim_end_matches('\r')
        .split('\t')
        .nth(6)
        .filter(|s| !s.is_empty())
}

/// The registry of the dimensions a table may carry its unit in when no unit dimension says it all (dims, codes, unit
/// code, evidence): a currency code, a currency with a quantity unit (a price), or a demography indicator code, each row
/// mapped to a code of the unit registry (unit-short-zh.tsv). Knowledge group data, read here as a word list; compiled in,
/// so a broken file fails its test, not a run.
pub(crate) const UNIT_CARRIERS: &str = include_str!("../runtime/pi/assets/unit-carriers.tsv");

/// The registry's rows as (dimensions, their codes in the same order, unit code).
fn unit_carrier_rows() -> impl Iterator<Item = (Vec<&'static str>, Vec<&'static str>, &'static str)>
{
    UNIT_CARRIERS.lines().skip(1).filter_map(|line| {
        let mut p = line.trim_end_matches('\r').split('\t');
        let (dims, codes, unit) = (p.next()?, p.next()?, p.next()?);
        Some((dims.split(',').collect(), codes.split(',').collect(), unit))
    })
}

/// The unit a table's series carry in another dimension (unit-carriers.tsv), given the codes each dimension of the rows
/// holds. A set of registered dimensions applies when the rows hold every one of them, it names `unit` exactly when the
/// rows have a unit dimension, and, naming it, the registry lists the rows' unit code with it (so a price's currency is
/// read only beside the quantity unit it is registered with). Ok(None) when no set applies: the unit dimension's own code
/// is the unit, as before. Err, naming what is missing, when a set applies but a dimension of it holds other than one code,
/// two sets apply, or the codes have no row: a currency or an indicator the registry does not map stays refused.
pub(crate) fn carried_unit(
    dims: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Option<&'static str>, String> {
    let rows: Vec<_> = unit_carrier_rows().collect();
    let unit_codes = dims.get("unit");
    let applies = |set: &[&str]| {
        set.iter().all(|d| dims.contains_key(*d))
            && set.contains(&"unit") == unit_codes.is_some()
            && unit_codes.is_none_or(|held| {
                let at = set.iter().position(|d| *d == "unit");
                rows.iter().any(|(s, codes, _)| {
                    s.as_slice() == set && at.is_some_and(|i| held.contains(codes[i]))
                })
            })
    };
    let sets: BTreeSet<&Vec<&str>> = rows
        .iter()
        .map(|(set, ..)| set)
        .filter(|set| applies(set.as_slice()))
        .collect();
    let set = match sets.into_iter().collect::<Vec<_>>().as_slice() {
        [] => return Ok(None),
        [one] => *one,
        many => {
            let named: Vec<String> = many.iter().map(|s| s.join(",")).collect();
            return Err(format!(
                "the unit is carried by two dimension sets: {}",
                named.join("; ")
            ));
        }
    };
    let mut codes = Vec::new();
    for d in set {
        match dims[*d].iter().collect::<Vec<_>>().as_slice() {
            [one] => codes.push(one.as_str()),
            held => {
                return Err(format!(
                    "the unit is carried by {d}, which holds {} codes, not one",
                    held.len()
                ))
            }
        }
    }
    rows.iter()
        .find(|(s, c, _)| s == set && *c == codes)
        .map(|(.., unit)| Some(*unit))
        .ok_or_else(|| {
            format!(
                "the unit is carried by {} {}, which has no row in unit-carriers",
                set.join(","),
                codes.join(",")
            )
        })
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
        assert_eq!(unit_short("THS_T"), Some("千吨"));
        // A registered short form; a code registered with no sure form has none.
        assert_eq!(unit_short("TCO2E_HAB"), Some("吨二氧化碳当量/人"));
        assert_eq!(unit_short("PC_POP"), Some("%"));
        // a count reads 数量 on its unit line and prints nothing after a number (generated, 11-05)
        assert_eq!(
            (unit_short("NR"), unit_number_suffix("NR")),
            (Some("数量"), Some(""))
        );
        assert_eq!(
            (unit_short("I15"), unit_number_suffix("I15")),
            (Some("指数(2015=100)"), Some(""))
        );
        assert_eq!(
            (unit_short("PC"), unit_number_suffix("PC")),
            (Some("%"), Some("%"))
        );
        assert_eq!(unit_number_suffix("XYZ"), None);
        // a rate of change keeps "%" as its short form and number suffix; its unit line says against what
        assert_eq!(
            (
                unit_short("PCH_SM"),
                unit_number_suffix("PCH_SM"),
                unit_line_form("PCH_SM")
            ),
            (Some("%"), Some("%"), Some("%（同比）"))
        );
        assert_eq!(unit_line_form("PCH_PRE"), Some("%（较上期）"));
        assert_eq!(
            (
                unit_line_form("PC"),
                unit_line_form("I15"),
                unit_line_form("XYZ")
            ),
            (Some("%"), Some("指数(2015=100)"), None)
        );
        // a rate of change whose label states no basis has no row (Annual average rate of change: against what is unsaid)
        assert_eq!(unit_short("RCH_A_AVG"), None);
        // a chain-linked volume's rate of change reads its basis past the price-basis prefix (n02's quarter on the same
        // quarter a year before); an annualized one or a chain-linked level is not read, and a chain-linked volume index is an
        // index of its base year (owner 11-20 17:3x) printing no suffix, as I15 does
        assert_eq!(
            (
                unit_short("CLV_PCH_SM"),
                unit_number_suffix("CLV_PCH_SM"),
                unit_line_form("CLV_PCH_SM")
            ),
            (Some("%"), Some("%"), Some("%（同比）"))
        );
        assert_eq!(unit_line_form("CLV_PCH_PRE"), Some("%（较上期）"));
        assert_eq!(
            (unit_short("CLV_PCH_ANN"), unit_short("CLV10_MEUR")),
            (None, None)
        );
        assert_eq!(
            (unit_short("CLV_I20"), unit_number_suffix("CLV_I20")),
            (Some("指数(2020=100)"), Some(""))
        );
        // a per-capita amount at current prices, in euro or in purchasing power standards (s4a)
        assert_eq!(
            (
                unit_line_form("CP_EUR_HAB"),
                unit_number_suffix("CP_EUR_HAB")
            ),
            (Some("欧元/人"), Some("欧元/人"))
        );
        assert_eq!(
            (
                unit_line_form("CP_PPS_EU27_2020_HAB"),
                unit_number_suffix("CP_PPS_EU27_2020_HAB")
            ),
            (Some("购买力标准/人"), Some("购买力标准/人"))
        );
        // a change against a year the label names prints that year as its basis (World Bank "% change from 1990", s6)
        assert_eq!(
            (
                unit_short("PCH_1990"),
                unit_number_suffix("PCH_1990"),
                unit_line_form("PCH_1990")
            ),
            (Some("%"), Some("%"), Some("%（较1990年）"))
        );
        // every World Bank change registered with a code prints a basis on its unit line: a change whose basis no rule
        // reads has no code, so the shape gate refuses it
        for row in include_str!("../runtime/pi/assets/wb-units.tsv")
            .lines()
            .skip(1)
        {
            let p: Vec<&str> = row.split('\t').collect();
            if p[4] == "change" && !p[2].is_empty() {
                assert_ne!(
                    unit_line_form(p[2]),
                    unit_short(p[2]),
                    "{row}: a registered change with no basis on its line"
                );
            }
        }
    }

    /// The unit table's rule and additive column as the page input reads them: an index's rule (its change in points), a
    /// percentage's; amounts and counts add up, per head and rates do not; a code with no row reads none.
    #[test]
    fn unit_rule_and_additive_read_the_unit_table() {
        assert_eq!(unit_rule("CLV_I20"), Some("index_base"));
        assert_eq!(unit_rule("PC"), Some("pct_family"));
        assert_eq!(unit_rule("NO_SUCH_UNIT"), None);
        for (code, adds) in [
            ("USD", Some(true)),
            ("NR", Some(true)),
            ("USD_HAB", Some(false)),
            ("PC", Some(false)),
            ("CLV_I20", Some(false)),
            ("NO_SUCH_UNIT", None),
        ] {
            assert_eq!(unit_table_additive(code), adds, "{code}");
        }
    }

    #[test]
    fn unit_short_zh_registers_one_form_per_code_with_its_rule() {
        let mut rows = UNIT_SHORT_ZH.lines();
        assert_eq!(
            rows.next(),
            Some("code\tshort_zh\trule\tadditive\tsuffix_zh\tsource\tlabel_en\tline_zh")
        );
        let mut seen = BTreeSet::new();
        for row in rows {
            let p: Vec<&str> = row.split('\t').collect();
            assert_eq!(p.len(), 8, "{row}");
            // what a number prints after it never holds a digit (the page tree's suffix rule); a generated row names the
            // catalogue label it was made from, and every digit of its form is that label's (a base year from the data)
            assert!(
                !p[4].chars().any(|c| c.is_ascii_digit()),
                "{row}: a digit in the number suffix"
            );
            assert!(matches!(p[5], "reviewed" | "generated"), "{row}: source");
            let digits = |t: &str| {
                t.split(|c: char| !c.is_ascii_digit())
                    .filter(|d| !d.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            };
            if p[5] == "generated" {
                assert!(
                    !p[6].is_empty() && !p[1].is_empty(),
                    "{row}: a generated row has its label and a form"
                );
            }
            if !p[6].is_empty() {
                assert!(
                    digits(p[1])
                        .iter()
                        .chain(&digits(p[7]))
                        .all(|d| digits(p[6]).contains(d)),
                    "{row}: a digit of the form is not the label's"
                );
            }
            // a rate of change prints its comparison basis on the unit line: a line form that starts with the short form and
            // says more (user 11-05 16:1x); a row that is no rate of change prints its short form
            let change = p[2] == "pct_change"
                || p[6].to_lowercase().starts_with("percentage change")
                || p[6].to_lowercase().starts_with("growth rate");
            assert_eq!(
                change,
                !p[7].is_empty(),
                "{row}: a rate of change, and only one, has a line form"
            );
            assert!(
                p[7].is_empty() || (p[7].starts_with(p[1]) && p[7].len() > p[1].len()),
                "{row}: the line form is the short form and its basis"
            );
            assert!(seen.insert(p[0]), "{} twice", p[0]);
            assert!(!p[2].is_empty(), "{row}: no rule");
            // B1 (owner 11-04): whether amounts in the unit add up, which the core reads (a share of a sum says
            // something only then): yes for a count or an amount, no for a share, a rate, a ratio or an index
            assert!(matches!(p[3], "yes" | "no"), "{row}: additive is yes or no");
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
        // of the World Bank rate bases the owner approved (11-14 15:2x), the one whose Chinese form the number check lets
        // through (owner 11-14 20:2x): the indicator's row names the code, the code its form
        let code_of = |ind: &str| {
            wb.lines()
                .find(|l| l.starts_with(&format!("{ind}\t")))
                .and_then(|l| l.split('\t').nth(2))
        };
        assert_eq!(
            code_of("SP.DYN.AMRT.FE").and_then(unit_short_zh),
            Some("每千名成年女性")
        );
        // the others keep no unit code (20:2x: each form holds a number word the number check refuses, 十万, 十五), nor do
        // the two the owner left out on 15:2x (a base the Chinese form would lose, a bank name that drops 成年)
        for ind in [
            "FB.ATM.TOTL.P5",
            "FB.CBK.BRCH.P5",
            "SH.STA.MMRT",
            "SH.STA.MMRT.NE",
            "SP.ADO.TFRT",
            "IC.BUS.NDNS.ZS",
            "SP.DYN.AMRT.MA",
        ] {
            assert_eq!(code_of(ind), Some(""), "{ind}");
        }
        let additive = |code: &str| {
            UNIT_SHORT_ZH
                .lines()
                .find(|l| l.starts_with(&format!("{code}\t")))
                .and_then(|l| l.split('\t').nth(3))
        };
        assert_eq!(
            [
                additive("PER"),
                additive("KTOE"),
                additive("PC"),
                additive("TCO2E_HAB"),
                additive("NR")
            ],
            [
                Some("yes"),
                Some("yes"),
                Some("no"),
                Some("no"),
                Some("yes")
            ]
        );
    }

    /// The unit-carriers registry: each row's dimensions and codes pair up, no pair twice, and every unit code it maps to
    /// has a unit-short-zh row, so a carried unit prints as the unit table's own form. Read on four shapes (a currency
    /// alone, a currency beside a quantity unit, an indicator code, a plain unit dimension), and an unmapped currency or
    /// indicator, a currency that varies, or a unit dimension with no carrier beside it is named, never guessed.
    #[test]
    fn a_carried_unit_is_read_from_the_registry_and_an_unmapped_code_is_refused() {
        let mut rows = UNIT_CARRIERS.lines();
        assert_eq!(rows.next(), Some("dims\tcodes\tunit_code\tevidence"));
        let mut seen = BTreeSet::new();
        for row in rows {
            let p: Vec<&str> = row.split('\t').collect();
            assert_eq!(p.len(), 4, "{row}");
            assert_eq!(
                p[0].split(',').count(),
                p[1].split(',').count(),
                "{row}: dims and codes pair up"
            );
            assert!(!p[3].is_empty(), "{row}: no evidence");
            assert!(
                unit_short(p[2]).is_some(),
                "{row}: unit {} has no unit-short-zh row",
                p[2]
            );
            assert!(seen.insert((p[0], p[1])), "{row}: twice");
        }
        fn dims(held: &[(&str, &[&str])]) -> BTreeMap<String, BTreeSet<String>> {
            held.iter()
                .map(|(d, codes)| (d.to_string(), codes.iter().map(|c| c.to_string()).collect()))
                .collect()
        }
        fn no(held: &[(&str, &[&str])]) -> String {
            carried_unit(&dims(held)).unwrap_err()
        }
        let geo: (&str, &[&str]) = ("geo", &["DE", "FR"]);
        assert_eq!(
            carried_unit(&dims(&[geo, ("freq", &["S"]), ("currency", &["EUR"])])),
            Ok(Some("EUR"))
        );
        assert_eq!(
            carried_unit(&dims(&[
                geo,
                ("currency", &["EUR"]),
                ("unit", &["KWH"]),
                ("tax", &["I_TAX"])
            ])),
            Ok(Some("EUR_KWH"))
        );
        assert_eq!(
            carried_unit(&dims(&[geo, ("indic_de", &["NATGROWRT"])])),
            Ok(Some("P_THAB"))
        );
        assert_eq!(
            carried_unit(&dims(&[geo, ("indic_de", &["LBIRTH"])])),
            Ok(Some("NR"))
        );
        assert_eq!(
            carried_unit(&dims(&[geo, ("indic_de", &["PC_Y65_MAX"])])),
            Ok(Some("PC"))
        );
        // a plain unit dimension, and a currency beside a unit the registry pairs with none (an exchange rate), read as before
        assert_eq!(carried_unit(&dims(&[geo, ("unit", &["GWH"])])), Ok(None));
        assert_eq!(
            carried_unit(&dims(&[("currency", &["USD"]), ("unit", &["AVG"])])),
            Ok(None)
        );
        assert_eq!(
            carried_unit(&dims(&[geo, ("indic_de", &["LBIRTH"]), ("unit", &["NR"])])),
            Ok(None)
        );
        assert_eq!(
            no(&[geo, ("currency", &["PPS"])]),
            "the unit is carried by currency PPS, which has no row in unit-carriers"
        );
        assert_eq!(
            no(&[geo, ("currency", &["NAC"])]),
            "the unit is carried by currency NAC, which has no row in unit-carriers"
        );
        assert_eq!(
            no(&[geo, ("currency", &["PPS"]), ("unit", &["KWH"])]),
            "the unit is carried by currency,unit PPS,KWH, which has no row in unit-carriers"
        );
        assert_eq!(
            no(&[geo, ("indic_de", &["GROW"])]),
            "the unit is carried by indic_de GROW, which has no row in unit-carriers"
        );
        assert_eq!(
            no(&[geo, ("currency", &["EUR", "NAC"])]),
            "the unit is carried by currency, which holds 2 codes, not one"
        );
        assert_eq!(
            no(&[geo, ("currency", &["EUR"]), ("indic_de", &["LBIRTH"])]),
            "the unit is carried by two dimension sets: currency; indic_de"
        );
        // the carried code prints as the registry's forms; its label is the catalogue's
        assert_eq!(
            (unit_short("EUR_KWH"), unit_label_en("EUR_KWH")),
            (Some("欧元/千瓦时"), Some("Euro per kilowatt-hour"))
        );
        assert_eq!(unit_label_en("XYZ"), None);
    }

    #[test]
    fn the_world_bank_units_read_from_its_metadata_print_their_reviewed_forms() {
        // owner 11-06 22:02: the bank's own unit words fill its codes; the Chinese forms are the reviewed ones
        for (code, short, suffix) in [
            ("USD", "美元", "美元"),
            ("USD_K15", "美元（2015年不变价）", "美元"),
            ("LCU", "本币（现价）", "本币"),
            ("LCU_K", "本币（不变价）", "本币"),
            ("INTD", "国际元（现价）", "国际元"),
            ("INTD_K21", "国际元（2021年不变价）", "国际元"),
            ("SC100", "分（满分100）", "分"),
            ("SCORE", "分", "分"),
            ("BIRTH_W", "个/妇女", "个/妇女"),
        ] {
            assert_eq!(
                (unit_short(code), unit_number_suffix(code)),
                (Some(short), Some(suffix)),
                "{code}"
            );
        }
        // a page prints a dollar amount at one magnitude chosen by its largest number; a unit with no magnitude row as it is
        assert_eq!(
            unit_at_magnitude("USD", 1.77e13),
            ("USD_E12".to_string(), Some(1e-12))
        );
        assert_eq!(
            unit_at_magnitude("USD", 9.9e11),
            ("USD_E8".to_string(), Some(1e-8))
        );
        assert_eq!(unit_at_magnitude("USD", 9.9e7), ("USD".to_string(), None));
        assert_eq!(
            unit_at_magnitude("INTD_K21", 3e12),
            ("INTD_K21_E12".to_string(), Some(1e-12))
        );
        assert_eq!(unit_at_magnitude("LCU", 3e14), ("LCU".to_string(), None));
        assert_eq!(unit_at_magnitude("GWH", 3e9), ("GWH".to_string(), None));
        assert_eq!(
            (unit_short("USD_E8"), unit_number_suffix("USD_E8")),
            (Some("亿美元"), Some("亿美元"))
        );
        // each place's own currency does not compare across places; a dollar amount and a share do
        assert!(!unit_compares_across_places("LCU") && !unit_compares_across_places("LCU_K"));
        assert!(unit_compares_across_places("USD") && unit_compares_across_places("PC"));
        // every code the World Bank table holds has a row here, so no filled code stops the page on a missing form
        for row in include_str!("../runtime/pi/assets/wb-units.tsv")
            .lines()
            .skip(1)
        {
            let code = row.split('\t').nth(2).unwrap_or("");
            assert!(code.is_empty() || unit_short(code).is_some(), "{row}");
            // an amount per someone (per worker, per capita) is no total, so it never takes a total amount's code
            if [" per worker", " per capita", " per person"]
                .iter()
                .any(|w| row.split('\t').nth(1).unwrap_or("").contains(w))
            {
                assert!(
                    !["USD", "USD_K15", "LCU", "LCU_K", "INTD", "INTD_K21"].contains(&code),
                    "{row}"
                );
            }
        }
    }

    #[test]
    fn unit_short_zh_holds_the_catalogue_s_percentage_family() {
        // K4 (11-05): sealed s2 stopped at the fill on PC_ACT, a unit the catalogue offers whose family the table already
        // held; every Eurostat code labelled "Percentage of …" now reads %, and none adds up. (The index family, s6's I90,
        // would add Chinese copy to this flow-group table, which the ratchet refuses: it waits for the owner.)
        for code in ["PC_ACT", "PC_IND", "PC_ENT", "PC_TOT"] {
            assert_eq!(unit_short_zh(code), Some("%"), "{code}");
        }
        // K4 round 1 for s6 (11-05, after the table moved to the knowledge group): every I## the unit list labels
        // "Index, YYYY=100" reads its own base year (s6's I90), none adding up
        for (code, short) in [
            ("I90", "指数(1990=100)"),
            ("I95", "指数(1995=100)"),
            ("I00", "指数(2000=100)"),
            ("I21", "指数(2021=100)"),
            ("I15", "指数(2015=100)"),
        ] {
            assert_eq!(unit_short_zh(code), Some(short), "{code}");
        }
        for row in UNIT_SHORT_ZH.lines().skip(1) {
            let p: Vec<&str> = row.split('\t').collect();
            if p[2] == "pct_family" {
                assert_eq!((p[1], p[3]), ("%", "no"), "{row}: a share does not add up");
            }
            if p[2] == "index_base" {
                assert!(
                    p[1] == format!("指数({}=100)", &p[1][7..11]) && p[3] == "no",
                    "{row}: an index reads its base year and does not add up"
                );
            }
        }
    }
}
