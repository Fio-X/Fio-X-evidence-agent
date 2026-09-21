# System One Round 4: Token Curve

## Goal

Attack token cost at its two structural sources:

1. model-visible tool results that accumulate in session history;
2. overly broad tool/schema exposure and retry context.

Artifacts remain the data plane. Model context carries bounded previews, refs, hashes, state, and failure information.

## Baseline and dependencies

Primary baseline branch: `feat/system-one-observability-codex-handoff`.

Optional implementation inputs:
- PR #24 / `origin/exp/system-one-r3-02-single-invocation-persistent-pi`
- PR #25 / `origin/exp/system-one-r3-03-stage-packet-boundary-ab`

Round 4 must not merge those branches wholesale. Experiments may inspect and selectively reproduce bounded mechanisms when their manifest entry explicitly lists them.

## Common measurements

Where applicable record:
- model-visible result bytes
- full artifact bytes
- truncation/preview ratio
- prompt bytes
- effective tools and schema bytes
- Pi RPC count
- child launches
- completion retries
- median/p95 E2E
- evidence / publication / visual QA status

## Promotion rule

PROMOTE requires measured reduction in the targeted cost dimension with no correctness or provenance regression. Static size reduction alone is insufficient for a production-path promotion.

## Safety

- Preserve full source/data/computation artifacts.
- Never auto-repair Fact, Claim, SQL, or Evidence.
- Never lower evidence, provenance, verification, publication, or browser-QA gates.
- All result-budget and routing changes remain opt-in in Round 4 unless they are measurement-only and backward compatible.
- No daemon or cross-CLI background process.
