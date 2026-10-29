//! Companion tables for one page: after the main table is picked, the program adds up to two more tables of the same topic
//! that add a dimension (D8). No model choice is made here: the candidates come from the catalogue's own folders and
//! indicator families, and a candidate stays only when its fetched rows overlap the main's.
//!
//! The index is built once from the catalogue's original files (`Raw`); `companions` is pure: the caller passes the rows
//! it fetched for the main table and for each candidate, so a candidate that failed to fetch is simply not offered.

use crate::l5geo::{time_freq, toks, wb_unit, Raw};
use std::collections::{BTreeMap, BTreeSet};

/// How many companions one page takes.
pub const MAX_COMPANIONS: usize = 2;

/// Dimensions that say nothing about the topic: sharing one proves nothing, and a table that adds only one of them is the
/// same numbers again (another period, another unit), which is the repeat a companion is there to remove.
const NOT_TOPIC: [&str; 3] = ["time", "freq", "unit"];

/// A dimension that only exists to hold publication vintages: a table with it repeats another table's numbers as first
/// published, not a second measure.
const VINTAGE_DIMS: [&str; 1] = ["release"];

/// A title word the catalogue puts on tables of the weights an index is built from (country weights, item weights): they
/// document how an index is made and carry no story of their own. Plural only: "gross weight" and "birth weight" are
/// measures.
const SUPPORT_TITLE_WORDS: [&str; 1] = ["weights"];

/// The World Bank source the catalogue's indicators are taken from.
const WB_SOURCE: &str = "2";

/// An indicator family shorter than this many segments is a whole subject (NY.GDP, SP.DYN), not a family.
const MIN_STEM_SEGMENTS: usize = 3;

/// Frequencies finer than a year: a table holding only these, beside an annual main of the same family, shows the shape
/// inside the year ("by month").
const FINER_THAN_YEAR: [&str; 5] = ["S", "Q", "M", "W", "D"];

/// Title words that say how often a table is published, not what it counts ("Natural gas imports - annual data" and
/// "... - monthly data", "... - annual aggregated data"): a twin's title without them is the main's.
const FREQUENCY_WORDS: [&str; 10] = [
    "annual", "yearly", "semi", "half", "quarterly", "monthly", "weekly", "daily", "aggregated", "data",
];

/// The share of the best year's shared countries a year must reach to be the overlap year (the latest such year wins), so
/// a page about the latest data is not given a companion year from long ago because one more country reported then.
const YEAR_SHARE_PERCENT: usize = 90;

/// A Eurostat candidate whose title shares less than this much of the main's (idf-weighted, Dice) is another topic of the
/// same folder (a heat-pump table beside a renewable-share table): it is not offered. Set between the off-topic pairs the
/// 10-28 shortlists showed (<= 0.22) and the nearest on-topic one (0.32); the sealed questions test it.
const MIN_TOPIC_SIMILARITY: f64 = 0.30;

/// What a fetched table gives the overlap check: one row per place and year with a value.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub geo: String,
    pub year: i32,
    /// Eurostat: the row's unit code. World Bank: none (the unit is the indicator's, see `wb_unit`).
    pub unit: Option<String>,
    /// A country-level row; an aggregate (EU27_2020, a World Bank region) is false.
    pub country: bool,
    /// A hub table's row (the knowledge group's hub_origin: geo one aggregate, the countries in another dimension): that
    /// dimension, whose code `geo` holds. None for a table placed by its geo. The overlap meets only rows placed alike.
    pub via: Option<String>,
}

/// Why a fetched candidate was not kept: a closed list, so a candidate dropped with no reason cannot be written. It is
/// written as its snake_case name (no_rows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DropWhy {
    /// Its fetch failed, timed out or came back empty.
    NoRows,
    /// No (place, year) of its rows is one of the main's.
    NoSharedPlaceYear,
    /// It shares places and years with the main, but only aggregates.
    NoCountryLevel,
    /// Kept by overlap, but cut by the number of companions a page takes.
    NoRoom,
}

/// How the companion's numbers may sit next to the main's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Axis {
    /// The same unit: one axis is possible; any arithmetic across the two tables is still the program's to record.
    Same,
    /// Different units, or a count against a share: side by side, never on one axis.
    Own,
}

/// The place and year the two tables share.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overlap {
    /// Places with a row in both tables in `year`, countries only.
    pub countries: usize,
    /// Aggregate places in both tables in `year`: they count, but cannot carry the overlap alone.
    pub aggregates: usize,
    /// The latest year in which the two tables share at least YEAR_SHARE_PERCENT of the most countries any year shares.
    pub year: i32,
}

/// One companion offered to the page.
#[derive(Clone, Debug, PartialEq)]
pub struct Companion {
    pub id: String,
    /// The dimensions it has that the main lacks (Eurostat). A World Bank sibling adds a split, not a dimension: empty.
    pub adds: Vec<String>,
    /// Set for a twin of the main in another, finer frequency: the frequency ("M"). Its rows' years are the months' years.
    pub grain: Option<&'static str>,
    pub overlap: Overlap,
    pub axis: Axis,
}

/// A table the program offers to fetch as a companion, before any fetch.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub adds: Vec<String>,
    pub grain: Option<&'static str>,
}

/// The catalogue's folders and dimensions, read once.
pub struct CompanionIndex {
    /// Eurostat table -> its folder path in the TOC.
    folder: BTreeMap<String, String>,
    by_folder: BTreeMap<String, Vec<String>>,
    /// A folder's parent path -> the tables of all its folders: the TOC puts some annual and monthly forms in sibling
    /// folders ("Natural gas - annual data" beside "... - monthly data").
    by_parent: BTreeMap<String, Vec<String>>,
    /// Eurostat table -> its dimensions but the NOT_TOPIC ones.
    dims: BTreeMap<String, BTreeSet<String>>,
    /// World Bank indicator ids, with the "@2" the catalogue ids carry.
    wb: Vec<String>,
    /// Eurostat table -> the frequencies its metabase time codes hold.
    freqs: BTreeMap<String, BTreeSet<&'static str>>,
    /// Eurostat table -> how many time codes its metabase lists (a longer series first when two tables tie).
    periods: BTreeMap<String, usize>,
    /// Eurostat table -> the words of its TOC title (l5geo's `toks`), and each word's idf over all the titles: the topic
    /// similarity reads the catalogue's own words, no hand-written list.
    title_words: BTreeMap<String, BTreeSet<String>>,
    /// Eurostat table -> the words of its TOC title in order, without FREQUENCY_WORDS: two tables with the same are one
    /// quantity published at two frequencies.
    quantity: BTreeMap<String, Vec<String>>,
    /// Tables that document another table (vintages, index weights): never offered as a companion.
    support: BTreeSet<String>,
    idf: BTreeMap<String, f64>,
}

