//! Flow side: the fetch parameters of a table the model picked, filled from the catalogue's own lists when no prepare spec
//! is given. The program fills what the codes alone decide (a dimension with one code, a total code, the places the
//! question names, the last year from the TOC); what only the question decides (the dimension the page breaks down by, a
//! measure or unit with no total, one year or ten) is listed under the table in the table pick as numbered options, the
//! model answering with numbers only. Every code a rule asks for is in the registry below. Pure: no file, no tool, no model.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use crate::classify::PLACE_SHARE;
use crate::l5geo::{Place, TableMeta};
use crate::shape_registry::{Role, Shape, VaryingDim, MAX_ROWS as MAX_CHART_ROWS};

/// Registry: codes that stand for the whole of a dimension, judged before the fetch by the code alone ("*" is any
/// dimension). classify judges the rows again after the fetch; this list only decides what is asked for.
pub const TOTAL_CODES: [(&str, &str); 2] = [("*", "TOTAL"), ("sex", "T")];
/// Registry: the EU aggregate on the geo dimension, asked for when the page breaks down by another place dimension.
pub const EU_AGGREGATE: &str = "EU27_2020";
/// Registry: the 27 EU members as Eurostat geo codes (EL is Greece), for a question that names the EU or Europe.
pub const EU27: [&str; 27] = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];
/// Registry: Eurostat geo codes that are not ISO 3166-1 alpha-2, as (Eurostat, ISO).
pub const ESTAT_ISO: [(&str, &str); 2] = [("EL", "GR"), ("UK", "GB")];
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
/// Codes kept when an open place dimension has more codes than a chart shows (newsroom_data_prepare narrow, rule "top"):
/// the highest at the latest time, at most the chart's rows over the years.
pub const NARROW_TOP: usize = 20;
/// The one registry of how a World Bank table with every country open is narrowed (the options, their n, the rank-year
/// share and the page wording), the same file newsroom.ts validates the narrow against.
const WB_RANK_BY: &str = include_str!("../runtime/pi/assets/wb-rank-by.json");
/// The item of a World Bank table with every country open: which economies the page keeps.
pub const PLACES_KEY: &str = "places";

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
}

/// A dimension, its offered codes, and how many codes it has.
pub type OfferedDim = (String, Vec<(String, String)>, usize);

/// The fetch arguments of one table and the event that records how they were filled.
#[derive(Clone, Debug, PartialEq)]
pub struct Filled {
    pub args: Map<String, Value>,
    pub event: Value,
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
    let places_open = table.worldbank && places.is_empty() && table.places.len() > MAX_CHART_ROWS;
    Draft {
        table,
        breakdown,
        members,
        named,
        ambiguous,
        places_open,
    }
}

/// A member dimension that is also a breakdown option: its item is answered only when the breakdown is not it (a
/// breakdown takes every code of its dimension, so a code picked for it would have no place).
fn split_member(d: &Draft, dim: &str) -> bool {
    d.breakdown.iter().any(|b| b == dim) && d.members.iter().any(|(m, _, _)| m == dim)
}

