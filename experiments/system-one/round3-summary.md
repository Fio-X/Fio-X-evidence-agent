# System One Round 3 summary

Baseline: `30b5d3fe823e794b9120a987349bdc0e2d0c4dfa`

All three Round 3 experiments completed and pushed.

## Classification

- HOLD: r3-01-observability-foundation
- PROMOTE: r3-02-single-invocation-persistent-pi
- PROMOTE: r3-03-stage-packet-boundary-ab

## Decisions

### Observability foundation: HOLD pending watchdog stabilization

The integrated observability prototype passed Rust/build/phase/redaction checks and measured roughly +2.05 ms median warm-mock overhead, but the existing 150 ms fragmented-output watchdog test remained timing-sensitive. Product timeout behavior must not be weakened. A test-harness-only stabilization task exists on `exp/system-one-r3-01b-rpc-watchdog-stability`.

### Persistent Pi: PROMOTE as an isolated draft

The opt-in single-invocation prototype reduced deterministic complex-visual mock child launches from 3 to 1 and median E2E from 496.28 ms to 304.10 ms while keeping two completion retries and fail-closed completion behavior. It remains isolated in draft PR #24 and should not become default until context-growth cost is measured.

### Stage Packet: PROMOTE as an isolated draft

The boundary prototype reduced research-to-design inline context from 130,079 bytes to 664 bytes (99.49%) and design-to-publish from 15,913 bytes to 698 bytes (95.61%). Resolve overhead was sub-millisecond and tamper/missing/unsafe/scope cases failed closed. It remains isolated in draft PR #25 pending production-boundary integration.