/// The TOC path a folder sits in ("" for a top folder).
fn parent(folder: &str) -> &str {
    folder.rsplit_once(" / ").map_or("", |(p, _)| p)
}

fn unquote(f: &str) -> &str {
    f.strip_prefix('"')
        .and_then(|f| f.strip_suffix('"'))
        .unwrap_or(f)
}

impl CompanionIndex {
    pub fn from_raw(raw: &Raw) -> CompanionIndex {
        let mut folder = BTreeMap::new();
        let mut by_folder: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut title_words: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut quantity: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut support: BTreeSet<String> = BTreeSet::new();
        let mut stack: Vec<String> = Vec::new();
        for line in raw.toc.lines().skip(1) {
            let r: Vec<&str> = line.split('\t').map(unquote).collect();
            if r.len() < 3 {
                continue;
            }
            let depth = (r[0].len() - r[0].trim_start_matches(' ').len()) / 4;
            stack.truncate(depth);
            if r[2] == "folder" {
                stack.push(r[0].trim().to_string());
                continue;
            }
            // The first TOC entry of a table wins, as the catalogue's own documents do.
            if folder.contains_key(r[1]) {
                continue;
            }
            let path = stack.join(" / ");
            if r[0]
                .to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .any(|w| SUPPORT_TITLE_WORDS.contains(&w))
            {
                support.insert(r[1].to_string());
            }
            let words = toks(r[0].trim());
            quantity.insert(
                r[1].to_string(),
                words.iter().filter(|w| !FREQUENCY_WORDS.contains(&w.as_str())).cloned().collect(),
            );
            title_words.insert(r[1].to_string(), words.into_iter().collect());
            folder.insert(r[1].to_string(), path.clone());
            by_folder.entry(path).or_default().push(r[1].to_string());
        }
        let mut by_parent: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (path, tables) in &by_folder {
            by_parent.entry(parent(path).to_string()).or_default().extend(tables.iter().cloned());
        }
        let mut dims: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut freqs: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
        let mut periods: BTreeMap<String, usize> = BTreeMap::new();
        for line in raw.metabase.lines() {
            let mut p = line.split('\t');
            if let (Some(t), Some(d), Some(c)) = (p.next(), p.next(), p.next()) {
                if !folder.contains_key(t) {
                    continue;
                }
                if d == "time" {
                    *periods.entry(t.to_string()).or_default() += 1;
                    if let Some(f) = time_freq(c) {
                        freqs.entry(t.to_string()).or_default().insert(f);
                    }
                } else if !NOT_TOPIC.contains(&d) {
                    if VINTAGE_DIMS.contains(&d) {
                        support.insert(t.to_string());
                    }
                    dims.entry(t.to_string()).or_default().insert(d.to_string());
                }
            }
        }
        let wb = raw
            .wb_indicators
            .get(1)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter(|i| i["source"]["id"].as_str() == Some(WB_SOURCE))
                    .filter_map(|i| i.get("id").and_then(|id| id.as_str()))
                    .map(|id| format!("{id}@2"))
                    .collect()
            })
            .unwrap_or_default();
        CompanionIndex {
            folder,
            by_folder,
            by_parent,
            dims,
            wb,
            freqs,
            periods,
            idf: {
                let mut df: BTreeMap<&str, usize> = BTreeMap::new();
                for w in title_words.values().flatten() {
                    *df.entry(w).or_default() += 1;
                }
                let n = title_words.len() as f64;
                df.into_iter()
                    .map(|(w, d)| (w.to_string(), (1.0 + n / d as f64).ln()))
                    .collect()
            },
            title_words,
            quantity,
            support,
        }
    }

    /// The tables worth fetching as companions of `main`, before any fetch. Eurostat: same TOC folder, at least one
    /// dimension in common and at least one the main lacks. World Bank: the same indicator family (the id without its
    /// last two segments, as SP.POP.65UP for SP.POP.65UP.TO.ZS), which adds a split, not a dimension. And, for an annual
    /// Eurostat main, a twin in its folder or a sibling folder with the same dimensions, a finer frequency only (by month)
    /// and the main's title but its frequency words: the same quantity, not another one of the same shape.
    pub fn candidates<'a>(&'a self, main: &'a str) -> Vec<Candidate> {
        if let Some(own) = main.strip_suffix("@2") {
            let stem = match own.rsplitn(3, '.').nth(2) {
                Some(s) if s.split('.').count() >= MIN_STEM_SEGMENTS => format!("{s}."),
                _ => return Vec::new(),
            };
            return self
                .wb
                .iter()
                .filter(|id| id.as_str() != main && id.starts_with(&stem))
                .map(|id| Candidate {
                    id: id.clone(),
                    adds: Vec::new(),
                    grain: None,
                })
                .collect();
        }
        let (Some(folder), Some(mine)) = (self.folder.get(main), self.dims.get(main)) else {
            return Vec::new();
        };
        let annual_main = self
            .freqs
            .get(main)
            .is_some_and(|f| f.len() == 1 && f.contains("A"));
        let others = |pool: &'a [String]| {
            pool.iter()
                .filter(move |t| t.as_str() != main && !self.support.contains(*t))
                .filter_map(move |t| Some((t, self.dims.get(t)?)))
        };
        let adds = others(&self.by_folder[folder]).filter_map(|(t, theirs)| {
            let adds: Vec<String> = theirs.difference(mine).cloned().collect();
            (theirs.intersection(mine).next().is_some() && !adds.is_empty()).then(|| Candidate {
                id: t.clone(),
                adds,
                grain: None,
            })
        });
        let twins = others(&self.by_parent[parent(folder)])
            .filter(|_| annual_main)
            .filter(|(t, theirs)| *theirs == mine && self.quantity(main) == self.quantity(t))
            .filter_map(|(t, _)| {
                let finer = self.freqs.get(t)?;
                let grain = FINER_THAN_YEAR.iter().copied().find(|f| finer.contains(f))?;
                finer.iter().all(|f| FINER_THAN_YEAR.contains(f)).then(|| Candidate {
                    id: t.clone(),
                    adds: Vec::new(),
                    grain: Some(grain),
                })
            });
        adds.chain(twins).collect()
    }
}

