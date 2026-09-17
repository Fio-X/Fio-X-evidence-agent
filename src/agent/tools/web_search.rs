use super::Tool;
use crate::agent::ToolResult;
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

        // 使用 DuckDuckGo 搜索（通过 Python）
        let output = Command::new("python3")
            .arg("-c")
            .arg(format!(
                r#"
import json
try:
    from duckduckgo_search import DDGS

    results = []
    with DDGS() as ddgs:
        for r in ddgs.text('{}', max_results={}):
            results.append({{
                'title': r.get('title', ''),
                'url': r.get('href', ''),
                'snippet': r.get('body', '')
            }})

    print(json.dumps(results, ensure_ascii=False))
except Exception as e:
    print(json.dumps({{'error': str(e)}}))
"#,
                query.replace('\'', "\\'"),
                max_results
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

        let result_text = String::from_utf8_lossy(&output.stdout);
        let results: Value = serde_json::from_str(&result_text)?;

        // 检查是否有错误
        if let Some(error) = results.get("error") {
            return Ok(ToolResult {
                success: false,
                output: format!("Search error: {}", error),
                data: None,
            });
        }

        let count = results.as_array().map(|a| a.len()).unwrap_or(0);

        Ok(ToolResult {
            success: true,
            output: format!("Found {} results for '{}'", count, query),
            data: Some(results),
        })
    }
}
