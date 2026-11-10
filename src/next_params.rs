//! Flow side: the fetch parameters of a table the model picked, filled from the catalogue's own lists when no prepare spec
//! is given. The program fills what the codes alone decide (a dimension with one code, a total code, the places the
//! question names, the last year from the TOC, an annual table's years: the ones the question names, else the last ten);
//! what only the question decides (the dimension the page breaks down by, a measure or unit with no total, one year or ten
//! of a table that is not annual) is listed under the table in the table pick as numbered options, the model answering with
//! numbers only. Every code a rule asks for is in the registry below. Pure: no file, no tool, no model.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use crate::classify::PLACE_SHARE;
use crate::l5geo::{Place, RankAsked, TableMeta};
use crate::next_knowledge::Held;
use crate::shape_registry::{Role, Shape, VaryingDim, MAX_ROWS as MAX_CHART_ROWS};

/// Registry: codes that stand for the whole of a dimension, judged before the fetch by the code alone ("*" is any
/// dimension). classify judges the rows again after the fetch; this list only decides what is asked for.
pub const TOTAL_CODES: [(&str, &str); 2] = [("*", "TOTAL"), ("sex", "T")];
/// Before the fetch, a category is predicted to add up to its total only with at least this many other codes fetched.
pub const ADDITIVE_MIN_PARTS: usize = 3;
/// Registry: the EU aggregate on the geo dimension, asked for when the page breaks down by another place dimension.
pub const EU_AGGREGATE: &str = "EU27_2020";
/// The most countries a question names as a ranking's subject ("where do Nigeria and Pakistan rank among the ten most
/// populous"): more are a group, the set itself (Draft::named_open).
pub const RANK_SUBJECTS_MAX: usize = 3;
/// Registry: the 27 EU members as Eurostat geo codes (EL is Greece), for a question that names the EU or Europe.
pub const EU27: [&str; 27] = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];
/// Registry: Eurostat geo codes that are not ISO 3166-1 alpha-2, as (Eurostat, ISO); an aggregate a question names as a
/// place of its own is the World Bank's iso3 (l5geo PEER_AGGREGATES_ZH).
pub const ESTAT_ISO: [(&str, &str); 3] = [("EL", "GR"), ("UK", "GB"), (EU_AGGREGATE, "EUU")];
/// The frequency dimension of a Eurostat fetch: the table's own freq (TableMeta::freq, from its metabase time codes; the
/// metabase lists no freq dimension).
pub const FREQ_DIM: &str = "freq";
pub const GEO_DIM: &str = "geo";
/// The place dimension of a World Bank fetch (newsroom.ts worldbank provider).
pub const WB_PLACE_DIM: &str = "country";
/// Never offered as the breakdown: one page does not mix units.
pub const UNIT_DIM: &str = "unit";
/// Registry: the row limits of newsroom_data_prepare (runtime/pi/newsroom.ts, max_rows of each provider).
pub const MAX_ROWS_EUROSTAT: u64 = 50_000;
pub const MAX_ROWS_WORLDBANK: u64 = 20_000;
/// Years in "the last ten years".
pub const YEARS_SPAN: i32 = 10;
/// World Bank "latest year": the catalogue has no years, so the three years before this one, the newest with a value among them.
pub const WB_LATEST_SPAN: i32 = 3;
/// Numbered options per item at most; the first by overlap with the search words, ties in metabase order.
pub const OPTIONS_MAX: usize = 8;
/// The item every table has ("t<table number>.years").
pub const YEARS_KEY: &str = "years";
pub const YEARS_OPTIONS: [&str; 2] = ["the latest year only", "the last ten years"];
/// The years option an annual table takes when the question names none: the last ten years, so a page can set the earliest
/// year beside the latest (the row caps below still cut it to the latest year when the fetch would hold too many rows).
pub const ANNUAL_YEARS: usize = 2;
/// The earliest year a question may name: a four-digit number before it is no year of a table.
pub const NAMED_FROM: i32 = 1950;
/// The words that run a question's one year on to now: before the year ("比 1990 年", "较 2015 年") or after its 年
/// ("2015 年以来", "与 2015 年相比").
pub const SINCE_BEFORE: [&str; 5] = ["比", "较", "相比", "相较", "对比"];
pub const SINCE_AFTER: [&str; 6] = ["以来", "至今", "到现在", "起", "相比", "比较"];
/// The marks between the two years of a range ("2015 到 2024 年").
pub const RANGE_MARKS: [char; 7] = ['到', '至', '-', '–', '—', '~', '～'];
/// The words that ask for months, not a year: each month of a span ("每月", "逐月", "月度") or the latest one ("上个月").
const MONTH_WORDS: [&str; 12] = ["每月", "每个月", "逐月", "按月", "各月", "月度", "月份", "上个月", "上月", "本月", "这个月", "当月"];
/// The words that ask for a part of a year, which months add up to and a year's figure cannot answer: a quarter ("一季度",
/// "第三季度", "前三季度", "按季度"), a half ("上半年", "下半年", "近半年") or the year so far ("今年以来").
const PART_YEAR_WORDS: [&str; 7] = ["季度", "半年", "今年以来", "今年至今", "今年迄今", "年初以来", "年初至今"];
/// The words of a table card's line under a table with composition groups (parts_line), around the grouped dimension and
/// its total code, then the groups' registry names; English program words with no number.
const PARTS_LINE_WORDS: [&str; 2] = ["each place's", "splits into the registered groups"];
/// Codes kept when an open place dimension has more codes than a chart shows (newsroom_data_prepare narrow, rule "top"):
/// the highest at the latest time, at most the chart's rows over the years.
pub const NARROW_TOP: usize = 20;
/// The one registry of how a World Bank table with every country open is narrowed (the options, their n, the rank-year
/// share and the page wording), the same file newsroom.ts validates the narrow against.
const WB_RANK_BY: &str = include_str!("../runtime/pi/assets/wb-rank-by.json");
/// The item of a World Bank table with every country open: which economies the page keeps.
pub const PLACES_KEY: &str = "places";
/// The registered Eurostat flow tables whose monthly or quarterly rows sum to a whole year (catalogue data of the knowledge group:
/// id prefixes, periods per year, the year share), read as a shared word list.
const FLOW_FAMILIES: &str = include_str!("../runtime/pi/assets/flow-families.json");
/// The registered parts of Eurostat table dimensions (catalogue data of the knowledge group: per dimension of a family of tables
/// that share its codelist, column "tables", its total code, aggregates and leaves with their parents), read as a shared word
/// list. A table of the family takes the registered codes it lists. More tables are more names in a row or more rows.
const ESTAT_PARTS: &str = include_str!("../runtime/pi/assets/estat-parts.tsv");
/// The asset a split's registered codes came from, as the params event names it.
pub const PARTS_SOURCE: &str = "estat-parts.tsv";
/// The levels a registered part has: the dimension's whole, a subtotal of other parts, or a part of no other.
pub const PART_LEVELS: [&str; 3] = ["total", "aggregate", "leaf"];
/// The level of a registered subtotal that is no part of the tree (estat-parts.tsv): it overlaps the tree's parts (nrg_bal_peh
/// BIOE spans renewable leaves and non-renewable waste), so it has no parent, is no parent, and `parts` never reads it as one.
pub const OVERLAP_LEVEL: &str = "overlap";

/// The sides a dimension's total row may name it in its table's registered flow (estat-parts.tsv column "flow"): the flow
/// runs from the source dimension's parts to the target dimension's (nrg_bal_s: each fuel to each sector of final use).
pub const FLOW_SIDES: [&str; 2] = ["source", "target"];
/// What joins a flow split's two dimensions in its breakdown entry ("siec>nrg_bal"): no dimension id holds it.
pub const FLOW_JOIN: char = '>';

/// One registered code of a table dimension (an estat-parts.tsv row): its level (PART_LEVELS), the code it is a part of,
/// on a total row the side of the table's flow the dimension is (FLOW_SIDES), on a leaf the code of the flow's other
/// dimension it is registered as left out of (column "excluded_from", with the published source that says so), and on a leaf
/// the group a composition sums it into (column "group_en": fossil, nuclear, renewable, other; its printed name is a reviewed
/// one only, composition_groups).
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub code: String,
    pub level: String,
    pub parent: Option<String>,
    pub group: Option<String>,
    pub flow: Option<String>,
    pub excluded_from: Option<String>,
    pub excluded_source: Option<String>,
}

/// The registered parts of dimension `dim` of Eurostat table `table` (its id without "@2"; a row registers them for every table
/// its "tables" names), in file order; empty for a dimension the file does not register.
pub fn parts(table: &str, dim: &str) -> Vec<Part> {
    registry()
        .iter()
        .filter(|(t, d, p)| t == table && d == dim && p.level != OVERLAP_LEVEL)
        .map(|(_, _, part)| part.clone())
        .collect()
}

/// The groups a composition of dimension `dim` of `table` sums its leaves into: each registered group (Part::group) with
/// its leaves, in the order the file first names the group, the leaves in file order. The leaves are the dimension's leaves
/// under its total (leaves_under_total), so each one counts once and they add up to the total. Empty when the file registers
/// no group for the dimension; Err when a leaf under the total has none (it would be left out of every group) or when one
/// group holds every leaf (a composition of one part shows nothing).
pub fn composition_groups(table: &str, dim: &str) -> Result<Vec<(String, Vec<Part>)>, String> {
    let leaves = leaves_under_total(table, dim);
    if !leaves.iter().any(|p| p.group.is_some()) {
        return Ok(Vec::new());
    }
    let mut groups: Vec<(String, Vec<Part>)> = Vec::new();
    for leaf in leaves {
        let Some(group) = leaf.group.clone() else {
            return Err(format!("{PARTS_SOURCE}: {table} {dim} {} is a leaf with no group", leaf.code));
        };
        match groups.iter_mut().find(|(g, _)| *g == group) {
            Some((_, members)) => members.push(leaf),
            None => groups.push((group, vec![leaf])),
        }
    }
    if groups.len() < 2 {
        return Err(format!("{PARTS_SOURCE}: {table} {dim} has one group only"));
    }
    Ok(groups)
}

/// The codes a composition of dimension `dim` of `table` fetches for each of its groups (composition_groups), in the groups'
/// order: from the total down, a code all of whose leaves are in one group is that group's input (an official subtotal such
/// as RA000 for the renewables, or a leaf), and a code whose leaves span groups gives its children's inputs instead. So the
/// inputs of a group add up to its leaves' sum, each leaf counted once, and every input is a code the table publishes. Empty
/// when the dimension has no groups; Err as composition_groups, or when a group gets no input.
pub fn group_inputs(table: &str, dim: &str) -> Result<Vec<(String, Vec<String>)>, String> {
    let groups = composition_groups(table, dim)?;
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    let registered = parts(table, dim);
    let leaves: Vec<Part> = groups.iter().flat_map(|(_, members)| members.iter().cloned()).collect();
    // the group of each leaf under a code (itself, for a leaf), each group once
    fn groups_under(code: &str, registered: &[Part], leaves: &[Part], depth: usize) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        if depth > registered.len() {
            return out;
        }
        if let Some(leaf) = leaves.iter().find(|l| l.code == code) {
            out.extend(leaf.group.clone());
            return out;
        }
        for child in registered.iter().filter(|p| p.parent.as_deref() == Some(code)) {
            out.extend(groups_under(&child.code, registered, leaves, depth + 1));
        }
        out
    }
    let Some(total) = registered.iter().find(|p| p.level == PART_LEVELS[0]).map(|p| p.code.clone()) else {
        return Ok(Vec::new());
    };
    let mut inputs: Vec<(String, Vec<String>)> = groups.iter().map(|(g, _)| (g.clone(), Vec::new())).collect();
    let mut at = vec![(total, 0usize)];
    while let Some((code, depth)) = at.pop() {
        let children: Vec<&Part> = registered.iter().filter(|p| p.parent.as_deref() == Some(code.as_str())).collect();
        for child in children {
            let under = groups_under(&child.code, &registered, &leaves, depth + 1);
            match under.iter().collect::<Vec<_>>()[..] {
                [] => {}
                [one] => {
                    if let Some((_, codes)) = inputs.iter_mut().find(|(g, _)| g == one) {
                        codes.push(child.code.clone());
                    }
                }
                _ => at.push((child.code.clone(), depth + 1)),
            }
        }
    }
    // a mixed code's children are visited after its siblings: each group's inputs back in file order
    let order = |c: &String| registered.iter().position(|p| p.code == *c).unwrap_or(usize::MAX);
    for (_, codes) in inputs.iter_mut() {
        codes.sort_by_key(order);
    }
    if let Some((g, _)) = inputs.iter().find(|(_, codes)| codes.is_empty()) {
        return Err(format!("{PARTS_SOURCE}: {table} {dim} group {g} has no input code"));
    }
    Ok(inputs)
}

/// The source and target dimensions of the flow estat-parts.tsv registers for `table` (its id without "@2"): the dimensions
/// whose total row names them a FLOW_SIDES side. None when the file registers no flow, or only one side of it.
pub fn flow_dims(table: &str) -> Option<(String, String)> {
    let side = |s: &str| {
        registry()
            .iter()
            .find(|(t, _, p)| t == table && p.level == PART_LEVELS[0] && p.flow.as_deref() == Some(s))
            .map(|(_, d, _)| d.clone())
    };
    Some((side(FLOW_SIDES[0])?, side(FLOW_SIDES[1])?))
}

/// The parts of dimension `dim` a flow of `table` draws: its leaves whose parents lead up to the dimension's total, so one
/// level only (an aggregate is never drawn beside its own parts: FC_OTH_E would count twice) and the leaves add up to the total.
pub fn flow_parts(table: &str, dim: &str) -> Vec<Part> {
    leaves_under_total(table, dim)
}

/// The leaves of dimension `dim` of `table` whose parents lead up to its total, in file order (flow_parts,
/// composition_groups): one level only, so they add up to the total.
fn leaves_under_total(table: &str, dim: &str) -> Vec<Part> {
    let registered = parts(table, dim);
    let Some(total) = registered.iter().find(|p| p.level == PART_LEVELS[0]) else {
        return Vec::new();
    };
    let under_total = |leaf: &Part| {
        let mut at = leaf.parent.clone();
        for _ in 0..registered.len() {
            match at {
                Some(code) if code == total.code => return true,
                Some(code) => at = registered.iter().find(|p| p.code == code).and_then(|p| p.parent.clone()),
                None => return false,
            }
        }
        false
    };
    registered
        .iter()
        .filter(|p| p.level == PART_LEVELS[2] && under_total(p))
        .cloned()
        .collect()
}

/// The source leaves of `table`'s flow the registry leaves out of it (column "excluded_from"): each one is registered as
/// excluded from the target dimension's total, so from every pair of it (Eurostat flags such a cell "Z", not applicable), and
/// it is never fetched; every pair of it is said, not asked for. Err for an exclusion the flow cannot read: one on a target
/// leaf, from a code other than the target's total, or with no source.
pub fn flow_excluded(table: &str) -> Result<Vec<Part>, String> {
    let Some((source, target)) = flow_dims(table) else {
        return Ok(Vec::new());
    };
    let total = parts(table, &target).into_iter().find(|p| p.level == PART_LEVELS[0]).map(|p| p.code);
    if let Some(p) = flow_parts(table, &target).into_iter().find(|p| p.excluded_from.is_some()) {
        return Err(format!("{PARTS_SOURCE}: target {target} {} is excluded, and only a source leaf may be", p.code));
    }
    let mut out = Vec::new();
    for p in flow_parts(table, &source).into_iter().filter(|p| p.excluded_from.is_some()) {
        if p.excluded_from != total {
            return Err(format!(
                "{PARTS_SOURCE}: {source} {} is excluded from {}, and an exclusion is from the target's total {}",
                p.code,
                p.excluded_from.as_deref().unwrap_or_default(),
                total.as_deref().unwrap_or("(none)")
            ));
        }
        if p.excluded_source.is_none() {
            return Err(format!("{PARTS_SOURCE}: {source} {} is excluded with no source", p.code));
        }
        out.push(p);
    }
    Ok(out)
}

/// The leaves of dimension `dim` a flow of `table` asks for: its flow_parts but the ones the registry leaves out of the
/// flow (flow_excluded).
pub fn flow_asked(table: &str, dim: &str) -> Result<Vec<Part>, String> {
    let excluded = flow_excluded(table)?;
    Ok(flow_parts(table, dim).into_iter().filter(|p| !excluded.iter().any(|x| x.code == p.code)).collect())
}

/// A flow split's breakdown entry read back as its (source, target) dimensions; None for a split by one dimension.
pub fn flow_split(entry: &str) -> Option<(&str, &str)> {
    entry.split_once(FLOW_JOIN)
}

/// A flow split's leaves of one dimension that the table lists and the flow asks for (flow_asked), in file order: None
/// unless it lists every one of them (a leaf left out would leave the flows short of the total) and they are two or more,
/// or when the registry's exclusions cannot be read.
fn listed_flow_parts(table: &TableMeta, dim: &str) -> Option<Vec<String>> {
    let dataset = table.id.strip_suffix("@2").unwrap_or(&table.id);
    let codes = &table.dims.iter().find(|(d, _)| d == dim)?.1;
    let leaves: Vec<String> = flow_asked(dataset, dim).ok()?.into_iter().map(|p| p.code).collect();
    (leaves.len() > 1 && leaves.iter().all(|l| codes.iter().any(|(c, _)| c == l))).then_some(leaves)
}

/// estat-parts.tsv read once, as (table, dimension, part) rows. Columns are found by the header's names.
fn registry() -> &'static Vec<(String, String, Part)> {
    static REGISTRY: OnceLock<Vec<(String, String, Part)>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut lines = ESTAT_PARTS.lines();
        let header: Vec<&str> = lines
            .next()
            .expect("estat-parts.tsv has a header")
            .split('\t')
            .collect();
        let col = |name: &str| {
            header
                .iter()
                .position(|h| *h == name)
                .unwrap_or_else(|| panic!("estat-parts.tsv lacks {name}"))
        };
        let (t, d, c, l, p, f) = (col("tables"), col("dim"), col("code"), col("level"), col("parent"), col("flow"));
        let (x, xs, g) = (col("excluded_from"), col("excluded_source"), col("group_en"));
        lines
            .filter(|line| !line.is_empty())
            .flat_map(|line| {
                let fields: Vec<&str> = line.split('\t').collect();
                let at = |i: usize| fields.get(i).copied().unwrap_or("").to_string();
                let part = Part {
                    code: at(c),
                    level: at(l),
                    parent: Some(at(p)).filter(|p| !p.is_empty()),
                    group: Some(at(g)).filter(|g| !g.is_empty()),
                    flow: Some(at(f)).filter(|f| !f.is_empty()),
                    excluded_from: Some(at(x)).filter(|x| !x.is_empty()),
                    excluded_source: Some(at(xs)).filter(|x| !x.is_empty()),
                };
                // one row registers the code for every table of its family (the tables that share the codelist)
                let dim = at(d);
                at(t).split_whitespace().map(|table| (table.to_string(), dim.clone(), part.clone())).collect::<Vec<_>>()
            })
            .collect()
    })
}

/// A summed year (newsroom_data_prepare sum_year): the periods a year holds, and the share of series that must hold it whole.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SumYear {
    pub n: u64,
    pub share: f64,
}

/// The summed year of a Eurostat table asked for its latest year: a registered flow table (flow-families.json, by id prefix) fetched
/// at a freq the registry gives periods for. None for an annual, World Bank or unregistered table, which keeps the latest period.
pub fn sum_year(table: &TableMeta) -> Option<SumYear> {
    static REGISTRY: OnceLock<(Vec<String>, BTreeMap<String, u64>, f64)> = OnceLock::new();
    let (prefixes, periods, share) = REGISTRY.get_or_init(|| {
        let asset: Value = serde_json::from_str(FLOW_FAMILIES).expect("flow-families.json is JSON");
        let prefixes = asset["prefixes"]
            .as_array()
            .expect("flow-families.json lists prefixes")
            .iter()
            .map(|p| p["prefix"].as_str().expect("a prefix is text").to_string())
            .collect();
        let periods = asset["periods_per_year"]
            .as_object()
            .expect("flow-families.json has periods_per_year")
            .iter()
            .map(|(f, n)| (f.clone(), n.as_u64().expect("periods are a count")))
            .collect();
        let share = asset["year_share"]
            .as_f64()
            .expect("flow-families.json has year_share");
        (prefixes, periods, share)
    });
    if table.worldbank {
        return None;
    }
    let id = table.id.strip_suffix("@2").unwrap_or(&table.id);
    if !prefixes.iter().any(|p| id.starts_with(p.as_str())) {
        return None;
    }
    let n = *periods.get(table.freq().ok()?)?;
    Some(SumYear { n, share: *share })
}

/// One option of wb-rank-by.json: rank by this indicator ("top"/"bottom") or by a registered other one (`by`).
#[derive(Clone, Debug, PartialEq)]
pub struct RankBy {
    pub key: String,
    pub rule: String,
    pub by: Option<String>,
    pub label: String,
    pub zh_scope: String,
    pub zh_line: String,
}

