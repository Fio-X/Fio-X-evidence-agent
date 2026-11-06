//! Data side: pick the first 5 candidate tables for one question (research page v5geo, "L5geo"). Deterministic:
//! BM25 on table titles and folder paths (S) plus a member-label signal (V), places in the search text used as a
//! filter, and the question's reach (Europe or beyond) judged by the program from the Chinese question, never by the
//! model. The model only picks a number from what this returns.
//!
//! Input is one plain directory made by scripts/l5geo_inputs.py: toc.txt, metabase.txt, cl/*.tsv, wb-indicators.json,
//! wb-countries.json, wb-countries-zh.json, nuts-2024-at.csv (original files, metabase unzipped). The registered table notes
//! (runtime/pi/assets/table-notes-en.json, compiled in) add search words to a table's S text.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

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
    /// Set when this is the annual twin of a monthly-only table the ranking reached (`top5`). Its score, s and v are those
    /// of the place it holds: the monthly table's when it took that place.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub twin_of: Option<TwinOf>,
}

/// The monthly-only table a candidate stands for: the ranking reached `asked`, and `used`, the annual table of the same
/// measure that monthly-twins.json registers for it (`found` as the file says how), is offered instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TwinOf {
    pub asked: String,
    pub used: String,
    pub found: String,
    /// The last period each table holds, in the metabase's own form ("2026M08", "2025"): what the swap costs in time, the
    /// annual table often ending a year or two before the monthly one.
    pub asked_end: String,
    pub used_end: String,
    pub why: String,
}

/// A registered pair `top5` reached and did not swap, with why (a check that failed, the question asking for months, or
/// its naming a year past the annual table's last); the monthly table stays, as without the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TwinRefused {
    pub monthly: String,
    pub annual: String,
    pub why: String,
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
    /// `top5` only: the registered monthly-only tables it kept, their annual twin failing a check or ending before the year
    /// the question names, or the question asking for months.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub twins_refused: Vec<TwinRefused>,
    /// The quantities the Chinese question asks for (`asked_zh`), each with the offered tables that hold it (`top5`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub asked: Vec<Asked>,
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
    /// The country groups of place-names-zh.json, members kept only when a World Bank country; a group word in zh_names
    /// stands for GROUP and the group id.
    groups: Vec<GroupZh>,
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
    /// Eurostat: each SDMX freq the metabase's time codes hold, as (freq, first, last) in FREQS order, first and last in
    /// the metabase's own form (2008M01). The metabase lists no freq dimension, so its time codes are the only source.
    /// World Bank: none.
    pub freqs: Vec<(String, String, String)>,
    /// World Bank: the indicator's unit as wb-units.tsv registers it; None when the file has no row with a code for it.
    /// Eurostat: none (its unit is the code the fetch fixes in the unit dimension).
    pub unit: Option<Unit>,
}

/// A World Bank indicator's unit. The catalogue lists none (its "unit" field is empty), so wb-units.tsv, built offline from
/// the indicator's own unit text, registers a Eurostat unit code (runtime/pi/assets/wb-units.tsv) and the measure kind.
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    pub code: String,
    /// The code's label in Eurostat's unit code list.
    pub label: String,
    /// One of WB_UNIT_KINDS; None when the file leaves it empty, which the page pack names, never guesses.
    pub kind: Option<&'static str>,
}

/// The registry of World Bank units, compiled in so a broken file fails its test, not a run.
const WB_UNITS: &str = include_str!("../runtime/pi/assets/wb-units.tsv");
/// The measure kinds wb-units.tsv may name (measure_semantics.mjs MEASURE_KINDS, the ones a WDI unit text states).
pub const WB_UNIT_KINDS: [&str; 7] = ["share", "rate", "change", "level", "count", "index", "mean"];

/// The unit wb-units.tsv registers for a World Bank indicator (with or without its "@2"); None for no row or an empty code.
pub fn wb_unit(id: &str) -> Option<Unit> {
    let id = id.strip_suffix("@2").unwrap_or(id);
    lines(WB_UNITS).skip(1).find_map(|line| {
        let mut p = line.split('\t');
        let (Some(indicator), Some(_name), Some(code), Some(label), Some(kind)) =
            (p.next(), p.next(), p.next(), p.next(), p.next())
        else {
            return None;
        };
        (indicator == id && !code.is_empty()).then(|| Unit {
            code: code.to_string(),
            label: label.to_string(),
            kind: WB_UNIT_KINDS.iter().copied().find(|k| *k == kind),
        })
    })
}

/// The Eurostat tables that hold monthly data only, each with the annual table of the same measure, built offline from the
/// metabase (runtime/pi/assets/monthly-twins.json), compiled in so a broken file fails its test, not a run. A pair says
/// nothing about a year being a sum of months: flow-families.json alone registers that, and this file is not read for it.
const MONTHLY_TWINS: &str = include_str!("../runtime/pi/assets/monthly-twins.json");

/// One pair of monthly-twins.json (its other fields are not read).
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct Twin {
    monthly: String,
    annual: String,
    /// How the pair was found: by "id", "title" or "id+title".
    found: String,
    /// The dimensions both tables have, time left out.
    dims: Vec<String>,
    /// Per dimension, how many codes the annual table has beyond the monthly one's; a dimension not listed has none.
    #[serde(default)]
    extra_annual_codes: BTreeMap<String, usize>,
    /// The monthly table's unit codes; none when it has no unit dimension.
    #[serde(default)]
    unit: Vec<String>,
}

/// The registered pairs, read once.
fn monthly_twins() -> &'static [Twin] {
    static TWINS: OnceLock<Vec<Twin>> = OnceLock::new();
    TWINS.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            pairs: Vec<Twin>,
        }
        serde_json::from_str::<File>(MONTHLY_TWINS)
            .expect("monthly-twins.json lists pairs")
            .pairs
    })
}

/// Extra English search words for Eurostat tables whose catalogue title is too generic for the words a question is searched
/// with (runtime/pi/assets/table-notes-en.json), compiled in so a broken file fails its test, not a run. A table's words join
/// its S text once, after its title and before its folder path; a table with no entry, and a catalogue built with no notes,
/// rank exactly as before. The words say what the table holds; they name no number and no place.
const TABLE_NOTES: &str = include_str!("../runtime/pi/assets/table-notes-en.json");

/// One entry of table-notes-en.json (its `dims`, the dimensions the words describe, are read only by the tests).
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct TableNote {
    /// The Eurostat table code.
    id: String,
    words: String,
}

/// The registered notes, read once.
fn table_notes() -> &'static [TableNote] {
    static NOTES: OnceLock<Vec<TableNote>> = OnceLock::new();
    NOTES.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            tables: Vec<TableNote>,
        }
        serde_json::from_str::<File>(TABLE_NOTES)
            .expect("table-notes-en.json lists tables")
            .tables
    })
}

/// Chinese place words the World Bank's Chinese country list does not hold (runtime/pi/assets/place-names-zh.json),
/// compiled in so a broken file fails its test, not a run: the short names of countries listed by their long form (韩国
/// for 大韩民国), and country groups (金砖国家, 东盟, 七国集团, 二十国集团) as their members by year, each with a source.
const PLACE_NAMES_ZH: &str = include_str!("../runtime/pi/assets/place-names-zh.json");

/// Where a row of place-names-zh.json is published: the page's title, its url and the day it was read.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct SourceZh {
    title: String,
    url: String,
    accessed: String,
}

/// One short name of place-names-zh.json.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct AliasZh {
    name: String,
    iso2: String,
    source: SourceZh,
}

/// One country group of place-names-zh.json: its Chinese words, its members by period, and the codes a source lists as
/// members and another does not (left out of every period).
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct GroupZh {
    id: String,
    names: Vec<String>,
    /// In year order; the last one is the latest list.
    periods: Vec<GroupPeriod>,
    #[serde(default)]
    disputed: Vec<DisputedZh>,
}

/// A code one source lists as a member and another says is not, with both sources.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct DisputedZh {
    iso2: String,
    sources: Vec<SourceZh>,
}

/// The members of a group from one year to another (`to` None: still current), the members that are no country, and the
/// source of the membership change that opens the period.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct GroupPeriod {
    from: i32,
    to: Option<i32>,
    members: Vec<String>,
    #[serde(default)]
    non_country_members: Vec<NonCountryZh>,
    source: SourceZh,
}

/// A member that is no country (the EU in the G20): its Chinese name, which the page line prints, and its source.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct NonCountryZh {
    name: String,
    source: SourceZh,
}

/// The words of the page line that says which members a group's page counts: `members_of_year` ({year}, {n}) where the
/// membership changes inside the page's years, `countries_only` ({n}, {others}) where the group has members that are no
/// country, each with its `_drawn` form (the count is of the places drawn, not of the members: a member has no data, or the
/// question names a place beside the group), and `missing` ({missing}) after it when a member has no data; `line_join`
/// joins the line to the unit line, `others_join` and `missing_join` the names in it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct BasisWordsZh {
    line_join: String,
    members_of_year: String,
    members_of_year_drawn: String,
    countries_only: String,
    countries_only_drawn: String,
    missing: String,
    others_join: String,
    missing_join: String,
}

/// place-names-zh.json as read.
#[derive(Debug, Deserialize)]
struct PlaceNamesZh {
    aliases: Vec<AliasZh>,
    groups: Vec<GroupZh>,
    basis: BasisWordsZh,
}

/// The registered short names, groups and the basis line's words, read once.
fn place_names_zh() -> &'static PlaceNamesZh {
    static NAMES: OnceLock<PlaceNamesZh> = OnceLock::new();
    NAMES.get_or_init(|| serde_json::from_str(PLACE_NAMES_ZH).expect("place-names-zh.json lists aliases, groups and basis words"))
}

/// What a page drawn for a group the question names counts (Catalog::group_basis), every code as the page's rows write it
/// (iso2, the World Bank's iso3, or Eurostat's EL and UK; a member with no row in iso3 on an iso3 page, else iso2): the
/// group, the year its member list is of, those members (countries only), the places the question names on their own
/// (kept whatever the group), the page's places that are neither (their rows are left out), the members with no row at the
/// page's last year, and the page line's words when the page must say its basis (the membership changes inside the page's
/// years, the group has members that are no country, or a member has no data). The line's {year} and {n} are left for the
/// page's own entries of the year and the count of the places it draws, {missing} for the names of the members with no
/// data (joined by `missing_join`); `join` joins it to the unit line. Every word is the knowledge group's
/// (place-names-zh.json).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GroupBasis {
    pub group: String,
    pub year: i32,
    pub members: Vec<String>,
    pub named: Vec<String>,
    pub dropped: Vec<String>,
    pub missing: Vec<String>,
    /// The members of `year` the flow never fetched (the question's years gave a list without them): their lack is no
    /// fact of the data, so the page is refused, never drawn with them named as having no data.
    #[serde(default)]
    pub unfetched: Vec<String>,
    pub line: Option<String>,
    pub join: String,
    pub missing_join: String,
}

/// The code a group word stands for in the Chinese name list: this prefix and the group id.
const GROUP: &str = "GROUP:";

/// The years a Chinese question writes, read as the flow's fetch window reads them (next_params question_years, its words
/// as vocabulary): a four-digit year from NAMED_FROM on standing alone directly before the year character or a range mark, spaces aside;
/// the earliest and the latest, the latest None (to this year) when the question writes one year that it runs on from or
/// compares with (a SINCE_AFTER word after it, a SINCE_BEFORE word before it). None when it writes no year.
fn question_span(text: &str) -> Option<(i32, Option<i32>)> {
    use crate::next_params::{NAMED_FROM, RANGE_MARKS, SINCE_AFTER, SINCE_BEFORE};
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    let mut years: Vec<(i32, usize)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        let marked = chars.get(i).is_some_and(|c| *c == '年' || RANGE_MARKS.contains(c));
        if i - start == 4 && marked {
            let y: i32 = chars[start..i].iter().collect::<String>().parse().unwrap_or(0);
            if (NAMED_FROM..=2100).contains(&y) {
                years.push((y, start));
            }
        }
    }
    let a = years.iter().map(|y| y.0).min()?;
    let b = years.iter().map(|y| y.0).max()?;
    let text = |r: std::ops::Range<usize>| chars[r].iter().collect::<String>();
    let since = a == b
        && years.iter().any(|&(_, at)| {
            let after = at + 5;
            SINCE_BEFORE.iter().any(|w| text(0..at).ends_with(w))
                || (chars.get(at + 4) == Some(&'年') && SINCE_AFTER.iter().any(|w| text(after.min(chars.len())..chars.len()).starts_with(w)))
        });
    Some((a, if since { None } else { Some(b) }))
}

/// The quantities a Chinese question can ask for (runtime/pi/assets/measure-families.json), compiled in so a broken file
/// fails its test, not a run. A question none of its words match asks for no listed quantity and ranks as without the file.
const MEASURE_FAMILIES: &str = include_str!("../runtime/pi/assets/measure-families.json");

/// One measure family of measure-families.json.
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct Family {
    id: String,
    /// Its name as the page prints it.
    zh: String,
    /// The Chinese words that name it in a question.
    words: Vec<String>,
    /// English search words for its own tables, used only when the question asks for two or more quantities.
    en: String,
    /// The table id prefixes that hold it (a World Bank id without its "@2").
    tables: Vec<String>,
}

/// The registered families, read once.
fn measure_families() -> &'static [Family] {
    static FAMILIES: OnceLock<Vec<Family>> = OnceLock::new();
    FAMILIES.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            families: Vec<Family>,
        }
        serde_json::from_str::<File>(MEASURE_FAMILIES)
            .expect("measure-families.json lists families")
            .families
    })
}

/// measure-families.json's denominator words: a family word between an opening word (占) and the nearest closing word
/// (比重, 比例, ...) at most `max_chars` characters on is that share's whole, not a quantity the question asks for.
#[derive(Clone, Debug, Deserialize)]
struct Denominator {
    opens: Vec<String>,
    closes: Vec<String>,
    /// A joining word or a comma: the whole ends before it, so a second quantity asked after it is never blanked.
    stops: Vec<String>,
    /// Words right after an opening word that make it a share said whole (占比), with no whole to blank.
    not_after_open: Vec<String>,
    max_chars: usize,
}

fn denominator() -> &'static Denominator {
    static D: OnceLock<Denominator> = OnceLock::new();
    D.get_or_init(|| {
        #[derive(Deserialize)]
        struct File {
            denominator: Denominator,
        }
        serde_json::from_str::<File>(MEASURE_FAMILIES)
            .expect("measure-families.json has its denominator words")
            .denominator
    })
}

