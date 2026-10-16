//! NEWSROOM_STEP_LINES=1: one named line per finished tool call, a line when the
//! first chart is out, and a closing line, all on stderr. With the switch on the
//! `[agent] phase=` progress lines are hidden; every other `[agent]` line stays.
//!
//! Only names, isError/passed flags read from the program's own result fields,
//! our own clock, the critic score, counts and the verification verdict are
//! printed. Never arguments, result text, SQL, URLs or paths. Nothing here feeds
//! back into the run: it grants no verification, completion or publication status.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

pub const ENV: &str = "NEWSROOM_STEP_LINES";
const CHAIN_TOOL: &str = "newsroom_viz_chain";

/// Exactly "1" turns it on; unset, "0", "true" and anything else are off.
pub fn enabled() -> bool {
    enabled_from(std::env::var(ENV).ok().as_deref())
}

/// The pure rule behind `enabled`, so a test can check it without changing the process environment.
fn enabled_from(value: Option<&str>) -> bool {
    value == Some("1")
}

static START: OnceLock<Instant> = OnceLock::new();
static ZH: AtomicBool = AtomicBool::new(false);
static CALLS: AtomicU32 = AtomicU32::new(0);
static REFUSED: AtomicU32 = AtomicU32::new(0);

/// Called once where a command starts. Language follows the request: Chinese
/// when it holds at least two CJK characters (the rule `language_instruction` uses).
pub fn begin(request: &str) {
    if !enabled() {
        return;
    }
    START.get_or_init(Instant::now);
    let cjk = request
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count();
    ZH.store(cjk >= 2, Ordering::Relaxed);
}

/// Seconds since the command started (the clock starts at first use if `begin` was not called).
pub fn secs_now() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub fn language_zh() -> bool {
    ZH.load(Ordering::Relaxed)
}

/// Display name for a tool. Unknown names print raw when they are plain
/// identifiers (a tool name can be model-influenced text), otherwise `?`.
pub fn step_name(tool: &str, zh: bool) -> String {
    let (z, e) = match tool {
        "newsroom_update_plan" => ("制定计划", "plan"),
        "artifact_inventory" => ("查看已有文件", "list files"),
        "news_search" => ("搜索新闻", "search news"),
        "fetch_url" => ("读取网页", "read page"),
        "download_data" => ("下载公开数据", "download data"),
        "duckdb_query" => ("用 SQL 计算", "SQL query"),
        "record_claim" => ("核实数字", "check figures"),
        "newsroom_story_graph" => ("梳理故事线", "story outline"),
        "newsroom_viz_plan" => ("设计图表", "design chart"),
        "newsroom_viz_lint" => ("检查图表设计", "check chart design"),
        "newsroom_viz_render" => ("出图", "render chart"),
        "newsroom_viz_critic" => ("图表自查打分", "chart self-check score"),
        CHAIN_TOOL => (
            "设计 → 检查 → 出图 → 自查（一次完成）",
            "design → check → render → self-check (one call)",
        ),
        "newsroom_visual_skill" => ("读取画图规则", "read chart rules"),
        "newsroom_parallel_tasks" => ("并行读取", "parallel reads"),
        "newsroom_viz_patch" => ("改图表设计", "patch chart design"),
        other => {
            let plain = !other.is_empty()
                && other.len() <= 48
                && other
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
            return if plain {
                other.to_string()
            } else {
                "?".to_string()
            };
        }
    };
    (if zh { z } else { e }).to_string()
}

/// Critic score as an integer 0–100; absent or non-numeric yields nothing.
fn score_of(details: &Value) -> Option<u32> {
    let n = details.get("score")?.as_f64()?;
    n.is_finite().then(|| n.round().clamp(0.0, 100.0) as u32)
}

/// Whether the program itself says this call was refused or failed. Read from
/// result fields only, never from text: isError, a lint/critic `passed: false`, a
/// render `renderQaPassed: false`, or a chain that STOPPED.
fn refused(tool: &str, is_error: bool, details: &Value) -> bool {
    is_error
        || match tool {
            "newsroom_viz_lint" | "newsroom_viz_critic" => {
                details.get("passed").and_then(Value::as_bool) == Some(false)
            }
            "newsroom_viz_render" => {
                details.get("renderQaPassed").and_then(Value::as_bool) == Some(false)
            }
            CHAIN_TOOL => details.get("chainStatus").and_then(Value::as_str) == Some("STOPPED"),
            _ => false,
        }
}

