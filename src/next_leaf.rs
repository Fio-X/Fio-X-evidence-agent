//! New route, visual group: the bridge to the second layer's leaf nodes (plans design-1028-node-contract). One child per panel
//! (a Node or a Python script, `Runner`); each layer is one JSON line in and one line out. Layers that reserve room are asked
//! first (`"phase": "reserve"`), in order, for the boxes and lines they will need; then every layer draws, bottom first, so a
//! layer sees the frame the base fixed, every box and line the layers under it took and every reservation. The child gets a
//! cleared environment (PATH, HOME, LANG only) and a deadline per layer. An SVG reply is taken only when every text it printed
//! has a `data-src`, a position, lies inside the panel, and touches no text or line of another layer, and it dropped nothing;
//! an HTML reply (text laid out in the browser) has no boxes here and is checked in the browser. The page's number check
//! (next_ledger::check_numbers) runs on the page as before. Each call leaves one record (node, layer, milliseconds, outcome)
//! for the caller's program event.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::ops::Range;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::next_facts::{recheck, Fact, Row, Spec, PERIOD_SRC};
use crate::next_ledger::{
    check_numbers, comment_len, tag_end, tag_parts, unescape, READ_ATTRS, VOID,
};
use crate::next_nodes::{tw, Bx, Kind, Knob, NodeInfo, Val};

/// How long one layer may take before the child is stopped and the layer refused.
pub const LAYER_DEADLINE: Duration = Duration::from_secs(2);

/// How long one bake (Chrome started, the page laid out, its DOM read back) may take before the child is stopped.
pub const BAKE_DEADLINE: Duration = Duration::from_secs(20);

/// Line points closer to a text box than this (px) count as the text sitting on the line.
const LINE_PAD: f64 = 1.0;

/// The first layer samples every line a leaf returns at this step (px) itself, so a leaf's own sampling cannot hide a crossing.
const LINE_STEP: f64 = 4.0;

/// The points of a polyline every LINE_STEP px along each segment, its vertices included.
fn sampled(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = pts.first().copied().into_iter().collect();
    for pair in pts.windows(2) {
        let ((x0, y0), (x1, y1)) = (pair[0], pair[1]);
        let n = ((x1 - x0).hypot(y1 - y0) / LINE_STEP).ceil().max(1.0) as usize;
        out.extend((1..=n).map(|i| {
            let f = i as f64 / n as f64;
            (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
        }));
    }
    out
}

/// How a panel's child is started: the program and its arguments.
#[derive(Clone, Debug, PartialEq)]
pub struct Runner {
    pub program: String,
    pub args: Vec<String>,
}

impl Runner {
    /// `node <script>`.
    pub fn node(script: &Path) -> Runner {
        Runner {
            program: "node".into(),
            args: vec![script.display().to_string()],
        }
    }

    /// `python3 -I -B <script>`: no user site, no PYTHON* variables, the script's folder not on the path unless it puts it
    /// there, and no __pycache__ written beside the leaves.
    pub fn python(script: &Path) -> Runner {
        Runner {
            program: "python3".into(),
            args: vec!["-I".into(), "-B".into(), script.display().to_string()],
        }
    }
}

/// One layer to draw: a registered leaf node under its layer name, with its rows (long table, every printed value as
/// {src, text}) and its knobs already checked against the registry; `reserve` when the registry says it claims room first.
/// The fields are private so that only `Layer::registered` builds one.
pub struct Layer<'a> {
    node: &'a str,
    layer: &'a str,
    rows: Value,
    knobs: Value,
    reserve: bool,
}

/// The leaf registry, as the second layer writes it from the prototype's knobs (runtime/leaves_py/knobs.py): each leaf
/// node with its knobs and whether it reserves room before the others draw, and the nodes that still read a knob from an
/// older page key of the same name, each with the path in the hero where it reads them ([] the hero, ["data"] hero.data).
pub struct Leaves {
    pub nodes: BTreeMap<String, Leaf>,
    pub legacy: Vec<(String, Vec<String>)>,
}

pub struct Leaf {
    pub info: &'static NodeInfo,
    pub reserve: bool,
}

const LEAVES: &str = include_str!("../runtime/leaves_py/knobs.json");

/// The registry, read once; the table is checked in, so a malformed one fails the first test, not a run.
pub fn leaves() -> &'static Leaves {
    static TABLE: OnceLock<Leaves> = OnceLock::new();
    // NodeInfo keeps 'static names, as the Rust-drawn nodes have; the table is read once, so leaking it is bounded.
    fn word(s: &Value) -> &'static str {
        Box::leak(s.as_str().expect("knobs.json: a word").to_string().into_boxed_str())
    }
    TABLE.get_or_init(|| {
        let t: Value = serde_json::from_str(LEAVES).expect("knobs.json");
        let knob = |k: &Value| Knob {
            name: word(&k["name"]),
            kind: match k["options"].as_array() {
                Some(o) => Kind::Pick {
                    default: word(&k["default"]),
                    options: Box::leak(o.iter().map(word).collect::<Vec<_>>().into_boxed_slice()),
                },
                None => {
                    let n = |f: &str| k[f].as_f64().expect("knobs.json: a number");
                    Kind::Range { default: n("default"), min: n("min"), max: n("max"), step: n("step") }
                }
            },
        };
        let nodes = t["nodes"].as_object().expect("knobs.json: nodes").iter().map(|(name, n)| {
            let knobs: Vec<Knob> = n["knobs"].as_array().expect("knobs.json: knobs").iter().map(knob).collect();
            let info = NodeInfo { name: word(&json!(name)), needs: &[], knobs: Box::leak(knobs.into_boxed_slice()), inner: None };
            (name.clone(), Leaf { info: Box::leak(Box::new(info)), reserve: n["reserve"].as_bool().expect("knobs.json: reserve") })
        });
        let legacy = t["legacy"].as_object().expect("knobs.json: legacy").iter().map(|(node, at)| {
            (node.clone(), at.as_array().expect("knobs.json: a path").iter().map(|p| word(p).to_string()).collect())
        });
        let legacy = legacy.collect();
        Leaves { nodes: nodes.collect(), legacy }
    })
}

/// Every knob value a page sets for its leaves against the registry: `hero.style` ({node: {knob: value}}) and the older
/// keys each legacy node reads, where it reads them (frame the hero's, base hero.data's). One refusal per value that is off its node, its knob or its range, naming what is
/// allowed and one example; the ranges are the prototype's and are never widened here.
pub fn check_style(hero: &Value) -> Vec<String> {
    let t = leaves();
    let mut bad = vec![];
    let mut set: Vec<(String, &str, &str, &Value)> = vec![];
    match hero.get("style").map(Value::as_object) {
        None => {}
        Some(None) => bad.push("style: not a table of nodes".to_string()),
        Some(Some(style)) => {
            for (node, kv) in style {
                match kv.as_object() {
                    Some(kv) => set.extend(kv.iter().map(|(k, v)| (format!("style.{node}.{k}"), node.as_str(), k.as_str(), v))),
                    None => bad.push(format!("style.{node}: not a table of knobs")),
                }
            }
        }
    }
    for (node, at) in &t.legacy {
        let Some(cfg) = at.iter().try_fold(hero, |c, p| c.get(p)) else { continue };
        for k in t.nodes.get(node).map_or(&[][..], |l| l.info.knobs) {
            if let Some(v) = cfg.get(k.name) {
                let path = at.iter().map(String::as_str).chain([k.name]).collect::<Vec<_>>().join(".");
                set.push((format!("{path} (read by {node})"), node, k.name, v));
            }
        }
    }
    for (path, node, k, v) in set {
        let Some(leaf) = t.nodes.get(node).filter(|l| !l.info.knobs.is_empty()) else {
            let with: Vec<_> = t.nodes.iter().filter(|(_, l)| !l.info.knobs.is_empty()).map(|(n, _)| n.as_str()).collect();
            bad.push(format!("{path}: no leaf node {node} takes knobs; e.g. one of {}", with.join("|")));
            continue;
        };
        let Some(knob) = leaf.info.knobs.iter().find(|x| x.name == k) else {
            let names: Vec<_> = leaf.info.knobs.iter().map(|x| x.name).collect();
            bad.push(format!("{path}: {node} has no knob {k}; e.g. one of {}", names.join("|")));
            continue;
        };
        let val = match v {
            Value::Number(x) => Val::Num(x.as_f64().unwrap_or(f64::NAN)),
            Value::String(w) => Val::Word(w.clone()),
            _ => {
                bad.push(format!("{path}: {v} is neither a number nor a word; e.g. {}", knob.default_val()));
                continue;
            }
        };
        if let Err(e) = knob.check(&path, &val) {
            bad.push(e);
        }
    }
    bad
}

impl<'a> Layer<'a> {
    /// A layer of a registered leaf node: it reserves room first when the registry says so, and the page's knob values
    /// (`knobs.spec.hero`) are checked against the registry before any leaf runs.
    pub fn registered(node: &'a str, layer: &'a str, rows: Value, knobs: Value) -> Result<Layer<'a>, Vec<String>> {
        let t = leaves();
        let Some(leaf) = t.nodes.get(node) else {
            let names: Vec<_> = t.nodes.keys().map(String::as_str).collect();
            return Err(vec![format!("{layer}: no leaf node {node}; e.g. one of {}", names.join("|"))]);
        };
        let bad = knobs.pointer("/spec/hero").map(check_style).unwrap_or_default();
        if !bad.is_empty() {
            return Err(bad.into_iter().map(|b| format!("{layer}: {b}")).collect());
        }
        Ok(Layer { node, layer, rows, knobs, reserve: leaf.reserve })
    }

    /// Test-only: a layer of a twin leaf no registry lists (fixtures/next_leaf), with no rows and its knobs as given.
    #[cfg(test)]
    pub(crate) fn twin(node: &'a str, layer: &'a str, knobs: Value) -> Layer<'a> {
        Layer { node, layer, rows: json!([]), knobs, reserve: false }
    }
}

/// A text the leaf printed: its box before turning (by the first layer's width rule), turned `rot` degrees clockwise (as
/// SVG's rotate) about `at`, the point it was drawn at.
#[derive(Clone, Debug, PartialEq)]
pub struct Text {
    pub src: String,
    pub text: String,
    pub layer: String,
    pub bx: Bx,
    pub rot: f64,
    pub at: (f64, f64),
}

/// What one layer cost and how it ended, for the caller's program event.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub node: String,
    pub layer: String,
    pub ms: u128,
    pub outcome: String,
}

/// The panel as drawn: each layer's SVG fragment bottom first, the HTML layers over it, every text with its box, the frame
/// the base fixed; `layers` holds every fragment taken under its layer's name, in the order taken and whether it is html, the
/// bytes the page phase is sent and must keep.
#[derive(Debug, Default)]
pub struct Panel {
    pub svg: Vec<String>,
    pub html: Vec<String>,
    pub layers: Vec<(String, String, bool)>,
    pub texts: Vec<Text>,
    pub lines: Vec<(String, Vec<(f64, f64)>)>,
    pub frame: Value,
}

