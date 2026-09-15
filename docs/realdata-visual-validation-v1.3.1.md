# v1.3.1 Real-data Visual Validation

## Dataset

This patch validates the renderer with NASA GISS Surface Temperature Analysis v4 (GISTEMP v4), using NASA's primary global Land-Ocean Temperature Index table rather than synthetic data.

Primary sources:

- NASA GISS data downloads: https://data.giss.nasa.gov/gistemp/data_v4.html
- NASA global table: https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.txt
- NASA release, January 14, 2026: https://www.nasa.gov/news-release/nasa-releases-global-temperature-data/

The source table is expressed in hundredths of a degree Celsius relative to the 1951-1980 mean. The fixture divides table values by 100. The regression deliberately stops at 2025 because NASA's 2026 annual value is incomplete in the current table.

Fixtures:

- `fixtures/realdata/nasa-gistemp-1980-2025.csv`: complete annual slice from 1980 through 2025.
- `fixtures/realdata/nasa-gistemp-monthly-2023-2025.csv`: complete monthly values for 2023 through 2025.
- `fixtures/realdata/nasa-gistemp-source.json`: source and transformation metadata.

NASA reports 2025 at +1.19 C and 2024 at +1.29 C relative to the 1951-1980 mean. The 2024 value is the highest annual value in the 1980-2025 test slice.

## Visual workload

`scripts/test_nasa_magazine_realdata.mjs` exercises four distinct visual tasks and then composes them into one InfographicSpec 1.2 page:

| Case | Shape | Rows | Desktop critic | Mobile critic |
| --- | --- | ---: | ---: | ---: |
| Annual warming signal, 1980-2025 | line | 46 | 100 | 100 |
| Ten highest annual anomalies in the slice | horizontal bar | 10 | 96 | 96 |
| Monthly persistence, 2023-2025 | heatmap | 36 | 96 | 96 |
| GISTEMP observation-to-estimate path | process schematic | 4 nodes | 100 | 100 |

The composed page scores 97/100 under the deterministic page critic and selects the `balanced` desktop strategy. Its raster dimensions are 1440 x 3076 for desktop and 720 x 4256 for mobile.

## Pixel QA findings

The deterministic scores were intentionally treated as structural evidence rather than sufficient visual approval. Raster review found three defects that the critic did not report:

1. The 12-column mobile heatmap suppressed cell values and had no quantitative color legend, leaving color intensity without a readable numeric mapping.
2. Process-schematic edge labels used one-line ellipsis truncation. Dense explanatory labels could therefore lose meaning despite a perfect deterministic critic score.
3. Right-edge line annotations always expanded to the right. The 2024 and 2025 labels became cramped against the plot boundary on mobile.

v1.3.1 fixes all three in the shared renderer. Heatmaps now emit a continuous min/max legend and retain exact values on sufficiently large mobile cells. Process edge labels wrap to two lines and use mobile-aware placement around converging edges. Line annotations flip to the left as they approach the right plot boundary.

The NASA regression contains assertions for each fix, so these behaviors are now release-blocking rather than one-off visual observations. The heatmap and process-schematic snapshot hashes were intentionally updated after the pixel changes.

## Remaining art-direction gap

The full desktop page still exposes a useful limitation: the early hero-stat and two-thirds hero line chart leave deliberate but generous unused space. The current candidate scorer judges geometry, order, density and module emphasis but does not reason about whether an empty third should become a sidecar, annotation rail or companion module. This is a page-level art-direction issue rather than a chart-rendering defect.

The next layout investment should therefore stay narrow: add image-aware occupancy and balance signals to candidate ranking, then permit a bounded sidecar/row-packing revision. A second page engine would duplicate the existing deterministic composer without addressing the observed failure mode.

## Regression and performance

The complete `scripts/smoke.sh` run passes after adding the NASA regression. Existing release evidence remains green: 24/24 competition gates and 16/16 integrity adversaries. Relevant p95 timings from the final run are:

| Pipeline | p95 | Budget |
| --- | ---: | ---: |
| Statistical responsive visualization | 0.401 ms | 10 ms |
| Heatmap family | 0.462 ms | included above |
| Spatial/process visualization | 0.296 ms | 22 ms |
| Infographic composer | 0.674 ms | 15 ms |
| Artifact verifier | 7.495 ms | 15 ms |
| Scale artifact verifier | 10.150 ms | 40 ms |

The visual fixes do not create a meaningful performance regression.

## Output evidence

Raster and SVG outputs are stored in `outputs/nasa-gistemp-realdata/`. The two primary inspection surfaces are:

- `nasa-gistemp-feature.png`
- `nasa-gistemp-feature.mobile.png`

Individual raster evidence for the repaired cases is also preserved for the line, heatmap and process schematic.
