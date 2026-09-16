# Agentic Data Newsroom

Rust 控制平面 + Pi 驱动的智能数据新闻编辑室。

## 简介

本项目是一个用于数据调查和可视化的智能代理系统，包含:
- **Rust CLI**: 核心控制平面 (`news` 命令)
- **Python 脚本**: 可视化运行时和验证工具
- **多运行时支持**: Web、D3、Sigma、Map 等可视化引擎

## 快速开始

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

# 开始调查
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
- **publication**: 发布管线工具（排版、QA、竞赛预检）
- **competition**: 完整竞赛工具集
- **full**: 所有可用工具

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
