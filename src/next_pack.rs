//! Flow side, page step 2: the first half of the design pack's judgement (discovery, story graph, novelty, asset plan,
//! visual concepts), assembled by the program from the question, the verified claims and the sheet's charts. Pure: no tool
//! runs here. A field is filled only from what the run holds: the question as written, a claim's id and its recorded
//! sentence, its candidate kind, the place and time dimensions of the data, the reader fields as reworded with the page
//! (next_page), and per chart relation its registered concept (shape_registry CONCEPTS; on the new route the pack takes
//! one concept per relation over one framing or more). What the run does not give is named in `missing`, never filled
//! with sample text; the caller does not send a pack with anything missing.
//!
//! Part "second" (`second`) is the page over the sheet's charts: per chart the judgement the sheet leaves out (reader task,
//! unit and the measure, from the relation and the fetched table's catalogue title and unit code), one module per chart
//! and per hero label, the page fields as reworded with the page. Story node ids follow the first half's rule.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::next_page::{concept, Chart, Target};
use crate::shape_registry::{page_plan, Axis, PagePlan, Relation, PAGE_AUDIENCE, PAGE_RENDERERS, PAGE_SCENE_PATTERN};

/// A picked claim: its recorded id (claim_id), its candidate kind (claim_candidates.mjs) and its recorded sentence.
#[derive(Clone, Debug, PartialEq)]
pub struct PackClaim {
    pub id: String,
    pub kind: String,
    pub text: String,
}

/// What the run holds for the pack.
pub struct PackInput<'a> {
    pub question: &'a str,
    /// Sheet order.
    pub claims: &'a [PackClaim],
    /// The ids the system verified (read through the group that owns the claims); any other claim is left out.
    pub verified: &'a BTreeSet<String>,
    pub charts: &'a [Chart],
    /// The data's place dimensions and time values.
    pub places: &'a [String],
    pub times: &'a [String],
    pub reader: &'a Reader,
}

/// The reader fields after the page rewording (next_page Target::ReaderProblem, VisualThesis, Question).
#[derive(Clone, Debug, PartialEq)]
pub struct Reader {
    pub problem: String,
    pub thesis: String,
    pub questions: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub struct Judgement {
    /// The pack fields as far as they are filled.
    pub pack: Map<String, Value>,
    /// Field paths nothing in the run gives, with what the tool needs there.
    pub missing: Vec<String>,
    /// Picked claims left out because the system did not verify them.
    pub unverified: Vec<String>,
}

/// The story dimension of a candidate kind (story_graph.mjs STORY_DIMENSIONS).
fn dimension(kind: &str) -> Option<&'static str> {
    match kind {
        "rank_top" | "rank_bottom" => Some("rank"),
        "extreme_gap" | "top_to_bottom_ratio" | "cut_top_share" | "cut_members_share" | "share_of_total" => Some("comparison"),
        "change_largest_rise" | "change_largest_fall" | "change_total" => Some("trend"),
        _ => None,
    }
}

/// The dimension a chart of this relation explains on its own (a map places, a flow moves, a change runs over time); a ranking or a
/// composition chart says what its claim says, so it takes its first claim's dimension.
fn relation_dimension(relation: Relation) -> Option<&'static str> {
    match relation {
        Relation::Map => Some("spatial"),
        Relation::Flow => Some("flow"),
        Relation::Change => Some("trend"),
        Relation::Distribution => Some("distribution"),
        Relation::Ranking | Relation::Composition => None,
    }
}

/// The edge between two claims in sheet order: the two ends of one ranking or one change contrast; anything else only supports.
fn relation(from: &str, to: &str) -> &'static str {
    let pair = |a: &str, b: &str| (from == a && to == b) || (from == b && to == a);
    if pair("rank_top", "rank_bottom") || pair("change_largest_rise", "change_largest_fall") {
        "contrasts_with"
    } else {
        "supports"
    }
}

/// The concept framing a chart's relation stands for (editorial.mjs CONCEPT_FRAMINGS).
fn framing(relation: Relation) -> &'static str {
    match relation {
        Relation::Map => "spatial",
        Relation::Change => "temporal",
        Relation::Flow => "mechanism",
        Relation::Ranking | Relation::Composition | Relation::Distribution => "comparison",
    }
}

/// The tools' counts (story_graph.mjs, editorial.mjs, newsroom.ts schemas); not loosened here.
const MIN_NODES: usize = 3;
const MIN_QUESTIONS: usize = 3;
/// The one asset the run holds, the data series; the tool's schema requires a purpose (a design record, not on the page).
const SERIES_PURPOSE: &str = "The fetched data series the page's charts are drawn from.";

