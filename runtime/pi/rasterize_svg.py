#!/usr/bin/env python3
import argparse
from pathlib import Path
import cairosvg

MAX_SVG_BYTES = 5_000_000


def main() -> int:
    parser = argparse.ArgumentParser(description="Rasterize a trusted newsroom SVG to PNG for visual review")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--width", type=int, required=True)
    args = parser.parse_args()
    src = Path(args.input).resolve()
    dst = Path(args.output).resolve()
    if args.width < 320 or args.width > 1800:
        raise SystemExit("width must be between 320 and 1800")
    if not src.is_file():
        raise SystemExit("input SVG does not exist")
    if src.stat().st_size > MAX_SVG_BYTES:
        raise SystemExit("input SVG exceeds 5 MB")
    dst.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(url=str(src), write_to=str(dst), output_width=args.width)
    if not dst.is_file() or dst.stat().st_size == 0:
        raise SystemExit("rasterizer did not produce a PNG")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
