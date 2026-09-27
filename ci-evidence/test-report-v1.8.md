# v1.8 RC Test Report

Release: `1.8.0-rc1`

## New v1.8 qualification

`python3 scripts/test_story_graph_schema_v18.py`

Result: PASS. StoryGraph 0.1 validates the new graph contract.

`python3 scripts/test_infographic_schema.py`

Result: PASS. The schema accepts InfographicSpec 1.4 reader-question/story-graph fields while retaining earlier supported versions.

`node scripts/test_runtime_visual_synthesis_v18.mjs`

Result: PASS. The materialized Pi runtime exposes the StoryGraph and v1.8 synthesis contract.

`node scripts/test_visual_synthesis_v18.mjs`

Result: PASS.

Observed output:

```text
v1.8 visual synthesis qualification: PASS
story closure=100.0% dimensions=6
infographic synthesis dimensions=6 visual_modules=2 illustration_modules=1
critic=98 desktop=1440x2697 mobile=720x3656
```

The same test contains negative cases that must fail:

- one ordinary statistical chart used as an infographic triggers `default_chart_equivalence`
- removing the final answer node from the resolution triggers `reader_question_closure`
- assigning `trend` grammar to the anomaly asset triggers grammar/asset incompatibility
- the June -38% edge label must remain inside the plot on desktop and mobile, preventing category-label collision

## Pixel diagnostics

Desktop:

`python3 scripts/visual_qa_probe.py --input outputs/v18-monsoon/india-food-risk-infographic.png --output outputs/v18-monsoon/visual-qa-desktop.json`

Result: PASS, 1440 x 2697. No hard failures or advisories.

Mobile qualification raster:

`python3 scripts/visual_qa_probe.py --input outputs/v18-monsoon/india-food-risk-infographic.mobile@2x.png --output outputs/v18-monsoon/visual-qa-mobile@2x.json`

Result: PASS, 1440 x 7313. The source mobile SVG remains a 720-pixel logical composition; the 2x raster is used because the generic screenshot diagnostic has an 800-pixel minimum-width rule.

Machine pixel QA remains diagnostic only and does not establish human editorial readiness.

## v1.7 semantic regression

The following were rerun during the v1.8 implementation and passed:

- `node scripts/test_editorial_semantics_v17.mjs`
- `node scripts/test_editorial_semantics_adversarial_v17.mjs`
- `node scripts/test_cold_story_editorial_semantics_v17.mjs`
- `node scripts/test_runtime_editorial_semantics_v17.mjs`
- `python3 scripts/test_visual_recipe_schema_v117.py`
- `node scripts/test_visual_recipe_v117.mjs`

The adversarial set remains 20 semantic cases, 7 grammar cases and 6 backend eligibility matrices.

## Existing system regressions

The following existing tests were executed and passed during the v1.8 integration:

- infographic composition
- editorial intelligence
- magazine real-data regression
- runtime foundation/build/promotion
- Python warm worker
- design systems
- visual QA
- art direction
- runtime executor
- semantic contract
- benchmark corpus
- Python and ECharts extensions
- blind review
- backend priors
- evidence router
- graph backend and graph extraction
- web runtime contract
- adjacency backend
- ECharts editorial contract
- backend executor/router/cache
- GIS backend
- AI visual compiler
- Python GIS publication backend
- backend qualification-plan generation

The monolithic visual-compiler smoke process exceeded the host command timeout after the ECharts extension stage. Execution resumed at the next unexecuted command, and all remaining tests passed. This report therefore claims segmented smoke completion, not one uninterrupted full-suite process.

## Release baseline

`python3 scripts/check_release_baseline.py`

Result: PASS with release `1.8.0-rc1`, InfographicSpec `1.4.0`, StoryGraph `0.1.0`, Rust pin `1.98.1`, Node pin `22.19.0`, Pi pin `0.85.1`, DuckDB pin `1.5.5`, and CairoSVG pin `2.8.2`.

## External qualification gap

A full live release qualification is not possible on the current host. Cargo and DuckDB are absent and Node is 22.16.0, below the pinned 22.19.0 baseline. Final promotion still requires the real provider/Pi environment, networked investigation, independent SQL recomputation and qualified-human visual review.
