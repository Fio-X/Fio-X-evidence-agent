#!/usr/bin/env python3
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.etree import ElementTree as ET
import cairosvg

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ROOT / "fixtures" / "infographic" / "magazine-regression.svg",
    ROOT / "fixtures" / "infographic" / "magazine-regression.mobile.svg",
    ROOT / "fixtures" / "infographic" / "award-regression.svg",
    ROOT / "fixtures" / "infographic" / "award-regression.mobile.svg",
    ROOT / "outputs" / "infographic" / "eia-us-energy-feature-2024.svg",
    ROOT / "outputs" / "infographic" / "eia-us-energy-feature-2024.mobile.svg",
]
with TemporaryDirectory(prefix="newsroom-infographic-raster-") as tmp:
    tmp = Path(tmp)
    for index, path in enumerate(FILES):
        if not path.is_file():
            raise SystemExit(f"missing infographic raster fixture: {path}")
        source = path.read_bytes()
        ET.fromstring(source)
        target = tmp / f"{index}.png"
        cairosvg.svg2png(bytestring=source, write_to=str(target), output_width=320)
        if target.stat().st_size < 1000:
            raise SystemExit(f"rasterized infographic is unexpectedly small: {path}")
print("infographic XML+raster smoke: PASS")
print(f"files={len(FILES)}")
