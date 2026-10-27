//! New route, flow group: from the question to the page. After prepare_claims, in the fixed order: each table's fetched file
//! is read into its shape (knowledge group) and the registry's template is picked for it (visual group), both only through
//! their group commands; the program drafts every page field (next_page) and the model rewords them once (Ask::Text); then
//! the design pack is sent its sheet. What the run decided is kept in PAGE_STATE, so the parent's completion prompts, each
//! in a new child, go on from it instead of picking again.
//!
//! After the sheet, the judgement half of the pack (next_pack, its reader fields reworded with the page) is sent as part
//! "first", then the page over the sheet's charts as part "second". After the preview's image review and the publication, the
//! completion gate: the model scores the published page's browser screenshot on the same pass line, and only a pass ends the
//! run with the rendered pack's text as the answer. Not done here yet: the rerun after a failed gate.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::{json, Map, Value};

use crate::agent_loop::ToolRunner;
use crate::next_flow::{prepare_claims, record_group_calls, Ask, Asker, Catalogue, Choice, Prepared, PrepareStep, Recorder, Stop};
use crate::next_pack::{self, PackClaim, PackInput, Reader};
use crate::next_page::{self, Chart, Claim, Drafts, Target, TIME_COLUMNS};
use crate::shape_registry::{Axis, PagePlan, Relation};

pub const DESIGN_PACK_TOOL: &str = "newsroom_design_pack";
/// The registry templates whose fields this flow fills from a series' columns (a category and a value column). The others
/// are not offered to the ranking yet: a flow or a composition needs a third column. A map reads the bundled basemap.
pub const FILLED_TEMPLATES: [&str; 3] = ["horizontal_bar", "line", "choropleth"];
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
        Relation::Ranking | Relation::Map => pick(&|c| !TIME_COLUMNS.contains(&c)),
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
    /// The claims' recorded sentences (claims.jsonl `claim`), by id.
    pub sentences: BTreeMap<String, String>,
    /// The place dimensions of the charted tables and the time values their series draw; sorted, no repeats.
    pub places: Vec<String>,
    pub times: Vec<String>,
    /// Per chart, what its fetched table says about the measure.
    pub measures: Vec<next_pack::Measure>,
    /// Per chart, the visual group's page plan row for its relation.
    pub plans: Vec<&'static PagePlan>,
}

/// One table's chart: its claims with their kinds and templates, the chart, and what the page's numbers come from.
struct TableChart {
    claims: Vec<Claim>,
    chart: Chart,
    claim_rows: Vec<Value>,
    /// The rows of the series its claims draw (every claim's), which the charts list along their category.
    series_rows: Vec<Value>,
    times: Vec<String>,
    places: Vec<String>,
    axis: Axis,
    event: Value,
    /// A second chart of the same series: the next relation the registry ranks for the shape, drawing the second picked claim.
    second: Option<(Chart, Axis)>,
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
    let mut matched = catalogue.rank(&shape, &FILLED_TEMPLATES, used);
    if !maps_a_ratio(table) {
        matched.candidates.retain(|c| c.relation != Relation::Map);
    }
    let Some(best) = matched.candidates.first() else {
        let why: Vec<String> = matched.rejected.iter().map(|r| format!("{:?}: {}", r.relation, r.reason)).collect();
        return Err(format!("no registered template fits its shape ({})", why.join("; ")));
    };
    let sheet = read_json(run_dir, &format!("shadow/candidate_sheet-{}.json", table.sheet))?;
    let mut out = TableChart {
        claims: Vec::new(),
        chart: Chart { relation: best.relation, claim_ids: Vec::new(), category: String::new(), value: String::new() },
        claim_rows: Vec::new(),
        series_rows: Vec::new(),
        times: Vec::new(),
        places: shape.dims.iter().filter(|d| d.is_place).map(|d| d.dim.clone()).collect(),
        axis: shape.axis(best.relation),
        event: Value::Null,
        second: None,
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
        out.series_rows.extend(series["rows"].as_array().cloned().unwrap_or_default());
        series_columns.get_or_insert_with(|| columns(&series));
        out.claims.push(Claim {
            id: claim_id.to_string(),
            kind: entry["kind"].as_str().unwrap_or("").to_string(),
            template: entry["template"].as_str().unwrap_or("").to_string(),
        });
        out.chart.claim_ids.push(claim_id.to_string());
    }
    let (category, value) = fields(best.relation, series_columns.as_deref().unwrap_or_default())?;
    out.event = json!({"table": table.id, "template": best.template(), "explain": best.explain(),
        "others": matched.candidates.iter().skip(1).map(|c| c.explain()).collect::<Vec<_>>(),
        "category_field": category, "value_field": value, "claims": out.chart.claim_ids});
    out.chart.category = category;
    out.chart.value = value;
    // The page draws at least two charts: with two claims or more, the second one goes on the next relation the registry
    // ranks for this shape (another template over the same series), when its fields fill from the series' columns. It takes
    // the first claim after the lead's that is no ranking (the lead chart and the ledger already rank), else the second claim.
    let columns = series_columns.unwrap_or_default();
    let next = matched.candidates.iter().find(|c| c.relation != best.relation).filter(|_| out.chart.claim_ids.len() >= 2);
    if let Some((relation, (category, value))) = next.and_then(|c| fields(c.relation, &columns).ok().map(|f| (c.relation, f))) {
        let pick = second_claim(&out.claims);
        let id = out.chart.claim_ids.remove(pick);
        out.event["second"] = json!({"template": relation.template(), "category_field": category, "value_field": value, "claims": [id]});
        out.second = Some((Chart { relation, claim_ids: vec![id], category, value }, shape.axis(relation)));
    }
    Ok(out)
}