fn stamp(at: f64) -> String {
    format!("[{:>5}s]", at.floor() as u64)
}

fn score_text(score: u32, zh: bool) -> String {
    if zh {
        format!(" · {score} 分")
    } else {
        format!(" · score {score}")
    }
}

fn tool_line(
    at: f64,
    took: f64,
    name: &str,
    score: Option<u32>,
    refused: bool,
    zh: bool,
) -> String {
    let mut line = format!("{} {name}", stamp(at));
    if let Some(s) = score {
        line.push_str(&score_text(s, zh));
    }
    if took >= 2.0 {
        line.push_str(&format!(" ({}s)", took.round() as u64));
    }
    if refused {
        line.push_str(if zh {
            "  ← 退回，自己改"
        } else {
            "  ← refused, fixing"
        });
    }
    line
}

/// The first chart is out: seconds since the command started, plus the program's own score when known.
pub fn chart_out_line(at: f64, score: Option<u32>, zh: bool) -> String {
    let mut line = format!(
        "{} {}",
        stamp(at),
        if zh { "图出来了" } else { "chart is out" }
    );
    if let Some(s) = score {
        line.push_str(&if zh {
            format!(" · 程序自查 {s} 分")
        } else {
            format!(" · program self-check {s}")
        });
    }
    line
}

/// Closing line. The totals and the verdict come from the program, never from model text.
pub fn final_line(total_secs: f64, calls: u32, refused: u32, verified: bool, zh: bool) -> String {
    let total = total_secs.round() as u64;
    if zh {
        format!(
            "== 完成：共 {total} 秒，{calls} 次调用（其中退回 {refused} 次）；系统复算：{} ==",
            if verified { "通过" } else { "未通过" }
        )
    } else {
        format!("== Done: {total} s, {calls} calls ({refused} refused); recomputation by the program: {} ==", if verified { "passed" } else { "not passed" })
    }
}

/// Prints the closing line after the post-run verdict. Off: prints nothing.
pub fn print_final(verified: bool) {
    if enabled() {
        eprintln!(
            "{}",
            final_line(
                secs_now(),
                CALLS.load(Ordering::Relaxed),
                REFUSED.load(Ordering::Relaxed),
                verified,
                language_zh()
            )
        );
    }
}

/// Follows the Pi tool events of one run and returns the lines to print.
#[derive(Default)]
pub struct StepTracker {
    open: HashMap<String, (String, f64)>,
    chart_out: bool,
}

impl StepTracker {
    pub fn on_start(&mut self, event: &Value, at: f64) {
        let (Some(tool), Some(id)) = (
            event.get("toolName").and_then(Value::as_str),
            event.get("toolCallId").and_then(Value::as_str),
        ) else {
            return;
        };
        self.open.insert(id.to_string(), (tool.to_string(), at));
    }

    pub fn on_end(&mut self, event: &Value, at: f64, zh: bool) -> Vec<String> {
        let id = event
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (tool, started) = match self.open.remove(id) {
            Some(found) => found,
            None => match event.get("toolName").and_then(Value::as_str) {
                Some(tool) => (tool.to_string(), at),
                None => return Vec::new(),
            },
        };
        let is_error = event.get("isError").and_then(Value::as_bool) == Some(true);
        let empty = Value::Null;
        let details = event
            .get("result")
            .and_then(|r| r.get("details"))
            .unwrap_or(&empty);
        let is_refused = refused(&tool, is_error, details);
        let is_critic = tool == "newsroom_viz_critic" || tool == CHAIN_TOOL;
        // A finished chain reports passed/score at its top level; fall back to its critic step.
        let critic_step = (tool == CHAIN_TOOL)
            .then(|| chain_critic_details(details))
            .flatten();
        let score = if is_critic {
            score_of(details).or_else(|| critic_step.and_then(score_of))
        } else {
            None
        };
        CALLS.fetch_add(1, Ordering::Relaxed);
        if is_refused {
            REFUSED.fetch_add(1, Ordering::Relaxed);
        }
        let mut lines = vec![tool_line(
            started,
            at - started,
            &step_name(&tool, zh),
            score,
            is_refused,
            zh,
        )];
        if tool == CHAIN_TOOL {
            lines.extend(self.chain_inner(details, zh));
        }
        let passed = details.get("passed").and_then(Value::as_bool).or_else(|| {
            critic_step
                .and_then(|d| d.get("passed"))
                .and_then(Value::as_bool)
        }) == Some(true);
        let complete = tool != CHAIN_TOOL
            || details.get("chainStatus").and_then(Value::as_str) == Some("COMPLETE");
        if is_critic && !is_error && passed && complete && !self.chart_out {
            self.chart_out = true;
            lines.push(chart_out_line(at, score, zh));
        }
        lines
    }

