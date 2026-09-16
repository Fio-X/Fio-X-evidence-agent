#!/usr/bin/env python3
import json
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/story-graph.schema.json').read_text())
Draft202012Validator.check_schema(schema)
validator=Draft202012Validator(schema)
valid={
 'schema_version':'0.1.0','story_id':'food-risk','reader_question':'Why can food-price risk remain elevated?','visual_thesis':'Weather instability and yield risk connect to prices.',
 'nodes':[
  {'id':'weather','kind':'evidence','summary':'Rainfall was unstable.','explanatory_dimension':'trend','claim_ids':['c1']},
  {'id':'yield','kind':'outcome','summary':'Yield risk rose.','explanatory_dimension':'outcome','claim_ids':['c2']},
  {'id':'price','kind':'outcome','summary':'Food-price risk stayed elevated.','explanatory_dimension':'outcome','claim_ids':['c3']},
 ],
 'edges':[{'from':'weather','to':'yield','relation':'contributes_to'},{'from':'yield','to':'price','relation':'contributes_to'}],
 'entry_node_ids':['weather'],'answer_node_ids':['price']
}
errs=list(validator.iter_errors(valid))
if errs: raise SystemExit('valid StoryGraph rejected: '+' | '.join(e.message for e in errs))
bad=json.loads(json.dumps(valid));bad['edges'][0]['relation']='same_axis'
if not list(validator.iter_errors(bad)): raise SystemExit('unsupported StoryGraph relation accepted')
print('story graph schema v0.1: PASS')
