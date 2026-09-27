#!/usr/bin/env python3
from __future__ import annotations
import copy, json, tempfile
from pathlib import Path
from selftest_evaluator import build_valid
from verify_artifact import verify, editorial_hash, replay_concept_finalists, replay_novelty


def write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def with_hash(obj):
    out=copy.deepcopy(obj); out["content_hash"]=editorial_hash(out); return out


def install(root: Path):
    discovery=with_hash({
      "schema_version":"0.1.0","reader_problem":"Explain a real-data story before layout.",
      "candidate_questions":["What changed?","Why?","Where?"],"surprises":["A"],"counterintuitive_findings":[],"human_scale_refs":[],"spatial_dimensions":["world"],"temporal_dimensions":["years"],"mechanisms":["measurement"],"uncertainties":[],"missing_reporting":[],"kill_reasons":[],
      "decision":"CONTINUE","decision_reasons":["sufficient_question_diversity_and_no_blocking_gap"],"metrics":{"candidate_question_count":3,"blocking_reporting_gap_count":0,"discovery_dimension_count":4}
    })
    dref="editorial/discovery/a.json"; write(root/dref,discovery)
    framings=["spatial","temporal","mechanism","comparison","human_scale","object_scene","progressive_reveal","comparison"]
    concepts=[]
    for i,framing in enumerate(framings):
      concepts.append({"concept_id":f"c{i}","reader_question":f"Question {i}","editorial_premise":"A sufficiently specific editorial premise for deterministic concept scoring and replay.","surprise":"A sufficiently long surprise statement for the test concept.","visual_metaphor":f"story-specific {framing} premise","hero_scene":f"story-specific {framing} scene","framing":framing,"hero_evidence_refs":[f"e{i}"],"supporting_evidence_refs":["support"],"asset_requirements":[],"media_mix":["map" if framing=="spatial" else "line"],"mobile_treatment":"A sufficiently explicit authored mobile treatment for the selected concept.","risk_flags":[],"reporting_gaps":[],"why_memorable":"A sufficiently specific and memorable visual idea for deterministic replay.","why_reject":""})
    finalists=replay_concept_finalists(concepts)
    scores={c["concept_id"]:0 for c in concepts}  # verifier recomputes finalists, stored score values are non-authoritative here
    concept=with_hash({"schema_version":"0.1.0","kind":"visual_concept_tournament","discovery_ref":dref,"concepts":concepts,"scores":scores,"pairwise":[],"finalists":finalists,"selected_concept_id":finalists[0],"rejected":[],"diversity":{"framing_count":7,"media_count":2}})
    cref="editorial/concepts/a.json"; write(root/cref,concept)
    modules=[
      {"id":"m1","reader_question_id":"q1","claim_set":["claim-1"],"new_information":"Long-run change over time.","explanatory_dimension":"trend","dependency_on":[]},
      {"id":"m2","reader_question_id":"q2","claim_set":["claim-1"],"new_information":"Mechanism explains how the measurement is constructed.","explanatory_dimension":"mechanism","dependency_on":["m1"]}
    ]
    decisions,passed=replay_novelty(modules)
    novelty=with_hash({"schema_version":"0.1.0","kind":"semantic_novelty_report","concept_ref":cref,"modules":modules,"pairwise":[],"decisions":decisions,"passed":passed,"high_redundancy_count":0,"average_novelty":1.0})
    nref="editorial/novelty/a.json"; write(root/nref,novelty)
    asset=with_hash({"schema_version":"0.1.0","kind":"editorial_asset_plan","concept_ref":cref,"concept_id":finalists[0],"requirements":[{"id":"map","asset_class":"published_gis","status":"required","available":True,"purpose":"context","source_refs":["sources/source.json"],"production_lane":"gis_render","evidence_needed":None,"rejection_reason":None}],"decision":"CONTINUE","blocking_missing":[],"required_missing":[],"available_count":1})
    aref="editorial/assets/a.json"; write(root/aref,asset)
    pref=with_hash({"schema_version":"0.1.0","kind":"expert_pairwise_preference","baseline_ref":"baseline.png","candidate_ref":"candidate.png","minimum_reviewers":3,"candidate_threshold":0.7,"reviews":[],"counts":{"candidate":0,"baseline":0,"tie":0,"total":0},"candidate_decisive_share":0.0,"status":"PENDING","human_evidence_required":True})
    prefref="editorial/preferences/a.json"; write(root/prefref,pref)
    page_ref="infographics/award-page.json"; write(root/page_ref,{"kind":"test-page"})
    run=with_hash({"schema_version":"0.1.0","kind":"award_mode_status","refs":{"discovery_ref":dref,"concepts_ref":cref,"asset_plan_ref":aref,"novelty_ref":nref,"page_ref":page_ref,"preference_ref":prefref},"metrics":{"concepts_generated":8,"concepts_killed":5,"research_gap_requests":1,"prototype_count":2,"raster_revision_count":1,"provider_tokens":0,"provider_cost_usd":0,"wall_time_ms":0,"human_review_count":0},"gates":{"concept_search_budget_ok":True,"prototype_budget_ok":True,"raster_review_observed":True},"preference_status":"PENDING","status":"READY_FOR_HUMAN","blockers":[],"human_evidence_required":True})
    runref="editorial/award-runs/a.json"; write(root/runref,run)
    return {"d":root/dref,"c":root/cref,"n":root/nref,"a":root/aref,"p":root/prefref,"r":root/runref}


def must_fail(name, mutate):
    with tempfile.TemporaryDirectory(prefix=f"newsroom-v14-{name}-") as tmp:
      root=Path(tmp); build_valid(root); refs=install(root)
      base=verify(root)
      if not base.passed: raise SystemExit(f"baseline invalid {name}: {base.errors[:3]}")
      mutate(refs)
      report=verify(root)
      if report.passed: raise SystemExit(f"FAIL adversary passed: {name}")
      print(f"PASS v1.4 adversary: {name} -> {report.errors[0]}")


def forged_concept(refs):
    p=refs['c']; o=json.loads(p.read_text()); o['selected_concept_id']='c7' if o['finalists'][0] != 'c7' else 'c6'; o['content_hash']=editorial_hash(o); write(p,o)

def forged_asset_decision(refs):
    p=refs['a']; o=json.loads(p.read_text()); o['requirements'][0]['status']='blocking'; o['requirements'][0]['available']=False; o['decision']='CONTINUE'; o['content_hash']=editorial_hash(o); write(p,o)

def forged_preference(refs):
    p=refs['p']; o=json.loads(p.read_text()); o['status']='PASS'; o['candidate_decisive_share']=1.0; o['content_hash']=editorial_hash(o); write(p,o)

def forged_award_status(refs):
    p=refs['r']; o=json.loads(p.read_text()); o['status']='PASS'; o['preference_status']='PENDING'; o['content_hash']=editorial_hash(o); write(p,o)

if __name__=='__main__':
    for name,fn in [('forged-concept-selection',forged_concept),('forged-asset-plan-decision',forged_asset_decision),('forged-human-preference',forged_preference),('forged-award-mode-status',forged_award_status)]: must_fail(name,fn)
    print('v1.4 editorial verifier adversaries: PASS (4 cases)')
