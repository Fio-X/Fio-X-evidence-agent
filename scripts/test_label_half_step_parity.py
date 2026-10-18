#!/usr/bin/env python3
"""The Python integrity verifier judges value labels by the precision they show, exactly as src/verify.rs does (#199).

fixtures/label-verdict-cases.json holds hand-written (kind, label, value, verdict) rows; the Rust test
labels_verdicts_match_the_hand_written_table (src/verify.rs) reads the same file, so one table pins both sides.
fixtures/compact-label-cases.json is what the renderer prints for a grid of values (scripts/test_compact_label_cases.mjs pins it
to the renderer); every renderer label must read back as its value, and not as a value 0.2 of its scale away.
"""
from __future__ import annotations

import json
from pathlib import Path

import verify_artifact as va

FIX = Path(__file__).resolve().parent.parent / "fixtures"


def choropleth_svg(value: float, label: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Fixture</title><desc>Fixture choropleth.</desc>'
        f'<path data-role="choropleth-data" data-iso3="GIN" data-value="{value}" d="M0,0L10,0L10,10L0,10Z"/>'
        '<text data-role="choropleth-label" data-iso3="GIN" x="5" y="5" font-size="12">Guinea</text>'
        f'<text data-role="choropleth-label-value" data-iso3="GIN" x="5" y="5" font-size="12"><tspan>{label}</tspan></text></svg>'
    )


def heatmap_svg(value: float, label: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Fixture</title><desc>Fixture heatmap.</desc>'
        f'<rect data-role="heatmap-cell" data-x="2020" data-y="A" data-value="{value}" x="10" y="10" width="40" height="30"/>'
        f'<text data-role="heatmap-cell-value" data-x="2020" data-y="A" x="30" y="25" text-anchor="middle" font-size="12">{label}</text></svg>'
    )


def verdict_of(kind: str, label: str, value: float) -> str:
    got = va._latin_label_matches(label, value) if kind == "choropleth" else va._heatmap_label_matches(label, value)
    return "unreadable" if got is None else ("match" if got else "mismatch")


def main() -> None:
    table = json.loads((FIX / "label-verdict-cases.json").read_text(encoding="utf-8"))
    assert len(table) >= 40
    for row in table:
        got = verdict_of(row["kind"], row["label"], row["value"])
        assert got == row["verdict"], (row, got)
    # the same labels through the whole-SVG verifiers: a label the table refuses is a failure line, one it accepts is not
    # (the integer-form choropleth labels are the Chinese exact reader's, so only decimal or suffixed labels go through the SVG here)
    for row in table:
        label, value = row["label"], row["value"]
        if row["kind"] == "choropleth":
            if not ("." in label or any(x in label for x in ("k", "m", "bn", "K", "…", "£"))):
                continue
            failures = va.verify_choropleth_labels_from_svg(choropleth_svg(value, label))
        else:
            failures = va.verify_heatmap_labels_from_svg(heatmap_svg(value, label))
        geometry = [f for f in failures if "px" in f or "outside" in f or "geometry" in f]
        failures = [f for f in failures if f not in geometry]
        if row["verdict"] == "match":
            assert failures == [], (row, failures)
        elif row["verdict"] == "mismatch":
            assert any("does not match" in f for f in failures), (row, failures)
        else:
            assert any("no readable number" in f for f in failures), (row, failures)
    # every label the renderer prints reads back; the same text beside a value 0.2 of its scale away does not
    grid = json.loads((FIX / "compact-label-cases.json").read_text(encoding="utf-8"))
    assert len(grid) >= 100
    for case in grid:
        value, label = case["value"], case["label"]
        assert va._latin_label_matches(label, value) is True, (label, value)
        magnitude = abs(value)
        step = 1e9 if magnitude >= 1e9 else 1e6 if magnitude >= 1e6 else 1e3 if magnitude >= 1e3 else 1.0
        assert va._latin_label_matches(label, value + 0.2 * step) is False, (label, value)
    # a NaN data-value is judged as before the change (the finite-value switch refuses it on its own); infinity is refused
    nan, inf = float("nan"), float("inf")
    assert va._latin_label_matches("1.2k", nan) is True and va._latin_label_matches("66.6%", nan) is True
    assert va._latin_label_matches("\u2026", nan) is None and va._heatmap_label_matches("12k", nan) is True
    assert va._latin_label_matches("1.2k", inf) is False and va._heatmap_label_matches("12.5", inf) is False
    # a hand-written pair that does not go through the table: Norway on the Germany page
    assert va.verify_choropleth_labels_from_svg(choropleth_svg(1155.7, "1.2k PJ")) == []
    assert any("does not match" in f for f in va.verify_choropleth_labels_from_svg(choropleth_svg(1155.7, "1.3k PJ")))
    print("label half-step parity (python): PASS")


if __name__ == "__main__":
    main()
