//! The system prompt of the Rust agent (1011ag step 6), written for this project: a news-infographic workshop, not a general coding
//! assistant. It is built once per session from three things only: the tools the host reported, the allow list of the command, and the
//! run folder. The same inputs give the same bytes, and nothing here reads the environment, the clock, or any file, so the text stays
//! identical from one turn of a session to the next (request caching). Guidelines come already worked out per tool (the host adds the
//! speed-switch ones where the switches are read); this module only collects them.

use crate::tool_host::ToolInfo;
use std::collections::BTreeMap;
use std::path::Path;

const ROLE: &str = "You are the assistant of a news-infographic workshop. A reader asks a question about the world; you answer it by \
researching with the data tools listed below and by planning the charts, maps and page that present the answer. Every number you \
state must come from a tool result, and every chart must be built from data a tool produced.";

/// Two guidelines that apply to every run, after the tools' own.
const GENERAL_GUIDELINES: [&str; 2] = [
    "When a tool returns an error or reports that a check was not met, say so plainly and fix the cause; do not present the result as if it had passed.",
    "Verification status is decided by the tools and the program around you. Never state or imply that a figure, source or chart is verified unless a tool result says so.",
];

/// Tool lines in the order of the allow list (the command's existing order), only for tools that are both reported by the host and allowed,
/// and only those with a one-line snippet.
fn listed<'a>(
    tools: &'a BTreeMap<String, ToolInfo>,
    allowed: &'a [String],
) -> Vec<(&'a str, &'a ToolInfo)> {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for name in allowed {
        if seen.contains(&name.as_str()) {
            continue;
        }
        seen.push(name);
        if let Some(info) = tools.get(name) {
            if info
                .prompt_snippet
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                out.push((name.as_str(), info));
            }
        }
    }
    out
}

