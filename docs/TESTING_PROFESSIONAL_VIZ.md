# 🧪 专业可视化工具测试指南

## ✅ 已完成

### Phase 2A 实施
- [x] PiVisualizationTool 实现
- [x] 工具注册（条件性，需要 API key）
- [x] 依赖添加（uuid）
- [x] 编译成功
- [x] 代码提交

---

## 🚀 如何测试

### 准备工作

```bash
# 1. 确保环境变量设置
export DRAGONCODE_API_KEY=your-key-here

# 2. 验证工具已注册
news investigate-v2 \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  --base-url https://dragoncode.codes \
  "列出你可以使用的工具"
```

**预期输出**: 应该看到 4 个工具
- calculate
- create_chart
- create_professional_chart ⭐ (新增)
- web_search

---

### 测试 1: 简单专业图表

```bash
export DRAGONCODE_API_KEY=your-key-here

news investigate-v2 \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  --base-url https://dragoncode.codes \
  "创建专业柱状图：2023年各地区电动车销量。中国913万辆，欧洲294万辆，美国118万辆，其他地区111万辆"
```

**预期行为**:
1. Agent 识别需要专业可视化
2. 调用 `create_professional_chart` 工具
3. 工具调用 Pi investigate
4. 生成 SVG 文件
5. 返回文件路径

**预期输出**:
```
🔧 Tool: create_professional_chart
✅ Created professional bar chart '...' saved to .newsroom/temp/viz-{uuid}/.../*.svg
```

---

### 测试 2: 对比基础 vs 专业

```bash
# 基础图表
news investigate-v2 "创建销量图表：苹果100亿，微软95亿"
# 应该使用 create_chart (Chart.js)

# 专业图表
news investigate-v2 "创建专业出版级销量图表：苹果100亿，微软95亿"
# 应该使用 create_professional_chart (Pi SVG)
```

---

### 测试 3: 完整工作流

```bash
news investigate-v2 \
  "分析2023年新能源车市场：比亚迪302万辆，特斯拉181万辆，大众14万辆。\
   计算市场份额，创建专业的对比图表"
```

**预期行为**:
1. 使用 calculate 计算市场份额
2. 使用 create_professional_chart 生成专业图表
3. 生成完整报告

---

## 🔍 验证点

### 1. 工具注册
```bash
# 有 API key 时
echo $DRAGONCODE_API_KEY
# 应该显示 key

# 工具应该被注册
# 在 investigate-v2 的工具列表中看到 create_professional_chart
```

### 2. Pi 调用
```bash
# 检查是否能调用 Pi
news investigate \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  "测试" | head -5
```

### 3. SVG 生成
```bash
# 运行测试后检查
ls -la .newsroom/temp/viz-*/*/visualizations/*.svg

# 应该看到生成的 SVG 文件
```

### 4. SVG 质量
```bash
# 查看 SVG 内容
cat .newsroom/temp/viz-*/*/visualizations/*.svg | head -20

# 应该包含:
# - <svg> 标签
# - viewBox
# - title, desc (accessibility)
# - 图表元素
```

---

## 🐛 故障排查

### 问题 1: 工具未注册

**症状**: 只看到 3 个工具（没有 create_professional_chart）

**原因**: 
- 没有设置 DRAGONCODE_API_KEY
- 或 ANTHROPIC_API_KEY

**解决**:
```bash
export DRAGONCODE_API_KEY=your-key
# 重新运行
```

---

### 问题 2: Pi 调用失败

**症状**: 
```
Pi investigation failed: ...
```

**检查**:
```bash
# 1. 测试 Pi 直接调用
news investigate --provider dragoncode "测试"

# 2. 检查 provider 配置
cat ~/.pi/agent/models.json | jq '.providers.dragoncode'

# 3. 检查 API key
echo $DRAGONCODE_API_KEY
```

---

### 问题 3: 找不到 SVG

**症状**:
```
No SVG files found in visualizations directory
```

**检查**:
```bash
# 查看临时目录
ls -la .newsroom/temp/

# 查看最新的 artifact
LATEST=$(ls -t .newsroom/temp/viz-* | head -1)
ls -la $LATEST/
ls -la $LATEST/*/visualizations/
```

**可能原因**:
- Pi 调用成功但没有生成可视化
- 使用了错误的 tool-profile（应该是 "visual"）
- Artifact 目录结构不同

---

### 问题 4: Agent 不选择专业工具

**症状**: Agent 使用 create_chart 而不是 create_professional_chart

**原因**: 提示词不够明确

**解决**: 在提示中明确要求
- "专业"
- "出版级"
- "magazine-grade"
- "高质量"

---

## 📊 预期结果

### 成功标准

- [x] 编译通过 ✅
- [ ] 4 个工具注册
- [ ] Agent 能调用 create_professional_chart
- [ ] Pi investigate 成功执行
- [ ] 生成 SVG 文件
- [ ] SVG 质量符合预期

### 输出示例

```
🔧 Loaded 4 tools: calculate, create_chart, create_professional_chart, web_search
🎯 Goal: 创建专业柱状图...

🔄 Iteration 1/20
🔧 Tool: create_professional_chart
✅ Created professional bar chart '2023年各地区电动车销量' 
   saved to .newsroom/temp/viz-a1b2c3d4/.../visualizations/abc123.svg

🔄 Iteration 2/20
💭 Agent: 已创建专业柱状图...

✅ 调查完成
```

---

## 🎯 下一步

### 如果测试成功
1. ✅ 记录成功案例
2. ✅ 准备演示材料
3. ✅ 更新文档
4. ✅ 准备竞赛提交

### 如果测试失败
1. 检查错误信息
2. 参考故障排查
3. 调整代码
4. 重新测试

---

## 💡 使用建议

### 何时使用 create_chart (基础)
- 快速原型
- 简单图表
- 不需要出版质量
- 速度优先（1-2秒）

### 何时使用 create_professional_chart (专业)
- 出版物
- 演示文稿
- 竞赛作品
- 需要 magazine-grade 质量
- 可以接受较长时间（30-60秒）

---

## 📞 如需帮助

如果遇到问题：
1. 检查上述故障排查部分
2. 查看 `.newsroom/temp/` 目录内容
3. 查看 Pi 的输出日志
4. 报告具体错误信息

---

**准备就绪，可以开始测试！** 🚀
