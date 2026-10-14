#!/usr/bin/env python3
import json, subprocess, tempfile
from pathlib import Path
import jsonschema
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/publication-spec.schema.json').read_text())
validator=jsonschema.Draft202012Validator(schema)
# The inputs are built here by the tests that make them, not read from outputs/ (git-ignored, and written
# there by those tests only if they happened to run first).
_TMP=tempfile.TemporaryDirectory(prefix='newsroom-publication-schema-')
def build(script: str, name: str) -> Path:
    dest=Path(_TMP.name)/name
    built=subprocess.run(['node',str(ROOT/'scripts'/script),'--out',str(dest)],cwd=ROOT,capture_output=True,text=True)
    if built.returncode != 0: raise SystemExit(f'building {name} with {script} failed:\n{built.stdout}{built.stderr}')
    return dest
BROWSER=build('test_browser_publication_v19.mjs','v19-browser')
TRUSTED=build('test_trusted_publication_v112.mjs','v112-trusted')
for p in [BROWSER/'energy-publication.json',BROWSER/'network-publication.json',TRUSTED/'archive-spec.json',TRUSTED/'production-spec.json']:
    if p.exists(): validator.validate(json.loads(p.read_text()))
energy=json.loads((BROWSER/'energy-publication.json').read_text())
bad=dict(energy); bad.pop('infographic_plan_ref')
try: validator.validate(bad)
except jsonschema.ValidationError: pass
else: raise SystemExit('missing infographic_plan_ref should fail')
trusted=json.loads((TRUSTED/'archive-spec.json').read_text())
if trusted.get('schema_version')!='0.3.0': raise SystemExit('trusted fixture must exercise PublicationSpec 0.3')
print('publication schema v0.1/v0.3: PASS')