/// The box of a text drawn at (x, y) with the given anchor, by `tw`: on its baseline, ascent 0.9 em and descent 0.25 em
/// (runtime/nodes/common.mjs uses the same); with `baseline` "middle" or "central", the same height centred on y.
fn text_box(x: f64, y: f64, size: f64, anchor: &str, baseline: &str, text: &str) -> Bx {
    let w = tw(text, size);
    let x0 = match anchor {
        "middle" => x - w / 2.0,
        "end" => x - w,
        _ => x,
    };
    let (up, down) = match baseline {
        "middle" | "central" => (0.575, 0.575),
        _ => (0.9, 0.25),
    };
    [x0, y - size * up, x0 + w, y + size * down]
}

/// The point p turned with the text by `deg` about `at`.
fn turn(p: (f64, f64), at: (f64, f64), deg: f64) -> (f64, f64) {
    let (s, c) = deg.to_radians().sin_cos();
    let (dx, dy) = (p.0 - at.0, p.1 - at.1);
    (at.0 + dx * c - dy * s, at.1 + dx * s + dy * c)
}

/// The four corners of a text's box as drawn.
fn corners(t: &Text) -> [(f64, f64); 4] {
    let b = t.bx;
    [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])].map(|p| turn(p, t.at, t.rot))
}

/// The upright box around a text as drawn: what other layers are told it takes.
fn bounds(t: &Text) -> Bx {
    corners(t).iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |b, &(x, y)| [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)],
    )
}

/// Two drawn boxes share area: no edge direction of either separates them (touching edges do not count).
fn overlap(a: &Text, b: &Text) -> bool {
    let (ca, cb) = (corners(a), corners(b));
    let span = |cs: &[(f64, f64); 4], (ux, uy): (f64, f64)| {
        cs.iter()
            .map(|&(x, y)| x * ux + y * uy)
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
                (lo.min(v), hi.max(v))
            })
    };
    [a.rot, b.rot].iter().all(|&deg| {
        let (s, c) = deg.to_radians().sin_cos();
        [(c, s), (-s, c)].iter().all(|&axis| {
            let ((a0, a1), (b0, b1)) = (span(&ca, axis), span(&cb, axis));
            a0 < b1 && a1 > b0
        })
    })
}

fn on_line(t: &Text, pts: &[(f64, f64)]) -> bool {
    let b = t.bx;
    pts.iter().any(|&p| {
        let (x, y) = turn(p, t.at, -t.rot);
        b[0] - LINE_PAD < x && x < b[2] + LINE_PAD && b[1] - LINE_PAD < y && y < b[3] + LINE_PAD
    })
}

/// Every reason a reply cannot go on the panel: a text with no source, no position or out of the panel, a text over another
/// text or over a line of another layer, a line of this layer over a text below it.
fn faults(
    panel: &Panel,
    w: f64,
    h: f64,
    layer: &str,
    texts: &[Text],
    lines: &[Vec<(f64, f64)>],
) -> Vec<String> {
    let mut out = Vec::new();
    for (i, t) in texts.iter().enumerate() {
        let b = bounds(t);
        if t.src.is_empty() {
            out.push(format!("{layer}: {:?} has no src", t.text));
        }
        if !b.iter().all(|v| v.is_finite()) {
            out.push(format!("{layer}: {:?} has no position", t.text));
        } else if b[0] < 0.0 || b[1] < 0.0 || b[2] > w || b[3] > h {
            out.push(format!(
                "{layer}: {:?} at {b:?} is outside the panel {w}x{h}",
                t.text
            ));
        }
        for o in panel.texts.iter().chain(&texts[i + 1..]) {
            if overlap(t, o) {
                out.push(format!(
                    "{layer}: {:?} overlaps {:?} of {}",
                    t.text, o.text, o.layer
                ));
            }
        }
        for (other, pts) in &panel.lines {
            if on_line(t, pts) {
                out.push(format!("{layer}: {:?} sits on a line of {other}", t.text));
            }
        }
    }
    for t in &panel.texts {
        if lines.iter().any(|pts| on_line(t, pts)) {
            out.push(format!(
                "{layer}: a line runs over {:?} of {}",
                t.text, t.layer
            ));
        }
    }
    out
}

