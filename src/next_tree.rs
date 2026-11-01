//! New route, visual group: the page tree's core (P3, plan B). An external node returns geometry only; everything that is
//! content is the core's: every select is recomputed from the rows the core holds, every fact computed, every check
//! evaluated, every item expanded from the node registry's binding, every printed word held to the worded-number rule. The
//! core issues one request per external node (ids, the numbers each mark encodes, text box sizes it measured from its own
//! words, pixel points it projected), and takes back only a shape's coordinates and a text's position:
//!   C  the core's own spec, before any node is asked (a failure stops the page; the node is never asked):
//!      C1 the page tree's schema, its selects recomputed from the rows (a kind, key, tie or field the core cannot compute
//!         is refused, never taken as written), facts computed, references resolved, lint, shared fields, the node registry;
//!      C2 each external node's items are exactly the generic expansion of its registry binding;
//!      C3 every word the core prints holds no number typed in words or digits;
//!      C4 the input checks R1-R12 (rows, printed numbers, names, the flow's picks, every check evaluated by the core and
//!         none it cannot compute, knob values as sent, drawn / rows / composition derived, items draw their own rows);
//!      C5 the registry: an external node naming a check, channel, scale, relation, field kind, shape or frame the core does
//!         not compute, or a tolerance above TOL_PX_MAX, a text farther from its mark than MAX_PX_MAX or a circle radius
//!         above RADIUS_PX_MAX, is refused when the registry loads.
//!      Colour (R11): the palette file passes palette_ok before anything else, and the page tree names no colour.
//!   B  the node's reply: B0 the allow-list (geometry fields only, closed enums, finite numbers, issued ids only); B1 every
//!      issued mark and text placed exactly once; B2 inside the frame; B3 each value-determined field equal to the core's
//!      recomputation from the declared field -> channel -> scale (B4 a projected point); B5 each text next to its own mark;
//!      B6 no two text boxes of a node overlap; B7 a refusal stops the page.
//! A port of the plan B prototype (core_b.py, reply_b.py, plan A's core_recheck.py and P1's validate.py, with the 11-01
//! fixes); scripts/fixtures/p3b holds its fixtures and verdicts, and the tests below hold this file to them case by case.
//! Pure: it reads no file and calls no other group; the child is started by next_leaf (this group's).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde_json::Value;

// ================================================================================================================
// An ordered JSON value. The page tree's objects are read in document order (a stacked bar's parts, the name rows):
// serde_json's map is sorted, so the core keeps its own. NaN and Infinity are read as numbers (a reply may hold them;
// B0 refuses them). Equality is Python's: objects compare without order, 1 == 1.0 == true.
// ================================================================================================================

#[derive(Clone, Debug)]
pub enum J {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

static NULL: J = J::Null;

impl PartialEq for J {
    fn eq(&self, other: &J) -> bool {
        match (self, other) {
            (J::Null, J::Null) => true,
            (J::Str(a), J::Str(b)) => a == b,
            (J::Arr(a), J::Arr(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y),
            (J::Obj(a), J::Obj(b)) => a.len() == b.len() && a.iter().all(|(k, v)| other.get(k).is_some_and(|w| v == w)),
            (a, b) => match (a.num_like(), b.num_like()) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            },
        }
    }
}

impl J {
    fn num_like(&self) -> Option<f64> {
        match self {
            J::Bool(b) => Some(f64::from(u8::from(*b))),
            J::Int(i) => Some(*i as f64),
            J::Num(x) => Some(*x),
            _ => None,
        }
    }
    /// A number that is no bool (Python: int or float, not bool).
    pub fn num(&self) -> Option<f64> {
        match self {
            J::Int(i) => Some(*i as f64),
            J::Num(x) => Some(*x),
            _ => None,
        }
    }
    pub fn finite(&self) -> bool {
        self.num().is_some_and(f64::is_finite)
    }
    pub fn get(&self, k: &str) -> Option<&J> {
        match self {
            J::Obj(m) => m.iter().find(|(key, _)| key == k).map(|(_, v)| v),
            _ => None,
        }
    }
    /// The field, or null (absent or not an object).
    pub fn g(&self, k: &str) -> &J {
        self.get(k).unwrap_or(&NULL)
    }
    pub fn has(&self, k: &str) -> bool {
        self.get(k).is_some()
    }
    pub fn at(&self, i: usize) -> &J {
        match self {
            J::Arr(a) => a.get(i).unwrap_or(&NULL),
            _ => &NULL,
        }
    }
    pub fn s(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn arr(&self) -> &[J] {
        match self {
            J::Arr(a) => a,
            _ => &[],
        }
    }
    pub fn obj(&self) -> &[(String, J)] {
        match self {
            J::Obj(m) => m,
            _ => &[],
        }
    }
    pub fn is_obj(&self) -> bool {
        matches!(self, J::Obj(_))
    }
    pub fn is_arr(&self) -> bool {
        matches!(self, J::Arr(_))
    }
    pub fn is_null(&self) -> bool {
        matches!(self, J::Null)
    }
    pub fn truthy(&self) -> bool {
        match self {
            J::Null => false,
            J::Bool(b) => *b,
            J::Int(i) => *i != 0,
            J::Num(x) => *x != 0.0,
            J::Str(s) => !s.is_empty(),
            J::Arr(a) => !a.is_empty(),
            J::Obj(m) => !m.is_empty(),
        }
    }
    pub fn get_mut(&mut self, k: &str) -> Option<&mut J> {
        match self {
            J::Obj(m) => m.iter_mut().find(|(key, _)| key == k).map(|(_, v)| v),
            _ => None,
        }
    }
    /// Sets a field: in place when it is there (Python keeps a key's place), else at the end.
    pub fn set(&mut self, k: &str, v: J) {
        if let J::Obj(m) = self {
            match m.iter_mut().find(|(key, _)| key == k) {
                Some((_, slot)) => *slot = v,
                None => m.push((k.to_string(), v)),
            }
        }
    }
    pub fn remove(&mut self, k: &str) -> Option<J> {
        match self {
            J::Obj(m) => m.iter().position(|(key, _)| key == k).map(|i| m.remove(i).1),
            _ => None,
        }
    }
    pub fn str(s: &str) -> J {
        J::Str(s.to_string())
    }
    pub fn obj_of(pairs: Vec<(&str, J)>) -> J {
        J::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
    pub fn strs<S: AsRef<str>>(v: &[S]) -> J {
        J::Arr(v.iter().map(|s| J::str(s.as_ref())).collect())
    }
    /// Sets the value at a path of keys (the last one set in place or added); false when a step is missing.
    #[cfg(test)]
    pub fn set_path(&mut self, p: &[String], v: J) -> bool {
        let Some((last, head)) = p.split_last() else { return false };
        let mut o = self;
        for k in head {
            o = match o {
                J::Obj(m) => match m.iter_mut().find(|(key, _)| key == k) {
                    Some((_, x)) => x,
                    None => return false,
                },
                J::Arr(a) => match k.parse::<usize>().ok().and_then(|i| a.get_mut(i)) {
                    Some(x) => x,
                    None => return false,
                },
                _ => return false,
            };
        }
        match o {
            J::Obj(_) => {
                o.set(last, v);
                true
            }
            J::Arr(a) => match last.parse::<usize>().ok().and_then(|i| a.get_mut(i)) {
                Some(x) => {
                    *x = v;
                    true
                }
                None => false,
            },
            _ => false,
        }
    }
    /// Python's `str(...)` of a value, as the prototype's messages print it (repr for every inner value).
    pub fn repr(&self) -> String {
        let mut out = String::new();
        repr_into(self, &mut out);
        out
    }
    /// JSON text (keys in order; NaN and Infinity as Python writes them).
    pub fn dump(&self) -> String {
        let mut out = String::new();
        dump_into(self, &mut out);
        out
    }
    pub fn to_value(&self) -> Value {
        match self {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Int(i) => Value::from(*i),
            J::Num(x) => serde_json::Number::from_f64(*x).map_or(Value::Null, Value::Number),
            J::Str(s) => Value::String(s.clone()),
            J::Arr(a) => Value::Array(a.iter().map(J::to_value).collect()),
            J::Obj(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }
    pub fn from_value(v: &Value) -> J {
        match v {
            Value::Null => J::Null,
            Value::Bool(b) => J::Bool(*b),
            Value::Number(n) => n.as_i64().map_or_else(|| J::Num(n.as_f64().unwrap_or(f64::NAN)), J::Int),
            Value::String(s) => J::Str(s.clone()),
            Value::Array(a) => J::Arr(a.iter().map(J::from_value).collect()),
            Value::Object(m) => J::Obj(m.iter().map(|(k, v)| (k.clone(), J::from_value(v))).collect()),
        }
    }
}

/// Python's repr of a float: the shortest digits that read back, fixed notation for exponents -4..16, else d.ddde+XX.
pub fn py_float(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let e = format!("{x:e}");
    let (mant, exp) = e.split_once('e').expect("{:e} has an exponent");
    let exp: i32 = exp.parse().expect("{:e} exponent");
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let sign = if neg { "-" } else { "" };
    if (-4..16).contains(&exp) {
        let point = exp + 1;
        let s = if point <= 0 {
            format!("0.{}{}", "0".repeat((-point) as usize), digits)
        } else if point as usize >= digits.len() {
            format!("{}{}.0", digits, "0".repeat(point as usize - digits.len()))
        } else {
            format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
        };
        format!("{sign}{s}")
    } else {
        let m = if digits.len() > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits };
        format!("{sign}{m}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

fn py_str_repr(s: &str, out: &mut String) {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push(q);
}

fn repr_into(v: &J, out: &mut String) {
    match v {
        J::Null => out.push_str("None"),
        J::Bool(b) => out.push_str(if *b { "True" } else { "False" }),
        J::Int(i) => {
            let _ = write!(out, "{i}");
        }
        J::Num(x) => out.push_str(&py_float(*x)),
        J::Str(s) => py_str_repr(s, out),
        J::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                repr_into(x, out);
            }
            out.push(']');
        }
        J::Obj(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                py_str_repr(k, out);
                out.push_str(": ");
                repr_into(x, out);
            }
            out.push('}');
        }
    }
}

/// Python's `str(x)` in an f-string: a string as it is, anything else as its repr.
fn st(v: &J) -> String {
    match v {
        J::Str(s) => s.clone(),
        v => v.repr(),
    }
}

fn dump_into(v: &J, out: &mut String) {
    match v {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Int(i) => {
            let _ = write!(out, "{i}");
        }
        J::Num(x) if x.is_nan() => out.push_str("NaN"),
        J::Num(x) if x.is_infinite() => out.push_str(if *x > 0.0 { "Infinity" } else { "-Infinity" }),
        J::Num(x) => out.push_str(&py_float(*x)),
        J::Str(s) => out.push_str(&serde_json::to_string(s).expect("a string serializes")),
        J::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                dump_into(x, out);
            }
            out.push(']');
        }
        J::Obj(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("a key serializes"));
                out.push(':');
                dump_into(x, out);
            }
            out.push('}');
        }
    }
}

/// Reads JSON text in document order (as Python's json.load: NaN, Infinity and -Infinity are numbers; an integer literal
/// is an int, any other number a float; a key given twice keeps its first place and its last value).
pub fn parse(text: &str) -> Result<J, String> {
    let b = text.as_bytes();
    let mut p = Parser { b, i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != b.len() {
        return Err(format!("json: extra data at byte {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn lit(&mut self, w: &str) -> bool {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            true
        } else {
            false
        }
    }
    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("json: {what} at byte {}", self.i))
    }
    fn value(&mut self) -> Result<J, String> {
        let Some(&c) = self.b.get(self.i) else { return self.err("unexpected end") };
        match c {
            b'{' => {
                self.i += 1;
                let mut m: Vec<(String, J)> = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(J::Obj(m));
                }
                loop {
                    self.ws();
                    if self.b.get(self.i) != Some(&b'"') {
                        return self.err("expected a key");
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return self.err("expected ':'");
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value()?;
                    match m.iter_mut().find(|(key, _)| *key == k) {
                        Some((_, slot)) => *slot = v,
                        None => m.push((k, v)),
                    }
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(J::Obj(m));
                        }
                        _ => return self.err("expected ',' or '}'"),
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(J::Arr(a));
                }
                loop {
                    self.ws();
                    a.push(self.value()?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(J::Arr(a));
                        }
                        _ => return self.err("expected ',' or ']'"),
                    }
                }
            }
            b'"' => Ok(J::Str(self.string()?)),
            b't' if self.lit("true") => Ok(J::Bool(true)),
            b'f' if self.lit("false") => Ok(J::Bool(false)),
            b'n' if self.lit("null") => Ok(J::Null),
            b'N' if self.lit("NaN") => Ok(J::Num(f64::NAN)),
            b'I' if self.lit("Infinity") => Ok(J::Num(f64::INFINITY)),
            b'-' if self.lit("-Infinity") => Ok(J::Num(f64::NEG_INFINITY)),
            b'-' | b'0'..=b'9' => self.number(),
            _ => self.err("unexpected character"),
        }
    }
    fn number(&mut self) -> Result<J, String> {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        let digits = |p: &mut Self| {
            let s = p.i;
            while p.i < p.b.len() && p.b[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i > s
        };
        if !digits(self) {
            return self.err("a number with no digit");
        }
        let mut float = false;
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            float = true;
            if !digits(self) {
                return self.err("a number with no digit after '.'");
            }
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            float = true;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !digits(self) {
                return self.err("a number with no exponent digit");
            }
        }
        let text = std::str::from_utf8(&self.b[start..self.i]).expect("ascii");
        if !float {
            if let Ok(i) = text.parse::<i64>() {
                return Ok(J::Int(i));
            }
        }
        text.parse::<f64>().map(J::Num).map_err(|e| format!("json: number {text}: {e}"))
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.b.get(self.i..self.i + 4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok());
        match h {
            Some(v) => {
                self.i += 4;
                Ok(v)
            }
            None => self.err("a bad \\u escape"),
        }
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' {
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.b[start..self.i]).map_err(|e| format!("json: {e}"))?);
            match self.b.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(&e) = self.b.get(self.i) else { return self.err("an unfinished escape") };
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let c = if (0xD800..0xDC00).contains(&hi) && self.b[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))
                                } else {
                                    None
                                }
                            } else {
                                char::from_u32(hi)
                            };
                            out.push(c.unwrap_or('\u{fffd}'));
                        }
                        _ => return self.err("an unknown escape"),
                    }
                }
                _ => return self.err("an unterminated string"),
            }
        }
    }
}

/// Every (path, value) of a tree, the tree first, depth first, in document order: `$.k`, `$[i]` (validate.walk).
pub fn walk<'a>(v: &'a J, path: &str) -> Vec<(String, &'a J)> {
    fn go<'a>(v: &'a J, path: String, out: &mut Vec<(String, &'a J)>) {
        out.push((path.clone(), v));
        match v {
            J::Obj(m) => {
                for (k, x) in m {
                    go(x, format!("{path}.{k}"), out);
                }
            }
            J::Arr(a) => {
                for (i, x) in a.iter().enumerate() {
                    go(x, format!("{path}[{i}]"), out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    go(v, path.to_string(), &mut out);
    out
}

// ================================================================================================================
// The page tree's schema (runtime/page_tree/page-tree.schema.json, P1): a JSON Schema 2020-12 validator for the keywords
// it uses; an unknown keyword or pattern is an error, so nothing is skipped silently.
// ================================================================================================================

const SCHEMA_TEXT: &str = include_str!("../runtime/page_tree/page-tree.schema.json");
const P1_REGISTRY_TEXT: &str = include_str!("../runtime/page_tree/node-registry.json");

fn schema() -> &'static J {
    static S: std::sync::OnceLock<J> = std::sync::OnceLock::new();
    S.get_or_init(|| parse(SCHEMA_TEXT).expect("page-tree.schema.json parses"))
}

const SCHEMA_IGNORED: [&str; 6] = ["$schema", "$id", "$comment", "title", "description", "$defs"];
const SCHEMA_KNOWN: [&str; 17] = [
    "$ref", "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "enum", "const",
    "pattern", "minimum", "maximum", "anyOf", "oneOf", "propertyNames", "minLength",
];

fn is_type(v: &J, t: &str) -> bool {
    match t {
        "object" => matches!(v, J::Obj(_)),
        "array" => matches!(v, J::Arr(_)),
        "string" => matches!(v, J::Str(_)),
        "boolean" => matches!(v, J::Bool(_)),
        "null" => v.is_null(),
        "integer" => matches!(v, J::Int(_)),
        "number" => matches!(v, J::Int(_) | J::Num(_)),
        _ => false,
    }
}

const NUMERALS: &str = "零〇一二两三四五六七八九十百千万亿几";
const RATIO_AFTER: [&str; 6] = ["倍", "成", "％", "%", "分之", "个百分点"];
const RATIO_WORDS: [&str; 11] = ["一半", "过半", "大半", "半数", "减半", "近半", "逾半", "超半", "翻番", "翻倍", "数倍"];
const NUMBER_FREE: [&str; 11] = ["二氧化碳", "统一成", "一成不变", "十分", "万一", "千万", "一一", "两者", "千瓦", "百分比", "零售"];
const QUANTITY_BEFORE: &str = "数上近逾超余多几";

/// A full match of `s` (or of `s` less one final newline, as Python's `$`).
fn full(s: &str, f: impl Fn(&str) -> bool) -> bool {
    f(s) || s.strip_suffix('\n').is_some_and(&f)
}
fn word_c(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn nonempty_all(s: &str, f: impl Fn(char) -> bool) -> bool {
    !s.is_empty() && s.chars().all(f)
}
/// A palette id (runtime/page_tree/palettes.json): lowercase letters, digits, hyphens, a letter first.
fn palette_id(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|c| c.is_ascii_lowercase()) && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
fn ident_lower(s: &str) -> bool {
    let mut c = s.chars();
    c.next().is_some_and(|c| c.is_ascii_lowercase()) && c.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The schema's patterns, each as a matcher (Python re.search; each is anchored at the start). None: a pattern this
/// validator has no matcher for, which is an error.
fn pattern_match(p: &str, s: &str) -> Option<bool> {
    let code = |c: char| word_c(c) || c == '.' || c == '-';
    Some(match p {
        r"^[a-z][a-z0-9-]*$" => full(s, palette_id),
        r"^[A-Za-z_][A-Za-z0-9_.\-]*$" => full(s, |t| {
            let mut c = t.chars();
            c.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && c.all(code)
        }),
        r"^(?!.*(一半|过半|大半|半数|减半|近半|逾半|超半|翻番|翻倍|数倍|[零〇一二两三四五六七八九十百千万亿几]\s*(倍|分之|个百分点|%|％)))[^0-9０-９]*$" => {
            let line = s.split('\n').next().unwrap_or("");
            let mut hit = false;
            for (i, c) in line.char_indices() {
                if RATIO_WORDS.iter().any(|w| line[i..].starts_with(w)) {
                    hit = true;
                }
                if NUMERALS.contains(c) {
                    let rest = s[i + c.len_utf8()..].trim_start();
                    if ["倍", "分之", "个百分点", "%", "％"].iter().any(|w| rest.starts_with(w)) {
                        hit = true;
                    }
                }
            }
            !hit && !s.chars().any(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
        }
        r"^(?!select:)[A-Za-z0-9_.@:>\-]+$" => {
            !s.starts_with("select:") && full(s, |t| nonempty_all(t, |c| code(c) || matches!(c, '@' | ':' | '>')))
        }
        r"^(fact|name|period|record):.+$" => full(s, |t| {
            ["fact:", "name:", "period:", "record:"].iter().any(|p| t.strip_prefix(p).is_some_and(|r| nonempty_all(r, |c| c != '\n')))
        }),
        r"^(n|t|tick[0-9]+)$" => full(s, |t| t == "n" || t == "t" || t.strip_prefix("tick").is_some_and(|d| nonempty_all(d, |c| c.is_ascii_digit()))),
        r"^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$" => full(s, |t| {
            let t = t.strip_prefix('-').unwrap_or(t);
            let (m, e) = match t.find(['e', 'E']) {
                Some(i) => (&t[..i], Some(&t[i + 1..])),
                None => (t, None),
            };
            let (a, b) = match m.split_once('.') {
                Some((a, b)) => (a, Some(b)),
                None => (m, None),
            };
            let digits = |x: &str| nonempty_all(x, |c| c.is_ascii_digit());
            digits(a) && b.is_none_or(digits) && e.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)))
        }),
        r"^[0-9a-f]{64}$" => full(s, |t| t.len() == 64 && t.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))),
        r"^[A-Z][A-Z0-9_]*$" => full(s, |t| {
            let mut c = t.chars();
            c.next().is_some_and(|c| c.is_ascii_uppercase()) && c.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        }),
        r"^[A-Za-z0-9_.\-]+(/[A-Za-z0-9_.\-]+)*$" => full(s, |t| t.split('/').all(|seg| nonempty_all(seg, code))),
        r"^[A-Za-z0-9_][A-Za-z0-9_.@\-]*$" => full(s, |t| {
            let mut c = t.chars();
            c.next().is_some_and(word_c) && c.all(|c| code(c) || c == '@')
        }),
        r"^[^0-9]*$" => full(s, |t| !t.chars().any(|c| c.is_ascii_digit())),
        r"^[a-z0-9_]+\.[a-z0-9_]+$" => full(s, |t| {
            let low = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_';
            t.split_once('.').is_some_and(|(a, b)| nonempty_all(a, low) && nonempty_all(b, low))
        }),
        r"^[a-z][a-z0-9_]*$" => full(s, ident_lower),
        r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$" => full(s, |t| {
            let mut parts = t.split('.');
            parts.next().is_some_and(ident_lower)
                && parts.all(|p| nonempty_all(p, |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
        }),
        r"^[a-z_]+:[A-Za-z0-9_.@:\-]+$" => full(s, |t| {
            t.split_once(':').is_some_and(|(a, b)| {
                nonempty_all(a, |c| c.is_ascii_lowercase() || c == '_') && nonempty_all(b, |c| code(c) || matches!(c, '@' | ':'))
            })
        }),
        r"^fact:[A-Za-z0-9_][A-Za-z0-9_.@\-]*$" => full(s, |t| {
            t.strip_prefix("fact:").is_some_and(|r| {
                let mut c = r.chars();
                c.next().is_some_and(word_c) && c.all(|c| code(c) || c == '@')
            })
        }),
        "^name:" => s.starts_with("name:"),
        r"^select:[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)?(\[-?[0-9]+\])?$" => full(s, |t| ref_parts(t).is_some()),
        "^series:.+$" => full(s, |t| t.strip_prefix("series:").is_some_and(|r| nonempty_all(r, |c| c != '\n'))),
        _ => return None,
    })
}

fn schema_ref<'a>(root: &'a J, r: &str) -> Option<&'a J> {
    let rest = r.strip_prefix("#/")?;
    let mut node = root;
    for part in rest.split('/') {
        node = node.get(part)?;
    }
    Some(node)
}

