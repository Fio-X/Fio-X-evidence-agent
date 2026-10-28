//! Data side: the role of every dimension of one table and the class of every code (research page dim-roles v5,
//! sections 1-6). Pure: the caller reads the table into rows and loads the reference lists once. Totals are only
//! believed when the data adds up (or an official list says so); nothing here is filled from the model.
//! The chart matcher reads the result through `varying`, never changes it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::shape_registry::{Role, Shape, VaryingDim};

/// Largest relative difference a total may have from the sum of its parts (design 3a; inferred until measured).
pub const TOLERANCE: f64 = 0.005;
/// Share of a dimension's codes that must be places for it to count as a place (dim-roles 2; inferred).
pub const PLACE_SHARE: f64 = 0.8;

const ROLE_ORDER: [Role; 9] = [
    Role::Time,
    Role::Unit,
    Role::Place,
    Role::FlowSource,
    Role::FlowTarget,
    Role::AdditiveCategory,
    Role::Category,
    Role::Pick,
    Role::Unknown,
];
const AGG_PREFIX: [&str; 4] = ["EU", "EA", "EEA", "EFTA"];
const SPECIAL: [&str; 3] = ["UNK", "NRP", "STLS"];
/// Eurostat's two exceptions to ISO 3166-1 alpha-2.
const ISO_ALIAS: [(&str, &str); 2] = [("EL", "GR"), ("UK", "GB")];

/// One table cell: codes in `dims` order, the period, the value.
pub type Row = (Vec<String>, Option<String>, f64);

#[derive(Clone, Debug)]
pub struct DimInput {
    pub id: String,
    /// Codes this table uses, in codelist order. Time is not a dimension here; it rides on each row.
    pub codes: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct TableInput {
    /// "eurostat" or "worldbank".
    pub provider: String,
    pub dataset: String,
    pub dims: Vec<DimInput>,
    pub rows: Vec<Row>,
    /// Cells without a value whose status the file itself labels "data cannot exist"; the self-check reads them
    /// as 0 and nothing else does (design 3a).
    pub zero_cells: Vec<(Vec<String>, Option<String>)>,
}

/// What the question or an earlier step already fixed.
#[derive(Clone, Debug, Default)]
pub struct Ask {
    /// Dimension id -> code.
    pub given: BTreeMap<String, String>,
    /// The question names a sub-national level (dim-roles 4: the six level words).
    pub fine_place: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    Member,
    Total,
    TotalUnchecked,
    Subtotal,
    Duplicate,
    Special,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowDirection {
    Official,
    Unknown,
}

pub type Slice = BTreeMap<String, String>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoleTag {
    pub role: Role,
    pub basis: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PickValue {
    pub code: String,
    pub basis: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CodeClass {
    pub code: String,
    pub class: Class,
    pub basis: String,
    pub level: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DimRole {
    pub dim: String,
    pub roles: Vec<RoleTag>,
    pub is_place: bool,
    /// Slices where a total of this dimension did not pass, had no real value, or missed a member.
    pub unchecked_slices: Vec<Slice>,
    /// Per data-checked total, the slices where it passed; `varying` grants that total only there.
    pub checked_slices: BTreeMap<String, Vec<Slice>>,
    pub pick: Option<PickValue>,
    pub codes: Vec<CodeClass>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Flow {
    pub source_dim: String,
    pub target_dim: String,
    pub direction: FlowDirection,
    pub basis: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TableRoles {
    pub provider: String,
    pub dataset: String,
    pub unit: String,
    pub unit_additive: bool,
    pub dims: Vec<DimRole>,
    pub flow: Option<Flow>,
}

#[derive(Clone, Debug)]
pub struct EnergyFormula {
    pub id: String,
    pub lhs: String,
    pub rhs: Vec<(f64, String)>,
    pub source: String,
}

#[derive(Clone, Debug, Default)]
pub struct Refs {
    pub iso2: BTreeSet<String>,
    /// NUTS code -> (level, the newest GISCO version that has it).
    pub nuts: BTreeMap<String, (u8, String)>,
    /// World Bank country list id -> (iso2Code, region is "Aggregates").
    pub wb: BTreeMap<String, (String, bool)>,
    pub energy: Vec<EnergyFormula>,
    /// Tables whose metadata link is ext_go_agg_esms (dim-roles 2a).
    pub flow_tables: BTreeSet<String>,
}

/// Reads iso2.txt, nuts.tsv, wb-countries.tsv, nrg-bal-formulas.tsv and flow-tables.txt from one directory.
pub fn load_refs(dir: &Path) -> Result<Refs, String> {
    let read = |name: &str| {
        std::fs::read_to_string(dir.join(name))
            .map_err(|e| format!("{}: {e}", dir.join(name).display()))
    };
    let mut refs = Refs {
        iso2: read("iso2.txt")?
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        ..Default::default()
    };
    for line in read("nuts.tsv")?.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        let level = f
            .get(1)
            .and_then(|l| l.parse().ok())
            .ok_or(format!("nuts.tsv: {line}"))?;
        refs.nuts.insert(
            f[0].to_string(),
            (level, f.get(2).unwrap_or(&"").to_string()),
        );
    }
    for line in read("wb-countries.tsv")?.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() != 3 {
            return Err(format!("wb-countries.tsv: {line}"));
        }
        refs.wb
            .insert(f[0].to_string(), (f[1].to_string(), f[2] == "aggregate"));
    }
    for line in read("nrg-bal-formulas.tsv")?
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 3 {
            return Err(format!("nrg-bal-formulas.tsv: {line}"));
        }
        let rhs = f[2]
            .split_whitespace()
            .map(|t| {
                let (sign, code) = t.split_at(1);
                (if sign == "-" { -1.0 } else { 1.0 }, code.to_string())
            })
            .collect();
        refs.energy.push(EnergyFormula {
            id: f[0].to_string(),
            lhs: f[1].to_string(),
            rhs,
            source: f.get(3).unwrap_or(&"").to_string(),
        });
    }
    refs.flow_tables = read("flow-tables.txt")?
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    Ok(refs)
}

/// Whether amounts in this Eurostat unit add up (dim-roles 4, first match wins). None: cannot tell; the caller
/// treats it as not additive and logs the table, unit and name.
pub fn unit_additive(code: &str) -> Option<bool> {
    const BASE: [&str; 7] = ["NR", "PER", "T", "KTOE", "TJ", "GWH", "EUR"];
    let index = code.len() > 3
        && code.starts_with('I')
        && code[1..3].bytes().all(|b| b.is_ascii_digit())
        && &code[3..4] == "_";
    if code.starts_with("CLV") {
        return Some(false);
    }
    if ["PC", "P_", "RCH", "PCH", "RT"]
        .iter()
        .any(|p| code.starts_with(p))
        || index
    {
        return Some(false);
    }
    if BASE.contains(&code) {
        return Some(true);
    }
    for prefix in ["THS_", "MIO_", "BN_"] {
        if let Some(rest) = code.strip_prefix(prefix) {
            if BASE.contains(&rest) {
                return Some(true);
            }
        }
    }
    None
}

/// Cells of every period, keyed by codes and period; a zero cell is Some(0.0) with `zero` set.
struct Cells {
    value: BTreeMap<(Vec<String>, Option<String>), (f64, bool)>,
}

/// The self-check runs in every period and records each slice with its period (under "time" when the rows
/// carry one), so a total is granted only in the years it passed. Roles are still decided on
/// the latest period alone (design v4), so the counts below are the latest period's.
#[derive(Default)]
struct Check {
    pass: Vec<Slice>,
    fail: Vec<Slice>,
    empty: Vec<Slice>,
    incomplete: Vec<Slice>,
    with_zero: usize,
    worst: f64,
    /// Latest period: passed, failed, empty and incomplete slices.
    latest: [usize; 4],
    /// Earlier periods: passed slices and slices that did not pass.
    earlier_pass: usize,
    earlier_not: usize,
}

impl Check {
    /// Counts an empty (2) or incomplete (3) slice: in the latest period, or as an earlier one not passed.
    fn tally(&mut self, latest: bool, at: usize) {
        if latest {
            self.latest[at] += 1;
        } else {
            self.earlier_not += 1;
        }
    }

    fn confirmed(&self) -> bool {
        self.latest[0] > 0 && self.latest[0] > self.latest[1]
    }

    fn strict(&self) -> bool {
        self.latest[0] > 0 && self.latest[1] == 0
    }

    /// Every slice that was looked at and did not pass.
    fn not_passed(&self) -> impl Iterator<Item = &Slice> {
        self.fail.iter().chain(&self.empty).chain(&self.incomplete)
    }

    fn summary(&self) -> String {
        let earlier = if self.earlier_pass + self.earlier_not == 0 {
            String::new()
        } else {
            format!(
                "；更早各年 {} 格过、{} 格没过",
                self.earlier_pass, self.earlier_not
            )
        };
        format!(
            "加和自检：最新一年 {} 格过、{} 格不过、{} 格空、{} 格缺成员，含 m 的 {} 格，最大差 {:.2}%{earlier}",
            self.latest[0],
            self.latest[1],
            self.latest[2],
            self.latest[3],
            self.with_zero,
            self.worst * 100.0
        )
    }
}

fn diff_of(total: f64, sum: f64) -> f64 {
    if total == 0.0 {
        f64::INFINITY
    } else {
        ((total - sum) / total).abs()
    }
}

struct Table<'a> {
    input: &'a TableInput,
    cells: Cells,
    latest: Option<String>,
    /// Rows carry a period: slices carry it under "time", even with one period only.
    timed: bool,
    /// Indexes of dimensions with two codes or more (they name a slice).
    varying: Vec<usize>,
}

impl<'a> Table<'a> {
    fn new(input: &'a TableInput) -> Self {
        let latest = input.rows.iter().filter_map(|r| r.1.clone()).max();
        let timed = input.rows.iter().any(|r| r.1.is_some());
        let mut value = BTreeMap::new();
        for (codes, time, v) in &input.rows {
            value.insert((codes.clone(), time.clone()), (*v, false));
        }
        for (codes, time) in &input.zero_cells {
            value
                .entry((codes.clone(), time.clone()))
                .or_insert((0.0, true));
        }
        let varying = (0..input.dims.len())
            .filter(|&i| input.dims[i].codes.len() >= 2)
            .collect();
        Table {
            input,
            cells: Cells { value },
            latest,
            timed,
            varying,
        }
    }

    /// Checks `lhs = sum(sign * part)` along dimension `d` in every slice of the other dimensions.
    fn check(&self, d: usize, lhs: &str, parts: &[(f64, String)]) -> Check {
        type Group<'g> = BTreeMap<&'g str, (f64, bool)>;
        let mut groups: BTreeMap<(Vec<String>, &Option<String>), Group> = BTreeMap::new();
        for ((codes, time), cell) in &self.cells.value {
            let mut rest = codes.clone();
            let code = rest.remove(d);
            if code == lhs || parts.iter().any(|(_, p)| *p == code) {
                let code = self.input.dims[d]
                    .codes
                    .iter()
                    .find(|c| **c == code)
                    .map(String::as_str)
                    .unwrap_or("");
                groups.entry((rest, time)).or_default().insert(code, *cell);
            }
        }
        let mut out = Check::default();
        for ((rest, time), group) in groups {
            let Some(&(total, z0)) = group.get(lhs) else {
                continue;
            };
            let latest = *time == self.latest;
            let slice = self.slice(d, &rest, time);
            let mut sum = 0.0;
            let mut zero = z0;
            let mut complete = true;
            for (sign, part) in parts {
                match group.get(part.as_str()) {
                    Some(&(v, z)) => {
                        sum += sign * v;
                        zero |= z;
                    }
                    None => complete = false,
                }
            }
            if !complete {
                out.tally(latest, 3);
                out.incomplete.push(slice);
                continue;
            }
            // Empty: neither side holds a real non-zero value, or every part is a "data cannot exist" cell
            // (the *_EED rows of nrg_bal_s: only TOTAL has a value; design 3a).
            let nonzero = (total != 0.0 && !z0)
                || parts
                    .iter()
                    .any(|(_, p)| group.get(p.as_str()).is_some_and(|c| c.0 != 0.0));
            let only_zero_cells = parts
                .iter()
                .all(|(_, p)| group.get(p.as_str()).is_some_and(|c| c.1));
            if !nonzero || only_zero_cells {
                out.tally(latest, 2);
                out.empty.push(slice);
                continue;
            }
            if !latest {
                if diff_of(total, sum) <= TOLERANCE {
                    out.earlier_pass += 1;
                    out.pass.push(slice);
                } else {
                    out.earlier_not += 1;
                    out.fail.push(slice);
                }
                continue;
            }
            if zero {
                out.with_zero += 1;
            }
            let diff = diff_of(total, sum);
            out.worst = out.worst.max(if diff.is_finite() { diff } else { 1.0 });
            if diff <= TOLERANCE {
                out.latest[0] += 1;
                out.pass.push(slice);
            } else {
                out.latest[1] += 1;
                out.fail.push(slice);
            }
        }
        out
    }

    /// The other varying dimensions' codes of one group (`rest` has dimension `d` removed), and its period.
    fn slice(&self, d: usize, rest: &[String], time: &Option<String>) -> Slice {
        let mut s = Slice::new();
        if let (true, Some(t)) = (self.timed, time) {
            s.insert("time".into(), t.clone());
        }
        for &i in &self.varying {
            if i != d {
                let at = if i < d { i } else { i - 1 };
                s.insert(self.input.dims[i].id.clone(), rest[at].clone());
            }
        }
        s
    }
}

enum Place {
    Member { level: Option<u8>, basis: String },
    Total(String),
    Duplicate,
}

fn place_code(provider: &str, code: &str, refs: &Refs) -> Option<Place> {
    if provider == "worldbank" {
        return refs.wb.get(code).map(|(_, aggregate)| {
            if *aggregate {
                Place::Total("世行国家清单 region=Aggregates（官方合计名单）".into())
            } else {
                Place::Member {
                    level: None,
                    basis: "世行国家清单（不在 Aggregates 名单）".into(),
                }
            }
        });
    }
    if AGG_PREFIX.iter().any(|p| code.starts_with(p)) && !refs.iso2.contains(code) {
        return Some(Place::Total(
            "欧盟统计局官方合计（EU／EA／EEA／EFTA 开头），不做加和".into(),
        ));
    }
    if code == "DE_TOT" {
        return Some(Place::Duplicate);
    }
    let nuts = refs.nuts.get(code);
    if refs.iso2.contains(code) {
        return Some(Place::Member {
            level: nuts.map(|n| n.0),
            basis: "ISO 3166-1 alpha-2".into(),
        });
    }
    if let Some((_, iso)) = ISO_ALIAS.iter().find(|(a, _)| *a == code) {
        if refs.iso2.contains(*iso) {
            return Some(Place::Member {
                level: nuts.map(|n| n.0),
                basis: format!("ISO 3166-1 alpha-2（Eurostat 例外码 {code}→{iso}）"),
            });
        }
    }
    nuts.map(|(level, version)| Place::Member {
        level: Some(*level),
        basis: format!("GISCO NUTS {version} 第 {level} 层"),
    })
}

fn class(code: &str, class: Class, basis: impl Into<String>) -> CodeClass {
    CodeClass {
        code: code.to_string(),
        class,
        basis: basis.into(),
        level: None,
    }
}

/// Age code as a half-open interval of years.
fn age_span(code: &str) -> Option<(u32, u32)> {
    const OPEN: u32 = u32::MAX;
    if code == "TOTAL" {
        return Some((0, OPEN));
    }
    if let Some(n) = code.strip_prefix("Y_LT") {
        return n.parse().ok().map(|n| (0, n));
    }
    if let Some(n) = code.strip_prefix("Y_GE") {
        return n.parse().ok().map(|n| (n, OPEN));
    }
    let body = code.strip_prefix('Y')?;
    match body.split_once('-') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse::<u32>().ok()? + 1)),
        None => body.parse::<u32>().ok().map(|n| (n, n + 1)),
    }
}

