use super::Tool;
use crate::agent::ToolResult;
use crate::output;
use anyhow::{bail, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::fs;
use uuid::Uuid;

/// Professional visualization tool using Pi newsroom system
pub struct PiVisualizationTool {
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
}

#[cfg(test)]
fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

impl PiVisualizationTool {
    pub fn new(provider: String, model: String) -> Self {
        Self::with_config(provider, model, None, None)
    }

    pub fn with_config(
        provider: String,
        model: String,
        api_key: Option<String>,
        base_url: Option<String>,
    ) -> Self {
        Self {
            provider,
            model,
            api_key,
            base_url,
        }
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn extract_rows(data: &[Value]) -> Result<Vec<(String, f64)>> {
    if data.is_empty() {
        bail!("No data provided");
    }
    data.iter()
        .enumerate()
        .map(|(index, row)| {
            let label = row
                .get("label")
                .or_else(|| row.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow::anyhow!("data[{index}].label must be a non-empty string"))?;
            let value = row
                .get("value")
                .or_else(|| row.get("y"))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| anyhow::anyhow!("data[{index}].value must be finite"))?;
            Ok((label.to_string(), value))
        })
        .collect()
}

const LOCAL_RENDERED_CHART_TYPES: &[&str] = &[
    "bar",
    "horizontal_bar",
    "dot",
    "dumbbell",
    "slope",
    "line",
    "multi_line",
    "scatter",
    "diverging_bar",
    "heatmap",
];

fn render_svg(chart_type: &str, title: &str, rows: &[(String, f64)], source: &str) -> String {
    const WIDTH: f64 = 960.0;
    const HEIGHT: f64 = 520.0;
    const LEFT: f64 = 112.0;
    const RIGHT: f64 = 44.0;
    const TOP: f64 = 86.0;
    const BOTTOM: f64 = 76.0;
    let plot_width = WIDTH - LEFT - RIGHT;
    let plot_height = HEIGHT - TOP - BOTTOM;
    let min = rows.iter().map(|(_, value)| *value).fold(0.0, f64::min);
    let max = rows.iter().map(|(_, value)| *value).fold(0.0, f64::max);
    let span = (max - min).max(1.0);
    let y = |value: f64| TOP + (max - value) / span * plot_height;
    let baseline = y(0.0);
    let step = plot_width / rows.len().max(1) as f64;
    let mut body = String::new();
    body.push_str(&format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH:.0} {HEIGHT:.0}" role="img" aria-labelledby="title desc"><title id="title">{title}</title><desc id="desc">{chart_type}; source: {source}</desc><rect width="100%" height="100%" fill="#f7f2eb"/><text x="{LEFT}" y="42" fill="#081f5c" font-family="Georgia,serif" font-size="28" font-weight="700">{title}</text><text x="{LEFT}" y="64" fill="#5f5d57" font-family="Arial,sans-serif" font-size="12">{chart_type} · evidence-bound local renderer</text>"##,
        WIDTH = WIDTH,
        HEIGHT = HEIGHT,
        LEFT = LEFT,
        title = escape_html(title),
        chart_type = escape_html(chart_type),
        source = escape_html(source),
    ));
    for tick in 0..=4 {
        let value = min + span * tick as f64 / 4.0;
        let line_y = y(value);
        body.push_str(&format!(
            r##"<line x1="{LEFT:.2}" x2="{right:.2}" y1="{line_y:.2}" y2="{line_y:.2}" stroke="#c9c7c0"/><text x="{label_x:.2}" y="{label_y:.2}" text-anchor="end" fill="#5f5d57" font-family="Arial,sans-serif" font-size="12">{value}</text>"##,
            LEFT = LEFT,
            right = WIDTH - RIGHT,
            line_y = line_y,
            label_x = LEFT - 10.0,
            label_y = line_y + 4.0,
            value = format_number(value),
        ));
    }
    body.push_str(&format!(
        r##"<line x1="{LEFT:.2}" x2="{right:.2}" y1="{baseline:.2}" y2="{baseline:.2}" stroke="#081f5c" stroke-width="1.5"/>"##,
        LEFT = LEFT,
        right = WIDTH - RIGHT,
        baseline = baseline,
    ));

    if chart_type == "line" || chart_type == "multi_line" {
        let points = rows
            .iter()
            .enumerate()
            .map(|(index, (_, value))| {
                format!("{:.2},{:.2}", LEFT + step * (index as f64 + 0.5), y(*value))
            })
            .collect::<Vec<_>>()
            .join(" ");
        body.push_str(&format!(
            r##"<polyline points="{points}" fill="none" stroke="#334eac" stroke-width="4" stroke-linejoin="round"/>"##,
            points = points,
        ));
        for (index, (label, value)) in rows.iter().enumerate() {
            let x = LEFT + step * (index as f64 + 0.5);
            let yy = y(*value);
            body.push_str(&format!(
                r##"<circle cx="{x:.2}" cy="{yy:.2}" r="6" fill="#081f5c"/><text x="{x:.2}" y="{value_y:.2}" text-anchor="middle" fill="#081f5c" font-family="Arial,sans-serif" font-size="12" font-weight="700">{value}</text><text x="{x:.2}" y="{label_y:.2}" text-anchor="middle" fill="#5f5d57" font-family="Arial,sans-serif" font-size="11">{label}</text>"##,
                x = x,
                yy = yy,
                value_y = (yy - 12.0).max(TOP + 14.0),
                value = format_number(*value),
                label_y = HEIGHT - 32.0,
                label = escape_html(label),
            ));
        }
    } else if chart_type == "bar" {
        for (index, (label, value)) in rows.iter().enumerate() {
            let x = LEFT + step * (index as f64 + 0.5);
            let yy = y(*value);
            let height = (baseline - yy).abs();
            body.push_str(&format!(
                r##"<rect x="{bar_x:.2}" y="{bar_y:.2}" width="{bar_width:.2}" height="{height:.2}" fill="#334eac"/><text x="{x:.2}" y="{value_y:.2}" text-anchor="middle" fill="#081f5c" font-family="Arial,sans-serif" font-size="12" font-weight="700">{value}</text><text x="{x:.2}" y="{label_y:.2}" text-anchor="middle" fill="#5f5d57" font-family="Arial,sans-serif" font-size="11">{label}</text>"##,
                bar_x = x - step * 0.32,
                bar_y = yy.min(baseline),
                bar_width = step * 0.64,
                height = height.max(1.0),
                x = x,
                value_y = (yy - 12.0).max(TOP + 14.0),
                value = format_number(*value),
                label_y = HEIGHT - 32.0,
                label = escape_html(label),
            ));
        }
    } else {
        // A lollipop/dot grammar keeps this compatibility path from silently
        // converting every requested professional form into a bar chart.
        for (index, (label, value)) in rows.iter().enumerate() {
            let x = LEFT + step * (index as f64 + 0.5);
            let yy = y(*value);
            body.push_str(&format!(
                r##"<line x1="{LEFT:.2}" x2="{x:.2}" y1="{yy:.2}" y2="{yy:.2}" stroke="#7096d1" stroke-width="3"/><circle cx="{x:.2}" cy="{yy:.2}" r="8" fill="#334eac"/><text x="{x:.2}" y="{value_y:.2}" text-anchor="middle" fill="#081f5c" font-family="Arial,sans-serif" font-size="12" font-weight="700">{value}</text><text x="{x:.2}" y="{label_y:.2}" text-anchor="middle" fill="#5f5d57" font-family="Arial,sans-serif" font-size="11">{label}</text>"##,
                LEFT = LEFT,
                x = x,
                yy = yy,
                value_y = (yy - 12.0).max(TOP + 14.0),
                value = format_number(*value),
                label_y = HEIGHT - 32.0,
                label = escape_html(label),
            ));
        }
    }
    body.push_str("</svg>");
    body
}

