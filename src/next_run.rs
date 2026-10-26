//! New route, flow group: from the question to the page. After prepare_claims, in the fixed order: each table's fetched file
//! is read into its shape (knowledge group) and the registry's template is picked for it (visual group), both only through
//! their group commands; the program drafts every page field (next_page) and the model rewords them once (Ask::Text); then
//! the design pack is sent its sheet. What the run decided is kept in PAGE_STATE, so the parent's completion prompts, each
//! in a new child, go on from it instead of picking again.
//!
//! Not done here yet: the judgement pack after the sheet (next_pack plus the rewording of its reader fields) and the rerun
//! for the completion gate; until then the run stops after the sheet with that named.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::{json, Map, Value};

use crate::agent_loop::ToolRunner;
use crate::next_flow::{prepare_claims, record_group_calls, Ask, Asker, Catalogue, Choice, Prepared, Recorder, Stop};
use crate::next_page::{self, Chart, Claim, Drafts, Target, TIME_COLUMNS};
use crate::shape_registry::Relation;

pub const DESIGN_PACK_TOOL: &str = "newsroom_design_pack";
/// The registry templates whose fields this flow fills from a series' columns (a category and a value column). The others
/// are not offered to the ranking yet: a map also needs its basemap, a flow or a composition a third column.
pub const FILLED_TEMPLATES: [&str; 2] = ["horizontal_bar", "line"];
/// What the first prompt decided, under the run folder.
pub const PAGE_STATE: &str = "runtime/next-page.json";
/// One per table: the shape's ranking and the template picked, with the fields filled.
pub const CHART_EVENT: &str = "next_chart";
/// A table that gives no chart, and why; the other tables go on.
pub const CHART_SKIPPED_EVENT: &str = "next_chart_skipped";
/// The rewording was refused in every round: which fields kept the model's wording and which went back to the draft.
pub const TEXT_FALLBACK_EVENT: &str = "next_text_fallback";
/// The line of the parent's prompt the question follows (prompts/investigate.md); the question ends at the first blank line.
const GOAL_MARK: &str = "Investigation goal:\n";

/// The question as the parent's prompt carries it; None when the prompt has no goal line.
pub fn question_of(prompt: &str) -> Option<String> {
    let rest = &prompt[prompt.find(GOAL_MARK)? + GOAL_MARK.len()..];
    let question = rest.split("\n\n").next().unwrap_or("").trim();
    (!question.is_empty()).then(|| question.to_string())
}

fn stop(step: &'static str, why: impl Into<String>) -> Stop {
    Stop::Page { step, why: why.into() }
}

fn read_json(run_dir: &Path, rel: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(run_dir.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{rel}: {e}"))
}

/// The claim records newsroom_data_prepare wrote, by claim id; read from the file, never from the tool text.
fn claim_records(run_dir: &Path) -> Result<BTreeMap<String, Value>, String> {
    let text = std::fs::read_to_string(run_dir.join("claims.jsonl")).map_err(|e| format!("claims.jsonl: {e}"))?;
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|record| Some((record["claim_id"].as_str()?.to_string(), record)))
        .collect())
}

/// A claim's computation record: 0 is its own one-row result, 1 the series its chart draws.
fn computation(run_dir: &Path, record: &Value, n: usize) -> Result<Value, String> {
    let rel = record["computation_refs"][n]
        .as_str()
        .ok_or_else(|| format!("{} has no computation_refs[{n}]", record["claim_id"]))?;
    read_json(run_dir, rel)
}

fn columns(series: &Value) -> Vec<String> {
    match series["columns"].as_array() {
        Some(columns) => columns.iter().filter_map(|c| c.as_str().map(String::from)).collect(),
        None => series["rows"][0].as_object().map(|row| row.keys().cloned().collect()).unwrap_or_default(),
    }
}

