//! New route, knowledge group: its one group command. Another group reaches the catalogue only through `call`, with a `Request`
//! and back a `Reply` (both shared types under rule one); the catalogue itself (l5geo.rs) stays this group's. The opened catalogue
//! is a handle the caller keeps for the run (loaded once, about 1.4 seconds): this module holds no state of its own, so two runs
//! (or two tests) in one process may open different directories. The reference lists classify reads are opened the same way.

use crate::classify::{self, DimInput, Slice, TableInput};
use crate::l5geo::{Catalog, Place, Ranking, TableMeta};
use crate::shape_registry::Shape;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::OnceLock;

/// The vendored name table the visual group's economy_names.mjs reads (the same file, built from CLDR and the World Bank list).
const ECONOMY_NAMES: &str = include_str!("../runtime/pi/assets/economy-names.json");

/// One opened catalogue directory. Its fields are this group's: the caller only passes it back in later requests.
pub struct Opened {
    catalog: Catalog,
}

/// The reference lists classify reads (ISO codes, NUTS, the World Bank list, the energy formulas, the flow tables), opened once.
pub struct OpenedRefs {
    refs: classify::Refs,
}

pub enum Request<'a> {
    /// Reads SOURCE.json first, so a wrong directory stops before the load; then the catalogue's original files.
    OpenCatalogue { dir: &'a Path },
    /// The first five tables for the Chinese question and the English search texts, with the scope and places it judged.
    Top5 {
        catalogue: &'a Opened,
        question: &'a str,
        texts: &'a [String],
    },
    /// English place names in the search texts that the question does not name.
    PlacesOutside {
        catalogue: &'a Opened,
        question: &'a str,
        texts: &'a [String],
    },
    /// The dimensions and codes of one listed table.
    Table { catalogue: &'a Opened, id: &'a str },
    /// The places the Chinese question names.
    Places {
        catalogue: &'a Opened,
        question: &'a str,
    },
    /// Reads the five reference files of classify::load_refs from one directory.
    OpenRefs { dir: &'a Path },
    /// The matcher's view of one fetched file: its rows read into classify, every dimension with one code fixed, every other one
    /// (and the time, when it holds more than one period) varying over the codes present.
    Shape {
        refs: &'a OpenedRefs,
        table: &'a TableMeta,
        /// The fetched file as written: Eurostat SDMX-CSV.
        csv: &'a str,
        /// What the matcher is asked; None asks the default.
        ask: Option<&'a classify::Ask>,
    },
    /// The Chinese name of each code in the name table's `scheme` (iso2, Eurostat's EL and UK included, or iso3), exact match
    /// only: a code the table does not hold is listed as missing, never translated or kept as it is.
    ZhNames {
        scheme: &'a str,
        codes: &'a [String],
    },
}

pub enum Reply {
    /// The handle and SOURCE.json of the directory (the original files and their hashes).
    Opened {
        catalogue: Opened,
        source: Value,
    },
    Ranking(Ranking),
    Names(Vec<String>),
    Table(Option<TableMeta>),
    Places(Vec<Place>),
    Refs(OpenedRefs),
    Shape(Shape),
    ZhNames {
        names: BTreeMap<String, String>,
        missing: Vec<String>,
    },
}

/// The knowledge group's command. Opening a directory and reading a fetched file can fail; the other requests are pure.
pub fn call(request: Request<'_>) -> Result<Reply, String> {
    Ok(match request {
        Request::OpenCatalogue { dir } => {
            let source = std::fs::read_to_string(dir.join("SOURCE.json"))
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
                .map_err(|e| format!("SOURCE.json cannot be read: {e}"))?;
            let catalog =
                Catalog::load(dir).map_err(|e| format!("the catalogue cannot be read: {e:#}"))?;
            Reply::Opened {
                catalogue: Opened { catalog },
                source,
            }
        }
        Request::Top5 {
            catalogue,
            question,
            texts,
        } => Reply::Ranking(catalogue.catalog.top5(question, texts)),
        Request::PlacesOutside {
            catalogue,
            question,
            texts,
        } => Reply::Names(catalogue.catalog.places_outside(question, texts)),
        Request::Table { catalogue, id } => Reply::Table(catalogue.catalog.table(id)),
        Request::Places {
            catalogue,
            question,
        } => Reply::Places(catalogue.catalog.places(question)),
        Request::OpenRefs { dir } => Reply::Refs(OpenedRefs {
            refs: classify::load_refs(dir)
                .map_err(|e| format!("the reference lists cannot be read: {e}"))?,
        }),
        Request::Shape {
            refs,
            table,
            csv,
            ask,
        } => {
            let input = sdmx_csv(table, csv)?;
            let default = classify::Ask::default();
            let roles = classify::classify(&input, &refs.refs, ask.unwrap_or(&default));
            let mut slice = Slice::new();
            let mut present: Vec<(String, Vec<String>)> = Vec::new();
            let periods: BTreeSet<String> = input.rows.iter().filter_map(|r| r.1.clone()).collect();
            let columns = input.dims.iter().map(|d| (d.id.clone(), d.codes.clone()));
            for (dim, codes) in columns.chain([("time".to_string(), periods.into_iter().collect())])
            {
                match codes.as_slice() {
                    [] => {}
                    [one] => {
                        slice.insert(dim, one.clone());
                    }
                    _ => present.push((dim, codes)),
                }
            }
            let varying: Vec<(&str, &[String])> = present
                .iter()
                .map(|(d, c)| (d.as_str(), c.as_slice()))
                .collect();
            Reply::Shape(classify::varying(&roles, &slice, &varying))
        }
        Request::ZhNames { scheme, codes } => {
            let table = name_tables()?
                .get(scheme)
                .ok_or_else(|| format!("the name table has no scheme '{scheme}' (iso2 or iso3)"))?;
            let (mut names, mut missing) = (BTreeMap::new(), Vec::new());
            for code in codes.iter().map(|c| c.trim()) {
                match table.get(code) {
                    Some(zh) => {
                        names.insert(code.to_string(), zh.clone());
                    }
                    None if !missing.iter().any(|m| m == code) => missing.push(code.to_string()),
                    None => {}
                }
            }
            Reply::ZhNames { names, missing }
        }
    })
}

/// The iso2 and iso3 tables of economy-names.json as economy_names.mjs builds them: economies and territories by iso2,
/// aggregates too by iso3, then the listed aliases, then the except codes by iso2 (an alias that names no entry, or an alias
/// or except code that shadows a code, is a broken table).
fn name_tables() -> Result<&'static BTreeMap<&'static str, BTreeMap<String, String>>, String> {
    static TABLES: OnceLock<Result<BTreeMap<&'static str, BTreeMap<String, String>>, String>> =
        OnceLock::new();
    TABLES
        .get_or_init(|| {
            let asset: Value = serde_json::from_str(ECONOMY_NAMES).map_err(|e| format!("economy-names.json: {e}"))?;
            let list = |key: &str| asset[key].as_array().cloned().unwrap_or_default();
            let (places, aggregates) = ([list("economies"), list("territories")].concat(), list("aggregates"));
            let by = |entries: &[Value], key: &str| -> BTreeMap<String, String> {
                entries
                    .iter()
                    .filter_map(|e| Some((e[key].as_str()?.to_string(), e["zh"].as_str()?.to_string())))
                    .collect()
            };
            let mut tables = BTreeMap::from([("iso2", by(&places, "iso2")), ("iso3", by(&[places, aggregates].concat(), "iso3"))]);
            for alias in list("aliases") {
                let (mode, name, target) = (alias["mode"].as_str().unwrap_or(""), alias["alias"].as_str().unwrap_or(""), alias["target"].as_str().unwrap_or(""));
                let table = tables.get_mut(mode).ok_or_else(|| format!("economy-names.json: alias '{name}' has mode '{mode}'"))?;
                let zh = table.get(target).cloned().ok_or_else(|| format!("economy-names.json: alias '{name}' targets '{target}', which is not a {mode} code"))?;
                if table.insert(name.to_string(), zh).is_some() {
                    return Err(format!("economy-names.json: alias '{name}' shadows a primary {mode} code"));
                }
            }
            let iso2 = tables.get_mut("iso2").expect("the iso2 table");
            for place in list("except_places") {
                let (code, zh) = (place["code"].as_str().unwrap_or(""), place["zh"].as_str().unwrap_or(""));
                if iso2.insert(code.to_string(), zh.to_string()).is_some() {
                    return Err(format!("economy-names.json: except code '{code}' shadows an iso2 code"));
                }
            }
            Ok(tables)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// One CSV line split on commas, a quoted field kept whole ("" inside it is one quote).
fn fields(line: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                out.last_mut().expect("one field").push('"');
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(String::new()),
            _ => out.last_mut().expect("one field").push(c),
        }
    }
    out
}

/// Eurostat's flag for a cell with no value because the data cannot exist (classify reads it as 0 in the self-check only).
const CANNOT_EXIST: &str = "m";

/// A fetched Eurostat SDMX-CSV file as classify's input: the dimensions are the columns between LAST UPDATE and TIME_PERIOD,
/// each with the codes the file holds in the metabase's order (a code the metabase does not list follows, in file order).
/// A cell with no value is kept only when flagged as data that cannot exist; a value that is not a number stops the read.
fn sdmx_csv(table: &TableMeta, csv: &str) -> Result<TableInput, String> {
    if table.worldbank {
        return Err(format!(
            "{}: a World Bank file is not read into classify yet",
            table.id
        ));
    }
    let mut lines = csv.lines().filter(|l| !l.trim().is_empty());
    let header = fields(lines.next().ok_or("the fetched file is empty")?);
    let at = |name: &str| {
        header
            .iter()
            .position(|h| h == name)
            .ok_or(format!("the fetched file has no {name} column"))
    };
    let (first, time, value) = (at("LAST UPDATE")? + 1, at("TIME_PERIOD")?, at("OBS_VALUE")?);
    let flag = header.iter().position(|h| h == "OBS_FLAG");
    if first >= time {
        return Err("the fetched file has no dimension column before TIME_PERIOD".into());
    }
    let mut seen: Vec<Vec<String>> = vec![Vec::new(); time - first];
    let mut rows = Vec::new();
    let mut zero_cells = Vec::new();
    for (n, line) in lines.enumerate() {
        let f = fields(line);
        if f.len() < header.len() {
            return Err(format!(
                "line {} of the fetched file has {} fields, the header {}",
                n + 2,
                f.len(),
                header.len()
            ));
        }
        let codes: Vec<String> = f[first..time].to_vec();
        for (known, code) in seen.iter_mut().zip(&codes) {
            if !known.contains(code) {
                known.push(code.clone());
            }
        }
        let period = Some(f[time].clone()).filter(|p| !p.is_empty());
        match f[value].trim() {
            "" if flag.is_some_and(|i| f[i].trim() == CANNOT_EXIST) => {
                zero_cells.push((codes, period))
            }
            "" => {}
            v => rows.push((
                codes,
                period,
                v.parse::<f64>()
                    .map_err(|_| format!("line {}: OBS_VALUE {v} is not a number", n + 2))?,
            )),
        }
    }
    let dims = header[first..time]
        .iter()
        .zip(seen)
        .map(|(id, in_file)| {
            let listed: Vec<&String> = table
                .dims
                .iter()
                .find(|(d, _)| d == id)
                .map(|(_, c)| c.iter().map(|(code, _)| code).collect())
                .unwrap_or_default();
            let mut codes: Vec<String> = listed
                .into_iter()
                .filter(|c| in_file.contains(c))
                .cloned()
                .collect();
            codes.extend(
                in_file
                    .into_iter()
                    .filter(|c| !codes.contains(c))
                    .collect::<Vec<_>>(),
            );
            DimInput {
                id: id.clone(),
                codes,
            }
        })
        .collect();
    Ok(TableInput {
        provider: "eurostat".into(),
        dataset: table.id.clone(),
        dims,
        rows,
        zero_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_gets_the_name_tables_chinese_name_and_an_unknown_one_is_missing() {
        let codes: Vec<String> = ["SE", "EL", "UK", "EU27_2020", "SE", "XX"]
            .iter()
            .map(|c| c.to_string())
            .collect();
        let Ok(Reply::ZhNames { names, missing }) = call(Request::ZhNames {
            scheme: "iso2",
            codes: &codes,
        }) else {
            panic!("no names")
        };
        assert_eq!(names.get("SE").map(String::as_str), Some("瑞典"));
        assert_eq!(names.get("EL").map(String::as_str), Some("希腊"));
        assert_eq!(names.get("UK").map(String::as_str), Some("英国"));
        assert_eq!(missing, ["EU27_2020", "XX"]);
        let codes = vec!["SWE".to_string(), "WLD".to_string()];
        let Ok(Reply::ZhNames { names, missing }) = call(Request::ZhNames {
            scheme: "iso3",
            codes: &codes,
        }) else {
            panic!("no names")
        };
        assert_eq!((names.len(), missing.len()), (2, 0));
        assert!(call(Request::ZhNames {
            scheme: "worldbank",
            codes: &codes
        })
        .is_err());
    }

    #[test]
    fn an_except_code_gets_its_composed_name_by_iso2_only_and_one_whose_parts_the_table_lacks_is_missing(
    ) {
        let codes: Vec<String> = ["CN_X_HK", "CN", "EU27_2020_X_DK"]
            .iter()
            .map(|c| c.to_string())
            .collect();
        let Ok(Reply::ZhNames { names, missing }) = call(Request::ZhNames {
            scheme: "iso2",
            codes: &codes,
        }) else {
            panic!("no names")
        };
        assert_eq!(
            names.get("CN_X_HK").map(String::as_str),
            Some("中国（不含香港）")
        );
        assert_eq!(names.get("CN").map(String::as_str), Some("中国"));
        assert_eq!(missing, ["EU27_2020_X_DK"]);
        let codes = vec!["CN_X_HK".to_string()];
        let Ok(Reply::ZhNames { missing, .. }) = call(Request::ZhNames {
            scheme: "iso3",
            codes: &codes,
        }) else {
            panic!("no names")
        };
        assert_eq!(missing, ["CN_X_HK"]);
    }

    #[test]
    fn a_directory_without_source_or_catalogue_files_cannot_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let opened = |dir: &Path| call(Request::OpenCatalogue { dir }).err().unwrap();
        assert!(opened(dir.path()).starts_with("SOURCE.json cannot be read"));
        std::fs::write(dir.path().join("SOURCE.json"), "{}").unwrap();
        assert!(opened(dir.path()).starts_with("the catalogue cannot be read"));
    }

    fn meta() -> TableMeta {
        let codes = |c: &[&str]| c.iter().map(|c| (c.to_string(), String::new())).collect();
        TableMeta {
            id: "sdg_07_40".into(),
            worldbank: false,
            dims: vec![
                ("freq".into(), codes(&["A"])),
                ("nrg_bal".into(), codes(&["REN", "REN_TRA"])),
                ("unit".into(), codes(&["PC"])),
                ("geo".into(), codes(&["EU27_2020", "BE", "SE", "AT"])),
            ],
            end_year: Some(2025),
            places: Vec::new(),
        }
    }

    /// The head of the q1 stand-in run's file (ab/run-rel10), with the EU aggregate and one cell that cannot exist added.
    const Q1_CSV: &str =
        "DATAFLOW,LAST UPDATE,freq,nrg_bal,unit,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG,CONF_STATUS
ESTAT:SDG_07_40(1.0),15/09/26 23:00:00,A,REN,PC,AT,2025,44.2,p,
ESTAT:SDG_07_40(1.0),15/09/26 23:00:00,A,REN,PC,BE,2025,14.9,p,
ESTAT:SDG_07_40(1.0),15/09/26 23:00:00,A,REN,PC,SE,2025,65.4,p,
ESTAT:SDG_07_40(1.0),\"15/09/26 23:00:00\",A,REN,PC,EU27_2020,2025,25.2,p,
ESTAT:SDG_07_40(1.0),15/09/26 23:00:00,A,REN,PC,XX,2025,,m,
";

    fn refs() -> OpenedRefs {
        let mut refs = classify::Refs::default();
        refs.iso2 = ["AT", "BE", "SE"].iter().map(|c| c.to_string()).collect();
        OpenedRefs { refs }
    }

    #[test]
    fn a_fetched_file_is_read_in_the_metabase_order_with_its_cells_that_cannot_exist() {
        let input = sdmx_csv(&meta(), Q1_CSV).unwrap();
        let geo = input.dims.iter().find(|d| d.id == "geo").unwrap();
        assert_eq!(geo.codes, ["EU27_2020", "BE", "SE", "AT", "XX"]);
        assert_eq!(
            input.dims.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["freq", "nrg_bal", "unit", "geo"]
        );
        assert_eq!(input.rows.len(), 4);
        assert_eq!(
            input.rows[2],
            (
                vec!["A".into(), "REN".into(), "PC".into(), "SE".into()],
                Some("2025".into()),
                65.4
            )
        );
        assert_eq!(
            input.zero_cells,
            [(
                vec!["A".to_string(), "REN".into(), "PC".into(), "XX".into()],
                Some("2025".to_string())
            )]
        );
        let bad = Q1_CSV.replace("44.2", "4x");
        assert!(sdmx_csv(&meta(), &bad)
            .unwrap_err()
            .contains("OBS_VALUE 4x is not a number"));
        let wb = TableMeta {
            worldbank: true,
            ..meta()
        };
        assert!(sdmx_csv(&wb, Q1_CSV)
            .unwrap_err()
            .contains("not read into classify yet"));
    }

    #[test]
    fn the_shape_of_a_one_year_file_varies_over_its_places_only() {
        let refs = refs();
        // Without the cell that cannot exist: its code XX is in no reference list, so it would count against geo being a place.
        let csv: String = Q1_CSV
            .lines()
            .filter(|l| !l.contains(",XX,"))
            .map(|l| format!("{l}\n"))
            .collect();
        let Reply::Shape(shape) = call(Request::Shape {
            refs: &refs,
            table: &meta(),
            csv: &csv,
            ask: None,
        })
        .unwrap() else {
            panic!("a shape");
        };
        assert_eq!(shape.dims.len(), 1, "{shape:?}");
        let geo = &shape.dims[0];
        assert_eq!(
            (geo.dim.as_str(), geo.is_place, geo.members),
            ("geo", true, 3)
        );
        assert!(geo.iso_countries);
    }
}
