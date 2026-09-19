use super::{ToolRegistry, ToolResult};
use crate::llm::{LLMClient, Message, ToolUse};
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

// Keep the V2 agent on the same editorial contract as the bundled newsroom
// runtime. This is a project-owned skill; no upstream template code is copied.
const EDITORIAL_CHART_SKILL: &str = include_str!("../../skills/editorial-chart/SKILL.md");
const ARTIFACT_CORRECTION: &str = "A real artifact file must be created through an available artifact-producing tool. Source code in the assistant message does not satisfy the request.";

/// The deliverable is selected once from the original user goal. It is not a
/// model-facing planning step and is never reclassified from an assistant
/// message or a tool result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum VisualDeliverableIntent {
    #[default]
    None,
    SingleChart,
    DataReport,
    IntegratedExplainer,
    VisualEssay,
    BrowserPublication,
}

impl VisualDeliverableIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::SingleChart => "SingleChart",
            Self::DataReport => "DataReport",
            Self::IntegratedExplainer => "IntegratedExplainer",
            Self::VisualEssay => "VisualEssay",
            Self::BrowserPublication => "BrowserPublication",
        }
    }

    pub fn requires_story(self) -> bool {
        matches!(
            self,
            Self::DataReport
                | Self::IntegratedExplainer
                | Self::VisualEssay
                | Self::BrowserPublication
        )
    }
}

fn contains_any(goal: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| goal.contains(term))
}

/// Deterministic intent routing. Keep this vocabulary in sync with the CLI
/// contract and use the original goal only; no extra classifier/planner call
/// is made.
pub fn determine_visual_deliverable_intent(goal: &str) -> VisualDeliverableIntent {
    let lower = goal.to_lowercase();
    let visual_essay = contains_any(
        &lower,
        &[
            "scrollytelling",
            "visual essay",
            "interactive story",
            "滚动叙事",
            "交互长文",
            "视觉文章",
        ],
    );
    let integrated = contains_any(
        &lower,
        &[
            "map",
            "spatial",
            "route",
            "anatomy",
            "mechanism",
            "explainer",
            "地图",
            "空间",
            "路线",
            "建筑",
            "剖面",
            "结构",
            "机制",
            "原理",
            "过程",
            "灾害演变",
        ],
    );
    let report = contains_any(
        &lower,
        &[
            "infographic report",
            "data story report",
            "data report",
            "visual report",
            "one-pager",
            "white paper",
            "brief",
            "infographic",
            "information graphic",
            "信息图",
            "数据新闻",
            "数据报告",
            "视觉报告",
            "调研报告",
            "研究报告",
            "年报",
            "月报",
            "白皮书",
            "海报",
        ],
    );
    let browser_explicit = contains_any(
        &lower,
        &[
            "interactive html",
            "browser publication",
            "browser report",
            "web report",
            "网页",
            "浏览器报告",
        ],
    );
    let chart = contains_any(
        &lower,
        &[
            "chart",
            "plot",
            "graph",
            "visualization",
            "visualisation",
            "柱状图",
            "折线图",
            "散点图",
            "图表",
            "图",
        ],
    );
    let browser = browser_explicit || (lower.contains("html") && !chart);
    let explicit_single = contains_any(
        &lower,
        &[
            "single chart",
            "one chart",
            "a chart",
            "one plot",
            "single plot",
            "单图",
            "一张图",
            "一个图",
            "一幅图",
        ],
    );

    if visual_essay {
        VisualDeliverableIntent::VisualEssay
    } else if integrated {
        VisualDeliverableIntent::IntegratedExplainer
    } else if browser && !(explicit_single && !report) {
        VisualDeliverableIntent::BrowserPublication
    } else if report {
        VisualDeliverableIntent::DataReport
    } else if chart {
        VisualDeliverableIntent::SingleChart
    } else {
        VisualDeliverableIntent::None
    }
}

#[derive(Debug, Clone, Default)]
pub struct VisualStoryState {
    pub intent: VisualDeliverableIntent,
    pub verified_claim_count: usize,
    pub editorial_discovery_passed: bool,
    pub story_graph_passed: bool,
    pub story_roles: HashSet<String>,
    pub distinct_findings: usize,
    pub distinct_analytical_jobs: usize,
    pub verified_visual_assets: Vec<PathBuf>,
    pub infographic_plan_passed: bool,
    pub infographic_rendered: bool,
    pub infographic_critic_passed: bool,
    pub publication_html_verified: bool,
    pub publication_qa_passed: bool,
    pub module_count: usize,
    pub source_bound_module_count: usize,
    pub single_chart_fallback: bool,
}

