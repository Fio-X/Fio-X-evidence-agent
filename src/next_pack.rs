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
use crate::shape_registry::Relation;

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
        let title = measure.map(|m| m.title.trim()).filter(|t| !t.is_empty());
        let code = measure.and_then(|m| m.unit_code.as_deref());
        let unit = code.and_then(|c| unit_text(c, measure.and_then(|m| m.unit_label.as_deref())));
        let kind = code.and_then(measure_kind);
        // The period the rows cover, first to last time value (one year is a period of one year).
        let times = measure.map(|m| m.times.as_slice()).unwrap_or_default();
        let period = times.first().zip(times.last()).map(|(start, end)| json!({"type": "period", "start": start, "end": end}));
        let (Some(title), Some(unit), Some(kind), Some(period)) = (title, unit, kind, period) else {
            missing.push(format!(
                "charts[{j}]: the table gives title {title:?}, unit code {code:?}, measure kind {kind:?}, {} time values",
                times.len()
            ));
            continue;
        };
        let task = reader_task(relation);
        let mut chart = json!({"claim_id": claim_id, "language": "zh", "reader_task": task, "claim_spec": {"reader_task": task},
            "measure_semantics": [{"id": "value", "field": own["value_field"], "phenomenon": title, "unit": unit, "measure_kind": kind,
                "temporal_basis": period}]});
        if own.get("unit").is_none() {
            chart["unit"] = json!(unit);
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
            if let Some((node, _)) = nodes.get(claim_id.as_str()) {
                modules.push(json!({"id": format!("hero{}", modules.len() + 1), "type": "hero_stat", "claim_id": claim_id,
                    "value_from": value_from, "label": label, "story_node_ids": [node]}));
            }
        }
    }
    let mut all_nodes = Vec::new();
    for (i, chart) in input.charts.iter().enumerate() {
        let on: Vec<&(String, &str)> = chart.claim_ids.iter().filter_map(|id| nodes.get(id.as_str())).collect();
        let mut module = json!({"id": format!("m{}", i + 1), "type": "visual", "chart": i,
            "story_node_ids": on.iter().map(|(node, _)| node).collect::<Vec<_>>()});
        if let Some(d) = on.first().and_then(|(_, kind)| dimension(kind)) {
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
        modules.push(json!({"id": "text1", "type": "text", "body": text, "story_node_ids": all_nodes}));
    }
    let mut page = json!({"modules": modules});
    for (key, target) in [("title", Target::PageTitle), ("dek", Target::PageDek), ("primary_message", Target::VisualThesis)] {
        if let Some(text) = worded.get(&target) {
            page[key] = json!(text);
        }
    }
    let mut pack = Map::new();
    pack.insert("part".into(), json!("second"));
    pack.insert("charts".into(), json!(charts));
    pack.insert("page".into(), page);
    pack.insert("publication".into(), json!({}));
    Judgement { pack, missing, unverified: Vec::new() }
}