/// The category and value columns of a series for a two-field template: the value is `value`; a ranking's category is its
/// one column that is neither the value nor a time, a change's category is its time column.
fn fields(relation: Relation, columns: &[String]) -> Result<(String, String), String> {
    if !columns.iter().any(|c| c == "value") {
        return Err(format!("the series has no value column (columns: {columns:?})"));
    }
    let pick = |want: &dyn Fn(&str) -> bool| {
        let found: Vec<&String> = columns.iter().filter(|c| c.as_str() != "value" && want(c)).collect();
        match found.as_slice() {
            [one] => Ok((one.to_string(), "value".to_string())),
            _ => Err(format!("{relation:?} needs one category column, the series has {found:?}")),
        }
    };
    match relation {
        Relation::Ranking => pick(&|c| !TIME_COLUMNS.contains(&c)),
        Relation::Change => pick(&|c| TIME_COLUMNS.contains(&c)),
        other => Err(format!("{other:?} is not a template this flow fills")),
    }
}

/// The time values a series' rows draw, as text.
fn times(series: &Value) -> Vec<String> {
    series["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|row| {
            TIME_COLUMNS.iter().filter_map(move |c| match &row[*c] {
                Value::String(t) => Some(t.clone()),
                Value::Number(t) => Some(t.to_string()),
                _ => None,
            })
        })
        .collect()
}

/// The page so far: the claims, the charts with their template picks, and the page fields after the rewording.
#[derive(Debug)]
pub struct Page {
    pub claims: Vec<Claim>,
    pub charts: Vec<Chart>,
    pub templates: Vec<Value>,
    pub numbers: Vec<String>,
}

/// One table's chart: its claims with their kinds and templates, the chart, and what the page's numbers come from.
struct TableChart {
    claims: Vec<Claim>,
    chart: Chart,
    claim_rows: Vec<Value>,
    times: Vec<String>,
    event: Value,
}

