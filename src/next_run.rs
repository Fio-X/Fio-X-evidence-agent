//! New route, flow group: from the question to the page. After prepare_claims, in the fixed order: each table's fetched file
//! is read into its shape (knowledge group) and the registry's template is picked for it (visual group), both only through
//! their group commands; the program drafts every page field (next_page) and the model rewords them once (Ask::Text); then
//! the leaf page of the first recipe whose shape the tables have is filled, drawn, written through the visual group's door
//! and checked in the browser (leaf_page). What the run decided is kept in PAGE_STATE, so the parent's completion prompts,
//! each in a new child, go on from it instead of picking again.
//!
//! A leaf page that stops at a stage stops the run there; no other route draws the page. On a published page the completion
//! gate (next_gate::leaf_gaps) runs first and its gaps stop the run; then the model scores the page's browser screenshot,
//! and only a pass ends the run. After each step the run's plan.json says which steps are done (save_route_state).
//! Not done here yet: the rerun after a failed gate.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::{json, Map, Value};

use crate::agent_loop::ToolRunner;
use crate::next_flow::{
    prepare_claims, record_group_calls, Ask, Asker, Catalogue, Choice, PrepareStep, Prepared,
    Recorder, Stop,
};
use crate::next_pack;
use crate::next_leaf::Recipe;
use crate::next_page::{self, Chart, Claim, Drafts, Scope, Target, TIME_COLUMNS};
use crate::next_knowledge::{HubMiss, HubOrigin};
use crate::next_params;
use crate::next_render::{BarCard, BarRow, Card, Hero, Label, Num, PageSpec, Seg, LABEL_SRC};
use crate::shape_registry::{Axis, PagePlan, Relation, View};

/// The registry templates whose fields this flow fills from a series' columns (a category and a value column). The others
/// are not offered to the ranking yet: a flow or a composition needs a third column. A map reads the bundled basemap.
pub const FILLED_TEMPLATES: [&str; 3] = ["horizontal_bar", "line", "choropleth"];
/// The registry template a change claim's move series fills (its entity and the first and last value columns). Kept apart from
/// FILLED_TEMPLATES, so a series of values, and the years options it is read for, gain no candidate from it.
pub const MOVE_TEMPLATES: [&str; 1] = ["dumbbell"];
/// The first and the last value columns of a move series (claim_candidates.mjs `move`, with its change column).
pub const MOVE_FROM: &str = "from_value";
pub const MOVE_TO: &str = "to_value";
const MOVE_CHANGE: &str = "change";
/// What the first prompt decided, under the run folder.
pub const PAGE_STATE: &str = "runtime/next-page.json";
/// One per table: the shape's ranking and the template picked, with the fields filled.
pub const CHART_EVENT: &str = "next_chart";
/// A table that gives no chart, and why; the other tables go on.
pub const CHART_SKIPPED_EVENT: &str = "next_chart_skipped";
/// A group of a table's picked claims (one series form) that gives no chart while another group does: its claim ids and why.
/// Those claims leave the page.
pub const CHART_GROUP_DROPPED_EVENT: &str = "next_chart_group_dropped";
/// The rewording was refused in every round: which fields kept the model's wording and which went back to the draft.
pub const TEXT_FALLBACK_EVENT: &str = "next_text_fallback";
/// On a page with a scoped chart: the fields whose reworded wording ranked outside the scope and went back to the draft.
pub const SCOPE_FALLBACK_EVENT: &str = "next_scope_fallback";
/// The origin record of a World Bank table the program narrowed (newsroom.ts prepareWorldBank), under data/origins.
const NARROW_ORIGIN: &str = "worldbank_narrow";
/// The line of the parent's prompt the question follows (prompts/investigate.md); the question ends at the first blank line.
const GOAL_MARK: &str = "Investigation goal:\n";

/// The question as the parent's prompt carries it; None when the prompt has no goal line.
pub fn question_of(prompt: &str) -> Option<String> {
    let rest = &prompt[prompt.find(GOAL_MARK)? + GOAL_MARK.len()..];
    let question = rest.split("\n\n").next().unwrap_or("").trim();
    (!question.is_empty()).then(|| question.to_string())
}

fn stop(step: &'static str, why: impl Into<String>) -> Stop {
    Stop::Page {
        step,
        why: why.into(),
    }
}

fn read_json(run_dir: &Path, rel: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(run_dir.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{rel}: {e}"))
}

/// The claim records newsroom_data_prepare wrote, by claim id; read from the file, never from the tool text.
fn claim_records(run_dir: &Path) -> Result<BTreeMap<String, Value>, String> {
    let text = std::fs::read_to_string(run_dir.join("claims.jsonl"))
        .map_err(|e| format!("claims.jsonl: {e}"))?;
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
        Some(columns) => columns
            .iter()
            .filter_map(|c| c.as_str().map(String::from))
            .collect(),
        None => series["rows"][0]
            .as_object()
            .map(|row| row.keys().cloned().collect())
            .unwrap_or_default(),
    }
}

/// A series that holds each entity's first and last value (a move series) is drawn first-to-last; any other is the slice.
fn view_of(columns: &[String]) -> View {
    if [MOVE_FROM, MOVE_TO]
        .iter()
        .all(|m| columns.iter().any(|c| c == m))
    {
        View::FirstToLast
    } else {
        View::Slice
    }
}

/// The category and value columns of a series for its template. A move series (first-to-last) fills only a change: its category
/// is its one column that is no value and no time, its value the last value (the first is MOVE_FROM). Otherwise the value is
/// `value`; a ranking's category is its one column that is neither the value nor a time, a change's category is its time column.
fn fields(relation: Relation, view: View, columns: &[String]) -> Result<(String, String), String> {
    if view == View::FirstToLast {
        let values = [MOVE_FROM, MOVE_TO, MOVE_CHANGE];
        let found: Vec<&String> = columns
            .iter()
            .filter(|c| !values.contains(&c.as_str()) && !TIME_COLUMNS.contains(&c.as_str()))
            .collect();
        return match (relation, found.as_slice()) {
            (Relation::Change, [one]) => Ok((one.to_string(), MOVE_TO.to_string())),
            (Relation::Change, _) => Err(format!(
                "a move series needs one entity column, the series has {found:?}"
            )),
            (other, _) => Err(format!("{other:?} is not drawn from a move series")),
        };
    }
    if !columns.iter().any(|c| c == "value") {
        return Err(format!(
            "the series has no value column (columns: {columns:?})"
        ));
    }
    let pick = |want: &dyn Fn(&str) -> bool| {
        let found: Vec<&String> = columns
            .iter()
            .filter(|c| c.as_str() != "value" && want(c))
            .collect();
        match found.as_slice() {
            [one] => Ok((one.to_string(), "value".to_string())),
            _ => Err(format!(
                "{relation:?} needs one category column, the series has {found:?}"
            )),
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
    /// The claims' recorded sentences (claims.jsonl `claim`), by id.
    pub sentences: BTreeMap<String, String>,
    /// The place dimensions of the charted tables and the time values their series draw; sorted, no repeats.
    pub places: Vec<String>,
    pub times: Vec<String>,
    /// Per chart, what its fetched table says about the measure.
    pub measures: Vec<next_pack::Measure>,
    /// Per chart, the visual group's page plan row for its relation.
    pub plans: Vec<&'static PagePlan>,
    /// Per chart, how the program chose its places when it narrowed the table (None: all the places the fetch asked for).
    pub scopes: Vec<Option<Scope>>,
}

/// One chart of a table: the chart, what it lists along its category, and the rows of the series its claims draw.
struct Drawn {
    chart: Chart,
    axis: Axis,
    series_rows: Vec<Value>,
}

/// One table's charts: its claims with their kinds and templates (the claims of a dropped group left out), the charts, and what
/// the page's numbers come from.
struct TableChart {
    claims: Vec<Claim>,
    /// The lead chart first (the first picked claim's group), then the other group's, or with one group a second chart of the same
    /// series: the next relation the registry ranks for the shape, drawing one claim.
    charts: Vec<Drawn>,
    claim_rows: Vec<Value>,
    times: Vec<String>,
    places: Vec<String>,
    event: Value,
    /// Each group that gave no chart while another did: its claim ids and why.
    dropped: Vec<(Vec<String>, String)>,
}

/// A picked claim as its sheet and its computations give it.
struct Picked {
    claim: Claim,
    own: Value,
    series: Value,
}

/// The table's candidate sheet, as the claims step wrote it.
fn candidate_sheet(run_dir: &Path, table: &Prepared) -> Result<Value, String> {
    read_json(run_dir, &format!("shadow/candidate_sheet-{}.json", table.sheet))
}

/// A registered claim (`{candidate, claim_id}`) joined to its candidate on the sheet, which gives its kind and template.
fn sheet_entry<'s, 'e>(sheet: &'s Value, entry: &'e Value) -> Result<(&'s Value, &'e str), String> {
    let (Some(candidate), Some(claim_id)) = (entry["candidate"].as_str(), entry["claim_id"].as_str()) else {
        return Err("a registered claim without candidate or claim_id".into());
    };
    let on_sheet = sheet["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["id"] == candidate)
        .ok_or_else(|| format!("candidate {candidate} is not on its sheet"))?;
    Ok((on_sheet, claim_id))
}

/// The table's picked claims in pick order as (kind, claims.jsonl record), through the same sheet join as table_chart.
fn picked_claims(
    run_dir: &Path,
    table: &Prepared,
    records: &BTreeMap<String, Value>,
) -> Result<Vec<(String, Value)>, String> {
    let sheet = candidate_sheet(run_dir, table)?;
    let mut out = Vec::new();
    for entry in &table.claims {
        let (entry, claim_id) = sheet_entry(&sheet, entry)?;
        let record = records
            .get(claim_id)
            .ok_or_else(|| format!("{claim_id} is not in claims.jsonl"))?;
        out.push((entry["kind"].as_str().unwrap_or("").to_string(), record.clone()));
    }
    Ok(out)
}

/// One table read into its shape; its picked claims grouped by series form (a move series or the slice), each group drawn on its own
/// chart with its own rows, never merged. Err says why this table gives no chart.
fn table_chart(
    run_dir: &Path,
    records: &BTreeMap<String, Value>,
    table: &Prepared,
    catalogue: &dyn Catalogue,
    used: &[Relation],
) -> Result<TableChart, String> {
    let meta = catalogue
        .table(&table.id)
        .ok_or("the catalogue lists no dimensions for it")?;
    let csv = std::fs::read_to_string(run_dir.join(&table.file))
        .map_err(|e| format!("the fetched file {}: {e}", table.file))?;
    let shape = catalogue.shape(&meta, &csv)?;
    let sheet = candidate_sheet(run_dir, table)?;
    let mut picked = Vec::new();
    for entry in &table.claims {
        let (entry, claim_id) = sheet_entry(&sheet, entry)?;
        let record = records
            .get(claim_id)
            .ok_or_else(|| format!("{claim_id} is not in claims.jsonl"))?;
        picked.push(Picked {
            own: computation(run_dir, record, 0)?,
            series: computation(run_dir, record, 1)?,
            claim: Claim {
                id: claim_id.to_string(),
                kind: entry["kind"].as_str().unwrap_or("").to_string(),
                template: entry["template"].as_str().unwrap_or("").to_string(),
            },
        });
    }
    if picked.is_empty() {
        return Err("the table has no picked claim to draw".into());
    }
    let mut groups: Vec<(View, Vec<&Picked>)> = Vec::new();
    for p in &picked {
        let view = view_of(&columns(&p.series));
        match groups.iter_mut().find(|(v, _)| *v == view) {
            Some((_, group)) => group.push(p),
            None => groups.push((view, vec![p])),
        }
    }
    let one_group = groups.len() == 1;
    let mut used = used.to_vec();
    let mut charts: Vec<Drawn> = Vec::new();
    let mut events: Vec<Value> = Vec::new();
    let mut dropped = Vec::new();
    for (view, group) in &groups {
        let ids: Vec<String> = group.iter().map(|p| p.claim.id.clone()).collect();
        match group_charts(&shape, table, catalogue, &used, *view, group, one_group) {
            Ok((drawn, event)) => {
                used.extend(drawn.iter().map(|d| d.chart.relation));
                charts.extend(drawn);
                events.push(event);
            }
            Err(why) if one_group => return Err(why),
            Err(why) => dropped.push((ids, why)),
        }
    }
    if charts.is_empty() {
        let why: Vec<String> = dropped.iter().map(|(_, why)| why.clone()).collect();
        return Err(why.join(" | "));
    }
    let mut event = events.remove(0);
    if let Some(other) = events.pop() {
        event["second"] = json!({"template": other["template"], "category_field": other["category_field"],
            "value_field": other["value_field"], "claims": other["claims"]});
        if let Some(start) = other.get("start_field") {
            event["second"]["start_field"] = start.clone();
        }
    }
    // The claims, their rows and their times in pick order, without those of a dropped group.
    let kept: Vec<&Picked> = picked
        .iter()
        .filter(|p| !dropped.iter().any(|(ids, _)| ids.contains(&p.claim.id)))
        .collect();
    Ok(TableChart {
        claims: kept.iter().map(|p| p.claim.clone()).collect(),
        charts,
        claim_rows: kept.iter().map(|p| p.own["rows"][0].clone()).collect(),
        times: kept.iter().flat_map(|p| times(&p.series)).collect(),
        places: shape
            .dims
            .iter()
            .filter(|d| d.is_place)
            .map(|d| d.dim.clone())
            .collect(),
        event,
        dropped,
    })
}

/// The table's shape as a slice series draws it: its time dimension cut to the time values the series rows hold, and removed
/// when they hold one or none (a level series at the latest year does not vary over time, so it ranks as no change). The
/// other dimensions keep the table's members: the series renames their columns, so they are not matched by name.
fn series_shape(
    shape: &crate::shape_registry::Shape,
    rows: &[Value],
) -> crate::shape_registry::Shape {
    use crate::shape_registry::Role;
    let held: BTreeSet<String> = times(&json!({ "rows": rows })).into_iter().collect();
    let mut cut = shape.clone();
    cut.dims.retain_mut(|d| {
        if !d.roles.contains(&Role::Time) {
            return true;
        }
        d.members = d.members.min(held.len());
        d.members > 1
    });
    cut
}

/// One group's charts and its CHART_EVENT: the registry's best template for the group's view (a move series is ranked in the
/// first-to-last view only, over MOVE_TEMPLATES), its fields from the group's series columns, its rows every claim's series rows.
/// With `second` (the table's one group), today's second chart too. Err says why the group gives no chart.
fn group_charts(
    shape: &crate::shape_registry::Shape,
    table: &Prepared,
    catalogue: &dyn Catalogue,
    used: &[Relation],
    view: View,
    group: &[&Picked],
    second: bool,
) -> Result<(Vec<Drawn>, Value), String> {
    let series_rows: Vec<Value> = group
        .iter()
        .flat_map(|p| p.series["rows"].as_array().cloned().unwrap_or_default())
        .collect();
    let mut matched = match view {
        View::Slice => catalogue.rank(&series_shape(shape, &series_rows), &FILLED_TEMPLATES, used),
        View::FirstToLast => catalogue.rank_first_to_last(shape, &MOVE_TEMPLATES, used),
    };
    if !maps_a_ratio(table) {
        matched.candidates.retain(|c| c.relation != Relation::Map);
    }
    let Some(best) = matched.candidates.first() else {
        let why: Vec<String> = matched
            .rejected
            .iter()
            .map(|r| format!("{:?}: {}", r.relation, r.reason))
            .collect();
        return Err(format!(
            "no registered template fits its shape ({})",
            why.join("; ")
        ));
    };
    let columns = columns(&group[0].series);
    let mut chart = Chart {
        relation: best.relation,
        view,
        claim_ids: group.iter().map(|p| p.claim.id.clone()).collect(),
        category: String::new(),
        value: String::new(),
    };
    let (category, value) = fields(best.relation, view, &columns)?;
    let mut event = json!({"table": table.id, "template": best.template(), "explain": best.explain(),
        "others": matched.candidates.iter().skip(1).map(|c| c.explain()).collect::<Vec<_>>(),
        "category_field": category, "value_field": value, "claims": chart.claim_ids});
    if view == View::FirstToLast {
        event["start_field"] = json!(MOVE_FROM);
    }
    chart.category = category;
    chart.value = value;
    // The page draws at least two charts: with two claims or more, the second one goes on the next relation the registry
    // ranks for this shape (another template over the same series), when its fields fill from the series' columns. It takes
    // the first claim after the lead's that is no ranking (the lead chart and the ledger already rank), else the second claim.
    let next = matched
        .candidates
        .iter()
        .find(|c| c.relation != best.relation)
        .filter(|_| second && chart.claim_ids.len() >= 2);
    let mut out = Vec::new();
    let mut second_chart = None;
    if let Some((relation, (category, value))) = next.and_then(|c| {
        fields(c.relation, view, &columns)
            .ok()
            .map(|f| (c.relation, f))
    }) {
        let claims: Vec<Claim> = group.iter().map(|p| p.claim.clone()).collect();
        let id = chart.claim_ids.remove(second_claim(&claims));
        event["second"] = json!({"template": relation.template(view), "category_field": category, "value_field": value, "claims": [id]});
        second_chart = Some(Drawn {
            chart: Chart {
                relation,
                view,
                claim_ids: vec![id],
                category,
                value,
            },
            axis: shape.axis(relation, view),
            series_rows: series_rows.clone(),
        });
    }
    out.push(Drawn {
        axis: shape.axis(chart.relation, view),
        chart,
        series_rows,
    });
    out.extend(second_chart);
    Ok((out, event))
}

/// Each table's shape, template and chart; the sheet's candidates give each claim its kind and template. This comes after the
/// data is in and the claims are verified, so a table that gives no chart is left off the page with one CHART_SKIPPED_EVENT and
/// the others go on; only when no table gives one does the run stop, naming each table's reason.
pub fn charts(
    recorder: &mut Recorder<'_>,
    prepared: &[Prepared],
    catalogue: &dyn Catalogue,
) -> Result<Page, Stop> {
    let run_dir = recorder.run_dir().to_path_buf();
    let records = claim_records(&run_dir).map_err(|e| stop("chart", e))?;
    let mut page = Page {
        claims: Vec::new(),
        charts: Vec::new(),
        templates: Vec::new(),
        sentences: BTreeMap::new(),
        places: Vec::new(),
        times: Vec::new(),
        measures: Vec::new(),
        plans: Vec::new(),
        scopes: Vec::new(),
    };
    let mut used = Vec::new();
    let mut claim_rows = Vec::new();
    let mut chart_times = Vec::new();
    let mut skipped = Vec::new();
    let mut dropped = 0;
    for table in prepared {
        let made = table_chart(&run_dir, &records, table, catalogue, &used);
        record_group_calls(recorder, catalogue)?;
        let made = match made {
            Ok(made) => made,
            Err(why) => {
                recorder
                    .program_event(CHART_SKIPPED_EVENT, json!({"table": table.id, "why": why}))?;
                skipped.push(format!("{}: {why}", table.id));
                continue;
            }
        };
        recorder.program_event(CHART_EVENT, made.event)?;
        for (claims, why) in &made.dropped {
            recorder.program_event(
                CHART_GROUP_DROPPED_EVENT,
                json!({"table": table.id, "claims": claims, "why": why}),
            )?;
            dropped += claims.len();
        }
        for drawn in &made.charts {
            used.push(drawn.chart.relation);
            let names = chart_names(&drawn.chart, &drawn.series_rows, catalogue);
            record_group_calls(recorder, catalogue)?;
            let names = names.map_err(|e| stop("chart", e))?;
            for id in &drawn.chart.claim_ids {
                page.templates
                    .push(template_of(&drawn.chart, id, names.clone()));
            }
        }
        claim_rows.extend(made.claim_rows);
        let mut measure = measure_of(table, catalogue, &made.times, made.charts[0].axis);
        let scope = match narrowed(&run_dir, table).map_err(|e| stop("chart", e))? {
            Some((scope, line)) => {
                measure.source = Some(match measure.source.take() {
                    Some(source) => format!("{source}；{line}"),
                    None => line,
                });
                Some(scope)
            }
            None => None,
        };
        chart_times.extend(made.times);
        page.places.extend(made.places);
        for id in made.charts.iter().flat_map(|d| &d.chart.claim_ids) {
            let sentence = records
                .get(id)
                .and_then(|r| r["claim"].as_str())
                .unwrap_or("");
            page.sentences.insert(id.clone(), sentence.to_string());
        }
        page.claims.extend(made.claims);
        push_charts(&mut page, made.charts, measure, scope);
    }
    if page.charts.is_empty() {
        return Err(stop(
            "chart",
            format!("no table gives a chart: {}", skipped.join(" | ")),
        ));
    }
    if dropped > 0 && page.claims.len() < next_pack::MIN_NODES {
        return Err(stop(
            "chart",
            format!(
                "{} claim(s) are left on the charts once {dropped} on no chart are dropped; the pack's story graph needs at least {}",
                page.claims.len(),
                next_pack::MIN_NODES
            ),
        ));
    }
    page.places.sort();
    page.places.dedup();
    page.times = chart_times;
    page.times.sort();
    page.times.dedup();
    let forms: Vec<(Relation, View)> = page.charts.iter().map(|c| (c.relation, c.view)).collect();
    page.plans = catalogue.page_plans(&forms);
    record_group_calls(recorder, catalogue)?;
    Ok(page)
}

/// A table's charts, each with its measure at the same index (the pack reads measures[i] for charts[i]); a later chart's measure
/// differs only in what it lists along its category.
fn push_charts(
    page: &mut Page,
    charts: Vec<Drawn>,
    measure: next_pack::Measure,
    scope: Option<Scope>,
) {
    for drawn in charts {
        page.charts.push(drawn.chart);
        page.measures.push(next_pack::Measure {
            axis: drawn.axis,
            ..measure.clone()
        });
        page.scopes.push(scope.clone());
    }
}

/// The program's narrowing of a fetched table: the data/origins record of origin NARROW_ORIGIN whose file is the table's,
/// read from the files, never from the tool's text. Its page words are wb-rank-by.json's for the record's option, with the
/// count of economies the record keeps and its rank year: the scope, and the selection line that follows the chart's
/// source. None when no record narrows this file; Err when the records cannot be read or two of them narrow it.
fn narrowed(run_dir: &Path, table: &Prepared) -> Result<Option<(Scope, String)>, String> {
    let Ok(entries) = std::fs::read_dir(run_dir.join("data/origins")) else {
        return Ok(None);
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".json"))
        .collect();
    names.sort();
    let mut found: Option<(String, Value)> = None;
    for name in names {
        let rel = format!("data/origins/{name}");
        let record = read_json(run_dir, &rel)?;
        if record["origin"] != NARROW_ORIGIN || record["file"] != table.file.as_str() {
            continue;
        }
        if let Some((first, _)) = &found {
            return Err(format!("{first} and {rel} both narrow {}", table.file));
        }
        found = Some((rel, record));
    }
    let Some((rel, record)) = found else {
        return Ok(None);
    };
    let (option, members, at) = narrow_words(&rel, &record)?;
    let n = members.to_string();
    let scope = Scope {
        text: option.zh_scope.replace("{n}", &n),
        record: rel.clone(),
    };
    Ok(Some((
        scope,
        option.zh_line.replace("{n}", &n).replace("{at}", &at),
    )))
}

/// What a narrow record (`rel`) says for the page: its wb-rank-by.json option, the count of economies it keeps and its rank
/// year. Err when the option is not registered, or the record keeps no members or has no rank year.
fn narrow_words(
    rel: &str,
    record: &Value,
) -> Result<(&'static next_params::RankBy, usize, String), String> {
    let key = record["option"].as_str().unwrap_or("");
    let option = next_params::wb_rank_by()
        .1
        .iter()
        .find(|o| o.key == key)
        .ok_or_else(|| format!("{rel}: option {key:?} is not in wb-rank-by.json"))?;
    let members = record["members"].as_array().map_or(0, Vec::len);
    let at = match &record["at"] {
        Value::String(at) => at.clone(),
        Value::Number(at) => at.to_string(),
        _ => String::new(),
    };
    if members == 0 || at.is_empty() {
        return Err(format!(
            "{rel}: the record keeps no members or has no rank year"
        ));
    }
    Ok((option, members, at))
}

/// A narrow record's page words (`template`: its option's zh_scope or zh_line) as pieces: `{n}` the count of economies the
/// record keeps (src `<rel>:members`), `{at}` its rank year (src `<rel>:at`), the ranking indicator's id (`by`) a table id,
/// the rest words. Err when the words hold a digit or another placeholder, or `{at}` stands for a year that is not a number.
fn narrow_segs(
    rel: &str,
    template: &str,
    members: usize,
    at: &str,
    by: Option<&str>,
) -> Result<Vec<Seg>, String> {
    let mut marks = vec![(
        "{n}",
        Seg::Num(Num {
            src: format!("{rel}:members"),
            value: members as f64,
            text: members.to_string(),
        }),
    )];
    if template.contains("{at}") {
        let value = at
            .parse::<f64>()
            .map_err(|_| format!("{rel}: the rank year {at:?} is not a number"))?;
        marks.push((
            "{at}",
            Seg::Num(Num {
                src: format!("{rel}:at"),
                value,
                text: at.to_string(),
            }),
        ));
    }
    if let Some(by) = by.filter(|b| !b.is_empty()) {
        marks.push((by, Seg::Ref(by.to_string())));
    }
    let mut out = Vec::new();
    let mut rest = template;
    loop {
        let next = marks
            .iter()
            .filter_map(|(mark, seg)| rest.find(mark).map(|i| (i, mark.len(), seg)))
            .min_by_key(|(i, _, _)| *i);
        let cut = next.map_or(rest.len(), |(i, _, _)| i);
        let words = &rest[..cut];
        if words.contains('{') || words.chars().any(|c| c.is_ascii_digit()) {
            return Err(format!(
                "{rel}: the words {words:?} hold a digit or another placeholder"
            ));
        }
        if !words.is_empty() {
            out.push(Seg::Text(words.to_string()));
        }
        let Some((i, len, seg)) = next else {
            return Ok(out);
        };
        out.push(seg.clone());
        rest = &rest[i + len..];
    }
}

/// A Scope as a page prints it, from its narrow record read again, never from the scope's text.
struct ScopeSegs {
    words: Vec<Seg>,
    /// The selection line after its chart's source (narrowed's).
    line: Vec<Seg>,
    /// The ranking indicator the line names as a table id, if any.
    by: Option<String>,
}

/// The ScopeSegs of a scope. Err when the record no longer gives the scope's text.
fn scope_segs(run_dir: &Path, scope: &Scope) -> Result<ScopeSegs, String> {
    let rel = scope.record.as_str();
    let record = read_json(run_dir, rel)?;
    let (option, members, at) = narrow_words(rel, &record)?;
    if option.zh_scope.replace("{n}", &members.to_string()) != scope.text {
        return Err(format!(
            "{rel}: the record does not give the scope {:?}",
            scope.text
        ));
    }
    let by = option.by.as_deref();
    Ok(ScopeSegs {
        words: narrow_segs(rel, &option.zh_scope, members, &at, by)?,
        line: narrow_segs(rel, &option.zh_line, members, &at, by)?,
        by: by.map(str::to_string),
    })
}

/// The code scheme of a country code column (claim_candidates ENTITY_ALIASES): iso2 or iso3, from its name.
fn code_scheme(category: &str) -> Option<&str> {
    category
        .strip_prefix("country_")
        .filter(|s| matches!(*s, "iso2" | "iso3"))
}

/// The Chinese name of every code a chart lists along a country code column, from the knowledge group's name table; None for
/// any other category. A code the table does not hold stops the page, naming it: neither the code nor an English name goes on
/// a Chinese page.
fn chart_names(
    chart: &Chart,
    rows: &[Value],
    catalogue: &dyn Catalogue,
) -> Result<Option<BTreeMap<String, String>>, String> {
    let Some(scheme) = code_scheme(&chart.category) else {
        return Ok(None);
    };
    let codes: BTreeSet<String> = rows
        .iter()
        .filter_map(|r| r[&chart.category].as_str().map(str::to_string))
        .collect();
    let codes: Vec<String> = codes.into_iter().collect();
    catalogue
        .zh_names(scheme, &codes)
        .map(Some)
        .map_err(|missing| {
            format!(
                "the name table has no Chinese name for {} code(s) {}",
                scheme,
                missing.join(", ")
            )
        })
}

/// The leaf layers' `labels` knob: the Chinese name of every code their request may print, from the same name table as the
/// design pack's charts. The codes are every dimension value of the request's series rows and the members, two letters looked
/// up as iso2 and the rest as iso3. A code the table does not hold is left out, not refused: totals, NSP and the *_OTH rests
/// are never printed, and a leaf that would print one refuses it by name ("the request labels no name for ..."). Err only when
/// the knowledge group cannot answer. Step 5 hands this to the visual group's page request.
fn leaf_labels(
    rows: &[Value],
    members: &[String],
    catalogue: &dyn Catalogue,
) -> Result<BTreeMap<String, String>, String> {
    let mut codes: BTreeSet<String> = members.iter().cloned().collect();
    for row in rows.iter().filter(|r| r["src"].as_str().is_some_and(|s| s.starts_with("series:"))) {
        if let Some(dims) = row["dims"].as_object() {
            codes.extend(dims.values().filter_map(Value::as_str).map(str::to_string));
        }
    }
    let mut labels = BTreeMap::new();
    for (scheme, two) in [("iso2", true), ("iso3", false)] {
        let ask: Vec<String> = codes.iter().filter(|c| (c.len() == 2) == two).cloned().collect();
        let names = match catalogue.zh_names(scheme, &ask) {
            Ok(names) => names,
            // the codes the table does not hold: ask again without them
            Err(missing) if missing.iter().all(|m| ask.contains(m)) => {
                let held: Vec<String> = ask.into_iter().filter(|c| !missing.contains(c)).collect();
                catalogue
                    .zh_names(scheme, &held)
                    .map_err(|e| format!("leaf labels: the name table did not answer for {scheme}: {}", e.join("; ")))?
            }
            Err(e) => return Err(format!("leaf labels: the name table did not answer for {scheme}: {}", e.join("; "))),
        };
        labels.extend(names);
    }
    Ok(labels)
}

/// The hubs a ring page can draw flows into: the hub's geo code, the map point the flows meet at and the map's extent
/// (lon0, lat0, lon1, lat1). No number here prints.
const RING_HUBS: &[(&str, [f64; 2], [f64; 4])] = &[("EU27_2020", [10.0, 50.0], [-12.6, 30.0, 48.6, 70.0])];

/// How many origins a ring page's map draws and names: a visual knob default, as RING_HUBS. No number here prints.
const RING_TOP: usize = 9;

/// How a ring page says what its shares are of: the total of every country outside the hub, which {hub} names by the knowledge
/// group's Chinese name of the hub code, never a fixed word.
const RING_SHARE_WORDS: &str = "占比为{hub}以外各国合计中的占比";

/// The tables' shape as a recipe's conditions found it (SHAPE_CONDITIONS, in the recipe's order), read from the tables'
/// dimensions and rows (never a table id or topic). A field no condition of the recipe sets stays empty; a node needs only
/// what its recipe's conditions set (knobs.py checks each recipe holds what its nodes eat).
#[derive(Debug, Default)]
struct Shape {
    main: String,
    /// The main's dimensions with their codes, and its periods, as dims_of reads them.
    dims: BTreeMap<String, BTreeSet<String>>,
    years: Vec<String>,
    /// The one dimension that varies across places (a ring's origin, a column page's places), and its countries.
    place: String,
    countries: Vec<String>,
    unit: String,
    /// The hub: the main's one geo code, an aggregate with members (the knowledge group's hub_origin), its map point and
    /// extent (RING_HUBS), the place's countries outside its members in code order, and its members.
    hub: String,
    point: [f64; 2],
    extent: [f64; 4],
    outside: Vec<String>,
    members: Vec<String>,
    /// The monthly companion (same origin dimension, hub and unit) and its months.
    companion: String,
    months: Vec<String>,
    /// The last year any of the place's countries has a row at.
    year: String,
}

/// A shape condition: it reads the main's dimensions (and the other tables, the main first) into the shape, or says what
/// is missing; the caller marks it "not this shape".
type Condition = fn(&mut Shape, &[(&str, &[Value])], &dyn Catalogue) -> Result<(), String>;

/// The shape conditions a recipe names (knobs.json recipes[].eats), each once here, whatever recipe names it.
const SHAPE_CONDITIONS: &[(&str, Condition)] = &[
    ("annual", annual),
    ("years_2", years_2),
    ("hub_origin", hub_origin),
    ("one_place", one_place),
    ("one_unit", one_unit),
    ("others_single", others_single),
    ("monthly_companion", monthly_companion),
    ("last_year", last_year),
];

/// The codes each dimension of a table's series rows holds, and its periods, both sorted.
fn dims_of(rows: &[Value]) -> (BTreeMap<String, BTreeSet<String>>, BTreeSet<String>) {
    let (mut dims, mut times): (BTreeMap<String, BTreeSet<String>>, BTreeSet<String>) = Default::default();
    for r in rows.iter().filter(|r| r["src"].as_str().is_some_and(|s| s.starts_with("series:"))) {
        for (d, c) in r["dims"].as_object().into_iter().flatten() {
            dims.entry(d.clone()).or_default().extend(c.as_str().map(str::to_string));
        }
        times.extend(r["time"].as_str().map(str::to_string));
    }
    (dims, times)
}

/// The tables' shape by a recipe's conditions, in its order: `tables` are (table, its series rows), the main first. Err is
/// "not this shape: <what is missing>", for the run record, at the first condition that fails; nothing is made up.
fn shape_of(eats: &[String], tables: &[(&str, &[Value])], catalogue: &dyn Catalogue) -> Result<Shape, String> {
    let no = |why: String| format!("not this shape: {why}");
    let (main, rows) = tables.first().ok_or_else(|| no("no table".into()))?;
    let (dims, years) = dims_of(rows);
    let mut shape = Shape { main: main.to_string(), dims, years: years.into_iter().collect(), ..Shape::default() };
    for name in eats {
        let Some((_, condition)) = SHAPE_CONDITIONS.iter().find(|(n, _)| n == name) else {
            let names: Vec<&str> = SHAPE_CONDITIONS.iter().map(|(n, _)| *n).collect();
            return Err(no(format!("no shape condition {name}; e.g. one of {}", names.join("|"))));
        };
        condition(&mut shape, tables, catalogue).map_err(no)?;
    }
    Ok(shape)
}

fn is_year(t: &str) -> bool {
    t.len() == 4 && t.bytes().all(|b| b.is_ascii_digit())
}

/// The one code a dimension holds.
fn one_code(dims: &BTreeMap<String, BTreeSet<String>>, d: &str) -> Option<String> {
    match dims.get(d).map(|c| c.iter().collect::<Vec<_>>()) {
        Some(c) if c.len() == 1 => Some(c[0].clone()),
        _ => None,
    }
}

/// Every period of the main is a year.
fn annual(s: &mut Shape, _: &[(&str, &[Value])], _: &dyn Catalogue) -> Result<(), String> {
    if s.years.is_empty() || !s.years.iter().all(|t| is_year(t)) {
        return Err(format!("main {} is not annual", s.main));
    }
    Ok(())
}

/// The main spans two years or more.
fn years_2(s: &mut Shape, _: &[(&str, &[Value])], _: &dyn Catalogue) -> Result<(), String> {
    match s.years.as_slice() {
        [one] => Err(format!("main spans one year ({one})")),
        _ => Ok(()),
    }
}

/// A flow to a hub: a dimension is the origin when it varies and at least two of its codes are countries (the knowledge
/// group's Countries); the hub is the main's one geo code, an aggregate with members, as the knowledge group's hub_origin
/// answers (the companion overlap places a hub table by the same answer), and a row in RING_HUBS.
fn hub_origin(s: &mut Shape, _: &[(&str, &[Value])], catalogue: &dyn Catalogue) -> Result<(), String> {
    let main = &s.main;
    let mut countries = BTreeSet::new();
    let geo_last = s.dims.iter().filter(|(d, _)| d.as_str() != "geo").chain(s.dims.get_key_value("geo"));
    for (_, codes) in geo_last.filter(|(_, c)| c.len() > 1) {
        countries.extend(catalogue.countries(&codes.iter().cloned().collect::<Vec<_>>())?);
    }
    let geo: Vec<&String> = s.dims.get("geo").into_iter().flatten().collect();
    let members = match geo.as_slice() {
        [one] => catalogue.members(one).ok(),
        _ => None,
    };
    let aggregates = geo.iter().filter(|_| members.is_some()).map(|g| g.to_string()).collect();
    let HubOrigin { hub, origin } = catalogue.hub_origin(&s.dims, &countries, &aggregates).map_err(|miss| match miss {
        HubMiss::NoOrigin => format!("no country origin dim in main {main}"),
        HubMiss::ManyOrigins(many) => format!("no single country origin dim: {}", many.join(", ")),
        HubMiss::NoHub(geo) => format!("no hub: main {main} has geo {}", geo.join(",")),
    })?;
    let members = members.ok_or_else(|| format!("no hub: the member list has no aggregate {hub}"))?;
    let &(_, point, extent) = RING_HUBS.iter().find(|(h, ..)| *h == hub).ok_or_else(|| format!("no hub row for {hub}"))?;
    let codes: Vec<String> = s.dims[&origin].iter().cloned().collect();
    s.outside = catalogue.countries(&codes)?.into_iter().filter(|c| !members.contains(c)).collect();
    (s.place, s.hub, s.point, s.extent, s.members) = (origin, hub, point, extent, members);
    Ok(())
}

/// One table across places: exactly one dimension but freq varies, and at least two of its codes are countries.
fn one_place(s: &mut Shape, _: &[(&str, &[Value])], catalogue: &dyn Catalogue) -> Result<(), String> {
    let varied: Vec<&String> = s.dims.iter().filter(|(d, c)| d.as_str() != "freq" && c.len() > 1).map(|(d, _)| d).collect();
    let [place] = varied.as_slice() else {
        return Err(format!("main {} varies on {varied:?}, not on one place dimension", s.main));
    };
    let place = place.to_string();
    let countries = catalogue.countries(&s.dims[&place].iter().cloned().collect::<Vec<_>>())?;
    if countries.len() < 2 {
        return Err(format!("main {place} holds {} countries, not two or more", countries.len()));
    }
    (s.place, s.countries) = (place, countries);
    Ok(())
}

/// The main holds one unit.
fn one_unit(s: &mut Shape, _: &[(&str, &[Value])], _: &dyn Catalogue) -> Result<(), String> {
    s.unit = one_code(&s.dims, "unit").ok_or_else(|| format!("main {} has no single unit", s.main))?;
    Ok(())
}

/// Every dimension of the main but the place and freq holds one code, so the page plots one series.
fn others_single(s: &mut Shape, _: &[(&str, &[Value])], _: &dyn Catalogue) -> Result<(), String> {
    match s.dims.iter().find(|(d, c)| **d != s.place && d.as_str() != "freq" && c.len() > 1) {
        Some((d, _)) => Err(format!("main {d} varies")),
        None => Ok(()),
    }
}

/// The main's monthly companion: the first other table whose periods are all months, with the origin dimension, the hub
/// and the unit; every other dimension but freq holds one code, the main's.
fn monthly_companion(s: &mut Shape, tables: &[(&str, &[Value])], _: &dyn Catalogue) -> Result<(), String> {
    let month = |t: &String| t.len() == 7 && t.as_bytes()[4] == b'-' && is_year(&t[..4]);
    let (origin, hub, unit, dims) = (&s.place, &s.hub, &s.unit, &s.dims);
    let mut why = "no monthly companion".to_string();
    for (table, rows) in &tables[1..] {
        let (cdims, times) = dims_of(rows);
        if times.is_empty() || !times.iter().all(month) {
            continue;
        }
        if !cdims.contains_key(origin) || one_code(&cdims, "geo").as_ref() != Some(hub) {
            why = format!("no monthly companion with origin dim {origin} and hub {hub}");
            continue;
        }
        let cunit = one_code(&cdims, "unit");
        if cunit.as_ref() != Some(unit) {
            why = format!("unit differs: main {unit}, monthly {table} {}", cunit.unwrap_or_else(|| "not one".into()));
            continue;
        }
        if let Some(d) = cdims.keys().find(|d| d.as_str() != "freq" && !dims.contains_key(*d)) {
            why = format!("monthly {table} {d} not in main");
            continue;
        }
        let differs = cdims.keys().filter(|d| *d != origin && d.as_str() != "freq").find_map(|d| {
            match (one_code(&cdims, d), one_code(dims, d)) {
                (None, _) => Some(format!("monthly {table} {d} varies")),
                (Some(x), Some(y)) if x != y => Some(format!("monthly {table} {d} is {x}, main {y}")),
                _ => None,
            }
        });
        if let Some(d) = differs {
            why = d;
            continue;
        }
        (s.companion, s.months) = (table.to_string(), times.into_iter().collect());
        return Ok(());
    }
    Err(why)
}

/// A finite value of a series row.
fn row_value(r: &Value) -> Option<f64> {
    r["value"].as_str().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite())
}

/// The last year any of the place's countries has a value at.
fn last_year(s: &mut Shape, tables: &[(&str, &[Value])], _: &dyn Catalogue) -> Result<(), String> {
    let rows = tables[0].1;
    let year = rows
        .iter()
        .filter(|r| r["dims"][&s.place].as_str().is_some_and(|c| s.countries.iter().any(|k| k == c)) && row_value(r).is_some())
        .filter_map(|r| r["time"].as_str())
        .max()
        .ok_or_else(|| format!("main {} has no country value", s.main))?;
    s.year = year.to_string();
    Ok(())
}

/// The ring kind whose subject is the page's focus: the member of the cut that changed most between two years. The non-cut
/// change_largest_rise/fall bind the same columns and never set the focus.
const MEMBER_CHANGE: &str = "cut_members_largest_change";

/// What the picked claims fix for a ring page, read from their bindings, and the origins the page's map draws.
#[derive(Debug, PartialEq)]
struct RingPicks {
    /// The subject of the one picked member change claim.
    focus: String,
    /// The earliest from_year and the latest to_year the picked claims bind.
    t0: String,
    t1: String,
    /// The page's top-N origins (ring_top at t0 and t1).
    top: Vec<String>,
}

/// The origins a ring page's map draws, as the leaf ranks them (runtime/leaves_py/prod.py MapFrame.top): the shape's countries
/// outside the hub, by the larger of their main values at t0 and t1 at the hub, largest first, an absent value 0, a tie to
/// code order; the first RING_TOP.
fn ring_top(shape: &Shape, main: &[Value], t0: &str, t1: &str) -> Vec<String> {
    let at = |code: &str, t: &str| {
        main.iter()
            .find(|r| r["dims"][&shape.place] == code && r["dims"]["geo"] == shape.hub.as_str() && r["time"] == t)
            .and_then(|r| r["value"].as_str())
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let mut ranked: Vec<(f64, &String)> = shape.outside.iter().map(|c| (at(c, t0).max(at(c, t1)), c)).collect();
    // shape.outside is in code order and the sort is stable
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    ranked.into_iter().take(RING_TOP).map(|(_, c)| c.clone()).collect()
}

/// The ring page's focus and years from the main's picked claims (kind, claims.jsonl record), checked against the shape and
/// the main's rows (`main`: its series rows): the focus is the subject of the one picked member change claim and one of the
/// page's top-N origins, and the rows' values for it at that claim's two years must be the very numbers it bound. Err is
/// "not this shape: <why>"; nothing is repaired or chosen in its place.
fn ring_picks(shape: &Shape, main: &[Value], claims: &[(String, Value)]) -> Result<RingPicks, String> {
    let no = |why: String| format!("not this shape: {why}");
    let id = |record: &Value| record["claim_id"].as_str().unwrap_or("").to_string();
    let bindings = |record: &Value| record["claim_bindings"].as_array().cloned().unwrap_or_default();
    let changes: Vec<&Value> = claims.iter().filter(|(kind, _)| kind == MEMBER_CHANGE).map(|(_, r)| r).collect();
    let change = match changes.as_slice() {
        [one] => *one,
        [] => return Err(no("no member change claim picked".into())),
        many => return Err(no(format!("{} member change claims picked", many.len()))),
    };
    let named: Vec<String> = bindings(change)
        .iter()
        .filter(|b| b["column"].as_str().and_then(code_scheme).is_some())
        .filter_map(|b| b["value"].as_str().map(str::to_string))
        .collect();
    let [focus] = named.as_slice() else {
        return Err(no(format!("claim {} names no single country", id(change))));
    };
    let focus = focus.clone();
    let year = |record: &Value, column: &str| -> Result<Option<i64>, String> {
        let years: Vec<Value> =
            bindings(record).into_iter().filter(|b| b["column"] == column).map(|b| b["value"].clone()).collect();
        match years.as_slice() {
            [] => Ok(None),
            [y] => y.as_i64().map(Some).ok_or_else(|| no(format!("claim {} binds {column} {y}, not a year", id(record)))),
            _ => Err(no(format!("claim {} binds {column} more than once", id(record)))),
        }
    };
    let (mut t0, mut t1): (Option<i64>, Option<i64>) = (None, None);
    for (_, record) in claims {
        if let Some(y) = year(record, "from_year")? {
            t0 = Some(t0.map_or(y, |t| t.min(y)));
        }
        if let Some(y) = year(record, "to_year")? {
            t1 = Some(t1.map_or(y, |t| t.max(y)));
        }
    }
    let (Some(t0), Some(t1)) = (t0, t1) else {
        return Err(no(format!("claim {} binds no from_year and to_year", id(change))));
    };
    for y in [t0, t1] {
        if !shape.years.contains(&y.to_string()) {
            return Err(no(format!("claim year {y} not in main {}", shape.main)));
        }
    }
    if t0 >= t1 {
        return Err(no(format!("t0 {t0} is not before t1 {t1}")));
    }
    let top = ring_top(shape, main, &t0.to_string(), &t1.to_string());
    if !top.contains(&focus) {
        return Err(no(format!("focus {focus} is not a top-N origin of main {}", shape.main)));
    }
    // the rows the page prints for the focus are the numbers the claim bound, compared exactly on the parsed numbers
    for (year_col, value_col) in [("from_year", "from_value"), ("to_year", "to_value")] {
        let at = year(change, year_col)?.ok_or_else(|| no(format!("claim {} binds no {year_col}", id(change))))?.to_string();
        let bound = bindings(change).iter().find(|b| b["column"] == value_col).and_then(|b| b["value"].as_f64());
        let held = main
            .iter()
            .find(|r| r["dims"][&shape.place] == focus.as_str() && r["time"] == at.as_str())
            .and_then(|r| r["value"].as_str())
            .and_then(|v| v.parse::<f64>().ok());
        let Some(held) = held else {
            return Err(no(format!("main {} has no row for {focus} at {at}", shape.main)));
        };
        if bound != Some(held) {
            return Err(no(format!("claim {} and main rows disagree for {focus} at {at}", id(change))));
        }
    }
    Ok(RingPicks {
        focus,
        t0: t0.to_string(),
        t1: t1.to_string(),
        top,
    })
}

/// What the program picks for a page over its shape and the picked claims (PICK_RULES, in the recipe's order); a field no
/// rule of the recipe sets stays empty.
#[derive(Debug, Default)]
struct Picks {
    /// A ring's focus, years and top-N origins (ring_picks).
    focus: String,
    t0: String,
    t1: String,
    top: Vec<String>,
    /// The place's countries with a value at the shape's year, largest first, a tie to code order.
    ranked: Vec<String>,
    /// The ranked countries the picked claims name, in claim order.
    marks: Vec<String>,
}

/// A pick rule over the shape, the main's series rows and the picked claims (kind, claims.jsonl record). Err is "not this
/// shape: <why>"; nothing is repaired or chosen in its place.
type PickRule = fn(&mut Picks, &Shape, &[Value], &[(String, Value)]) -> Result<(), String>;

/// The pick rules a recipe names (knobs.json recipes[].picks), each once here, whatever recipe names it.
const PICK_RULES: &[(&str, PickRule)] = &[("change_focus", change_focus), ("ranked", ranked), ("claim_marks", claim_marks)];

/// The page's picks by a recipe's rules, in its order.
fn picks_of(rules: &[String], shape: &Shape, main: &[Value], claims: &[(String, Value)]) -> Result<Picks, String> {
    let mut picks = Picks::default();
    for name in rules {
        let Some((_, rule)) = PICK_RULES.iter().find(|(n, _)| n == name) else {
            let names: Vec<&str> = PICK_RULES.iter().map(|(n, _)| *n).collect();
            return Err(format!("not this shape: no pick rule {name}; e.g. one of {}", names.join("|")));
        };
        rule(&mut picks, shape, main, claims)?;
    }
    Ok(picks)
}

/// A ring's focus, years and top-N origins (ring_picks): its checks hold together (the focus must be a top-N origin).
fn change_focus(p: &mut Picks, shape: &Shape, main: &[Value], claims: &[(String, Value)]) -> Result<(), String> {
    let RingPicks { focus, t0, t1, top } = ring_picks(shape, main, claims)?;
    (p.focus, p.t0, p.t1, p.top) = (focus, t0, t1, top);
    Ok(())
}

/// The place's countries with a value at the shape's year, largest first, a tie to code order; a country twice refuses.
fn ranked(p: &mut Picks, shape: &Shape, main: &[Value], _: &[(String, Value)]) -> Result<(), String> {
    let no = |why: String| format!("not this shape: {why}");
    let (place, year) = (&shape.place, shape.year.as_str());
    let mut ranked: Vec<(f64, String)> = main
        .iter()
        .filter(|r| r["time"] == year)
        .filter_map(|r| r["dims"][place].as_str().filter(|c| shape.countries.iter().any(|k| k == c)).zip(row_value(r)))
        .map(|(c, v)| (v, c.to_string()))
        .collect();
    let mut seen = BTreeSet::new();
    if let Some((_, twice)) = ranked.iter().find(|(_, c)| !seen.insert(c.as_str())) {
        return Err(no(format!("main {} holds {twice} twice at {year}", shape.main)));
    }
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    if ranked.is_empty() {
        return Err(no(format!("main {} ranks no country", shape.main)));
    }
    p.ranked = ranked.into_iter().map(|(_, c)| c).collect();
    Ok(())
}

/// The ranked countries the picked claims name (a binding in a country code column), in claim order, each once.
fn claim_marks(p: &mut Picks, _: &Shape, _: &[Value], claims: &[(String, Value)]) -> Result<(), String> {
    for (_, record) in claims {
        for b in record["claim_bindings"].as_array().into_iter().flatten() {
            let named = b["value"].as_str().filter(|_| b["column"].as_str().and_then(code_scheme).is_some());
            if let Some(code) = named.filter(|c| p.ranked.iter().any(|k| k == c) && !p.marks.iter().any(|m| m == c)) {
                p.marks.push(code.to_string());
            }
        }
    }
    Ok(())
}

/// The ring's first month: `span` months (the visual knob ring.months) back from the companion's last month, that month
/// counted, or its first month when it holds fewer. None when it holds no month.
fn ring_from(months: &[String], span: i64) -> Option<String> {
    let last = months.last()?;
    let (y, m): (i64, i64) = (last[..4].parse().ok()?, last[5..].parse().ok()?);
    let i = y * 12 + m - 1 - (span - 1);
    let from = format!("{}-{:02}", i.div_euclid(12), i.rem_euclid(12) + 1);
    Some(if from < months[0] { months[0].clone() } else { from })
}

/// What a node's fill reads: the page's shape and picks, the main's and the companion's series rows, the catalogue, the
/// unit's format key and registered short form, and the page's time window (window_of) as its first and last month.
struct Filling<'a> {
    shape: &'a Shape,
    picks: &'a Picks,
    main: &'a [Value],
    companion: &'a [Value],
    catalogue: &'a dyn Catalogue,
    fmt: String,
    short: &'a str,
    window: Option<(String, String)>,
}

/// A recipe's time window over the picks, as its first and last month: ["t0", "t1"] runs from t0's January to t1's
/// December; none is None. Any other window, or picks without both years, is Err.
fn window_of(recipe: &Recipe, picks: &Picks) -> Result<Option<(String, String)>, String> {
    match recipe.window.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => Ok(None),
        ["t0", "t1"] if is_year(&picks.t0) && is_year(&picks.t1) => Ok(Some((format!("{}-01", picks.t0), format!("{}-12", picks.t1)))),
        ["t0", "t1"] => Err(format!("the window runs from t0 to t1, and the picks give {:?} to {:?}", picks.t0, picks.t1)),
        _ => Err(format!("recipe {} has a window {:?}; the one window is [\"t0\", \"t1\"]", recipe.name, recipe.window)),
    }
}

