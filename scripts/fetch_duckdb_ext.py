#!/usr/bin/env python3
"""Fetch the DuckDB extensions the bundled-extension switch loads (NEWSROOM_DUCKDB_BUNDLED_EXT=1).

Binaries are never committed. Version, platform and the sha256 of the unpacked extension are pinned
below; a mismatch fails and leaves nothing behind. The downloaded bytes are untrusted: they are only
hashed and unpacked here, never executed or loaded. DuckDB additionally verifies its own signature
when the extension is loaded (unsigned extensions stay refused).

  fetch_duckdb_ext.py --out DIR               download from extensions.duckdb.org
  fetch_duckdb_ext.py --out DIR --from-gz F   use a local .gz instead (tests, offline bundles)

DIR must not exist or must be empty; the result is DIR/<version>/<platform>/<name>.duckdb_extension.
Point NEWSROOM_DUCKDB_EXT_DIR at DIR. No httpfs: SQL must not reach the network by itself.
"""
import argparse
import gzip
import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request

BASE_URL = "https://extensions.duckdb.org"
VERSION = "v1.5.5"
# sha256 of the unpacked extension file. The pin was taken from the copy DuckDB v1.5.5 itself installed
# from the official repository on osx_arm64; other platforms have no pin yet and are refused.
PINS = {
    ("excel", "osx_arm64"): "9500a2841e8b3dda698e1e541fb58e76920f25ac752931de61d9b0fc7d8e97ec",
}
MAX_UNPACKED = 64 * 1024 * 1024


def unpack(gz_path, limit=MAX_UNPACKED):
    digest = hashlib.sha256()
    chunks = []
    total = 0
    with gzip.open(gz_path, "rb") as handle:
        while True:
            block = handle.read(1 << 20)
            if not block:
                break
            total += len(block)
            if total > limit:
                raise ValueError("unpacked extension is larger than the limit")
            digest.update(block)
            chunks.append(block)
    return b"".join(chunks), digest.hexdigest()


def fetch(name, platform, out, from_gz=None):
    expected = PINS.get((name, platform))
    if not expected:
        raise ValueError(f"no pinned sha256 for {name} on {platform}")
    if os.path.exists(out) and (not os.path.isdir(out) or os.listdir(out)):
        raise ValueError(f"{out} must not exist or must be an empty directory")
    work = tempfile.mkdtemp(prefix="duckdb-ext-")
    try:
        gz_path = from_gz
        if gz_path is None:
            gz_path = os.path.join(work, "download.gz")
            url = f"{BASE_URL}/{VERSION}/{platform}/{name}.duckdb_extension.gz"
            with urllib.request.urlopen(url, timeout=60) as response, open(gz_path, "wb") as sink:
                shutil.copyfileobj(response, sink)
        data, actual = unpack(gz_path)
        if actual != expected:
            raise ValueError(f"sha256 mismatch for {name}: expected {expected}, got {actual}")
        target_dir = os.path.join(out, VERSION, platform)
        os.makedirs(target_dir, exist_ok=True)
        target = os.path.join(target_dir, f"{name}.duckdb_extension")
        with open(target, "wb") as sink:
            sink.write(data)
        return target
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default="excel")
    parser.add_argument("--platform", default="osx_arm64")
    parser.add_argument("--from-gz")
    args = parser.parse_args(argv)
    try:
        print(fetch(args.name, args.platform, args.out, args.from_gz))
    except Exception as error:  # noqa: BLE001 - one line, no traceback, nothing left behind
        print(f"fetch_duckdb_ext: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
