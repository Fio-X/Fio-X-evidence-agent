use super::Tool;
use crate::agent::ToolResult;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct CreateChartTool;

#[async_trait]
impl Tool for CreateChartTool {
    fn name(&self) -> &str {
        "create_chart"
    }

    fn description(&self) -> &str {
        "Create a chart or infographic from data. Supports bar charts, line charts, pie charts, and scatter plots. Returns an HTML file with the visualization."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "chart_type": {
                    "type": "string",
                    "enum": ["bar", "line", "pie", "scatter"],
                    "description": "Type of chart to create"
                },
                "title": {
                    "type": "string",
                    "description": "Chart title"
                },
                "data": {
                    "type": "object",
                    "description": "Chart data with labels and values",
                    "properties": {
                        "labels": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "X-axis labels or categories"
                        },
                        "values": {
                            "type": "array",
                            "items": {"type": "number"},
                            "description": "Y-axis values or data points"
                        }
                    },
                    "required": ["labels", "values"]
                },
                "output_file": {
                    "type": "string",
                    "description": "Output HTML file path (optional)",
                    "default": "chart.html"
                }
            },
            "required": ["chart_type", "title", "data"]
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let chart_type = params["chart_type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'chart_type'"))?;

        let title = params["title"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'title'"))?;

        let labels = params["data"]["labels"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing 'data.labels'"))?;

        let values = params["data"]["values"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing 'data.values'"))?;

        let output_file = params["output_file"]
            .as_str()
            .unwrap_or("chart.html");

        // 生成简单的 Chart.js HTML
        let labels_str = labels
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| format!("'{}'", s))
            .collect::<Vec<_>>()
            .join(", ");

        let values_str = values
            .iter()
            .filter_map(|v| v.as_f64())
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(", ");

        let chart_html = format!(
            r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>{}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body {{
            font-family: system-ui, -apple-system, sans-serif;
            padding: 20px;
            max-width: 1200px;
            margin: 0 auto;
        }}
        h1 {{
            text-align: center;
            color: #333;
        }}
        #chartContainer {{
            width: 100%;
            max-width: 800px;
            margin: 20px auto;
        }}
    </style>
</head>
<body>
    <h1>{}</h1>
    <div id="chartContainer">
        <canvas id="myChart"></canvas>
    </div>
    <script>
        const ctx = document.getElementById('myChart').getContext('2d');
        new Chart(ctx, {{
            type: '{}',
            data: {{
                labels: [{}],
                datasets: [{{
                    label: '{}',
                    data: [{}],
                    backgroundColor: [
                        'rgba(54, 162, 235, 0.5)',
                        'rgba(255, 99, 132, 0.5)',
                        'rgba(255, 206, 86, 0.5)',
                        'rgba(75, 192, 192, 0.5)',
                        'rgba(153, 102, 255, 0.5)',
                    ],
                    borderColor: [
                        'rgba(54, 162, 235, 1)',
                        'rgba(255, 99, 132, 1)',
                        'rgba(255, 206, 86, 1)',
                        'rgba(75, 192, 192, 1)',
                        'rgba(153, 102, 255, 1)',
                    ],
                    borderWidth: 1
                }}]
            }},
            options: {{
                responsive: true,
                maintainAspectRatio: true,
                plugins: {{
                    legend: {{
                        display: true,
                        position: 'top'
                    }}
                }}
            }}
        }});
    </script>
</body>
</html>"#,
            title, title, chart_type, labels_str, title, values_str
        );

        // 写入文件
        tokio::fs::write(output_file, chart_html).await?;

        Ok(ToolResult {
            success: true,
            output: format!(
                "Created {} chart '{}' saved to {}",
                chart_type, title, output_file
            ),
            data: Some(json!({
                "file": output_file,
                "chart_type": chart_type,
                "title": title
            })),
        })
    }
}