/// The strings of a reply's array field (`refused`, `dropped`).
fn strs(reply: &Value, key: &str) -> Vec<String> {
    reply[key]
        .as_array()
        .map(|r| {
            r.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Every `<text>` element of a fragment as (source, text): the source is its `data-src`, or else the `data-src` of each
/// element inside it joined by "+" (a text holding several numbers), or else ""; the text is its content, tags dropped.
fn drawn_texts(svg: &str) -> Vec<(String, String)> {
    let src_of = |attrs: &[(String, String)]| {
        attrs
            .iter()
            .find(|(k, _)| k == "data-src")
            .map(|(_, v)| v.clone())
    };
    let mut out = Vec::new();
    let mut rest = svg;
    while let Some(at) = rest.find('<') {
        rest = &rest[at..];
        let Some(end) = tag_end(rest) else { break };
        let (name, attrs) = tag_parts(&rest[1..end]);
        rest = &rest[end + 1..];
        if name != "text" {
            continue;
        }
        let close = rest.find("</text>").unwrap_or(rest.len());
        let (mut body, mut words, mut inner) = (&rest[..close], String::new(), Vec::new());
        while let Some(lt) = body.find('<') {
            words.push_str(&body[..lt]);
            body = &body[lt..];
            let Some(gt) = tag_end(body) else { break };
            inner.extend(src_of(&tag_parts(&body[1..gt]).1));
            body = &body[gt + 1..];
        }
        if !body.contains('<') {
            words.push_str(body);
        }
        out.push((
            src_of(&attrs).unwrap_or_else(|| inner.join("+")),
            unescape(&words),
        ));
        rest = &rest[close..];
    }
    out
}

/// The elements an svg layer may hold, lower-case. Inside inline svg the browser leaves svg at any html start tag (div,
/// span, b, font with color, ...) and shows it as html, a text `drawn_texts` never sees; so the list is closed, not open.
/// Filter primitives go in by name: feImage loads a file like image does. Out until a node needs one: image and a, and
/// use, symbol, pattern, marker and textPath, which re-place, repeat or bend a text where `drawn_texts` reads no box.
const SVG_TAGS: &[&str] = &[
    "svg", "g", "path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text", "tspan", "defs",
    "clippath", "lineargradient", "radialgradient", "stop", "title", "desc", "filter", "fegaussianblur",
];

/// Why an svg fragment cannot be drawn as svg: a start tag off `SVG_TAGS` (any prefix such as `svg:` dropped), a CDATA
/// section (shown as text, read by no check here), an `on*` handler, or an href that points anywhere but a `#` inside the page. None when it is plain svg.
fn svg_markup(svg: &str) -> Option<String> {
    let b = svg.as_bytes();
    let mut i = 0;
    while let Some(off) = svg[i..].find('<') {
        i += off + 1;
        if svg[i..].starts_with("![CDATA[") {
            return Some("holds a CDATA section, a text no reader here sees".to_string());
        }
        if let Some(body) = svg[i..].strip_prefix("!--") {
            match comment_len(body) {
                Ok(n) => i += 3 + n,
                Err(e) => return Some(format!("holds {e}")),
            }
            continue;
        }
        if !b.get(i).is_some_and(u8::is_ascii_alphabetic) {
            continue; // an end tag or a bare "<"
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'/' && b[i] != b'>' {
            i += 1;
        }
        let name = svg[start..i].to_ascii_lowercase();
        let local = name.rsplit(':').next().unwrap_or("");
        if !SVG_TAGS.contains(&local) {
            return Some(format!("holds <{}>, which is not svg; html goes in an html layer", &svg[start..i]));
        }
        loop {
            while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
                i += 1;
            }
            if i >= b.len() || b[i] == b'>' {
                break;
            }
            let at = i;
            while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
                i += 1;
            }
            let attr = svg[at..i].to_ascii_lowercase();
            let mut value = "";
            if b.get(i) == Some(&b'=') {
                i += 1;
                let q = b.get(i).copied().filter(|c| *c == b'"' || *c == b'\'');
                let from = i + q.is_some() as usize;
                let end = match q {
                    Some(q) => svg[from..].find(q as char).map_or(b.len(), |e| from + e),
                    None => svg[from..].find(|c: char| c.is_ascii_whitespace() || c == '>').map_or(b.len(), |e| from + e),
                };
                value = &svg[from..end];
                i = (end + q.is_some() as usize).min(b.len());
            }
            if attr.starts_with("on") {
                return Some(format!("<{name}> carries the handler {attr}"));
            }
            if (attr == "href" || attr.ends_with(":href")) && !value.trim_start().starts_with('#') {
                return Some(format!("<{name}> {attr} points outside the page ({value:?}); only #ids inside it"));
            }
        }
    }
    None
}

/// Reads one reply into the panel, or the reasons it was refused. Only the first layer (the base) may fix the frame.
fn take(
    panel: &mut Panel,
    w: f64,
    h: f64,
    layer: &str,
    first: bool,
    reply: &Value,
) -> Result<(), Vec<String>> {
    let refused = strs(reply, "refused");
    if !refused.is_empty() {
        return Err(refused);
    }
    // Names a leaf could not place go to a list under the map; until that list node exists, a panel that drops one is refused.
    let dropped = strs(reply, "dropped");
    if !dropped.is_empty() {
        return Err(vec![format!(
            "{layer}: dropped {dropped:?}; no list node takes them yet"
        )]);
    }
    if !first && !reply["frame"].is_null() {
        return Err(vec![format!(
            "{layer}: only the base layer fixes the frame"
        )]);
    }
    let reported = reply["texts"].as_array().cloned().unwrap_or_default();
    let lines_given = reply["lines"].as_array().is_some_and(|l| !l.is_empty());
    if let Some(html) = reply["html"].as_str() {
        // Laid out in the browser: no boxes here, so it may report none; check_numbers and the browser check read it.
        if !reported.is_empty() || lines_given || !reply["svg"].is_null() {
            return Err(vec![format!(
                "{layer}: an html layer reports no texts or lines and draws no svg; they are checked in the browser"
            )]);
        }
        panel.html.push(html.to_string());
        panel.layers.push((layer.to_string(), html.to_string(), true));
        return Ok(());
    }
    let svg = reply["svg"]
        .as_str()
        .ok_or_else(|| vec![format!("{layer}: no svg")])?;
    // html inside an svg would be a text the reader below never sees, past the html layers' own rule
    if let Some(why) = svg_markup(svg) {
        return Err(vec![format!("{layer}: an svg layer {why}")]);
    }
    let mut bad = Vec::new();
    let texts: Vec<Text> = reported
        .iter()
        .map(|t| {
            let s = |k: &str| t[k].as_str().unwrap_or("").to_string();
            let n = |k: &str| t[k].as_f64().unwrap_or(f64::NAN);
            let (x, y, size) = (n("x"), n("y"), n("size"));
            if !(size.is_finite() && size > 0.0) {
                bad.push(format!("{layer}: {:?} has no size", s("text")));
            }
            Text {
                src: s("src"),
                text: s("text"),
                layer: layer.to_string(),
                bx: text_box(x, y, size, &s("anchor"), &s("baseline"), &s("text")),
                rot: t["rot"].as_f64().unwrap_or(0.0),
                at: (x, y),
            }
        })
        .collect();
    // The texts reported are the texts drawn: a <text> left out of the report would escape the checks below.
    let mut drawn = drawn_texts(svg);
    let mut said: Vec<(String, String)> = texts
        .iter()
        .map(|t| (t.src.clone(), t.text.clone()))
        .collect();
    drawn.sort();
    said.sort();
    if drawn != said {
        bad.push(format!(
            "{layer}: the svg draws texts {drawn:?} but reports {said:?}"
        ));
    }
    let lines: Vec<Vec<(f64, f64)>> = reply["lines"]
        .as_array()
        .map(|ls| {
            ls.iter()
                .map(|l| {
                    let vertices: Vec<(f64, f64)> = l
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|p| Some((p[0].as_f64()?, p[1].as_f64()?)))
                        .collect();
                    sampled(&vertices)
                })
                .collect()
        })
        .unwrap_or_default();
    bad.extend(faults(panel, w, h, layer, &texts, &lines));
    if !bad.is_empty() {
        return Err(bad);
    }
    panel.svg.push(svg.to_string());
    panel.layers.push((layer.to_string(), svg.to_string(), false));
    panel.texts.extend(texts);
    panel
        .lines
        .extend(lines.into_iter().map(|l| (layer.to_string(), l)));
    if !reply["frame"].is_null() {
        panel.frame = reply["frame"].clone();
    }
    Ok(())
}

fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The reply lines of a child's output, read on their own thread.
type Lines = mpsc::Receiver<std::io::Result<String>>;

/// A child started with a cleared environment (PATH, HOME, LANG only), its input and its reply lines.
fn start(runner: &Runner) -> Result<(Child, ChildStdin, Lines), String> {
    let mut child = Command::new(&runner.program)
        .args(&runner.args)
        .env_clear()
        .envs(
            ["PATH", "HOME", "LANG"]
                .iter()
                .filter_map(|k| Some((*k, std::env::var(k).ok()?))),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{} did not start: {e}", runner.program))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        stop(child);
        return Err(format!("{} gave no pipes", runner.program));
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    Ok((child, stdin, rx))
}

/// A refused panel: the records so far and every reason the refused layer gave.
pub type Refused = (Vec<Record>, Vec<String>);

/// One request line out and its reply line back within the deadline.
fn ask(
    stdin: &mut impl Write,
    rx: &mpsc::Receiver<std::io::Result<String>>,
    layer: &str,
    request: &Value,
    deadline: Duration,
) -> Result<Value, String> {
    writeln!(stdin, "{request}")
        .and_then(|_| stdin.flush())
        .map_err(|_| format!("{layer}: the leaf closed its input"))?;
    match rx.recv_timeout(deadline) {
        Ok(Ok(line)) => serde_json::from_str::<Value>(&line)
            .map_err(|e| format!("{layer}: reply is not JSON: {e}")),
        Ok(Err(e)) => Err(format!("{layer}: reading the reply: {e}")),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!("{layer}: no reply in {deadline:?}")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("{layer}: the leaf exited")),
    }
}

/// A reservation's entries with the reserving layer as their tag where the leaf gave none: boxes [x0, y0, x1, y1, tag],
/// lines {layer, pts, ...}. They only steer the layers' placing; the checks read what is drawn.
fn reserved(layer: &str, reply: &Value) -> (Vec<Value>, Vec<Value>) {
    let items = |k: &str| reply[k].as_array().cloned().unwrap_or_default();
    let boxes = items("boxes")
        .into_iter()
        .map(|mut b| {
            if let Some(a) = b.as_array_mut().filter(|a| a.len() == 4) {
                a.push(json!(layer));
            }
            b
        })
        .collect();
    let lines = items("lines")
        .into_iter()
        .map(|mut l| {
            if let Some(o) = l.as_object_mut() {
                o.entry("layer").or_insert(json!(layer));
            }
            l
        })
        .collect();
    (boxes, lines)
}

/// Draws a panel of `w`×`h` from its layers through one child started by `runner`: the reserving layers first, then every
/// layer bottom first. Err: the records so far and every reason the first refused call gave; nothing of a refused panel is
/// kept.
pub fn draw(
    runner: &Runner,
    w: f64,
    h: f64,
    frame: Value,
    layers: &[Layer<'_>],
) -> Result<(Panel, Vec<Record>), Refused> {
    drawn(runner, w, h, frame, layers, false).map(|(panel, _, records)| (panel, records))
}

/// The same panel, then the page around it from the same child: Rust sends the page line the fragments it took (layer ->
/// bytes), and the page comes back only if it holds each of them byte for byte (`held`). The page is not yet baked or checked.
pub fn draw_page(
    runner: &Runner,
    w: f64,
    h: f64,
    frame: Value,
    layers: &[Layer<'_>],
) -> Result<(Panel, String, Vec<Record>), Refused> {
    drawn(runner, w, h, frame, layers, true).map(|(panel, html, records)| (panel, html.unwrap_or_default(), records))
}

/// Every way the page does not hold the layers as Rust took them. Each layer's bytes sit on the page exactly once, its root
/// element gaining at most its own ` data-layer="<name>"` right after the tag name (the page tags a bare inset that way), and
/// not inside a comment, template, script, style or noscript; the longest layer is found first and its bytes are spent, so a
/// short layer cannot pass on a longer one's. The svg layers in one svg (or in none) keep the order Rust took them, bottom
/// first, as the html layers do; and no svg on the page draws anything of its own or moves or hides its layers: past them it
/// holds only `<g>`, `</g>` and `<g data-layer="<name>">` naming a layer in it (a transform or style on a group would draw the
/// same bytes elsewhere or not at all).
fn held(html: &str, layers: &[(String, String, bool)]) -> Vec<String> {
    let unseen = unseen(html);
    let mut page = html.to_string();
    let mut at = vec![None; layers.len()];
    let mut off = Vec::new();
    let mut longest: Vec<usize> = (0..layers.len()).filter(|&i| !layers[i].1.is_empty()).collect();
    longest.sort_by_key(|&i| std::cmp::Reverse(layers[i].1.len()));
    for i in longest {
        let (name, frag, _) = &layers[i];
        let tagged = frag.strip_prefix('<').and_then(|rest| {
            let n = rest.find(|c: char| !c.is_ascii_alphanumeric()).filter(|n| *n > 0)?;
            Some(format!("<{} data-layer=\"{name}\"{}", &rest[..n], &rest[n..]))
        });
        // spent bytes are NULs, which no layer holds
        let found: Vec<(usize, usize)> = std::iter::once(frag.as_str())
            .chain(tagged.as_deref())
            .filter(|f| !f.contains('\0'))
            .flat_map(|f| page.match_indices(f).map(|(p, _)| (p, f.len())).collect::<Vec<_>>())
            .collect();
        match found[..] {
            [] => off.push(format!("page: the layer {name} is not on the page byte for byte as it was drawn")),
            [(p, _)] if unseen.iter().any(|r| r.contains(&p)) => off.push(format!(
                "page: the layer {name} sits inside a comment, template, script, style or noscript, where nothing is drawn"
            )),
            [(p, n)] => {
                at[i] = Some(p);
                page.replace_range(p..p + n, &"\0".repeat(n));
            }
            _ => off.push(format!("page: the layer {name} is on the page {} times; it was drawn once", found.len())),
        }
    }
    let svgs = svgs(&page, &unseen);
    let inside = |p: usize| svgs.iter().filter(|s| s.1 <= p && p < s.2).max_by_key(|s| s.1).map(|s| s.0);
    let mut kept: BTreeMap<(bool, Option<usize>), Vec<(usize, &str)>> = BTreeMap::new();
    for ((name, _, is_html), p) in layers.iter().zip(&at) {
        if let Some(p) = *p {
            let svg = if *is_html { None } else { inside(p) };
            kept.entry((*is_html, svg)).or_default().push((p, name.as_str()));
        }
    }
    for taken in kept.values() {
        if taken.windows(2).any(|w| w[0].0 > w[1].0) {
            let mut on_page = taken.clone();
            on_page.sort();
            let names = |l: &[(usize, &str)]| l.iter().map(|(_, n)| n.to_string()).collect::<Vec<_>>();
            off.push(format!(
                "page: the layers {:?} are on the page as {:?}; they keep the order they were drawn, bottom first",
                names(taken),
                names(&on_page)
            ));
        }
    }
    for &(start, body, end) in &svgs {
        let names: Vec<&str> = kept.get(&(false, Some(start))).map_or(Vec::new(), |t| t.iter().map(|(_, n)| *n).collect());
        if let Some(own) = drawing(&page[body..end], &names) {
            let own: String = own.chars().take_while(|c| *c != '\0').take(60).collect();
            off.push(format!(
                "page: an svg draws {own:?} of its own; past its layers an svg holds only <g>, </g> and <g data-layer=\"<a layer in it>\">"
            ));
        }
    }
    off
}

/// Whether `s` opens the element `name` (lower case): `<name` and then white space, `>`, `/` or the end.
fn element(s: &str, name: &str) -> bool {
    s.strip_prefix('<')
        .and_then(|r| r.strip_prefix(name))
        .is_some_and(|r| r.is_empty() || r.starts_with(|c: char| c == '>' || c == '/' || c.is_ascii_whitespace()))
}

/// The parts of the page nothing is drawn from, by byte range: comments, and the elements template (to its own close,
/// counting the templates inside it), script, style and noscript; one left open runs to the page end.
fn unseen(html: &str) -> Vec<Range<usize>> {
    let low = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = low[i..].find('<').map(|p| p + i) {
        let end = if low[p..].starts_with("<!--") {
            low[p + 4..].find("-->").map_or(low.len(), |e| p + 4 + e + 3)
        } else if let Some(name) = ["template", "script", "style", "noscript"].into_iter().find(|n| element(&low[p..], n)) {
            let close = format!("/{name}");
            let (mut depth, mut j, mut end) = (0, p, low.len());
            while let Some(q) = low[j..].find('<').map(|q| q + j) {
                if q == p || (name == "template" && element(&low[q..], name)) {
                    depth += 1;
                } else if element(&low[q..], &close) {
                    depth -= 1;
                    if depth == 0 {
                        end = low[q..].find('>').map_or(low.len(), |e| q + e + 1);
                        break;
                    }
                }
                j = q + 1;
            }
            end
        } else {
            i = p + 1;
            continue;
        };
        out.push(p..end);
        i = end;
    }
    out
}

/// Every svg element on the page outside `unseen`: where its start tag begins, and its body, from past the start tag to its
/// end tag (or the page end).
fn svgs(page: &str, unseen: &[Range<usize>]) -> Vec<(usize, usize, usize)> {
    let low = page.to_ascii_lowercase();
    let (mut out, mut open) = (Vec::new(), Vec::new());
    let mut i = 0;
    while let Some(p) = low[i..].find('<').map(|p| p + i) {
        i = p + 1;
        if unseen.iter().any(|r| r.contains(&p)) {
            continue;
        }
        if element(&low[p..], "svg") {
            let Some(e) = low[p..].find('>').map(|e| p + e + 1) else { break };
            if !low[p..e].ends_with("/>") {
                open.push((p, e));
            }
            i = e;
        } else if element(&low[p..], "/svg") {
            if let Some((o, b)) = open.pop() {
                out.push((o, b, p));
            }
        }
    }
    out.extend(open.into_iter().map(|(o, b)| (o, b, page.len())));
    out
}

/// The first thing an svg body draws past its spent layers (NULs), white space and the group tags `<g>`, `</g>` and
/// `<g data-layer="<name>">` for a name in `names`, as the page line tags a layer.
fn drawing<'a>(mut s: &'a str, names: &[&str]) -> Option<&'a str> {
    loop {
        s = s.trim_start_matches(|c: char| c == '\0' || c.is_ascii_whitespace());
        if s.is_empty() {
            return None;
        }
        let tag = if s.starts_with("</g>") {
            Some(4)
        } else if s.starts_with("<g>") {
            Some(3)
        } else {
            s.strip_prefix("<g data-layer=\"").and_then(|r| {
                let e = r.find('"')?;
                (names.contains(&&r[..e]) && r[e..].starts_with("\">")).then_some("<g data-layer=\"".len() + e + 2)
            })
        };
        match tag {
            Some(n) => s = &s[n..],
            None => return Some(s),
        }
    }
}

fn drawn(
    runner: &Runner,
    w: f64,
    h: f64,
    frame: Value,
    layers: &[Layer<'_>],
    page: bool,
) -> Result<(Panel, Option<String>, Vec<Record>), Refused> {
    let mut records = Vec::new();
    let (child, mut stdin, rx) = match start(runner) {
        Ok(started) => started,
        Err(why) => return Err((records, vec![why])),
    };
    let mut panel = Panel {
        frame,
        ..Panel::default()
    };
    let (mut held_boxes, mut held_lines) = (Vec::new(), Vec::new());
    let calls = layers
        .iter()
        .filter(|l| l.reserve)
        .map(|l| (l, true))
        .chain(layers.iter().map(|l| (l, false)));
    let mut first = true;
    for (l, reserve) in calls {
        let started = Instant::now();
        let request = if reserve {
            json!({
                "phase": "reserve", "node": l.node, "layer": l.layer,
                "panel": {"w": w, "h": h, "frame": panel.frame}, "rows": l.rows, "knobs": l.knobs,
            })
        } else {
            let occ_boxes: Vec<Value> = panel
                .texts
                .iter()
                .map(|t| {
                    let b = bounds(t);
                    json!([b[0], b[1], b[2], b[3], t.layer])
                })
                .chain(held_boxes.iter().cloned())
                .collect();
            let occ_lines: Vec<Value> = panel
                .lines
                .iter()
                .map(|(layer, pts)| json!({"layer": layer, "pts": pts.iter().map(|&(x, y)| json!([x, y])).collect::<Vec<_>>()}))
                .chain(held_lines.iter().cloned())
                .collect();
            json!({
                "node": l.node, "layer": l.layer, "panel": {"w": w, "h": h, "frame": panel.frame},
                "rows": l.rows, "knobs": l.knobs, "occ": {"boxes": occ_boxes, "lines": occ_lines},
            })
        };
        let taken = ask(&mut stdin, &rx, l.layer, &request, LAYER_DEADLINE)
            .map_err(|e| vec![e])
            .and_then(|r| {
                if reserve {
                    let refused = strs(&r, "refused");
                    if !refused.is_empty() {
                        return Err(refused);
                    }
                    let (b, ls) = reserved(l.layer, &r);
                    held_boxes.extend(b);
                    held_lines.extend(ls);
                    Ok(())
                } else {
                    take(&mut panel, w, h, l.layer, std::mem::take(&mut first), &r)
                }
            });
        let record = |outcome: &str| Record {
            node: l.node.to_string(),
            layer: l.layer.to_string(),
            ms: started.elapsed().as_millis(),
            outcome: outcome.to_string(),
        };
        match taken {
            Ok(()) => records.push(record(if reserve { "reserved" } else { "drawn" })),
            Err(why) => {
                records.push(record("refused"));
                stop(child);
                return Err((records, why));
            }
        }
    }
    let mut html = None;
    if page {
        let started = Instant::now();
        let sent: serde_json::Map<String, Value> =
            panel.layers.iter().map(|(n, f, _)| (n.clone(), json!(f))).collect();
        let request = json!({"phase": "page", "layers": sent});
        let taken = ask(&mut stdin, &rx, "page", &request, LAYER_DEADLINE)
            .map_err(|e| vec![e])
            .and_then(|r| {
                let refused = strs(&r, "refused");
                if !refused.is_empty() {
                    return Err(refused);
                }
                let page = r["html"].as_str().ok_or_else(|| vec!["page: no html".to_string()])?;
                let off = held(page, &panel.layers);
                if off.is_empty() {
                    Ok(page.to_string())
                } else {
                    Err(off)
                }
            });
        let record = |outcome: &str| Record {
            node: layers.first().map_or("", |l| l.node).to_string(),
            layer: "page".to_string(),
            ms: started.elapsed().as_millis(),
            outcome: outcome.to_string(),
        };
        match taken {
            Ok(p) => {
                records.push(record("drawn"));
                html = Some(p);
            }
            Err(why) => {
                records.push(record("refused"));
                stop(child);
                return Err((records, why));
            }
        }
    }
    drop(stdin);
    stop(child);
    Ok((panel, html, records))
}

/// What a reader reads on a page, in order: every text run (character references read; script and style bodies and
/// comments are not text and do not split a run; a run of only white space is none) and every attribute a reader is read,
/// and, apart, each `data-src` element with all the text inside it.
#[derive(Debug, PartialEq)]
struct Read {
    texts: Vec<String>,
    marks: Vec<(String, String)>,
}

fn read(html: &str) -> Result<Read, String> {
    let mut out = Read {
        texts: Vec::new(),
        marks: Vec::new(),
    };
    let mut run = String::new();
    let flush = |run: &mut String, texts: &mut Vec<String>| {
        if !run.trim().is_empty() {
            texts.push(std::mem::take(run));
        }
        run.clear();
    };
    // Open elements: name and, for a data-src one, its src, where its mark sits in `marks` and the text so far.
    let mut open: Vec<(String, Option<(String, String)>)> = Vec::new();
    let shut = |o: (String, Option<(String, String)>), marks: &mut Vec<(String, String)>| {
        if let Some(m) = o.1 {
            marks.push(m);
        }
    };
    let mut rest = html;
    while !rest.is_empty() {
        if let Some(comment) = rest.strip_prefix("<!--") {
            rest = &comment[comment_len(comment)?..];
            continue;
        }
        if rest.starts_with('<') {
            let end = tag_end(rest).ok_or("a tag is not closed")?;
            let tag = &rest[1..end];
            rest = &rest[end + 1..];
            if tag.starts_with('!') {
                continue;
            }
            let (name, attrs) = tag_parts(tag.trim_start_matches('/'));
            if name == "style" || name == "script" {
                if !tag.starts_with('/') {
                    let at = rest
                        .to_ascii_lowercase()
                        .find(&format!("</{name}"))
                        .ok_or(format!("a {name} is not closed"))?;
                    rest = &rest[at..];
                    rest = tag_end(rest).map_or("", |e| &rest[e + 1..]);
                }
                continue;
            }
            flush(&mut run, &mut out.texts);
            if tag.starts_with('/') {
                if open.iter().any(|o| o.0 == name) {
                    while let Some(o) = open.pop() {
                        let done = o.0 == name;
                        shut(o, &mut out.marks);
                        if done {
                            break;
                        }
                    }
                }
                continue;
            }
            for (key, value) in &attrs {
                if READ_ATTRS.contains(&key.as_str()) {
                    out.texts.push(format!("{key}={value}"));
                }
            }
            if tag.trim_end().ends_with('/') || VOID.contains(&name.as_str()) {
                continue;
            }
            let src = attrs
                .iter()
                .find(|(k, _)| k == "data-src")
                .map(|(_, v)| (v.clone(), String::new()));
            open.push((name, src));
            continue;
        }
        let next = rest.find('<').unwrap_or(rest.len());
        let text = unescape(&rest[..next]);
        rest = &rest[next..];
        for o in open.iter_mut() {
            if let Some((_, t)) = o.1.as_mut() {
                t.push_str(&text);
            }
        }
        run.push_str(&text);
    }
    flush(&mut run, &mut out.texts);
    while let Some(o) = open.pop() {
        shut(o, &mut out.marks);
    }
    out.marks.sort();
    Ok(out)
}

/// A page laid out once in the browser by the second layer's bake (runtime/leaves_py/bake.py): its layout scripts have run
/// and are gone, only `ready` (the renderer's script) is kept. The baked page is taken only when a reader reads the same as
/// before, every text and every `data-src` with its text, compared here; baking may move and draw, never write.
pub struct Baked {
    pub html: String,
    pub ms: u128,
}

pub fn bake(runner: &Runner, html: &str, ready: &str, width: u32) -> Result<Baked, String> {
    let started = Instant::now();
    let before = read(html).map_err(|e| format!("bake: the page as assembled: {e}"))?;
    let (child, mut stdin, rx) = start(runner)?;
    let reply = ask(
        &mut stdin,
        &rx,
        "bake",
        &json!({"html": html, "ready": ready, "width": width}),
        BAKE_DEADLINE,
    );
    drop(stdin);
    stop(child);
    let reply = reply?;
    if let Some(why) = reply["error"].as_str() {
        return Err(format!("bake: {why}"));
    }
    let baked = reply["html"]
        .as_str()
        .ok_or("bake: the reply has no html")?
        .to_string();
    let after = read(&baked).map_err(|e| format!("bake: the laid-out page: {e}"))?;
    if let Some(i) = (0..before.texts.len().max(after.texts.len()))
        .find(|&i| before.texts.get(i) != after.texts.get(i))
    {
        return Err(format!(
            "bake: text {i} was {:?}, the laid-out page reads {:?}",
            before.texts.get(i),
            after.texts.get(i)
        ));
    }
    if before.marks != after.marks {
        let gone: Vec<_> = before
            .marks
            .iter()
            .filter(|m| !after.marks.contains(m))
            .take(3)
            .collect();
        let came: Vec<_> = after
            .marks
            .iter()
            .filter(|m| !before.marks.contains(m))
            .take(3)
            .collect();
        return Err(format!(
            "bake: the data-src marks differ: before only {gone:?}, after only {came:?}"
        ));
    }
    Ok(Baked {
        html: baked,
        ms: started.elapsed().as_millis(),
    })
}

/// Every `{key}` placeholder left anywhere on a page, its scripts and styles included (a script may build one at run time,
/// which only the baked page shows). A `${...}` refuses too: after the bake the page's one script is READY_JS, which has
/// none, so nothing here is skipped (run.py's pre-bake scan still passes a layout script's `${...}`).
fn placeholders(html: &str) -> Vec<String> {
    let chars: Vec<char> = html.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for i in (0..chars.len()).filter(|&i| chars[i] == '{') {
        let Some(&first) = chars.get(i + 1) else {
            continue;
        };
        if !(first.is_alphabetic() || first == '_') {
            continue;
        }
        let end = (i + 1..chars.len())
            .find(|&j| !(chars[j].is_alphanumeric() || matches!(chars[j], '_' | '.')));
        if let Some(end) = end.filter(|&e| chars[e] == '}') {
            let k: String = chars[i..=end].iter().collect();
            if !out.contains(&k) {
                out.push(k);
            }
        }
    }
    out.sort();
    out
}

/// A month's year and month printed from two keys: each `period:<t>:<YYYY-MM>.y` mark must be followed by its own `.m`
/// mark, and each `.m` follow its own `.y`, in page order, so a date reads as one period of the data.
fn split_months(html: &str) -> Vec<String> {
    const AT: &str = "data-src=\"";
    let srcs: Vec<&str> = html
        .match_indices(AT)
        .filter_map(|(i, _)| html[i + AT.len()..].split('"').next())
        .collect();
    let mut off = Vec::new();
    for (i, src) in srcs.iter().enumerate() {
        let Some(key) = src
            .strip_prefix(PERIOD_SRC)
            .and_then(|r| r.rsplit_once(':'))
            .map(|(_, k)| k)
            .filter(|k| k.contains('-'))
        else {
            continue;
        };
        let stem = &src[..src.len() - key.len()];
        let (want, next) = match key.rsplit_once('.') {
            Some((m, "y")) => (format!("{stem}{m}.m"), srcs.get(i + 1)),
            Some((m, "m")) => (
                format!("{stem}{m}.y"),
                i.checked_sub(1).and_then(|j| srcs.get(j)),
            ),
            _ => continue,
        };
        if next.is_none_or(|n| **n != want) {
            off.push(format!("{src}: printed beside {next:?}, not beside {want} (a month's year and month come from one period)"));
        }
    }
    off
}

/// The whole-page check on the page as written (after the bake): no `{key}` placeholder anywhere, nothing skipped; no
/// month whose year and month come from two keys; every digit printing its ledger entry or naming one of `refs`, exactly
/// (next_ledger::check_numbers; `refs` is next_facts::leaf_refs, the request's table ids); and every `fact:`, `period:` and `record:` entry recomputed from the request rows
/// (next_facts::recheck). One line per finding; empty when the page passes.
pub fn check_leaf_page(
    html: &str,
    ledger: &BTreeMap<String, String>,
    refs: &[String],
    spec: &Spec,
    rows: &[Row],
    facts: &[Fact],
) -> Vec<String> {
    let mut off: Vec<String> = placeholders(html)
        .into_iter()
        .map(|k| format!("page: the page still holds the placeholder {k}"))
        .collect();
    off.extend(split_months(html));
    off.extend(check_numbers(html, ledger, refs));
    off.extend(recheck(ledger, spec, rows, facts));
    off
}

/// The leaf page as it is published: Rust adds the renderer's ready script once before `</body>` (the child never writes
/// it), the bake lays the page out and must leave exactly that one script, and check_leaf_page reads the baked bytes. A bake
/// error, a page that already holds READY_JS or has no `</body>`, any other script count, or any finding is no page: the
/// un-baked page is never written, checked or published.
pub fn bake_leaf_page(
    runner: &Runner,
    html: &str,
    ledger: &BTreeMap<String, String>,
    refs: &[String],
    (spec, rows, facts): (&Spec, &[Row], &[Fact]),
) -> Result<Baked, Vec<String>> {
    let ready = crate::next_ledger::READY_JS;
    if html.contains(ready) {
        return Err(vec!["page: the child wrote the ready script itself".into()]);
    }
    let Some(at) = html.rfind("</body>") else {
        return Err(vec!["page: the page has no </body>".into()]);
    };
    let page = format!("{}<script>{ready}</script>{}", &html[..at], &html[at..]);
    let baked = bake(runner, &page, ready, 1440).map_err(|e| vec![e])?;
    let scripts = baked.html.matches("<script").count();
    if scripts != 1 || !baked.html.contains(&format!("<script>{ready}</script>")) {
        return Err(vec![format!(
            "page: the baked page holds {scripts} scripts, not the one ready script"
        )]);
    }
    let off = check_leaf_page(&baked.html, ledger, refs, spec, rows, facts);
    if off.is_empty() {
        Ok(baked)
    } else {
        Err(off)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAID: &str =
        "<!doctype html><p>德国 <b data-src=\"fact:a.n\">44</b>%</p><svg><g></g></svg>\
        <div class=\"h\" title=\"t 1\">年<script>layout()</script>月</div><script>READY</script>";

    #[test]
    fn a_reader_reads_texts_and_marks_and_no_script_or_style() {
        let r = read(LAID).unwrap();
        assert_eq!(r.texts, ["德国 ", "44", "%", "title=t 1", "年月"]);
        assert_eq!(r.marks, [("fact:a.n".to_string(), "44".to_string())]);
        assert_eq!(
            read("<style>b{}</style><p>&amp;1<!--c-->2</p>")
                .unwrap()
                .texts,
            ["&12"]
        );
    }

    /// The bake twin drops the layout script and draws a path: taken. A page whose text it changes, or that it refuses,
    /// is refused, and nothing loose comes back.
    #[test]
    fn a_bake_may_draw_and_drop_scripts_but_never_change_a_text() {
        let twin = Runner::python(Path::new("fixtures/next_leaf/bake_twin.py"));
        let baked = bake(&twin, LAID, "READY", 1440).unwrap();
        assert!(!baked.html.contains("layout()") && baked.html.contains("<script>READY</script>"));
        assert!(baked.html.contains("<path"));
        let tampered = format!("{LAID}<!--tamper-->");
        let why = bake(&twin, &tampered, "READY", 1440).err().unwrap();
        assert!(why.starts_with("bake: text 1 was Some(\"44\")"), "{why}");
        let mark = "<p><b data-src=\"fact:a.n\">4</b></p><!--tamper-->";
        assert!(bake(&twin, mark, "READY", 1440)
            .err()
            .unwrap()
            .starts_with("bake: text 0"));
        let failed = format!("{LAID}<!--fail-->");
        assert_eq!(
            bake(&twin, &failed, "READY", 1440).err().unwrap(),
            "bake: the page asked for http://x/"
        );
    }

    /// The real bake in headless Chrome: the layout script runs (it draws a line) and is gone, the ready script stays; a page
    /// that asks the network for anything is refused.
    #[test]
    fn the_browser_bake_lays_the_page_out_and_lets_no_request_through() {
        let real = Runner::python(Path::new("runtime/leaves_py/bake.py"));
        let ready = crate::next_ledger::READY_JS;
        let page = format!(
            "<!doctype html><meta charset=\"utf-8\"><div id=\"h\"><b data-src=\"fact:a.n\">44</b><svg></svg></div>\
             <script>(()=>{{const h=document.getElementById('h');h.querySelector('svg').innerHTML=\
             '<line x2=\"'+h.offsetWidth+'\"/>';}})()</script><script>{ready}</script>"
        );
        let baked = bake(&real, &page, ready, 1440).unwrap();
        assert!(baked.html.contains("<line x2=\""), "{}", baked.html);
        assert_eq!(baked.html.matches("<script").count(), 1);
        assert!(baked.html.contains(&format!("<script>{ready}</script>")));
        assert!(!baked.html.contains("data-bake"));
        let asks = page.replace("<svg>", "<img src=\"http://example.invalid/a.png\"><svg>");
        let why = bake(&real, &asks, ready, 1440).err().unwrap();
        assert_eq!(why, "bake: the page asked for http://example.invalid/a.png");
    }

    /// The published leaf page: Rust adds READY_JS once, the bake leaves it as the one script and the check reads the baked
    /// bytes. A child that wrote READY_JS, a page with no </body>, a bake error or a finding on the baked page is no page.
    #[test]
    fn the_leaf_page_is_baked_with_one_ready_script_and_checked_after() {
        use crate::next_facts::leaf_ledger;
        use crate::next_ledger::READY_JS;
        let twin = Runner::python(Path::new("fixtures/next_leaf/bake_twin.py"));
        let rows = [Row {
            src: "series:mo/X:2021-01:v".into(),
            table: "mo".into(),
            dims: BTreeMap::new(),
            time: "2021-01".into(),
            value: 1.0,
        }];
        let spec = Spec {
            facts: Vec::new(),
            fmts: json!({}),
            members: None,
        };
        let ledger = leaf_ledger(&spec, &rows, &[]).unwrap();
        let refs = ["MIGR_ASYAPPCTZM".to_string()];
        let y = ["y", "m"]
            .map(|p| format!("<b data-src=\"period:mo:2021-01.{p}\">{}</b>", ledger[&format!("period:mo:2021-01.{p}")]))
            .join(" 年 ");
        let page = |body: &str| {
            format!("<!doctype html><html><body><p>{body}</p><svg><g></g></svg><footer><span data-ref=\"\">MIGR_ASYAPPCTZM</span></footer><script>layout()</script></body></html>")
        };
        let run = |html: &str| bake_leaf_page(&twin, html, &ledger, &refs, (&spec, &rows, &[]));
        let baked = run(&page(&format!("{y} 年"))).unwrap();
        assert_eq!(baked.html.matches("<script").count(), 1);
        assert!(baked.html.contains(&format!("<script>{READY_JS}</script></body>")));
        assert!(!baked.html.contains("layout()") && baked.html.contains("<path"));
        let wrote = page(&format!("{y} 年")).replace("layout()", READY_JS);
        assert_eq!(run(&wrote).err().unwrap(), ["page: the child wrote the ready script itself"]);
        let bodiless = page(&format!("{y} 年")).replace("</body>", "");
        assert_eq!(run(&bodiless).err().unwrap(), ["page: the page has no </body>"]);
        let failed = page(&format!("{y} 年<!--fail-->"));
        assert_eq!(run(&failed).err().unwrap(), ["bake: the page asked for http://x/"]);
        let raw = run(&page("2021 年")).err().unwrap();
        assert!(raw.iter().any(|f| f.contains("2021")), "{raw:?}");
    }

    #[test]
    fn the_bake_refuses_a_text_over_a_text_out_of_its_svg_or_over_a_note_and_passes_a_clean_page() {
        let real = Runner::python(Path::new("runtime/leaves_py/bake.py"));
        let page = |body: &str| format!("<!doctype html><meta charset=\"utf-8\"><body style=\"margin:0\">{body}</body>");
        let svg = |texts: &str| format!("<svg width=\"400\" height=\"200\" data-layer=\"map\">{texts}</svg>");
        let clean = page(&svg("<text x=\"20\" y=\"40\" font-size=\"14\">德国</text><text x=\"20\" y=\"120\" font-size=\"14\">法国</text>"));
        bake(&real, &clean, "", 1440).unwrap();
        let cases = [
            (svg("<text x=\"20\" y=\"40\" font-size=\"14\">德国</text><text x=\"24\" y=\"42\" font-size=\"14\">法国</text>"), "overlap svg0: 德国 | 法国"),
            (svg("<text x=\"380\" y=\"40\" font-size=\"14\">德国德国</text>"), "clip svg0: 德国德国"),
            (
                "<div data-layer=\"callouts\"><div class=\"rc\" style=\"position:absolute;left:10px;top:10px\">德国</div>\
                 <div class=\"rc\" style=\"position:absolute;left:14px;top:12px\">法国</div></div>"
                    .to_string(),
                "callouts × callouts: 德国 | 法国",
            ),
        ];
        for (body, why) in cases {
            let got = bake(&real, &page(&body), "", 1440).err().unwrap();
            assert!(got.contains("layout finding") && got.contains(why), "{why}: {got}");
        }
    }

    /// The line rule: the base map's lines are background, and a text may sit on its own line (data-on = data-line), in the
    /// svg check and in the layer check alike; a text on any other line, or on a box edge (the base map's too), is a finding.
    #[test]
    fn the_bake_lets_a_text_cross_the_base_map_and_its_own_line_only() {
        let real = Runner::python(Path::new("runtime/leaves_py/bake.py"));
        let page = |body: &str| {
            format!("<!doctype html><meta charset=\"utf-8\"><body style=\"margin:0\"><svg width=\"400\" height=\"200\">{body}</svg></body>")
        };
        let line = |layer: &str, id: &str| {
            format!("<g data-layer=\"{layer}\"><path data-line=\"{id}\" d=\"M0,35 L400,35\" stroke=\"#c33\" stroke-width=\"1\" fill=\"none\"/></g>")
        };
        let text = |layer: &str, on: &str| format!("<g data-layer=\"{layer}\"><text data-on=\"{on}\" x=\"20\" y=\"40\" font-size=\"14\">德国</text></g>");
        let sea = |layer: &str| format!("<g data-layer=\"{layer}\"><rect x=\"30\" y=\"0\" width=\"100\" height=\"35\" fill=\"#dde\"/></g>");
        // too pale for the svg check, still a line to the layer check, which reports each text and layer pair once
        let pale = "<g data-layer=\"map.flows\"><path data-line=\"flow:FR\" d=\"M0,33 L400,33\" stroke=\"#fafafa\" stroke-width=\"1\" fill=\"none\"/></g>";
        for body in [
            line("map.base", "") + &text("map.labels", ""),
            line("map.flows", "flow:DE") + &text("map.flows", "flow:DE"),
        ] {
            bake(&real, &page(&body), "", 1440).unwrap();
        }
        let cases = [
            (line("map.flows", "flow:FR") + &text("map.flows", "flow:DE"), "line: svg0: 德国 x path (map.flows)"),
            (line("map.flows", "flow:DE") + &text("map.labels", ""), "line: svg0: 德国 x path (map.flows)"),
            (line("map.routes", "") + &text("map.labels", ""), "layers: map.labels × map.routes line: 德国"),
            (sea("map") + &text("map.labels", ""), "line: svg0: 德国 x rect (map edge)"),
            (sea("map.base") + &text("map.labels", ""), "line: svg0: 德国 x rect (map.base edge)"),
            (pale.to_string() + &text("map.flows", "flow:DE"), "layers: map.flows × map.flows line: 德国"),
            (pale.to_string() + &line("map.flows", "flow:DE") + &text("map.flows", "flow:DE"), "layers: map.flows × map.flows line: 德国"),
        ];
        for (body, why) in cases {
            let got = bake(&real, &page(&body), "", 1440).err().unwrap();
            assert!(got.contains("layout finding") && got.contains(why), "{why}: {got}");
        }
    }

    /// Measures one bake of a whole page (BAKE_PAGE=<html>; run with --ignored): seconds and the check's script finding.
    #[test]
    #[ignore]
    fn bake_a_stored_page() {
        let html = std::fs::read_to_string(std::env::var("BAKE_PAGE").unwrap()).unwrap();
        let ready = crate::next_ledger::READY_JS;
        let script = "the page holds a script that is not the renderer's".to_string();
        let as_is = crate::next_ledger::check_numbers(&html, &Default::default(), &[]);
        let baked = bake(
            &Runner::python(Path::new("runtime/leaves_py/bake.py")),
            &html,
            ready,
            1440,
        )
        .unwrap();
        let after = crate::next_ledger::check_numbers(&baked.html, &Default::default(), &[]);
        println!(
            "bake ms {} | script finding before {} after {} | findings before {} after {}",
            baked.ms,
            as_is.contains(&script),
            after.contains(&script),
            as_is.len(),
            after.len()
        );
    }

    fn runners() -> [Runner; 2] {
        [
            Runner::node(Path::new("fixtures/next_leaf/echo.mjs")),
            Runner::python(Path::new("fixtures/next_leaf/echo.py")),
        ]
    }

    fn layer<'a>(node: &'a str, name: &'a str, knobs: Value) -> Layer<'a> {
        Layer {
            node,
            layer: name,
            rows: json!([]),
            knobs,
            reserve: false,
        }
    }

    fn text(src: &str, x: f64, y: f64) -> Value {
        json!({"src": src, "text": "德国", "x": x, "y": y, "size": 12, "anchor": "start"})
    }

    /// Draws `layers` on a 900×460 panel through every runner; each runner must give the same outcome.
    fn both(layers: &[Layer<'_>]) -> Vec<Result<(Panel, Vec<Record>), Refused>> {
        runners()
            .iter()
            .map(|r| draw(r, 900.0, 460.0, json!({"projection": "equalEarth"}), layers))
            .collect()
    }

    fn reasons(layers: &[Layer<'_>]) -> Vec<String> {
        let out: Vec<Vec<String>> = both(layers)
            .into_iter()
            .map(|r| {
                let (records, why) = r.unwrap_err();
                assert_eq!(records.last().unwrap().outcome, "refused");
                why
            })
            .collect();
        assert_eq!(out[0], out[1], "node and python differ");
        out[0].clone()
    }

    /// The echo leaves (fixtures, one in Node and one in Python) print what their knobs say, so each check can be met head on.
    #[test]
    fn a_panel_takes_layers_bottom_first_and_passes_the_base_frame_up() {
        let base = layer(
            "echo",
            "base",
            json!({"frame": {"scale": 140}, "lines": [[[0, 50], [900, 50]]]}),
        );
        let label = layer(
            "echo",
            "notes",
            json!({"texts": [{"src": "name:x/RU", "text": "俄罗斯", "x": 10, "y": 30, "size": 12, "anchor": "start"}], "echo_frame": true}),
        );
        let layers = [base, label];
        for done in both(&layers) {
            let (panel, records) = done.unwrap();
            assert_eq!(panel.svg.len(), 2);
            assert_eq!(panel.frame, json!({"scale": 140}));
            // The second layer was handed the frame the base fixed.
            assert!(panel.svg[1].contains("scale"), "{}", panel.svg[1]);
            assert_eq!(
                records
                    .iter()
                    .map(|r| r.outcome.as_str())
                    .collect::<Vec<_>>(),
                ["drawn", "drawn"]
            );
            assert_eq!(
                panel.texts[0].bx,
                [10.0, 30.0 - 12.0 * 0.9, 46.0, 30.0 + 12.0 * 0.25]
            );
        }
    }

    /// The page line is sent the bytes Rust took and the page holds each as taken: once, where something is drawn, in the
    /// order taken, with nothing else drawn in its svg and only bare or layer-named groups around it; a root element may gain
    /// only its own data-layer. The echo page puts the
    /// svg layers (events under ring) in one svg and the legend after it, the first layer by name changed as page_alter says.
    #[test]
    fn the_page_holds_every_layer_as_rust_took_it() {
        // ring may hold events' bytes, so events is found only where ring's are not
        let page = |alter: Option<&str>, ring: &str| {
            runners()
                .iter()
                .map(|r| {
                    let events = layer("echo", "events", json!({"page_alter": alter}));
                    let ring = layer("echo", "ring", json!({"extra_svg": ring}));
                    let legend = layer("echo", "legend", json!({"html": "<div>图例</div>"}));
                    draw_page(r, 900.0, 460.0, json!({}), &[events, ring, legend])
                })
                .collect::<Vec<_>>()
        };
        let inner = r#"<g data-layer="events"></g>"#;
        for done in [page(None, ""), page(Some("own"), ""), page(Some("wrap"), ""), page(None, inner)].into_iter().flatten() {
            let (panel, html, records) = done.unwrap();
            assert_eq!(
                panel.layers.iter().map(|(n, _, h)| (n.as_str(), *h)).collect::<Vec<_>>(),
                [("events", false), ("ring", false), ("legend", true)]
            );
            assert!(html.contains("<div>图例</div>"), "{html}");
            assert_eq!(records.last().map(|r| (r.layer.as_str(), r.outcome.as_str())), Some(("page", "drawn")));
        }
        let lost = "page: the layer events is not on the page byte for byte as it was drawn";
        let hidden = "page: the layer events sits inside a comment, template, script, style or noscript, where nothing is drawn";
        let own = r#"of its own; past its layers an svg holds only <g>, </g> and <g data-layer="<a layer in it>">"#;
        let cases: [(&str, &str, &[&str]); 11] = [
            // changed in place: lost, and the changed group is no bare or layer-named group
            ("attr", "", &[lost, own]),
            ("other", "", &[lost, own]),
            // dropped, with its bytes still inside ring's
            ("drop", inner, &[lost]),
            // kept in a comment, a changed copy drawn in its place
            ("comment", "", &[hidden, own]),
            ("template", "", &[hidden, own]),
            // not taken, so its group names no layer in that svg
            ("twice", "", &["page: the layer events is on the page 2 times; it was drawn once", own]),
            // kept, and a changed copy drawn beside it
            ("extra", "", &["page: an svg draws \"<text>24%</text></g>\" of its own"]),
            // kept as is, inside a group that draws it elsewhere, hides it, or names a layer not in that svg
            ("moved", "", &[r#"page: an svg draws "<g transform=\"translate(400,0)\">" of its own"#]),
            ("hidden", "", &[r#"page: an svg draws "<g style=\"display:none\">" of its own"#]),
            ("stranger", "", &[r#"page: an svg draws "<g data-layer=\"zz\">" of its own"#]),
            (
                "reverse",
                "",
                &["page: the layers [\"events\", \"ring\"] are on the page as [\"ring\", \"events\"]; they keep the order they were drawn, bottom first"],
            ),
        ];
        for (alter, ring, want) in cases {
            for done in page(Some(alter), ring) {
                let (records, why) = done.unwrap_err();
                assert!(why.len() == want.len() && why.iter().zip(want).all(|(w, s)| w.contains(s)), "{alter}: {why:?}");
                assert_eq!(records.last().unwrap().outcome, "refused");
            }
        }
    }

    #[test]
    fn a_text_out_of_the_panel_on_a_line_over_a_text_with_no_src_or_no_place_is_refused() {
        let no_size = json!({"src": "name:x/DE", "text": "德国", "x": 10, "y": 30, "size": 0});
        let no_x = json!({"src": "name:x/DE", "text": "德国", "y": 30, "size": 12});
        let cases = [
            (
                json!({"texts": [text("name:x/DE", 890.0, 30.0)]}),
                "outside the panel",
            ),
            (json!({"texts": [text("", 10.0, 30.0)]}), "has no src"),
            (
                json!({"texts": [text("name:x/DE", 10.0, 54.0)]}),
                "sits on a line of base",
            ),
            (
                json!({"texts": [text("name:x/DE", 100.0, 30.0), text("name:x/FR", 110.0, 32.0)]}),
                "overlaps",
            ),
            (json!({"texts": [no_size]}), "has no size"),
            (json!({"texts": [no_x]}), "has no position"),
            // A text drawn but not reported, or reported but not drawn, would escape the checks.
            (
                json!({"texts": [], "extra_svg": "<text x=\"10\" y=\"54\">德国</text>"}),
                "the svg draws texts",
            ),
            (
                json!({"texts": [text("name:x/DE", 10.0, 30.0)], "extra_svg": "<g/>"}),
                "the svg draws texts",
            ),
            (json!({"dropped": ["卢森堡"]}), "no list node"),
            (
                json!({"frame": {"scale": 1}}),
                "only the base layer fixes the frame",
            ),
            (
                json!({"html": "<div>德国</div>", "texts": [text("name:x/DE", 10.0, 30.0)]}),
                "an html layer",
            ),
            (
                json!({"extra_svg": "<foreignObject width=\"90\" height=\"20\"><div>德国</div></foreignObject>"}),
                "which is not svg",
            ),
            (
                json!({"extra_svg": "<g><ForeignObject/></g>"}),
                "which is not svg",
            ),
            (json!({"extra_svg": "<g><div>德国</div></g>"}), "<div>, which is not svg"),
            (json!({"extra_svg": "<svg:foreignObject/>"}), "which is not svg"),
            (json!({"extra_svg": "<g onload=\"x()\"/>"}), "handler onload"),
            (json!({"extra_svg": "<g href=\"https://e.x/a.svg#p\"/>"}), "points outside the page"),
        ];
        for (knobs, why) in cases {
            let base = layer("echo", "base", json!({"lines": [[[0, 50], [900, 50]]]}));
            let got = reasons(&[base, layer("echo", "notes", knobs)]);
            assert!(got.iter().any(|r| r.contains(why)), "{why}: {got:?}");
        }
        // A later layer's line over an earlier layer's text is refused too.
        let notes = layer(
            "echo",
            "notes",
            json!({"texts": [text("name:x/DE", 10.0, 30.0)]}),
        );
        let flows = layer("echo", "flows", json!({"lines": [[[0, 27], [900, 27]]]}));
        assert!(reasons(&[notes, flows])[0].contains("a line runs over"));
    }

    #[test]
    fn a_turned_text_is_checked_as_drawn() {
        // "德国" at 12 px is 24×13.8; turned 90° about (100, 100) it stands from y 100 to 124, x 97 to 110.8.
        let turned = |x: f64| json!({"src": "name:x/DE", "text": "德国", "x": x, "y": 100, "size": 12, "anchor": "start", "rot": 90});
        let wide = layer("echo", "base", json!({"lines": [[[0, 120], [90, 120]]]}));
        let ok = layer("echo", "notes", json!({"texts": [turned(100.0)]}));
        for done in both(&[wide, ok]) {
            let (panel, _) = done.unwrap();
            let b = bounds(&panel.texts[0]);
            assert!(
                (b[1] - 100.0).abs() < 1e-9 && (b[3] - 124.0).abs() < 1e-9,
                "{b:?}"
            );
        }
        // Upright it would clear y 120; turned, it crosses the line at x 100–110.
        let line = layer("echo", "base", json!({"lines": [[[0, 120], [900, 120]]]}));
        let over = layer("echo", "notes", json!({"texts": [turned(100.0)]}));
        assert!(reasons(&[line, over])[0].contains("sits on a line"));
        // Two turned texts side by side 20 px apart do not touch; upright boxes 24 wide would.
        let pair = layer(
            "echo",
            "notes",
            json!({"texts": [turned(100.0), {"src": "name:x/FR", "text": "法国", "x": 120, "y": 100, "size": 12, "rot": 90}]}),
        );
        for done in both(&[pair]) {
            assert!(done.is_ok());
        }
        // A middle baseline centres the box on y.
        assert_eq!(
            text_box(0.0, 50.0, 10.0, "start", "middle", "德"),
            [0.0, 50.0 - 5.75, 10.0, 50.0 + 5.75]
        );
    }

    #[test]
    fn reservations_reach_every_layer_before_any_draws_and_html_layers_are_kept_apart() {
        let mut routes = layer(
            "echo",
            "routes",
            json!({"reserve_boxes": [[1, 2, 3, 4]], "reserve_lines": [{"pts": [[0, 0], [5, 5]], "own": "RU"}]}),
        );
        routes.reserve = true;
        let names = layer("echo", "names", json!({"echo_occ": true}));
        let callouts = layer(
            "echo",
            "callouts",
            json!({"html": "<div class=\"rc\">x</div>"}),
        );
        // routes reserves, then names draws below it and already sees routes' room.
        let layers = [names, routes, callouts];
        for done in both(&layers) {
            let (panel, records) = done.unwrap();
            assert_eq!(
                records
                    .iter()
                    .map(|r| (r.layer.as_str(), r.outcome.as_str()))
                    .collect::<Vec<_>>(),
                [
                    ("routes", "reserved"),
                    ("names", "drawn"),
                    ("routes", "drawn"),
                    ("callouts", "drawn")
                ]
            );
            assert!(
                panel.svg[0].contains("[1,2,3,4,&quot;routes&quot;]"),
                "{}",
                panel.svg[0]
            );
            assert!(
                panel.svg[0].contains("&quot;own&quot;:&quot;RU&quot;"),
                "{}",
                panel.svg[0]
            );
            assert_eq!(panel.html, ["<div class=\"rc\">x</div>"]);
            assert_eq!(panel.svg.len(), 2);
        }
    }

    #[test]
    fn the_leaf_registry_is_the_prototypes() {
        let t = leaves();
        let knobs: usize = t.nodes.values().map(|l| l.info.knobs.len()).sum();
        // ring.years and ring.months (the ring's window, read by layer 1) are two of them
        assert_eq!((t.nodes.len(), knobs), (26, 80));
        let reserve: Vec<_> = t.nodes.iter().filter(|(_, l)| l.reserve).map(|(n, _)| n.as_str()).collect();
        assert_eq!(reserve, ["flows", "labels", "routes"]);
        let legacy: Vec<_> = t.legacy.iter().map(|(n, at)| (n.as_str(), at.join("."))).collect();
        assert_eq!(legacy, [("base", "data".to_string()), ("frame", String::new())]);
        for l in t.nodes.values() {
            assert_eq!(crate::next_nodes::check_info(l.info), Vec::<String>::new());
        }
        assert!(Layer::registered("routes", "routes", json!([]), json!({})).is_ok_and(|l| l.reserve));
        assert!(Layer::registered("base", "base", json!([]), json!({})).is_ok_and(|l| !l.reserve));
        assert!(Layer::registered("pie", "pie", json!([]), json!({})).is_err_and(|e| e[0].contains("no leaf node pie")));
    }

    #[test]
    fn a_page_knob_off_the_registry_is_refused() {
        // The words the prototype's pages set are the registry's (page_knobs.json): base.member #efebe4, base.land #ecebe5.
        let ok = json!({"r": 300, "style": {"names": {"font": "serif"}, "labels": {"fit": "free"}, "edge": {"join": 60}},
            "data": {"member": "#efebe4", "land": "#ecebe5", "bw": 0.6}});
        assert_eq!(check_style(&ok), Vec::<String>::new());
        for (style, why) in [
            (json!({"style": {"edge": {"join": 61}}}), "style.edge.join: 61 is not 0..120 step 2; e.g. 0"),
            (json!({"style": {"names": {"font": "comic"}}}), "style.names.font: comic is not one of"),
            (json!({"style": {"names": {"glow": 1}}}), "names has no knob glow"),
            (json!({"style": {"pie": {"r": 1}}}), "no leaf node pie takes knobs"),
            (json!({"style": {"edge": {"join": true}}}), "neither a number nor a word"),
            (json!({"r": 999}), "r (read by frame): 999 is not 160..400 step 5"),
            (json!({"data": {"member": "#000000"}}), "data.member (read by base): #000000 is not one of"),
            (json!({"data": {"bw": 2.5}}), "data.bw (read by base): 2.5 is not"),
            (json!({"style": []}), "not a table of nodes"),
        ] {
            let got = check_style(&style);
            assert!(got.iter().any(|g| g.contains(why)), "{why}: {got:?}");
        }
        let knobs = json!({"spec": {"hero": {"style": {"edge": {"join": 61}}}}});
        assert!(Layer::registered("edge", "map.edge", json!([]), knobs).is_err_and(|e| e[0].starts_with("map.edge: style.edge.join")));
    }

    /// For the gates: the knob values of a stored request (`LEAF_REQ`, as the gate scripts dump it) against the registry.
    #[test]
    #[ignore]
    fn knob_values_of_a_stored_request() {
        let req: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("LEAF_REQ").expect("LEAF_REQ")).unwrap()).unwrap();
        let bad = check_style(&req["knobs"]["spec"]["hero"]);
        println!("knobcheck refused {}: {bad:?}", bad.len());
        assert!(bad.is_empty());
    }

    #[test]
    fn an_svg_layer_holds_svg_only() {
        // What the prototype's two pages draw passes, comments and inner references included.
        let plain = "<defs><clipPath id=\"c\"><rect width=\"9\" height=\"9\"/></clipPath><filter id=\"h\">\
            <feGaussianBlur stdDeviation=\"2\"/></filter></defs><!-- <div> --><g clip-path=\"url(#c)\">\
            <path d=\"M0 0L9 9\"/><text x='1' y=2>a &lt; b<tspan>c</tspan></text><path xlink:href=\"#c\"/></g>";
        assert_eq!(svg_markup(plain), None);
        assert!(read("<html><body><!--><b>44</b>--></body></html>").is_err_and(|e| e.contains("ends early")));
        for (bad, why) in [
            ("<g><B>德国</B></g>", "<B>, which is not svg"),
            ("<font color=\"red\">德国</font>", "<font>, which is not svg"),
            ("<feImage href=\"#a\"/>", "<feImage>, which is not svg"),
            ("<image href=\"a.png\"/>", "which is not svg"),
            ("<a><text>x</text></a>", "which is not svg"),
            ("<rect ONCLICK='x()'/>", "handler onclick"),
            ("<path xlink:href=\"other.svg#p\"/>", "points outside the page"),
            ("<use href=\"#c\"/>", "<use>, which is not svg"),
            ("<g><textPath>x</textPath></g>", "<textPath>, which is not svg"),
            ("<text x=\"1\" y=\"2\"><![CDATA[44%]]></text>", "CDATA"),
            ("<!--><text>44</text>-->", "ends early"),
            ("<!-- a --!><text>44</text><!-- -->", "ends early"),
            ("<!-- a -->b<div/>", "<div>, which is not svg"),
            ("<path href=\"#a", ""),
        ] {
            let got = svg_markup(bad);
            assert!(why.is_empty() || got.as_deref().is_some_and(|g| g.contains(why)), "{bad}: {got:?}");
        }
    }

    /// For the gates: every `.svg` in `LEAF_SVG_DIR` (the svg layers a run of the leaves drew) through the svg check;
    /// prints one line per refused file and the count.
    #[test]
    #[ignore]
    fn svg_layers_in_a_dir_hold_svg_only() {
        let dir = std::env::var("LEAF_SVG_DIR").expect("LEAF_SVG_DIR");
        let (mut seen, mut bad) = (0, 0);
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "svg") {
                seen += 1;
                if let Some(why) = svg_markup(&std::fs::read_to_string(&p).unwrap()) {
                    bad += 1;
                    println!("svgcheck refused {}: {why}", p.display());
                }
            }
        }
        println!("svgcheck files {seen} refused {bad}");
        assert!(seen > 0 && bad == 0);
    }

    #[test]
    fn the_drawn_texts_are_read_from_the_fragment() {
        assert_eq!(
            drawn_texts(
                "<g><text data-src=\"a\" x=\"1\">德&amp;国</text><text>净<tspan data-src=\"v/1\">155</tspan> 亿<tspan data-src=\"v/2\">3</tspan></text><text x=\"2\">缺</text></g>"
            ),
            [
                ("a".to_string(), "德&国".to_string()),
                ("v/1+v/2".to_string(), "净155 亿3".to_string()),
                (String::new(), "缺".to_string()),
            ]
        );
    }

    /// A leaf that prints a row's raw value gets through the bridge (its texts are marked and placed) but not the page: the
    /// number check reads the page back against the ledger.
    #[test]
    fn a_raw_row_value_a_leaf_prints_is_refused_by_the_page_check() {
        use crate::next_ledger::{check_numbers, Ledger, Num, READY_JS};
        let src = "series:nrg_ti_gasm/M.DE:2024-01:OBS_VALUE";
        let mut ledger = Ledger::default();
        ledger.num(
            "tspan",
            "n",
            &Num {
                src: src.into(),
                value: 1234.5678,
                text: "1234.6".into(),
            },
        );
        let ledger = ledger.finish().unwrap();
        let printed = |src: &str, text: &str, x: f64| json!({"src": src, "text": text, "x": x, "y": 30, "size": 12, "anchor": "start"});
        let notes = layer(
            "echo",
            "notes",
            json!({"texts": [
                printed(src, "1234.6", 10.0),
                printed(src, "1234.5678", 200.0),
                printed("series:nrg_ti_gasm/M.DE:2023-12:OBS_VALUE", "1180.2", 400.0),
            ]}),
        );
        let callouts = layer(
            "echo",
            "callouts",
            json!({"html": "<div class=\"rc\">1234.5678</div>"}),
        );
        for done in both(&[notes, callouts]) {
            let (panel, _) = done.unwrap();
            let page = format!(
                "<!doctype html><html><body><svg>{}</svg>{}<script>{READY_JS}</script></body></html>",
                panel.svg.join(""),
                panel.html.join("")
            );
            let off = check_numbers(&page, &ledger, &[]);
            assert_eq!(off.len(), 3, "{off:?}");
            assert!(off[0].contains("prints \"1234.5678\", its ledger entry is \"1234.6\""));
            assert!(off[1].contains("2023-12:OBS_VALUE is not in the ledger"));
            assert!(
                off[2].contains("the digits 1234.5678 in \"1234.5678\" come from no ledger entry")
            );
        }
    }

    #[test]
    fn a_leaf_that_refuses_hangs_or_dies_stops_the_panel() {
        let refusal = layer(
            "echo",
            "a",
            json!({"refused": ["width_max: 40 is not 1..30; e.g. 18"]}),
        );
        assert_eq!(reasons(&[refusal]), ["width_max: 40 is not 1..30; e.g. 18"]);
        for done in both(&[layer("echo", "a", json!({"hang": true}))]) {
            let (records, why) = done.unwrap_err();
            assert!(why[0].contains("no reply in"), "{why:?}");
            assert!(records[0].ms >= LAYER_DEADLINE.as_millis());
        }
        assert!(
            reasons(&[layer("echo", "a", json!({"exit": true}))])[0].contains("the leaf exited")
        );
        let missing = Runner {
            program: "no-such-leaf-runner".into(),
            args: vec![],
        };
        let (_, why) = draw(
            &missing,
            900.0,
            460.0,
            Value::Null,
            &[layer("echo", "a", json!({}))],
        )
        .unwrap_err();
        assert!(why[0].contains("did not start"), "{why:?}");
    }

    #[test]
    fn the_whole_page_check_reads_the_baked_page_and_skips_nothing() {
        use crate::next_facts::leaf_ledger;
        use crate::next_ledger::READY_JS;
        let mo = |t: &str| Row {
            src: format!("series:mo/X:{t}:v"),
            table: "mo".into(),
            dims: BTreeMap::new(),
            time: t.into(),
            value: 1.0,
        };
        let rows = [mo("2021-01"), mo("2021-02"), mo("2022-01")];
        let spec = Spec {
            facts: Vec::new(),
            fmts: json!({}),
            members: None,
        };
        let ledger = leaf_ledger(&spec, &rows, &[]).unwrap();
        let m = |src: &str| {
            format!(
                "<span data-src=\"period:mo:{src}\">{}</span>",
                ledger[&format!("period:mo:{src}")]
            )
        };
        let page = |body: &str| {
            format!("<!doctype html><html><body><p>{body}</p><footer>欧盟统计局 <span data-ref=\"\">MIGR_ASYAPPCTZM</span></footer><script>{READY_JS}</script></body></html>")
        };
        let refs = ["MIGR_ASYAPPCTZM".to_string()];
        let check = |html: &str| check_leaf_page(html, &ledger, &refs, &spec, &rows, &[]);
        let one_key = page(&format!("从 {} 年 {} 月起", m("2021-01.y"), m("2021-01.m")));
        assert_eq!(check(&one_key), Vec::<String>::new());
        // C2: a data-ref passes only when it equals one of the request's table ids: a World Bank id followed by "。" does,
        // a bare year in a data-ref does not
        let wb = ["AG.LND.AGRI.K2".to_string()];
        let wb_page = one_key.replace("MIGR_ASYAPPCTZM</span>", "AG.LND.AGRI.K2</span>。");
        assert_eq!(check_leaf_page(&wb_page, &ledger, &wb, &spec, &rows, &[]), Vec::<String>::new());
        let year = one_key.replace("MIGR_ASYAPPCTZM</span>", "2022</span>");
        assert!(!check(&year).is_empty(), "a data-ref 2022 passed");
        // a year and a month from two keys, each a true entry alone
        let two_keys = page(&format!("从 {} 年 {} 月起", m("2022-01.y"), m("2021-02.m")));
        assert_eq!(check(&two_keys).len(), 2, "{:?}", check(&two_keys));
        assert!(check(&two_keys)[0].starts_with("period:mo:2022-01.y: printed beside"));
        let alone = page(&format!("{} 年", m("2021-01.y")));
        assert_eq!(check(&alone).len(), 1, "{:?}", check(&alone));
        // a {key} the page's script builds at run time is only on the baked page; a ${...} refuses as well
        for (left, key) in [
            ("<p>{zz}</p>", "{zz}"),
            (
                "<style>.a::after{content:\"{sy23_share}\"}</style>",
                "{sy23_share}",
            ),
            ("<script>var a=\"{k.n}\";</script>", "{k.n}"),
            ("<p>US${gdp}</p>", "{gdp}"),
            ("<p>${k.n}</p>", "{k.n}"),
        ] {
            let html = page(&format!(
                "{}{left}",
                m("2021-01.y") + " 年 " + &m("2021-01.m")
            ));
            assert!(
                check(&html).contains(&format!("page: the page still holds the placeholder {key}")),
                "{left}: {:?}",
                check(&html)
            );
        }
        assert_eq!(placeholders("<script>`${a}`; x={a:1}; y={ }</script>"), ["{a}"]);
        assert!(placeholders(READY_JS).is_empty());
        // a table id the request does not name, and an entry the rows do not give
        let off = check(&page("").replace("MIGR_ASYAPPCTZM", "MIGR_ASYAPPCTZA"));
        assert_eq!(off.len(), 1, "{off:?}");
        let mut bent = ledger.clone();
        bent.insert("period:mo:2021-03.m".into(), "3".into());
        assert_eq!(
            check_leaf_page(&page(""), &bent, &refs, &spec, &rows, &[]),
            ["period:mo:2021-03.m: no row of mo is in that month"]
        );
    }

    /// The whole-page check on one stored page (LEAF_REQ, LEAF_PAGE; its refs from next_facts::leaf_refs over the spec's tables; run with
    /// --ignored), for the gate that checks the dev questions' leaf pages with the ledger layer 1 gives.
    #[test]
    #[ignore]
    fn leaf_page_check_for_a_stored_page() {
        use crate::next_facts::{compute, leaf_ledger, stored_request};
        let req: Value = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("LEAF_REQ").unwrap()).unwrap(),
        )
        .unwrap();
        let html = std::fs::read_to_string(std::env::var("LEAF_PAGE").unwrap()).unwrap();
        let refs = crate::next_facts::leaf_refs(&req["knobs"]["spec"]["tables"]).unwrap();
        let (spec, rows, _) = stored_request(&req);
        let facts = compute(&spec, &rows).unwrap();
        let ledger = leaf_ledger(&spec, &rows, &facts).unwrap();
        let off = match std::env::var("BAKE_OUT") {
            Err(_) => check_leaf_page(&html, &ledger, &refs, &spec, &rows, &facts),
            Ok(out) => {
                let python = Runner::python(Path::new("runtime/leaves_py/bake.py"));
                match bake_leaf_page(&python, &html, &ledger, &refs, (&spec, &rows, &facts)) {
                    Ok(baked) => {
                        std::fs::write(&out, &baked.html).unwrap();
                        println!("baked ms {} scripts {}", baked.ms, baked.html.matches("<script").count());
                        Vec::new()
                    }
                    Err(off) => off,
                }
            }
        };
        println!("findings {}", off.len());
        for f in off {
            println!("finding {f}");
        }
    }
}