/// Each table's shape, template and chart; the sheet's candidates give each claim its kind and template. This comes after the
/// data is in and the claims are verified, so a table that gives no chart is left off the page with one CHART_SKIPPED_EVENT and
/// the others go on; only when no table gives one does the run stop, naming each table's reason.
pub fn charts(recorder: &mut Recorder<'_>, prepared: &[Prepared], catalogue: &dyn Catalogue) -> Result<Page, Stop> {
    let run_dir = recorder.run_dir().to_path_buf();
    let records = claim_records(&run_dir).map_err(|e| stop("chart", e))?;
    let mut page = Page {
        claims: Vec::new(),
        charts: Vec::new(),
        templates: Vec::new(),
        numbers: Vec::new(),
        sentences: BTreeMap::new(),
        places: Vec::new(),
        times: Vec::new(),
        measures: Vec::new(),
        plans: Vec::new(),
    };
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
        let names = chart_names(&made.chart, &made.series_rows, catalogue);
        record_group_calls(recorder, catalogue)?;
        let names = names.map_err(|e| stop("chart", e))?;
        for id in &made.chart.claim_ids {
            page.templates.push(template_of(&made.chart, id, names.clone()));
        }
        if let Some((chart, _)) = &made.second {
            used.push(chart.relation);
            let names = chart_names(chart, &made.series_rows, catalogue);
            record_group_calls(recorder, catalogue)?;
            page.templates.push(template_of(chart, &chart.claim_ids[0], names.map_err(|e| stop("chart", e))?));
        }
        claim_rows.extend(made.claim_rows);
        let measure = measure_of(table, catalogue, &made.times, made.axis);
        chart_times.extend(made.times);
        page.places.extend(made.places);
        for id in made.chart.claim_ids.iter().chain(made.second.iter().flat_map(|(c, _)| &c.claim_ids)) {
            let sentence = records.get(id).and_then(|r| r["claim"].as_str()).unwrap_or("");
            page.sentences.insert(id.clone(), sentence.to_string());
        }
        page.claims.extend(made.claims);
        push_charts(&mut page, made.chart, made.second, measure);
    }
    if page.charts.is_empty() {
        return Err(stop("chart", format!("no table gives a chart: {}", skipped.join(" | "))));
    }
    page.numbers = next_page::allowed_numbers(&claim_rows, &chart_times);
    page.places.sort();
    page.places.dedup();
    page.times = chart_times;
    page.times.sort();
    page.times.dedup();
    let relations: Vec<Relation> = page.charts.iter().map(|c| c.relation).collect();
    page.plans = catalogue.page_plans(&relations);
    record_group_calls(recorder, catalogue)?;
    Ok(page)
}

/// A table's chart and its second chart, if any, each with its measure at the same index (the pack reads measures[i] for
/// charts[i]); the second chart's measure differs only in what it lists along its category.
fn push_charts(page: &mut Page, chart: Chart, second: Option<(Chart, Axis)>, measure: next_pack::Measure) {
    page.charts.push(chart);
    page.measures.push(measure.clone());
    if let Some((chart, axis)) = second {
        page.charts.push(chart);
        page.measures.push(next_pack::Measure { axis, ..measure });
    }
}

/// The publication module of each hero_stat: a stat bound to its claim's own computation (computation_refs[0], its result_hash),
/// showing the column and row the claim's recorded binding names for value_from. Its texts are the label, placeholders kept (the
/// pack fills them from rows); the value itself is drawn from the bound rows, not typed here.
fn hero_publication(run_dir: &Path, modules: &[Value]) -> Result<Vec<Value>, String> {
    let records = claim_records(run_dir)?;
    let mut out = Vec::new();
    for hero in modules.iter().filter(|m| m["type"] == "hero_stat") {
        let (id, claim_id) = (hero["id"].as_str().unwrap_or(""), hero["claim_id"].as_str().unwrap_or(""));
        let record = records.get(claim_id).ok_or_else(|| format!("{id}: {claim_id} is not in claims.jsonl"))?;
        let bindings = record["claim_bindings"].as_array().cloned().unwrap_or_default();
        let binding = bindings
            .iter()
            .find(|b| b["placeholder"] == hero["value_from"])
            .ok_or_else(|| format!("{id}: claim {claim_id} has no recorded binding for {}", hero["value_from"]))?;
        let rel = record["computation_refs"][0].as_str().ok_or_else(|| format!("{id}: {claim_id} has no computation_refs[0]"))?;
        let hash = computation(run_dir, record, 0)?["result_hash"].as_str().map(str::to_string).ok_or_else(|| format!("{id}: {rel} has no result_hash"))?;
        // The big number carries its page unit (the plan's, from the chart that draws this value column), as the page does.
        let mut view = json!({"row_index": binding["row_index"]});
        if let Some(unit) = hero["unit"].as_str() {
            view["unit"] = json!(unit);
        }
        // Its title and summaries are the design pack's: the page plan's label once filled from this claim's rows (this label still
        // holds the placeholders).
        out.push(json!({"id": id, "type": "stat", "story_node_ids": hero["story_node_ids"], "claim_ids": [claim_id],
            "explanatory_dimension": hero["explanatory_dimension"], "computation_ref": rel, "result_hash": hash,
            "field_mapping_json": json!({"value": binding["column"]}).to_string(),
            "view_spec_json": view.to_string()}));
    }
    Ok(out)
}

/// The code scheme of a country code column (claim_candidates ENTITY_ALIASES): iso2 or iso3, from its name.
fn code_scheme(category: &str) -> Option<&str> {
    category.strip_prefix("country_").filter(|s| matches!(*s, "iso2" | "iso3"))
}

/// The Chinese name of every code a chart lists along a country code column, from the knowledge group's name table; None for
/// any other category. A code the table does not hold stops the page, naming it: neither the code nor an English name goes on
/// a Chinese page.
fn chart_names(chart: &Chart, rows: &[Value], catalogue: &dyn Catalogue) -> Result<Option<BTreeMap<String, String>>, String> {
    let Some(scheme) = code_scheme(&chart.category) else { return Ok(None) };
    let codes: BTreeSet<String> = rows.iter().filter_map(|r| r[&chart.category].as_str().map(str::to_string)).collect();
    let codes: Vec<String> = codes.into_iter().collect();
    catalogue
        .zh_names(scheme, &codes)
        .map(Some)
        .map_err(|missing| format!("the name table has no Chinese name for {} code(s) {}", scheme, missing.join(", ")))
}

/// The design pack's template for one claim of a chart. A country code column names its code scheme, so the chart shows names,
/// not codes, and carries the program's Chinese name of each code, which the pack's text fills with.
fn template_of(chart: &Chart, id: &str, names: Option<BTreeMap<String, String>>) -> Value {
    let mut template = json!({"claim_id": id, "chart_type": chart.relation.template(),
        "fields": {"category_field": chart.category, "value_field": chart.value}});
    if let Some(scheme) = code_scheme(&chart.category) {
        template["category_names"] = json!(scheme);
    }
    if let Some(names) = names {
        template["names"] = json!(names);
    }
    template
}

/// The table's title and the one unit code it was fetched in (its `unit` filter), with that code's catalogue label; the
/// time values its series draws; and what the chart lists along its category.
fn measure_of(table: &Prepared, catalogue: &dyn Catalogue, times: &[String], axis: Axis) -> next_pack::Measure {
    let unit_code = unit_code(table);
    let unit_label = unit_code.as_ref().and_then(|code| {
        let meta = catalogue.table(&table.id)?;
        let (_, codes) = meta.dims.iter().find(|(dim, _)| dim == "unit")?;
        codes.iter().find(|(c, _)| c == code).map(|(_, label)| label.clone())
    });
    let mut times = times.to_vec();
    times.sort();
    times.dedup();
    let name = measure_name(table, catalogue);
    let source = catalogue.table(&table.id).map(|meta| source_line(meta.worldbank, &meta.id, &table.title, &times));
    next_pack::Measure { title: table.title.clone(), name, unit_code, unit_label, times, axis, source }
}