/// The non-overlapping group of codes that tiles [0, open): most codes wins, then the group whose codes come
/// first in codelist order (design 3, R must 4).
fn age_cover(spans: &[(usize, (u32, u32))]) -> Option<Vec<usize>> {
    fn best(
        at: u32,
        spans: &[(usize, (u32, u32))],
        memo: &mut BTreeMap<u32, Option<Vec<usize>>>,
    ) -> Option<Vec<usize>> {
        if at == u32::MAX {
            return Some(Vec::new());
        }
        if let Some(hit) = memo.get(&at) {
            return hit.clone();
        }
        let mut found: Option<Vec<usize>> = None;
        for &(i, (a, b)) in spans {
            if a != at || (a == 0 && b == u32::MAX) {
                continue;
            }
            if let Some(mut tail) = best(b, spans, memo) {
                tail.push(i);
                tail.sort_unstable();
                let better = match &found {
                    None => true,
                    Some(f) => tail.len() > f.len() || (tail.len() == f.len() && tail < *f),
                };
                if better {
                    found = Some(tail);
                }
            }
        }
        memo.insert(at, found.clone());
        found
    }
    best(0, spans, &mut BTreeMap::new())
}

/// Interval code such as C0350-0370 or I551-I553: the codes it spans among `codes`. A trailing zero on the upper
/// end stands for its whole group (SIEC C0350-0370 holds C0371 and C0379); inferred from the SIEC labels.
fn interval_cover<'c>(code: &str, codes: &'c [String]) -> Vec<&'c String> {
    let split = |c: &str| {
        let p = c.find(|ch: char| ch.is_ascii_digit())?;
        let (letters, digits) = c.split_at(p);
        digits
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| (letters.to_string(), digits.to_string()))
    };
    let Some((a, b)) = code.split_once('-') else {
        return Vec::new();
    };
    let Some((la, da)) = split(a) else {
        return Vec::new();
    };
    let (lb, db) = match split(b) {
        Some((l, d)) if l.is_empty() => (la.clone(), d),
        Some(x) => x,
        None => return Vec::new(),
    };
    if la != lb || da.len() != db.len() {
        return Vec::new();
    }
    codes
        .iter()
        .filter(|c| c.as_str() != code)
        .filter(|c| {
            split(c).is_some_and(|(l, d)| {
                l == la
                    && d.len() == da.len()
                    && d >= da
                    && (d <= db || d.starts_with(db.trim_end_matches('0')))
            })
        })
        .collect()
}

/// Code classes, unchecked slices, passed slices per checked total, and the first checked total.
type DimVerdict = (
    Vec<CodeClass>,
    Vec<Slice>,
    BTreeMap<String, Vec<Slice>>,
    Option<String>,
);

