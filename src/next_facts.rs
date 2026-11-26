//! New route, visual group: the page's facts, computed and formatted here so a second-layer leaf only prints the text it is
//! handed. A fact is a declared query: an op over the request's rows (value, mean, peak, low, last, count, rest, n, zeros,
//! unrowed, excluded) or over two
//! other facts (share, change, times, minus, plus); nothing names a topic. Ported from the gas-1027 prototype's facts.py,
//! whose output the tests compare text for text.
//! A fact family (`each`: a dimension) is one value fact per code of that dimension, keyed `<family>.<code>`; the codes
//! are the rows', none is named here. The years a table covers and the dates of sourced records are ledger entries too
//! (`period:`, `record:`), read from the rows.
//! Every fact keeps its op and the sources of the rows it read, and `recheck` recomputes every `fact:`, `period:` and
//! `record:` entry of a page's ledger from the request rows, so no number is taken on the word of whoever built the page.

use crate::next_ledger::{Label, Num, LABEL_SRC};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Where a fact's ledger entries are: `fact:<key>` its number with its unit, `fact:<key>.n` the number alone (for a layout
/// that states the unit once), `fact:<key>.t` its period, `fact:<key>.tick<i>` the i-th tick of an axis running to it,
/// `fact:<key>.r` a value fact's number alone at fewer places (display).
pub const FACT_SRC: &str = "fact:";

/// Where a year a table's rows cover is: `period:<table>:<year>`, its text the year; a month is two entries read from
/// one key, `period:<table>:<YYYY-MM>.y` and `.m`, so a date in words prints its year and month from the same period.
pub const PERIOD_SRC: &str = "period:";

/// Where a sourced record's cell is: `record:<table>/<i>` the row, then `:<column>` and `.y`, `.m`, `.d` a date's parts.
pub const RECORD_SRC: &str = "record:";

/// Where a row a `zeros` fact counted is kept in the ledger: `zero:<its series src>`, its text the row's value, one entry per
/// row, so each flow a picture leaves out as zero is on record with the cell it was read from (never printed).
pub const ZERO_SRC: &str = "zero:";

/// Where a pair an `unrowed` fact counted is kept in the ledger: `norow:<code>><code>`, its text "no row", one entry per pair,
/// so each pair asked for that the table holds no row of is on record (never printed).
pub const NOROW_SRC: &str = "norow:";

/// The text of a NOROW_SRC entry.
pub const NOROW_TEXT: &str = "no row";

/// Where a pair an `excluded` fact names is kept in the ledger: `excluded:<code>><code>`, its text EXCLUDED_TEXT, one entry
/// per pair, so each pair the registry leaves out of a flow is on record apart from a pair with no row and a zero flow.
pub const EXCLUDED_SRC: &str = "excluded:";

/// Where a group page's member-list year is (BASIS_YEAR_SRC, its text the year): the year the knowledge group's member list
/// holds from when it is not the page's data year (a question naming no year counts today's members, owner 11-16 08:4x
/// item 1); the flow writes it into the request's basis (spec.basis.member_year) from the group registry, never a model.
pub const BASIS_YEAR_SRC: &str = "basis:member_year";

/// The text of an EXCLUDED_SRC entry.
pub const EXCLUDED_TEXT: &str = "excluded by registry";

/// Where a series row was read (the series, its row key, period and column): what makes its table one a page dates.
pub(crate) const SERIES_SRC: &str = "series:";

/// The record columns a page prints whole, as the cell gives them (`record:<table>/<i>:<column>`): a source's name, which
/// may hold a regulation's number, and a thing's name (a pipeline's, 北溪1号), which may hold a digit. Each is rechecked
/// against its row; no other column prints whole.
const RECORD_TEXT: &[&str] = &["source_name", "name_zh"];

/// A table as a mark names it (`record:<table>/<i>`, `period:<table>:...`): its id, a letter first, then letters, digits,
/// `_` or `-`; or a World Bank table as the catalogue names it (l5geo: the indicator id, which may hold `.`, then `@2`,
/// such as EN.GHG.CO2.PC.CE.AR5@2). Never a file's path: the request's table list says where a table's file is, and no
/// path goes on a page.
pub fn table_id(t: &str) -> bool {
    let (id, dot) = match t.strip_suffix("@2") {
        Some(id) => (id, true),
        None => (t, false),
    };
    // a dot only parts a World Bank id into non-empty pieces ("X.@2" and "a..b@2" are none); the pieces' characters are
    // not ruled further (the catalogue's World Bank ids hold lower case, e.g. account.t.d.1), so "cities.csv@2" has
    // the shape of one: what keeps a file's name off a page is leaf_refs, which takes only the request's own table ids
    id.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-') || (dot && c == '.'))
        && id.split('.').all(|part| !part.is_empty())
}

/// The table ids a leaf page may name in its sources: the dataset id each table of the request was read from (`"id"` in
/// the spec's table list, which layer 1 fills), sorted, each once. The same list goes to the child and to the page check,
/// which takes a `data-ref` only when it equals one of them (no rule on the id's characters: a World Bank id such as
/// AG.LND.AGRI.K2 is one); it is never read from the page's wording. Err names each table with no id.
pub fn leaf_refs(tables: &Value) -> Result<Vec<String>, String> {
    let mut refs = Vec::new();
    let mut off = Vec::new();
    for (name, t) in tables.as_object().into_iter().flatten() {
        match t["id"].as_str() {
            Some(id) if !id.is_empty() => refs.push(id.to_string()),
            _ => off.push(format!("table {name}: the request gives no dataset id")),
        }
    }
    refs.sort();
    refs.dedup();
    if off.is_empty() {
        Ok(refs)
    } else {
        Err(off.join("\n"))
    }
}

/// The aggregate a rest or value query leaves out with the members (the code Eurostat gives the whole of a dimension).
pub(crate) const TOTAL_CODE: &str = "TOTAL";

/// The dimension a count runs over when its query names none: Eurostat's place dimension.
const PLACE_DIM: &str = "geo";

/// How many ticks an axis holds at least within its data; the step is the largest of 1, 2, 5 times a power of ten that
/// keeps to it (so at most 7).
const MIN_TICKS: f64 = 3.0;

/// One row of the request's long table: where it was read, its table, its dimension codes, its period and its value.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Row {
    pub src: String,
    pub table: String,
    pub dims: BTreeMap<String, String>,
    pub time: String,
    pub value: f64,
}

/// The page's declared facts, in order, with its formats (`<fmt>`: scale, dec, suffix; `time`: prefix) and the member
/// codes a count, a rest or a value outside the members reads (from the knowledge group's member list; none when the
/// page has no such query).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Spec {
    pub facts: Vec<(String, Value)>,
    pub fmts: Value,
    pub members: Option<Vec<String>>,
    /// The countries the question names on their own and what the page must say of them (knobs.spec.asked_places); none
    /// when the question names no country.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_places: Option<AskedPlaces>,
    /// The member basis a page for a country group must say (knobs.spec.basis); none for any other page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basis: Option<Basis>,
}

/// What a page for a country group counts and must say (the flow writes it from the knowledge group's group_basis): the
/// line's words, none when it prints none ({year} and {n} the page's entries of `year` in `table` and of the `count` fact's
/// bare number, {missing} the name rows of the `missing` members joined by `missing_join`), the year the count is at, the
/// count's fact (none on a page with no count of its places), and, as the page's rows write the codes, the group's members
/// that year (countries only), the places the question names beside them, the members with no data, and the places left
/// out with why.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Basis {
    pub words: Option<String>,
    pub year: String,
    pub count: Option<String>,
    pub table: String,
    pub members: Vec<String>,
    #[serde(default)]
    pub named: Vec<String>,
    #[serde(default)]
    pub missing: Vec<String>,
    #[serde(default)]
    pub missing_join: String,
    #[serde(default)]
    pub dropped: Vec<BasisDropped>,
    /// The members of `year` the run never fetched; a page with any is refused (its lack is no fact of the data).
    #[serde(default)]
    pub unfetched: Vec<String>,
    /// The year of the member list when it is not `year` (BASIS_YEAR_SRC); none: the list is `year`'s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_year: Option<String>,
    /// Why a stored request's basis could not be read; a page with one never passes (no check skipped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<String>,
    /// The members a page asking for the first n at one end leaves out (the flow writes them): each must be a member with
    /// one row of the basis table at `year` whose value is no better than any drawn (no higher than the lowest drawn, or
    /// for the last n no lower than the highest), which the whole-page check recomputes from the request's rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut: Option<BasisCut>,
}

/// The members a page leaves out for asking the first or the last n, and which end it asks.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BasisCut {
    pub codes: Vec<String>,
    pub low: bool,
}

/// A place a group's page left out, and why.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BasisDropped {
    pub code: String,
    pub why: String,
}

/// The countries a question names on their own (the knowledge group's places, countries only), as the page's rows write
/// them (a row is of a place when one of its `dims` holds the code: a hub page's place is its fixed geo, the places around
/// it its varying dimension), and what the page must do with each (next_leaf places_answered): print a value read from
/// its rows, or, when it has no row at the page's `year`, be in `missing` and named on the page by its name row in the
/// line `words` ({missing} the names joined by `join`, every word the knowledge group's). The flow writes it; no model does.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AskedPlaces {
    pub asked: Vec<String>,
    #[serde(default)]
    pub missing: Vec<String>,
    #[serde(default)]
    pub words: String,
    #[serde(default)]
    pub join: String,
    pub dims: Vec<String>,
    pub year: String,
    /// Why a stored request's asked_places could not be read; a page with one never passes (no check skipped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<String>,
}

/// What the program computed for one fact.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Fact {
    pub key: String,
    pub op: String,
    pub v: f64,
    /// The period it was read at (peak, low, last).
    pub t: Option<String>,
    /// How many values it covers (mean: the periods; rest: the codes above zero; n: the codes counted).
    pub n: Option<usize>,
    /// The member codes counted (count), sorted.
    pub who: Vec<String>,
    pub fmt: String,
    /// The sources of the rows it read in request order, or `fact:<a>`, `fact:<b>` for one computed from two facts.
    pub reads: Vec<String>,
    /// The same value worked out exactly from the rows' decimal values (`exact_values`), which `text` and `display`
    /// round once; None when it cannot be (a value with no short decimal, a sum past i128), and the text is `v`'s. Not
    /// stored: a request's facts read back print from `v`.
    #[serde(skip)]
    pub exact: Option<Exact>,
}

/// Two facts are the same fact when every stored field is: `exact` is how `v` is printed, not another value.
impl PartialEq for Fact {
    fn eq(&self, o: &Self) -> bool {
        self.key == o.key
            && self.op == o.op
            && (self.v == o.v || (self.v.is_nan() && o.v.is_nan()))
            && self.t == o.t
            && self.n == o.n
            && self.who == o.who
            && self.fmt == o.fmt
            && self.reads == o.reads
    }
}

/// A rational number, numerator over a positive denominator in lowest terms: a row's value as its decimal text writes it
/// (the shortest that reads back as the stored number, the source's own text), and what the facts' ops make of such
/// values, with no binary rounding on the way. Every step is checked; one past i128 gives none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exact {
    n: i128,
    d: i128,
}

impl Exact {
    fn new(n: i128, d: i128) -> Option<Exact> {
        if d == 0 {
            return None;
        }
        let g = gcd(n.unsigned_abs(), d.unsigned_abs()).max(1) as i128;
        let s = if d < 0 { -1 } else { 1 };
        Some(Exact {
            n: s * (n / g),
            d: s * (d / g),
        })
    }
    fn int(k: i128) -> Exact {
        Exact { n: k, d: 1 }
    }
    /// The value of the shortest decimal text of `x` (Rust prints an f64 that way, with no exponent); none for a value
    /// that is not finite or whose digits pass i128.
    pub fn of(x: f64) -> Option<Exact> {
        if !x.is_finite() {
            return None;
        }
        let t = format!("{x}");
        let (neg, t) = t
            .strip_prefix('-')
            .map_or((false, t.as_str()), |r| (true, r));
        let (whole, frac) = t.split_once('.').unwrap_or((t, ""));
        let digits: i128 = format!("{whole}{frac}").parse().ok()?;
        let d = 10i128.checked_pow(u32::try_from(frac.len()).ok()?)?;
        Exact::new(if neg { -digits } else { digits }, d)
    }
    fn add(self, o: Exact) -> Option<Exact> {
        Exact::new(
            self.n
                .checked_mul(o.d)?
                .checked_add(o.n.checked_mul(self.d)?)?,
            self.d.checked_mul(o.d)?,
        )
    }
    fn sub(self, o: Exact) -> Option<Exact> {
        self.add(Exact {
            n: o.n.checked_neg()?,
            d: o.d,
        })
    }
    fn mul(self, o: Exact) -> Option<Exact> {
        Exact::new(self.n.checked_mul(o.n)?, self.d.checked_mul(o.d)?)
    }
    fn div(self, o: Exact) -> Option<Exact> {
        Exact::new(self.n.checked_mul(o.d)?, self.d.checked_mul(o.n)?)
    }
    fn abs(self) -> Exact {
        Exact {
            n: self.n.abs(),
            d: self.d,
        }
    }
}

fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// Each fact's value worked out exactly (Exact) from what it read: the rows' decimal values summed (a value, a period's
/// total, a rest), over their count for a mean, a count as itself, and a fact of two facts from their exact values. A
/// fact whose reads or op cannot be worked out exactly keeps none, and so does every fact made from it.
fn exact_values(facts: &mut [Fact], rows: &[Row]) {
    let row: BTreeMap<&str, f64> = rows.iter().map(|r| (r.src.as_str(), r.value)).collect();
    let sum = |reads: &[String]| {
        reads.iter().try_fold(Exact::int(0), |s, src| {
            s.add(Exact::of(*row.get(src.as_str())?)?)
        })
    };
    let mut known: BTreeMap<String, Exact> = BTreeMap::new();
    // a fact of two facts may come before them in declared order: pass again until nothing more is worked out
    loop {
        let before = known.len();
        for f in facts.iter_mut().filter(|f| f.exact.is_none()) {
            let of = |k: &str| k.strip_prefix(FACT_SRC).and_then(|k| known.get(k)).copied();
            f.exact = match f.op.as_str() {
                "value" | "peak" | "low" | "last" | "rest" if !f.reads.is_empty() => sum(&f.reads),
                "mean" if !f.reads.is_empty() => {
                    sum(&f.reads).and_then(|s| s.div(Exact::int(f.reads.len() as i128)))
                }
                "per_year" | "line_at" if f.reads.len() == 2 && f.n.is_some() => {
                    let years = Exact::int(f.n.unwrap_or(1) as i128);
                    match (of(&f.reads[0]), of(&f.reads[1])) {
                        (Some(a), Some(b)) if f.op == "per_year" => {
                            a.sub(b).and_then(|d| d.div(years))
                        }
                        (Some(a), Some(b)) => b.mul(years).and_then(|d| a.add(d)),
                        _ => None,
                    }
                }
                // the year from the exact start, rate and target: the first whole number of years at or over the gap; it
                // takes the place of the float year (review 11-22: a float quotient can put a year too many)
                "reach_year" if f.reads.len() == 3 && f.n.is_some() => {
                    match (of(&f.reads[0]), of(&f.reads[1]), of(&f.reads[2])) {
                        (Some(s), Some(r), Some(t)) => {
                            let start_year = f.v as i128 - f.n.unwrap_or(0) as i128;
                            let k = t.sub(s).and_then(|gap| {
                                if gap.n <= 0 {
                                    Some(0)
                                } else if r.n > 0 {
                                    gap.div(r).map(|q| {
                                        q.n.div_euclid(q.d) + i128::from(q.n.rem_euclid(q.d) != 0)
                                    })
                                } else {
                                    None
                                }
                            });
                            k.map(|k| {
                                f.v = (start_year + k) as f64;
                                f.n = Some(k as usize);
                                Exact::int(start_year + k)
                            })
                        }
                        _ => None,
                    }
                }
                "step_max" if f.t.is_some() => {
                    let later = f.t.clone().unwrap_or_default();
                    let at = |later_side: bool| {
                        let picked: Vec<String> = f
                            .reads
                            .iter()
                            .filter(|s| {
                                rows.iter()
                                    .any(|r| &r.src == *s && (r.time == later) == later_side)
                            })
                            .cloned()
                            .collect();
                        sum(&picked)
                    };
                    match (at(true), at(false)) {
                        (Some(a), Some(b)) => a.sub(b),
                        _ => None,
                    }
                }
                "count" | "n" | "position" | "zeros" | "unrowed" | "excluded"
                    if f.v.fract() == 0.0 =>
                {
                    Some(Exact::int(f.v as i128))
                }
                "share" | "times" | "change" | "minus" | "plus" if f.reads.len() == 2 => {
                    match (of(&f.reads[0]), of(&f.reads[1])) {
                        (Some(a), Some(b)) => match f.op.as_str() {
                            "share" | "times" => a.div(b),
                            "change" => a.div(b).and_then(|q| q.sub(Exact::int(1))),
                            "minus" => a.sub(b),
                            _ => a.add(b),
                        },
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Some(e) = f.exact {
                known.insert(f.key.clone(), e);
            }
        }
        if known.len() == before {
            break;
        }
    }
}

/// `x` with `dec` places, rounded once on its exact value with a tie to the even digit (GB/T 8170), a minus on a
/// negative value unless it rounds to 0 (a printed "-0.0" says a sign no reader can use), and a comma between thousands
/// when `sep`: `fixed` on the exact value.
fn fixed_exact(x: Exact, dec: usize, sep: bool) -> Option<String> {
    let a = x.abs();
    let scaled =
        a.n.checked_mul(10i128.checked_pow(u32::try_from(dec).ok()?)?)?;
    let (mut q, r) = (scaled / a.d, scaled % a.d);
    // r / d against one half: 2r against d
    let twice = r.checked_mul(2)?;
    if twice > a.d || (twice == a.d && q % 2 == 1) {
        q += 1;
    }
    let sign = if x.n < 0 && q != 0 { "-" } else { "" };
    let digits = format!("{q:0>width$}", width = dec + 1);
    let (int, frac) = digits.split_at(digits.len() - dec);
    let int = if sep { thousands(int) } else { int.to_string() };
    Some(if dec == 0 {
        format!("{sign}{int}")
    } else {
        format!("{sign}{int}.{frac}")
    })
}

/// Whole digits with a comma between thousands.
fn thousands(int: &str) -> String {
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(c);
    }
    grouped
}

/// A fact's number at `scale` and `dec` places: its exact value rounded once when it has one, else `v` as `fixed` prints it.
fn rounded(f: &Fact, scale: f64, dec: usize, sep: bool) -> String {
    f.exact
        .and_then(|e| e.mul(Exact::of(scale)?))
        .and_then(|e| fixed_exact(e, dec, sep))
        .unwrap_or_else(|| fixed(f.v * scale, dec, sep))
}

/// Which of a fact's ledger entries a number is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Part {
    Text,
    Bare,
    Period,
    /// The period's year or month (`.t.y`, `.t.m`) as a whole number, or its half (`.t.h`) as its word (HALF_WORDS), for a
    /// leaf that writes the words around them.
    Year,
    Month,
    Half,
}

/// Every declared fact, in declared order. Err lists each fact that cannot be computed (one per line): a query that does
/// not read as one, a row set with no row, a zero divisor, a fact it needs that is missing or fails, or members it needs
/// that the spec does not hold. No value is guessed.
pub fn compute(spec: &Spec, rows: &[Row]) -> Result<Vec<Fact>, String> {
    let queries: BTreeMap<&str, &Value> = spec.facts.iter().map(|(k, q)| (k.as_str(), q)).collect();
    let mut done: BTreeMap<String, Result<Fact, String>> = BTreeMap::new();
    let mut out = Vec::new();
    let mut off = Vec::new();
    for (key, q) in &spec.facts {
        if !q["each"].is_null() {
            let members = match q["op"].as_str() {
                Some("minus") => minus_family(key, q, &queries, spec, rows),
                _ => family(key, q, spec, rows),
            };
            match members {
                Ok(fs) => out.extend(fs),
                Err(e) => off.push(e),
            }
            continue;
        }
        match fact(key, &queries, spec, rows, &mut done, &mut BTreeSet::new()) {
            Ok(f) => out.push(f),
            Err(e) => off.push(e),
        }
    }
    if off.is_empty() {
        exact_values(&mut out, rows);
        Ok(out)
    } else {
        Err(off.join("\n"))
    }
}

fn fact(
    key: &str,
    queries: &BTreeMap<&str, &Value>,
    spec: &Spec,
    rows: &[Row],
    done: &mut BTreeMap<String, Result<Fact, String>>,
    open: &mut BTreeSet<String>,
) -> Result<Fact, String> {
    if let Some(r) = done.get(key) {
        return r.clone();
    }
    let q = *queries
        .get(key)
        .ok_or_else(|| format!("{key}: no such fact is declared"))?;
    if !open.insert(key.to_string()) {
        return Err(format!("{key}: the fact depends on itself"));
    }
    let r = one(key, q, queries, spec, rows, done, open);
    open.remove(key);
    done.insert(key.to_string(), r.clone());
    r
}

fn one(
    key: &str,
    q: &Value,
    queries: &BTreeMap<&str, &Value>,
    spec: &Spec,
    rows: &[Row],
    done: &mut BTreeMap<String, Result<Fact, String>>,
    open: &mut BTreeSet<String>,
) -> Result<Fact, String> {
    if !q["each"].is_null() {
        return Err(format!(
            "{key}: a family gives one fact per code; name one as {key}.<code>"
        ));
    }
    let op = match &q["op"] {
        Value::Null => "value",
        Value::String(s) => s.as_str(),
        _ => return Err(format!("{key}: op is not a word")),
    };
    let mut f = Fact {
        key: key.to_string(),
        op: op.to_string(),
        v: f64::NAN,
        t: None,
        n: None,
        who: Vec::new(),
        fmt: String::new(),
        reads: Vec::new(),
        exact: None,
    };
    if matches!(op, "share" | "change" | "times" | "minus" | "plus") {
        let mut of = |side: &str| -> Result<f64, String> {
            let k = q[side]
                .as_str()
                .ok_or_else(|| format!("{key}: {op} names no fact as {side}"))?;
            let other = fact(k, queries, spec, rows, done, open)
                .map_err(|e| format!("{key}: {side} {k} fails ({e})"))?;
            Ok(other.v)
        };
        // owner 11-06: a difference or ratio is computed from the raw values, never from its operands as printed
        if q.get("of_printed").is_some() {
            return Err(format!(
                "{key}: of_printed is refused, a difference is computed from the raw values"
            ));
        }
        let (a, b) = (of("a")?, of("b")?);
        if b == 0.0 && matches!(op, "share" | "change" | "times") {
            return Err(format!("{key}: {op} divides by {}, which is 0", q["b"]));
        }
        f.v = match op {
            "share" | "times" => a / b,
            "change" => a / b - 1.0,
            "minus" => a - b,
            _ => a + b,
        };
        f.fmt = match &q["fmt"] {
            Value::Null => "pct".to_string(),
            v => word(key, v, "fmt")?,
        };
        f.reads = vec![
            format!("{FACT_SRC}{}", q["a"].as_str().unwrap_or_default()),
            format!("{FACT_SRC}{}", q["b"].as_str().unwrap_or_default()),
        ];
        return Ok(f);
    }
    if matches!(op, "per_year" | "cagr" | "line_at" | "reach_year") {
        return of_facts_over_years(key, q, op, f, queries, spec, rows, done, open);
    }
    if matches!(op, "step_max" | "first_above" | "spread" | "group_change") {
        return over_periods(key, q, op, f, spec, rows);
    }
    if op == "count" {
        let members = members(key, spec)?;
        let time = word(key, &q["time"], "time")?;
        // a member counts when its value of a over its value of b is above `above`; or, with `below` and no b, when its own
        // value of a is under `below` (the members under a line: every member needs its row of a, none is skipped)
        let (line, under) = match (q["above"].as_f64(), q["below"].as_f64()) {
            (Some(x), None) => (x, false),
            (None, Some(x)) if q["b"].is_null() => (x, true),
            _ => {
                return Err(format!(
                    "{key}: count has no number as above (or below, with no b)"
                ))
            }
        };
        let by = match &q["by"] {
            Value::Null => PLACE_DIM.to_string(),
            v => word(key, v, "by")?,
        };
        // a later row of the same code takes the place of an earlier one, as the prototype's dict does
        let mut side = |s: &str| -> Result<BTreeMap<String, f64>, String> {
            let mut at = BTreeMap::new();
            for r in select(key, rows, &q[s])?
                .into_iter()
                .filter(|r| r.time == time)
            {
                let code = r
                    .dims
                    .get(&by)
                    .ok_or_else(|| format!("{key}: the row {} has no {by}", r.src))?;
                at.insert(code.clone(), finite(key, r)?);
                f.reads.push(r.src.clone());
            }
            Ok(at)
        };
        let num = side("a")?;
        // under a line there is no b: each member's value of a is read over 1
        let (den, side_b) = if under {
            (
                num.keys()
                    .map(|c| (c.clone(), 1.0))
                    .collect::<BTreeMap<String, f64>>(),
                "a",
            )
        } else {
            (side("b")?, "b")
        };
        if den.is_empty() {
            return Err(format!("{key}: count has no row of {side_b} at {time}"));
        }
        // a member with no row of b is not known to be under the line, so the count is not known: fail, never skip
        let gone: Vec<&str> = members
            .iter()
            .filter(|g| !den.contains_key(*g))
            .map(String::as_str)
            .collect();
        if !gone.is_empty() {
            return Err(format!(
                "{key}: count has no row of {side_b} at {time} for {}",
                gone.join(", ")
            ));
        }
        let mut hit: Vec<String> = members
            .iter()
            .filter(|g| {
                den.get(*g).is_some_and(|d| {
                    let r = num.get(*g).copied().unwrap_or(0.0) / d;
                    *d != 0.0 && (if under { r < line } else { r > line })
                })
            })
            .cloned()
            .collect();
        hit.sort();
        f.v = hit.len() as f64;
        f.who = hit;
        f.fmt = "n".to_string();
        return Ok(f);
    }
    f.fmt = word(key, &q["fmt"], "fmt")?;
    let picked = select(key, rows, q)?;
    match op {
        "mean" => {
            let within = word(key, &q["within"], "within")?;
            let at: Vec<&Row> = picked
                .into_iter()
                .filter(|r| r.time.starts_with(&within))
                .collect();
            if at.is_empty() {
                return Err(format!("{key}: mean has no row within {within}"));
            }
            f.v = sum(key, &at)? / at.len() as f64;
            f.n = Some(at.len());
            f.reads = at.iter().map(|r| r.src.clone()).collect();
        }
        "peak" | "low" | "last" => {
            let from = match &q["from"] {
                Value::Null => String::new(),
                v => word(key, v, "from")?,
            };
            // the window's last period, inclusive; none: every period from `from` on
            let to = match &q["to"] {
                Value::Null => None,
                v => Some(word(key, v, "to")?),
            };
            // each period's total over the rows, in the order the periods first appear
            let mut ser: Vec<(String, f64)> = Vec::new();
            for r in &picked {
                let v = finite(key, r)?;
                match ser.iter_mut().find(|(t, _)| *t == r.time) {
                    Some((_, s)) => *s += v,
                    None => ser.push((r.time.clone(), 0.0 + v)),
                }
            }
            ser.retain(|(t, _)| *t >= from && to.as_ref().is_none_or(|to| t <= to));
            let Some(first) = ser.first().cloned() else {
                return Err(format!("{key}: {op} has no row"));
            };
            // the first period that holds the most (least, the latest) wins a tie, as Python's max and min do
            let (t, v) = ser.iter().skip(1).fold(first, |best, (t, v)| {
                let better = match op {
                    "peak" => *v > best.1,
                    "low" => *v < best.1,
                    _ => *t > best.0,
                };
                if better {
                    (t.clone(), *v)
                } else {
                    best
                }
            });
            f.reads = picked
                .iter()
                .filter(|r| r.time == t)
                .map(|r| r.src.clone())
                .collect();
            f.v = v;
            f.t = Some(t);
        }
        "rest" => {
            let time = word(key, &q["time"], "time")?;
            let by = word(key, &q["by"], "by")?;
            let skip = q["skip"]
                .as_u64()
                .ok_or_else(|| format!("{key}: rest has no whole number as skip"))?
                as usize;
            let outside = q["not_eu"].as_bool().unwrap_or(false);
            let members = if outside {
                members(key, spec)?
            } else {
                &[][..]
            };
            let mut tot: Vec<(String, f64, Vec<String>)> = Vec::new();
            for r in picked.iter().filter(|r| r.time == time) {
                let k = r
                    .dims
                    .get(&by)
                    .ok_or_else(|| format!("{key}: the row {} has no {by}", r.src))?;
                if outside && (members.contains(k) || k == TOTAL_CODE) {
                    continue;
                }
                let v = finite(key, r)?;
                match tot.iter_mut().find(|(c, _, _)| c == k) {
                    Some((_, s, srcs)) => {
                        *s += v;
                        srcs.push(r.src.clone());
                    }
                    None => tot.push((k.clone(), 0.0 + v, vec![r.src.clone()])),
                }
            }
            if tot.is_empty() {
                return Err(format!("{key}: rest has no row at {time}"));
            }
            // largest first; a stable sort keeps codes of equal totals in the order they appear, as Python's sorted does
            tot.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let kept = tot.get(skip..).unwrap_or_default();
            f.v = kept.iter().fold(0.0, |s, (_, v, _)| s + v);
            f.n = Some(kept.iter().filter(|(_, v, _)| *v > 0.0).count());
            f.reads = kept
                .iter()
                .flat_map(|(_, _, s)| s.iter().cloned())
                .collect();
        }
        // how many of the selected rows hold 0 at `time`: the flows a picture leaves out as zero, each one read
        "zeros" => {
            let time = word(key, &q["time"], "time")?;
            let at: Vec<&Row> = picked
                .into_iter()
                .filter(|r| r.time == time && r.value == 0.0)
                .collect();
            if at.is_empty() {
                return Err(format!("{key}: zeros has no row of 0 at {time}"));
            }
            f.v = at.len() as f64;
            f.n = Some(at.len());
            f.reads = at.iter().map(|r| r.src.clone()).collect();
        }
        // how many pairs of the listed codes of two dimensions (`by`, `codes`: each the first's code with the second's) the
        // selected rows hold no row of at `time`, each pair named in `who` as <a>><b>; no row is read, so none is in `reads`
        "unrowed" => {
            let time = word(key, &q["time"], "time")?;
            let words = |v: &Value, what: &str| -> Result<Vec<String>, String> {
                v.as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .filter(|w| Some(w.len()) == v.as_array().map(Vec::len))
                    .ok_or_else(|| format!("{key}: unrowed has no list of words as {what}"))
            };
            let by = words(&q["by"], "by")?;
            let codes = q["codes"]
                .as_array()
                .ok_or_else(|| format!("{key}: unrowed has no lists as codes"))?;
            let ([a, b], [ca, cb]) = (by.as_slice(), codes.as_slice()) else {
                return Err(format!(
                    "{key}: unrowed takes two dimensions and a code list for each"
                ));
            };
            let (ca, cb) = (words(ca, "codes")?, words(cb, "codes")?);
            let held = |x: &str, y: &str| {
                picked.iter().any(|r| {
                    r.time == time
                        && r.dims.get(a).map(String::as_str) == Some(x)
                        && r.dims.get(b).map(String::as_str) == Some(y)
                })
            };
            let who: Vec<String> = ca
                .iter()
                .flat_map(|x| cb.iter().map(move |y| (x, y)))
                .filter(|(x, y)| !held(x, y))
                .map(|(x, y)| format!("{x}>{y}"))
                .collect();
            if who.is_empty() {
                return Err(format!(
                    "{key}: unrowed finds a row of every pair at {time}"
                ));
            }
            f.v = who.len() as f64;
            f.n = Some(who.len());
            f.who = who;
        }
        // how many pairs of two dimensions (`by`) the registry leaves out (`pairs`, each [<code of the first>, <code of the
        // second>]), each named in `who` as <a>><b>; refused when the selected rows hold a row of one at `time` (the data
        // would contradict the registry) or when it names none
        "excluded" => {
            let time = word(key, &q["time"], "time")?;
            let by: Vec<&str> = q["by"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let [a, b] = by.as_slice() else {
                return Err(format!("{key}: excluded takes two dimensions as by"));
            };
            let mut who = Vec::new();
            for pair in q["pairs"].as_array().into_iter().flatten() {
                let (Some(x), Some(y)) = (pair[0].as_str(), pair[1].as_str()) else {
                    return Err(format!(
                        "{key}: excluded has a pair that is no two codes: {pair}"
                    ));
                };
                let at = |r: &&&Row| {
                    r.time == time
                        && r.dims.get(*a).map(String::as_str) == Some(x)
                        && r.dims.get(*b).map(String::as_str) == Some(y)
                };
                if let Some(r) = picked.iter().find(at) {
                    return Err(format!(
                        "{key}: the registry leaves {x}>{y} out, and the row {} holds it",
                        r.src
                    ));
                }
                who.push(format!("{x}>{y}"));
            }
            if who.is_empty() {
                return Err(format!("{key}: excluded names no pair"));
            }
            f.v = who.len() as f64;
            f.n = Some(who.len());
            f.who = who;
        }
        // how many codes of `by` the selected rows hold at `time`: the places a chart draws, counted from its own rows
        "n" => {
            let time = word(key, &q["time"], "time")?;
            let by = word(key, &q["by"], "by")?;
            let mut codes: Vec<&String> = Vec::new();
            for r in picked.into_iter().filter(|r| r.time == time) {
                let code = r
                    .dims
                    .get(&by)
                    .ok_or_else(|| format!("{key}: the row {} has no {by}", r.src))?;
                if !codes.contains(&code) {
                    codes.push(code);
                }
                f.reads.push(r.src.clone());
            }
            if codes.is_empty() {
                return Err(format!("{key}: n has no row at {time}"));
            }
            f.v = codes.len() as f64;
            f.n = Some(codes.len());
        }
        // where `code` stands among the codes of `by` the selected rows hold at `time`, highest first: 1 and the number of
        // codes whose value there is above its own (a tie shares the place); refused when no row holds it
        "position" => {
            let time = word(key, &q["time"], "time")?;
            let by = word(key, &q["by"], "by")?;
            let code = word(key, &q["code"], "code")?;
            let mut at: Vec<(&String, f64)> = Vec::new();
            for r in picked.into_iter().filter(|r| r.time == time) {
                let c = r
                    .dims
                    .get(&by)
                    .ok_or_else(|| format!("{key}: the row {} has no {by}", r.src))?;
                let v = finite(key, r)?;
                match at.iter_mut().find(|(k, _)| *k == c) {
                    Some((_, s)) => *s += v,
                    None => at.push((c, 0.0 + v)),
                }
                f.reads.push(r.src.clone());
            }
            let own = at
                .iter()
                .find(|(c, _)| **c == code)
                .map(|(_, v)| *v)
                .ok_or_else(|| format!("{key}: position has no row of {code} at {time}"))?;
            f.v = (1 + at.iter().filter(|(_, v)| *v > own).count()) as f64;
            f.n = Some(at.len());
        }
        "value" => {
            let time = word(key, &q["time"], "time")?;
            let mut at: Vec<&Row> = picked.into_iter().filter(|r| r.time == time).collect();
            if let Some(dim) = q["not_eu"].as_str() {
                let members = members(key, spec)?;
                let mut kept = Vec::new();
                for r in at {
                    let code = r
                        .dims
                        .get(dim)
                        .ok_or_else(|| format!("{key}: the row {} has no {dim}", r.src))?;
                    if !members.contains(code) && code != TOTAL_CODE {
                        kept.push(r);
                    }
                }
                at = kept;
            }
            if at.is_empty() {
                return Err(format!("{key}: value has no row at {time}"));
            }
            f.v = sum(key, &at)?;
            f.reads = at.iter().map(|r| r.src.clone()).collect();
        }
        _ => return Err(format!("{key}: {op} is not an op")),
    }
    Ok(f)
}

/// The year of a fact that reads one period: its query's `time` as four digits. A fact with no such time has no year, so
/// a rate over it is refused, never assumed.
fn year_of(key: &str, k: &str, queries: &BTreeMap<&str, &Value>) -> Result<i32, String> {
    let q = queries
        .get(k)
        .ok_or_else(|| format!("{key}: {k} is not a declared fact"))?;
    let t = q["time"]
        .as_str()
        .ok_or_else(|| format!("{key}: {k} reads no one time, so it has no year"))?;
    if t.len() != 4 || !t.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{key}: the time of {k} ({t}) is not a year"));
    }
    t.parse::<i32>()
        .map_err(|_| format!("{key}: the time of {k} ({t}) is not a year"))
}

/// Facts over years (owner 11-22: a story is computed and simulated, each scenario named as one), each from facts the
/// page declares, their years from those facts' own times, never typed in:
/// - per_year: (a - b) over the years between them, a after b;
/// - cagr: (a / b) to the power 1 over those years, less 1, both above 0;
/// - line_at: `start` carried at the `rate` a year from its year to the year `at` (a straight line, a scenario);
/// - reach_year: the first whole year `start` carried at `rate` a year is at or above `target`; refused when the rate
///   is not above 0 or the year is past 2100.
///   Each names what it read in `reads`; `n` holds the years a rate or a line spans.
#[allow(clippy::too_many_arguments)]
fn of_facts_over_years(
    key: &str,
    q: &Value,
    op: &str,
    mut f: Fact,
    queries: &BTreeMap<&str, &Value>,
    spec: &Spec,
    rows: &[Row],
    done: &mut BTreeMap<String, Result<Fact, String>>,
    open: &mut BTreeSet<String>,
) -> Result<Fact, String> {
    let mut side = |s: &str| -> Result<(String, f64), String> {
        let k = q[s]
            .as_str()
            .ok_or_else(|| format!("{key}: {op} names no fact as {s}"))?;
        let other = fact(k, queries, spec, rows, done, open)
            .map_err(|e| format!("{key}: {s} {k} fails ({e})"))?;
        Ok((k.to_string(), other.v))
    };
    f.fmt = word(key, &q["fmt"], "fmt")?;
    match op {
        "per_year" | "cagr" => {
            let ((ka, a), (kb, b)) = (side("a")?, side("b")?);
            let (ya, yb) = (year_of(key, &ka, queries)?, year_of(key, &kb, queries)?);
            if ya <= yb {
                return Err(format!("{key}: {op} needs a ({ya}) after b ({yb})"));
            }
            let years = (ya - yb) as f64;
            f.v = if op == "per_year" {
                (a - b) / years
            } else {
                if a <= 0.0 || b <= 0.0 {
                    return Err(format!("{key}: cagr needs both values above 0"));
                }
                (a / b).powf(1.0 / years) - 1.0
            };
            f.n = Some((ya - yb) as usize);
            f.reads = vec![format!("{FACT_SRC}{ka}"), format!("{FACT_SRC}{kb}")];
        }
        "line_at" => {
            let ((ks, s), (kr, r)) = (side("start")?, side("rate")?);
            let ys = year_of(key, &ks, queries)?;
            let at = word(key, &q["at"], "at")?;
            let ya = at
                .parse::<i32>()
                .ok()
                .filter(|_| at.len() == 4)
                .ok_or_else(|| format!("{key}: at ({at}) is not a year"))?;
            if ya <= ys {
                return Err(format!(
                    "{key}: line_at needs at ({ya}) after the start ({ys})"
                ));
            }
            f.v = s + r * (ya - ys) as f64;
            f.n = Some((ya - ys) as usize);
            f.t = Some(at);
            f.reads = vec![format!("{FACT_SRC}{ks}"), format!("{FACT_SRC}{kr}")];
        }
        _ => {
            let ((ks, s), (kr, r), (kt, t)) = (side("start")?, side("rate")?, side("target")?);
            let ys = year_of(key, &ks, queries)?;
            let k = if s >= t {
                0
            } else if r > 0.0 {
                let q = (t - s) / r;
                // checked before the cast, so a huge quotient cannot wrap past the limit
                if !q.is_finite() || q > (2100 - ys) as f64 {
                    return Err(format!("{key}: the target is reached only past 2100"));
                }
                // a quotient a float puts a hair over a whole number (0.3 / 0.1) is that number; exact_values works the
                // year out again from the exact values and its year wins
                let whole = q.round();
                (if (q - whole).abs() <= 1e-9 * whole.abs().max(1.0) {
                    whole
                } else {
                    q.ceil()
                }) as i64
            } else {
                return Err(format!(
                    "{key}: at a rate of {r} a year the start never reaches the target"
                ));
            };
            let y = ys as i64 + k;
            if y > 2100 {
                return Err(format!(
                    "{key}: the target is reached only in {y}, past 2100"
                ));
            }
            f.v = y as f64;
            f.n = Some(k as usize);
            f.reads = vec![
                format!("{FACT_SRC}{ks}"),
                format!("{FACT_SRC}{kr}"),
                format!("{FACT_SRC}{kt}"),
            ];
        }
    }
    Ok(f)
}

/// Each period's total over rows, in time order (a period's string order is its time order: years, YYYY-MM, YYYY-S1).
fn period_totals(key: &str, picked: &[&Row]) -> Result<Vec<(String, f64)>, String> {
    let mut ser: BTreeMap<String, f64> = BTreeMap::new();
    for r in picked {
        *ser.entry(r.time.clone()).or_insert(0.0) += finite(key, r)?;
    }
    Ok(ser.into_iter().collect())
}

/// Facts over the periods of rows (owner 11-22), each read back from the rows it names:
/// - step_max: the largest rise from one period to the next within `from`..`to` (years only when one apart); `t` is the
///   later period;
/// - first_above: the first period within `from`..`to` where the rows of query `a` total more than those of query `b`
///   (each a table and filter); `v` is a's total there; refused when no period has both or a never passes b;
/// - spread: the population standard deviation of the members' values (codes of `by`) at `time`, every member read;
/// - group_change: the members ranked by value at `from` (highest first), the `part` ("top" or "bottom") `k` of them,
///   and the mean of each one's value at `to` less its value at `from`; `who` names them.
fn over_periods(
    key: &str,
    q: &Value,
    op: &str,
    mut f: Fact,
    spec: &Spec,
    rows: &[Row],
) -> Result<Fact, String> {
    f.fmt = word(key, &q["fmt"], "fmt")?;
    let window = |ser: Vec<(String, f64)>| -> Result<Vec<(String, f64)>, String> {
        let from = match &q["from"] {
            Value::Null => String::new(),
            v => word(key, v, "from")?,
        };
        let to = match &q["to"] {
            Value::Null => None,
            v => Some(word(key, v, "to")?),
        };
        Ok(ser
            .into_iter()
            .filter(|(t, _)| *t >= from && to.as_ref().is_none_or(|to| t <= to))
            .collect())
    };
    match op {
        "step_max" => {
            let picked = select(key, rows, q)?;
            let ser = window(period_totals(key, &picked)?)?;
            // a step is one period to the next (a year, YYYY-MM, YYYY-Qn, YYYY-Sn): a gap in the rows is no step, and a
            // period written any other way is no step either (review 11-22)
            let next_year = |a: &str, b: &str| {
                let parts = |p: &str| -> Option<(i32, char, i32)> {
                    let y = p.get(0..4)?.parse::<i32>().ok()?;
                    match p.len() {
                        4 => Some((y, 'Y', 0)),
                        7 if &p[4..5] == "-" && p[5..].bytes().all(|b| b.is_ascii_digit()) => {
                            Some((y, 'M', p[5..].parse().ok()?))
                        }
                        7 if &p[4..6] == "-Q" => Some((y, 'Q', p[6..].parse().ok()?)),
                        7 if &p[4..6] == "-S" => Some((y, 'S', p[6..].parse().ok()?)),
                        _ => None,
                    }
                };
                let per = |c: char| match c {
                    'Y' => 1,
                    'M' => 12,
                    'Q' => 4,
                    _ => 2,
                };
                match (parts(a), parts(b)) {
                    (Some((ya, ca, pa)), Some((yb, cb, pb))) if ca == cb => {
                        let n = per(ca);
                        let ia = ya * n + if ca == 'Y' { 0 } else { pa - 1 };
                        let ib = yb * n + if cb == 'Y' { 0 } else { pb - 1 };
                        ib == ia + 1
                    }
                    _ => false,
                }
            };
            let best = ser
                .windows(2)
                .filter(|w| next_year(&w[0].0, &w[1].0))
                .map(|w| (w[1].0.clone(), w[0].0.clone(), w[1].1 - w[0].1))
                .fold(None::<(String, String, f64)>, |b, s| match b {
                    Some(b) if b.2 >= s.2 => Some(b),
                    _ => Some(s),
                })
                .ok_or_else(|| format!("{key}: step_max needs two periods"))?;
            f.v = best.2;
            f.reads = picked
                .iter()
                .filter(|r| r.time == best.0 || r.time == best.1)
                .map(|r| r.src.clone())
                .collect();
            f.t = Some(best.0);
        }
        "first_above" => {
            let (qa, qb) = (&q["a"], &q["b"]);
            let (pa, pb) = (select(key, rows, qa)?, select(key, rows, qb)?);
            let sa = window(period_totals(key, &pa)?)?;
            let sb: BTreeMap<String, f64> = period_totals(key, &pb)?.into_iter().collect();
            let hit = sa
                .iter()
                .find(|(t, v)| sb.get(t).is_some_and(|w| v > w))
                .cloned()
                .ok_or_else(|| format!("{key}: a never totals more than b in the window"))?;
            f.v = hit.1;
            f.reads = pa
                .iter()
                .chain(pb.iter())
                .filter(|r| r.time == hit.0)
                .map(|r| r.src.clone())
                .collect();
            f.t = Some(hit.0);
        }
        "spread" | "group_change" => {
            let members = members(key, spec)?;
            let by = word(key, &q["by"], "by")?;
            let picked = select(key, rows, q)?;
            let at =
                |time: &str, reads: &mut Vec<String>| -> Result<BTreeMap<String, f64>, String> {
                    let mut m = BTreeMap::new();
                    for r in picked.iter().filter(|r| r.time == time) {
                        let code = r
                            .dims
                            .get(&by)
                            .ok_or_else(|| format!("{key}: the row {} has no {by}", r.src))?;
                        if members.contains(code) {
                            *m.entry(code.clone()).or_insert(0.0) += finite(key, r)?;
                            reads.push(r.src.clone());
                        }
                    }
                    let gone: Vec<&str> = members
                        .iter()
                        .filter(|g| !m.contains_key(*g))
                        .map(String::as_str)
                        .collect();
                    if gone.is_empty() {
                        Ok(m)
                    } else {
                        Err(format!("{key}: no row at {time} for {}", gone.join(", ")))
                    }
                };
            if op == "spread" {
                let time = word(key, &q["time"], "time")?;
                let m = at(&time, &mut f.reads)?;
                let n = m.len() as f64;
                let mean = m.values().sum::<f64>() / n;
                f.v = (m.values().map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt();
                f.n = Some(m.len());
            } else {
                let (from, to) = (word(key, &q["from"], "from")?, word(key, &q["to"], "to")?);
                let part = word(key, &q["part"], "part")?;
                let k = q["k"].as_u64().filter(|k| *k > 0).ok_or_else(|| {
                    format!("{key}: group_change has no whole number above 0 as k")
                })? as usize;
                let (a, b) = (at(&from, &mut f.reads)?, at(&to, &mut f.reads)?);
                if k > a.len() {
                    return Err(format!(
                        "{key}: k ({k}) is more than the {} members",
                        a.len()
                    ));
                }
                // highest first; a tie keeps code order (BTreeMap order), stable
                let mut ranked: Vec<(&String, f64)> = a.iter().map(|(c, v)| (c, *v)).collect();
                ranked.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
                let group: Vec<&String> = match part.as_str() {
                    "top" => ranked.iter().take(k).map(|(c, _)| *c).collect(),
                    "bottom" => ranked.iter().rev().take(k).map(|(c, _)| *c).collect(),
                    _ => return Err(format!("{key}: part ({part}) is not top or bottom")),
                };
                f.v = group.iter().map(|c| b[*c] - a[*c]).sum::<f64>() / k as f64;
                f.n = Some(k);
                let mut who: Vec<String> = group.into_iter().cloned().collect();
                who.sort();
                f.who = who;
            }
        }
        _ => return Err(format!("{key}: {op} is not an op")),
    }
    Ok(f)
}

/// A family member's format: the family's `fmt_each.<code>` when it names one (a printed difference's operand printed with
/// one decimal more, next_tree_gen printed_raise), else the family's own.
/// A value as a format of `scale` and `dec` decimals prints it, read back in the value's own unit (0.5678 at 100, 2: 0.57).
pub(crate) fn printed_value(x: f64, scale: f64, dec: usize) -> Option<f64> {
    if !x.is_finite() || scale == 0.0 {
        return None;
    }
    format!("{:.dec$}", x * scale)
        .parse::<f64>()
        .ok()
        .map(|p| p / scale)
}

fn member_fmt(q: &Value, code: &str, fmt: &str) -> String {
    q["fmt_each"][code].as_str().unwrap_or(fmt).to_string()
}

/// A family: one value fact per code of its `each` dimension among the rows at its time (that code's one row there),
/// keyed `<family>.<code>`, in the order the codes first appear. With `not_eu` (a dimension) the member codes and the
/// aggregate of that dimension are left out, as a value's are. Err for an op other than value, a row set with no row,
/// or a code with more than one row at that time (the filter must leave one row per code: a sum would not be the
/// line the leaf draws).
fn family(key: &str, q: &Value, spec: &Spec, rows: &[Row]) -> Result<Vec<Fact>, String> {
    if !q["op"].is_null() && q["op"].as_str() != Some("value") {
        return Err(format!("{key}: a family (each) takes op value"));
    }
    let each = word(key, &q["each"], "each")?;
    let time = word(key, &q["time"], "time")?;
    let fmt = word(key, &q["fmt"], "fmt")?;
    let outside = match &q["not_eu"] {
        Value::Null => None,
        v => Some((word(key, v, "not_eu")?, members(key, spec)?)),
    };
    let mut by: Vec<(String, Vec<&Row>)> = Vec::new();
    for r in select(key, rows, q)?.into_iter().filter(|r| r.time == time) {
        let code = r
            .dims
            .get(&each)
            .ok_or_else(|| format!("{key}: the row {} has no {each}", r.src))?;
        if let Some((dim, members)) = &outside {
            let c = r
                .dims
                .get(dim)
                .ok_or_else(|| format!("{key}: the row {} has no {dim}", r.src))?;
            if members.contains(c) || c == TOTAL_CODE {
                continue;
            }
        }
        if let Some((_, rs)) = by.iter().find(|(c, _)| c == code) {
            return Err(format!(
                "{key}: the code {code} has more than one row at {time} ({}, {}); filter to one row per code",
                rs[0].src, r.src
            ));
        }
        by.push((code.clone(), vec![r]));
    }
    if by.is_empty() {
        return Err(format!("{key}: the family has no row at {time}"));
    }
    by.into_iter()
        .map(|(code, rs)| {
            Ok(Fact {
                key: format!("{key}.{code}"),
                op: "value".to_string(),
                v: sum(key, &rs)?,
                t: None,
                n: None,
                who: Vec::new(),
                fmt: member_fmt(q, &code, &fmt),
                reads: rs.iter().map(|r| r.src.clone()).collect(),
                exact: None,
            })
        })
        .collect()
}

/// A family of differences: per code of its `each` dimension, family `a`'s member less family `b`'s (`{"op": "minus",
/// "each": dim, "a": family, "b": family, "fmt": format}`), keyed `<family>.<code>` in `a`'s order, each reading
/// `fact:<a>.<code>` and `fact:<b>.<code>`. Err when `a` or `b` is no declared value family over the same dimension, either
/// fails, or a code of either has no member in the other: no code is left out and no value guessed.
fn minus_family(
    key: &str,
    q: &Value,
    queries: &BTreeMap<&str, &Value>,
    spec: &Spec,
    rows: &[Row],
) -> Result<Vec<Fact>, String> {
    let each = word(key, &q["each"], "each")?;
    let fmt = word(key, &q["fmt"], "fmt")?;
    let side = |s: &str| -> Result<(String, Vec<(String, f64)>), String> {
        let k = word(key, &q[s], s)?;
        let of = queries
            .get(k.as_str())
            .filter(|of| of["each"].as_str() == Some(each.as_str()))
            .ok_or_else(|| format!("{key}: minus names no family over {each} as {s} ({k})"))?;
        let members =
            family(&k, of, spec, rows).map_err(|e| format!("{key}: {s} {k} fails ({e})"))?;
        // a member's key is <family>.<code>
        let codes = members
            .into_iter()
            .map(|f| (f.key[k.len() + 1..].to_string(), f.v))
            .collect();
        Ok((k, codes))
    };
    let ((a, of_a), (b, of_b)) = (side("a")?, side("b")?);
    if let Some((code, _)) = of_b.iter().find(|(c, _)| !of_a.iter().any(|(k, _)| k == c)) {
        return Err(format!("{key}: {b} has {code}, {a} has not"));
    }
    of_a.into_iter()
        .map(|(code, va)| {
            let vb = of_b
                .iter()
                .find(|(c, _)| *c == code)
                .map(|(_, v)| *v)
                .ok_or_else(|| format!("{key}: {a} has {code}, {b} has not"))?;
            Ok(Fact {
                key: format!("{key}.{code}"),
                op: "minus".to_string(),
                v: va - vb,
                t: None,
                n: None,
                who: Vec::new(),
                fmt: member_fmt(q, &code, &fmt),
                reads: vec![
                    format!("{FACT_SRC}{a}.{code}"),
                    format!("{FACT_SRC}{b}.{code}"),
                ],
                exact: None,
            })
        })
        .collect()
}

/// The rows of a query's table that its filter keeps (a dimension and one code, or a list of codes), in request order.
fn select<'r>(key: &str, rows: &'r [Row], q: &Value) -> Result<Vec<&'r Row>, String> {
    let table = word(key, &q["table"], "table")?;
    let mut want: Vec<(&str, Vec<&str>)> = Vec::new();
    if let Some(filter) = q.get("filter") {
        let filter = filter
            .as_object()
            .ok_or_else(|| format!("{key}: filter is not a map of dimensions"))?;
        for (dim, codes) in filter {
            let codes = match codes {
                Value::String(c) => vec![c.as_str()],
                Value::Array(a) => a
                    .iter()
                    .map(Value::as_str)
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| format!("{key}: the codes of {dim} are not words"))?,
                _ => return Err(format!("{key}: the codes of {dim} are not words")),
            };
            want.push((dim, codes));
        }
    }
    let mut out = Vec::new();
    for r in rows.iter().filter(|r| r.table == table) {
        let mut keep = true;
        for (dim, codes) in &want {
            let code = r
                .dims
                .get(*dim)
                .ok_or_else(|| format!("{key}: the row {} has no {dim}", r.src))?;
            keep &= codes.contains(&code.as_str());
        }
        if keep {
            out.push(r);
        }
    }
    Ok(out)
}

