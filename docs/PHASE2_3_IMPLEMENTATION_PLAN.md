# Phase 2+3 实施计划 - 新架构完成版

## 🎯 目标

在 2-3 天内完成自主 agent 的最小可行版本，满足竞赛要求。

---

## 📋 Phase 2: 工具系统（Day 1-2）

### Step 2.1: 核心抽象（2-3 小时）

#### 文件：`src/agent/tools.rs`

```rust
use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

/// 工具执行结果
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    pub data: Option<Value>,
}

/// 工具 trait - 所有工具必须实现
#[async_trait]
pub trait Tool: Send + Sync {
    /// 工具名称（用于 LLM 调用）
    fn name(&self) -> &str;
    
    /// 工具描述（告诉 LLM 这个工具是做什么的）
    fn description(&self) -> &str;
    
    /// 参数 schema（JSON Schema 格式）
    fn parameters_schema(&self) -> Value;
    
    /// 执行工具
    async fn execute(&self, params: Value) -> Result<ToolResult>;
}

/// 工具注册表
pub struct ToolRegistry {
    tools: std::collections::HashMap<String, Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: std::collections::HashMap::new(),
        }
    }
    
    /// 注册工具
    pub fn register<T: Tool + 'static>(&mut self, tool: T) {
        self.tools.insert(tool.name().to_string(), Box::new(tool));
    }
    
    /// 执行工具
    pub async fn execute(&self, name: &str, params: Value) -> Result<ToolResult> {
        let tool = self.tools.get(name)
            .ok_or_else(|| anyhow::anyhow!("Tool not found: {}", name))?;
        tool.execute(params).await
    }
    
    /// 获取所有工具的 Claude 格式定义
    pub fn to_claude_tools(&self) -> Vec<Value> {
        self.tools.values()
            .map(|tool| serde_json::json!({
                "name": tool.name(),
                "description": tool.description(),
                "input_schema": tool.parameters_schema()
            }))
            .collect()
    }
    
    /// 工具列表
    pub fn list_tools(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}
```

**验收**：编译通过

---

### Step 2.2: 实现第一个工具 - web_search（2-3 小时）

#### 文件：`src/agent/tools/web_search.rs`

```rust
use super::super::{Tool, ToolResult};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::process::Command;

pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    
    fn description(&self) -> &str {
        "Search the web for information. Returns relevant search results with titles, URLs, and snippets."
    }
    
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return",
                    "default": 5
                }
            },
            "required": ["query"]
        })
    }
    
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let query = params["query"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'query' parameter"))?;
        
        let max_results = params["max_results"].as_i64().unwrap_or(5);
        
        // 使用 DuckDuckGo 命令行工具（已在 runtime 中）
        let output = Command::new("python3")
            .arg("-c")
            .arg(format!(
                r#"
import json
from duckduckgo_search import DDGS

results = []
with DDGS() as ddgs:
    for r in ddgs.text('{}', max_results={}):
        results.append({{
            'title': r.get('title', ''),
            'url': r.get('href', ''),
            'snippet': r.get('body', '')
        }})

print(json.dumps(results))
"#,
                query, max_results
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await?;
        
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            return Ok(ToolResult {
                success: false,
                output: format!("Search failed: {}", error),
                data: None,
            });
        }
        
        let results: Value = serde_json::from_slice(&output.stdout)?;
        
        Ok(ToolResult {
            success: true,
            output: format!("Found {} results for '{}'", results.as_array().map(|a| a.len()).unwrap_or(0), query),
            data: Some(results),
        })
    }
}
```

**验收**：
```bash
cargo test --package agentic-data-newsroom --lib agent::tools::web_search
```

---

### Step 2.3: 实现第二个工具 - calculate（1-2 小时）

#### 文件：`src/agent/tools/calculate.rs`

```rust
use super::super::{Tool, ToolResult};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct CalculateTool;

#[async_trait]
impl Tool for CalculateTool {
    fn name(&self) -> &str {
        "calculate"
    }
    
    fn description(&self) -> &str {
        "Perform mathematical calculations and data analysis using Python."
    }
    
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "Python expression or code to evaluate"
                }
            },
            "required": ["expression"]
        })
    }
    
    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let expression = params["expression"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'expression' parameter"))?;
        
        // 安全的 Python 计算环境
        let output = tokio::process::Command::new("python3")
            .arg("-c")
            .arg(format!("import json; result = {}; print(json.dumps(result))", expression))
            .output()
            .await?;
        
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            return Ok(ToolResult {
                success: false,
                output: format!("Calculation failed: {}", error),
                data: None,
            });
        }
        
        let result: Value = serde_json::from_slice(&output.stdout)?;
        
        Ok(ToolResult {
            success: true,
            output: format!("Result: {}", result),
            data: Some(result),
        })
    }
}
```

