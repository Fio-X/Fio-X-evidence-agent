#!/usr/bin/env python3
import subprocess, sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(root/'scripts/build_visual_skill_bundle.py')],check=True,capture_output=True,text=True)
text=(root/'runtime/pi/visual_skill_bundle.mjs').read_text()
for name in ['python-gis','r-editorial','qgis-cartography','pygmt-scientific','datashader-density','sigma-network','editorial-chart']:
    assert f'"{name}"' in text
print('visual skill bundle v1.16 PASS')
