//! One `model_timing` event per model request, appended to `events.jsonl` in the run folder (NEWSROOM_MODEL_TIMING_RECORD=1). Readers of that
//! file go by `type`, so an unknown type is skipped; the audit counts lines, so with the record on its sequence numbers shift as a whole. Record only: nothing the
//! request, the stream or the loop does depends on it, and a failed write is dropped. Times are milliseconds since the request was
//! sent. No request header, address or key is recorded, and switches are listed by name only.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

pub(crate) const FILE: &str = "events.jsonl";
/// A gap longer than this between two pieces of a block starts a new burst (the relay may be holding pieces and sending them together).
const BURST_GAP_MS: u64 = 50;

pub(crate) fn enabled_from(get: impl Fn(&str) -> Option<String>) -> bool {
    get("NEWSROOM_MODEL_TIMING_RECORD").as_deref() == Some("1")
}

/// Names (never values) of the NEWSROOM_ switches that are on, sorted.
pub(crate) fn switches_on(vars: impl Iterator<Item = (String, String)>) -> Vec<String> {
    let mut names: Vec<String> = vars
        .filter(|(name, value)| name.starts_with("NEWSROOM_") && value == "1")
        .map(|(name, _)| name)
        .collect();
    names.sort();
    names
}

#[derive(Default)]
struct BlockTiming {
    kind: String,
    start_ms: u64,
    first_piece_ms: Option<u64>,
    last_piece_ms: Option<u64>,
    stop_ms: Option<u64>,
    pieces: u64,
    bursts: u64,
}

pub(crate) struct Timing {
    started: Instant,
    started_at: String,
    body_bytes: usize,
    tools_hash: String,
    switches: Vec<String>,
    headers_ms: Option<u64>,
    message_start_ms: Option<u64>,
    first_block_ms: Option<u64>,
    stop_ms: Option<u64>,
    usage_start: Option<Value>,
    usage_end: Option<Value>,
    stop_reason: Option<String>,
    blocks: BTreeMap<u64, BlockTiming>,
}

