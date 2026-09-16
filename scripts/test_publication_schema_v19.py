#!/usr/bin/env python3
import json
from pathlib import Path
import jsonschema
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/publication-spec.schema.json').read_text())
validator=jsonschema.Draft202012Validator(schema)
for rel in ['outputs/v19-browser/energy-publication.json','outputs/v19-browser/network-publication.json','outputs/v112-trusted/archive-spec.json','outputs/v112-trusted/production-spec.json']:
    p=ROOT/rel
    if p.exists(): validator.validate(json.loads(p.read_text()))
energy=json.loads((ROOT/'outputs/v19-browser/energy-publication.json').read_text())
bad=dict(energy); bad.pop('infographic_plan_ref')
try: validator.validate(bad)
except jsonschema.ValidationError: pass
else: raise SystemExit('missing infographic_plan_ref should fail')
trusted=json.loads((ROOT/'outputs/v112-trusted/archive-spec.json').read_text())
if trusted.get('schema_version')!='0.3.0': raise SystemExit('trusted fixture must exercise PublicationSpec 0.3')
print('publication schema v0.1/v0.3: PASS')
