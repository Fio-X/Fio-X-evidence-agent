---
name: network-analysis
description: Analyze graph structure with deterministic NetworkX metrics, communities and layouts before handing geometry to a publication renderer.
---
Use NetworkX as the analytical layer, not as the final newsroom renderer. Compute graph metrics, connected components, communities and deterministic seeded layouts. Preserve graph direction and weight semantics. Store the analysis result hash. For hierarchical branching stories, radial_tree can expose hub-and-branch structure; for general networks prefer spring or ForceAtlas2 depending on scale. Hand the resulting positions and metrics to Sigma, D3, Plotly or another qualified renderer.