/// Only the numeric fields of a usage object, so nothing but counts is recorded from it.
fn counts(usage: &Value) -> Value {
    let mut out = Map::new();
    if let Some(map) = usage.as_object() {
        for (key, value) in map {
            if value.is_u64() {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

impl Timing {
    /// Call right before the request is sent.
    pub(crate) fn start(body: &Value, switches: Vec<String>) -> Self {
        let tools = body.get("tools").map(Value::to_string).unwrap_or_default();
        Timing {
            started: Instant::now(),
            started_at: chrono::Utc::now().to_rfc3339(),
            body_bytes: serde_json::to_vec(body).map(|b| b.len()).unwrap_or(0),
            tools_hash: format!("{:x}", Sha256::digest(tools.as_bytes())),
            switches,
            headers_ms: None,
            message_start_ms: None,
            first_block_ms: None,
            stop_ms: None,
            usage_start: None,
            usage_end: None,
            stop_reason: None,
            blocks: BTreeMap::new(),
        }
    }

    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub(crate) fn headers_arrived(&mut self) {
        self.headers_ms.get_or_insert(self.now());
    }

    pub(crate) fn event(&mut self, event: &Value) {
        let at = self.now();
        let index = event["index"].as_u64().unwrap_or(0);
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.message_start_ms.get_or_insert(at);
                self.usage_start = Some(counts(&event["message"]["usage"]));
            }
            "content_block_start" => {
                self.first_block_ms.get_or_insert(at);
                self.blocks.insert(
                    index,
                    BlockTiming {
                        kind: event["content_block"]["type"].as_str().unwrap_or("").to_string(),
                        start_ms: at,
                        ..BlockTiming::default()
                    },
                );
            }
            "content_block_delta" => {
                if let Some(block) = self.blocks.get_mut(&index) {
                    let new_burst = block.last_piece_ms.map_or(true, |last| at.saturating_sub(last) > BURST_GAP_MS);
                    block.bursts += u64::from(new_burst);
                    block.pieces += 1;
                    block.first_piece_ms.get_or_insert(at);
                    block.last_piece_ms = Some(at);
                }
            }
            "content_block_stop" => {
                if let Some(block) = self.blocks.get_mut(&index) {
                    block.stop_ms = Some(at);
                }
            }
            "message_delta" => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_string());
                }
                self.usage_end = Some(counts(&event["usage"]));
            }
            "message_stop" => {
                self.stop_ms.get_or_insert(at);
            }
            _ => {}
        }
    }

    /// The finished line. `final_usage` is what the stream had counted when it ended; `ending` is complete, aborted or failed.
    pub(crate) fn line(&self, final_usage: &Value, ending: &str) -> Value {
        let total_ms = self.now();
        let first_piece = self.blocks.values().filter_map(|b| b.first_piece_ms).min();
        let last_piece = self.blocks.values().filter_map(|b| b.last_piece_ms).max();
        let output = final_usage["output"].as_u64().unwrap_or(0);
        // OTel names: time to first token, time per output token, whole request.
        let per_token = match (first_piece, last_piece) {
            (Some(first), Some(last)) if output > 1 => Some((last - first) as f64 / (output - 1) as f64),
            _ => None,
        };
        let blocks: Vec<Value> = self
            .blocks
            .iter()
            .map(|(index, b)| {
                json!({"index": index, "type": b.kind, "start_ms": b.start_ms, "first_piece_ms": b.first_piece_ms,
                       "last_piece_ms": b.last_piece_ms, "stop_ms": b.stop_ms, "pieces": b.pieces, "bursts_50ms": b.bursts})
            })
            .collect();
        json!({
            "type": "model_timing",
            "started_at": self.started_at,
            "request_sent_ms": 0,
            "response_headers_ms": self.headers_ms,
            "message_start_ms": self.message_start_ms,
            "first_block_ms": self.first_block_ms,
            "stop_ms": self.stop_ms,
            "gen_ai.server.time_to_first_token_ms": first_piece,
            "gen_ai.server.time_per_output_token_ms": per_token,
            "gen_ai.server.request.duration_ms": total_ms,
            "blocks": blocks,
            "usage_start": self.usage_start,
            "usage_end": self.usage_end,
            "usage_final": final_usage,
            "stop_reason": self.stop_reason,
            "ending": ending,
            "request_body_bytes": self.body_bytes,
            "tools_hash": self.tools_hash,
            "switches_on": self.switches,
        })
    }
}

