#!/usr/bin/env python3
import json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
m=json.loads((ROOT/'runtimes/build-matrix.json').read_text())
assert len(m['runtimes'])>=10
for rid,row in m['runtimes'].items(): assert (ROOT/row['definition']).exists(), (rid,row)
p=subprocess.run([str(ROOT/'scripts/bootstrap_visual_runtimes.sh'),'--dry-run'],cwd=ROOT,capture_output=True,text=True,check=True)
for rid in m['runtimes']: assert f'[{rid}]' in p.stdout
health=(ROOT/'scripts/runtime_image_health.sh').read_text()
for rid in m['runtimes']: assert rid in health
print('runtime build plan v1.16 PASS')
