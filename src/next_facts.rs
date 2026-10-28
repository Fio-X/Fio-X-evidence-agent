//! New route, visual group: the page's facts, computed and formatted here so a second-layer leaf only prints the text it is
//! handed. A fact is a declared query: an op over the request's rows (value, mean, peak, low, last, count, rest) or over two
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
/// that states the unit once), `fact:<key>.t` its period, `fact:<key>.tick<i>` the i-th tick of an axis running to it.
pub const FACT_SRC: &str = "fact:";

/// Where a year a table's rows cover is: `period:<table>:<year>`, its text the year; a month is two entries read from
/// one key, `period:<table>:<YYYY-MM>.y` and `.m`, so a date in words prints its year and month from the same period.
pub const PERIOD_SRC: &str = "period:";

/// Where a sourced record's cell is: `record:<table>/<i>` the row, then `:<column>` and `.y`, `.m`, `.d` a date's parts.
pub const RECORD_SRC: &str = "record:";

/// Where a series row was read (the series, its row key, period and column): what makes its table one a page dates.
const SERIES_SRC: &str = "series:";

/// The record columns a page prints whole, as the cell gives them (`record:<table>/<i>:<column>`): a source's name, which
/// may hold a regulation's number. No other column prints whole.
const RECORD_TEXT: &[&str] = &["source_name"];