impl VisualStoryState {
    pub fn completion_error(&self) -> Option<String> {
        if self.intent == VisualDeliverableIntent::None {
            return None;
        }
        if self.verified_claim_count == 0 {
            return Some("no verified claim supports the requested visual deliverable".into());
        }
        if self.intent == VisualDeliverableIntent::SingleChart {
            if self.verified_visual_assets.is_empty() {
                return Some("single-chart request has no verified visual file".into());
            }
            return None;
        }
        if self.distinct_findings < 2 {
            return Some("evidence insufficient to support a complex infographic".into());
        }
        if !self.editorial_discovery_passed {
            return Some("editorial discovery has not passed".into());
        }
        if !self.story_graph_passed {
            return Some("Story Graph lint has not passed".into());
        }
        let required_role_groups: &[&[&str]] = &[
            &["hook"],
            &["context", "evidence"],
            &["turn", "explanation"],
            &["resolution"],
        ];
        for group in required_role_groups {
            if !group.iter().any(|role| self.story_roles.contains(*role)) {
                return Some(format!("Story Graph is missing {}", group.join(" or ")));
            }
        }
        if self.distinct_analytical_jobs < 2 {
            return Some("complex report requires two distinct analytical jobs".into());
        }
        if self.verified_visual_assets.len() < 2 {
            return Some("complex report requires two verified visual assets".into());
        }
        if !(4..=9).contains(&self.module_count) {
            return Some("infographic plan must contain 4–9 ordered modules".into());
        }
        if self.source_bound_module_count != self.module_count {
            return Some("every report module must be source-bound".into());
        }
        if self.single_chart_fallback {
            return Some("single-chart fallback cannot complete a complex report".into());
        }
        if !self.infographic_plan_passed
            || !self.infographic_rendered
            || !self.infographic_critic_passed
        {
            return Some("infographic plan, render, and critic must all pass".into());
        }
        if !self.publication_html_verified || !self.publication_qa_passed {
            return Some("publication HTML and QA must both pass".into());
        }
        None
    }
}

/// Agent 状态
#[derive(Debug)]
pub struct AgentState {
    pub goal: String,
    pub conversation: Vec<Message>,
    pub tool_results: Vec<(String, ToolResult)>,
    pub iteration: usize,
}

impl AgentState {
    pub fn new(goal: String) -> Self {
        Self {
            goal,
            conversation: Vec::new(),
            tool_results: Vec::new(),
            iteration: 0,
        }
    }

    pub fn add_user_message(&mut self, content: String) {
        self.conversation.push(Message::user(&content));
    }

    pub fn add_assistant_response(&mut self, content: &str, tool_uses: &[ToolUse]) {
        self.conversation
            .push(Message::assistant_response(content, tool_uses));
    }

    pub fn add_tool_results_message(&mut self, blocks: Vec<serde_json::Value>, content: String) {
        self.conversation
            .push(Message::tool_results(blocks, content));
    }

    pub fn add_tool_result(&mut self, tool_name: String, result: ToolResult) {
        self.tool_results.push((tool_name, result));
    }
}

/// Newsroom Agent
pub struct NewsroomAgent {
    llm: LLMClient,
    tools: ToolRegistry,
    state: AgentState,
    max_iterations: usize,
    run_root: PathBuf,
    artifact_paths: Vec<PathBuf>,
    pub intent: VisualDeliverableIntent,
    pub story_state: VisualStoryState,
}

