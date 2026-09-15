# Iteration Next Plan

This iteration executes twenty independently verifiable workstreams. GitHub issues #1 through #20 are the source of truth for task state and acceptance criteria.

## Execution groups

- Source and reproducibility: #1 #2 #3
- macOS local-first runtime: #4 #5
- Parallel scheduler hardening: #6 #7 #8 #9 #10 #11
- Registry/backend drift control: #12
- Cold-story qualification: #13 #14
- Real-provider autonomy and repeated reliability: #15 #16
- Deterministic integration qualification: #17
- Browser/visual RC: #18
- Business-value benchmark: #19
- Final qualification dossier: #20

## Release invariants

1. Integration qualification cannot substitute for agentic qualification.
2. Missing provider or GPU evidence remains BLOCKED.
3. Resource classification is runtime-owned; model-supplied labels are advisory only and cannot relax limits.
4. Parallel execution must preserve deterministic audit ordering, explicit dependency failures, and write-scope safety.
5. macOS-native backends are selected only where measured or semantically appropriate; portable/specialized backends remain available as fallback.
6. No benchmark, cold-story case, or qualification artifact may be fabricated to satisfy a gate.

## Current execution focus

The first executable slice is #6 + #7 + #12, followed by macOS CI validation. Full-source materialization (#1) is the dependency for complete Cargo/RC qualification.