impl CompanionIndex {
    /// The table's title words without FREQUENCY_WORDS; None for a table not in the TOC.
    fn quantity(&self, id: &str) -> Option<&Vec<String>> {
        self.quantity.get(id)
    }

    /// How much of its title the candidate shares with the main's, idf-weighted (Dice); None when either title is not in the
    /// index (World Bank ids), which neither filters nor ranks.
    pub fn topic(&self, main: &str, other: &str) -> Option<f64> {
        let (a, b) = (self.title_words.get(main)?, self.title_words.get(other)?);
        let w = |set: &BTreeSet<String>| set.iter().map(|x| self.idf[x]).sum::<f64>();
        let shared: f64 = a.intersection(b).map(|x| self.idf[x]).sum();
        let total = w(a) + w(b);
        (total > 0.0).then(|| 2.0 * shared / total)
    }

    /// The candidates worth a fetch: ranked from what the catalogue already says, cut to `MAX_COMPANIONS` before any
    /// download; a Eurostat table whose title shares too little with the main's is left out (MIN_TOPIC_SIMILARITY), and
    /// the rest rank by that similarity first. A by-month twin first (it shows the shape inside the year, which no added dimension does). Eurostat: the
    /// most added dimensions, then the most shared ones. World Bank: an indicator with a registered
    /// unit of the main's kind first (a share beside a share), then one with any registered unit; the catalogue lists no
    /// years or country counts, so those cannot rank. Ties by id.
    pub fn shortlist(&self, main: &str) -> Vec<Candidate> {
        let mine = self.dims.get(main);
        let kind = wb_kind;
        let main_kind = kind(main);
        let mut found = self.candidates(main);
        found.retain(|c| {
            self.topic(main, &c.id)
                .is_none_or(|t| t >= MIN_TOPIC_SIMILARITY)
        });
        found.sort_by_cached_key(|Candidate { id, adds, grain }| {
            let shared = match (mine, self.dims.get(id)) {
                (Some(m), Some(t)) => m.intersection(t).count(),
                _ => 0,
            };
            let unit_rank = match (kind(id), main_kind) {
                (Some(k), Some(m)) if k == m => 0,
                (Some(_), _) => 1,
                (None, _) => 2,
            };
            // Between two tables that tie, the one that matches the main's frequency, then the longer series.
            let other_freq = self.freqs.get(id) != self.freqs.get(main);
            let topic = (self.topic(main, id).unwrap_or(0.0) * 1000.0) as i64;
            (
                grain.is_none(),
                std::cmp::Reverse(topic),
                unit_rank,
                std::cmp::Reverse(adds.len()),
                std::cmp::Reverse(shared),
                other_freq,
                std::cmp::Reverse(self.periods.get(id).copied().unwrap_or(0)),
                id.clone(),
            )
        });
        // One by-month twin is enough: a second one is the same shape again and would spend the other place.
        let mut twin_seen = false;
        found.retain(|c| c.grain.is_none() || !std::mem::replace(&mut twin_seen, true));
        // Two tables with the same topic dimensions and different frequencies (an annual and a monthly form) are one topic:
        // the first stays, the other would spend the second place on the same thing. Same dimensions and the same
        // frequencies are two different measures (a current account and an IIP table): both stay.
        let mut kept: Vec<(&BTreeSet<String>, Option<&BTreeSet<&'static str>>)> = Vec::new();
        found.retain(|c| match (c.grain, self.dims.get(&c.id)) {
            (None, Some(d)) if !c.adds.is_empty() => {
                let f = self.freqs.get(&c.id);
                let twin_form = kept.iter().any(|(kd, kf)| *kd == d && *kf != f);
                if !twin_form {
                    kept.push((d, f));
                }
                !twin_form
            }
            _ => true,
        });
        found.truncate(MAX_COMPANIONS);
        found
    }
}

/// The overlap of two tables' rows, or None when no country-level row is shared: aggregates count but cannot carry it.
pub fn overlap(main: &[Row], other: &[Row]) -> Option<Overlap> {
    let mine: BTreeSet<_> = main.iter().map(place_year).collect();
    let mut by_year: BTreeMap<i32, (BTreeSet<&str>, BTreeSet<&str>)> = BTreeMap::new();
    for r in other.iter().filter(|r| mine.contains(&place_year(r))) {
        let e = by_year.entry(r.year).or_default();
        if r.country {
            e.0.insert(r.geo.as_str());
        } else {
            e.1.insert(r.geo.as_str());
        }
    }
    let best = by_year.values().map(|(c, _)| c.len()).max()?;
    by_year
        .into_iter()
        .filter(|(_, (c, _))| !c.is_empty() && c.len() * 100 >= best * YEAR_SHARE_PERCENT)
        .max_by_key(|(y, _)| *y)
        .map(|(year, (c, a))| Overlap {
            countries: c.len(),
            aggregates: a.len(),
            year,
        })
}

/// The registry of World Bank units (the file l5geo's `wb_unit` reads), read here for the measure kind alone: a row with an
/// empty unit code (AG.LND.ARBL.HA.PC) still says it is a rate, which `wb_unit` does not return.
const WB_UNITS: &str = include_str!("../runtime/pi/assets/wb-units.tsv");

/// The measure kind wb-units.tsv registers for an indicator (with or without its "@2"); None for no row or an empty kind.
fn wb_kind(id: &str) -> Option<&'static str> {
    let id = id.strip_suffix("@2").unwrap_or(id);
    WB_UNITS.lines().skip(1).find_map(|line| {
        let mut p = line.split('\t');
        let indicator = p.next()?;
        let kind = p.nth(3)?;
        (indicator == id && !kind.is_empty()).then_some(kind)
    })
}

fn units(rows: &[Row]) -> BTreeSet<&str> {
    rows.iter().filter_map(|r| r.unit.as_deref()).collect()
}

/// Whether the two tables' numbers can share an axis: Eurostat when each side's rows hold exactly one unit code and the
/// two match, World Bank by the unit the registry gives each indicator (a share and a count never do).
fn axis(main: &str, other: &str, main_rows: &[Row], other_rows: &[Row]) -> Axis {
    let same = if main.ends_with("@2") {
        match (wb_unit(main), wb_unit(other)) {
            (Some(a), Some(b)) => a.code == b.code,
            _ => false,
        }
    } else {
        let (a, b) = (units(main_rows), units(other_rows));
        a.len() == 1 && a == b
    };
    if same {
        Axis::Same
    } else {
        Axis::Own
    }
}

