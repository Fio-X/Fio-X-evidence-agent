use super::Tool;
use crate::agent::ToolResult;
use crate::output;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Component, Path};

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_script_json(value: &str) -> Result<String> {
    Ok(serde_json::to_string(value)?
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e"))
}

pub struct CreateChartTool;

#[async_trait]
impl Tool for CreateChartTool {
    fn name(&self) -> &str {
        "create_chart"
    }

    fn description(&self) -> &str {
        concat!(
            "Compatibility fallback for a basic Chart.js chart. Supports bar, line, pie, and scatter plots. ",
            "Use create_modern_chart for the project's editorial bar/line output and use the professional ",
            "Pi tool for evidence-backed publication artifacts."
        )
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
        if !matches!(chart_type, "bar" | "line" | "pie" | "scatter") {
            return Err(anyhow::anyhow!(
                "Unsupported chart_type '{}'; use bar, line, pie, or scatter",
                chart_type
            ));
        }

        let title = params["title"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'title'"))?;

        let labels = params["data"]["labels"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing 'data.labels'"))?;

        let values = params["data"]["values"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing 'data.values'"))?;

        // 生成简单的 Chart.js HTML
        if labels.len() != values.len() {
            return Err(anyhow::anyhow!(
                "'labels' and 'values' must have the same length"
            ));
        }
        let mut label_values = Vec::with_capacity(labels.len());
        for (index, value) in labels.iter().enumerate() {
            let label = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("labels[{}] must be a string", index))?;
            label_values.push(escape_script_json(label)?);
        }
        let labels_str = label_values.join(", ");

        let mut numeric_values = Vec::with_capacity(values.len());
        for (index, value) in values.iter().enumerate() {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| anyhow::anyhow!("values[{}] must be a finite number", index))?;
            numeric_values.push(number.to_string());
        }
        let values_str = numeric_values.join(", ");
        let title_html = escape_html(title);
        let title_json = escape_script_json(title)?;
        let requested_output = params["output_file"].as_str().unwrap_or("chart.html");
        if !Path::new(requested_output).is_absolute()
            && Path::new(requested_output)
                .components()
                .any(|component| component == Component::ParentDir)
        {
            return Err(anyhow::anyhow!(
                "relative output_file must stay below the active output directory"
            ));
        }
        let output_path = if Path::new(requested_output).is_absolute() {
            Path::new(requested_output).to_path_buf()
        } else {
            output::runtime_output_dir()?.join(requested_output)
        };
        if let Some(parent) = output_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

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
                    label: {},
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
            title_html, title_html, chart_type, labels_str, title_json, values_str
        );

        // 写入文件
        tokio::fs::write(&output_path, chart_html).await?;
        let output_file = output_path.display().to_string();

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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compatibility_chart_escapes_document_and_script_values() {
        let output_file = "/tmp/create-chart-compatibility-escape-test.html";
        let result = CreateChartTool
            .execute(json!({
                "chart_type": "bar",
                "title": "<img src=x onerror=alert(1)>",
                "data": {
                    "labels": ["</script><script>alert(1)"],
                    "values": [1]
                },
                "output_file": output_file
            }))
            .await
            .expect("compatibility chart should render");
        assert!(result.success);
        let html = tokio::fs::read_to_string(output_file)
            .await
            .expect("chart file should exist");
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(html.contains("\\u003c/script\\u003e"));
        assert!(!html.contains("</script><script>alert(1)"));
        let _ = tokio::fs::remove_file(output_file).await;
    }

    #[tokio::test]
    async fn compatibility_chart_rejects_mismatched_rows() {
        let error = CreateChartTool
            .execute(json!({
                "chart_type": "bar",
                "title": "A title",
                "data": {"labels": ["A"], "values": []}
            }))
            .await
            .expect_err("mismatched rows must fail");
        assert!(error.to_string().contains("same length"));
    }

    #[tokio::test]
    async fn compatibility_chart_rejects_relative_output_escape() {
        let error = CreateChartTool
            .execute(json!({
                "chart_type": "bar",
                "title": "A title",
                "data": {"labels": ["A"], "values": [1]},
                "output_file": "../outside.html"
            }))
            .await
            .expect_err("relative output must remain under the active root");
        assert!(error.to_string().contains("active output directory"));
    }
}