/// What the fetched table says about a chart's measure: its catalogue title, and the one unit code it was fetched in with
/// that code's catalogue label (None when the fetch did not fix one unit).
#[derive(Clone, Debug, PartialEq)]
pub struct Measure {
    pub title: String,
    pub unit_code: Option<String>,
    pub unit_label: Option<String>,
    /// The time values the chart's series draws, sorted, no repeats.
    pub times: Vec<String>,
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

/// The measure kind of a Eurostat unit code (measure_semantics.mjs MEASURE_KINDS), by the prefixes classify.rs
/// unit_additive reads; None for a code these do not cover, which is named, not guessed.
fn measure_kind(code: &str) -> Option<&'static str> {
    const COUNTS: [&str; 2] = ["NR", "PER"];
    const AMOUNTS: [&str; 5] = ["T", "KTOE", "TJ", "GWH", "EUR"];
    let base = ["THS_", "MIO_", "BN_"].iter().find_map(|p| code.strip_prefix(p)).unwrap_or(code);
    let index = code.len() > 3 && code.starts_with('I') && code[1..3].bytes().all(|b| b.is_ascii_digit()) && &code[3..4] == "_";
    if code.starts_with("PCH") || code.starts_with("RCH") {
        Some("change")
    } else if code.starts_with("PC") || code.starts_with("P_") {
        Some("share")
    } else if code.starts_with("RT") {
        Some("rate")
    } else if index {
        Some("index")
    } else if COUNTS.contains(&base) {
        Some("count")
    } else if AMOUNTS.contains(&base) || code.starts_with("CLV") {
        Some("level")
    } else {
        None
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
            (Target::VisualThesis, "把各国排在同一把尺子上。"),
        ]
        .into_iter()
        .map(|(t, w)| (t, w.to_string()))
        .collect();
        let measures = [Measure { title: "Share of renewables".into(), unit_code: Some("PC".into()), unit_label: Some("Percentage".into()),
            times: vec!["2024".into(), "2025".into()] }];
        let sheet = [json!({"claim_id": "claim-a", "chart_type": "horizontal_bar", "value_field": "value"})];
        let judged = second(&input, &worded, &measures, &sheet);
        assert!(judged.missing.is_empty(), "{:?}", judged.missing);
        let out = judged.pack;
        assert_eq!((out["part"].clone(), out["publication"].clone()), (json!("second"), json!({})));
        assert_eq!(out["charts"], json!([{"claim_id": "claim-a", "language": "zh", "reader_task": "ranking", "unit": "%",
            "claim_spec": {"reader_task": "ranking"},
            "measure_semantics": [{"id": "value", "field": "value", "phenomenon": "Share of renewables", "unit": "%", "measure_kind": "share",
                "temporal_basis": {"type": "period", "start": "2024", "end": "2025"}}]}]));
        let page = &out["page"];
        assert_eq!((page["title"].clone(), page["dek"].clone()), (json!("标题"), json!("导语")));
        assert_eq!(page["primary_message"], json!("把各国排在同一把尺子上。"));
        let modules = page["modules"].as_array().unwrap();
        assert_eq!(modules.len(), 3, "the unverified claim's hero is left out");
        // claim-a is not verified, so claim-b is n1 and claim-c n2, as in the first part's story graph.
        let first = run(&claims, &charts, &["claim-b", "claim-c"]);
        assert_eq!(first.pack["story_graph"]["nodes"][1]["claim_ids"], json!(["claim-c"]));
        assert_eq!(modules[0], json!({"id": "hero1", "type": "hero_stat", "claim_id": "claim-c", "value_from": "first.gap",
            "label": "差距", "story_node_ids": ["n2"]}));
        assert_eq!(modules[1], json!({"id": "m1", "type": "visual", "chart": 0, "story_node_ids": ["n1", "n2"],
            "explanatory_dimension": "rank", "heading": "小标题", "body": "最低是{min.value.name}。"}));
        assert_eq!(modules[2], json!({"id": "text1", "type": "text", "body": "说明", "story_node_ids": ["n1", "n2"]}));
    }

    #[test]
    fn a_chart_whose_table_gives_no_unit_or_another_order_is_named() {
        let (claims, charts) = q1();
        let verified: BTreeSet<String> = ["claim-a"].iter().map(|s| s.to_string()).collect();
        let reader = reader();
        let input = PackInput { question: "q", claims: &claims, verified: &verified, charts: &charts, places: &[], times: &[], reader: &reader };
        let bare = [Measure { title: "T".into(), unit_code: None, unit_label: None, times: Vec::new() }];
        let sheet = [json!({"claim_id": "claim-b", "value_field": "value"})];
        let out = second(&input, &BTreeMap::new(), &bare, &sheet);
        assert_eq!(out.missing, ["charts[0]: the table gives title Some(\"T\"), unit code None, measure kind None, 0 time values"]);
        let stray = [json!({"claim_id": "claim-x", "value_field": "value"})];
        assert_eq!(second(&input, &BTreeMap::new(), &bare, &stray).missing, ["charts[0]: the sheet's claim claim-x is on no page chart"]);
    }

    #[test]
    fn unit_codes_give_a_measure_kind_or_none() {
        let kinds: Vec<Option<&str>> = ["PC", "PC_GDP", "PCH_PRE", "RCH_A", "RT", "I15_A_AVG", "THS_PER", "NR", "MIO_EUR", "CLV10_EUR", "KG_HAB"]
            .iter().map(|c| measure_kind(c)).collect();
        assert_eq!(kinds, [Some("share"), Some("share"), Some("change"), Some("change"), Some("rate"), Some("index"), Some("count"),
            Some("count"), Some("level"), Some("level"), None]);
        assert_eq!(unit_text("PC", Some("Percentage")).as_deref(), Some("%"));
        assert_eq!(unit_text("THS_T", Some("Thousand tonnes")).as_deref(), Some("Thousand tonnes"));
        assert_eq!(unit_text("THS_T", None), None);
    }
}
