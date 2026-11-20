# Quick start

## From zero to a first run in 5 steps

### 1. Clone

```bash
git clone https://github.com/Fio-X/Fio-X-evidence-agent.git
cd Fio-X-evidence-agent
```

### 2. Install the tool dependencies

```bash
./scripts/setup.sh
```

The script:
- checks the Node.js, Python and Rust versions (Node.js runs the tool host)
- offers to install DuckDB (data queries)

`news doctor` (step 5) needs at least these versions:
- Rust 1.98.1: `rust-toolchain.toml` pins it for builds, so rustup installs and uses it inside the repository folder
  (`rustup default 1.98.1` makes it the default elsewhere);
- DuckDB 1.5.5: `python3 -m pip install --user duckdb-cli==1.5.5` installs the tested version (a later one also passes).

No global npm package is needed: the agent loop is built into `news`.

### 3. Install the news CLI

```bash
cargo install --path . --locked
```

After this, `news` works from any folder.

### 4. Save your API key

```bash
news login
```

`news login` asks for:

1. the provider: Anthropic (Claude API), an OpenAI-compatible relay, or a custom Anthropic Messages-compatible endpoint;
2. whether to open the provider's API key page in your browser;
3. the API key (pasted with echo off);
4. the model (default `claude-sonnet-4-6` for Anthropic-style providers).

It then sends one one-token test request and, if the key works, saves everything to
`~/.config/fio-x/credentials` with permissions `600`.

```bash
news login --show    # show the saved login with the key masked
news login --clear   # remove it
```

For scripts, send the key on standard input (there is deliberately no option that takes the key itself):

```bash
printf '%s\n' "$KEY" | news login --provider anthropic --model claude-sonnet-4-6 --key-stdin
```

**Already using a `.env` file?** It keeps working: a key set in the shell or in a `.env`
(the current folder's `.env`, `NEWSROOM_ENV_FILE`, or `~/.config/fio-x/.env`) takes precedence,
and the saved login is then ignored.

### 5. Check the setup

```bash
news doctor
```

Run it in the repository folder. Every required line should say `PASS`, ending with `live ready yes`; a `FAIL` on
`rustc` or `duckdb` means a version older than the two above.

---

## Using it

### Example 1: an investigation

```bash
news investigate "Global climate trends in 2024"
```

This:
1. starts the agent
2. searches for relevant data
3. analyses it and builds the page
4. saves the run under `.newsroom/artifacts/<run-id>/`

### Example 2: a quick question

```bash
news ask "What is the latest climate data?"
```

One stateless request; nothing is kept.

### Example 3: continue an investigation

```bash
ls .newsroom/artifacts/
news continue .newsroom/artifacts/<run-id> "Add a chart by region"
```

---

## Where is the output?

```
.newsroom/artifacts/<run-id>/
├── story.json          # run metadata
├── prompt.md           # your question
├── answer.md           # latest answer
├── conversation.md     # full conversation
├── data/               # downloaded data
├── visualizations/     # rendered pages and charts
└── claims.jsonl        # verified claims
```

---

## Troubleshooting

### `news login` says the connection test failed

- `HTTP 401` / `HTTP 403`: the key was not accepted; copy it again from the provider's key page.
- `HTTP 404`: check the endpoint URL and the model name.
- `could not connect` / `timed out`: check the URL, your network, or your `HTTPS_PROXY` setting.

Nothing is saved until the test passes.

### "credentials has permissions 644"

The credentials file must be readable by you only:

```bash
chmod 600 ~/.config/fio-x/credentials
```

### A key is set but the saved login is not used

`news login --show` prints `In use: no` when a key from the shell or a `.env` file takes precedence.
Remove that key (for example `unset ANTHROPIC_API_KEY`) to use the saved login.

### Another model for one run

```bash
news investigate --model claude-opus-5 "your question"
```

### All options

```bash
news investigate --help
news login --help
```

---

## More

### Tool profiles

```bash
# Default: search, data, basic charts
news investigate --tool-profile investigate "question"

# Visual: full visual composition (charts, explainers, illustrations)
news investigate --tool-profile visual "question"

# Publication: layout, QA, pre-publication checks
news investigate --tool-profile publication "question"

# Everything
news investigate --tool-profile full "question"
```

### Verify the output

```bash
# Evidence, hashes, references
news verify .newsroom/artifacts/<run-id>

# Tool-call audit trail
news inspect .newsroom/artifacts/<run-id>
```

- Full documentation: [README.md](README.md)
- Iteration plan: [ITERATION_PLAN.md](ITERATION_PLAN.md)

---

## Checklist

- [ ] `news doctor` shows `live ready yes`
- [ ] `news login --show` shows your provider and a masked key (or you use a `.env`)
- [ ] `news --version` prints a version
- [ ] `news` runs from any folder
