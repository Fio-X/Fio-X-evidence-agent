# Round-1 experiment 07: context artifact size

Classification: **PROMOTE**

## Hypothesis

Major IR artifacts and conversation context are materially larger than a boundary packet containing only stable references, hashes, and deterministic reason codes. A bounded Stage Packet could therefore reduce cross-stage context while preserving provenance and validation gates.

## Commands and measurements

Tested commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e` on branch `exp/system-one-r1-07-context-artifact-size`.

- Read `AGENTS.md`, `experiments/system-one/README.md`, `experiments/system-one/manifest.json`, `local-codex/task.md`, `src/artifact.rs`, and the migration IR builder.
- Measured checked-in fixture files with `stat -f '%z %N'` and `wc -c`.
- Ran a temporary Python measurement script (no repository output) over `fixtures/migration/story-ir/`.
- Ran the existing deterministic `scripts/mock_pi.py` with `NEWSROOM_ARTIFACT_DIR` under `/tmp` and measured generated files.
- Verified repository state with `git status --short --branch`.

## Observed values

| Context | Bytes |
|---|---:|
| Migration IR files on disk (10 files) | 247,162 |
| JSON-only migration IR, compact serialized | 145,997 |
| Stage Packet estimate: refs + SHA-256 + reason codes for those 10 files | 1,715 |
| Estimated JSON IR reduction | 144,282 bytes / 98.8% |
| Canonical investigation prompt template | 5,287 |
| Representative user input | 133 |
| Representative follow-up input | 126 |
| Prompt plus both inputs | 5,546 |
| Mock artifact total, including assets | 21,206 |
| Mock artifact JSON only (excluding SVG/PNG/CSV) | 20,513 |
| Mock `plan.json` | 289 |
| Mock `claims.jsonl` | 693 |
| Mock visualization JSON artifacts | 5,149 |
| Mock infographic JSON artifacts | 9,126 |

Largest checked-in IR files were `fact-graph.json` (184,122 bytes), `infographic-spec.json` (16,563), and `route-coordinates.csv` (27,844). The packet estimate retained each artifact path, content hash, and one bounded readiness reason code; it intentionally retained no factual payload.

## Limitations

The repository has no checked-in completed investigation bundle containing `story.json`, `conversation.md`, and a full `plan.json`; the conversation values are representative inputs, and the runtime artifact values come from the existing deterministic mock. The 98.8% figure is a sizing estimate, not a correctness or latency result. It does not prove that every downstream consumer can operate from references alone, nor does it measure tokenization, RPC latency, or provider behavior. The Stage Packet estimate must therefore be validated in a round-2 implementation with explicit provenance and verification checks.

Environment: Darwin 27.0.0 arm64; Python 3.14.6; git 2.50.1.

Temporary non-sensitive measurement artifact: `/tmp/context-artifact-size.45LOX3`.

No secrets were copied into this report.
