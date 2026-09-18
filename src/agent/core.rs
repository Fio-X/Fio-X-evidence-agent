use super::{ToolRegistry, ToolResult};
use crate::llm::{LLMClient, Message, ToolUse};
use anyhow::Result;

// Keep the V2 agent on the same editorial contract as the bundled newsroom
// runtime. This is a project-owned skill; no upstream template code is copied.
const EDITORIAL_CHART_SKILL: &str = include_str!("../../skills/editorial-chart/SKILL.md");

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
}

impl NewsroomAgent {
    pub fn new(llm: LLMClient, tools: ToolRegistry, goal: String) -> Self {
        Self {
            llm,
            tools,
            state: AgentState::new(goal),
            max_iterations: 20,
        }
    }

    /// 构建系统提示词
    fn build_system_prompt(&self) -> String {
        format!(
            r#"你是一个数据新闻调查 agent。

调查目标：{}

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
"#,
            self.state.goal,
            self.tools.list_tools().join(", "),
            EDITORIAL_CHART_SKILL
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
        // 初始化
        self.state.add_user_message(self.state.goal.clone());

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
            let tools = self.tools.to_claude_tools();

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
                        Err(_) => ToolResult {
                            success: false,
                            output: format!("Tool '{}' execution failed", tool_use.name),
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

            // 如果没有工具调用，agent 完成
            eprintln!("\n✅ 调查完成");
            break;
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

        Ok(report)
    }
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
}
