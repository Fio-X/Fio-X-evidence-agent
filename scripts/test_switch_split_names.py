#!/usr/bin/env python3
"""A switch name is never built from a split "NEWSROOM_" prefix, except by the credential-name test fixtures listed below.

test_switch_owner_table.py finds switches by grepping for NEWSROOM_ followed by name characters, so concat!("NEWSROOM_", "X") would read
a switch without a table row. The credential-name tests need a fixture that looks like a credential, and a whole-name literal would count as
a switch there, so those few fixtures are joined with concat! instead. Everything else that joins the prefix to a name (concat!, + , a
template or format string, a prefix split off from the word NEWSROOM) turns this test red, and so does one more fixture, one fewer, or one in another file."""
import re
import subprocess
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parents[1]
SCOPE = ("src", "runtime", "scripts")
# Same product-code scope as test_switch_owner_table.py: tests and vendored bundles do not define a switch.
EXCLUDE = (":!runtime/pi/vendor", ":!runtime/pi/visual_skill_bundle.mjs", ":!runtime/web/vendor", ":!scripts/test_*", ":!scripts/measure/test_*", ":!scripts/fixtures/pin_patches")
ALLOWED = Counter({
    ("src/agent_serve.rs", "KEY"): 1, ("src/agent_serve.rs", "APIKEY"): 1,
    ("src/pi.rs", "KEY"): 3, ("src/pi.rs", "APIKEY"): 3,
    ("src/tool_host.rs", "KEY"): 1, ("src/tool_host.rs", "APIKEY"): 1, ("src/tool_host.rs", "PASSWD"): 1, ("src/tool_host.rs", "CREDENTIALS"): 1,
    ("src/tool_host.rs", "SERVICE_TOKEN_2"): 1, ("src/tool_host.rs", "KEYBOARD_MODE"): 1, ("src/tool_host.rs", "DEMO_API_KEY"): 1,
})
CONCAT = re.compile(r'concat!\(\s*"NEWSROOM_"\s*,\s*"([A-Z0-9_]+)"\s*\)')
# Other ways to join the prefix to a name: quote right after NEWSROOM_ or NEWSROOM, then , + .to_string() .push_str; or NEWSROOM_ then {, ${, %.
OTHER = re.compile(r'NEWSROOM_?["\'`]\s*(?:,|\+|\.to_|\.push)|NEWSROOM_(?:\{|\$\{|%)|concat!\([^)]*NEWSROOM')


def scan(files):
    """files: {path: text}. Returns a Counter of (path, name) for concat! fixtures and (path, '?') for any other split form."""
    found = Counter()
    for path, text in files.items():
        for line in text.splitlines():
            named = CONCAT.findall(line)
            found.update((path, name) for name in named)
            rest = CONCAT.sub("", line)
            found.update((path, "?") for _ in OTHER.finditer(rest))
    return found


listed = subprocess.run(["git", "ls-files", "--", *SCOPE, *EXCLUDE], cwd=root, capture_output=True, text=True, check=True).stdout.split("\n")
files = {}
for path in filter(None, listed):
    try:
        files[path] = (root / path).read_text(encoding="utf-8")
    except (UnicodeDecodeError, FileNotFoundError):
        continue
found = scan(files)
assert found == ALLOWED, f"split NEWSROOM_ names differ from the fixture list: extra {dict(found - ALLOWED)}, missing {dict(ALLOWED - found)}"

# Built-in mutations: each of these must turn the scan red.
mutations = {
    "a real switch name joined with concat!": ("src/pi.rs", 'let n = concat!("NEWSROOM_", "SPEED_DESIGN_PACK");'),
    "a fixture used once more": ("src/tool_host.rs", 'concat!("NEWSROOM_", "KEY"),'),
    "a fixture in another file": ("src/prompt.rs", 'concat!("NEWSROOM_", "KEY"),'),
    "a plus-joined name in JavaScript": ("runtime/pi/newsroom.ts", 'const n = "NEWSROOM_" + "SPEED_DESIGN_PACK";'),
    "a format string": ("src/pi.rs", 'let n = format!("NEWSROOM_{}", name);'),
    "a template string": ("runtime/pi/newsroom.ts", "const n = `NEWSROOM_${name}`;"),
    "a prefix split off from the word": ("src/pi.rs", 'let n = concat!("NEWSROOM", "_SPEED_DESIGN_PACK");'),
}
for label, (path, line) in mutations.items():
    mutated = dict(files)
    mutated[path] = mutated.get(path, "") + "\n" + line + "\n"
    assert scan(mutated) != ALLOWED, f"mutation not caught: {label}"
print(f"switch split names: PASS ({sum(ALLOWED.values())} fixture joins in {len({p for p, _ in ALLOWED})} files, {len(mutations)} mutations red)")
