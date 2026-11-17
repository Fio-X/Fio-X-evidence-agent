#!/usr/bin/env python3
"""Every child process the product starts either clears its environment (env_clear plus an allow list) or drops every key-like name
(tool_host::strip_keylike_env), so a model key that `.env` or the user's configuration put into the parent's environment never reaches
a child through inheritance. Static check over non-test Rust code; the runtime behaviour of the helper is covered by the tool_host test
a_stripped_child_inherits_no_key_like_name. A new spawn site fails here until it does one of the two or is named below with a reason."""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = root / "src"
WINDOW = 8  # lines after `Command::new(` in which the clearing or stripping call must appear

# (file, text on the spawn line) -> reason
EXEMPT = {
    ("src/cli.rs", "clap::Command::new"): "clap command builder, not a process",
    ("src/pi.rs", "Command::new(std::env::current_exe().unwrap_or_else(|_| self.binary.clone()))"): "Rust agent child: strip_keylike_env in the rust branch of the same function, then the real route's allow list",
    ("src/pi.rs", "Command::new(&self.binary)"): "old Pi child (NEWSROOM_AGENT=pi fallback only): Pi itself needs the provider key in its environment",
}

main_rs = (src / "main.rs").read_text(encoding="utf-8")
test_mods = set(re.findall(r"#\[cfg\(test\)\]\s*\n\s*mod (\w+);", main_rs))

bad = []
seen_exempt = set()
for path in sorted(src.rglob("*.rs")):
    rel = path.relative_to(root).as_posix()
    if path.stem in test_mods:
        continue
    lines = path.read_text(encoding="utf-8").splitlines()
    # product code ends where the file's test module starts
    for i, line in enumerate(lines):
        if line.startswith("#[cfg(test)]") and i + 1 < len(lines) and lines[i + 1].startswith("mod "):
            lines = lines[:i]
            break
    for i, line in enumerate(lines):
        if "Command::new(" not in line or line.lstrip().startswith("//"):
            continue
        hit = next((key for key in EXEMPT if key[0] == rel and key[1] in line), None)
        if hit:
            seen_exempt.add(hit)
            continue
        window = "\n".join(lines[i : i + WINDOW])
        if "env_clear()" not in window and "strip_keylike_env(" not in window:
            bad.append(f"{rel}:{i + 1}: {line.strip()}")

assert not bad, "child processes that inherit the parent's environment unfiltered:\n" + "\n".join(bad)
stale = sorted(set(EXEMPT) - seen_exempt)
assert not stale, f"exemptions without a spawn site: {stale}"
print(f"child env no keys: PASS ({len(seen_exempt)} named exemptions)")
