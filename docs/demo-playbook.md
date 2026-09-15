# Demo Playbook

## 1. Readiness

Use the pinned v1.3 baseline and fail closed before recording:

```bash
./scripts/bootstrap_live_env.sh --check
news doctor --strict --json
./scripts/smoke.sh
```

Generate and commit `Cargo.lock` before the final recorded run.

## 2. First autonomous investigation

Use Ember Europe or another competition-grade dataset and give the agent a reporting goal rather than a fixed tool recipe. Keep the terminal visible while Pi creates/revises its plan and chooses tools.

A good prompt asks for the strongest defensible angle, verification, a responsive visual explanation and a magazine-grade feature. The agent should decide whether the story needs statistical charts, flow/network/spatial visuals, an explanatory graphic, or a combination.

## 3. Show the evidence chain

During the run, surface:

```text
source/data snapshot
  -> DuckDB computation
  -> verified claim
  -> NewsroomVizSpec
  -> visual lint/render/critic
  -> optional explainer plan/lint/render/critic
  -> provenance-aware rich illustration when policy permits
  -> InfographicSpec 1.2
  -> candidate layouts
  -> deterministic awards-informed page critic
  -> exact desktop/mobile preview
  -> image-aware visual critic
  -> bounded evidence-preserving revision
  -> final competition-profile preflight
```

The explainer must visibly state `SCHEMATIC / NOT TO SCALE` and any governed parts should resolve to verified claims.

## 4. Second-turn editorial correction

Use the same persistent Pi session. Ask for a meaningful editorial change, for example a mobile-first reframing, a challenge to a ranking with mixed reference periods, or a request to simplify an over-dense magazine page. The plan revision should be observable and evidence should remain stable unless new reporting changes it.

## 5. Independent verification and replay

```bash
news verify .newsroom/artifacts/<artifact-id> --recompute
news inspect .newsroom/artifacts/<artifact-id>
python3 scripts/evaluate_artifact.py .newsroom/artifacts/<artifact-id>
```

A final v1.3 engineering artifact should pass **24/24** and contain measured wall-clock agent runs.

## 6. Provider qualification

```bash
NEWSROOM_NEWS_BIN=./target/release/news \
NEWSROOM_PROVIDER=<provider> \
NEWSROOM_MODEL=<model> \
./scripts/agentic_qualification.sh

# Run separately when full subsystem integration must also be qualified.
NEWSROOM_NEWS_BIN=./target/release/news \
NEWSROOM_PROVIDER=<provider> \
NEWSROOM_MODEL=<model> \
./scripts/integration_qualification.sh
```

Store `agentic-qualification.json` beside the open-goal artifact and `qualification.json` beside the separate integration artifact. Repeat the same agentic scenario with a second provider, or use `NEWSROOM_PROVIDER_MATRIX` with `scripts/provider_matrix.sh` to produce an autonomy comparison report.

## 7. Magazine-grade deterministic rehearsal

The included EIA 2024 feature is the release regression for the complete presentation layer. It combines hero statistics, a ranked source visual, Sankey energy flow, a semantic cutaway explaining the energy-balance layers, a geographic flow visual, editorial text and source/method notes. Its `InfographicSpec 1.2` exposes intent, primary message, story arc, audience, module roles, priorities and emphasis.

Use this rehearsal to demonstrate:

- three candidate desktop layouts and deterministic selection;
- one clear visual anchor and two-speed reading;
- page-level award rubric rather than only chart-level critic scores;
- responsive mobile recomposition;
- explanatory illustration provenance and schematic disclosure;
- exact-pixel desktop/mobile preview and image-aware review of the final feature;
- a verifier-replayable bounded revision and final competition-profile preflight;
- mobile-specific reading order where narrow-screen hierarchy requires it.

## 8. Failure-recovery rehearsal

Before recording, rehearse at least three real failure classes: unavailable source, unexpected dataset schema and mixed/missing reference periods. Also rehearse one presentation failure such as an overcrowded infographic that receives `REVISE` and causes a page-plan adjustment.

## 9. Business-value measurement

Run the same reporting task manually and with the agent. Record elapsed time to first defensible visual and final feature, sources inspected, deterministic computations, verified claims, visual/page revisions, recovery rate, model tokens/cost and factual/editorial corrections. This evidence should support the competition's business-value dimension.
