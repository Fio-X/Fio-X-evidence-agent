//! The new route's completion gate for a published leaf page (works/gate-1029 gate table): which publication is one, and what
//! it still lacks. Pure over the run folder's files; the completion check (investigate.rs) and verification (verify.rs) both
//! read it, and neither takes a page for a leaf page on its manifest's word alone.

use crate::l5geo::TableMeta;
use crate::next_facts::{Fact, Row, Spec};
use crate::next_flow::{knowledge_call, visual_call, LEAF_REQUEST};
use crate::next_run::{leaf_plan_ref, RING_ACTOR, RING_EVENT};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;

/// The longest headline and dek a page may print (the old critic's clarity limits, in characters).
const TITLE_MAX: usize = 100;
const DEK_MAX: usize = 300;

/// GAP-2 (gate table): the layers that answer each kind of view a question asks for (prompt::required_visual_modes), matched
/// against a recipe's layers with its groups expanded (the visual group's RecipeLayers). A kind with none, network, is never
/// answered on the new route.
const MODE_LAYERS: &[(&str, &[&str])] = &[
    ("spatial", &["map"]),
    ("flow", &["flows", "flowmap"]),
    ("trend", &["strip", "ring", "profile", "stack_area", "step"]),
    ("composition", &["stack_area"]),
    ("change", &["bars", "slope"]),
    ("benchmark", &["bars", "slope"]),
    ("network", &[]),
];

/// One fetch the knowledge group recorded: the table, the file under data/ and the sha256 of the bytes it wrote there.
pub struct Fetch {
    pub table: String,
    pub file: String,
    pub sha256: String,
}

/// What the leaf page in publications/<dir>/ still lacks, or None when it is no leaf page of this run: its manifest says
/// kind leaf_page, the run is the new route's (runtime/next-page.json), and a RING_EVENT of the flow (RING_ACTOR, under a
/// model call) names this folder as its recipe, this html_ref and this sha256. A None leaves the publication to the old
/// checks, which a leaf page does not pass. The completion check (investigate.rs) calls it once the run's events are
/// written; the fetches are those events.jsonl records (fetches).
pub fn leaf_gate(root: &Path, dir: &str, manifest: &Value) -> Option<Vec<String>> {
    let html_ref = manifest["html_ref"].as_str()?;
    let sha = manifest["html_sha256"].as_str()?;
    let entered = manifest["kind"] == "leaf_page"
        && root.join("runtime/next-page.json").is_file()
        && ring_events(root).iter().any(|e| {
            e["by"] == RING_ACTOR
                && e["auto_parent_call_id"].is_string()
                && e.get("stuck").is_none()
                && e["recipe"] == dir
                && e["published"] == html_ref
                && e["html_sha256"] == sha
        });
    entered.then(|| leaf_gaps(root, dir, manifest, &fetches(root)))
}