/// A table as a mark names it (`record:<table>/<i>`, `period:<table>:...`): its id, a letter first, then letters, digits,
/// `_` or `-`. Never a file's path: the request's table list says where a table's file is, and no path goes on a page.
pub fn table_id(t: &str) -> bool {
    t.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// A dataset's id as a page's sources name it (`data-ref`), e.g. MIGR_ASYAPPCTZM: an upper-case letter first, then
/// upper-case letters, digits and `_`. A number such as "2022" is never one.
pub fn dataset_id(t: &str) -> bool {
    t.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// The table ids a leaf page may name in its sources: the dataset id each table of the request was read from (`"id"` in
/// the spec's table list, which layer 1 fills), sorted, each once. The same list goes to the child and to the page check;
/// it is never read from the page's wording. Err names each table with no id or one that is not a `dataset_id`.
pub fn leaf_refs(tables: &Value) -> Result<Vec<String>, String> {
    let mut refs = Vec::new();
    let mut off = Vec::new();
    for (name, t) in tables.as_object().into_iter().flatten() {
        match t["id"].as_str() {
            Some(id) if dataset_id(id) => refs.push(id.to_string()),
            other => off.push(format!("table {name}: {other:?} is no dataset id")),
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
const TOTAL_CODE: &str = "TOTAL";

/// The dimension a count runs over when its query names none: Eurostat's place dimension.
const PLACE_DIM: &str = "geo";

/// How many ticks an axis aims at; the step is the first of 1, 2, 5, 10 times a power of ten that keeps to it.
const TICKS: f64 = 4.0;

/// One row of the request's long table: where it was read, its table, its dimension codes, its period and its value.
#[derive(Clone, Debug, PartialEq)]
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
#[derive(Clone, Debug)]
pub struct Spec {
    pub facts: Vec<(String, Value)>,
    pub fmts: Value,
    pub members: Option<Vec<String>>,
}

/// What the program computed for one fact.
#[derive(Clone, Debug, PartialEq)]
pub struct Fact {
    pub key: String,
    pub op: String,
    pub v: f64,
    /// The period it was read at (peak, low, last).
    pub t: Option<String>,
    /// How many values it covers (mean: the periods; rest: the codes above zero).
    pub n: Option<usize>,
    /// The member codes counted (count), sorted.
    pub who: Vec<String>,
    pub fmt: String,
    /// The sources of the rows it read in request order, or `fact:<a>`, `fact:<b>` for one computed from two facts.
    pub reads: Vec<String>,
}

/// Which of a fact's ledger entries a number is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Part {
    Text,
    Bare,
    Period,
    /// The period's year, month or half (`.t.y`, `.t.m`, `.t.h`) as a whole number, for a leaf that writes the words.
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
            match family(key, q, spec, rows) {
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
    if op == "count" {
        let members = members(key, spec)?;
        let time = word(key, &q["time"], "time")?;
        let above = q["above"]
            .as_f64()
            .ok_or_else(|| format!("{key}: count has no number as above"))?;
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
        let (num, den) = (side("a")?, side("b")?);
        if den.is_empty() {
            return Err(format!("{key}: count has no row of b at {time}"));
        }
        let mut hit: Vec<String> = members
            .iter()
            .filter(|g| {
                den.get(*g)
                    .is_some_and(|d| *d != 0.0 && num.get(*g).copied().unwrap_or(0.0) / d > above)
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
            // each period's total over the rows, in the order the periods first appear
            let mut ser: Vec<(String, f64)> = Vec::new();
            for r in &picked {
                let v = finite(key, r)?;
                match ser.iter_mut().find(|(t, _)| *t == r.time) {
                    Some((_, s)) => *s += v,
                    None => ser.push((r.time.clone(), 0.0 + v)),
                }
            }
            ser.retain(|(t, _)| *t >= from);
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
                fmt: fmt.clone(),
                reads: rs.iter().map(|r| r.src.clone()).collect(),
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
            let s = fixed(f.v.abs() * 100.0, 0, false);
            if bare {
                s
            } else {
                s + "%"
            }
        }
        "n" => fixed(f.v, 0, false),
        "x" => fixed(f.v, 1, false),
        k => {
            let m = scaled(f, fmts, k)?;
            let s = fixed(f.v * m.0, m.1, true);
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
/// value even when it rounds to 0, and a comma between thousands when `sep`: what Python's `f"{x:,.{dec}f}"` prints.
fn fixed(x: f64, dec: usize, sep: bool) -> String {
    let sign = if x.is_sign_negative() { "-" } else { "" };
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
                .ok_or_else(|| format!("{}: the period {t:?} has no such part", f.key))?;
            Num {
                src: src(&format!(".t.{tail}")),
                value: f64::from(v),
                text: v.to_string(),
            }
        }
    })
}

/// The ticks of an axis from 0 to a fact (0 left out), in the fact's format without its unit: steps of 1, 2, 5 or 10
/// times a power of ten in the printed unit, the first that gives at most `TICKS` ticks, and never finer than the
/// format's last printed place (with `dec` 0 a top of 2 gets 1, 2, not 0.5, 1, 1.5, 2 printed as 0, 1, 2, 2). Err for a
/// fact that is not above 0 or not in a scaled format, an axis shorter than one printed place, or a tick whose text
/// does not read back as its value.
pub fn ticks(f: &Fact, fmts: &Value) -> Result<Vec<Num>, String> {
    let (scale, dec, _) = scaled(f, fmts, &f.fmt)?;
    let top = f.v * scale;
    if !(top.is_finite() && top > 0.0) {
        return Err(format!("{}: an axis needs a fact above 0", f.key));
    }
    let place = 10f64.powi(-(dec as i32));
    let mag = 10f64.powf((top / TICKS).log10().floor());
    let step = [1.0, 2.0, 5.0, 10.0]
        .into_iter()
        .map(|m| m * mag)
        .find(|s| top / s <= TICKS)
        .unwrap_or(10.0 * mag)
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

/// Every entry a leaf may print, src to text: per fact its text, its bare number and its period's parts (`.t.y`, then
/// `.t.m` or `.t.h`, whichever the period has); per series table its years and months; per record row its date's parts
/// when the date cell is a date, and each `RECORD_TEXT` cell whole. No tick (no leaf prints one). Err names each fact
/// whose text or bare number cannot be made, and each record row whose table is not a `table_id` (one per line).
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
        if f.t.is_some() {
            // a period has a year and at most one of a month or a half
            for n in [Part::Year, Part::Month, Part::Half]
                .into_iter()
                .filter_map(|p| num(f, &spec.fmts, p).ok())
            {
                out.insert(n.src, n.text);
            }
        }
    }
    let mut tables: Vec<&str> = Vec::new();
    for r in rows.iter().filter(|r| r.src.starts_with(SERIES_SRC)) {
        if !tables.contains(&r.table.as_str()) {
            tables.push(&r.table);
        }
    }
    off.extend(tables.iter().filter(|t| !table_id(t)).map(|t| format!("series table {t}: its name must be a table id")));
    for t in tables.into_iter().filter(|t| table_id(t)) {
        for n in periods(t, rows).into_iter().chain(months(t, rows)) {
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
        let flush = |segs: &mut Vec<Value>, words: &mut String| {
            if !words.is_empty() {
                segs.push(json!({ "w": std::mem::take(words) }));
            }
        };
        match (year, month, after(end, '年')) {
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
        let example = years
            .last()
            .map_or(String::new(), |y| format!(", as \"{y} 年\""));
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
        let what = if at.contains('-') { "month" } else { "year" };
        return periods(table, rows)
            .into_iter()
            .chain(months(table, rows))
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
            Some((k, t)) if t == "n" || t == "t" || t.starts_with("tick") => (k, t),
            _ => (rest, ""),
        };
        let Some(f) = by_key.get(key) else {
            off.push(format!("{src}: no declared fact gives it"));
            continue;
        };
        let want = match tail {
            "" => num(f, &spec.fmts, Part::Text),
            "n" => num(f, &spec.fmts, Part::Bare),
            "t" => num(f, &spec.fmts, Part::Period),
            "t.y" => num(f, &spec.fmts, Part::Year),
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

/// For the gates: a stored leaf request (`LEAF_REQ`, as the gate scripts dump it) as its spec, its rows (the stand-in's
/// ledger lines, which have no table, left out) and its tables in the order the spec gives them.
#[cfg(test)]
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
        }
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
            (-0.4, 0, false, "-0"),
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
        assert_eq!(num(&half, &spec.fmts, Part::Half).unwrap().text, "2");
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
        for (src, table) in [("record:../a.b/ev.csv/0", "../a.b/ev.csv"), ("record:notes/0", "events")] {
            let mut bad = rows.clone();
            bad.push(cell(src, table, &[("date", "2022-09-26")], "", f64::NAN));
            let why = leaf_ledger(&s, &bad, &facts).err().unwrap();
            assert_eq!(why, format!("{src}: a record row's table must be its table id (not a path) and its src must name it"));
        }
        assert!(table_id("MIGR_ASYAPPCTZM") && table_id("nrg-pc") && !table_id("2022") && !table_id("data/cities.csv"));
        let mut path = rows.clone();
        path.push(row("data/mo.csv", "X", "2021-01", 1.0));
        assert_eq!(leaf_ledger(&s, &path, &facts).err().unwrap(), "series table data/mo.csv: its name must be a table id");
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

    /// Prints the ledger layer 1 gives one stored leaf request and the segments of its dek and hero unit (LEAF_REQ; run
    /// with --ignored), for the gate that compares it with the stand-in's and hands both to the child.
    #[test]
    fn a_leaf_page_names_only_the_dataset_ids_of_its_tables() {
        let tables = json!({"m": {"csv": "a/m.csv", "id": "MIGR_ASYAPPCTZM"}, "a": {"id": "MIGR_ASYAPPCTZA"}, "g": {"id": "MIGR_ASYAPPCTZA"}});
        assert_eq!(leaf_refs(&tables).unwrap(), ["MIGR_ASYAPPCTZA", "MIGR_ASYAPPCTZM"]);
        let bad = json!({"a": {"id": "2022"}, "b": {"csv": "b.csv"}, "c": {"id": "nrg_pc"}});
        assert_eq!(
            leaf_refs(&bad).err().unwrap(),
            "table a: Some(\"2022\") is no dataset id\ntable b: None is no dataset id\ntable c: Some(\"nrg_pc\") is no dataset id"
        );
    }

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
            "segs": {"dek": segs(&spec["dek"]), "unit": segs(&spec["hero"]["unit"])},
        });
        println!("leaf {}", serde_json::to_string(&out).unwrap());
    }
}
