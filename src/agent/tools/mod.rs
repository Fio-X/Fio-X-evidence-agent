use anyhow::{bail, Result};
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
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("Tool not found: {}", name))?;
        validate_tool_parameters(name, &params, &tool.parameters_schema())?;
        tool.execute(params).await
    }

    /// 获取所有工具的 Claude 格式定义
    pub fn to_claude_tools(&self) -> Vec<Value> {
        let mut tools: Vec<Value> = self
            .tools
            .values()
            .map(|tool| {
                serde_json::json!({
                    "name": tool.name(),
                    "description": tool.description(),
                    "input_schema": tool.parameters_schema()
                })
            })
            .collect();
        tools.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
        tools
    }

    /// Return OpenAI Chat Completions function tools. The public tool schema
    /// is shared with Anthropic, but the envelope is provider-specific.
    pub fn to_openai_tools(&self) -> Vec<Value> {
        let mut tools: Vec<Value> = self
            .tools
            .values()
            .map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name(),
                        "description": tool.description(),
                        "parameters": tool.parameters_schema()
                    }
                })
            })
            .collect();
        tools.sort_by(|left, right| {
            left["function"]["name"]
                .as_str()
                .cmp(&right["function"]["name"].as_str())
        });
        tools
    }

    /// 工具列表
    pub fn list_tools(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        names.sort();
        names
    }
}

/// Validate the small JSON Schema subset used by the direct Rust tools before
/// dispatch. This keeps malformed model calls actionable and prevents a JSON
/// string from reaching a tool that expects an object/array.
fn validate_tool_parameters(name: &str, value: &Value, schema: &Value) -> Result<()> {
    fn check(value: &Value, schema: &Value, path: &str) -> Result<()> {
        if let Some(options) = schema
            .get("anyOf")
            .and_then(Value::as_array)
            .or_else(|| schema.get("oneOf").and_then(Value::as_array))
        {
            if options
                .iter()
                .any(|candidate| check(value, candidate, path).is_ok())
            {
                return Ok(());
            }
            bail!("{path}: value does not match any allowed schema");
        }
        if let Some(enum_values) = schema.get("enum").and_then(Value::as_array) {
            if !enum_values.iter().any(|candidate| candidate == value) {
                bail!("{path}: value is not one of the allowed enum values");
            }
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("object") => {
                let object = value.as_object().ok_or_else(|| {
                    anyhow::anyhow!(
                        "{path}: expected JSON object, received {}",
                        json_type(value)
                    )
                })?;
                for required in schema
                    .get("required")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let field = required.as_str().unwrap_or_default();
                    if !object.contains_key(field) {
                        bail!("{path}.{field}: required property is missing");
                    }
                }
                if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                    for (field, field_schema) in properties {
                        if let Some(field_value) = object.get(field) {
                            check(field_value, field_schema, &format!("{path}.{field}"))?;
                        }
                    }
                }
            }
            Some("array") => {
                let array = value.as_array().ok_or_else(|| {
                    anyhow::anyhow!("{path}: expected JSON array, received {}", json_type(value))
                })?;
                if let Some(items) = schema.get("items") {
                    for (index, item) in array.iter().enumerate() {
                        check(item, items, &format!("{path}[{index}]"))?;
                    }
                }
            }
            Some("string") if !value.is_string() => {
                bail!("{path}: expected string, received {}", json_type(value))
            }
            Some("boolean") if !value.is_boolean() => {
                bail!("{path}: expected boolean, received {}", json_type(value))
            }
            Some("number") if !value.is_number() => {
                bail!("{path}: expected number, received {}", json_type(value))
            }
            Some("integer") if value.as_i64().is_none() && value.as_u64().is_none() => {
                bail!("{path}: expected integer, received {}", json_type(value))
            }
            _ => {}
        }
        Ok(())
    }

    fn json_type(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    if !value.is_object() {
        bail!(
            "{name}: tool parameters must be a JSON object, received {}",
            json_type(value)
        );
    }
    check(value, schema, name)
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// 具体工具实现
mod calculate;
mod create_chart;
mod modern_chart;
mod pi_visualization;
mod web_search;

pub use calculate::CalculateTool;
pub use create_chart::CreateChartTool;
pub use modern_chart::ModernChartTool;
pub use pi_visualization::PiVisualizationTool;
pub use web_search::WebSearchTool;

/// 创建默认工具注册表
pub fn create_default_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();

    // 注册基础工具
    registry.register(WebSearchTool);
    registry.register(CalculateTool);

    // 注册遵守 editorial-chart skill 的交互式图表工具
    registry.register(ModernChartTool);

    // 注册传统静态图表工具（快速）
    registry.register(CreateChartTool);

    // Register the Pi publication tool for an explicit DragonCode/Anthropic
    // route. OPENAI_API_KEY is accepted only when its configured base URL is
    // DragonCode, so a normal OpenAI setup is not silently rerouted.
    let dragoncode_base_url = std::env::var("DRAGONCODE_BASE_URL")
        .ok()
        .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
        .unwrap_or_default();
    let dragoncode_endpoint = dragoncode_base_url
        .to_ascii_lowercase()
        .contains("dragoncode.codes");
    if std::env::var("DRAGONCODE_API_KEY").is_ok()
        || std::env::var("ANTHROPIC_API_KEY").is_ok()
        || (std::env::var("OPENAI_API_KEY").is_ok() && dragoncode_endpoint)
    {
        registry.register(PiVisualizationTool::new(
            "dragoncode".to_string(),
            "claude-sonnet-4-6".to_string(),
        ));
    }

    registry
}

/// Build the single-chart registry from the already-resolved CLI provider
/// configuration. This path must not decide whether a professional tool is
/// available by inspecting only ambient environment variables.
pub fn create_default_registry_with_visual_config(
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    registry.register(WebSearchTool);
    registry.register(CalculateTool);
    registry.register(ModernChartTool);
    registry.register(CreateChartTool);
    registry.register(PiVisualizationTool::with_config(
        provider, model, api_key, base_url,
    ));
    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_tools_use_function_envelope() {
        let mut registry = ToolRegistry::new();
        registry.register(CalculateTool);
        let tools = registry.to_openai_tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "calculate");
        assert!(tools[0]["function"]["parameters"].is_object());
        assert!(tools[0].get("input_schema").is_none());
    }

    #[tokio::test]
    async fn rejects_string_parameters_before_tool_execution() {
        let mut registry = ToolRegistry::new();
        registry.register(ModernChartTool);
        let error = registry
            .execute("create_modern_chart", serde_json::json!("{\"data\":[]}"))
            .await
            .expect_err("a string must not reach the chart tool");
        assert!(error
            .to_string()
            .contains("tool parameters must be a JSON object"));
    }

    #[tokio::test]
    async fn rejects_array_field_encoded_as_string() {
        let mut registry = ToolRegistry::new();
        registry.register(ModernChartTool);
        let error = registry
            .execute(
                "create_modern_chart",
                serde_json::json!({
                    "title": "A",
                    "chart_type": "bar",
                    "data": "[{\"label\":\"A\",\"value\":1}]"
                }),
            )
            .await
            .expect_err("data string must be rejected by the schema boundary");
        assert!(error
            .to_string()
            .contains("data: expected JSON array, received string"));
    }
}
