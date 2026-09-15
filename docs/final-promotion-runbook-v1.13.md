# v1.13 Final Promotion Runbook

This runbook is intentionally fail-closed. Do not edit qualification JSON by hand to promote a build.

## 1. Generate and review dependency locks

On a networked host with Node 22.19.0+ and Rust 1.98.1:

```bash
./scripts/generate_dependency_locks.sh
python3 scripts/verify_dependency_locks.py
```

Review and commit the five generated lockfiles. CI and runtime images must consume them with `cargo --locked` / `npm ci`.

## 2. Run the standard RC gate

```bash
python3 scripts/release_check.py --profile rc --output outputs/v113-release-check-rc.json
```

`PASS_SEGMENTED` evidence is useful for development but is not a substitute for this standard-host PASS.

## 3. Qualify CPU and GPU publication lanes

Run the CPU trusted-publication lane and a genuine WebGL2-capable GPU lane. The GPU report must be PASS; `webgl2_unavailable` is a final blocker.

## 4. Complete the cold-story ledger

Add only executed, reviewable cases to `config/cold-story-ledger.json`. Then run:

```bash
python3 scripts/check_cold_story_ledger.py --output outputs/v113-cold-story-gate.json
```

The gate requires 12 cases, 6 news cases, 8 topology families, at least 5 observed behavior families, zero silent semantic errors and at least one correct abstention. Behavior tags must come from executed, reviewable cases.

## 5. Run provider-backed live qualification

Set `NEWSROOM_PROVIDER`, `NEWSROOM_MODEL` and the relevant credentials, then run both `scripts/agentic_qualification.sh` and `scripts/integration_qualification.sh` or execute the final release profile. The agentic artifact must pass causal autonomy, hidden-failure recovery and same-session continuation without a prescribed tool path. The integration artifact must include StoryGraph, verified SQL/claims, InfographicSpec, evidence-bound PublicationSpec, passing sandboxed CPU browser QA and `news verify --recompute`.

## 6. Human review

A qualified editor reviews the exact final artifact and records an attestation derived from `config/human-attestation.example.json`, including reviewer qualification and the reviewed artifact SHA-256.

## 7. Build final dossier

```bash
python3 scripts/final_qualification.py \
  --preflight outputs/v113-production-preflight.json \
  --rc-report outputs/v113-release-check-rc.json \
  --cold-report outputs/v113-cold-story-gate.json \
  --agentic-qualification /path/to/agentic-qualification.json \
  --integration-qualification /path/to/qualification.json \
  --human-attestation /path/to/human-attestation.json \
  --output outputs/v113-final-qualification.json
```

Only a `PASS` dossier is eligible for a final tag.
