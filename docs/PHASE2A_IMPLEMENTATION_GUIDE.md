# 🚀 Phase 2A 实施计划：集成专业可视化系统

## ✅ 验证成果

### 测试结果（2026-09-16）

**命令**:
```bash
news investigate \
  --provider dragoncode \
  --model claude-sonnet-4-6 \
  --tool-profile visual \
  "调查2023年全球电动汽车销量数据，创建专业的数据可视化信息图"
```

**输出**:
- ✅ 2个专业 SVG 可视化
- ✅ 完整数据验证流程
- ✅ 叙事结构（story graph）
- ✅ 声明记录（claims）
- ✅ Magazine-grade 质量

**文件路径**: `.newsroom/artifacts/20260916T171414930Z-2023/`

---

## 🎯 实施目标

**将 Pi 的专业可视化能力集成到 investigate-v2**

### 最终效果
```bash
news investigate-v2 \
  --use-professional-viz \
  "调查电动车市场，创建专业信息图"
```

**输出**:
- 数据收集（Agent）
- 数据分析（Agent）
- **专业可视化（Pi）** ← 新增
- 完整报告（Agent）

---

## 📋 详细实施步骤

### Step 1: 创建 PiVisualizationTool

**文件**: `src/agent/tools/pi_visualization.rs`

**功能**: 
1. 准备数据
2. 调用 Pi 创建可视化
3. 解析 SVG 输出
4. 返回文件路径

**接口设计**:
```rust
pub struct PiVisualizationTool {
    provider: String,
    model: String,
}

impl Tool for PiVisualizationTool {
    fn name(&self) -> &str {
        "create_professional_chart"
    }
    
    fn description(&self) -> &str {
        "Create magazine-grade data visualization using professional newsroom system. \
         Supports bar charts, line charts, and complex infographics. \
         Returns SVG files suitable for publication."
    }
    
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Chart title"
                },
                "chart_type": {
                    "type": "string",
                    "enum": ["bar", "line", "multi_line"],
                    "description": "Type of chart"
                },
                "data": {
                    "type": "object",
                    "description": "Chart data as SQL or structured format",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "SQL query returning chart data"
                        },
                        "inline": {
                            "type": "array",
                            "description": "Inline data as array of objects"
                        }
                    }
                },
                "x_field": {"type": "string"},
                "y_field": {"type": "string"},
                "subtitle": {"type": "string"},
                "source_note": {"type": "string"}
            },
            "required": ["title", "chart_type", "data"]
        })
    }
    
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        // 1. 提取参数
        let title = params["title"].as_str().unwrap();
        let chart_type = params["chart_type"].as_str().unwrap();
        
        // 2. 准备 SQL 数据
        let sql = if let Some(inline_data) = params["data"]["inline"].as_array() {
            // 转换 inline data 为 SQL
            self.inline_data_to_sql(inline_data)?
        } else {
            params["data"]["sql"].as_str().unwrap().to_string()
        };
        
        // 3. 创建临时 investigation
        let temp_dir = format!(".newsroom/temp/{}", uuid::Uuid::new_v4());
        fs::create_dir_all(&temp_dir)?;
        
        // 4. 写入数据文件
        let data_file = format!("{}/data.csv", temp_dir);
        // ... 生成 CSV
        
        // 5. 调用 Pi
        let output = Command::new("news")
            .args(&[
                "investigate",
                "--provider", &self.provider,
                "--model", &self.model,
                "--tool-profile", "visual",
                "--out", &temp_dir,
                &format!("创建{}图表: {}", chart_type, title)
            ])
            .env("DRAGONCODE_API_KEY", env::var("DRAGONCODE_API_KEY")?)
            .output()
            .await?;
        
        // 6. 解析输出，找到 SVG
        let svg_path = self.find_latest_svg(&temp_dir)?;
        
        // 7. 返回结果
        Ok(ToolResult {
            success: true,
            output: format!("Created professional chart: {}", svg_path),
            data: Some(json!({
                "svg_path": svg_path,
                "artifact_dir": temp_dir
            }))
        })
    }
}

impl PiVisualizationTool {
    fn inline_data_to_sql(&self, data: &[Value]) -> Result<String> {
        // 将 JSON 数据转换为 SQL VALUES
        todo!()
    }
    
    fn find_latest_svg(&self, dir: &str) -> Result<String> {
        // 在 visualizations/ 目录找到最新的 SVG
        let viz_dir = format!("{}/visualizations", dir);
        // ...
        todo!()
    }
}
```

---

### Step 2: 注册工具

**文件**: `src/agent/tools/mod.rs`

