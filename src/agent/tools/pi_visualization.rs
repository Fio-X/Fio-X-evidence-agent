use super::Tool;
use crate::agent::ToolResult;
use crate::output;
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

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
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
        let headers: Vec<String> = first
            .as_object()
            .map(|obj| obj.keys().cloned().collect())
            .ok_or_else(|| anyhow::anyhow!("Data must be array of objects"))?;

        // Build CSV
        let mut csv = headers
            .iter()
            .map(|header| csv_cell(header))
            .collect::<Vec<_>>()
            .join(",");
        csv.push('\n');
        for row in data {
            let obj = row
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Data rows must be objects"))?;
            let values: Vec<String> = headers
                .iter()
                .map(|header| {
                    obj.get(header)
                        .map(|value| {
                            value
                                .as_str()
                                .map(csv_cell)
                                .unwrap_or_else(|| csv_cell(&value.to_string()))
                        })
                        .unwrap_or_default()
                })
                .collect();
            csv.push_str(&values.join(","));
            csv.push('\n');
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
            return Err(anyhow::anyhow!(
                "No SVG files found in visualizations directory"
            ));
        }

        // Return the first SVG (or could sort by modification time)
        Ok(svg_files[0].clone())
    }

    /// Build investigation prompt for Pi
    fn build_investigation_prompt(&self, params: &Value) -> String {
        let title = params["title"].as_str().unwrap_or("Untitled");
        let chart_type = params["chart_type"].as_str().unwrap_or("bar");
        let subtitle = params
            .get("subtitle")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let source_note = params
            .get("source_note")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        format!(
            "创建专业的{}图表。标题：{}。{}{}使用提供的数据文件生成高质量的SVG可视化。",
            chart_type,
            title,
            if subtitle.is_empty() {
                String::new()
            } else {
                format!("副标题：{}。", subtitle)
            },
            if source_note.is_empty() {
                String::new()
            } else {
                format!("数据来源：{}。", source_note)
            }
        )
    }
}

#[async_trait]
impl Tool for PiVisualizationTool {
    fn name(&self) -> &str {
        "create_professional_chart"
    }

    fn description(&self) -> &str {
        "Create an evidence-backed newsroom visualization using the professional \
         Pi pipeline. Use the chart family that answers the reader question: \
         statistical charts, Sankey/alluvial flows, network/adjacency views, \
         timelines, or geographic flow maps. Flow rows need source/target/value \
         and one unit; maps need sourced coordinates, projection, and basemap \
         provenance. Returns an SVG artifact after the runtime validation gates."
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
                    "enum": [
                        "bar", "horizontal_bar", "dot", "dumbbell", "slope", "line", "multi_line",
                        "small_multiples", "scatter", "diverging_bar", "heatmap", "sankey", "alluvial",
                        "node_link", "adjacency_matrix", "hierarchy_tree", "timeline", "streamgraph",
                        "parallel_sets", "chord", "geo_flow_map", "cartographic_flow_map",
                        "trajectory_profile", "process_schematic"
                    ],
                    "description": "Choose by analytical job; use Sankey/alluvial only for additive flows, network forms for relationships, and geo/cartographic flow only for sourced geography"
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
        let temp_root = output::runtime_output_dir()?.join("temp");
        let temp_dir = temp_root.join(format!("viz-{}", temp_id));
        fs::create_dir_all(&temp_dir)
            .await
            .context("Failed to create temp directory")?;

        // Write data as CSV
        let data_file = temp_dir.join("data.csv");
        let data_file_string = data_file.to_string_lossy().to_string();
        self.write_data_csv(data, &data_file_string)
            .await
            .context("Failed to write data CSV")?;

        // Build investigation prompt
        let prompt = self.build_investigation_prompt(&params);

        // Check for API key
        let api_key = std::env::var("DRAGONCODE_API_KEY")
            .or_else(|_| std::env::var("ANTHROPIC_API_KEY"))
            .or_else(|_| std::env::var("OPENAI_API_KEY"))
            .context(
                "No API key found. Set DRAGONCODE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY",
            )?;

        // Call Pi investigate
        let output = Command::new("news")
            .args([
                "investigate",
                "--provider",
                &self.provider,
                "--model",
                &self.model,
                "--tool-profile",
                "visual",
                "--out",
                temp_dir.to_string_lossy().as_ref(),
                "--data",
                &data_file_string,
                &prompt,
            ])
            .env("DRAGONCODE_API_KEY", &api_key)
            .output()
            .await
            .context("Failed to execute 'news investigate' command")?;

        if !output.status.success() {
            let status = output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Ok(ToolResult {
                success: false,
                // Provider and subprocess stderr can contain credentials or
                // prompt fragments. Keep only bounded, non-sensitive
                // diagnostics in the tool result.
                output: format!(
                    "Pi investigation failed (exit status {}; stderr suppressed, {} bytes)",
                    status,
                    output.stderr.len()
                ),
                data: None,
            });
        }

        // Find the generated artifact directory
        let mut artifacts = fs::read_dir(&temp_dir).await?;
        let mut artifact_dir = None;

        while let Some(entry) = artifacts.next_entry().await? {
            let path = entry.path();
            if path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.contains("Z-"))
            {
                artifact_dir = Some(path);
                break;
            }
        }

        let artifact_path =
            artifact_dir.ok_or_else(|| anyhow::anyhow!("No artifact directory found"))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_cells_escape_quotes_for_complex_labels() {
        assert_eq!(csv_cell("port, \"A\""), "\"port, \"\"A\"\"\"");
    }

    #[test]
    fn professional_schema_exposes_topology_aware_families() {
        let schema = PiVisualizationTool::new("dragoncode".into(), "claude-sonnet-4-6".into())
            .parameters_schema();
        let chart_types = schema["properties"]["chart_type"]["enum"]
            .as_array()
            .expect("chart type enum");
        for expected in [
            "sankey",
            "alluvial",
            "node_link",
            "timeline",
            "cartographic_flow_map",
        ] {
            assert!(
                chart_types
                    .iter()
                    .any(|value| value.as_str() == Some(expected)),
                "missing {expected}"
            );
        }
    }
}