pub fn assemble(input: &PackInput<'_>) -> Judgement {
    let mut missing = Vec::new();
    let (claims, unverified): (Vec<&PackClaim>, Vec<&PackClaim>) =
        input.claims.iter().partition(|c| input.verified.contains(&c.id));
    let unverified = unverified.into_iter().map(|c| c.id.clone()).collect();

    // ---- discovery: the question as written and the reworded reader fields; the data's places and times; nothing
    // reported as missing or surprising. Reworded questions that repeat one another go back to the lead concept's drafts,
    // which differ. ----
    let lead = input.charts.first().map(|c| c.relation);
    let reworded: BTreeSet<&str> = input.reader.questions.iter().map(|q| q.trim()).filter(|q| !q.is_empty()).collect();
    let questions: Vec<String> = match lead {
        Some(relation) if reworded.len() < MIN_QUESTIONS => concept(relation).questions.iter().map(|q| q.to_string()).collect(),
        _ => input.reader.questions.iter().map(|q| q.trim().to_string()).filter(|q| !q.is_empty()).collect(),
    };
    let mut candidate_questions = vec![input.question.to_string()];
    candidate_questions.extend(questions.into_iter().filter(|q| q != input.question));
    let distinct: BTreeSet<&String> = candidate_questions.iter().collect();
    if distinct.len() < MIN_QUESTIONS {
        missing.push(format!("discovery.candidate_questions: {MIN_QUESTIONS} distinct for CONTINUE, the run gives {}", distinct.len()));
    }
    if input.reader.problem.trim().is_empty() {
        missing.push("discovery.reader_problem".to_string());
    }
    let mut discovery = json!({
        "candidate_questions": candidate_questions,
        "surprises": [], "counterintuitive_findings": [], "human_scale_refs": [],
        "spatial_dimensions": input.places, "temporal_dimensions": input.times,
        "mechanisms": [], "uncertainties": [], "missing_reporting": [], "kill_reasons": [],
    });
    if !input.reader.problem.trim().is_empty() {
        discovery["reader_problem"] = json!(input.reader.problem.trim());
    }

    // ---- story graph: one evidence node per verified claim, chained in sheet order ----
    let mut nodes = Vec::new();
    for (i, claim) in claims.iter().enumerate() {
        let mut node = json!({"id": node_id(i), "kind": "evidence", "summary": claim.text, "claim_ids": [claim.id]});
        match dimension(&claim.kind) {
            Some(d) => node["explanatory_dimension"] = json!(d),
            None => missing.push(format!("story_graph.nodes[{i}].explanatory_dimension: kind {} has none", claim.kind)),
        }
        nodes.push(node);
    }
    let edges: Vec<Value> = claims
        .windows(2)
        .enumerate()
        .map(|(i, pair)| json!({"from": node_id(i), "to": node_id(i + 1), "relation": relation(&pair[0].kind, &pair[1].kind)}))
        .collect();
    if nodes.len() < MIN_NODES {
        missing.push(format!("story_graph.nodes: at least {MIN_NODES}, the verified claims give {}", nodes.len()));
    }
    let dimensions: BTreeSet<&str> = claims.iter().filter_map(|c| dimension(&c.kind)).collect();
    if dimensions.len() < 2 {
        missing.push(format!("story_graph.nodes: 2 distinct explanatory_dimension, the claims give {}", dimensions.len()));
    }
    if !edges.iter().any(|e| e["relation"] != "supports") {
        missing.push("story_graph.edges: one relation other than supports, the claim kinds give none".to_string());
    }
    let count = nodes.len();
    let mut story_graph = json!({"reader_question": input.question, "nodes": nodes, "edges": edges});
    match input.reader.thesis.trim() {
        "" => missing.push("story_graph.visual_thesis".to_string()),
        thesis => story_graph["visual_thesis"] = json!(thesis),
    }
    if count > 0 {
        story_graph["entry_node_ids"] = json!([node_id(0)]);
        story_graph["answer_node_ids"] = json!([node_id(count - 1)]);
    }

    // ---- semantic novelty: one module per verified claim; a kind is one reader question ----
    let modules: Vec<Value> = claims
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            dimension(&c.kind).map(|d| {
                json!({"id": format!("m{}", i + 1), "reader_question_id": c.kind, "claim_set": [c.id],
                    "new_information": c.text, "explanatory_dimension": d})
            })
        })
        .collect();
    if modules.len() < 2 {
        missing.push(format!("semantic_novelty.modules: at least 2, the claims give {}", modules.len()));
    }

    // ---- visual concepts: one per chart relation in sheet order, its record from the registry, its evidence the verified
    // claims drawn on charts of that relation ----
    let mut concepts = Vec::new();
    let mut seen = BTreeSet::new();
    for chart in input.charts {
        if !seen.insert(chart.relation) {
            continue;
        }
        let refs: Vec<&String> = input
            .charts
            .iter()
            .filter(|c| c.relation == chart.relation)
            .flat_map(|c| c.claim_ids.iter())
            .filter(|id| input.verified.contains(*id))
            .collect();
        let id = chart.relation.template();
        if refs.is_empty() {
            missing.push(format!("visual_concepts.concepts[{id}].hero_evidence_refs: no verified claim on its charts"));
            continue;
        }
        let record = concept(chart.relation);
        concepts.push(json!({
            "concept_id": id, "framing": framing(chart.relation), "reader_question": input.question,
            "editorial_premise": record.premise, "visual_metaphor": record.metaphor, "hero_scene": record.hero_scene,
            "why_memorable": record.why_memorable, "media_mix": record.media, "hero_evidence_refs": refs,
            "supporting_evidence_refs": [], "asset_requirements": [], "risk_flags": [], "reporting_gaps": [],
        }));
    }
    if concepts.is_empty() && input.charts.is_empty() {
        missing.push("visual_concepts.concepts: the sheet has no chart".to_string());
    }

    // ---- asset plan: the data series only; no asset this run can source, so none is marked available; the pack takes
    // the concept the tournament selected ----
    let asset_requirements = json!({"requirements": [{"asset_class": "historical_series", "status": "optional", "available": false,
        "purpose": SERIES_PURPOSE}]});

    let mut pack = Map::new();
    pack.insert("discovery".into(), discovery);
    pack.insert("story_graph".into(), story_graph);
    if !concepts.is_empty() {
        pack.insert("visual_concepts".into(), json!({"concepts": concepts}));
    }
    pack.insert("semantic_novelty".into(), json!({"modules": modules}));
    pack.insert("asset_requirements".into(), asset_requirements);
    Judgement { pack, missing, unverified }
}

/// The story node of the i-th verified claim in sheet order.
fn node_id(i: usize) -> String {
    format!("n{}", i + 1)
}

