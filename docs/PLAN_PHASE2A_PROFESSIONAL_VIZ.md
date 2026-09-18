# 🎯 方案 2 实施计划：集成专业可视化系统

## 📊 现状分析

### ✅ 已完成
1. **Phase 1-3**: 基础 Agent 系统 (investigate-v2)
   - LLM 客户端
   - 工具系统 (web_search, calculate, create_chart)
   - Agent 循环

2. **DragonCode + Pi 连接成功**
   - Pi 已配置 dragoncode provider
   - 测试连接成功
   - `news investigate` 命令可以调用

### 🔍 发现的问题
1. **专业可视化工具链复杂**
   - 需要先 `record_claim`（验证声明）
   - 然后 `newsroom_viz_plan`（规划可视化）
   - 最后 `newsroom_viz_render`（渲染输出）

2. **工作流要求**
   - Magazine-grade 质量需要完整的编辑工作流
   - 需要数据验证和声明记录
   - 多步骤协作

---

## 🎯 方案 2 目标

**整合旧架构的专业可视化系统到新的 Agent**

### 核心优势
- ✅ Magazine-grade 信息图
- ✅ 符合竞赛标准（SND, OJA, IIB）
- ✅ 响应式设计（desktop + mobile）
- ✅ 专业 SVG 输出
- ✅ 编辑工作流

---

## 🔧 实施方案

### 方案 2A: Pi 作为可视化后端（推荐）⭐

**架构**:
```
investigate-v2 (新 Agent)
    ↓ 数据收集 + 计算
    ↓ 准备好数据
    ↓ 调用 Pi RPC
Pi (专业可视化)
    ↓ newsroom_viz_plan
    ↓ newsroom_viz_render
    ↓ 返回 SVG
investigate-v2
    ↓ 整合到报告
```

**优势**:
- 复用所有专业功能
- 最快实现（1-2天）
- 质量保证

**实现步骤**:
1. 创建 Pi RPC 调用工具
2. 包装 `newsroom_viz_plan`
3. 包装 `newsroom_viz_render`
4. 整合到 investigate-v2

**时间**: 1-2天

---

### 方案 2B: 直接调用 newsroom 扩展

**架构**:
```
investigate-v2
    ↓ 直接 import newsroom.ts
    ↓ 调用可视化函数
    ↓ 生成 SVG
```

**问题**:
- newsroom.ts 是 TypeScript
- 需要 Node.js runtime
- 依赖管理复杂

**时间**: 3-5天

---

### 方案 2C: 提取核心逻辑重写

**架构**:
```
重写可视化逻辑（Rust）
    ↓ SVG 生成
    ↓ 布局算法
    ↓ 响应式设计
```

**问题**:
- 重复造轮子
- 2900+ 行代码
- 测试工作量大

**时间**: 1-2周

---

## 📋 推荐路径：方案 2A

### Phase 1: Pi RPC 工具 (4-6小时)

**Step 1.1**: 创建 PiRpcTool
```rust
pub struct PiRpcTool {
    provider: String,
    model: String,
    tool_profile: String,
}

impl Tool for PiRpcTool {
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        // 调用 pi 命令
        // 传递参数
        // 解析结果
    }
}
```

**Step 1.2**: 测试 Pi 调用
```bash
news investigate-v2 "测试 Pi RPC 调用"
```

---

### Phase 2: 可视化工具包装 (6-8小时)

**Step 2.1**: CreateProfessionalChartTool
```rust
pub struct CreateProfessionalChartTool {
    pi_rpc: PiRpcTool,
}

async fn execute(&self, params: Value) -> Result<ToolResult> {
    // 1. 准备数据
    // 2. 调用 Pi newsroom_viz_plan
    // 3. 调用 Pi newsroom_viz_render
    // 4. 返回 SVG 路径
}
```

**Step 2.2**: 数据准备辅助
```rust
fn prepare_viz_data(data: Value) -> VizSpec {
    // 转换为 Pi 期望的格式
}
```

---

### Phase 3: 端到端测试 (2-4小时)

**测试场景**:
1. 简单柱状图
2. 多系列折线图
3. 复杂信息图

**验证点**:
- [ ] SVG 生成成功
- [ ] 响应式设计
- [ ] 专业质量
- [ ] Agent 自主调用

---

### Phase 4: 文档和演示 (2-3小时)

**交付物**:
- 使用文档
- 演示视频
- 竞赛材料

---

## 🚀 当前进展

### 正在测试
```bash
news investigate \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  --tool-profile visual \
  "调查2023年全球电动汽车销量数据，创建专业的数据可视化信息图"
```

**目标**: 
- 验证 Pi 可视化工作流
- 获取输出格式
- 确认集成可行性

---

## 📊 预期结果

### 完成后能力

**investigate-v2** 将拥有:
1. ✅ 基础图表（Chart.js）- 已有
2. ✅ **专业信息图**（Pi newsroom）- 新增
3. ✅ 数据收集（web_search）
4. ✅ 数据处理（calculate）
5. ✅ 完整报告生成

### 竞赛得分提升

**当前** (Chart.js):
- 工具质量: 20/25
- 业务价值: 22/25
- 总分: **88/100**

**完成方案 2**:
- 工具质量: 25/25 ⬆️
- 业务价值: 25/25 ⬆️
- 总分: **95/100** 🏆

---

## ⏱️ 时间规划

### Day 1 (今天剩余时间)
- [x] 验证 Pi + DragonCode 连接
- [ ] 完成测试调查
- [ ] 分析输出格式
- [ ] 设计 PiRpcTool 接口

### Day 2
- [ ] 实现 PiRpcTool (4小时)
- [ ] 实现 CreateProfessionalChartTool (4小时)
- [ ] 基础测试

### Day 3
- [ ] 端到端测试 (3小时)
- [ ] 文档编写 (2小时)
- [ ] 演示准备 (2小时)

---

## 🎬 最终演示场景

### 场景 1: 基础图表 (1分钟)
```bash
news investigate-v2 "创建简单的销量对比图"
# 使用 Chart.js
```

### 场景 2: 专业信息图 (2-3分钟)
```bash
news investigate-v2 --use-professional-viz "调查电动车市场，创建magazine-grade信息图"
# 使用 Pi newsroom 系统
# 展示完整工作流
```

### 场景 3: 对比展示 (1分钟)
```
基础图表 vs 专业信息图
- 质量差异
- 适用场景
- 灵活选择
```

---

## 🎯 成功标准

### 必须达成
- [x] Pi + DragonCode 连接
- [ ] PiRpcTool 实现
- [ ] 生成专业 SVG
- [ ] Agent 自主调用

### 加分项
- [ ] 多种图表类型
- [ ] 响应式输出
- [ ] 完整编辑工作流
- [ ] 声明验证集成

---

## 💡 风险和备选方案

### 风险 1: Pi 调用太慢
**缓解**: 添加超时和降级到 Chart.js

### 风险 2: 输出格式不兼容
**缓解**: 转换层适配

### 风险 3: 时间不够
**备选**: 
- 保留 Chart.js 版本参赛
- 方案 2 作为增强版

---

## 📞 决策点

**如果测试成功** → 继续方案 2A
**如果测试失败** → 评估方案 2B 或回退方案 1

---

**当前状态**: 🔄 测试中
**预计完成**: Day 3
**目标得分**: 95/100