/// Every place `v` leaves the schema `s` (validate.Schema.errors).
fn schema_errors(root: &J, s: &J, v: &J, path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let unknown: BTreeSet<&str> = s
        .obj()
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !SCHEMA_IGNORED.contains(k) && !SCHEMA_KNOWN.contains(k))
        .collect();
    if !unknown.is_empty() {
        return vec![format!("{path}: schema uses unsupported keywords {unknown:?}")];
    }
    if let Some(r) = s.get("$ref") {
        match r.s().and_then(|r| schema_ref(root, r)) {
            Some(sub) => out.extend(schema_errors(root, sub, v, path)),
            None => return vec![format!("{path}: schema $ref {} does not resolve", r.repr())],
        }
    }
    if let Some(t) = s.get("type") {
        let types: Vec<&str> = match t {
            J::Arr(a) => a.iter().filter_map(J::s).collect(),
            J::Str(x) => vec![x.as_str()],
            _ => vec![],
        };
        if !types.iter().any(|t| is_type(v, t)) {
            out.push(format!("{path}: is not {}", J::strs(&types).repr()));
            return out;
        }
    }
    if let Some(c) = s.get("const") {
        if v != c {
            out.push(format!("{path}: is not {}", c.repr()));
        }
    }
    if let Some(e) = s.get("enum") {
        if !e.arr().iter().any(|x| x == v) {
            out.push(format!("{path}: {} not in {}", v.repr(), e.repr()));
        }
    }
    if let J::Str(text) = v {
        if let Some(n) = s.get("minLength").and_then(J::num) {
            if (text.chars().count() as f64) < n {
                out.push(format!("{path}: shorter than {}", st(s.g("minLength"))));
            }
        }
        if let Some(p) = s.get("pattern").and_then(J::s) {
            match pattern_match(p, text) {
                Some(true) => {}
                Some(false) => out.push(format!("{path}: {} does not match {p}", v.repr())),
                None => out.push(format!("{path}: schema pattern {p} has no matcher in the core")),
            }
        }
    }
    if let Some(x) = v.num() {
        if s.get("minimum").and_then(J::num).is_some_and(|m| x < m) {
            out.push(format!("{path}: {} < {}", st(v), st(s.g("minimum"))));
        }
        if s.get("maximum").and_then(J::num).is_some_and(|m| x > m) {
            out.push(format!("{path}: {} > {}", st(v), st(s.g("maximum"))));
        }
    }
    if let J::Arr(a) = v {
        if s.get("minItems").and_then(J::num).is_some_and(|n| (a.len() as f64) < n) {
            out.push(format!("{path}: fewer than {} items", st(s.g("minItems"))));
        }
        if s.get("maxItems").and_then(J::num).is_some_and(|n| (a.len() as f64) > n) {
            out.push(format!("{path}: more than {} items", st(s.g("maxItems"))));
        }
        if let Some(items) = s.get("items") {
            for (i, x) in a.iter().enumerate() {
                out.extend(schema_errors(root, items, x, &format!("{path}[{i}]")));
            }
        }
    }
    if let J::Obj(m) = v {
        for k in s.g("required").arr().iter().filter_map(J::s) {
            if !v.has(k) {
                out.push(format!("{path}: missing {k}"));
            }
        }
        let props = s.g("properties");
        for (k, x) in m {
            if let Some(pn) = s.get("propertyNames") {
                out.extend(schema_errors(root, pn, &J::str(k), &format!("{path}.<{k}>")));
            }
            if let Some(p) = props.get(k) {
                out.extend(schema_errors(root, p, x, &format!("{path}.{k}")));
            } else {
                match s.get("additionalProperties") {
                    Some(J::Bool(false)) => out.push(format!("{path}: unexpected key {k}")),
                    Some(ap @ J::Obj(_)) => out.extend(schema_errors(root, ap, x, &format!("{path}.{k}"))),
                    _ => {}
                }
            }
        }
    }
    if let Some(any) = s.get("anyOf") {
        let tries: Vec<Vec<String>> = any.arr().iter().map(|sub| schema_errors(root, sub, v, path)).collect();
        if tries.iter().all(|t| !t.is_empty()) {
            let closest = tries.iter().min_by_key(|t| t.len()).map(|t| t.iter().take(2).cloned().collect::<Vec<_>>()).unwrap_or_default();
            out.push(format!("{path}: matches none of anyOf; closest: {closest:?}"));
        }
    }
    if let Some(one) = s.get("oneOf") {
        let tries: Vec<Vec<String>> = one.arr().iter().map(|sub| schema_errors(root, sub, v, path)).collect();
        let ok = tries.iter().filter(|t| t.is_empty()).count();
        if ok != 1 {
            let closest = tries.iter().min_by_key(|t| t.len()).map(|t| t.iter().take(2).cloned().collect::<Vec<_>>()).unwrap_or_default();
            out.push(format!("{path}: matches {ok} of oneOf (needs 1); closest: {closest:?}"));
        }
    }
    out
}

// ================================================================================================================
// Select references, rows and facts (validate.py parts 3 and 4).
// ================================================================================================================

/// `select:<id>[.<key>][[<index>]]`: (id, key, index).
pub fn ref_parts(s: &str) -> Option<(String, Option<String>, Option<i64>)> {
    let rest = s.strip_prefix("select:")?;
    let n = rest.find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')).unwrap_or(rest.len());
    let sid = &rest[..n];
    if !ident_lower(sid) {
        return None;
    }
    let mut rest = &rest[n..];
    let mut key = None;
    if let Some(r) = rest.strip_prefix('.') {
        let m = r.find(|c: char| !word_c(c)).unwrap_or(r.len());
        if m == 0 {
            return None;
        }
        key = Some(r[..m].to_string());
        rest = &r[m..];
    }
    let mut idx = None;
    if let Some(r) = rest.strip_prefix('[') {
        let r = r.strip_suffix(']')?;
        let d = r.strip_prefix('-').unwrap_or(r);
        if !nonempty_all(d, |c| c.is_ascii_digit()) {
            return None;
        }
        idx = Some(r.parse::<i64>().ok()?);
        rest = "";
    }
    rest.is_empty().then(|| (sid.to_string(), key, idx))
}

fn is_ref(v: &J) -> bool {
    v.s().is_some_and(|s| ref_parts(s).is_some())
}

/// The select id a value refers to: a reference string, or {select: id} (with part at most).
fn ref_id(v: &J) -> Option<String> {
    if let Some(s) = v.s() {
        return ref_parts(s).map(|p| p.0);
    }
    if let J::Obj(m) = v {
        if v.has("select") && m.iter().all(|(k, _)| k == "select" || k == "part") {
            return Some(st(v.g("select")));
        }
    }
    None
}

type Got = BTreeMap<String, J>;
/// How recheck_one reports a recomputed result against the one written: (errors, the select's id, recomputed, written).
type Same = dyn Fn(&mut Vec<String>, String, &J, &J);

fn index(v: &J, i: i64) -> Result<J, String> {
    let n = match v {
        J::Arr(a) => a.len(),
        J::Str(s) => s.chars().count(),
        _ => return Err(format!("{} is not indexable", v.repr())),
    } as i64;
    let k = if i < 0 { n + i } else { i };
    if k < 0 || k >= n {
        return Err("list index out of range".into());
    }
    Ok(match v {
        J::Arr(a) => a[k as usize].clone(),
        J::Str(s) => J::Str(s.chars().nth(k as usize).expect("in range").to_string()),
        _ => unreachable!(),
    })
}

fn resolve_ref(v: &str, got: &Got) -> Result<J, String> {
    let (sid, key, idx) = ref_parts(v).ok_or_else(|| format!("{v}: no select reference"))?;
    let mut r = got.get(&sid).cloned().ok_or_else(|| format!("'{v}: no select {sid}'"))?;
    if let Some(k) = key {
        r = r.get(&k).cloned().ok_or_else(|| format!("'{k}'"))?;
    }
    if let Some(i) = idx {
        r = index(&r, i)?;
    }
    Ok(r)
}

/// Every select reference of a tree replaced by its recomputed result; a reference inside a list that resolves to a list
/// is spliced in.
fn resolved(v: &J, got: &Got) -> Result<J, String> {
    Ok(match v {
        J::Str(s) if ref_parts(s).is_some() => resolve_ref(s, got)?,
        J::Obj(m) => J::Obj(m.iter().map(|(k, x)| Ok((k.clone(), resolved(x, got)?))).collect::<Result<_, String>>()?),
        J::Arr(a) => {
            let mut out = Vec::new();
            for x in a {
                let y = resolved(x, got)?;
                match (is_ref(x), y) {
                    (true, J::Arr(ys)) => out.extend(ys),
                    (_, y) => out.push(y),
                }
            }
            J::Arr(out)
        }
        v => v.clone(),
    })
}

fn result_codes(r: &J) -> BTreeSet<String> {
    match r {
        J::Str(s) => [s.clone()].into(),
        J::Arr(a) => a.iter().filter_map(J::s).map(str::to_string).collect(),
        J::Obj(m) => m.iter().flat_map(|(_, vs)| vs.arr().iter().filter_map(J::s).map(str::to_string)).collect(),
        _ => BTreeSet::new(),
    }
}

/// A row's value as a number (Python float(row["value"])).
fn num(r: &J) -> Result<f64, String> {
    match r.g("value") {
        J::Str(s) => s.trim().parse::<f64>().map_err(|_| format!("could not convert string to float: {}", J::str(s).repr())),
        J::Bool(b) => Ok(f64::from(u8::from(*b))),
        v => v.num().ok_or_else(|| format!("float() of {}", v.repr())),
    }
}

fn dims<'a>(r: &'a J, d: &str) -> &'a J {
    r.g("dims").g(d)
}

/// The rows of a query's table that pass its filter (a code or a list of codes per dimension).
fn select_rows<'a>(rows: &'a [J], q: &J) -> Vec<&'a J> {
    rows.iter()
        .filter(|r| r.g("table") == q.g("table"))
        .filter(|r| {
            q.g("filter").obj().iter().all(|(dim, codes)| {
                let have = dims(r, dim);
                match codes {
                    J::Str(_) => have == codes,
                    J::Arr(a) => a.iter().any(|c| c == have),
                    _ => false,
                }
            })
        })
        .collect()
}

/// The facts of a page computed over its rows (validate.compute): value, n, zeros, last / peak / low over a span, and
/// share / change / times / minus / plus of two facts; a family (`each`) has a member per code.
struct Compute<'a> {
    facts: &'a J,
    rows: &'a [J],
    done: std::cell::RefCell<BTreeMap<String, f64>>,
}

impl<'a> Compute<'a> {
    fn new(facts: &'a J, rows: &'a [J]) -> Self {
        Compute { facts, rows, done: Default::default() }
    }
    fn fam(&self, key: &str) -> Result<Vec<(String, f64)>, String> {
        let q = self.facts.get(key).ok_or_else(|| format!("'{key}'"))?;
        let each = q.g("each").s().ok_or("each")?;
        let mut out: Vec<(String, f64)> = Vec::new();
        for r in select_rows(self.rows, q).into_iter().filter(|r| r.g("time") == q.g("time")) {
            let code = st(r.g("dims").get(each).ok_or_else(|| format!("'{each}'"))?);
            let v = num(r)?;
            match out.iter_mut().find(|(c, _)| *c == code) {
                Some(slot) => slot.1 = v,
                None => out.push((code, v)),
            }
        }
        Ok(out)
    }
    fn val(&self, key: &str) -> Result<f64, String> {
        if let Some(v) = self.done.borrow().get(key) {
            return Ok(*v);
        }
        let v = self.val_new(key)?;
        self.done.borrow_mut().insert(key.to_string(), v);
        Ok(v)
    }
    fn val_new(&self, key: &str) -> Result<f64, String> {
        let Some(q) = self.facts.get(key) else {
            let (fam_key, code) = key.rsplit_once('.').unwrap_or(("", key));
            if let Some(q) = self.facts.get(fam_key).filter(|q| q.has("each")) {
                let member = |k: &str| -> Result<f64, String> {
                    self.fam(k)?.into_iter().find(|(c, _)| c == code).map(|(_, v)| v).ok_or_else(|| format!("'{code}'"))
                };
                return if q.g("op").s() == Some("minus") {
                    Ok(member(&st(q.g("a")))? - member(&st(q.g("b")))?)
                } else {
                    member(fam_key)
                };
            }
            return Err(format!("{key}: no such fact"));
        };
        let op = q.g("op").s().unwrap_or("value");
        let time = q.g("time");
        Ok(match op {
            "share" | "change" | "times" | "minus" | "plus" => {
                let (a, b) = (self.val(&st(q.g("a")))?, self.val(&st(q.g("b")))?);
                match op {
                    "share" | "times" => {
                        if b != 0.0 {
                            a / b
                        } else {
                            f64::NAN
                        }
                    }
                    "change" => {
                        if b != 0.0 {
                            a / b - 1.0
                        } else {
                            f64::NAN
                        }
                    }
                    "minus" => a - b,
                    _ => a + b,
                }
            }
            "value" => {
                if !q.has("time") {
                    return Err("'time'".into());
                }
                let at: Vec<&J> = select_rows(self.rows, q).into_iter().filter(|r| r.g("time") == time).collect();
                if at.is_empty() {
                    return Err(format!("{key}: value has no row at {}", st(time)));
                }
                let mut s = 0.0;
                for r in at {
                    s += num(r)?;
                }
                s
            }
            "n" => {
                let by = q.g("by").s().ok_or("'by'")?;
                let mut seen: Vec<&J> = Vec::new();
                for r in select_rows(self.rows, q).into_iter().filter(|r| r.g("time") == time) {
                    let c = r.g("dims").get(by).ok_or_else(|| format!("'{by}'"))?;
                    if !seen.contains(&c) {
                        seen.push(c);
                    }
                }
                seen.len() as f64
            }
            "zeros" => {
                let mut n = 0;
                for r in select_rows(self.rows, q).into_iter().filter(|r| r.g("time") == time) {
                    if num(r)? == 0.0 {
                        n += 1;
                    }
                }
                if n == 0 {
                    return Err(format!("{key}: zeros has no row of 0"));
                }
                n as f64
            }
            "last" | "peak" | "low" => {
                let from = q.g("from").s().unwrap_or("");
                let mut ser: Vec<(String, f64)> = Vec::new();
                for r in select_rows(self.rows, q) {
                    let t = r.g("time").s().unwrap_or("");
                    if t >= from && q.get("to").is_none_or(|to| to.s().is_some_and(|to| t <= to)) {
                        let v = num(r)?;
                        match ser.iter_mut().find(|(k, _)| k == t) {
                            Some(slot) => slot.1 += v,
                            None => ser.push((t.to_string(), v)),
                        }
                    }
                }
                if ser.is_empty() {
                    return Err(format!("{key}: {op} has no row in its span"));
                }
                let pick = match op {
                    "last" => ser.iter().max_by(|a, b| a.0.cmp(&b.0)).expect("not empty"),
                    "peak" => ser.iter().fold(&ser[0], |m, x| if x.1 > m.1 { x } else { m }),
                    _ => ser.iter().fold(&ser[0], |m, x| if x.1 < m.1 { x } else { m }),
                };
                pick.1
            }
            _ => return Err(format!("{key}: op {op} not ported in this checker")),
        })
    }
}

/// The first number a text types in words outside its placeholders (validate.worded_number, a port of
/// next_flow::worded_number): `chars` the text with each placeholder (a run that is no literal) one blank whose `held`
/// is true.
fn worded_number(chars: &[char], held: &[bool]) -> Option<String> {
    let numeral = |c: char| c.is_numeric() || NUMERALS.contains(c);
    let mut chars = chars.to_vec();
    let words: Vec<Vec<char>> = NUMBER_FREE.iter().map(|w| w.chars().collect()).collect();
    for pos in 0..chars.len() {
        let Some(word) = words.iter().find(|w| chars[pos..].starts_with(w)) else { continue };
        let before = (0..pos).rev().find(|&j| held[j] || !chars[j].is_whitespace());
        if before.is_none_or(|j| !held[j] && !numeral(chars[j]) && !QUANTITY_BEFORE.contains(chars[j])) {
            chars[pos..pos + word.len()].fill(' ');
        }
    }
    let outside: String = chars.iter().collect();
    if let Some(w) = RATIO_WORDS.iter().find(|w| outside.contains(*w)) {
        return Some(w.to_string());
    }
    let mut i = 0;
    while i < chars.len() {
        if !numeral(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && (numeral(chars[i]) || (matches!(chars[i], '.' | ',') && chars.get(i + 1).is_some_and(|&n| numeral(n)))) {
            i += 1;
        }
        if start > 0 && chars[start - 1] == '第' {
            continue;
        }
        let run: String = chars[start..i].iter().collect();
        let rest: String = chars[i..].iter().collect();
        if let Some(after) = RATIO_AFTER.iter().find(|a| rest.trim_start().starts_with(*a)) {
            return Some(format!("{run}{after}"));
        }
        if run.chars().any(|c| NUMERALS.contains(c)) && (run.chars().count() > 1 || !matches!(run.as_str(), "一" | "几")) {
            return Some(run);
        }
    }
    None
}

// ================================================================================================================
// C1: the selects recomputed from the rows (validate.recheck). A kind, key, tie or field the core cannot compute is
// refused; a result written on the page is never taken in its place (11-01: take out of range, rank by change or by
// printed ties, window, merge_below; empty_parts is computed).
// ================================================================================================================

const RANK_OVER: [&str; 4] = ["table", "filter", "by", "time"];

fn plain_tie(t: Option<&J>) -> bool {
    t.is_none_or(|t| *t == J::obj_of(vec![("by", J::str("code")), ("outcome", J::str("order"))]))
}

fn cannot_rank(s: &J) -> Option<String> {
    if s.g("key").s() != Some("value") {
        return Some(format!("key {} (only value)", s.g("key").repr()));
    }
    let extra: Vec<&str> = s.g("over").obj().iter().map(|(k, _)| k.as_str()).filter(|k| !RANK_OVER.contains(k)).collect();
    if !extra.is_empty() {
        let mut extra = extra;
        extra.sort();
        let mut over = RANK_OVER.to_vec();
        over.sort();
        return Some(format!("over fields {} (only {})", J::strs(&extra).repr(), J::strs(&over).repr()));
    }
    if !plain_tie(s.get("tie")) {
        return Some(format!("tie {} (only by code, outcome order)", s.g("tie").repr()));
    }
    None
}

fn cannot_take(s: &J) -> Option<String> {
    if let Some(w) = s.get("when") {
        return Some(format!("when {}", w.repr()));
    }
    let t = s.get("tie");
    if plain_tie(t) {
        return None;
    }
    let t = t.expect("not plain, so present");
    let at = s.g("at").s().unwrap_or("");
    if t.g("by").s() == Some("printed") && t.g("outcome").s() == Some("silence") && matches!(at, "first" | "last") {
        return None;
    }
    Some(format!("tie {} at {at} (only by code, or by printed with silence at first or last)", t.repr()))
}

/// The value a take's code is ordered by: its rows under the root rank's over.
fn take_value(sel: &[(String, &J)], sid: &str, code: &J, rows: &[J]) -> Result<f64, String> {
    let q = root_rank(sel, sid)?.g("over");
    let mut s = 0.0;
    for r in select_rows(rows, q).into_iter().filter(|r| r.g("time") == q.g("time") && dims(r, q.g("by").s().unwrap_or("")) == code) {
        s += num(r)?;
    }
    Ok(s)
}

fn sel_get<'a>(sel: &[(String, &'a J)], id: &str) -> Option<&'a J> {
    sel.iter().find(|(k, _)| k == id).map(|(_, s)| *s)
}

fn root_rank<'a>(sel: &[(String, &'a J)], sid: &str) -> Result<&'a J, String> {
    let mut s = sel_get(sel, sid).ok_or_else(|| format!("'{sid}'"))?;
    for _ in 0..64 {
        if s.g("kind").s() == Some("rank") {
            return Ok(s);
        }
        let from = st(s.g("from"));
        s = sel_get(sel, &from).ok_or_else(|| format!("'{from}'"))?;
    }
    Err(format!("select {sid}: no rank at the root of its from chain"))
}

fn int_or_knob(v: &J) -> Result<i64, String> {
    match v {
        J::Int(i) => Ok(*i),
        v => v.g("value").num().map(|x| x.trunc() as i64).ok_or_else(|| format!("{} is no int or knob value", v.repr())),
    }
}

fn sum_rows<'a>(rows: impl IntoIterator<Item = &'a J>) -> Result<f64, String> {
    let mut s = 0.0;
    for r in rows {
        s += num(r)?;
    }
    Ok(s)
}

fn py_fixed(x: f64, dec: usize) -> String {
    format!("{x:.dec$}")
}

/// The selects recomputed over the page's rows, the checks max_dropped and fill_after_drop, then the page with every
/// select reference resolved and its facts computed: (failures, recomputed results by select id, the resolved page).
pub fn recheck(page: &J) -> (Vec<String>, Got, Option<J>) {
    let f = page.g("facts");
    let rows = f.g("rows").arr();
    let items = page.g("selects").g("items").arr();
    let sel: Vec<(String, &J)> = items.iter().map(|s| (st(s.g("id")), s)).collect();
    let mut got: Got = BTreeMap::new();
    let mut bad: Vec<String> = Vec::new();
    let same = |bad: &mut Vec<String>, name: String, want: &J, have: &J| {
        if want != have {
            bad.push(format!("{name}: declared {} recomputed {}", want.repr(), have.repr()));
        }
    };
    for s0 in items {
        let id = st(s0.g("id"));
        let ways = J::Obj(s0.obj().iter().filter(|(k, _)| !matches!(k.as_str(), "result" | "declared" | "dropped")).cloned().collect());
        let mut s = match resolved(&ways, &got) {
            Ok(s) => s,
            Err(e) => {
                bad.push(format!("select {id}: {e}"));
                continue;
            }
        };
        for k in ["result", "declared", "dropped"] {
            if let Some(v) = s0.get(k) {
                s.set(k, v.clone());
            }
        }
        let kind = s.g("kind").s().unwrap_or("").to_string();
        let r = recheck_one(&id, &kind, s0, &s, &sel, rows, f, &mut got, &mut bad, &same);
        if let Err(e) = r {
            bad.push(format!("select {id} ({kind}): {e}"));
            got.entry(id).or_insert_with(|| s0.g("result").clone());
        }
    }
    for c in page.g("checks").g("items").arr() {
        let kind = c.g("kind").s().unwrap_or("");
        if !matches!(kind, "max_dropped" | "fill_after_drop") {
            continue;
        }
        let sid = st(c.g("select"));
        let d = got.get(&format!("{sid}#dropped")).map_or(0, |d| d.arr().len()) as f64;
        let t = got.get(&format!("{sid}#target")).and_then(J::num).unwrap_or(1.0);
        let ok = if kind == "max_dropped" {
            d * c.g("den").num().unwrap_or(f64::NAN) <= t * c.g("num").num().unwrap_or(f64::NAN)
        } else {
            d == 0.0 || got.get(&sid).map_or(0, |x| x.arr().len()) as f64 >= t
        };
        if c.get("passed").is_some_and(|p| *p != J::Bool(ok)) || (!c.has("passed") && !ok) {
            bad.push(format!("check {} ({kind}): passed {}", st(c.g("id")), if ok { "True" } else { "False" }));
        }
    }
    let rpage = match resolved(page, &got) {
        Ok(p) => p,
        Err(e) => {
            bad.push(format!("resolve: {e}"));
            return (bad, got, None);
        }
    };
    let facts = rpage.g("facts").g("facts");
    let val = Compute::new(facts, rows);
    let mut keys: Vec<&str> = facts.obj().iter().filter(|(_, q)| !q.has("each")).map(|(k, _)| k.as_str()).collect();
    keys.sort();
    for k in keys {
        if let Err(e) = val.val(k) {
            bad.push(format!("fact {k}: {e}"));
        }
    }
    (bad, got, Some(rpage))
}

