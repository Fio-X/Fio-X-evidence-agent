#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

EXPECTED_BRANCH=${CODEX_BRANCH:-feat/system-one-observability-codex-handoff}
MODEL=${CODEX_MODEL:-gpt-5.6-luna}

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
codex exec -m "$MODEL" "Read AGENTS.md and .codex/task.md. Execute the task completely. Do not modify product source. Replace .codex/result.md with the structured result required by the task. Ask the user only when a local login, browser authentication, macOS permission, or another human-only action is actually required."

if git diff --quiet -- .codex/result.md; then
  echo "Codex did not update .codex/result.md" >&2
  exit 3
fi

git add .codex/result.md
git commit -m "test: report local Codex validation"
git push origin HEAD

OTHER_CHANGES=$(git status --porcelain --untracked-files=all | grep -v ' \.codex/result\.md$' || true)
if [ -n "$OTHER_CHANGES" ]; then
  echo "Local Codex left additional uncommitted changes; they were not pushed:" >&2
  echo "$OTHER_CHANGES" >&2
fi

echo "Local validation result pushed. GitHub is now the handoff channel."