/// wb-rank-by.json's year share: the rank year is the latest year where at least this share of the economies with any value
/// have one (both tables counted when ranked by another indicator), as the tool ranks it.
pub fn wb_rank_year_share() -> f64 {
    static SHARE: OnceLock<f64> = OnceLock::new();
    *SHARE.get_or_init(|| {
        let asset: Value = serde_json::from_str(WB_RANK_BY).expect("wb-rank-by.json is JSON");
        asset["year_share"].as_f64().expect("wb-rank-by.json has year_share")
    })
}

/// wb-rank-by.json parsed once: the cap on the economies kept and the options in their pick order. The file is compiled
/// in, so a broken one fails the registry test, not a run.
pub fn wb_rank_by() -> &'static (usize, Vec<RankBy>) {
    static REGISTRY: OnceLock<(usize, Vec<RankBy>)> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let asset: Value = serde_json::from_str(WB_RANK_BY).expect("wb-rank-by.json is JSON");
        let text = |o: &Value, key: &str| {
            o[key]
                .as_str()
                .unwrap_or_else(|| panic!("wb-rank-by.json: an option lacks {key}"))
                .to_string()
        };
        let options = asset["options"]
            .as_array()
            .expect("wb-rank-by.json lists options")
            .iter()
            .map(|o| RankBy {
                key: text(o, "key"),
                rule: text(o, "rule"),
                by: o["by"].as_str().map(str::to_string),
                label: text(o, "label"),
                zh_scope: text(o, "zh_scope"),
                zh_line: text(o, "zh_line"),
            })
            .collect();
        let n = asset["n"].as_u64().expect("wb-rank-by.json has n") as usize;
        (n, options)
    })
}

/// One picked table before the model's answer: what the program fixed, and what it asks.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub table: TableMeta,
    /// Dimensions the breakdown may be, offered as options 2.. (option 1 is none).
    pub breakdown: Vec<String>,
    /// Dimensions with several codes and no total: the offered codes, and how many codes the dimension has.
    pub members: Vec<OfferedDim>,
    /// The named countries geo does not hold, fixed in the first other dimension that lists them as places, as
    /// (dim, [(code, iso2)]) (the EU's trade with China: geo is the EU, partner is CN_X_HK). Such a dimension is neither a
    /// breakdown nor an item.
    pub named: Vec<(String, Vec<(String, String)>)>,
    /// The named countries geo does not hold that two or more other dimensions list (c_orig and c_dest), as (iso2, dims):
    /// which one the question means is not fixed, so they are left to fill as before (dropped, or the table refused).
    pub ambiguous: Vec<(String, Vec<String>)>,
    /// A World Bank table the question names no place of, with more economies than a chart shows: every country is open,
    /// and the item "t<n>.places" asks which economies the page keeps (wb-rank-by.json).
    pub places_open: bool,
    /// A World Bank table with more economies than a chart shows whose question names countries only (no region word): a
    /// ranking the question asks for still fixes the economies kept (ranked_option), the named ones being the ranking's
    /// subject, not its set ("the ten most populous countries, where does Nigeria rank", n45); with no ranking they fill
    /// the places as before. A group the question names (its members as places, more than RANK_SUBJECTS_MAX) is the set
    /// itself, drawn whole as before (review 11-08: "the five most populous of the G20").
    pub named_open: bool,
    /// Set by the flow before the pick for an annual table whose companion shortlist has a monthly twin, when the answer
    /// fills geo with one aggregate (the hub): those answers take the ring's years, not the years item.
    pub window: Option<Window>,
    /// Set by the flow before the pick: the years the question names (question_years), which an annual table's fetch takes
    /// before the program's own last ten years.
    pub named_years: Option<NamedYears>,
    /// Set by the flow before the pick: the ranking the question asks for in place of named places (the knowledge group's
    /// rank_asked). With `places_open` and a wb-rank-by.json option ranked by its reference, the program keeps that option's
    /// economies and the count the question writes (ranked_option): "t<n>.places" is not asked.
    pub ranked: Option<RankAsked>,
}

/// The years a question names: a span of years it writes ("2015 年到 2024 年", one year alone a span of one), or the last
/// n years ("近五年", "过去 10 年"), counted back from the table's last year.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NamedYears {
    Span(i32, i32),
    Last(i32),
}

/// The years a question names, read by rule from its words, spaces aside (no model): a four-digit number from NAMED_FROM on
/// directly before 年 ("2015 年"), or the first of a range written with a RANGE_MARKS ("2015 到 2024 年", "2015-2024 年"),
/// is a year, and a four-digit number before anything else is none ("2000 美元", "2000 万"); the years give the span from the
/// earliest to the latest, a later one than this year kept (the fill keeps the fetch to the table's last year). One year
/// alone that the question runs on from or compares with (SINCE_BEFORE before it, SINCE_AFTER after its 年: "比 1990 年",
/// "与 2015 年相比", "2015 年以来") runs to this year. Else "近" / "过去" / "最近" before a count (digits, or 一 to 十, 两,
/// 十一 to 九十九 in Chinese numerals) and "年" give the last that many years. None when it names no years.
pub fn question_years(question: &str, this_year: i32) -> Option<NamedYears> {
    let chars: Vec<char> = question.chars().filter(|c| !c.is_whitespace()).collect();
    let four = |i: usize| -> Option<i32> {
        let run = chars[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        let before = i > 0 && chars[i - 1].is_ascii_digit();
        (run == 4 && !before).then(|| chars[i..i + 4].iter().collect::<String>().parse::<i32>().ok()).flatten().filter(|y| *y >= NAMED_FROM)
    };
    // each year with where its digits start and where the text after its 年 starts
    let mut years: Vec<(i32, usize, usize)> = Vec::new();
    for i in 0..chars.len() {
        let Some(y) = four(i) else { continue };
        match chars.get(i + 4) {
            Some('年') => years.push((y, i, i + 5)),
            Some(m) if RANGE_MARKS.contains(m) => {
                if let Some(to) = four(i + 5).filter(|_| chars.get(i + 9) == Some(&'年')) {
                    years.extend([(y, i, i + 5), (to, i + 5, i + 10)]);
                }
            }
            _ => {}
        }
    }
    years.dedup();
    let last = last_years(&chars);
    if let (Some(a), Some(b)) = (years.iter().map(|y| y.0).min(), years.iter().map(|y| y.0).max()) {
        let text = |r: std::ops::Range<usize>| chars[r].iter().collect::<String>();
        let since = a == b
            && years.iter().any(|&(_, at, after)| {
                SINCE_BEFORE.iter().any(|w| text(0..at).ends_with(w)) || SINCE_AFTER.iter().any(|w| text(after..chars.len()).starts_with(w))
            });
        // one year inside the last n years the question also counts back ("近二十年……2015 年那一年有没有往下掉", e9): the
        // year is a point the question asks about within the span, not the span (rounds 7-10 fetched 2015 alone)
        if let Some(n) = last.filter(|&n| a == b && !since && n > 1 && a > this_year - 1 - n) {
            return Some(NamedYears::Last(n));
        }
        return Some(NamedYears::Span(a, if since { this_year.max(a) } else { b }));
    }
    // "最近一年" / "近一年" counts back one year: the latest year, which is the program's when the question names none (an
    // annual table's last ten years, the page at the latest year most places hold); Last(1) fetched this year minus one alone,
    // a year a sparse World Bank table has no value in for any asked place (n14, n34: no rows, rounds 7-10)
    last.filter(|&n| n > 1).map(NamedYears::Last)
}

/// The last n years a question counts back over (year-words.json: a lead word, a count, 年; or a count before a tail).
fn last_years(chars: &[char]) -> Option<i32> {
    let text: String = chars.iter().filter(|c| !c.is_whitespace()).collect();
    let numeral = |c: &char| c.is_ascii_digit() || "一二两三四五六七八九十".contains(*c);
    let words: Value = serde_json::from_str(include_str!("../runtime/pi/assets/year-words.json")).unwrap_or_default();
    let list = |k: &str| -> Vec<String> { words[k].as_array().into_iter().flatten().filter_map(|w| w.as_str().map(str::to_string)).collect() };
    for lead in list("last_lead") {
        let lead = lead.as_str();
        for (at, _) in text.match_indices(lead) {
            let rest = &text[at + lead.len()..];
            let count: String = rest.chars().take_while(numeral).collect();
            if rest[count.len()..].starts_with('年') {
                if let Some(n) = count_of(&count).filter(|n| *n >= 1) {
                    return Some(n);
                }
            }
        }
    }
    // a count of years the question runs back over with no word before it: "五年来", "10 年以来" (t4, 11-05 10:2x (e))
    for tail in list("last_tail") {
        for (at, _) in text.match_indices(tail.as_str()) {
            let count: String = text[..at].chars().rev().take_while(numeral).collect::<Vec<_>>().into_iter().rev().collect();
            if let Some(n) = count_of(&count).filter(|n| *n >= 1 && count.chars().count() < 4) {
                return Some(n);
            }
        }
    }
    None
}

/// The latest year a question names: the end of question_years' span (a year it runs on from or compares with running to
/// this year). None for the last n years, counted back from the table's own last year, and for a question naming no years.
/// The table pick keeps a monthly-only table rather than an annual twin that ends before it.
pub fn question_latest_year(question: &str, this_year: i32) -> Option<i32> {
    match question_years(question, this_year)? {
        NamedYears::Span(_, to) => Some(to),
        NamedYears::Last(_) => None,
    }
}

/// Whether a question asks for months, read by rule from its words, spaces aside, as question_years reads its years (no
/// model): a month it names by its number before 月 (1 to 12, in digits or Chinese numerals: "3 月", "2025 年十月"), a count
/// of months ("几个月", "近三个月", "过去 6 个月"), one of MONTH_WORDS, or a part of a year: one of PART_YEAR_WORDS or a
/// quarter Q1 to Q4 after no Latin letter ("2025 Q1", "2025Q3"). A 月 after no such number is none ("月薪", "岁月"), and a
/// question naming years alone asks for none. The table pick then keeps a monthly-only table rather than its annual twin,
/// which ends a year or two earlier.
pub fn question_months(question: &str) -> bool {
    let text: String = question.chars().filter(|c| !c.is_whitespace()).collect();
    if text.contains("个月") || MONTH_WORDS.iter().chain(&PART_YEAR_WORDS).any(|w| text.contains(w)) {
        return true;
    }
    let chars: Vec<char> = text.chars().collect();
    let quarter = chars.windows(2).enumerate().any(|(i, w)| {
        matches!(w, ['Q' | 'q', '1'..='4'])
            && (i == 0 || !chars[i - 1].is_ascii_alphabetic())
            && !chars.get(i + 2).is_some_and(|c| c.is_ascii_digit())
    });
    quarter
        || chars.iter().enumerate().any(|(i, c)| {
            *c == '月' && {
                let numeral = |c: &&char| c.is_ascii_digit() || "一二两三四五六七八九十".contains(**c);
                let n = chars[..i].iter().rev().take_while(numeral).count();
                count_of(&chars[i - n..i].iter().collect::<String>()).is_some_and(|m| (1..=12).contains(&m))
            }
        })
}

/// The dimension of Eurostat table `table` (its id) whose registry has composition groups (group_inputs), the first in the
/// file's order, with its total code and the groups' registry names (column "group_en") in their order; None for a World
/// Bank table and for a table with no such dimension, or whose groups the registry cannot give.
pub fn grouped_dim(table: &str) -> Option<(String, String, Vec<String>)> {
    if table.ends_with("@2") {
        return None;
    }
    let mut dims: Vec<&str> = Vec::new();
    for (t, d, _) in registry() {
        if t == table && !dims.contains(&d.as_str()) {
            dims.push(d.as_str());
        }
    }
    dims.into_iter().find_map(|dim| {
        let total = parts(table, dim).into_iter().find(|p| p.level == PART_LEVELS[0])?;
        match group_inputs(table, dim) {
            Ok(groups) if !groups.is_empty() => Some((dim.to_string(), total.code, groups.into_iter().map(|(g, _)| g).collect())),
            _ => None,
        }
    })
}

/// The table card's line under table `n` (its id `table`) when its registry has composition groups (grouped_dim): each
/// place's total of the grouped dimension splits into the registered groups, by their registry names. Shown under every
/// such table whatever the question; None for a table with none.
pub fn parts_line(n: usize, table: &str) -> Option<String> {
    let (dim, total, groups) = grouped_dim(table)?;
    let [before, after] = PARTS_LINE_WORDS;
    Some(format!("   t{n}: {before} {dim} {total} {after} {}", groups.join(", ")))
}

/// A count in digits, or in Chinese numerals up to 九十九 (十 ten, 两 two).
fn count_of(s: &str) -> Option<i32> {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        return s.parse().ok();
    }
    let digit = |c: char| "一二三四五六七八九".find(c).map(|i| i as i32 / 3 + 1).or((c == '两').then_some(2));
    let c: Vec<char> = s.chars().collect();
    match c.as_slice() {
        [d] => digit(*d).or((*d == '十').then_some(10)),
        ['十', d] => Some(10 + digit(*d)?),
        [d, '十'] => Some(digit(*d)? * 10),
        [a, '十', b] => Some(digit(*a)? * 10 + digit(*b)?),
        _ => None,
    }
}

/// A table whose fetch is annual: a World Bank indicator, or a Eurostat table whose one freq to fetch is A. Its years are
/// the program's (fill), never an item of the table pick.
pub fn annual(table: &TableMeta) -> bool {
    table.worldbank || table.freq().ok() == Some("A")
}

/// The years a hub table with a monthly twin is fetched for, from the leaf registry's ring knobs (not asked of the model).
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    /// ring.years: the main's years, ending at its last year.
    pub years: i32,
    /// ring.months: the twin's months, ending at its last month.
    pub months: i64,
    pub hub: String,
    pub twin: String,
    /// The breakdown dimensions whose fetch fills geo with the hub, the only answers that take the window; None when every
    /// answer does, and then no years item is asked.
    pub only: Option<Vec<String>>,
}

impl Draft {
    /// The window the answer with this breakdown (None for none) takes, if any.
    pub fn window_for(&self, breakdown: Option<&str>) -> Option<&Window> {
        self.window.as_ref().filter(|w| match (&w.only, breakdown) {
            (None, _) => true,
            (Some(dims), Some(b)) => dims.iter().any(|d| d == b),
            (Some(_), None) => false,
        })
    }
}

/// Where a window's numbers come from, as its event says.
pub const WINDOW_SOURCE: &str = "knobs.json ring.years/ring.months";

/// A dimension, its offered codes, and how many codes it has.
pub type OfferedDim = (String, Vec<(String, String)>, usize);

/// The fetch arguments of one table and the event that records how they were filled.
#[derive(Clone, Debug, PartialEq)]
pub struct Filled {
    pub args: Map<String, Value>,
    pub event: Value,
    /// The draft's window if the answer's breakdown takes it (Draft::window_for), else None.
    pub window: Option<Window>,
}

fn total_of<'a>(dim: &str, codes: &'a [(String, String)]) -> Option<&'a str> {
    TOTAL_CODES
        .iter()
        .filter(|(d, _)| *d == "*" || *d == dim)
        .find_map(|(_, total)| {
            codes
                .iter()
                .find(|(c, _)| c == total)
                .map(|(c, _)| c.as_str())
        })
}

/// A label that names a whole ("Total ...", Eurostat's wording): offered first, as a whole to pick, never fixed, since one
/// dimension can hold several (src_crf: excluding memo items, excluding LULUCF) and "Total crop" is a subtotal.
fn total_label(label: &str) -> bool {
    label
        .strip_prefix("Total")
        .is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric()))
}

/// A memo item is reported beside the inventory, not part of it (Eurostat src_crf "Memo items", "(memo item)"): never offered.
/// A whole that names them ("Total (excluding memo items)") is a whole.
fn memo_label(label: &str) -> bool {
    !total_label(label) && label.to_lowercase().contains("memo item")
}

/// The Eurostat code of an iso2 country (GR is EL).
fn estat_code(iso: &str) -> &str {
    ESTAT_ISO
        .iter()
        .find(|(_, i)| *i == iso)
        .map_or(iso, |(e, _)| *e)
}

/// Draft::named and Draft::ambiguous: each named country geo does not hold, in the one place-valued dimension that lists it
/// (its own code first, else the first version of it, CN_X_HK for China). A country no dimension holds, or two or more
/// dimensions hold (flights from or to China), is left to fill, which drops it.
#[allow(clippy::type_complexity)]
fn named_elsewhere(
    table: &TableMeta,
    places: &[Place],
) -> (
    Vec<(String, Vec<(String, String)>)>,
    Vec<(String, Vec<String>)>,
) {
    let geo = table
        .dims
        .iter()
        .find(|(d, _)| d == GEO_DIM)
        .map_or(&[][..], |(_, c)| c.as_slice());
    let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut ambiguous: Vec<(String, Vec<String>)> = Vec::new();
    for p in places {
        let Place::Country(iso) = p else {
            continue;
        };
        let own = estat_code(iso);
        if table.worldbank || geo.iter().any(|(g, _)| g == own) {
            continue;
        }
        let listing: Vec<(&String, (String, String))> = table
            .place_members
            .iter()
            .filter_map(|(dim, members)| {
                let of: Vec<&(String, String)> = members.iter().filter(|(_, i)| i == iso).collect();
                of.iter()
                    .find(|(c, _)| c == own)
                    .or(of.first())
                    .map(|m| (dim, (*m).clone()))
            })
            .collect();
        let [(dim, member)] = listing.as_slice() else {
            if listing.len() > 1 && !ambiguous.iter().any(|(i, _)| i == iso) {
                ambiguous.push((
                    iso.clone(),
                    listing.iter().map(|(d, _)| (*d).clone()).collect(),
                ));
            }
            continue;
        };
        let (dim, member) = (*dim, member.clone());
        match out.iter_mut().find(|(d, _)| d == dim) {
            Some((_, held)) if held.contains(&member) => {}
            Some((_, held)) => held.push(member),
            None => out.push((dim.clone(), vec![member])),
        }
    }
    (out, ambiguous)
}

/// The refusal of a table that holds none of the named places, naming each named country two dimensions list (which one
/// the question means is not fixed) with one example.
fn holds_none(draft: &Draft) -> String {
    let mut text = format!(
        "{} holds none of the places the question names",
        draft.table.id
    );
    for (iso, dims) in &draft.ambiguous {
        let code = draft
            .table
            .place_members
            .iter()
            .find(|(d, _)| d == &dims[0])
            .and_then(|(_, m)| m.iter().find(|(_, i)| i == iso))
            .map_or(iso.as_str(), |(c, _)| c.as_str());
        text.push_str(&format!(
            "; {iso} is listed in {}, and which one the question means is not fixed (for example {}={code})",
            dims.join(" and "),
            dims[0]
        ));
    }
    text
}

fn country_like(code: &str) -> bool {
    code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// A place dimension before the fetch: geo, or a dimension whose codes are mostly two-letter country codes (classify's share).
fn place_like(dim: &str, codes: &[(String, String)]) -> bool {
    dim == GEO_DIM
        || (codes.len() >= 2
            && codes.iter().filter(|(c, _)| country_like(c)).count() as f64 / codes.len() as f64
                >= PLACE_SHARE)
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// What the program fixes and what it asks for one table; `texts` are the model's search words, used only to order options.
/// `places` are the places the question names: a named country only another dimension lists fixes that dimension.
pub fn draft(table: TableMeta, texts: &[String], places: &[Place]) -> Draft {
    let searched: Vec<String> = texts.iter().flat_map(|t| words(t)).collect();
    let (named, ambiguous) = named_elsewhere(&table, places);
    let mut breakdown = Vec::new();
    let mut members = Vec::new();
    for (dim, codes) in &table.dims {
        if named.iter().any(|(d, _)| d == dim) {
            continue;
        }
        if dim != GEO_DIM && dim != UNIT_DIM && codes.len() > 1 {
            breakdown.push(dim.clone());
        }
        if dim == GEO_DIM || codes.len() == 1 || total_of(dim, codes).is_some() {
            continue;
        }
        let mut ranked: Vec<(bool, usize, &(String, String))> = codes
            .iter()
            .filter(|code| !memo_label(&code.1))
            .map(|code| {
                (
                    total_label(&code.1),
                    words(&code.1)
                        .iter()
                        .filter(|w| searched.contains(w))
                        .count(),
                    code,
                )
            })
            .collect();
        ranked.sort_by_key(|(total, hits, _)| std::cmp::Reverse((*total, *hits)));
        let offered = ranked
            .into_iter()
            .take(OPTIONS_MAX)
            .map(|(_, _, code)| code.clone())
            .collect();
        members.push((dim.clone(), offered, codes.len()));
    }
    breakdown.truncate(OPTIONS_MAX - 1);
    // A table whose flow estat-parts.tsv registers, both its dimensions offered and every leaf of each listed, is offered
    // one more split: the flow from each source leaf to each target leaf (fill, flow_parts).
    let dataset = table.id.strip_suffix("@2").unwrap_or(&table.id);
    if let Some((source, target)) = flow_dims(dataset) {
        let offered = |d: &str| breakdown.iter().any(|b| b == d);
        if breakdown.len() < OPTIONS_MAX - 1
            && offered(&source)
            && offered(&target)
            && listed_flow_parts(&table, &source).is_some()
            && listed_flow_parts(&table, &target).is_some()
        {
            breakdown.push(format!("{source}{FLOW_JOIN}{target}"));
        }
    }
    let many = table.worldbank && table.places.len() > MAX_CHART_ROWS;
    let places_open = many && places.is_empty();
    let named_open = many && (1..=RANK_SUBJECTS_MAX).contains(&places.len()) && !places.contains(&Place::Region);
    Draft {
        table,
        breakdown,
        members,
        named,
        ambiguous,
        places_open,
        named_open,
        window: None,
        named_years: None,
        ranked: None,
    }
}

/// The wb-rank-by.json option a draft's asked ranking fixes (its 1-based number and the option): only for a table with every
/// country open, or one whose question names countries beside the ranking (named_open), and only an option ranked by another
/// indicator that is the ranking's reference. None leaves "t<n>.places" to the pick, or the named places to fill, as before.
pub fn ranked_option(d: &Draft) -> Option<(usize, &'static RankBy)> {
    let asked = d.ranked.as_ref().filter(|_| d.places_open || d.named_open)?;
    wb_rank_by()
        .1
        .iter()
        .enumerate()
        .find(|(_, o)| o.by.as_deref() == Some(asked.by.as_str()))
        .map(|(i, o)| (i + 1, o))
}

/// The dimensions breakdown entry `entry` takes the codes of: its own dimension, or a flow split's two (flow_split).
pub fn split_dims(entry: &str) -> Vec<&str> {
    match flow_split(entry) {
        Some((source, target)) => vec![source, target],
        None => vec![entry],
    }
}

/// The breakdown options that take member dimension `dim` (split_dims): its item is answered only when the breakdown is
/// none of them (a breakdown takes every code of its dimension, a flow split its leaves, so a code picked for it would have
/// no place). Empty for a dimension that is no member item or that no breakdown takes.
fn splits_taking<'a>(d: &'a Draft, dim: &str) -> Vec<&'a str> {
    if !d.members.iter().any(|(m, _, _)| m == dim) {
        return Vec::new();
    }
    d.breakdown.iter().map(String::as_str).filter(|b| split_dims(b).contains(&dim)).collect()
}

