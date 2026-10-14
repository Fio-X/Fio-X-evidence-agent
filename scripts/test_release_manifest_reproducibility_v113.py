#!/usr/bin/env python3
from __future__ import annotations
import json,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'release-manifest.json'
ORIGINAL=MANIFEST.read_bytes() if MANIFEST.exists() else None
def restore():
    # The builder rewrites release-manifest.json in the work tree; put the committed bytes back.
    if ORIGINAL is None:
        MANIFEST.unlink(missing_ok=True)
    elif MANIFEST.read_bytes()!=ORIGINAL:
        MANIFEST.write_bytes(ORIGINAL)
def build():
    cp=subprocess.run(['python3','scripts/build_release_manifest.py'],cwd=ROOT,capture_output=True,text=True)
    if cp.returncode: raise SystemExit(cp.stderr or cp.stdout)
    return json.loads((ROOT/'release-manifest.json').read_text())
try:
    a=build();time.sleep(1.05);b=build()
finally:
    restore()
assert a['source_tree']['sha256']==b['source_tree']['sha256'],(a['source_tree']['sha256'],b['source_tree']['sha256'])
assert a['manifest_sha256']==b['manifest_sha256'],(a['manifest_sha256'],b['manifest_sha256'])
assert all(x['path']!='release-manifest.json' for x in b['source_tree']['files'])
assert all(not x['path'].startswith('target/') for x in b['source_tree']['files'])
assert all(x['path'] != '.env' and not x['path'].startswith(('logs/', 'codex-session-')) for x in b['source_tree']['files'])
print(json.dumps({'status':'PASS','source_tree_sha256':b['source_tree']['sha256'],'manifest_sha256':b['manifest_sha256'],'file_count':b['source_tree']['file_count']},indent=2))