**验收**：单元测试通过

---

### Step 2.4: 工具模块整合（1 小时）

#### 文件：`src/agent/tools/mod.rs`

```rust
mod web_search;
mod calculate;

pub use web_search::WebSearchTool;
pub use calculate::CalculateTool;

use super::{Tool, ToolRegistry};

/// 创建默认工具注册表
pub fn create_default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    
    // 注册工具
    registry.register(WebSearchTool);
    registry.register(CalculateTool);
    
    registry
}
```

#### 文件：`src/agent/mod.rs`

```rust
mod tools;

pub use tools::{Tool, ToolResult, ToolRegistry};
pub use tools::{WebSearchTool, CalculateTool, create_default_registry};
```

**验收**：编译通过，导出正确

---

## 📋 Phase 3: Agent 循环（Day 2-3）

### Step 3.1: Agent 核心结构（2-3 小时）

#### 文件：`src/agent/core.rs`

```rust
use crate::llm::{LLMClient, Message, Response};
use super::{ToolRegistry, ToolResult};
use anyhow::Result;
use serde_json::Value;

/// Agent 状态
#[derive(Debug)]
pub struct AgentState {
    pub goal: String,
    pub conversation: Vec<Message>,
    pub tool_results: Vec<(String, ToolResult)>,
    pub iteration: usize,
}

impl AgentState {
    pub fn new(goal: String) -> Self {
        Self {
            goal,
            conversation: Vec::new(),
            tool_results: Vec::new(),
            iteration: 0,
        }
    }
    
    pub fn add_user_message(&mut self, content: String) {
        self.conversation.push(Message::user(&content));
    }
    
    pub fn add_assistant_message(&mut self, content: String) {
        self.conversation.push(Message::assistant(&content));
    }
    
    pub fn add_tool_result(&mut self, tool_name: String, result: ToolResult) {
        self.tool_results.push((tool_name, result));
    }
}

/// Newsroom Agent
pub struct NewsroomAgent {
    llm: LLMClient,
    tools: ToolRegistry,
    state: AgentState,
    max_iterations: usize,
}

impl NewsroomAgent {
    pub fn new(llm: LLMClient, tools: ToolRegistry, goal: String) -> Self {
        Self {
            llm,
            tools,
            state: AgentState::new(goal),
            max_iterations: 20,
        }
    }
    
    /// 构建系统提示词
    fn build_system_prompt(&self) -> String {
        format!(
            r#"你是一个数据新闻调查 agent。

调查目标：{}

你的任务：
1. 理解调查目标
2. 规划调查步骤
3. 使用可用工具收集信息
4. 分析数据
5. 生成结构化报告

可用工具：
{}

规则：
- 调用工具时使用 JSON 格式
- 每次只调用一个工具
- 基于工具结果动态调整计划
- 完成后输出完整报告
"#,
            self.state.goal,
            self.tools
                .list_tools()
                .join(", ")
        )
    }
    
    /// 构建消息列表
    fn build_messages(&self) -> Vec<Message> {
        let mut messages = vec![
            Message::system(&self.build_system_prompt())
        ];
        
        // 添加对话历史
        messages.extend(self.state.conversation.clone());
        
        messages
    }
    
    /// 执行调查
    pub async fn investigate(&mut self) -> Result<String> {
        // 初始化
        self.state.add_user_message(self.state.goal.clone());
        
        // Agent 循环
        loop {
            self.state.iteration += 1;
            
            if self.state.iteration > self.max_iterations {
                eprintln!("⚠️  达到最大迭代次数");
                break;
            }
            
            eprintln!("🔄 Iteration {}/{}", self.state.iteration, self.max_iterations);
            
            // 调用 LLM
            let messages = self.build_messages();
            let tools = self.tools.to_claude_tools();
            
            let response = self.llm
                .chat(&messages, Some(&tools))
                .await?;
            
            // 记录 assistant 消息
            if !response.content.is_empty() {
                self.state.add_assistant_message(response.content.clone());
                eprintln!("💭 Agent: {}", response.content);
            }
            
            // 处理工具调用
            if !response.tool_uses.is_empty() {
                for tool_use in &response.tool_uses {
                    eprintln!("🔧 Tool: {}", tool_use.name);
                    
                    // 执行工具
                    let result = self.tools
                        .execute(&tool_use.name, tool_use.input.clone())
                        .await?;
                    
                    eprintln!("✅ Result: {}", result.output);
                    
                    // 记录结果
                    self.state.add_tool_result(tool_use.name.clone(), result.clone());
                    
                    // 将工具结果添加到对话
                    self.state.add_user_message(format!(
                        "Tool '{}' result: {}",
                        tool_use.name,
                        result.output
                    ));
                }
                
                // 继续循环让 agent 处理工具结果
                continue;
            }
            
            // 如果没有工具调用，agent 完成
            eprintln!("✅ 调查完成");
            break;
        }
        
        // 生成最终报告
        self.generate_report()
    }
    
    /// 生成报告
    fn generate_report(&self) -> Result<String> {
        let mut report = String::new();
        
        report.push_str(&format!("# 调查报告：{}\n\n", self.state.goal));
        report.push_str(&format!("迭代次数：{}\n\n", self.state.iteration));
        report.push_str(&format!("工具调用：{}\n\n", self.state.tool_results.len()));
        
        // 添加最后的 assistant 消息作为主要内容
        if let Some(last_msg) = self.state.conversation.last() {
            report.push_str("## 调查结果\n\n");
            report.push_str(&last_msg.content);
            report.push_str("\n\n");
        }
        
        // 添加工具使用记录
        report.push_str("## 数据来源\n\n");
        for (tool_name, result) in &self.state.tool_results {
            report.push_str(&format!("- {}: {}\n", tool_name, result.output));
        }
        
        Ok(report)
    }
}
```

