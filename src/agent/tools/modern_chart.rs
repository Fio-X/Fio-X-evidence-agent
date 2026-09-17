use super::Tool;
use crate::agent::ToolResult;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::fs;

/// Modern interactive chart tool using ECharts
pub struct ModernChartTool;

impl ModernChartTool {
    /// Generate ECharts interactive HTML
    async fn generate_echarts_html(
        &self,
        title: &str,
        chart_type: &str,
        data: &[Value],
        subtitle: Option<&str>,
        unit: Option<&str>,
    ) -> Result<String> {
        // Extract x and y data
        let x_data: Vec<String> = data
            .iter()
            .filter_map(|item| item.get("label").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();

        let y_data: Vec<f64> = data
            .iter()
            .filter_map(|item| item.get("value").and_then(|v| v.as_f64()))
            .collect();

        let x_data_json = serde_json::to_string(&x_data)?;
        let y_data_json = serde_json::to_string(&y_data)?;

        let chart_config = match chart_type {
            "bar" => self.bar_chart_config(&x_data_json, &y_data_json),
            "line" => self.line_chart_config(&x_data_json, &y_data_json),
            _ => self.bar_chart_config(&x_data_json, &y_data_json),
        };

        let html = format!(
            r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 40px 20px;
        }}

        .container {{
            max-width: 1200px;
            margin: 0 auto;
        }}

        .header {{
            background: rgba(255, 255, 255, 0.95);
            padding: 30px;
            border-radius: 12px 12px 0 0;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }}

        h1 {{
            font-size: 32px;
            font-weight: 700;
            color: #2d3748;
            margin-bottom: 10px;
        }}

        .subtitle {{
            font-size: 16px;
            color: #718096;
            line-height: 1.6;
        }}

        #chart {{
            width: 100%;
            height: 600px;
            background: white;
            border-radius: 0 0 12px 12px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }}

        .footer {{
            margin-top: 20px;
            text-align: center;
            color: rgba(255, 255, 255, 0.8);
            font-size: 14px;
        }}

        @media (max-width: 768px) {{
            body {{
                padding: 20px 10px;
            }}

            h1 {{
                font-size: 24px;
            }}

            #chart {{
                height: 400px;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>{title}</h1>
            <div class="subtitle">{subtitle_text}</div>
        </div>
        <div id="chart"></div>
        <div class="footer">
            交互提示：鼠标悬停查看详细数据 · 点击图例筛选 · 支持缩放和拖拽
        </div>
    </div>

    <script>
        // 初始化图表
        var chart = echarts.init(document.getElementById('chart'), null, {{
            renderer: 'canvas',
            useDirtyRect: false
        }});

        // 图表配置
        var option = {chart_config};

        // 设置图表
        chart.setOption(option);

        // 响应式
        window.addEventListener('resize', function() {{
            chart.resize();
        }});

        // 添加交互提示
        chart.on('mouseover', function(params) {{
            document.body.style.cursor = 'pointer';
        }});

        chart.on('mouseout', function(params) {{
            document.body.style.cursor = 'default';
        }});
    </script>
</body>
</html>"#,
            title = title,
            subtitle_text = subtitle.unwrap_or("数据可视化分析"),
            chart_config = chart_config,
        );

        Ok(html)
    }

    /// Bar chart configuration
    fn bar_chart_config(&self, x_data: &str, y_data: &str) -> String {
        format!(
            r#"{{
            title: {{
                show: false
            }},
            tooltip: {{
                trigger: 'axis',
                axisPointer: {{
                    type: 'shadow',
                    shadowStyle: {{
                        color: 'rgba(0, 0, 0, 0.1)'
                    }}
                }},
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                borderColor: '#e2e8f0',
                borderWidth: 1,
                textStyle: {{
                    color: '#2d3748',
                    fontSize: 14
                }},
                formatter: function(params) {{
                    return '<div style="padding: 5px;">' +
                           '<strong>' + params[0].name + '</strong><br/>' +
                           '<span style="color: #4299e1;">●</span> ' +
                           params[0].value.toLocaleString() + ' 单位' +
                           '</div>';
                }}
            }},
            grid: {{
                left: '3%',
                right: '4%',
                bottom: '10%',
                top: '5%',
                containLabel: true
            }},
            xAxis: {{
                type: 'category',
                data: {x_data},
                axisLabel: {{
                    fontSize: 14,
                    color: '#4a5568',
                    interval: 0,
                    rotate: 0
                }},
                axisTick: {{
                    show: false
                }},
                axisLine: {{
                    lineStyle: {{
                        color: '#e2e8f0'
                    }}
                }}
            }},
            yAxis: {{
                type: 'value',
                axisLabel: {{
                    fontSize: 14,
                    color: '#4a5568',
                    formatter: '{{value}}'
                }},
                splitLine: {{
                    lineStyle: {{
                        color: '#f7fafc',
                        type: 'dashed'
                    }}
                }},
                axisLine: {{
                    show: false
                }}
            }},
            series: [{{
                type: 'bar',
                data: {y_data},
                barWidth: '60%',
                itemStyle: {{
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        {{ offset: 0, color: '#4facfe' }},
                        {{ offset: 0.5, color: '#00f2fe' }},
                        {{ offset: 1, color: '#43e97b' }}
                    ]),
                    borderRadius: [8, 8, 0, 0],
                    shadowBlur: 10,
                    shadowColor: 'rgba(0, 0, 0, 0.1)',
                    shadowOffsetY: 4
                }},
                emphasis: {{
                    itemStyle: {{
                        shadowBlur: 20,
                        shadowColor: 'rgba(0, 0, 0, 0.3)',
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            {{ offset: 0, color: '#667eea' }},
                            {{ offset: 0.5, color: '#764ba2' }},
                            {{ offset: 1, color: '#f093fb' }}
                        ])
                    }}
                }},
                label: {{
                    show: true,
                    position: 'top',
                    formatter: '{{c}}',
                    fontSize: 12,
                    fontWeight: 'bold',
                    color: '#2d3748'
                }},
                animationDuration: 1500,
                animationEasing: 'elasticOut'
            }}]
        }}"#,
            x_data = x_data,
            y_data = y_data
        )
    }

    /// Line chart configuration
    fn line_chart_config(&self, x_data: &str, y_data: &str) -> String {
        format!(
            r#"{{
            tooltip: {{
                trigger: 'axis',
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                borderColor: '#e2e8f0',
                borderWidth: 1
            }},
            grid: {{
                left: '3%',
                right: '4%',
                bottom: '10%',
                top: '5%',
                containLabel: true
            }},
            xAxis: {{
                type: 'category',
                data: {x_data},
                boundaryGap: false,
                axisLabel: {{ fontSize: 14, color: '#4a5568' }},
                axisLine: {{ lineStyle: {{ color: '#e2e8f0' }} }}
            }},
            yAxis: {{
                type: 'value',
                axisLabel: {{ fontSize: 14, color: '#4a5568' }},
                splitLine: {{ lineStyle: {{ color: '#f7fafc', type: 'dashed' }} }}
            }},
            series: [{{
                type: 'line',
                data: {y_data},
                smooth: true,
                lineStyle: {{
                    width: 3,
                    color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                        {{ offset: 0, color: '#4facfe' }},
                        {{ offset: 1, color: '#00f2fe' }}
                    ])
                }},
                areaStyle: {{
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        {{ offset: 0, color: 'rgba(79, 172, 254, 0.3)' }},
                        {{ offset: 1, color: 'rgba(0, 242, 254, 0.05)' }}
                    ])
                }},
                itemStyle: {{
                    color: '#4facfe',
                    borderWidth: 2,
                    borderColor: '#fff'
                }},
                emphasis: {{
                    itemStyle: {{
                        color: '#667eea',
                        borderWidth: 3,
                        borderColor: '#fff',
                        shadowBlur: 10,
                        shadowColor: 'rgba(102, 126, 234, 0.5)'
                    }}
                }},
                animationDuration: 1500,
                animationEasing: 'cubicOut'
            }}]
        }}"#,
            x_data = x_data,
            y_data = y_data
        )
    }
}

