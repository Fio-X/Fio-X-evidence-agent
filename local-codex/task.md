# Local Codex task: System One R6 macOS-native CI gate

Task ID: `system-one-r6-macos-native-ci-gate`

Expected branch: `ci/system-one-r6-macos-native-gate`

Base production-candidate commit: `fd4367cbabe33ae7259d88ad55e537555c3fc1cb`

Parent production-candidate PR: #30

## Objective

Add a narrow GitHub Actions macOS-native CI job so the repository continuously verifies the local backend and parallel replay contracts that the existing Ubuntu CI cannot execute semantically.

This is CI hardening only. Do not change product/runtime behavior.

Use the stable GitHub-hosted runner label:

`macos-26`

Do not use the `xcode-27` public-preview runner as a required production gate.

## Required CI behavior

Modify the existing workflow `.github/workflows/ci.yml` by adding one independent job with a clear name such as `macos-native-contracts`.

The job must:

- run on `macos-26`;
- checkout the repository;
- use the same pinned Node version as the existing Ubuntu CI unless there is a concrete compatibility reason not to;
- verify the expected macOS-native executables used by the local backend are present, at minimum:
  - `/usr/bin/sqlite3`
  - `/usr/bin/plutil`
  - `/usr/bin/textutil`
- run the macOS-relevant existing contracts:
  - `node scripts/test_local_result_budget.mjs`
  - `node scripts/test_parallel_tool_contract.mjs`
  - `node scripts/test_parallel_result_budget.mjs`
  - `node scripts/test_parallel_replay_wiring.mjs`
  - `node scripts/test_tool_result_budget_integration.mjs`
- keep the existing Ubuntu job unchanged except for unavoidable YAML structure/formatting;
- fail normally if a required native executable or contract fails;
- avoid installing unnecessary dependencies;
- avoid duplicating the full Linux CI suite.

The intended coverage is:

- default `local_text` bounded behavior;
- explicit `maxBytes` behavior;
- opt-in full local text behavior;
- SQLite read-only execution;
- complete parallel text and SQLite replay before model-visible compaction;
- scheduler-owned parallel model-visible budgets;
- no helper-level `maxRows` truncation;
- the existing 942143 -> 30544 model-visible integration fixture.

## Architecture and safety invariants

- No product/runtime source changes.
- No change to result-budget semantics.
- No change to routing/classifier behavior.
- No change to evidence, claim, SQL, verification, completion, publication, browser-QA, or replay gates.
- No new dependency or package lockfile changes.
- Do not change PR #30 or PR #29 review state.
- Do not merge any PR.

## Allowed modifications

- `.github/workflows/ci.yml`
- `local-codex/result.md`

Do not modify any other file.

If another file is required, stop and report the smallest necessary scope expansion.

## Required local validation

Because this task changes GitHub Actions YAML and the new runner can only be proven remotely after push, perform all locally available checks:

- inspect the final workflow diff and confirm the existing Ubuntu job is semantically unchanged;
- parse the workflow as YAML using an available local parser if one is already installed; do not add a dependency just for this;
- `node scripts/test_local_result_budget.mjs`
- `node scripts/test_parallel_tool_contract.mjs`
- `node scripts/test_parallel_result_budget.mjs`
- `node scripts/test_parallel_replay_wiring.mjs`
- `node scripts/test_tool_result_budget_integration.mjs`
- `git diff --check`

Also record local `sw_vers`, `uname -m`, and Node version for non-sensitive environment evidence.

## Required result report

Update `local-codex/result.md` with:

- tested branch/base SHA;
- files modified;
- exact job name and runner label;
- exact commands run;
- PASS/FAIL/SKIP for every local validation;
- observed macOS version, architecture, and Node version;
- observed result-budget/replay metrics from the tests;
- confirmation that the Ubuntu job was not semantically changed;
- confirmation that no product/runtime source changed;
- note that the new GitHub-hosted `macos-26` job requires remote CI to establish final PASS;
- blockers, if any;
- no secrets/credentials/tokens/provider diagnostics.

End with exactly one classification:

PROMOTE

HOLD

REJECT

or

INCONCLUSIVE

Use PROMOTE only if the workflow change and all local validations pass, while clearly stating that final production-gate acceptance still depends on the first remote `macos-26` CI run.

Do not commit or push if Git metadata is not writable.
Do not merge any PR.
Do not mark any Draft PR Ready for Review.