/// One table read into its shape, given the best registered template and its fields; Err says why this table gives no chart.
fn table_chart(
    run_dir: &Path,
    records: &BTreeMap<String, Value>,
    table: &Prepared,
    catalogue: &dyn Catalogue,
    used: &[Relation],
) -> Result<TableChart, String> {
    let meta = catalogue.table(&table.id).ok_or("the catalogue lists no dimensions for it")?;
    let csv = std::fs::read_to_string(run_dir.join(&table.file)).map_err(|e| format!("the fetched file {}: {e}", table.file))?;
    let shape = catalogue.shape(&meta, &csv)?;
    let matched = catalogue.rank(&shape, &FILLED_TEMPLATES, used);
    let Some(best) = matched.candidates.first() else {
        let why: Vec<String> = matched.rejected.iter().map(|r| format!("{:?}: {}", r.relation, r.reason)).collect();
        return Err(format!("no registered template fits its shape ({})", why.join("; ")));
    };
    let sheet = read_json(run_dir, &format!("shadow/candidate_sheet-{}.json", table.sheet))?;
    let mut out = TableChart {
        claims: Vec::new(),
        chart: Chart { relation: best.relation, claim_ids: Vec::new(), category: String::new(), value: String::new() },
        claim_rows: Vec::new(),
        times: Vec::new(),
        event: Value::Null,
    };
    let mut series_columns = None;
    for picked in &table.claims {
        let (Some(candidate), Some(claim_id)) = (picked["candidate"].as_str(), picked["claim_id"].as_str()) else {
            return Err("a registered claim without candidate or claim_id".into());
        };
        let entry = sheet["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["id"] == candidate)
            .ok_or_else(|| format!("candidate {candidate} is not on its sheet"))?;
        let record = records.get(claim_id).ok_or_else(|| format!("{claim_id} is not in claims.jsonl"))?;
        let own = computation(run_dir, record, 0)?;
        let series = computation(run_dir, record, 1)?;
        out.claim_rows.push(own["rows"][0].clone());
        out.times.extend(times(&series));
        series_columns.get_or_insert_with(|| columns(&series));
        out.claims.push(Claim {
            id: claim_id.to_string(),
            kind: entry["kind"].as_str().unwrap_or("").to_string(),
            template: entry["template"].as_str().unwrap_or("").to_string(),
        });
        out.chart.claim_ids.push(claim_id.to_string());
    }
    let (category, value) = fields(best.relation, &series_columns.unwrap_or_default())?;
    out.event = json!({"table": table.id, "template": best.template(), "explain": best.explain(),
        "others": matched.candidates.iter().skip(1).map(|c| c.explain()).collect::<Vec<_>>(),
        "category_field": category, "value_field": value, "claims": out.chart.claim_ids});
    out.chart.category = category;
    out.chart.value = value;
    Ok(out)
}

/// Each table's shape, template and chart; the sheet's candidates give each claim its kind and template. This comes after the
/// data is in and the claims are verified, so a table that gives no chart is left off the page with one CHART_SKIPPED_EVENT and
/// the others go on; only when no table gives one does the run stop, naming each table's reason.
pub fn charts(recorder: &mut Recorder<'_>, prepared: &[Prepared], catalogue: &dyn Catalogue) -> Result<Page, Stop> {
    let run_dir = recorder.run_dir().to_path_buf();
    let records = claim_records(&run_dir).map_err(|e| stop("chart", e))?;
    let mut page = Page { claims: Vec::new(), charts: Vec::new(), templates: Vec::new(), numbers: Vec::new() };
    let mut used = Vec::new();
    let mut claim_rows = Vec::new();
    let mut chart_times = Vec::new();
    let mut skipped = Vec::new();
    for table in prepared {
        let made = table_chart(&run_dir, &records, table, catalogue, &used);
        record_group_calls(recorder, catalogue)?;
        let made = match made {
            Ok(made) => made,
            Err(why) => {
                recorder.program_event(CHART_SKIPPED_EVENT, json!({"table": table.id, "why": why}))?;
                skipped.push(format!("{}: {why}", table.id));
                continue;
            }
        };
        recorder.program_event(CHART_EVENT, made.event)?;
        used.push(made.chart.relation);
        for id in &made.chart.claim_ids {
            page.templates.push(json!({"claim_id": id, "chart_type": made.chart.relation.template(),
                "fields": {"category_field": made.chart.category, "value_field": made.chart.value}}));
        }
        claim_rows.extend(made.claim_rows);
        chart_times.extend(made.times);
        page.claims.extend(made.claims);
        page.charts.push(made.chart);
    }
    if page.charts.is_empty() {
        return Err(stop("chart", format!("no table gives a chart: {}", skipped.join(" | "))));
    }
    page.numbers = next_page::allowed_numbers(&claim_rows, &chart_times);
    Ok(page)
}

/// The fourth ask: the drafted fields reworded once. Refused in every round, it does not stop the run (the data is in and
/// the claims are verified): each field of the last refused answer that passes on its own is kept, the rest go back to
/// their drafts, and the fallback is one program event under the last accepted answer.
pub async fn reword(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    question: &str,
    drafts: &Drafts,
    cancel: &AtomicBool,
) -> Result<BTreeMap<Target, String>, Stop> {
    let ask = drafts.ask(Vec::new());
    let Ask::Text { fields, numbers, .. } = &ask else { unreachable!("drafts ask for text") };
    let listed: Vec<String> = fields.iter().map(|(n, text)| format!("{n}. {text}")).collect();
    let typed = if numbers.is_empty() { "none".to_string() } else { numbers.join(", ") };
    let prompt = format!(
        "Question: {question}\nPage fields, drafted by the program:\n{}\nRewrite in Simplified Chinese the fields whose wording \
         should fit the question better; leave out the ones to keep. Keep every {{placeholder}} of a field exactly; type no number \
         (and no number in words) except these: {typed}.",
        listed.join("\n")
    );
    let choice = match recorder.ask_step(model, &ask, &prompt, cancel).await {
        Ok((_, choice)) => choice,
        Err(Stop::Refused { step: "text", problem }) => {
            let last = recorder
                .history()
                .iter()
                .rev()
                .find(|m| m["role"] == "assistant")
                .and_then(|m| m["content"].as_array())
                .and_then(|blocks| blocks.iter().find(|b| b["type"] == "toolCall"))
                .map(|call| call["arguments"]["text"].clone())
                .unwrap_or(Value::Null);
            let mut kept = BTreeMap::new();
            for (n, wording) in last.as_object().into_iter().flatten() {
                let alone = json!({"step": "text", "text": {n.as_str(): wording}, "names": {}});
                if ask.check(&alone).is_ok() {
                    kept.insert(n.clone(), wording.as_str().unwrap_or("").to_string());
                }
            }
            let choice = match ask.check(&json!({"step": "text", "text": kept, "names": {}})) {
                Ok(choice) => choice,
                Err(_) => Choice::Text { text: BTreeMap::new(), names: BTreeMap::new() },
            };
            if !recorder.resume_under_last_accepted() {
                return Err(Stop::Refused { step: "text", problem });
            }
            let Choice::Text { text, .. } = &choice else { unreachable!("a text check gives a text choice") };
            let back: Vec<&String> = fields.keys().filter(|n| !text.contains_key(*n)).collect();
            recorder.program_event(
                TEXT_FALLBACK_EVENT,
                json!({"problem": problem, "kept": text.keys().collect::<Vec<_>>(), "back_to_draft": back}),
            )?;
            choice
        }
        Err(other) => return Err(other),
    };
    drafts.revised(&choice).map_err(|e| stop("text", e))
}

/// What the first prompt decided, for the completion prompts.
fn save_state(run_dir: &Path, state: &Value) -> Result<(), Stop> {
    let text = serde_json::to_string_pretty(state).map_err(|e| stop("state", e.to_string()))?;
    crate::group_guard::write(run_dir, &run_dir.join(PAGE_STATE), text).map_err(|e| stop("state", format!("{PAGE_STATE}: {e}")))
}

/// The design pack's verdict on one send: its status and problems, from the details only.
fn pack_status(called: &crate::next_flow::Called) -> (String, String) {
    let details = called.details.clone().unwrap_or(Value::Null);
    let status = details["status"].as_str().unwrap_or(if called.is_error { "error" } else { "" }).to_string();
    let problems = match &details["problems"] {
        Value::Array(list) if !list.is_empty() => list.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(" | "),
        _ => called.content.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" "),
    };
    (status, problems)
}

