//! New route, flow group: the agent child's side when NEWSROOM_NEXT=1 (agent_serve.rs hands it the commands). The same JSONL
//! protocol as the agent loop (prompt, get_last_assistant_text, get_session_stats; abort is set by the reader), but a prompt
//! runs the program's fixed order (next_run::run_page) instead of a model driving tools. A run that cannot go on ends with
//! `stopped` on its agent_end, which the parent reports as is; nothing is retried or guessed here.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent_loop::{Model, ModelRequest};
use crate::anthropic_model::{AnthropicModel, ToolDef};
use crate::next_flow::{legacy_problem, now_ms, Asker, GroupCatalogue, ModelRoute, Recorder, Stop};
use crate::next_run::{question_of, run_page};
use crate::tool_host::ToolHost;

/// The system text of the route's model: it only answers the program's one question per step.
pub const SYSTEM: &str = "You answer a program that builds a news infographic, one question at a time, only with the one tool \
the question offers. Give only what the question asks for: listed numbers, English search words, or Simplified Chinese wording \
that keeps every {placeholder} and types no number that is not listed.";

/// The model as the route asks it: each request offers the one tool of its step. The stand-in client is built at start; a
/// real one arrives with the handoff (agent_serve.rs) and is taken from the slot at the first ask.
pub struct NextAsker {
    standin: bool,
    model: Option<AnthropicModel>,
    slot: Arc<Mutex<Option<AnthropicModel>>>,
}

impl NextAsker {
    pub fn new(standin: Option<AnthropicModel>, slot: Arc<Mutex<Option<AnthropicModel>>>) -> Self {
        Self { standin: standin.is_some(), model: standin, slot }
    }
}

#[async_trait]
impl Asker for NextAsker {
    fn route(&self) -> ModelRoute {
        match &self.model {
            Some(model) => ModelRoute::of(self.standin, model.base_url()),
            None => ModelRoute::Other,
        }
    }

    async fn ask(&mut self, history: &[Value], tools: &[ToolDef], cancel: &AtomicBool) -> Option<Value> {
        if self.model.is_none() {
            self.model = self.slot.lock().ok().and_then(|mut s| s.take());
        }
        let Some(model) = self.model.as_mut() else {
            return Some(json!({"content": [], "stopReason": "error", "usage": {},
                "errorMessage": "the model configuration has not been received yet; no request was sent"}));
        };
        model.set_tools(tools.to_vec());
        let mut pieces = |_event: Value, _usage: Value| {};
        model.respond(&ModelRequest { history }, cancel, &mut pieces).await
    }
}

fn text_message(role: &str, text: &str) -> Value {
    json!({"role": role, "content": [{"type": "text", "text": text}], "timestamp": now_ms()})
}

pub struct NextServe {
    tools: ToolHost,
    asker: NextAsker,
    run_dir: PathBuf,
    /// Why no prompt can run: an older switch the route stands on is not as it needs, or the catalogue cannot be opened.
    broken: Option<String>,
    catalogue: Option<GroupCatalogue>,
    /// The handed-over key and the proxy's pieces, filled by the reader with the handoff; scanned out of every exchange.
    secrets: Arc<Mutex<Vec<String>>>,
    /// The parent's completion prompts come in a new child with --continue; this child's own second prompt is one too.
    resumed: bool,
    history: Vec<Value>,
    pub cancel: Arc<AtomicBool>,
}

impl NextServe {
    pub fn new(
        tools: ToolHost,
        asker: NextAsker,
        run_dir: PathBuf,
        resumed: bool,
        secrets: Arc<Mutex<Vec<String>>>,
    ) -> Self {
        let get = |key: &str| std::env::var(key).ok();
        let (broken, catalogue) = match legacy_problem(get) {
            Some(problem) => (Some(problem), None),
            None => match GroupCatalogue::from_env(get) {
                Ok(catalogue) => (None, Some(catalogue)),
                Err(stop) => (Some(stop.to_string()), None),
            },
        };
        Self { tools, asker, run_dir, broken, catalogue, secrets, resumed, history: Vec::new(), cancel: Arc::default() }
    }

