#!/usr/bin/env python3
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'fixtures' / 'infographic' / 'magazine-regression.svg'
with tempfile.TemporaryDirectory() as tmp:
    output = Path(tmp) / 'preview.png'
    subprocess.run(['python3', str(root / 'runtime/pi/rasterize_svg.py'), str(source), str(output), '--width', '900'], check=True)
    data = output.read_bytes()
    assert data.startswith(b'\x89PNG\r\n\x1a\n')
    assert len(data) > 1000
print('infographic preview raster test: PASS')
