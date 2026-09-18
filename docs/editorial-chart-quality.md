# Editorial chart quality audit

## What is in this repository

The repository has a project-local `skills/editorial-chart/SKILL.md`. It covers
chart-family choice, direct labels, units, source notes, truthful axes, mobile
behaviour, deterministic export, and reduced motion. There is no `lieflat-charts`
skill or vendored LieFlat template in this repository.

Before this change, `investigate-v2` built its own system prompt and never read
the local skill. It advertised `create_modern_chart` as the recommended tool.
That renderer used a purple gradient page, a three-colour gradient series,
drop shadows, a white rounded card, elastic animation, a generic interaction
footer, and a timestamped output name. It accepted only labels and values, so
the generated page had no source or unit contract. Those properties explain
the generic presentation seen in the audit.

## What changed on this branch

- The V2 system prompt now embeds the project-owned editorial chart skill.
- The interactive renderer uses paper/ink/line tokens, one solid accent,
  direct labels, explicit unit and source-note fields, a truthful value axis,
  responsive sizing, and `prefers-reduced-motion` handling.
- Data rows are validated instead of silently dropping malformed labels or
  values. Empty data, empty titles, unsupported chart families, and non-finite
  values fail before a file is written.
- The output name is content-addressed (`editorial-echarts-v1` plus a short
  SHA-256 prefix), so equal inputs are reproducible and a changed source note
  cannot overwrite an unrelated chart.
- Tool names and definitions are sorted before they are sent to the model, so
  prompt/tool ordering is stable across runs.

The HTML still loads ECharts from jsDelivr for hover and resize interaction,
but it includes a deterministic inline SVG fallback. The essential chart stays
legible when the CDN is unavailable; the page is still not the canonical
evidence artifact. The professional Pi visualization path remains available
for evidence-backed SVG artifacts.

The broader family-selection and validation rules for Sankey/alluvial,
dandelion-like distribution views, and city/geographic maps are recorded in
[`docs/visualization-best-practices.md`](visualization-best-practices.md).

## DragonCode routing audit

The configured external `.env` currently has `NEWSROOM_PI_PROVIDER=openai`,
`NEWSROOM_PI_MODEL=claude-sonnet-4-6`, `OPENAI_BASE_URL=https://dragoncode.codes`,
and an `OPENAI_API_KEY`. The `news` CLI now reads these whitelisted settings
from the current directory's `.env` (or `NEWSROOM_ENV_FILE`) without printing
values; the installed Pi model catalog instead declares
provider `dragoncode`, API `anthropic-messages`, and model
`claude-sonnet-4-6`. The direct V2 command also used to accept only
`anthropic` and `openai`, and it reads `NEWSROOM_*` names rather than
automatically loading the external `.env`.

DragonCode's documented route is therefore an Anthropic Messages request to
`https://dragoncode.codes/v1/messages`. This branch adds a `dragoncode`
provider to the direct client, accepts the existing OpenAI-named environment
variable as a fallback without printing it, normalizes `/v1/messages` URL
construction, and updates the setup script to use `dragoncode` plus
`anthropic_messages`. A run from an independent worktree can set
`NEWSROOM_ENV_FILE` to the existing external file (or use an equivalent secret
manager); the key is never copied into the worktree or passed on a command
line. The Pi wrapper also detects the exact combination
`NEWSROOM_PI_PROVIDER=openai` plus a DragonCode host and passes
`--provider dragoncode`; this prevents an old OpenAI alias from silently
selecting `/v1/chat/completions`. The compatibility key name is mapped only in
the child process.

## LieFlat relationship and licensing

LieFlat was researched as a design reference, not copied into this project.
Its upstream skill and catalog are available at
<https://github.com/larashero3-dotcom/lieflat-charts>. The upstream repository
uses the PolyForm Noncommercial License 1.0.0, while this project is MIT. This
branch therefore implements compatible high-level editorial constraints in the
project's own skill and renderer; it does not vendor upstream templates or
claim an official LieFlat integration.

## Verification

The Rust unit tests cover malformed data rejection, deterministic IDs, and the
absence of gradient, shadow, and elastic-motion styling in generated HTML. The
visual skill bundle is rebuilt with `scripts/build_visual_skill_bundle.py` and
passes `scripts/test_visual_skill_bundle_v116.py` plus `node --check`.

The optimized worktree secret-pattern audit scanned 858 non-build files and
found zero credential-pattern matches and zero matches against the configured
external value. The original qualification worktree was intentionally left
unchanged; it still needs a separate cleanup and key rotation before any
future commit.

## Flow validation

The bounded strict mock in `scripts/test_anthropic_wire_mock.py` exercises the
route and chart path without provider spend. It completed in 0.010 s with exit
0, two `POST /v1/messages` requests, top-level system text, message roles
`[user]` then `[user, assistant, user]`, and two tool-result blocks grouped in
the second user turn. The fixed conclusion was returned and the fixture key
was absent from stdout and stderr. Generated files were
`/tmp/modern_chart_bar_beada9213b3a.html` and
`/tmp/modern_chart_line_c19eaae73b08.html`; they contain source notes and
direct labels, and have no gradient, shadow, or elastic-motion styles.
Headless screenshots (including JavaScript-disabled SVG fallback) are retained
at `/private/tmp/editorial-chart-four-bars.png` and
`/private/tmp/editorial-chart-four-bars-offline.png`.

A real DragonCode smoke reached the documented endpoint and returned
`403 INSUFFICIENT_BALANCE` (no DNS or route error); the matching real
`investigate-v2` smoke was also bounded and returned the same account blocker.
No real model latency or 3x3 result is inferred from those failures. The
separate baseline/optimized 3x3 live round and its raw samples remain in
`/private/tmp/fio-x-perf-20260916/perf-results/REPORT.md`.