    /// The chain's finished steps, printed when the chain ends. The result carries no
    /// per-step times, so none are shown; the chain's own time is on its line above.
    fn chain_inner(&self, details: &Value, zh: bool) -> Vec<String> {
        let mut lines = Vec::new();
        let steps = details.get("steps").and_then(Value::as_array);
        let mut last_done: Option<&str> = None;
        for step in steps.into_iter().flatten() {
            if let Some(tool) = step.get("tool").and_then(Value::as_str) {
                last_done = Some(tool);
                let step_details = step.get("details").unwrap_or(&Value::Null);
                let stopped_here = details.get("chainStatus").and_then(Value::as_str)
                    == Some("STOPPED")
                    && details.get("failedAt").and_then(Value::as_str) == Some(tool);
                let step_score = if tool == "newsroom_viz_critic" {
                    score_of(step_details)
                } else {
                    None
                };
                let step_refused = stopped_here || refused(tool, false, step_details);
                CALLS.fetch_add(1, Ordering::Relaxed);
                lines.push(inner_line(
                    &step_name(tool, zh),
                    step_score,
                    step_refused,
                    zh,
                ));
            }
        }
        // A step that errored before it finished is not in the done list; name it from failedAt.
        if details.get("chainStatus").and_then(Value::as_str) == Some("STOPPED") {
            if let Some(failed) = details.get("failedAt").and_then(Value::as_str) {
                if last_done != Some(failed) {
                    CALLS.fetch_add(1, Ordering::Relaxed);
                    lines.push(inner_line(&step_name(failed, zh), None, true, zh));
                }
            }
        }
        lines
    }
}

/// The details of the chain's critic step, when it ran.
fn chain_critic_details(details: &Value) -> Option<&Value> {
    details
        .get("steps")?
        .as_array()?
        .iter()
        .find(|s| s.get("tool").and_then(Value::as_str) == Some("newsroom_viz_critic"))?
        .get("details")
}

