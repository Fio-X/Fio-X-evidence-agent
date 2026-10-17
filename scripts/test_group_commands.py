#!/usr/bin/env python3
"""The four group commands (agent / knowledge / visual / system) behind NEWSROOM_GROUP_COMMANDS=1.

Switch off: help, each command's help and the unknown-command error are byte-identical to the recorded output of the
build before the group commands existed (scripts/fixtures/group_commands_off.json). Switch on: each group command equals its
old command, `news visual` prints one short help, a wrong pairing names the right group, and the CLI's group mapping equals the
`commands` section of runtime/pi/groups.json. Offline: runs the binary with an empty environment and a throwaway HOME; the
provider commands are only ever run with --help.

Run: python3 scripts/test_group_commands.py [--record]   (NEWS_BIN=<path> to use a given binary; --record rewrites the fixture
from the binary, which must then be a build without the group commands)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from selftest_evaluator import build_valid  # noqa: E402

FIXTURE = ROOT / "scripts" / "fixtures" / "group_commands_off.json"
SWITCH = "NEWSROOM_GROUP_COMMANDS"
OLD = ["doctor", "ask", "investigate", "continue", "inspect", "verify"]
PROVIDER = ["ask", "investigate", "continue", "doctor"]
GROUP_OF = {"ask": "agent", "investigate": "agent", "continue": "agent",
            "verify": "knowledge", "doctor": "system", "inspect": "system", "review": "system"}


def binary() -> str:
    path = os.environ.get("NEWS_BIN") or str(ROOT / "target" / "debug" / "news")
    if not os.environ.get("NEWS_BIN") and not Path(path).exists():
        subprocess.run(["cargo", "build", "--quiet"], cwd=ROOT, check=True)
    return path


def run(news: str, args: list[str], home: str, on: bool = False, cwd: str | None = None) -> dict:
    env = {"HOME": home, "PATH": "/usr/bin:/bin"}
    if on:
        env[SWITCH] = "1"
    p = subprocess.run([news, *args], env=env, capture_output=True, cwd=cwd or home, timeout=60)
    return {"stdout": p.stdout.decode(), "stderr": p.stderr.decode(), "rc": p.returncode}


OFF_CASES = [["--help"], ["-h"], ["help"], ["--version"], ["nosuch"], ["agent"], ["agent", "ask", "x"], ["visual"],
             ["knowledge", "verify", "x"], ["system", "inspect", "x"]] + [[c, "--help"] for c in OLD] + [[c, "-h"] for c in OLD]


def main() -> None:
    news = binary()
    results = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append(name)
        if not ok:
            raise SystemExit(f"FAIL: {name}\n{detail}")

    with tempfile.TemporaryDirectory(prefix="newsroom-groupcmd-") as tmp:
        home = os.path.join(tmp, "home")
        os.mkdir(home)
        if "--record" in sys.argv:
            FIXTURE.write_text(json.dumps({" ".join(a): run(news, a, home) for a in OFF_CASES}, indent=1, ensure_ascii=False) + "\n")
            print("recorded", FIXTURE)
            return
        golden = json.loads(FIXTURE.read_text())

        # 1. switch off: byte-identical to the recorded output, also when the switch is unset, "0", "true" or "" (exact "1" only)
        for value in (None, "0", "true", "", "yes"):
            for args in OFF_CASES:
                env = {"HOME": home, "PATH": "/usr/bin:/bin"}
                if value is not None:
                    env[SWITCH] = value
                p = subprocess.run([news, *args], env=env, capture_output=True, cwd=home, timeout=60)
                got = {"stdout": p.stdout.decode(), "stderr": p.stderr.decode(), "rc": p.returncode}
                check(f"off ({value!r}): {' '.join(args)}", got == golden[" ".join(args)], f"got {got}\nwant {golden[' '.join(args)]}")

        # 2. switch on: top-level help is the old help plus the four groups
        off_help = golden["--help"]["stdout"]
        on_help = run(news, ["--help"], home, on=True)
        check("on: --help exit 0", on_help["rc"] == 0)
        added = [l for l in on_help["stdout"].splitlines() if l not in off_help.splitlines()]
        check("on: --help adds only the four group lines", len(added) == 4 and [l.split()[0] for l in added] == ["agent", "knowledge", "visual", "system"], str(added))
        for line in off_help.splitlines():
            if re.match(r"^  (doctor|ask|investigate|continue|inspect|verify) ", line):
                check(f"on: --help still lists {line.split()[0]}", line in on_help["stdout"].splitlines())
        check("on: -h and help also list the groups", all("knowledge" in run(news, a, home, on=True)["stdout"] for a in (["-h"], ["help"])))

        # 3. switch on: every group command's --help equals the old command's --help; old commands unchanged
        for c in OLD:
            for flag in ("--help", "-h"):
                old = run(news, [c, flag], home, on=True)
                check(f"on: old `{c} {flag}` unchanged", old == golden[f"{c} {flag}"])
                new = run(news, [GROUP_OF[c], c, flag], home, on=True)
                check(f"on: `{GROUP_OF[c]} {c} {flag}` == old", new == old, f"{new}\n{old}")
        # group lists
        for g, cmds in (("agent", PROVIDER[:3]), ("knowledge", ["verify"]), ("system", ["doctor", "inspect"])):
            for args in ([g], [g, "--help"], [g, "-h"]):
                out = run(news, args, home, on=True)
                check(f"on: `news {' '.join(args)}` lists its commands", out["rc"] == 0 and all(re.search(rf"^  {re.escape(c)}\s", out["stdout"], re.M) for c in cmds), str(out))

        # 4. visual: one short help, exit 0, no invented command
        for args in (["visual"], ["visual", "--help"], ["visual", "-h"]):
            v = run(news, args, home, on=True)
            check(f"on: `news {' '.join(args)}`", v["rc"] == 0 and v["stderr"] == "" and len(v["stdout"].splitlines()) == 1 and "no command-line commands" in v["stdout"], str(v))

        # 5. wrong pairing names the right group; exit code equals the usage error of an unknown command
        unknown = run(news, ["nosuch"], home, on=True)
        for c, g in GROUP_OF.items():
            for wrong in {"agent", "knowledge", "system"} - {g}:
                w = run(news, [wrong, c], home, on=True)
                check(f"on: `news {wrong} {c}` names `{g}`", w["rc"] == unknown["rc"] == 2 and f"news {g} {c}" in w["stderr"] and w["stdout"] == "", str(w))
        w = run(news, ["agent", "nosuch"], home, on=True)
        check("on: unknown command in a group is a usage error", w["rc"] == 2 and "nosuch" in w["stderr"], str(w))

        # 6. inspect and verify for real on an offline fixture folder: old vs group command, identical stdout, stderr, exit code
        art = Path(tmp) / "run"
        build_valid(art)
        for old, group in (("inspect", "system"), ("verify", "knowledge")):
            for extra in ([], ["--json"] if False else []):
                a = run(news, [old, str(art), *extra], home, on=True)
                b = run(news, [group, old, str(art), *extra], home, on=True)
                c = run(news, [old, str(art), *extra], home)
                check(f"on: `{group} {old}` on a fixture == `{old}` (and == switch off)", a == b == c, f"{a}\n{b}\n{c}")
        missing = str(Path(tmp) / "nope")
        for old, group in (("inspect", "system"), ("verify", "knowledge")):
            a, b = run(news, [old, missing], home, on=True), run(news, [group, old, missing], home, on=True)
            check(f"on: `{group} {old}` on a missing folder == `{old}`", a == b and a["rc"] != 0, f"{a}\n{b}")

        # 7. one source of truth: the CLI reads its mapping from groups.json (src/cli.rs command_groups, compiled in); here the behaviour is checked
        # against the json: each command with a subcommand works under the group the json names, and a wrong pairing names the json's group
        groups_json = json.loads((ROOT / "runtime" / "pi" / "groups.json").read_text())["commands"]
        check("groups.json commands equal the recorded mapping (the launcher `interactive` has no subcommand)",
              {k: v["group"] for k, v in groups_json.items() if k != "interactive"} == GROUP_OF and groups_json["interactive"]["group"] == "agent", str(groups_json))
        for command, entry in groups_json.items():
            if command == "interactive":
                continue
            a, b = run(news, [command, "--help"], home, on=True), run(news, [entry["group"], command, "--help"], home, on=True)
            check(f"on: `{entry['group']} {command} --help` == `{command} --help` (group from groups.json)", a == b and a["rc"] == 0, f"{a}\n{b}")
        names = json.loads((ROOT / "runtime" / "pi" / "groups.json").read_text())["groups"]
        top = run(news, ["--help"], home, on=True)["stdout"]
        check("groups.json names the four groups with the visual group last-but-one, and the top help (switch on) lists them in that order",
              names == ["agent", "knowledge", "visual", "system"] and [g for g in names if re.search(rf"^\s+{g}\s", top, re.M)] == names, f"{names}\n{top}")

    print(f"group command checks: {len(results)} passed")


if __name__ == "__main__":
    main()