/// Trimmed, non-empty, first occurrence only, in order.
fn tidy(lines: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        let line = line.trim().to_string();
        if !line.is_empty() && !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

pub fn system_prompt(
    tools: &BTreeMap<String, ToolInfo>,
    allowed: &[String],
    run_dir: &Path,
) -> String {
    let shown = listed(tools, allowed);
    let list = if shown.is_empty() {
        "None".to_string()
    } else {
        shown
            .iter()
            .map(|(name, info)| {
                format!(
                    "- {name}: {}",
                    info.prompt_snippet.as_deref().unwrap_or("").trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let rules = tidy(
        shown
            .iter()
            .flat_map(|(_, info)| info.prompt_guidelines.iter().cloned())
            .chain(GENERAL_GUIDELINES.iter().map(|g| g.to_string())),
    )
    .iter()
    .map(|g| format!("- {g}"))
    .collect::<Vec<_>>()
    .join("\n");
    format!(
        "{ROLE}\n\nTools you may call:\n{list}\n\nHow to work here:\n{rules}\n\nThis run's folder: {}",
        run_dir.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn tool(snippet: Option<&str>, guidelines: &[&str]) -> ToolInfo {
        ToolInfo {
            description: "d".into(),
            parameters: json!({"type": "object"}),
            group: "agent".into(),
            prompt_snippet: snippet.map(str::to_string),
            prompt_guidelines: guidelines.iter().map(|g| g.to_string()).collect(),
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    fn sample() -> BTreeMap<String, ToolInfo> {
        BTreeMap::from([
            (
                "query".to_string(),
                tool(
                    Some("Run a read-only SQL query on the run's data."),
                    &["  Query before you chart.  ", "", "Cite the table."],
                ),
            ),
            (
                "plan".to_string(),
                tool(
                    Some("Plan the page."),
                    &["Query before you chart.", "Keep one idea per chart."],
                ),
            ),
            (
                "quiet".to_string(),
                tool(None, &["Never shown: its tool has no snippet."]),
            ),
            (
                "blank".to_string(),
                tool(Some("   "), &["Never shown either."]),
            ),
            (
                "outside".to_string(),
                tool(Some("Not on the allow list."), &["Outside guideline."]),
            ),
        ])
    }

    fn built() -> String {
        system_prompt(
            &sample(),
            &names(&["plan", "query", "quiet", "blank", "absent"]),
            &PathBuf::from("/runs/one"),
        )
    }

    #[test]
    fn the_same_inputs_give_the_same_bytes() {
        assert_eq!(built(), built());
        assert!(built().starts_with("You are the assistant of a news-infographic workshop."));
    }

    #[test]
    fn tools_follow_the_allow_list_order_and_only_snippet_tools_on_the_list_appear() {
        let text = built();
        let plan = text.find("- plan: Plan the page.").unwrap();
        let query = text.find("- query: Run a read-only SQL query").unwrap();
        assert!(plan < query, "allow-list order, not name order");
        for hidden in [
            "quiet",
            "blank",
            "outside",
            "absent",
            "Not on the allow list",
            "Never shown",
        ] {
            assert!(!text.contains(hidden), "{hidden}");
        }
    }

    #[test]
    fn with_no_snippet_tool_the_list_says_none() {
        let text = system_prompt(&sample(), &names(&["quiet", "blank"]), Path::new("/r"));
        assert!(text.contains("Tools you may call:\nNone\n"));
        assert!(text.contains("How to work here:\n- When a tool returns an error"));
    }

    #[test]
    fn guidelines_are_trimmed_not_empty_deduplicated_in_order_then_two_general_ones() {
        let text = built();
        let section = text.split("How to work here:\n").nth(1).unwrap();
        let lines: Vec<&str> = section
            .lines()
            .take_while(|l| l.starts_with("- "))
            .collect();
        // plan first (allow-list order): its two; query's first is a duplicate after trimming; then query's second; then the general two.
        assert_eq!(lines[0], "- Query before you chart.");
        assert_eq!(lines[1], "- Keep one idea per chart.");
        assert_eq!(lines[2], "- Cite the table.");
        assert_eq!(lines.len(), 5);
        assert!(lines[3].contains("error") && lines[4].contains("Verification status"));
    }

    #[test]
    fn a_speed_guideline_added_by_the_host_shows_up_like_any_other() {
        let mut tools = sample();
        tools
            .get_mut("plan")
            .unwrap()
            .prompt_guidelines
            .push("Send all the plan fields in one call.".into());
        let text = system_prompt(&tools, &names(&["plan"]), Path::new("/r"));
        assert!(text.contains("- Send all the plan fields in one call."));
    }

    #[test]
    fn the_working_directory_line_is_the_run_folder_and_there_is_no_date() {
        let text = built();
        assert!(text.ends_with("This run's folder: /runs/one"));
        for token in text.split(|c: char| !c.is_ascii_alphanumeric()) {
            let year = token.len() == 4
                && token.starts_with("20")
                && token.chars().all(|c| c.is_ascii_digit());
            assert!(!year, "no date: {token}");
        }
        for word in ["today", "Today", "date"] {
            assert!(!text.contains(word), "{word}");
        }
    }

    #[test]
    fn nothing_about_file_shell_tools_context_files_skills_or_the_old_runner_appears() {
        let text = built();
        let tokens: Vec<&str> = text
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '.')
            .collect();
        for banned in [
            "bash",
            "ls",
            "rg",
            "grep",
            "cat",
            "AGENTS.md",
            "Pi",
            "skill",
            "skills",
        ] {
            assert!(!tokens.contains(&banned), "{banned}");
        }
        for banned in ["context file", "documentation", "SKILL"] {
            assert!(!text.contains(banned), "{banned}");
        }
    }

    #[test]
    fn the_general_guidelines_leave_verification_to_the_tools() {
        assert!(GENERAL_GUIDELINES[1].contains("decided by the tools"));
        assert!(built().contains("unless a tool result says so"));
    }
}