fn inner_line(name: &str, score: Option<u32>, refused: bool, zh: bool) -> String {
    let mut line = format!("   · {name}");
    if let Some(s) = score {
        line.push_str(&score_text(s, zh));
    }
    if refused {
        line.push_str(if zh {
            "  ← 退回，自己改"
        } else {
            "  ← refused, fixing"
        });
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn end(tool: &str, id: &str, is_error: bool, details: Value) -> Value {
        json!({"type": "tool_execution_end", "toolName": tool, "toolCallId": id, "isError": is_error, "result": {"details": details}})
    }
    fn start(tool: &str, id: &str) -> Value {
        json!({"type": "tool_execution_start", "toolName": tool, "toolCallId": id, "args": {"sql": "SELECT secret"}})
    }

    #[test]
    fn names_follow_the_language_and_unknown_tools_print_plain_or_question_mark() {
        assert_eq!(step_name("duckdb_query", true), "用 SQL 计算");
        assert_eq!(step_name("duckdb_query", false), "SQL query");
        assert_eq!(step_name("newsroom_viz_critic", true), "图表自查打分");
        assert_eq!(
            step_name(CHAIN_TOOL, true),
            "设计 → 检查 → 出图 → 自查（一次完成）"
        );
        assert_eq!(step_name("some_new_tool", true), "some_new_tool");
        assert_eq!(step_name("Bad Tool\n[agent] forged", true), "?");
        assert_eq!(step_name(&"a".repeat(49), true), "?");
        assert_eq!(step_name("", true), "?");
    }

    #[test]
    fn tool_line_has_right_aligned_seconds_duration_over_two_seconds_and_refusal() {
        assert_eq!(
            tool_line(12.4, 0.2, "用 SQL 计算", None, false, true),
            "[   12s] 用 SQL 计算"
        );
        assert_eq!(
            tool_line(12.0, 3.4, "用 SQL 计算", None, false, true),
            "[   12s] 用 SQL 计算 (3s)"
        );
        assert_eq!(
            tool_line(7.0, 1.9, "出图", None, true, true),
            "[    7s] 出图  ← 退回，自己改"
        );
        assert_eq!(tool_line(123.0, 0.0, "x", None, false, false), "[  123s] x");
    }

    #[test]
    fn refusal_comes_from_program_fields_only() {
        assert!(refused("duckdb_query", true, &Value::Null));
        assert!(!refused("duckdb_query", false, &json!({"passed": false})));
        assert!(refused(
            "newsroom_viz_lint",
            false,
            &json!({"passed": false})
        ));
        assert!(refused(
            "newsroom_viz_critic",
            false,
            &json!({"passed": false})
        ));
        assert!(refused(
            "newsroom_viz_render",
            false,
            &json!({"renderQaPassed": false})
        ));
        assert!(!refused(
            "newsroom_viz_render",
            false,
            &json!({"renderQaPassed": true})
        ));
        assert!(refused(
            CHAIN_TOOL,
            false,
            &json!({"chainStatus": "STOPPED"})
        ));
        assert!(!refused(
            CHAIN_TOOL,
            false,
            &json!({"chainStatus": "COMPLETE"})
        ));
    }

    #[test]
    fn score_is_an_integer_0_to_100_or_absent() {
        assert_eq!(score_of(&json!({"score": 95.6})), Some(96));
        assert_eq!(score_of(&json!({"score": 250})), Some(100));
        assert_eq!(score_of(&json!({"score": -3})), Some(0));
        assert_eq!(score_of(&json!({"score": "96"})), None);
        assert_eq!(score_of(&json!({})), None);
    }

    #[test]
    fn a_plain_call_prints_one_line_and_never_args_or_results() {
        let mut t = StepTracker::default();
        t.on_start(&start("duckdb_query", "c1"), 19.1);
        let lines = t.on_end(
            &end(
                "duckdb_query",
                "c1",
                false,
                json!({"rows": [["secret-value"]]}),
            ),
            19.3,
            true,
        );
        assert_eq!(lines, vec!["[   19s] 用 SQL 计算".to_string()]);
        assert!(!lines.join("").contains("secret"));
    }

    #[test]
    fn a_completed_chain_prints_the_chain_its_inner_steps_and_the_chart_out_line_once() {
        let mut t = StepTracker::default();
        let chain = json!({"chain": CHAIN_TOOL, "chainStatus": "COMPLETE", "passed": true, "score": 96,
            "steps": [{"tool": "newsroom_viz_plan", "params": {"x": "SECRET"}, "details": {}}, {"tool": "newsroom_viz_lint", "details": {"passed": true}}, {"tool": "newsroom_viz_render", "details": {"renderQaPassed": true}}, {"tool": "newsroom_viz_critic", "details": {"passed": true, "score": 96}}]});
        t.on_start(&start(CHAIN_TOOL, "k"), 34.0);
        let lines = t.on_end(&end(CHAIN_TOOL, "k", false, chain.clone()), 50.0, true);
        assert_eq!(
            lines[0],
            "[   34s] 设计 → 检查 → 出图 → 自查（一次完成） · 96 分 (16s)"
        );
        assert_eq!(
            &lines[1..5],
            [
                "   · 设计图表",
                "   · 检查图表设计",
                "   · 出图",
                "   · 图表自查打分 · 96 分"
            ]
        );
        assert_eq!(lines[5], "[   50s] 图出来了 · 程序自查 96 分");
        assert_eq!(lines.len(), 6);
        assert!(!lines.join("").contains("SECRET"));
        t.on_start(&start(CHAIN_TOOL, "k2"), 60.0);
        assert!(
            !t.on_end(&end(CHAIN_TOOL, "k2", false, chain), 61.0, true)
                .iter()
                .any(|l| l.contains("图出来了")),
            "the chart-out line is printed once"
        );
    }

    #[test]
    fn a_chain_without_top_level_passed_or_score_reads_them_from_its_critic_step() {
        let mut t = StepTracker::default();
        let chain = json!({"chainStatus": "COMPLETE", "steps": [{"tool": "newsroom_viz_plan", "details": {}}, {"tool": "newsroom_viz_critic", "details": {"passed": true, "score": 90}}]});
        t.on_start(&start(CHAIN_TOOL, "k"), 5.0);
        let lines = t.on_end(&end(CHAIN_TOOL, "k", false, chain), 9.0, true);
        assert!(lines[0].contains("· 90 分"), "{lines:?}");
        assert_eq!(lines.last().unwrap(), "[    9s] 图出来了 · 程序自查 90 分");
    }

    #[test]
    fn a_stopped_chain_marks_the_refused_step_and_prints_no_chart_out_line() {
        let mut t = StepTracker::default();
        let chain = json!({"chainStatus": "STOPPED", "failedAt": "newsroom_viz_render", "stopCode": "RENDER_QA_FAILED",
            "steps": [{"tool": "newsroom_viz_plan", "details": {}}, {"tool": "newsroom_viz_lint", "details": {"passed": true}}, {"tool": "newsroom_viz_render", "details": {"renderQaPassed": false}}]});
        t.on_start(&start(CHAIN_TOOL, "k"), 30.0);
        let lines = t.on_end(&end(CHAIN_TOOL, "k", false, chain), 33.0, true);
        assert!(lines[0].ends_with("(3s)  ← 退回，自己改"), "{lines:?}");
        assert_eq!(lines[3], "   · 出图  ← 退回，自己改");
        assert!(!lines.iter().any(|l| l.contains("图出来了")));
    }

    #[test]
    fn a_critic_that_asks_for_revision_is_refused_and_a_passing_one_announces_the_chart() {
        let mut t = StepTracker::default();
        t.on_start(&start("newsroom_viz_critic", "a"), 40.0);
        let lines = t.on_end(
            &end(
                "newsroom_viz_critic",
                "a",
                false,
                json!({"passed": false, "score": 61}),
            ),
            40.2,
            true,
        );
        assert_eq!(
            lines,
            vec!["[   40s] 图表自查打分 · 61 分  ← 退回，自己改".to_string()]
        );
        t.on_start(&start("newsroom_viz_critic", "b"), 55.0);
        let lines = t.on_end(
            &end(
                "newsroom_viz_critic",
                "b",
                false,
                json!({"passed": true, "score": 88}),
            ),
            55.1,
            false,
        );
        assert_eq!(
            lines,
            vec![
                "[   55s] chart self-check score · score 88".to_string(),
                "[   55s] chart is out · program self-check 88".to_string()
            ]
        );
    }

    #[test]
    fn final_line_reports_totals_and_the_verdict() {
        assert_eq!(
            final_line(75.6, 10, 0, true, true),
            "== 完成：共 76 秒，10 次调用（其中退回 0 次）；系统复算：通过 =="
        );
        assert_eq!(
            final_line(75.6, 10, 2, false, true),
            "== 完成：共 76 秒，10 次调用（其中退回 2 次）；系统复算：未通过 =="
        );
        assert_eq!(
            final_line(75.6, 10, 0, true, false),
            "== Done: 76 s, 10 calls (0 refused); recomputation by the program: passed =="
        );
    }

    #[test]
    fn only_an_exact_one_turns_it_on() {
        for (value, expected) in [
            ("1", true),
            ("0", false),
            ("true", false),
            ("", false),
            (" 1", false),
        ] {
            assert_eq!(enabled_from(Some(value)), expected, "{value:?}");
        }
        assert!(!enabled_from(None));
    }
}
