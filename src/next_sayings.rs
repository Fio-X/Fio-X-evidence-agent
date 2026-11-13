//! The flow's sayings check on a published leaf page (plan v4 item 1, works/v4-item1-design.md): every sentence that says
//! something over a whole set of places (the highest, the lowest, a rank, the first N, times as much, above the average, all
//! rising or falling) is held against every place the question names, those the page does not draw included, read from the
//! source's own values; a sentence that says a place has no data is held against the source; a narrowed page's set
//! description (the N most populous) is held against the ranking it describes. What does not hold is returned sentence by
//! sentence, and the flow stops the page on it (next_run page_from, stage SAYINGS_STAGE).
//!
//! One pure function (`unheld`) does the judging; two callers feed it: the flow on the page it just published
//! (`check_published`, reading the run folder the way the page step left it) and the offline measure over archived pages,
//! which rebuilds the prepared tables from the run's events and calls `check_published` on the archived folder. Nothing
//! here writes a file or asks a model.
//!
//! The four kinds of the design:
//! - A (Set): a named place the page does not draw but the source has a value for, at the page's year, is put back into the
//!   set and the set recomputed: a sentence saying the highest (lowest) fails when that place would be the highest (lowest),
//!   one saying times as much, an average or a rank fails whenever the set changes, one saying all rose (fell) fails when
//!   that place moved the other way.
//! - B (Unshown): a named place the page neither draws nor says has no data: every set saying fails, whatever the values.
//!   A group page's member (its basis) the page does not draw, with fetched values in other periods but none at the
//!   page's year, is held as a named place (held_members).
//! - C (NoData): "X has no data" holds only when the source has no value of X at the page's year: the whole table where the
//!   run kept it (the World Bank local copy), else the rows fetched, and then only when the fetch asked for X (or every place),
//!   marked as judged by that fallback.
//! - D (Narrowed): a narrowed page's set description holds only when the places drawn are the description's top N: the
//!   reference's values at the narrow's rank year, over the economies (the codes) that qualify, those with a value of the
//!   page's own table only when the sentence says "with data".
//!
//! Values are only ever compared with each other (which place is the highest), never with a printed number, so the round-off
//! rules of the third plan's cases (half a last unit, GB/T 8170 for an exact .5) never decide anything here.

use crate::l5geo::Place;
use crate::next_flow::{Catalogue, Prepared};
use crate::next_params;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

/// The stop a page whose sayings do not hold is reported under, a step of next_run::LEAF_PLAN_STEPS (plan v4 item 9).
pub const SAYINGS_STAGE: &str = "sayings";

/// What the flow records of the sayings check on the page just published: {recipe, published, html_sha256, unheld}.
pub const SAYINGS_EVENT: &str = "next_sayings";

/// One block of text the page shows (a heading, a paragraph, an svg text): its words as shown, and the sources its marked
/// spans name (data-src: a fact, a name row, a period).
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub said: String,
    pub srcs: Vec<String>,
}

/// A place the question names, as the page's rows write it (`code`), with the other codes that stand for it (its iso2, a
/// Eurostat code that differs, a partner member coded for it).
#[derive(Clone, Debug, PartialEq)]
pub struct Named {
    pub code: String,
    pub aliases: Vec<String>,
}

impl Named {
    fn is(&self, code: &str) -> bool {
        self.code == code || self.aliases.iter().any(|a| a == code)
    }
}

/// The published page as the check reads it: its text blocks, every code its main table's rows hold in any dimension but
/// frequency and unit, and its main table's values by (place, time) in its place dimension, with the page's year (`t1`) and
/// first year (`t0`, none for a page of one year).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Page {
    pub blocks: Vec<Block>,
    pub drawn: BTreeSet<String>,
    pub values: BTreeMap<(String, String), f64>,
    pub t1: String,
    pub t0: Option<String>,
}

/// The source of the page's main table: the place codes its fetch asked for (None: every place), the values it fetched by
/// (place, time), and the whole table's by (place, time) where the run kept it (None: not kept).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Source {
    pub asked: Option<BTreeSet<String>>,
    pub fetched: BTreeMap<(String, String), f64>,
    pub whole: Option<BTreeMap<(String, String), f64>>,
}

impl Source {
    /// The source's value of a place at a time, and whether it was read by the fallback (the rows fetched, no whole table).
    /// Ok(None) when the source has none; Err when only the fetch could tell and it never asked for the place.
    fn value(&self, place: &Named, time: &str) -> Result<(Option<f64>, bool), String> {
        let find = |m: &BTreeMap<(String, String), f64>| {
            std::iter::once(&place.code)
                .chain(place.aliases.iter())
                .find_map(|c| m.get(&(c.clone(), time.to_string())).copied())
        };
        if let Some(whole) = &self.whole {
            return Ok((find(whole), false));
        }
        let asked = match &self.asked {
            None => true,
            Some(a) => a.iter().any(|c| place.is(c)),
        };
        match find(&self.fetched) {
            Some(v) => Ok((Some(v), true)),
            None if asked => Ok((None, true)),
            None => Err(format!(
                "the fetch never asked the source for {} and the run kept no whole table",
                place.code
            )),
        }
    }
}

/// A narrowed page's ranking: the count it keeps (`n`), its rank time (`at`), whether it keeps the lowest (`bottom`), each
/// qualifying code's reference value at `at`, the codes with a value of the page's own table (None: the reference is the
/// page's own table) and the codes drawn in the narrowed dimension.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Narrow {
    pub n: usize,
    pub at: String,
    pub bottom: bool,
    pub reference: BTreeMap<String, f64>,
    pub with_value: Option<BTreeSet<String>>,
    pub drawn: BTreeSet<String>,
}

/// The kind of saying that does not hold (design: A, B, C, D).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Set,
    Unshown,
    NoData,
    Narrowed,
}

impl Kind {
    pub fn letter(self) -> &'static str {
        match self {
            Kind::Set => "A",
            Kind::Unshown => "B",
            Kind::NoData => "C",
            Kind::Narrowed => "D",
        }
    }
}

/// One sentence of the page that does not hold: the sentence as shown, its kind, why, and whether it was judged by the
/// fallback (the rows fetched, the source's whole table not kept).
#[derive(Clone, Debug, PartialEq)]
pub struct Unheld {
    pub sentence: String,
    pub kind: Kind,
    pub why: String,
    pub fallback: bool,
}

impl Unheld {
    pub fn to_json(&self) -> Value {
        json!({"sentence": self.sentence, "kind": self.kind.letter(), "why": self.why, "fallback": self.fallback})
    }
}

/// The words the check reads sentences by (next_knowledge::SET_SAYINGS_ZH, and the no-data words of ASKED_PLACES_ZH's said).
#[derive(Clone, Debug, PartialEq)]
pub struct Words {
    most: Vec<String>,
    least: Vec<String>,
    rank: Vec<String>,
    times: Vec<String>,
    mean: Vec<String>,
    all: Vec<String>,
    up: Vec<String>,
    down: Vec<String>,
    count: Vec<String>,
    with_data: String,
    no_data: String,
}