#[allow(clippy::too_many_arguments)]
fn recheck_one(
    id: &str,
    kind: &str,
    s0: &J,
    s: &J,
    sel: &[(String, &J)],
    rows: &[J],
    f: &J,
    got: &mut Got,
    bad: &mut Vec<String>,
    same: &Same,
) -> Result<(), String> {
    let codes_of = |x: &J| -> Vec<J> { x.arr().to_vec() };
    match kind {
        "rank" => {
            if let Some(why) = cannot_rank(s) {
                bad.push(format!("select {id} (rank): {why}; the core cannot compute it, so it is refused"));
                got.insert(id.into(), s0.g("result").clone());
                return Ok(());
            }
            let q = s.g("over");
            let by = q.g("by").s().ok_or("'by'")?;
            let only = s.g("only");
            let mut at: Vec<&J> = Vec::new();
            for r in select_rows(rows, q).into_iter().filter(|r| r.g("time") == q.g("time")) {
                let c = r.g("dims").get(by).ok_or_else(|| format!("'{by}'"))?;
                if !only.truthy() || only.arr().contains(c) {
                    at.push(r);
                }
            }
            let codes: Vec<&J> = at.iter().map(|r| dims(r, by)).collect();
            if s.g("one_row_per_code").truthy() && codes.iter().enumerate().any(|(i, c)| codes[..i].contains(c)) {
                bad.push(format!("rank {id}: a code has two rows"));
            }
            let desc = s.g("order").s() == Some("desc");
            let mut keyed: Vec<(f64, String, &J)> = Vec::new();
            for r in at {
                let v = num(r)?;
                keyed.push((if desc { -v } else { v }, st(dims(r, by)), r));
            }
            keyed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(&b.1)));
            let have = J::Arr(keyed.iter().map(|(_, _, r)| dims(r, by).clone()).collect());
            same(bad, format!("select {id} (rank)"), s.g("result"), &have);
            got.insert(id.into(), have);
        }
        "top_n" => {
            let n = int_or_knob(s.g("n"))?;
            let from = st(s.g("from"));
            let src = got.get(&from).ok_or_else(|| format!("'{from}'"))?;
            let have = J::Arr(src.arr().iter().take(n.max(0) as usize).cloned().collect());
            same(bad, format!("select {id} (top_n)"), s.g("result"), &have);
            got.insert(id.into(), have);
        }
        "take" => {
            let from = st(s.g("from"));
            let src = codes_of(got.get(&from).ok_or_else(|| format!("'{from}'"))?);
            let at = s.g("at").s().unwrap_or("");
            let i: i64 = match at {
                "first" => 0,
                "last" => -1,
                "second" => 1,
                "before_last" => -2,
                _ => return Err(format!("at {}", s.g("at").repr())),
            };
            if let Some(why) = cannot_take(s) {
                bad.push(format!("select {id} (take): {why}; the core cannot compute it, so it is refused"));
                got.insert(id.into(), s0.g("result").clone());
                return Ok(());
            }
            let n = src.len() as i64;
            if !src.is_empty() && !(-n <= i && i < n) {
                bad.push(format!("select {id} (take): at {at} of {n} codes is out of range"));
                got.insert(id.into(), J::Null);
                return Ok(());
            }
            let mut pick = if src.is_empty() { J::Null } else { src[(if i < 0 { n + i } else { i }) as usize].clone() };
            let tie = s.g("tie");
            if !pick.is_null() && tie.g("by").s() == Some("printed") && src.len() > 1 {
                let nb = if i == 0 { &src[1] } else { &src[src.len() - 2] };
                let fm = f.g("fmts").g(&st(tie.g("fmt")));
                let dec = fm.g("dec").num().ok_or_else(|| format!("tie fmt {}: no dec", st(tie.g("fmt"))))? as usize;
                let scale = fm.get("scale").map_or(Ok(1.0), |x| x.num().ok_or("scale"))?;
                let pr = |c: &J| -> Result<String, String> { Ok(py_fixed(take_value(sel, &from, c, rows)? * scale, dec)) };
                if pr(&pick)? == pr(nb)? {
                    pick = J::Null;
                }
            }
            same(bad, format!("select {id} (take)"), s.g("result"), &pick);
            got.insert(id.into(), pick);
        }
        "given" | "named_rule" | "registry_list" => {
            got.insert(id.into(), s.g("result").clone());
        }
        "exclude_codes" => {
            got.insert(id.into(), s.g("codes").clone());
            let drs: Vec<&J> = sel.iter().map(|(_, d)| *d).filter(|d| d.g("kind").s() == Some("drop_replace")).collect();
            let named = drs.iter().find(|d| d.g("check").g("sum_within").g("less").arr().iter().any(|x| x.s() == Some(id)));
            let dr = match named {
                Some(d) => *d,
                None => {
                    bad.push(format!("select {id} (exclude_codes): declared but no drop_replace applies it (check.sum_within.less)"));
                    match drs.first() {
                        Some(d) => *d,
                        None => return Ok(()),
                    }
                }
            };
            let c = resolved(dr.g("check").g("sum_within"), got)?;
            let at = |codes: &[J]| -> Vec<&J> {
                rows.iter()
                    .filter(|r| r.g("table") == c.g("table") && r.g("time") == c.g("time"))
                    .filter(|r| dims(r, &st(c.g("place"))) == s.g("place") && codes.contains(dims(r, &st(c.g("dim")))))
                    .collect()
            };
            let whole = sum_rows(at(&[c.g("total").clone()]))?;
            let all: Vec<J> = c.g("parts").obj().iter().flat_map(|(_, cs)| cs.arr().iter().cloned()).collect();
            let gap = sum_rows(at(&all))? - whole;
            let vkey = st(s.g("value"));
            let v = (|| -> Result<f64, String> {
                let q = resolved(f.g("facts").get(&vkey).ok_or_else(|| format!("'{vkey}'"))?, got)?;
                let one = J::Obj(vec![(vkey.clone(), q)]);
                Compute::new(&one, rows).val(&vkey)
            })();
            let v = match v {
                Ok(v) => v,
                Err(e) => {
                    bad.push(format!("select {id}: its value fact fails ({e})"));
                    return Ok(());
                }
            };
            if (gap - v).abs().partial_cmp(&1e-6) != Some(std::cmp::Ordering::Less) {
                bad.push(format!(
                    "select {id} (exclude_codes {} from {}): gap {gap:.3} vs value {v:.3} -> does not hold",
                    s.g("codes").repr(),
                    st(s.g("place"))
                ));
            }
        }
        "drop_replace" => {
            let c = s.g("check").g("sum_within");
            let mut less: Vec<(J, Vec<J>)> = Vec::new();
            for e in c.g("less").arr() {
                if let Some(x) = sel_get(sel, &st(e)) {
                    let place = resolved(x.g("place"), got)?;
                    let codes = resolved(x.g("codes"), got)?;
                    match less.iter_mut().find(|(p, _)| *p == place) {
                        Some((_, cs)) => cs.extend(codes.arr().iter().cloned()),
                        None => less.push((place, codes.arr().to_vec())),
                    }
                }
            }
            let tol = c.g("tol").g("value").num().ok_or("'tol'")?;
            let target = int_or_knob(s.g("target"))?;
            let every: Vec<J> = c.g("parts").obj().iter().flat_map(|(_, cs)| cs.arr().iter().cloned()).collect();
            let (place, dim) = (st(c.g("place")), st(c.g("dim")));
            let (mut drawn, mut dropped): (Vec<J>, Vec<J>) = (Vec::new(), Vec::new());
            let from = st(s.g("from"));
            for code in got.get(&from).ok_or_else(|| format!("'{from}'"))?.arr().to_vec() {
                if drawn.len() as i64 == target {
                    break;
                }
                let at: Vec<&J> = rows
                    .iter()
                    .filter(|r| r.g("table") == c.g("table") && r.g("time") == c.g("time") && *dims(r, &place) == code)
                    .collect();
                let whole = sum_rows(at.iter().copied().filter(|r| dims(r, &dim) == c.g("total")))?;
                let out: &[J] = less.iter().find(|(p, _)| *p == code).map_or(&[], |(_, cs)| cs.as_slice());
                let parts = sum_rows(at.iter().copied().filter(|r| every.contains(dims(r, &dim)) && !out.contains(dims(r, &dim))))?;
                if (parts - whole).abs() > tol * whole.abs() {
                    dropped.push(code);
                } else {
                    drawn.push(code);
                }
            }
            let declared = J::Arr(s.g("dropped").arr().iter().map(|d| d.g("code").clone()).collect());
            same(bad, format!("select {id} (drop_replace)"), s.g("result"), &J::Arr(drawn.clone()));
            same(bad, format!("select {id} dropped"), &declared, &J::Arr(dropped.clone()));
            got.insert(id.into(), J::Arr(drawn));
            got.insert(format!("{id}#dropped"), J::Arr(dropped));
            got.insert(format!("{id}#target"), J::Int(target));
        }
        "zero_parts" => {
            let bars = st(s0.g("bars"));
            let (place, dim) = (st(s.g("place")), st(s.g("dim")));
            let mut want: Vec<J> = Vec::new();
            for bar in got.get(&bars).ok_or_else(|| format!("'{bars}'"))?.arr().to_vec() {
                for (part, codes) in s.g("parts").obj() {
                    let held: Vec<&J> = rows
                        .iter()
                        .filter(|r| r.g("table") == s.g("table") && r.g("time") == s.g("time") && *dims(r, &place) == bar)
                        .filter(|r| codes.arr().contains(dims(r, &dim)))
                        .collect();
                    let mut all_zero = true;
                    for r in &held {
                        all_zero &= num(r)? == 0.0;
                    }
                    let every = codes.arr().iter().all(|c| held.iter().any(|r| r.g("dims").get(&dim) == Some(c)));
                    if !held.is_empty() && all_zero && every {
                        let mut srcs: Vec<String> = held.iter().map(|r| st(r.g("src"))).collect();
                        srcs.sort();
                        want.push(J::Arr(vec![bar.clone(), J::str(part), J::strs(&srcs)]));
                    }
                }
            }
            let have = J::Arr(
                s.g("declared")
                    .arr()
                    .iter()
                    .map(|d| {
                        let mut cells: Vec<String> = d.g("cells").arr().iter().map(st).collect();
                        cells.sort();
                        J::Arr(vec![d.g("bar").clone(), d.g("part").clone(), J::strs(&cells)])
                    })
                    .collect(),
            );
            same(bad, format!("select {id} (zero_parts)"), &have, &J::Arr(want.clone()));
            let bars_set: BTreeSet<String> = want.iter().map(|w| st(w.at(0))).collect();
            got.insert(id.into(), J::strs(&bars_set.into_iter().collect::<Vec<_>>()));
        }
        "set_op" => {
            let side = |k: &str| -> Result<J, String> {
                let x = s0.g(k);
                if is_ref(x) {
                    resolved(x, got)
                } else {
                    got.get(&st(x)).cloned().ok_or_else(|| format!("'{}'", st(x)))
                }
            };
            let (a, b) = (side("a")?, side("b")?);
            let have: Vec<J> = if s.g("op").s() == Some("minus") {
                a.arr().iter().filter(|x| !b.arr().contains(x)).cloned().collect()
            } else {
                a.arr().iter().cloned().chain(b.arr().iter().filter(|x| !a.arr().contains(x)).cloned()).collect()
            };
            same(bad, format!("select {id} (set_op {})", st(s.g("op"))), s.g("result"), &J::Arr(have.clone()));
            got.insert(id.into(), J::Arr(have));
        }
        "empty_parts" => {
            let bars = st(s0.g("bars"));
            let dr = sel_get(sel, &bars).filter(|d| d.g("kind").s() == Some("drop_replace"));
            let Some(dr) = dr else {
                bad.push(format!("select {id} (empty_parts): bars {bars} is no drop_replace, so the core cannot compute it"));
                got.insert(id.into(), s0.g("result").clone());
                return Ok(());
            };
            let c = resolved(dr.g("check").g("sum_within"), got)?;
            let (place, dim) = (st(c.g("place")), st(c.g("dim")));
            let mut want: Vec<J> = Vec::new();
            for bar in got.get(&bars).map(|b| b.arr().to_vec()).unwrap_or_default() {
                for (part, codes) in c.g("parts").obj() {
                    let held: Vec<&J> = rows
                        .iter()
                        .filter(|r| r.g("table") == c.g("table") && r.g("time") == c.g("time") && *dims(r, &place) == bar)
                        .filter(|r| codes.arr().contains(dims(r, &dim)))
                        .collect();
                    let every = codes.arr().iter().all(|x| held.iter().any(|r| dims(r, &dim) == x));
                    let mut all_zero = true;
                    for r in &held {
                        all_zero &= num(r)? == 0.0;
                    }
                    if held.is_empty() || (all_zero && !every) {
                        want.push(J::obj_of(vec![("bar", bar.clone()), ("part", J::str(part))]));
                    }
                }
            }
            same(bad, format!("select {id} (empty_parts)"), s.g("result"), &J::Arr(want.clone()));
            got.insert(id.into(), J::Arr(want));
        }
        k => {
            bad.push(format!("select {id} ({k}): the core cannot compute this kind; a result written on the page is not taken"));
            got.insert(id.into(), s0.g("result").clone());
        }
    }
    Ok(())
}

// ================================================================================================================
// C1: lint, words, shared fields and the node registry over the page (validate.py parts 2, 4-7).
// ================================================================================================================

const EXEMPT: [&str; 6] = ["$.facts.rows", "$.facts.labels", "$.facts.named", "$.facts.points", "$.record", "$.$comment"];
const SELECT_OUT: [&str; 10] = ["result", "declared", "dropped", "rest", "unread", "kept", "id", "from", "bars", "select"];
const NOT_A_CHOICE: [&str; 16] =
    ["node", "kind", "id", "recipe", "role", "rule", "table", "by", "dim", "place", "total", "part", "time", "name_kind", "registry", "w"];

/// A fact key less its printed part: `.n`, `.t` or `.tick<k>`.
fn strip_part(key: &str) -> &str {
    if let Some((head, tail)) = key.rsplit_once('.') {
        if tail == "n" || tail == "t" || tail.strip_prefix("tick").is_some_and(|d| nonempty_all(d, |c| c.is_ascii_digit())) {
            return head;
        }
    }
    key
}

/// The last name of a walk path (`$.a.b[2]` -> b).
fn last_name(path: &str) -> &str {
    let last = path.rsplit('.').next().unwrap_or(path);
    last.split('[').next().unwrap_or(last)
}

fn lint(page: &J, got: &Got, rpage: Option<&J>) -> Vec<String> {
    let f = page.g("facts");
    let (facts, rows, fmts) = (f.g("facts"), f.g("rows").arr(), f.g("fmts"));
    let labels = f.g("labels");
    let by_src: BTreeMap<String, &J> = rows.iter().map(|r| (st(r.g("src")), r)).collect();
    let fams: BTreeSet<&str> = facts.obj().iter().filter(|(_, q)| q.has("each")).map(|(k, _)| k.as_str()).collect();
    let items = page.g("selects").g("items").arr();
    let selects: BTreeMap<String, &J> = items.iter().map(|s| (st(s.g("id")), s)).collect();
    let mut errs = Vec::new();
    let mut chosen: BTreeSet<String> = BTreeSet::new();
    for (sid, s) in &selects {
        let k = s.g("kind").s().unwrap_or("");
        if matches!(k, "rank" | "top_n" | "take" | "drop_replace" | "given" | "exclude_codes") {
            chosen.extend(result_codes(got.get(sid).unwrap_or(s.g("result"))));
        }
        if k == "registry_list" {
            chosen.extend(result_codes(s.g("result")));
        }
    }
    let sel_dims: BTreeSet<String> =
        selects.values().filter(|s| s.g("kind").s() == Some("rank")).map(|s| st(s.g("over").g("by"))).collect();
    let fact_ok = |key: &str| -> bool {
        let key = strip_part(key);
        if facts.has(key) {
            return true;
        }
        let (fam, code) = key.rsplit_once('.').unwrap_or(("", key));
        fams.contains(fam) && !code.is_empty()
    };
    if selects.len() != items.len() {
        errs.push("select ids are not unique".to_string());
    }
    for (k, q) in facts.obj() {
        for side in ["a", "b"] {
            if let Some(x) = q.g(side).s() {
                if !fact_ok(x) {
                    errs.push(format!("fact {k}: {side} {x} is not declared"));
                }
            }
        }
        if let Some(fm) = q.get("fmt") {
            let fm = st(fm);
            if !fmts.has(&fm) && fm != "n" && fm != "pct" {
                errs.push(format!("fact {k}: fmt {fm} has no entry in fmts"));
            }
        }
    }
    for (path, v) in walk(page, "$") {
        if EXEMPT.iter().any(|e| path.starts_with(e)) || (path.starts_with("$.selects") && SELECT_OUT.contains(&last_name(&path))) {
            continue;
        }
        let last = last_name(&path);
        if let Some(x) = v.s() {
            if chosen.contains(x) && !NOT_A_CHOICE.contains(&last) {
                let in_select = path.starts_with("$.selects")
                    && !path.contains(".over.")
                    && !path.contains(".parts")
                    && !path.contains(".only")
                    && !path.contains(".place");
                if !in_select {
                    errs.push(format!("{path}: literal {} is a chosen code; write the select reference", v.repr()));
                }
            }
            if let Some((sid, ..)) = ref_parts(x) {
                if !selects.contains_key(&sid) {
                    errs.push(format!("{path}: {x} names no select"));
                }
            }
        }
        if v.is_obj() {
            if let Some(sid) = ref_id(v) {
                if !selects.contains_key(&sid) {
                    errs.push(format!("{path}: select {sid} is not declared"));
                }
            }
        }
    }
    let Some(rpage) = rpage else { return errs };
    let rfacts = rpage.g("facts").g("facts");
    fn places(rfacts: &J, sel_dims: &BTreeSet<String>, key: &str, seen: &[String]) -> BTreeSet<String> {
        let key = strip_part(key);
        if seen.iter().any(|s| s == key) {
            return BTreeSet::new();
        }
        let Some(q) = rfacts.get(key) else {
            let (fam, code) = key.rsplit_once('.').unwrap_or(("", key));
            return if rfacts.has(fam) { [code.to_string()].into() } else { BTreeSet::new() };
        };
        let mut out = BTreeSet::new();
        for (dim, codes) in q.g("filter").obj() {
            if sel_dims.contains(dim) {
                match codes {
                    J::Str(c) => {
                        out.insert(c.clone());
                    }
                    J::Arr(a) => out.extend(a.iter().map(st)),
                    other => {
                        out.insert(st(other));
                    }
                }
            }
        }
        let mut seen2 = seen.to_vec();
        seen2.push(key.to_string());
        for side in ["a", "b"] {
            if let Some(x) = q.g(side).s() {
                out.extend(places(rfacts, sel_dims, x, &seen2));
            }
        }
        out
    }
    for (path, v) in walk(rpage, "$") {
        if let Some(x) = v.s() {
            if let Some(k) = x.strip_prefix("fact:") {
                if !fact_ok(k) {
                    errs.push(format!("{path}: {x} is not declared"));
                }
            }
            if x.starts_with("series:") && !path.starts_with("$.facts.rows") && !by_src.contains_key(x) {
                errs.push(format!("{path}: {x} is no row of the page"));
            }
        }
        if let J::Obj(m) = v {
            if v.has("fact") && m.iter().all(|(k, _)| k == "fact" || k == "part") && !fact_ok(&st(v.g("fact"))) {
                errs.push(format!("{path}: fact {} is not declared", st(v.g("fact"))));
            }
            if m.len() == 1 && v.has("name") {
                if let Some(n) = v.g("name").s() {
                    if !labels.has(n) {
                        errs.push(format!("{path}: name {n} has no label"));
                    }
                }
            }
            if v.has("code") && path.rsplit('.').next().unwrap_or("").starts_with("items") {
                let code = v.g("code");
                for fld in ["value", "total"] {
                    if let Some(src) = v.g(fld).s() {
                        if let Some(r) = by_src.get(src) {
                            if !r.g("dims").obj().iter().any(|(_, x)| x == code) {
                                errs.push(format!("{path}: {fld} {src} is no row of {}", st(code)));
                            }
                        }
                    }
                }
                if let Some(vt) = v.g("value_text").s() {
                    let k = vt.get(5..).unwrap_or("");
                    if fact_ok(k) {
                        let ps = places(rfacts, &sel_dims, k, &[]);
                        if !ps.is_empty() && !ps.contains(&st(code)) {
                            errs.push(format!("{path}: {vt} reads {:?}, not the item's {}", ps, st(code)));
                        }
                    }
                }
            }
            if v.g("kind").s() == Some("Node") && v.has("items_for") {
                let want = match v.g("items_for") {
                    J::Arr(a) => J::Arr(a.clone()),
                    x => J::Arr(vec![x.clone()]),
                };
                let have = J::Arr(v.g("items").arr().iter().map(|i| i.g("code").clone()).collect());
                if have != want {
                    errs.push(format!("{path} ({}): items {} are not its items_for {}", st(v.g("id")), have.repr(), want.repr()));
                }
            }
        }
    }
    let mut placed: BTreeSet<String> = BTreeSet::new();
    for (sid, s) in &selects {
        if matches!(s.g("kind").s().unwrap_or(""), "rank" | "top_n" | "take" | "drop_replace" | "given") {
            placed.extend(result_codes(got.get(sid).unwrap_or(s.g("result"))));
        }
    }
    for (key, _) in rfacts.obj() {
        let tail = key.rsplit('.').next().unwrap_or(key);
        if placed.contains(tail) {
            let ps = places(rfacts, &sel_dims, key, &[]);
            if !ps.is_empty() && !ps.contains(tail) {
                errs.push(format!("fact {key}: keyed {tail} but reads {ps:?}"));
            }
        }
    }
    errs
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn digit_runs(s: &str) -> BTreeSet<String> {
    let d = |c: char| c.is_ascii_digit() || ('０'..='９').contains(&c);
    let cs: Vec<char> = s.chars().collect();
    let mut out = BTreeSet::new();
    let mut i = 0;
    while i < cs.len() {
        if !d(cs[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < cs.len() && d(cs[i]) {
            i += 1;
        }
        while i + 1 < cs.len() && matches!(cs[i], '.' | ',') && d(cs[i + 1]) {
            i += 1;
            while i < cs.len() && d(cs[i]) {
                i += 1;
            }
        }
        out.insert(cs[start..i].iter().collect());
    }
    out
}

/// The page's own words (validate.words_lint): its title, dek, kicker and finding hold no worded number; a quote is a digit
/// string of the request. A node's lines are said only here (C3 refuses them for the core's own words).
fn words_lint(page: &J, errs: &mut Vec<String>) {
    let req = page.get("request");
    if let Some(req) = req {
        if sha256_hex(&st(req.g("text"))) != st(req.g("sha256")) {
            errs.push("request: sha256 is not the hash of its text".into());
        }
    }
    for (path, v) in walk(page, "$") {
        if v.g("kind").s() != Some("Text") {
            continue;
        }
        let (mut chars, mut held) = (Vec::new(), Vec::new());
        for r in v.g("runs").arr() {
            match r.g("w").s() {
                Some(w) if r.has("w") => {
                    chars.extend(w.chars());
                    held.extend(w.chars().map(|_| false));
                }
                _ => {
                    chars.push(' ');
                    held.push(true);
                }
            }
            if let Some(q) = r.get("quote") {
                let q = st(q);
                match req {
                    None => errs.push(format!("{path}: quote {} but the page holds no request", J::str(&q).repr())),
                    Some(req) => {
                        let text = st(req.g("text"));
                        if !text.contains(&q) || !digit_runs(&q).is_subset(&digit_runs(&text)) {
                            errs.push(format!("{path}: quote {} is not a digit string of the request", J::str(&q).repr()));
                        }
                    }
                }
            }
        }
        if let Some(hit) = worded_number(&chars, &held) {
            if path.starts_with("$.texts") || path.starts_with("$.finding") {
                errs.push(format!("{path}: literal words type a number ({}); a number is a fact run", J::str(&hit).repr()));
            }
        }
    }
}

const SHARED_FIELDS: [&str; 5] = ["category_order", "legend", "scale", "accent", "palette"];

/// No child restates a shared field under any name; accents agree (validate.shared_lint).
fn shared_lint(page: &J, got: &Got, errs: &mut Vec<String>) {
    fn codes_of(v: &J, got: &Got) -> Vec<J> {
        if let Some(s) = v.s().filter(|s| ref_parts(s).is_some()) {
            return match resolve_ref(s, got) {
                Ok(J::Arr(a)) => a,
                Ok(r) => vec![r],
                Err(_) => vec![],
            };
        }
        if v.is_obj() {
            if let Some(sid) = ref_id(v) {
                return match got.get(&sid) {
                    Some(J::Arr(a)) => a.clone(),
                    Some(r) => vec![r.clone()],
                    None => vec![J::Null],
                };
            }
            return vec![];
        }
        if let J::Arr(a) = v {
            return if a.iter().any(|x| x.is_obj() || is_ref(x)) { a.iter().flat_map(|x| codes_of(x, got)).collect() } else { a.clone() };
        }
        vec![]
    }
    let labels = page.g("facts").g("labels");
    let mut accents: Vec<(String, Option<String>)> = Vec::new();
    fn scope(n: &J, inherited: &[(String, J)], path: &str, got: &Got, labels: &J, errs: &mut Vec<String>, accents: &mut Vec<(String, Option<String>)>) {
        let sh = n.g("shared");
        let mut here = inherited.to_vec();
        let put = |here: &mut Vec<(String, J)>, k: String, v: J| match here.iter_mut().find(|(x, _)| *x == k) {
            Some(slot) => slot.1 = v,
            None => here.push((k, v)),
        };
        for f in SHARED_FIELDS {
            if let Some(v) = sh.get(f) {
                put(&mut here, f.to_string(), v.clone());
            }
        }
        for (k, _) in sh.g("knobs").obj() {
            put(&mut here, format!("knob:{k}"), J::Bool(true));
        }
        if let Some(a) = sh.get("accent") {
            accents.push((format!("{path}.shared.accent"), ref_id(a)));
        }
        if let Some(l) = sh.get("legend") {
            for e in l.g("entries").arr() {
                let mut c = codes_of(e.g("code"), got);
                if c.is_empty() {
                    c = vec![e.g("code").clone()];
                }
                if !labels.has(&st(&c[0])) {
                    errs.push(format!("{path}.shared.legend: {} has no label", st(&c[0])));
                }
            }
        }
        let inh = |k: &str| inherited.iter().find(|(x, _)| x == k).map(|(_, v)| v);
        if n.g("kind").s() == Some("Node") {
            let binds = n.g("binds");
            if let Some(a) = binds.get("accent") {
                accents.push((format!("{path}.binds.accent"), ref_id(a)));
            }
            let all = binds.obj().iter().chain(n.g("knobs").obj()).chain(n.g("shared").g("knobs").obj());
            for (name, v) in all {
                if inh(name).is_some() || inh(&format!("knob:{name}")).is_some() {
                    errs.push(format!("{path} ({}): sets shared {} again", st(n.g("id")), J::str(name).repr()));
                } else if let Some(co) = inh("category_order") {
                    let order = codes_of(co, got);
                    let mine = if matches!(v, J::Int(_) | J::Num(_) | J::Bool(_)) { vec![] } else { codes_of(v, got) };
                    if mine.iter().filter(|c| order.contains(c)).count() >= 2 {
                        errs.push(format!("{path} ({}): {} restates the shared category order", st(n.g("id")), J::str(name).repr()));
                    }
                }
            }
            if let Some(co) = inh("category_order") {
                if n.has("items_for") && ref_id(n.g("items_for")) != ref_id(co) {
                    errs.push(format!("{path} ({}): items_for {} is not the shared category order", st(n.g("id")), st(n.g("items_for"))));
                }
            }
        }
        for (i, c) in n.g("children").arr().iter().enumerate() {
            if matches!(c.g("kind").s(), Some("Frame" | "Node")) {
                scope(c, &here, &format!("{path}.children[{i}]"), got, labels, errs, accents);
            }
        }
    }
    scope(page.g("body"), &Vec::new(), "$.body", got, labels, errs, &mut accents);
    let distinct: BTreeSet<&Option<String>> = accents.iter().map(|(_, a)| a).collect();
    if distinct.len() > 1 {
        errs.push(format!("accent: nodes mark different places {accents:?}; declare one accent in shared"));
    }
}

/// Every node of the page is registered and carries its registered bound selects and stop lines (validate.registry_lint).
fn registry_lint(page: &J, reg: &J, errs: &mut Vec<String>) {
    let items = page.g("selects").g("items").arr();
    let selects: BTreeMap<String, &J> = items.iter().map(|s| (st(s.g("id")), s)).collect();
    let checks = page.g("checks").g("items").arr();
    let has_check = |want: &J, bound: &BTreeMap<String, String>| -> bool {
        checks.iter().filter(|c| c.g("kind") == want.g("kind")).any(|c| {
            want.obj().iter().filter(|(f, _)| f != "kind").all(|(f, x)| {
                let x = match x.s().and_then(|s| s.strip_prefix('$')) {
                    Some(name) => bound.get(name).map_or(J::Null, |s| J::str(s)),
                    None => x.clone(),
                };
                let mut have = c.get(f).cloned().unwrap_or_else(|| c.g("args").g(f).clone());
                if f == "knob" {
                    have = have.g("knob").clone();
                }
                if f == "declared" {
                    match &have {
                        J::Arr(a) => a.contains(&x),
                        J::Str(s) => x.s().is_some_and(|x| s.contains(x)),
                        _ => false,
                    }
                } else {
                    have == x
                }
            })
        })
    };
    for want in reg.g("page").g("checks").arr() {
        if !has_check(want, &BTreeMap::new()) {
            errs.push(format!("registry: the page lacks check {}", want.repr()));
        }
    }
    type Scoped<'a> = Vec<(String, &'a J, Vec<(String, J)>)>;
    fn scoped<'a>(n: &'a J, inherited: Vec<(String, J)>, path: String, out: &mut Scoped<'a>) {
        let mut here = inherited.clone();
        for (k, v) in n.g("shared").obj() {
            if k != "knobs" {
                match here.iter_mut().find(|(x, _)| x == k) {
                    Some(slot) => slot.1 = v.clone(),
                    None => here.push((k.clone(), v.clone())),
                }
            }
        }
        out.push((path.clone(), n, inherited));
        for (i, c) in n.g("children").arr().iter().enumerate() {
            if matches!(c.g("kind").s(), Some("Frame" | "Node")) {
                scoped(c, here.clone(), format!("{path}.children[{i}]"), out);
            }
        }
    }
    let mut all = Vec::new();
    scoped(page.g("body"), Vec::new(), "$.body".into(), &mut all);
    for (path, n, inherited) in all {
        if n.g("kind").s() != Some("Node") {
            continue;
        }
        let name = st(n.g("node"));
        let Some(r) = reg.g("nodes").get(&name) else {
            errs.push(format!("registry: node {name} ({path}) is not registered"));
            continue;
        };
        let id = st(n.g("id"));
        let mut bound: BTreeMap<String, String> = BTreeMap::new();
        for b in r.g("bound").arr() {
            let mut found: Option<Vec<Option<String>>> = None;
            for wh in b.g("any_of").arr() {
                let wh = st(wh);
                let one = |v: Option<String>| v.map(|x| vec![Some(x)]);
                match wh.as_str() {
                    "items[*].code" => {
                        let ids: Vec<Option<String>> = n.g("items").arr().iter().map(|i| ref_id(i.g("code"))).collect();
                        if !ids.is_empty() && ids.iter().all(Option::is_some) {
                            found = Some(ids);
                        }
                    }
                    "shared.category_order" => {
                        let co = inherited.iter().find(|(k, _)| k == "category_order").map(|(_, v)| v).unwrap_or(&NULL);
                        if let Some(f) = one(ref_id(co)) {
                            found = Some(f);
                        }
                    }
                    "items_for" => {
                        if let Some(f) = one(ref_id(n.g("items_for"))) {
                            found = Some(f);
                        }
                    }
                    other => {
                        let (sec, key) = other.split_once('.').unwrap_or((other, ""));
                        if let Some(f) = one(ref_id(n.g(sec).g(key))) {
                            found = Some(f);
                        }
                    }
                }
                if found.as_ref().is_some_and(|f| !f.is_empty()) {
                    break;
                }
            }
            let Some(found) = found.filter(|f| !f.is_empty()) else {
                errs.push(format!("registry: {id} must bind {} to a select of kind {}", b.g("any_of").repr(), b.g("kinds").repr()));
                continue;
            };
            for sid in found.iter().flatten() {
                let s = selects.get(sid);
                match s {
                    Some(s) if b.g("kinds").arr().contains(s.g("kind")) => {
                        if b.g("from_kinds").truthy() {
                            let fk = selects.get(&st(s.g("from"))).map_or(&NULL, |x| x.g("kind"));
                            if !b.g("from_kinds").arr().contains(fk) {
                                errs.push(format!("registry: {id}: {sid} must come from a {} select", b.g("from_kinds").repr()));
                            }
                        }
                    }
                    _ => errs.push(format!(
                        "registry: {id} binds {sid} of kind {}, needs {}",
                        s.map_or("None".into(), |s| st(s.g("kind"))),
                        b.g("kinds").repr()
                    )),
                }
            }
            bound.insert(st(b.g("as")), found[0].clone().unwrap_or_default());
        }
        for want in r.g("selects").arr() {
            if !selects.values().any(|s| s.g("kind") == want.g("kind")) {
                errs.push(format!("registry: {id} ({name}) needs a select of kind {}", st(want.g("kind"))));
            }
        }
        for want in r.g("checks").arr() {
            if !has_check(want, &bound) {
                errs.push(format!("registry: {id} ({name}) lacks check {}", want.repr()));
            }
        }
        for f in r.g("shared").arr() {
            if !n.g("shared").has(&st(f)) {
                errs.push(format!("registry: {id} ({name}) must declare shared {}", st(f)));
            }
        }
    }
}

/// P1's checks on the core's copy of the page (its rows the input's): (failure lines, recomputed selects, resolved page).
fn part_a(page: &J, inp: &J, reg: &J) -> (Vec<String>, Got, Option<J>) {
    let root = schema();
    let errs = schema_errors(root, root, page, "$");
    if !errs.is_empty() {
        return (errs.into_iter().take(6).map(|e| format!("schema: {e}")).collect(), BTreeMap::new(), None);
    }
    let mut page = page.clone();
    if let Some(f) = page.get_mut("facts") {
        f.set("rows", inp.g("rows").clone());
    }
    let (bad, got, rpage) = recheck(&page);
    let mut lerrs = lint(&page, &got, rpage.as_ref());
    words_lint(&page, &mut lerrs);
    shared_lint(&page, &got, &mut lerrs);
    lerrs.extend(tree_colour_problems(&page, palettes()));
    if page.has("fragment") {
        lerrs.push("fragment: a node's merged page may not hold one".into());
    }
    registry_lint(&page, reg, &mut lerrs);
    let mut out: Vec<String> = lerrs.into_iter().map(|e| format!("lint: {e}")).collect();
    out.extend(bad.into_iter().map(|b| format!("recheck: {b}")));
    (out, got, rpage)
}

// ================================================================================================================
// C4: what only the core can check because it holds the input (core_recheck.py part B: R1-R12).
// ================================================================================================================

/// The Natural Earth points table the map points must come from (next_flow::NE_POINTS_SHA256, a shared constant).
const PINNED_POINTS: &str = crate::next_flow::NE_POINTS_SHA256;
const REF_PREFIX: [&str; 4] = ["series:", "name:", "fact:", "select:"];
const OUTPUT_FIELDS: [&str; 5] = ["id", "result", "declared", "dropped", "rest"];
/// Checks a later core step computes (the text step); any other kind not evaluated here is refused (R11).
const LATER: [(&str, &str); 2] =
    [("unit_short", "the text step (next_pack.rs unit_short)"), ("finding_words", "the text step (next_run.rs finding_of)")];
const PAGE_CHECKS: [&str; 6] = ["same_numbers_twice", "type_size", "text_contrast", "zeros_declared", "notes_dropped", "strip_placed"];
const ROW_WHATS: [&str; 2] = ["total_row", "number_in_row"];

fn has_digit(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
}

fn pathlike(s: &str) -> bool {
    let t = s.strip_suffix('\n').unwrap_or(s);
    s.starts_with('/')
        || s.starts_with('~')
        || s.starts_with("./")
        || s.starts_with("../")
        || ["runtime/", "data/", "out/", "config/", "session/"].iter().any(|p| s.starts_with(p))
        || [".geojson", ".json", ".csv", ".tsv", ".shp", ".txt", ".py", ".mjs", ".cjs", ".js", ".html"]
            .iter()
            .any(|e| s.ends_with(e) || t.ends_with(e))
}

fn nodes_of(body: &J) -> Vec<(String, &J)> {
    walk(body, "$.body").into_iter().filter(|(_, n)| n.g("kind").s() == Some("Node")).collect()
}

fn check_codes(v: &J, got: &Got) -> Result<Vec<J>, String> {
    Ok(match v {
        J::Arr(a) => a.clone(),
        J::Str(s) if ref_parts(s).is_some() => match resolve_ref(s, got)? {
            J::Arr(a) => a,
            r => vec![r],
        },
        J::Obj(_) if v.has("select") => match got.get(&st(v.g("select"))) {
            Some(J::Arr(a)) => a.clone(),
            Some(r) if r.truthy() => vec![r.clone()],
            _ => vec![],
        },
        _ => vec![],
    })
}

fn named_in(code: &str, table: &J) -> bool {
    table.g("labels").has(code) || table.g("named").obj().iter().any(|(k, _)| k.ends_with(&format!(":{code}")))
}

fn names_of(code: &str, table: &J) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = table.g("labels").get(code).map(st).into_iter().collect();
    out.extend(table.g("named").obj().iter().filter(|(k, _)| k.ends_with(&format!(":{code}"))).map(|(_, t)| st(t)));
    out
}