/// A member dimension that is also a breakdown option, by itself or as a side of a flow split (splits_taking).
fn split_member(d: &Draft, dim: &str) -> bool {
    !splits_taking(d, dim).is_empty()
}

/// The items of table `n` (its number in the table pick) with their option labels: the years (only for a table that is not
/// annual: an annual one's are the program's, fill), the economies a World Bank table with every country open keeps, its breakdown when it has a breakdown
/// dimension, and each member dimension ("t<n>.years", "t<n>.places", "t<n>.breakdown", "t<n>.<dim>"). The breakdown's
/// options say what the page then compares.
pub fn items(n: usize, d: &Draft) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    if !annual(&d.table) {
        out.push((
            format!("t{n}.{YEARS_KEY}"),
            YEARS_OPTIONS.iter().map(|s| s.to_string()).collect(),
        ));
    }
    if d.places_open && ranked_option(d).is_none() {
        let (cap, options) = wb_rank_by();
        out.push((
            format!("t{n}.{PLACES_KEY}"),
            options
                .iter()
                .map(|o| format!("keep {}", o.label.replace("{n}", &cap.to_string())))
                .collect(),
        ));
    }
    if !d.breakdown.is_empty() {
        let mut options = vec![
            "none: one number per place, each item below keeps the one code picked".to_string(),
        ];
        for dim in &d.breakdown {
            if let Some((source, target)) = flow_split(dim) {
                let leaves = |side: &str| listed_flow_parts(&d.table, side).map_or(0, |l| l.len());
                // a side that is a member item is answered by the flow's leaves, so its item is left out
                let leave: String = [source, target]
                    .iter()
                    .filter(|side| d.members.iter().any(|(m, _, _)| m == *side))
                    .map(|side| format!("; leave out t{n}.{side}"))
                    .collect();
                // a leaf the registry leaves out of the flow is said, never fetched (flow_excluded)
                let dataset = d.table.id.strip_suffix("@2").unwrap_or(&d.table.id);
                let out: String = flow_excluded(dataset)
                    .unwrap_or_default()
                    .iter()
                    .map(|p| format!("; {source} {} left out (registered as not applicable)", p.code))
                    .collect();
                options.push(format!(
                    "flow from {source} to {target}: each place × {} {source} parts × {} {target} parts, the leaves under each total (no total or subtotal drawn){out}{leave}",
                    leaves(source),
                    leaves(target)
                ));
                continue;
            }
            let codes = &d
                .table
                .dims
                .iter()
                .find(|(id, _)| id == dim)
                .expect("a breakdown dimension is a dimension")
                .1;
            let some: Vec<&str> = codes
                .iter()
                .take(3)
                .map(|(c, l)| if l.is_empty() { c.as_str() } else { l.as_str() })
                .collect();
            let leave = if split_member(d, dim) {
                format!("; leave out t{n}.{dim}")
            } else {
                String::new()
            };
            options.push(format!(
                "split by {dim}: each place × all {} {dim} codes (e.g. {}){leave}",
                codes.len(),
                some.join("; ")
            ));
        }
        out.push((format!("t{n}.breakdown"), options));
    }
    for (dim, offered, _) in &d.members {
        out.push((
            format!("t{n}.{dim}"),
            offered
                .iter()
                .map(|(c, l)| {
                    if l.is_empty() {
                        c.clone()
                    } else {
                        format!("{c}: {l}")
                    }
                })
                .collect(),
        ));
    }
    out
}

/// The words for a freq other than annual (FREQS).
const FREQ_WORDS: [(&str, &str); 5] = [
    ("S", "half-yearly"),
    ("Q", "quarterly"),
    ("M", "monthly"),
    ("W", "weekly"),
    ("D", "daily"),
];

/// A Eurostat table whose fetch freq is not annual, said with its span ("the table is monthly only, 2008M01 to
/// 2026M08"), so a year question can see it before picking; none for an annual or World Bank table.
fn non_annual(table: &TableMeta) -> Option<String> {
    let f = table.freq().ok().filter(|f| *f != "A")?;
    let (_, first, last) = table.freqs.iter().find(|(g, _, _)| g == f)?;
    let (_, word) = FREQ_WORDS.iter().find(|(g, _)| *g == f)?;
    Some(format!("the table is {word} only, {first} to {last}"))
}

/// The lines listed under table `n` in the table pick: each item with its numbered options; a member item a breakdown
/// can take says when it is answered.
pub fn lines(n: usize, d: &Draft, items: &[(String, Vec<String>)]) -> Vec<String> {
    let mut lines = Vec::new();
    for (key, options) in items {
        match key
            .strip_prefix(&format!("t{n}."))
            .filter(|dim| split_member(d, dim))
        {
            Some(dim) => lines.push(format!(
                "   {key} (only when t{n}.breakdown is not {}):",
                splits_taking(d, dim).join(" or ")
            )),
            None if *key == format!("t{n}.{YEARS_KEY}") => match non_annual(&d.table) {
                Some(span) => lines.push(format!("   {key} ({span}):")),
                None => lines.push(format!("   {key}:")),
            },
            None => lines.push(format!("   {key}:")),
        }
        lines.extend(
            options
                .iter()
                .enumerate()
                .map(|(k, o)| format!("     {}. {o}", k + 1)),
        );
    }
    lines
}

/// The fetch arguments of table `n` (its number in the table pick) from the answer (item key -> option number, every item answered) and the
/// places the question names. A split by a dimension with registered parts (parts) fetches those codes, not every code; a
/// flow split (flow_split) fetches the leaves of both its dimensions (flow_parts). Err when the table holds none of the named
/// places, or a flow split's table does not list every leaf.
pub fn fill(
    draft: &Draft,
    n: usize,
    picks: &BTreeMap<String, usize>,
    places: &[Place],
    this_year: i32,
) -> Result<Filled, String> {
    let table = &draft.table;
    let pick = |key: &str| picks.get(key).copied().unwrap_or(1);
    let breakdown = match pick(&format!("t{n}.breakdown")) {
        1 => None,
        k => draft.breakdown.get(k - 2).cloned(),
    };
    let flow = breakdown.as_deref().and_then(flow_split);
    let dataset_id = table.id.strip_suffix("@2").unwrap_or(&table.id);
    // the source leaves the registry leaves out of the flow: not fetched, every pair of them said in the event
    let excluded = if flow.is_some() { flow_excluded(dataset_id)? } else { Vec::new() };
    // The named countries geo is filled from: those another dimension holds are that dimension's (Draft::named).
    let countries: Vec<&str> = places
        .iter()
        .filter_map(|p| match p {
            Place::Country(iso) => Some(iso.as_str()),
            Place::Region => None,
        })
        .filter(|iso| {
            !draft
                .named
                .iter()
                .any(|(_, held)| held.iter().any(|(_, i)| i == iso))
        })
        .collect();
    let region = places.contains(&Place::Region);
    let mut filters = Vec::new();
    // (dimension, its code count) left open: newsroom_data_prepare takes every code of it.
    let mut open: Option<(String, usize)> = None;
    let mut rows: u64 = 1;
    let mut put = |filters: &mut Vec<Value>, dim: &str, values: Vec<String>| {
        rows *= values.len() as u64;
        filters.push(json!({"dimension": dim, "values": values}));
    };
    let mut cut = Map::new();
    // The places the question names that the table does not hold (a named country, or an EU member under a region
    // word): left out of the fetch and kept in the event, so the page cannot imply them.
    let mut dropped: Vec<String> = Vec::new();
    // The split dimension fetched as its registered parts, with where they came from and each part's parent (the params
    // event's "parts"), so a replay reads the hierarchy the fetch was asked with.
    let mut parted: Vec<Value> = Vec::new();
    let dataset = table.id.strip_suffix("@2").unwrap_or(&table.id);
    if table.worldbank {
        let mut ids = |isos: &mut dyn Iterator<Item = &str>| -> Vec<String> {
            isos.filter_map(|iso| {
                let id = table
                    .places
                    .iter()
                    .find(|(i, _)| i == iso)
                    .map(|(_, id)| id.clone());
                if id.is_none() {
                    dropped.push(iso.to_string());
                }
                id
            })
            .collect()
        };
        // A ranking the program fixes (ranked_option) keeps its economies; a named one is the ranking's subject, drawn when
        // the ranking holds it.
        let ranking = ranked_option(draft).is_some();
        let values = if ranking {
            Vec::new()
        } else if !countries.is_empty() {
            ids(&mut countries.iter().copied())
        } else if region {
            ids(&mut EU27.iter().map(|c| {
                ESTAT_ISO
                    .iter()
                    .find(|(e, _)| e == c)
                    .map_or(*c, |(_, i)| *i)
            }))
        } else {
            Vec::new()
        };
        if values.is_empty() {
            if !ranking && (!countries.is_empty() || region) {
                return Err(holds_none(draft));
            }
            open = Some((WB_PLACE_DIM.to_string(), table.places.len()));
        } else {
            put(&mut filters, WB_PLACE_DIM, values);
        }
    } else {
        put(&mut filters, FREQ_DIM, vec![table.freq()?.to_string()]);
        for (dim, codes) in &table.dims {
            if let Some((_, held)) = draft.named.iter().find(|(d, _)| d == dim) {
                put(
                    &mut filters,
                    dim,
                    held.iter().map(|(c, _)| c.clone()).collect(),
                );
                continue;
            }
            if let Some((source, _)) = flow.filter(|&(s, t)| dim == s || dim == t) {
                // A flow split fetches the leaves of both its dimensions (flow_parts), so no total or subtotal is a flow
                // beside its own parts; the totals they add up to are named, not fetched.
                let leaves = listed_flow_parts(table, dim).ok_or_else(|| {
                    format!("{dataset} does not list every registered leaf of {dim}, so its flow would fall short of the total")
                })?;
                let registered = parts(dataset, dim);
                parted.push(json!({"dimension": dim, "source": PARTS_SOURCE, "codes": leaves.len(), "registered": registered.len(),
                    "from_codes": codes.len(), "flow": if dim == source { FLOW_SIDES[0] } else { FLOW_SIDES[1] }, "level": PART_LEVELS[2],
                    "totals": registered.iter().filter(|p| p.level != PART_LEVELS[2]).map(|p| p.code.as_str()).collect::<Vec<_>>(),
                    "parents": registered.iter().filter(|p| leaves.contains(&p.code)).filter_map(|p| Some([p.code.as_str(), p.parent.as_deref()?])).collect::<Vec<_>>()}));
                put(&mut filters, dim, leaves);
                continue;
            }
            if Some(dim) == breakdown.as_ref() {
                // A split by a dimension with registered parts (estat-parts.tsv) fetches the parts the table lists, its total
                // among them, not every code; any other split leaves its dimension open.
                let registered = parts(dataset, dim);
                let listed: Vec<String> = registered
                    .iter()
                    .filter(|p| codes.iter().any(|(c, _)| *c == p.code))
                    .map(|p| p.code.clone())
                    .collect();
                let whole = registered
                    .iter()
                    .any(|p| p.level == PART_LEVELS[0] && listed.contains(&p.code));
                if whole && listed.len() > 1 {
                    parted.push(json!({"dimension": dim, "source": PARTS_SOURCE, "codes": listed.len(),
                        "registered": registered.len(), "from_codes": codes.len(),
                        "unlisted": registered.iter().filter(|p| !listed.contains(&p.code)).map(|p| p.code.as_str()).collect::<Vec<_>>(),
                        "parents": registered.iter().filter(|p| listed.contains(&p.code)).filter_map(|p| Some([p.code.as_str(), p.parent.as_deref()?])).collect::<Vec<_>>()}));
                    put(&mut filters, dim, listed);
                } else {
                    open = Some((dim.clone(), codes.len()));
                }
                continue;
            }
            if dim == GEO_DIM {
                continue;
            }
            let value = if codes.len() == 1 {
                codes[0].0.clone()
            } else if let Some(total) = total_of(dim, codes) {
                total.to_string()
            } else {
                let (_, offered, all) = draft
                    .members
                    .iter()
                    .find(|(d, _, _)| d == dim)
                    .expect("a dimension with no total is an item");
                if offered.len() < *all {
                    cut.insert(dim.clone(), json!({"offered": offered.len(), "codes": all}));
                }
                offered
                    .get(pick(&format!("t{n}.{dim}")) - 1)
                    .map_or_else(|| offered[0].0.clone(), |(c, _)| c.clone())
            };
            put(&mut filters, dim, vec![value]);
        }
        if let Some((_, geo)) = table.dims.iter().find(|(d, _)| d == GEO_DIM) {
            let held = |c: &str| geo.iter().any(|(g, _)| g == c);
            let by_place = breakdown
                .as_ref()
                .and_then(|b| table.dims.iter().find(|(d, _)| d == b))
                .is_some_and(|(d, codes)| place_like(d, codes));
            let mut keep = |codes: &mut dyn Iterator<Item = &str>| -> Vec<String> {
                codes
                    .filter(|c| {
                        held(c) || {
                            dropped.push(c.to_string());
                            false
                        }
                    })
                    .map(str::to_string)
                    .collect()
            };
            // A region word beside EU members only ("the EU countries' early-leaver rate, where does Italy rank", n51): the
            // named members are the subject, the region the set, so geo is the region's members, the named ones among them.
            let members_named = region
                && !countries.is_empty()
                && countries.iter().all(|iso| EU27.contains(&estat_code(iso)));
            let values: Vec<String> = if members_named {
                keep(&mut EU27.iter().copied())
            } else if !countries.is_empty() {
                keep(&mut countries.iter().map(|iso| estat_code(iso)))
            } else if by_place {
                [EU_AGGREGATE]
                    .into_iter()
                    .filter(|c| held(c))
                    .map(str::to_string)
                    .collect()
            } else if region && !EU27.iter().any(|c| held(c)) && held(EU_AGGREGATE) {
                // A table of the EU as a whole (geo EU27_2020 only, the trade tables): the region is that one code.
                vec![EU_AGGREGATE.to_string()]
            } else if region {
                keep(&mut EU27.iter().copied())
            } else if breakdown.is_some() {
                geo.iter()
                    .map(|(c, _)| c)
                    .filter(|c| country_like(c))
                    .cloned()
                    .collect()
            } else {
                open = Some((GEO_DIM.to_string(), geo.len()));
                Vec::new()
            };
            if open.as_ref().is_none_or(|(d, _)| d != GEO_DIM) {
                if values.is_empty() {
                    return Err(holds_none(draft));
                }
                put(&mut filters, GEO_DIM, values);
            }
        } else if !countries.is_empty() {
            // No geo (env_ac_co2fp: c_orig and c_dest): a named country no dimension is fixed to is left out, and a
            // table fixed to none of them holds none.
            if draft.named.is_empty() {
                return Err(holds_none(draft));
            }
            dropped.extend(countries.iter().map(|c| c.to_string()));
        }
    }
    let rows_but_years = rows * open.as_ref().map_or(1, |(_, count)| *count as u64);
    let limit = if table.worldbank {
        MAX_ROWS_WORLDBANK
    } else {
        MAX_ROWS_EUROSTAT
    };
    let mut end = table.end_year.unwrap_or(this_year - 1);
    let mut latest = if table.worldbank {
        end - WB_LATEST_SPAN + 1
    } else {
        end
    };
    // An annual table's years are the program's: the ones the question names, else the last ten; a years option given for
    // one is the program's own (a split that draws only with the latest year, next_flow). Any other table's are the item's.
    let given = picks.get(&format!("t{n}.{YEARS_KEY}")).copied();
    let window = draft.window_for(breakdown.as_deref());
    let named = draft.named_years.filter(|_| annual(table) && window.is_none());
    let (asked, rule) = match (window, named, annual(table), given) {
        (Some(_), ..) => (given.unwrap_or(1), "window"),
        (None, Some(_), ..) => (ANNUAL_YEARS, "question"),
        (None, None, true, Some(k)) => (k, "split"),
        (None, None, true, None) => (ANNUAL_YEARS, "annual"),
        (None, None, false, k) => (k.unwrap_or(1), "model"),
    };
    // The latest year of a registered flow table at M or Q is summed from its periods: the fetch starts a year earlier, so the latest
    // year every series holds whole is in the file whichever month each series ends at.
    let summed = sum_year(table).filter(|_| asked != 2 && window.is_none());
    let mut start = if let Some(window) = window {
        end - window.years + 1
    } else if let Some(named) = named {
        // the question's years, kept to what the table has: no later than its last year
        let (from, to) = match named {
            NamedYears::Span(a, b) => (a, b),
            NamedYears::Last(k) => (end - k + 1, end),
        };
        end = end.min(to);
        latest = latest.min(end);
        from.min(end)
    } else if asked == 2 {
        end - YEARS_SPAN + 1
    } else if summed.is_some() {
        latest - 1
    } else {
        latest
    };
    let mut years_cut = Value::Null;
    if rows_but_years * (end - start + 1) as u64 > limit && start < latest {
        // A summed table keeps the year before, which every series holds whole, not the latest months alone: those sum to no
        // full year, so the fetch would hold nothing to chart.
        let to = if summed.is_some() && asked != 2 {
            latest - 1
        } else {
            latest
        };
        years_cut = json!({"from": {"start": start, "end": end}, "to": {"start": to, "end": if to < latest { to } else { end }},
            "estimate": rows_but_years * (end - start + 1) as u64, "limit": limit});
        if to < latest {
            end = to;
        }
        start = to;
    }
    // An open place dimension with more codes than a chart shows, every other dimension one code: the tool keeps its top
    // codes (two-letter codes only, the total refetched as the denominator); a dimension of another kind stays as asked.
    let years = (end - start + 1) as usize;
    let mut narrow = Value::Null;
    // A World Bank table with every country open: the tool keeps the economies of the picked registry option (aggregates
    // out, ranked at the latest year most of them have), at most the chart's rows over the years.
    if let Some((_, count)) = open
        .as_ref()
        .filter(|(dim, _)| (draft.places_open || ranked_option(draft).is_some()) && dim == WB_PLACE_DIM)
    {
        let (cap, options) = wb_rank_by();
        let fixed = ranked_option(draft);
        let (option, rank) = fixed.unwrap_or_else(|| {
            let kept = pick(&format!("t{n}.{PLACES_KEY}"));
            kept.checked_sub(1)
                .and_then(|i| options.get(i))
                .map_or((1, &options[0]), |o| (kept, o))
        });
        // The count the question writes, kept to the registry's cap and the chart's rows over the years; the page prints the
        // count the narrow record keeps, and the event keeps the count asked.
        let asked = fixed.and(draft.ranked.as_ref());
        let kept_n = asked
            .and_then(|r| r.n)
            .unwrap_or(*cap)
            .min(*cap)
            .min(MAX_CHART_ROWS / years)
            .max(1);
        let from = if asked.is_some() { "question" } else { "pick" };
        let asked = asked.map(|r| json!({"phrase": r.phrase, "by": r.by, "n": r.n}));
        narrow = json!({"dimension": WB_PLACE_DIM, "rule": rank.rule, "by": rank.by, "n": kept_n,
            "exclude": [], "option": option, "key": rank.key, "label": rank.label, "from_codes": count,
            "estimate": count * years, "chart_rows": MAX_CHART_ROWS,
            "from": from, "asked": asked});
    }
    if let Some((dim, count)) = open
        .as_ref()
        .filter(|(_, count)| !table.worldbank && *count > MAX_CHART_ROWS)
    {
        let codes = &table
            .dims
            .iter()
            .find(|(d, _)| d == dim)
            .expect("the open dimension is a dimension")
            .1;
        let single = filters
            .iter()
            .all(|f| f["values"].as_array().is_some_and(|v| v.len() == 1));
        if single && place_like(dim, codes) {
            let total = total_of(dim, codes);
            let exclude: Vec<&str> = codes
                .iter()
                .map(|(c, _)| c.as_str())
                .filter(|c| !country_like(c) && Some(*c) != total)
                .collect();
            narrow = json!({"dimension": dim, "rule": "top", "n": NARROW_TOP.min(MAX_CHART_ROWS / years).max(1),
                "exclude": exclude, "total": total, "from_codes": count, "estimate": count * years, "chart_rows": MAX_CHART_ROWS});
        }
    }
    let mut args = Map::new();
    if table.worldbank {
        args.insert("provider".into(), json!("worldbank"));
    }
    args.insert("dataset".into(), json!(dataset));
    if !filters.is_empty() {
        args.insert("filters".into(), Value::Array(filters));
    }
    args.insert("years".into(), json!({"start": start, "end": end}));
    if let Some(SumYear { n, share }) = summed {
        args.insert("sum_year".into(), json!({"n": n, "share": share}));
    }
    if let Some(n) = narrow.as_object() {
        let mut arg: Map<String, Value> = n
            .iter()
            .filter(|(k, _)| ["dimension", "rule", "n", "exclude"].contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for key in ["total", "by"] {
            if !n.get(key).unwrap_or(&Value::Null).is_null() {
                arg.insert(key.into(), n[key].clone());
            }
        }
        args.insert("narrow".into(), Value::Object(arg));
    }
    let mut event = json!({
        "table": table.id, "args": args, "breakdown": breakdown, "open": open.map(|(d, _)| d),
        "years": match window {
            None => json!({"option": asked, "rule": rule, "named": named.map(|n| match n {
                    NamedYears::Span(a, b) => json!({"from": a, "to": b}),
                    NamedYears::Last(k) => json!({"last": k}),
                }), "end_from": if table.end_year.is_some() { "toc" } else { "this year - 1" }, "this_year": this_year}),
            Some(w) => json!({"window": {"years": w.years, "months": w.months, "hub": w.hub, "twin": w.twin, "only": w.only, "source": WINDOW_SOURCE},
                "rule": rule, "end_from": if table.end_year.is_some() { "toc" } else { "this year - 1" }, "this_year": this_year}),
        },
        "years_cut": years_cut, "estimate": rows_but_years * (end - start + 1) as u64, "limit": limit, "options_cut": cut,
        "places": places.iter().map(|p| match p { Place::Country(iso) => iso.clone(), Place::Region => "region".to_string() }).collect::<Vec<_>>(),
        "dropped": dropped, "narrow": narrow,
    });
    if !parted.is_empty() {
        event["parts"] = json!(parted);
    }
    if let Some((source, target)) = flow {
        event["flow"] = json!({"source": source, "target": target, "from": PARTS_SOURCE});
        if !excluded.is_empty() {
            // the pairs the registry's leaves span (each source leaf with each target leaf), less the excluded leaves' own
            let (from, to) = (flow_parts(dataset_id, source).len(), flow_parts(dataset_id, target).len());
            event["flow"]["pairs"] = json!({"registered": from * to, "excluded": excluded.len() * to, "asked": (from - excluded.len()) * to});
            event["flow"]["excluded"] = excluded
                .iter()
                .map(|p| json!({"dimension": source, "code": p.code, "from": p.excluded_from, "pairs": to, "source": p.excluded_source}))
                .collect();
        }
    }
    if !draft.named.is_empty() {
        event["named"] = json!(draft.named);
    }
    if !draft.ambiguous.is_empty() {
        event["ambiguous"] = json!(draft.ambiguous);
    }
    Ok(Filled {
        args,
        event,
        window: window.cloned(),
    })
}

/// The slice the fetch of these picks would vary over, judged from its arguments before any download: each filtered
/// dimension with more than one code, the open dimension (its code count, or the top the tool narrows it to), and the
/// time when more than one year is asked (a summed fetch is one year: its periods are summed to it). Roles are what the codes
/// alone tell (a place, the time, else a category); a category whose total code is fetched with at least 3 other codes, in a unit
/// `unit_additive` says adds up, is an unchecked additive category with that total. A flow split reports its registered pair as
/// the official flow. The knowledge group's classify judges the fetched rows again, and grants the tag only where the data adds
/// up. Err as fill.
pub fn predicted_shape(
    draft: &Draft,
    n: usize,
    picks: &BTreeMap<String, usize>,
    places: &[Place],
    this_year: i32,
    unit_additive: &dyn Fn(&str) -> Option<bool>,
) -> Result<Shape, String> {
    let filled = fill(draft, n, picks, places, this_year)?;
    let codes = |dim: &str| {
        draft
            .table
            .dims
            .iter()
            .find(|(d, _)| d == dim)
            .map_or(&[][..], |(_, c)| c.as_slice())
    };
    let unit = filled
        .args
        .get("filters")
        .and_then(Value::as_array)
        .and_then(|fs| {
            fs.iter()
                .find(|f| f["dimension"] == "unit")
                .and_then(|f| f["values"].as_array())
                .filter(|v| v.len() == 1)
                .and_then(|v| v[0].as_str())
        });
    let additive = !draft.table.worldbank && unit.and_then(unit_additive) == Some(true);
    let varying = |dim: &str, values: &[&str]| {
        let is_place = dim == WB_PLACE_DIM || place_like(dim, codes(dim));
        let total = total_of(dim, codes(dim)).filter(|t| {
            additive && !is_place && values.contains(t) && values.len() > ADDITIVE_MIN_PARTS
        });
        VaryingDim {
            dim: dim.to_string(),
            members: values.len(),
            roles: match (is_place, total) {
                (true, _) => vec![Role::Place],
                (false, Some(_)) => vec![Role::AdditiveCategory, Role::Category],
                (false, None) => vec![Role::Category],
            },
            is_place,
            iso_countries: dim == WB_PLACE_DIM
                || (is_place && values.iter().all(|c| country_like(c))),
            total_member: total.map(str::to_string),
        }
    };
    let mut dims = Vec::new();
    for f in filled
        .args
        .get("filters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let values: Vec<&str> = f["values"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if values.len() > 1 {
            dims.push(varying(f["dimension"].as_str().unwrap_or(""), &values));
        }
    }
    if let Some(open) = filled.event["open"].as_str() {
        let all: Vec<&str> = if draft.table.worldbank && open == WB_PLACE_DIM {
            draft
                .table
                .places
                .iter()
                .map(|(_, id)| id.as_str())
                .collect()
        } else {
            codes(open).iter().map(|(c, _)| c.as_str()).collect()
        };
        let mut open_dim = varying(open, &all);
        if let Some(top) = filled.args.get("narrow").and_then(|n| n["n"].as_u64()) {
            open_dim.members = open_dim.members.min(top as usize);
        }
        if open_dim.members > 1 {
            dims.push(open_dim);
        }
    }
    let years = &filled.args["years"];
    let span = years["end"].as_i64().unwrap_or(0) - years["start"].as_i64().unwrap_or(0) + 1;
    if span > 1 && !filled.args.contains_key("sum_year") {
        dims.push(VaryingDim {
            dim: "time".into(),
            members: span as usize,
            roles: vec![Role::Time],
            is_place: false,
            iso_countries: false,
            total_member: None,
        });
    }
    // A flow split's pair is the flow estat-parts.tsv registers for the table (flow_dims), as classify reads it after the fetch.
    let official_flow = filled.event["flow"]
        .as_object()
        .and_then(|f| Some((f.get("source")?.as_str()?.to_string(), f.get("target")?.as_str()?.to_string())));
    Ok(Shape {
        dims,
        unit_additive: false,
        official_flow,
    })
}

