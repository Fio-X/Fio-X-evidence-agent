#!/usr/bin/env python3
import json, subprocess, tempfile
from pathlib import Path
import jsonschema
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/model-spec.schema.json').read_text())
# The inputs are built here by the tests that make them, not read from outputs/ (git-ignored, and written
# there by those tests only if they happened to run first).
_TMP=tempfile.TemporaryDirectory(prefix='newsroom-model-spec-')
def build(script: str, name: str) -> Path:
    dest=Path(_TMP.name)/name
    built=subprocess.run(['node',str(ROOT/'scripts'/script),'--out',str(dest)],cwd=ROOT,capture_output=True,text=True)
    if built.returncode != 0: raise SystemExit(f'building {name} with {script} failed:\n{built.stdout}{built.stderr}')
    return dest
model=json.loads((build('test_browser_publication_v19.mjs','v19-browser')/'energy-model.json').read_text())
jsonschema.Draft202012Validator(schema).validate(model)
print('model schema v0.1: PASS')
