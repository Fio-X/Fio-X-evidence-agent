//! NEWSROOM_REPEAT_FAILURE_STOP=1 (exact "1", default off): the same tool failing `LIMIT` times in a row with
//! equal arguments ends the run with one line naming the tool and the reason. "Equal" is equal canonical JSON
//! (object keys sorted), so a model that changes even one argument value each time is not stopped. Any
//! successful call, or any call with a different tool or different arguments, restarts the count. This only
//! decides when a run stops: it changes no check, grants no status, and never repairs anything.

use serde_json::Value;
use std::collections::HashMap;

pub const REPEAT_FAILURE_STOP_ENV: &str = "NEWSROOM_REPEAT_FAILURE_STOP";
pub const LIMIT: usize = 5;
const REASON_CHARS: usize = 160;

pub fn enabled() -> bool {
    std::env::var(REPEAT_FAILURE_STOP_ENV).ok().as_deref() == Some("1")
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), canonical(&map[k])))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(canonical).collect::<Vec<_>>().join(",")
            )
        }
        other => other.to_string(),
    }
}

/// First line of the failing result's text, one line, capped; empty when the event carries none.
fn reason_of(event: &Value) -> String {
    let text = event
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find_map(|p| p.get("text").and_then(Value::as_str))
        })
        .unwrap_or("");
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let clean: String = line.chars().filter(|c| !c.is_control()).collect();
    clean.chars().take(REASON_CHARS).collect()
}

#[derive(Default)]
pub struct RepeatFailureWatch {
    open: HashMap<String, (String, String)>,
    last: Option<(String, String)>,
    count: usize,
}

impl RepeatFailureWatch {
    pub fn on_start(&mut self, event: &Value) {
        let (Some(tool), Some(id)) = (
            event.get("toolName").and_then(Value::as_str),
            event.get("toolCallId").and_then(Value::as_str),
        ) else {
            return;
        };
        let args = event.get("args").map(canonical).unwrap_or_default();
        self.open.insert(id.to_string(), (tool.to_string(), args));
    }

