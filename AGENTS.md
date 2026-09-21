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
