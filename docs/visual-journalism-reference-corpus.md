# Visual Journalism Reference Corpus

This corpus records transferable editorial decisions. It does not clone the visual identity, layout, typography or artwork of any publication.

## South China Morning Post Graphics

SCMP describes its infographics desk as producing interactive visual stories using data, maps, videos and illustrations. Its work demonstrates a broader unit of design than a chart: quantitative evidence can be combined with geography, explanatory diagrams, illustrations and interaction inside one visual story.

Agent lessons:

- classify the reader task before selecting a mark type;
- allow relationship, spatial, process and explanatory topologies alongside tables;
- combine data and annotations only when each element advances the governing claim;
- treat illustration and cutaway graphics as a separate semantic adapter with explicit abstraction disclosure, rather than forcing them into the statistical chart renderer.

Sources:

- South China Morning Post, “SCMP Infographics”: https://www.scmp.com/infographic/
- South China Morning Post, Infographics archive: https://www.scmp.com/infographics

## Delayed Gratification

Delayed Gratification and its `An Answer for Everything` project frame infographic design at the intersection of questions, data and design. Its designers describe a successful page as capable of holding a large story for exploration while still giving a fast top-level takeaway. Reused layouts and colour codes help readers build visual fluency.

Agent lessons:

- expose `complexity_budget` explicitly instead of treating lower visual complexity as universally optimal;
- preserve an immediate takeaway even in exploratory high-density graphics;
- search the dataset for smaller editorial stories before choosing a final composition;
- keep a “how it works” or explanatory layer when the encoding is unfamiliar.

Sources:

- Design Week, “These 200 infographics aim to provide an answer for everything”: https://www.designweek.co.uk/issues/25-31-october-2021/delayed-gratification/
- Design Week, “Delayed Gratification: choosing beauty over the news agenda in cover design”: https://www.designweek.co.uk/issues/26-june-30-june-2023/delayed-gratification-cover-design-50th-issue/

## Eurostat energy Sankey practice

Eurostat uses Sankey diagrams for energy balances because energy products can be traced through production, trade, transformation and final consumption. Its methodology also shows why a Sankey renderer needs domain lint: negative flows and some balance aggregates cannot be represented directly without semantic transformation.

Agent lessons:

- Sankey is appropriate for staged directional flows where width has an additive interpretation;
- negative values must be rejected or transformed under an explicit domain rule;
- conservation checks are domain-dependent and should be a selectable strict/warn/off policy;
- graph cycles require a different representation or an explicit modeling transformation.

Sources:

- Eurostat, “Shedding light on energy in Europe”: https://ec.europa.eu/eurostat/web/interactive-publications/energy-2025
- Eurostat methodology notes for Sankey energy balances: https://ec.europa.eu/eurostat/documents/3217494/8113778/KS-EN-17-001-EN-N.pdf/99cc20f1-cb11-4886-80f9-43ce0ab7823c

## U.S. Energy Information Administration

EIA publishes U.S. energy consumption flow diagrams and the underlying national totals. The 2024 source values used in the v0.8 regression fixture are petroleum 35.3, natural gas 34.2, renewable energy 8.6, nuclear 8.2 and coal 7.9 quadrillion Btu, summing to 94.2 quads. The fixture also uses 74.9 quads for end-use sectors and 19.3 quads for electrical-system losses.

Agent lessons:

- real flow graphics need arithmetic conservation tests in addition to SVG tests;
- source notes and units must remain visible on both desktop and mobile;
- a compact aggregate Sankey should not imply source-specific allocation when only aggregate totals are available.

Sources:

- EIA, “U.S. primary energy production, consumption, and exports increased in 2024”: https://www.eia.gov/Todayinenergy/detail.php?id=65524
- EIA, “U.S. energy consumption by source and sector, 2024”: https://www.eia.gov/totalenergy/data/monthly/pdf/flow/total_energy_spaghettichart_2024.pdf

## Decision matrix encoded in v0.8

