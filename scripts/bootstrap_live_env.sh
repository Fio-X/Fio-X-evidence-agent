#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---check}"

if [[ "$MODE" != "--check" && "$MODE" != "--install" ]]; then
  echo "usage: $0 [--check|--install]" >&2
  exit 64
fi
if [[ "$MODE" == "--check" ]]; then
  exec python3 "$ROOT/scripts/live_readiness.py"
fi

export PATH="$HOME/.cargo/bin:$HOME/.duckdb/cli/latest:$PATH"
failures=0
attempt() {
  local label="$1"; shift
  echo "==> $label"
  if "$@"; then
    echo "PASS $label"
  else
    echo "FAIL $label" >&2
    failures=$((failures + 1))
  fi
}

# "Already installed" means the same "at least" rule as `news doctor` and live_readiness.py (--meets): a tool that is good enough is
# never reinstalled, switched or downgraded.
meets() { python3 "$ROOT/scripts/live_readiness.py" --meets "$1"; }

install_node() {
  if meets node; then return 0; fi
  [[ -s /opt/nvm/nvm.sh ]] || { echo "nvm unavailable" >&2; return 1; }
  echo "requesting Node 22.19.0 from NVM mirror ${NVM_NODEJS_ORG_MIRROR:-https://nodejs.org/dist}"
  timeout 20s bash -lc 'source /opt/nvm/nvm.sh && nvm install 22.19.0 && nvm use 22.19.0'
}

install_pi() {
  if command -v pi >/dev/null 2>&1 && pi --version 2>&1 | grep -q '0.85.1'; then return 0; fi
  timeout 20s npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
}

install_rust() {
  if meets rustc && meets cargo; then return 0; fi
  if ! command -v rustup >/dev/null 2>&1; then
    timeout 20s bash -o pipefail -c "curl --connect-timeout 5 --max-time 15 --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.1" || return 1
  fi
  # shellcheck disable=SC1090
  [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
  timeout 20s rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy
  rustup default 1.98.1
}

install_duckdb() {
  if meets duckdb; then return 0; fi
  timeout 20s bash -o pipefail -c "curl --connect-timeout 5 --max-time 15 -fsSL https://install.duckdb.org | DUCKDB_VERSION=1.5.5 sh" || return 1
  export PATH="$HOME/.duckdb/cli/latest:$PATH"
}

attempt "Node 22.19.0+" install_node
# Pi is only a fallback runtime: installed only when it is the selected one (NEWSROOM_AGENT=pi), as `news doctor` requires it.
if [[ "${NEWSROOM_AGENT:-}" == "pi" ]]; then
  attempt "Pi 0.85.1" install_pi
fi
attempt "Rust 1.98.1 + Cargo" install_rust
attempt "DuckDB 1.5.5" install_duckdb

python3 "$ROOT/scripts/live_readiness.py"
readiness=$?
if [[ $readiness -ne 0 || $failures -ne 0 ]]; then
  exit 2
fi
