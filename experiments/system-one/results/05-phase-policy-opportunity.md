# 05-phase-policy-opportunity

## Hypothesis

`tool_phase_policy` can materially narrow the agent-visible tool surface during each phase, especially for `visual-story`, while preserving the smaller `investigate` surface and always retaining core tools.

## Commands and measurements

- `git branch --show-current && git rev-parse HEAD` → branch `exp/system-one-r1-05-phase-policy-opportunity`, commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Read `runtime/pi/tool_phase_policy.mjs` and `runtime/pi/tool_registry.mjs`.
- Ran a Node measurement using `toolEnabledForProfile` plus `toolEnabledForPhase`. The phase policy adds `core` to every named phase.
- Ran `node scripts/test_phase_tool_scope_v112.mjs` → `PASS` (`tool_count=53`, `investigate_count=14`).

## Observed values

Profile-enabled totals and phase-scoped exposed counts (phase tools plus core):

| Profile | Total | core | discover | verify | synthesize | design | publish | verify_publication |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `visual-story` | 47 | 4 | 7 | 7 | 16 | 25 | 7 | 5 |
| `investigate` | 14 | 2 | 5 | 5 | 3 | 7 | 2 | 2 |

Raw profile-enabled ownership by phase was `visual-story`: 4/3/3/12/21/3/1 and `investigate`: 2/3/3/1/5/0/0, in the same phase order. Thus, for example, a `visual-story` design phase exposes 25 of 47 profile tools (22 fewer, 46.8% reduction); an investigate design phase exposes 7 of 14 (50.0% reduction). The policy test also verified fail-closed unknown tools, profile filtering, and publication/render separation.

## Limitations

These are static registry counts, not end-to-end latency, prompt-token, or correctness measurements. They assume the generated runtime registry is authoritative and measure the policy’s named-phase semantics; `toolEnabledForPhase` alone does not apply profile filtering, so the combined profile-plus-phase calculation was used. No provider or browser run was performed.

## Classification

PROMOTE

The opportunity is large and directly measurable, with the existing policy and canonical tests passing. A bounded round-2 experiment should measure whether phase-scoped exposure reduces prompt/tool overhead without affecting evidence or publication gates.
