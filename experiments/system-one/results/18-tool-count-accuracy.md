# 18-tool-count-accuracy

## Hypothesis

`tool_count` is accurate for profile-only runs but overstates effective registered tools when `NEWSROOM_PHASE` scopes registration.

## Commands and measurements

- Read `AGENTS.md`, `experiments/system-one/README.md`, `experiments/system-one/manifest.json`, `local-codex/task.md`, `src/pi.rs`, `runtime/pi/newsroom.ts`, `runtime/pi/tool_registry.mjs`, and `runtime/pi/tool_phase_policy.mjs`.
- Ran a temporary Node measurement using the canonical registry and `toolEnabled(name, {profile, phase})` for all six profiles and `all` plus seven phases.
- Ran `node scripts/test_phase_tool_scope_v112.mjs`.
- Ran `python3 scripts/check_runtime_contract.py`.
- Checked `git status --short` after the read-only measurements.

## Observed values

- Canonical registry: 53 tools.
- Profile allowlist counts: investigate 14, visual 36, publication 10, visual-story 47, competition 53, full 53.
- With phase `all`, effective counts equal those profile counts (no overstatement).
- With scoped phases, `src/pi.rs` still records the profile count, while `runtime/pi/newsroom.ts` registers only profile-and-phase-enabled tools. Examples:
  - `visual-story` / `core`: reported 47, effective 4, overstatement 43.
  - `visual-story` / `design`: reported 47, effective 25, overstatement 22.
  - `investigate` / `discover`: reported 14, effective 5, overstatement 9.
  - `full` / `verify_publication`: reported 53, effective 7, overstatement 46.
- Existing phase-scope test: PASS (`tool_count` 53; investigate count 14).
- Runtime contract alignment: PASS.
- Product source remained unchanged.

## Limitations

This is a static/runtime-definition audit; no provider RPC was run and no production event containing a scoped `NEWSROOM_PHASE` was captured. The result establishes the count mismatch from the implemented code paths, but does not quantify token or latency impact. `NEWSROOM_PHASE` is externally supplied; repository search found no Rust-side assignment beyond the extension's environment read.

## Classification

PROMOTE
