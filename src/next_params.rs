//! Flow side: the fetch parameters of a table the model picked, filled from the catalogue's own lists when no prepare spec
//! is given. The program fills what the codes alone decide (a dimension with one code, a total code, the places the
//! question names, the last year from the TOC); what only the question decides (the dimension the page breaks down by, a
//! measure or unit with no total, one year or ten) is listed under the table in the table pick as numbered options, the
//! model answering with numbers only. Every code a rule asks for is in the registry below. Pure: no file, no tool, no model.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::classify::PLACE_SHARE;
use crate::l5geo::{Place, TableMeta};
use crate::shape_registry::MAX_ROWS as MAX_CHART_ROWS;

/// Registry: codes that stand for the whole of a dimension, judged before the fetch by the code alone ("*" is any
/// dimension). classify judges the rows again after the fetch; this list only decides what is asked for.
pub const TOTAL_CODES: [(&str, &str); 2] = [("*", "TOTAL"), ("sex", "T")];
/// Registry: the EU aggregate on the geo dimension, asked for when the page breaks down by another place dimension.
pub const EU_AGGREGATE: &str = "EU27_2020";
/// Registry: the 27 EU members as Eurostat geo codes (EL is Greece), for a question that names the EU or Europe.
pub const EU27: [&str; 27] = [
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV",
    "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];
/// Registry: Eurostat geo codes that are not ISO 3166-1 alpha-2, as (Eurostat, ISO).
pub const ESTAT_ISO: [(&str, &str); 2] = [("EL", "GR"), ("UK", "GB")];
/// Registry: the frequency every Eurostat fetch asks for (the metabase lists no freq).
pub const FREQ: (&str, &str) = ("freq", "A");
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

/// One picked table before the model's answer: what the program fixed, and what it asks.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub table: TableMeta,
    /// Dimensions the breakdown may be, offered as options 2.. (option 1 is none).
    pub breakdown: Vec<String>,
    /// Dimensions with several codes and no total: the offered codes, and how many codes the dimension has.
    pub members: Vec<(String, Vec<(String, String)>, usize)>,
}

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
        .find_map(|(_, total)| codes.iter().find(|(c, _)| c == total).map(|(c, _)| c.as_str()))
}

/// A label that names a whole ("Total ...", Eurostat's wording): offered first, as a whole to pick, never fixed, since one
/// dimension can hold several (src_crf: excluding memo items, excluding LULUCF) and "Total crop" is a subtotal.
fn total_label(label: &str) -> bool {
    label.strip_prefix("Total").is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric()))
}

/// A memo item is reported beside the inventory, not part of it (Eurostat src_crf "Memo items", "(memo item)"): never offered.
/// A whole that names them ("Total (excluding memo items)") is a whole.
fn memo_label(label: &str) -> bool {
    !total_label(label) && label.to_lowercase().contains("memo item")
}