    /// `Some(line)` when this finished call is the `LIMIT`th identical failure in a row.
    pub fn on_end(&mut self, event: &Value) -> Option<String> {
        let id = event
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = match self.open.remove(id) {
            Some(key) => key,
            None => (
                event.get("toolName").and_then(Value::as_str)?.to_string(),
                String::new(),
            ),
        };
        if event.get("isError").and_then(Value::as_bool) != Some(true) {
            self.last = None;
            self.count = 0;
            return None;
        }
        if self.last.as_ref() == Some(&key) {
            self.count += 1;
        } else {
            self.last = Some(key.clone());
            self.count = 1;
        }
        if self.count < LIMIT {
            return None;
        }
        let reason = reason_of(event);
        let reason = if reason.is_empty() {
            "no reason reported".to_string()
        } else {
            reason
        };
        Some(format!(
            "stopped: {} failed {LIMIT} times in a row with the same arguments ({reason})",
            key.0
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start(id: &str, tool: &str, args: Value) -> Value {
        json!({"type": "tool_execution_start", "toolCallId": id, "toolName": tool, "args": args})
    }
    fn end(id: &str, tool: &str, is_error: bool, text: &str) -> Value {
        json!({"type": "tool_execution_end", "toolCallId": id, "toolName": tool, "isError": is_error,
               "result": {"content": [{"type": "text", "text": text}]}})
    }
    /// Feeds one call; returns the stop line if this call ended the run.
    fn call(
        w: &mut RepeatFailureWatch,
        n: usize,
        tool: &str,
        args: Value,
        ok: bool,
    ) -> Option<String> {
        let id = format!("c{n}");
        w.on_start(&start(&id, tool, args));
        w.on_end(&end(
            &id,
            tool,
            !ok,
            "Alt description must be at least 20 characters\nsecond line",
        ))
    }

    #[test]
    fn five_identical_failures_stop_with_one_line_naming_tool_and_reason() {
        let mut w = RepeatFailureWatch::default();
        let args = json!({"plan_ref": "p", "n": 1});
        for n in 1..LIMIT {
            assert!(
                call(&mut w, n, "newsroom_viz_plan", args.clone(), false).is_none(),
                "call {n}"
            );
        }
        let line = call(&mut w, LIMIT, "newsroom_viz_plan", args, false).expect("fifth stops");
        assert_eq!(
            line,
            "stopped: newsroom_viz_plan failed 5 times in a row with the same arguments (Alt description must be at least 20 characters)"
        );
        assert!(!line.contains('\n'));
    }

    #[test]
    fn key_order_does_not_make_arguments_different() {
        let mut w = RepeatFailureWatch::default();
        let mut stop = None;
        for n in 1..=LIMIT {
            let args = if n % 2 == 0 {
                json!({"a": 1, "b": {"y": 2, "x": 3}})
            } else {
                json!({"b": {"x": 3, "y": 2}, "a": 1})
            };
            stop = call(&mut w, n, "t", args, false);
        }
        assert!(stop.is_some());
    }

    #[test]
    fn four_identical_failures_do_not_stop() {
        let mut w = RepeatFailureWatch::default();
        for n in 1..LIMIT {
            assert!(call(&mut w, n, "t", json!({"x": 1}), false).is_none());
        }
    }

    #[test]
    fn five_failures_with_one_argument_changed_do_not_stop() {
        let mut w = RepeatFailureWatch::default();
        for n in 1..=LIMIT {
            // A model that changes one value each time is never stopped.
            assert!(
                call(&mut w, n, "t", json!({"x": n}), false).is_none(),
                "call {n}"
            );
        }
        // Four same, then one changed: the changed call starts a new run of one, so it takes four more to reach five.
        let mut w = RepeatFailureWatch::default();
        for n in 1..LIMIT {
            assert!(call(&mut w, n, "t", json!({"x": 1}), false).is_none());
        }
        assert!(call(&mut w, 10, "t", json!({"x": 2}), false).is_none());
        for n in 11..14 {
            assert!(
                call(&mut w, n, "t", json!({"x": 2}), false).is_none(),
                "call {n}"
            );
        }
        assert!(call(&mut w, 14, "t", json!({"x": 2}), false).is_some());
    }

    #[test]
    fn a_success_in_between_resets_the_count() {
        let mut w = RepeatFailureWatch::default();
        for n in 1..LIMIT {
            assert!(call(&mut w, n, "t", json!({"x": 1}), false).is_none());
        }
        assert!(call(&mut w, 20, "t", json!({"x": 1}), true).is_none());
        for n in 21..25 {
            assert!(
                call(&mut w, n, "t", json!({"x": 1}), false).is_none(),
                "call {n}"
            );
        }
        assert!(call(&mut w, 25, "t", json!({"x": 1}), false).is_some());
    }

    #[test]
    fn a_different_tool_in_between_also_restarts_the_count() {
        let mut w = RepeatFailureWatch::default();
        for n in 1..LIMIT {
            assert!(call(&mut w, n, "t", json!({"x": 1}), false).is_none());
        }
        assert!(call(&mut w, 30, "other", json!({"x": 1}), false).is_none());
        assert!(call(&mut w, 31, "t", json!({"x": 1}), false).is_none());
    }

    #[test]
    fn a_failure_without_a_message_still_names_the_tool() {
        let mut w = RepeatFailureWatch::default();
        let mut stop = None;
        for n in 1..=LIMIT {
            let id = format!("c{n}");
            w.on_start(&start(&id, "t", json!({})));
            stop = w.on_end(&json!({"type": "tool_execution_end", "toolCallId": id, "toolName": "t", "isError": true}));
        }
        assert_eq!(
            stop.unwrap(),
            "stopped: t failed 5 times in a row with the same arguments (no reason reported)"
        );
    }

    #[test]
    fn the_reason_is_one_capped_line() {
        let long = "x".repeat(500);
        let event = end("c", "t", true, &format!("\n  {long}\nnext"));
        assert_eq!(reason_of(&event).chars().count(), REASON_CHARS);
    }

    #[test]
    fn the_switch_takes_only_the_exact_value_one() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (value, expected) in [
            (None, false),
            (Some(""), false),
            (Some("0"), false),
            (Some("true"), false),
            (Some(" 1"), false),
            (Some("01"), false),
            (Some("1"), true),
        ] {
            match value {
                Some(v) => std::env::set_var(REPEAT_FAILURE_STOP_ENV, v),
                None => std::env::remove_var(REPEAT_FAILURE_STOP_ENV),
            }
            assert_eq!(enabled(), expected, "{value:?}");
        }
        std::env::remove_var(REPEAT_FAILURE_STOP_ENV);
    }
}
