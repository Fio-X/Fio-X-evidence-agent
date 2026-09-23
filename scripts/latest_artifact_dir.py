#!/usr/bin/env python3
"""Print the newest immediate child directory using portable Python semantics."""
from __future__ import annotations

import argparse
from pathlib import Path


def newest_child(root: Path) -> Path | None:
    if not root.is_dir():
        return None
    children = [path for path in root.iterdir() if path.is_dir()]
    if not children:
        return None
    return max(children, key=lambda path: (path.stat().st_mtime_ns, path.name))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    newest = newest_child(args.root)
    if newest is not None:
        print(newest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
