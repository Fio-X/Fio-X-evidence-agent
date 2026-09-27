# Offline test fixtures

`world-bank-renewable-latest.csv` is a deliberately small, real-data fixture for deterministic tests when the network is unavailable. It transcribes the country/year/value rows shown by the World Bank data page for the indicator `EG.FEC.RNEW.ZS`, "Renewable energy consumption (% of total final energy consumption)", for the resource-rich Sub-Saharan Africa country group.

Source page:
https://data.worldbank.org/indicator/EG.FEC.RNEW.ZS?locations=R6

The fixture intentionally mixes 2021 and 2022 observations. That is a test feature: a competent data-news agent should detect that a naive ranking of each country's "latest" value compares different reference years and should state or repair that limitation before making a strong cross-country claim.

This fixture is for offline regression and reasoning tests. The competition demo should prefer live, authoritative machine-readable data and preserve its downloaded snapshot in the investigation artifact.

`chart-regression.svg` is a renderer regression artifact generated from the same fixture using the current `makeSvg` implementation. Its title and note explicitly state that the mixed-year ranking is only a visual regression, not an editorial claim.


## v0.9 spatial/explanatory fixtures

`v09-realdata/eia-us-crude-imports-2024.csv` contains selected 2024 EIA crude-oil import totals converted to average thousand barrels per day plus representative country coordinates for schematic origin/destination placement.

`v09-realdata/titanic-r-datasets.csv` contains the full 32-cell R `datasets::Titanic` contingency table (2,201 observations).

`spatial-explanatory/` contains deterministic desktop/mobile regression outputs for Parallel Sets, Chord, schematic geographic flow and process schematic.

## v1.4 external scene fixture

`fixtures/external/naturalearth_lowres/` contains an offline low-resolution Natural Earth Admin 0 country-polygon fixture used only as geographic context in the NASA editorial-quality regression. `SOURCE.json` records file hashes, bundle hash, official upstream/terms URLs, public-domain license, credit and the limitation that station locations, station density, anomaly values and political comparisons are not encoded by the benchmark map.

## v1.5 cartographic-flow fixtures

`v15-cartographic-flow/world-bank-remittance-corridors-2021.csv` contains four published World Bank 2021 bilateral-remittance corridor estimates with representative country-capital anchors. The anchors are cartographic placement aids; the arcs are explicitly `abstract_od` and do not represent financial infrastructure or the physical path of money.

`v15-cartographic-flow/world-bank-remittance-corridors-2021.source.json` records the published source, values and coordinate-method caveat.

`v15-cartographic-flow/route-semantics-contract.json` is an illustrative geometry-only contract fixture used to test `verified_route`, `observed_trajectory` and `network_constrained` policies. It is intentionally not presented as a real aircraft, vessel, pipeline or road route.

The existing `v09-realdata/eia-us-crude-imports-2024.csv` is reused by the v1.5 `abstract_od` regression so the same quantities can be compared between the old schematic geo-flow renderer and the new provenance-aware cartographic renderer.