/// Every check of the gate table on a leaf page, whoever asks: the flow right after it published the page (its events are
/// not on disk yet, so it lends its own fetches) and leaf_gate at completion. Empty is a page that passes: its bytes are
/// the manifest's, its plan is the recipe's, every row it was checked against is the row the knowledge group reads again
/// from a recorded fetch (N1 b), the visual group's recheck passes on those bytes (LeafRecheck: a registered recipe, the
/// bake's own check, each series entry printing its row), every view the question asks for has a layer of the recipe
/// (GAP-2), and the text checks pass. Anything that cannot be read is a gap.
pub fn leaf_gaps(root: &Path, dir: &str, manifest: &Value, fetched: &[Fetch]) -> Vec<String> {
    let at = format!("publications/{dir}");
    let mut gaps = Vec::new();
    let (Some(html_ref), Some(sha)) = (manifest["html_ref"].as_str(), manifest["html_sha256"].as_str()) else {
        return vec![format!("leaf page {at}: the manifest names no html_ref and html_sha256")];
    };
    if html_ref != format!("{at}/index.html") {
        gaps.push(format!("leaf page {at}: html_ref {html_ref} is not its index.html"));
    }
    let html = match std::fs::read(root.join(&at).join("index.html")) {
        Ok(bytes) if crate::hash::sha256_bytes(&bytes) == sha => String::from_utf8(bytes).ok(),
        Ok(_) => {
            gaps.push(format!("leaf page {at}: index.html is not the bytes its manifest and ring event name"));
            None
        }
        Err(e) => {
            gaps.push(format!("leaf page {at}: index.html: {e}"));
            None
        }
    };
    let plan_ref = leaf_plan_ref(dir);
    match read_json(root, &plan_ref) {
        Some(plan) if plan["kind"] == "leaf_plan" && plan["recipe"] == dir => {}
        Some(_) => gaps.push(format!("leaf page {at}: {plan_ref} is not this recipe's leaf plan")),
        None => gaps.push(format!("leaf page {at}: no readable plan {plan_ref}")),
    }
    let calls = Mutex::new(Vec::new());
    let layers = match visual_call(&calls, "recipe_layers", crate::next_visual::Request::RecipeLayers { recipe: dir }) {
        Ok(crate::next_visual::Reply::Layers(Some(layers))) => layers,
        Ok(_) => {
            gaps.push(format!("leaf page {at}: {dir} is no recipe of the leaf registry"));
            Vec::new()
        }
        Err(e) => {
            gaps.push(format!("leaf page {at}: the recipe's layers: {e}"));
            Vec::new()
        }
    };
    match read_json(root, "runtime/next-page.json").and_then(|state| state["question"].as_str().map(str::to_string)) {
        Some(question) => gaps.extend(
            unanswered_modes(&question, &layers)
                .into_iter()
                .map(|mode| format!("leaf page {at}: the question asks for a {mode} view, which no layer of {dir} draws")),
        ),
        None => gaps.push(format!("leaf page {at}: runtime/next-page.json names no question")),
    }
    let Some(html) = html else {
        return gaps;
    };
    match request(root, &at) {
        Ok((spec, rows, facts, ledger, refs)) => {
            gaps.extend(reread_gaps(root, &rows, fetched).into_iter().map(|off| format!("leaf page {at}: {off}")));
            let recheck = crate::next_visual::Request::LeafRecheck {
                recipe: dir,
                html: &html,
                ledger: &ledger,
                refs: &refs,
                facts: (&spec, &rows, &facts),
            };
            match visual_call(&calls, "leaf_recheck", recheck) {
                Ok(crate::next_visual::Reply::Rechecked(off)) => {
                    gaps.extend(off.into_iter().map(|off| format!("leaf page {at}: {off}")))
                }
                Ok(_) => unreachable!("the visual group answered leaf_recheck with another reply"),
                Err(e) => gaps.push(format!("leaf page {at}: the recheck: {e}")),
            }
        }
        Err(why) => gaps.push(format!("leaf page {at}: {LEAF_REQUEST}: {why}")),
    }
    gaps.extend(text_gaps(&html).into_iter().map(|off| format!("leaf page {at}: {off}")));
    gaps
}

/// GAP-2: each view the question asks for (prompt::required_visual_modes) that none of these layers draws (MODE_LAYERS).
/// The flow asks it of each recipe before it picks one, and the gate again of the published page.
pub fn unanswered_modes(question: &str, layers: &[String]) -> Vec<&'static str> {
    crate::prompt::required_visual_modes(question)
        .into_iter()
        .filter(|(_, kinds)| {
            !kinds.iter().any(|kind| {
                MODE_LAYERS
                    .iter()
                    .filter(|(k, _)| k == kind)
                    .any(|(_, want)| want.iter().any(|w| layers.iter().any(|l| l == w)))
            })
        })
        .map(|(mode, _)| mode)
        .collect()
}

/// The knowledge group's fetches as events.jsonl records them: a program-run (auto) DATA_PREPARE_TOOL call that ended
/// without error and names a Eurostat dataset, its file and that file's sha256. A World Bank fetch is none: its rows are
/// not re-read here, so a page over one is not passed.
fn fetches(root: &Path) -> Vec<Fetch> {
    std::fs::read_to_string(root.join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|e| {
            e["type"] == "tool_execution_end"
                && e["toolName"] == crate::next_knowledge::DATA_PREPARE_TOOL
                && e["auto"] == true
                && e["isError"] == false
                && e["result"]["details"]["provider"] == "eurostat"
        })
        .filter_map(|e| {
            let d = &e["result"]["details"];
            Some(Fetch {
                table: d["dataset"].as_str()?.to_string(),
                file: d["filePath"].as_str()?.to_string(),
                sha256: d["sha256"].as_str()?.to_string(),
            })
        })
        .collect()
}

