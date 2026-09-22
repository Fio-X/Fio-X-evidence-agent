# System One exploration swarm

Baseline policy: every experiment starts from the same Git commit and must not modify product source in round 1.

Round 1 goal: identify high-value optimization directions using measurements and repository evidence before introducing control-plane behavior changes.

## Result classes

- PROMOTE: strong evidence that a bounded round-2 implementation is worth testing.
- HOLD: plausible value, but evidence is incomplete or dependent on another experiment.
- REJECT: measured cost/risk outweighs likely value.
- INCONCLUSIVE: the current repository cannot answer the hypothesis reliably yet.

## Common metrics

Where applicable record:
- end-to-end wall time
- Pi RPC call count
- startup_ms
- rpc_ms
- first_model_text_ms
- prompt bytes
- tool profile and tool count
- input/output/cache token counters
- tool calls and retries
- validator failures
- correctness / evidence-gate result

## Safety

Round 1 is read-only with respect to product source. Experiments may write only their own result under `experiments/system-one/results/` plus temporary files outside the repository.

Do not weaken evidence, provenance, verification, validator, publication, or browser-QA gates.