```rust
mod pi_visualization;
pub use pi_visualization::PiVisualizationTool;

pub fn create_default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    
    registry.register(WebSearchTool);
    registry.register(CalculateTool);
    registry.register(CreateChartTool);
    
    // 如果有 DragonCode API key，注册专业可视化
    if env::var("DRAGONCODE_API_KEY").is_ok() {
        registry.register(PiVisualizationTool::new(
            "dragoncode".to_string(),
            "claude-sonnet-4-6".to_string()
        ));
    }
    
    registry
}
```

---

### Step 3: 更新 Agent 提示词

**文件**: `src/agent/core.rs`

```rust
let system_prompt = format!(
    r#"You are an autonomous data journalism agent.

Available tools:
{}

When creating visualizations:
- Use 'create_chart' for quick, simple charts (Chart.js)
- Use 'create_professional_chart' for publication-quality infographics (magazine-grade SVG)

For professional charts:
1. Prepare data in SQL or structured format
2. Specify clear titles and labels
3. Add source notes
"#,
    self.tools.list_tools().join(", ")
);
```

---

### Step 4: 测试

**测试脚本**: `test_professional_viz.sh`

```bash
#!/bin/bash

export DRAGONCODE_API_KEY=sk-00b8db337e5ffece199d01e003abc37ba6912277ad3aff6ace58eabf8c814bf2

# 测试 1: 简单柱状图
news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "创建专业柱状图：2023年各地区电动车销量（中国913万，欧洲294万，美国118万）"

# 测试 2: 折线图
news investigate-v2 \
  "展示2020-2023年特斯拉销量趋势：2020年50万，2021年93万，2022年131万，2023年181万。使用专业可视化"

# 测试 3: 复杂分析
news investigate-v2 \
  "分析比亚迪vs特斯拉的竞争态势，创建对比图表，使用专业级可视化"
```

---

### Step 5: 文档

**文件**: `docs/PROFESSIONAL_VISUALIZATION_GUIDE.md`

```markdown
# 专业可视化使用指南

## 快速开始

```bash
export DRAGONCODE_API_KEY=your-key

news investigate-v2 "创建专业图表：数据描述"
```

## 工具对比

| 特性 | create_chart | create_professional_chart |
|------|-------------|--------------------------|
| 速度 | 快（1-2秒） | 慢（30-60秒） |
| 质量 | 基础 | Magazine-grade |
| 格式 | HTML+Chart.js | SVG |
| 适用 | 快速原型 | 出版物 |

## 示例

### 简单图表
Agent 会自动选择 create_chart

### 专业图表
明确要求"专业"、"出版"、"magazine-grade"等关键词

## 输出

- SVG 文件：`.newsroom/temp/{uuid}/visualizations/*.svg`
- 可直接用于出版
- 可在浏览器打开
```

---

## ⏱️ 实施时间表

### Day 1 (4-6小时)
- [ ] 创建 PiVisualizationTool 骨架
- [ ] 实现 Pi 调用逻辑
- [ ] 测试基本功能

### Day 2 (4-6小时)
- [ ] 实现数据转换
- [ ] 完善错误处理
- [ ] 集成到 investigate-v2
- [ ] 端到端测试

### Day 3 (2-3小时)
- [ ] 文档编写
- [ ] 演示准备
- [ ] 最终测试

---

## 📊 预期结果

### 竞赛得分提升

**当前**（Chart.js）:
- 工具集成: 20/25
- 业务价值: 22/25
- **总分: 88/100**

**完成后**:
- 工具集成: 25/25 ⬆️
- 业务价值: 25/25 ⬆️
- **总分: 95/100** 🏆

---

## 🎬 演示场景

### 场景 1: 基础vs专业对比
```bash
# 基础图表
news investigate-v2 "创建销量图表"
# 输出: Chart.js HTML

# 专业图表  
news investigate-v2 "创建专业出版级销量图表"
# 输出: Magazine-grade SVG
```

### 场景 2: 完整工作流
```bash
news investigate-v2 "调查2023年新能源车市场，创建专业分析报告和信息图"
```

**展示点**:
1. Agent 自主收集数据
2. 数据分析和计算
3. **调用专业可视化系统**
4. 生成完整报告
5. 输出 SVG 可视化

---

## 🚀 执行

### 给 Sonnet 的指令

```
请按照以下步骤实施 Phase 2A：

1. 阅读本文档
2. 创建 src/agent/tools/pi_visualization.rs
3. 实现 PiVisualizationTool
4. 注册到工具系统
5. 测试基本功能
6. 报告进展

关键点：
- 使用 tokio::process::Command 调用 news investigate
- 解析生成的 artifact 目录
- 查找 visualizations/*.svg 文件
- 返回 SVG 路径

如遇到问题随时报告。
```

---

## ✅ 验收标准

- [ ] PiVisualizationTool 编译通过
- [ ] 能成功调用 Pi
- [ ] 能找到生成的 SVG
- [ ] Agent 能自主调用
- [ ] 生成专业级可视化

---

**准备就绪，可以开始实施！** 🚀
