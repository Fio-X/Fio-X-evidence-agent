//! New route, visual group: its one group command. Another group reaches the chart matcher only through `call`, with a
//! `Request` and back a `Reply` (both shared types under rule one); the matcher itself (shape_registry.rs) stays this group's.
//! It holds no state and writes nothing; its one host tool, the image-aware critic, it only names and hands back to run on the
//! host the caller lends. A page it draws by its recipe (next_render) and checks against the ledger it came back with before
//! handing it out; a page that passes has passed the visual gate only, which says nothing about whether a number is verified.
//! A leaf page it draws and bakes; the flow writes it (group_guard, inside this group's door) and asks here whether the
//! browser check passed those bytes.

use crate::next_facts::{Fact, Row, Spec};
use crate::next_leaf::{bake_leaf_page, draw_page, Layer, Record, Runner};
use crate::next_ledger::check_numbers;
use crate::next_nodes::Style;
use crate::next_render::{render, PageSpec, Rendered};
use crate::shape_registry::{Matched, PagePlan, Relation, Shape, View};
use serde_json::Value;
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
    /// One run of the browser check (runtime/pi/browser_qa.py as the run materialized it, or a twin) on the page file at
    /// `html`, with `QA_SPEC` written beside its report in `out`: whether its report is a PASS for the bytes `html_sha256`.
    BrowserCheck {
        qa: &'a Runner,
        html: &'a Path,
        out: &'a Path,
        html_sha256: &'a str,
    },
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
    /// The browser check's PASS report for the bytes asked about.
    Checked(Value),
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
        Request::BrowserCheck {
            qa,
            html,
            out,
            html_sha256,
        } => Reply::Checked(passed(browser_check(qa, html, out)?, html_sha256)?),
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

