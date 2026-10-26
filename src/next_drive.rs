//! Offline driver of the next route's prepare_claims for one question bank question, with the real catalogue and the real
//! tool host and a stand-in model on files: every request is written to `<relay>/req-<n>.txt` (the prompt and the allowed
//! answer) and the run waits for `<relay>/ans-<n>.json` (the answer's arguments), which someone outside writes. Not a score:
//! the archive says `"reading": "standin"`. Writes `<out>/<q>.json` in the bench's claims format.
//!
//!     NEWS_CATALOG_DIR=<registry>/l5geo/catalog NEXT_DRIVE_Q=q1 NEXT_DRIVE_QUESTION=<the question as asked> NEXT_DRIVE_RELAY=<dir> \
//!     NEXT_DRIVE_OUT=<dir> NEXT_DRIVE_RUN=<dir> cargo test --bin news next_drive -- --include-ignored --nocapture

// A test module of its own, so the raw-write check (group_guard) reads it as test code: it writes only the relay and the archive.
#[cfg(test)]
mod drive {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    use async_trait::async_trait;
    use serde_json::{json, Value};

    use crate::anthropic_model::ToolDef;
    use crate::next_flow::{
        prepare_claims, Asker, GroupCatalogue, ModelRoute, Need, Recorder, CATALOGUE_EVENT, CHOOSE_TOOL, LEGACY_SWITCHES, NEXT_ENV, PARAMS_EVENT,
    };
    use crate::tool_host::{whitelisted_env, ToolHost};

    /// How long one stand-in answer may take.
    const ANSWER_WAIT: Duration = Duration::from_secs(900);

    struct FileAsker {
        relay: PathBuf,
        n: usize,
        /// (step, answer arguments) in order, for the archive.
        answers: Vec<(String, Value)>,
    }

    #[async_trait]
    impl Asker for FileAsker {
        fn route(&self) -> ModelRoute {
            ModelRoute::Standin
        }

        async fn ask(&mut self, history: &[Value], tools: &[ToolDef], _cancel: &AtomicBool) -> Option<Value> {
            self.n += 1;
            let text = |m: &Value| {
                m["content"].as_array().map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"))
            };
            let mut prompt = history.iter().rev().find(|m| m["role"] == "user").and_then(text).unwrap_or_default();
            // A refused answer: the step's prompt again with what the program sent back.
            if let Some(refusal) = history.last().filter(|m| m["role"] == "toolResult" && m["isError"] == true).and_then(text) {
                prompt.push_str(&format!("\n\nYour previous answer was refused: {refusal}"));
            }
            let schema = serde_json::to_string_pretty(&tools[0].parameters).unwrap();
            std::fs::write(
                self.relay.join(format!("req-{}.txt", self.n)),
                format!("{prompt}\n\nAnswer with one JSON object that matches this schema, and nothing else:\n{schema}\n"),
            )
            .unwrap();
            let answer = self.relay.join(format!("ans-{}.json", self.n));
            let started = Instant::now();
            let args: Value = loop {
                if let Some(v) = std::fs::read_to_string(&answer).ok().and_then(|t| serde_json::from_str(&t).ok()) {
                    break v;
                }
                if started.elapsed() > ANSWER_WAIT {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            };
            self.answers.push((args["step"].as_str().unwrap_or("").to_string(), args.clone()));
            Some(json!({"content": [{"type": "toolCall", "id": format!("standin-{}", self.n), "name": CHOOSE_TOOL, "arguments": args}],
                "stopReason": "toolUse", "usage": {}}))
        }
    }

    fn var(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
    }

