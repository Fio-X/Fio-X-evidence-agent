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
//!   On the SVG the core draws (R11): paint_matches_scale, every painted mark, in-mark number and legend entry equal to
//!      the core's recomputation from its scale record; single_accent, every colour from the palette file and spelled one
//!      way, one accent. Both run on every node the core draws and no registry can switch them off.
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
pub(crate) fn st(v: &J) -> String {
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
/// The knowledge group's list of words that write a fixed term, a unit or a band with a numeral or a digit (user 11-07
/// 「全按推荐」⑤), read as data: number_free is a port of next_flow::number_free.
const FREE_WORDS_TEXT: &str = include_str!("../runtime/pi/assets/number-free-words.json");

fn free_words() -> &'static J {
    static W: std::sync::OnceLock<J> = std::sync::OnceLock::new();
    W.get_or_init(|| parse(FREE_WORDS_TEXT).expect("number-free-words.json parses"))
}

/// Each spelling of a digit term (digit_terms) a text may write, with the term the page tree prints for it, longest spelling
/// first: the term itself, and an age band written with another range mark of number-free-words.json (15至24岁 prints
/// 15-24岁), as the text checks read it (number_free, next_flow::number_free).
pub fn digit_term_spellings() -> Vec<(String, String)> {
    let w = free_words();
    let marks: Vec<char> = w.g("age_range").arr().iter().flat_map(|x| st(x).chars().collect::<Vec<_>>()).collect();
    let ages: Vec<String> = w.g("ages").arr().iter().map(st).collect();
    let mut out = Vec::new();
    for t in digit_terms() {
        if ages.contains(&t) && t.contains('-') {
            out.extend(marks.iter().filter(|m| **m != '-').map(|m| (t.replace('-', &m.to_string()), t.clone())));
        }
        out.push((t.clone(), t));
    }
    out.sort_by(|a, b| b.0.chars().count().cmp(&a.0.chars().count()).then(a.0.cmp(&b.0)));
    out
}

/// The words of number-free-words.json that hold an ASCII digit as an official indicator name writes them (15-24岁, PM2.5,
/// 每10万人; user 11-08 item 4), longest first: a page prints one as a term run, never as a literal (which holds no digit).
pub fn digit_terms() -> Vec<String> {
    let mut out: Vec<String> = ["terms", "si_units", "rates", "ages", "scales"]
        .iter()
        .flat_map(|k| free_words().g(k).arr().iter().map(st).collect::<Vec<_>>())
        .filter(|w| w.chars().any(|c| c.is_ascii_digit()))
        .collect();
    out.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then(a.cmp(b)));
    out.dedup();
    out
}

/// Which chars of a text's literal (`held` marks a placeholder's blank) write a term, a unit, a rate's base, a scale label
/// or an age band of number-free-words.json (next_flow::number_free, ported).
fn number_free(chars: &[char], held: &[bool]) -> Vec<bool> {
    let w = free_words();
    let words = |k: &str| w.g(k).arr().iter().map(|x| st(x).to_string()).collect::<Vec<String>>();
    let list = |k: &str| words(k).iter().map(|x| x.chars().collect::<Vec<char>>()).collect::<Vec<_>>();
    let (terms, si_units, rates, scales, scale_open, scale_close) =
        (list("terms"), list("si_units"), list("rates"), list("scales"), list("scale_open"), list("scale_close"));
    let ages = words("ages");
    let age_range: Vec<char> = words("age_range").iter().flat_map(|x| x.chars()).collect();
    let numeral = |c: char| c.is_numeric() || NUMERALS.contains(c);
    let at = |i: usize, word: &[char]| !word.is_empty() && chars.get(i..i + word.len()) == Some(word);
    let before = |i: usize| (0..i).rev().find(|&j| held[j] || !chars[j].is_whitespace());
    let counted = |j: usize| numeral(chars[j]) || QUANTITY_BEFORE.contains(chars[j]);
    let run_end = |i: usize| {
        let mut e = i;
        while e < chars.len() && (numeral(chars[e]) || (chars[e] == '.' && chars.get(e + 1).is_some_and(|&n| numeral(n)))) {
            e += 1;
        }
        e
    };
    let mut free = vec![false; chars.len()];
    for i in 0..chars.len() {
        let mut mark = |from: usize, to: usize| free[from..to].iter_mut().for_each(|f| *f = true);
        // a coded term stands alone among Latin letters and digits (M2 is not in PM2.5)
        let alone = |t: &[char]| {
            let code = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '.');
            !code(i.checked_sub(1).and_then(|j| chars.get(j))) && !code(chars.get(i + t.len()))
        };
        if let Some(t) = terms.iter().chain(&rates).find(|t| at(i, t) && alone(t)) {
            if before(i).is_none_or(|j| !held[j] && !counted(j)) {
                mark(i, i + t.len());
            }
        }
        if let Some(u) = si_units.iter().find(|u| at(i, u)) {
            if before(i).is_none_or(|j| held[j] || !counted(j)) {
                mark(i, i + u.len());
            }
        }
        if let Some(o) = scale_open.iter().find(|o| at(i, o)) {
            let closed = |s: &[char]| scale_close.iter().any(|c| at(i + o.len() + s.len(), c));
            if let Some(s) = scales.iter().find(|s| at(i + o.len(), s) && closed(s)) {
                mark(i + o.len(), i + o.len() + s.len());
            }
        }
        if numeral(chars[i]) && (i == 0 || !numeral(chars[i - 1])) && before(i).is_none_or(|j| !held[j]) {
            let e = run_end(i);
            let mut end = e;
            if chars.get(e).is_some_and(|c| age_range.contains(c)) && run_end(e + 1) > e + 1 {
                end = run_end(e + 1);
            }
            if chars.get(end) == Some(&'岁') {
                let band: String = chars[i..=end].iter().map(|&c| if age_range.contains(&c) { '-' } else { c }).collect();
                // an age band alone, or a single age with the words its official name writes after it (5岁以下); a bare age
                // (增加了5岁) is a number (next_flow::number_free)
                let rest: String = chars[end + 1..].iter().collect();
                let named = ages.iter().filter(|a| a.starts_with(band.as_str()) && rest.starts_with(&a[band.len()..]));
                if let Some(a) = named.max_by_key(|a| a.len()) {
                    mark(i, end + 1 + a[band.len()..].chars().count());
                }
            }
        }
    }
    free
}

/// The value of a run of NUMERALS (next_flow::numeral_value, ported); None for a run with 几 or a digit.
fn numeral_value(run: &[char]) -> Option<usize> {
    let (mut total, mut section, mut digit) = (0usize, 0usize, None::<usize>);
    for &c in run {
        let unit = match c {
            '十' => 10,
            '百' => 100,
            '千' => 1000,
            '万' => 10_000,
            '亿' => 100_000_000,
            '〇' => {
                digit = Some(0);
                continue;
            }
            '两' => {
                digit = Some(2);
                continue;
            }
            '零' => {
                digit = Some(0);
                continue;
            }
            '一' => {
                digit = Some(1);
                continue;
            }
            '二' => {
                digit = Some(2);
                continue;
            }
            '三' => {
                digit = Some(3);
                continue;
            }
            '四' => {
                digit = Some(4);
                continue;
            }
            '五' => {
                digit = Some(5);
                continue;
            }
            '六' => {
                digit = Some(6);
                continue;
            }
            '七' => {
                digit = Some(7);
                continue;
            }
            '八' => {
                digit = Some(8);
                continue;
            }
            '九' => {
                digit = Some(9);
                continue;
            }
            _ => return None,
        };
        if unit >= 10_000 {
            total = total.checked_add((section + digit.unwrap_or(0)).max(1).checked_mul(unit)?)?;
            section = 0;
        } else {
            section += digit.unwrap_or(1) * unit;
        }
        digit = None;
    }
    Some(total + section + digit.unwrap_or(0))
}

/// Which chars of a text's literal (`held` marks a placeholder's blank) count the places the page draws: a numeral run
/// right before a place_counts noun of number-free-words.json whose value is `places`, not after 第, a QUANTITY_BEFORE
/// word or a placeholder (next_flow::place_count, ported; user 11-07). None marks none.
fn place_count(chars: &[char], held: &[bool], places: Option<usize>) -> Vec<bool> {
    let mut free = vec![false; chars.len()];
    let Some(places) = places else { return free };
    let nouns: Vec<Vec<char>> = free_words().g("place_counts").arr().iter().map(|x| st(x).chars().collect()).collect();
    let numeral = |c: char| NUMERALS.contains(c);
    let mut i = 0;
    while i < chars.len() {
        if !numeral(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && numeral(chars[i]) {
            i += 1;
        }
        let before = (0..start).rev().find(|&j| held[j] || !chars[j].is_whitespace());
        let free_before = before.is_none_or(|j| !held[j] && chars[j] != '第' && !QUANTITY_BEFORE.contains(chars[j]));
        let noun = nouns.iter().any(|n| chars.get(i..i + n.len()) == Some(n.as_slice()));
        if free_before && noun && numeral_value(&chars[start..i]) == Some(places) {
            free[start..i].iter_mut().for_each(|f| *f = true);
        }
    }
    free
}

/// The number of distinct places a page draws: the codes of the place_dims of number-free-words.json across the rows of
/// its record's drawn entries (each a row of `rows` by its src), as next_run counts them on the fill. None when no drawn
/// row holds a place.
fn places_drawn(page: &J, rows: &[J]) -> Option<usize> {
    let srcs: BTreeSet<String> = page.g("record").g("drawn").arr().iter().map(|d| st(d.g("src"))).collect();
    let dims: Vec<String> = free_words().g("place_dims").arr().iter().map(st).collect();
    let codes: BTreeSet<String> = rows
        .iter()
        .filter(|r| srcs.contains(&st(r.g("src"))))
        .flat_map(|r| dims.iter().filter_map(|d| r.g("dims").g(d).s().map(str::to_string)).collect::<Vec<_>>())
        .collect();
    (!codes.is_empty()).then_some(codes.len())
}

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
pub(crate) fn ref_id(v: &J) -> Option<String> {
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

pub(crate) type Got = BTreeMap<String, J>;
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

pub(crate) fn resolve_ref(v: &str, got: &Got) -> Result<J, String> {
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
pub(crate) fn resolved(v: &J, got: &Got) -> Result<J, String> {
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
                // owner 11-06: a difference or ratio is computed from the raw values, never from its operands as printed
                if q.has("of_printed") {
                    return Err(format!("{key}: of_printed is refused, a difference is computed from the raw values"));
                }
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
            // where `code` stands among the codes of `by` at `time`, highest first (next_facts position): 1 and the codes above it
            "position" => {
                let by = q.g("by").s().ok_or("'by'")?;
                let code = q.g("code");
                let mut at: Vec<(&J, f64)> = Vec::new();
                for r in select_rows(self.rows, q).into_iter().filter(|r| r.g("time") == time) {
                    let c = r.g("dims").get(by).ok_or_else(|| format!("'{by}'"))?;
                    let v = num(r)?;
                    match at.iter_mut().find(|(k, _)| *k == c) {
                        Some(slot) => slot.1 += v,
                        None => at.push((c, v)),
                    }
                }
                let own = at.iter().find(|(c, _)| *c == code).map(|(_, v)| *v).ok_or_else(|| format!("{key}: position has no row of {}", code.repr()))?;
                (1 + at.iter().filter(|(_, v)| *v > own).count()) as f64
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

/// K10 (P4a-2): a rank's key, its value at over.time or its change {"change": [t0, t1]} from t0 to t1 = over.time (the later
/// value less the earlier, as the flow's changed ranks and the page's change facts compute it): the time it runs from.
pub(crate) fn change_from(s: &J) -> Option<&J> {
    let k = s.g("key");
    let ends = k.g("change").arr();
    (k.is_obj() && k.obj().len() == 1 && ends.len() == 2 && ends[1] == *s.g("over").g("time") && ends[0].s().is_some()).then(|| &ends[0])
}

/// A rank's key {"part_share": {"dim", "codes", "rows"}}: each code's parts (its `rows` at over.time whose `dim` is one of
/// `codes`) summed, over its own row's value (the total, above 0); a code with no part row or no total above 0 is left out.
fn part_share_key(s: &J) -> Option<&J> {
    let k = s.g("key");
    (k.is_obj() && k.obj().len() == 1).then(|| k.get("part_share")).flatten()
}

/// The share of a code's parts in its total (part_share_key): none when its total is not above 0 or it has no part row.
fn part_share_of(ps: &J, by: &str, time: &J, code: &J, total: f64) -> Option<f64> {
    if total <= 0.0 {
        return None;
    }
    let dim = st(ps.g("dim"));
    let parts: Vec<f64> = ps
        .g("rows")
        .arr()
        .iter()
        .filter(|r| r.g("time") == time && dims(r, by) == code && ps.g("codes").arr().contains(dims(r, &dim)))
        .filter_map(text_num)
        .collect();
    (!parts.is_empty()).then(|| parts.iter().sum::<f64>() / total)
}

fn cannot_rank(s: &J) -> Option<String> {
    if s.g("key").s() != Some("value") && change_from(s).is_none() && part_share_key(s).is_none() {
        return Some(format!("key {} (only value, {{\"change\": [a time, over.time]}} or {{\"part_share\": ...}})", s.g("key").repr()));
    }
    let extra: Vec<&str> = s.g("over").obj().iter().map(|(k, _)| k.as_str()).filter(|k| !RANK_OVER.contains(k)).collect();
    if !extra.is_empty() {
        let mut extra = extra;
        extra.sort();
        let mut over = RANK_OVER.to_vec();
        over.sort();
        return Some(format!("over fields {} (only {})", J::strs(&extra).repr(), J::strs(&over).repr()));
    }
    if !plain_tie(s.get("tie")) && !last_in_only(s) {
        return Some(format!("tie {} (only by code, outcome order; or by only, outcome last)", s.g("tie").repr()));
    }
    None
}

/// A rank's tie {"by": "only", "outcome": "last"}: of equal keys the code later in its `only` list ranks first (a max
/// over the list in its order that keeps the last of equals, as the flow's big numbers took the origin that grew most).
fn last_in_only(s: &J) -> bool {
    s.get("tie").is_some_and(|t| *t == J::obj_of(vec![("by", J::str("only")), ("outcome", J::str("last"))])) && s.has("only")
}

/// The rows of a pairs select (held_codes, group_sum, share_merge): at its over.table and over.time, each holding every
/// `with` dimension as a code, in row order.
fn pair_rows<'a>(rows: &'a [J], s: &J) -> Vec<&'a J> {
    let q = s.g("over");
    rows.iter()
        .filter(|r| r.g("table") == q.g("table") && r.g("time") == q.g("time"))
        .filter(|r| s.g("with").arr().iter().all(|d| dims(r, &st(d)).s().is_some()))
        .collect()
}

/// A row's value as the map reads one: a text that parses to a finite number (none for anything else).
fn text_num(r: &J) -> Option<f64> {
    r.g("value").s().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite())
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
    if matches!(t.g("by").s(), Some("printed" | "value")) && t.g("outcome").s() == Some("silence") && matches!(at, "first" | "last" | "second") {
        return None;
    }
    Some(format!("tie {} at {at} (only by code, or by printed or value with silence at first, second or last)", t.repr()))
}

/// The value a take's code is ordered by: the root rank's key of it, as the rank computes it. Its rows under the rank's over
/// at over.time (read as the map reads a number when the rank reads only numbers), less its rows at the time a change runs
/// from (key change), or their parts' share (key part_share).
pub(crate) fn take_value(sel: &[(String, &J)], sid: &str, code: &J, rows: &[J]) -> Result<f64, String> {
    let root = root_rank(sel, sid)?;
    let q = root.g("over");
    let by = q.g("by").s().unwrap_or("");
    let lenient = root.g("numbers_only").truthy() || root.has("from_above");
    let sum_at = |t: &J| -> Result<f64, String> {
        let mut s = 0.0;
        for r in select_rows(rows, q).into_iter().filter(|r| r.g("time") == t && dims(r, by) == code) {
            s += if lenient { text_num(r).unwrap_or(0.0) } else { num(r)? };
        }
        Ok(s)
    };
    let mut v = sum_at(q.g("time"))?;
    if let Some(t0) = change_from(root) {
        v -= sum_at(t0)?;
    }
    if let Some(ps) = part_share_key(root) {
        v = part_share_of(ps, by, q.g("time"), code, v).ok_or_else(|| format!("{}: no share of its parts", st(code)))?;
    }
    Ok(v)
}

fn sel_get<'a>(sel: &[(String, &'a J)], id: &str) -> Option<&'a J> {
    sel.iter().find(|(k, _)| k == id).map(|(_, s)| *s)
}

pub(crate) fn root_rank<'a>(sel: &[(String, &'a J)], sid: &str) -> Result<&'a J, String> {
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

/// A fixed-point number with its whole part grouped by thousands with commas, as Python's format spec `,.{dec}f` writes
/// it (the leaf's facts.fmt): "-1234567.5" is "-1,234,567.5".
fn py_grouped(fixed: &str) -> String {
    let (sign, rest) = fixed.strip_prefix('-').map_or(("", fixed), |r| ("-", r));
    let (whole, frac) = rest.split_once('.').map_or((rest, None), |(w, f)| (w, Some(f)));
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    format!("{sign}{out}{}", frac.map_or(String::new(), |f| format!(".{f}")))
}

/// The registered parts table (runtime/pi/assets/estat-parts.tsv, the knowledge group's catalogue data), which the core reads
/// itself as vocabulary, as next_visual.rs reads the Natural Earth attributes: no function of another group is called.
const PARTS_TEXT: &str = include_str!("../runtime/pi/assets/estat-parts.tsv");

/// One estat-parts.tsv row as the core reads it: (table, dim, code, level, parent, flow side, excluded_from), a row naming
/// several tables once per table. Columns are found by the header's names; a table without one is no registry.
pub(crate) fn parts_rows() -> Result<Vec<[String; 7]>, String> {
    let mut lines = PARTS_TEXT.lines();
    let header: Vec<&str> = lines.next().unwrap_or("").split('\t').collect();
    let col = |name: &str| header.iter().position(|h| *h == name).ok_or_else(|| format!("estat-parts.tsv has no column {name}"));
    let cols = [col("tables")?, col("dim")?, col("code")?, col("level")?, col("parent")?, col("flow")?, col("excluded_from")?];
    let mut out = Vec::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        let at = |i: usize| f.get(cols[i]).copied().unwrap_or("").to_string();
        for table in at(0).split_whitespace() {
            out.push([table.to_string(), at(1), at(2), at(3), at(4), at(5), at(6)]);
        }
    }
    Ok(out)
}

/// The leaves of `dim` of `table` whose parents lead up to its total, in file order (the dimension's level-2 codes under its
/// total: an aggregate is never one), each with its excluded_from.
fn leaves_under_total(rows: &[[String; 7]], table: &str, dim: &str) -> Vec<(String, String)> {
    let of: Vec<&[String; 7]> = rows.iter().filter(|r| r[0] == table && r[1] == dim && r[3] != "overlap").collect();
    let Some(total) = of.iter().find(|r| r[3] == "total").map(|r| r[2].clone()) else { return Vec::new() };
    let parent = |code: &str| of.iter().find(|r| r[2] == code).map(|r| r[4].clone()).unwrap_or_default();
    let under = |r: &[String; 7]| {
        let mut at = r[4].clone();
        for _ in 0..of.len() {
            if at == total {
                return true;
            }
            if at.is_empty() {
                return false;
            }
            at = parent(&at);
        }
        false
    };
    of.iter().filter(|r| r[3] == "leaf" && under(r)).map(|r| (r[2].clone(), r[6].clone())).collect()
}

/// A registry_list select's codes recomputed from the registered parts table, in its order: `flow_excluded:<table>`, the
/// leaves of the flow's source dimension (the one whose total row names it the source) marked excluded_from; and
/// `flow_asked:<table>:<dim>`, the leaves of `dim` under its total less those. None for any other registry (taken as handed,
/// as before 11-03).
fn registry_list(registry: &str) -> Option<Result<J, String>> {
    let rows = match parts_rows() {
        Ok(rows) => rows,
        Err(e) => return Some(Err(e)),
    };
    let excluded = |table: &str| -> Vec<String> {
        let source = rows.iter().find(|r| r[0] == table && r[3] == "total" && r[5] == "source").map(|r| r[1].clone());
        source.map(|d| leaves_under_total(&rows, table, &d).into_iter().filter(|(_, x)| !x.is_empty()).map(|(c, _)| c).collect()).unwrap_or_default()
    };
    let codes = |c: Vec<String>| J::Arr(c.into_iter().map(J::Str).collect());
    match registry.split(':').collect::<Vec<_>>()[..] {
        ["flow_excluded", table] => Some(Ok(codes(excluded(table)))),
        ["flow_asked", table, dim] => {
            let out = excluded(table);
            Some(Ok(codes(leaves_under_total(&rows, table, dim).into_iter().map(|(c, _)| c).filter(|c| !out.contains(c)).collect())))
        }
        _ => None,
    }
}

/// The roles of a recipe's layers (11-03, the quantity a page states). Its main chart (node-bindings.json main_chart)
/// draws the headline's quantity and is never registered wholly reference. A reference (a node's roles.<recipe>: role
/// reference for the whole layer, or parts.<part>.role reference for one part of it, as the map's earlier-year halo) may
/// draw another quantity than the headline's; its legend line is the registry's word (legend.word), which every published
/// page of the recipe must print. Refused: a recipe with no main chart, a main chart that is no layer of the recipe or is
/// registered wholly reference, a role other than reference, a reference with no legend word or one the word table lacks,
/// and a recipe whose every layer is wholly reference. (main chart, [(layer or layer.part, its legend word)])
pub(crate) fn recipe_roles(reg: &J, recipe: &str) -> Result<(String, Vec<(String, String)>), String> {
    let layers: Vec<String> = reg.g("recipes").g(recipe).arr().iter().map(st).collect();
    if layers.is_empty() {
        return Err(format!("recipe {recipe}: the registry lists no layers"));
    }
    let main = reg.g("main_chart").g(recipe).s().ok_or_else(|| format!("recipe {recipe}: the registry names no main chart (main_chart)"))?.to_string();
    if !layers.contains(&main) {
        return Err(format!("recipe {recipe}: its main chart {main} is no layer of it"));
    }
    let entry = |what: &str, role: &J| -> Result<(String, String), String> {
        if role.g("role").s() != Some("reference") {
            return Err(format!("recipe {recipe}: {what} has role {}, and reference is the only role", role.g("role").repr()));
        }
        let word = role.g("legend").g("word").s().filter(|w| !w.is_empty()).ok_or_else(|| format!("recipe {recipe}: reference {what} names no legend word"))?;
        let Some(template) = crate::next_ledger::word_table().get(word).and_then(serde_json::Value::as_str) else {
            return Err(format!("recipe {recipe}: reference {what}'s legend word {word} is not in the word table"));
        };
        // the legend it sits in, and how each placeholder of its word is filled (reference_legend_gaps)
        if role.g("legend").g("within").s().is_none_or(str::is_empty) {
            return Err(format!("recipe {recipe}: reference {what}'s legend names no legend it sits within"));
        }
        // each entry it prints is one the layer draws (legend.entries over legend.draws, drawn_entry_gaps), not any entry
        // of that kind on the page: a template per entry placeholder, tied to what the layer draws by a value of draws or by
        // a value another such template shares
        let known = draws_vars(role.g("legend").g("draws"));
        let mut tied: Vec<(String, Vec<String>)> = Vec::new();
        for ph in template.split('{').skip(1).filter_map(|p| p.split_once('}').map(|x| x.0)) {
            let kind = role.g("legend").g("fills").g(ph).s().unwrap_or("");
            if !LEGEND_FILLS.contains(&kind) {
                return Err(format!("recipe {recipe}: reference {what}'s legend fills {{{ph}}} as {kind:?}, not one of {LEGEND_FILLS:?}"));
            }
            if kind == "unit" {
                continue;
            }
            let Some(e) = role.g("legend").g("entries").g(ph).s().filter(|e| !e.is_empty()) else {
                return Err(format!("recipe {recipe}: reference {what}'s legend names no entry its layer draws for {{{ph}}} (legend.entries)"));
            };
            if !e.starts_with(&format!("{}:", kind.strip_suffix("_unit").unwrap_or(kind))) {
                return Err(format!("recipe {recipe}: reference {what}'s entry {e:?} for {{{ph}}} is no {kind} entry"));
            }
            tied.push((ph.to_string(), template_vars(e)));
        }
        for (ph, vars) in &tied {
            let shared = |v: &String| tied.iter().any(|(p, vs)| p != ph && vs.contains(v) && vs.iter().any(|w| known.contains(w)));
            if !vars.iter().any(|v| known.contains(v) || shared(v)) {
                return Err(format!("recipe {recipe}: reference {what}'s entry for {{{ph}}} names nothing its layer draws (legend.draws)"));
            }
        }
        Ok((what.to_string(), word.to_string()))
    };
    let (mut refs, mut whole) = (Vec::new(), 0);
    for layer in &layers {
        let Some(roles) = reg.g("nodes").g(layer).g("roles").get(recipe) else { continue };
        if roles.has("role") {
            if *layer == main {
                return Err(format!("recipe {recipe}: its main chart {main} is registered wholly reference; the main chart draws the headline's quantity"));
            }
            refs.push(entry(layer, roles)?);
            whole += 1;
        }
        for (part, role) in roles.g("parts").obj() {
            refs.push(entry(&format!("{layer}.{part}"), role)?);
        }
    }
    if whole == layers.len() {
        return Err(format!("recipe {recipe}: every layer is wholly reference; one at least draws the headline's quantity"));
    }
    Ok((main, refs))
}

/// How a reference's legend word fills a placeholder (reference_legend_gaps is_the_word).
const LEGEND_FILLS: [&str; 5] = ["period", "fact", "name", "fact_unit", "unit"];

/// What a published page's layers were given and read, for what a reference layer draws (drawn_entry_gaps): the page's
/// knobs (`knobs.spec.hero`), its request rows, the member codes, and each fact's reads.
pub(crate) struct Drawn<'a> {
    pub hero: &'a J,
    pub rows: &'a [J],
    pub members: &'a [String],
    pub reads: &'a BTreeMap<String, Vec<String>>,
}

/// The values a reference's legend.draws gives its entry templates: each key but `span` (a path into the knobs), and
/// `first`, `last` for a `span`.
fn draws_vars(draws: &J) -> BTreeSet<String> {
    draws.obj().iter().flat_map(|(k, _)| if k == "span" { vec!["first".to_string(), "last".to_string()] } else { vec![k.clone()] }).collect()
}

/// The {placeholders} of an entry template, in order.
fn template_vars(t: &str) -> Vec<String> {
    t.split('{').skip(1).filter_map(|p| p.split_once('}').map(|x| x.0.to_string())).collect()
}

/// The knobs' value at a dotted path.
fn knob_at<'a>(hero: &'a J, path: &str) -> &'a J {
    path.split('.').fold(hero, |j, k| j.g(k))
}

/// What legend.draws names, read from the page as drawn: each key a string of the knobs at its path, and `span`
/// ({q, from, to}: paths of a query and its first and last period) the first and last period of the request rows the
/// query selects in that range (its not_eu leaving the members and TOTAL out of its by-dimension, as the layer reads it).
fn drawn_vars(draws: &J, d: &Drawn) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for (var, path) in draws.obj() {
        if var != "span" {
            let v = knob_at(d.hero, &st(path)).s().ok_or_else(|| format!("the knobs give no {var} at {}", st(path)))?;
            out.insert(var.clone(), v.to_string());
            continue;
        }
        let q = knob_at(d.hero, &st(path.g("q")));
        let table = q.g("table").s().ok_or_else(|| format!("the knobs give no query at {}", st(path.g("q"))))?;
        let from = knob_at(d.hero, &st(path.g("from"))).s().ok_or_else(|| format!("the knobs give no first period at {}", st(path.g("from"))))?;
        let to = path.g("to").s().and_then(|p| knob_at(d.hero, p).s());
        let by = q.g("by").s();
        let out_of = |r: &J| matches!(q.g("not_eu"), J::Bool(true)) && by.is_some_and(|b| d.members.iter().any(|m| m == &st(dims(r, b))) || st(dims(r, b)) == "TOTAL");
        let times: BTreeSet<String> = select_rows(d.rows, q)
            .into_iter()
            .filter(|r| !out_of(r))
            .map(|r| st(r.g("time")))
            .filter(|t| from <= t.as_str() && to.is_none_or(|to| t.as_str() <= to))
            .collect();
        let (Some(a), Some(b)) = (times.first(), times.last()) else {
            return Err(format!("the query of {table} selects no row from {from}"));
        };
        out.insert("table".to_string(), table.to_string());
        out.insert("first".to_string(), a.clone());
        out.insert("last".to_string(), b.clone());
    }
    Ok(out)
}

/// src_is's matcher: the segments (is a var, literal or name) read off `src` in order, a var not yet bound trying each
/// length from one character.
fn segs_match(src: &str, segs: &[(bool, String)], bound: &mut BTreeMap<String, String>) -> bool {
    let Some(((is_var, s), rest)) = segs.split_first() else { return src.is_empty() };
    if !is_var {
        return src.strip_prefix(s.as_str()).is_some_and(|r| segs_match(r, rest, bound));
    }
    if let Some(v) = bound.get(s).cloned() {
        return src.strip_prefix(v.as_str()).is_some_and(|r| segs_match(r, rest, bound));
    }
    for end in src.char_indices().map(|(i, c)| i + c.len_utf8()) {
        let mut b = bound.clone();
        b.insert(s.clone(), src[..end].to_string());
        if segs_match(&src[end..], rest, &mut b) {
            *bound = b;
            return true;
        }
    }
    false
}

/// Whether `src` is the entry `template` names: its literal parts and the known values exactly, each other {var} one or
/// more characters, bound once (`bound`: the same in every entry of the line).
fn src_is(src: &str, template: &str, known: &BTreeMap<String, String>, bound: &mut BTreeMap<String, String>) -> bool {
    let mut segs = Vec::new();
    for (i, p) in template.split('{').enumerate() {
        let (var, lit) = if i == 0 { (None, p) } else { p.split_once('}').map_or((None, p), |(v, l)| (Some(v), l)) };
        if let Some(v) = var {
            segs.push(known.get(v).map_or((true, v.to_string()), |k| (false, k.clone())));
        }
        if !lit.is_empty() {
            segs.push((false, lit.to_string()));
        }
    }
    segs_match(src, &segs, bound)
}

/// What a reference's legend line prints that its layer does not draw: each entry (placeholder, src) the one its template
/// names over what the layer draws (legend.entries over legend.draws), and with a `time` among them each fact entry's
/// reads all at that period (the halo's value is its year's).
fn drawn_entry_gaps(legend: &J, entries: &[(String, String)], d: &Drawn) -> Vec<String> {
    let known = match drawn_vars(legend.g("draws"), d) {
        Ok(k) => k,
        Err(e) => return vec![format!("what its layer draws: {e}")],
    };
    let mut bound = BTreeMap::new();
    let mut out = Vec::new();
    // an entry tied to what the layer draws binds the values it shares first (the halo's {code} by its value, then its name)
    let mut entries: Vec<&(String, String)> = entries.iter().collect();
    entries.sort_by_key(|(ph, _)| !template_vars(&st(legend.g("entries").g(ph))).iter().any(|v| known.contains_key(v)));
    for (ph, src) in entries {
        let template = st(legend.g("entries").g(ph));
        if !src_is(src, &template, &known, &mut bound) {
            let want = known.iter().fold(template.clone(), |t, (k, v)| t.replace(&format!("{{{k}}}"), v));
            out.push(format!("{{{ph}}} is the entry {src}, and its layer draws {want}"));
            continue;
        }
        let Some(key) = src.strip_prefix("fact:") else { continue };
        let (Some(time), key) = (known.get("time"), key.strip_suffix(".n").or(key.strip_suffix(".t")).unwrap_or(key)) else { continue };
        let reads = d.reads.get(key).map(Vec::as_slice).unwrap_or_default();
        let at = |r: &String| r.strip_prefix("series:").and_then(|r| r.rsplit(':').nth(1)) == Some(time.as_str());
        if reads.is_empty() || !reads.iter().all(at) {
            out.push(format!("{{{ph}}} is the fact {key}, which reads {reads:?}, not its layer's {time}"));
        }
    }
    out
}