impl Words {
    /// The knowledge group's word files, read as data.
    pub fn read() -> Result<Words, String> {
        let set: Value = serde_json::from_str(crate::next_knowledge::SET_SAYINGS_ZH)
            .map_err(|e| format!("set-sayings-zh.json: {e}"))?;
        let said: Value = serde_json::from_str(crate::next_knowledge::ASKED_PLACES_ZH)
            .map_err(|e| format!("asked-places-zh.json: {e}"))?;
        let list = |key: &str| -> Result<Vec<String>, String> {
            let words: Vec<String> = set[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            if words.is_empty() {
                return Err(format!("set-sayings-zh.json holds no {key}"));
            }
            Ok(words)
        };
        let one = |key: &str| {
            set[key]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("set-sayings-zh.json holds no {key}"))
        };
        let no_data = said["said"]
            .as_str()
            .and_then(|s| s.split_once("{missing}"))
            .map(|(_, after)| after.trim().to_string())
            .filter(|w| !w.is_empty())
            .ok_or("asked-places-zh.json: its said has no words after {missing}")?;
        let num = numerals();
        if num.units.len() != 10 || num.two.is_none() || num.ten.is_none() {
            return Err("set-sayings-zh.json: numerals needs ten units, two and ten".into());
        }
        Ok(Words {
            most: list("most")?,
            least: list("least")?,
            rank: list("rank")?,
            times: list("times")?,
            mean: list("mean")?,
            all: list("all")?,
            up: list("up")?,
            down: list("down")?,
            count: list("count")?,
            with_data: one("with_data")?,
            no_data,
        })
    }

    fn any(said: &str, words: &[String]) -> bool {
        words.iter().any(|w| found(said, w).is_some())
    }

    /// A sentence that says something over the whole set.
    fn over_set(&self, said: &str) -> bool {
        [
            &self.most,
            &self.least,
            &self.rank,
            &self.times,
            &self.mean,
            &self.all,
        ]
        .iter()
        .any(|w| Words::any(said, w))
    }

    /// A sentence about a change between two years (a rise or a fall).
    fn of_change(&self, said: &str) -> bool {
        Words::any(said, &self.up) || Words::any(said, &self.down)
    }
}

/// Where `word` is found in `said`, and the count it holds when it has "{d}" (ASCII digits or Chinese numerals, with spaces
/// around allowed). None when it is not found.
fn found(said: &str, word: &str) -> Option<Option<u32>> {
    let Some((before, after)) = word.split_once("{d}") else {
        return said.contains(word).then_some(None);
    };
    let chars: Vec<char> = said.chars().collect();
    let (b, a): (Vec<char>, Vec<char>) = (before.chars().collect(), after.chars().collect());
    for start in 0..=chars.len() {
        if !chars[start..].starts_with(&b) {
            continue;
        }
        let mut i = start + b.len();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let from = i;
        // a count starts a number: "1.0 个百分点" holds no count 0
        if from > 0 && (chars[from - 1].is_ascii_digit() || chars[from - 1] == '.') {
            continue;
        }
        let num = numerals();
        while i < chars.len() && (chars[i].is_ascii_digit() || num.holds(chars[i])) {
            i += 1;
        }
        if i == from {
            continue;
        }
        let digits: String = chars[from..i].iter().collect();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if chars[i..].starts_with(&a) {
            return Some(count_of(&digits));
        }
    }
    None
}

/// The Chinese numerals a count may be written in (set-sayings-zh.json numerals): the units by value, the other two and ten.
struct Numerals {
    units: Vec<char>,
    two: Option<char>,
    ten: Option<char>,
}

impl Numerals {
    fn holds(&self, c: char) -> bool {
        self.units.contains(&c) || self.two == Some(c) || self.ten == Some(c)
    }

    fn unit(&self, c: char) -> Option<u32> {
        self.units.iter().position(|u| *u == c).map(|i| i as u32).or((self.two == Some(c)).then_some(2))
    }
}

/// The word file's numerals, read once; none (ASCII counts only) when the file has none, which Words::read refuses.
fn numerals() -> &'static Numerals {
    static NUMERALS: std::sync::OnceLock<Numerals> = std::sync::OnceLock::new();
    NUMERALS.get_or_init(|| {
        let set: Value = serde_json::from_str(crate::next_knowledge::SET_SAYINGS_ZH).unwrap_or_default();
        let n = &set["numerals"];
        let one = |k: &str| n[k].as_str().and_then(|s| s.chars().next());
        Numerals { units: n["units"].as_str().unwrap_or("").chars().collect(), two: one("two"), ten: one("ten") }
    })
}

/// A count written in ASCII digits or in Chinese numerals up to 99.
fn count_of(digits: &str) -> Option<u32> {
    if let Ok(n) = digits.parse() {
        return Some(n);
    }
    let num = numerals();
    let ten = num.ten?;
    let chars: Vec<char> = digits.chars().collect();
    match chars.as_slice() {
        [t] if *t == ten => Some(10),
        [c] => num.unit(*c),
        [t, u] if *t == ten => Some(10 + num.unit(*u)?),
        [t, x] if *x == ten => Some(num.unit(*t)? * 10),
        [t, x, u] if *x == ten => Some(num.unit(*t)? * 10 + num.unit(*u)?),
        _ => None,
    }
}

/// The text blocks of a published page: each run of text between two tags that are not inline (span, b, i, em, strong,
/// tspan, a, small, sup, sub), with the data-src of every marked span inside it; script and style skipped, and so is an
/// element marked hidden (a chart's description repeating the title). Spaces are collapsed; empty blocks are dropped.
pub fn blocks_of(html: &str) -> Vec<Block> {
    const INLINE: [&str; 10] = [
        "span", "b", "i", "em", "strong", "tspan", "a", "small", "sup", "sub",
    ];
    let mut blocks = Vec::new();
    let (mut said, mut srcs) = (String::new(), Vec::new());
    let flush = |said: &mut String, srcs: &mut Vec<String>, blocks: &mut Vec<Block>| {
        let text = said.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            blocks.push(Block {
                said: text,
                srcs: std::mem::take(srcs),
            });
        }
        said.clear();
        srcs.clear();
    };
    let mut rest = html;
    // a hidden element (or script, style) being skipped: its tag name and how deep inside it the scan is
    let mut skip: Option<(String, usize)> = None;
    while !rest.is_empty() {
        let Some(open) = rest.find('<') else {
            if skip.is_none() {
                said.push_str(&unescape(rest));
            }
            break;
        };
        if skip.is_none() {
            said.push_str(&unescape(&rest[..open]));
        }
        rest = &rest[open..];
        if rest.starts_with("<!--") {
            rest = rest.find("-->").map_or("", |e| &rest[e + 3..]);
            continue;
        }
        let close = tag_end(rest);
        let tag = &rest[1..close];
        rest = &rest[(close + 1).min(rest.len())..];
        let closing = tag.starts_with('/');
        let body = tag.trim_start_matches('/');
        let name: String = body
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let selfclosing = body.trim_end().ends_with('/');
        if let Some((skipped, depth)) = skip.as_mut() {
            if *skipped == name {
                if closing {
                    *depth -= 1;
                    if *depth == 0 {
                        skip = None;
                    }
                } else if !selfclosing {
                    *depth += 1;
                }
            }
            continue;
        }
        if !closing
            && !selfclosing
            && (name == "script" || name == "style" || has_attr(body, "hidden"))
        {
            flush(&mut said, &mut srcs, &mut blocks);
            skip = Some((name, 1));
            continue;
        }
        let inline = INLINE.contains(&name.as_str());
        if !inline {
            flush(&mut said, &mut srcs, &mut blocks);
        }
        if !closing {
            if let Some(src) = attr(body, "data-src") {
                srcs.push(src);
            }
        }
    }
    flush(&mut said, &mut srcs, &mut blocks);
    blocks
}

