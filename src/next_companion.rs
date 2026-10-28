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

/// The dimension every table has; sharing it, or adding it, says nothing about the topic.
const TIME: &str = "time";

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
    /// Eurostat table -> its dimensions but time.
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
                if d != TIME && folder.contains_key(t) {
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
                Some(s) if s.contains('.') => format!("{s}."),
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

/// The overlap of two tables' rows, or None when no country-level row is shared: aggregates count but cannot carry it.
pub fn overlap(main: &[Row], other: &[Row]) -> Option<Overlap> {
    let mine: BTreeSet<(&str, i32)> = main.iter().map(|r| (r.geo.as_str(), r.year)).collect();
    let mut by_year: BTreeMap<i32, (BTreeSet<&str>, BTreeSet<&str>)> = BTreeMap::new();
    for r in other.iter().filter(|r| mine.contains(&(r.geo.as_str(), r.year))) {
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

/// Whether the two tables' numbers can share an axis: Eurostat by the unit code of their rows, World Bank by the unit
/// the registry gives each indicator (a share and a count never do).
fn axis(main: &str, other: &str, main_rows: &[Row], other_rows: &[Row]) -> Axis {
    let unit = |rows: &[Row]| rows.iter().find_map(|r| r.unit.clone());
    let same = if main.ends_with("@2") {
        match (wb_unit(main), wb_unit(other)) {
            (Some(a), Some(b)) => a.code == b.code,
            _ => false,
        }
    } else {
        matches!((unit(main_rows), unit(other_rows)), (Some(a), Some(b)) if a == b)
    };
    if same {
        Axis::Same
    } else {
        Axis::Own
    }
}

/// The main table's companions, at most `MAX_COMPANIONS`. `rows` gives the fetched rows of a table, None when its fetch
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
        .candidates(main)
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
                   \"    Trade\"\t\"ext\"\t\"folder\"\n\
                   \"        Trade by partner\"\t\"trd_a\"\t\"table\"\n";
        let metabase = "gas_a\tgeo\tAT\ngas_a\tpartner\tRU\ngas_a\ttime\t2024\n\
                        gas_b\tgeo\tAT\ngas_b\tnrg_bal\tIC\ngas_b\ttime\t2024\n\
                        gas_c\ttime\t2024\ngas_c\tnrg_bal\tST\n\
                        trd_a\tgeo\tAT\ntrd_a\tpartner\tCN\n";
        Raw {
            toc: toc.into(),
            metabase: metabase.into(),
            cl: Vec::new(),
            wb_indicators: json!([{}, [
                {"id": "SP.POP.65UP.TO.ZS"}, {"id": "SP.POP.65UP.FE.ZS"},
                {"id": "SP.POP.65UP.TO"}, {"id": "SP.POP.TOTL"}, {"id": "NY.GDP.MKTP.CD"}
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
        // gas_b shares geo and adds nrg_bal; gas_c shares nothing but time; trd_a is another folder.
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
        assert_eq!(ids, vec!["SP.POP.65UP.FE.ZS@2", "SP.POP.65UP.TO@2"]);
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
}
