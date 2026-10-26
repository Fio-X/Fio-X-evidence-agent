//! Flow side, page step 2: the first half of the design pack's judgement (discovery, story graph, novelty, asset plan,
//! visual concepts), assembled by the program from the question, the verified claims and the sheet's charts. Pure: no tool
//! runs here. A field is filled only from what the run holds: the question as written, a claim's id and its recorded
//! sentence, its candidate kind, the place and time dimensions of the data. A field nothing in the run gives (a premise, a
//! thesis, a metaphor) is left out and named in `missing`, never filled with sample text; the caller does not send a pack
//! with anything missing.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use crate::next_page::Chart;
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
const MIN_CONCEPTS: usize = 8;
const MIN_FRAMINGS: usize = 3;

pub fn assemble(input: &PackInput<'_>) -> Judgement {
    let mut missing = Vec::new();
    let (claims, unverified): (Vec<&PackClaim>, Vec<&PackClaim>) =
        input.claims.iter().partition(|c| input.verified.contains(&c.id));
    let unverified = unverified.into_iter().map(|c| c.id.clone()).collect();

    // ---- discovery: the question as written; the data's places and times; nothing reported as missing or surprising ----
    missing.push("discovery.reader_problem".to_string());
    missing.push(format!(
        "discovery.candidate_questions: {MIN_QUESTIONS} distinct for CONTINUE, the question gives 1"
    ));
    let discovery = json!({
        "candidate_questions": [input.question],
        "surprises": [], "counterintuitive_findings": [], "human_scale_refs": [],
        "spatial_dimensions": input.places, "temporal_dimensions": input.times,
        "mechanisms": [], "uncertainties": [], "missing_reporting": [], "kill_reasons": [],
    });

    // ---- story graph: one evidence node per verified claim, chained in sheet order ----
    let mut nodes = Vec::new();
    for (i, claim) in claims.iter().enumerate() {
        let mut node = json!({"id": format!("n{}", i + 1), "kind": "evidence", "summary": claim.text, "claim_ids": [claim.id]});
        match dimension(&claim.kind) {
            Some(d) => node["explanatory_dimension"] = json!(d),
            None => missing.push(format!("story_graph.nodes[{i}].explanatory_dimension: kind {} has none", claim.kind)),
        }
        nodes.push(node);
    }
    let edges: Vec<Value> = claims
        .windows(2)
        .enumerate()
        .map(|(i, pair)| json!({"from": format!("n{}", i + 1), "to": format!("n{}", i + 2), "relation": relation(&pair[0].kind, &pair[1].kind)}))
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
    missing.push("story_graph.visual_thesis".to_string());
    let count = nodes.len();
    let mut story_graph = json!({"reader_question": input.question, "nodes": nodes, "edges": edges});
    if count > 0 {
        story_graph["entry_node_ids"] = json!(["n1"]);
        story_graph["answer_node_ids"] = json!([format!("n{count}")]);
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

    // ---- visual concepts: what a concept needs beyond the charts is prose the run does not hold ----
    let framings: BTreeSet<&str> = input.charts.iter().map(|c| framing(c.relation)).collect();
    missing.push(format!(
        "visual_concepts.concepts: {MIN_CONCEPTS}..20 over {MIN_FRAMINGS} framings, each with reader_question, editorial_premise, \
         visual_metaphor, hero_scene, why_memorable; the charts give {} framing(s): {}",
        framings.len(),
        framings.iter().copied().collect::<Vec<_>>().join(", ")
    ));

    // ---- asset plan: the data series only; no asset this run can source, so none is marked available ----
    missing.push("asset_requirements.concept_id: a finalist of visual_concepts".to_string());
    missing.push("asset_requirements.requirements[0].purpose".to_string());
    let asset_requirements = json!({"requirements": [{"asset_class": "historical_series", "status": "optional", "available": false}]});

    let mut pack = Map::new();
    pack.insert("discovery".into(), discovery);
    pack.insert("story_graph".into(), story_graph);
    pack.insert("semantic_novelty".into(), json!({"modules": modules}));
    pack.insert("asset_requirements".into(), asset_requirements);
    Judgement { pack, missing, unverified }
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

    fn run(claims: &[PackClaim], charts: &[Chart], verified: &[&str]) -> Judgement {
        let verified: BTreeSet<String> = verified.iter().map(|s| s.to_string()).collect();
        let places = vec!["geo".to_string()];
        let times = vec!["2025".to_string()];
        assemble(&PackInput { question: "Which EU country has the highest share?", claims, verified: &verified, charts, places: &places, times: &times })
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
    fn the_prose_nothing_in_the_run_gives_is_named_and_left_out() {
        let (claims, charts) = q1();
        let out = run(&claims, &charts, &["claim-a", "claim-b", "claim-c"]);
        let named: Vec<&str> = out.missing.iter().map(|m| m.split(':').next().unwrap()).collect();
        assert_eq!(
            named,
            [
                "discovery.reader_problem",
                "discovery.candidate_questions",
                "story_graph.visual_thesis",
                "visual_concepts.concepts",
                "asset_requirements.concept_id",
                "asset_requirements.requirements[0].purpose",
            ]
        );
        assert!(out.missing[3].ends_with("the charts give 1 framing(s): comparison"), "{}", out.missing[3]);
        for (key, field) in [("discovery", "reader_problem"), ("story_graph", "visual_thesis")] {
            assert!(out.pack[key].get(field).is_none(), "{key}.{field} is not filled");
        }
        assert!(out.pack.get("visual_concepts").is_none());
        assert!(out.pack["asset_requirements"].get("concept_id").is_none());
        assert!(out.pack["asset_requirements"]["requirements"][0].get("purpose").is_none());
    }

    #[test]
    fn a_claim_the_system_did_not_verify_reaches_no_field() {
        let (claims, charts) = q1();
        let out = run(&claims, &charts, &["claim-a", "claim-c"]);
        assert_eq!(out.unverified, ["claim-b"]);
        let text = serde_json::to_string(&out.pack).unwrap();
        assert!(!text.contains("claim-b") && !text.contains("BE has the lowest"), "{text}");
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
}