/// Classes and roles of one category-like dimension; `place` holds the place verdict per code when the
/// dimension is a place.
fn category_dim(
    t: &Table,
    d: usize,
    additive: bool,
    place: Option<&BTreeMap<String, CodeClass>>,
    refs: &Refs,
) -> DimVerdict {
    let dim = &t.input.dims[d];
    let id = dim.id.to_ascii_lowercase();
    let codes = &dim.codes;
    let mut out: BTreeMap<String, CodeClass> = BTreeMap::new();
    let mut unchecked = Vec::new();
    let mut checked: BTreeMap<String, Vec<Slice>> = BTreeMap::new();
    let mut checked_total: Option<String> = None;

    // Energy balance rows: the official formula table decides as soon as this dimension uses any of its codes;
    // only formulas whose codes are all present can be checked, every other code is unknown.
    if id == "nrg_bal" {
        let present: BTreeSet<&str> = codes.iter().map(String::as_str).collect();
        let in_table = refs.energy.iter().any(|f| {
            present.contains(f.lhs.as_str())
                || f.rhs.iter().any(|(_, c)| present.contains(c.as_str()))
        });
        let usable: Vec<&EnergyFormula> = refs
            .energy
            .iter()
            .filter(|f| {
                present.contains(f.lhs.as_str())
                    && f.rhs.iter().all(|(_, c)| present.contains(c.as_str()))
            })
            .collect();
        if in_table {
            let mut covered: BTreeMap<String, String> = BTreeMap::new();
            let mut failed: Vec<String> = Vec::new();
            for f in usable {
                let check = t.check(d, &f.lhs, &f.rhs);
                if check.strict() {
                    for c in std::iter::once(&f.lhs).chain(f.rhs.iter().map(|(_, c)| c)) {
                        covered.entry(c.clone()).or_insert(format!(
                            "能源公式 {}（{}）：{}",
                            f.id,
                            f.source,
                            check.summary()
                        ));
                    }
                } else {
                    failed.push(format!("能源公式 {} 没过：{}", f.id, check.summary()));
                }
            }
            for c in codes {
                let cc = match covered.get(c) {
                    Some(b) => class(c, Class::Member, b.clone()),
                    None if failed.is_empty() => class(c, Class::Unknown, "能源公式表里没有这个码"),
                    None => class(
                        c,
                        Class::Unknown,
                        format!("能源公式表里没有、或公式没过（{}）", failed.join("；")),
                    ),
                };
                out.insert(c.clone(), cc);
            }
            return (
                codes.iter().map(|c| out.remove(c).unwrap()).collect(),
                unchecked,
                checked,
                None,
            );
        }
    }

    let mut leaves: Vec<String> = Vec::new();
    let mut named: Vec<String> = Vec::new();
    let mut fixed_total: Option<String> = None;
    let name_total = format!("{}_TOT", dim.id.to_ascii_uppercase());

    if id == "sex" {
        for c in codes {
            let cc = match c.as_str() {
                "T" => {
                    fixed_total = Some(c.clone());
                    class(c, Class::Total, "欧盟统计局 SEX 码表：T＝合计")
                }
                "F" | "M" => class(c, Class::Member, "欧盟统计局 SEX 码表"),
                "UNK" => class(c, Class::Special, "欧盟统计局 SEX 码表：UNK＝未知"),
                _ => class(c, Class::Unknown, "性别码在固定词表外，停下报"),
            };
            if cc.class == Class::Member {
                leaves.push(c.clone());
            }
            out.insert(c.clone(), cc);
        }
    } else if id == "age" {
        let spans: Vec<(usize, (u32, u32))> = codes
            .iter()
            .enumerate()
            .filter(|(_, c)| !matches!(c.as_str(), "UNK" | "Y_OPEN"))
            .filter_map(|(i, c)| age_span(c).map(|s| (i, s)))
            .collect();
        let cover: BTreeSet<usize> = age_cover(&spans).unwrap_or_default().into_iter().collect();
        for (i, c) in codes.iter().enumerate() {
            let cc = if c == "TOTAL" {
                fixed_total = Some(c.clone());
                class(c, Class::Total, "年龄 TOTAL＝合计")
            } else if c == "UNK" || c == "Y_OPEN" {
                class(c, Class::Special, "年龄 UNK／Y_OPEN＝特殊")
            } else if cover.contains(&i) {
                leaves.push(c.clone());
                class(
                    c,
                    Class::Member,
                    format!("年龄区间：拼满 TOTAL 的一组（{} 个码）", cover.len()),
                )
            } else if age_span(c).is_some() {
                class(c, Class::Subtotal, "年龄区间：和成员重叠")
            } else {
                class(c, Class::Unknown, "年龄码解析不了")
            };
            out.insert(c.clone(), cc);
        }
    } else {
        for c in codes {
            if let Some(p) = place.and_then(|p| p.get(c)) {
                if p.class == Class::Member {
                    leaves.push(c.clone());
                }
                out.insert(c.clone(), p.clone());
                continue;
            }
            if SPECIAL.contains(&c.as_str()) {
                out.insert(c.clone(), class(c, Class::Special, "UNK／NRP／STLS＝特殊"));
            } else if c == "EXT_EU27_2020" {
                out.insert(c.clone(), class(c, Class::Subtotal, "EXT_EU27_2020＝小计"));
            } else if *c == "TOTAL" || *c == name_total {
                named.push(c.clone());
            } else {
                let inside = interval_cover(c, codes);
                let under: Vec<&String> = codes
                    .iter()
                    .filter(|o| {
                        *o != c
                            && o.starts_with(c.as_str())
                            && o[c.len()..].starts_with(|ch: char| ch.is_ascii_alphanumeric())
                            && !o.contains('-')
                    })
                    .collect();
                let covers: Vec<&String> = if inside.is_empty() { under } else { inside };
                if covers.is_empty() {
                    leaves.push(c.clone());
                } else if !additive {
                    out.insert(
                        c.clone(),
                        class(c, Class::Unknown, "小计候选，单位不可加，不做自检"),
                    );
                } else {
                    let parts: Vec<(f64, String)> =
                        covers.iter().map(|o| (1.0, (*o).clone())).collect();
                    let check = t.check(d, c, &parts);
                    let cc = if check.confirmed() {
                        class(
                            c,
                            Class::Subtotal,
                            format!("等于所含 {} 个码之和；{}", parts.len(), check.summary()),
                        )
                    } else {
                        class(
                            c,
                            Class::Unknown,
                            format!(
                                "小计候选不等于所含 {} 个码之和；{}",
                                parts.len(),
                                check.summary()
                            ),
                        )
                    };
                    out.insert(c.clone(), cc);
                }
            }
        }
        // Leaves of a place dimension are its places; the rest of what is left is not a member.
        if place.is_some() {
            for c in std::mem::take(&mut leaves) {
                if out.contains_key(&c) {
                    leaves.push(c);
                } else {
                    out.insert(
                        c.clone(),
                        class(&c, Class::Special, "不是 ISO 3166-1／NUTS 地点码"),
                    );
                }
            }
        }
    }

    // Totals: a fixed vocabulary total or a name candidate is tried first, then every other code; each is
    // believed only where the data adds up.
    let mut tried: Vec<String> = fixed_total
        .iter()
        .cloned()
        .chain(named.iter().cloned())
        .collect();
    if place.is_none() && id != "sex" && id != "age" {
        let more: Vec<String> = leaves
            .iter()
            .filter(|c| !tried.contains(c))
            .cloned()
            .collect();
        tried.extend(more);
    }
    let mut confirmed: BTreeSet<String> = BTreeSet::new();
    for x in tried {
        let is_name = fixed_total.as_ref() == Some(&x) || named.contains(&x);
        if !additive {
            if is_name {
                out.insert(
                    x.clone(),
                    class(
                        &x,
                        Class::TotalUnchecked,
                        "单位不可加：按码认出的合计记「合计（未核）」",
                    ),
                );
            }
            continue;
        }
        let rest: Vec<(f64, String)> = leaves
            .iter()
            .filter(|c| **c != x && !confirmed.contains(*c) && !named.contains(c))
            .map(|c| (1.0, c.clone()))
            .collect();
        let split: Vec<(f64, String)> = x
            .split('_')
            .filter(|s| codes.iter().any(|c| c == s))
            .map(|s| (1.0, s.to_string()))
            .collect();
        let mut tries: Vec<(String, Vec<(f64, String)>)> = Vec::new();
        if rest.len() >= 2 {
            tries.push((format!("等于 {} 个成员码之和", rest.len()), rest));
        }
        if split.len() >= 2 && split.len() == x.split('_').count() {
            tries.push(("等于码名按 _ 拆开各段之和".to_string(), split));
        }
        let mut done = false;
        let mut last = String::new();
        for (how, parts) in tries {
            let check = t.check(d, &x, &parts);
            if check.confirmed() {
                out.insert(
                    x.clone(),
                    class(&x, Class::Total, format!("{how}；{}", check.summary())),
                );
                leaves.retain(|c| *c != x);
                unchecked.extend(check.not_passed().cloned());
                checked.insert(x.clone(), check.pass.clone());
                confirmed.insert(x.clone());
                checked_total.get_or_insert(x.clone());
                done = true;
                break;
            }
            last = format!("{how}没过；{}", check.summary());
        }
        if !done && is_name {
            let why = if last.is_empty() {
                "成员码不到 2 个，自检做不了".to_string()
            } else {
                last
            };
            out.insert(x.clone(), class(&x, Class::TotalUnchecked, why));
        }
    }
    for c in &leaves {
        out.entry(c.clone())
            .or_insert_with(|| class(c, Class::Member, "成员候选"));
    }
    unchecked.sort();
    unchecked.dedup();
    (
        codes
            .iter()
            .map(|c| {
                out.remove(c)
                    .unwrap_or_else(|| class(c, Class::Unknown, "没分到类"))
            })
            .collect(),
        unchecked,
        checked,
        checked_total,
    )
}

fn tag(role: Role, basis: impl Into<String>) -> RoleTag {
    RoleTag {
        role,
        basis: basis.into(),
    }
}

fn pick_value(dim: &DimInput, codes: &[CodeClass], ask: &Ask) -> PickValue {
    if let Some(c) = ask.given.get(&dim.id).filter(|c| dim.codes.contains(c)) {
        return PickValue {
            code: c.clone(),
            basis: format!("{}：已指定 {c}", dim.id),
        };
    }
    if let Some(c) = codes.iter().find(|c| c.class == Class::Total) {
        return PickValue {
            code: c.code.clone(),
            basis: format!("{}：取合计 {}", dim.id, c.code),
        };
    }
    if let Some(c) = codes.iter().find(|c| c.class == Class::Member) {
        return PickValue {
            code: c.code.clone(),
            basis: format!("{}：码表顺序第一个成员 {}", dim.id, c.code),
        };
    }
    let c = dim.codes.first().cloned().unwrap_or_default();
    PickValue {
        basis: format!("{}：没有成员，取码表顺序第一个码 {c}", dim.id),
        code: c,
    }
}

