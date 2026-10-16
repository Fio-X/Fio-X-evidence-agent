#!/usr/bin/env python3
"""A country drawn as several choropleth-data regions with one value counts as one value; two different values still fail."""
from __future__ import annotations

import os

import verify_artifact as va

PATH = '<path data-role="choropleth-data" data-iso3="AUS" data-value="{v}" d="M0,0L10,0L10,10L0,10Z"/>'
NAME = '<text data-role="choropleth-label" data-iso3="AUS" x="5" y="5" font-size="12">Australia</text>'
VALUE = '<text data-role="choropleth-label-value" data-iso3="AUS" x="5" y="5" font-size="12">5.5%</text>'


def svg(values: list[str], labels: bool = True) -> str:
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Fixture</title><desc>Fixture choropleth.</desc>']
    parts += [PATH.format(v=v) for v in values]
    if labels:
        parts += [NAME, VALUE]
    parts.append("</svg>")
    return "".join(parts)


def run(text: str, strict: str | None = None) -> list[str]:
    old = os.environ.get("NEWSROOM_VERIFY_STRICT_READERS")
    try:
        if strict is None:
            os.environ.pop("NEWSROOM_VERIFY_STRICT_READERS", None)
        else:
            os.environ["NEWSROOM_VERIFY_STRICT_READERS"] = strict
        return va.verify_choropleth_labels_from_svg(text)
    finally:
        if old is None:
            os.environ.pop("NEWSROOM_VERIFY_STRICT_READERS", None)
        else:
            os.environ["NEWSROOM_VERIFY_STRICT_READERS"] = old


def main() -> None:
    for strict in (None, "1"):
        assert run(svg(["5.5"]), strict) == [], strict
        assert run(svg(["5.5", "5.5", "5.5"]), strict) == [], strict
        assert run(svg(["5.5", "5.50"]), strict) == [], strict
        conflict = run(svg(["5.5", "6.5"]), strict)
        assert conflict == ["AUS has 2 choropleth-data regions with conflicting data-value attributes"], conflict
        three = run(svg(["5.5", "5.5", "6.5"]), strict)
        assert three == ["AUS has 3 choropleth-data regions with conflicting data-value attributes"], three
        # same value on every region, but the labels are still checked once each
        assert any("value labels" in f for f in run(svg(["5.5", "5.5"], labels=False), strict)), strict
        wrong = run(svg(["9.5", "9.5"]), strict)
        assert any("does not match" in f for f in wrong), wrong
    nan = run(svg(["nan", "nan"]))
    assert nan == ["AUS has 2 choropleth-data regions with conflicting data-value attributes"], nan
    assert any("not a finite number" in f for f in run(svg(["nan", "nan"]), "1"))
    inf = run(svg(["inf", "inf"]))
    assert inf == ["AUS has 2 choropleth-data regions with conflicting data-value attributes"], inf
    assert any("not a finite number" in f for f in run(svg(["inf", "inf"]), "1"))
    print("PASS choropleth same-value regions: equal values count once, different values and NaN still fail, labels still checked")


if __name__ == "__main__":
    main()
