# Relay API setup guide

## The problem

The `news` CLI depends on the Pi framework. When `news` runs, it reads the allow-listed provider, model, base URL and key
settings from the `.env` in the directory it was started from. Variables already set in the shell win, and keys are never
printed, copied or written back to a file. Running `pi` on its own still does not read `.env`; use Pi's own login or config
flow for that.

The relay is an OpenAI-compatible service that speaks the Anthropic Messages route (`/v1/messages`). Its provider id is
`relay`, and its variables are `NEWSROOM_RELAY_API_KEY`, `NEWSROOM_RELAY_BASE_URL` and `NEWSROOM_RELAY_MODEL`.

## Solutions

### Method 1: the Pi login command (recommended)

```bash
# 1. Start Pi's login flow
pi /login

# 2. Choose the relay provider

# 3. Enter the settings:
#    API Key:  <your-key>
#    Base URL: <the relay address>
#    API mode: anthropic_messages

# 4. Check the configuration
pi auth

# 5. Test
news investigate --provider relay --model claude-sonnet-4-6 "test query"
```

### Method 2: configure Pi by hand (if method 1 is not available)

Pi's configuration files are usually under `~/.config/pi/` or a similar place. Add a relay provider (see
`config/pi-models.example.json`) with API mode `anthropic_messages`; do not treat it as an OpenAI `chat/completions`
endpoint.

### Method 3: temporary use (testing only)

```bash
# A separate worktree can let news read an existing external .env; the key is not copied into the worktree
NEWSROOM_ENV_FILE="$PWD/.env" \
news investigate --provider relay --model claude-sonnet-4-6 "test query"

# Or put a .env in the current directory and run:
set -a
source ./.env
set +a
export NEWSROOM_RELAY_API_KEY="${NEWSROOM_RELAY_API_KEY:-${OPENAI_API_KEY:-}}"
export NEWSROOM_RELAY_BASE_URL="${NEWSROOM_RELAY_BASE_URL:-${OPENAI_BASE_URL:-}}"

# Run an investigation
news investigate \
  --provider relay \
  --model claude-sonnet-4-6 \
  --tool-profile visual \
  "your topic"
```

## Known issues

1. **Running Pi on its own does not read .env** - configure it with Pi's `/login` command; the `news` CLI reads the `.env` in the current directory or the file named by `NEWSROOM_ENV_FILE`.
2. **The relay uses Anthropic Messages** - the endpoint is `/v1/messages`.
3. **Model name** - the account must actually have access to `claude-sonnet-4-6`.

## Recommendations

For production use:
- Use the standard Anthropic or OpenAI API, or
- Write a dedicated configuration note for your relay.
- If you use another launcher, make sure it passes the same allow-list settings on to `news`.

## Test steps

After configuring, verify with these steps:

```bash
# 1. Check the environment
news doctor

# 2. A simple test
news ask "Hello, test"

# 3. A full investigation test
news investigate --tool-profile visual \
  "Analyse the market shares of the top three electric-vehicle makers worldwide in 2025"
```

## Getting help

If something goes wrong:

1. Read the Pi docs: `~/.nvm/versions/node/*/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
2. Show the Pi config: `pi config -l`
3. Check the auth status: `pi auth`
