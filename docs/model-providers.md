# Model provider architecture

The newsroom CLI keeps model-vendor concerns below the agent runtime boundary. Rust owns the CLI, artifacts, audit trail, and process lifecycle. Pi owns model protocol handling. Newsroom tools remain identical regardless of the selected model.


## Live qualification baseline

The v0.9 source release retains Pi coding agent 0.85.1 and Node.js 22.19.0 as the provider-layer qualification baseline in `versions.json`. Later Pi/model versions remain eligible after the behavioral qualification gate below passes; the newsroom artifact and tool contracts do not depend on one vendor release.

## Support matrix

| Provider | Integration path | Protocol | Newsroom status |
| --- | --- | --- | --- |
| OpenAI API | Pi built-in `openai` | OpenAI Responses / Chat Completions | native |
| ChatGPT Plus/Pro | Pi subscription login | Codex subscription route | optional interactive auth path |
| Anthropic Claude API | Pi built-in `anthropic` | Anthropic Messages | native |
| DeepSeek API | Pi built-in `deepseek` | provider-native Pi catalog; current DeepSeek API also exposes OpenAI/Anthropic-compatible transports | native |
| Kimi API | Pi custom provider | OpenAI-compatible Chat Completions | configured in `models.json` |
| Z.AI / GLM | Pi custom provider | OpenAI-compatible Chat Completions | configured in `models.json` |
| DragonCode or another gateway | Pi custom provider | OpenAI-compatible or Anthropic-compatible, depending on gateway contract | configurable gateway |

The Rust CLI already forwards `--provider`, `--model`, and `--thinking` to Pi. No newsroom tool or artifact schema depends on a model vendor.

## Credentials

Never place provider keys in prompts, artifacts, source files, command history, or checked-in config. `models.json` should reference environment variables only.

Examples:

```bash
export OPENAI_API_KEY='...'
export ANTHROPIC_API_KEY='...'
export DEEPSEEK_API_KEY='...'
export KIMI_API_KEY='...'
export ZAI_API_KEY='...'
export DRAGONCODE_API_KEY='...'
```

Copy `config/pi-models.example.json` into Pi's global model config and edit only the provider/model metadata that your account actually supports:

```bash
mkdir -p ~/.pi/agent
cp config/pi-models.example.json ~/.pi/agent/models.json
```

The DragonCode entry is intentionally a template. Set `DRAGONCODE_BASE_URL`, `DRAGONCODE_MODEL`, and the protocol in `models.json` to match the gateway documentation available to your account. Do not infer the protocol from the brand name.

## Examples

OpenAI:

```bash
news investigate \
  --provider openai \
  --model gpt-5.6-sol \
  --thinking high \
  "Find a defensible data-news angle in the supplied energy dataset"
```

Claude:

```bash
news investigate \
  --provider anthropic \
  --model claude-opus-5 \
  --thinking high \
  "Investigate the strongest counter-intuitive trend"
```

DeepSeek:

```bash
news investigate \
  --provider deepseek \
  --model deepseek-v4-pro \
  --thinking high \
  "Investigate the strongest counter-intuitive trend"
```

Kimi after custom-provider configuration:

```bash
news investigate \
  --provider kimi \
  --model kimi-k3 \
  --thinking high \
  "Investigate the strongest counter-intuitive trend"
```

Z.AI / GLM after custom-provider configuration:

```bash
news investigate \
  --provider zai \
  --model glm-5.1 \
  --thinking high \
  "Investigate the strongest counter-intuitive trend"
```

DragonCode or another API gateway after its exact transport has been configured:

```bash
news investigate \
  --provider dragoncode \
  --model "$DRAGONCODE_MODEL" \
  --thinking high \
  "Investigate the strongest counter-intuitive trend"
```

## Provider qualification gate

A provider is considered newsroom-compatible only after it passes the same behavioral suite. A successful plain-text completion is insufficient. The model must demonstrate:

1. multi-turn session continuity;
2. reliable JSON-schema tool calls;
3. at least three sequential newsroom capability calls;
4. correct tool-result replay after an error;
5. plan revision after contradictory evidence;
6. no corruption of SQL, source URLs, or claim IDs;
7. a clean `agent_settled` completion;
8. deterministic artifact output independent of provider prose style.

This turns model support into a tested capability instead of a configuration claim.

## Recommended routing policy

Do not bind one vendor to the product. Treat the primary model as a runtime choice. Later versions can add role-based routing, for example a cheaper model for source triage, a strong reasoning model for story planning, and a vision-capable model for visual critique. All arithmetic and evidence verification should remain in deterministic tools rather than depend on the selected LLM.

## Live qualification execution

Configuration does not qualify a provider. `.github/workflows/live-qualification.yml` runs two independent gates. `scripts/agentic_qualification.sh` evaluates an open-goal two-turn investigation with hidden fault injection and writes `agentic-qualification.json`; `scripts/integration_qualification.sh` exercises the complete visual/publication contract and writes `qualification.json`. Provider comparison uses the agentic artifact so scripted subsystem coverage cannot stand in for autonomous planning.
