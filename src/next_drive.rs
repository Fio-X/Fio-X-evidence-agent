//! Offline driver of the next route's prepare_claims for one question bank question, with the real catalogue and the real
//! tool host and a stand-in model on files: every request is written to `<relay>/req-<n>.txt` (the prompt and the allowed
//! answer) and the run waits for `<relay>/ans-<n>.json` (the answer's arguments), which someone outside writes. Not a score:
//! the archive says `"reading": "standin"`. Writes `<out>/<q>.json` in the bench's claims format. With NEXT_DRIVE_PAGE=1 it
//! runs the whole first prompt (run_page) instead and prints where it stops and after how many seconds; NEXT_DRIVE_SWITCHES
//! (NAME=VALUE,..) adds the product's other NEWSROOM_ switches. drive_one_question_from_gold runs the whole first prompt from a
//! question's gold file instead (its prepare steps, and a GoldAsker answering every ask from it) and stops at the first vision ask.
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
        parse_prepare_spec, prepare_claims, Asker, GroupCatalogue, ModelRoute, Need, PrepareStep,
        Recorder, CATALOGUE_EVENT, CHOOSE_TOOL, LEGACY_SWITCHES, NEXT_ENV, PARAMS_EVENT, TOOL_KEYS,
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

        async fn ask(
            &mut self,
            history: &[Value],
            tools: &[ToolDef],
            _cancel: &AtomicBool,
        ) -> Option<Value> {
            self.n += 1;
            let text = |m: &Value| {
                m["content"].as_array().map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            };
            let mut prompt = history
                .iter()
                .rev()
                .find(|m| m["role"] == "user")
                .and_then(text)
                .unwrap_or_default();
            // A refused answer: the step's prompt again with what the program sent back.
            if let Some(refusal) = history
                .last()
                .filter(|m| m["role"] == "toolResult" && m["isError"] == true)
                .and_then(text)
            {
                prompt.push_str(&format!("\n\nYour previous answer was refused: {refusal}"));
            }
            // Images of the request go next to it, base64 as sent (img-<n>-<k>.b64; `base64 -D` makes the picture), for the stand-in.
            let images: Vec<&Value> = history
                .iter()
                .rev()
                .find(|m| m["role"] == "user")
                .and_then(|m| m["content"].as_array())
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "image")
                .collect();
            for (k, image) in images.iter().enumerate() {
                let path = self.relay.join(format!("img-{}-{}.b64", self.n, k + 1));
                std::fs::write(&path, image["data"].as_str().unwrap_or("")).unwrap();
                prompt.push_str(&format!(
                    "\n[attached image {} ({})]",
                    k + 1,
                    image["mimeType"].as_str().unwrap_or("image")
                ));
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
                panic!(
                    "the stand-in archive lacks ans-{} (req-{} is written)",
                    self.n, self.n
                );
            }
            let started = Instant::now();
            let args: Value = loop {
                if let Some(v) = std::fs::read_to_string(&answer)
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                {
                    break v;
                }
                if started.elapsed() > ANSWER_WAIT {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            };
            self.answers.push((
                args["step"].as_str().unwrap_or("").to_string(),
                args.clone(),
            ));
            Some(
                json!({"content": [{"type": "toolCall", "id": format!("standin-{}", self.n), "name": CHOOSE_TOOL, "arguments": args}],
                "stopReason": "toolUse", "usage": {}}),
            )
        }
    }

    fn var(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
    }

    /// The candidate texts of one sheet, by candidate id.
    fn sheet_texts(run: &Path, key: &str) -> Vec<(String, String)> {
        let sheet: Value =
            std::fs::read_to_string(run.join(format!("shadow/candidate_sheet-{key}.json")))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(Value::Null);
        sheet["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                (
                    c["id"].as_str().unwrap_or("").to_string(),
                    c["text"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect()
    }

    #[tokio::test]
    #[ignore]
    async fn drive_one_question_with_a_standin_on_files() {
        let (q, question) = (var("NEXT_DRIVE_Q"), var("NEXT_DRIVE_QUESTION"));
        let (relay, out, run) = (
            PathBuf::from(var("NEXT_DRIVE_RELAY")),
            PathBuf::from(var("NEXT_DRIVE_OUT")),
            PathBuf::from(var("NEXT_DRIVE_RUN")),
        );
        for dir in [&relay, &out, &run] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // The command the route runs under in the product (`news investigate`, group agent), as main says it with enter_command.
        let _command = crate::group_guard::command_for_test("investigate");
        // As `news investigate` does: the run's config/ (the editorial grammar registry the page plan reads) is written into it.
        crate::runtime::materialize_extension(&run).unwrap();
        let started = Instant::now();
        // NEXT_DRIVE_FETCH_FROM also answers each held-series probe from that run (none saved: unprobed), never the network.
        let catalogue = GroupCatalogue::from_env(|key| {
            std::env::var(key).ok().or_else(|| {
                (key == crate::next_flow::HELD_FROM_ENV)
                    .then(|| std::env::var("NEXT_DRIVE_FETCH_FROM").ok())
                    .flatten()
            })
        })
        .unwrap();
        let page = std::env::var("NEXT_DRIVE_PAGE").is_ok_and(|v| v == "1");
        let mut tools = start_tools(&run, &out).await;
        let mut model = FileAsker {
            relay,
            n: 0,
            answers: Vec::new(),
        };
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
        if page {
            let result = crate::next_run::run_page(
                &mut recorder,
                &mut model,
                &mut tools,
                &question,
                &[],
                &catalogue,
                &cancel,
            )
            .await;
            let stopped = match &result {
                Err(stop) => stop.to_string(),
                Ok(answer) => format!("answered: {answer}"),
            };
            println!(
                "{}",
                json!({"q": q, "page": stopped, "seconds": started.elapsed().as_secs_f64(), "asks": model.n})
            );
            drop(recorder);
            std::fs::write(
                run.join("events.jsonl"),
                events
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            return;
        }
        let result = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            &question,
            &[],
            &catalogue,
            &cancel,
        )
        .await;
        drop(recorder);
        let offered: Vec<String> = events
            .iter()
            .find(|e| e["type"] == CATALOGUE_EVENT)
            .and_then(|e| {
                e["event"]["ranking"]["candidates"]
                    .as_array()
                    .or(e["ranking"]["candidates"].as_array())
            })
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
            .filter_map(|n| {
                n.as_u64()
                    .filter(|n| *n > 0)
                    .and_then(|n| offered.get(n as usize - 1))
                    .cloned()
            })
            .collect();
        let params = events.iter().find(|e| e["type"] == PARAMS_EVENT).cloned();
        let (stopped, claims) =
            match &result {
                Err(stop) => (json!(stop.to_string()), Vec::new()),
                Ok(prepared) => {
                    (
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
                    )
                }
            };
        let archive = json!({"q": q, "reading": "standin", "picked_tables": picked, "stopped": stopped, "claims": claims,
            "seconds": started.elapsed().as_secs_f64().round(), "params": params, "answers": model.answers.iter().map(|(_, a)| a.clone()).collect::<Vec<_>>()});
        std::fs::write(
            out.join(format!("{q}.json")),
            serde_json::to_string_pretty(&archive).unwrap(),
        )
        .unwrap();
        std::fs::write(
            run.join("events.jsonl"),
            events
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        println!("{}", serde_json::to_string(&json!({"q": q, "picked": archive["picked_tables"], "stopped": archive["stopped"], "claims": claims.len()})).unwrap());
    }

    /// The real tool host as `news investigate` starts it on the new route, writing into `run`, offering the knowledge group's
    /// fetch only (the page is drawn by the leaf children, not by a host tool). NEXT_DRIVE_FETCH_FROM answers every fetch from local files (fetch.log goes to `out`).
    async fn start_tools(run: &Path, out: &Path) -> ToolHost {
        start_tools_from(run, out, std::env::var("NEXT_DRIVE_FETCH_FROM").ok()).await
    }

    /// start_tools with the finished run every fetch is answered from given here (`from`), none: the network.
    async fn start_tools_from(run: &Path, out: &Path, from: Option<String>) -> ToolHost {
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
        // The product's other switches (news-next sets them), as NAME=VALUE,NAME=VALUE.
        for pair in std::env::var("NEXT_DRIVE_SWITCHES")
            .unwrap_or_default()
            .split(',')
            .filter(|p| !p.is_empty())
        {
            if let Some((name, value)) = pair
                .split_once('=')
                .filter(|(name, _)| name.starts_with("NEWSROOM_"))
            {
                env.push((name.into(), value.into()));
            }
        }
        // NEXT_DRIVE_FETCH_FROM=<a finished run>: every fetch is answered from that run's downloads, nothing from the network
        // (scripts/drive_local_fetch.mjs; NEXT_DRIVE_FETCH_LOG lists each URL as local or missing).
        if let Some(from) = from {
            env.retain(|(name, _)| name != "NODE_OPTIONS");
            env.push((
                "NODE_OPTIONS".into(),
                format!(
                    "--import={}",
                    repo.join("scripts/drive_local_fetch.mjs").display()
                ),
            ));
            env.push(("NEXT_DRIVE_FETCH_FROM".into(), from));
            env.push((
                "NEXT_DRIVE_FETCH_LOG".into(),
                out.join("fetch.log").display().to_string(),
            ));
        }
        let allowed = vec!["newsroom_data_prepare".to_string()];
        ToolHost::start("node", &repo.join("runtime/pi"), &repo, run, &allowed, env)
            .await
            .unwrap()
            .with_staging(run)
    }

    /// Answers every ask from a gold file (the stored correct inputs of one bank question, research/gold-1027 of the local docs),
    /// never from a model: search -> stage_a.search_en; table -> the number of the gold dataset in the listed tables; claims -> the
    /// listed candidates whose kinds are stage_c.picks, in that order (read from the run's candidate sheets by text), filled up to
    /// the least the ask takes with the next listed ones (`padded`); text -> no revision and stage_d.measure_zh for every name. It
    /// stops at the first vision ask, and at any ask the gold cannot answer, with no answer; `notes` says why. Not a score.
    struct GoldAsker {
        gold: Value,
        run: PathBuf,
        /// The steps asked, in order.
        asked: Vec<String>,
        /// Where the gold answer departs from the gold (a kind not offered) or cannot be given; the first is the row's failure.
        notes: Vec<String>,
        /// The claims added to reach the least the ask takes: the gold lists fewer kinds than that, which is no failure.
        padded: Vec<String>,
    }

    impl GoldAsker {
        /// The numbered lines `<n>. <rest>` of a prompt.
        fn numbered(prompt: &str) -> Vec<(u64, &str)> {
            prompt
                .lines()
                .filter_map(|line| {
                    line.split_once(". ")
                        .and_then(|(n, rest)| Some((n.trim().parse().ok()?, rest)))
                })
                .collect()
        }

        /// Candidate text -> kind, over every candidate sheet the run wrote.
        fn kinds(&self) -> Vec<(String, String)> {
            std::fs::read_dir(self.run.join("shadow"))
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("candidate_sheet-")
                })
                .filter_map(|e| {
                    std::fs::read_to_string(e.path())
                        .ok()
                        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                })
                .flat_map(|sheet| sheet["candidates"].as_array().cloned().unwrap_or_default())
                .map(|c| {
                    (
                        c["text"].as_str().unwrap_or("").to_string(),
                        c["kind"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect()
        }

        /// A string field of the gold, or a note that the gold lacks it.
        fn field(&mut self, step: &str, pointer: &str) -> Option<String> {
            let value = self
                .gold
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_string);
            if value.is_none() {
                self.notes
                    .push(format!("{step}: the gold has no {pointer}"));
            }
            value
        }

        fn answer(&mut self, step: &str, prompt: &str, schema: &Value) -> Option<Value> {
            match step {
                "search" => Some(
                    json!({"step": "search", "query": self.field(step, "/stage_a/search_en")?}),
                ),
                "table" => {
                    let dataset = self.field(step, "/stage_a/args/dataset")?;
                    let worldbank = self.gold["route"] == "worldbank";
                    let id = if worldbank {
                        format!("{dataset}@2")
                    } else {
                        dataset.to_string()
                    };
                    let Some((n, _)) = Self::numbered(prompt)
                        .into_iter()
                        .find(|(_, rest)| rest.ends_with(&format!("({id})")))
                    else {
                        self.notes
                            .push(format!("a: {id} is not in the listed tables"));
                        return None;
                    };
                    Some(json!({"step": "table", "pick": [n]}))
                }
                "claims" => {
                    let kinds = self.kinds();
                    let listed: Vec<(u64, &str)> = Self::numbered(prompt)
                        .into_iter()
                        .map(|(n, text)| {
                            (
                                n,
                                kinds
                                    .iter()
                                    .find(|(t, _)| t == text)
                                    .map_or("", |(_, k)| k.as_str()),
                            )
                        })
                        .collect();
                    let mut pick: Vec<u64> = Vec::new();
                    for kind in self.gold["stage_c"]["picks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        match listed.iter().find(|(n, k)| *k == kind && !pick.contains(n)) {
                            Some((n, _)) => pick.push(*n),
                            None => self
                                .notes
                                .push(format!("c: the kind {kind} is not offered")),
                        }
                    }
                    let least = schema["properties"]["pick"]["minItems"]
                        .as_u64()
                        .unwrap_or(0) as usize;
                    let padded: Vec<u64> = listed
                        .iter()
                        .map(|(n, _)| *n)
                        .filter(|n| !pick.contains(n))
                        .take(least.saturating_sub(pick.len()))
                        .collect();
                    if !padded.is_empty() {
                        self.padded
                            .push(format!("c: padded with {padded:?} to the least of {least}"));
                        pick.extend(padded);
                    }
                    Some(json!({"step": "claims", "pick": pick}))
                }
                "text" => {
                    let name = self.field(step, "/stage_d/measure_zh")?;
                    let slots = schema["properties"]["names"]["required"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    Some(json!({"step": "text", "text": {},
                        "names": slots.iter().filter_map(Value::as_str).map(|s| (s.to_string(), json!(name))).collect::<serde_json::Map<_, _>>()}))
                }
                // Where the gold run ends: reached, not a failure.
                "vision" => None,
                other => {
                    self.notes
                        .push(format!("{other}: the gold has no answer for this ask"));
                    None
                }
            }
        }
    }

    #[async_trait]
    impl Asker for GoldAsker {
        fn route(&self) -> ModelRoute {
            ModelRoute::Standin
        }

        async fn ask(
            &mut self,
            history: &[Value],
            tools: &[ToolDef],
            _cancel: &AtomicBool,
        ) -> Option<Value> {
            let schema = &tools[0].parameters;
            let step = schema["properties"]["step"]["enum"][0]
                .as_str()
                .unwrap_or("")
                .to_string();
            // A refused gold answer is not tried again: the refusal is the finding.
            if let Some(refusal) = history
                .last()
                .filter(|m| m["role"] == "toolResult" && m["isError"] == true)
            {
                let text: String = refusal["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b["text"].as_str())
                    .collect();
                self.notes.push(format!(
                    "{step}: the gold answer was refused: {}",
                    text.chars().take(300).collect::<String>()
                ));
                return None;
            }
            self.asked.push(step.clone());
            let prompt = history
                .iter()
                .rev()
                .find(|m| m["role"] == "user")
                .and_then(|m| m["content"].as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let args = self.answer(&step, &prompt, schema)?;
            Some(
                json!({"content": [{"type": "toolCall", "id": format!("gold-{}", self.asked.len()), "name": CHOOSE_TOOL, "arguments": args}],
                "stopReason": "toolUse", "usage": {}}),
            )
        }
    }

    /// The prepare steps a gold file gives (start from stage b): stage_a.args with the provider of `route`, and stage_c.narrowed
    /// cut to the tool's keys (its dataset and provider are the step's), through the spec parser the route reads specs with.
    fn gold_steps(gold: &Value) -> Vec<PrepareStep> {
        let mut step = gold["stage_a"]["args"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if let Some(provider) = gold["route"]
            .as_str()
            .filter(|r| ["eurostat", "worldbank"].contains(r))
        {
            step.entry("provider").or_insert_with(|| json!(provider));
        }
        if let Some(narrowed) = gold["stage_c"]["narrowed"].as_object() {
            let mut cut: serde_json::Map<String, Value> = narrowed
                .iter()
                .filter(|(k, _)| TOOL_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for key in ["provider", "dataset"] {
                if let Some(v) = step.get(key) {
                    cut.entry(key).or_insert_with(|| v.clone());
                }
            }
            step.insert("narrowed".into(), Value::Object(cut));
        }
        parse_prepare_spec(&json!([step]).to_string()).unwrap()
    }

    /// One bank question run from its gold file through the whole first prompt (run_page) with the real catalogue and tool host,
    /// the gold's prepare steps and a GoldAsker; prints one row (q, stage reached, first failure, seconds) for the bench's gold_k
    /// columns and writes `<out>/<q>-gold.json` and the run's events. Fetches go to NEXT_DRIVE_FETCH_FROM (a root drive_tsv_set.mjs
    /// built from the data side's downloads); NEXT_DRIVE_SWITCHES as above.
    ///
    ///     NEWS_CATALOG_DIR=.. NEWS_CLASSIFY_REFS=.. NEXT_DRIVE_GOLD=<gold-qN.json> NEXT_DRIVE_OUT=<dir> NEXT_DRIVE_RUN=<dir> \
    ///     NEXT_DRIVE_FETCH_FROM=<root> cargo test --bin news drive_one_question_from_gold -- --include-ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn drive_one_question_from_gold() {
        let gold: Value =
            serde_json::from_str(&std::fs::read_to_string(var("NEXT_DRIVE_GOLD")).unwrap())
                .unwrap();
        let q = gold["qid"].as_str().unwrap_or("").to_string();
        // An unanswerable question is not driven: its gold_k cells read n/a.
        if gold["answerable"] != true {
            println!("{q}\tn/a\tn/a\tn/a\tn/a");
            return;
        }
        let (out, run) = (
            PathBuf::from(var("NEXT_DRIVE_OUT")),
            PathBuf::from(var("NEXT_DRIVE_RUN")),
        );
        let (model, events, stopped, seconds) = walk_gold(gold, &out, &run).await;
        let reached = model.asked.last().cloned().unwrap_or_default();
        let failure = first_failure(&model.notes, &reached, &stopped);
        let row = json!({"q": q, "reading": "gold", "start": "b", "reached": reached, "first_failure": failure, "stopped": stopped,
            "notes": model.notes, "padded": model.padded, "asked": model.asked, "seconds": (seconds * 10.0).round() / 10.0});
        std::fs::write(
            out.join(format!("{q}-gold.json")),
            serde_json::to_string_pretty(&row).unwrap(),
        )
        .unwrap();
        std::fs::write(
            run.join("events.jsonl"),
            events
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        println!("{q}\tb\t{reached}\t{failure}\t{:.1}", seconds);
    }

    /// A gold file through the whole first prompt (run_page) in `run` with the real catalogue and tool host, the gold's prepare
    /// steps and a GoldAsker (fetch log in `out`): the asker as it ended, the run's events, where the run stopped and its seconds.
    async fn walk_gold(gold: Value, out: &Path, run: &Path) -> (GoldAsker, Vec<Value>, String, f64) {
        let question = gold["question"].as_str().unwrap_or("").to_string();
        for dir in [out, run] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let _command = crate::group_guard::command_for_test("investigate");
        crate::runtime::materialize_extension(run).unwrap();
        let started = Instant::now();
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let steps = gold_steps(&gold);
        let mut tools = start_tools(run, out).await;
        let mut model = GoldAsker {
            gold,
            run: run.to_path_buf(),
            asked: Vec::new(),
            notes: Vec::new(),
            padded: Vec::new(),
        };
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run, Vec::new(), Vec::new());
        let result = crate::next_run::run_page(
            &mut recorder,
            &mut model,
            &mut tools,
            &question,
            &steps,
            &catalogue,
            &cancel,
        )
        .await;
        drop(recorder);
        let stopped = match &result {
            Err(stop) => stop.to_string(),
            Ok(answer) => format!("answered: {answer}"),
        };
        (model, events, stopped, started.elapsed().as_secs_f64())
    }

    /// The q1 walk (the quick check's H2): q1's gold file through the whole first prompt as walk_gold runs it, the model a
    /// stub (GoldAsker, test code only: the product's signatures and switches are as they are), the run folder under
    /// CF_WALK_DIR (a tmpd.sh folder). Prints "Q1WALK ..." lines, the last one the reading: the asks reached, the leaf page
    /// published or where it stuck, the completion gate's gaps on it ("gate 0 gaps, vision pending" when none and the vision
    /// ask is reached), the seconds. A test reading, not a score: the stub gives no reply to the image review, which is
    /// advice only, so the page is published with its six questions unanswered; a page verifies on the program's page checks
    /// of its bytes (verify.rs verify_publications), never on that review.
    ///
    ///     NEWS_CATALOG_DIR=.. NEWS_CLASSIFY_REFS=.. Q1WALK_GOLD=<gold-q1.json> NEXT_DRIVE_FETCH_FROM=<a finished q1 run> \
    ///     CF_WALK_DIR=<tmpd folder> cargo test --bins q1_walk -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn q1_walk() {
        let gold: Value =
            serde_json::from_str(&std::fs::read_to_string(var("Q1WALK_GOLD")).unwrap()).unwrap();
        assert_eq!(gold["qid"], "q1", "Q1WALK_GOLD is not q1's gold file");
        let dir = PathBuf::from(var("CF_WALK_DIR"));
        let (model, events, stopped, seconds) = walk_gold(gold, &dir.join("out"), &dir.join("run")).await;
        // the run's events stay next to its pages, for the quick check to keep when the walk stops short
        let lines: Vec<String> = events.iter().map(Value::to_string).collect();
        std::fs::write(dir.join("run/events.jsonl"), lines.join("\n")).unwrap();
        let last = |kind: &str| events.iter().rev().find(|e| e["type"] == kind);
        let page = match last(crate::next_run::RING_EVENT) {
            Some(e) if e["published"].is_string() => format!("{} published", e["recipe"].as_str().unwrap_or("?")),
            Some(e) => format!("stuck {}", e["stuck"].as_str().unwrap_or("?")),
            None => "no page".to_string(),
        };
        let gaps: Vec<&str> = last(crate::next_run::LEAF_GATE_EVENT)
            .and_then(|e| e["gaps"].as_array())
            .map(|g| g.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        for note in &model.notes {
            println!("Q1WALK note {note}");
        }
        if let Some(why) = last(crate::next_run::RING_EVENT).and_then(|e| e["why"].as_str()) {
            println!("Q1WALK why {}", why.chars().take(600).collect::<String>());
        }
        for gap in &gaps {
            println!("Q1WALK gap {gap}");
        }
        // the program's page checks past the gate, each with what it measured
        for check in last(crate::next_run::PAGE_CHECKS_EVENT).and_then(|e| e["checks"].as_array()).into_iter().flatten() {
            println!("Q1WALK check {} passed {} measured {}", check["name"].as_str().unwrap_or("?"), check["passed"], check["measured"]);
        }
        // the gaps the flow recorded are the ones the completion check finds again from the written run; a page the ring
        // event says was published always has the flow's gate event, so the comparison cannot be skipped for it
        let gate_event = match last(crate::next_run::RING_EVENT).filter(|e| e["published"].is_string()) {
            Some(ring) => Some(last(crate::next_run::LEAF_GATE_EVENT).unwrap_or_else(|| {
                panic!(
                    "the {} page was published (RING_EVENT) but the flow recorded no LEAF_GATE_EVENT: the completion gate did not run on it",
                    ring["recipe"].as_str().unwrap_or("?")
                )
            })),
            None => last(crate::next_run::LEAF_GATE_EVENT),
        };
        if let Some(event) = gate_event {
            let recipe = event["recipe"].as_str().unwrap();
            let run = dir.join("run");
            let manifest: Value = serde_json::from_str(
                &std::fs::read_to_string(run.join(format!("publications/{recipe}/manifest.json"))).unwrap(),
            )
            .unwrap();
            let again = crate::next_gate::leaf_gate(&run, recipe, &manifest);
            assert_eq!(again.as_deref(), Some(&gaps.iter().map(|g| g.to_string()).collect::<Vec<_>>()[..]), "flow gaps != completion gaps");
        }
        println!("Q1WALK stopped {}", stopped.chars().take(300).collect::<String>());
        // the stub gives no reply to the image review (advice only, answered by a stand-in that sees the screenshot): a page
        // with no gap reads "vision pending"
        let gate = match last(crate::next_run::LEAF_GATE_EVENT) {
            Some(_) if gaps.is_empty() && model.asked.last().is_some_and(|s| s == "vision") => {
                "gate 0 gaps, vision pending".to_string()
            }
            Some(_) => format!("gate {} gap(s)", gaps.len()),
            None => "gate not reached".to_string(),
        };
        println!(
            "Q1WALK asked {} | {page} | {gate} | {seconds:.1} s | test reading, not a score",
            model.asked.join(",")
        );
    }

    /// The first departure from the gold, else where the run stopped; the GoldAsker's own stop at vision is none ("-").
    fn first_failure(notes: &[String], reached: &str, stopped: &str) -> String {
        match notes.first() {
            Some(note) => note.clone(),
            None if reached == "vision" => "-".into(),
            None => stopped.to_string(),
        }
    }

    #[test]
    fn gold_answers_come_from_the_gold_file() {
        let gold = json!({"qid": "q4", "route": "worldbank",
            "stage_a": {"search_en": "CO2 per capita", "args": {"provider": "worldbank", "dataset": "EN.X", "years": {"start": 2016, "end": 2024}}},
            "stage_c": {"picks": ["trend", "rank_top"], "narrowed": {"filters": [{"dimension": "country", "values": ["IND"]}], "rows": 72, "file": "data/q4.csv"}},
            "stage_d": {"measure_zh": "人均排放"}});
        let steps = gold_steps(&gold);
        let narrowed = steps[0].narrowed.as_ref().unwrap();
        assert_eq!(
            narrowed.keys().map(String::as_str).collect::<Vec<_>>(),
            ["dataset", "filters", "provider"]
        );
        assert_eq!(
            (&narrowed["dataset"], &steps[0].args["provider"]),
            (&json!("EN.X"), &json!("worldbank"))
        );

        let run = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(run.path().join("shadow")).unwrap();
        let sheet = json!({"kind": "candidate_sheet", "candidates": [{"id": "c1", "kind": "rank_top", "text": "A leads"},
            {"id": "c2", "kind": "trend", "text": "B rises"}, {"id": "c3", "kind": "change", "text": "C falls"}, {"id": "c4", "kind": "share", "text": "D"}]});
        std::fs::write(
            run.path()
                .join("shadow/candidate_sheet-0123456789abcdef.json"),
            sheet.to_string(),
        )
        .unwrap();
        let mut asker = GoldAsker {
            gold,
            run: run.path().to_path_buf(),
            asked: Vec::new(),
            notes: Vec::new(),
            padded: Vec::new(),
        };
        let table = asker.answer(
            "table",
            "Question: q\nTables:\n1. Other (EN.Y@2)\n2. CO2 (EN.X@2)",
            &Value::Null,
        );
        assert_eq!(table, Some(json!({"step": "table", "pick": [2]})));
        let schema =
            json!({"properties": {"pick": {"minItems": 3}, "names": {"required": ["s1", "s2"]}}});
        let claims = asker.answer(
            "claims",
            "Question: q\nTable 1 (EN.X@2):\n1. A leads\n2. B rises\n3. C falls\n4. D",
            &schema,
        );
        assert_eq!(claims, Some(json!({"step": "claims", "pick": [2, 1, 3]})));
        assert_eq!(asker.padded, ["c: padded with [3] to the least of 3"]);
        assert!(asker.notes.is_empty());
        // Padding alone is no failure, and neither is the stop at vision.
        assert_eq!(asker.answer("vision", "", &Value::Null), None);
        assert_eq!(
            first_failure(&asker.notes, "vision", "the model gave no reply to vision"),
            "-"
        );
        assert_eq!(
            first_failure(&asker.notes, "text", "the page step sheet stopped: x"),
            "the page step sheet stopped: x"
        );
        let text = asker.answer("text", "", &schema).unwrap();
        assert_eq!(text["names"], json!({"s1": "人均排放", "s2": "人均排放"}));
        assert_eq!(
            asker.answer("table", "1. Other (EN.Y@2)", &Value::Null),
            None
        );
        assert_eq!(
            asker.notes.last().unwrap(),
            "a: EN.X@2 is not in the listed tables"
        );
        asker.gold["stage_a"]
            .as_object_mut()
            .unwrap()
            .remove("search_en");
        assert_eq!(asker.answer("search", "", &Value::Null), None);
        assert_eq!(
            asker.notes.last().unwrap(),
            "search: the gold has no /stage_a/search_en"
        );
        assert_eq!(
            first_failure(&asker.notes, "vision", "x"),
            "a: EN.X@2 is not in the listed tables"
        );
    }

    /// The new route's page replay gate (P4a design section 6): every page of a frozen list of published stand-in runs is
    /// refilled from its run's own records and walked through the production path again, and its outcome (10 items) must
    /// equal, item for item after a fixed normalisation, the outcome of the same page before the change. The rule, the
    /// normalisation and the cases are the prototype's (outcome.py), carried over constant for constant; the cross-language
    /// fixture (scripts/fixtures/p4a/replay-norm.json) holds outcome.py's own normalisation of the q1 golden walks.
    mod replay {
        use std::collections::{BTreeMap, BTreeSet, VecDeque};
        use std::path::{Path, PathBuf};
        use std::sync::atomic::AtomicBool;

        use async_trait::async_trait;
        use serde_json::{json, Map, Value};

        use crate::anthropic_model::ToolDef;
        use crate::next_flow::{
            Asker, Catalogue, GroupCatalogue, ModelRoute, Prepared, Recorder, Stop, CATALOGUE_EVENT, CHOOSE_TOOL,
            COMPANION_EVENT, COMPOSITION_FETCH_EVENT, DATA_PREPARE_TOOL,
        };

        /// The frozen list's sha256 (11-01 15:49, design section 6): every later list is it with recorded swaps.
        const MANIFEST_SHA256: &str = "9ac9b0cd42fdb1e6b7c68ac2d61a963e141c95d7b55f83275da20f5e8e73bcbb";
        /// Never lowered: a re-freeze swaps a column page for a column page (user 11-01 21:41).
        const COLUMN_PAGES: usize = 14;
        const FIELDS: [&str; 5] = ["sha", "q", "recipe", "runs", "run"];
        const ITEMS: [&str; 10] = ["refill", "end", "facts", "text", "drawn", "ring", "gate", "checks", "layers", "page"];
        /// Sorted by their whole normalised value: sets, whatever order a run wrote them in.
        const SET_ITEMS: [&str; 2] = ["facts", "drawn"];
        const REFILL_REASONS: [&str; 4] =
            ["data file missing", "claims missing", "events missing", "ledger facts differ from request.json"];
        const FLOAT_SIG: usize = 12;
        const NUM_ATTRS: [&str; 21] = [
            "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "width", "height", "font-size",
            "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-dashoffset",
        ];
        const MULTI_ATTRS: [&str; 4] = ["d", "points", "transform", "viewbox"];
        const VOID: [&str; 13] = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
        const RING_KEEP: [&str; 6] = ["dropped", "r_used", "r_steps", "r_min_lifted", "r_min_codes", "ends"];
        /// The layer a column page's bars are drawn in: a column page counts only when its bars were compared.
        const BARS_LAYER: &str = "bars";

        /// The swap record's header: the line taken out, the line brought in, the sha256 of the BEFORE file whose first pass
        /// showed the page taken out failing, and why (that failure's sentence, word for word).
        fn swap_header() -> String {
            let mut h = vec!["# swaps".to_string()];
            h.extend(FIELDS.iter().map(|f| format!("out_{f}")));
            h.extend(FIELDS.iter().map(|f| format!("in_{f}")));
            h.extend(["before_sha256".to_string(), "why".to_string()]);
            h.join("\t")
        }

        // ------------------------------------------------------------ normalisation (N1-N4)

        /// A decimal: its sign, its digits without leading zeros (none for zero) and the power of ten of the last one.
        struct Dec {
            neg: bool,
            digits: Vec<u8>,
            exp: i64,
        }

        /// A decimal number token (-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?), whole; None for anything else.
        fn parse_dec(s: &str) -> Option<Dec> {
            let (neg, body) = match s.strip_prefix('-') {
                Some(rest) => (true, rest),
                None => (false, s),
            };
            let (mantissa, exp) = match body.find(['e', 'E']) {
                Some(at) => {
                    let e = &body[at + 1..];
                    let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
                    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                        return None;
                    }
                    (&body[..at], e.parse::<i64>().ok()?)
                }
                None => (body, 0),
            };
            let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            let ok = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
            if !ok(int) || !ok(frac) || (int.is_empty() && frac.is_empty()) {
                return None;
            }
            let mut digits: Vec<u8> = int.bytes().chain(frac.bytes()).map(|b| b - b'0').collect();
            let lead = digits.iter().take_while(|&&d| d == 0).count();
            digits.drain(..lead);
            Some(Dec { neg, digits, exp: exp - frac.len() as i64 })
        }

        /// The decimal printed as Python's format(d.normalize(), "f") does, and 0 for any zero.
        fn dec_text(mut d: Dec) -> String {
            while d.digits.last() == Some(&0) {
                d.digits.pop();
                d.exp += 1;
            }
            if d.digits.is_empty() {
                return "0".into();
            }
            let digits: String = d.digits.iter().map(|&x| char::from(b'0' + x)).collect();
            let body = if d.exp >= 0 {
                format!("{digits}{}", "0".repeat(d.exp as usize))
            } else {
                let point = digits.len() as i64 + d.exp;
                if point > 0 {
                    format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
                } else {
                    format!("0.{}{digits}", "0".repeat((-point) as usize))
                }
            };
            format!("{}{body}", if d.neg { "-" } else { "" })
        }

        /// Rounded to `sig` significant digits, half to even (Python's decimal context ROUND_HALF_EVEN).
        fn round_sig(mut d: Dec, sig: usize) -> Dec {
            if d.digits.len() <= sig {
                return d;
            }
            let rest = d.digits.split_off(sig);
            d.exp += rest.len() as i64;
            let tail = rest[1..].iter().any(|&x| x != 0);
            let up = rest[0] > 5 || (rest[0] == 5 && (tail || d.digits[sig - 1] % 2 == 1));
            if up {
                let mut i = sig;
                loop {
                    if i == 0 {
                        d.digits.insert(0, 1);
                        break;
                    }
                    i -= 1;
                    if d.digits[i] == 9 {
                        d.digits[i] = 0;
                    } else {
                        d.digits[i] += 1;
                        break;
                    }
                }
            }
            d
        }

        /// N2: a float rounded to FLOAT_SIG significant digits of its shortest repr, half to even, printed plain.
        fn canon_float(x: f64) -> String {
            if !x.is_finite() {
                return if x.is_nan() { "nan" } else if x > 0.0 { "inf" } else { "-inf" }.into();
            }
            let d = parse_dec(&format!("{x:e}")).expect("a finite float prints as a decimal");
            dec_text(round_sig(d, FLOAT_SIG))
        }

        /// N3: a number token rewritten as the same decimal, shortest: lossless, nothing rounded.
        fn num_token(t: &str) -> Option<String> {
            parse_dec(t).map(dec_text)
        }

        /// N1, N2, N4 on a json value: a text equal for two values exactly when their normalised values are equal (object
        /// keys sorted, an int as itself, a float by canon_float, the run's folder in a string as <RUN>).
        fn cj(v: &Value, run: Option<&str>) -> String {
            match v {
                Value::Null => "null".into(),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) => match (n.as_i64(), n.as_u64()) {
                    (Some(i), _) => i.to_string(),
                    (_, Some(u)) => u.to_string(),
                    _ => canon_float(n.as_f64().unwrap_or(f64::NAN)),
                },
                Value::String(s) => Value::String(match run {
                    Some(r) => s.replace(r, "<RUN>"),
                    None => s.clone(),
                })
                .to_string(),
                Value::Array(a) => format!("[{}]", a.iter().map(|x| cj(x, run)).collect::<Vec<_>>().join(",")),
                Value::Object(o) => {
                    let mut kv: Vec<(&String, &Value)> = o.iter().collect();
                    kv.sort_by(|a, b| a.0.cmp(b.0));
                    let kv: Vec<String> = kv.iter().map(|(k, x)| format!("{}:{}", Value::String((*k).clone()), cj(x, run))).collect();
                    format!("{{{}}}", kv.join(","))
                }
            }
        }

        /// Python's str.strip() whitespace.
        fn py_space(c: char) -> bool {
            c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
        }

        /// html.escape: & < > always, " and ' with `quote`.
        fn escape(s: &str, quote: bool) -> String {
            let mut o = String::with_capacity(s.len());
            for c in s.chars() {
                match c {
                    '&' => o.push_str("&amp;"),
                    '<' => o.push_str("&lt;"),
                    '>' => o.push_str("&gt;"),
                    '"' if quote => o.push_str("&quot;"),
                    '\'' if quote => o.push_str("&#x27;"),
                    _ => o.push(c),
                }
            }
            o
        }

        /// Character references decoded: numeric ones and the named ones a page of ours can hold; others stay as written.
        fn unescape(s: &str) -> String {
            if !s.contains('&') {
                return s.to_string();
            }
            let mut o = String::with_capacity(s.len());
            let mut rest = s;
            while let Some(at) = rest.find('&') {
                o.push_str(&rest[..at]);
                rest = &rest[at..];
                let end = rest.find(';').filter(|&e| e <= 12);
                let decoded = end.and_then(|e| {
                    let name = &rest[1..e];
                    let c = match name {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        "nbsp" => Some('\u{a0}'),
                        _ => match name.strip_prefix('#') {
                            Some(n) => match n.strip_prefix(['x', 'X']) {
                                Some(h) => u32::from_str_radix(h, 16).ok(),
                                None => n.parse::<u32>().ok(),
                            }
                            .and_then(char::from_u32),
                            None => None,
                        },
                    };
                    c.map(|c| (c, e))
                });
                match decoded {
                    Some((c, e)) => {
                        o.push(c);
                        rest = &rest[e + 1..];
                    }
                    None => {
                        o.push('&');
                        rest = &rest[1..];
                    }
                }
            }
            o.push_str(rest);
            o
        }

        /// One element's attributes in normal form: names sorted, numbers rewritten (NUM_ATTRS whole, MULTI_ATTRS each).
        fn attrs_text(attrs: &[(String, Option<String>)]) -> String {
            let mut sorted: Vec<&(String, Option<String>)> = attrs.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut o = String::new();
            for (k, v) in sorted {
                let v = v.clone().unwrap_or_default();
                let v = if NUM_ATTRS.contains(&k.as_str()) {
                    num_token(v.trim_matches(py_space)).unwrap_or(v)
                } else if MULTI_ATTRS.contains(&k.as_str()) {
                    numbers_in(&v)
                } else {
                    v
                };
                o.push_str(&format!(" {k}=\"{}\"", escape(&v, true)));
            }
            o
        }

        /// Every number token in a text rewritten by num_token (re.sub over -?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?).
        fn numbers_in(v: &str) -> String {
            let b = v.as_bytes();
            let mut o = String::new();
            let mut i = 0;
            let digit = |i: usize| i < b.len() && b[i].is_ascii_digit();
            while i < b.len() {
                let start = i;
                let mut j = i;
                if b[j] == b'-' {
                    j += 1;
                }
                let m = if digit(j) {
                    while digit(j) {
                        j += 1;
                    }
                    if j < b.len() && b[j] == b'.' {
                        j += 1;
                        while digit(j) {
                            j += 1;
                        }
                    }
                    Some(j)
                } else if j < b.len() && b[j] == b'.' && digit(j + 1) {
                    j += 1;
                    while digit(j) {
                        j += 1;
                    }
                    Some(j)
                } else {
                    None
                };
                match m {
                    Some(mut j) => {
                        if j < b.len() && (b[j] == b'e' || b[j] == b'E') {
                            let mut k = j + 1;
                            if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
                                k += 1;
                            }
                            if digit(k) {
                                while digit(k) {
                                    k += 1;
                                }
                                j = k;
                            }
                        }
                        o.push_str(&num_token(&v[start..j]).unwrap_or_else(|| v[start..j].to_string()));
                        i = j;
                    }
                    None => {
                        let c = v[i..].chars().next().expect("inside the text");
                        o.push(c);
                        i += c.len_utf8();
                    }
                }
            }
            o
        }

        /// N3: a page serialised again in normal form (as outcome.py's Canon on Python's HTMLParser), its data-layer subtrees
        /// and its visible texts collected.
        #[derive(Default)]
        struct Canon {
            out: Vec<String>,
            layers: Vec<(usize, String, String)>,
            text: Vec<String>,
            open: Vec<(String, Vec<String>, usize, usize)>,
            stack: Vec<String>,
            skip: usize,
        }

        impl Canon {
            fn emit(&mut self, t: String) {
                for lay in &mut self.open {
                    lay.1.push(t.clone());
                }
                self.out.push(t);
            }

            fn start(&mut self, tag: &str, attrs: &[(String, Option<String>)]) {
                self.emit(format!("<{tag}{}>", attrs_text(attrs)));
                if VOID.contains(&tag) {
                    return;
                }
                let layer = attrs.iter().rev().find(|(k, _)| k == "data-layer").and_then(|(_, v)| v.clone());
                if let Some(layer) = layer {
                    let first = self.out.last().cloned().unwrap_or_default();
                    self.open.push((layer, vec![first], self.stack.len(), self.out.len() - 1));
                }
                self.stack.push(tag.to_string());
                if ["style", "script", "head"].contains(&tag) {
                    self.skip += 1;
                }
            }

            fn end(&mut self, tag: &str) {
                if VOID.contains(&tag) {
                    return;
                }
                self.emit(format!("</{tag}>"));
                if self.stack.iter().any(|t| t == tag) {
                    while let Some(t) = self.stack.pop() {
                        if ["style", "script", "head"].contains(&t.as_str()) {
                            self.skip -= 1;
                        }
                        while self.open.last().is_some_and(|l| l.2 == self.stack.len()) {
                            let (name, parts, _, at) = self.open.pop().expect("an open layer");
                            self.layers.push((at, name, parts.concat()));
                        }
                        if t == tag {
                            break;
                        }
                    }
                }
            }

            fn data(&mut self, d: &str) {
                self.emit(escape(d, false));
                let t = d.trim_matches(py_space);
                if self.skip == 0 && !t.is_empty() {
                    self.text.push(t.to_string());
                }
            }
        }

        /// The parts of a start tag after its name: attributes (names lowercased, values unquoted and decoded) and whether
        /// it closes itself.
        fn tag_attrs(inner: &str) -> (Vec<(String, Option<String>)>, bool) {
            let b = inner.as_bytes();
            let mut attrs = Vec::new();
            let mut i = 0;
            let space = |c: u8| c.is_ascii_whitespace();
            let mut closes = false;
            while i < b.len() {
                while i < b.len() && (space(b[i]) || (b[i] == b'/' && i + 1 < b.len())) {
                    i += 1;
                }
                if i >= b.len() {
                    break;
                }
                if b[i] == b'/' {
                    closes = true;
                    break;
                }
                let n0 = i;
                while i < b.len() && !space(b[i]) && b[i] != b'=' && b[i] != b'/' {
                    i += 1;
                }
                let name = inner[n0..i].to_lowercase();
                let mut j = i;
                while j < b.len() && space(b[j]) {
                    j += 1;
                }
                if j < b.len() && b[j] == b'=' {
                    j += 1;
                    while j < b.len() && space(b[j]) {
                        j += 1;
                    }
                    let value = if j < b.len() && (b[j] == b'"' || b[j] == b'\'') {
                        let q = b[j];
                        let e = inner[j + 1..].find(char::from(q)).map_or(b.len(), |e| j + 1 + e);
                        let v = &inner[j + 1..e];
                        i = (e + 1).min(b.len());
                        v
                    } else {
                        let e = inner[j..].find(|c: char| c.is_ascii_whitespace()).map_or(b.len(), |e| j + e);
                        let v = &inner[j..e];
                        i = e;
                        v
                    };
                    attrs.push((name, Some(unescape(value))));
                } else {
                    attrs.push((name, None));
                }
            }
            (attrs, closes)
        }

        /// The normal form of a page: its visible texts in order, its data-layer subtrees by where each starts, the page.
        struct CanonHtml {
            text: Vec<String>,
            layers: Vec<(String, String)>,
            page: String,
        }

        fn canon_html(page: &str) -> CanonHtml {
            let mut c = Canon::default();
            let lower = page.to_ascii_lowercase();
            let mut i = 0;
            let n = page.len();
            while i < n {
                let raw_elem = c.stack.last().filter(|t| *t == "script" || *t == "style").cloned();
                if let Some(elem) = raw_elem {
                    // raw text up to its own end tag, not decoded
                    let close = format!("</{elem}");
                    let j = lower[i..].find(&close).map_or(n, |j| i + j);
                    if j > i {
                        c.data(&page[i..j]);
                    }
                    i = j;
                    if i >= n {
                        break;
                    }
                    let gt = page[i..].find('>').map_or(n, |g| i + g);
                    c.end(&elem);
                    i = gt + 1;
                    continue;
                }
                let j = page[i..].find('<').map_or(n, |j| i + j);
                if j > i {
                    c.data(&unescape(&page[i..j]));
                    i = j;
                    continue;
                }
                let rest = &page[i..];
                if let Some(body) = rest.strip_prefix("<!--") {
                    let e = body.find("-->").unwrap_or(body.len());
                    c.emit(format!("<!--{}-->", &body[..e]));
                    i += 4 + e + 3;
                } else if let Some(body) = rest.strip_prefix("</") {
                    let gt = body.find('>').unwrap_or(body.len());
                    let name: String = body[..gt].split(|ch: char| ch.is_ascii_whitespace() || ch == '/').next().unwrap_or("").to_lowercase();
                    c.end(&name);
                    i += 2 + gt + 1;
                } else if let Some(body) = rest.strip_prefix("<!") {
                    let gt = body.find('>').unwrap_or(body.len());
                    c.emit(format!("<!{}>", &body[..gt]));
                    i += 2 + gt + 1;
                } else if rest.starts_with("<?") {
                    i += rest.find('>').map_or(rest.len(), |g| g + 1);
                } else if rest.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic) {
                    let gt = tag_end(rest);
                    let inner = &rest[1..gt];
                    let name_end = inner.find(|ch: char| ch.is_ascii_whitespace() || ch == '/' || ch == '>').unwrap_or(inner.len());
                    let tag = inner[..name_end].to_lowercase();
                    let (attrs, closes) = tag_attrs(&inner[name_end..]);
                    c.start(&tag, &attrs);
                    if closes {
                        c.end(&tag);
                    }
                    i += gt + 1;
                } else {
                    c.data("<");
                    i += 1;
                }
            }
            // close(): what is still open stays open, as the parser leaves it
            let mut layers = c.layers;
            layers.sort();
            CanonHtml { text: c.text, layers: layers.into_iter().map(|(_, n, s)| (n, s)).collect(), page: c.out.concat() }
        }

        /// Where a start tag ends: its '>' outside quoted attribute values.
        fn tag_end(rest: &str) -> usize {
            let mut quote = None;
            for (k, ch) in rest.char_indices().skip(1) {
                match (quote, ch) {
                    (None, '"' | '\'') => quote = Some(ch),
                    (Some(q), c) if c == q => quote = None,
                    (None, '>') => return k,
                    _ => {}
                }
            }
            rest.len() - 1
        }

        /// One page's outcome record normalised: each item's normal text, or None when the record has none.
        fn normalise(rec: &Value) -> BTreeMap<&'static str, Option<String>> {
            let run = rec["run"].as_str().filter(|r| !r.is_empty());
            let mut out = BTreeMap::new();
            for item in ITEMS {
                if ["text", "layers", "page"].contains(&item) {
                    continue;
                }
                let v = rec.get(item).filter(|v| !v.is_null());
                out.insert(
                    item,
                    v.map(|v| {
                        if SET_ITEMS.contains(&item) {
                            let mut all: Vec<String> = v.as_array().into_iter().flatten().map(|x| cj(x, run)).collect();
                            all.sort();
                            format!("[{}]", all.join(","))
                        } else {
                            cj(v, run)
                        }
                    }),
                );
            }
            let html = rec["html"].as_str().map(|h| match run {
                Some(r) => canon_html(&h.replace(r, "<RUN>")),
                None => canon_html(h),
            });
            out.insert("text", html.as_ref().map(|h| json!(h.text).to_string()));
            out.insert("layers", html.as_ref().map(|h| json!(h.layers).to_string()));
            out.insert("page", html.map(|h| h.page));
            out
        }

        /// The items whose normalised values differ between two records of one page, in ITEMS order.
        fn differs(a: &Value, b: &Value) -> Vec<&'static str> {
            let (na, nb) = (normalise(a), normalise(b));
            ITEMS.into_iter().filter(|i| na[i] != nb[i]).collect()
        }

        // ------------------------------------------------------------ the list and the judge

        /// One line of the list: sha16, question, recipe, how many runs published it, its run folder under the local docs.
        #[derive(Clone, Debug, PartialEq)]
        struct Page {
            sha: String,
            q: String,
            recipe: String,
            runs: String,
            run: String,
        }

        impl Page {
            fn of(fields: &[&str]) -> Page {
                let f = |i: usize| fields.get(i).copied().unwrap_or("").to_string();
                Page { sha: f(0), q: f(1), recipe: f(2), runs: f(3), run: f(4) }
            }
            fn line(&self) -> String {
                [&self.sha, &self.q, &self.recipe, &self.runs, &self.run].map(String::as_str).join("\t")
            }
        }

        /// What the judge reads: the list's bytes and the swap record's (none: not given or not readable), the frozen list's
        /// sha256, the local docs the run folders are under, and the folder the BEFORE files a swap names are kept in.
        struct Inputs {
            manifest: Option<Vec<u8>>,
            swaps: Option<Vec<u8>>,
            frozen: String,
            docs: PathBuf,
            beside: PathBuf,
        }

        impl Inputs {
            /// The gate's: the list at `manifest`, replay-swaps.tsv beside it, the local docs three folders up from it (the
            /// list lives in works/<design>/<plan>/ of them), BEFORE files beside it.
            fn beside(manifest: Option<&Path>) -> Inputs {
                let dir = manifest.and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
                let docs = dir.ancestors().nth(3).map(Path::to_path_buf).unwrap_or_default();
                Inputs {
                    manifest: manifest.and_then(|m| std::fs::read(m).ok()),
                    swaps: std::fs::read(dir.join("replay-swaps.tsv")).ok(),
                    frozen: MANIFEST_SHA256.into(),
                    docs,
                    beside: dir,
                }
            }
        }

        fn sha256(bytes: &[u8]) -> String {
            crate::hash::sha256_bytes(bytes)
        }

        /// The file beside the list whose sha256 is `sha`, read as json.
        fn before_file(beside: &Path, sha: &str) -> Option<Value> {
            let entries = std::fs::read_dir(beside).ok()?;
            entries.flatten().filter(|e| e.path().is_file()).find_map(|e| {
                let bytes = std::fs::read(e.path()).ok()?;
                (sha256(&bytes) == sha).then(|| serde_json::from_slice(&bytes).ok()).flatten()
            })
        }

        /// Why a column page of a BEFORE first pass does not count, in the words a swap must give: it did not refill, it
        /// refilled and stopped before publishing, or it published with no bars layer. None: it refilled and published its bars.
        fn column_failure(rec: &Value) -> Option<String> {
            let refill = rec["refill"].as_str().unwrap_or("");
            if refill != "ok" {
                return Some(format!("not refilled: {refill}"));
            }
            if rec["end"] != json!({"published": true}) {
                return Some(format!(
                    "refilled, not published: stopped at {}: {}",
                    rec["end"]["stop"].as_str().unwrap_or("?"),
                    rec["end"]["why"].as_str().unwrap_or("")
                ));
            }
            let html = rec["html"].as_str().unwrap_or("");
            if !canon_html(html).layers.iter().any(|(name, _)| name == BARS_LAYER) {
                return Some("published with no bars layer".into());
            }
            None
        }

        /// The list judged with its swap record: Ok is its pages and its sha256, Err why it is refused.
        fn read_manifest(inputs: &Inputs) -> Result<(Vec<Page>, String), String> {
            let raw = inputs.manifest.as_ref().ok_or("no manifest (NEXT_TREE_REPLAY_RUNS not given or not readable)")?;
            let sraw = inputs.swaps.as_ref().ok_or("no swap record beside the manifest (replay-swaps.tsv)")?;
            let text = String::from_utf8(raw.clone()).map_err(|_| "manifest is not utf-8")?;
            let lines: Vec<&str> = text.split('\n').collect();
            let head: Vec<&str> = lines[0].split(' ').collect();
            let count = |at: usize| {
                head.get(at).filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).and_then(|n| n.parse::<usize>().ok())
            };
            let header_ok = head.len() == 9
                && [head[0], head[1], head[3], head[5], head[7]] == ["#", "pages", "column", "change", "other"]
                && (2..=8).step_by(2).all(|k| count(k).is_some());
            let pages: Vec<Page> = lines[1..].iter().filter(|l| !l.is_empty()).map(|l| Page::of(&l.split('\t').collect::<Vec<_>>())).collect();
            let distinct: BTreeSet<&str> = pages.iter().map(|p| p.sha.as_str()).collect();
            if !header_ok || count(2) != Some(pages.len()) || pages.is_empty() || distinct.len() != pages.len() {
                return Err("manifest header and lines disagree (or empty)".into());
            }
            let stext = String::from_utf8(sraw.clone()).map_err(|_| "swap record is not utf-8")?;
            let srec: Vec<&str> = stext.split('\n').collect();
            if srec[0] != swap_header() {
                return Err("swap record has not the swap header".into());
            }
            let mut swapped: Vec<(Page, Page, String, String)> = Vec::new();
            for l in srec[1..].iter().filter(|l| !l.is_empty()) {
                let f: Vec<&str> = l.split('\t').collect();
                if f.len() != 2 * FIELDS.len() + 2 || f[f.len() - 1].trim().is_empty() {
                    let short: String = l.chars().take(40).collect();
                    return Err(format!("swap record line {short:?} is not: the line out, the line in, the BEFORE file, why"));
                }
                let (out, inn) = (Page::of(&f[..5]), Page::of(&f[5..10]));
                if out.recipe != "column" || inn.recipe != "column" {
                    return Err(format!(
                        "swap {} -> {} takes out a {} page and brings in a {} page: only a column page for a column page",
                        out.sha, inn.sha, out.recipe, inn.recipe
                    ));
                }
                swapped.push((out, inn, f[10].to_string(), f[11].to_string()));
            }
            let ins: Vec<&str> = swapped.iter().map(|s| s.1.sha.as_str()).collect();
            let outs: Vec<&str> = swapped.iter().map(|s| s.0.sha.as_str()).collect();
            let (ins_set, outs_set): (BTreeSet<&str>, BTreeSet<&str>) = (ins.iter().copied().collect(), outs.iter().copied().collect());
            if ins_set.len() != ins.len() || outs_set.len() != outs.len() || !ins_set.is_disjoint(&outs_set) {
                return Err("swap record names a page twice (record each swap once, from the frozen page to the page now on)".into());
            }
            let cols = pages.iter().filter(|p| p.recipe == "column").count();
            if cols != COLUMN_PAGES || count(4) != Some(cols) {
                return Err(format!(
                    "manifest has {cols} column pages (header says {}), not {COLUMN_PAGES}: a re-freeze swaps column for column and \
                     never lowers the count",
                    head.get(4).unwrap_or(&"?")
                ));
            }
            let on: BTreeMap<&str, &Page> = pages.iter().map(|p| (p.sha.as_str(), p)).collect();
            let mut undone: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            // the swaps undone last to first: before undoing one, the list is as it was right after it was made
            for (out, inn, before_sha, why) in swapped.iter().rev() {
                let name = format!("swap {} -> {}", out.sha, inn.sha);
                if on.get(inn.sha.as_str()) != Some(&inn) {
                    return Err(format!("{name}: the page brought in is not on the manifest as recorded"));
                }
                if on.contains_key(out.sha.as_str()) {
                    return Err(format!("{name}: the page taken out is still on the manifest"));
                }
                let req = inputs.docs.join(&inn.run).join("publications/column/request.json");
                if std::fs::read(&req).map(|b| sha256(&b)[..16] == inn.sha).ok() != Some(true) {
                    return Err(format!("{name}: its run folder holds no column page with that request (publications/column/request.json)"));
                }
                let at = undone.iter().position(|l| *l == inn.line()).ok_or_else(|| format!("{name}: the line brought in is not on the list"))?;
                undone[at] = out.line();
                let pre = sha256(undone.join("\n").as_bytes());
                let before = before_file(&inputs.beside, before_sha)
                    .ok_or_else(|| format!("{name}: no BEFORE file beside the manifest has sha256 {before_sha}"))?;
                if before["kind"] != "before" || before["manifest_sha256"] != pre.as_str() {
                    return Err(format!("{name}: its BEFORE file is not a before run of the list as it was before the swap"));
                }
                let failure = column_failure(&before["passes"][0][&out.sha]);
                match failure {
                    None => return Err(format!("{name}: the page taken out refilled and published in its BEFORE file's first pass")),
                    Some(f) if f != *why => {
                        return Err(format!("{name}: why {why:?} is not its BEFORE file's failure, word for word: {f:?}"));
                    }
                    Some(_) => {}
                }
            }
            if sha256(undone.join("\n").as_bytes()) != inputs.frozen {
                return Err("manifest is not the frozen one with the recorded swaps undone (sha256 differs): every change to the list \
                            must be a recorded column-for-column swap"
                    .into());
            }
            Ok((pages, sha256(raw)))
        }

        fn hex40(v: &Value) -> bool {
            v.as_str().is_some_and(|h| h.len() == 40 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        }

        /// The problems of one outcome file of `kind` over the list's pages (none: it holds).
        fn file_problems(f: &Value, kind: &str, pages: &[Page], msha: &str) -> Vec<String> {
            let mut p = Vec::new();
            if f["kind"] != kind {
                p.push(format!("{kind} file says kind {}", f["kind"]));
            }
            if f["manifest_sha256"] != msha {
                p.push(format!("{kind} file is of another manifest"));
            }
            if !hex40(&f["head40"]) {
                p.push(format!("{kind} file has no 40-hex head"));
            }
            let empty = Vec::new();
            let ps = f["passes"].as_array().unwrap_or(&empty);
            if ps.len() != 2 {
                p.push(format!("{kind} file has {} passes, not 2", ps.len()));
            }
            let shas: BTreeSet<&str> = pages.iter().map(|x| x.sha.as_str()).collect();
            for (i, recs) in ps.iter().enumerate() {
                let keys: BTreeSet<&str> = recs.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
                if keys != shas {
                    p.push(format!("{kind} pass {} is not one record per manifest page ({} of {})", i + 1, keys.len(), shas.len()));
                    continue;
                }
                for (sha, r) in recs.as_object().into_iter().flatten() {
                    let rf = &r["refill"];
                    let known = rf.as_str().is_some_and(|rf| {
                        rf == "ok"
                            || REFILL_REASONS.iter().any(|c| rf.strip_prefix(&format!("{c}: ")).is_some_and(|d| !d.trim().is_empty()))
                    });
                    if !known {
                        p.push(format!("{kind} pass {} page {sha}: refill {rf} is neither ok nor a known reason with detail", i + 1));
                    }
                }
            }
            if p.is_empty() {
                let again: Vec<&str> = pages.iter().map(|x| x.sha.as_str()).filter(|s| !differs(&ps[0][s], &ps[1][s]).is_empty()).collect();
                if let Some(first) = again.first() {
                    p.push(format!("{kind} file's two passes differ on {} page(s), first {first}: the gate is not repeatable", again.len()));
                }
            }
            if p.is_empty() && kind == "before" {
                // every column page of the first pass refilled and published its bars: no margin (user 11-01 21:41, 22:0x)
                let cols: Vec<&Page> = pages.iter().filter(|x| x.recipe == "column").collect();
                let failed: Vec<(&str, String)> =
                    cols.iter().filter_map(|x| column_failure(&ps[0][&x.sha]).map(|f| (x.sha.as_str(), f))).collect();
                if let Some((first, why)) = failed.first() {
                    p.push(format!(
                        "before pass 1: {} of {} column page(s) not refilled and published, first {first} ({why}): every column \
                         page must refill and publish its bars before (swap it, recorded, or fail)",
                        failed.len(),
                        cols.len()
                    ));
                }
            }
            if p.is_empty() && ps[0].as_object().into_iter().flatten().all(|(_, r)| r["refill"] != "ok") {
                p.push(format!("{kind} file refilled no page: an empty run"));
            }
            p
        }

        /// The gate's whole pass rule on this run's outcome file and, for an after run, BEFORE's: Ok(()) or every problem.
        fn judge(inputs: &Inputs, run: &Value, before: Option<&Value>) -> Result<(), Vec<String>> {
            let (pages, msha) = read_manifest(inputs).map_err(|why| vec![why])?;
            let mut bad = Vec::new();
            match run["kind"].as_str() {
                Some("before") => {
                    if before.is_some() {
                        bad.push("before run given a BEFORE file".to_string());
                    }
                    bad.extend(file_problems(run, "before", &pages, &msha));
                }
                Some("after") => {
                    let Some(before) = before else { return Err(vec!["after run without BEFORE".into()]) };
                    bad.extend(file_problems(before, "before", &pages, &msha));
                    bad.extend(file_problems(run, "after", &pages, &msha));
                    if bad.is_empty() && before["head40"] == run["head40"] {
                        bad.push("BEFORE was run at the same head as this run".into());
                    }
                    if bad.is_empty() {
                        for page in &pages {
                            let d = differs(&before["passes"][0][&page.sha], &run["passes"][0][&page.sha]);
                            if !d.is_empty() {
                                bad.push(format!("page {}: {} differ", page.sha, d.join(", ")));
                            }
                        }
                    }
                }
                other => return Err(vec![format!("run kind {other:?} is neither before nor after")]),
            }
            if bad.is_empty() { Ok(()) } else { Err(bad) }
        }

        // ------------------------------------------------------------ the fixture page set (acceptance H2, 11-02)

        /// The fixture list's sha256: the column pages and the change pages that refilled and published in the BEFORE at
        /// ad4b05f541b934c6627db58ef98276bd9070ddae (pass 1), each pinned to the run records a refill reads.
        const FIXTURE_LIST_SHA256: &str = "ac6d62bc590a8c62e8dd90e21386986929d619ba1053277a94d6e32f5fc8ef93";

        /// The sha256 of the run records a refill reads from a run folder: events.jsonl, claims.jsonl and every file under
        /// computations/, data/ and shadow/, as "<relative path>\0<sha256 of its bytes>\n" lines in byte order of the paths.
        fn inputs_sha256(run: &Path) -> Result<String, String> {
            fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
                for e in std::fs::read_dir(dir)? {
                    let path = e?.path();
                    if path.is_dir() {
                        walk(root, &path, out)?;
                    } else {
                        out.push(path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned());
                    }
                }
                Ok(())
            }
            let mut files = vec!["events.jsonl".to_string(), "claims.jsonl".to_string()];
            for d in ["computations", "data", "shadow"] {
                if run.join(d).is_dir() {
                    walk(run, &run.join(d), &mut files).map_err(|e| format!("{d}: {e}"))?;
                }
            }
            files.sort();
            files.dedup();
            let mut all = Vec::new();
            for f in &files {
                let bytes = std::fs::read(run.join(f)).map_err(|e| format!("{f}: {e}"))?;
                all.extend(format!("{f}\0{}\n", sha256(&bytes)).into_bytes());
            }
            Ok(sha256(&all))
        }

        /// The fixture list (`# fixture pages <n> column <c> change <h>`, then a line per page: the gate list's five fields
        /// and inputs_sha256 of its run folder under `docs`): Ok its pages and its sha256, Err why it is refused. Only the
        /// pinned list, and only pages whose run folder holds that page and those records.
        fn read_fixture_list(raw: &[u8], docs: &Path, pinned: &str) -> Result<(Vec<Page>, String), String> {
            let sha = sha256(raw);
            if sha != pinned {
                return Err(format!("fixture list sha256 {sha} is not the pinned {pinned}"));
            }
            let text = String::from_utf8(raw.to_vec()).map_err(|_| "fixture list is not utf-8")?;
            let mut lines = text.split('\n').filter(|l| !l.is_empty());
            let head: Vec<&str> = lines.next().unwrap_or("").split(' ').collect();
            let mut pages = Vec::new();
            for l in lines {
                let f: Vec<&str> = l.split('\t').collect();
                if f.len() != FIELDS.len() + 1 {
                    return Err(format!("fixture line {:?} has not six fields", l.chars().take(40).collect::<String>()));
                }
                let page = Page::of(&f[..5]);
                if !["column", "change"].contains(&page.recipe.as_str()) {
                    return Err(format!("fixture page {} is a {} page, not a column or change page", page.sha, page.recipe));
                }
                let run = docs.join(&page.run);
                let req = run.join("publications").join(&page.recipe).join("request.json");
                if std::fs::read(&req).map(|b| sha256(&b)[..16] == page.sha).ok() != Some(true) {
                    return Err(format!("fixture page {}: its run folder holds no {} page with that request", page.sha, page.recipe));
                }
                if inputs_sha256(&run)? != f[5] {
                    return Err(format!("fixture page {}: its run records are not the pinned ones (inputs_sha256 differs)", page.sha));
                }
                pages.push(page);
            }
            let n = |r: &str| pages.iter().filter(|p| p.recipe == r).count().to_string();
            let want = ["#", "fixture", "pages", &pages.len().to_string(), "column", &n("column"), "change", &n("change")];
            if head != want || pages.is_empty() {
                return Err("fixture list header and lines disagree (or empty)".into());
            }
            Ok((pages, sha))
        }

        /// The fixture set's pass rule (H2): a BEFORE whose two passes agree and in whose first pass every page refilled
        /// and published (a column page with its bars, file_problems), and an AFTER at another head, repeatable too, whose
        /// first pass equals BEFORE's on every item of every page. Ok(()) or every problem.
        fn fixture_judge(pages: &[Page], lsha: &str, run: &Value, before: Option<&Value>) -> Result<(), Vec<String>> {
            let green = |f: &Value| -> Vec<String> {
                pages
                    .iter()
                    .filter(|p| f["passes"][0][&p.sha]["end"] != json!({"published": true}))
                    .map(|p| format!("before pass 1 page {} ({}) did not publish: every fixture page publishes at the base", p.sha, p.recipe))
                    .collect()
            };
            let mut bad = Vec::new();
            match (run["kind"].as_str(), before) {
                (Some("before"), None) => {
                    bad.extend(file_problems(run, "before", pages, lsha));
                    if bad.is_empty() {
                        bad.extend(green(run));
                    }
                }
                (Some("after"), Some(before)) => {
                    bad.extend(file_problems(before, "before", pages, lsha));
                    bad.extend(file_problems(run, "after", pages, lsha));
                    if bad.is_empty() {
                        bad.extend(green(before));
                    }
                    if bad.is_empty() && before["head40"] == run["head40"] {
                        bad.push("BEFORE was run at the same head as this run".into());
                    }
                    if bad.is_empty() {
                        for page in pages {
                            let d = differs(&before["passes"][0][&page.sha], &run["passes"][0][&page.sha]);
                            if !d.is_empty() {
                                bad.push(format!("page {}: {} differ", page.sha, d.join(", ")));
                            }
                        }
                    }
                }
                (Some("before"), Some(_)) => bad.push("before run given a BEFORE file".into()),
                (Some("after"), None) => bad.push("after run without BEFORE".into()),
                (other, _) => bad.push(format!("run kind {other:?} is neither before nor after")),
            }
            if bad.is_empty() { Ok(()) } else { Err(bad) }
        }

        // ------------------------------------------------------------ refill: a page through the production path again

        /// The run's model, replayed: each step's answers (its newsroom_choose calls, in order) given again in that order;
        /// none for a step it has no answer left for, and none for the image review (advice the gate does not run).
        ///
        /// The run's answers to one step are kept as asks (replay_asks): each ask the run's attempts at it in order, every
        /// one the run's program refused and then the one it accepted. A refused replayed answer the run's program refused too
        /// gets the run's own next attempt, as the run did; only when the attempt the run's program accepted is refused (the
        /// program the page is refilled with may be newer: an item it no longer offers, a word a later rule refuses), or the
        /// ask has no attempt left, the asker gives the refused answer mapped onto what the program now allows (fitted). The
        /// same rule for every refill, so a page's before and after meet the same answers.
        struct ReplayAsker {
            answers: BTreeMap<String, VecDeque<VecDeque<Value>>>,
            /// The attempts of each step's current ask not given yet.
            retries: BTreeMap<String, VecDeque<Value>>,
            /// The last answer given to each step.
            last: BTreeMap<String, Value>,
            n: usize,
        }

        /// The run's newsroom_choose answers by step, as asks: each tool_execution_start's args in order, an ask closed by the
        /// first attempt its tool_execution_end (by toolCallId) does not mark isError. An attempt without its end is taken as
        /// accepted; a run's last ask may end refused.
        fn replay_asks(events: &[Value]) -> BTreeMap<String, VecDeque<VecDeque<Value>>> {
            let refused: BTreeSet<&str> = events
                .iter()
                .filter(|e| e["type"] == "tool_execution_end" && e["toolName"] == CHOOSE_TOOL && e["isError"] == true)
                .filter_map(|e| e["toolCallId"].as_str())
                .collect();
            let mut asks: BTreeMap<String, VecDeque<VecDeque<Value>>> = BTreeMap::new();
            let mut open: BTreeSet<String> = BTreeSet::new();
            for e in events.iter().filter(|e| e["type"] == "tool_execution_start" && e["toolName"] == CHOOSE_TOOL) {
                let step = e["args"]["step"].as_str().unwrap_or("").to_string();
                let of_step = asks.entry(step.clone()).or_default();
                if !open.contains(&step) {
                    of_step.push_back(VecDeque::new());
                }
                of_step.back_mut().unwrap().push_back(e["args"].clone());
                if e["toolCallId"].as_str().is_some_and(|id| refused.contains(id)) {
                    open.insert(step);
                } else {
                    open.remove(&step);
                }
            }
            asks
        }

        /// A refused answer mapped onto the refusal's allowed values and example (the program's own, newsroom_choose):
        /// a table step keeps each recorded parameter the program still offers with a value it allows (else the
        /// example's), and its pick when the program allows it (else the example's); a text step keeps the recorded name
        /// of each name the program asks for (else the example's) and gives no rewording, so the program's own drafts
        /// stand; any other step gives the example. None when the refusal holds no example.
        fn fitted(step: &str, recorded: &Value, refusal: &Value) -> Option<Value> {
            let (allowed, example) = (&refusal["allowed"], refusal.get("example")?);
            let mut out = example.clone();
            match step {
                "table" => {
                    let mut params = serde_json::Map::new();
                    for (k, values) in allowed["params"].as_object().into_iter().flatten() {
                        let ok = |v: &Value| values.as_array().is_some_and(|a| a.contains(v));
                        match (recorded["params"].get(k), example["params"].get(k)) {
                            (Some(v), _) if ok(v) => params.insert(k.clone(), v.clone()),
                            (_, Some(e)) => params.insert(k.clone(), e.clone()),
                            _ => None,
                        };
                    }
                    out["params"] = Value::Object(params);
                    let picks = recorded["pick"].as_array().cloned().unwrap_or_default();
                    if !picks.is_empty() && picks.iter().all(|p| allowed["pick"].as_array().is_some_and(|a| a.contains(p))) {
                        out["pick"] = json!(picks);
                    }
                }
                "text" => {
                    for k in allowed["names"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        if let Some(name) = recorded["names"].get(k) {
                            out["names"][k] = name.clone();
                        }
                    }
                    out["text"] = json!({});
                }
                _ => {}
            }
            Some(out)
        }

        #[async_trait]
        impl Asker for ReplayAsker {
            fn route(&self) -> ModelRoute {
                ModelRoute::Standin
            }

            async fn ask(&mut self, history: &[Value], tools: &[ToolDef], _cancel: &AtomicBool) -> Option<Value> {
                let step = tools.first()?.parameters["properties"]["step"]["enum"][0].as_str()?.to_string();
                if step == "vision" {
                    return None;
                }
                // the program's refusal of the answer just given, when it refused it
                let refusal = history
                    .last()
                    .filter(|m| m["role"] == "toolResult" && m["isError"] == true)
                    .and_then(|m| m["content"][0]["text"].as_str())
                    .and_then(|t| serde_json::from_str::<Value>(t).ok());
                let args = match (refusal, self.last.get(&step)) {
                    // the run's program refused the answer just given too: the run's own next attempt at this ask
                    (Some(refusal), Some(last)) => match self.retries.get_mut(&step).and_then(VecDeque::pop_front) {
                        Some(next) => next,
                        None => fitted(&step, last, &refusal)?,
                    },
                    _ => {
                        let mut ask = self.answers.get_mut(&step).and_then(VecDeque::pop_front)?;
                        let first = ask.pop_front()?;
                        self.retries.insert(step.clone(), ask);
                        first
                    }
                };
                self.last.insert(step, args.clone());
                self.n += 1;
                Some(json!({"content": [{"type": "toolCall", "id": format!("replay-{}", self.n), "name": CHOOSE_TOOL, "arguments": args}],
                    "stopReason": "toolUse", "usage": {}}))
            }
        }

        /// The replay follows the run's own retries: a text answer the run's program refused and then took on the second try
        /// (r8-e2: a measure name with 四类, then without) is given again as the run gave it, the second attempt after the
        /// refusal; only when that accepted attempt is refused too is the answer fitted (no rewording, the recorded names
        /// the program asks for kept). A later ask of the step takes the run's next ask, not a leftover retry.
        #[tokio::test]
        async fn the_replay_gives_the_runs_accepted_retry_before_fitting_an_answer() {
            let attempt = |id: &str, args: Value, refused: bool| {
                vec![
                    json!({"type": "tool_execution_start", "toolName": CHOOSE_TOOL, "toolCallId": id, "args": args}),
                    json!({"type": "tool_execution_end", "toolName": CHOOSE_TOOL, "toolCallId": id, "isError": refused}),
                ]
            };
            let first = json!({"step": "text", "names": {"s1": "四类慢病的变化"}, "text": {"1": "四地"}});
            let second = json!({"step": "text", "names": {"s1": "慢性病的变化"}, "text": {"1": "各地"}});
            let later = json!({"step": "text", "names": {"s1": "后来的"}, "text": {}});
            let table = json!({"step": "table", "params": {}, "pick": [1]});
            let events: Vec<Value> = [
                attempt("t1", table.clone(), false),
                attempt("x1", first.clone(), true),
                attempt("x2", second.clone(), false),
                attempt("x3", later.clone(), false),
                vec![json!({"type": "tool_execution_start", "toolName": CHOOSE_TOOL, "toolCallId": "x4", "args": first.clone()})],
            ]
            .concat();
            let asks = replay_asks(&events);
            assert_eq!(asks["text"], VecDeque::from([VecDeque::from([first.clone(), second.clone()]), VecDeque::from([later.clone()]), VecDeque::from([first.clone()])]));
            assert_eq!(asks["table"], VecDeque::from([VecDeque::from([table])]));
            let mut model = ReplayAsker { answers: asks, retries: BTreeMap::new(), last: BTreeMap::new(), n: 0 };
            let tools = [ToolDef {
                name: CHOOSE_TOOL.into(),
                description: String::new(),
                parameters: json!({"properties": {"step": {"enum": ["text"]}}}),
            }];
            let refusal = json!({"allowed": {"names": ["s1"]}, "example": {"step": "text", "names": {"s1": "<name>"}, "text": {"1": "<x>"}}});
            let refused = [json!({"role": "toolResult", "isError": true, "content": [{"type": "text", "text": refusal.to_string()}]})];
            let cancel = AtomicBool::new(false);
            macro_rules! give {
                ($history:expr) => {
                    model.ask($history, &tools, &cancel).await.unwrap()["content"][0]["arguments"].clone()
                };
            }
            assert_eq!(give!(&[]), first, "the ask's first attempt");
            assert_eq!(give!(&refused), second, "refused as the run's program refused it: the run's own retry");
            assert_eq!(give!(&refused), json!({"step": "text", "names": {"s1": "慢性病的变化"}, "text": {}}), "the accepted attempt refused: fitted");
            assert_eq!(give!(&[]), later, "a new ask takes the run's next ask");
        }

        fn failed(dir: &Path, reason: String) -> Value {
            json!({"run": dir.display().to_string(), "refill": reason, "end": null, "facts": null, "drawn": null, "ring": null,
                "gate": null, "checks": null, "html": null})
        }


        fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
            std::fs::create_dir_all(to)?;
            for e in std::fs::read_dir(from)? {
                let e = e?;
                if e.file_type()?.is_dir() {
                    copy_tree(&e.path(), &to.join(e.file_name()))?;
                } else {
                    std::fs::copy(e.path(), to.join(e.file_name()))?;
                }
            }
            Ok(())
        }

        /// Where a stopped run stopped: the step and the words of the stop.
        fn stage_of(stop: &Stop) -> (String, String) {
            let step = match stop {
                Stop::Page { step, why } => return (step.to_string(), why.clone()),
                Stop::Refused { step, .. }
                | Stop::NoReply { step }
                | Stop::ModelFailed { step, .. }
                | Stop::SecretInExchange { step, .. }
                | Stop::Exchange { step, .. } => step.to_string(),
                _ => "prepare".to_string(),
            };
            (step, stop.to_string())
        }

        /// The tables the run prepared (prepare_claims' result), rebuilt from its events: each claims-step fetch of the
        /// knowledge group (a newsroom_data_prepare call with picks and a sheet) that registered every pick, in call order
        /// (the main first), its id the catalogue's (a World Bank indicator with "@2"), its title the catalogue's ranking
        /// (a companion's: the main's companion shortlist), its claims in pick order; the main carries the companions the
        /// run kept (next_companions) with their fetched files and its sum-input fetch (next_composition_fetch). With them
        /// the claims step's call id, the program events' parent. Err names what the events lack.
        fn prepared_of(events: &[Value], catalogue: &dyn Catalogue) -> Result<(Vec<Prepared>, String), String> {
            let ranking = events.iter().find(|e| e["type"] == CATALOGUE_EVENT).map(|e| e["ranking"].clone()).ok_or("no next_catalogue")?;
            let places_zh: Vec<String> = serde_json::from_value(ranking["places_zh"].clone()).unwrap_or_default();
            let ends: BTreeMap<&str, &Value> = events
                .iter()
                .filter(|e| e["type"] == "tool_execution_end" && e["toolName"] == DATA_PREPARE_TOOL)
                .filter_map(|e| Some((e["toolCallId"].as_str()?, e)))
                .collect();
            let id_of = |args: &Value| {
                let dataset = args["dataset"].as_str().unwrap_or("");
                if args["provider"] == "worldbank" { format!("{dataset}@2") } else { dataset.to_string() }
            };
            // every fetch's file by table id, the last one fetched (the companions' files)
            let mut files: BTreeMap<String, String> = BTreeMap::new();
            let mut prepared: Vec<Prepared> = Vec::new();
            let mut parent = None;
            for start in events.iter().filter(|e| e["type"] == "tool_execution_start" && e["toolName"] == DATA_PREPARE_TOOL) {
                let Some(end) = start["toolCallId"].as_str().and_then(|id| ends.get(id)) else { continue };
                let (args, details) = (&start["args"], &end["result"]["details"]);
                let id = id_of(args);
                if let Some(file) = details["filePath"].as_str() {
                    files.insert(id.clone(), file.to_string());
                }
                let picks: Vec<&str> = args["picks"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let Some(sheet) = args["sheet"].as_str().filter(|_| !picks.is_empty()) else { continue };
                let mut claims = details["claims"].as_array().cloned().unwrap_or_default();
                if details["mode"] != "picks" || !details["runStop"].is_null() || claims.len() != picks.len() {
                    continue;
                }
                claims.sort_by_key(|c| c["candidate"].as_str().and_then(|k| picks.iter().position(|p| *p == k)).unwrap_or(usize::MAX));
                parent.get_or_insert_with(|| start["auto_parent_call_id"].as_str().unwrap_or("").to_string());
                let mut fetch = args.as_object().cloned().unwrap_or_default();
                fetch.remove("sheet");
                fetch.remove("picks");
                let ranked = ranking["candidates"].as_array().into_iter().flatten().find(|c| c["id"] == id.as_str()).and_then(|c| c["title"].as_str());
                let title = match (ranked, prepared.first()) {
                    (Some(t), _) => t.to_string(),
                    (None, Some(main)) => {
                        catalogue.companion_shortlist(&main.id).into_iter().find(|(c, _)| c.id == id).map(|(_, t)| t).unwrap_or_default()
                    }
                    (None, None) => String::new(),
                };
                prepared.push(Prepared {
                    id,
                    title,
                    file: details["filePath"].as_str().unwrap_or("").to_string(),
                    args: fetch,
                    sheet: sheet.to_string(),
                    claims,
                    places_zh: places_zh.clone(),
                    companions: Vec::new(),
                    // the asked quantities as the catalogue event recorded them (none on a run before they were)
                    asked: ranking.get("asked").cloned().unwrap_or_else(|| json!([])),
                    relation: None,
                });
            }
            let main = prepared.first_mut().ok_or("no claims-step fetch registered its picks")?;
            for kept in events.iter().filter(|e| e["type"] == COMPANION_EVENT).flat_map(|e| e["kept"].as_array().cloned().unwrap_or_default()) {
                let table = kept["table"].as_str().unwrap_or("").to_string();
                let file = files.get(&table).ok_or_else(|| format!("no fetch of the kept companion {table}"))?;
                main.companions.push((table, file.clone()));
            }
            for e in events.iter().filter(|e| e["type"] == COMPOSITION_FETCH_EVENT) {
                let file = e["file"].as_str().ok_or("a next_composition_fetch with no file")?;
                main.companions.push((main.id.clone(), file.to_string()));
            }
            // the relation the table step kept for the main table, as recorded (none on a run that gave none)
            main.relation = events.iter().filter(|e| e["type"] == crate::next_flow::TABLE_RELATION_EVENT).last().and_then(|e| {
                crate::shape_registry::RELATIONS.into_iter().find(|r| e["kept"].as_str() == Some(format!("{r:?}").as_str()))
            });
            Ok((prepared, parent.unwrap_or_default()))
        }

        /// One page of the list refilled under `dir` and walked through the production path again from its prepared tables:
        /// the run's records the page step reads (claims.jsonl, data/ with its origins, computations/, the candidate
        /// sheets in shadow/) copied to <dir>/run (the run folder is only read; nothing is fetched or computed afresh), its
        /// prepared tables rebuilt from its events (prepared_of), then next_run::page_from (the charts, the recipe's pick,
        /// the text step, the leaf page with the bake and the browser check, the completion gate, the page checks) with the
        /// run's model's text answers (ReplayAsker) and the real catalogue. Refilled ("ok") when the run's records are all
        /// there and every claim a prepared table names is a verified record of its claims.jsonl; else the reason
        /// (REFILL_REASONS). The record holds the 10 items' raw values (the html for text, layers and page).
        async fn refill(docs: &Path, page: &Page, dir: &Path) -> Value {
            let src = docs.join(&page.run);
            let Ok(text) = std::fs::read_to_string(src.join("events.jsonl")) else {
                return failed(dir, "events missing: events.jsonl".into());
            };
            let events: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
            let answers = replay_asks(&events);
            let Some(question) = events.iter().find(|e| e["type"] == CATALOGUE_EVENT).and_then(|e| e["question"].as_str()) else {
                return failed(dir, "events missing: no next_catalogue question in events.jsonl".into());
            };
            let Some(records) = std::fs::read_to_string(src.join("claims.jsonl")).ok().filter(|t| !t.trim().is_empty()) else {
                return failed(dir, "claims missing: claims.jsonl".into());
            };
            let records: Vec<Value> = records.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
            let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
            let (prepared, parent) = match prepared_of(&events, &catalogue) {
                Ok(p) => p,
                Err(why) => return failed(dir, format!("events missing: {why}")),
            };
            // every file the page step reads is the run's own
            let mut needed: Vec<String> = prepared.iter().map(|p| p.file.clone()).collect();
            needed.extend(prepared.iter().flat_map(|p| p.companions.iter().map(|(_, f)| f.clone())));
            needed.extend(prepared.iter().map(|p| format!("shadow/candidate_sheet-{}.json", p.sheet)));
            for r in &records {
                for key in ["source_refs", "computation_refs"] {
                    needed.extend(r[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string));
                }
            }
            if let Some(f) = needed.iter().find(|f| !src.join(f).is_file()) {
                return failed(dir, format!("data file missing: {f}"));
            }
            let verified: BTreeSet<&str> =
                records.iter().filter(|r| r["status"] == "verified").filter_map(|r| r["claim_id"].as_str()).collect();
            let named: Vec<&str> = prepared.iter().flat_map(|p| p.claims.iter().filter_map(|c| c["claim_id"].as_str())).collect();
            if let Some(c) = named.iter().find(|c| !verified.contains(*c)) {
                return failed(dir, format!("ledger facts differ from request.json: {c}, a claim of a prepared table, is no verified record of claims.jsonl"));
            }
            let _ = std::fs::remove_dir_all(dir);
            let run = dir.join("run");
            std::fs::create_dir_all(&run).unwrap();
            for d in ["data", "computations", "shadow"] {
                if src.join(d).is_dir() {
                    copy_tree(&src.join(d), &run.join(d)).unwrap();
                }
            }
            std::fs::copy(src.join("claims.jsonl"), run.join("claims.jsonl")).unwrap();
            let _command = crate::group_guard::command_for_test("investigate");
            crate::runtime::materialize_extension(&run).unwrap();
            let mut model = ReplayAsker { answers, retries: BTreeMap::new(), last: BTreeMap::new(), n: 0 };
            let mut walked = Vec::new();
            let mut sink = |e: Value| walked.push(e);
            let cancel = AtomicBool::new(false);
            let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
            recorder.hang_under(&parent);
            let result = crate::next_run::page_from(&mut recorder, &mut model, question, &prepared, &catalogue, &cancel).await;
            drop(recorder);
            // the walk's events beside it, as the q1 walk keeps them, for a reader of a refill that went wrong
            let lines: Vec<String> = walked.iter().map(Value::to_string).collect();
            std::fs::write(dir.join("walk-events.jsonl"), lines.join("\n")).unwrap();
            outcome_of(dir, &run, &walked, &result)
        }

        /// The outcome record of a refilled walk: where it ended, and the published page's facts, rows, html and the flow's
        /// ring, gate and checks events (each absent when the walk did not reach it).
        fn outcome_of(dir: &Path, run: &Path, events: &[Value], result: &Result<String, Stop>) -> Value {
            let last = |kind: &str| events.iter().rev().find(|e| e["type"] == kind);
            let end = match result {
                Ok(_) => json!({"published": true}),
                Err(stop) => {
                    let (stage, why) = stage_of(stop);
                    json!({"stop": stage, "why": why})
                }
            };
            let ring = last(crate::next_run::RING_EVENT);
            let published = ring.filter(|e| e["published"].is_string()).and_then(|e| e["recipe"].as_str());
            let read = |rel: String| std::fs::read_to_string(run.join(rel)).ok();
            let request: Option<Value> =
                published.and_then(|r| read(format!("publications/{r}/request.json"))).and_then(|t| serde_json::from_str(&t).ok());
            let html = published.and_then(|r| read(format!("publications/{r}/index.html")));
            // the rows the layers draw, as the request lists them (fill.drawn is not written to the run)
            let drawn = request.as_ref().map(|q| {
                q["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| json!({"layer": r.get("layer"), "src": r.get("src"), "table": r.get("table"), "time": r.get("time")}))
                    .collect::<Vec<_>>()
            });
            let ring = ring.map(|e| {
                let kept: Map<String, Value> =
                    RING_KEEP.iter().filter_map(|k| e.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
                Value::Object(kept)
            });
            json!({"run": dir.display().to_string(), "refill": "ok", "end": end,
                "facts": request.as_ref().map(|q| q["facts"].clone()), "drawn": drawn, "ring": ring,
                "gate": last(crate::next_run::LEAF_GATE_EVENT).map(|e| e["gaps"].clone()),
                "checks": last(crate::next_run::PAGE_CHECKS_EVENT).map(|e| e["checks"].clone()), "html": html})
        }

        fn var(name: &str) -> String {
            std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
        }

        /// One page of the list refilled into target/page-replay/one/<sha16>/ (NEXT_TREE_REPLAY_RUNS, NEXT_TREE_REPLAY_PAGE: its
        /// sha16), its record printed but its html: for reading why a page does not refill. Not the gate.
        #[tokio::test]
        #[ignore]
        async fn replay_refill_one_page() {
            let manifest = PathBuf::from(var("NEXT_TREE_REPLAY_RUNS"));
            let sha = var("NEXT_TREE_REPLAY_PAGE");
            let inputs = Inputs::beside(Some(&manifest));
            let (pages, _) = read_manifest(&inputs).unwrap_or_else(|why| panic!("{why}"));
            let page = pages.iter().find(|p| p.sha == sha).unwrap_or_else(|| panic!("{sha} is not on the list"));
            let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/page-replay/one").join(&sha);
            let rec = refill(&inputs.docs, page, &dir).await;
            let layers: Vec<String> = rec["html"].as_str().map(|h| canon_html(h).layers.into_iter().map(|(n, _)| n).collect()).unwrap_or_default();
            std::fs::write(dir.join("record.json"), rec.to_string()).unwrap_or_else(|e| panic!("{sha}: record: {e}"));
            println!("REFILL {sha} refill {} | end {} | layers {layers:?}", rec["refill"], rec["end"]);
        }

        /// The gate (design section 6.3): the list at NEXT_TREE_REPLAY_RUNS (its swap record beside it) refilled page by page
        /// twice, into target/page-replay/<kind>-<pass>/<sha16>/; the outcome file written to NEXT_TREE_REPLAY_OUT
        /// ({kind, head40, manifest_sha256, passes}, raw values); then judged, NEXT_TREE_REPLAY_KIND before or after (after with
        /// NEXT_TREE_REPLAY_BEFORE). Prints a line per page, for a before run each column page's end and the ones that do not
        /// count, every problem, and last `REPLAY <kind> pages <n> equal <n> differ <n>`; fails on any problem.
        ///
        ///     NEWS_CATALOG_DIR=.. NEWS_CLASSIFY_REFS=.. NEXT_TREE_REPLAY_RUNS=<list> NEXT_TREE_REPLAY_KIND=before \
        ///     NEXT_TREE_REPLAY_OUT=<file> cargo test --release --bins page_tree_replay -- --ignored --nocapture
        #[tokio::test]
        #[ignore]
        async fn page_tree_replay() {
            let manifest = std::env::var("NEXT_TREE_REPLAY_RUNS").ok().map(PathBuf::from);
            let kind = var("NEXT_TREE_REPLAY_KIND");
            let out = PathBuf::from(var("NEXT_TREE_REPLAY_OUT"));
            let before: Option<Value> = std::env::var("NEXT_TREE_REPLAY_BEFORE")
                .ok()
                .map(|p| serde_json::from_slice(&std::fs::read(&p).unwrap_or_else(|e| panic!("BEFORE {p}: {e}"))).unwrap());
            let inputs = Inputs::beside(manifest.as_deref());
            let (pages, msha) = read_manifest(&inputs).unwrap_or_else(|why| panic!("REPLAY {kind} refused: {why}"));
            assert!(kind == "before" || kind == "after", "NEXT_TREE_REPLAY_KIND {kind} is neither before nor after");
            let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
            let head = std::process::Command::new("git").arg("-C").arg(repo).args(["rev-parse", "HEAD"]).output().unwrap();
            let head40 = String::from_utf8_lossy(&head.stdout).trim().to_string();
            let mut passes = Vec::new();
            for pass in 1..=2 {
                let mut recs = Map::new();
                for page in &pages {
                    let dir = repo.join("target/page-replay").join(format!("{kind}-{pass}")).join(&page.sha);
                    recs.insert(page.sha.clone(), refill(&inputs.docs, page, &dir).await);
                }
                passes.push(Value::Object(recs));
            }
            let file = json!({"kind": kind, "head40": head40, "manifest_sha256": msha, "passes": passes});
            std::fs::write(&out, serde_json::to_vec(&file).unwrap()).unwrap();
            let other = match &before {
                Some(b) => &b["passes"][0],
                None => &file["passes"][1],
            };
            let (mut equal, mut differ) = (0, 0);
            for page in &pages {
                let rec = &file["passes"][0][&page.sha];
                let d = differs(&other[&page.sha], rec);
                if d.is_empty() { equal += 1 } else { differ += 1 }
                let refill = rec["refill"].as_str().unwrap_or("?");
                let end = match rec["end"].get("stop") {
                    Some(stage) => stage.as_str().unwrap_or("?").to_string(),
                    None if rec["end"].is_null() => "-".into(),
                    None => "published".into(),
                };
                let d = if d.is_empty() { String::new() } else { format!(" differ: {}", d.join(",")) };
                println!("replay: {} {} refill {refill} end {end}{d}", page.sha, page.recipe);
            }
            if kind == "before" {
                // each column page's end in the first pass, then the ones that do not count, each with its failure sentence
                let cols: Vec<&Page> = pages.iter().filter(|p| p.recipe == "column").collect();
                for page in &cols {
                    let rec = &file["passes"][0][&page.sha];
                    let end = match column_failure(rec) {
                        None => "published".to_string(),
                        Some(f) => f,
                    };
                    println!("replay column: {} {end}", page.sha);
                }
                for page in &cols {
                    if let Some(f) = column_failure(&file["passes"][0][&page.sha]) {
                        println!("replay column not counted: {} {f}", page.sha);
                    }
                }
            }
            let judged = judge(&inputs, &file, before.as_ref());
            for problem in judged.as_ref().err().into_iter().flatten() {
                println!("replay problem: {problem}");
            }
            println!("REPLAY {kind} pages {} equal {equal} differ {differ}", pages.len());
            assert!(judged.is_ok(), "the replay gate does not pass: {:?}", judged.err());
        }

        /// The fixture page set (acceptance H2): the pinned list at NEXT_TREE_FIXTURE_LIST (beside the gate's list; the
        /// local docs three folders up) refilled page by page twice into target/page-replay/fixture-<kind>-<pass>/<sha16>/,
        /// the outcome file written to NEXT_TREE_FIXTURE_OUT (as the gate's, the list's sha256 as its manifest_sha256), then
        /// judged by fixture_judge, NEXT_TREE_FIXTURE_KIND before or after (after with NEXT_TREE_FIXTURE_BEFORE). Prints a
        /// line per page and last `FIXTURES <kind> pages <n> equal <n> differ <n>`; fails on any problem.
        ///
        ///     NEWS_CATALOG_DIR=.. NEWS_CLASSIFY_REFS=.. NEXT_TREE_FIXTURE_LIST=<list> NEXT_TREE_FIXTURE_KIND=before \
        ///     NEXT_TREE_FIXTURE_OUT=<file> cargo test --release --bins page_tree_fixture_set -- --ignored --nocapture
        #[tokio::test]
        #[ignore]
        async fn page_tree_fixture_set() {
            let list = PathBuf::from(var("NEXT_TREE_FIXTURE_LIST"));
            let kind = var("NEXT_TREE_FIXTURE_KIND");
            let out = PathBuf::from(var("NEXT_TREE_FIXTURE_OUT"));
            let before: Option<Value> = std::env::var("NEXT_TREE_FIXTURE_BEFORE")
                .ok()
                .map(|p| serde_json::from_slice(&std::fs::read(&p).unwrap_or_else(|e| panic!("BEFORE {p}: {e}"))).unwrap());
            let docs = list.parent().and_then(|d| d.ancestors().nth(3)).map(Path::to_path_buf).unwrap_or_default();
            let raw = std::fs::read(&list).unwrap_or_else(|e| panic!("fixture list: {e}"));
            let (pages, lsha) = read_fixture_list(&raw, &docs, FIXTURE_LIST_SHA256).unwrap_or_else(|why| panic!("FIXTURES {kind} refused: {why}"));
            assert!(kind == "before" || kind == "after", "NEXT_TREE_FIXTURE_KIND {kind} is neither before nor after");
            let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
            let head = std::process::Command::new("git").arg("-C").arg(repo).args(["rev-parse", "HEAD"]).output().unwrap();
            let head40 = String::from_utf8_lossy(&head.stdout).trim().to_string();
            let mut passes = Vec::new();
            for pass in 1..=2 {
                let mut recs = Map::new();
                for page in &pages {
                    let dir = repo.join("target/page-replay").join(format!("fixture-{kind}-{pass}")).join(&page.sha);
                    recs.insert(page.sha.clone(), refill(&docs, page, &dir).await);
                }
                passes.push(Value::Object(recs));
            }
            let file = json!({"kind": kind, "head40": head40, "manifest_sha256": lsha, "passes": passes});
            std::fs::write(&out, serde_json::to_vec(&file).unwrap()).unwrap();
            let other = match &before {
                Some(b) => &b["passes"][0],
                None => &file["passes"][1],
            };
            let (mut equal, mut differ) = (0, 0);
            for page in &pages {
                let rec = &file["passes"][0][&page.sha];
                let d = differs(&other[&page.sha], rec);
                if d.is_empty() { equal += 1 } else { differ += 1 }
                let end = match rec["end"].get("stop") {
                    Some(stage) => stage.as_str().unwrap_or("?").to_string(),
                    None if rec["end"].is_null() => "-".into(),
                    None => "published".into(),
                };
                let d = if d.is_empty() { String::new() } else { format!(" differ: {}", d.join(",")) };
                println!("fixture: {} {} refill {} end {end}{d}", page.sha, page.recipe, rec["refill"].as_str().unwrap_or("?"));
            }
            let judged = fixture_judge(&pages, &lsha, &file, before.as_ref());
            for problem in judged.as_ref().err().into_iter().flatten() {
                println!("fixture problem: {problem}");
            }
            println!("FIXTURES {kind} pages {} equal {equal} differ {differ}", pages.len());
            assert!(judged.is_ok(), "the fixture set does not pass: {:?}", judged.err());
        }

        // ------------------------------------------------------------ the gate's own cases (design section 6.4)

        /// N2 and N3 as the design states them: what is forgiven (float last digits, int or float, -0, a number's spelling)
        /// and what is not (a display step, a 0.1 px move).
        #[test]
        fn replay_normalisation_forgives_only_spelling() {
            let n = |text: &str| cj(&serde_json::from_str::<Value>(text).unwrap(), None);
            assert_eq!(n("22"), n("22.0"));
            assert_eq!(n("-0.0"), n("0"));
            assert_eq!(n("50.50000000000001"), n("50.5"));
            assert_eq!(n("4.38926174496644"), n("4.3892617449664435"));
            assert_ne!(n("65.4"), n("65.5"));
            assert_ne!(n("1234567.8"), n("1234567.9"));
            assert_ne!(n("true"), n("1"));
            assert_ne!(n("\"65.4\""), n("65.4"), "a string is never read as a number");
            // N1: key order is no difference
            assert_eq!(n(r#"{"a": 1, "b": [2.0, {"d": 3, "c": 4}]}"#), n(r#"{"b": [2, {"c": 4, "d": 3.0}], "a": 1.0}"#));
            assert_ne!(n("[1, 2]"), n("[2, 1]"), "a list keeps its order");
            for (t, want) in [("424.80", "424.8"), ("18.0", "18"), ("-0.0", "0"), ("5.", "5"), (".5", "0.5"), ("1e3", "1000"), ("007", "7")] {
                assert_eq!(num_token(t).as_deref(), Some(want), "{t}");
            }
            let page = |rect: &str| canon_html(&format!(r#"<svg><g data-layer="bars">{rect}<text x="1">A</text></g></svg>"#));
            let a = page(r#"<rect x="120.0" y="6" width="30.50" height="18"/>"#);
            let b = page(r#"<rect height="18.0" width="30.5" y="6.0" x="120"></rect>"#);
            assert_eq!((a.page.as_str(), &a.layers), (b.page.as_str(), &b.layers));
            assert_ne!(a.page, page(r#"<rect x="120" y="6" width="30.6" height="18"/>"#).page, "0.1 px is a difference");
            assert_eq!(a.text, ["A"]);
            assert_eq!(numbers_in("M1.50,2 L-0.0 3e2 Z"), "M1.5,2 L0 300 Z");
        }

        /// The Rust normalisation is the prototype's: on the q1 golden walk committed beside the fixture, the page, each layer
        /// and the texts as outcome.py's canon_html gives them (sha256), and every float of the three walks, the edge floats
        /// and the number tokens as its canon_float and num_token print them (scripts/fixtures/p4a/replay-norm.json).
        #[test]
        fn replay_normalisation_equals_the_prototype() {
            let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a");
            let fix: Value = serde_json::from_slice(&std::fs::read(fx.join("replay-norm.json")).unwrap()).unwrap();
            let html = std::fs::read_to_string(fx.join("golden-q1-column.html")).unwrap();
            let walk = &fix["walks"][fix["committed_walk"].as_str().unwrap()];
            assert_eq!(sha256(html.as_bytes()), walk["html_sha256"]);
            let c = canon_html(&html);
            assert_eq!(sha256(c.page.as_bytes()), walk["page_sha256"], "the page's normal form");
            let layers: Vec<Value> = c.layers.iter().map(|(n, s)| json!([n, sha256(s.as_bytes())])).collect();
            assert_eq!(json!(layers), walk["layers"]);
            assert_eq!(json!(c.text), walk["text"]);
            let mut floats = 0;
            for case in fix["float_cases"].as_array().unwrap().iter().chain(fix["walks"].as_object().unwrap().values().flat_map(|w| w["floats"].as_array().unwrap())) {
                let x: f64 = case[0].as_str().unwrap().parse().unwrap();
                assert_eq!(canon_float(x), case[1].as_str().unwrap(), "{case}");
                floats += 1;
            }
            for case in fix["token_cases"].as_array().unwrap() {
                assert_eq!(num_token(case[0].as_str().unwrap()).as_deref(), case[1].as_str(), "{case}");
            }
            assert!(floats > 100 && layers.len() == 5, "{floats} floats, {} layers", layers.len());
        }

        /// The world of the judge's cases, under the worktree's target/: local docs with a run folder per page holding its
        /// request, the list (14 column pages, 2 change pages) and an empty swap record in w/d/p/, and three pages off the list.
        struct World {
            _tmp: tempfile::TempDir,
            docs: PathBuf,
            plan: PathBuf,
            pages: Vec<Page>,
            /// Off the list: two column pages and a change page.
            spares: Vec<Page>,
            frozen: Vec<u8>,
            base: Map<String, Value>,
        }

        const H0: &str = "1c62e0e1452faa2e7ba56716b1a29d9cc2027526";

        impl World {
            fn new() -> World {
                let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
                std::fs::create_dir_all(&target).unwrap();
                let tmp = tempfile::Builder::new().prefix("replay-judge-").tempdir_in(&target).unwrap();
                let docs = tmp.path().to_path_buf();
                let plan = docs.join("w/d/p");
                std::fs::create_dir_all(&plan).unwrap();
                let make = |i: usize, q: &str, recipe: &str| {
                    let run = format!("runs/p{i}");
                    let body = format!("{{\"page\": {i}}}");
                    let dir = docs.join(&run).join("publications").join(recipe);
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(dir.join("request.json"), &body).unwrap();
                    Page { sha: sha256(body.as_bytes())[..16].to_string(), q: q.into(), recipe: recipe.into(), runs: "1".into(), run }
                };
                let mut pages: Vec<Page> = (0..14).map(|i| make(i, "q1", "column")).collect();
                pages.extend((14..16).map(|i| make(i, "q5", "change")));
                let spares = vec![make(16, "q6", "column"), make(17, "q6", "column"), make(18, "q5", "change")];
                let lines: Vec<String> = pages.iter().map(Page::line).collect();
                let frozen = format!("# pages 16 column 14 change 2 other 0\n{}\n", lines.join("\n")).into_bytes();
                let base = pages.iter().enumerate().map(|(i, p)| (p.sha.clone(), record(i, &p.recipe, false))).collect();
                World { _tmp: tmp, docs, plan, pages, spares, frozen, base }
            }

            fn inputs(&self, manifest: Option<&[u8]>, swaps: &[u8]) -> Inputs {
                Inputs {
                    manifest: manifest.map(<[u8]>::to_vec),
                    swaps: Some(swaps.to_vec()),
                    frozen: sha256(&self.frozen),
                    docs: self.docs.clone(),
                    beside: self.plan.clone(),
                }
            }

            /// A BEFORE file kept beside the list (as the gate keeps the one a swap names): its sha256.
            fn keep(&self, before: &Value) -> String {
                let bytes = serde_json::to_vec(before).unwrap();
                let sha = sha256(&bytes);
                std::fs::write(self.plan.join(format!("replay-outcome-before-{}.json", &sha[..8])), &bytes).unwrap();
                sha
            }

            fn col(&self, k: usize) -> &str {
                &self.pages[k].sha
            }
            fn chg(&self) -> &str {
                &self.pages[14].sha
            }
        }

        fn header_only() -> Vec<u8> {
            format!("{}\n", swap_header()).into_bytes()
        }

        /// One re-freeze step: the list's line of `out` replaced in place by `inn`'s, the swap appended to the record.
        fn swap_lines(manifest: &[u8], swaps: &[u8], out: &str, inn: &Page, before_sha: &str, why: &str) -> (Vec<u8>, Vec<u8>) {
            let text = String::from_utf8(manifest.to_vec()).unwrap();
            let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
            let at = lines.iter().position(|l| l.split('\t').next() == Some(out)).unwrap();
            let out_line = std::mem::replace(&mut lines[at], inn.line());
            let mut rec = String::from_utf8(swaps.to_vec()).unwrap();
            if !rec.ends_with('\n') {
                rec.push('\n');
            }
            rec.push_str(&format!("{out_line}\t{}\t{before_sha}\t{why}\n", inn.line()));
            (lines.join("\n").into_bytes(), rec.into_bytes())
        }

        /// A page's record as a run would give it: a page with its layer (bars on a column page) holding two bars and their
        /// names, a note layer, facts, rows, ring, gate and checks; `noisy` writes every element's attributes reversed and
        /// every whole number with ".0" (what N3 forgives).
        fn record(i: usize, recipe: &str, noisy: bool) -> Value {
            let layer = if recipe == "column" { "bars" } else { "change_bars" };
            let run = format!("/w/run-{i}");
            let el = |tag: &str, attrs: &[(&str, &str)], inner: &str| {
                let mut a: Vec<String> = attrs
                    .iter()
                    .map(|(k, v)| {
                        let v = if noisy && v.parse::<i64>().is_ok() { format!("{v}.0") } else { v.to_string() };
                        format!(" {k}=\"{v}\"")
                    })
                    .collect();
                if noisy {
                    a.reverse();
                }
                format!("<{tag}{}>{inner}</{tag}>", a.concat())
            };
            let (w1, w2) = (format!("{}.5", 300 + i), format!("{}.0", 100 + i));
            let bars = [
                el("rect", &[("x", "120"), ("y", "6"), ("width", &w1), ("height", "18")], ""),
                el("text", &[("x", "112"), ("y", "18"), ("text-anchor", "end")], "Alpha"),
                el("rect", &[("x", "120"), ("y", "30"), ("width", &w2), ("height", "18")], ""),
                el("text", &[("x", "112"), ("y", "42"), ("text-anchor", "end")], "Beta"),
            ]
            .concat();
            let html = format!(
                "<!DOCTYPE html><html><head><title>p{i}</title><style>.a > b {{ fill: #111 }}</style></head><body><h1>Page {i} \
                 title</h1><svg viewBox=\"0 0 1140 300.0\"><g data-layer=\"{layer}\">{bars}</g><g data-layer=\"leader_notes\">{}</g>\
                 </svg><p>Source: t{i}</p></body></html>",
                el("text", &[("x", "400"), ("y", "20")], &format!("Note {i}"))
            );
            json!({"run": run, "refill": "ok", "end": {"published": true},
                "facts": [{"key": "val.SE", "op": "value", "fmt": "pc", "v": 65.4 + i as f64, "n": null, "t": null, "who": [],
                           "reads": ["series:t/A.SE:2025:OBS_VALUE", format!("{run}/data/a.csv")]},
                          {"key": "gap", "op": "minus", "fmt": "pp", "v": 50.50000000000001, "n": null, "t": null, "who": [], "reads": ["fact:val.SE"]},
                          {"key": "count", "op": "count", "fmt": "n", "v": 22, "n": null, "t": null, "who": [], "reads": []}],
                "drawn": [{"layer": layer, "src": "s1", "table": "t", "time": "2025"}, {"layer": layer, "src": "s2", "table": "t", "time": "2025"}],
                "ring": {"dropped": [], "r_used": 30.25, "r_steps": [10.5, 20.0], "r_min_lifted": 0, "r_min_codes": []},
                "gate": [],
                "checks": [{"name": "notes_dropped", "passed": true, "warning": null, "measured": {"count": 0, "items": []}},
                           {"name": "strip_placed", "passed": true, "warning": null, "measured": {"html_read": true}},
                           {"name": "type_size", "passed": true, "warning": null, "measured": {"min_font_px": 11.5, "floor_px": 11.0}}],
                "html": html})
        }

        fn refill_failed(r: &Value, reason: &str) -> Value {
            json!({"run": r["run"], "refill": reason, "end": null, "facts": null, "drawn": null, "ring": null, "gate": null,
                "checks": null, "html": null})
        }

        fn stop_at(r: &Value, stage: &str, why: &str) -> Value {
            let mut r = r.clone();
            for k in ["ring", "gate", "checks", "html", "facts", "drawn"] {
                r[k] = Value::Null;
            }
            r["end"] = json!({"stop": stage, "why": why});
            r
        }

        fn drop_note(r: &Value) -> Value {
            let mut r = r.clone();
            r["ring"]["dropped"] = json!([{"what": "leader_notes.lead1", "why": "no free place"}]);
            r["checks"][0]["passed"] = json!(false);
            r["checks"][0]["measured"] = json!({"count": 1, "items": ["leader_notes.lead1"]});
            r["end"] = json!({"stop": "checks", "why": "1 page check(s) failed"});
            r
        }

        /// The first bar of the page's bars layer `delta` px wider, printed to one decimal.
        fn bar_width(r: &Value, delta: f64) -> Value {
            let mut r = r.clone();
            let h = r["html"].as_str().unwrap().to_string();
            let at = h.find("data-layer=\"bars\"").unwrap();
            let w = at + h[at..].find("width=\"").unwrap() + 7;
            let e = w + h[w..].find('"').unwrap();
            let v: f64 = h[w..e].parse().unwrap();
            r["html"] = json!(format!("{}{:.1}{}", &h[..w], v + delta, &h[e..]));
            r
        }

        /// The first two names of the bars layer change places.
        fn swap_texts(r: &Value) -> Value {
            let mut r = r.clone();
            let h = r["html"].as_str().unwrap().to_string();
            let at = h.find("data-layer=\"bars\"").unwrap();
            let mut spans = Vec::new();
            let mut i = at;
            while spans.len() < 2 {
                let s = i + h[i..].find("<text").unwrap();
                let e = s + h[s..].find("</text>").unwrap() + 7;
                if h[s..e].contains("text-anchor=\"end\"") {
                    spans.push((s, e));
                }
                i = e;
            }
            let ((s0, e0), (s1, e1)) = (spans[0], spans[1]);
            r["html"] = json!(format!("{}{}{}{}{}", &h[..s0], &h[s1..e1], &h[e0..s1], &h[s0..e0], &h[e1..]));
            r
        }

        fn with_fact(r: &Value, f: impl Fn(f64) -> f64) -> Value {
            let mut r = r.clone();
            let v = r["facts"][0]["v"].as_f64().unwrap();
            r["facts"][0]["v"] = json!(f(v));
            r
        }

        /// Every float one ulp up, every whole float an int and every int a float: the noise N2 forgives.
        fn last_digits(v: &Value) -> Value {
            match v {
                Value::Number(n) if n.as_i64().is_some() => json!(n.as_i64().unwrap() as f64),
                Value::Number(n) => {
                    let x = n.as_f64().unwrap();
                    if x.fract() == 0.0 && x.abs() < 1e15 {
                        json!(x as i64)
                    } else {
                        let up = if x == 0.0 { f64::from_bits(1) } else if x > 0.0 { f64::from_bits(x.to_bits() + 1) } else { f64::from_bits(x.to_bits() - 1) };
                        json!(up)
                    }
                }
                Value::Array(a) => Value::Array(a.iter().map(last_digits).collect()),
                Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), last_digits(x))).collect()),
                other => other.clone(),
            }
        }

        fn file(kind: &str, head: &str, msha: &str, p1: &Map<String, Value>, p2: &Map<String, Value>) -> Value {
            json!({"kind": kind, "head40": head, "manifest_sha256": msha, "passes": [p1, p2]})
        }

        /// The judge's cases (outcome.py's, with the swap record's BEFORE file and the published-column floor added): each
        /// judged as expected, and a must-fail for its own reason (the words its first matching problem must hold).
        #[test]
        fn replay_judge_cases() {
            let w = World::new();
            let msha = sha256(&w.frozen);
            let base = &w.base;
            let hdr = header_only();
            let at = |sha: &str, f: &dyn Fn(&Value) -> Value| -> Map<String, Value> {
                let mut m = base.clone();
                m.insert(sha.to_string(), f(&base[sha]));
                m
            };
            let each = |f: &dyn Fn(&Value) -> Value| -> Map<String, Value> { base.iter().map(|(k, v)| (k.clone(), f(v))).collect() };
            let b = |p1: &Map<String, Value>| file("before", H0, &msha, p1, p1);
            let a = |p1: &Map<String, Value>| file("after", &"a".repeat(40), &msha, p1, p1);
            let (c0, chg) = (w.col(0).to_string(), w.chg().to_string());
            let rf_col_why = "ledger facts differ from request.json: fact val.SE";
            let rf_col = at(&c0, &|r| refill_failed(r, rf_col_why));
            let rf = at(&chg, &|r| refill_failed(r, "ledger facts differ from request.json: fact chg.SE"));
            let mut rf_other = rf.clone();
            rf_other.insert(chg.clone(), refill_failed(&base[&chg], "data file missing: data/x.xml"));
            let all_rf = each(&|r| refill_failed(r, "data file missing: data/x.xml"));
            let unpub_why = "the column leaf page stopped at fill: node bars: recheck: B5 node bars";
            let unpub = at(&c0, &|r| stop_at(r, "fill", unpub_why));
            let frozen = w.frozen.clone();
            let text = String::from_utf8(frozen.clone()).unwrap();
            let short = text.as_bytes()[..text.trim_end_matches('\n').rfind('\n').unwrap() + 1].to_vec();

            // the swaps: the failing column page out, a spare column page in; the record names the BEFORE file that showed it
            let swapped_recs = |out: &str, inn: &Page, rec: Value| -> Map<String, Value> {
                base.iter().map(|(k, v)| if k == out { (inn.sha.clone(), rec.clone()) } else { (k.clone(), v.clone()) }).collect()
            };
            let before_rf = b(&rf_col);
            let rf_sha = w.keep(&before_rf);
            let before_unpub = b(&unpub);
            let unpub_sha = w.keep(&before_unpub);
            let (spare, spare2, spare_chg) = (&w.spares[0], &w.spares[1], &w.spares[2]);
            let not_refilled = format!("not refilled: {rf_col_why}");
            let not_published = format!("refilled, not published: stopped at fill: {unpub_why}");
            let (ok_man, ok_sw) = swap_lines(&frozen, &hdr, &c0, spare, &rf_sha, &not_refilled);
            let ok_sha = sha256(&ok_man);
            let ok_recs = swapped_recs(&c0, spare, record(16, "column", false));
            let (up_man, up_sw) = swap_lines(&frozen, &hdr, &c0, spare, &unpub_sha, &not_published);
            let up_sha = sha256(&up_man);
            // (b): the page brought in for the unpublished one does not publish either: 13 column pages compared
            let up13 = {
                let mut m = swapped_recs(&c0, spare, record(16, "column", false));
                m.insert(spare.sha.clone(), stop_at(&m[&spare.sha], "fill", unpub_why));
                m
            };
            let (nr_man, _) = swap_lines(&frozen, &hdr, &c0, spare, &rf_sha, &not_refilled);
            let lie = Page { recipe: "column".into(), ..spare_chg.clone() };
            let (ch_man0, ch_sw) = swap_lines(&frozen, &hdr, &c0, spare_chg, &rf_sha, &not_refilled);
            let ch_man = String::from_utf8(ch_man0).unwrap().replacen("# pages 16 column 14 change 2", "# pages 16 column 13 change 3", 1).into_bytes();
            let (li_man, li_sw) = swap_lines(&frozen, &hdr, &c0, &lie, &rf_sha, &not_refilled);
            let c13 = {
                let lines: Vec<&str> = text.split('\n').collect();
                let mut kept = vec!["# pages 15 column 13 change 2 other 0"];
                kept.extend(lines[1..].iter().filter(|l| !l.starts_with(c0.as_str())));
                kept.join("\n").into_bytes()
            };
            let c13_recs: Map<String, Value> = base.iter().filter(|(k, _)| **k != c0).map(|(k, v)| (k.clone(), v.clone())).collect();
            let c13_sha = sha256(&c13);
            // swap records that do not hold: no BEFORE column, a BEFORE nobody kept, one of another list, one where the page
            // published, a why that is not its failure
            let eleven = {
                let t = String::from_utf8(ok_sw.clone()).unwrap();
                let mut lines: Vec<String> = t.lines().map(str::to_string).collect();
                lines[0] = lines[0].replace("\tbefore_sha256", "");
                let mut f: Vec<&str> = lines[1].split('\t').collect();
                f.remove(10);
                lines[1] = f.join("\t");
                format!("{}\n", lines.join("\n")).into_bytes()
            };
            let (_, nofile_sw) = swap_lines(&frozen, &hdr, &c0, spare, &"0".repeat(64), &not_refilled);
            let other_list = w.keep(&file("before", H0, &"1".repeat(64), &rf_col, &rf_col));
            let (_, other_sw) = swap_lines(&frozen, &hdr, &c0, spare, &other_list, &not_refilled);
            let fine = w.keep(&file("before", "b".repeat(40).as_str(), &msha, base, base));
            let (_, fine_sw) = swap_lines(&frozen, &hdr, &c0, spare, &fine, &not_refilled);
            let (_, why_sw) = swap_lines(&frozen, &hdr, &c0, spare, &rf_sha, "it did not refill");

            type Case<'a> = (&'a str, Inputs, Value, Option<Value>, bool, Option<&'a str>);
            let at_list = |m: &[u8], s: &[u8]| w.inputs(Some(m), s);
            let list = || w.inputs(Some(&frozen), &hdr);
            let after_on = |sha: &str, recs: &Map<String, Value>| file("after", &"a".repeat(40), sha, recs, recs);
            let before_on = |sha: &str, recs: &Map<String, Value>| file("before", H0, sha, recs, recs);
            let mut two = b(base);
            two["passes"][1][&chg]["html"] = json!(base[&chg]["html"].as_str().unwrap().replace("Beta", "Gamma"));
            let mut late = a(base);
            late["passes"][1][&c0] = stop_at(&base[&c0], "fill", "node bars: the child took more than 2 s");
            let mut miss = b(base);
            miss["passes"][0].as_object_mut().unwrap().remove(&c0);
            miss["passes"][1].as_object_mut().unwrap().remove(&c0);
            let mut moved = base.clone();
            for (k, v) in moved.iter_mut() {
                let other = format!("/w/elsewhere-{k}");
                let text = serde_json::to_string(v).unwrap().replace(v["run"].as_str().unwrap(), &other);
                *v = serde_json::from_str(&text).unwrap();
            }
            let noisy: Map<String, Value> = w
                .pages
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let mut r = last_digits(&base[&p.sha]);
                    r["html"] = record(i, &p.recipe, true)["html"].clone();
                    r["refill"] = base[&p.sha]["refill"].clone();
                    (p.sha.clone(), r)
                })
                .collect();
            let cases: Vec<Case> = vec![
                ("O0 after = before on every page", list(), a(base), Some(b(base)), true, None),
                ("O1 a column page published before stops at B5 after (must fail)", list(), a(&at(&c0, &|r| stop_at(r, "fill", "node bars: recheck: B5"))), Some(b(base)), false, Some("end")),
                ("O2 a page refilled before does not refill after (must fail)", list(), a(&rf_col), Some(b(base)), false, Some("refill")),
                ("O3 a page drops a leader note after (must fail)", list(), a(&at(&c0, &drop_note)), Some(b(base)), false, Some("ring")),
                ("O4 a bar 1 px wider after (must fail)", list(), a(&at(&c0, &|r| bar_width(r, 1.0))), Some(b(base)), false, Some("layers")),
                ("O5 after run without BEFORE (must fail)", list(), a(base), None, false, Some("without BEFORE")),
                ("N1 a fact one display step up (must fail)", list(), a(&at(&c0, &|r| with_fact(r, |v| ((v + 0.1) * 1e10).round() / 1e10))), Some(b(base)), false, Some("facts")),
                ("N2 a bar 0.1 px wider (must fail)", list(), a(&at(&c0, &|r| bar_width(r, 0.1))), Some(b(base)), false, Some("layers")),
                ("N3 two bar names swap places (must fail)", list(), a(&at(&c0, &swap_texts)), Some(b(base)), false, Some("text")),
                ("N4 two page checks swap order (must fail)", list(), a(&at(&chg, &|r| { let mut r = r.clone(); r["checks"].as_array_mut().unwrap().swap(0, 1); r })), Some(b(base)), false, Some("checks")),
                ("N5 a change page fails to refill on both runs, for different reasons (must fail)", list(), a(&rf_other), Some(b(&rf)), false, Some("refill")),
                ("P1 only float last digits, int or float and svg attribute order and '.0' differ, on every page", list(), a(&noisy), Some(b(base)), true, None),
                ("P2 a change page fails to refill on both runs for the same reason", list(), a(&rf), Some(b(&rf)), true, None),
                ("P3 the drawn rows come in another order", list(), a(&each(&|r| { let mut r = r.clone(); r["drawn"].as_array_mut().unwrap().reverse(); r })), Some(b(base)), true, None),
                ("P4 a fact differs in its 13th significant digit", list(), a(&at(&c0, &|r| with_fact(r, |v| v * (1.0 + 3e-14)))), Some(b(base)), true, None),
                ("P6 every page refilled into another folder (N4)", list(), a(&moved), Some(b(base)), true, None),
                ("E1 no manifest (must fail)", w.inputs(None, &hdr), a(base), Some(b(base)), false, Some("no manifest")),
                ("E2 the list less one page (must fail)", at_list(&short, &hdr), a(base), Some(b(base)), false, Some("header and lines disagree")),
                ("E2b a manifest that is another file (must fail)", at_list(b"{\"nodes\": {}}", &hdr), a(base), Some(b(base)), false, Some("header and lines disagree")),
                ("E3 BEFORE of another manifest (must fail)", list(), a(base), Some(before_on(&"0".repeat(64), base)), false, Some("another manifest")),
                ("E4 BEFORE is an after file (must fail)", list(), a(base), Some(a(base)), false, Some("kind")),
                ("E5 BEFORE at the same head (must fail)", list(), file("after", H0, &msha, base, base), Some(b(base)), false, Some("same head")),
                ("E6 BEFORE's two passes differ on a page (must fail)", list(), a(base), Some(two), false, Some("not repeatable")),
                ("E7 BEFORE lacks a page (must fail)", list(), a(base), Some(miss), false, Some("one record per manifest page")),
                ("E8 a before run given a BEFORE file (must fail)", list(), b(base), Some(b(base)), false, Some("given a BEFORE")),
                ("E9 a before run where no page refilled (must fail)", list(), b(&all_rf), None, false, Some("column page(s) not refilled")),
                ("E10 a refill reason outside the known ones (must fail)", list(), a(&rf), Some(b(&at(&chg, &|r| refill_failed(r, "it broke")))), false, Some("neither ok nor a known reason")),
                ("E11 a before run whose two passes agree", list(), b(base), None, true, None),
                ("E12 an after run whose second pass stops a column page (a timing stop) (must fail)", list(), late, Some(b(base)), false, Some("not repeatable")),
                ("C1 a before run where a column page does not refill (must fail)", list(), b(&rf_col), None, false, Some("column page(s) not refilled and published")),
                ("C1b that column page fails alike before and after (must fail)", list(), a(&rf_col), Some(b(&rf_col)), false, Some("column page(s) not refilled and published")),
                ("C2 a list with 13 column pages, its header made to agree (must fail)", at_list(&c13, &hdr), after_on(&c13_sha, &c13_recs), Some(before_on(&c13_sha, &c13_recs)), false, Some("13 column pages")),
                ("C3 a column page swapped, the swap not recorded (must fail)", at_list(&nr_man, &hdr), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("recorded swaps undone")),
                ("C4 the page swapped in is a change page (must fail)", at_list(&ch_man, &ch_sw), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("brings in a change page")),
                ("C4b a change page written down as column (must fail)", at_list(&li_man, &li_sw), after_on(&sha256(&li_man), &swapped_recs(&c0, &lie, record(18, "column", false))), Some(before_on(&sha256(&li_man), &swapped_recs(&c0, &lie, record(18, "column", false)))), false, Some("no column page")),
                ("P5 a column page that did not refill swapped for one that publishes, recorded", at_list(&ok_man, &ok_sw), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), true, None),
                ("P5b the before run on that swapped list", at_list(&ok_man, &ok_sw), before_on(&ok_sha, &ok_recs), None, true, None),
                ("A1 a before run where a column page refilled but stopped before publishing (must fail)", list(), b(&unpub), None, false, Some("refilled, not published")),
                ("A1b that column page stops alike before and after (must fail)", list(), a(&unpub), Some(b(&unpub)), false, Some("refilled, not published")),
                ("A2 the page swapped in for it does not publish either: 13 column pages compared (must fail)", at_list(&up_man, &up_sw), before_on(&up_sha, &up13), None, false, Some("1 of 14 column page(s) not refilled and published")),
                ("A3 the unpublished column page swapped for one that publishes, recorded", at_list(&up_man, &up_sw), after_on(&up_sha, &ok_recs), Some(before_on(&up_sha, &ok_recs)), true, None),
                ("A3b a column page published with no bars layer before (must fail)", list(), b(&at(&c0, &|r| { let mut r = r.clone(); r["html"] = json!(r["html"].as_str().unwrap().replace("data-layer=\"bars\"", "data-layer=\"rows\"")); r })), None, false, Some("published with no bars layer")),
                ("S1 a swap record line with no BEFORE file column (must fail)", at_list(&ok_man, &eleven), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("swap header")),
                ("S2 a swap naming a BEFORE file nobody kept (must fail)", at_list(&ok_man, &nofile_sw), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("no BEFORE file beside the manifest")),
                ("S3 a swap naming the BEFORE file of another list (must fail)", at_list(&ok_man, &other_sw), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("as it was before the swap")),
                ("S4 a swap whose page published in its BEFORE file (must fail)", at_list(&ok_man, &fine_sw), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("refilled and published in its BEFORE")),
                ("S5 a swap whose why is not its BEFORE file's failure (must fail)", at_list(&ok_man, &why_sw), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("word for word")),
                ("S6 a second swap of a page already swapped in (must fail)", at_list(&swap_lines(&ok_man, &ok_sw, &spare.sha, spare2, &rf_sha, &not_refilled).0, &swap_lines(&ok_man, &ok_sw, &spare.sha, spare2, &rf_sha, &not_refilled).1), after_on(&ok_sha, &ok_recs), Some(before_on(&ok_sha, &ok_recs)), false, Some("names a page twice")),
            ];
            let mut off = Vec::new();
            for (name, inputs, run, before, want, words) in &cases {
                let got = judge(inputs, run, before.as_ref());
                let problems = got.as_ref().err().cloned().unwrap_or_default();
                let own = words.is_none_or(|w| problems.iter().any(|p| p.contains(w)));
                println!("replay gate {name}: judged {}{}", if got.is_ok() { "PASS" } else { "FAIL" }, problems.first().map(|p| format!("; {}", p.chars().take(160).collect::<String>())).unwrap_or_default());
                if got.is_ok() != *want || !own {
                    off.push(format!("{name}: {problems:?}"));
                }
            }
            // the must-pass noise did touch the raw records (else P1 would pass by doing nothing)
            let touched = w.pages.iter().filter(|p| noisy[&p.sha]["html"] != base[&p.sha]["html"] && noisy[&p.sha]["facts"] != base[&p.sha]["facts"]).count();
            assert_eq!(touched, w.pages.len(), "P1's noise changed the raw html and facts of every page");
            assert!(off.is_empty() && cases.len() == 48, "{} cases; not as expected: {off:#?}", cases.len());
        }

        /// One published run's outcome as the gate records it, read from the run folder (outcome.py capture: the rows of the
        /// request for drawn); for the walks below, which are runs and not refills.
        /// The fixture set's list and judge: only the pinned list, of column and change pages whose run folders hold the
        /// page and the pinned records; a BEFORE every page of which published (a column page with its bars) and whose passes
        /// agree; an AFTER at another head equal to it on every item of every page. Each must-fail for its own reason.
        #[test]
        fn fixture_set_judge_cases() {
            let w = World::new();
            for i in 0..16 {
                std::fs::create_dir_all(w.docs.join(format!("runs/p{i}/data"))).unwrap();
                std::fs::write(w.docs.join(format!("runs/p{i}/events.jsonl")), format!("{{\"e\": {i}}}\n")).unwrap();
                std::fs::write(w.docs.join(format!("runs/p{i}/claims.jsonl")), "{}\n").unwrap();
                std::fs::write(w.docs.join(format!("runs/p{i}/data/a.csv")), format!("x,{i}\n")).unwrap();
            }
            let take: Vec<&Page> = [0, 1, 14].iter().map(|&i| &w.pages[i]).collect();
            let list = |pages: &[&Page], head: &str| -> Vec<u8> {
                let lines: Vec<String> =
                    pages.iter().map(|p| format!("{}\t{}", p.line(), inputs_sha256(&w.docs.join(&p.run)).unwrap())).collect();
                format!("{head}\n{}\n", lines.join("\n")).into_bytes()
            };
            let good = list(&take, "# fixture pages 3 column 2 change 1");
            let gsha = sha256(&good);
            let (pages, lsha) = read_fixture_list(&good, &w.docs, &gsha).unwrap();
            assert_eq!(pages.len(), 3);
            // the list
            let refused = |raw: &[u8], pin: &str, words: &str| {
                let why = read_fixture_list(raw, &w.docs, pin).err().unwrap_or_default();
                assert!(why.contains(words), "{words:?} not in {why:?}");
            };
            refused(&good, &"0".repeat(64), "is not the pinned");
            let wrong_head = list(&take, "# fixture pages 3 column 3 change 0");
            refused(&wrong_head, &sha256(&wrong_head), "header and lines disagree");
            std::fs::write(w.docs.join("runs/p1/data/a.csv"), "x,changed\n").unwrap();
            refused(&good, &gsha, "run records are not the pinned ones");
            std::fs::write(w.docs.join("runs/p1/data/a.csv"), "x,1\n").unwrap();
            let mut other = w.pages[0].clone();
            other.recipe = "flow".into();
            let flow = list(&[&other], "# fixture pages 1 column 0 change 0");
            refused(&flow, &sha256(&flow), "not a column or change page");
            // the judge
            let p1: Map<String, Value> = pages.iter().map(|p| (p.sha.clone(), w.base[&p.sha].clone())).collect();
            let before = file("before", H0, &lsha, &p1, &p1);
            assert_eq!(fixture_judge(&pages, &lsha, &before, None), Ok(()));
            let after = file("after", &"a".repeat(40), &lsha, &p1, &p1);
            assert_eq!(fixture_judge(&pages, &lsha, &after, Some(&before)), Ok(()));
            let fails = |run: &Value, before: Option<&Value>, words: &str| {
                let bad = fixture_judge(&pages, &lsha, run, before).err().unwrap_or_default();
                assert!(bad.first().is_some_and(|b| b.contains(words)), "{words:?} not first in {bad:?}");
            };
            let mut stopped = p1.clone();
            stopped.insert(w.chg().to_string(), stop_at(&p1[w.chg()], "checks", "x"));
            fails(&file("before", H0, &lsha, &stopped, &stopped), None, "did not publish");
            let mut barless = p1.clone();
            let c0 = w.col(0).to_string();
            barless[&c0]["html"] = json!(p1[&c0]["html"].as_str().unwrap().replace("data-layer=\"bars\"", "data-layer=\"other\""));
            fails(&file("before", H0, &lsha, &barless, &barless), None, "published with no bars layer");
            let mut moved = p1.clone();
            moved.insert(c0.clone(), bar_width(&p1[&c0], 0.5));
            fails(&file("after", &"a".repeat(40), &lsha, &moved, &moved), Some(&before), "differ");
            fails(&file("after", &"a".repeat(40), &lsha, &moved, &p1), Some(&before), "the gate is not repeatable");
            fails(&file("after", H0, &lsha, &p1, &p1), Some(&before), "same head");
            fails(&file("after", &"a".repeat(40), &"0".repeat(64), &p1, &p1), Some(&before), "another manifest");
            fails(&after, None, "without BEFORE");
            fails(&before, Some(&before), "given a BEFORE file");
        }

        fn capture(run: &Path, recipe: &str) -> Value {
            let text = std::fs::read_to_string(run.join("events.jsonl")).unwrap();
            let events: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
            let last = |kind: &str| events.iter().rev().find(|e| e["type"] == kind);
            let pubd = run.join("publications").join(recipe);
            let req: Value = serde_json::from_slice(&std::fs::read(pubd.join("request.json")).unwrap()).unwrap();
            let checks = last(crate::next_run::PAGE_CHECKS_EVENT).map(|e| e["checks"].clone());
            let failed = checks.as_ref().and_then(Value::as_array).map_or(0, |c| c.iter().filter(|c| c["passed"] != true).count());
            let end = if failed > 0 { json!({"stop": "checks", "why": format!("{failed} page check(s) failed")}) } else { json!({"published": true}) };
            let ring = last(crate::next_run::RING_EVENT).map(|e| {
                Value::Object(RING_KEEP.iter().filter_map(|k| e.get(*k).map(|v| (k.to_string(), v.clone()))).collect())
            });
            let drawn: Vec<Value> = req["rows"].as_array().into_iter().flatten()
                .map(|r| json!({"layer": r.get("layer"), "src": r.get("src"), "table": r.get("table"), "time": r.get("time")}))
                .collect();
            json!({"run": null, "refill": "ok", "end": end, "facts": req["facts"], "drawn": drawn, "ring": ring,
                "gate": last(crate::next_run::LEAF_GATE_EVENT).map(|e| e["gaps"].clone()), "checks": checks,
                "html": std::fs::read_to_string(pubd.join("index.html")).unwrap()})
        }

        /// The P2 golden walks of q1 (NEXT_TREE_REPLAY_GOLDEN, the walks' runs folder): the normalisation of each of the
        /// three in the fixture equals the prototype's, and the outcome compares as the prototype found: two walks at one
        /// commit and walks with no change to the page between them equal; walks across the 1 px circle edge differ, in the
        /// bubbles layer and the page only.
        ///
        ///     NEXT_TREE_REPLAY_GOLDEN=<runs> cargo test --release --bins replay_golden_walks -- --ignored --nocapture
        #[test]
        #[ignore]
        fn replay_golden_walks() {
            let runs = PathBuf::from(var("NEXT_TREE_REPLAY_GOLDEN"));
            let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/p4a/replay-norm.json");
            let fix: Value = serde_json::from_slice(&std::fs::read(fx).unwrap()).unwrap();
            for (tag, walk) in fix["walks"].as_object().unwrap() {
                let rec = capture(&runs.join(tag), "column");
                let c = canon_html(rec["html"].as_str().unwrap());
                assert_eq!(sha256(c.page.as_bytes()), walk["page_sha256"], "{tag}");
                let layers: Vec<Value> = c.layers.iter().map(|(n, s)| json!([n, sha256(s.as_bytes())])).collect();
                assert_eq!(json!(layers), walk["layers"], "{tag}");
                assert_eq!(json!(c.text), walk["text"], "{tag}");
            }
            let walk = |tag: &str| capture(&runs.join(tag), "column");
            for (name, x, y, want) in [
                ("R1 two walks at one commit", "44382c0c-1", "44382c0c-2", vec![]),
                ("R2 no change to the q1 page between", "f7602679-1", "44382c0c-1", vec![]),
                ("R3 the 1 px circle edge between", "44382c0c-1", "1c62e0e1-1", vec!["layers", "page"]),
                ("R4 across 9e7dbc20", "9e7dbc20-1", "44382c0c-1", vec!["layers", "page"]),
            ] {
                let (a, b) = (walk(x), walk(y));
                let d = differs(&a, &b);
                let la = canon_html(a["html"].as_str().unwrap()).layers;
                let lb = canon_html(b["html"].as_str().unwrap()).layers;
                let moved: Vec<&str> = la.iter().zip(&lb).filter(|(p, q)| p != q).map(|(p, _)| p.0.as_str()).collect();
                println!("replay outcome {name}: differ {d:?}, layers {moved:?}");
                assert_eq!(d, want, "{name}");
                assert!(want.is_empty() || moved == ["bubbles"], "{name}: {moved:?}");
            }
        }
    }
}