/// N1(b): each row the page was checked against, as the knowledge group reads it again (SeriesRows) from a recorded fetch
/// of its table whose file still holds the bytes the fetch recorded. A row no such file holds as it is, a table with no
/// such fetch, or one source read two ways is a finding.
fn reread_gaps(root: &Path, rows: &[Row], fetched: &[Fetch]) -> Vec<String> {
    let calls = Mutex::new(Vec::new());
    let mut off = Vec::new();
    let mut read: BTreeMap<String, Row> = BTreeMap::new();
    let tables: BTreeSet<&str> = rows.iter().map(|r| r.table.as_str()).collect();
    for table in tables {
        let files: Vec<&Fetch> = fetched.iter().filter(|f| f.table == table).collect();
        if files.is_empty() {
            off.push(format!("no recorded fetch of {table} to read its rows again from"));
        }
        for fetch in files {
            let file = &fetch.file;
            if !file.starts_with("data/") || file.split('/').any(|part| part == ".." || part.is_empty()) {
                off.push(format!("the fetch of {table} names {file}, not a file under data/"));
                continue;
            }
            let bytes = match std::fs::read(root.join(file)) {
                Ok(bytes) if crate::hash::sha256_bytes(&bytes) == fetch.sha256 => bytes,
                Ok(_) => {
                    off.push(format!("{file} is not the bytes the fetch of {table} recorded"));
                    continue;
                }
                Err(e) => {
                    off.push(format!("{file}: {e}"));
                    continue;
                }
            };
            let Ok(csv) = String::from_utf8(bytes) else {
                off.push(format!("{file} is not text"));
                continue;
            };
            // SeriesRows reads only the id and whether the table is World Bank's; a recorded fetch here is Eurostat's
            let meta = TableMeta {
                id: table.to_string(),
                worldbank: false,
                dims: Vec::new(),
                end_year: None,
                places: Vec::new(),
                place_members: Vec::new(),
                freqs: Vec::new(),
                unit: None,
            };
            let args = json!({"table": table, "csv_sha256": fetch.sha256});
            let request = crate::next_knowledge::Request::SeriesRows { table: &meta, csv: &csv };
            let found = match knowledge_call(&calls, "series_rows", args, request) {
                Ok(crate::next_knowledge::Reply::SeriesRows(found)) => found,
                Ok(_) => unreachable!("the knowledge group answered series_rows with another reply"),
                Err(e) => {
                    off.push(format!("{file}: {e}"));
                    continue;
                }
            };
            for row in found {
                let value = row["value"].as_str().and_then(|v| v.trim().parse::<f64>().ok());
                let (Some(src), Some(value), Ok(dims)) = (
                    row["src"].as_str(),
                    value,
                    serde_json::from_value::<BTreeMap<String, String>>(row["dims"].clone()),
                ) else {
                    off.push(format!("{file}: a row the knowledge group read is not a series row"));
                    continue;
                };
                let again = Row {
                    src: src.to_string(),
                    table: table.to_string(),
                    dims,
                    time: row["time"].as_str().unwrap_or_default().to_string(),
                    value,
                };
                match read.get(src) {
                    Some(first) if *first != again => off.push(format!("{src} is read two ways from the fetched files")),
                    Some(_) => {}
                    None => {
                        read.insert(src.to_string(), again);
                    }
                }
            }
        }
    }
    for row in rows {
        match read.get(&row.src) {
            Some(again) if again == row => {}
            Some(_) => off.push(format!("{}: not as its fetched file holds it", row.src)),
            None => off.push(format!("{}: no recorded fetch holds it", row.src)),
        }
    }
    off
}

/// The run's RING_EVENT lines (a line that does not parse is none).
fn ring_events(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|e| e["type"] == RING_EVENT)
        .collect()
}

fn read_json(root: &Path, rel: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(root.join(rel)).ok()?).ok()
}

type Checked = (Spec, Vec<Row>, Vec<Fact>, BTreeMap<String, String>, Vec<String>);

/// What the page was checked against at its bake, as publish_leaf_page wrote it beside index.html.
fn request(root: &Path, at: &str) -> Result<Checked, String> {
    let text = std::fs::read_to_string(root.join(at).join(LEAF_REQUEST)).map_err(|e| e.to_string())?;
    let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut take = |key: &str| value.get_mut(key).map(Value::take).ok_or(format!("no {key}"));
    let field = |e: serde_json::Error| e.to_string();
    Ok((
        serde_json::from_value(take("spec")?).map_err(field)?,
        serde_json::from_value(take("rows")?).map_err(field)?,
        serde_json::from_value(take("facts")?).map_err(field)?,
        serde_json::from_value(take("ledger")?).map_err(field)?,
        serde_json::from_value(take("refs")?).map_err(field)?,
    ))
}