/// The main table's companions, at most `MAX_COMPANIONS`, fetched only for the shortlist (the caller also bounds the time
/// the whole fetch may take). `rows` gives the fetched rows of a table, None when its fetch
/// failed, timed out or came back empty: such a candidate is dropped, never read as no overlap. With no rows for the
/// main table nothing is offered. Best first: most shared countries, then most added dimensions, then the id. Each
/// shortlisted candidate not kept comes back beside them with why (none when the main has no rows).
pub fn companions(
    index: &CompanionIndex,
    main: &str,
    rows: &dyn Fn(&str) -> Option<Vec<Row>>,
) -> (Vec<Companion>, Vec<(String, DropWhy)>) {
    let Some(main_rows) = rows(main) else {
        return (Vec::new(), Vec::new());
    };
    let mut dropped = Vec::new();
    let mut found: Vec<Companion> = index
        .shortlist(main)
        .into_iter()
        .filter_map(|Candidate { id, adds, grain }| {
            let Some(theirs) = rows(&id) else {
                dropped.push((id, DropWhy::NoRows));
                return None;
            };
            let Some(overlap) = overlap(&main_rows, &theirs) else {
                let shared = overlap_places(&main_rows, &theirs);
                dropped.push((id, if shared { DropWhy::NoCountryLevel } else { DropWhy::NoSharedPlaceYear }));
                return None;
            };
            let axis = axis(main, &id, &main_rows, &theirs);
            Some(Companion {
                id,
                adds,
                grain,
                overlap,
                axis,
            })
        })
        .collect();
    found.sort_by(|a, b| {
        a.grain
            .is_none()
            .cmp(&b.grain.is_none())
            .then(b.overlap.countries.cmp(&a.overlap.countries))
            .then(b.adds.len().cmp(&a.adds.len()))
            .then(a.id.cmp(&b.id))
    });
    dropped.extend(found.drain(found.len().min(MAX_COMPANIONS)..).map(|c| (c.id, DropWhy::NoRoom)));
    (found, dropped)
}

/// A row's place, as placed (its `via`), and year: what the overlap matches on.
fn place_year(r: &Row) -> (Option<&str>, &str, i32) {
    (r.via.as_deref(), r.geo.as_str(), r.year)
}