fn word(key: &str, v: &Value, field: &str) -> Result<String, String> {
    v.as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{key}: {field} is not a word"))
}

fn members<'s>(key: &str, spec: &'s Spec) -> Result<&'s [String], String> {
    spec.members
        .as_deref()
        .ok_or_else(|| format!("{key}: needs the member list, which the spec does not hold"))
}

fn finite(key: &str, r: &Row) -> Result<f64, String> {
    if r.value.is_finite() {
        Ok(r.value)
    } else {
        Err(format!("{key}: the row {} holds no number", r.src))
    }
}

/// A total added in row order from 0, as Python's sum does.
fn sum(key: &str, rows: &[&Row]) -> Result<f64, String> {
    rows.iter().try_fold(0.0, |s, r| Ok(s + finite(key, r)?))
}

/// A fact's text: `pct` a whole percent of its size (unless `bare`, with "%"), `n` a whole number, `x` one decimal, any other format its `scale`,
/// `dec` places with a comma between thousands and (unless `bare`) its `suffix`. Err for a format the spec does not hold.
pub fn text(f: &Fact, fmts: &Value, bare: bool) -> Result<String, String> {
    Ok(match f.fmt.as_str() {
        "pct" => {
            let s = match f
                .exact
                .and_then(|e| e.abs().mul(Exact::int(100)))
                .and_then(|e| fixed_exact(e, 0, false))
            {
                Some(s) => s,
                None => fixed(f.v.abs() * 100.0, 0, false),
            };
            if bare {
                s
            } else {
                s + "%"
            }
        }
        "n" => rounded(f, 1.0, 0, false),
        "x" => rounded(f, 1.0, 1, false),
        k => {
            let m = scaled(f, fmts, k)?;
            let s = rounded(f, m.0, m.1, true);
            if bare {
                s
            } else {
                s + &m.2
            }
        }
    })
}

/// A format's scale, places and suffix; Err when the spec does not hold it.
fn scaled(f: &Fact, fmts: &Value, k: &str) -> Result<(f64, usize, String), String> {
    let m = fmts
        .get(k)
        .filter(|m| m.is_object())
        .ok_or_else(|| format!("{}: the format {k} is not in the spec", f.key))?;
    Ok((
        m.get("scale").and_then(Value::as_f64).unwrap_or(1.0),
        m.get("dec").and_then(Value::as_u64).unwrap_or(0) as usize,
        m.get("suffix")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    ))
}

/// A number with `dec` places, rounded on its exact decimal expansion with a tie to the even digit, a minus on a negative
/// value unless it rounds to 0, and a comma between thousands when `sep`: what Python's `f"{x:,.{dec}f}"` prints, but for the
/// minus of a value that rounds to 0 (a printed "-0.0" says a sign no reader can use).
fn fixed(x: f64, dec: usize, sep: bool) -> String {
    // an f64 has at most 1074 binary places, so 1100 decimal places print it exactly
    let exact = format!("{:.1100}", x.abs());
    let (whole, places) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(places.bytes().take(dec))
        .map(|b| b - b'0')
        .collect();
    let rest = places.as_bytes().get(dec..).unwrap_or_default();
    let up = match rest.first() {
        Some(b'6'..=b'9') => true,
        Some(b'5') => {
            rest[1..].iter().any(|b| *b != b'0') || digits.last().is_some_and(|d| d % 2 == 1)
        }
        _ => false,
    };
    if up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let sign = if x.is_sign_negative() && digits.iter().any(|d| *d != 0) {
        "-"
    } else {
        ""
    };
    let cut = digits.len() - dec;
    let mut int: String = digits[..cut].iter().map(|d| char::from(b'0' + d)).collect();
    if sep {
        let mut grouped = String::new();
        for (i, c) in int.chars().enumerate() {
            if i > 0 && (int.len() - i).is_multiple_of(3) {
                grouped.push(',');
            }
            grouped.push(c);
        }
        int = grouped;
    }
    let frac: String = digits[cut..].iter().map(|d| char::from(b'0' + d)).collect();
    if dec == 0 {
        format!("{sign}{int}")
    } else {
        format!("{sign}{int}.{frac}")
    }
}

/// The words of a half year, the first and the second, as a page prints them inside "{y} 年{h}半年" (the leaves' word table
/// runtime/leaves_py/words.zh.json, half.1 and half.2, holds the same): a half is printed as a ledger entry like a month's
/// number, so the page check reads which half it names.
pub const HALF_WORDS: [&str; 2] = ["上", "下"];

/// A period as the page names it: `2022-S1` the first half of 2022, `2022-03` its third month, `2022` the year.
pub fn tlabel(t: &str) -> Result<String, String> {
    if let Some((y, h)) = t.split_once("-S") {
        return match h {
            "1" => Ok(format!("{y} 年上半年")),
            "2" => Ok(format!("{y} 年下半年")),
            _ => Err(format!("the period {t:?} is no half year")),
        };
    }
    if let Some((y, m)) = t.split_once('-') {
        let m: u32 = m
            .parse()
            .map_err(|_| format!("the period {t:?} is no month"))?;
        return Ok(format!("{y} 年 {m} 月"));
    }
    Ok(format!("{t} 年"))
}

