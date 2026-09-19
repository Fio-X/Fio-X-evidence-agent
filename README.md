# Agentic Data Newsroom

Rust 控制平面 + Pi 驱动的智能数据新闻编辑室。

## 简介

本项目是一个用于数据调查和可视化的智能代理系统，包含:
- **Rust CLI**: 核心控制平面 (`news` 命令)
- **Python 脚本**: 可视化运行时和验证工具
- **多运行时支持**: Web、D3、Sigma、Map 等可视化引擎

## 🚀 快速开始（推荐）

### 一键安装所有依赖

```bash
# 1. 克隆项目
git clone <repo-url>
cd PJ004

# 2. 运行自动安装脚本
./scripts/setup.sh

# 3. 安装 news CLI
cargo install --path . --locked

# 4. 配置 API Key（推荐把配置放在项目目录的 .env；news 会自动读取白名单设置）
cat > .env <<'EOF'
NEWSROOM_PI_PROVIDER=dragoncode
NEWSROOM_PI_MODEL=claude-sonnet-4-6
OPENAI_BASE_URL=https://dragoncode.codes
OPENAI_API_KEY=your_key_here
EOF

# 5. 验证安装
news doctor

# 6. 开始使用；结果自动写入当前目录 .newsroom/artifacts/<run-id>
news investigate "分析2025年全球气候数据"

# 最简单的方式：不带子命令进入连续对话式编辑室
news
# 输入第一句目标，之后继续输入追问或新的图表要求
# :help 查看命令，:path 查看当前 artifact，:new 开始新调查，:quit 退出
```

### 手动安装

如果自动脚本失败，可以手动安装：

### 前置要求
- Rust 1.98.1+
- Node.js 22.19.0+
- Python 3.13+
- Pi CLI (`@earendil-works/pi-coding-agent`)

### 安装

```bash
# 构建 Rust CLI
cargo build --release

# 安装 Python 依赖
pip install -r runtimes/viz-browser/requirements.txt
pip install -r runtimes/viz-graph-extract/requirements.txt

# 安装 Pi
npm install -g @earendil-works/pi-coding-agent@0.85.1
```

### 基本使用

```bash
# 检查环境
./target/release/news doctor

# 开始调查（相对输出路径以启动命令的当前目录为基准）
./target/release/news investigate "分析2025年全球气候数据"

# 进入连续对话式编辑室；news 会自动读取当前目录 .env，或用户配置
# ~/.config/fio-x/.env，结果仍写入启动命令所在目录
./target/release/news

# 输出默认位于启动 CLI 的当前目录：./.newsroom/artifacts/<run-id>
# 也可以显式指定目录；需要人工确认时加 --confirm-output
./target/release/news investigate --out ./results --confirm-output "分析2025年全球气候数据"

# 如果密钥由外部 symlink 管理，可显式指定它；CLI 只读取，不复制或改写
NEWSROOM_ENV_FILE=/Users/fio/code/PJ004/.env \
  ./target/release/news investigate "分析2025年全球气候数据"

# 继续现有调查
./target/release/news continue <investigation-id>

# 验证产出
./target/release/news verify <investigation-directory>

# 审计工具调用
./target/release/news inspect <investigation-directory>
```

## 架构

```
PJ004/
├── src/              # Rust 核心控制平面
│   ├── main.rs       # CLI 入口
│   ├── artifact.rs   # 调查产物管理
│   ├── verify.rs     # 证据完整性验证
│   ├── audit.rs      # 工具调用审计
│   ├── pi.rs         # Pi RPC 接口
│   └── hash.rs       # SHA256 哈希工具
├── scripts/          # Python/Shell 工具脚本
├── runtimes/         # 可视化运行时
│   ├── viz-browser/  # 浏览器可视化
│   └── viz-graph-extract/ # 图数据提取
├── config/           # 配置文件
│   ├── tool-registry.json
│   ├── backend-policy.json
│   └── release-profiles.json
├── fixtures/         # 测试固件
├── docs/             # 文档
└── schemas/          # JSON Schema 定义
```

## 命令参考

### `news doctor`
环境健康检查，验证所有依赖项是否正确安装。

```bash
# 基本检查
./target/release/news doctor

# 严格模式（要求可选依赖）
./target/release/news doctor --strict

# JSON 输出
./target/release/news doctor --json
```

### `news ask`
发送单次查询到 Pi（无状态）。

