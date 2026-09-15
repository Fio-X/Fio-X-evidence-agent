#!/usr/bin/env python3
from __future__ import annotations
import json,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def build():
    cp=subprocess.run(['python3','scripts/build_release_manifest.py'],cwd=ROOT,capture_output=True,text=True)
    if cp.returncode: raise SystemExit(cp.stderr or cp.stdout)
    return json.loads((ROOT/'release-manifest.json').read_text())
a=build();time.sleep(1.05);b=build()
assert a['source_tree']['sha256']==b['source_tree']['sha256'],(a['source_tree']['sha256'],b['source_tree']['sha256'])
assert a['manifest_sha256']==b['manifest_sha256'],(a['manifest_sha256'],b['manifest_sha256'])
assert all(x['path']!='release-manifest.json' for x in b['source_tree']['files'])
print(json.dumps({'status':'PASS','source_tree_sha256':b['source_tree']['sha256'],'manifest_sha256':b['manifest_sha256'],'file_count':b['source_tree']['file_count']},indent=2))