/// One of a fact's ledger entries as a number of the page: its text, its bare number, its period (with the spec's time
/// prefix) or one part of the period. Err when the format is not in the spec, the fact has no period, or the period has
/// no such part (a year has no month, a month no half).
pub fn num(f: &Fact, fmts: &Value, part: Part) -> Result<Num, String> {
    let src = |tail: &str| format!("{FACT_SRC}{}{tail}", f.key);
    Ok(match part {
        Part::Text => Num {
            src: src(""),
            value: f.v,
            text: text(f, fmts, false)?,
        },
        Part::Bare => Num {
            src: src(".n"),
            value: f.v,
            text: text(f, fmts, true)?,
        },
        Part::Period => {
            let t =
                f.t.as_deref()
                    .ok_or_else(|| format!("{}: the fact has no period", f.key))?;
            let prefix = fmts["time"]["prefix"].as_str().unwrap_or_default();
            Num {
                src: src(".t"),
                value: t.get(..4).and_then(|y| y.parse().ok()).unwrap_or(f64::NAN),
                text: format!("{prefix}{}", tlabel(t)?),
            }
        }
        Part::Year | Part::Month | Part::Half => {
            let t =
                f.t.as_deref()
                    .ok_or_else(|| format!("{}: the fact has no period", f.key))?;
            let (tail, piece) = match (part, t.split_once('-')) {
                (Part::Year, _) => ("y", Some(t.split('-').next().unwrap_or(t))),
                (Part::Half, Some((_, h))) => ("h", h.strip_prefix('S')),
                (Part::Month, Some((_, m))) if !m.starts_with('S') => ("m", Some(m)),
                _ => ("", None),
            };
            let v: u32 = piece
                .and_then(|p| p.parse().ok())
                .filter(|v| part != Part::Half || (1..=2).contains(v))
                .ok_or_else(|| format!("{}: the period {t:?} has no such part", f.key))?;
            Num {
                src: src(&format!(".t.{tail}")),
                value: f64::from(v),
                text: if part == Part::Half {
                    HALF_WORDS[v as usize - 1].to_string()
                } else {
                    v.to_string()
                },
            }
        }
    })
}

/// A value fact's display part (`fact:<key>.r`): its number alone at the places three significant digits need (a whole
/// number from 100 up), never more than its format's, with a comma between thousands; None when that is its format's own
/// places (the page prints `.n`) or it is no value fact in a scaled format. Err for a format the spec does not hold.
pub fn display(f: &Fact, fmts: &Value) -> Result<Option<Num>, String> {
    if f.op != "value" || matches!(f.fmt.as_str(), "pct" | "n" | "x") {
        return Ok(None);
    }
    let (scale, dec, _) = scaled(f, fmts, &f.fmt)?;
    let x = f.v * scale;
    if !x.is_finite() {
        return Ok(None);
    }
    let whole = if x.abs() >= 1.0 {
        fixed(x.abs().trunc(), 0, false).len()
    } else {
        0
    };
    let places = dec.min(3usize.saturating_sub(whole));
    Ok((places < dec).then(|| Num {
        src: format!("{FACT_SRC}{}.r", f.key),
        value: f.v,
        text: rounded(f, scale, places, true),
    }))
}

/// The ticks of an axis from 0 to a fact (0 left out), in the fact's format without its unit: steps of 1, 2, 5 or 10
/// times a power of ten in the printed unit, the largest that gives at least `MIN_TICKS` ticks up to the top, and never
/// finer than the format's last printed place (with `dec` 0 a top of 2 gets 1, 2, not 0.5, 1, 1.5, 2 printed as 0, 1, 2,
/// 2; only that floor leaves fewer than `MIN_TICKS`). Err for a
/// fact that is not above 0 or not in a scaled format, an axis shorter than one printed place, or a tick whose text
/// does not read back as its value.
pub fn ticks(f: &Fact, fmts: &Value) -> Result<Vec<Num>, String> {
    let (scale, dec, _) = scaled(f, fmts, &f.fmt)?;
    let top = f.v * scale;
    if !(top.is_finite() && top > 0.0) {
        return Err(format!("{}: an axis needs a fact above 0", f.key));
    }
    let place = 10f64.powi(-(dec as i32));
    // mag <= target < 10 * mag, so 1 * mag always fits; a step within float noise of the target fits too
    let target = top / MIN_TICKS;
    let mag = 10f64.powf(target.log10().floor());
    let step = [5.0, 2.0, 1.0]
        .into_iter()
        .map(|m| m * mag)
        .find(|s| *s <= target * (1.0 + 1e-9))
        .unwrap_or(mag)
        .max(place);
    let out: Vec<Num> = (1..)
        .map(|i| (i, i as f64 * step))
        // 3 * 0.1 is a hair above 0.3: a tick within float noise of the top is the top
        .take_while(|(_, v)| *v <= top * (1.0 + 1e-9))
        .map(|(i, v)| Num {
            src: format!("{FACT_SRC}{}.tick{i}", f.key),
            value: v / scale,
            text: fixed(v, dec, true),
        })
        .collect();
    if out.is_empty() {
        return Err(format!(
            "{}: the axis is shorter than one printed place ({place})",
            f.key
        ));
    }
    match out.iter().find(|n| !reads_back(&n.text, n.value * scale)) {
        Some(n) => Err(format!("{}: {} prints {:?}", f.key, n.src, n.text)),
        None => Ok(out),
    }
}

/// The years a table's rows cover, one ledger entry each (`period:<table>:<year>`, its text the year), in the order they
/// first appear: what a calendar writes along its track. A period that does not start with a four-digit year is left out.
pub fn periods(table: &str, rows: &[Row]) -> Vec<Num> {
    let mut out: Vec<Num> = Vec::new();
    for r in rows.iter().filter(|r| r.table == table) {
        let Some(y) = r
            .time
            .get(..4)
            .filter(|y| y.bytes().all(|b| b.is_ascii_digit()))
        else {
            continue;
        };
        let src = format!("{PERIOD_SRC}{table}:{y}");
        if !out.iter().any(|n| n.src == src) {
            out.push(Num {
                src,
                value: y.parse().unwrap_or(f64::NAN),
                text: y.to_string(),
            });
        }
    }
    out
}

/// The months a table's rows cover, two ledger entries each from one key (`period:<table>:<YYYY-MM>.y` and `.m`, the year
/// and the month as whole numbers, no leading zero), in the order they first appear. A period that is no month is left
/// out.
pub fn months(table: &str, rows: &[Row]) -> Vec<Num> {
    let mut out: Vec<Num> = Vec::new();
    for r in rows.iter().filter(|r| r.table == table) {
        let t = r.time.as_str();
        let ok = t.len() == 7
            && t.bytes().enumerate().all(|(i, c)| match i {
                4 => c == b'-',
                _ => c.is_ascii_digit(),
            });
        let (Some(y), Some(m)) = (
            t.get(..4)
                .filter(|_| ok)
                .and_then(|y| y.parse::<u32>().ok()),
            t.get(5..)
                .filter(|_| ok)
                .and_then(|m| m.parse::<u32>().ok()),
        ) else {
            continue;
        };
        if !(1..=12).contains(&m)
            || out
                .iter()
                .any(|n| n.src == format!("{PERIOD_SRC}{table}:{t}.y"))
        {
            continue;
        }
        for (tail, v) in [("y", y), ("m", m)] {
            out.push(Num {
                src: format!("{PERIOD_SRC}{table}:{t}.{tail}"),
                value: f64::from(v),
                text: v.to_string(),
            });
        }
    }
    out
}

/// The half years a table's rows cover, two ledger entries each from one key (`period:<table>:<YYYY-Sn>.y` and `.h`, the
/// year as a whole number and the half as its word, HALF_WORDS), in the order they first appear. A period that is no half
/// year (YYYY-S1, YYYY-S2) is left out.
pub fn halves(table: &str, rows: &[Row]) -> Vec<Num> {
    let mut out: Vec<Num> = Vec::new();
    for r in rows.iter().filter(|r| r.table == table) {
        let t = r.time.as_str();
        let (Some(y), Some(h)) = (
            t.get(..4)
                .filter(|y| y.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|y| y.parse::<u32>().ok()),
            match t.get(4..) {
                Some("-S1") => Some(1usize),
                Some("-S2") => Some(2),
                _ => None,
            },
        ) else {
            continue;
        };
        if out
            .iter()
            .any(|n| n.src == format!("{PERIOD_SRC}{table}:{t}.y"))
        {
            continue;
        }
        out.push(Num {
            src: format!("{PERIOD_SRC}{table}:{t}.y"),
            value: f64::from(y),
            text: y.to_string(),
        });
        out.push(Num {
            src: format!("{PERIOD_SRC}{table}:{t}.h"),
            value: h as f64,
            text: HALF_WORDS[h - 1].to_string(),
        });
    }
    out
}

/// A sourced record's date cell as three ledger entries, `<row src>:<column>.y`, `.m` and `.d`: the year, the month and
/// the day as whole numbers (no leading zero), for a page that writes the date in words around them. Err when the row
/// has no such column or the cell is no date (YYYY-MM-DD).
pub fn date_parts(row: &Row, column: &str) -> Result<[Num; 3], String> {
    let cell = row
        .dims
        .get(column)
        .ok_or_else(|| format!("{}: the record has no {column}", row.src))?;
    let no_date = || format!("{}:{column}: {cell:?} is no date", row.src);
    // every byte checked before any slice, so a cell of other characters cannot cut one
    let ok = cell.len() == 10
        && cell.bytes().enumerate().all(|(i, c)| match i {
            4 | 7 => c == b'-',
            _ => c.is_ascii_digit(),
        });
    if !ok {
        return Err(no_date());
    }
    let part = |at: std::ops::Range<usize>, tail: &str| -> Result<Num, String> {
        let v: u32 = cell[at].parse().map_err(|_| no_date())?;
        Ok(Num {
            src: format!("{}:{column}.{tail}", row.src),
            value: f64::from(v),
            text: v.to_string(),
        })
    };
    Ok([part(0..4, "y")?, part(5..7, "m")?, part(8..10, "d")?])
}

/// The year a value fact (op value, no period of its own) reads at: the four-digit year every row it reads holds, None when
/// it reads none, the rows hold two years, or a time that is no year.
fn value_year(f: &Fact, rows: &[Row]) -> Option<String> {
    if f.op != "value" || f.reads.is_empty() {
        return None;
    }
    let years: BTreeSet<&str> = rows
        .iter()
        .filter(|r| f.reads.contains(&r.src))
        .map(|r| r.time.get(..4).unwrap_or(""))
        .collect();
    let read = rows.iter().filter(|r| f.reads.contains(&r.src)).count();
    match years.into_iter().collect::<Vec<_>>()[..] {
        [y] if read == f.reads.len() && y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()) => {
            Some(y.to_string())
        }
        _ => None,
    }
}

/// Every entry a leaf may print, src to text: per fact its text, its bare number, its display part when it has one
/// (display) and its period's parts (`.t.y`, then
/// `.t.m` or `.t.h`, whichever the period has); per series table its years, months and half years; per record row its date's parts
/// when the date cell is a date, and each `RECORD_TEXT` cell whole; and the ticks of an axis running to each fact whose
/// query says `"axis": true` (ticks), the only facts a leaf draws an axis to. Err names each fact whose text, bare number
/// or axis cannot be made, and each record row whose table is not a `table_id` (one per line).
pub fn leaf_ledger(
    spec: &Spec,
    rows: &[Row],
    facts: &[Fact],
) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let mut off = Vec::new();
    for f in facts {
        for part in [Part::Text, Part::Bare] {
            match num(f, &spec.fmts, part) {
                Ok(n) => {
                    out.insert(n.src, n.text);
                }
                Err(e) => off.push(e),
            }
        }
        if let Ok(Some(n)) = display(f, &spec.fmts) {
            out.insert(n.src, n.text);
        }
        if spec
            .facts
            .iter()
            .any(|(k, q)| *k == f.key && q["axis"] == json!(true))
        {
            match ticks(f, &spec.fmts) {
                Ok(ts) => out.extend(ts.into_iter().map(|n| (n.src, n.text))),
                Err(e) => off.push(e),
            }
        }
        // each pair an unrowed fact counted
        if f.op == "unrowed" {
            for pair in &f.who {
                out.insert(format!("{NOROW_SRC}{pair}"), NOROW_TEXT.to_string());
            }
        }
        // each pair an excluded fact named
        if f.op == "excluded" {
            for pair in &f.who {
                out.insert(format!("{EXCLUDED_SRC}{pair}"), EXCLUDED_TEXT.to_string());
            }
        }
        // each row a zeros fact counted, under its series src
        if f.op == "zeros" {
            for src in &f.reads {
                let v = rows.iter().find(|r| r.src == *src).map_or(0.0, |r| r.value);
                out.insert(format!("{ZERO_SRC}{src}"), v.to_string());
            }
        }
        if f.t.is_some() {
            // a period has a year and at most one of a month or a half
            for n in [Part::Year, Part::Month, Part::Half]
                .into_iter()
                .filter_map(|p| num(f, &spec.fmts, p).ok())
            {
                out.insert(n.src, n.text);
            }
        } else if let Some(y) = value_year(f, rows) {
            // a value read at one year (op value): its year is the year of the rows it reads, one year for all of them
            out.insert(format!("fact:{}.t.y", f.key), y);
        }
    }
    // a group page's member-list year, when it is not the data year (four digits, or the request is off)
    if let Some(y) = spec.basis.as_ref().and_then(|b| b.member_year.as_ref()) {
        if y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()) {
            out.insert(BASIS_YEAR_SRC.to_string(), y.clone());
        } else {
            off.push(format!("basis: member_year {y:?} is no year"));
        }
    }
    let mut tables: Vec<&str> = Vec::new();
    for r in rows.iter().filter(|r| r.src.starts_with(SERIES_SRC)) {
        if !tables.contains(&r.table.as_str()) {
            tables.push(&r.table);
        }
    }
    off.extend(
        tables
            .iter()
            .filter(|t| !table_id(t))
            .map(|t| format!("series table {t}: its name must be a table id")),
    );
    for t in tables.into_iter().filter(|t| table_id(t)) {
        for n in periods(t, rows)
            .into_iter()
            .chain(months(t, rows))
            .chain(halves(t, rows))
        {
            out.insert(n.src, n.text);
        }
    }
    for r in rows.iter().filter(|r| r.src.starts_with(RECORD_SRC)) {
        if !table_id(&r.table) || !r.src.starts_with(&format!("{RECORD_SRC}{}/", r.table)) {
            off.push(format!(
                "{}: a record row's table must be its table id (not a path) and its src must name it",
                r.src
            ));
            continue;
        }
        for n in date_parts(r, "date").into_iter().flatten() {
            out.insert(n.src, n.text);
        }
        for c in RECORD_TEXT {
            if let Some(v) = r.dims.get(*c) {
                out.insert(format!("{}:{c}", r.src), v.clone());
            }
        }
    }
    if off.is_empty() {
        Ok(out)
    } else {
        Err(off.join("\n"))
    }
}

