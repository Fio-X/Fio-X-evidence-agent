#!/usr/bin/env bash
# Agentic Data Newsroom - 依赖安装脚本

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "🚀 Agentic Data Newsroom - 依赖安装"
echo ""

# 检查 Node.js
echo "📦 检查 Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//')
    echo -e "${GREEN}✓${NC} Node.js $NODE_VERSION 已安装"
else
    echo -e "${RED}✗${NC} Node.js 未安装"
    echo "请访问 https://nodejs.org/ 安装 Node.js >= 22.19.0"
    exit 1
fi

# The agent runtime is built into news (Rust); Pi is no longer installed.
# Only the NEWSROOM_AGENT=pi fallback needs it:
#   npm install -g @earendil-works/pi-coding-agent@0.85.1

# 检查 Python
echo ""
echo "📦 检查 Python..."
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version | awk '{print $2}')
    echo -e "${GREEN}✓${NC} Python $PYTHON_VERSION 已安装"
else
    echo -e "${YELLOW}!${NC} Python3 未安装 (可选依赖)"
fi

# 检查 DuckDB
echo ""
echo "📦 检查 DuckDB..."
if command -v duckdb &> /dev/null; then
    DUCKDB_VERSION=$(duckdb --version | head -1)
    echo -e "${GREEN}✓${NC} DuckDB 已安装: $DUCKDB_VERSION"
else
    echo -e "${YELLOW}!${NC} DuckDB 未安装"
    read -p "是否安装 DuckDB? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            if command -v brew &> /dev/null; then
                brew install duckdb
                echo -e "${GREEN}✓${NC} DuckDB 安装完成"
            else
                echo -e "${RED}✗${NC} 请先安装 Homebrew: https://brew.sh/"
            fi
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Linux
            python3 -m pip install --user duckdb-cli==1.5.5
            echo -e "${GREEN}✓${NC} DuckDB 安装完成"
        else
            echo -e "${YELLOW}!${NC} 请手动安装 DuckDB: https://duckdb.org/"
        fi
    fi
fi

# 检查 Rust
echo ""
echo "📦 检查 Rust..."
if command -v rustc &> /dev/null; then
    RUST_VERSION=$(rustc --version | awk '{print $2}')
    echo -e "${GREEN}✓${NC} Rust $RUST_VERSION 已安装"
else
    echo -e "${YELLOW}!${NC} Rust 未安装 (构建需要)"
    echo "访问 https://rustup.rs/ 安装 Rust"
fi

# API key: saved by `news login` in a file only you can read, not exported into every shell (a key in ~/.zshrc
# would reach every process started from it)
echo ""
echo "⚙️  API key"
echo ""
echo "Run: news login"
echo "  It asks for the provider and the key (echo off), tests it, and saves it to ~/.config/fio-x/credentials (mode 600)."
echo "  A key already set in a .env file (the current folder's .env, NEWSROOM_ENV_FILE or ~/.config/fio-x/.env) still takes precedence."
echo ""

# 运行 doctor 检查
echo "🏥 运行环境检查..."
echo ""
if command -v news &> /dev/null; then
    news doctor || true
else
    echo -e "${YELLOW}!${NC} 'news' 命令未找到"
    echo "请运行: cargo install --path . --locked"
fi

echo ""
echo -e "${GREEN}✅ 依赖检查完成！${NC}"
echo ""
echo "📖 快速开始:"
echo "  1. 配置 API Key: export ANTHROPIC_API_KEY=your_key"
echo "  2. 检查环境: news doctor"
echo "  3. 开始调查: news investigate '你的调查主题'"