/// A chart's source line: the publisher the catalogue files the table under, its id (a World Bank indicator without its
/// "@2") and title as listed, and the years the chart draws, e.g. "欧盟统计局 sdg_07_40「Share of …」，2025 年".
fn source_line(worldbank: bool, id: &str, title: &str, times: &[String]) -> String {
    let publisher = if worldbank { "世界银行" } else { "欧盟统计局" };
    let id = id.split('@').next().unwrap_or(id);
    let mut line = format!("{publisher} {id}「{}」", title.trim());
    if let (Some(first), Some(last)) = (times.first(), times.last()) {
        let span = if first == last { first.clone() } else { format!("{first}–{last}") };
        let years = times.iter().all(|t| t.len() == 4 && t.bytes().all(|b| b.is_ascii_digit()));
        line.push_str(&format!("，{span}{}", if years { " 年" } else { "" }));
    }
    line
}

/// The draft of the measure's name: when the fetch fixed one code of a breakdown the title names ("… by sector"), the
/// title without its "by …" and with those codes' catalogue labels, e.g. "Share of renewable energy in gross final energy
/// consumption (Renewable energy - overall)"; otherwise the title as listed.
fn measure_name(table: &Prepared, catalogue: &dyn Catalogue) -> String {
    let title = table.title.trim();
    let Some(cut) = title.rfind(" by ") else { return title.to_string() };
    let meta = catalogue.table(&table.id);
    let labels: Vec<String> = table.args.get("filters").and_then(Value::as_array).into_iter().flatten()
        .filter(|f| !matches!(f["dimension"].as_str(), Some("geo" | "unit" | "freq" | "time") | None))
        .filter_map(|f| {
            let dim = f["dimension"].as_str()?;
            let [code] = f["values"].as_array()?.as_slice() else { return None };
            let code = code.as_str()?;
            let label = meta.as_ref()
                .and_then(|m| m.dims.iter().find(|(d, _)| d == dim))
                .and_then(|(_, codes)| codes.iter().find(|(c, l)| c == code && !l.is_empty()))
                .map_or(code, |(_, label)| label.as_str());
            Some(label.to_string())
        })
        .collect();
    if labels.is_empty() {
        return title.to_string();
    }
    format!("{} ({})", &title[..cut], labels.join("; "))
}

/// A map colours regions, so it draws only a ratio the catalogue's unit code names (share, rate or index); a total, a count or a
/// unit it cannot read goes on the other templates (a ranked bar).
fn maps_a_ratio(table: &Prepared) -> bool {
    unit_code(table).as_deref().and_then(next_pack::measure_kind).is_some_and(|k| matches!(k, "share" | "rate" | "index"))
}

/// The one unit code the table was fetched in (its `unit` filter); None when the fetch did not fix one unit.
fn unit_code(table: &Prepared) -> Option<String> {
    table.args.get("filters").and_then(Value::as_array).into_iter().flatten()
        .find(|f| f["dimension"] == "unit")
        .and_then(|f| f["values"].as_array())
        .filter(|values| values.len() == 1)
        .and_then(|values| values[0].as_str())
        .map(str::to_string)
}