| Reader problem | Data topology | Preferred v0.8 forms | Failure rule |
| --- | --- | --- | --- |
| Trace quantity through stages | flow edges | Sankey, alluvial | reject negative/cyclic flows; check conservation |
| Follow paths in a sparse relationship graph | graph edges | node-link | warn on density; cap nodes/edges |
| Compare a dense relationship graph | graph edges | adjacency matrix | cap matrix size |
| Explain parent-child structure | hierarchy | hierarchy tree | require one root, valid parents, no cycles |
| Explain dated sequence | events | timeline | sort dates; cap event count |
| Show changing composition | tabular time series | streamgraph | reject negative values; cap series |
| Compare heavy-tailed positive variables | tabular | log scatter | reject zero/negative values on log axis |

## Future reference families

Geographic flow maps, chord/ribbon diagrams, dedicated categorical parallel sets and process schematics entered the v0.9 runtime. Semantic cutaway/exploded/anatomy/system graphics entered the v1.1 explanatory adapter. Remaining reference work should focus on published basemap/GIS integration, photography-aware layout, bespoke vector illustration, 3D reconstruction, scrollytelling and image-aware art-direction critique.

## v0.9 additions: spatial, categorical flow and explanatory process

The v0.9 implementation converts several future reference families into explicit runtime decisions without copying publisher styling.

### Geographic flow

A spatial-flow view is selected only when geographic position contributes to the reader's task. The deterministic v0.9 renderer uses verified coordinate endpoints, width-encoded flow and a visible schematic-projection disclosure. It intentionally avoids invented borders or physical route geometry.

The real regression fixture uses U.S. Energy Information Administration monthly crude-oil import volumes for selected 2024 suppliers. Canada is the dominant selected source; the map uses representative country coordinates solely to locate origins and the United States target.

Sources:

- U.S. Energy Information Administration, Petroleum & Other Liquids country import tables: https://www.eia.gov/petroleum/data.php#imports
- U.S. Energy Information Administration, Canada remained the top source of U.S. crude oil imports in 2024: https://www.eia.gov/todayinenergy/

### Categorical Parallel Sets

Dedicated Parallel Sets are used for weighted paths through multiple categorical dimensions. The renderer preserves every contingency-table cell, while lint limits axis count and category cardinality so a high-density graphic remains interpretable.

The real regression fixture uses the R `datasets::Titanic` four-dimensional contingency table with 2,201 observations over Class, Sex, Age and Survived.

Source:

- R `datasets::Titanic` documentation: https://stat.ethz.ch/R-manual/R-devel/library/datasets/html/Titanic.html

### Process schematic

A process schematic communicates verified stage-to-stage logic. It requires an acyclic `process_graph` and treats labels and arrows as explanatory evidence structure rather than quantitative marks. Illustration-heavy cutaways and exploded/anatomy/system drawings are handled by the separate v1.1 semantic explanatory adapter, which is deliberately schematic and not to scale.

## Decision matrix encoded in v0.9

| Reader problem | Data topology | Preferred forms | Failure / fallback rule |
| --- | --- | --- | --- |
| Trace additive quantity through stages | `flow_edges` | Sankey, alluvial | reject negative/cyclic flows; conservation policy |
| Trace categories across multiple dimensions | `categorical_flow` | Parallel Sets | reject negative weight; cap axes/categories/rows |
| Follow sparse paths | `graph_edges` | node-link | warn on density; cap nodes/edges |
| Compare dense relationships | `graph_edges` | adjacency matrix | cap matrix size |
| Summarize weighted many-to-many relationships | `graph_edges` | Chord | cap nodes/links and warn on high density |
| Explain hierarchy | `hierarchy` | hierarchy tree | one root, valid parents, no cycles |
| Explain dated sequence | `events` | timeline | deterministic date sort; cap event count |
| Show changing composition | tabular time series | streamgraph | reject negative values; cap series |
| Explain geographic origin/destination flows | `geo_edges` | schematic geo flow map | validate coordinates; disclose approximate geometry; cap routes |
| Explain a verified process | `process_graph` | process schematic | require DAG; cap stages/transitions |
| Compare heavy-tailed positive variables | `tabular` | log scatter | reject zero/negative values on log axis |