/// `q` (measure_chars) with each share's whole blanked (`denominator`), so no family word matches inside it.
fn blank_denominators(q: &mut [char]) {
    let d = denominator();
    let words = |ws: &[String]| ws.iter().map(|w| measure_chars(w)).filter(|w| !w.is_empty()).collect::<Vec<_>>();
    let (opens, closes, stops, not_after) = (words(&d.opens), words(&d.closes), words(&d.stops), words(&d.not_after_open));
    let at = |q: &[char], i: usize, w: &[char]| q.get(i..i + w.len()) == Some(w);
    let mut i = 0;
    while i < q.len() {
        let Some(open) = opens.iter().find(|w| at(q, i, w)) else {
            i += 1;
            continue;
        };
        let from = i + open.len();
        if not_after.iter().any(|w| at(q, from, w)) {
            i = from;
            continue;
        }
        let end = (from..q.len().min(from + d.max_chars + 1))
            .find(|&j| stops.iter().any(|w| at(q, j, w)))
            .unwrap_or_else(|| q.len().min(from + d.max_chars + 1));
        let close = (from..end).find(|&j| closes.iter().any(|w| at(q, j, w)));
        if let Some(to) = close {
            q[from..to].iter_mut().for_each(|c| *c = '\0');
            i = to;
        } else {
            i = from;
        }
    }
}

/// A question's text as the family words are matched on it: spaces removed, letters upper-cased.
fn measure_chars(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

/// The words a question asks for a ranked set of economies with (runtime/pi/assets/rank-phrases-zh.json), compiled in so a
/// broken file fails its test, not a run.
const RANK_PHRASES: &str = include_str!("../runtime/pi/assets/rank-phrases-zh.json");

/// The count slot of a rank-phrases-zh.json word.
const COUNT_SLOT: &str = "{n}";

/// A ranking the Chinese question asks for in place of named places (the ten most populous economies): the reference
/// indicator the set is ranked by, how many economies the question asks for (None: it names no count), and the words that
/// asked. Read by rule from the question alone; it holds no economy: the program ranks the set from the fetched rows of `by`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RankAsked {
    pub by: String,
    pub n: Option<usize>,
    pub phrase: String,
}

/// One entry of rank-phrases-zh.json. Unknown fields are refused, so an entry that types a list of economies (codes,
/// members) fails to load instead of being read as a ranking.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct RankPhrase {
    by: String,
    words: Vec<String>,
}

/// rank-phrases-zh.json read from its text: Err when it is not the registered form (an unknown field, a reference id that is
/// not an indicator code, a word with no Chinese character, a word with two count slots, two entries with one reference).
fn rank_phrases_from(text: &str) -> Result<Vec<RankPhrase>, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct File {
        #[allow(dead_code)]
        note: String,
        phrases: Vec<RankPhrase>,
    }
    let file: File = serde_json::from_str(text).map_err(|e| format!("rank-phrases-zh.json: {e}"))?;
    let mut seen = BTreeSet::new();
    for p in &file.phrases {
        let code = !p.by.is_empty()
            && p.by.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            && p.by.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '_');
        if !code {
            return Err(format!("rank-phrases-zh.json: {:?} is not an indicator code", p.by));
        }
        if !seen.insert(p.by.clone()) {
            return Err(format!("rank-phrases-zh.json: {} has two entries", p.by));
        }
        if p.words.is_empty() {
            return Err(format!("rank-phrases-zh.json: {} has no words", p.by));
        }
        for w in &p.words {
            if !w.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) {
                return Err(format!("rank-phrases-zh.json: {w:?} has no Chinese character"));
            }
            if w.matches(COUNT_SLOT).count() > 1 {
                return Err(format!("rank-phrases-zh.json: {w:?} has two count slots"));
            }
        }
    }
    Ok(file.phrases)
}

/// The registered ranking words, read once.
fn rank_phrases() -> &'static [RankPhrase] {
    static PHRASES: OnceLock<Vec<RankPhrase>> = OnceLock::new();
    PHRASES.get_or_init(|| rank_phrases_from(RANK_PHRASES).expect("rank-phrases-zh.json is the registered form"))
}

/// A count written at `at`: Arabic digits (1 to 999), or one to ninety-nine in Chinese numerals (a digit word alone, ten, ten
/// and a digit word, a digit word and ten with or without one more digit word), with the characters it takes. None for no
/// count or zero.
fn count_at(chars: &[char], at: usize) -> Option<(usize, usize)> {
    let digits: String = chars[at..].iter().take_while(|c| c.is_ascii_digit()).take(3).collect();
    if !digits.is_empty() {
        let n: usize = digits.parse().ok()?;
        return (n > 0).then_some((n, digits.chars().count()));
    }
    let unit = |c: char| "一二三四五六七八九".chars().position(|d| d == c).map(|i| i + 1).or((c == '两').then_some(2));
    let ten = |i: usize| chars.get(i) == Some(&'十');
    match (chars.get(at).copied().and_then(unit), ten(at)) {
        // ten, or ten and a digit word (10 to 19)
        (None, true) => match chars.get(at + 1).copied().and_then(unit) {
            Some(u) => Some((10 + u, 2)),
            None => Some((10, 1)),
        },
        // a digit word and ten, with or without one more (20 to 99)
        (Some(t), _) if ten(at + 1) => match chars.get(at + 2).copied().and_then(unit) {
            Some(u) => Some((t * 10 + u, 3)),
            None => Some((t * 10, 2)),
        },
        (Some(u), _) => Some((u, 1)),
        (None, false) => None,
    }
}

/// The mark before a number that makes it an ordinal (the second): such a number is no count.
const ORDINAL_MARK: char = '第';

/// `word` matched at `at` of `chars`: the count its slot read (None for a word with no slot) and the characters it took.
fn word_at(chars: &[char], at: usize, word: &str) -> Option<(Option<usize>, usize)> {
    let (before, after) = match word.split_once(COUNT_SLOT) {
        Some((b, a)) => (b, Some(a)),
        None => (word, None),
    };
    let before: Vec<char> = before.chars().collect();
    if !chars[at..].starts_with(&before) {
        return None;
    }
    let Some(after) = after else {
        return Some((None, before.len()));
    };
    // an ordinal (the second largest economy) names one place in a ranking, never how many the question asks for
    if (at + before.len()).checked_sub(1).is_some_and(|i| chars[i] == ORDINAL_MARK) {
        return None;
    }
    let (n, took) = count_at(chars, at + before.len())?;
    let after: Vec<char> = after.chars().collect();
    let end = at + before.len() + took;
    chars[end..]
        .starts_with(&after)
        .then_some((Some(n), end + after.len() - at))
}

/// A level below the country asked for (BELOW_COUNTRY_ZH, NOT_BELOW_COUNTRY_ZH aside), as `Catalog::uncovered` reads it.
fn below_country_asked(question_zh: &str) -> bool {
    let not: Vec<(usize, usize)> = NOT_BELOW_COUNTRY_ZH
        .iter()
        .flat_map(|n| question_zh.match_indices(*n).map(|(at, m)| (at, at + m.len())))
        .collect();
    BELOW_COUNTRY_ZH.iter().any(|w| {
        question_zh
            .match_indices(*w)
            .any(|(at, m)| !not.iter().any(|&(a, b)| at < b && a < at + m.len()))
    })
}

/// The ranking the Chinese question asks for (rank-phrases-zh.json), read by rule from the question alone, spaces aside: at
/// the first position where a registered word matches (its longest word there), that entry's reference and the count its
/// slot read. None when no word matches, when words of two references match (which one the question means is not fixed),
/// or when the question asks for a level below the country (the most populous cities): the question then reads as before.
pub fn rank_asked_zh(question_zh: &str) -> Option<RankAsked> {
    if below_country_asked(question_zh) {
        return None;
    }
    let chars: Vec<char> = question_zh.chars().filter(|c| !c.is_whitespace()).collect();
    let mut words: Vec<(&RankPhrase, &String)> = rank_phrases()
        .iter()
        .flat_map(|p| p.words.iter().map(move |w| (p, w)))
        .collect();
    words.sort_by_key(|(_, w)| std::cmp::Reverse(w.replace(COUNT_SLOT, "").chars().count()));
    let mut found: Option<RankAsked> = None;
    let mut i = 0;
    while i < chars.len() {
        match words.iter().find_map(|(p, w)| word_at(&chars, i, w).map(|m| (p, m))) {
            Some((p, (n, took))) => {
                match found.as_ref().map(|f| f.by == p.by) {
                    None => {
                        found = Some(RankAsked {
                            by: p.by.clone(),
                            n,
                            phrase: chars[i..i + took].iter().collect(),
                        })
                    }
                    Some(false) => return None,
                    Some(true) => {}
                }
                i += took;
            }
            None => i += 1,
        }
    }
    found
}

/// One quantity the Chinese question asks for, judged by the program from the question alone (never from the model).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Asked {
    /// The family id in measure-families.json.
    pub id: String,
    /// Its name as the page prints it, the only name the page may use for it.
    pub zh: String,
    /// The table id prefixes that hold it.
    pub tables: Vec<String>,
    /// `top5` only: the offered tables that hold it, best first. Empty means no offered table answers this quantity, the
    /// one case in which the page may say it cannot be answered.
    pub offered: Vec<String>,
}

impl Asked {
    /// Whether the table `id` (a World Bank id with or without "@2") holds this quantity.
    pub fn holds(&self, id: &str) -> bool {
        let id = id.split('@').next().unwrap_or(id);
        self.tables.iter().any(|p| id.starts_with(p.as_str()))
    }

    /// Whether the candidate holds this quantity: its id starts with one of the family's prefixes (`holds`), or its
    /// catalogue title names every word of the family's English search words (`title_names`) and no family with more of
    /// those words names it as well (a per-capita title is gdp_pc's, not gdp's). A summary table outside the prefixes
    /// (tps00191, "Asylum applicants by type - annual aggregated data") is then the asylum family's like migr_asy*.
    pub fn holds_candidate(&self, c: &Candidate) -> bool {
        self.holds(&c.id) || {
            let fams = measure_families();
            let words = |f: &Family| en_words(&f.en);
            match fams.iter().find(|f| f.id == self.id) {
                Some(f) => {
                    let mine = words(f);
                    title_names(&c.title, &mine)
                        && !fams.iter().any(|g| {
                            let theirs = words(g);
                            g.id != f.id && theirs.len() > mine.len() && mine.iter().all(|w| theirs.contains(w)) && title_names(&c.title, &theirs)
                        })
                }
                None => false,
            }
        }
    }
}

/// The content words of a family's English search words: lowercase, letters only, four letters or more.
fn en_words(en: &str) -> Vec<String> {
    en.split(|c: char| !c.is_ascii_alphabetic()).filter(|w| w.len() >= 4).map(str::to_ascii_lowercase).collect()
}

/// Whether a catalogue title holds every one of `words` as a word of its own (case aside); no words, no match.
fn title_names(title: &str, words: &[String]) -> bool {
    let t: Vec<String> = title.split(|c: char| !c.is_ascii_alphanumeric()).map(str::to_ascii_lowercase).collect();
    !words.is_empty() && words.iter().all(|w| t.iter().any(|x| x == w))
}

/// The quantities the Chinese question asks for, in the order their words are matched: longest word first, a matched span
/// used up so a shorter word inside it does not match again, each family once.
pub fn asked_zh(question_zh: &str) -> Vec<Asked> {
    let mut q = measure_chars(question_zh);
    blank_denominators(&mut q);
    let mut words: Vec<(Vec<char>, &Family)> = measure_families()
        .iter()
        .flat_map(|f| f.words.iter().map(move |w| (measure_chars(w), f)))
        .filter(|(w, _)| !w.is_empty())
        .collect();
    words.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    let mut found: Vec<Asked> = Vec::new();
    for (w, f) in &words {
        let mut hit = false;
        let mut i = 0;
        while i + w.len() <= q.len() {
            if q[i..i + w.len()] == w[..] {
                q[i..i + w.len()].iter_mut().for_each(|c| *c = '\0');
                hit = true;
                i += w.len();
            } else {
                i += 1;
            }
        }
        if hit && !found.iter().any(|a| a.id == f.id) {
            found.push(Asked {
                id: f.id.clone(),
                zh: f.zh.clone(),
                tables: f.tables.clone(),
                offered: Vec::new(),
            });
        }
    }
    found
}

/// The SDMX freqs a Eurostat time code can hold, annual first.
pub const FREQS: [&str; 6] = ["A", "S", "Q", "M", "W", "D"];

/// The SDMX freq of a metabase time code: 2024 A, 2024S1 S, 2024Q1 Q, 2024M08 M, 2024W05 W, 2024M08D01 D; none for
/// another form (LTAA, a long-term average).
pub fn time_freq(code: &str) -> Option<&'static str> {
    let b = code.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    if !digits(0..4) {
        return None;
    }
    match (b.len(), b.get(4)) {
        (4, None) => Some("A"),
        (6, Some(b'S')) if digits(5..6) => Some("S"),
        (6, Some(b'Q')) if digits(5..6) => Some("Q"),
        (7, Some(b'M')) if digits(5..7) => Some("M"),
        (7, Some(b'W')) if digits(5..7) => Some("W"),
        (10, Some(b'M')) if digits(5..7) && b[7] == b'D' && digits(8..10) => Some("D"),
        _ => None,
    }
}

