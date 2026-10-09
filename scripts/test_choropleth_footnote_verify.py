#!/usr/bin/env python3
"""NEWSROOM_VERIFY_MAP_FOOTNOTES: the independent choropleth value-labels re-derivation also counts the numbered-footnote list rows."""
from __future__ import annotations

import os

import verify_artifact as va


def svg(on_map_name: bool, footnote_name: bool, footnote_value: str) -> str:
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Fixture</title><desc>Fixture choropleth.</desc>',
        '<path data-role="choropleth-data" data-iso3="GIN" data-value="66.6" d="M0,0L10,0L10,10L0,10Z"/>',
    ]
    if on_map_name:
        parts.append('<text data-role="choropleth-label" data-iso3="GIN" x="5" y="5" font-size="12">Guinea</text>')
    if footnote_name:
        parts.append('<text data-role="choropleth-footnote-name" data-iso3="GIN" x="80" y="637" font-size="12.5">Guinea</text>')
    if footnote_value:
        parts.append(f'<text data-role="choropleth-footnote-value" data-iso3="GIN" x="212" y="637" text-anchor="end" font-size="12.5">{footnote_value}</text>')
    parts.append("</svg>")
    return "".join(parts)


ON_MAP = (
    svg(True, False, "")
    .replace("</svg>", '<text data-role="choropleth-label-value" data-iso3="GIN" x="5" y="5" font-size="12"><tspan>66.6%</tspan></text></svg>')
)


def run(switch: str | None, text: str) -> list[str]:
    old = os.environ.get("NEWSROOM_VERIFY_MAP_FOOTNOTES")
    try:
        if switch is None:
            os.environ.pop("NEWSROOM_VERIFY_MAP_FOOTNOTES", None)
        else:
            os.environ["NEWSROOM_VERIFY_MAP_FOOTNOTES"] = switch
        return va.verify_choropleth_labels_from_svg(text)
    finally:
        if old is None:
            os.environ.pop("NEWSROOM_VERIFY_MAP_FOOTNOTES", None)
        else:
            os.environ["NEWSROOM_VERIFY_MAP_FOOTNOTES"] = old


def main() -> None:
    footnoted = svg(False, True, "66.6%")
    assert run("1", footnoted) == [], run("1", footnoted)
    for off in (None, "0", "true", ""):
        failures = run(off, footnoted)
        assert any("GIN" in f and "name labels" in f for f in failures), (off, failures)
        assert any("GIN" in f and "value labels" in f for f in failures), (off, failures)
    wrong = run("1", svg(False, True, "12.3%"))
    assert any("GIN" in f and "does not match" in f for f in wrong), wrong
    nothing = run("1", svg(False, False, ""))
    assert any("name labels" in f for f in nothing) and any("value labels" in f for f in nothing), nothing
    both = run("1", svg(True, True, "66.6%").replace("</svg>", '<text data-role="choropleth-label-value" data-iso3="GIN" x="5" y="5" font-size="12">66.6%</text></svg>'))
    assert any("2 rendered name labels" in f for f in both), both
    assert run(None, ON_MAP) == [] and run("1", ON_MAP) == []
    bad = svg(False, False, "").replace("</svg>", '<text data-role="choropleth-label-value" data-iso3="GIN" x="5" y="5" font-size="12">66.6%</text></svg>')
    assert run(None, bad) == run("1", bad)
    print("PASS choropleth footnote verify: on counts footnote rows, off unchanged, wrong value / no label / double label fail")


if __name__ == "__main__":
    main()
