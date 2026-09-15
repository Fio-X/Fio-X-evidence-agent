#!/usr/bin/env python3
import argparse,json,sys
from pathlib import Path
ap=argparse.ArgumentParser(); ap.add_argument('blind'); ap.add_argument('key'); ap.add_argument('--output',required=True); a=ap.parse_args()
blind=json.loads(Path(a.blind).read_text()); key=json.loads(Path(a.key).read_text()); mapping={x['candidate']:x['backend'] for x in key['key']}; gates=blind.get('candidate_gates',{}); out=[]; skipped=[]
for r in blind.get('records',[]):
    ca,cb=r['candidate_a'],r['candidate_b']; w=r['winner']
    if ca not in mapping or cb not in mapping: raise SystemExit('unknown candidate')
    if gates.get(ca)!='PASS' or gates.get(cb)!='PASS': skipped.append({'candidate_a':ca,'candidate_b':cb,'reason':'human_validity_gate'}); continue
    winner='tie' if w=='tie' else ('a' if w==ca else 'b' if w==cb else None)
    if winner is None: raise SystemExit('winner is not a reviewed candidate')
    out.append({'story_id':r['story_id'],'story_family':r['story_family'],'backend_a':mapping[ca],'backend_b':mapping[cb],'winner':winner,'confidence':r['confidence'],'reason_tags':r.get('reason_tags',[]),'reviewer_class':r['reviewer_class'],'reviewer_id':r.get('reviewer_id','')})
Path(a.output).write_text(''.join(json.dumps(x,separators=(',',':'))+'\n' for x in out)); print(json.dumps({'output':a.output,'accepted':len(out),'skipped':skipped}))
