//! NEWSROOM_NUMBER_AUDIT_LOG=1 (exact, default off). Record only: every number in a claim's
//! text and in the reader-visible text of a publication plan is looked up in the computation
//! rows saved on disk. The result is one side file (shadow/record_number_audit-<key>.json,
//! written by verify.rs `write_record_only`). It is never read by a check and changes no
//! status, error, warning, claim or artifact.
//!
//! The extraction and matching rules follow runtime/pi/number_shadow.mjs (display precision,
//! percent and scale words, years/dates/ordinals/codes skipped), without a regex dependency.
//! Derived candidates are the bounded subset: counts, sums, means, medians, extremes, ranges,
//! shares, pairwise differences and ratios. Per-group totals are not derived.

use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

const MAX_DERIVED: usize = 20000;
const ALL_PAIRS_LIMIT: usize = 30;
const ROW_PAIR_LIMIT: usize = 200;
const MAX_ENTRIES: usize = 4000;

pub fn enabled() -> bool {
    std::env::var("NEWSROOM_NUMBER_AUDIT_LOG").as_deref() == Ok("1")
}

// ---------------------------------------------------------------- extraction

#[derive(Debug, Clone)]
struct Num {
    raw: String,
    index: usize,
    skipped: Option<&'static str>,
    value: f64,
    decimals: usize,
    percent: bool,
    scale: f64,
    /// A CJK scale word (千, 万, 亿): the figure may be in that unit (176489.6千吨, 355.9万 of a 10k_ha column).
    unit_word: bool,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

fn is_letter(c: Option<char>) -> bool {
    c.map(|c| c.is_alphabetic()).unwrap_or(false)
}

fn boundary_before(c: &[char], i: usize) -> bool {
    i == 0 || !is_word(c[i - 1])
}

fn boundary_after(c: &[char], e: usize) -> bool {
    e >= c.len() || !is_word(c[e])
}

/// Possible ends of `min..=max` digits starting at `j`, longest first.
fn digit_ends(c: &[char], j: usize, min: usize, max: usize) -> Vec<usize> {
    let mut n = 0;
    while n < max && j + n < c.len() && c[j + n].is_ascii_digit() {
        n += 1;
    }
    if n < min {
        return Vec::new();
    }
    (min..=n).rev().map(|k| j + k).collect()
}

fn is_date_sep(ch: char) -> bool {
    matches!(ch, '-' | '/' | '.')
}

fn date_ymd(c: &[char], i: usize) -> Option<usize> {
    if !boundary_before(c, i) {
        return None;
    }
    let a = digit_ends(c, i, 4, 4).first().copied()?;
    if !c.get(a).copied().map(is_date_sep).unwrap_or(false) {
        return None;
    }
    for e2 in digit_ends(c, a + 1, 1, 2) {
        if c.get(e2).copied().map(is_date_sep).unwrap_or(false) {
            for e3 in digit_ends(c, e2 + 1, 1, 2) {
                if boundary_after(c, e3) {
                    return Some(e3);
                }
            }
        }
    }
    None
}

fn date_dmy(c: &[char], i: usize) -> Option<usize> {
    if !boundary_before(c, i) {
        return None;
    }
    for e1 in digit_ends(c, i, 1, 2) {
        if c.get(e1).copied().map(is_date_sep).unwrap_or(false) {
            for e2 in digit_ends(c, e1 + 1, 1, 2) {
                if c.get(e2).copied().map(is_date_sep).unwrap_or(false) {
                    for e3 in digit_ends(c, e2 + 1, 2, 4) {
                        if boundary_after(c, e3) {
                            return Some(e3);
                        }
                    }
                }
            }
        }
    }
    None
}

fn clock_time(c: &[char], i: usize) -> Option<usize> {
    if !boundary_before(c, i) {
        return None;
    }
    for e1 in digit_ends(c, i, 1, 2) {
        if c.get(e1) == Some(&':') {
            if let Some(&e2) = digit_ends(c, e1 + 1, 2, 2).first() {
                if c.get(e2) == Some(&':') {
                    if let Some(&e3) = digit_ends(c, e2 + 1, 2, 2).first() {
                        if boundary_after(c, e3) {
                            return Some(e3);
                        }
                    }
                }
                if boundary_after(c, e2) {
                    return Some(e2);
                }
            }
        }
    }
    None
}

fn skip_spaces(c: &[char], mut j: usize) -> usize {
    while j < c.len() && c[j].is_whitespace() {
        j += 1;
    }
    j
}

fn year_range(c: &[char], i: usize) -> Option<usize> {
    let a = digit_ends(c, i, 4, 4).first().copied()?;
    let j = skip_spaces(c, a);
    if !matches!(c.get(j), Some('-') | Some('–') | Some('—')) {
        return None;
    }
    let k = skip_spaces(c, j + 1);
    for e in digit_ends(c, k, 2, 4) {
        if boundary_after(c, e) && c.get(skip_spaces(c, e)) != Some(&'%') {
            return Some(e);
        }
    }
    None
}

fn find_all(c: &[char], matcher: fn(&[char], usize) -> Option<usize>) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_digit() {
            if let Some(end) = matcher(c, i) {
                out.push((i, end));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

const SUFFIXES: [&str; 20] = [
    "percentage points",
    "percentage point",
    "percent points",
    "percent point",
    "per cent",
    "percent",
    "万亿",
    "百万",
    "million",
    "billion",
    "trillion",
    "thousand",
    "mn",
    "bn",
    "tn",
    "pp",
    "%",
    "万",
    "亿",
    "千",
];

const NAME_LABELS: [&str; 24] = [
    "article", "section", "chapter", "figure", "fig.", "fig", "table", "phase", "round", "stage",
    "tier", "level", "type", "group", "class", "part", "step", "volume", "vol.", "vol", "no.",
    "no", "page", "pages",
];
const NAME_LABELS_MORE: [&str; 9] = [
    "p.", "pp.", "appendix", "annex", "rule", "resolution", "protocol", "schedule", "",
];

fn ends_with_label(before: &[char]) -> bool {
    let mut end = before.len();
    while end > 0 && before[end - 1].is_whitespace() {
        end -= 1;
    }
    let head: String = before[..end].iter().collect::<String>().to_lowercase();
    NAME_LABELS
        .iter()
        .chain(NAME_LABELS_MORE.iter())
        .filter(|label| !label.is_empty())
        .any(|label| {
            head.ends_with(label)
                && !head[..head.len() - label.len()].chars().last().map(|ch| ch.is_alphabetic()).unwrap_or(false)
        })
}

/// The suffix at the start of `rest`: (consumed chars, lowercase text).
fn suffix_at(rest: &[char]) -> Option<(usize, String)> {
    let skip = usize::from(rest.first().map(|c| c.is_whitespace()).unwrap_or(false));
    let tail = &rest[skip..];
    let lower: String = tail.iter().take(20).collect::<String>().to_lowercase();
    for word in SUFFIXES {
        if lower.starts_with(word) {
            return Some((skip + word.chars().count(), word.to_string()));
        }
    }
    let first = *tail.first()?;
    if "kKmMbBtT".contains(first) && !is_letter(tail.get(1).copied()) {
        return Some((skip + 1, first.to_lowercase().to_string()));
    }
    None
}

fn scale_of(suffix: &str) -> f64 {
    match suffix {
        "k" | "thousand" | "千" => 1e3,
        "m" | "mn" | "million" | "百万" => 1e6,
        "b" | "bn" | "billion" => 1e9,
        "t" | "tn" | "trillion" | "万亿" => 1e12,
        "万" => 1e4,
        "亿" => 1e8,
        _ => 1.0,
    }
}

fn is_percent_word(suffix: &str) -> bool {
    matches!(
        suffix,
        "%" | "percent" | "per cent" | "pp" | "percentage points" | "percentage point" | "percent points"
    )
}

/// Letters right before a trailing '-' that include an uppercase one ("Covid-", "H-"), looking at the last 12 chars.
fn upper_name_before_dash(before: &[char]) -> bool {
    let start = before.len().saturating_sub(12);
    let slice = &before[start..];
    if slice.last() != Some(&'-') {
        return false;
    }
    let mut j = slice.len() - 1;
    let mut upper = false;
    while j > 0 && slice[j - 1].is_alphabetic() {
        j -= 1;
        upper |= slice[j].is_uppercase();
    }
    upper
}

fn extract_numbers(text: &str) -> Vec<Num> {
    let c: Vec<char> = text.chars().collect();
    let mut masks: Vec<(usize, usize, &'static str)> = Vec::new();
    let patterns: [(fn(&[char], usize) -> Option<usize>, &'static str); 4] = [
        (date_ymd, "date"),
        (date_dmy, "date"),
        (clock_time, "time"),
        (year_range, "year_range"),
    ];
    for (matcher, reason) in patterns {
        for (s, e) in find_all(&c, matcher) {
            if !masks.iter().any(|m| s < m.1 && e > m.0) {
                masks.push((s, e, reason));
            }
        }
    }
    let mut out: Vec<Num> = masks
        .iter()
        .map(|m| Num {
            raw: c[m.0..m.1].iter().collect(),
            index: m.0,
            skipped: Some(m.2),
            value: 0.0,
            decimals: 0,
            percent: false,
            scale: 1.0,
            unit_word: false,
        })
        .collect();
    let in_mask = |i: usize| masks.iter().any(|m| i >= m.0 && i < m.1);

    let mut i = 0;
    while i < c.len() {
        if !c[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // (\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?
        let start = i;
        let mut j = i;
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        if j - start <= 3 {
            let mut k = j;
            let mut groups = 0;
            while k + 3 < c.len() + 0 && c[k] == ',' && c[k + 1..k + 4].iter().all(|d| d.is_ascii_digit()) {
                k += 4;
                groups += 1;
            }
            if groups > 0 {
                j = k;
            }
        }
        let int_end = j;
        let mut decimals_len = 0;
        if j + 1 < c.len() && c[j] == '.' && c[j + 1].is_ascii_digit() {
            let mut k = j + 1;
            while k < c.len() && c[k].is_ascii_digit() {
                k += 1;
            }
            decimals_len = k - j - 1;
            j = k;
        }
        let end = j;
        i = end;
        if in_mask(start) {
            continue;
        }
        let raw: String = c[start..end].iter().collect();
        let before = &c[..start];
        let prev = before.last().copied();
        let mark = |reason: &'static str| Num {
            raw: raw.clone(),
            index: start,
            skipped: Some(reason),
            value: 0.0,
            decimals: 0,
            percent: false,
            scale: 1.0,
            unit_word: false,
        };
        let has_decimal = decimals_len > 0;
        if prev == Some('.') && before.len() >= 2 && before[before.len() - 2].is_ascii_digit() {
            continue;
        }
        if is_letter(prev) && !prev.map(is_cjk).unwrap_or(false) {
            out.push(mark("name_or_code"));
            continue;
        }
        if prev == Some('-') && upper_name_before_dash(before) {
            out.push(mark("name_or_code"));
            continue;
        }
        let mut b = before.len();
        while b > 0 && before[b - 1].is_whitespace() {
            b -= 1;
        }
        if b > 0 && before[b - 1] == '第' {
            out.push(mark("ordinal"));
            continue;
        }
        if ends_with_label(before) {
            out.push(mark("name_or_code"));
            continue;
        }
        if matches!(prev, Some('\'') | Some('’')) && !has_decimal && end - start == 2 {
            out.push(mark("year"));
            continue;
        }
        let next = c.get(end).copied();
        if (prev == Some('[') && next == Some(']'))
            || (prev == Some('(') && next == Some(')') && !has_decimal && end - start <= 2)
        {
            out.push(mark("citation"));
            continue;
        }
        let rest = &c[end..];
        let word: String = rest.iter().take(3).collect::<String>().to_lowercase();
        let ordinal_suffix = ["st", "nd", "rd", "th"]
            .iter()
            .any(|s| word.starts_with(s) && !is_word(rest.get(2).copied().unwrap_or(' ')));
        if ordinal_suffix {
            out.push(mark("ordinal"));
            continue;
        }
        if matches!(rest.first(), Some('月') | Some('日') | Some('号'))
            || (rest.first() == Some(&' ') && matches!(rest.get(1), Some('月') | Some('日') | Some('号')))
        {
            out.push(mark("date"));
            continue;
        }
        if matches!(rest.first(), Some('章') | Some('节') | Some('条') | Some('款') | Some('页') | Some('期') | Some('届')) && !has_decimal {
            out.push(mark("ordinal"));
            continue;
        }
        let mut percent = false;
        let mut scale = 1.0;
        let mut unit_word = false;
        let mut shown = raw.clone();
        let suffix = suffix_at(rest);
        if let Some((used, text)) = &suffix {
            unit_word = matches!(text.as_str(), "千" | "万" | "亿");
            let _ = used;
            if is_percent_word(text) {
                percent = true;
            } else {
                scale = scale_of(text);
            }
            let glued = text.chars().next().map(|ch| "%万亿千".contains(ch)).unwrap_or(false);
            shown = if glued { format!("{raw}{text}") } else { format!("{raw} {text}") };
        } else if is_letter(next) && !next.map(is_cjk).unwrap_or(false) {
            out.push(mark("name_or_code"));
            continue;
        }
        let Ok(value) = raw.replace(',', "").parse::<f64>() else {
            continue;
        };
        if suffix.is_none()
            && !has_decimal
            && !raw.contains(',')
            && int_end - start == 4
            && (1000.0..=2100.0).contains(&value)
        {
            out.push(mark("year"));
            continue;
        }
        out.push(Num {
            raw: shown,
            index: start,
            skipped: None,
            value,
            decimals: decimals_len,
            percent,
            scale,
            unit_word,
        });
    }
    out.sort_by_key(|n| n.index);
    out
}

// ---------------------------------------------------------------- candidates

#[derive(Debug, Clone)]
struct Cand {
    value: f64,
    comp: usize,
    row: Option<usize>,
    column: Option<String>,
    kind: &'static str,
}

#[derive(Default)]
struct Candidates {
    rows: Vec<Cand>,
    derived: Vec<Cand>,
}

fn cell_number(cell: &Value) -> Option<f64> {
    match cell {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => {
            let t = s.trim().replace(',', "");
            if t.is_empty() || !t.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.' | 'e' | 'E')) {
                return None;
            }
            t.parse::<f64>().ok().filter(|v| v.is_finite())
        }
        _ => None,
    }
}

fn column_unit_scale(column: &str) -> f64 {
    let l = column.to_lowercase();
    let has_word = |w: &str| {
        let mut from = 0;
        while let Some(p) = l[from..].find(w) {
            let s = from + p;
            let e = s + w.len();
            let before_ok = s == 0 || !l[..s].chars().last().map(|ch| ch.is_ascii_lowercase()).unwrap_or(false);
            let after_ok = e >= l.len() || !l[e..].chars().next().map(|ch| ch.is_ascii_lowercase()).unwrap_or(false);
            if before_ok && after_ok {
                return true;
            }
            from = e;
        }
        false
    };
    if has_word("tn") || has_word("trillion") || column.contains("万亿") {
        1e12
    } else if has_word("bn") || has_word("billion") {
        1e9
    } else if has_word("mn") || has_word("million") {
        1e6
    } else if has_word("thousand") {
        1e3
    } else if column.contains('亿') {
        1e8
    } else if column.contains('万') {
        1e4
    } else {
        1.0
    }
}

fn add_computation(cands: &mut Candidates, comp: usize, rows: &[Value]) {
    if rows.is_empty() {
        return;
    }
    let derived = |value: f64, kind: &'static str, cands: &mut Candidates| {
        if value.is_finite() && cands.derived.len() < MAX_DERIVED {
            cands.derived.push(Cand { value, comp, row: None, column: None, kind });
        }
    };
    derived(rows.len() as f64, "row_count", cands);
    let mut columns: Vec<String> = Vec::new();
    for row in rows {
        if let Some(obj) = row.as_object() {
            for key in obj.keys() {
                if !columns.contains(key) {
                    columns.push(key.clone());
                }
            }
        }
    }
    let mut numeric: Vec<(String, Vec<Option<f64>>)> = Vec::new();
    for column in &columns {
        let values: Vec<Option<f64>> = rows.iter().map(|r| r.get(column).and_then(cell_number)).collect();
        let unit = column_unit_scale(column);
        for (r, v) in values.iter().enumerate() {
            if let Some(v) = v {
                cands.rows.push(Cand { value: *v, comp, row: Some(r), column: Some(column.clone()), kind: "cell" });
                if unit != 1.0 {
                    cands.rows.push(Cand { value: v * unit, comp, row: Some(r), column: Some(column.clone()), kind: "cell_in_base_units" });
                }
            }
        }
        let present = values.iter().filter(|v| v.is_some()).count();
        let nonempty = rows
            .iter()
            .filter(|r| match r.get(column) {
                None | Some(Value::Null) => false,
                Some(Value::String(s)) => !s.is_empty(),
                _ => true,
            })
            .count();
        if present > 0 && present == nonempty {
            numeric.push((column.clone(), values));
        }
        let distinct: std::collections::BTreeSet<String> =
            rows.iter().map(|r| r.get(column).map(|v| v.to_string()).unwrap_or_else(|| "null".into())).collect();
        derived(distinct.len() as f64, "distinct_count", cands);
    }
    for (_, values) in &numeric {
        let present: Vec<f64> = values.iter().flatten().copied().collect();
        if present.is_empty() {
            continue;
        }
        let sum: f64 = present.iter().sum();
        let mut sorted = present.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = sorted.len() / 2;
        let median = if sorted.len() % 2 == 1 { sorted[mid] } else { (sorted[mid - 1] + sorted[mid]) / 2.0 };
        let (lo, hi) = (sorted[0], sorted[sorted.len() - 1]);
        derived(sum, "sum", cands);
        derived(sum / present.len() as f64, "mean", cands);
        derived(present.len() as f64, "count", cands);
        derived(median, "median", cands);
        derived(lo, "min", cands);
        derived(hi, "max", cands);
        derived(hi - lo, "range", cands);
        if lo != 0.0 {
            derived(hi / lo, "max_over_min", cands);
        }
        if sum != 0.0 {
            for v in &present {
                derived(v / sum, "share", cands);
            }
        }
        let pairs: Vec<(f64, f64)> = if present.len() <= ALL_PAIRS_LIMIT {
            let mut p = Vec::new();
            for (i, a) in present.iter().enumerate() {
                for b in &present[i + 1..] {
                    p.push((*a, *b));
                    p.push((*b, *a));
                }
            }
            p
        } else {
            let mut p: Vec<(f64, f64)> = present.windows(2).map(|w| (w[0], w[1])).collect();
            p.push((present[0], present[present.len() - 1]));
            p
        };
        for (a, b) in pairs {
            derived(b - a, "difference", cands);
            derived((b - a).abs(), "abs_difference", cands);
            if a != 0.0 {
                derived(b / a, "ratio", cands);
                derived((b - a) / a.abs(), "relative_change", cands);
            }
        }
    }
    if rows.len() <= ROW_PAIR_LIMIT {
        for (i, (_, a)) in numeric.iter().enumerate() {
            for (j, (_, b)) in numeric.iter().enumerate() {
                if i == j {
                    continue;
                }
                for r in 0..rows.len() {
                    if let (Some(x), Some(y)) = (a[r], b[r]) {
                        derived(x - y, "column_difference", cands);
                        if y != 0.0 {
                            derived(x / y, "column_ratio", cands);
                        }
                    }
                }
            }
        }
    }
}

fn rounds(value: f64, decimals: usize) -> f64 {
    let factor = 10f64.powi(decimals as i32);
    (value.abs() * factor + 1e-9 + 0.5).floor() / factor
}

fn matches_number(entry: &Num, candidate: f64) -> bool {
    matches_scaled(entry, candidate, true)
}

/// `scaled` false: read the figure as written, in the unit word that follows (176489.6千吨 = 176489.6 in 千吨).
fn matches_scaled(entry: &Num, candidate: f64, scaled: bool) -> bool {
    if !scaled {
        let target = entry.value.abs();
        return (rounds(candidate, entry.decimals) - target).abs() <= 1e-9 * target.max(1.0);
    }
    let target = entry.value.abs();
    let close = |shown: f64| (rounds(shown, entry.decimals) - target).abs() <= 1e-9 * target.max(1.0);
    close(candidate / entry.scale) || (entry.percent && close(candidate * 100.0))
}

// ---------------------------------------------------------------- the run folder

fn safe_run_path(root: &Path, reference: &str) -> Option<std::path::PathBuf> {
    if reference.is_empty() || reference.starts_with('/') || reference.contains('\\') || reference.split('/').any(|p| p == ".." || p.is_empty()) {
        return None;
    }
    Some(root.join(reference))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

struct Computations {
    refs: Vec<String>,
    rows: Vec<Vec<Value>>,
}

impl Computations {
    fn index_of(&mut self, root: &Path, reference: &str) -> Option<usize> {
        if let Some(i) = self.refs.iter().position(|r| r == reference) {
            return Some(i);
        }
        if !reference.starts_with("computations/") {
            return None;
        }
        let rows = read_json(&safe_run_path(root, reference)?)?
            .get("rows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.refs.push(reference.to_string());
        self.rows.push(rows);
        Some(self.refs.len() - 1)
    }
}

fn candidates_for(comps: &Computations, indexes: &[usize]) -> Candidates {
    let mut cands = Candidates::default();
    for &i in indexes {
        add_computation(&mut cands, i, &comps.rows[i]);
    }
    cands
}

fn push_checks(
    out: &mut Vec<Value>,
    comps: &Computations,
    surface: &str,
    place: &str,
    scope: &str,
    text: &str,
    cands: &Candidates,
) {
    let has_candidates = !cands.rows.is_empty() || !cands.derived.is_empty();
    for entry in extract_numbers(text) {
        let mut record = Map::new();
        record.insert("surface".into(), json!(surface));
        record.insert("where".into(), json!(place));
        record.insert("scope".into(), json!(scope));
        record.insert("raw".into(), json!(entry.raw));
        record.insert("offset".into(), json!(entry.index));
        if let Some(reason) = entry.skipped {
            record.insert("status".into(), json!("skipped"));
            record.insert("skipped_reason".into(), json!(reason));
        } else {
            record.insert("value".into(), json!(entry.value));
            if !has_candidates {
                record.insert("status".into(), json!("no_candidates"));
            } else if let Some(hit) = cands.rows.iter().find(|c| matches_number(&entry, c.value)) {
                record.insert("status".into(), json!("matched_rows"));
                record.insert("computation_ref".into(), json!(comps.refs[hit.comp]));
                record.insert("row".into(), json!(hit.row));
                record.insert("column".into(), json!(hit.column));
                record.insert("candidate_kind".into(), json!(hit.kind));
            } else if let Some(hit) = entry.unit_word.then(|| cands.rows.iter().find(|c| matches_scaled(&entry, c.value, false))).flatten() {
                record.insert("status".into(), json!("matched_rows"));
                record.insert("computation_ref".into(), json!(comps.refs[hit.comp]));
                record.insert("row".into(), json!(hit.row));
                record.insert("column".into(), json!(hit.column));
                record.insert("candidate_kind".into(), json!(hit.kind));
                record.insert("via".into(), json!("unit_word_unscaled"));
            } else if let Some(hit) = cands.derived.iter().find(|c| matches_number(&entry, c.value)) {
                record.insert("status".into(), json!("matched_derived"));
                record.insert("computation_ref".into(), json!(comps.refs[hit.comp]));
                record.insert("candidate_kind".into(), json!(hit.kind));
            } else {
                record.insert("status".into(), json!("unmatched"));
            }
        }
        out.push(Value::Object(record));
    }
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn counts(entries: &[Value]) -> Value {
    let mut total: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    for e in entries {
        let surface = e.get("surface").and_then(Value::as_str).unwrap_or("?");
        let status = e.get("status").and_then(Value::as_str).unwrap_or("?");
        *total.entry(format!("{surface}.{status}")).or_default() += 1;
        if status != "skipped" {
            *total.entry(format!("{surface}.numbers")).or_default() += 1;
        }
    }
    json!(total)
}

/// The audit of one run folder: (key inputs, record) for `write_record_only`, or None when there is nothing to audit.
pub fn audit(root: &Path) -> Option<(Value, Value)> {
    let mut comps = Computations { refs: Vec::new(), rows: Vec::new() };
    let mut entries: Vec<Value> = Vec::new();

    // claim id -> computation indexes (every claim line, in file order)
    let mut claim_comps: Vec<(String, Vec<usize>)> = Vec::new();
    let claims_text = fs::read_to_string(root.join("claims.jsonl")).unwrap_or_default();
    for line in claims_text.lines() {
        let Ok(claim) = serde_json::from_str::<Value>(line) else { continue };
        let id = claim.get("claim_id").and_then(Value::as_str).unwrap_or("").to_string();
        let indexes: Vec<usize> = claim
            .get("computation_refs")
            .and_then(Value::as_array)
            .map(|refs| refs.iter().filter_map(Value::as_str).filter_map(|r| comps.index_of(root, r)).collect())
            .unwrap_or_default();
        if let Some(text) = claim.get("claim").and_then(Value::as_str) {
            let cands = candidates_for(&comps, &indexes);
            push_checks(&mut entries, &comps, "claim", &format!("claims.jsonl#{id}"), "claim_computations", text, &cands);
        }
        claim_comps.push((id, indexes));
    }
    let claim_index = |id: &str| claim_comps.iter().find(|(c, _)| c == id).map(|(_, i)| i.clone());

    // reader-visible text of each publication plan
    let mut dirs: Vec<std::path::PathBuf> = fs::read_dir(root.join("publications"))
        .map(|read| read.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    dirs.sort();
    let mut seen_plans: Vec<String> = Vec::new();
    for dir in dirs {
        let Some(manifest) = read_json(&dir.join("manifest.json")) else { continue };
        let Some(plan_ref) = manifest.get("plan_ref").and_then(Value::as_str) else { continue };
        if seen_plans.iter().any(|p| p == plan_ref) {
            continue;
        }
        seen_plans.push(plan_ref.to_string());
        let Some(plan) = safe_run_path(root, plan_ref).and_then(|p| read_json(&p)) else { continue };
        let modules: Vec<Value> = plan.get("modules").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut all: Vec<usize> = Vec::new();
        let mut per_module: Vec<(String, Vec<usize>, bool)> = Vec::new();
        for module in &modules {
            let id = module.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
            let mut idx: Vec<usize> = Vec::new();
            if let Some(ids) = module.get("claim_ids").and_then(Value::as_array) {
                for cid in ids.iter().filter_map(Value::as_str) {
                    if let Some(found) = claim_index(cid) {
                        idx.extend(found);
                    }
                }
            }
            if let Some(binding) = module.pointer("/evidence_binding/ref").and_then(Value::as_str) {
                if let Some(i) = comps.index_of(root, binding) {
                    idx.push(i);
                }
            }
            idx.sort_unstable();
            idx.dedup();
            all.extend(idx.iter().copied());
            let own = !idx.is_empty();
            per_module.push((id, idx, own));
        }
        all.sort_unstable();
        all.dedup();
        let plan_name = plan_ref.to_string();
        let wide = candidates_for(&comps, &all);
        for field in ["title", "dek"] {
            if let Some(text) = plan.get(field).and_then(Value::as_str) {
                push_checks(&mut entries, &comps, "publication", &format!("{plan_name}#{field}"), "publication_computations", text, &wide);
            }
        }
        for (module, (id, idx, own)) in modules.iter().zip(per_module.iter()) {
            let (cands, scope) = if *own { (candidates_for(&comps, idx), "module_claims") } else { (candidates_for(&comps, &all), "publication_computations") };
            let mut fields: Vec<(String, String)> = Vec::new();
            for field in ["title", "dek", "text"] {
                if let Some(text) = module.get(field).and_then(Value::as_str) {
                    fields.push((field.to_string(), text.to_string()));
                }
            }
            if let Some(value) = module.get("value").and_then(value_text) {
                let unit = module.get("unit").and_then(Value::as_str).unwrap_or("");
                fields.push(("value".to_string(), format!("{value}{unit}")));
            }
            for field in ["summary", "long_description"] {
                if let Some(text) = module.pointer(&format!("/accessibility/{field}")).and_then(Value::as_str) {
                    fields.push((format!("accessibility.{field}"), text.to_string()));
                }
            }
            for (field, text) in fields {
                push_checks(&mut entries, &comps, "publication", &format!("{plan_name}#modules[{id}].{field}"), scope, &text, &cands);
            }
        }
    }
    if entries.is_empty() && claim_comps.is_empty() {
        return None;
    }
    let summary = counts(&entries);
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    let key_inputs = json!({ "counts": summary, "entries": entries });
    let record = json!({
        "counts": summary,
        "claims_audited": claim_comps.len(),
        "computations_read": comps.refs,
        "entries_truncated": truncated,
        "entries": entries,
    });
    Some((key_inputs, record))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nums(text: &str) -> Vec<(String, Option<&'static str>)> {
        extract_numbers(text).into_iter().map(|n| (n.raw, n.skipped)).collect()
    }

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("computations")).unwrap();
        fs::write(
            root.join("computations/c1.json"),
            r#"{"rows":[{"fuel":"oil","ktoe":176489.6,"share_pct":29.7},{"fuel":"gas","ktoe":90000,"share_pct":25.9}]}"#,
        )
        .unwrap();
        fs::write(
            root.join("claims.jsonl"),
            format!(
                "{}\n",
                json!({"claim_id":"claim-1","claim":"2023 年终端消费 176489.6 吨油当量，石油占 29.7%、天然气占 25.9%，合计 99.9%。","computation_refs":["computations/c1.json"]})
            ),
        )
        .unwrap();
        fs::create_dir_all(root.join("publications/h1")).unwrap();
        fs::create_dir_all(root.join("publications/plans")).unwrap();
        fs::write(root.join("publications/h1/manifest.json"), r#"{"plan_ref":"publications/plans/p1.json"}"#).unwrap();
        fs::write(
            root.join("publications/plans/p1.json"),
            json!({"title":"石油占 29.7%","dek":"共 2 种燃料","modules":[
                {"id":"m1","type":"text","claim_ids":["claim-1"],"title":"天然气占 25.9%","text":"石油占 31.2%"},
                {"id":"m2","type":"stat","claim_ids":["claim-1"],"value":"29.7","unit":"%","title":"石油份额"}
            ]}).to_string(),
        )
        .unwrap();
        dir
    }

    fn count(record: &Value, key: &str) -> u64 {
        record["counts"].get(key).and_then(Value::as_u64).unwrap_or(0)
    }

    #[test]
    fn extraction_skips_years_dates_ordinals_and_codes() {
        let out = nums("2023 年 G20 第3章 2020-2024 年 12月 5 percent 3.4 million");
        let skipped: Vec<_> = out.iter().filter(|(_, s)| s.is_some()).map(|(r, _)| r.as_str()).collect();
        assert!(skipped.contains(&"2023") && skipped.contains(&"20") && skipped.contains(&"3") && skipped.contains(&"2020-2024") && skipped.contains(&"12"), "{out:?}");
        let kept: Vec<_> = out.iter().filter(|(_, s)| s.is_none()).map(|(r, _)| r.as_str()).collect();
        assert_eq!(kept, vec!["5 percent", "3.4 million"], "{out:?}");
    }

    #[test]
    fn matching_uses_display_precision_percent_and_scale() {
        let e = |t: &str| extract_numbers(t).remove(0);
        assert!(matches_number(&e("29.7%"), 29.7));
        assert!(matches_number(&e("29.7%"), 0.2973));
        assert!(matches_number(&e("30%"), 29.7));
        assert!(!matches_number(&e("31.2%"), 29.7));
        assert!(matches_number(&e("3.4 million"), 3_400_000.0));
        assert!(!matches_number(&e("34 million"), 3_400_000.0));
    }

    #[test]
    fn audit_counts_found_and_unfound_numbers() {
        let dir = folder();
        let (_, record) = audit(dir.path()).expect("an audit record");
        // claim: 176489.6, 29.7, 25.9 found in rows; 99.9 not found (the real sum is 55.6); 2023 skipped
        assert_eq!(count(&record, "claim.matched_rows"), 3, "{record}");
        assert_eq!(count(&record, "claim.unmatched"), 1, "{record}");
        assert_eq!(count(&record, "claim.skipped"), 1, "{record}");
        // publication: title 29.7 found; dek "2" found as the row count; m1 title found; m1 text 31.2 not found; stat 29.7% found
        assert_eq!(count(&record, "publication.unmatched"), 1, "{record}");
        let hit = record["entries"].as_array().unwrap().iter().find(|e| e["raw"] == "176489.6").unwrap();
        assert_eq!(hit["computation_ref"], "computations/c1.json");
        assert_eq!(hit["row"], 0);
        assert_eq!(hit["column"], "ktoe");
        assert_eq!(hit["status"], "matched_rows");
        let miss = record["entries"].as_array().unwrap().iter().find(|e| e["raw"] == "31.2%").unwrap();
        assert_eq!(miss["status"], "unmatched");
        assert_eq!(miss["where"], "publications/plans/p1.json#modules[m1].text");
    }

    #[test]
    fn a_scale_word_that_starts_a_unit_word_may_be_the_unit() {
        let e = |t: &str| extract_numbers(t).remove(0);
        assert!(e("176489.6千吨").unit_word && !e("176489.6 million").unit_word);
        assert!(matches_scaled(&e("176489.6千吨"), 176489.6, false));
        assert!(!matches_scaled(&e("176489.7千吨"), 176489.6, false));
    }

    #[test]
    fn audit_changes_nothing_in_the_run_folder() {
        let dir = folder();
        let before = fs::read_to_string(dir.path().join("claims.jsonl")).unwrap();
        let _ = audit(dir.path());
        assert_eq!(fs::read_to_string(dir.path().join("claims.jsonl")).unwrap(), before);
        assert!(!dir.path().join("shadow").exists());
    }

    #[test]
    fn a_claim_without_computation_rows_has_no_candidates() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("claims.jsonl"), format!("{}\n", json!({"claim_id":"c","claim":"占 12.5%","computation_refs":[]}))).unwrap();
        let (_, record) = audit(dir.path()).unwrap();
        assert_eq!(count(&record, "claim.no_candidates"), 1, "{record}");
    }
}
