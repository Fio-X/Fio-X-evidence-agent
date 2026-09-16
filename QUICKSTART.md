# 快速开始指南

## 🚀 从零到运行只需 5 步

### 1️⃣ 克隆项目

```bash
git clone <repo-url>
cd PJ004
```

### 2️⃣ 一键安装所有依赖

```bash
./scripts/setup.sh
```

这个脚本会自动安装：
- ✅ Pi 0.85.1（LLM 代理框架）
- ✅ DuckDB 1.5.5（可选，数据查询）
- ✅ 检查 Node.js、Python、Rust 版本

### 3️⃣ 安装 news CLI

```bash
cargo install --path . --locked
```

安装后，你可以在任何目录使用 `news` 命令。

### 4️⃣ 配置 API Key

```bash
# 配置你使用的 LLM 提供商
export ANTHROPIC_API_KEY=sk-ant-xxxxx

# 或其他提供商
export OPENAI_API_KEY=sk-xxxxx
export DEEPSEEK_API_KEY=xxxxx
```

**持久化配置**（推荐）：

```bash
# 添加到 ~/.zshrc 或 ~/.bashrc
echo 'export ANTHROPIC_API_KEY=sk-ant-xxxxx' >> ~/.zshrc
source ~/.zshrc
```

### 5️⃣ 验证安装

```bash
news doctor
```

期望输出：
```
pi         0.85.1       PASS  0.85.1
duckdb     1.5.5        PASS  v1.5.5
node       >=22.19.0    PASS  v24.14.1
rustc      1.98.1       PASS  rustc 1.98.1
python3    optional     PASS  Python 3.14.6
live ready yes
```

---

## 🎯 立即开始使用

### 示例 1: 数据调查

```bash
news investigate "分析2024年全球气候变化趋势"
```

这会：
1. 启动 Pi 代理
2. 自动搜索相关数据
3. 分析数据并生成可视化
4. 保存调查产物到 `.newsroom/investigations/`

### 示例 2: 快速提问

```bash
news ask "What is the latest climate data?"
```

单次无状态查询，不保存历史。

### 示例 3: 继续之前的调查

```bash
# 列出所有调查
ls .newsroom/investigations/

# 继续特定调查
news continue <investigation-id>
```

---

## 📁 产出物在哪里？

所有调查产物保存在：
```
.newsroom/investigations/<investigation-id>/
├── story.json          # 调查元数据
├── prompt.txt          # 你的提问
├── answer.md           # 最新回答
├── conversation.md     # 完整对话
├── data/               # 下载的数据
├── visualizations/     # 生成的可视化
└── claims.jsonl        # 验证过的声明
```

---

## 🔧 常见问题

### Q: Pi 安装失败？

```bash
# 手动安装
npm install -g @earendil-works/pi-coding-agent@0.85.1

# 检查安装
pi --version
```

### Q: API Key 配置了但还是报错？

```bash
# 检查环境变量
echo $ANTHROPIC_API_KEY

# 确保没有多余空格
export ANTHROPIC_API_KEY=sk-ant-xxxxx  # 正确
export ANTHROPIC_API_KEY=" sk-ant-xxxxx"  # 错误（有空格）
```

### Q: 想使用不同的模型？

```bash
# 使用 Claude Opus
news investigate \
  --provider anthropic \
  --model claude-opus-5 \
  "你的任务"

# 使用 OpenAI GPT-4
news investigate \
  --provider openai \
  --model gpt-4 \
  "你的任务"
```

### Q: 如何查看完整的工具配置？

```bash
news investigate --help
```

---

## 🎓 进阶使用

### 工具配置模式

```bash
# 基础模式（默认）- 搜索、数据、基础可视化
news investigate --tool-profile investigate "任务"

# 视觉模式 - 完整视觉合成（图表、解释图、插图）
news investigate --tool-profile visual "任务"

# 发布模式 - 排版、QA、竞赛预检
news investigate --tool-profile publication "任务"

# 完整模式 - 所有工具
news investigate --tool-profile full "任务"
```

### 验证产出

```bash
# 验证数据完整性、哈希、引用
news verify .newsroom/investigations/<investigation-id>

# 审计工具调用
news inspect .newsroom/investigations/<investigation-id>
```

---

## 📚 更多资源

- 完整文档：[README.md](README.md)
- 迭代计划：[ITERATION_PLAN.md](ITERATION_PLAN.md)
- 问题反馈：提交 GitHub Issue

---

## ✅ 检查清单

安装完成后，确认：

- [ ] `news doctor` 显示 `live ready yes`
- [ ] 已配置至少一个 API Key
- [ ] `news --version` 显示版本号
- [ ] 可以在任意目录运行 `news` 命令

全部完成？🎉 开始你的数据调查之旅吧！