fn is_knob(v: &J) -> bool {
    v.is_obj() && v.has("knob") && v.has("value")
}

fn knob_problem(have: &J, sent: Option<&J>) -> Option<String> {
    let name = st(have.g("knob"));
    if !is_knob(have) {
        return Some(format!("{} is no knob value", have.repr()));
    }
    let Some(sent) = sent else { return Some(format!("knob {name} was not sent with the request")) };
    let v = have.g("value");
    let mut out = Vec::new();
    if v != sent.g("value") {
        out.push(format!("knob {name} = {}, not the value sent {}", st(v), st(sent.g("value"))));
    }
    let inside = match (v.num(), sent.g("min").num(), sent.g("max").num()) {
        (Some(x), Some(lo), Some(hi)) => lo <= x && x <= hi,
        _ => false,
    };
    if !inside {
        out.push(format!("knob {name} = {} outside the registry range [{}, {}]", st(v), st(sent.g("min")), st(sent.g("max"))));
    }
    (!out.is_empty()).then(|| out.join("; "))
}

/// (passed, why): passed as the core computes it; (None, why) a later core step computes it; (None, None) the core cannot.
fn evaluate(c: &J, page: &J, inp: &J, got: &Got, items_of: &BTreeMap<String, usize>, table: &J) -> (Option<bool>, Option<String>) {
    let (k, a) = (c.g("kind").s().unwrap_or(""), c.g("args"));
    let f = page.g("facts");
    let len = |v: Option<&J>| -> usize {
        match v {
            Some(J::Arr(x)) => x.len(),
            Some(J::Str(s)) => s.chars().count(),
            Some(J::Obj(m)) => m.len(),
            _ => 0,
        }
    };
    match k {
        "count_equals" => {
            let n = items_of.get(&st(a.g("items"))).copied().unwrap_or(0);
            let want = len(got.get(&st(a.g("select"))));
            (Some(n == want), Some(format!("{n} items, select {} holds {want}", st(a.g("select")))))
        }
        "points_pinned" => {
            let ok = f.g("points").g("sha256").s() == Some(PINNED_POINTS);
            (Some(ok), Some(format!("table sha256 {}", if ok { "pinned" } else { "not pinned" })))
        }
        "named" | "one_name" => match check_codes(c.g("codes"), got) {
            Err(e) => (Some(false), Some(e)),
            Ok(codes) => {
                let off: Vec<String> = codes
                    .iter()
                    .map(st)
                    .filter(|x| if k == "named" { !named_in(x, table) } else { names_of(x, table).len() != 1 })
                    .collect();
                (Some(off.is_empty()), Some(if off.is_empty() { "every code named".into() } else { format!("off {off:?}") }))
            }
        },
        "tolerance_fixed" => {
            let kn = c.g("knob");
            let bad = knob_problem(kn, inp.g("knobs").get(&st(kn.g("knob"))));
            (Some(bad.is_none()), Some(bad.unwrap_or_else(|| "the value sent, in the registry range".into())))
        }
        "ranks_some" => {
            let ok = got.get(&st(a.g("select"))).is_some_and(J::truthy);
            (Some(ok), Some(if ok { "some" } else { "none" }.into()))
        }
        "one_row_per_code" | "max_dropped" | "fill_after_drop" => {
            (Some(true), Some("computed in part A from the input rows (a failure there stops the page)".into()))
        }
        "has_composition" => {
            let ok = page.g("record").g("composition").is_obj();
            (Some(ok), Some(if ok { "a composition record, derived in R10" } else { "no composition record" }.into()))
        }
        "row_exists" => {
            if !c.g("what").s().is_some_and(|w| ROW_WHATS.contains(&w)) {
                return (None, None);
            }
            // for_each names the codes each of which must have the row: without it the core has nothing to check (11-01)
            let Some(codes) = c.g("for_each").s().and_then(|s| got.get(s)).filter(|v| v.is_arr()) else { return (None, None) };
            let q = c.g("query");
            let mut lack = Vec::new();
            for x in codes.arr() {
                let rs: Vec<&J> = inp
                    .g("rows")
                    .arr()
                    .iter()
                    .filter(|r| r.g("table") == q.g("table") && r.g("time") == q.g("time"))
                    .filter(|r| q.g("filter").obj().iter().all(|(d, v)| r.g("dims").get(d).is_some_and(|x| x == v)))
                    .filter(|r| r.g("dims").obj().iter().any(|(_, v)| v == x))
                    .collect();
                if rs.is_empty() || (c.g("what").s() == Some("number_in_row") && !rs.iter().all(|r| num(r).is_ok())) {
                    lack.push(st(x));
                }
            }
            (Some(lack.is_empty()), Some(format!("{} for {lack:?}", st(c.g("what")))))
        }
        "page_check" => {
            if c.g("name").s().is_some_and(|n| PAGE_CHECKS.contains(&n)) {
                (None, Some(format!("computed by the page checks ({})", st(c.g("name")))))
            } else {
                (None, None)
            }
        }
        k => match LATER.iter().find(|(n, _)| *n == k) {
            Some((_, by)) => (None, Some(format!("computed by {by}"))),
            None => (None, None),
        },
    }
}

fn spec_diff(path: &str, want: &J, have: &J, knobs: &J, out: &mut Vec<String>) {
    if is_knob(want) {
        if !is_knob(have) || have.g("knob") != want.g("knob") {
            out.push(format!("{path} {} is not the declared knob {}", have.repr(), st(want.g("knob"))));
            return;
        }
        let bad = match knobs.get(&st(want.g("knob"))) {
            Some(sent) => knob_problem(have, Some(sent)),
            None if have.g("value") == want.g("value") => None,
            None => Some(format!("knob {} = {}, not the value sent {}", st(want.g("knob")), st(have.g("value")), st(want.g("value")))),
        };
        if let Some(b) = bad {
            out.push(format!("{path} {b}"));
        }
        return;
    }
    if want.is_obj() && have.is_obj() {
        let mut keys: Vec<&str> = want.obj().iter().chain(have.obj()).map(|(k, _)| k.as_str()).collect();
        keys.sort();
        keys.dedup();
        for k in keys {
            if path.is_empty() && OUTPUT_FIELDS.contains(&k) {
                continue;
            }
            let sub = if path.is_empty() { k.to_string() } else { format!("{path}.{k}") };
            match (want.get(k), have.get(k)) {
                (Some(w), None) => out.push(format!("{sub} is missing; declared {}", w.repr())),
                (None, Some(h)) => out.push(format!("{sub} {} is not declared", h.repr())),
                (Some(w), Some(h)) => spec_diff(&sub, w, h, knobs, out),
                (None, None) => {}
            }
        }
        return;
    }
    if want != have {
        out.push(format!("{path} {} is not the declared {}", have.repr(), want.repr()));
    }
}

/// The input rows a resolved fact query reads (none for an op over two facts).
fn fact_rows<'a>(q: &J, rows: &'a [J]) -> Vec<&'a J> {
    if !q.has("table") {
        return vec![];
    }
    select_rows(rows, q)
        .into_iter()
        .filter(|r| {
            let t = r.g("time").s().unwrap_or("");
            !(q.has("time") && r.g("time") != q.g("time"))
                && !(q.has("from") && t < q.g("from").s().unwrap_or(""))
                && !(q.has("to") && t > q.g("to").s().unwrap_or(""))
                && !(q.has("within") && !t.starts_with(q.g("within").s().unwrap_or("")))
        })
        .collect()
}

fn part_b(inp: &J, page: &J, ext: &[String], got: &Got, rpage: Option<&J>) -> Vec<String> {
    let mut errs = Vec::new();
    let f = page.g("facts");
    let rows = inp.g("rows").arr();
    let by_src: BTreeMap<String, &J> = rows.iter().map(|r| (st(r.g("src")), r)).collect();
    // R1 rows
    for r in f.g("rows").arr() {
        let src = st(r.g("src"));
        match by_src.get(&src) {
            None => errs.push(format!("R1 row {src}: not in the node's input rows")),
            Some(x) if *x != r => errs.push(format!("R1 row {src}: differs from the input row")),
            _ => {}
        }
    }
    // R2 printed numbers
    let body = page.g("body");
    for (path, v) in walk(body, "$.body") {
        if !v.is_obj() {
            continue;
        }
        for fld in ["value_text", "total_text"] {
            if let Some(x) = v.get(fld) {
                if !x.s().is_some_and(|s| s.starts_with("fact:")) {
                    errs.push(format!("R2 {path}.{fld} = {}: a printed number with no fact reference", x.repr()));
                }
            }
        }
        for (k, x) in v.g("share_text").obj() {
            if !x.s().is_some_and(|s| s.starts_with("fact:")) {
                errs.push(format!("R2 {path}.share_text.{k} = {}: a printed number with no fact reference", x.repr()));
            }
        }
    }
    for (path, v) in nodes_of(body) {
        if ext.contains(&st(v.g("id"))) {
            for (p2, w) in walk(v, &path) {
                if let Some(x) = w.g("w").s() {
                    if w.is_obj() && has_digit(x) {
                        errs.push(format!("R2 {p2}: external node {} prints a number outside a fact ({})", st(v.g("id")), J::str(x).repr()));
                    }
                }
            }
        }
    }
    // R3 claimed values: plan B takes none from a node
    // R4 names
    let table = inp.g("name_table");
    for (code, zh) in f.g("labels").obj() {
        if table.g("labels").get(code) != Some(zh) {
            errs.push(format!("R4 label {code} = {}: not the name table's ({})", zh.repr(), table.g("labels").g(code).repr()));
        }
    }
    for (src, text) in f.g("named").obj() {
        if table.g("named").get(src) != Some(text) {
            errs.push(format!("R4 name row {src} = {}: not the name table's ({})", text.repr(), table.g("named").g(src).repr()));
        }
    }
    // R5 picks the flow made
    let selects = page.g("selects").g("items").arr();
    for s in selects {
        if matches!(s.g("kind").s().unwrap_or(""), "given" | "named_rule" | "registry_list") {
            let id = st(s.g("id"));
            match inp.g("given").get(&id) {
                None => errs.push(format!("R5 select {id} ({}): the flow's record holds no such pick", st(s.g("kind")))),
                Some(want) if s.g("result") != want => errs.push(format!(
                    "R5 select {id} ({}): result {} is not the flow's record {}",
                    st(s.g("kind")),
                    s.g("result").repr(),
                    want.repr()
                )),
                _ => {}
            }
        }
    }
    let returned: BTreeSet<String> = selects.iter().map(|s| st(s.g("id"))).collect();
    let mut given: Vec<&String> = inp.g("given").obj().iter().map(|(k, _)| k).filter(|k| !returned.contains(*k)).collect();
    given.sort();
    for sid in given {
        errs.push(format!("R5 the flow's pick {sid} has no select on the page"));
    }
    // R6 / R11 every check evaluated by the core; passed comes from nowhere else
    if rpage.is_none() {
        errs.push("R6 not evaluated: the page failed part A before its selects were recomputed".into());
    } else {
        let items_of: BTreeMap<String, usize> = nodes_of(body).iter().map(|(_, n)| (st(n.g("id")), n.g("items").arr().len())).collect();
        for c in page.g("checks").g("items").arr() {
            let (id, k) = (st(c.g("id")), st(c.g("kind")));
            if let Some(p) = c.get("passed") {
                errs.push(format!("R6 check {id} {k}: carries passed={}; only the core computes passed", p.repr()));
            }
            match evaluate(c, page, inp, got, &items_of, table) {
                (None, None) => errs.push(format!("R11 check {id} {k}: the core cannot compute this check, so it is refused")),
                (None, Some(_)) | (Some(true), _) => {}
                (Some(false), why) => {
                    let why = why.unwrap_or_default();
                    if c.g("on_fail").s() == Some("stop") {
                        errs.push(format!("R6 check {id} {k}: {why}; it stops the page"));
                    } else {
                        errs.push(format!("R6 check {id} {k}: {why}; on_fail {}", c.g("on_fail").repr()));
                    }
                }
            }
        }
    }
    // R7 no file
    if f.g("assets").truthy() {
        errs.push("R7 facts.assets: the node names a file; assets come from the entry by id and sha256".into());
    }
    for (path, v) in walk(page, "$") {
        if path.starts_with("$.$comment") || path.starts_with("$.facts.assets") {
            continue;
        }
        if let Some(x) = v.s() {
            if !REF_PREFIX.iter().any(|p| x.starts_with(p)) && pathlike(x) {
                errs.push(format!("R7 {path} = {}: the node names a file", v.repr()));
            }
        }
    }
    // R8 points
    let (want, have) = (inp.g("points"), f.g("points"));
    if have.truthy() {
        if have.g("sha256") != want.g("sha256") || have.g("table") != want.g("table") {
            errs.push("R8 points: not the table the input carried".into());
        }
        for (code, p) in have.g("at").obj() {
            if want.g("at").get(code) != Some(p) {
                errs.push(format!("R8 point {code} = {}: not the input's {}", p.repr(), want.g("at").g(code).repr()));
            }
        }
    }
    // R9 every select's way of choosing as declared, knob values as sent
    let (spec, knobs) = (inp.g("select_spec"), inp.g("knobs"));
    for s in selects {
        let id = st(s.g("id"));
        match spec.get(&id) {
            None => errs.push(format!("R9 select {id}: neither the flow's record nor the registry declares it")),
            Some(want) => {
                let mut diffs = Vec::new();
                spec_diff("", want, s, knobs, &mut diffs);
                errs.extend(diffs.into_iter().map(|d| format!("R9 select {id}: {d}")));
            }
        }
    }
    r10(inp, page, got, rpage, &mut errs);
    if rpage.is_some() {
        r12(inp, page, got, ext, &mut errs);
    }
    errs
}

