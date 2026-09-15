#!/usr/bin/env python3
import json
from jsonschema import Draft202012Validator
schema=json.load(open('schemas/art-direction-patch-v2.schema.json'))
patch={'schema_version':'2.0.0','patch_id':'p','story_id':'s','backend':'python_publication','base_semantic_fingerprint':'a'*64,'base_design_system_hash':'b'*64,'operations':[{'target_id':'story:s:title','field':'title_size','value':25}]}
errs=list(Draft202012Validator(schema).iter_errors(patch)); assert not errs
bad={**patch,'operations':[{'target_id':'story:s:data','field':'value_field','value':'x'}]}; assert list(Draft202012Validator(schema).iter_errors(bad))
print('art direction patch schema v1.34: PASS')
