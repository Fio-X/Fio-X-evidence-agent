# DragonCode API 配置指南

## 问题

`news` CLI 依赖 Pi 框架，Pi 需要单独配置 API 凭证，不会自动读取 `.env` 文件。

## 解决方案

### 方法 1: 使用 Pi 登录命令（推荐）

```bash
# 1. 启动 Pi 登录流程
pi /login

# 2. 选择 openai provider

# 3. 输入配置：
#    API Key: sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2
#    Base URL: https://dragoncode.codes

# 4. 验证配置
pi auth

# 5. 测试
news investigate --provider openai --model claude-sonnet-4-6 "测试查询"
```

### 方法 2: 手动配置 Pi（如果方法1不可用）

Pi 的配置文件通常在 `~/.config/pi/` 或类似位置。需要添加 OpenAI provider 配置。

### 方法 3: 临时使用（仅测试）

```bash
# 设置环境变量
export OPENAI_API_KEY=sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2
export OPENAI_BASE_URL=https://dragoncode.codes

# 运行调查
news investigate \
  --provider openai \
  --model claude-sonnet-4-6 \
  --tool-profile visual \
  "你的调查主题"
```

## 已知问题

1. **Pi 不自动读取 .env** - 需要通过 Pi 的 /login 命令配置
2. **DragonCode 需要自定义 Base URL** - 不是标准的 OpenAI endpoint
3. **模型名称警告** - Pi 不认识 `claude-sonnet-4-6`，但会尝试使用

## 建议

对于生产使用，建议：
- 使用标准的 Anthropic/OpenAI API
- 或者为 DragonCode 创建专门的配置文档
- 或者改进 `news` CLI 使其能直接读取 `.env` 文件

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
