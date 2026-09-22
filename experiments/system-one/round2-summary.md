# System One Round 2 summary

Baseline: `4965767bdbd6880f1b21ecd846ba2e3abde55044`

All five isolated A/B experiments completed and pushed.

## Classification

- PROMOTE: r2-01, r2-02, r2-03, r2-04
- HOLD: r2-05
- REJECT: none
- INCONCLUSIVE: none

## Decisions

### Promote: observability correctness

Combine r2-01 and r2-02 first. A/B work needs trustworthy operation-local metrics, failed-RPC terminal metrics, and actual phase-scoped tool-surface metrics before broader runtime changes are interpreted.

### Promote with narrower scope: persistent Pi

The r2-03 prototype proved a bounded multi-prompt sequence can reuse one child while existing tests pass. Its single timing pair is directional only and the prototype does not persist a child across CLI invocations. Round 3 therefore targets the simpler high-value case: reuse one child inside a single investigate invocation across completion retries. No daemon or background service.

### Promote: Stage Packet

The typed packet reduced the migration fixture boundary from 145,991 bytes to 1,147 bytes (99.21%) and failed closed on tamper/missing refs. Round 3 should measure an actual boundary/prompt handoff in an opt-in test harness before wiring it into the production path.

### Hold: sparse checkpoints

The opt-in checkpoint prototype preserved correctness but increased the local mock from 5,530 to 5,885 prompt bytes and median E2E from 67 to 72 ms, with no RPC or retry reduction. Keep the three-boundary model as a design hypothesis; do not expand it until another mechanism (phase scoping, Stage Packet, or persistent child reuse) gives checkpoints a concrete runtime benefit.