/// Whether the two tables share any (place, year), aggregates included.
fn overlap_places(main: &[Row], other: &[Row]) -> bool {
    let mine: BTreeSet<_> = main.iter().map(place_year).collect();
    other.iter().any(|r| mine.contains(&place_year(r)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw() -> Raw {
        let toc = "\"title\"\t\"code\"\t\"type\"\n\
                   \"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"    Energy\"\t\"nrg\"\t\"folder\"\n\
                   \"        Natural gas imports by partner annual data\"\t\"gas_a\"\t\"table\"\n\
                   \"        Natural gas balance by partner annual data\"\t\"gas_b\"\t\"table\"\n\
                   \"        Gas stock\"\t\"gas_c\"\t\"table\"\n\
                   \"        Natural gas imports in another unit\"\t\"gas_d\"\t\"table\"\n\
                   \"        Natural gas imports by partner monthly data\"\t\"gas_m\"\t\"table\"\n\
                   \"    Trade\"\t\"ext\"\t\"folder\"\n\
                   \"        Trade by partner\"\t\"trd_a\"\t\"table\"\n";
        let metabase = "gas_a\tgeo\tAT\ngas_a\tpartner\tRU\ngas_a\ttime\t2024\n\
                        gas_b\tgeo\tAT\ngas_b\tnrg_bal\tIC\ngas_b\ttime\t2024\n\
                        gas_c\ttime\t2024\ngas_c\tnrg_bal\tST\n\
                        gas_d\tgeo\tAT\ngas_d\tunit\tPC\ngas_d\tfreq\tM\n\
                        gas_m\tgeo\tAT\ngas_m\tpartner\tRU\ngas_m\ttime\t2024M01\ngas_m\ttime\t2024M02\n\
                        trd_a\tgeo\tAT\ntrd_a\tpartner\tCN\n";
        Raw {
            toc: toc.into(),
            metabase: metabase.into(),
            cl: Vec::new(),
            wb_indicators: json!([{}, [
                {"id": "SP.POP.65UP.TO.ZS", "source": {"id": "2"}},
                {"id": "SP.POP.65UP.FE.ZS", "source": {"id": "2"}},
                {"id": "SP.POP.65UP.MF.ZS", "source": {"id": "57"}},
                {"id": "SP.POP.65UP.TO", "source": {"id": "2"}},
                {"id": "SP.POP.TOTL", "source": {"id": "2"}},
                {"id": "NY.GDP.MKTP.CD", "source": {"id": "2"}},
                {"id": "NY.GDP.PCAP.CD", "source": {"id": "2"}}
            ]]),
            wb_countries: json!([]),
            wb_countries_zh: json!([]),
            nuts: String::new(),
        }
    }

    fn row(geo: &str, year: i32, country: bool) -> Row {
        Row {
            geo: geo.into(),
            year,
            unit: Some("MIO_M3".into()),
            country,
            via: None,
        }
    }

    #[test]
    fn eurostat_candidates_share_a_dim_and_add_one_in_the_same_folder() {
        let index = CompanionIndex::from_raw(&raw());
        // gas_b shares geo and adds nrg_bal; gas_c shares nothing but time; gas_d adds only freq and unit; gas_m is the
        // monthly twin of the annual gas_a; trd_a is another folder.
        let found = index.candidates("gas_a");
        assert_eq!(
            found,
            vec![
                Candidate {
                    id: "gas_b".into(),
                    adds: vec!["nrg_bal".into()],
                    grain: None
                },
                Candidate {
                    id: "gas_m".into(),
                    adds: vec![],
                    grain: Some("M")
                }
            ]
        );
        // The twin comes first on the shortlist; a second twin of the same main would be cut; a monthly main gets no twin.
        assert_eq!(index.shortlist("gas_a")[0].id, "gas_m");
        assert!(index.candidates("gas_m").iter().all(|c| c.grain.is_none()));
        assert!(index.candidates("unknown").is_empty());
    }

    #[test]
    fn only_one_by_month_twin_is_shortlisted() {
        let mut two = raw();
        two.toc = two.toc.replace(
            "\"    Trade\"",
            "\"        Natural gas imports by partner, monthly data\"\t\"gas_n\"\t\"table\"\n\"    Trade\"",
        );
        two.metabase
            .push_str("gas_n\tgeo\tAT\ngas_n\tpartner\tRU\ngas_n\ttime\t2024M05\n");
        let index = CompanionIndex::from_raw(&two);
        assert_eq!(
            index
                .candidates("gas_a")
                .iter()
                .filter(|c| c.grain.is_some())
                .count(),
            2
        );
        let list = index.shortlist("gas_a");
        assert_eq!(list.iter().filter(|c| c.grain.is_some()).count(), 1);
        assert_eq!(list.len(), MAX_COMPANIONS);
    }

    /// The TOC puts some annual and monthly forms in sibling folders: a twin there is offered when its title is the main's
    /// but its frequency words. A finer table of the same dimensions with another title is another quantity, in the
    /// main's folder too; one in a folder that is no sibling is not looked at.
    #[test]
    fn a_twin_is_the_same_title_in_the_folder_or_a_sibling_folder() {
        let mut split = raw();
        split.toc = split.toc.replace(
            "\"    Trade\"",
            "\"    Natural gas\"\t\"ng\"\t\"folder\"\n\
             \"        Natural gas - annual data\"\t\"nga\"\t\"folder\"\n\
             \"            Natural gas exports - annual data\"\t\"gx_a\"\t\"table\"\n\
             \"            Natural gas exports by sector - monthly data\"\t\"gx_s\"\t\"table\"\n\
             \"        Natural gas - monthly data\"\t\"ngm\"\t\"folder\"\n\
             \"            Natural gas exports - monthly data\"\t\"gx_m\"\t\"table\"\n\
             \"            Natural gas stocks - monthly data\"\t\"gs_m\"\t\"table\"\n\
             \"    Trade\"",
        );
        split.toc.push_str("\"        Natural gas exports - quarterly data\"\t\"gx_q\"\t\"table\"\n");
        for id in ["gx_a", "gx_s", "gx_m", "gs_m", "gx_q"] {
            let time = if id == "gx_a" { "2024" } else if id == "gx_q" { "2024Q1" } else { "2024M01" };
            split.metabase.push_str(&format!("{id}\tgeo\tAT\n{id}\tpartner\tRU\n{id}\ttime\t{time}\n"));
        }
        let index = CompanionIndex::from_raw(&split);
        let twins: Vec<(String, Option<&str>)> =
            index.candidates("gx_a").into_iter().map(|c| (c.id, c.grain)).collect();
        assert_eq!(twins, vec![("gx_m".to_string(), Some("M"))]);
        // In one folder the title gate holds as well: gas_n has gas_a's dimensions, a finer frequency and another title.
        let mut one = raw();
        one.toc = one.toc.replace("\"    Trade\"", "\"        Natural gas stocks, monthly data\"\t\"gas_n\"\t\"table\"\n\"    Trade\"");
        one.metabase.push_str("gas_n\tgeo\tAT\ngas_n\tpartner\tRU\ngas_n\ttime\t2024M05\n");
        let twins: Vec<String> = CompanionIndex::from_raw(&one)
            .candidates("gas_a")
            .into_iter()
            .filter(|c| c.grain.is_some())
            .map(|c| c.id)
            .collect();
        assert_eq!(twins, vec!["gas_m"]);
    }

    #[test]
    fn the_longer_series_wins_between_twins_and_one_of_two_frequency_forms_stays() {
        let mut more = raw();
        // gas_n (smaller id than gas_m) is a monthly twin with fewer time codes; gas_x and gas_y are one topic (nrg_bal,
        // geo) in an annual and a monthly form; gas_x has the lower id but the monthly gas_y is longer.
        more.toc = more.toc.replace(
            "\"    Trade\"",
            "\"        Natural gas imports by partner - monthly data\"\t\"gas_ln\"\t\"table\"\n\
             \"        Natural gas imports by partner annual data withdrawals\"\t\"gas_wa\"\t\"table\"\n\
             \"        Natural gas imports by partner monthly data withdrawals\"\t\"gas_wm\"\t\"table\"\n\"    Trade\"",
        );
        more.metabase.push_str(
            "gas_ln\tgeo\tAT\ngas_ln\tpartner\tRU\ngas_ln\ttime\t2024M05\n\
             gas_wa\tgeo\tAT\ngas_wa\twithdraw\tX\ngas_wa\ttime\t2023\ngas_wa\ttime\t2024\n\
             gas_wm\tgeo\tAT\ngas_wm\twithdraw\tX\ngas_wm\ttime\t2024M01\ngas_wm\ttime\t2024M02\n\
             gas_wm\ttime\t2024M03\ngas_wm\ttime\t2024M04\n",
        );
        let index = CompanionIndex::from_raw(&more);
        let twins: Vec<String> = index
            .candidates("gas_a")
            .into_iter()
            .filter(|c| c.grain.is_some())
            .map(|c| c.id)
            .collect();
        assert_eq!(twins, vec!["gas_m", "gas_ln"]);
        // gas_m has 2 time codes, gas_ln 1: the longer series is the one twin kept, though its id is later.
        let list = index.shortlist("gas_a");
        assert_eq!(list[0].id, "gas_m");
        // The two withdrawal forms are one topic and, like gas_b, they add a dimension: gas_wa (the main's frequency) stays.
        let rest: Vec<&str> = list[1..].iter().map(|c| c.id.as_str()).collect();
        assert_eq!(rest, vec!["gas_wa"]);
        let all: Vec<String> = index
            .candidates("gas_a")
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert!(all.contains(&"gas_wa".to_string()) && all.contains(&"gas_wm".to_string()));
    }

    #[test]
    fn a_table_of_another_topic_is_left_out_and_the_rest_rank_by_topic() {
        let mut other = raw();
        // wind_a shares geo and adds a dimension but its title shares nothing with the main's.
        other.toc = other.toc.replace(
            "\"    Trade\"",
            "\"        Wind turbine blade statistics\"\t\"wind_a\"\t\"table\"\n\"    Trade\"",
        );
        other
            .metabase
            .push_str("wind_a\tgeo\tAT\nwind_a\tblade\tX\nwind_a\ttime\t2024\n");
        let index = CompanionIndex::from_raw(&other);
        assert!(index.candidates("gas_a").iter().any(|c| c.id == "wind_a"));
        assert!(index.topic("gas_a", "wind_a").unwrap() < MIN_TOPIC_SIMILARITY);
        assert!(index.topic("gas_a", "gas_b").unwrap() >= MIN_TOPIC_SIMILARITY);
        let ids: Vec<String> = index.shortlist("gas_a").into_iter().map(|c| c.id).collect();
        assert!(!ids.contains(&"wind_a".to_string()));
        assert_eq!(index.topic("gas_a", "SP.POP.65UP.TO.ZS@2"), None);
    }

    #[test]
    fn vintage_and_index_weight_tables_are_never_companions_but_a_gross_weight_measure_stays() {
        let mut other = raw();
        other.toc = other.toc.replace(
            "\"    Trade\"",
            "\"        Natural gas imports first published data\"\t\"gas_fp\"\t\"table\"\n\
             \"        Natural gas imports country weights\"\t\"gas_cw\"\t\"table\"\n\
             \"        Natural gas imports item weights\"\t\"gas_iw\"\t\"table\"\n\
             \"        Natural gas imports gross weight by mode\"\t\"gas_gw\"\t\"table\"\n\
             \"    Trade\"",
        );
        other.metabase.push_str(
            "gas_fp\tgeo\tAT\ngas_fp\tpartner\tRU\ngas_fp\trelease\tFIN\ngas_fp\ttime\t2024M01\n\
             gas_cw\tgeo\tAT\ngas_cw\tstatinfo\tCOWEU\ngas_cw\ttime\t2024\n\
             gas_iw\tgeo\tAT\ngas_iw\tnrg_bal\tIC\ngas_iw\ttime\t2024\n\
             gas_gw\tgeo\tAT\ngas_gw\tmode\tPIPE\ngas_gw\ttime\t2024\n",
        );
        let index = CompanionIndex::from_raw(&other);
        let ids: Vec<String> = index
            .candidates("gas_a")
            .into_iter()
            .map(|c| c.id)
            .collect();
        for gone in ["gas_fp", "gas_cw", "gas_iw"] {
            assert!(!ids.contains(&gone.to_string()), "{gone} offered");
        }
        assert!(ids.contains(&"gas_gw".to_string()));
        assert!(ids.contains(&"gas_b".to_string()));
    }

    #[test]
    fn a_dropped_frequency_form_is_not_what_later_tables_are_compared_with() {
        let mut small = raw();
        small.toc = "\"title\"\t\"code\"\t\"type\"\n\"Themes\"\t\"data\"\t\"folder\"\n\
            \"    Gas\"\t\"nrg\"\t\"folder\"\n\
            \"        Gas imports by partner annual data\"\t\"x_m\"\t\"table\"\n\
            \"        Gas imports by partner and balance annual data\"\t\"x_a\"\t\"table\"\n\
            \"        Gas imports by partner and balance monthly data\"\t\"x_c\"\t\"table\"\n\
            \"        Gas imports by partner and balance net of stock changes and losses annual data\"\t\"x_d\"\t\"table\"\n"
            .into();
        small.metabase = "x_m\tgeo\tAT\nx_m\ttime\t2024\n\
            x_a\tgeo\tAT\nx_a\tnrg_bal\tIC\nx_a\ttime\t2024\n\
            x_c\tgeo\tAT\nx_c\tnrg_bal\tIC\nx_c\ttime\t2024M01\n\
            x_d\tgeo\tAT\nx_d\tnrg_bal\tIC\nx_d\ttime\t2024\n"
            .into();
        let index = CompanionIndex::from_raw(&small);
        let ids: Vec<String> = index.shortlist("x_m").into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["x_a", "x_d"]);
    }

    #[test]
    fn same_dims_same_frequencies_are_two_measures_both_stay_but_two_forms_are_one() {
        let mut small = raw();
        small.toc = "\"title\"\t\"code\"\t\"type\"\n\"Themes\"\t\"data\"\t\"folder\"\n\
            \"    Trade\"\t\"ext\"\t\"folder\"\n\
            \"        Current account quarterly data\"\t\"m_a\"\t\"table\"\n\
            \"        Financial account quarterly data\"\t\"m_b\"\t\"table\"\n\
            \"        Current account primary income quarterly data\"\t\"m_c\"\t\"table\"\n\
            \"        Financial account monthly data\"\t\"m_d\"\t\"table\"\n"
            .into();
        small.metabase = "m_a\tgeo\tAT\nm_a\ttime\t2024Q1\n\
            m_b\tgeo\tAT\nm_b\tcurrency\tEUR\nm_b\ttime\t2024Q1\n\
            m_c\tgeo\tAT\nm_c\tcurrency\tEUR\nm_c\ttime\t2024Q1\n\
            m_d\tgeo\tAT\nm_d\tcurrency\tEUR\nm_d\ttime\t2024M01\n"
            .into();
        let index = CompanionIndex::from_raw(&small);
        // m_b and m_c: same dims, same frequency, two different measures: both stay. m_d is the monthly form of the same
        // dims as m_b (frequency differs): the third place would be a repeat, so only the cap of two is in play here.
        let ids: Vec<String> = index.shortlist("m_a").into_iter().map(|c| c.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"m_b".to_string()) && ids.contains(&"m_c".to_string()));
        assert!(!ids.contains(&"m_d".to_string()));
    }

    #[test]
    fn a_main_table_is_never_its_own_companion() {
        let index = CompanionIndex::from_raw(&raw());
        let rows = |_: &str| Some(vec![row("AT", 2024, true)]);
        for main in ["gas_a", "gas_m", "SP.POP.65UP.TO.ZS@2"] {
            assert!(index.candidates(main).iter().all(|c| c.id != main));
            assert!(index.shortlist(main).iter().all(|c| c.id != main));
            assert!(companions(&index, main, &rows).0.iter().all(|c| c.id != main));
        }
    }

    #[test]
    fn the_overlap_year_is_the_latest_with_nearly_the_best_country_count() {
        let mut main = Vec::new();
        let mut other = Vec::new();
        // 2019: 10 shared countries; 2025: 9 (90% of 10, so it counts); 2024: 8 (does not).
        for (year, n) in [(2019, 10), (2024, 8), (2025, 9)] {
            for i in 0..n {
                main.push(row(&format!("C{i}"), year, true));
                other.push(row(&format!("C{i}"), year, true));
            }
        }
        assert_eq!(overlap(&main, &other).unwrap().year, 2025);
        // 8 of 10 in the latest year is below the share: 2019 stays.
        let short: Vec<Row> = other.iter().filter(|r| r.year != 2025).cloned().collect();
        let mut main8 = main.clone();
        main8.extend((0..8).map(|i| row(&format!("C{i}"), 2025, true)));
        let mut other8 = short;
        other8.extend((0..8).map(|i| row(&format!("C{i}"), 2025, true)));
        assert_eq!(overlap(&main8, &other8).unwrap().year, 2019);
    }

    #[test]
    fn worldbank_candidates_are_the_indicator_family() {
        let index = CompanionIndex::from_raw(&raw());
        let ids: Vec<String> = index
            .candidates("SP.POP.65UP.TO.ZS@2")
            .into_iter()
            .map(|c| {
                assert!(c.adds.is_empty() && c.grain.is_none());
                c.id
            })
            .collect();
        // MF.ZS is World Bank source 57, not the catalogue's source 2.
        assert_eq!(ids, vec!["SP.POP.65UP.FE.ZS@2", "SP.POP.65UP.TO@2"]);
        // A family under three segments (NY.GDP) is a whole subject: no candidates.
        assert!(index.candidates("NY.GDP.MKTP.CD@2").is_empty());
        assert!(index.candidates("SP.POP.TOTL@2").is_empty());
    }

    #[test]
    fn on_the_registered_units_the_q5_shortlist_is_the_two_sex_shares() {
        // A registry row with an empty unit code still ranks by its measure kind (FE.ZS and MA.ZS have no code).
        let mut real = raw();
        real.wb_indicators = json!([{}, [
            {"id": "SP.POP.65UP.TO.ZS", "source": {"id": "2"}},
            {"id": "SP.POP.65UP.FE.IN", "source": {"id": "2"}},
            {"id": "SP.POP.65UP.FE.ZS", "source": {"id": "2"}},
            {"id": "SP.POP.65UP.MA.IN", "source": {"id": "2"}},
            {"id": "SP.POP.65UP.MA.ZS", "source": {"id": "2"}},
            {"id": "SP.POP.65UP.TO", "source": {"id": "2"}}
        ]]);
        let ids: Vec<String> = CompanionIndex::from_raw(&real)
            .shortlist("SP.POP.65UP.TO.ZS@2")
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["SP.POP.65UP.FE.ZS@2", "SP.POP.65UP.MA.ZS@2"]);
    }

    #[test]
    fn the_shortlist_is_cut_before_any_fetch() {
        let index = CompanionIndex::from_raw(&raw());
        assert_eq!(index.candidates("SP.POP.65UP.TO.ZS@2").len(), 2);
        let mut many = raw();
        many.wb_indicators = json!([{}, [
            {"id": "A.B.C.D.E", "source": {"id": "2"}}, {"id": "A.B.C.D.F", "source": {"id": "2"}},
            {"id": "A.B.C.D.G", "source": {"id": "2"}}, {"id": "A.B.C.D.H", "source": {"id": "2"}}
        ]]);
        let index = CompanionIndex::from_raw(&many);
        assert_eq!(index.candidates("A.B.C.D.E@2").len(), 3);
        assert_eq!(index.shortlist("A.B.C.D.E@2").len(), MAX_COMPANIONS);
    }

    #[test]
    fn aggregates_count_but_cannot_carry_the_overlap() {
        let main = [row("EU27_2020", 2024, false), row("AT", 2023, true)];
        let only_aggregate = [row("EU27_2020", 2024, false)];
        assert_eq!(overlap(&main, &only_aggregate), None);
        let both = [row("EU27_2020", 2024, false), row("AT", 2023, true)];
        assert_eq!(
            overlap(&main, &both),
            Some(Overlap {
                countries: 1,
                aggregates: 0,
                year: 2023
            })
        );
    }

    #[test]
    fn a_failed_fetch_drops_the_companion_and_no_main_rows_offers_nothing() {
        let index = CompanionIndex::from_raw(&raw());
        let ok = |t: &str| (t == "gas_a" || t == "gas_b").then(|| vec![row("AT", 2024, true)]);
        let found = companions(&index, "gas_a", &ok).0;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "gas_b");
        assert_eq!(found[0].axis, Axis::Same);
        let failed = |t: &str| (t == "gas_a").then(|| vec![row("AT", 2024, true)]);
        assert!(companions(&index, "gas_a", &failed).0.is_empty());
        assert!(companions(&index, "gas_a", &|_: &str| None).0.is_empty());
    }

    #[test]
    fn hub_rows_meet_on_their_origins_and_never_a_geo_of_the_same_code() {
        let hub = |code: &str, year: i32| Row {
            via: Some("citizen".into()),
            ..row(code, year, true)
        };
        let main = [hub("SY", 2024), hub("AF", 2024), hub("SY", 2025), hub("AF", 2025)];
        let twin = [hub("SY", 2025), hub("AF", 2025), hub("SY", 2024)];
        assert_eq!(
            overlap(&main, &twin),
            Some(Overlap {
                countries: 2,
                aggregates: 0,
                year: 2025
            })
        );
        let by_geo = [row("SY", 2025, true), row("AF", 2025, true)];
        assert_eq!(overlap(&main, &by_geo), None);
        assert!(!overlap_places(&main, &by_geo));
    }

    #[test]
    fn each_dropped_candidate_says_why() {
        let index = CompanionIndex::from_raw(&raw());
        let main = vec![row("EU27_2020", 2024, false), row("AT", 2024, true)];
        let with = |other: Option<Vec<Row>>| {
            let main = main.clone();
            move |t: &str| if t == "gas_a" { Some(main.clone()) } else { other.clone() }
        };
        let why = |other| companions(&index, "gas_a", &with(other)).1;
        // the shortlist is gas_m (the monthly twin) and gas_b; both are given the same rows here
        let both = |w: DropWhy| [("gas_m".to_string(), w), ("gas_b".to_string(), w)];
        assert_eq!(why(None), both(DropWhy::NoRows));
        assert_eq!(why(Some(vec![row("AT", 2019, true)])), both(DropWhy::NoSharedPlaceYear));
        assert_eq!(why(Some(vec![row("EU27_2020", 2024, false)])), both(DropWhy::NoCountryLevel));
        assert!(why(Some(vec![row("AT", 2024, true)])).is_empty());
        assert_eq!(
            serde_json::json!([DropWhy::NoRows, DropWhy::NoSharedPlaceYear, DropWhy::NoCountryLevel, DropWhy::NoRoom]),
            serde_json::json!(["no_rows", "no_shared_place_year", "no_country_level", "no_room"])
        );
    }

    #[test]
    fn different_units_keep_their_own_axis() {
        let index = CompanionIndex::from_raw(&raw());
        let rows = |t: &str| {
            Some(vec![Row {
                unit: Some(if t == "gas_a" { "PC" } else { "KTOE" }.into()),
                ..row("AT", 2024, true)
            }])
        };
        assert_eq!(companions(&index, "gas_a", &rows).0[0].axis, Axis::Own);
    }

    #[test]
    fn several_units_in_one_table_never_share_an_axis() {
        let index = CompanionIndex::from_raw(&raw());
        let rows = |_: &str| {
            Some(vec![
                row("AT", 2024, true),
                Row {
                    unit: Some("PC".into()),
                    ..row("BE", 2024, true)
                },
            ])
        };
        assert_eq!(companions(&index, "gas_a", &rows).0[0].axis, Axis::Own);
    }

    #[test]
    fn at_most_two_are_offered_best_overlap_first() {
        let index = CompanionIndex::from_raw(&raw());
        let rows = |t: &str| match t {
            "SP.POP.65UP.TO.ZS@2" => Some(vec![row("AUT", 2025, true), row("BEL", 2025, true)]),
            "SP.POP.65UP.FE.ZS@2" => Some(vec![row("AUT", 2025, true)]),
            "SP.POP.65UP.TO@2" => Some(vec![row("AUT", 2025, true), row("BEL", 2025, true)]),
            _ => None,
        };
        let found = companions(&index, "SP.POP.65UP.TO.ZS@2", &rows).0;
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "SP.POP.65UP.TO@2");
        assert_eq!(found[1].id, "SP.POP.65UP.FE.ZS@2");
    }

    /// Measurement on the real catalogue (COMPANION_CATALOGUE; cases from NEXT_WINDOW_CASES): every annual table's twins
    /// (same dimensions, a finer frequency only) in its folder and in its folder's siblings, by whether the titles are one
    /// quantity and whether the shortlist offers them; then each case table's shortlist. One JSON line each; run with
    /// --ignored, before and after a twin rule changes.
    #[test]
    #[ignore]
    fn replay_twins_over_the_real_catalogue() {
        let dir = std::env::var("COMPANION_CATALOGUE").expect("COMPANION_CATALOGUE");
        let index = CompanionIndex::from_raw(&Raw::read(std::path::Path::new(&dir)).unwrap());
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut by_dims: BTreeMap<&BTreeSet<String>, Vec<&String>> = BTreeMap::new();
        for (t, d) in &index.dims {
            by_dims.entry(d).or_default().push(t);
        }
        for (main, folder) in &index.folder {
            let (Some(mine), Some(f)) = (index.dims.get(main), index.freqs.get(main)) else {
                continue;
            };
            if f.len() != 1 || !f.contains("A") || index.support.contains(main) {
                continue;
            }
            let offered: BTreeSet<String> = index.shortlist(main).into_iter().filter(|c| c.grain.is_some()).map(|c| c.id).collect();
            for &t in &by_dims[mine] {
                let tf = &index.folder[t];
                let finer_only = index.freqs.get(t).is_some_and(|f| !f.is_empty() && f.iter().all(|f| FINER_THAN_YEAR.contains(f)));
                if t == main || !finer_only || index.support.contains(t) {
                    continue;
                }
                let place = if tf == folder {
                    "same_folder"
                } else if parent(tf) == parent(folder) {
                    "sibling_folder"
                } else {
                    continue;
                };
                let same = index.quantity(main) == index.quantity(t);
                let topic = index.topic(main, t).is_some_and(|x| x >= MIN_TOPIC_SIMILARITY);
                let key = format!("{place} title_same={same} topic_ok={topic} offered={}", offered.contains(t));
                *counts.entry(key).or_default() += 1;
                if place == "same_folder" && !same && offered.contains(t) {
                    println!("{}", serde_json::json!({"offered_other_title": [main, t]}));
                }
            }
        }
        for (k, n) in &counts {
            println!("{}", serde_json::json!({"pairs": k, "n": n}));
        }
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(std::env::var("NEXT_WINDOW_CASES").unwrap()).unwrap()).unwrap();
        for case in &cases {
            for id in case["tables"].as_array().unwrap().iter().filter_map(|v| v.as_str()) {
                // A twin is marked =title when its title without FREQUENCY_WORDS is the main's, !title when not.
                let list: Vec<String> = index
                    .shortlist(id)
                    .iter()
                    .map(|c| match c.grain {
                        None => c.id.clone(),
                        Some(g) => {
                            let same = if index.quantity(id) == index.quantity(&c.id) { "=title" } else { "!title" };
                            format!("{}:{g}{same}", c.id)
                        }
                    })
                    .collect();
                println!("{}", serde_json::json!({"run": case["run"], "table": id, "shortlist": list}));
            }
        }
    }

    /// Timing on the real catalogue directory (COMPANION_CATALOGUE); run with --ignored.
    #[test]
    #[ignore]
    fn real_catalogue_index_cost() {
        let dir = std::env::var("COMPANION_CATALOGUE").expect("COMPANION_CATALOGUE");
        let t = std::time::Instant::now();
        let raw = Raw::read(std::path::Path::new(&dir)).unwrap();
        println!("read raw: {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let index = CompanionIndex::from_raw(&raw);
        println!("index: {:?}", t.elapsed());
        for main in [
            "sdg_07_40",
            "ten00124",
            "nrg_ind_peh",
            "nrg_cb_pem",
            "EN.GHG.CO2.PC.CE.AR5@2",
            "SP.POP.65UP.TO.ZS@2",
            "migr_asyappctza",
            "ext_st_easitc",
            "ext_lt_maineu",
            "nrg_ti_gas",
            "ei_bpm6ca_q",
            "ei_isin_m",
        ] {
            let t = std::time::Instant::now();
            let c = index.shortlist(main);
            println!(
                "{main}: shortlist {} in {:?}: {:?}",
                c.len(),
                t.elapsed(),
                c.iter().take(4).collect::<Vec<_>>()
            );
        }
    }
}