#[async_trait]
impl Tool for ModernChartTool {
    fn name(&self) -> &str {
        "create_modern_chart"
    }

    fn description(&self) -> &str {
        "Create modern, interactive data visualizations with beautiful animations and gradients. \
         Supports hover effects, smooth transitions, and responsive design. \
         Perfect for presentations and reports. \
         Use this for high-quality, engaging charts."
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
                    "enum": ["bar", "line"],
                    "description": "Type of chart: bar or line"
                },
                "data": {
                    "type": "array",
                    "description": "Array of data objects with 'label' and 'value' fields",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "value": {"type": "number"}
                        },
                        "required": ["label", "value"]
                    }
                },
                "subtitle": {
                    "type": "string",
                    "description": "Optional subtitle or description"
                }
            },
            "required": ["title", "chart_type", "data"]
        })
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        let title = params["title"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'title'"))?;

        let chart_type = params["chart_type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing 'chart_type'"))?;

        let data = params["data"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing or invalid 'data'"))?;

        let subtitle = params.get("subtitle").and_then(|v| v.as_str());

        // Generate HTML
        let html = self
            .generate_echarts_html(title, chart_type, data, subtitle, None)
            .await?;

        // Save to file
        let filename = format!(
            "modern_chart_{}_{}.html",
            chart_type,
            chrono::Utc::now().timestamp()
        );
        let filepath = format!("/tmp/{}", filename);
        fs::write(&filepath, html).await?;

        Ok(ToolResult {
            success: true,
            output: format!(
                "Created modern interactive {} chart '{}'\nSaved to: {}\nOpen in browser to see animations and hover effects!",
                chart_type, title, filepath
            ),
            data: Some(json!({
                "file_path": filepath,
                "chart_type": chart_type,
                "title": title,
                "interactive": true,
                "animated": true
            })),
        })
    }
}