/// Appends one event to `<run folder>/events.jsonl` the way the program's other own events are (`pi::append_completion_skip_event`); any failure is dropped.
pub(crate) fn append(run_folder: &Path, line: &Value) {
    let path = run_folder.join(FILE);
    let opened = crate::group_guard::as_run_bundle(|| crate::group_guard::open_append(run_folder, &path));
    if let Ok(mut file) = opened {
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(timing: &mut Timing, events: &[Value]) {
        for event in events {
            timing.event(event);
        }
    }

    #[test]
    fn only_the_exact_value_one_turns_it_on() {
        let on = |v: &'static str| enabled_from(|n| (n == "NEWSROOM_MODEL_TIMING_RECORD").then(|| v.to_string()));
        assert!(on("1"));
        for off in ["", "0", "true", "yes", "2", " 1"] {
            assert!(!on(off), "{off:?}");
        }
        assert!(!enabled_from(|_| None));
    }

    #[test]
    fn switches_are_listed_by_name_only_and_only_when_on() {
        let vars = vec![
            ("NEWSROOM_TOOL_ERROR_HINTS".to_string(), "1".to_string()),
            ("NEWSROOM_DEFAULT_RESULT_BUDGET".to_string(), "1".to_string()),
            ("NEWSROOM_MODEL_TIMING_RECORD".to_string(), "0".to_string()),
            ("NEWSROOM_ONE_NUMBERING".to_string(), "sk-secret-value".to_string()),
            ("HOME".to_string(), "1".to_string()),
        ];
        assert_eq!(switches_on(vars.into_iter()), vec!["NEWSROOM_DEFAULT_RESULT_BUDGET", "NEWSROOM_TOOL_ERROR_HINTS"]);
    }

    #[test]
    fn a_stream_gives_every_field_and_counts_pieces_and_bursts() {
        let body = json!({"model": "m", "stream": true, "tools": [{"name": "a"}], "messages": []});
        let mut timing = Timing::start(&body, vec!["NEWSROOM_TOOL_ERROR_HINTS".into()]);
        timing.headers_arrived();
        feed(
            &mut timing,
            &[
                json!({"type": "message_start", "message": {"usage": {"input_tokens": 7, "service_tier": "standard"}}}),
                json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "a"}}),
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "b"}}),
                json!({"type": "content_block_stop", "index": 0}),
                json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}),
                json!({"type": "message_stop"}),
            ],
        );
        let line = timing.line(&json!({"output": 3}), "complete");
        for key in [
            "started_at", "request_sent_ms", "response_headers_ms", "message_start_ms", "first_block_ms", "stop_ms",
            "gen_ai.server.time_to_first_token_ms", "gen_ai.server.request.duration_ms", "blocks", "usage_start", "usage_end",
            "usage_final", "stop_reason", "ending", "request_body_bytes", "tools_hash", "switches_on",
        ] {
            assert!(!line[key].is_null(), "{key} missing: {line}");
        }
        assert_eq!(line["stop_reason"], "end_turn");
        assert_eq!(line["usage_start"], json!({"input_tokens": 7}), "only counts are copied");
        assert_eq!(line["usage_end"], json!({"output_tokens": 3}));
        assert_eq!(line["blocks"][0]["pieces"], 2);
        assert_eq!(line["blocks"][0]["type"], "text");
        assert_eq!(line["switches_on"], json!(["NEWSROOM_TOOL_ERROR_HINTS"]));
        assert_eq!(line["tools_hash"].as_str().unwrap().len(), 64);
        assert_eq!(line["request_body_bytes"], serde_json::to_vec(&body).unwrap().len());
    }

    #[test]
    fn a_gap_over_fifty_milliseconds_starts_a_new_burst() {
        let mut timing = Timing::start(&json!({}), vec![]);
        feed(&mut timing, &[json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}})]);
        let delta = json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "x"}});
        timing.event(&delta);
        timing.event(&delta);
        std::thread::sleep(std::time::Duration::from_millis(80));
        timing.event(&delta);
        let block = &timing.line(&json!({}), "complete")["blocks"][0];
        assert_eq!((block["pieces"].as_u64(), block["bursts_50ms"].as_u64()), (Some(3), Some(2)));
    }

    #[test]
    fn the_line_carries_no_header_address_or_key() {
        let body = json!({"model": "m", "stream": true, "messages": [{"role": "user", "content": "hi"}]});
        let mut timing = Timing::start(&body, vec!["NEWSROOM_TOOL_ERROR_HINTS".into()]);
        timing.headers_arrived();
        timing.event(&json!({"type": "message_start", "message": {"usage": {"input_tokens": 1}, "id": "msg_secret_id"}}));
        let text = timing.line(&json!({"output": 1}), "complete").to_string().to_ascii_lowercase();
        for word in ["x-api-key", "authorization", "bearer", "http://", "https://", "msg_secret_id", "sk-"] {
            assert!(!text.contains(word), "{word} in {text}");
        }
    }

    #[test]
    fn the_file_gets_one_line_per_call_and_an_unwritable_folder_is_ignored() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &json!({"n": 1}));
        append(dir.path(), &json!({"n": 2}));
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert_eq!(text.lines().count(), 2);
        append(&dir.path().join("missing"), &json!({"n": 3}));
    }
}
