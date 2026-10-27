//! Data side: pick the first 5 candidate tables for one question (research page v5geo, "L5geo"). Deterministic:
//! BM25 on table titles and folder paths (S) plus a member-label signal (V), places in the search text used as a
//! filter, and the question's reach (Europe or beyond) judged by the program from the Chinese question, never by the
//! model. The model only picks a number from what this returns.
//!
//! Input is one plain directory made by scripts/l5geo_inputs.py: toc.txt, metabase.txt, cl/*.tsv, wb-indicators.json,
//! wb-countries.json, wb-countries-zh.json, nuts-2024-at.csv (original files, metabase unzipped).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

/// BM25 parameters (v1 scorer).
const K1: f64 = 1.2;
const B: f64 = 0.75;
/// Weight of the member-label signal against the title score (L5-none, dir-1-values plan).
const LAMBDA: f64 = 0.5;
/// A Eurostat table with fewer non-European countries than this covers only Europe (geo-filter plan).
const WORLD_MIN: usize = 10;
const TOP: usize = 5;
const STOP: &str = "a an and the of in by to for from per on at as or with all each its is are be how what which over";
const SKIP_DIMS: [&str; 2] = ["geo", "time"];
const ESTAT_ISO: [(&str, &str); 2] = [("EL", "GR"), ("UK", "GB")];
/// Region words that mean Europe: the union, the continent and its parts, and the seas inside it.
const REGION_WORDS_ZH: [&str; 15] = [
    "欧盟",
    "欧洲",
    "欧元区",
    "欧洲联盟",
    "欧洲货币联盟",
    "北欧",
    "西欧",
    "东欧",
    "南欧",
    "中东欧",
    "巴尔干",
    "斯堪的纳维亚",
    "北海",
    "地中海",
    "波罗的海",
];
const REGION: &str = "REGION";
/// Whole words that hold a place name but name no place (发展中国家 holds 中国, 增加纳税 holds 加纳). Matched with the
/// place names, longest first, so a hit swallows the name. Hand-kept: the catalog has no Chinese words to derive
/// them from. 小国 is the World Bank aggregate "Small states", which a Chinese question never means.
const NOT_PLACE_ZH: [&str; 11] = [
    "发展中国家",
    "海地区",
    "加纳税",
    "加纳入",
    "加纳米",
    "南非洲",
    "印度洋",
    "纽芬兰",
    "关岛屿",
    "小国",
    "北海道",
];
/// 中 as "among": after one of these characters (国家中, 欧盟中, 欧元区中, 其中) a name starting with 中 is not read when
/// its second character starts one of GUO_WORDS_ZH. In 欧洲国家中国防开支 the words are 国家中 and 国防, not 中国;
/// 欧盟国家中国游客 still names 中国.
const AMONG_BEFORE_ZH: &str = "家国盟区其之当体市省州";
const GUO_WORDS_ZH: [&str; 13] = [
    "国防", "国内", "国际", "国债", "国民", "国土", "国有", "国库", "国企", "国产", "国会", "国籍",
    "国营",
];
const NOT_PLACE: &str = "";
/// Words that ask for a level below the country. Eurostat has that level only for the countries of the NUTS table
/// and the World Bank has none, so a question naming another country with one of these cannot be answered. Each one
/// names the split itself (各城市, 按城市); a bare 城市 is not one, since 城市人口 and 城市化率 are national figures.
const BELOW_COUNTRY_ZH: [&str; 20] = [
    "各省",
    "省份",
    "省级",
    "分省",
    "按省",
    "各州",
    "州级",
    "分州",
    "按州",
    "各城市",
    "各大城市",
    "按城市",
    "哪些城市",
    "城市之间",
    "主要城市",
    "城市排名",
    "各县",
    "县级",
    "各地区",
    "按地区",
];
/// Words that overlap a level word without asking for the level: 节省份额 is a saved share, not 省份, and 主要城市化
/// is the urbanisation of a country. A level word that overlaps one of these does not count.
const NOT_BELOW_COUNTRY_ZH: [&str; 2] = ["省份额", "城市化"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Europe,
    Beyond,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    Europe,
    World,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Estat,
    Wb,
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    /// Eurostat code, or World Bank indicator id with "@2" (source 2, WDI).
    pub id: String,
    pub title: String,
    pub score: f64,
    pub s: f64,
    pub v: f64,
    pub coverage: Coverage,
}

/// Why a question cannot be answered: it asks for `level_zh` inside `place_zh`, and neither catalog has that level there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Uncovered {
    pub place_zh: String,
    pub level_zh: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Ranking {
    pub scope: Scope,
    /// Place names found in the Chinese question (what the scope was judged from).
    pub places_zh: Vec<String>,
    /// Set when the question asks for a level the catalogs lack; `candidates` is then empty.
    pub uncovered: Option<Uncovered>,
    /// Best first; `top5` keeps 5, `rank` keeps every table that passed the filters.
    pub candidates: Vec<Candidate>,
}

struct Doc {
    id: String,
    source: Source,
    title: String,
    tf: HashMap<String, u32>,
    len: usize,
    geo: HashSet<String>,
    /// The members of its other dimensions that name a place (partner, citizen: see `place_members` in from_raw).
    places: HashSet<String>,
    /// The countries those members stand for, by iso2 (CN_X_HK is CN, EL is GR).
    reach: HashSet<String>,
}

pub struct Catalog {
    docs: Vec<Doc>,
    df: HashMap<String, usize>,
    avgdl: f64,
    coverage: Vec<Coverage>,
    /// (dim, code) -> label tokens, its lidf total, and the tables that use it.
    members: Vec<(String, HashSet<String>, f64, Vec<usize>)>,
    lidf: HashMap<String, f64>,
    inv: HashMap<String, Vec<usize>>,
    place_estat: HashMap<String, String>,
    /// English place name -> the codes that stand for it, in geo or a place-valued dimension: its own code, and the versions
    /// of that code whose label starts with the same name (EU -> EU27_2020, EU28; EA -> EA20; China -> CN_X_HK), so a table
    /// listing only those still has the place.
    place_codes: HashMap<String, HashSet<String>>,
    place_wb: HashSet<String>,
    /// English place name (either catalog) -> iso2.
    place_iso: HashMap<String, String>,
    max_place_words: usize,
    europe: HashSet<String>,
    /// Countries with regions below the country (the NUTS table).
    regional: HashSet<String>,
    /// Chinese place names, longest first, with their iso2 code, REGION or NOT_PLACE.
    zh_names: Vec<(Vec<char>, String)>,
    /// What the fetch parameters are filled from (`table`): the metabase lines whole, scanned for one table when it is
    /// picked; member labels by dim in codelist order; the TOC's last data year of each Eurostat table; the World Bank's
    /// countries (aggregates left out) as (iso2, id).
    metabase: String,
    labels: BTreeMap<String, Vec<(String, String)>>,
    end_year: HashMap<String, i32>,
    wb_places: Vec<(String, String)>,
    /// dim -> its place-valued members outside geo and time (`place_members` in from_raw).
    place_members: HashMap<String, HashSet<String>>,
}

/// One catalogue table as the fetch parameters are filled from it.
#[derive(Clone, Debug, PartialEq)]
pub struct TableMeta {
    /// The catalogue id: a Eurostat code, or a World Bank indicator with "@2".
    pub id: String,
    pub worldbank: bool,
    /// Eurostat: every dimension the metabase lists for the table but time, with its codes as (code, English label) in
    /// the order the metabase gives them (a code with no label keeps an empty one). World Bank: none.
    pub dims: Vec<(String, Vec<(String, String)>)>,
    /// Eurostat: the TOC's "data end" year. World Bank: none (the catalogue has no years).
    pub end_year: Option<i32>,
    /// World Bank: the countries as (iso2, id), aggregates left out. Eurostat: none (its places are the geo codes).
    pub places: Vec<(String, String)>,
    /// Eurostat: each dimension but geo and time that lists countries (partner, citizen), with those codes as (code, iso2)
    /// in the table's order (partner CN_X_HK is CN, EL is GR). World Bank: none.
    pub place_members: Vec<(String, Vec<(String, String)>)>,
}

/// A place the Chinese question names: a country's iso2 code, or a region word (the EU, Europe ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    Country(String),
    Region,
}

/// The original files, already read. `cl` is (dim, file text).
pub struct Raw {
    pub toc: String,
    pub metabase: String,
    pub cl: Vec<(String, String)>,
    pub wb_indicators: serde_json::Value,
    pub wb_countries: serde_json::Value,
    pub wb_countries_zh: serde_json::Value,
    pub nuts: String,
}

