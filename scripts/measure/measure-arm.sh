#!/bin/zsh
# measure-arm.sh <topic> <arm A|B|C3|R> <news-binary> <out-dir> --commit SHA40 [measure_arm.py flags]
# Refuses to start when a provider or credential variable name is present. PYTHON selects the interpreter (default python3).
set -eu
[ $# -ge 4 ] || { echo "usage: measure-arm.sh <topic> <A|B|C3|R> <news-binary> <out-dir> --commit SHA40 [flags]"; exit 4; }
topic=$1; arm=$2; bin=$3; out=$4; shift 4
here=${0:A:h}
bad=$(env | cut -d= -f1 | grep -v '^CLAUDE_CODE_' | grep -Ei 'KEY|TOKEN|SECRET|PASSWORD|COOKIE|PROXY|ANTHROPIC|OPENAI|BASE_URL|API_URL|^NEWSROOM_AGENT_REAL$' || true)
[ -z "$bad" ] || { echo "refused: provider/credential variable names present: $(echo $bad | tr '\n' ' ')"; exit 4; }
exec "${PYTHON:-python3}" -I "$here/measure_arm.py" --topic "$topic" --arm "$arm" --binary "$bin" --out "$out" "$@"
