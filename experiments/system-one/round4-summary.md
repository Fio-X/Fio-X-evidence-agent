# System One Round 4 summary

Baseline: `e5ad5a7e8719225f5c88d011b6d8ad04d05aed77`

All nine Round 4 experiments completed and pushed.

## Reported classifications

- PROMOTE: r4-01, r4-03, r4-04, r4-05, r4-06, r4-07, r4-08
- HOLD: r4-02, r4-09
- REJECT: none
- INCONCLUSIVE: none

## Evidence-backed decisions

### Strong promotion candidates: result budgets

The four result-budget experiments produced large model-visible byte reductions while preserving full/replayable data:

- DuckDB: 34,201 -> 7,272 bytes, 78.74% reduction.
- fetch_url: 30K body -> 10,495 bytes (65.35% reduction); 80K body -> 10,495 bytes (86.93% reduction).
- local text: 368,898 -> 65,536 bytes, 82.23% reduction; SQLite preview remained read-only and bounded.
- parallel DAG: 257,374 -> 30,893 bytes, 88.00% reduction with full hash-addressed batch replay.

These mechanisms overlap in `runtime/pi/newsroom.ts`; Round 5 must integrate them behind one coherent budget policy instead of stacking four branch diffs.

### Telemetry: foundation input, not a cost reducer

r4-02 preserved returned text exactly and correctly measured UTF-8 model-visible bytes. Its HOLD classification is expected because telemetry alone does not reduce cost. It is an input to the Round 5 observability foundation.

### Phase plumbing: implementation candidate, measurement correction required

r4-07 successfully demonstrated Rust-to-Pi `NEWSROOM_PHASE` injection, but its scope table used `tool.profiles.includes(profile)` directly. That bypasses canonical profile inheritance such as `visual-story -> visual`, so the reported visual-story phase counts are underestimates. Round 5 must measure through `toolEnabled(...)` and reproduce canonical inherited counts before drawing a phase benefit conclusion.

### Retry packet: packet is valid; active-context claim remains unproven

r4-08 produced a 431-byte packet versus a 100,025-byte fixture and reduced aggregate prompt bytes by 10.71%, while combining three prompt turns into one Pi child. However, `run_prompt_sequence` keeps those prompts in the same Pi process/session, so prior conversational/tool-result history can still remain active. A smaller retry prompt is not proof of a smaller active context. Round 5 must compare a fresh repair session + Stage Packet against same-session persistence.

### Classifier split: keep on HOLD pending real routing A/B

r4-09 cleanly separated delivery requirements from analytical complexity across a 24-case matrix, but production routing stayed unchanged. The next experiment must wire it opt-in through the actual effective profile/prompt route and measure prompt/tool-surface deltas.

## Round 5 principle

Integrate only mechanisms whose measured quantity matches the claimed benefit. Do not use prompt-byte reduction as a proxy for active-context reduction, and do not use profile counts that bypass registry inheritance.
