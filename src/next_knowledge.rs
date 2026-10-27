//! New route, knowledge group: its one group command. Another group reaches the catalogue only through `call`, with a `Request`
//! and back a `Reply` (both shared types under rule one); the catalogue itself (l5geo.rs) stays this group's. The opened catalogue
//! is a handle the caller keeps for the run (loaded once, about 1.4 seconds): this module holds no state of its own, so two runs
//! (or two tests) in one process may open different directories. The reference lists classify reads are opened the same way.

use crate::classify::{self, DimInput, Slice, TableInput};
use crate::l5geo::{Catalog, Place, Ranking, TableMeta};
use crate::shape_registry::Shape;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

/// The vendored name table the visual group's economy_names.mjs reads (the same file, built from CLDR and the World Bank list).
const ECONOMY_NAMES: &str = include_str!("../runtime/pi/assets/economy-names.json");

/// Registry: Eurostat's SDMX 3.0 data endpoint. Its named filters (`c[geo]=DE,FR`) need no dimension order: the metabase
/// lists a table's dimensions alphabetically, not in its DSD's order (30 of 30 sampled tables differ, 10-28), and a DSD call
/// would add about 1.2 s per table.
pub const HELD_BASE: &str =
    "https://ec.europa.eu/eurostat/api/dissemination/sdmx/3.0/data/dataflow/ESTAT";
/// A probe past this is unprobed: the table keeps the metabase codes (works/held-wall-1028.md, about 1 in 8 probes).
pub const HELD_TIMEOUT: Duration = Duration::from_secs(3);
/// The two columns an SDMX 3.0 csvdata reply starts with; the dimensions follow.
const HELD_LEAD: [&str; 2] = ["STRUCTURE", "STRUCTURE_ID"];

/// The probe's raw reply (HTTP status and body), or the network error's text as reqwest gave it (the caller redacts it).
pub type HeldFuture = Pin<Box<dyn Future<Output = Result<(u16, String), String>> + Send>>;

/// What a probe says about a table's series under the key.
#[derive(Clone, Debug, PartialEq)]
pub enum Held {
    /// An HTTP 200 csvdata reply: its dimension columns and each series key's codes in that order. No row is no series.
    Series {
        dims: Vec<String>,
        keys: Vec<Vec<String>>,
    },
    /// Anything else (a 400, 404, 413, a timeout, a queued or unreadable reply): the reason. Never read as no series.
    Unprobed(String),
}

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
    /// The series keys a Eurostat table holds under `filters` (dimension, codes; a dimension not listed is open): the GET
    /// to start, which writes nothing. Its proxy is the environment's only, never the system's.
    HeldSeries {
        table: &'a str,
        filters: &'a [(String, Vec<String>)],
    },
    /// A probe's reply read: only an HTTP 200 in csvdata form is series (none when it has no row); anything else is unprobed.
    ReadHeld { status: u16, body: &'a str },
}

pub enum Reply {
    /// The handle and SOURCE.json of the directory (the original files and their hashes).
    Opened {
        catalogue: Box<Opened>,
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
    HeldProbe {
        url: String,
        reply: HeldFuture,
    },
    Held(Held),
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
                catalogue: Box::new(Opened { catalog }),
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
        Request::HeldSeries { table, filters } => {
            let url = held_url(table, filters);
            Reply::HeldProbe {
                reply: held_get(held_client()?, url.clone()),
                url,
            }
        }
        Request::ReadHeld { status, body } => Reply::Held(read_held(status, body)),
    })
}

/// The probe's URL: series keys only (no attribute, no value), one `c[dim]=a,b` filter per fixed dimension.
fn held_url(table: &str, filters: &[(String, Vec<String>)]) -> String {
    let mut url = format!("{HELD_BASE}/{table}/1.0/*?attributes=none&measures=none&format=csvdata");
    for (dim, codes) in filters {
        url.push_str(&format!("&c[{dim}]={}", codes.join(",")));
    }
    url
}

