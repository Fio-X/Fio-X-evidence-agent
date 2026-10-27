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
        parse_prepare_spec, prepare_claims, Asker, GroupCatalogue, ModelRoute, Need, PrepareStep, Recorder, CATALOGUE_EVENT, CHOOSE_TOOL,
        LEGACY_SWITCHES, NEXT_ENV, PARAMS_EVENT, TOOL_KEYS,
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
        let page = std::env::var("NEXT_DRIVE_PAGE").is_ok_and(|v| v == "1");
        let mut tools = start_tools(&run, &out, page).await;
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

    /// The real tool host as `news investigate` starts it on the new route, writing into `run`; `page` adds the design pack's
    /// and the critic's tools. NEXT_DRIVE_FETCH_FROM answers every fetch from local files (fetch.log goes to `out`).
    async fn start_tools(run: &Path, out: &Path, page: bool) -> ToolHost {
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
        let mut allowed = vec!["newsroom_data_prepare".to_string()];
        if page {
            allowed.push(crate::next_run::DESIGN_PACK_TOOL.to_string());
            allowed.push(crate::next_run::VISION_CRITIC_TOOL.to_string());
        }
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
                .filter_map(|line| line.split_once(". ").and_then(|(n, rest)| Some((n.trim().parse().ok()?, rest))))
                .collect()
        }

        /// Candidate text -> kind, over every candidate sheet the run wrote.
        fn kinds(&self) -> Vec<(String, String)> {
            std::fs::read_dir(self.run.join("shadow"))
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("candidate_sheet-"))
                .filter_map(|e| std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()))
                .flat_map(|sheet| sheet["candidates"].as_array().cloned().unwrap_or_default())
                .map(|c| (c["text"].as_str().unwrap_or("").to_string(), c["kind"].as_str().unwrap_or("").to_string()))
                .collect()
        }

        /// A string field of the gold, or a note that the gold lacks it.
        fn field(&mut self, step: &str, pointer: &str) -> Option<String> {
            let value = self.gold.pointer(pointer).and_then(Value::as_str).map(str::to_string);
            if value.is_none() {
                self.notes.push(format!("{step}: the gold has no {pointer}"));
            }
            value
        }

        fn answer(&mut self, step: &str, prompt: &str, schema: &Value) -> Option<Value> {
            match step {
                "search" => Some(json!({"step": "search", "query": self.field(step, "/stage_a/search_en")?})),
                "table" => {
                    let dataset = self.field(step, "/stage_a/args/dataset")?;
                    let worldbank = self.gold["route"] == "worldbank";
                    let id = if worldbank { format!("{dataset}@2") } else { dataset.to_string() };
                    let Some((n, _)) = Self::numbered(prompt).into_iter().find(|(_, rest)| rest.ends_with(&format!("({id})"))) else {
                        self.notes.push(format!("a: {id} is not in the listed tables"));
                        return None;
                    };
                    Some(json!({"step": "table", "pick": [n]}))
                }
                "claims" => {
                    let kinds = self.kinds();
                    let listed: Vec<(u64, &str)> = Self::numbered(prompt)
                        .into_iter()
                        .map(|(n, text)| (n, kinds.iter().find(|(t, _)| t == text).map_or("", |(_, k)| k.as_str())))
                        .collect();
                    let mut pick: Vec<u64> = Vec::new();
                    for kind in self.gold["stage_c"]["picks"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        match listed.iter().find(|(n, k)| *k == kind && !pick.contains(n)) {
                            Some((n, _)) => pick.push(*n),
                            None => self.notes.push(format!("c: the kind {kind} is not offered")),
                        }
                    }
                    let least = schema["properties"]["pick"]["minItems"].as_u64().unwrap_or(0) as usize;
                    let padded: Vec<u64> = listed.iter().map(|(n, _)| *n).filter(|n| !pick.contains(n)).take(least.saturating_sub(pick.len())).collect();
                    if !padded.is_empty() {
                        self.padded.push(format!("c: padded with {padded:?} to the least of {least}"));
                        pick.extend(padded);
                    }
                    Some(json!({"step": "claims", "pick": pick}))
                }
                "text" => {
                    let name = self.field(step, "/stage_d/measure_zh")?;
                    let slots = schema["properties"]["names"]["required"].as_array().cloned().unwrap_or_default();
                    Some(json!({"step": "text", "text": {},
                        "names": slots.iter().filter_map(Value::as_str).map(|s| (s.to_string(), json!(name))).collect::<serde_json::Map<_, _>>()}))
                }
                // Where the gold run ends: reached, not a failure.
                "vision" => None,
                other => {
                    self.notes.push(format!("{other}: the gold has no answer for this ask"));
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

        async fn ask(&mut self, history: &[Value], tools: &[ToolDef], _cancel: &AtomicBool) -> Option<Value> {
            let schema = &tools[0].parameters;
            let step = schema["properties"]["step"]["enum"][0].as_str().unwrap_or("").to_string();
            // A refused gold answer is not tried again: the refusal is the finding.
            if let Some(refusal) = history.last().filter(|m| m["role"] == "toolResult" && m["isError"] == true) {
                let text: String = refusal["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect();
                self.notes.push(format!("{step}: the gold answer was refused: {}", text.chars().take(300).collect::<String>()));
                return None;
            }
            self.asked.push(step.clone());
            let prompt = history
                .iter()
                .rev()
                .find(|m| m["role"] == "user")
                .and_then(|m| m["content"].as_array())
                .map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            let args = self.answer(&step, &prompt, schema)?;
            Some(json!({"content": [{"type": "toolCall", "id": format!("gold-{}", self.asked.len()), "name": CHOOSE_TOOL, "arguments": args}],
                "stopReason": "toolUse", "usage": {}}))
        }
    }

    /// The prepare steps a gold file gives (start from stage b): stage_a.args with the provider of `route`, and stage_c.narrowed
    /// cut to the tool's keys (its dataset and provider are the step's), through the spec parser the route reads specs with.
    fn gold_steps(gold: &Value) -> Vec<PrepareStep> {
        let mut step = gold["stage_a"]["args"].as_object().cloned().unwrap_or_default();
        if let Some(provider) = gold["route"].as_str().filter(|r| ["eurostat", "worldbank"].contains(r)) {
            step.entry("provider").or_insert_with(|| json!(provider));
        }
        if let Some(narrowed) = gold["stage_c"]["narrowed"].as_object() {
            let mut cut: serde_json::Map<String, Value> =
                narrowed.iter().filter(|(k, _)| TOOL_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
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
        let gold: Value = serde_json::from_str(&std::fs::read_to_string(var("NEXT_DRIVE_GOLD")).unwrap()).unwrap();
        let q = gold["qid"].as_str().unwrap_or("").to_string();
        let question = gold["question"].as_str().unwrap_or("").to_string();
        // An unanswerable question is not driven: its gold_k cells read n/a.
        if gold["answerable"] != true {
            println!("{q}\tn/a\tn/a\tn/a\tn/a");
            return;
        }
        let (out, run) = (PathBuf::from(var("NEXT_DRIVE_OUT")), PathBuf::from(var("NEXT_DRIVE_RUN")));
        for dir in [&out, &run] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let _command = crate::group_guard::command_for_test("investigate");
        crate::runtime::materialize_extension(&run).unwrap();
        let started = Instant::now();
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let steps = gold_steps(&gold);
        let mut tools = start_tools(&run, &out, true).await;
        let mut model = GoldAsker { gold, run: run.clone(), asked: Vec::new(), notes: Vec::new(), padded: Vec::new() };
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, &run, Vec::new(), Vec::new());
        let result = crate::next_run::run_page(&mut recorder, &mut model, &mut tools, &question, &steps, &catalogue, &cancel).await;
        drop(recorder);
        let seconds = started.elapsed().as_secs_f64();
        let stopped = match &result {
            Err(stop) => stop.to_string(),
            Ok(answer) => format!("answered: {answer}"),
        };
        let reached = model.asked.last().cloned().unwrap_or_default();
        let failure = first_failure(&model.notes, &reached, &stopped);
        let row = json!({"q": q, "reading": "gold", "start": "b", "reached": reached, "first_failure": failure, "stopped": stopped,
            "notes": model.notes, "padded": model.padded, "asked": model.asked, "seconds": (seconds * 10.0).round() / 10.0});
        std::fs::write(out.join(format!("{q}-gold.json")), serde_json::to_string_pretty(&row).unwrap()).unwrap();
        std::fs::write(run.join("events.jsonl"), events.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        println!("{q}\tb\t{reached}\t{failure}\t{:.1}", seconds);
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
        assert_eq!(narrowed.keys().map(String::as_str).collect::<Vec<_>>(), ["dataset", "filters", "provider"]);
        assert_eq!((&narrowed["dataset"], &steps[0].args["provider"]), (&json!("EN.X"), &json!("worldbank")));

        let run = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(run.path().join("shadow")).unwrap();
        let sheet = json!({"kind": "candidate_sheet", "candidates": [{"id": "c1", "kind": "rank_top", "text": "A leads"},
            {"id": "c2", "kind": "trend", "text": "B rises"}, {"id": "c3", "kind": "change", "text": "C falls"}, {"id": "c4", "kind": "share", "text": "D"}]});
        std::fs::write(run.path().join("shadow/candidate_sheet-0123456789abcdef.json"), sheet.to_string()).unwrap();
        let mut asker = GoldAsker { gold, run: run.path().to_path_buf(), asked: Vec::new(), notes: Vec::new(), padded: Vec::new() };
        let table = asker.answer("table", "Question: q\nTables:\n1. Other (EN.Y@2)\n2. CO2 (EN.X@2)", &Value::Null);
        assert_eq!(table, Some(json!({"step": "table", "pick": [2]})));
        let schema = json!({"properties": {"pick": {"minItems": 3}, "names": {"required": ["s1", "s2"]}}});
        let claims = asker.answer("claims", "Question: q\nTable 1 (EN.X@2):\n1. A leads\n2. B rises\n3. C falls\n4. D", &schema);
        assert_eq!(claims, Some(json!({"step": "claims", "pick": [2, 1, 3]})));
        assert_eq!(asker.padded, ["c: padded with [3] to the least of 3"]);
        assert!(asker.notes.is_empty());
        // Padding alone is no failure, and neither is the stop at vision.
        assert_eq!(asker.answer("vision", "", &Value::Null), None);
        assert_eq!(first_failure(&asker.notes, "vision", "the model gave no reply to vision"), "-");
        assert_eq!(first_failure(&asker.notes, "text", "the page step sheet stopped: x"), "the page step sheet stopped: x");
        let text = asker.answer("text", "", &schema).unwrap();
        assert_eq!(text["names"], json!({"s1": "人均排放", "s2": "人均排放"}));
        assert_eq!(asker.answer("table", "1. Other (EN.Y@2)", &Value::Null), None);
        assert_eq!(asker.notes.last().unwrap(), "a: EN.X@2 is not in the listed tables");
        asker.gold["stage_a"].as_object_mut().unwrap().remove("search_en");
        assert_eq!(asker.answer("search", "", &Value::Null), None);
        assert_eq!(asker.notes.last().unwrap(), "search: the gold has no /stage_a/search_en");
        assert_eq!(first_failure(&asker.notes, "vision", "x"), "a: EN.X@2 is not in the listed tables");
    }
}
