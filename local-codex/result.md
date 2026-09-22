# Result: system-one-r6-macos-native-ci-gate

- Tested branch: `ci/system-one-r6-macos-native-gate`
- Starting task commit SHA (before uncommitted workflow/report changes): `38e1a4071ad65c51971f781f8b141eaefbd79a4f`
- Task-specified base production-candidate SHA: `fd4367cbabe33ae7259d88ad55e537555c3fc1cb` (confirmed ancestor of tested HEAD)
- Modified files: `.github/workflows/ci.yml`, `local-codex/result.md`
- Added job: `macos-native-contracts`
- Runner label: `macos-26`
- CI Node version: `22.19.0`, matching the existing Ubuntu job

## Environment

- macOS: `27.0` (`26A428`)
- Architecture: `arm64`
- Local Node: `v24.14.1`
- YAML parser: Ruby `2.6.10p210` with installed Psych
- Local native executables observed: `/usr/bin/sqlite3`, `/usr/bin/plutil`, `/usr/bin/textutil`

## Commands executed

```text
sed -n '1,260p' AGENTS.md && sed -n '1,320p' local-codex/task.md && git branch --show-current && git status --short && git rev-parse HEAD
sed -n '1,260p' .github/workflows/ci.yml && sed -n '1,260p' local-codex/result.md && git log -1 --format='%H%n%D%n%s' && git diff fd4367cbabe33ae7259d88ad55e537555c3fc1cb..HEAD -- .github/workflows/ci.yml local-codex/result.md
git diff -- .github/workflows/ci.yml && sw_vers && uname -m && node --version && ruby --version && ruby -e "require 'yaml'; YAML.load_file('.github/workflows/ci.yml'); puts 'YAML parse: PASS (Ruby Psych)'" && command -v /usr/bin/sqlite3 /usr/bin/plutil /usr/bin/textutil
node scripts/test_local_result_budget.mjs
node scripts/test_parallel_tool_contract.mjs
node scripts/test_parallel_result_budget.mjs
node scripts/test_parallel_replay_wiring.mjs
node scripts/test_tool_result_budget_integration.mjs
ruby -e "require 'yaml'; workflow = YAML.load_file('.github/workflows/ci.yml'); jobs = workflow.fetch('jobs'); abort unless jobs.keys == ['rust-and-newsroom', 'macos-native-contracts']; abort unless jobs.fetch('macos-native-contracts').fetch('runs-on') == 'macos-26'; puts jobs.keys.join(', '); puts jobs.fetch('macos-native-contracts').fetch('runs-on')" && git diff --check && git diff --name-only && git merge-base --is-ancestor fd4367cbabe33ae7259d88ad55e537555c3fc1cb HEAD; printf 'base_is_ancestor_exit=%s\n' "$?"
git diff --check
git diff --name-only
git status --short
```

## Validation

- PASS — final workflow diff inspected. The existing `rust-and-newsroom` Ubuntu job has no changed lines and is semantically unchanged; the diff only appends the independent macOS job.
- PASS — workflow parsed as YAML with the already-installed Ruby Psych parser; structural assertions found exactly `rust-and-newsroom` and `macos-native-contracts`, with the latter on `macos-26`.
- PASS — `node scripts/test_local_result_budget.mjs`.
- PASS — `node scripts/test_parallel_tool_contract.mjs`.
- PASS — `node scripts/test_parallel_result_budget.mjs`.
- PASS — `node scripts/test_parallel_replay_wiring.mjs`.
- PASS — `node scripts/test_tool_result_budget_integration.mjs`.
- PASS — `git diff --check`.
- SKIP — execution on the GitHub-hosted `macos-26` runner is not locally available. The first remote CI run is required to establish final production-gate acceptance.

## Structured metrics

- Local result budget: source `3488898` bytes; default `2097152` bytes; explicit bound `65536` bytes; full mode `3488898` bytes. Default and explicit bounds truncated, full mode was complete, SQLite was read-only, and helper-level `maxRows` was absent.
- Parallel tool contract: one registration; supported kinds were `local_hash`, `local_text`, `local_metadata`, `local_image_info`, `local_search`, and `sqlite_query`.
- Parallel result budget: `12` tasks; batch limit `32768` bytes; model-visible batch truncated; full batch replayable.
- Replay wiring: complete text `96000` bytes; complete SQLite result `240` rows; `2` per-task truncations; full task and batch references replayable; scheduler confirmed as model-visible budget owner.
- Integration fixture: baseline model-visible `942143` bytes; budgeted model-visible `30544` bytes; reduction ratio `0.9676`; behavior remained opt-in; full artifacts remained referenced.

## Scope, safety, and blockers

- No product/runtime source changed. Only the two task-allowlisted files are modified.
- No dependency or package lockfile changed, and no dependency was installed.
- No result-budget, routing/classifier, evidence, claim, SQL, verification, completion, publication, browser-QA, or replay semantics/gates were changed.
- The macOS job fails normally if a required native executable or contract is unavailable or fails.
- Remote CI remains outstanding; this is an acceptance dependency, not a local implementation blocker. No user action is required for the completed local task.
- No commit, push, merge, or PR Draft/Ready state change was attempted.
- No secrets, credentials, tokens, cookies, proxy data, or provider diagnostics were copied into this report.

PROMOTE