fn r10(inp: &J, page: &J, got: &Got, rpage: Option<&J>, errs: &mut Vec<String>) {
    let Some(rpage) = rpage else {
        errs.push("R10 not evaluated: the page failed part A before its selects were recomputed".into());
        return;
    };
    let rows = inp.g("rows").arr();
    let items = page.g("selects").g("items").arr();
    let sel: Vec<(String, &J)> = items.iter().map(|s| (st(s.g("id")), s)).collect();
    let nodes: Vec<(String, &J)> = nodes_of(page.g("body")).into_iter().map(|(_, n)| (st(n.g("id")), n)).collect();
    let node = |id: &str| nodes.iter().find(|(k, _)| k == id).map(|(_, n)| *n);
    let mut bound: BTreeMap<String, (String, J)> = BTreeMap::new();
    for (nid, n) in &nodes {
        let b = n.g("binds");
        let r = if b.g("ranked").truthy() { b.g("ranked") } else { n.g("items_for") };
        let sid = if r.truthy() { ref_id(r) } else { None };
        let Some(sid) = sid else { continue };
        let Some(s) = sel_get(&sel, &sid) else { continue };
        if !matches!(s.g("kind").s().unwrap_or(""), "rank" | "top_n" | "drop_replace") {
            continue;
        }
        let Ok(root) = root_rank(&sel, &sid) else { continue };
        let over = root.g("over").clone();
        for (fl, of) in [("by", "by"), ("year", "time")] {
            if let Some(x) = b.get(fl) {
                if x != over.g(of) {
                    errs.push(format!("R10 node {nid}: binds.{fl} {} is not its select's over.{of} {}", x.repr(), over.g(of).repr()));
                }
            }
        }
        bound.insert(nid.clone(), (sid, over));
    }
    let drawn = page.g("record").g("drawn").arr();
    let rules = inp.g("drawn_rules");
    let mut layers: BTreeSet<String> = drawn.iter().map(|d| st(d.g("layer"))).collect();
    for nid in bound.keys() {
        if node(nid).is_some_and(|n| rules.g(&st(n.g("node"))).truthy()) {
            layers.insert(nid.clone());
        }
    }
    let quad = |l: &str, r: &J| [l.to_string(), st(r.g("src")), st(r.g("table")), st(r.g("time"))];
    for nid in layers {
        let have: Vec<[String; 4]> = drawn.iter().filter(|d| st(d.g("layer")) == nid).map(|d| quad(&nid, d)).collect();
        let rule_ok = node(&nid).is_some_and(|n| rules.g(&st(n.g("node"))).s() == Some("rows_of_select"));
        if !rule_ok {
            errs.push(format!("R10 drawn {nid}: the registry gives this node no drawn rule, so nothing it hands to Filled.drawn can be derived"));
            continue;
        }
        let Some((sid, over)) = bound.get(&nid) else {
            errs.push(format!("R10 drawn {nid}: no select of the page binds what this layer draws"));
            continue;
        };
        let codes = got.get(sid).map(|c| c.arr().to_vec()).unwrap_or_default();
        let by = st(over.g("by"));
        let want: Vec<[String; 4]> = rows
            .iter()
            .filter(|r| r.g("table") == over.g("table") && r.g("time") == over.g("time") && codes.contains(dims(r, &by)))
            .map(|r| quad(&nid, r))
            .collect();
        if have != want {
            let (mut a, mut b) = (have.clone(), want.clone());
            a.sort();
            b.sort();
            let srcs = |v: &[[String; 4]]| v.iter().map(|x| x[1].clone()).collect::<Vec<_>>();
            if a == b {
                errs.push(format!("R10 drawn {nid}: the rows of select {sid}, but in the order {:?}, not the input order", srcs(&have)));
            } else {
                errs.push(format!("R10 drawn {nid}: {:?} are not the input rows of select {sid} {:?}", srcs(&have), srcs(&want)));
            }
        }
    }
    let mut read: BTreeSet<String> = BTreeSet::new();
    for (_, q) in rpage.g("facts").g("facts").obj() {
        read.extend(fact_rows(q, rows).iter().map(|r| st(r.g("src"))));
    }
    read.extend(select_rows_read(&sel, got, rows));
    let rec = page.g("record");
    if rec.has("pairs") {
        errs.push("R10 pairs: P3 derives no flow pairs (Filled.flow_pairs); an external node may not hand them".into());
    }
    if let Some(have) = rec.get("composition") {
        composition(have, inp, &sel, got, errs);
    }
    read.extend(drawn.iter().map(|d| st(d.g("src"))));
    let want: Vec<String> = rows.iter().map(|r| st(r.g("src"))).filter(|s| read.contains(s)).collect();
    let have: Vec<String> = page.g("facts").g("rows").arr().iter().map(|r| st(r.g("src"))).collect();
    if have != want {
        errs.push(format!("R10 rows: facts.rows {have:?} is not the drawn and read input rows {want:?}"));
    }
}

/// Input rows the drop_replace sum checks and the zero_parts declarations read.
fn select_rows_read(sel: &[(String, &J)], got: &Got, rows: &[J]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (id, s) in sel {
        match s.g("kind").s() {
            Some("drop_replace") => {
                let Ok(c) = resolved(s.g("check").g("sum_within"), got) else { continue };
                let mut codes: Vec<J> = c.g("parts").obj().iter().flat_map(|(_, cs)| cs.arr().iter().cloned()).collect();
                codes.push(c.g("total").clone());
                let bars = got.get(id).map(|b| b.arr().to_vec()).unwrap_or_default();
                let (place, dim) = (st(c.g("place")), st(c.g("dim")));
                out.extend(
                    rows.iter()
                        .filter(|r| r.g("table") == c.g("table") && r.g("time") == c.g("time"))
                        .filter(|r| bars.contains(dims(r, &place)) && codes.contains(dims(r, &dim)))
                        .map(|r| st(r.g("src"))),
                );
            }
            Some("zero_parts") => {
                for d in s.g("declared").arr() {
                    out.extend(d.g("cells").arr().iter().map(st));
                }
            }
            _ => {}
        }
    }
    out
}

/// Filled.composition derived from the recomputed selects and the flow's record.
fn composition(have: &J, inp: &J, sel: &[(String, &J)], got: &Got, errs: &mut Vec<String>) {
    let dr = sel.iter().map(|(_, s)| *s).find(|s| s.g("kind").s() == Some("drop_replace"));
    let zp = sel.iter().map(|(_, s)| *s).find(|s| s.g("kind").s() == Some("zero_parts"));
    let Some(dr) = dr else {
        errs.push("R10 composition: no drop_replace select to derive it from".into());
        return;
    };
    let c = dr.g("check").g("sum_within");
    let id = st(dr.g("id"));
    let arr = |k: &str| got.get(k).filter(|v| v.truthy()).cloned().unwrap_or(J::Arr(vec![]));
    let (bars, dropped, cands) = (arr(&id), arr(&format!("{id}#dropped")), arr(&st(dr.g("from"))));
    let flow = inp.g("flow_record");
    let left = flow.get("left_out").cloned().unwrap_or(J::Arr(vec![]));
    let mut others: Vec<J> = cands.arr().iter().filter(|x| !bars.arr().contains(x) && !dropped.arr().contains(x)).cloned().collect();
    others.extend(left.arr().iter().filter(|x| !cands.arr().contains(x)).cloned());
    let want = vec![
        ("template", flow.g("template").clone()),
        ("dim", c.g("dim").clone()),
        ("total", c.g("total").clone()),
        ("year", c.g("time").clone()),
        ("place", c.g("place").clone()),
        ("candidates", cands.clone()),
        ("bars", bars.clone()),
        ("dropped", dropped.clone()),
        ("others", J::Arr(others)),
        ("zero", zp.map_or(J::Arr(vec![]), |z| z.g("declared").clone())),
        ("left_out", left.clone()),
    ];
    let got_dropped = J::Arr(have.g("dropped").arr().iter().map(|d| if d.is_obj() { d.g("code").clone() } else { d.clone() }).collect());
    for (k, w) in &want {
        let h = if *k == "dropped" { got_dropped.clone() } else { have.g(k).clone() };
        if h != *w {
            errs.push(format!("R10 composition.{k} {} is not the one derived from the selects {}", h.repr(), w.repr()));
        }
    }
    let mut extra: Vec<&str> = have.obj().iter().map(|(k, _)| k.as_str()).filter(|k| !want.iter().any(|(w, _)| w == k)).collect();
    extra.sort();
    if !extra.is_empty() {
        errs.push(format!("R10 composition: fields {extra:?} have no derivation"));
    }
}

fn r12(inp: &J, page: &J, got: &Got, ext: &[String], errs: &mut Vec<String>) {
    let rows = inp.g("rows").arr();
    let by_src: BTreeMap<String, &J> = rows.iter().map(|r| (st(r.g("src")), r)).collect();
    let sel = page.g("selects").g("items").arr();
    for (_, n) in nodes_of(page.g("body")) {
        let nid = st(n.g("id"));
        if !ext.contains(&nid) {
            continue;
        }
        for (i, it) in n.g("items").arr().iter().enumerate() {
            let mut code = it.g("code").clone();
            if let Some(s) = code.s().filter(|s| ref_parts(s).is_some()) {
                match resolve_ref(s, got) {
                    Ok(c) => code = c,
                    Err(e) => {
                        errs.push(format!("R12 node {nid} item {i}: {e}"));
                        continue;
                    }
                }
            }
            let mine = |src: &str| by_src.get(src).is_some_and(|r| r.g("dims").obj().iter().any(|(_, v)| *v == code));
            let mut bad: Vec<String> = walk(it, "$")
                .into_iter()
                .filter_map(|(_, v)| v.s())
                .filter(|v| v.starts_with("series:") && !mine(v))
                .map(str::to_string)
                .collect();
            if it.has("cells") {
                let parts = inp.get("part_codes");
                let tot = it.g("total").s().and_then(|s| by_src.get(s)).copied().unwrap_or(&NULL);
                let Some(parts) = parts else {
                    errs.push(format!("R12 node {nid} item {i}: cells, but the input holds no part table to derive them from"));
                    continue;
                };
                let mut names: Vec<&str> = it.g("cells").obj().iter().chain(parts.obj()).map(|(k, _)| k.as_str()).collect();
                names.sort();
                names.dedup();
                for part in names {
                    let have = it.g("cells").get(part).filter(|h| h.truthy()).cloned();
                    let mut out: Vec<J> = Vec::new();
                    for s in sel {
                        if s.g("kind").s() == Some("exclude_codes") && s.g("part").s() == Some(part) {
                            let place = s.g("place").s().map(|p| resolve_ref(p, got));
                            if matches!(place, Some(Ok(ref p)) if *p == code) {
                                out.extend(s.g("codes").arr().iter().cloned());
                            }
                        }
                    }
                    let zero = sel.iter().filter(|s| s.g("kind").s() == Some("zero_parts")).any(|s| {
                        s.g("declared").arr().iter().any(|d| *d.g("bar") == code && d.g("part").s() == Some(part))
                    });
                    let want: Option<J> = if zero {
                        None
                    } else {
                        let pc = parts.g(part).arr();
                        let w: Vec<J> = rows
                            .iter()
                            .filter(|r| r.g("table") == tot.g("table") && r.g("time") == tot.g("time"))
                            .filter(|r| r.g("dims").obj().iter().any(|(_, v)| *v == code))
                            .filter(|r| r.g("dims").obj().iter().any(|(_, x)| pc.contains(x) && !out.contains(x)))
                            .map(|r| r.g("src").clone())
                            .collect();
                        (!w.is_empty()).then_some(J::Arr(w))
                    };
                    if !parts.has(part) || have != want {
                        bad.push(format!("cells.{part} {} (derived: {})", have.map_or("None".into(), |h| h.repr()), want.map_or("None".into(), |w| w.repr())));
                    }
                }
            }
            if !bad.is_empty() {
                errs.push(format!("R12 node {nid} item {i} ({}): {bad:?} are not its own code's input rows", st(&code)));
            }
        }
    }
}

// ================================================================================================================
// C5: the node registry (P1's node-registry.json with the external bindings over it, core_b.registry_problems).
// ================================================================================================================

/// The largest tolerance (px) a registry may give a value-determined field; an entry may only be stricter.
pub const TOL_PX_MAX: f64 = 0.5;
/// The farthest an item's text may sit from its own mark (B5's max_px) in any registry entry: the farthest relation a
/// registered node draws today, the bar's label under its baseline (24 px); every other registered relation is nearer
/// (12, 8, 6). A registry may only be stricter.
pub const MAX_PX_MAX: f64 = 24.0;
/// The largest circle radius a registry's radius_area scale may declare: the bubbles' 28 px, the one registered today.
pub const RADIUS_PX_MAX: f64 = 28.0;
const CHECK_KINDS: [&str; 14] = [
    "count_equals", "points_pinned", "named", "one_name", "tolerance_fixed", "ranks_some", "one_row_per_code", "max_dropped",
    "fill_after_drop", "has_composition", "row_exists", "page_check", "unit_short", "finding_words",
];
/// Value-determined geometry: channel -> (the field tuples it decides, what it encodes, scale kind, domain source, range).
/// Every part of a scale is the core's; a registry may only add the declared constants (band padding, max radius).
/// A channel the core recomputes: (name, its field sets, what it encodes, scale kind, domain, range).
type Channel = (&'static str, &'static [&'static [&'static str]], &'static str, &'static str, &'static str, &'static str);
const CHANNELS: [Channel; 6] = [
    ("length_up", &[&["h", "y"]], "value", "linear", "zero_to_max", "plot.y"),
    ("band_x", &[&["x", "w"]], "item", "band", "items", "plot.x"),
    ("band_y", &[&["y", "h"]], "item", "band", "items", "plot.y"),
    ("radius_area", &[&["r"]], "value", "sqrt", "zero_to_max", "max_px"),
    ("point", &[&["cx", "cy"], &["x2", "y2"]], "at", "mercator", "ext", "plot"),
    ("stack_x", &[&["x", "w"]], "share", "linear", "zero_to_one", "plot.x"),
];
const FIELD_KINDS: [&str; 7] = ["select_index", "row_of_code", "fact_template", "code_is", "point_of_code", "cells_by_part", "fact_per_part"];
const FOR_EACH: [&str; 4] = ["binds.ranked", "binds.bars", "items_for", "spec"];
/// The reply allow-list: each shape's fields, a text's fields, the anchors, the one refusal.
pub const SHAPES: [(&str, &[&str]); 3] = [("rect", &["x", "y", "w", "h"]), ("circle", &["cx", "cy", "r"]), ("line", &["x1", "y1", "x2", "y2"])];
pub const TEXT_FIELDS: [&str; 3] = ["x", "y", "anchor"];
pub const ANCHORS: [&str; 3] = ["start", "middle", "end"];
pub const REFUSALS: [&str; 1] = ["no_room"];
const TOP: [&str; 2] = ["marks", "texts"];

fn shape_fields(shape: &str) -> Option<&'static [&'static str]> {
    SHAPES.iter().find(|(s, _)| *s == shape).map(|(_, f)| *f)
}

/// P1's node registry with an overlay over it: the overlay's frames, and each overlay node's fields set over P1's entry.
pub fn load_registry(overlay: &J) -> J {
    let mut reg = parse(P1_REGISTRY_TEXT).expect("node-registry.json parses");
    reg.set("frames", overlay.get("frames").cloned().unwrap_or(J::Obj(vec![])));
    let mut nodes = reg.remove("nodes").unwrap_or(J::Obj(vec![]));
    for (k, v) in overlay.g("nodes").obj() {
        if !nodes.has(k) {
            nodes.set(k, J::Obj(vec![]));
        }
        let e = nodes.get_mut(k).expect("set above");
        for (f, x) in v.obj() {
            e.set(f, x.clone());
        }
    }
    reg.set("nodes", nodes);
    reg
}

/// C5: every external node's entry names only what the core computes; a rust-bound node keeps its rust fill.
pub fn registry_problems(reg: &J) -> Vec<String> {
    let mut out = Vec::new();
    for c in reg.g("page").g("checks").arr() {
        if !c.g("kind").s().is_some_and(|k| CHECK_KINDS.contains(&k)) {
            out.push(format!("C5 registry page check {}: the core cannot compute it", st(c.g("kind"))));
        }
    }
    for (name, e) in reg.g("nodes").obj() {
        if e.g("binding").s() != Some("external") {
            continue;
        }
        let p = format!("C5 registry {name}");
        for c in e.g("checks").arr() {
            let k = st(c.g("kind"));
            if !CHECK_KINDS.contains(&k.as_str()) {
                out.push(format!("{p} check {k}: the core cannot compute it"));
            } else if k == "row_exists" && !c.g("what").s().is_some_and(|w| ROW_WHATS.contains(&w)) {
                out.push(format!("{p} check row_exists what={}: the core cannot compute it", c.g("what").repr()));
            } else if k == "page_check" && !c.g("name").s().is_some_and(|n| PAGE_CHECKS.contains(&n)) {
                out.push(format!("{p} page check {}: no core page check computes it", c.g("name").repr()));
            }
        }
        if !e.g("frame").s().is_some_and(|f| reg.g("frames").has(f)) {
            out.push(format!("{p} frame {}: not a registered frame", e.g("frame").repr()));
        }
        let it = e.g("items");
        if !it.g("for_each").s().is_some_and(|f| FOR_EACH.contains(&f)) {
            out.push(format!("{p} items.for_each {}: not one the core expands", it.g("for_each").repr()));
        }
        for (f, d) in it.g("fields").obj() {
            if !d.g("kind").s().is_some_and(|k| FIELD_KINDS.contains(&k)) {
                out.push(format!("{p} items.fields.{f} kind {}: the core cannot expand it", d.g("kind").repr()));
            }
        }
        let m = e.g("marks");
        let tol = m.g("tol_px");
        if tol.finite() && !(0.0..=TOL_PX_MAX).contains(&tol.num().expect("finite")) {
            out.push(format!("{p} marks: tol_px {} is over the core's cap {}; a registry may only be stricter", st(tol), py_float(TOL_PX_MAX)));
        }
        let shape = m.g("shape").s().and_then(shape_fields);
        if shape.is_none() || !m.g("per").s().is_some_and(|x| x == "item" || x == "part") || !tol.finite() {
            out.push(format!("{p} marks: shape {} / per {} / tol_px not one the core checks", m.g("shape").repr(), m.g("per").repr()));
            continue;
        }
        let mut covered: Vec<String> = m.g("free").arr().iter().map(st).collect();
        for ch in m.g("encode").arr() {
            let sc = ch.g("scale");
            let fields: Vec<String> = ch.g("fields").arr().iter().map(st).collect();
            let def = CHANNELS.iter().find(|c| ch.g("channel").s() == Some(c.0));
            let ok = def.is_some_and(|(_, ftuples, of, kind, domain, range)| {
                let consts: &[&str] = if *kind == "band" { &["padding"] } else { &[] };
                let rng = sc.g("range");
                ftuples.iter().any(|t| t.len() == fields.len() && t.iter().zip(&fields).all(|(a, b)| a == b))
                    && ch.g("of").s() == Some(of)
                    && sc.g("kind").s() == Some(kind)
                    && sc.g("domain").s() == Some(domain)
                    && (rng.s() == Some(range)
                        || (*range == "max_px"
                            && rng.is_obj()
                            && rng.obj().len() == 1
                            && rng.g("max_px").num().is_some_and(|r| r > 0.0 && r <= RADIUS_PX_MAX)))
                    && {
                        let mut extra: Vec<&str> = sc.obj().iter().map(|(k, _)| k.as_str()).filter(|k| !["kind", "domain", "range"].contains(k)).collect();
                        extra.sort();
                        extra == consts
                    }
                    && consts.iter().all(|k| sc.g(k).finite() && (0.0..1.0).contains(&sc.g(k).num().expect("finite")))
                    && {
                        let mut keys: Vec<&str> = ch.obj().iter().map(|(k, _)| k.as_str()).collect();
                        keys.sort();
                        keys == ["channel", "fields", "of", "scale"]
                    }
            });
            if !ok {
                out.push(format!("{p} channel {}: not a field -> channel -> scale the core recomputes", ch.repr()));
            }
            covered.extend(fields);
        }
        let shape_name = st(m.g("shape"));
        let mut want: Vec<String> = shape.expect("checked").iter().map(|s| s.to_string()).collect();
        covered.sort();
        want.sort();
        if covered != want {
            out.push(format!(
                "{p} marks: fields {} declared or free; the {shape_name} has {}, each exactly once",
                J::strs(&covered).repr(),
                J::strs(&want).repr()
            ));
        }
        if m.g("free").arr().iter().any(|f| !matches!(f.s(), Some("x1" | "y1"))) {
            out.push(format!("{p} marks: free {}: only a line's start may be free (tied to its text)", m.g("free").repr()));
        }
        for (f, rel) in e.g("texts").g("item").obj() {
            let ok = matches!(rel.g("near").s(), Some("item" | "part")) && matches!(rel.g("from").s(), Some("anchor" | "box")) && rel.g("max_px").finite();
            if !ok {
                out.push(format!("{p} text {f} relation {}: not one the core checks", rel.repr()));
            } else if !rel.g("max_px").num().is_some_and(|d| d > 0.0 && d <= MAX_PX_MAX) {
                let cap = py_float(MAX_PX_MAX);
                let cap = cap.strip_suffix(".0").unwrap_or(&cap);
                out.push(format!("{p} text {f}: max_px {} is over the core's cap {cap}; a registry may only be stricter", st(rel.g("max_px"))));
            }
        }
    }
    out
}

// ================================================================================================================
// R11: colour (ADR R9 batch 1). A node returns no colour (B0); the core alone writes one, from the palette file
// (runtime/page_tree/palettes.json), and the palette file is checked before any page uses it (palette_ok). A colour has
// one spelling, '#' and six lowercase hex digits: another spelling means another writer, so it is refused even when it
// names the same colour, and equality is string equality at every layer.
// ================================================================================================================

const PALETTES_TEXT: &str = include_str!("../runtime/page_tree/palettes.json");

/// The visual group's colour file: roles, page grounds, and per palette id one table per number of classes.
fn palettes() -> &'static J {
    static P: std::sync::OnceLock<J> = std::sync::OnceLock::new();
    P.get_or_init(|| parse(PALETTES_TEXT).expect("palettes.json parses"))
}

/// The colour roles, exactly these: one accent (the page's only saturated colour), base (an unselected mark), nodata
/// (no row or a null value; never step 0), ink and white (text in a painted mark), edge (outline of a light mark).
const ROLES: [&str; 6] = ["accent", "base", "nodata", "ink", "white", "edge"];
/// ColorBrewer ships its sequential schemes with one table for each k = 3..9; the palette file does the same.
const K_MIN: usize = 3;
const K_MAX: usize = 9;
/// WCAG 2.2 SC 1.4.3, text under 18 pt (14 pt bold), not rounded: 4.499 fails.
const TEXT_MIN: f64 = 4.5;
/// WCAG 2.2 SC 1.4.11, a graphical object against its adjacent colour.
const NONTEXT_MIN: f64 = 3.0;
/// The least adjacent-step Delta E 1976 of any ColorBrewer sequential table (BuGn k=8: 5.11), floored; and the same under
/// Machado 2009 protan / deutan at severity 1.0 (BuGn k=8: 3.47), floored. A palette may be no harder to tell apart.
const ADJ_DE_MIN: f64 = 5.1;
const ADJ_DE_CVD_MIN: f64 = 3.4;
/// LCh chroma caps from the repo's own ramps (ADR R9 3.2): data steps <= 30, neutral roles and grounds <= 6, the accent
/// >= 50. Only the accent is saturated.
const DATA_CHROMA_MAX: f64 = 30.0;
const NEUTRAL_CHROMA_MAX: f64 = 6.0;
const ACCENT_CHROMA_MIN: f64 = 50.0;
/// Machado, Oliveira, Fernandes 2009, severity 1.0, applied to linear RGB.
type Cvd = [[f64; 3]; 3];
const CVDS: [(&str, Cvd); 2] = [
    ("protan", [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]),
    ("deutan", [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]),
];

