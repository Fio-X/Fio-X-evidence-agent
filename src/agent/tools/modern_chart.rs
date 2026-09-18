use super::Tool;
use crate::agent::ToolResult;
use crate::output;
use anyhow::{bail, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::fs;

const PAPER: &str = "#f4f1ea";
const INK: &str = "#202124";
const MUTED: &str = "#5f6368";
const GRID: &str = "#d8d4cc";
const ACCENT: &str = "#1f5a68";
const HIGHLIGHT: &str = "#174552";

/// Interactive chart tool with the project's editorial chart contract.
///
/// ECharts is retained for hover and resize behaviour, while the generated
/// page owns the visual tokens so an LLM cannot silently select a decorative
/// theme for every chart.
pub struct ModernChartTool;

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_script_json(value: String) -> String {
    value
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

fn extract_data(data: &[Value]) -> Result<(Vec<String>, Vec<f64>)> {
    if data.is_empty() {
        bail!("'data' must contain at least one row");
    }

    let mut labels = Vec::with_capacity(data.len());
    let mut values = Vec::with_capacity(data.len());
    for (index, item) in data.iter().enumerate() {
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .ok_or_else(|| anyhow::anyhow!("data[{}].label must be a non-empty string", index))?;
        let value = item
            .get("value")
            .and_then(Value::as_f64)
            .ok_or_else(|| anyhow::anyhow!("data[{}].value must be a number", index))?;
        if !value.is_finite() {
            bail!("data[{}].value must be finite", index);
        }
        labels.push(label.to_string());
        values.push(value);
    }
    Ok((labels, values))
}

fn format_number(value: f64) -> String {
    if value.abs() < 0.0005 {
        return "0".to_string();
    }
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

/// Render an inline SVG fallback so the chart remains legible when the
/// optional ECharts CDN cannot be reached. This is also the deterministic
/// offline representation used by screenshot QA.
fn fallback_svg(chart_type: &str, labels: &[String], values: &[f64], title: &str) -> String {
    const WIDTH: f64 = 960.0;
    const HEIGHT: f64 = 440.0;
    const LEFT: f64 = 76.0;
    const RIGHT: f64 = 24.0;
    const TOP: f64 = 24.0;
    const BOTTOM: f64 = 72.0;
    let plot_width = WIDTH - LEFT - RIGHT;
    let plot_height = HEIGHT - TOP - BOTTOM;

    let mut min_value: f64 = 0.0;
    let mut max_value: f64 = 0.0;
    for value in values {
        min_value = min_value.min(*value);
        max_value = max_value.max(*value);
    }
    if (max_value - min_value).abs() < f64::EPSILON {
        max_value = min_value + 1.0;
    }
    let value_y = |value: f64| TOP + (max_value - value) / (max_value - min_value) * plot_height;
    let baseline_y = value_y(0.0);
    let mut svg = format!(
        r##"<svg class="fallback-chart" id="fallback-chart" viewBox="0 0 {WIDTH:.0} {HEIGHT:.0}" role="img" aria-label="{title}">
    <rect width="{WIDTH:.0}" height="{HEIGHT:.0}" fill="#fffdf8"/>
    <g fill="{muted}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12">
"##,
        WIDTH = WIDTH,
        HEIGHT = HEIGHT,
        title = escape_html(title),
        muted = MUTED,
    );

    for tick_index in 0..=4 {
        let fraction = tick_index as f64 / 4.0;
        let value = min_value + (max_value - min_value) * fraction;
        let y = value_y(value);
        svg.push_str(&format!(
            r#"        <line x1="{LEFT:.2}" x2="{right:.2}" y1="{y:.2}" y2="{y:.2}" stroke="{grid}" stroke-width="1"/>
        <text x="{label_x:.2}" y="{label_y:.2}" text-anchor="end">{value}</text>
"#,
            LEFT = LEFT,
            right = WIDTH - RIGHT,
            y = y,
            grid = GRID,
            label_x = LEFT - 10.0,
            label_y = y + 4.0,
            value = format_number(value),
        ));
    }

    svg.push_str(&format!(
        r#"        <line x1="{LEFT:.2}" x2="{right:.2}" y1="{baseline:.2}" y2="{baseline:.2}" stroke="{ink}" stroke-width="1.5"/>
    </g>
"#,
        LEFT = LEFT,
        right = WIDTH - RIGHT,
        baseline = baseline_y,
        ink = INK,
    ));

    let count = labels.len() as f64;
    if chart_type == "line" {
        let step = if labels.len() <= 1 {
            0.0
        } else {
            plot_width / (count - 1.0)
        };
        let points: Vec<String> = values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                format!("{:.2},{:.2}", LEFT + step * index as f64, value_y(*value))
            })
            .collect();
        svg.push_str(&format!(
            r#"    <polyline points="{points}" fill="none" stroke="{accent}" stroke-width="3" stroke-linejoin="round"/>
"#,
            points = points.join(" "),
            accent = ACCENT,
        ));
        for (index, (label, value)) in labels.iter().zip(values).enumerate() {
            let x = LEFT + step * index as f64;
            let y = value_y(*value);
            svg.push_str(&format!(
                r#"    <circle cx="{x:.2}" cy="{y:.2}" r="4" fill="{accent}"/>
    <text x="{x:.2}" y="{value_y:.2}" text-anchor="middle" fill="{ink}" font-size="11">{value}</text>
    <text x="{x:.2}" y="{label_y:.2}" text-anchor="middle" fill="{muted}">{label}</text>
"#,
                x = x,
                y = y,
                accent = ACCENT,
                value_y = (y - 10.0).max(TOP + 12.0),
                ink = INK,
                value = format_number(*value),
                label_y = HEIGHT - 28.0,
                muted = MUTED,
                label = escape_html(label),
            ));
        }
    } else {
        let step = plot_width / count.max(1.0);
        let bar_width = (step * 0.62).min(64.0);
        for (index, (label, value)) in labels.iter().zip(values).enumerate() {
            let center = LEFT + step * (index as f64 + 0.5);
            let y = value_y(*value);
            let top = y.min(baseline_y);
            let height = (baseline_y - y).abs().max(1.0);
            svg.push_str(&format!(
                r#"    <rect x="{x:.2}" y="{top:.2}" width="{width:.2}" height="{height:.2}" fill="{accent}"/>
    <text x="{center:.2}" y="{value_y:.2}" text-anchor="middle" fill="{ink}" font-size="11">{value}</text>
    <text x="{center:.2}" y="{label_y:.2}" text-anchor="middle" fill="{muted}">{label}</text>
"#,
                x = center - bar_width / 2.0,
                top = top,
                width = bar_width,
                height = height,
                accent = ACCENT,
                center = center,
                value_y = (top - 10.0).max(TOP + 12.0),
                ink = INK,
                value = format_number(*value),
                label_y = HEIGHT - 28.0,
                muted = MUTED,
                label = escape_html(label),
            ));
        }
    }
    svg.push_str("</svg>");
    svg
}

fn content_id(
    title: &str,
    chart_type: &str,
    data: &[Value],
    subtitle: Option<&str>,
    unit: Option<&str>,
    source_note: Option<&str>,
) -> Result<String> {
    let canonical = json!({
        "renderer": "editorial-echarts-v1",
        "title": title,
        "chart_type": chart_type,
        "data": data,
        "subtitle": subtitle,
        "unit": unit,
        "source_note": source_note,
    });
    let bytes = serde_json::to_vec(&canonical)?;
    let digest = Sha256::digest(bytes);
    let hex = format!("{:x}", digest);
    Ok(hex[..12].to_string())
}

impl ModernChartTool {
    /// Generate deterministic ECharts HTML with editorial tokens.
    async fn generate_echarts_html(
        &self,
        title: &str,
        chart_type: &str,
        data: &[Value],
        subtitle: Option<&str>,
        unit: Option<&str>,
        source_note: Option<&str>,
    ) -> Result<String> {
        if title.trim().is_empty() {
            bail!("'title' must not be empty");
        }
        if !matches!(chart_type, "bar" | "line") {
            bail!(
                "Unsupported chart_type '{}'; use 'bar' or 'line'",
                chart_type
            );
        }

        let (labels, values) = extract_data(data)?;
        let x_data_json = escape_script_json(serde_json::to_string(&labels)?);
        let y_data_json = escape_script_json(serde_json::to_string(&values)?);
        let fallback_svg = fallback_svg(chart_type, &labels, &values, title.trim());
        let unit_value = unit.map(str::trim).filter(|unit| !unit.is_empty());
        let unit_json = unit_value
            .map(|value| serde_json::to_string(value).map(escape_script_json))
            .transpose()?
            .unwrap_or_else(|| "null".to_string());
        let chart_config = match chart_type {
            "bar" => self.bar_chart_config(&x_data_json, &y_data_json),
            "line" => self.line_chart_config(&x_data_json, &y_data_json),
            _ => unreachable!("chart_type was validated above"),
        };

        let title_html = escape_html(title.trim());
        let subtitle_html = subtitle
            .map(str::trim)
            .filter(|subtitle| !subtitle.is_empty())
            .map(|subtitle| format!("<p class=\"subtitle\">{}</p>", escape_html(subtitle)))
            .unwrap_or_default();
        let unit_html = unit_value
            .map(|unit| format!("<p class=\"unit\">单位：{}</p>", escape_html(unit)))
            .unwrap_or_default();
        let source_missing = source_note
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none();
        let source_html = escape_html(
            source_note
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("未提供（发布前请补充）"),
        );
        let source_class = if source_missing {
            "source-note missing"
        } else {
            "source-note"
        };

        Ok(format!(
            r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <title>{title}</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
    <style>
        :root {{
            color-scheme: light;
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: {paper};
            color: {ink};
        }}
        * {{ box-sizing: border-box; }}
        body {{
            margin: 0;
            min-width: 280px;
            background: {paper};
            color: {ink};
            padding: clamp(20px, 4vw, 48px) clamp(16px, 4vw, 56px) 32px;
        }}
        .container {{ max-width: 1120px; margin: 0 auto; }}
        .header {{ border-bottom: 1px solid {grid}; padding-bottom: 16px; }}
        h1 {{
            margin: 0;
            max-width: 34em;
            font-size: clamp(25px, 3.3vw, 36px);
            line-height: 1.12;
            letter-spacing: -0.02em;
            font-weight: 760;
        }}
        .subtitle {{
            margin: 10px 0 0;
            max-width: 62em;
            color: {muted};
            font-size: 15px;
            line-height: 1.55;
        }}
        .unit {{ margin: 8px 0 0; color: {muted}; font-size: 13px; }}
        #chart {{
            width: 100%;
            height: clamp(360px, 52vw, 560px);
            margin-top: 24px;
            background: #fffdf8;
            border: 1px solid {grid};
        }}
        .fallback-chart {{ width: 100%; height: 100%; display: block; }}
        .source-note {{
            margin: 12px 0 0;
            border-top: 1px solid {grid};
            padding-top: 10px;
            color: {muted};
            font-size: 12px;
            line-height: 1.45;
        }}
        .source-note.missing {{ color: #8a2f2f; }}
        .interaction-note {{ margin: 5px 0 0; color: {muted}; font-size: 12px; }}
        @media (prefers-reduced-motion: reduce) {{
            *, *::before, *::after {{ scroll-behavior: auto !important; }}
        }}
        @media (max-width: 640px) {{
            #chart {{ height: 360px; margin-top: 18px; }}
            .interaction-note {{ display: none; }}
        }}
    </style>
</head>
<body>
    <main class="container">
        <header class="header">
            <h1>{title}</h1>
            {subtitle}
            {unit}
        </header>
        <div id="chart" role="img" aria-label="{title}">{fallback_svg}</div>
        <p class="source-note {source_class}">来源：{source}</p>
        <p class="interaction-note">交互仅用于查看细节；图中直接标注保留主要数值。</p>
        <noscript>交互不可用，静态图仍可查看。</noscript>
    </main>
    <script>
        var chartUnit = {unit_json};
        function escapeTooltip(value) {{
            return String(value).replace(/[&<>\"']/g, function(character) {{
                return {{'&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;'}}[character];
            }});
        }}
        var fallback = document.getElementById('fallback-chart');
        if (typeof echarts !== 'undefined') {{
            if (fallback) fallback.hidden = true;
            var chart = echarts.init(document.getElementById('chart'), null, {{
                renderer: 'canvas',
                useDirtyRect: true
            }});
            var option = {chart_config};
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {{
                option.animation = false;
            }}
            chart.setOption(option);
            window.addEventListener('resize', function() {{ chart.resize(); }});
        }}
    </script>
</body>
</html>"#,
            title = title_html,
            subtitle = subtitle_html,
            unit = unit_html,
            fallback_svg = fallback_svg,
            source = source_html,
            source_class = source_class,
            paper = PAPER,
            ink = INK,
            muted = MUTED,
            grid = GRID,
            chart_config = chart_config,
            unit_json = unit_json,
        ))
    }

    fn bar_chart_config(&self, x_data: &str, y_data: &str) -> String {
        format!(
            r#"{{
            tooltip: {{
                trigger: 'axis',
                axisPointer: {{ type: 'line', lineStyle: {{ color: '{grid}' }} }},
                backgroundColor: '#fffdf8',
                borderColor: '{grid}',
                borderWidth: 1,
                textStyle: {{ color: '{ink}', fontSize: 13 }},
                formatter: function(params) {{
                    var point = params[0];
                    var suffix = chartUnit ? ' ' + escapeTooltip(chartUnit) : '';
                    return escapeTooltip(point.name) + '<br/>' + Number(point.value).toLocaleString() + suffix;
                }}
            }},
            grid: {{ left: '7%', right: '4%', bottom: '14%', top: '8%', containLabel: true }},
            xAxis: {{
                type: 'category',
                data: {x_data},
                axisLabel: {{ fontSize: 12, color: '{muted}', interval: 0, hideOverlap: true }},
                axisTick: {{ show: false }},
                axisLine: {{ lineStyle: {{ color: '{grid}' }} }}
            }},
            yAxis: {{
                type: 'value',
                axisLabel: {{ fontSize: 12, color: '{muted}', formatter: function(value) {{ return Number(value).toLocaleString(); }} }},
                splitLine: {{ lineStyle: {{ color: '{grid}', type: 'solid' }} }},
                axisLine: {{ show: false }}
            }},
            series: [{{
                type: 'bar',
                data: {y_data},
                barMaxWidth: 48,
                itemStyle: {{ color: '{accent}', borderRadius: [2, 2, 0, 0] }},
                emphasis: {{ itemStyle: {{ color: '{highlight}' }} }},
                label: {{ show: true, position: 'top', formatter: '{{c}}', fontSize: 12, color: '{ink}' }},
                animationDuration: 420,
                animationEasing: 'cubicOut'
            }}]
        }}"#,
            x_data = x_data,
            y_data = y_data,
            ink = INK,
            muted = MUTED,
            grid = GRID,
            accent = ACCENT,
            highlight = HIGHLIGHT,
        )
    }

    fn line_chart_config(&self, x_data: &str, y_data: &str) -> String {
        format!(
            r#"{{
            tooltip: {{
                trigger: 'axis',
                backgroundColor: '#fffdf8',
                borderColor: '{grid}',
                borderWidth: 1,
                textStyle: {{ color: '{ink}', fontSize: 13 }},
                formatter: function(params) {{
                    var point = params[0];
                    var suffix = chartUnit ? ' ' + escapeTooltip(chartUnit) : '';
                    return escapeTooltip(point.name) + '<br/>' + Number(point.value).toLocaleString() + suffix;
                }}
            }},
            grid: {{ left: '7%', right: '5%', bottom: '14%', top: '12%', containLabel: true }},
            xAxis: {{
                type: 'category',
                data: {x_data},
                boundaryGap: false,
                axisLabel: {{ fontSize: 12, color: '{muted}', hideOverlap: true }},
                axisLine: {{ lineStyle: {{ color: '{grid}' }} }}
            }},
            yAxis: {{
                type: 'value',
                axisLabel: {{ fontSize: 12, color: '{muted}', formatter: function(value) {{ return Number(value).toLocaleString(); }} }},
                splitLine: {{ lineStyle: {{ color: '{grid}', type: 'solid' }} }}
            }},
            series: [{{
                type: 'line',
                data: {y_data},
                smooth: false,
                showSymbol: true,
                symbol: 'circle',
                symbolSize: 7,
                lineStyle: {{ width: 2, color: '{accent}' }},
                itemStyle: {{ color: '{accent}' }},
                label: {{ show: true, position: 'top', formatter: '{{c}}', fontSize: 11, color: '{ink}' }},
                emphasis: {{ itemStyle: {{ color: '{highlight}' }} }},
                animationDuration: 420,
                animationEasing: 'cubicOut'
            }}]
        }}"#,
            x_data = x_data,
            y_data = y_data,
            ink = INK,
            muted = MUTED,
            grid = GRID,
            accent = ACCENT,
            highlight = HIGHLIGHT,
        )
    }
}

