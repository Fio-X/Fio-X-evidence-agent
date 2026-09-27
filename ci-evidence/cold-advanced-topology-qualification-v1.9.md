# v1.9 Cold Advanced Topology Qualification — 2026-09-14

This batch tests whether the browser publication agent selects and safely executes advanced visual topologies on fresh or recent real stories, rather than falling back to ordinary statistical charts.

## Cases

| Case | Visual topology | Router execution | Story closure | Browser QA |
|---|---|---|---:|---|
| `ai-selloff` | radial event-impact hierarchy | networkx_graph → plotly_browser | 100% | PASS at 390/768/1024/1440 |
| `cpi-treemap` | hierarchical treemap | plotly_browser | 100% | PASS at 390/768/1024/1440 |
| `oil-chokepoint` | route/chokepoint network after Sankey abstention | networkx_graph → plotly_browser | 100% | PASS at 390/768/1024/1440 |
| `enbridge-deal` | radial ownership/asset hierarchy | networkx_graph → plotly_browser | 100% | PASS at 390/768/1024/1440 |

All four pages are self-contained and recorded zero external HTTP requests in Chromium. All Plotly text clipping and scatter-label overlap counts are zero after the final revision.

## Semantic abstention

The Saudi oil story deliberately attempts a conserved-flow Sankey using pipeline throughput/capacity and inventory days. `ModelSpec` blocks the model before rendering because the units do not match: `million barrels/day` and `days`. The agent then switches to an unweighted route network, preserving the route topology without inventing additive flow quantities.

## Defects discovered and fixed

1. **Capability under-reporting.** `plotly_browser` could already render network/treemap forms but did not advertise `radial_network` or `treemap`; D3 also lacked the required browser delivery capability in policy. The capability registry and backend policies now reflect executable presentation capabilities.

2. **Multi-stage routing overconstraint.** Presentation requirements were incorrectly applied to the NetworkX compute stage. Routing now separates analysis-stage eligibility from final-renderer requirements, allowing `NetworkX → Plotly` plans.

3. **Conserved-flow unit safety.** `ModelSpec` previously checked numerical residuals without first enforcing one conserved unit. It now fails closed when flow units differ. The existing EIA energy-flow fixture still passes with zero residual.

4. **Browser label collision blind spot.** QA checked module/SVG bounds but not label-on-label collisions. It now measures Plotly scatter text bounding boxes and blocks overlap. A dedicated negative regression expects `plotly_scatter_text_overlap`, and the Enbridge mobile labels were re-positioned until the new QA passed.

## Regression evidence

- v1.7 editorial semantics adversarial corpus: PASS (20 semantic, 7 grammar, 6 backend matrices).
- v1.8 StoryGraph / visual synthesis / infographic composer: PASS.
- v1.9 advanced router, capability registry, browser publication, advanced visual engines, ModelSpec, D3 fail-closed, WebGL fail-closed and label-collision negative regression: PASS.

## Remaining qualification gap

This batch adds real-story evidence for radial hierarchy, treemap, ownership network and route network, plus a correct Sankey abstention. It does not yet qualify large-graph rendering, uncertainty graphics, linked map/chart views, event-sequence/scrollytelling, or causal-system publication on cold stories. D3/Sigma remain unavailable as executable runtimes on this host, and WebGL remains fail-closed.
