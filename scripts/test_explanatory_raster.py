#!/usr/bin/env python3
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.etree import ElementTree as ET
import cairosvg

ROOT = Path(__file__).resolve().parents[1]
VIEWS = ["cutaway", "exploded", "anatomy", "system"]
FILES = [
    ROOT / "fixtures" / "explanatory" / f"{view}{suffix}.svg"
    for view in VIEWS
    for suffix in ("", ".mobile")
]

with TemporaryDirectory(prefix="newsroom-explanatory-raster-") as tmp_dir:
    tmp = Path(tmp_dir)
    for index, path in enumerate(FILES):
        if not path.is_file():
            raise SystemExit(f"missing explanatory raster fixture: {path}")
        source = path.read_bytes()
        root = ET.fromstring(source)
        text = "".join(root.itertext())
        if "SCHEMATIC / NOT TO SCALE" not in text:
            raise SystemExit(f"missing schematic disclosure: {path}")
        target = tmp / f"{index}.png"
        cairosvg.svg2png(bytestring=source, write_to=str(target), output_width=320)
        if target.stat().st_size < 1000:
            raise SystemExit(f"rasterized explanatory graphic is unexpectedly small: {path}")

print("explanatory XML+raster smoke: PASS")
print(f"files={len(FILES)}")
