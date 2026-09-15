# Real-data visualization test

## Scope

This test exercises the v0.8 deterministic visualization engine with public, real-world data transcribed from current source pages retrieved on 2026-09-13. It does not use synthetic values.

Sources:

- Our World in Data / Ember: renewable electricity share, 2021 and 2025.
- Our World in Data / Ember: solar electricity share, 2025.
- World Bank World Development Indicators: GDP per capita and life expectancy, 2024.

## Cases

| Case | Renderer | Rows | Desktop critic | Mobile critic | Human QA |
|---|---|---:|---:|---:|---|
| Renewable share 2021 vs 2025 | dumbbell | 6 | 100 | 100 | B+; strong comparison, annotations crowd the high-value end |
| Solar share 2025 | horizontal bar | 11 | 96 | 96 | A-; closest to publication-ready |
| Solar vs all renewables | scatter | 11 | 100 | 100 | B desktop / C+ mobile; sparse context labels, mobile annotation truncates |
| Solar + renewables | heatmap | 22 | 96 | 96 | A-; compact and legible, values compensate for missing color legend |
| GDP per capita vs life expectancy | scatter | 12 | 100 | 100 | C+/B-; label collision and linear GDP axis compress lower-income observations |

All deterministic lint checks passed. The human review shows that the current structural critic overestimates scatter quality.

## Findings

1. Horizontal ranking and compact heatmaps are the strongest current renderer families.
2. Dumbbell works well for two-period editorial comparison, but annotation placement needs more horizontal collision awareness near domain edges.
3. Scatter needs `x_scale: log` support for heavy-tailed economic variables such as GDP per capita.
4. Mobile point annotations should wrap to two or three lines instead of truncating after a fixed character count.
5. Highlight labels and point annotations need a shared collision layout; today they are placed independently.
6. The visual critic needs image/layout-derived signals so a score of 100 cannot coexist with visible label collisions.

## Regression assets

The real-data fixtures and outputs live under:

- `fixtures/realdata/`
- `outputs/realdata/`
- `scripts/test_realdata_viz.mjs`

These should become a non-blocking visual-quality suite first, then a blocking regression suite after the scatter layout fixes land.


## v0.8 follow-up

The World Bank GDP/life-expectancy scatter is rerun with a positive log x axis and unified annotation/direct-label collision layout. This addresses the heavy-tailed income compression and label overlap discovered during the original real-data review.


## v0.9 spatial/explanatory follow-up

v0.9 adds two additional real-data regression cases. EIA monthly 2024 crude-oil import totals are aggregated into average thousand barrels per day and rendered as a schematic origin/destination flow map for six selected suppliers. The R `datasets::Titanic` 2,201-observation contingency table is rendered as four-axis Parallel Sets without dropping any of its 32 cells.

These cases are executed by `scripts/test_v09_realdata_viz.mjs` and included in the main smoke suite. The geographic visual explicitly states that representative coordinates and relationship curves are schematic rather than physical routes.

## v1.3.1 NASA GISTEMP pixel-QA follow-up

v1.3.1 adds `scripts/test_nasa_magazine_realdata.mjs` using NASA GISS GISTEMP v4. The regression covers a 46-year annual line, a top-ten ranking, a 36-cell monthly heatmap, a process schematic and one complete InfographicSpec 1.2 desktop/mobile page.

Raster inspection exposed three defects that deterministic critics missed despite scores of 96-100: mobile heatmap values disappeared without a quantitative legend, process-edge labels could truncate with ellipsis, and right-edge line annotations cramped against the plot boundary. The shared renderer now adds heatmap min/max legends and mobile values, wraps process-edge labels, and flips line annotations left near the right edge. The regression asserts these behaviors and is part of `scripts/smoke.sh`.

See `docs/realdata-visual-validation-v1.3.1.md` for the full evidence and output inventory.
