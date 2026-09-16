# 🧪 修正的测试命令

## ✅ 正确的测试方法

### 步骤 1: 验证工具注册

```bash
export ANTHROPIC_API_KEY=sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2

news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "列出你可以使用的工具"
```

---

### 步骤 2: 测试专业可视化

```bash
export ANTHROPIC_API_KEY=sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2

news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "创建专业柱状图：2023年各地区电动车销量。中国913万辆，欧洲294万辆，美国118万辆，其他地区111万辆"
```

---

### 步骤 3: 对比测试

```bash
# 基础图表（应该使用 create_chart）
news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "创建简单图表：苹果100亿，微软95亿"

# 专业图表（应该使用 create_professional_chart）
news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "创建专业出版级图表：苹果100亿，微软95亿"
```

---

## 📝 关键点

1. **环境变量**: 使用 `ANTHROPIC_API_KEY` 或 `DRAGONCODE_API_KEY`
2. **Base URL**: `--base-url https://dragoncode.codes`
3. **Provider**: `--provider anthropic` (只能用一次)
4. **Model**: `--model claude-sonnet-5`

---

## 🔍 预期输出

### 工具列表
```
🔧 Loaded 4 tools: calculate, create_chart, create_professional_chart, web_search
```

### 专业图表调用
```
🔄 Iteration 1/20
🔧 Tool: create_professional_chart
✅ Created professional bar chart '...' saved to .newsroom/temp/...
```
