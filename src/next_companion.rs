//! Companion tables for one page: after the main table is picked, the program adds up to two more tables of the same topic
//! that add a dimension (D8). No model choice is made here: the candidates come from the catalogue's own folders and
//! indicator families, and a candidate stays only when its fetched rows overlap the main's.
//!
//! The index is built once from the catalogue's original files (`Raw`); `companions` is pure: the caller passes the rows
//! it fetched for the main table and for each candidate, so a candidate that failed to fetch is simply not offered.

use crate::l5geo::{wb_unit, Raw};
use std::collections::{BTreeMap, BTreeSet};

/// How many companions one page takes.
pub const MAX_COMPANIONS: usize = 2;

/// Dimensions that say nothing about the topic: sharing one proves nothing, and a table that adds only one of them is the
/// same numbers again (another period, another unit), which is the repeat a companion is there to remove.
const NOT_TOPIC: [&str; 3] = ["time", "freq", "unit"];

/// The World Bank source the catalogue's indicators are taken from.
const WB_SOURCE: &str = "2";

/// An indicator family shorter than this many segments is a whole subject (NY.GDP, SP.DYN), not a family.
const MIN_STEM_SEGMENTS: usize = 3;

/// What a fetched table gives the overlap check: one row per place and year with a value.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub geo: String,
    pub year: i32,
    /// Eurostat: the row's unit code. World Bank: none (the unit is the indicator's, see `wb_unit`).
    pub unit: Option<String>,
    /// A country-level row; an aggregate (EU27_2020, a World Bank region) is false.
    pub country: bool,
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
    /// The latest year in which both tables hold the most country rows.
    pub year: i32,
}

/// One companion offered to the page.
#[derive(Clone, Debug, PartialEq)]
pub struct Companion {
    pub id: String,
    /// The dimensions it has that the main lacks (Eurostat). A World Bank sibling adds a split, not a dimension: empty.
    pub adds: Vec<String>,
    pub overlap: Overlap,
    pub axis: Axis,
}

/// The catalogue's folders and dimensions, read once.
pub struct CompanionIndex {
    /// Eurostat table -> its folder path in the TOC.
    folder: BTreeMap<String, String>,
    by_folder: BTreeMap<String, Vec<String>>,
    /// Eurostat table -> its dimensions but the NOT_TOPIC ones.
    dims: BTreeMap<String, BTreeSet<String>>,
    /// World Bank indicator ids, with the "@2" the catalogue ids carry.
    wb: Vec<String>,
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
            folder.insert(r[1].to_string(), path.clone());
            by_folder.entry(path).or_default().push(r[1].to_string());
        }
        let mut dims: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for line in raw.metabase.lines() {
            let mut p = line.split('\t');
            if let (Some(t), Some(d), Some(_)) = (p.next(), p.next(), p.next()) {
                if !NOT_TOPIC.contains(&d) && folder.contains_key(t) {
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
            dims,
            wb,
        }
    }

    /// The tables worth fetching as companions of `main`, before any fetch. Eurostat: same TOC folder, at least one
    /// dimension in common and at least one the main lacks. World Bank: the same indicator family (the id without its
    /// last two segments, as SP.POP.65UP for SP.POP.65UP.TO.ZS), which adds a split, not a dimension.
    pub fn candidates(&self, main: &str) -> Vec<(String, Vec<String>)> {
        if let Some(own) = main.strip_suffix("@2") {
            let stem = match own.rsplitn(3, '.').nth(2) {
                Some(s) if s.split('.').count() >= MIN_STEM_SEGMENTS => format!("{s}."),
                _ => return Vec::new(),
            };
            return self
                .wb
                .iter()
                .filter(|id| id.as_str() != main && id.starts_with(&stem))
                .map(|id| (id.clone(), Vec::new()))
                .collect();
        }
        let (Some(folder), Some(mine)) = (self.folder.get(main), self.dims.get(main)) else {
            return Vec::new();
        };
        self.by_folder[folder]
            .iter()
            .filter(|t| t.as_str() != main)
            .filter_map(|t| {
                let theirs = self.dims.get(t)?;
                let adds: Vec<String> = theirs.difference(mine).cloned().collect();
                (theirs.intersection(mine).next().is_some() && !adds.is_empty())
                    .then(|| (t.clone(), adds))
            })
            .collect()
    }
}

impl CompanionIndex {
    /// The candidates worth a fetch: ranked from what the catalogue already says, cut to `MAX_COMPANIONS` before any
    /// download. Eurostat: the most added dimensions, then the most shared ones. World Bank: an indicator with a registered
    /// unit of the main's kind first (a share beside a share), then one with any registered unit; the catalogue lists no
    /// years or country counts, so those cannot rank. Ties by id.
    pub fn shortlist(&self, main: &str) -> Vec<(String, Vec<String>)> {
        let mine = self.dims.get(main);
        let kind = wb_kind;
        let main_kind = kind(main);
        let mut found = self.candidates(main);
        found.sort_by_cached_key(|(id, adds)| {
            let shared = match (mine, self.dims.get(id)) {
                (Some(m), Some(t)) => m.intersection(t).count(),
                _ => 0,
            };
            let unit_rank = match (kind(id), main_kind) {
                (Some(k), Some(m)) if k == m => 0,
                (Some(_), _) => 1,
                (None, _) => 2,
            };
            (
                unit_rank,
                std::cmp::Reverse(adds.len()),
                std::cmp::Reverse(shared),
                id.clone(),
            )
        });
        found.truncate(MAX_COMPANIONS);
        found
    }
}

