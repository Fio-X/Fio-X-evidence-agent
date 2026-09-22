#!/usr/bin/env python3
"""Build a bounded, deterministic fixture from the published model estimates.

The output contains estimated annual flows, not observed flows, migrant stocks,
or stock changes. The raw NetCDF and lookup files are intentionally kept out of
the repository; their expected hashes pin the exact upstream revision.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
from pathlib import Path

from scipy.io import netcdf_file

FLOW_SHA256 = "3f29fc7a3fe6b63657ea08e4383a362a5152b00b806c26ff8e7e3d5fbfd50014"
LOOKUP_SHA256 = "f6bcc9bbb418c7393af040f8768596e2d8bd3f8503a264bf2def27b2f72ed743"
YEARS = (1990, 2000, 2010, 2020, 2023)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode_iso(values) -> list[str]:
    return [b"".join(row).decode("ascii") for row in values]


def load_names(path: Path) -> dict[str, str]:
    with path.open(encoding="utf-8", newline="") as handle:
        return {row["Alpha-3 code"]: row["Country"] for row in csv.DictReader(handle)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("flows", type=Path)
    parser.add_argument("lookup", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--top", type=int, default=30)
    args = parser.parse_args()
    if sha256(args.flows) != FLOW_SHA256:
        raise SystemExit("flows.nc SHA-256 does not match the pinned source")
    if sha256(args.lookup) != LOOKUP_SHA256:
        raise SystemExit("ISO lookup SHA-256 does not match the pinned source")
    if not 1 <= args.top <= 100:
        raise SystemExit("--top must be between 1 and 100")

    names = load_names(args.lookup)
    with netcdf_file(args.flows, "r", mmap=False) as dataset:
        years = [int(value) for value in dataset.variables["Year"].data.copy()]
        origins = decode_iso(dataset.variables["Origin ISO"].data.copy())
        destinations = decode_iso(dataset.variables["Destination ISO"].data.copy())
        means = dataset.variables["mean"].data.copy()
        standard_deviations = dataset.variables["std"].data.copy()

    rows = []
    for year in YEARS:
        year_index = years.index(year)
        candidates = []
        for origin_index, origin_iso in enumerate(origins):
            for destination_index, destination_iso in enumerate(destinations):
                mean = float(means[year_index, origin_index, destination_index])
                std = float(standard_deviations[year_index, origin_index, destination_index])
                if origin_iso == destination_iso or not math.isfinite(mean) or mean < 0:
                    continue
                candidates.append((mean, origin_iso, destination_iso, std))
        candidates.sort(key=lambda row: (-row[0], row[1], row[2]))
        for rank, (mean, origin_iso, destination_iso, std) in enumerate(candidates[: args.top], 1):
            rows.append(
                {
                    "year": year,
                    "rank_within_year": rank,
                    "origin_iso3": origin_iso,
                    "origin_name": names.get(origin_iso, origin_iso),
                    "destination_iso3": destination_iso,
                    "destination_name": names.get(destination_iso, destination_iso),
                    "estimated_flow_mean": f"{mean:.6f}",
                    "estimated_flow_std": f"{std:.6f}",
                    "estimate_semantics": "model_estimated_annual_origin_destination_flow",
                }
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows to {args.output}")


if __name__ == "__main__":
    main()
