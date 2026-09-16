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

# 设置环境变量（给 Pi 使用）
export OPENAI_API_KEY=sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2
export OPENAI_BASE_URL=https://dragoncode.codes

echo "📝 环境变量已设置："
echo "   OPENAI_API_KEY=sk-00b8...bf2"
echo "   OPENAI_BASE_URL=https://dragoncode.codes"
echo ""

# 测试 Pi
echo "🧪 测试 Pi 连接..."
echo ""

# 创建测试文件
cat > /tmp/pi_test.txt << 'EOF'
Hello, please respond with "OK" if you can read this.
EOF

# 尝试调用 Pi
if pi --provider openai --model claude-sonnet-4-6 /tmp/pi_test.txt 2>&1 | grep -q "OK\|ok\|可以"; then
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
    echo "3. 选择: openai"
    echo "4. API Key: sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2"
    echo "5. Base URL: https://dragoncode.codes"
fi

rm -f /tmp/pi_test.txt
