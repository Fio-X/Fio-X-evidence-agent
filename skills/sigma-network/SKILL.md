---
name: sigma-network
description: Use for interactive graph exploration with thousands of nodes or edges, including search, filtering, community exploration, ego networks, and neighborhood expansion. Use Graphology for graph structure, metrics, community detection, and layouts; use Sigma.js for WebGL rendering. Do not ask the model to invent node coordinates.
---

# Sigma Network

## Workflow
1. Confirm `viz-web` is `AVAILABLE`.
2. Load graph data into Graphology with stable node/edge IDs and evidence references.
3. Compute community/metrics/layout using Graphology packages; initialize positions before ForceAtlas2 and use Barnes-Hut settings for larger graphs when appropriate.
4. Use Sigma.js only for rendering and interaction. Preserve search, filter, focus, neighborhood expansion, keyboard/touch paths, and a static fallback.
5. Keep essential labels/details available without hover-only discovery.
6. Record layout parameters and graph hash so a view can be regenerated.

For static publication networks, route to R ggraph; for dense comparison, consider an adjacency matrix.