/// The element of `html` whose opening tag starts at `open`: (its name, where its body starts, where its closing tag
/// starts), elements of the same name inside it counted; none when it does not close.
fn element_at(html: &str, open: usize) -> Option<(String, usize, usize)> {
    let name: String = html[open + 1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if name.is_empty() {
        return None;
    }
    let body = open + html[open..].find('>')? + 1;
    let (mut depth, mut i) = (1usize, body);
    loop {
        let next = html[i..].find('<')? + i;
        let tag = &html[next + 1..];
        if tag.strip_prefix('/').is_some_and(|t| t.starts_with(&name) && t[name.len()..].starts_with('>')) {
            depth -= 1;
            if depth == 0 {
                return Some((name, body, next));
            }
        } else if tag.starts_with(&name) && tag[name.len()..].starts_with([' ', '>']) {
            depth += 1;
        }
        i = next + 1;
    }
}

/// One piece of a legend line's body: its own text, or a child element with the data-src its opening tag names.
enum Piece {
    Text(String),
    Entry(String),
}

/// A legend line's body as the reader reads it: its text between its child elements, each child an entry (the data-src of
/// its opening tag; a child with none, or a tag left open, is no legend line).
fn pieces(html: &str, from: usize, to: usize) -> Option<Vec<Piece>> {
    let mut out = Vec::new();
    let mut i = from;
    while i < to {
        match html[i..to].find('<') {
            None => {
                out.push(Piece::Text(html[i..to].to_string()));
                break;
            }
            Some(0) => {
                let (_, body, close) = element_at(html, i)?;
                let tag = &html[i..body];
                let src = tag.split("data-src=\"").nth(1)?.split('"').next()?.to_string();
                out.push(Piece::Entry(src));
                i = close + html[close..].find('>')? + 1;
            }
            Some(n) => {
                out.push(Piece::Text(html[i..i + n].to_string()));
                i += n;
            }
        }
    }
    Some(out)
}

/// Whether a legend line's pieces are the registry's word: its literal parts the line's text exactly, each placeholder
/// filled as the registry's legend says (fills: `period`, `fact`, `name`: one entry of that kind; `fact_unit`: such an
/// entry, then the unit of a page format; `unit`: the unit of a page format as text). A page format's unit is its suffix
/// less its spaces.
fn is_the_word(pieces: &[Piece], template: &str, fills: &J, units: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut entries = Vec::new();
    let mut text = String::new();
    let mut rest = pieces.iter();
    let all: Vec<(bool, String)> = template
        .split('{')
        .enumerate()
        .flat_map(|(i, p)| {
            let (ph, lit) = if i == 0 { ("", p) } else { p.split_once('}').unwrap_or((p, "")) };
            [(true, ph.to_string()), (false, lit.to_string())]
        })
        .collect();
    let next_text = |text: &mut String, rest: &mut std::slice::Iter<Piece>| {
        while text.is_empty() {
            match rest.as_slice().first() {
                Some(Piece::Text(t)) => {
                    text.push_str(t);
                    rest.next();
                }
                _ => break,
            }
        }
    };
    let take_unit = |text: &mut String, upto: Option<&str>| -> Result<(), String> {
        let end = upto.filter(|l| !l.is_empty()).and_then(|l| text.find(l)).unwrap_or(text.len());
        let u = text[..end].trim().to_string();
        if !units.contains(&u) {
            return Err(format!("{u:?} is the unit of no format of the page"));
        }
        text.replace_range(..end, "");
        Ok(())
    };
    for (n, (is_ph, s)) in all.iter().enumerate() {
        if !is_ph {
            next_text(&mut text, &mut rest);
            if !text.starts_with(s.as_str()) {
                return Err(format!("the line reads {text:?} where the word has {s:?}"));
            }
            text.replace_range(..s.len(), "");
            continue;
        }
        if s.is_empty() {
            continue;
        }
        let kind = fills.g(s).s().ok_or_else(|| format!("the legend names no fill for {{{s}}}"))?;
        let following = all.get(n + 1).map(|(_, l)| l.as_str());
        if kind == "unit" {
            next_text(&mut text, &mut rest);
            take_unit(&mut text, following)?;
            continue;
        }
        if !text.trim().is_empty() {
            return Err(format!("the line reads {text:?} where the word has {{{s}}}"));
        }
        text.clear();
        let want = kind.strip_suffix("_unit").unwrap_or(kind);
        match rest.next() {
            Some(Piece::Entry(src)) if src.starts_with(&format!("{want}:")) => entries.push((s.clone(), src.clone())),
            Some(Piece::Entry(src)) => return Err(format!("{{{s}}} is the entry {src}, not a {want}")),
            _ => return Err(format!("{{{s}}} is no entry of the page")),
        }
        if kind.ends_with("_unit") {
            next_text(&mut text, &mut rest);
            take_unit(&mut text, following)?;
        }
    }
    next_text(&mut text, &mut rest);
    if !text.trim().is_empty() || rest.next().is_some() {
        return Err(format!("the line holds more than the word ({text:?})"));
    }
    Ok(entries)
}

/// What a published page of `recipe` lacks of its references' legend lines (owner 11-03 14:43): each reference
/// (recipe_roles) prints its legend line in an element marked `data-word="<word>"` that sits inside the legend it names
/// (legend.within: an element marked `data-legend="<within>"`), and whose text is the registry's word (the word table's
/// entry) exactly, each placeholder filled as legend.fills says from the page's entries, whose own text the page check
/// holds to the ledger, and each of those entries the one its layer draws (drawn_entry_gaps over `drawn`: what the page's
/// layers were given; none, a gap). `units`: the units of the page's formats. A registry the roles cannot be read from is
/// one gap; one that names no main chart at all is a prototype fixture's (as registry_lint reads it: the registry in
/// force names one per recipe, a test holds it) and asks for no line.
pub(crate) fn reference_legend_gaps(reg: &J, recipe: &str, html: &str, units: &[String], drawn: Option<&Drawn>) -> Vec<String> {
    if !reg.has("main_chart") {
        return Vec::new();
    }
    let refs = match recipe_roles(reg, recipe) {
        Err(e) => return vec![format!("roles: {e}")],
        Ok((_, refs)) => refs,
    };
    let mut out = Vec::new();
    for (what, word) in refs {
        let legend = reference_legend(reg, recipe, &what);
        out.extend(legend_line_gaps(&what, "is drawn as a reference", &word, &legend, html, units, drawn));
    }
    out
}

/// What a page lacks of one legend line the registry gives (a reference's, a time split's): the line marked
/// `data-word="<word>"` inside the legend legend.within names (`data-legend`), its text the word with each placeholder
/// filled as legend.fills says, each entry the one its layer draws (drawn_entry_gaps). `why`: what the layer does that
/// the line says.
fn legend_line_gaps(what: &str, why: &str, word: &str, legend: &J, html: &str, units: &[String], drawn: Option<&Drawn>) -> Vec<String> {
    let mut out = Vec::new();
    let within = st(legend.g("within"));
    // the legend it names, and the line inside it
    let line = html.match_indices(&format!("data-legend=\"{within}\"")).find_map(|(at, _)| {
        let (_, body, close) = element_at(html, html[..at].rfind('<')?)?;
        let mark = html[body..close].find(&format!("data-word=\"{word}\""))? + body;
        let open = html[..mark].rfind('<')?;
        let (_, lb, lc) = element_at(html, open)?;
        Some((lb, lc))
    });
    let Some((lb, lc)) = line else {
        let anywhere = html.contains(&format!("data-word=\"{word}\""));
        out.push(match anywhere {
            true => format!("roles: {what}'s legend line data-word={word} sits outside the legend data-legend={within}"),
            false => format!("roles: {what} {why} and its legend data-legend={within} prints no line data-word={word}"),
        });
        return out;
    };
    let template = crate::next_ledger::word_table().get(word).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let said = pieces(html, lb, lc).ok_or_else(|| "a child element names no data-src".to_string()).and_then(|p| is_the_word(&p, &template, legend.g("fills"), units));
    match (said, drawn) {
        (Err(e), _) => out.push(format!("roles: {what}'s legend line is not the registry's word {word} ({template:?}): {e}")),
        (Ok(_), None) => out.push(format!("roles: {what}'s legend line: the page gives no knobs to read what its layer draws")),
        (Ok(entries), Some(d)) => {
            out.extend(drawn_entry_gaps(legend, &entries, d).into_iter().map(|e| format!("roles: {what}'s legend line {word}: {e}")))
        }
    }
    out
}

/// The opacity at or above which a drawn piece is not faded.
const UNFADED: f64 = 1.0;

/// What a published page of `recipe` lacks of its time splits (owner 11-03): each node of the recipe that registers
/// split.<recipe> ({months: the layer, legend}) draws its months as pieces marked `data-ms` (the months, space-separated),
/// each piece faded (its fill-opacity below 1) exactly when its months fall outside the years legend.draws names (from,
/// to), no piece holding months of both, no month in two pieces; when a piece is faded, the legend line names the years
/// (legend_line_gaps). A page with no knobs to read the years from is one gap.
pub(crate) fn split_gaps(reg: &J, recipe: &str, html: &str, units: &[String], drawn: Option<&Drawn>) -> Vec<String> {
    let mut out = Vec::new();
    for layer in reg.g("recipes").g(recipe).arr().iter().map(st) {
        let Some(split) = reg.g("nodes").g(&layer).g("split").get(recipe) else { continue };
        let legend = split.g("legend");
        let Some(d) = drawn else {
            out.push(format!("split: {layer}: the page gives no knobs to read the years its months are split by"));
            continue;
        };
        let years = match drawn_vars(&J::obj_of(vec![("from", legend.g("draws").g("from").clone()), ("to", legend.g("draws").g("to").clone())]), d) {
            Ok(y) => y,
            Err(e) => {
                out.push(format!("split: {layer}: {e}"));
                continue;
            }
        };
        let (from, to) = (years["from"].clone(), years["to"].clone());
        let (mut seen, mut faded_any) = (BTreeSet::new(), false);
        for (at, _) in html.match_indices("data-ms=\"") {
            let Some(open) = html[..at].rfind('<') else { continue };
            let tag = &html[open..open + html[open..].find('>').unwrap_or(0)];
            let months: Vec<&str> = html[at + 9..].split('"').next().unwrap_or("").split_whitespace().collect();
            let opacity = tag.split("fill-opacity=\"").nth(1).and_then(|v| v.split('"').next()).map_or(Some(UNFADED), |v| v.parse::<f64>().ok());
            let faded = opacity.is_some_and(|o| o < UNFADED);
            let inside = |m: &str| m.get(..4).is_some_and(|y| from.as_str() <= y && y <= to.as_str());
            let inn = months.iter().filter(|m| inside(m)).count();
            let outside = months.len() - inn;
            if opacity.is_none() {
                out.push(format!("split: {layer}: a piece's fill-opacity is no number"));
            } else if inn > 0 && outside > 0 {
                out.push(format!("split: {layer}: a piece holds months inside {from}..{to} and outside them"));
            } else if faded != (outside > 0) {
                let say = if faded { "faded" } else { "drawn as the band is" };
                out.push(format!("split: {layer}: months {}..{} are {say}, and the years are {from}..{to}", months.first().unwrap_or(&""), months.last().unwrap_or(&"")));
            }
            for m in months {
                if !seen.insert(m.to_string()) {
                    out.push(format!("split: {layer}: month {m} is in two pieces"));
                }
            }
            faded_any |= faded;
        }
        if faded_any {
            let word = st(legend.g("word"));
            out.extend(legend_line_gaps(&layer, "fades its months outside the headline's years", &word, legend, html, units, drawn));
        }
    }
    out
}

/// A reference's legend as the registry declares it (roles.<recipe> of the layer, or its parts.<part>).
fn reference_legend(reg: &J, recipe: &str, what: &str) -> J {
    let (layer, part) = what.split_once('.').map_or((what, None), |(l, p)| (l, Some(p)));
    let roles = reg.g("nodes").g(layer).g("roles").g(recipe);
    match part {
        Some(p) => roles.g("parts").g(p).g("legend").clone(),
        None => roles.g("legend").clone(),
    }
}

/// The core's own reading of a flow's registry lists (registry_list), for the tests that hold it to the flow's.
#[cfg(test)]
pub(crate) fn registry_list_for_test(registry: &str) -> Option<Result<J, String>> {
    registry_list(registry)
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
    // a printed difference is the difference of the two values as the page prints them (differences_disagree): what the
    // page prints read from it less its facts
    let shown = printed_keys(&J::Obj(rpage.obj().iter().filter(|(k, _)| k != "facts").cloned().collect()), facts);
    bad.extend(differences_disagree(facts, rpage.g("facts").g("fmts"), rows, &shown).into_iter().map(|(e, _)| e));
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
            // from_above: a change only from a value the map reads (text_num) above it at the time the change runs
            // from, as the map declares a change; a code without both ends read so is left out, never refused.
            // positive: only the codes whose key is above 0
            let above = s.g("from_above").num();
            let mut keyed: Vec<(f64, String, &J)> = Vec::new();
            // numbers_only: a row whose value is no number (as the map reads one) is left out, never refused
            let lenient = above.is_some() || s.g("numbers_only").truthy();
            for r in at {
                let mut v = match lenient {
                    true => match text_num(r) {
                        Some(v) => v,
                        None => continue,
                    },
                    false => num(r)?,
                };
                if let Some(ps) = part_share_key(s) {
                    match part_share_of(ps, by, q.g("time"), dims(r, by), v) {
                        Some(share) => v = share,
                        None => continue,
                    }
                }
                if let Some(t0) = change_from(s) {
                    let c = dims(r, by);
                    let from: Vec<&J> = select_rows(rows, q).into_iter().filter(|x| x.g("time") == t0 && dims(x, by) == c).collect();
                    match (above, &from[..]) {
                        (Some(th), from) => match (from.iter().any(|x| text_num(x).is_some_and(|v0| v0 > th)), from.first().and_then(|x| text_num(x))) {
                            (true, Some(v0)) => v -= v0,
                            _ => continue,
                        },
                        (None, [r0]) => v -= num(r0)?,
                        (None, _) => {
                            bad.push(format!("rank {id}: {} has {} rows at {}, the change needs one", st(c), from.len(), st(t0)));
                            got.insert(id.into(), s0.g("result").clone());
                            return Ok(());
                        }
                    }
                }
                if s.g("positive").truthy() && v <= 0.0 {
                    continue;
                }
                keyed.push((if desc { -v } else { v }, st(dims(r, by)), r));
            }
            let pos = |c: &str| only.arr().iter().position(|x| x.s() == Some(c));
            let last = last_in_only(s);
            keyed.sort_by(|a, b| {
                let tie = if last { pos(&b.1).cmp(&pos(&a.1)) } else { a.1.cmp(&b.1) };
                a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(tie)
            });
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
            let by = tie.g("by").s();
            // the pick against each place beside it in the list (first and last have one, the second has two: the first and
            // the third), silent when it prints as either does
            let at_i = if i < 0 { n + i } else { i };
            let beside: Vec<&J> = [at_i - 1, at_i + 1].iter().filter(|&&k| 0 <= k && k < n).map(|&k| &src[k as usize]).collect();
            for nb in beside.into_iter().filter(|_| !pick.is_null() && matches!(by, Some("printed" | "value")) && src.len() > 1) {
                let (a, b) = (take_value(sel, &from, &pick, rows)?, take_value(sel, &from, nb, rows)?);
                let alike = match by {
                    // by value: the two keys are one number
                    Some("value") => a == b,
                    // printed: as the page's format prints them (its decimals and scale) or as the tie states them (dec,
                    // scale); a format the page lacks prints whole when the tie says so (missing: whole), else refuses
                    _ => {
                        let fm = f.g("fmts").g(&st(tie.g("fmt")));
                        let whole = tie.g("missing").s() == Some("whole");
                        let at: Option<(usize, f64)> = if tie.has("dec") {
                            Some((tie.g("dec").num().ok_or("tie dec")? as usize, tie.get("scale").map_or(Ok(1.0), |x| x.num().ok_or("tie scale"))?))
                        } else if whole && fm.is_null() {
                            None
                        } else if whole {
                            Some((fm.g("dec").num().unwrap_or(0.0) as usize, fm.g("scale").num().unwrap_or(1.0)))
                        } else {
                            let dec = fm.g("dec").num().ok_or_else(|| format!("tie fmt {}: no dec", st(tie.g("fmt"))))? as usize;
                            Some((dec, fm.get("scale").map_or(Ok(1.0), |x| x.num().ok_or("scale"))?))
                        };
                        let pr = |v: f64| at.map_or_else(|| v.to_string(), |(dec, scale)| py_fixed(v * scale, dec));
                        pr(a) == pr(b)
                    }
                };
                if alike {
                    pick = J::Null;
                    break;
                }
            }
            same(bad, format!("select {id} (take)"), s.g("result"), &pick);
            got.insert(id.into(), pick);
        }
        "given" | "named_rule" => {
            got.insert(id.into(), s.g("result").clone());
        }
        "registry_list" => {
            // a flow's registry lists read again: a list the page was handed that is not the registry's is refused. Another
            // registry (composition_groups) is taken as handed, as before 11-03: the core reads only the flow's two
            match registry_list(&st(s.g("registry"))) {
                Some(Ok(want)) => same(bad, format!("select {id} (registry_list {})", st(s.g("registry"))), s.g("result"), &want),
                Some(Err(e)) => bad.push(format!("select {id} (registry_list): {e}")),
                None => {}
            }
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
        // the codes of `by` among the rows at the table and time that hold every `with` dimension, in row order (held_codes:
        // all of them; group_sum: those with a row whose value is not 0, in the order of each one's first such row)
        "held_codes" | "group_sum" => {
            let at = pair_rows(rows, s);
            let by = st(s.g("by"));
            let mut have: Vec<J> = Vec::new();
            for r in at.iter().filter(|r| kind == "held_codes" || text_num(r) != Some(0.0)) {
                if !have.contains(dims(r, &by)) {
                    have.push(dims(r, &by).clone());
                }
            }
            same(bad, format!("select {id} ({kind})"), s.g("result"), &J::Arr(have.clone()));
            got.insert(id.into(), J::Arr(have));
        }
        // share_merge: the codes of a group_sum (`from`, in its order) whose rows' sum is under `share` of all the rows'
        // sum, none when fewer than `min_count` are
        "share_merge" => {
            let at = pair_rows(rows, s);
            let by = st(s.g("by"));
            let share = s.g("share").num().ok_or("'share'")?;
            let total: f64 = at.iter().map(|r| text_num(r).unwrap_or(0.0)).sum();
            let mut sums: Vec<(J, f64)> = Vec::new();
            for r in at.iter().filter(|r| text_num(r) != Some(0.0)) {
                let v = text_num(r).unwrap_or(0.0);
                match sums.iter().position(|(c, _)| c == dims(r, &by)) {
                    Some(i) => sums[i].1 += v,
                    None => sums.push((dims(r, &by).clone(), v)),
                }
            }
            let from = got.get(&st(s.g("from"))).cloned().unwrap_or(J::Arr(vec![]));
            let small: Vec<J> = from.arr().iter().filter(|c| sums.iter().any(|(x, v)| x == *c && *v / total < share)).cloned().collect();
            let min = s.g("min_count").num().unwrap_or(2.0) as usize;
            let have = J::Arr(if small.len() >= min { small } else { Vec::new() });
            same(bad, format!("select {id} (share_merge)"), s.g("result"), &have);
            got.insert(id.into(), have);
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
    // a count of the places the page draws (四国 on a page of four) is the data's own count (user 11-07)
    let places = places_drawn(page, page.g("facts").g("rows").arr());
    for (path, v) in walk(page, "$") {
        if v.g("kind").s() != Some("Text") {
            continue;
        }
        let (mut chars, mut held) = (Vec::new(), Vec::new());
        for r in v.g("runs").arr() {
            // a term run is a word of the digit lists (user 11-08 item 4), read as the literal it prints
            if let Some(t) = r.get("term") {
                let t = st(t);
                if !digit_terms().contains(&t) {
                    errs.push(format!("{path}: term {} is no word of number-free-words.json with a digit", J::str(&t).repr()));
                }
                chars.extend(t.chars());
                held.extend(t.chars().map(|_| false));
                continue;
            }
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
        let free = number_free(&chars, &held);
        let counted = place_count(&chars, &held, places);
        chars.iter_mut().zip(free.into_iter().zip(counted)).filter(|(_, (f, n))| *f || *n).for_each(|(c, _)| *c = ' ');
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
    // the page's recipe: its main chart and its references as the registry gives them (recipe_roles); a registry that
    // names no main chart at all is a prototype fixture's (the one in force names one per recipe, a test holds it)
    if let (Some(recipe), true) = (page.g("recipe").s(), reg.has("main_chart")) {
        if let Err(e) = recipe_roles(reg, recipe) {
            errs.push(format!("registry: {e}"));
        }
    }
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
/// Checks a later core step computes (the text step, the flow's shape and its pair accounting); any other kind not evaluated
/// here is refused (R11).
const LATER: [(&str, &str); 4] = [
    ("unit_short", "the text step (next_pack.rs unit_short)"),
    ("finding_words", "the finding node (node-bindings.json finding; next_tree_gen.rs finding_declared, rechecked at draw)"),
    ("has_flow", "the flow's shape condition (next_run.rs official_flow)"),
    ("pairs_accounted", "the flow's pair accounting and its page checks (next_run.rs flow_pairs_of)"),
];
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
pub(crate) fn fact_rows<'a>(q: &J, rows: &'a [J]) -> Vec<&'a J> {
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
/// K4 (P4a-2) holds a map's r_max knob under it too: a registry may only be stricter.
pub const RADIUS_PX_MAX: f64 = 28.0;
/// K4: the grid the circles' radius scale r_used steps down on, from the registry's r_max: R_STEP_PX at a time, down to
/// R_FLOOR_PX (the leaf's r_max knob floor and step, bubbles.py); the core's, no registry sets them.
pub const R_FLOOR_PX: f64 = 12.0;
pub const R_STEP_PX: f64 = 2.0;
/// K4: the range of the radius a small circle is lifted to (the r_min knob's range).
pub const R_MIN_PX: (f64, f64) = (2.0, 8.0);
/// K5: the farthest a circle may be moved off its place's point (the nudge knob's maximum).
pub const NUDGE_PX_MAX: f64 = 16.0;
/// K8: the longest leader from a circle's edge to its label (the reach knob's maximum).
pub const REACH_PX_MAX: f64 = 200.0;
/// K6: the most pairs of circles that may overlap by over half the smaller one (the max_overlaps knob's maximum).
pub const OVERLAPS_MAX: f64 = 20.0;
/// K8: the least room a label keeps from every circle and dot (label_gap's minimum) and from another label (label_sep's).
pub const GAP_PX_MIN: f64 = 1.0;
pub const SEP_PX_MIN: f64 = 2.0;
/// K5: the dot a circle moved off its point keeps at the point (radius), and how far it must have moved to keep one.
pub const DOT_R_PX: f64 = 1.6;
const DOT_OVER_PX: f64 = 0.5;
const CHECK_KINDS: [&str; 16] = [
    "count_equals", "points_pinned", "named", "one_name", "tolerance_fixed", "ranks_some", "one_row_per_code", "max_dropped",
    "fill_after_drop", "has_composition", "row_exists", "page_check", "unit_short", "finding_words", "has_flow", "pairs_accounted",
];
/// Value-determined geometry: channel -> (the field tuples it decides, what it encodes, scale kind, domain source, range).
/// Every part of a scale is the core's; a registry may only add the declared constants (band padding, max radius).
/// A channel the core recomputes: (name, its field sets, what it encodes, scale kind, domain, range).
type Channel = (&'static str, &'static [&'static [&'static str]], &'static str, &'static str, &'static str, &'static str);
const CHANNELS: [Channel; 10] = [
    ("length_up", &[&["h", "y"]], "value", "linear", "zero_to_max", "plot.y"),
    // K11 (P4a-2, in place of K1): a bar from a zero line, its length the value's size over the span from the lowest (or 0)
    // to the highest (or 0), right of the line for a value of 0 or more, left of it below 0; on values of 0 or more it is
    // K1's bar from the plot's left edge, bit for bit
    ("length_signed", &[&["x", "w"]], "value", "linear", "lo0_to_hi0", "plot.x"),
    // K2 (P4a): one row per item down a rows frame, the mark inset from its row's top and bottom
    ("rows_y", &[&["y", "h"]], "item", "rows", "items", "plot.y"),
    ("band_x", &[&["x", "w"]], "item", "band", "items", "plot.x"),
    ("band_y", &[&["y", "h"]], "item", "band", "items", "plot.y"),
    ("radius_area", &[&["r"]], "value", "sqrt", "zero_to_max", "max_px"),
    ("point", &[&["cx", "cy"], &["x2", "y2"]], "at", "mercator", "ext", "plot"),
    // K3 (P4a-2): a place's point as the map leaves project it (mapkit.View over the page's extent, the frame's width)
    ("point", &[&["cx", "cy"]], "at", "view", "ext", "plot"),
    // K4 (P4a-2): r = max(r_min, r_used * sqrt(v / vmax)), r_used the largest circle's, on the core's grid under r_max
    ("radius_floor", &[&["r"]], "value", "sqrt", "zero_to_max", "r_max"),
    ("stack_x", &[&["x", "w"]], "share", "linear", "zero_to_one", "plot.x"),
];
const FIELD_KINDS: [&str; 9] =
    ["select_index", "row_of_code", "row_of_code_from", "fact_template", "code_is", "point_of_code", "cells_by_part", "fact_per_part", "first_holding"];
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

/// K2: a frame of kind "rows" (one row per item, top down, the plot between a text column on each side) names every number
/// the core lays it out by, and the two texts that size its columns are texts of the node; a channel rows_y needs such a
/// frame, and a frame of any other kind is one the core cannot lay out.
fn rows_frame_problem(fr: &J, e: &J) -> Option<String> {
    let rows_y = e.g("marks").g("encode").arr().iter().any(|c| c.g("channel").s() == Some("rows_y"));
    match fr.get("kind") {
        None if rows_y => Some("channel rows_y needs a frame of kind rows".into()),
        None => None,
        // K3 (P4a-2): a map view, the core's projection over the page's extent at the frame's width, its land inset px in
        Some(k) if k.s() == Some("view") && !rows_y => {
            let ok = matches!(fr.g("w"), J::Int(x) if *x > 0) && matches!(fr.g("inset"), J::Int(x) if *x >= 0);
            (!ok).then(|| "a view frame needs a whole w above 0 and a whole inset".into())
        }
        Some(k) if k.s() != Some("rows") => Some(format!("kind {}: not one the core lays out", k.repr())),
        Some(_) => {
            let whole = ["w", "top", "row", "inset", "foot"].iter().all(|f| matches!(fr.g(f), J::Int(x) if *x >= 0));
            let side = |s: &str| fr.g(s).g("gap").finite() && fr.g(s).g("text").s().is_some_and(|t| e.g("texts").g("item").has(t));
            let ok = whole && side("left") && side("right") && fr.g("inset").num().unwrap_or(0.0) * 2.0 < fr.g("row").num().unwrap_or(0.0);
            (!ok).then(|| "a rows frame needs whole w, top, row, inset (under half a row) and foot, and a left and right text of the node".into())
        }
    }
}

/// The knobs a map circles node is laid out by (the registry's `knobs`, the values the core sends), each a number.
const CIRCLE_KNOBS: [&str; 10] = [
    "r_max",
    "r_min",
    "nudge",
    "circle_gap",
    "max_overlaps",
    "label_top",
    "label_gap",
    "label_sep",
    "reach",
    "land_cost",
];

/// Every map circles knob past the core's own bound (K4-K8, design 4.1): the registry's at load (C5) and a request's before
/// its reply is read (B0), by the same rule, so a second layer that widens its knob ranges cannot widen a core check. `k`
/// gives a knob's value by its registry name; a missing or non-number knob is out of bounds.
fn circle_bound_problems(at: &str, k: &dyn Fn(&str) -> Option<f64>) -> Vec<String> {
    let mut bad = Vec::new();
    let mut need = |name: &str, ok: &dyn Fn(f64) -> bool, why: String| match k(name) {
        Some(v) if v.is_finite() && ok(v) => {}
        v => bad.push(format!(
            "{at} {name} {}: {why}",
            v.map_or("none".into(), py_float)
        )),
    };
    need(
        "r_max",
        &|v| (R_FLOOR_PX..=RADIUS_PX_MAX).contains(&v) && (v - R_FLOOR_PX) % R_STEP_PX == 0.0,
        format!(
        "outside [{}, RADIUS_PX_MAX {}] on the core's {} px grid; a registry may only be stricter",
        py_float(R_FLOOR_PX),
        py_float(RADIUS_PX_MAX),
        py_float(R_STEP_PX)
    ),
    );
    need(
        "r_min",
        &|v| (R_MIN_PX.0..=R_MIN_PX.1).contains(&v),
        format!(
            "outside [{}, {}]",
            py_float(R_MIN_PX.0),
            py_float(R_MIN_PX.1)
        ),
    );
    need(
        "max_overlaps",
        &|v| (0.0..=OVERLAPS_MAX).contains(&v) && v.fract() == 0.0,
        format!("over OVERLAPS_MAX {}", py_float(OVERLAPS_MAX)),
    );
    need(
        "nudge",
        &|v| (0.0..=NUDGE_PX_MAX).contains(&v),
        format!("over NUDGE_PX_MAX {}", py_float(NUDGE_PX_MAX)),
    );
    need(
        "reach",
        &|v| (0.0..=REACH_PX_MAX).contains(&v),
        format!("over REACH_PX_MAX {}", py_float(REACH_PX_MAX)),
    );
    need(
        "label_gap",
        &|v| v >= GAP_PX_MIN,
        format!("under GAP_PX_MIN {}", py_float(GAP_PX_MIN)),
    );
    need(
        "label_sep",
        &|v| v >= SEP_PX_MIN,
        format!("under SEP_PX_MIN {}", py_float(SEP_PX_MIN)),
    );
    need("circle_gap", &|v| v >= 0.0, "below 0".into());
    need(
        "label_top",
        &|v| v >= 0.0 && v.fract() == 0.0,
        "not a whole count".into(),
    );
    need("land_cost", &|v| v >= 0.0, "below 0".into());
    bad
}

/// C5 for a map circles node (a frame of kind view): the rules it names are the ones the core computes (K5 pinned_within,
/// K6 overlap_pairs, K7 ends_then_largest, K9 dropped_listed), its marks in value order, and its knobs within the core's
/// own bounds.
fn circles_registry_problems(p: &str, e: &J) -> Vec<String> {
    let mut out = Vec::new();
    let m = e.g("marks");
    let want = [
        (m.g("order"), J::str("value_desc_stable"), "marks.order"),
        (
            m.g("moved"),
            J::obj_of(vec![
                ("rule", J::str("pinned_within")),
                ("most", J::str("nudge")),
            ]),
            "marks.moved",
        ),
        (
            m.g("overlap"),
            J::obj_of(vec![
                ("rule", J::str("overlap_pairs")),
                ("max", J::str("max_overlaps")),
            ]),
            "marks.overlap",
        ),
        (
            e.g("texts").g("subset"),
            J::obj_of(vec![
                ("rule", J::str("ends_then_largest")),
                ("top", J::str("label_top")),
            ]),
            "texts.subset",
        ),
        (
            e.g("texts").g("drop"),
            J::obj_of(vec![("rule", J::str("dropped_listed"))]),
            "texts.drop",
        ),
    ];
    for (have, want, what) in want {
        if *have != want {
            out.push(format!(
                "{p} {what} {}: the core computes only {}",
                have.repr(),
                want.repr()
            ));
        }
    }
    let item: Vec<&str> = e
        .g("texts")
        .g("item")
        .obj()
        .iter()
        .map(|(k, _)| k.as_str())
        .collect();
    if item != ["label"] {
        out.push(format!(
            "{p} texts.item {}: a map circle carries one label",
            J::strs(&item).repr()
        ));
    }
    let knobs = e.g("knobs");
    let extra: Vec<&str> = knobs
        .obj()
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !CIRCLE_KNOBS.contains(k))
        .collect();
    if !extra.is_empty() {
        out.push(format!(
            "{p} knobs {}: not knobs the core lays the circles out by",
            J::strs(&extra).repr()
        ));
    }
    out.extend(circle_bound_problems(&format!("{p} knobs"), &|k| {
        knobs.g(k).num()
    }));
    out
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
    // a node that eats another's data shape (declares_as: that node, a picture of the same rows) is declared and checked
    // as that node is: every field of its entry the node does not set itself, its pinned checks among them, never fewer
    let inherit: Vec<(String, String)> =
        nodes.obj().iter().filter_map(|(k, v)| v.g("declares_as").s().map(|of| (k.clone(), of.to_string()))).collect();
    for (k, of) in inherit {
        let from = nodes.g(&of).clone();
        let e = nodes.get_mut(&k).expect("listed above");
        for (f, x) in from.obj() {
            if !e.has(f) {
                e.set(f, x.clone());
            }
        }
    }
    reg.set("nodes", nodes);
    // the pick rules the page tree generator writes as selects (next_tree_gen): data the core itself does not read
    if let Some(picks) = overlay.get("picks") {
        reg.set("picks", picks.clone());
    }
    // each recipe's layers and main chart, which the roles' checks read (recipe_roles)
    for k in ["recipes", "main_chart"] {
        if let Some(v) = overlay.get(k) {
            reg.set(k, v.clone());
        }
    }
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
        out.extend(registry_scale_problems(name, e, palettes()));
        if let Some(sid) = e.g("marks").g("paint").g("scale").s() {
            if e.g("marks").g("per").s() != Some("item") {
                out.push(format!("{p} marks.paint: scale {sid} paints one mark per item"));
            }
            let lg = reg.g("frames").g(&st(e.g("frame"))).g("legend");
            if lg.arr().len() != 2 || !lg.arr().iter().all(J::finite) {
                out.push(format!("{p} frame {}: a node painted by scale {sid} needs the legend's place [x, y] in its frame", e.g("frame").repr()));
            }
        }
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
        // a node whose leaf lays itself out (geometry leaf) is asked for no geometry: it has no frame, items or marks here
        if e.g("geometry").s() == Some("leaf") {
            continue;
        }
        if !e.g("frame").s().is_some_and(|f| reg.g("frames").has(f)) {
            out.push(format!("{p} frame {}: not a registered frame", e.g("frame").repr()));
        }
        if let Some(why) = rows_frame_problem(reg.g("frames").g(&st(e.g("frame"))), e) {
            out.push(format!("{p} frame {}: {why}", e.g("frame").repr()));
        }        let it = e.g("items");
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
            let ok = CHANNELS.iter().filter(|c| ch.g("channel").s() == Some(c.0)).any(|(_, ftuples, of, kind, domain, range)| {
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
        let view = reg.g("frames").g(&st(e.g("frame"))).g("kind").s() == Some("view");
        if view {
            out.extend(circles_registry_problems(&p, e));
        }
        for (f, rel) in e.g("texts").g("item").obj() {
            let ok = matches!(rel.g("near").s(), Some("item" | "part")) && matches!(rel.g("from").s(), Some("anchor" | "box")) && rel.g("max_px").finite();
            // K2 (P4a-2): a text at its row's start in a rows frame (the left column's right edge, gap_px before it), its
            // place the core's own: a closer check than near
            let row_left = rel.g("row").s() == Some("left")
                && rel.obj().len() == 2
                && rel.g("gap_px").num().is_some_and(|g| g > 0.0 && g <= MAX_PX_MAX)
                && reg.g("frames").g(&st(e.g("frame"))).g("kind").s() == Some("rows")
                && reg.g("frames").g(&st(e.g("frame"))).g("left").g("text").s() == Some(f.as_str());
            // K8 (P4a-2): a map circle's label beside it or at a leader's end, by the knobs the core bounds
            let beside = view && rel == &J::obj_of(vec![("place", J::str("beside_or_leader"))]);
            if row_left || beside {
                continue;
            }
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

/// The scale kinds, cut rules and paint roles the core recomputes (batch 1: a threshold scale of a value).
const SCALE_KINDS: [&str; 1] = ["threshold"];
const CUT_RULES: [&str; 2] = ["quantile", "facts"];
const PAINT_ROLES: [&str; 2] = ["base", "accent"];

/// C5 for a node's scales and paint: a threshold scale of the value with cuts the core computes (quantile k, or 2..8
/// facts) and a palette of the palette file; paint one {scale} of the entry or one {role}; no literal colour anywhere.
fn registry_scale_problems(name: &str, e: &J, pf: &J) -> Vec<String> {
    let p = format!("C5 registry {name}");
    let mut out = Vec::new();
    for (path, x) in walk(e, "$") {
        if x.s().is_some_and(colour_literal) {
            out.push(format!("{p} {path}: a literal colour {}; colours come only from the palette file", x.repr()));
        }
    }
    let scales = e.g("scales");
    let sorted_keys = |o: &J| {
        let mut k: Vec<String> = o.obj().iter().map(|(k, _)| k.clone()).collect();
        k.sort();
        k
    };
    for (sid, sc) in scales.obj() {
        let q = format!("{p} scale {sid}");
        let mut want = vec!["cuts", "encodes", "kind", "no_data", "palette"];
        if sc.has("printed") {
            want.push("printed");
        }
        if !sc.is_obj() || sorted_keys(sc) != want {
            out.push(format!("{q}: fields {}; a threshold scale has kind, encodes, cuts, palette, no_data, printed", J::strs(&sorted_keys(sc)).repr()));
            continue;
        }
        if !sc.g("kind").s().is_some_and(|k| SCALE_KINDS.contains(&k)) || sc.g("encodes").s() != Some("value") || sc.g("no_data").s() != Some("nodata") {
            out.push(format!("{q}: kind/encodes/no_data {}/{}/{} not one the core recomputes", sc.g("kind").repr(), sc.g("encodes").repr(), sc.g("no_data").repr()));
        }
        if sc.has("printed") && !matches!(sc.g("printed"), J::Bool(_)) {
            out.push(format!("{q}: printed is true or false"));
        }
        let cu = sc.g("cuts");
        let rule = cu.g("rule").s();
        let from = cu.g("from").arr();
        if !cu.is_obj() || !rule.is_some_and(|r| CUT_RULES.contains(&r)) {
            out.push(format!("{q}: cuts {}: rule is quantile or facts", cu.repr()));
        } else if rule == Some("quantile") && (sorted_keys(cu) != ["k", "rule"] || !matches!(cu.g("k"), J::Int(k) if (K_MIN as i64..=K_MAX as i64).contains(k))) {
            out.push(format!("{q}: quantile cuts take one integer k in {K_MIN}..{K_MAX}"));
        } else if rule == Some("facts")
            && (sorted_keys(cu) != ["from", "rule"]
                || !cu.g("from").is_arr()
                || !(K_MIN - 1..=K_MAX - 1).contains(&from.len())
                || !from.iter().all(|r| r.s().is_some_and(|r| r.starts_with("fact:"))))
        {
            out.push(format!("{q}: facts cuts are {}..{} fact: references", K_MIN - 1, K_MAX - 1));
        }
        if !sc.g("palette").s().is_some_and(|x| pf.g("sequential").has(x)) {
            out.push(format!("{q}: palette {} is not in the palette file", sc.g("palette").repr()));
        }
    }
    if let Some(paint) = e.g("marks").get("paint") {
        let ok = paint.obj().len() == 1
            && (paint.g("scale").s().is_some_and(|s| scales.has(s)) || paint.g("role").s().is_some_and(|r| PAINT_ROLES.contains(&r)));
        if !ok {
            out.push(format!("{p} marks.paint {}: one {{scale: id}} of this entry or one {{role: base|accent}}", paint.repr()));
        }
    }
    out
}

/// The text colour the core prints on a painted mark: ink or white, whichever has the higher WCAG contrast.
fn ink_on<'p>(fill: &str, pf: &'p J) -> &'p str {
    let (ink, white) = (pf.g("roles").g("ink").s().unwrap_or(""), pf.g("roles").g("white").s().unwrap_or(""));
    if contrast(fill, ink) >= contrast(fill, white) { ink } else { white }
}

/// A painted mark under 3:1 on any page ground gets the edge outline (WCAG SC 1.4.11).
fn needs_edge(fill: &str, pf: &J) -> bool {
    pf.g("grounds").arr().iter().filter_map(J::s).any(|g| contrast(fill, g) < NONTEXT_MIN)
}

/// A number as printed with `dec` decimals, read back.
fn printed_value(v: f64, dec: usize) -> f64 {
    py_fixed(v, dec).parse().unwrap_or(v)
}

/// The scale's cuts, ascending. quantile: nearest rank on the classified values, cut j = the ceil(j n / k)-th (from 0)
/// of the sorted values, so every cut is a value of the data; equal cuts merge, a cut equal to the least value is dropped
/// (its class would be empty). facts: each cut a fact the core recomputes (`fact` resolves only the core's own facts),
/// strictly ascending. Fewer than K_MIN classes is refused.
fn cuts_of(sc: &J, values: &[f64], fact: &dyn Fn(&str) -> Result<f64, String>, dec: usize) -> Result<Vec<f64>, String> {
    let cu = sc.g("cuts");
    let mut cuts: Vec<f64> = Vec::new();
    if cu.g("rule").s() == Some("quantile") {
        let mut s = values.to_vec();
        s.sort_by(f64::total_cmp);
        let (n, k) = (s.len(), cu.g("k").num().unwrap_or(0.0) as usize);
        if n < k {
            return Err(format!("too_few_values: {n} values for {k} classes"));
        }
        for j in 1..k {
            let c = s[(j * n).div_ceil(k)];
            if c > s[0] && cuts.last().is_none_or(|l| c > *l) {
                cuts.push(c);
            }
        }
    } else {
        for r in cu.g("from").arr().iter().map(st) {
            let v = r.strip_prefix("fact:").and_then(|k| fact(k).ok()).filter(|v| v.is_finite());
            let v = v.ok_or_else(|| format!("cut {r}: not a fact the core resolves to a number"))?;
            cuts.push(if sc.g("printed").truthy() { printed_value(v, dec) } else { v });
        }
        if cuts.windows(2).any(|w| w[0] >= w[1] || w[0].is_nan()) {
            return Err(format!("cuts_not_ascending: [{}]", cuts.iter().map(|c| py_float(*c)).collect::<Vec<_>>().join(", ")));
        }
    }
    if cuts.len() + 1 < K_MIN {
        return Err(format!("too_few_classes: {} after equal cuts merge", cuts.len() + 1));
    }
    Ok(cuts)
}

/// The class of a value: the number of cuts at or below it (classes closed on the left; the top class holds the maximum).
fn bin_of(v: f64, cuts: &[f64]) -> usize {
    cuts.iter().filter(|c| **c <= v).count()
}

/// One mark a scale paints, as the core keeps it: its id, the value it classifies (None: no row or a null value; the
/// printed number when the scale prints), its focus, and the text it prints inside the mark: its id, words and source.
#[derive(Clone, Debug, Default)]
pub struct Cell {
    pub id: String,
    pub value: Option<f64>,
    pub focus: bool,
    pub text_id: Option<String>,
    pub text: Option<String>,
    pub src: Option<String>,
}

/// The core's record of a node painted by a scale: its cells, the cuts the core computed and their printed texts (the
/// cut facts `<sid>.cut.<j>`, j = 1..k-1), where the legend goes and the word it prints for no data. Rendering and the
/// page checks both start from this record and the palette file; nothing a renderer wrote is read back as truth.
#[derive(Clone, Debug, Default)]
pub struct Paint {
    pub sid: String,
    pub palette: String,
    pub cells: Vec<Cell>,
    pub cuts: Vec<f64>,
    pub cut_texts: Vec<String>,
    pub legend: (f64, f64),
    pub nodata_word: String,
}

impl Paint {
    fn new(sid: &str, sc: &J, cells: Vec<Cell>, cuts: Vec<f64>, dec: usize, legend: (f64, f64), nodata_word: String) -> Paint {
        let cut_texts = cuts.iter().map(|c| py_fixed(*c, dec)).collect();
        Paint { sid: sid.to_string(), palette: st(sc.g("palette")), cells, cuts, cut_texts, legend, nodata_word }
    }
    fn k(&self) -> usize {
        self.cuts.len() + 1
    }
    fn any_missing(&self) -> bool {
        self.cells.iter().any(|c| c.value.is_none())
    }
    /// The palette's table for this scale's number of classes (empty when the file has none).
    fn steps<'p>(&self, pf: &'p J) -> Vec<&'p str> {
        pf.g("sequential").g(&self.palette).g(&self.k().to_string()).arr().iter().filter_map(J::s).collect()
    }
    /// A cell's class tag and colour, recomputed from its value and the cuts: `nodata` and the nodata role, or the step.
    fn paint_of<'p>(&self, c: &Cell, pf: &'p J) -> (String, &'p str) {
        match c.value {
            None => ("nodata".into(), pf.g("roles").g("nodata").s().unwrap_or("")),
            Some(v) => {
                let b = bin_of(v, &self.cuts);
                (b.to_string(), self.steps(pf).get(b).copied().unwrap_or(""))
            }
        }
    }
    /// The attributes the core writes on a painted mark: its class tag, its colour, and its outline (the accent for a
    /// focus, else the edge when the colour is under 3:1 on a ground).
    fn mark_attrs(&self, c: &Cell, pf: &J) -> String {
        let (tag, fill) = self.paint_of(c, pf);
        let r = pf.g("roles");
        let stroke = if c.focus {
            format!(" stroke=\"{}\" stroke-width=\"2\"", st(r.g("accent")))
        } else if needs_edge(fill, pf) {
            format!(" stroke=\"{}\" stroke-width=\"0.5\"", st(r.g("edge")))
        } else {
            String::new()
        };
        format!(" data-paint=\"{}:{tag}\" fill=\"{fill}\"{stroke}", xml(&self.sid))
    }
    /// The legend: the k steps in order, the k-1 cut texts from the cut facts, and the nodata swatch with its word
    /// exactly when a cell has no value.
    fn legend_svg(&self, pf: &J) -> String {
        let (x, y) = self.legend;
        let (sid, ink) = (xml(&self.sid), st(pf.g("roles").g("ink")));
        let edge = |fill: &str| if needs_edge(fill, pf) { format!(" stroke=\"{}\" stroke-width=\"0.5\"", st(pf.g("roles").g("edge"))) } else { String::new() };
        let mut o = format!("<g data-legend=\"{sid}\">");
        let steps = self.steps(pf);
        for (i, fill) in steps.iter().enumerate() {
            let at = num_attr(x + i as f64 * 30.0);
            let _ = write!(o, "<rect x=\"{at}\" y=\"{}\" width=\"30\" height=\"10\" data-id=\"legend/{sid}/{i}\" data-paint=\"{sid}:{i}\" fill=\"{fill}\"{}/>", num_attr(y), edge(fill));
        }
        for (j, t) in self.cut_texts.iter().enumerate().map(|(j, t)| (j + 1, t)) {
            let at = num_attr(x + j as f64 * 30.0);
            let _ = write!(o, "<text x=\"{at}\" y=\"{}\" data-id=\"legend/{sid}/cut{j}\" data-src=\"fact:{sid}.cut.{j}\" fill=\"{ink}\">{}</text>", num_attr(y + 22.0), xml(t));
        }
        if self.any_missing() {
            let nd = st(pf.g("roles").g("nodata"));
            let at = x + steps.len() as f64 * 30.0;
            let _ = write!(o, "<rect x=\"{}\" y=\"{}\" width=\"30\" height=\"10\" data-id=\"legend/{sid}/nodata\" data-paint=\"{sid}:nodata\" fill=\"{nd}\"{}/>", num_attr(at + 20.0), num_attr(y), edge(nd.as_str()));
            let _ = write!(
                o,
                "<text x=\"{}\" y=\"{}\" data-id=\"legend/{sid}/nodata/t\" data-src=\"word:legend.no_data\" fill=\"{ink}\">{}</text>",
                num_attr(at + 55.0),
                num_attr(y + 10.0),
                xml(&self.nodata_word)
            );
        }
        o.push_str("</g>");
        o
    }
}

/// The core's record of a node its registry paints by scale `sid`: each cell's value from its own row (no row or a null
/// value is no data), in the units its fmt prints (the printed number when the scale prints); the cuts from those values
/// or from the core's own facts (Compute), never from a number the page tree wrote; the legend's place from the frame.
/// `texts`: per cell, the id, source and words of the number it prints (value_text), which sits in the mark when the
/// scale is printed.
fn paint_record(sid: &str, e: &J, fr: &J, mut cells: Vec<Cell>, texts: &[Option<(String, String, String)>], words: &Words, inp: &J) -> Result<Paint, String> {
    let sc = e.g("scales").g(sid);
    let printed = sc.g("printed").truthy();
    for (c, t) in cells.iter_mut().zip(texts) {
        if let Some((tid, src, said)) = t.as_ref().filter(|_| printed) {
            (c.text_id, c.src, c.text) = (Some(tid.clone()), Some(src.clone()), Some(said.clone()));
        }
    }
    let cut_refs: Vec<String> = sc.g("cuts").g("from").arr().iter().map(st).collect();
    let mut fmts: Vec<String> = Vec::new();
    for k in texts.iter().flatten().map(|t| &t.1).chain(&cut_refs).filter_map(|s| s.strip_prefix("fact:")) {
        let q = words.query(k).1;
        let f = st(q.g("fmt"));
        if !q.is_null() && !fmts.contains(&f) {
            fmts.push(f);
        }
    }
    let m = match fmts.as_slice() {
        [f] => words.fmts.g(f),
        _ => &NULL,
    };
    let (Some(dec), Some(scale)) = (m.g("dec").num(), m.get("scale").map_or(Some(1.0), J::num)) else {
        return Err(format!("scale {sid}: its marks and cuts print with the fmts {}; a scale prints with one fmt that has a dec", J::strs(&fmts).repr()));
    };
    let dec = dec as usize;
    if printed && texts.iter().all(Option::is_none) {
        return Err(format!("scale {sid} prints its numbers but no mark prints one"));
    }
    for c in &mut cells {
        c.value = c.value.map(|v| if printed { printed_value(v * scale, dec) } else { v * scale });
    }
    let values: Vec<f64> = cells.iter().filter_map(|c| c.value).collect();
    let fact = |k: &str| -> Result<f64, String> { Ok(words.val.val(words.query(k).0)? * scale) };
    let cuts = cuts_of(sc, &values, &fact, dec).map_err(|e| format!("refused: {e}"))?;
    let nodata_word = if cells.iter().any(|c| c.value.is_none()) {
        inp.g("word_table").get("legend.no_data").map(st).ok_or_else(|| format!("scale {sid}: a mark has no value and the word table has no legend.no_data"))?
    } else {
        String::new()
    };
    let lg = fr.g("legend");
    Ok(Paint::new(sid, sc, cells, cuts, dec, (lg.at(0).num().unwrap_or(0.0), lg.at(1).num().unwrap_or(0.0)), nodata_word))
}

/// One element of an SVG the core wrote: its tag (`#stray` for text outside any element), its attributes in order, the
/// text inside it, and the first attribute it repeats.
#[derive(Debug, Default)]
struct El {
    tag: String,
    attrs: Vec<(String, String)>,
    text: String,
    repeats: Option<String>,
}

impl El {
    fn get(&self, k: &str) -> Option<&str> {
        self.attrs.iter().rev().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
    fn id(&self) -> &str {
        self.get("data-id").unwrap_or("None")
    }
}

/// The elements of an SVG in the one form the core writes (`<tag a="v" ...>`, `</tag>`, `<tag .../>`, text inside a
/// text element). Anything else, a tag in another form or text outside a text element, is read as stray text.
fn svg_elements(svg: &str) -> Vec<El> {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let b = svg.as_bytes();
    let tag_at = |i: usize| -> Option<(usize, bool, El, bool)> {
        let mut j = i + 1;
        let close = svg[j..].starts_with('/');
        j += usize::from(close);
        let name_len = svg[j..].char_indices().find(|(k, c)| !(if *k == 0 { c.is_ascii_alphabetic() } else { word(*c) || *c == '-' })).map_or(svg.len() - j, |x| x.0);
        if name_len == 0 {
            return None;
        }
        let mut el = El { tag: svg[j..j + name_len].to_string(), ..Default::default() };
        j += name_len;
        loop {
            let ws = svg[j..].find(|c: char| !c.is_whitespace()).unwrap_or(svg.len() - j);
            let rest = &svg[j + ws..];
            let an = rest.find(|c: char| !(word(c) || c == ':' || c == '-')).unwrap_or(rest.len());
            if ws == 0 || an == 0 || !rest[an..].starts_with("=\"") {
                j += ws;
                break;
            }
            let v0 = j + ws + an + 2;
            let vlen = svg[v0..].find('"')?;
            let (a, v) = (rest[..an].to_string(), svg[v0..v0 + vlen].to_string());
            if el.repeats.is_none() && el.get(&a).is_some() {
                el.repeats = Some(a.clone());
            }
            el.attrs.push((a, v));
            j = v0 + vlen + 1;
        }
        let selfclose = svg[j..].starts_with('/');
        j += usize::from(selfclose);
        (b.get(j) == Some(&b'>')).then_some((j + 1, close, el, selfclose))
    };
    let (mut out, mut stack, mut pos, mut i): (Vec<El>, Vec<usize>, usize, usize) = (Vec::new(), Vec::new(), 0, 0);
    let between = |out: &mut Vec<El>, stack: &[usize], text: &str| {
        if text.trim().is_empty() {
            return;
        }
        match stack.last() {
            Some(&k) if out[k].tag == "text" => out[k].text.push_str(text),
            _ => out.push(El { tag: "#stray".into(), text: text.trim().to_string(), ..Default::default() }),
        }
    };
    while let Some(k) = svg[i..].find('<').map(|k| i + k) {
        let Some((end, close, el, selfclose)) = tag_at(k) else {
            i = k + 1;
            continue;
        };
        between(&mut out, &stack, &svg[pos..k]);
        (pos, i) = (end, end);
        if close {
            stack.pop();
        } else {
            out.push(el);
            if !selfclose {
                stack.push(out.len() - 1);
            }
        }
    }
    between(&mut out, &stack, &svg[pos..]);
    out
}

/// paint_matches_scale: every painted element of the node's SVG equals the core's recomputation from its own record
/// (class from the value and the cuts, colour from the palette file; the renderer's class tag is compared, never
/// believed); every cell painted exactly once; a printed number in its ink, with the record's words and source; the
/// outline as the record says; the legend the k steps in order, the nodata swatch exactly when a cell has no value, and
/// its cut texts the cut facts.
pub fn paint_problems(svg: &str, rec: &Paint, pf: &J) -> Vec<String> {
    let mut out = Vec::new();
    let sid = &rec.sid;
    let els = svg_elements(svg);
    let pal = rec.steps(pf);
    let (accent, edge) = (pf.g("roles").g("accent").s(), pf.g("roles").g("edge").s());
    let in_legend = |e: &El| e.get("data-paint").is_some_and(|p| p.starts_with(&format!("{sid}:"))) && e.id().starts_with(&format!("legend/{sid}/"));
    let cell_of = |did: &str| rec.cells.iter().find(|c| xml(&c.id) == did);
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for e in els.iter().filter(|e| e.get("data-paint").is_some() && !in_legend(*e)) {
        let did = e.id();
        let Some(c) = cell_of(did) else {
            out.push(format!("paint_matches_scale: {did} is painted but is no cell of the core's record"));
            continue;
        };
        *seen.entry(c.id.clone()).or_default() += 1;
        let (tag, fill) = rec.paint_of(c, pf);
        if e.get("data-paint") != Some(format!("{sid}:{tag}").as_str()) {
            out.push(format!("paint_matches_scale: {did} tagged {}, the core's class is {sid}:{tag} (value {:?}, cuts {:?})", e.get("data-paint").unwrap_or(""), c.value, rec.cuts));
        }
        if e.get("fill") != Some(fill) {
            out.push(format!("paint_matches_scale: {did} fill {:?}, the core's colour is {fill:?} ({sid}:{tag})", e.get("fill")));
        }
        let want = if c.focus { accent } else if needs_edge(fill, pf) { edge } else { None };
        if e.get("stroke") != want {
            out.push(format!("paint_matches_scale: {did} stroke {:?}, the core's outline is {want:?}", e.get("stroke")));
        }
    }
    for c in &rec.cells {
        let n = seen.get(&c.id).copied().unwrap_or(0);
        if n != 1 {
            out.push(format!("paint_matches_scale: cell {} painted {n} times, not once", c.id));
        }
    }
    for e in els.iter().filter(|e| e.tag == "text") {
        let Some(c) = rec.cells.iter().find(|c| c.text_id.as_ref().is_some_and(|t| xml(t) == e.id())) else { continue };
        let fill = rec.paint_of(c, pf).1;
        if e.get("fill") != Some(ink_on(fill, pf)) {
            out.push(format!("paint_matches_scale: {} text fill {:?} on {fill}, the core's ink is {:?}", e.id(), e.get("fill"), ink_on(fill, pf)));
        }
        let (words, src) = (c.text.as_deref().map(xml).unwrap_or_default(), c.src.as_deref().map(xml));
        if e.text.trim() != words || e.get("data-src").map(str::to_string) != src {
            out.push(format!("paint_matches_scale: {} prints {:?} from {:?}, the record has {words:?} from {src:?}", e.id(), e.text, e.get("data-src")));
        }
    }
    let legend: Vec<&El> = els.iter().filter(|e| in_legend(*e)).collect();
    let (nd, steps): (Vec<&El>, Vec<&El>) = legend.into_iter().partition(|e| e.get("data-paint").is_some_and(|p| p.ends_with(":nodata")));
    let tags: Vec<&str> = steps.iter().filter_map(|e| e.get("data-paint")).collect();
    if tags != (0..rec.k()).map(|i| format!("{sid}:{i}")).collect::<Vec<_>>() {
        out.push(format!("paint_matches_scale: legend swatches {tags:?}, the core's are {sid}:0..{} in order", rec.k() - 1));
    }
    for (i, e) in steps.iter().enumerate() {
        if i < pal.len() && e.get("fill") != Some(pal[i]) {
            out.push(format!("paint_matches_scale: legend swatch {i} fill {:?}, the palette's step {i} is {:?}", e.get("fill"), pal[i]));
        }
    }
    let nodata = pf.g("roles").g("nodata").s();
    if nd.is_empty() == rec.any_missing() || nd.len() > 1 || nd.iter().any(|e| e.get("fill") != nodata) {
        let fills: Vec<Option<&str>> = nd.iter().map(|e| e.get("fill")).collect();
        out.push(format!("paint_matches_scale: legend nodata swatches {fills:?}; the core draws one ({nodata:?}) exactly when a cell has no value ({})", rec.any_missing()));
    }
    let have: Vec<(Option<&str>, &str)> =
        els.iter().filter(|e| e.tag == "text" && e.id().starts_with(&format!("legend/{sid}/cut"))).map(|e| (e.get("data-src"), e.text.trim())).collect();
    let want: Vec<(String, String)> = rec.cut_texts.iter().enumerate().map(|(j, t)| (format!("fact:{sid}.cut.{}", j + 1), xml(t))).collect();
    if have.len() != want.len() || have.iter().zip(&want).any(|(h, w)| h.0 != Some(w.0.as_str()) || h.1 != w.1) {
        out.push(format!("paint_matches_scale: legend cut texts {have:?}, the core's cut facts {want:?}"));
    }
    out
}

/// The attributes that carry a colour: the two the core writes, and the ones it never writes.
const COLOUR_ATTRS: [&str; 2] = ["fill", "stroke"];
const OTHER_COLOUR_ATTRS: [&str; 5] = ["color", "stop-color", "flood-color", "lighting-color", "style"];

/// single_accent: every colour on the node's SVG is spelled '#rrggbb' lowercase and comes from the palette file (a role,
/// a ground, or a step of a scale the node declares); the only saturated colour besides the declared steps is the one
/// accent; a painted mark is never filled with the accent (emphasis on a painted mark is the accent outline).
pub fn accent_problems(svg: &str, recs: &[&Paint], pf: &J) -> Vec<String> {
    let mut out = Vec::new();
    let roles: Vec<&str> = pf.g("roles").obj().iter().filter_map(|(_, v)| v.s()).chain(pf.g("grounds").arr().iter().filter_map(J::s)).collect();
    let steps: Vec<&str> = recs.iter().flat_map(|r| r.steps(pf)).collect();
    let acc = pf.g("roles").g("accent").s().unwrap_or("");
    let mut saturated: BTreeSet<&str> = BTreeSet::new();
    let low = svg.to_ascii_lowercase();
    if low.match_indices("<style").any(|(i, m)| low[i + m.len()..].chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_'))) {
        out.push("single_accent: the SVG holds a <style>; the core writes colours as fill/stroke attributes only".into());
    }
    let els = svg_elements(svg);
    for e in &els {
        if e.tag == "#stray" {
            out.push(format!("single_accent: text outside any element {}", J::str(&e.text.chars().take(40).collect::<String>()).repr()));
        }
        if let Some(a) = &e.repeats {
            out.push(format!("single_accent: {} repeats the attribute {a}", e.id()));
        }
        for a in OTHER_COLOUR_ATTRS {
            if let Some(v) = e.get(a) {
                out.push(format!("single_accent: {} has {a}={}; the core writes colours only as fill/stroke", e.id(), J::str(v).repr()));
            }
        }
        for a in COLOUR_ATTRS {
            let Some(v) = e.get(a).filter(|v| *v != "none") else { continue };
            if !canon_hex(v) {
                out.push(format!(
                    "single_accent: {} {a}={} is not spelled '#rrggbb' lowercase; the core writes no other spelling, so another writer drew it",
                    e.id(),
                    J::str(v).repr()
                ));
                continue;
            }
            if !roles.contains(&v) && !steps.contains(&v) {
                out.push(format!("single_accent: {} {a}={v} is not in the palette file (roles, grounds, declared steps)", e.id()));
            }
            if !steps.contains(&v) && chroma(v) > NEUTRAL_CHROMA_MAX {
                saturated.insert(v);
            }
            if a == "fill" && v == acc && e.get("data-paint").is_some() {
                out.push(format!("single_accent: {} is painted by a scale and filled with the accent; emphasis on a painted mark is the outline", e.id()));
            }
        }
    }
    if saturated.len() > 1 || saturated.iter().any(|v| *v != acc) {
        out.push(format!("single_accent: saturated colours {saturated:?} besides the declared steps; the page has one accent {acc}"));
    }
    out
}

/// The two colour checks on a node's SVG, run on every node the core draws: paint_matches_scale for its scale record,
/// single_accent always.
fn colour_problems(svg: &str, meta: &Meta) -> Vec<String> {
    let pf = palettes();
    let mut out = meta.paint.as_ref().map_or_else(Vec::new, |p| paint_problems(svg, p, pf));
    out.extend(accent_problems(svg, &meta.paint.iter().collect::<Vec<_>>(), pf));
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

/// A template's `{name}` holes filled from the context, or from the node by a dotted path; `{path?}` is empty where the
/// node has no such path (a bind one page's node carries and another's not: the column page's number part `.n`).
fn fill_template(template: &str, ctx: &[(&str, &str)], n: &J) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let end = after.find(|c: char| !(c.is_ascii_lowercase() || c == '_' || c == '.')).unwrap_or(after.len());
        let optional = after[end..].starts_with("?}");
        if end > 0 && (optional || after[end..].starts_with('}')) {
            let k = &after[..end];
            match ctx.iter().find(|(name, _)| *name == k) {
                Some((_, v)) => out.push_str(v),
                None if optional => out.push_str(&at_path(n, k).map(st).unwrap_or_default()),
                None => out.push_str(&st(at_path(n, k)?)),
            }
            rest = &after[end + 1 + usize::from(optional)..];
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
    // the rows the items' rank reads, for the fields that name a row (row_of_code); items over a select with no rank at
    // its root (a given one: a flow's top origins) have none, and such a field refuses below
    let (over, from) = match sid.as_deref().map(|s| root_rank(&sel, s)) {
        Some(Ok(root)) => (Some(root.g("over").clone()), change_from(root).cloned()),
        _ => (None, None),
    };
    for (i, (item, code)) in items.iter_mut().zip(&codes).enumerate() {
        let mut cells: Option<J> = None;
        let cs = st(code);
        for (f, d) in it.g("fields").obj() {
            let kind = d.g("kind").s().unwrap_or("");
            // K10: the row a change runs from, only where the items' rank is by a change (else no such field)
            if kind == "row_of_code_from" && from.is_none() {
                continue;
            }
            let v = match kind {
                "select_index" => J::Str(format!("select:{}[{i}]", sid.as_deref().unwrap_or("None"))),
                "row_of_code" | "row_of_code_from" => {
                    let over = over.as_ref().ok_or("'over'")?;
                    let by = st(over.g("by"));
                    let time = if kind == "row_of_code" { over.g("time") } else { from.as_ref().expect("checked above") };
                    let hit: Vec<&J> = rows
                        .iter()
                        .filter(|r| r.g("table") == over.g("table") && r.g("time") == time && dims(r, &by) == code)
                        .filter(|r| over.g("filter").obj().iter().all(|(a, b)| dims(r, a) == b))
                        .collect();
                    if hit.len() != 1 {
                        return Err(format!("{} item {i} ({cs}): {} rows, the expansion needs exactly one", st(n.g("id")), hit.len()));
                    }
                    hit[0].g("src").clone()
                }
                "fact_template" => J::Str(format!("fact:{}", fill_template(&st(d.g("template")), &[("code", &cs)], n)?)),
                // the first candidate whose conditions hold (CONDITIONS), from the list the item's `by` field names; its
                // value is the candidate less its conditions, `{code}` read as the item's code
                "first_holding" => {
                    let list = match d.get("by") {
                        Some(b) => d.g("candidates").g(&st(item.g(&st(b)))).clone(),
                        None => d.g("candidates").clone(),
                    };
                    let list = with_code(&list, &cs, inp);
                    let mut facts = spec.g("facts").g("facts").clone();
                    for c in list.arr() {
                        for (k, q) in c.g("facts").obj() {
                            facts.set(k, q.clone());
                        }
                    }
                    let fact = |k: &str| fact_value(&facts, rows, k);
                    let word = |k: &str| crate::next_ledger::word_table().get(k).and_then(serde_json::Value::as_str).map(str::to_string);
                    // the code's name, read only by a condition that prints it (width_at_most's {name})
                    let name = inp.g("names").g(&cs).s();
                    let hold = Holding { facts: &fact, fmts: spec.g("facts").g("fmts"), got, page: inp, code: &cs, name, word: &word };
                    let i = first_holding(&list, &hold)?;
                    // a name segment of its words naming a select's one code (the other place a note compares with) names that code
                    let mut picked = J::Obj(list.at(i).obj().iter().filter(|(k, _)| k != "when").cloned().collect());
                    if let Some(text) = picked.get("text").cloned() {
                        let segs = text.arr().iter().map(|s| match s.g("name").s().filter(|r| r.starts_with("select:")) {
                            Some(r) => resolve_ref(r, got).map(|c| { let mut s = s.clone(); s.set("name", c); s }),
                            None => Ok(s.clone()),
                        }).collect::<Result<Vec<_>, String>>()?;
                        picked.set("text", J::Arr(segs));
                    }
                    picked
                }
                // a page that marks no code (no accent bound: the leaf's focus is none) marks no item
                "code_is" => match at_path(n, &st(d.g("ref"))) {
                    Ok(r) => J::Bool(*code == resolve_sel(r, got)?),
                    Err(_) => J::Bool(false),
                },
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

/// The conditions a `first_holding` field's candidates are held by, all recomputed here from the core's own facts,
/// formats, selects and the page input (registered: next_ledger CHECK_REGISTRY tree.first_holding). A candidate names
/// only these; any other condition, or another argument, is refused.
pub const CONDITIONS: [(&str, &[&str]); 10] = [
    // the sign of a fact the core computes: pos, neg or zero (a NaN reads as zero, as a partial_cmp with 0 does)
    ("sign", &["fact", "is"]),
    // the fact as the format prints it differs from 0 as the format prints it (a tie prints as no gap)
    ("prints_nonzero", &["fact", "fmt"]),
    // one line's width: its parts (a `{name}`, a literal, a `{"word": key}` of the word table) joined in order, each
    // character above U+2E7F `size` px, any other 0.58 `size`, summed left to right, at most `max` px
    ("width_at_most", &["text", "size", "max"]),
    // a select holds at least `n` codes
    ("count_at_least", &["select", "n"]),
    // the amounts of the page's unit add up (a share of their sum says something): every row of the page input holds one
    // unit code, the same, and the unit registry (unit-short-zh.tsv, its additive column) says yes for it; a row with no
    // unit, two units or a code the registry lacks: it does not hold
    ("unit_adds_up", &[]),
    // the select's codes are the whole of `by` (B1, owner 11-04: a share of the drawn sum only when the members cover it
    // all): the rows of `table` at `time` hold that dimension's one total row (next_ledger total_row, by its type), every
    // code of the select one row there, and their sum prints as the total does in `fmt`; a narrowed page (the rest not
    // fetched), a page with no total row, a code with no row or two, or a sum the total does not print as: it does not hold
    ("covers_whole", &["select", "table", "by", "time", "fmt"]),
    // the page prints the fact, a difference, as a number: no DIFF_MOST_DEC decimals left it more than half a unit of
    // its last place off its true difference (next_tree_gen printed_raise's gap_order), else its words say only which is higher
    // (`is` false: it does not, the note's words then naming the other place with no number)
    ("gap_printable", &["fact", "is"]),
    // a boolean at a path of the page input (a value that is not true or false is refused)
    ("page_is", &["path"]),
    // a row of the page input's rows at `table`, `time` and every `filter` dimension holds a text value that parses above
    // `than`; no such row, or none that parses, does not hold (the map's rule for a change: from nothing it has no ratio)
    ("row_above", &["table", "filter", "time", "than"]),
    // the page's order (its recipe's layers) has `layer` before `than`: what `layer` declares is there when `than` is
    // declared (a layer absent from the order declares nothing)
    ("layer_before", &["layer", "than"]),
];

/// What a `first_holding` condition reads, given by its caller: the core's fact values by key, its formats, its selects'
/// results, the page input, the item's code, the code's name as the page prints it (none when the page input names it
/// none: only a condition that prints it refuses), and the word table.
pub(crate) struct Holding<'a> {
    pub facts: &'a dyn Fn(&str) -> Result<f64, String>,
    pub fmts: &'a J,
    pub got: &'a Got,
    pub page: &'a J,
    pub code: &'a str,
    pub name: Option<&'a str>,
    pub word: &'a dyn Fn(&str) -> Option<String>,
}

/// The index of the first candidate (`[{"when": [condition, ...], ...}, ...]`) whose every condition holds, `{code}` in a
/// fact or select key read as the item's code. None holds: refused (the page cannot say what the registry asks).
pub(crate) fn first_holding(candidates: &J, h: &Holding) -> Result<usize, String> {
    for (i, c) in candidates.arr().iter().enumerate() {
        if conditions_hold(c.g("when"), h).map_err(|e| format!("candidate {i}: {e}"))? {
            return Ok(i);
        }
    }
    Err(format!("item {}: no candidate's conditions hold", h.code))
}

/// Whether every condition of a list (CONDITIONS) holds, read in order (the first that does not ends it).
pub(crate) fn conditions_hold(conds: &J, h: &Holding) -> Result<bool, String> {
    for cond in conds.arr() {
        if !condition_holds(cond, h)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// One condition of CONDITIONS over what `h` gives.
fn condition_holds(cond: &J, h: &Holding) -> Result<bool, String> {
    let kind = st(cond.g("if"));
    let args = CONDITIONS.iter().find(|(k, _)| *k == kind).map(|(_, a)| *a).ok_or_else(|| format!("condition {kind}: not one the core computes"))?;
    if let Some((k, _)) = cond.obj().iter().find(|(k, _)| k != "if" && !args.contains(&k.as_str())) {
        return Err(format!("condition {kind}: no argument {k} (it reads {})", args.join(", ")));
    }
    let key = |k: &str| st(cond.g(k)).replace("{code}", h.code);
    match kind.as_str() {
        "sign" => {
            let v = (h.facts)(&key("fact"))?;
            let is = match v.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) {
                std::cmp::Ordering::Greater => "pos",
                std::cmp::Ordering::Less => "neg",
                std::cmp::Ordering::Equal => "zero",
            };
            match st(cond.g("is")).as_str() {
                want @ ("pos" | "neg" | "zero") => Ok(is == want),
                other => Err(format!("condition sign: is {other} (pos, neg or zero)")),
            }
        }
        "prints_nonzero" => {
            let v = (h.facts)(&key("fact"))?;
            let fmt = st(cond.g("fmt"));
            let fm = h.fmts.get(&fmt).ok_or_else(|| format!("condition prints_nonzero: no format {fmt}"))?;
            let dec = fm.g("dec").num().ok_or_else(|| format!("format {fmt}: no dec"))? as usize;
            let scale = fm.get("scale").map_or(Ok(1.0), |x| x.num().ok_or_else(|| format!("format {fmt}: scale")))?;
            Ok(py_fixed(v * scale, dec) != py_fixed(0.0 * scale, dec))
        }
        "width_at_most" => {
            let mut line = String::new();
            for part in cond.g("text").arr() {
                match part {
                    J::Str(s) if s.contains("{name}") => {
                        let name = h.name.ok_or_else(|| format!("'{}': the page input names no {}", h.code, h.code))?;
                        line.push_str(&s.replace("{name}", name))
                    }
                    J::Str(s) => line.push_str(s),
                    J::Obj(_) if part.has("word") => {
                        let k = st(part.g("word"));
                        line.push_str(&(h.word)(&k).ok_or_else(|| format!("condition width_at_most: the word table has no {k}"))?);
                    }
                    p => return Err(format!("condition width_at_most: text part {}", p.repr())),
                }
            }
            let size = cond.g("size").num().ok_or("condition width_at_most: size")?;
            let max = cond.g("max").num().ok_or("condition width_at_most: max")?;
            Ok(line_width(&line, size) <= max)
        }
        "unit_adds_up" => {
            let units: std::collections::BTreeSet<Option<&str>> = h.page.g("rows").arr().iter().map(|r| dims(r, "unit").s()).collect();
            Ok(match units.into_iter().collect::<Vec<_>>()[..] {
                [Some(unit)] => unit_additive(unit)?,
                _ => false,
            })
        }
        "covers_whole" => {
            let sid = key("select");
            let codes = h.got.get(&sid).ok_or_else(|| format!("condition covers_whole: no select {sid}"))?.arr().to_vec();
            let (table, by, time) = (key("table"), key("by"), key("time"));
            let fmt = key("fmt");
            let fm = h.fmts.get(&fmt).ok_or_else(|| format!("condition covers_whole: no format {fmt}"))?;
            let dec = fm.g("dec").num().ok_or_else(|| format!("format {fmt}: no dec"))? as usize;
            let scale = fm.get("scale").map_or(Ok(1.0), |x| x.num().ok_or_else(|| format!("format {fmt}: scale")))?;
            let at: Vec<&J> = h.page.g("rows").arr().iter().filter(|r| st(r.g("table")) == table && st(r.g("time")) == time).collect();
            let totals: Vec<&J> = at.iter().copied().filter(|r| dims(r, &by).s().is_some_and(|c| crate::next_ledger::total_row(&table, &by, c))).collect();
            let [total] = totals.as_slice() else { return Ok(false) };
            let mut sum = 0.0;
            for c in &codes {
                let rows: Vec<&J> = at.iter().copied().filter(|r| dims(r, &by) == c).collect();
                match (rows.as_slice(), c.s().is_some_and(|c| crate::next_ledger::total_row(&table, &by, c))) {
                    ([r], false) => sum += text_num(r).ok_or_else(|| format!("condition covers_whole: {} has no number", st(c)))?,
                    _ => return Ok(false),
                }
            }
            let whole = text_num(total).ok_or("condition covers_whole: the total row has no number")?;
            Ok(!codes.is_empty() && py_fixed(sum * scale, dec) == py_fixed(whole * scale, dec))
        }
        "count_at_least" => {
            let sid = key("select");
            let n = cond.g("n").num().ok_or("condition count_at_least: n")?;
            let have = h.got.get(&sid).ok_or_else(|| format!("condition count_at_least: no select {sid}"))?.arr().len();
            Ok(have as f64 >= n)
        }
        "gap_printable" => {
            let prints = !h.page.g("gap_order").arr().iter().any(|o| o.s() == Some(key("fact").as_str()));
            match cond.get("is") {
                None | Some(J::Bool(true)) => Ok(prints),
                Some(J::Bool(false)) => Ok(!prints),
                Some(v) => Err(format!("condition gap_printable: is {} (true or false)", v.repr())),
            }
        }
        "page_is" => match at_path(h.page, &st(cond.g("path")))? {
            J::Bool(b) => Ok(*b),
            v => Err(format!("condition page_is {}: {} is not true or false", st(cond.g("path")), v.repr())),
        },
        "row_above" => {
            let than = cond.g("than").num().ok_or("condition row_above: than")?;
            let filter = cond.g("filter").obj();
            Ok(h.page.g("rows").arr().iter().any(|r| {
                r.g("table") == cond.g("table")
                    && r.g("time") == cond.g("time")
                    && filter.iter().all(|(d, c)| dims(r, d) == c)
                    && r.g("value").s().and_then(|v| v.parse::<f64>().ok()).is_some_and(|v| v > than)
            }))
        }
        "layer_before" => {
            let at = |k: &str| h.page.g("order").arr().iter().position(|l| l.s() == Some(st(cond.g(k)).as_str()));
            Ok(matches!((at("layer"), at("than")), (Some(a), Some(b)) if a < b))
        }
        _ => unreachable!("CONDITIONS holds the arms"),
    }
}

/// The unit registry (runtime/pi/assets/unit-short-zh.tsv, data the core reads itself as vocabulary, as it reads the
/// parts table): code, short form, rule, additive.
const UNIT_TSV: &str = include_str!("../runtime/pi/assets/unit-short-zh.tsv");

/// Whether amounts in `unit` add up, as the unit registry's additive column says (yes or no); a code it lacks: no. A
/// registry with no additive column, or a value other than yes or no, is refused.
fn unit_additive(unit: &str) -> Result<bool, String> {
    let mut lines = UNIT_TSV.lines();
    let head: Vec<&str> = lines.next().unwrap_or_default().split('\t').collect();
    let at = |name: &str| head.iter().position(|h| *h == name).ok_or_else(|| format!("unit registry: no column {name}"));
    let (code, additive) = (at("code")?, at("additive")?);
    for line in lines {
        let p: Vec<&str> = line.split('\t').collect();
        if p.get(code) == Some(&unit) {
            return match p.get(additive) {
                Some(&"yes") => Ok(true),
                Some(&"no") => Ok(false),
                v => Err(format!("unit registry: {unit} additive {v:?} (yes or no)")),
            };
        }
    }
    Ok(false)
}

/// `v` with `{code}` in every string and object key read as `code`, `{code_lc}` as it in lowercase, and `{y0}` / `{y1}`
/// as the page input's picks.y0 / picks.y1 (the two years' last two digits) when it has them.
pub(crate) fn with_code(v: &J, code: &str, page: &J) -> J {
    let lc = code.to_lowercase();
    let mut ctx = vec![("{code}", code), ("{code_lc}", lc.as_str())];
    for (k, y) in [("{y0}", "y0"), ("{y1}", "y1")] {
        if let Some(v) = page.g("picks").g(y).s() {
            ctx.push((k, v));
        }
    }
    fn walk(v: &J, ctx: &[(&str, &str)]) -> J {
        let put = |s: &str| ctx.iter().fold(s.to_string(), |s, (k, v)| s.replace(k, v));
        match v {
            J::Str(s) => J::Str(put(s)),
            J::Arr(a) => J::Arr(a.iter().map(|x| walk(x, ctx)).collect()),
            J::Obj(o) => J::Obj(o.iter().map(|(k, x)| (put(k), walk(x, ctx))).collect()),
            x => x.clone(),
        }
    }
    walk(v, &ctx)
}

/// A fact's value as the core computes it over `rows` (the Compute the checks use), the facts declared in `facts`.
pub(crate) fn fact_value(facts: &J, rows: &[J], key: &str) -> Result<f64, String> {
    Compute::new(facts, rows).val(key)
}

/// The most decimals a printed difference's two values may take to come close (J2): two.
pub(crate) const DIFF_MOST_DEC: usize = 2;

/// A number its format printed (py_fixed: "-0.35") as an integer of `dec` decimals (-35 at 2, -350 at 3); none when it
/// holds more decimals than `dec` or is no number.
fn printed_int(printed: &str, dec: usize) -> Option<i128> {
    let (neg, body) = printed.strip_prefix('-').map_or((false, printed), |b| (true, b));
    let (whole, frac) = body.split_once('.').unwrap_or((body, ""));
    if frac.len() > dec || whole.is_empty() || !whole.chars().chain(frac.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: i128 = format!("{whole}{frac}{}", "0".repeat(dec - frac.len())).parse().ok()?;
    Some(if neg { -n } else { n })
}

/// An integer of `from` decimals rounded half to even to `to` (at most `from`) decimals.
fn round_even(x: i128, from: usize, to: usize) -> i128 {
    let k = 10i128.pow((from - to) as u32);
    let (q, r) = (x.div_euclid(k), x.rem_euclid(k));
    match (2 * r).cmp(&k) {
        std::cmp::Ordering::Greater => q + 1,
        std::cmp::Ordering::Equal => q + (q & 1),
        std::cmp::Ordering::Less => q,
    }
}

/// The fact keys a page prints: every `fact:<key>` ledger reference and every `{<key>}` placeholder in `v` (a page tree
/// less its facts, or what a layer declared), a `.n` ending read as the number itself; a `.t` (its year) or any other
/// ending of a key the facts do not hold is no number of it. A family's members print where a layer binds the family
/// (`"family": <key>`, the bars' signed changes): every member of it then.
pub(crate) fn printed_keys(v: &J, facts: &J) -> BTreeSet<String> {
    fn walk(v: &J, out: &mut Vec<String>, fams: &mut Vec<String>) {
        match v {
            J::Str(s) => {
                if let Some(k) = s.strip_prefix("fact:") {
                    out.push(k.to_string());
                }
                let mut rest = s.as_str();
                while let Some(i) = rest.find('{') {
                    let tail = &rest[i + 1..];
                    match tail.find('}') {
                        Some(j) => {
                            out.push(tail[..j].to_string());
                            rest = &tail[j + 1..];
                        }
                        None => break,
                    }
                }
            }
            J::Arr(a) => a.iter().for_each(|x| walk(x, out, fams)),
            J::Obj(o) => {
                for (k, x) in o {
                    if k == "family" {
                        if let Some(f) = x.s() {
                            fams.push(f.to_string());
                        }
                    }
                    walk(x, out, fams);
                }
            }
            _ => {}
        }
    }
    let (mut refs, mut fams) = (Vec::new(), Vec::new());
    walk(v, &mut refs, &mut fams);
    let held = |k: &str| facts.get(k).is_some() || k.rsplit_once('.').is_some_and(|(f, _)| facts.get(f).is_some_and(|q| q.has("each")));
    let mut out = BTreeSet::new();
    for r in refs {
        let k = r.strip_suffix(".n").unwrap_or(&r);
        if held(k) {
            out.insert(k.to_string());
        }
    }
    for f in fams.into_iter().filter(|f| facts.get(f).is_some_and(|q| q.has("each"))) {
        out.insert(format!("{f}.*"));
    }
    out
}

/// A fact key's format: its own fact's, or a family member's (`fmt_each.<code>` when the family names one for it, else the
/// family's own: chg.SE prints in chg's).
pub(crate) fn fact_fmt(facts: &J, key: &str) -> Option<String> {
    if let Some(q) = facts.get(key) {
        return q.g("fmt").s().map(str::to_string);
    }
    let (fam, code) = key.rsplit_once('.')?;
    let q = facts.get(fam).filter(|q| q.has("each"))?;
    q.g("fmt_each").g(code).s().or(q.g("fmt").s()).map(str::to_string)
}

/// A printed difference read against its true difference (owner 11-06, superseding 11-03 and J2 of 11-04): for every
/// minus fact of two facts (no family) the page prints whose operands it prints too (the operand itself, or a printed fact
/// of the same value: vs_hi_a is SE's bar chg.SE), the difference as printed is within half a unit of its last place of
/// the difference of the two raw values. It need not equal the difference of the two numbers as printed (6.3 less 3.6 may
/// print 2.8 when the raw values differ by 2.78). An operand the page does not print leaves its difference no case; so do
/// formats of two scales and a fact the core cannot compute (the facts check reports it). Each failure: (its words, [the
/// difference, the printed key of each operand]).
pub(crate) fn differences_disagree(facts: &J, fmts: &J, rows: &[J], printed: &BTreeSet<String>) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    for d in printed_differences(facts, fmts, rows, printed) {
        let keys = vec![d.key.clone(), d.pa.clone(), d.pb.clone()];
        if !d.close {
            out.push((format!("printed difference {}: prints {}, more than half a unit of its last place off the true difference {} of {} and {}", d.key, d.tk, d.truth, d.pa, d.pb), keys));
        }
    }
    out
}

/// One printed difference of the page as differences_disagree reads it: the difference and its operands' printed keys,
/// what the difference prints, the operands' (scale, decimals), whether it is the difference of its operands as printed
/// (kept for reading, no longer asked), the true difference of the operands, and whether the printed one is within half a
/// unit of its last place of it.
pub(crate) struct PrintedDiff {
    pub key: String,
    pub pa: String,
    pub pb: String,
    pub tk: String,
    pub forms: [(f64, usize); 2],
    pub dec: usize,
    pub equal: bool,
    pub truth: f64,
    pub close: bool,
}

/// The page's printed differences (differences_disagree's cases), each read whole (PrintedDiff).
pub(crate) fn printed_differences(facts: &J, fmts: &J, rows: &[J], printed: &BTreeSet<String>) -> Vec<PrintedDiff> {
    let val = Compute::new(facts, rows);
    let shown = |k: &str| printed.contains(k) || k.rsplit_once('.').is_some_and(|(f, _)| printed.contains(&format!("{f}.*")));
    // the printed keys, each family bound whole as its members
    let mut keys: Vec<String> = printed.iter().filter(|k| !k.ends_with(".*")).cloned().collect();
    for f in printed.iter().filter_map(|k| k.strip_suffix(".*")) {
        // a family of differences has its first family's codes
        let of = match facts.g(f).g("op").s() {
            Some("minus") => st(facts.g(f).g("a")),
            _ => f.to_string(),
        };
        if let Ok(members) = val.fam(&of) {
            keys.extend(members.into_iter().map(|(c, _)| format!("{f}.{c}")));
        }
    }
    let form = |key: &str| -> Option<(String, f64, usize)> {
        let f = fact_fmt(facts, key)?;
        let fm = fmts.get(&f)?;
        Some((f, fm.get("scale").map_or(Some(1.0), J::num)?, fm.g("dec").num()? as usize))
    };
    // where the page prints an operand: itself, else a printed fact of its value (its own format's first)
    let twin = |key: &str| -> Option<String> {
        if shown(key) {
            return Some(key.to_string());
        }
        let v = val.val(key).ok()?;
        let own = fact_fmt(facts, key);
        let same: Vec<&String> = keys.iter().filter(|k| val.val(k).is_ok_and(|w| w == v)).collect();
        same.iter().find(|k| fact_fmt(facts, k) == own).or(same.first()).map(|k| k.to_string())
    };
    let mut out = Vec::new();
    for (k, q) in facts.obj() {
        if q.g("op").s() != Some("minus") || q.has("each") || !shown(k) {
            continue;
        }
        let (Some(pa), Some(pb)) = (twin(&st(q.g("a"))), twin(&st(q.g("b")))) else { continue };
        let (Some((_, sk, dk)), Some((_, sa, da)), Some((_, sb, db))) = (form(k), form(&pa), form(&pb)) else { continue };
        if sk != sa || sk != sb {
            continue;
        }
        let (Ok(vk), Ok(va), Ok(vb)) = (val.val(k), val.val(&pa), val.val(&pb)) else { continue };
        if !(vk.is_finite() && va.is_finite() && vb.is_finite()) {
            continue;
        }
        let (tk, ta, tb) = (py_fixed(vk * sk, dk), py_fixed(va * sa, da), py_fixed(vb * sb, db));
        let most = da.max(db).max(dk);
        let (Some(ik), Some(ia), Some(ib)) = (printed_int(&tk, dk), printed_int(&ta, most), printed_int(&tb, most)) else { continue };
        let want = round_even(ia - ib, most, dk);
        // the true difference of the two values, and the printed one against it (in the difference's own unit)
        let truth = va - vb;
        let shown_v = ik as f64 / 10f64.powi(dk as i32) / sk;
        // owner 11-06: within half a unit of the difference's last printed place of the raw difference
        let close = (shown_v - truth).abs() <= 0.5 * 10f64.powi(-(dk as i32)) / sk + 1e-9;
        out.push(PrintedDiff { key: k.clone(), pa, pb, tk, forms: [(sa, da), (sb, db)], dec: dk, equal: want == ik, truth, close });
    }
    out
}

/// One line's width as the flow's leader notes measured it (note_fits): a character above U+2E7F `size`, any other 0.58
/// `size`, summed left to right in a plain sum (not tw_leaf's compensated one: the two may differ at the limit).
fn line_width(text: &str, size: f64) -> f64 {
    text.chars().map(|c| if c as u32 > 0x2e7f { size } else { 0.58 * size }).sum()
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

/// K2: the column page leaf's width rule (prod.py tw, copied: a code point above U+2E7F 1 em, any other 0.58 em, summed
/// glyph by glyph in that order). Only a rows frame is laid out by it, on the strings the core prints, never rounded.
pub fn tw_leaf(text: &str, size: f64) -> f64 {
    // Python's sum() over floats (3.12+) is Neumaier's compensated sum; the leaf's widths come from it, so this does the same.
    let (mut s, mut c) = (0.0f64, 0.0f64);
    for ch in text.chars() {
        let x = if ch as u32 > 0x2E7F { size } else { 0.58 * size };
        let t = s + x;
        c += if s.abs() >= x.abs() { (s - t) + x } else { (x - t) + s };
        s = t;
    }
    s + c
}

/// K11 (P4a-2): the room for a value text on each side a bar runs to, as the change leaf left it (column.py
/// cl_change_bars): `vw` left of the zero line when a value is below 0, right of it when one is above 0. (lo, hi, neg, pos)
fn signed_room(values: &[f64], vw: f64) -> (f64, f64, f64, f64) {
    let lo = values
        .iter()
        .copied()
        .fold(f64::INFINITY, |a, b| if b < a { b } else { a });
    let hi = values
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, |a, b| if b > a { b } else { a });
    // Python's min(0.0, x) and max(0.0, x): 0.0 unless x is past it
    let (lo, hi) = (
        if lo < 0.0 { lo } else { 0.0 },
        if hi > 0.0 { hi } else { 0.0 },
    );
    (
        lo,
        hi,
        if lo < 0.0 { vw } else { 0.0 },
        if hi > 0.0 { vw } else { 0.0 },
    )
}

/// K2: a rows frame laid out as the column page's leaf lays out its bars (column.py ColumnFrame and cl_change_bars, their
/// arithmetic in their order): the left column as wide as its widest text plus its gap, the right likewise, the frame
/// starting at the node's knob x0 (0 without it); the bars between the two columns from a zero line, with the right
/// column's room on each side a bar runs to (K11: on values of 0 or more, the room after the bars only); one row per item
/// from top, the frame's foot under the last. Returns the frame {w, h}, the plot box (from the zero line's left room to the
/// right room) and the numbers the node lays the rows out by {x0, lw, vw, bw (the whole width after x0), top, row, inset}.
fn rows_frame(fr: &J, n: &J, meta: &Meta, size: f64, values: &[f64]) -> Result<(J, J, J), String> {
    let widest = |side: &str| -> Result<f64, String> {
        let end = format!("/{}", st(fr.g(side).g("text")));
        let gap = fr.g(side).g("gap").num().ok_or("rows frame gap")?;
        let w = meta.texts.iter().filter(|t| t.0.ends_with(&end)).map(|t| tw_leaf(&t.1, size)).reduce(pmax).ok_or("rows frame: no text sizes a column")?;
        Ok(w + gap)
    };
    let (lw, vw) = (widest("left")?, widest("right")?);
    let x0 = n.g("knobs").get("x0").cloned().unwrap_or(J::Int(0));
    let num = |v: &J, what: &str| v.num().ok_or_else(|| format!("rows frame: {what} is no number"));
    let (w, x, top, row) = (num(fr.g("w"), "w")?, num(&x0, "x0")?, num(fr.g("top"), "top")?, num(fr.g("row"), "row")?);
    let count = n.g("items").arr().len() as f64;
    let whole = w - x;
    let (_, _, neg, pos) = signed_room(values, vw);
    let bw = whole - lw - neg - pos;
    let left = x + lw + neg;
    let plot = J::Arr(vec![
        J::Num(left),
        J::Num(top),
        J::Num(left + bw),
        J::Num(top + row * count),
    ]);
    let h = top + row * count + num(fr.g("foot"), "foot")?;
    let frame = J::obj_of(vec![("w", fr.g("w").clone()), ("h", J::Num(h))]);
    let rows = J::obj_of(vec![
        ("x0", x0),
        ("lw", J::Num(lw)),
        ("vw", J::Num(vw)),
        ("bw", J::Num(whole)),
        ("top", fr.g("top").clone()),
        ("row", fr.g("row").clone()),
        ("inset", fr.g("inset").clone()),
    ]);
    Ok((frame, plot, rows))
}

/// K11: the zero line and each value's bar (x, w) on a signed rows request, the change leaf's arithmetic in its order:
/// left = x0 + lw + neg, bw = whole - lw - neg - pos, z = left + -lo / (hi - lo) * bw, w = |v| / (hi - lo) * bw, x = z or
/// z - w. None when every value is 0 (no span to scale by).
fn signed_bars(rows: &J, values: &[f64]) -> Option<(f64, Vec<(f64, f64)>)> {
    let (x0, lw, vw, whole) = (
        rows.g("x0").num()?,
        rows.g("lw").num()?,
        rows.g("vw").num()?,
        rows.g("bw").num()?,
    );
    let (lo, hi, neg, pos) = signed_room(values, vw);
    if hi - lo <= 0.0 {
        return None;
    }
    let left = x0 + lw + neg;
    let bw = whole - lw - neg - pos;
    let z = left + -lo / (hi - lo) * bw;
    Some((
        z,
        values
            .iter()
            .map(|v| {
                let w = v.abs() / (hi - lo) * bw;
                (if *v >= 0.0 { z } else { z - w }, w)
            })
            .collect(),
    ))
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
    /// A printed fact key's base (less a final .n or .t) and its query (its own, or its family's).
    fn query<'k>(&self, key: &'k str) -> (&'k str, &'a J) {
        let base = match key.rsplit_once('.') {
            Some((head, "n" | "t")) => head,
            _ => key,
        };
        let q = [self.rfacts.get(base), self.rfacts.get(base.rsplit_once('.').map_or("", |x| x.0))]
            .into_iter()
            .flatten()
            .find(|q| q.truthy())
            .unwrap_or(&NULL);
        (base, q)
    }
    fn fact(&self, key: &str, part: Option<&str>) -> Result<String, String> {
        let (base, q) = self.query(key);
        if part == Some("t") {
            let t = if q.g("to").truthy() { q.g("to") } else { q.g("time") };
            return Ok(if t.is_null() { "None".into() } else { st(t) });
        }
        let v = self.val.val(base)?;
        // a family member's own format when the family names one (fact_fmt: fmt_each), else the fact's
        let f = fact_fmt(self.rfacts, base).map_or_else(|| q.g("fmt").clone(), J::Str);
        let f = &f;
        if let Some(m) = f.s().and_then(|f| self.fmts.get(f)).filter(|m| m.has("dec")) {
            let scale = m.get("scale").map_or(Some(1.0), J::num).ok_or("scale")?;
            let dec = m.g("dec").num().ok_or("dec")? as usize;
            // a key's .n part is the number without its unit, as the leaf's ledger prints fact:<key>.n (facts.py)
            let bare = part == Some("n") || key.ends_with(".n");
            let suffix = if bare { String::new() } else { m.get("suffix").map_or(String::new(), st) };
            return Ok(format!("{}{suffix}", py_grouped(&py_fixed(v * scale, dec))));
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
        if r.has("term") {
            return Ok(st(r.g("term")));
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
        } else if r.has("term") {
            Some(st(r.g("term")))
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
            "length_signed" => {
                // K11: from the zero line, each value's size over the span, right of the line or left of it by its sign
                let values = ms.iter().map(|m| value(m, "value")).collect::<Result<Vec<f64>, String>>()?;
                let (_, bars) = signed_bars(req.g("rows"), &values).ok_or("length_signed: no value differs from 0, or no signed rows frame")?;
                for (i, (x, w)) in bars.into_iter().enumerate() {
                    put(&mut out, i, "x", x);
                    put(&mut out, i, "w", w);
                }
            }
            "rows_y" => {
                // K2: item j's row from the plot's top, the mark inset from its row's top and bottom
                let rows = req.g("rows");
                let (row, inset) = (rows.g("row").num().ok_or("rows_y: no row")?, rows.g("inset").num().ok_or("rows_y: no inset")?);
                for (i, m) in ms.iter().enumerate() {
                    let j = order.iter().position(|o| *o == m.g("item")).expect("in order") as f64;
                    put(&mut out, i, "y", y0 + j * row + inset);
                    put(&mut out, i, "h", row - 2.0 * inset);
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
    /// The scale record when the registry paints the node's marks by a scale (R11).
    pub paint: Option<Paint>,
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
        if fr.g("kind").s() == Some("view") {
            let (req, meta) = circles_request(&nid, n, e, fr, &words, &rows, got, inp)?;
            reqs.push((nid.clone(), req));
            metas.insert(nid, meta);
            continue;
        }
        let enc = e.g("marks").g("encode");
        let ofs: Vec<&str> = enc.arr().iter().filter_map(|c| c.g("of").s()).collect();
        let proj = if ofs.contains(&"at") { Some(fit(four(n.g("geometry").g("ext"))?, four(fr.g("plot"))?)) } else { None };
        let (mut marks, mut texts, mut meta) = (Vec::new(), Vec::new(), Meta::default());
        let mut row_left: Vec<(usize, usize, f64)> = Vec::new();
        let shape = e.g("marks").g("shape").clone();
        let per_item = e.g("marks").g("per").s() == Some("item");
        let tsize = e.g("texts").g("size").num().ok_or("texts.size")?;
        let paint_sid = e.g("marks").g("paint").g("scale").s();
        let mut cells: Vec<Cell> = Vec::new();
        for (i, it) in n.g("items").arr().iter().enumerate() {
            let focus = it.g("focus").truthy();
            if per_item {
                let id = format!("{nid}/{i}");
                let mut m = J::obj_of(vec![("id", J::str(&id)), ("shape", shape.clone()), ("item", J::Int(i as i64))]);
                if ofs.contains(&"value") {
                    let mut v = num(row(it.g("value"))?)?;
                    // K10: an item ranked by its change is drawn by it, the later value less the earlier
                    if let Some(from) = it.get("value_from") {
                        v -= num(row(from)?)?;
                    }
                    m.set("value", J::Num(v));
                }
                if let Some(proj) = proj {
                    let p = project((it.g("at").at(0).num().ok_or("at")?, it.g("at").at(1).num().ok_or("at")?), proj);
                    m.set("pin", J::Arr(p.iter().map(|v| J::Num(py_round(*v, 3))).collect()));
                }
                marks.push(m);
                if paint_sid.is_some() {
                    let v = it.g("value");
                    let value = if v.is_null() || row(v)?.g("value").is_null() { None } else { Some(num(row(v)?)?) };
                    cells.push(Cell { id: id.clone(), value, focus, ..Default::default() });
                }
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
                    let mut t = J::obj_of(vec![
                        ("id", J::str(&tid)),
                        ("w", J::Num(py_round(tw(&s, tsize), 3))),
                        ("h", J::Num(py_round(tsize * 1.15, 3))),
                        ("size", e.g("texts").g("size").clone()),
                    ]);
                    match rel.g("gap_px").num() {
                        // K2: at its row's start, placed below once the rows frame is laid out
                        Some(gap) => row_left.push((texts.len(), i, gap)),
                        None => t.set("near", J::obj_of(vec![("marks", J::strs(&near)), ("from", rel.g("from").clone()), ("max_px", rel.g("max_px").clone())])),
                    }
                    texts.push(t);
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
        if let Some(sid) = paint_sid {
            let texts: Vec<Option<(String, String, String)>> = cells
                .iter()
                .map(|c| meta.texts.iter().find(|t| t.0 == format!("{}/value_text", c.id)).and_then(|t| t.2.s().map(|s| (t.0.clone(), s.to_string(), t.1.clone()))))
                .collect();
            meta.paint = Some(paint_record(sid, e, fr, cells, &texts, &words, inp)?);
        }
        meta.tol_px = e.g("marks").g("tol_px").num().ok_or("tol_px")?;
        let mut req = J::obj_of(vec![
            ("node", n.g("node").clone()),
            ("frame", J::obj_of(vec![("w", fr.g("w").clone()), ("h", fr.g("h").clone())])),
            ("plot", fr.g("plot").clone()),
            ("encode", enc.clone()),
            ("marks", J::Arr(marks)),
            ("texts", J::Arr(texts)),
        ]);
        if fr.g("kind").s() == Some("rows") {
            let values = req.g("marks").arr().iter().filter_map(|m| m.g("value").num()).collect::<Vec<f64>>();
            let (frame, plot, rows) = rows_frame(fr, n, &meta, tsize, &values)?;
            // K2: a text at its row's start: right-aligned gap_px before the left column's edge, on its row's middle
            let (x0, lw, top, row) = (rows.g("x0").num(), rows.g("lw").num(), rows.g("top").num(), rows.g("row").num());
            let (Some(x0), Some(lw), Some(top), Some(row)) = (x0, lw, top, row) else { return Err("rows frame: x0, lw, top, row".into()) };
            let mut ts = req.g("texts").arr().to_vec();
            for (k, i, gap) in &row_left {
                let y = top + *i as f64 * row;
                ts[*k].set("at", J::Arr(vec![J::Num(x0 + lw - gap), J::Num(y + row / 2.0), J::str("end")]));
            }
            req.set("texts", J::Arr(ts));
            req.set("frame", frame);
            req.set("plot", plot);
            req.set("rows", rows);
        }
        reqs.push((nid.clone(), req));
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
    // a count of the places the page draws (四国 on a page of four) is the data's own count (user 11-07)
    let places = places_drawn(spec, inp.g("rows").arr());
    for (path, v) in walk(spec, "$") {
        let rs = if v.g("kind").s() == Some("Text") {
            v.g("runs")
        } else if v.is_arr() && path.ends_with(".text") && v.at(0).is_obj() {
            v
        } else {
            continue;
        };
        let (mut chars, held) = literal_chars(rs, inp);
        let free = number_free(&chars, &held);
        let counted = place_count(&chars, &held, places);
        chars.iter_mut().zip(free.into_iter().zip(counted)).filter(|(_, (f, n))| *f || *n).for_each(|(c, _)| *c = ' ');
        let hit = worded_number(&chars, &held);
        let literal: String = chars.iter().zip(&held).filter(|(_, h)| !**h).map(|(c, _)| *c).collect();
        if hit.is_some() || has_digit(&literal) {
            errs.push(format!("C3 {path}: the core's words type a number ({}); a number is a fact run", J::str(hit.as_deref().unwrap_or("a digit")).repr()));
        }
    }
    errs.extend(asked_problems(spec, inp));
    let ok = errs.is_empty();
    (errs, ok.then_some(Content { got, rpage }))
}

/// C6, the page answers what the question asks: each quantity the catalogue read in the question (inp.asked, the flow's
/// copy of its record; none when the field is absent) is drawn, a row of the page's drawn record from a table one of its
/// prefixes starts, or else named by the leaf's line that this half cannot be answered. The leaf prints that line for each
/// quantity of its own spec with no offered table (inp.leaf_asked, scmp.py unanswered), and the line stands only when the
/// catalogue's record offered no table for it either: whether a half is unanswerable is the program's call from the
/// offered tables, never the model's. The leaf's record must be the catalogue's. A fact the page prints draws the tables it
/// is computed from as well (a change page's bars print val1 - val0 and draw no row of their own; C1 recomputes it from
/// those rows): a count of places (op n) draws none.
fn asked_problems(spec: &J, inp: &J) -> Vec<String> {
    let strs = |v: &J| v.arr().iter().map(st).collect::<Vec<_>>();
    let mut drawn = spec.g("record").g("drawn").arr().iter().map(|d| st(d.g("table"))).collect::<Vec<_>>();
    let facts = spec.g("facts").g("facts");
    let page = J::Obj(spec.obj().iter().filter(|(k, _)| k != "facts").cloned().collect());
    for k in printed_keys(&page, facts) {
        let base = match k.strip_suffix(".*") {
            Some(f) => f,
            None if facts.get(&k).is_some() => k.as_str(),
            None => k.rsplit_once('.').map_or(k.as_str(), |(f, _)| f),
        };
        fact_tables(facts, base, &mut drawn, 0);
    }
    let (asked, leaf) = (inp.g("asked").arr(), inp.g("leaf_asked").arr());
    let lined: Vec<String> = leaf.iter().filter(|a| a.g("offered").arr().is_empty()).map(|a| st(a.g("id"))).collect();
    let mut out = Vec::new();
    for a in asked {
        let (id, tables, offered) = (st(a.g("id")), strs(a.g("tables")), strs(a.g("offered")));
        // drawn from a table one of its prefixes starts, or one the catalogue offered for it (a title naming it: l5geo
        // Asked::holds_candidate)
        if drawn.iter().any(|t| tables.iter().any(|p| !p.is_empty() && t.starts_with(p.as_str())) || offered.contains(t)) {
            continue;
        }
        let head = format!("C6: the question asks for {id} but the page draws no row from {}", tables.join(", "));
        match (offered.is_empty(), lined.contains(&id)) {
            (true, true) => {}
            (true, false) => out.push(format!("{head} and carries no unanswered line for it")),
            (false, true) => out.push(format!("{head}; its unanswered line does not stand, as {} was offered for it", offered.join(", "))),
            (false, false) => out.push(head),
        }
    }
    for a in leaf.iter().filter(|a| !asked.contains(a)) {
        out.push(format!("C6: the leaf's asked {} is not the catalogue's record", a.repr()));
    }
    out
}

/// The tables a fact is computed from: its own table, or those of the facts it is made of (a and b of an op), a count of
/// places (op n) none; depth-bounded, so a fact naming itself ends.
fn fact_tables(facts: &J, key: &str, out: &mut Vec<String>, depth: usize) {
    let Some(q) = facts.get(key) else { return };
    if depth > 8 || q.g("op").s() == Some("n") {
        return;
    }
    if let Some(t) = q.g("table").s() {
        out.push(t.to_string());
    }
    for part in ["a", "b"] {
        if let Some(k) = q.g(part).s() {
            fact_tables(facts, k, out, depth + 1);
        }
    }
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
    // K2 (P4a-2): a text the core places at its row's start is there, within the tolerance, with the anchor it gives
    for (i, t, r) in &rt {
        let at = t.g("at");
        if !at.truthy() {
            continue;
        }
        let (ax, ay) = (
            at.at(0).num().unwrap_or(f64::NAN),
            at.at(1).num().unwrap_or(f64::NAN),
        );
        let (hx, hy) = (coord(r, "x"), coord(r, "y"));
        if !((hx - ax).abs() <= meta.tol_px
            && (hy - ay).abs() <= meta.tol_px
            && r.g("anchor") == at.at(2))
        {
            out.push(format!(
                "K2 node {nid} {i}: ({hx:.3}, {hy:.3}) anchor {} drawn, its row's start is ({ax:.3}, {ay:.3}) anchor {}",
                r.g("anchor").repr(),
                at.at(2).repr()
            ));
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

// ================================================================================================================
// P4a-2: map circles (a node in a frame of kind view). The core computes the request's numbers (K3 each place's point,
// K7 the label subset, the label widths by the leaf's rule) and checks the node's reply (B0 widened by K9, B1, K4-K6, K8);
// a reply that passes is the placed geometry the leaf draws. Nothing here is read from a node but the reply.
// ================================================================================================================

/// Below this a recomputed number equals the reply's: the node computes in the same order (no rounding in between).
const CIRCLE_EPS: f64 = 1e-9;

/// K3: the map view's height and each place's point, as the map leaves project it (mapkit.View and prod.proj, in their
/// order): H = round(W (lat1 - lat0) / ((lon1 - lon0) cos(mid latitude + 2 deg))), the scale the smaller of the two fits.
pub fn view_projection(
    w: f64,
    ext: [f64; 4],
) -> Result<(f64, impl Fn(f64, f64) -> [f64; 2]), String> {
    let [lon0, lat0, lon1, lat1] = ext;
    if !(lon0 < lon1
        && lat0 < lat1
        && -180.0 <= lon0
        && lon1 <= 180.0
        && -90.0 <= lat0
        && lat1 <= 90.0)
    {
        return Err(format!(
            "view: ext {} must be [lon0, lat0, lon1, lat1] inside the globe",
            J::Arr(ext.iter().map(|x| J::Num(*x)).collect()).repr()
        ));
    }
    let k = ((lat0 + lat1) / 2.0 + 2.0).to_radians().cos();
    // Python's round: halves to even
    let h = (w * (lat1 - lat0) / ((lon1 - lon0) * k)).round_ties_even();
    let (a, b) = (w / ((lon1 - lon0) * k), h / (lat1 - lat0));
    let s = if b < a { b } else { a };
    Ok((h, move |lo: f64, la: f64| {
        [(lo - lon0) * k * s, (lat1 - la) * s]
    }))
}

/// K7: the label subset, of the codes largest first: the largest and the smallest, then the rest by size, `top` at most.
pub fn ends_then_largest(codes: &[String], top: usize) -> Vec<String> {
    let ends: Vec<String> = match codes {
        [] => vec![],
        [one] => vec![one.clone()],
        [first, .., last] => vec![first.clone(), last.clone()],
    };
    ends.iter()
        .cloned()
        .chain(codes.iter().filter(|c| !ends.contains(c)).cloned())
        .take(top)
        .collect()
}

/// A number as the request carries it: a whole one as an integer (as the registry gave it), else a float.
fn whole_or(x: f64) -> J {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        J::Int(x as i64)
    } else {
        J::Num(x)
    }
}

/// The request to a map circles node: its frame (the view's size, its land's inset), one mark per item largest first
/// (ties in the select's order) with its value and its point (K3), the label subset (K7) with each label's two widths (the
/// name's and the number's, by the leaf's rule tw_leaf), the knobs the registry lays it out by (each within the core's
/// bounds), and the land the leaf gave (ground: it only chooses among places the core holds equally good, never checked).
#[allow(clippy::too_many_arguments)]
fn circles_request(
    nid: &str,
    n: &J,
    e: &J,
    fr: &J,
    words: &Words<'_>,
    rows: &BTreeMap<String, &J>,
    got: &Got,
    inp: &J,
) -> Result<(J, Meta), String> {
    let kn = e.g("knobs");
    let knob = |k: &str| kn.g(k).num().ok_or_else(|| format!("knob {k}"));
    let w = fr.g("w").num().ok_or("view w")?;
    let (h, pin) = view_projection(w, four(n.g("geometry").g("ext"))?)?;
    let size = e.g("texts").g("size").num().ok_or("texts.size")?;
    let mut items: Vec<(String, f64, J, J)> = Vec::new();
    for it in n.g("items").arr() {
        let code = st(&resolve_sel(it.g("code"), got)?);
        let at = it.g("at");
        let (lon, lat) = (at.at(0).num().ok_or("at")?, at.at(1).num().ok_or("at")?);
        let p = pin(lon, lat);
        let src = it.g("value");
        let r = rows
            .get(&st(src))
            .copied()
            .ok_or_else(|| format!("'{}'", st(src)))?;
        // a circle's area is its value's size (11-07): a value below 0 is drawn by its size and outlined by the leaf
        // (bubbles.py), so the node lays out and K4 rechecks the size; the printed number stays the ledger's, sign and all
        items.push((
            code,
            num(r)?.abs(),
            J::Arr(vec![J::Num(p[0]), J::Num(p[1])]),
            it.g("value_text").clone(),
        ));
    }
    // largest first, a tie in the select's order (the leaf's stable sort by -value)
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|a, b| {
        items[*b]
            .1
            .partial_cmp(&items[*a].1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut meta = Meta::default();
    let marks: Vec<J> = order
        .iter()
        .map(|i| {
            let (code, v, p, _) = &items[*i];
            meta.marks.push((code.clone(), *i, None, false));
            J::obj_of(vec![
                ("id", J::str(code)),
                ("item", J::Int(*i as i64)),
                ("value", J::Num(*v)),
                ("pin", p.clone()),
            ])
        })
        .collect();
    let codes: Vec<String> = order.iter().map(|i| items[*i].0.clone()).collect();
    let mut texts = Vec::new();
    for c in ends_then_largest(&codes, knob("label_top")? as usize) {
        let it = items
            .iter()
            .find(|x| x.0 == c)
            .expect("a code of the items");
        let name = words.name(&c)?;
        let value = words.fact(st(&it.3).strip_prefix("fact:").unwrap_or(""), None)?;
        texts.push(J::obj_of(vec![
            ("id", J::str(&c)),
            ("w_name", J::Num(tw_leaf(&name, size))),
            ("w_value", J::Num(tw_leaf(&value, size))),
        ]));
        meta.texts
            .push((c.clone(), format!("{name} {value}"), it.3.clone()));
    }
    let req = J::obj_of(vec![
        ("node", n.g("node").clone()),
        (
            "frame",
            J::obj_of(vec![
                ("w", fr.g("w").clone()),
                ("h", whole_or(h)),
                ("top", J::Int(0)),
                ("inset", fr.g("inset").clone()),
            ]),
        ),
        ("marks", J::Arr(marks)),
        (
            "scale",
            J::obj_of(vec![
                ("r_max", kn.g("r_max").clone()),
                ("r_min", kn.g("r_min").clone()),
                ("step", whole_or(R_STEP_PX)),
                ("floor", whole_or(R_FLOOR_PX)),
                ("max_overlaps", kn.g("max_overlaps").clone()),
            ]),
        ),
        (
            "nudge",
            J::obj_of(vec![
                ("most", kn.g("nudge").clone()),
                ("gap", kn.g("circle_gap").clone()),
            ]),
        ),
        ("texts", J::Arr(texts)),
        (
            "labels",
            J::obj_of(vec![
                ("size", e.g("texts").g("size").clone()),
                ("gap", kn.g("label_gap").clone()),
                ("sep", kn.g("label_sep").clone()),
                ("reach", kn.g("reach").clone()),
                ("land_cost", kn.g("land_cost").clone()),
            ]),
        ),
        (
            "ground",
            inp.g("ground")
                .get(nid)
                .cloned()
                .unwrap_or_else(|| J::obj_of(vec![("land", J::Obj(vec![]))])),
        ),
    ]);
    Ok((req, meta))
}

/// K6: the area two circles (cx, cy, r) overlap by.
fn lens(a: (f64, f64, f64), b: (f64, f64, f64)) -> f64 {
    let d = (a.0 - b.0).hypot(a.1 - b.1);
    let (r1, r2) = (a.2, b.2);
    if d >= r1 + r2 {
        return 0.0;
    }
    let small = if r2 < r1 { r2 } else { r1 };
    if d <= (r1 - r2).abs() {
        return std::f64::consts::PI * small.powi(2);
    }
    let p = r1 * r1 * ((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1)).acos()
        + r2 * r2 * ((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2)).acos();
    p - 0.5 * ((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)).sqrt()
}

type Pt = (f64, f64);

/// K8: whether two leaders a-b and c-d cross (touching counts: two leaders may not meet either), as the leaf's mapkit.crosses.
fn crosses(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    let side = |p: Pt, q: Pt, r: Pt| (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
    let on = |p: Pt, q: Pt, r: Pt| {
        p.0.min(q.0) - 1e-9 <= r.0
            && r.0 <= p.0.max(q.0) + 1e-9
            && p.1.min(q.1) - 1e-9 <= r.1
            && r.1 <= p.1.max(q.1) + 1e-9
    };
    let (d1, d2, d3, d4) = (side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d));
    if ((d1 > 0.0) != (d2 > 0.0))
        && ((d3 > 0.0) != (d4 > 0.0))
        && d1 != 0.0
        && d2 != 0.0
        && d3 != 0.0
        && d4 != 0.0
    {
        return true;
    }
    [(d1, c, d, a), (d2, c, d, b), (d3, a, b, c), (d4, a, b, d)]
        .iter()
        .any(|(v, p, q, r)| v.abs() < 1e-9 && on(*p, *q, *r))
}

/// Points along a-b, `step` px apart at most, both ends included (the leaf samples its leaders and hairline so).
fn along(a: Pt, b: Pt, n: usize) -> impl Iterator<Item = Pt> {
    (0..=n).map(move |t| {
        (
            a.0 + (b.0 - a.0) * t as f64 / n as f64,
            a.1 + (b.1 - a.1) * t as f64 / n as f64,
        )
    })
}

fn pdist(a: Pt, b: Pt) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// B0 (widened by K9), B1, K4, K5, K6 and K8 over a map circles node's reply, in the reply's order; Ok is the placed
/// geometry the leaf draws ({order, marks, texts in the order placed, r_used, dropped, size}), or, when even the floor
/// overlaps more than max_overlaps pairs, {floor: {pairs, r_used, max_overlaps}}, which the leaf stops the page on in its
/// own words. A reply of the wrong form is not read further; nothing is repaired.
pub fn circles_problems(nid: &str, req: &J, rep: &J) -> Result<J, Vec<String>> {
    let (sc, nu, lb, fr) = (
        req.g("scale"),
        req.g("nudge"),
        req.g("labels"),
        req.g("frame"),
    );
    // B0: the request's knobs within the core's bounds (a second layer cannot widen them), the grid the core's
    let ntexts = req.g("texts").arr().len() as f64;
    let mut caps = circle_bound_problems(&format!("B0 request {nid}"), &|k| match k {
        "r_max" | "r_min" | "max_overlaps" => sc.g(k).num(),
        "nudge" => nu.g("most").num(),
        "circle_gap" => nu.g("gap").num(),
        "label_gap" => lb.g("gap").num(),
        "label_sep" => lb.g("sep").num(),
        "label_top" => Some(ntexts),
        _ => lb.g(k).num(),
    });
    if sc.g("floor").num() != Some(R_FLOOR_PX) || sc.g("step").num() != Some(R_STEP_PX) {
        caps.push(format!(
            "B0 request {nid} r_used grid: floor and step are the core's ({}, {})",
            py_float(R_FLOOR_PX),
            py_float(R_STEP_PX)
        ));
    }
    if !caps.is_empty() {
        return Err(caps);
    }
    let p = format!("B0 reply.{nid}");
    let J::Obj(top) = rep else {
        return Err(vec![format!("{p}: not an object")]);
    };
    if rep.has("refused") {
        return Err(vec![format!(
            "B7 node {nid} refused ({}): the page stops; nothing is dropped or repaired",
            rep.g("refused").repr()
        )]);
    }
    let mut bad: Vec<String> = top
        .iter()
        .filter(|(k, _)| !["marks", "texts", "dropped"].contains(&k.as_str()))
        .map(|(k, _)| format!("{p}.{k}: not a reply field (only marks, texts, dropped)"))
        .collect();
    let codes: Vec<String> = req.g("marks").arr().iter().map(|m| st(m.g("id"))).collect();
    let subset: Vec<String> = req.g("texts").arr().iter().map(|t| st(t.g("id"))).collect();
    let (marks, texts) = (rep.g("marks"), rep.g("texts"));
    if !marks.is_obj() || !texts.is_obj() || !rep.g("dropped").is_arr() {
        return Err(vec![format!(
            "{p}: marks and texts are objects keyed by issued id, dropped a list"
        )]);
    }
    let dropped: Vec<String> = rep.g("dropped").arr().iter().map(st).collect();
    for (k, _) in marks.obj() {
        let base = k
            .strip_suffix("/dot")
            .or_else(|| k.strip_suffix("/leader"))
            .unwrap_or(k);
        if !codes.iter().any(|c| c == base) {
            bad.push(format!(
                "{p}.marks.{k}: not an id the core issued to this node"
            ));
        }
    }
    for (k, _) in texts.obj() {
        if !subset.contains(k) {
            bad.push(format!(
                "{p}.texts.{k}: not an id the core issued to this node"
            ));
        }
    }
    // K9: a label of the subset is placed or listed as dropped, never both, the dropped in the subset's order
    let listed: Vec<&String> = subset.iter().filter(|c| dropped.contains(c)).collect();
    if listed.len() != dropped.len() || listed.iter().zip(&dropped).any(|(a, b)| *a != b) {
        bad.push(format!(
            "K9 node {nid} dropped {}: not ids of the label subset in its order",
            J::strs(&dropped).repr()
        ));
    }
    for c in &subset {
        match (texts.has(c), dropped.contains(c)) {
            (true, true) => bad.push(format!("K9 node {nid} label {c}: both placed and dropped")),
            (false, false) => bad.push(format!(
                "K9 node {nid} label {c}: neither placed nor listed as dropped"
            )),
            _ => {}
        }
    }
    if !bad.is_empty() {
        return Err(bad);
    }
    // B1: every mark the shape and fields its id stands for (a circle, a dot, a leader), every text at x, y with an anchor
    for (k, m) in marks.obj() {
        let (shape, fields) = if k.ends_with("/leader") {
            ("line", &["x1", "y1", "x2", "y2"][..])
        } else {
            ("circle", &["cx", "cy", "r"][..])
        };
        let mut keys: Vec<&str> = m.obj().iter().map(|(f, _)| f.as_str()).collect();
        keys.sort();
        let mut want: Vec<&str> = fields.iter().copied().chain(["shape"]).collect();
        want.sort();
        if m.g("shape").s() != Some(shape)
            || keys != want
            || !fields.iter().all(|f| m.g(f).finite())
        {
            bad.push(format!(
                "B1 node {nid} mark {k}: no {shape} {}",
                fields.join(", ")
            ));
        }
    }
    for c in &codes {
        if !marks.has(c) {
            bad.push(format!("B1 node {nid} mark {c}: no circle cx, cy, r"));
        }
    }
    for (k, t) in texts.obj() {
        let mut keys: Vec<&str> = t.obj().iter().map(|(f, _)| f.as_str()).collect();
        keys.sort();
        if keys != ["anchor", "x", "y"]
            || !t.g("x").finite()
            || !t.g("y").finite()
            || !t.g("anchor").s().is_some_and(|a| ANCHORS.contains(&a))
        {
            bad.push(format!("B1 node {nid} text {k}: no x, y, anchor"));
        }
    }
    if !bad.is_empty() {
        return Err(bad);
    }
    let n = |o: &J, f: &str| o.g(f).num().unwrap_or(f64::NAN);
    let by: Vec<(&J, &J)> = req
        .g("marks")
        .arr()
        .iter()
        .map(|m| (m, marks.g(&st(m.g("id")))))
        .collect();
    let circ: Vec<(f64, f64, f64)> = by
        .iter()
        .map(|(_, m)| (n(m, "cx"), n(m, "cy"), n(m, "r")))
        .collect();
    // K4: r_used the largest circle's radius, on the core's grid from the registry's r_max down; each r by its area
    let (r_max, r_min, step, floor) = (n(sc, "r_max"), n(sc, "r_min"), R_STEP_PX, R_FLOOR_PX);
    let vmax = by
        .iter()
        .map(|(q, _)| n(q, "value"))
        .fold(f64::NEG_INFINITY, |a, b| if b > a { b } else { a });
    let r_used = circ.first().map_or(f64::NAN, |c| c.2);
    let grid: Vec<f64> = (0..=((r_max - floor) / step) as usize)
        .map(|j| r_max - j as f64 * step)
        .collect();
    let on_grid = grid
        .iter()
        .copied()
        .find(|g| (r_used - g).abs() <= CIRCLE_EPS);
    if on_grid.is_none() {
        bad.push(format!(
            "K4 node {nid} r_used {}: not on the core's grid {}",
            py_float(r_used),
            J::Arr(grid.iter().map(|g| J::Num(*g)).collect()).repr()
        ));
    }
    let denom = if vmax == 0.0 { 1.0 } else { vmax };
    for ((q, _), c) in by.iter().zip(&circ) {
        let a = r_used * (n(q, "value") / denom).sqrt();
        let want = if a > r_min { a } else { r_min };
        if (c.2 - want).abs() > CIRCLE_EPS {
            bad.push(format!(
                "K4 node {nid} mark {}: r {} is not {}",
                st(q.g("id")),
                py_float(c.2),
                py_float(want)
            ));
        }
    }
    // K5: each circle within `most` px of its point; one moved over DOT_OVER_PX keeps a DOT_R_PX dot exactly at it, no other
    let most = n(nu, "most");
    for ((q, _), c) in by.iter().zip(&circ) {
        let id = st(q.g("id"));
        let (px, py) = (
            q.g("pin").at(0).num().unwrap_or(f64::NAN),
            q.g("pin").at(1).num().unwrap_or(f64::NAN),
        );
        let off = pdist((c.0, c.1), (px, py));
        if !(off <= most + CIRCLE_EPS) {
            bad.push(format!(
                "K5 node {nid} mark {id}: {off:.3} px off its point, most {}",
                py_float(most)
            ));
        }
        let dot = marks.get(&format!("{id}/dot"));
        if (off > DOT_OVER_PX) != dot.is_some() {
            bad.push(format!(
                "K5 node {nid} mark {id}: moved {off:.3} px {} a dot at its point",
                if dot.is_some() { "with" } else { "without" }
            ));
        }
        if let Some(d) = dot {
            if !(n(d, "cx") == px && n(d, "cy") == py && n(d, "r") == DOT_R_PX) {
                bad.push(format!(
                    "K5 node {nid} dot {id}: not a {} px circle at the point",
                    py_float(DOT_R_PX)
                ));
            }
        }
    }
    // K6: pairs overlapping by over half the smaller circle; past max_overlaps only at the floor, which the leaf stops on
    let mut pairs = Vec::new();
    for a in 0..circ.len() {
        for b in a + 1..circ.len() {
            let small = if circ[b].2 < circ[a].2 {
                circ[b].2
            } else {
                circ[a].2
            };
            if lens(circ[a], circ[b]) > 0.5 * std::f64::consts::PI * small.powi(2) {
                pairs.push(J::strs(&[codes[a].clone(), codes[b].clone()]));
            }
        }
    }
    let r_used_j = match (on_grid, sc.g("r_max")) {
        (Some(g), J::Int(_)) => whole_or(g),
        (Some(g), _) => J::Num(g),
        (None, _) => J::Num(r_used),
    };
    if pairs.len() as f64 > n(sc, "max_overlaps") {
        if r_used - step < floor {
            if !bad.is_empty() {
                return Err(bad);
            }
            return Ok(J::obj_of(vec![(
                "floor",
                J::obj_of(vec![
                    ("pairs", J::Arr(pairs)),
                    ("r_used", r_used_j),
                    ("max_overlaps", sc.g("max_overlaps").clone()),
                ]),
            )]));
        }
        bad.push(format!(
            "K6 node {nid}: {} pairs overlap by over half the smaller at r_used {}, a step above the floor: the node stopped stepping down early",
            pairs.len(),
            py_float(r_used)
        ));
    }
    // K8: each label, in the order placed, beside its circle or at the end of a leader from its edge, clear as the leaf
    // holds a label clear (its free and clear_lead): of the frame's edge, the labels and leaders before it, every circle
    // and dot; its leader of every other circle and dot, the leaders and labels before it
    let (sz, gap, sep, reach) = (n(lb, "size"), n(lb, "gap"), n(lb, "sep"), n(lb, "reach"));
    let (w, h, top_y, inset) = (n(fr, "w"), n(fr, "h"), n(fr, "top"), n(fr, "inset"));
    let widths: Vec<(String, f64, f64)> = req
        .g("texts")
        .arr()
        .iter()
        .map(|t| (st(t.g("id")), n(t, "w_name"), n(t, "w_value")))
        .collect();
    let dots: Vec<(f64, f64, f64, &str)> = codes
        .iter()
        .filter_map(|c| {
            marks
                .get(&format!("{c}/dot"))
                .map(|d| (n(d, "cx"), n(d, "cy"), DOT_R_PX, c.as_str()))
        })
        .collect();
    let rings: Vec<(f64, f64, f64, &str)> = circ
        .iter()
        .zip(&codes)
        .map(|(c, k)| (c.0, c.1, c.2, k.as_str()))
        .collect();
    let (mut tboxes, mut segs, mut leads): (Vec<Bx>, Vec<(Pt, Pt)>, Vec<Pt>) =
        (Vec::new(), Vec::new(), Vec::new());
    if inset != 0.0 {
        let e = inset;
        let corners = [(e, e), (w - e, e), (w - e, h - e), (e, h - e), (e, e)];
        for pair in corners.windows(2) {
            let steps = ((pdist(pair[0], pair[1]) / 4.0).ceil() as usize).max(1);
            leads.extend(along(pair[0], pair[1], steps));
        }
    }
    let x_of = |anchor: &str, x: f64, wd: f64| match anchor {
        "start" => x,
        "end" => x - wd,
        _ => x - wd / 2.0,
    };
    for (c, t) in texts.obj() {
        let i = codes
            .iter()
            .position(|k| k == c)
            .expect("a subset id is a mark id");
        let (x, y, r) = circ[i];
        let (tx, ty, anchor) = (n(t, "x"), n(t, "y"), t.g("anchor").s().unwrap_or(""));
        let g = gap + 1.0;
        let ln = marks.get(&format!("{c}/leader"));
        match ln {
            None => {
                let places = [
                    ("start", x + r + g, y - sz * 0.2),
                    ("end", x - r - g, y - sz * 0.2),
                    ("middle", x, y - r - g - sz * 1.65),
                    ("middle", x, y + r + g + sz * 0.8),
                ];
                if !places.iter().any(|(a, px, py)| {
                    *a == anchor && (tx - px).abs() <= CIRCLE_EPS && (ty - py).abs() <= CIRCLE_EPS
                }) {
                    bad.push(format!(
                        "K8 node {nid} label {c}: not beside its circle and no leader"
                    ));
                }
            }
            Some(l) => {
                let mut hit = false;
                for d in (16..=(reach as i64)).step_by(8) {
                    let d = d as f64;
                    for k in 0..16 {
                        let ang = std::f64::consts::PI * k as f64 / 8.0;
                        let (co, si) = (ang.cos(), ang.sin());
                        let (a0, b0) = (
                            (x + r * co, y + r * si),
                            (x + (r + d) * co, y + (r + d) * si),
                        );
                        let want = if co > 0.3 {
                            "start"
                        } else if co < -0.3 {
                            "end"
                        } else {
                            "middle"
                        };
                        let tp = if si > 0.3 {
                            b0.1 + sz * 0.3
                        } else if si < -0.3 {
                            b0.1 - sz * 2.45
                        } else {
                            b0.1 - sz * 1.2
                        };
                        let near = |a: f64, b: f64| (a - b).abs() <= CIRCLE_EPS;
                        if near(n(l, "x1"), a0.0)
                            && near(n(l, "y1"), a0.1)
                            && near(n(l, "x2"), b0.0)
                            && near(n(l, "y2"), b0.1)
                            && anchor == want
                            && near(tx, b0.0)
                            && near(ty, tp + sz * 0.8)
                        {
                            hit = true;
                        }
                    }
                }
                if !hit {
                    bad.push(format!("K8 node {nid} label {c}: its leader does not start on its circle's edge or the label is not at its end"));
                }
            }
        }
        let (_, wn, wv) = widths
            .iter()
            .find(|x| x.0 == *c)
            .cloned()
            .expect("a subset id has its widths");
        let wmax = if wv > wn { wv } else { wn };
        let x0 = x_of(anchor, tx, wmax);
        let bx: Bx = (x0, ty - sz * 0.8, x0 + wmax, ty + sz * 1.65);
        if bx.0 < 2.0 || bx.2 > w - 2.0 || bx.1 < top_y - 4.0 || bx.3 > h - 2.0 {
            bad.push(format!("K8 node {nid} label {c}: outside the frame"));
        }
        if tboxes.iter().any(|b| {
            bx.0 < b.2 + sep && b.0 < bx.2 + sep && bx.1 < b.3 + sep / 2.0 && b.1 < bx.3 + sep / 2.0
        }) {
            bad.push(format!(
                "K8 node {nid} label {c}: within {} px of a label before it",
                py_float(sep)
            ));
        }
        if leads.iter().any(|(px, py)| {
            bx.0 - 1.0 < *px && *px < bx.2 + 1.0 && bx.1 - 1.0 < *py && *py < bx.3 + 1.0
        }) {
            bad.push(format!(
                "K8 node {nid} label {c}: over a leader or the frame's hairline"
            ));
        }
        let clear = |cx: f64, cy: f64| {
            pmax(pmax(bx.0 - cx, 0.0), cx - bx.2).hypot(pmax(pmax(bx.1 - cy, 0.0), cy - bx.3))
        };
        if rings
            .iter()
            .chain(&dots)
            .any(|(cx, cy, rr, _)| clear(*cx, *cy) < rr + gap)
        {
            bad.push(format!(
                "K8 node {nid} label {c}: within {} px of a circle or dot",
                py_float(gap)
            ));
        }
        if let Some(l) = ln {
            let (a, b) = ((n(l, "x1"), n(l, "y1")), (n(l, "x2"), n(l, "y2")));
            let steps = ((pdist(a, b) / 2.0).ceil() as usize).max(2);
            let pts: Vec<Pt> = along(a, b, steps).collect();
            if pts.iter().any(|p| {
                rings
                    .iter()
                    .any(|(cx, cy, rr, o)| *o != c.as_str() && pdist(*p, (*cx, *cy)) < rr + 1.0)
            }) {
                bad.push(format!("K8 node {nid} leader {c}: over another circle"));
            }
            if pts.iter().any(|p| {
                dots.iter()
                    .any(|(dx, dy, dr, o)| *o != c.as_str() && pdist(*p, (*dx, *dy)) < dr + 1.0)
            }) {
                bad.push(format!("K8 node {nid} leader {c}: over a dot"));
            }
            if segs.iter().any(|(s0, s1)| crosses(a, b, *s0, *s1)) {
                bad.push(format!(
                    "K8 node {nid} leader {c}: crosses a leader before it"
                ));
            }
            if pts.iter().any(|p| {
                tboxes.iter().any(|t| {
                    t.0 - 1.0 < p.0 && p.0 < t.2 + 1.0 && t.1 - 1.0 < p.1 && p.1 < t.3 + 1.0
                })
            }) {
                bad.push(format!("K8 node {nid} leader {c}: over a label before it"));
            }
            leads.extend(pts);
            segs.push((a, b));
        }
        for (wd, yy) in [(wn, ty), (wv, ty + sz * 1.4)] {
            let x0 = x_of(anchor, tx, wd);
            tboxes.push((x0, yy - sz * 0.8, x0 + wd, yy + sz * 0.25));
        }
    }
    if !bad.is_empty() {
        return Err(bad);
    }
    // the texts as a list in the order placed (an object's order does not survive every JSON map the placed geometry
    // passes through on its way to the leaf), each with its circle's code
    let placed_texts = texts
        .obj()
        .iter()
        .map(|(c, t)| J::Obj(std::iter::once(("id".to_string(), J::str(c))).chain(t.obj().iter().cloned()).collect()))
        .collect();
    Ok(J::obj_of(vec![
        ("order", J::strs(&codes)),
        ("marks", marks.clone()),
        ("texts", J::Arr(placed_texts)),
        ("r_used", r_used_j),
        ("dropped", J::strs(&dropped)),
        ("size", lb.g("size").clone()),
    ]))
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
/// text at the reply's position, its words and source from the core's record. Nothing the node sent is printed. A mark a
/// scale paints takes its class tag, colour and outline from the core's scale record and the palette file, the text it
/// prints the ink for that colour, and the legend follows the texts; a mark no scale paints is drawn as before R11.
pub fn svg(nid: &str, req: &J, reply: &J, meta: &Meta) -> String {
    let pf = palettes();
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
        match meta.paint.as_ref().and_then(|p| p.cells.iter().find(|c| c.id == *id).map(|c| (p, c))) {
            Some((p, c)) => {
                let _ = write!(out, "{el} class=\"mark paint\" data-id=\"{}\"{part}{}/>", xml(id), p.mark_attrs(c, pf));
            }
            None => {
                let _ = write!(out, "{el} class=\"{class}\" data-id=\"{}\"{part}/>", xml(id));
            }
        }
    }
    for (id, printed, src) in &meta.texts {
        let t = reply.g("texts").g(id);
        let src = match src {
            J::Str(s) => s.clone(),
            other => other.dump(),
        };
        let ink = meta.paint.as_ref().and_then(|p| p.cells.iter().find(|c| c.text_id.as_deref() == Some(id.as_str())).map(|c| (p, c)));
        let ink = ink.map_or(String::new(), |(p, c)| format!(" fill=\"{}\"", ink_on(p.paint_of(c, pf).1, pf)));
        let _ = write!(
            out,
            "<text x=\"{}\" y=\"{}\" text-anchor=\"{}\" data-id=\"{}\" data-src=\"{}\"{ink}>{}</text>",
            num_attr(coord(t, "x")),
            num_attr(coord(t, "y")),
            xml(&st(t.g("anchor"))),
            xml(id),
            xml(&src),
            xml(printed)
        );
    }
    if let Some(p) = &meta.paint {
        out.push_str(&p.legend_svg(pf));
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
    if out.is_empty() {
        for (nid, req) in &reqs {
            out.extend(colour_problems(&svg(nid, req, reply.g(nid), &metas[nid]), &metas[nid]));
        }
    }
    Ok(out)
}

// ================================================================================================================
// The visual group's NodeDraw (P4a): one external node asked over the page tree the generator wrote (next_tree_gen), its
// geometry checked, and the checked geometry handed to the leaf that draws the layer.
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
pub(crate) fn registry_in_force() -> (J, Option<crate::next_leaf::Runner>) {
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

/// One external node drawn over the core's page tree (Request::NodeDraw, P4a): the geometry the core checked, as the leaf
/// that draws the layer reads it (`placed`), and the child's and the core's milliseconds.
#[derive(Debug, Clone)]
pub struct NodeDrawn {
    /// {"items": [{"code", "mark": {field: value}, "texts": {name: {x, y, anchor, src}}}]}, item by item in the core's order:
    /// each code is the core's select result, each src the core's record of what the text prints, each number the node's
    /// own reply that passed B0-B7 (none rounded or rewritten).
    pub placed: J,
    pub child_ms: u64,
    pub recheck_ms: u64,
}

fn node_in<'a>(spec: &'a J, id: &str) -> Option<&'a J> {
    walk(spec.g("body"), "$").into_iter().map(|(_, n)| n).find(|n| n.g("kind").s() == Some("Node") && n.g("id").s() == Some(id))
}

/// The checked geometry as the leaf reads it, from the core's own record (meta) and its select results (got); the
/// coordinates are the reply's, which passed B0-B7.
fn placed_of(n: &J, reply: &J, meta: &Meta, got: &Got) -> Result<J, String> {
    let mut items: Vec<J> = Vec::new();
    for (i, it) in n.g("items").arr().iter().enumerate() {
        let code = resolve_sel(it.g("code"), got)?;
        let mut mark = J::Obj(vec![]);
        if let Some((id, ..)) = meta.marks.iter().find(|m| m.1 == i && m.2.is_none()) {
            for (f, v) in reply.g("marks").g(id).obj() {
                if f != "shape" {
                    mark.set(f, v.clone());
                }
            }
        }
        let prefix = format!("{}/{i}/", st(n.g("id")));
        // in the core's order (the registry's), which the leaf prints them in and the drawn check reads them back in
        let mut texts = Vec::new();
        for (tid, _, src) in &meta.texts {
            let Some(name) = tid.strip_prefix(&prefix) else { continue };
            let mut t = reply.g("texts").g(tid).clone();
            t.set("name", J::str(name));
            t.set("src", src.clone());
            texts.push(t);
        }
        items.push(J::obj_of(vec![("code", code), ("mark", mark), ("texts", J::Arr(texts))]));
    }
    Ok(J::obj_of(vec![("items", J::Arr(items))]))
}

/// Request::NodeDraw: the external node `node` of the core's page tree (`inp`: {page_spec, rows, name_table, points,
/// given, select_spec, knobs, drawn_rules, word_table}, as next_tree_gen::tree writes it) asked for its geometry by its
/// registered runner under `runtime`, everything checked (C1-C5 before the child starts, B0-B7 and the colour checks on its
/// reply). Err lists every failure, one per line; nothing is repaired and nothing falls back to a rust fill.
pub fn node_draw(node: &str, inp: &J, runtime: &std::path::Path) -> Result<NodeDrawn, String> {
    let started = std::time::Instant::now();
    let spec = inp.g("page_spec");
    let n = node_in(spec, node).ok_or_else(|| format!("node {node}: the page tree has no node {node}"))?;
    let (reg, runner_override) = registry_in_force();
    let entry = reg.g("nodes").g(&st(n.g("node")));
    if entry.g("binding").s() != Some("external") {
        return Err(format!("node {node}: the registry binds {} rust, not external", st(n.g("node"))));
    }
    let ext = vec![node.to_string()];
    let (errs, content) = content_problems(spec, inp, &ext, &reg);
    let Some(content) = content else { return Err(errs.iter().map(|e| format!("node {node}: recheck: {e}")).collect::<Vec<_>>().join("\n")) };
    let (reqs, metas) = issue(spec, inp, &reg, &ext, &content.got, &content.rpage).map_err(|e| format!("node {node}: recheck: {e}"))?;
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
    let lines = |fails: Vec<String>| fails.iter().map(|e| format!("node {node}: recheck: {e}")).collect::<Vec<_>>().join("\n");
    // a map circles node (P4a-2): its own checks, K3-K9; the placed geometry is the checked reply
    if reqs[0].1.has("scale") {
        let placed = circles_problems(node, &reqs[0].1, &reply).map_err(lines)?;
        let recheck_ms = (before_child + after_child.elapsed()).as_millis() as u64;
        return Ok(NodeDrawn { placed, child_ms: child_ms as u64, recheck_ms });
    }
    let replies = J::Obj(vec![(node.to_string(), reply)]);
    let mut fails = reply_problems(&replies, &reqs);
    if fails.is_empty() {
        fails = geometry_problems(node, &reqs[0].1, replies.g(node), &metas[node]).map_err(|e| format!("node {node}: recheck: {e}"))?;
    }
    if fails.is_empty() {
        fails = colour_problems(&svg(node, &reqs[0].1, replies.g(node), &metas[node]), &metas[node]);
    }
    if !fails.is_empty() {
        return Err(fails.iter().map(|e| format!("node {node}: recheck: {e}")).collect::<Vec<_>>().join("\n"));
    }
    let mut placed = placed_of(n, replies.g(node), &metas[node], &content.got).map_err(|e| format!("node {node}: recheck: {e}"))?;
    // K11: the bars' zero line, the core's own (the leaf draws it there; the bars' ends were checked against it)
    let req = &reqs[0].1;
    if req.g("encode").arr().iter().any(|c| c.g("channel").s() == Some("length_signed")) {
        let values: Vec<f64> = req.g("marks").arr().iter().filter_map(|m| m.g("value").num()).collect();
        if let Some((z, _)) = signed_bars(req.g("rows"), &values) {
            placed.set("axis", J::obj_of(vec![("x", J::Num(z))]));
        }
    }
    Ok(NodeDrawn {
        placed,
        child_ms: child_ms as u64,
        recheck_ms: (before_child + after_child.elapsed()).as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An asked record as the catalogue writes it (l5geo Asked): the family id, its page name, its table prefixes and the
    /// offered tables that hold it.
    fn asked_rec(id: &str, tables: &[&str], offered: &[&str]) -> J {
        J::obj_of(vec![("id", J::str(id)), ("zh", J::str(id)), ("tables", J::strs(tables)), ("offered", J::strs(offered))])
    }

    /// A page tree's drawn record, one row per (layer, table), and the envelope over it holding the asked records (the flow's
    /// copy, `asked`) and the leaf's spec's (`leaf_asked`); None leaves the field out.
    fn asked_page(drawn: &[(&str, &str)], asked: Option<Vec<J>>, leaf: Option<Vec<J>>) -> (J, J) {
        let rows: Vec<J> = drawn
            .iter()
            .map(|(layer, table)| J::obj_of(vec![("layer", J::str(layer)), ("src", J::Str(format!("series:{table}/DE:2024:OBS_VALUE"))), ("table", J::str(table)), ("time", J::str("2024"))]))
            .collect();
        let spec = J::obj_of(vec![("kind", J::str("Page")), ("record", J::obj_of(vec![("drawn", J::Arr(rows))]))]);
        let mut inp = J::obj_of(vec![("page_spec", spec.clone())]);
        for (k, v) in [("asked", asked), ("leaf_asked", leaf)] {
            if let Some(v) = v {
                inp.set(k, J::Arr(v));
            }
        }
        (spec, inp)
    }

    /// C6 on two-quantity questions written here, no sealed text ("各国碳排放和老年人口占比，哪一个涨得更快？", "欧盟各国的庇护申请
    /// 和人口变化"). A page passes when each asked quantity is drawn (a drawn row from a table its prefixes start) or, when no
    /// offered table holds it, named by the leaf's unanswered line; one drawn and the other neither drawn nor lined is refused;
    /// a line for a quantity a table was offered for does not stand; a page with no asked field, or an empty one, passes as
    /// before; and the leaf's record must be the catalogue's.
    #[test]
    fn c6_each_asked_quantity_is_drawn_or_named_unanswered_where_no_table_was_offered() {
        let co2 = asked_rec("co2", &["EN.GHG.", "env_air_gge"], &["EN.GHG.CO2.PC.CE.AR5@2"]);
        let pop65 = asked_rec("pop65", &["SP.POP.65UP", "demo_pjanind"], &["SP.POP.65UP.TO.ZS@2"]);
        let run = |drawn: &[(&str, &str)], asked: Vec<J>| {
            let (spec, inp) = asked_page(drawn, Some(asked.clone()), Some(asked));
            asked_problems(&spec, &inp)
        };
        // both drawn: pass
        let both = [("bars", "EN.GHG.CO2.PC.CE.AR5@2"), ("bubbles", "SP.POP.65UP.TO.ZS@2")];
        assert_eq!(run(&both, vec![co2.clone(), pop65.clone()]), Vec::<String>::new());
        // one drawn, the other with no offered table and the leaf's line: pass
        let asylum = asked_rec("asylum", &["migr_asy"], &["migr_asyappctza"]);
        let population = asked_rec("population", &["SP.POP.TOTL", "demo_pjan", "demo_gind"], &[]);
        assert_eq!(run(&[("bars", "migr_asyappctza")], vec![asylum.clone(), population.clone()]), Vec::<String>::new());
        // one drawn, the other offered a table but not drawn, so no line stands for it: refused, naming it and its tables
        let off = run(&[("bars", "EN.GHG.CO2.PC.CE.AR5@2")], vec![co2.clone(), pop65.clone()]);
        assert_eq!(off, vec!["C6: the question asks for pop65 but the page draws no row from SP.POP.65UP, demo_pjanind".to_string()]);
        // one drawn, the other with no offered table but no line on the page (the leaf's spec lacks it): refused
        let (spec, inp) = asked_page(&[("bars", "migr_asyappctza")], Some(vec![asylum.clone(), population.clone()]), Some(vec![asylum.clone()]));
        let off = asked_problems(&spec, &inp);
        assert!(off.len() == 1 && off[0].ends_with("and carries no unanswered line for it"), "{off:?}");
        // the line refused: the leaf's spec says no table was offered for pop65, the catalogue's record offered one
        let unoffered = asked_rec("pop65", &["SP.POP.65UP", "demo_pjanind"], &[]);
        let (spec, inp) = asked_page(&[("bars", "EN.GHG.CO2.PC.CE.AR5@2")], Some(vec![co2.clone(), pop65.clone()]), Some(vec![co2.clone(), unoffered]));
        let off = asked_problems(&spec, &inp);
        assert_eq!(off.len(), 2, "{off:?}");
        assert!(off[0].contains("its unanswered line does not stand, as SP.POP.65UP.TO.ZS@2 was offered for it"), "{off:?}");
        assert!(off[1].starts_with("C6: the leaf's asked ") && off[1].ends_with("is not the catalogue's record"), "{off:?}");
        // a change page (user 11-05 17:1x, C): bars print val1 - val0 from the asked table and draw no row of their own; the
        // printed change draws its table, on a Eurostat shape and a World Bank shape alike; a page that prints only a count of
        // places, or a change from another table, is refused as before
        let ghg = asked_rec("co2", &["EN.GHG.", "env_air_gge"], &["env_air_gge", "sdg_13_10"]);
        for table in ["sdg_13_10", "EN.GHG.CO2.PC.CE.AR5@2"] {
            let change = |table: &str, printed: &str| {
                let (mut spec, inp) = asked_page(&[], Some(vec![ghg.clone()]), Some(vec![ghg.clone()]));
                let fact = |t: &str, time: &str| J::obj_of(vec![("each", J::str("geo")), ("table", J::str(t)), ("time", J::str(time))]);
                let facts = J::obj_of(vec![
                    ("val0", fact(table, "2015")),
                    ("val1", fact(table, "2023")),
                    ("chg", J::obj_of(vec![("op", J::str("minus")), ("each", J::str("geo")), ("a", J::str("val0")), ("b", J::str("val1"))])),
                    ("drawn", J::obj_of(vec![("op", J::str("n")), ("table", J::str(table)), ("time", J::str("2023"))])),
                ]);
                spec.set("facts", J::obj_of(vec![("facts", facts)]));
                spec.set("body", J::obj_of(vec![("kind", J::str("Text")), ("runs", J::Arr(vec![J::obj_of(vec![("src", J::str(printed))])]))]));
                asked_problems(&spec, &inp)
            };
            assert_eq!(change(table, "fact:chg.DE"), Vec::<String>::new(), "{table}");
            assert_eq!(change(table, "fact:drawn").len(), 1, "{table}: a count of places draws nothing");
            assert_eq!(change("sdg_07_40", "fact:chg.DE").len(), 1, "a change from another table");
        }
        // no asked field, an empty one, or one quantity drawn: as before
        let (spec, inp) = asked_page(&[("bars", "sdg_07_40")], None, None);
        assert_eq!(asked_problems(&spec, &inp), Vec::<String>::new());
        assert_eq!(run(&[("bars", "sdg_07_40")], Vec::new()), Vec::<String>::new());
        let ren = asked_rec("renewable_share", &["sdg_07_40", "nrg_ind_ren"], &["sdg_07_40"]);
        assert_eq!(run(&[("bars", "sdg_07_40")], vec![ren]), Vec::<String>::new());
        // a prefix matches the table id's start only
        assert_eq!(run(&[("bars", "XEN.GHG.CO2")], vec![co2]).len(), 1);
        // a table the catalogue offered for the quantity (its title names it) counts as drawn, though no prefix starts it
        let asylum_tps = asked_rec("asylum", &["migr_asy"], &["tps00191", "migr_asyappctza"]);
        let pop_offered = asked_rec("population", &["SP.POP.TOTL", "demo_pjan", "demo_gind"], &["demo_gind"]);
        assert_eq!(run(&[("bars", "tps00191"), ("bubbles", "demo_gind")], vec![asylum_tps.clone(), pop_offered.clone()]), Vec::<String>::new());
        // the stand-in's page (11-05): asylum from tps00191, population offered but not drawn: only population is refused
        let off = run(&[("bars", "tps00191")], vec![asylum_tps, pop_offered]);
        assert_eq!(off, vec!["C6: the question asks for population but the page draws no row from SP.POP.TOTL, demo_pjan, demo_gind".to_string()]);
    }
    use std::path::{Path, PathBuf};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p3b")
    }

    /// 11-03: every recipe of the registry in force names its main chart, a layer of it never registered wholly reference;
    /// the four the leaf's run.py MAIN names agree with it (column, change, flow, composition); scmp takes the map (the
    /// flowmap of the headline's year, the strip under it the month profile) and ring the ring (it wraps the page, the
    /// map inside it is the locator of each source's volume; owner 11-03 15:0x).
    #[test]
    fn every_recipe_names_its_main_chart_and_the_leafs_main_agrees() {
        let (reg, _) = registry_in_force();
        let recipes: Vec<String> = reg.g("recipes").obj().iter().map(|(k, _)| k.clone()).collect();
        let mut mains = Vec::new();
        for r in &recipes {
            let (main, _) = recipe_roles(&reg, r).unwrap_or_else(|e| panic!("{e}"));
            mains.push(format!("{r}={main}"));
        }
        assert_eq!(mains, ["column=bars", "change=bars", "composition=stacked100", "scmp=map", "ring=ring", "flow=sankey", "ranked_bars=bars", "block_ranks=rank_lines", "composition_steps=waterfall", "one_line=line"]);
        let run_py = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/leaves_py/run.py")).unwrap();
        let line = run_py.lines().find(|l| l.starts_with("MAIN = dict(")).expect("run.py MAIN");
        let pairs: Vec<&str> = line.trim_start_matches("MAIN = dict(").trim_end_matches(')').split(", ").collect();
        assert_eq!(pairs.len(), 8, "{line}");
        for pair in pairs {
            let (r, n) = pair.split_once('=').unwrap();
            assert_eq!(reg.g("main_chart").g(r).s(), Some(n.trim_matches('"')), "run.py MAIN {pair}");
        }
    }

    /// 11-03: the roles' rules refuse each way a registry breaks them (no main chart, a main chart of no layer, a main chart
    /// wholly reference, a role that is no reference, a reference with no legend word, a word the table lacks, no legend it
    /// sits within, a placeholder filled no known way), take a part of the main chart as reference (the map's earlier-year
    /// halo), and a published page lacks each legend line that is not the registry's word inside its legend: missing, its
    /// text changed (a literal, an entry of another kind, a unit of no format, more text), or outside the legend.
    #[test]
    fn a_reference_layer_names_its_legend_and_the_main_chart_is_never_wholly_one() {
        let halo = r#"{"word": "halo.t0", "within": "map", "fills": {"y": "period", "name": "name", "val": "fact_unit"},
            "draws": {"table": "data.q.table", "time": "data.t0", "family": "data.legend_fact"},
            "entries": {"y": "period:{table}:{time}", "val": "fact:{family}.{code}.n", "name": "name:{names}:{code}"}}"#;
        let reg = |main: &str, roles: &str| {
            let map = format!(r#"{{"roles": {{"ring": {{"parts": {{"halo": {{"role": "reference", "legend": {halo}}}}}}}}}}}"#);
            parse(&format!(r#"{{"recipes": {{"ring": ["map", "ring"]}}, "main_chart": {{"ring": {main}}}, "nodes": {{"map": {map}, "ring": {{"roles": {{"ring": {roles}}}}}}}}}"#)).unwrap()
        };
        let strip = r#"{"role": "reference", "legend": {"word": "scmp.strip.peak", "within": "strip", "fills": {"t": "period", "v": "fact_unit"},
            "draws": {"span": {"q": "strip.q", "from": "strip.from", "to": "strip.to"}, "peak": "strip.peak"},
            "entries": {"t": "period:{table}:{last}.y", "v": "fact:{peak}.n"}}}"#;
        let good = reg(r#""map""#, strip);
        let (main, refs) = recipe_roles(&good, "ring").unwrap();
        assert_eq!(main, "map");
        assert_eq!(refs, [("map.halo".to_string(), "halo.t0".to_string()), ("ring".to_string(), "scmp.strip.peak".to_string())]);
        for (what, bad, says) in [
            ("no main chart", reg("null", strip), "names no main chart"),
            ("a main chart of no layer", reg(r#""bars""#, strip), "is no layer of it"),
            ("the main chart wholly reference", reg(r#""ring""#, strip), "wholly reference"),
            ("a role that is no reference", reg(r#""map""#, &strip.replace("\"reference\"", "\"aux\"")), "the only role"),
            ("no legend word", reg(r#""map""#, r#"{"role": "reference"}"#), "names no legend word"),
            ("a word the table lacks", reg(r#""map""#, &strip.replace("scmp.strip.peak", "no.such.word")), "not in the word table"),
            ("no legend it sits within", reg(r#""map""#, &strip.replace(r#""within": "strip", "#, "")), "names no legend it sits within"),
            ("a fill of no kind", reg(r#""map""#, &strip.replace(r#""t": "period""#, r#""t": "words""#)), "fills {t}"),
            ("a placeholder not filled", reg(r#""map""#, &strip.replace(r#""t": "period", "#, "")), "fills {t}"),
            // each entry it prints is one its layer draws (reviewer 11-03): a template per entry, of its kind, tied to draws
            ("no entry template", reg(r#""map""#, &strip.replace(r#""t": "period:{table}:{last}.y", "#, "")), "no entry its layer draws for {t}"),
            ("an entry of another kind", reg(r#""map""#, &strip.replace(r#""t": "period:{table}"#, r#""t": "fact:{table}"#)), "is no period entry"),
            ("an entry tied to nothing drawn", reg(r#""map""#, &strip.replace(r#""v": "fact:{peak}.n""#, r#""v": "fact:{any}.n""#)), "names nothing its layer draws"),
        ] {
            let e = recipe_roles(&bad, "ring").expect_err(what);
            assert!(e.contains(says), "{what}: {e}");
            assert_eq!(reference_legend_gaps(&bad, "ring", "", &[], None).len(), 1, "{what}: one gap");
        }
        // what the page's layers were given and read: the map's halo at 2015 of lab_t0, the strip over m's RU rows from 2021-01
        let hero = parse(r#"{"data": {"q": {"table": "t"}, "t0": "2015", "legend_fact": "lab_t0"},
            "strip": {"q": {"table": "m", "filter": {"partner": "RU"}, "by": "partner"}, "from": "2021-01", "peak": "ru_s_peak"}}"#).unwrap();
        let row = |p: &str, t: &str| format!(r#"{{"src": "series:m/{p}:{t}:OBS_VALUE", "table": "m", "dims": {{"partner": "{p}"}}, "time": "{t}", "value": 1}}"#);
        let rows = parse(&format!("[{}]", [row("RU", "2019-01"), row("RU", "2021-01"), row("RU", "2025-12"), row("NO", "2026-01")].join(","))).unwrap();
        let reads_at = |y: &str| BTreeMap::from([("lab_t0.RU".to_string(), vec![format!("series:t/RU:{y}:OBS_VALUE")]), ("ru_s_peak".to_string(), vec![])]);
        let (reads, reads_late) = (reads_at("2015"), reads_at("2024"));
        let drawn = Drawn { hero: &hero, rows: rows.arr(), members: &[], reads: &reads };
        let late = Drawn { reads: &reads_late, ..drawn };
        // the page: each line the registry's word, its numbers the page's entries, inside its legend
        let units = ["百万立方米".to_string()];
        let halo_line = r#"<text data-word="halo.t0">浅色宽带＝<tspan data-src="period:t:2015">2015</tspan> 年（<tspan data-src="name:zh_names:iso2:RU">俄罗斯</tspan> <tspan data-src="fact:lab_t0.RU.n">126,027</tspan> 百万立方米）</text>"#;
        let strip_line = r#"<span data-word="scmp.strip.peak">最多：<span data-src="period:m:2025-12.y">2025</span> <span data-src="fact:ru_s_peak.n">3,261</span> 百万立方米</span>"#;
        let page = |h: &str, s: &str| format!(r#"<g data-legend="map"><rect/>{h}</g><div data-legend="strip"><b>剖面</b>{s}</div>"#);
        assert_eq!(reference_legend_gaps(&good, "ring", &page(halo_line, strip_line), &units, Some(&drawn)), Vec::<String>::new());
        let fails_with = |d: Option<&Drawn>, html: &str, says: &str| {
            let gaps = reference_legend_gaps(&good, "ring", html, &units, d);
            assert_eq!(gaps.len(), 1, "{says}: {gaps:?}");
            assert!(gaps[0].contains(says), "{says}: {}", gaps[0]);
        };
        // each entry the one its layer draws, not any entry of its kind: the strip's last month, the halo's year, its value
        // a member of the map's legend family read at that year, its name that member's
        fails_with(Some(&drawn), &page(halo_line, &strip_line.replace("period:m:2025-12.y", "period:m:2024-12.y")), "its layer draws period:m:2025-12.y");
        fails_with(Some(&drawn), &page(&halo_line.replace("period:t:2015", "period:t:2024"), strip_line), "its layer draws period:t:2015");
        fails_with(Some(&drawn), &page(&halo_line.replace("period:t:2015", "period:m:2015"), strip_line), "its layer draws period:t:2015");
        fails_with(Some(&drawn), &page(&halo_line.replace("fact:lab_t0.RU.n", "fact:lab_t1.RU.n"), strip_line), "its layer draws fact:lab_t0.{code}.n");
        fails_with(Some(&drawn), &page(&halo_line.replace("iso2:RU", "iso2:NO"), strip_line), "{name} is the entry name:zh_names:iso2:NO");
        fails_with(Some(&drawn), &page(halo_line, &strip_line.replace("fact:ru_s_peak.n", "fact:no_s_peak.n")), "its layer draws fact:ru_s_peak.n");
        fails_with(Some(&late), &page(halo_line, strip_line), "not its layer's 2015");
        // no knobs: each of the two references says it cannot read what its layer draws
        let blind = reference_legend_gaps(&good, "ring", &page(halo_line, strip_line), &units, None);
        assert!(blind.len() == 2 && blind.iter().all(|g| g.contains("gives no knobs")), "{blind:?}");
        let fails = |html: &str, says: &str| {
            let gaps = reference_legend_gaps(&good, "ring", html, &units, Some(&drawn));
            assert_eq!(gaps.len(), 1, "{says}: {gaps:?}");
            assert!(gaps[0].contains(says), "{says}: {}", gaps[0]);
        };
        // missing, or outside its legend
        fails(&page(halo_line, ""), "prints no line data-word=scmp.strip.peak");
        fails(&format!(r#"{}<p>{strip_line}</p>"#, page(halo_line, "")), "sits outside the legend data-legend=strip");
        fails(&format!(r#"<g data-legend="map">{halo_line}</g><div data-legend="map">{strip_line}</div>"#), "sits outside the legend data-legend=strip");
        // the attribute there and its text changed: a literal, an entry of another kind, a unit of no format, more text
        fails(&page(&halo_line.replace("浅色宽带＝", "浅色＝"), strip_line), "not the registry's word halo.t0");
        fails(&page(&halo_line.replace(r#"data-src="period:t:2015""#, r#"data-src="fact:y0""#), strip_line), "not a period");
        fails(&page(halo_line, &strip_line.replace("百万立方米", "吨")), "the unit of no format");
        fails(&page(&halo_line.replace("）</text>", "）以前</text>"), strip_line), "more than the word");
        fails(&page(&halo_line.replace(r#"<tspan data-src="period:t:2015">2015</tspan>"#, "2015"), strip_line), "not the registry's word halo.t0");
        // a page of the registry in force: scmp's strip and the map's halo are references (step 2)
        let (in_force, _) = registry_in_force();
        let (_, scmp) = recipe_roles(&in_force, "scmp").unwrap();
        assert_eq!(scmp, [("map.halo".to_string(), "halo.t0".to_string()), ("strip".to_string(), "scmp.strip.ref".to_string())]);
        assert_eq!(reference_legend_gaps(&in_force, "scmp", "", &[], None).len(), 2);
        // the ring page's map is wholly a reference (owner 11-03 15:14): it draws each source at the later year, said in the ring's legend
        let (ring_main, ring) = recipe_roles(&in_force, "ring").unwrap();
        assert_eq!((ring_main.as_str(), ring), ("ring", vec![("map".to_string(), "ring.map.t1".to_string())]));
        assert_eq!(reference_legend_gaps(&in_force, "ring", "", &[], None).len(), 1);
        assert!(reference_legend_gaps(&in_force, "column", "", &[], None).is_empty());
    }

    /// 11-03 (owner): the ring's months inside the headline's years are drawn as the band is and the rest faded, and the
    /// legend names those years: a page passes with both, and fails with a month outside not faded, a month inside faded,
    /// a piece of both, a month in two pieces, no line, a line of other years, and no knobs; a page that fades nothing
    /// needs no line.
    #[test]
    fn a_ring_fades_its_months_outside_the_headline_years_and_its_legend_names_them() {
        let reg = parse(r#"{"recipes": {"ring": ["map", "ring"]}, "nodes": {"ring": {"split": {"ring": {"months": "ring", "legend": {"word": "ring.inside", "within": "ring",
            "fills": {"ay": "period", "by": "period"}, "draws": {"table": "data.q.table", "from": "ring.inside.from", "to": "ring.inside.to"},
            "entries": {"ay": "period:{table}:{from}", "by": "period:{table}:{to}"}}}}}}}"#).unwrap();
        let hero = parse(r#"{"data": {"q": {"table": "t"}}, "ring": {"inside": {"from": "2021", "to": "2023"}}}"#).unwrap();
        let reads = BTreeMap::new();
        let drawn = Drawn { hero: &hero, rows: &[], members: &[], reads: &reads };
        let piece = |ms: &str, faded: bool| format!(r#"<path data-ms="{ms}" d="M0,0" fill="red"{}/>"#, if faded { r#" fill-opacity="0.35""# } else { "" });
        let line = |a: &str, b: &str| format!(r#"<div class="hu" data-legend="ring"><div class="gapw" data-word="ring.inside">深色＝<span data-src="period:t:{a}">{a}</span> 年至 <span data-src="period:t:{b}">{b}</span> 年各月，浅色＝其余月份</div></div>"#);
        let page = |pieces: &[String], legend: &str| format!("{legend}<svg>{}</svg>", pieces.concat());
        let good = [piece("2021-01 2023-12", false), piece("2020-11 2020-12 2024-01", true)];
        assert_eq!(split_gaps(&reg, "ring", &page(&good, &line("2021", "2023")), &[], Some(&drawn)), Vec::<String>::new());
        // nothing faded (every month inside): no line asked for
        assert_eq!(split_gaps(&reg, "ring", &page(&[piece("2021-01 2022-06", false)], ""), &[], Some(&drawn)), Vec::<String>::new());
        let fails = |html: &str, d: Option<&Drawn>, says: &str| {
            let gaps = split_gaps(&reg, "ring", html, &[], d);
            assert_eq!(gaps.len(), 1, "{says}: {gaps:?}");
            assert!(gaps[0].contains(says), "{says}: {}", gaps[0]);
        };
        let lg = line("2021", "2023");
        fails(&page(&[piece("2021-01", false), piece("2024-01", false)], &lg), Some(&drawn), "2024-01..2024-01 are drawn as the band is");
        fails(&page(&[piece("2021-01", true), piece("2024-01", true)], &lg), Some(&drawn), "2021-01..2021-01 are faded");
        fails(&page(&[piece("2023-12 2024-01", false)], &lg), Some(&drawn), "inside 2021..2023 and outside them");
        fails(&page(&[piece("2021-01", false), piece("2021-01", false), piece("2024-01", true)], &lg), Some(&drawn), "month 2021-01 is in two pieces");
        fails(&page(&good, ""), Some(&drawn), "prints no line data-word=ring.inside");
        fails(&page(&good, &line("2015", "2023")), Some(&drawn), "its layer draws period:t:2021");
        fails(&page(&good, &lg), None, "gives no knobs");
        // the registry in force: the ring node splits the ring page's months, and no other recipe's
        let (in_force, _) = registry_in_force();
        assert!(in_force.g("nodes").g("ring").g("split").has("ring"));
        assert_eq!(split_gaps(&in_force, "ring", "", &[], None).len(), 1);
        assert!(split_gaps(&in_force, "scmp", "", &[], None).is_empty() && split_gaps(&in_force, "column", "", &[], None).is_empty());
    }

    /// Owner 11-06 (superseding J2 of 11-04): a printed difference is computed from the raw values and only then rounded,
    /// and passes when within half a unit of its last place of the true difference. RO 0.568 and HR 0.234 (true 0.334):
    /// at one decimal it prints 0.3 and at two 0.33, both within half a unit, though 0.6 less 0.2 as printed is 0.4; a
    /// stored fact asking the difference of the values as printed (of_printed) is refused by the core, so it never
    /// prints; a true difference of 0 printed 0 passes.
    #[test]
    fn a_printed_difference_is_within_half_a_unit_of_the_true_one() {
        let rows: Vec<J> = [("RO", "0.568"), ("HR", "0.234"), ("SE", "0.3"), ("FI", "0.3")].iter()
            .map(|(g, v)| parse(&format!(r#"{{"table": "t", "time": "2024", "dims": {{"geo": "{g}"}}, "value": "{v}"}}"#)).unwrap()).collect();
        let fmts = parse(r#"{"d1": {"scale": 1, "dec": 1, "suffix": ""}, "d2": {"scale": 1, "dec": 2, "suffix": ""}}"#).unwrap();
        let facts = |dec: usize, of: bool| {
            let f = format!("d{dec}");
            let of = if of { format!(r#", "of_printed": [{{"scale": 1, "dec": {dec}}}, {{"scale": 1, "dec": {dec}}}]"#) } else { String::new() };
            parse(&format!(r#"{{"ro": {{"table": "t", "filter": {{"geo": "RO"}}, "time": "2024", "fmt": "{f}"}}, "hr": {{"table": "t", "filter": {{"geo": "HR"}}, "time": "2024", "fmt": "{f}"}},
                "se": {{"table": "t", "filter": {{"geo": "SE"}}, "time": "2024", "fmt": "{f}"}}, "fi": {{"table": "t", "filter": {{"geo": "FI"}}, "time": "2024", "fmt": "{f}"}},
                "gap": {{"op": "minus", "a": "ro", "b": "hr", "fmt": "{f}"{of}}}, "tie": {{"op": "minus", "a": "se", "b": "fi", "fmt": "{f}"{of}}}}}"#)).unwrap()
        };
        let shown: BTreeSet<String> = ["ro", "hr", "gap", "se", "fi", "tie"].iter().map(|k| k.to_string()).collect();
        // from the raw values: 0.334 prints 0.3 and 0.33, each within half a unit; the tie 0 prints 0
        assert!(differences_disagree(&facts(1, false), &fmts, &rows, &shown).is_empty());
        assert!(differences_disagree(&facts(2, false), &fmts, &rows, &shown).is_empty());
        // a fact of the values as printed is refused by both cores (it would read 0.4 and 0.34)
        for dec in [1, 2] {
            let why = fact_value(&facts(dec, true), &rows, "gap").unwrap_err();
            assert!(why.contains("of_printed is refused"), "{why}");
            assert!(differences_disagree(&facts(dec, true), &fmts, &rows, &shown).is_empty(), "no value, no printed number");
        }
        let d = printed_differences(&facts(2, false), &fmts, &rows, &shown).into_iter().find(|d| d.key == "gap").unwrap();
        assert_eq!((d.close, d.forms, d.dec), (true, [(1.0, 2), (1.0, 2)], 2));
        assert!((d.truth - 0.334).abs() < 1e-12);
    }

    /// Owner 11-06 (superseding 11-03): a printed difference computed from the raw values and then rounded is no failure
    /// though it differs from the difference of its two values as the page prints them, over three shapes: a change page's
    /// gap of two changes in points (each operand printed as a member of the bars' minus family, its value twin), a column
    /// page's gap in points of two shares printed in percent, a whole-unit gap of two levels. An operand the page does not
    /// print (the dek's year levels), a difference the page does not print, formats of two scales and a half tie read to
    /// the even digit are no case either; a family member takes its own format (fmt_each).
    #[test]
    fn a_printed_difference_is_the_difference_of_its_two_printed_values() {
        let rows = |vals: &[(&str, &str, &str)]| -> Vec<J> {
            vals.iter().map(|(g, t, v)| parse(&format!(r#"{{"table": "sdg", "time": "{t}", "dims": {{"geo": "{g}"}}, "value": "{v}"}}"#)).unwrap()).collect()
        };
        let fmts = |decs: &[(&str, i64)]| J::Obj(decs.iter().map(|(k, d)| (k.to_string(), parse(&format!(r#"{{"scale": 1, "dec": {d}, "suffix": ""}}"#)).unwrap())).collect());
        let set = |ks: &[&str]| ks.iter().map(|k| k.to_string()).collect::<BTreeSet<String>>();
        // the change page: BE +5.5, FR -2.25; the note's gap 7.75 prints 7.8, the bars 5.5 and -2.2 (7.7)
        let change = rows(&[("BE", "2016", "10"), ("BE", "2024", "15.5"), ("FR", "2016", "9.25"), ("FR", "2024", "7")]);
        let facts = |each: &str| {
            parse(&format!(
                r#"{{"val0": {{"each": "geo", "table": "sdg", "time": "2016", "fmt": "pc"}}, "val1": {{"each": "geo", "table": "sdg", "time": "2024", "fmt": "pc"}},
                    "chg": {{"op": "minus", "each": "geo", "a": "val1", "b": "val0", "fmt": "pp"{each}}},
                    "a1": {{"table": "sdg", "filter": {{"geo": "BE"}}, "time": "2024", "fmt": "pc"}}, "a0": {{"table": "sdg", "filter": {{"geo": "BE"}}, "time": "2016", "fmt": "pc"}},
                    "b1": {{"table": "sdg", "filter": {{"geo": "FR"}}, "time": "2024", "fmt": "pc"}}, "b0": {{"table": "sdg", "filter": {{"geo": "FR"}}, "time": "2016", "fmt": "pc"}},
                    "vs_a": {{"op": "minus", "a": "a1", "b": "a0", "fmt": "pp"}}, "vs_b": {{"op": "minus", "a": "b1", "b": "b0", "fmt": "pp"}},
                    "vs_lo": {{"op": "minus", "a": "vs_a", "b": "vs_b", "fmt": "{}"}}}}"#,
                if each.is_empty() { "pp" } else { "pp_d2" }
            ))
            .unwrap()
        };
        // what the page prints: the bars bind the family (every member), the note its gap
        let shown = printed_keys(&parse(r#"{"bars": {"family": "chg"}, "note": "fact:vs_lo", "dek": "{a0.t} {a1.t}"}"#).unwrap(), &facts(""));
        assert_eq!(shown, set(&["chg.*", "vs_lo"]), "a .t year prints no number of its fact");
        // the gap 7.75 prints 7.8 though the bars print 5.5 and -2.2 (7.7): within half a unit of the raw difference
        let d = printed_differences(&facts(""), &fmts(&[("pc", 2), ("pp", 1)]), &change, &shown).into_iter().find(|d| d.key == "vs_lo").unwrap();
        assert_eq!((d.pa.as_str(), d.pb.as_str(), d.tk.as_str(), d.equal, d.close), ("chg.BE", "chg.FR", "7.8", false, true));
        assert!(differences_disagree(&facts(""), &fmts(&[("pc", 2), ("pp", 1)]), &change, &shown).is_empty());
        // the three at two decimals, each in its own format; the other bars keep one
        let raised = facts(r#", "fmt_each": {"BE": "pp_d2", "FR": "pp_d2"}"#);
        assert_eq!((fact_fmt(&raised, "chg.BE").as_deref(), fact_fmt(&raised, "chg.SE").as_deref()), (Some("pp_d2"), Some("pp")));
        assert!(differences_disagree(&raised, &fmts(&[("pc", 2), ("pp", 1), ("pp_d2", 2)]), &change, &shown).is_empty());
        // the gap not printed, or no operand printed: no case
        assert!(differences_disagree(&facts(""), &fmts(&[("pc", 2), ("pp", 1)]), &change, &set(&["chg.*"])).is_empty());
        assert!(differences_disagree(&facts(""), &fmts(&[("pc", 2), ("pp", 1)]), &change, &set(&["vs_lo"])).is_empty());
        // the column page: two shares at two decimals, their gap in points at one: 65.43 - 14.92 = 50.51 prints 50.5
        let column = rows(&[("SE", "2025", "65.43"), ("BE", "2025", "14.92")]);
        let gap = |a: &str, b: &str, f: &str| {
            parse(&format!(
                r#"{{"hi": {{"table": "sdg", "filter": {{"geo": "{a}"}}, "time": "2025", "fmt": "{f}"}}, "lo": {{"table": "sdg", "filter": {{"geo": "{b}"}}, "time": "2025", "fmt": "{f}"}},
                    "gap": {{"op": "minus", "a": "hi", "b": "lo", "fmt": "pp"}}}}"#
            ))
            .unwrap()
        };
        let all = set(&["hi", "lo", "gap"]);
        assert!(differences_disagree(&gap("SE", "BE", "pc"), &fmts(&[("pc", 2), ("pp", 1)]), &column, &all).is_empty());
        // at none: 65 - 15 = 50 as printed, the raw gap 50.51 prints 51: no failure
        assert!(differences_disagree(&gap("SE", "BE", "pc"), &fmts(&[("pc", 0), ("pp", 0)]), &column, &all).is_empty());
        // whole units: 10.6 and 3.4 print 11 and 3 (8), their raw gap 7.2 prints 7: no failure; at one decimal 7.2
        let levels = rows(&[("DE", "2025", "10.6"), ("FR", "2025", "3.4")]);
        assert!(differences_disagree(&gap("DE", "FR", "ktoe"), &fmts(&[("ktoe", 0), ("pp", 0)]), &levels, &all).is_empty());
        assert!(differences_disagree(&gap("DE", "FR", "ktoe"), &fmts(&[("ktoe", 1), ("pp", 1)]), &levels, &all).is_empty());
        // a half tie: 2.25 and 1.00, their 1.25 to one decimal is 1.2 by the even digit, as the gap prints
        let tie = rows(&[("DE", "2025", "2.25"), ("FR", "2025", "1")]);
        assert!(differences_disagree(&gap("DE", "FR", "ktoe"), &fmts(&[("ktoe", 2), ("pp", 1)]), &tie, &all).is_empty());
        // formats of two scales are no case
        let mut scaled = fmts(&[("ktoe", 0), ("pp", 0)]);
        scaled.set("pp", parse(r#"{"scale": 100, "dec": 0, "suffix": ""}"#).unwrap());
        assert!(differences_disagree(&gap("DE", "FR", "ktoe"), &scaled, &levels, &all).is_empty());
        // the printed numbers as integers, and the half tie to the even digit
        assert_eq!((printed_int("-2.2", 2), printed_int("7", 1), printed_int("1.234", 2)), (Some(-220), Some(70), None));
        assert_eq!((round_even(775, 2, 1), round_even(765, 2, 1), round_even(-775, 2, 1), round_even(-226, 2, 1)), (78, 76, -78, -23));
    }
    fn read(name: &str) -> J {
        parse(&std::fs::read_to_string(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))).unwrap_or_else(|e| panic!("{name}: {e}"))
    }
    /// P4a-2: the map circles' honest requests and replies (scripts/fixtures/p4a2/circles.json, exported from the design's
    /// prototype): q1 (dots, labels beside), q6 (leaders), and q1 with two places on one point and no nudge.
    fn circles() -> J {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a2/circles.json");
        parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The first failure line of a circles reply, or "passed".
    fn circles_first(req: &J, rep: &J) -> String {
        match circles_problems("bubbles", req, rep) {
            Ok(_) => "passed".into(),
            Err(e) => e.first().cloned().unwrap_or_default(),
        }
    }

    /// K3-K9 (P4a-2): the honest replies pass and give the placed geometry the prototype's core gave (texts listed in the
    /// order placed); even the floor overlapping passes the reply and hands the leaf the floor's pairs (placed.floor: the
    /// leaf stops in its own words, scripts/test_leaf_stops_p4a2.py B6), never a placed circle.
    #[test]
    fn next_tree_circles_honest_replies_pass_as_the_prototype() {
        let fx = circles();
        for case in ["q1", "q6", "floor"] {
            let c = fx.g(case);
            let placed = circles_problems("bubbles", c.g("request"), c.g("reply")).unwrap_or_else(|e| panic!("{case}: {e:?}"));
            // the core keeps r_used whole when r_max is (the leaf's own int, so its records print as before) and adds the
            // labels' size; the prototype wrote r_used as a float
            let (have, want) = (if placed.has("floor") { placed.g("floor") } else { &placed }, c.g("placed").get("floor").unwrap_or(c.g("placed")));
            assert_eq!(have.g("r_used").num(), want.g("r_used").num(), "{case}");
            for k in ["order", "marks", "texts", "dropped", "pairs", "max_overlaps"] {
                assert_eq!(have.g(k).dump(), want.g(k).dump(), "{case} {k}");
            }
        }
        assert!(fx.g("floor").g("placed").g("floor").g("pairs").arr().len() > fx.g("floor").g("request").g("scale").g("max_overlaps").num().unwrap() as usize);
    }

    /// F1-F17 (P4a-2 design 8): each tampered reply stops at the check kind it names, never passes (design tests/must_fail.py).
    #[test]
    fn next_tree_circles_tampered_replies_stop_at_their_check() {
        let fx = circles();
        let (q1, q6) = (fx.g("q1"), fx.g("q6"));
        let (req1, rep1, req6, rep6) = (q1.g("request"), q1.g("reply"), q6.g("request"), q6.g("reply"));
        let marks = rep1.g("marks");
        let moved = req1.g("marks").arr().iter().map(|m| st(m.g("id"))).find(|c| marks.has(&format!("{c}/dot"))).expect("a moved circle");
        let still = req1.g("marks").arr().iter().map(|m| st(m.g("id"))).find(|c| !marks.has(&format!("{c}/dot"))).expect("a still circle");
        let led = rep6.g("marks").obj().iter().find_map(|(k, _)| k.strip_suffix("/leader").map(String::from)).expect("a leader");
        let lab = rep1.g("texts").obj()[0].0.clone();
        let num = |r: &J, path: &[&str]| r.g(path[0]).g(path[1]).g(path[2]).num().unwrap();
        let set = |r: &mut J, path: &[&str], v: J| assert!(r.set_path(&path.iter().map(|x| x.to_string()).collect::<Vec<_>>(), v), "{path:?}");
        type Tamper<'a> = Box<dyn Fn(&mut J) + 'a>;
        let pin = req1.g("marks").arr().iter().find(|m| st(m.g("id")) == moved).unwrap().g("pin").clone();
        let most = req1.g("nudge").g("most").num().unwrap();
        let cases: Vec<(&str, &str, bool, Tamper)> = vec![
            ("F1 a circle 0.1 px past nudge.most", "K5", true, Box::new(|r: &mut J| {
                let (cx, cy) = (num(r, &["marks", &moved, "cx"]), num(r, &["marks", &moved, "cy"]));
                let (px, py) = (pin.at(0).num().unwrap(), pin.at(1).num().unwrap());
                let k = (most + 0.1) / (cx - px).hypot(cy - py);
                set(r, &["marks", &moved, "cx"], J::Num(px + (cx - px) * k));
                set(r, &["marks", &moved, "cy"], J::Num(py + (cy - py) * k));
            })),
            ("F2 one radius +0.1 px", "K4", true, Box::new(|r: &mut J| { let v = num(r, &["marks", &still, "r"]); set(r, &["marks", &still, "r"], J::Num(v + 0.1)) })),
            ("F3 r_used 21, off the 2 px grid", "K4", true, Box::new(|r: &mut J| {
                for m in req1.g("marks").arr() {
                    let c = st(m.g("id"));
                    let v = num(r, &["marks", &c, "r"]);
                    set(r, &["marks", &c, "r"], J::Num(if v > 3.0 { (v * 21.0 / 22.0).max(3.0) } else { 3.0 }));
                }
            })),
            ("F4 a moved circle's dot left out", "K5", true, Box::new(|r: &mut J| { r.get_mut("marks").unwrap().remove(&format!("{moved}/dot")); })),
            ("F5 a dot 0.1 px off its pin", "K5", true, Box::new(|r: &mut J| { let d = format!("{moved}/dot"); let v = num(r, &["marks", &d, "cx"]); set(r, &["marks", &d, "cx"], J::Num(v + 0.1)) })),
            ("F6 a dot on a circle that did not move", "K5", true, Box::new(|r: &mut J| {
                r.get_mut("marks").unwrap().set(&format!("{still}/dot"), J::obj_of(vec![("shape", J::str("circle")), ("cx", J::Int(1)), ("cy", J::Int(1)), ("r", J::Num(1.6))]));
            })),
            ("F7 a beside label 0.1 px off its place", "K8", true, Box::new(|r: &mut J| { let v = num(r, &["texts", &lab, "x"]); set(r, &["texts", &lab, "x"], J::Num(v + 0.1)) })),
            ("F8 a beside label with another anchor", "K8", true, Box::new(|r: &mut J| {
                let a = if r.g("texts").g(&lab).g("anchor").s() != Some("middle") { "middle" } else { "start" };
                set(r, &["texts", &lab, "anchor"], J::str(a));
            })),
            ("F10 a label left off and not listed", "K9", true, Box::new(|r: &mut J| { r.get_mut("texts").unwrap().remove(&lab); })),
            ("F11 a label placed and listed as dropped", "K9", true, Box::new(|r: &mut J| {
                let mut d = r.g("dropped").arr().to_vec();
                d.push(J::str(&lab));
                r.set("dropped", J::Arr(d));
            })),
            ("F12 two dropped, out of the subset's order", "K9", true, Box::new(|r: &mut J| {
                let (a, b) = (r.g("texts").obj()[0].0.clone(), r.g("texts").obj()[1].0.clone());
                let t = r.get_mut("texts").unwrap();
                t.remove(&a);
                t.remove(&b);
                let mut d = r.g("dropped").arr().to_vec();
                d.extend([J::str(&b), J::str(&a)]);
                r.set("dropped", J::Arr(d));
            })),
            ("F13 a reply field the core does not read", "B0", true, Box::new(|r: &mut J| r.set("scale", J::obj_of(vec![("r_used", J::Int(22))])))),
            ("F14 a label for a circle outside the subset", "B0", true, Box::new(|r: &mut J| {
                let out = st(req1.g("marks").arr()[req1.g("marks").arr().len() - 2].g("id"));
                r.get_mut("texts").unwrap().set(&out, J::obj_of(vec![("x", J::Int(1)), ("y", J::Int(1)), ("anchor", J::str("start"))]));
            })),
            ("F17 a circle answered as a rect", "B1", true, Box::new(|r: &mut J| set(r, &["marks", &still, "shape"], J::str("rect")))),
            ("F9 a leader starting 0.1 px off the circle's edge", "K8", false, Box::new(|r: &mut J| { let l = format!("{led}/leader"); let v = num(r, &["marks", &l, "x1"]); set(r, &["marks", &l, "x1"], J::Num(v + 0.1)) })),
            ("F16 a leader 8 px longer than its label's place", "K8", false, Box::new(|r: &mut J| { let l = format!("{led}/leader"); let v = num(r, &["marks", &l, "x2"]); set(r, &["marks", &l, "x2"], J::Num(v + 8.0)) })),
        ];
        let mut off = Vec::new();
        for (name, kind, on_q1, tamper) in &cases {
            let (req, mut rep) = if *on_q1 { (req1, rep1.clone()) } else { (req6, rep6.clone()) };
            tamper(&mut rep);
            let first = circles_first(req, &rep);
            if !first.starts_with(kind) {
                off.push(format!("{name}: want {kind}, got {first}"));
            }
        }
        // F15: a label moved to an earlier beside place, one the node found taken
        let (sz, g) = (req1.g("labels").g("size").num().unwrap(), req1.g("labels").g("gap").num().unwrap() + 1.0);
        let mut rep = rep1.clone();
        let mut done = false;
        for (c, t) in rep1.g("texts").obj() {
            let m = rep1.g("marks").g(c);
            let (x, y, r) = (m.g("cx").num().unwrap(), m.g("cy").num().unwrap(), m.g("r").num().unwrap());
            let places = [("start", x + r + g, y - sz * 0.2), ("end", x - r - g, y - sz * 0.2), ("middle", x, y - r - g - sz * 1.65), ("middle", x, y + r + g + sz * 0.8)];
            let at = places.iter().position(|p| Some(p.0) == t.g("anchor").s() && (p.1 - t.g("x").num().unwrap()).abs() < 1e-9 && (p.2 - t.g("y").num().unwrap()).abs() < 1e-9);
            if at.is_some_and(|a| a > 0) {
                let (a, px, py) = places[0];
                rep.get_mut("texts").unwrap().set(c, J::obj_of(vec![("x", J::Num(px)), ("y", J::Num(py)), ("anchor", J::str(a))]));
                done = true;
                break;
            }
        }
        assert!(done, "F15: q1 has a label past its first beside place");
        let first = circles_first(req1, &rep);
        if !first.starts_with("K8") {
            off.push(format!("F15 a label at an earlier beside place: want K8, got {first}"));
        }
        assert!(off.is_empty(), "{off:#?}");
    }

    /// C1-C6, D1-D6 (P4a-2 design 4.1): a registry past a core bound is refused when it loads, and a request carrying the same
    /// knob (a second layer's knobs.json widened) is refused before the reply is read, each naming its constant; the
    /// production knobs and the bounds themselves pass.
    #[test]
    fn next_tree_circles_knobs_past_the_core_bounds_are_refused() {
        let widen = [("reach", 208.0, "REACH_PX_MAX"), ("nudge", 17.0, "NUDGE_PX_MAX"), ("r_max", 30.0, "RADIUS_PX_MAX"), ("max_overlaps", 21.0, "OVERLAPS_MAX"), ("label_gap", 0.5, "GAP_PX_MIN"), ("label_sep", 1.0, "SEP_PX_MIN")];
        let at_bound = [("reach", 200.0), ("nudge", 16.0), ("r_max", 28.0), ("max_overlaps", 20.0), ("label_gap", 1.0), ("label_sep", 2.0)];
        let with_knob = |k: &str, v: f64| {
            let mut o = bindings();
            assert!(o.set_path(&["nodes", "bubbles", "knobs", k].map(String::from), J::Num(v)));
            registry_problems(&load_registry(&o))
        };
        assert_eq!(registry_problems(&load_registry(&bindings())), Vec::<String>::new());
        for (k, v, cap) in widen {
            let errs = with_knob(k, v);
            assert!(errs.iter().any(|e| e.starts_with("C5 registry bubbles knobs") && e.contains(cap)), "C {k} {v}: {errs:?}");
        }
        for (k, v) in at_bound {
            assert_eq!(with_knob(k, v), Vec::<String>::new(), "{k} at its bound {v}");
        }
        let fx = circles();
        let (req, rep) = (fx.g("q1").g("request"), fx.g("q1").g("reply"));
        for (k, v, cap) in widen {
            let path: [&str; 2] = match k {
                "reach" => ["labels", "reach"],
                "nudge" => ["nudge", "most"],
                "r_max" | "max_overlaps" => ["scale", k],
                "label_gap" => ["labels", "gap"],
                _ => ["labels", "sep"],
            };
            let mut rq = req.clone();
            assert!(rq.set_path(&path.map(String::from), J::Num(v)));
            let first = circles_first(&rq, rep);
            assert!(first.starts_with("B0 request bubbles") && first.contains(cap), "D {k} {v}: {first}");
        }
    }

    /// K11 (P4a-2): signed bars from one zero line, the value's room on each side a bar runs to; with values of 0 or more
    /// the room after the bars only, as K1 laid the level bars; every value 0 gives no bars to scale.
    #[test]
    fn next_tree_signed_bars_run_from_one_zero_line() {
        let rows = J::obj_of(vec![("x0", J::Int(0)), ("lw", J::Num(40.0)), ("vw", J::Num(30.0)), ("bw", J::Num(400.0))]);
        let (z, bars) = signed_bars(&rows, &[3.0, -1.0]).unwrap();
        // left 0 + 40 + 30 = 70, bw 400 - 40 - 30 - 30 = 300, z = 70 + 1/4 * 300
        assert_eq!((z, bars), (145.0, vec![(145.0, 225.0), (70.0, 75.0)]));
        let (z, bars) = signed_bars(&rows, &[4.0, 1.0, 0.0]).unwrap();
        // no room left of the zero line: left 70 - 30 = 40, bw 400 - 40 - 30 = 330
        assert_eq!((z, bars), (40.0, vec![(40.0, 330.0), (40.0, 82.5), (40.0, 0.0)]));
        assert_eq!(signed_room(&[0.0, -2.0], 30.0), (-2.0, 0.0, 30.0, 0.0));
        assert!(signed_bars(&rows, &[0.0, 0.0]).is_none());
    }

    /// K10 (P4a-2): a rank by the change between two times orders the codes by the later value less the earlier, the largest
    /// first and a tie to code order; a result in another order, a key whose later time is not over.time, or a code with
    /// no row at the earlier time stops.
    #[test]
    fn next_tree_a_rank_by_change_recomputes_the_flow_s_changed() {
        let row = |c: &str, t: &str, v: &str| {
            J::obj_of(vec![("src", J::Str(format!("series:T/{c}:{t}"))), ("table", J::str("T")), ("dims", J::obj_of(vec![("geo", J::str(c))])), ("time", J::str(t)), ("value", J::str(v))])
        };
        let rows = J::Arr(vec![row("AT", "2016", "10"), row("AT", "2024", "14"), row("BE", "2016", "5"), row("BE", "2024", "9"), row("CY", "2016", "8"), row("CY", "2024", "7")]);
        let page = |key: J, result: &[&str]| {
            let s = J::obj_of(vec![
                ("id", J::str("ranked")),
                ("kind", J::str("rank")),
                ("over", J::obj_of(vec![("table", J::str("T")), ("by", J::str("geo")), ("time", J::str("2024"))])),
                ("key", key),
                ("order", J::str("desc")),
                ("tie", J::obj_of(vec![("by", J::str("code")), ("outcome", J::str("order"))])),
                ("result", J::strs(result)),
            ]);
            J::obj_of(vec![
                ("kind", J::str("Page")),
                ("selects", J::obj_of(vec![("kind", J::str("Selects")), ("items", J::Arr(vec![s]))])),
                ("facts", J::obj_of(vec![("kind", J::str("Facts")), ("tables", J::Obj(vec![])), ("rows", rows.clone()), ("facts", J::Obj(vec![])), ("fmts", J::Obj(vec![]))])),
                ("checks", J::obj_of(vec![("kind", J::str("Checks")), ("items", J::Arr(vec![]))])),
            ])
        };
        let change = |a: &str, b: &str| J::obj_of(vec![("change", J::strs(&[a, b]))]);
        // AT +4 and BE +4 tie to code order, CY -1 last
        let (bad, got, _) = recheck(&page(change("2016", "2024"), &["AT", "BE", "CY"]));
        assert_eq!((bad, got.get("ranked").map(J::dump)), (Vec::<String>::new(), Some(r#"["AT","BE","CY"]"#.to_string())));
        let (bad, _, _) = recheck(&page(change("2016", "2024"), &["BE", "AT", "CY"]));
        assert!(!bad.is_empty(), "the flow's ranked in another order passed");
        let (bad, _, _) = recheck(&page(change("2016", "2025"), &["AT", "BE", "CY"]));
        assert!(bad.iter().any(|e| e.contains("key")), "a change whose later end is not over.time: {bad:?}");
        let (bad, _, _) = recheck(&page(change("2015", "2024"), &["AT", "BE", "CY"]));
        assert!(bad.iter().any(|e| e.contains("has 0 rows at 2015")), "{bad:?}");
    }

    /// The core writes a number as the leaf's facts.fmt does: Python's `,.{dec}f` (outputs taken from Python 3.13).
    #[test]
    fn next_tree_numbers_group_by_thousands_as_the_leaf() {
        for (x, dec, py) in [
            (0.0, 1, "0.0"),
            (12.5, 2, "12.50"),
            (999.0, 0, "999"),
            (1000.0, 0, "1,000"),
            (112310.0, 0, "112,310"),
            (552658.77, 2, "552,658.77"),
            (-1234567.5, 1, "-1,234,567.5"),
            (-0.04, 1, "-0.0"),
        ] {
            assert_eq!(py_grouped(&py_fixed(x, dec)), py, "{x} at {dec}");
        }
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
        assert_eq!((total, passed), (all.g("total").num().unwrap() as i64, 890));
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

    /// The production bindings (P4a-2) bind the bars and the map circles external, and (P4b-1) the composition's stacked100 with its leaf's own geometry, and nothing else, pass C5, and name a
    /// runner under the node folders; every recipe's external layers in the leaf registry (knobs.json, which knobs.py writes
    /// from the bindings' recipes) are the bindings' own, of nodes the core binds external, and its points layers the ones
    /// laid out in a view frame. The circles' knobs are the bubbles leaf's under the map style (run.MAP_STYLE: label_top 12,
    /// label_sep 8; the rest its knob defaults), so the core lays them out as the leaf did.
    #[test]
    fn next_tree_production_binds_the_bars_external() {
        let o = bindings();
        assert_eq!(external_nodes(&o), ["bars", "bubbles", "map", "bignums", "leader_notes", "notes", "ring", "strip", "sankey", "line", "rank_lines", "waterfall", "stacked100"]);
        assert_eq!(registry_problems(&load_registry(&o)), Vec::<String>::new());
        for n in external_nodes(&o) {
            assert!(runner_allowed(&st(o.g("nodes").g(&n).g("runner"))), "{n}");
        }
        for r in &crate::next_leaf::leaves().recipes {
            let want: Vec<String> = o.g("recipes").g(&r.name).arr().iter().map(st).collect();
            assert_eq!(r.external, want, "recipe {}", r.name);
            assert!(r.external.iter().all(|l| external_nodes(&o).contains(l)));
            let view: Vec<String> =
                want.iter().filter(|l| o.g("frames").g(&st(o.g("nodes").g(l.as_str()).g("frame"))).g("kind").s() == Some("view")).cloned().collect();
            assert_eq!(r.points, view, "recipe {}", r.name);
        }
        let leaf = |k: &str| match crate::next_leaf::leaves().nodes["bubbles"].info.knobs.iter().find(|x| x.name == k).map(|x| &x.kind) {
            Some(crate::next_nodes::Kind::Range { default, .. }) => *default,
            _ => panic!("bubbles.{k}"),
        };
        let kn = o.g("nodes").g("bubbles").g("knobs");
        for (k, map_style) in [("label_top", Some(12.0)), ("label_sep", Some(8.0)), ("r_max", None), ("nudge", None), ("max_overlaps", None), ("reach", None), ("r_min", None), ("circle_gap", None), ("label_gap", None), ("land_cost", None)] {
            assert_eq!(kn.g(k).num(), Some(map_style.unwrap_or_else(|| leaf(k))), "bubbles knob {k}");
        }
        // the rows frame repeats the bars leaf's knob defaults (column.py ColumnFrame reads top, row and size)
        let knob = |k: &str| match crate::next_leaf::leaves().nodes["bars"].info.knobs.iter().find(|x| x.name == k).map(|x| &x.kind) {
            Some(crate::next_nodes::Kind::Range { default, .. }) => *default,
            _ => panic!("bars.{k}"),
        };
        let fr = o.g("frames").g("bars_rows");
        assert_eq!((fr.g("top").num(), fr.g("row").num()), (Some(knob("top")), Some(knob("row"))));
        assert_eq!(o.g("nodes").g("bars").g("texts").g("size").num(), Some(knob("size")));
        assert!(runner_allowed("nodes/bars.mjs") && runner_allowed("leaves_py/bars.py"));
        for bad in ["pi/x.mjs", "nodes/../pi/x.mjs", "nodes/x.json", "/nodes/x.mjs", "nodes/./x.py", "leaves_py/bake.py", "leaves_py/knobs.py"] {
            assert!(!runner_allowed(bad), "{bad}");
        }
    }

    /// K1, K2 (P4a): the two kinds the real bars need. A registry naming them where the core does not compute them is
    /// refused (a rows_y with no rows frame, a rows frame with a part missing, another frame kind, a channel the core has
    /// not), as P3's core refused length_right itself; the production entry passes.
    #[test]
    fn next_tree_k1_k2_registry_refuses_what_it_cannot_lay_out() {
        let heads = |o: &J| registry_problems(&load_registry(o));
        let o = bindings();
        assert!(heads(&o).is_empty());
        let mut no_kind = o.clone();
        no_kind.get_mut("frames").and_then(|f| f.get_mut("bars_rows")).unwrap().remove("kind");
        assert!(heads(&no_kind).iter().any(|e| e.contains("channel rows_y needs a frame of kind rows")), "{:?}", heads(&no_kind));
        let mut other = o.clone();
        other.get_mut("frames").and_then(|f| f.get_mut("bars_rows")).unwrap().set("kind", J::str("columns"));
        assert!(heads(&other).iter().any(|e| e.contains("not one the core lays out")));
        for (field, v) in [("inset", J::Int(12)), ("row", J::Num(24.5)), ("foot", J::Null)] {
            let mut bad = o.clone();
            bad.get_mut("frames").and_then(|f| f.get_mut("bars_rows")).unwrap().set(field, v);
            assert!(heads(&bad).iter().any(|e| e.contains("a rows frame needs")), "{field}");
        }
        let mut side = o.clone();
        assert!(side.set_path(&["frames", "bars_rows", "left", "text"].map(String::from), J::str("share_text")));
        assert!(heads(&side).iter().any(|e| e.contains("a rows frame needs")));
        let mut chan = o.clone();
        assert!(chan.set_path(&["nodes", "bars", "marks", "encode", "0", "channel"].map(String::from), J::str("length_left")));
        assert!(heads(&chan).iter().any(|e| e.starts_with("C5 registry bars channel")));
    }

    /// K2's width rule is the leaf's (prod.py tw): equal bit for bit on every name and value the 14 column pages print, a
    /// code point scan and a few scripts, at three sizes (scripts/fixtures/p4a/tw-leaf.json, Python's repr of prod.tw).
    #[test]
    fn next_tree_tw_leaf_is_the_leaf_rule_bit_for_bit() {
        let f = parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a/tw-leaf.json")).unwrap()).unwrap();
        let mut off = Vec::new();
        for c in f.g("cases").arr() {
            let w = tw_leaf(&st(c.at(0)), c.at(1).num().unwrap());
            // Python's sum stays an int while every term is (no Latin char, an int size): the same number, printed bare
            let int = (matches!(c.at(1), J::Int(_)) || st(c.at(0)).is_empty()) && st(c.at(0)).chars().all(|ch| ch as u32 > 0x2E7F);
            let got = if int { format!("{}", w as i64) } else { py_float(w) };
            if got != st(c.at(2)) {
                off.push(format!("{:?} at {}: {got} != {}", st(c.at(0)), st(c.at(1)), st(c.at(2))));
            }
        }
        assert!(off.is_empty() && f.g("cases").arr().len() > 400, "{off:?}");
    }

    /// K1, K2 on the 14 column pages of the replay list (scripts/fixtures/p4a/column-bars.json, from their published bars
    /// layers): the rows frame the core lays out from the page's printed names and values, and the bars K1 and K2 recompute
    /// on it, print every number the page printed (the axis, each name, bar x and width, value), as ColumnFrame did.
    #[test]
    fn next_tree_k1_k2_print_the_column_pages_numbers() {
        let pages = parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a/column-bars.json")).unwrap()).unwrap();
        let reg = load_registry(&bindings());
        let e = reg.g("nodes").g("bars");
        let fr = reg.g("frames").g("bars_rows");
        let mut done = 0;
        for p in pages.g("pages").arr() {
            let sha = st(p.g("sha"));
            let names: Vec<String> = p.g("names").arr().iter().map(st).collect();
            let texts: Vec<String> = p.g("values_text").arr().iter().map(st).collect();
            let mut meta = Meta::default();
            for (i, (n, v)) in names.iter().zip(&texts).enumerate() {
                meta.texts.push((format!("bars/{i}/label"), n.clone(), J::Null));
                meta.texts.push((format!("bars/{i}/value_text"), v.clone(), J::Null));
            }
            let node = J::obj_of(vec![
                ("knobs", J::obj_of(vec![("x0", p.g("x0").clone())])),
                ("items", J::Arr(names.iter().map(|_| J::Obj(vec![])).collect())),
            ]);
            let values: Vec<f64> = p.g("values").arr().iter().filter_map(J::num).collect();
            let (frame, plot, rows) = rows_frame(fr, &node, &meta, 13.0, &values).unwrap();
            let marks: Vec<J> = p.g("values").arr().iter().enumerate().map(|(i, v)| {
                J::obj_of(vec![("id", J::Str(format!("bars/{i}"))), ("shape", J::str("rect")), ("item", J::Int(i as i64)), ("value", v.clone())])
            }).collect();
            let req = J::obj_of(vec![("frame", frame), ("plot", plot.clone()), ("rows", rows), ("encode", e.g("marks").g("encode").clone()), ("marks", J::Arr(marks))]);
            let want = expected(&req).unwrap();
            let left = plot.at(0).num().unwrap();
            let mut printed = vec![format!("{left:.1}")];
            for (_, f) in &want {
                let get = |k: &str| f.iter().find(|(x, _)| x == k).unwrap().1;
                printed.extend([format!("{:.1}", left - 8.0), format!("{:.1}", get("x")), format!("{:.1}", get("w")), format!("{:.1}", left + get("w") + 6.0)]);
                assert_eq!(get("h"), 18.0, "{sha}");
            }
            let page: Vec<String> = p.g("printed").arr().iter().map(st).collect();
            assert_eq!(printed, page, "{sha}");
            done += 1;
        }
        assert_eq!(done, 14);
    }

    /// K1, K2 through B3 and B5: an honest reply passes; a bar 1 px longer, a bar moved to another row, or a name at another
    /// bar stops.
    #[test]
    fn next_tree_k1_k2_hold_the_reply() {
        let reg = load_registry(&bindings());
        let e = reg.g("nodes").g("bars");
        let fr = reg.g("frames").g("bars_rows");
        let (names, vals) = (["瑞典", "芬兰", "丹麦"], [65.4, 53.0, 48.2]);
        let mut meta = Meta { tol_px: 0.5, ..Meta::default() };
        let mut texts = Vec::new();
        for (i, n) in names.iter().enumerate() {
            meta.marks.push((format!("bars/{i}"), i, None, false));
            for (f, s) in [("label", n.to_string()), ("value_text", format!("{}", vals[i]))] {
                let id = format!("bars/{i}/{f}");
                texts.push(J::obj_of(vec![("id", J::str(&id)), ("w", J::Num(tw(&s, 13.0))), ("h", J::Num(14.95)), ("size", J::Int(13)),
                    ("near", J::obj_of(vec![("marks", J::strs(&[format!("bars/{i}")])), ("from", J::str("anchor")), ("max_px", J::Int(12))]))]));
                meta.texts.push((id, s, J::Null));
            }
        }
        let node = J::obj_of(vec![("knobs", J::obj_of(vec![("x0", J::Int(600))])), ("items", J::Arr(vec![J::Obj(vec![]); 3]))]);
        let (frame, plot, rows) = rows_frame(fr, &node, &meta, 13.0, &vals).unwrap();
        let marks: Vec<J> = vals.iter().enumerate().map(|(i, v)| J::obj_of(vec![("id", J::Str(format!("bars/{i}"))), ("shape", J::str("rect")), ("item", J::Int(i as i64)), ("value", J::Num(*v))])).collect();
        let req = J::obj_of(vec![("node", J::str("bars")), ("frame", frame), ("plot", plot), ("rows", rows), ("encode", e.g("marks").g("encode").clone()), ("marks", J::Arr(marks)), ("texts", J::Arr(texts))]);
        let honest = {
            let r = req.g("rows");
            let (left, bw) = (600.0 + r.g("lw").num().unwrap(), r.g("bw").num().unwrap() - r.g("lw").num().unwrap() - r.g("vw").num().unwrap());
            let mut m = Vec::new();
            let mut t = Vec::new();
            for (i, v) in vals.iter().enumerate() {
                let (y, w) = (6.0 + 24.0 * i as f64, v / 65.4 * bw);
                m.push((format!("bars/{i}"), J::obj_of(vec![("shape", J::str("rect")), ("x", J::Num(left)), ("y", J::Num(y + 3.0)), ("w", J::Num(w)), ("h", J::Int(18))])));
                t.push((format!("bars/{i}/label"), J::obj_of(vec![("x", J::Num(left - 8.0)), ("y", J::Num(y + 12.0)), ("anchor", J::str("end"))])));
                t.push((format!("bars/{i}/value_text"), J::obj_of(vec![("x", J::Num(left + w + 6.0)), ("y", J::Num(y + 12.0)), ("anchor", J::str("start"))])));
            }
            J::obj_of(vec![("marks", J::Obj(m)), ("texts", J::Obj(t))])
        };
        let fails = |r: &J| geometry_problems("bars", &req, r, &meta).unwrap();
        assert_eq!(fails(&honest), Vec::<String>::new());
        let mut longer = honest.clone();
        let w = longer.g("marks").g("bars/1").g("w").num().unwrap();
        assert!(longer.set_path(&["marks", "bars/1", "w"].map(String::from), J::Num(w + 1.0)));
        assert!(fails(&longer).iter().any(|f| f.starts_with("B3 node bars bars/1.w")), "{:?}", fails(&longer));
        let mut moved = honest.clone();
        assert!(moved.set_path(&["marks", "bars/1", "y"].map(String::from), J::Num(57.0)));
        assert!(fails(&moved).iter().any(|f| f.starts_with("B3 node bars bars/1.y")));
        let mut swapped = honest.clone();
        let (a, b) = (swapped.g("texts").g("bars/0/label").clone(), swapped.g("texts").g("bars/2/label").clone());
        assert!(swapped.set_path(&["texts", "bars/0/label"].map(String::from), b) && swapped.set_path(&["texts", "bars/2/label"].map(String::from), a));
        assert!(fails(&swapped).iter().any(|f| f.starts_with("B5 node bars bars/0/label")), "{:?}", fails(&swapped));
    }

    // ---- R11: colour --------------------------------------------------------------------------------------------

    /// The 35 cases in id order, each parsed from its file text as scripts/r11_fixtures.py generates it: three base pages
    /// stored whole (scripts/fixtures/r11/P1-P3.json) and 32 change descriptions (derived.json). The script refuses to
    /// print unless every generated text's sha256 is the one recorded for the case file it replaced, byte for byte.
    fn r11_cases() -> Vec<(String, J)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let out = std::process::Command::new("python3").arg(root.join("scripts/r11_fixtures.py")).arg("dump").output().unwrap();
        assert!(out.status.success(), "r11_fixtures.py dump: {}", String::from_utf8_lossy(&out.stderr));
        let all = parse(std::str::from_utf8(&out.stdout).unwrap()).unwrap();
        let cases: Vec<(String, J)> = all.obj().iter().map(|(id, text)| (id.clone(), parse(&st(text)).unwrap())).collect();
        assert_eq!(cases.len(), 35);
        cases
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

    /// Plan B's registry with q1's bars painted by a threshold scale (test only: no production node is painted).
    fn painted_bars(cuts: J, printed: bool) -> J {
        let mut o = read("registry-b.json");
        let sc = J::obj_of(vec![
            ("kind", J::str("threshold")),
            ("encodes", J::str("value")),
            ("cuts", cuts),
            ("palette", J::str("seq-slate")),
            ("no_data", J::str("nodata")),
            ("printed", J::Bool(printed)),
        ]);
        let bars = o.get_mut("nodes").and_then(|n| n.get_mut("bars")).unwrap();
        bars.set("scales", J::obj_of(vec![("s1", sc)]));
        bars.get_mut("marks").unwrap().set("paint", J::obj_of(vec![("scale", J::str("s1"))]));
        o.get_mut("frames").and_then(|f| f.get_mut("chart")).unwrap().set("legend", J::Arr(vec![J::Int(30), J::Int(228)]));
        o
    }

    /// User 11-07: a count of places (四国, 两个国家, 四个经济体) in the core's words is a number, passed by C3 and the words
    /// lint only when it is the number of distinct places the page draws (q1 draws BE DE FR SE: four); any other count, a
    /// numeral that counts no place, and a count on a page whose places are unknown stay refused.
    #[test]
    fn next_tree_a_count_of_places_passes_only_when_the_page_draws_that_many() {
        let env = read("pos-q1-b.json");
        let reg = reg_of(&env);
        let inp = env.g("input");
        let ext: Vec<String> = env.g("external").arr().iter().map(st).collect();
        assert_eq!(places_drawn(inp.g("page_spec"), inp.g("rows").arr()), Some(4));
        let with_kicker = |w: &str| {
            let mut spec = inp.g("page_spec").clone();
            spec.get_mut("texts").and_then(|t| t.get_mut("kicker")).unwrap().set("runs", J::Arr(vec![J::obj_of(vec![("w", J::str(w))])]));
            content_problems(&spec, inp, &ext, &reg).0
        };
        for w in ["四国对比", "四个经济体对比", "四个国家对比", "四地对比"] {
            assert_eq!(with_kicker(w), Vec::<String>::new(), "{w}");
        }
        for w in ["三国对比", "两国对比", "五个国家对比", "十年前对比", "四国占三成", "近四国对比"] {
            let errs = with_kicker(w);
            assert!(errs.iter().any(|e| e.starts_with("C3 $.texts.kicker")), "{w}: {errs:?}");
            assert!(errs.iter().any(|e| e.contains("lint: $.texts.kicker")), "{w}: {errs:?}");
        }
        // digits stay refused, by the schema before C3
        assert!(with_kicker("4个国家对比").iter().any(|e| e.starts_with("C1 schema")));
        let lit = |w: &str| (w.chars().collect::<Vec<char>>(), vec![false; w.chars().count()]);
        for (w, places, blanked) in [("三国", Some(3), true), ("三国", Some(4), false), ("两国", Some(2), true), ("四个经济体", Some(4), true), ("三国", None, false), ("十年前", Some(10), false)] {
            let (chars, held) = lit(w);
            assert_eq!(place_count(&chars, &held, places)[0], blanked, "{w} {places:?}");
        }
        // a page with no drawn record knows no count
        let bare = J::obj_of(vec![("kind", J::str("Page"))]);
        assert_eq!(places_drawn(&bare, inp.g("rows").arr()), None);
    }

    /// q1 (pos-q1-b) through the core with `overlay`: the bars' SVG and record, or every failure line.
    fn painted_svg(overlay: &J) -> Result<(String, Meta), String> {
        let env = read("pos-q1-b.json");
        let reg = load_registry(overlay);
        let inp = env.g("input");
        let spec = inp.g("page_spec");
        let ext: Vec<String> = env.g("external").arr().iter().map(st).collect();
        let (errs, content) = content_problems(spec, inp, &ext, &reg);
        let content = content.ok_or_else(|| errs.join("\n"))?;
        let (reqs, metas) = issue(spec, inp, &reg, &ext, &content.got, &content.rpage)?;
        let (nid, req) = reqs.iter().find(|(k, _)| k == "bars").unwrap();
        Ok((svg(nid, req, env.g("reply").g(nid), &metas[nid]), metas[nid].clone()))
    }

    /// A node the registry paints by a scale: each mark's class and colour recomputed by the core from its own row and the
    /// cuts (quantile: values of the data; facts: the core's own facts), the legend with the cut facts, and a printed
    /// scale's in-mark numbers in the ink for their colour. A cut that is no fact the core computes is refused.
    #[test]
    fn next_tree_r11_a_painted_node_takes_its_colours_from_the_core() {
        let pf = palettes();
        let quantile = J::obj_of(vec![("rule", J::str("quantile")), ("k", J::Int(3))]);
        let (svg_q, meta) = painted_svg(&painted_bars(quantile.clone(), false)).unwrap();
        let p = meta.paint.as_ref().unwrap();
        let mut vals: Vec<f64> = p.cells.iter().filter_map(|c| c.value).collect();
        vals.sort_by(f64::total_cmp);
        assert_eq!((vals.len(), p.cuts.clone()), (4, vec![vals[2], vals[3]]));
        let steps = p.steps(pf);
        assert_eq!(steps.len(), 3);
        for c in &p.cells {
            let b = bin_of(c.value.unwrap(), &p.cuts);
            assert!(svg_q.contains(&format!("data-id=\"{}\" data-paint=\"s1:{b}\" fill=\"{}\"", c.id, steps[b])), "{}: {svg_q}", c.id);
        }
        assert!(svg_q.contains("<g data-legend=\"s1\">") && svg_q.matches("data-src=\"fact:s1.cut.").count() == 2, "{svg_q}");
        assert!(!svg_q.contains("legend/s1/nodata") && !svg_q.contains("class=\"mark base\"") && !svg_q.contains("class=\"mark accent\""), "{svg_q}");
        // not printed in the marks: the value texts keep the page's own colour
        let body = &svg_q[..svg_q.find("<g data-legend").unwrap()];
        assert!(!body.split("<text").skip(1).any(|t| t[..t.find('>').unwrap()].contains(" fill=")), "{svg_q}");

        let (svg_p, meta) = painted_svg(&painted_bars(quantile, true)).unwrap();
        let p = meta.paint.as_ref().unwrap();
        for c in &p.cells {
            let ink = ink_on(p.paint_of(c, pf).1, pf);
            let tid = c.text_id.clone().unwrap();
            let tail = &svg_p[svg_p.find(&format!("data-id=\"{tid}\"")).unwrap()..];
            assert!(tail[..tail.find('>').unwrap()].ends_with(&format!(" fill=\"{ink}\"")), "{tid}: {svg_p}");
        }

        let facts = |from: &[&str]| J::obj_of(vec![("rule", J::str("facts")), ("from", J::strs(from))]);
        let (_, meta) = painted_svg(&painted_bars(facts(&["fact:val.BE.n", "fact:val.FR.n"]), false)).unwrap();
        let p = meta.paint.as_ref().unwrap();
        let classes: Vec<usize> = p.cells.iter().map(|c| bin_of(c.value.unwrap(), &p.cuts)).collect();
        assert_eq!((p.cuts.len(), classes), (2, vec![2, 2, 2, 1]), "{:?} {:?}", p.cuts, p.cells);
        for (from, why) in [(&["fact:val.FR.n", "fact:val.BE.n"][..], "cuts_not_ascending"), (&["fact:val.BE.n", "fact:99"][..], "cut fact:99: not a fact")] {
            let errs = painted_svg(&painted_bars(facts(from), false)).unwrap_err();
            assert!(errs.starts_with("refused: ") && errs.contains(why), "{from:?}: {errs}");
        }
    }

    /// C5 for a painted node: scale fields, cut rules, palette ids and paint are closed; a scale paints one mark per item
    /// and its frame gives the legend's place; no literal colour anywhere in the entry.
    #[test]
    fn next_tree_r11_registry_refuses_a_scale_the_core_cannot_recompute() {
        let quantile = |k: i64| J::obj_of(vec![("rule", J::str("quantile")), ("k", J::Int(k))]);
        assert_eq!(registry_problems(&load_registry(&painted_bars(quantile(3), true))), Vec::<String>::new());
        let edit = |f: &dyn Fn(&mut J)| {
            let mut o = painted_bars(quantile(3), true);
            f(o.get_mut("nodes").and_then(|n| n.get_mut("bars")).unwrap());
            registry_problems(&load_registry(&o))
        };
        fn scale(b: &mut J, k: &str, v: J) {
            b.get_mut("scales").and_then(|s| s.get_mut("s1")).unwrap().set(k, v);
        }
        let cases: Vec<(&str, Box<dyn Fn(&mut J)>)> = vec![
            ("quantile cuts take one integer k", Box::new(move |b| scale(b, "cuts", quantile(10)))),
            ("rule is quantile or facts", Box::new(|b| scale(b, "cuts", J::obj_of(vec![("rule", J::str("jenks"))])))),
            ("facts cuts are 2..8 fact: references", Box::new(|b| scale(b, "cuts", J::obj_of(vec![("rule", J::str("facts")), ("from", J::Arr(vec![J::Int(1), J::Int(5)]))])))),
            ("is not in the palette file", Box::new(|b| scale(b, "palette", J::str("viridis")))),
            ("a threshold scale has kind", Box::new(|b| scale(b, "domain", J::str("zero_to_max")))),
            ("not one the core recomputes", Box::new(|b| scale(b, "kind", J::str("linear")))),
            ("a literal colour", Box::new(|b| b.get_mut("marks").unwrap().set("paint", J::obj_of(vec![("fill", J::str("#ff00ff"))])))),
            ("one {scale: id} of this entry", Box::new(|b| b.get_mut("marks").unwrap().set("paint", J::obj_of(vec![("scale", J::str("s2"))])))),
            ("paints one mark per item", Box::new(|b| b.get_mut("marks").unwrap().set("per", J::str("part")))),
            ("needs the legend's place", Box::new(|b| b.set("frame", J::str("rows")))),
        ];
        for (why, f) in cases {
            let errs = edit(&*f);
            assert!(errs.iter().any(|e| e.starts_with("C5 registry bars") && e.contains(why)), "{why}: {errs:?}");
        }
    }

    /// The prototype's record of a case (core_color.record): cell values (the printed ones when the scale prints), cuts
    /// from the values or from the case's facts. The cut numbers of a facts case are injected here, in the test only;
    /// the core resolves a cut only through its own facts (paint_record). `lenient` is the prototype's switched-off
    /// cuts_of (mutate.py): quantile the distinct values from the second to the fifth, facts as written.
    fn r11_record(case: &J, lenient: bool) -> Result<Paint, String> {
        let (sc, dec) = (case.g("scale"), case.g("dec").num().unwrap() as usize);
        let printed = sc.g("printed").truthy();
        let cells: Vec<Cell> = case
            .g("items")
            .arr()
            .iter()
            .map(|it| {
                let (id, v) = (st(it.g("id")), it.g("value").num());
                Cell {
                    value: v.map(|v| if printed { printed_value(v, dec) } else { v }),
                    focus: it.g("focus").truthy(),
                    text_id: printed.then(|| format!("{id}/t")),
                    text: v.map(|v| py_fixed(v, dec)),
                    src: it.g("src").s().map(str::to_string),
                    id,
                }
            })
            .collect();
        let values: Vec<f64> = cells.iter().filter_map(|c| c.value).collect();
        let facts = case.g("facts");
        let cuts = if !lenient {
            cuts_of(sc, &values, &|k| facts.g(k).num().ok_or_else(|| format!("'{k}'")), dec)?
        } else if sc.g("cuts").g("rule").s() == Some("quantile") {
            let mut d = values.clone();
            d.sort_by(f64::total_cmp);
            d.dedup();
            d.into_iter().skip(1).take(4).collect()
        } else {
            sc.g("cuts").g("from").arr().iter().filter_map(|r| facts.g(st(r).get(5..).unwrap_or("")).num()).collect()
        };
        Ok(Paint::new(&st(case.g("sid")), sc, cells, cuts, dec, (0.0, 300.0), "\u{65e0}\u{6570}\u{636e}".into()))
    }

    /// The core's own drawing of a case (the prototype's render, cells 40 x 22 at their grid place), from the record.
    fn r11_render(rec: &Paint, case: &J, pf: &J) -> String {
        let ink = st(pf.g("roles").g("ink"));
        let mut o = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" data-node=\"{}\">", rec.sid);
        for l in case.g("labels").arr() {
            let _ = write!(o, "<text x=\"{}\" y=\"{}\" data-id=\"{}\" data-src=\"{}\" fill=\"{ink}\">{}</text>", st(l.g("x")), st(l.g("y")), st(l.g("id")), st(l.g("src")), st(l.g("text")));
        }
        for (c, it) in rec.cells.iter().zip(case.g("items").arr()) {
            let (x, y) = (it.g("at").at(0).num().unwrap() * 40.0, it.g("at").at(1).num().unwrap() * 22.0);
            let _ = write!(o, "<rect x=\"{}\" y=\"{}\" width=\"40\" height=\"22\" data-id=\"{}\"{}/>", num_attr(x), num_attr(y), c.id, rec.mark_attrs(c, pf));
            if let (Some(tid), Some(t)) = (&c.text_id, &c.text) {
                let fill = ink_on(rec.paint_of(c, pf).1, pf);
                let src = c.src.clone().unwrap_or_default();
                let _ = write!(o, "<text x=\"{}\" y=\"{}\" data-id=\"{tid}\" data-src=\"{src}\" fill=\"{fill}\">{t}</text>", num_attr(x + 20.0), num_attr(y + 15.0));
            }
        }
        o.push_str(&rec.legend_svg(pf));
        o.push_str("</svg>");
        o
    }

    /// The prototype's check_node over one case file: palette_ok, then C5 for the entry and the tree's colours, then the
    /// record, then paint_matches_scale and single_accent over the case's SVG (the core's own drawing when it has none).
    /// `off` switches one of them off, as mutate.py does.
    fn r11_check(c: &J, off: &str) -> Vec<String> {
        let (case, pf) = (c.g("case"), c.g("palettes"));
        if off != "palette_ok" {
            let errs = palette_problems(pf);
            if !errs.is_empty() {
                return errs;
            }
        }
        let mut errs = Vec::new();
        if off != "registry" {
            errs.extend(registry_scale_problems(&st(case.g("node")), case.g("registry"), pf));
        }
        if off != "tree" {
            errs.extend(tree_colour_problems(case.g("tree"), pf));
        }
        if !errs.is_empty() {
            return errs;
        }
        let rec = match r11_record(case, off == "cuts") {
            Ok(r) => r,
            Err(e) => return vec![format!("refused: {e}")],
        };
        // a must-pass case is drawn by the core (as the prototype's check_node draws it); a must-fail case brings its SVG
        let given = c.g("svg").s().filter(|_| st(c.g("expect")) != "pass");
        let svg = given.map_or_else(|| r11_render(&rec, case, pf), str::to_string);
        let mut out = if off == "paint_matches_scale" { vec![] } else { paint_problems(&svg, &rec, pf) };
        if off != "single_accent" {
            out.extend(accent_problems(&svg, &[&rec], pf));
        }
        out
    }

    fn r11_as_expected(c: &J, errs: &[String]) -> bool {
        let expect = st(c.g("expect"));
        if expect == "pass" { errs.is_empty() } else { errs.iter().any(|e| e.contains(&expect)) }
    }

    /// The 35 R11 prototype cases (scripts/fixtures/r11, copied from the prototype's cases/): the 3 that must pass pass,
    /// the 32 that must fail are each refused by the check the prototype names, and every failure line's head equals the
    /// prototype's, case by case. The prototype's drawing of each passing case passes too.
    #[test]
    fn next_tree_r11_cases_equal_the_prototype() {
        let (mut off, mut pass, mut fail) = (Vec::new(), 0, 0);
        for (id, c) in r11_cases() {
            let errs = r11_check(&c, "none");
            let proto: Vec<String> = c.g("got").arr().iter().map(st).collect();
            if !r11_as_expected(&c, &errs) || heads(&errs) != heads(&proto) {
                off.push(format!("{id}: rust {:?}; prototype {:?}; first lines {:?}", heads(&errs), heads(&proto), errs.iter().take(3).collect::<Vec<_>>()));
            }
            if st(c.g("expect")) == "pass" {
                pass += 1;
                let (case, pf) = (c.g("case"), c.g("palettes"));
                let rec = r11_record(case, false).unwrap();
                let drawn = st(c.g("svg"));
                let mut errs = paint_problems(&drawn, &rec, pf);
                errs.extend(accent_problems(&drawn, &[&rec], pf));
                assert!(errs.is_empty(), "{id}: the prototype's drawing: {errs:?}");
            } else {
                fail += 1;
            }
        }
        println!("next_tree r11 cases: {}/{} equal to the prototype", pass + fail - off.len(), pass + fail);
        assert!(off.is_empty(), "{}", off.join("\n"));
        assert_eq!((pass, fail), (3, 32));
    }

    /// Each check is load-bearing (mutate.py): switched off, it turns the prototype's count of cases red (palette_ok 7,
    /// C5 1, tree 2, paint_matches_scale 11, single_accent 8, the cut refusals 3).
    #[test]
    fn next_tree_r11_each_colour_check_turns_cases_red_when_off() {
        let cases = r11_cases();
        let red = |off: &str| -> Vec<String> { cases.iter().filter(|(_, c)| !r11_as_expected(c, &r11_check(c, off))).map(|(id, _)| id.clone()).collect() };
        assert_eq!(red("none"), Vec::<String>::new());
        let mut counts = Vec::new();
        for off in ["palette_ok", "registry", "tree", "paint_matches_scale", "single_accent", "cuts"] {
            let r = red(off);
            println!("next_tree r11 {off} off: {} red {r:?}", r.len());
            counts.push(r.len());
        }
        assert_eq!(counts, [7, 1, 2, 11, 8, 3]);
    }

    /// The SVG reader takes only the core's form: a tag in another form or text outside a text element is stray, a
    /// repeated attribute is named, and the colour checks refuse each.
    #[test]
    fn next_tree_r11_svg_reader_takes_only_the_core_form() {
        let els = svg_elements("<svg a=\"1\"><g><rect x=\"0\" fill=\"#ffffff\"/><text data-id=\"t\">6.9</text></g></svg>");
        assert_eq!(els.iter().map(|e| e.tag.as_str()).collect::<Vec<_>>(), ["svg", "g", "rect", "text"]);
        assert_eq!((els[2].get("fill"), els[3].text.as_str()), (Some("#ffffff"), "6.9"));
        for (bad, why) in [
            ("<svg><rect x=0 fill=\"#ffffff\"/></svg>", "text outside any element"),
            ("<svg><g>stray</g></svg>", "text outside any element"),
            ("<svg><rect fill=\"#ffffff\" fill=\"#ff00ff\"/></svg>", "repeats the attribute fill"),
            ("<svg><style>rect{fill:red}</style></svg>", "holds a <style>"),
            ("<svg><rect stop-color=\"#ffffff\"/></svg>", "has stop-color="),
        ] {
            let errs = accent_problems(bad, &[], palettes());
            assert!(errs.iter().any(|e| e.contains(why)), "{bad}: {errs:?}");
        }
    }

    /// A painted node's SVG as the core draws it passes both colour checks; one cell drawn a class up, or the legend
    /// without its first cut, is refused (the production path: content, issue, svg, then the checks node_draw runs).
    #[test]
    fn next_tree_r11_the_core_drawing_passes_and_a_changed_one_is_refused() {
        let quantile = J::obj_of(vec![("rule", J::str("quantile")), ("k", J::Int(3))]);
        for printed in [false, true] {
            let (drawn, meta) = painted_svg(&painted_bars(quantile.clone(), printed)).unwrap();
            assert_eq!(colour_problems(&drawn, &meta), Vec::<String>::new(), "{drawn}");
            let p = meta.paint.as_ref().unwrap();
            let c = p.cells.iter().find(|c| bin_of(c.value.unwrap(), &p.cuts) == 0).unwrap();
            let (tag, fill) = p.paint_of(c, palettes());
            let up = p.steps(palettes())[1];
            let moved = drawn.replace(&format!("data-paint=\"s1:{tag}\" fill=\"{fill}\""), &format!("data-paint=\"s1:1\" fill=\"{up}\""));
            assert_ne!(moved, drawn);
            assert!(colour_problems(&moved, &meta).iter().any(|e| e.starts_with("paint_matches_scale")), "{moved}");
            let cut = drawn.find("data-id=\"legend/s1/cut1\"").unwrap();
            let start = drawn[..cut].rfind("<text").unwrap();
            let end = cut + drawn[cut..].find("</text>").unwrap() + "</text>".len();
            let cutless = format!("{}{}", &drawn[..start], &drawn[end..]);
            assert!(colour_problems(&cutless, &meta).iter().any(|e| e.contains("legend cut texts")), "{cutless}");
        }
    }

    /// The node SVG the core draws for every plan B fixture whose requests it issues (30 fixtures, 72 node SVGs, any reply)
    /// is byte for byte what it was before R11
    /// (base f76026792f1e86f1ac7d2211293629449973c299): a mark no scale paints is drawn as it was. Re-measured when the
    /// core came to print a number as the leaf does (P4a-1 S5b: a .n fact without its unit, the whole part grouped by
    /// thousands): the only bytes that moved are 177 texts, 168 losing their '%' and 9 their gigawatt-hour unit with
    /// "51089" written "51,089"; every other byte and every text's attributes as before.
    #[test]
    fn next_tree_r11_unpainted_svg_is_the_base_bytes() {
        let want = read("prototype-results.json");
        let (mut all, mut n) = (String::new(), 0);
        for (name, _) in want.g("fixtures").obj() {
            let env = read(name);
            let reg = reg_of(&env);
            let inp = env.g("input");
            let spec = inp.g("page_spec");
            let ext: Vec<String> = env.g("external").arr().iter().map(st).collect();
            let Some(content) = content_problems(spec, inp, &ext, &reg).1 else { continue };
            let Ok((reqs, metas)) = issue(spec, inp, &reg, &ext, &content.got, &content.rpage) else { continue };
            let reply = env.g("reply");
            for (nid, req) in &reqs {
                all.push_str(&svg(nid, req, reply.g(nid), &metas[nid]));
                all.push('\n');
            }
            n += 1;
        }
        println!("next_tree r11 unpainted svg: {n} fixtures, {} svgs, sha256 {}", all.lines().count(), sha256_hex(&all));
        // measured at R11 part 1, whose svg() is the base's; re-measured at S5b (numbers printed as the leaf prints them)
        assert_eq!((n, all.lines().count(), sha256_hex(&all).as_str()), (30, 72, "cfd1b685951d4431b14ff8873a7e9109cc8404b303af00524f3881c5a334c39d"));
    }

    /// The flow's leader-note width rule (next_run note_fits, at NOTE_PX 16 and half the 560 px map panel), copied here as
    /// the reference the core's width_at_most is held to.
    fn note_fits_old(words: &str) -> bool {
        let w: f64 = words.chars().map(|c| if c as u32 > 0x2e7f { 16.0 } else { 0.58 * 16.0 }).sum();
        w <= 560.0 / 2.0
    }

    /// covers_whole (B1, owner 11-04): the select's codes are the whole of their dimension only when the rows hold its one
    /// total row at the year and the codes' sum prints as it. A bar page by citizenship (TOTAL, persons) and a flow side by
    /// balance (FC_E, typed total in the parts table, ktoe at one decimal). Must fail: a narrowed page (the total above
    /// the members fetched), no total row, a sum one decimal off, a code with two rows, the total among the codes.
    #[test]
    fn covers_whole_holds_only_when_the_codes_sum_to_the_total_row() {
        let facts = |k: &str| -> Result<f64, String> { Err(format!("'{k}'")) };
        let words = |_: &str| -> Option<String> { None };
        let fmts = parse(r#"{"per": {"scale": 1, "dec": 0}, "ktoe": {"scale": 1, "dec": 1}}"#).unwrap();
        let holds = |table: &str, by: &str, fmt: &str, codes: &[&str], rows: &[(&str, &str)]| {
            let mut got = Got::new();
            got.insert("ranked".into(), J::Arr(codes.iter().map(|c| J::str(c)).collect()));
            let rows: Vec<String> = rows.iter().map(|(c, v)| format!(r#"{{"table": "{table}", "time": "2024", "dims": {{"{by}": "{c}"}}, "value": "{v}"}}"#)).collect();
            let page = parse(&format!(r#"{{"rows": [{}]}}"#, rows.join(", "))).unwrap();
            let hold = Holding { facts: &facts, fmts: &fmts, got: &got, page: &page, code: "", name: None, word: &words };
            let cond = format!(r#"[{{"if": "covers_whole", "select": "ranked", "table": "{table}", "by": "{by}", "time": "2024", "fmt": "{fmt}"}}]"#);
            conditions_hold(&parse(&cond).unwrap(), &hold).unwrap()
        };
        let bars = |total: &str| holds("migr", "citizen", "per", &["SY", "AF", "VE"], &[("SY", "50"), ("AF", "30"), ("VE", "20"), ("TOTAL", total)]);
        assert!(bars("100"), "the three are every citizenship");
        assert!(!bars("150"), "a narrowed page: the rest not fetched");
        assert!(!holds("migr", "citizen", "per", &["SY", "AF", "VE"], &[("SY", "50"), ("AF", "30"), ("VE", "20")]), "no total row");
        assert!(!holds("migr", "citizen", "per", &["SY", "AF", "VE"], &[("SY", "50"), ("SY", "1"), ("AF", "30"), ("VE", "20"), ("TOTAL", "100")]), "a code with two rows");
        assert!(!holds("migr", "citizen", "per", &["SY", "AF", "TOTAL"], &[("SY", "50"), ("AF", "50"), ("TOTAL", "100")]), "the total among the codes");
        let side = |total: &str| holds("nrg_bal_c", "nrg_bal", "ktoe", &["FC_IND_E", "FC_TRA_E"], &[("FC_IND_E", "60.004"), ("FC_TRA_E", "40.004"), ("FC_E", total)]);
        assert!(side("100.01"), "100.008 and 100.01 both print 100.0");
        assert!(!side("100.06"), "100.0 against 100.1: a part left out");
        // FC_E is a total only on nrg_bal of the tables the parts table names
        assert!(!holds("other_table", "nrg_bal", "ktoe", &["FC_IND_E", "FC_TRA_E"], &[("FC_IND_E", "60"), ("FC_TRA_E", "40"), ("FC_E", "100")]));
    }

    /// first_holding over each condition: the first candidate whose conditions all hold, a refusal when none does or a
    /// condition is not CONDITIONS's; width_at_most measures the whole line as note_fits did, at and around its limit.
    #[test]
    fn first_holding_takes_the_first_candidate_whose_conditions_hold() {
        let facts = |k: &str| -> Result<f64, String> {
            match k {
                "chg.SE" => Ok(2.5),
                "chg.FI" => Ok(-1.0),
                "chg.NO" => Ok(0.0),
                "chg.NA" => Ok(f64::NAN),
                "tie" => Ok(0.004),
                "gap" => Ok(0.006),
                k => Err(format!("'{k}'")),
            }
        };
        let words = |k: &str| match k {
            "w.rise" => Some("增幅最大".to_string()),
            "w.vs" => Some("，比第二名高".to_string()),
            "w.ascii" => Some("abcdefghijklmnopqrstuvw".to_string()),
            _ => None,
        };
        let fmts = parse(r#"{"pp": {"scale": 1, "dec": 2, "suffix": "x"}, "pct": {"scale": 100, "dec": 0}}"#).unwrap();
        let mut got = Got::new();
        got.insert("ranked".into(), parse(r#"["SE", "FI"]"#).unwrap());
        let row = |geo: &str, v: &str| format!(r#"{{"table": "t", "time": "2019", "dims": {{"geo": "{geo}", "partner": "EU"}}, "value": {v}}}"#);
        let rows = [row("SE", r#""2.5""#), row("FI", r#""0""#), row("NO", r#""-1""#), row("DK", r#"":""#), row("IS", "4"), row("LV", r#""1""#), row("LV", r#""-3""#)];
        let page = parse(&format!(r#"{{"scoped": true, "plain": false, "n": 1, "rows": [{}]}}"#, rows.join(", "))).unwrap();
        let run = |cands: &str, code: &str, name: &str| {
            let name = (name != "?").then_some(name);
            let hold = Holding { facts: &facts, fmts: &fmts, got: &got, page: &page, code, name, word: &words };
            first_holding(&parse(cands).unwrap(), &hold)
        };
        let sign = |is: &str| format!(r#"[{{"when": [{{"if": "sign", "fact": "chg.{{code}}", "is": "{is}"}}]}}, {{"when": []}}]"#);
        assert_eq!(run(&sign("pos"), "SE", "瑞典"), Ok(0));
        assert_eq!(run(&sign("pos"), "FI", "芬兰"), Ok(1));
        assert_eq!(run(&sign("neg"), "FI", "芬兰"), Ok(0));
        assert_eq!(run(&sign("zero"), "NO", "挪威"), Ok(0));
        assert_eq!(run(&sign("zero"), "NA", "x"), Ok(0), "a NaN reads as zero, as the flow's partial_cmp did");
        assert!(run(&sign("up"), "SE", "瑞典").unwrap_err().contains("is up"));
        // a tie: the gap prints as 0 in its format, so the gap candidate does not hold
        let tie = |fact: &str, fmt: &str| format!(r#"[{{"when": [{{"if": "prints_nonzero", "fact": "{fact}", "fmt": "{fmt}"}}]}}, {{"when": []}}]"#);
        assert_eq!(run(&tie("tie", "pp"), "SE", "瑞典"), Ok(1));
        assert_eq!(run(&tie("gap", "pp"), "SE", "瑞典"), Ok(0));
        assert_eq!(run(&tie("tie", "pct"), "SE", "瑞典"), Ok(1), "0.4 prints as 0 at dec 0");
        assert_eq!(run(&tie("gap", "pct"), "SE", "瑞典"), Ok(0), "0.6 prints as 1");
        assert!(run(&tie("gap", "none"), "SE", "瑞典").unwrap_err().contains("no format none"));
        // a neighbour: the ranked select's length
        let count = |n: u32| format!(r#"[{{"when": [{{"if": "count_at_least", "select": "ranked", "n": {n}}}]}}, {{"when": []}}]"#);
        assert_eq!(run(&count(2), "SE", "瑞典"), Ok(0));
        assert_eq!(run(&count(3), "SE", "瑞典"), Ok(1));
        // the scoped words: a boolean at a path, anything else refused, and no comparison argument
        let flag = |p: &str| format!(r#"[{{"when": [{{"if": "page_is", "path": "{p}"}}]}}, {{"when": []}}]"#);
        assert_eq!(run(&flag("scoped"), "SE", "瑞典"), Ok(0));
        assert_eq!(run(&flag("plain"), "SE", "瑞典"), Ok(1));
        assert!(run(&flag("n"), "SE", "瑞典").unwrap_err().contains("is not true or false"));
        assert!(run(r#"[{"when": [{"if": "page_is", "path": "n", "is": 1}]}]"#, "SE", "瑞典").unwrap_err().contains("no argument is"));
        // what CONDITIONS does not hold is refused, and an item no candidate fits
        assert!(run(r#"[{"when": [{"if": "larger", "fact": "gap"}]}]"#, "SE", "瑞典").unwrap_err().contains("not one the core computes"));
        assert!(run(r#"[{"when": [{"if": "sign", "fact": "chg.{code}", "is": "neg"}]}]"#, "SE", "瑞典").unwrap_err().contains("no candidate"));
        // width_at_most: the line "{name} {word}{vs}" in note_fits's order, the separator space included
        let width = |parts: &str| format!(r#"[{{"when": [{{"if": "width_at_most", "text": {parts}, "size": 16, "max": 280}}]}}, {{"when": []}}]"#);
        for (name, word) in [("瑞典", "w.rise"), ("波斯尼亚和黑塞哥维那", "w.rise"), ("AB", "w.ascii"), ("中文", "w.ascii")] {
            let line = format!("{name} {}{}", words(word).unwrap(), words("w.vs").unwrap());
            let parts = format!(r#"["{{name}}", " ", {{"word": "{word}"}}, {{"word": "w.vs"}}]"#);
            let want = if note_fits_old(&line) { 0 } else { 1 };
            assert_eq!(run(&width(&parts), "SE", name), Ok(want), "{line}: {} px", line_width(&line, 16.0));
        }
        // the limit: 3 CJK (48 px) and 25 others (232 px), 279.99999999999994 by the plain sum; one more character is over, one
        // fewer (short by one space width) holds; each held to note_fits's own answer
        let exact = "A中文字 abcdefghijklmnopqrstuvw";
        assert_eq!((exact.chars().filter(|c| (*c as u32) > 0x2e7f).count(), exact.chars().count()), (3, 28));
        for line in [exact.to_string(), format!("{exact}x"), format!("{exact} "), exact[..exact.len() - 1].to_string(), "AB中文字 abcdefghijklmnopqrstuvw".to_string()] {
            let parts = format!(r#"["{line}"]"#);
            assert_eq!(run(&width(&parts), "SE", "-"), Ok(if note_fits_old(&line) { 0 } else { 1 }), "{line}");
        }
        assert!(!note_fits_old(&format!("{exact}x")) && note_fits_old(&exact[..exact.len() - 1]));
        assert!(run(&width(r#"[{"word": "w.none"}]"#), "SE", "瑞典").unwrap_err().contains("no w.none"));
        // a code the page input names none of: only a condition that prints its name refuses, in the expansion's words
        assert_eq!(run(&width(r#"["{name}"]"#), "XK", "?"), Err("candidate 0: 'XK': the page input names no XK".to_string()));
        assert_eq!(run(&width(r#"["abc"]"#), "XK", "?"), Ok(0));
        // row_above: the map's above_0, a text value above `than` at the table, time and filter; a 0, a negative, an
        // unparsed text, a number that is no text and a missing row do not hold; of two rows any one above holds
        let above = |code: &str, than: &str| format!(r#"[{{"when": [{{"if": "row_above", "table": "t", "time": "2019", "filter": {{"geo": "{code}", "partner": "EU"}}, "than": {than}}}]}}, {{"when": []}}]"#);
        for (code, want) in [("SE", 0), ("FI", 1), ("NO", 1), ("DK", 1), ("IS", 1), ("EE", 1), ("LV", 0)] {
            assert_eq!(run(&above(code, "0"), code, "-"), Ok(want), "{code}");
        }
        assert_eq!(run(&above("NO", "-2"), "NO", "-"), Ok(0));
        assert!(run(&above("SE", r#""0""#), "SE", "-").unwrap_err().contains("row_above: than"));
        // with_code: the code, its lowercase and the page's two years where it has them
        let years = parse(r#"{"picks": {"y0": "19", "y1": "24"}}"#).unwrap();
        assert_eq!(with_code(&J::str("{code_lc}{y0}/{code}{y1}"), "DE", &years), J::str("de19/DE24"));
        assert_eq!(with_code(&J::str("{code_lc}{y0}"), "DE", &page), J::str("de{y0}"));
        // layer_before: the page's order, both layers in it, the first earlier
        let ordered = parse(r#"{"order": ["map", "strip", "bignums"]}"#).unwrap();
        let before = |a: &str, b: &str| {
            let hold = Holding { facts: &facts, fmts: &fmts, got: &got, page: &ordered, code: "", name: None, word: &words };
            conditions_hold(&parse(&format!(r#"[{{"if": "layer_before", "layer": "{a}", "than": "{b}"}}]"#)).unwrap(), &hold).unwrap()
        };
        assert_eq!([before("strip", "bignums"), before("bignums", "strip"), before("ring", "bignums"), before("strip", "notes")], [true, false, false, false]);
        // gap_printable (J2): the page prints the difference unless printed_raise left it in gap_order; is false, the other way
        let gapped = parse(r#"{"gap_order": ["vs_lo"]}"#).unwrap();
        let gap = |fact: &str, is: &str| {
            let hold = Holding { facts: &facts, fmts: &fmts, got: &got, page: &gapped, code: "", name: None, word: &words };
            conditions_hold(&parse(&format!(r#"[{{"if": "gap_printable", "fact": "{fact}"{is}}}]"#)).unwrap(), &hold)
        };
        assert_eq!([gap("vs_lo", ""), gap("vs_hi", ""), gap("vs_lo", r#", "is": false"#), gap("vs_hi", r#", "is": false"#)].map(Result::unwrap), [false, true, true, false]);
        assert!(gap("vs_lo", r#", "is": "no""#).unwrap_err().contains("true or false"));
        assert_eq!(CONDITIONS.map(|(k, _)| k), ["sign", "prints_nonzero", "width_at_most", "count_at_least", "unit_adds_up", "covers_whole", "gap_printable", "page_is", "row_above", "layer_before"]);
        // unit_adds_up (B1): the page's rows' one unit, as the unit registry's additive column says; persons (a count) and
        // ktoe (an amount) add up, a percentage and a per-person rate do not; rows with no unit, or two units, never
        let adds = |units: &[Option<&str>]| {
            let rows: Vec<serde_json::Value> = units
                .iter()
                .enumerate()
                .map(|(i, u)| {
                    let mut dims = serde_json::json!({"geo": format!("G{i}")});
                    if let Some(u) = u {
                        dims["unit"] = serde_json::json!(u);
                    }
                    serde_json::json!({"src": format!("series:t/{i}:2024"), "table": "t", "time": "2024", "dims": dims, "value": "1"})
                })
                .collect();
            let page = J::from_value(&serde_json::json!({"rows": rows}));
            let hold = Holding { facts: &facts, fmts: &fmts, got: &got, page: &page, code: "", name: None, word: &words };
            conditions_hold(&parse(r#"[{"if": "unit_adds_up"}]"#).unwrap(), &hold).unwrap()
        };
        assert_eq!([adds(&[Some("PER"), Some("PER")]), adds(&[Some("KTOE"), Some("KTOE")])], [true, true], "a count, an amount");
        assert_eq!([adds(&[Some("PC"), Some("PC")]), adds(&[Some("TCO2E_HAB"), Some("TCO2E_HAB")])], [false, false], "a share, a rate");
        assert_eq!([adds(&[None, None]), adds(&[Some("PER"), Some("KTOE")]), adds(&[Some("PER"), None]), adds(&[Some("NO_SUCH_UNIT")])], [false; 4]);
        assert!(conditions_hold(&parse(r#"[{"if": "unit_adds_up", "unit": "PER"}]"#).unwrap(), &Holding { facts: &facts, fmts: &fmts, got: &got, page: &gapped, code: "", name: None, word: &words }).unwrap_err().contains("no argument unit"));
    }


    /// A page of selects over rows and formats, recomputed by the core: each select's result.
    fn selects_over(rows: Vec<J>, sels: &[&str], fmts: &str) -> Got {
        let items: Vec<J> = sels.iter().map(|s| parse(s).unwrap()).collect();
        let page = J::obj_of(vec![
            ("kind", J::str("Page")),
            ("selects", J::obj_of(vec![("kind", J::str("Selects")), ("items", J::Arr(items))])),
            ("facts", J::obj_of(vec![("kind", J::str("Facts")), ("tables", J::Obj(vec![])), ("rows", J::Arr(rows)), ("facts", J::Obj(vec![])), ("fmts", parse(fmts).unwrap())])),
            ("checks", J::obj_of(vec![("kind", J::str("Checks")), ("items", J::Arr(vec![]))])),
        ]);
        recheck(&page).1
    }

    fn a_row(code: &str, dim: Option<(&str, &str)>, t: &str, v: &str) -> J {
        let mut dims = serde_json::json!({"geo": code});
        if let Some((d, c)) = dim {
            dims[d] = serde_json::json!(c);
        }
        J::from_value(&serde_json::json!({"src": format!("series:t/{code}:{t}"), "table": "t", "dims": dims, "time": t, "value": v}))
    }

    /// P6 step 7 (finding): a take's value is its root rank's key, as the rank orders by it, not the rank's rows at over.time.
    /// A change rank: two places at one level and two changes (and two changes alike at two levels); a part_share rank: two
    /// places at one total and two shares (and two shares alike at two totals). The take's tie (printed, silence) decides on
    /// the key: the same level never silences two changes, the same change at two levels does; likewise totals and shares.
    #[test]
    fn take_value_is_the_root_rank_s_key_and_the_tie_reads_it() {
        // change: A and B both 50 at 2024, up 40 and 20; C and D both up 25, at 25 and 45
        let rows: Vec<J> = [("A", "10", "50"), ("B", "30", "50"), ("C", "0", "25"), ("D", "20", "45")]
            .iter()
            .flat_map(|(c, a, b)| [a_row(c, None, "2020", a), a_row(c, None, "2024", b)])
            .collect();
        let rank = r#"{"id": "r", "kind": "rank", "over": {"table": "t", "by": "geo", "time": "2024"}, "key": {"change": ["2020", "2024"]}, "order": "desc"}"#;
        let take = r#"{"id": "k", "kind": "take", "from": "r", "at": "first", "tie": {"by": "printed", "outcome": "silence", "dec": 0}}"#;
        let (r, k) = (parse(rank).unwrap(), parse(take).unwrap());
        let sel = vec![("r".to_string(), &r), ("k".to_string(), &k)];
        let key = |c: &str| take_value(&sel, "k", &J::str(c), &rows);
        assert_eq!([key("A"), key("B"), key("C"), key("D")], [Ok(40.0), Ok(20.0), Ok(25.0), Ok(25.0)], "the change, not the level");
        // A first (40), B next (20): one level, two changes, no tie
        let got = selects_over(rows.clone(), &[rank, take], "{}");
        assert_eq!((got["r"].clone(), got["k"].clone()), (parse(r#"["A", "C", "D", "B"]"#).unwrap(), J::str("A")));
        // C and D alone: two levels, one change, a tie
        let cd: Vec<J> = rows.iter().filter(|r| ["C", "D"].contains(&r.g("dims").g("geo").s().unwrap())).cloned().collect();
        let got = selects_over(cd, &[rank, take], "{}");
        assert_eq!(got["k"], J::Null, "one change at two levels is a tie");
        // part_share: P and Q both 100 in total, 30 and 60 of it in F1; R and S both half, of 100 and of 200
        let totals: Vec<J> = [("P", "100"), ("Q", "100"), ("R", "100"), ("S", "200")].iter().map(|(c, v)| a_row(c, Some(("siec", "TOTAL")), "2024", v)).collect();
        let parts: Vec<serde_json::Value> = [("P", "30"), ("Q", "60"), ("R", "50"), ("S", "100")]
            .iter()
            .map(|(c, v)| a_row(c, Some(("siec", "F1")), "2024", v).to_value())
            .collect();
        let rank = |only: &[&str]| {
            serde_json::json!({"id": "r", "kind": "rank", "over": {"table": "t", "filter": {"siec": "TOTAL"}, "by": "geo", "time": "2024"},
                "key": {"part_share": {"dim": "siec", "codes": ["F1"], "rows": parts}}, "order": "desc", "only": only, "numbers_only": true})
            .to_string()
        };
        let take = r#"{"id": "k", "kind": "take", "from": "r", "at": "first", "tie": {"by": "printed", "outcome": "silence", "dec": 0, "scale": 100}}"#;
        let pq = rank(&["P", "Q"]);
        let (r, k) = (parse(&pq).unwrap(), parse(take).unwrap());
        let sel = vec![("r".to_string(), &r), ("k".to_string(), &k)];
        let key = |c: &str| take_value(&sel, "k", &J::str(c), &totals);
        assert_eq!([key("P"), key("Q"), key("R"), key("S")], [Ok(0.3), Ok(0.6), Ok(0.5), Ok(0.5)], "the share, not the total");
        // Q first (60 %), P next (30 %): one total, two shares, no tie
        let got = selects_over(totals.clone(), &[pq.as_str(), take], "{}");
        assert_eq!(got["k"], J::str("Q"));
        // R and S: two totals, one share, a tie
        let got = selects_over(totals.clone(), &[rank(&["R", "S"]).as_str(), take], "{}");
        assert_eq!(got["k"], J::Null, "one share of two totals is a tie");
        // a value rank's take is its level at over.time, as before
        let rank = r#"{"id": "r", "kind": "rank", "over": {"table": "t", "by": "geo", "time": "2024"}, "key": "value", "order": "desc"}"#;
        let r = parse(rank).unwrap();
        let sel = vec![("r".to_string(), &r), ("k".to_string(), &k)];
        assert_eq!(take_value(&sel, "k", &J::str("C"), &rows), Ok(25.0));
        // a tie by value: one number; a tie printed by a format the page lacks prints whole when the tie says so, else refuses
        let by_value = r#"{"id": "k", "kind": "take", "from": "r", "at": "first", "tie": {"by": "value", "outcome": "silence"}}"#;
        let ab: Vec<J> = rows.iter().filter(|r| r.g("time").s() == Some("2024")).cloned().collect();
        assert_eq!(selects_over(ab.clone(), &[rank, by_value], "{}")["k"], J::Null, "A and B are both 50");
        let whole = r#"{"id": "k", "kind": "take", "from": "r", "at": "first", "tie": {"by": "printed", "outcome": "silence", "fmt": "chg", "missing": "whole"}}"#;
        assert_eq!(selects_over(ab.clone(), &[rank, whole], "{}")["k"], J::Null);
        let strict = r#"{"id": "k", "kind": "take", "from": "r", "at": "first", "tie": {"by": "printed", "outcome": "silence", "fmt": "chg"}}"#;
        let items: Vec<J> = [rank, strict].iter().map(|s| parse(s).unwrap()).collect();
        let page = J::obj_of(vec![
            ("kind", J::str("Page")),
            ("selects", J::obj_of(vec![("kind", J::str("Selects")), ("items", J::Arr(items))])),
            ("facts", J::obj_of(vec![("kind", J::str("Facts")), ("tables", J::Obj(vec![])), ("rows", J::Arr(ab)), ("facts", J::Obj(vec![])), ("fmts", J::Obj(vec![]))])),
            ("checks", J::obj_of(vec![("kind", J::str("Checks")), ("items", J::Arr(vec![]))])),
        ]);
        let (bad, _, _) = recheck(&page);
        assert!(bad.iter().any(|b| b.contains("tie fmt chg: no dec")), "{bad:?}");
    }

    /// A take at second with a printed tie (a cut page's headline naming the second kept place) is silent when the second
    /// prints as the third does, or as the first does; a second printed apart from both is the pick. First and last still
    /// read only the one place beside them.
    #[test]
    fn a_second_printed_as_the_third_is_no_pick() {
        let rows = |vals: &[(&str, &str)]| -> Vec<J> { vals.iter().map(|(c, v)| a_row(c, None, "2024", v)).collect() };
        let rank = r#"{"id": "r", "kind": "rank", "over": {"table": "t", "by": "geo", "time": "2024"}, "key": "value", "order": "desc"}"#;
        let second = r#"{"id": "k", "kind": "take", "from": "r", "at": "second", "tie": {"by": "printed", "outcome": "silence", "dec": 0}}"#;
        let first = r#"{"id": "k", "kind": "take", "from": "r", "at": "first", "tie": {"by": "printed", "outcome": "silence", "dec": 0}}"#;
        // A 50, C 30.4, B 30: the second (C) prints 30 as the third does
        let tied = rows(&[("A", "50"), ("B", "30"), ("C", "30.4")]);
        let got = selects_over(tied.clone(), &[rank, second], "{}");
        assert_eq!((got["r"].clone(), got["k"].clone()), (parse(r#"["A", "C", "B"]"#).unwrap(), J::Null), "a second printed as the third");
        // the first is apart from the second there, so the first's take still names it
        assert_eq!(selects_over(tied, &[rank, first], "{}")["k"], J::str("A"));
        // C 34 prints apart from both: the pick
        assert_eq!(selects_over(rows(&[("A", "50"), ("B", "30"), ("C", "34")]), &[rank, second], "{}")["k"], J::str("C"));
        // C 49.8 prints 50 as the first does: silent too
        assert_eq!(selects_over(rows(&[("A", "50"), ("B", "30"), ("C", "49.8")]), &[rank, second], "{}")["k"], J::Null);
        // by value: the second and the third one number
        let by_value = r#"{"id": "k", "kind": "take", "from": "r", "at": "second", "tie": {"by": "value", "outcome": "silence"}}"#;
        assert_eq!(selects_over(rows(&[("A", "50"), ("B", "30"), ("C", "30")]), &[rank, by_value], "{}")["k"], J::Null);
        // two codes: the second is the last, beside the first only
        assert_eq!(selects_over(rows(&[("A", "50"), ("C", "34")]), &[rank, second], "{}")["k"], J::str("C"));
    }

    /// The core's printed tie (py_fixed) and the flow's old printed() are one call, format!("{:.*}"): at every .x5 boundary,
    /// either sign, 0 to 2 decimals, they print the same.
    #[test]
    fn the_printed_tie_rounds_as_the_flow_s_printed_did_at_every_x5_boundary() {
        for (v, dec) in [(0.125, 2), (2.675, 2), (1.005, 2), (0.5, 0), (1.5, 0), (2.5, 0), (0.05, 1), (0.15, 1), (0.25, 1), (16.005, 2), (-0.125, 2), (-2.5, 0), (-0.15, 1)] {
            assert_eq!(py_fixed(v, dec), format!("{:.*}", dec, v), "{v} at {dec}");
            assert_eq!(py_fixed(v * 100.0, 0), format!("{:.0}", v * 100.0), "{v} as a whole percent");
        }
    }
}