/// The one spelling the core writes: '#' and six lowercase hex digits.
fn canon_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Linear RGB of a canonical colour (sRGB transfer, WCAG's 0.04045 knee).
fn rgb_lin(h: &str) -> [f64; 3] {
    [1, 3, 5].map(|i| {
        let c = h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(0) as f64 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    })
}

/// WCAG relative luminance.
fn lum(h: &str) -> f64 {
    let [r, g, b] = rgb_lin(h);
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// WCAG contrast ratio, not rounded.
fn contrast(a: &str, b: &str) -> f64 {
    let (x, y) = (lum(a), lum(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// CIE Lab (D65, 2 degree), optionally as a colour-vision deficiency sees it.
fn lab(h: &str, cvd: Option<&Cvd>) -> [f64; 3] {
    let mut l = rgb_lin(h);
    if let Some(m) = cvd {
        l = [0, 1, 2].map(|i| (m[i][0] * l[0] + m[i][1] * l[1] + m[i][2] * l[2]).clamp(0.0, 1.0));
    }
    let [r, g, b] = l;
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    let f = |t: f64| if t > 216.0 / 24389.0 { t.powf(1.0 / 3.0) } else { (24389.0 / 27.0 * t + 16.0) / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn chroma(h: &str) -> f64 {
    let [_, a, b] = lab(h, None);
    a.hypot(b)
}

/// Delta E 1976 between two colours, optionally under a colour-vision deficiency.
fn de76(a: &str, b: &str, cvd: Option<&Cvd>) -> f64 {
    let (p, q) = (lab(a, cvd), lab(b, cvd));
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
}

/// palette_ok: every reason the colour file cannot be loaded; empty means it loads. The core runs it before any page it
/// checks; a file with any problem stops them all.
pub fn palette_problems(pf: &J) -> Vec<String> {
    let mut top: Vec<&str> = pf.obj().iter().map(|(k, _)| k.as_str()).filter(|k| *k != "$comment").collect();
    top.sort();
    if top != ["grounds", "roles", "sequential"] {
        return vec!["palette_ok: the file has exactly roles, grounds, sequential (and a $comment)".into()];
    }
    let mut out = Vec::new();
    for (k, v) in pf.obj().iter().filter(|(k, _)| k != "$comment") {
        for (path, x) in walk(v, &format!("$.{k}")) {
            if !matches!(x, J::Obj(_) | J::Arr(_)) && !x.s().is_some_and(canon_hex) && !path.ends_with(".$comment") {
                out.push(format!("palette_ok: {path} {} is not '#' and six lowercase hex digits", x.repr()));
            }
        }
    }
    if !out.is_empty() {
        return out;
    }
    let (roles, grounds, seq) = (pf.g("roles"), pf.g("grounds"), pf.g("sequential"));
    let mut names: Vec<&str> = roles.obj().iter().map(|(k, _)| k.as_str()).collect();
    names.sort();
    let mut want = ROLES.to_vec();
    want.sort();
    if names != want || !roles.obj().iter().all(|(_, v)| v.s().is_some()) || !grounds.arr().iter().all(|g| g.s().is_some()) || !seq.is_obj() {
        return vec![format!(
            "palette_ok: roles are exactly {} (one colour each), grounds a list of colours; got {}",
            J::strs(&ROLES).repr(),
            J::strs(&names).repr()
        )];
    }
    let role = |r: &str| roles.g(r).s().unwrap_or("");
    let gs: Vec<&str> = grounds.arr().iter().filter_map(J::s).collect();
    if gs.is_empty() {
        out.push("palette_ok: no page ground".into());
    }
    let (acc, edge) = (role("accent"), role("edge"));
    if chroma(acc) < ACCENT_CHROMA_MIN {
        out.push(format!("palette_ok: accent {acc} chroma {:.1} under {}", chroma(acc), py_float(ACCENT_CHROMA_MIN)));
    }
    for g in &gs {
        if contrast(acc, g) < TEXT_MIN {
            out.push(format!("palette_ok: accent {acc} on ground {g} is {:.2}:1, under {} (accent is printed as text)", contrast(acc, g), py_float(TEXT_MIN)));
        }
        if contrast(edge, g) < NONTEXT_MIN {
            out.push(format!("palette_ok: edge {edge} on ground {g} is {:.2}:1, under {}", contrast(edge, g), py_float(NONTEXT_MIN)));
        }
    }
    for r in ROLES.iter().filter(|r| **r != "accent") {
        if chroma(role(r)) > NEUTRAL_CHROMA_MAX {
            let c = chroma(role(r));
            out.push(format!("palette_ok: role {r} {} is not neutral (chroma {c:.1} > {}); only the accent is saturated", role(r), py_float(NEUTRAL_CHROMA_MAX)));
        }
    }
    for g in &gs {
        if chroma(g) > NEUTRAL_CHROMA_MAX {
            out.push(format!("palette_ok: ground {g} is not neutral"));
        }
    }
    let taken: Vec<&str> = ROLES.iter().map(|r| role(r)).chain(gs.iter().copied()).collect();
    let nd = role("nodata");
    let k_of = |k: &str| k.parse::<usize>().ok().filter(|n| n.to_string() == k);
    for (pid, by_k) in seq.obj() {
        let p = format!("palette_ok: {pid}");
        if !palette_id(pid) {
            out.push(format!("{p}: id is not lowercase letters, digits, hyphens"));
        }
        let mut ks: Vec<&str> = by_k.obj().iter().map(|(k, _)| k.as_str()).collect();
        ks.sort_by_key(|k| k_of(k).unwrap_or(usize::MAX));
        let whole: Vec<String> = (K_MIN..=K_MAX).map(|k| k.to_string()).collect();
        if !by_k.is_obj() || ks != whole {
            out.push(format!("{p}: has tables {}; needs one for every k in {K_MIN}..{K_MAX}", J::strs(&ks).repr()));
            continue;
        }
        for (k, table) in by_k.obj() {
            let q = format!("{p} k={k}");
            let cols: Vec<&str> = table.arr().iter().filter_map(J::s).collect();
            if !table.is_arr() || Some(cols.len()) != k_of(k) {
                out.push(format!("{q}: {} colours", cols.len()));
                continue;
            }
            let l: Vec<f64> = cols.iter().map(|c| lab(c, None)[0]).collect();
            if !l.windows(2).all(|w| w[0] > w[1]) {
                let shown: Vec<String> = l.iter().map(|x| py_float(py_round(*x, 1))).collect();
                out.push(format!("{q}: lightness does not fall step by step [{}]", shown.join(", ")));
            }
            for (i, w) in cols.windows(2).enumerate() {
                let d = de76(w[0], w[1], None);
                if d < ADJ_DE_MIN {
                    out.push(format!("{q}: steps {i},{} dE76 {d:.2} under {}", i + 1, py_float(ADJ_DE_MIN)));
                }
                for (name, m) in &CVDS {
                    let d = de76(w[0], w[1], Some(m));
                    if d < ADJ_DE_CVD_MIN {
                        out.push(format!("{q}: steps {i},{} under {name} dE76 {d:.2} under {}", i + 1, py_float(ADJ_DE_CVD_MIN)));
                    }
                }
            }
            for (i, c) in cols.iter().enumerate() {
                if chroma(c) > DATA_CHROMA_MAX {
                    out.push(format!("{q}: step {i} {c} chroma {:.1} over {}", chroma(c), py_float(DATA_CHROMA_MAX)));
                }
                let (ink, white) = (contrast(c, role("ink")), contrast(c, role("white")));
                if ink.max(white) < TEXT_MIN {
                    out.push(format!("{q}: step {i} {c}: ink {ink:.2}, white {white:.2}; no text colour reaches {}", py_float(TEXT_MIN)));
                }
                if taken.contains(c) {
                    out.push(format!("{q}: step {i} {c} is also a role or ground colour"));
                }
                if de76(c, nd, None) < ADJ_DE_MIN || CVDS.iter().any(|(_, m)| de76(c, nd, Some(m)) < ADJ_DE_CVD_MIN) {
                    out.push(format!("{q}: step {i} {c} too close to nodata {nd}"));
                }
            }
        }
    }
    out
}

/// A colour written as a literal: '#' and 3 to 8 hex digits ending at a word boundary, or a CSS colour function (rgb,
/// rgba, hsl, hsla, hwb, lab, lch, oklab, oklch, color) followed by '('.
fn colour_literal(s: &str) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let cs: Vec<char> = s.chars().collect();
    for (i, c) in cs.iter().enumerate() {
        if *c == '#' {
            let run = cs[i + 1..].iter().take_while(|c| c.is_ascii_hexdigit()).count();
            if (3..=8).contains(&run) && cs.get(i + 1 + run).is_none_or(|c| !word(*c)) {
                return true;
            }
        } else if *c == '(' {
            let mut name: Vec<char> = cs[..i].iter().rev().take_while(|c| word(**c)).copied().collect();
            name.reverse();
            let name: String = name.into_iter().collect::<String>().to_lowercase();
            if ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"].contains(&name.as_str()) {
                return true;
            }
        }
    }
    false
}

/// The page tree names no colour: no string outside its facts is a literal colour, and a frame's shared palette is a
/// palette id of the palette file.
fn tree_colour_problems(spec: &J, pf: &J) -> Vec<String> {
    fn frames(n: &J, path: &str, pf: &J, out: &mut Vec<String>) {
        if let Some(pal) = n.g("shared").get("palette") {
            if !pal.s().is_some_and(|p| pf.g("sequential").has(p)) {
                out.push(format!("tree: {path}.shared.palette {} is not a palette id of the palette file", pal.repr()));
            }
        }
        for (i, c) in n.g("children").arr().iter().enumerate() {
            frames(c, &format!("{path}.children[{i}]"), pf, out);
        }
    }
    let mut out = Vec::new();
    for (k, v) in spec.obj().iter().filter(|(k, _)| k != "facts") {
        for (path, x) in walk(v, &format!("$.{k}")) {
            if x.s().is_some_and(colour_literal) {
                out.push(format!("tree: {path} {} is a literal colour; a page names a palette id, never a colour", x.repr()));
            }
        }
    }
    frames(spec.g("body"), "$.body", pf, &mut out);
    out
}

// ================================================================================================================
// The core's content: items expanded from the binding (C2), the words it prints and their boxes, the map projection,
// the value-determined geometry, the requests it issues.
// ================================================================================================================

fn resolve_sel(r: &J, got: &Got) -> Result<J, String> {
    if let Some(s) = r.s().filter(|s| ref_parts(s).is_some()) {
        return resolve_ref(s, got);
    }
    if r.is_obj() && r.has("select") {
        let k = st(r.g("select"));
        return got.get(&k).cloned().ok_or_else(|| format!("'{k}'"));
    }
    Err(format!("{} is no select reference", r.repr()))
}

fn at_path<'a>(obj: &'a J, dotted: &str) -> Result<&'a J, String> {
    let mut o = obj;
    for p in dotted.split('.') {
        o = o.get(p).ok_or_else(|| format!("'{p}'"))?;
    }
    Ok(o)
}

/// A template's `{name}` holes filled from the context, or from the node by a dotted path.
fn fill_template(template: &str, ctx: &[(&str, &str)], n: &J) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let end = after.find(|c: char| !(c.is_ascii_lowercase() || c == '_' || c == '.')).unwrap_or(after.len());
        if end > 0 && after[end..].starts_with('}') {
            let k = &after[..end];
            match ctx.iter().find(|(name, _)| *name == k) {
                Some((_, v)) => out.push_str(v),
                None => out.push_str(&st(at_path(n, k)?)),
            }
            rest = &after[end + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// The node's items as the core expands them from its registry binding (generic: no node name is read here).
pub fn expand_items(n: &J, entry: &J, spec: &J, got: &Got, inp: &J) -> Result<Vec<J>, String> {
    let it = entry.g("items");
    let rows = inp.g("rows").arr();
    let sel: Vec<(String, &J)> = spec.g("selects").g("items").arr().iter().map(|s| (st(s.g("id")), s)).collect();
    let fe = it.g("for_each").s().unwrap_or("");
    let (mut items, codes, sid): (Vec<J>, Vec<J>, Option<String>) = if fe == "spec" {
        let items = n.g("items").arr().to_vec();
        let codes = items.iter().map(|x| resolve_sel(x.g("code"), got)).collect::<Result<Vec<_>, _>>()?;
        (items, codes, None)
    } else {
        let r = if fe == "items_for" {
            n.g("items_for")
        } else {
            n.g("binds").get(fe.split_once('.').map_or("", |x| x.1)).ok_or_else(|| format!("'{fe}'"))?
        };
        let sid = ref_id(r).ok_or_else(|| format!("{} is no select reference", r.repr()))?;
        let codes = got.get(&sid).ok_or_else(|| format!("'{sid}'"))?.arr().to_vec();
        (codes.iter().map(|_| J::Obj(vec![])).collect(), codes, Some(sid))
    };
    let over = match &sid {
        Some(s) => Some(root_rank(&sel, s)?.g("over").clone()),
        None => None,
    };
    for (i, (item, code)) in items.iter_mut().zip(&codes).enumerate() {
        let mut cells: Option<J> = None;
        let cs = st(code);
        for (f, d) in it.g("fields").obj() {
            let v = match d.g("kind").s().unwrap_or("") {
                "select_index" => J::Str(format!("select:{}[{i}]", sid.as_deref().unwrap_or("None"))),
                "row_of_code" => {
                    let over = over.as_ref().ok_or("'over'")?;
                    let by = st(over.g("by"));
                    let hit: Vec<&J> = rows
                        .iter()
                        .filter(|r| r.g("table") == over.g("table") && r.g("time") == over.g("time") && dims(r, &by) == code)
                        .filter(|r| over.g("filter").obj().iter().all(|(a, b)| dims(r, a) == b))
                        .collect();
                    if hit.len() != 1 {
                        return Err(format!("{} item {i} ({cs}): {} rows, the expansion needs exactly one", st(n.g("id")), hit.len()));
                    }
                    hit[0].g("src").clone()
                }
                "fact_template" => J::Str(format!("fact:{}", fill_template(&st(d.g("template")), &[("code", &cs)], n)?)),
                "code_is" => J::Bool(*code == resolve_sel(at_path(n, &st(d.g("ref")))?, got)?),
                "point_of_code" => inp.g("points").g("at").get(&cs).cloned().ok_or_else(|| format!("'{cs}'"))?,
                "cells_by_part" => {
                    let sid = sid.as_deref().ok_or("'None'")?;
                    let c = cells_of(code, sel_get(&sel, sid).ok_or_else(|| format!("'{sid}'"))?, &sel, got, rows)?;
                    cells = Some(c.clone());
                    c
                }
                "fact_per_part" => J::Obj(
                    cells
                        .as_ref()
                        .map(|c| c.obj().to_vec())
                        .unwrap_or_default()
                        .iter()
                        .map(|(p, _)| Ok((p.clone(), J::Str(format!("fact:{}", fill_template(&st(d.g("template")), &[("code", &cs), ("part", p)], n)?)))))
                        .collect::<Result<_, String>>()?,
                ),
                k => return Err(format!("field kind {k} is not one the core expands")),
            };
            item.set(f, v);
        }
    }
    Ok(items)
}

/// part -> the input rows of a code at the part's codes (the drop_replace's own sum check), less the excluded, none for a
/// part declared zero, in input order.
fn cells_of(code: &J, dr: &J, sel: &[(String, &J)], got: &Got, rows: &[J]) -> Result<J, String> {
    let c = resolved(dr.g("check").g("sum_within"), got)?;
    let (place, dim) = (st(c.g("place")), st(c.g("dim")));
    let mut out = Vec::new();
    for (part, codes) in c.g("parts").obj() {
        let mut excl: Vec<J> = Vec::new();
        for (_, s) in sel {
            if s.g("kind").s() == Some("exclude_codes") && s.g("part").s() == Some(part) && resolve_sel(s.g("place"), got)? == *code {
                excl.extend(s.g("codes").arr().iter().cloned());
            }
        }
        let zero = sel.iter().filter(|(_, s)| s.g("kind").s() == Some("zero_parts")).any(|(_, s)| {
            s.g("declared").arr().iter().any(|d| d.g("bar") == code && d.g("part").s() == Some(part))
        });
        let srcs: Vec<J> = rows
            .iter()
            .filter(|r| r.g("table") == c.g("table") && r.g("time") == c.g("time") && dims(r, &place) == code)
            .filter(|r| codes.arr().contains(dims(r, &dim)) && !excl.contains(dims(r, &dim)))
            .map(|r| r.g("src").clone())
            .collect();
        if !srcs.is_empty() && !zero {
            out.push((part.clone(), J::Arr(srcs)));
        }
    }
    Ok(J::Obj(out))
}

/// The first layer's width rule (runtime/nodes/common.mjs tw): a CJK character 1 em, any other 0.58 em.
fn tw(text: &str, size: f64) -> f64 {
    let cjk = |c: char| matches!(c as u32, 0x2E80..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF);
    text.chars().fold(0.0, |s, c| s + if cjk(c) { 1.0 } else { 0.58 }) * size
}

/// Python's round(x, n).
fn py_round(x: f64, n: usize) -> f64 {
    format!("{x:.n$}").parse().unwrap_or(x)
}

/// The core's printed strings: facts formatted by their format record, names from the name table, word-table words.
struct Words<'a> {
    fmts: &'a J,
    rfacts: &'a J,
    inp: &'a J,
    got: &'a Got,
    val: Compute<'a>,
}

impl<'a> Words<'a> {
    fn new(spec: &'a J, rpage: &'a J, inp: &'a J, got: &'a Got) -> Self {
        let rfacts = rpage.g("facts").g("facts");
        Words { fmts: spec.g("facts").g("fmts"), rfacts, inp, got, val: Compute::new(rfacts, inp.g("rows").arr()) }
    }
    fn fact(&self, key: &str, part: Option<&str>) -> Result<String, String> {
        let base = match key.rsplit_once('.') {
            Some((head, "n" | "t")) => head,
            _ => key,
        };
        let q = [self.rfacts.get(base), self.rfacts.get(base.rsplit_once('.').map_or("", |x| x.0))]
            .into_iter()
            .flatten()
            .find(|q| q.truthy())
            .unwrap_or(&NULL);
        if part == Some("t") {
            let t = if q.g("to").truthy() { q.g("to") } else { q.g("time") };
            return Ok(if t.is_null() { "None".into() } else { st(t) });
        }
        let v = self.val.val(base)?;
        let f = q.g("fmt");
        if let Some(m) = f.s().and_then(|f| self.fmts.get(f)).filter(|m| m.has("dec")) {
            let scale = m.get("scale").map_or(Some(1.0), J::num).ok_or("scale")?;
            let dec = m.g("dec").num().ok_or("dec")? as usize;
            return Ok(format!("{}{}", py_fixed(v * scale, dec), m.get("suffix").map_or(String::new(), st)));
        }
        if f.s() == Some("n") {
            return Ok(format!("{}", v.round_ties_even() as i64));
        }
        Ok(format!("{}%", py_fixed(v * 100.0, 1)))
    }
    fn name(&self, code: &str) -> Result<String, String> {
        let t = self.inp.g("name_table");
        if let Some(n) = t.g("labels").get(code).filter(|n| n.truthy()) {
            return Ok(st(n));
        }
        t.g("named").obj().iter().find(|(s, _)| s.ends_with(&format!(":{code}"))).map(|(_, x)| st(x)).ok_or_else(|| format!("no name for {code}"))
    }
    fn run(&self, r: &J) -> Result<String, String> {
        if r.has("w") {
            return Ok(st(r.g("w")));
        }
        if r.has("word") {
            let k = st(r.g("word"));
            return self.inp.g("word_table").get(&k).map(st).ok_or_else(|| format!("'{k}'"));
        }
        if r.has("fact") {
            return self.fact(&st(r.g("fact")), r.g("part").s());
        }
        if let Some(s) = r.get("src") {
            let s = st(s);
            if let Some(k) = s.strip_prefix("fact:") {
                return self.fact(k, None);
            }
            let t = self.inp.g("name_table");
            if let Some(x) = t.g("named").get(&s).filter(|x| x.truthy()) {
                return Ok(st(x));
            }
            let code = s.rsplit_once(':').map_or(s.as_str(), |x| x.1);
            return t.g("labels").get(code).map(st).ok_or_else(|| format!("'{code}'"));
        }
        if let Some(x) = r.get("name") {
            let x = st(x);
            let code = if ref_parts(&x).is_some() { st(&resolve_sel(&J::Str(x.clone()), self.got)?) } else { x };
            return self.name(&code);
        }
        if r.has("table") {
            return Ok(st(r.g("table")));
        }
        Err(format!("run {} prints nothing the core knows", r.repr()))
    }
    fn runs(&self, rs: &J) -> Result<String, String> {
        rs.arr().iter().map(|r| self.run(r)).collect()
    }
}

/// Chars and held flags for worded_number: literal runs and word-table words are words; every other run one placeholder.
fn literal_chars(rs: &J, inp: &J) -> (Vec<char>, Vec<bool>) {
    let (mut chars, mut held) = (Vec::new(), Vec::new());
    for r in rs.arr() {
        let t = if r.has("w") {
            Some(st(r.g("w")))
        } else if r.has("word") {
            Some(inp.g("word_table").get(&st(r.g("word"))).map_or(String::new(), st))
        } else {
            None
        };
        match t {
            None => {
                chars.push(' ');
                held.push(true);
            }
            Some(t) => {
                chars.extend(t.chars());
                held.extend(t.chars().map(|_| false));
            }
        }
    }
    (chars, held)
}

fn merc(lon: f64, lat: f64) -> (f64, f64) {
    (lon.to_radians(), (std::f64::consts::PI / 4.0 + lat.to_radians() / 2.0).tan().ln())
}

/// d3 geoMercator().fitExtent(plot box, ext box): (scale, tx, ty); px = tx + s*x, py = ty - s*y.
fn fit(ext: [f64; 4], plot: [f64; 4]) -> (f64, f64, f64) {
    let [x0, y0, x1, y1] = plot;
    let pts = [(ext[0], ext[1]), (ext[2], ext[1]), (ext[2], ext[3]), (ext[0], ext[3])].map(|(a, b)| merc(a, b));
    let xs = pts.map(|p| p.0);
    let ys = pts.map(|p| -p.1);
    let min = |v: [f64; 4]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |v: [f64; 4]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let (bx0, bx1, by0, by1) = (min(xs), max(xs), min(ys), max(ys));
    let (w, h) = (x1 - x0, y1 - y0);
    let k = (w / (bx1 - bx0)).min(h / (by1 - by0));
    (k, x0 + (w - k * (bx1 + bx0)) / 2.0, y0 + (h - k * (by1 + by0)) / 2.0)
}

fn project(pt: (f64, f64), proj: (f64, f64, f64)) -> [f64; 2] {
    let (k, tx, ty) = proj;
    let (x, y) = merc(pt.0, pt.1);
    [tx + k * x, ty - k * y]
}

fn four(v: &J) -> Result<[f64; 4], String> {
    let a = v.arr();
    if a.len() != 4 {
        return Err(format!("{} is no box of four numbers", v.repr()));
    }
    let n = |i: usize| a[i].num().ok_or_else(|| format!("{} is no number", a[i].repr()));
    Ok([n(0)?, n(1)?, n(2)?, n(3)?])
}

/// {mark id: [(field, value)]} for every value-determined field, from the core's own request: the declared channel and
/// scale, the plot box the core chose, the values the core computed. Nothing here is read from a node.
/// Each mark's value-determined fields and the values the core recomputes for them, by mark id.
pub type Expected = Vec<(String, Vec<(String, f64)>)>;
pub fn expected(req: &J) -> Result<Expected, String> {
    let [x0, y0, x1, y1] = four(req.g("plot"))?;
    let ms = req.g("marks").arr();
    let mut order: Vec<&J> = Vec::new();
    for m in ms {
        if !order.contains(&m.g("item")) {
            order.push(m.g("item"));
        }
    }
    let mut out: Vec<(String, Vec<(String, f64)>)> = ms.iter().map(|m| (st(m.g("id")), Vec::new())).collect();
    let put = |out: &mut Vec<(String, Vec<(String, f64)>)>, i: usize, f: &str, v: f64| {
        let fs = &mut out[i].1;
        match fs.iter_mut().find(|(k, _)| k == f) {
            Some(slot) => slot.1 = v,
            None => fs.push((f.to_string(), v)),
        }
    };
    let value = |m: &J, k: &str| m.g(k).num().ok_or_else(|| format!("mark {} has no {k}", st(m.g("id"))));
    for ch in req.g("encode").arr() {
        let (c, sc) = (ch.g("channel").s().unwrap_or(""), ch.g("scale"));
        let f: Vec<String> = ch.g("fields").arr().iter().map(st).collect();
        match c {
            "length_up" | "radius_area" => {
                let mut vmax = f64::NEG_INFINITY;
                for m in ms {
                    vmax = vmax.max(value(m, "value")?);
                }
                for (i, m) in ms.iter().enumerate() {
                    let v = value(m, "value")?;
                    if c == "length_up" {
                        let h = if vmax > 0.0 { (v / vmax) * (y1 - y0) } else { 0.0 };
                        put(&mut out, i, "h", h);
                        put(&mut out, i, "y", y1 - h);
                    } else {
                        let r = if vmax > 0.0 { sc.g("range").g("max_px").num().ok_or("max_px")? * (v / vmax).sqrt() } else { 0.0 };
                        put(&mut out, i, "r", r);
                    }
                }
            }
            "band_x" | "band_y" => {
                let (a0, a1) = if c == "band_x" { (x0, x1) } else { (y0, y1) };
                let step = (a1 - a0) / order.len() as f64;
                let pad = sc.g("padding").num().ok_or("padding")?;
                for (i, m) in ms.iter().enumerate() {
                    let j = order.iter().position(|o| *o == m.g("item")).expect("in order") as f64;
                    put(&mut out, i, &f[0], a0 + j * step + step * pad / 2.0);
                    put(&mut out, i, &f[1], step * (1.0 - pad));
                }
            }
            "point" => {
                for (i, m) in ms.iter().enumerate() {
                    let pin = m.g("pin");
                    put(&mut out, i, &f[0], pin.at(0).num().ok_or("pin")?);
                    put(&mut out, i, &f[1], pin.at(1).num().ok_or("pin")?);
                }
            }
            "stack_x" => {
                let mut cum: Vec<(J, f64)> = Vec::new();
                for (i, m) in ms.iter().enumerate() {
                    let start = cum.iter().find(|(k, _)| *k == *m.g("item")).map_or(0.0, |x| x.1);
                    let share = value(m, "share")?;
                    put(&mut out, i, "x", x0 + start * (x1 - x0));
                    put(&mut out, i, "w", share * (x1 - x0));
                    match cum.iter_mut().find(|(k, _)| *k == *m.g("item")) {
                        Some(slot) => slot.1 = start + share,
                        None => cum.push((m.g("item").clone(), start + share)),
                    }
                }
            }
            _ => return Err(format!("channel {c} is not one the core recomputes")),
        }
    }
    Ok(out)
}

/// What the core keeps of each id it issued: a mark's item, part and emphasis; a text's printed words and their source.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub marks: Vec<(String, usize, Option<String>, bool)>,
    pub texts: Vec<(String, String, J)>,
    pub tol_px: f64,
}

impl Meta {
    fn item_of(&self, id: &str) -> Option<usize> {
        self.marks.iter().find(|m| m.0 == id).map(|m| m.1)
    }
}

/// The one request per external node, and the core's own record of what each id stands for.
/// The requests the core issues, by node id, and what it keeps beside each to check the reply.
type Issued = (Vec<(String, J)>, BTreeMap<String, Meta>);
fn issue(spec: &J, inp: &J, reg: &J, ext: &[String], got: &Got, rpage: &J) -> Result<Issued, String> {
    let words = Words::new(spec, rpage, inp, got);
    let rows: BTreeMap<String, &J> = inp.g("rows").arr().iter().map(|r| (st(r.g("src")), r)).collect();
    let row = |src: &J| rows.get(&st(src)).copied().ok_or_else(|| format!("'{}'", st(src)));
    let (mut reqs, mut metas) = (Vec::new(), BTreeMap::new());
    for (_, n) in walk(spec.g("body"), "$") {
        let nid = st(n.g("id"));
        if n.g("kind").s() != Some("Node") || !ext.contains(&nid) {
            continue;
        }
        let e = reg.g("nodes").g(&st(n.g("node")));
        let fr = reg.g("frames").g(&st(e.g("frame")));
        let enc = e.g("marks").g("encode");
        let ofs: Vec<&str> = enc.arr().iter().filter_map(|c| c.g("of").s()).collect();
        let proj = if ofs.contains(&"at") { Some(fit(four(n.g("geometry").g("ext"))?, four(fr.g("plot"))?)) } else { None };
        let (mut marks, mut texts, mut meta) = (Vec::new(), Vec::new(), Meta::default());
        let shape = e.g("marks").g("shape").clone();
        let per_item = e.g("marks").g("per").s() == Some("item");
        let tsize = e.g("texts").g("size").num().ok_or("texts.size")?;
        for (i, it) in n.g("items").arr().iter().enumerate() {
            let focus = it.g("focus").truthy();
            if per_item {
                let id = format!("{nid}/{i}");
                let mut m = J::obj_of(vec![("id", J::str(&id)), ("shape", shape.clone()), ("item", J::Int(i as i64))]);
                if ofs.contains(&"value") {
                    m.set("value", J::Num(num(row(it.g("value"))?)?));
                }
                if let Some(proj) = proj {
                    let p = project((it.g("at").at(0).num().ok_or("at")?, it.g("at").at(1).num().ok_or("at")?), proj);
                    m.set("pin", J::Arr(p.iter().map(|v| J::Num(py_round(*v, 3))).collect()));
                }
                marks.push(m);
                meta.marks.push((id, i, None, focus));
            } else {
                let total = num(row(it.g("total"))?)?;
                for (part, srcs) in it.g("cells").obj() {
                    let id = format!("{nid}/{i}/{part}");
                    let mut sum = 0.0;
                    for s in srcs.arr() {
                        sum += num(row(s)?)?;
                    }
                    marks.push(J::obj_of(vec![("id", J::str(&id)), ("shape", shape.clone()), ("item", J::Int(i as i64)), ("share", J::Num(sum / total))]));
                    meta.marks.push((id, i, Some(part.clone()), focus));
                }
            }
            let own: Vec<String> = meta.marks.iter().filter(|m| m.1 == i).map(|m| m.0.clone()).collect();
            for (f, rel) in e.g("texts").g("item").obj() {
                let found: Vec<(String, String, J, Vec<String>)> = match f.as_str() {
                    "label" => vec![(format!("{nid}/{i}/label"), words.name(&st(&resolve_sel(it.g("code"), got)?))?, it.g("code").clone(), own.clone())],
                    "share_text" => it
                        .g(f)
                        .obj()
                        .iter()
                        .map(|(p, r)| Ok((format!("{nid}/{i}/share_text/{p}"), words.fact(st(r).get(5..).unwrap_or(""), None)?, r.clone(), vec![format!("{nid}/{i}/{p}")])))
                        .collect::<Result<_, String>>()?,
                    "text" if it.has(f) => vec![(format!("{nid}/{i}/text"), words.runs(it.g(f))?, it.g(f).clone(), own.clone())],
                    _ if it.has(f) => vec![(format!("{nid}/{i}/{f}"), words.fact(st(it.g(f)).get(5..).unwrap_or(""), None)?, it.g(f).clone(), own.clone())],
                    _ => vec![],
                };
                for (tid, s, src, near) in found {
                    texts.push(J::obj_of(vec![
                        ("id", J::str(&tid)),
                        ("w", J::Num(py_round(tw(&s, tsize), 3))),
                        ("h", J::Num(py_round(tsize * 1.15, 3))),
                        ("size", e.g("texts").g("size").clone()),
                        ("near", J::obj_of(vec![("marks", J::strs(&near)), ("from", rel.g("from").clone()), ("max_px", rel.g("max_px").clone())])),
                    ]));
                    meta.texts.push((tid, s, src));
                }
            }
        }
        if e.g("texts").g("node").truthy() {
            let size = if e.g("texts").has("head_size") { e.g("texts").g("head_size") } else { e.g("texts").g("size") };
            let sz = size.num().ok_or("head_size")?;
            let parts = n.g("texts").obj().iter().map(|(k, t)| (format!("{nid}/texts/{k}"), t)).chain(n.g("lines").arr().iter().enumerate().map(|(j, t)| (format!("{nid}/lines/{j}"), t)));
            for (tid, t) in parts {
                let s = words.runs(t.g("runs"))?;
                texts.push(J::obj_of(vec![("id", J::str(&tid)), ("w", J::Num(py_round(tw(&s, sz), 3))), ("h", J::Num(py_round(sz * 1.15, 3))), ("size", size.clone())]));
                meta.texts.push((tid, s, t.g("runs").clone()));
            }
        }
        meta.tol_px = e.g("marks").g("tol_px").num().ok_or("tol_px")?;
        reqs.push((
            nid.clone(),
            J::obj_of(vec![
                ("node", n.g("node").clone()),
                ("frame", J::obj_of(vec![("w", fr.g("w").clone()), ("h", fr.g("h").clone())])),
                ("plot", fr.g("plot").clone()),
                ("encode", enc.clone()),
                ("marks", J::Arr(marks)),
                ("texts", J::Arr(texts)),
            ]),
        ));
        metas.insert(nid, meta);
    }
    Ok((reqs, metas))
}

/// What the core holds once its own spec has passed C1-C5: the recomputed selects and the resolved page.
pub struct Content {
    pub got: Got,
    pub rpage: J,
}

/// C1-C5 on the core's own spec: (failure lines, the content when it passed).
pub fn content_problems(spec: &J, inp: &J, ext: &[String], reg: &J) -> (Vec<String>, Option<Content>) {
    let pal = palette_problems(palettes());
    if !pal.is_empty() {
        return (pal, None);
    }
    let mut errs = registry_problems(reg);
    let (a_errs, got, rpage) = part_a(spec, inp, reg);
    errs.extend(a_errs.into_iter().map(|x| format!("C1 {x}")));
    let Some(rpage) = rpage else { return (errs, None) };
    errs.extend(part_b(inp, spec, ext, &got, Some(&rpage)).into_iter().map(|x| format!("C4 {x}")));
    for (_, n) in walk(spec.g("body"), "$") {
        let nid = st(n.g("id"));
        if n.g("kind").s() != Some("Node") || !ext.contains(&nid) {
            continue;
        }
        let entry = reg.g("nodes").get(&st(n.g("node")));
        match entry.ok_or_else(|| format!("'{}'", st(n.g("node")))).and_then(|e| expand_items(n, e, spec, &got, inp)) {
            Err(ex) => errs.push(format!("C2 node {nid}: the core cannot expand its items ({ex})")),
            Ok(want) => {
                if J::Arr(want.clone()) != *n.get("items").unwrap_or(&J::Arr(vec![])) {
                    errs.push(format!("C2 node {nid}: items are not the expansion of its registry binding: {} != {}", n.g("items").repr(), J::Arr(want).repr()));
                }
            }
        }
    }
    for (path, v) in walk(spec, "$") {
        let rs = if v.g("kind").s() == Some("Text") {
            v.g("runs")
        } else if v.is_arr() && path.ends_with(".text") && v.at(0).is_obj() {
            v
        } else {
            continue;
        };
        let (chars, held) = literal_chars(rs, inp);
        let hit = worded_number(&chars, &held);
        let literal: String = chars.iter().zip(&held).filter(|(_, h)| !**h).map(|(c, _)| *c).collect();
        if hit.is_some() || has_digit(&literal) {
            errs.push(format!("C3 {path}: the core's words type a number ({}); a number is a fact run", J::str(hit.as_deref().unwrap_or("a digit")).repr()));
        }
    }
    let ok = errs.is_empty();
    (errs, ok.then_some(Content { got, rpage }))
}

// ================================================================================================================
// B: the node's reply. B0 the allow-list before anything is read; B1-B7 the geometry.
// ================================================================================================================

/// B0 over every node's reply: one line per place the reply leaves the allow-list, naming its path.
pub fn reply_problems(replies: &J, reqs: &[(String, J)]) -> Vec<String> {
    let J::Obj(rs) = replies else { return vec!["B0 reply: not an object keyed by node id".into()] };
    let mut out = Vec::new();
    for (nid, _) in reqs {
        if !replies.has(nid) {
            out.push(format!("B0 reply.{nid}: the node sent no reply"));
        }
    }
    for (nid, r) in rs {
        match reqs.iter().find(|(k, _)| k == nid) {
            None => out.push(format!("B0 reply.{nid}: no request was sent to a node {}", J::str(nid).repr())),
            Some((_, req)) => out.extend(node_problems(nid, r, req)),
        }
    }
    out
}

fn node_problems(nid: &str, r: &J, req: &J) -> Vec<String> {
    let p = format!("B0 reply.{nid}");
    let J::Obj(top) = r else { return vec![format!("{p}: not an object")] };
    if r.has("refused") {
        let ok = top.len() == 1 && r.g("refused").s().is_some_and(|x| REFUSALS.contains(&x));
        return if ok { vec![] } else { vec![format!("{p}.refused: a refusal is {{\"refused\": one of {}}} alone", J::strs(&REFUSALS).repr())] };
    }
    let mut out: Vec<String> = top.iter().filter(|(k, _)| !TOP.contains(&k.as_str())).map(|(k, _)| format!("{p}.{k}: not a reply field (only marks, texts)")).collect();
    let marks: Vec<(&str, &J)> = req.g("marks").arr().iter().map(|m| (m.g("id").s().unwrap_or(""), m)).collect();
    let texts: Vec<&str> = req.g("texts").arr().iter().filter_map(|t| t.g("id").s()).collect();
    for sec in TOP {
        let Some(v) = r.get(sec) else { continue };
        let J::Obj(entries) = v else {
            out.push(format!("{p}.{sec}: not an object keyed by issued id"));
            continue;
        };
        for (i, o) in entries {
            let q = format!("{p}.{sec}.{i}");
            let issued = if sec == "marks" { marks.iter().any(|(k, _)| k == i) } else { texts.contains(&i.as_str()) };
            if !issued {
                out.push(format!("{q}: not an id the core issued to this node"));
                continue;
            }
            if !o.is_obj() {
                out.push(format!("{q}: not an object"));
                continue;
            }
            let (need, with_shape): (Vec<&str>, bool) = if sec == "marks" {
                let shape = o.g("shape");
                let Some(fields) = shape.s().and_then(shape_fields) else {
                    let mut names: Vec<&str> = SHAPES.iter().map(|s| s.0).collect();
                    names.sort();
                    out.push(format!("{q}.shape: {} is not one of {}", shape.repr(), J::strs(&names).repr()));
                    continue;
                };
                let registered = marks.iter().find(|(k, _)| k == i).map(|(_, m)| m.g("shape")).unwrap_or(&NULL);
                if shape != registered {
                    out.push(format!("{q}.shape: {}, the registry gives this mark {}", shape.repr(), registered.repr()));
                    continue;
                }
                (fields.to_vec(), true)
            } else {
                (TEXT_FIELDS.to_vec(), false)
            };
            for (f, x) in o.obj() {
                let known = need.contains(&f.as_str()) || (with_shape && f == "shape");
                if !known {
                    let only = if with_shape { std::iter::once("shape").chain(need.iter().copied()).collect::<Vec<_>>().join(", ") } else { need.join(", ") };
                    out.push(format!("{q}.{f}: not a field of this {} (only {only})", if with_shape { "mark" } else { "text" }));
                } else if f == "shape" {
                    continue;
                } else if f == "anchor" {
                    if !x.s().is_some_and(|a| ANCHORS.contains(&a)) {
                        out.push(format!("{q}.anchor: {} is not one of {}", x.repr(), J::strs(&ANCHORS).repr()));
                    }
                } else if !x.finite() {
                    out.push(format!("{q}.{f}: {} is not a finite number", x.repr()));
                }
            }
            let mut missing: Vec<&str> = need.iter().copied().filter(|f| !o.has(f)).collect();
            if with_shape && !o.has("shape") {
                missing.insert(0, "shape");
            }
            if !missing.is_empty() {
                out.push(format!("{q}: lacks {}", J::strs(&missing).repr()));
            }
        }
    }
    out
}

type Bx = (f64, f64, f64, f64);

fn coord(o: &J, f: &str) -> f64 {
    o.g(f).num().unwrap_or(f64::NAN)
}

fn mbox(m: &J) -> Bx {
    match m.g("shape").s() {
        Some("rect") => (coord(m, "x"), coord(m, "y"), coord(m, "x") + coord(m, "w"), coord(m, "y") + coord(m, "h")),
        Some("circle") => {
            let (cx, cy, r) = (coord(m, "cx"), coord(m, "cy"), coord(m, "r"));
            (cx - r, cy - r, cx + r, cy + r)
        }
        _ => {
            let (x1, y1, x2, y2) = (coord(m, "x1"), coord(m, "y1"), coord(m, "x2"), coord(m, "y2"));
            (x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2))
        }
    }
}

/// Where a text ties to its mark: the mark's box, or a line's start (its end sits on the point).
fn region(m: &J) -> Bx {
    if m.g("shape").s() == Some("line") {
        let (x, y) = (coord(m, "x1"), coord(m, "y1"));
        (x, y, x, y)
    } else {
        mbox(m)
    }
}

fn tbox(t: &J, req_t: &J) -> Bx {
    let (w, s) = (coord(req_t, "w"), coord(req_t, "size"));
    let x = coord(t, "x");
    let x0 = match t.g("anchor").s() {
        Some("middle") => x - w / 2.0,
        Some("end") => x - w,
        _ => x,
    };
    (x0, coord(t, "y") - 0.9 * s, x0 + w, coord(t, "y") + 0.25 * s)
}

fn pmax(a: f64, b: f64) -> f64 {
    // Python's max(a, b) keeps a when b is not greater (NaN included)
    if b > a { b } else { a }
}

fn dist(a: Bx, b: Bx) -> f64 {
    pmax(pmax(b.0 - a.2, 0.0), a.0 - b.2).hypot(pmax(pmax(b.1 - a.3, 0.0), a.1 - b.3))
}

fn union(boxes: &[Bx]) -> Bx {
    boxes.iter().skip(1).fold(boxes[0], |u, b| (u.0.min(b.0), u.1.min(b.1), u.2.max(b.2), u.3.max(b.3)))
}

fn inside(b: Bx, w: f64, h: f64) -> bool {
    let eps = 1e-9;
    b.0 >= -eps && b.1 >= -eps && b.2 <= w + eps && b.3 <= h + eps
}

fn fmt2(b: Bx) -> String {
    format!("({}, {}, {}, {})", py_float(py_round(b.0, 2)), py_float(py_round(b.1, 2)), py_float(py_round(b.2, 2)), py_float(py_round(b.3, 2)))
}

/// B1-B7 for one node's reply that passed B0.
pub fn geometry_problems(nid: &str, req: &J, reply: &J, meta: &Meta) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if reply.has("refused") {
        return Ok(vec![format!("B7 node {nid} refused ({}): the page stops; nothing is dropped or repaired", st(reply.g("refused")))]);
    }
    let (w, h) = (req.g("frame").g("w").num().ok_or("frame")?, req.g("frame").g("h").num().ok_or("frame")?);
    let (marks, texts) = (reply.g("marks"), reply.g("texts"));
    let miss: Vec<String> = req
        .g("marks")
        .arr()
        .iter()
        .chain(req.g("texts").arr())
        .map(|x| st(x.g("id")))
        .enumerate()
        .filter(|(k, id)| if *k < req.g("marks").arr().len() { !marks.has(id) } else { !texts.has(id) })
        .map(|(_, id)| id)
        .collect();
    if !miss.is_empty() {
        return Ok(vec![format!("B1 node {nid}: no geometry for issued {}; every issued mark and text has exactly one", J::strs(&miss).repr())]);
    }
    let rm: Vec<(String, &J)> = req.g("marks").arr().iter().map(|m| (st(m.g("id")), marks.g(&st(m.g("id"))))).collect();
    let rt: Vec<(String, &J, &J)> = req.g("texts").arr().iter().map(|t| (st(t.g("id")), t, texts.g(&st(t.g("id"))))).collect();
    let boxes: Vec<(String, Bx, bool)> = rm.iter().map(|(i, m)| (i.clone(), mbox(m), matches!(m.g("shape").s(), Some("rect" | "circle")))).collect();
    let tb: Vec<(String, Bx)> = rt.iter().map(|(i, t, r)| (i.clone(), tbox(r, t))).collect();
    // B2
    for (i, b, solid) in boxes.iter().map(|(i, b, s)| (i, *b, *s)).chain(tb.iter().map(|(i, b)| (i, *b, false))) {
        if !inside(b, w, h) || (solid && (b.2 < b.0 || b.3 < b.1)) {
            out.push(format!("B2 node {nid} {i}: box {} is not inside the frame {}x{}", fmt2(b), st(req.g("frame").g("w")), st(req.g("frame").g("h"))));
        }
    }
    // B3 / B4: every value-determined field equals the core's recomputation; free fields only B2, B5
    let want = expected(req)?;
    let point: Vec<String> =
        req.g("encode").arr().iter().filter(|c| c.g("channel").s() == Some("point")).flat_map(|c| c.g("fields").arr().iter().map(st)).collect();
    for (i, m) in &rm {
        let fields = want.iter().find(|(k, _)| k == i).map(|(_, f)| f.as_slice()).unwrap_or(&[]);
        for (f, v) in fields {
            let tag = if point.contains(f) { "B4" } else { "B3" };
            let have = coord(m, f);
            if (have - v).abs() > meta.tol_px {
                let ch = req.g("encode").arr().iter().find(|c| c.g("fields").arr().iter().any(|x| x.s() == Some(f))).unwrap_or(&NULL);
                let sc = ch.g("scale");
                out.push(format!(
                    "{tag} node {nid} {i}.{f}: {have:.3} drawn, the declared {} ({} scale, domain {}, range {}) gives {v:.3}",
                    st(ch.g("channel")),
                    st(sc.g("kind")),
                    st(sc.g("domain")),
                    st(sc.g("range"))
                ));
            }
        }
    }
    // B5: each text near its own mark, nearer to it than to any other mark of the node
    for (i, t, r) in &rt {
        let nr = t.g("near");
        if !nr.truthy() {
            continue;
        }
        let tb_i = tb.iter().find(|(k, _)| k == i).expect("every text boxed").1;
        let frm = if nr.g("from").s() == Some("box") { tb_i } else { (coord(r, "x"), coord(r, "y"), coord(r, "x"), coord(r, "y")) };
        let mut own: Vec<String> = nr.g("marks").arr().iter().map(st).collect();
        own.sort();
        let mut groups: Vec<(String, Vec<Bx>)> = Vec::new();
        for (m, mj) in &rm {
            let key = if own.contains(m) {
                "own".to_string()
            } else if own.len() > 1 {
                format!("item:{}", meta.item_of(m).unwrap_or(usize::MAX))
            } else {
                format!("id:{m}")
            };
            match groups.iter_mut().find(|(k, _)| *k == key) {
                Some((_, v)) => v.push(region(mj)),
                None => groups.push((key, vec![region(mj)])),
            }
        }
        let Some(pos) = groups.iter().position(|(k, _)| k == "own") else {
            return Err(format!("B5 node {nid} {i}: none of its own marks {own:?} was drawn"));
        };
        let own_boxes = groups.remove(pos).1;
        let d_own = dist(frm, union(&own_boxes));
        let d_other = groups.iter().map(|(_, v)| dist(frm, union(v))).fold(f64::INFINITY, f64::min);
        let max_px = nr.g("max_px").num().unwrap_or(f64::NAN);
        if d_own > max_px || d_own >= d_other {
            out.push(format!("B5 node {nid} {i}: {d_own:.1} px from its own mark (max {}), {d_other:.1} px from another", st(nr.g("max_px"))));
        }
    }
    // B6: no two text boxes of a node overlap
    let mut ids: Vec<&(String, Bx)> = tb.iter().collect();
    ids.sort_by(|a, b| a.0.cmp(&b.0));
    for x in 0..ids.len() {
        for y in x + 1..ids.len() {
            let (a, b) = (ids[x].1, ids[y].1);
            if a.0 < b.2 && b.0 < a.2 && a.1 < b.3 && b.1 < a.3 {
                out.push(format!("B6 node {nid}: texts {} and {} overlap", ids[x].0, ids[y].0));
            }
        }
    }
    Ok(out)
}

/// The content a reply's geometry is drawn with, by id: a mark's shape and emphasis, a text's words and source. Two replies
/// that render the same list print the same page.
#[cfg(test)]
pub fn rendered(replies: &J, metas: &BTreeMap<String, Meta>) -> Vec<String> {
    let mut out = Vec::new();
    for (nid, r) in replies.obj() {
        let Some(meta) = metas.get(nid) else { continue };
        for (i, g) in r.g("marks").obj() {
            let focus = meta.marks.iter().find(|m| m.0 == *i).is_some_and(|m| m.3);
            out.push(format!("mark {i} {} {}", st(g.g("shape")), if focus { "accent" } else { "base" }));
        }
        for (i, _) in r.g("texts").obj() {
            if let Some((_, printed, src)) = meta.texts.iter().find(|t| t.0 == *i) {
                out.push(format!("text {i} {printed} {}", src.dump()));
            }
        }
    }
    out
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn num_attr(x: f64) -> String {
    let r = py_round(x, 2);
    if r == r.trunc() && r.abs() < 1e15 { format!("{}", r as i64) } else { format!("{r}") }
}

/// The node's SVG as the core draws it: each shape at the reply's coordinates, its emphasis from the core's record; each
/// text at the reply's position, its words and source from the core's record. Nothing the node sent is printed.
pub fn svg(nid: &str, req: &J, reply: &J, meta: &Meta) -> String {
    let (w, h) = (st(req.g("frame").g("w")), st(req.g("frame").g("h")));
    let mut out = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" data-node=\"{}\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\">", xml(nid));
    for (id, _, part, focus) in &meta.marks {
        let g = reply.g("marks").g(id);
        let class = if *focus { "mark accent" } else { "mark base" };
        let part = part.as_ref().map_or(String::new(), |p| format!(" data-part=\"{}\"", xml(p)));
        let a = |f: &str| num_attr(coord(g, f));
        let el = match g.g("shape").s() {
            Some("rect") => format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"", a("x"), a("y"), a("w"), a("h")),
            Some("circle") => format!("<circle cx=\"{}\" cy=\"{}\" r=\"{}\"", a("cx"), a("cy"), a("r")),
            _ => format!("<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"", a("x1"), a("y1"), a("x2"), a("y2")),
        };
        let _ = write!(out, "{el} class=\"{class}\" data-id=\"{}\"{part}/>", xml(id));
    }
    for (id, printed, src) in &meta.texts {
        let t = reply.g("texts").g(id);
        let src = match src {
            J::Str(s) => s.clone(),
            other => other.dump(),
        };
        let _ = write!(
            out,
            "<text x=\"{}\" y=\"{}\" text-anchor=\"{}\" data-id=\"{}\" data-src=\"{}\">{}</text>",
            num_attr(coord(t, "x")),
            num_attr(coord(t, "y")),
            xml(&st(t.g("anchor"))),
            xml(id),
            xml(&src),
            xml(printed)
        );
    }
    out.push_str("</svg>");
    out
}

/// The core's whole check of an envelope ({input: {rows, page_spec, name_table, points, given, select_spec, knobs,
/// drawn_rules, word_table, ...}, external, reply}): C1-C5 first, then the requests, then B0, then B1-B7 per node.
#[cfg(test)]
pub fn check_envelope(env: &J, reg: &J) -> Result<Vec<String>, String> {
    let inp = env.g("input");
    let spec = inp.g("page_spec");
    let ext: Vec<String> = env.g("external").arr().iter().map(st).collect();
    let (errs, content) = content_problems(spec, inp, &ext, reg);
    let Some(content) = content else { return Ok(errs) };
    let (reqs, metas) = issue(spec, inp, reg, &ext, &content.got, &content.rpage)?;
    let reply = env.g("reply");
    let b0 = reply_problems(reply, &reqs);
    if !b0.is_empty() {
        return Ok(b0);
    }
    let mut out = Vec::new();
    for (nid, req) in &reqs {
        out.extend(geometry_problems(nid, req, reply.g(nid), &metas[nid])?);
    }
    Ok(out)
}

// ================================================================================================================
// The visual group's NodeFill: one external node asked, its geometry checked, and what the flow's Filled takes from it
// derived by the core (drawn rows, rows read, facts, formats, hero data), never taken from the node.
// ================================================================================================================

/// The external bindings over P1's registry (frames; per node binding, runner, frame, items, marks, texts). P3 binds no
/// production node external, so it holds none; the leaf registry's `binding` (knobs.json) must name the same nodes.
const BINDINGS_TEXT: &str = include_str!("../runtime/page_tree/node-bindings.json");

/// The folders (under the run's runtime/) an external node's runner may lie in.
pub const RUNNER_DIRS: [&str; 2] = ["nodes/", "leaves_py/"];
/// The files under RUNNER_DIRS that are program steps, not nodes (groups.json cross_calls.node_rule.not_nodes: the bake
/// child, the registry writer). The node rule's scan skips them, so no registry may name one as a node's runner.
pub const NOT_NODES: [&str; 2] = ["leaves_py/bake.py", "leaves_py/knobs.py"];

#[cfg(test)]
thread_local! {
    /// Test-only: a registry overlay and a runner in place of the production bindings (a twin no registry lists).
    static TEST_BINDINGS: std::cell::RefCell<Option<(J, crate::next_leaf::Runner)>> = const { std::cell::RefCell::new(None) };
}

/// Test-only: runs `f` with `overlay` as the bindings and `runner` as every external node's child.
#[cfg(test)]
pub fn with_test_bindings<R>(overlay: J, runner: crate::next_leaf::Runner, f: impl FnOnce() -> R) -> R {
    TEST_BINDINGS.with(|t| *t.borrow_mut() = Some((overlay, runner)));
    let out = f();
    TEST_BINDINGS.with(|t| *t.borrow_mut() = None);
    out
}

/// The production bindings overlay.
pub fn bindings() -> J {
    parse(BINDINGS_TEXT).expect("node-bindings.json parses")
}

/// The registry in force and the runner override (test only).
fn registry_in_force() -> (J, Option<crate::next_leaf::Runner>) {
    #[cfg(test)]
    if let Some((overlay, runner)) = TEST_BINDINGS.with(|t| t.borrow().clone()) {
        return (load_registry(&overlay), Some(runner));
    }
    (load_registry(&bindings()), None)
}

/// The nodes a bindings overlay binds external.
#[cfg(test)]
pub fn external_nodes(overlay: &J) -> Vec<String> {
    overlay.g("nodes").obj().iter().filter(|(_, e)| e.g("binding").s() == Some("external")).map(|(k, _)| k.clone()).collect()
}

/// A runner path the registry may name: under one of RUNNER_DIRS, none of NOT_NODES, no `..`, a code file.
pub fn runner_allowed(rel: &str) -> bool {
    RUNNER_DIRS.iter().any(|d| rel.starts_with(d))
        && !NOT_NODES.contains(&rel)
        && !rel.split('/').any(|s| s == ".." || s == "." || s.is_empty())
        && [".mjs", ".cjs", ".js", ".py"].iter().any(|e| rel.ends_with(e))
}

/// What the flow's Filled takes from one external node, every part derived by the core.
#[derive(Debug, Clone)]
pub struct NodeFilled {
    pub node: String,
    /// The rows the node draws ({src, table, dims, time, value}), input order.
    pub drawn: Vec<Value>,
    /// The other rows its facts read, input order.
    pub reads: Vec<Value>,
    pub facts: Vec<(String, Value)>,
    pub fmts: Vec<(String, Value)>,
    /// Its binds with every reference resolved: a select to its recomputed result, {fact: k} to k, {family: f} to f.
    pub data: Vec<(String, Value)>,
    pub svg: String,
    /// From the child's start to its reply line, and the core's checks (C and B), each wall clock.
    pub child_ms: u64,
    pub recheck_ms: u64,
}

fn node_in<'a>(spec: &'a J, id: &str) -> Option<&'a J> {
    walk(spec.g("body"), "$").into_iter().map(|(_, n)| n).find(|n| n.g("kind").s() == Some("Node") && n.g("id").s() == Some(id))
}

