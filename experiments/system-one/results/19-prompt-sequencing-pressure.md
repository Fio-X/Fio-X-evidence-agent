# 19-prompt-sequencing-pressure

## Hypothesis

The deterministic request-routing layer in `src/prompt.rs` is a bounded candidate for a sparse supervisor: profile selection, output-format requirements, language selection, and explicit visual-mode extraction can be represented as structured routing metadata. Evidence, verification, claim policy, renderer sequencing, and completion gates should remain deterministic/runtime-enforced because moving them to model prose risks semantic loss.

## Commands and measurements

- Inspected `src/prompt.rs`, `prompts/investigate.md`, `src/commands/investigate.rs`, and `src/commands/continue_investigation.rs` at commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`, branch `exp/system-one-r1-19-prompt-sequencing-pressure`.
- `cargo test --locked prompt::tests`: PASS, 4/4.
- `cargo test --locked commands::investigate::completion_tests`: PASS, 3/3.
- `cargo build --locked`: PASS.
- `target/debug/news investigate --dry-run ...` prompt sizes: plain request 5,522 bytes; visual request 7,362 bytes; complex visual request 9,448 bytes; Chinese complex visual request 9,447 bytes.
- Static audit: 7 public decision functions in `src/prompt.rs`; routing decisions are consumed across initial investigation, continuation, and completion logic. `is_visual_request` and `is_complex_visual_request` each have 8–9 source references; `required_visual_modes` has 7.
- `git diff --check` and `git status --short`: PASS; no product-source changes.

## Observed values

Visual routing adds 1,840 bytes over the plain dry-run prompt; complex visual routing adds 3,926 bytes. The deterministic functions cover 24 visual trigger literals and explicit mode/format/language decisions, while the visual contract itself contains safety- and provenance-sensitive instructions. Existing tests demonstrate that explicit modes cannot be silently replaced by unrelated charts and that completion retries preserve required modes.

## Limitations

This is static and local evidence only: no provider run, wall-time reduction, token reduction, or model-equivalence measurement was performed. Prompt byte counts include the fixed investigation template and are not serialized-token counts. A round-2 implementation must compare structured-routing behavior against the current functions and retain runtime validation for evidence, verification, provenance, and publication gates.

No secrets were copied into this report.

## Classification

PROMOTE
