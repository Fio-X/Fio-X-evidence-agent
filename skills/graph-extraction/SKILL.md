---
name: graph-extraction
description: Extract evidence-bearing entity and relationship graphs from document corpora through the project graph-extraction runtime. Use for investigations that need entities, relationships, claims, communities, or GraphRAG indexing before visualization or retrieval. Keep extraction upstream from rendering and preserve source text-unit provenance.
---

# Graph Extraction

## Workflow
1. Use this skill only when the story requires a document-derived graph. Do not invoke it for a graph already supplied as structured nodes and edges.
2. Check `viz-graph-extract` health before execution. Never install GraphRAG during a production request.
3. Put source documents in an isolated workspace and preserve stable source identifiers, titles, dates, and hashes before indexing.
4. Use Microsoft GraphRAG only as an extractor/indexer adapter. Keep the newsroom EvidenceGraph contract independent of GraphRAG versions.
5. Run GraphRAG indexing with a pinned configuration and model policy. Prefer `standard` when claims and rich relationship descriptions matter. Treat `fast` as a cost-saving mode that may omit claim extraction.
6. Convert GraphRAG `entities.parquet`, `relationships.parquet`, `communities.parquet`, optional `covariates.parquet`, and text-unit references through `runtime/graph/graphrag_to_evidence.py`.
7. Require every exported edge or claim to retain source text-unit identifiers when available. Flag unsupported relationships rather than silently promoting them to facts.
8. Send the normalized EvidenceGraph to graph analysis or visualization backends such as Graphology/Sigma, ggraph, sfnetworks, or adjacency matrix. Never send raw GraphRAG layout assumptions downstream.

## Quality Gates
- Record GraphRAG version, configuration hash, source table hashes, row counts, and extraction method.
- Keep entity summaries and relationship descriptions distinguishable from verbatim source evidence.
- Do not treat community membership, degree, or model-extracted relationship descriptions as causal evidence.
- Require human review before sensitive or high-impact extracted relationships are published as factual claims.
- Re-index or explicitly migrate when GraphRAG changes major/minor configuration formats.

## Output
Produce the project `graph-extraction-result` contract with deterministic node/edge ordering, communities, optional claims, and provenance. Downstream renderers consume this project contract, never GraphRAG Parquet directly.
