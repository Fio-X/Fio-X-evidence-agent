//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! It holds no state and writes nothing; its one host tool, the image-aware critic, it only names and hands back to run on the
//! host the caller lends. A page it draws by its recipe (next_render) and checks against the ledger it came back with before
//! handing it out; a page that passes has passed the visual gate only, which says nothing about whether a number is verified.
//! A leaf page it draws and bakes; the flow writes it (group_guard, inside this group's door) and asks here whether the
//! browser check passed those bytes.

use crate::next_facts::{compute, leaf_ledger, leaf_refs, stored_request, Fact, Row, Spec};
use crate::next_leaf::{bake_leaf_page, draw_page, leaves, Layer, Recipe, Record, Runner};
use crate::next_ledger::check_numbers;
use crate::next_nodes::{Kind, Style};
use crate::next_render::{render, PageSpec, Rendered};
use crate::shape_registry::{Matched, PagePlan, Relation, Shape, View};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The image-aware critic: the model's verdict on the previewed page, kept as a QA record before publication.
pub const VISION_CRITIC_TOOL: &str = "newsroom_infographic_vision_critic";

pub enum Request<'a> {
    /// Every relation ranked for one data slice: `registered` lists the templates the registry has, `used_before` the
    /// relations earlier panels on the page already picked.
    Rank {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The same, in the first-to-last view only and whatever the slice's size: for a series of each entity's first and last
    /// value.
    RankFirstToLast {
        shape: &'a Shape,
        registered: &'a [&'a str],
        used_before: &'a [Relation],
    },
    /// The page plan row (PAGE_PLANS) of each chart's relation and view, in chart order.
    PagePlan { forms: &'a [(Relation, View)] },
    /// One run of `VISION_CRITIC_TOOL` on the host the caller lends, with these arguments.
    VisionCritic {
        host: crate::next_flow::HostRun<'a>,
        args: Value,
    },
    /// The page for this spec by the column recipe, its knobs at their defaults.
    #[allow(dead_code)]
    // to be wired: the flow asks for its page here when the recipe opens (a user nod)
    Page { spec: &'a PageSpec },
    /// The leaf page for these layers: drawn by the leaf child (the layers byte for byte as Rust took them, draw_page), then
    /// baked and checked (bake_leaf_page). Nothing is written.
    LeafPage { page: &'a LeafPage<'a> },
    /// A leaf page's pieces from a filled request (plain JSON: the series rows, the knobs with the spec, and the layer names
    /// in order) by a page recipe, a composite node of the leaf registry (runtime/leaves_py/knobs.json groups): the facts
    /// computed from the rows, their ledger, the refs, and one layer of the recipe's node per name, each a layer the
    /// recipe groups, with the rows, the ledger as {src, text} rows and the knobs; and the children that draw, bake and
    /// check it, from the second layer under `runtime` (the run's materialized runtime/). Nothing is drawn or written.
    LeafFill {
        recipe: &'a str,
        rows: &'a [Value],
        knobs: &'a Value,
        order: &'a [String],
        runtime: &'a Path,
    },
    /// One run of the browser check (runtime/pi/browser_qa.py as the run materialized it, or a twin) on the page file at
    /// `html`, with `QA_SPEC` written beside its report in `out`: whether its report is a PASS for the bytes `html_sha256`.
    BrowserCheck {
        qa: &'a Runner,
        html: &'a Path,
        out: &'a Path,
        html_sha256: &'a str,
    },
    /// A number knob of a leaf node as the registry states it (runtime/leaves_py/knobs.json, next_leaf::leaves): its default
    /// and range. A word knob, or one the node does not have, is no number.
    Knob { node: &'a str, knob: &'a str },
    /// The page recipes of the leaf registry (runtime/leaves_py/knobs.json recipes), in the order the flow tries them.
    Recipes,
}

/// What a leaf page is drawn from: the leaf child and the bake, the panel, its layers, and the ledger with the refs, spec,
/// rows and facts the baked page is checked against.
pub struct LeafPage<'a> {
    pub draw: &'a Runner,
    pub bake: &'a Runner,
    pub w: f64,
    pub h: f64,
    pub frame: Value,
    pub layers: &'a [Layer<'a>],
    pub ledger: &'a BTreeMap<String, String>,
    pub refs: &'a [String],
    pub facts: (&'a Spec, &'a [Row], &'a [Fact]),
}