/// The index of the '>' that ends the tag `rest` starts with, quotes skipped; the end of `rest` when there is none.
fn tag_end(rest: &str) -> usize {
    let mut quote: Option<char> = None;
    for (i, c) in rest.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"') | (None, '\'') => quote = Some(c),
            (None, '>') => return i,
            _ => {}
        }
    }
    rest.len()
}

/// An attribute's value in a tag's body (name="value"), unescaped.
fn attr(body: &str, key: &str) -> Option<String> {
    let mut at = 0;
    while let Some(i) = body[at..].find(key) {
        let start = at + i;
        let before = body[..start].chars().last();
        let after = &body[start + key.len()..];
        if before.is_some_and(char::is_whitespace) {
            if let Some(v) = after.trim_start().strip_prefix('=') {
                let v = v.trim_start();
                let q = v.chars().next()?;
                if q == '"' || q == '\'' {
                    let end = v[1..].find(q)? + 1;
                    return Some(unescape(&v[1..end]));
                }
            }
        }
        at = start + key.len();
    }
    None
}

/// Whether a tag's body carries a bare or valued attribute of this name.
fn has_attr(body: &str, key: &str) -> bool {
    body.split(|c: char| c.is_whitespace() || c == '/')
        .skip(1)
        .any(|part| part == key || part.starts_with(&format!("{key}=")))
}

