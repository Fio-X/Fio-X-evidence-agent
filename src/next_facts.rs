//! New route, visual group: the page's facts, computed and formatted here so a second-layer leaf only prints the text it is
//! handed. A fact is a declared query: an op over the request's rows (value, mean, peak, low, last, count, rest) or over two
//! other facts (share, change, times, minus, plus); nothing names a topic. Ported from the gas-1027 prototype's facts.py,
//! whose output the tests compare text for text.
//! Every fact keeps its op and the sources of the rows it read, and `recheck` recomputes every `fact:` entry of a page's
//! ledger from the request rows, so no fact is taken on the word of whoever built the page.

use crate::next_ledger::{Label, Num, LABEL_SRC};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Where a fact's ledger entries are: `fact:<key>` its number with its unit, `fact:<key>.n` the number alone (for a layout
/// that states the unit once), `fact:<key>.t` its period, `fact:<key>.tick<i>` the i-th tick of an axis running to it.
pub const FACT_SRC: &str = "fact:";

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
}

/// Every declared fact, in declared order. Err lists each fact that cannot be computed (one per line): a query that does
/// not read as one, a row set with no row, a zero divisor, a fact it needs that is missing or fails, or members it needs
/// that the spec does not hold. No value is guessed.
pub fn compute(spec: &Spec, rows: &[Row]) -> Result<Vec<Fact>, String> {
    let queries: BTreeMap<&str, &Value> = spec.facts.iter().map(|(k, q)| (k.as_str(), q)).collect();
    let mut done: BTreeMap<String, Result<Fact, String>> = BTreeMap::new();
    let mut out = Vec::new();
    let mut off = Vec::new();
    for (key, _) in &spec.facts {
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

/// A fact's text: `pct` a whole percent of its size, `n` a whole number, `x` one decimal, any other format its `scale`,
/// `dec` places with a comma between thousands and (unless `bare`) its `suffix`. Err for a format the spec does not hold.
pub fn text(f: &Fact, fmts: &Value, bare: bool) -> Result<String, String> {
    Ok(match f.fmt.as_str() {
        "pct" => format!("{}%", fixed(f.v.abs() * 100.0, 0, false)),
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

/// One of a fact's ledger entries as a number of the page: its text, its bare number, or its period (with the spec's time
/// prefix). Err when the format is not in the spec or the fact has no period.
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
    })
}

/// The ticks of an axis from 0 to a fact (0 left out), in the fact's format without its unit: steps of 1, 2, 5 or 10
/// times a power of ten in the printed unit, the first that gives at most `TICKS` ticks. Err for a fact that is not above
/// 0 or not in a scaled format.
pub fn ticks(f: &Fact, fmts: &Value) -> Result<Vec<Num>, String> {
    let (scale, dec, _) = scaled(f, fmts, &f.fmt)?;
    let top = f.v * scale;
    if !(top.is_finite() && top > 0.0) {
        return Err(format!("{}: an axis needs a fact above 0", f.key));
    }
    let mag = 10f64.powf((top / TICKS).log10().floor());
    let step = [1.0, 2.0, 5.0, 10.0]
        .into_iter()
        .map(|m| m * mag)
        .find(|s| top / s <= TICKS)
        .unwrap_or(10.0 * mag);
    Ok((1..)
        .map(|i| (i, i as f64 * step))
        .take_while(|(_, v)| *v <= top)
        .map(|(i, v)| Num {
            src: format!("{FACT_SRC}{}.tick{i}", f.key),
            value: v / scale,
            text: fixed(v, dec, true),
        })
        .collect())
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
/// count, members and the rows it read), and each `fact:` entry of the page's ledger against the text recomputed for it.
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
        let (key, tail) = rest.split_once('.').unwrap_or((rest, ""));
        let Some(f) = by_key.get(key) else {
            off.push(format!("{src}: no declared fact gives it"));
            continue;
        };
        let want = match tail {
            "" => num(f, &spec.fmts, Part::Text),
            "n" => num(f, &spec.fmts, Part::Bare),
            "t" => num(f, &spec.fmts, Part::Period),
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
    off
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
            assert_eq!(text(f, &spec.fmts, true).unwrap(), g["bare"], "{k} bare");
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
                ..f
            },
            &fmts
        )
        .is_err());
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
}
