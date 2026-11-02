//! New route, visual group: the number path every node prints through. A number goes on the page only through
//! `Ledger::num`, which marks its element with where the number was read (`data-src`) and enters it in the ledger;
//! `check_numbers` reads the written page back and fails any digit that is neither inside an element printing its ledger
//! entry as entered nor a table id the page names. Dates and years are numbers too: they go through the ledger with their
//! data row, and the check exempts no digit. A name whose digits are part of it (G20, EU27, PM2.5) is a ledger entry too:
//! `Ledger::label` marks it with the code-list or name row it was read from, and the page must print that row's text
//! exactly. Pure: it holds no state and writes nothing.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::next_facts::{Fact, Row, Spec, SERIES_SRC};

/// A number from the data: where it was read (a claim id and column, or a series, row key and column), its value (for the
/// geometry) and its text as the data gives it (what the page prints).
#[derive(Clone, Debug, PartialEq)]
pub struct Num {
    pub src: String,
    pub value: f64,
    pub text: String,
}

/// Where a label is read: a row of a code list or name table, never a value.
pub const LABEL_SRC: &str = "name:";

/// The name row a leaf marks a place's name with (runtime/leaves_py/prod.py name_src): the Chinese name table, two-letter
/// codes as iso2 and the rest as iso3, as next_run's leaf_labels looks them up.
pub fn name_src(code: &str) -> String {
    format!("{LABEL_SRC}zh_names:{}:{code}", if code.len() == 2 { "iso2" } else { "iso3" })
}

/// Where a map point a leaf drew a place at is read: the point table (its name and sha256) and the code. A ledger entry of
/// this kind is never printed; it keeps the point ([lon, lat] as "lon,lat") with the page's request, so a replay of that
/// table can be held to it.
pub const POINT_SRC: &str = "point:";

/// The ledger entry of a place's map point read from `table` of `sha256`, and its text.
pub fn point_entry(table: &str, sha256: &str, code: &str, at: [f64; 2]) -> (String, String) {
    (format!("{POINT_SRC}{table}@{sha256}:{code}"), format!("{},{}", at[0], at[1]))
}

/// Where a thing a layer was given and did not draw is kept: the layer and the thing's id (a place's code where the leaf
/// has one). A ledger entry of this kind is never printed; its text is why, in the leaf's words, so the page's request says
/// what the page leaves out.
pub const DROPPED_SRC: &str = "dropped:";

/// The ledger entry of an item `layer` dropped, and its text.
pub fn dropped_entry(layer: &str, id: &str, why: &str) -> (String, String) {
    (format!("{DROPPED_SRC}{layer}:{id}"), why.to_string())
}

/// A name from the data: the code-list or name row it was read from (`LABEL_SRC` then the table, the list and the code) and
/// that row's text as given. It may hold digits (G20, EU27, PM2.5) but is a name, not a number.
#[derive(Clone, Debug, PartialEq)]
pub struct Label {
    pub src: String,
    pub text: String,
}

/// A piece of prose: words (drafted by the program, or reworded and checked), a number from the data, a name from the
/// data, or a table id.
#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Text(String),
    Num(Num),
    Label(Label),
    Ref(String),
}

/// The page's one script: it only says the page is laid out once the fonts are in (browser_qa.py waits for it).
pub const READY_JS: &str = "document.fonts.ready.then(function(){window.__ADN_READY=true;});";

pub fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Whether the text prints the value: it reads as a number within half a unit of its last place.
pub(crate) fn prints(text: &str, value: f64) -> bool {
    let Ok(read) = text.parse::<f64>() else {
        return false;
    };
    let places = text.split_once('.').map_or(0, |(_, f)| f.len()) as i32;
    value.is_finite() && (read - value).abs() <= 0.5 * 10f64.powi(-places) + 1e-9
}

/// What the page has printed so far, and what it could not print.
#[derive(Debug, Default)]
pub struct Ledger {
    entries: BTreeMap<String, String>,
    /// Each value printed so far (its bits) with the source and text it was first printed with.
    values: BTreeMap<u64, (String, String)>,
    errors: Vec<String>,
}

impl Ledger {
    /// The one way a number goes on the page: the element `tag` (span in HTML, tspan in SVG) marked with its source. One
    /// value prints one way on a page, whichever source it is read from (a claim and the series row it is about).
    pub fn num(&mut self, tag: &str, class: &str, n: &Num) -> String {
        if !prints(&n.text, n.value) {
            self.errors.push(format!(
                "{}: the text {:?} does not print the value {}",
                n.src, n.text, n.value
            ));
        }
        if n.src.starts_with(LABEL_SRC) {
            self.errors.push(format!(
                "{}: a number is read from a value, not a name row",
                n.src
            ));
        }
        let first = self
            .values
            .entry((n.value + 0.0).to_bits())
            .or_insert_with(|| (n.src.clone(), n.text.clone()));
        if first.0 != n.src && first.1 != n.text {
            self.errors.push(format!(
                "{}: the value {} is printed {:?} here and {:?} at {}",
                n.src, n.value, n.text, first.1, first.0
            ));
        }
        self.enter(tag, class, &n.src, &n.text)
    }

    /// The one way a name with digits goes on the page: marked with its code-list or name row like a number, its text as
    /// that row gives it. A text with no letter is a number and goes through `num`.
    pub fn label(&mut self, tag: &str, class: &str, l: &Label) -> String {
        if !l.src.starts_with(LABEL_SRC) {
            self.errors.push(format!(
                "{}: a label is read from a name row ({LABEL_SRC}...)",
                l.src
            ));
        }
        if !l.text.chars().any(char::is_alphabetic) {
            self.errors.push(format!(
                "{}: {:?} holds no letter, so it is a number, not a name",
                l.src, l.text
            ));
        }
        self.enter(tag, class, &l.src, &l.text)
    }

    fn enter(&mut self, tag: &str, class: &str, src: &str, text: &str) -> String {
        match self.entries.get(src) {
            Some(printed) if printed != text => self
                .errors
                .push(format!("{src}: printed as both {printed:?} and {text:?}")),
            _ => {
                self.entries.insert(src.to_string(), text.to_string());
            }
        }
        format!(
            "<{tag} class=\"{class}\" data-src=\"{}\">{}</{tag}>",
            esc(src),
            esc(text)
        )
    }

    /// A piece of prose in elements `tag`: words escaped, numbers through `num`, names through `label`, table ids marked
    /// `data-ref`.
    pub fn segs(&mut self, tag: &str, segs: &[Seg]) -> String {
        segs.iter()
            .map(|seg| match seg {
                Seg::Text(text) => esc(text),
                Seg::Num(n) => self.num(tag, "n", n),
                Seg::Label(l) => self.label(tag, "nm", l),
                Seg::Ref(id) => format!("<{tag} data-ref=\"\">{}</{tag}>", esc(id)),
            })
            .collect()
    }

    /// The ledger the page comes back with, or every number it could not print, one per line.
    pub fn finish(self) -> Result<BTreeMap<String, String>, String> {
        if self.errors.is_empty() {
            Ok(self.entries)
        } else {
            Err(self.errors.join("\n"))
        }
    }
}

pub(crate) const VOID: [&str; 6] = ["meta", "link", "br", "img", "input", "hr"];
/// Attributes a reader is given as text (a screen reader reads them), checked as text.
pub(crate) const READ_ATTRS: [&str; 3] = ["aria-label", "alt", "title"];

/// The text with its character references read (so a digit cannot hide in one).
pub(crate) fn unescape(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|e| *e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
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

/// The digit runs of a text, full-width digits read as ASCII, a point or comma kept between two digits.
fn digit_runs(text: &str) -> Vec<String> {
    let chars: Vec<char> = text
        .chars()
        .map(|c| {
            if ('０'..='９').contains(&c) {
                char::from_u32(c as u32 - '０' as u32 + '0' as u32).unwrap_or(c)
            } else {
                c
            }
        })
        .collect();
    let mut runs = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && (chars[i].is_ascii_digit()
                || (matches!(chars[i], '.' | ',')
                    && chars.get(i + 1).is_some_and(char::is_ascii_digit)))
        {
            i += 1;
        }
        runs.push(chars[start..i].iter().collect());
    }
    runs
}

/// A tag's name and attributes (values unescaped); quotes may hold '>'.
pub(crate) fn tag_parts(tag: &str) -> (String, Vec<(String, String)>) {
    let tag = tag.trim_end_matches('/');
    let name_end = tag.find(|c: char| c.is_whitespace()).unwrap_or(tag.len());
    let name = tag[..name_end].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let chars: Vec<char> = tag[name_end..].chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' {
            i += 1;
        }
        let key = chars[start..i]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        let mut value = String::new();
        if i < chars.len() && chars[i] == '=' {
            i += 1;
            let quote = chars.get(i).copied().filter(|q| matches!(q, '"' | '\''));
            if quote.is_some() {
                i += 1;
            }
            let from = i;
            while i < chars.len()
                && match quote {
                    Some(q) => chars[i] != q,
                    None => !chars[i].is_whitespace(),
                }
            {
                i += 1;
            }
            value = chars[from..i].iter().collect();
            if quote.is_some() {
                i += 1;
            }
        }
        if !key.is_empty() {
            attrs.push((key, unescape(&value)));
        }
    }
    (name, attrs)
}

/// How many bytes a comment's body (what follows `<!--`) spans, its `-->` included; all of it when unclosed, as the
/// browser hides the rest. A comment the browser ends elsewhere (`<!-->`, `<!--->`, a `--!>` inside) is refused, not
/// followed: what comes after its early end would be drawn and read by nobody here.
pub(crate) fn comment_len(body: &str) -> Result<usize, String> {
    let end = body.find("-->");
    if body.starts_with('>') || body.starts_with("->") || body[..end.unwrap_or(body.len())].contains("--!>") {
        let head: String = body.chars().take(30).collect();
        return Err(format!("a comment the browser ends early: <!--{head:?}; only <!-- ... --> is read"));
    }
    Ok(end.map_or(body.len(), |e| e + 3))
}

/// Where the tag starting at `<` ends (its `>`), quotes skipped.
pub(crate) fn tag_end(html: &str) -> Option<usize> {
    let mut quote = None;
    for (i, c) in html.char_indices().skip(1) {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return Some(i),
            _ => {}
        }
    }
    None
}

enum Mark {
    Src(String),
    Ref,
}

struct Open {
    name: String,
    mark: Option<Mark>,
    text: String,
}

/// The page check: every text of the page (and every attribute a reader is read), with its character references read, holds
/// digits only inside an element marked `data-src` that prints its ledger entry (a number or a label) as entered, or inside an element marked
/// `data-ref` that names one of `refs`. No digit is exempt: a year or a date is a ledger entry like any number. The page's
/// one script must be READY_JS. Each finding is one line.
pub fn check_numbers(
    html: &str,
    ledger: &BTreeMap<String, String>,
    refs: &[String],
) -> Vec<String> {
    let mut off = Vec::new();
    let mut open: Vec<Open> = Vec::new();
    let plain = |text: &str, off: &mut Vec<String>| {
        for run in digit_runs(text) {
            off.push(format!(
                "the digits {run} in {:?} come from no ledger entry",
                text.trim()
            ));
        }
    };
    let close = |shut: Open, off: &mut Vec<String>| match shut.mark {
        Some(Mark::Src(src)) => match ledger.get(&src) {
            Some(printed) if printed == shut.text.trim() => {}
            Some(printed) => off.push(format!(
                "{src} prints {:?}, its ledger entry is {printed:?}",
                shut.text.trim()
            )),
            None => off.push(format!(
                "{src} is not in the ledger (it prints {:?})",
                shut.text.trim()
            )),
        },
        Some(Mark::Ref) if !refs.iter().any(|r| r == shut.text.trim()) => off.push(format!(
            "{:?} is not a table the page names",
            shut.text.trim()
        )),
        _ => {}
    };
    let mut rest = html;
    while !rest.is_empty() {
        if let Some(comment) = rest.strip_prefix("<!--") {
            match comment_len(comment) {
                Ok(n) => rest = &comment[n..],
                Err(e) => {
                    off.push(e);
                    break;
                }
            }
            continue;
        }
        if let Some(section) = rest.strip_prefix("<![CDATA[") {
            // In svg the browser shows it as text, which no reader here would see: refused, never skipped.
            off.push(format!("a CDATA section is not read: {:?}", section.split("]]>").next().unwrap_or("")));
            rest = section.find("]]>").map_or("", |e| &section[e + 3..]);
            continue;
        }
        if rest.starts_with('<') {
            let Some(end) = tag_end(rest) else {
                off.push("a tag is not closed".into());
                break;
            };
            let tag = &rest[1..end];
            rest = &rest[end + 1..];
            if tag.starts_with('!') {
                // only comments (above) and the doctype are skipped
                if !tag[1..].to_ascii_lowercase().starts_with("doctype") {
                    off.push(format!("<{tag}> is neither a comment nor the doctype"));
                }
                continue;
            }
            if let Some(name) = tag.strip_prefix('/') {
                let name = name.trim().to_ascii_lowercase();
                if open.iter().any(|o| o.name == name) {
                    while let Some(shut) = open.pop() {
                        let done = shut.name == name;
                        close(shut, &mut off);
                        if done {
                            break;
                        }
                    }
                }
                continue;
            }
            let (name, attrs) = tag_parts(tag);
            for (key, value) in &attrs {
                if READ_ATTRS.contains(&key.as_str()) {
                    plain(value, &mut off);
                }
            }
            if name == "style" || name == "script" {
                let shut = format!("</{name}");
                let Some(at) = rest.to_ascii_lowercase().find(&shut) else {
                    off.push(format!("a {name} is not closed"));
                    break;
                };
                if name == "script" && &rest[..at] != READY_JS {
                    off.push("the page holds a script that is not the renderer's".into());
                }
                rest = &rest[at..];
                rest = tag_end(rest).map_or("", |e| &rest[e + 1..]);
                continue;
            }
            if tag.trim_end().ends_with('/') || VOID.contains(&name.as_str()) {
                continue;
            }
            let attr = |k: &str| {
                attrs
                    .iter()
                    .find(|(key, _)| key == k)
                    .map(|(_, v)| v.clone())
            };
            let mark = attr("data-src")
                .map(Mark::Src)
                .or_else(|| attr("data-ref").map(|_| Mark::Ref));
            open.push(Open {
                name,
                mark,
                text: String::new(),
            });
            continue;
        }
        let next = rest.find('<').unwrap_or(rest.len());
        let text = unescape(&rest[..next]);
        rest = &rest[next..];
        match open.iter_mut().rev().find(|o| o.mark.is_some()) {
            Some(marked) => marked.text.push_str(&text),
            None => plain(&text, &mut off),
        }
    }
    while let Some(shut) = open.pop() {
        close(shut, &mut off);
    }
    off
}

/// The distinct saturated colours (#rrggbb, HSL saturation above 0.25 and lightness inside 0.1..0.9) the page names.
pub fn saturated_colours(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (at, _) in html.match_indices('#') {
        let Some(hex) = html
            .get(at + 1..at + 7)
            .filter(|h| h.chars().all(|c| c.is_ascii_hexdigit()))
        else {
            continue;
        };
        if html[at + 7..].starts_with(|c: char| c.is_ascii_alphanumeric()) {
            continue;
        }
        let channel =
            |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map_or(0.0, |v| v as f64 / 255.0);
        let (r, g, b) = (channel(0), channel(2), channel(4));
        let (hi, lo) = (r.max(g).max(b), r.min(g).min(b));
        let light = (hi + lo) / 2.0;
        let saturation = if hi == lo {
            0.0
        } else {
            (hi - lo) / (1.0 - (2.0 * light - 1.0).abs())
        };
        let colour = format!("#{}", hex.to_ascii_lowercase());
        if saturation > 0.25 && light > 0.1 && light < 0.9 && !out.contains(&colour) {
            out.push(colour);
        }
    }
    out
}

/// The relations a page may state over value facts (data-cmp) and the word-table keys whose words state each: a headline or
/// note marked with one must print one of them. The words are the leaf's table, read here as data (include_str), so the
/// check and the leaf hold the same few words.
const RELATIONS: [(&str, &[&str]); 3] = [("max", &["column.note.vs_next"]), ("next", &["column.note.vs_next"]), ("gt", &["column.note.vs_next"])];

/// The leaf's word table, read here as data (include_str), so the check and the leaf hold the same words.
fn word_table() -> &'static Value {
    static WORDS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| serde_json::from_str(include_str!("../runtime/leaves_py/words.zh.json")).unwrap_or_default())
}

/// The word-table key of the scope phrase a comparison over a set narrower than the full set says (scope_said); the leaf
/// reads the same key (wbkit.FINDING_WORDS["scope"]).
const SCOPE_WORD: &str = "scope.within";

/// The words of a relation, as the word table gives them, their leading and trailing punctuation trimmed.
fn relation_words(rel: &str) -> Vec<String> {
    let table = word_table();
    let keys = RELATIONS.iter().find(|(r, _)| *r == rel).map_or(&[][..], |(_, k)| *k);
    keys.iter().filter_map(|k| table[*k].as_str()).map(|w| w.trim_matches(['\u{ff0c}', '\u{3001}', '\u{ff1b}']).to_string()).filter(|w| !w.is_empty()).collect()
}

/// An element of a page: its name, its attributes and the byte range of its inner html (empty for a void or self-closed one).
struct El {
    name: String,
    attrs: Vec<(String, String)>,
    inner: std::ops::Range<usize>,
}