/// The text of html with its character references read (the named ones a page writes, and numeric ones).
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let c = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            e if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16)
                .ok()
                .and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A place the page says has no data that the question does not name on its own (a group's member): its code, with its
/// Eurostat or iso2 counterpart where they differ (EL is GR).
fn unnamed(code: &str) -> Named {
    let aliases = next_params::ESTAT_ISO
        .iter()
        .filter_map(|(e, i)| {
            if *e == code {
                Some(i.to_string())
            } else if *i == code {
                Some(e.to_string())
            } else {
                None
            }
        })
        .collect();
    Named {
        code: code.to_string(),
        aliases,
    }
}

/// The code a name row marks (name:<table>:<scheme>:<code>), none for another source.
fn name_code(src: &str) -> Option<&str> {
    src.strip_prefix("name:")
        .and_then(|s| s.rsplit(':').next())
        .filter(|c| !c.is_empty())
}

/// The sentences of the page that do not hold, over the places the question names (`named`, as the page's rows write them),
/// the page, its main table's source and its narrowing (a narrowed page's only). See the module's head for the four kinds.
pub fn unheld(
    named: &[Named],
    page: &Page,
    source: &Source,
    narrow: Option<&Narrow>,
    words: &Words,
) -> Vec<Unheld> {
    let mut out: Vec<Unheld> = Vec::new();
    let mut push = |u: Unheld| {
        if !out
            .iter()
            .any(|o| o.sentence == u.sentence && o.kind == u.kind && o.why == u.why)
        {
            out.push(u);
        }
    };
    let set_blocks: Vec<&Block> = page
        .blocks
        .iter()
        .filter(|b| words.over_set(&b.said))
        .collect();
    // the places the page says have no data: the name rows of each block holding the no-data words
    let mut said_missing: Vec<(&Block, String)> = Vec::new();
    for b in page
        .blocks
        .iter()
        .filter(|b| b.said.contains(&words.no_data))
    {
        for code in b.srcs.iter().filter_map(|s| name_code(s)) {
            if !page.drawn.contains(code) {
                said_missing.push((b, code.to_string()));
            }
        }
    }
    // C: each place said to have no data, against the source at the page's year
    for (block, code) in &said_missing {
        let place = named
            .iter()
            .find(|n| n.is(code))
            .cloned()
            .unwrap_or_else(|| unnamed(code));
        match source.value(&place, &page.t1) {
            Ok((Some(v), fallback)) => push(Unheld {
                sentence: block.said.clone(),
                kind: Kind::NoData,
                why: format!(
                    "the page says {code} has no data, but the source has {code} at {} = {v}",
                    page.t1
                ),
                fallback,
            }),
            Ok((None, _)) => {}
            Err(why) => push(Unheld {
                sentence: block.said.clone(),
                kind: Kind::NoData,
                why: format!("the page says {code} has no data: {why}"),
                fallback: true,
            }),
        }
    }
    // the named places the page does not draw
    for place in named.iter().filter(|n| {
        !page.drawn.contains(&n.code) && !n.aliases.iter().any(|a| page.drawn.contains(a))
    }) {
        let said = said_missing.iter().any(|(_, c)| place.is(c));
        if !said {
            // B: neither drawn nor said to have no data
            for b in &set_blocks {
                push(Unheld {
                    sentence: b.said.clone(),
                    kind: Kind::Unshown,
                    why: format!(
                        "the question names {}, which the page neither draws nor says has no data: a saying over the whole set cannot hold",
                        place.code
                    ),
                    fallback: false,
                });
            }
            continue;
        }
        // A: said to have no data; when the source has it after all (C above), the set is recomputed with it
        let Ok((Some(v1), fallback)) = source.value(place, &page.t1) else {
            continue;
        };
        let v0 = page
            .t0
            .as_ref()
            .and_then(|t0| source.value(place, t0).ok())
            .and_then(|(v, _)| v);
        for b in &set_blocks {
            if let Some(why) = set_changed(page, place, (v0, v1), &b.said, words) {
                push(Unheld {
                    sentence: b.said.clone(),
                    kind: Kind::Set,
                    why,
                    fallback,
                });
            }
        }
    }
    // D: a narrowed page's set description
    if let Some(nr) = narrow {
        for b in page
            .blocks
            .iter()
            .filter(|b| words.over_set(&b.said) || found(&b.said, &words.with_data).is_some())
        {
            let Some(printed) = words.count.iter().find_map(|w| found(&b.said, w)) else {
                continue;
            };
            if let Some(why) = narrow_fails(nr, printed, found(&b.said, &words.with_data).is_some())
            {
                push(Unheld {
                    sentence: b.said.clone(),
                    kind: Kind::Narrowed,
                    why,
                    fallback: false,
                });
            }
        }
    }
    out
}

/// Why a set saying no longer holds once `place` (with its source values at t0 and t1) joins the page's set, or None when
/// it still does. A sentence about a change compares the change from t0 to t1, any other the value at t1.
fn set_changed(
    page: &Page,
    place: &Named,
    (v0, v1): (Option<f64>, f64),
    said: &str,
    words: &Words,
) -> Option<String> {
    let change = words.of_change(said) && page.t0.is_some();
    let metric_of = |code: &str| -> Option<f64> {
        let at1 = page.values.get(&(code.to_string(), page.t1.clone()))?;
        if change {
            let at0 = page.values.get(&(code.to_string(), page.t0.clone()?))?;
            Some(at1 - at0)
        } else {
            Some(*at1)
        }
    };
    let drawn: Vec<f64> = page
        .values
        .keys()
        .map(|(c, _)| c.clone())
        .collect::<BTreeSet<_>>()
        .iter()
        .filter_map(|c| metric_of(c))
        .collect();
    let x = if change { v1 - v0? } else { v1 };
    let (hi, lo) = drawn
        .iter()
        .fold((f64::NEG_INFINITY, f64::INFINITY), |(h, l), v| {
            (h.max(*v), l.min(*v))
        });
    let what = if change { "its change" } else { "its value" };
    let code = &place.code;
    if Words::any(said, &words.most) && x > hi {
        return Some(format!("with {code} put back ({what} {x}) the highest of the set is {code}, not the page's ({hi})"));
    }
    if Words::any(said, &words.least) && x < lo {
        return Some(format!("with {code} put back ({what} {x}) the lowest of the set is {code}, not the page's ({lo})"));
    }
    if Words::any(said, &words.times) && (x > hi || x < lo) {
        return Some(format!("with {code} put back ({what} {x}) the set's highest or lowest changes, and so does a times-as-much"));
    }
    if Words::any(said, &words.mean) || Words::any(said, &words.rank) {
        return Some(format!("with {code} put back ({what} {x}) the set's average and ranks are no longer the page's"));
    }
    if Words::any(said, &words.all) && change {
        let rose = Words::any(said, &words.up);
        let fell = Words::any(said, &words.down);
        if (rose && x <= 0.0) || (fell && x >= 0.0) {
            return Some(format!("with {code} put back (its change {x}) not every place moved the way the sentence says"));
        }
    }
    None
}

/// Why a narrowed page's set description printing `printed` places does not hold (None: it holds): the drawn places must be
/// as many as the narrow keeps and the description says, and each must rank (by the reference at the rank time) at or above
/// every qualifying place not drawn; with `with_data` a place qualifies only with a value of the page's own table.
fn narrow_fails(nr: &Narrow, printed: Option<u32>, with_data: bool) -> Option<String> {
    let qualifies = |c: &str| !with_data || nr.with_value.as_ref().is_none_or(|w| w.contains(c));
    let pool: BTreeMap<&str, f64> = nr
        .reference
        .iter()
        .filter(|(c, _)| qualifies(c))
        .map(|(c, v)| (c.as_str(), *v))
        .collect();
    let drawn: Vec<&String> = nr.drawn.iter().collect();
    if printed.is_some_and(|p| p as usize != drawn.len()) {
        return Some(format!(
            "the description says {} places, the page draws {}",
            printed.unwrap_or(0),
            drawn.len()
        ));
    }
    if drawn.len() != nr.n {
        return Some(format!(
            "the narrow keeps {} places, the page draws {}",
            nr.n,
            drawn.len()
        ));
    }
    let better = |a: f64, b: f64| if nr.bottom { a < b } else { a > b };
    // the drawn place ranked last, and the best qualifying place not drawn
    let mut worst: Option<(&str, f64)> = None;
    for c in &drawn {
        let Some(v) = pool.get(c.as_str()).copied() else {
            return Some(format!(
                "{c} is drawn but has no reference value at {} among the qualifying places",
                nr.at
            ));
        };
        if worst.is_none_or(|(_, w)| better(w, v)) {
            worst = Some((c.as_str(), v));
        }
    }
    let outside = pool.iter().filter(|(c, _)| !nr.drawn.contains(**c)).fold(
        None,
        |best: Option<(&str, f64)>, (c, v)| {
            if best.is_none_or(|(_, b)| better(*v, b)) {
                Some((c, *v))
            } else {
                best
            }
        },
    );
    match (worst, outside) {
        (Some((w, wv)), Some((o, ov))) if better(ov, wv) => Some(format!(
            "{o} ({ov} at {}) is not drawn and ranks before the drawn {w} ({wv}){}",
            nr.at,
            if with_data {
                ""
            } else {
                "; the sentence does not say the places are those with data"
            }
        )),
        _ => None,
    }
}

// ---- the readers both callers share: the run folder as the page step left it ----

/// The sayings of the leaf page published under publications/<recipe>/ in `run_dir` that do not hold, for `question`, with
/// the page's prepared tables (the first the main) and the catalogue. Err when the page's files cannot be read.
pub fn check_published(
    run_dir: &Path,
    recipe: &str,
    question: &str,
    prepared: &[Prepared],
    catalogue: &dyn Catalogue,
) -> Result<Vec<Unheld>, String> {
    let words = Words::read()?;
    let main = prepared.first().ok_or("no prepared table")?;
    let request: Value = read_json(run_dir, &format!("publications/{recipe}/request.json"))?;
    let html = std::fs::read_to_string(run_dir.join(format!("publications/{recipe}/index.html")))
        .map_err(|e| format!("publications/{recipe}/index.html: {e}"))?;
    let meta = catalogue
        .table(&main.id)
        .ok_or_else(|| format!("the catalogue lists no {}", main.id))?;
    let rows: Vec<&Value> = request["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["table"] == main.id.as_str())
        .collect();
    let origins = origins(run_dir);
    let narrow_rec = origins.iter().find(|o| {
        let kind = o["origin"].as_str().unwrap_or("");
        (kind == "worldbank_narrow" || kind == "eurostat_narrow")
            && same_file(o["file"].as_str(), &main.file)
    });
    let place_dim = place_dim(&meta, &rows, narrow_rec);
    let mut page = page_of(&html, &rows, &place_dim);
    if let Some(y) = request
        .pointer("/spec/asked_places/year")
        .and_then(Value::as_str)
        .filter(|y| !y.is_empty())
    {
        page.t1 = y.to_string();
    }
    let mut named = named_of(catalogue, question, &meta)?;
    let source = source_of(run_dir, catalogue, &meta, main, &rows, &place_dim, &origins)?;
    held_members(&mut named, request.pointer("/knobs/spec/basis/members"), &page, &source);
    let narrow = match narrow_rec {
        Some(rec) => narrow_of(run_dir, rec, &rows)?,
        None => None,
    };
    Ok(unheld(&named, &page, &source, narrow.as_ref(), &words))
}

/// A group page's members (its basis, knobs.spec.basis.members, as the page's rows write them; the knowledge group's
/// group_basis) that the page does not draw and the fetched rows hold a value of in another period but none at the page's
/// year are held as places the question names: each must be said to have no data (B), and joins the set where the source
/// has it after all (A). A member already named stays as it is; one the fetched rows hold no value of, or one with a value
/// at the page's year, is no member lacking the page's year and is held to nothing new.
fn held_members(named: &mut Vec<Named>, members: Option<&Value>, page: &Page, source: &Source) {
    for m in members.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let with_value = source.fetched.keys().any(|(c, _)| c == m);
        let at_t1 = source.fetched.contains_key(&(m.to_string(), page.t1.clone()));
        if named.iter().any(|n| n.is(m)) || page.drawn.contains(m) || !with_value || at_t1 {
            continue;
        }
        named.push(Named {
            code: m.to_string(),
            aliases: Vec::new(),
        });
    }
}

fn read_json(run_dir: &Path, rel: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(run_dir.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{rel}: {e}"))
}

/// Whether a record's file (data/<sha>.<ext>) is the prepared table's file, compared by file name.
fn same_file(rec: Option<&str>, file: &str) -> bool {
    let name = |p: &str| Path::new(p).file_name().map(|n| n.to_os_string());
    rec.is_some_and(|r| name(r).is_some() && name(r) == name(file))
}

/// The run's origin records (data/origins/*.json), in file name order.
fn origins(run_dir: &Path) -> Vec<Value> {
    let mut files: Vec<_> = std::fs::read_dir(run_dir.join("data/origins"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect()
}

/// The dimensions of a row but frequency and unit.
fn place_like(r: &Value) -> Vec<(String, String)> {
    r["dims"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(d, _)| d.as_str() != next_params::FREQ_DIM && d.as_str() != next_params::UNIT_DIM)
        .filter_map(|(d, v)| Some((d.clone(), v.as_str()?.to_string())))
        .collect()
}

/// The dimension the page's places are in: a World Bank table's country, a narrowed Eurostat table's narrowed dimension,
/// else geo when the rows hold it, else the one with the most codes in the rows.
fn place_dim(meta: &crate::l5geo::TableMeta, rows: &[&Value], narrow: Option<&Value>) -> String {
    if meta.worldbank {
        return next_params::WB_PLACE_DIM.to_string();
    }
    if let Some(d) = narrow.and_then(|n| n["dimension"].as_str()) {
        return d.to_string();
    }
    let mut codes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for r in rows {
        for (d, v) in place_like(r) {
            codes.entry(d).or_default().insert(v);
        }
    }
    if codes.contains_key("geo") {
        return "geo".to_string();
    }
    codes
        .into_iter()
        .max_by_key(|(_, c)| c.len())
        .map(|(d, _)| d)
        .unwrap_or_default()
}

/// The page as the check reads it from its html and its main table's rows.
fn page_of(html: &str, rows: &[&Value], place_dim: &str) -> Page {
    let mut page = Page {
        blocks: blocks_of(html),
        ..Page::default()
    };
    let mut times: BTreeSet<String> = BTreeSet::new();
    for r in rows {
        for (_, v) in place_like(r) {
            page.drawn.insert(v);
        }
        let (Some(code), Some(time), Some(v)) = (
            r["dims"][place_dim].as_str(),
            r["time"].as_str(),
            r["value"].as_f64(),
        ) else {
            continue;
        };
        page.values.insert((code.to_string(), time.to_string()), v);
        times.insert(time.to_string());
    }
    page.t1 = times.iter().next_back().cloned().unwrap_or_default();
    page.t0 = times.iter().next().filter(|t| **t != page.t1).cloned();
    page
}

/// The places the question names on their own (the knowledge group's places, countries and aggregates only), as the page's
/// rows write them: a World Bank table's by iso3, a Eurostat table's by its own code where it differs, each with its iso2 and
/// the partner or citizen members coded for it as aliases.
fn named_of(
    catalogue: &dyn Catalogue,
    question: &str,
    meta: &crate::l5geo::TableMeta,
) -> Result<Vec<Named>, String> {
    let mut iso2: Vec<String> = Vec::new();
    for p in catalogue.places(question) {
        if let Place::Country(c) = p {
            if !iso2.contains(&c) {
                iso2.push(c);
            }
        }
    }
    if iso2.is_empty() {
        return Ok(Vec::new());
    }
    let of = if meta.worldbank {
        catalogue.iso3_of(&iso2)?
    } else {
        BTreeMap::new()
    };
    Ok(iso2
        .iter()
        .map(|c| {
            let code = if meta.worldbank {
                of.get(c).cloned().unwrap_or_else(|| c.clone())
            } else {
                next_params::ESTAT_ISO
                    .iter()
                    .find(|(_, i)| *i == c.as_str())
                    .map_or(c.clone(), |(e, _)| e.to_string())
            };
            let mut aliases = vec![c.clone()];
            for (_, m) in meta.place_members.iter() {
                for (k, iso) in m {
                    if iso == c && !aliases.contains(k) {
                        aliases.push(k.clone());
                    }
                }
            }
            aliases.retain(|a| *a != code);
            Named { code, aliases }
        })
        .collect())
}

/// The main table's source: what its fetch asked for in the place dimension, its fetched rows of the page's series (the
/// rows' other dimensions as on the page), and the World Bank local copy when the run kept it.
fn source_of(
    run_dir: &Path,
    catalogue: &dyn Catalogue,
    meta: &crate::l5geo::TableMeta,
    main: &Prepared,
    rows: &[&Value],
    place_dim: &str,
    origins: &[Value],
) -> Result<Source, String> {
    let csv = std::fs::read_to_string(run_dir.join(&main.file))
        .map_err(|e| format!("the fetched file {}: {e}", main.file))?;
    let fetched_rows = catalogue.series_rows(meta, &csv)?;
    let other = |r: &Value| -> Vec<(String, String)> {
        place_like(r)
            .into_iter()
            .filter(|(d, _)| d != place_dim)
            .collect()
    };
    let series: BTreeSet<Vec<(String, String)>> = rows.iter().map(|r| other(r)).collect();
    let mut fetched = BTreeMap::new();
    for r in &fetched_rows {
        if !series.is_empty() && !series.contains(&other(r)) {
            continue;
        }
        if let (Some(code), Some(time), Some(v)) = (
            r["dims"][place_dim].as_str(),
            r["time"].as_str(),
            r["value"].as_f64(),
        ) {
            fetched.insert((code.to_string(), time.to_string()), v);
        }
    }
    let asked: Option<BTreeSet<String>> = main
        .args
        .get("filters")
        .and_then(Value::as_array)
        .and_then(|fs| {
            fs.iter()
                .find(|f| f["dimension"].as_str() == Some(place_dim))
                .map(|f| {
                    f["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
        });
    let whole = if meta.worldbank {
        worldbank_whole(run_dir, &meta.id, origins)?
    } else {
        None
    };
    Ok(Source {
        asked,
        fetched,
        whole,
    })
}

/// The World Bank local copy of an indicator the run kept (its worldbank_local_copy record's file, a gzipped table of
/// indicator, country_id, iso3, year, value, obs_status) by (iso3, year); None when the run kept none.
fn worldbank_whole(
    run_dir: &Path,
    id: &str,
    origins: &[Value],
) -> Result<Option<BTreeMap<(String, String), f64>>, String> {
    let indicator = id.strip_suffix("@2").unwrap_or(id);
    let marker = format!("/indicator/{indicator}?");
    let Some(file) = origins
        .iter()
        .filter(|o| o["origin"] == "worldbank_local_copy")
        .find(|o| {
            o["requested_url"]
                .as_str()
                .is_some_and(|u| u.contains(&marker))
        })
        .and_then(|o| o["file"].as_str())
    else {
        return Ok(None);
    };
    let bytes = std::fs::read(run_dir.join(file)).map_err(|e| format!("{file}: {e}"))?;
    let mut text = String::new();
    flate2::read::GzDecoder::new(&bytes[..])
        .read_to_string(&mut text)
        .map_err(|e| format!("{file}: {e}"))?;
    let mut lines = text.lines();
    let head: Vec<&str> = lines.next().unwrap_or("").split('\t').collect();
    let col = |name: &str| {
        head.iter()
            .position(|h| *h == name)
            .ok_or_else(|| format!("{file}: no {name} field in its header"))
    };
    let (iso3, year, value) = (col("iso3")?, col("year")?, col("value")?);
    let mut whole = BTreeMap::new();
    for line in lines {
        let f: Vec<&str> = line.split('\t').collect();
        if let (Some(c), Some(y), Some(v)) = (
            f.get(iso3),
            f.get(year),
            f.get(value).and_then(|v| v.trim().parse::<f64>().ok()),
        ) {
            whole.insert((c.to_string(), y.to_string()), v);
        }
    }
    Ok(Some(whole))
}

/// The fields of one csv line, quotes read ("Korea, Rep." is one field).
fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            (true, '"') => quoted = false,
            (false, '"') => quoted = true,
            (false, ',') => out.push(std::mem::take(&mut field)),
            _ => field.push(c),
        }
    }
    out.push(field);
    out
}

/// A csv file of the run as its header's columns, each line a map from column to field.
fn csv_table(run_dir: &Path, file: &str) -> Result<Vec<BTreeMap<String, String>>, String> {
    let text = std::fs::read_to_string(run_dir.join(file)).map_err(|e| format!("{file}: {e}"))?;
    let mut lines = text.lines();
    let head = csv_fields(lines.next().unwrap_or(""));
    Ok(lines
        .filter(|l| !l.trim().is_empty())
        .map(|l| head.iter().cloned().zip(csv_fields(l)).collect())
        .collect())
}

/// The ranking a narrowed main table's record describes (a worldbank_narrow or eurostat_narrow record), read from the
/// files the record names; None when the record's reference holds more than one value of a code at the rank time (it
/// ranks no single series) or names no reference file.
fn narrow_of(run_dir: &Path, rec: &Value, rows: &[&Value]) -> Result<Option<Narrow>, String> {
    let n = rec["n"].as_u64().ok_or("the narrow record has no n")? as usize;
    let at = rec["at"]
        .as_str()
        .ok_or("the narrow record has no at")?
        .to_string();
    let bottom = rec["rule"] == "bottom";
    if rec["origin"] == "worldbank_narrow" {
        let full = rec.pointer("/inputs/full/file").and_then(Value::as_str);
        let by = rec["by"]
            .as_str()
            .and_then(|_| rec.pointer("/inputs/by/file").and_then(Value::as_str));
        let Some(reference_file) = by.or(full) else {
            return Ok(None);
        };
        // an economy: a country list region other than the aggregates
        let economies = |file: &str| -> Result<Vec<BTreeMap<String, String>>, String> {
            Ok(csv_table(run_dir, file)?
                .into_iter()
                .filter(|r| r.get("region").is_some_and(|g| g.trim() != "Aggregates"))
                .collect())
        };
        let mut reference = BTreeMap::new();
        for r in economies(reference_file)? {
            if r.get("date") == Some(&at) {
                if let (Some(c), Some(v)) = (
                    r.get("country"),
                    r.get("value").and_then(|v| v.trim().parse::<f64>().ok()),
                ) {
                    reference.insert(c.clone(), v);
                }
            }
        }
        let with_value = match (by, full) {
            (Some(_), Some(full)) => Some(
                economies(full)?
                    .into_iter()
                    .filter(|r| {
                        r.get("value")
                            .is_some_and(|v| v.trim().parse::<f64>().is_ok())
                    })
                    .filter_map(|r| r.get("country").cloned())
                    .collect(),
            ),
            _ => None,
        };
        let drawn = rows
            .iter()
            .filter_map(|r| {
                r["dims"][next_params::WB_PLACE_DIM]
                    .as_str()
                    .map(str::to_string)
            })
            .collect();
        return Ok(Some(Narrow {
            n,
            at,
            bottom,
            reference,
            with_value,
            drawn,
        }));
    }
    // a Eurostat narrow: the first file's values of the narrowed dimension at the rank time, the total and the excluded
    // codes never ranked
    let dim = rec["dimension"]
        .as_str()
        .ok_or("the narrow record has no dimension")?;
    let Some(first) = rec.pointer("/first/file").and_then(Value::as_str) else {
        return Ok(None);
    };
    let never: BTreeSet<&str> = rec["exclude"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(rec["total"].as_str())
        .collect();
    let mut reference: BTreeMap<String, f64> = BTreeMap::new();
    for r in csv_table(run_dir, first)? {
        let (Some(c), Some(t), Some(v)) = (
            r.get(dim),
            r.get("TIME_PERIOD"),
            r.get("OBS_VALUE")
                .and_then(|v| v.trim().parse::<f64>().ok()),
        ) else {
            continue;
        };
        if t != &at || never.contains(c.as_str()) {
            continue;
        }
        if reference.insert(c.clone(), v).is_some_and(|old| old != v) {
            return Ok(None);
        }
    }
    let drawn = rows
        .iter()
        .filter_map(|r| r["dims"][dim].as_str())
        .filter(|c| !never.contains(c))
        .map(str::to_string)
        .collect();
    Ok(Some(Narrow {
        n,
        at,
        bottom,
        reference,
        with_value: None,
        drawn,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words() -> Words {
        Words::read().unwrap()
    }

    fn block(said: &str, srcs: &[&str]) -> Block {
        Block {
            said: said.to_string(),
            srcs: srcs.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn named(code: &str) -> Named {
        Named {
            code: code.to_string(),
            aliases: Vec::new(),
        }
    }

    /// n37's page (the EU, the United States and China named; the United States and China drawn at 2022).
    fn n37_page(unit_line: Block) -> Page {
        let mut values = BTreeMap::new();
        values.insert(("USA".to_string(), "2022".to_string()), 3.48736);
        values.insert(("CHN".to_string(), "2022".to_string()), 2.4945);
        Page {
            blocks: vec![
                block("研发投入强度的高低排名", &[]),
                block("美国最高，是最低者中国的1.4倍", &["fact:times.n"]),
                block(
                    "2022 年，美国最高，为3.49%，比最低的中国高1.0 个百分点",
                    &["fact:lead1.t.y", "fact:hi.n", "fact:gap.n"],
                ),
                unit_line,
                block(
                    "美国 比最低者高 1.0 个百分点",
                    &["name:zh_names:iso3:USA", "fact:gap"],
                ),
                block("数据来源：世界银行 GB.XPD.RSDV.GD.ZS", &[]),
            ],
            drawn: ["USA", "CHN"].iter().map(|s| s.to_string()).collect(),
            values,
            t1: "2022".into(),
            t0: None,
        }
    }

    fn n37_named() -> Vec<Named> {
        vec![named("EUU"), named("USA"), named("CHN")]
    }

    #[test]
    fn a_named_place_not_drawn_and_not_said_fails_every_set_saying() {
        let page = n37_page(block(
            "单位：%；2022 年",
            &["period:GB.XPD.RSDV.GD.ZS@2:2022"],
        ));
        let source = Source {
            asked: Some(["USA", "CHN"].iter().map(|s| s.to_string()).collect()),
            ..Source::default()
        };
        let u = unheld(&n37_named(), &page, &source, None, &words());
        assert!(u.iter().all(|u| u.kind == Kind::Unshown), "{u:?}");
        // the kicker (a ranking), the title, the dek and the note: four set sayings; the source line is none
        assert_eq!(u.len(), 4, "{u:?}");
        assert!(u.iter().all(|u| u.why.contains("EUU")));
    }

    /// Round 10's r5: a page for the EU's members drawn at 2024 without Romania, whose rows end at 2023. The member is held
    /// as named (held_members): the page's line saying Romania has no data holds, and without the line every set saying
    /// fails; a member the fetched rows hold no value of (Greece, round 10's t4) or one with a value at 2024 the page does
    /// not draw is held to nothing new, and a page with no basis holds none.
    #[test]
    fn a_group_member_without_a_value_at_the_page_year_is_held_as_named() {
        let page_with = |unit: Block| Page {
            blocks: vec![block("2024 年，德国最高，最低的是塞浦路斯", &["fact:hi.n"]), unit],
            drawn: ["DE", "CY", "AT"].iter().map(|s| s.to_string()).collect(),
            t1: "2024".into(),
            ..Page::default()
        };
        let mut fetched = BTreeMap::new();
        for (c, t, v) in [("DE", "2024", 69.0), ("CY", "2024", 15.8), ("AT", "2024", 60.0), ("RO", "2023", 12.4), ("SK", "2024", 50.0)] {
            fetched.insert((c.to_string(), t.to_string()), v);
        }
        let source = Source {
            asked: Some(["DE", "CY", "AT", "RO", "SK", "EL"].iter().map(|s| s.to_string()).collect()),
            fetched,
            whole: None,
        };
        let members = json!(["AT", "CY", "DE", "EL", "RO", "SK"]);
        let line = block(
            "单位：%；按现有成员国计，画出 3 国，2024 年罗马尼亚无数据",
            &["fact:drawn.n", "period:cei_wm011:2024", "name:zh_names:iso2:RO"],
        );
        let page = page_with(line);
        let mut held: Vec<Named> = Vec::new();
        held_members(&mut held, Some(&members), &page, &source);
        assert_eq!(held, vec![named("RO")]);
        assert_eq!(unheld(&held, &page, &source, None, &words()), Vec::new());
        // the same page without its line: Romania is neither drawn nor said
        let bare = page_with(block("单位：%", &[]));
        let mut held: Vec<Named> = Vec::new();
        held_members(&mut held, Some(&members), &bare, &source);
        let u = unheld(&held, &bare, &source, None, &words());
        assert_eq!(u.len(), 1, "{u:?}");
        assert!(u[0].kind == Kind::Unshown && u[0].why.contains("RO"), "{u:?}");
        // a member already named stays once; no basis, nothing held
        let mut held = vec![named("RO")];
        held_members(&mut held, Some(&members), &bare, &source);
        assert_eq!(held, vec![named("RO")]);
        let mut held: Vec<Named> = Vec::new();
        held_members(&mut held, None, &bare, &source);
        assert!(held.is_empty());
    }

    #[test]
    fn no_data_said_of_a_place_the_whole_table_holds_fails_and_the_set_is_recomputed() {
        let page = n37_page(block(
            "单位：%；欧盟无数据；2022 年",
            &["name:zh_names:iso3:EUU", "period:GB.XPD.RSDV.GD.ZS@2:2022"],
        ));
        let mut whole = BTreeMap::new();
        whole.insert(("EUU".to_string(), "2022".to_string()), 2.22738);
        whole.insert(("USA".to_string(), "2022".to_string()), 3.48736);
        let source = Source {
            asked: Some(["USA", "CHN"].iter().map(|s| s.to_string()).collect()),
            whole: Some(whole),
            ..Source::default()
        };
        let u = unheld(&n37_named(), &page, &source, None, &words());
        let c: Vec<&Unheld> = u.iter().filter(|u| u.kind == Kind::NoData).collect();
        assert_eq!(c.len(), 1, "{u:?}");
        assert!(
            c[0].sentence.contains("欧盟无数据") && !c[0].fallback,
            "{c:?}"
        );
        // the EU (2.23) is below China (2.49): every sentence saying the lowest or times as much fails, the kicker's ranking too
        let a: Vec<&str> = u
            .iter()
            .filter(|u| u.kind == Kind::Set)
            .map(|u| u.sentence.as_str())
            .collect();
        assert_eq!(a.len(), 4, "{a:?}");
        assert!(!u.iter().any(|u| u.kind == Kind::Unshown), "{u:?}");
    }

    #[test]
    fn no_data_holds_only_when_the_source_has_none() {
        let page = n37_page(block(
            "单位：%；欧盟无数据；2022 年",
            &["name:zh_names:iso3:EUU"],
        ));
        // the whole table has no EU at 2022: the line holds and the set is the page's
        let whole: BTreeMap<(String, String), f64> =
            [(("EUU".to_string(), "2021".to_string()), 2.1)]
                .into_iter()
                .collect();
        let source = Source {
            whole: Some(whole),
            ..Source::default()
        };
        assert!(unheld(&n37_named(), &page, &source, None, &words()).is_empty());
        // no whole table: the fetch asked for the EU and got no row of it (fallback, holds)
        let asked: BTreeSet<String> = ["EUU", "USA", "CHN"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let source = Source {
            asked: Some(asked),
            ..Source::default()
        };
        assert!(unheld(&n37_named(), &page, &source, None, &words()).is_empty());
        // no whole table and the fetch never asked for the EU: the line cannot be said (fallback, fails)
        let source = Source {
            asked: Some(["USA", "CHN"].iter().map(|s| s.to_string()).collect()),
            ..Source::default()
        };
        let u = unheld(&n37_named(), &page, &source, None, &words());
        assert!(
            u.len() == 1 && u[0].kind == Kind::NoData && u[0].fallback,
            "{u:?}"
        );
        // every place fetched (no filter) and a row of the EU there: fails, read by the fallback
        let fetched = [(("EUU".to_string(), "2022".to_string()), 2.2)]
            .into_iter()
            .collect();
        let source = Source {
            fetched,
            ..Source::default()
        };
        let u = unheld(&n37_named(), &page, &source, None, &words());
        assert!(
            u.iter().any(|u| u.kind == Kind::NoData && u.fallback),
            "{u:?}"
        );
    }

    #[test]
    fn a_place_put_back_in_the_middle_breaks_no_extreme() {
        let page = n37_page(block(
            "单位：%；欧盟无数据；2022 年",
            &["name:zh_names:iso3:EUU"],
        ));
        let whole = [(("EUU".to_string(), "2022".to_string()), 3.0)]
            .into_iter()
            .collect();
        let source = Source {
            whole: Some(whole),
            ..Source::default()
        };
        let u = unheld(&n37_named(), &page, &source, None, &words());
        // the no-data line fails (C); "the highest", "the lowest" and the times stay with the US and China; the kicker's
        // ranking does not
        assert!(u.iter().any(|u| u.kind == Kind::NoData));
        let a: Vec<&str> = u
            .iter()
            .filter(|u| u.kind == Kind::Set)
            .map(|u| u.sentence.as_str())
            .collect();
        assert_eq!(a, ["研发投入强度的高低排名"], "{u:?}");
    }

    /// 东亚 (owner 11-13): the near note next_run near_noted puts on the unit line is words only: no saying over the set and
    /// no place said to have no data, so the page holds as without it.
    #[test]
    fn a_near_note_on_the_unit_line_holds_as_words() {
        let note = "；世行没有单列『东亚』，最接近的是『东亚与太平洋』，含东南亚和太平洋岛国";
        let page = n37_page(block(&format!("单位：%；2022 年{note}"), &[]));
        let u = unheld(&[named("USA"), named("CHN")], &page, &Source::default(), None, &words());
        assert!(u.is_empty(), "{u:?}");
    }

    #[test]
    fn every_named_place_drawn_holds() {
        let page = n37_page(block("单位：%；2022 年", &[]));
        let u = unheld(
            &[named("USA"), named("CHN")],
            &page,
            &Source::default(),
            None,
            &words(),
        );
        assert!(u.is_empty(), "{u:?}");
        // a scope named (no place): nothing to hold the page to
        assert!(unheld(&[], &page, &Source::default(), None, &words()).is_empty());
        // a named place drawn under an alias (a partner member coded for it)
        let mut page = page;
        page.drawn.insert("CN_X_HK".into());
        page.drawn.remove("CHN");
        let cn = Named {
            code: "CN".into(),
            aliases: vec!["CN_X_HK".into()],
        };
        assert!(unheld(
            &[named("USA"), cn],
            &page,
            &Source::default(),
            None,
            &words()
        )
        .is_empty());
    }

    /// n31 (round 8): narrowed to the 3 most populous economies with a value of the table; China, the most populous, has none.
    fn n31_narrow() -> Narrow {
        let reference: BTreeMap<String, f64> = [
            ("IND", 1.42e9),
            ("CHN", 1.41e9),
            ("USA", 3.33e8),
            ("IDN", 2.75e8),
            ("PAK", 2.4e8),
        ]
        .iter()
        .map(|(c, v)| (c.to_string(), *v))
        .collect();
        let with_value = Some(
            ["IND", "USA", "IDN", "PAK"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );
        let drawn = ["IND", "USA", "IDN"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        Narrow {
            n: 3,
            at: "2022".into(),
            bottom: false,
            reference,
            with_value,
            drawn,
        }
    }

    #[test]
    fn a_narrowed_set_described_without_with_data_fails_when_a_larger_economy_is_left_out() {
        let page = Page {
            blocks: vec![block("印度在人口最多的 3 个经济体中增幅最大", &[])],
            ..Page::default()
        };
        let u = unheld(
            &[],
            &page,
            &Source::default(),
            Some(&n31_narrow()),
            &words(),
        );
        assert!(
            u.len() == 1 && u[0].kind == Kind::Narrowed && u[0].why.contains("CHN"),
            "{u:?}"
        );
        // the round 9 wording: the three most populous with data
        let page = Page {
            blocks: vec![block("在人口最多、有数据的3个经济体中", &[])],
            ..Page::default()
        };
        assert!(unheld(
            &[],
            &page,
            &Source::default(),
            Some(&n31_narrow()),
            &words()
        )
        .is_empty());
        // a count the page does not draw
        let page = Page {
            blocks: vec![block("在人口最多、有数据的 4 个经济体中", &[])],
            ..Page::default()
        };
        let u = unheld(
            &[],
            &page,
            &Source::default(),
            Some(&n31_narrow()),
            &words(),
        );
        assert!(u.len() == 1 && u[0].why.contains("says 4"), "{u:?}");
        // a drawn place below one left out, with data: fails whatever the words
        let mut nr = n31_narrow();
        nr.drawn = ["IND", "USA", "PAK"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let page = Page {
            blocks: vec![block("在人口最多、有数据的三个经济体中", &[])],
            ..Page::default()
        };
        let u = unheld(&[], &page, &Source::default(), Some(&nr), &words());
        assert!(u.len() == 1 && u[0].why.contains("IDN"), "{u:?}");
    }

    #[test]
    fn a_change_sentence_compares_changes() {
        let mut values = BTreeMap::new();
        for (c, a, b) in [("DE", 10.0, 20.0), ("FR", 10.0, 12.0)] {
            values.insert((c.to_string(), "2010".to_string()), a);
            values.insert((c.to_string(), "2020".to_string()), b);
        }
        let page = Page {
            blocks: vec![
                block("德国增幅最大", &[]),
                block("意大利无数据", &["name:zh_names:iso2:IT"]),
                block("各国都在上升", &[]),
            ],
            drawn: ["DE", "FR"].iter().map(|s| s.to_string()).collect(),
            values,
            t1: "2020".into(),
            t0: Some("2010".into()),
        };
        // Italy fetched after all, rising 6 (below Germany's 10) and so no new highest; all rose still holds
        let fetched: BTreeMap<(String, String), f64> = [
            (("IT".to_string(), "2010".to_string()), 10.0),
            (("IT".to_string(), "2020".to_string()), 16.0),
        ]
        .into_iter()
        .collect();
        let source = Source {
            fetched: fetched.clone(),
            ..Source::default()
        };
        let u = unheld(
            &[named("DE"), named("FR"), named("IT")],
            &page,
            &source,
            None,
            &words(),
        );
        assert!(
            u.len() == 1 && u[0].kind == Kind::NoData && u[0].fallback,
            "{u:?}"
        );
        // rising 15, more than Germany: the highest rise is Italy's
        let fetched: BTreeMap<(String, String), f64> = [
            (("IT".to_string(), "2010".to_string()), 1.0),
            (("IT".to_string(), "2020".to_string()), 16.0),
        ]
        .into_iter()
        .collect();
        let source = Source {
            fetched,
            ..Source::default()
        };
        let u = unheld(
            &[named("DE"), named("FR"), named("IT")],
            &page,
            &source,
            None,
            &words(),
        );
        assert!(
            u.iter()
                .any(|u| u.kind == Kind::Set && u.sentence == "德国增幅最大"),
            "{u:?}"
        );
        // Italy falling: every place rose is no longer true
        let fetched: BTreeMap<(String, String), f64> = [
            (("IT".to_string(), "2010".to_string()), 20.0),
            (("IT".to_string(), "2020".to_string()), 16.0),
        ]
        .into_iter()
        .collect();
        let source = Source {
            fetched,
            ..Source::default()
        };
        let u = unheld(
            &[named("DE"), named("FR"), named("IT")],
            &page,
            &source,
            None,
            &words(),
        );
        assert!(
            u.iter()
                .any(|u| u.kind == Kind::Set && u.sentence == "各国都在上升"),
            "{u:?}"
        );
    }

    #[test]
    fn counts_and_words_are_found_in_either_numerals() {
        assert_eq!(found("人口最多的 3 个经济体", "{d}个"), Some(Some(3)));
        assert_eq!(found("前十二个", "前{d}"), Some(Some(12)));
        assert_eq!(found("第二十名", "第{d}"), Some(Some(20)));
        assert_eq!(found("两个", "{d}个"), Some(Some(2)));
        assert_eq!(found("个人", "{d}个"), None);
        assert_eq!(found("最高", "最高"), Some(None));
    }

    #[test]
    fn blocks_are_read_from_the_published_html() {
        let html = r#"<body><div class="pg"><header><div class="kicker">研发投入强度的高低排名</div><h1>美国最高，是最低者中国的<b class="n"><span data-src="fact:times.n">1.4</span>倍</b></h1></header><div class="cu">单位：%；<span data-src="name:zh_names:iso3:EUU">欧盟</span>无数据；<span data-src="period:X:2022">2022</span> 年</div><svg><text x="1"><tspan data-src="name:zh_names:iso3:USA">美国</tspan> 比最低者高 <tspan font-weight="700"><tspan data-src="fact:gap">1.0 个百分点</tspan></tspan></text></svg><p id="d" hidden="">美国最高，<b>隐藏</b></p><script>var x = "<h1>no</h1>";</script><footer>A &amp; B</footer></div></body>"#;
        let b = blocks_of(html);
        let said: Vec<&str> = b.iter().map(|b| b.said.as_str()).collect();
        assert_eq!(
            said,
            [
                "研发投入强度的高低排名",
                "美国最高，是最低者中国的1.4倍",
                "单位：%；欧盟无数据；2022 年",
                "美国 比最低者高 1.0 个百分点",
                "A & B"
            ]
        );
        assert_eq!(b[2].srcs, ["name:zh_names:iso3:EUU", "period:X:2022"]);
        assert_eq!(b[3].srcs, ["name:zh_names:iso3:USA", "fact:gap"]);
    }

    #[test]
    fn the_word_files_read() {
        let w = words();
        assert_eq!(w.no_data, "无数据");
        assert!(
            w.over_set("美国最高")
                && w.over_set("在本指标最高的8个经济体中")
                && !w.over_set("数据来源：世界银行")
        );
    }
}