/// A held-series probe's key: each dimension it fixes, with its codes (a dimension not listed is open).
pub type Key = Vec<(String, Vec<String>)>;

/// The dimensions a probe leaves open: the breakdown options and the member items, whose codes the answer picks.
fn answered_dims(draft: &Draft) -> Vec<&str> {
    let mut dims: Vec<&str> = draft.breakdown.iter().map(String::as_str).collect();
    dims.extend(
        draft
            .members
            .iter()
            .map(|(d, _, _)| d.as_str())
            .filter(|d| !draft.breakdown.iter().any(|b| b == d)),
    );
    dims
}

/// The key a held-series probe asks before the table pick: the fixed part of the fetch with every item at option 1 (fill's
/// own filters), each breakdown and member dimension open, and the EU aggregate added to geo when a place breakdown would
/// fetch it. None for a World Bank table, a table fill refuses, or a key that fixes nothing but freq (never fully open).
pub fn probe_key(draft: &Draft, places: &[Place], this_year: i32) -> Option<Key> {
    if draft.table.worldbank {
        return None;
    }
    let filled = fill(draft, 1, &BTreeMap::new(), places, this_year).ok()?;
    let open = answered_dims(draft);
    let mut key: Key = filled.args["filters"]
        .as_array()?
        .iter()
        .filter_map(|f| {
            let dim = f["dimension"].as_str()?;
            let values = f["values"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            (!open.contains(&dim)).then(|| (dim.to_string(), values))
        })
        .collect();
    let place_split = draft.breakdown.iter().any(|b| {
        draft
            .table
            .dims
            .iter()
            .any(|(d, codes)| d == b && place_like(d, codes))
    });
    let holds_eu = draft
        .table
        .dims
        .iter()
        .any(|(d, c)| d == GEO_DIM && c.iter().any(|(g, _)| g == EU_AGGREGATE));
    if let Some((_, geo)) = key.iter_mut().find(|(d, _)| d == GEO_DIM) {
        if place_split
            && holds_eu
            && places.contains(&Place::Region)
            && !geo.iter().any(|g| g == EU_AGGREGATE)
        {
            geo.push(EU_AGGREGATE.to_string());
        }
    }
    key.iter().any(|(d, _)| d != FREQ_DIM).then_some(key)
}

/// The table as the probe found it: each dimension the key left open keeps only the metabase codes some series holds (a
/// dimension the reply has no column for, or whose held codes the metabase lists none of, keeps its codes). With the event:
/// each narrowed dimension's codes before and after, and the codes left out. Err when the probe found no series at all.
pub fn held_table(
    table: &TableMeta,
    key: &[(String, Vec<String>)],
    held: &Held,
) -> Result<(TableMeta, Value), String> {
    let Held::Series { dims, keys } = held else {
        return Ok((table.clone(), Value::Null));
    };
    if keys.is_empty() {
        return Err(format!("{} holds no series under the probe key", table.id));
    }
    let mut narrowed = table.clone();
    let mut event = Map::new();
    for (dim, codes) in narrowed.dims.iter_mut() {
        let Some(col) = dims
            .iter()
            .position(|d| d == dim)
            .filter(|_| !key.iter().any(|(k, _)| k == dim))
        else {
            continue;
        };
        let found: std::collections::BTreeSet<&str> = keys
            .iter()
            .filter_map(|k| k.get(col))
            .map(String::as_str)
            .collect();
        let kept: Vec<(String, String)> = codes
            .iter()
            .filter(|(c, _)| found.contains(c.as_str()))
            .cloned()
            .collect();
        if kept.is_empty() || kept.len() == codes.len() {
            continue;
        }
        let out: Vec<&str> = codes
            .iter()
            .map(|(c, _)| c.as_str())
            .filter(|c| !found.contains(c))
            .collect();
        event.insert(
            dim.clone(),
            json!({"codes": codes.len(), "held": kept.len(), "left_out": out,
            "fixed": (kept.len() == 1).then(|| kept[0].0.clone())}),
        );
        *codes = kept;
    }
    Ok((narrowed, Value::Object(event)))
}

/// Whether the fetch of these picks asks for a series the probe found: some series key holds, in every filtered dimension
/// the reply has a column for, one of that filter's codes (the open dimension takes any). Unprobed, or a table fill refuses:
/// true, so the check never stops what the fetch would not.
pub fn holds_series(
    draft: &Draft,
    n: usize,
    picks: &BTreeMap<String, usize>,
    places: &[Place],
    this_year: i32,
    held: &Held,
) -> bool {
    let Held::Series { dims, keys } = held else {
        return true;
    };
    let Ok(filled) = fill(draft, n, picks, places, this_year) else {
        return true;
    };
    let wanted: Vec<(usize, Vec<&str>)> = filled.args["filters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let col = dims
                .iter()
                .position(|d| Some(d.as_str()) == f["dimension"].as_str())?;
            Some((
                col,
                f["values"]
                    .as_array()?
                    .iter()
                    .filter_map(Value::as_str)
                    .collect(),
            ))
        })
        .collect();
    keys.iter().any(|k| {
        wanted
            .iter()
            .all(|(col, values)| k.get(*col).is_some_and(|c| values.contains(&c.as_str())))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dim(id: &str, codes: &[&str]) -> (String, Vec<(String, String)>) {
        (
            id.to_string(),
            codes
                .iter()
                .map(|c| (c.to_string(), format!("label {c}")))
                .collect(),
        )
    }

    fn eurostat(id: &str, dims: Vec<(String, Vec<(String, String)>)>) -> TableMeta {
        TableMeta {
            id: id.into(),
            worldbank: false,
            dims,
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        }
    }

    fn filter(filled: &Filled, dim: &str) -> Option<Vec<String>> {
        filled.args["filters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["dimension"] == dim)
            .map(|f| {
                f["values"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect()
            })
    }

    fn picks(pairs: &[(&str, usize)]) -> BTreeMap<String, usize> {
        pairs.iter().map(|(k, n)| (k.to_string(), *n)).collect()
    }

    /// The EU's trade with China (ext_st_eu27_2020sitc, cut): geo is the EU alone, China is partner CN_X_HK.
    fn eu_trade() -> TableMeta {
        let mut table = eurostat(
            "ext_st_eu27_2020sitc",
            vec![
                dim("indic_et", &["MIO_EXP_VAL", "MIO_IMP_VAL"]),
                dim("partner", &["EXT_EU27_2020", "US", "CN_X_HK", "HK", "JP"]),
                dim("geo", &["EU27_2020"]),
                dim("stk_flow", &["EXP", "IMP", "BAL_RT"]),
            ],
        );
        table.place_members = vec![(
            "partner".into(),
            [("US", "US"), ("CN_X_HK", "CN"), ("HK", "HK"), ("JP", "JP")]
                .iter()
                .map(|(c, i)| (c.to_string(), i.to_string()))
                .collect(),
        )];
        table
    }

    /// q3's table (nrg_cb_pem, cut): monthly only, geo, siec with a total, unit GWH or PC; TOTAL has no PC series.
    fn q3_table() -> TableMeta {
        let mut table = eurostat(
            "nrg_cb_pem",
            vec![
                dim("geo", &["DE", "FR", "EU27_2020"]),
                dim("siec", &["TOTAL", "C0000", "RA100"]),
                dim("unit", &["GWH", "PC"]),
            ],
        );
        table.freqs = vec![("M".into(), "2008M01".into(), "2026M08".into())];
        table
    }

    /// q3's probe reply as read: every siec in GWH, the two fuels in PC too, for DE and FR (the reply's own column order).
    fn q3_held() -> Held {
        let mut keys = Vec::new();
        for (siec, units) in [
            ("C0000", &["GWH", "PC"][..]),
            ("RA100", &["GWH", "PC"]),
            ("TOTAL", &["GWH"]),
        ] {
            for unit in units {
                for geo in ["DE", "FR"] {
                    keys.push(["M", siec, unit, geo].map(str::to_string).to_vec());
                }
            }
        }
        Held::Series {
            dims: ["freq", "siec", "unit", "geo"].map(str::to_string).to_vec(),
            keys,
        }
    }

    #[test]
    fn the_probe_key_fixes_the_fetch_part_and_opens_what_the_answer_picks() {
        let places = [Place::Country("DE".into()), Place::Country("FR".into())];
        let d = draft(q3_table(), &[], &places);
        assert_eq!(
            probe_key(&d, &places, 2026).unwrap(),
            [
                ("freq".to_string(), vec!["M".to_string()]),
                ("geo".to_string(), vec!["DE".to_string(), "FR".to_string()])
            ],
            "siec (a breakdown) and unit (an item) are open"
        );
        let mut wb = eurostat("SP.POP.TOTL@2", Vec::new());
        wb.worldbank = true;
        assert_eq!(probe_key(&draft(wb, &[], &places), &places, 2026), None);
        // No place named and nothing else fixed: freq alone is a fully open key, never probed.
        let open = eurostat(
            "x",
            vec![dim("geo", &["DE", "FR"]), dim("unit", &["A", "B"])],
        );
        assert_eq!(probe_key(&draft(open, &[], &[]), &[], 2026), None);
    }

    #[test]
    fn the_held_table_keeps_the_held_codes_and_a_400_never_reads_as_no_series() {
        let places = [Place::Country("DE".into())];
        let table = q3_table();
        let key = probe_key(&draft(table.clone(), &[], &places), &places, 2026).unwrap();
        let mut held = q3_held();
        if let Held::Series { keys, .. } = &mut held {
            keys.retain(|k| k[1] != "RA100");
        }
        let (narrowed, event) = held_table(&table, &key, &held).unwrap();
        assert_eq!(
            narrowed.dims[1]
                .1
                .iter()
                .map(|(c, _)| c.as_str())
                .collect::<Vec<_>>(),
            ["TOTAL", "C0000"]
        );
        assert_eq!(narrowed.dims[2], table.dims[2], "both units are held");
        assert_eq!(
            narrowed.dims[0], table.dims[0],
            "geo is fixed in the key, never narrowed"
        );
        assert_eq!(event["siec"]["left_out"], json!(["RA100"]));
        let none = Held::Series {
            dims: vec!["freq".into(), "geo".into()],
            keys: Vec::new(),
        };
        assert!(held_table(&table, &key, &none)
            .unwrap_err()
            .contains("no series"));
        let unprobed = Held::Unprobed("HTTP 400".into());
        assert_eq!(
            held_table(&table, &key, &unprobed).unwrap(),
            (table, Value::Null)
        );
    }

    #[test]
    fn a_dimension_with_one_held_code_is_fixed_and_not_asked() {
        let places = [Place::Country("DE".into())];
        let table = q3_table();
        let key = probe_key(&draft(table.clone(), &[], &places), &places, 2026).unwrap();
        let mut held = q3_held();
        if let Held::Series { keys, .. } = &mut held {
            keys.retain(|k| k[2] == "GWH");
        }
        let (narrowed, event) = held_table(&table, &key, &held).unwrap();
        assert_eq!(event["unit"]["fixed"], json!("GWH"));
        let d = draft(narrowed, &[], &places);
        assert!(
            d.members.iter().all(|(m, _, _)| m != "unit"),
            "no unit item: {:?}",
            d.members
        );
        let filled = fill(&d, 1, &BTreeMap::new(), &places, 2026).unwrap();
        assert_eq!(filter(&filled, "unit").unwrap(), ["GWH"]);
    }

    #[test]
    fn a_picked_combination_with_no_series_is_told_apart_from_one_with_series() {
        let places = [Place::Country("DE".into())];
        let d = draft(q3_table(), &[], &places);
        let unit = |code: &str| {
            d.members
                .iter()
                .find(|(m, _, _)| m == "unit")
                .unwrap()
                .1
                .iter()
                .position(|(c, _)| c == code)
                .unwrap()
                + 1
        };
        let held = q3_held();
        // No breakdown: siec is TOTAL, and TOTAL has no PC series.
        assert!(!holds_series(
            &d,
            1,
            &picks(&[("t1.breakdown", 1), ("t1.unit", unit("PC"))]),
            &places,
            2026,
            &held
        ));
        assert!(holds_series(
            &d,
            1,
            &picks(&[("t1.breakdown", 1), ("t1.unit", unit("GWH"))]),
            &places,
            2026,
            &held
        ));
        // Split by siec: siec is open, and the fuels hold PC.
        assert!(holds_series(
            &d,
            1,
            &picks(&[("t1.breakdown", 2), ("t1.unit", unit("PC"))]),
            &places,
            2026,
            &held
        ));
        assert!(holds_series(
            &d,
            1,
            &picks(&[("t1.breakdown", 1), ("t1.unit", unit("PC"))]),
            &places,
            2026,
            &Held::Unprobed("timeout".into())
        ));
    }

    #[test]
    fn a_named_country_only_another_dimension_lists_fixes_that_dimension() {
        let places = [Place::Region, Place::Country("CN".into())];
        let draft = draft(eu_trade(), &[], &places);
        assert_eq!(
            draft.named,
            [(
                "partner".to_string(),
                vec![("CN_X_HK".to_string(), "CN".to_string())]
            )]
        );
        assert!(!draft.breakdown.iter().any(|d| d == "partner"));
        assert!(!draft.members.iter().any(|(d, _, _)| d == "partner"));
        let filled = fill(&draft, 1, &picks(&[("t1.years", 1)]), &places, 2026).unwrap();
        assert_eq!(filter(&filled, "partner").unwrap(), ["CN_X_HK"]);
        assert_eq!(
            filter(&filled, "geo").unwrap(),
            ["EU27_2020"],
            "the EU named, geo holds only the EU as a whole"
        );
        assert_eq!(filled.event["dropped"], json!([]));
        assert_eq!(
            filled.event["named"],
            json!([["partner", [["CN_X_HK", "CN"]]]])
        );
        let japan = [Place::Country("JP".into()), Place::Country("US".into())];
        let both = fill(
            &draft_of(&japan),
            1,
            &picks(&[("t1.years", 1)]),
            &japan,
            2026,
        )
        .unwrap();
        assert_eq!(filter(&both, "partner").unwrap(), ["JP", "US"]);
    }

    fn draft_of(places: &[Place]) -> Draft {
        draft(eu_trade(), &[], places)
    }

    /// The EU named as a place of its own (the World Bank's EUU, l5geo PEER_AGGREGATES_ZH) is Eurostat's EU27_2020 beside
    /// the countries named with it, and a table that lacks it drops it, as any named place it does not hold.
    #[test]
    fn the_eu_named_as_a_place_is_fetched_by_its_eurostat_code() {
        let eu_us = [Place::Country("EUU".into()), Place::Country("US".into())];
        let table = eurostat("rd_e_gerdtot", vec![dim("geo", &["EU27_2020", "DE", "US", "CN"])]);
        let filled = fill(&draft(table, &[], &eu_us), 1, &picks(&[("t1.years", 1)]), &eu_us, 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["EU27_2020", "US"]);
        assert_eq!(filled.event["dropped"], json!([]));
        let without = eurostat("rd_e_gerdtot", vec![dim("geo", &["DE", "US"])]);
        let filled = fill(&draft(without, &[], &eu_us), 1, &picks(&[("t1.years", 1)]), &eu_us, 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["US"]);
        assert_eq!(filled.event["dropped"], json!(["EU27_2020"]));
    }

    #[test]
    fn a_named_country_two_dimensions_list_is_not_fixed_in_either() {
        let mut table = eurostat(
            "avia_x",
            vec![
                dim("geo", &["DE", "FR"]),
                dim("c_orig", &["TOTAL", "CN", "US"]),
                dim("c_dest", &["TOTAL", "CN", "US"]),
            ],
        );
        let listed: Vec<(String, String)> = [("CN", "CN"), ("US", "US")]
            .iter()
            .map(|(c, i)| (c.to_string(), i.to_string()))
            .collect();
        table.place_members = vec![("c_orig".into(), listed.clone()), ("c_dest".into(), listed)];
        let cn = [Place::Country("CN".into())];
        let d = draft(table.clone(), &[], &cn);
        assert!(d.named.is_empty(), "from or to China is not fixed");
        assert_eq!(
            d.ambiguous,
            [(
                "CN".to_string(),
                vec!["c_orig".to_string(), "c_dest".to_string()]
            )]
        );
        let err = fill(&d, 1, &picks(&[("t1.years", 1)]), &cn, 2026).unwrap_err();
        assert_eq!(
            err,
            "avia_x holds none of the places the question names; CN is listed in c_orig and c_dest, and which one the \
             question means is not fixed (for example c_orig=CN)"
        );
        let de_cn = [Place::Country("DE".into()), Place::Country("CN".into())];
        let filled = fill(
            &draft(table, &[], &de_cn),
            1,
            &picks(&[("t1.years", 1)]),
            &de_cn,
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["DE"]);
        assert_eq!(filter(&filled, "c_orig").unwrap(), ["TOTAL"]);
        assert_eq!(filter(&filled, "c_dest").unwrap(), ["TOTAL"]);
        assert_eq!(filled.event["dropped"], json!(["CN"]));
        assert_eq!(
            filled.event["ambiguous"],
            json!([["CN", ["c_orig", "c_dest"]]])
        );
        assert!(filled.event.get("named").is_none());
        // no geo (env_ac_co2fp): China in c_orig and c_dest is fixed nowhere, so the table holds none of the places
        let mut no_geo = eurostat(
            "env_ac_co2fp",
            vec![
                dim("c_orig", &["EU27_2020", "CN", "US"]),
                dim("c_dest", &["EU27_2020", "CN", "US"]),
            ],
        );
        no_geo.place_members = vec![
            ("c_orig".into(), vec![("CN".into(), "CN".into())]),
            ("c_dest".into(), vec![("CN".into(), "CN".into())]),
        ];
        let region_cn = [Place::Region, Place::Country("CN".into())];
        let err = fill(
            &draft(no_geo, &[], &region_cn),
            1,
            &picks(&[("t1.years", 1)]),
            &region_cn,
            2026,
        )
        .unwrap_err();
        assert!(
            err.starts_with("env_ac_co2fp holds none of the places the question names; CN is listed in c_orig and c_dest"),
            "{err}"
        );
    }

    #[test]
    fn geo_is_searched_first_and_a_country_no_dimension_lists_is_still_refused() {
        let mut table = eurostat(
            "migr_asyappctza",
            vec![
                dim("geo", &["EU27_2020", "DE", "FR"]),
                dim("unit", &["PER"]),
                dim("citizen", &["TOTAL", "DE", "SY", "AF"]),
            ],
        );
        table.place_members = vec![(
            "citizen".into(),
            [("DE", "DE"), ("SY", "SY"), ("AF", "AF")]
                .iter()
                .map(|(c, i)| (c.to_string(), i.to_string()))
                .collect(),
        )];
        let de = [Place::Country("DE".into())];
        let d = draft(table.clone(), &[], &de);
        assert!(d.named.is_empty());
        let filled = fill(&d, 1, &picks(&[("t1.years", 1)]), &de, 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["DE"]);
        assert_eq!(filter(&filled, "citizen").unwrap(), ["TOTAL"]);
        assert!(filled.event.get("named").is_none());
        let sy = [Place::Country("SY".into())];
        let filled = fill(
            &draft(table.clone(), &[], &sy),
            1,
            &picks(&[("t1.years", 1)]),
            &sy,
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "citizen").unwrap(), ["SY"]);
        assert_eq!(
            filled.event["open"], "geo",
            "no place left for geo: every geo code is fetched"
        );
        let br = [Place::Country("BR".into())];
        let err = fill(
            &draft(table, &[], &br),
            1,
            &picks(&[("t1.years", 1)]),
            &br,
            2026,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "migr_asyappctza holds none of the places the question names"
        );
        let none = fill(&draft_of(&br), 1, &picks(&[("t1.years", 1)]), &br, 2026).unwrap_err();
        assert_eq!(
            none,
            "ext_st_eu27_2020sitc holds none of the places the question names"
        );
    }

    #[test]
    fn a_place_breakdown_takes_the_eu_aggregate_and_totals_elsewhere() {
        let mut citizen = vec!["TOTAL", "EU27_2020"];
        citizen.extend(["AF", "SY", "VE", "TR", "CO", "UA", "BD", "PK"]);
        let table = eurostat(
            "migr_asyappctza",
            vec![
                dim("applicant", &["TOTAL", "FRST", "SSEQ"]),
                dim("age", &["TOTAL", "Y_LT14"]),
                dim("sex", &["T", "M", "F"]),
                dim("geo", &["EU27_2020", "DE", "FR"]),
                dim("unit", &["PER"]),
                dim("citizen", &citizen),
            ],
        );
        let draft = draft(table, &[], &[]);
        assert!(draft.members.is_empty(), "{:?}", draft.members);
        let k = draft.breakdown.iter().position(|d| d == "citizen").unwrap() + 2;
        let filled = fill(
            &draft,
            1,
            &picks(&[("t1.breakdown", k), ("t1.years", 1)]),
            &[Place::Region],
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["EU27_2020"]);
        assert_eq!(filter(&filled, "citizen"), None);
        assert_eq!(filter(&filled, "applicant").unwrap(), ["TOTAL"]);
        assert_eq!(filter(&filled, "sex").unwrap(), ["T"]);
        assert_eq!(filter(&filled, "freq").unwrap(), ["A"]);
        assert_eq!(filled.args["years"], json!({"start": 2024, "end": 2024}));
        assert_eq!(filled.event["open"], "citizen");
    }

    #[test]
    fn a_hub_table_with_a_window_asks_no_years_and_is_fetched_for_the_ring_s_years() {
        let table = eurostat(
            "migr_asyappctza",
            vec![
                dim("sex", &["T", "M", "F"]),
                dim("geo", &["EU27_2020", "DE", "FR"]),
                dim("unit", &["PER"]),
                dim("citizen", &["TOTAL", "AF", "SY", "VE", "TR", "CO", "UA", "BD", "PK"]),
            ],
        );
        let plain = draft(table, &[], &[]);
        let k = plain.breakdown.iter().position(|d| d == "citizen").unwrap() + 2;
        let fill_k = |d: &Draft, extra: &[(&str, usize)]| {
            let mut p = picks(&[("t1.breakdown", k)]);
            p.extend(picks(extra));
            fill(d, 1, &p, &[Place::Region], 2026).unwrap()
        };
        // No window: an annual table asks no years item; it takes the last ten, and the event says by which rule.
        assert!(items(1, &plain).iter().all(|(key, _)| key != "t1.years"), "{:?}", items(1, &plain));
        let today = fill_k(&plain, &[]);
        assert_eq!(today.args["years"], json!({"start": 2015, "end": 2024}));
        assert_eq!((&today.event["years"]["option"], &today.event["years"]["rule"]), (&json!(ANNUAL_YEARS), &json!("annual")));
        // A window on every answer: no years item; the fetch takes ring.years ending at the last year, and the event says
        // where from.
        let window = Window { years: 5, months: 60, hub: "EU27_2020".into(), twin: "migr_asyappctzm".into(), only: None };
        let windowed = Draft { window: Some(window.clone()), ..plain.clone() };
        assert!(items(1, &windowed).iter().all(|(key, _)| key != "t1.years"), "{:?}", items(1, &windowed));
        let filled = fill_k(&windowed, &[]);
        assert_eq!(filled.args["years"], json!({"start": 2020, "end": 2024}));
        assert_eq!(
            filled.event["years"]["window"],
            json!({"years": 5, "months": 60, "hub": "EU27_2020", "twin": "migr_asyappctzm", "only": null, "source": WINDOW_SOURCE})
        );
        assert!(filled.event["years"].get("option").is_none());
        assert_eq!(filled.event["years"]["rule"], "window");
        // Its filters are the plain draft's: only the years differ.
        assert_eq!(filled.args["filters"], today.args["filters"]);
        // A window on the citizen split only: still no years item; the split takes the window, the other answers the
        // program's years (a years option the program gives, as for a split that draws only with the latest year, holds).
        let split = Draft { window: Some(Window { only: Some(vec!["citizen".into()]), ..window }), ..plain.clone() };
        assert!(items(1, &split).iter().all(|(key, _)| key != "t1.years"));
        assert_eq!(fill_k(&split, &[]).args["years"], json!({"start": 2020, "end": 2024}));
        let none = fill(&split, 1, &picks(&[("t1.breakdown", 1)]), &[Place::Region], 2026).unwrap();
        assert_eq!(none.args["years"], json!({"start": 2015, "end": 2024}));
        let given = fill(&split, 1, &picks(&[("t1.breakdown", 1), ("t1.years", 1)]), &[Place::Region], 2026).unwrap();
        assert_eq!(given.args["years"], json!({"start": 2024, "end": 2024}));
        assert_eq!((&given.event["years"]["option"], &given.event["years"]["rule"]), (&json!(1), &json!("split")));
        // Years the question names win over the ten, kept to the table's last year, and the event names them.
        let named = |n: NamedYears| fill(&Draft { named_years: Some(n), ..plain.clone() }, 1, &picks(&[("t1.breakdown", 1)]), &[Place::Region], 2026).unwrap();
        let span = named(NamedYears::Span(2018, 2026));
        assert_eq!(span.args["years"], json!({"start": 2018, "end": 2024}));
        assert_eq!((&span.event["years"]["rule"], &span.event["years"]["named"]), (&json!("question"), &json!({"from": 2018, "to": 2026})));
        assert_eq!(named(NamedYears::Span(2021, 2021)).args["years"], json!({"start": 2021, "end": 2021}));
        assert_eq!(named(NamedYears::Last(5)).args["years"], json!({"start": 2020, "end": 2024}));
        // A window still wins over the question's years.
        let ring = fill_k(&Draft { named_years: Some(NamedYears::Span(2010, 2011)), ..windowed.clone() }, &[]);
        assert_eq!(ring.args["years"], json!({"start": 2020, "end": 2024}));
    }

    #[test]
    fn the_years_a_question_names_are_read_by_rule() {
        let q = |s: &str| question_years(s, 2026);
        assert_eq!(q("2015 年到 2024 年欧盟各国可再生能源占比"), Some(NamedYears::Span(2015, 2024)));
        assert_eq!(q("2024年欧盟各国失业率"), Some(NamedYears::Span(2024, 2024)));
        assert_eq!(q("2015 年以来欧盟各国可再生能源占比"), Some(NamedYears::Span(2015, 2026)));
        assert_eq!(q("近五年欧盟各国失业率怎么变"), Some(NamedYears::Last(5)));
        assert_eq!(q("过去 10 年各国人均碳排放"), Some(NamedYears::Last(10)));
        assert_eq!(q("最近十二年"), Some(NamedYears::Last(12)));
        assert_eq!(q("近二十年"), Some(NamedYears::Last(20)));
        // one year counted back is the latest year, the program's own when none is named (n14, n34: Last(1) fetched 2025
        // alone, a year a sparse table holds for none of the asked places)
        assert_eq!(q("南非、巴西、哥伦比亚、墨西哥最近一年的基尼系数，谁的收入最不平等？"), None);
        assert_eq!(q("日本、意大利、希腊、新加坡、美国最近一年的中央政府债务占 GDP，谁最高？"), None);
        assert_eq!(q("近一年各国通胀"), None);
        // one year asked about inside the last n years the question counts back: the span (e9 fetched 2015 alone); a year
        // before the span, or a year run on from, stays the question's years
        assert_eq!(
            q("印尼、菲律宾、泰国、越南近二十年的谷物单产怎么变？2015 年厄尔尼诺那一年有没有往下掉？"),
            Some(NamedYears::Last(20))
        );
        assert_eq!(q("近五年各国失业率，和 2000 年比呢"), Some(NamedYears::Span(2000, 2000)));
        assert_eq!(q("2015 年以来近十年各国失业率"), Some(NamedYears::Span(2015, 2026)));
        assert_eq!(q("2015 年到 2024 年，近十年各国失业率"), Some(NamedYears::Span(2015, 2024)));
        // a count of years run back over with no word before it, or after 这 (11-05: a question asking five years was fetched
        // and printed over the table's whole ten)
        assert_eq!(q("五年来欧盟各国房价涨了多少"), Some(NamedYears::Last(5)));
        assert_eq!(q("各国房价 3 年以来的变化"), Some(NamedYears::Last(3)));
        assert_eq!(q("这十年各国失业率"), Some(NamedYears::Last(10)));
        assert_eq!(q("这两年来的通胀"), Some(NamedYears::Last(2)));
        // no count before it: none
        assert_eq!(q("近年来欧盟各国失业率"), None);
        assert_eq!(q("多年来各国人口"), None);
        assert_eq!(q("十多年来各国人口"), None);
        // no year: a count that is no year, a four-digit number off the years, a time word without a count
        assert_eq!(q("欧盟各国可再生能源占比"), None);
        assert_eq!(q("人口超过 1000 万的国家"), None);
        assert_eq!(q("5000 人以上"), None);
        assert_eq!(q("最近欧盟各国失业率"), None);
        assert_eq!(q("12345 年"), None);
        // a four-digit number is a year only before 年 or in a range of years
        assert_eq!(q("人均 GDP 超过 2000 美元的国家"), None);
        assert_eq!(q("人口 2000 万以上的国家"), None);
        assert_eq!(q("月薪低于 1990 欧元"), None);
        assert_eq!(q("2015-2024 年各国失业率"), Some(NamedYears::Span(2015, 2024)));
        assert_eq!(q("2015至2024年"), Some(NamedYears::Span(2015, 2024)));
        assert_eq!(q("人口超过 2000 万的国家 2020 年的失业率"), Some(NamedYears::Span(2020, 2020)));
        // a year later than this one is kept (the fill keeps the fetch to the table's last year)
        assert_eq!(q("2020 年到 2030 年欧盟可再生能源"), Some(NamedYears::Span(2020, 2030)));
        // one year compared with runs to this year, as one run on from
        assert_eq!(q("欧盟各国碳排放比 1990 年下降多少"), Some(NamedYears::Span(1990, 2026)));
        assert_eq!(q("与 2015 年相比各国失业率"), Some(NamedYears::Span(2015, 2026)));
        assert_eq!(q("失业率较2015年上升的国家"), Some(NamedYears::Span(2015, 2026)));
        assert_eq!(q("2015 年起"), Some(NamedYears::Span(2015, 2026)));
        // a share (比重, 比例) is no comparison with the year
        assert_eq!(q("2020 年可再生能源比重"), Some(NamedYears::Span(2020, 2020)));
    }

    #[test]
    fn a_question_asking_for_months_is_read_by_rule() {
        for s in [
            "2026 年 3 月欧盟庇护申请的来源国",
            "2025年十月欧盟各国失业率",
            "12 月德国发电结构",
            "最近几个月欧盟庇护申请",
            "近三个月各国天然气进口",
            "过去 6 个月的通胀",
            "今年每月的庇护申请",
            "欧盟庇护申请逐月变化",
            "上个月欧盟各国失业率",
            "庇护申请的月度数据",
            // a part of a year: a quarter, a half, the year so far
            "2026 年一季度欧盟庇护申请的来源国",
            "第三季度德国发电结构",
            "2025 年前三季度各国天然气进口",
            "按季度的通胀",
            "2026 年上半年欧盟庇护申请",
            "下半年各国失业率",
            "近半年的天然气进口",
            "今年以来欧盟庇护申请",
            "年初至今的通胀",
            "2025 Q1 欧盟庇护申请",
            "2025Q4德国发电结构",
            "q2 各国失业率",
        ] {
            assert!(question_months(s), "{s}");
        }
        // years alone, a count of years, a 月 after no month number, a number off the months, a Q after a letter or
        // off the quarters, 半 or 季 in another word
        for s in [
            "2024 年欧盟庇护申请的来源国",
            "2015 年到 2024 年欧盟庇护申请",
            "近五年欧盟各国失业率怎么变",
            "欧盟庇护申请的来源国",
            "月薪低于 1990 欧元",
            "13 月",
            "岁月",
            "SQ1 型号的销量",
            "Q5 各国失业率",
            "Q12 各国失业率",
            "欧盟半导体出口",
            "两年半以来的通胀",
            "季节性流感病例",
        ] {
            assert!(!question_months(s), "{s}");
        }
    }

    #[test]
    fn the_latest_year_a_question_names_is_the_end_of_its_years() {
        let q = |s: &str| question_latest_year(s, 2026);
        assert_eq!(q("2026 年欧盟庇护申请的来源国"), Some(2026));
        assert_eq!(q("2024 年欧盟庇护申请的来源国"), Some(2024));
        assert_eq!(q("2015 年到 2024 年欧盟庇护申请"), Some(2024));
        // one year run on from runs to this year
        assert_eq!(q("2015 年以来欧盟庇护申请"), Some(2026));
        // the last n years are counted back from the table's last year, and no year named is none
        assert_eq!(q("近五年欧盟各国失业率"), None);
        assert_eq!(q("欧盟庇护申请的来源国"), None);
    }

    #[test]
    fn a_monthly_table_is_fetched_monthly_and_says_so_before_the_pick() {
        // nrg_cb_pem's metabase time codes are months only: the fetch asks freq M (A gave HTTP 400), and the years item
        // says the table is monthly with its span. A table with A among its freqs keeps A and its lines unchanged.
        let span = |f: &str, a: &str, b: &str| (f.to_string(), a.to_string(), b.to_string());
        let mut table = eurostat(
            "nrg_cb_pem",
            vec![
                dim("siec", &["TOTAL", "C0000"]),
                dim("unit", &["GWH"]),
                dim("geo", &["DE", "FR"]),
            ],
        );
        table.freqs = vec![span("M", "2008M01", "2026M08")];
        let draft = draft(table.clone(), &[], &[]);
        let filled = fill(&draft, 1, &picks(&[("t1.years", 1)]), &[], 2026).unwrap();
        assert_eq!(filter(&filled, "freq").unwrap(), ["M"]);
        let items = items(1, &draft);
        assert_eq!(
            lines(1, &draft, &items)[0],
            "   t1.years (the table is monthly only, 2008M01 to 2026M08):"
        );
        table.freqs = vec![span("A", "2008", "2025"), span("M", "2008M01", "2026M08")];
        let draft = super::draft(table.clone(), &[], &[]);
        let filled = fill(&draft, 1, &picks(&[("t1.years", 1)]), &[], 2026).unwrap();
        assert_eq!(filter(&filled, "freq").unwrap(), ["A"]);
        assert_eq!(lines(1, &draft, &items)[0], "   t1.years:");
        // Two freqs and no A: there is no one freq to ask, so the fill stops and names them instead of guessing.
        table.freqs = vec![
            span("Q", "2008Q1", "2026Q2"),
            span("M", "2008M01", "2026M08"),
        ];
        let draft = super::draft(table, &[], &[]);
        let why = fill(&draft, 1, &picks(&[("t1.years", 1)]), &[], 2026).unwrap_err();
        assert!(why.contains("the freqs Q, M and no annual one"), "{why}");
    }

    #[test]
    fn a_registered_flow_table_asked_its_latest_year_is_fetched_from_the_year_before_and_summed() {
        // nrg_cb_pem (q3) and nrg_cb_gasm (outside the bank, the same family), monthly: the latest year is summed from 12 months, so
        // the fetch starts a year before the end and carries the registry's n and share; a quarterly one sums 4.
        let span = |f: &str, a: &str, b: &str| vec![(f.to_string(), a.to_string(), b.to_string())];
        let table = |id: &str, freqs| {
            let mut t = eurostat(id, vec![dim("unit", &["GWH"]), dim("geo", &["DE", "FR"])]);
            t.freqs = freqs;
            t
        };
        let years = |t: &TableMeta, option: usize| {
            let filled = fill(
                &draft(t.clone(), &[], &[]),
                1,
                &picks(&[("t1.years", option)]),
                &[],
                2026,
            )
            .unwrap();
            (
                filled.args["years"].clone(),
                filled.args.get("sum_year").cloned(),
            )
        };
        for id in ["nrg_cb_pem", "nrg_cb_gasm"] {
            assert_eq!(
                years(&table(id, span("M", "2008M01", "2024M08")), 1),
                (
                    json!({"start": 2023, "end": 2024}),
                    Some(json!({"n": 12, "share": 0.8}))
                ),
                "{id}"
            );
        }
        assert_eq!(
            years(&table("nrg_cb_pem", span("Q", "2008Q1", "2024Q2")), 1).1,
            Some(json!({"n": 4, "share": 0.8}))
        );
        // The last ten years, an annual flow table, a stock table and a monthly table outside the family: no sum, years as before.
        let pem = table("nrg_cb_pem", span("M", "2008M01", "2024M08"));
        assert_eq!(years(&pem, 2), (json!({"start": 2015, "end": 2024}), None));
        for t in [
            table("nrg_cb_e", span("A", "1990", "2024")),
            table("nrg_stk_oilm", span("M", "2008M01", "2024M08")),
            table("ei_isen_m", span("M", "2000M01", "2024M08")),
        ] {
            assert_eq!(
                years(&t, 1),
                (json!({"start": 2024, "end": 2024}), None),
                "{}",
                t.id
            );
        }
    }

    #[test]
    fn a_summed_table_over_the_row_limit_keeps_the_whole_year_before_not_the_latest_months() {
        // Two years of 30 000 places is over 50 000 rows: a summed table is cut to the year before alone (start = end = latest - 1),
        // still summed; the latest year's months alone would sum to no full year. A table outside the family asks its latest year alone, as before.
        let places: Vec<String> = (0..30_000).map(|i| format!("X{i:05}")).collect();
        let places: Vec<&str> = places.iter().map(String::as_str).collect();
        let table = |id: &str, freq: &str, last: &str| {
            let mut t = eurostat(id, vec![dim("unit", &["GWH"]), dim("geo", &places)]);
            t.freqs = vec![(
                freq.to_string(),
                format!("2008{}", &last[4..]),
                last.to_string(),
            )];
            t
        };
        let fill1 = |t: TableMeta| {
            fill(
                &draft(t, &[], &[]),
                1,
                &picks(&[("t1.years", 1)]),
                &[],
                2026,
            )
            .unwrap()
        };
        let filled = fill1(table("nrg_cb_pem", "M", "2024M08"));
        assert_eq!(
            filled.args["years"],
            json!({"start": 2023, "end": 2023}),
            "{}",
            filled.event
        );
        assert_eq!(filled.args["sum_year"], json!({"n": 12, "share": 0.8}));
        assert_eq!(
            filled.event["years_cut"]["to"],
            json!({"start": 2023, "end": 2023})
        );
        assert_eq!(
            filled.event["years_cut"]["from"],
            json!({"start": 2023, "end": 2024})
        );
        let filled = fill1(table("nrg_stk_oilm", "M", "2024M08"));
        assert_eq!(
            filled.args["years"],
            json!({"start": 2024, "end": 2024}),
            "{}",
            filled.event
        );
        assert!(filled.args.get("sum_year").is_none());
    }

    #[test]
    fn an_open_place_dimension_over_the_chart_rows_is_narrowed_to_its_top_codes() {
        let letters: Vec<String> = (b'A'..=b'Z')
            .flat_map(|a| (b'A'..=b'D').map(move |b| format!("{}{}", a as char, b as char)))
            .collect();
        let mut citizen: Vec<&str> = vec!["TOTAL", "EU27_2020", "EXT_EU27_2020", "UNK", "STLS"];
        citizen.extend(letters.iter().map(String::as_str));
        let table = |citizen: &[&str]| {
            eurostat(
                "migr_asyappctza",
                vec![
                    dim("sex", &["T", "M"]),
                    dim("geo", &["EU27_2020", "DE"]),
                    dim("unit", &["PER"]),
                    dim("citizen", citizen),
                ],
            )
        };
        let one = |citizen: &[&str], years: usize| {
            let draft = draft(table(citizen), &[], &[]);
            let k = draft.breakdown.iter().position(|d| d == "citizen").unwrap() + 2;
            fill(
                &draft,
                1,
                &picks(&[("t1.breakdown", k), ("t1.years", years)]),
                &[Place::Region],
                2026,
            )
            .unwrap()
        };
        let filled = one(&citizen, 1);
        assert_eq!(
            filled.args["narrow"],
            json!({"dimension": "citizen", "rule": "top", "n": 20,
            "exclude": ["EU27_2020", "EXT_EU27_2020", "UNK", "STLS"], "total": "TOTAL"})
        );
        assert_eq!(filled.event["narrow"]["from_codes"], 109);
        assert_eq!(filled.event["narrow"]["chart_rows"], 80);
        assert_eq!(filter(&filled, "geo").unwrap(), ["EU27_2020"]);
        assert_eq!(
            one(&citizen, 2).args["narrow"]["n"],
            8,
            "ten years: at most 80 rows over the years"
        );
        assert!(
            !one(&citizen[..80], 1).args.contains_key("narrow"),
            "80 codes fit a chart"
        );
        assert!(one(&citizen, 1).event["narrow"]["exclude"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c != "TOTAL"));
        let flat: Vec<String> = (0..100).map(|i| format!("C{i:03}")).collect();
        let flat: Vec<&str> = flat.iter().map(String::as_str).collect();
        assert!(
            !one(&flat, 1).args.contains_key("narrow"),
            "a dimension that is not of places is left as asked"
        );
    }

    #[test]
    fn the_eu_named_gives_its_members_and_a_measure_with_no_total_is_asked() {
        let table = eurostat(
            "nrg_ind_ren",
            vec![
                dim("nrg_bal", &["REN", "REN_TRA", "REN_ELC"]),
                dim("geo", &["EU27_2020", "BE", "DE", "EL", "NO"]),
                dim("unit", &["PC"]),
            ],
        );
        let draft = draft(table, &[], &[]);
        let items = items(1, &draft);
        let keys: Vec<&str> = items.iter().map(|(k, _)| k.as_str()).collect();
        // an annual table: its years are the program's, never an item
        assert_eq!(keys, ["t1.breakdown", "t1.nrg_bal"]);
        let listed = lines(1, &draft, &items);
        assert_eq!(
            listed[1],
            "     1. none: one number per place, each item below keeps the one code picked"
        );
        assert_eq!(listed[2], "     2. split by nrg_bal: each place × all 3 nrg_bal codes (e.g. label REN; label REN_TRA; label REN_ELC); leave out t1.nrg_bal");
        assert_eq!(
            listed[3],
            "   t1.nrg_bal (only when t1.breakdown is not nrg_bal):"
        );
        let filled = fill(
            &draft,
            1,
            &picks(&[("t1.breakdown", 1), ("t1.nrg_bal", 3)]),
            &[Place::Region],
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["BE", "DE", "EL"]);
        assert_eq!(filled.event["places"], json!(["region"]));
        assert_eq!(filled.event["dropped"].as_array().unwrap().len(), 24);
        assert_eq!(filter(&filled, "nrg_bal").unwrap(), ["REN_ELC"]);
        assert_eq!(filled.args["years"], json!({"start": 2015, "end": 2024}));
        assert_eq!((&filled.event["years"]["rule"], &filled.event["years"]["option"]), (&json!("annual"), &json!(ANNUAL_YEARS)));
        assert_eq!(filled.event["open"], Value::Null);
    }

    #[test]
    fn the_predicted_shape_is_what_the_fetch_would_vary_over() {
        let table = eurostat(
            "nrg_ind_ren",
            vec![
                dim("nrg_bal", &["REN", "REN_TRA", "REN_ELC"]),
                dim("geo", &["EU27_2020", "BE", "DE", "EL", "NO"]),
                dim("unit", &["PC"]),
            ],
        );
        let d = draft(table, &[], &[]);
        let of = |p: &[(&str, usize)], places: &[Place]| -> Vec<(String, usize, bool)> {
            predicted_shape(&d, 1, &picks(p), places, 2026, &|_| None)
                .unwrap()
                .dims
                .iter()
                .map(|v| (v.dim.clone(), v.members, v.is_place))
                .collect()
        };
        let (geo, nrg_bal, time) = (
            |m| ("geo".to_string(), m, true),
            |m| ("nrg_bal".to_string(), m, false),
            |m| ("time".to_string(), m, false),
        );
        assert_eq!(
            of(&[("t1.years", 1), ("t1.breakdown", 1)], &[Place::Region]),
            [geo(3)]
        );
        assert_eq!(
            of(&[("t1.years", 1), ("t1.breakdown", 2)], &[Place::Region]),
            [geo(3), nrg_bal(3)]
        );
        assert_eq!(
            of(
                &[("t1.years", 2), ("t1.breakdown", 2)],
                &[Place::Country("DE".into())]
            ),
            [nrg_bal(3), time(10)]
        );
    }

    #[test]
    fn a_category_with_its_total_and_three_parts_in_an_additive_unit_is_predicted_additive() {
        // q3's shape (nrg_cb_pem): split by siec, the latest year summed from its months.
        let table = |siec: &[&str]| {
            let mut t = eurostat(
                "nrg_cb_pem",
                vec![
                    dim("geo", &["DE", "FR", "EU27_2020"]),
                    dim("siec", siec),
                    dim("unit", &["GWH", "PC"]),
                ],
            );
            t.freqs = vec![("M".into(), "2008M01".into(), "2026M08".into())];
            t
        };
        let additive = |c: &str| Some(c == "GWH");
        let shape = |siec: &[&str], unit: &str| {
            let d = draft(table(siec), &[], &[Place::Region]);
            let unit = d
                .members
                .iter()
                .find(|(m, _, _)| m == "unit")
                .unwrap()
                .1
                .iter()
                .position(|(c, _)| c == unit)
                .unwrap()
                + 1;
            let picks = picks(&[("t1.years", 1), ("t1.breakdown", 2), ("t1.unit", unit)]);
            assert!(fill(&d, 1, &picks, &[Place::Region], 2026)
                .unwrap()
                .args
                .contains_key("sum_year"));
            predicted_shape(&d, 1, &picks, &[Place::Region], 2026, &additive).unwrap()
        };
        let siec = |s: &Shape| s.dims.iter().find(|v| v.dim == "siec").cloned().unwrap();
        let parts = ["TOTAL", "C0000", "N9000", "RA300", "RA100"];
        let s = shape(&parts, "GWH");
        // A summed fetch is one year: no time dimension.
        assert!(s.dims.iter().all(|v| v.dim != "time"), "{:?}", s.dims);
        assert_eq!(siec(&s).roles, [Role::AdditiveCategory, Role::Category]);
        assert_eq!(siec(&s).total_member.as_deref(), Some("TOTAL"));
        // The map gate reads the table's unit after the fetch; the prediction does not claim it.
        assert!(!s.unit_additive);
        // A share unit, no total code, or fewer than three other codes: a plain category.
        for (codes, unit) in [
            (&parts[..], "PC"),
            (&parts[1..], "GWH"),
            (&parts[..3], "GWH"),
        ] {
            let v = siec(&shape(codes, unit));
            assert_eq!(v.roles, [Role::Category], "{codes:?} {unit}");
            assert_eq!(v.total_member, None, "{codes:?} {unit}");
        }
    }

    #[test]
    fn a_named_country_is_asked_by_its_eurostat_code_and_a_missing_place_stops() {
        let table = eurostat("t", vec![dim("geo", &["EL", "DE"]), dim("unit", &["PC"])]);
        let d = draft(table, &[], &[]);
        let filled = fill(
            &d,
            1,
            &BTreeMap::new(),
            &[Place::Country("GR".into())],
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["EL"]);
        // a named place the table lacks is left out and kept in the event; the others are fetched
        let filled = fill(
            &d,
            1,
            &BTreeMap::new(),
            &[Place::Country("DE".into()), Place::Country("JP".into())],
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["DE"]);
        assert_eq!(filled.event["places"], json!(["DE", "JP"]));
        assert_eq!(filled.event["dropped"], json!(["JP"]));
        let err = fill(
            &d,
            1,
            &BTreeMap::new(),
            &[Place::Country("JP".into())],
            2026,
        )
        .unwrap_err();
        assert!(err.contains("none of the places"), "{err}");
    }

    #[test]
    fn options_are_at_most_eight_and_the_searched_words_come_first() {
        let codes: Vec<String> = (0..12).map(|i| format!("C{i}")).collect();
        let mut d = dim(
            "siec",
            &codes.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        d.1[10].1 = "Natural gas".into();
        let draft = draft(
            eurostat("t", vec![d, dim("geo", &["DE"])]),
            &["natural gas power".into()],
            &[],
        );
        let (_, offered, all) = &draft.members[0];
        assert_eq!((offered.len(), *all), (OPTIONS_MAX, 12));
        assert_eq!(offered[0].0, "C10");
        let filled = fill(&draft, 1, &BTreeMap::new(), &[], 2026).unwrap();
        assert_eq!(
            filled.event["options_cut"]["siec"],
            json!({"offered": 8, "codes": 12})
        );
    }

    #[test]
    fn a_total_label_is_offered_first_as_a_whole_and_a_memo_item_never() {
        let mut d = dim(
            "src_crf",
            &[
                "CRF1A",
                "TOTXMEMO",
                "CRF1D1",
                "TOTX4_MEMO",
                "CRF_MEMO",
                "CRF4",
            ],
        );
        for (i, label) in [
            (0, "Fuel combustion"),
            (1, "Total (excluding memo items)"),
            (2, "International bunkers (memo item)"),
            (3, "Total (excluding LULUCF and memo items)"),
            (4, "Memo items"),
            (5, "Land use, land use change, and forestry (LULUCF)"),
        ] {
            d.1[i].1 = label.into();
        }
        let draft = draft(
            eurostat("t", vec![d, dim("geo", &["DE"])]),
            &["fuel combustion".into()],
            &[],
        );
        let (_, offered, all) = &draft.members[0];
        let codes: Vec<&str> = offered.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(
            codes,
            ["TOTXMEMO", "TOTX4_MEMO", "CRF1A", "CRF4"],
            "the wholes first, then by search words, no memo item"
        );
        assert_eq!(*all, 6);
        assert!(
            !total_label("Totally renewable")
                && total_label("Total")
                && total_label("Total crop, including fruit")
        );
    }

    #[test]
    fn world_bank_with_no_place_leaves_the_countries_open_and_cuts_years_over_the_limit() {
        let places: Vec<(String, String)> = (0..2500)
            .map(|i| (format!("X{i}"), format!("X{i:04}")))
            .collect();
        let table = TableMeta {
            id: "EN.X@2".into(),
            worldbank: true,
            dims: Vec::new(),
            end_year: None,
            places,
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        let d = draft(table, &[], &[]);
        let filled = fill(&d, 1, &picks(&[("t1.years", 2)]), &[], 2026).unwrap();
        assert_eq!(filled.args["provider"], "worldbank");
        assert_eq!(filled.args["dataset"], "EN.X");
        assert!(filled.args.get("filters").is_none());
        // 2500 countries x 10 years is over 20 000 rows: the latest three years are asked instead.
        assert_eq!(filled.args["years"], json!({"start": 2023, "end": 2025}));
        assert_eq!(filled.event["years_cut"]["limit"], MAX_ROWS_WORLDBANK);
        assert_eq!(filled.event["open"], "country");
        assert_eq!(
            filled.args["narrow"],
            json!({"dimension": "country", "rule": "top", "n": 8, "exclude": []})
        );
    }

    fn world_bank(economies: usize) -> TableMeta {
        TableMeta {
            id: "SP.POP.65UP.TO.ZS@2".into(),
            worldbank: true,
            dims: Vec::new(),
            end_year: Some(2025),
            places: (0..economies)
                .map(|i| (format!("X{i}"), format!("X{i:02}")))
                .collect(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        }
    }

    #[test]
    fn the_rank_registry_parses_with_its_placeholders() {
        let (cap, options) = wb_rank_by();
        assert_eq!(*cap, 8);
        assert!(*cap * YEARS_SPAN as usize <= MAX_CHART_ROWS);
        let keys: Vec<&str> = options.iter().map(|o| o.key.as_str()).collect();
        assert_eq!(keys, ["top", "bottom", "SP.POP.TOTL", "NY.GDP.MKTP.CD"]);
        for o in options {
            assert!(["top", "bottom"].contains(&o.rule.as_str()), "{o:?}");
            assert!(
                o.by.is_none() || o.by.as_deref() == Some(o.key.as_str()),
                "{o:?}"
            );
            assert!(
                o.label.contains("{n}") && o.zh_scope.contains("{n}"),
                "{o:?}"
            );
            assert!(
                o.zh_line.contains("{n}") && o.zh_line.contains("{at}"),
                "{o:?}"
            );
            assert!(!o.zh_scope.chars().any(|c| c.is_ascii_digit()), "{o:?}");
            // A kicker and an eyebrow stand alone: no prefix comma.
            assert!(!o.zh_scope.ends_with(['，', ',']), "{o:?}");
            // Ranked by another indicator, the tool ranks only the economies with a value in both tables: the words say the
            // count is of economies with data, never "the n most populous" of all (round 8 n31). Ranked by the table's own
            // values, an economy without one cannot be highest or lowest.
            assert_eq!(o.by.is_some(), o.zh_scope.contains("有数据的{n}个"), "{o:?}");
            assert_eq!(o.by.is_some(), o.zh_line.contains("有数据的前 {n} 个"), "{o:?}");
        }
    }

    #[test]
    fn a_world_bank_table_with_every_country_open_asks_which_economies_to_keep() {
        let d = draft(world_bank(217), &[], &[]);
        assert!(d.places_open);
        let listed = items(1, &d);
        // a World Bank table is annual: no years item, the places item first
        assert_eq!(listed[0].0, "t1.places");
        assert_eq!(
            listed[0].1[2],
            "keep the 8 most populous economies (World Bank SP.POP.TOTL, the latest year both tables have)"
        );
        assert_eq!(listed[0].1.len(), wb_rank_by().1.len());
        let narrow = |k: usize| {
            fill(
                &d,
                1,
                &picks(&[("t1.years", 2), ("t1.places", k)]),
                &[],
                2026,
            )
            .unwrap()
            .args["narrow"]
                .clone()
        };
        assert_eq!(
            narrow(1),
            json!({"dimension": "country", "rule": "top", "n": 8, "exclude": []})
        );
        assert_eq!(
            narrow(2),
            json!({"dimension": "country", "rule": "bottom", "n": 8, "exclude": []})
        );
        assert_eq!(
            narrow(3),
            json!({"dimension": "country", "rule": "top", "by": "SP.POP.TOTL", "n": 8, "exclude": []})
        );
        assert_eq!(
            narrow(4),
            json!({"dimension": "country", "rule": "top", "by": "NY.GDP.MKTP.CD", "n": 8, "exclude": []})
        );
        // An option out of range is the first, as every other item.
        assert_eq!(narrow(9), narrow(1));
        let filled = fill(
            &d,
            1,
            &picks(&[("t1.years", 2), ("t1.places", 3)]),
            &[],
            2026,
        )
        .unwrap();
        assert_eq!(filled.event["narrow"]["option"], 3);
        assert_eq!(filled.event["narrow"]["key"], "SP.POP.TOTL");
        assert_eq!(filled.event["narrow"]["from_codes"], 217);
        let shape = predicted_shape(
            &d,
            1,
            &picks(&[("t1.years", 2), ("t1.places", 3)]),
            &[],
            2026,
            &|_| None,
        )
        .unwrap();
        assert_eq!(shape.dims[0].members, 8);
    }

    #[test]
    fn a_world_bank_table_with_named_places_or_few_economies_is_not_narrowed() {
        let few = draft(world_bank(80), &[], &[]);
        assert!(!few.places_open);
        assert!(items(1, &few).iter().all(|(k, _)| k != "t1.places"));
        assert!(!fill(&few, 1, &picks(&[("t1.years", 2)]), &[], 2026)
            .unwrap()
            .args
            .contains_key("narrow"));
        let japan = [Place::Country("X3".into())];
        let named = draft(world_bank(217), &[], &japan);
        assert!(!named.places_open);
        let filled = fill(
            &named,
            1,
            &picks(&[("t1.years", 2), ("t1.places", 3)]),
            &japan,
            2026,
        )
        .unwrap();
        assert!(!filled.args.contains_key("narrow"));
        assert_eq!(filter(&filled, "country").unwrap(), ["X03"]);
        let region = draft(world_bank(217), &[], &[Place::Region]);
        assert!(!region.places_open);
        // A Eurostat table is never this item's.
        assert!(!draft_of(&[]).places_open);
    }

    fn asked(by: &str, n: Option<usize>) -> Option<RankAsked> {
        Some(RankAsked { by: by.into(), n, phrase: "p".into() })
    }

    /// t2 and q4: a ranking the question asks for fixes the economies a table with every country open keeps. The option is
    /// the one ranked by the ranking's reference and the count is the question's, within the cap and the chart's rows; the
    /// economies are ranked by the tool from the reference's fetched rows (newsroom.ts prepareWorldBank), never listed here.
    /// "t<n>.places" is not asked, and a pick of it does not move the program's option. Two shapes: ten years (a time
    /// series, q4) and one named year (the latest year, t2).
    #[test]
    fn a_ranking_the_question_asks_for_fixes_the_kept_economies() {
        let ranked = |by: &str, n: Option<usize>, years: Option<NamedYears>| Draft {
            ranked: asked(by, n),
            named_years: years,
            ..draft(world_bank(217), &[], &[])
        };
        fn narrow(d: &Draft, p: &[(&str, usize)]) -> Filled {
            fill(d, 1, &picks(p), &[], 2026).unwrap()
        }
        for years in [None, Some(NamedYears::Span(2024, 2024))] {
            let five = ranked("SP.POP.TOTL", Some(5), years);
            assert!(items(1, &five).iter().all(|(k, _)| k != "t1.places"), "{years:?}");
            let filled = narrow(&five, &[]);
            assert_eq!(
                filled.args["narrow"],
                json!({"dimension": "country", "rule": "top", "by": "SP.POP.TOTL", "n": 5, "exclude": []}),
                "{years:?}"
            );
            assert_eq!(filled.event["narrow"]["from"], "question");
            assert_eq!(filled.event["narrow"]["option"], 3);
            assert_eq!(filled.event["narrow"]["asked"], json!({"phrase": "p", "by": "SP.POP.TOTL", "n": 5}));
            // a pick of the item the program fixed does not move it
            assert_eq!(narrow(&five, &[("t1.places", 1)]).args["narrow"], filled.args["narrow"]);
            // asked ten: the registry's cap keeps eight, the event keeps the ten asked
            let ten = narrow(&ranked("SP.POP.TOTL", Some(10), years), &[]);
            assert_eq!(ten.args["narrow"]["n"], 8);
            assert_eq!(ten.event["narrow"]["asked"]["n"], 10);
            // no count written (q4): the cap
            let some = narrow(&ranked("SP.POP.TOTL", None, years), &[]);
            assert_eq!(some.args["narrow"]["n"], 8);
            assert_eq!(some.event["narrow"]["asked"]["n"], Value::Null);
            // the second registered reference
            let gdp = narrow(&ranked("NY.GDP.MKTP.CD", Some(3), years), &[]);
            assert_eq!(
                gdp.args["narrow"],
                json!({"dimension": "country", "rule": "top", "by": "NY.GDP.MKTP.CD", "n": 3, "exclude": []})
            );
            let shape = predicted_shape(&five, 1, &picks(&[]), &[], 2026, &|_| None).unwrap();
            assert_eq!(shape.dims[0].members, 5);
        }
    }

    /// Must fail: a ranking by a reference wb-rank-by.json does not register is not the program's (the item is asked as
    /// before); a ranking on a table with few economies, or beside a region word, narrows nothing; with no ranking asked the
    /// pick is the model's and the event says so.
    #[test]
    fn a_ranking_the_registry_cannot_rank_by_is_not_used() {
        let unregistered = Draft {
            ranked: asked("XX.NOT.REGISTERED", Some(5)),
            ..draft(world_bank(217), &[], &[])
        };
        assert_eq!(ranked_option(&unregistered), None);
        assert!(items(1, &unregistered).iter().any(|(k, _)| k == "t1.places"));
        let filled = fill(&unregistered, 1, &picks(&[("t1.places", 2)]), &[], 2026).unwrap();
        assert_eq!(filled.args["narrow"]["rule"], "bottom");
        assert_eq!(filled.args["narrow"]["n"], 8);
        assert_eq!(filled.event["narrow"]["from"], "pick");
        assert_eq!(filled.event["narrow"]["asked"], Value::Null);
        let region = [Place::Region, Place::Country("X3".into())];
        let beside_region = Draft {
            ranked: asked("SP.POP.TOTL", Some(5)),
            ..draft(world_bank(217), &[], &region)
        };
        assert_eq!(ranked_option(&beside_region), None);
        let few = Draft {
            ranked: asked("SP.POP.TOTL", Some(5)),
            ..draft(world_bank(80), &[], &[])
        };
        assert_eq!(ranked_option(&few), None);
        assert!(!fill(&few, 1, &picks(&[]), &[], 2026).unwrap().args.contains_key("narrow"));
        let none = draft(world_bank(217), &[], &[]);
        assert_eq!(fill(&none, 1, &picks(&[("t1.places", 3)]), &[], 2026).unwrap().event["narrow"]["from"], "pick");
    }

    /// n45: a ranking the question asks for beside the countries it names ("the ten most populous countries, where does
    /// Nigeria rank") keeps the ranking's economies, as with no place named: the named country is the ranking's subject,
    /// drawn when the ranking holds it, not the one place fetched (one row, nothing to rank). Two shapes: one named country,
    /// and two; with no ranking asked the named ones fill the places as before.
    #[test]
    fn a_ranking_beside_named_countries_keeps_the_rankings_economies() {
        for named in [vec![Place::Country("X3".into())], vec![Place::Country("X3".into()), Place::Country("X4".into())]] {
            let d = Draft {
                ranked: asked("SP.POP.TOTL", Some(5)),
                ..draft(world_bank(217), &[], &named)
            };
            assert!(!d.places_open && d.named_open);
            assert_eq!(ranked_option(&d).map(|(i, _)| i), Some(3));
            assert!(items(1, &d).iter().all(|(k, _)| k != "t1.places"));
            let filled = fill(&d, 1, &picks(&[]), &named, 2026).unwrap();
            assert_eq!(
                filled.args["narrow"],
                json!({"dimension": "country", "rule": "top", "by": "SP.POP.TOTL", "n": 5, "exclude": []})
            );
            assert!(
                !filled.args.get("filters").and_then(Value::as_array).is_some_and(|f| f.iter().any(|f| f["dimension"] == "country")),
                "every country is fetched, the tool ranks"
            );
            assert_eq!(filled.event["narrow"]["from"], "question");
            let unranked = draft(world_bank(217), &[], &named);
            // a group (more than RANK_SUBJECTS_MAX places) is the set, drawn whole as before
            let group: Vec<Place> = (0..5).map(|i| Place::Country(format!("X{i}"))).collect();
            let g = Draft { ranked: asked("SP.POP.TOTL", Some(5)), ..draft(world_bank(217), &[], &group) };
            assert!(!g.named_open && ranked_option(&g).is_none());
            let filled = fill(&unranked, 1, &picks(&[]), &named, 2026).unwrap();
            assert!(!filled.args.contains_key("narrow"));
            assert_eq!(filter(&filled, "country").unwrap().len(), named.len());
        }
    }

    /// n51: a region word beside EU members only ("the EU countries' early-leaver rate, where does Italy rank") fills geo with
    /// the region's members, the named one among them, not the named one alone. Must fail: a named country outside the EU
    /// beside the region (the EU and China) keeps the named places as before; a member named alone stays alone.
    #[test]
    fn a_region_beside_its_named_members_fills_geo_with_the_region() {
        let mut geo: Vec<&str> = EU27.to_vec();
        geo.extend(["EU27_2020", "CN", "NO"]);
        let d = |places: &[Place]| draft(eurostat("edat_x", vec![dim("geo", &geo)]), &[], places);
        for places in [
            vec![Place::Region, Place::Country("IT".into())],
            vec![Place::Region, Place::Country("GR".into()), Place::Country("IT".into())],
        ] {
            let filled = fill(&d(&places), 1, &picks(&[]), &places, 2026).unwrap();
            assert_eq!(filter(&filled, "geo").unwrap(), EU27, "{places:?}");
        }
        let eu_cn = [Place::Region, Place::Country("CN".into())];
        assert_eq!(filter(&fill(&d(&eu_cn), 1, &picks(&[]), &eu_cn, 2026).unwrap(), "geo").unwrap(), ["CN"]);
        let italy = [Place::Country("IT".into())];
        assert_eq!(filter(&fill(&d(&italy), 1, &picks(&[]), &italy, 2026).unwrap(), "geo").unwrap(), ["IT"]);
    }

    /// The nrg_bal codes of nrg_bal_s the q2 stand-in run's probe found held for DE (the metabase's 95 but GIC2020-2030,
    /// PEC2020-2030 and FEC2020-2030).
    const Q2_NRG_BAL: &str = "PPRD RCV_RCY IMP EXP STK_CHG GAE INTMARB GIC INTAVI NRGSUP GIC_EED PEC_EED FEC_EED TI_E TI_EHG_E \
        TI_CO_E TI_BF_E TI_GW_E TI_RPI_E TI_PF_E TI_BKBPB_E TI_CL_E TI_BNG_E TI_LBB_E TI_CPP_E TI_GTL_E TI_NSP_E TO TO_EHG TO_CO \
        TO_BF TO_GW TO_RPI TO_PF TO_BKBPB TO_CL TO_BNG TO_LBB TO_CPP TO_GTL TO_NSP NRG_E NRG_EHG_E NRG_CM_E NRG_OIL_NG_E NRG_PF_E \
        NRG_CO_E NRG_BKBPB_E NRG_GW_E NRG_BF_E NRG_PR_E NRG_NI_E NRG_CL_E NRG_LNG_E NRG_BIOG_E NRG_GTL_E NRG_CPP_E NRG_NSP_E DL AFC \
        FC_NE FC_E FC_IND_E FC_IND_IS_E FC_IND_CPC_E FC_IND_NFM_E FC_IND_NMM_E FC_IND_TE_E FC_IND_MAC_E FC_IND_MQ_E FC_IND_FBT_E \
        FC_IND_PPP_E FC_IND_WP_E FC_IND_CON_E FC_IND_TL_E FC_IND_NSP_E FC_TRA_E FC_TRA_RAIL_E FC_TRA_ROAD_E FC_TRA_DAVI_E \
        FC_TRA_DNAVI_E FC_TRA_PIPE_E FC_TRA_NSP_E FC_OTH_E FC_OTH_CP_E FC_OTH_HH_E FC_OTH_AF_E FC_OTH_FISH_E FC_OTH_NSP_E STATDIFF \
        GEP GHP";
    const Q2_SIEC: [&str; 12] = [
        "TOTAL", "C0000X0350-0370", "C0350-0370", "P1000", "S2000", "G3000", "O4000XBIO", "RA000", "W6100_6220", "N900H",
        "E7000", "H8000",
    ];

    /// q2's table as the 10-31 stand-in run's table pick held it (nrg_bal_s, cut to three geo codes), under `id`.
    fn q2_table(id: &str) -> TableMeta {
        let nrg_bal: Vec<&str> = Q2_NRG_BAL.split_whitespace().collect();
        assert_eq!(nrg_bal.len(), 92);
        eurostat(
            id,
            vec![
                dim("geo", &["EU27_2020", "DE", "FR"]),
                dim("nrg_bal", &nrg_bal),
                dim("siec", &Q2_SIEC),
                dim("unit", &["KTOE", "GWH", "TJ"]),
            ],
        )
    }

    #[test]
    fn the_registered_parts_have_one_total_their_parents_and_add_up_on_the_fixture() {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for line in ESTAT_PARTS.lines().skip(1).filter(|l| !l.is_empty()) {
            let f: Vec<&str> = line.split('\t').collect();
            assert_eq!(f.len(), 12, "{line}");
            for table in f[0].split_whitespace() {
                let pair = (table.to_string(), f[1].to_string());
                if !pairs.contains(&pair) {
                    pairs.push(pair);
                }
            }
        }
        for table in ["nrg_bal_c", "nrg_bal_s"] {
            assert!(pairs.contains(&(table.into(), "siec".into())));
            assert!(pairs.contains(&(table.into(), "nrg_bal".into())));
        }
        assert!(pairs.contains(&("nrg_bal_peh".into(), "siec".into())));
        for (table, dim) in &pairs {
            let registered = parts(table, dim);
            let codes: Vec<&str> = registered.iter().map(|p| p.code.as_str()).collect();
            assert_eq!(
                registered.iter().filter(|p| p.level == PART_LEVELS[0]).count(),
                1,
                "{table} {dim}: one total"
            );
            for p in &registered {
                assert!(PART_LEVELS.contains(&p.level.as_str()), "{table} {dim} {}", p.code);
                assert_eq!(codes.iter().filter(|c| **c == p.code).count(), 1, "{table} {dim} {} once", p.code);
                match &p.parent {
                    None => assert_eq!(p.level, PART_LEVELS[0], "{table} {dim} {}: only the total has no parent", p.code),
                    Some(parent) => assert!(codes.contains(&parent.as_str()), "{table} {dim} {}: parent {parent}", p.code),
                }
            }
            // a subtotal that overlaps the tree is read apart: no part, no parent, no group, never a part's parent
            for o in overlaps(table, dim) {
                assert_eq!((o.parent.as_deref(), o.group.as_deref()), (None, None), "{table} {dim} {}", o.code);
                assert!(!codes.contains(&o.code.as_str()), "{table} {dim} {}: an overlap is no part", o.code);
            }
        }
        assert_eq!(parts("nrg_bal_peh", "siec").len(), 73);
        assert_eq!(overlaps("nrg_bal_peh", "siec").iter().map(|p| p.code.as_str()).collect::<Vec<_>>(), ["BIOE", "FE"]);
        assert!(overlaps("nrg_bal_s", "siec").is_empty());
        assert_eq!(parts("nrg_bal_s", "siec").len(), 12);
        assert_eq!(parts("nrg_bal_s", "nrg_bal").len(), 9);
        assert!(parts("nrg_bal_s", "unit").is_empty() && parts("nrg_x", "siec").is_empty());
        // one row registers the code for the family: nrg_bal_c has nrg_bal_s's parts, and no copy of them
        assert_eq!(parts("nrg_bal_c", "siec"), parts("nrg_bal_s", "siec"));
        assert_eq!(parts("nrg_bal_c", "nrg_bal"), parts("nrg_bal_s", "nrg_bal"));
        // On nrg_bal_s DE 2024 (KTOE): each fuel parent is the sum of its parts at FC_E, each sector parent at TOTAL; a code
        // the file has no row for is the sum of its own parts (FC_OTH_E), else nothing (N900H in final consumption).
        let fixture = include_str!("../scripts/fixtures/data_prepare/nrg_bal_s_DE_2024.tsv");
        let value: BTreeMap<(String, String), f64> = fixture
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                ((f[0].to_string(), f[1].to_string()), f[2].parse().unwrap())
            })
            .collect();
        for (dim, at) in [("siec", "FC_E"), ("nrg_bal", "TOTAL")] {
            let registered = parts("nrg_bal_s", dim);
            fn of(code: &str, registered: &[Part], read: &dyn Fn(&str) -> Option<f64>) -> f64 {
                read(code).unwrap_or_else(|| {
                    registered
                        .iter()
                        .filter(|p| p.parent.as_deref() == Some(code))
                        .map(|p| of(&p.code, registered, read))
                        .sum()
                })
            }
            let read = |code: &str| {
                if dim == "siec" {
                    value.get(&(at.to_string(), code.to_string())).copied()
                } else {
                    value.get(&(code.to_string(), at.to_string())).copied()
                }
            };
            for p in registered.iter().filter(|p| p.level != "leaf") {
                let Some(whole) = read(&p.code) else { continue };
                let sum: f64 = registered
                    .iter()
                    .filter(|c| c.parent.as_deref() == Some(p.code.as_str()))
                    .map(|c| of(&c.code, &registered, &read))
                    .sum();
                assert!((whole - sum).abs() < 0.005, "{dim} {}: {whole} vs parts {sum}", p.code);
            }
        }
    }

    /// P4b-4: the tables whose registry has composition groups give their dimension, total and groups in file order
    /// (nrg_bal_peh; nrg_bal_c and nrg_bal_s siec), a table with none and a World Bank table none; the card's line under
    /// a table says what each place's total splits into only for such a table. q3's card (run 233730) gets it under t4
    /// nrg_bal_peh alone.
    #[test]
    fn the_tables_with_composition_groups_and_their_card_line() {
        let four: Vec<String> = ["fossil", "renewable", "other", "nuclear"].iter().map(|g| g.to_string()).collect();
        for t in ["nrg_bal_peh", "nrg_bal_s", "nrg_bal_c"] {
            assert_eq!(grouped_dim(t), Some(("siec".into(), "TOTAL".into(), four.clone())), "{t}");
        }
        for none in ["nrg_cb_pem", "nrg_cb_e", "nrg_ind_ren", "SP.POP.65UP.TO.ZS@2"] {
            assert_eq!(grouped_dim(none), None, "{none}");
        }
        let card: Vec<Option<String>> =
            ["nrg_ind_pehnf", "nrg_cb_pem", "nrg_ind_pehcf", "nrg_bal_peh", "nrg_ind_peh"].iter().enumerate().map(|(i, t)| parts_line(i + 1, t)).collect();
        assert_eq!(
            card,
            [None, None, None, Some("   t4: each place's siec TOTAL splits into the registered groups fossil, renewable, other, nuclear".into()), None]
        );
    }

    /// q3 (欧盟各国发电结构): nrg_bal_peh's siec tree and its four groups on the fixture (gross electricity production, GWH,
    /// 2024; DE, and EU27_2020 as the second shape). Each tree parent is the sum of its parts (a code with no row counts as
    /// the sum of its own parts, else nothing); the leaves under the total, each in one group, sum to TOTAL, so the four group
    /// sums do too. The tolerance is the sankey's conservation knob (sankey.tol, 1e-5 of the total): EU27_2020's aggregate
    /// rows are rounded (its leaves are 0.633 GWh over its TOTAL of 2828734.401). BIOE and FE overlap the tree: neither is a
    /// group's member.
    #[test]
    fn nrg_bal_peh_s_four_groups_add_up_to_its_total_on_two_shapes() {
        let fixture = include_str!("../scripts/fixtures/data_prepare/nrg_bal_peh_GEP_2024.tsv");
        let value: BTreeMap<(String, String), f64> = fixture
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                ((f[0].to_string(), f[1].to_string()), f[2].parse().unwrap())
            })
            .collect();
        let registered = parts("nrg_bal_peh", "siec");
        let groups = composition_groups("nrg_bal_peh", "siec").unwrap();
        let names: Vec<(&str, usize)> = groups.iter().map(|(g, m)| (g.as_str(), m.len())).collect();
        assert_eq!(names, [("fossil", 40), ("renewable", 18), ("other", 7), ("nuclear", 1)]);
        let leaves: Vec<&str> = groups.iter().flat_map(|(_, m)| m.iter().map(|p| p.code.as_str())).collect();
        assert_eq!(leaves.len(), registered.iter().filter(|p| p.level == PART_LEVELS[2]).count());
        assert!(!leaves.iter().any(|c| ["BIOE", "FE", "TOTAL", "RA000"].contains(c)));
        let mut sums = Vec::new();
        for geo in ["DE", "EU27_2020"] {
            let read = |code: &str| value.get(&(geo.to_string(), code.to_string())).copied();
            fn of(code: &str, registered: &[Part], read: &dyn Fn(&str) -> Option<f64>) -> f64 {
                read(code).unwrap_or_else(|| {
                    registered
                        .iter()
                        .filter(|p| p.parent.as_deref() == Some(code))
                        .map(|p| of(&p.code, registered, read))
                        .sum()
                })
            }
            let total = read("TOTAL").unwrap();
            let tol = 1e-5 * total;
            for p in registered.iter().filter(|p| p.level != PART_LEVELS[2]) {
                let Some(whole) = read(&p.code) else { continue };
                let sum: f64 = registered
                    .iter()
                    .filter(|c| c.parent.as_deref() == Some(p.code.as_str()))
                    .map(|c| of(&c.code, &registered, &read))
                    .sum();
                assert!((whole - sum).abs() <= tol, "{geo} {}: {whole} vs parts {sum}", p.code);
            }
            let by_group: Vec<f64> = groups.iter().map(|(_, m)| m.iter().filter_map(|p| read(&p.code)).sum()).collect();
            assert!((by_group.iter().sum::<f64>() - total).abs() <= tol, "{geo}: groups {by_group:?} vs TOTAL {total}");
            sums.push((geo, by_group.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>(), total));
        }
        assert_eq!(
            sums,
            [
                ("DE", vec![210282.0, 289417.0, 14310.0, 0.0], 514009.0),
                ("EU27_2020", vec![786337.045, 1332512.227, 60339.919, 649545.843], 2828734.401)
            ]
        );
        // a table with no registered parts has no groups
        assert!(composition_groups("nrg_x", "siec").unwrap().is_empty());
        // the codes a composition fetches: each group's topmost codes under the total, official subtotals where the registry
        // has one; on both shapes their published values add up to the group's leaves within the same tolerance
        let inputs = group_inputs("nrg_bal_peh", "siec").unwrap();
        assert_eq!(
            inputs,
            [
                ("fossil", vec!["C0000X0350-0370", "C0350-0370", "P1000", "S2000", "G3000", "O4000XBIO"]),
                ("renewable", vec!["RA000"]),
                ("other", vec!["RA130", "W6100_6220", "E7000", "H8000", "X9900", "BA100"]),
                ("nuclear", vec!["N900H"]),
            ]
            .map(|(g, codes)| (g.to_string(), codes.into_iter().map(String::from).collect::<Vec<_>>()))
        );
        assert_eq!(inputs.iter().map(|(_, c)| c.len()).sum::<usize>(), 14);
        for (geo, by_group, total) in &sums {
            let read = |code: &str| value.get(&(geo.to_string(), code.to_string())).copied();
            for ((g, codes), want) in inputs.iter().zip(by_group) {
                let got: f64 = codes.iter().filter_map(|c| read(c)).sum();
                assert!((got - want).abs() <= 1e-5 * total, "{geo} {g}: inputs {got} vs leaves {want}");
            }
        }
        assert!(group_inputs("nrg_x", "siec").unwrap().is_empty());
    }

    /// q2 (德国能源从来源到各部门) as the 10-31 stand-in run answered the table pick: nrg_bal_s, t2.breakdown 2 (nrg_bal), t2.unit 1.
    /// The run's fill left nrg_bal open (92 codes), and newsroom_data_prepare stopped at needs_narrowing (92 rows, a chart shows
    /// 80); the program now fetches nrg_bal's registered parts and records where they came from. A siec split takes siec's.
    #[test]
    fn a_split_by_a_dimension_with_registered_parts_fetches_those_codes_and_q2_leaves_none_open() {
        let de = [Place::Country("DE".into())];
        let draft = draft(q2_table("nrg_bal_s"), &[], &de);
        assert_eq!(draft.breakdown, ["nrg_bal", "siec", "siec>nrg_bal"]);
        let filled = fill(&draft, 2, &picks(&[("t2.breakdown", 2), ("t2.unit", 1)]), &de, 2026).unwrap();
        let sectors: Vec<String> = parts("nrg_bal_s", "nrg_bal").into_iter().map(|p| p.code).collect();
        assert_eq!(
            sectors,
            ["FC_E", "FC_IND_E", "FC_TRA_E", "FC_OTH_E", "FC_OTH_CP_E", "FC_OTH_HH_E", "FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"]
        );
        assert_eq!(
            filled.args,
            *json!({"dataset": "nrg_bal_s", "filters": [
                {"dimension": "freq", "values": ["A"]}, {"dimension": "nrg_bal", "values": sectors},
                {"dimension": "siec", "values": ["TOTAL"]}, {"dimension": "unit", "values": ["KTOE"]},
                {"dimension": "geo", "values": ["DE"]}],
                "years": {"start": 2015, "end": 2024}})
            .as_object()
            .unwrap()
        );
        assert_eq!(filled.event["open"], Value::Null);
        assert_eq!(filled.event["narrow"], Value::Null);
        assert_eq!(filled.event["breakdown"], "nrg_bal");
        assert_eq!(filled.event["estimate"], 90);
        assert_eq!(
            filled.event["parts"],
            json!([{"dimension": "nrg_bal", "source": "estat-parts.tsv", "codes": 9, "registered": 9, "from_codes": 92, "unlisted": [],
                "parents": [["FC_IND_E", "FC_E"], ["FC_TRA_E", "FC_E"], ["FC_OTH_E", "FC_E"], ["FC_OTH_CP_E", "FC_OTH_E"],
                    ["FC_OTH_HH_E", "FC_OTH_E"], ["FC_OTH_AF_E", "FC_OTH_E"], ["FC_OTH_FISH_E", "FC_OTH_E"], ["FC_OTH_NSP_E", "FC_OTH_E"]]}])
        );
        // the siec split: siec's registered parts, nrg_bal the one code picked
        let filled = fill(
            &draft,
            2,
            &picks(&[("t2.breakdown", 3), ("t2.nrg_bal", 1), ("t2.unit", 1)]),
            &de,
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "siec").unwrap(), Q2_SIEC);
        assert_eq!(filter(&filled, "nrg_bal").unwrap().len(), 1);
        assert_eq!(filled.event["open"], Value::Null);
        assert_eq!(filled.event["parts"][0]["dimension"], "siec");
        assert_eq!(filled.event["parts"][0]["source"], PARTS_SOURCE);
        // a part the table does not list is left out and named; a table that lists not even the total is left open as before
        let mut cut = q2_table("nrg_bal_s");
        cut.dims[1].1.retain(|(c, _)| c != "FC_OTH_FISH_E");
        let filled = fill(&draft_of_table(cut), 2, &picks(&[("t2.breakdown", 2), ("t2.unit", 1)]), &de, 2026).unwrap();
        assert_eq!(filter(&filled, "nrg_bal").unwrap().len(), 8);
        assert_eq!(filled.event["parts"][0]["unlisted"], json!(["FC_OTH_FISH_E"]));
        let mut no_total = q2_table("nrg_bal_s");
        no_total.dims[1].1.retain(|(c, _)| c != "FC_E");
        let filled = fill(&draft_of_table(no_total), 2, &picks(&[("t2.breakdown", 2), ("t2.unit", 1)]), &de, 2026).unwrap();
        assert_eq!(filled.event["open"], "nrg_bal");
        assert!(filled.event.get("parts").is_none());
        assert!(filter(&filled, "nrg_bal").is_none());
    }

    /// q2's flow (德国能源从来源到各部门): nrg_bal_s registers siec -> nrg_bal (estat-parts.tsv), so the draft offers one more
    /// split, the flow. Its fill fetches the leaves of both dimensions, one level per side: FC_OTH_E's five parts and never
    /// FC_OTH_E beside them, no TOTAL and no FC_E. The registry leaves nuclear heat out of the flow (excluded_from FC_E: Eurostat
    /// flags each of its final-use cells not applicable), so of the 11 x 7 = 77 registered pairs the latest year's fetch asks
    /// for 10 x 7 = 70, within a chart's 80 rows, and the event says the 7 left out with their source; predicted_shape reports
    /// the registered pair as the flow. On the DE 2024 fixture the leaf flows add up to TOTAL at FC_E
    /// (the fixture holds no FC_OTH_E row, so FC_OTH_E = its five parts is not checked here).
    #[test]
    fn a_flow_split_fetches_the_leaves_of_both_dimensions_and_they_add_up_to_the_total() {
        let de = [Place::Country("DE".into())];
        assert_eq!(flow_dims("nrg_bal_s"), Some(("siec".to_string(), "nrg_bal".to_string())));
        let draft = draft(q2_table("nrg_bal_s"), &[], &de);
        assert_eq!(draft.breakdown, ["nrg_bal", "siec", "siec>nrg_bal"]);
        assert_eq!(flow_split("siec>nrg_bal"), Some(("siec", "nrg_bal")));
        assert_eq!(flow_split("siec"), None);
        let (_, options) = items(2, &draft).into_iter().find(|(k, _)| k == "t2.breakdown").unwrap();
        assert_eq!(
            options[3],
            "flow from siec to nrg_bal: each place × 10 siec parts × 7 nrg_bal parts, the leaves under each total (no total or subtotal drawn); siec N900H left out (registered as not applicable); leave out t2.nrg_bal"
        );
        // nrg_bal is a member item (no total code) that both its own split and the flow take; siec has TOTAL, so no item
        let listed = lines(2, &draft, &items(2, &draft));
        assert!(listed.contains(&"   t2.nrg_bal (only when t2.breakdown is not nrg_bal or siec>nrg_bal):".to_string()), "{listed:?}");
        assert!(!listed.iter().any(|l| l.starts_with("   t2.siec")), "{listed:?}");
        let fuels: Vec<String> = flow_parts("nrg_bal_s", "siec").into_iter().map(|p| p.code).collect();
        let sectors: Vec<String> = flow_parts("nrg_bal_s", "nrg_bal").into_iter().map(|p| p.code).collect();
        assert_eq!(fuels, Q2_SIEC[1..].to_vec());
        let excluded = flow_excluded("nrg_bal_s").unwrap();
        assert_eq!(excluded.iter().map(|p| (p.code.as_str(), p.excluded_from.as_deref())).collect::<Vec<_>>(), [("N900H", Some("FC_E"))]);
        let source = excluded[0].excluded_source.as_deref().unwrap();
        for words in ["KS-HB-20-001", "https://ec.europa.eu/eurostat/documents/3217494/11099022/KS-HB-20-001-EN-N.pdf", "PDF p.26 (printed p.24)", "PDF p.16 (printed p.14)",
            "Symbol \"Z\" means data are not applicable.", "Basis: the cell-by-cell Z flags, not a one-sentence definition."] {
            assert!(source.contains(words), "{words}");
        }
        let asked: Vec<String> = flow_asked("nrg_bal_s", "siec").unwrap().into_iter().map(|p| p.code).collect();
        assert_eq!(asked, fuels.iter().filter(|f| *f != "N900H").cloned().collect::<Vec<_>>());
        assert_eq!(flow_asked("nrg_bal_s", "nrg_bal").unwrap().len(), 7);
        assert!(flow_excluded("nrg_x").unwrap().is_empty());
        assert_eq!(
            sectors,
            ["FC_IND_E", "FC_TRA_E", "FC_OTH_CP_E", "FC_OTH_HH_E", "FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"]
        );
        let answer = picks(&[("t2.breakdown", 4), ("t2.unit", 1), ("t2.years", 1)]);
        let filled = fill(&draft, 2, &answer, &de, 2026).unwrap();
        assert_eq!(
            filled.args,
            *json!({"dataset": "nrg_bal_s", "filters": [
                {"dimension": "freq", "values": ["A"]}, {"dimension": "nrg_bal", "values": sectors},
                {"dimension": "siec", "values": asked}, {"dimension": "unit", "values": ["KTOE"]},
                {"dimension": "geo", "values": ["DE"]}],
                "years": {"start": 2024, "end": 2024}})
            .as_object()
            .unwrap()
        );
        assert_eq!(filled.event["open"], Value::Null);
        assert_eq!(filled.event["breakdown"], "siec>nrg_bal");
        assert_eq!(filled.event["estimate"], 70);
        assert_eq!(filled.event["flow"]["pairs"], json!({"registered": 77, "excluded": 7, "asked": 70}));
        assert_eq!(
            filled.event["flow"]["excluded"],
            json!([{"dimension": "siec", "code": "N900H", "from": "FC_E", "pairs": 7, "source": source}])
        );
        for (k, v) in [("source", "siec"), ("target", "nrg_bal"), ("from", PARTS_SOURCE)] {
            assert_eq!(filled.event["flow"][k], v);
        }
        assert_eq!(filled.event["parts"][0]["dimension"], "nrg_bal");
        assert_eq!(filled.event["parts"][0]["flow"], "target");
        assert_eq!(filled.event["parts"][0]["totals"], json!(["FC_E", "FC_OTH_E"]));
        assert_eq!(filled.event["parts"][1]["dimension"], "siec");
        assert_eq!(filled.event["parts"][1]["flow"], "source");
        assert_eq!(filled.event["parts"][1]["totals"], json!(["TOTAL"]));
        let shape = predicted_shape(&draft, 2, &answer, &de, 2026, &|_| Some(true)).unwrap();
        assert_eq!(shape.official_flow, Some(("siec".to_string(), "nrg_bal".to_string())));
        let members: Vec<(&str, usize)> = shape.dims.iter().map(|d| (d.dim.as_str(), d.members)).collect();
        assert_eq!(members, [("nrg_bal", 7), ("siec", 10)]);
        assert!(shape.dims.iter().map(|d| d.members).product::<usize>() <= MAX_CHART_ROWS);
        // a split by one dimension reports no flow
        let one = predicted_shape(&draft, 2, &picks(&[("t2.breakdown", 3), ("t2.unit", 1), ("t2.years", 1)]), &de, 2026, &|_| Some(true));
        assert_eq!(one.unwrap().official_flow, None);
        // a table that leaves one leaf out is offered no flow, and a flow answer for it is refused, not short of the total
        let mut cut = q2_table("nrg_bal_s");
        cut.dims[1].1.retain(|(c, _)| c != "FC_OTH_FISH_E");
        let short = draft_of_table(cut);
        assert_eq!(short.breakdown, ["nrg_bal", "siec"]);
        let forced = Draft { breakdown: draft.breakdown.clone(), ..short };
        let refused = fill(&forced, 2, &answer, &de, 2026).unwrap_err();
        assert!(refused.contains("does not list every registered leaf of nrg_bal"), "{refused}");
        // On the DE 2024 fixture (KTOE): the 77 registered leaf pairs hold 69 rows (no N900H row: the registry's exclusion
        // stands on the data too; no FC_TRA_E x H8000 row), 32 of them non-zero, and their sum is TOTAL at FC_E within
        // classify's tolerance.
        let fixture = include_str!("../scripts/fixtures/data_prepare/nrg_bal_s_DE_2024.tsv");
        let value: BTreeMap<(String, String), f64> = fixture
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                ((f[0].to_string(), f[1].to_string()), f[2].parse().unwrap())
            })
            .collect();
        let flows: Vec<f64> = sectors
            .iter()
            .flat_map(|s| fuels.iter().map(move |f| (s.clone(), f.clone())))
            .filter_map(|pair| value.get(&pair).copied())
            .collect();
        assert_eq!(flows.len(), 69);
        assert!(!value.keys().any(|(_, siec)| siec == "N900H"), "no row of an excluded code");
        assert_eq!(flows.iter().filter(|v| **v != 0.0).count(), 32);
        let total = value[&("FC_E".to_string(), "TOTAL".to_string())];
        let sum: f64 = flows.iter().sum();
        assert!((sum - total).abs() <= crate::classify::TOLERANCE * total, "flows {sum} vs total {total}");
    }

    fn draft_of_table(table: TableMeta) -> Draft {
        draft(table, &[], &[Place::Country("DE".into())])
    }

    /// A table with no registered parts fills as before: the same q2 answer on the same codes under an unregistered id gives
    /// the 10-31 run's fetch byte for byte (nrg_bal open), and its event names no parts.
    #[test]
    fn a_table_with_no_registered_parts_fills_as_before() {
        let de = [Place::Country("DE".into())];
        assert!(parts("nrg_x", "nrg_bal").is_empty() && parts("nrg_x", "siec").is_empty());
        let draft = draft(q2_table("nrg_x"), &[], &de);
        // no registered flow: the two splits it had, and the same options under them as nrg_bal_s's but its flow
        assert_eq!(flow_dims("nrg_x"), None);
        assert_eq!(draft.breakdown, ["nrg_bal", "siec"]);
        let registered = super::draft(q2_table("nrg_bal_s"), &[], &de);
        let mut options = items(2, &registered);
        options.iter_mut().find(|(k, _)| k == "t2.breakdown").unwrap().1.pop();
        assert_eq!(items(2, &draft), options);
        let filled = fill(&draft, 2, &picks(&[("t2.breakdown", 2), ("t2.unit", 1)]), &de, 2026).unwrap();
        // the run's next_params args, with only the dataset id changed
        let run = json!({"dataset": "nrg_x", "filters": [{"dimension": "freq", "values": ["A"]},
            {"dimension": "siec", "values": ["TOTAL"]}, {"dimension": "unit", "values": ["KTOE"]}, {"dimension": "geo", "values": ["DE"]}],
            "years": {"start": 2015, "end": 2024}});
        assert_eq!(
            serde_json::to_string(&Value::Object(filled.args.clone())).unwrap(),
            serde_json::to_string(&run).unwrap()
        );
        assert_eq!(filled.event["open"], "nrg_bal");
        assert_eq!(filled.event["estimate"], 920);
        assert!(filled.event.get("parts").is_none());
    }

    /// q2 as the 10-31 12:27 stand-in run answered it on the table it ranked first, nrg_bal_c with its catalogue codes (142
    /// nrg_bal, 72 siec): t1.breakdown 2 (nrg_bal), t1.unit 1 left nrg_bal open and stopped at needs_narrowing. The family's
    /// rows register nrg_bal_c too, so the split fetches the registered codes the table lists, and its flow is offered and
    /// filled as nrg_bal_s's. On that run's DE 2024 rows (siec TOTAL) the sector leaves add up to FC_E, and FC_OTH_E's five parts
    /// to FC_OTH_E; on the DE 2024 FC_E rows by fuel (fetched 10-31 for this check) the fuel leaves add up to siec TOTAL, nuclear
    /// heat having no final-use row.
    #[test]
    fn nrg_bal_c_with_its_catalogue_codes_fills_the_family_s_registered_parts() {
        let de = [Place::Country("DE".into())];
        let listed = include_str!("../scripts/fixtures/data_prepare/nrg_bal_c_codes.tsv");
        let of = |d: &str| -> Vec<&str> {
            listed.lines().filter(|l| !l.starts_with('#')).skip(1).filter_map(|l| l.split_once('\t')).filter(|(x, _)| *x == d).map(|(_, c)| c).collect()
        };
        let (nrg_bal, siec) = (of("nrg_bal"), of("siec"));
        assert_eq!((nrg_bal.len(), siec.len()), (142, 72));
        let table = eurostat(
            "nrg_bal_c",
            vec![dim("geo", &["EU27_2020", "DE", "FR"]), dim("nrg_bal", &nrg_bal), dim("siec", &siec), dim("unit", &["KTOE", "GWH", "TJ"])],
        );
        let draft = draft(table, &[], &de);
        assert_eq!(draft.breakdown, ["nrg_bal", "siec", "siec>nrg_bal"]);
        let filled = fill(&draft, 1, &picks(&[("t1.breakdown", 2), ("t1.unit", 1)]), &de, 2026).unwrap();
        let sectors: Vec<String> = parts("nrg_bal_c", "nrg_bal").into_iter().map(|p| p.code).collect();
        assert_eq!(filter(&filled, "nrg_bal").unwrap(), sectors);
        assert_eq!(filled.event["open"], Value::Null);
        assert_eq!(filled.event["estimate"], 90);
        assert_eq!(filled.event["parts"][0]["from_codes"], 142);
        assert_eq!(filled.event["parts"][0]["unlisted"], json!([]));
        // the flow: 10 x 7 leaves for the latest year, none open, the family's exclusion read from the same row (N900H)
        let flow = fill(&draft, 1, &picks(&[("t1.breakdown", 4), ("t1.unit", 1), ("t1.years", 1)]), &de, 2026).unwrap();
        assert_eq!(filter(&flow, "siec").unwrap().len(), 10);
        assert!(!filter(&flow, "siec").unwrap().iter().any(|c| c == "N900H"));
        assert_eq!(filter(&flow, "nrg_bal").unwrap().len(), 7);
        assert_eq!(flow.event["open"], Value::Null);
        assert_eq!(flow.event["estimate"], 70);
        assert_eq!(flow.event["flow"]["pairs"], json!({"registered": 77, "excluded": 7, "asked": 70}));
        assert_eq!(flow.event["flow"]["excluded"][0]["code"], "N900H");
        // the run's DE 2024 sector rows
        let fixture = include_str!("../scripts/fixtures/data_prepare/nrg_bal_c_DE_2024_TOTAL.tsv");
        let value: BTreeMap<&str, f64> = fixture
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                (f[0], f[2].parse().unwrap())
            })
            .collect();
        let leaves: f64 = flow_parts("nrg_bal_c", "nrg_bal").iter().map(|p| value[p.code.as_str()]).sum();
        let other: f64 = parts("nrg_bal_c", "nrg_bal")
            .iter()
            .filter(|p| p.parent.as_deref() == Some("FC_OTH_E"))
            .map(|p| value[p.code.as_str()])
            .sum();
        // the DE 2024 FC_E rows by fuel
        let fixture = include_str!("../scripts/fixtures/data_prepare/nrg_bal_c_DE_2024_FC_E.tsv");
        let by_fuel: BTreeMap<&str, f64> = fixture
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                (f[1], f[2].parse().unwrap())
            })
            .collect();
        let fuels = flow_parts("nrg_bal_c", "siec");
        assert_eq!(fuels.len(), 11);
        assert_eq!(fuels.iter().filter(|p| !by_fuel.contains_key(p.code.as_str())).map(|p| p.code.as_str()).collect::<Vec<_>>(), ["N900H"]);
        let fuel_leaves: f64 = fuels.iter().filter_map(|p| by_fuel.get(p.code.as_str())).sum();
        assert_eq!(by_fuel["TOTAL"], value["FC_E"]);
        for (whole, sum) in [(value["FC_E"], leaves), (value["FC_OTH_E"], other), (by_fuel["TOTAL"], fuel_leaves)] {
            assert!((whole - sum).abs() <= crate::classify::TOLERANCE * whole, "{whole} vs parts {sum}");
        }
    }
}

/// The registered subtotals of dimension `dim` of `table` that overlap its tree (OVERLAP_LEVEL), in file order: never a part,
/// a parent or a group's member, listed so a page can say they are left out. Only the tests read it yet.
#[cfg(test)]
pub fn overlaps(table: &str, dim: &str) -> Vec<Part> {
    registry()
        .iter()
        .filter(|(t, d, p)| t == table && d == dim && p.level == OVERLAP_LEVEL)
        .map(|(_, _, part)| part.clone())
        .collect()
}
