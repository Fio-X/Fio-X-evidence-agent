# Local Codex operating rules

This repository uses local Codex as an environment-bound validation worker. Architecture and GitHub-side source changes are coordinated separately; local Codex should execute the task in `local-codex/task.md` and report evidence in `local-codex/result.md`.

## Scope

- Read this file and `local-codex/task.md` before running commands.
- Treat the current Git HEAD as the implementation under test.
- Do not redesign architecture or refactor product code unless the task explicitly asks for it.
- Prefer existing project scripts and canonical test commands.
- If a local-only failure suggests a code fix, report the smallest proposed fix in `local-codex/result.md` instead of silently changing source.

## Safety and evidence invariants

- Never print, copy, commit, or summarize API keys, tokens, cookies, passwords, proxy credentials, or other secrets.
- Never weaken evidence, provenance, verification, validator, publication, or browser-QA gates to make a test pass.
- Never hand-edit generated factual artifacts to manufacture a pass.
- Preserve the project invariant that model output cannot grant verification status.
- Do not install system-wide packages or change global configuration unless the user explicitly approves it.
- When authentication, browser login, macOS permission, or another human-only action is required, stop at that step and ask the user to complete it. Resume after the user confirms.

## Git discipline

- Work on the branch named in `local-codex/task.md`.
- Keep product source unchanged unless the task explicitly authorizes edits.
- The local worker script stages only the allowlisted files for the active task.
- Do not commit generated artifacts, screenshots, provider traces, or logs unless the task explicitly requests them.

## System One experiment swarm

When the invoking prompt explicitly names a round-1 experiment ID from `experiments/system-one/manifest.json`, that experiment contract takes precedence over the default `local-codex/task.md` handoff path.

For round 1:
- read `experiments/system-one/README.md` and the named manifest entry
- treat product source as read-only
- write only the named `experiments/system-one/results/<experiment-id>.md` result file
- use temporary files outside the repository for measurements
- classify the result as exactly one of PROMOTE, HOLD, REJECT, or INCONCLUSIVE
- do not update `local-codex/result.md` during a swarm experiment

## Result contract

Write `local-codex/result.md` before finishing. It must contain:

- tested commit SHA and branch
- OS and tool versions relevant to the run
- commands actually executed
- PASS/FAIL/SKIP for each requested check
- locations of non-sensitive local artifacts
- observed structured metrics
- blockers, including whether user action is required
- concise root-cause notes for failures
- confirmation that no secrets were copied into the report

Do not claim a check passed unless the command or observable artifact actually demonstrated it.


## System One round-2 experiments

When the invoking prompt explicitly names an experiment ID from `experiments/system-one/round2-manifest.json`, that experiment contract takes precedence over the default `local-codex/task.md` handoff.

For round 2:
- read `experiments/system-one/README.md`, `experiments/system-one/round1-summary.md`, and the named round-2 manifest entry
- modify only the experiment's `allowed_files` plus its own result file under `experiments/system-one/results/`
- preserve all evidence, provenance, verification, validator, publication, and browser-QA gates
- keep prototypes opt-in or test-only when the experiment contract requires default behavior to remain unchanged
- do not introduce a generic new RunState or parallel memory system
- do not expose secrets or raw provider diagnostics
- classify the final result as exactly one of PROMOTE, HOLD, REJECT, or INCONCLUSIVE


## System One round-3 experiments

When the invoking prompt explicitly names an experiment ID from `experiments/system-one/round3-manifest.json`, that experiment contract takes precedence over the default local handoff.

For round 3:
- read `experiments/system-one/round1-summary.md`, `experiments/system-one/round2-summary.md`, and the named round-3 manifest entry
- inspect listed R2 experiment branches as implementation inputs, but do not blindly merge conflicting files
- modify only the named experiment's `allowed_files` plus its own result file
- preserve all evidence, provenance, verification, validator, publication, and browser-QA gates
- keep persistent-Pi work bounded to a single CLI invocation; do not introduce a daemon or background service
- keep Stage Packet work off the production default path in this round
- keep sparse macro checkpoints on HOLD unless explicitly reintroduced by a later manifest
- classify the final result as exactly one of PROMOTE, HOLD, REJECT, or INCONCLUSIVE
