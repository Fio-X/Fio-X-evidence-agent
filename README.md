# Agentic Data Newsroom

A Rust control plane for an agentic data newsroom: ask a news question, get a verified Chinese infographic page.

## Overview

- **Rust CLI**: the control plane and the agent loop (`news`), talking to the model API directly
- **Node.js tool host and Python scripts**: the tools the agent calls (data, rendering, checks)
- **Several renderers**: Web, D3, Sigma, maps and more

## Quick start

```bash
# 1. Clone
git clone https://github.com/Fio-X/Fio-X-evidence-agent.git
cd Fio-X-evidence-agent

# 2. Check the tool dependencies (Node.js, Python, Rust) and install DuckDB 1.5.5
./scripts/setup.sh

# 3. Install the news CLI
cargo install --path . --locked

# 4. Save your model provider and API key (asked interactively; the key is not echoed)
news login

# 5. Check the setup (run it in the repository folder, so rustc is the pinned 1.98.1)
news doctor

# 6. Start; results go to .newsroom/artifacts/<run-id> under the current folder
news investigate "Global climate data in 2025"

# Or start the conversational newsroom with no subcommand
news
# Type a first goal, then follow-ups or new chart requests
# :help lists commands, :path shows the current artifact, :new starts over, :quit exits
```

No global npm package is needed: the agent loop is built into `news`.

### API key configuration

`news login` asks for a provider, opens the provider's key page if you want, reads the key with echo off, sends one
one-token test request, and saves the result to `~/.config/fio-x/credentials` (or `$XDG_CONFIG_HOME/fio-x/credentials`)
with permissions `600`.

| Provider | Saved as | Notes |
|---|---|---|
| Anthropic (Claude API) | `anthropic` | Key page: https://console.anthropic.com/settings/keys |
| OpenAI-compatible relay | `relay` | Anthropic Messages route |
| Custom endpoint | `anthropic` + `base_url` | Any Anthropic Messages-compatible URL |

```bash
news login --show    # provider, model, endpoint and the key masked (first 8 and last 4 characters)
news login --clear   # remove the saved login

# Non-interactive (scripts, CI): the key comes on standard input, never as an argument
printf '%s\n' "$KEY" | news login --provider anthropic --model claude-sonnet-4-6 --key-stdin
```

Precedence: a key already set in the shell or in a `.env` file (the current folder's `.env`, `NEWSROOM_ENV_FILE`,
or `~/.config/fio-x/.env`) wins, and the saved login is then not read at all. Existing `.env` setups keep working
unchanged. A credentials file that other users can read is refused until you run `chmod 600` on it.

The key is handed to the agent over its standard-input protocol, never through a command-line argument or a child
process's environment, and it is never written to logs, events or error messages.

### Manual installation

If the setup script fails, install the pieces by hand.

Requirements (`news doctor` checks that Rust, DuckDB and Node.js are at least these versions and reports `live ready no` otherwise):
- Rust 1.98.1 or later: `rust-toolchain.toml` pins 1.98.1 for builds, so rustup installs and uses it inside the repository folder
  (run `rustup default 1.98.1` to make it the default elsewhere)
- DuckDB 1.5.5 or later: `python3 -m pip install --user duckdb-cli==1.5.5` installs the tested version
- Node.js 22.19.0 or later (runs the tool host)
- Python 3.13+

```bash
# Build the Rust CLI
cargo build --release

# Python dependencies
pip install -r runtimes/viz-browser/requirements.txt
pip install -r runtimes/viz-graph-extract/requirements.txt
```

### Basic use

```bash
# Check the environment
./target/release/news doctor

# Start an investigation (relative output paths are taken from the current folder)
./target/release/news investigate "Global climate data in 2025"

# Conversational newsroom; reads the configuration as described above, writes results under the current folder
./target/release/news

# Output defaults to ./.newsroom/artifacts/<run-id> under the folder you start from
# Pick another folder with --out; add --confirm-output to be asked first
./target/release/news investigate --out ./results --confirm-output "Global climate data in 2025"

# A .env managed elsewhere (for example a symlink) can be named explicitly; the CLI only reads it
NEWSROOM_ENV_FILE="$HOME/.config/fio-x/.env" \
  ./target/release/news investigate "Global climate data in 2025"

# Continue an investigation: its folder and a follow-up instruction
./target/release/news continue .newsroom/artifacts/<run-id> "Add a chart by region"

# Verify the output
./target/release/news verify <investigation-directory>

# Audit the tool calls
./target/release/news inspect <investigation-directory>
```

## Architecture

