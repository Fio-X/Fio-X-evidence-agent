#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${NEWSROOM_DOCKER_IMAGE:-agentic-data-newsroom:1.13.0-rc1}"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }
docker build -f "$ROOT/Dockerfile.live" -t "$IMAGE" "$ROOT"
echo "built $IMAGE"
echo "Run with model credentials, for example:"
echo "docker run --rm -it -e OPENAI_API_KEY -v \"$ROOT/.newsroom:/workspace/.newsroom\" $IMAGE doctor --strict --json"
