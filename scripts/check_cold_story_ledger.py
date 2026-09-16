#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def load_behavior_cases(path: Path):
    if not path.is_file():
        return []
    payload=json.loads(path.read_text())
    rows=[]
    for result in payload.get('cases',[]):
        if result.get('status') != 'PASS':
            continue
        rows.append({
            'id': result.get('id'),
            'date': None,
            'kind': result.get('kind'),
            'topology_family': result.get('topology_family'),
            'status': 'PASS',
            'silent_semantic_errors': int(result.get('silent_semantic_errors',0) or 0),
            'correct_abstention': bool(result.get('correct_abstention',False)),
            'behavior_tags': list(result.get('behavior_tags') or []),
            'evidence_ref': str(path.relative_to(ROOT)),
            'derived_from_executable_fixture': True,
        })
    return rows

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--ledger',default='config/cold-story-ledger.json')
    ap.add_argument('--behavior-results',default='outputs/v113-cold-behavior-results.json')
    ap.add_argument('--output',default='outputs/v113-cold-story-gate.json')
    args=ap.parse_args()
    req=json.loads((ROOT/'config/cold-story-requirements.json').read_text())['requirements']
    ledger=json.loads((ROOT/args.ledger).read_text())
    base_cases=list(ledger.get('cases',[]))
    behavior_path=ROOT/args.behavior_results
    derived_cases=load_behavior_cases(behavior_path)
    ids=set()
    cases=[]
    duplicate_ids=[]
    for case in [*base_cases,*derived_cases]:
        cid=str(case.get('id') or '')
        if not cid:
            continue
        if cid in ids:
            duplicate_ids.append(cid)
            continue
        ids.add(cid)
        cases.append(case)
    passed=[c for c in cases if c.get('status')=='PASS']
    news=[c for c in passed if c.get('kind')=='news']
    families=sorted({str(c.get('topology_family')) for c in passed if c.get('topology_family')})
    behavior_families=sorted({str(tag) for c in passed for tag in (c.get('behavior_tags') or []) if tag})
    silent=sum(int(c.get('silent_semantic_errors',0) or 0) for c in passed)
    abstentions=sum(1 for c in passed if c.get('correct_abstention') is True)
    missing_refs=[c.get('id') for c in passed if c.get('evidence_ref') and not (ROOT/c['evidence_ref']).is_file()]
    derived_fixture_cases=[c for c in passed if c.get('derived_from_executable_fixture') is True]
    checks={
      'minimum_cases':len(passed)>=int(req['minimum_cases']),
      'minimum_news_cases':len(news)>=int(req['minimum_news_cases']),
      'minimum_topology_families':len(families)>=int(req['minimum_topology_families']),
      'minimum_behavior_families':len(behavior_families)>=int(req.get('minimum_behavior_families',0)),
      'silent_semantic_errors':silent<=int(req['maximum_silent_semantic_errors']),
      'correct_abstentions':abstentions>=int(req['minimum_correct_abstentions']),
      'evidence_refs_present':not missing_refs,
      'no_duplicate_case_ids':not duplicate_ids,
      'executable_behavior_cases_present':len(derived_fixture_cases)>=int(req.get('minimum_behavior_families',0)),
    }
    out={
      'schema_version':'0.2.0',
      'release':ledger.get('release'),
      'status':'PASS' if all(checks.values()) else 'BLOCKED',
      'checks':checks,
      'observed':{
        'cases':len(passed),
        'base_cases':len([c for c in base_cases if c.get('status')=='PASS']),
        'executable_behavior_cases':len(derived_fixture_cases),
        'news_cases':len(news),
        'topology_families':families,
        'topology_family_count':len(families),
        'behavior_families':behavior_families,
        'behavior_family_count':len(behavior_families),
        'silent_semantic_errors':silent,
        'correct_abstentions':abstentions,
      },
      'required':req,
      'missing_evidence_refs':missing_refs,
      'duplicate_case_ids':duplicate_ids,
      'case_ids':[c.get('id') for c in passed],
      'derived_case_ids':[c.get('id') for c in derived_fixture_cases],
    }
    p=ROOT/args.output
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps(out,indent=2))
    raise SystemExit(0 if out['status']=='PASS' else 2)
if __name__=='__main__': main()
