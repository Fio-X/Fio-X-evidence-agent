# System One Round 5 summary

Baseline: `05a08fb0863535aa5dd506c4885d8c29bf8f9ac0`

All five Round 5 experiments completed and pushed.

## Classification

- HOLD: r5-01-token-observability-foundation
- PROMOTE: r5-02-unified-tool-result-budget
- PROMOTE: r5-03-phase-routing-corrected-ab
- HOLD: r5-04-fresh-repair-session-ab
- PROMOTE: r5-05-classifier-routing-cost-ab

## Decisions

### Promote: unified model-visible result budget

The integrated opt-in budget reduced a combined deterministic workload from 942,143 model-visible bytes to 30,544 bytes (96.76%) while retaining replayable computation/source/full-batch artifacts and trust/evidence controls. Promote as a production candidate, pending combined validation with phase routing.

### Promote: corrected phase routing

Canonical profile inheritance was restored in the measurement. Visual-story/all is 47 tools / 40,355 TypeBox parameter-schema bytes; discover is 7 / 1,860, verify 7 / 2,670, design 25 / 22,594. Promote the validated opt-in plumbing, pending combined validation with result budgets.

### Promote: classifier split

The opt-in production-route A/B changed 9 of 24 fixed cases in the intended direction: delivery-only cases avoid visual-story, true multi-module cases gain it. Promote as an isolated candidate, pending combined benchmark.

### Hold: observability foundation

The foundation is structurally useful and all checks pass, but the fixed mock benchmark still does not exercise tool calls end-to-end. Keep it as an implementation input rather than claim a full run-level tool-result telemetry validation.

### Hold: fresh repair session

Fresh repair structurally isolates conversation history, but the harness cannot measure active provider context/tokens. Keep the strategy as a future provider-backed experiment. Do not infer active-token savings from prompt bytes.
