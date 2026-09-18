# Agent 重新设计方案

## 🎯 目标

从"Pi 包装器"改造为"以 Pi 为底座的自有 agent"

---

## 当前架构（包装器模式）

```
用户请求
   ↓
news CLI
   ↓
启动 Pi 进程（pi --mode rpc）
   ↓
Pi 处理一切（规划、工具调用、LLM）
   ↓
返回结果
```

**问题**：完全依赖 Pi，无法定制核心逻辑

---

## 目标架构（自主 Agent）

```
用户请求
   ↓
news CLI
   ↓
Newsroom Agent（自己的逻辑）
   ├─ 规划模块（自己的）
   ├─ 执行循环（自己的）
   ├─ 工具系统（自己的）
   └─ LLM 调用
        └─ 可选：使用 Pi 库/直接调用 API
```

---

## 实现路线图

### Phase 1: 解耦 LLM 调用

**目标**：不依赖 Pi 进程，直接调用 LLM API

```rust
// src/llm.rs
pub struct LLMClient {
    provider: Provider,
    api_key: String,
    base_url: Option<String>,
}

impl LLMClient {
    pub async fn chat(&self, messages: &[Message]) -> Result<Response> {
        match self.provider {
            Provider::Anthropic => {
                // 直接调用 Anthropic API
                let client = anthropic_sdk::Client::new(&self.api_key);
                client.messages()
                    .create(messages)
                    .model("claude-sonnet-4")
                    .max_tokens(4096)
                    .send()
                    .await
            }
            Provider::OpenAI => {
                // 直接调用 OpenAI API
                // ...
            }
        }
    }
}
```

**依赖**：
```toml
[dependencies]
anthropic-sdk = "0.2"  # 或其他 SDK
reqwest = { version = "0.11", features = ["json"] }
```

---

### Phase 2: 自主工具系统

**目标**：自己管理工具注册和执行

```rust
// src/agent/tools.rs
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;
    async fn execute(&self, params: Value) -> Result<ToolResult>;
}

pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn register<T: Tool + 'static>(&mut self, tool: T) {
        self.tools.insert(tool.name().to_string(), Box::new(tool));
    }
    
    pub async fn execute(&self, name: &str, params: Value) -> Result<ToolResult> {
        let tool = self.tools.get(name)
            .ok_or_else(|| anyhow!("Tool not found: {}", name))?;
        tool.execute(params).await
    }
    
    pub fn to_claude_tools(&self) -> Vec<Value> {
        self.tools.values()
            .map(|tool| json!({
                "name": tool.name(),
                "description": tool.description(),
                "input_schema": tool.parameters_schema()
            }))
            .collect()
    }
}
```

---

### Phase 3: Agent 执行循环

**目标**：自己的规划和执行逻辑

```rust
// src/agent/core.rs
pub struct NewsroomAgent {
    llm: LLMClient,
    tools: ToolRegistry,
    state: InvestigationState,
}

impl NewsroomAgent {
    pub async fn investigate(&mut self, goal: &str) -> Result<InvestigationReport> {
        // 1. 初始化调查
        self.state.set_goal(goal);
        
        // 2. Agent 循环
        let max_iterations = 50;
        for iteration in 0..max_iterations {
            // 2.1 构建提示词
            let prompt = self.build_investigation_prompt();
            
            // 2.2 LLM 推理
            let response = self.llm.chat(&prompt, &self.tools.to_claude_tools()).await?;
            
            // 2.3 记录思考过程
            self.state.add_assistant_message(&response.content);
            
            // 2.4 处理工具调用
            if let Some(tool_use) = response.tool_uses.first() {
                eprintln!("[tool] -> {}", tool_use.name);
                
                // 执行工具
                let result = self.tools
                    .execute(&tool_use.name, tool_use.input.clone())
                    .await?;
                
                eprintln!("[tool] <- {} ok", tool_use.name);
                
                // 记录结果
                self.state.add_tool_result(&tool_use.id, result);
                
                // 继续下一轮
                continue;
            }
            
            // 2.5 Agent 决定停止
            if response.stop_reason == StopReason::EndTurn {
                break;
            }
        }
        
        // 3. 生成报告
        self.generate_report()
    }
    
    fn build_investigation_prompt(&self) -> Vec<Message> {
        let system_prompt = format!(
            "你是数据新闻调查 agent。\n\n调查目标：{}\n\n...",
            self.state.goal
        );
        
        let mut messages = vec![
            Message::system(&system_prompt),
        ];
        
        // 添加历史对话
        messages.extend(self.state.conversation.iter().cloned());
        
        messages
    }
}
```

