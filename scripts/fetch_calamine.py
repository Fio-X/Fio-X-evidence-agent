#!/usr/bin/env python3
"""Fetch the python-calamine wheel the spreadsheet converter loads (NEWSROOM_XLS_CONVERT=1).

Nothing is installed into any Python environment. Version, interpreter tag and the sha256 of the
wheel are pinned below; a mismatch fails and leaves nothing behind. The downloaded bytes are
untrusted: they are only hashed and unzipped here (the package files only, no path outside DIR),
never executed. The product's own interpreter (NEWSROOM_PYTHON_BIN) imports the unpacked package
at conversion time, so the tag must match that interpreter's ABI; a mismatch is an explicit error.

  fetch_calamine.py --out DIR                  download from pypi.org
  fetch_calamine.py --out DIR --from-whl F     use a local wheel instead (tests, offline bundles)

DIR must not exist or must be empty; the result is DIR/<tag>/python_calamine/. Point
NEWSROOM_XLS_CONVERT_DIR at DIR. No runtime network: conversion only reads this directory.
"""
import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "0.8.3"
PYPI_JSON = f"https://pypi.org/pypi/python-calamine/{VERSION}/json"
# sha256 of the wheel file, taken from the copy pip downloaded from pypi.org (macOS 11+ arm64 wheels, the product's platform).
PINS = {
    "cp313": ("python_calamine-0.8.3-cp313-cp313-macosx_11_0_arm64.whl", "6cbecb00dc8d7b8c892ef04458b370b815cad92dd8699f2d9b023700dd6b5170"),
    "cp314": ("python_calamine-0.8.3-cp314-cp314-macosx_11_0_arm64.whl", "2d62f38165cabca6740c24e438aaca3e47fda4f047b9ebdd6a7bab02d546f846"),
}
MAX_WHEEL = 16 * 1024 * 1024
MAX_UNPACKED = 64 * 1024 * 1024


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def unpack(whl, target):
    total = 0
    root = os.path.realpath(target)
    with zipfile.ZipFile(whl) as archive:
        for info in archive.infolist():
            name = info.filename
            if not name.startswith("python_calamine/") or info.is_dir():
                continue  # dist-info and anything else stays in the zip
            dest = os.path.realpath(os.path.join(root, name))
            if os.path.commonpath([root, dest]) != root or ".." in name.split("/"):
                raise ValueError(f"unsafe path in wheel: {name!r}")
            total += info.file_size
            if total > MAX_UNPACKED:
                raise ValueError("unpacked wheel is larger than the limit")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with archive.open(info) as source, open(dest, "wb") as sink:
                shutil.copyfileobj(source, sink)


def fetch(tag, out, from_whl=None):
    if tag not in PINS:
        raise ValueError(f"no pinned wheel for tag {tag}; pinned: {', '.join(sorted(PINS))}")
    filename, expected = PINS[tag]
    if os.path.exists(out) and (not os.path.isdir(out) or os.listdir(out)):
        raise ValueError(f"{out} must not exist or must be an empty directory")
    created = not os.path.exists(out)
    work = tempfile.mkdtemp(prefix="calamine-")
    try:
        whl = from_whl
        if whl is None:
            whl = os.path.join(work, filename)
            import json
            with urllib.request.urlopen(PYPI_JSON, timeout=60) as response:
                listing = json.load(response)
            url = next((item["url"] for item in listing.get("urls", []) if item.get("filename") == filename), None)
            if not url or not url.startswith("https://files.pythonhosted.org/"):
                raise ValueError(f"{filename} is not listed on pypi.org for {VERSION}")
            with urllib.request.urlopen(url, timeout=60) as response, open(whl, "wb") as sink:
                shutil.copyfileobj(response, sink)
        if os.path.getsize(whl) > MAX_WHEEL:
            raise ValueError("wheel is larger than the limit")
        actual = sha256_of(whl)
        if actual != expected:
            raise ValueError(f"sha256 mismatch for {filename}: expected {expected}, got {actual}")
        target = os.path.join(out, tag)
        os.makedirs(target, exist_ok=True)
        unpack(whl, target)
        with open(os.path.join(target, "WHEEL.sha256"), "w") as sink:
            sink.write(f"{expected}  {filename}\n")
        return target
    except Exception:
        # nothing left behind: remove what this call made (the directory itself only if this call created it)
        if created:
            shutil.rmtree(out, ignore_errors=True)
        elif os.path.isdir(out):
            for entry in os.listdir(out):
                shutil.rmtree(os.path.join(out, entry), ignore_errors=True)
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--tag", default="cp313")
    parser.add_argument("--from-whl")
    args = parser.parse_args(argv)
    try:
        print(fetch(args.tag, args.out, args.from_whl))
    except Exception as error:  # noqa: BLE001 - one line, no traceback, nothing left behind
        print(f"fetch_calamine: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