/// What the nodes of a page put into its request, bottom first: the rows each prints from, the facts it declares (computed by
/// the visual group, never here), its formats, its keys of the hero's data and its other hero keys, and the notes after the
/// unit. A key two nodes set to different values refuses the page.
#[derive(Default)]
struct Filled {
    rows: Vec<Value>,
    facts: Map<String, Value>,
    fmts: Map<String, Value>,
    data: Map<String, Value>,
    hero: Map<String, Value>,
    notes: Vec<String>,
}

impl Filled {
    fn set(map: &mut Map<String, Value>, what: &str, key: &str, value: Value) -> Result<(), String> {
        match map.get(key) {
            Some(was) if *was != value => Err(format!("two layers set the {what} {key} differently")),
            _ => {
                map.insert(key.to_string(), value);
                Ok(())
            }
        }
    }
    /// Rows a layer prints from, each once (by its src).
    fn rows(&mut self, rows: impl IntoIterator<Item = Value>) {
        for r in rows {
            if !self.rows.iter().any(|k| k["src"] == r["src"]) {
                self.rows.push(r);
            }
        }
    }
}

/// A node's fill: program rules over the shape and picks, nothing chosen by a model. Err is the why; the caller marks it
/// "not this shape".
type NodeFill = fn(&Filling, &mut Filled) -> Result<(), String>;

/// The nodes that put something into a page's request, each once here, whatever recipe draws it; a layer with none here
/// (callouts, legend, inset) prints from what the others put.
const NODE_FILLS: &[(&str, NodeFill)] = &[
    ("map", map_fill),
    ("ring", ring_node_fill),
    ("bars", bars_fill),
    ("bignums", bignums_fill),
    ("notes", notes_fill),
    ("strip", strip_fill),
];

/// A filter of a fact: dimension -> code.
fn filter(pairs: &[(&str, &str)]) -> Value {
    Value::Object(pairs.iter().map(|(k, v)| (k.to_string(), json!(v))).collect())
}

/// The flow map into the hub. Rows: the main's at the hub for the shape's countries (outside the hub and its members, so no
/// aggregate row is ever summed). Facts, keyed by the lowercase code and the year's last two digits: each top origin's value
/// at t0 and t1, its change (only from a t0 value above 0: a change from nothing has no ratio) and its t1 share of the total;
/// the totals (the rest of the countries outside the hub, none skipped) and their change; the map's label and legend values.
/// The unit's format is its registered short form, unscaled; a hub the name table does not name is refused, and the unit
/// note says what the shares are of.
fn map_fill(f: &Filling, out: &mut Filled) -> Result<(), String> {
    let (shape, picks, fmt) = (f.shape, f.picks, f.fmt.as_str());
    let (y0, y1) = (&picks.t0[2..], &picks.t1[2..]);
    if y0 == y1 {
        return Err(format!("t0 {} and t1 {} share their last two digits", picks.t0, picks.t1));
    }
    let (origin, hub) = (shape.place.as_str(), shape.hub.as_str());
    // the scheme by length, as leaf_labels: a hub the iso3 table does not name (EA20) refuses below
    let scheme = if hub.len() == 2 { "iso2" } else { "iso3" };
    let hub_zh = f
        .catalogue
        .zh_names(scheme, &[hub.to_string()])
        .ok()
        .and_then(|mut names| names.remove(hub))
        .ok_or_else(|| format!("the name table names no hub {hub}"))?;
    let countries: BTreeSet<&str> = shape.outside.iter().chain(&shape.members).map(String::as_str).collect();
    out.rows(
        f.main
            .iter()
            .filter(|r| r["dims"]["geo"] == hub && r["dims"][origin].as_str().is_some_and(|c| countries.contains(c)))
            .cloned(),
    );
    let facts = &mut out.facts;
    let mut fact = |key: String, q: Value| Filled::set(facts, "fact", &key, q);
    for (y, t) in [(y0, &picks.t0), (y1, &picks.t1)] {
        let q = json!({"op": "rest", "table": shape.main, "filter": filter(&[("geo", hub)]), "by": origin, "not_eu": true,
            "skip": 0, "time": t, "fmt": fmt});
        fact(format!("tot{y}"), q)?;
    }
    fact("tot_ch".into(), json!({"op": "change", "a": format!("tot{y1}"), "b": format!("tot{y0}")}))?;
    let above_0 = |code: &str| {
        f.main.iter().any(|r| {
            r["dims"][origin] == code && r["dims"]["geo"] == hub && r["time"] == picks.t0.as_str()
                && r["value"].as_str().and_then(|v| v.parse::<f64>().ok()).is_some_and(|v| v > 0.0)
        })
    };
    for code in &picks.top {
        let c = code.to_lowercase();
        for (y, t) in [(y0, &picks.t0), (y1, &picks.t1)] {
            let q = json!({"table": shape.main, "filter": filter(&[(origin, code.as_str()), ("geo", hub)]), "time": t, "fmt": fmt});
            fact(format!("{c}{y}"), q)?;
        }
        if above_0(code) {
            fact(format!("{c}_ch"), json!({"op": "change", "a": format!("{c}{y1}"), "b": format!("{c}{y0}")}))?;
        }
        fact(format!("{c}{y1}_share"), json!({"op": "share", "a": format!("{c}{y1}"), "b": format!("tot{y1}")}))?;
    }
    for (key, t) in [("lab_t0", &picks.t0), ("lab_t1", &picks.t1)] {
        let q = json!({"op": "value", "each": origin, "table": shape.main, "filter": filter(&[("geo", hub)]), "time": t,
            "not_eu": origin, "fmt": fmt});
        fact(key.into(), q)?;
    }
    Filled::set(&mut out.fmts, "format", fmt, json!({"scale": 1, "dec": 0, "suffix": suffix(f.short)}))?;
    let data = json!({"chart": "flowmap", "fmt": fmt, "q": {"table": shape.main, "filter": filter(&[("geo", hub)]), "by": origin,
        "not_eu": true}, "t0": picks.t0, "t1": picks.t1, "top": picks.top, "hub": shape.point, "ext": shape.extent,
        "focus": picks.focus, "hub_name": hub_zh, "label_fact": "lab_t1", "legend_fact": "lab_t0"});
    for (k, v) in data.as_object().into_iter().flatten() {
        Filled::set(&mut out.data, "hero data", k, v.clone())?;
    }
    out.notes.push(RING_SHARE_WORDS.replace("{hub}", &hub_zh));
    Ok(())
}

/// The ring of the focus's months. Rows: the companion's for the focus. Facts: the focus's monthly peak and last within the
/// ring, which starts ring.months (the visual knob) back from the companion's last month.
fn ring_node_fill(f: &Filling, out: &mut Filled) -> Result<(), String> {
    let (shape, picks, fmt) = (f.shape, f.picks, f.fmt.as_str());
    let span = f.catalogue.knob("ring", "months")? as i64;
    let from = ring_from(&shape.months, span).ok_or_else(|| format!("monthly {} has no month", shape.companion))?;
    let origin = shape.place.as_str();
    out.rows(f.companion.iter().filter(|r| r["dims"][origin] == picks.focus.as_str()).cloned());
    let c = picks.focus.to_lowercase();
    let monthly = |op: &str| {
        json!({"op": op, "table": shape.companion, "filter": filter(&[(origin, picks.focus.as_str())]), "from": from, "fmt": fmt})
    };
    Filled::set(&mut out.facts, "fact", &format!("{c}_m_peak"), monthly("peak"))?;
    Filled::set(&mut out.facts, "fact", &format!("{c}_last"), monthly("last"))?;
    let ring = json!({"q": {"table": shape.companion, "filter": filter(&[(origin, picks.focus.as_str())]), "by": origin},
        "from": from, "marks": [{"key": format!("{c}_m_peak")}, {"key": format!("{c}_last")}]});
    Filled::set(&mut out.hero, "hero key", "ring", ring)
}

/// The facts the map declares for one origin (map_fill), by its keys: its values at t0 and t1, its change and its t1 share.
fn flow_keys(picks: &Picks, code: &str) -> [String; 4] {
    let (c, y0, y1) = (code.to_lowercase(), &picks.t0[2..], &picks.t1[2..]);
    [format!("{c}{y0}"), format!("{c}{y1}"), format!("{c}_ch"), format!("{c}{y1}_share")]
}

/// The short notes beside the map, one per top origin and one for the total: which facts each prints (the map's, so the
/// map fills first), never a sentence; the leaf writes the words from its word table. A note's change is there only when
/// the map declared one (a change from a value above 0), and the focus's note is marked.
fn notes_fill(f: &Filling, out: &mut Filled) -> Result<(), String> {
    let picks = f.picks;
    let mut notes = Vec::new();
    for code in &picks.top {
        let [a, b, ch, share] = flow_keys(picks, code);
        if ![&a, &b, &share].iter().all(|k| out.facts.contains_key(k.as_str())) {
            return Err(format!("notes: the map declares no facts for {code}"));
        }
        let ch = if out.facts.contains_key(&ch) { json!(ch) } else { Value::Null };
        notes.push(json!({"code": code, "a": a, "b": b, "ch": ch, "share": share, "f": *code == picks.focus}));
    }
    let (a, b) = (format!("tot{}", &picks.t0[2..]), format!("tot{}", &picks.t1[2..]));
    if ![&a, &b, &"tot_ch".to_string()].iter().all(|k| out.facts.contains_key(k.as_str())) {
        return Err("notes: the map declares no totals".into());
    }
    notes.push(json!({"hub": true, "a": a, "b": b, "ch": "tot_ch"}));
    Filled::set(&mut out.hero, "hero key", "notes", Value::Array(notes))
}

/// The strip under the hero: the focus's months in the companion, strip.months (the visual knob) back from its last month,
/// kept to the page's window when the recipe has one (from no earlier than its first month, to its last month or the
/// companion's last before it). Rows: the companion's for the focus. Facts: its peak (the top of its value axis) and its
/// last month in that span, the strip's two marks.
fn strip_fill(f: &Filling, out: &mut Filled) -> Result<(), String> {
    let (shape, picks, fmt) = (f.shape, f.picks, f.fmt.as_str());
    let span = f.catalogue.knob("strip", "months")? as i64;
    let none = || format!("monthly {} has no month in the page's window", shape.companion);
    let (months, to): (Vec<String>, Option<String>) = match &f.window {
        None => (shape.months.clone(), None),
        Some((a, b)) => {
            let kept: Vec<String> = shape.months.iter().filter(|t| *t <= b).cloned().collect();
            let last = kept.last().cloned().ok_or_else(none)?;
            (kept.into_iter().filter(|t| t >= a).collect(), Some(last))
        }
    };
    let from = ring_from(&months, span).ok_or_else(none)?;
    let origin = shape.place.as_str();
    out.rows(f.companion.iter().filter(|r| r["dims"][origin] == picks.focus.as_str()).cloned());
    let c = picks.focus.to_lowercase();
    let (peak, last) = (format!("{c}_s_peak"), format!("{c}_s_last"));
    for (key, op) in [(&peak, "peak"), (&last, "last")] {
        let mut q = json!({"op": op, "table": shape.companion, "filter": filter(&[(origin, picks.focus.as_str())]), "from": from, "fmt": fmt});
        if let Some(to) = &to {
            q["to"] = json!(to);
        }
        if op == "peak" {
            q["axis"] = json!(true);
        }
        Filled::set(&mut out.facts, "fact", key, q)?;
    }
    let mut strip = json!({"q": {"table": shape.companion, "filter": filter(&[(origin, picks.focus.as_str())]), "by": origin},
        "from": from, "axis": peak, "marks": [{"key": peak, "word": "scmp.strip.peak"}, {"key": last, "word": "scmp.strip.last"}]});
    if let Some(to) = to {
        strip["to"] = json!(to);
    }
    Filled::set(&mut out.hero, "hero key", "strip", strip)
}

/// The suffix a value prints with: its unit's short form, after a space when it holds a letter or a digit.
fn suffix(short: &str) -> String {
    if short.chars().any(char::is_alphanumeric) {
        format!(" {short}")
    } else {
        short.to_string()
    }
}

/// The most decimals a column page prints a value with, whatever its rows hold.
const COLUMN_DEC: usize = 2;

/// The main's rows at the shape's year for the ranked countries, and the most decimals they hold (at most COLUMN_DEC): every
/// value of a column page prints with that many.
fn ranked_rows<'a>(f: &Filling<'a>) -> (Vec<&'a Value>, usize) {
    let (place, year) = (f.shape.place.as_str(), f.shape.year.as_str());
    let kept: Vec<&Value> = f
        .main
        .iter()
        .filter(|r| r["time"] == year && r["dims"][place].as_str().is_some_and(|c| f.picks.ranked.iter().any(|k| k == c)))
        .collect();
    let dec = kept
        .iter()
        .filter_map(|r| r["value"].as_str())
        .map(|v| v.split_once('.').map_or(0, |(_, d)| d.len()))
        .max()
        .unwrap_or(0)
        .min(COLUMN_DEC);
    (kept, dec)
}

/// One bar per ranked country. Rows: the main's at the year for the ranked countries. Facts: each country's value (the
/// family `val`), printed with the most decimals the rows hold (at most COLUMN_DEC).
fn bars_fill(f: &Filling, out: &mut Filled) -> Result<(), String> {
    let (shape, picks, fmt) = (f.shape, f.picks, f.fmt.as_str());
    let (place, year) = (shape.place.as_str(), shape.year.as_str());
    let (kept, dec) = ranked_rows(f);
    out.rows(kept.into_iter().cloned());
    Filled::set(&mut out.facts, "fact", "val", json!({"each": place, "table": shape.main, "time": year, "fmt": fmt}))?;
    Filled::set(&mut out.fmts, "format", fmt, json!({"scale": 1, "dec": dec, "suffix": suffix(f.short)}))?;
    let data = json!({"chart": "bars", "by": place, "year": year, "family": "val", "ranked": picks.ranked, "marks": picks.marks});
    for (k, v) in data.as_object().into_iter().flatten() {
        Filled::set(&mut out.data, "hero data", k, v.clone())?;
    }
    Ok(())
}