impl Raw {
    pub fn read(dir: &Path) -> Result<Raw> {
        let text = |name: &str| {
            std::fs::read_to_string(dir.join(name)).with_context(|| format!("read {name}"))
        };
        let json =
            |name: &str| -> Result<serde_json::Value> { Ok(serde_json::from_str(&text(name)?)?) };
        let mut cl = Vec::new();
        for entry in std::fs::read_dir(dir.join("cl")).context("read cl/")? {
            let path = entry?.path();
            if let Some(dim) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".tsv"))
            {
                cl.push((dim.to_string(), std::fs::read_to_string(&path)?));
            }
        }
        cl.sort();
        let nuts =
            String::from_utf8_lossy(&std::fs::read(dir.join("nuts-2024-at.csv"))?).into_owned();
        Ok(Raw {
            toc: text("toc.txt")?,
            metabase: text("metabase.txt")?,
            cl,
            wb_indicators: json("wb-indicators.json")?,
            wb_countries: json("wb-countries.json")?,
            wb_countries_zh: json("wb-countries-zh.json")?,
            nuts,
        })
    }
}

/// Lines as Python's text mode gives them (\r\n, \r and \n all end a line).
fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split_inclusive(['\n', '\r'])
        .scan(false, |after_cr, piece| {
            let skip = *after_cr && piece == "\n";
            *after_cr = piece.ends_with('\r');
            Some(if skip {
                None
            } else {
                Some(piece.trim_end_matches(['\n', '\r']))
            })
        })
        .flatten()
}

fn words(s: &str, digits: bool) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || (digits && c.is_ascii_digit())))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Search tokens: lower-case words, stop words dropped, plain plural endings cut.
pub fn toks(s: &str) -> Vec<String> {
    let stop: HashSet<&str> = STOP.split(' ').collect();
    words(s, true)
        .into_iter()
        .filter(|w| !stop.contains(w.as_str()))
        .map(|w| {
            if w.len() > 4 && w.ends_with("ies") {
                format!("{}y", &w[..w.len() - 3])
            } else if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
                w[..w.len() - 1].to_string()
            } else {
                w
            }
        })
        .collect()
}

