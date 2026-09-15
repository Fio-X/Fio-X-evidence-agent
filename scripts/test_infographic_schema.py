#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
schema = json.loads((ROOT / 'schemas' / 'infographic-spec.schema.json').read_text(encoding='utf-8'))
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)

valid = {
    'schema_version': '1.0.0',
    'kicker': 'Energy feature',
    'title': 'How the energy system fits together',
    'dek': 'A magazine-style feature combines verified statistics and visuals into one editorial composition.',
    'alt': 'A magazine infographic combines a large headline, verified hero statistics, two charts and explanatory text.',
    'layout': 'feature',
    'complexity_budget': 'medium',
    'modules': [
        {'id':'stat-1','type':'hero_stat','span':'third','value':'94.2','unit':'quads','label':'Total energy','claim_id':'claim-1'},
        {'id':'viz-1','type':'visual','span':'two_thirds','manifest_ref':'visualizations/a.json','label':'The big picture'},
        {'id':'text-1','type':'text','span':'full','heading':'What matters','body':'Verified explanatory copy.', 'claim_ids':['claim-1']},
    ],
}
errors = list(validator.iter_errors(valid))
if errors:
    raise SystemExit('valid infographic rejected: ' + ' | '.join(e.message for e in errors))

bad = json.loads(json.dumps(valid))
bad['modules'][0].pop('claim_id')
errors = list(validator.iter_errors(bad))
if not errors:
    raise SystemExit('hero_stat without claim_id was accepted')

bad_visual = json.loads(json.dumps(valid))
bad_visual['modules'][1].pop('manifest_ref')
if not list(validator.iter_errors(bad_visual)):
    raise SystemExit('visual without manifest_ref was accepted')


valid_v11 = json.loads(json.dumps(valid))
valid_v11.update({
    'schema_version': '1.1.0',
    'intent': 'Explain a verified system with a fast takeaway and a deeper evidence path.',
    'primary_message': 'One coherent page should preserve hierarchy, provenance and responsive reading order.',
    'story_arc': 'explain',
    'audience': 'informed',
    'quality_target': 'award',
})
valid_v11['modules'][0].update({'story_role':'hook','priority':1,'emphasis':'primary'})
valid_v11['modules'][1].update({'story_role':'evidence','priority':1,'emphasis':'hero'})
valid_v11['modules'][2].update({'story_role':'resolution','priority':3,'emphasis':'secondary'})
errors = list(validator.iter_errors(valid_v11))
if errors:
    raise SystemExit('valid 1.1 infographic rejected: ' + ' | '.join(e.message for e in errors))

bad_v11 = json.loads(json.dumps(valid_v11))
bad_v11.pop('primary_message')
if not list(validator.iter_errors(bad_v11)):
    raise SystemExit('1.1 infographic without primary_message was accepted')


valid_illustration = json.loads(json.dumps(valid_v11))
valid_illustration['modules'].insert(2, {
    'id':'ill-1','type':'illustration','span':'full',
    'asset_ref':'visualizations/illustrations/a.json',
    'alt':'A schematic cutaway explains the verified system layers in a not-to-scale editorial illustration.',
    'credit':'Semantic schematic based on verified reporting',
    'claim_ids':['claim-1'],
    'story_role':'explanation','priority':2,'emphasis':'primary'
})
errors = list(validator.iter_errors(valid_illustration))
if errors:
    raise SystemExit('valid illustration module rejected: ' + ' | '.join(e.message for e in errors))
bad_illustration = json.loads(json.dumps(valid_illustration))
bad_illustration['modules'][2].pop('credit')
if not list(validator.iter_errors(bad_illustration)):
    raise SystemExit('illustration without credit was accepted')

bad_priority = json.loads(json.dumps(valid_v11))
bad_priority['modules'][0]['priority'] = 8
if not list(validator.iter_errors(bad_priority)):
    raise SystemExit('module priority outside 1..5 was accepted')

valid_v12 = json.loads(json.dumps(valid_v11))
valid_v12.update({
    'schema_version': '1.2.0',
    'competition_profile': 'oja2026_visual',
    'mobile_module_order': ['viz-1', 'stat-1', 'text-1'],
})
errors = list(validator.iter_errors(valid_v12))
if errors:
    raise SystemExit('valid 1.2 infographic rejected: ' + ' | '.join(e.message for e in errors))

bad_v12_profile = json.loads(json.dumps(valid_v12))
bad_v12_profile.pop('competition_profile')
if not list(validator.iter_errors(bad_v12_profile)):
    raise SystemExit('1.2 infographic without competition_profile was accepted')

bad_v12_order = json.loads(json.dumps(valid_v12))
bad_v12_order['mobile_module_order'] = ['viz-1', 'viz-1', 'text-1']
if not list(validator.iter_errors(bad_v12_order)):
    raise SystemExit('1.2 infographic with duplicate mobile order entries was accepted')


valid_v13 = json.loads(json.dumps(valid_v12))
valid_v13.update({
    'schema_version': '1.3.0',
    'editorial_discovery_ref': 'editorial/discovery/a.json',
    'visual_concept_ref': 'editorial/concepts/a.json',
    'selected_concept_id': 'concept-a',
    'novelty_ref': 'editorial/novelty/a.json',
    'asset_plan_ref': 'editorial/assets/a.json',
    'scene_graph': {
        'schema_version': '0.1.0',
        'scenes': [{
            'id': 'hero-scene', 'pattern': 'hero_sidecar_stack',
            'anchor_module_id': 'viz-1', 'sidecar_module_ids': ['stat-1', 'text-1'],
            'title': 'One integrated visual scene'
        }]
    },
})
errors = list(validator.iter_errors(valid_v13))
if errors:
    raise SystemExit('valid 1.3 infographic rejected: ' + ' | '.join(e.message for e in errors))

bad_v13_asset = json.loads(json.dumps(valid_v13))
bad_v13_asset.pop('asset_plan_ref')
if not list(validator.iter_errors(bad_v13_asset)):
    raise SystemExit('1.3 award infographic without asset_plan_ref was accepted')

bad_scene = json.loads(json.dumps(valid_v13))
bad_scene['scene_graph']['scenes'][0]['pattern'] = 'freeform_canvas'
if not list(validator.iter_errors(bad_scene)):
    raise SystemExit('1.3 infographic accepted unsupported freeform scene pattern')

print('infographic schema: PASS')
print('draft: 2020-12')
print('module conditional checks + v1.3 scene/editorial fields: PASS')

valid_v14 = json.loads(json.dumps(valid_v13))
valid_v14.update({
    'schema_version':'1.4.0',
    'reader_question':'Why does the verified system behave this way?',
    'visual_thesis':'Multiple verified signals combine into one explanatory path.',
    'story_graph_ref':'editorial/story-graphs/a.json',
})
valid_v14['modules'][0]['story_node_ids']=['n1']
valid_v14['modules'][1].update({'story_node_ids':['n2'],'visual_grammar':'rank'})
valid_v14['modules'][2]['story_node_ids']=['n3']
errors = list(validator.iter_errors(valid_v14))
if errors:
    raise SystemExit('valid 1.4 infographic rejected: ' + ' | '.join(e.message for e in errors))
bad_v14 = json.loads(json.dumps(valid_v14))
bad_v14.pop('story_graph_ref')
if not list(validator.iter_errors(bad_v14)):
    raise SystemExit('1.4 infographic without story_graph_ref was accepted')
print('v1.4 reader-question/story-graph fields: PASS')