impl TableMeta {
    /// The freq a Eurostat fetch asks for: A when the table holds annual codes or the metabase lists no time code (as
    /// before freqs were read), else the one other freq it holds. Err for a table holding two or more and no A: there is
    /// no one freq to ask, and the program does not guess.
    pub fn freq(&self) -> Result<&str, String> {
        match self.freqs.as_slice() {
            [] => Ok("A"),
            [(f, _, _), ..] if f == "A" => Ok("A"),
            [(f, _, _)] => Ok(f),
            more => Err(format!(
                "{} holds the freqs {} and no annual one: there is no one freq to fetch",
                self.id,
                more.iter()
                    .map(|(f, _, _)| f.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
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
    /// The directory's catalogue as the Python prototype read it, with no table notes: the replays compare against it.
    #[cfg(test)]
    pub fn load(dir: &Path) -> Result<Catalog> {
        Ok(Catalog::with_notes(&Raw::read(dir)?, &[]))
    }

    /// The catalogue of these files, with the registered table notes (table-notes-en.json).
    pub fn from_raw(raw: &Raw) -> Catalog {
        Catalog::with_notes(raw, table_notes())
    }

    /// `from_raw` with these table notes: each listed table's words join its S text. With none, or none for a listed table,
    /// every document, and so every ranking, is as without the file.
    fn with_notes(raw: &Raw, notes: &[TableNote]) -> Catalog {
        let notes: HashMap<&str, &str> = notes
            .iter()
            .map(|n| (n.id.as_str(), n.words.as_str()))
            .collect();
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
        let registered = place_names_zh();
        for a in &registered.aliases {
            if countries.contains(&a.iso2) {
                put(&a.name, &a.iso2);
            }
        }
        let mut groups: Vec<GroupZh> = Vec::new();
        for g in &registered.groups {
            let mut g = g.clone();
            for p in &mut g.periods {
                p.members.retain(|c| countries.contains(c));
            }
            for n in &g.names {
                put(n, &format!("{GROUP}{}", g.id));
            }
            groups.push(g);
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
            if let Some(words) = notes.get(r[1]) {
                t.extend(toks(words));
            }
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
            groups,
            metabase: raw.metabase.clone(),
            labels,
            end_year,
            wb_places,
            place_members,
        }
    }

    /// The catalogue title of a table.
    pub fn title(&self, id: &str) -> Option<String> {
        self.docs
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.title.clone())
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
                    freqs: Vec::new(),
                    unit: wb_unit(id),
                });
        }
        let mut dims: Vec<(String, Vec<String>)> = Vec::new();
        let mut freqs: Vec<(String, String, String)> = Vec::new();
        for line in lines(&self.metabase) {
            let mut p = line.split('\t');
            let (Some(t), Some(d), Some(c)) = (p.next(), p.next(), p.next()) else {
                continue;
            };
            if t != id {
                continue;
            }
            if d == "time" {
                // One form per freq, so the codes of a freq order as text.
                if let Some(f) = time_freq(c) {
                    match freqs.iter_mut().find(|(g, _, _)| g == f) {
                        Some((_, first, last)) => {
                            if c < first.as_str() {
                                *first = c.to_string();
                            }
                            if c > last.as_str() {
                                *last = c.to_string();
                            }
                        }
                        None => freqs.push((f.to_string(), c.to_string(), c.to_string())),
                    }
                }
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
            freqs: {
                freqs.sort_by_key(|(f, _, _)| FREQS.iter().position(|g| g == f));
                freqs
            },
            unit: None,
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

    /// The members of a registered group in this year (the period holding it; None for a year it did not exist), or its
    /// latest list when no year is given.
    fn group_period(&self, id: &str, year: Option<i32>) -> Option<&GroupPeriod> {
        let g = self.groups.iter().find(|g| g.id == id)?;
        match year {
            None => g.periods.last(),
            Some(y) => g
                .periods
                .iter()
                .find(|p| p.from <= y && p.to.is_none_or(|t| y <= t)),
        }
    }

    /// What a page drawn for the first group the Chinese question names counts, from the page's first and last years
    /// (`t0`, None for a page of one year, and `t1`), its place codes (`places`) and those with a row at t1 (`at_t1`): the
    /// members in `t1` (the page's last year, the year its line prints, whatever year the question names); the places the question names on
    /// their own, which stay; the page's other places, which are no member that year (left out); the members fetched with no
    /// row at t1, and those never fetched (unfetched: the page is refused); and the page line when the page must say its basis: the member list differs inside the page's t0..t1, the group has members that are no country, or a member has no data (named). The line counts the places
    /// drawn (its `_drawn` form) where they are not the members: a member missing, or a named place beside them. None when
    /// the question names no group or the group has no members in that year.
    pub fn group_basis(
        &self,
        question_zh: &str,
        (t0, t1): (Option<i32>, i32),
        (places, at_t1): (&[String], &[String]),
    ) -> Option<GroupBasis> {
        let scanned = self.scan_zh(question_zh);
        let id = scanned.iter().find_map(|(_, c)| c.strip_prefix(GROUP).map(str::to_string))?;
        let g = self.groups.iter().find(|g| g.id == id)?;
        // the list of the page's own year, whichever year the question names: the line prints that year from the data
        let year = t1;
        let p = self.group_period(&id, Some(year))?;
        let words = &place_names_zh().basis;
        // an iso2 country as the page writes it: the form its rows hold, else iso3 on an iso3 page, else iso2
        let iso3 = |c: &str| self.wb_places.iter().find(|(i, _)| i == c).map(|(_, id)| id.clone());
        let page_code = |c: &str| {
            let estat = ESTAT_ISO.iter().find(|(_, i)| *i == c).map(|(e, _)| e.to_string());
            [Some(c.to_string()), iso3(c), estat]
                .into_iter()
                .flatten()
                .find(|k| places.contains(k))
                .unwrap_or_else(|| match iso3(c) {
                    Some(i) if !places.is_empty() && places.iter().all(|p| p.len() == 3) => i,
                    _ => c.to_string(),
                })
        };
        let members: Vec<String> = p.members.iter().map(|m| page_code(m)).collect();
        let mut named: Vec<String> = Vec::new();
        for (_, c) in &scanned {
            if c != REGION && c != NOT_PLACE && !c.starts_with(GROUP) && !named.contains(&page_code(c)) {
                named.push(page_code(c));
            }
        }
        let dropped: Vec<String> = places.iter().filter(|c| !members.contains(c) && !named.contains(c)).cloned().collect();
        // a member is fetched when the question's places hold it (the flow fetches places_zh's list) or the page has a row
        // of it; one that is neither was never asked for, and its lack is no fact of the data
        let asked: Vec<String> = self.places_zh(question_zh).into_iter().map(|(_, c)| page_code(&c)).collect();
        let unfetched: Vec<String> = members.iter().filter(|m| !places.contains(m) && !asked.contains(m)).cloned().collect();
        let missing: Vec<String> = members.iter().filter(|m| !at_t1.contains(m) && !unfetched.contains(m)).cloned().collect();
        let beside = named.iter().any(|c| !members.contains(c) && places.contains(c));
        let drawn = !missing.is_empty() || beside;
        let tail = if missing.is_empty() { "" } else { words.missing.as_str() };
        let pick = |all: &str, part: &str| if drawn { format!("{part}{tail}") } else { all.to_string() };
        let mut lines = Vec::new();
        // the page's own years, whether or not the question names any: a question asking 2015 to 2025 spans them too
        let changes = t0.is_some_and(|t0| {
                t0 < t1
                    && g.periods.iter().any(|q| {
                        q.from <= t1 && q.to.is_none_or(|to| t0 <= to) && {
                            let (mut a, mut b) = (q.members.clone(), p.members.clone());
                            a.sort();
                            b.sort();
                            a != b
                        }
                    })
            });
        if !p.non_country_members.is_empty() && !changes {
            let others: Vec<&str> = p.non_country_members.iter().map(|m| m.name.as_str()).collect();
            let line = pick(&words.countries_only, &words.countries_only_drawn);
            lines.push(line.replace("{others}", &others.join(&words.others_join)));
        } else if changes || !missing.is_empty() {
            lines.push(pick(&words.members_of_year, &words.members_of_year_drawn));
        }
        Some(GroupBasis {
            group: id.clone(),
            year,
            members,
            named,
            dropped,
            missing,
            unfetched,
            line: lines.pop(),
            join: words.line_join.clone(),
            missing_join: words.missing_join.clone(),
        })
    }

    /// Place names in the Chinese question, longest name first at each position; a NOT_PLACE word is skipped whole. A
    /// group word gives one entry per member, under the group word, of every member list over the years the question
    /// writes (question_span: a year it runs on from to the latest list; the latest list when it writes none), each once in
    /// list order, so every member of whichever year in that span the page ends at is fetched.
    fn places_zh(&self, text: &str) -> Vec<(String, String)> {
        let span = question_span(text);
        let mut found = Vec::new();
        for (name, code) in self.scan_zh(text) {
            if let Some(id) = code.strip_prefix(GROUP) {
                for c in self.group_members_over(id, span) {
                    found.push((name.clone(), c));
                }
            } else {
                found.push((name, code));
            }
        }
        found
    }

    /// The members of a registered group over a span of years (`from`, and `to` None for to the latest list), every list
    /// that overlaps it in year order, each member once; the latest list when no span is given; none when the group has no
    /// list in the span.
    fn group_members_over(&self, id: &str, span: Option<(i32, Option<i32>)>) -> Vec<String> {
        let Some(g) = self.groups.iter().find(|g| g.id == id) else { return Vec::new() };
        let periods: Vec<&GroupPeriod> = match span {
            None => g.periods.last().into_iter().collect(),
            Some((from, to)) => g
                .periods
                .iter()
                .filter(|p| p.to.is_none_or(|t| from <= t) && to.is_none_or(|to| p.from <= to))
                .collect(),
        };
        let mut members: Vec<String> = Vec::new();
        for m in periods.iter().flat_map(|p| &p.members) {
            if !members.contains(m) {
                members.push(m.clone());
            }
        }
        members
    }

    /// The Chinese name list's words in the text, longest first at each position, each with its code (an iso2, REGION or
    /// GROUP and the group id); a NOT_PLACE word is skipped whole. A name with an ASCII letter or digit at an end (G7) is
    /// read only when the text there goes on with no other one (not in G77).
    fn scan_zh(&self, text: &str) -> Vec<(String, String)> {
        let chars: Vec<char> = text.chars().collect();
        let alnum = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
        let bounded = |i: usize, n: &[char]| {
            !(alnum(n.first()) && i > 0 && alnum(chars.get(i - 1)))
                && !(alnum(n.last()) && alnum(chars.get(i + n.len())))
        };
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
                .find(|(n, _)| chars[i..].starts_with(n) && bounded(i, n))
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
        let mut names: Vec<String> = Vec::new();
        for (n, _) in found {
            // a group word stands for each of its members; it is named once
            let group = self
                .zh_names
                .iter()
                .any(|(w, c)| c.starts_with(GROUP) && w.iter().copied().eq(n.chars()));
            if !(group && names.last() == Some(&n)) {
                names.push(n);
            }
        }
        (if europe { Scope::Europe } else { Scope::Beyond }, names)
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
    #[cfg(test)]
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
                    twin_of: None,
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
        let asked = asked_zh(question_zh);
        let candidates = if uncovered.is_some() {
            Vec::new()
        } else {
            self.lift_asked(self.rank_reaching(texts, scope, &far), &asked, scope, &far)
        };
        Ranking {
            scope,
            places_zh,
            uncovered,
            candidates,
            twins_refused: Vec::new(),
            asked,
        }
    }

    /// With two or more asked quantities, a place among the first TOP for each one: a quantity none of the first TOP holds
    /// gets its best ranked table, or, when no ranked table holds it, the best table its family's own English words reach
    /// under the same filters (scored by that search, not this one). It takes the place of the last table of the first TOP
    /// that is not the only one there holding another asked quantity; the order is otherwise kept. With fewer than two
    /// asked quantities, or none to lift, `ranked` comes back unchanged.
    fn lift_asked(&self, ranked: Vec<Candidate>, asked: &[Asked], scope: Scope, far: &[String]) -> Vec<Candidate> {
        if asked.len() < 2 {
            return ranked;
        }
        let mut lifted: Vec<Candidate> = Vec::new();
        for a in asked {
            let placed = ranked.iter().take(TOP).chain(lifted.iter()).any(|c| a.holds_candidate(c));
            if placed {
                continue;
            }
            let found = ranked.iter().find(|c| a.holds_candidate(c)).cloned().or_else(|| {
                let family = measure_families().iter().find(|f| f.id == a.id)?;
                self.rank_reaching(&[family.en.clone()], scope, far)
                    .into_iter()
                    .find(|c| a.holds_candidate(c))
            });
            if let Some(c) = found {
                lifted.push(c);
            }
        }
        lifted.truncate(TOP);
        if lifted.is_empty() {
            return ranked;
        }
        let is_lifted = |c: &Candidate| lifted.iter().any(|l| l.id == c.id);
        let mut head: Vec<Candidate> = ranked.iter().filter(|c| !is_lifted(c)).take(TOP).cloned().collect();
        while head.len() + lifted.len() > TOP {
            // The last table that is not the only one among head and lifted holding an asked quantity.
            let sole = |k: usize| {
                asked.iter().any(|a| {
                    a.holds_candidate(&head[k])
                        && head
                            .iter()
                            .enumerate()
                            .filter(|&(j, _)| j != k)
                            .map(|(_, c)| c)
                            .chain(lifted.iter())
                            .all(|c| !a.holds_candidate(c))
                })
            };
            match (0..head.len()).rev().find(|&k| !sole(k)) {
                Some(k) => {
                    head.remove(k);
                }
                None => {
                    head.pop();
                }
            }
        }
        let mut out = head;
        out.extend(lifted.iter().cloned());
        let rest: Vec<Candidate> = ranked
            .into_iter()
            .filter(|c| !out.iter().any(|o| o.id == c.id))
            .collect();
        out.extend(rest);
        out
    }

    /// The first 5 of `rank`, a registered monthly-only table among them swapped for its annual twin (`twin_swap`) before
    /// the model sees any, unless `months`: the caller read that the question asks for months (a month it names, the
    /// latest months), which the annual table, ending a year or two earlier, cannot answer; nor when the annual table ends
    /// before `latest_year`, the latest year the caller read the question to name.
    pub fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>) -> Ranking {
        let mut r = self.rank(question_zh, texts);
        let (candidates, refused) =
            self.twin_swap(std::mem::take(&mut r.candidates), monthly_twins(), months, latest_year);
        r.candidates = candidates;
        r.twins_refused = refused;
        for a in &mut r.asked {
            a.offered = r
                .candidates
                .iter()
                .filter(|c| a.holds_candidate(c))
                .map(|c| c.id.clone())
                .collect();
        }
        r
    }

    /// The first TOP of `ranked` (best first, ids once each), each monthly-only table of `twins` whose annual twin passes
    /// `twin_check` and this question's filters (is ranked too) replaced by it. The twin takes the monthly table's place
    /// and scores; a twin ranked above its monthly table is offered once, in its own place, and the monthly one is dropped,
    /// so the next table fills the five. A refused pair keeps the monthly table where it was, as without the file; with
    /// `months` every pair is refused so, unchecked, and the first TOP are those of `ranked`. With `latest_year`, a pair
    /// whose annual table ends before that year is refused too: the fill keeps the fetch to the table's last year, so the
    /// annual table would cut the year the question names with no word on the page.
    fn twin_swap(
        &self,
        ranked: Vec<Candidate>,
        twins: &[Twin],
        months: bool,
        latest_year: Option<i32>,
    ) -> (Vec<Candidate>, Vec<TwinRefused>) {
        let mut out: Vec<Candidate> = Vec::new();
        let mut refused = Vec::new();
        for c in &ranked {
            if out.len() == TOP {
                break;
            }
            // A twin already offered in its monthly table's place.
            if out.iter().any(|o| o.id == c.id) {
                continue;
            }
            let Some(t) = twins.iter().find(|t| t.monthly == c.id) else {
                out.push(c.clone());
                continue;
            };
            let swap = if months {
                Err(format!(
                    "the question asks for months, which {} ends too early to answer, so the monthly table stays",
                    t.annual
                ))
            } else {
                ranked
                    .iter()
                    .find(|a| a.id == t.annual)
                    .ok_or_else(|| format!("{} is not among the tables this question's filters keep", t.annual))
                    .and_then(|a| self.twin_check(t).map(|ends| (a, ends)))
                    .and_then(|(a, (asked_end, used_end))| match latest_year {
                        Some(y) if !used_end.parse::<i32>().is_ok_and(|end| end >= y) => Err(format!(
                            "the question names {y}, past {}'s last year {used_end}, so the monthly table (to {asked_end}) stays",
                            t.annual
                        )),
                        _ => Ok((a, (asked_end, used_end))),
                    })
            };
            let (a, (asked_end, used_end)) = match swap {
                Ok(a) => a,
                Err(why) => {
                    refused.push(TwinRefused {
                        monthly: t.monthly.clone(),
                        annual: t.annual.clone(),
                        why,
                    });
                    out.push(c.clone());
                    continue;
                }
            };
            let twin_of = |why: String| {
                Some(TwinOf {
                    asked: c.id.clone(),
                    used: a.id.clone(),
                    found: t.found.clone(),
                    asked_end: asked_end.clone(),
                    used_end: used_end.clone(),
                    why,
                })
            };
            let held = format!(
                "{} holds monthly data only, to {asked_end}; {} is the annual table of the same measure (monthly-twins.json, found by {}), its dimensions and codes checked in this catalogue, to {used_end}",
                c.id, a.id, t.found
            );
            match out.iter_mut().find(|o| o.id == a.id) {
                Some(o) => {
                    if o.twin_of.is_none() {
                        o.twin_of = twin_of(format!("{held}; it is ranked above {}, which is not offered", c.id));
                    }
                }
                None => out.push(Candidate {
                    id: a.id.clone(),
                    title: a.title.clone(),
                    coverage: a.coverage,
                    twin_of: twin_of(held),
                    ..c.clone()
                }),
            }
        }
        (out, refused)
    }

    /// The data end periods (the monthly table's, the annual one's; the metabase's own form, 2026M08 and 2025) of a
    /// registered pair whose annual table can stand for its monthly one in this catalogue; else why it cannot. The file was
    /// built from an older catalogue copy, so each pair is checked again here: both tables listed, the monthly one holding
    /// monthly codes alone and the annual one annual codes alone (as the file's builder requires), the same dimensions as
    /// the file names, every monthly code (its unit codes too) in the annual table, and no more annual codes in a dimension
    /// than the file counts. A failure only keeps the monthly table.
    fn twin_check(&self, twin: &Twin) -> Result<(String, String), String> {
        fn freqs(t: &TableMeta) -> Vec<&str> {
            t.freqs.iter().map(|(f, _, _)| f.as_str()).collect()
        }
        fn names(t: &TableMeta) -> BTreeSet<&str> {
            t.dims.iter().map(|(d, _)| d.as_str()).collect()
        }
        let (Some(m), Some(a)) = (self.table(&twin.monthly), self.table(&twin.annual)) else {
            return Err(format!(
                "the catalogue does not list both {} and {}",
                twin.monthly, twin.annual
            ));
        };
        let (m_end, a_end) = match (m.freqs.as_slice(), a.freqs.as_slice()) {
            ([(mf, _, m_end)], [(af, _, a_end)]) if mf == "M" && af == "A" => (m_end.clone(), a_end.clone()),
            ([(mf, _, _)], _) if mf == "M" => {
                let what = if freqs(&a).contains(&"A") { "more than annual data" } else { "no annual data" };
                return Err(format!("{} holds {what}: its time codes hold [{}]", a.id, freqs(&a).join(", ")));
            }
            _ => {
                return Err(format!(
                    "{} is not monthly only: its time codes hold [{}]",
                    m.id,
                    freqs(&m).join(", ")
                ))
            }
        };
        let named: BTreeSet<&str> = twin.dims.iter().map(String::as_str).collect();
        if names(&m) != named || names(&a) != named {
            let list = |s: BTreeSet<&str>| s.into_iter().collect::<Vec<_>>().join(", ");
            return Err(format!(
                "the dimensions differ: {} has [{}], {} has [{}], the file names [{}]",
                m.id,
                list(names(&m)),
                a.id,
                list(names(&a)),
                list(named)
            ));
        }
        let codes = |t: &TableMeta, dim: &str| -> HashSet<String> {
            t.dims
                .iter()
                .find(|(d, _)| d == dim)
                .map(|(_, cs)| cs.iter().map(|(c, _)| c.clone()).collect())
                .unwrap_or_default()
        };
        for (dim, _) in &m.dims {
            let (monthly, annual) = (codes(&m, dim), codes(&a, dim));
            if let Some(c) = monthly.iter().find(|c| !annual.contains(*c)) {
                return Err(format!("{} lacks the {dim} code {c} of {}", a.id, m.id));
            }
            let extra = annual.len() - monthly.len();
            let allowed = twin.extra_annual_codes.get(dim).copied().unwrap_or(0);
            if extra > allowed {
                return Err(format!(
                    "{} has {extra} {dim} codes beyond those of {}, the file counts {allowed}",
                    a.id, m.id
                ));
            }
        }
        let units = codes(&a, "unit");
        if let Some(u) = twin.unit.iter().find(|u| !units.contains(*u)) {
            return Err(format!("{} lacks the unit {u}", a.id));
        }
        Ok((m_end, a_end))
    }
}

/// The tests' small catalogue with every member of the registered groups as a World Bank country, for other groups' tests
/// that read a group as this group does.
#[cfg(test)]
pub(crate) fn test_world() -> Catalog {
    tests::world()
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
        Catalog::from_raw(&small_raw())
    }

    /// The files of `small`.
    fn small_raw() -> Raw {
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
        Raw {
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
        }
    }

    /// `small` with the other members of the registered groups as World Bank countries.
    pub(super) fn world() -> Catalog {
        let mut raw = small_raw();
        let more = [
            "RU", "ID", "MY", "PH", "SG", "TH", "BN", "VN", "LA", "MM", "KH", "TL", "GB", "IT", "EG", "ET", "IR", "AE",
            "AR", "SA", "TR",
        ];
        let list = raw.wb_countries[1].as_array_mut().unwrap();
        for c in more {
            list.push(json!({"id": c, "iso2Code": c, "name": format!("Land {c}"), "region": {"value": "Elsewhere"}}));
        }
        Catalog::from_raw(&raw)
    }

    fn countries(c: &Catalog, q: &str) -> Vec<String> {
        c.places(q)
            .into_iter()
            .map(|p| match p {
                Place::Country(c) => c,
                Place::Region => REGION.to_string(),
            })
            .collect()
    }

    #[test]
    fn a_short_country_name_reads_as_its_country() {
        let c = world();
        assert_eq!(countries(&c, "中国、日本、韩国人口老龄化的速度"), ["CN", "JP", "KR"]);
        assert_eq!(countries(&c, "2020年韩国的人均GDP"), ["KR"]);
        assert_eq!(countries(&c, "俄罗斯和伊朗的石油出口"), ["RU", "IR"]);
        assert_eq!(countries(&c, "埃及人口"), ["EG"]);
        assert_eq!(c.scope("韩国人口").1, ["韩国"]);
        // a name not in the catalogue's countries is not read
        assert!(countries(&small(), "叙利亚人口").is_empty());
    }

    #[test]
    fn a_group_reads_as_its_members_in_the_year_asked_and_the_latest_with_none() {
        let c = world();
        let brics = |q: &str| countries(&c, q);
        assert_eq!(brics("2010年金砖国家的GDP"), ["BR", "RU", "IN", "CN"]);
        assert_eq!(brics("金砖国家2011年GDP增长率"), ["BR", "RU", "IN", "CN", "ZA"]);
        assert_eq!(brics("2023年金砖的人口"), ["BR", "RU", "IN", "CN", "ZA"]);
        assert_eq!(brics("2024年金砖国家人口"), ["BR", "RU", "IN", "CN", "ZA", "EG", "ET", "IR", "AE"]);
        let latest = ["BR", "RU", "IN", "CN", "ZA", "EG", "ET", "IR", "AE", "ID"];
        assert_eq!(brics("金砖国家近十年的GDP增长率"), latest);
        let p = c.group_period("BRICS", None).unwrap();
        assert_eq!(p.members, latest);
        assert!(p.source.title.contains("Indonesia") && p.source.title.contains("2025"), "{:?}", p.source);
        assert!(p.source.url.starts_with("https://www.mfa.gov.cn/"), "{:?}", p.source);
        assert!(brics("2000年金砖国家人口").is_empty(), "no BRICS in 2000");

        assert_eq!(
            countries(&c, "东盟国家人均GDP"),
            ["ID", "MY", "PH", "SG", "TH", "BN", "VN", "LA", "MM", "KH", "TL"]
        );
        assert_eq!(
            countries(&c, "2020年东盟国家人均GDP"),
            ["ID", "MY", "PH", "SG", "TH", "BN", "VN", "LA", "MM", "KH"]
        );
        let g7 = ["FR", "DE", "IT", "JP", "GB", "US", "CA"];
        assert_eq!(countries(&c, "七国集团的人均碳排放"), g7);
        assert_eq!(countries(&c, "2015年G7的人均碳排放"), g7);
        assert!(countries(&c, "G77的人均碳排放").is_empty(), "G77 is not G7");
        assert_eq!(countries(&c, "二十国集团的人口").len(), 19);
        // a group and a country: in question order, the group word named once
        assert_eq!(countries(&c, "七国集团和中国的GDP"), [&g7[..], &["CN"]].concat());
        let (scope, named) = c.scope("七国集团和中国的GDP");
        assert_eq!((scope, named), (Scope::Beyond, vec!["七国集团".to_string(), "中国".to_string()]));
        // a member's English name in a search text is inside the group
        assert!(c.places_outside("七国集团的GDP", &texts(&["land jp gdp"])).is_empty());
        assert_eq!(c.places_outside("七国集团的GDP", &texts(&["land cn gdp"])), ["land cn"]);
    }

    /// A group page's basis: the members of the page's last year when the question names none (of the named year when it
    /// does), the line where the list changes inside the page's years or the group has members that are no country, none
    /// for a page of one year or a list that holds; no basis for a question naming no group.
    #[test]
    fn a_group_page_counts_the_members_of_its_last_year_and_says_so_where_they_change() {
        let c = world();
        let s = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let brics10 = ["BR", "RU", "IN", "CN", "ZA", "EG", "ET", "IR", "AE", "ID"];
        let g20 = ["AR", "AU", "BR", "CA", "CN", "FR", "DE", "IN", "ID", "IT", "JP", "KR", "MX", "RU", "SA", "ZA", "TR", "GB", "US"];
        // every place with a row at t1
        let gb = |q: &str, t0: Option<i32>, t1: i32, places: &[&str]| c.group_basis(q, (t0, t1), (&s(places), &s(places)));
        let q = "金砖国家近十年的GDP增长率";
        let changes = "按 {year} 年成员（{n} 国）计";
        let b = gb(q, Some(2016), 2025, &brics10).unwrap();
        assert_eq!((b.group.as_str(), b.year, b.members.len(), b.line.as_deref(), b.join.as_str()), ("BRICS", 2025, 10, Some(changes), "；"));
        assert!(b.named.is_empty() && b.dropped.is_empty() && b.missing.is_empty());
        let b = gb(q, Some(2016), 2024, &[&brics10[..], &["SA"]].concat()).unwrap();
        assert_eq!((b.year, b.members.len(), b.line.as_deref(), b.dropped.clone()), (2024, 9, Some(changes), s(&["ID", "SA"])), "no members in 2024");
        assert_eq!(gb(q, Some(2012), 2020, &brics10[..5]).unwrap().line, None, "five members all through");
        assert_eq!(gb(q, None, 2025, &brics10).unwrap().line, None, "a page of one year");
        let named = gb("2010年金砖国家的GDP", Some(2005), 2010, &brics10[..4]).unwrap();
        assert_eq!((named.year, named.members, named.line), (2010, s(&brics10[..4]), None));
        // a question naming its years spans them too, and the list is the page's last year's, not the year asked
        let b = gb("2016年到2025年金砖国家的GDP增长率", Some(2016), 2025, &brics10).unwrap();
        assert_eq!((b.year, b.line.as_deref()), (2025, Some(changes)), "years named, members changed inside them");
        let b = gb("2025年金砖国家的GDP", Some(2016), 2024, &[&brics10[..], &["SA"]].concat()).unwrap();
        assert_eq!((b.year, b.members.len(), b.line.as_deref()), (2024, 9, Some(changes)), "asked 2025, the data ends 2024");
        let named = gb("2010年金砖国家的GDP", Some(2005), 2015, &brics10[..5]).unwrap();
        assert_eq!((named.year, named.members.len(), named.line.as_deref()), (2015, 5, Some(changes)), "the page runs past the year asked");
        assert_eq!(gb("七国集团的人均碳排放", Some(1990), 2024, &["FR", "DE", "IT", "JP", "GB", "US", "CA"]).unwrap().line, None);
        let b = gb("二十国集团的人口", None, 2024, &g20).unwrap();
        assert_eq!((b.members.len(), b.line.as_deref()), (19, Some("按 {n} 个成员国计，不含欧盟、非洲联盟")));
        assert_eq!(gb("二十国集团的人口", Some(2000), 2020, &g20).unwrap().line.as_deref(), Some("按 {n} 个成员国计，不含欧盟"));
        assert_eq!(gb("中国和德国的GDP", Some(2016), 2025, &["CN", "DE"]), None);
        assert_eq!(gb("2000年金砖国家人口", None, 2000, &brics10), None, "a page of 2000: no BRICS that year");
        // a member with no row at t1 is named: the line counts the places drawn, in every case (one year, a list that holds)
        let no_et: Vec<String> = s(&brics10).into_iter().filter(|c| c != "ET").collect();
        let b = c.group_basis(q, (Some(2016), 2025), (&s(&brics10), &no_et)).unwrap();
        assert_eq!((b.missing.clone(), b.line.as_deref(), b.missing_join.as_str()), (s(&["ET"]), Some("按 {year} 年成员计，画出 {n} 国，{missing}无数据"), "、"));
        let b = c.group_basis(q, (None, 2025), (&s(&brics10), &no_et)).unwrap();
        assert_eq!(b.line.as_deref(), Some("按 {year} 年成员计，画出 {n} 国，{missing}无数据"), "one year, a member missing");
        let no_us: Vec<String> = s(&g20).into_iter().filter(|c| c != "US").collect();
        let b = c.group_basis("二十国集团的人口", (None, 2024), (&no_us, &no_us)).unwrap();
        assert_eq!((b.missing.clone(), b.line.as_deref()), (s(&["US"]), Some("按成员国计，不含欧盟、非洲联盟，画出 {n} 国，{missing}无数据")));
        // a place the question names on its own stays, and the count is of the places drawn
        let b = gb("日本和金砖国家近十年的GDP增长率", Some(2016), 2025, &[&brics10[..], &["JP", "SA"]].concat()).unwrap();
        assert_eq!((b.named.clone(), b.dropped.clone(), b.line.as_deref()), (s(&["JP"]), s(&["SA"]), Some("按 {year} 年成员计，画出 {n} 国")));
        let b = gb("中国和七国集团的GDP", Some(2016), 2024, &["CN", "FR", "DE", "IT", "JP", "GB", "US", "CA"]).unwrap();
        assert_eq!((b.named.clone(), b.dropped.clone(), b.line), (s(&["CN"]), Vec::new(), None), "China kept beside the G7");
        // the codes as the page's rows write them: Eurostat's UK for GB
        let b = gb("七国集团的GDP", None, 2024, &["FR", "DE", "IT", "JP", "UK", "US", "CA"]).unwrap();
        assert!(b.members.contains(&"UK".to_string()) && b.dropped.is_empty() && b.missing.is_empty(), "{b:?}");
    }

    /// A question's years fetch every member the page can end at (round-3 fix): a year it runs on from (since 2010) reads
    /// every list from that year to the latest, two years every list between them; the page's basis then names as having
    /// no data only a member that was fetched, and a member never fetched refuses the page (unfetched), never "no data".
    #[test]
    fn a_group_is_fetched_over_the_years_the_question_spans_and_a_member_never_fetched_is_no_missing_member() {
        let c = world();
        let s = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let brics10 = ["BR", "RU", "IN", "CN", "ZA", "EG", "ET", "IR", "AE", "ID"];
        // since 2010: every list from 2010 on, so the page's 2025 members are all fetched
        let q = "2010年以来金砖国家的GDP增长率";
        assert_eq!(countries(&c, q), brics10);
        let fetched = s(&brics10);
        let b = c.group_basis(q, (Some(2010), 2025), (&fetched, &fetched)).unwrap();
        assert_eq!((b.year, b.members.len(), b.missing.clone(), b.unfetched.clone()), (2025, 10, Vec::new(), Vec::new()));
        assert_eq!(b.line.as_deref(), Some("按 {year} 年成员（{n} 国）计"), "the list changes inside 2010..2025");
        // a member fetched with no row at all is missing (a fact of the data), not unfetched
        let no_et: Vec<String> = fetched.iter().filter(|c| *c != "ET").cloned().collect();
        let b = c.group_basis(q, (Some(2010), 2025), (&no_et, &no_et)).unwrap();
        assert_eq!((b.missing.clone(), b.unfetched.clone()), (s(&["ET"]), Vec::new()));
        // ASEAN since 2015: Timor-Leste, which joins in 2025, is fetched
        let q = "2015年以来东盟国家人均GDP";
        let asean11 = ["ID", "MY", "PH", "SG", "TH", "BN", "VN", "LA", "MM", "KH", "TL"];
        assert_eq!(countries(&c, q), asean11);
        let b = c.group_basis(q, (Some(2015), 2025), (&s(&asean11), &s(&asean11[..10]))).unwrap();
        assert_eq!((b.members.len(), b.missing.clone(), b.unfetched.clone()), (11, s(&["TL"]), Vec::new()), "fetched, no row at 2025");
        // two years: every list between them, none after
        let q = "2010年和2024年金砖国家的GDP";
        let nine = &brics10[..9];
        assert_eq!(countries(&c, q), nine);
        let b = c.group_basis(q, (Some(2010), 2024), (&s(nine), &s(nine))).unwrap();
        assert_eq!((b.year, b.members.len(), b.missing.clone(), b.unfetched.clone()), (2024, 9, Vec::new(), Vec::new()));
        assert_eq!(countries(&c, "2010年至2015年金砖国家的GDP"), &brics10[..5]);
        // one year with nothing run on from: its list alone; a page that runs past it to 2025 has members never fetched,
        // which are unfetched (the page is refused), never named as having no data
        let q = "2010年金砖国家的GDP";
        assert_eq!(countries(&c, q), &brics10[..4]);
        let b = c.group_basis(q, (Some(2010), 2025), (&s(&brics10[..4]), &s(&brics10[..4]))).unwrap();
        assert_eq!((b.missing.clone(), b.unfetched.clone()), (Vec::new(), s(&brics10[4..])));
        assert!(countries(&c, "2000年以来金砖国家人口").len() == 10 && countries(&c, "2000年金砖国家人口").is_empty());
    }

    #[test]
    fn the_published_lists_give_short_names_the_world_bank_list_holds_only_long() {
        let mut raw = small_raw();
        let list = raw.wb_countries[1].as_array_mut().unwrap();
        for c in ["HK", "MO", "SO", "YE", "BA", "CF", "CG", "CD"] {
            list.push(json!({"id": c, "iso2Code": c, "name": format!("Land {c}"), "region": {"value": "Elsewhere"}}));
        }
        let c = Catalog::from_raw(&raw);
        // short names from CLDR, FAO and the zh ISO 3166-1 list
        assert_eq!(countries(&c, "香港、澳门的人口密度"), ["HK", "MO"]);
        assert_eq!(countries(&c, "索马里和也门的粮食进口"), ["SO", "YE"]);
        assert_eq!(countries(&c, "波黑的失业率"), ["BA"]);
        // the excluded words do not read: China-Africa and an 'among them' split are no country, bare Congo is either one
        assert!(countries(&c, "中非合作论坛的贸易额").is_empty());
        assert!(countries(&c, "其中非洲国家的人口").is_empty());
        assert!(countries(&c, "刚果河流域的降雨").is_empty());
        let names = place_names_zh();
        assert!(names.aliases.iter().all(|a| !["中非", "刚果", "欧盟"].contains(&a.name.as_str())));
        // one name, one code across all lists
        for a in &names.aliases {
            assert!(names.aliases.iter().filter(|b| b.name == a.name).all(|b| b.iso2 == a.iso2), "{}", a.name);
        }
    }

    #[test]
    fn a_question_naming_no_group_or_alias_reads_as_before() {
        let (c, w) = (small(), world());
        for q in [
            "德国能源从来源到各部门",
            "欧盟各国可再生能源占比",
            "2020年中国和德国的电价",
            "中国和德国",
            "各国 65 岁以上人口比例",
            "发展中国家人口",
        ] {
            assert_eq!(countries(&c, q), countries(&w, q), "{q}");
            assert_eq!(c.scope(q), w.scope(q), "{q}");
        }
        assert_eq!(countries(&w, "2020年中国和德国的电价"), ["CN", "DE"]);
    }

    #[test]
    fn the_registered_groups_are_whole() {
        let names = place_names_zh();
        let sourced = |s: &SourceZh| !s.title.is_empty() && s.url.starts_with("https://") && s.accessed.len() == 10;
        assert!(names.aliases.iter().all(|a| a.iso2.len() == 2 && !a.name.is_empty() && sourced(&a.source)));
        assert!(names.aliases.iter().any(|a| a.name == "韩国" && a.iso2 == "KR"));
        for id in ["BRICS", "ASEAN", "G7", "G20"] {
            let g = names.groups.iter().find(|g| g.id == id).expect(id);
            assert!(!g.names.is_empty(), "{id}");
            for d in &g.disputed {
                assert!(d.sources.len() >= 2 && d.sources.iter().all(sourced), "{id} {}", d.iso2);
                assert!(g.periods.iter().all(|p| !p.members.contains(&d.iso2)), "{id}: disputed {} is no member", d.iso2);
            }
            for (i, p) in g.periods.iter().enumerate() {
                assert!(sourced(&p.source) && !p.members.is_empty(), "{id} {}", p.from);
                assert!(p.non_country_members.iter().all(|m| !m.name.is_empty() && sourced(&m.source)), "{id} {}", p.from);
                assert!(p.members.iter().all(|c| c.len() == 2), "{id} {}", p.from);
                match g.periods.get(i + 1) {
                    Some(next) => assert_eq!(p.to.map(|t| t + 1), Some(next.from), "{id} periods meet"),
                    None => assert_eq!(p.to, None, "{id} latest period is current"),
                }
            }
        }
        assert_eq!(question_span("2010年金砖国家"), Some((2010, Some(2010))));
        assert_eq!(question_span("2010年至2020年"), Some((2010, Some(2020))));
        assert_eq!(question_span("2015-2024 年"), Some((2015, Some(2024))));
        assert_eq!(question_span("2010 年以来金砖国家"), Some((2010, None)));
        assert_eq!(question_span("与 2015 年相比"), Some((2015, None)));
        assert_eq!(question_span("金砖国家近十年"), None);
        assert_eq!(question_span("12010年 65 岁"), None);
        assert_eq!(question_span("人均 2000 美元"), None, "a number before no year mark is no year");
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
        let r = c.top5("中国各省房价", &texts(&["energy"]), false, None);
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
    fn wb_units_registers_one_unit_per_indicator_from_the_closed_kinds() {
        let mut rows = lines(WB_UNITS);
        assert_eq!(
            rows.next(),
            Some("indicator\tname\tunit_code\tunit_label\tmeasure_kind\trule")
        );
        let mut seen = HashSet::new();
        for row in rows {
            let p: Vec<&str> = row.split('\t').collect();
            assert_eq!(p.len(), 6, "{row}");
            let (name, code) = (p[1].to_lowercase(), p[2]);
            assert!(seen.insert(p[0]), "{} twice", p[0]);
            assert!(
                p[4].is_empty() || WB_UNIT_KINDS.contains(&p[4]),
                "{row}: kind outside WB_UNIT_KINDS"
            );
            // A kind with no code is unused: the row gives no unit, and that chart stops at the page pack, named.
            assert!(
                !code.is_empty() || p[3].is_empty(),
                "{row}: a label with no code"
            );
            assert!(!p[5].is_empty(), "{row}: no rule");
            // "% of total population" only for a part of the whole population: not a subgroup's own population (a quintile).
            if code == "PC_POP" {
                let subgroup = [
                    "quintile", "decile", "bottom", "top", "poorest", "richest", "urban", "rural",
                    "female", "male",
                ]
                .iter()
                .any(|w| {
                    name.split(|c: char| !c.is_ascii_alphanumeric())
                        .any(|x| x == *w)
                });
                assert!(
                    name.ends_with("(% of total population)")
                        || (name.ends_with("(% of population)") && !subgroup),
                    "{row}: PC_POP on a name that is not of the total population"
                );
            }
            // A per-capita amount keeps its per inhabitant: no bare volume or mass code (a percentage change is fine).
            if name.contains("per capita") && !code.is_empty() {
                assert!(
                    code.contains("HAB") || code.starts_with("PC"),
                    "{row}: a per-capita name with a code that is not per inhabitant"
                );
            }
            // PC prints a level: never on a change or growth rate, nor on an amount of money ("% of" may sit inside its name).
            assert!(
                code != "PC" || (p[4] != "change" && !p[5].contains("money")),
                "{row}: PC on a change or a money amount"
            );
        }
        // The two World Bank bench measures (q4, q5): a per-capita amount and a part of the population; a quintile's coverage
        // is a plain percentage.
        let unit = |id: &str| wb_unit(id).map(|u| (u.code, u.kind));
        assert_eq!(
            unit("EN.GHG.CO2.PC.CE.AR5@2"),
            Some(("TCO2E_HAB".into(), Some("rate")))
        );
        assert_eq!(
            unit("SP.POP.65UP.TO.ZS"),
            Some(("PC_POP".into(), Some("share")))
        );
        // A part of a subgroup's own population ("% of female population") is a plain percentage, not PC_POP: q5's two
        // companions.
        for id in ["SP.POP.65UP.FE.ZS", "SP.POP.65UP.MA.ZS@2"] {
            assert_eq!(unit(id), Some(("PC".into(), Some("share"))), "{id}");
        }
        // A percentage change against a year its unit text names ("% change from 1990") takes that change's own code,
        // whose unit line prints the basis (unit-short-zh.tsv line_zh), never PC: s6's main and its three siblings.
        for id in ["EN.GHG.CH4.ZG.AR5", "EN.GHG.CO2.ZG.AR5", "EN.GHG.N2O.ZG.AR5", "EN.GHG.TOT.ZG.AR5@2"] {
            assert_eq!(unit(id), Some(("PCH_1990".into(), Some("change"))), "{id}");
        }
        // A percentage change or growth rate whose unit text states no basis the registry reads stays codeless: PC would
        // print it as a level.
        for id in [
            "FM.AST.CGOV.ZG.M3",
            "FM.AST.DOMO.ZG.M3",
            "FM.AST.PRVT.ZG.M3",
            "SI.SPR.PC40.ZG",
            "SI.SPR.PCAP.ZG",
        ] {
            assert_eq!(unit(id), None, "{id}");
        }
        // A quintile's coverage: a plain percentage too, never PC_POP (the quintile is not the total population).
        assert_eq!(
            unit("per_sa_allsa.cov_q1_tot@2"),
            Some(("PC".into(), Some("share")))
        );
        // "% of" inside the name but a money unit in its trailing parenthesis: dollars a day, never PC.
        assert_eq!(unit("SI.SPR.PC40@2"), None);
        assert_eq!(unit("ER.H2O.INTR.PC@2"), None);
        assert_eq!(unit("NO.SUCH.INDICATOR@2"), None);
    }

    #[test]
    fn a_table_s_freqs_and_spans_come_from_its_metabase_time_codes() {
        for (code, freq) in [
            ("2024", Some("A")),
            ("2024S1", Some("S")),
            ("2024Q1", Some("Q")),
            ("2024M08", Some("M")),
            ("2024W05", Some("W")),
            ("2024M08D01", Some("D")),
            ("LTAA", None),
            ("2024M8", None),
            ("2024Q", None),
            ("20245", None),
        ] {
            assert_eq!(time_freq(code), freq, "{code}");
        }
        // The metabase lists the newest first; first and last are the span, annual first, an unknown form left out.
        let toc = "\"title\"\t\"code\"\t\"type\"\n\"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"    Energy\"\t\"nrg\"\t\"folder\"\n\
                   \"        Monthly electricity\"\t\"nrg_m\"\t\"table\"\n";
        let metabase =
            "nrg_m\tgeo\tDE\nnrg_m\ttime\t2026M08\nnrg_m\ttime\t2025\nnrg_m\ttime\t2008M01\n\
                        nrg_m\ttime\tLTAA\nnrg_m\ttime\t2024\nnrg_m\ttime\t2019M03\n";
        let c = Catalog::from_raw(&Raw {
            toc: toc.into(),
            metabase: metabase.into(),
            cl: vec![("geo".into(), "DE\tGermany\r\n".into())],
            wb_indicators: json!([{}, []]),
            wb_countries: json!([{}, []]),
            wb_countries_zh: json!([{}, []]),
            nuts: "\u{feff}CNTR_CODE,NUTS_ID\r\n".into(),
        });
        let t = c.table("nrg_m").unwrap();
        let span = |f: &str, a: &str, b: &str| (f.to_string(), a.to_string(), b.to_string());
        assert_eq!(
            t.freqs,
            [span("A", "2024", "2025"), span("M", "2008M01", "2026M08")]
        );
        assert_eq!(t.freq(), Ok("A"));
        assert_eq!(t.dims.len(), 1, "time is no dimension of the fill");
        let monthly = TableMeta {
            freqs: vec![span("M", "2008M01", "2026M08")],
            ..t.clone()
        };
        assert_eq!(monthly.freq(), Ok("M"));
        let none = TableMeta {
            freqs: Vec::new(),
            ..t.clone()
        };
        assert_eq!(none.freq(), Ok("A"), "no time code asks A, as before");
        let two = TableMeta {
            freqs: vec![
                span("Q", "2008Q1", "2026Q2"),
                span("M", "2008M01", "2026M08"),
            ],
            ..t
        };
        assert!(two.freq().is_err());
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

    #[test]
    fn a_table_note_adds_its_words_to_that_table_s_text_and_no_note_changes_nothing() {
        let raw = small_raw();
        let plain = Catalog::with_notes(&raw, &[]);
        let note = |id: &str| TableNote {
            id: id.into(),
            words: "energy supply by source".into(),
        };
        let noted = Catalog::with_notes(&raw, &[note("nrg_src")]);
        let q = texts(&["supply by source"]);
        let before = plain.rank_in(&q, Scope::Europe);
        assert!(before.iter().all(|c| c.s == 0.0), "no title or folder holds the words");
        let after = noted.rank_in(&q, Scope::Europe);
        assert_eq!(ids(&after)[0], "nrg_src");
        assert!(after[0].s > 0.0 && after[1..].iter().all(|c| c.s == 0.0));
        // A note for a table the catalogue does not list, and the registered notes (none for these tables), leave every
        // ranking as with no notes, scores included.
        let absent = Catalog::with_notes(&raw, &[note("nrg_absent")]);
        let registered = Catalog::from_raw(&raw);
        for words in ["energy balance solar", "supply by source", "energy", "France energy prices"] {
            for scope in [Scope::Europe, Scope::Beyond] {
                let want = serde_json::to_value(plain.rank_in(&texts(&[words]), scope)).unwrap();
                for c in [&absent, &registered] {
                    assert_eq!(serde_json::to_value(c.rank_in(&texts(&[words]), scope)).unwrap(), want, "{words}");
                }
            }
        }
    }

    #[test]
    fn measure_families_registers_each_family_once_and_each_word_in_one_family() {
        let families = measure_families();
        let file: serde_json::Value = serde_json::from_str(MEASURE_FAMILIES).unwrap();
        assert_eq!(families.len(), file["families"].as_array().unwrap().len());
        assert!(!families.is_empty());
        let ids: HashSet<&str> = families.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids.len(), families.len(), "a family twice");
        let mut words: HashSet<Vec<char>> = HashSet::new();
        for f in families {
            assert!(!f.zh.is_empty() && !f.words.is_empty() && !toks(&f.en).is_empty() && !f.tables.is_empty(), "{f:?}");
            // The name is printed on a page that says a half cannot be answered: no number but from the data.
            assert!(!f.zh.chars().any(|c| c.is_ascii_digit()), "{f:?}");
            for w in &f.words {
                assert!(!measure_chars(w).is_empty(), "{f:?}: an empty word");
                assert!(words.insert(measure_chars(w)), "{f:?}: {w} in two families");
            }
            assert!(f.tables.iter().all(|t| !t.is_empty() && !t.contains('@')), "{f:?}");
        }
    }

    /// A share's whole is its denominator, not a quantity asked (user 11-05 10:2x): 占 GDP 比重 reads no gdp, 占总人口比例
    /// no population, while the same words outside a share still ask (GDP 和 ... ; 总人口).
    #[test]
    fn a_share_s_whole_is_no_asked_quantity() {
        let ids = |q: &str| asked_zh(q).into_iter().map(|a| a.id).collect::<Vec<_>>();
        assert!(ids("各国研发支出占GDP比重的变化").is_empty());
        assert!(ids("欧盟各国研发支出占 GDP 的百分比").is_empty());
        assert_eq!(ids("各国65岁以上人口占总人口比例"), ["pop65"]);
        assert_eq!(ids("各国GDP和老年人口占总人口的比重"), ["pop65", "gdp"]);
        assert_eq!(ids("各国总人口的变化"), ["population"]);
        // an opening word with no closing word near it blanks nothing
        assert_eq!(ids("各国碳排放占了多少，和GDP"), ["co2", "gdp"]);
        // 占比 is a share said whole, and a joining word ends a whole: the quantity asked after it stays asked (review 11-05)
        assert_eq!(ids("可再生能源占比和人均GDP的比重"), ["renewable_share", "gdp_pc"]);
        assert_eq!(ids("各国可再生能源占比，以及煤炭发电份额"), ["renewable_share", "electricity_mix"]);
        // the asked list is in the families' order, not the question's
        assert_eq!(ids("人均GDP和可再生能源占比的关系"), ["renewable_share", "gdp_pc"]);
    }

    /// Each dev question asks for one quantity, the DE question for two, and words that only narrow (a big-population
    /// filter) or name a dimension (origin countries) ask for none.
    #[test]
    fn asked_zh_reads_the_quantities_of_the_dev_questions() {
        let ids = |q: &str| asked_zh(q).into_iter().map(|a| a.id).collect::<Vec<_>>();
        for (q, want) in [
            ("欧盟各国可再生能源占比", vec!["renewable_share"]),
            ("德国能源从来源到各部门", vec!["energy_balance"]),
            ("欧盟各国发电结构", vec!["electricity_mix"]),
            ("人口大国 × 年份的人均碳排放", vec!["co2"]),
            ("各国 65 岁以上人口比例十年变化", vec!["pop65"]),
            ("欧盟庇护申请的来源国", vec!["asylum"]),
            (
                "德国能源转型：2023 年德国的一次能源从哪里来、最终用在哪里？请用桑基图展示一次能源到终端用途的流向，并用世界地图标出德国进口化石能源的主要来源国。",
                vec!["energy_balance", "energy_imports"],
            ),
            ("人均GDP和可再生能源占比的关系", vec!["renewable_share", "gdp_pc"]),
            ("人均 gdp 与 GDP", vec!["gdp_pc", "gdp"]),
            ("今天天气如何", vec![]),
        ] {
            assert_eq!(ids(q), want, "{q}");
        }
        let a = &asked_zh("人均GDP和可再生能源占比的关系")[1];
        assert_eq!(a.zh, "人均GDP");
        assert!(a.holds("nama_10_pc") && a.holds("NY.GDP.PCAP.CD@2") && !a.holds("nama_10_gdp"));
    }

    fn cand(id: &str, score: f64) -> Candidate {
        Candidate { id: id.into(), title: id.into(), score, s: score, v: 0.0, coverage: Coverage::Europe, twin_of: None }
    }

    fn asked_of(id: &str, tables: &[&str]) -> Asked {
        Asked { id: id.into(), zh: id.into(), tables: tables.iter().map(|t| t.to_string()).collect(), offered: Vec::new() }
    }

    /// Two asked quantities, the first filling the first five: the second's best ranked table takes the fifth place and
    /// the one it displaces moves down. One asked quantity, or two already both in the first five, leave the order as it was.
    /// A table outside a family's prefixes holds it when its catalogue title names the family's English words, and not when
    /// a family with more of those words names the title too: asylum's summary tables, a CO2 table under another id, a
    /// per-capita GDP title (gdp_pc's, not gdp's), and titles naming another quantity or only part of the words.
    #[test]
    fn an_asked_quantity_is_held_by_a_title_naming_its_words() {
        let fam = |id: &str| asked_zh(match id { "asylum" => "庇护申请", "co2" => "碳排放", "gdp" => "GDP", "gdp_pc" => "人均GDP", "population" => "总人口", _ => unreachable!() }).remove(0);
        let titled = |id: &str, title: &str| Candidate { title: title.into(), ..cand(id, 1.0) };
        let (asylum, co2, gdp, gdp_pc, population) = (fam("asylum"), fam("co2"), fam("gdp"), fam("gdp_pc"), fam("population"));
        assert_eq!((asylum.id.as_str(), gdp_pc.id.as_str()), ("asylum", "gdp_pc"));
        assert!(asylum.holds_candidate(&titled("tps00191", "Asylum applicants by type - annual aggregated data")));
        assert!(asylum.holds_candidate(&titled("migr_asyappctza", "migr_asyappctza")), "a prefix still holds");
        assert!(co2.holds_candidate(&titled("XYZ.CO2", "Carbon dioxide emissions by sector")));
        let per_capita = titled("tec00114", "Gross domestic product per capita in PPS");
        assert!(gdp_pc.holds_candidate(&per_capita) && !gdp.holds_candidate(&per_capita));
        assert!(gdp.holds_candidate(&titled("tec00001", "Gross domestic product at market prices")));
        assert!(!asylum.holds_candidate(&titled("tps00001", "Population on 1 January")));
        assert!(!population.holds_candidate(&titled("tps00001", "Population on 1 January")), "total is not in the title");
        assert!(!co2.holds_candidate(&titled("env_x", "Carbon footprint")), "part of the words");
    }

    #[test]
    fn lift_asked_keeps_a_place_for_each_asked_quantity() {
        let c = small();
        let ranked: Vec<Candidate> =
            ["ren_a", "ren_b", "ren_c", "ren_d", "ren_e", "ren_f", "gdp_pc_a", "gdp_pc_b"].iter().enumerate().map(|(k, id)| cand(id, 10.0 - k as f64)).collect();
        let ren = asked_of("renewable_share", &["ren_"]);
        let gdp = asked_of("gdp_pc", &["gdp_pc_"]);
        let lifted = c.lift_asked(ranked.clone(), &[ren.clone(), gdp.clone()], Scope::Beyond, &[]);
        assert_eq!(ids(&lifted[..TOP]), ["ren_a", "ren_b", "ren_c", "ren_d", "gdp_pc_a"]);
        assert_eq!(ids(&lifted[TOP..]), ["ren_e", "ren_f", "gdp_pc_b"]);
        assert_eq!(ids(&c.lift_asked(ranked.clone(), &[ren.clone()], Scope::Beyond, &[])), ids(&ranked));
        let both = c.lift_asked(ranked.clone(), &[ren.clone(), asked_of("x", &["ren_b"])], Scope::Beyond, &[]);
        assert_eq!(ids(&both), ids(&ranked));
        // The only table of an asked quantity in the first five is not the one displaced.
        let third = asked_of("third", &["ren_e"]);
        let kept = c.lift_asked(ranked.clone(), &[ren, third, gdp], Scope::Beyond, &[]);
        assert_eq!(ids(&kept[..TOP]), ["ren_a", "ren_b", "ren_c", "ren_e", "gdp_pc_a"]);
    }

    #[test]
    fn table_notes_registers_each_eurostat_table_once_with_words_that_hold_no_number() {
        let notes = table_notes();
        let file: serde_json::Value = serde_json::from_str(TABLE_NOTES).unwrap();
        assert_eq!(notes.len(), file["tables"].as_array().unwrap().len());
        assert!(!notes.is_empty());
        let tables: HashSet<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(tables.len(), notes.len(), "a table twice");
        for (n, entry) in notes.iter().zip(file["tables"].as_array().unwrap()) {
            assert_eq!(entry["id"], json!(n.id));
            let dims: Vec<&str> = entry["dims"].as_array().unwrap().iter().filter_map(|d| d.as_str()).collect();
            assert!(!dims.is_empty() && !dims.iter().any(|d| SKIP_DIMS.contains(d)), "{n:?}: {dims:?}");
            assert!(!n.id.is_empty() && !n.id.ends_with("@2"), "{n:?}");
            assert!(!toks(&n.words).is_empty(), "{n:?}");
            assert!(!n.words.chars().any(|c| c.is_ascii_digit()), "{n:?}");
        }
    }

    /// The q6 pair as monthly-twins.json registers it (migr_asyappctzm monthly only, migr_asyappctza its annual twin with
    /// the same codes) among other asylum tables, and nrg_cb_pem, monthly only with no registered twin, beside tables that
    /// each differ from it in one way, for crafted pairs: nrg_pa_more (annual, two more geo codes), nrg_pa_op (annual, one
    /// more dimension), nrg_pa_few (annual, a geo code fewer), nrg_pq (quarterly) and nrg_pa_mix (annual and monthly).
    fn twins_catalog() -> Catalog {
        let toc = "\"title\"\t\"code\"\t\"type\"\n\"Database by themes\"\t\"data\"\t\"folder\"\n\
                   \"    Asylum\"\t\"migr\"\t\"folder\"\n\
                   \"        Asylum applicants by type, citizenship, age and sex - monthly data\"\t\"migr_asyappctzm\"\t\"table\"\n\
                   \"        Asylum applicants by type, citizenship, age and sex - annual aggregated data\"\t\"migr_asyappctza\"\t\"table\"\n\
                   \"        Asylum applicants considered to be unaccompanied minors\"\t\"migr_asyunaa\"\t\"table\"\n\
                   \"        First instance decisions on applications by citizenship\"\t\"migr_asydcfsta\"\t\"table\"\n\
                   \"        Beneficiaries of temporary protection at the end of the month by citizenship\"\t\"migr_asytpsm\"\t\"table\"\n\
                   \"        First permits by reason\"\t\"migr_resfirst\"\t\"table\"\n\
                   \"    Energy\"\t\"nrg\"\t\"folder\"\n\
                   \"        Net electricity generation by type of fuel - monthly data\"\t\"nrg_cb_pem\"\t\"table\"\n\
                   \"        Electricity generation by fuel and operator\"\t\"nrg_pa_op\"\t\"table\"\n\
                   \"        Electricity generation by fuel in Germany\"\t\"nrg_pa_few\"\t\"table\"\n\
                   \"        Electricity generation by fuel\"\t\"nrg_pa_more\"\t\"table\"\n\
                   \"        Electricity generation by fuel - quarterly data\"\t\"nrg_pq\"\t\"table\"\n\
                   \"        Electricity generation by fuel - annual and monthly data\"\t\"nrg_pa_mix\"\t\"table\"\n";
        let asylum: &[(&str, &[&str])] = &[
            ("age", &["TOTAL"]),
            ("applicant", &["ASY_APP"]),
            ("citizen", &["SY", "AF"]),
            ("geo", &["EU27_2020", "DE"]),
            ("sex", &["T"]),
            ("unit", &["PER"]),
        ];
        let power: &[(&str, &[&str])] = &[("geo", &["DE", "FR"]), ("siec", &["TOTAL", "CF"]), ("unit", &["GWH"])];
        let monthly: &[(&str, &[&str])] = &[("time", &["2026M08", "2008M01"])];
        let annual: &[(&str, &[&str])] = &[("time", &["2025", "2008"])];
        let mut metabase = String::new();
        for (table, parts) in [
            ("migr_asyappctzm", vec![asylum, monthly]),
            ("migr_asyappctza", vec![asylum, annual]),
            ("migr_asyunaa", vec![&[("geo", &["EU27_2020"][..])][..], annual]),
            ("migr_asydcfsta", vec![&[("geo", &["EU27_2020"][..]), ("citizen", &["SY"][..])][..], annual]),
            ("migr_asytpsm", vec![&[("geo", &["EU27_2020"][..])][..], monthly]),
            ("migr_resfirst", vec![&[("geo", &["EU27_2020"][..])][..], annual]),
            ("nrg_cb_pem", vec![power, &[("time", &["2026M08", "2016M01"][..])][..]]),
            ("nrg_pa_op", vec![power, &[("operator", &["TOTAL"][..])][..], annual]),
            ("nrg_pa_few", vec![&[("geo", &["DE"][..]), ("siec", &["TOTAL", "CF"][..]), ("unit", &["GWH"][..])][..], annual]),
            ("nrg_pa_more", vec![&[("geo", &["DE", "FR", "IT", "ES"][..]), ("siec", &["TOTAL", "CF"][..]), ("unit", &["GWH"][..])][..], annual]),
            ("nrg_pq", vec![power, &[("time", &["2024Q1", "2024Q2"][..])][..]]),
            ("nrg_pa_mix", vec![power, &[("time", &["2025", "2025M01"][..])][..]]),
        ] {
            for (dim, codes) in parts.into_iter().flatten() {
                for code in *codes {
                    metabase.push_str(&format!("{table}\t{dim}\t{code}\n"));
                }
            }
        }
        Catalog::from_raw(&Raw {
            toc: toc.into(),
            metabase,
            cl: vec![
                ("geo".into(), "EU27_2020\tEuropean Union - 27 countries (from 2020)\r\nDE\tGermany\r\nFR\tFrance\r\nIT\tItaly\r\nES\tSpain\r\n".into()),
                ("citizen".into(), "SY\tSyria\r\nAF\tAfghanistan\r\n".into()),
                ("siec".into(), "TOTAL\tTotal\r\nCF\tCombustible fuels\r\n".into()),
                ("unit".into(), "PER\tPerson\r\nGWH\tGigawatt-hour\r\n".into()),
            ],
            wb_indicators: json!([{}, []]),
            wb_countries: json!([{}, []]),
            wb_countries_zh: json!([{}, []]),
            nuts: "\u{feff}CNTR_CODE,NUTS_ID\r\n".into(),
        })
    }

    #[test]
    fn a_monthly_only_table_is_offered_as_its_registered_annual_twin() {
        let c = twins_catalog();
        let q6 = "欧盟庇护申请的来源国";
        // The monthly table ranks first and its twin second: the twin takes the first place and its scores, once, and the
        // sixth table fills the five.
        let t = texts(&["asylum applicants citizenship monthly"]);
        let all = c.rank(q6, &t).candidates;
        assert_eq!(ids(&all)[..2], ["migr_asyappctzm", "migr_asyappctza"]);
        let r = c.top5(q6, &t, false, None);
        let want: Vec<&str> = std::iter::once("migr_asyappctza")
            .chain(ids(&all)[2..6].iter().copied())
            .collect();
        assert_eq!(ids(&r.candidates), want);
        let first = &r.candidates[0];
        assert_eq!(
            (first.score, first.s, first.v, first.title.as_str()),
            (all[0].score, all[0].s, all[0].v, all[1].title.as_str())
        );
        let twin = first.twin_of.as_ref().expect("the twin says what it stands for");
        assert_eq!(
            (twin.asked.as_str(), twin.used.as_str(), twin.found.as_str()),
            ("migr_asyappctzm", "migr_asyappctza", "id")
        );
        // What the swap costs: the annual table ends at 2025, the monthly one at 2026M08, both in the record.
        assert_eq!((twin.asked_end.as_str(), twin.used_end.as_str()), ("2026M08", "2025"));
        assert!(twin.why.contains("to 2026M08") && twin.why.contains("to 2025"), "{}", twin.why);
        assert!(r.candidates[1..].iter().all(|c| c.twin_of.is_none()));
        assert!(r.twins_refused.is_empty());
        // As the catalogue event records it: only the twin carries the new field.
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["candidates"][0]["twin_of"]["used"], "migr_asyappctza");
        assert_eq!(j["candidates"][0]["twin_of"]["asked_end"], "2026M08");
        assert_eq!(j["candidates"][0]["twin_of"]["used_end"], "2025");
        assert!(j["candidates"][1].get("twin_of").is_none());
        assert!(j.get("twins_refused").is_none());

        // The twin ranks above its monthly table: it keeps its own place and scores, and the monthly one is not offered.
        let t = texts(&["asylum applicants citizenship annual aggregated"]);
        let all = c.rank(q6, &t).candidates;
        assert_eq!(ids(&all)[..2], ["migr_asyappctza", "migr_asyappctzm"]);
        let r = c.top5(q6, &t, false, None);
        let want: Vec<&str> = std::iter::once("migr_asyappctza")
            .chain(ids(&all)[2..6].iter().copied())
            .collect();
        assert_eq!(ids(&r.candidates), want);
        assert_eq!(r.candidates[0].score, all[0].score);
        assert_eq!(
            r.candidates[0].twin_of.as_ref().map(|t| t.asked.as_str()),
            Some("migr_asyappctzm")
        );
    }

    #[test]
    fn a_question_asking_for_months_keeps_the_monthly_only_table() {
        let c = twins_catalog();
        let q6 = "2026 年 3 月欧盟庇护申请的来源国";
        for t in [
            texts(&["asylum applicants citizenship monthly"]),
            texts(&["asylum applicants citizenship annual aggregated"]),
        ] {
            let mut all = c.rank(q6, &t);
            assert!(ids(&all.candidates[..2]).contains(&"migr_asyappctzm"));
            // months: the five as ranked, the monthly table in its place, the pair recorded as not swapped
            let r = c.top5(q6, &t, true, None);
            all.candidates.truncate(TOP);
            assert_eq!(ids(&r.candidates), ids(&all.candidates));
            assert!(r.candidates.iter().all(|c| c.twin_of.is_none()));
            assert_eq!(r.twins_refused.len(), 1);
            let refused = &r.twins_refused[0];
            assert_eq!((refused.monthly.as_str(), refused.annual.as_str()), ("migr_asyappctzm", "migr_asyappctza"));
            assert!(refused.why.contains("asks for months"), "{}", refused.why);
            // the same question and words without months: swapped
            let r = c.top5(q6, &t, false, None);
            assert_eq!(r.candidates[0].id, "migr_asyappctza");
            assert!(!ids(&r.candidates).contains(&"migr_asyappctzm"));
            assert!(r.twins_refused.is_empty());
        }
    }

    #[test]
    fn a_question_naming_a_year_past_the_annual_twin_keeps_the_monthly_only_table() {
        let c = twins_catalog();
        // migr_asyappctzm runs to 2026M08, its twin migr_asyappctza to 2025.
        let q6 = "2026 年欧盟庇护申请的来源国";
        for t in [
            texts(&["asylum applicants citizenship monthly"]),
            texts(&["asylum applicants citizenship annual aggregated"]),
        ] {
            let mut all = c.rank(q6, &t);
            assert!(ids(&all.candidates[..2]).contains(&"migr_asyappctzm"));
            all.candidates.truncate(TOP);
            // 2026, past the annual table's 2025: the five as ranked, the monthly table in its place, the pair recorded
            let r = c.top5(q6, &t, false, Some(2026));
            assert_eq!(ids(&r.candidates), ids(&all.candidates));
            assert!(r.candidates.iter().all(|c| c.twin_of.is_none()));
            assert_eq!(r.twins_refused.len(), 1);
            let refused = &r.twins_refused[0];
            assert_eq!((refused.monthly.as_str(), refused.annual.as_str()), ("migr_asyappctzm", "migr_asyappctza"));
            assert!(
                refused.why.contains("names 2026") && refused.why.contains("last year 2025") && refused.why.contains("to 2026M08"),
                "{}",
                refused.why
            );
            // as the catalogue event records it
            let j = serde_json::to_value(&r).unwrap();
            assert_eq!(j["twins_refused"][0]["monthly"], "migr_asyappctzm");
            // months as well: refused once, for the months
            let r = c.top5(q6, &t, true, Some(2026));
            assert_eq!(ids(&r.candidates), ids(&all.candidates));
            assert_eq!(r.twins_refused.len(), 1);
            assert!(r.twins_refused[0].why.contains("asks for months"), "{}", r.twins_refused[0].why);
            // a year the annual table holds (its last one too), or no year named: swapped
            for year in [Some(2024), Some(2025), None] {
                let r = c.top5(q6, &t, false, year);
                assert_eq!(r.candidates[0].id, "migr_asyappctza", "{year:?}");
                assert_eq!(r.candidates[0].twin_of.as_ref().map(|t| t.used_end.as_str()), Some("2025"), "{year:?}");
                assert!(!ids(&r.candidates).contains(&"migr_asyappctzm"), "{year:?}");
                assert!(r.twins_refused.is_empty(), "{year:?}");
            }
        }
    }

    #[test]
    fn a_monthly_only_table_with_no_registered_twin_ranks_as_before() {
        let c = twins_catalog();
        let q3 = "欧盟各国发电结构";
        let t = texts(&["net electricity generation fuel monthly"]);
        let mut all = c.rank(q3, &t);
        assert_eq!(all.candidates[0].id, "nrg_cb_pem");
        all.candidates.truncate(TOP);
        // the asked record's offered tables are the top five's (top5 fills them; rank alone offers none): nrg_cb_pem by its
        // prefix, the four annual ones by their titles ("Electricity generation by fuel ...")
        let got = c.top5(q3, &t, false, None);
        let want: Vec<String> = ["nrg_cb_pem", "nrg_pa_mix", "nrg_pa_more", "nrg_pa_few", "nrg_pa_op"].iter().map(|s| s.to_string()).collect();
        assert_eq!(got.asked.iter().map(|a| a.offered.clone()).collect::<Vec<_>>(), vec![want]);
        all.asked = got.asked.clone();
        assert_eq!(serde_json::to_value(got).unwrap(), serde_json::to_value(all).unwrap());
    }

    #[test]
    fn a_registered_twin_that_fails_a_check_in_this_catalogue_is_not_swapped() {
        let c = twins_catalog();
        let t = texts(&["net electricity generation fuel monthly"]);
        let ranked = c.rank("欧盟各国发电结构", &t).candidates;
        assert!(ids(&ranked[..TOP]).contains(&"nrg_cb_pem"));
        let pair = |annual: &str, dims: &[&str], extra: &[(&str, usize)], unit: &[&str]| Twin {
            monthly: "nrg_cb_pem".into(),
            annual: annual.into(),
            found: "id".into(),
            dims: dims.iter().map(|d| d.to_string()).collect(),
            extra_annual_codes: extra.iter().map(|(d, n)| (d.to_string(), *n)).collect(),
            unit: unit.iter().map(|u| u.to_string()).collect(),
        };
        let dims = ["geo", "siec", "unit"];
        // Every monthly code in the annual table, with no more extra codes than the file counts: swapped.
        let (got, refused) = c.twin_swap(ranked.clone(), &[pair("nrg_pa_more", &dims, &[("geo", 2)], &["GWH"])], false, None);
        assert!(refused.is_empty(), "{refused:?}");
        assert_eq!(got.len(), TOP);
        assert!(!ids(&got).contains(&"nrg_cb_pem"));
        let twin: Vec<&Candidate> = got.iter().filter(|c| c.id == "nrg_pa_more").collect();
        assert_eq!(twin.len(), 1);
        assert_eq!(
            twin[0].twin_of.as_ref().map(|t| t.asked.as_str()),
            Some("nrg_cb_pem")
        );
        // Any check failing keeps the five as ranked, and says which.
        let not_monthly = Twin {
            monthly: "nrg_pa_more".into(),
            ..pair("nrg_pa_op", &dims, &[], &["GWH"])
        };
        for (twin, why) in [
            (
                pair("nrg_pa_more", &dims, &[("geo", 1)], &["GWH"]),
                "nrg_pa_more has 2 geo codes beyond those of nrg_cb_pem, the file counts 1",
            ),
            (pair("nrg_pa_op", &dims, &[], &["GWH"]), "the dimensions differ"),
            (
                pair("nrg_pa_op", &["geo", "operator", "siec", "unit"], &[], &["GWH"]),
                "the dimensions differ",
            ),
            (pair("nrg_pa_few", &dims, &[], &["GWH"]), "nrg_pa_few lacks the geo code FR of nrg_cb_pem"),
            (pair("nrg_pq", &dims, &[], &["GWH"]), "nrg_pq holds no annual data"),
            (pair("nrg_pa_mix", &dims, &[], &["GWH"]), "nrg_pa_mix holds more than annual data"),
            (pair("nrg_pa_more", &dims, &[("geo", 2)], &["TJ"]), "nrg_pa_more lacks the unit TJ"),
            (pair("nrg_no_such", &dims, &[], &[]), "nrg_no_such is not among the tables"),
            (not_monthly, "nrg_pa_more is not monthly only"),
        ] {
            let (got, refused) = c.twin_swap(ranked.clone(), std::slice::from_ref(&twin), false, None);
            assert_eq!(ids(&got), ids(&ranked[..TOP]), "{why}");
            assert!(got.iter().all(|c| c.twin_of.is_none()), "{why}");
            assert_eq!(refused.len(), 1, "{why}");
            assert!(refused[0].why.contains(why), "{} vs {why}", refused[0].why);
            assert_eq!(
                (refused[0].monthly.as_str(), refused[0].annual.as_str()),
                (twin.monthly.as_str(), twin.annual.as_str())
            );
        }
    }

    #[test]
    fn monthly_twins_registers_each_monthly_table_once_with_another_annual_one() {
        let twins = monthly_twins();
        let file: serde_json::Value = serde_json::from_str(MONTHLY_TWINS).unwrap();
        assert_eq!(twins.len(), file["pairs"].as_array().unwrap().len());
        assert!(!twins.is_empty());
        let monthly: HashSet<&str> = twins.iter().map(|t| t.monthly.as_str()).collect();
        let annual: HashSet<&str> = twins.iter().map(|t| t.annual.as_str()).collect();
        assert_eq!(monthly.len(), twins.len(), "a monthly table twice");
        assert_eq!(annual.len(), twins.len(), "an annual table twice");
        assert!(monthly.is_disjoint(&annual), "a table on both sides");
        for t in twins {
            assert!(["id", "title", "id+title"].contains(&t.found.as_str()), "{t:?}");
            assert!(!t.dims.is_empty() && !t.dims.iter().any(|d| d == "time"), "{t:?}");
            assert!(t.extra_annual_codes.keys().all(|d| t.dims.contains(d)), "{t:?}");
            assert_eq!(t.unit.is_empty(), !t.dims.iter().any(|d| d == "unit"), "{t:?}");
            assert!(!t.monthly.ends_with("@2") && !t.annual.ends_with("@2"), "{t:?}");
        }
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
            false,
            None,
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

    /// The registered twins on the real catalogue: each golden row of replay_v5geo (its phrasings and stand-in rows, both
    /// scopes) and the 6 questions with their stand-in A words, and the rows of L5GEO_TWINS_ROWS when set (a TSV of label,
    /// question, words), printed as one JSON line each with its first five before the swap and after it. A row may change
    /// only by a registered monthly-only table giving way to its annual twin, the next ranked table filling the five. The
    /// questions' top5 is timed with and without the swap.
    /// L5GEO_DIR=<registry>/l5geo/catalog L5GEO_REPLAY=<registry> cargo test l5geo::tests::replay_v5geo_twins -- --include-ignored --nocapture
    #[test]
    #[ignore]
    fn replay_v5geo_twins() {
        let dir = std::path::PathBuf::from(std::env::var("L5GEO_DIR").expect("L5GEO_DIR"));
        let reg = std::path::PathBuf::from(std::env::var("L5GEO_REPLAY").expect("L5GEO_REPLAY"));
        let read = |p: &str| std::fs::read_to_string(reg.join(p)).unwrap();
        let c = Catalog::load(&dir).unwrap();
        let want: serde_json::Value = serde_json::from_str(&read("v5geo/out-v5geo.json")).unwrap();
        let twins = monthly_twins();
        let monthly: HashMap<&str, &str> = twins.iter().map(|t| (t.monthly.as_str(), t.annual.as_str())).collect();
        let mut bad = Vec::new();
        let mut changed = 0;
        let mut rows = 0;
        let mut row = |kind: &str, label: String, scope: &str, ranked: &[Candidate], after: &Ranking| {
            let before = ids(&ranked[..ranked.len().min(TOP)]);
            let got = ids(&after.candidates);
            let removed: Vec<&str> = before.iter().copied().filter(|i| !got.contains(i)).collect();
            let added: Vec<&str> = got.iter().copied().filter(|i| !before.contains(i)).collect();
            for r in &removed {
                if !monthly.contains_key(r) {
                    bad.push(format!("{kind} {label} {scope}: {r} left the five and is no registered monthly table"));
                }
            }
            let fills = ids(&ranked[TOP.min(ranked.len())..(TOP + removed.len()).min(ranked.len())]);
            for a in &added {
                if !removed.iter().any(|r| monthly.get(r) == Some(a)) && !fills.contains(a) {
                    bad.push(format!("{kind} {label} {scope}: {a} joined the five as neither a twin nor the next ranked"));
                }
            }
            for t in after.candidates.iter().filter_map(|c| c.twin_of.as_ref()) {
                if monthly.get(t.asked.as_str()) != Some(&t.used.as_str()) || !before.contains(&t.asked.as_str()) {
                    bad.push(format!("{kind} {label} {scope}: twin_of {t:?}"));
                }
            }
            rows += 1;
            changed += usize::from(before != got);
            println!(
                "twins {}",
                json!({"kind": kind, "label": label, "scope": scope, "before": before, "after": got,
                    "changed": before != got,
                    "twins": after.candidates.iter().filter_map(|c| c.twin_of.as_ref()).collect::<Vec<_>>(),
                    "refused": after.twins_refused})
            );
        };
        let swapped = |ranked: &[Candidate]| {
            let (candidates, twins_refused) = c.twin_swap(ranked.to_vec(), twins, false, None);
            Ranking { scope: Scope::Europe, places_zh: Vec::new(), uncovered: None, candidates, twins_refused, asked: Vec::new() }
        };
        let scope_of = |q: &str| c.scope(ORIG.iter().find(|(k, _)| *k == q).unwrap().1).0;
        for r in want["phrasings"].as_array().unwrap() {
            let q = r["q"].as_str().unwrap();
            let ph = texts(&[r["phrasing"].as_str().unwrap()]);
            for (name, scope) in [("L5-none", Scope::Europe), ("L5geo", scope_of(q))] {
                let ranked = c.rank_in(&ph, scope);
                row("phrasing", format!("{q} {}", ph[0]), name, &ranked, &swapped(&ranked));
            }
        }
        let a_file = read("standin-query-1025/A-one-query.txt");
        let a: HashMap<&str, &str> = a_file.lines().filter_map(|l| l.split_once(": ")).collect();
        let b_file = read("standin-query-1025/B-terms.jsonl");
        let b: HashMap<String, serde_json::Value> = b_file
            .lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .map(|j| (j["id"].as_str().unwrap().to_lowercase(), j))
            .collect();
        for r in want["standin"].as_array().unwrap() {
            let q = r["q"].as_str().unwrap();
            let t: Vec<String> = if r["variant"] == "A" {
                texts(&[a[q].trim()])
            } else {
                b[q]["terms"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect()
            };
            for (name, scope) in [("L5-none", Scope::Europe), ("L5geo", scope_of(q))] {
                let ranked = c.rank_in(&t, scope);
                let label = format!("{q} {} {}", r["variant"].as_str().unwrap(), t.join(" | "));
                row("standin", label, name, &ranked, &swapped(&ranked));
            }
        }
        let mut asked: Vec<(String, String, String)> =
            ORIG.iter().map(|(q, zh)| (q.to_string(), zh.to_string(), a[q].trim().to_string())).collect();
        if let Ok(path) = std::env::var("L5GEO_TWINS_ROWS") {
            for line in std::fs::read_to_string(path).unwrap().lines() {
                if let [label, question, words] = line.split('\t').collect::<Vec<_>>()[..] {
                    asked.push((label.into(), question.into(), words.into()));
                }
            }
        }
        let ms = |t: std::time::Instant| t.elapsed().as_secs_f64() * 1000.0;
        for (label, zh, words) in &asked {
            let t = texts(&[words]);
            let t0 = std::time::Instant::now();
            let mut plain = c.rank(zh, &t);
            plain.candidates.truncate(TOP);
            let plain_ms = ms(t0);
            let t1 = std::time::Instant::now();
            let after = c.top5(zh, &t, false, None);
            let swap_ms = ms(t1);
            let ranked = c.rank(zh, &t).candidates;
            println!("time {label} rank+truncate {plain_ms:.1} ms, top5 {swap_ms:.1} ms, refused {}", after.twins_refused.len());
            row("question", format!("{label} {zh} {words}"), "top5", &ranked, &after);
        }
        println!("rows {rows}, changed {changed}");
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    /// The search words of the other five dev questions as their stand-in runs wrote them (each run's first search answer
    /// that reached the catalogue, runs of 10-28 to 10-31), with the run's question.
    const NOTE_LOCKED: [(&str, &str, &str); 19] = [
        ("q1", "欧盟各国可再生能源占比", "share of renewable energy in gross final energy consumption by country"),
        ("q1", "欧盟各国可再生能源占比", "share of renewable energy in gross final energy consumption"),
        ("q1", "欧盟各国可再生能源占比", "share of renewable energy in gross final energy consumption EU countries"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share of gross final energy consumption"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share gross final energy consumption"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share gross final energy consumption by country"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share gross final energy consumption EU countries"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share gross final consumption by country"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share by country EU"),
        ("q1", "欧盟各国可再生能源占比", "renewable energy share EU countries"),
        ("q3", "欧盟各国发电结构", "electricity generation by fuel type EU countries"),
        ("q4", "人口大国 × 年份的人均碳排放", "CO2 emissions per capita by country"),
        ("q4", "人口大国 × 年份的人均碳排放", "carbon dioxide emissions per capita population country year"),
        ("q5", "各国 65 岁以上人口比例十年变化", "population aged 65+ share of total population by country"),
        ("q5", "各国 65 岁以上人口比例十年变化", "population aged 65+ share of total population"),
        ("q5", "各国 65 岁以上人口比例十年变化", "population aged 65+ share by country"),
        ("q5", "各国 65 岁以上人口比例十年变化", "population aged 65 and over percent of total population ageing age structure"),
        ("q6", "欧盟庇护申请的来源国", "asylum applicants by citizenship"),
        ("q6", "欧盟庇护申请的来源国", "asylum applicants by citizenship EU"),
    ];

    /// The registered table notes on the real catalogue: q2's stand-in search words reach nrg_bal_s in the first five only
    /// with the notes, and every NOTE_LOCKED row gets the same first five with and without them. Each note's table is
    /// listed with the dimensions the note names, and its words hold no place name.
    /// L5GEO_DIR=<registry>/l5geo/catalog cargo test l5geo::tests::table_notes_on_the_real_catalogue -- --include-ignored --nocapture
    #[test]
    #[ignore]
    fn table_notes_on_the_real_catalogue() {
        let dir = std::path::PathBuf::from(std::env::var("L5GEO_DIR").expect("L5GEO_DIR"));
        let raw = Raw::read(&dir).unwrap();
        let with = Catalog::from_raw(&raw);
        let without = Catalog::with_notes(&raw, &[]);
        let file: serde_json::Value = serde_json::from_str(TABLE_NOTES).unwrap();
        for (n, entry) in table_notes().iter().zip(file["tables"].as_array().unwrap()) {
            let t = with
                .table(&n.id)
                .unwrap_or_else(|| panic!("{} is not in the catalogue", n.id));
            for d in entry["dims"].as_array().unwrap().iter().filter_map(|d| d.as_str()) {
                assert!(t.dims.iter().any(|(dim, _)| dim == d), "{}: no dimension {d}", n.id);
            }
            assert!(with.split_places(&n.words).0.is_empty(), "{}: a place name", n.id);
        }
        let five = |c: &Catalog, zh: &str, words: &str| -> Vec<String> {
            let r = c.top5(zh, &texts(&[words]), false, None);
            r.candidates.into_iter().map(|c| c.id).collect()
        };
        let (zh, words) = ("德国能源从来源到各部门", "Germany energy supply by source and final consumption by sector");
        let place = |c: &Catalog| {
            let r = c.rank(zh, &texts(&[words]));
            r.candidates.iter().position(|c| c.id == "nrg_bal_s").map(|n| n + 1)
        };
        println!("q2 nrg_bal_s ranked {:?} without the notes, {:?} with them", place(&without), place(&with));
        let (before, after) = (five(&without, zh, words), five(&with, zh, words));
        println!("q2 first five without {before:?}, with {after:?}");
        assert!(!before.iter().any(|id| id == "nrg_bal_s"), "{before:?}");
        assert!(after.iter().any(|id| id == "nrg_bal_s"), "{after:?}");
        let mut bad = Vec::new();
        for (q, zh, words) in NOTE_LOCKED {
            let (before, after) = (five(&without, zh, words), five(&with, zh, words));
            println!("{q} {words}: {after:?}");
            if before != after {
                bad.push(format!("{q} {words}: {before:?} -> {after:?}"));
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    /// t2 and q4: a ranking phrase reads as a ranking by the reference indicator, with the count it writes (Chinese numerals
    /// or digits) or none; two shapes of words (a count after the phrase, a count before it) and a second reference.
    #[test]
    fn a_ranking_phrase_reads_as_a_ranking_with_its_count() {
        let asked = |q: &str| rank_asked_zh(q).map(|r| (r.by, r.n, r.phrase));
        let pop = |n: Option<usize>, phrase: &str| Some(("SP.POP.TOTL".to_string(), n, phrase.to_string()));
        assert_eq!(asked("世界人口最多的十个国家的预期寿命"), pop(Some(10), "人口最多的十个"));
        assert_eq!(asked("人口大国 × 年份的人均碳排放"), pop(None, "人口大国"));
        assert_eq!(asked("人口最多的 5 个国家的失业率"), pop(Some(5), "人口最多的5个"));
        assert_eq!(asked("人口最多的前二十个国家"), pop(Some(20), "人口最多的前二十个"));
        assert_eq!(asked("十二大人口国的城市化率"), pop(Some(12), "十二大人口国"));
        assert_eq!(asked("人口最多的几个国家"), pop(None, "人口最多"));
        assert_eq!(
            asked("全球十大经济体的通胀率"),
            Some(("NY.GDP.MKTP.CD".to_string(), Some(10), "十大经济体".to_string()))
        );
        // no phrase: the question reads as before
        assert_eq!(asked("欧盟各国可再生能源占比"), None);
        assert_eq!(asked("德国、法国、意大利二十年来的能源进口依存度"), None);
    }

    /// Must fail: words of two references (which ranking is meant is not fixed) and a level below the country (the most
    /// populous cities) read as no ranking.
    #[test]
    fn a_ranking_phrase_that_is_not_fixed_or_is_below_the_country_is_not_read() {
        assert_eq!(rank_asked_zh("中国作为世界第二大经济体的出口增长"), None, "an ordinal is no count");
        assert_eq!(rank_asked_zh("第3大人口国的城市化率"), None);
        assert_eq!(rank_asked_zh("人口最多和经济规模最大的国家"), None);
        assert_eq!(rank_asked_zh("中国人口最多的主要城市"), None);
        assert_eq!(rank_asked_zh("美国各州人口最多的十个"), None);
    }

    /// Must fail: the word list holds words and a reference only. An entry that types the economies (a members or codes
    /// list), a reference that is no indicator code, a word with no Chinese, two slots or two entries of one reference is
    /// refused when the file is read; the file in the repository is the registered form.
    #[test]
    fn a_typed_list_of_economies_in_the_ranking_words_is_refused() {
        assert!(rank_phrases_from(RANK_PHRASES).is_ok());
        let file = |phrases: serde_json::Value| json!({"note": "x", "phrases": phrases}).to_string();
        let typed = file(json!([{"by": "SP.POP.TOTL", "words": ["人口最多"], "members": ["CN", "IN", "US"]}]));
        assert!(rank_phrases_from(&typed).unwrap_err().contains("members"), "{typed}");
        let codes = file(json!([{"by": "SP.POP.TOTL", "words": ["人口最多"], "codes": ["CHN"]}]));
        assert!(rank_phrases_from(&codes).is_err());
        let top = json!({"note": "x", "phrases": [], "economies": ["CN"]}).to_string();
        assert!(rank_phrases_from(&top).is_err());
        let not_code = file(json!([{"by": "China, India", "words": ["人口最多"]}]));
        assert!(rank_phrases_from(&not_code).unwrap_err().contains("not an indicator code"));
        let no_zh = file(json!([{"by": "SP.POP.TOTL", "words": ["top {n}"]}]));
        assert!(rank_phrases_from(&no_zh).unwrap_err().contains("no Chinese"));
        let two = file(json!([{"by": "SP.POP.TOTL", "words": ["前{n}到{n}"]}]));
        assert!(rank_phrases_from(&two).unwrap_err().contains("two count slots"));
        let twice = file(json!([{"by": "SP.POP.TOTL", "words": ["人口最多"]}, {"by": "SP.POP.TOTL", "words": ["人口大国"]}]));
        assert!(rank_phrases_from(&twice).unwrap_err().contains("two entries"));
    }

    #[test]
    fn a_count_reads_digits_and_chinese_numerals() {
        let at = |s: &str| count_at(&s.chars().collect::<Vec<_>>(), 0);
        assert_eq!(at("十个"), Some((10, 1)));
        assert_eq!(at("十一个"), Some((11, 2)));
        assert_eq!(at("二十个"), Some((20, 2)));
        assert_eq!(at("九十九"), Some((99, 3)));
        assert_eq!(at("两个"), Some((2, 1)));
        assert_eq!(at("12个"), Some((12, 2)));
        assert_eq!(at("0个"), None);
        assert_eq!(at("个"), None);
    }
}
