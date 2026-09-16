#!/usr/bin/env python3
import json, subprocess
from pathlib import Path
import jsonschema
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/model-spec.schema.json').read_text())
model=json.loads((ROOT/'outputs/v19-browser/energy-model.json').read_text())
jsonschema.Draft202012Validator(schema).validate(model)
print('model schema v0.1: PASS')
