#!/bin/bash
# Pi login configuration script - OpenAI-compatible relay (Anthropic Messages route)

echo "Configuring Pi to use the relay API"
echo ""
echo "Note: this script walks you through Pi's API configuration"
echo ""

# Check that Pi is installed
if ! command -v pi &> /dev/null; then
    echo "Pi is not installed. Run first: ./scripts/setup.sh"
    exit 1
fi

echo "Pi is installed"
echo ""

# The relay's Hermes/Pi route is Anthropic Messages. Use the external .env that is already
# loaded; do not write the key into the script, the shell history or a log.
if [[ -z "${NEWSROOM_RELAY_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]]; then
    export NEWSROOM_RELAY_API_KEY="${OPENAI_API_KEY}"
fi
if [[ -z "${NEWSROOM_RELAY_API_KEY:-}" ]]; then
    echo "NEWSROOM_RELAY_API_KEY or OPENAI_API_KEY was not found (load the external .env first)"
    exit 1
fi
export NEWSROOM_RELAY_BASE_URL="${NEWSROOM_RELAY_BASE_URL:-${OPENAI_BASE_URL:-}}"
if [[ -z "${NEWSROOM_RELAY_BASE_URL}" ]]; then
    echo "NEWSROOM_RELAY_BASE_URL or OPENAI_BASE_URL was not found (load the external .env first)"
    exit 1
fi
export NEWSROOM_PI_PROVIDER=relay
export NEWSROOM_PI_MODEL=claude-sonnet-4-6

echo "Environment variables set:"
echo "   NEWSROOM_RELAY_API_KEY=<configured>"
echo "   NEWSROOM_RELAY_BASE_URL=${NEWSROOM_RELAY_BASE_URL}"
echo "   NEWSROOM_PI_PROVIDER=${NEWSROOM_PI_PROVIDER}"
echo "   NEWSROOM_PI_MODEL=${NEWSROOM_PI_MODEL}"
echo ""

# Test Pi
echo "Testing the Pi connection..."
echo ""

# Create the test file
cat > /tmp/pi_test.txt << 'EOT'
Hello, please respond with "OK" if you can read this.
EOT

# Try calling Pi
if pi --provider relay --model claude-sonnet-4-6 /tmp/pi_test.txt 2>&1 | grep -q "OK\|ok"; then
    echo "Pi is configured."
    echo ""
    echo "You can now run:"
    echo "  news investigate 'your topic'"
else
    echo "The Pi test failed"
    echo ""
    echo "Manual steps:"
    echo "1. Run: pi"
    echo "2. Enter: /login"
    echo "3. Choose: relay"
    echo "4. Use the key from the external .env (it is not shown in the terminal)"
    echo "5. API mode: anthropic_messages"
    echo "6. Base URL: the relay address"
fi

rm -f /tmp/pi_test.txt