#[async_trait]
impl Tool for PiVisualizationTool {
    fn name(&self) -> &str {
        "create_professional_chart"
    }

    fn description(&self) -> &str {
        "Create a deterministic local SVG prototype in the current run root without starting a nested agent. This compatibility renderer is explicitly DRAFT/non-publishable; use the newsroom visualization or visual-story pipeline for verified publication artifacts."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "chart_type": {
                    "type": "string",
                    "enum": [
                        "bar", "horizontal_bar", "dot", "dumbbell", "slope", "line", "multi_line",
                        "small_multiples", "scatter", "diverging_bar", "heatmap", "sankey", "alluvial",
                        "node_link", "adjacency_matrix", "hierarchy_tree", "timeline", "streamgraph",
                        "parallel_sets", "chord", "geo_flow_map", "cartographic_flow_map",
                        "trajectory_profile", "process_schematic"
                    ]
                },
                "data": {"type": "array", "items": {"type": "object"}},
                "source_note": {"type": "string"}
            },
            "required": ["title", "chart_type", "data"]
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let title = params["title"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Missing non-empty 'title'"))?;
        let chart_type = params["chart_type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'chart_type'"))?;
        let data = params["data"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'data'"))?;

        if !LOCAL_RENDERED_CHART_TYPES.contains(&chart_type) {
            return Ok(ToolResult {
                success: false,
                output: format!(
                    "Chart type '{chart_type}' is not covered by the local professional renderer; use the visual-story Lieflat/publication pipeline instead of an approximate geometry."
                ),
                data: Some(json!({
                    "blocked": true,
                    "chart_type": chart_type,
                    "reason": "unsupported_local_geometry",
                    "requires": "visual-story"
                })),
            });
        }

        let rows = extract_rows(data)?;
        let source = params["source_note"].as_str().unwrap_or("not provided");
        // This renderer is local and therefore does not make a second provider
        // request. Keep the resolved CLI configuration on the tool boundary so
        // a future provider-backed adapter cannot fall back to ambient env
        // values; never include the key in an artifact or tool result.
        let _configured_runtime = (&self.provider, &self.model, &self.api_key, &self.base_url);
        let output_dir = output::runtime_output_dir()?.join("visualizations");
        fs::create_dir_all(&output_dir).await?;
        let svg_path = output_dir.join(format!("professional-{}.svg", Uuid::new_v4()));
        fs::write(&svg_path, render_svg(chart_type, title, &rows, source)).await?;
        let path_text = svg_path.to_string_lossy().to_string();

        Ok(ToolResult {
            success: true,
            output: format!(
                "Created DRAFT professional {chart_type} chart '{title}' saved to {path_text}; use newsroom_viz_plan in verified mode for publication"
            ),
            data: Some(json!({
                "svg_path": path_text,
                "file_path": svg_path.to_string_lossy(),
                "chart_type": chart_type,
                "title": title,
                "source_note": source,
                "renderer": "local-professional-svg-v1",
                "artifact_status": "DRAFT",
                "publishable": false
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