/// The page's text checks the old critic made and nothing else here does: one headline of at most TITLE_MAX characters, a dek
/// of at most DEK_MAX, and every `role="img"` graphic named (aria-label) and described (aria-describedby an element with text).
fn text_gaps(html: &str) -> Vec<String> {
    let mut gaps = Vec::new();
    let heads = elements(html, "h1");
    match heads.as_slice() {
        [title] if title.trim().is_empty() => gaps.push("the headline is empty".to_string()),
        [title] if title.chars().count() > TITLE_MAX => gaps.push(format!("the headline is over {TITLE_MAX} characters")),
        [_] => {}
        _ => gaps.push(format!("the page has {} headlines, not one", heads.len())),
    }
    if elements(html, "p").iter().zip(attrs(html, "p")).any(|(text, a)| a.contains("class=\"dek\"") && text.chars().count() > DEK_MAX) {
        gaps.push(format!("the dek is over {DEK_MAX} characters"));
    }
    for a in attrs(html, "svg").into_iter().filter(|a| a.contains("role=\"img\"")) {
        let label = attr(&a, "aria-label").unwrap_or_default();
        let described = attr(&a, "aria-describedby")
            .and_then(|id| {
                let open = format!("id=\"{id}\"");
                let at = html.find(&open)?;
                let rest = &html[at..];
                let body = &rest[rest.find('>')? + 1..];
                Some(strip(&body[..body.find('<').unwrap_or(body.len())]))
            })
            .is_some_and(|text| !text.trim().is_empty());
        if label.trim().is_empty() || !described {
            gaps.push("a graphic has no alt text (aria-label and a described-by text)".to_string());
        }
    }
    gaps
}

/// The text inside each `<tag ...>...</tag>`, tags stripped, in page order (no nesting of the same tag).
fn elements(html: &str, tag: &str) -> Vec<String> {
    let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find(&open) {
        let after = &rest[at + open.len()..];
        if !after.starts_with(['>', ' ']) {
            rest = after;
            continue;
        }
        let Some(body) = after.find('>').map(|g| &after[g + 1..]) else { break };
        let end = body.find(&close).unwrap_or(body.len());
        out.push(strip(&body[..end]));
        rest = &body[end..];
    }
    out
}

/// The attribute text of each `<tag ...>`, in page order, matching elements().
fn attrs(html: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find(&open) {
        let after = &rest[at + open.len()..];
        rest = after;
        if after.starts_with(['>', ' ']) {
            out.push(after[..after.find('>').unwrap_or(after.len())].to_string());
        }
    }
    out
}

fn attr(attrs: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=\"");
    let at = attrs.find(&key)? + key.len();
    Some(attrs[at..at + attrs[at..].find('"')?].to_string())
}

