#!/usr/bin/env python3
import hashlib,json,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as td:
    td=Path(td); req={'backend':'adjacency_matrix','recipe_path':'fixtures/complex/matrix.json','output_dir':str(td/'a'),'inputs':{'table':'fixtures/complex/matrix.json'},'options':{'title':'The same network as a matrix'}}
    rp=td/'req.json'; rp.write_text(json.dumps(req))
    subprocess.run([sys.executable,'runtime/graph/python_adjacency_matrix.py','--request',str(rp)],cwd=ROOT,check=True)
    first=hashlib.sha256((td/'a/figure.svg').read_bytes()).hexdigest()
    req['output_dir']=str(td/'b'); rp.write_text(json.dumps(req)); subprocess.run([sys.executable,'runtime/graph/python_adjacency_matrix.py','--request',str(rp)],cwd=ROOT,check=True)
    second=hashlib.sha256((td/'b/figure.svg').read_bytes()).hexdigest(); assert first==second,(first,second)
    manifest=json.loads((td/'b/manifest.json').read_text()); assert manifest['nodes']>=8 and manifest['edges']==12
print('adjacency backend v1.20 PASS')