impl NewsroomAgent {
    pub fn new(llm: LLMClient, tools: ToolRegistry, goal: String) -> Self {
        let intent = determine_visual_deliverable_intent(&goal);
        Self {
            llm,
            tools,
            state: AgentState::new(goal),
            max_iterations: 20,
            run_root: std::env::var_os("NEWSROOM_OUTPUT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
            artifact_paths: Vec::new(),
            intent,
            story_state: VisualStoryState {
                intent,
                ..VisualStoryState::default()
            },
        }
    }

    pub fn with_run_root(mut self, run_root: PathBuf) -> Self {
        self.run_root = run_root;
        self
    }

    /// 构建系统提示词
    fn build_system_prompt(&self) -> String {
        let single_chart_method = if self.intent == VisualDeliverableIntent::SingleChart {
            "单图方法：economist-analytical。每张图只回答一个可验证判断；使用熟悉图形、结论式标题、直接标签、明确比较基准和克制颜色，并保留来源与计算绑定。"
        } else {
            ""
        };
        format!(
            r#"你是一个数据新闻调查 agent。

调查目标：{}

确定性交付意图：{}

你的任务：
1. 理解调查目标
2. 规划调查步骤
3. 使用可用工具收集信息
4. 分析数据
5. 生成结构化报告

可用工具：
{}

规则：
- 根据需要主动调用工具
- 对互不依赖的工具可在同一轮批量调用；等待所有结果后再决策
- 基于工具结果动态调整计划
- 完成后输出完整的调查报告
- 报告要包含数据来源和关键发现

图表输出必须遵守项目 editorial-chart skill（不要把装饰当作证据）：
{}

{}
"#,
            self.state.goal,
            self.intent.as_str(),
            self.tools.list_tools().join(", "),
            EDITORIAL_CHART_SKILL,
            single_chart_method
        )
    }

    /// 构建消息列表
    fn build_messages(&self) -> Vec<Message> {
        let mut messages = vec![Message::system(&self.build_system_prompt())];

        // 添加对话历史
        messages.extend(self.state.conversation.clone());

        messages
    }

    /// 执行调查
    pub async fn investigate(&mut self) -> Result<String> {
        if self.intent.requires_story() {
            let blocker = self
                .story_state
                .completion_error()
                .unwrap_or_else(|| "rich story state is incomplete".to_string());
            bail!(
                "{} requires the bundled visual-story pipeline: {blocker}",
                self.intent.as_str()
            );
        }
        // 初始化
        self.state.add_user_message(self.state.goal.clone());
        let artifact_required = requires_file_artifact(&self.state.goal);
        let mut artifact_created = false;
        let mut corrective_turn_used = false;

        // Agent 循环
        loop {
            self.state.iteration += 1;

            if self.state.iteration > self.max_iterations {
                eprintln!("⚠️  达到最大迭代次数 {}", self.max_iterations);
                break;
            }

            eprintln!(
                "\n🔄 Iteration {}/{}",
                self.state.iteration, self.max_iterations
            );

            // 调用 LLM
            let messages = self.build_messages();
            let tools = if self.llm.uses_openai_tools() {
                self.tools.to_openai_tools()
            } else {
                self.tools.to_claude_tools()
            };

            let response = self.llm.chat(&messages, Some(&tools)).await?;

            // Preserve the exact assistant turn shape for Anthropic tool use:
            // text and tool_use blocks must share one assistant message.
            if !response.content.is_empty() || !response.tool_uses.is_empty() {
                self.state
                    .add_assistant_response(&response.content, &response.tool_uses);
            }
            if !response.content.is_empty() {
                eprintln!(
                    "💭 Agent: {}",
                    response.content.lines().next().unwrap_or("")
                );
            }

            // 处理工具调用
            if !response.tool_uses.is_empty() {
                let mut result_blocks = Vec::with_capacity(response.tool_uses.len());
                let mut rendered_results = String::new();
                for tool_use in &response.tool_uses {
                    eprintln!("🔧 Tool: {} ({})", tool_use.name, tool_use.id);

                    // 执行工具
                    let result = match self
                        .tools
                        .execute(&tool_use.name, tool_use.input.clone())
                        .await
                    {
                        Ok(result) => result,
                        Err(error) => ToolResult {
                            success: false,
                            output: bounded_tool_error(&tool_use.name, &error),
                            data: None,
                        },
                    };

                    if result.success {
                        eprintln!("✅ {}", result.output);
                    } else {
                        eprintln!("❌ {}", result.output);
                    }

                    // 记录结果
                    self.state
                        .add_tool_result(tool_use.name.clone(), result.clone());
                    if let Some(path) = verified_artifact_path(&result, &self.run_root) {
                        artifact_created = true;
                        self.artifact_paths.push(path);
                    }

                    // 将工具结果添加到对话
                    let result_message = if let Some(data) = &result.data {
                        format!(
                            "Tool '{}' result:\n{}\nData: {}",
                            tool_use.name,
                            result.output,
                            serde_json::to_string_pretty(data)?
                        )
                    } else {
                        format!("Tool '{}' result: {}", tool_use.name, result.output)
                    };

                    let mut result_block = serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": result_message,
                    });
                    if !result.success {
                        result_block["is_error"] = serde_json::Value::Bool(true);
                    }
                    result_blocks.push(result_block);
                    rendered_results.push_str(&format!("{}\n", result_message));
                }

                // One assistant turn maps to one user turn containing every
                // tool result in order, as required by Anthropic Messages.
                self.state
                    .add_tool_results_message(result_blocks, rendered_results);

                // 继续循环让 agent 处理工具结果
                continue;
            }

            if artifact_required && !artifact_created {
                if corrective_turn_used {
                    anyhow::bail!(
                        "Artifact request could not be completed: no verified artifact file was created under {} after one corrective turn.",
                        self.run_root.display()
                    );
                }
                corrective_turn_used = true;
                eprintln!("⚠️  File-backed request has no verified artifact; requesting the artifact tool.");
                self.state.add_user_message(ARTIFACT_CORRECTION.to_string());
                continue;
            }

            // 如果没有工具调用，agent 完成
            eprintln!("\n✅ 调查完成");
            break;
        }

