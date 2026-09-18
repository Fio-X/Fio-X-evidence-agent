# DragonCode API 配置指南

## 问题

`news` CLI 依赖 Pi 框架。直接运行 `news` 时，CLI 会从启动命令所在目录的
`.env` 读取白名单中的 provider/model/base URL/key 设置；已经存在的 shell
变量优先，密钥不会打印、复制或写回文件。单独运行 `pi` 仍不会自动读取
`.env`，需要使用 Pi 自己的登录/config 流程。

## 解决方案

### 方法 1: 使用 Pi 登录命令（推荐）

```bash
# 1. 启动 Pi 登录流程
pi /login

# 2. 选择 dragoncode provider

# 3. 输入配置：
#    API Key: <your-key>
#    Base URL: https://dragoncode.codes
#    API mode: anthropic_messages

# 4. 验证配置
pi auth

# 5. 测试
news investigate --provider dragoncode --model claude-sonnet-4-6 "测试查询"
```

### 方法 2: 手动配置 Pi（如果方法1不可用）

Pi 的配置文件通常在 `~/.config/pi/` 或类似位置。需要添加 DragonCode
provider，API mode 使用 `anthropic_messages`，不要把它当作 OpenAI
`chat/completions` endpoint。

### 方法 3: 临时使用（仅测试）

```bash
# 独立 worktree 可直接让 news 读取已有外部 .env；不会将 key 复制到 worktree
NEWSROOM_ENV_FILE="$PWD/.env" \
news investigate --provider dragoncode --model claude-sonnet-4-6 "测试查询"

# 也可以在当前目录放置 .env，再运行：
set -a
source ./.env
set +a
export DRAGONCODE_API_KEY="${DRAGONCODE_API_KEY:-${OPENAI_API_KEY:-}}"
export DRAGONCODE_BASE_URL="${DRAGONCODE_BASE_URL:-${OPENAI_BASE_URL:-https://dragoncode.codes}}"

# 运行调查
news investigate \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  --tool-profile visual \
  "你的调查主题"
```

## 已知问题

1. **单独运行 Pi 不自动读取 .env** - 需要通过 Pi 的 /login 命令配置；`news` CLI 会读取当前目录或 `NEWSROOM_ENV_FILE` 指定文件
2. **DragonCode 使用 Anthropic Messages** - endpoint 是 `/v1/messages`
3. **模型名称** - 账号必须实际拥有 `claude-sonnet-4-6` 权限

## 建议

对于生产使用，建议：
- 使用标准的 Anthropic/OpenAI API
- 或者为 DragonCode 创建专门的配置文档
- 若使用其他启动器，确保它也把相同的白名单设置传给 `news`

## 测试步骤

配置完成后，按以下步骤验证：

```bash
# 1. 检查环境
news doctor

# 2. 简单测试
news ask "Hello, test"

# 3. 完整调查测试
news investigate --tool-profile visual \
  "分析2025年全球电动汽车市场前三名企业的市场份额"
```

## 获取帮助

如果遇到问题：

1. 检查 Pi 文档：`~/.nvm/versions/node/*/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
2. 查看 Pi 配置：`pi config -l`
3. 检查认证状态：`pi auth`
