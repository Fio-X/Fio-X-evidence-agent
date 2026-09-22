#!/usr/bin/env python3
import json
from jsonschema import Draft202012Validator
schema=json.load(open('schemas/art-direction-patch-v2.schema.json'))
patch={'schema_version':'2.1.0','patch_id':'p','story_id':'s','backend':'python_publication','base_semantic_fingerprint':'a'*64,'base_design_system_hash':'b'*64,'operations':[{'operation_id':'op-1','validator_rule_id':'layout.title_hierarchy','scene_id':'scene:s','object_id':'title','op':'replace','path':'/options/title_size','value':25,'viewports':['desktop']}]}
errs=list(Draft202012Validator(schema).iter_errors(patch)); assert not errs
bad={**patch,'operations':[{'operation_id':'op-bad','validator_rule_id':'x','scene_id':'scene:s','object_id':'data','op':'replace','path':'/inputs/value_field','value':'x'}]}; assert list(Draft202012Validator(schema).iter_errors(bad))
print('art direction patch schema v1.34: PASS')
