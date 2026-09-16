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

// 具体工具实现
mod web_search;
mod calculate;
mod create_chart;
mod pi_visualization;

pub use web_search::WebSearchTool;
pub use calculate::CalculateTool;
pub use create_chart::CreateChartTool;
pub use pi_visualization::PiVisualizationTool;

/// 创建默认工具注册表
pub fn create_default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();

    // 注册基础工具
    registry.register(WebSearchTool);
    registry.register(CalculateTool);
    registry.register(CreateChartTool);

    // 如果有 DragonCode API key，注册专业可视化工具
    if std::env::var("DRAGONCODE_API_KEY").is_ok() || std::env::var("ANTHROPIC_API_KEY").is_ok() {
        registry.register(PiVisualizationTool::new(
            "dragoncode".to_string(),
            "claude-sonnet-4-6".to_string(),
        ));
    }

    registry
}