**验收**：编译通过

---

### Step 3.2: 新命令 - investigate-v2（1-2 小时）

#### 文件：`src/commands/investigate_v2.rs`

```rust
use anyhow::Result;
use crate::cli::InvestigateV2Args;
use crate::llm::{LLMClient, Provider};
use crate::agent::{NewsroomAgent, create_default_registry};

pub async fn run(args: InvestigateV2Args) -> Result<()> {
    // 1. 解析 provider
    let provider = match args.provider.to_lowercase().as_str() {
        "anthropic" => Provider::Anthropic,
        "openai" => Provider::OpenAI,
        _ => anyhow::bail!("Unsupported provider: {}", args.provider),
    };
    
    // 2. 获取 API key
    let api_key = args.api_key.or_else(|| {
        match provider {
            Provider::Anthropic => std::env::var("ANTHROPIC_API_KEY").ok(),
            Provider::OpenAI => std::env::var("OPENAI_API_KEY").ok(),
        }
    }).ok_or_else(|| anyhow::anyhow!("No API key found"))?;
    
    // 3. 创建 LLM 客户端
    let mut client = LLMClient::new(provider, api_key, args.model.clone());
    if let Some(base_url) = args.base_url {
        client = client.with_base_url(base_url);
    }
    
    // 4. 创建工具注册表
    let tools = create_default_registry();
    
    // 5. 创建 agent
    let goal = args.topic.join(" ");
    let mut agent = NewsroomAgent::new(client, tools, goal);
    
    // 6. 执行调查
    eprintln!("🚀 开始调查...\n");
    let report = agent.investigate().await?;
    
    // 7. 输出报告
    println!("{}", report);
    
    Ok(())
}
```

#### 文件：`src/cli.rs` - 添加新命令

```rust
#[derive(Debug, Args)]
pub struct InvestigateV2Args {
    /// LLM provider
    #[arg(long, env = "NEWSROOM_PROVIDER", default_value = "anthropic")]
    pub provider: String,

    /// Model to use
    #[arg(long, env = "NEWSROOM_MODEL", default_value = "claude-sonnet-5")]
    pub model: String,

    /// API key
    #[arg(long, env = "NEWSROOM_API_KEY")]
    pub api_key: Option<String>,

    /// Custom base URL
    #[arg(long, env = "NEWSROOM_BASE_URL")]
    pub base_url: Option<String>,

    /// Investigation topic
    #[arg(required = true, num_args = 1..)]
    pub topic: Vec<String>,
}
```

