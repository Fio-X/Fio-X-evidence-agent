#!/usr/bin/env python3
from pathlib import Path
import importlib.util, json
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('gx',ROOT/'runtime/graph/graphrag_to_evidence.py'); gx=importlib.util.module_from_spec(spec); spec.loader.exec_module(gx)
tables={
 'entities':[
  {'id':'e2','title':'Beta Ltd','type':'organization','description':'Target','text_unit_ids':['t2'],'frequency':1,'degree':1},
  {'id':'e1','title':'Alpha Corp','type':'organization','description':'Source','text_unit_ids':['t1','t2'],'frequency':2,'degree':1},
 ],
 'relationships':[{'id':'r1','source':'Alpha Corp','target':'Beta Ltd','description':'owns a stake in','weight':7.5,'combined_degree':2,'text_unit_ids':['t2']}],
 'communities':[{'id':'c1','community':0,'parent':None,'children':[],'level':0,'title':'Corporate cluster','entity_ids':['e2','e1'],'relationship_ids':['r1'],'text_unit_ids':['t2'],'size':2}],
 'covariates':[{'id':'x1','covariate_type':'claim','type':'ownership','description':'Alpha owns a stake in Beta','subject_id':'Alpha Corp','object_id':'Beta Ltd','status':'SUSPECTED','start_date':None,'end_date':None,'source_text':'Alpha acquired a stake in Beta.','text_unit_id':'t2'}]
}
a=gx.normalize_tables(tables,extractor_version='3.1.2',method='standard')
b=gx.normalize_tables(tables,extractor_version='3.1.2',method='standard')
assert a==b
assert [n['id'] for n in a['nodes']]==['e1','e2']
assert a['edges'][0]['source']=='e1' and a['edges'][0]['target']=='e2'
assert a['claims'][0]['subject']=='e1' and a['claims'][0]['object']=='e2'
assert a['claims'][0]['evidence_text_unit_ids']==['t2']
schema=json.loads((ROOT/'schemas/graph-extraction-result.schema.json').read_text())
errors=list(Draft202012Validator(schema).iter_errors(a))
assert not errors, [e.message for e in errors]
bad={k:list(v) if isinstance(v,list) else v for k,v in tables.items()}; bad['relationships']=[dict(tables['relationships'][0],target='Missing Entity')]
try: gx.normalize_tables(bad)
except ValueError: pass
else: raise AssertionError('missing relationship endpoint was accepted')
print('graph extraction v1.25 PASS')