/// A drafted wording (a dek, a hero's unit) as segments for a leaf: `{"w": words}` (a `{key}` placeholder stays in the
/// words for the leaf to fill) and `{"src": entry}` for each date it writes. "YYYY 年 M 月" is the year and the month of
/// one month entry (`period:<t>:<YYYY-MM>.y`, `.m`); "YYYY 年" a year entry (`period:<t>:<YYYY>`); each of the first of
/// `tables` holding it in `ledger`. Err names each other digit run (or a date no table holds), with the years the
/// wording may write and an example, so it goes back to be reworded once; it is never cut or printed raw.
pub fn wording_segs(
    text: &str,
    ledger: &BTreeMap<String, String>,
    tables: &[String],
) -> Result<Vec<Value>, String> {
    let digit = |c: char| c.is_ascii_digit() || c.is_numeric();
    let chars: Vec<char> = text.chars().collect();
    let run_end = |from: usize| {
        (from..chars.len())
            .find(|&j| !digit(chars[j]))
            .unwrap_or(chars.len())
    };
    // the index just past `want`, a space allowed before it
    let after = |from: usize, want: char| {
        let j = if chars.get(from) == Some(&' ') {
            from + 1
        } else {
            from
        };
        (chars.get(j) == Some(&want)).then_some(j + 1)
    };
    let held = |key: &str| {
        tables
            .iter()
            .map(|t| format!("{PERIOD_SRC}{t}:{key}"))
            .find(|s| ledger.contains_key(s.as_str()) || ledger.contains_key(&format!("{s}.y")))
    };
    // a half-yearly or monthly main (its ledger holds a period with a '-': YYYY-Sn or YYYY-MM): a bare "YYYY 年" there
    // names no period of the page, so it is refused with the latest half or month the ledger holds as the example
    let sub = tables.first().map_or(String::new(), |t| {
        let pre = format!("{PERIOD_SRC}{t}:");
        let v = |k: &str| ledger.get(k).map_or("", String::as_str);
        ledger
            .keys()
            .filter_map(|k| {
                k.strip_prefix(&pre)
                    .filter(|r| r.contains('-'))
                    .and_then(|r| r.strip_suffix(".y"))
                    .map(|r| (k, r))
            })
            .next_back()
            .map_or(String::new(), |(k, r)| {
                let stem = &k[..k.len() - 2];
                if r.contains("-S") {
                    format!("{} 年{}半年", v(k), v(&format!("{stem}.h")))
                } else {
                    format!("{} 年 {} 月", v(k), v(&format!("{stem}.m")))
                }
            })
    });
    let mut segs = Vec::new();
    let mut words = String::new();
    let mut off = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            let end = (i + 1..chars.len())
                .find(|&j| !(chars[j].is_alphanumeric() || matches!(chars[j], '_' | '.')));
            if let Some(end) = end.filter(|&e| {
                chars[e] == '}' && (chars[i + 1].is_ascii_alphabetic() || chars[i + 1] == '_')
            }) {
                words.extend(&chars[i..=end]);
                i = end + 1;
                continue;
            }
        }
        if !digit(chars[i]) {
            words.push(chars[i]);
            i += 1;
            continue;
        }
        let end = run_end(i);
        let run: String = chars[i..end].iter().collect();
        let year = end - i == 4 && run.bytes().all(|b| b.is_ascii_digit());
        let month = after(end, '年').and_then(|j| {
            let j = if chars.get(j) == Some(&' ') { j + 1 } else { j };
            let m_end = run_end(j);
            let m: String = chars[j..m_end].iter().collect();
            let m = (1..=2)
                .contains(&m.len())
                .then(|| m.parse::<u32>().ok())
                .flatten()?;
            after(m_end, '月').map(|_| (j, m_end, m))
        });
        // "YYYY 年上半年" / "YYYY 年下半年": the year and the half of one half-year entry (`.y`, `.h`, the half's word)
        let half = after(end, '年').and_then(|j| {
            let j = if chars.get(j) == Some(&' ') { j + 1 } else { j };
            let n = match chars.get(j) {
                Some('上') => 1,
                Some('下') => 2,
                _ => return None,
            };
            (chars.get(j + 1) == Some(&'半') && chars.get(j + 2) == Some(&'年')).then_some((j, n))
        });
        let flush = |segs: &mut Vec<Value>, words: &mut String| {
            if !words.is_empty() {
                segs.push(json!({ "w": std::mem::take(words) }));
            }
        };
        match (year, month, after(end, '年')) {
            (true, None, Some(_)) if half.is_some() => {
                let (j, n) = half.unwrap();
                match held(&format!("{run}-S{n}")) {
                    Some(key) => {
                        flush(&mut segs, &mut words);
                        segs.push(json!({ "src": format!("{key}.y") }));
                        segs.push(json!({ "w": chars[end..j].iter().collect::<String>() }));
                        segs.push(json!({ "src": format!("{key}.h") }));
                        i = j + 1;
                        continue;
                    }
                    None => off.push(format!(
                        "\"{run} 年{}半年\" is a half year no table of the page holds",
                        if n == 1 { "上" } else { "下" }
                    )),
                }
            }
            (true, None, Some(_)) if !sub.is_empty() => off.push(format!(
                "\"{run} 年\" names no half year or month, and the page's main is at one (as \"{sub}\")"
            )),
            (true, Some((j, m_end, m)), _) => match held(&format!("{run}-{m:02}")) {
                Some(key) => {
                    flush(&mut segs, &mut words);
                    segs.push(json!({ "src": format!("{key}.y") }));
                    segs.push(json!({ "w": chars[end..j].iter().collect::<String>() }));
                    segs.push(json!({ "src": format!("{key}.m") }));
                    i = m_end;
                    continue;
                }
                None => off.push(format!(
                    "\"{run} 年 {m} 月\" is a month no table of the page holds"
                )),
            },
            (true, None, Some(_)) => match held(&run) {
                Some(key) => {
                    flush(&mut segs, &mut words);
                    segs.push(json!({ "src": key }));
                    i = end;
                    continue;
                }
                None => off.push(format!("\"{run} 年\" is a year no table of the page holds")),
            },
            _ => off.push(format!("the digits {run} are no year or month of the data")),
        }
        words.push_str(&run);
        i = end;
    }
    if !off.is_empty() {
        let years: Vec<&str> = tables
            .iter()
            .flat_map(|t| {
                let pre = format!("{PERIOD_SRC}{t}:");
                ledger
                    .iter()
                    .filter(move |(s, _)| s.strip_prefix(&pre).is_some_and(|k| !k.contains('-')))
                    .map(|(_, y)| y.as_str())
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let example = if sub.is_empty() {
            years
                .last()
                .map_or(String::new(), |y| format!(", as \"{y} 年\""))
        } else {
            format!(", as \"{sub}\"")
        };
        return Err(format!(
            "{text:?}: {}; a wording writes only the years of the data ({}{example}), and any other number as a {{key}} of a fact",
            off.join("; "),
            if years.is_empty() { "none".to_string() } else { years.join(", ") }
        ));
    }
    if !words.is_empty() {
        segs.push(json!({ "w": words }));
    }
    Ok(segs)
}

/// The entry a `period:` or `record:` src names, recomputed from the rows. A record src is split at its last ':' first
/// (a table's path may hold dots), then the column from its part; a `RECORD_TEXT` column is read whole.
fn read_entry(src: &str, rows: &[Row]) -> Result<Num, String> {
    if let Some(rest) = src.strip_prefix(PERIOD_SRC) {
        let (table, at) = rest
            .rsplit_once(':')
            .ok_or_else(|| "names no table and year".to_string())?;
        let what = if at.contains("-S") {
            "half year"
        } else if at.contains('-') {
            "month"
        } else {
            "year"
        };
        return periods(table, rows)
            .into_iter()
            .chain(months(table, rows))
            .chain(halves(table, rows))
            .find(|n| n.src == src)
            .ok_or_else(|| format!("no row of {table} is in that {what}"));
    }
    let (at, cell) = src
        .rsplit_once(':')
        .ok_or_else(|| "names no column".to_string())?;
    let row = rows
        .iter()
        .find(|r| r.src == at)
        .ok_or_else(|| format!("the request has no row {at}"))?;
    if RECORD_TEXT.contains(&cell) {
        return row
            .dims
            .get(cell)
            .map(|v| Num {
                src: src.to_string(),
                value: f64::NAN,
                text: v.clone(),
            })
            .ok_or_else(|| format!("{at}: the record has no {cell}"));
    }
    let (column, _) = cell
        .split_once('.')
        .ok_or_else(|| "names no part of a date".to_string())?;
    date_parts(row, column)?
        .into_iter()
        .find(|n| n.src == src)
        .ok_or_else(|| "names no part of a date (y, m, d)".to_string())
}

/// Whether a printed number (thousands commas allowed) reads back as `v`, to within float noise.
fn reads_back(text: &str, v: f64) -> bool {
    text.replace(',', "")
        .parse::<f64>()
        .is_ok_and(|x| (x - v).abs() <= 1e-9 * v.abs().max(1.0))
}

/// The names of a count's members, each a ledger label of the knowledge group's name rows. Err names the fact and each
/// code with no name row, or a name that is not read from a name row.
pub fn who(f: &Fact, names: &BTreeMap<String, Label>) -> Result<Vec<Label>, String> {
    let mut off = Vec::new();
    let mut out = Vec::new();
    for code in &f.who {
        match names.get(code) {
            Some(l) if l.src.starts_with(LABEL_SRC) => out.push(l.clone()),
            Some(l) => off.push(format!(
                "{}: the name of {code} is not read from a name row ({})",
                f.key, l.src
            )),
            None => off.push(format!("{}: {code} has no name row", f.key)),
        }
    }
    if off.is_empty() {
        Ok(out)
    } else {
        Err(off.join("\n"))
    }
}

/// A page's facts against the request: each fact recorded for the page recomputed from the rows (its op, value, period,
/// count, members and the rows it read), and each `fact:`, `period:` and `record:` entry of the page's ledger against the
/// text recomputed for it.
/// One line per difference, an entry no declared fact gives, or a fact that cannot be recomputed; empty when all agree.
pub fn recheck(
    ledger: &BTreeMap<String, String>,
    spec: &Spec,
    rows: &[Row],
    recorded: &[Fact],
) -> Vec<String> {
    let facts = match compute(spec, rows) {
        Ok(f) => f,
        Err(e) => return e.lines().map(|l| format!("cannot recompute {l}")).collect(),
    };
    let by_key: BTreeMap<&str, &Fact> = facts.iter().map(|f| (f.key.as_str(), f)).collect();
    let mut off = Vec::new();
    for r in recorded {
        match by_key.get(r.key.as_str()) {
            Some(f) if *f == r => {}
            Some(_) => off.push(format!(
                "{}: recorded as computed otherwise than from the rows",
                r.key
            )),
            None => off.push(format!("{}: recorded but not declared", r.key)),
        }
    }
    for (src, printed) in ledger.iter().filter(|(s, _)| s.starts_with(FACT_SRC)) {
        let rest = &src[FACT_SRC.len()..];
        // a family member's key holds a dot (<family>.<code>), so the part is the last dot's tail when it names one
        let (key, tail) = match rest.rsplit_once('.') {
            Some((k, t)) if ["y", "m", "h"].contains(&t) && k.ends_with(".t") => {
                (&k[..k.len() - 2], &rest[k.len() - 1..])
            }
            Some((k, t)) if t == "n" || t == "r" || t == "t" || t.starts_with("tick") => (k, t),
            _ => (rest, ""),
        };
        let Some(f) = by_key.get(key) else {
            off.push(format!("{src}: no declared fact gives it"));
            continue;
        };
        let want = match tail {
            "" => num(f, &spec.fmts, Part::Text),
            "n" => num(f, &spec.fmts, Part::Bare),
            "r" => display(f, &spec.fmts)
                .and_then(|n| n.ok_or_else(|| format!("{key} has no display part"))),
            "t" => num(f, &spec.fmts, Part::Period),
            "t.y" => match value_year(f, rows) {
                // a value read at one year: the year of the rows it reads (leaf_ledger)
                Some(y) if f.t.is_none() => Ok(Num {
                    src: src.clone(),
                    value: y.parse().unwrap_or(f64::NAN),
                    text: y,
                }),
                _ => num(f, &spec.fmts, Part::Year),
            },
            "t.m" => num(f, &spec.fmts, Part::Month),
            "t.h" => num(f, &spec.fmts, Part::Half),
            t if t.starts_with("tick") => ticks(f, &spec.fmts).and_then(|ts| {
                ts.into_iter()
                    .find(|n| n.src == *src)
                    .ok_or_else(|| format!("the axis to {key} has no such tick"))
            }),
            _ => Err(format!("{tail:?} is no part of a fact")),
        };
        match want {
            Ok(n) if n.text == *printed => {}
            Ok(n) => off.push(format!(
                "{src} prints {printed:?}, the rows give {:?}",
                n.text
            )),
            Err(e) => off.push(format!("{src}: {e}")),
        }
    }
    for (src, printed) in ledger
        .iter()
        .filter(|(s, _)| s.starts_with(PERIOD_SRC) || s.starts_with(RECORD_SRC))
    {
        match read_entry(src, rows) {
            Ok(n) if n.text == *printed => {}
            Ok(n) => off.push(format!(
                "{src} prints {printed:?}, the rows give {:?}",
                n.text
            )),
            Err(e) => off.push(format!("{src}: {e}")),
        }
    }
    off
}

/// A leaf request (the visual group's LeafFill; for the gates, `LEAF_REQ` as the gate scripts dump it) as its spec, its rows
/// (the stand-in's ledger lines, which have no table, left out) and its tables in the order the spec gives them.
pub(crate) fn stored_request(req: &Value) -> (Spec, Vec<Row>, Vec<String>) {
    let s = &req["knobs"]["spec"];
    let facts = s["facts"]
        .as_object()
        .map(|o| o.iter().map(|(k, q)| (k.clone(), q.clone())).collect())
        .unwrap_or_default();
    let members = req["knobs"]["members"].as_array().map(|m| {
        m.iter()
            .filter_map(|c| c.as_str().map(str::to_string))
            .collect()
    });
    let rows = req["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["table"].is_string())
        .map(|r| Row {
            src: r["src"].as_str().unwrap_or_default().to_string(),
            table: r["table"].as_str().unwrap_or_default().to_string(),
            dims: r["dims"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect(),
            time: r["time"].as_str().unwrap_or_default().to_string(),
            value: r["value"]
                .as_str()
                .and_then(|v| v.parse().ok())
                .unwrap_or(f64::NAN),
        })
        .collect();
    let tables = s["tables"]
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let spec = Spec {
        facts,
        fmts: s["fmts"].clone(),
        members,
        // none when the request has none; one that does not read keeps why, so the page check refuses the page instead
        // of passing it unchecked
        asked_places: (!s["asked_places"].is_null()).then(|| {
            serde_json::from_value(s["asked_places"].clone()).unwrap_or_else(|e| AskedPlaces {
                unread: Some(e.to_string()),
                ..Default::default()
            })
        }),
        // none when the request has none; one that does not read keeps why, so the page check refuses the page instead
        // of passing it unchecked
        basis: (!s["basis"].is_null()).then(|| {
            serde_json::from_value(s["basis"].clone()).unwrap_or_else(|e| Basis {
                unread: Some(e.to_string()),
                ..Default::default()
            })
        }),
    };
    (spec, rows, tables)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Generated by running the prototype's facts.py on the two ring pages (base merged): the rows its queries read, the
    /// member list, the sha256 of each input file, and what it computed. Not typed by hand.
    const GAS: &str = include_str!("../fixtures/next_facts/gas-ring.json");
    const ASY: &str = include_str!("../fixtures/next_facts/asy-ring.json");

    fn fixture(page: &str) -> (Spec, Vec<Row>, Value) {
        let d: Value = serde_json::from_str(page).unwrap();
        let facts = d["facts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p[0].as_str().unwrap().to_string(), p[1].clone()))
            .collect();
        let members = d["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m.as_str().unwrap().to_string())
            .collect();
        let rows = d["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Row {
                src: r["src"].as_str().unwrap().to_string(),
                table: r["table"].as_str().unwrap().to_string(),
                dims: r["dims"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                    .collect(),
                time: r["time"].as_str().unwrap().to_string(),
                value: r["value"].as_str().unwrap().parse().unwrap(),
            })
            .collect();
        let spec = Spec {
            facts,
            fmts: d["fmts"].clone(),
            members: Some(members),
            asked_places: None,
            basis: None,
        };
        (spec, rows, d["golden"].clone())
    }

    fn against_golden(page: &str, expect: usize) {
        let (spec, rows, golden) = fixture(page);
        let facts = compute(&spec, &rows).unwrap();
        let golden = golden.as_array().unwrap();
        assert_eq!(golden.len(), expect);
        assert_eq!(facts.len(), golden.len());
        for (f, g) in facts.iter().zip(golden) {
            let (k, g) = (g[0].as_str().unwrap(), &g[1]);
            assert_eq!(f.key, k);
            // serde_json may read the golden float a unit off in the last place; the text is the exact check
            let gv = g["v"].as_f64().unwrap();
            assert!(
                (f.v - gv).abs() <= 1e-12 * gv.abs().max(1.0),
                "{k} value {} against {gv}",
                f.v
            );
            assert_eq!(text(f, &spec.fmts, false).unwrap(), g["text"], "{k} text");
            // the prototype's bare share kept its "%"; here a bare number is digits only and the leaf writes the "%"
            let bare = g["bare"].as_str().unwrap();
            let bare = if f.fmt == "pct" {
                bare.trim_end_matches('%')
            } else {
                bare
            };
            assert_eq!(text(f, &spec.fmts, true).unwrap(), bare, "{k} bare");
            assert_eq!(f.t.as_deref(), g["t"].as_str(), "{k} period");
            match g["tlabel"].as_str() {
                Some(l) => assert_eq!(
                    num(f, &spec.fmts, Part::Period).unwrap().text,
                    l,
                    "{k} period label"
                ),
                None => assert!(
                    num(f, &spec.fmts, Part::Period).is_err(),
                    "{k} has no period"
                ),
            }
            assert_eq!(f.n.map(|n| n as u64), g["n"].as_u64(), "{k} n");
            let who: Vec<&str> = g["who"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(f.who, who, "{k} who");
            assert!(!f.reads.is_empty(), "{k} reads no row");
        }
    }

    #[test]
    fn gas_ring_facts_print_as_the_prototype_does() {
        against_golden(GAS, 52);
    }

    #[test]
    fn asylum_ring_facts_print_as_the_prototype_does() {
        against_golden(ASY, 55);
    }

    #[test]
    fn fixtures_name_the_input_files_they_were_made_from() {
        for page in [GAS, ASY] {
            let d: Value = serde_json::from_str(page).unwrap();
            let inputs = d["inputs"].as_array().unwrap();
            assert!(!inputs.is_empty());
            for i in inputs {
                assert_eq!(i["sha256"].as_str().unwrap().len(), 64, "{i}");
            }
        }
    }

    fn row(table: &str, geo: &str, time: &str, value: f64) -> Row {
        Row {
            src: format!("series:{table}/{geo}:{time}:v"),
            table: table.into(),
            dims: [("geo".to_string(), geo.to_string())].into(),
            time: time.into(),
            value,
        }
    }

    fn spec(facts: Value, members: Option<&[&str]>) -> Spec {
        Spec {
            facts: facts
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, q)| (k.clone(), q.clone()))
                .collect(),
            fmts: json!({"m": {"scale": 0.01, "dec": 0, "suffix": " 亿"}, "time": {}}),
            members: members.map(|m| m.iter().map(|s| s.to_string()).collect()),
            asked_places: None,
            basis: None,
        }
    }

    fn by_key(s: &Spec, rows: &[Row]) -> BTreeMap<String, Fact> {
        compute(s, rows)
            .unwrap()
            .into_iter()
            .map(|f| (f.key.clone(), f))
            .collect()
    }

    /// Owner 11-22 (a story is computed and simulated): a rate a year takes its years from its operands' own times, a
    /// straight line carries a start at a rate to a year, the year a target is reached is the first whole year at or
    /// above it, and the largest one-year rise names its year. Each is worked out from the rows and refused when a year
    /// is missing, the order is wrong or the target is never reached.
    #[test]
    fn rates_lines_and_target_years_take_their_years_from_the_facts() {
        let rows = [
            row("r", "EU", "2005", 10.2),
            row("r", "EU", "2019", 19.9),
            row("r", "EU", "2020", 22.0),
            row("r", "EU", "2024", 25.2),
            row("t", "EU", "2030", 42.5),
        ];
        let base = json!({
            "now": {"table": "r", "time": "2024", "fmt": "x"},
            "was": {"table": "r", "time": "2005", "fmt": "x"},
            "goal": {"table": "t", "time": "2030", "fmt": "x"},
            "past": {"op": "per_year", "a": "now", "b": "was", "fmt": "x"},
            "line": {"op": "line_at", "start": "now", "rate": "past", "at": "2030", "fmt": "x"},
            "best": {"op": "step_max", "table": "r", "fmt": "x"},
            "when": {"op": "reach_year", "start": "now", "rate": "best", "target": "goal", "fmt": "n"},
            "grow": {"op": "cagr", "a": "now", "b": "was", "fmt": "pct"},
        });
        let f = by_key(&spec(base.clone(), None), &rows);
        assert_eq!(f["past"].n, Some(19));
        assert!((f["past"].v - 15.0 / 19.0).abs() < 1e-12);
        assert_eq!(text(&f["past"], &json!({}), false).unwrap(), "0.8");
        assert_eq!(text(&f["line"], &json!({}), false).unwrap(), "29.9");
        assert_eq!(f["line"].t.as_deref(), Some("2030"));
        assert_eq!(f["line"].reads, ["fact:now", "fact:past"]);
        assert_eq!(f["best"].t.as_deref(), Some("2020"));
        assert_eq!(text(&f["best"], &json!({}), false).unwrap(), "2.1");
        assert_eq!(
            f["best"].reads,
            ["series:r/EU:2019:v", "series:r/EU:2020:v"]
        );
        assert_eq!((f["when"].v, f["when"].n), (2033.0, Some(9)));
        assert_eq!(f["when"].exact, Some(Exact::int(2033)));
        assert_eq!(f["best"].exact, Exact::new(21, 10));
        // a gap the rate covers exactly is that many years, not one more (review 11-22: 0.3 / 0.1 is 3.0000000000000004)
        let edge = [
            row("r", "EU", "2020", 0.6),
            row("r", "EU", "2021", 0.7),
            row("t", "EU", "2030", 1.0),
        ];
        let e = by_key(
            &spec(
                json!({
                    "now": {"table": "r", "time": "2021", "fmt": "x"},
                    "goal": {"table": "t", "time": "2030", "fmt": "x"},
                    "step": {"op": "step_max", "table": "r", "fmt": "x"},
                    "when": {"op": "reach_year", "start": "now", "rate": "step", "target": "goal", "fmt": "n"},
                }),
                None,
            ),
            &edge,
        );
        assert_eq!((e["when"].v, e["when"].n), (2024.0, Some(3)));
        // a month missing between two rows is no step
        let months = [
            row("m", "EU", "2024-01", 1.0),
            row("m", "EU", "2024-03", 9.0),
            row("m", "EU", "2024-04", 10.0),
        ];
        let m = by_key(
            &spec(
                json!({"s": {"op": "step_max", "table": "m", "fmt": "x"}}),
                None,
            ),
            &months,
        );
        assert_eq!((m["s"].t.as_deref(), m["s"].v), (Some("2024-04"), 1.0));
        assert_eq!(text(&f["grow"], &json!({}), false).unwrap(), "5%");
        let refused = |patch: Value, why: &str| {
            let mut q = base.clone();
            for (k, v) in patch.as_object().unwrap() {
                q[k] = v.clone();
            }
            let e = compute(&spec(q, None), &rows).unwrap_err();
            assert!(e.contains(why), "{e}");
        };
        refused(
            json!({"past": {"op": "per_year", "a": "was", "b": "now", "fmt": "x"}}),
            "after b",
        );
        refused(
            json!({"past": {"op": "per_year", "a": "best", "b": "was", "fmt": "x"}}),
            "no one time",
        );
        refused(
            json!({"line": {"op": "line_at", "start": "now", "rate": "past", "at": "2020", "fmt": "x"}}),
            "after the start",
        );
        refused(
            json!({"best": {"op": "minus", "a": "was", "b": "now", "fmt": "x"}}),
            "never reaches",
        );
    }

    /// Owner 11-22: the first period one series passes another, how far the members spread at a time, and the mean change
    /// of the members that stood highest (or lowest) at the start, every member read and none skipped.
    #[test]
    fn crossings_spreads_and_group_changes_read_every_member() {
        let mut rows = vec![];
        for (g, a, b) in [
            ("A", 40.0, 60.0),
            ("B", 30.0, 35.0),
            ("C", 10.0, 30.0),
            ("D", 2.0, 6.0),
        ] {
            rows.push(row("r", g, "2005", a));
            rows.push(row("r", g, "2024", b));
        }
        for (t, w, c) in [
            ("2018", 10.0, 20.0),
            ("2019", 12.0, 15.0),
            ("2020", 14.0, 12.0),
            ("2021", 13.0, 14.0),
        ] {
            rows.push(row("w", "EU", t, w));
            rows.push(row("c", "EU", t, c));
        }
        let members: &[&str] = &["A", "B", "C", "D"];
        let s = spec(
            json!({
                "cross": {"op": "first_above", "a": {"table": "w"}, "b": {"table": "c"}, "fmt": "x"},
                "sd": {"op": "spread", "table": "r", "by": "geo", "time": "2024", "fmt": "x"},
                "lo": {"op": "group_change", "table": "r", "by": "geo", "from": "2005", "to": "2024", "part": "bottom", "k": 2, "fmt": "x"},
                "hi": {"op": "group_change", "table": "r", "by": "geo", "from": "2005", "to": "2024", "part": "top", "k": 2, "fmt": "x"},
            }),
            Some(members),
        );
        let f = by_key(&s, &rows);
        assert_eq!(
            (f["cross"].t.as_deref(), f["cross"].v),
            (Some("2020"), 14.0)
        );
        assert_eq!(
            f["cross"].reads,
            ["series:w/EU:2020:v", "series:c/EU:2020:v"]
        );
        let mean = (60.0 + 35.0 + 30.0 + 6.0) / 4.0;
        let sd = ([60.0, 35.0, 30.0, 6.0f64]
            .iter()
            .map(|v| (v - mean).powi(2))
            .sum::<f64>()
            / 4.0)
            .sqrt();
        assert!((f["sd"].v - sd).abs() < 1e-12);
        assert_eq!(f["sd"].reads.len(), 4);
        assert_eq!(
            (f["lo"].v, f["lo"].who.clone()),
            (12.0, vec!["C".to_string(), "D".to_string()])
        );
        assert_eq!(
            (f["hi"].v, f["hi"].who.clone()),
            (12.5, vec!["A".to_string(), "B".to_string()])
        );
        // a member with no row is not skipped
        rows.retain(|r| !(r.dims["geo"] == "D" && r.time == "2024"));
        let e = compute(&s, &rows).unwrap_err();
        assert!(e.contains("no row at 2024 for D"), "{e}");
    }

    #[test]
    fn low_peak_and_last_take_the_first_period_on_a_tie() {
        let rows = [
            row("a", "X", "2020", 5.0),
            row("a", "X", "2021", 3.0),
            row("a", "X", "2022", 3.0),
            row("a", "X", "2023", 5.0),
        ];
        let s = spec(
            json!({
                "lo": {"op": "low", "table": "a", "fmt": "m"},
                "hi": {"op": "peak", "table": "a", "fmt": "m"},
                "la": {"op": "last", "table": "a", "fmt": "m"},
                "hi22": {"op": "peak", "table": "a", "fmt": "m", "from": "2022"},
            }),
            None,
        );
        let f: BTreeMap<String, Fact> = compute(&s, &rows)
            .unwrap()
            .into_iter()
            .map(|f| (f.key.clone(), f))
            .collect();
        assert_eq!((f["lo"].t.as_deref(), f["lo"].v), (Some("2021"), 3.0));
        assert_eq!((f["hi"].t.as_deref(), f["hi"].v), (Some("2020"), 5.0));
        assert_eq!(f["la"].t.as_deref(), Some("2023"));
        assert_eq!(f["hi22"].t.as_deref(), Some("2023"));
        assert_eq!(f["lo"].reads, ["series:a/X:2021:v"]);
    }

    /// Plan v4 item 6 (GB/T 8170, rounded once on the exact decimal value): a row value of exactly .5 at the last place
    /// kept goes to the even digit on its decimal text, not on the binary number (54.635 prints 54.64, which the float
    /// 54.634999... printed 54.63); a difference and a mean are worked out from the rows' decimals (113.5 less the mean of
    /// four rows, 10.45, prints 10.4, which the float 10.450000000000003 printed 10.5); a tie that the even digit already
    /// rounded down stays (12,422.5 prints 12,422; 45 less 34.5 prints 10); a share prints its exact percent; and a fact
    /// read back from a stored request (no exact value) prints from its float as before.
    #[test]
    fn a_number_is_rounded_once_on_its_exact_decimal_value() {
        let rows = [
            row("a", "NGA", "2024", 54.635),
            row("a", "IND", "2024", 72.235),
            row("a", "NER", "2024", 113.5),
            row("a", "TCD", "2024", 100.6),
            row("a", "SLE", "2024", 93.8),
            row("a", "SOM", "2024", 104.3),
            row("b", "X", "2024", 12422.5),
            row("b", "Y", "2024", 45.0),
            row("b", "Z", "2024", 34.5),
        ];
        let four = ["NER", "TCD", "SLE", "SOM"];
        let mut s = spec(
            json!({
                "lo": {"table": "a", "filter": {"geo": "NGA"}, "time": "2024", "fmt": "yr"},
                "ind": {"table": "a", "filter": {"geo": "IND"}, "time": "2024", "fmt": "yr"},
                "hi": {"table": "a", "filter": {"geo": "NER"}, "time": "2024", "fmt": "p"},
                "mean_sum": {"table": "a", "filter": {"geo": four}, "time": "2024", "fmt": "p"},
                "mean_n": {"op": "n", "by": "geo", "table": "a", "filter": {"geo": four}, "time": "2024", "fmt": "n"},
                "mean": {"op": "times", "a": "mean_sum", "b": "mean_n", "fmt": "p"},
                "vs_mean": {"op": "minus", "a": "hi", "b": "mean", "fmt": "p"},
                "x": {"table": "b", "filter": {"geo": "X"}, "time": "2024", "fmt": "w"},
                "y": {"table": "b", "filter": {"geo": "Y"}, "time": "2024", "fmt": "w"},
                "z": {"table": "b", "filter": {"geo": "Z"}, "time": "2024", "fmt": "w"},
                "gap": {"op": "minus", "a": "y", "b": "z", "fmt": "w"},
                "part": {"op": "share", "a": "z", "b": "y"},
            }),
            None,
        );
        s.fmts = json!({"yr": {"scale": 1, "dec": 2, "suffix": " 年"}, "p": {"scale": 1, "dec": 1, "suffix": ""},
            "w": {"scale": 1, "dec": 0, "suffix": ""}, "time": {}});
        let f: BTreeMap<String, Fact> = compute(&s, &rows)
            .unwrap()
            .into_iter()
            .map(|f| (f.key.clone(), f))
            .collect();
        let t = |k: &str| text(&f[k], &s.fmts, true).unwrap();
        assert_eq!(
            (t("lo"), t("ind")),
            ("54.64".to_string(), "72.24".to_string())
        );
        assert_eq!(
            fixed(f["lo"].v, 2, false),
            "54.63",
            "the float alone rounds the other way"
        );
        assert_eq!(f["vs_mean"].v, 10.450000000000003);
        assert_eq!(
            (t("mean"), t("vs_mean")),
            ("103.0".to_string(), "10.4".to_string())
        );
        assert_eq!((t("x"), t("gap")), ("12,422".to_string(), "10".to_string()));
        // 34.5 / 45 = 76.666...%
        assert_eq!(t("part"), "77");
        // a negative value keeps its minus; a stored fact has no exact value and prints its float
        let mut neg = f["gap"].clone();
        neg.exact = Some(Exact::of(-0.25).unwrap());
        assert_eq!(
            text(&neg, &json!({"w": {"scale": 1, "dec": 1}}), true).unwrap(),
            "-0.2"
        );
        let stored: Fact = serde_json::from_value(serde_json::to_value(&f["lo"]).unwrap()).unwrap();
        assert_eq!(
            (stored.exact, text(&stored, &s.fmts, true).unwrap()),
            (None, "54.63".to_string())
        );
        assert_eq!(stored, f["lo"], "the stored fields are the same fact");
        // the display part rounds the exact value too
        assert_eq!(
            display(&f["lo"], &s.fmts).unwrap().map(|n| n.text),
            Some("54.6".to_string())
        );
    }

    /// Owner 11-06: a difference asked of its operands as printed (of_printed) is refused, never computed.
    #[test]
    fn a_difference_of_printed_operands_is_refused() {
        let rows = [row("a", "X", "2020", 6.31), row("a", "Y", "2020", 3.53)];
        let facts = |of: bool| {
            let mut gap = json!({"op": "minus", "a": "x", "b": "y", "fmt": "m"});
            if of {
                gap["of_printed"] = json!([{"scale": 1, "dec": 0}, {"scale": 1, "dec": 0}]);
            }
            json!({"x": {"table": "a", "filter": {"geo": "X"}, "time": "2020", "fmt": "m"},
                   "y": {"table": "a", "filter": {"geo": "Y"}, "time": "2020", "fmt": "m"}, "gap": gap})
        };
        let e = compute(&spec(facts(true), None), &rows).unwrap_err();
        assert!(e.contains("gap: of_printed is refused"), "{e}");
        let f = compute(&spec(facts(false), None), &rows).unwrap();
        assert!((f.iter().find(|f| f.key == "gap").unwrap().v - 2.78).abs() < 1e-9);
    }

    #[test]
    fn nothing_is_guessed() {
        let rows = [row("a", "X", "2020", 0.0), row("a", "Y", "2020", 4.0)];
        let refused = |facts: Value, members: Option<&[&str]>, why: &str| {
            let e = compute(&spec(facts, members), &rows).unwrap_err();
            assert!(e.contains(why), "{e}");
        };
        refused(
            json!({"z": {"table": "a", "filter": {"geo": "X"}, "time": "2020", "fmt": "m"},
                   "y": {"table": "a", "filter": {"geo": "Y"}, "time": "2020", "fmt": "m"},
                   "s": {"op": "share", "a": "y", "b": "z"}}),
            None,
            "s: share divides by",
        );
        refused(
            json!({"s": {"op": "share", "a": "q", "b": "q"}}),
            None,
            "q: no such fact is declared",
        );
        refused(
            json!({"s": {"op": "plus", "a": "s", "b": "s"}}),
            None,
            "depends on itself",
        );
        refused(
            json!({"v": {"table": "a", "time": "1999", "fmt": "m"}}),
            None,
            "v: value has no row at 1999",
        );
        refused(
            json!({"v": {"table": "a", "time": "2020", "fmt": "m", "not_eu": "geo"}}),
            None,
            "v: needs the member list",
        );
        refused(
            json!({"c": {"op": "count", "a": {"table": "a"}, "b": {"table": "a"}, "time": "2020", "above": 0.5}}),
            None,
            "c: needs the member list",
        );
        refused(
            json!({"v": {"table": "a", "filter": {"sex": "T"}, "time": "2020", "fmt": "m"}}),
            None,
            "has no sex",
        );
        refused(
            json!({"v": {"op": "median", "table": "a", "fmt": "m"}}),
            None,
            "median is not an op",
        );
        let f = compute(
            &spec(
                json!({"v": {"table": "a", "time": "2020", "fmt": "bcm"}}),
                None,
            ),
            &rows,
        )
        .unwrap();
        assert!(text(&f[0], &json!({}), false)
            .unwrap_err()
            .contains("bcm is not in the spec"));
        let nan = [row("a", "X", "2020", f64::NAN)];
        assert!(compute(
            &spec(
                json!({"v": {"table": "a", "time": "2020", "fmt": "m"}}),
                None
            ),
            &nan
        )
        .unwrap_err()
        .contains("holds no number"));
    }

    #[test]
    fn count_and_rest_read_the_member_list() {
        let rows = [
            row("ru", "AA", "2020", 6.0),
            row("ru", "BB", "2020", 1.0),
            row("all", "AA", "2020", 10.0),
            row("all", "BB", "2020", 10.0),
            row("all", "ZZ", "2020", 10.0),
        ];
        let f = compute(
            &spec(
                json!({"c": {"op": "count", "a": {"table": "ru"}, "b": {"table": "all"}, "time": "2020", "above": 0.5}}),
                Some(&["BB", "AA"]),
            ),
            &rows,
        )
        .unwrap();
        assert_eq!((f[0].v, f[0].who.clone()), (1.0, vec!["AA".to_string()]));
        // under a line: no b, each member's own value of a under `below`; a member with no row of a fails, never skipped
        let under = |q: Value| compute(&spec(json!({"c": q}), Some(&["BB", "AA"])), &rows);
        let fu = under(json!({"op": "count", "a": {"table": "ru"}, "time": "2020", "below": 5.0}))
            .unwrap();
        assert_eq!((fu[0].v, fu[0].who.clone()), (1.0, vec!["BB".to_string()]));
        let eu = compute(
            &spec(
                json!({"c": {"op": "count", "a": {"table": "ru"}, "time": "2020", "below": 5.0}}),
                Some(&["BB", "AA", "CC"]),
            ),
            &rows,
        )
        .unwrap_err();
        assert!(
            eu.contains("c: count has no row of a at 2020 for CC"),
            "{eu}"
        );
        assert!(under(json!({"op": "count", "a": {"table": "ru"}, "b": {"table": "all"}, "time": "2020", "below": 5.0}))
            .unwrap_err()
            .contains("count has no number as above"));
        // drop BB's row of b: the count fails and names BB, it does not come out 1 of 1
        let e = compute(
            &spec(
                json!({"c": {"op": "count", "a": {"table": "ru"}, "b": {"table": "all"}, "time": "2020", "above": 0.5}}),
                Some(&["BB", "AA"]),
            ),
            &[rows[0].clone(), rows[1].clone(), rows[2].clone(), rows[4].clone()],
        )
        .unwrap_err();
        assert!(e.contains("c: count has no row of b at 2020 for BB"), "{e}");
        let counted = spec(
            json!({"c": {"op": "count", "a": {"table": "ru"}, "b": {"table": "all"}, "time": "2020", "above": 0.5}}),
            Some(&["BB", "AA"]),
        );
        assert_eq!(
            recheck(
                &BTreeMap::new(),
                &counted,
                &[rows[0].clone(), rows[2].clone(), rows[4].clone()],
                &f
            ),
            ["cannot recompute c: count has no row of b at 2020 for BB"]
        );
        let by = |p: &str, v: f64| Row {
            src: format!("series:imp/{p}:2024:v"),
            table: "imp".into(),
            dims: [("partner".to_string(), p.to_string())].into(),
            time: "2024".into(),
            value: v,
        };
        let rows = [
            by("TOTAL", 100.0),
            by("AA", 50.0),
            by("NO", 40.0),
            by("US", 30.0),
            by("QA", 30.0),
            by("XX", 0.0),
        ];
        let f = compute(
            &spec(
                json!({"r": {"op": "rest", "table": "imp", "by": "partner", "not_eu": true, "time": "2024", "skip": 1, "fmt": "m"}}),
                Some(&["AA"]),
            ),
            &rows,
        )
        .unwrap();
        assert_eq!((f[0].v, f[0].n), (60.0, Some(2)));
        assert_eq!(
            f[0].reads,
            [
                "series:imp/US:2024:v",
                "series:imp/QA:2024:v",
                "series:imp/XX:2024:v"
            ]
        );
    }

    #[test]
    fn numbers_round_as_python_formats_them() {
        for (x, dec, sep, want) in [
            (0.5, 0, false, "0"),
            (1.5, 0, false, "2"),
            (2.5, 0, false, "2"),
            (0.125, 2, false, "0.12"),
            (0.375, 2, false, "0.38"),
            (2.675, 2, false, "2.67"),
            (-0.4, 0, false, "0"),
            (-0.04, 1, false, "0.0"),
            (-0.05, 1, false, "-0.1"),
            (999.5, 0, true, "1,000"),
            (1234567.891, 0, true, "1,234,568"),
            (-1234.5, 1, true, "-1,234.5"),
            (12.0, 0, true, "12"),
        ] {
            assert_eq!(fixed(x, dec, sep), want, "{x} at {dec}");
        }
    }

    #[test]
    fn periods_are_named_in_chinese() {
        assert_eq!(tlabel("2022-S1").unwrap(), "2022 年上半年");
        assert_eq!(tlabel("2022-S2").unwrap(), "2022 年下半年");
        assert_eq!(tlabel("2022-03").unwrap(), "2022 年 3 月");
        assert_eq!(tlabel("2022").unwrap(), "2022 年");
        assert!(tlabel("2022-S3").is_err());
        assert!(tlabel("2022-Q1").is_err());
    }

    #[test]
    fn ticks_step_in_the_printed_unit() {
        let f = Fact {
            key: "top".into(),
            op: "value".into(),
            v: 347_812.0,
            t: None,
            n: None,
            who: vec![],
            fmt: "m".into(),
            reads: vec!["x".into()],
            exact: None,
        };
        let fmts = json!({"m": {"scale": 0.01, "dec": 0, "suffix": " 亿"}});
        let t = ticks(&f, &fmts).unwrap();
        let texts: Vec<&str> = t.iter().map(|n| n.text.as_str()).collect();
        assert_eq!(texts, ["1,000", "2,000", "3,000"]);
        assert_eq!(t[1].src, "fact:top.tick2");
        assert!((t[1].value - 200_000.0).abs() < 1e-6);
        assert!(ticks(
            &Fact {
                v: 0.0,
                ..f.clone()
            },
            &fmts
        )
        .is_err());
        assert!(ticks(
            &Fact {
                fmt: "pct".into(),
                ..f.clone()
            },
            &fmts
        )
        .is_err());
        // a whole-number format never gets a half step: every tick's text reads back as its value
        let whole = json!({"m": {"scale": 1, "dec": 0}});
        for v in [1.6, 2.0, 3.0, 7.5, 19.0] {
            let t = ticks(&Fact { v, ..f.clone() }, &whole).unwrap();
            assert!(
                t.iter().all(|n| n.text.parse::<f64>().unwrap() == n.value),
                "{v}: {t:?}"
            );
        }
        let two: Vec<String> = ticks(
            &Fact {
                v: 2.0,
                ..f.clone()
            },
            &whole,
        )
        .unwrap()
        .into_iter()
        .map(|n| n.text)
        .collect();
        assert_eq!(two, ["1", "2"]);
        // at least three ticks up to the top, and at most seven: a top of 9,500 once got the one tick 5,000
        let texts = |v: f64| -> Vec<String> {
            ticks(&Fact { v, ..f.clone() }, &whole)
                .unwrap()
                .into_iter()
                .map(|n| n.text)
                .collect()
        };
        assert_eq!(texts(9_500.0), ["2,000", "4,000", "6,000", "8,000"]);
        assert_eq!(texts(3.0), ["1", "2", "3"]);
        for v in [3.0, 4.9, 7.4, 9.9, 15.0, 29.9, 99.0, 9_500.0, 123_456.0] {
            let n = texts(v).len();
            assert!((3..=7).contains(&n), "{v}: {n} ticks");
        }
        let tenth = json!({"m": {"scale": 1, "dec": 1}});
        let t = ticks(
            &Fact {
                v: 0.3,
                ..f.clone()
            },
            &tenth,
        )
        .unwrap();
        assert_eq!(
            t.iter().map(|n| n.text.as_str()).collect::<Vec<_>>(),
            ["0.1", "0.2", "0.3"]
        );
        assert!(ticks(&Fact { v: 0.4, ..f }, &whole).is_err());
        assert!(reads_back("1,000", 1000.0) && reads_back("0.3", 0.1 + 0.2));
        assert!(!reads_back("2", 1.5) && !reads_back("0", 0.5) && !reads_back("x", 1.0));
    }

    #[test]
    fn member_names_come_from_name_rows_only() {
        let f = Fact {
            key: "dep".into(),
            op: "count".into(),
            v: 2.0,
            t: None,
            n: None,
            who: vec!["AT".into(), "HU".into()],
            fmt: "n".into(),
            reads: vec![],
            exact: None,
        };
        let label = |src: &str, text: &str| Label {
            src: src.into(),
            text: text.into(),
        };
        let names: BTreeMap<String, Label> =
            [("AT".to_string(), label("name:zh:iso2:AT", "奥地利"))].into();
        let e = who(&f, &names).unwrap_err();
        assert_eq!(e, "dep: HU has no name row");
        let mut names = names;
        names.insert("HU".into(), label("places.json:HU", "匈牙利"));
        assert!(who(&f, &names)
            .unwrap_err()
            .contains("not read from a name row"));
        names.insert("HU".into(), label("name:zh:iso2:HU", "匈牙利"));
        assert_eq!(who(&f, &names).unwrap().len(), 2);
    }

    /// A leaf that writes the words gets bare numbers only: a share without "%", a period as its year and month (or half),
    /// st1 11-23: a value read at one year has the year of the rows it reads as its .t.y entry (a series row, a target row
    /// of the legal-targets registry); a value over rows of two years, a row it names that is not there, or a half-year
    /// period's own years elsewhere give none.
    #[test]
    fn a_value_read_at_a_year_has_that_year_as_an_entry() {
        let row = |src: &str, time: &str| Row {
            src: src.into(),
            table: "t".into(),
            dims: BTreeMap::new(),
            time: time.into(),
            value: 1.0,
        };
        let rows = [
            row("series:t/EU:2024:OBS_VALUE", "2024"),
            row("target:eu-2030", "2030"),
            row("series:t/DE:2023:OBS_VALUE", "2023"),
        ];
        let value = |reads: &[&str]| Fact {
            key: "now".into(),
            op: "value".into(),
            v: 1.0,
            t: None,
            n: None,
            who: Vec::new(),
            fmt: "pc".into(),
            reads: reads.iter().map(|r| r.to_string()).collect(),
            exact: None,
        };
        assert_eq!(
            value_year(&value(&["series:t/EU:2024:OBS_VALUE"]), &rows).as_deref(),
            Some("2024")
        );
        assert_eq!(
            value_year(&value(&["target:eu-2030"]), &rows).as_deref(),
            Some("2030")
        );
        assert_eq!(
            value_year(
                &value(&["series:t/EU:2024:OBS_VALUE", "series:t/DE:2023:OBS_VALUE"]),
                &rows
            ),
            None
        );
        assert_eq!(
            value_year(&value(&["series:t/FR:2024:OBS_VALUE"]), &rows),
            None
        );
        assert_eq!(
            value_year(
                &Fact {
                    op: "minus".into(),
                    ..value(&["series:t/EU:2024:OBS_VALUE"])
                },
                &rows
            ),
            None
        );
    }

    /// each rechecked from the rows; a part the period lacks is no entry.
    #[test]
    fn bare_shares_and_period_parts_are_entries_rechecked_from_the_rows() {
        let (spec, rows, _) = fixture(GAS);
        let facts = compute(&spec, &rows).unwrap();
        let mut ledger: BTreeMap<String, String> = BTreeMap::new();
        let (mut pct, mut months) = (0, 0);
        for f in &facts {
            let bare = num(f, &spec.fmts, Part::Bare).unwrap();
            assert!(
                bare.text
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b".,-".contains(&b)),
                "{}",
                bare.text
            );
            pct += usize::from(f.fmt == "pct");
            ledger.insert(bare.src, bare.text);
            let Some(t) = f.t.as_deref() else { continue };
            let y = num(f, &spec.fmts, Part::Year).unwrap();
            assert_eq!(
                (y.src.clone(), y.text.clone()),
                (format!("fact:{}.t.y", f.key), t[..4].to_string())
            );
            ledger.insert(y.src, y.text);
            for part in [Part::Month, Part::Half] {
                if let Ok(n) = num(f, &spec.fmts, part) {
                    months += 1;
                    ledger.insert(n.src, n.text);
                }
            }
        }
        assert!(
            pct > 0 && months > 0,
            "the gas fixture has shares {pct} and month periods {months}"
        );
        assert_eq!(recheck(&ledger, &spec, &rows, &facts), Vec::<String>::new());
        let (k, _) = ledger.iter().find(|(s, _)| s.ends_with(".t.m")).unwrap();
        let mut wrong = ledger.clone();
        wrong.insert(k.clone(), "13".into());
        assert_eq!(recheck(&wrong, &spec, &rows, &facts).len(), 1);
        let year_only = Fact {
            t: Some("2024".into()),
            ..facts[0].clone()
        };
        assert!(
            num(&year_only, &spec.fmts, Part::Month).is_err()
                && num(&year_only, &spec.fmts, Part::Half).is_err()
        );
        let half = Fact {
            t: Some("2022-S2".into()),
            ..facts[0].clone()
        };
        assert_eq!(num(&half, &spec.fmts, Part::Half).unwrap().text, "下");
        assert!(num(&half, &spec.fmts, Part::Month).is_err());
    }

    #[test]
    fn recheck_recomputes_every_fact_entry_from_the_rows() {
        let (spec, rows, _) = fixture(GAS);
        let facts = compute(&spec, &rows).unwrap();
        let mut ledger: BTreeMap<String, String> = BTreeMap::new();
        for f in &facts {
            let n = num(f, &spec.fmts, Part::Text).unwrap();
            ledger.insert(n.src, n.text);
            if f.t.is_some() {
                let n = num(f, &spec.fmts, Part::Period).unwrap();
                ledger.insert(n.src, n.text);
            }
        }
        ledger.insert("series:x:y:z".into(), "12".into());
        assert_eq!(recheck(&ledger, &spec, &rows, &facts), Vec::<String>::new());

        // an axis's ticks are rechecked too: a tick printed otherwise than the rows give is caught
        let axis = facts.iter().find(|f| ticks(f, &spec.fmts).is_ok()).unwrap();
        let mut ticked = ledger.clone();
        for n in ticks(axis, &spec.fmts).unwrap() {
            ticked.insert(n.src, n.text);
        }
        assert_eq!(recheck(&ticked, &spec, &rows, &facts), Vec::<String>::new());
        ticked.insert(format!("fact:{}.tick1", axis.key), "0".into());
        assert_eq!(recheck(&ticked, &spec, &rows, &facts).len(), 1);

        let k = facts[0].key.clone();
        let mut bent = ledger.clone();
        bent.insert(format!("fact:{k}"), "9,999 亿立方米".into());
        let off = recheck(&bent, &spec, &rows, &facts);
        assert_eq!(off.len(), 1, "{off:?}");
        assert!(
            off[0].starts_with(&format!("fact:{k} prints \"9,999 亿立方米\"")),
            "{off:?}"
        );

        let mut extra = ledger.clone();
        extra.insert("fact:made_up".into(), "42%".into());
        assert_eq!(
            recheck(&extra, &spec, &rows, &facts),
            ["fact:made_up: no declared fact gives it"]
        );

        let mut told = facts.clone();
        told[0].reads.pop();
        assert_eq!(recheck(&ledger, &spec, &rows, &told).len(), 1);
        told = facts.clone();
        told[0].v += 1.0;
        assert_eq!(recheck(&ledger, &spec, &rows, &told).len(), 1);

        // a row changed after the page was built: the entries that read it no longer agree
        let mut moved = rows.clone();
        let read = facts[0].reads[0].clone();
        moved.iter_mut().find(|r| r.src == read).unwrap().value += 1e6;
        assert!(!recheck(&ledger, &spec, &moved, &facts).is_empty());
    }

    fn cell(src: &str, table: &str, dims: &[(&str, &str)], time: &str, value: f64) -> Row {
        Row {
            src: src.into(),
            table: table.into(),
            dims: dims
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            time: time.into(),
            value,
        }
    }

    fn partners() -> Vec<Row> {
        let r = |p: &str, s: &str, t: &str, v: f64| {
            cell(
                &format!("series:imp/{p}.{s}:{t}:OBS_VALUE"),
                "imp",
                &[("partner", p), ("siec", s)],
                t,
                v,
            )
        };
        vec![
            r("NO", "a", "2024", 900.0),
            r("RU", "a", "2024", 300.0),
            r("NO", "b", "2024", 49.0),
            r("DE", "a", "2024", 70.0),
            r("TOTAL", "a", "2024", 1319.0),
            r("RU", "a", "2021", 1500.0),
            cell(
                "record:events/0",
                "events",
                &[("date", "2022-09-26"), ("label", "x")],
                "",
                f64::NAN,
            ),
        ]
    }

    #[test]
    fn a_minus_family_is_each_code_s_later_value_less_its_earlier_and_reads_both() {
        let rows = partners();
        let q = |t: &str| json!({"each": "partner", "table": "imp", "time": t, "fmt": "m", "filter": {"siec": "a"}});
        let sp = spec(
            json!({"v0": q("2021"), "v1": q("2024"), "ch": {"op": "minus", "each": "partner", "a": "v1", "b": "v0", "fmt": "m"}}),
            None,
        );
        // RU is the one code at both years: 300 - 1500 by hand; the others have no 2021 row, so the family refuses them
        let both = |rows: &[Row]| -> Vec<Row> {
            rows.iter()
                .filter(|r| r.dims.get("partner").is_some_and(|p| p == "RU"))
                .cloned()
                .collect()
        };
        let ru = both(&rows);
        let facts = compute(&sp, &ru).unwrap();
        let ch = facts.iter().find(|f| f.key == "ch.RU").unwrap();
        assert_eq!(
            (ch.op.as_str(), ch.v, ch.fmt.as_str()),
            ("minus", 300.0 - 1500.0, "m")
        );
        assert_eq!(ch.reads, ["fact:v1.RU", "fact:v0.RU"]);
        assert_eq!(text(ch, &sp.fmts, false).unwrap(), "-12 亿");
        let ledger: BTreeMap<String, String> = facts
            .iter()
            .flat_map(|f| {
                [
                    num(f, &sp.fmts, Part::Text).unwrap(),
                    num(f, &sp.fmts, Part::Bare).unwrap(),
                ]
            })
            .map(|n| (n.src, n.text))
            .collect();
        assert_eq!(ledger["fact:ch.RU"], "-12 亿");
        assert_eq!(recheck(&ledger, &sp, &ru, &facts), Vec::<String>::new());
        // a code one end holds and the other not is refused, never left out
        let kept: Vec<Row> = rows
            .iter()
            .filter(|r| r.dims.get("siec").is_some_and(|s| s == "a"))
            .cloned()
            .collect();
        let err = compute(&sp, &kept).unwrap_err();
        assert!(err.contains("ch: v1 has NO, v0 has not"), "{err}");
        // a side that is no family over the same dimension
        let off = spec(
            json!({"v1": q("2024"), "ch": {"op": "minus", "each": "siec", "a": "v1", "b": "v1", "fmt": "m"}}),
            None,
        );
        assert!(compute(&off, &ru)
            .unwrap_err()
            .contains("ch: minus names no family over siec as a (v1)"));
    }

    /// A change family's facts as the flow writes them to a page's request (serde_json) and the completion gate reads them
    /// back: each f64 comes back bit for bit, so the exact recheck finds every change computed from the rows. The four pairs
    /// are the q1 page's whose differences print 17 digits (44.2 - 33.37 is 10.830000000000005).
    #[test]
    fn a_change_family_read_back_from_its_json_is_rechecked_bit_for_bit() {
        let pairs = [
            ("AT", 33.37, 44.2),
            ("DE", 14.885, 23.9),
            ("LU", 5.364, 20.2),
            ("LV", 37.138, 46.3),
        ];
        let mut rows = Vec::new();
        for (geo, v0, v1) in pairs {
            for (t, v) in [("2016", v0), ("2025", v1)] {
                rows.push(cell(
                    &format!("series:sdg_07_40/A.REN.PC.{geo}:{t}:OBS_VALUE"),
                    "sdg_07_40",
                    &[("geo", geo)],
                    t,
                    v,
                ));
            }
        }
        let q = |t: &str| json!({"each": "geo", "table": "sdg_07_40", "time": t, "fmt": "pc"});
        let mut sp = spec(
            json!({"val0": q("2016"), "val1": q("2025"), "chg": {"op": "minus", "each": "geo", "a": "val1", "b": "val0", "fmt": "pp"}}),
            None,
        );
        sp.fmts = json!({"pc": {"scale": 1, "dec": 1, "suffix": "%"}, "pp": {"scale": 1, "dec": 2, "suffix": " 个百分点"}, "time": {}});
        let facts = compute(&sp, &rows).unwrap();
        // the later end less the earlier, each read from its two value facts
        for (geo, v0, v1) in pairs {
            let ch = facts
                .iter()
                .find(|f| f.key == format!("chg.{geo}"))
                .unwrap();
            assert_eq!(
                (ch.v, &ch.reads[..]),
                (
                    v1 - v0,
                    &[format!("fact:val1.{geo}"), format!("fact:val0.{geo}")][..]
                )
            );
        }
        let ledger = leaf_ledger(&sp, &rows, &facts).unwrap();
        let text = serde_json::to_string_pretty(
            &json!({"spec": sp, "rows": rows, "facts": facts, "ledger": ledger}),
        )
        .unwrap();
        // read back as the gate reads a page's request: the text to a value, then each part from it
        let mut back: Value = serde_json::from_str(&text).unwrap();
        let read: Vec<Fact> = serde_json::from_value(back["facts"].take()).unwrap();
        let read_rows: Vec<Row> = serde_json::from_value(back["rows"].take()).unwrap();
        let read_spec: Spec = serde_json::from_value(back["spec"].take()).unwrap();
        let read_ledger: BTreeMap<String, String> =
            serde_json::from_value(back["ledger"].take()).unwrap();
        let bits: Vec<(String, u64, u64)> = facts
            .iter()
            .zip(&read)
            .filter(|(f, r)| f.v.to_bits() != r.v.to_bits())
            .map(|(f, r)| (f.key.clone(), f.v.to_bits(), r.v.to_bits()))
            .collect();
        // the facts whose f64 came back with other bits, and what the recheck finds on what was read back
        let off = recheck(&read_ledger, &read_spec, &read_rows, &read);
        assert_eq!((bits, off), (Vec::new(), Vec::<String>::new()));
    }

    #[test]
    fn a_family_is_one_fact_per_code_of_its_dimension() {
        let rows = partners();
        let sp = spec(
            json!({"lab": {"op": "value", "each": "partner", "table": "imp", "time": "2024", "not_eu": "partner", "fmt": "m", "filter": {"siec": "a"}}}),
            Some(&["DE"]),
        );
        let facts = compute(&sp, &rows).unwrap();
        let got: Vec<(&str, f64)> = facts.iter().map(|f| (f.key.as_str(), f.v)).collect();
        assert_eq!(got, [("lab.NO", 900.0), ("lab.RU", 300.0)]);
        assert_eq!(facts[0].reads, ["series:imp/NO.a:2024:OBS_VALUE"]);
        // without the filter NO has two rows at 2024: refused, not summed
        let two_rows = spec(
            json!({"lab": {"op": "value", "each": "partner", "table": "imp", "time": "2024", "not_eu": "partner", "fmt": "m"}}),
            Some(&["DE"]),
        );
        assert_eq!(
            compute(&two_rows, &rows).unwrap_err(),
            "lab: the code NO has more than one row at 2024 (series:imp/NO.a:2024:OBS_VALUE, series:imp/NO.b:2024:OBS_VALUE); filter to one row per code"
        );
        let n = num(&facts[0], &sp.fmts, Part::Bare).unwrap();
        assert_eq!((n.src.as_str(), n.text.as_str()), ("fact:lab.NO.n", "9"));

        let ledger: BTreeMap<String, String> = facts
            .iter()
            .map(|f| num(f, &sp.fmts, Part::Bare).unwrap())
            .map(|n| (n.src, n.text))
            .collect();
        assert_eq!(recheck(&ledger, &sp, &rows, &facts), Vec::<String>::new());
        // the entry of one code printed with another code's text, and a code the family does not give
        let mut wrong = ledger.clone();
        wrong.insert("fact:lab.RU.n".into(), "9".into());
        assert_eq!(
            recheck(&wrong, &sp, &rows, &facts),
            ["fact:lab.RU.n prints \"9\", the rows give \"3\""]
        );
        let mut extra = ledger.clone();
        extra.insert("fact:lab.DE.n".into(), "1".into());
        assert_eq!(
            recheck(&extra, &sp, &rows, &facts),
            ["fact:lab.DE.n: no declared fact gives it"]
        );
        // a family is not one fact another fact can read
        let two = super::Spec {
            facts: vec![
                sp.facts[0].clone(),
                ("s".into(), json!({"op": "share", "a": "lab", "b": "lab"})),
            ],
            ..sp.clone()
        };
        assert!(compute(&two, &rows)
            .unwrap_err()
            .contains("a family gives one fact per code"));
        let bad = spec(
            json!({"lab": {"op": "peak", "each": "partner", "table": "imp", "fmt": "m"}}),
            None,
        );
        assert_eq!(
            compute(&bad, &rows).unwrap_err(),
            "lab: a family (each) takes op value"
        );
    }

    /// A half-yearly table's periods (nrg_pc_204's 2025-S2, 2026-S1) are two ledger entries each, the year and the half's
    /// word (HALF_WORDS, the leaves' half.1 and half.2), beside the year entry every period gives; each is read back from
    /// the rows, and a half the rows do not give is refused by the recheck.
    #[test]
    fn half_years_are_a_year_and_a_half_word_read_back_from_the_rows() {
        let rows = [
            row("nrg_pc_204", "DE", "2025-S2", 0.38),
            row("nrg_pc_204", "DE", "2026-S1", 0.39),
            row("nrg_pc_204", "SE", "2026-S1", 0.21),
        ];
        let got: Vec<(String, String)> = halves("nrg_pc_204", &rows)
            .into_iter()
            .map(|n| (n.src, n.text))
            .collect();
        let want: Vec<(String, String)> = [
            ("2025-S2.y", "2025"),
            ("2025-S2.h", "下"),
            ("2026-S1.y", "2026"),
            ("2026-S1.h", "上"),
        ]
        .iter()
        .map(|(k, t)| (format!("period:nrg_pc_204:{k}"), t.to_string()))
        .collect();
        assert_eq!(got, want);
        assert!(
            months("nrg_pc_204", &rows).is_empty()
                && halves("une_rt_m", &[row("une_rt_m", "DE", "2026-08", 1.0)]).is_empty()
        );
        let words: Value =
            serde_json::from_str(include_str!("../runtime/leaves_py/words.zh.json")).unwrap();
        assert_eq!(
            (words["half.1"].as_str(), words["half.2"].as_str()),
            (Some(HALF_WORDS[0]), Some(HALF_WORDS[1])),
            "the leaves' half words"
        );
        let s = spec(json!({}), None);
        let facts: Vec<Fact> = Vec::new();
        let ledger = leaf_ledger(&s, &rows, &facts).unwrap();
        for (k, t) in [
            ("period:nrg_pc_204:2026-S1.y", "2026"),
            ("period:nrg_pc_204:2026-S1.h", "上"),
            ("period:nrg_pc_204:2026", "2026"),
        ] {
            assert_eq!(ledger.get(k).map(String::as_str), Some(t), "{k}");
        }
        assert_eq!(recheck(&ledger, &s, &rows, &facts), Vec::<String>::new());
        let mut wrong = ledger.clone();
        wrong.insert("period:nrg_pc_204:2026-S1.h".into(), "下".into());
        wrong.insert("period:nrg_pc_204:2026-S2.y".into(), "2026".into());
        let off = recheck(&wrong, &s, &rows, &facts);
        assert!(
            off.len() == 2
                && off[0].contains("the rows give \"上\"")
                && off[1].contains("no row of nrg_pc_204 is in that half year"),
            "{off:?}"
        );
        // a wording on this half-yearly main: "YYYY 年上半年" is the year and the half of one entry the rows hold; a half
        // no row is in, and a bare "YYYY 年", go back to be reworded with the latest half held as the example
        let tables = ["nrg_pc_204".to_string()];
        assert_eq!(
            Value::from(wording_segs("2026 年上半年德国最高", &ledger, &tables).unwrap()),
            json!([{"src": "period:nrg_pc_204:2026-S1.y"}, {"w": " 年"}, {"src": "period:nrg_pc_204:2026-S1.h"}, {"w": "半年德国最高"}])
        );
        for (text, why) in [
            (
                "2026 年下半年德国最高",
                "\"2026 年下半年\" is a half year no table of the page holds",
            ),
            ("2026 年德国最高", "\"2026 年\" names no half year or month"),
        ] {
            let e = wording_segs(text, &ledger, &tables).unwrap_err();
            assert!(
                e.contains(why) && e.contains("as \"2026 年上半年\""),
                "{text}: {e}"
            );
        }
    }

    #[test]
    fn years_and_record_dates_are_read_back_from_the_rows() {
        let rows = partners();
        let ys = periods("imp", &rows);
        let got: Vec<(&str, &str)> = ys
            .iter()
            .map(|n| (n.src.as_str(), n.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [("period:imp:2024", "2024"), ("period:imp:2021", "2021")]
        );
        let d = date_parts(&rows[6], "date").unwrap();
        let got: Vec<(&str, &str)> = d
            .iter()
            .map(|n| (n.src.as_str(), n.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("record:events/0:date.y", "2022"),
                ("record:events/0:date.m", "9"),
                ("record:events/0:date.d", "26")
            ]
        );
        assert!(date_parts(&rows[6], "label")
            .unwrap_err()
            .contains("is no date"));
        assert!(date_parts(&rows[6], "when")
            .unwrap_err()
            .contains("has no when"));

        let sp = spec(json!({}), None);
        let ledger: BTreeMap<String, String> =
            ys.into_iter().chain(d).map(|n| (n.src, n.text)).collect();
        assert_eq!(recheck(&ledger, &sp, &rows, &[]), Vec::<String>::new());
        // each src pointing at a wrong year, row, column or part, or printed otherwise, is refused
        for (src, text, why) in [
            (
                "period:imp:2019",
                "2019",
                "period:imp:2019: no row of imp is in that year",
            ),
            (
                "period:imp:2024",
                "2023",
                "period:imp:2024 prints \"2023\", the rows give \"2024\"",
            ),
            (
                "period:gas:2024",
                "2024",
                "period:gas:2024: no row of gas is in that year",
            ),
            (
                "record:events/0:date.m",
                "10",
                "record:events/0:date.m prints \"10\", the rows give \"9\"",
            ),
            (
                "record:events/1:date.y",
                "2022",
                "record:events/1:date.y: the request has no row record:events/1",
            ),
            (
                "record:events/0:label.y",
                "2022",
                "record:events/0:label.y: record:events/0:label: \"x\" is no date",
            ),
            (
                "record:events/0:date.w",
                "1",
                "record:events/0:date.w: names no part of a date (y, m, d)",
            ),
        ] {
            let mut bent = ledger.clone();
            bent.insert(src.into(), text.into());
            assert_eq!(recheck(&bent, &sp, &rows, &[]), [why], "{src}");
        }
    }

    fn dated() -> (Spec, Vec<Row>) {
        let mut rows = partners();
        rows.extend([
            row("mo", "X", "2021-01", 700.0),
            row("mo", "X", "2021-02", 900.0),
        ]);
        rows.push(cell(
            "record:notes/0",
            "notes",
            &[
                ("date", "2022-09-26"),
                ("source_name", "EUR-Lex (Regulation 2022/1369)"),
            ],
            "",
            f64::NAN,
        ));
        let s = spec(
            json!({"hi": {"op": "peak", "table": "mo", "fmt": "m"}}),
            None,
        );
        (s, rows)
    }

    #[test]
    fn a_leaf_ledger_holds_what_a_leaf_prints_and_rechecks_from_the_rows() {
        let (s, rows) = dated();
        let facts = compute(&s, &rows).unwrap();
        let l = leaf_ledger(&s, &rows, &facts).unwrap();
        for (src, text) in [
            ("fact:hi", "9 亿"),
            ("fact:hi.n", "9"),
            ("fact:hi.t.y", "2021"),
            ("fact:hi.t.m", "2"),
            ("period:imp:2024", "2024"),
            ("period:mo:2021", "2021"),
            ("period:mo:2021-01.y", "2021"),
            ("period:mo:2021-01.m", "1"),
            ("record:events/0:date.d", "26"),
            // a second record table, and the source name prints whole
            ("record:notes/0:date.m", "9"),
            (
                "record:notes/0:source_name",
                "EUR-Lex (Regulation 2022/1369)",
            ),
        ] {
            assert_eq!(l.get(src).map(String::as_str), Some(text), "{src}");
        }
        assert!(
            !l.keys()
                .any(|k| k.contains("tick") || k.ends_with(":label")),
            "{l:?}"
        );
        assert_eq!(recheck(&l, &s, &rows, &facts), Vec::<String>::new());
        // C4: a record table named by its file's path, or a src naming another table, is no ledger
        for (src, table) in [
            ("record:../a.b/ev.csv/0", "../a.b/ev.csv"),
            ("record:notes/0", "events"),
        ] {
            let mut bad = rows.clone();
            bad.push(cell(src, table, &[("date", "2022-09-26")], "", f64::NAN));
            let why = leaf_ledger(&s, &bad, &facts).err().unwrap();
            assert_eq!(why, format!("{src}: a record row's table must be its table id (not a path) and its src must name it"));
        }
        assert!(
            table_id("MIGR_ASYAPPCTZM")
                && table_id("nrg-pc")
                && !table_id("2022")
                && !table_id("data/cities.csv")
        );
        // a World Bank table by its catalogue name; a dot only with the World Bank's mark, never a path
        assert!(table_id("EN.GHG.CO2.PC.CE.AR5@2") && table_id("SP.POP.65UP.TO.ZS@2"));
        assert!(
            !table_id("cities.csv")
                && !table_id("data/cities.csv@2")
                && !table_id("@2")
                && !table_id("EN.X@3")
        );
        assert!(!table_id("X.@2") && !table_id("a..b@2") && !table_id("EN.@2"));
        // shaped as a World Bank id with lower case, as the catalogue's are; only leaf_refs decides what a page may name
        assert!(table_id("account.t.d.1@2") && table_id("cities.csv@2"));
        let mut path = rows.clone();
        path.push(row("data/mo.csv", "X", "2021-01", 1.0));
        assert_eq!(
            leaf_ledger(&s, &path, &facts).err().unwrap(),
            "series table data/mo.csv: its name must be a table id"
        );
        for (src, text, why) in [
            // a month the table lacks
            ("period:mo:2021-03.m", "3", "period:mo:2021-03.m: no row of mo is in that month"),
            // a month read as a year, and a year as a month (bus111 c)
            ("period:mo:2021-01.m", "2021", "period:mo:2021-01.m prints \"2021\", the rows give \"1\""),
            ("fact:hi.t.m", "2021", "fact:hi.t.m prints \"2021\", the rows give \"2\""),
            ("period:mo:2021-01.y", "1", "period:mo:2021-01.y prints \"1\", the rows give \"2021\""),
            // a source name that is not its row's
            (
                "record:notes/0:source_name",
                "EUR-Lex (Regulation 2022/1370)",
                "record:notes/0:source_name prints \"EUR-Lex (Regulation 2022/1370)\", the rows give \"EUR-Lex (Regulation 2022/1369)\"",
            ),
            ("record:events/0:source_name", "x", "record:events/0:source_name: record:events/0: the record has no source_name"),
            ("record:notes/0:label_en", "x", "record:notes/0:label_en: names no part of a date"),
        ] {
            let mut bent = l.clone();
            bent.insert(src.into(), text.into());
            assert_eq!(recheck(&bent, &s, &rows, &facts), [why], "{src}");
        }
    }

    #[test]
    fn a_wording_writes_its_dates_as_entries_and_no_other_number() {
        let (s, rows) = dated();
        let l = leaf_ledger(&s, &rows, &compute(&s, &rows).unwrap()).unwrap();
        let tables = ["imp".to_string(), "mo".to_string()];
        let segs = wording_segs(
            "从 2021 年 1 月起，2024 年剩{ru24_share}，{k.n}",
            &l,
            &tables,
        )
        .unwrap();
        assert_eq!(
            Value::from(segs),
            json!([
                {"w": "从 "},
                {"src": "period:mo:2021-01.y"}, {"w": " 年 "}, {"src": "period:mo:2021-01.m"},
                {"w": " 月起，"},
                {"src": "period:imp:2024"},
                {"w": " 年剩{ru24_share}，{k.n}"},
            ])
        );
        // the year alone is the first table's that holds it
        assert_eq!(
            wording_segs("2021 年", &l, &tables).unwrap(),
            [json!({"src": "period:imp:2021"}), json!({"w": " 年"})]
        );
        for (text, why) in [
            (
                "2019 年少了",
                "\"2019 年\" is a year no table of the page holds",
            ),
            (
                "从 2021 年 3 月起",
                "\"2021 年 3 月\" is a month no table of the page holds",
            ),
            ("少了 12%", "the digits 12 are no year or month of the data"),
            (
                "前一年（2021）",
                "the digits 2021 are no year or month of the data",
            ),
            (
                "２０２４ 年",
                "the digits ２０２４ are no year or month of the data",
            ),
        ] {
            let e = wording_segs(text, &l, &tables).unwrap_err();
            assert!(e.contains(why), "{text}: {e}");
            assert!(e.contains("(2021, 2024, as \"2024 年\")"), "{text}: {e}");
        }
    }

    #[test]
    fn a_leaf_page_names_only_the_dataset_ids_of_its_tables() {
        let tables = json!({"m": {"csv": "a/m.csv", "id": "MIGR_ASYAPPCTZM"}, "a": {"id": "MIGR_ASYAPPCTZA"}, "g": {"id": "MIGR_ASYAPPCTZA"}});
        assert_eq!(
            leaf_refs(&tables).unwrap(),
            ["MIGR_ASYAPPCTZA", "MIGR_ASYAPPCTZM"]
        );
        let wb = json!({"land": {"id": "AG.LND.AGRI.K2"}, "gdp": {"id": "NY.GDP.MKTP.CD"}});
        assert_eq!(
            leaf_refs(&wb).unwrap(),
            ["AG.LND.AGRI.K2", "NY.GDP.MKTP.CD"]
        );
        let bad = json!({"b": {"csv": "b.csv"}, "c": {"id": ""}});
        assert_eq!(
            leaf_refs(&bad).err().unwrap(),
            "table b: the request gives no dataset id\ntable c: the request gives no dataset id"
        );
    }

    /// Prints the ledger layer 1 gives one stored leaf request and the segments of its dek, hero unit and notes (LEAF_REQ; run
    /// with --ignored), for the gate that compares it with the stand-in's and hands both to the child.
    #[test]
    #[ignore]
    fn leaf_ledger_for_a_stored_request() {
        let req: Value = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("LEAF_REQ").unwrap()).unwrap(),
        )
        .unwrap();
        let (s, rows, tables) = stored_request(&req);
        let facts = compute(&s, &rows).unwrap();
        let ledger = leaf_ledger(&s, &rows, &facts).unwrap();
        let segs = |at: &Value| match at.as_str().map(|t| wording_segs(t, &ledger, &tables)) {
            None => Value::Null,
            Some(Ok(segs)) => Value::from(segs),
            Some(Err(e)) => json!({ "error": e }),
        };
        let spec = &req["knobs"]["spec"];
        let out = json!({
            "refs": leaf_refs(&spec["tables"]).unwrap(),
            "ledger": ledger,
            "segs": spec["hero"]["notes"].as_array().into_iter().flatten().enumerate()
                .filter(|(_, n)| n["t"].is_string())
                .map(|(i, n)| (format!("notes.{i}"), segs(&n["t"])))
                .chain([("dek".to_string(), segs(&spec["dek"])), ("unit".to_string(), segs(&spec["hero"]["unit"]))])
                .collect::<serde_json::Map<_, _>>(),
        });
        println!("leaf {}", serde_json::to_string(&out).unwrap());
    }

    /// n counts the codes of `by` the selected rows hold at its time, each once (a code with two rows there is one place),
    /// printed bare as a whole number; no row at that time fails, and recheck recomputes it from the same rows.
    #[test]
    fn n_counts_the_places_the_rows_hold_at_one_time() {
        let row = |geo: &str, time: &str, v: f64| Row {
            src: format!("series:t/A.{geo}:{time}:OBS_VALUE"),
            table: "t".into(),
            dims: BTreeMap::from([
                ("geo".to_string(), geo.to_string()),
                ("freq".to_string(), "A".to_string()),
            ]),
            time: time.into(),
            value: v,
        };
        let rows = vec![
            row("SE", "2025", 65.4),
            row("BE", "2025", 14.9),
            row("SE", "2025", 1.0),
            row("DE", "2024", 20.0),
        ];
        let spec = Spec {
            facts: vec![(
                "drawn".into(),
                json!({"op": "n", "by": "geo", "table": "t", "time": "2025", "fmt": "n"}),
            )],
            fmts: json!({}),
            members: None,
            asked_places: None,
            basis: None,
        };
        let facts = compute(&spec, &rows).unwrap();
        assert_eq!((facts[0].v, facts[0].n), (2.0, Some(2)));
        assert_eq!(facts[0].reads.len(), 3);
        let ledger = leaf_ledger(&spec, &rows, &facts).unwrap();
        assert_eq!(ledger.get("fact:drawn.n").map(String::as_str), Some("2"));
        assert_eq!(recheck(&ledger, &spec, &rows, &facts), Vec::<String>::new());
        let none = Spec {
            facts: vec![(
                "drawn".into(),
                json!({"op": "n", "by": "geo", "table": "t", "time": "2023", "fmt": "n"}),
            )],
            ..spec
        };
        assert!(compute(&none, &rows)
            .unwrap_err()
            .contains("n has no row at 2023"));
    }

    /// position is where a code stands among the codes of `by` at its time, highest first: 1 and the codes above it, a tie
    /// sharing the place, a code with two rows there summed as n counts it once; printed bare as a whole number and
    /// rechecked from the same rows; a code with no row at that time fails.
    #[test]
    fn position_is_one_and_the_codes_above_the_code() {
        let row = |geo: &str, time: &str, v: f64| Row {
            src: format!("series:t/A.{geo}:{time}:OBS_VALUE"),
            table: "t".into(),
            dims: BTreeMap::from([
                ("geo".to_string(), geo.to_string()),
                ("freq".to_string(), "A".to_string()),
            ]),
            time: time.into(),
            value: v,
        };
        let rows = vec![
            row("SE", "2025", 65.4),
            row("BE", "2025", 14.9),
            row("FI", "2025", 14.9),
            row("DE", "2025", 10.0),
            row("DE", "2025", 6.0),
            row("PL", "2024", 99.0),
        ];
        let q = |code: &str| json!({"op": "position", "by": "geo", "table": "t", "time": "2025", "code": code, "fmt": "n"});
        let at = |code: &str| {
            let spec = Spec {
                facts: vec![("pos".into(), q(code))],
                fmts: json!({}),
                members: None,
                asked_places: None,
                basis: None,
            };
            compute(&spec, &rows).map(|f| (f[0].v, spec, f))
        };
        assert_eq!(at("SE").unwrap().0, 1.0);
        // DE's two rows are 16, so it is second; BE and FI tie at 14.9 and share the third place
        assert_eq!(
            (
                at("DE").unwrap().0,
                at("BE").unwrap().0,
                at("FI").unwrap().0
            ),
            (2.0, 3.0, 3.0)
        );
        let (_, spec, facts) = at("BE").unwrap();
        let ledger = leaf_ledger(&spec, &rows, &facts).unwrap();
        assert_eq!(ledger.get("fact:pos.n").map(String::as_str), Some("3"));
        assert_eq!(recheck(&ledger, &spec, &rows, &facts), Vec::<String>::new());
        assert!(at("PL")
            .unwrap_err()
            .contains("position has no row of PL at 2025"));
    }

    /// excluded names each pair the registry leaves out of a flow, keeps each in the ledger as excluded by registry (apart from
    /// a pair with no row), and refuses a pair the rows hold (the data would contradict the registry) and an empty list.
    #[test]
    fn excluded_names_the_registry_s_pairs_and_refuses_one_the_rows_hold() {
        let row = |a: &str, b: &str, v: f64| Row {
            src: format!("series:t/A.{a}.{b}:2024:OBS_VALUE"),
            table: "t".into(),
            dims: BTreeMap::from([
                ("s".to_string(), a.to_string()),
                ("d".to_string(), b.to_string()),
            ]),
            time: "2024".into(),
            value: v,
        };
        let rows = vec![row("G", "IND", 5.0), row("G", "TRA", 0.0)];
        let q = |pairs: Value| json!({"op": "excluded", "table": "t", "time": "2024", "by": ["s", "d"], "pairs": pairs, "fmt": "n"});
        let spec = Spec {
            facts: vec![("x".into(), q(json!([["N", "IND"], ["N", "TRA"]])))],
            fmts: json!({}),
            members: None,
            asked_places: None,
            basis: None,
        };
        let facts = compute(&spec, &rows).unwrap();
        assert_eq!(
            (facts[0].v, facts[0].who.as_slice()),
            (2.0, &["N>IND".to_string(), "N>TRA".to_string()][..])
        );
        assert!(facts[0].reads.is_empty());
        let ledger = leaf_ledger(&spec, &rows, &facts).unwrap();
        assert_eq!(
            ledger.get("excluded:N>IND").map(String::as_str),
            Some(EXCLUDED_TEXT)
        );
        assert_eq!(
            ledger
                .keys()
                .filter(|k| k.starts_with(EXCLUDED_SRC))
                .count(),
            2
        );
        assert!(!ledger.keys().any(|k| k.starts_with(NOROW_SRC)));
        assert_eq!(recheck(&ledger, &spec, &rows, &facts), Vec::<String>::new());
        let held = Spec {
            facts: vec![("x".into(), q(json!([["G", "TRA"]])))],
            ..spec.clone()
        };
        assert!(compute(&held, &rows).unwrap_err().contains(
            "the registry leaves G>TRA out, and the row series:t/A.G.TRA:2024:OBS_VALUE holds it"
        ));
        let none = Spec {
            facts: vec![("x".into(), q(json!([])))],
            ..spec
        };
        assert!(compute(&none, &rows)
            .unwrap_err()
            .contains("excluded names no pair"));
    }

    /// B11: a value fact's display part (`.r`) holds three significant digits, never more places than its format's, and is
    /// in the ledger only when that is fewer places; the recheck recomputes it, a made-up one refused, one where the fact
    /// has none too. Other formats and ops have none.
    #[test]
    fn the_display_part_rounds_to_three_significant_digits_and_is_rechecked() {
        let f = |key: &str, op: &str, v: f64, fmt: &str| Fact {
            key: key.into(),
            op: op.into(),
            v,
            t: None,
            n: None,
            who: Vec::new(),
            fmt: fmt.into(),
            reads: Vec::new(),
            exact: None,
        };
        let fmts = json!({"k2": {"dec": 2, "scale": 1, "suffix": " u"}, "k0": {"dec": 0}, "m": {"dec": 2, "scale": 0.001}});
        let shown = |v: f64, fmt: &str| {
            display(&f("a", "value", v, fmt), &fmts)
                .unwrap()
                .map(|n| (n.src, n.text))
        };
        assert_eq!(
            shown(60699.059, "k2"),
            Some(("fact:a.r".into(), "60,699".into()))
        );
        assert_eq!(shown(45.67, "k2").unwrap().1, "45.7");
        assert_eq!(
            shown(5.678, "k2"),
            None,
            "three significant digits are the format's two places"
        );
        assert_eq!(shown(0.631, "k2"), None, "under 1: the format's two places");
        assert_eq!(
            shown(-1234.5, "k2").unwrap().1,
            "-1,234",
            "a minus kept, half to even"
        );
        assert_eq!(
            shown(15000.0, "m").unwrap().1,
            "15.0",
            "the format's scale first"
        );
        assert_eq!(shown(60699.0, "k0"), None, "no places: no display part");
        for fmt in ["pct", "n", "x"] {
            assert_eq!(shown(1234.56, fmt), None, "{fmt}");
        }
        assert_eq!(
            display(&f("a", "sum", 1234.56, "k2"), &fmts).unwrap(),
            None,
            "a value fact's only"
        );
        assert!(display(&f("a", "value", 1.0, "nope"), &fmts).is_err());
        // in the ledger and rechecked, from a request's rows
        let row = |code: &str, v: f64| Row {
            src: format!("series:t/{code}:2024:OBS_VALUE"),
            table: "t".into(),
            dims: BTreeMap::from([("s".to_string(), code.to_string())]),
            time: "2024".into(),
            value: v,
        };
        let rows = vec![row("A", 60699.059), row("B", 0.631)];
        let q = |code: &str| json!({"op": "value", "table": "t", "time": "2024", "fmt": "k2", "filter": {"s": code}});
        let spec = Spec {
            facts: vec![("a".into(), q("A")), ("b".into(), q("B"))],
            fmts,
            members: None,
            asked_places: None,
            basis: None,
        };
        let facts = compute(&spec, &rows).unwrap();
        let ledger = leaf_ledger(&spec, &rows, &facts).unwrap();
        assert_eq!(
            (ledger["fact:a.n"].as_str(), ledger["fact:a.r"].as_str()),
            ("60,699.06", "60,699")
        );
        assert!(ledger.contains_key("fact:b.n") && !ledger.contains_key("fact:b.r"));
        assert_eq!(recheck(&ledger, &spec, &rows, &facts), Vec::<String>::new());
        let mut bent = ledger.clone();
        bent.insert("fact:a.r".into(), "60,700".into());
        assert_eq!(
            recheck(&bent, &spec, &rows, &facts),
            ["fact:a.r prints \"60,700\", the rows give \"60,699\""]
        );
        let mut extra = ledger.clone();
        extra.insert("fact:b.r".into(), "0.6".into());
        assert_eq!(
            recheck(&extra, &spec, &rows, &facts),
            ["fact:b.r: b has no display part"]
        );
    }
}
