#!/usr/bin/env python3
import json
from jsonschema import Draft202012Validator
schema=json.load(open('schemas/editorial-design-system.schema.json'))
data=json.load(open('config/editorial-design-systems.json'))
errors=sorted(Draft202012Validator(schema).iter_errors(data),key=lambda e:list(e.path))
assert not errors, '\n'.join(e.message for e in errors)
ids=[x['id'] for x in data['systems']]; assert len(ids)==len(set(ids)) and len(ids)>=6
print('design system schema v1.32: PASS')
