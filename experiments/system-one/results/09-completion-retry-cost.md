# Experiment 09 — Completion retry cost

## Hypothesis

Bounded completion recovery adds a small, fixed number of Pi RPCs: the
`investigate-v2` artifact path permits one corrective turn, while the visual
completion loop in `investigate` permits at most two retries. The added wall
time should therefore be measurable as the cost of those extra RPCs.

## Commands and measurements

- Read `AGENTS.md`, `experiments/system-one/README.md`, and the target entry in
  `experiments/system-one/manifest.json`.
- `git branch --show-current` and `git rev-parse HEAD`:
  `exp/system-one-r1-09-completion-retry-cost`,
  `7188f692fb8d849bc2b4fea02af64d0a3423d00e`.
- Built the unchanged binary outside the repository:
  `CARGO_TARGET_DIR=/tmp/... cargo build --release --locked --bin news` — PASS.
- `CARGO_TARGET_DIR=/tmp/... cargo test --locked completion -- --nocapture` —
  PASS: 5 passed, 0 failed. This covered empty-final recovery, retry-event
  accounting, and visual completion-gate behavior; the tests completed in
  `0.00s` after compilation.
- Ran `python3 scripts/test_artifact_completion.py .` with the temporary
  release binary — BLOCKED before a case began: its existing local HTTP mock
  could not bind `127.0.0.1` (`PermissionError: Operation not permitted`).
- Ran `node scripts/test_visual_story_completion.mjs` — PASS.

## Observed values

- Runtime RPC count and retry wall-time contribution: **not observed** because
  the sandbox denied loopback server binding.
- Existing mock contract inspected in `scripts/test_artifact_completion.py`:
  source-only completion expects 2 requests (initial + one corrective request);
  source-then-tool expects 3 (initial + corrective tool-use + tool-result
  completion); text-only expects 1. These are fixture-defined expectations,
  not successful end-to-end measurements in this run.
- Rust focused completion tests: **5/5 PASS**.
- Independent story completion test: **PASS**, fail-closed with 4–9 modules,
  at least 2 visual assets, and at least 2 analytical jobs.

## Limitations

No runtime request count or wall-time delta can be claimed from this sandbox.
The HTTP mock requires loopback socket creation, which is unavailable here.
The source-level bound and fixture expectations do not substitute for the
requested end-to-end timing measurement.

## Classification

INCONCLUSIVE

No secrets were copied into this result.