        if artifact_required && !artifact_created {
            anyhow::bail!(
                "Artifact request could not be completed: no verified artifact file was created under {}.",
                self.run_root.display()
            );
        }

        // 生成最终报告
        self.generate_report()
    }

    /// 生成报告
    fn generate_report(&self) -> Result<String> {
        let mut report = String::new();

        report.push_str(&format!("# 调查报告：{}\n\n", self.state.goal));
        report.push_str(&format!("**迭代次数**：{}\n\n", self.state.iteration));
        report.push_str(&format!(
            "**工具调用**：{}\n\n",
            self.state.tool_results.len()
        ));

        // 添加最后的 assistant 消息作为主要内容
        if let Some(last_msg) = self.state.conversation.last() {
            report.push_str("## 调查结果\n\n");
            report.push_str(&last_msg.content);
            report.push_str("\n\n");
        }

        // 添加工具使用记录
        if !self.state.tool_results.is_empty() {
            report.push_str("## 数据来源\n\n");
            for (tool_name, result) in &self.state.tool_results {
                report.push_str(&format!("- **{}**: {}\n", tool_name, result.output));
            }
        }

        if !self.artifact_paths.is_empty() {
            report.push_str("\n## 生成的文件\n\n");
            for path in &self.artifact_paths {
                report.push_str(&format!("- `{}`\n", path.display()));
            }
        }

        Ok(report)
    }
}

fn requires_file_artifact(goal: &str) -> bool {
    let lowercase_goal = goal.to_ascii_lowercase();
    [
        "chart",
        "visual",
        "html",
        "svg",
        "infographic",
        "map",
        "dashboard",
        "plot",
        "diagram",
        "artifact",
        "file-backed",
        "output file",
        "create a file",
        "generate a file",
        "write a file",
        "save a file",
        "output a file",
        "export a file",
        "javascript file",
        "js file",
        "webpage",
        "web page",
        "export",
    ]
    .iter()
    .any(|keyword| lowercase_goal.contains(keyword))
        || [
            "图表",
            "可视化",
            "信息图",
            "地图",
            "仪表盘",
            "仪表板",
            "数据看板",
            "网页",
            "矢量图",
            "绘图",
            "导出",
            "生成文件",
            "创建文件",
            "输出文件",
            "导出文件",
            "保存文件",
            "写入文件",
        ]
        .iter()
        .any(|keyword| goal.contains(keyword))
}

fn bounded_tool_error(name: &str, error: &anyhow::Error) -> String {
    const MAX_ERROR_CHARS: usize = 1_200;
    let mut message = format!("Tool '{name}' execution failed: {error:#}");
    if message.chars().count() > MAX_ERROR_CHARS {
        message = message.chars().take(MAX_ERROR_CHARS).collect();
        message.push('…');
    }
    message
}