pub fn classify(t: &TableInput, refs: &Refs, ask: &Ask) -> TableRoles {
    let table = Table::new(t);
    let unit_dim = t
        .dims
        .iter()
        .position(|d| d.id.eq_ignore_ascii_case("unit"));
    let unit = unit_dim
        .map(|i| pick_value(&t.dims[i], &[], ask).code)
        .unwrap_or_default();
    let additive = t.provider == "eurostat" && unit_additive(&unit).unwrap_or(false);
    let mut dims: Vec<DimRole> = Vec::new();

    for (d, dim) in t.dims.iter().enumerate() {
        let id = dim.id.to_ascii_lowercase();
        let mut roles: Vec<RoleTag> = Vec::new();
        let mut role = DimRole {
            dim: dim.id.clone(),
            roles: Vec::new(),
            is_place: false,
            unchecked_slices: Vec::new(),
            checked_slices: BTreeMap::new(),
            pick: None,
            codes: Vec::new(),
        };
        if Some(d) == unit_dim {
            roles.push(tag(Role::Unit, "维名 unit（SDMX 结构）"));
            if dim.codes.len() >= 2 {
                roles.push(tag(Role::Pick, "单位不并列加和，取一个"));
            }
        } else if id == "freq" {
            roles.push(tag(Role::Pick, "freq：取一个值"));
            role.codes = dim
                .codes
                .iter()
                .map(|c| class(c, Class::Member, "freq"))
                .collect();
        } else {
            let by_name = matches!(id.as_str(), "geo" | "country");
            let found: BTreeMap<String, Place> = dim
                .codes
                .iter()
                .filter_map(|c| place_code(&t.provider, c, refs).map(|p| (c.clone(), p)))
                .collect();
            let members = found
                .values()
                .filter(|p| matches!(p, Place::Member { .. }))
                .count();
            let share = members as f64 / dim.codes.len().max(1) as f64;
            role.is_place = by_name || (dim.codes.len() >= 2 && share >= PLACE_SHARE);
            let mut place: Option<BTreeMap<String, CodeClass>> = None;
            if role.is_place {
                roles.push(tag(
                    Role::Place,
                    if by_name {
                        format!("维名 {}", dim.id)
                    } else {
                        format!(
                            "{:.0}% 的码是地点成员（≥{:.0}%）",
                            share * 100.0,
                            PLACE_SHARE * 100.0
                        )
                    },
                ));
                let country = |l: Option<u8>| l.unwrap_or(0);
                let mut by_level: BTreeMap<u8, usize> = BTreeMap::new();
                for p in found.values() {
                    if let Place::Member { level, .. } = p {
                        *by_level.entry(country(*level)).or_default() += 1;
                    }
                }
                let take = if ask.fine_place {
                    by_level.keys().next_back().copied()
                } else {
                    by_level.keys().next().copied()
                }
                .unwrap_or(0);
                let mut map = BTreeMap::new();
                for (c, p) in found {
                    let cc = match p {
                        Place::Member { level, basis } if country(level) == take => CodeClass {
                            code: c.clone(),
                            class: Class::Member,
                            basis,
                            level,
                        },
                        Place::Member { level, .. } => CodeClass {
                            code: c.clone(),
                            class: Class::Subtotal,
                            basis: format!("NUTS 第 {} 层，本次取第 {take} 层", country(level)),
                            level,
                        },
                        Place::Total(b) => class(&c, Class::Total, b),
                        Place::Duplicate => {
                            class(&c, Class::Duplicate, "DE_TOT 含前东德，和 DE 重复")
                        }
                    };
                    map.insert(c, cc);
                }
                place = Some(map);
            }
            let (codes, unchecked, checked, total) =
                category_dim(&table, d, additive, place.as_ref(), refs);
            let n_members = codes.iter().filter(|c| c.class == Class::Member).count();
            if additive && n_members >= 2 {
                if let Some(x) = &total {
                    roles.push(tag(
                        Role::AdditiveCategory,
                        format!("单位 {unit} 可加，合计 {x} 过了加和自检"),
                    ));
                }
            }
            if n_members >= 2 {
                roles.push(tag(Role::Category, format!("{n_members} 个成员码")));
            } else if codes.iter().all(|c| c.class == Class::Unknown) && dim.codes.len() >= 2 {
                roles.push(tag(
                    Role::Unknown,
                    codes.first().map(|c| c.basis.clone()).unwrap_or_default(),
                ));
            } else {
                roles.push(tag(
                    Role::Pick,
                    format!("成员码不到 2 个（{n_members} 个）"),
                ));
            }
            role.codes = codes;
            role.unchecked_slices = unchecked;
            role.checked_slices = checked;
        }
        role.roles = roles;
        dims.push(role);
    }
    if t.rows.iter().any(|r| r.1.is_some()) {
        dims.push(DimRole {
            dim: "time".into(),
            roles: vec![tag(Role::Time, "行上的时间（SDMX TIME_PERIOD／世行 date）")],
            is_place: false,
            unchecked_slices: Vec::new(),
            checked_slices: BTreeMap::new(),
            pick: None,
            codes: Vec::new(),
        });
    }

    let flow = flow(t, &mut dims, refs, ask);
    for (d, role) in dims.iter_mut().enumerate() {
        role.roles
            .sort_by_key(|r| ROLE_ORDER.iter().position(|o| *o == r.role));
        if role
            .roles
            .iter()
            .any(|r| matches!(r.role, Role::Pick | Role::Unknown))
        {
            if let Some(dim) = t.dims.get(d) {
                role.pick = Some(pick_value(dim, &role.codes, ask));
            }
        }
    }
    TableRoles {
        provider: t.provider.clone(),
        dataset: t.dataset.clone(),
        unit,
        unit_additive: additive,
        dims,
        flow,
    }
}

/// dim-roles 2a: only directions the official metadata states become flow roles.
fn flow(t: &TableInput, dims: &mut [DimRole], refs: &Refs, ask: &Ask) -> Option<Flow> {
    let at = |name: &str| t.dims.iter().position(|d| d.id.eq_ignore_ascii_case(name));
    let add = |dims: &mut [DimRole], src: usize, dst: usize, basis: &str| {
        dims[src].roles.push(tag(Role::FlowSource, basis));
        dims[dst].roles.push(tag(Role::FlowTarget, basis));
    };
    if let (Some(siec), Some(bal)) = (at("siec"), at("nrg_bal")) {
        let codes = &t.dims[bal].codes;
        let supply = codes.iter().any(|c| c == "PPRD" || c == "IMP");
        let final_use = codes.iter().any(|c| c.starts_with("FC_"));
        if supply && final_use {
            let basis =
                "方向表第 3 行：能源平衡指南第 19 页三段（供应→转换→最终消费），燃料→部门是推断";
            add(dims, siec, bal, basis);
            return Some(Flow {
                source_dim: t.dims[siec].id.clone(),
                target_dim: t.dims[bal].id.clone(),
                direction: FlowDirection::Official,
                basis: basis.into(),
            });
        }
    }
    if let (Some(partner), Some(geo)) = (at("partner"), at("geo")) {
        if refs.flow_tables.contains(&t.dataset) {
            let flow_code = at("stk_flow").and_then(|i| {
                let d = &t.dims[i];
                ask.given
                    .get(&d.id)
                    .cloned()
                    .or_else(|| (d.codes.len() == 1).then(|| d.codes[0].clone()))
            });
            let basis = "方向表第 1、2 行：ext_go_agg_esms「Partner country – … country of destination for … exports, the country of origin for extra-EU imports …」";
            let (src, dst) = match flow_code.as_deref() {
                Some("IMP") => (partner, geo),
                Some("EXP") => (geo, partner),
                _ => {
                    return Some(Flow {
                        source_dim: t.dims[partner].id.clone(),
                        target_dim: t.dims[geo].id.clone(),
                        direction: FlowDirection::Unknown,
                        basis: "进出口没定成一个（stk_flow 不止一个值），方向未知".into(),
                    })
                }
            };
            add(dims, src, dst, basis);
            return Some(Flow {
                source_dim: t.dims[src].id.clone(),
                target_dim: t.dims[dst].id.clone(),
                direction: FlowDirection::Official,
                basis: basis.into(),
            });
        }
    }
    let pairs: Vec<usize> = (0..t.dims.len())
        .filter(|&i| {
            dims[i].is_place
                && !matches!(
                    t.dims[i].id.to_ascii_lowercase().as_str(),
                    "citizen" | "c_birth"
                )
        })
        .collect();
    if pairs.len() >= 2 {
        return Some(Flow {
            source_dim: t.dims[pairs[0]].id.clone(),
            target_dim: t.dims[pairs[1]].id.clone(),
            direction: FlowDirection::Unknown,
            basis: "成对地点维，方向表里没有，方向未知".into(),
        });
    }
    None
}

/// An unchecked entry hits the slice; a period the call does not fix counts as any period.
fn hit(entry: &Slice, slice: &Slice) -> bool {
    entry
        .iter()
        .all(|(k, v)| slice.get(k).map_or(k == "time", |f| f == v))
}

