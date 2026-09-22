#!/usr/bin/env python3
from __future__ import annotations
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
v=json.loads((ROOT/'versions.json').read_text()); release=v['release']; errors=[]
ct=(ROOT/'Cargo.toml').read_text(); m=re.search(r'(?m)^version\s*=\s*"([^"]+)"',ct)
if not m or m.group(1)!=release: errors.append(f'Cargo.toml release mismatch: {m.group(1) if m else None} != {release}')
for rel in ['runtime/web/package.json','runtime/sigma/package.json','runtime/map/package.json','runtime/d3/package.json']:
    got=json.loads((ROOT/rel).read_text()).get('version')
    if got!=release: errors.append(f'{rel} release mismatch: {got} != {release}')
for rel in ['config/production-host.json','config/dependency-lock-policy.json','config/cold-story-requirements.json','config/cold-story-ledger.json']:
    got=json.loads((ROOT/rel).read_text()).get('release')
    if got!=release: errors.append(f'{rel} release mismatch: {got} != {release}')
# Contract versions must match the current trusted publication baseline.
expected={'publication_spec':'0.3.0','map_spec':'0.2.0','story_graph':'0.1.0','infographic_spec':'1.5.0','model_spec':'0.2.0'}
for k,want in expected.items():
    if v.get(k)!=want: errors.append(f'versions.json {k}: {v.get(k)} != {want}')
out={'schema_version':'0.1.0','release':release,'status':'PASS' if not errors else 'FAIL','errors':errors}
print(json.dumps(out,indent=2));raise SystemExit(0 if not errors else 2)