/// The fourth ask: the drafted fields reworded once. Refused in every round, it does not stop the run (the data is in and
/// the claims are verified): each field and name that passes on its own in a refused answer of the step is kept (the newest
/// such answer wins), the other fields go back to their drafts, and the fallback is one program event under the last accepted
/// answer. Only a measure left with no Chinese name stops, since its chart would have no title.
pub async fn reword(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    question: &str,
    drafts: &Drafts,
    cancel: &AtomicBool,
) -> Result<BTreeMap<Target, String>, Stop> {
    let ask = drafts.ask(drafts.slot_ids());
    let Ask::Text { fields, numbers, .. } = &ask else { unreachable!("drafts ask for text") };
    let listed: Vec<String> = fields.iter().map(|(n, text)| format!("{n}. {text}")).collect();
    let typed = if numbers.is_empty() { "none".to_string() } else { numbers.join(", ") };
    let slots: Vec<String> = drafts.slot_ids().iter().zip(&drafts.slots).map(|(id, (_, title))| format!("{id}. {title}")).collect();
    let named = if slots.is_empty() {
        String::new()
    } else {
        format!(
            "\nIn `names`, give each chart's measure, named here from its table title and the codes it was fetched in, a Chinese name of at most {} characters \
             with no number (it becomes the chart title):\n{}",
            crate::next_flow::NAME_MAX_CHARS,
            slots.join("\n")
        )
    };
    let prompt = format!(
        "Question: {question}\nPage fields, drafted by the program:\n{}\nRewrite in Simplified Chinese the fields whose wording \
         should fit the question better; leave out the ones to keep. Keep every {{placeholder}} of a field exactly; type no number \
         (and no number in words) except these: {typed}.{named}",
        listed.join("\n")
    );
    let choice = match recorder.ask_step(model, &ask, &prompt, cancel).await {
        Ok((_, choice)) => choice,
        Err(Stop::Refused { step: "text", problem }) => {
            // Every refused answer of the step, newest first: each field and each name that passes every check alone is
            // kept from the newest answer that has it.
            let answers: Vec<Value> = recorder.step_answers().iter().map(|a| ask.decode(a).0).collect();
            let fields_only = Ask::Text { fields: fields.clone(), slots: Vec::new(), numbers: numbers.clone() };
            let mut kept = BTreeMap::new();
            let mut given = Map::new();
            for answer in &answers {
                for (n, wording) in answer["text"].as_object().into_iter().flatten() {
                    let alone = json!({"step": "text", "text": {n.as_str(): wording}, "names": {}});
                    if !kept.contains_key(n) && fields_only.check(&alone).is_ok() {
                        kept.insert(n.clone(), wording.as_str().unwrap_or("").to_string());
                    }
                }
                for (id, name) in answer["names"].as_object().into_iter().flatten() {
                    let one = Ask::Text { fields: BTreeMap::new(), slots: vec![id.clone()], numbers: numbers.clone() };
                    let alone = json!({"step": "text", "text": {}, "names": {id.as_str(): name}});
                    if !given.contains_key(id) && drafts.slot_ids().contains(id) && one.check(&alone).is_ok() {
                        given.insert(id.clone(), name.clone());
                    }
                }
            }
            let text = match fields_only.check(&json!({"step": "text", "text": kept, "names": {}})) {
                Ok(Choice::Text { text, .. }) => text,
                _ => BTreeMap::new(),
            };
            // A chart with no Chinese measure name has no title: stop here, not later in the pack under another name.
            let names = match ask.check(&json!({"step": "text", "text": {}, "names": given})) {
                Ok(Choice::Text { names, .. }) => names,
                _ => {
                    let missing: Vec<String> = drafts.slot_ids().into_iter().filter(|id| !given.contains_key(id)).collect();
                    return Err(stop("text", format!("no Chinese measure name for {} (last refusal: {problem})", missing.join(", "))));
                }
            };
            let choice = Choice::Text { text, names };
            if !recorder.resume_under_last_accepted() {
                return Err(Stop::Refused { step: "text", problem });
            }
            let Choice::Text { text, names } = &choice else { unreachable!("a text check gives a text choice") };
            let back: Vec<&String> = fields.keys().filter(|n| !text.contains_key(*n)).collect();
            recorder.program_event(
                TEXT_FALLBACK_EVENT,
                json!({"problem": problem, "kept": text.keys().collect::<Vec<_>>(), "back_to_draft": back,
                    "names_kept": names.keys().collect::<Vec<_>>()}),
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

/// The first prompt: the question to the design pack's sheet, every step in order. Returns the answer text. `steps` is
/// prepare_claims' spec: empty (the product) asks the model for the tables; a given spec skips that ask (an offline entry).
pub async fn run_page<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    tools: &mut R,
    question: &str,
    steps: &[PrepareStep],
    catalogue: &dyn Catalogue,
    cancel: &AtomicBool,
) -> Result<String, Stop> {
    let prepared = prepare_claims(recorder, model, tools, question, steps, catalogue, cancel).await?;
    let page = charts(recorder, &prepared, catalogue)?;
    let titles: Vec<String> = page.measures.iter().map(|m| m.name.clone()).collect();
    let drafts = next_page::draft(&page.claims, &page.charts, page.numbers.clone()).name_measures(&titles);
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
    let reader = Reader {
        problem: worded.get(&Target::ReaderProblem).cloned().unwrap_or_default(),
        thesis: worded.get(&Target::VisualThesis).cloned().unwrap_or_default(),
        questions: (0..3).filter_map(|i| worded.get(&Target::Question(i)).cloned()).collect(),
    };
    let claims: Vec<PackClaim> = page
        .claims
        .iter()
        .map(|c| PackClaim { id: c.id.clone(), kind: c.kind.clone(), text: page.sentences.get(&c.id).cloned().unwrap_or_default() })
        .collect();
    let verified: BTreeSet<String> = verified.iter().map(|id| id.to_string()).collect();
    let input = PackInput {
        question,
        claims: &claims,
        verified: &verified,
        charts: &page.charts,
        plans: &page.plans,
        places: &page.places,
        times: &page.times,
        reader: &reader,
    };
    let judgement = next_pack::assemble(&input);
    if !judgement.missing.is_empty() {
        return Err(stop("pack", format!("the judgement pack lacks: {}", judgement.missing.join(" | "))));
    }
    let mut first = judgement.pack;
    first.insert("part".into(), json!("first"));
    let sent = recorder.auto(tools, DESIGN_PACK_TOOL, Value::Object(first), cancel).await?;
    let (first_status, problems) = pack_status(&sent);
    save_state(
        recorder.run_dir(),
        &json!({"question": question, "claims": verified, "templates": page.templates, "worded": worded_out,
            "sheet_status": status, "pack_status": first_status}),
    )?;
    if first_status != "FIRST_HALF_DONE" {
        return Err(stop("pack", format!("the design pack refused the first half ({first_status}): {problems}")));
    }
    let sheet_charts = sheet.details.as_ref().and_then(|d| d["sheet"]["charts"].as_array().cloned()).unwrap_or_default();
    let second = next_pack::second(&input, &worded, &page.measures, &sheet_charts);
    if !second.missing.is_empty() {
        return Err(stop("second", format!("the page pack lacks: {}", second.missing.join(" | "))));
    }
    let mut pack = second.pack;
    if let Some(page) = pack.get_mut("page").filter(|p| p["title"].is_string()) {
        let places = prepared.first().map_or(&[][..], |p| p.places_zh.as_slice());
        page["title"] = json!(next_pack::scoped_title(page["title"].as_str().unwrap_or(""), places));
    }
    let heroes = hero_publication(recorder.run_dir(), pack.get("page").and_then(|p| p["modules"].as_array()).map_or(&[][..], Vec::as_slice))
        .map_err(|e| stop("second", e))?;
    if !heroes.is_empty() {
        pack.insert("publication".into(), json!({"modules": heroes}));
    }
    let sent = recorder.auto(tools, DESIGN_PACK_TOOL, Value::Object(pack), cancel).await?;
    let (second_status, problems) = pack_status(&sent);
    save_state(
        recorder.run_dir(),
        &json!({"question": question, "claims": verified, "templates": page.templates, "worded": worded_out,
            "sheet_status": status, "pack_status": second_status}),
    )?;
    if second_status != "PREVIEWED" {
        return Err(stop("second", format!("the design pack refused the second half ({second_status}): {problems}")));
    }
    // The image-aware critic: the model looks at the preview and scores it; the record can only veto (NEWSROOM_VISION_VETO_ONLY).
    let refs = sent.details.as_ref().map(|d| d["refs"].clone()).unwrap_or(Value::Null);
    let images: Vec<Value> = sent.content.iter().filter(|b| b["type"] == "image").cloned().collect();
    let modules: Vec<String> = plan_modules(recorder.run_dir(), &refs["infographicPlanRef"]);
    let ask = Ask::Vision { modules };
    let prompt = format!(
        "Question: {question}\nThe attached image is the desktop preview of the page. Judge only what is visible: score the page and every \
         rubric item 0-100, give your confidence 0-1, and list the visible defects (blocker only for clipping, unreadable text, severe \
         overlap or broken hierarchy). The page passes only with a score of at least 80, every rubric item at least 60 and no blocker."
    );
    let Choice::Vision { score, confidence, rubric, issues } = recorder.ask_step_seeing(model, &ask, &prompt, &images, cancel).await?.1 else {
        unreachable!("a vision check gives a vision choice")
    };
    let issues: Vec<Value> = issues.into_iter().map(|mut i| { i["viewport"] = json!("desktop"); i }).collect();
    let passed = vision_passes(score, &rubric, &issues);
    let critic = recorder
        .auto(tools, VISION_CRITIC_TOOL, json!({"manifest_ref": refs["infographicManifestRef"], "preview_ref": refs["previewRef"],
            "deterministic_critic_ref": refs["infographicCriticRef"], "passed": passed, "score": score, "confidence": confidence,
            "rubric": rubric, "issues": issues, "patches": []}), cancel)
        .await?;
    if critic.is_error || critic.details.as_ref().is_none_or(|d| d["passed"] != true) {
        let text = critic.content.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" ");
        return Err(stop("vision", format!("the image-aware critic did not pass the page: {}", text.chars().take(400).collect::<String>())));
    }
    let sent = recorder.auto(tools, DESIGN_PACK_TOOL, json!({"part": "publish"}), cancel).await?;
    let (publish_status, problems) = pack_status(&sent);
    save_state(
        recorder.run_dir(),
        &json!({"question": question, "claims": verified, "templates": page.templates, "worded": worded_out,
            "sheet_status": status, "pack_status": publish_status}),
    )?;
    if publish_status != "RENDERED" {
        return Err(stop("publish", format!("the design pack refused the publication ({publish_status}): {problems}")));
    }
    // The completion gate. The image under review is the browser screenshot the publication QA wrote: the rendered pack's image
    // whose decoded bytes hash to that file's, found by content; none such means the screenshot is not there, and nothing else
    // stands in for it.
    let refs = sent.details.as_ref().map(|d| d["refs"].clone()).unwrap_or(Value::Null);
    let (shot_ref, shot_sha) = qa_screenshot(recorder.run_dir(), &refs["publicationQaRef"]).map_err(|why| stop("publication_vision", why))?;
    let shown: Vec<&Value> = sent.content.iter().filter(|b| b["type"] == "image").collect();
    let Some(shot) = shown.iter().find(|b| b["data"].as_str().and_then(base64_bytes).is_some_and(|bytes| crate::hash::sha256_bytes(&bytes) == shot_sha)).map(|b| (*b).clone()) else {
        return Err(stop("publication_vision", format!("none of the rendered pack's {} image(s) is the publication screenshot {shot_ref}", shown.len())));
    };
    let ask = Ask::Vision { modules: plan_modules(recorder.run_dir(), &refs["publicationPlanRef"]) };
    let prompt = format!(
        "Question: {question}\nThe attached image is the browser screenshot of the published page, as a reader sees it. Judge only what is \
         visible: score the page and every rubric item 0-100, give your confidence 0-1, and list the visible defects (blocker only for \
         clipping, unreadable text, severe overlap or broken hierarchy). The page passes only with a score of at least 80, every rubric \
         item at least 60 and no blocker."
    );
    let Choice::Vision { score, confidence, rubric, issues } = recorder.ask_step_seeing(model, &ask, &prompt, std::slice::from_ref(&shot), cancel).await?.1 else {
        unreachable!("a vision check gives a vision choice")
    };
    let issues: Vec<Value> = issues.into_iter().map(|mut i| { i["viewport"] = json!("desktop"); i }).collect();
    let passed = vision_passes(score, &rubric, &issues);
    // The verdict is the model's own and can only hold the page back; the event keeps what it saw for the replay.
    recorder.program_event(
        PUBLICATION_VISION_EVENT,
        json!({"publication_manifest_ref": refs["publicationManifestRef"], "qa_ref": refs["publicationQaRef"],
            "screenshot_ref": shot_ref, "image_sha256": shot_sha, "passed": passed,
            "score": score, "confidence": confidence, "rubric": rubric, "issues": issues}),
    )?;
    save_state(
        recorder.run_dir(),
        &json!({"question": question, "claims": verified, "templates": page.templates, "worded": worded_out,
            "sheet_status": status, "pack_status": publish_status, "publication_vision": {"passed": passed, "score": score}}),
    )?;
    if !passed {
        let seen: Vec<String> = issues.iter().map(|i| format!("{}:{}", i["severity"].as_str().unwrap_or("?"), i["code"].as_str().unwrap_or("?"))).collect();
        return Err(stop("publication_vision", format!("the published page did not pass the image review (score {score}; issues: {})", if seen.is_empty() { "none".to_string() } else { seen.join(" | ") })));
    }
    let text = sent.content.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n");
    Ok(text.replacen(RENDERED_NOT_COMPLETE, &format!(" The published page passed the image review: score {score}/100."), 1))
}

/// The pass line of both image reviews (the preview's and the published page's): a score of at least 80, every rubric item at
/// least 60, no blocker.
fn vision_passes(score: u64, rubric: &BTreeMap<String, u64>, issues: &[Value]) -> bool {
    score >= 80 && rubric.values().all(|v| *v >= 60) && !issues.iter().any(|i| i["severity"] == "blocker")
}

/// The desktop screenshot the publication QA record (browser-qa.json) names, as a run-relative ref, and the sha256 of its bytes
/// as read from the file now; Err names what is missing.
fn qa_screenshot(run_dir: &Path, qa_ref: &Value) -> Result<(String, String), String> {
    let qa_ref = qa_ref.as_str().filter(|r| r.starts_with("publications/qa/") && r.ends_with("/browser-qa.json")).ok_or("the publication names no QA record")?;
    let qa = read_json(run_dir, qa_ref)?;
    let name = qa["screenshots"].as_array().into_iter().flatten().find(|s| s["width"] == 1440).and_then(|s| s["path"].as_str())
        .filter(|p| !p.is_empty() && !p.contains('/') && !p.contains(".."))
        .ok_or_else(|| format!("{qa_ref} records no 1440-wide screenshot"))?;
    let shot_ref = format!("{}/{name}", qa_ref.trim_end_matches("/browser-qa.json"));
    let bytes = std::fs::read(run_dir.join(&shot_ref)).map_err(|e| format!("{shot_ref}: {e}"))?;
    Ok((shot_ref, crate::hash::sha256_bytes(&bytes)))
}

/// The bytes of standard, padded base64 text; None when it is not that.
fn base64_bytes(text: &str) -> Option<Vec<u8>> {
    let digits = text.as_bytes();
    if digits.len() % 4 != 0 {
        return None;
    }
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(digits.len() / 4 * 3);
    for (i, quad) in digits.chunks(4).enumerate() {
        let last = i + 1 == digits.len() / 4;
        let pad = quad.iter().rev().take_while(|c| **c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for c in &quad[..4 - pad] {
            n = (n << 6) | u32::from(value(*c)?);
        }
        n <<= 6 * pad as u32;
        out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8][..3 - pad]);
    }
    Some(out)
}

/// The published page's image review, as a program event under its model call.
pub const PUBLICATION_VISION_EVENT: &str = "next_publication_vision";
/// The rendered pack's sentence for a model driving the tools (design_pack.mjs designPackText); in the answer it gives way to
/// the gate's verdict.
const RENDERED_NOT_COMPLETE: &str =
    " The page is NOT complete: look at the images, then call newsroom_infographic_vision_critic with your own verdict.";

/// The image-aware critic (visual group), called by the flow between the previewed page and its publication.
pub const VISION_CRITIC_TOOL: &str = "newsroom_infographic_vision_critic";

/// The module ids of a page or publication plan, which a vision issue may name.
fn plan_modules(run_dir: &Path, plan_ref: &Value) -> Vec<String> {
    plan_ref
        .as_str()
        .and_then(|rel| read_json(run_dir, rel).ok())
        .and_then(|plan| plan["modules"].as_array().map(|m| m.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect()))
        .unwrap_or_default()
}

/// The claim the second chart takes: the first after the lead's that is no ranking, else the second.
fn second_claim(claims: &[Claim]) -> usize {
    (1..claims.len()).find(|&i| next_pack::dimension(&claims[i].kind) != Some("rank")).unwrap_or(1)
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

    /// Both image reviews hold the same line: 80 overall, 60 on every rubric item, no blocker; anything short holds the page back.
    #[test]
    fn the_second_chart_takes_the_first_claim_that_is_no_ranking() {
        let claims = |kinds: &[&str]| -> Vec<Claim> {
            kinds.iter().enumerate().map(|(i, k)| Claim { id: format!("c{}", i + 1), kind: k.to_string(), template: String::new() }).collect()
        };
        assert_eq!(second_claim(&claims(&["rank_top", "rank_bottom", "extreme_gap"])), 2);
        assert_eq!(second_claim(&claims(&["rank_top", "rank_bottom"])), 1, "all rankings: the second claim");
        assert_eq!(second_claim(&claims(&["extreme_gap", "share_of_total"])), 1);
    }

    #[test]
    fn the_image_reviews_pass_only_on_the_line() {
        let rubric = |low: u64| BTreeMap::from([("hierarchy".to_string(), 90), ("legibility".to_string(), low)]);
        let warning = vec![json!({"severity": "warning", "code": "crowded"})];
        assert!(vision_passes(80, &rubric(60), &warning));
        assert!(!vision_passes(79, &rubric(90), &[]));
        assert!(!vision_passes(95, &rubric(59), &[]));
        assert!(!vision_passes(95, &rubric(90), &[json!({"severity": "blocker", "code": "clipped"})]));
    }

    /// The screenshot under review is known by its bytes: base64 decodes exactly, and the QA record's 1440 file is hashed as read.
    #[test]
    fn the_publication_screenshot_is_the_qa_files_bytes() {
        assert_eq!(base64_bytes("aGVsbG8="), Some(b"hello".to_vec()));
        assert_eq!(base64_bytes("aGk="), Some(b"hi".to_vec()));
        assert_eq!(base64_bytes("AAEC"), Some(vec![0, 1, 2]));
        assert_eq!(base64_bytes(""), Some(Vec::new()));
        for bad in ["aGVsbG8", "aG=k", "a===", "aGk=aGk=", "aG\nk"] {
            assert_eq!(base64_bytes(bad), None, "{bad}");
        }
        let dir = tempfile::tempdir().unwrap();
        let qa = dir.path().join("publications/qa/k");
        std::fs::create_dir_all(&qa).unwrap();
        std::fs::write(qa.join("publication-1440.png"), b"png bytes").unwrap();
        let record = |path: &str| json!({"screenshots": [{"width": 390, "path": "small.png"}, {"width": 1440, "path": path}]}).to_string();
        std::fs::write(qa.join("browser-qa.json"), record("publication-1440.png")).unwrap();
        let qa_ref = json!("publications/qa/k/browser-qa.json");
        assert_eq!(qa_screenshot(dir.path(), &qa_ref), Ok(("publications/qa/k/publication-1440.png".to_string(), crate::hash::sha256_bytes(b"png bytes"))));
        assert!(qa_screenshot(dir.path(), &json!("elsewhere/browser-qa.json")).is_err());
        assert!(qa_screenshot(dir.path(), &Value::Null).is_err());
        std::fs::write(qa.join("browser-qa.json"), record("../escape.png")).unwrap();
        assert!(qa_screenshot(dir.path(), &qa_ref).is_err());
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

    /// The q1 page wording of the real batch of 10-27 (drafts and both answers as the model sent them). Answer 1 drops
    /// field 6's {first.year}; answer 2 is the same content with `text` and `names` sent as JSON strings.
    fn q1_drafts() -> Drafts {
        let fields = [
            "哪里最高", "各地在地图上的对比", "各地对比", "{min.value.country_iso2}最低，为{min.value}。", "由高到低",
            "{first.country_iso2} has the highest OBS VALUE in {first.year}.",
            "读图：颜色越深，数值越高，灰色是没有数据；各地是同一口径的数据。", "读者想知道这些数值在地理上怎样分布，哪里最高、哪里最低。",
            "放到地图上看，高值和低值聚在哪里清清楚楚。", "哪里最高？", "哪里最低？", "相邻地区之间是否相近？",
        ];
        Drafts {
            fields: fields.iter().enumerate().map(|(i, f)| (Target::Question(i), f.to_string())).collect(),
            numbers: vec!["2025".into()],
            unplaced: Vec::new(),
            slots: vec![(Target::Measure(0), "Renewable energy share".into()), (Target::Measure(1), "Renewable energy share".into())],
        }
    }

    const Q1_ANSWER_1: &str = r#"{"names": {"s1": "可再生能源占比", "s2": "可再生能源占比"}, "step": "text", "text": {"1": "哪个国家占比最高", "10": "哪个国家占比最高？", "11": "哪个国家占比最低？", "4": "{min.value.country_iso2}占比最低，为{min.value}%。", "6": "{first.country_iso2}的可再生能源占比在2025年最高。", "8": "读者想了解各欧盟成员国可再生能源占比的地理分布情况。"}}"#;
    const Q1_ANSWER_2: &str = r#"{"names": "{\"s1\": \"可再生能源占比\", \"s2\": \"可再生能源占比\"}", "step": "text", "text": "{\"1\": \"哪个国家占比最高\", \"4\": \"{min.value.country_iso2}占比最低，为{min.value}%。\", \"6\": \"{first.country_iso2}的可再生能源占比在{first.year}年最高。\", \"8\": \"读者想了解各欧盟成员国可再生能源占比的地理分布情况。\", \"10\": \"哪个国家占比最高？\", \"11\": \"哪个国家占比最低？\"}"}"#;

    /// Runs the q1 text step on `answers` after an accepted search; the page or the stop, and the events.
    async fn reword_q1(answers: Vec<Value>) -> (Result<BTreeMap<Target, String>, Stop>, Vec<Value>) {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut replies = vec![call("s1", json!({"step": "search", "query": "renewable share"}))];
        replies.extend(answers.into_iter().enumerate().map(|(i, a)| call(&format!("t{}", i + 1), a)));
        let mut model = ScriptedAsker(replies.into());
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = Default::default();
        let into = events.clone();
        let mut sink = move |e: Value| into.lock().unwrap().push(e);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let cancel = AtomicBool::new(false);
        recorder.ask_step(&mut model, &Ask::Search, "search words", &cancel).await.unwrap();
        let page = reword(&mut recorder, &mut model, "欧盟各国可再生能源占比", &q1_drafts(), &cancel).await;
        drop(recorder);
        let events = events.lock().unwrap().clone();
        (page, events)
    }

    /// The real q1 exchange: answer 2, its objects sent as strings, is decoded once and passes whole, and the event says so.
    #[tokio::test]
    async fn the_real_q1_rewording_passes_once_its_stringified_objects_are_decoded() {
        let answers = vec![serde_json::from_str(Q1_ANSWER_1).unwrap(), serde_json::from_str(Q1_ANSWER_2).unwrap()];
        let (page, events) = reword_q1(answers).await;
        let page = page.unwrap();
        assert_eq!(page[&Target::Measure(0)], "可再生能源占比");
        assert_eq!(page[&Target::Measure(1)], "可再生能源占比");
        assert_eq!(page[&Target::Question(5)], "{first.country_iso2}的可再生能源占比在{first.year}年最高。");
        assert!(!events.iter().any(|e| e["type"] == TEXT_FALLBACK_EVENT));
        let ends: Vec<&Value> = events.iter().filter(|e| e["type"] == "tool_execution_end").collect();
        assert_eq!(ends.last().unwrap()["decoded"], json!(["text", "names"]));
        assert!(ends[..ends.len() - 1].iter().all(|e| e.get("decoded").is_none()));
    }

    /// When the later answer holds nothing usable (here answer 2 encoded twice, which is not decoded), the fallback still
    /// keeps answer 1's names and the fields of answer 1 that pass alone; field 6, which dropped a placeholder, is drafted.
    #[tokio::test]
    async fn a_refused_rewording_keeps_names_and_fields_from_an_earlier_answer() {
        let twice = json!({"step": "text", "text": json!(Q1_ANSWER_2).to_string(), "names": json!("{}").to_string()});
        let (page, events) = reword_q1(vec![serde_json::from_str(Q1_ANSWER_1).unwrap(), twice]).await;
        let page = page.unwrap();
        assert_eq!(page[&Target::Measure(0)], "可再生能源占比");
        assert_eq!(page[&Target::Measure(1)], "可再生能源占比");
        assert_eq!(page[&Target::Question(5)], q1_drafts().fields[5].1);
        assert_eq!(page[&Target::Question(0)], "哪个国家占比最高");
        let fallback: Vec<&Value> = events.iter().filter(|e| e["type"] == TEXT_FALLBACK_EVENT).collect();
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0]["kept"], json!(["1", "10", "11", "4", "8"]));
        assert_eq!(fallback[0]["names_kept"], json!(["s1", "s2"]));
    }

    /// No answer of the step names every measure in Chinese: the run stops at the text step and says so.
    #[tokio::test]
    async fn a_rewording_with_no_chinese_measure_name_stops_at_the_text_step() {
        let english = json!({"step": "text", "text": {}, "names": {"s1": "Renewable share", "s2": "可再生能源占比"}});
        let none = json!({"step": "text", "text": {"1": "哪个国家占比最高"}, "names": {}});
        let (page, _) = reword_q1(vec![english, none]).await;
        match page {
            Err(Stop::Page { step: "text", why }) => assert!(why.starts_with("no Chinese measure name for s1 "), "{why}"),
            other => panic!("expected a text stop, got {other:?}"),
        }
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
                    title: String::new(),
                    file: file.unwrap_or_default(),
                    args: args.clone(),
                    sheet: sheet.clone(),
                    claims: details["claims"].as_array().cloned().unwrap_or_default(),
                    places_zh: Vec::new(),
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
        assert_eq!(fields(Relation::Map, &cols(&["geo", "value"])).unwrap(), ("geo".to_string(), "value".to_string()));
        assert!(fields(Relation::Distribution, &cols(&["geo", "value"])).is_err());
    }

    #[test]
    fn a_hero_stat_is_bound_to_its_claims_computation_and_recorded_binding_or_refused() {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        std::fs::create_dir_all(run.join("computations")).unwrap();
        std::fs::write(run.join("computations/own.json"), json!({"result_hash": "h1", "rows": [{"value": 65.4}]}).to_string()).unwrap();
        let record = json!({"claim_id": "c1", "computation_refs": ["computations/own.json", "computations/series.json"],
            "claim_bindings": [{"placeholder": "{max.value}", "column": "value", "row_index": 0}]});
        std::fs::write(run.join("claims.jsonl"), format!("{record}\n")).unwrap();
        let hero = json!({"id": "hero1", "type": "hero_stat", "claim_id": "c1", "value_from": "{max.value}", "label": "瑞典占比最高。",
            "story_node_ids": ["n1"], "explanatory_dimension": "comparison"});
        let text = json!({"id": "text1", "type": "text", "claim_id": "c1"});
        let out = hero_publication(run, &[hero.clone(), text]).unwrap();
        assert_eq!(out.len(), 1, "only a hero_stat publishes as a stat");
        let stat = &out[0];
        assert_eq!((stat["id"].as_str(), stat["type"].as_str()), (Some("hero1"), Some("stat")));
        // The words are the design pack's, from the filled page label; the flow's label may still hold placeholders.
        assert!(["title", "accessibility_summary", "accessibility_long_description"].iter().all(|k| stat.get(*k).is_none()), "{stat}");
        assert_eq!((stat["computation_ref"].as_str(), stat["result_hash"].as_str()), (Some("computations/own.json"), Some("h1")));
        assert_eq!(stat["field_mapping_json"], json!({"value": "value"}).to_string());
        assert_eq!(stat["view_spec_json"], json!({"row_index": 0}).to_string());
        let with_unit = hero_publication(run, &[json!({"id": "hero1", "type": "hero_stat", "claim_id": "c1", "value_from": "{max.value}", "unit": "%"})]).unwrap();
        assert_eq!(with_unit[0]["view_spec_json"], json!({"row_index": 0, "unit": "%"}).to_string());
        assert_eq!(stat["claim_ids"], json!(["c1"]));
        assert!(!stat.to_string().contains("65.4"), "the value is drawn from the bound rows, not typed into the module");
        let mut other = hero.clone();
        other["value_from"] = json!("{min.value}");
        let refused = hero_publication(run, &[other]).unwrap_err();
        assert!(refused.contains("hero1") && refused.contains("no recorded binding for \"{min.value}\""), "{refused}");
        let mut missing = hero;
        missing["claim_id"] = json!("c9");
        assert!(hero_publication(run, &[missing]).unwrap_err().contains("c9 is not in claims.jsonl"));
    }

    #[test]
    fn a_country_code_chart_carries_the_tables_chinese_names_and_an_unknown_code_stops_it() {
        struct NoTables;
        impl Catalogue for NoTables {
            fn top5(&self, _: &str, _: &[String]) -> crate::l5geo::Ranking {
                unreachable!()
            }
            fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
                unreachable!()
            }
            fn source(&self) -> &Value {
                &Value::Null
            }
        }
        let chart = |category: &str| Chart { relation: Relation::Ranking, claim_ids: vec!["c1".into()], category: category.into(), value: "value".into() };
        let rows = [json!({"country_iso2": "SE", "value": 66.4}), json!({"country_iso2": "EL", "value": 25.0})];
        let names = chart_names(&chart("country_iso2"), &rows, &NoTables).unwrap();
        let template = template_of(&chart("country_iso2"), "c1", names);
        assert_eq!(template["category_names"], "iso2");
        assert_eq!(template["names"], json!({"EL": "希腊", "SE": "瑞典"}));
        let aggregate = [json!({"country_iso2": "SE", "value": 1.0}), json!({"country_iso2": "EU27_2020", "value": 2.0})];
        let refused = chart_names(&chart("country_iso2"), &aggregate, &NoTables).unwrap_err();
        assert!(refused.contains("EU27_2020") && !refused.contains("SE"), "{refused}");
        assert_eq!(chart_names(&chart("year"), &rows, &NoTables), Ok(None));
        assert!(template_of(&chart("year"), "c1", None).get("names").is_none());
    }

    #[test]
    fn a_second_chart_gets_its_own_measure_at_its_own_index() {
        let mut page = Page { claims: Vec::new(), charts: Vec::new(), templates: Vec::new(), numbers: Vec::new(), sentences: BTreeMap::new(),
            places: Vec::new(), times: Vec::new(), measures: Vec::new(), plans: Vec::new() };
        let chart = |relation, category: &str| Chart { relation, claim_ids: vec!["c".into()], category: category.into(), value: "value".into() };
        let measure = next_pack::Measure { title: "T".into(), name: "T".into(), unit_code: Some("PC".into()), unit_label: None, times: Vec::new(), axis: Axis::Country, source: None };
        push_charts(&mut page, chart(Relation::Ranking, "geo"), Some((chart(Relation::Map, "geo"), Axis::Other)), measure.clone());
        push_charts(&mut page, chart(Relation::Change, "year"), None, next_pack::Measure { axis: Axis::Time, ..measure });
        let pairs: Vec<(Relation, Axis)> = page.charts.iter().zip(&page.measures).map(|(c, m)| (c.relation, m.axis)).collect();
        assert_eq!(pairs, [(Relation::Ranking, Axis::Country), (Relation::Map, Axis::Other), (Relation::Change, Axis::Time)]);
    }

    #[test]
    fn a_source_line_names_the_publisher_the_table_and_the_years_drawn() {
        let years = |list: &[&str]| list.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert_eq!(source_line(false, "sdg_07_40", "Share of renewables ", &years(&["2025"])), "欧盟统计局 sdg_07_40「Share of renewables」，2025 年");
        assert_eq!(source_line(true, "EG.FEC.RNEW.ZS@2", "Renewables", &years(&["2015", "2023"])), "世界银行 EG.FEC.RNEW.ZS「Renewables」，2015–2023 年");
        assert_eq!(source_line(false, "x", "T", &years(&["2024-01", "2024-06"])), "欧盟统计局 x「T」，2024-01–2024-06");
        assert_eq!(source_line(false, "x", "T", &[]), "欧盟统计局 x「T」");
    }

    #[test]
    fn a_measure_fetched_in_one_code_of_its_breakdown_is_named_for_that_code() {
        struct OneTable;
        impl Catalogue for OneTable {
            fn top5(&self, _: &str, _: &[String]) -> crate::l5geo::Ranking {
                unreachable!()
            }
            fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
                unreachable!()
            }
            fn source(&self) -> &Value {
                &Value::Null
            }
            fn table(&self, id: &str) -> Option<crate::l5geo::TableMeta> {
                let codes = |pairs: &[(&str, &str)]| pairs.iter().map(|(c, l)| (c.to_string(), l.to_string())).collect();
                (id == "t").then(|| crate::l5geo::TableMeta { id: id.into(), worldbank: false, end_year: None, places: Vec::new(),
                    dims: vec![("nrg_bal".into(), codes(&[("REN", "Renewable energy - overall"), ("REN_TRA", "Renewable energy - transport")])),
                        ("unit".into(), codes(&[("PC", "Percentage")]))] })
            }
        }
        let table = |title: &str, filters: Value| Prepared { id: "t".into(), title: title.into(), file: String::new(),
            args: json!({"filters": filters}).as_object().unwrap().clone(), sheet: String::new(), claims: Vec::new(), places_zh: Vec::new() };
        let by_sector = "Share of renewable energy by sector";
        let one = json!([{"dimension": "nrg_bal", "values": ["REN"]}, {"dimension": "unit", "values": ["PC"]}, {"dimension": "geo", "values": ["SE"]}]);
        assert_eq!(measure_name(&table(by_sector, one.clone()), &OneTable), "Share of renewable energy (Renewable energy - overall)");
        let both = json!([{"dimension": "nrg_bal", "values": ["REN", "REN_TRA"]}, {"dimension": "unit", "values": ["PC"]}]);
        assert_eq!(measure_name(&table(by_sector, both), &OneTable), by_sector);
        assert_eq!(measure_name(&table("Share of renewable energy", one), &OneTable), "Share of renewable energy");
    }

    #[test]
    fn only_a_table_fetched_in_a_ratio_unit_may_go_on_a_map() {
        let table = |filters: Value| Prepared { id: "t".into(), title: String::new(), file: String::new(),
            args: json!({"filters": filters}).as_object().unwrap().clone(), sheet: String::new(), claims: Vec::new(), places_zh: Vec::new() };
        let unit = |codes: &[&str]| table(json!([{"dimension": "unit", "values": codes}]));
        assert!(maps_a_ratio(&unit(&["PC"])) && maps_a_ratio(&unit(&["RT"])) && maps_a_ratio(&unit(&["I15_A_AVG"])));
        assert!(!maps_a_ratio(&unit(&["KTOE"])) && !maps_a_ratio(&unit(&["THS_PER"])) && !maps_a_ratio(&unit(&["KG_HAB"])));
        assert!(!maps_a_ratio(&unit(&["PC", "KTOE"])) && !maps_a_ratio(&table(json!([]))));
        // The data side's unit kinds of six local tables (unit_kinds.json): every level code stays off the map; the per-inhabitant
        // and EU27-average codes are not read yet, so they stay off too (a bar, not a guess).
        for code in ["GWH", "KTOE", "TJ", "MIO_T", "THS_T", "PER", "MIO_EUR", "MIO_NAC", "MIO_PPS_EU27_2020", "EUR_HAB", "PPS_EU27_2020_HAB", "EUR_HAB_EU27_2020"] {
            assert!(!maps_a_ratio(&unit(&[code])), "{code}");
        }
        // Only the unit dimension is read: TJ under geo is a country, not terajoules, and a code under another dimension is no unit.
        assert!(!maps_a_ratio(&table(json!([{"dimension": "geo", "values": ["TJ"]}, {"dimension": "indic_et", "values": ["PC_IMP_EU"]}]))));
    }
}