/// The format of a gap between two percentages: percentage points, not a percentage.
const POINTS: (&str, &str) = ("pp", " 个百分点");

/// The big numbers: the highest and the lowest ranked country's value, their gap (in percentage points when the unit prints
/// as "%") and how many times the lowest the highest is; each with the decimals the bars print. Rows: the main's for the two
/// at the year.
fn bignums_fill(f: &Filling, out: &mut Filled) -> Result<(), String> {
    if f.picks.ranked.is_empty() && !f.picks.focus.is_empty() {
        return flow_bignums(f, out);
    }
    let (shape, picks, fmt) = (f.shape, f.picks, f.fmt.as_str());
    let (place, year) = (shape.place.as_str(), shape.year.as_str());
    let (Some(hi), Some(lo)) = (picks.ranked.first(), picks.ranked.last()) else {
        return Err(format!("main {} ranks no country", shape.main));
    };
    out.rows(f.main.iter().filter(|r| r["time"] == year && (r["dims"][place] == hi.as_str() || r["dims"][place] == lo.as_str())).cloned());
    let at = |code: &str| json!({"table": shape.main, "filter": {place: code}, "time": year, "fmt": fmt});
    let (_, dec) = ranked_rows(f);
    let gap_fmt = if f.short == "%" { POINTS.0 } else { fmt };
    for (key, q) in [
        ("hi", at(hi)),
        ("lo", at(lo)),
        ("gap", json!({"op": "minus", "a": "hi", "b": "lo", "fmt": gap_fmt})),
        ("times", json!({"op": "times", "a": "hi", "b": "lo", "fmt": "times"})),
    ] {
        Filled::set(&mut out.facts, "fact", key, q)?;
    }
    Filled::set(&mut out.fmts, "format", fmt, json!({"scale": 1, "dec": dec, "suffix": suffix(f.short)}))?;
    if gap_fmt == POINTS.0 {
        Filled::set(&mut out.fmts, "format", POINTS.0, json!({"scale": 1, "dec": dec, "suffix": POINTS.1}))?;
    }
    Filled::set(&mut out.fmts, "format", "times", json!({"scale": 1, "dec": 1, "suffix": "倍"}))?;
    for k in ["hi", "lo", "gap", "times"] {
        Filled::set(&mut out.data, "hero data", k, json!(k))?;
    }
    Ok(())
}

/// The big numbers of a flow page (a focus and its years, no ranking): the focus's change, the total's change, the change of the
/// top origin that grew most in volume (the focus aside) and the focus's peak month in the strip, each a fact the map or the
/// strip declared (so both fill first), as hero.data.bignums items; each label a word-table key, its fall or rise word by
/// the sign of the fact (the leaf's column.bignum_cells). A fact the page lacks is left out, never made up; none refuses.
fn flow_bignums(f: &Filling, out: &mut Filled) -> Result<(), String> {
    let (shape, picks) = (f.shape, f.picks);
    let at = |code: &str, t: &str| {
        f.main
            .iter()
            .find(|r| r["dims"][&shape.place] == code && r["dims"]["geo"] == shape.hub.as_str() && r["time"] == t)
            .and_then(row_value)
    };
    let grew = picks
        .top
        .iter()
        .filter(|c| **c != picks.focus && out.facts.contains_key(&flow_keys(picks, c)[2]))
        .filter_map(|c| Some((at(c, &picks.t1)? - at(c, &picks.t0)?, c)))
        .filter(|(d, _)| *d > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, c)| c);
    let ch = |code: &str| {
        let key = flow_keys(picks, code)[2].clone();
        json!({"fact": key, "label": {"word": "scmp.bn.ch", "name": code, "by_sign": key}})
    };
    let mut items = vec![ch(&picks.focus), json!({"fact": "tot_ch", "label": {"word": "scmp.bn.tot", "by_sign": "tot_ch"}})];
    items.extend(grew.map(|c| ch(c)));
    let peak = format!("{}_s_peak", picks.focus.to_lowercase());
    items.push(json!({"fact": peak, "label": {"word": "scmp.bn.peak", "name": picks.focus}}));
    let items: Vec<Value> = items.into_iter().filter(|i| i["fact"].as_str().is_some_and(|k| out.facts.contains_key(k))).collect();
    if items.is_empty() {
        return Err("bignums: the page declares none of its facts".into());
    }
    Filled::set(&mut out.data, "hero data", "bignums", Value::Array(items))
}

/// A page's request for the visual group's LeafFill by a recipe, as plain JSON {order, rows, knobs}: each of the recipe's
/// layers' node fills (NODE_FILLS) in its order, over the shape, the picks and the rows, then what every page has: the
/// unit's registered short form (a unit with none is refused) with the nodes' notes after it, the tables, the title and dek
/// from the text step, and the place names of the rows. Err is "not this shape: <why>".
fn fill_of(
    recipe: &Recipe,
    shape: &Shape,
    picks: &Picks,
    (main, companion): (&[Value], &[Value]),
    catalogue: &dyn Catalogue,
    (title, dek): (&str, &str),
) -> Result<Value, String> {
    let no = |why: String| format!("not this shape: {why}");
    let short = next_pack::unit_short(&shape.unit)
        .ok_or_else(|| no(format!("unit {} has no row in {}", shape.unit, next_pack::UNIT_SHORT_ZH_TABLE)))?;
    let window = window_of(recipe, picks).map_err(no)?;
    let filling = Filling { shape, picks, main, companion, catalogue, fmt: shape.unit.to_lowercase(), short, window };
    let mut out = Filled::default();
    for layer in &recipe.layers {
        if let Some((_, node)) = NODE_FILLS.iter().find(|(n, _)| n == layer) {
            node(&filling, &mut out).map_err(no)?;
        }
    }
    let Filled { rows, facts, mut fmts, data, mut hero, notes } = out;
    hero.insert("data".into(), Value::Object(data));
    hero.insert("unit".into(), json!(std::iter::once(format!("单位：{short}")).chain(notes).collect::<Vec<_>>().join("；")));
    fmts.insert("time".into(), json!({}));
    let mut tables = Map::new();
    for t in [&shape.main, &shape.companion].into_iter().filter(|t| !t.is_empty()) {
        tables.insert(t.clone(), json!({"id": t}));
    }
    let spec = json!({"title": title, "dek": dek, "tables": tables, "facts": facts, "fmts": fmts, "hero": hero});
    let labels = leaf_labels(&rows, &shape.members, catalogue)?;
    let mut knobs = json!({"spec": spec, "labels": labels});
    if !shape.hub.is_empty() {
        knobs["members"] = json!(shape.members);
    }
    Ok(json!({"order": recipe.layers, "rows": rows, "knobs": knobs}))
}

/// What a leaf page did: the stage it stopped at and why (the run stops there; no other route draws the page), or the page
/// it published, with its recipe.
pub const RING_EVENT: &str = "next_ring_page";
/// The `by` of a published leaf page's RING_EVENT: the flow group wrote it after publish_leaf_page; the completion gate
/// (next_gate::leaf_gate) takes the new route's checks only for an event that says so.
pub const RING_ACTOR: &str = "flow";

/// The Natural Earth admin-0 file a page's map draws its countries from, as the run materialized it (runtime.rs): a visual
/// knob default, as RING_HUBS. No number here prints.
const RING_SHAPES: &str = "runtime/assets/naturalearth-admin0-50m.geojson";

/// A page's request by a recipe for the first table (and its first kept companion, when the recipe's shape needs a monthly
/// one): the charts step must have drawn the table as one of the recipe's charts (`drawn`: the page's chart types; none
/// listed, the shape alone decides), then their fetched files read as series rows (knowledge group), the shape, picks and
/// fill (program rules); the page's words are the text step's title, dek and kicker (`words`), and its source line the
/// catalogue's publisher, id and title of the table, no year (a digit there would be one no ledger entry marks). Err is
/// (stage, why).
fn recipe_request(
    run_dir: &Path,
    prepared: &[Prepared],
    drawn: &[&str],
    recipe: &Recipe,
    catalogue: &dyn Catalogue,
    (title, dek, kicker): (&str, &str, &str),
) -> Result<Value, (&'static str, String)> {
    let shape_err = |why: String| ("shape", why);
    let main = prepared.first().ok_or_else(|| shape_err("not this shape: no table".into()))?;
    if !recipe.charts.is_empty() && !drawn.iter().any(|c| recipe.charts.iter().any(|k| k == c)) {
        return Err(shape_err(format!("not this shape: the charts step drew {drawn:?}, none of {:?}", recipe.charts)));
    }
    let companion = match recipe.eats.iter().any(|e| e == "monthly_companion") {
        true => Some(
            main.companions
                .first()
                .ok_or_else(|| shape_err(format!("not this shape: main {} kept no companion", main.id)))?,
        ),
        false => None,
    };
    let main_rows = fetched_rows(run_dir, catalogue, &main.id, &main.file).map_err(shape_err)?;
    let comp_rows = match companion {
        Some((id, file)) => fetched_rows(run_dir, catalogue, id, file).map_err(shape_err)?,
        None => Vec::new(),
    };
    let mut tables: Vec<(&str, &[Value])> = vec![(main.id.as_str(), &main_rows)];
    tables.extend(companion.map(|(id, _)| (id.as_str(), &comp_rows[..])));
    let shape = shape_of(&recipe.eats, &tables, catalogue).map_err(shape_err)?;
    let claims = picked_claims(run_dir, main, &claim_records(run_dir).map_err(shape_err)?).map_err(shape_err)?;
    let picks = picks_of(&recipe.picks, &shape, &main_rows, &claims).map_err(shape_err)?;
    let mut fill = fill_of(recipe, &shape, &picks, (&main_rows, &comp_rows), catalogue, (title, dek)).map_err(|why| ("fill", why))?;
    if recipe.layers.iter().any(|l| l == "map") {
        fill["knobs"]["shapes"] = json!(run_dir.join(RING_SHAPES));
    }
    let meta = catalogue.table(&main.id).ok_or_else(|| ("fill", format!("the catalogue lists no {}", main.id)))?;
    fill["knobs"]["spec"]["kicker"] = json!(kicker);
    fill["knobs"]["spec"]["source"] = json!(source_line(meta.worldbank, &meta.id, &main.title, &[]));
    Ok(fill)
}

/// A fetched table file read as series rows by the knowledge group.
fn fetched_rows(run_dir: &Path, catalogue: &dyn Catalogue, id: &str, file: &str) -> Result<Vec<Value>, String> {
    let meta = catalogue.table(id).ok_or_else(|| format!("the catalogue lists no dimensions for {id}"))?;
    let csv = std::fs::read_to_string(run_dir.join(file)).map_err(|e| format!("the fetched file {file}: {e}"))?;
    catalogue.series_rows(&meta, &csv)
}

/// The recipe a page stopped at when none of the registry's recipes reads its shape.
const NO_RECIPE: &str = "leaf";

/// The leaf page of the first table by the first recipe of the leaf registry that draws every view the question asks for
/// and whose shape it has (leaf_request), then the
/// visual group's LeafFill by that recipe, the page drawn and baked by the run's own copy of the second layer
/// (runtime/leaves_py, the children LeafFill names), written and checked in the browser (publish_leaf_page) under
/// publications/<recipe>/. The visual group's calls are kept in `calls`. Ok is the recipe and the publication; Err is
/// (recipe, stage, why), the stage one of LEAF_PLAN_STEPS after the text and the recipe the one that stopped (NO_RECIPE
/// when no recipe fits); nothing written before it is removed.
fn leaf_page(
    run_dir: &Path,
    prepared: &[Prepared],
    drawn: &[&str],
    catalogue: &dyn Catalogue,
    (question, words): (&str, (&str, &str, &str)),
    calls: &std::sync::Mutex<Vec<Value>>,
) -> Result<(&'static str, crate::next_flow::Published), (&'static str, &'static str, String)> {
    use crate::next_visual::{LeafPage, Reply, Request};
    let (recipe, fill) = leaf_request(run_dir, prepared, drawn, catalogue, (question, words), calls)?;
    let order: Vec<String> = fill["order"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect();
    let rows = fill["rows"].as_array().map_or(&[][..], Vec::as_slice);
    let runtime = run_dir.join("runtime");
    let request = Request::LeafFill { recipe, rows, knobs: &fill["knobs"], order: &order, runtime: &runtime };
    let Reply::Filled(page) = crate::next_flow::visual_call(calls, "leaf_fill", request).map_err(|why| (recipe, "fill", why))? else {
        unreachable!("the visual group answered leaf_fill with another reply")
    };
    let leaf = LeafPage {
        draw: &page.draw,
        bake: &page.bake,
        w: page.w,
        h: page.h,
        frame: page.frame.clone(),
        layers: &page.layers,
        ledger: &page.ledger,
        refs: &page.refs,
        facts: (&page.spec, &page.rows, &page.facts),
    };
    let plan = leaf_plan(question, recipe);
    let published = crate::next_flow::publish_leaf_page(calls, run_dir, recipe, (&leaf, &plan), &page.qa).map_err(|why| {
        // the call that refused names the stage; a refusal of the folder or of a write is the door's
        let refused = calls.lock().unwrap_or_else(|e| e.into_inner()).last().filter(|e| e["ok"] == false).cloned();
        let stage = match refused.as_ref().and_then(|e| e["request"].as_str()) {
            Some("leaf_page") => "draw",
            Some("browser_check") => "browser",
            _ => "door",
        };
        (recipe, stage, why)
    })?;
    Ok((recipe, published))
}

/// The first recipe of the leaf registry (the visual group's Recipes, in its order) that draws every view the question asks
/// for (GAP-2, unanswered_views) and whose shape the first table has, and the page's request by it (recipe_request). Err is
/// (recipe, stage, why): NO_RECIPE at the shape, every recipe's why given in registry order, when none fits; else the
/// recipe that stopped past its shape.
fn leaf_request(
    run_dir: &Path,
    prepared: &[Prepared],
    drawn: &[&str],
    catalogue: &dyn Catalogue,
    (question, words): (&str, (&str, &str, &str)),
    calls: &std::sync::Mutex<Vec<Value>>,
) -> Result<(&'static str, Value), (&'static str, &'static str, String)> {
    let mut missed = Vec::new();
    for recipe in catalogue.recipes() {
        match unanswered_views(calls, &recipe.name, question) {
            Ok(views) if views.is_empty() => {}
            Ok(views) => {
                let why = format!("not this view: the question asks for {}, which no layer of it draws", views.join(", "));
                missed.push((recipe.name.as_str(), why));
                continue;
            }
            Err(why) => return Err((recipe.name.as_str(), "shape", why)),
        }
        match recipe_request(run_dir, prepared, drawn, recipe, catalogue, words) {
            Ok(fill) => return Ok((recipe.name.as_str(), fill)),
            Err(("shape", why)) => missed.push((recipe.name.as_str(), why)),
            Err((stage, why)) => return Err((recipe.name.as_str(), stage, why)),
        }
    }
    let why = missed.iter().map(|(r, why)| format!("{r}: {why}")).collect::<Vec<_>>().join("; ");
    Err((NO_RECIPE, "shape", if why.is_empty() { "the leaf registry holds no recipe".into() } else { why }))
}

/// GAP-2 at the pick: each view the question asks for that no layer of the recipe draws, its groups expanded by the visual
/// group's RecipeLayers (next_gate::unanswered_modes, which the completion gate asks again of the published page). Err when
/// the registry has no such recipe or the visual group cannot answer.
fn unanswered_views(calls: &std::sync::Mutex<Vec<Value>>, recipe: &str, question: &str) -> Result<Vec<&'static str>, String> {
    use crate::next_visual::{Reply, Request};
    match crate::next_flow::visual_call(calls, "recipe_layers", Request::RecipeLayers { recipe })? {
        Reply::Layers(Some(layers)) => Ok(crate::next_gate::unanswered_modes(question, &layers)),
        Reply::Layers(None) => Err(format!("{recipe} is no recipe of the leaf registry")),
        _ => unreachable!("the visual group answered recipe_layers with another reply"),
    }
}

/// The design pack's template for one claim of a chart. A country code column names its code scheme, so the chart shows names,
/// not codes, and carries the program's Chinese name of each code, which the pack's text fills with.
fn template_of(chart: &Chart, id: &str, names: Option<BTreeMap<String, String>>) -> Value {
    let fields = match chart.view {
        View::FirstToLast => {
            json!({"category_field": chart.category, "start_field": MOVE_FROM, "end_field": chart.value})
        }
        View::Slice => json!({"category_field": chart.category, "value_field": chart.value}),
    };
    let mut template = json!({"claim_id": id, "chart_type": chart.relation.template(chart.view),
        "fields": fields});
    if let Some(scheme) = code_scheme(&chart.category) {
        template["category_names"] = json!(scheme);
    }
    if let Some(names) = names {
        template["names"] = json!(names);
    }
    template
}

/// The table's title and the one unit code it was fetched in (its `unit` filter), with that code's catalogue label and
/// measure kind; a World Bank indicator, which has no unit dimension, takes the unit the catalogue registers for it. Then the
/// time values its series draws, and what the chart lists along its category.
fn measure_of(
    table: &Prepared,
    catalogue: &dyn Catalogue,
    times: &[String],
    axis: Axis,
) -> next_pack::Measure {
    let meta = catalogue.table(&table.id);
    let (unit_code, unit_label, kind) = match meta.as_ref().and_then(|m| m.unit.as_ref()) {
        Some(unit) => (Some(unit.code.clone()), Some(unit.label.clone()), unit.kind),
        None => {
            let unit_code = unit_code(table);
            let unit_label = unit_code.as_ref().and_then(|code| {
                let (_, codes) = meta.as_ref()?.dims.iter().find(|(dim, _)| dim == "unit")?;
                codes
                    .iter()
                    .find(|(c, _)| c == code)
                    .map(|(_, label)| label.clone())
            });
            let kind = unit_code.as_deref().and_then(next_pack::measure_kind);
            (unit_code, unit_label, kind)
        }
    };
    let mut times = times.to_vec();
    times.sort();
    times.dedup();
    let name = measure_name(table, catalogue);
    let source = meta.map(|meta| source_line(meta.worldbank, &meta.id, &table.title, &times));
    next_pack::Measure {
        title: table.title.clone(),
        name,
        unit_code,
        unit_label,
        kind,
        times,
        axis,
        source,
    }
}

/// A chart's source line: the publisher the catalogue files the table under, its id (a World Bank indicator without its
/// "@2") and title as listed, and the years the chart draws, e.g. "欧盟统计局 sdg_07_40「Share of …」，2025 年".
fn source_line(worldbank: bool, id: &str, title: &str, times: &[String]) -> String {
    let publisher = publisher(worldbank);
    let id = id.split('@').next().unwrap_or(id);
    let mut line = format!("{publisher} {id}");
    if !title.trim().is_empty() {
        line.push_str(&format!("「{}」", title.trim()));
    }
    if let (Some(first), Some(last)) = (times.first(), times.last()) {
        let span = if first == last {
            first.clone()
        } else {
            format!("{first}–{last}")
        };
        let years = times
            .iter()
            .all(|t| t.len() == 4 && t.bytes().all(|b| b.is_ascii_digit()));
        line.push_str(&format!("，{span}{}", if years { " 年" } else { "" }));
    }
    line
}

/// The publisher a source line names for a table the catalogue files under it.
fn publisher(worldbank: bool) -> &'static str {
    if worldbank {
        "世界银行"
    } else {
        "欧盟统计局"
    }
}

