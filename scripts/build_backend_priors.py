#!/usr/bin/env python3
"""Build evidence-qualified Bradley-Terry priors from blinded human pairwise records."""
from __future__ import annotations
import argparse,json,math
from collections import defaultdict
from pathlib import Path

def fit(rows,iters=250,eps=1e-9):
    backends=sorted({r['backend_a'] for r in rows}|{r['backend_b'] for r in rows})
    if len(backends)<2:return {b:1.0 for b in backends}
    wins=defaultdict(float); games=defaultdict(float)
    for r in rows:
        a,b=r['backend_a'],r['backend_b']; w=max(.1,float(r.get('confidence',.7))); games[tuple(sorted((a,b)))]+=w
        if r['winner']=='a': wins[a]+=w
        elif r['winner']=='b': wins[b]+=w
        else: wins[a]+=w*.5; wins[b]+=w*.5
    ability={b:1.0 for b in backends}
    for _ in range(iters):
        nxt={}
        for i in backends:
            denom=sum(games.get(tuple(sorted((i,j))),0.0)/(ability[i]+ability[j]) for j in backends if j!=i)
            nxt[i]=(wins[i]+eps)/(denom+eps)
        gm=math.exp(sum(math.log(max(v,eps)) for v in nxt.values())/len(nxt)); ability={k:v/gm for k,v in nxt.items()}
    total=sum(ability.values()); return {k:ability[k]/total for k in sorted(ability)}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('jsonl'); ap.add_argument('--output',default='config/backend-priors.json'); ap.add_argument('--min-reviewers',type=int,default=3); ap.add_argument('--min-comparisons',type=int,default=6); args=ap.parse_args()
    rows=[]; seen=set()
    for line in Path(args.jsonl).read_text().splitlines():
        if not line.strip():continue
        r=json.loads(line)
        if r.get('reviewer_class') not in {'qualified_human','editor','designer'}: raise SystemExit('refusing non-human preference record')
        if not str(r.get('reviewer_id','')).strip(): raise SystemExit('reviewer_id is required')
        k=(r['reviewer_id'],r['story_id'],tuple(sorted((r['backend_a'],r['backend_b']))))
        if k in seen: raise SystemExit(f'duplicate pairwise review from same reviewer: {k}')
        seen.add(k); rows.append(r)
    grouped=defaultdict(list)
    for r in rows: grouped[r['story_family']].append(r)
    fams={}
    for fam,rs in sorted(grouped.items()):
        reviewers=sorted({r['reviewer_id'] for r in rs}); status='QUALIFIED' if len(reviewers)>=args.min_reviewers and len(rs)>=args.min_comparisons else 'PENDING'
        fams[fam]={'status':status,'reviewer_count':len(reviewers),'comparison_count':len(rs),'probabilities':fit(rs) if status=='QUALIFIED' else {}}
    out={'schema_version':'2.0.0','generated_from':'qualified_human_pairwise_only','minimums':{'reviewers':args.min_reviewers,'comparisons_per_family':args.min_comparisons},'story_families':fams}
    p=Path(args.output); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(json.dumps(out,indent=2)+'\n'); print(p)
if __name__=='__main__':main()
