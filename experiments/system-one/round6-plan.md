# System One Round 6: Combined Production Candidate

## Goal

Validate that the three Round 5 winners remain correct and beneficial when combined:

1. unified model-visible tool-result budget;
2. corrected opt-in phase routing;
3. split visual delivery vs analytical-complexity routing.

No new optimization mechanism is introduced in this round.

## Required A/B

Compare baseline versus combined opt-in candidate on deterministic local fixtures and the fixed routing matrix.

Measure:
- model-visible tool-result bytes
- effective tool count and TypeBox schema bytes
- initial prompt bytes
- selected profile and phase
- Pi RPC count / retries where the harness provides them
- evidence/completion/publication/visual gate status

## Promotion rule

Promote only if:
- all common checks pass;
- combined result-budget reduction remains >=75% on the integration workload;
- inherited phase counts match canonical values;
- delivery-only routing reductions remain intact;
- true multi-module requests retain visual-story;
- no default behavior changes when flags/options are unset;
- no evidence/provenance/verification/completion/publication/browser-QA gate is weakened.