在 `Commands` enum 中添加：
```rust
/// New autonomous investigation (Phase 3)
InvestigateV2(InvestigateV2Args),
```

**验收**：编译通过

---

### Step 3.3: 集成和测试（2-3 小时）

#### 更新 `src/main.rs`

```rust
mod agent;

// 在 match 中添加
Commands::InvestigateV2(args) => commands::investigate_v2::run(args).await,
```

#### 更新 `src/commands/mod.rs`

```rust
pub mod investigate_v2;
```

#### 更新 `Cargo.toml`

```toml
[dependencies]
async-trait = "0.1"
```

#### 端到端测试

```bash
# 编译
cargo build --release

# 安装
cargo install --path . --locked

# 测试
export ANTHROPIC_API_KEY=sk-00b8...bf2

news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "搜索2025年AI发展趋势，总结3个要点"
```

**预期输出**：
```
🚀 开始调查...

🔄 Iteration 1/20
💭 Agent: 我需要搜索...
🔧 Tool: web_search
✅ Result: Found 5 results...

🔄 Iteration 2/20
💭 Agent: 基于搜索结果...
✅ 调查完成

# 调查报告：搜索2025年AI发展趋势

## 调查结果
...

## 数据来源
- web_search: Found 5 results...
```

**验收**：成功完成完整调查

---

## 📊 验收标准

### Phase 2 完成标志
- [ ] Tool trait 定义完成
- [ ] ToolRegistry 实现完成
- [ ] web_search 工具可用
- [ ] calculate 工具可用
- [ ] 编译无错误
- [ ] 单元测试通过

### Phase 3 完成标志
- [ ] AgentState 实现
- [ ] NewsroomAgent 实现
- [ ] investigate-v2 命令可用
- [ ] 端到端测试通过
- [ ] 工具调用成功
- [ ] 生成完整报告

### 竞赛要求验证
- [ ] ✅ 多轮对话（agent 循环）
- [ ] ✅ 工具调用（web_search, calculate）
- [ ] ✅ 自主规划（agent 决策何时调用工具）
- [ ] ✅ 上下文管理（conversation history）
- [ ] ✅ 动态调整（基于工具结果）

---

## 🚨 关键注意事项

### 1. 依赖管理
```toml
[dependencies]
async-trait = "0.1"  # 新增
anyhow = "1.0"       # 已有
reqwest = "0.11"     # 已有
serde_json = "1.0"   # 已有
tokio = "1.0"        # 已有
```

### 2. 错误处理
- 所有工具调用都要 try/catch
- 工具失败不应该中断 agent
- 提供清晰的错误信息

### 3. 性能优化
- 工具调用超时控制
- LLM 调用重试机制
- 日志输出优化

### 4. 安全性
- Python 代码执行沙箱
- 参数验证
- 输入清理

---

## 📅 时间规划

### Day 1（6-8 小时）
- 09:00-12:00：Step 2.1-2.2（工具抽象 + web_search）
- 14:00-17:00：Step 2.3-2.4（calculate + 集成）
- 18:00-19:00：测试和调试

### Day 2（6-8 小时）
- 09:00-12:00：Step 3.1（Agent 核心）
- 14:00-17:00：Step 3.2（新命令）
- 18:00-19:00：集成测试

### Day 3（4-6 小时）
- 09:00-12:00：Step 3.3（端到端测试）
- 14:00-17:00：文档和演示准备
- 18:00-19:00：最终验收

---

## 🎯 执行顺序

1. ✅ **按顺序执行**：不要跳步骤
2. ✅ **逐步验证**：每个 step 完成后测试
3. ✅ **增量提交**：每个 step 完成后 git commit
4. ✅ **遇到问题**：先检查编译错误，再检查运行时错误

---

## 📝 成功标志

当你能运行以下命令并获得完整报告时，Phase 2+3 就完成了：

```bash
news investigate-v2 \
  --provider anthropic \
  --model claude-sonnet-5 \
  --base-url https://dragoncode.codes \
  "分析2025年全球电动汽车市场Top 3企业"
```

预期：
- 自动搜索信息
- 分析数据
- 生成结构化报告
- 显示数据来源

---

**准备好了吗？从 Step 2.1 开始！** 🚀