/// The draft of the measure's name: when the fetch fixed one code of a breakdown the title names ("… by sector"), the
/// title without its "by …" and with those codes' catalogue labels, e.g. "Share of renewable energy in gross final energy
/// consumption (Renewable energy - overall)"; otherwise the title as listed.
fn measure_name(table: &Prepared, catalogue: &dyn Catalogue) -> String {
    let title = table.title.trim();
    let Some(cut) = title.rfind(" by ") else {
        return title.to_string();
    };
    let meta = catalogue.table(&table.id);
    let labels: Vec<String> = table
        .args
        .get("filters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|f| {
            !matches!(
                f["dimension"].as_str(),
                Some("geo" | "unit" | "freq" | "time") | None
            )
        })
        .filter_map(|f| {
            let dim = f["dimension"].as_str()?;
            let [code] = f["values"].as_array()?.as_slice() else {
                return None;
            };
            let code = code.as_str()?;
            let label = meta
                .as_ref()
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
    unit_code(table)
        .as_deref()
        .and_then(next_pack::measure_kind)
        .is_some_and(|k| matches!(k, "share" | "rate" | "index"))
}

/// The one unit code the table was fetched in (its `unit` filter); None when the fetch did not fix one unit.
fn unit_code(table: &Prepared) -> Option<String> {
    table
        .args
        .get("filters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
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
    let Ask::Text {
        fields,
        numbers,
        periods,
        ..
    } = &ask
    else {
        unreachable!("drafts ask for text")
    };
    let listed: Vec<String> = fields
        .iter()
        .map(|(n, text)| format!("{n}. {text}"))
        .collect();
    let slots: Vec<String> = drafts
        .slot_ids()
        .iter()
        .zip(&drafts.slots)
        .map(|(id, (_, title))| format!("{id}. {title}"))
        .collect();
    let named = if slots.is_empty() {
        String::new()
    } else {
        format!(
            "\nIn `names`, give each chart's measure, named here from its table title and the codes it was fetched in, a Chinese name of at most {} characters \
             with no number (it becomes the chart title); {}:\n{}",
            crate::next_flow::NAME_MAX_CHARS,
            crate::next_flow::NUMBER_WORD_RULE,
            slots.join("\n")
        )
    };
    let prompt = format!(
        "Question: {question}\nPage fields, drafted by the program:\n{}\nRewrite in Simplified Chinese the fields whose wording \
         should fit the question better; leave out the ones to keep. Keep every {{placeholder}} of a field exactly; {}; {}.{named}",
        listed.join("\n"),
        if numbers.is_empty() {
            crate::next_flow::TYPED_NUMBER_RULE.to_string()
        } else {
            format!("type no number other than these: {}", numbers.join(", "))
        },
        crate::next_flow::NUMBER_WORD_RULE
    );
    let choice = match recorder.ask_step(model, &ask, &prompt, cancel).await {
        Ok((_, choice)) => choice,
        Err(Stop::Refused {
            step: "text",
            problem,
        }) => {
            // Every refused answer of the step, newest first: each field and each name that passes every check alone is
            // kept from the newest answer that has it.
            let answers: Vec<Value> = recorder
                .step_answers()
                .iter()
                .map(|a| ask.decode(a).0)
                .collect();
            let fields_only = Ask::Text {
                fields: fields.clone(),
                slots: Vec::new(),
                numbers: numbers.clone(),
                periods: periods.clone(),
            };
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
                    let one = Ask::Text {
                        fields: BTreeMap::new(),
                        slots: vec![id.clone()],
                        numbers: numbers.clone(),
                        periods: periods.clone(),
                    };
                    let alone = json!({"step": "text", "text": {}, "names": {id.as_str(): name}});
                    if !given.contains_key(id)
                        && drafts.slot_ids().contains(id)
                        && one.check(&alone).is_ok()
                    {
                        given.insert(id.clone(), name.clone());
                    }
                }
            }
            let text = match fields_only.check(&json!({"step": "text", "text": kept, "names": {}}))
            {
                Ok(Choice::Text { text, .. }) => text,
                _ => BTreeMap::new(),
            };
            // A chart with no Chinese measure name has no title: stop here, not later in the pack under another name.
            let names = match ask.check(&json!({"step": "text", "text": {}, "names": given})) {
                Ok(Choice::Text { names, .. }) => names,
                _ => {
                    let missing: Vec<String> = drafts
                        .slot_ids()
                        .into_iter()
                        .filter(|id| !given.contains_key(id))
                        .collect();
                    return Err(stop(
                        "text",
                        format!(
                            "no Chinese measure name for {} (last refusal: {problem})",
                            missing.join(", ")
                        ),
                    ));
                }
            };
            let choice = Choice::Text { text, names };
            if !recorder.resume_under_last_accepted() {
                return Err(Stop::Refused {
                    step: "text",
                    problem,
                });
            }
            let Choice::Text { text, names } = &choice else {
                unreachable!("a text check gives a text choice")
            };
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
    let revised = drafts.revised(&choice).map_err(|e| stop("text", e))?;
    let (page, back) = drafts.scoped(revised);
    if !back.is_empty() {
        recorder.program_event(
            SCOPE_FALLBACK_EVENT,
            json!({"back_to_draft": back.iter().map(|t| format!("{t:?}")).collect::<Vec<_>>()}),
        )?;
    }
    Ok(page)
}

/// What the run decided, for the completion prompts (PAGE_STATE), and the run's plan of `steps` (LEAF_PLAN_STEPS) as of `step`
/// (`ok`: that step passed).
fn save_route_state(run_dir: &Path, steps: &[(&str, &str)], step: &str, ok: bool, state: &Value) -> Result<(), Stop> {
    let text = serde_json::to_string_pretty(state).map_err(|e| stop("state", e.to_string()))?;
    crate::group_guard::write(run_dir, &run_dir.join(PAGE_STATE), text)
        .map_err(|e| stop("state", format!("{PAGE_STATE}: {e}")))?;
    let plan = plan_record(state["question"].as_str().unwrap_or(""), steps, step, ok)?;
    let text = serde_json::to_string_pretty(&plan).map_err(|e| stop("state", e.to_string()))?;
    crate::group_guard::write(run_dir, &run_dir.join(PLAN_FILE), text)
        .map_err(|e| stop("state", format!("{PLAN_FILE}: {e}")))
}

/// The run's plan file, which the story lists and verification requires (artifact.rs `files.plan`).
pub const PLAN_FILE: &str = "plan.json";
/// The old route's fixed steps after the claims, in order, each with the stop step its failure is reported under; a leaf
/// page's plan (LEAF_PLAN_STEPS) takes its first two and its last.
pub const PLAN_STEPS: [(&str, &str); 7] = [
    (
        "claims",
        "pick the tables and the claims from the catalogue",
    ),
    ("text", "reword the drafted page fields"),
    ("sheet", "send the design pack its sheet"),
    ("pack", "send the design pack its judgement half"),
    (
        "second",
        "send the page over the sheet's charts and preview it",
    ),
    ("publish", "publish the page and check it in the browser"),
    (
        "publication_vision",
        "review the published page's browser screenshot",
    ),
];

/// A leaf page's steps after the claims and the text, in its own order (leaf_page's stages, whatever the recipe, then the image
/// review of what was published); its plan is recorded once it is published.
pub const LEAF_PLAN_STEPS: [(&str, &str); 8] = [
    PLAN_STEPS[0],
    PLAN_STEPS[1],
    ("shape", "read the tables into the first page recipe whose shape they have, and its picks"),
    ("fill", "fill the page recipe's request and compute its facts"),
    ("draw", "draw and bake the leaf page"),
    ("door", "write the leaf page through the visual group's door"),
    ("browser", "check the written leaf page in the browser"),
    PLAN_STEPS[6],
];

/// Where a published leaf page's own plan is (publications/plans/<recipe>.json): the publication plan verification reads
/// for a leaf page (verify.rs verify_publications), written with its manifest inside the visual group's door (publish_leaf_page).
pub fn leaf_plan_ref(recipe: &str) -> String {
    format!("publications/plans/{recipe}.json")
}

/// What the completion gate (next_gate::leaf_gaps) finds on the leaf page the flow just published, recorded by the flow
/// (by RING_ACTOR) for verification to read as data (verify.rs leaf_gate_event): {recipe, published, html_sha256, gaps}.
pub const LEAF_GATE_EVENT: &str = "next_leaf_gate";

/// The completion gate on the page just published, with the fetches the flow itself holds (its events are not on disk
/// yet): each prepared table's file and its companions', a file counted only under the content-addressed name its fetch
/// gives it (data/<sha256>.<ext>), so other bytes there are no fetch of it. A World Bank table (an id ending "@2", as
/// step_for reads it) is no fetch here, as the completion gate takes only Eurostat's (next_gate fetches): the gaps the flow
/// records are the ones that gate finds again. Called once PAGE_STATE names the question the gate reads.
fn leaf_gate_now(run_dir: &Path, recipe: &str, prepared: &[Prepared]) -> Vec<String> {
    let manifest = match read_json(run_dir, &format!("publications/{recipe}/manifest.json")) {
        Ok(manifest) => manifest,
        Err(why) => return vec![why],
    };
    let files = prepared.iter().flat_map(|p| {
        std::iter::once((p.id.as_str(), p.file.as_str()))
            .chain(p.companions.iter().map(|(id, file)| (id.as_str(), file.as_str())))
    });
    let fetched: Vec<crate::next_gate::Fetch> = files
        .filter(|(table, _)| !table.ends_with("@2"))
        .filter_map(|(table, file)| {
            let sha256 = crate::hash::sha256_bytes(&std::fs::read(run_dir.join(file)).ok()?);
            let named = Path::new(file).file_stem().and_then(|s| s.to_str()) == Some(sha256.as_str());
            named.then(|| crate::next_gate::Fetch { table: table.to_string(), file: file.to_string(), sha256 })
        })
        .collect();
    crate::next_gate::leaf_gaps(run_dir, recipe, &manifest, &fetched)
}

/// The leaf page's plan (leaf_plan_ref): the recipe, the question, LEAF_PLAN_STEPS and the one delivery width the browser
/// check measures (QA_SPEC, 1440). The visual group writes it with the page's manifest (publish_leaf_page), as
/// publications/plans/ is its folder.
fn leaf_plan(question: &str, recipe: &str) -> Value {
    let steps: Vec<Value> = LEAF_PLAN_STEPS.iter().map(|(id, action)| json!({"id": id, "action": action})).collect();
    json!({"kind": "leaf_plan", "recipe": recipe, "goal": question, "steps": steps, "delivery": {"breakpoints": [1440]}})
}

/// The first step of a route's plan that save_route_state records; the two before it (the claims and the text) are done by then.
const SENDS_FROM: usize = 2;

/// The plan in newsroom_update_plan's record shape (newsroom.ts): the steps before `step` completed, `step` completed or blocked
/// by its send, the rest pending. The revision counts the sends recorded, so a later one replaces an earlier one.
fn plan_record(question: &str, steps: &[(&str, &str)], step: &str, ok: bool) -> Result<Value, Stop> {
    let at = steps
        .iter()
        .position(|(id, _)| *id == step)
        .filter(|&at| at >= SENDS_FROM)
        .ok_or_else(|| stop("state", format!("{step} is not a send of the plan")))?;
    let steps: Vec<Value> = steps
        .iter()
        .enumerate()
        .map(|(i, (id, action))| {
            let status = match i.cmp(&at) {
                std::cmp::Ordering::Less => "completed",
                std::cmp::Ordering::Equal if ok => "completed",
                std::cmp::Ordering::Equal => "blocked",
                std::cmp::Ordering::Greater => "pending",
            };
            json!({"id": id, "action": action, "status": status})
        })
        .collect();
    let revision = at - SENDS_FROM + 1;
    Ok(json!({"schema_version": "0.7.0", "revision": revision,
        "updated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "goal": question,
        "revision_note": format!("{step}: {}", if ok { "passed" } else { "refused" }),
        "trigger": if revision == 1 { "initial_goal" } else if ok { "other" } else { "validation_failure" }, "steps": steps}))
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
    let prepared =
        prepare_claims(recorder, model, tools, question, steps, catalogue, cancel).await?;
    let page = charts(recorder, &prepared, catalogue)?;
    let titles: Vec<String> = page.measures.iter().map(|m| m.name.clone()).collect();
    // No typed number on the page text, years included: the design pack's claim-template check refuses every one, so the
    // text step offers none (a year goes through a placeholder or is left out).
    let drafts = next_page::draft(&page.claims, &page.charts, Vec::new())
        .name_measures(&titles, &page.charts)
        .with_scopes(&page.scopes)
        .with_periods(&page.times);
    let worded = reword(recorder, model, question, &drafts, cancel).await?;
    let worded_out: Map<String, Value> = worded
        .iter()
        .map(|(t, w)| (format!("{t:?}"), json!(w)))
        .collect();
    let verified: BTreeSet<&str> = page.claims.iter().map(|c| c.id.as_str()).collect();
    let title = next_pack::scoped_title(
        worded.get(&Target::PageTitle).map_or("", String::as_str),
        prepared.first().map_or(&[][..], |p| p.places_zh.as_slice()),
    );
    let dek = worded.get(&Target::PageDek).cloned().unwrap_or_default();
    // the kicker names the lead chart's measure, as the old route's does without a scope
    let kicker = worded.get(&Target::Measure(0)).map_or("", String::as_str);
    let calls = std::sync::Mutex::new(Vec::new());
    let drawn: Vec<&str> = page.templates.iter().filter_map(|t| t["chart_type"].as_str()).collect();
    let leaf = leaf_page(recorder.run_dir(), &prepared, &drawn, catalogue, (question, (&title, &dek, kicker)), &calls);
    record_group_calls(recorder, catalogue)?;
    for event in calls.into_inner().unwrap_or_else(|e| e.into_inner()) {
        recorder.program_event(crate::next_flow::GROUP_CALL_EVENT, event)?;
    }
    match leaf {
        Ok((recipe, published)) => {
            recorder.program_event(
                RING_EVENT,
                json!({"by": RING_ACTOR, "recipe": recipe, "published": published.html_ref,
                    "html_sha256": published.html_sha256}),
            )?;
            let state = json!({"question": question, "route": recipe, "claims": verified, "worded": worded_out,
                "published": published.html_ref, "html_sha256": published.html_sha256});
            save_route_state(recorder.run_dir(), &LEAF_PLAN_STEPS, "browser", true, &state)?;
            let gaps = leaf_gate_now(recorder.run_dir(), recipe, &prepared);
            recorder.program_event(
                LEAF_GATE_EVENT,
                json!({"by": RING_ACTOR, "recipe": recipe, "published": published.html_ref,
                    "html_sha256": published.html_sha256, "gaps": gaps}),
            )?;
            // a page the completion gate already holds back is not shown for review: the run stops on its gaps
            if !gaps.is_empty() {
                return Err(stop(
                    "gate",
                    format!("the completion gate found {} gap(s) on the {recipe} page: {}", gaps.len(), gaps.join(" | ")),
                ));
            }
            let score = leaf_vision(recorder, model, question, recipe, &state, cancel).await?;
            return Ok(format!(
                "The {recipe} page is published at {} (sha256 {}); the browser check passed those bytes and the published page \
                 passed the image review: score {score}/100.",
                published.html_ref, published.html_sha256
            ));
        }
        // no other route takes over: the run stops at the stage the leaf page stopped at, and what it wrote stays for the replay
        Err((recipe, stage, why)) => {
            recorder.program_event(
                RING_EVENT,
                json!({"recipe": recipe, "stage": stage, "stuck": format!("{recipe}-{stage}"), "why": why}),
            )?;
            let state = json!({"question": question, "route": recipe, "claims": verified, "worded": worded_out,
                "stuck": format!("{recipe}-{stage}")});
            save_route_state(recorder.run_dir(), &LEAF_PLAN_STEPS, stage, false, &state)?;
            Err(stop(stage, format!("the {recipe} leaf page stopped at {stage}: {why}")))
        }
    }
}

/// The published page's image review prompt.
fn publication_vision_prompt(question: &str) -> String {
    format!(
        "Question: {question}\nThe attached image is the browser screenshot of the published page, as a reader sees it. Judge only what is \
         visible: score the page and every rubric item 0-100, give your confidence 0-1, and list the visible defects (blocker only for \
         clipping, unreadable text, severe overlap or broken hierarchy). The page passes only with a score of at least 80, every rubric \
         item at least 60 and no blocker."
    )
}

/// The published leaf page's image review (the completion gate's GAP-3): the 1440 screenshot its PASS browser check wrote
/// (publications/qa/<recipe>/), read from disk, shown to the model; the verdict is recorded as a PUBLICATION_VISION_EVENT and
/// in the plan, and can only hold the page back. Ok is the score of a pass.
async fn leaf_vision(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    question: &str,
    recipe: &str,
    state: &Value,
    cancel: &AtomicBool,
) -> Result<u64, Stop> {
    let qa_ref = format!("publications/qa/{recipe}/browser-qa.json");
    let (shot_ref, shot_sha) = qa_screenshot(recorder.run_dir(), &json!(qa_ref)).map_err(|why| stop("publication_vision", why))?;
    let bytes = std::fs::read(recorder.run_dir().join(&shot_ref)).map_err(|e| stop("publication_vision", format!("{shot_ref}: {e}")))?;
    // the bytes shown are the bytes hashed: a file changed in between is refused, not reviewed
    if crate::hash::sha256_bytes(&bytes) != shot_sha {
        return Err(stop("publication_vision", format!("{shot_ref} changed while it was read")));
    }
    let shot = json!({"type": "image", "data": base64_text(&bytes), "mimeType": "image/png"});
    let ask = Ask::Vision { modules: Vec::new() };
    let Choice::Vision { score, confidence, rubric, issues } = recorder
        .ask_step_seeing(model, &ask, &publication_vision_prompt(question), std::slice::from_ref(&shot), cancel)
        .await?
        .1
    else {
        unreachable!("a vision check gives a vision choice")
    };
    let issues: Vec<Value> = issues.into_iter().map(|mut i| { i["viewport"] = json!("desktop"); i }).collect();
    let passed = vision_passes(score, &rubric, &issues);
    recorder.program_event(
        PUBLICATION_VISION_EVENT,
        json!({"publication_manifest_ref": format!("publications/{recipe}/manifest.json"), "qa_ref": qa_ref,
            "screenshot_ref": shot_ref, "image_sha256": shot_sha, "passed": passed,
            "score": score, "confidence": confidence, "rubric": rubric, "issues": issues}),
    )?;
    let mut state = state.clone();
    state["publication_vision"] = json!({"passed": passed, "score": score});
    save_route_state(recorder.run_dir(), &LEAF_PLAN_STEPS, "publication_vision", passed, &state)?;
    if !passed {
        let seen: Vec<String> = issues
            .iter()
            .map(|i| format!("{}:{}", i["severity"].as_str().unwrap_or("?"), i["code"].as_str().unwrap_or("?")))
            .collect();
        let seen = if seen.is_empty() { "none".to_string() } else { seen.join(" | ") };
        return Err(stop("publication_vision", format!("the published page did not pass the image review (score {score}; issues: {seen})")));
    }
    Ok(score)
}

/// The pass line of the published page's image review: a score of at least 80, every rubric item at least 60, no blocker.
fn vision_passes(score: u64, rubric: &BTreeMap<String, u64>, issues: &[Value]) -> bool {
    score >= 80
        && rubric.values().all(|v| *v >= 60)
        && !issues.iter().any(|i| i["severity"] == "blocker")
}

/// The desktop screenshot the publication QA record (browser-qa.json) names, as a run-relative ref, and the sha256 of its bytes
/// as read from the file now; Err names what is missing.
fn qa_screenshot(run_dir: &Path, qa_ref: &Value) -> Result<(String, String), String> {
    let qa_ref = qa_ref
        .as_str()
        .filter(|r| r.starts_with("publications/qa/") && r.ends_with("/browser-qa.json"))
        .ok_or("the publication names no QA record")?;
    let qa = read_json(run_dir, qa_ref)?;
    let name = qa["screenshots"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["width"] == 1440)
        .and_then(|s| s["path"].as_str())
        .filter(|p| !p.is_empty() && !p.contains('/') && !p.contains(".."))
        .ok_or_else(|| format!("{qa_ref} records no 1440-wide screenshot"))?;
    let shot_ref = format!("{}/{name}", qa_ref.trim_end_matches("/browser-qa.json"));
    let bytes = std::fs::read(run_dir.join(&shot_ref)).map_err(|e| format!("{shot_ref}: {e}"))?;
    Ok((shot_ref, crate::hash::sha256_bytes(&bytes)))
}

/// Standard, padded base64 text of `bytes`.
fn base64_text(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { DIGITS[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The published page's image review, as a program event under its model call.
pub const PUBLICATION_VISION_EVENT: &str = "next_publication_vision";
/// The claim the second chart takes: the first after the lead's that is no ranking, else the second.
fn second_claim(claims: &[Claim]) -> usize {
    (1..claims.len())
        .find(|&i| next_pack::dimension(&claims[i].kind) != Some("rank"))
        .unwrap_or(1)
}

/// A claim's recorded binding at one column of its own row.
fn binding<'a>(id: &str, record: &'a Value, column: &str) -> Result<&'a Value, String> {
    record["claim_bindings"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["column"] == column)
        .ok_or_else(|| format!("{id} has no recorded binding for {column}"))
}

/// A claim's number at one column of its own row, read from its recorded binding: src `<claim id>:<column>`.
fn claim_num(id: &str, record: &Value, column: &str) -> Result<Num, String> {
    let b = binding(id, record, column)?;
    match (b["value"].as_f64(), b["text"].as_str()) {
        (Some(value), Some(text)) => Ok(Num {
            src: format!("{id}:{column}"),
            value,
            text: text.to_string(),
        }),
        _ => Err(format!(
            "{id}: the binding for {column} is not a number with its text"
        )),
    }
}

/// A value as a claim's binding prints it (claim_candidates.mjs candidateValueText), so a row and a claim about it print
/// alike: a whole number as it is, one decimal from 1 up (toFixed(1)), else two significant digits without trailing zeros
/// (toPrecision(2)), in exponent form below a millionth as JS writes it. Both round the value's exact decimal expansion and
/// take the larger magnitude on a tie.
fn value_text(n: &serde_json::Number) -> String {
    let Some(v) = n.as_f64().filter(|_| n.is_f64()) else {
        return n.to_string();
    };
    if v.fract() == 0.0 {
        // + 0.0 prints a negative zero as 0, as JS does
        return (v + 0.0).to_string();
    }
    let sign = if v < 0.0 { "-" } else { "" };
    let a = v.abs();
    if a >= 1.0 {
        // an f64 at or above 1 that is not whole has at most 52 binary places, so 60 decimal places print it exactly
        let exact = format!("{a:.60}");
        let (whole, places) = exact.split_once('.').unwrap_or((&exact, "00"));
        let p = places.as_bytes();
        let tenths = whole.parse::<u64>().unwrap_or(0) * 10
            + u64::from(p[0] - b'0')
            + u64::from(p[1] >= b'5');
        return format!("{sign}{}.{}", tenths / 10, tenths % 10);
    }
    // 800 significant digits print any f64 exactly
    let exact = format!("{a:.800e}");
    let (digits, exp) = exact.split_once('e').unwrap_or((&exact, "0"));
    let d = digits.as_bytes();
    let mut two = u32::from(d[0] - b'0') * 10 + u32::from(d[2] - b'0') + u32::from(d[3] >= b'5');
    let mut exp: i32 = exp.parse().unwrap_or(0);
    if two == 100 {
        two = 10;
        exp += 1;
    }
    if exp < -6 {
        return format!("{sign}{}.{}e{exp}", two / 10, two % 10);
    }
    if exp >= 0 {
        return format!("{sign}1");
    }
    let text = format!("0.{}{two}", "0".repeat((-exp - 1) as usize));
    format!("{sign}{}", text.trim_end_matches('0'))
}

/// A number of a series row: src `series:<series id>:<row key>:<column>`, its text as value_text prints it.
fn row_num(series_id: &str, key: &str, row: &Value, column: &str) -> Result<Num, String> {
    match &row[column] {
        Value::Number(n) => Ok(Num {
            src: format!("series:{series_id}:{key}:{column}"),
            value: n.as_f64().unwrap_or(f64::NAN),
            text: value_text(n),
        }),
        _ => Err(format!("the series row {key} has no number at {column}")),
    }
}

/// A name from the data: plain words, or a ledger label read from its name row when it holds a digit (EU27).
fn name_seg(row: &str, text: &str) -> Seg {
    if text.chars().any(|c| c.is_ascii_digit()) {
        Seg::Label(Label {
            src: format!("{LABEL_SRC}{row}"),
            text: text.to_string(),
        })
    } else {
        Seg::Text(text.to_string())
    }
}

/// The unit after a value as a piece of the page: the code's short form (next_pack unit_short) as words, or as a name read
/// from its registry row when it holds a digit ("指数(2010=100)"); else the catalogue's unit label of `table` as a name
/// (a label when it holds a digit, "Per 100 000 inhabitants"). Err without a unit code or with neither, as the pack.
fn unit_seg(table: &str, code: Option<&str>, label: Option<&str>) -> Result<Seg, String> {
    let none = || format!("the measure has no unit text (unit code {code:?})");
    let code = code.ok_or_else(none)?;
    if let Some(short) = next_pack::unit_short(code) {
        let registry = next_pack::UNIT_SHORT_ZH_TABLE;
        return Ok(name_seg(&format!("{registry}:{code}"), short));
    }
    label
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| name_seg(&format!("catalogue:{table}:unit"), l))
        .ok_or_else(none)
}

/// The unit of a difference of two values: percentage points for a percentage, else the value's own unit.
fn diff_unit(unit: &Seg) -> Seg {
    match unit {
        Seg::Text(t) if t == "%" => Seg::Text("个百分点".into()),
        other => other.clone(),
    }
}

/// The claims a ranking page's text names, by the end of the ranking they stand for.
struct Ends<'a> {
    category: &'a str,
    scheme: &'a str,
    value: &'a str,
    unit: &'a Seg,
    names: &'a BTreeMap<String, String>,
    /// `first` (the text's own claim), `max` (rank_top) and `min` (rank_bottom), with their records.
    claims: Vec<(&'static str, &'a str, &'a Value)>,
}

impl Ends<'_> {
    /// A text's placeholders filled: `{<end>.<column>}` a number from that claim's binding (the value column followed by the
    /// unit), `{<end>.<category>}` or `{<end>.<value>.<category>}` the Chinese name of the claim's code.
    fn fill(&self, text: &str) -> Result<Vec<Seg>, String> {
        let mut out = Vec::new();
        let mut rest = text;
        let words = |out: &mut Vec<Seg>, text: &str| {
            if !text.is_empty() {
                out.push(Seg::Text(text.to_string()));
            }
        };
        while let Some(open) = rest.find('{') {
            words(&mut out, &rest[..open]);
            let close = rest[open..]
                .find('}')
                .map(|c| c + open)
                .ok_or("a { has no }")?;
            let name = &rest[open + 1..close];
            rest = &rest[close + 1..];
            let (end, path) = name
                .split_once('.')
                .ok_or_else(|| format!("{{{name}}} names no column"))?;
            let (_, id, record) = self
                .claims
                .iter()
                .find(|(e, _, _)| *e == end)
                .ok_or_else(|| format!("{{{name}}}: the page has no claim for {end}"))?;
            if path == self.category || path == format!("{}.{}", self.value, self.category) {
                let code = binding(id, record, self.category)?["text"]
                    .as_str()
                    .ok_or_else(|| {
                        format!("{id}: the binding for {} has no text", self.category)
                    })?;
                let zh = self
                    .names
                    .get(code)
                    .ok_or_else(|| format!("no Chinese name for {code}"))?;
                out.push(name_seg(&format!("zh_names:{}:{code}", self.scheme), zh));
            } else if !path.contains('.') {
                out.push(Seg::Num(claim_num(id, record, path)?));
                if path == self.value {
                    out.push(self.unit.clone());
                }
            } else {
                return Err(format!("{{{name}}} is not a placeholder of this chart"));
            }
        }
        words(&mut out, rest);
        Ok(out)
    }
}

/// The spec of a ranking page for the new renderer (next_render; drawn through the visual group's command) for chart `index`
/// of the page: its fields as reworded (`fields`: PageTitle, PageDek, Measure(i), Heading(i), Body(i), the rank_top claim's
/// HeroLabel); every row of the series its claims draw as a bar named in Chinese; the rank_top claim as the hero and the lead
/// bar; the extreme_gap and top_to_bottom_ratio claims on the bracket; the source line of `table_id` with the years the
/// series draws. Every number, years included, is read from a claim's binding or a series row, with where it was read; the
/// unit is unit_seg's. Not on run_page's path: until the user opens it, only a test on a
/// stored run draws with it.
#[allow(dead_code)] // to be wired: next_visual::call draws a page from it
pub fn ranking_page_spec(
    run_dir: &Path,
    page: &Page,
    index: usize,
    fields: &BTreeMap<Target, String>,
    table_id: &str,
    catalogue: &dyn Catalogue,
    accent: &str,
) -> Result<PageSpec, String> {
    let (chart, measure) = page
        .charts
        .get(index)
        .zip(page.measures.get(index))
        .ok_or_else(|| format!("the page has no chart {index}"))?;
    if chart.relation != Relation::Ranking {
        return Err(format!(
            "a ranking page draws a Ranking chart, not {:?}",
            chart.relation
        ));
    }
    let records = claim_records(run_dir)?;
    let record = |id: &str| {
        records
            .get(id)
            .ok_or_else(|| format!("{id} is not in claims.jsonl"))
    };
    let series_of = |record: &Value| record["computation_refs"][1].as_str().map(str::to_string);
    // The claims are the page's claims over the series the chart draws: the sheet may place a claim of this series
    // on another chart of the page (a map of the same rows), and its number still belongs on this one.
    let mut drawn = BTreeSet::new();
    for id in &chart.claim_ids {
        drawn.insert(series_of(record(id)?).ok_or_else(|| format!("{id} draws no series"))?);
    }
    let series_ref = match drawn.len() {
        1 => drawn.pop_first().unwrap_or_default(),
        n => return Err(format!("a ranking chart draws one series, not {n}")),
    };
    let mut mine = Vec::new();
    for claim in &page.claims {
        let record = record(&claim.id)?;
        if series_of(record).as_deref() == Some(series_ref.as_str()) {
            mine.push((claim, record));
        }
    }
    let kind = |kind: &str| {
        mine.iter()
            .find(|(c, _)| c.kind == kind)
            .map(|(c, r)| (c.id.as_str(), *r))
    };
    let (_, first) = mine.first().ok_or("the chart draws no claim")?;
    let series = computation(run_dir, first, 1)?;
    let series_id: String = first["computation_refs"][1]
        .as_str()
        .and_then(|r| r.rsplit('/').next())
        .unwrap_or("")
        .chars()
        .take(12)
        .collect();
    let rows = series["rows"].as_array().cloned().unwrap_or_default();
    let names = chart_names(chart, &rows, catalogue)?
        .ok_or_else(|| format!("{} is not a country code column", chart.category))?;
    let scheme = code_scheme(&chart.category).unwrap_or("");
    let key_of = |row: &Value| {
        row[&chart.category]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("a series row has no {}", chart.category))
    };
    // The ends' own numbers, by the row their claims name.
    let mut said = BTreeMap::new();
    for (id, record) in ["rank_top", "rank_bottom"].into_iter().filter_map(kind) {
        if let Some(code) = binding(id, record, &chart.category)?["text"].as_str() {
            said.insert(code.to_string(), claim_num(id, record, &chart.value)?);
        }
    }
    let mut bars = Vec::new();
    for row in &rows {
        let key = key_of(row)?;
        let zh = names
            .get(&key)
            .ok_or_else(|| format!("no Chinese name for {key}"))?;
        bars.push(BarRow {
            label: name_seg(&format!("zh_names:{scheme}:{key}"), zh),
            value: row_num(&series_id, &key, row, &chart.value)?,
            claim: said.remove(&key),
            key,
        });
    }
    let id = table_id.split('@').next().unwrap_or(table_id).to_string();
    let unit = unit_seg(
        &id,
        measure.unit_code.as_deref(),
        measure.unit_label.as_deref(),
    )?;
    let field = |target: Target| {
        fields
            .get(&target)
            .cloned()
            .ok_or_else(|| format!("the page has no {target:?} field"))
    };
    let (top_id, top) = kind("rank_top").ok_or("the ranking has no rank_top claim")?;
    let mut ends = Ends {
        category: &chart.category,
        scheme,
        value: &chart.value,
        unit: &unit,
        names: &names,
        claims: vec![("first", top_id, top), ("max", top_id, top)],
    };
    if let Some((id, record)) = kind("rank_bottom") {
        ends.claims.push(("min", id, record));
    }
    let hero_label = fields
        .iter()
        .find(|(t, _)| matches!(t, Target::HeroLabel { claim_id, .. } if claim_id == top_id))
        .map(|(_, text)| text.as_str())
        .ok_or_else(|| format!("the page has no hero label for {top_id}"))?;
    let hero = Hero {
        value: claim_num(top_id, top, &chart.value)?,
        unit: unit.clone(),
        label: ends.fill(hero_label)?,
    };
    let body = match fields.get(&Target::Body(index)) {
        Some(text) => vec![ends.fill(text)?],
        None => Vec::new(),
    };
    let mut bracket = Vec::new();
    if let Some((id, record)) = kind("extreme_gap") {
        bracket.push(vec![
            Seg::Text("相差".into()),
            Seg::Num(claim_num(id, record, "gap")?),
            diff_unit(&unit),
        ]);
    }
    if let Some((id, record)) = kind("top_to_bottom_ratio") {
        bracket.push(vec![
            Seg::Num(claim_num(id, record, "ratio")?),
            Seg::Text("倍".into()),
        ]);
    }
    let mut subtitle = vec![
        Seg::Num(claim_num(top_id, top, "year")?),
        Seg::Text("年，".into()),
    ];
    subtitle.extend(ends.fill(&field(Target::Heading(index))?)?);
    let meta = catalogue
        .table(table_id)
        .ok_or_else(|| format!("the catalogue does not list {table_id}"))?;
    let mut source = vec![
        Seg::Text(format!("数据来源：{} ", publisher(meta.worldbank))),
        Seg::Ref(id.clone()),
        Seg::Text("「".into()),
        name_seg(&format!("catalogue:{id}:title"), measure.title.trim()),
        Seg::Text("」，".into()),
    ];
    // The years the series draws, each from a row that holds it: the first and, when they differ, the last.
    let time = TIME_COLUMNS
        .iter()
        .find(|c| rows.first().is_some_and(|r| r[**c].is_number()))
        .ok_or("the series has no year column")?;
    let year_of = |row: &&Value| row[*time].as_i64().unwrap_or(i64::MIN);
    let (low, high) = rows
        .iter()
        .min_by_key(year_of)
        .zip(rows.iter().max_by_key(year_of))
        .ok_or("the series has no row")?;
    source.push(Seg::Num(row_num(&series_id, &key_of(low)?, low, time)?));
    if year_of(&low) != year_of(&high) {
        source.push(Seg::Text("–".into()));
        source.push(Seg::Num(row_num(&series_id, &key_of(high)?, high, time)?));
    }
    source.push(Seg::Text(" 年".into()));
    let measure_name = field(Target::Measure(index))?;
    // The scopes as the page places them: the lead chart's above the title, each chart's above its own card; and in the
    // source line, the chart's selection line after its source.
    let scope = |i: usize| {
        page.scopes
            .get(i)
            .and_then(Option::as_ref)
            .map(|s| scope_segs(run_dir, s))
            .transpose()
    };
    let kicker = scope(0)?.map_or_else(|| vec![Seg::Text(measure_name.clone())], |s| s.words);
    let mut refs = vec![id];
    let mut eyebrow = Vec::new();
    if let Some(ScopeSegs { words, line, by }) = scope(index)? {
        eyebrow = words;
        source.push(Seg::Text("；".into()));
        source.extend(line);
        refs.extend(by);
    }
    Ok(PageSpec {
        accent: accent.to_string(),
        kicker,
        title: field(Target::PageTitle)?,
        dek: field(Target::PageDek)?,
        hero: Some(hero),
        body,
        cards: vec![Card::Bar(BarCard {
            id: format!("rank-{index}"),
            eyebrow,
            title: measure_name,
            subtitle,
            rows: bars,
            lead: Some(
                binding(top_id, top, &chart.category)?["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            bracket,
            unit,
            source,
        })],
        refs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anthropic_model::ToolDef;
    use crate::next_flow::{
        number_not_allowed, placeholders, worded_number, ModelRoute, CHOOSE_TOOL,
    };

    /// verify.rs (knowledge group) reads the flow's leaf page events and plan as data, by these literals in
    /// leaf_gate_event and verify_publications, not by the agent group's names: they must not drift apart.
    #[test]
    fn verify_reads_the_leaf_page_names_the_flow_writes() {
        assert_eq!(RING_ACTOR, "flow");
        assert_eq!(RING_EVENT, "next_ring_page");
        assert_eq!(LEAF_GATE_EVENT, "next_leaf_gate");
        assert_eq!(leaf_plan_ref("x"), "publications/plans/x.json");
    }

    /// GAP-2 at the pick: a recipe none of whose layers (groups expanded) draws a view the question asks for is passed
    /// over before its shape is read; network is never drawn on the new route; an unknown recipe is an error, not a pass.
    #[test]
    fn the_pick_passes_over_a_recipe_without_the_asked_view() {
        let calls = std::sync::Mutex::new(Vec::new());
        assert_eq!(unanswered_views(&calls, "column", "在地图上看欧盟各国").unwrap(), ["map/spatial"]);
        assert!(unanswered_views(&calls, "scmp", "在地图上看欧盟各国").unwrap().is_empty());
        assert!(unanswered_views(&calls, "ring", "show it on a map").unwrap().is_empty());
        assert!(unanswered_views(&calls, "column", "欧盟各国可再生能源占比").unwrap().is_empty());
        assert_eq!(unanswered_views(&calls, "scmp", "draw it as a network graph").unwrap(), ["network"]);
        assert!(unanswered_views(&calls, "no_such", "show it on a map").unwrap_err().contains("no recipe"));
        assert_eq!(calls.lock().unwrap().len(), 6, "each ask goes through the visual group's door");
    }

    /// A recipe of the leaf registry by name, as the flow reads it (the visual group's Recipes).
    fn recipe(name: &str) -> &'static Recipe {
        Hubs.recipes().iter().find(|r| r.name == name).unwrap()
    }
    const RING_RECIPE: &str = "ring";
    fn ring_order() -> &'static [String] {
        &recipe(RING_RECIPE).layers
    }
    /// The ring recipe's shape, picks and fill, as leaf_page makes them.
    fn ring_shape(tables: &[(&str, &[Value])], catalogue: &dyn Catalogue) -> Result<Shape, String> {
        shape_of(&recipe(RING_RECIPE).eats, tables, catalogue)
    }
    fn ring_fill(
        shape: &Shape,
        picks: &RingPicks,
        tables: (&[Value], &[Value]),
        catalogue: &dyn Catalogue,
        words: (&str, &str),
    ) -> Result<Value, String> {
        let RingPicks { focus, t0, t1, top } = picks;
        let picks = Picks { focus: focus.clone(), t0: t0.clone(), t1: t1.clone(), top: top.clone(), ..Picks::default() };
        fill_of(recipe(RING_RECIPE), shape, &picks, tables, catalogue, words)
    }

    /// The flow's filled lists are frozen with the design pack's template list (shape_registry
    /// the_whole_chart_template_lists_stay_frozen): a new graphic is a node or a composition, never one more template.
    #[test]
    fn the_filled_template_lists_stay_frozen() {
        let frozen = "whole-chart templates are frozen: a new graphic adds a node or a composition of nodes, \
                      not a template";
        // Slices, so a longer list fails with the rule rather than a type error.
        assert_eq!(
            FILLED_TEMPLATES[..],
            ["horizontal_bar", "line", "choropleth"],
            "{frozen}"
        );
        assert_eq!(MOVE_TEMPLATES[..], ["dumbbell"], "{frozen}");
    }

    /// Replays scripted replies, one per request.
    struct ScriptedAsker(std::collections::VecDeque<Value>);

    #[async_trait::async_trait]
    impl Asker for ScriptedAsker {
        fn route(&self) -> ModelRoute {
            ModelRoute::Standin
        }
        async fn ask(
            &mut self,
            _history: &[Value],
            _tools: &[ToolDef],
            _cancel: &AtomicBool,
        ) -> Option<Value> {
            self.0.pop_front()
        }
    }

    #[test]
    fn the_second_chart_takes_the_first_claim_that_is_no_ranking() {
        let claims = |kinds: &[&str]| -> Vec<Claim> {
            kinds
                .iter()
                .enumerate()
                .map(|(i, k)| Claim {
                    id: format!("c{}", i + 1),
                    kind: k.to_string(),
                    template: String::new(),
                })
                .collect()
        };
        assert_eq!(
            second_claim(&claims(&["rank_top", "rank_bottom", "extreme_gap"])),
            2
        );
        assert_eq!(
            second_claim(&claims(&["rank_top", "rank_bottom"])),
            1,
            "all rankings: the second claim"
        );
        assert_eq!(second_claim(&claims(&["extreme_gap", "share_of_total"])), 1);
    }

    #[test]
    fn the_plan_marks_each_send_and_the_file_verification_requires_is_written() {
        // A refused publication: the steps before it done, it blocked, the review after it still pending.
        let plan = plan_record("q", &PLAN_STEPS, "publish", false).unwrap();
        let status: Vec<&str> = plan["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["status"].as_str().unwrap())
            .collect();
        assert_eq!(
            status,
            [
                "completed",
                "completed",
                "completed",
                "completed",
                "completed",
                "blocked",
                "pending"
            ]
        );
        assert_eq!(
            (plan["goal"].as_str(), plan["revision"].as_u64()),
            (Some("q"), Some(4))
        );
        assert_eq!(plan["trigger"], "validation_failure");
        // Every step is an object {id, action, status}, as newsroom_update_plan records it.
        assert!(plan["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["id"].is_string() && s["action"].is_string()));
        let first = plan_record("q", &PLAN_STEPS, "sheet", true).unwrap();
        assert_eq!(
            (first["revision"].as_u64(), first["trigger"].as_str()),
            (Some(1), Some("initial_goal"))
        );
        let last = plan_record("q", &PLAN_STEPS, "publication_vision", true).unwrap();
        assert!(last["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] == "completed"));
        // The claims and the text are no sends of their own, and an unknown step is refused.
        assert!(
            plan_record("q", &PLAN_STEPS, "text", true).is_err() && plan_record("q", &PLAN_STEPS, "rerun", true).is_err()
        );
        // save_route_state writes the page state and the plan through the checked writer, under the story's own name for it.
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("runtime")).unwrap();
        save_route_state(dir.path(), &LEAF_PLAN_STEPS, "shape", true, &json!({"question": "q"})).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(PLAN_FILE)).unwrap())
                .unwrap();
        assert_eq!(written["steps"][2]["status"], "completed");
        assert!(dir.path().join(PAGE_STATE).is_file());
        let story = crate::artifact::InvestigationBundle::create(dir.path(), "q").unwrap();
        assert_eq!(
            story.plan_path.file_name().and_then(|n| n.to_str()),
            Some(PLAN_FILE)
        );
    }

    /// The image review holds its line: 80 overall, 60 on every rubric item, no blocker; anything short holds the page back.
    #[test]
    fn the_image_reviews_pass_only_on_the_line() {
        let rubric = |low: u64| {
            BTreeMap::from([
                ("hierarchy".to_string(), 90),
                ("legibility".to_string(), low),
            ])
        };
        let warning = vec![json!({"severity": "warning", "code": "crowded"})];
        assert!(vision_passes(80, &rubric(60), &warning));
        assert!(!vision_passes(79, &rubric(90), &[]));
        assert!(!vision_passes(95, &rubric(59), &[]));
        assert!(!vision_passes(
            95,
            &rubric(90),
            &[json!({"severity": "blocker", "code": "clipped"})]
        ));
    }

    /// The screenshot under review is known by its bytes: base64 encodes them exactly, and the QA record's 1440 file is hashed as
    /// read.
    #[test]
    fn the_publication_screenshot_is_the_qa_files_bytes() {
        assert_eq!(base64_text(b"hello"), "aGVsbG8=");
        assert_eq!(base64_text(b"hi"), "aGk=");
        assert_eq!(base64_text(&[0, 1, 2]), "AAEC");
        assert_eq!(base64_text(&[0xfb, 0xff]), "+/8=");
        assert_eq!(base64_text(b""), "");
        let dir = tempfile::tempdir().unwrap();
        let qa = dir.path().join("publications/qa/k");
        std::fs::create_dir_all(&qa).unwrap();
        std::fs::write(qa.join("publication-1440.png"), b"png bytes").unwrap();
        let record = |path: &str| {
            json!({"screenshots": [{"width": 390, "path": "small.png"}, {"width": 1440, "path": path}]}).to_string()
        };
        std::fs::write(qa.join("browser-qa.json"), record("publication-1440.png")).unwrap();
        let qa_ref = json!("publications/qa/k/browser-qa.json");
        assert_eq!(
            qa_screenshot(dir.path(), &qa_ref),
            Ok((
                "publications/qa/k/publication-1440.png".to_string(),
                crate::hash::sha256_bytes(b"png bytes")
            ))
        );
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
            template:
                "{first.country_iso2} has the highest OBS VALUE in {first.year}: {first.value}."
                    .into(),
        }];
        let charts = vec![Chart {
            relation: Relation::Ranking,
            view: View::Slice,
            claim_ids: vec!["c1".into()],
            category: "country_iso2".into(),
            value: "value".into(),
        }];
        let numbers = vec!["2025".to_string()];
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
        recorder
            .ask_step(&mut model, &Ask::Search, "search words", &cancel)
            .await
            .unwrap();
        let page = reword(
            &mut recorder,
            &mut model,
            "欧盟各国可再生能源占比",
            &drafts,
            &cancel,
        )
        .await
        .unwrap();
        drop(recorder);
        assert_eq!(page[&Target::PageTitle], "欧盟各国可再生能源占比：谁领先");
        let heading = &drafts
            .fields
            .iter()
            .find(|(t, _)| *t == Target::Heading(0))
            .unwrap()
            .1;
        assert_eq!(&page[&Target::Heading(0)], heading);
        for (target, wording) in &page {
            let draft = &drafts.fields.iter().find(|(t, _)| t == target).unwrap().1;
            assert_eq!(placeholders(wording), placeholders(draft), "{target:?}");
            assert_eq!(
                number_not_allowed(wording, &drafts.numbers),
                None,
                "{target:?}: {wording}"
            );
            assert_eq!(worded_number(wording), None, "{target:?}: {wording}");
        }
        let events = events.lock().unwrap();
        let fallback: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == TEXT_FALLBACK_EVENT)
            .collect();
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0]["kept"], json!(["1"]));
        assert!(fallback[0]["back_to_draft"]
            .as_array()
            .unwrap()
            .contains(&json!("3")));
        assert_eq!(fallback[0]["auto_parent_call_id"], "s1");
    }

    /// The q1 page wording of the real batch of 10-27 (drafts and both answers as the model sent them). Answer 1 drops
    /// field 6's {first.year}; answer 2 is the same content with `text` and `names` sent as JSON strings.
    fn q1_drafts() -> Drafts {
        let fields = [
            "哪里最高",
            "各地在地图上的对比",
            "各地对比",
            "{min.value.country_iso2}最低，为{min.value}。",
            "由高到低",
            "{first.country_iso2} has the highest OBS VALUE in {first.year}.",
            "读图：颜色越深，数值越高，灰色是没有数据；各地是同一口径的数据。",
            "读者想知道这些数值在地理上怎样分布，哪里最高、哪里最低。",
            "放到地图上看，高值和低值聚在哪里清清楚楚。",
            "哪里最高？",
            "哪里最低？",
            "相邻地区之间是否相近？",
        ];
        Drafts {
            fields: fields
                .iter()
                .enumerate()
                .map(|(i, f)| (Target::Question(i), f.to_string()))
                .collect(),
            numbers: vec!["2025".into()],
            periods: Vec::new(),
            unplaced: Vec::new(),
            slots: vec![
                (Target::Measure(0), "Renewable energy share".into()),
                (Target::Measure(1), "Renewable energy share".into()),
            ],
            has_scope: false,
        }
    }

    const Q1_ANSWER_1: &str = r#"{"names": {"s1": "可再生能源占比", "s2": "可再生能源占比"}, "step": "text", "text": {"1": "哪个国家占比最高", "10": "哪个国家占比最高？", "11": "哪个国家占比最低？", "4": "{min.value.country_iso2}占比最低，为{min.value}%。", "6": "{first.country_iso2}的可再生能源占比在2025年最高。", "8": "读者想了解各欧盟成员国可再生能源占比的地理分布情况。"}}"#;
    const Q1_ANSWER_2: &str = r#"{"names": "{\"s1\": \"可再生能源占比\", \"s2\": \"可再生能源占比\"}", "step": "text", "text": "{\"1\": \"哪个国家占比最高\", \"4\": \"{min.value.country_iso2}占比最低，为{min.value}%。\", \"6\": \"{first.country_iso2}的可再生能源占比在{first.year}年最高。\", \"8\": \"读者想了解各欧盟成员国可再生能源占比的地理分布情况。\", \"10\": \"哪个国家占比最高？\", \"11\": \"哪个国家占比最低？\"}"}"#;

    /// Runs the q1 text step on `answers` after an accepted search; the page or the stop, and the events.
    async fn reword_q1(
        answers: Vec<Value>,
    ) -> (Result<BTreeMap<Target, String>, Stop>, Vec<Value>) {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut replies = vec![call(
            "s1",
            json!({"step": "search", "query": "renewable share"}),
        )];
        replies.extend(
            answers
                .into_iter()
                .enumerate()
                .map(|(i, a)| call(&format!("t{}", i + 1), a)),
        );
        let mut model = ScriptedAsker(replies.into());
        let events: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = Default::default();
        let into = events.clone();
        let mut sink = move |e: Value| into.lock().unwrap().push(e);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let cancel = AtomicBool::new(false);
        recorder
            .ask_step(&mut model, &Ask::Search, "search words", &cancel)
            .await
            .unwrap();
        let page = reword(
            &mut recorder,
            &mut model,
            "欧盟各国可再生能源占比",
            &q1_drafts(),
            &cancel,
        )
        .await;
        drop(recorder);
        let events = events.lock().unwrap().clone();
        (page, events)
    }

    /// The real q1 exchange: answer 2, its objects sent as strings, is decoded once and passes whole, and the event says so.
    #[tokio::test]
    async fn the_real_q1_rewording_passes_once_its_stringified_objects_are_decoded() {
        let answers = vec![
            serde_json::from_str(Q1_ANSWER_1).unwrap(),
            serde_json::from_str(Q1_ANSWER_2).unwrap(),
        ];
        let (page, events) = reword_q1(answers).await;
        let page = page.unwrap();
        assert_eq!(page[&Target::Measure(0)], "可再生能源占比");
        assert_eq!(page[&Target::Measure(1)], "可再生能源占比");
        assert_eq!(
            page[&Target::Question(5)],
            "{first.country_iso2}的可再生能源占比在{first.year}年最高。"
        );
        assert!(!events.iter().any(|e| e["type"] == TEXT_FALLBACK_EVENT));
        let ends: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == "tool_execution_end")
            .collect();
        assert_eq!(ends.last().unwrap()["decoded"], json!(["text", "names"]));
        assert!(ends[..ends.len() - 1]
            .iter()
            .all(|e| e.get("decoded").is_none()));
    }

    /// When the later answer holds nothing usable (here answer 2 encoded twice, which is not decoded), the fallback still
    /// keeps answer 1's names and the fields of answer 1 that pass alone; field 6, which dropped a placeholder, is drafted.
    #[tokio::test]
    async fn a_refused_rewording_keeps_names_and_fields_from_an_earlier_answer() {
        let twice = json!({"step": "text", "text": json!(Q1_ANSWER_2).to_string(), "names": json!("{}").to_string()});
        let (page, events) =
            reword_q1(vec![serde_json::from_str(Q1_ANSWER_1).unwrap(), twice]).await;
        let page = page.unwrap();
        assert_eq!(page[&Target::Measure(0)], "可再生能源占比");
        assert_eq!(page[&Target::Measure(1)], "可再生能源占比");
        assert_eq!(page[&Target::Question(5)], q1_drafts().fields[5].1);
        assert_eq!(page[&Target::Question(0)], "哪个国家占比最高");
        let fallback: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == TEXT_FALLBACK_EVENT)
            .collect();
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
            Err(Stop::Page { step: "text", why }) => {
                assert!(why.starts_with("no Chinese measure name for s1 "), "{why}")
            }
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
        for event in text
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        {
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
                let mut fetched = std::fs::read_dir(run.join("data"))
                    .ok()?
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string());
                let json = fetched.find(|n| n.ends_with(".json") && !n.ends_with(".meta.json"))?;
                worldbank.then(|| format!("data/{json}"))
            });
            if let Some(key) = details["sheet"].as_str() {
                sheet = key.to_string();
            }
            if event["type"] == "tool_execution_end" && file.is_some() {
                let worldbank = args.get("provider").and_then(Value::as_str) == Some("worldbank");
                let dataset = details["dataset"]
                    .as_str()
                    .or(args.get("dataset").and_then(Value::as_str))
                    .unwrap_or("");
                let prepared = Prepared {
                    id: if worldbank {
                        format!("{dataset}@2")
                    } else {
                        dataset.to_string()
                    },
                    title: String::new(),
                    file: file.unwrap_or_default(),
                    args: args.clone(),
                    sheet: sheet.clone(),
                    claims: details["claims"].as_array().cloned().unwrap_or_default(),
                    places_zh: Vec::new(),
                    companions: Vec::new(),
                };
                found = Some((
                    prepared,
                    details["mode"].as_str().unwrap_or("failed").to_string(),
                ));
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
        let catalogue =
            crate::next_flow::GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
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
            let shown = Path::new(source)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let Some((table, mode)) = last_prepare(run) else {
                println!("CHARTS {} | - | no prepare call named a file", shown);
                continue;
            };
            let records = claim_records(run).unwrap_or_default();
            let line = match table_chart(run, &records, &table, &catalogue, &[]) {
                Ok(made) => {
                    let lead = &made.charts[0].chart;
                    let more: String = made.charts[1..]
                        .iter()
                        .map(|d| {
                            format!(
                                " + {} {}/{} {:?}",
                                d.chart.relation.template(d.chart.view),
                                d.chart.category,
                                d.chart.value,
                                d.chart.claim_ids
                            )
                        })
                        .collect();
                    format!(
                        "chart {} {}/{} claims={}{more} dropped={:?}",
                        lead.relation.template(lead.view),
                        lead.category,
                        lead.value,
                        made.claims.len(),
                        made.dropped
                    )
                }
                Err(why) => format!("skip: {why}"),
            };
            println!("CHARTS {} | {} | prepare={mode} | {line}", shown, table.id);
            if !table.claims.is_empty() {
                // The chart events as the run would record them, for a byte comparison with the run's own events.jsonl.
                let mut sink = |e: Value| {
                    if [CHART_EVENT, CHART_SKIPPED_EVENT, CHART_GROUP_DROPPED_EVENT]
                        .contains(&e["type"].as_str().unwrap_or(""))
                    {
                        println!("EVENT {shown} {e}");
                    }
                };
                let mut recorder = Recorder::new(&mut sink, run, Vec::new(), Vec::new());
                let mut model = ScriptedAsker(
                    vec![call(
                        "s1",
                        json!({"step": "search", "query": "renewable share"}),
                    )]
                    .into(),
                );
                let cancel = AtomicBool::new(false);
                recorder
                    .ask_step(&mut model, &Ask::Search, "search words", &cancel)
                    .await
                    .unwrap();
                match charts(&mut recorder, std::slice::from_ref(&table), &catalogue) {
                    Ok(page) => println!(
                        "CHARTS {} | page | charts={} claims={}",
                        shown,
                        page.charts.len(),
                        page.claims.len()
                    ),
                    Err(stop) => println!("CHARTS {} | page | stop: {stop}", shown),
                }
            }
        }
    }

    #[test]
    fn the_question_is_the_goal_block_of_the_prompt() {
        let prompt = "You are the layer.\n\nInvestigation goal:\n欧盟各国可再生能源占比\n\nOperate as an evidence-first data journalist.";
        assert_eq!(
            question_of(prompt).as_deref(),
            Some("欧盟各国可再生能源占比")
        );
        assert_eq!(question_of("no goal line here"), None);
        assert_eq!(question_of("Investigation goal:\n\n\nrest"), None);
    }

    #[test]
    fn a_ranking_takes_its_one_entity_column_and_a_change_its_time() {
        let cols = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            fields(
                Relation::Ranking,
                View::Slice,
                &cols(&["country_iso2", "value", "year"])
            )
            .unwrap(),
            ("country_iso2".to_string(), "value".to_string())
        );
        assert_eq!(
            fields(Relation::Change, View::Slice, &cols(&["year", "value"])).unwrap(),
            ("year".to_string(), "value".to_string())
        );
        assert!(fields(
            Relation::Ranking,
            View::Slice,
            &cols(&["geo", "unit", "value"])
        )
        .is_err());
        assert!(fields(Relation::Ranking, View::Slice, &cols(&["geo", "obs"])).is_err());
        assert_eq!(
            fields(Relation::Map, View::Slice, &cols(&["geo", "value"])).unwrap(),
            ("geo".to_string(), "value".to_string())
        );
        assert!(fields(
            Relation::Distribution,
            View::Slice,
            &cols(&["geo", "value"])
        )
        .is_err());
    }

    /// The knowledge group's own name table and nothing else.
    struct NamesOnly;
    impl Catalogue for NamesOnly {
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

    #[test]
    fn leaf_labels_name_every_place_the_rows_and_members_hold_and_leave_totals_out() {
        let series = |dims: Value| json!({"src": "series:t/x:2024:OBS_VALUE", "table": "t", "dims": dims, "time": "2024", "value": "1"});
        let rows = [
            series(json!({"partner": "CG", "geo": "EU27_2020", "siec": "G3000", "unit": "MIO_M3"})),
            series(json!({"partner": "TOTAL", "geo": "EL"})),
            series(json!({"partner": "NSP", "geo": "UK"})),
            series(json!({"partner": "AFR_OTH", "country": "DEU"})),
            // not series rows: their dimensions are not codes the leaves print by name
            json!({"src": "record:events.csv/0", "table": "events.csv", "dims": {"place": "MX"}, "time": "", "value": ""}),
        ];
        let labels = leaf_labels(&rows, &["FR".into(), "DE".into()], &NamesOnly).unwrap();
        // the hub EU27_2020 is named (an alias of the EU's World Bank code); TOTAL, NSP and AFR_OTH are not
        assert_eq!(labels.keys().map(String::as_str).collect::<Vec<_>>(), ["CG", "DE", "DEU", "EL", "EU27_2020", "FR", "UK"]);
        assert_eq!(labels["EU27_2020"], "欧盟");
        assert!(labels.values().all(|n| !n.is_empty() && !n.is_ascii()));
        assert!(leaf_labels(&[], &[], &NamesOnly).unwrap().is_empty());
    }

    /// Prints the labels layer 1 gives one stored leaf request (LEAF_REQ=<json with rows and knobs.members>; run with
    /// --ignored), for the gate that draws a dev question's real request with them.
    #[test]
    #[ignore]
    fn leaf_labels_for_a_stored_request() {
        let req: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("LEAF_REQ").unwrap()).unwrap()).unwrap();
        let rows = req["rows"].as_array().unwrap();
        let members: Vec<String> = req["knobs"]["members"]
            .as_array()
            .map(|m| m.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        println!("labels {}", serde_json::to_string(&leaf_labels(rows, &members, &NamesOnly).unwrap()).unwrap());
    }

    /// Two-letter codes are countries (EU aside); EU27_2020 and EA20 have members, only EU27_2020 a hub row.
    struct Hubs;
    impl Catalogue for Hubs {
        fn top5(&self, _: &str, _: &[String]) -> crate::l5geo::Ranking {
            unreachable!()
        }
        fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
            unreachable!()
        }
        fn source(&self) -> &Value {
            &Value::Null
        }
        fn countries(&self, codes: &[String]) -> Result<Vec<String>, String> {
            Ok(codes.iter().filter(|c| c.len() == 2 && c.as_str() != "EU").cloned().collect())
        }
        fn zh_names(&self, _: &str, codes: &[String]) -> Result<BTreeMap<String, String>, Vec<String>> {
            Ok(codes.iter().map(|c| (c.clone(), format!("名{c}"))).collect())
        }
        fn members(&self, aggregate: &str) -> Result<Vec<String>, String> {
            match aggregate {
                "EU27_2020" | "EA20" => Ok(vec!["DE".into(), "FR".into()]),
                _ => Err(format!("the member list has no aggregate {aggregate}")),
            }
        }
    }

    /// Series rows of `table` over every (code of `by`, time), the other dimensions as given.
    fn ring_rows(table: &str, fixed: &[(&str, &str)], by: (&str, &[&str]), times: &[&str]) -> Vec<Value> {
        let mut out = Vec::new();
        for code in by.1 {
            for t in times {
                let mut dims: Map<String, Value> = fixed.iter().map(|(d, c)| (d.to_string(), json!(c))).collect();
                dims.insert(by.0.into(), json!(code));
                out.push(json!({"src": format!("series:{table}/{code}:{t}:OBS_VALUE"), "table": table, "dims": dims, "time": t, "value": "1"}));
            }
        }
        out
    }

    #[test]
    fn the_ring_shape_is_read_from_the_tables_dims_and_rows_and_each_gap_is_refused_by_name() {
        let gas = [("siec", "G3000"), ("unit", "MIO_M3"), ("geo", "EU27_2020")];
        let partners: &[&str] = &["RU", "NO", "US", "DE", "TOTAL", "AFR_OTH"];
        let main = ring_rows("imp", &gas, ("partner", partners), &["2021", "2024"]);
        let monthly = ring_rows("impm", &gas, ("partner", &["RU", "NO"]), &["2024-01", "2024-02"]);
        let shape = ring_shape(&[("imp", &main), ("impm", &monthly)], &Hubs).unwrap();
        println!("ring shape {shape:?}");
        assert_eq!((shape.place.as_str(), shape.hub.as_str(), shape.unit.as_str()), ("partner", "EU27_2020", "MIO_M3"));
        assert_eq!((shape.main.as_str(), shape.companion.as_str()), ("imp", "impm"));
        assert_eq!(shape.outside, ["NO", "RU", "US"]);
        assert_eq!((shape.years.len(), shape.months.len(), shape.point, shape.extent[0]), (2, 2, [10.0, 50.0], -12.6));
        // q6's shape: the origins in citizen, the same hub; no table id or topic is read
        let asylum = [("sex", "T"), ("unit", "PER"), ("geo", "EU27_2020")];
        let main_q6 = ring_rows("asy", &asylum, ("citizen", partners), &["2024", "2025"]);
        let monthly_q6 = ring_rows("asym", &asylum, ("citizen", &["RU", "NO"]), &["2025-01"]);
        let q6 = ring_shape(&[("asy", &main_q6), ("asym", &monthly_q6)], &Hubs).unwrap();
        assert_eq!((q6.place.as_str(), q6.hub.as_str(), q6.companion.as_str()), ("citizen", "EU27_2020", "asym"));

        let one_year = ring_rows("a", &gas, ("partner", partners), &["2025"]);
        let tj = ring_rows("impm", &[("unit", "TJ_GCV"), ("geo", "EU27_2020")], ("partner", &["RU"]), &["2024-01"]);
        let all_geo = ring_rows("imp", &[("unit", "MIO_M3"), ("partner", "RU")], ("geo", &["DE", "FR", "EU27_2020"]), &["2021", "2024"]);
        let two = [main.clone(), all_geo.iter().map(|r| {
            let mut r = r.clone();
            r["dims"]["partner"] = json!("NO");
            r
        }).collect()].concat();
        let ea = ring_rows("imp", &[("unit", "MIO_M3"), ("geo", "EA20")], ("partner", partners), &["2021", "2024"]);
        let siec = |rows: &[Value], code: &str| -> Vec<Value> {
            rows.iter().map(|r| {
                let mut r = r.clone();
                r["dims"]["siec"] = json!(code);
                r
            }).collect()
        };
        let mixed = [main.clone(), siec(&main, "G3200")].concat();
        let lng = siec(&monthly, "G3200");
        let monthly_mixed = [monthly.clone(), lng.clone()].concat();
        let balance = ring_rows("impm", &[gas[0], gas[1], gas[2], ("nrg_bal", "IMP")], ("partner", &["RU", "NO"]), &["2024-01"]);
        for (tables, says) in [
            (vec![("imp", &main[..]), ("impm", &balance[..])], "not this shape: monthly impm nrg_bal not in main"),
            (vec![("a", &one_year[..]), ("impm", &monthly[..])], "not this shape: main spans one year (2025)"),
            (vec![("imp", &main[..])], "not this shape: no monthly companion"),
            (vec![("imp", &main[..]), ("impm", &tj[..])], "not this shape: unit differs: main MIO_M3, monthly impm TJ_GCV"),
            (vec![("imp", &two[..]), ("impm", &monthly[..])], "not this shape: no single country origin dim: partner, geo"),
            (vec![("imp", &ea[..]), ("impm", &monthly[..])], "not this shape: no hub row for EA20"),
            (vec![("imp", &mixed[..]), ("impm", &monthly[..])], "not this shape: main siec varies"),
            (vec![("imp", &main[..]), ("impm", &lng[..])], "not this shape: monthly impm siec is G3200, main G3000"),
            (vec![("imp", &main[..]), ("impm", &monthly_mixed[..])], "not this shape: monthly impm siec varies"),
        ] {
            assert_eq!(ring_shape(&tables, &Hubs).unwrap_err(), says);
        }
    }

    /// The series rows of an SDMX-CSV file read as table `id` (the dims between LAST UPDATE and TIME_PERIOD), the rows whose
    /// dims `keep` takes, an empty OBS_VALUE left out.
    fn sdmx_rows(id: &str, text: &str, keep: impl Fn(&Map<String, Value>) -> bool) -> Vec<Value> {
        let mut lines = text.lines();
        let header: Vec<&str> = lines.next().unwrap().split(',').collect();
        let at = |n: &str| header.iter().position(|h| *h == n).unwrap();
        let (first, time, value) = (at("LAST UPDATE") + 1, at("TIME_PERIOD"), at("OBS_VALUE"));
        lines.filter_map(|l| {
            // the LAST UPDATE cell holds no comma in these files
            let f: Vec<&str> = l.split(',').collect();
            let dims: Map<String, Value> = (first..time).map(|i| (header[i].to_string(), json!(f[i]))).collect();
            let key = (first..time).map(|i| f[i]).collect::<Vec<_>>().join(".");
            (!f[value].is_empty() && keep(&dims)).then(|| json!({"src": format!("series:{id}/{key}:{}:OBS_VALUE", f[time]), "table": id,
                "dims": dims, "time": f[time], "value": f[value]}))
        }).collect()
    }

    /// A claims.jsonl record binding each (column, value) at row 0.
    fn bound(id: &str, columns: &[(&str, Value)]) -> Value {
        let bindings: Vec<Value> = columns
            .iter()
            .map(|(c, v)| json!({"placeholder": format!("{{first.{c}}}"), "column": c, "row_index": 0, "value": v}))
            .collect();
        json!({"claim_id": id, "claim_bindings": bindings})
    }

    #[test]
    fn the_ring_focus_and_years_are_the_picked_member_change_claims_and_each_gap_is_refused_by_name() {
        let gas = [("siec", "G3000"), ("unit", "MIO_M3"), ("geo", "EU27_2020")];
        let mut main = ring_rows("imp", &gas, ("partner", &["RU", "NO", "US", "TOTAL"]), &["2021", "2022", "2024"]);
        for r in main.iter_mut().filter(|r| r["dims"]["partner"] == "RU") {
            r["value"] = json!(if r["time"] == "2021" { "126027.316" } else { "37843.285" });
        }
        let monthly = ring_rows("impm", &gas, ("partner", &["RU", "NO"]), &["2024-01"]);
        let shape = ring_shape(&[("imp", &main), ("impm", &monthly)], &Hubs).unwrap();
        let change = |code: &str, from: Value, from_year: i64| {
            vec![("members", json!(5)), ("to_year", json!(2024)), ("country_iso2", json!(code)), ("from_value", from),
                ("from_year", json!(from_year)), ("to_value", json!(37843.285))]
        };
        let c4 = bound("c4", &change("RU", json!(126027.316), 2021));
        let c1 = bound("c1", &[("value", json!(90))]);
        let c5 = bound("c5", &[("from_value", json!(1)), ("from_year", json!(2022)), ("to_value", json!(1)), ("to_year", json!(2024))]);
        let picks = |p: &[(&str, &Value)]| -> Vec<(String, Value)> { p.iter().map(|(k, r)| (k.to_string(), (*r).clone())).collect() };
        let got = ring_picks(&shape, &main, &picks(&[("rank_top", &c1), (MEMBER_CHANGE, &c4), ("cut_total_change", &c5)])).unwrap();
        // NO and US hold the same values: code order
        let top = vec!["RU".to_string(), "NO".into(), "US".into()];
        assert_eq!(got, RingPicks { focus: "RU".into(), t0: "2021".into(), t1: "2024".into(), top });

        let no_country = bound("c4", &change("RU", json!(126027.316), 2021)[..2]);
        let off = bound("c4", &change("RU", json!(126027.3), 2021));
        let jp = bound("c4", &change("JP", json!(126027.316), 2021));
        let early = bound("c4", &change("RU", json!(126027.316), 2019));
        let flat = bound("c4", &[("country_iso2", json!("RU")), ("from_year", json!(2024)), ("to_year", json!(2024))]);
        for (claims, says) in [
            (picks(&[("change_largest_rise", &c4)]), "not this shape: no member change claim picked"),
            (picks(&[("rank_top", &c1), ("cut_total_change", &c5)]), "not this shape: no member change claim picked"),
            (picks(&[(MEMBER_CHANGE, &c4), (MEMBER_CHANGE, &c4)]), "not this shape: 2 member change claims picked"),
            (picks(&[(MEMBER_CHANGE, &no_country)]), "not this shape: claim c4 names no single country"),
            (picks(&[(MEMBER_CHANGE, &off)]), "not this shape: claim c4 and main rows disagree for RU at 2021"),
            (picks(&[(MEMBER_CHANGE, &jp)]), "not this shape: focus JP is not a top-N origin of main imp"),
            (picks(&[(MEMBER_CHANGE, &early)]), "not this shape: claim year 2019 not in main imp"),
            (picks(&[(MEMBER_CHANGE, &flat)]), "not this shape: t0 2024 is not before t1 2024"),
        ] {
            assert_eq!(ring_picks(&shape, &main, &claims).unwrap_err(), says);
        }

        // RING_TOP origins above RU at both years push it off the map
        let big = ["AZ", "DZ", "LY", "NG", "QA", "TR", "UA", "UK", "ZA"];
        assert_eq!(big.len(), RING_TOP);
        let mut crowded = main.clone();
        crowded.extend(ring_rows("imp", &gas, ("partner", &big), &["2021", "2022", "2024"]).into_iter().map(|mut r| {
            r["value"] = json!("200000");
            r
        }));
        let shape = ring_shape(&[("imp", &crowded), ("impm", &monthly)], &Hubs).unwrap();
        assert_eq!(
            ring_picks(&shape, &crowded, &picks(&[(MEMBER_CHANGE, &c4)])).unwrap_err(),
            "not this shape: focus RU is not a top-N origin of main imp"
        );
    }

    /// The ring page's fill on Hubs rows: its rows (no total or aggregate row), facts, unit format, share words, top list
    /// and window; the visual group's LeafFill computes it into one ring layer per name; a unit with no short form refuses.
    #[test]
    fn the_ring_fill_is_program_rules_over_the_shape_and_picks_and_the_visual_group_computes_it() {
        let rows = |unit: &str| {
            let fixed = [("siec", "G3000"), ("unit", unit), ("geo", "EU27_2020")];
            let partners: &[&str] = &["RU", "NO", "US", "DE", "TOTAL", "EXT_EU27_2020"];
            let mut main = ring_rows("imp", &fixed, ("partner", partners), &["2021", "2022", "2024"]);
            for r in main.iter_mut().filter(|r| r["dims"]["partner"] == "RU") {
                r["value"] = json!(if r["time"] == "2021" { "126027.316" } else { "37843.285" });
            }
            // a new source: nothing at t0
            for r in main.iter_mut().filter(|r| r["dims"]["partner"] == "US" && r["time"] == "2021") {
                r["value"] = json!("0");
            }
            let months: Vec<String> = (2019..=2024).flat_map(|y| (1..=12).map(move |m| format!("{y}-{m:02}"))).take(63).collect();
            let months: Vec<&str> = months.iter().map(String::as_str).collect();
            let monthly = ring_rows("impm", &fixed, ("partner", &["RU", "NO"]), &months);
            let shape = ring_shape(&[("imp", &main), ("impm", &monthly)], &Hubs).unwrap();
            let change = [("members", json!(5)), ("from_year", json!(2021)), ("to_year", json!(2024)),
                ("country_iso2", json!("RU")), ("from_value", json!(126027.316)), ("to_value", json!(37843.285))];
            let picks = ring_picks(&shape, &main, &[(MEMBER_CHANGE.to_string(), bound("c4", &change))]).unwrap();
            (main, monthly, shape, picks)
        };
        let (main, monthly, shape, picks) = rows("MIO_M3");
        let fill = ring_fill(&shape, &picks, (&main, &monthly), &Hubs, ("标题", "导语")).unwrap();
        // the fill byte for byte as the ring filled it before the recipe registry (10-29): a move onto the registry changes none
        assert_eq!(crate::hash::sha256_bytes(fill.to_string().as_bytes()), "d728a43088b98205718a7814a2ce0ef3572d9485fc8961926831fa471dafb5e8");
        assert_eq!(fill["order"], json!(ring_order()));
        let kept = fill["rows"].as_array().unwrap();
        // RU NO US DE at three years, and RU's 63 months
        assert_eq!(kept.len(), 4 * 3 + 63);
        assert!(kept.iter().all(|r| !["TOTAL", "EXT_EU27_2020"].contains(&r["dims"]["partner"].as_str().unwrap())));
        assert!(kept.iter().filter(|r| r["table"] == "impm").all(|r| r["dims"]["partner"] == "RU"));
        let spec = &fill["knobs"]["spec"];
        let mut keys: Vec<String> = spec["facts"].as_object().unwrap().keys().cloned().collect();
        let mut want: Vec<String> = ["tot21", "tot24", "tot_ch", "ru_m_peak", "ru_last", "lab_t0", "lab_t1"].map(String::from).to_vec();
        for c in ["ru", "no", "us"] {
            want.extend([format!("{c}21"), format!("{c}24"), format!("{c}24_share")]);
        }
        // US had nothing at t0, so no change of its
        want.extend(["ru_ch".to_string(), "no_ch".into()]);
        keys.sort();
        want.sort();
        assert_eq!(keys, want);
        assert_eq!(spec["facts"]["tot24"]["filter"], json!({"geo": "EU27_2020"}));
        assert_eq!(spec["fmts"]["mio_m3"], json!({"scale": 1, "dec": 0, "suffix": " 百万立方米"}));
        assert_eq!(spec["hero"]["unit"], "单位：百万立方米；占比为名EU27_2020以外各国合计中的占比");
        assert_eq!(spec["hero"]["data"]["top"], json!(["RU", "NO", "US"]));
        // 60 months ending 2024-03; fewer months start at the first
        assert_eq!(spec["hero"]["ring"]["from"], "2019-04");
        assert_eq!(ring_from(&["2023-01".into(), "2024-03".into()], 60).as_deref(), Some("2023-01"));
        assert_eq!(ring_from(&["2023-01".into(), "2024-03".into()], 12).as_deref(), Some("2023-04"));
        assert_eq!(fill["knobs"]["labels"]["RU"], "名RU");

        let order: Vec<String> = ring_order().to_vec();
        let calls = std::sync::Mutex::new(Vec::new());
        let request =
            crate::next_visual::Request::LeafFill { recipe: RING_RECIPE, rows: kept, knobs: &fill["knobs"], order: &order, runtime: Path::new("runtime") };
        let Ok(crate::next_visual::Reply::Filled(page)) = crate::next_flow::visual_call(&calls, "leaf_fill", request) else {
            panic!("no filled page");
        };
        // 18 declared; lab_t0 and lab_t1 each compute one fact per origin outside the hub (RU NO US)
        assert_eq!((page.layers.len(), page.refs.as_slice(), page.facts.len()), (5, &["imp".to_string(), "impm".into()][..], 22));
        // the total is the countries outside the hub (RU NO US); DE is a member, TOTAL and EXT_EU27_2020 are not rows
        let tot24 = page.facts.iter().find(|f| f.key == "tot24").unwrap();
        assert_eq!((tot24.v, tot24.n), (37843.285 + 1.0 + 1.0, Some(3)));
        assert_eq!((page.frame.clone(), page.w, page.h), (Value::Null, 1140.0, 0.0));

        let (main, monthly, shape, picks) = rows("XYZ");
        assert_eq!(
            ring_fill(&shape, &picks, (&main, &monthly), &Hubs, ("", "")).unwrap_err(),
            "not this shape: unit XYZ has no row in unit-short-zh"
        );
        let (main, monthly, shape, picks) = rows("MIO_M3");
        assert_eq!(
            ring_fill(&shape, &picks, (&main, &monthly), &NoAggregateNames, ("", "")).unwrap_err(),
            "not this shape: the name table names no hub EU27_2020"
        );
    }

    /// Hubs, but the name table names no aggregate code: only two-letter codes have a name.
    struct NoAggregateNames;
    impl Catalogue for NoAggregateNames {
        fn top5(&self, _: &str, _: &[String]) -> crate::l5geo::Ranking {
            unreachable!()
        }
        fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
            unreachable!()
        }
        fn source(&self) -> &Value {
            &Value::Null
        }
        fn countries(&self, codes: &[String]) -> Result<Vec<String>, String> {
            Hubs.countries(codes)
        }
        fn zh_names(&self, scheme: &str, codes: &[String]) -> Result<BTreeMap<String, String>, Vec<String>> {
            let missing: Vec<String> = codes.iter().filter(|c| c.len() != 2).cloned().collect();
            if missing.is_empty() { Hubs.zh_names(scheme, codes) } else { Err(missing) }
        }
        fn members(&self, aggregate: &str) -> Result<Vec<String>, String> {
            Hubs.members(aggregate)
        }
    }

    /// The ring page's layers are the leaf registry's ring group without events.
    #[test]
    fn the_ring_order_is_the_registry_ring_group_without_events() {
        let knobs: Value = serde_json::from_str(&std::fs::read_to_string("runtime/leaves_py/knobs.json").unwrap()).unwrap();
        let group: Vec<&str> = knobs["groups"]["ring"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(group.into_iter().filter(|l| *l != "events").collect::<Vec<_>>(), ring_order());
    }

    /// A ring page with no table, or a main with no kept companion, stops at the shape before anything is read or called;
    /// a published ring page's plan is its own steps, all done.
    #[test]
    fn a_ring_page_without_a_companion_stops_at_the_shape_and_its_plan_is_its_own_steps() {
        let dir = tempfile::tempdir().unwrap();
        let main = Prepared {
            id: "imp".into(),
            title: String::new(),
            file: "data/imp.csv".into(),
            args: Map::new(),
            sheet: String::new(),
            claims: Vec::new(),
            places_zh: Vec::new(),
            companions: Vec::new(),
        };
        let stopped = |prepared: &[Prepared]| recipe_request(dir.path(), prepared, &[], recipe(RING_RECIPE), &Hubs, ("", "", "")).unwrap_err();
        assert_eq!(stopped(&[]), ("shape", "not this shape: no table".to_string()));
        assert_eq!(stopped(&[main]), ("shape", "not this shape: main imp kept no companion".to_string()));
        let plan = plan_record("q", &LEAF_PLAN_STEPS, "browser", true).unwrap();
        let ids: Vec<&str> = plan["steps"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["claims", "text", "shape", "fill", "draw", "door", "browser", "publication_vision"]);
        let done: Vec<&Value> = plan["steps"].as_array().unwrap().iter().filter(|s| s["status"] == "completed").collect();
        assert_eq!(done.len(), 7, "the image review is pending once the page is checked in the browser");
    }

    /// The gas fixture read as the run reads it: the main's and the companion's rows, the catalogue, the ring shape, and the
    /// picked claims joined to their kinds (picked_claims, the one join the run makes).
    fn gas_fixture() -> (Vec<Value>, Vec<Value>, crate::next_flow::GroupCatalogue, Shape, Vec<(String, Value)>) {
        let var = |k: &str| std::env::var(k).unwrap();
        let run = std::path::PathBuf::from(var("GAS_RUN"));
        let main = sdmx_rows("nrg_ti_gas", &std::fs::read_to_string(var("GAS_CSV")).unwrap(), |d| d["geo"] == "EU27_2020");
        let monthly = sdmx_rows("nrg_ti_gasm", &std::fs::read_to_string(var("GAS_CSV_M")).unwrap(), |_| true);
        let catalogue = crate::next_flow::GroupCatalogue::from_env(|k| std::env::var(k).ok()).unwrap();
        let shape = ring_shape(&[("nrg_ti_gas", &main), ("nrg_ti_gasm", &monthly)], &catalogue).unwrap();
        let picked = read_json(&run, "picked.json").unwrap();
        let table = Prepared {
            id: "nrg_ti_gas".into(),
            title: String::new(),
            file: String::new(),
            args: Map::new(),
            sheet: picked["sheet"].as_str().unwrap().into(),
            claims: picked["claims"].as_array().unwrap().clone(),
            places_zh: Vec::new(),
            companions: Vec::new(),
        };
        let claims = picked_claims(&run, &table, &claim_records(&run).unwrap()).unwrap();
        (main, monthly, catalogue, shape, claims)
    }

    /// The gas fixture (GAS_CSV, GAS_CSV_M: nrg_ti_gas kept to geo EU27_2020 as a fetch would, nrg_ti_gasm) and the claims
    /// step's run folder for it (GAS_RUN: claims.jsonl, the candidate sheet and picked.json, as claims_step_fixture writes them):
    /// the picked claims joined to their kinds as the run reads them, then the ring shape and its picks.
    #[test]
    #[ignore]
    fn ring_picks_of_the_gas_fixture() {
        let started = std::time::Instant::now();
        let (main, _, _, shape, claims) = gas_fixture();
        let kinds: Vec<&str> = claims.iter().map(|(k, _)| k.as_str()).collect();
        let got = ring_picks(&shape, &main, &claims);
        println!("ring picks kinds {kinds:?} shape {} -> {} years {}..{} got {got:?} ms {}", shape.main, shape.companion,
            shape.years[0], shape.years[shape.years.len() - 1], started.elapsed().as_millis());
        let got = got.unwrap();
        assert_eq!((got.focus.as_str(), got.t0.as_str(), got.t1.as_str()), ("RU", "2015", "2024"));
        assert_eq!(got.top.len(), RING_TOP);
    }

    /// The gas fixture's main and its monthly twin, each kept to geo EU27_2020 as a fetch under the main's filters would be,
    /// through the knowledge group's companion rows and companions as the run reads them (env as gas_fixture): both placed by
    /// partner, the origin ring_shape found, and every shortlisted candidate kept or dropped with why. The twin is not on
    /// nrg_ti_gas's shortlist (10-29: nrg_stk_gas, nrg_cb_gas), so it is not asked to be kept here.
    #[test]
    #[ignore]
    fn the_gas_fixture_s_hub_rows_are_placed_by_partner() {
        let (_, _, catalogue, shape, _) = gas_fixture();
        let hub_only = |var: &str| {
            let csv = std::fs::read_to_string(std::env::var(var).unwrap()).unwrap();
            let mut lines = csv.lines();
            let header = lines.next().unwrap();
            let at = header.split(',').position(|h| h == "geo").unwrap();
            let kept = lines.filter(|l| l.split(',').nth(at) == Some("EU27_2020"));
            std::iter::once(header).chain(kept).collect::<Vec<_>>().join("\n")
        };
        let mut rows = BTreeMap::new();
        for (table, var) in [("nrg_ti_gas", "GAS_CSV"), ("nrg_ti_gasm", "GAS_CSV_M")] {
            let found = catalogue.companion_rows(&catalogue.table(table).unwrap(), &hub_only(var)).unwrap();
            assert!(found.iter().all(|r| r.via.as_deref() == Some(shape.place.as_str())), "{table} not placed by {}", shape.place);
            rows.insert(table.to_string(), found);
        }
        let (kept, dropped) = catalogue.companions("nrg_ti_gas", &rows);
        println!("kept {kept:?} dropped {dropped:?}");
        let shortlist: Vec<String> = catalogue.companion_shortlist("nrg_ti_gas").into_iter().map(|(c, _)| c.id).collect();
        let mut seen: Vec<String> = kept.iter().map(|c| c.id.clone()).chain(dropped.into_iter().map(|(t, _)| t)).collect();
        seen.sort();
        assert_eq!(seen, shortlist.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>());
    }

    /// The gas fixture's ring page filled (env as ring_picks_of_the_gas_fixture; HAND_REQ: the hand page's stored request,
    /// read for its fact keys only): the fill's fields by class, its facts against the hand page's with each hand key it has
    /// no fact for named, focus, years, top and window, then the visual group's LeafFill on it, and the milliseconds.
    #[test]
    #[ignore]
    fn ring_fill_of_the_gas_fixture() {
        let started = std::time::Instant::now();
        let (main, monthly, catalogue, shape, claims) = gas_fixture();
        let picks = ring_picks(&shape, &main, &claims).unwrap();
        let fill = ring_fill(&shape, &picks, (&main, &monthly), &catalogue, ("标题", "导语")).unwrap();
        // FILL_OUT: where to write the filled request, for the scan of its numbers
        if let Ok(out) = std::env::var("FILL_OUT") {
            std::fs::write(out, fill.to_string()).unwrap();
        }
        let spec = &fill["knobs"]["spec"];
        let facts = spec["facts"].as_object().unwrap();
        let mut by_class: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (k, q) in facts {
            by_class.entry(q["op"].as_str().unwrap_or("value")).or_default().push(k.as_str());
        }
        let hand: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("HAND_REQ").unwrap()).unwrap()).unwrap();
        let hand = hand["knobs"]["spec"]["facts"].as_object().unwrap();
        let uncovered: Vec<&String> = hand.keys().filter(|k| !facts.contains_key(*k)).collect();
        println!("fill focus {} t0 {} t1 {} top {:?} from {} rows {} order {}", picks.focus, picks.t0, picks.t1, picks.top,
            spec["hero"]["ring"]["from"], fill["rows"].as_array().unwrap().len(), fill["order"]);
        println!("fill facts {} by class {by_class:?}", facts.len());
        println!("fill fmts {} unit {}", spec["fmts"], spec["hero"]["unit"]);
        println!("hand facts {} also generated {} uncovered {} {uncovered:?}", hand.len(), hand.len() - uncovered.len(),
            uncovered.len());
        assert_eq!(spec["hero"]["data"]["top"], json!(picks.top));

        let order: Vec<String> = fill["order"].as_array().unwrap().iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
        let calls = std::sync::Mutex::new(Vec::new());
        let request = crate::next_visual::Request::LeafFill {
            recipe: RING_RECIPE,
            rows: fill["rows"].as_array().unwrap(),
            knobs: &fill["knobs"],
            order: &order,
            runtime: Path::new("runtime"),
        };
        let page = match crate::next_flow::visual_call(&calls, "leaf_fill", request) {
            Ok(crate::next_visual::Reply::Filled(page)) => page,
            Ok(_) => panic!("not a filled page"),
            Err(e) => panic!("leaf fill: {e}"),
        };
        let at = |k: &str| page.facts.iter().find(|f| f.key == k).map(|f| (f.v, f.t.clone()));
        let f = picks.focus.to_lowercase();
        println!("leaf fill layers {} facts {} ledger {} refs {:?} peak {:?} last {:?} tot {:?} {:?} ms {}", page.layers.len(),
            page.facts.len(), page.ledger.len(), page.refs, at(&format!("{f}_m_peak")), at(&format!("{f}_last")),
            at(&format!("tot{}", &picks.t0[2..])), at(&format!("tot{}", &picks.t1[2..])), started.elapsed().as_millis());
    }

    /// Every recipe's conditions in registry order on one table across places, one year (the q1 shape): the ring refuses it
    /// by name, the column page reads its place, unit and year; its picks rank the countries (a country twice refuses) and mark
    /// the ones the claims name; its nodes, big numbers then bars, fill a page from it, each row once, the gap of two
    /// percentages in points; an unknown condition or rule names the known.
    #[test]
    fn each_recipe_reads_the_shape_by_its_own_conditions_and_its_nodes_fill_the_page() {
        let names: Vec<&str> = Hubs.recipes().iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["scmp", "ring", "column"]);
        let mut main = ring_rows("sdg", &[("freq", "A"), ("unit", "PC")], ("geo", &["SE", "BE", "DE", "FR", "EU27_2020"]), &["2025"]);
        for (r, v) in main.iter_mut().zip(["65.4", "14.9", "30.25", "20", "40"]) {
            r["value"] = json!(v);
        }
        let tables = [("sdg", &main[..])];
        assert_eq!(ring_shape(&tables, &Hubs).unwrap_err(), "not this shape: main spans one year (2025)");
        let column = recipe("column");
        let shape = shape_of(&column.eats, &tables, &Hubs).unwrap();
        assert_eq!((shape.place.as_str(), shape.unit.as_str(), shape.year.as_str()), ("geo", "PC", "2025"));
        assert_eq!(shape.countries, ["BE", "DE", "FR", "SE"]);
        let claims = [("rank_top".to_string(), bound("c1", &[("country_iso2", json!("BE")), ("value", json!(14.9))]))];
        let picks = picks_of(&column.picks, &shape, &main, &claims).unwrap();
        assert_eq!((picks.ranked.clone(), picks.marks.clone()), (vec!["SE".into(), "DE".into(), "FR".into(), "BE".into()], vec!["BE".into()]));
        // the same country twice, its two rows apart once sorted
        let mut twice = main.clone();
        twice.push(json!({"src": "series:sdg/x:2025:OBS_VALUE", "dims": {"freq": "A", "unit": "PC", "geo": "SE"}, "time": "2025", "value": "1"}));
        assert_eq!(picks_of(&column.picks, &shape, &twice, &claims).unwrap_err(), "not this shape: main sdg holds SE twice at 2025");

        assert_eq!(column.layers, ["bignums", "bars"]);
        let fill = fill_of(column, &shape, &picks, (&main, &[]), &Hubs, ("标题", "导语")).unwrap();
        assert_eq!(fill["order"], json!(["bignums", "bars"]));
        let rows = fill["rows"].as_array().unwrap();
        assert_eq!(rows.iter().map(|r| r["dims"]["geo"].as_str().unwrap()).collect::<Vec<_>>(), ["SE", "BE", "DE", "FR"]);
        let spec = &fill["knobs"]["spec"];
        assert_eq!(spec["facts"].as_object().unwrap().keys().collect::<Vec<_>>(), ["gap", "hi", "lo", "times", "val"]);
        assert_eq!((spec["facts"]["hi"]["filter"]["geo"].as_str(), spec["facts"]["lo"]["filter"]["geo"].as_str()), (Some("SE"), Some("BE")));
        assert_eq!(spec["fmts"]["pc"], json!({"scale": 1, "dec": 2, "suffix": "%"}));
        assert_eq!(spec["fmts"]["pp"], json!({"scale": 1, "dec": 2, "suffix": " 个百分点"}));
        assert_eq!((spec["facts"]["gap"]["fmt"].as_str(), spec["facts"]["hi"]["fmt"].as_str()), (Some("pp"), Some("pc")));
        assert_eq!(spec["hero"]["unit"], "单位：%");
        assert_eq!(spec["hero"]["data"]["marks"], json!(["BE"]));
        assert_eq!(spec["tables"], json!({"sdg": {"id": "sdg"}}));
        assert!(fill["knobs"].get("members").is_none());

        let bad = Recipe { eats: vec!["annual".into(), "round".into()], ..recipe_like(column) };
        assert!(shape_of(&bad.eats, &tables, &Hubs).unwrap_err().starts_with("not this shape: no shape condition round; e.g. one of annual|"));
        assert!(picks_of(&["guess".into()], &shape, &main, &claims).unwrap_err().starts_with("not this shape: no pick rule guess; e.g. one of "));
    }

    /// The q6 shape (asylum applicants by citizenship into the EU, one year) in registry order: the ring refuses it for its
    /// one year, the column page is the first recipe that reads it, its place the citizenship.
    #[test]
    fn a_one_year_table_across_citizenships_is_a_column_page_and_never_a_ring() {
        let fixed = [("freq", "A"), ("unit", "PER"), ("sex", "T"), ("age", "TOTAL"), ("geo", "EU27_2020")];
        let main = ring_rows("migr", &fixed, ("citizen", &["SY", "AF", "UA", "TOTAL"]), &["2025"]);
        let tables = [("migr", &main[..])];
        let got: Vec<(&str, Result<String, String>)> = Hubs
            .recipes()
            .iter()
            .map(|r| (r.name.as_str(), shape_of(&r.eats, &tables, &Hubs).map(|s| format!("{} {} {}", s.place, s.unit, s.year))))
            .collect();
        assert_eq!(
            got,
            [
                ("scmp", Err("not this shape: main spans one year (2025)".to_string())),
                ("ring", Err("not this shape: main spans one year (2025)".to_string())),
                ("column", Ok("citizen PER 2025".to_string()))
            ]
        );
    }

    fn recipe_like(r: &Recipe) -> Recipe {
        Recipe {
            name: r.name.clone(),
            layers: r.layers.clone(),
            eats: r.eats.clone(),
            charts: r.charts.clone(),
            picks: r.picks.clone(),
            exposes: r.exposes.clone(),
            window: r.window.clone(),
        }
    }

    /// The gas fixture's ring page drawn, baked and checked by the leaf children (env as ring_fill_of_the_gas_fixture; run with
    /// --ignored): the visual group's LeafPage on its LeafFill, nothing written or published; prints each layer's record (its
    /// milliseconds) or the first refusal, for the draw stage's measurement.
    #[test]
    #[ignore]
    fn the_gas_ring_page_through_the_leaf_children() {
        let (main, monthly, catalogue, shape, claims) = gas_fixture();
        let picks = ring_picks(&shape, &main, &claims).unwrap();
        let mut fill = ring_fill(&shape, &picks, (&main, &monthly), &catalogue, ("标题", "导语")).unwrap();
        fill["knobs"]["shapes"] = json!("runtime/pi/assets/naturalearth-admin0-50m.geojson");
        let order: Vec<String> = fill["order"].as_array().unwrap().iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
        let calls = std::sync::Mutex::new(Vec::new());
        let request = crate::next_visual::Request::LeafFill {
            recipe: RING_RECIPE,
            rows: fill["rows"].as_array().unwrap(),
            knobs: &fill["knobs"],
            order: &order,
            runtime: Path::new("runtime"),
        };
        let Ok(crate::next_visual::Reply::Filled(page)) = crate::next_flow::visual_call(&calls, "leaf_fill", request) else {
            panic!("leaf fill")
        };
        let leaf = crate::next_visual::LeafPage {
            draw: &page.draw,
            bake: &page.bake,
            w: page.w,
            h: page.h,
            frame: page.frame.clone(),
            layers: &page.layers,
            ledger: &page.ledger,
            refs: &page.refs,
            facts: (&page.spec, &page.rows, &page.facts),
        };
        let started = std::time::Instant::now();
        match crate::next_flow::visual_call(&calls, "leaf_page", crate::next_visual::Request::LeafPage { page: &leaf }) {
            Ok(crate::next_visual::Reply::Leaf(drawn)) => {
                for r in &drawn.records {
                    println!("record {} {} {} ms {}", r.node, r.layer, r.outcome, r.ms);
                }
                println!("drawn page {} bytes ms {}", drawn.html.len(), started.elapsed().as_millis());
            }
            Ok(_) => panic!("not a leaf page"),
            Err(why) => {
                println!("refused ms {}: {why}", started.elapsed().as_millis());
                // the records up to the refusal, from the draw stage itself (the visual call keeps only the reasons)
                if let Err((records, _)) = crate::next_leaf::draw_page(leaf.draw, leaf.w, leaf.h, leaf.frame.clone(), leaf.layers) {
                    for r in &records {
                        println!("record {} {} {} ms {}", r.node, r.layer, r.outcome, r.ms);
                    }
                }
            }
        };
    }

    /// The gas fixture's scmp page (env as ring_fill_of_the_gas_fixture; run with --ignored): the scmp recipe's shape, picks and
    /// fill over the fixture, its LeafFill, then the page drawn and baked by the leaf children from this tree's runtime/ (the
    /// visual group's LeafPage), nothing written or published; prints the fill's sizes, each layer's record (its
    /// milliseconds) or the first refusal, for the measurement; LEAF_PAGE_OUT: where to write the page.
    #[test]
    #[ignore]
    fn the_gas_scmp_page_through_the_leaf_children() {
        let started = std::time::Instant::now();
        let (main, monthly, catalogue, _, claims) = gas_fixture();
        let scmp = recipe("scmp");
        let shape = shape_of(&scmp.eats, &[("nrg_ti_gas", &main), ("nrg_ti_gasm", &monthly)], &catalogue).unwrap();
        let picks = picks_of(&scmp.picks, &shape, &main, &claims).unwrap();
        let mut fill = fill_of(scmp, &shape, &picks, (&main, &monthly), &catalogue, ("标题", "导语")).unwrap();
        fill["knobs"]["shapes"] = json!("runtime/pi/assets/naturalearth-admin0-50m.geojson");
        fill["knobs"]["spec"]["kicker"] = json!("栏目");
        fill["knobs"]["spec"]["source"] = json!("欧盟统计局 nrg_ti_gas、nrg_ti_gasm");
        let hero = &fill["knobs"]["spec"]["hero"];
        println!("scmp fill order {} rows {} facts {} notes {} bignums {} strip from {} ms {}", fill["order"],
            fill["rows"].as_array().unwrap().len(), fill["knobs"]["spec"]["facts"].as_object().unwrap().len(),
            hero["notes"].as_array().map_or(0, Vec::len), hero["data"]["bignums"], hero["strip"]["from"], started.elapsed().as_millis());
        let order: Vec<String> = fill["order"].as_array().unwrap().iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
        let calls = std::sync::Mutex::new(Vec::new());
        let request = crate::next_visual::Request::LeafFill {
            recipe: "scmp",
            rows: fill["rows"].as_array().unwrap(),
            knobs: &fill["knobs"],
            order: &order,
            runtime: Path::new("runtime"),
        };
        let page = match crate::next_flow::visual_call(&calls, "leaf_fill", request) {
            Ok(crate::next_visual::Reply::Filled(page)) => page,
            Ok(_) => panic!("not a leaf fill"),
            Err(why) => panic!("stuck scmp-fill: {why}"),
        };
        let leaf = crate::next_visual::LeafPage {
            draw: &page.draw,
            bake: &page.bake,
            w: page.w,
            h: page.h,
            frame: page.frame.clone(),
            layers: &page.layers,
            ledger: &page.ledger,
            refs: &page.refs,
            facts: (&page.spec, &page.rows, &page.facts),
        };
        let started = std::time::Instant::now();
        match crate::next_flow::visual_call(&calls, "leaf_page", crate::next_visual::Request::LeafPage { page: &leaf }) {
            Ok(crate::next_visual::Reply::Leaf(drawn)) => {
                for r in &drawn.records {
                    println!("record {} {} {} ms {}", r.node, r.layer, r.outcome, r.ms);
                }
                println!("drawn page {} bytes ms {}", drawn.html.len(), started.elapsed().as_millis());
                if let Ok(out) = std::env::var("LEAF_PAGE_OUT") {
                    std::fs::write(out, &drawn.html).unwrap();
                }
            }
            Ok(_) => panic!("not a leaf page"),
            Err(why) => {
                println!("refused ms {}: {why}", started.elapsed().as_millis());
                // the page as drawn, before the bake, for a refusal past the draw (LEAF_PAGE_OUT with .drawn.html)
                let records = match crate::next_leaf::draw_page(leaf.draw, leaf.w, leaf.h, leaf.frame.clone(), leaf.layers) {
                    Ok((_, html, records)) => {
                        if let Ok(out) = std::env::var("LEAF_PAGE_OUT") {
                            std::fs::write(format!("{out}.drawn.html"), html).unwrap();
                        }
                        records
                    }
                    Err((records, _)) => records,
                };
                for r in &records {
                    println!("record {} {} {} ms {}", r.node, r.layer, r.outcome, r.ms);
                }
            }
        };
    }

    /// The stored q1 run's page (STORED_RUN=<the q1 run folder>; the catalogue env as the product's; run with --ignored) as
    /// leaf_page makes it, its charts drawn as a horizontal bar: the first recipe whose shape it has, its LeafFill, then the
    /// page drawn and baked by the leaf children from this tree's runtime/ (the visual group's LeafPage), nothing written
    /// or published; prints the recipe, each layer's record (its milliseconds) or the first refusal, for the draw stage's
    /// measurement.
    #[test]
    #[ignore]
    fn the_q1_page_through_the_leaf_children() {
        let run = std::path::PathBuf::from(std::env::var("STORED_RUN").unwrap());
        let catalogue = crate::next_flow::GroupCatalogue::from_env(|k| std::env::var(k).ok()).unwrap();
        let (prepared, mode) = last_prepare(&run).unwrap();
        println!("prepare {} {} mode {mode}", prepared.id, prepared.file);
        let started = std::time::Instant::now();
        let request = leaf_request(&run, &[prepared], &["horizontal_bar"], &catalogue, ("", ("标题", "导语", "栏目")), &Default::default());
        let (recipe, fill) = match request {
            Ok(got) => got,
            Err((recipe, stage, why)) => panic!("stuck {recipe}-{stage} ms {}: {why}", started.elapsed().as_millis()),
        };
        println!("recipe {recipe} request ms {}", started.elapsed().as_millis());
        let order: Vec<String> = fill["order"].as_array().unwrap().iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
        let calls = std::sync::Mutex::new(Vec::new());
        let request = crate::next_visual::Request::LeafFill {
            recipe,
            rows: fill["rows"].as_array().unwrap(),
            knobs: &fill["knobs"],
            order: &order,
            runtime: Path::new("runtime"),
        };
        let page = match crate::next_flow::visual_call(&calls, "leaf_fill", request) {
            Ok(crate::next_visual::Reply::Filled(page)) => page,
            Ok(_) => panic!("not a leaf fill"),
            Err(why) => panic!("stuck {recipe}-fill: {why}"),
        };
        let leaf = crate::next_visual::LeafPage {
            draw: &page.draw,
            bake: &page.bake,
            w: page.w,
            h: page.h,
            frame: page.frame.clone(),
            layers: &page.layers,
            ledger: &page.ledger,
            refs: &page.refs,
            facts: (&page.spec, &page.rows, &page.facts),
        };
        let started = std::time::Instant::now();
        match crate::next_flow::visual_call(&calls, "leaf_page", crate::next_visual::Request::LeafPage { page: &leaf }) {
            Ok(crate::next_visual::Reply::Leaf(drawn)) => {
                for r in &drawn.records {
                    println!("record {} {} {} ms {}", r.node, r.layer, r.outcome, r.ms);
                }
                println!("drawn page {} bytes ms {}", drawn.html.len(), started.elapsed().as_millis());
                if let Ok(out) = std::env::var("LEAF_PAGE_OUT") {
                    std::fs::write(out, &drawn.html).unwrap();
                }
            }
            Ok(_) => panic!("not a leaf page"),
            Err(why) => {
                println!("refused ms {}: {why}", started.elapsed().as_millis());
                // the records up to the refusal, or of the whole draw when the bake or the page check refused, from the draw
                // stage itself (the visual call keeps only the reasons)
                let records = match crate::next_leaf::draw_page(leaf.draw, leaf.w, leaf.h, leaf.frame.clone(), leaf.layers) {
                    Ok((_, _, records)) | Err((records, _)) => records,
                };
                for r in &records {
                    println!("record {} {} {} ms {}", r.node, r.layer, r.outcome, r.ms);
                }
            }
        };
    }

    /// The stored q6 run (RING_RUN=<run folder>; the catalogue env as the product's; run with --ignored): its fetched files
    /// opened by their hash names, each checked against its fetch event's sha256, read as series rows, then the ring shape.
    #[test]
    #[ignore]
    fn ring_shape_of_a_stored_run() {
        let started = std::time::Instant::now();
        let tables = stored_tables("RING_RUN");
        let catalogue = crate::next_flow::GroupCatalogue::from_env(|k| std::env::var(k).ok()).unwrap();
        let tables: Vec<(&str, &[Value])> = tables.iter().map(|(t, r)| (t.as_str(), &r[..])).collect();
        let got = ring_shape(&tables, &catalogue);
        println!("ring shape {got:?} ms {}", started.elapsed().as_millis());
        assert_eq!(got.unwrap_err(), "not this shape: main spans one year (2025)");
    }

    /// A stored run's fetched files (<env var>=<run folder>) opened by their hash names, each checked against its fetch
    /// event's sha256, read as series rows, in fetch order.
    fn stored_tables(var: &str) -> Vec<(String, Vec<Value>)> {
        let run = std::path::PathBuf::from(std::env::var(var).unwrap());
        let mut tables: Vec<(String, Vec<Value>)> = Vec::new();
        for line in std::fs::read_to_string(run.join("events.jsonl")).unwrap().lines() {
            let e: Value = serde_json::from_str(line).unwrap();
            let d = &e["result"]["details"];
            if d["mode"] != "candidates" {
                continue;
            }
            let (file, sha) = (d["filePath"].as_str().unwrap(), d["sha256"].as_str().unwrap());
            let bytes = std::fs::read(run.join(file)).unwrap();
            assert_eq!(crate::hash::sha256_bytes(&bytes), sha, "{file}");
            assert_eq!(file, format!("data/{sha}.csv"));
            let id = d["dataset"].as_str().unwrap().to_string();
            let rows = sdmx_rows(&id, &String::from_utf8(bytes).unwrap(), |_| true);
            println!("ring table {id} {file} sha256 ok");
            tables.push((id, rows));
        }
        tables
    }

    /// Every recipe's shape, in registry order, on a stored run (STORED_RUN=<run folder>; the catalogue env as the product's;
    /// run with --ignored), as leaf_page tries them on the first table (with its fetched companions behind it): q6 (an
    /// asylum table across citizenships, one year) and q1 (a share across countries, one year) are each refused by the
    /// ring by name and read by the column page, the first recipe that reads them.
    #[test]
    #[ignore]
    fn every_recipe_s_shape_of_a_stored_run() {
        let tables = stored_tables("STORED_RUN");
        let catalogue = crate::next_flow::GroupCatalogue::from_env(|k| std::env::var(k).ok()).unwrap();
        let tables: Vec<(&str, &[Value])> = tables.iter().map(|(t, r)| (t.as_str(), &r[..])).collect();
        let got: Vec<(String, Result<String, String>)> = catalogue
            .recipes()
            .iter()
            .map(|r| {
                let shape = shape_of(&r.eats, &tables, &catalogue);
                (r.name.clone(), shape.map(|s| format!("place {} unit {} year {} companion {}", s.place, s.unit, s.year, s.companion)))
            })
            .collect();
        println!("main {} recipes {got:?}", tables[0].0);
        assert_eq!(got[0], ("ring".to_string(), Err("not this shape: main spans one year (2025)".to_string())));
        let column = match tables[0].0 {
            "migr_asyappctza" => "place citizen unit PER year 2025 companion ",
            "sdg_07_40" => "place geo unit PC year 2025 companion ",
            other => panic!("no expected shape for the stored main {other}"),
        };
        assert_eq!(got[1], ("column".to_string(), Ok(column.to_string())));
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
        let chart = |category: &str| Chart {
            relation: Relation::Ranking,
            view: View::Slice,
            claim_ids: vec!["c1".into()],
            category: category.into(),
            value: "value".into(),
        };
        let rows = [
            json!({"country_iso2": "SE", "value": 66.4}),
            json!({"country_iso2": "EL", "value": 25.0}),
        ];
        let names = chart_names(&chart("country_iso2"), &rows, &NoTables).unwrap();
        let template = template_of(&chart("country_iso2"), "c1", names);
        assert_eq!(template["category_names"], "iso2");
        assert_eq!(template["names"], json!({"EL": "希腊", "SE": "瑞典"}));
        let aggregate = [
            json!({"country_iso2": "SE", "value": 1.0}),
            json!({"country_iso2": "EU27_2020", "value": 2.0}),
        ];
        let refused = chart_names(&chart("country_iso2"), &aggregate, &NoTables).unwrap_err();
        assert!(
            refused.contains("EU27_2020") && !refused.contains("SE"),
            "{refused}"
        );
        assert_eq!(chart_names(&chart("year"), &rows, &NoTables), Ok(None));
        assert!(template_of(&chart("year"), "c1", None)
            .get("names")
            .is_none());
    }

    #[test]
    fn a_second_chart_gets_its_own_measure_at_its_own_index() {
        let mut page = Page {
            claims: Vec::new(),
            charts: Vec::new(),
            templates: Vec::new(),
            sentences: BTreeMap::new(),
            places: Vec::new(),
            times: Vec::new(),
            measures: Vec::new(),
            plans: Vec::new(),
            scopes: Vec::new(),
        };
        let chart = |relation, category: &str| Chart {
            relation,
            view: View::Slice,
            claim_ids: vec!["c".into()],
            category: category.into(),
            value: "value".into(),
        };
        let measure = next_pack::Measure {
            title: "T".into(),
            name: "T".into(),
            unit_code: Some("PC".into()),
            unit_label: None,
            kind: Some("share"),
            times: Vec::new(),
            axis: Axis::Country,
            source: None,
        };
        let drawn = |relation, category: &str, axis| Drawn {
            chart: chart(relation, category),
            axis,
            series_rows: Vec::new(),
        };
        push_charts(
            &mut page,
            vec![
                drawn(Relation::Ranking, "geo", Axis::Country),
                drawn(Relation::Map, "geo", Axis::Other),
            ],
            measure.clone(),
            None,
        );
        push_charts(
            &mut page,
            vec![drawn(Relation::Change, "year", Axis::Time)],
            measure,
            None,
        );
        let pairs: Vec<(Relation, Axis)> = page
            .charts
            .iter()
            .zip(&page.measures)
            .map(|(c, m)| (c.relation, m.axis))
            .collect();
        assert_eq!(
            pairs,
            [
                (Relation::Ranking, Axis::Country),
                (Relation::Map, Axis::Other),
                (Relation::Change, Axis::Time)
            ]
        );
    }

    /// A fetched table of 6 countries over 9 years, read into its shape by the fake below; its claims' computations written under
    /// a run folder: `picked` gives (claim id, kind, series columns), the value series one row per country at the latest year,
    /// the move series one row per country from the first to the last year.
    struct MoveRun {
        dir: tempfile::TempDir,
        table: Prepared,
    }

    struct SixCountries;

    impl Catalogue for SixCountries {
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
            Some(crate::l5geo::TableMeta {
                id: id.into(),
                worldbank: false,
                end_year: None,
                places: Vec::new(),
                place_members: Vec::new(),
                freqs: Vec::new(),
                unit: None,
                dims: Vec::new(),
            })
        }
        fn shape(
            &self,
            _: &crate::l5geo::TableMeta,
            _: &str,
        ) -> Result<crate::shape_registry::Shape, String> {
            use crate::shape_registry::{Role, Shape, VaryingDim};
            let dim = |dim: &str, members, roles: &[Role], place| VaryingDim {
                dim: dim.into(),
                members,
                roles: roles.to_vec(),
                is_place: place,
                iso_countries: place,
                total_member: None,
            };
            Ok(Shape {
                dims: vec![
                    dim("geo", 6, &[Role::Place, Role::Category], true),
                    dim("time", 9, &[Role::Time], false),
                ],
                unit_additive: false,
                official_flow: None,
            })
        }
    }

    fn move_run(picked: &[(&str, &str, &[&str])]) -> MoveRun {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        for sub in ["computations", "shadow", "data"] {
            std::fs::create_dir_all(run.join(sub)).unwrap();
        }
        std::fs::write(run.join("data/t.csv"), "geo,time,value\n").unwrap();
        let codes = ["DEU", "FRA", "ITA", "ESP", "POL", "NLD"];
        let mut claims = String::new();
        let mut candidates = Vec::new();
        let mut registered = Vec::new();
        for (i, (id, kind, columns)) in picked.iter().enumerate() {
            let rows: Vec<Value> = codes
                .iter()
                .enumerate()
                .map(|(n, code)| {
                    let mut row = Map::new();
                    for c in *columns {
                        row.insert(
                            c.to_string(),
                            match *c {
                                "country_iso3" => json!(code),
                                "year" | "to_year" => json!(2024),
                                "from_year" => json!(2016),
                                "siec" => json!("TOTAL"),
                                _ => json!(10 + n),
                            },
                        );
                    }
                    Value::Object(row)
                })
                .collect();
            let series = json!({"columns": columns, "rows": rows});
            let own = json!({"rows": [rows[0]]});
            std::fs::write(
                run.join(format!("computations/{id}-own.json")),
                own.to_string(),
            )
            .unwrap();
            std::fs::write(
                run.join(format!("computations/{id}-series.json")),
                series.to_string(),
            )
            .unwrap();
            claims.push_str(&format!(
                "{}\n",
                json!({"claim_id": id, "claim": format!("{kind} sentence"),
                    "computation_refs": [format!("computations/{id}-own.json"), format!("computations/{id}-series.json")]})
            ));
            candidates.push(
                json!({"id": format!("k{i}"), "kind": kind, "template": "{first.country_iso3}"}),
            );
            registered.push(json!({"candidate": format!("k{i}"), "claim_id": id}));
        }
        std::fs::write(run.join("claims.jsonl"), claims).unwrap();
        std::fs::write(
            run.join("shadow/candidate_sheet-s.json"),
            json!({"candidates": candidates}).to_string(),
        )
        .unwrap();
        MoveRun {
            dir,
            table: Prepared {
                id: "t".into(),
                title: "T".into(),
                file: "data/t.csv".into(),
                args: Map::new(),
                sheet: "s".into(),
                claims: registered,
                places_zh: Vec::new(),
                companions: Vec::new(),
            },
        }
    }

    const VALUE_SERIES: &[&str] = &["country_iso3", "value", "year"];
    const MOVE_SERIES: &[&str] = &[
        "country_iso3",
        "from_value",
        "to_value",
        "change",
        "from_year",
        "to_year",
    ];

    fn made(run: &MoveRun) -> Result<TableChart, String> {
        let _command = crate::group_guard::command_for_test("investigate");
        let records = claim_records(run.dir.path()).unwrap();
        table_chart(run.dir.path(), &records, &run.table, &SixCountries, &[])
    }

    #[test]
    fn a_mixed_pick_draws_each_series_form_on_its_own_chart_with_its_own_rows() {
        let run = move_run(&[
            ("c1", "rank_top", VALUE_SERIES),
            ("c2", "change_largest_rise", MOVE_SERIES),
            ("c3", "rank_bottom", VALUE_SERIES),
            ("c4", "change_largest_fall", MOVE_SERIES),
        ]);
        let made = made(&run).unwrap();
        let drawn: Vec<(&str, &str, &str, Vec<&str>)> = made
            .charts
            .iter()
            .map(|d| {
                (
                    d.chart.relation.template(d.chart.view),
                    d.chart.category.as_str(),
                    d.chart.value.as_str(),
                    d.chart.claim_ids.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            drawn,
            [
                // The value series hold one year: ranked as no change, so a bar, not a line of points at one x.
                ("horizontal_bar", "country_iso3", "value", vec!["c1", "c3"]),
                ("dumbbell", "country_iso3", "to_value", vec!["c2", "c4"]),
            ]
        );
        // Never merged: each chart lists only its own series' rows.
        assert!(made.charts[0]
            .series_rows
            .iter()
            .all(|r| r.get("value").is_some()));
        assert!(made.charts[1]
            .series_rows
            .iter()
            .all(|r| r.get("from_value").is_some() && r.get("value").is_none()));
        assert_eq!(made.charts[1].series_rows.len(), 12);
        assert_eq!(made.charts[1].axis, Axis::Country);
        // Every kept claim is on exactly one chart, in pick order.
        let mut on: Vec<&str> = made
            .charts
            .iter()
            .flat_map(|d| d.chart.claim_ids.iter().map(String::as_str))
            .collect();
        on.sort();
        let kept: Vec<&str> = made.claims.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(kept, ["c1", "c2", "c3", "c4"]);
        assert_eq!(on, kept);
        assert_eq!(made.claim_rows.len(), 4);
        assert!(made.dropped.is_empty());
        assert_eq!(made.event["template"], "horizontal_bar");
        assert_eq!(made.event["second"]["template"], "dumbbell");
        assert_eq!(made.event["second"]["start_field"], MOVE_FROM);
        // The move series leads when its claim is picked first.
        let run = move_run(&[
            ("c2", "change_largest_rise", MOVE_SERIES),
            ("c1", "rank_top", VALUE_SERIES),
        ]);
        let made = super::tests::made(&run).unwrap();
        assert_eq!(made.charts[0].chart.view, View::FirstToLast);
        assert_eq!(made.event["template"], "dumbbell");
        assert_eq!(made.event["start_field"], MOVE_FROM);
    }

    #[test]
    fn a_group_that_gives_no_chart_leaves_the_page_and_a_lone_one_skips_the_table() {
        // The move series holds a second entity column, so it fills no dumbbell: only its claims leave.
        let two_entities: &[&str] = &[
            "country_iso3",
            "siec",
            "from_value",
            "to_value",
            "change",
            "from_year",
            "to_year",
        ];
        let run = move_run(&[
            ("c1", "rank_top", VALUE_SERIES),
            ("c2", "change_largest_rise", two_entities),
            ("c3", "rank_bottom", VALUE_SERIES),
        ]);
        let made = made(&run).unwrap();
        assert_eq!(made.dropped.len(), 1);
        assert_eq!(made.dropped[0].0, ["c2"]);
        assert!(
            made.dropped[0].1.contains("one entity column"),
            "{}",
            made.dropped[0].1
        );
        let kept: Vec<&str> = made.claims.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(kept, ["c1", "c3"]);
        assert_eq!(made.claim_rows.len(), 2);
        let on: Vec<&str> = made
            .charts
            .iter()
            .flat_map(|d| d.chart.claim_ids.iter().map(String::as_str))
            .collect();
        assert_eq!(on, kept);
        assert!(made.times.iter().all(|t| t == "2024"));
        // A table whose one group gives no chart is skipped as before, with that group's reason.
        let run = move_run(&[("c2", "change_largest_rise", two_entities)]);
        let why = super::tests::made(&run).err().unwrap();
        assert!(why.contains("one entity column"), "{why}");
        // No picked claim: a reason, never an empty one.
        let why = super::tests::made(&move_run(&[])).err().unwrap();
        assert_eq!(why, "the table has no picked claim to draw");
    }

    #[test]
    fn a_slice_series_ranks_on_the_time_values_its_rows_hold() {
        let _command = crate::group_guard::command_for_test("investigate");
        let shape = SixCountries
            .shape(&SixCountries.table("t").unwrap(), "")
            .unwrap();
        let rows = |years: &[i64]| -> Vec<Value> {
            years
                .iter()
                .map(|y| json!({"country_iso3": "DEU", "value": 1, "year": y}))
                .collect()
        };
        let dims = |s: &crate::shape_registry::Shape| -> Vec<(String, usize)> {
            s.dims.iter().map(|d| (d.dim.clone(), d.members)).collect()
        };
        // One year (a level series): time does not vary, so no change is ranked for it.
        let one = series_shape(&shape, &rows(&[2024, 2024]));
        assert_eq!(dims(&one), [("geo".to_string(), 6)]);
        let matched = SixCountries.rank(&one, &FILLED_TEMPLATES, &[]);
        assert!(matched
            .candidates
            .iter()
            .all(|c| c.relation != Relation::Change));
        // Three years: time varies over those three; the table's other dimensions are kept.
        let three = series_shape(&shape, &rows(&[2022, 2023, 2024]));
        assert_eq!(
            dims(&three),
            [("geo".to_string(), 6), ("time".to_string(), 3)]
        );
        assert_eq!(
            SixCountries.rank(&three, &FILLED_TEMPLATES, &[]).candidates[0].relation,
            Relation::Change
        );
    }

    #[test]
    fn a_dumbbell_template_names_its_entity_and_both_ends() {
        let cols = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let chart = Chart {
            relation: Relation::Change,
            view: View::FirstToLast,
            claim_ids: vec!["c2".into()],
            category: "country_iso3".into(),
            value: MOVE_TO.into(),
        };
        let template = template_of(&chart, "c2", None);
        assert_eq!(template["chart_type"], "dumbbell");
        assert_eq!(
            template["fields"],
            json!({"category_field": "country_iso3", "start_field": "from_value", "end_field": "to_value"})
        );
        assert_eq!(template["category_names"], "iso3");
        assert_eq!(
            fields(Relation::Change, View::FirstToLast, &cols(MOVE_SERIES)).unwrap(),
            ("country_iso3".to_string(), "to_value".to_string())
        );
        assert!(fields(Relation::Ranking, View::FirstToLast, &cols(MOVE_SERIES)).is_err());
        assert_eq!(view_of(&cols(MOVE_SERIES)), View::FirstToLast);
        assert_eq!(view_of(&cols(VALUE_SERIES)), View::Slice);
    }

    #[test]
    fn a_source_line_names_the_publisher_the_table_and_the_years_drawn() {
        let years = |list: &[&str]| list.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert_eq!(
            source_line(
                false,
                "sdg_07_40",
                "Share of renewables ",
                &years(&["2025"])
            ),
            "欧盟统计局 sdg_07_40「Share of renewables」，2025 年"
        );
        assert_eq!(
            source_line(
                true,
                "EG.FEC.RNEW.ZS@2",
                "Renewables",
                &years(&["2015", "2023"])
            ),
            "世界银行 EG.FEC.RNEW.ZS「Renewables」，2015–2023 年"
        );
        assert_eq!(
            source_line(false, "x", "T", &years(&["2024-01", "2024-06"])),
            "欧盟统计局 x「T」，2024-01–2024-06"
        );
        assert_eq!(source_line(false, "x", "T", &[]), "欧盟统计局 x「T」");
        assert_eq!(source_line(false, "x", " ", &[]), "欧盟统计局 x");
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
                let codes = |pairs: &[(&str, &str)]| {
                    pairs
                        .iter()
                        .map(|(c, l)| (c.to_string(), l.to_string()))
                        .collect()
                };
                (id == "t").then(|| crate::l5geo::TableMeta {
                    id: id.into(),
                    worldbank: false,
                    end_year: None,
                    places: Vec::new(),
                    place_members: Vec::new(),
                    freqs: Vec::new(),
                    unit: None,
                    dims: vec![
                        (
                            "nrg_bal".into(),
                            codes(&[
                                ("REN", "Renewable energy - overall"),
                                ("REN_TRA", "Renewable energy - transport"),
                            ]),
                        ),
                        ("unit".into(), codes(&[("PC", "Percentage")])),
                    ],
                })
            }
        }
        let table = |title: &str, filters: Value| Prepared {
            id: "t".into(),
            title: title.into(),
            file: String::new(),
            args: json!({"filters": filters}).as_object().unwrap().clone(),
            sheet: String::new(),
            claims: Vec::new(),
            places_zh: Vec::new(),
            companions: Vec::new(),
        };
        let by_sector = "Share of renewable energy by sector";
        let one = json!([{"dimension": "nrg_bal", "values": ["REN"]}, {"dimension": "unit", "values": ["PC"]}, {"dimension": "geo", "values": ["SE"]}]);
        assert_eq!(
            measure_name(&table(by_sector, one.clone()), &OneTable),
            "Share of renewable energy (Renewable energy - overall)"
        );
        let both = json!([{"dimension": "nrg_bal", "values": ["REN", "REN_TRA"]}, {"dimension": "unit", "values": ["PC"]}]);
        assert_eq!(measure_name(&table(by_sector, both), &OneTable), by_sector);
        assert_eq!(
            measure_name(&table("Share of renewable energy", one), &OneTable),
            "Share of renewable energy"
        );
    }

    #[test]
    fn a_world_bank_measure_takes_its_registered_unit_and_a_eurostat_one_its_unit_filter() {
        struct Two;
        impl Catalogue for Two {
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
                let worldbank = id.ends_with("@2");
                Some(crate::l5geo::TableMeta {
                    id: id.into(),
                    worldbank,
                    dims: if worldbank {
                        Vec::new()
                    } else {
                        vec![("unit".into(), vec![("PC".into(), "Percentage".into())])]
                    },
                    end_year: None,
                    places: Vec::new(),
                    place_members: Vec::new(),
                    freqs: Vec::new(),
                    unit: worldbank.then(|| crate::l5geo::Unit {
                        code: "PC_POP".into(),
                        label: "Percentage of total population".into(),
                        kind: Some("share"),
                    }),
                })
            }
        }
        let table = |id: &str, filters: Value| Prepared {
            id: id.into(),
            title: "T".into(),
            file: String::new(),
            args: json!({"filters": filters}).as_object().unwrap().clone(),
            sheet: String::new(),
            claims: Vec::new(),
            places_zh: Vec::new(),
            companions: Vec::new(),
        };
        let unit = |t: &Prepared| {
            let m = measure_of(t, &Two, &[], Axis::Country);
            (m.unit_code, m.unit_label, m.kind)
        };
        assert_eq!(
            unit(&table("SP.POP.65UP.TO.ZS@2", json!([]))),
            (
                Some("PC_POP".into()),
                Some("Percentage of total population".into()),
                Some("share")
            )
        );
        let pc = json!([{"dimension": "unit", "values": ["PC"]}]);
        assert_eq!(
            unit(&table("t", pc)),
            (Some("PC".into()), Some("Percentage".into()), Some("share"))
        );
        assert_eq!(unit(&table("t", json!([]))), (None, None, None));
    }

    #[test]
    fn only_a_table_fetched_in_a_ratio_unit_may_go_on_a_map() {
        let table = |filters: Value| Prepared {
            id: "t".into(),
            title: String::new(),
            file: String::new(),
            args: json!({"filters": filters}).as_object().unwrap().clone(),
            sheet: String::new(),
            claims: Vec::new(),
            places_zh: Vec::new(),
            companions: Vec::new(),
        };
        let unit = |codes: &[&str]| table(json!([{"dimension": "unit", "values": codes}]));
        assert!(
            maps_a_ratio(&unit(&["PC"]))
                && maps_a_ratio(&unit(&["RT"]))
                && maps_a_ratio(&unit(&["I15_A_AVG"]))
        );
        assert!(
            !maps_a_ratio(&unit(&["KTOE"]))
                && !maps_a_ratio(&unit(&["THS_PER"]))
                && !maps_a_ratio(&unit(&["KG_HAB"]))
        );
        assert!(!maps_a_ratio(&unit(&["PC", "KTOE"])) && !maps_a_ratio(&table(json!([]))));
        // The data side's unit kinds of six local tables (unit_kinds.json): every level code stays off the map; the per-inhabitant
        // and EU27-average codes are not read yet, so they stay off too (a bar, not a guess).
        for code in [
            "GWH",
            "KTOE",
            "TJ",
            "MIO_T",
            "THS_T",
            "PER",
            "MIO_EUR",
            "MIO_NAC",
            "MIO_PPS_EU27_2020",
            "EUR_HAB",
            "PPS_EU27_2020_HAB",
            "EUR_HAB_EU27_2020",
        ] {
            assert!(!maps_a_ratio(&unit(&[code])), "{code}");
        }
        // Only the unit dimension is read: TJ under geo is a country, not terajoules, and a code under another dimension is no unit.
        assert!(!maps_a_ratio(&table(
            json!([{"dimension": "geo", "values": ["TJ"]}, {"dimension": "indic_et", "values": ["PC_IMP_EU"]}])
        )));
    }

    #[test]
    fn a_narrowed_table_gets_its_scope_and_selection_line_from_the_narrow_record() {
        let dir = tempfile::tempdir().unwrap();
        let origins = dir.path().join("data/origins");
        std::fs::create_dir_all(&origins).unwrap();
        let table = Prepared {
            id: "EN.GHG.CO2.PC.CE.AR5@2".into(),
            title: "CO2 per capita".into(),
            file: "data/narrowed.csv".into(),
            args: Map::new(),
            sheet: String::new(),
            claims: Vec::new(),
            places_zh: Vec::new(),
            companions: Vec::new(),
        };
        assert_eq!(narrowed(dir.path(), &table), Ok(None), "no origins folder");
        let members = json!(["IND", "CHN", "USA", "IDN", "PAK", "NGA", "BRA"]);
        let write = |name: &str, record: Value| {
            std::fs::write(origins.join(name), record.to_string()).unwrap();
        };
        write(
            "a.json",
            json!({"origin": "worldbank_json_conversion", "file": "data/narrowed.csv"}),
        );
        write(
            "b.json",
            json!({"origin": "worldbank_narrow", "file": "data/other.csv", "option": "top", "members": members.clone(), "at": "2024"}),
        );
        assert_eq!(
            narrowed(dir.path(), &table),
            Ok(None),
            "no record narrows this file"
        );
        write(
            "c.json",
            json!({"origin": "worldbank_narrow", "file": "data/narrowed.csv", "option": "SP.POP.TOTL",
            "members": members.clone(), "at": "2024"}),
        );
        // The count is the members the record keeps (7 here), not the registry's cap.
        assert_eq!(
            narrowed(dir.path(), &table),
            Ok(Some((
                Scope {
                    text: "在人口最多的7个经济体中".into(),
                    record: "data/origins/c.json".into()
                },
                "按人口取前 7 个经济体（世界银行 SP.POP.TOTL，2024 年）".into()
            )))
        );
        write(
            "d.json",
            json!({"origin": "worldbank_narrow", "file": "data/narrowed.csv", "option": "top", "members": members.clone(), "at": 2024}),
        );
        assert!(narrowed(dir.path(), &table)
            .unwrap_err()
            .contains("both narrow"));
        std::fs::remove_file(origins.join("d.json")).unwrap();
        write(
            "c.json",
            json!({"origin": "worldbank_narrow", "file": "data/narrowed.csv", "option": "XX", "members": members.clone(), "at": "2024"}),
        );
        assert!(narrowed(dir.path(), &table)
            .unwrap_err()
            .contains("not in wb-rank-by.json"));
        write(
            "c.json",
            json!({"origin": "worldbank_narrow", "file": "data/narrowed.csv", "option": "top", "members": [], "at": "2024"}),
        );
        assert!(narrowed(dir.path(), &table)
            .unwrap_err()
            .contains("no members"));
        write(
            "c.json",
            json!({"origin": "worldbank_narrow", "file": "data/narrowed.csv", "option": "bottom", "members": members.clone(), "at": 2024}),
        );
        assert_eq!(
            narrowed(dir.path(), &table).unwrap().unwrap().1,
            "按 2024 年本指标取最低的 7 个经济体"
        );
    }

    /// A ranking run: rank_top SE, rank_bottom BE, their gap and ratio, all of 2025, over a six-country series of shares.
    fn ranking_run() -> (tempfile::TempDir, Page, BTreeMap<Target, String>) {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        std::fs::create_dir_all(run.join("computations")).unwrap();
        let shares = [
            ("SE", 65.4),
            ("FI", 50.8),
            ("DK", 44.4),
            ("DE", 22.4),
            ("FR", 22.3),
            ("BE", 14.9),
        ];
        let rows: Vec<Value> = shares
            .iter()
            .map(|(code, value)| json!({"country_iso2": code, "value": value, "year": 2025}))
            .collect();
        std::fs::write(
            run.join("computations/a1b2c3d4e5f6a7b8.json"),
            json!({"columns": ["country_iso2", "value", "year"], "rows": rows}).to_string(),
        )
        .unwrap();
        let bound = |column: &str, value: Value, text: &str| json!({"column": column, "value": value, "text": text});
        let claims = [
            (
                "c1",
                "rank_top",
                vec![
                    bound("country_iso2", json!("SE"), "SE"),
                    bound("value", json!(65.4), "65.4"),
                ],
            ),
            (
                "c2",
                "rank_bottom",
                vec![
                    bound("country_iso2", json!("BE"), "BE"),
                    bound("value", json!(14.9), "14.9"),
                ],
            ),
            ("c3", "extreme_gap", vec![bound("gap", json!(50.5), "50.5")]),
            (
                "c4",
                "top_to_bottom_ratio",
                vec![bound("ratio", json!(4.4), "4.4")],
            ),
        ];
        let mut lines = String::new();
        for (id, _, bindings) in &claims {
            let mut bindings = bindings.clone();
            bindings.push(bound("year", json!(2025), "2025"));
            lines.push_str(&format!(
                "{}\n",
                json!({"claim_id": id, "claim_bindings": bindings,
                    "computation_refs": [format!("computations/{id}-own.json"), "computations/a1b2c3d4e5f6a7b8.json"]})
            ));
        }
        std::fs::write(run.join("claims.jsonl"), lines).unwrap();
        let page = Page {
            claims: claims
                .iter()
                .map(|(id, kind, _)| Claim {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    template: String::new(),
                })
                .collect(),
            charts: vec![Chart {
                relation: Relation::Ranking,
                view: View::Slice,
                claim_ids: claims.iter().map(|(id, _, _)| id.to_string()).collect(),
                category: "country_iso2".into(),
                value: "value".into(),
            }],
            templates: Vec::new(),
            sentences: BTreeMap::new(),
            places: Vec::new(),
            times: Vec::new(),
            measures: vec![next_pack::Measure {
                title: "Renewables share, SDG 7.2".into(),
                name: "Renewables share, SDG 7.2".into(),
                unit_code: Some("PC".into()),
                unit_label: Some("Percentage".into()),
                kind: None,
                times: vec!["2025".into()],
                axis: Axis::Country,
                source: None,
            }],
            plans: Vec::new(),
            scopes: vec![None],
        };
        let fields = BTreeMap::from([
            (Target::PageTitle, "瑞典领跑可再生能源".to_string()),
            (Target::PageDek, "北欧国家占比居前".to_string()),
            (Target::Measure(0), "可再生能源占比排名".to_string()),
            (Target::Heading(0), "{min.country_iso2}垫底".to_string()),
            (
                Target::Body(0),
                "{max.country_iso2}以{max.value}居首，{min.country_iso2}只有{min.value}"
                    .to_string(),
            ),
            (
                Target::HeroLabel {
                    claim_id: "c1".into(),
                    value_from: "first.value".into(),
                },
                "{first.year}年，{first.country_iso2}可再生能源占比最高".to_string(),
            ),
        ]);
        (dir, page, fields)
    }

    /// Every piece of text a spec prints between its numbers and names.
    fn spec_texts(spec: &PageSpec) -> Vec<&str> {
        let mut lines: Vec<&Vec<Seg>> = vec![&spec.kicker];
        let mut units: Vec<&Seg> = Vec::new();
        if let Some(hero) = &spec.hero {
            lines.push(&hero.label);
            units.push(&hero.unit);
        }
        lines.extend(&spec.body);
        for Card::Bar(card) in &spec.cards {
            lines.push(&card.eyebrow);
            lines.push(&card.subtitle);
            lines.extend(&card.bracket);
            lines.push(&card.source);
            units.push(&card.unit);
        }
        let rows = spec
            .cards
            .iter()
            .flat_map(|Card::Bar(c)| c.rows.iter().map(|r| &r.label));
        lines
            .into_iter()
            .flatten()
            .chain(rows)
            .chain(units)
            .filter_map(|s| match s {
                Seg::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_ranking_spec_reads_every_number_and_year_from_a_binding_or_a_series_row() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (dir, page, fields) = ranking_run();
        let spec = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap();
        let nums: Vec<(&str, &str)> = spec
            .nums()
            .iter()
            .map(|n| (n.src.as_str(), n.text.as_str()))
            .collect();
        let row = |code: &'static str, text: &'static str| -> (String, &'static str) {
            (format!("series:a1b2c3d4e5f6:{code}:value"), text)
        };
        let mut want: Vec<(String, &str)> = vec![
            ("c1:value".into(), "65.4"),
            ("c1:year".into(), "2025"),
            ("c1:value".into(), "65.4"),
            ("c2:value".into(), "14.9"),
            ("c1:year".into(), "2025"),
        ];
        want.push(row("SE", "65.4"));
        want.push(("c1:value".into(), "65.4"));
        want.extend([
            row("FI", "50.8"),
            row("DK", "44.4"),
            row("DE", "22.4"),
            row("FR", "22.3"),
            row("BE", "14.9"),
        ]);
        want.push(("c2:value".into(), "14.9"));
        want.push(("c3:gap".into(), "50.5"));
        want.push(("c4:ratio".into(), "4.4"));
        want.push(("series:a1b2c3d4e5f6:SE:year".into(), "2025"));
        let want: Vec<(&str, &str)> = want.iter().map(|(s, t)| (s.as_str(), *t)).collect();
        assert_eq!(nums, want);

        let Some(Card::Bar(card)) = spec.cards.first() else {
            unreachable!()
        };
        assert_eq!(card.unit, Seg::Text("%".into()));
        assert_eq!(card.lead.as_deref(), Some("SE"));
        assert_eq!(card.bracket[0].last(), Some(&Seg::Text("个百分点".into())));
        assert_eq!(spec.hero.as_ref().unwrap().unit, Seg::Text("%".into()));
        assert_eq!(spec.refs, ["t"]);
        // No scope: the measure's name above the title, nothing above the card's.
        assert_eq!(spec.kicker, [Seg::Text("可再生能源占比排名".into())]);
        assert_eq!(
            (card.eyebrow.len(), card.title.as_str()),
            (0, "可再生能源占比排名")
        );
        // The measure's title holds a digit, so it is a label read from the catalogue, never words.
        assert!(card.source.contains(&Seg::Label(Label {
            src: format!("{LABEL_SRC}catalogue:t:title"),
            text: "Renewables share, SDG 7.2".into(),
        })));
        // No exemption: not one digit is printed outside a number or a label.
        let texts = spec_texts(&spec);
        assert!(
            texts.contains(&"个百分点") && texts.contains(&"倍"),
            "{texts:?}"
        );
        for text in texts {
            assert!(
                !text.chars().any(|c| c.is_ascii_digit()),
                "a digit in the words {text:?}"
            );
        }
    }

    #[test]
    fn a_ranking_spec_stops_on_a_missing_binding_or_a_text_naming_no_claim() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (dir, page, mut fields) = ranking_run();
        fields.insert(Target::Body(0), "{max.gap}".into());
        let err = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap_err();
        assert!(err.contains("c1 has no recorded binding for gap"), "{err}");
        fields.insert(Target::Body(0), "{mid.value}".into());
        let err = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap_err();
        assert!(err.contains("the page has no claim for mid"), "{err}");
    }

    #[test]
    fn a_ranking_spec_puts_the_scope_above_the_page_and_its_card_with_the_count_read_from_its_record(
    ) {
        let _command = crate::group_guard::command_for_test("investigate");
        let (dir, mut page, fields) = ranking_run();
        let origins = dir.path().join("data/origins");
        std::fs::create_dir_all(&origins).unwrap();
        let members = json!(["SE", "FI", "DK", "DE", "FR", "BE", "PL"]);
        std::fs::write(
            origins.join("n.json"),
            json!({"origin": NARROW_ORIGIN, "file": "data/t.csv", "option": "bottom",
                "members": members, "at": "2024"})
            .to_string(),
        )
        .unwrap();
        let option = next_params::wb_rank_by()
            .1
            .iter()
            .find(|o| o.key == "bottom")
            .unwrap();
        let (before, after) = option.zh_scope.split_once("{n}").unwrap();
        let rel = "data/origins/n.json";
        page.scopes = vec![Some(Scope {
            text: option.zh_scope.replace("{n}", "7"),
            record: rel.into(),
        })];
        let spec = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap();
        let count = Num {
            src: format!("{rel}:members"),
            value: 7.0,
            text: "7".into(),
        };
        let mut want = Vec::new();
        for words in [before, after].into_iter().filter(|w| !w.is_empty()) {
            want.push(Seg::Text(words.into()));
        }
        want.insert(usize::from(!before.is_empty()), Seg::Num(count.clone()));
        assert_eq!(spec.kicker, want);
        let Some(Card::Bar(card)) = spec.cards.first() else {
            unreachable!()
        };
        assert_eq!(card.eyebrow, want);
        // The selection line follows the source, its rank year and count read from the record too.
        let at = Num {
            src: format!("{rel}:at"),
            value: 2024.0,
            text: "2024".into(),
        };
        let line = narrow_segs(rel, &option.zh_line, 7, "2024", None).unwrap();
        assert!(line.contains(&Seg::Num(at)) && line.contains(&Seg::Num(count.clone())));
        assert_eq!(
            card.source[card.source.len() - line.len() - 1..][0],
            Seg::Text("；".into())
        );
        assert!(card.source.ends_with(&line));
        assert_eq!(spec.refs, ["t"]);
        // The count is printed as a number from the record, above the page, above its card and in its line, in page order.
        let nums = spec.nums();
        assert_eq!(nums.first(), Some(&&count));
        assert_eq!(nums.iter().filter(|n| ***n == count).count(), 3);

        // Ranked by another indicator: its id goes on the page's refs, the table id the line names.
        std::fs::write(
            origins.join("n.json"),
            json!({"origin": NARROW_ORIGIN, "file": "data/t.csv", "option": "SP.POP.TOTL",
                "members": members, "at": "2024"})
            .to_string(),
        )
        .unwrap();
        let by_population = next_params::wb_rank_by()
            .1
            .iter()
            .find(|o| o.key == "SP.POP.TOTL")
            .unwrap();
        page.scopes = vec![Some(Scope {
            text: by_population.zh_scope.replace("{n}", "7"),
            record: rel.into(),
        })];
        let spec = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap();
        assert_eq!(spec.refs, ["t", "SP.POP.TOTL"]);
        let Some(Card::Bar(card)) = spec.cards.first() else {
            unreachable!()
        };
        assert!(card.source.contains(&Seg::Ref("SP.POP.TOTL".into())));
        // A scope the record does not give (another count) stops the spec.
        page.scopes = vec![Some(Scope {
            text: option.zh_scope.replace("{n}", "8"),
            record: rel.into(),
        })];
        let err = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap_err();
        assert!(err.contains("does not give the scope"), "{err}");
        // No scope: no number read from a narrow record.
        page.scopes = vec![None];
        assert!(
            ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
                .unwrap()
                .nums()
                .iter()
                .all(|n| !n.src.starts_with("data/origins/"))
        );
    }

    #[test]
    fn every_registered_narrow_option_prints_its_words_with_numbers_and_ids_read_from_the_record() {
        let text = |segs: &[Seg]| -> String {
            segs.iter()
                .map(|s| match s {
                    Seg::Text(t) | Seg::Ref(t) => t.clone(),
                    Seg::Num(n) => n.text.clone(),
                    Seg::Label(l) => l.text.clone(),
                })
                .collect()
        };
        let rel = "data/origins/n.json";
        for o in &next_params::wb_rank_by().1 {
            let by = o.by.as_deref();
            for template in [&o.zh_scope, &o.zh_line] {
                let segs = narrow_segs(rel, template, 7, "2024", by).unwrap();
                assert_eq!(
                    text(&segs),
                    template.replace("{n}", "7").replace("{at}", "2024"),
                    "{}",
                    o.key
                );
                for seg in &segs {
                    match seg {
                        Seg::Text(t) => assert!(!t.chars().any(|c| c.is_ascii_digit()), "{t:?}"),
                        Seg::Num(n) => assert!(
                            [format!("{rel}:members"), format!("{rel}:at")].contains(&n.src),
                            "{n:?}"
                        ),
                        Seg::Ref(id) => assert_eq!(Some(id.as_str()), by),
                        Seg::Label(_) => unreachable!(),
                    }
                }
            }
            // The indicator a line ranks by is a table id of the page.
            if let Some(by) = by {
                let line = narrow_segs(rel, &o.zh_line, 7, "2024", Some(by)).unwrap();
                assert!(line.contains(&Seg::Ref(by.into())), "{}", o.key);
            }
        }
        // A year that is not a number, or words with a digit or another placeholder, stop.
        assert!(narrow_segs(rel, "按 {at} 年", 7, "", None).is_err());
        assert!(narrow_segs(rel, "前 {n} 个（共 8 个）", 7, "2024", None).is_err());
        assert!(narrow_segs(rel, "前 {n} 个 {m}", 7, "2024", None).is_err());
        // A scope with no year does not need one.
        assert!(narrow_segs(rel, "前{n}个", 7, "", None).is_ok());
    }

    #[test]
    fn a_unit_with_a_digit_is_a_name_read_from_its_row_never_words() {
        // A short form: words, or a name of the registry's row when it holds a digit.
        assert_eq!(unit_seg("t", Some("PC"), None), Ok(Seg::Text("%".into())));
        assert_eq!(
            unit_seg("t", Some("P_HTHAB"), Some("Per 100 000 inhabitants")),
            Ok(Seg::Text("每十万人".into()))
        );
        assert_eq!(
            unit_seg("t", Some("I10"), Some("Index, 2010=100")),
            Ok(Seg::Label(Label {
                src: format!("{LABEL_SRC}{}:I10", next_pack::UNIT_SHORT_ZH_TABLE),
                text: "指数(2010=100)".into(),
            }))
        );
        // No short form: the catalogue's label of the table, a name when it holds a digit.
        assert_eq!(
            unit_seg("t", Some("X_UNREG"), Some(" Per 100 000 inhabitants ")),
            Ok(Seg::Label(Label {
                src: format!("{LABEL_SRC}catalogue:t:unit"),
                text: "Per 100 000 inhabitants".into(),
            }))
        );
        assert_eq!(
            unit_seg("t", Some("X_UNREG"), Some("Tonnes")),
            Ok(Seg::Text("Tonnes".into()))
        );
        // As the pack: no unit code, or no text at all, stops.
        assert!(unit_seg("t", None, Some("Tonnes")).is_err());
        assert!(unit_seg("t", Some("X_UNREG"), Some(" ")).is_err());
        // A difference of percentages is in points; any other unit stays itself.
        assert_eq!(
            diff_unit(&Seg::Text("%".into())),
            Seg::Text("个百分点".into())
        );
        let label = unit_seg("t", Some("I10"), None).unwrap();
        assert_eq!(diff_unit(&label), label);
    }

    #[test]
    fn a_ranking_spec_prints_a_unit_with_a_digit_as_a_label_after_every_value() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (dir, mut page, fields) = ranking_run();
        page.measures[0].unit_code = Some("X_UNREG".into());
        page.measures[0].unit_label = Some("Per 100 000 inhabitants".into());
        let spec = ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
            .unwrap();
        let unit = Seg::Label(Label {
            src: format!("{LABEL_SRC}catalogue:t:unit"),
            text: "Per 100 000 inhabitants".into(),
        });
        let Some(Card::Bar(card)) = spec.cards.first() else {
            unreachable!()
        };
        assert_eq!(
            (&card.unit, &spec.hero.as_ref().unwrap().unit),
            (&unit, &unit)
        );
        // After {max.value} and {min.value} in the body, and after the gap.
        assert_eq!(spec.body[0].iter().filter(|s| **s == unit).count(), 2);
        assert_eq!(card.bracket[0].last(), Some(&unit));
        for text in spec_texts(&spec) {
            assert!(
                !text.chars().any(|c| c.is_ascii_digit()),
                "a digit in the words {text:?}"
            );
        }
    }

    /// The ranking spec of a stored stand-in run (q1, sdg_07_40) against the ledger the page prototype printed from it: the same
    /// sources with the same texts, besides the years, which the prototype printed as words and the spec reads from the data.
    ///     NEXT_RANKING_RUN=<run dir> NEXT_RANKING_LEDGER=<ledger json> cargo test a_stored_ranking -- --include-ignored
    /// Pinned from node: candidateValueText (claim_candidates.mjs) run on each value. Ties take the larger magnitude on the
    /// value's exact expansion (1.25 -> 1.3, 0.125 -> 0.13), and a value just below a tie in binary rounds down (22.45 -> 22.4).
    #[test]
    fn a_series_value_prints_as_a_claim_binding_prints_it() {
        let text = |v: Value| value_text(v.as_number().unwrap());
        for (v, want) in [
            ("53", "53"),
            ("2025", "2025"),
            ("53.0", "53"),
            ("-0.0", "0"),
            ("29.9940966737423", "30.0"),
            ("23.7031981458429", "23.7"),
            ("65.4", "65.4"),
            ("22.45", "22.4"),
            ("14.95", "14.9"),
            ("10.35", "10.3"),
            ("1.25", "1.3"),
            ("-1.25", "-1.3"),
            ("999.95", "1000.0"),
            ("0.125", "0.13"),
            ("-0.125", "-0.13"),
            ("0.0512", "0.051"),
            ("0.7", "0.7"),
            ("0.995", "0.99"),
            ("0.00000125", "0.0000013"),
            ("9.96e-7", "0.000001"),
            ("9.5e-7", "9.5e-7"),
            ("1.2e-7", "1.2e-7"),
            ("-1.25e-8", "-1.2e-8"),
            ("1.05e-7", "1.1e-7"),
        ] {
            assert_eq!(text(serde_json::from_str(v).unwrap()), want, "{v}");
        }
    }

    /// The same against a sweep of values node printed (one `value<TAB>text` per line; two-place values from 10 to 1000 and
    /// both signs, four-place values below 1, values below a millionth):
    ///     NEXT_VALUE_TEXT_CASES=<tsv> cargo test every_value_node_printed -- --include-ignored
    #[test]
    #[ignore = "needs NEXT_VALUE_TEXT_CASES"]
    fn every_value_node_printed_prints_alike() {
        let path = std::env::var("NEXT_VALUE_TEXT_CASES").expect("NEXT_VALUE_TEXT_CASES");
        let cases = std::fs::read_to_string(path).unwrap();
        let mut off = vec![];
        for line in cases.lines() {
            let (v, want) = line.split_once('\t').unwrap();
            let got = value_text(&serde_json::from_str::<serde_json::Number>(v).unwrap());
            if got != want {
                off.push(format!("{v}: node {want}, here {got}"));
            }
        }
        assert!(
            off.is_empty(),
            "{} of {} differ: {:?}",
            off.len(),
            cases.lines().count(),
            &off[..off.len().min(20)]
        );
    }

    /// Every number a stored run could print (each claim's recorded bindings and every value of the computations its claims
    /// read, a series row printed as value_text prints it), all on one page through the visual group's command: what the
    /// page check refuses on any of them is a refusal after the data was in. Prints one line per run.
    ///     NEXT_REPLAY_RUNS=<run dir>,<run dir>.. cargo test every_number_a_stored_run -- --include-ignored --nocapture
    #[test]
    #[ignore = "needs NEXT_REPLAY_RUNS"]
    fn every_number_a_stored_run_could_print_goes_on_one_page() {
        let _command = crate::group_guard::command_for_test("investigate");
        let runs = std::env::var("NEXT_REPLAY_RUNS").expect("NEXT_REPLAY_RUNS");
        let mut refused = 0;
        for run in runs.split(',').map(std::path::PathBuf::from) {
            let records = claim_records(&run).unwrap();
            let (mut nums, mut seen) = (vec![], BTreeSet::new());
            for (id, record) in &records {
                for b in record["claim_bindings"].as_array().into_iter().flatten() {
                    if let (Some(column), Some(_), Some(_)) = (
                        b["column"].as_str(),
                        b["value"].as_f64(),
                        b["text"].as_str(),
                    ) {
                        nums.push(claim_num(id, record, column).unwrap());
                    }
                }
                for (n, r) in record["computation_refs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    if !seen.insert(r.as_str().unwrap_or("").to_string()) {
                        continue;
                    }
                    let Ok(c) = computation(&run, record, n) else {
                        continue;
                    };
                    let ref_id: String = r
                        .as_str()
                        .unwrap_or("")
                        .rsplit('/')
                        .next()
                        .unwrap_or("")
                        .chars()
                        .take(12)
                        .collect();
                    for (i, row) in c["rows"].as_array().into_iter().flatten().enumerate() {
                        for (column, v) in row.as_object().into_iter().flatten() {
                            if v.is_number() {
                                nums.push(row_num(&ref_id, &i.to_string(), row, column).unwrap());
                            }
                        }
                    }
                }
            }
            let spec = PageSpec {
                accent: "#c8553d".into(),
                kicker: vec![],
                title: "t".into(),
                dek: String::new(),
                hero: None,
                body: vec![nums
                    .iter()
                    .flat_map(|n| [Seg::Num(n.clone()), Seg::Text("、".into())])
                    .collect()],
                cards: vec![],
                refs: vec![],
            };
            let errors = match crate::group_guard::as_visual_call(|| {
                crate::next_visual::call(crate::next_visual::Request::Page { spec: &spec })
            }) {
                Ok(_) => vec![],
                Err(e) => e.lines().map(str::to_string).collect::<Vec<_>>(),
            };
            refused += errors.len();
            println!(
                "{}\tclaims {}\tnumbers {}\trefused {}\t{:?}",
                run.display(),
                records.len(),
                nums.len(),
                errors.len(),
                &errors[..errors.len().min(5)]
            );
        }
        assert_eq!(refused, 0);
    }

    /// The page for a spec drawn through the visual group's command, which checks it against the ledger it came back with;
    /// written to NEXT_PAGE_OUT when set, to be looked at.
    fn stored_page(spec: &PageSpec) -> crate::next_render::Rendered {
        let page = match crate::group_guard::as_visual_call(|| {
            crate::next_visual::call(crate::next_visual::Request::Page { spec })
        }) {
            Ok(crate::next_visual::Reply::Page(page)) => page,
            Ok(_) => unreachable!("the visual group answered a page with another reply"),
            Err(e) => panic!("{e}"),
        };
        if let Ok(out) = std::env::var("NEXT_PAGE_OUT") {
            std::fs::write(out, &page.html).unwrap();
        }
        page
    }

    struct WorldBank;

    impl Catalogue for WorldBank {
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
            Some(crate::l5geo::TableMeta {
                worldbank: true,
                ..SixCountries.table(id)?
            })
        }
    }

    // A second topic through the same nodes: a World Bank ranking of eight economies (q5, its share aged 65 and above).
    #[test]
    #[ignore]
    fn a_stored_world_bank_ranking_run_draws_its_page() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = std::path::PathBuf::from(std::env::var("NEXT_WB_RANKING_RUN").unwrap());
        let worded = read_json(&run, "runtime/next-page.json").unwrap()["worded"].clone();
        let (top, bottom) = ("claim-1eb19a3841ee7437", "claim-b7c715e09a0075da");
        let targets = [
            Target::PageTitle,
            Target::PageDek,
            Target::Measure(1),
            Target::Heading(1),
            Target::Body(1),
            Target::HeroLabel {
                claim_id: top.into(),
                value_from: "first.value".into(),
            },
        ];
        let fields: BTreeMap<Target, String> = targets
            .into_iter()
            .filter_map(|t| Some((t.clone(), worded[format!("{t:?}")].as_str()?.to_string())))
            .collect();
        let chart = |relation, view, ids: &[&str]| Chart {
            relation,
            view,
            claim_ids: ids.iter().map(|id| id.to_string()).collect(),
            category: "country_iso3".into(),
            value: "value".into(),
        };
        let title = "Population ages 65 and above (% of total population)";
        let measure = next_pack::Measure {
            title: title.into(),
            name: title.into(),
            unit_code: Some("PC_POP".into()),
            unit_label: Some("Percentage of total population".into()),
            kind: None,
            times: vec!["2025".into()],
            axis: Axis::Country,
            source: None,
        };
        let page = Page {
            claims: [(top, "rank_top"), (bottom, "rank_bottom")]
                .iter()
                .map(|(id, kind)| Claim {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    template: String::new(),
                })
                .collect(),
            charts: vec![
                chart(Relation::Change, View::FirstToLast, &[]),
                chart(Relation::Ranking, View::Slice, &[top, bottom]),
            ],
            templates: Vec::new(),
            sentences: BTreeMap::new(),
            places: Vec::new(),
            times: Vec::new(),
            measures: vec![measure.clone(), measure],
            plans: Vec::new(),
            scopes: vec![None, None],
        };
        let spec = ranking_page_spec(
            &run,
            &page,
            1,
            &fields,
            "SP.POP.65UP.TO.ZS@2",
            &WorldBank,
            "#c8553d",
        )
        .unwrap();
        let page = stored_page(&spec);
        let Card::Bar(card) = &spec.cards[0];
        assert_eq!(card.rows.len(), 8);
        for row in &card.rows {
            assert_eq!(page.ledger.get(&row.value.src), Some(&row.value.text));
        }
        for id in [top, bottom] {
            assert!(page.ledger.keys().any(|k| k.starts_with(id)), "{id}");
        }
        assert!(page.html.contains("世界银行"));
    }

    #[test]
    #[ignore]
    fn a_stored_ranking_run_prints_the_numbers_of_its_ledger() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = std::path::PathBuf::from(std::env::var("NEXT_RANKING_RUN").unwrap());
        let ledger: BTreeMap<String, String> = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("NEXT_RANKING_LEDGER").unwrap()).unwrap(),
        )
        .unwrap();
        let worded = read_json(&run, "runtime/next-page.json").unwrap()["worded"].clone();
        let kinds = [
            ("claim-9e407e41cedd29b0", "rank_top"),
            ("claim-5375de5d6720000c", "rank_bottom"),
            ("claim-9dfb4e7ae9844e2d", "extreme_gap"),
            ("claim-54c38def34b0d2b8", "top_to_bottom_ratio"),
        ];
        let targets = [
            Target::PageTitle,
            Target::PageDek,
            Target::Measure(1),
            Target::Heading(1),
            Target::Body(1),
            Target::HeroLabel {
                claim_id: kinds[0].0.into(),
                value_from: "first.value".into(),
            },
        ];
        let fields: BTreeMap<Target, String> = targets
            .into_iter()
            .filter_map(|t| Some((t.clone(), worded[format!("{t:?}")].as_str()?.to_string())))
            .collect();
        // As the run's sheet placed them: the gap on the bars, the rest on the map of the same series.
        let chart = |relation, ids: &[&str]| Chart {
            relation,
            view: View::Slice,
            claim_ids: ids.iter().map(|id| id.to_string()).collect(),
            category: "country_iso2".into(),
            value: "value".into(),
        };
        let title = "Share of renewable energy in gross final energy consumption";
        let measure = next_pack::Measure {
            title: title.into(),
            name: title.into(),
            unit_code: Some("PC".into()),
            unit_label: Some("Percentage".into()),
            kind: None,
            times: vec!["2025".into()],
            axis: Axis::Country,
            source: None,
        };
        let page = Page {
            claims: kinds
                .iter()
                .map(|(id, kind)| Claim {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    template: String::new(),
                })
                .collect(),
            charts: vec![
                chart(Relation::Map, &[kinds[0].0, kinds[1].0, kinds[3].0]),
                chart(Relation::Ranking, &[kinds[2].0]),
            ],
            templates: Vec::new(),
            sentences: BTreeMap::new(),
            places: Vec::new(),
            times: Vec::new(),
            measures: vec![measure.clone(), measure],
            plans: Vec::new(),
            scopes: vec![None, None],
        };
        let spec = ranking_page_spec(
            &run,
            &page,
            1,
            &fields,
            "sdg_07_40",
            &SixCountries,
            "#c8553d",
        )
        .unwrap();
        let mut printed = BTreeMap::new();
        for n in spec.nums() {
            if n.src.ends_with(":year") {
                assert_eq!(n.text, "2025", "{}", n.src);
            } else if let Some(text) = printed.insert(n.src.clone(), n.text.clone()) {
                assert_eq!(text, n.text, "{} printed two ways", n.src);
            }
        }
        assert_eq!(printed, ledger);
        let page = stored_page(&spec);
        let drawn: BTreeMap<String, String> = page
            .ledger
            .into_iter()
            .filter(|(src, _)| !src.starts_with(LABEL_SRC) && !src.ends_with(":year"))
            .collect();
        let missing: Vec<&String> = ledger.keys().filter(|k| !drawn.contains_key(*k)).collect();
        eprintln!(
            "drawn {}/{} of the ledger; missing {missing:?}",
            ledger.len() - missing.len(),
            ledger.len()
        );
        assert!(
            drawn.iter().all(|(k, v)| ledger.get(k) == Some(v)),
            "{drawn:?}"
        );
    }

    #[test]
    fn a_ranking_spec_takes_each_claim_of_its_series_once_wherever_the_sheet_placed_it() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (dir, page, fields) = ranking_run();
        let one_chart =
            ranking_page_spec(dir.path(), &page, 0, &fields, "t", &SixCountries, "#c8553d")
                .unwrap();
        // A map of the same rows holds the ends and the ratio (the gap listed on both charts); a rank_top claim of another
        // series sits on a third chart.
        let run = dir.path();
        std::fs::write(
            run.join("computations/other.json"),
            json!({"rows": [{"country_iso2": "PL", "value": 99.9, "year": 2025}]}).to_string(),
        )
        .unwrap();
        let mut lines = std::fs::read_to_string(run.join("claims.jsonl")).unwrap();
        lines.push_str(&format!(
            "{}\n",
            json!({"claim_id": "c5", "computation_refs": ["computations/c5-own.json", "computations/other.json"],
                "claim_bindings": [{"column": "value", "value": 99.9, "text": "99.9"}]})
        ));
        std::fs::write(run.join("claims.jsonl"), lines).unwrap();
        let mut two = Page {
            claims: page.claims.clone(),
            charts: Vec::new(),
            templates: Vec::new(),
            sentences: BTreeMap::new(),
            places: Vec::new(),
            times: Vec::new(),
            measures: vec![page.measures[0].clone(); 3],
            plans: Vec::new(),
            scopes: vec![None; 3],
        };
        two.claims.insert(
            0,
            Claim {
                id: "c5".into(),
                kind: "rank_top".into(),
                template: String::new(),
            },
        );
        let chart = |relation, ids: &[&str]| Chart {
            relation,
            view: View::Slice,
            claim_ids: ids.iter().map(|id| id.to_string()).collect(),
            category: "country_iso2".into(),
            value: "value".into(),
        };
        two.charts = vec![
            chart(Relation::Map, &["c1", "c2", "c3", "c4"]),
            chart(Relation::Ranking, &["c3"]),
            chart(Relation::Ranking, &["c5"]),
        ];
        let moved: BTreeMap<Target, String> = fields
            .into_iter()
            .map(|(target, text)| {
                let target = match target {
                    Target::Measure(0) => Target::Measure(1),
                    Target::Heading(0) => Target::Heading(1),
                    Target::Body(0) => Target::Body(1),
                    other => other,
                };
                (target, text)
            })
            .collect();
        let spec = ranking_page_spec(run, &two, 1, &moved, "t", &SixCountries, "#c8553d").unwrap();
        assert_eq!(spec.nums(), one_chart.nums());
        let Some(Card::Bar(card)) = spec.cards.first() else {
            unreachable!()
        };
        assert_eq!((card.id.as_str(), card.bracket.len()), ("rank-1", 2));

        two.charts[1] = chart(Relation::Ranking, &["c3", "c5"]);
        let err =
            ranking_page_spec(run, &two, 1, &moved, "t", &SixCountries, "#c8553d").unwrap_err();
        assert!(err.contains("one series, not 2"), "{err}");
    }

    /// The table of the leaf-route run tests: Eurostat-like `sdg`, a share (PC) by country in one year, as fetched.
    const SDG_VALUES: [(&str, &str); 4] = [("SE", "65.4"), ("BE", "14.9"), ("DE", "30.25"), ("FR", "20")];

    /// The leaf-route run tests' catalogue: `sdg` alone, its metadata, its shape (one place dimension of four countries) and
    /// its series rows (SDG_VALUES, as the knowledge group reads a fetched file), and Hubs' countries, names and members.
    struct OneTable;
    impl Catalogue for OneTable {
        fn top5(&self, _: &str, _: &[String]) -> crate::l5geo::Ranking {
            let candidate = crate::l5geo::Candidate {
                id: "sdg".into(),
                title: "Share of renewable energy".into(),
                score: 1.0,
                s: 2.0,
                v: 0.5,
                coverage: crate::l5geo::Coverage::Europe,
            };
            crate::l5geo::Ranking {
                scope: crate::l5geo::Scope::Europe,
                places_zh: vec!["欧盟".into()],
                uncovered: None,
                candidates: vec![candidate],
            }
        }
        fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
            Vec::new()
        }
        fn source(&self) -> &Value {
            &Value::Null
        }
        fn table(&self, id: &str) -> Option<crate::l5geo::TableMeta> {
            let codes = |c: &[&str]| c.iter().map(|c| (c.to_string(), String::new())).collect();
            (id == "sdg").then(|| crate::l5geo::TableMeta {
                id: "sdg".into(),
                worldbank: false,
                dims: vec![
                    ("freq".into(), codes(&["A"])),
                    ("unit".into(), vec![("PC".into(), "Percentage".into())]),
                    ("geo".into(), codes(&SDG_VALUES.map(|(c, _)| c))),
                ],
                end_year: Some(2025),
                places: Vec::new(),
                place_members: Vec::new(),
                freqs: Vec::new(),
                unit: None,
            })
        }
        fn shape(&self, _: &crate::l5geo::TableMeta, _: &str) -> Result<crate::shape_registry::Shape, String> {
            let geo = crate::shape_registry::VaryingDim {
                dim: "geo".into(),
                members: SDG_VALUES.len(),
                roles: vec![crate::shape_registry::Role::Place],
                is_place: true,
                iso_countries: true,
                total_member: None,
            };
            Ok(crate::shape_registry::Shape { dims: vec![geo], unit_additive: false, official_flow: None })
        }
        fn series_rows(&self, _: &crate::l5geo::TableMeta, _: &str) -> Result<Vec<Value>, String> {
            Ok(SDG_VALUES
                .iter()
                .map(|(geo, value)| {
                    json!({"src": format!("series:sdg/A.PC.{geo}:2025:OBS_VALUE"), "table": "sdg",
                        "dims": {"freq": "A", "unit": "PC", "geo": geo}, "time": "2025", "value": value})
                })
                .collect())
        }
        fn countries(&self, codes: &[String]) -> Result<Vec<String>, String> {
            Hubs.countries(codes)
        }
        fn zh_names(&self, scheme: &str, codes: &[String]) -> Result<BTreeMap<String, String>, Vec<String>> {
            Hubs.zh_names(scheme, codes)
        }
        fn members(&self, aggregate: &str) -> Result<Vec<String>, String> {
            Hubs.members(aggregate)
        }
    }

    /// A host whose newsroom_data_prepare answers from a queue of details; every tool it is asked to run is kept.
    struct QueuedTools {
        details: std::collections::VecDeque<Value>,
        ran: Vec<String>,
    }

    #[async_trait::async_trait]
    impl ToolRunner for QueuedTools {
        async fn run(
            &mut self,
            name: &str,
            _args: &Value,
            _cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> anyhow::Result<crate::tool_host::CallOutcome> {
            self.ran.push(name.to_string());
            let details = self.details.pop_front().unwrap_or_else(|| json!({"mode": "failed", "text": "no scripted answer left"}));
            Ok(crate::tool_host::CallOutcome::Result {
                content: vec![json!({"type": "text", "text": format!("{name} done")})],
                details: Some(details),
                is_error: false,
            })
        }
        fn exposes(&self, _name: &str) -> bool {
            true
        }
    }

    /// What a leaf-route run_page test left: the run folder, the result, the events, the model's unasked replies and the
    /// tools run.
    struct LeafRun {
        _dir: tempfile::TempDir,
        run: std::path::PathBuf,
        result: Result<String, Stop>,
        events: Vec<Value>,
        unasked: usize,
        ran: Vec<String>,
    }

    /// A twin of the leaf child (runtime/leaves_py/run.py) for the leaf-route run tests: the panel 1140 by 600, every layer
    /// an empty group of its own, the page those groups in the order drawn; no text, so no number.
    const LEAF_CHILD_TWIN: &str = r#"import json, sys
drawn = []
for line in sys.stdin:
    req = json.loads(line)
    phase = req.get("phase")
    if phase == "size":
        out = {"w": 1140, "h": 600}
    elif phase == "page":
        out = {"html": "<body><svg>" + "".join(req["layers"][n] for n in drawn if n in req["layers"]) + "</svg></body>"}
    elif phase == "reserve":
        out = {"boxes": [], "lines": [], "refused": []}
    else:
        drawn.append(req["layer"])
        out = {"svg": '<g data-layer="%s"></g>' % req["layer"], "texts": [], "lines": [], "frame": None, "refused": [], "dropped": []}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
"#;

    /// run_page over OneTable's `sdg` on the leaf route, offline: the fetch scripted (its candidate sheet, claims.jsonl and
    /// computations written as the fetch tool writes them), the model scripted (search, table, claims, text; then
    /// `after_text` replies, which a step past the text would take), the column page drawn by LEAF_CHILD_TWIN, baked by the
    /// bake twin and checked by the browser-check twin (pass) from the run's own runtime/, through the measured doors.
    /// `draw_child`: whether runtime/leaves_py/run.py is there.
    /// The fetched file is written under data/<sha256 of `fetched_as`>.csv with SDG_CSV's bytes, so a `fetched_as` other
    /// than SDG_CSV is a file changed since its fetch.
    async fn leaf_run(draw_child: bool, fetched_as: &str, after_text: Vec<Value>) -> LeafRun {
        const SDG_CSV: &str = "DATAFLOW,LAST UPDATE,freq,unit,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG\n\
            ESTAT:SDG(1.0),x,A,PC,SE,2025,65.4,\nESTAT:SDG(1.0),x,A,PC,BE,2025,14.9,\n\
            ESTAT:SDG(1.0),x,A,PC,DE,2025,30.25,\nESTAT:SDG(1.0),x,A,PC,FR,2025,20,\n";
        const SHEET: &str = "0123456789abcdef";
        let question = "欧盟各国可再生能源占比";
        let _command = crate::group_guard::command_for_test("investigate");
        let _doors = crate::group_guard::doors_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = crate::artifact::InvestigationBundle::create(dir.path(), "leaf run").unwrap().dir;
        // the fetch tool's files: the data, the candidate sheet, the claims and their computations
        let file = format!("data/{}.csv", crate::hash::sha256_bytes(fetched_as.as_bytes()));
        for sub in ["data", "shadow", "computations", "runtime/leaves_py"] {
            std::fs::create_dir_all(run.join(sub)).unwrap();
        }
        std::fs::write(run.join(&file), SDG_CSV).unwrap();
        let kinds = [("c1", "rank_top", "SE"), ("c2", "rank_bottom", "BE"), ("c3", "extreme_gap", "")];
        let candidates: Vec<Value> = kinds
            .iter()
            .map(|(id, kind, _)| json!({"id": id, "kind": kind, "sql": "SELECT 1", "text": format!("claim {id}"),
                "template": "{first.country_iso2} at {first.value}"}))
            .collect();
        std::fs::write(
            run.join(format!("shadow/candidate_sheet-{SHEET}.json")),
            json!({"schema_version": "0.1.0", "kind": "candidate_sheet", "candidate_only": true, "candidates": candidates}).to_string(),
        )
        .unwrap();
        let series: Vec<Value> = SDG_VALUES
            .iter()
            .map(|(geo, v)| json!({"country_iso2": geo, "value": v.parse::<f64>().unwrap(), "year": 2025}))
            .collect();
        std::fs::write(
            run.join("computations/series.json"),
            json!({"columns": ["country_iso2", "value", "year"], "rows": series}).to_string(),
        )
        .unwrap();
        let mut lines = String::new();
        for (i, (_, kind, geo)) in kinds.iter().enumerate() {
            let id = format!("k{}", i + 1);
            let (own, bindings) = match *kind {
                "extreme_gap" => (json!({"gap": 50.5}), vec![json!({"placeholder": "{gap}", "column": "gap", "row_index": 0, "value": 50.5, "text": "50.5"})]),
                _ => {
                    let value = SDG_VALUES.iter().find(|(c, _)| c == geo).unwrap().1.parse::<f64>().unwrap();
                    (
                        json!({"country_iso2": geo, "value": value, "year": 2025}),
                        vec![
                            json!({"placeholder": "{first.country_iso2}", "column": "country_iso2", "row_index": 0, "value": geo, "text": geo}),
                            json!({"placeholder": "{first.value}", "column": "value", "row_index": 0, "value": value, "text": value.to_string()}),
                        ],
                    )
                }
            };
            std::fs::write(run.join(format!("computations/{id}.json")), json!({"rows": [own]}).to_string()).unwrap();
            lines.push_str(&format!(
                "{}\n",
                json!({"claim_id": id, "claim": format!("claim {id}"), "claim_bindings": bindings,
                    "computation_refs": [format!("computations/{id}.json"), "computations/series.json"]})
            ));
        }
        std::fs::write(run.join("claims.jsonl"), lines).unwrap();
        // the run's own second layer: the leaf child's twin, the bake twin and the browser-check twin
        if draw_child {
            std::fs::write(run.join("runtime/leaves_py/run.py"), LEAF_CHILD_TWIN).unwrap();
        }
        std::fs::copy("fixtures/next_leaf/bake_twin.py", run.join("runtime/leaves_py/bake.py")).unwrap();
        let qa_twin = std::fs::canonicalize("fixtures/next_visual/qa_twin.py").unwrap();
        std::fs::write(
            run.join("runtime/browser_qa.py"),
            format!("import runpy, sys\nsys.argv = [sys.argv[0], \"pass\"] + sys.argv[1:]\nrunpy.run_path({:?}, run_name=\"__main__\")\n", qa_twin.display().to_string()),
        )
        .unwrap();
        let mut replies = vec![
            call("toolu_s", json!({"step": "search", "query": "renewable energy share"})),
            call("toolu_t", json!({"step": "table", "pick": [1]})),
            call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
            call("toolu_x", json!({"step": "text", "text": {}, "names": {"s1": "可再生能源占比", "s2": "可再生能源占比"}})),
        ];
        replies.extend(after_text);
        let mut model = ScriptedAsker(replies.into());
        let picks: Vec<Value> = (1..=3).map(|i| json!({"candidate": format!("c{i}"), "claim_id": format!("k{i}")})).collect();
        let mut tools = QueuedTools {
            details: vec![
                json!({"mode": "candidates", "sheet": SHEET, "filePath": file}),
                json!({"mode": "picks", "sheet": SHEET, "filePath": file, "claims": picks}),
            ]
            .into(),
            ran: Vec::new(),
        };
        let steps = vec![PrepareStep {
            args: json!({"dataset": "sdg", "filters": [{"dimension": "unit", "values": ["PC"]}], "years": {"start": 2025, "end": 2025}})
                .as_object()
                .unwrap()
                .clone(),
            narrowed: None,
            window: None,
        }];
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
        let result = run_page(&mut recorder, &mut model, &mut tools, question, &steps, &OneTable, &cancel).await;
        drop(recorder);
        LeafRun { _dir: dir, run, result, events, unasked: model.0.len(), ran: tools.ran }
    }

    /// The completion gate holds a published leaf page back: its gaps (here the fetched file changed since its fetch, so
    /// no row of the page is held to a recorded fetch) stop the run at "gate", naming every gap the flow recorded, and the
    /// page is never shown for the image review.
    #[tokio::test]
    async fn a_published_leaf_page_with_gate_gaps_stops_at_the_gate_before_the_image_review() {
        let vision = call("toolu_v", json!({"step": "vision", "score": 95, "confidence": 0.9, "rubric": {}, "issues": []}));
        let ran = leaf_run(true, "other bytes", vec![vision]).await;
        let ring: Vec<&Value> = ran.events.iter().filter(|e| e["type"] == RING_EVENT).collect();
        assert_eq!(ring.len(), 1, "{:?}", ran.result);
        assert_eq!((ring[0]["by"].as_str(), ring[0]["recipe"].as_str()), (Some(RING_ACTOR), Some("column")), "{:?}", ran.result);
        let gate: Vec<&Value> = ran.events.iter().filter(|e| e["type"] == LEAF_GATE_EVENT).collect();
        assert_eq!(gate.len(), 1);
        let gaps: Vec<&str> = gate[0]["gaps"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(gaps.iter().any(|g| g.contains("no recorded fetch of sdg")), "{gaps:?}");
        match &ran.result {
            Err(Stop::Page { step: "gate", why }) => {
                assert!(why.contains(&format!("{} gap(s)", gaps.len())), "{why}");
                for gap in &gaps {
                    assert!(why.contains(gap), "{why} does not name {gap}");
                }
            }
            other => panic!("expected a gate stop, got {other:?}"),
        }
        // the vision reply is still unasked, no image review was recorded, and the plan stops at the browser check
        assert_eq!(ran.unasked, 1);
        assert!(!ran.events.iter().any(|e| e["type"] == PUBLICATION_VISION_EVENT || e["step"] == "vision"));
        let plan: Value = serde_json::from_str(&std::fs::read_to_string(ran.run.join(PLAN_FILE)).unwrap()).unwrap();
        let status: Vec<&str> = plan["steps"].as_array().unwrap().iter().map(|s| s["status"].as_str().unwrap()).collect();
        assert_eq!(status.last(), Some(&"pending"), "{plan}");
    }

    /// A leaf page that stops at a stage stops the run there: run_page returns that stage, the ring event names it and
    /// what stuck, with no fallback, the plan marks the step blocked, and no other route's tool (the design pack) is run.
    #[tokio::test]
    async fn a_leaf_page_stopped_at_a_stage_stops_the_run_there_with_no_fallback() {
        let ran = leaf_run(false, "", Vec::new()).await;
        match &ran.result {
            Err(Stop::Page { step: "draw", why }) => assert!(why.starts_with("the column leaf page stopped at draw: "), "{why}"),
            other => panic!("expected a draw stop, got {other:?}"),
        }
        let ring: Vec<&Value> = ran.events.iter().filter(|e| e["type"] == RING_EVENT).collect();
        assert_eq!(ring.len(), 1);
        assert_eq!((ring[0]["stage"].as_str(), ring[0]["stuck"].as_str()), (Some("draw"), Some("column-draw")));
        assert!(ring[0].get("fallback").is_none() && ring[0].get("published").is_none(), "{}", ring[0]);
        assert!(!ran.events.iter().any(|e| e["type"] == LEAF_GATE_EVENT));
        assert_eq!(ran.ran, ["newsroom_data_prepare", "newsroom_data_prepare"], "only the fetch runs on the host");
        assert!(!ran.events.iter().any(|e| e.to_string().contains("newsroom_design_pack")));
        let plan: Value = serde_json::from_str(&std::fs::read_to_string(ran.run.join(PLAN_FILE)).unwrap()).unwrap();
        let draw = plan["steps"].as_array().unwrap().iter().find(|s| s["id"] == "draw").unwrap();
        assert_eq!(draw["status"], "blocked", "{plan}");
    }
}
