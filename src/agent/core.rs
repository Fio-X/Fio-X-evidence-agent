use crate::llm::{LLMClient, Message, Response};
use super::{ToolRegistry, ToolResult};
use anyhow::Result;
use serde_json::Value;

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

    pub fn add_assistant_message(&mut self, content: String) {
        self.conversation.push(Message::assistant(&content));
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
- 每次调用一个工具
- 基于工具结果动态调整计划
- 完成后输出完整的调查报告
- 报告要包含数据来源和关键发现
"#,
            self.state.goal,
            self.tools.list_tools().join(", ")
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

            // 记录 assistant 消息
            if !response.content.is_empty() {
                self.state
                    .add_assistant_message(response.content.clone());
                eprintln!("💭 Agent: {}", response.content.lines().next().unwrap_or(""));
            }

            // 处理工具调用
            if !response.tool_uses.is_empty() {
                for tool_use in &response.tool_uses {
                    eprintln!("🔧 Tool: {} ({})", tool_use.name, tool_use.id);

                    // 执行工具
                    let result = self
                        .tools
                        .execute(&tool_use.name, tool_use.input.clone())
                        .await?;

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

                    self.state.add_user_message(result_message);
                }

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
