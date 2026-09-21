# Round 1: 11-repair-routing-candidates

## Hypothesis

Deterministic runtime can safely route or repair bounded presentation/derived-state failures, but must never auto-repair Fact, Claim, SQL, or Evidence content (`AutoRepair ∩ {Fact, Claim, SQL, Evidence} = ∅`).

## Commands and measurements

- Read `AGENTS.md`, `experiments/system-one/README.md`, `experiments/system-one/manifest.json`, and `local-codex/task.md`.
- Audited `runtime/pi/evidence_gate.mjs`, `runtime/pi/fact_graph.mjs`, `runtime/pi/editorial_validators.mjs`, `runtime/pi/editorial_grammar.mjs`, and `scripts/verify_artifact.py` with `rg`/`sed`.
- Ran `node scripts/test_evidence_gate.mjs` — PASS.
- Ran `node scripts/test_fact_editorial_runtime.mjs` — PASS.
- Ran `node scripts/test_cognitive_editorial_validators_v15.mjs` — PASS.
- Ran `python3 scripts/test_editorial_verifier_v14.py` — PASS; 4 adversarial cases rejected.
- Ran `python3 scripts/test_integrity_adversarial.py` — PASS; 17 adversarial cases rejected.
- Ran `python3 scripts/test_artifact_schema.py` — SKIP/FAIL at import: `ModuleNotFoundError: No module named 'jsonschema'`.

## Observed values

- Current implementation: branch `exp/system-one-r1-11-repair-routing-candidates`, commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`; working tree was clean before this result.
- Five editorial validator groups expose 23 explicit rule IDs across annotation binding, visual-channel ownership, quantitative semantics, scene budgets, and grammar compatibility.
- Existing safe repair surface: exactly 5 bounded visual fields — `span`, `emphasis`, `priority`, `move_before`, `mobile_move_before`. Replay checks also require the immutable editorial-evidence hash to remain unchanged and evidence-preserved attestation to be true.
- Existing deterministic derived-state candidates: replay `finalists`/`selected_concept_id`, asset-plan `decision`, expert-preference `status`/share, and award-mode `status`/blockers. These are safe to recompute or route for regeneration only when inputs remain unchanged; they must not manufacture human review or evidence.
- Unsafe auto-repair candidates: source/data/computation hash or path mismatches, unsupported/model-verified claims, missing source/computation references, fact-origin violations, SQL/computation replay failures, quantitative semantic violations, and missing visual assets/accessibility/provenance. The adversarial suites demonstrate these gates fail closed.
- Runtime environment: macOS 27.0; Node v24.14.1; Python 3.14.6; Rust 1.98.1; Cargo 1.98.1.

## Limitations

No production failure corpus or frequency distribution was available, so repair-value and incidence cannot be quantified. The schema test could not run because the local Python environment lacks `jsonschema`; no packages were installed. The audit is repository/static plus deterministic fixtures, not a live-provider or browser-QA measurement.

## Classification

HOLD