    /// The candidate texts of one sheet, by candidate id.
    fn sheet_texts(run: &Path, key: &str) -> Vec<(String, String)> {
        let sheet: Value = std::fs::read_to_string(run.join(format!("shadow/candidate_sheet-{key}.json")))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        sheet["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| (c["id"].as_str().unwrap_or("").to_string(), c["text"].as_str().unwrap_or("").to_string()))
            .collect()
    }

    #[tokio::test]
    #[ignore]
    async fn drive_one_question_with_a_standin_on_files() {
        let (q, question) = (var("NEXT_DRIVE_Q"), var("NEXT_DRIVE_QUESTION"));
        let (relay, out, run) = (PathBuf::from(var("NEXT_DRIVE_RELAY")), PathBuf::from(var("NEXT_DRIVE_OUT")), PathBuf::from(var("NEXT_DRIVE_RUN")));
        for dir in [&relay, &out, &run] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // The command the route runs under in the product (`news investigate`, group agent), as main says it with enter_command.
        let _command = crate::group_guard::command_for_test("investigate");
        let started = Instant::now();
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut env = whitelisted_env(std::env::vars());
        env.retain(|(name, _)| !name.starts_with("NEWSROOM_"));
        // The route's older switches as the route needs them (newsroom_data_prepare exists only with NEWSROOM_DATA_PREPARE=1).
        for (name, need) in LEGACY_SWITCHES {
            if let Need::Exactly(value) = need {
                env.push((name.into(), value.into()));
            }
        }
        // The route's own switch: the runtime's new-route providers (World Bank) exist only with it.
        env.push((NEXT_ENV.into(), "1".into()));
        env.push(("NEWSROOM_TOOL_PROFILE".into(), "full".into()));
        env.push(("NEWSROOM_PHASE".into(), "all".into()));
        env.push(("NEWSROOM_ARTIFACT_DIR".into(), run.display().to_string()));
        let mut tools = ToolHost::start("node", &repo.join("runtime/pi"), &repo, &run, &["newsroom_data_prepare".to_string()], env)
            .await
            .unwrap()
            .with_staging(&run);
        let mut model = FileAsker { relay, n: 0, answers: Vec::new() };
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
        let result = prepare_claims(&mut recorder, &mut model, &mut tools, &question, &[], &catalogue, &cancel).await;
        drop(recorder);
        let offered: Vec<String> = events
            .iter()
            .find(|e| e["type"] == CATALOGUE_EVENT)
            .and_then(|e| e["event"]["ranking"]["candidates"].as_array().or(e["ranking"]["candidates"].as_array()))
            .into_iter()
            .flatten()
            .map(|c| c["id"].as_str().unwrap_or("").to_string())
            .collect();
        let picked: Vec<String> = model
            .answers
            .iter()
            .find(|(step, _)| step == "table")
            .and_then(|(_, a)| a["pick"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|n| n.as_u64().filter(|n| *n > 0).and_then(|n| offered.get(n as usize - 1)).cloned())
            .collect();
        let params = events.iter().find(|e| e["type"] == PARAMS_EVENT).cloned();
        let (stopped, claims) = match &result {
            Err(stop) => (json!(stop.to_string()), Vec::new()),
            Ok(prepared) => (
                Value::Null,
                prepared
                    .iter()
                    .zip(&picked)
                    .flat_map(|(p, table)| {
                        let texts = sheet_texts(&run, &p.sheet);
                        p.claims.iter().map(move |c| {
                            let id = c["candidate"].as_str().unwrap_or("");
                            let text = texts.iter().find(|(i, _)| i == id).map(|(_, t)| t.clone());
                            json!({"table": table, "text": text, "claim_id": c["claim_id"]})
                        }).collect::<Vec<_>>()
                    })
                    .collect(),
            ),
        };
        let archive = json!({"q": q, "reading": "standin", "picked_tables": picked, "stopped": stopped, "claims": claims,
            "seconds": started.elapsed().as_secs_f64().round(), "params": params, "answers": model.answers.iter().map(|(_, a)| a.clone()).collect::<Vec<_>>()});
        std::fs::write(out.join(format!("{q}.json")), serde_json::to_string_pretty(&archive).unwrap()).unwrap();
        std::fs::write(
            run.join("events.jsonl"),
            events.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n"),
        )
        .unwrap();
        println!("{}", serde_json::to_string(&json!({"q": q, "picked": archive["picked_tables"], "stopped": archive["stopped"], "claims": claims.len()})).unwrap());
    }
}
