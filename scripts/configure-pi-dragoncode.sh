#!/bin/bash
# Pi 登录配置脚本 - DragonCode API

echo "🔧 配置 Pi 使用 DragonCode API"
echo ""
echo "注意：这个脚本会引导你完成 Pi 的 API 配置"
echo ""

# 检查 Pi 是否安装
if ! command -v pi &> /dev/null; then
    echo "❌ Pi 未安装。请先运行: ./scripts/setup.sh"
    exit 1
fi

echo "✅ Pi 已安装"
echo ""

# DragonCode 的 Hermes/Pi 路由是 Anthropic Messages。使用已加载的外部
# .env；不要把 key 写入脚本、shell 历史或日志。
if [[ -z "${DRAGONCODE_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]]; then
    export DRAGONCODE_API_KEY="${OPENAI_API_KEY}"
fi
if [[ -z "${DRAGONCODE_API_KEY:-}" ]]; then
    echo "❌ 未找到 DRAGONCODE_API_KEY 或 OPENAI_API_KEY（请先加载外部 .env）"
    exit 1
fi
export DRAGONCODE_BASE_URL="${DRAGONCODE_BASE_URL:-${OPENAI_BASE_URL:-https://dragoncode.codes}}"
export NEWSROOM_PI_PROVIDER=dragoncode
export NEWSROOM_PI_MODEL=claude-sonnet-4-6

echo "📝 环境变量已设置："
echo "   DRAGONCODE_API_KEY=<configured>"
echo "   DRAGONCODE_BASE_URL=${DRAGONCODE_BASE_URL}"
echo "   NEWSROOM_PI_PROVIDER=${NEWSROOM_PI_PROVIDER}"
echo "   NEWSROOM_PI_MODEL=${NEWSROOM_PI_MODEL}"
echo ""

# 测试 Pi
echo "🧪 测试 Pi 连接..."
echo ""

# 创建测试文件
cat > /tmp/pi_test.txt << 'EOF'
Hello, please respond with "OK" if you can read this.
EOF

# 尝试调用 Pi
if pi --provider dragoncode --model claude-sonnet-4-6 /tmp/pi_test.txt 2>&1 | grep -q "OK\|ok\|可以"; then
    echo "✅ Pi 配置成功！"
    echo ""
    echo "现在可以运行："
    echo "  news investigate '你的调查主题'"
else
    echo "⚠️ Pi 测试失败"
    echo ""
    echo "手动配置步骤："
    echo "1. 运行: pi"
    echo "2. 输入: /login"
    echo "3. 选择: dragoncode"
    echo "4. 使用外部 .env 中的 key（不在终端显示）"
    echo "5. API mode: anthropic_messages"
    echo "6. Base URL: https://dragoncode.codes"
fi

rm -f /tmp/pi_test.txt
