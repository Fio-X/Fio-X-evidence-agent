# CLI output layout

`news` resolves every relative output path against the directory in which the
command was started. The default persistent investigation root is
`./.newsroom/artifacts`, so running the CLI from a project directory keeps the
run beside that project rather than beside the installed binary.

Running `news` without a subcommand opens the interactive newsroom. It uses the
same root, keeps one persistent investigation session, and accepts follow-up
messages until `:quit`. `:path` prints the active artifact and `:new` starts a
new investigation. A CSV/JSON/TSV/Parquet path written in a message is imported
automatically when it is a local file.

```text
<working-directory>/.newsroom/artifacts/<timestamp>-<topic>/
├── story.json
├── answer.md
├── conversation.md
├── events.jsonl
├── data/
├── sources/
├── computations/
└── visualizations/
```

Use `--out /absolute/or/relative/path` (or
`NEWSROOM_ARTIFACTS_DIR`) to select another root. The CLI reports the resolved
absolute path on stderr before writing. Add `--confirm-output` when an
interactive confirmation is desired; in a pipe or CI it fails immediately
instead of waiting forever on stdin.

Provider settings are loaded from `.env` in the current directory. If that is
absent, `news` checks the conventional `~/.config/fio-x/.env`; an explicit
`NEWSROOM_ENV_FILE` always takes precedence. Existing shell variables win and
the file is never copied or rewritten.

The `investigate-v2` command uses the same default root and creates a run
folder containing `report.md` and any generated HTML/SVG under
`visualizations/`. Runtime tools receive this run folder through the internal
`NEWSROOM_OUTPUT_DIR` environment variable; it is never included in model
prompts.
