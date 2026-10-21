#!/usr/bin/env python3
"""prompts/source-table.md (the block `NEWSROOM_SOURCE_TABLE=1` adds to the first prompt) is a table a program can read row by row.

Fixed columns, one row per line, no `|` inside a cell. Candidate rows are keyed by (shape, provider), only for the two shapes the table covers, and are
templates: every address has a <placeholder> and no topic words appear. The limits stay inside the product's own caps in runtime/pi/newsroom.ts. The
negative rows carry the literal first cell `avoid`. probed_at is `unprobed` until a maintainer probe has run, then an ISO date. The first paragraph keeps
saying that the table is not evidence, that other shapes work as before, that the model may use none of it, and that the source is recorded like any other.

The mutation cases change one thing in a copy of the text and expect check() to name it.

Usage: test_source_table.py [TABLE.md]   (default: prompts/source-table.md; the argument lets another copy be checked)"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]

COLUMNS = ["shape", "provider", "address template", "method", "expect", "limits", "catalog", "probed_at"]
AVOID_COLUMNS = ["avoid", "pattern", "seen", "instead"]
SHAPES = {"time-series", "ranking"}
TOOLS = ("download_data", "fetch_url")
# The table is keyed by shape and provider. These words belong to one topic, not to a shape.
TOPIC_WORDS = ("germany", "german", "deutsch", "energy", "nrg_", "electric", "carbon", "co2", "emission", "sankey")
# What the first paragraph has to tell the model.
FRAMING = ("not evidence", "work as before", "use none", "recorded and validated like any other", "never grants verified status")
# One negative row for each: the whole file, a name taken from memory, a host that refuses programs.
AVOID_KINDS = ("bulk file", "guessed", "refuses programs")
ADDRESS = r"`https://[^\s`]+`"


def product_caps():
    """(MB, seconds) a download may take in the product itself, read from the runtime so the table cannot drift above it."""
    src = (root / "runtime/pi/newsroom.ts").read_text(encoding="utf-8")
    found = []
    for name in ("MAX_DATASET_BYTES", "DOWNLOAD_TIMEOUT_MS"):
        hit = re.search(rf"^const {name} = ([\d_]+);", src, re.M)
        assert hit, f"{name} is gone from runtime/pi/newsroom.ts; this test reads the product cap from there"
        found.append(int(hit.group(1).replace("_", "")))
    return found[0] // 1_000_000, found[1] // 1000


def split_tables(text):
    """(first paragraph, tables): a table is a run of lines that start with `|`."""
    intro, tables, current = [], [], []
    for line in text.splitlines():
        if line.startswith("|"):
            current.append(line)
            continue
        if current:
            tables.append(current)
            current = []
        if not tables and line.strip():
            intro.append(line.strip())
    if current:
        tables.append(current)
    return " ".join(intro), tables


def cells(line):
    line = line.strip()
    if not (line.startswith("|") and line.endswith("|")):
        return None
    return [cell.strip() for cell in line[1:-1].split("|")]


def separator_ok(line, width):
    return re.fullmatch(r"\|(-+\|){%d}" % width, line.replace(" ", "")) is not None


def check(text, caps):
    """Every way the table stops being program-readable or stops being a shape-keyed template, as a list of sentences."""
    intro, tables = split_tables(text)
    if len(tables) != 2:
        return [f"expected 2 tables (candidates, then avoid), found {len(tables)}"]
    problems = [f"the first paragraph lost its framing: {need!r}" for need in FRAMING if need not in intro]
    lower = text.lower()
    problems += [f"topic word {word!r} in the source table, which is keyed by shape and provider, not by topic" for word in TOPIC_WORDS if word in lower]

    candidates, avoid = tables
    if cells(candidates[0]) != COLUMNS:
        problems.append(f"candidate header is {cells(candidates[0])}, want {COLUMNS}")
    if len(candidates) < 3 or not separator_ok(candidates[1], len(COLUMNS)):
        problems.append("candidate table needs a separator line and at least one row")
    keys = set()
    for n, line in enumerate(candidates[2:], start=1):
        row = cells(line)
        if row is None or len(row) != len(COLUMNS):
            problems.append(f"candidate row {n} has {'no cells' if row is None else f'{len(row)} cells'}, want {len(COLUMNS)}")
            continue
        shape, provider, address, method, expect, limits, catalog, probed = row
        label = f"candidate row {n} ({shape}, {provider})"
        if not all(row):
            problems.append(f"{label} has an empty cell")
        if shape not in SHAPES:
            problems.append(f"{label}: shape must be one of {sorted(SHAPES)}")
        if not re.fullmatch(r"[a-z][a-z0-9-]*", provider):
            problems.append(f"{label}: the provider key must be a lower-case word")
        if (shape, provider) in keys:
            problems.append(f"{label}: duplicate (shape, provider) key")
        keys.add((shape, provider))
        found = re.fullmatch(ADDRESS, address)
        if not found:
            problems.append(f"{label}: the address template must be one backticked https:// address")
        elif not re.search(r"<[a-z0-9-]+>", found.group(0)):
            problems.append(f"{label}: the address has no <placeholder>; a row is a template, not one dataset")
        if not method.startswith(TOOLS):
            problems.append(f"{label}: the method must start with one of {TOOLS}")
        if not re.match(r"(csv|json|json-stat): ", expect) or "unit:" not in expect or "years:" not in expect:
            problems.append(f"{label}: expect must start with csv:, json: or json-stat: and give unit: and years:")
        limit = re.match(r"max (\d+) MB, (\d+) s(;|$)", limits)
        if not limit:
            problems.append(f"{label}: limits must start with 'max N MB, N s'")
        elif int(limit.group(1)) > caps[0] or int(limit.group(2)) > caps[1]:
            problems.append(f"{label}: limits are above the product cap ({caps[0]} MB, {caps[1]} s)")
        if not re.search(ADDRESS, catalog):
            problems.append(f"{label}: the catalog cell needs a backticked https:// address")
        if probed != "unprobed" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", probed):
            problems.append(f"{label}: probed_at is 'unprobed' or an ISO date, not {probed!r}")
    if not keys:
        problems.append("no candidate rows")

    if cells(avoid[0]) != AVOID_COLUMNS:
        problems.append(f"avoid header is {cells(avoid[0])}, want {AVOID_COLUMNS}")
    if len(avoid) < 3 or not separator_ok(avoid[1], len(AVOID_COLUMNS)):
        problems.append("avoid table needs a separator line and at least one row")
    kinds = set()
    for n, line in enumerate(avoid[2:], start=1):
        row = cells(line)
        if row is None or len(row) != len(AVOID_COLUMNS) or not all(row):
            problems.append(f"avoid row {n} needs {len(AVOID_COLUMNS)} filled cells")
            continue
        if row[0] != "avoid":
            problems.append(f"avoid row {n}: the first cell must be the literal 'avoid'")
        if not re.search(ADDRESS, row[1]):
            problems.append(f"avoid row {n}: the pattern needs a backticked https:// example")
        kinds.update(kind for kind in AVOID_KINDS if kind in row[1])
    problems += [f"no avoid row for {kind!r}" for kind in AVOID_KINDS if kind not in kinds]
    return problems


def sub(old, new):
    def run(text):
        assert old in text, f"mutation anchor not found in the table: {old!r}"
        return text.replace(old, new, 1)

    return run


def drop_lines(pattern):
    def run(text):
        out = re.sub(pattern, "", text, flags=re.M)
        assert out != text, f"mutation pattern matched nothing: {pattern!r}"
        return out

    return run


def append(extra):
    return lambda text: text + extra


LIMITS = "max 25 MB, 30 s"
# (label, mutation, text that must appear in some problem; None = the text must still pass)
CASES = [
    ("a date in probed_at is accepted", sub("| unprobed |\n", "| 2026-10-21 |\n"), None),
    ("a cell dropped from a row", sub(" | unprobed |\n", " |\n"), "7 cells"),
    ("a pipe inside a cell", sub("joins entities", "joins | entities"), "9 cells"),
    ("a third table", append("\n| a | b |\n|---|---|\n| 1 | 2 |\n"), "expected 2 tables"),
    ("a header column renamed", sub("| probed_at |", "| verified_at |"), "candidate header"),
    ("a third shape", sub("| ranking | owid |", "| flows | owid |"), "shape must be one of"),
    ("a duplicated key", sub("| ranking | owid |", "| time-series | owid |"), "duplicate (shape, provider)"),
    ("an address that names one dataset", sub("`https://ourworldindata.org/grapher/<chart-slug>.csv` | download_data; the file", "`https://ourworldindata.org/grapher/life-expectancy.csv` | download_data; the file"), "no <placeholder>"),
    ("an address that is not https", sub("`https://ourworldindata.org/grapher/<chart-slug>.csv?csvType", "`http://ourworldindata.org/grapher/<chart-slug>.csv?csvType"), "backticked https:// address"),
    ("a method that is not a product tool", sub("| download_data; `~` or `+`", "| curl; `~` or `+`"), "method must start with"),
    ("expect without years", sub("years: those in `time`", "those in `time`"), "expect must start with"),
    ("a size limit above the product cap", sub(LIMITS, "max 50 MB, 30 s"), "above the product cap"),
    ("a time limit above the product cap", sub(LIMITS, "max 25 MB, 60 s"), "above the product cap"),
    ("limits in free text", sub(LIMITS, "up to 25 MB"), "limits must start with"),
    ("no catalog address", sub("| `https://ourworldindata.org/data` | unprobed |", "| the data page | unprobed |"), "catalog cell"),
    ("probed_at in free text", sub("| unprobed |\n", "| verified |\n"), "probed_at is 'unprobed' or an ISO date"),
    ("a topic word", sub("`https://ourworldindata.org/data` |", "`https://ourworldindata.org/data` energy |"), "topic word 'energy'"),
    ("no negative rows", drop_lines(r"^\| avoid \| (?!pattern).*\n"), "no avoid row for"),
    ("the refuses-programs row removed", drop_lines(r"^.*refuses programs.*\n"), "no avoid row for 'refuses programs'"),
    ("a negative row without the mark", sub("| avoid | the whole dataset", "| bulk | the whole dataset"), "must be the literal 'avoid'"),
    ("a negative row without an example", sub("`https://ourworldindata.org/grapher/<guessed-slug>.csv`", "a guessed chart name"), "needs a backticked https:// example"),
    ("other shapes no longer work as before", sub("ignore this table and work as before", "ignore this table"), "'work as before'"),
    ("the model no longer free to use none", sub("You may use a row, use none, or find your own source;", "Use a row;"), "'use none'"),
    ("the provenance sentence gone", sub("a source taken from this table is recorded and validated like any other, and the table never grants verified status", "the table is a list"), "'recorded and validated like any other'"),
    ("the not-evidence words gone", sub("; not evidence)", ")"), "'not evidence'"),
    ("only the never-verified words gone", sub(", and the table never grants verified status", ""), "'never grants verified status'"),
    ("the candidate separator line gone", drop_lines(r"^\|(---\|){8}\n"), "candidate table needs a separator line"),
    ("an empty cell", sub("| unprobed |\n\n| avoid | pattern", "|  |\n\n| avoid | pattern"), "has an empty cell"),
    ("a provider key in capitals", sub("| ranking | owid |", "| ranking | OWID |"), "the provider key must be a lower-case word"),
    ("no candidate rows", drop_lines(r"^\| (time-series|ranking) \|.*\n"), "no candidate rows"),
    ("no candidate rows, so no row after the separator", drop_lines(r"^\| (time-series|ranking) \|.*\n"), "candidate table needs a separator line and at least one row"),
    ("expect without a format prefix", sub("| json-stat: JSON-stat 2.0 with id", "| JSON-stat 2.0 with id"), "expect must start with"),
    ("expect without a unit", sub("unit: the `unit` dimension when the dataset has one; years: from `sinceTimePeriod`", "years: from `sinceTimePeriod`"), "expect must start with"),
    ("the avoid header renamed", sub("| avoid | pattern | seen | instead |", "| avoid | pattern | seen | use |"), "avoid header is"),
    ("the avoid separator line gone", drop_lines(r"^\|(---\|){4}\n"), "avoid table needs a separator line"),
    ("no negative rows, so no row after the separator", drop_lines(r"^\| avoid \| (?!pattern).*\n"), "avoid table needs a separator line and at least one row"),
    ("a negative row with a cell missing", sub("| HTTP 404 in one run | take the name", "| take the name"), "avoid row 2 needs 4 filled cells"),
]

EMBED = 'include_str!("../prompts/source-table.md")'


def embed_problems(prompt_rs):
    """src/prompt.rs has to embed this very file, or the table that is checked here is not the one the model sees."""
    return [] if EMBED in prompt_rs else ["src/prompt.rs does not embed prompts/source-table.md"]


def main(path):
    caps = product_caps()
    text = Path(path).read_text(encoding="utf-8")
    problems = check(text, caps)
    prompt_rs = (root / "src/prompt.rs").read_text(encoding="utf-8")
    problems += embed_problems(prompt_rs)
    if problems:
        print("source table: " + "; ".join(problems), file=sys.stderr)
        return 1
    bad = []
    if not embed_problems(prompt_rs.replace(EMBED, 'include_str!("../prompts/other.md")')):  # the embed check must notice another path
        bad.append("a prompt.rs that embeds another file would pass the embed check")
    for label, mutate, expected in CASES:
        found = check(mutate(text), caps)
        if expected is None and found:
            bad.append(f"{label}: should pass but {found}")
        elif expected is not None and not any(expected in problem for problem in found):
            bad.append(f"{label}: no problem names {expected!r}; got {found}")
    if bad:
        print("source table mutation cases that did not behave: " + "; ".join(bad), file=sys.stderr)
        return 1
    _, tables = split_tables(text)
    print(f"source table: PASS ({len(tables[0]) - 2} candidate rows, {len(tables[1]) - 2} avoid rows, {len(CASES)} mutation cases, product cap {caps[0]} MB / {caps[1]} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else root / "prompts/source-table.md"))