    /// One command line; `abort` never reaches here (the reader sets `cancel` itself).
    pub async fn command(&mut self, line: &str, out: &mut (dyn FnMut(Value) + Send)) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Ok(command) = serde_json::from_str::<Value>(line) else {
            out(json!({"type": "response", "command": "parse", "success": false,
                "error": format!("command line is not valid JSON: {line}")}));
            return;
        };
        let name = command["type"].as_str().unwrap_or("").to_string();
        let mut response = json!({"type": "response", "command": name, "success": true});
        if let Some(id) = command.get("id") {
            response["id"] = id.clone();
        }
        match name.as_str() {
            "prompt" => {
                out(response);
                self.prompt(command["message"].as_str().unwrap_or(""), out).await;
            }
            "get_last_assistant_text" => {
                response["data"] = json!({"text": self.last_assistant_text()});
                out(response);
            }
            "get_session_stats" => {
                response["data"] = self.stats();
                out(response);
            }
            other => {
                response["success"] = json!(false);
                response["error"] = json!(format!("No such command: {other}"));
                out(response);
            }
        }
    }

    async fn prompt(&mut self, message: &str, out: &mut (dyn FnMut(Value) + Send)) {
        self.cancel.store(false, Ordering::SeqCst);
        out(json!({"type": "agent_start"}));
        let user = text_message("user", message);
        out(json!({"type": "message_start", "message": user}));
        out(json!({"type": "message_end", "message": user}));
        let resumed = std::mem::replace(&mut self.resumed, true);
        let secrets = self.secrets.lock().map(|s| s.clone()).unwrap_or_default();
        let mut produced = vec![user];
        let outcome = match (&self.broken, &self.catalogue) {
            (Some(why), _) => Err(why.clone()),
            (None, None) => Err("the catalogue was not opened".to_string()),
            (None, Some(catalogue)) => {
                let mut recorder = Recorder::new(&mut *out, &self.run_dir, secrets, Vec::new());
                let result = if resumed {
                    Err(Stop::Page { step: "rerun", why: "the completion rerun is not wired yet".into() })
                } else {
                    match question_of(message) {
                        Some(question) => {
                            run_page(&mut recorder, &mut self.asker, &mut self.tools, &question, catalogue, &self.cancel)
                                .await
                        }
                        None => Err(Stop::Page { step: "question", why: "the prompt has no investigation goal".into() }),
                    }
                };
                produced.extend(recorder.history().iter().cloned());
                result.map_err(|stop| stop.to_string())
            }
        };
        let mut end = json!({"type": "agent_end", "willRetry": false});
        match outcome {
            Ok(answer) => {
                let reply = json!({"role": "assistant", "content": [{"type": "text", "text": answer}], "stopReason": "stop",
                    "usage": {}, "timestamp": now_ms()});
                out(json!({"type": "message_start", "message": reply}));
                out(json!({"type": "message_end", "message": reply}));
                produced.push(reply);
            }
            Err(why) => end["stopped"] = json!(why),
        }
        end["messages"] = json!(produced);
        self.history.extend(produced);
        out(end);
        out(json!({"type": "agent_settled"}));
    }

    fn last_assistant_text(&self) -> Option<String> {
        self.history.iter().rev().filter(|m| m["role"] == "assistant").find_map(|m| {
            let text: Vec<&str> =
                m["content"].as_array()?.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
            (!text.is_empty()).then(|| text.concat())
        })
    }

    /// Token totals over every assistant message, and message counts, as the agent loop reports them.
    fn stats(&self) -> Value {
        let count = |role: &str| self.history.iter().filter(|m| m["role"] == role).count();
        let assistant = || self.history.iter().filter(|m| m["role"] == "assistant");
        let sum = |key: &str| assistant().map(|m| m["usage"][key].as_u64().unwrap_or(0)).sum::<u64>();
        let tokens: Vec<u64> = ["input", "output", "cacheRead", "cacheWrite"].iter().map(|k| sum(k)).collect();
        let calls: usize = assistant()
            .map(|m| m["content"].as_array().map_or(0, |b| b.iter().filter(|b| b["type"] == "toolCall").count()))
            .sum();
        json!({
            "userMessages": count("user"), "assistantMessages": count("assistant"), "toolCalls": calls,
            "toolResults": count("toolResult"), "totalMessages": self.history.len(),
            "tokens": {"input": tokens[0], "output": tokens[1], "cacheRead": tokens[2], "cacheWrite": tokens[3],
                "total": tokens.iter().sum::<u64>()},
            "cost": 0,
        })
    }
}