/// The probe itself: it holds the client and the URL only, so awaiting it, which the flow does outside any writer door
/// (the knowledge group has one entry, `call`), can do nothing but this one GET.
fn held_get(client: reqwest::Client, url: String) -> HeldFuture {
    Box::pin(async move {
        let reply = client.get(&url).send().await.map_err(|e| e.to_string())?;
        let status = reply.status().as_u16();
        let body = reply.text().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    })
}

/// The probe's client: HELD_TIMEOUT, and the proxy the environment names or none (reqwest's own system-proxy discovery is
/// unsafe in a headless process, llm/client.rs).
fn held_client() -> Result<reqwest::Client, String> {
    let proxy = [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .into_iter()
    .find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()));
    let builder = reqwest::Client::builder().timeout(HELD_TIMEOUT);
    let builder = match proxy {
        Some(proxy) => builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?),
        None => builder.no_proxy(),
    };
    builder.build().map_err(|e| e.to_string())
}

fn read_held(status: u16, body: &str) -> Held {
    if status != 200 {
        return Held::Unprobed(format!("HTTP {status}"));
    }
    let mut lines = body.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<&str> = lines.next().unwrap_or("").split(',').collect();
    if header.len() <= HELD_LEAD.len()
        || header[..HELD_LEAD.len()] != HELD_LEAD
        || body.contains('"')
    {
        return Held::Unprobed(format!(
            "HTTP 200 that is not a csvdata series list ({} bytes, starting {:?})",
            body.len(),
            body.chars().take(60).collect::<String>()
        ));
    }
    let dims: Vec<String> = header[HELD_LEAD.len()..]
        .iter()
        .map(|d| d.to_string())
        .collect();
    let mut keys = Vec::new();
    for line in lines {
        let cells: Vec<&str> = line.split(',').collect();
        if cells.len() != header.len() {
            return Held::Unprobed(format!(
                "a series row has {} cells, the header {}",
                cells.len(),
                header.len()
            ));
        }
        keys.push(
            cells[HELD_LEAD.len()..]
                .iter()
                .map(|c| c.to_string())
                .collect(),
        );
    }
    Held::Series { dims, keys }
}

/// The iso2 and iso3 name tables: code to name.
type NameTables = BTreeMap<&'static str, BTreeMap<String, String>>;

/// The iso2 and iso3 tables of economy-names.json as economy_names.mjs builds them: economies and territories by iso2,
/// aggregates too by iso3, then the listed aliases, then the except codes by iso2 (an alias that names no entry, or an alias
/// or except code that shadows a code, is a broken table).
fn name_tables() -> Result<&'static NameTables, String> {
    static TABLES: OnceLock<Result<NameTables, String>> = OnceLock::new();
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
        return worldbank_csv(table, csv);
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

/// The columns of the World Bank file newsroom.ts writes (country, country_name, region, date, value): the place code, the time
/// and the value. The name and the region are labels of the place, not dimensions.
const WB_COUNTRY: &str = "country";
const WB_DATE: &str = "date";
const WB_VALUE: &str = "value";