fn country_like(code: &str) -> bool {
    code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// A place dimension before the fetch: geo, or a dimension whose codes are mostly two-letter country codes (classify's share).
fn place_like(dim: &str, codes: &[(String, String)]) -> bool {
    dim == GEO_DIM
        || (codes.len() >= 2
            && codes.iter().filter(|(c, _)| country_like(c)).count() as f64 / codes.len() as f64 >= PLACE_SHARE)
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// What the program fixes and what it asks for one table; `texts` are the model's search words, used only to order options.
pub fn draft(table: TableMeta, texts: &[String]) -> Draft {
    let searched: Vec<String> = texts.iter().flat_map(|t| words(t)).collect();
    let mut breakdown = Vec::new();
    let mut members = Vec::new();
    for (dim, codes) in &table.dims {
        if dim != GEO_DIM && dim != UNIT_DIM && codes.len() > 1 {
            breakdown.push(dim.clone());
        }
        if dim == GEO_DIM || codes.len() == 1 || total_of(dim, codes).is_some() {
            continue;
        }
        let mut ranked: Vec<(bool, usize, &(String, String))> = codes
            .iter()
            .filter(|code| !memo_label(&code.1))
            .map(|code| (total_label(&code.1), words(&code.1).iter().filter(|w| searched.contains(w)).count(), code))
            .collect();
        ranked.sort_by_key(|(total, hits, _)| std::cmp::Reverse((*total, *hits)));
        let offered = ranked.into_iter().take(OPTIONS_MAX).map(|(_, _, code)| code.clone()).collect();
        members.push((dim.clone(), offered, codes.len()));
    }
    breakdown.truncate(OPTIONS_MAX - 1);
    Draft { table, breakdown, members }
}

/// The items of table `n` (its number in the table pick) with their option labels: the years, its breakdown when it has
/// a breakdown dimension, and each member dimension ("t<n>.years", "t<n>.breakdown", "t<n>.<dim>").
pub fn items(n: usize, d: &Draft) -> Vec<(String, Vec<String>)> {
    let mut out = vec![(format!("t{n}.{YEARS_KEY}"), YEARS_OPTIONS.iter().map(|s| s.to_string()).collect())];
    if !d.breakdown.is_empty() {
        let mut options = vec!["none: one value per place".to_string()];
        for dim in &d.breakdown {
            let codes = &d.table.dims.iter().find(|(id, _)| id == dim).expect("a breakdown dimension is a dimension").1;
            let some: Vec<&str> = codes.iter().take(3).map(|(c, l)| if l.is_empty() { c.as_str() } else { l.as_str() }).collect();
            options.push(format!("{dim} ({} codes, e.g. {})", codes.len(), some.join("; ")));
        }
        out.push((format!("t{n}.breakdown"), options));
    }
    for (dim, offered, _) in &d.members {
        out.push((
            format!("t{n}.{dim}"),
            offered.iter().map(|(c, l)| if l.is_empty() { c.clone() } else { format!("{c}: {l}") }).collect(),
        ));
    }
    out
}

/// The lines listed under a table in the table pick: each item with its numbered options.
pub fn lines(items: &[(String, Vec<String>)]) -> Vec<String> {
    let mut lines = Vec::new();
    for (key, options) in items {
        lines.push(format!("   {key}:"));
        lines.extend(options.iter().enumerate().map(|(k, o)| format!("     {}. {o}", k + 1)));
    }
    lines
}

/// The fetch arguments of table `n` (its number in the table pick) from the answer (item key -> option number, every item answered) and the
/// places the question names. Err when the table holds none of the named places.
pub fn fill(draft: &Draft, n: usize, picks: &BTreeMap<String, usize>, places: &[Place], this_year: i32) -> Result<Filled, String> {
    let table = &draft.table;
    let pick = |key: &str| picks.get(key).copied().unwrap_or(1);
    let breakdown = match pick(&format!("t{n}.breakdown")) {
        1 => None,
        k => draft.breakdown.get(k - 2).cloned(),
    };
    let countries: Vec<&str> = places
        .iter()
        .filter_map(|p| match p {
            Place::Country(iso) => Some(iso.as_str()),
            Place::Region => None,
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
                let id = table.places.iter().find(|(i, _)| i == iso).map(|(_, id)| id.clone());
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
            ids(&mut EU27.iter().map(|c| ESTAT_ISO.iter().find(|(e, _)| e == c).map_or(*c, |(_, i)| *i)))
        } else {
            Vec::new()
        };
        if values.is_empty() {
            if !countries.is_empty() || region {
                return Err(format!("{} holds none of the places the question names", table.id));
            }
            open = Some((WB_PLACE_DIM.to_string(), table.places.len()));
        } else {
            put(&mut filters, WB_PLACE_DIM, values);
        }
    } else {
        put(&mut filters, FREQ.0, vec![FREQ.1.to_string()]);
        for (dim, codes) in &table.dims {
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
                let (_, offered, all) = draft.members.iter().find(|(d, _, _)| d == dim).expect("a dimension with no total is an item");
                if offered.len() < *all {
                    cut.insert(dim.clone(), json!({"offered": offered.len(), "codes": all}));
                }
                offered.get(pick(&format!("t{n}.{dim}")) - 1).map_or_else(|| offered[0].0.clone(), |(c, _)| c.clone())
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
                    .filter(|c| held(c) || {
                        dropped.push(c.to_string());
                        false
                    })
                    .map(str::to_string)
                    .collect()
            };
            let values: Vec<String> = if !countries.is_empty() {
                keep(&mut countries.iter().map(|iso| ESTAT_ISO.iter().find(|(_, i)| i == iso).map_or(*iso, |(e, _)| *e)))
            } else if by_place {
                [EU_AGGREGATE].into_iter().filter(|c| held(c)).map(str::to_string).collect()
            } else if region {
                keep(&mut EU27.iter().copied())
            } else if breakdown.is_some() {
                geo.iter().map(|(c, _)| c).filter(|c| country_like(c)).cloned().collect()
            } else {
                open = Some((GEO_DIM.to_string(), geo.len()));
                Vec::new()
            };
            if open.as_ref().is_none_or(|(d, _)| d != GEO_DIM) {
                if values.is_empty() {
                    return Err(format!("{} holds none of the places the question names", table.id));
                }
                put(&mut filters, GEO_DIM, values);
            }
        }
    }
    let rows_but_years = rows * open.as_ref().map_or(1, |(_, count)| *count as u64);
    let limit = if table.worldbank { MAX_ROWS_WORLDBANK } else { MAX_ROWS_EUROSTAT };
    let end = table.end_year.unwrap_or(this_year - 1);
    let latest = if table.worldbank { end - WB_LATEST_SPAN + 1 } else { end };
    let asked = pick(&format!("t{n}.{YEARS_KEY}"));
    let mut start = if asked == 2 { end - YEARS_SPAN + 1 } else { latest };
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
    if let Some((dim, count)) = open.as_ref().filter(|(_, count)| !table.worldbank && *count > MAX_CHART_ROWS) {
        let codes = &table.dims.iter().find(|(d, _)| d == dim).expect("the open dimension is a dimension").1;
        let single = filters.iter().all(|f| f["values"].as_array().is_some_and(|v| v.len() == 1));
        if single && place_like(dim, codes) {
            let total = total_of(dim, codes);
            let exclude: Vec<&str> =
                codes.iter().map(|(c, _)| c.as_str()).filter(|c| !country_like(c) && Some(*c) != total).collect();
            narrow = json!({"dimension": dim, "rule": "top", "n": NARROW_TOP.min(MAX_CHART_ROWS / years).max(1),
                "exclude": exclude, "total": total, "from_codes": count, "estimate": count * years, "chart_rows": MAX_CHART_ROWS});
        }
    }
    let mut args = Map::new();
    if table.worldbank {
        args.insert("provider".into(), json!("worldbank"));
    }
    args.insert("dataset".into(), json!(table.id.strip_suffix("@2").unwrap_or(&table.id)));
    if !filters.is_empty() {
        args.insert("filters".into(), Value::Array(filters));
    }
    args.insert("years".into(), json!({"start": start, "end": end}));
    if let Some(n) = narrow.as_object() {
        let mut arg: Map<String, Value> =
            n.iter().filter(|(k, _)| ["dimension", "rule", "n", "exclude"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        if !n["total"].is_null() {
            arg.insert("total".into(), n["total"].clone());
        }
        args.insert("narrow".into(), Value::Object(arg));
    }
    let event = json!({
        "table": table.id, "args": args, "breakdown": breakdown, "open": open.map(|(d, _)| d),
        "years": {"option": asked, "end_from": if table.end_year.is_some() { "toc" } else { "this year - 1" }, "this_year": this_year},
        "years_cut": years_cut, "estimate": rows_but_years * (end - start + 1) as u64, "limit": limit, "options_cut": cut,
        "places": places.iter().map(|p| match p { Place::Country(iso) => iso.clone(), Place::Region => "region".to_string() }).collect::<Vec<_>>(),
        "dropped": dropped, "narrow": narrow,
    });
    Ok(Filled { args, event })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dim(id: &str, codes: &[&str]) -> (String, Vec<(String, String)>) {
        (id.to_string(), codes.iter().map(|c| (c.to_string(), format!("label {c}"))).collect())
    }

    fn eurostat(id: &str, dims: Vec<(String, Vec<(String, String)>)>) -> TableMeta {
        TableMeta { id: id.into(), worldbank: false, dims, end_year: Some(2024), places: Vec::new() }
    }

    fn filter(filled: &Filled, dim: &str) -> Option<Vec<String>> {
        filled.args["filters"].as_array().unwrap().iter().find(|f| f["dimension"] == dim).map(|f| {
            f["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
        })
    }

    fn picks(pairs: &[(&str, usize)]) -> BTreeMap<String, usize> {
        pairs.iter().map(|(k, n)| (k.to_string(), *n)).collect()
    }

    #[test]
    fn a_place_breakdown_takes_the_eu_aggregate_and_totals_elsewhere() {
        let mut citizen = vec!["TOTAL", "EU27_2020"];
        citizen.extend(["AF", "SY", "VE", "TR", "CO", "UA", "BD", "PK"]);
        let table = eurostat("migr_asyappctza", vec![
            dim("applicant", &["TOTAL", "FRST", "SSEQ"]),
            dim("age", &["TOTAL", "Y_LT14"]),
            dim("sex", &["T", "M", "F"]),
            dim("geo", &["EU27_2020", "DE", "FR"]),
            dim("unit", &["PER"]),
            dim("citizen", &citizen),
        ]);
        let draft = draft(table, &[]);
        assert!(draft.members.is_empty(), "{:?}", draft.members);
        let k = draft.breakdown.iter().position(|d| d == "citizen").unwrap() + 2;
        let filled = fill(&draft, 1, &picks(&[("t1.breakdown", k), ("t1.years", 1)]), &[Place::Region], 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["EU27_2020"]);
        assert_eq!(filter(&filled, "citizen"), None);
        assert_eq!(filter(&filled, "applicant").unwrap(), ["TOTAL"]);
        assert_eq!(filter(&filled, "sex").unwrap(), ["T"]);
        assert_eq!(filter(&filled, "freq").unwrap(), ["A"]);
        assert_eq!(filled.args["years"], json!({"start": 2024, "end": 2024}));
        assert_eq!(filled.event["open"], "citizen");
    }

    #[test]
    fn an_open_place_dimension_over_the_chart_rows_is_narrowed_to_its_top_codes() {
        let letters: Vec<String> = (b'A'..=b'Z').flat_map(|a| (b'A'..=b'D').map(move |b| format!("{}{}", a as char, b as char))).collect();
        let mut citizen: Vec<&str> = vec!["TOTAL", "EU27_2020", "EXT_EU27_2020", "UNK", "STLS"];
        citizen.extend(letters.iter().map(String::as_str));
        let table = |citizen: &[&str]| {
            eurostat("migr_asyappctza", vec![dim("sex", &["T", "M"]), dim("geo", &["EU27_2020", "DE"]), dim("unit", &["PER"]), dim("citizen", citizen)])
        };
        let one = |citizen: &[&str], years: usize| {
            let draft = draft(table(citizen), &[]);
            let k = draft.breakdown.iter().position(|d| d == "citizen").unwrap() + 2;
            fill(&draft, 1, &picks(&[("t1.breakdown", k), ("t1.years", years)]), &[Place::Region], 2026).unwrap()
        };
        let filled = one(&citizen, 1);
        assert_eq!(filled.args["narrow"], json!({"dimension": "citizen", "rule": "top", "n": 20,
            "exclude": ["EU27_2020", "EXT_EU27_2020", "UNK", "STLS"], "total": "TOTAL"}));
        assert_eq!(filled.event["narrow"]["from_codes"], 109);
        assert_eq!(filled.event["narrow"]["chart_rows"], 80);
        assert_eq!(filter(&filled, "geo").unwrap(), ["EU27_2020"]);
        assert_eq!(one(&citizen, 2).args["narrow"]["n"], 8, "ten years: at most 80 rows over the years");
        assert!(!one(&citizen[..80], 1).args.contains_key("narrow"), "80 codes fit a chart");
        assert!(one(&citizen, 1).event["narrow"]["exclude"].as_array().unwrap().iter().all(|c| c != "TOTAL"));
        let flat: Vec<String> = (0..100).map(|i| format!("C{i:03}")).collect();
        let flat: Vec<&str> = flat.iter().map(String::as_str).collect();
        assert!(!one(&flat, 1).args.contains_key("narrow"), "a dimension that is not of places is left as asked");
    }

    #[test]
    fn the_eu_named_gives_its_members_and_a_measure_with_no_total_is_asked() {
        let table = eurostat("nrg_ind_ren", vec![
            dim("nrg_bal", &["REN", "REN_TRA", "REN_ELC"]),
            dim("geo", &["EU27_2020", "BE", "DE", "EL", "NO"]),
            dim("unit", &["PC"]),
        ]);
        let draft = draft(table, &[]);
        let items = items(1, &draft);
        let keys: Vec<&str> = items.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["t1.years", "t1.breakdown", "t1.nrg_bal"]);
        assert_eq!(lines(&items)[..3], ["   t1.years:", "     1. the latest year only", "     2. the last ten years"]);
        let filled = fill(&draft, 1, &picks(&[("t1.breakdown", 1), ("t1.nrg_bal", 3), ("t1.years", 2)]), &[Place::Region], 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["BE", "DE", "EL"]);
        assert_eq!(filled.event["places"], json!(["region"]));
        assert_eq!(filled.event["dropped"].as_array().unwrap().len(), 24);
        assert_eq!(filter(&filled, "nrg_bal").unwrap(), ["REN_ELC"]);
        assert_eq!(filled.args["years"], json!({"start": 2015, "end": 2024}));
        assert_eq!(filled.event["open"], Value::Null);
    }

    #[test]
    fn a_named_country_is_asked_by_its_eurostat_code_and_a_missing_place_stops() {
        let table = eurostat("t", vec![dim("geo", &["EL", "DE"]), dim("unit", &["PC"])]);
        let d = draft(table, &[]);
        let filled = fill(&d, 1, &BTreeMap::new(), &[Place::Country("GR".into())], 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["EL"]);
        // a named place the table lacks is left out and kept in the event; the others are fetched
        let filled = fill(&d, 1, &BTreeMap::new(), &[Place::Country("DE".into()), Place::Country("JP".into())], 2026).unwrap();
        assert_eq!(filter(&filled, "geo").unwrap(), ["DE"]);
        assert_eq!(filled.event["places"], json!(["DE", "JP"]));
        assert_eq!(filled.event["dropped"], json!(["JP"]));
        let err = fill(&d, 1, &BTreeMap::new(), &[Place::Country("JP".into())], 2026).unwrap_err();
        assert!(err.contains("none of the places"), "{err}");
    }

    #[test]
    fn options_are_at_most_eight_and_the_searched_words_come_first() {
        let codes: Vec<String> = (0..12).map(|i| format!("C{i}")).collect();
        let mut d = dim("siec", &codes.iter().map(String::as_str).collect::<Vec<_>>());
        d.1[10].1 = "Natural gas".into();
        let draft = draft(eurostat("t", vec![d, dim("geo", &["DE"])]), &["natural gas power".into()]);
        let (_, offered, all) = &draft.members[0];
        assert_eq!((offered.len(), *all), (OPTIONS_MAX, 12));
        assert_eq!(offered[0].0, "C10");
        let filled = fill(&draft, 1, &BTreeMap::new(), &[], 2026).unwrap();
        assert_eq!(filled.event["options_cut"]["siec"], json!({"offered": 8, "codes": 12}));
    }

    #[test]
    fn a_total_label_is_offered_first_as_a_whole_and_a_memo_item_never() {
        let mut d = dim("src_crf", &["CRF1A", "TOTXMEMO", "CRF1D1", "TOTX4_MEMO", "CRF_MEMO", "CRF4"]);
        for (i, label) in [(0, "Fuel combustion"), (1, "Total (excluding memo items)"), (2, "International bunkers (memo item)"),
            (3, "Total (excluding LULUCF and memo items)"), (4, "Memo items"), (5, "Land use, land use change, and forestry (LULUCF)")]
        {
            d.1[i].1 = label.into();
        }
        let draft = draft(eurostat("t", vec![d, dim("geo", &["DE"])]), &["fuel combustion".into()]);
        let (_, offered, all) = &draft.members[0];
        let codes: Vec<&str> = offered.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(codes, ["TOTXMEMO", "TOTX4_MEMO", "CRF1A", "CRF4"], "the wholes first, then by search words, no memo item");
        assert_eq!(*all, 6);
        assert!(!total_label("Totally renewable") && total_label("Total") && total_label("Total crop, including fruit"));
    }

    #[test]
    fn world_bank_with_no_place_leaves_the_countries_open_and_cuts_years_over_the_limit() {
        let places: Vec<(String, String)> = (0..2500).map(|i| (format!("X{i}"), format!("X{i:04}"))).collect();
        let table = TableMeta { id: "EN.X@2".into(), worldbank: true, dims: Vec::new(), end_year: None, places };
        let d = draft(table, &[]);
        let filled = fill(&d, 1, &picks(&[("t1.years", 2)]), &[], 2026).unwrap();
        assert_eq!(filled.args["provider"], "worldbank");
        assert_eq!(filled.args["dataset"], "EN.X");
        assert!(filled.args.get("filters").is_none());
        // 2500 countries x 10 years is over 20 000 rows: the latest three years are asked instead.
        assert_eq!(filled.args["years"], json!({"start": 2023, "end": 2025}));
        assert_eq!(filled.event["years_cut"]["limit"], MAX_ROWS_WORLDBANK);
        assert_eq!(filled.event["open"], "country");
    }
}