impl El {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// Every element of the html in page order, nesting followed by name; comments, the doctype and the bodies of style and
/// script skipped.
fn elements(html: &str) -> Vec<El> {
    let (mut out, mut open): (Vec<El>, Vec<usize>) = (Vec::new(), Vec::new());
    let mut at = 0;
    while let Some(lt) = html[at..].find('<').map(|i| at + i) {
        if let Some(body) = html[lt..].strip_prefix("<!--") {
            at = lt + 4 + comment_len(body).unwrap_or(body.len());
            continue;
        }
        let Some(end) = tag_end(&html[lt..]) else { break };
        let tag = &html[lt + 1..lt + end];
        at = lt + end + 1;
        if tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let name = name.trim().to_ascii_lowercase();
            if let Some(i) = open.iter().rposition(|&o| out[o].name == name) {
                open.drain(i..).for_each(|o| out[o].inner.end = lt);
            }
            continue;
        }
        let (name, attrs) = tag_parts(tag);
        let shut = tag.trim_end().ends_with('/') || VOID.contains(&name.as_str());
        out.push(El { name: name.clone(), attrs, inner: at..at });
        if name == "style" || name == "script" {
            let close = html[at..].to_ascii_lowercase().find(&format!("</{name}")).map_or(html.len(), |i| at + i);
            if let Some(e) = out.last_mut() {
                e.inner.end = close;
            }
            at = close;
        } else if !shut {
            open.push(out.len() - 1);
        }
    }
    open.into_iter().for_each(|o| out[o].inner.end = html.len());
    out
}

/// The text of an html fragment, character references read, leaving out what lies inside any element carrying `skip`.
fn text_outside(frag: &str, skip: &str) -> String {
    let inside: Vec<_> = elements(frag).into_iter().filter(|e| e.attr(skip).is_some()).map(|e| e.inner).collect();
    let (mut out, mut at) = (String::new(), 0);
    while at < frag.len() {
        if frag[at..].starts_with('<') {
            at += tag_end(&frag[at..]).map_or(frag.len() - at, |e| e + 1);
            continue;
        }
        let next = frag[at..].find('<').map_or(frag.len(), |i| at + i);
        if !inside.iter().any(|r| r.contains(&at)) {
            out.push_str(&unescape(&frag[at..next]));
        }
        at = next;
    }
    out
}

/// The data-src values printed in an html fragment.
fn printed(frag: &str) -> Vec<String> {
    elements(frag).into_iter().filter_map(|e| e.attr("data-src").map(str::to_string)).collect()
}

/// The comparison set of a value fact, derived from the request's fact definitions alone (never from the page): every fact
/// whose definition has op value and the same table, time and format, and a filter over the same one dimension (its value
/// one code, or a list for a merged node). Empty when `key` is no such fact.
fn family<'a>(key: &str, spec: &'a Spec) -> Vec<&'a str> {
    let shape = |q: &Value| {
        let filter = q.get("filter")?.as_object().filter(|f| f.len() == 1)?;
        let dim = filter.keys().next()?.clone();
        (q["op"] == "value").then(|| (q["table"].clone(), q["time"].clone(), q["fmt"].clone(), dim))
    };
    let Some(want) = spec.facts.iter().find(|(k, _)| k == key).and_then(|(_, q)| shape(q)) else {
        return Vec::new();
    };
    let mut set: Vec<&str> = spec.facts.iter().filter(|(_, q)| shape(q).as_ref() == Some(&want)).map(|(k, _)| k.as_str()).collect();
    set.sort_unstable();
    set.dedup();
    set
}

/// The comparison set of a share fact, from the request's fact definitions alone (never from the page), each member with its
/// code: `d` the one dimension on which its numerator and denominator (value facts the request defines) hold the same single
/// code, every share fact of the same format whose numerator and denominator hold one code on `d` alike and, `d` left out,
/// the same filter, table, time and format as its own (a list compared as written). Empty when `key` is no such fact, when
/// its numerator and denominator are one (a share of 1), when two dimensions each give two codes or more, when a share fact
/// over the same denominator stands at a code outside the set, or when the set holds fewer than two codes.
fn share_family<'a>(key: &str, spec: &'a Spec) -> Vec<(&'a str, String)> {
    share_split(key, spec).map_or_else(Vec::new, |(_, set)| set)
}

/// share_family with the dimension its codes stand on.
fn share_split<'a>(key: &str, spec: &'a Spec) -> Option<(String, Vec<(&'a str, String)>)> {
    let def = move |k: &Value| k.as_str().and_then(|k| spec.facts.iter().find(|(key, _)| key == k)).map(|(_, q)| q);
    let side = |k: &Value, d: &str| {
        let q = def(k).filter(|q| q["op"] == "value")?;
        let mut filter = q.get("filter")?.as_object()?.clone();
        let code = filter.remove(d)?.as_str()?.to_string();
        Some((code, Value::Array(vec![Value::Object(filter), q["table"].clone(), q["time"].clone(), q["fmt"].clone()])))
    };
    let split = |q: &Value, d: &str| {
        let ((ca, num), (cb, den)) = (side(&q["a"], d)?, side(&q["b"], d)?);
        (q["op"] == "share" && ca == cb).then_some((ca, num, den))
    };
    let own = def(&Value::from(key)).filter(|q| q["op"] == "share")?;
    let dims: Vec<String> = def(&own["a"]).and_then(|q| q["filter"].as_object()).map(|f| f.keys().cloned().collect()).unwrap_or_default();
    let mut found = Vec::new();
    for d in &dims {
        let Some((_, num, den)) = split(own, d) else { continue };
        if num == den {
            return None;
        }
        let at = |want: &Value| -> Vec<(&'a str, String, bool)> {
            let held = spec.facts.iter().filter_map(|(k, q)| split(q, d).map(|(c, n, b)| (k.as_str(), c, n, b, q.get("fmt") == own.get("fmt"))));
            held.filter(|(_, _, _, b, _)| b == want).map(|(k, c, n, _, fmt)| (k, c, fmt && n == num)).collect()
        };
        let mut set: Vec<(&str, String)> = at(&den).into_iter().filter(|m| m.2).map(|(k, c, _)| (k, c)).collect();
        let codes: std::collections::BTreeSet<&String> = set.iter().map(|(_, c)| c).collect();
        if codes.len() >= 2 {
            let covered = at(&den).iter().all(|(_, c, _)| codes.contains(c));
            set.sort_unstable();
            set.dedup();
            found.push((d.clone(), if covered { set } else { Vec::new() }));
        }
    }
    (found.len() == 1 && !found[0].1.is_empty()).then(|| found.remove(0))
}

/// A member of a comparison set: the fact that holds it (none for a code the check computed itself), the code it stands
/// for where it is compared by code (a share's, or a computed code's; a value family's members by key), and its value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Member<'a> {
    pub key: Option<&'a str>,
    pub code: Option<String>,
    pub v: f64,
}

impl Member<'_> {
    /// One member twice: the same fact, or the same code (a copy of a share under another key).
    fn same(&self, o: &Member) -> bool {
        (self.key.is_some() && self.key == o.key) || (self.code.is_some() && self.code == o.code)
    }

    fn label(&self) -> String {
        self.key.map_or_else(|| format!("code:{}", self.code.as_deref().unwrap_or_default()), str::to_string)
    }
}

/// The comparison of a fact (design-scope v2), from the request alone: its set (family, or share_family where no value
/// family holds it) with each member's computed value, then every other code of the full set (the codes its dimension
/// takes in the request rows of the set's tables and time) whose value the set's own definition computes from those rows
/// (computed_at), and whether the full set holds a code it could not compute (scoped: a comparison stated over it must say
/// its scope). None when the fact has no set of two codes or more, a member has no computed value, or a code of the full
/// set holds rows the set's definition cannot read alike (computed_at Unsupported): no comparison is judged then.
pub(crate) fn comparison<'a>(key: &str, spec: &'a Spec, rows: &[Row], facts: &[Fact]) -> Option<(Vec<Member<'a>>, bool)> {
    let def = move |k: &str| spec.facts.iter().find(|(key, _)| key == k).map(|(_, q)| q);
    let value = move |k: &str| facts.iter().find(|f| f.key == k).map(|f| f.v);
    let fam = family(key, spec);
    let (dim, mut members, template): (String, Vec<Member<'a>>, Vec<&'a Value>) = if !fam.is_empty() {
        let q = def(key)?;
        let dim = q["filter"].as_object()?.keys().next()?.clone();
        let members = fam.iter().map(|k| Some(Member { key: Some(*k), code: None, v: value(*k)? })).collect::<Option<Vec<_>>>()?;
        let template = fam.iter().filter_map(|k| def(*k)).find(|q| q["filter"][&dim].is_string()).into_iter().collect();
        (dim, members, template)
    } else {
        let (dim, set) = share_split(key, spec)?;
        let members = set.iter().map(|(k, c)| Some(Member { key: Some(*k), code: Some(c.clone()), v: value(*k)? })).collect::<Option<Vec<_>>>()?;
        let first = def(set[0].0)?;
        (dim, members, vec![def(first["a"].as_str()?)?, def(first["b"].as_str()?)?])
    };
    // the codes the set holds: each member's code on its dimension, a merged node's list whole
    let mut held: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for m in &members {
        match m.key.and_then(def).and_then(|q| if fam.is_empty() { def(q["a"].as_str()?) } else { Some(q) }).map(|q| &q["filter"][&dim]) {
            Some(Value::String(c)) => {
                held.insert(c.clone());
            }
            Some(Value::Array(cs)) => held.extend(cs.iter().filter_map(Value::as_str).map(str::to_string)),
            _ => {}
        }
    }
    let at: Vec<(&Value, &Value)> = template.iter().map(|q| (&q["table"], &q["time"])).collect();
    let full: std::collections::BTreeSet<&String> = rows
        .iter()
        .filter(|r| at.iter().any(|(t, y)| t.as_str() == Some(r.table.as_str()) && y.as_str() == Some(r.time.as_str())))
        .filter_map(|r| r.dims.get(&dim))
        .collect();
    let mut scoped = false;
    for c in full.into_iter().filter(|c| !held.contains(*c)) {
        let got: Vec<At> = template.iter().map(|q| computed_at(q, &dim, c, rows)).collect();
        match got[..] {
            // a definition the check cannot apply to the code's rows alike: no comparison it could stand behind
            _ if got.is_empty() || got.contains(&At::Unsupported) => return None,
            [At::Value(v)] => members.push(Member { key: None, code: Some(c.clone()), v }),
            [At::Value(a), At::Value(b)] if b != 0.0 => members.push(Member { key: None, code: Some(c.clone()), v: a / b }),
            _ => scoped = true,
        }
    }
    Some((members, scoped))
}

/// What computed_at finds for a code: its value; no rows of the template's kind (a numerator or denominator row missing,
/// a code of the filter with none, a 0 denominator: the set is scoped); or rows it cannot read alike (a definition with a
/// key it does not apply, or rows that do not match the template member's exactly: the comparison refuses).
#[derive(Clone, Copy, Debug, PartialEq)]
enum At {
    Value(f64),
    Missing,
    Unsupported,
}

/// The value a value fact's definition `q` (a template member of the set) takes with its code on `dim` replaced by `code`,
/// summed from the request rows as next_facts sums a value. The rows must match the template member's own exactly: on
/// every other dimension the same codes, and as many rows for each code of the filter; a row of another code there
/// (a second unit) is Unsupported, never summed, and no row of the template's codes at all is Missing, as is a code of the
/// filter with no row. A definition with keys beyond op, table, time, fmt and filter is Unsupported.
fn computed_at(q: &Value, dim: &str, code: &str, rows: &[Row]) -> At {
    use std::collections::{BTreeMap as Map, BTreeSet as Set};
    let plain = q.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "op" | "table" | "time" | "fmt" | "filter")));
    let Some(filter) = q["filter"].as_object().filter(|_| plain && q["op"] == "value") else { return At::Unsupported };
    let codes = |v: &Value| match v {
        Value::String(c) => Some(vec![c.clone()]),
        Value::Array(cs) => cs.iter().map(|c| c.as_str().map(str::to_string)).collect(),
        _ => None,
    };
    let want = |swap: bool| -> Option<Vec<(&String, Vec<String>)>> {
        filter.iter().map(|(d, v)| Some((d, if swap && d == dim { vec![code.to_string()] } else { codes(v)? }))).collect()
    };
    let (Some(mine_want), Some(there_want)) = (want(false), want(true)) else { return At::Unsupported };
    let pick = |want: &[(&String, Vec<String>)]| -> Vec<&Row> {
        let at = rows.iter().filter(|r| Some(r.table.as_str()) == q["table"].as_str() && Some(r.time.as_str()) == q["time"].as_str());
        at.filter(|r| want.iter().all(|(d, cs)| r.dims.get(*d).is_some_and(|c| cs.contains(c)))).collect()
    };
    let (mine, there) = (pick(&mine_want), pick(&there_want));
    // the template's other dimensions and their codes, and its rows per combination of filter codes (dim left out)
    let others = |rs: &[&Row]| -> Map<String, Set<String>> {
        let mut out: Map<String, Set<String>> = Map::new();
        for r in rs {
            for (d, c) in r.dims.iter().filter(|(d, _)| !filter.contains_key(*d)) {
                out.entry(d.clone()).or_default().insert(c.clone());
            }
        }
        out
    };
    let per = |rs: &[&Row]| -> Set<usize> {
        let mut n: Map<Vec<Option<&String>>, usize> = Map::new();
        for r in rs {
            *n.entry(filter.keys().filter(|d| *d != dim).map(|d| r.dims.get(d)).collect()).or_default() += 1;
        }
        n.into_values().collect()
    };
    let profile = others(&mine[..]);
    let one = per(&mine[..]);
    if mine.is_empty() || one.len() != 1 {
        return At::Unsupported;
    }
    let inside: Vec<&Row> = there.iter().copied().filter(|r| profile.iter().all(|(d, cs)| r.dims.get(d).is_some_and(|c| cs.contains(c)))).collect();
    if inside.is_empty() {
        return At::Missing;
    }
    if inside.len() != there.len() {
        return At::Unsupported;
    }
    if !there_want.iter().all(|(d, cs)| cs.iter().all(|c| inside.iter().any(|r| r.dims.get(*d) == Some(c)))) {
        return At::Missing;
    }
    if others(&inside[..]) != profile || per(&inside[..]) != one {
        return At::Unsupported;
    }
    let v: f64 = inside.iter().map(|r| r.value).sum();
    if v.is_finite() { At::Value(v) } else { At::Unsupported }
}

/// For the leaf: each fact of a comparison set, the codes the check finds first and second over it and whether a
/// comparison stated over it must say its scope ({key: {"first", "second", "scoped"}}); a member with no code by its
/// member_code is named by its key.
pub fn comparisons(spec: &Spec, rows: &[Row], facts: &[Fact]) -> Value {
    let mut out = serde_json::Map::new();
    for (key, _) in &spec.facts {
        if out.contains_key(key) {
            continue;
        }
        let Some((mut members, scoped)) = comparison(key, spec, rows, facts) else { continue };
        members.sort_by(|a, b| b.v.total_cmp(&a.v));
        let name = |m: &Member| m.code.clone().or_else(|| m.key.and_then(|k| member_code(k, spec))).unwrap_or_else(|| m.label());
        let first = &members[0];
        let Some(second) = members.iter().find(|m| !m.same(first)) else { continue };
        let one = serde_json::json!({"first": name(first), "second": name(second), "scoped": scoped});
        for k in members.iter().filter_map(|m| m.key) {
            out.insert(k.to_string(), one.clone());
        }
    }
    Value::Object(out)
}

/// The code a compared fact stands for, which its name row ends in: a share fact's code in its set (share_family), else the
/// first code of its filter (a merged node's list none).
fn member_code(key: &str, spec: &Spec) -> Option<String> {
    if let Some((_, code)) = share_family(key, spec).into_iter().find(|(k, _)| *k == key) {
        return Some(code);
    }
    let def = spec.facts.iter().find(|(k, _)| k == key).map(|(_, q)| q);
    def.and_then(|q| q["filter"].as_object()).and_then(|f| f.values().next()).and_then(Value::as_str).map(str::to_string)
}

/// The fact key a ledger src prints (`fact:<k>.n`, `fact:<k>.r` its display part, or `fact:<k>`), when `k` is a fact the
/// request defines.
fn fact_key<'a>(src: &str, spec: &'a Spec) -> Option<&'a str> {
    let k = src.strip_prefix("fact:")?;
    let known = |k: &str| spec.facts.iter().find(|(key, _)| key == k).map(|(key, _)| key.as_str());
    known(k).or_else(|| k.strip_suffix(".n").or_else(|| k.strip_suffix(".r")).and_then(known))
}

/// The part of a fact a compared src prints: `.r` (display) or `.n` (bare; its text too, as the comparison has always read).
fn part_of(src: &str) -> &'static str {
    if src.ends_with(".r") {
        ".r"
    } else {
        ".n"
    }
}

