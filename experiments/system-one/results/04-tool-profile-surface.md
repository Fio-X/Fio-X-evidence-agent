# Round 1 — 04-tool-profile-surface

## Hypothesis

Profile-scoped tool registration materially reduces the agent-visible tool surface compared with the full registry, especially for investigate and publication flows, while visual-story retains the tools needed for its richer pipeline.

## Commands / measurements

- Read `AGENTS.md`, `experiments/system-one/README.md`, `experiments/system-one/manifest.json`, and `local-codex/task.md`.
- Recorded branch/SHA: `exp/system-one-r1-04-tool-profile-surface` / `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Ran `python3 scripts/check_runtime_contract.py`.
- Parsed `config/tool-registry.json`, including profile inheritance and `agent_visible`, and compared each projection with the generated constants in `src/tool_registry.rs`.
- Parsed `runtime/pi/newsroom.ts` registration definitions and compared them with the canonical registry.

Environment: macOS 27.0; `rustc 1.98.1`; Python 3.14.6; Node v24.14.1.

## Observed values

| Profile | Agent-visible tools | Reduction vs full |
|---|---:|---:|
| investigate | 14 | 73.6% |
| publication | 10 | 81.1% |
| visual | 36 | 32.1% |
| visual-story | 47 | 11.3% |
| competition | 53 | 0% |
| full | 53 | 0% |

- Canonical registry: 53 tools, 53 unique.
- Bundled Pi registrations: 53, 53 unique; exact order/content match with canonical registry.
- Generated Rust profile projections: all six matched the canonical projections exactly.
- Runtime contract: PASS (`allowlist/audit/tools/runtime materialization are aligned`).
- `visual-story` inherits `visual`; its additional publication/research surface brings it to 47 tools.

## Limitations

This experiment measures declared/registered tool counts only. It does not measure serialized schema bytes, model selection behavior, RPC latency, token usage, or whether unused registered tools affect provider performance. The comparison is repository-static and does not exercise a live provider route.

## Classification

PROMOTE

The evidence supports a bounded follow-up measuring schema/token cost and runtime behavior of the already-defined narrow profiles; the largest immediate surface reductions are in investigate and publication.
