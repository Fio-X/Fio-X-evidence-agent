#!/usr/bin/env python3
"""Chinese 万 / 亿 / 万亿 choropleth value labels are read back exactly (no tolerance) by the independent SVG re-derivation."""
from __future__ import annotations

import verify_artifact as va


def svg(value: str, label: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Fixture</title><desc>Fixture choropleth.</desc>'
        f'<path data-role="choropleth-data" data-iso3="GIN" data-value="{value}" d="M0,0L10,0L10,10L0,10Z"/>'
        '<text data-role="choropleth-label" data-iso3="GIN" x="5" y="5" font-size="12">几内亚</text>'
        f'<text data-role="choropleth-label-value" data-iso3="GIN" x="5" y="5" font-size="12"><tspan>{label}</tspan></text></svg>'
    )


def failures(value: str, label: str) -> list[str]:
    return va.verify_choropleth_labels_from_svg(svg(value, label))


def main() -> None:
    exact = [
        ("11500", "1.2万 人"), ("12500", "1.3万 人"), ("10800", "1.1万"), ("99950", "10.0万"), ("-11500", "-1.2万"),
        ("123456789", "1.2亿"), ("150000000", "1.5亿"), ("2500000000000", "2.5万亿"), ("10000", "1.0万"), ("12345.5", "1.2万"),
    ]
    for value, label in exact:
        assert failures(value, label) == [], (value, label, failures(value, label))
    # one tenth off, the wrong scale, a rounded-down half, or a value under 1万 never passes
    for value, label in [("11500", "1.1万"), ("11500", "1.3万"), ("11500", "1.2亿"), ("9000", "0.9万"), ("-11500", "1.2万"), ("12500", "1.2万")]:
        got = failures(value, label)
        assert any("does not match" in f for f in got), (value, label, got)
    # labels in the ordinary notation keep their ordinary reading
    assert failures("66.6", "66.6%") == []
    assert failures("1200", "1.2k") == []
    assert any("does not match" in f for f in failures("1200", "9.9k"))
    print("typeset choropleth verify: PASS")


if __name__ == "__main__":
    main()
