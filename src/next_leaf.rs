//! New route, visual group: the bridge to the second layer's leaf nodes (plans design-1028-node-contract). One Node child per
//! panel runs `runtime/nodes/run.mjs`; each layer is one JSON line in and one line out, bottom layer first, so a layer sees the
//! frame the base fixed and every box and line the layers under it took. The child gets a cleared environment (PATH, HOME,
//! LANG only) and a deadline per layer. A reply is taken only when every text it printed has a `data-src`, lies inside the
//! panel, and touches no text or line of another layer; the page's number check (next_ledger::check_numbers) runs on the page
//! as before. Each layer leaves one record (node, layer, milliseconds, outcome) for the caller's program event.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::next_nodes::{tw, Bx};

/// How long one layer may take before the child is stopped and the layer refused.
pub const LAYER_DEADLINE: Duration = Duration::from_secs(2);

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

/// One layer to draw: a registered leaf node under its layer name, with its rows (long table, every printed value as
/// {src, text}) and its knobs already checked against the registry.
pub struct Layer<'a> {
    pub node: &'a str,
    pub layer: &'a str,
    pub rows: Value,
    pub knobs: Value,
}

/// A text the leaf printed, with the box the first layer's width rule gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct Text {
    pub src: String,
    pub text: String,
    pub layer: String,
    pub bx: Bx,
}

/// What one layer cost and how it ended, for the caller's program event.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub node: String,
    pub layer: String,
    pub ms: u128,
    pub outcome: String,
}

/// The panel as drawn: each layer's SVG fragment bottom first, every text with its box, the frame the base fixed.
#[derive(Debug, Default)]
pub struct Panel {
    pub svg: Vec<String>,
    pub texts: Vec<Text>,
    pub lines: Vec<(String, Vec<(f64, f64)>)>,
    pub frame: Value,
}

/// The box of a text drawn at (x, y) on its baseline with the given anchor, by `tw`.
fn text_box(x: f64, y: f64, size: f64, anchor: &str, text: &str) -> Bx {
    let w = tw(text, size);
    let x0 = match anchor {
        "middle" => x - w / 2.0,
        "end" => x - w,
        _ => x,
    };
    [x0, y - size * 0.88, x0 + w, y + size * 0.24]
}

fn overlap(a: &Bx, b: &Bx) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

fn on_line(b: &Bx, pts: &[(f64, f64)]) -> bool {
    pts.iter().any(|&(x, y)| {
        b[0] - LINE_PAD < x && x < b[2] + LINE_PAD && b[1] - LINE_PAD < y && y < b[3] + LINE_PAD
    })
}

/// Every reason a reply cannot go on the panel: a text with no source or out of the panel, a text over another text or over a
/// line of another layer, a line of this layer over a text below it.
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
        let b = t.bx;
        if t.src.is_empty() {
            out.push(format!("{layer}: {:?} has no src", t.text));
        }
        if b[0] < 0.0 || b[1] < 0.0 || b[2] > w || b[3] > h {
            out.push(format!(
                "{layer}: {:?} at {b:?} is outside the panel {w}x{h}",
                t.text
            ));
        }
        for o in panel.texts.iter().chain(&texts[i + 1..]) {
            if overlap(&b, &o.bx) {
                out.push(format!(
                    "{layer}: {:?} overlaps {:?} of {}",
                    t.text, o.text, o.layer
                ));
            }
        }
        for (other, pts) in &panel.lines {
            if on_line(&b, pts) {
                out.push(format!("{layer}: {:?} sits on a line of {other}", t.text));
            }
        }
    }
    for t in &panel.texts {
        if lines.iter().any(|pts| on_line(&t.bx, pts)) {
            out.push(format!(
                "{layer}: a line runs over {:?} of {}",
                t.text, t.layer
            ));
        }
    }
    out
}

