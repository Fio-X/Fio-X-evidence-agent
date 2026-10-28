//! New route, visual group: the number path every node prints through. A number goes on the page only through
//! `Ledger::num`, which marks its element with where the number was read (`data-src`) and enters it in the ledger;
//! `check_numbers` reads the written page back and fails any digit that is neither inside an element printing its ledger
//! entry as entered nor a table id the page names. Dates and years are numbers too: they go through the ledger with their
//! data row, and the check exempts no digit. A name whose digits are part of it (G20, EU27, PM2.5) is a ledger entry too:
//! `Ledger::label` marks it with the code-list or name row it was read from, and the page must print that row's text
//! exactly. Pure: it holds no state and writes nothing.

use std::collections::BTreeMap;

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
fn prints(text: &str, value: f64) -> bool {
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
            rest = comment.find("-->").map_or("", |e| &comment[e + 3..]);
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
}