#[async_trait]
impl Tool for ModernChartTool {
    fn name(&self) -> &str {
        "create_modern_chart"
    }

    fn description(&self) -> &str {
        concat!(
            "Create a restrained interactive editorial bar or line chart after checking the values. ",
            "The renderer uses one solid accent, direct labels, truthful axes, responsive layout, ",
            "reduced-motion support, and an explicit source note. Pass unit and source_note when known; ",
            "do not use it for maps, pies, or unverified claims."
        )
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Conclusion-led chart title"
                },
                "chart_type": {
                    "type": "string",
                    "enum": ["bar", "line"],
                    "description": "bar for category comparison; line for an ordered time or sequence"
                },
                "data": {
                    "type": "array",
                    "description": "Checked rows with label and numeric value fields",
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
                    "description": "Optional factual subtitle"
                },
                "unit": {
                    "type": "string",
                    "description": "Optional measured unit, such as people or %"
                },
                "source_note": {
                    "type": "string",
                    "description": "Data source citation; never invent this value"
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
        let subtitle = params.get("subtitle").and_then(Value::as_str);
        let unit = params.get("unit").and_then(Value::as_str);
        let source_note = params.get("source_note").and_then(Value::as_str);
        let id = content_id(title, chart_type, data, subtitle, unit, source_note)?;
        let html = self
            .generate_echarts_html(title, chart_type, data, subtitle, unit, source_note)
            .await?;

        let output_dir = output::runtime_output_dir()?;
        let visual_dir = output_dir.join("visualizations");
        fs::create_dir_all(&visual_dir).await?;
        let filepath = visual_dir.join(format!("modern_chart_{}_{}.html", chart_type, id));
        fs::write(&filepath, html).await?;
        let source_note_provided = source_note
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();

        Ok(ToolResult {
            success: true,
            output: format!(
                "Created editorial interactive {} chart '{}'\nSaved to: {}\nSource note provided: {}",
                chart_type, title, filepath.display(), source_note_provided
            ),
            data: Some(json!({
                "file_path": filepath,
                "chart_type": chart_type,
                "title": title,
                "interactive": true,
                "animation_default_ms": 420,
                "reduced_motion_safe": true,
                "deterministic_id": id,
                "source_note_provided": source_note_provided
            })),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn generated_chart_uses_editorial_contract() {
        let html = ModernChartTool
            .generate_echarts_html(
                "A conclusion",
                "bar",
                &[json!({"label": "A", "value": 42})],
                Some("A factual subtitle"),
                Some("people"),
                Some("Example source, 2026"),
            )
            .await
            .expect("chart should render");

        assert!(html.contains("source-note"));
        assert!(html.contains("Example source, 2026"));
        assert!(html.contains("fallback-chart"));
        assert!(html.contains("label: { show: true"));
        assert!(html.contains("prefers-reduced-motion"));
        assert!(!html.contains("linear-gradient"));
        assert!(!html.contains("box-shadow"));
        assert!(!html.contains("elasticOut"));
        assert!(html.contains("escapeTooltip"));
    }

    #[tokio::test]
    async fn malformed_data_fails_with_bounded_validation() {
        let error = ModernChartTool
            .generate_echarts_html(
                "A title",
                "bar",
                &[json!({"label": "missing value"})],
                None,
                None,
                None,
            )
            .await
            .expect_err("missing values must be rejected");
        assert!(error.to_string().contains("data[0].value"));
    }

    #[test]
    fn content_id_is_stable() {
        let data = vec![json!({"label": "A", "value": 1})];
        let first = content_id("Title", "bar", &data, None, None, None).unwrap();
        let second = content_id("Title", "bar", &data, None, None, None).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 12);
    }

    #[tokio::test]
    async fn labels_are_safe_in_inline_script() {
        let html = ModernChartTool
            .generate_echarts_html(
                "A <title>",
                "bar",
                &[json!({"label": "</script><script>alert(1)", "value": 1})],
                None,
                None,
                None,
            )
            .await
            .expect("chart should render");
        assert!(!html.contains("</script><script>alert(1)"));
        assert!(html.contains("\\u003c/script\\u003e"));
        assert!(html.contains("&lt;title&gt;"));
    }

    #[tokio::test]
    async fn missing_unit_does_not_invent_metadata() {
        let html = ModernChartTool
            .generate_echarts_html(
                "A title",
                "bar",
                &[json!({"label": "A", "value": 1})],
                None,
                None,
                None,
            )
            .await
            .expect("chart should render");
        assert!(html.contains("var chartUnit = null;"));
        assert!(!html.contains("单位：单位"));
    }
}