/// Reads one reply into the panel, or the reasons it was refused.
fn take(panel: &mut Panel, w: f64, h: f64, layer: &str, reply: &Value) -> Result<(), Vec<String>> {
    let refused: Vec<String> = reply["refused"]
        .as_array()
        .map(|r| {
            r.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !refused.is_empty() {
        return Err(refused);
    }
    let svg = reply["svg"]
        .as_str()
        .ok_or_else(|| vec![format!("{layer}: no svg")])?;
    let texts: Vec<Text> = reply["texts"]
        .as_array()
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    let s = |k: &str| t[k].as_str().unwrap_or("").to_string();
                    let n = |k: &str| t[k].as_f64().unwrap_or(f64::NAN);
                    Text {
                        src: s("src"),
                        text: s("text"),
                        layer: layer.to_string(),
                        bx: text_box(n("x"), n("y"), n("size"), &s("anchor"), &s("text")),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
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
    let bad = faults(panel, w, h, layer, &texts, &lines);
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

/// A refused panel: the records so far and every reason the refused layer gave.
pub type Refused = (Vec<Record>, Vec<String>);

/// Draws a panel of `w`×`h` from its layers, bottom first, through `node script`. Err: the records so far and every reason
/// the first refused layer gave; nothing of a refused panel is kept.
pub fn draw(
    script: &Path,
    w: f64,
    h: f64,
    frame: Value,
    layers: &[Layer<'_>],
) -> Result<(Panel, Vec<Record>), Refused> {
    let mut records = Vec::new();
    let mut child = match Command::new("node")
        .arg(script)
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
    {
        Ok(c) => c,
        Err(e) => return Err((records, vec![format!("node did not start: {e}")])),
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        stop(child);
        return Err((records, vec!["node gave no pipes".into()]));
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut panel = Panel {
        frame,
        ..Panel::default()
    };
    for l in layers {
        let started = Instant::now();
        let occ_boxes: Vec<Value> = panel
            .texts
            .iter()
            .map(|t| json!([t.bx[0], t.bx[1], t.bx[2], t.bx[3], t.layer]))
            .collect();
        let occ_lines: Vec<Value> = panel
            .lines
            .iter()
            .map(|(layer, pts)| json!({"layer": layer, "pts": pts.iter().map(|&(x, y)| json!([x, y])).collect::<Vec<_>>()}))
            .collect();
        let request = json!({
            "node": l.node, "layer": l.layer, "panel": {"w": w, "h": h, "frame": panel.frame},
            "rows": l.rows, "knobs": l.knobs, "occ": {"boxes": occ_boxes, "lines": occ_lines},
        });
        let record = |outcome: String| Record {
            node: l.node.to_string(),
            layer: l.layer.to_string(),
            ms: started.elapsed().as_millis(),
            outcome,
        };
        if writeln!(stdin, "{request}")
            .and_then(|_| stdin.flush())
            .is_err()
        {
            records.push(record("node closed its input".into()));
            stop(child);
            return Err((records, vec![format!("{}: node closed its input", l.layer)]));
        }
        let reply = match rx.recv_timeout(LAYER_DEADLINE) {
            Ok(Ok(line)) => serde_json::from_str::<Value>(&line)
                .map_err(|e| format!("{}: reply is not JSON: {e}", l.layer)),
            Ok(Err(e)) => Err(format!("{}: reading the reply: {e}", l.layer)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(format!("{}: no reply in {:?}", l.layer, LAYER_DEADLINE))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("{}: node exited", l.layer)),
        };
        let taken = reply
            .map_err(|e| vec![e])
            .and_then(|r| take(&mut panel, w, h, l.layer, &r));
        match taken {
            Ok(()) => records.push(record("drawn".into())),
            Err(why) => {
                records.push(record("refused".into()));
                stop(child);
                return Err((records, why));
            }
        }
    }
    drop(stdin);
    stop(child);
    Ok((panel, records))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ECHO: &str = "fixtures/next_leaf/echo.mjs";

    fn layer<'a>(node: &'a str, name: &'a str, knobs: Value) -> Layer<'a> {
        Layer {
            node,
            layer: name,
            rows: json!([]),
            knobs,
        }
    }

    /// The echo leaf (fixtures) prints what its knobs say, so each check can be met head on.
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
        let (panel, records) = draw(
            Path::new(ECHO),
            900.0,
            460.0,
            json!({"projection": "equalEarth"}),
            &[base, label],
        )
        .unwrap();
        assert_eq!(panel.svg.len(), 2);
        assert_eq!(panel.frame, json!({"scale": 140}));
        // The second layer was handed the frame the base fixed and the base's line.
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
            [10.0, 30.0 - 12.0 * 0.88, 46.0, 30.0 + 12.0 * 0.24]
        );
    }

    #[test]
    fn a_text_out_of_the_panel_on_a_line_over_a_text_or_with_no_src_is_refused() {
        let text = |src: &str, x: f64, y: f64| json!({"src": src, "text": "德国", "x": x, "y": y, "size": 12, "anchor": "start"});
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
        ];
        for (knobs, why) in cases {
            let base = layer("echo", "base", json!({"lines": [[[0, 50], [900, 50]]]}));
            let (records, reasons) = draw(
                Path::new(ECHO),
                900.0,
                460.0,
                Value::Null,
                &[base, layer("echo", "notes", knobs)],
            )
            .unwrap_err();
            assert!(
                reasons.iter().any(|r| r.contains(why)),
                "{why}: {reasons:?}"
            );
            assert_eq!(records.last().unwrap().outcome, "refused");
        }
        // A later layer's line over an earlier layer's text is refused too.
        let notes = layer(
            "echo",
            "notes",
            json!({"texts": [text("name:x/DE", 10.0, 30.0)]}),
        );
        let flows = layer("echo", "flows", json!({"lines": [[[0, 27], [900, 27]]]}));
        let (_, reasons) =
            draw(Path::new(ECHO), 900.0, 460.0, Value::Null, &[notes, flows]).unwrap_err();
        assert!(reasons[0].contains("a line runs over"), "{reasons:?}");
    }

    #[test]
    fn a_leaf_that_refuses_hangs_or_dies_stops_the_panel() {
        let (_, reasons) = draw(
            Path::new(ECHO),
            900.0,
            460.0,
            Value::Null,
            &[layer(
                "echo",
                "a",
                json!({"refused": ["width_max: 40 is not 1..30; e.g. 18"]}),
            )],
        )
        .unwrap_err();
        assert_eq!(reasons, ["width_max: 40 is not 1..30; e.g. 18"]);
        let (records, reasons) = draw(
            Path::new(ECHO),
            900.0,
            460.0,
            Value::Null,
            &[layer("echo", "a", json!({"hang": true}))],
        )
        .unwrap_err();
        assert!(reasons[0].contains("no reply in"), "{reasons:?}");
        assert!(records[0].ms >= LAYER_DEADLINE.as_millis());
        let (_, reasons) = draw(
            Path::new(ECHO),
            900.0,
            460.0,
            Value::Null,
            &[layer("echo", "a", json!({"exit": true}))],
        )
        .unwrap_err();
        assert!(reasons[0].contains("node exited"), "{reasons:?}");
    }
}