/// Part "second": the charts left to the sheet (it fills every program field of each, in sheet order), the hero stats first
/// (PAGE_TOP_GUIDANCE), then one visual module per chart and the text module, each naming the story nodes of its verified
/// claims; the page fields are the reworded ones. A field the rewording left out is left out here, not filled.
pub fn second(input: &PackInput<'_>, worded: &BTreeMap<Target, String>, measures: &[Measure], sheet: &[Value]) -> Judgement {
    let mut missing = Vec::new();
    let mut charts = Vec::new();
    // Per page chart: its visual_channels and quantitative_encoding, from the template's registry row.
    let mut encodings = Vec::new();
    for (j, own) in sheet.iter().enumerate() {
        let claim_id = own["claim_id"].as_str().unwrap_or("");
        let Some(i) = input.charts.iter().position(|c| c.claim_ids.iter().any(|id| id == claim_id)) else {
            missing.push(format!("charts[{j}]: the sheet's claim {claim_id} is on no page chart"));
            continue;
        };
        if i != j {
            missing.push(format!("charts[{j}]: the sheet's chart is page chart {i}"));
            continue;
        }
        let (relation, measure) = (input.charts[i].relation, measures.get(i));
        // The measure's name is the reworded Chinese one (a Text slot); the catalogue title is only its draft.
        let title = worded.get(&Target::Measure(i)).map(|t| t.trim()).filter(|t| !t.is_empty());
        let code = measure.and_then(|m| m.unit_code.as_deref());
        let unit = code.and_then(|c| unit_text(c, measure.and_then(|m| m.unit_label.as_deref())));
        let kind = code.and_then(measure_kind);
        // The period the rows cover, first to last time value (one year is a period of one year).
        let times = measure.map(|m| m.times.as_slice()).unwrap_or_default();
        let period = times.first().zip(times.last()).map(|(start, end)| json!({"type": "period", "start": start, "end": end}));
        let (Some(title), Some(unit), Some(kind), Some(period)) = (title, unit, kind, period) else {
            missing.push(format!(
                "charts[{j}]: the run gives measure name {title:?}, unit code {code:?}, measure kind {kind:?}, {} time values",
                times.len()
            ));
            continue;
        };
        let task = reader_task(relation);
        // The alt text says what the chart draws (registry words and the checked measure name); the claim is not in it yet.
        let alt = relation.alt(measure.map_or(Axis::Other, |m| m.axis), title);
        // The claim is about the one measure the chart declares (its id is "value").
        encodings.push(encoding(page_plan(relation), own, kind));
        let mut chart = json!({"claim_id": claim_id, "language": "zh", "reader_task": task,
            "claim_spec": {"reader_task": task, "target_measure": "value"}, "alt": alt,
            "measure_semantics": [{"id": "value", "field": own["value_field"], "phenomenon": title, "unit": unit, "measure_kind": kind,
                "temporal_basis": period}]});
        if own.get("unit").is_none() {
            chart["unit"] = json!(unit);
        }
        // The chart's own reworded heading is its scope, so the pack titles it "measure：heading" and two charts of one measure
        // never share a title (a visual module's heading is not drawn on the page; the chart's title is).
        if let Some(heading) = worded.get(&Target::Heading(i)).map(|t| t.trim()).filter(|t| !t.is_empty() && *t != title) {
            chart["measure_semantics"][0]["scope"] = json!(heading);
        }
        if let Some(source) = measure.and_then(|m| m.source.as_deref()) {
            chart["source_note"] = json!(source);
        }
        if let Some(denominator) = measure.and_then(|m| denominator(m, kind)) {
            chart["measure_semantics"][0]["denominator"] = json!(denominator);
        }
        charts.push(chart);
    }
    let nodes: BTreeMap<&str, (String, &str)> = input
        .claims
        .iter()
        .filter(|c| input.verified.contains(&c.id))
        .enumerate()
        .map(|(i, c)| (c.id.as_str(), (node_id(i), c.kind.as_str())))
        .collect();
    let mut modules = Vec::new();
    for (target, label) in worded {
        if let Target::HeroLabel { claim_id, value_from } = target {
            if let Some((node, kind)) = nodes.get(claim_id.as_str()) {
                let mut hero = json!({"id": format!("hero{}", modules.len() + 1), "type": "hero_stat", "story_role": "hook", "claim_id": claim_id,
                    "value_from": format!("{{{value_from}}}"), "label": label, "story_node_ids": [node]});
                if let Some(d) = dimension(kind) {
                    hero["explanatory_dimension"] = json!(d);
                }
                // The unit of the chart that draws this claim's value column (the plan unit the hero check allows).
                let column = value_from.split_once('.').map_or(value_from.as_str(), |(_, c)| c);
                let unit = charts.iter().filter(|c| c["claim_id"] == claim_id.as_str()).flat_map(|c| c["measure_semantics"].as_array().into_iter().flatten())
                    .find(|m| m["field"] == column).and_then(|m| m["unit"].as_str());
                if let Some(unit) = unit {
                    hero["unit"] = json!(unit);
                }
                modules.push(hero);
            }
        }
    }
    let mut all_nodes = Vec::new();
    for (i, chart) in input.charts.iter().enumerate() {
        let on: Vec<&(String, &str)> = chart.claim_ids.iter().filter_map(|id| nodes.get(id.as_str())).collect();
        let mut module = json!({"id": format!("m{}", i + 1), "type": "visual", "story_role": "evidence", "chart": i,
            "visual_grammar": page_plan(chart.relation).visual_grammar, "story_node_ids": on.iter().map(|(node, _)| node).collect::<Vec<_>>()});
        if let Some((channels, quantitative)) = encodings.get(i) {
            module["visual_channels"] = channels.clone();
            module["quantitative_encoding"] = quantitative.clone();
        }
        if let Some(d) = relation_dimension(chart.relation).or_else(|| on.first().and_then(|(_, kind)| dimension(kind))) {
            module["explanatory_dimension"] = json!(d);
        }
        for (key, target) in [("heading", Target::Heading(i)), ("body", Target::Body(i))] {
            if let Some(text) = worded.get(&target) {
                module[key] = json!(text);
            }
        }
        all_nodes.extend(on.iter().map(|(node, _)| node.clone()));
        modules.push(module);
    }
    if let Some(text) = worded.get(&Target::Text) {
        // The text module speaks for the page, so it cites every verified claim the charts draw (sheet order, once each).
        let mut cited: Vec<&str> = Vec::new();
        for id in input.charts.iter().flat_map(|c| c.claim_ids.iter()).filter(|id| nodes.contains_key(id.as_str())) {
            if !cited.contains(&id.as_str()) {
                cited.push(id);
            }
        }
        let mut module = json!({"id": "text1", "type": "text", "story_role": "resolution", "body": text, "claim_ids": cited, "story_node_ids": all_nodes});
        // The publication is the page (one dimension of the modules it draws) and this text, and needs two dimensions: the text takes
        // the first cited claim's dimension the drawn modules lack, else the first cited claim's.
        let shown: BTreeSet<&str> = modules.iter().filter_map(|m| m["explanatory_dimension"].as_str()).collect();
        let dims: Vec<&str> = cited.iter().filter_map(|id| nodes.get(*id)).filter_map(|(_, kind)| dimension(kind)).collect();
        if let Some(d) = dims.iter().find(|d| !shown.contains(*d)).or(dims.first()) {
            module["explanatory_dimension"] = json!(d);
        }
        modules.push(module);
    }
    // The page module takes a drawn dimension other than the text's when there is one (design_pack does the same), so the publication
    // has two only when the drawn modules and the text give two between them; say so here rather than at the publication.
    let text_dim = modules.iter().find(|m| m["type"] == "text").and_then(|m| m["explanatory_dimension"].as_str());
    let drawn: BTreeSet<&str> = modules.iter().filter(|m| m["type"] != "text").filter_map(|m| m["explanatory_dimension"].as_str()).collect();
    if !text_dim.is_some_and(|t| drawn.iter().any(|d| *d != t)) {
        missing.push(format!("page.modules: 2 distinct explanatory_dimension between the page and its text, the drawn modules give {drawn:?} and the text {text_dim:?}"));
    }
    // The charts are Chinese (language above), so the page is too; the story roles read hero, evidence, then the text's answer.
    let mut page = json!({"language": "zh", "modules": modules});
    for (key, target) in [("title", Target::PageTitle), ("dek", Target::PageDek), ("primary_message", Target::VisualThesis)] {
        if let Some(text) = worded.get(&target) {
            page[key] = json!(text);
        }
    }
    if let Some(first) = input.charts.first() {
        plan_fields(&mut page, page_plan(first.relation), input, sheet);
        // The page alt: what each chart draws (the charts' alt, registry words and checked measure names), then the intent.
        let alts: Vec<&str> = charts.iter().filter_map(|c| c["alt"].as_str()).collect();
        if !alts.is_empty() {
            page["alt"] = json!(format!("本页的图：{}。{}", alts.join("；"), page_plan(first.relation).intent));
        }
    }
    let mut pack = Map::new();
    pack.insert("part".into(), json!("second"));
    pack.insert("charts".into(), json!(charts));
    pack.insert("page".into(), page);
    pack.insert("publication".into(), json!({}));
    Judgement { pack, missing, unverified: Vec::new() }
}