```
Fio-X-evidence-agent/
├── src/              # Rust control plane
│   ├── main.rs       # CLI entry
│   ├── agent_loop.rs # the built-in agent loop (the default runtime)
│   ├── agent_serve.rs# the agent child process and its model route
│   ├── artifact.rs   # investigation bundles
│   ├── verify.rs     # evidence integrity checks
│   ├── audit.rs      # tool-call audit
│   ├── pi.rs         # runs the agent child; the old Pi runtime is a fallback (NEWSROOM_AGENT=pi)
│   └── hash.rs       # SHA-256 helpers
├── scripts/          # Python and shell tools
├── runtimes/         # visualization runtimes
│   ├── viz-browser/  # browser rendering
│   └── viz-graph-extract/ # graph data extraction
├── config/           # configuration
│   ├── tool-registry.json
│   ├── backend-policy.json
│   └── release-profiles.json
├── fixtures/         # test fixtures
└── schemas/          # JSON Schema definitions
```

## Command reference

### `news doctor`
Checks the local dependencies and prints `live ready yes` when every required one passes.

```bash
# Basic check
./target/release/news doctor

# Strict: exit with an error unless live ready
./target/release/news doctor --strict

# JSON output
./target/release/news doctor --json
```

### `news login`
Save the model provider, model and API key (see "API key configuration" above).

```bash
news login            # interactive
news login --show     # key masked
news login --clear
```

### `news ask`
Send one stateless prompt to the agent.

```bash
./target/release/news ask "What is the latest climate data?"
```

### `news investigate`
Start a persistent data investigation.

```bash
./target/release/news investigate "Global climate trends in 2025"

# Pick the model
./target/release/news investigate --provider anthropic --model claude-opus-5 "..."

# Use the full tool profile
./target/release/news investigate --tool-profile full "..."

# The report and the generated HTML/SVG go to .newsroom/artifacts/<run-id>/ under the
# current folder; --out picks another folder.
./target/release/news investigate --out ./results "..."
```

### `news continue`
Continue an existing investigation: give its folder and a follow-up instruction.

```bash
./target/release/news continue .newsroom/artifacts/<run-id> "Add a chart by region"
```

### `news inspect`
Print the tool-call audit of an investigation.

```bash
./target/release/news inspect <investigation-directory>

# JSON output
./target/release/news inspect --json <investigation-directory>
```

### `news verify`
Check an investigation's evidence integrity, hashes and references.

```bash
./target/release/news verify <investigation-directory>

# JSON output
./target/release/news verify --json <investigation-directory>
```

## Tool profiles

`--tool-profile` picks the tools the agent can use:

- **investigate** (default): basic investigation tools (search, data, charts)
- **visual**: full visual composition (charts, explainers, illustrations)
- **visual-story**: complex infographics (StoryGraph, GIS, flow and network publication, portable HTML fallback)
- **publication**: the publication pipeline (layout, QA, pre-publication checks)
- **competition**: the full competition tool set
- **full**: every available tool

### Data and delivery for visual requests

When the goal of `news investigate` asks for a chart, visualization, infographic, SVG or HTML, the default `investigate`
profile is raised to `visual`. The agent must look at local files first; missing data may only be fetched as
reproducible CSV, JSON, Parquet or TSV through `news_search`, `fetch_url` and `download_data`, and chart rows are then
computed with `duckdb_query`, never taken from model memory or made up with `VALUES`.

A single chart produces the smallest deliverable by default (an SVG and a self-contained HTML companion); a multi-module
HTML report is made only when a full report is asked for. The `visual-story` profile's complex-infographic path uses the
visual backends, map and network analysis and publication tools it actually exposes, and finishes through
`newsroom_publication_plan` → `newsroom_publication_render` → `newsroom_publication_qa`; when a template fallback is
needed it can use `newsroom_lieflat_catalog` → `newsroom_lieflat_render`. With the `publication`, `competition` or
`full` profile, `newsroom_portable_publication` is also available; it is not part of `visual-story`. Publication keeps
checking verified claims and their source and computation bindings; without verifiable data no publishable factual
chart is made.

A verified claim is the bar for publishing a factual chart, not for loading a visualization skill or exploring a chart
grammar. `visual-story` inherits the `visual` tool surface (canonical `visual-story` → `visual` profile inheritance), so
its effective surface includes visual planning tools such as `newsroom_viz_plan`, and draft verification can be used to
check layout and interaction while exploring. `visual-story` adds its own design, composition and publication tools,
and stays under the evidence, verification, completion, publication and browser-QA gates before final delivery.
`newsroom_portable_publication` is exposed only by `publication`, `competition` and `full`, not by `visual-story`.

The built-in agent talks to the model over Anthropic Messages. Tool-call arguments must decode to a JSON object; an
array field (for example `data` or `modules`) that the model encodes as a string is refused at the dispatch boundary
with the field's path.

## Development

### Tests

```bash
# Rust unit tests
cargo test

# Lints
cargo clippy

# Integration
./scripts/smoke.sh

# Full suite
./scripts/integration_qualification.sh
```

### Formatting

```bash
# Rust
cargo fmt

# Python (needs black)
black scripts/
```

### Release build

```bash
cargo build --release --locked
```

## License

MIT License - Copyright (c) 2026

## Contributing

The project is under active development. Please open an issue with questions or suggestions.
