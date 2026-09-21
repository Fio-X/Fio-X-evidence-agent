# System One Round 5: Token Budget Integration

## Goal

Turn the strongest Round 4 mechanisms into compatible integration candidates while correcting two measurement blind spots:

1. profile inheritance in phase-surface measurements;
2. persistent-session history in completion-repair context measurements.

## Execution order

1. Trustworthy token/tool-result observability.
2. Unified model-visible tool-result budget.
3. Correct phase routing measurement and plumbing.
4. Fresh repair session + Stage Packet A/B.
5. Opt-in complex-classifier production-route A/B.

## Required distinctions

Always distinguish:
- prompt bytes from active/session context;
- model-visible result bytes from full artifact bytes;
- profile tool count from effective inherited phase count;
- child-process reuse from conversation-history reuse.

## Safety invariants

- Full source/data/computation artifacts remain available for deterministic replay.
- AutoRepair ∩ {Fact, Claim, SQL, Evidence} = empty.
- Evidence, provenance, verification, completion, publication and browser-QA gates remain authoritative.
- Cost optimization cannot silently reduce requested visual requirements.
- No daemon or cross-CLI background service.
- Behavior-changing experiments remain opt-in.
