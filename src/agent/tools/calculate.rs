use super::Tool;
use crate::agent::ToolResult;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::process::Command;

pub struct CalculateTool;

#[async_trait]
impl Tool for CalculateTool {
    fn name(&self) -> &str {
        "calculate"
    }

    fn description(&self) -> &str {
        "Perform mathematical calculations and data analysis using Python. Can evaluate expressions, do statistics, etc."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "Python expression or code to evaluate (e.g., '2+2', 'sum([1,2,3])', 'import statistics; statistics.mean([1,2,3])')"
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
        let output = Command::new("python3")
            .arg("-c")
            .arg(format!(
                r#"
import json
try:
    result = eval({})
    print(json.dumps({{'result': result}}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({{'error': str(e)}}))
"#,
                serde_json::to_string(expression)?
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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

        let result_text = String::from_utf8_lossy(&output.stdout);
        let result: Value = serde_json::from_str(&result_text)?;

        if let Some(error) = result.get("error") {
            return Ok(ToolResult {
                success: false,
                output: format!("Calculation error: {}", error),
                data: None,
            });
        }

        let calc_result = result.get("result").cloned().unwrap_or(Value::Null);

        Ok(ToolResult {
            success: true,
            output: format!("Result: {}", calc_result),
            data: Some(calc_result),
        })
    }
}
