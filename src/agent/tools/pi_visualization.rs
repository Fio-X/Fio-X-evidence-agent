use super::Tool;
use crate::agent::ToolResult;
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::fs;
use tokio::process::Command;
use uuid::Uuid;

/// Professional visualization tool using Pi newsroom system
pub struct PiVisualizationTool {
    provider: String,
    model: String,
}

impl PiVisualizationTool {
    pub fn new(provider: String, model: String) -> Self {
        Self { provider, model }
    }

    /// Convert inline data to CSV format
    async fn write_data_csv(&self, data: &[Value], output_path: &str) -> Result<()> {
        if data.is_empty() {
            return Err(anyhow::anyhow!("No data provided"));
        }

        // Extract headers from first object
        let first = &data[0];
        let headers: Vec<String> = if let Some(obj) = first.as_object() {
            obj.keys().cloned().collect()
        } else {
            return Err(anyhow::anyhow!("Data must be array of objects"));
        };

        // Build CSV
        let mut csv = headers.join(",") + "\n";
        for row in data {
            if let Some(obj) = row.as_object() {
                let values: Vec<String> = headers
                    .iter()
                    .map(|h| {
                        obj.get(h)
                            .and_then(|v| {
                                if v.is_string() {
                                    v.as_str().map(|s| format!("\"{}\"", s))
                                } else {
                                    Some(v.to_string())
                                }
                            })
                            .unwrap_or_default()
                    })
                    .collect();
                csv.push_str(&values.join(","));
                csv.push('\n');
            }
        }

        fs::write(output_path, csv).await?;
        Ok(())
    }

    /// Find the latest SVG file in visualizations directory
    async fn find_latest_svg(&self, artifact_dir: &str) -> Result<PathBuf> {
        let viz_dir = PathBuf::from(artifact_dir).join("visualizations");

        if !viz_dir.exists() {
            return Err(anyhow::anyhow!(
                "Visualizations directory not found: {}",
                viz_dir.display()
            ));
        }

        let mut entries = fs::read_dir(&viz_dir).await?;
        let mut svg_files = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("svg") {
                svg_files.push(path);
            }
        }

        if svg_files.is_empty() {
            return Err(anyhow::anyhow!("No SVG files found in visualizations directory"));
        }

        // Return the first SVG (or could sort by modification time)
        Ok(svg_files[0].clone())
    }

    /// Build investigation prompt for Pi
    fn build_investigation_prompt(&self, params: &Value) -> String {
        let title = params["title"].as_str().unwrap_or("Untitled");
        let chart_type = params["chart_type"].as_str().unwrap_or("bar");
        let subtitle = params.get("subtitle").and_then(|v| v.as_str()).unwrap_or("");
        let source_note = params.get("source_note").and_then(|v| v.as_str()).unwrap_or("");

        format!(
            "创建专业的{}图表。标题：{}。{}{}使用提供的数据文件生成高质量的SVG可视化。",
            chart_type,
            title,
            if subtitle.is_empty() { String::new() } else { format!("副标题：{}。", subtitle) },
            if source_note.is_empty() { String::new() } else { format!("数据来源：{}。", source_note) }
        )
    }
}

#[async_trait]
impl Tool for PiVisualizationTool {
    fn name(&self) -> &str {
        "create_professional_chart"
    }

    fn description(&self) -> &str {
        "Create magazine-grade data visualization using professional newsroom system. \
         Supports bar charts, line charts, and complex infographics. \
         Returns publication-ready SVG files. Use this when high-quality, \
         professional visualization is required for publication or presentation."
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
                    "description": "Type of chart to create"
                },
                "data": {
                    "type": "array",
                    "description": "Array of data objects, e.g. [{\"label\": \"A\", \"value\": 100}, ...]",
                    "items": {
                        "type": "object"
                    }
                },
                "subtitle": {
                    "type": "string",
                    "description": "Optional subtitle or time period"
                },
                "source_note": {
                    "type": "string",
                    "description": "Optional data source citation"
                }
            },
            "required": ["title", "chart_type", "data"]
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        // Validate required parameters
        let title = params["title"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'title'"))?;

        let chart_type = params["chart_type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'chart_type'"))?;

        let data = params["data"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'data'"))?;

        // Create temporary directory for this visualization
        let temp_id = Uuid::new_v4();
        let temp_dir = format!(".newsroom/temp/viz-{}", temp_id);
        fs::create_dir_all(&temp_dir)
            .await
            .context("Failed to create temp directory")?;

        // Write data as CSV
        let data_file = format!("{}/data.csv", temp_dir);
        self.write_data_csv(data, &data_file)
            .await
            .context("Failed to write data CSV")?;

        // Build investigation prompt
        let prompt = self.build_investigation_prompt(&params);

        // Check for API key
        let api_key = std::env::var("DRAGONCODE_API_KEY")
            .or_else(|_| std::env::var("ANTHROPIC_API_KEY"))
            .context("No API key found. Set DRAGONCODE_API_KEY or ANTHROPIC_API_KEY")?;

        // Call Pi investigate
        let output = Command::new("news")
            .args(&[
                "investigate",
                "--provider",
                &self.provider,
                "--model",
                &self.model,
                "--tool-profile",
                "visual",
                "--out",
                &temp_dir,
                "--data",
                &data_file,
                &prompt,
            ])
            .env("DRAGONCODE_API_KEY", &api_key)
            .output()
            .await
            .context("Failed to execute 'news investigate' command")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Ok(ToolResult {
                success: false,
                output: format!("Pi investigation failed: {}", stderr),
                data: None,
            });
        }

        // Find the generated artifact directory
        let mut artifacts = fs::read_dir(&temp_dir).await?;
        let mut artifact_dir = None;

        while let Some(entry) = artifacts.next_entry().await? {
            let path = entry.path();
            if path.is_dir() && path.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.contains("Z-")) {
                artifact_dir = Some(path);
                break;
            }
        }

        let artifact_path = artifact_dir
            .ok_or_else(|| anyhow::anyhow!("No artifact directory found"))?;

        // Find SVG file
        let svg_path = self
            .find_latest_svg(artifact_path.to_str().unwrap())
            .await
            .context("Failed to find generated SVG")?;

        Ok(ToolResult {
            success: true,
            output: format!(
                "Created professional {} chart '{}' saved to {}",
                chart_type,
                title,
                svg_path.display()
            ),
            data: Some(json!({
                "svg_path": svg_path.to_str().unwrap(),
                "artifact_dir": artifact_path.to_str().unwrap(),
                "chart_type": chart_type,
                "title": title
            })),
        })
    }
}
