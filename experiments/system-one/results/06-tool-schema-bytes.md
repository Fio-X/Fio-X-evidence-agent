# 06-tool-schema-bytes

## Hypothesis

Phase-aware tool registration materially reduces serialized tool-schema payloads, especially for the visual-story/full profiles, making bounded phase scoping worth a round-2 implementation test.

## Commands / measurements

- Read `AGENTS.md`, `experiments/system-one/README.md`, `experiments/system-one/manifest.json`, and the tool registry/policy sources.
- Recorded baseline: branch `exp/system-one-r1-06-tool-schema-bytes`; commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Ran an inline Bun harness importing `runtime/pi/newsroom.ts`, capturing the TypeBox schemas registered for each `NEWSROOM_TOOL_PROFILE` and `NEWSROOM_PHASE` combination.
- Serialized each `parameters` schema with compact `JSON.stringify` and measured UTF-8 bytes. Also measured the OpenAI function-tool envelope (`{type,function:{name,description,parameters}}`). No product source was edited.

## Observed values

`count / parameter-schema bytes`:

| profile | all | core | discover | verify | synthesize | design | publish | verify_publication |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| investigate | 14 / 13,131 | 2 / 753 | 5 / 1,417 | 5 / 2,227 | 3 / 2,172 | 7 / 9,574 | 2 / 753 | 2 / 753 |
| visual | 36 / 32,825 | 3 / 1,163 | 6 / 1,827 | 6 / 2,637 | 9 / 7,280 | 23 / 21,924 | 4 / 3,809 | 3 / 1,163 |
| publication | 10 / 10,705 | 2 / 753 | 2 / 753 | 3 / 1,267 | 3 / 2,172 | 2 / 753 | 6 / 8,327 | 4 / 1,198 |
| visual-story | 47 / 40,355 | 4 / 1,196 | 7 / 1,860 | 7 / 2,670 | 16 / 10,988 | 25 / 22,594 | 7 / 6,845 | 5 / 1,378 |
| competition | 53 / 45,269 | 5 / 1,229 | 8 / 1,893 | 8 / 2,703 | 19 / 12,909 | 27 / 23,432 | 9 / 8,803 | 7 / 1,674 |
| full | 53 / 45,269 | 5 / 1,229 | 8 / 1,893 | 8 / 2,703 | 19 / 12,909 | 27 / 23,432 | 9 / 8,803 | 7 / 1,674 |

Selected serialized OpenAI envelope totals: investigate/all `17,300` bytes; visual-story/all `55,074`; full/all `61,946`; visual-story/design `30,611`; full/design `32,030`.

Phase scoping therefore removes approximately 44.0% of visual-story parameter-schema bytes in design, 48.2% for full/competition design, and 33.2% for visual design versus each profile's all-phase surface.

## Limitations

- This is compact JSON byte size, not provider tokenization, compression, network payload, or billed-token cost.
- The harness measures the current TypeBox schemas and registration policy; it does not run a provider RPC or validate model correctness/evidence outcomes.
- `core` is implicitly included in every non-`all` phase by the existing policy, so phase rows are scoped surfaces rather than isolated phase-only sets.

## Classification

PROMOTE