/// The page plan fields the program fills (PAGE_PLANS, the first chart's row; later charts add their grammar as supporting,
/// at most two): intent, story_arc, audience, editorial_grammar, and a scene_graph of one scene per chart, its anchor the
/// chart's visual module and its sidecars the hero stats of the chart's claims (a hero on no chart joins the first scene),
/// then the text module in the first scene left without one. A scene with no sidecar is left out; at most three sidecars.
fn plan_fields(page: &mut Value, first: &PagePlan, input: &PackInput<'_>, sheet: &[Value]) {
    let plans: Vec<&PagePlan> = input.charts.iter().map(|c| page_plan(c.relation)).collect();
    let mut supporting: Vec<&str> = Vec::new();
    for p in &plans {
        if p.grammar != first.grammar && first.supports.contains(&p.grammar) && !supporting.contains(&p.grammar) && supporting.len() < 2 {
            supporting.push(p.grammar);
        }
    }
    let union = |pick: &dyn Fn(&PagePlan) -> Vec<&'static str>| {
        plans.iter().flat_map(|p| pick(p)).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>()
    };
    page["intent"] = json!(first.intent);
    page["story_arc"] = json!(first.story_arc);
    page["audience"] = json!(PAGE_AUDIENCE);
    page["editorial_grammar"] = json!({"project_id": "news-next-page", "primary": first.grammar, "supporting": supporting,
        "available_renderer_capabilities": PAGE_RENDERERS, "evidence_features": union(&|p| p.evidence.to_vec()),
        "cognitive_goals": union(&|p| vec![p.goal])});
    let modules = page["modules"].as_array().cloned().unwrap_or_default();
    let mut sidecars: Vec<Vec<(String, Option<String>)>> = vec![Vec::new(); input.charts.len()];
    for m in modules.iter().filter(|m| m["type"] == "hero_stat") {
        let claim = m["claim_id"].as_str().unwrap_or("");
        let i = input.charts.iter().position(|c| c.claim_ids.iter().any(|id| id == claim)).unwrap_or(0);
        sidecars[i].push((m["id"].as_str().unwrap_or("").to_string(), Some(claim.to_string())));
    }
    if modules.iter().any(|m| m["id"] == "text1") {
        let free = sidecars.iter().position(|s| s.is_empty()).or_else(|| sidecars.iter().rposition(|s| s.len() < 3));
        if let Some(i) = free {
            sidecars[i].push(("text1".to_string(), None));
        }
    }
    let mut scenes = Vec::new();
    for (i, mut side) in sidecars.into_iter().enumerate() {
        side.truncate(3);
        if side.is_empty() {
            continue;
        }
        let anchor = format!("m{}", i + 1);
        let own: Vec<String> = sheet.get(i).and_then(|s| s["claim_id"].as_str()).map(str::to_string).into_iter().collect();
        let cites = |id: &str| -> Vec<String> {
            let m = modules.iter().find(|m| m["id"] == id);
            let one = m.and_then(|m| m["claim_id"].as_str()).map(str::to_string);
            let many = m.and_then(|m| m["claim_ids"].as_array()).into_iter().flatten().filter_map(|c| c.as_str().map(str::to_string));
            one.into_iter().chain(many).collect()
        };
        let claims: BTreeSet<String> = own.iter().cloned().chain(side.iter().flat_map(|(id, _)| cites(id))).collect();
        scenes.push(json!({"id": format!("scene{}", i + 1), "pattern": PAGE_SCENE_PATTERN, "anchor_module_id": anchor,
            "sidecar_module_ids": side.iter().map(|(id, _)| id).collect::<Vec<_>>(), "primary_cognitive_goal": plans[i].goal,
            "hero_object_id": anchor, "supporting_claim_ids": own,
            "scene_budget": {"max_supporting_objects": side.len(), "max_annotations": 8, "max_claims": claims.len().clamp(1, 12)}}));
    }
    page["scene_graph"] = json!({"schema_version": "0.2.0", "scenes": scenes});
}