/// True when `passed` holds every slice the call asks about: the fixed codes of `slice` and each combination
/// of the codes present in the other varying dimensions. A dimension of the entries that the call neither
/// fixes nor varies leaves the slice unknown, so it is not covered.
fn covered(passed: &[Slice], slice: &Slice, dim: &str, varying: &[(&str, &[String])]) -> bool {
    let Some(first) = passed.first() else {
        return false;
    };
    let mut need = 1usize;
    for key in first.keys() {
        if slice.contains_key(key) {
            continue;
        }
        match varying
            .iter()
            .find(|(n, _)| *n == key.as_str() && *n != dim)
        {
            Some((_, codes)) => {
                let codes: BTreeSet<&String> = codes.iter().collect();
                need = need.saturating_mul(codes.len());
            }
            None => return false,
        }
    }
    let matching = passed
        .iter()
        .filter(|e| {
            e.iter().all(|(k, v)| match slice.get(k) {
                Some(f) => f == v,
                None => varying
                    .iter()
                    .any(|(n, codes)| *n == k.as_str() && codes.contains(v)),
            })
        })
        .count();
    need > 0 && matching == need
}

/// The matcher's view of one slice. `slice` holds the fixed codes of the dimensions that do not vary;
/// `varying` names each varying dimension with the codes present in the slice's data. When the rows carry
/// periods the call must name the period, fixed under "time" in `slice` or listed as ("time", years)
/// in `varying`; otherwise no data-checked total is granted.
pub fn varying(roles: &TableRoles, slice: &Slice, varying: &[(&str, &[String])]) -> Shape {
    let mut dims = Vec::new();
    for (name, present) in varying {
        let Some(role) = roles.dims.iter().find(|d| d.dim == *name) else {
            continue;
        };
        let class_of = |c: &String| role.codes.iter().find(|x| x.code == *c);
        let total = present
            .iter()
            .filter_map(class_of)
            .find(|c| c.class == Class::Total);
        // A total the data check confirmed holds only where it passed, in every combination of the other
        // varying dimensions; a total named by an official list keeps its class everywhere.
        // Without the total among the codes, the members still add up only where some checked total passed.
        let unchecked = match total.and_then(|c| role.checked_slices.get(&c.code)) {
            Some(passed) => !covered(passed, slice, name, varying),
            None if total.is_none() && !role.checked_slices.is_empty() => !role
                .checked_slices
                .values()
                .any(|passed| covered(passed, slice, name, varying)),
            None => role.unchecked_slices.iter().any(|e| hit(e, slice)),
        };
        let members: Vec<&CodeClass> = present
            .iter()
            .filter_map(class_of)
            .filter(|c| c.class == Class::Member)
            .collect();
        let total_member = if unchecked {
            None
        } else {
            total.map(|c| c.code.clone())
        };
        let iso_countries = role.is_place
            && !members.is_empty()
            && members.iter().all(|c| {
                c.basis.starts_with("ISO 3166-1") || c.basis.starts_with("世行国家清单（不在")
            });
        let roles_here: Vec<Role> = role
            .roles
            .iter()
            .map(|r| r.role)
            .filter(|r| !(unchecked && *r == Role::AdditiveCategory))
            .collect();
        dims.push(VaryingDim {
            dim: role.dim.clone(),
            members: if role.codes.is_empty() {
                present.len()
            } else {
                members.len()
            },
            roles: roles_here,
            is_place: role.is_place,
            iso_countries,
            total_member,
        });
    }
    let official_flow = roles
        .flow
        .as_ref()
        .filter(|f| f.direction == FlowDirection::Official)
        .and_then(|f| {
            let both = varying.iter().any(|(n, _)| *n == f.source_dim)
                && varying.iter().any(|(n, _)| *n == f.target_dim);
            both.then(|| (f.source_dim.clone(), f.target_dim.clone()))
        });
    Shape {
        dims,
        unit_additive: roles.unit_additive,
        official_flow,
    }
}

/// Most codes a partition search tries (design 1028 §2: exhaustive below this; over it, no partition).
pub const PARTITION_MAX_CODES: usize = 24;
/// Parts drawn by name; the rest of a finer partition is drawn as one "other" part (stacked_bar_100 holds 5 segments).
pub const PARTITION_SHOWN: usize = 4;
/// Fewest rows a partition must add up in: one row lets chance sums pass within TOLERANCE.
pub const PARTITION_MIN_ROWS: usize = 2;
/// Share of the rows holding the total that must hold every part of a partition (the summed year's 0.8); the rest are left out and listed.
pub const PARTITION_ROW_SHARE: f64 = 0.8;
/// Largest share of the whole total the "other" part may hold (design 1028 §2; one parameter).
pub const OTHER_MAX: f64 = 0.15;
/// Largest share of any one bar's total the "other" part may hold (design 1028 §2, f0 bus63; one parameter).
pub const OTHER_BAR_MAX: f64 = 0.30;

/// A split of one dimension into codes that add up to its total code in every complete row, found from the data alone.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Partition {
    pub dim: String,
    pub total: String,
    /// Every code of the partition, in the file's order.
    pub parts: Vec<String>,
    /// The parts drawn by name, largest share of the whole first.
    pub shown: Vec<String>,
    /// The parts drawn together as "other" (empty when the partition has no more parts than a chart holds).
    pub other: Vec<String>,
    /// "other"'s share of the whole, and the largest share it holds in one bar.
    pub other_share: f64,
    pub other_bar_max: f64,
    /// Rows left out because the total or a part is missing there (missing is not 0): the codes of the other varying
    /// dimensions, then the period.
    pub incomplete: Vec<Vec<String>>,
    /// Partitions the data proves; the one kept is the finest under both "other" caps.
    pub found: usize,
}

/// The finest split of `dim` into codes that sum to `total` (within TOLERANCE) in every row holding the total and each
/// part (at least PARTITION_MIN_ROWS rows and PARTITION_ROW_SHARE of the rows holding the total), whose "other" stays under OTHER_MAX of the whole and OTHER_BAR_MAX of every bar. Ties: the smaller "other", then
/// the file's code order. Err names why there is none; the caller keeps the total alone.
/// One row of a partition's chart: the other dimensions' codes and the period.
type GroupKey = (Vec<String>, Option<String>);