/// The items of table `n` (its number in the table pick) with their option labels: the years, the economies a World Bank
/// table with every country open keeps, its breakdown when it has a breakdown dimension, and each member dimension
/// ("t<n>.years", "t<n>.places", "t<n>.breakdown", "t<n>.<dim>"). The breakdown's options say what the page then compares.
pub fn items(n: usize, d: &Draft) -> Vec<(String, Vec<String>)> {
    let mut out = vec![(
        format!("t{n}.{YEARS_KEY}"),
        YEARS_OPTIONS.iter().map(|s| s.to_string()).collect(),
    )];
    if d.places_open {
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
            Some(dim) => lines.push(format!("   {key} (only when t{n}.breakdown is not {dim}):")),
            None => match non_annual(&d.table).filter(|_| *key == format!("t{n}.{YEARS_KEY}")) {
                Some(span) => lines.push(format!("   {key} ({span}):")),
                None => lines.push(format!("   {key}:")),
            },
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
/// places the question names. Err when the table holds none of the named places.
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
        let values = if !countries.is_empty() {
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
            if !countries.is_empty() || region {
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
            if Some(dim) == breakdown.as_ref() {
                open = Some((dim.clone(), codes.len()));
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
            let values: Vec<String> = if !countries.is_empty() {
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
    let end = table.end_year.unwrap_or(this_year - 1);
    let latest = if table.worldbank {
        end - WB_LATEST_SPAN + 1
    } else {
        end
    };
    let asked = pick(&format!("t{n}.{YEARS_KEY}"));
    let mut start = if asked == 2 {
        end - YEARS_SPAN + 1
    } else {
        latest
    };
    let mut years_cut = Value::Null;
    if rows_but_years * (end - start + 1) as u64 > limit && start < latest {
        years_cut = json!({"from": {"start": start, "end": end}, "to": {"start": latest, "end": end},
            "estimate": rows_but_years * (end - start + 1) as u64, "limit": limit});
        start = latest;
    }
    // An open place dimension with more codes than a chart shows, every other dimension one code: the tool keeps its top
    // codes (two-letter codes only, the total refetched as the denominator); a dimension of another kind stays as asked.
    let years = (end - start + 1) as usize;
    let mut narrow = Value::Null;
    // A World Bank table with every country open: the tool keeps the economies of the picked registry option (aggregates
    // out, ranked at the latest year most of them have), at most the chart's rows over the years.
    if let Some((_, count)) = open
        .as_ref()
        .filter(|(dim, _)| draft.places_open && dim == WB_PLACE_DIM)
    {
        let (cap, options) = wb_rank_by();
        let kept = pick(&format!("t{n}.{PLACES_KEY}"));
        let (option, rank) = kept
            .checked_sub(1)
            .and_then(|i| options.get(i))
            .map_or((1, &options[0]), |o| (kept, o));
        narrow = json!({"dimension": WB_PLACE_DIM, "rule": rank.rule, "by": rank.by, "n": (*cap).min(MAX_CHART_ROWS / years).max(1),
            "exclude": [], "option": option, "key": rank.key, "label": rank.label, "from_codes": count,
            "estimate": count * years, "chart_rows": MAX_CHART_ROWS});
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
    args.insert(
        "dataset".into(),
        json!(table.id.strip_suffix("@2").unwrap_or(&table.id)),
    );
    if !filters.is_empty() {
        args.insert("filters".into(), Value::Array(filters));
    }
    args.insert("years".into(), json!({"start": start, "end": end}));
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
        "years": {"option": asked, "end_from": if table.end_year.is_some() { "toc" } else { "this year - 1" }, "this_year": this_year},
        "years_cut": years_cut, "estimate": rows_but_years * (end - start + 1) as u64, "limit": limit, "options_cut": cut,
        "places": places.iter().map(|p| match p { Place::Country(iso) => iso.clone(), Place::Region => "region".to_string() }).collect::<Vec<_>>(),
        "dropped": dropped, "narrow": narrow,
    });
    if !draft.named.is_empty() {
        event["named"] = json!(draft.named);
    }
    if !draft.ambiguous.is_empty() {
        event["ambiguous"] = json!(draft.ambiguous);
    }
    Ok(Filled { args, event })
}

/// The slice the fetch of these picks would vary over, judged from its arguments before any download: each filtered
/// dimension with more than one code, the open dimension (its code count, or the top the tool narrows it to), and the
/// time when more than one year is asked. Roles are what the codes alone tell (a place, the time, else a category); the
/// knowledge group's classify judges the fetched rows again. Err as fill.
pub fn predicted_shape(
    draft: &Draft,
    n: usize,
    picks: &BTreeMap<String, usize>,
    places: &[Place],
    this_year: i32,
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
    let varying = |dim: &str, values: &[&str]| {
        let is_place = dim == WB_PLACE_DIM || place_like(dim, codes(dim));
        VaryingDim {
            dim: dim.to_string(),
            members: values.len(),
            roles: vec![if is_place {
                Role::Place
            } else {
                Role::Category
            }],
            is_place,
            iso_countries: dim == WB_PLACE_DIM
                || (is_place && values.iter().all(|c| country_like(c))),
            total_member: None,
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
    if span > 1 {
        dims.push(VaryingDim {
            dim: "time".into(),
            members: span as usize,
            roles: vec![Role::Time],
            is_place: false,
            iso_countries: false,
            total_member: None,
        });
    }
    Ok(Shape {
        dims,
        unit_additive: false,
        official_flow: None,
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
        assert_eq!(keys, ["t1.years", "t1.breakdown", "t1.nrg_bal"]);
        let listed = lines(1, &draft, &items);
        assert_eq!(
            listed[..3],
            [
                "   t1.years:",
                "     1. the latest year only",
                "     2. the last ten years"
            ]
        );
        assert_eq!(
            listed[4],
            "     1. none: one number per place, each item below keeps the one code picked"
        );
        assert_eq!(listed[5], "     2. split by nrg_bal: each place × all 3 nrg_bal codes (e.g. label REN; label REN_TRA; label REN_ELC); leave out t1.nrg_bal");
        assert_eq!(
            listed[6],
            "   t1.nrg_bal (only when t1.breakdown is not nrg_bal):"
        );
        let filled = fill(
            &draft,
            1,
            &picks(&[("t1.breakdown", 1), ("t1.nrg_bal", 3), ("t1.years", 2)]),
            &[Place::Region],
            2026,
        )
        .unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["BE", "DE", "EL"]);
        assert_eq!(filled.event["places"], json!(["region"]));
        assert_eq!(filled.event["dropped"].as_array().unwrap().len(), 24);
        assert_eq!(filter(&filled, "nrg_bal").unwrap(), ["REN_ELC"]);
        assert_eq!(filled.args["years"], json!({"start": 2015, "end": 2024}));
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
            predicted_shape(&d, 1, &picks(p), places, 2026)
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
        }
    }

    #[test]
    fn a_world_bank_table_with_every_country_open_asks_which_economies_to_keep() {
        let d = draft(world_bank(217), &[], &[]);
        assert!(d.places_open);
        let listed = items(1, &d);
        assert_eq!(listed[1].0, "t1.places");
        assert_eq!(
            listed[1].1[2],
            "keep the 8 most populous economies (World Bank SP.POP.TOTL, the latest year both tables have)"
        );
        assert_eq!(listed[1].1.len(), wb_rank_by().1.len());
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
}