/// What the fetched table says about a chart's measure: its catalogue title, the draft of its Chinese name, and the one
/// unit code it was fetched in with
/// that code's catalogue label (None when the fetch did not fix one unit).
#[derive(Clone, Debug, PartialEq)]
pub struct Measure {
    pub title: String,
    /// The title with its trailing "by …" breakdown swapped for the labels of the codes the fetch fixed (the model names
    /// the measure from this, so it never names a breakdown the chart does not draw).
    pub name: String,
    pub unit_code: Option<String>,
    pub unit_label: Option<String>,
    /// The time values the chart's series draws, sorted, no repeats.
    pub times: Vec<String>,
    /// What the chart lists along its category (the alt text's axis word).
    pub axis: Axis,
    /// The chart's source line from the catalogue: the publisher, the table's id and title, and the years the chart draws.
    /// None when the catalogue does not list the table (the pack then writes its line from the data files).
    pub source: Option<String>,
}

/// The viz plan's reader task of a chart relation (newsroom.ts VIZ_PLAN_READER_TASKS).
fn reader_task(relation: Relation) -> &'static str {
    match relation {
        Relation::Ranking => "ranking",
        Relation::Change => "change",
        Relation::Composition => "part_to_whole",
        Relation::Flow => "flow",
        Relation::Map => "spatial",
        Relation::Distribution => "distribution",
    }
}

/// A chart's visual_channels (the sheet's category and value columns on the template's channels) and quantitative_encoding
/// (quantity_kind from the measure kind; a level or a change is "other", not guessed as stock or flow).
fn encoding(plan: &PagePlan, own: &Value, kind: &str) -> (Value, Value) {
    let channels: Vec<Value> = plan
        .channels
        .iter()
        .map(|(channel, column, role)| json!({"channel": channel, "field": own[format!("{column}_field")], "role": role}))
        .collect();
    let quantity = match kind {
        "rate" | "share" | "index" | "count" => kind,
        _ => "other",
    };
    (json!(channels), json!({"quantity_kind": quantity, "mark_semantics": plan.mark, "scale_type": "linear",
        "baseline_policy": plan.baseline, "uncertainty_disclosed": false}))
}

/// The measure kind of a Eurostat unit code (measure_semantics.mjs MEASURE_KINDS), by the prefixes classify.rs
/// unit_additive reads; None for a code these do not cover, which is named, not guessed.
pub(crate) fn measure_kind(code: &str) -> Option<&'static str> {
    const COUNTS: [&str; 2] = ["NR", "PER"];
    const AMOUNTS: [&str; 5] = ["T", "KTOE", "TJ", "GWH", "EUR"];
    let base = ["THS_", "MIO_", "BN_"].iter().find_map(|p| code.strip_prefix(p)).unwrap_or(code);
    // An energy amount in a stated basis (TJ_GCV, TJ_NCV, KTOE_...) is still an amount; per inhabitant (_HAB) is not.
    let energy = ["KTOE_", "TJ_", "GWH_"].iter().any(|p| base.starts_with(p)) && !base.contains("HAB");
    let index = code.len() > 3 && code.starts_with('I') && code[1..3].bytes().all(|b| b.is_ascii_digit()) && &code[3..4] == "_";
    if code.starts_with("PCH") || code.starts_with("RCH") {
        Some("change")
    } else if code == "PC" || code == "PC_TOT" {
        // A part of its whole; another PC_ code (of GDP, of the population) is a ratio to something else, not guessed.
        Some("share")
    } else if code.starts_with("RT") || code.starts_with("P_") {
        Some("rate")
    } else if index {
        Some("index")
    } else if COUNTS.contains(&base) {
        Some("count")
    } else if AMOUNTS.contains(&base) || energy || code.starts_with("CLV") {
        Some("level")
    } else {
        None
    }
}

/// What a ratio the source publishes is divided by, from the catalogue: a share or rate (by its unit code) is of the whole the
/// source table defines, named by the table's title and its unit's label; an index is on the base its unit label names. A level,
/// count or change has none (a map refuses it), and nothing is written that the catalogue does not say.
pub(crate) fn denominator(measure: &Measure, kind: &str) -> Option<String> {
    let label = measure.unit_label.as_deref().map(str::trim).filter(|l| !l.is_empty());
    match kind {
        "share" | "rate" => Some(format!("来源表「{}」所定的总量（{}）", measure.title.trim(), label.or(measure.unit_code.as_deref())?)),
        "index" => label.map(str::to_string),
        _ => None,
    }
}

