#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ids=sorted(json.loads((ROOT/'runtimes/build-matrix.json').read_text())['runtimes'])
with tempfile.TemporaryDirectory() as td:
    d=Path(td)
    for i,rid in enumerate(ids):
        h=hashlib.sha256(rid.encode()).hexdigest()
        row={'runtime':rid,'image':f'ghcr.io/example/{rid}:v1.26.0','image_digest':'sha256:'+h,'health_status':'PASS','health_sha256':h,'deps_sha256':h,'definition_sha256':h}
        (d/f'{rid}.json').write_text(json.dumps(row))
    out=d/'lock.json'
    subprocess.run(['python3',str(ROOT/'scripts/promote_visual_runtime_locks.py'),'--fragments-dir',str(d),'--source-commit','0123456789abcdef','--output',str(out),'--require-all'],cwd=ROOT,check=True,capture_output=True,text=True)
    obj=json.loads(out.read_text())
    assert sorted(obj['runtimes'])==ids
    assert all(x['health_status']=='PASS' for x in obj['runtimes'].values())
print('runtime promotion v1.26: PASS')