fn verified_artifact_path(result: &ToolResult, run_root: &Path) -> Option<PathBuf> {
    if !result.success {
        return None;
    }

    let canonical_root = std::fs::canonicalize(run_root).ok()?;
    let data = result.data.as_ref()?.as_object()?;
    ["file_path", "file", "svg_path"]
        .iter()
        .filter_map(|field| data.get(*field).and_then(Value::as_str))
        .find_map(|raw_path| {
            let candidate = Path::new(raw_path);
            let candidate = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                run_root.join(candidate)
            };
            let canonical_candidate = std::fs::canonicalize(candidate).ok()?;
            if !canonical_candidate.starts_with(&canonical_root) {
                return None;
            }
            std::fs::metadata(&canonical_candidate)
                .ok()
                .filter(|metadata| metadata.is_file())?;
            Some(canonical_candidate)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::Provider;

    #[test]
    fn v2_prompt_includes_editorial_chart_skill() {
        let agent = NewsroomAgent::new(
            LLMClient::new(
                Provider::Anthropic,
                "test-key".to_string(),
                "test-model".to_string(),
            ),
            ToolRegistry::default(),
            "test goal".to_string(),
        );
        let prompt = agent.build_system_prompt();
        assert!(prompt.contains("investigate-v2` contract"));
        assert!(prompt.contains("Do not use gradients"));
    }

    #[test]
    fn file_artifact_intent_covers_product_vocabulary() {
        for goal in [
            "make a chart",
            "build a visualization",
            "write an HTML file",
            "create an SVG",
            "生成信息图",
            "制作地图",
            "做一个数据看板",
            "创建文件",
        ] {
            assert!(requires_file_artifact(goal), "{goal}");
        }
        assert!(!requires_file_artifact("summarize the latest climate news"));
        assert!(!requires_file_artifact("分析这个文件中的数据"));
    }

    #[test]
    fn visual_intent_is_deterministic_and_report_strict() {
        assert_eq!(
            determine_visual_deliverable_intent("请做一张经济比较图表"),
            VisualDeliverableIntent::SingleChart
        );
        assert_eq!(
            determine_visual_deliverable_intent("调研主题并生成中文版数据新闻信息图报告"),
            VisualDeliverableIntent::DataReport
        );
        assert_eq!(
            determine_visual_deliverable_intent("制作机制解释网页 HTML 报告"),
            VisualDeliverableIntent::IntegratedExplainer
        );
        assert_eq!(
            determine_visual_deliverable_intent("写一篇 scrollytelling visual essay"),
            VisualDeliverableIntent::VisualEssay
        );
        assert_eq!(
            determine_visual_deliverable_intent("输出 browser publication HTML"),
            VisualDeliverableIntent::BrowserPublication
        );
        assert_eq!(
            determine_visual_deliverable_intent("summarize the latest climate news"),
            VisualDeliverableIntent::None
        );
    }

    #[test]
    fn complex_story_state_rejects_single_chart_fallback() {
        let state = VisualStoryState {
            intent: VisualDeliverableIntent::DataReport,
            verified_claim_count: 4,
            distinct_findings: 4,
            distinct_analytical_jobs: 2,
            verified_visual_assets: vec![PathBuf::from("one.svg")],
            module_count: 1,
            single_chart_fallback: true,
            ..VisualStoryState::default()
        };
        let error = state.completion_error().expect("state must be blocked");
        assert!(error.contains("editorial discovery") || error.contains("visual assets"));
    }

    #[test]
    fn evidence_insufficiency_is_not_publishable() {
        let state = VisualStoryState {
            intent: VisualDeliverableIntent::BrowserPublication,
            verified_claim_count: 1,
            distinct_findings: 1,
            ..VisualStoryState::default()
        };
        assert_eq!(
            state.completion_error().as_deref(),
            Some("evidence insufficient to support a complex infographic")
        );
    }

    #[test]
    fn artifact_path_must_be_a_file_inside_the_run_root() {
        let root = tempfile::tempdir().expect("run root");
        let outside = tempfile::tempdir().expect("outside root");
        let inside_path = root.path().join("visualizations/chart.html");
        std::fs::create_dir_all(inside_path.parent().expect("parent")).expect("directory");
        std::fs::write(&inside_path, "<html></html>").expect("artifact");
        let outside_path = outside.path().join("outside.html");
        std::fs::write(&outside_path, "<html></html>").expect("outside artifact");

        let inside_result = ToolResult {
            success: true,
            output: "ignored".to_string(),
            data: Some(serde_json::json!({"file_path": inside_path})),
        };
        let outside_result = ToolResult {
            success: true,
            output: "ignored".to_string(),
            data: Some(serde_json::json!({"file_path": outside_path})),
        };

        assert!(verified_artifact_path(&inside_result, root.path()).is_some());
        assert!(verified_artifact_path(&outside_result, root.path()).is_none());
    }
}
