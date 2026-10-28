//! New route, visual group: the bridge to the second layer's leaf nodes (plans design-1028-node-contract). One child per panel
//! (a Node or a Python script, `Runner`); each layer is one JSON line in and one line out. Layers that reserve room are asked
//! first (`"phase": "reserve"`), in order, for the boxes and lines they will need; then every layer draws, bottom first, so a
//! layer sees the frame the base fixed, every box and line the layers under it took and every reservation. The child gets a
//! cleared environment (PATH, HOME, LANG only) and a deadline per layer. An SVG reply is taken only when every text it printed
//! has a `data-src`, a position, lies inside the panel, and touches no text or line of another layer, and it dropped nothing;
//! an HTML reply (text laid out in the browser) has no boxes here and is checked in the browser. The page's number check
//! (next_ledger::check_numbers) runs on the page as before. Each call leaves one record (node, layer, milliseconds, outcome)
//! for the caller's program event.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::next_ledger::{tag_end, tag_parts, unescape, READ_ATTRS, VOID};
use crate::next_nodes::{tw, Bx};

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

    /// `python3 -I <script>`: no user site, no PYTHON* variables, the script's folder not on the path unless it puts it there.
    pub fn python(script: &Path) -> Runner {
        Runner {
            program: "python3".into(),
            args: vec!["-I".into(), script.display().to_string()],
        }
    }
}

/// One layer to draw: a registered leaf node under its layer name, with its rows (long table, every printed value as
/// {src, text}) and its knobs already checked against the registry; `reserve` when the registry says it claims room first.
pub struct Layer<'a> {
    pub node: &'a str,
    pub layer: &'a str,
    pub rows: Value,
    pub knobs: Value,
    pub reserve: bool,
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
/// the base fixed.
#[derive(Debug, Default)]
pub struct Panel {
    pub svg: Vec<String>,
    pub html: Vec<String>,
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
        return Ok(());
    }
    let svg = reply["svg"]
        .as_str()
        .ok_or_else(|| vec![format!("{layer}: no svg")])?;
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
    drop(stdin);
    stop(child);
    Ok((panel, records))
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
            rest = comment.find("-->").map_or("", |e| &comment[e + 3..]);
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
}