/// A leaf page drawn and baked: the baked page, the one the browser check and the manifest are to name, and the leaf child's
/// records.
pub struct LeafDrawn {
    pub html: String,
    pub records: Vec<Record>,
}

/// A leaf page as LeafFill built it, owned but for the layer names: the flow lends it as a LeafPage with its draw and bake
/// children, and its browser check child to the publication.
pub struct LeafFill<'a> {
    pub layers: Vec<Layer<'a>>,
    pub ledger: BTreeMap<String, String>,
    pub refs: Vec<String>,
    pub spec: Spec,
    pub rows: Vec<Row>,
    pub facts: Vec<Fact>,
    pub frame: Value,
    pub w: f64,
    pub h: f64,
    pub draw: Runner,
    pub bake: Runner,
    pub qa: Runner,
}

/// The panel a filled page is drawn in: the page's width, its height left to the child (0), no frame.
const FILL_W: f64 = 1140.0;
const FILL_H: f64 = 0.0;

/// The pieces of a filled leaf page (Request::LeafFill). Err lists what does not compute or register, one per line; a
/// recipe the registry does not group, or a layer it does not hold, names what it holds and one example.
fn fill<'a>(
    recipe: &'a str,
    rows: &[Value],
    knobs: &Value,
    order: &'a [String],
    runtime: &Path,
) -> Result<LeafFill<'a>, String> {
    let groups = &leaves().groups;
    let Some(holds) = groups.get(recipe) else {
        let names: Vec<_> = groups.keys().map(String::as_str).collect();
        return Err(format!("fill: no recipe {recipe}; e.g. one of {}", names.join("|")));
    };
    let stray: Vec<String> = order
        .iter()
        .filter(|n| !holds.contains(n))
        .map(|n| format!("fill: the recipe {recipe} holds no layer {n}; e.g. one of {}", holds.join("|")))
        .collect();
    if !stray.is_empty() {
        return Err(stray.join("\n"));
    }
    let (spec, table_rows, _) = stored_request(&json!({"knobs": knobs, "rows": rows}));
    let facts = compute(&spec, &table_rows)?;
    let ledger = leaf_ledger(&spec, &table_rows, &facts)?;
    let refs = leaf_refs(&knobs["spec"]["tables"])?;
    let mut knobs = knobs.clone();
    one_mark_per_period(&mut knobs, &facts);
    let mut all = rows.to_vec();
    all.extend(ledger.iter().map(|(src, text)| json!({"src": src, "text": text})));
    let all = Value::Array(all);
    let (mut layers, mut off) = (Vec::new(), Vec::new());
    for name in order {
        match Layer::registered(recipe, name, all.clone(), knobs.clone()) {
            Ok(layer) => layers.push(layer),
            Err(e) => off.extend(e),
        }
    }
    if !off.is_empty() {
        return Err(off.join("\n"));
    }
    Ok(LeafFill {
        layers,
        ledger,
        refs,
        spec,
        rows: table_rows,
        facts,
        frame: Value::Null,
        w: FILL_W,
        h: FILL_H,
        draw: Runner::python(&runtime.join("leaves_py/run.py")),
        bake: Runner::python(&runtime.join("leaves_py/bake.py")),
        qa: Runner::python(&runtime.join("browser_qa.py")),
    })
}