## v1.1 additions: awards-informed magazine composition

### Information is Beautiful Awards

The published IIB judging language spans impact, engagement, analytical clarity, innovation/creativity, inclusion/accessibility, effectiveness and beauty. The transferable lesson is multi-dimensional quality: an attractive page cannot make weak analysis acceptable, and an accurate page can still fail to engage or guide readers.

Source: https://www.informationisbeautifulawards.com/news/598-meet-the-2023-judges

### Society for News Design

SND evaluates typography, pacing, organization, information architecture, usability, color, responsiveness, performance, accessibility, reporting, data visualization, illustration and art direction. Entry materials also ask teams to explain intent, target audience and impact. v1.1 therefore elevates audience, intent, hierarchy and responsive execution into the page contract instead of treating them as informal copy-editing concerns.

Sources:
- https://snd.org/best-of-news-design-call-for-entries/
- https://snd.org/best-of-design-competitions/faqs/

### Sigma Awards

Sigma 2026 criteria emphasize great data collection/analysis in service of journalism, strong visual or interactive storytelling, public service, innovation and concise curation. The 2026 shortlist spans explainer projects and visually driven work combining maps, charts, video and illustration. This supports the project's shared evidence graph across multiple visual-media modules.

Sources:
- https://www.sigmaawards.org/rules/
- https://www.sigmaawards.org/remarkable-diversity-confronting-some-of-the-most-urgent-issues-of-our-time-announcing-the-2026-sigma-awards-shortlist/

### Online Journalism Awards

OJA's Excellence in Visual Digital Storytelling category judges quality/impact of visuals, media selection, effectiveness in conveying the story, and originality/innovation/creativity for digital and mobile platforms. The important implementation lesson is that responsive composition and media selection are editorial quality, not post-processing.

Source: https://awards.journalists.org/awards/visual-digital-storytelling/

### v1.1 decision rules

- state the story intent, primary message and audience before page layout;
- give modules narrative roles and explicit priorities;
- generate several order-preserving layout candidates and record why one won;
- privilege one clear visual anchor while preserving a fast scan layer and deeper exploratory layer;
- treat density and whitespace as pacing variables;
- allow semantic explanatory graphics as first-class modules only with claim provenance and `SCHEMATIC / NOT TO SCALE`;
- score originality as a bonus but never let it override provenance, readability or accessibility;
- keep raster/human review because structured rubric scores cannot fully judge illustration quality or emotional coherence.

## Community workflow references

### The Pudding

The Pudding publishes its data, design and storytelling process as a connected visual-essay workflow. Its public guidance normalizes exploration, pivoting and killing weak ideas instead of forcing every analysis into production. Agent takeaway: editorial planning needs an explicit `REVISE`/stop path even when data and renderer contracts are valid.

Sources:
- https://pudding.cool/process/how-to-make-dope-shit-part-1/
- https://pudding.cool/process/how-to-make-dope-shit-part-2/
- https://pudding.cool/process/how-to-make-dope-shit-part-3/
- https://pudding.cool/process/pivot-continue-down/

### OpenNews Source newsroom case studies

WSJ, Bloomberg, USA Today/WNYC and other newsroom case studies repeatedly emphasize story-first collaboration, visual anchors, narrative tempo, early usability testing and robust QA. Agent takeaway: the page composer should preserve story structure and expose alternatives/revisions, while deterministic tests carry repeatable correctness and accessibility checks.

Sources:
- https://source.opennews.org/articles/wsj-graphics-team/
- https://source.opennews.org/articles/how-we-made-behind-bloodshed/
- https://source.opennews.org/articles/how-usability-testing-can-improve-news-stories/
- https://source.opennews.org/articles/qa-process-confidence-data-stories/