/// The fact keys a node prints or names (fact: refs and {fact: k}), each as its declared key (a family member as its
/// family), then the facts those read (a, b), in first-seen order.
fn facts_of(n: &J, rfacts: &J) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let add = |k: &str, out: &mut Vec<String>| {
        let k = strip_part(k);
        let key = if rfacts.has(k) {
            Some(k.to_string())
        } else {
            k.rsplit_once('.').map(|x| x.0).filter(|f| rfacts.g(f).has("each")).map(str::to_string)
        };
        if let Some(key) = key {
            if !out.contains(&key) {
                out.push(key);
            }
        }
    };
    for (_, v) in walk(n, "$") {
        if let Some(k) = v.s().and_then(|s| s.strip_prefix("fact:")) {
            add(k, &mut out);
        }
        if v.is_obj() && v.obj().iter().all(|(k, _)| k == "fact" || k == "part") {
            if let Some(k) = v.g("fact").s() {
                add(k, &mut out);
            }
        }
    }
    let mut i = 0;
    while i < out.len() {
        let q = rfacts.g(&out[i]).clone();
        for side in ["a", "b"] {
            if let Some(x) = q.g(side).s() {
                add(x, &mut out);
            }
        }
        i += 1;
    }
    out
}

/// What the flow takes from the node, derived from the core's own content (the R10 derivations).
fn derive(n: &J, inp: &J, spec: &J, content: &Content) -> NodeFilled {
    let rows = inp.g("rows").arr();
    let (got, rfacts) = (&content.got, content.rpage.g("facts").g("facts"));
    let sel: Vec<(String, &J)> = spec.g("selects").g("items").arr().iter().map(|s| (st(s.g("id")), s)).collect();
    let mut drawn: Vec<&J> = Vec::new();
    if inp.g("drawn_rules").g(&st(n.g("node"))).s() == Some("rows_of_select") {
        let b = n.g("binds");
        let r = if b.g("ranked").truthy() { b.g("ranked") } else { n.g("items_for") };
        if let Some(over) = ref_id(r).and_then(|sid| root_rank(&sel, &sid).ok().map(|root| (sid, root.g("over").clone()))) {
            let (sid, over) = over;
            let codes = got.get(&sid).map(|c| c.arr().to_vec()).unwrap_or_default();
            let by = st(over.g("by"));
            drawn = rows.iter().filter(|r| r.g("table") == over.g("table") && r.g("time") == over.g("time") && codes.contains(dims(r, &by))).collect();
        }
    }
    let keys = facts_of(n, rfacts);
    let mut read: BTreeSet<String> = BTreeSet::new();
    for k in &keys {
        read.extend(fact_rows(rfacts.g(k), rows).iter().map(|r| st(r.g("src"))));
    }
    let drawn_srcs: Vec<String> = drawn.iter().map(|r| st(r.g("src"))).collect();
    let reads: Vec<Value> = rows.iter().filter(|r| read.contains(&st(r.g("src"))) && !drawn_srcs.contains(&st(r.g("src")))).map(J::to_value).collect();
    let fmts_all = spec.g("facts").g("fmts");
    let mut fmts: Vec<(String, Value)> = Vec::new();
    for k in &keys {
        let f = st(rfacts.g(k).g("fmt"));
        if let Some(m) = fmts_all.get(&f) {
            if !fmts.iter().any(|(x, _)| *x == f) {
                let kept = J::Obj(m.obj().iter().filter(|(k, _)| matches!(k.as_str(), "scale" | "dec" | "suffix")).cloned().collect());
                fmts.push((f, kept.to_value()));
            }
        }
    }
    let data = n
        .g("binds")
        .obj()
        .iter()
        .map(|(k, v)| {
            let x = match v {
                J::Str(s) if ref_parts(s).is_some() => resolve_ref(s, got).unwrap_or(J::Null),
                J::Obj(m) if m.len() == 1 && (v.has("fact") || v.has("family")) => m[0].1.clone(),
                J::Obj(_) if ref_id(v).is_some() => got.get(&ref_id(v).expect("checked")).cloned().unwrap_or(J::Null),
                v => v.clone(),
            };
            (k.clone(), x.to_value())
        })
        .collect();
    NodeFilled {
        node: st(n.g("id")),
        drawn: drawn.into_iter().map(J::to_value).collect(),
        reads,
        facts: keys.iter().map(|k| (k.clone(), rfacts.g(k).to_value())).collect(),
        fmts,
        data,
        svg: String::new(),
        child_ms: 0,
        recheck_ms: 0,
    }
}