/// relation_holds: every element with data-cmp states one relation of value facts over a set this check derives from the
/// request's fact definitions (spec.facts, family), never from the page:
///   max   data-a is above every other fact of its set, printing differently from each;
///   next  data-a is the max as above, and data-b the max of the rest of the set;
///   gt    data-b is in data-a's set, data-a above it, printing differently.
/// A share fact with no such set takes its share set (share_family): a member's copies under other keys (one code, one
/// value, else refused) are no other member of it. The set compared over is comparison's: the set and every other code of
/// the request rows its definition computes; where the rows hold a code it cannot compute, the words say the scope
/// (scope_said), and where they hold none they do not.
/// The element prints data-a (and data-b) as data-src and the name row of each one's own code (member_code: the code its
/// filter holds or a share's code in its set; a merged node's list is exempt), so a number cannot stand under another node's name; its words (outside data-src) hold
/// the relation's words. A set of fewer than two facts, or a fact of it with no computed value, refuses. A relation word in
/// an h1 outside a data-cmp element refuses, and every text of a g[data-notes] group must carry data-cmp. One line per finding.
pub fn check_relations(html: &str, ledger: &BTreeMap<String, String>, spec: &Spec, facts: &[Fact], rows: &[Row]) -> Vec<String> {
    let mut off = Vec::new();
    let els = elements(html);
    let value = |k: &str| facts.iter().find(|f| f.key == k).map(|f| f.v);
    // "prints differently" compares the part data-a prints (`.r` or `.n`), each member read at that part (one with no such
    // entry at `.n`, then its text)
    let text = |k: &str, part: &str| {
        ledger.get(&format!("fact:{k}{part}")).or_else(|| ledger.get(&format!("fact:{k}.n"))).or_else(|| ledger.get(&format!("fact:{k}")))
    };
    for g in els.iter().filter(|e| e.name == "g" && e.attr("data-notes").is_some()) {
        for t in els.iter().filter(|t| t.name == "text" && g.inner.contains(&t.inner.start) && t.attr("data-cmp").is_none()) {
            off.push(format!("note {:?}: no comparison marked (data-cmp)", text_outside(&html[t.inner.clone()], "\0")));
        }
    }
    let words: Vec<String> = RELATIONS.iter().flat_map(|(r, _)| relation_words(r)).collect();
    for h in els.iter().filter(|e| e.name == "h1") {
        let bare = text_outside(&html[h.inner.clone()], "data-cmp");
        off.extend(words.iter().filter(|w| bare.contains(w.as_str())).map(|w| format!("h1: the relation word {w:?} with no data-cmp")));
    }
    for e in els.iter().filter(|e| e.attr("data-cmp").is_some()) {
        let body = &html[e.inner.clone()];
        let shown = text_outside(body, "\0");
        let rel = e.attr("data-cmp").unwrap_or_default();
        let srcs: Vec<&str> = std::iter::once(e.attr("data-a")).chain((rel != "max").then(|| e.attr("data-b"))).flatten().collect();
        if !RELATIONS.iter().any(|(r, _)| *r == rel) || srcs.len() != if rel == "max" { 1 } else { 2 } {
            off.push(format!("{shown:?}: data-cmp {rel:?} is not max, next or gt with its entries"));
            continue;
        }
        let seen = printed(body);
        if srcs.iter().any(|s| !seen.iter().any(|p| p == s)) {
            off.push(format!("{shown:?}: its compared entries {srcs:?} are not all printed in it"));
            continue;
        }
        let Some(keys) = srcs.iter().map(|s| fact_key(s, spec)).collect::<Option<Vec<&str>>>() else {
            off.push(format!("{shown:?}: {srcs:?} are not all defined facts"));
            continue;
        };
        // a share fact's set where no value set holds it (share_family), its members compared once per code: a copy of a
        // member under another key (as comp_top is of share.fossil.PL) is no other member, and must hold the same value
        let mut set = family(keys[0], spec);
        let shares = if set.is_empty() { share_family(keys[0], spec) } else { Vec::new() };
        if !shares.is_empty() {
            set = shares.iter().map(|(k, _)| *k).collect();
        }
        if set.len() < 2 {
            off.push(format!("{shown:?}: {} has no comparison set", keys[0]));
            continue;
        }
        if set.iter().any(|k| value(k).is_none()) {
            off.push(format!("{shown:?}: a fact of {set:?} has no computed value"));
            continue;
        }
        // the set compared over: its members, and every code the request rows let the check compute alike (comparison)
        let Some((members, scoped)) = comparison(keys[0], spec, rows, facts) else {
            off.push(format!("{shown:?}: {} has no comparison set its rows compute alike (a code of the rows it cannot read alike)", keys[0]));
            continue;
        };
        if let Some((a, b)) = members.iter().flat_map(|a| members.iter().map(move |b| (a, b))).find(|(a, b)| a.code.is_some() && a.code == b.code && a.v != b.v) {
            off.push(format!("{shown:?}: {} and {} stand for {} with different values", a.label(), b.label(), a.code.as_deref().unwrap_or_default()));
            continue;
        }
        for k in &keys {
            if let Some(code) = member_code(k, spec).filter(|c| !seen.iter().any(|p| p.starts_with(LABEL_SRC) && p.ends_with(&format!(":{c}")))) {
                off.push(format!("{shown:?}: {k} is printed without the name of its code {code}"));
            }
        }
        let part = part_of(srcs[0]);
        // above: strictly, and printing differently from each member the page could print (a computed code prints nothing)
        let above = |a: &Member, others: &[&Member]| {
            others.iter().all(|o| a.v > o.v && o.key.is_none_or(|k| text(a.key.unwrap_or_default(), part) != text(k, part)))
        };
        let find = |k: &str| members.iter().find(|m| m.key == Some(k));
        let me = find(keys[0]);
        let other = keys.get(1).and_then(|k| find(*k)).filter(|b| me.is_some_and(|a| !b.same(a)));
        let rest: Vec<&Member> = members.iter().filter(|m| me.is_some_and(|a| !m.same(a))).collect();
        let holds = match (rel, me, other) {
            ("max", Some(a), _) => above(a, &rest[..]),
            ("next", Some(a), Some(b)) => {
                let after: Vec<&Member> = rest.iter().copied().filter(|m| !m.same(b)).collect();
                above(a, &rest[..]) && above(b, &after[..])
            }
            ("gt", Some(a), Some(b)) => above(a, &[b][..]),
            _ => false,
        };
        if !holds {
            let set: Vec<(String, f64)> = members.iter().map(|m| (m.label(), m.v)).collect();
            off.push(format!("{shown:?}: {rel} does not hold over {keys:?} and its derived set {set:?}"));
        }
        let said = text_outside(body, "data-src");
        if !relation_words(rel).iter().any(|w| said.contains(w.as_str())) {
            off.push(format!("{shown:?}: its words state no {rel} comparison"));
        }
        off.extend(scope_said(&shown, body, scoped));
    }
    off
}

/// The scope rule (design-scope v2), shared by every comparison: over a set narrower than the full set (`scoped`) the
/// element's own words (outside data-src, in its markup as written, in one piece) hold the scope phrase; over the full set
/// they do not. With no phrase in the word table a scoped comparison refuses.
fn scope_said(shown: &str, body: &str, scoped: bool) -> Option<String> {
    let phrase = word_table()[SCOPE_WORD].as_str();
    match phrase {
        Some(p) if scoped && body.contains(p) && text_outside(body, "data-src").contains(p) => None,
        _ if scoped => Some(format!("{shown:?}: its set is narrower than the codes the request holds, and its words do not say {phrase:?}")),
        Some(p) if shown.contains(p) => Some(format!("{shown:?}: its set holds every code the request holds, and its words say {p:?}")),
        _ => None,
    }
}

/// accent_named, on a page whose h1 states a relation (an element with data-cmp or data-claim in it: a headline a leaf
/// made from a finding, or a title whose claim it read from the data): every mark (rect, path, polygon, circle) filled with the accent that names its entity (data-code) is named in
/// the h1 or the dek (p.dek) by that code's name row. A page whose h1 states none is out of its scope (unscoped, the accent
/// circles of the published column pages would refuse: their h1 names no code by its row).
pub fn check_accent_named(html: &str) -> Vec<String> {
    let els = elements(html);
    let heads: Vec<&El> = els.iter().filter(|e| e.name == "h1").collect();
    if !heads.iter().any(|h| els.iter().any(|e| (e.attr("data-cmp").is_some() || e.attr("data-claim").is_some()) && h.inner.contains(&e.inner.start))) {
        return Vec::new();
    }
    let dek = |e: &El| e.name == "p" && e.attr("class").is_some_and(|c| c.split_whitespace().any(|w| w == "dek"));
    let named: Vec<String> =
        els.iter().filter(|e| e.name == "h1" || dek(e)).flat_map(|e| printed(&html[e.inner.clone()])).collect();
    let mut codes: Vec<&str> = els
        .iter()
        .filter(|e| matches!(e.name.as_str(), "rect" | "path" | "polygon" | "circle") && e.attr("fill") == Some("var(--accent)"))
        .filter_map(|e| e.attr("data-code"))
        .collect();
    codes.sort_unstable();
    codes.dedup();
    codes
        .into_iter()
        .filter(|c| !named.iter().any(|p| p.starts_with(LABEL_SRC) && p.ends_with(&format!(":{c}"))))
        .map(|c| format!("the accent marks {c}, which the h1 and the dek do not name"))
        .collect()
}

/// The words a title's claim is read by (check_claims): a check vocabulary, never printed by the core. The leaf gets the
/// same lists on its page line (claim_words), so it keeps the finding's headline before this check could refuse.
///   max   a claim's words hold one of these;
///   off   and none of these: another relation, a rank below first, a negation, a trend, a multiple or share, a hedge;
///   verb  the leaf's alone (it keeps a title only when it also reads as a conclusion); the check never reads it.
pub const CLAIM_WORDS: [(&str, &[&str]); 3] = [
    ("max", &["最大", "最多", "最高", "最粗", "最宽", "最主要", "居首", "首位", "第一大", "领先", "领跑"]),
    (
        "off",
        &[
            "最小", "最少", "最低", "最细", "最窄", "最弱", "垫底", "末位", "第二", "次之", "其次", "仅次", "不", "非", "没", "未", "无",
            "比", "倍", "半", "少于", "低于", "多于", "高于", "超过", "不及", "落后", "减", "增", "降", "升", "曾", "将", "约", "近", "逾",
            "左右", "？", "?",
        ],
    ),
    ("verb", &["居首", "集中", "占", "达", "成为", "领先", "是", "领跑"]),
];

/// One list of CLAIM_WORDS.
fn claim_list(kind: &str) -> &'static [&'static str] {
    CLAIM_WORDS.iter().find(|(k, _)| *k == kind).map_or(&[][..], |(_, w)| *w)
}

/// CLAIM_WORDS as the page line gives them to the leaf: {"max": [...], "off": [...], "verb": [...]}.
pub fn claim_words() -> Value {
    Value::Object(CLAIM_WORDS.iter().map(|(k, w)| (k.to_string(), Value::from(w.to_vec()))).collect())
}

/// The comparison set of a request row, from the request's rows alone: every series row of the same table and time, and
/// the dims whose code differs among them (the varying dims). None when `src` is no series row.
fn row_family<'r>(src: &str, rows: &'r [Row]) -> Option<(Vec<&'r Row>, Vec<String>)> {
    let me = rows.iter().find(|r| r.src == src && r.src.starts_with(SERIES_SRC))?;
    let same: Vec<&Row> =
        rows.iter().filter(|r| r.src.starts_with(SERIES_SRC) && r.table == me.table && r.time == me.time).collect();
    let dims: std::collections::BTreeSet<&String> = same.iter().flat_map(|r| r.dims.keys()).collect();
    let vary = dims
        .into_iter()
        .filter(|d| same.iter().map(|r| r.dims.get(*d)).collect::<std::collections::BTreeSet<_>>().len() > 1)
        .cloned()
        .collect();
    Some((same, vary))
}

/// A claim's subject (its fact key or row src), its derived set with each member's computed value, its subject codes and
/// the member codes of its set.
type Claimed = (String, Vec<(String, Option<f64>)>, Vec<String>, std::collections::BTreeSet<String>);