/// A fetched World Bank file as classify's input: one dimension, the country, with the codes the file holds in the catalogue's
/// order (a code the catalogue does not list follows, in file order). The World Bank has no flags, so a row with no value is left
/// out; a value that is not a number stops the read.
fn worldbank_csv(table: &TableMeta, csv: &str) -> Result<TableInput, String> {
    let mut lines = csv.lines().filter(|l| !l.trim().is_empty());
    let header = fields(lines.next().ok_or("the fetched file is empty")?);
    let at = |name: &str| {
        header
            .iter()
            .position(|h| h == name)
            .ok_or(format!("the fetched file has no {name} column"))
    };
    let (place, time, value) = (at(WB_COUNTRY)?, at(WB_DATE)?, at(WB_VALUE)?);
    let mut in_file: Vec<String> = Vec::new();
    let mut rows = Vec::new();
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
        if !in_file.contains(&f[place]) {
            in_file.push(f[place].clone());
        }
        let period = Some(f[time].clone()).filter(|p| !p.is_empty());
        match f[value].trim() {
            "" => {}
            v => rows.push((
                vec![f[place].clone()],
                period,
                v.parse::<f64>()
                    .map_err(|_| format!("line {}: {WB_VALUE} {v} is not a number", n + 2))?,
            )),
        }
    }
    let mut codes: Vec<String> = table
        .places
        .iter()
        .map(|(_, id)| id)
        .filter(|id| in_file.contains(id))
        .cloned()
        .collect();
    codes.extend(
        in_file
            .into_iter()
            .filter(|c| !codes.contains(c))
            .collect::<Vec<_>>(),
    );
    Ok(TableInput {
        provider: "worldbank".into(),
        dataset: table.id.strip_suffix("@2").unwrap_or(&table.id).to_string(),
        dims: vec![DimInput {
            id: WB_COUNTRY.into(),
            codes,
        }],
        rows,
        zero_cells: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(status: u16, body: &str) -> Held {
        match call(Request::ReadHeld { status, body }) {
            Ok(Reply::Held(held)) => held,
            _ => panic!("no held reply"),
        }
    }

    /// The replies measured 10-28 on nrg_cb_pem: a 200 with series, a 200 with the header only (held codes, no series), a 400
    /// (a code the table does not hold), a 404 (no such table) and an asynchronous or HTML reply.
    #[test]
    fn only_a_200_csvdata_reply_is_series_and_a_header_alone_is_none() {
        let body = "STRUCTURE,STRUCTURE_ID,freq,siec,unit,geo\r\ndataflow,ESTAT:NRG_CB_PEM(1.0),M,C0000,GWH,DE\r\ndataflow,ESTAT:NRG_CB_PEM(1.0),M,C0000,PC,DE\r\n";
        assert_eq!(
            read(200, body),
            Held::Series {
                dims: ["freq", "siec", "unit", "geo"].map(str::to_string).to_vec(),
                keys: vec![
                    ["M", "C0000", "GWH", "DE"].map(str::to_string).to_vec(),
                    ["M", "C0000", "PC", "DE"].map(str::to_string).to_vec()
                ],
            }
        );
        assert_eq!(
            read(200, "STRUCTURE,STRUCTURE_ID,freq,siec,unit,geo\r\n"),
            Held::Series {
                dims: ["freq", "siec", "unit", "geo"].map(str::to_string).to_vec(),
                keys: Vec::new()
            }
        );
        let fault = "<?xml version=\"1.0\"?><S:Fault><faultcode>150</faultcode></S:Fault>";
        for (status, body) in [
            (400, fault),
            (404, fault),
            (413, ""),
            (200, fault),
            (200, "<html>queued</html>"),
            (200, ""),
            (200, "STRUCTURE,STRUCTURE_ID\n"),
        ] {
            assert!(
                matches!(read(status, body), Held::Unprobed(_)),
                "{status} {body}"
            );
        }
        assert!(
            matches!(
                read(200, "STRUCTURE,STRUCTURE_ID,freq,geo\ndataflow,X,A\n"),
                Held::Unprobed(_)
            ),
            "a short row"
        );
    }

    #[test]
    fn the_probe_url_names_each_fixed_dimension_and_asks_for_series_keys_only() {
        let filters = [
            ("freq".to_string(), vec!["M".to_string()]),
            ("geo".to_string(), vec!["DE".to_string(), "FR".to_string()]),
        ];
        assert_eq!(
            held_url("nrg_cb_pem", &filters),
            format!("{HELD_BASE}/nrg_cb_pem/1.0/*?attributes=none&measures=none&format=csvdata&c[freq]=M&c[geo]=DE,FR")
        );
    }

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
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
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
        let refs = classify::Refs {
            iso2: ["AT", "BE", "SE"].iter().map(|c| c.to_string()).collect(),
            ..Default::default()
        };
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
        assert_eq!(
            sdmx_csv(&wb, Q1_CSV).unwrap_err(),
            "the fetched file has no country column"
        );
    }

    fn wb_meta() -> TableMeta {
        TableMeta {
            id: "EN.GHG.CO2.PC.CE.AR5@2".into(),
            worldbank: true,
            dims: Vec::new(),
            end_year: None,
            places: [("CN", "CHN"), ("IN", "IND"), ("US", "USA")]
                .iter()
                .map(|(i, id)| (i.to_string(), id.to_string()))
                .collect(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        }
    }

    /// The head of the q4 stand-in run's narrowed file (b1028 runs.b2), with an aggregate, a row with no value and a quoted name.
    const Q4_CSV: &str = "country,country_name,region,date,value
USA,\"United States\",\"North America\",2024,13.8
USA,\"United States\",\"North America\",2023,14.1
CHN,\"China\",\"East Asia & Pacific\",2024,9.2
CHN,\"China\",\"East Asia & Pacific\",2023,
WLD,\"World\",\"Aggregates\",2024,4.7
IND,\"India\",\"South Asia\",2024,2.1
";

    #[test]
    fn a_world_bank_file_is_read_as_one_country_dimension_in_the_catalogue_order() {
        let input = sdmx_csv(&wb_meta(), Q4_CSV).unwrap();
        assert_eq!(
            (input.provider.as_str(), input.dataset.as_str()),
            ("worldbank", "EN.GHG.CO2.PC.CE.AR5")
        );
        assert_eq!(input.dims.len(), 1);
        assert_eq!(input.dims[0].id, "country");
        assert_eq!(input.dims[0].codes, ["CHN", "IND", "USA", "WLD"]);
        assert_eq!(input.rows.len(), 5, "the row with no value is left out");
        assert_eq!(
            input.rows[2],
            (vec!["CHN".into()], Some("2024".into()), 9.2)
        );
        assert!(input.zero_cells.is_empty());
        let bad = Q4_CSV.replace("13.8", "1x");
        assert_eq!(
            sdmx_csv(&wb_meta(), &bad).unwrap_err(),
            "line 2: value 1x is not a number"
        );
        let short = Q4_CSV.replace(",2024,2.1", "");
        assert!(sdmx_csv(&wb_meta(), &short)
            .unwrap_err()
            .starts_with("line 7 of the fetched file has 3 fields"));
        assert_eq!(
            sdmx_csv(&wb_meta(), Q1_CSV).unwrap_err(),
            "the fetched file has no country column"
        );
    }

    #[test]
    fn the_shape_of_a_world_bank_file_varies_over_its_economies_and_years_with_the_aggregate_a_total(
    ) {
        let mut refs = refs();
        for (id, iso2, kind) in [
            ("CHN", "CN", false),
            ("IND", "IN", false),
            ("USA", "US", false),
            ("WLD", "1W", true),
        ] {
            refs.refs.wb.insert(id.into(), (iso2.into(), kind));
        }
        let input = sdmx_csv(&wb_meta(), Q4_CSV).unwrap();
        let roles = classify::classify(&input, &refs.refs, &classify::Ask::default());
        let country = roles.dims.iter().find(|d| d.dim == "country").unwrap();
        assert!(country.is_place, "{country:?}");
        let Reply::Shape(shape) = call(Request::Shape {
            refs: &refs,
            table: &wb_meta(),
            csv: Q4_CSV,
            ask: None,
        })
        .unwrap() else {
            panic!("a shape");
        };
        let dims: Vec<&str> = shape.dims.iter().map(|d| d.dim.as_str()).collect();
        assert_eq!(dims, ["country", "time"], "{shape:?}");
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