/// Request::NodeFill: the external node `node` of the core's page tree (`tree`: {page_spec, rows, name_table, points,
/// given, select_spec, knobs, drawn_rules, word_table, ...}) asked for its geometry by its registered runner under
/// `runtime`, everything checked (C1-C5 before the child starts, B0-B7 on its reply). Err lists every failure, one per line;
/// nothing is repaired and nothing falls back to the rust fill.
pub fn node_fill(node: &str, tree: &Value, runtime: &std::path::Path) -> Result<NodeFilled, String> {
    let started = std::time::Instant::now();
    let inp = J::from_value(tree);
    let spec = inp.g("page_spec");
    let n = node_in(spec, node).ok_or_else(|| format!("node {node}: the page tree has no node {node}"))?;
    let (reg, runner_override) = registry_in_force();
    let entry = reg.g("nodes").g(&st(n.g("node")));
    if entry.g("binding").s() != Some("external") {
        return Err(format!("node {node}: the registry binds {} rust, not external", st(n.g("node"))));
    }
    let ext = vec![node.to_string()];
    let (errs, content) = content_problems(spec, &inp, &ext, &reg);
    let Some(content) = content else { return Err(errs.iter().map(|e| format!("node {node}: recheck: {e}")).collect::<Vec<_>>().join("\n")) };
    let (reqs, metas) = issue(spec, &inp, &reg, &ext, &content.got, &content.rpage).map_err(|e| format!("node {node}: recheck: {e}"))?;
    let runner = match runner_override {
        Some(r) => r,
        None => {
            let rel = st(entry.g("runner"));
            if !runner_allowed(&rel) {
                return Err(format!("node {node}: runner {rel:?} is not a code file under {RUNNER_DIRS:?} of the runtime"));
            }
            let path = runtime.join(&rel);
            if rel.ends_with(".py") { crate::next_leaf::Runner::python(&path) } else { crate::next_leaf::Runner::node(&path) }
        }
    };
    let before_child = started.elapsed();
    let (line, child_ms) = crate::next_leaf::ask_once(&runner, &reqs[0].1.dump(), crate::next_leaf::FILL_DEADLINE)
        .map_err(|e| format!("node {node}: the child: {e}"))?;
    let after_child = std::time::Instant::now();
    let reply = parse(&line).map_err(|e| format!("node {node}: recheck: B0 reply: {e}"))?;
    let replies = J::Obj(vec![(node.to_string(), reply)]);
    let mut fails = reply_problems(&replies, &reqs);
    if fails.is_empty() {
        fails = geometry_problems(node, &reqs[0].1, replies.g(node), &metas[node]).map_err(|e| format!("node {node}: recheck: {e}"))?;
    }
    if !fails.is_empty() {
        return Err(fails.iter().map(|e| format!("node {node}: recheck: {e}")).collect::<Vec<_>>().join("\n"));
    }
    let mut out = derive(n, &inp, spec, &content);
    out.svg = svg(node, &reqs[0].1, replies.g(node), &metas[node]);
    out.child_ms = child_ms as u64;
    out.recheck_ms = (before_child + after_child.elapsed()).as_millis() as u64;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p3b")
    }
    fn read(name: &str) -> J {
        parse(&std::fs::read_to_string(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))).unwrap_or_else(|e| panic!("{name}: {e}"))
    }
    fn heads(errs: &[String]) -> Vec<String> {
        errs.iter().map(|e| e.split(':').next().unwrap_or("").to_string()).collect()
    }
    fn reg_of(env: &J) -> J {
        load_registry(env.get("registry_overlay").unwrap_or(&read("registry-b.json")))
    }

    /// Reads JSON as Python does: document order, NaN and Infinity, ints and floats apart, Python's equality and repr.
    #[test]
    fn next_tree_json_reads_and_prints_as_the_prototype() {
        let v = parse(r#"{"b": 1, "a": [1.0, Infinity, -Infinity, "xé😀"], "b": 2}"#).unwrap();
        assert_eq!(v.obj().iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(v.g("b"), &J::Int(2));
        assert!(matches!(v.g("a").at(0), J::Num(_)) && v.g("a").at(0) == &J::Int(1));
        assert!(!v.g("a").at(1).finite());
        assert_eq!(J::obj_of(vec![("x", J::Int(1)), ("y", J::Int(2))]), J::obj_of(vec![("y", J::Int(2)), ("x", J::Bool(true))]));
        for (x, want) in [(1e-5, "1e-05"), (0.0001, "0.0001"), (170.0, "170.0"), (65.4, "65.4"), (1e16, "1e+16"), (-2.5e-7, "-2.5e-07"), (123456.789, "123456.789")] {
            assert_eq!(py_float(x), want);
        }
        assert_eq!(J::str("from_node").repr(), "'from_node'");
        assert_eq!(parse(r#"{"fields": ["x"], "of": 0.4}"#).unwrap().repr(), "{'fields': ['x'], 'of': 0.4}");
        assert_eq!(ref_parts("select:ranked[0]"), Some(("ranked".into(), None, Some(0))));
        assert_eq!(ref_parts("select:groups.other"), Some(("groups".into(), Some("other".into()), None)));
        assert_eq!(ref_parts("select:Ranked"), None);
        assert_eq!(py_round(12.649999999999999, 3), 12.65);
    }

    /// The schema's every pattern has a matcher here, and the core refuses a schema with one it has none for.
    #[test]
    fn next_tree_every_schema_pattern_has_a_matcher() {
        let mut missing = Vec::new();
        for (_, v) in walk(schema(), "$") {
            if let Some(p) = v.g("pattern").s() {
                if pattern_match(p, "").is_none() {
                    missing.push(p.to_string());
                }
            }
        }
        assert!(missing.is_empty(), "{missing:?}");
        assert_eq!(pattern_match("^[a-z]+x$", "ax"), None);
        assert_eq!(pattern_match(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$", "ab.c_1"), Some(true));
        assert_eq!(pattern_match(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$", "ab..c"), Some(false));
        let words = r"^(?!.*(一半|过半|大半|半数|减半|近半|逾半|超半|翻番|翻倍|数倍|[零〇一二两三四五六七八九十百千万亿几]\s*(倍|分之|个百分点|%|％)))[^0-9０-９]*$";
        assert_eq!(pattern_match(words, "约三成"), Some(true));
        assert_eq!(pattern_match(words, "三 倍"), Some(false));
        assert_eq!(pattern_match(words, "过半数"), Some(false));
        assert_eq!(pattern_match(words, "第2"), Some(false));
    }

    /// Every plan B fixture (scripts/fixtures/p3b, the prototype's own, with the 11-01 additions) stops or passes as it says,
    /// and with the prototype's failure heads (each failure line up to its first ':'), case by case.
    #[test]
    fn next_tree_fixtures_equal_the_prototype() {
        let want = read("prototype-results.json");
        let mut off = Vec::new();
        let mut n = 0;
        for (name, proto) in want.g("fixtures").obj() {
            let env = read(name);
            let errs = check_envelope(&env, &reg_of(&env)).unwrap_or_else(|e| vec![format!("CRASH: {e}")]);
            let expect = st(env.g("expect"));
            let as_expected = if expect == "pass" { errs.is_empty() } else { errs.iter().any(|e| e.contains(&expect)) };
            let proto: Vec<String> = proto.arr().iter().map(st).collect();
            if !as_expected || heads(&errs) != proto {
                off.push(format!("{name}: expect {expect:?}; rust {:?}; prototype {proto:?}; first lines {:?}", heads(&errs), errs.iter().take(3).collect::<Vec<_>>()));
            }
            n += 1;
        }
        println!("next_tree fixtures: {}/{n} equal to the prototype", n - off.len());
        assert!(off.is_empty(), "{}", off.join("\n"));
        assert_eq!(n, 54);
    }

    /// The five round-4 holes in all 38 forms they take under plan B: every form stops, with the prototype's heads.
    #[test]
    fn next_tree_holes_all_stop_as_in_the_prototype() {
        let holes = read("holes.json");
        let mut off = Vec::new();
        let forms = holes.g("forms").arr();
        for (k, f) in forms.iter().enumerate() {
            let (env, label) = match f.get("fixture") {
                Some(name) => (read(&st(name)), st(name)),
                None => {
                    let mut env = read(&st(f.g("base")));
                    let path: Vec<String> = f.g("path").arr().iter().map(st).collect();
                    assert!(env.set_path(&path, f.g("value").clone()), "form {k}: no path {path:?}");
                    (env, path.join("."))
                }
            };
            let errs = check_envelope(&env, &reg_of(&env)).unwrap_or_else(|e| vec![format!("CRASH: {e}")]);
            let proto: Vec<String> = f.g("heads").arr().iter().map(st).collect();
            if errs.is_empty() || heads(&errs) != proto {
                off.push(format!("hole {} form {label}: rust {:?}, prototype {proto:?}", st(f.g("hole")), heads(&errs)));
            }
        }
        println!("next_tree holes: {}/{} forms stopped as in the prototype", forms.len() - off.len(), forms.len());
        assert!(off.is_empty(), "{}", off.join("\n"));
        assert_eq!(forms.len(), 38);
    }

    /// The 11,222 tamper cases the prototype judged by geometry (a number in a coordinate slot, an honest object under
    /// another issued id): B0 lets each through, and the geometry heads equal the prototype's; each that passes renders
    /// the honest reply's content.
    #[test]
    fn next_tree_tamper_geometry_equals_the_prototype() {
        let all = read("tamper-geometry.json");
        let (mut total, mut passed, mut off) = (0i64, 0i64, Vec::new());
        for (name, cases) in all.g("cases").obj() {
            let env = read(name);
            let reg = reg_of(&env);
            let inp = env.g("input");
            let spec = inp.g("page_spec");
            let ext: Vec<String> = env.g("external").arr().iter().map(st).collect();
            let (errs, content) = content_problems(spec, inp, &ext, &reg);
            assert!(errs.is_empty(), "{name}: {errs:?}");
            let content = content.expect("passed");
            let (reqs, metas) = issue(spec, inp, &reg, &ext, &content.got, &content.rpage).unwrap();
            let honest = rendered(env.g("reply"), &metas);
            for case in cases.arr() {
                let path: Vec<String> = case.at(0).arr().iter().map(st).collect();
                let mut reply = env.g("reply").clone();
                assert!(reply.set_path(&path, case.at(1).clone()));
                let count = case.at(2).num().unwrap() as i64;
                total += count;
                let proto: Vec<String> = case.at(3).arr().iter().map(st).collect();
                let b0 = reply_problems(&reply, &reqs);
                if !b0.is_empty() {
                    off.push(format!("{name} {path:?}: B0 refused {:?}", heads(&b0)));
                    continue;
                }
                let mut g = Vec::new();
                for (nid, req) in &reqs {
                    g.extend(geometry_problems(nid, req, reply.g(nid), &metas[nid]).unwrap_or_else(|e| vec![format!("CRASH: {e}")]));
                }
                let mut h = heads(&g);
                h.sort();
                if h != proto {
                    off.push(format!("{name} {path:?} = {}: rust {h:?}, prototype {proto:?}", case.at(1).repr()));
                } else if h.is_empty() {
                    passed += count;
                    if rendered(&reply, &metas) != honest {
                        off.push(format!("{name} {path:?}: passes but renders other content"));
                    }
                }
            }
        }
        println!("next_tree tamper geometry: {} cases, {} passed with the honest content, {} not as the prototype", total, passed, off.len());
        assert!(off.is_empty(), "{}", off.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
        assert_eq!((total, passed), (all.g("total").num().unwrap() as i64, 887));
    }

    /// A text farther than MAX_PX_MAX from its mark, or a circle radius above RADIUS_PX_MAX, is refused when the registry
    /// loads; one at or under the cap is taken, and so is every value registered today.
    #[test]
    fn next_tree_a_registry_text_distance_or_radius_over_the_cap_is_refused() {
        fn at_mut<'a>(mut o: &'a mut J, path: &[&str]) -> &'a mut J {
            for k in path {
                o = o.get_mut(k).unwrap_or_else(|| panic!("registry-b.json has no {k}"));
            }
            o
        }
        let base = read("registry-b.json");
        assert!(registry_problems(&load_registry(&base)).is_empty());
        for (d, refused) in [(25.0, true), (24.0, false), (6.0, false), (0.0, true), (-1.0, true)] {
            let mut o = base.clone();
            let label = at_mut(&mut o, &["nodes", "bars", "texts", "item", "label"]);
            label.set("max_px", J::Num(d));
            let errs = registry_problems(&load_registry(&o));
            assert_eq!(errs.iter().any(|e| e.starts_with("C5 registry bars text label: max_px")), refused, "{d}: {errs:?}");
        }
        for (r, refused) in [(29.0, true), (28.0, false), (10.0, false), (0.0, true)] {
            let mut o = base.clone();
            let enc = at_mut(&mut o, &["nodes", "bubbles", "marks", "encode"]);
            let J::Arr(chs) = enc else { panic!("encode is a list") };
            chs[0].get_mut("scale").unwrap().set("range", J::obj_of(vec![("max_px", J::Num(r))]));
            let errs = registry_problems(&load_registry(&o));
            assert_eq!(errs.iter().any(|e| e.starts_with("C5 registry bubbles channel")), refused, "{r}: {errs:?}");
        }
    }

    /// A registry tolerance above TOL_PX_MAX is refused when the registry loads; one at or under it is taken.
    #[test]
    fn next_tree_a_registry_tolerance_over_the_cap_is_refused() {
        let mut o = read("registry-b.json");
        for (tol, refused) in [(0.6, true), (0.5, false), (0.1, false), (-0.1, true)] {
            o.get_mut("nodes").and_then(|n| n.get_mut("bars")).and_then(|b| b.get_mut("marks")).unwrap().set("tol_px", J::Num(tol));
            let errs = registry_problems(&load_registry(&o));
            assert_eq!(errs.iter().any(|e| e.starts_with("C5 registry bars marks: tol_px")), refused, "{tol}: {errs:?}");
        }
    }

    /// The production bindings bind no node external (P3), the leaf registry's knobs.json names the same (none), and every
    /// external entry would need a runner under the node folders.
    #[test]
    fn next_tree_production_binds_no_node_external() {
        let o = bindings();
        assert!(external_nodes(&o).is_empty(), "{:?}", external_nodes(&o));
        assert!(registry_problems(&load_registry(&o)).is_empty());
        let leaf: Vec<&String> = crate::next_leaf::leaves().nodes.iter().filter(|(_, l)| l.external).map(|(k, _)| k).collect();
        assert!(leaf.is_empty(), "{leaf:?}");
        assert!(runner_allowed("nodes/bars.mjs") && runner_allowed("leaves_py/bars.py"));
        for bad in ["pi/x.mjs", "nodes/../pi/x.mjs", "nodes/x.json", "/nodes/x.mjs", "nodes/./x.py", "leaves_py/bake.py", "leaves_py/knobs.py"] {
            assert!(!runner_allowed(bad), "{bad}");
        }
    }

    // ---- R11: colour --------------------------------------------------------------------------------------------

    fn r11_cases() -> Vec<(String, J)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/r11");
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".json")).collect();
        names.sort();
        names.into_iter().map(|n| (n.trim_end_matches(".json").to_string(), parse(&std::fs::read_to_string(dir.join(&n)).unwrap()).unwrap())).collect()
    }

    /// The shipped palette file passes palette_ok; each bad palette file of the prototype's cases (N5c, N8a-N8f) is
    /// refused with the prototype's failure heads, line by line.
    #[test]
    fn next_tree_r11_palette_ok_loads_the_shipped_file_and_refuses_the_bad_ones() {
        assert_eq!(palette_problems(palettes()), Vec::<String>::new());
        let mut n = 0;
        for (id, c) in r11_cases().into_iter().filter(|(id, _)| id == "N5c" || id.starts_with("N8")) {
            let got = palette_problems(c.g("palettes"));
            let proto: Vec<String> = c.g("got").arr().iter().map(st).collect();
            assert_eq!(heads(&got), heads(&proto), "{id}: {got:?}");
            assert!(got.iter().any(|e| e.contains(&st(c.g("expect")))), "{id}: {got:?}");
            n += 1;
        }
        assert_eq!(n, 7);
    }

    /// One accent value across the repo's colour sources: tokens.css, the two leaf page roots and the JS nodes' colours
    /// each declare exactly the palette file's accent wherever they declare a saturated accent.
    #[test]
    fn next_tree_r11_one_accent_value() {
        let acc = st(palettes().g("roles").g("accent"));
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime");
        let mut seen = Vec::new();
        for (file, key) in [("leaves_py/tokens.css", "--accent:"), ("leaves_py/scmp.py", "--accent:"), ("leaves_py/prod.py", "--accent:"), ("nodes/common.mjs", "accent: \"")] {
            let text = std::fs::read_to_string(root.join(file)).unwrap();
            for (i, _) in text.match_indices(key) {
                let v = text.get(i + key.len()..i + key.len() + 7).unwrap_or("");
                if canon_hex(v) && chroma(v) <= NEUTRAL_CHROMA_MAX {
                    continue;
                }
                seen.push((file, v.to_string()));
            }
        }
        assert!(seen.len() >= 4, "{seen:?}");
        assert!(seen.iter().all(|(_, v)| *v == acc), "{acc}: {seen:?}");
    }
}
