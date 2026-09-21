# Round-1 experiment 03: prompt bytes

Hypothesis: prompt construction is materially larger for the visual-story route than for the compact investigate route, with the visual delivery contracts being the main incremental contributors.

Commands and measurements:

- Read-only baseline: branch `exp/system-one-r1-03-prompt-bytes`, commit `7188f692fb8d849bc2b4fea02af64d0a3423d00e`; `git status --short` was clean before this result file.
- Built with `CARGO_TARGET_DIR=/private/tmp/system-one-03-target.V82LHl cargo build --release --locked` and ran the deterministic `scripts/perf_mock_pi.py` twice, with output roots under `/private/tmp/system-one-03-runs.D7tk3E`.
- Plain investigate goal (`Investigate recent global migration trends`): one `investigate` RPC, `prompt_bytes=5,544`; `prompt.md` was also 5,544 bytes.
- Complex visual goal (`Create a complex multi-module visual story ... self-contained HTML and desktop/mobile PNG`): initial `visual-story` RPC, `prompt_bytes=9,167`; two completion retries were 1,058 bytes each. The aggregate was 11,283 bytes across three calls.
- Component accounting from generated prompts: `prompts/investigate.md` is 5,287 bytes; generated base/template-plus-goal portion was 5,314 bytes plain and 5,393 bytes visual; the visual prompt’s language portion was about 224 bytes, visual-delivery contract 1,836 bytes, and complex-visual contract 1,714 bytes. Thus the visual contracts added about 3,550 bytes over the generated base before retries.
- Runtime profile evidence: plain route used tool profile `investigate` with 14 tools; visual route used `visual-story` with 47 tools. Mock token counters and tool calls were zero, as expected for this deterministic peer.

Observed values support the hypothesis: the initial visual-story payload was 3,623 bytes / 65.3% larger than the plain investigate payload, and the two visual contracts accounted for roughly 39% of the initial visual prompt.

Limitations: only one representative goal per route was measured; prompt size varies with goal text, explicit visual modes, and local-data paths. The mock does not model provider tokenization or network compression, and it cannot satisfy visual completion gates, so the visual command exited nonzero after producing the prompt metrics. Measurements are UTF-8 bytes, matching the runtime’s `prompt.len()` field.

No secrets were copied into this report. Temporary build/run artifacts are under `/private/tmp/system-one-03-*`.

Classification: PROMOTE
