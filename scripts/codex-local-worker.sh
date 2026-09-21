#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

EXPECTED_BRANCH=${CODEX_BRANCH:-feat/system-one-observability-codex-handoff}
MODEL=${CODEX_MODEL:-gpt-5.6-luna}
LOG=${CODEX_LOG:-${TMPDIR:-/tmp}/fiox-codex.log}
TASK=local-codex/task.md
RESULT=local-codex/result.md

if ! command -v codex >/dev/null 2>&1; then
  echo "codex is not installed or not on PATH" >&2
  exit 127
fi

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]; then
  echo "expected branch $EXPECTED_BRANCH, found $CURRENT_BRANCH" >&2
  echo "run: git fetch origin && git switch $EXPECTED_BRANCH" >&2
  exit 2
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree must be clean before starting the local worker" >&2
  git status --short >&2
  exit 2
fi

git pull --ff-only origin "$EXPECTED_BRANCH"

echo "Running local Codex with model: $MODEL"
echo "Full Codex output: $LOG"
if ! codex exec -m "$MODEL" "Read AGENTS.md and $TASK. Execute that task completely. Write the required report to $RESULT. Keep terminal narration concise. Ask the user only for a human-only local action." >"$LOG" 2>&1; then
  echo "Codex exited with an error. Last 25 log lines:" >&2
  tail -n 25 "$LOG" >&2
  exit 3
fi

if git diff --quiet -- "$RESULT"; then
  echo "Codex did not update $RESULT" >&2
  echo "Last 25 log lines:" >&2
  tail -n 25 "$LOG" >&2
  exit 3
fi

UNEXPECTED=$(git status --porcelain --untracked-files=all | grep -vE '^( M|M |A |\?\?) (src/artifact\.rs|local-codex/result\.md)$' || true)
if [ -n "$UNEXPECTED" ]; then
  echo "Codex left unexpected changes; nothing will be committed:" >&2
  echo "$UNEXPECTED" >&2
  exit 4
fi

git add src/artifact.rs "$RESULT"
git commit -m "test: format and report local Codex validation"
git push origin HEAD

echo
grep '^Status:' "$RESULT" || true
echo "Local validation result pushed to GitHub."