/// The ring's marks (hero.ring.marks, each {key: <fact>}) keep one per period: a mark whose fact was read at the period of
/// a mark before it (a peak in the last month) is dropped, so two marks never sit on one month.
fn one_mark_per_period(knobs: &mut Value, facts: &[Fact]) {
    let Some(marks) = knobs.pointer_mut("/spec/hero/ring/marks").and_then(Value::as_array_mut) else {
        return;
    };
    let mut seen: Vec<String> = Vec::new();
    marks.retain(|m| match facts.iter().find(|f| m["key"] == f.key.as_str()).and_then(|f| f.t.clone()) {
        Some(t) if seen.contains(&t) => false,
        Some(t) => {
            seen.push(t);
            true
        }
        None => true,
    });
}

/// The program's browser check for a leaf page: the desktop width the bake lays the page out at, as an archive page.
pub const QA_SPEC: &str = r#"{"delivery":{"breakpoints":[1440],"packaging":"archive"}}"#;
/// How long the browser check may take before it is stopped and the page left unpublished.
const QA_DEADLINE: Duration = Duration::from_secs(90);

pub enum Reply<'a> {
    /// Best first; no candidate means narrow the filter.
    Matched(Matched),
    /// One row per relation asked, in the same order.
    Plans(Vec<&'static PagePlan>),
    /// The critic's run, which the caller awaits.
    Run(crate::next_flow::ToolFuture<'a>),
    /// The drawn page and its ledger; every digit on it was found printing its ledger entry or naming a table the spec names.
    Page(Rendered),
    /// The leaf page, baked and checked.
    Leaf(LeafDrawn),
    /// The filled page's pieces, for the flow to lend as a LeafPage.
    Filled(LeafFill<'a>),
    /// The browser check's PASS report for the bytes asked about.
    Checked(Value),
    /// A number knob's default and range.
    Knob { default: f64, min: f64, max: f64 },
    /// The page recipes, in registry order.
    Recipes(&'static [Recipe]),
}

/// The visual group's command. Only a page can fail: Err lists what could not be drawn, or every digit the page check found
/// off the ledger (one per line); no page leaves with one.
pub fn call(request: Request<'_>) -> Result<Reply<'_>, String> {
    Ok(match request {
        Request::Rank {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank(shape, registered, used_before)),
        Request::RankFirstToLast {
            shape,
            registered,
            used_before,
        } => Reply::Matched(crate::shape_registry::rank_first_to_last(
            shape,
            registered,
            used_before,
        )),
        Request::PagePlan { forms } => Reply::Plans(
            forms
                .iter()
                .map(|(r, v)| crate::shape_registry::page_plan(*r, *v))
                .collect(),
        ),
        Request::VisionCritic { host, args } => Reply::Run(host(VISION_CRITIC_TOOL, args)),
        Request::Page { spec } => {
            let page = render(spec, &Style::default())?;
            let off = check_numbers(&page.html, &page.ledger, &spec.refs);
            if !off.is_empty() {
                return Err(off.join("\n"));
            }
            Reply::Page(page)
        }
        Request::LeafPage { page } => {
            let (_, html, records) =
                draw_page(page.draw, page.w, page.h, page.frame.clone(), page.layers).map_err(|(_, why)| why.join("\n"))?;
            let baked = bake_leaf_page(page.bake, &html, page.ledger, page.refs, page.facts).map_err(|off| off.join("\n"))?;
            Reply::Leaf(LeafDrawn {
                html: baked.html,
                records,
            })
        }
        Request::LeafFill { recipe, rows, knobs, order, runtime } => Reply::Filled(fill(recipe, rows, knobs, order, runtime)?),
        Request::BrowserCheck {
            qa,
            html,
            out,
            html_sha256,
        } => Reply::Checked(passed(browser_check(qa, html, out)?, html_sha256)?),
        Request::Knob { node, knob } => {
            let leaf = leaves().nodes.get(node).ok_or_else(|| format!("knob: the leaf registry has no node {node}"))?;
            match leaf.info.knobs.iter().find(|k| k.name == knob).map(|k| &k.kind) {
                Some(Kind::Range { default, min, max, .. }) => Reply::Knob { default: *default, min: *min, max: *max },
                Some(Kind::Pick { .. }) => return Err(format!("knob: {node}.{knob} is a word, not a number")),
                None => return Err(format!("knob: node {node} has no knob {knob}")),
            }
        }
        Request::Recipes => Reply::Recipes(&leaves().recipes),
    })
}

/// The report, when it is a PASS for the bytes `html_sha256`; a FAIL (with its first errors) or a PASS for other bytes is no
/// pass.
fn passed(report: Value, html_sha256: &str) -> Result<Value, String> {
    let status = report["status"].as_str().unwrap_or("no status");
    if status != "PASS" {
        let errors: Vec<&str> = report["errors"].as_array().into_iter().flatten().filter_map(Value::as_str).take(8).collect();
        return Err(format!("browser check: {status}: {}", errors.join("; ")));
    }
    if report["html_sha256"].as_str() != Some(html_sha256) {
        return Err(format!(
            "browser check: the PASS report is for html_sha256 {}, not the page written ({html_sha256})",
            report["html_sha256"]
        ));
    }
    Ok(report)
}

/// One run of the browser check on `html` (`--html --spec --output`, the spec beside its report in `out`): the report it
/// wrote. Its exit code is its status (browser_qa.py), so only the report is read; none within QA_DEADLINE is an error.
fn browser_check(runner: &Runner, html: &Path, out: &Path) -> Result<Value, String> {
    let mut child = Command::new(&runner.program)
        .args(&runner.args)
        .arg("--html")
        .arg(html)
        .arg("--spec")
        .arg(out.join("spec.json"))
        .arg("--output")
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("browser check: {} would not start: {e}", runner.program))?;
    let started = Instant::now();
    while child.try_wait().map_err(|e| format!("browser check: {e}"))?.is_none() {
        if started.elapsed() > QA_DEADLINE {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("browser check: no report within {}s", QA_DEADLINE.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::fs::read_to_string(out.join("browser-qa.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| "browser check: it wrote no readable browser-qa.json".to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A peak in the ring's last month leaves one mark there; marks on two months, or naming no computed fact, all stay.
    #[test]
    fn a_ring_mark_on_a_month_another_mark_has_is_dropped() {
        let fact = |key: &str, t: &str| Fact {
            key: key.into(),
            op: "peak".into(),
            v: 1.0,
            t: Some(t.into()),
            n: None,
            who: Vec::new(),
            fmt: "m".into(),
            reads: Vec::new(),
        };
        let marks = |facts: &[Fact]| {
            let mut knobs = json!({"spec": {"hero": {"ring": {"marks": [{"key": "p"}, {"key": "l"}, {"key": "x"}]}}}});
            one_mark_per_period(&mut knobs, facts);
            knobs["spec"]["hero"]["ring"]["marks"].clone()
        };
        assert_eq!(marks(&[fact("p", "2024-03"), fact("l", "2024-03")]), json!([{"key": "p"}, {"key": "x"}]));
        assert_eq!(marks(&[fact("p", "2022-01"), fact("l", "2024-03")]), json!([{"key": "p"}, {"key": "l"}, {"key": "x"}]));
    }

    /// The ring's window knobs come from the registry with their ranges; a word knob or a missing one is no number.
    #[test]
    fn a_number_knob_is_read_from_the_registry_and_nothing_else_is() {
        let knob = |node, knob| match call(Request::Knob { node, knob }) {
            Ok(Reply::Knob { default, min, max }) => Ok((default, min, max)),
            Ok(_) => panic!("knob answered with another reply"),
            Err(e) => Err(e),
        };
        assert_eq!(knob("ring", "years"), Ok((5.0, 2.0, 10.0)));
        assert_eq!(knob("ring", "months"), Ok((60.0, 24.0, 120.0)));
        assert_eq!(knob("ring", "color"), Err("knob: ring.color is a word, not a number".to_string()));
        assert_eq!(knob("ring", "decades"), Err("knob: node ring has no knob decades".to_string()));
        assert_eq!(knob("rings", "years"), Err("knob: the leaf registry has no node rings".to_string()));
    }
}
