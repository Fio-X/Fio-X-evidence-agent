#!/usr/bin/env python3
"""Scan workspace source and local evidence; print counts and safe locations only."""
import json, os, re, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
values=dict(os.environ)
for line in Path('/Users/fio/code/PJ004/.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  key,value=line.removeprefix('export ').split('=',1);values[key.strip()]=value.strip().strip('\"\'')
secrets=[v.encode() for k,v in values.items() if len(v)>=8 and any(w in k.upper() for w in ['API_KEY','TOKEN','SECRET','PASSWORD'])]
pattern=re.compile(rb'(?:sk-(?:ant-)?[A-Za-z0-9_-]{24,}|(?:Bearer|x-api-key)[ :]+[A-Za-z0-9_-]{24,})')
hits=[];files=0
for p in root.rglob('*'):
 if not p.is_file() or p.is_symlink() or 'target' in p.relative_to(root).parts or '.git' in p.relative_to(root).parts:continue
 if p.name=='secret-audit.json':continue
 data=p.read_bytes();files+=1
 for kind,positions in [('configured-secret',[data.find(s) for s in secrets if s in data]),('credential-pattern',[m.start() for m in pattern.finditer(data)])]:
  for pos in positions:hits.append({'file':str(p.relative_to(root)),'line':data[:pos].count(b'\n')+1,'kind':kind})
report={'files_scanned':files,'hits':len(hits),'locations':hits,'scope':'source, all local perf logs/artifacts/binaries, conversation notes; target build cache excluded'}
(root/'perf-results/secret-audit.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
raise SystemExit(bool(hits))