/// The overlap of two tables' rows, or None when no country-level row is shared: aggregates count but cannot carry it.
pub fn overlap(main: &[Row], other: &[Row]) -> Option<Overlap> {
    let mine: BTreeSet<(&str, i32)> = main.iter().map(|r| (r.geo.as_str(), r.year)).collect();
    let mut by_year: BTreeMap<i32, (BTreeSet<&str>, BTreeSet<&str>)> = BTreeMap::new();
    for r in other
        .iter()
        .filter(|r| mine.contains(&(r.geo.as_str(), r.year)))
    {
        let e = by_year.entry(r.year).or_default();
        if r.country {
            e.0.insert(r.geo.as_str());
        } else {
            e.1.insert(r.geo.as_str());
        }
    }
    by_year
        .into_iter()
        .filter(|(_, (c, _))| !c.is_empty())
        .max_by_key(|(y, (c, _))| (c.len(), *y))
        .map(|(year, (c, a))| Overlap {
            countries: c.len(),
            aggregates: a.len(),
            year,
        })
}

/// The registry of World Bank units (the file l5geo's `wb_unit` reads), read here for the measure kind alone: a row with an
/// empty unit code (SP.POP.65UP.FE.ZS) still says it is a share, which `wb_unit` does not return.
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
/// main table nothing is offered. Best first: most shared countries, then most added dimensions, then the id.
pub fn companions(
    index: &CompanionIndex,
    main: &str,
    rows: &dyn Fn(&str) -> Option<Vec<Row>>,
) -> Vec<Companion> {
    let Some(main_rows) = rows(main) else {
        return Vec::new();
    };
    let mut found: Vec<Companion> = index
        .shortlist(main)
        .into_iter()
        .filter_map(|(id, adds)| {
            let theirs = rows(&id)?;
            let overlap = overlap(&main_rows, &theirs)?;
            let axis = axis(main, &id, &main_rows, &theirs);
            Some(Companion {
                id,
                adds,
                overlap,
                axis,
            })
        })
        .collect();
    found.sort_by(|a, b| {
        b.overlap
            .countries
            .cmp(&a.overlap.countries)
            .then(b.adds.len().cmp(&a.adds.len()))
            .then(a.id.cmp(&b.id))
    });
    found.truncate(MAX_COMPANIONS);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw() -> Raw {
        let toc = "\"title\"\t\"code\"\t\"type\"\n\
                   \"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"    Energy\"\t\"nrg\"\t\"folder\"\n\
                   \"        Gas imports\"\t\"gas_a\"\t\"table\"\n\
                   \"        Gas balance\"\t\"gas_b\"\t\"table\"\n\
                   \"        Gas stock\"\t\"gas_c\"\t\"table\"\n\
                   \"        Gas in another unit\"\t\"gas_d\"\t\"table\"\n\
                   \"    Trade\"\t\"ext\"\t\"folder\"\n\
                   \"        Trade by partner\"\t\"trd_a\"\t\"table\"\n";
        let metabase = "gas_a\tgeo\tAT\ngas_a\tpartner\tRU\ngas_a\ttime\t2024\n\
                        gas_b\tgeo\tAT\ngas_b\tnrg_bal\tIC\ngas_b\ttime\t2024\n\
                        gas_c\ttime\t2024\ngas_c\tnrg_bal\tST\n\
                        gas_d\tgeo\tAT\ngas_d\tunit\tPC\ngas_d\tfreq\tM\n\
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
        }
    }

    #[test]
    fn eurostat_candidates_share_a_dim_and_add_one_in_the_same_folder() {
        let index = CompanionIndex::from_raw(&raw());
        // gas_b shares geo and adds nrg_bal; gas_c shares nothing but time; gas_d adds only freq and unit; trd_a is another
        // folder.
        assert_eq!(
            index.candidates("gas_a"),
            vec![("gas_b".to_string(), vec!["nrg_bal".to_string()])]
        );
        assert!(index.candidates("unknown").is_empty());
    }

    #[test]
    fn worldbank_candidates_are_the_indicator_family() {
        let index = CompanionIndex::from_raw(&raw());
        let ids: Vec<String> = index
            .candidates("SP.POP.65UP.TO.ZS@2")
            .into_iter()
            .map(|(id, adds)| {
                assert!(adds.is_empty());
                id
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
            .map(|(id, _)| id)
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
        let found = companions(&index, "gas_a", &ok);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "gas_b");
        assert_eq!(found[0].axis, Axis::Same);
        let failed = |t: &str| (t == "gas_a").then(|| vec![row("AT", 2024, true)]);
        assert!(companions(&index, "gas_a", &failed).is_empty());
        assert!(companions(&index, "gas_a", &|_: &str| None).is_empty());
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
        assert_eq!(companions(&index, "gas_a", &rows)[0].axis, Axis::Own);
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
        assert_eq!(companions(&index, "gas_a", &rows)[0].axis, Axis::Own);
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
        let found = companions(&index, "SP.POP.65UP.TO.ZS@2", &rows);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "SP.POP.65UP.TO@2");
        assert_eq!(found[1].id, "SP.POP.65UP.FE.ZS@2");
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
        for main in ["sdg_07_40", "SP.POP.65UP.TO.ZS@2", "nrg_ti_gas"] {
            let t = std::time::Instant::now();
            let c = index.candidates(main);
            println!(
                "{main}: {} candidates in {:?}: {:?}",
                c.len(),
                t.elapsed(),
                c.iter().take(4).collect::<Vec<_>>()
            );
        }
    }
}