---

### Phase 4: 保留 Pi 的优秀部分

**可以保留**：
- ✅ Pi 的工具定义格式（TypeScript）
- ✅ Pi 的可视化运行时
- ✅ Pi 的数据验证逻辑

**替换方式**：
```rust
// 加载 Pi 的工具定义，但自己执行
pub fn load_pi_tools(newsroom_extension: &Path) -> Result<ToolRegistry> {
    let mut registry = ToolRegistry::new();
    
    // 解析 Pi 的 TypeScript 工具定义
    let tools_ts = fs::read_to_string(newsroom_extension)?;
    
    // 提取工具元数据
    for tool_def in parse_pi_tools(&tools_ts)? {
        // 创建我们自己的工具实现
        registry.register(NewsroomTool::from_pi_def(tool_def));
    }
    
    Ok(registry)
}
```

---

## 实现优先级

### 🔴 Phase 1: LLM 解耦（关键）
- 添加 `src/llm.rs`
- 直接调用 Anthropic/OpenAI API
- 测试基本的对话功能

**时间估计**：1-2 天

---

### 🟡 Phase 2: 工具系统（核心）
- 添加 `src/agent/tools.rs`
- 实现工具注册和执行
- 迁移 3-5 个关键工具作为 POC

**时间估计**：3-5 天

---

### 🟢 Phase 3: Agent 循环（整合）
- 添加 `src/agent/core.rs`
- 实现完整的 agent 循环
- 替换 `run_prompt` 调用

**时间估计**：2-3 天

---

### 🔵 Phase 4: 优化和扩展（长期）
- 迁移所有工具
- 优化性能
- 添加更多定制功能

**时间估计**：持续迭代

---

## 示例代码结构

```
src/
├── agent/
│   ├── mod.rs
│   ├── core.rs          # NewsroomAgent
│   ├── tools.rs         # Tool trait, ToolRegistry
│   ├── state.rs         # InvestigationState
│   └── prompts.rs       # Prompt 构建
├── llm/
│   ├── mod.rs
│   ├── client.rs        # LLMClient
│   ├── anthropic.rs     # Anthropic 实现
│   └── openai.rs        # OpenAI 实现
├── tools/
│   ├── mod.rs
│   ├── search.rs        # 搜索工具
│   ├── fetch.rs         # 数据获取
│   ├── compute.rs       # 数据计算
│   └── visualize.rs     # 可视化
└── pi.rs                # 保留用于兼容模式
```

---

## 迁移策略

### 渐进式迁移（推荐）

1. **第 1 周**：实现 LLM 客户端，替换简单的 `ask` 命令
2. **第 2 周**：实现工具系统，迁移 2-3 个核心工具
3. **第 3 周**：实现 agent 循环，POC 完整调查
4. **第 4 周**：迁移剩余工具，优化性能

### 兼容模式

保留 `--use-pi-rpc` 标志：
```bash
# 新模式（自主 agent）
news investigate "主题"

# 旧模式（Pi 包装器）
news investigate --use-pi-rpc "主题"
```

---

## 收益

### 技术收益
- ✅ 完全控制 agent 逻辑
- ✅ 简化配置（无需 Pi /login）
- ✅ 更好的性能（无进程间通信）
- ✅ 更容易调试

### 产品收益
- ✅ 真正的"开箱即用"
- ✅ 可以添加自定义功能
- ✅ 不受 Pi 更新影响

---

## 风险和挑战

1. **工作量大** - 需要重新实现 agent 循环
2. **工具迁移** - 需要适配现有的 40+ 个工具
3. **兼容性** - 可能破坏现有工作流

**缓解**：
- 渐进式迁移
- 保留兼容模式
- 充分测试

---

## 决策点

### 现在需要决定：

1. **是否要改造？**
   - 如果只是使用 → 保持现状
   - 如果要深度定制 → 启动改造

2. **改造深度？**
   - 轻量级（保留 Pi RPC，改进包装层）
   - 深度（完全自主 agent）

3. **时间投入？**
   - 快速 POC：1-2 周
   - 完整迁移：1 个月
   - 持续优化：持续

---

**建议**: 先做 Phase 1 (LLM 解耦) 的 POC，验证可行性后再决定是否继续。