```bash
./target/release/news ask "What is the latest climate data?"
```

### `news investigate`
启动持久化的数据调查会话。

```bash
./target/release/news investigate "分析2025年全球气候趋势"

# 指定模型
./target/release/news investigate --provider anthropic --model claude-opus-5 "..."

# 使用完整工具配置
./target/release/news investigate --tool-profile full "..."

# investigate-v2 同样把报告和生成的 HTML/SVG 放在当前目录的
# .newsroom/artifacts/<run-id>/ 下；可用 --out 覆盖。
./target/release/news investigate-v2 --out ./results "..."
```

### `news continue`
继续现有调查会话。

```bash
./target/release/news continue <investigation-id>
```

### `news inspect`
生成调查的工具调用审计报告。

```bash
./target/release/news inspect <investigation-directory>

# JSON 输出
./target/release/news inspect --json <investigation-directory>
```

### `news verify`
验证调查产物的证据完整性、哈希校验、引用正确性。

```bash
./target/release/news verify <investigation-directory>

# JSON 输出
./target/release/news verify --json <investigation-directory>
```

## 工具配置

通过 `--tool-profile` 选择代理可用的工具集：

- **investigate** (默认): 基础调查工具（搜索、数据、可视化）
- **visual**: 完整视觉合成工具（图表、解释图、插图）
- **visual-story**: 复杂信息图工具（StoryGraph、GIS/流/网络 publication 与 portable HTML fallback）
- **publication**: 发布管线工具（排版、QA、竞赛预检）
- **competition**: 完整竞赛工具集
- **full**: 所有可用工具

### 可视化请求的数据与交付契约

当 `news investigate` 的目标包含“图表 / 可视化 / 信息图 / SVG / HTML”等视觉交付词时，默认的 `investigate` profile 会自动提升为 `visual` profile。代理必须先检查本地文件；缺少数据时只能通过 `news_search`、`fetch_url`、`download_data` 获取可复现的 CSV/JSON/Parquet/TSV，再用 `duckdb_query` 计算图表行，不能用模型记忆或 `VALUES` 伪造数据。

单图默认输出最小可交付物（SVG 与自包含 HTML 伴随文件）；明确要求完整报告时才生成多模块 HTML。复杂组合优先使用 `newsroom_portable_publication`：它把 verified computation 绑定到 Plotly `geo_linked`/Sankey 与 native Canvas network，并输出 self-contained `japanese_editorial` HTML。geo 模块可用经纬度、ISO-3 或国家名，Sankey/network 接受 `*_field` 字段映射，`relationship` 会规范化为网络维度；相关 supporting computations 会在 provenance 中显式留痕。若专业渲染器不可用，`newsroom_lieflat_catalog` → `newsroom_lieflat_render` 会使用仓库锁定版本的 Lieflat Charts 模板作为最后保底。渲染器会校验 verified claim、source 与 computation 绑定；没有可验证数据时返回 `EVIDENCE_BLOCKED`，不会生成看似真实的图。

这里的 verified claim 是“发布事实性图表”的门槛，不是加载可视化 skill 或探索图形语法的门槛。探索阶段可在 `newsroom_viz_plan` 传 `verification_mode: "draft"` 并省略 `claim_id`；生成的 SVG/HTML 会明确标记 `DRAFT`、`publishable: false`，可用于检查布局和交互，但不能进入信息图/出版物。转为最终交付时再切换为 `verification_mode: "verified"`，绑定 `record_claim` 返回的 claim、source 和 computation。

OpenAI Chat Completions 与 Anthropic Messages 的工具协议由客户端分别编码：OpenAI 使用 `type=function` / `function.parameters`，工具调用参数必须解码为 JSON 对象；数组字段（例如 `data`、`modules`）若被模型编码成字符串会在分发边界被拒绝并返回字段路径。

## 开发

### 运行测试

```bash
# Rust 单元测试
cargo test

# 代码检查
cargo clippy

# 集成测试
./scripts/smoke.sh

# 完整测试套件
./scripts/integration_qualification.sh
```

### 代码格式化

```bash
# Rust
cargo fmt

# Python (需要安装 black)
black scripts/
```

### 构建发布版本

```bash
cargo build --release --locked
```

## 许可证

MIT License - Copyright (c) 2026

## 贡献

本项目当前处于活跃开发中。如有问题或建议，请提交 issue。