/// A place name as matched in English text: lower case, "(...)" removed, letters only.
/// `code` is `own` or a version of it: `own`, digits, and at most an underscore and digits (EU27_2020, EU28, EA20); the
/// context-changing aggregate (EU_V); or `own` except a two-letter place (CN_X_HK, China except Hong Kong: the code keeps its
/// own label, the name tables never read it as CN). Not-allocated, capital or split codes (DE_NAL, DE_CAP, RS_ME) are other places.
fn versioned_of(code: &str, own: &str) -> bool {
    let Some(rest) = code.strip_prefix(own) else {
        return false;
    };
    if rest == "_V"
        || rest
            .strip_prefix("_X_")
            .is_some_and(|other| other.len() == 2 && other.bytes().all(|b| b.is_ascii_uppercase()))
    {
        return true;
    }
    let (count, year) = rest.split_once('_').unwrap_or((rest, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    digits(count) && digits(year) && (year.is_empty() || !count.is_empty()) && !rest.ends_with('_')
}

fn norm_place(s: &str) -> String {
    let s = s.to_lowercase();
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(open) = rest.find('(') {
        match rest[open..].find(')') {
            Some(close) => {
                out.push_str(&rest[..open]);
                rest = &rest[open + close + 1..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    words(&out, false).join(" ")
}

fn list(v: &serde_json::Value) -> &[serde_json::Value] {
    v.get(1)
        .and_then(|l| l.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn field<'a>(x: &'a serde_json::Value, path: &[&str]) -> &'a str {
    path.iter().fold(x, |x, k| &x[*k]).as_str().unwrap_or("")
}

/// The country a place-valued member stands for: its own code before an "_X_" qualifier, as iso2 (CN_X_HK is CN).
fn member_iso(code: &str) -> &str {
    estat_iso(code.split_once("_X_").map_or(code, |(own, _)| own))
}

fn estat_iso(code: &str) -> &str {
    ESTAT_ISO
        .iter()
        .find(|(e, _)| *e == code)
        .map(|(_, i)| *i)
        .unwrap_or(code)
}

fn unquote(f: &str) -> &str {
    f.strip_prefix('"')
        .and_then(|f| f.strip_suffix('"'))
        .unwrap_or(f)
}

fn counts(tokens: &[String]) -> HashMap<String, u32> {
    let mut tf = HashMap::new();
    for t in tokens {
        *tf.entry(t.clone()).or_insert(0) += 1;
    }
    tf
}

impl Catalog {
    pub fn load(dir: &Path) -> Result<Catalog> {
        Ok(Catalog::from_raw(&Raw::read(dir)?))
    }

    pub fn from_raw(raw: &Raw) -> Catalog {
        let mut labels: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for (dim, text) in &raw.cl {
            // first position, last label (a Python dict)
            let m = labels.entry(dim.clone()).or_default();
            let mut at: HashMap<&str, usize> = HashMap::new();
            for line in lines(text) {
                let p: Vec<&str> = line.split('\t').collect();
                if p.len() >= 2 {
                    match at.get(p[0]) {
                        Some(&k) => m[k].1 = p[1].to_string(),
                        None => {
                            at.insert(p[0], m.len());
                            m.push((p[0].to_string(), p[1].to_string()));
                        }
                    }
                }
            }
        }
        // used[table][dim] = codes (as a set: every use below takes the set)
        let mut used: HashMap<String, BTreeMap<String, HashSet<String>>> = HashMap::new();
        for line in lines(&raw.metabase) {
            let mut p = line.split('\t');
            if let (Some(t), Some(d), Some(c)) = (p.next(), p.next(), p.next()) {
                used.entry(t.into())
                    .or_default()
                    .entry(d.into())
                    .or_default()
                    .insert(c.into());
            }
        }

        let mut place_estat = HashMap::new();
        for (code, lab) in labels.get("geo").map(Vec::as_slice).unwrap_or(&[]) {
            let n = norm_place(lab);
            if code.chars().count() == 2 && !n.is_empty() {
                place_estat.insert(n, code.clone());
            }
        }
        let mut place_codes: HashMap<String, HashSet<String>> = HashMap::new();
        for (code, lab) in labels.get("geo").map(Vec::as_slice).unwrap_or(&[]) {
            let label = norm_place(lab);
            let w: Vec<&str> = label.split(' ').collect();
            for k in 1..=w.len() {
                let name = w[..k].join(" ");
                if place_estat
                    .get(&name)
                    .is_some_and(|own| versioned_of(code, own))
                {
                    place_codes.entry(name).or_default().insert(code.clone());
                }
            }
        }
        let wb: Vec<&serde_json::Value> = list(&raw.wb_countries)
            .iter()
            .filter(|x| field(x, &["region", "value"]).trim() != "Aggregates")
            .collect();
        let place_wb: HashSet<String> =
            wb.iter().map(|x| norm_place(field(x, &["name"]))).collect();
        let mut place_iso: HashMap<String, String> = place_estat
            .iter()
            .map(|(n, c)| (n.clone(), estat_iso(c).to_string()))
            .collect();
        for x in &wb {
            place_iso
                .entry(norm_place(field(x, &["name"])))
                .or_insert_with(|| field(x, &["iso2Code"]).to_string());
        }
        let max_place_words = place_estat
            .keys()
            .chain(place_wb.iter())
            .map(|p| p.split(' ').count())
            .max()
            .unwrap_or(1);
        // dim -> its place-valued members outside geo and time: the label starts with a place name (either catalog) and the
        // code is that place's own or a version of it (partner CN_X_HK "China except Hong Kong" is China; a unit NR "Number"
        // names no place). A table whose geo is the EU alone still has the countries it lists as partners or citizens.
        let mut place_members: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (dim, m) in &labels {
            if SKIP_DIMS.contains(&dim.as_str()) {
                continue;
            }
            for (code, lab) in m {
                let label = norm_place(lab);
                let w: Vec<&str> = label.split(' ').collect();
                for k in 1..=w.len().min(max_place_words) {
                    let name = w[..k].join(" ");
                    if place_estat
                        .get(&name)
                        .or_else(|| place_iso.get(&name))
                        .is_some_and(|own| versioned_of(code, own))
                    {
                        place_members
                            .entry(dim.as_str())
                            .or_default()
                            .insert(code.as_str());
                        place_codes.entry(name).or_default().insert(code.clone());
                    }
                }
            }
        }

        // Europe = the World Bank's "Europe & Central Asia" plus every country of the NUTS 2024 table
        let countries: HashSet<String> = wb
            .iter()
            .map(|x| field(x, &["iso2Code"]).to_string())
            .collect();
        let wb_places: Vec<(String, String)> = wb
            .iter()
            .map(|x| {
                (
                    field(x, &["iso2Code"]).to_string(),
                    field(x, &["id"]).to_string(),
                )
            })
            .collect();
        let mut europe: HashSet<String> = wb
            .iter()
            .filter(|x| field(x, &["region", "value"]).trim() == "Europe & Central Asia")
            .map(|x| field(x, &["iso2Code"]).to_string())
            .collect();
        let nuts = raw.nuts.strip_prefix('\u{feff}').unwrap_or(&raw.nuts);
        let regional: HashSet<String> = nuts
            .lines()
            .skip(1)
            .map(|line| {
                estat_iso(line.trim_end_matches('\r').split(',').next().unwrap_or("")).to_string()
            })
            .collect();
        europe.extend(regional.iter().cloned());

        let mut zh: Vec<(String, String)> = Vec::new();
        let mut put = |name: &str, code: &str| match zh.iter_mut().find(|(n, _)| n == name) {
            Some(e) => e.1 = code.to_string(),
            None => zh.push((name.to_string(), code.to_string())),
        };
        for x in list(&raw.wb_countries_zh) {
            if countries.contains(field(x, &["iso2Code"])) {
                put(field(x, &["name"]), field(x, &["iso2Code"]));
            }
        }
        for w in REGION_WORDS_ZH {
            put(w, REGION);
        }
        for w in NOT_PLACE_ZH {
            put(w, NOT_PLACE);
        }
        let mut zh_names: Vec<(Vec<char>, String)> = zh
            .into_iter()
            .map(|(n, c)| (n.chars().collect(), c))
            .collect();
        zh_names.sort_by_key(|(n, _)| std::cmp::Reverse(n.len()));

        // documents: Eurostat tables from the TOC (first entry wins), then World Bank source 2
        let mut docs = Vec::new();
        let mut seen = HashSet::new();
        let mut end_year = HashMap::new();
        let mut stack: Vec<String> = Vec::new();
        for line in lines(&raw.toc).skip(1) {
            let r: Vec<&str> = line.split('\t').map(unquote).collect();
            if r.len() < 3 {
                continue;
            }
            let depth = (r[0].len() - r[0].trim_start_matches(' ').len()) / 4;
            let title = r[0].trim();
            stack.truncate(depth);
            if r[2] == "folder" {
                stack.push(title.to_string());
                continue;
            }
            if !seen.insert(r[1].to_string()) {
                continue;
            }
            let mut t = toks(title);
            t.extend(toks(title));
            t.extend(toks(
                &stack.iter().skip(1).cloned().collect::<Vec<_>>().join(" "),
            ));
            if let Some(end) = r
                .get(6)
                .and_then(|e| e.get(..4))
                .and_then(|y| y.parse::<i32>().ok())
            {
                end_year.insert(r[1].to_string(), end);
            }
            let geo = used
                .get(r[1])
                .and_then(|d| d.get("geo"))
                .cloned()
                .unwrap_or_default();
            let places: HashSet<String> = used
                .get(r[1])
                .into_iter()
                .flatten()
                .flat_map(|(dim, codes)| {
                    let members = place_members.get(dim.as_str());
                    codes
                        .iter()
                        .filter(move |c| members.is_some_and(|m| m.contains(c.as_str())))
                })
                .cloned()
                .collect();
            let reach = places.iter().map(|c| member_iso(c).to_string()).collect();
            docs.push(Doc {
                id: r[1].to_string(),
                source: Source::Estat,
                title: title.to_string(),
                tf: counts(&t),
                len: t.len(),
                geo,
                places,
                reach,
            });
        }
        for x in list(&raw.wb_indicators) {
            if field(x, &["source", "id"]) != "2" {
                continue;
            }
            let name = field(x, &["name"]);
            let topics: Vec<&str> = x["topics"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|t| t["value"].as_str().unwrap_or(""))
                        .filter(|v| !v.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let mut t = toks(name);
            t.extend(toks(name));
            t.extend(toks(&format!("{name} {}", topics.join(" "))));
            t.extend(toks(field(x, &["source", "value"])));
            docs.push(Doc {
                id: format!("{}@2", field(x, &["id"])),
                source: Source::Wb,
                title: name.to_string(),
                tf: counts(&t),
                len: t.len(),
                geo: HashSet::new(),
                places: HashSet::new(),
                reach: HashSet::new(),
            });
        }
        let mut df: HashMap<String, usize> = HashMap::new();
        for d in &docs {
            for w in d.tf.keys() {
                *df.entry(w.clone()).or_insert(0) += 1;
            }
        }
        let avgdl = docs.iter().map(|d| d.len).sum::<usize>() as f64 / docs.len().max(1) as f64;
        let coverage = docs
            .iter()
            .map(|d| match d.source {
                Source::Wb => Coverage::World,
                Source::Estat if d.geo.is_empty() => Coverage::Unknown,
                Source::Estat => {
                    let n = d
                        .geo
                        .iter()
                        .filter(|c| c.chars().count() == 2)
                        .map(|c| estat_iso(c))
                        .filter(|c| countries.contains(*c) && !europe.contains(*c))
                        .count();
                    if n >= WORLD_MIN {
                        Coverage::World
                    } else {
                        Coverage::Europe
                    }
                }
            })
            .collect();

        // member labels (every dim but geo and time)
        let idx_of: HashMap<&str, usize> = docs
            .iter()
            .enumerate()
            .map(|(i, d)| (d.id.as_str(), i))
            .collect();
        let mut members = Vec::new();
        let mut key_of: HashMap<(String, String), usize> = HashMap::new();
        for (dim, m) in &labels {
            if SKIP_DIMS.contains(&dim.as_str()) {
                continue;
            }
            for (code, lab) in m {
                let t: HashSet<String> = toks(lab).into_iter().collect();
                if !t.is_empty() {
                    key_of.insert((dim.clone(), code.clone()), members.len());
                    members.push((dim.clone(), t, 0.0, Vec::new()));
                }
            }
        }
        let mut ldf: HashMap<String, usize> = HashMap::new();
        for (_, t, _, _) in &members {
            for w in t {
                *ldf.entry(w.clone()).or_insert(0) += 1;
            }
        }
        let m_count = members.len() as f64;
        let lidf: HashMap<String, f64> = ldf
            .iter()
            .map(|(w, &n)| {
                (
                    w.clone(),
                    (1.0 + (m_count - n as f64 + 0.5) / (n as f64 + 0.5)).ln(),
                )
            })
            .collect();
        let mut inv: HashMap<String, Vec<usize>> = HashMap::new();
        for (k, (_, t, total, _)) in members.iter_mut().enumerate() {
            *total = t.iter().map(|w| lidf[w]).sum();
            for w in t.iter() {
                inv.entry(w.clone()).or_default().push(k);
            }
        }
        for (table, dims) in &used {
            let Some(&i) = idx_of.get(table.as_str()) else {
                continue;
            };
            for (dim, codes) in dims {
                if SKIP_DIMS.contains(&dim.as_str()) {
                    continue;
                }
                for c in codes {
                    if let Some(&k) = key_of.get(&(dim.clone(), c.clone())) {
                        members[k].3.push(i);
                    }
                }
            }
        }
        let place_members = place_members
            .into_iter()
            .map(|(dim, codes)| {
                (
                    dim.to_string(),
                    codes.into_iter().map(str::to_string).collect(),
                )
            })
            .collect();
        Catalog {
            docs,
            df,
            avgdl,
            coverage,
            members,
            lidf,
            inv,
            place_estat,
            place_codes,
            place_wb,
            place_iso,
            max_place_words,
            europe,
            regional,
            zh_names,
            metabase: raw.metabase.clone(),
            labels,
            end_year,
            wb_places,
            place_members,
        }
    }

    /// The table with this catalogue id, as the fetch parameters are filled from it; None when the catalogue has no such table.
    pub fn table(&self, id: &str) -> Option<TableMeta> {
        if id.ends_with("@2") {
            return self
                .docs
                .iter()
                .any(|d| d.source == Source::Wb && d.id == id)
                .then(|| TableMeta {
                    id: id.to_string(),
                    worldbank: true,
                    dims: Vec::new(),
                    end_year: None,
                    places: self.wb_places.clone(),
                    place_members: Vec::new(),
                });
        }
        let mut dims: Vec<(String, Vec<String>)> = Vec::new();
        for line in lines(&self.metabase) {
            let mut p = line.split('\t');
            let (Some(t), Some(d), Some(c)) = (p.next(), p.next(), p.next()) else {
                continue;
            };
            if t != id || d == "time" {
                continue;
            }
            match dims.iter_mut().find(|(dim, _)| dim == d) {
                Some((_, codes)) => {
                    if !codes.iter().any(|x| x == c) {
                        codes.push(c.to_string());
                    }
                }
                None => dims.push((d.to_string(), vec![c.to_string()])),
            }
        }
        if dims.is_empty() {
            return None;
        }
        let place_members = dims
            .iter()
            .filter(|(dim, _)| !SKIP_DIMS.contains(&dim.as_str()))
            .filter_map(|(dim, codes)| {
                let members = self.place_members.get(dim)?;
                let countries: Vec<(String, String)> = codes
                    .iter()
                    .filter(|c| members.contains(c.as_str()))
                    .map(|c| (c.clone(), member_iso(c).to_string()))
                    .filter(|(_, iso)| {
                        iso.len() == 2 && iso.bytes().all(|b| b.is_ascii_uppercase())
                    })
                    .collect();
                (!countries.is_empty()).then(|| (dim.clone(), countries))
            })
            .collect();
        let label = |dim: &str, code: &str| {
            self.labels
                .get(dim)
                .and_then(|m| m.iter().find(|(c, _)| c == code))
                .map(|(_, l)| l.clone())
                .unwrap_or_default()
        };
        Some(TableMeta {
            id: id.to_string(),
            worldbank: false,
            dims: dims
                .into_iter()
                .map(|(dim, codes)| {
                    let labelled = codes
                        .into_iter()
                        .map(|c| {
                            let l = label(&dim, &c);
                            (c, l)
                        })
                        .collect();
                    (dim, labelled)
                })
                .collect(),
            end_year: self.end_year.get(id).copied(),
            places: Vec::new(),
            place_members,
        })
    }

    /// The places the Chinese question names, in question order: countries by iso2, region words as Region.
    pub fn places(&self, question_zh: &str) -> Vec<Place> {
        self.places_zh(question_zh)
            .into_iter()
            .map(|(_, c)| {
                if c == REGION {
                    Place::Region
                } else {
                    Place::Country(c)
                }
            })
            .collect()
    }

    /// Place names in the Chinese question, longest name first at each position; a NOT_PLACE word is skipped whole.
    fn places_zh(&self, text: &str) -> Vec<(String, String)> {
        let chars: Vec<char> = text.chars().collect();
        let mut found = Vec::new();
        let mut i = 0;
        let among = |i: usize| {
            chars[i] == '中'
                && i > 0
                && AMONG_BEFORE_ZH.contains(chars[i - 1])
                && GUO_WORDS_ZH
                    .iter()
                    .any(|w| chars[i + 1..].starts_with(&w.chars().collect::<Vec<_>>()))
        };
        while i < chars.len() {
            if among(i) {
                i += 1;
                continue;
            }
            match self
                .zh_names
                .iter()
                .find(|(n, _)| chars[i..].starts_with(n))
            {
                Some((n, code)) => {
                    if code != NOT_PLACE {
                        found.push((n.iter().collect(), code.clone()));
                    }
                    i += n.len();
                }
                None => i += 1,
            }
        }
        found
    }

    /// Europe only when the question names places and every one is European (or the EU, Europe, the euro area).
    pub fn scope(&self, question_zh: &str) -> (Scope, Vec<String>) {
        let found = self.places_zh(question_zh);
        let europe = !found.is_empty()
            && found
                .iter()
                .all(|(_, c)| c == REGION || self.europe.contains(c));
        (
            if europe { Scope::Europe } else { Scope::Beyond },
            found.into_iter().map(|(n, _)| n).collect(),
        )
    }

    /// A level below the country asked for in a named country that has no regions in either catalog. Judged from the
    /// Chinese question alone, so it is known before any search.
    pub fn uncovered(&self, question_zh: &str) -> Option<Uncovered> {
        let not: Vec<(usize, usize)> = NOT_BELOW_COUNTRY_ZH
            .iter()
            .flat_map(|n| {
                question_zh
                    .match_indices(*n)
                    .map(|(at, m)| (at, at + m.len()))
            })
            .collect();
        let level = BELOW_COUNTRY_ZH.iter().find(|w| {
            question_zh
                .match_indices(*w)
                .any(|(at, m)| !not.iter().any(|&(a, b)| at < b && a < at + m.len()))
        })?;
        let (place, _) = self
            .places_zh(question_zh)
            .into_iter()
            .find(|(_, c)| c != REGION && !self.regional.contains(c))?;
        Some(Uncovered {
            place_zh: place,
            level_zh: level.to_string(),
        })
    }

    /// English place names in the search texts that the Chinese question does not name, each once, in text order.
    /// A name is inside when its iso2 is a country the question names, or when the question names a region word (欧盟,
    /// 欧洲 ...) and the country is in Europe. English region words (europe, eu) are not place names in either catalog,
    /// so they are never returned.
    pub fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
        let named = self.places_zh(question_zh);
        let region = named.iter().any(|(_, c)| c == REGION);
        let inside = |iso: &String| {
            named.iter().any(|(_, c)| c == iso) || (region && self.europe.contains(iso))
        };
        let mut out: Vec<String> = Vec::new();
        for t in texts {
            for p in self.split_places(t).0 {
                if !self.place_iso.get(&p).is_some_and(inside) && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// English place names in a search text (longest match), and the text without them.
    fn split_places(&self, text: &str) -> (Vec<String>, String) {
        let w = words(text, true);
        let (mut found, mut keep, mut i) = (Vec::new(), Vec::new(), 0);
        'outer: while i < w.len() {
            for n in (1..=self.max_place_words).rev() {
                if i + n <= w.len() {
                    let g = w[i..i + n].join(" ");
                    if self.place_estat.contains_key(&g) || self.place_wb.contains(&g) {
                        found.push(g);
                        i += n;
                        continue 'outer;
                    }
                }
            }
            keep.push(w[i].clone());
            i += 1;
        }
        (found, keep.join(" "))
    }

    /// A named place must be in the table's geo or a place-valued dimension. Beyond Europe drops a table that covers only
    /// Europe, unless a place-valued dimension holds a country beyond Europe the question names (the EU's trade with China:
    /// geo is the EU, China a partner). `far` is that list, by iso2.
    fn passes(&self, i: usize, places: &[String], scope: Scope, far: &[String]) -> bool {
        let d = &self.docs[i];
        let place_ok = places.iter().all(|p| match d.source {
            Source::Estat => self.place_codes.get(p).is_some_and(|codes| {
                codes
                    .iter()
                    .any(|c| d.geo.contains(c) || d.places.contains(c))
            }),
            Source::Wb => self.place_wb.contains(p),
        });
        let europe_only =
            self.coverage[i] == Coverage::Europe && !far.iter().any(|c| d.reach.contains(c));
        place_ok && !(scope == Scope::Beyond && europe_only)
    }

    fn s_scores(&self, qt: &[String], ok: &[bool], s: &mut HashMap<usize, f64>) {
        let n = self.docs.len() as f64;
        for (i, d) in self.docs.iter().enumerate() {
            if !ok[i] {
                continue;
            }
            let mut sc = 0.0;
            for w in qt {
                if let Some(&tf) = d.tf.get(w) {
                    let df = self.df[w] as f64;
                    let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
                    let tf = tf as f64;
                    sc += idf * tf * (K1 + 1.0)
                        / (tf + K1 * (1.0 - B + B * d.len as f64 / self.avgdl));
                }
            }
            *s.entry(i).or_insert(0.0) += sc;
        }
    }

    fn v_scores(&self, qt: &[String], ok: &[bool], v: &mut HashMap<usize, f64>) {
        let q: HashSet<&String> = qt.iter().collect();
        let mut cand: Vec<usize> = q
            .iter()
            .flat_map(|w| self.inv.get(*w).into_iter().flatten().copied())
            .collect();
        cand.sort_unstable();
        cand.dedup();
        let mut best: HashMap<(usize, &str), f64> = HashMap::new();
        for k in cand {
            let (dim, t, total, tabs) = &self.members[k];
            let matched: f64 = t
                .iter()
                .filter(|w| q.contains(w))
                .map(|w| self.lidf[w])
                .sum();
            let ms = matched * matched / total;
            if ms <= 0.0 {
                continue;
            }
            for &i in tabs {
                let b = best.entry((i, dim.as_str())).or_insert(0.0);
                if ok[i] && ms > *b {
                    *b = ms;
                }
            }
        }
        for ((i, _), b) in best {
            if b > 0.0 {
                *v.entry(i).or_insert(0.0) += b;
            }
        }
    }

    /// Every table that passes the filters, best first, for these search texts under a given scope.
    /// Several texts add up: S and V are each summed over the texts before they are combined.
    pub fn rank_in(&self, texts: &[String], scope: Scope) -> Vec<Candidate> {
        self.rank_reaching(texts, scope, &[])
    }

    /// `rank_in` for a question that names the countries `far` beyond Europe (iso2).
    fn rank_reaching(&self, texts: &[String], scope: Scope, far: &[String]) -> Vec<Candidate> {
        let (mut s, mut v) = (HashMap::new(), HashMap::new());
        for text in texts {
            let (places, rest) = self.split_places(text);
            let ok: Vec<bool> = (0..self.docs.len())
                .map(|i| self.passes(i, &places, scope, far))
                .collect();
            let qt = toks(&rest);
            self.s_scores(&qt, &ok, &mut s);
            self.v_scores(&qt, &ok, &mut v);
        }
        let max_s = s.values().copied().fold(0.0, f64::max);
        let max_v = s
            .keys()
            .map(|i| v.get(i).copied().unwrap_or(0.0))
            .fold(0.0, f64::max);
        let mut out: Vec<Candidate> = s
            .iter()
            .map(|(&i, &si)| {
                let vi = v.get(&i).copied().unwrap_or(0.0);
                let fin = (if max_s > 0.0 { si / max_s } else { 0.0 })
                    + LAMBDA * (if max_v > 0.0 { vi / max_v } else { 0.0 });
                let d = &self.docs[i];
                Candidate {
                    id: d.id.clone(),
                    title: d.title.clone(),
                    score: fin,
                    s: si,
                    v: vi,
                    coverage: self.coverage[i],
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(b.s.total_cmp(&a.s))
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    /// The full order for a question: scope from the Chinese question, ranking from the English search texts. No
    /// ranking when the question is uncovered.
    pub fn rank(&self, question_zh: &str, texts: &[String]) -> Ranking {
        let (scope, places_zh) = self.scope(question_zh);
        let uncovered = self.uncovered(question_zh);
        let far: Vec<String> = self
            .places_zh(question_zh)
            .into_iter()
            .map(|(_, c)| c)
            .filter(|c| c != REGION && !self.europe.contains(c))
            .collect();
        let candidates = if uncovered.is_some() {
            Vec::new()
        } else {
            self.rank_reaching(texts, scope, &far)
        };
        Ranking {
            scope,
            places_zh,
            uncovered,
            candidates,
        }
    }

    pub fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
        let mut r = self.rank(question_zh, texts);
        r.candidates.truncate(TOP);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn texts(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| s.to_string()).collect()
    }

    fn ids(c: &[Candidate]) -> Vec<&str> {
        c.iter().map(|c| c.id.as_str()).collect()
    }

    /// Four Eurostat tables and one World Bank indicator. nrg_world reaches 10 non-European countries; nrg_none has no geo.
    fn small() -> Catalog {
        let toc = "\"title\"\t\"code\"\t\"type\"\n\"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"    Energy\"\t\"nrg\"\t\"folder\"\n\
                   \"        Energy balance\"\t\"nrg_bal\"\t\"table\"\n\
                   \"        Energy balance\"\t\"nrg_src\"\t\"table\"\n\
                   \"        Energy balance\"\t\"nrg_bal\"\t\"table\"\n\
                   \"        Energy prices\"\t\"nrg_world\"\t\"table\"\n\
                   \"        Energy stock\"\t\"nrg_none\"\t\"table\"\n";
        let far = ["CN", "US", "JP", "IN", "BR", "CA", "AU", "MX", "KR", "ZA"];
        let mut metabase = String::from(
            "nrg_bal\tgeo\tDE\nnrg_bal\tgeo\tFR\nnrg_src\tgeo\tFR\nnrg_src\tsiec\tSOL\n",
        );
        for c in far {
            metabase.push_str(&format!("nrg_world\tgeo\t{c}\n"));
        }
        let mut geo = String::from("DE\tGermany\r\nFR\tFrance\r\nXK\tKosovo*\r\n");
        let mut countries = vec![
            json!({"id": "DEU", "iso2Code": "DE", "name": "Germany", "region": {"value": "Europe & Central Asia"}}),
            json!({"id": "FRA", "iso2Code": "FR", "name": "France", "region": {"value": "Europe & Central Asia"}}),
            json!({"id": "MLT", "iso2Code": "MT", "name": "Malta", "region": {"value": "Middle East & North Africa"}}),
            json!({"id": "WLD", "iso2Code": "1W", "name": "World", "region": {"value": "Aggregates "}}),
            json!({"id": "FIN", "iso2Code": "FI", "name": "Finland", "region": {"value": "Europe & Central Asia"}}),
            json!({"id": "HTI", "iso2Code": "HT", "name": "Haiti", "region": {"value": "Elsewhere"}}),
            json!({"id": "GHA", "iso2Code": "GH", "name": "Ghana", "region": {"value": "Elsewhere"}}),
            json!({"id": "GUM", "iso2Code": "GU", "name": "Guam", "region": {"value": "Elsewhere"}}),
            json!({"id": "SST", "iso2Code": "S1", "name": "Small states", "region": {"value": "Aggregates "}}),
        ];
        for c in far {
            geo.push_str(&format!("{c}\tLand {c}\r\n"));
            countries.push(json!({"id": c, "iso2Code": c, "name": format!("Land {c}"), "region": {"value": "Elsewhere"}}));
        }
        Catalog::from_raw(&Raw {
            toc: toc.into(),
            metabase,
            cl: vec![
                ("geo".into(), geo),
                (
                    "siec".into(),
                    "SOL\tSolar photovoltaic\r\nTOTAL\tTotal\r\n".into(),
                ),
            ],
            wb_indicators: json!([{}, [
                {"id": "EG.USE", "name": "Energy use", "source": {"id": "2", "value": "World Development Indicators"}, "topics": [{"value": "Energy & Mining"}]},
                {"id": "OTHER", "name": "Energy use", "source": {"id": "11", "value": "Other"}, "topics": []}
            ]]),
            wb_countries: json!([{}, countries]),
            wb_countries_zh: json!([{}, [
                {"iso2Code": "DE", "name": "德国"}, {"iso2Code": "MT", "name": "马耳他"}, {"iso2Code": "CN", "name": "中国"},
                {"iso2Code": "1W", "name": "世界"}, {"iso2Code": "FR", "name": "法国"}, {"iso2Code": "FI", "name": "芬兰"},
                {"iso2Code": "HT", "name": "海地"}, {"iso2Code": "GH", "name": "加纳"}, {"iso2Code": "ZA", "name": "南非"},
                {"iso2Code": "IN", "name": "印度"}, {"iso2Code": "GU", "name": "关岛"}, {"iso2Code": "S1", "name": "小国"},
                {"iso2Code": "JP", "name": "日本"}, {"iso2Code": "US", "name": "美国"}
            ]]),
            nuts: "\u{feff}CNTR_CODE,NUTS_ID\r\nMT,MT00\r\nEL,EL30\r\nDE,DE1\r\n".into(),
        })
    }

    #[test]
    fn places_the_question_does_not_name_are_outside() {
        let c = small();
        let t = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(c
            .places_outside("德国和法国", &t(&["germany france electricity"]))
            .is_empty());
        assert_eq!(
            c.places_outside("德国和法国", &t(&["land jp electricity"])),
            ["land jp"]
        );
        assert_eq!(
            c.places_outside("德国电价", &t(&["france power", "france gas"])),
            ["france"],
            "once each"
        );
        assert!(
            c.places_outside("欧盟电价", &t(&["germany finland electricity"]))
                .is_empty(),
            "European under a region"
        );
        assert_eq!(
            c.places_outside("欧盟电价", &t(&["land cn electricity"])),
            ["land cn"]
        );
        assert!(
            c.places_outside("德国电价", &t(&["europe eu electricity"]))
                .is_empty(),
            "region words are no places"
        );
    }

    #[test]
    fn tokens_drop_stop_words_and_plain_plurals() {
        assert_eq!(
            toks("Shares of the Industries, glass & CO2"),
            ["share", "industry", "glass", "co2"]
        );
        assert_eq!(norm_place("Korea, Rep. (South) (x"), "korea rep x");
        assert_eq!(
            lines("a\r\nb\rc\n\nd").collect::<Vec<_>>(),
            ["a", "b", "c", "", "d"]
        );
    }

    #[test]
    fn scope_is_europe_only_when_every_named_place_is() {
        let c = small();
        assert_eq!(
            c.scope("德国能源从来源到各部门"),
            (Scope::Europe, texts(&["德国"]))
        );
        assert_eq!(c.scope("欧盟各国可再生能源占比").0, Scope::Europe);
        assert_eq!(
            c.scope("马耳他人口").0,
            Scope::Europe,
            "Malta is European through the NUTS table"
        );
        assert_eq!(c.scope("中国和德国").0, Scope::Beyond);
        assert_eq!(
            c.scope("各国 65 岁以上人口比例").0,
            Scope::Beyond,
            "no place named"
        );
        assert_eq!(
            c.scope("世界人口").0,
            Scope::Beyond,
            "aggregates are not places"
        );
    }

    /// The five questions of review seg3-l5geo-v1: a place name read across a word boundary must not decide the scope.
    #[test]
    fn a_name_inside_another_word_does_not_decide_the_scope() {
        let c = small();
        assert_eq!(
            c.scope("北海地区的海上风电装机容量"),
            (Scope::Europe, texts(&["北海"]))
        );
        assert_eq!(
            c.scope("沿海地区人口密度最高的欧盟国家"),
            (Scope::Europe, texts(&["欧盟"]))
        );
        assert_eq!(
            c.scope("德国增加纳税人的比例"),
            (Scope::Europe, texts(&["德国"]))
        );
        assert_eq!(
            c.scope("欧盟对发展中国家的援助"),
            (Scope::Europe, texts(&["欧盟"]))
        );
        assert_eq!(
            c.scope("哪些国家的可再生能源占比最高"),
            (Scope::Beyond, vec![]),
            "no place named means the world"
        );
    }

    #[test]
    fn each_not_place_word_swallows_the_name_it_holds() {
        let c = small();
        let cases: [(&str, Scope, &[&str]); 11] = [
            ("欧盟对发展中国家的援助", Scope::Europe, &["欧盟"]),
            ("中国家庭的储蓄率", Scope::Beyond, &["中国"]),
            ("法国沿海地区的房价", Scope::Europe, &["法国"]),
            ("德国增加纳税人的比例", Scope::Europe, &["德国"]),
            ("德国增加纳入医保的药品", Scope::Europe, &["德国"]),
            ("撒哈拉以南非洲的人口增长", Scope::Beyond, &[]),
            ("法国在印度洋的领地", Scope::Europe, &["法国"]),
            ("纽芬兰的渔业产量", Scope::Beyond, &[]),
            ("法国有关岛屿的旅游收入", Scope::Europe, &["法国"]),
            ("欧洲小国的人均收入", Scope::Europe, &["欧洲"]),
            ("北海道人口", Scope::Beyond, &[]),
        ];
        for (q, scope, places) in cases {
            assert_eq!(c.scope(q), (scope, texts(places)), "{q}");
        }
        assert_eq!(
            c.scope("南非和印度的电价").0,
            Scope::Beyond,
            "the names themselves still count"
        );
        assert_eq!(c.scope("关岛和芬兰").1, texts(&["关岛", "芬兰"]));
    }

    /// Review seg3-l5geo-v2: the 中 of an "among" frame must not start 中国.
    #[test]
    fn an_among_frame_keeps_its_zhong() {
        let c = small();
        let cases: [(&str, Scope, &[&str]); 12] = [
            (
                "欧洲国家中国防开支占比最高的是哪国",
                Scope::Europe,
                &["欧洲"],
            ),
            ("欧盟成员国中国内生产总值最高的", Scope::Europe, &["欧盟"]),
            ("欧盟国家中国际旅客最多的", Scope::Europe, &["欧盟"]),
            ("欧元区中国债收益率", Scope::Europe, &["欧元区"]),
            ("欧盟国家中国民收入最高", Scope::Europe, &["欧盟"]),
            ("欧洲国家中国土面积最大", Scope::Europe, &["欧洲"]),
            ("欧洲各国中国有企业占比", Scope::Europe, &["欧洲"]),
            ("欧盟国家中国游客", Scope::Beyond, &["欧盟", "中国"]),
            ("其中国际贸易占比", Scope::Beyond, &[]),
            ("中国家庭的储蓄率", Scope::Beyond, &["中国"]),
            ("德国和中国国防开支", Scope::Beyond, &["德国", "中国"]),
            ("德国增加纳米材料投资", Scope::Europe, &["德国"]),
        ];
        for (q, scope, places) in cases {
            assert_eq!(c.scope(q), (scope, texts(places)), "{q}");
        }
    }

    #[test]
    fn a_level_below_a_country_without_regions_is_uncovered() {
        let c = small();
        let un = |p: &str, l: &str| {
            Some(Uncovered {
                place_zh: p.into(),
                level_zh: l.into(),
            })
        };
        assert_eq!(c.uncovered("中国各省房价"), un("中国", "各省"));
        assert_eq!(c.uncovered("美国各州失业率"), un("美国", "各州"));
        assert_eq!(c.uncovered("日本各城市人口"), un("日本", "各城市"));
        assert_eq!(c.uncovered("中国主要城市房价"), un("中国", "主要城市"));
        assert_eq!(
            c.uncovered("日本城市人口"),
            None,
            "urban population is a national figure"
        );
        assert_eq!(
            c.uncovered("中国城市化率"),
            None,
            "the urbanisation rate is a national figure"
        );
        assert_eq!(
            c.uncovered("美国城市人口占比"),
            None,
            "a share of the national population"
        );
        assert_eq!(
            c.uncovered("中国节省份额"),
            None,
            "省份 inside 节省份额 is no level"
        );
        assert_eq!(
            c.uncovered("中国省份和节省份额"),
            un("中国", "省份"),
            "a real 省份 still counts"
        );
        assert_eq!(
            c.uncovered("中国主要城市化指标"),
            None,
            "主要城市 inside 城市化 is no level"
        );
        assert_eq!(
            c.uncovered("德国和中国各省的电价"),
            un("中国", "各省"),
            "one uncovered country is enough"
        );
        assert_eq!(
            c.uncovered("德国各州人口"),
            None,
            "Germany has NUTS regions"
        );
        assert_eq!(
            c.uncovered("欧盟各城市空气质量"),
            None,
            "a region word is not a country"
        );
        assert_eq!(
            c.uncovered("中国人均碳排放"),
            None,
            "no level below the country"
        );
        assert_eq!(c.uncovered("各国城市人口"), None, "no country named");
        assert_eq!(
            c.uncovered("美国大选民调"),
            None,
            "a topic neither catalog has is left to the table pick"
        );
        let r = c.top5("中国各省房价", &texts(&["energy"]));
        assert!(r.uncovered.is_some() && r.candidates.is_empty());
    }

    #[test]
    fn regions_and_seas_inside_europe_are_europe() {
        let c = small();
        for q in [
            "地中海国家的旅游收入",
            "波罗的海沿岸的风电",
            "北欧国家税率",
            "巴尔干移民",
            "中东欧国家的工资",
            "欧洲联盟预算",
        ] {
            assert_eq!(c.scope(q).0, Scope::Europe, "{q}");
        }
        assert_eq!(
            c.scope("日本和北欧的老龄化").0,
            Scope::Beyond,
            "every named place must be European"
        );
    }

    #[test]
    fn a_place_matches_the_versioned_aggregates_of_its_code_and_no_region_below_it() {
        let toc = "\"title\"\t\"code\"\t\"type\"\n\"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"        Greenhouse gas emissions\"\t\"ghg_eu27\"\t\"table\"\n\
                   \"        Greenhouse gas emissions\"\t\"ghg_eu28\"\t\"table\"\n\
                   \"        Greenhouse gas emissions\"\t\"ghg_ea\"\t\"table\"\n\
                   \"        Greenhouse gas emissions\"\t\"ghg_nuts\"\t\"table\"\n";
        let metabase = "ghg_eu27\tgeo\tEU27_2020\nghg_eu27\tgeo\tAT\nghg_eu28\tgeo\tEU28\nghg_ea\tgeo\tEA20\nghg_nuts\tgeo\tDE1\n";
        let geo = "EU\tEuropean Union (EU6-1958, EU9-1973, EU27-2020)\r\nEU27_2020\tEuropean Union - 27 countries (from 2020)\r\n\
                   EU28\tEuropean Union - 28 countries (2013-2020)\r\nEA\tEuro area (EA11-1999, EA20-2023)\r\n\
                   EA20\tEuro area \u{2013} 20 countries (from 2023)\r\nDE\tGermany\r\nDE1\tBaden-W\u{fc}rttemberg\r\nAT\tAustria\r\n";
        let c = Catalog::from_raw(&Raw {
            toc: toc.into(),
            metabase: metabase.into(),
            cl: vec![("geo".into(), geo.into())],
            wb_indicators: json!([{}, []]),
            wb_countries: json!([{}, []]),
            wb_countries_zh: json!([{}, []]),
            nuts: "\u{feff}CNTR_CODE,NUTS_ID\r\nDE,DE1\r\n".into(),
        });
        let mut eu = ids(&c.rank_in(&texts(&["greenhouse gas European Union"]), Scope::Europe))
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        eu.sort();
        assert_eq!(eu, ["ghg_eu27", "ghg_eu28"], "EU names EU27_2020 and EU28");
        assert_eq!(
            ids(&c.rank_in(&texts(&["greenhouse gas euro area"]), Scope::Europe)),
            ["ghg_ea"],
            "EA names EA20"
        );
        assert!(
            c.rank_in(&texts(&["greenhouse gas Germany"]), Scope::Europe)
                .is_empty(),
            "DE1 is a region of DE, not DE"
        );
    }

    #[test]
    fn a_place_version_is_the_code_and_digits_eu_v_or_an_except_code_and_never_a_not_allocated_capital_or_split_code(
    ) {
        for code in ["EU", "EU27_2020", "EU28", "EA20", "EU_V", "CN_X_HK"] {
            assert!(versioned_of(code, &code[..2]), "{code}");
        }
        for (code, own) in [
            ("DE_NAL", "DE"),
            ("DE_CAP", "DE"),
            ("RS_ME", "RS"),
            ("CN_X_H", "CN"),
            ("EU_", "EU"),
            ("EU_2020", "EU"),
            ("EU_VV", "EU"),
        ] {
            assert!(!versioned_of(code, own), "{code}");
        }
    }

    #[test]
    fn a_named_place_filters_tables_and_is_not_a_search_word() {
        let c = small();
        let r = c.rank_in(&texts(&["energy balance Germany"]), Scope::Europe);
        assert_eq!(
            ids(&r),
            ["nrg_bal", "EG.USE@2"],
            "nrg_src has no DE; the World Bank has Germany"
        );
        let r = c.rank_in(&texts(&["energy Kosovo"]), Scope::Europe);
        assert!(
            r.is_empty(),
            "no table lists XK, and a Eurostat-only place drops World Bank tables"
        );
    }

    #[test]
    fn beyond_drops_europe_only_tables_and_keeps_unknown() {
        let c = small();
        let all = ids(&c.rank_in(&texts(&["energy"]), Scope::Europe)).len();
        let r = c.rank_in(&texts(&["energy"]), Scope::Beyond);
        assert_eq!(all, 5);
        let mut got = ids(&r);
        got.sort();
        assert_eq!(got, ["EG.USE@2", "nrg_none", "nrg_world"]);
        assert_eq!(
            r.iter().find(|c| c.id == "nrg_world").unwrap().coverage,
            Coverage::World
        );
    }

    #[test]
    fn a_partner_dimension_keeps_a_europe_table_for_the_country_the_question_names() {
        let toc = "\"title\"\t\"code\"\t\"type\"\n\"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"    Trade\"\t\"ext\"\t\"folder\"\n\
                   \"        Extra-EU trade by partner\"\t\"ext_partner\"\t\"table\"\n\
                   \"        Extra-EU trade by unit\"\t\"ext_unit\"\t\"table\"\n";
        let metabase = "ext_partner\tgeo\tEU27_2020\next_partner\tpartner\tCN_X_HK\next_partner\tpartner\tUS\n\
                        ext_unit\tgeo\tEU27_2020\next_unit\tunit\tMT\n";
        let c = Catalog::from_raw(&Raw {
            toc: toc.into(),
            metabase: metabase.into(),
            cl: vec![
                ("geo".into(), "EU27_2020\tEuropean Union - 27 countries (from 2020)\r\nEU\tEuropean Union\r\nCN\tChina\r\nMT\tMalta\r\n".into()),
                ("partner".into(), "CN_X_HK\tChina except Hong Kong\r\nUS\tLand US\r\n".into()),
                ("unit".into(), "MT\tMillion tonnes\r\n".into()),
            ],
            wb_indicators: json!([{}, []]),
            wb_countries: json!([{}, [
                {"id": "CHN", "iso2Code": "CN", "name": "China", "region": {"value": "East Asia & Pacific"}},
                {"id": "MLT", "iso2Code": "MT", "name": "Malta", "region": {"value": "Middle East & North Africa"}},
                {"id": "USA", "iso2Code": "US", "name": "Land US", "region": {"value": "North America"}}
            ]]),
            wb_countries_zh: json!([{}, [{"iso2Code": "CN", "name": "中国"}, {"iso2Code": "MT", "name": "马耳他"}]]),
            nuts: "\u{feff}CNTR_CODE,NUTS_ID\r\n".into(),
        });
        // Both tables cover the EU alone. A question naming China keeps the one whose partners hold China (CN_X_HK);
        // beyond Europe with no such country named, or with Malta named (MT is a unit there, no place), both are dropped.
        let r = c.rank("欧盟与中国的贸易", &texts(&["extra-EU trade"]));
        assert_eq!(
            (r.scope, ids(&r.candidates)),
            (Scope::Beyond, vec!["ext_partner"])
        );
        assert_eq!(r.candidates[0].coverage, Coverage::Europe);
        assert!(c
            .rank_in(&texts(&["extra-EU trade"]), Scope::Beyond)
            .is_empty());
        assert!(c
            .rank("欧盟与马耳他的贸易", &texts(&["extra-EU trade"]))
            .candidates
            .is_empty());
        // A place in the search text is found in a partner dimension too (Land US is a World Bank name only), never in a unit.
        assert_eq!(
            ids(&c
                .rank("欧盟与中国的贸易", &texts(&["trade China"]))
                .candidates),
            ["ext_partner"]
        );
        assert_eq!(
            ids(&c.rank_in(&texts(&["trade Land US"]), Scope::Europe)),
            ["ext_partner"]
        );
        assert!(c
            .rank_in(&texts(&["trade Malta"]), Scope::Europe)
            .is_empty());
        // The fetch parameters get the same members with the country each stands for; a unit MT is no place.
        let pair = |c: &str, i: &str| (c.to_string(), i.to_string());
        assert_eq!(
            c.table("ext_partner").unwrap().place_members,
            [(
                "partner".to_string(),
                vec![pair("CN_X_HK", "CN"), pair("US", "US")]
            )]
        );
        assert!(c.table("ext_unit").unwrap().place_members.is_empty());
    }

    #[test]
    fn a_member_label_lifts_the_table_that_uses_it() {
        let c = small();
        let r = c.rank_in(&texts(&["energy balance solar"]), Scope::Europe);
        assert_eq!(
            ids(&r)[..2],
            ["nrg_src", "nrg_bal"],
            "same title; only nrg_src has the SOL member"
        );
        assert!(r[0].v > 0.0 && r[1].v == 0.0);
        let one = c.rank_in(&texts(&["solar"]), Scope::Europe);
        let two = c.rank_in(&texts(&["solar", "solar"]), Scope::Europe);
        assert_eq!(
            two[0].v,
            2.0 * one[0].v,
            "texts add up before they are combined"
        );
    }

    const ORIG: [(&str, &str); 8] = [
        ("q1", "欧盟各国可再生能源占比"),
        ("q2", "德国能源从来源到各部门"),
        ("q3", "欧盟各国发电结构"),
        ("q4", "人口大国各年份的人均碳排放"),
        ("q5", "各国 65 岁以上人口比例十年变化"),
        ("q6", "欧盟庇护申请的来源国"),
        ("u1", "中国各省房价"),
        ("u2", "美国大选民调"),
    ];

    fn rank_of(c: &[Candidate], targets: &[serde_json::Value]) -> serde_json::Value {
        let t: Vec<&str> = targets.iter().filter_map(|t| t.as_str()).collect();
        c.iter()
            .position(|c| t.contains(&c.id.split('@').next().unwrap()))
            .map(|n| json!(n + 1))
            .unwrap_or(serde_json::Value::Null)
    }

    /// Replays the Python prototype (v5geo/out-v5geo.json): scopes, coverage counts, 24 phrasings (L5-none and
    /// L5geo ranks and top 5), and the stand-in A and B-sum rows of the 6 questions and the 2 it cannot answer.
    /// L5GEO_DIR=<registry>/l5geo/catalog L5GEO_REPLAY=<registry> cargo test l5geo::tests -- --include-ignored --nocapture
    #[test]
    #[ignore]
    fn replay_v5geo() {
        let dir = std::path::PathBuf::from(std::env::var("L5GEO_DIR").expect("L5GEO_DIR"));
        let reg = std::path::PathBuf::from(std::env::var("L5GEO_REPLAY").expect("L5GEO_REPLAY"));
        let read = |p: &str| std::fs::read_to_string(reg.join(p)).unwrap();
        let t0 = std::time::Instant::now();
        let c = Catalog::load(&dir).unwrap();
        println!(
            "load {:.2}s, {} tables",
            t0.elapsed().as_secs_f64(),
            c.docs.len()
        );
        let want: serde_json::Value = serde_json::from_str(&read("v5geo/out-v5geo.json")).unwrap();
        let qs: serde_json::Value = serde_json::from_str(&read("index-v2/questions.json")).unwrap();
        let mut bad = Vec::new();

        for (q, zh) in ORIG {
            let un = c.uncovered(zh);
            println!("uncovered {q} {zh}: {un:?}");
            if q.starts_with('q') && un.is_some() {
                bad.push(format!("uncovered {q}: {un:?}"));
            }
            let got = serde_json::to_value(c.scope(zh).0).unwrap();
            if got != want["scope"][q] {
                bad.push(format!("scope {q}: {got} vs {}", want["scope"][q]));
            }
        }
        if c.uncovered("中国各省房价").is_none() {
            bad.push("uncovered u1: None".into());
        }
        let out = |t: &str| c.places_outside("德国和法国", &[t.to_string()]);
        if !out("germany france electricity").is_empty() || out("japan electricity") != ["japan"] {
            bad.push(format!(
                "places_outside: {:?} {:?}",
                out("germany france electricity"),
                out("japan electricity")
            ));
        }
        for q in [
            "德国各州人口",
            "法国各地区失业率",
            "意大利城市空气质量",
            "中国城市化率",
            "日本城市人口",
        ] {
            if c.uncovered(q).is_some() {
                bad.push(format!("uncovered {q}: {:?}", c.uncovered(q)));
            }
        }
        let mut cov: BTreeMap<String, usize> = BTreeMap::new();
        for k in &c.coverage {
            *cov.entry(
                serde_json::to_value(k)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string(),
            )
            .or_default() += 1;
        }
        if serde_json::to_value(&cov).unwrap() != want["coverage"] {
            bad.push(format!("coverage {cov:?} vs {}", want["coverage"]));
        }

        let scope_of = |q: &str| c.scope(ORIG.iter().find(|(k, _)| *k == q).unwrap().1).0;
        let mut targets: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
        for q in qs.as_array().unwrap() {
            let id = q["id"].as_str().unwrap();
            if let Some(n) = id.strip_prefix('Q') {
                targets.insert(
                    format!("q{}", n.split(' ').next().unwrap()),
                    q["targets"].as_array().unwrap().clone(),
                );
            }
        }
        let mut n_ph = 0;
        for row in want["phrasings"].as_array().unwrap() {
            let q = row["q"].as_str().unwrap();
            let ph = texts(&[row["phrasing"].as_str().unwrap()]);
            for (name, scope) in [("L5-none", Scope::Europe), ("L5geo", scope_of(q))] {
                let r = c.rank_in(&ph, scope);
                let rank = rank_of(&r, &targets[q]);
                let top: Vec<serde_json::Value> = r.iter().take(TOP).map(|c| json!(c.id)).collect();
                if rank != row[name] || json!(top) != row[format!("top5-{name}")] {
                    bad.push(format!(
                        "{q} {name} {:?}: rank {rank} vs {}, top {top:?}",
                        ph[0], row[name]
                    ));
                }
            }
            n_ph += 1;
        }

        let a_file = read("standin-query-1025/A-one-query.txt");
        let a: HashMap<&str, &str> = a_file.lines().filter_map(|l| l.split_once(": ")).collect();
        let b_file = read("standin-query-1025/B-terms.jsonl");
        let b: HashMap<String, serde_json::Value> = b_file
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .map(|j| (j["id"].as_str().unwrap().to_lowercase(), j))
            .collect();
        let none = Vec::new();
        for row in want["standin"].as_array().unwrap() {
            let q = row["q"].as_str().unwrap();
            let t = if row["variant"] == "A" {
                texts(&[a[q].trim()])
            } else {
                b[q]["terms"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t.as_str().unwrap().to_string())
                    .collect()
            };
            for (name, scope) in [("L5-none", Scope::Europe), ("L5geo", scope_of(q))] {
                let r = c.rank_in(&t, scope);
                let rank = if targets.contains_key(q) {
                    rank_of(&r, &targets[q])
                } else {
                    rank_of(&r, &none)
                };
                let max_s = r.iter().map(|c| c.s).fold(0.0, f64::max);
                let max_v = r.iter().map(|c| c.v).fold(0.0, f64::max);
                let w = &row[format!("{name}_top")];
                let close =
                    |x: f64, y: &serde_json::Value| (x - y.as_f64().unwrap()).abs() < 0.0051;
                if rank != row[name]
                    || json!(r.first().map(|c| &c.id)) != w[0]
                    || !close(max_s, &w[1])
                    || !close(max_v, &w[2])
                {
                    bad.push(format!(
                        "{q} {} {name}: rank {rank} vs {}, top {:?} {max_s:.2} {max_v:.2} vs {w}",
                        row["variant"],
                        row[name],
                        r.first().map(|c| &c.id)
                    ));
                }
            }
        }
        for (q, scope) in [
            ("北海地区的海上风电装机容量", Scope::Europe),
            ("沿海地区人口密度最高的欧盟国家", Scope::Europe),
            ("德国增加纳税人的比例", Scope::Europe),
            ("欧盟对发展中国家的援助", Scope::Europe),
            ("哪些国家的可再生能源占比最高", Scope::Beyond),
        ] {
            if c.scope(q).0 != scope {
                bad.push(format!("review question {q}: {:?}", c.scope(q)));
            }
        }

        // First-place s under the L5geo scope, for the cannot-answer threshold: 24 dev phrasings, X2's 4, stand-in rows.
        let first_s = |t: &[String], scope| c.rank_in(t, scope).first().map_or(0.0, |c| c.s);
        for row in want["phrasings"].as_array().unwrap() {
            let q = row["q"].as_str().unwrap();
            let ph = row["phrasing"].as_str().unwrap();
            println!(
                "thr dev {q} {:.2} {ph}",
                first_s(&texts(&[ph]), scope_of(q))
            );
        }
        for q in qs
            .as_array()
            .unwrap()
            .iter()
            .filter(|q| q["id"].as_str().unwrap().starts_with('X'))
        {
            for ph in q["phrasings"].as_array().unwrap() {
                let ph = ph.as_str().unwrap();
                println!(
                    "thr none u2 {:.2} {ph}",
                    first_s(&texts(&[ph]), scope_of("u2"))
                );
            }
        }
        for row in want["standin"].as_array().unwrap() {
            let q = row["q"].as_str().unwrap();
            let t = if row["variant"] == "A" {
                texts(&[a[q].trim()])
            } else {
                b[q]["terms"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t.as_str().unwrap().to_string())
                    .collect()
            };
            let group = if q.starts_with('u') { "none" } else { "dev" };
            println!(
                "thr standin-{} {group} {q} {:.2}",
                row["variant"].as_str().unwrap(),
                first_s(&t, scope_of(q))
            );
        }

        let t1 = std::time::Instant::now();
        let r = c.top5(
            "德国能源从来源到各部门",
            &texts(&["energy balance supply sources to final consumption by sector Germany"]),
        );
        println!(
            "top5 one query {:.3}s: {}",
            t1.elapsed().as_secs_f64(),
            serde_json::to_string(&r).unwrap()
        );
        println!(
            "phrasings {n_ph}, stand-in rows {}, mismatches {}",
            want["standin"].as_array().unwrap().len(),
            bad.len()
        );
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }
}
