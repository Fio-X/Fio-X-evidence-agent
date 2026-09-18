# Phase 1 测试指南

## 🎉 Phase 1 POC 已完成！

新的 `news chat` 命令已实现，可以直接调用 LLM API，无需配置 Pi。

---

## 🧪 测试步骤

### 1. 查看命令帮助

```bash
news chat --help
```

应该看到：
```
Direct LLM chat (new agent mode, bypasses Pi RPC)

Usage: news chat [OPTIONS] <PROMPT>...

Arguments:
  <PROMPT>...  Prompt to send

Options:
      --provider <PROVIDER>  LLM provider (anthropic, dragoncode, or openai)
      --model <MODEL>        Model to use
      --api-key <API_KEY>    API key (prefer an environment variable)
      --base-url <BASE_URL>  Custom base URL for API
```

---

### 2. 使用 DragonCode API 测试

#### 方式 A: 使用环境变量（推荐）

```bash
# 设置环境变量
# Load DRAGONCODE_API_KEY from the external secret store before this step.

# 测试
news chat \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  --base-url https://dragoncode.codes \
  "你好，请用中文回答：什么是数据新闻？"
```

#### 方式 B: 使用配置文件

```bash
# 添加到 .env
cat >> .env << 'EOF'
NEWSROOM_PROVIDER=dragoncode
NEWSROOM_MODEL=claude-sonnet-4-6
NEWSROOM_BASE_URL=https://dragoncode.codes
# Load DRAGONCODE_API_KEY from the external secret store before this step.
EOF

# 加载并测试
source .env
news chat "介绍一下 Rust 编程语言"
```

---

### 3. 预期结果

成功的话，你应该看到：

```bash
🤖 Calling OpenAI with model claude-sonnet-4-6...
数据新闻是一种以数据为核心的新闻报道方式...（LLM 的回复）
```

---

### 4. 对比测试

#### 旧命令（会失败）

```bash
# 这个需要 Pi 配置
news ask "Hello"
# 错误：Pi RPC stream ended before the prompt was accepted
```

#### 新命令（应该成功）

```bash
# 这个直接调用 API
news chat "Hello"
# 成功：返回 LLM 回复
```

---

## ✅ 验证清单

- [ ] `news chat --help` 显示正确的帮助信息
- [ ] 使用 DragonCode API 成功获得回复
- [ ] 回复内容合理（中文/英文）
- [ ] 错误提示清晰（如果 API key 错误）

---

## 🐛 常见问题

### 问题 1: "No API key found"

**原因**：环境变量未设置

**解决**：
```bash
export DRAGONCODE_API_KEY=<configured-key>
```

### 问题 2: API 返回 403/401

**原因**：API key 无效或 Base URL 错误

**解决**：
- 检查 API key 是否正确
- 确认 Base URL: `https://dragoncode.codes`
- 确认 provider 设置为 `dragoncode`，API mode 为 `anthropic_messages`

### 问题 3: 连接超时

**原因**：网络问题或 API 服务不可用

**解决**：
- 检查网络连接
- 尝试访问 https://dragoncode.codes 确认服务可用

---

## 📊 成功标志

如果以下测试都通过，Phase 1 就成功了：

1. ✅ 命令帮助正常显示
2. ✅ 能够成功调用 DragonCode API
3. ✅ 返回合理的中文/英文回复
4. ✅ 错误提示清晰友好

---

## 🎯 Phase 1 vs 旧架构

### 旧架构 (ask 命令)
```
优点：
- 功能完整（工具调用、会话管理）

缺点：
- ❌ 需要配置 Pi（复杂）
- ❌ 进程间通信（慢）
- ❌ 依赖外部工具
```

### 新架构 (chat 命令)
```
优点：
- ✅ 配置简单（只需 API key）
- ✅ 响应快速（直接 HTTP）
- ✅ 完全自主（无外部依赖）

限制：
- ⚠️ 暂时没有工具调用（Phase 2 会添加）
- ⚠️ 暂时是单轮对话（Phase 3 会实现多轮）
```

---

## 🚀 测试成功后

当你验证 `news chat` 工作正常后，告诉我结果！

我们可以：
1. 继续 Phase 2：实现工具系统
2. 改进 Phase 1：添加更多功能
3. 或者你有其他想法

---

## 📝 测试记录

记录你的测试结果：

```bash
# 测试 1: 基本调用
news chat "Hello"
结果：[成功/失败]
问题：[如果有]

# 测试 2: 中文对话
news chat "介绍数据新闻"
结果：[成功/失败]
问题：[如果有]

# 测试 3: 复杂提示
news chat "分析2025年AI发展趋势，用3个要点总结"
结果：[成功/失败]
问题：[如果有]
```

---

**准备好后，运行测试并告诉我结果！** 🚀