/// claim_holds: every element with data-claim states the claim a number-free title makes, over a set this check derives
/// from the request (never from the page; a data-of or data-scope it carries is not read):
///   C1 it is the whole of an h1 (no words of the h1 outside it);
///   C2 data-claim is max (the one relation a title states);
///   C3 its subject data-a is a value fact (`fact:<k>`: its set the family of k, its subject the one code its filter holds)
///      or a request row (a series src: its set every series row of its table and time, its subject codes its codes on the
///      dims that vary among them); anything else, a merged fact (a list filter), a set of fewer than two or a member with
///      no computed value refuses;
///   C4 max holds: the subject's value strictly above every other member's (computed values, never page text);
///   C5 no digit in it and no fact entry printed in it: the title carries no number;
///   C6 each subject code printed in it by a name row, and no name row of another member (a fact's members: every code a
///      value fact of its table and time filters on, either side of a flow; a row's: every code of its set on the varying
///      dims);
///   C7 outside its marked names, no name of another member as the ledger's name rows give it, nor that name's first two
///      characters when it is longer;
///   C8 its words outside its marked names hold a max word and no off word (CLAIM_WORDS);
///   C9 a value fact's set is comparison's (C4 over it too), and the scope rule holds (scope_said): a set narrower than
///      the full set says the scope phrase, one over the full set (a request row's always) does not.
/// One line per finding; empty when the page passes (a page with no data-claim passes).
pub fn check_claims(html: &str, ledger: &BTreeMap<String, String>, spec: &Spec, facts: &[Fact], rows: &[Row]) -> Vec<String> {
    let mut off = Vec::new();
    let els = elements(html);
    let value = |k: &str| facts.iter().find(|f| f.key == k).map(|f| f.v);
    for e in els.iter().filter(|e| e.attr("data-claim").is_some()) {
        let body = &html[e.inner.clone()];
        let shown = text_outside(body, "\0");
        let h1 = els.iter().find(|h| h.name == "h1" && !std::ptr::eq(*h, e) && h.inner.contains(&e.inner.start));
        if h1.is_none_or(|h| text_outside(&html[h.inner.clone()], "\0").trim() != shown.trim()) {
            off.push(format!("{shown:?}: a claim is the whole of an h1 (C1)"));
            continue;
        }
        if e.attr("data-claim") != Some("max") {
            off.push(format!("{shown:?}: data-claim {:?} is not max (C2)", e.attr("data-claim").unwrap_or_default()));
            continue;
        }
        let src = e.attr("data-a").unwrap_or_default();
        let def = src.strip_prefix("fact:").and_then(|k| spec.facts.iter().find(|(key, _)| key == k));
        let mut scoped = false;
        let (me, set, subject, members): Claimed =
            if let Some((k, q)) = def {
                let code = q["filter"].as_object().filter(|f| f.len() == 1).and_then(|f| f.values().next());
                let Some(code) = code.and_then(Value::as_str) else {
                    off.push(format!("{shown:?}: {k} is a merged node or filters no one code, no subject (C3)"));
                    continue;
                };
                let mut members = std::collections::BTreeSet::new();
                let alike = spec.facts.iter().map(|(_, o)| o).filter(|o| o["op"] == "value" && o["table"] == q["table"] && o["time"] == q["time"]);
                for v in alike.filter_map(|o| o["filter"].as_object()).flat_map(|f| f.values()) {
                    match v {
                        Value::String(c) => {
                            members.insert(c.clone());
                        }
                        Value::Array(cs) => members.extend(cs.iter().filter_map(Value::as_str).map(str::to_string)),
                        _ => {}
                    }
                }
                let mut set: Vec<(String, Option<f64>)> = family(k, spec).into_iter().map(|o| (o.to_string(), value(o))).collect();
                if set.iter().any(|(_, v)| v.is_none()) {
                    off.push(format!("{shown:?}: a fact of the set of {k} has no computed value (C3)"));
                    continue;
                }
                // C9: the set compared over is comparison's, the codes the rows let the check compute alike with it
                let Some((all, narrower)) = comparison(k, spec, rows, facts) else {
                    off.push(format!("{shown:?}: the rows hold a code of the set of {k} its definition cannot read alike (C9)"));
                    continue;
                };
                set.extend(all.iter().filter(|m| m.key.is_none()).map(|m| (m.label(), Some(m.v))));
                scoped = narrower;
                (k.clone(), set, vec![code.to_string()], members)
            } else if let Some((same, vary)) = row_family(src, rows) {
                let Some(subject) = same.iter().find(|r| r.src == src).and_then(|r| vary.iter().map(|d| r.dims.get(d).cloned()).collect::<Option<Vec<_>>>())
                else {
                    off.push(format!("{shown:?}: {src} holds no code on a dimension its set varies on (C3)"));
                    continue;
                };
                let members = same.iter().flat_map(|r| vary.iter().filter_map(move |d| r.dims.get(d).cloned())).collect();
                (src.to_string(), same.iter().map(|r| (r.src.clone(), Some(r.value))).collect(), subject, members)
            } else {
                off.push(format!("{shown:?}: data-a {src:?} is neither a value fact nor a request row (C3)"));
                continue;
            };
        if set.len() < 2 {
            off.push(format!("{shown:?}: {me} has no comparison set (C3)"));
            continue;
        }
        let mine = set.iter().find(|(k, _)| *k == me).and_then(|(_, v)| *v);
        if mine.is_none() || !set.iter().filter(|(k, _)| *k != me).all(|(_, v)| mine > *v) {
            off.push(format!("{shown:?}: max does not hold for {me} over its derived set of {} (C4)", set.len()));
        }
        let seen = printed(body);
        if shown.chars().any(|c| c.is_ascii_digit() || ('\u{ff10}'..='\u{ff19}').contains(&c)) || seen.iter().any(|p| p.starts_with("fact:")) {
            off.push(format!("{shown:?}: a claim title carries no number (C5)"));
        }
        let names: Vec<&String> = seen.iter().filter(|p| p.starts_with(LABEL_SRC)).collect();
        for c in &subject {
            if !names.iter().any(|p| p.ends_with(&format!(":{c}"))) {
                off.push(format!("{shown:?}: the subject {c} is not named by its name row (C6)"));
            }
        }
        let others: Vec<&String> = members.iter().filter(|c| !subject.contains(*c)).collect();
        for p in &names {
            if let Some(c) = others.iter().find(|o| p.ends_with(&format!(":{o}"))) {
                off.push(format!("{shown:?}: names {c}, a member that is not the subject (C6)"));
            }
        }
        let bare = text_outside(body, "data-src");
        for c in &others {
            let rows_of = ledger.iter().filter(|(s, t)| s.starts_with(LABEL_SRC) && s.ends_with(&format!(":{c}")) && !t.is_empty());
            for (_, name) in rows_of {
                let two: String = name.chars().take(2).collect();
                let aliases = if name.chars().count() > 2 { vec![name.clone(), two] } else { vec![name.clone()] };
                for a in aliases.iter().filter(|a| bare.contains(a.as_str())) {
                    off.push(format!("{shown:?}: {a:?} names {c}, a member that is not the subject (C7)"));
                }
            }
        }
        if !claim_list("max").iter().any(|w| bare.contains(w)) {
            off.push(format!("{shown:?}: its words state no max (C8)"));
        }
        let held: Vec<&str> = claim_list("off").iter().copied().filter(|w| bare.contains(w)).collect();
        if !held.is_empty() {
            off.push(format!("{shown:?}: its words hold {held:?}, another relation or a qualifier the claim does not state (C8)"));
        }
        off.extend(scope_said(&shown, body, scoped).map(|f| format!("{f} (C9)")));
    }
    off
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(src: &str, value: f64, text: &str) -> Num {
        Num {
            src: src.into(),
            value,
            text: text.into(),
        }
    }

    fn label(src: &str, text: &str) -> Label {
        Label {
            src: src.into(),
            text: text.into(),
        }
    }

    fn refs() -> Vec<String> {
        vec!["sdg_07_40".into()]
    }

    /// A map point's entry names its table and that table's hash, and keeps the point as the table gives it.
    #[test]
    fn a_dropped_entry_names_its_layer_and_id_and_says_why() {
        assert_eq!(
            dropped_entry("leader_notes", "AT", "no free place for the note"),
            ("dropped:leader_notes:AT".to_string(), "no free place for the note".to_string())
        );
    }

    #[test]
    fn a_map_point_entry_names_its_table_and_hash() {
        assert_eq!(point_entry("ne", "ab12", "DE", [9.678348, -50.5]), ("point:ne@ab12:DE".to_string(), "9.678348,-50.5".to_string()));
    }

    /// A small page put together the way a node would: a headline, a big number, prose with a year from its data row,
    /// an SVG label with a value, a source line naming its table, one style and the one script.
    fn page(
        title: &str,
        hero: &Num,
        year: &Num,
    ) -> (String, Result<BTreeMap<String, String>, String>) {
        let mut l = Ledger::default();
        let html = format!(
            "<!doctype html><html><head><style>:root{{--accent:#eb0033;--bg:#ffffff}}.big{{font:700 72px/1 sans}}</style></head><body>\
             <h1>{}</h1><p class=\"big\">{}%</p><p>{}</p>\
             <svg role=\"img\" aria-label=\"Renewable share\"><text x=\"23%\" y=\"12\"><tspan>Sweden</tspan> {}</text></svg>\
             <p>{}</p><script>{READY_JS}</script></body></html>",
            esc(title),
            l.num("span", "big", hero),
            l.segs(
                "span",
                &[
                    Seg::Text("Sweden leads in ".into()),
                    Seg::Num(year.clone()),
                    Seg::Text(" at ".into()),
                    Seg::Num(hero.clone()),
                    Seg::Text("%.".into()),
                ]
            ),
            l.num("tspan", "val", &num("series:s1:SE:value", 65.4, "65.4")),
            l.segs(
                "span",
                &[Seg::Text("Source: Eurostat ".into()), Seg::Ref("sdg_07_40".into())]
            ),
        );
        (html, l.finish())
    }

    fn sample() -> (String, BTreeMap<String, String>) {
        let (html, ledger) = page(
            "Who leads, who trails",
            &num("c1:value", 65.4, "65.4"),
            &num("series:s1:time", 2025.0, "2025"),
        );
        (html, ledger.expect("every number prints"))
    }

    #[test]
    fn every_number_on_the_page_is_in_the_ledger() {
        let (html, ledger) = sample();
        assert_eq!(ledger.get("c1:value").map(String::as_str), Some("65.4"));
        assert_eq!(
            ledger.get("series:s1:time").map(String::as_str),
            Some("2025")
        );
        assert_eq!(
            ledger.get("series:s1:SE:value").map(String::as_str),
            Some("65.4")
        );
        assert_eq!(ledger.len(), 3);
        assert_eq!(check_numbers(&html, &ledger, &refs()), Vec::<String>::new());
        assert!(html.contains("<span class=\"n\" data-src=\"series:s1:time\">2025</span>"));
    }

    #[test]
    fn a_digit_off_the_ledger_fails_the_page() {
        let (_, ledger) = sample();
        let typed = page(
            "12 of 27 passed half",
            &num("c1:value", 65.4, "65.4"),
            &num("series:s1:time", 2025.0, "2025"),
        )
        .0;
        let found = check_numbers(&typed, &ledger, &refs());
        assert!(
            found.iter().any(|f| f.contains("the digits 12")),
            "{found:?}"
        );
        let hidden = page(
            "No. &#49;",
            &num("c1:value", 65.4, "65.4"),
            &num("series:s1:time", 2025.0, "2025"),
        )
        .0;
        // esc() turns the & into &amp;, so the page shows "&#49;" as text (digits 49); written raw, it is read as a 1
        assert!(check_numbers(&hidden, &ledger, &refs())
            .iter()
            .any(|f| f.contains("the digits 49")));
        let raw = hidden.replacen("&amp;#49;", "&#49;", 1);
        assert!(check_numbers(&raw, &ledger, &refs())
            .iter()
            .any(|f| f.contains("the digits 1")));
        let wide = page(
            "１２ countries",
            &num("c1:value", 65.4, "65.4"),
            &num("series:s1:time", 2025.0, "2025"),
        )
        .0;
        assert!(check_numbers(&wide, &ledger, &refs())
            .iter()
            .any(|f| f.contains("the digits 12")));
        // a year printed as plain words is not exempt: it must come from its data row through the ledger
        let year = sample().0.replacen(
            "<span class=\"n\" data-src=\"series:s1:time\">2025</span>",
            "2025",
            1,
        );
        assert!(check_numbers(&year, &ledger, &refs())
            .iter()
            .any(|f| f.contains("the digits 2025")));
        assert!(check_numbers(&sample().0, &ledger, &[])
            .iter()
            .any(|f| f.contains("sdg_07_40")));
    }

    #[test]
    fn a_number_printed_off_its_value_or_twice_differently_is_refused() {
        let (_, off) = page(
            "t",
            &num("c1:value", 65.4, "65.9"),
            &num("series:s1:time", 2025.0, "2025"),
        );
        assert!(off.unwrap_err().contains("does not print"));
        let mut l = Ledger::default();
        l.num("span", "n", &num("c1:value", 65.4, "65.4"));
        l.num("span", "n", &num("c1:value", 65.4, "65.40"));
        assert!(l.finish().unwrap_err().contains("printed as both"));
        // one value read from two sources (a claim and its series row) printed two ways
        let mut l = Ledger::default();
        l.num("span", "n", &num("c1:value", 22.45, "22.4"));
        l.num("span", "n", &num("series:s1:DE:value", 22.45, "22.5"));
        let err = l.finish().unwrap_err();
        assert!(
            err.contains("series:s1:DE:value: the value 22.45 is printed \"22.5\" here and \"22.4\" at c1:value"),
            "{err}"
        );
        let mut l = Ledger::default();
        l.num("span", "n", &num("c1:value", 22.45, "22.4"));
        l.num("span", "n", &num("series:s1:DE:value", 22.45, "22.4"));
        assert!(l.finish().is_ok());
        let (_, year) = page(
            "t",
            &num("c1:value", 65.4, "65.4"),
            &num("series:s1:time", 2025.0, "2024"),
        );
        assert!(year.unwrap_err().contains("series:s1:time"));
    }

    #[test]
    fn the_check_reads_the_written_page() {
        let (html, ledger) = sample();
        let changed = html.replacen(">65.4</span>", ">65.9</span>", 1);
        assert!(check_numbers(&changed, &ledger, &refs())
            .iter()
            .any(|f| f.contains("its ledger entry is")));
        let added = html.replacen("</h1>", "<span>3.5</span></h1>", 1);
        assert!(!check_numbers(&added, &ledger, &refs()).is_empty());
        let unknown = html.replacen("data-src=\"c1:value\"", "data-src=\"c9:value\"", 1);
        assert!(check_numbers(&unknown, &ledger, &refs())
            .iter()
            .any(|f| f.contains("not in the ledger")));
        let cdata = html.replacen("</body>", "<svg><text><![CDATA[44%]]></text></svg></body>", 1);
        assert!(check_numbers(&cdata, &ledger, &refs())
            .iter()
            .any(|f| f.contains("CDATA section is not read")));
        for early in ["<!--><b>44</b>-->", "<!---><b>44</b>-->", "<!-- x --!><b>44</b><!-- -->"] {
            let page = html.replacen("</body>", &format!("{early}</body>"), 1);
            assert!(check_numbers(&page, &ledger, &refs())
                .iter()
                .any(|f| f.contains("ends early")), "{early}");
        }
        let bogus = html.replacen("</body>", "<!x 7></body>", 1);
        assert!(check_numbers(&bogus, &ledger, &refs())
            .iter()
            .any(|f| f.contains("neither a comment nor the doctype")));
        let script = html.replacen("</body>", "<script>document.write(7)</script></body>", 1);
        assert!(check_numbers(&script, &ledger, &refs())
            .iter()
            .any(|f| f.contains("script")));
        let entity = html.replacen("</h1>", "&#51;</h1>", 1);
        assert!(check_numbers(&entity, &ledger, &refs())
            .iter()
            .any(|f| f.contains("the digits 3")));
        let label = html.replacen("aria-label=\"Renewable share\"", "aria-label=\"Top 5\"", 1);
        assert!(check_numbers(&label, &ledger, &refs())
            .iter()
            .any(|f| f.contains("the digits 5")));
        // digits in the style, in drawing attributes and in a comment are not page text
        assert!(html.contains("72px") && html.contains("x=\"23%\""));
        let comment = html.replacen("</h1>", "<!-- 42 --></h1>", 1);
        assert!(check_numbers(&comment, &ledger, &refs()).is_empty());
    }

    /// A page naming the G20 and EU27 from their name rows and PM2.5 from its code list, next to a number.
    fn labelled() -> (String, Result<BTreeMap<String, String>, String>) {
        let mut l = Ledger::default();
        let html = format!(
            "<!doctype html><html><body><h1>{}</h1><p>{}</p><svg><text><tspan>{}</tspan></text></svg></body></html>",
            l.label("span", "nm", &label("name:geo:G20", "G20")),
            l.segs(
                "span",
                &[
                    Seg::Label(label("name:migr_asyappctza:geo:EU27_2020", "EU27")),
                    Seg::Text(" took ".into()),
                    Seg::Num(num("c1:value", 912.0, "912")),
                    Seg::Text(" thousand.".into()),
                ]
            ),
            l.label("tspan", "nm", &label("name:env_air:airpol:PM2_5", "PM2.5")),
        );
        (html, l.finish())
    }

    #[test]
    fn a_name_with_digits_prints_its_name_row() {
        let (html, ledger) = labelled();
        let ledger = ledger.expect("every name and number prints");
        assert_eq!(ledger.get("name:geo:G20").map(String::as_str), Some("G20"));
        assert_eq!(ledger.len(), 4);
        assert_eq!(check_numbers(&html, &ledger, &[]), Vec::<String>::new());
        assert!(html.contains("<span class=\"nm\" data-src=\"name:geo:G20\">G20</span>"));
        // the page text must be the row's text exactly: a changed or longer name fails, as does one off the ledger
        let changed = html.replacen(">EU27</span>", ">EU28</span>", 1);
        assert!(check_numbers(&changed, &ledger, &[])
            .iter()
            .any(|f| f.contains("its ledger entry is \"EU27\"")));
        let longer = html.replacen(">G20</span>", ">G20 (19)</span>", 1);
        assert!(!check_numbers(&longer, &ledger, &[]).is_empty());
        let unknown = html.replacen("data-src=\"name:geo:G20\"", "data-src=\"name:geo:G7\"", 1);
        assert!(check_numbers(&unknown, &ledger, &[])
            .iter()
            .any(|f| f.contains("not in the ledger")));
        // the same name typed as plain words is a digit off the ledger: no name is exempt
        let typed = html.replacen("</h1>", " and the G7</h1>", 1);
        assert!(check_numbers(&typed, &ledger, &[])
            .iter()
            .any(|f| f.contains("the digits 7")));
    }

    #[test]
    fn a_label_is_a_name_from_a_name_row_and_a_number_is_not() {
        let mut l = Ledger::default();
        l.label("span", "nm", &label("name:geo:EU27_2020", "27"));
        assert!(l.finish().unwrap_err().contains("holds no letter"));
        let mut l = Ledger::default();
        l.label("span", "nm", &label("c1:value", "EU27"));
        assert!(l.finish().unwrap_err().contains("name row"));
        let mut l = Ledger::default();
        l.num("span", "n", &num("name:geo:G20", 20.0, "20"));
        assert!(l.finish().unwrap_err().contains("not a name row"));
        let mut l = Ledger::default();
        l.label("span", "nm", &label("name:geo:EU27_2020", "EU27"));
        l.label("span", "nm", &label("name:geo:EU27_2020", "EU-27"));
        assert!(l.finish().unwrap_err().contains("printed as both"));
    }

    #[test]
    fn a_second_saturated_colour_shows() {
        let (html, _) = sample();
        assert_eq!(saturated_colours(&html), ["#eb0033"]);
        assert_eq!(
            saturated_colours(&html.replace("--bg:#ffffff", "--bg:#2a6fdb")),
            ["#eb0033", "#2a6fdb"]
        );
    }

    use serde_json::json;

    // ---- relation_holds and accent_named (P5): a flow page's finding, the q2 run's numbers (DE 2024, ktoe), English names

    /// The request's fact definitions, computed values and ledger of a two-sided flow: sources over siec, destinations over
    /// nrg_bal, a merged node on each side, and one fact of another op.
    fn flow_request() -> (Spec, Vec<Fact>, BTreeMap<String, String>) {
        let nodes: [(&str, &str, Value, f64, &str, &str); 11] = [
            ("from.O4000XBIO", "siec", json!("O4000XBIO"), 60699.059, "60,699.06", "Oil"),
            ("from.G3000", "siec", json!("G3000"), 45028.241, "45,028.24", "Gas"),
            ("from.E7000", "siec", json!("E7000"), 40566.981, "40,566.98", "Power"),
            ("from.RA000", "siec", json!("RA000"), 16893.734, "16,893.73", "Renewables"),
            ("from.H8000", "siec", json!("H8000"), 8682.741, "8,682.74", "Heat"),
            ("from_other", "siec", json!(["C0000X0350-0370", "C0350-0370", "W6100_6220"]), 5874.307, "5,874.31", ""),
            ("to.FC_OTH_HH_E", "nrg_bal", json!("FC_OTH_HH_E"), 52455.833, "52,455.83", "Homes"),
            ("to.FC_TRA_E", "nrg_bal", json!("FC_TRA_E"), 49522.114, "49,522.11", "Transport"),
            ("to.FC_IND_E", "nrg_bal", json!("FC_IND_E"), 48368.385, "48,368.38", "Industry"),
            ("to.FC_OTH_CP_E", "nrg_bal", json!("FC_OTH_CP_E"), 23800.773, "23,800.77", "Services"),
            ("to_other", "nrg_bal", json!(["FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"]), 3597.958, "3,597.96", ""),
        ];
        let fact = |key: &str, op: &str, v: f64, fmt: &str| Fact {
            key: key.into(),
            op: op.into(),
            v,
            t: None,
            n: None,
            who: Vec::new(),
            fmt: fmt.into(),
            reads: Vec::new(),
        };
        let mut defs = vec![("zero_flows".to_string(), json!({"op": "zeros", "table": "nrg_bal_c", "time": "2024", "fmt": "n"}))];
        let mut facts = vec![fact("zero_flows", "zeros", 12.0, "n")];
        let mut ledger = BTreeMap::from([("name:unit_short_zh:KTOE".to_string(), "ktoe".to_string())]);
        for (key, dim, code, v, text, name) in nodes {
            defs.push((key.into(), json!({"op": "value", "table": "nrg_bal_c", "time": "2024", "fmt": "ktoe", "filter": {dim: code}})));
            facts.push(fact(key, "value", v, "ktoe"));
            ledger.insert(format!("fact:{key}.n"), text.into());
            if let Some(code) = code.as_str() {
                ledger.insert(format!("name:zh_names:{dim}:{code}"), name.into());
            }
        }
        (Spec { facts: defs, fmts: json!({}), members: None }, facts, ledger)
    }

    /// A node's name and its value marked as the leaf prints them (svg: tspan, html: span), the value bold.
    fn named_value(tag: &str, dim: &str, code: &str, name: &str, key: &str, text: &str) -> String {
        let bold = if tag == "span" { ("<b class=\"n\">", "</b>") } else { ("<tspan font-weight=\"700\">", "</tspan>") };
        format!("<{tag} data-src=\"name:zh_names:{dim}:{code}\">{name}</{tag}> {}<{tag} data-src=\"fact:{key}.n\">{text}</{tag}>{}", bold.0, bold.1)
    }

    /// The flow page with its finding as the prototype leaf draws it: the headline (max) in the h1, the subject's node in the
    /// accent, one note (next) per side; the relation and paren words from the word table.
    fn flow_page() -> String {
        let above = format!("\u{ff0c}{}", relation_words("next")[0]);
        let head = format!(
            "<span data-cmp=\"max\" data-a=\"fact:from.O4000XBIO.n\">{} <span data-src=\"name:unit_short_zh:KTOE\">ktoe</span>{above}</span>",
            named_value("span", "siec", "O4000XBIO", "Oil", "from.O4000XBIO", "60,699.06")
        );
        let note = |a: (&str, &str, &str, &str, &str), b: (&str, &str, &str, &str, &str)| {
            format!(
                "<text x=\"152.6\" y=\"546.0\" data-cmp=\"next\" data-a=\"fact:{}.n\" data-b=\"fact:{}.n\">{}{above}\u{ff08}{}\u{ff09}</text>",
                a.3, b.3, named_value("tspan", a.0, a.1, a.2, a.3, a.4), named_value("tspan", b.0, b.1, b.2, b.3, b.4)
            )
        };
        format!(
            "<!doctype html><html><body><header><div class=\"kicker\">Energy from sources to sectors</div><h1>{head}</h1>\
             <p class=\"dek\">From source to use</p></header><svg><g data-layer=\"sankey\">\
             <rect x=\"147.6\" y=\"54\" width=\"14\" height=\"140\" fill=\"var(--accent)\" data-code=\"O4000XBIO\"/>\
             <rect x=\"147.6\" y=\"204\" width=\"14\" height=\"103\" fill=\"var(--t-sec)\" data-code=\"G3000\"/>\
             <rect x=\"990.4\" y=\"185\" width=\"14\" height=\"103\" fill=\"var(--t-sec)\" data-code=\"FC_TRA_E\"/>\
             <g data-notes=\"finding\"><polyline points=\"144.6,124 144.6,541 149.6,541\" fill=\"none\"/>{}{}</g></g></svg>\
             <script>{READY_JS}</script></body></html>",
            note(("siec", "O4000XBIO", "Oil", "from.O4000XBIO", "60,699.06"), ("siec", "G3000", "Gas", "from.G3000", "45,028.24")),
            note(("nrg_bal", "FC_OTH_HH_E", "Homes", "to.FC_OTH_HH_E", "52,455.83"), ("nrg_bal", "FC_TRA_E", "Transport", "to.FC_TRA_E", "49,522.11")),
        )
    }

    /// The two new check kinds on a page, and the existing number check on it (which a must-fail below must pass).
    fn new_checks(html: &str, facts: &[Fact]) -> (Vec<String>, Vec<String>) {
        let (spec, _, ledger) = flow_request();
        let mut off = check_relations(html, &ledger, &spec, facts, &[]);
        off.extend(check_accent_named(html));
        (off, check_numbers(html, &ledger, &[]))
    }

    #[test]
    fn a_flow_finding_holds_over_the_set_its_fact_definitions_give() {
        let (spec, facts, _) = flow_request();
        assert_eq!(family("from.G3000", &spec), ["from.E7000", "from.G3000", "from.H8000", "from.O4000XBIO", "from.RA000", "from_other"]);
        assert_eq!(family("to_other", &spec).len(), 5);
        assert!(family("zero_flows", &spec).is_empty() && family("nothing", &spec).is_empty());
        assert_eq!(fact_key("fact:from.G3000.n", &spec), Some("from.G3000"));
        assert_eq!(fact_key("fact:from_other", &spec), Some("from_other"));
        assert_eq!(fact_key("series:from.G3000", &spec), None);
        assert_eq!(new_checks(&flow_page(), &facts), (Vec::<String>::new(), Vec::<String>::new()));
        // a page with no relation marked is out of both checks' way, its accent unnamed included
        let plain = "<h1>Energy</h1><svg><circle fill=\"var(--accent)\" data-code=\"DE\"/></svg>";
        assert_eq!(new_checks(plain, &facts).0, Vec::<String>::new());
    }

    /// F6-F11, F18, F19 of the prototype: tampers the new checks refuse (some the number check refuses too).
    #[test]
    fn a_flow_finding_refuses_a_false_or_unmarked_relation() {
        let (_, facts, _) = flow_request();
        let page = flow_page();
        let word = relation_words("next")[0].clone();
        let refused = |html: &str| !new_checks(html, &facts).0.is_empty();
        assert!(refused(&page.replacen(&word, "x", 2)), "F6 a note without its comparison word");
        let swapped = page.replacen(
            "data-a=\"fact:from.O4000XBIO.n\" data-b=\"fact:from.G3000.n\"",
            "data-a=\"fact:from.G3000.n\" data-b=\"fact:from.O4000XBIO.n\"",
            1,
        );
        assert!(refused(&swapped), "F7 a note's two entries swapped");
        assert!(refused(&page.replacen("data-b=\"fact:from.G3000.n\"", "data-b=\"fact:from.O4000XBIO.n\"", 1)), "F8 compared with itself");
        assert!(refused(&page.replacen(" data-cmp=\"next\"", "", 1)), "F9 a note with no comparison marked");
        assert!(refused(&page.replacen("data-b=\"fact:from.G3000.n\"", "data-b=\"fact:from.E7000.n\"", 1)), "F10 an entry it does not print");
        let moved = page.replacen("fill=\"var(--accent)\" data-code=\"O4000XBIO\"", "fill=\"var(--accent)\" data-code=\"G3000\"", 1);
        assert!(refused(&moved), "F11 the accent on an entity the title does not name");
        let lie = page
            .replacen("data-cmp=\"max\" data-a=\"fact:from.O4000XBIO.n\"", "data-cmp=\"max\" data-a=\"fact:from.G3000.n\"", 1)
            .replacen("name:zh_names:siec:O4000XBIO\">Oil<", "name:zh_names:siec:G3000\">Gas<", 1)
            .replacen("data-src=\"fact:from.O4000XBIO.n\">60,699.06<", "data-src=\"fact:from.G3000.n\">45,028.24<", 1);
        assert!(refused(&lie), "F18 the headline names a node that is not the largest");
        let h1 = &page[page.find("<h1>").unwrap()..page.find("</h1>").unwrap()];
        assert!(refused(&page.replacen(h1, &h1.replacen(&word, "x", 1), 1)), "F19 the headline's comparison word removed");
    }

    /// F20-F28 of the prototype: each refused by relation_holds or accent_named alone, the existing number check passing it.
    #[test]
    fn a_flow_finding_refused_by_the_new_checks_alone() {
        let (_, facts, _) = flow_request();
        let page = flow_page();
        let h1 = page[page.find("<h1>").unwrap() + 4..page.find("</h1>").unwrap()].to_string();
        let alone = |name: &str, html: &str, facts: &[Fact]| {
            let (new, old) = new_checks(html, facts);
            assert!(!new.is_empty() && old.is_empty(), "{name}: new {new:?} numbers {old:?}");
        };
        let word = relation_words("max")[0].clone();
        let gas = format!(
            "{} <span data-src=\"name:unit_short_zh:KTOE\">ktoe</span>\u{ff0c}{word}",
            named_value("span", "siec", "G3000", "Gas", "from.G3000", "45,028.24")
        );
        let head = |inner: String| page.replacen(&h1, &inner, 1);
        alone(
            "F20 a short data-of that omits the true max",
            &head(format!("<span data-cmp=\"max\" data-a=\"fact:from.G3000.n\" data-of=\"fact:from.G3000.n fact:from.E7000.n\">{gas}</span>")),
            &facts,
        );
        alone(
            "F21 max over a set from the other side",
            &head(format!("<span data-cmp=\"max\" data-a=\"fact:from.G3000.n\" data-of=\"fact:from.G3000.n fact:to.FC_OTH_CP_E.n fact:to_other.n\">{gas}</span>")),
            &facts,
        );
        let tied: Vec<Fact> =
            facts.iter().cloned().map(|f| if f.key == "from.G3000" { Fact { v: 60699.059, ..f } } else { f }).collect();
        alone("F22 gt where the two values tie", &page.replacen("data-cmp=\"next\"", "data-cmp=\"gt\"", 1), &tied);
        alone("F23 next where the two values tie", &page, &tied);
        let third = page.replacen("data-b=\"fact:from.G3000.n\"", "data-b=\"fact:from.E7000.n\"", 1).replacen(
            &named_value("tspan", "siec", "G3000", "Gas", "from.G3000", "45,028.24"),
            &named_value("tspan", "siec", "E7000", "Power", "from.E7000", "40,566.98"),
            1,
        );
        alone("F24 the note's second is the third", &third, &facts);
        let cross = page.replacen("data-b=\"fact:from.G3000.n\"", "data-b=\"fact:to.FC_TRA_E.n\"", 1).replacen(
            &named_value("tspan", "siec", "G3000", "Gas", "from.G3000", "45,028.24"),
            &named_value("tspan", "nrg_bal", "FC_TRA_E", "Transport", "to.FC_TRA_E", "49,522.11"),
            1,
        );
        alone("F25 a note compared with a node of the other side", &cross, &facts);
        let borrowed = page
            .replacen("data-cmp=\"max\" data-a=\"fact:from.O4000XBIO.n\"", "data-cmp=\"max\" data-a=\"fact:to.FC_OTH_HH_E.n\"", 1)
            .replacen("data-src=\"fact:from.O4000XBIO.n\">60,699.06<", "data-src=\"fact:to.FC_OTH_HH_E.n\">52,455.83<", 1);
        alone("F26 the other side's true max under another node's name", &borrowed, &facts);
        alone("F27 a relation word in the h1 with no data-cmp", &head(h1.replacen("<span data-cmp=\"max\" data-a=\"fact:from.O4000XBIO.n\">", "<span>", 1)), &facts);
        let on_target = page.replacen("fill=\"var(--t-sec)\" data-code=\"FC_TRA_E\"", "fill=\"var(--accent)\" data-code=\"FC_TRA_E\"", 1);
        assert_ne!(on_target, page);
        alone("F28 the accent on a code the h1 does not name", &on_target, &facts);
    }

    /// The leaf's side rule (wbkit.finding_side_top) and this check agree: a side whose merged node is above its second named
    /// node, or whose second prints like its third, claims nothing; the page the leaf then draws (the finding on the other
    /// side, or that side's note left out) passes, and the page it drew before the rule matched the check is refused.
    #[test]
    fn a_side_the_leaf_leaves_out_is_one_the_check_would_refuse() {
        let (spec, facts, ledger) = flow_request();
        let page = flow_page();
        let check = |html: &str, facts: &[Fact], ledger: &BTreeMap<String, String>| -> Vec<String> {
            let mut off = check_relations(html, ledger, &spec, facts, &[]);
            off.extend(check_accent_named(html));
            off
        };
        let note_of = |html: &str, a: &str| -> String {
            let at = html.find(&format!("data-a=\"fact:{a}.n\" data-b=")).unwrap();
            let start = html[..at].rfind("<text").unwrap();
            let end = at + html[at..].find("</text>").unwrap() + "</text>".len();
            html[start..end].to_string()
        };
        // the merged sources above the second named source: the sources claim nothing, the destinations take the finding
        let merged: Vec<Fact> =
            facts.iter().cloned().map(|f| if f.key == "from_other" { Fact { v: 46000.0, ..f } } else { f }).collect();
        let mut merged_ledger = ledger.clone();
        merged_ledger.insert("fact:from_other.n".into(), "46,000.00".into());
        assert!(!check(&page, &merged, &merged_ledger).is_empty(), "the sources' note: its second is below the merged node");
        let homes = format!(
            "<span data-cmp=\"max\" data-a=\"fact:to.FC_OTH_HH_E.n\">{} <span data-src=\"name:unit_short_zh:KTOE\">ktoe</span>\u{ff0c}{}</span>",
            named_value("span", "nrg_bal", "FC_OTH_HH_E", "Homes", "to.FC_OTH_HH_E", "52,455.83"),
            relation_words("max")[0]
        );
        let h1 = page[page.find("<h1>").unwrap() + 4..page.find("</h1>").unwrap()].to_string();
        let tra = "<rect x=\"990.4\" y=\"185\" width=\"14\" height=\"103\" fill=\"var(--t-sec)\" data-code=\"FC_TRA_E\"/>";
        let to_side = page
            .replacen(&h1, &homes, 1)
            .replacen(&note_of(&page, "from.O4000XBIO"), "", 1)
            .replacen("fill=\"var(--accent)\" data-code=\"O4000XBIO\"", "fill=\"var(--t-sec)\" data-code=\"O4000XBIO\"", 1)
            .replacen(tra, &format!("{tra}<rect x=\"990.4\" y=\"60\" width=\"14\" height=\"120\" fill=\"var(--accent)\" data-code=\"FC_OTH_HH_E\"/>"), 1);
        assert!(!to_side.contains("data-a=\"fact:from.O4000XBIO.n\""));
        assert_eq!(check(&to_side, &merged, &merged_ledger), Vec::<String>::new());
        // the second destination prints like the third: the destinations claim nothing, the sources keep the finding
        let mut alike = ledger.clone();
        alike.insert("fact:to.FC_IND_E.n".into(), "49,522.11".into());
        assert!(!check(&page, &facts, &alike).is_empty(), "the destinations' note: its second prints like the third");
        let from_side = page.replacen(&note_of(&page, "to.FC_OTH_HH_E"), "", 1);
        assert!(!from_side.contains("data-a=\"fact:to.FC_OTH_HH_E.n\""));
        assert_eq!(check(&from_side, &facts, &alike), Vec::<String>::new());
    }

    /// The measure for P5 (run with --ignored): both new checks over published pages (P5_PAGES, one path per line) find
    /// nothing; with P5_PAGE and P5_REQUEST (a page and the request.json it was checked against) the page passes them too.
    #[test]
    #[ignore]
    fn relation_checks_over_stored_pages() {
        let mut hits = 0;
        let list = std::fs::read_to_string(std::env::var("P5_PAGES").unwrap()).unwrap();
        let pages: Vec<&str> = list.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let none = Spec { facts: Vec::new(), fmts: json!({}), members: None };
        for p in &pages {
            let html = std::fs::read_to_string(p).unwrap();
            let mut off = check_relations(&html, &BTreeMap::new(), &none, &[], &[]);
            off.extend(check_accent_named(&html));
            hits += off.len();
            off.iter().for_each(|f| println!("finding {p}: {f}"));
        }
        println!("P5 pages {} findings {hits}", pages.len());
        if let (Ok(page), Ok(req)) = (std::env::var("P5_PAGE"), std::env::var("P5_REQUEST")) {
            let html = std::fs::read_to_string(page).unwrap();
            let req: Value = serde_json::from_str(&std::fs::read_to_string(req).unwrap()).unwrap();
            let spec: Spec = serde_json::from_value(req["spec"].clone()).unwrap();
            let facts: Vec<Fact> = serde_json::from_value(req["facts"].clone()).unwrap();
            let ledger: BTreeMap<String, String> = serde_json::from_value(req["ledger"].clone()).unwrap();
            let rows: Vec<Row> = req["rows"].as_array().into_iter().flatten().filter_map(|r| serde_json::from_value(r.clone()).ok()).collect();
            let mut off = check_relations(&html, &ledger, &spec, &facts, &rows);
            off.extend(check_claims(&html, &ledger, &spec, &facts, &rows));
            off.extend(check_accent_named(&html));
            println!("P5 page findings {} {off:?}", off.len());
            hits += off.len();
        }
        assert_eq!(hits, 0);
    }

    // ---- the share set and the scope rule (P4b-5, design-share and design-scope v2): the q3 composition request's share
    // facts, their numerators, denominators, values, ledger entries, place name rows and rows, cut from an archived run's
    // request.json (scripts/fixtures/p4b5/q3-share.json)

    type ShareRequest = (Spec, Vec<Fact>, BTreeMap<String, String>, Vec<Row>);

    fn share_request() -> ShareRequest {
        let r: Value = serde_json::from_str(include_str!("../scripts/fixtures/p4b5/q3-share.json")).unwrap();
        let part = |k: &str| r[k].clone();
        (
            serde_json::from_value(part("spec")).unwrap(),
            serde_json::from_value(part("facts")).unwrap(),
            serde_json::from_value(part("ledger")).unwrap(),
            serde_json::from_value(part("rows")).unwrap(),
        )
    }

    /// The request with one more fact definition; a share also with its value and its ledger entries (printed and bare).
    fn with_fact(mut r: ShareRequest, key: &str, def: Value, share: Option<(f64, &str)>) -> ShareRequest {
        if let Some((v, text)) = share {
            r.1.push(Fact { key: key.into(), op: "share".into(), v, t: None, n: None, who: Vec::new(), fmt: "pct".into(), reads: Vec::new() });
            r.2.insert(format!("fact:{key}"), format!("{text}%"));
            r.2.insert(format!("fact:{key}.n"), text.into());
        }
        r.0.facts.push((key.into(), def));
        r
    }

    /// A request row at 2024, its src from its codes.
    fn row_at(table: &str, dims: &[(&str, &str)], value: f64) -> Row {
        let dims: BTreeMap<String, String> = dims.iter().map(|(d, c)| (d.to_string(), c.to_string())).collect();
        let codes: Vec<&str> = dims.values().map(String::as_str).collect();
        Row { src: format!("{SERIES_SRC}{table}/{}:2024:OBS_VALUE", codes.join(".")), table: table.into(), dims, time: "2024".into(), value }
    }

    /// The scope phrase, as the word table gives it (the leaf reads the same key).
    fn scope() -> String {
        word_table()[SCOPE_WORD].as_str().expect("the word table holds the scope phrase").to_string()
    }

    /// A place's name as its name row prints it.
    fn place(l: &BTreeMap<String, String>, code: &str) -> String {
        format!("<tspan data-src=\"name:zh_names:iso2:{code}\">{}</tspan>", l[&format!("name:zh_names:iso2:{code}")])
    }

    /// The note under the bars as stacked100 draws it: `lead` (the scope phrase and its comma, or nothing), then `rel` of a
    /// over b, each (place code, share fact) printed by its name row and its share in bold, the relation's and the paren's
    /// words from the word table.
    fn share_note(l: &BTreeMap<String, String>, rel: &str, a: (&str, &str), b: (&str, &str), lead: &str) -> String {
        let nv = |(code, key): (&str, &str)| {
            format!("{} <tspan font-weight=\"700\"><tspan data-src=\"fact:{key}\">{}</tspan></tspan>", place(l, code), l[&format!("fact:{key}")])
        };
        format!(
            "<!doctype html><html><body><h1>Composition</h1><svg><g data-layer=\"stacked100\"><g data-notes=\"share\">\
             <text x=\"8.0\" y=\"560.0\" data-cmp=\"{rel}\" data-a=\"fact:{}\" data-b=\"fact:{}\">{lead}{}\u{ff0c}{}\u{ff08}{}\u{ff09}</text>\
             </g></g></svg></body></html>",
            a.1,
            b.1,
            nv(a),
            relation_words("next")[0],
            nv(b)
        )
    }

    fn share_page(l: &BTreeMap<String, String>, rel: &str, a: (&str, &str), b: (&str, &str)) -> String {
        share_note(l, rel, a, b, "")
    }

    fn scoped_page(l: &BTreeMap<String, String>, rel: &str, a: (&str, &str), b: (&str, &str)) -> String {
        share_note(l, rel, a, b, &format!("{}\u{ff0c}", scope()))
    }

    /// The relation checks on a page over a request, and the existing number check on it (which a must-fail must pass).
    fn share_checks(html: &str, (spec, facts, ledger, rows): &ShareRequest) -> (Vec<String>, Vec<String>) {
        let mut off = check_relations(html, ledger, spec, facts, rows);
        off.extend(check_accent_named(html));
        (off, check_numbers(html, ledger, &[]))
    }

    /// Transport's rows at a place: its use (FC_TRA_E) when given, its final use (FC_E) 1000.
    fn transport_rows(geo: &str, tra: Option<f64>) -> Vec<Row> {
        let at = |bal: &str, v: f64| row_at("nrg_bal_c", &[("geo", geo), ("nrg_bal", bal), ("siec", "TOTAL"), ("unit", "KTOE")], v);
        tra.map(|v| at("FC_TRA_E", v)).into_iter().chain([at("FC_E", 1000.0)]).collect()
    }

    /// P3, a second data shape: transport's share of final energy use by place, numerator and denominator one code each on
    /// nrg_bal (not siec) and alike on siec, with their rows, over the q3 request's place names.
    fn transport() -> ShareRequest {
        let mut r = (Spec { facts: Vec::new(), fmts: json!({}), members: None }, Vec::new(), share_request().2, Vec::new());
        for (geo, tra, text) in [("DE", 301.0, "30"), ("FR", 334.0, "33"), ("IT", 287.0, "29")] {
            for (k, bal) in [("tra", "FC_TRA_E"), ("fc", "FC_E")] {
                let filter = json!({"geo": geo, "nrg_bal": bal, "siec": "TOTAL"});
                r = with_fact(r, &format!("{k}.{geo}"), json!({"op": "value", "table": "nrg_bal_c", "time": "2024", "fmt": "ktoe", "filter": filter}), None);
            }
            r = with_fact(r, &format!("share.tra.{geo}"), json!({"op": "share", "a": format!("tra.{geo}"), "b": format!("fc.{geo}")}), Some((tra / 1000.0, text)));
            r.3.extend(transport_rows(geo, Some(tra)));
        }
        r
    }

    /// q3 with Portugal's fossil share made `share` (its gas row and its total raised alike).
    fn portugal_at(share: f64) -> ShareRequest {
        let mut r = share_request();
        let fossil: Vec<String> = r.0.facts.iter().find(|(k, _)| k == "sum.fossil.PT").map_or_else(
            || r.0.facts.iter().find(|(k, _)| k == "sum.fossil.PL").unwrap().1["filter"]["siec"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect(),
            |(_, q)| q["filter"]["siec"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect(),
        );
        let at = |r: &ShareRequest, siec: &str| r.3.iter().position(|x| x.dims["geo"] == "PT" && x.dims["siec"] == siec);
        let f: f64 = r.3.iter().filter(|x| x.dims["geo"] == "PT" && fossil.contains(&x.dims["siec"])).map(|x| x.value).sum();
        let t = r.3[at(&r, "TOTAL").unwrap()].value;
        let more = (share * t - f) / (1.0 - share);
        let (g, tot) = (at(&r, "G3000").unwrap(), at(&r, "TOTAL").unwrap());
        r.3[g].value += more;
        r.3[tot].value += more;
        r
    }

    /// P1, P2 (q3's fossil and renewable sets: the rows hold 27 places, Portugal computed into both, six with a total only,
    /// so a note says the scope), P3 (a second shape, first over every place, then over one with a total only and one more
    /// computed), the sets, their codes and what the leaf is handed.
    #[test]
    fn a_share_note_holds_over_the_share_set_and_the_codes_the_rows_compute() {
        let r = share_request();
        let (spec, facts, l, rows) = &r;
        let fossil = share_family("share.fossil.PL", spec);
        let codes: std::collections::BTreeSet<&str> = fossil.iter().map(|(_, c)| c.as_str()).collect();
        assert_eq!((fossil.len(), codes.len()), (21, 20));
        assert!(fossil.contains(&("comp_top", "PL".to_string())));
        assert!(fossil.iter().all(|(k, c)| *k == "comp_top" || *k == format!("share.fossil.{c}")));
        assert_eq!(share_family("comp_top", spec), fossil);
        assert_eq!(share_family("share.renewable.DK", spec).len(), 20);
        assert!(share_family("share.nuclear.FR", spec).is_empty(), "nuclear holds 12 of the 20 places shared out");
        assert!(family("share.fossil.PL", spec).is_empty() && share_family("total.PL", spec).is_empty());
        assert_eq!((member_code("comp_top", spec), member_code("share.renewable.AT", spec)), (Some("PL".into()), Some("AT".into())));
        let computed = |k: &str| {
            let (set, scoped) = comparison(k, spec, rows, facts).unwrap();
            let extra: Vec<(String, i64)> = set.iter().filter(|m| m.key.is_none()).map(|m| (m.code.clone().unwrap(), (m.v * 1000.0).round() as i64)).collect();
            (extra, scoped)
        };
        assert_eq!(computed("share.fossil.PL"), (vec![("PT".to_string(), 133)], true));
        assert_eq!(computed("share.renewable.DK"), (vec![("PT".to_string(), 790)], true));
        assert_eq!(computed("share.other.AT"), (Vec::new(), true), "Portugal's other share: no E7000 row");
        assert!(comparison("share.nuclear.FR", spec, rows, facts).is_none());
        let pass = |html: String, r: &ShareRequest| assert_eq!(share_checks(&html, r), (Vec::new(), Vec::new()), "{html}");
        let (pl, ie) = (("PL", "share.fossil.PL"), ("IE", "share.fossil.IE"));
        // P1: Poland 68% above Ireland 52% above Greece 51%, Portugal 13% computed, data-a the share or its copy comp_top
        pass(scoped_page(l, "next", pl, ie), &r);
        pass(scoped_page(l, "next", ("PL", "comp_top"), ie), &r);
        pass(scoped_page(l, "max", pl, ie), &r);
        pass(scoped_page(l, "gt", ie, ("EL", "share.fossil.EL")), &r);
        // P2: Denmark 89% above Austria 82%, Portugal 79% computed below them, a numerator of one code
        pass(scoped_page(l, "next", ("DK", "share.renewable.DK"), ("AT", "share.renewable.AT")), &r);
        let handed = comparisons(spec, rows, facts);
        assert_eq!(handed["share.fossil.PL"], json!({"first": "PL", "second": "IE", "scoped": true}));
        assert_eq!(handed["comp_top"], handed["share.fossil.PL"]);
        assert_eq!(handed["share.renewable.AT"], json!({"first": "DK", "second": "AT", "scoped": true}));
        assert!(handed.get("share.nuclear.FR").is_none() && handed.get("sum.fossil.PL").is_none());
        // P3: France 33% above Germany 30% above Italy 29%, every place of the rows in the set: no phrase
        let t = transport();
        assert_eq!(share_family("share.tra.FR", &t.0).iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>(), ["DE", "FR", "IT"]);
        assert_eq!(comparison("share.tra.FR", &t.0, &t.3, &t.1).map(|(m, s)| (m.len(), s)), Some((3, false)));
        let (fr, de) = (("FR", "share.tra.FR"), ("DE", "share.tra.DE"));
        pass(share_page(&t.2, "next", fr, de), &t);
        assert!(!share_checks(&share_page(&t.2, "next", fr, ("IT", "share.tra.IT")), &t).0.is_empty(), "P3's third");
        // a place with its final use only: not computed, so the set is scoped; one with both rows is computed into it
        let mut lone = t.clone();
        lone.3.extend(transport_rows("ES", None));
        assert!(!share_checks(&share_page(&lone.2, "next", fr, de), &lone).0.is_empty(), "P3 scoped, no phrase");
        pass(scoped_page(&lone.2, "next", fr, de), &lone);
        let mut more = lone.clone();
        more.3.extend(transport_rows("PL", Some(250.0)));
        let (set, scoped) = comparison("share.tra.FR", &more.0, &more.3, &more.1).unwrap();
        assert!(scoped && set.iter().any(|m| m.key.is_none() && m.code.as_deref() == Some("PL") && (m.v - 0.25).abs() < 1e-12));
        pass(scoped_page(&more.2, "next", fr, de), &more);
        let mut above = lone.clone();
        above.3.extend(transport_rows("PL", Some(320.0)));
        assert!(!share_checks(&scoped_page(&above.2, "next", fr, de), &above).0.is_empty(), "P3: a computed place second");
    }

    /// F6-F31 over the share set and M1-M6, M8 of the scope rule: each refused by the relation check, the number check
    /// passing it.
    #[test]
    fn a_share_note_refused_by_the_share_set_or_the_scope_rule_alone() {
        let r = share_request();
        let l = r.2.clone();
        let alone = |name: &str, html: &str, r: &ShareRequest| {
            let (new, old) = share_checks(html, r);
            assert!(!new.is_empty() && old.is_empty(), "{name}: new {new:?} numbers {old:?}");
            new
        };
        let said = |name: &str, html: &str, r: &ShareRequest, why: &str| {
            let off = alone(name, html, r);
            assert!(off.iter().any(|f| f.contains(why)), "{name}: {off:?}");
        };
        let (pl, ie, el) = (("PL", "share.fossil.PL"), ("IE", "share.fossil.IE"), ("EL", "share.fossil.EL"));
        let page = scoped_page(&l, "next", pl, ie);
        let p = scope();
        // the scope rule
        said("M1 no scope phrase over a scoped set", &share_page(&l, "next", pl, ie), &r, "do not say");
        let cut: String = p.chars().skip(1).collect();
        said("M2 the phrase cut short", &page.replacen(&p, &cut, 1), &r, "do not say");
        let k = p.char_indices().nth(3).unwrap().0;
        said("M2b the phrase split by a tspan", &page.replacen(&p, &format!("{}<tspan>{}</tspan>", &p[..k], &p[k..]), 1), &r, "do not say");
        let outside = share_page(&l, "next", pl, ie).replacen("<h1>Composition</h1>", &format!("<h1>{p}</h1>"), 1);
        said("M2c the phrase outside the data-cmp element", &outside, &r, "do not say");
        let wrong: String = p.chars().rev().collect();
        said("M4 another scope's words", &page.replacen(&p, &wrong, 1), &r, "do not say");
        said("M5 gt over a scoped set, no phrase", &share_page(&l, "gt", ie, el), &r, "do not say");
        let of = share_page(&l, "max", pl, ie).replacen("data-cmp=\"max\"", "data-cmp=\"max\" data-of=\"fact:share.fossil.PL fact:share.fossil.IE\"", 1);
        said("M6 a page-given set and no phrase", &of, &r, "do not say");
        // M8: Portugal computed above Poland (70%), then between Poland and Ireland (60%): refused, the phrase said
        said("M8 a computed code above data-a", &page, &portugal_at(0.70), "does not hold");
        said("M8b a computed code above data-b", &page, &portugal_at(0.60), "does not hold");
        assert_eq!(comparisons(&portugal_at(0.70).0, &portugal_at(0.70).3, &portugal_at(0.70).1)["share.fossil.PL"]["first"], "PT");
        // M9: a row of Portugal's in a second unit, under its numerator's or its denominator's codes: never summed in, the
        // comparison refused and nothing handed to the leaf
        for siec in ["G3000", "TOTAL"] {
            let mut tj = r.clone();
            let mut extra = tj.3.iter().find(|x| x.dims["geo"] == "PT" && x.dims["siec"] == siec).unwrap().clone();
            extra.dims.insert("unit".into(), "TJ".into());
            extra.src = extra.src.replace(".GWH.", ".TJ.");
            extra.value *= 3.6;
            tj.3.push(extra);
            assert!(comparison("share.fossil.PL", &tj.0, &tj.3, &tj.1).is_none(), "{siec}");
            assert!(comparisons(&tj.0, &tj.3, &tj.1).get("share.fossil.PL").is_none(), "{siec}");
            said(&format!("M9 a second-unit row under {siec}"), &page, &tj, "cannot read alike");
        }
        // M10: a definition with a key the check does not apply (not_eu) while the rows hold a code to compute by it: the
        // comparison refused, not scoped out; with no such code the key is never read
        let mut keyed = transport();
        keyed.0.facts.iter_mut().filter(|(k, _)| k.starts_with("tra.")).for_each(|(_, q)| q["not_eu"] = json!("geo"));
        let kpage = share_page(&keyed.2, "next", ("FR", "share.tra.FR"), ("DE", "share.tra.DE"));
        assert_eq!(share_checks(&kpage, &keyed), (Vec::new(), Vec::new()), "no code to compute: the key is not read");
        let mut more = keyed.clone();
        more.3.extend(transport_rows("PL", Some(250.0)));
        assert!(comparison("share.tra.FR", &more.0, &more.3, &more.1).is_none());
        let koff = share_checks(&scoped_page(&more.2, "next", ("FR", "share.tra.FR"), ("DE", "share.tra.DE")), &more).0;
        assert!(koff.iter().any(|f| f.contains("cannot read alike")) && check_numbers(&scoped_page(&more.2, "next", ("FR", "share.tra.FR"), ("DE", "share.tra.DE")), &more.2, &[]).is_empty(), "M10 {koff:?}");
        // the share set
        alone("F6 no comparison word", &page.replacen(&relation_words("next")[0], "x", 1), &r);
        alone("F7 the two entries swapped", &scoped_page(&l, "next", ie, pl), &r);
        alone("F8 compared with itself", &scoped_page(&l, "next", pl, pl), &r);
        alone("F8b compared with its copy", &scoped_page(&l, "next", pl, ("PL", "comp_top")), &r);
        let mut copy = r.clone();
        copy.1.iter_mut().filter(|f| f.key == "comp_top").for_each(|f| f.v = 0.70);
        said("F8c a copy of a member holding another value", &page, &copy, "with different values");
        alone("F9 no comparison marked", &page.replacen(" data-cmp=\"next\"", "", 1), &r);
        alone("F10 an entry it does not print", &page.replacen("data-b=\"fact:share.fossil.IE\"", "data-b=\"fact:share.fossil.EL\"", 1), &r);
        let mut tied = r.clone();
        let v_pl = r.1.iter().find(|f| f.key == "share.fossil.PL").unwrap().v;
        tied.1.iter_mut().filter(|f| f.key == "share.fossil.IE").for_each(|f| f.v = v_pl);
        alone("F22 gt where the two values tie", &scoped_page(&l, "gt", pl, ie), &tied);
        alone("F23 next where the two values tie", &page, &tied);
        alone("F22b gt over two values printed alike (41% and 41%)", &scoped_page(&l, "gt", ("CZ", "share.fossil.CZ"), ("DE", "share.fossil.DE")), &r);
        alone("F24 the note's second is the third", &scoped_page(&l, "next", pl, el), &r);
        alone("F25 a share of another numerator", &scoped_page(&l, "next", pl, ("IE", "share.renewable.IE")), &r);
        // F25b-d: Ireland's fossil share once more, over another denominator, period or numerator code list
        let value = |filter: Value, table: &str, time: &str| json!({"op": "value", "table": table, "time": time, "fmt": "gwh", "filter": filter});
        let share = |a: &str, b: &str| json!({"op": "share", "a": a, "b": b});
        let list: Vec<Value> = r.0.facts.iter().find(|(k, _)| k == "sum.fossil.IE").unwrap().1["filter"]["siec"].as_array().unwrap().clone();
        let other = |r: &ShareRequest, a: Option<Value>, b: Option<Value>| {
            let mut r = r.clone();
            if let Some(a) = a {
                r = with_fact(r, "sum.fossil.IE.x", a, None);
            }
            if let Some(b) = b {
                r = with_fact(r, "total.IE.x", b, None);
            }
            let num = if r.0.facts.iter().any(|(k, _)| k == "sum.fossil.IE.x") { "sum.fossil.IE.x" } else { "sum.fossil.IE" };
            let den = if r.0.facts.iter().any(|(k, _)| k == "total.IE.x") { "total.IE.x" } else { "total.IE" };
            let r = with_fact(r, "share.fossil.IE.x", share(num, den), Some((0.5, "50")));
            assert_eq!(share_family("share.fossil.PL", &r.0), share_family("share.fossil.PL", &share_request().0));
            let html = scoped_page(&r.2, "next", pl, ("IE", "share.fossil.IE.x"));
            (html, r)
        };
        let (html, x) = other(&r, None, Some(value(json!({"geo": "IE", "siec": "TOTAL"}), "nrg_bal_c", "2024")));
        alone("F25b another denominator", &html, &x);
        let (html, x) = other(&r, Some(value(json!({"geo": "IE", "siec": list.clone()}), "nrg_bal_peh", "2023")), None);
        alone("F25c another period", &html, &x);
        let reversed: Vec<Value> = list.iter().rev().cloned().collect();
        let (html, x) = other(&r, Some(value(json!({"geo": "IE", "siec": reversed}), "nrg_bal_peh", "2024")), None);
        alone("F25d the numerator's codes in another order", &html, &x);
        let (html, x) = other(&r, Some(value(json!({"geo": "IE", "siec": list[1..].to_vec()}), "nrg_bal_peh", "2024")), None);
        alone("F25d2 the numerator one code short", &html, &x);
        alone("F26 the true max under another place's name", &page.replacen(&place(&l, "PL"), &place(&l, "IE"), 1), &r);
        alone("F26b another member's name", &page.replacen(&place(&l, "PL"), &place(&l, "SE"), 1), &r);
        let of = scoped_page(&l, "max", ie, el).replacen("data-cmp=\"max\"", "data-cmp=\"max\" data-of=\"fact:share.fossil.IE fact:share.fossil.EL\"", 1);
        alone("F27 a page-given set is not read", &of, &r);
        let cross = with_fact(r.clone(), "share.fossil.PLDE", share("sum.fossil.PL", "total.DE"), Some((0.99, "99")));
        assert_eq!(share_family("share.fossil.PL", &cross.0), share_family("share.fossil.PL", &r.0));
        alone("F28 a cross-place share as the second", &scoped_page(&cross.2, "next", pl, ("DE", "share.fossil.PLDE")), &cross);
        alone("F28b a cross-place share as the max", &scoped_page(&cross.2, "max", ("DE", "share.fossil.PLDE"), pl), &cross);
        alone("F29 nuclear, held at 12 of the 20 places", &scoped_page(&l, "next", ("FR", "share.nuclear.FR"), ("SK", "share.nuclear.SK")), &r);
        let mut one = r.clone();
        for (k, q) in r.0.facts.iter().filter(|(k, _)| k.starts_with("share.fossil.")) {
            let geo = &k["share.fossil.".len()..];
            let v = r.1.iter().find(|f| &f.key == k).unwrap().v;
            one = with_fact(one, &format!("share.one.{geo}"), share(q["b"].as_str().unwrap(), q["b"].as_str().unwrap()), Some((v, l[&format!("fact:{k}.n")].as_str())));
        }
        alone("F30 a share of numerator equal to its denominator", &scoped_page(&one.2, "next", ("PL", "share.one.PL"), ("IE", "share.one.IE")), &one);
        // F31: shares by place and by unit at once (no rows: no scope); the same page over the one unit's shares passes
        let mut two = (Spec { facts: Vec::new(), fmts: json!({}), members: None }, Vec::new(), l.clone(), Vec::new());
        for (geo, unit, v, text) in [("PL", "U1", 0.6, "60"), ("IE", "U1", 0.5, "50"), ("PL", "U2", 0.4, "40"), ("IE", "U2", 0.3, "30")] {
            two = with_fact(two, &format!("n.{geo}.{unit}"), value(json!({"geo": geo, "unit": unit, "siec": ["A", "B"]}), "t", "2024"), None);
            two = with_fact(two, &format!("d.{geo}.{unit}"), value(json!({"geo": geo, "unit": unit, "siec": "TOTAL"}), "t", "2024"), None);
            two = with_fact(two, &format!("s.{geo}.{unit}"), share(&format!("n.{geo}.{unit}"), &format!("d.{geo}.{unit}")), Some((v, text)));
        }
        let gt = share_page(&two.2, "gt", ("PL", "s.PL.U1"), ("IE", "s.IE.U1"));
        alone("F31 two dimensions each give a set", &gt, &two);
        let mut u1 = two.clone();
        u1.0.facts.retain(|(k, _)| !k.ends_with("U2"));
        assert_eq!(share_checks(&gt, &u1), (Vec::new(), Vec::new()));
        // M3: a set over every code of the rows (transport) saying the scope
        let t = transport();
        said("M3 the phrase over the full set", &scoped_page(&t.2, "next", ("FR", "share.tra.FR"), ("DE", "share.tra.DE")), &t, "its words say");
    }

    /// A value family by fuel (siec) of one sector's rows: A 50, B 30, C 20, and D's rows as given (another sector's rows
    /// only, in the reviewer's fixture); fact v.<code> for A, B, C; English test names.
    fn value_family(d: &[(&str, f64)]) -> ClaimRequest {
        let mut rows: Vec<Row> = [("A", 50.0), ("B", 30.0), ("C", 20.0)].iter().map(|(c, v)| row_at("t", &[("nrg_bal", "N1"), ("siec", c)], *v)).collect();
        rows.extend(d.iter().map(|(bal, v)| row_at("t", &[("nrg_bal", bal), ("siec", "D")], *v)));
        let defs: Vec<(String, Value)> = ["A", "B", "C"].map(|c| (format!("v.{c}"), json!({"op": "value", "table": "t", "time": "2024", "fmt": "n", "filter": {"siec": c}}))).into();
        let names: [(&str, &str); 4] = [("A", "Alpha"), ("B", "Beta"), ("C", "Gamma"), ("D", "Delta")];
        claim_request("t", rows, defs, json!({"time": {}}), &[("siec", &names)], ("name:unit_short_zh:N", "n"))
    }

    /// A value note: `lead`, then A's name and value and the max word (data-cmp max).
    fn value_note(l: &BTreeMap<String, String>, lead: &str) -> String {
        format!(
            "<!doctype html><html><body><h1>Fuels</h1><svg><g data-notes=\"v\"><text data-cmp=\"max\" data-a=\"fact:v.A.n\">{lead}{} {}\u{ff0c}{}</text></g></svg></body></html>",
            nm(l, "tspan", "siec", "A"),
            nv(l, "tspan", "v.A", ".n"),
            relation_words("max")[0]
        )
    }

    /// A claim title on A (a value fact) or on A's row, `lead` before it.
    fn value_claim(l: &BTreeMap<String, String>, a: &str, lead: &str) -> String {
        format!("<!doctype html><html><body><h1>{}</h1></body></html>", cl(a, &format!("{lead}{}{}", nm(l, "span", "siec", "A"), claim_list("max")[0])))
    }

    /// P5 and M7: a value family's set and the scope rule. A code of the rows the family's definition computes is compared
    /// (above A refuses, the phrase never helps; below A passes without the phrase); a code with rows under another sector
    /// only is not computed, so the set is scoped and a statement over it says the phrase, in a note and in a claim title;
    /// a claim on a request row (its set every row) never does.
    #[test]
    fn a_value_family_is_compared_over_the_codes_its_rows_compute_and_says_its_scope() {
        let lead = format!("{}\u{ff0c}", scope());
        let checks = |html: &str, (spec, rows, facts, ledger): &ClaimRequest| {
            let mut off = check_relations(html, ledger, spec, facts, rows);
            off.extend(check_claims(html, ledger, spec, facts, rows));
            assert!(check_numbers(html, ledger, &[]).is_empty(), "{html}");
            off
        };
        let below = value_family(&[("N1", 10.0)]);
        assert_eq!(comparison("v.A", &below.0, &below.1, &below.2).map(|(m, s)| (m.len(), s)), Some((4, false)));
        assert_eq!(checks(&value_note(&below.3, ""), &below), Vec::<String>::new(), "P5 a computed code below");
        assert!(checks(&value_note(&below.3, &lead), &below).iter().any(|f| f.contains("its words say")), "M3 the phrase over the full set");
        let higher = value_family(&[("N1", 60.0)]);
        assert!(checks(&value_note(&higher.3, ""), &higher).iter().any(|f| f.contains("does not hold")), "P5 a computed code above");
        assert!(checks(&value_note(&higher.3, &lead), &higher).iter().any(|f| f.contains("does not hold")), "P5 the phrase does not help");
        // the reviewer's fixture: D's rows under another sector only
        let other = value_family(&[("N2", 60.0)]);
        assert_eq!(comparison("v.A", &other.0, &other.1, &other.2).map(|(m, s)| (m.len(), s)), Some((3, true)));
        assert!(checks(&value_note(&other.3, ""), &other).iter().any(|f| f.contains("do not say")), "a scoped value note, no phrase");
        assert_eq!(checks(&value_note(&other.3, &lead), &other), Vec::<String>::new(), "a scoped value note with the phrase");
        // M9b: D's rows under the family's sector and another: never summed in; the note and the claim refused
        let both = value_family(&[("N1", 10.0), ("N2", 60.0)]);
        assert!(comparison("v.A", &both.0, &both.1, &both.2).is_none());
        assert!(checks(&value_note(&both.3, ""), &both).iter().any(|f| f.contains("cannot read alike")), "M9b a note");
        assert!(checks(&value_claim(&both.3, "fact:v.A", ""), &both).iter().any(|f| f.contains("cannot read alike")), "M9b a claim");
        // M7: claim titles
        assert_eq!(checks(&value_claim(&below.3, "fact:v.A", ""), &below), Vec::<String>::new(), "a value claim over the full set");
        assert!(checks(&value_claim(&other.3, "fact:v.A", ""), &other).iter().any(|f| f.contains("(C9)")), "M7 a scoped value claim, no phrase");
        assert_eq!(checks(&value_claim(&other.3, "fact:v.A", &lead), &other), Vec::<String>::new(), "a scoped value claim with the phrase");
        let a_row = below.1.iter().find(|x| x.dims["siec"] == "A").unwrap().src.clone();
        assert_eq!(checks(&value_claim(&below.3, &a_row, ""), &below), Vec::<String>::new(), "a row claim");
        assert!(checks(&value_claim(&below.3, &a_row, &lead), &below).iter().any(|f| f.contains("(C9)")), "M7 a row claim saying the scope");
        // q2 (P2): every flow set over every code of its rows, no phrase
        let q2 = claim_q2();
        for k in ["from.O4000XBIO", "to.FC_OTH_HH_E"] {
            assert!(!comparison(k, &q2.0, &q2.1, &q2.2).unwrap().1, "{k}");
        }
    }

    /// The comparisons a stored request hands the leaf (run with --ignored; P5_REQUEST a request.json), as one JSON line.
    #[test]
    #[ignore]
    fn comparisons_of_a_stored_request() {
        let req: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("P5_REQUEST").unwrap()).unwrap()).unwrap();
        let spec: Spec = serde_json::from_value(req["spec"].clone()).unwrap();
        let facts: Vec<Fact> = serde_json::from_value(req["facts"].clone()).unwrap();
        let rows: Vec<Row> = req["rows"].as_array().into_iter().flatten().filter_map(|r| serde_json::from_value(r.clone()).ok()).collect();
        println!("COMPARISONS {}", comparisons(&spec, &rows, &facts));
    }

    // ---- claim_holds (B11): a number-free title's claim over a set the check derives; the dek's numbers at the display part

    const Q2_FUELS: [(&str, &str); 8] = [
        ("O4000XBIO", "石油"),
        ("G3000", "天然气"),
        ("E7000", "电力"),
        ("RA000", "可再生能源"),
        ("H8000", "热力"),
        ("C0000X0350-0370", "固体燃料"),
        ("C0350-0370", "人造气"),
        ("W6100_6220", "不可再生废物"),
    ];
    const Q2_SECTORS: [(&str, &str); 7] = [
        ("FC_IND_E", "工业"),
        ("FC_TRA_E", "交通运输"),
        ("FC_OTH_CP_E", "商业公服"),
        ("FC_OTH_HH_E", "家庭"),
        ("FC_OTH_AF_E", "农林业"),
        ("FC_OTH_FISH_E", "渔业"),
        ("FC_OTH_NSP_E", "其他未列明"),
    ];

    /// A claim request: its spec, rows, the facts next_facts computes from them, and the ledger leaf_ledger writes (the
    /// display part with it) with the name rows.
    type ClaimRequest = (Spec, Vec<Row>, Vec<Fact>, BTreeMap<String, String>);

    fn claim_request(table: &str, rows: Vec<Row>, defs: Vec<(String, Value)>, fmts: Value, names: &[(&str, &[(&str, &str)])], unit: (&str, &str)) -> ClaimRequest {
        let spec = Spec { facts: defs, fmts, members: None };
        let facts = crate::next_facts::compute(&spec, &rows).unwrap();
        let mut ledger = crate::next_facts::leaf_ledger(&spec, &rows, &facts).unwrap();
        for (dim, list) in names {
            ledger.extend(list.iter().map(|(c, n)| (format!("name:zh_names:{dim}:{c}"), n.to_string())));
        }
        ledger.insert(unit.0.into(), unit.1.into());
        assert!(rows.iter().all(|r| r.table == table));
        (spec, rows, facts, ledger)
    }

    /// q2's flow request (Eurostat nrg_bal_s, DE 2024, KTOE: the data_prepare fixture's rows of each fuel to each sector),
    /// its node facts with a merged node per side, the format of two places the run gives it.
    fn claim_q2() -> ClaimRequest {
        claim_q2_with(0.0)
    }

    /// q2 with `more` added to gas to households (its row read so; every fact and entry computed from the rows again).
    fn claim_q2_with(more: f64) -> ClaimRequest {
        let fixture = include_str!("../scripts/fixtures/data_prepare/nrg_bal_s_DE_2024.tsv");
        let rows: Vec<Row> = fixture
            .lines()
            .filter(|l| !l.starts_with('#'))
            .skip(1)
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                (Q2_SECTORS.iter().any(|(c, _)| *c == f[0]) && Q2_FUELS.iter().any(|(c, _)| *c == f[1])).then(|| Row {
                    src: format!("series:nrg_bal_s/A.{}.{}.KTOE.DE:2024:OBS_VALUE", f[0], f[1]),
                    table: "nrg_bal_s".into(),
                    dims: [("freq", "A"), ("nrg_bal", f[0]), ("siec", f[1]), ("unit", "KTOE"), ("geo", "DE")].map(|(d, c)| (d.to_string(), c.to_string())).into(),
                    time: "2024".into(),
                    value: f[2].parse::<f64>().unwrap() + if (f[0], f[1]) == ("FC_OTH_HH_E", "G3000") { more } else { 0.0 },
                })
            })
            .collect();
        let q = |dim: &str, code: Value| json!({"op": "value", "table": "nrg_bal_s", "time": "2024", "fmt": "ktoe", "filter": {dim: code}});
        let mut defs: Vec<(String, Value)> = ["E7000", "G3000", "H8000", "O4000XBIO", "RA000"].map(|c| (format!("from.{c}"), q("siec", json!(c)))).into();
        defs.push(("from_other".into(), q("siec", json!(["C0000X0350-0370", "C0350-0370", "W6100_6220"]))));
        defs.extend(["FC_IND_E", "FC_OTH_CP_E", "FC_OTH_HH_E", "FC_TRA_E"].map(|c| (format!("to.{c}"), q("nrg_bal", json!(c)))));
        defs.push(("to_other".into(), q("nrg_bal", json!(["FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"]))));
        let fmts = json!({"ktoe": {"dec": 2, "scale": 1, "suffix": " 千吨油当量"}, "time": {}});
        claim_request("nrg_bal_s", rows, defs, fmts, &[("siec", &Q2_FUELS), ("nrg_bal", &Q2_SECTORS)], ("name:unit_short_zh:KTOE", "千吨油当量"))
    }

    /// Another data shape (test-only numbers): fuel groups to three countries, GWH in whole numbers (no display part), no
    /// merged node.
    fn claim_gen() -> ClaimRequest {
        let cells = [
            ("fossil", "DE", 200000.0),
            ("fossil", "FR", 40000.0),
            ("fossil", "ES", 60000.0),
            ("nuclear", "DE", 0.0),
            ("nuclear", "FR", 320000.0),
            ("nuclear", "ES", 50000.0),
            ("renewable", "DE", 280000.0),
            ("renewable", "FR", 140000.0),
            ("renewable", "ES", 160000.0),
            ("other", "DE", 20000.0),
            ("other", "FR", 10000.0),
            ("other", "ES", 8000.0),
        ];
        let rows = cells
            .map(|(g, c, v)| Row {
                src: format!("series:gen/{g}.{c}:2024:OBS_VALUE"),
                table: "gen".into(),
                dims: [("siec_group", g), ("geo", c)].map(|(d, c)| (d.to_string(), c.to_string())).into(),
                time: "2024".into(),
                value: v,
            })
            .into();
        let q = |dim: &str, code: &str| json!({"op": "value", "table": "gen", "time": "2024", "fmt": "gwh", "filter": {dim: code}});
        let groups = [("fossil", "化石能源"), ("nuclear", "核能"), ("renewable", "可再生能源"), ("other", "其他能源")];
        let geos = [("DE", "德国"), ("FR", "法国"), ("ES", "西班牙")];
        let defs = groups.iter().map(|(g, _)| (format!("n.{g}"), q("siec_group", g))).chain(geos.iter().map(|(c, _)| (format!("n.{c}"), q("geo", c)))).collect();
        let fmts = json!({"gwh": {"dec": 0, "scale": 1, "suffix": " 吉瓦时"}, "time": {}});
        claim_request("gen", rows, defs, fmts, &[("siec_group", &groups), ("iso2", &geos)], ("name:unit_short_zh:GWH", "吉瓦时"))
    }

    /// The two largest nodes of each side and the unit of a flow page, as (name dim, code, fact key).
    struct Sides {
        a: [(&'static str, &'static str, &'static str); 2],
        b: [(&'static str, &'static str, &'static str); 2],
        unit: &'static str,
    }

    const Q2_SIDES: Sides = Sides {
        a: [("siec", "O4000XBIO", "from.O4000XBIO"), ("siec", "G3000", "from.G3000")],
        b: [("nrg_bal", "FC_OTH_HH_E", "to.FC_OTH_HH_E"), ("nrg_bal", "FC_TRA_E", "to.FC_TRA_E")],
        unit: "name:unit_short_zh:KTOE",
    };
    const GEN_SIDES: Sides = Sides {
        a: [("siec_group", "renewable", "n.renewable"), ("siec_group", "nuclear", "n.nuclear")],
        b: [("iso2", "FR", "n.FR"), ("iso2", "DE", "n.DE")],
        unit: "name:unit_short_zh:GWH",
    };

    /// A name as the leaf marks it by its name row (`tag` span or tspan).
    fn nm(l: &BTreeMap<String, String>, tag: &str, dim: &str, code: &str) -> String {
        let src = format!("name:zh_names:{dim}:{code}");
        format!("<{tag} data-src=\"{src}\">{}</{tag}>", l[&src])
    }

    /// A fact's number at `part` (".r", ".n"), bold, as the leaf prints it.
    fn nv(l: &BTreeMap<String, String>, tag: &str, key: &str, part: &str) -> String {
        let src = format!("fact:{key}{part}");
        let (b, e) = if tag == "span" { ("<b class=\"n\">", "</b>") } else { ("<tspan font-weight=\"700\">", "</tspan>") };
        format!("{b}<{tag} data-src=\"{src}\">{}</{tag}>{e}", l[&src])
    }

    /// The flow page as the B11 leaf draws it: `h1` (a claim span, or None: the finding's headline at `part`), the dek (with
    /// a claim: the finding with its second, at `part`; else words), the accent on the first source, a note per side.
    fn claim_page(l: &BTreeMap<String, String>, s: &Sides, part: &str, h1: Option<String>, kicker: &str) -> String {
        let above = relation_words("next")[0].clone();
        let unit = format!("<span data-src=\"{}\">{}</span>", s.unit, l[s.unit]);
        let [(da, ca, ka), (db, cb, kb)] = s.a;
        let head = format!("{} {} {unit}\u{ff0c}{above}", nm(l, "span", da, ca), nv(l, "span", ka, part));
        let (h1, dek) = match h1 {
            Some(claim) => (
                claim,
                format!(
                    "<span data-cmp=\"next\" data-a=\"fact:{ka}{part}\" data-b=\"fact:{kb}{part}\">{head}\u{ff08}{} {}\u{ff09}</span>",
                    nm(l, "span", db, cb),
                    nv(l, "span", kb, part)
                ),
            ),
            None => (format!("<span data-cmp=\"max\" data-a=\"fact:{ka}{part}\">{head}</span>"), "words of the text step".to_string()),
        };
        let note = |side: &[(&str, &str, &str); 2]| {
            let [(d1, c1, k1), (d2, c2, k2)] = *side;
            format!(
                "<text x=\"1\" y=\"546.0\" data-cmp=\"next\" data-a=\"fact:{k1}{part}\" data-b=\"fact:{k2}{part}\">{} {}\u{ff0c}{above}\u{ff08}{} {}\u{ff09}</text>",
                nm(l, "tspan", d1, c1),
                nv(l, "tspan", k1, part),
                nm(l, "tspan", d2, c2),
                nv(l, "tspan", k2, part)
            )
        };
        format!(
            "<!doctype html><html><body><header class=\"hh wide\"><div><div class=\"kicker\">{kicker}</div><h1>{h1}</h1><p class=\"dek\">{dek}</p></div></header>\
             <svg><g data-layer=\"sankey\"><rect x=\"1\" y=\"54\" width=\"14\" height=\"140\" fill=\"var(--accent)\" data-code=\"{ca}\"/>\
             <rect x=\"1\" y=\"204\" width=\"14\" height=\"103\" fill=\"var(--t-sec)\" data-code=\"{cb}\"/>\
             <g data-notes=\"finding\">{}{}</g></g></svg><script>{READY_JS}</script></body></html>",
            note(&s.a),
            note(&s.b)
        )
    }

    /// A claim h1's span.
    fn cl(a: &str, inner: &str) -> String {
        format!("<span data-claim=\"max\" data-a=\"{a}\">{inner}</span>")
    }

    /// Every check a leaf page meets (check_leaf_page's, but the placeholders and months), each with its findings.
    fn all_checks(html: &str, (spec, rows, facts, ledger): &ClaimRequest) -> BTreeMap<&'static str, Vec<String>> {
        BTreeMap::from([
            ("numbers", check_numbers(html, ledger, &[])),
            ("recheck", crate::next_facts::recheck(ledger, spec, rows, facts)),
            ("relations", check_relations(html, ledger, spec, facts, rows)),
            ("claims", check_claims(html, ledger, spec, facts, rows)),
            ("accent", check_accent_named(html)),
        ])
    }

    /// The request with no display part in its ledger (a core before B11).
    fn without_display((spec, rows, facts, ledger): &ClaimRequest) -> ClaimRequest {
        let ledger = ledger.iter().filter(|(k, _)| !(k.starts_with("fact:") && k.ends_with(".r"))).map(|(k, v)| (k.clone(), v.clone())).collect();
        (spec.clone(), rows.clone(), facts.clone(), ledger)
    }

    /// The seven pages of the B11 prototype, each as the B11 leaf draws it (display part; a claim h1 where its title holds
    /// one) and as today's leaf draws it (no display part, the finding's headline): 14 pages, every check passes.
    fn claim_cases() -> Vec<(&'static str, &'static str, Option<String>, &'static str)> {
        let (q, g) = (claim_q2().3, claim_gen().3);
        let oil = nm(&q, "span", "siec", "O4000XBIO");
        vec![
            ("q2-opus", "q2", None, "德国能源：石油产品最大一股流向交通"),
            ("q2-sonnet", "q2", None, "德国能源从来源流向各部门"),
            ("q2-node", "q2", Some(cl("fact:from.O4000XBIO", &format!("{oil}是德国最大的能源来源"))), "德国能源从来源到各部门"),
            (
                "q2-flow",
                "q2",
                Some(cl(
                    "series:nrg_bal_s/A.FC_TRA_E.O4000XBIO.KTOE.DE:2024:OBS_VALUE",
                    &format!("{oil}流向{}是最大的一股能源流", nm(&q, "span", "nrg_bal", "FC_TRA_E")),
                )),
                "德国能源从来源到各部门",
            ),
            ("q2-dest", "q2", Some(cl("fact:to.FC_OTH_HH_E", &format!("{}是德国用能最多的部门", nm(&q, "span", "nrg_bal", "FC_OTH_HH_E")))), "德国能源从来源到各部门"),
            ("gen-node", "gen", Some(cl("fact:n.renewable", &format!("{}是发电大国最大的电源", nm(&g, "span", "siec_group", "renewable")))), "发电流向"),
            ("gen-label", "gen", None, "欧盟发电大国的能源构成"),
        ]
    }

    fn proto_page(case: &str) -> (String, ClaimRequest) {
        let (_, shape, h1, kicker) = claim_cases().into_iter().find(|c| c.0 == case).unwrap();
        let (req, sides, part) = if shape == "q2" { (claim_q2(), &Q2_SIDES, ".r") } else { (claim_gen(), &GEN_SIDES, ".n") };
        (claim_page(&req.3, sides, part, h1, kicker), req)
    }

    #[test]
    fn claim_pages_pass_every_check_as_the_b11_leaf_and_as_todays_leaf_draw_them() {
        let mut passed = 0;
        for (case, shape, h1, kicker) in claim_cases() {
            let (req, sides) = if shape == "q2" { (claim_q2(), &Q2_SIDES) } else { (claim_gen(), &GEN_SIDES) };
            let part = if shape == "q2" { ".r" } else { ".n" };
            let proto = claim_page(&req.3, sides, part, h1.clone(), kicker);
            assert_eq!(proto.contains("data-claim="), h1.is_some(), "{case}");
            let base_req = without_display(&req);
            let base = claim_page(&base_req.3, sides, ".n", None, kicker);
            for (which, html, r) in [("proto", &proto, &req), ("base", &base, &base_req)] {
                let hits: Vec<_> = all_checks(html, r).into_iter().filter(|(_, v)| !v.is_empty()).collect();
                assert!(hits.is_empty(), "{case} {which}: {hits:?}");
                passed += 1;
            }
        }
        assert_eq!(passed, 14);
        // the display part is in the q2 ledger (two places held, three significant digits shown), not in gen's (no places)
        let (q, g) = (claim_q2().3, claim_gen().3);
        assert_eq!((q["fact:from.O4000XBIO.n"].as_str(), q["fact:from.O4000XBIO.r"].as_str()), ("60,699.06", "60,699"));
        assert_eq!(q["fact:from.G3000.r"], "45,028");
        assert!(!g.keys().any(|k| k.ends_with(".r")));
        let spec = claim_q2().0;
        assert_eq!(fact_key("fact:from.G3000.r", &spec), Some("from.G3000"));
    }

    /// The 27 must-fail tampers of the B11 prototype. A tamper marked `new` passes every check a page met before B11
    /// (numbers, recheck, relations; the accent's scope was an h1 with data-cmp) and only check_claims refuses it; the rest
    /// are refused by the check named.
    #[test]
    fn claim_tampers_are_refused_and_the_claim_ones_by_check_claims_alone() {
        let (node, req) = proto_page("q2-node");
        let (flow, _) = proto_page("q2-flow");
        let (gen, greq) = proto_page("gen-node");
        let l = &req.3;
        let h1 = |html: &str| html[html.find("<h1>").unwrap()..html.find("</h1>").unwrap() + 5].to_string();
        let with_h1 = |html: &str, inner: &str| html.replacen(&h1(html), &format!("<h1>{inner}</h1>"), 1);
        let n = |dim: &str, code: &str| nm(l, "span", dim, code);
        let (oil, gas, hh, ind, heat) = (n("siec", "O4000XBIO"), n("siec", "G3000"), n("nrg_bal", "FC_OTH_HH_E"), n("nrg_bal", "FC_IND_E"), n("siec", "H8000"));
        let oil_k = "fact:from.O4000XBIO";
        let node_h1 = |inner: String| with_h1(&node, &cl(oil_k, &inner));
        let row = |bal: &str, siec: &str| format!("series:nrg_bal_s/A.{bal}.{siec}.KTOE.DE:2024:OBS_VALUE");
        let g45 = "<span data-src=\"fact:from.G3000.r\">45,028</span>";
        let bent = |key: &str, text: &str| {
            let mut r = req.clone();
            r.3.insert(key.into(), text.into());
            r
        };
        let alike = claim_q2_with(15670.5);
        let alike_page = |part: &str| claim_page(&alike.3, &Q2_SIDES, part, Some(cl(oil_k, &format!("{oil}是德国最大的能源来源"))), "kicker");
        // (id, page, request, refused by: "new" check_claims alone, or the one check named)
        let cases: Vec<(&str, String, ClaimRequest, &str)> = vec![
            ("F1 a digit in the title", node_h1(format!("{oil}是德国2024年最大的能源来源")), req.clone(), "numbers"),
            ("F1b a number entry in the title", node_h1(format!("{oil}是最大的能源来源，达<span data-src=\"fact:from.O4000XBIO.r\">60,699</span>")), req.clone(), "new"),
            ("F2 a non-subject in plain words", node_h1(format!("{oil}和天然气是最大的能源来源")), req.clone(), "new"),
            ("F2b a non-subject by its row", node_h1(format!("{oil}领先{gas}，是最大的能源来源")), req.clone(), "new"),
            ("F2c a non-subject by two characters", node_h1(format!("{oil}是交通最大的能源来源")), req.clone(), "new"),
            ("F2d the subject in plain words only", node_h1("石油是德国最大的能源来源".into()), req.clone(), "new"),
            ("F3 false: gas the largest source", with_h1(&node, &cl("fact:from.G3000", &format!("{gas}是德国最大的能源来源"))), req.clone(), "new"),
            ("F3b false: industry the largest user", with_h1(&node, &cl("fact:to.FC_IND_E", &format!("{ind}是德国用能最多的部门"))), req.clone(), "new"),
            ("F3c false: oil to households the largest flow", with_h1(&flow, &cl(&row("FC_OTH_HH_E", "O4000XBIO"), &format!("{oil}流向{hh}是最大的一股能源流"))), req.clone(), "new"),
            ("F4 the wrong set: households' column", with_h1(&flow, &cl(&row("FC_OTH_HH_E", "G3000"), &format!("{gas}流向{hh}是最大的一股能源流"))), req.clone(), "new"),
            (
                "F4b a page-given set is not read",
                with_h1(&node, &format!("<span data-claim=\"max\" data-a=\"fact:from.G3000\" data-of=\"fact:from.G3000 fact:from.E7000\" data-scope=\"side\">{gas}是最大的能源来源</span>")),
                req.clone(),
                "new",
            ),
            ("F4c the merged node", with_h1(&node, &cl("fact:from_other", "其他来源是最大的能源来源")), req.clone(), "new"),
            ("F4d another side's name over oil's fact", node_h1(format!("{hh}是最大的能源来源")), req.clone(), "new"),
            ("F5 a dek number not in the ledger", node.replacen(g45, "<span data-src=\"fact:from.G3000.r0\">45,028</span>", 1), req.clone(), "numbers"),
            ("F5b a dek number changed", node.replacen(g45, "<span data-src=\"fact:from.G3000.r\">46,028</span>", 1), req.clone(), "numbers"),
            ("F5c a dek number unmarked", node.replacen(g45, "45,028", 1), req.clone(), "numbers"),
            (
                "F5d the display part made up (printed as entered)",
                // the dek's span and the note's tspan alike
                node.replace("data-src=\"fact:from.G3000.r\">45,028<", "data-src=\"fact:from.G3000.r\">45,000<"),
                bent("fact:from.G3000.r", "45,000"),
                "recheck",
            ),
            // gas 15,670.5 higher on one row: 60,698.74 below oil's 60,699.06, both 60,699 at the display part the page prints
            ("F5e two numbers alike at the display part", alike_page(".r"), alike.clone(), "relations"),
            ("F6 no max word", node_h1(format!("{oil}是德国的主要能源来源")), req.clone(), "new"),
            ("F7 a negation", node_h1(format!("{oil}不是德国最大的能源来源")), req.clone(), "new"),
            ("F7b a trend", node_h1(format!("{oil}是最大的能源来源，但在下降")), req.clone(), "new"),
            ("F7c second place", node_h1(format!("{oil}是第二大的能源来源，仅次于最大的一种")), req.clone(), "new"),
            ("F8 the claim is not the whole h1", with_h1(&node, &format!("据估计 {}", cl(oil_k, &format!("{oil}是最大的能源来源")))), req.clone(), "new"),
            ("F9 a relation other than max", with_h1(&node, &format!("<span data-claim=\"min\" data-a=\"fact:from.H8000\">{heat}是最大的来源</span>")), req.clone(), "new"),
            (
                "F10 the accent on a code the claim h1 and the dek do not name",
                node.replacen("fill=\"var(--accent)\" data-code=\"O4000XBIO\"", "fill=\"var(--accent)\" data-code=\"FC_TRA_E\"", 1),
                req.clone(),
                "accent",
            ),
            (
                "F11 gen: false, fossil the largest",
                with_h1(&gen, &cl("fact:n.fossil", &format!("{}是发电大国最大的电源", nm(&greq.3, "span", "siec_group", "fossil")))),
                greq.clone(),
                "new",
            ),
            (
                "F12 gen: a country in plain words under a fuel's claim",
                with_h1(&gen, &cl("fact:n.renewable", &format!("{}是德国最大的电源", nm(&greq.3, "span", "siec_group", "renewable")))),
                greq.clone(),
                "new",
            ),
        ];
        assert_eq!(cases.len(), 27);
        for (id, html, r, by) in &cases {
            let got = all_checks(html, r);
            let hit = |k: &str| !got[k].is_empty();
            match *by {
                // before B11: no digit, number entry, recomputed entry or relation refuses it (the accent's scope then: an
                // h1 with data-cmp, which these h1s have none of); check_claims does
                "new" => {
                    assert!(!hit("numbers") && !hit("recheck") && !hit("relations"), "{id}: an existing check refuses it: {got:?}");
                    assert!(hit("claims"), "{id}: check_claims passed it");
                }
                check => assert!(hit(check), "{id}: {check} passed it: {got:?}"),
            }
        }
        // F5d, F5e and F10 are each caught by the B11 change alone: the display part's recheck arm, the comparison at the
        // printed part, the accent's scope widened to a claim h1
        let f = |id: &str| cases.iter().find(|c| c.0.starts_with(id)).unwrap();
        let (_, html, r, _) = f("F5d");
        assert!(check_numbers(html, &r.3, &[]).is_empty());
        let (_, html, r, _) = f("F5e");
        assert_eq!((alike.3["fact:from.G3000.n"].as_str(), alike.3["fact:from.G3000.r"].as_str()), ("60,698.74", "60,699"));
        let others: Vec<_> = all_checks(html, r).into_iter().filter(|(k, v)| *k != "relations" && !v.is_empty()).collect();
        assert!(others.is_empty(), "F5e: {others:?}");
        // the same page printing .n holds (the values and their .n texts differ): what refuses is the comparison at the part
        // the page prints
        assert_eq!(check_relations(&alike_page(".n"), &alike.3, &alike.0, &alike.2, &alike.1), Vec::<String>::new());
        let (_, html, _, _) = f("F10");
        assert!(!h1(html).contains("data-cmp=") && check_claims(html, &req.3, &req.0, &req.2, &req.1).is_empty());
    }

    /// CLAIM_WORDS goes to the leaf as three lists; the check reads max and off, the verb list is the leaf's alone.
    #[test]
    fn claim_words_go_to_the_leaf_as_three_lists() {
        let w = claim_words();
        assert_eq!(w.as_object().unwrap().keys().collect::<Vec<_>>(), ["max", "off", "verb"]);
        assert!(w["max"].as_array().unwrap().iter().any(|x| x == "最大") && w["off"].as_array().unwrap().iter().any(|x| x == "不"));
        let (node, req) = proto_page("q2-node");
        let title = "<span data-src=\"name:zh_names:siec:O4000XBIO\">石油</span>是德国最大的能源来源";
        assert!(node.contains(title));
        // no verb of a conclusion: the check does not read the verb list (the leaf does, and falls back before it)
        let no_verb = node.replacen(title, "<span data-src=\"name:zh_names:siec:O4000XBIO\">石油</span>最大", 1);
        assert_eq!(check_claims(&no_verb, &req.3, &req.0, &req.2, &req.1), Vec::<String>::new());
    }
}