pub fn partition(t: &TableInput, dim: &str, total: &str) -> Result<Partition, String> {
    let at = t
        .dims
        .iter()
        .position(|d| d.id == dim)
        .ok_or(format!("the table has no {dim} dimension"))?;
    // One group per row of the chart: the other dimensions' codes and the period; in it, each code's value.
    let mut groups: BTreeMap<GroupKey, BTreeMap<&str, f64>> = BTreeMap::new();
    for (codes, period, value) in &t.rows {
        let mut key = codes.clone();
        let code = key.remove(at);
        let group = groups.entry((key, period.clone())).or_default();
        let known = t.dims[at].codes.iter().find(|c| **c == code);
        if let Some(c) = known {
            group.insert(c.as_str(), *value);
        }
    }
    let codes: Vec<&str> = t.dims[at]
        .codes
        .iter()
        .map(String::as_str)
        .filter(|c| *c != total && groups.values().any(|g| g.get(c).is_some_and(|v| *v != 0.0)))
        .collect();
    if codes.len() > PARTITION_MAX_CODES {
        return Err(format!(
            "{dim} holds {} non-zero codes besides {total}, over the {PARTITION_MAX_CODES} a search tries",
            codes.len()
        ));
    }
    let rows: Vec<(&GroupKey, f64, Vec<Option<f64>>)> = groups
        .iter()
        .filter_map(|(key, g)| {
            let whole = *g.get(total)?;
            Some((
                key,
                whole,
                codes.iter().map(|c| g.get(c).copied()).collect::<Vec<_>>(),
            ))
        })
        .filter(|(_, whole, parts)| {
            *whole != 0.0 || parts.iter().any(|p| p.is_some_and(|v| v != 0.0))
        })
        .collect();
    // The search runs on one row holding the total and every code, then each candidate is checked on all rows.
    let (_, probe_total, probe) = rows
        .iter()
        .filter(|(_, _, parts)| parts.iter().all(Option::is_some))
        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
        .ok_or(format!("no row holds {total} and every other {dim} code"))?;
    let probe: Vec<f64> = probe.iter().map(|p| p.unwrap_or(0.0)).collect();
    let prune = probe.iter().all(|v| *v >= 0.0) && *probe_total > 0.0;
    let mut candidates: Vec<Vec<usize>> = Vec::new();
    fn search(
        i: usize,
        sum: f64,
        picked: &mut Vec<usize>,
        probe: &[f64],
        whole: f64,
        prune: bool,
        out: &mut Vec<Vec<usize>>,
    ) {
        if prune && sum > whole * (1.0 + TOLERANCE) {
            return;
        }
        if i == probe.len() {
            if picked.len() >= 2 && diff_of(whole, sum) <= TOLERANCE {
                out.push(picked.clone());
            }
            return;
        }
        picked.push(i);
        search(i + 1, sum + probe[i], picked, probe, whole, prune, out);
        picked.pop();
        search(i + 1, sum, picked, probe, whole, prune, out);
    }
    search(
        0,
        0.0,
        &mut Vec::new(),
        &probe,
        *probe_total,
        prune,
        &mut candidates,
    );
    let (mut found, mut thin) = (0, 0);
    let mut best: Option<Partition> = None;
    for picked in candidates {
        // Missing is not 0: a row missing the total or a part proves nothing and is left out.
        let complete: Vec<_> = rows
            .iter()
            .filter(|(_, _, parts)| picked.iter().all(|&i| parts[i].is_some()))
            .collect();
        let adds_up = complete.iter().all(|(_, whole, parts)| {
            let sum: f64 = picked.iter().map(|&i| parts[i].unwrap_or(0.0)).sum();
            diff_of(*whole, sum) <= TOLERANCE
        });
        if !adds_up {
            continue;
        }
        // Proven only where enough rows hold every part: a chance sum seldom holds in two rows.
        if complete.len() < PARTITION_MIN_ROWS
            || (complete.len() as f64) < PARTITION_ROW_SHARE * rows.len() as f64
        {
            thin += 1;
            continue;
        }
        found += 1;
        let whole: f64 = complete.iter().map(|(_, w, _)| w).sum();
        let share = |i: usize| {
            complete
                .iter()
                .map(|(_, _, p)| p[i].unwrap_or(0.0))
                .sum::<f64>()
                / whole
        };
        let mut by_share = picked.clone();
        by_share.sort_by(|a, b| share(*b).total_cmp(&share(*a)));
        let (shown, other) = if by_share.len() <= PARTITION_SHOWN + 1 {
            (by_share, Vec::new())
        } else {
            let other = by_share.split_off(PARTITION_SHOWN);
            (by_share, other)
        };
        let other_share: f64 = other.iter().map(|&i| share(i)).sum();
        let other_bar_max = complete
            .iter()
            .map(|(_, w, p)| other.iter().map(|&i| p[i].unwrap_or(0.0)).sum::<f64>() / w)
            .fold(0.0, f64::max);
        if other_share > OTHER_MAX || other_bar_max > OTHER_BAR_MAX {
            continue;
        }
        let name = |is: &[usize]| is.iter().map(|&i| codes[i].to_string()).collect::<Vec<_>>();
        let here = Partition {
            dim: dim.to_string(),
            total: total.to_string(),
            parts: name(&picked),
            shown: name(&shown),
            other: name(&other),
            other_share,
            other_bar_max,
            incomplete: rows
                .iter()
                .filter(|(_, _, parts)| picked.iter().any(|&i| parts[i].is_none()))
                .map(|((key, period), _, _)| {
                    let mut k: Vec<String> = key
                        .iter()
                        .enumerate()
                        .filter(|(j, _)| {
                            let d = if *j < at { *j } else { j + 1 };
                            t.dims[d].codes.len() > 1
                        })
                        .map(|(_, c)| c.clone())
                        .collect();
                    k.extend(period.clone());
                    k
                })
                .collect(),
            found: 0,
        };
        // Candidates come in the file's code order, so on a tie the first one kept stays.
        let better = best.as_ref().is_none_or(|b| {
            here.parts.len() > b.parts.len()
                || (here.parts.len() == b.parts.len() && here.other_share < b.other_share)
        });
        if better {
            best = Some(here);
        }
    }
    let mut best = best.ok_or(if found == 0 && thin > 0 {
        format!(
            "{thin} sets of {dim} codes add up to {total}, none in at least {PARTITION_MIN_ROWS} rows and {:.0}% of the {} rows holding {total}",
            PARTITION_ROW_SHARE * 100.0,
            rows.len()
        )
    } else if found == 0 {
        format!("no set of {dim} codes adds up to {total} in every complete row")
    } else {
        format!(
            "{found} {dim} partitions add up to {total}, none with \"other\" under {:.0}% of the whole and {:.0}% of each bar",
            OTHER_MAX * 100.0,
            OTHER_BAR_MAX * 100.0
        )
    })?;
    best.found = found;
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn refs() -> Refs {
        let mut r = Refs::default();
        for c in ["DE", "FR", "GR", "GB", "SY", "AF"] {
            r.iso2.insert(c.into());
        }
        r.nuts.insert("DE".into(), (0, "2024".into()));
        r.nuts.insert("DE1".into(), (1, "2024".into()));
        r.nuts.insert("EL".into(), (0, "2024".into()));
        r
    }

    /// q3's siec, cut: TOTAL = CF + N9000 + RA000, CF = C0000 + G3000, RA000 = RA100 + RA300 + RA400; no parent links.
    fn siec_rows(geos: &[(&str, [f64; 6])], missing: &[(&str, &str)]) -> TableInput {
        const SIEC: [&str; 9] = [
            "TOTAL", "CF", "C0000", "G3000", "N9000", "RA000", "RA100", "RA300", "RA400",
        ];
        let mut rows = Vec::new();
        for (geo, [c, g, n, r1, r3, r4]) in geos {
            let values = [
                c + g + n + r1 + r3 + r4,
                c + g,
                *c,
                *g,
                *n,
                r1 + r3 + r4,
                *r1,
                *r3,
                *r4,
            ];
            for (code, v) in SIEC.iter().zip(values) {
                if !missing.contains(&(*geo, *code)) {
                    rows.push((s(&[geo, code, "GWH"]), Some("2025".into()), v));
                }
            }
        }
        let geo: Vec<&str> = geos.iter().map(|(g, _)| *g).collect();
        TableInput {
            provider: "eurostat".into(),
            dataset: "nrg_cb_pem".into(),
            dims: vec![
                DimInput {
                    id: "geo".into(),
                    codes: s(&geo),
                },
                DimInput {
                    id: "siec".into(),
                    codes: s(&SIEC),
                },
                DimInput {
                    id: "unit".into(),
                    codes: s(&["GWH"]),
                },
            ],
            rows,
            zero_cells: Vec::new(),
        }
    }

    /// Five rows of siec_rows: the EU and four members, "other" (C0000 + RA100) at most 21% of a bar.
    const FIVE: [(&str, [f64; 6]); 5] = [
        ("EU27_2020", [3.1, 27.3, 24.7, 5.2, 19.4, 20.3]),
        ("DE", [1.3, 8.9, 0.0, 4.1, 6.2, 5.3]),
        ("ES", [0.4, 12.6, 9.1, 3.3, 11.8, 8.2]),
        ("PL", [2.2, 21.7, 0.0, 1.1, 7.4, 4.6]),
        ("IT", [1.9, 10.4, 0.0, 2.8, 4.1, 6.6]),
    ];

    #[test]
    fn a_partition_is_found_from_the_sums_and_the_finest_under_both_other_caps_is_kept() {
        let eu = ("EU27_2020", [3.1, 27.3, 24.7, 5.2, 19.4, 20.3]);
        // One row adds up 7 splits within TOLERANCE, some by chance (CF + RA000 + RA100 + RA300): none counts.
        let err = partition(&siec_rows(&[eu], &[]), "siec", "TOTAL").unwrap_err();
        assert!(
            err.starts_with("7 sets of siec codes add up to TOTAL, none in at least 2 rows"),
            "{err}"
        );
        // Five rows: the 4 true splits; the finest is the 6-part one, 4 drawn, RA100 + C0000 as "other".
        let rows = siec_rows(&FIVE, &[]);
        let p = partition(&rows, "siec", "TOTAL").unwrap();
        assert_eq!(p.found, 4);
        assert_eq!(
            p.parts,
            s(&["C0000", "G3000", "N9000", "RA100", "RA300", "RA400"])
        );
        assert_eq!(p.shown, s(&["G3000", "RA300", "RA400", "N9000"]));
        assert_eq!(p.other, s(&["RA100", "C0000"]));
        assert!((p.other_share - 25.4 / 234.0).abs() < 1e-9, "{p:?}");
        // A small bar where "other" is 70%: the whole stays under 15%, the bar is over 30%, so the 5-part CF split is kept.
        let fr = ("FR", [4.3, 1.1, 0.9, 2.9, 0.6, 0.7]);
        let p = partition(&siec_rows(&[eu, fr], &[]), "siec", "TOTAL").unwrap();
        assert_eq!(p.parts, s(&["CF", "N9000", "RA100", "RA300", "RA400"]));
        // A second row voids the chance sums: only the 4 true splits stand.
        assert_eq!(p.found, 4);
        assert!(p.other.is_empty());
        assert!(p.incomplete.is_empty());
    }

    #[test]
    fn a_row_missing_a_part_is_left_out_and_listed_not_read_as_zero() {
        let whole = partition(&siec_rows(&FIVE, &[]), "siec", "TOTAL").unwrap();
        // Read as 0, DE's missing RA400 would void every split through RA400; left out (4 of 5 rows still hold every part),
        // the same partition stands and DE is listed.
        let p = partition(&siec_rows(&FIVE, &[("DE", "RA400")]), "siec", "TOTAL").unwrap();
        assert_eq!(p.parts, whole.parts);
        assert_eq!(p.incomplete, [s(&["DE", "2025"])]);
        // Two rows missing RA400 leave 3 of 5, under 80%: no split through RA400 counts; the finest left is CF's parts with RA000.
        let p = partition(
            &siec_rows(&FIVE, &[("DE", "RA400"), ("IT", "RA400")]),
            "siec",
            "TOTAL",
        )
        .unwrap();
        assert_eq!(p.parts, s(&["C0000", "G3000", "N9000", "RA000"]));
        assert!(p.incomplete.is_empty());
    }

    #[test]
    fn no_total_or_no_adding_split_is_no_partition_with_the_reason() {
        let eu = ("EU27_2020", [3.1, 27.3, 24.7, 5.2, 19.4, 20.3]);
        let fr = ("FR", [4.3, 1.1, 0.9, 2.9, 0.6, 0.7]);
        let mut t = siec_rows(&[eu, fr], &[]);
        let err = partition(&t, "siec", "ALL").unwrap_err();
        assert!(err.contains("no row holds ALL"), "{err}");
        // Every part a tenth too high: nothing adds up (on one row alone a chance sum can still pass).
        for r in t.rows.iter_mut().filter(|r| r.0[1] != "TOTAL") {
            r.2 *= 1.1;
        }
        let err = partition(&t, "siec", "TOTAL").unwrap_err();
        assert!(err.contains("no set of siec codes adds up"), "{err}");
    }

    #[test]
    fn unit_codes_follow_the_four_rules() {
        for c in [
            "NR", "PER", "THS_PER", "T", "THS_T", "MIO_T", "KTOE", "TJ", "GWH", "MIO_EUR",
        ] {
            assert_eq!(unit_additive(c), Some(true), "{c}");
        }
        for c in [
            "PC",
            "PC_ACT",
            "PC_POP",
            "PC_TOT",
            "PCH_PRE",
            "P_KM2",
            "P_THAB",
            "I15_A_AVG",
            "I25_A_AVG",
            "RCH_A_AVG",
            "CLV10_MEUR",
        ] {
            assert_eq!(unit_additive(c), Some(false), "{c}");
        }
        assert_eq!(unit_additive("XYZ"), None);
    }

    #[test]
    fn age_takes_the_cover_with_most_codes() {
        let codes = s(&[
            "TOTAL", "Y15-64", "Y_GE65", "Y15-24", "Y25-49", "Y50-64", "Y_LT15",
        ]);
        let spans: Vec<_> = codes
            .iter()
            .enumerate()
            .filter_map(|(i, c)| age_span(c).map(|x| (i, x)))
            .collect();
        let cover = age_cover(&spans).unwrap();
        let names: Vec<&str> = cover.iter().map(|&i| codes[i].as_str()).collect();
        assert_eq!(names, ["Y_GE65", "Y15-24", "Y25-49", "Y50-64", "Y_LT15"]);
    }

    #[test]
    fn interval_codes_cover_their_range() {
        let codes = s(&[
            "C0350-0370",
            "C0350",
            "C0360",
            "C0371",
            "I551-I553",
            "I551",
            "I553",
        ]);
        assert_eq!(
            interval_cover("C0350-0370", &codes),
            [&codes[1], &codes[2], &codes[3]]
        );
        assert_eq!(interval_cover("I551-I553", &codes), [&codes[5], &codes[6]]);
    }

    #[test]
    fn a_code_is_not_the_prefix_parent_of_an_interval_that_starts_with_it() {
        let codes = s(&["TOTAL", "C0350-0370", "C0350", "C0360", "C0371", "C0379"]);
        let values = [10.0, 10.0, 1.0, 2.0, 3.0, 4.0];
        let t = TableInput {
            provider: "eurostat".into(),
            dataset: "nrg_bal_peh".into(),
            dims: vec![
                DimInput {
                    id: "siec".into(),
                    codes: codes.clone(),
                },
                DimInput {
                    id: "unit".into(),
                    codes: s(&["GWH"]),
                },
            ],
            rows: codes
                .iter()
                .zip(values)
                .map(|(c, v)| (vec![c.clone(), "GWH".into()], Some("2024".into()), v))
                .collect(),
            zero_cells: Vec::new(),
        };
        let roles = classify(&t, &refs(), &Ask::default());
        let class: Vec<&Class> = roles.dims[0].codes.iter().map(|c| &c.class).collect();
        assert_eq!(
            class,
            [
                &Class::Total,
                &Class::Subtotal,
                &Class::Member,
                &Class::Member,
                &Class::Member,
                &Class::Member
            ]
        );
    }

    fn bal24(bal: &str) -> Slice {
        Slice::from([
            ("nrg_bal".to_string(), bal.to_string()),
            ("time".to_string(), "2024".to_string()),
        ])
    }

    #[test]
    fn a_one_year_table_grants_a_total_only_in_that_year() {
        let roles = classify(&q2_like(), &refs(), &Ask::default());
        let codes = s(&["TOTAL", "A", "B"]);
        let years = s(&["2023", "2024"]);
        let gic = |year: Option<&str>, over: Option<&[String]>| {
            let mut slice = Slice::from([("nrg_bal".to_string(), "GIC".to_string())]);
            if let Some(y) = year {
                slice.insert("time".into(), y.into());
            }
            let mut v: Vec<(&str, &[String])> = vec![("siec", &codes)];
            if let Some(o) = over {
                v.push(("time", o));
            }
            varying(&roles, &slice, &v).dims[0].total_member.clone()
        };
        assert_eq!(gic(Some("2024"), None).as_deref(), Some("TOTAL"));
        assert_eq!(gic(Some("2023"), None), None);
        assert_eq!(gic(None, Some(&years)), None);
        assert_eq!(gic(None, None), None);
    }

    fn q2_like() -> TableInput {
        // siec TOTAL = A + B except in the GEP row; nrg_bal is not in the formula table here.
        let mut rows = Vec::new();
        for (bal, a, b, total) in [
            ("GIC", 1.0, 2.0, 3.0),
            ("FC_E", 4.0, 5.0, 9.0),
            ("GEP", 1.0, 1.0, 2.5),
        ] {
            for (sc, v) in [("TOTAL", total), ("A", a), ("B", b)] {
                rows.push((s(&[bal, sc, "KTOE"]), Some("2024".into()), v));
            }
        }
        TableInput {
            provider: "eurostat".into(),
            dataset: "nrg_bal_s".into(),
            dims: vec![
                DimInput {
                    id: "nrg_bal".into(),
                    codes: s(&["GIC", "FC_E", "GEP"]),
                },
                DimInput {
                    id: "siec".into(),
                    codes: s(&["TOTAL", "A", "B"]),
                },
                DimInput {
                    id: "unit".into(),
                    codes: s(&["KTOE"]),
                },
            ],
            rows,
            zero_cells: Vec::new(),
        }
    }

    #[test]
    fn a_total_that_misses_in_one_row_is_unchecked_only_there() {
        let roles = classify(&q2_like(), &refs(), &Ask::default());
        let siec = roles.dims.iter().find(|d| d.dim == "siec").unwrap();
        let tags: Vec<Role> = siec.roles.iter().map(|r| r.role).collect();
        assert_eq!(tags, [Role::AdditiveCategory, Role::Category]);
        assert_eq!(siec.unchecked_slices, vec![bal24("GEP")]);
        let codes = s(&["TOTAL", "A", "B"]);
        let gep = varying(&roles, &bal24("GEP"), &[("siec", &codes)]);
        assert!(!gep.dims[0].roles.contains(&Role::AdditiveCategory));
        assert_eq!(gep.dims[0].total_member, None);
        let gic = varying(&roles, &bal24("GIC"), &[("siec", &codes)]);
        assert!(gic.dims[0].roles.contains(&Role::AdditiveCategory));
        assert_eq!(gic.dims[0].total_member.as_deref(), Some("TOTAL"));
        assert_eq!(gic.dims[0].members, 2);
    }

    fn total_of(roles: &TableRoles, bal: &str) -> (Option<String>, bool) {
        let codes = s(&["TOTAL", "A", "B"]);
        let shape = varying(roles, &bal24(bal), &[("siec", &codes)]);
        let d = &shape.dims[0];
        (
            d.total_member.clone(),
            d.roles.contains(&Role::AdditiveCategory),
        )
    }

    #[test]
    fn slices_never_checked_get_no_total() {
        // EED: only TOTAL has a value, both parts are m cells; MISS: B is missing; NONE has no rows at all.
        let mut t = q2_like();
        t.dims[0].codes.extend(s(&["EED", "MISS", "NONE"]));
        t.rows
            .push((s(&["EED", "TOTAL", "KTOE"]), Some("2024".into()), 7.0));
        for sc in ["A", "B"] {
            t.zero_cells
                .push((s(&["EED", sc, "KTOE"]), Some("2024".into())));
        }
        for (sc, v) in [("TOTAL", 3.0), ("A", 1.0)] {
            t.rows
                .push((s(&["MISS", sc, "KTOE"]), Some("2024".into()), v));
        }
        let roles = classify(&t, &refs(), &Ask::default());
        let siec = roles.dims.iter().find(|d| d.dim == "siec").unwrap();
        let one = bal24;
        assert_eq!(
            siec.unchecked_slices,
            vec![one("EED"), one("GEP"), one("MISS")]
        );
        for bal in ["EED", "MISS", "NONE", "GEP"] {
            assert_eq!(total_of(&roles, bal), (None, false), "{bal}");
        }
        assert_eq!(total_of(&roles, "GIC"), (Some("TOTAL".into()), true));
    }

    #[test]
    fn a_total_holds_only_in_the_years_it_passed() {
        // 2024 as in q2_like (GEP fails); 2023: GIC fails, FC_E and GEP pass.
        let mut t = q2_like();
        for (bal, a, b, total) in [
            ("GIC", 1.0, 2.0, 4.0),
            ("FC_E", 4.0, 5.0, 9.0),
            ("GEP", 1.0, 1.0, 2.0),
        ] {
            for (sc, v) in [("TOTAL", total), ("A", a), ("B", b)] {
                t.rows.push((s(&[bal, sc, "KTOE"]), Some("2023".into()), v));
            }
        }
        let roles = classify(&t, &refs(), &Ask::default());
        let siec = roles.dims.iter().find(|d| d.dim == "siec").unwrap();
        let tags: Vec<Role> = siec.roles.iter().map(|r| r.role).collect();
        assert_eq!(tags, [Role::AdditiveCategory, Role::Category]);
        let at = |bal: &str, year: Option<&str>| {
            Slice::from_iter(
                [("nrg_bal", bal)]
                    .into_iter()
                    .chain(year.map(|y| ("time", y)))
                    .map(|(k, v)| (k.to_string(), v.to_string())),
            )
        };
        assert_eq!(
            siec.unchecked_slices,
            vec![at("GEP", Some("2024")), at("GIC", Some("2023"))]
        );
        let codes = s(&["TOTAL", "A", "B"]);
        let years = s(&["2023", "2024"]);
        let total = |slice: &Slice, over_years: bool| {
            let mut v: Vec<(&str, &[String])> = vec![("siec", &codes)];
            if over_years {
                v.push(("time", &years));
            }
            let d = &varying(&roles, slice, &v).dims[0];
            (
                d.total_member.clone(),
                d.roles.contains(&Role::AdditiveCategory),
            )
        };
        let yes = (Some("TOTAL".to_string()), true);
        let no = (None, false);
        assert_eq!(total(&at("GIC", Some("2024")), false), yes);
        // An earlier year that failed, a call without a year, first-vs-last year across a failed year.
        assert_eq!(total(&at("GIC", Some("2023")), false), no);
        assert_eq!(total(&at("GIC", None), false), no);
        assert_eq!(total(&at("GIC", None), true), no);
        assert_eq!(total(&at("FC_E", None), true), yes);
        assert_eq!(total(&at("FC_E", Some("2023")), false), yes);
        assert_eq!(total(&at("GEP", Some("2023")), false), yes);
        assert_eq!(total(&at("GEP", None), true), no);
        // Members only, no year named: not additive.
        let ab = s(&["A", "B"]);
        let members = varying(&roles, &at("FC_E", None), &[("siec", &ab)]);
        assert!(!members.dims[0].roles.contains(&Role::AdditiveCategory));
    }

    #[test]
    fn a_total_holds_across_two_varying_dims_only_where_every_slice_passed() {
        let roles = classify(&q2_like(), &refs(), &Ask::default());
        let siec = s(&["TOTAL", "A", "B"]);
        let at = |bals: &[&str]| {
            let bals = s(bals);
            let shape = varying(
                &roles,
                &Slice::from([("time".into(), "2024".into())]),
                &[("siec", &siec), ("nrg_bal", &bals)],
            );
            shape.dims[0].total_member.clone()
        };
        assert_eq!(at(&["GIC", "FC_E"]).as_deref(), Some("TOTAL"));
        assert_eq!(at(&["GIC", "GEP"]), None);
        // Members only: still additive only where a checked total passed.
        let ab = s(&["A", "B"]);
        let gep = varying(&roles, &bal24("GEP"), &[("siec", &ab)]);
        assert!(!gep.dims[0].roles.contains(&Role::AdditiveCategory));
    }

    #[test]
    fn any_formula_code_puts_the_balance_dim_on_the_formula_table() {
        // GIC is absent, so the formula cannot be checked; EXP must not fall back to a plain member.
        let mut r = refs();
        r.energy.push(EnergyFormula {
            id: "f1".into(),
            lhs: "GIC".into(),
            rhs: vec![
                (1.0, "PPRD".into()),
                (1.0, "IMP".into()),
                (-1.0, "EXP".into()),
            ],
            source: "test".into(),
        });
        let mut rows = Vec::new();
        for (bal, v) in [("PPRD", 5.0), ("IMP", 3.0), ("EXP", 2.0)] {
            rows.push((s(&[bal, "KTOE"]), Some("2024".into()), v));
        }
        let t = TableInput {
            provider: "eurostat".into(),
            dataset: "nrg_x".into(),
            dims: vec![
                DimInput {
                    id: "nrg_bal".into(),
                    codes: s(&["PPRD", "IMP", "EXP"]),
                },
                DimInput {
                    id: "unit".into(),
                    codes: s(&["KTOE"]),
                },
            ],
            rows,
            zero_cells: Vec::new(),
        };
        let roles = classify(&t, &r, &Ask::default());
        let bal = roles.dims.iter().find(|d| d.dim == "nrg_bal").unwrap();
        assert!(bal.codes.iter().all(|c| c.class == Class::Unknown));
    }

    #[test]
    fn places_take_one_level_and_read_eurostat_exceptions() {
        let t = TableInput {
            provider: "eurostat".into(),
            dataset: "x".into(),
            dims: vec![
                DimInput {
                    id: "geo".into(),
                    codes: s(&["EU27_2020", "DE", "DE1", "EL", "DE_TOT", "XK"]),
                },
                DimInput {
                    id: "unit".into(),
                    codes: s(&["PC"]),
                },
            ],
            rows: Vec::new(),
            zero_cells: Vec::new(),
        };
        let roles = classify(&t, &refs(), &Ask::default());
        let geo = &roles.dims[0];
        let class: Vec<(&str, &Class)> = geo
            .codes
            .iter()
            .map(|c| (c.code.as_str(), &c.class))
            .collect();
        assert_eq!(
            class,
            [
                ("EU27_2020", &Class::Total),
                ("DE", &Class::Member),
                ("DE1", &Class::Subtotal),
                ("EL", &Class::Member),
                ("DE_TOT", &Class::Duplicate),
                ("XK", &Class::Special)
            ]
        );
        assert!(geo.codes[3].basis.contains("EL→GR"));
        assert!(!roles.unit_additive);
    }

    /// Replays the six dev questions from the registry fixtures:
    /// CLASSIFY_DIR=<registry>/classify cargo test classify::tests::dev_questions -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dev_questions() {
        let dir = std::path::PathBuf::from(std::env::var("CLASSIFY_DIR").expect("CLASSIFY_DIR"));
        let refs = load_refs(&dir.join("refs")).unwrap();
        for (q, provider, dataset) in [
            ("q1", "eurostat", "nrg_ind_ren"),
            ("q2", "eurostat", "nrg_bal_s"),
            ("q3", "eurostat", "nrg_bal_peh"),
            ("q4", "worldbank", "EN.GHG.CO2.PC.CE.AR5"),
            ("q5", "worldbank", "SP.POP.65UP.TO.ZS"),
            ("q6", "eurostat", "migr_asyappctza"),
        ] {
            let text = std::fs::read_to_string(dir.join(format!("fixtures/{q}.tsv"))).unwrap();
            let mut t = TableInput {
                provider: provider.into(),
                dataset: dataset.into(),
                dims: Vec::new(),
                rows: Vec::new(),
                zero_cells: Vec::new(),
            };
            for line in text.lines() {
                let f: Vec<&str> = line.split('\t').collect();
                let n = t.dims.len();
                match f[0] {
                    "D" => t.dims.push(DimInput {
                        id: f[1].into(),
                        codes: f[2].split(' ').map(str::to_string).collect(),
                    }),
                    "R" => t.rows.push((
                        s(&f[1..=n]),
                        Some(f[n + 1].into()),
                        f[n + 2].parse().unwrap(),
                    )),
                    "M" => t.zero_cells.push((s(&f[1..=n]), Some(f[n + 1].into()))),
                    _ => panic!("{line}"),
                }
            }
            let started = std::time::Instant::now();
            let roles = classify(&t, &refs, &Ask::default());
            let ms = started.elapsed().as_millis();
            println!(
                "== {q} {dataset} unit={} additive={} flow={:?} {ms}ms",
                roles.unit,
                roles.unit_additive,
                roles
                    .flow
                    .as_ref()
                    .map(|f| (&f.source_dim, &f.target_dim, f.direction))
            );
            for d in &roles.dims {
                let mut count: BTreeMap<String, usize> = BTreeMap::new();
                for c in &d.codes {
                    *count.entry(format!("{:?}", c.class)).or_default() += 1;
                }
                let tags: Vec<String> = d.roles.iter().map(|r| format!("{:?}", r.role)).collect();
                println!(
                    "  {} roles=[{}] place={} pick={:?} unchecked={} classes={:?}",
                    d.dim,
                    tags.join(","),
                    d.is_place,
                    d.pick.as_ref().map(|p| &p.code),
                    d.unchecked_slices.len(),
                    count
                );
                for c in d
                    .codes
                    .iter()
                    .filter(|c| matches!(c.class, Class::Total | Class::TotalUnchecked))
                {
                    println!("    {} {:?} {}", c.code, c.class, c.basis);
                }
                if d.unchecked_slices.len() <= 4 {
                    for u in &d.unchecked_slices {
                        println!("    unchecked {u:?}");
                    }
                }
            }
            let dim = |name: &str| roles.dims.iter().find(|d| d.dim == name).unwrap();
            if q == "q5" {
                // wb-fetch v1.2a: 217 economies, aggregates never counted as members.
                let country = dim("country");
                let codes: Vec<String> = country.codes.iter().map(|c| c.code.clone()).collect();
                let shape = varying(&roles, &Slice::new(), &[("country", &codes)]);
                assert_eq!(shape.dims[0].members, 217);
                assert!(shape.dims[0].iso_countries);
                // The raw file has 266 locations (217 + 49 aggregates). XY "Not classified" is an aggregate whose
                // values are all null, so it leaves no row; the fixture script records it instead of dropping it silently.
                assert_eq!(codes.len() - 217, 48, "aggregates with a value");
                let dropped = std::fs::read_to_string(dir.join("fixtures/q5-dropped.tsv")).unwrap();
                assert_eq!(dropped, "XY\tINX\tall_null\n");
                assert_eq!(
                    codes.len() + dropped.lines().count(),
                    266,
                    "every raw location is a code or recorded"
                );
            }
            if q == "q2" {
                let year = t.rows.iter().filter_map(|r| r.1.clone()).max().unwrap();
                let gep = |c: &str| {
                    Slice::from([
                        ("nrg_bal".to_string(), c.to_string()),
                        ("time".to_string(), year.clone()),
                    ])
                };
                let siec = dim("siec");
                // The two failing rows plus every empty *_EED row (only TOTAL holds a value there).
                assert!(siec.unchecked_slices.contains(&gep("GEP")));
                assert!(siec.unchecked_slices.contains(&gep("GHP")));
                let eed: Vec<&Slice> = siec
                    .unchecked_slices
                    .iter()
                    .filter(|e| e.get("nrg_bal").is_some_and(|c| c.ends_with("_EED")))
                    .collect();
                assert!(!eed.is_empty());
                let codes: Vec<String> = siec.codes.iter().map(|c| c.code.clone()).collect();
                for e in eed.iter().copied().chain([&gep("GEP")]) {
                    let shape = varying(&roles, e, &[("siec", &codes)]);
                    assert_eq!(shape.dims[0].total_member, None, "{e:?}");
                }
                println!(
                    "  q2 siec unchecked {} (of which _EED {})",
                    siec.unchecked_slices.len(),
                    eed.len()
                );
            }
            if let Ok(path) = std::env::var("CLASSIFY_OUT") {
                std::fs::create_dir_all(&path).unwrap();
                std::fs::write(
                    format!("{path}/{q}.json"),
                    serde_json::to_string_pretty(&roles).unwrap(),
                )
                .unwrap();
            }
        }
    }
}
