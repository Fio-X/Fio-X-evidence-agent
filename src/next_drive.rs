//! Offline driver of the next route's prepare_claims for one question bank question, with the real catalogue and the real
//! tool host and a stand-in model on files: every request is written to `<relay>/req-<n>.txt` (the prompt and the allowed
//! answer) and the run waits for `<relay>/ans-<n>.json` (the answer's arguments), which someone outside writes. Not a score:
//! the archive says `"reading": "standin"`. Writes `<out>/<q>.json` in the bench's claims format. With NEXT_DRIVE_PAGE=1 it
//! runs the whole first prompt (run_page) instead and prints where it stops and after how many seconds; NEXT_DRIVE_SWITCHES
//! (NAME=VALUE,..) adds the product's other NEWSROOM_ switches.
//!
//!     NEWS_CATALOG_DIR=<registry>/l5geo/catalog NEWS_CLASSIFY_REFS=<registry>/classify/refs NEXT_DRIVE_Q=q1 NEXT_DRIVE_QUESTION=<the question as asked> NEXT_DRIVE_RELAY=<dir> \
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
            // Images of the request go next to it, base64 as sent (img-<n>-<k>.b64; `base64 -D` makes the picture), for the stand-in.
            let images: Vec<&Value> = history.iter().rev().find(|m| m["role"] == "user").and_then(|m| m["content"].as_array())
                .into_iter().flatten().filter(|b| b["type"] == "image").collect();
            for (k, image) in images.iter().enumerate() {
                let path = self.relay.join(format!("img-{}-{}.b64", self.n, k + 1));
                std::fs::write(&path, image["data"].as_str().unwrap_or("")).unwrap();
                prompt.push_str(&format!("\n[attached image {} ({})]", k + 1, image["mimeType"].as_str().unwrap_or("image")));
            }
            let schema = serde_json::to_string_pretty(&tools[0].parameters).unwrap();
            std::fs::write(
                self.relay.join(format!("req-{}.txt", self.n)),
                format!("{prompt}\n\nAnswer with one JSON object that matches this schema, and nothing else:\n{schema}\n"),
            )
            .unwrap();
            let answer = self.relay.join(format!("ans-{}.json", self.n));
            // NEXT_DRIVE_NO_WAIT=1: the relay holds an archive, so a missing answer (or a refused one, whose retry is missing) stops
            // the run at once instead of waiting for someone to write it.
            if std::env::var("NEXT_DRIVE_NO_WAIT").is_ok_and(|v| v == "1") && !answer.exists() {
                panic!("the stand-in archive lacks ans-{} (req-{} is written)", self.n, self.n);
            }
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
        // As `news investigate` does: the run's config/ (the editorial grammar registry the page plan reads) is written into it.
        crate::runtime::materialize_extension(&run).unwrap();
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
        // The product's other switches (news-next sets them), as NAME=VALUE,NAME=VALUE: the design pack needs its chain tools.
        for pair in std::env::var("NEXT_DRIVE_SWITCHES").unwrap_or_default().split(',').filter(|p| !p.is_empty()) {
            if let Some((name, value)) = pair.split_once('=').filter(|(name, _)| name.starts_with("NEWSROOM_")) {
                env.push((name.into(), value.into()));
            }
        }
        // NEXT_DRIVE_FETCH_FROM=<a finished run>: every fetch is answered from that run's downloads, nothing from the network
        // (scripts/drive_local_fetch.mjs; NEXT_DRIVE_FETCH_LOG lists each URL as local or missing).
        if let Ok(from) = std::env::var("NEXT_DRIVE_FETCH_FROM") {
            env.retain(|(name, _)| name != "NODE_OPTIONS");
            env.push(("NODE_OPTIONS".into(), format!("--import={}", repo.join("scripts/drive_local_fetch.mjs").display())));
            env.push(("NEXT_DRIVE_FETCH_FROM".into(), from));
            env.push(("NEXT_DRIVE_FETCH_LOG".into(), out.join("fetch.log").display().to_string()));
        }
        let page = std::env::var("NEXT_DRIVE_PAGE").is_ok_and(|v| v == "1");
        let mut allowed = vec!["newsroom_data_prepare".to_string()];
        if page {
            allowed.push(crate::next_run::DESIGN_PACK_TOOL.to_string());
            allowed.push(crate::next_run::VISION_CRITIC_TOOL.to_string());
        }
        let mut tools = ToolHost::start("node", &repo.join("runtime/pi"), &repo, &run, &allowed, env)
            .await
            .unwrap()
            .with_staging(&run);
        let mut model = FileAsker { relay, n: 0, answers: Vec::new() };
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
        if page {
            let result = crate::next_run::run_page(&mut recorder, &mut model, &mut tools, &question, &[], &catalogue, &cancel).await;
            let stopped = match &result {
                Err(stop) => stop.to_string(),
                Ok(answer) => format!("answered: {answer}"),
            };
            println!("{}", json!({"q": q, "page": stopped, "seconds": started.elapsed().as_secs_f64(), "asks": model.n}));
            drop(recorder);
            std::fs::write(run.join("events.jsonl"), events.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
            return;
        }
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