/// The first prompt: the question to the design pack's sheet, every step in order. Returns the answer text.
pub async fn run_page<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    tools: &mut R,
    question: &str,
    catalogue: &dyn Catalogue,
    cancel: &AtomicBool,
) -> Result<String, Stop> {
    let prepared = prepare_claims(recorder, model, tools, question, &[], catalogue, cancel).await?;
    let page = charts(recorder, &prepared, catalogue)?;
    let drafts = next_page::draft(&page.claims, &page.charts, page.numbers.clone());
    let worded = reword(recorder, model, question, &drafts, cancel).await?;
    let sheet = recorder
        .auto(tools, DESIGN_PACK_TOOL, json!({"part": "sheet", "templates": page.templates}), cancel)
        .await?;
    let (status, problems) = pack_status(&sheet);
    let worded_out: Map<String, Value> = worded.iter().map(|(t, w)| (format!("{t:?}"), json!(w))).collect();
    let verified: BTreeSet<&str> = page.claims.iter().map(|c| c.id.as_str()).collect();
    save_state(
        recorder.run_dir(),
        &json!({"question": question, "claims": verified, "templates": page.templates, "worded": worded_out,
            "sheet_status": status}),
    )?;
    if status != "SHEET" {
        return Err(stop("sheet", format!("the design pack refused the sheet ({status}): {problems}")));
    }
    Err(stop("pack", "the judgement pack after the sheet is not wired yet"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anthropic_model::ToolDef;
    use crate::next_flow::{number_not_allowed, placeholders, worded_number, ModelRoute, CHOOSE_TOOL};

    /// Replays scripted replies, one per request.
    struct ScriptedAsker(std::collections::VecDeque<Value>);

    #[async_trait::async_trait]
    impl Asker for ScriptedAsker {
        fn route(&self) -> ModelRoute {
            ModelRoute::Standin
        }
        async fn ask(&mut self, _history: &[Value], _tools: &[ToolDef], _cancel: &AtomicBool) -> Option<Value> {
            self.0.pop_front()
        }
    }

    fn call(id: &str, args: Value) -> Value {
        json!({"content": [{"type": "toolCall", "id": id, "name": CHOOSE_TOOL, "arguments": args}],
            "stopReason": "toolUse", "usage": {}})
    }

    /// The rewording refused in both rounds: the field that passes alone keeps the model's wording, the one with a typed
    /// number goes back to its draft, and every number left on the page is a placeholder over the rows or an allowed time.
    #[tokio::test]
    async fn a_refused_rewording_keeps_the_fields_that_pass_and_drafts_the_rest() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path().to_path_buf();
        let claims = vec![Claim {
            id: "c1".into(),
            kind: "rank_top".into(),
            template: "{first.country_iso2} has the highest OBS VALUE in {first.year}: {first.value}.".into(),
        }];
        let charts = vec![Chart {
            relation: Relation::Ranking,
            claim_ids: vec!["c1".into()],
            category: "country_iso2".into(),
            value: "value".into(),
        }];
        let numbers = next_page::allowed_numbers(&[json!({"country_iso2": "SE", "value": 66.4, "year": 2025})], &["2025".into()]);
        let drafts = next_page::draft(&claims, &charts, numbers);
        let refused = json!({"step": "text", "text": {"1": "欧盟各国可再生能源占比：谁领先", "3": "27国由高到低"}, "names": {}});
        let mut model = ScriptedAsker(
            vec![
                call("s1", json!({"step": "search", "query": "renewable share"})),
                call("t1", refused.clone()),
                call("t2", refused),
            ]
            .into(),
        );
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = Default::default();
        let into = events.clone();
        let mut sink = move |e: Value| into.lock().unwrap().push(e);
        let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
        let cancel = AtomicBool::new(false);
        recorder.ask_step(&mut model, &Ask::Search, "search words", &cancel).await.unwrap();
        let page = reword(&mut recorder, &mut model, "欧盟各国可再生能源占比", &drafts, &cancel).await.unwrap();
        drop(recorder);
        assert_eq!(page[&Target::PageTitle], "欧盟各国可再生能源占比：谁领先");
        let heading = &drafts.fields.iter().find(|(t, _)| *t == Target::Heading(0)).unwrap().1;
        assert_eq!(&page[&Target::Heading(0)], heading);
        for (target, wording) in &page {
            let draft = &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
            assert_eq!(placeholders(wording), placeholders(draft), "{target:?}");
            assert_eq!(number_not_allowed(wording, &drafts.numbers), None, "{target:?}: {wording}");
            assert_eq!(worded_number(wording), None, "{target:?}: {wording}");
        }
        let events = events.lock().unwrap();
        let fallback: Vec<&Value> = events.iter().filter(|e| e["type"] == TEXT_FALLBACK_EVENT).collect();
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0]["kept"], json!(["1"]));
        assert!(fallback[0]["back_to_draft"].as_array().unwrap().contains(&json!("3")));
        assert_eq!(fallback[0]["auto_parent_call_id"], "s1");
    }

    /// The last newsroom_data_prepare call of a run that named a file: (catalogue id, file, sheet key, registered claims), and
    /// the mode it ended in. The sheet key comes from the candidates call, the claims from the picks call after it.
    fn last_prepare(run: &Path) -> Option<(Prepared, String)> {
        let text = std::fs::read_to_string(run.join("events.jsonl")).ok()?;
        let mut args = Map::new();
        let mut sheet = String::new();
        let mut found = None;
        for event in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
            if event["toolName"] != "newsroom_data_prepare" {
                continue;
            }
            if event["type"] == "tool_execution_start" {
                args = event["args"].as_object().cloned().unwrap_or_default();
            }
            let details = &event["result"]["details"];
            // a failed World Bank prepare names no file: the fetched one under data/ stands in, to see whether its shape reads
            let file = details["filePath"].as_str().map(String::from).or_else(|| {
                let worldbank = args.get("provider").and_then(Value::as_str) == Some("worldbank");
                let fetched = std::fs::read_dir(run.join("data")).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string());
                let json = fetched.filter(|n| n.ends_with(".json") && !n.ends_with(".meta.json")).next()?;
                worldbank.then(|| format!("data/{json}"))
            });
            if let Some(key) = details["sheet"].as_str() {
                sheet = key.to_string();
            }
            if event["type"] == "tool_execution_end" && file.is_some() {
                let worldbank = args.get("provider").and_then(Value::as_str) == Some("worldbank");
                let dataset = details["dataset"].as_str().or(args.get("dataset").and_then(Value::as_str)).unwrap_or("");
                let prepared = Prepared {
                    id: if worldbank { format!("{dataset}@2") } else { dataset.to_string() },
                    file: file.unwrap_or_default(),
                    args: args.clone(),
                    sheet: sheet.clone(),
                    claims: details["claims"].as_array().cloned().unwrap_or_default(),
                };
                found = Some((prepared, details["mode"].as_str().unwrap_or("failed").to_string()));
            }
        }
        found
    }

    /// charts() over runs whose files were already fetched (R1 3): one line per table, the template it got or where it stops.
    /// NEWS_CATALOG_DIR=.. NEWS_CLASSIFY_REFS=.. NEXT_CHARTS_RUNS=<run>,<run>.. cargo test --bin news next_run::tests::charts_over -- --include-ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn charts_over_fetched_runs() {
        let _command = crate::group_guard::command_for_test("investigate");
        let catalogue = crate::next_flow::GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        fn copy(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap().flatten() {
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        for source in std::env::var("NEXT_CHARTS_RUNS").unwrap().split(',') {
            // the run is copied first: the steps below write exchanges and events under it, and the fetched run stays as it was
            let dir = tempfile::tempdir().unwrap();
            let run = &dir.path().join("run");
            copy(Path::new(source), run);
            let shown = Path::new(source).file_name().unwrap().to_string_lossy().to_string();
            let Some((table, mode)) = last_prepare(run) else {
                println!("CHARTS {} | - | no prepare call named a file", shown);
                continue;
            };
            let records = claim_records(run).unwrap_or_default();
            let line = match table_chart(run, &records, &table, &catalogue, &[]) {
                Ok(made) => format!("chart {} {}/{} claims={}", made.chart.relation.template(), made.chart.category, made.chart.value, made.claims.len()),
                Err(why) => format!("skip: {why}"),
            };
            println!("CHARTS {} | {} | prepare={mode} | {line}", shown, table.id);
            if !table.claims.is_empty() {
                let mut sink = |_e: Value| {};
                let mut recorder = Recorder::new(&mut sink, run, Vec::new(), Vec::new());
                let mut model = ScriptedAsker(vec![call("s1", json!({"step": "search", "query": "renewable share"}))].into());
                let cancel = AtomicBool::new(false);
                recorder.ask_step(&mut model, &Ask::Search, "search words", &cancel).await.unwrap();
                match charts(&mut recorder, std::slice::from_ref(&table), &catalogue) {
                    Ok(page) => println!("CHARTS {} | page | charts={} claims={} numbers={:?}", shown, page.charts.len(), page.claims.len(), page.numbers),
                    Err(stop) => println!("CHARTS {} | page | stop: {stop}", shown),
                }
            }
        }
    }

    #[test]
    fn the_question_is_the_goal_block_of_the_prompt() {
        let prompt = "You are the layer.\n\nInvestigation goal:\n欧盟各国可再生能源占比\n\nOperate as an evidence-first data journalist.";
        assert_eq!(question_of(prompt).as_deref(), Some("欧盟各国可再生能源占比"));
        assert_eq!(question_of("no goal line here"), None);
        assert_eq!(question_of("Investigation goal:\n\n\nrest"), None);
    }

    #[test]
    fn a_ranking_takes_its_one_entity_column_and_a_change_its_time() {
        let cols = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            fields(Relation::Ranking, &cols(&["country_iso2", "value", "year"])).unwrap(),
            ("country_iso2".to_string(), "value".to_string())
        );
        assert_eq!(fields(Relation::Change, &cols(&["year", "value"])).unwrap(), ("year".to_string(), "value".to_string()));
        assert!(fields(Relation::Ranking, &cols(&["geo", "unit", "value"])).is_err());
        assert!(fields(Relation::Ranking, &cols(&["geo", "obs"])).is_err());
        assert!(fields(Relation::Map, &cols(&["geo", "value"])).is_err());
    }
}
