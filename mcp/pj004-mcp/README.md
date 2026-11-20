# pj004-mcp

A small stdio [MCP](https://modelcontextprotocol.io) server in front of the `news` command. It starts `news` as a child process, the
way any user would, and relays what that process printed. It decides nothing itself.

It has one tool, `pj004_verify`. It never starts a model run, never talks to a model and takes no key. The crate is separate from the
`news` package: it has its own `Cargo.lock` (rmcp 3.8.0) and adds nothing to the `news` dependency tree. Nothing here has been tried in
a real MCP host yet.

## Build and run

    cd mcp/pj004-mcp
    cargo build --release        # binary: target/release/pj004-mcp
    pj004-mcp --runs <run root> [--news <news program>]

- `--runs` (required): the folder that holds the run folders. It must exist and be a folder.
- `--news` (optional): the `news` program to start. Default: the `PJ004_NEWS_BIN` environment variable, else `news` from PATH.
- Transport: stdio only, one JSON-RPC message per line, nothing else on stdout; the process exits when stdin closes.
- Protocol: handled by rmcp. The tests cover the `initialize` handshake and a handshake-less `server/discover` call (the message
  shapes come from the specification text). Which protocol revision a given host speaks is unverified.

## Register in a host

Claude Code (command form from memory, not run here; check `claude mcp add --help`):

    claude mcp add --transport stdio pj004 -- /path/to/pj004-mcp --runs /path/to/runs

Generic stdio JSON (key names differ per host; unverified for every host):

    { "mcpServers": { "pj004": {
        "command": "/path/to/pj004-mcp",
        "args": ["--runs", "/path/to/runs"],
        "env": { "PJ004_NEWS_BIN": "/path/to/news" } } } }

## Environment of the `news verify` child

The child does not inherit the server's environment. It gets only these names, each only when it is set for the server:

- `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`;
- `NEWSROOM_DUCKDB_BIN`, which tells `news verify --recompute` which DuckDB to start;
- every name starting with `NEWSROOM_VERIFY_`, the opt-in stricter checks of `news verify` (for example
  `NEWSROOM_VERIFY_STRICT_REFS=1`), so a verdict here is not looser than the same `news verify` from a shell. A name with a credential
  word in it (KEY, SECRET, TOKEN, PASSWORD, PASSWD, CREDENTIAL) is dropped even under that prefix.

Anything else, key-like names included, never reaches the child. The server reads no configuration or session files.
A `--recompute` run may outlast a host's default tool timeout (unverified).

## Tool: `pj004_verify`

Runs `news verify <folder> --json [--recompute]` on a stored run folder and returns its result. The input schema is closed: extra
fields are refused.

| field | type | meaning |
|---|---|---|
| `run_id` | string, required | a run folder name under the run root: letters, digits, `-`, `_`, `.`; at most 200 characters; not starting with `.`; no slash; links are refused |
| `recompute` | boolean, default false | also re-run the stored SQL computations with DuckDB (DuckDB must be installed) |

Output (`structuredContent`, also one text block): the JSON object printed by `news verify --json` (`passed`, `checks`, `errors`,
`integrity`, `recompute`, `report`), unchanged except that `report` is shortened to `<run_id>/verification.json`, so no absolute path
leaves the process.

- `passed` comes only from `news verify`. The server refuses a reply whose `passed` disagrees with the exit code.
- A run that did not verify is a result (`passed: false`), not an error.
- `isError: true` means no verdict was reached: bad `run_id`, no such folder, `news` would not start, exit code 2 or a signal, output
  that is not JSON, or more than 300 seconds (the child is killed). Messages are short and show the run root as `<runs>`.
- Side effect: `news verify` writes `verification.json` into that run folder. The server writes nothing else.

## Not done yet

- No tool to start a run, no run status, no follow-up. Only `pj004_verify`.
- No test against a real host (Claude Code, Codex, Cursor), so the registration steps above are untried. No HTTP transport.

## Tests

    NEWS_BIN=<path to a built news> cargo test

The tests are offline. A stdio client (`tests/stdio.rs`) drives the server against a real `news` binary and a mock run, and uses fake
`news` scripts for the error paths and the environment check. `python3` must be on PATH (it runs the mock).
