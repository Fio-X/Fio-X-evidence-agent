#!/usr/bin/env python3
"""Regression tests for the causal autonomy and split-qualification contracts."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from selftest_evaluator import build_valid  # noqa: E402


def run_evaluator(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "evaluate_agentic_artifact.py"),
            str(root),
            "--provider",
            "mock-provider",
            "--model",
            "mock-model",
        ],
        capture_output=True,
        text=True,
    )


def write(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="newsroom-agentic-hardening-") as tmp:
        root = Path(tmp) / "artifact"
        build_valid(root)

        ok = run_evaluator(root)
        if ok.returncode != 0:
            print(ok.stdout)
            print(ok.stderr, file=sys.stderr)
            raise SystemExit("valid causal-autonomy fixture should pass agentic qualification")
        qualification = json.loads((root / "agentic-qualification.json").read_text(encoding="utf-8"))
        if qualification.get("qualification_type") != "agentic" or qualification.get("passed") is not True:
            raise SystemExit("agentic qualification metadata mismatch")

        story_path = root / "story.json"
        story = json.loads(story_path.read_text(encoding="utf-8"))
        story["autonomy"]["adaptive_replanning_observed"] = False
        write(story_path, story)
        bad = run_evaluator(root)
        if bad.returncode == 0:
            raise SystemExit("artifact without adaptive replanning must fail agentic qualification")

        evidence = Path(tmp) / "evidence"
        evidence.mkdir()
        preflight = evidence / "preflight.json"
        rc = evidence / "rc.json"
        cold = evidence / "cold.json"
        agentic = evidence / "agentic.json"
        integration = evidence / "integration.json"
        human = evidence / "human.json"
        write(preflight, {"status": "PASS"})
        write(rc, {"status": "PASS"})
        write(cold, {"status": "PASS"})
        write(
            agentic,
            {
                "qualification_type": "agentic",
                "passed": True,
                "checks": {
                    "causal_autonomous_execution": True,
                    "adaptive_replanning": True,
                    "hidden_tool_failure_recovery": True,
                    "same_session_follow_up": True,
                    "contextual_follow_up_replanning": True,
                },
            },
        )
        write(integration, {"passed": True, "checks": {"browser_publication_passed": True}})
        write(human, {"passed": True, "reviewer_qualification": "fixture", "artifact_sha256": "a" * 64})

        # The repository's lock state can keep the overall dossier BLOCKED. The
        # contract under test is that both independent provider gates are read.
        output = evidence / "final.json"
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "final_qualification.py"),
                "--preflight",
                str(preflight),
                "--rc-report",
                str(rc),
                "--cold-report",
                str(cold),
                "--agentic-qualification",
                str(agentic),
                "--integration-qualification",
                str(integration),
                "--human-attestation",
                str(human),
                "--output",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        dossier = json.loads(output.read_text(encoding="utf-8"))
        if dossier["checks"].get("agentic_provider_qualification") is not True:
            raise SystemExit("final dossier did not accept valid agentic provider evidence")
        if dossier["checks"].get("integration_provider_qualification") is not True:
            raise SystemExit("final dossier did not accept valid integration provider evidence")

        output2 = evidence / "final-without-agentic.json"
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "final_qualification.py"),
                "--preflight",
                str(preflight),
                "--rc-report",
                str(rc),
                "--cold-report",
                str(cold),
                "--integration-qualification",
                str(integration),
                "--human-attestation",
                str(human),
                "--output",
                str(output2),
            ],
            capture_output=True,
            text=True,
        )
        dossier2 = json.loads(output2.read_text(encoding="utf-8"))
        if dossier2["checks"].get("agentic_provider_qualification") is not False:
            raise SystemExit("integration evidence must not satisfy the agentic provider gate")

    print("agentic hardening contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