fn strip(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in text.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_gaps_reads_headline_dek_and_alt() {
        let ok = "<h1>标题</h1><p class=\"dek\">导语</p><svg role=\"img\" aria-label=\"图\" aria-describedby=\"d\"></svg><p id=\"d\" hidden>说明</p>";
        assert!(text_gaps(ok).is_empty(), "{:?}", text_gaps(ok));
        let long = format!("<h1>{}</h1>", "字".repeat(TITLE_MAX + 1));
        assert_eq!(text_gaps(&long), [format!("the headline is over {TITLE_MAX} characters")]);
        assert_eq!(text_gaps("<h1>a</h1><h1>b</h1>"), ["the page has 2 headlines, not one"]);
        let dek = format!("<h1>t</h1><p class=\"dek\">{}</p>", "字".repeat(DEK_MAX + 1));
        assert_eq!(text_gaps(&dek), [format!("the dek is over {DEK_MAX} characters")]);
        let bare = "<h1>t</h1><svg role=\"img\" aria-label=\"图\"></svg>";
        assert_eq!(text_gaps(bare), ["a graphic has no alt text (aria-label and a described-by text)"]);
        let empty = "<h1>t</h1><svg role=\"img\" aria-label=\"图\" aria-describedby=\"d\"></svg><p id=\"d\"></p>";
        assert_eq!(text_gaps(empty).len(), 1);
    }

    /// A run folder holding a published leaf page as publish_leaf_page and run_page leave it: manifest, index.html, plan and
    /// the flow's ring event; `by` is the ring event's actor.
    fn leaf_run(root: &Path, by: &str) -> Value {
        let html = "<h1>t</h1><p class=\"dek\">d</p>";
        let sha = crate::hash::sha256_bytes(html.as_bytes());
        std::fs::create_dir_all(root.join("publications/column")).unwrap();
        std::fs::create_dir_all(root.join("publications/plans")).unwrap();
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::write(root.join("runtime/next-page.json"), r#"{"question": "q"}"#).unwrap();
        std::fs::write(root.join("publications/column/index.html"), html).unwrap();
        std::fs::write(root.join(leaf_plan_ref("column")), r#"{"kind": "leaf_plan", "recipe": "column"}"#).unwrap();
        let event = serde_json::json!({"type": RING_EVENT, "by": by, "auto_parent_call_id": "c1", "recipe": "column",
            "published": "publications/column/index.html", "html_sha256": sha});
        std::fs::write(root.join("events.jsonl"), format!("{event}\n")).unwrap();
        serde_json::json!({"kind": "leaf_page", "html_ref": "publications/column/index.html", "html_sha256": sha})
    }

    #[test]
    fn leaf_gate_enters_only_on_the_flows_ring_event() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = leaf_run(dir.path(), RING_ACTOR);
        let gaps = leaf_gate(dir.path(), "column", &manifest).expect("a leaf page of this run");
        assert!(gaps.iter().any(|g| g.contains(LEAF_REQUEST)), "no request is a gap: {gaps:?}");
        // the folder is a registered recipe, so the only gaps are what the run does not hold: no request, no fetch
        assert!(!gaps.iter().any(|g| g.contains("no recipe")), "{gaps:?}");
        // another actor, another folder, another kind, another sha: not a leaf page, the old checks apply
        let forged = tempfile::tempdir().unwrap();
        let m = leaf_run(forged.path(), "model");
        assert!(leaf_gate(forged.path(), "column", &m).is_none());
        assert!(leaf_gate(dir.path(), "ring-2", &manifest).is_none());
        let mut other = manifest.clone();
        other["kind"] = "publication".into();
        assert!(leaf_gate(dir.path(), "column", &other).is_none());
        other = manifest.clone();
        other["html_sha256"] = "0".repeat(64).into();
        assert!(leaf_gate(dir.path(), "column", &other).is_none());
        std::fs::remove_file(dir.path().join("runtime/next-page.json")).unwrap();
        assert!(leaf_gate(dir.path(), "column", &manifest).is_none());
    }

    #[test]
    fn leaf_gate_finds_changed_bytes_and_a_missing_plan() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = leaf_run(dir.path(), RING_ACTOR);
        std::fs::write(dir.path().join("publications/column/index.html"), "<h1>other</h1>").unwrap();
        std::fs::remove_file(dir.path().join(leaf_plan_ref("column"))).unwrap();
        let gaps = leaf_gate(dir.path(), "column", &manifest).unwrap();
        assert!(gaps.iter().any(|g| g.contains("not the bytes")), "{gaps:?}");
        assert!(gaps.iter().any(|g| g.contains("no readable plan")), "{gaps:?}");
    }

    #[test]
    fn unanswered_modes_reads_the_recipes_layers() {
        let layers = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // q1's question asks for no view; a map question needs a map layer; network is never answered
        assert!(unanswered_modes("欧盟各国可再生能源占比", &layers(&["bignums", "bars"])).is_empty());
        assert_eq!(unanswered_modes("show it on a map", &layers(&["bignums", "bars"])), ["map/spatial"]);
        assert!(unanswered_modes("show it on a map", &layers(&["map", "strip"])).is_empty());
        assert_eq!(unanswered_modes("draw it as a network graph", &layers(&["map", "flows"])), ["network"]);
    }

    #[test]
    fn reread_gaps_holds_rows_to_the_recorded_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let csv = "DATAFLOW,LAST UPDATE,freq,unit,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG\nE,x,A,PC,AT,2025,44.2,p\n";
        let sha = crate::hash::sha256_bytes(csv.as_bytes());
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        std::fs::write(dir.path().join(format!("data/{sha}.csv")), csv).unwrap();
        let fetch = || vec![Fetch { table: "t".into(), file: format!("data/{sha}.csv"), sha256: sha.clone() }];
        let row = |value: f64| Row {
            src: "series:t/A.PC.AT:2025:OBS_VALUE".into(),
            table: "t".into(),
            dims: [("freq", "A"), ("unit", "PC"), ("geo", "AT")].map(|(k, v)| (k.to_string(), v.to_string())).into(),
            time: "2025".into(),
            value,
        };
        assert!(reread_gaps(dir.path(), &[row(44.2)], &fetch()).is_empty(), "{:?}", reread_gaps(dir.path(), &[row(44.2)], &fetch()));
        assert_eq!(reread_gaps(dir.path(), &[row(45.0)], &fetch()), ["series:t/A.PC.AT:2025:OBS_VALUE: not as its fetched file holds it"]);
        assert!(reread_gaps(dir.path(), &[row(44.2)], &[])[0].starts_with("no recorded fetch of t"));
        let mut other = fetch();
        other[0].sha256 = "0".repeat(64);
        assert!(reread_gaps(dir.path(), &[row(44.2)], &other).iter().any(|g| g.contains("not the bytes")));
    }
}