/// The unit as the chart shows it: "%" for a plain percentage, else the code's catalogue label.
fn unit_text(code: &str, label: Option<&str>) -> Option<String> {
    if code == "PC" {
        return Some("%".to_string());
    }
    label.map(str::trim).filter(|l| !l.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The q1 stand-in run: three verified claims on one ranking chart (ab/run-rel10 claims.jsonl).
    fn q1() -> (Vec<PackClaim>, Vec<Chart>) {
        let claim = |id: &str, kind: &str, text: &str| PackClaim { id: id.into(), kind: kind.into(), text: text.into() };
        (
            vec![
                claim("claim-a", "rank_top", "SE has the highest OBS VALUE in 2025: 65.4."),
                claim("claim-b", "rank_bottom", "BE has the lowest OBS VALUE in 2025: 14.9."),
                claim("claim-c", "extreme_gap", "The gap between the highest and the lowest OBS VALUE in 2025 is 50.5."),
            ],
            vec![Chart {
                relation: Relation::Ranking,
                claim_ids: vec!["claim-a".into(), "claim-b".into(), "claim-c".into()],
                category: "name".into(),
                value: "value".into(),
            }],
        )
    }

    /// The reader fields as the model reworded them.
    fn reader() -> Reader {
        Reader {
            problem: "读者想知道欧盟各国的可再生能源占比谁高谁低。".into(),
            thesis: "把各国排在同一把尺子上，北欧领先清楚可见。".into(),
            questions: vec!["哪国占比最高？".into(), "哪国占比最低？".into(), "最高和最低相差多少？".into()],
        }
    }

    fn run_with(claims: &[PackClaim], charts: &[Chart], verified: &[&str], reader: &Reader) -> Judgement {
        let verified: BTreeSet<String> = verified.iter().map(|s| s.to_string()).collect();
        let places = vec!["geo".to_string()];
        let times = vec!["2025".to_string()];
        assemble(&PackInput {
            question: "Which EU country has the highest share?",
            claims,
            verified: &verified,
            charts,
            places: &places,
            times: &times,
            reader,
        })
    }

    fn run(claims: &[PackClaim], charts: &[Chart], verified: &[&str]) -> Judgement {
        run_with(claims, charts, verified, &reader())
    }

    #[test]
    fn the_q1_story_graph_is_built_from_the_verified_claims_alone() {
        let (claims, charts) = q1();
        let out = run(&claims, &charts, &["claim-a", "claim-b", "claim-c"]);
        let graph = &out.pack["story_graph"];
        assert_eq!(graph["reader_question"], "Which EU country has the highest share?");
        let nodes = graph["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0]["summary"], "SE has the highest OBS VALUE in 2025: 65.4.");
        assert_eq!(nodes.iter().map(|n| n["explanatory_dimension"].as_str().unwrap()).collect::<Vec<_>>(), ["rank", "rank", "comparison"]);
        assert_eq!(graph["edges"], json!([{"from": "n1", "to": "n2", "relation": "contrasts_with"}, {"from": "n2", "to": "n3", "relation": "supports"}]));
        assert_eq!((graph["entry_node_ids"].clone(), graph["answer_node_ids"].clone()), (json!(["n1"]), json!(["n3"])));
        let modules = out.pack["semantic_novelty"]["modules"].as_array().unwrap();
        assert_eq!(modules.iter().map(|m| m["claim_set"][0].as_str().unwrap()).collect::<Vec<_>>(), ["claim-a", "claim-b", "claim-c"]);
        assert_eq!(out.pack["discovery"]["spatial_dimensions"], json!(["geo"]));
        assert!(out.unverified.is_empty());
    }

    #[test]
    fn with_the_reader_fields_q1_gives_a_whole_pack_with_one_concept() {
        let (claims, charts) = q1();
        let out = run(&claims, &charts, &["claim-a", "claim-b", "claim-c"]);
        assert!(out.missing.is_empty(), "{:?}", out.missing);
        assert_eq!(out.pack["discovery"]["reader_problem"], json!(reader().problem));
        assert_eq!(out.pack["story_graph"]["visual_thesis"], json!(reader().thesis));
        let mut questions = vec![json!("Which EU country has the highest share?")];
        questions.extend(reader().questions.iter().map(|q| json!(q)));
        assert_eq!(out.pack["discovery"]["candidate_questions"], json!(questions));
        let concepts = out.pack["visual_concepts"]["concepts"].as_array().unwrap();
        assert_eq!(concepts.len(), 1);
        let one = &concepts[0];
        assert_eq!((one["concept_id"].as_str(), one["framing"].as_str()), (Some("horizontal_bar"), Some("comparison")));
        assert_eq!(one["reader_question"], "Which EU country has the highest share?");
        assert_eq!(one["hero_evidence_refs"], json!(["claim-a", "claim-b", "claim-c"]));
        for field in ["editorial_premise", "visual_metaphor", "hero_scene", "why_memorable"] {
            assert!(!one[field].as_str().unwrap().is_empty(), "{field}");
        }
        assert!(!one["media_mix"].as_array().unwrap().is_empty());
        // The asset plan takes the tournament's selected concept: no concept_id from the program.
        assert!(out.pack["asset_requirements"].get("concept_id").is_none());
        assert_eq!(out.pack["asset_requirements"]["requirements"][0]["purpose"], SERIES_PURPOSE);
    }

    #[test]
    fn repeated_or_empty_reader_fields_fall_back_or_are_named() {
        let (claims, charts) = q1();
        let mut same = reader();
        same.questions = vec!["哪国最高？".into(), "哪国最高？".into(), " ".into()];
        let out = run_with(&claims, &charts, &["claim-a", "claim-b", "claim-c"], &same);
        assert!(out.missing.is_empty(), "{:?}", out.missing);
        let drafted = concept(Relation::Ranking).questions;
        assert_eq!(out.pack["discovery"]["candidate_questions"].as_array().unwrap()[1..], drafted.map(|q| json!(q)));
        let mut empty = reader();
        empty.problem = " ".into();
        empty.thesis = String::new();
        let out = run_with(&claims, &charts, &["claim-a", "claim-b", "claim-c"], &empty);
        assert_eq!(out.missing, ["discovery.reader_problem", "story_graph.visual_thesis"]);
        assert!(out.pack["discovery"].get("reader_problem").is_none() && out.pack["story_graph"].get("visual_thesis").is_none());
    }

    #[test]
    fn one_concept_per_relation_and_none_without_a_verified_claim() {
        let (claims, mut charts) = q1();
        charts.push(Chart { relation: Relation::Ranking, claim_ids: vec!["claim-x".into()], category: "name".into(), value: "value".into() });
        charts.push(Chart { relation: Relation::Change, claim_ids: vec!["claim-y".into()], category: "year".into(), value: "value".into() });
        let out = run(&claims, &charts, &["claim-a", "claim-b", "claim-c"]);
        let concepts = out.pack["visual_concepts"]["concepts"].as_array().unwrap();
        assert_eq!(concepts.len(), 1, "two ranking charts give one concept; the change chart has no verified claim");
        assert_eq!(out.missing, ["visual_concepts.concepts[line].hero_evidence_refs: no verified claim on its charts"]);
    }

    #[test]
    fn a_claim_the_system_did_not_verify_reaches_no_field() {
        let (claims, charts) = q1();
        let out = run(&claims, &charts, &["claim-a", "claim-c"]);
        assert_eq!(out.unverified, ["claim-b"]);
        let text = serde_json::to_string(&out.pack).unwrap();
        assert!(!text.contains("claim-b") && !text.contains("BE has the lowest"), "{text}");
        assert_eq!(out.pack["visual_concepts"]["concepts"][0]["hero_evidence_refs"], json!(["claim-a", "claim-c"]));
        // Two nodes is under the tool's three, and no edge contrasts: both named, not padded.
        assert!(out.missing.iter().any(|m| m.starts_with("story_graph.nodes: at least 3")));
        assert!(out.missing.iter().any(|m| m.starts_with("story_graph.edges")));
    }

    #[test]
    fn a_kind_with_no_story_dimension_is_named_not_guessed() {
        let (mut claims, charts) = q1();
        claims[2].kind = "new_kind".into();
        let out = run(&claims, &charts, &["claim-a", "claim-b", "claim-c"]);
        assert!(out.pack["story_graph"]["nodes"][2].get("explanatory_dimension").is_none());
        assert!(out.missing.iter().any(|m| m == "story_graph.nodes[2].explanatory_dimension: kind new_kind has none"));
        assert!(out.missing.iter().any(|m| m.starts_with("story_graph.nodes: 2 distinct")));
    }

    #[test]
    fn a_hero_on_a_charts_own_value_carries_that_charts_unit() {
        let (claims, charts) = q1();
        let verified: BTreeSet<String> = ["claim-a", "claim-b", "claim-c"].iter().map(|s| s.to_string()).collect();
        let reader = reader();
        let input = PackInput { question: "q", claims: &claims, verified: &verified, charts: &charts, places: &[], times: &[], reader: &reader };
        let worded: BTreeMap<Target, String> = [
            (Target::HeroLabel { claim_id: "claim-a".into(), value_from: "first.value".into() }, "最高"),
            (Target::HeroLabel { claim_id: "claim-c".into(), value_from: "first.gap".into() }, "差距"),
            (Target::Measure(0), "可再生能源占比"),
        ]
        .into_iter()
        .map(|(t, w)| (t, w.to_string()))
        .collect();
        let measures = [Measure { title: "T".into(), name: "T".into(), unit_code: Some("PC".into()), unit_label: Some("Percentage".into()),
            times: vec!["2025".into()], axis: Axis::Country, source: None }];
        let sheet = [json!({"claim_id": "claim-a", "chart_type": "horizontal_bar", "value_field": "value"})];
        let modules = second(&input, &worded, &measures, &sheet).pack["page"]["modules"].as_array().cloned().unwrap();
        let units: Vec<(&Value, &Value)> = modules.iter().filter(|m| m["type"] == "hero_stat").map(|m| (&m["claim_id"], &m["unit"])).collect();
        // The gap is no row value of the chart, so no unit is given for it (its unit would be points, not the chart's).
        assert_eq!(units, [(&json!("claim-a"), &json!("%")), (&json!("claim-c"), &Value::Null)]);
    }

    #[test]
    fn the_second_part_names_the_first_parts_nodes_and_leaves_the_charts_to_the_sheet() {
        let (claims, charts) = q1();
        let verified: BTreeSet<String> = ["claim-b", "claim-c"].iter().map(|s| s.to_string()).collect();
        let reader = reader();
        let input = PackInput { question: "q", claims: &claims, verified: &verified, charts: &charts, places: &[], times: &[], reader: &reader };
        let hero = Target::HeroLabel { claim_id: "claim-c".into(), value_from: "first.gap".into() };
        let unverified = Target::HeroLabel { claim_id: "claim-a".into(), value_from: "first.value".into() };
        let worded: BTreeMap<Target, String> = [
            (Target::PageTitle, "标题"), (Target::PageDek, "导语"), (Target::Heading(0), "小标题"),
            (Target::Body(0), "最低是{min.value.name}。"), (hero, "差距"), (unverified, "最高"), (Target::Text, "说明"),
            (Target::VisualThesis, "把各国排在同一把尺子上。"), (Target::Measure(0), "可再生能源占比"),
        ]
        .into_iter()
        .map(|(t, w)| (t, w.to_string()))
        .collect();
        let measures = [Measure { title: "Share of renewables".into(), name: "Share of renewables".into(), unit_code: Some("PC".into()), unit_label: Some("Percentage".into()),
            times: vec!["2024".into(), "2025".into()], axis: Axis::Country, source: None }];
        let sheet = [json!({"claim_id": "claim-a", "chart_type": "horizontal_bar", "value_field": "value"})];
        let judged = second(&input, &worded, &measures, &sheet);
        assert!(judged.missing.is_empty(), "{:?}", judged.missing);
        let out = judged.pack;
        assert_eq!((out["part"].clone(), out["publication"].clone()), (json!("second"), json!({})));
        assert_eq!(out["charts"], json!([{"claim_id": "claim-a", "language": "zh", "reader_task": "ranking", "unit": "%",
            "claim_spec": {"reader_task": "ranking", "target_measure": "value"}, "alt": "条形图，按国家列出可再生能源占比",
            "measure_semantics": [{"id": "value", "field": "value", "phenomenon": "可再生能源占比", "unit": "%", "measure_kind": "share",
                "temporal_basis": {"type": "period", "start": "2024", "end": "2025"}, "scope": "小标题", "denominator": "来源表「Share of renewables」所定的总量（Percentage）"}]}]));
        let page = &out["page"];
        assert_eq!((page["title"].clone(), page["dek"].clone()), (json!("标题"), json!("导语")));
        assert_eq!(page["primary_message"], json!("把各国排在同一把尺子上。"));
        let modules = page["modules"].as_array().unwrap();
        assert_eq!(modules.len(), 3, "the unverified claim's hero is left out");
        // claim-a is not verified, so claim-b is n1 and claim-c n2, as in the first part's story graph.
        let first = run(&claims, &charts, &["claim-b", "claim-c"]);
        assert_eq!(first.pack["story_graph"]["nodes"][1]["claim_ids"], json!(["claim-c"]));
        assert_eq!(modules[0], json!({"id": "hero1", "type": "hero_stat", "story_role": "hook", "claim_id": "claim-c", "value_from": "{first.gap}",
            "label": "差距", "story_node_ids": ["n2"], "explanatory_dimension": "comparison"}));
        let m1 = &modules[1];
        assert_eq!((m1["id"].clone(), m1["type"].clone(), m1["story_role"].clone(), m1["chart"].clone()), (json!("m1"), json!("visual"), json!("evidence"), json!(0)));
        assert_eq!((m1["story_node_ids"].clone(), m1["explanatory_dimension"].clone()), (json!(["n1", "n2"]), json!("rank")));
        assert_eq!((m1["heading"].clone(), m1["body"].clone()), (json!("小标题"), json!("最低是{min.value.name}。")));
        assert_eq!(m1["visual_grammar"], json!(page_plan(Relation::Ranking).visual_grammar));
        assert_eq!(modules[2], json!({"id": "text1", "type": "text", "story_role": "resolution", "body": "说明", "claim_ids": ["claim-b", "claim-c"],
            "story_node_ids": ["n1", "n2"], "explanatory_dimension": "rank"}));
        // A map chart explains where, whatever its claim ranks; its text module still takes the first claim's dimension.
        let mut mapped = charts.clone();
        mapped[0].relation = Relation::Map;
        let input = PackInput { charts: &mapped, ..input };
        let modules = second(&input, &worded, &measures, &sheet).pack["page"]["modules"].clone();
        assert_eq!((modules[1]["explanatory_dimension"].clone(), modules[2]["explanatory_dimension"].clone()), (json!("spatial"), json!("rank")));
    }

    #[test]
    fn the_text_takes_a_dimension_the_drawn_modules_lack_or_the_page_is_named() {
        let (claims, charts) = q1();
        let reader = reader();
        let measures = [Measure { title: "T".into(), name: "T".into(), unit_code: Some("PC".into()), unit_label: Some("Percentage".into()),
            times: vec!["2025".into()], axis: Axis::Country, source: None }];
        let sheet = [json!({"claim_id": "claim-a", "chart_type": "horizontal_bar", "value_field": "value"})];
        let hero = Target::HeroLabel { claim_id: "claim-a".into(), value_from: "first.value".into() };
        let worded = |text: bool| -> BTreeMap<Target, String> {
            [(Target::Measure(0), "占比"), (hero.clone(), "最高")].into_iter().chain(text.then_some((Target::Text, "说明")))
                .map(|(t, w)| (t, w.to_string())).collect()
        };
        let mut composed = charts.clone();
        composed[0].relation = Relation::Composition;
        let judge_on = |charts: &[Chart], ids: &[&str], text: bool| {
            let verified: BTreeSet<String> = ids.iter().map(|s| s.to_string()).collect();
            let input = PackInput { question: "q", claims: &claims, verified: &verified, charts, places: &[], times: &[], reader: &reader };
            second(&input, &worded(text), &measures, &sheet)
        };
        let judge = |ids: &[&str], text: bool| judge_on(&charts, ids, text);
        // A ranking (or composition) chart and a hero on its top claim both explain rank; the text takes the gap's comparison, not
        // the first claim's rank.
        for out in [judge(&["claim-a", "claim-b", "claim-c"], true), judge_on(&composed, &["claim-a", "claim-b", "claim-c"], true)] {
            assert!(out.missing.is_empty(), "{:?}", out.missing);
            let dims: Vec<&Value> = out.pack["page"]["modules"].as_array().unwrap().iter().map(|m| &m["explanatory_dimension"]).collect();
            assert_eq!(dims, [&json!("rank"), &json!("rank"), &json!("comparison")]);
        }
        // Every claim on the chart ranks, or there is no text: the page would carry one dimension, so the pack says so.
        let named = "page.modules: 2 distinct explanatory_dimension between the page and its text";
        assert!(judge(&["claim-a", "claim-b"], true).missing.iter().any(|m| m.starts_with(named)));
        assert!(judge(&["claim-a", "claim-b", "claim-c"], false).missing.iter().any(|m| m.starts_with(named)));
    }

    #[test]
    fn a_chart_whose_table_gives_no_unit_or_another_order_is_named() {
        let (claims, charts) = q1();
        let verified: BTreeSet<String> = ["claim-a"].iter().map(|s| s.to_string()).collect();
        let reader = reader();
        let input = PackInput { question: "q", claims: &claims, verified: &verified, charts: &charts, places: &[], times: &[], reader: &reader };
        let bare = [Measure { title: "T".into(), name: "T".into(), unit_code: None, unit_label: None, times: Vec::new(), axis: Axis::Other, source: None }];
        let sheet = [json!({"claim_id": "claim-b", "value_field": "value"})];
        let out = second(&input, &BTreeMap::new(), &bare, &sheet);
        // (No text is worded here, so the page's dimensions are named after the charts.)
        assert_eq!(out.missing[..1], ["charts[0]: the run gives measure name None, unit code None, measure kind None, 0 time values"]);
        let stray = [json!({"claim_id": "claim-x", "value_field": "value"})];
        assert_eq!(second(&input, &BTreeMap::new(), &bare, &stray).missing[..1], ["charts[0]: the sheet's claim claim-x is on no page chart"]);
    }

    #[test]
    fn a_ratio_gets_the_catalogues_denominator_and_a_total_none() {
        let measure = |code: &str, label: Option<&str>| Measure { title: "T".into(), name: "T".into(), unit_code: Some(code.into()), unit_label: label.map(str::to_string),
            times: Vec::new(), axis: Axis::Country, source: None };
        let named: Vec<Option<String>> = [("PC", Some("Percentage")), ("RT", None), ("I15_A_AVG", Some("Index, 2015=100")), ("I15_A_AVG", None), ("KTOE", Some("Thousand tonnes of oil equivalent")), ("THS_PER", Some("Thousand persons"))]
            .iter().map(|(code, label)| denominator(&measure(code, *label), measure_kind(code).unwrap_or(""))).collect();
        assert_eq!(named, [Some("来源表「T」所定的总量（Percentage）".into()), Some("来源表「T」所定的总量（RT）".into()), Some("Index, 2015=100".into()), None, None, None]);
    }

    #[test]
    fn unit_codes_give_a_measure_kind_or_none() {
        let kinds: Vec<Option<&str>> = ["PC", "PC_GDP", "PCH_PRE", "RCH_A", "RT", "P_THAB", "I15_A_AVG", "THS_PER", "NR", "MIO_EUR", "CLV10_EUR", "KG_HAB", "TJ_GCV",
            "THS_TJ_NCV", "KTOE", "TJ_HAB"]
            .iter().map(|c| measure_kind(c)).collect();
        assert_eq!(kinds, [Some("share"), None, Some("change"), Some("change"), Some("rate"), Some("rate"), Some("index"), Some("count"),
            Some("count"), Some("level"), Some("level"), None, Some("level"), Some("level"), Some("level"), None]);
        assert_eq!(unit_text("PC", Some("Percentage")).as_deref(), Some("%"));
        assert_eq!(unit_text("THS_T", Some("Thousand tonnes")).as_deref(), Some("Thousand tonnes"));
        assert_eq!(unit_text("THS_T", None), None);
    }
}
