#!/usr/bin/env python3
import json
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'runtime/gis/visual_recipe.schema.json').read_text())
Draft202012Validator.check_schema(schema)
valid={
 'schema_version':'2.0.0','analytical_job':'flow','artifact_mode':'static_editorial','story_family':'maritime_trajectory',
 'data_profile':{'geometry':'trajectory','mark_count':15,'temporal':True},
 'geography':{'enabled':True,'scale':'local','projection_policy':'local_metric','terrain':False,'bathymetry':False,'context_layers':['coastline']},
 'network':{'enabled':False},'annotation':{'label_count':20,'direct_labels':True},
 'delivery':{'print':True,'interactive':False,'mobile':True,'vector_required':True},'backend_hints':{'qualification_mode':True},'generated_imagery':False
}
Draft202012Validator(schema).validate(valid)
semantic={**valid,
 'measure_semantics':[
   {'id':'current','phenomenon':'vessel_transits','unit':'vessels/day','measure_kind':'rate','temporal_basis':{'type':'point_in_time'},'observation_status':'observed','aggregation':'daily','value':7},
   {'id':'baseline','phenomenon':'vessel_transits','unit':'vessels/day','measure_kind':'rate','temporal_basis':{'type':'point_in_time'},'observation_status':'observed','aggregation':'daily','value':125}
 ],
 'claim_spec':{'claim_id':'claim:hormuz','relation':'change','reader_task':'magnitude_of_change','target_measure':'current','baseline_measure':'baseline','derived_metric':'percent_change'}
}
Draft202012Validator(schema).validate(semantic)
missing_claim={**valid,'measure_semantics':semantic['measure_semantics']}
assert list(Draft202012Validator(schema).iter_errors(missing_claim)), 'measure_semantics without claim_spec should fail'
invalid={**valid,'artifact_mode':'interactive','delivery':{**valid['delivery'],'interactive':False}}
assert list(Draft202012Validator(schema).iter_errors(invalid)), 'interactive contradiction should fail'
print('visual recipe schema v1.17 PASS')
