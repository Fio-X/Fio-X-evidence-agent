//! New route (`NEWSROOM_NEXT=1`, exactly; default off): the program drives a fixed order and the model only answers
//! with numbers and words. This part holds what decides whether the route runs at all: the one switch, the older
//! switches the route stands on, the choice between this route and the model loop, and the transitional prepare
//! spec (`--prepare-spec <file>`, the table and fetch parameters given on the command line until the table pick is
//! wired). Those parts are pure. The recorder below is the one place that talks to the model and runs the program's own calls: it
//! writes every model turn, every call and every model exchange as events, so the audit can trace each program call to the model
//! answer it followed.

use crate::agent_loop::ToolRunner;
use crate::anthropic_model::ToolDef;
use crate::l5geo::{Place, Ranking, TableMeta};
use crate::next_knowledge;
use crate::next_params;
use crate::next_visual;
use crate::shape_registry::{Matched, PagePlan, Relation, Shape, View};
use crate::tool_host::CallOutcome;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const NEXT_ENV: &str = "NEWSROOM_NEXT";
/// The command-line flag of the transitional prepare spec; the parent passes it on to the agent child unchanged.
pub const PREPARE_SPEC_ARG: &str = "--prepare-spec";

fn next_selected(value: Option<&str>) -> bool {
    value == Some("1")
}

pub fn next_enabled() -> bool {
    next_selected(std::env::var(NEXT_ENV).ok().as_deref())
}

/// What an older switch must be for this route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    Exactly(&'static str),
    /// Not "1": the route never calls the tool the switch changes, and an "on" would change that tool's text unseen.
    Off,
}

/// The older switches the route stands on, checked at start; none is relied on silently.
/// - NEWSROOM_AGENT=rust: the route runs in the Rust agent child.
/// - NEWSROOM_DATA_PREPARE=1: newsroom_data_prepare exists only with it (newsroom.ts dataPrepareEnabled).
/// - NEWSROOM_SPEED_PAGE_BUILD=1: the design pack's "sheet" part exists only with it (newsroom.ts packPageBuildOn).
/// - NEWSROOM_SPEED_DESIGN_PACK=1: the pack split and the pack's asset source check (agent_serve.rs, newsroom.ts).
/// - NEWSROOM_SPEED_RECIPES off: it only adds a recipe to download_data, which this route never calls.
/// - NEWSROOM_LEAN_GATES off: with it the concept, novelty and asset tools are not registered (newsroom.ts leanGatesEnabled), so
///   the design pack's first half cannot run and the completion gate would miss them after the data is in.
pub const LEGACY_SWITCHES: [(&str, Need); 6] = [
    ("NEWSROOM_AGENT", Need::Exactly("rust")),
    ("NEWSROOM_DATA_PREPARE", Need::Exactly("1")),
    ("NEWSROOM_SPEED_PAGE_BUILD", Need::Exactly("1")),
    ("NEWSROOM_SPEED_DESIGN_PACK", Need::Exactly("1")),
    ("NEWSROOM_SPEED_RECIPES", Need::Off),
    ("NEWSROOM_LEAN_GATES", Need::Off),
];

/// The first older switch that is not what the route needs, by name and need; `None` when all are.
pub fn legacy_problem(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    LEGACY_SWITCHES.iter().find_map(|(name, need)| {
        let value = get(name);
        match need {
            Need::Exactly(want) if value.as_deref() != Some(*want) => Some(format!(
                "the new route needs {name}={want}; it is {}",
                value
                    .as_deref()
                    .map_or("unset".to_string(), |v| format!("'{v}'"))
            )),
            Need::Off if value.as_deref() == Some("1") => {
                Some(format!("the new route needs {name} off; it is '1'"))
            }
            _ => None,
        }
    })
}

// Test shells only (next_drive's gold driver and this file's tests): the product picks tables from the catalogue.
#[cfg(test)]
#[derive(Debug, PartialEq)]
pub enum Route {
    /// The model loop, exactly as before.
    ModelLoop,
    /// The fixed flow; the spec is the transitional prepare spec when one was given.
    NextFlow { prepare_spec: Option<PathBuf> },
}

#[cfg(test)]
/// Which path the agent child takes. Off, a prepare spec is an error rather than ignored.
pub fn route(next: bool, prepare_spec: Option<&Path>) -> Result<Route, String> {
    match (next, prepare_spec) {
        (false, Some(_)) => Err(format!(
            "{PREPARE_SPEC_ARG} belongs to the new route, and {NEXT_ENV} is not '1'"
        )),
        (false, None) => Ok(Route::ModelLoop),
        (true, spec) => Ok(Route::NextFlow {
            prepare_spec: spec.map(Path::to_path_buf),
        }),
    }
}

// Test shells only (next_drive's gold driver and this file's tests): the product picks tables from the catalogue.
#[cfg(test)]
/// The keys of one prepare step that go to newsroom_data_prepare.
pub const TOOL_KEYS: [&str; 4] = ["provider", "dataset", "filters", "years"];
#[cfg(test)]
/// The step keys the file may carry: the tool keys and the narrowed request (itself only tool keys).
pub const STEP_KEYS: [&str; 5] = ["provider", "dataset", "filters", "years", "narrowed"];

/// One table of the spec: what goes to newsroom_data_prepare, and the narrowed request used once when the tool asks to narrow.
#[derive(Clone, Debug, PartialEq)]
pub struct PrepareStep {
    pub args: Map<String, Value>,
    pub narrowed: Option<Map<String, Value>>,
}

/// Why the route stops before any table is fetched.
#[derive(Debug, PartialEq)]
pub enum Stop {
    /// No table can be chosen: no spec was given, or a step is only a catalogue search; the catalogue pick is not wired yet.
    TablePickNotWired(String),
    /// The spec breaks a rule; the text names the step and what is wrong.
    #[cfg(test)]
    BadSpec(String),
    /// The model's answer to this step was refused in every allowed round; the text is the last refusal.
    Refused { step: &'static str, problem: String },
    /// The model gave no reply to this step.
    NoReply { step: &'static str },
    /// The reply to this step was a provider failure or an abort.
    ModelFailed { step: &'static str, error: String },
    /// The exchange of this step holds a secret of this kind; nothing of it was written.
    SecretInExchange {
        step: &'static str,
        kind: SecretKind,
    },
    /// The exchange of this step could not be recorded.
    Exchange { step: &'static str, why: String },
    /// A program call was about to run with no accepted model answer to hang under.
    NoModelParent { tool: String },
    /// The question cannot be answered from the catalogue: it offered no table, or the model answered that none fits.
    NoTable(String),
    /// The catalogue is not set up: NEWS_CATALOG_DIR is unset, or the directory cannot be read. A configuration error, never
    /// "cannot be answered".
    CatalogueNotConfigured(String),
    /// The table has fewer than CLAIMS_MIN candidate claims; the question cannot be answered from it.
    TooFewClaims { dataset: String },
    /// newsroom_data_prepare gave no candidate sheet for the table; `mode` is the mode it returned, `why` the start of its text
    /// (REASON_MAX_CHARS, addresses removed).
    NotPrepared {
        dataset: String,
        mode: String,
        why: String,
    },
    /// The table's source could not be reached in `tries` fetches (FETCH_RETRY_WAITS_MS): an infrastructure stop, never "cannot be answered".
    SourceUnreachable {
        dataset: String,
        tries: usize,
        why: String,
    },
    /// The picked claims were not all registered as verified claims; the text says what came back.
    NotRegistered { dataset: String, why: String },
    /// A page step after the claims (next_run) cannot go on; the text says what is missing.
    Page { step: &'static str, why: String },
}

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stop::TablePickNotWired(why) => write!(f, "table pick not wired: {why}"),
            #[cfg(test)]
            Stop::BadSpec(why) => write!(f, "prepare spec refused: {why}"),
            Stop::Refused { step, problem } => write!(
                f,
                "the answer to step {step} was refused {REFUSED_ROUNDS} times: {problem}"
            ),
            Stop::NoReply { step } => write!(f, "the model gave no reply to step {step}"),
            Stop::ModelFailed { step, error } => {
                write!(f, "the model reply to step {step} failed: {error}")
            }
            Stop::SecretInExchange { step, kind } => write!(
                f,
                "the exchange of step {step} holds a secret ({}); it was not written",
                kind.name()
            ),
            Stop::Exchange { step, why } => {
                write!(f, "the exchange of step {step} was not recorded: {why}")
            }
            Stop::NoModelParent { tool } => write!(
                f,
                "{tool} would run with no model answer to follow; the program never calls on its own"
            ),
            Stop::NoTable(why) => write!(f, "no table answers the question: {why}"),
            Stop::CatalogueNotConfigured(why) => write!(f, "configuration error: {why}"),
            Stop::TooFewClaims { dataset } => write!(
                f,
                "{dataset} has fewer than {CLAIMS_MIN} candidate claims; the question cannot be answered from it"
            ),
            Stop::NotPrepared { dataset, mode, why } => {
                write!(f, "{DATA_PREPARE_TOOL} gave no candidate sheet for {dataset} (mode {mode})")?;
                if !why.is_empty() {
                    write!(f, ": {why}")?;
                }
                Ok(())
            }
            Stop::SourceUnreachable { dataset, tries, why } => write!(
                f,
                "source unreachable: {DATA_PREPARE_TOOL} could not reach the source of {dataset} in {tries} tries: {why}"
            ),
            Stop::NotRegistered { dataset, why } => {
                write!(f, "the picked claims of {dataset} were not registered: {why}")
            }
            Stop::Page { step, why } => write!(f, "the page step {step} stopped: {why}"),
        }
    }
}

// Test shells only (next_drive's gold driver and this file's tests): the product picks tables from the catalogue.
#[cfg(test)]
/// The steps of the run, or why it stops. No spec stops as "table pick not wired"; nothing else is tried.
pub fn prepare_steps(spec_text: Option<&str>) -> Result<Vec<PrepareStep>, Stop> {
    match spec_text {
        None => Err(Stop::TablePickNotWired(format!(
            "no {PREPARE_SPEC_ARG} was given and the catalogue pick is not wired yet"
        ))),
        Some(text) => parse_prepare_spec(text),
    }
}

#[cfg(test)]
/// Reads the spec: a JSON list, one step per table, as the question bank's prepare list with every `$` reference already
/// expanded and the measurer's keys removed. A key outside the five, a `$` value or a bad narrowed request is refused by name,
/// never dropped; a step that is only a search stops the run.
pub fn parse_prepare_spec(text: &str) -> Result<Vec<PrepareStep>, Stop> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| Stop::BadSpec(format!("the file is not JSON: {e}")))?;
    let Value::Array(items) = value else {
        return Err(Stop::BadSpec(
            "the file must be a JSON list of steps".into(),
        ));
    };
    if items.is_empty() {
        return Err(Stop::BadSpec("the list has no step".into()));
    }
    let mut steps = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let n = index + 1;
        let Value::Object(map) = item else {
            return Err(Stop::BadSpec(format!("step {n} is not an object")));
        };
        if map.len() == 1 && map.contains_key("search") {
            return Err(Stop::TablePickNotWired(format!(
                "step {n} is only a catalogue search"
            )));
        }
        if let Some(key) = map.keys().find(|k| !STEP_KEYS.contains(&k.as_str())) {
            return Err(Stop::BadSpec(format!(
                "step {n} has the key '{key}'; allowed: {}",
                STEP_KEYS.join(", ")
            )));
        }
        if let Some(path) = dollar_path(item, "") {
            return Err(Stop::BadSpec(format!(
                "step {n} has an unexpanded reference at {path}"
            )));
        }
        let narrowed = match map.get("narrowed") {
            None => None,
            Some(Value::Object(inner)) => {
                if let Some(key) = inner.keys().find(|k| !TOOL_KEYS.contains(&k.as_str())) {
                    return Err(Stop::BadSpec(format!(
                        "step {n} narrowed has the key '{key}'; allowed: {}",
                        TOOL_KEYS.join(", ")
                    )));
                }
                Some(inner.clone())
            }
            Some(_) => {
                return Err(Stop::BadSpec(format!("step {n} narrowed is not an object")));
            }
        };
        let args = map
            .iter()
            .filter(|(k, _)| k.as_str() != "narrowed")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        steps.push(PrepareStep { args, narrowed });
    }
    Ok(steps)
}

#[cfg(test)]
/// Where the first string starting with `$` sits, as a JSON pointer.
fn dollar_path(value: &Value, at: &str) -> Option<String> {
    match value {
        Value::String(s) if s.starts_with('$') => {
            Some(if at.is_empty() { "/".into() } else { at.into() })
        }
        Value::Array(list) => list
            .iter()
            .enumerate()
            .find_map(|(i, v)| dollar_path(v, &format!("{at}/{i}"))),
        Value::Object(map) => map
            .iter()
            .find_map(|(k, v)| dollar_path(v, &format!("{at}/{k}"))),
        _ => None,
    }
}

/// The model's one tool on this route (flow group; no capability class). Each request offers one step, with the
/// allowed values of that step written into the schema.
pub const CHOOSE_TOOL: &str = "newsroom_choose";

/// What the program asks in one request.
#[derive(Clone, Debug, PartialEq)]
pub enum Ask {
    /// English words for the catalogue search; used only to search, never on the page or in fetch parameters.
    Search,
    /// One to `most` different ones of `count` listed tables, or 0 for none of them. With `items` (one list per listed
    /// table, next_params::items as item key -> option count; empty when a prepare spec gives the fetch parameters), also
    /// one option number for every item of each picked table and no other, but for the item a picked split leaves out
    /// (`splits`, one list per listed table: each breakdown option the table pick offers, see Split).
    Table {
        count: usize,
        most: usize,
        items: Vec<Vec<(String, usize)>>,
        splits: Vec<Vec<Split>>,
        /// One per listed table: the series its held-series probe found (HeldCheck); None when it was not probed or the
        /// probe gave no answer, and then nothing is checked.
        held: Vec<Option<HeldCheck>>,
    },
    /// Claims of one or more tables, numbered on across the tables (`groups` holds each table's count, each at least
    /// CLAIMS_MIN): from each table CLAIMS_MIN to min(CLAIMS_MAX, its count); with more than one candidate relation, also one of them.
    Claims {
        groups: Vec<usize>,
        relations: usize,
    },
    /// Revised wording by field id (each keeps the draft's placeholders), and a Chinese name for every untranslated slot.
    /// `numbers`: the only numbers a wording may type outside placeholders (the time values the page draws, such as the
    /// year of a claim's row); any other typed number is refused, and so is a number in words (二十七, 两国, 三倍, 过半).
    /// `periods`: the page's time values that are not years (2026-08, a monthly table's): a time placeholder prints the
    /// whole period, so 年 right after one is refused (year_after_period); empty on an annual page.
    Text {
        fields: BTreeMap<String, String>,
        slots: Vec<String>,
        numbers: Vec<String>,
        periods: Vec<String>,
    },
    /// The image-aware critic's verdict on the previewed page: a 0-100 score, every rubric item 0-100, a 0-1 confidence and up to
    /// VISION_ISSUES_MAX issues, each on one of `modules` (the page's module ids) or the whole page. The record can only veto the page.
    Vision { modules: Vec<String> },
}

/// The rubric of the image-aware critic (vision.mjs VISION_RUBRIC_KEYS).
pub const VISION_RUBRIC: [&str; 10] = [
    "hierarchy",
    "legibility",
    "composition",
    "visual_coherence",
    "typography",
    "source_legibility",
    "responsive_quality",
    "illustration_integration",
    "color_contrast",
    "editorial_distinctiveness",
];
pub const VISION_ISSUES_MAX: usize = 8;
/// The longest evidence or recommendation of one issue.
pub const VISION_TEXT_MAX: usize = 200;
const VISION_SEVERITIES: [&str; 3] = ["blocker", "warning", "nit"];

/// The model's answer, checked.
#[derive(Clone, Debug, PartialEq)]
pub enum Choice {
    Search {
        query: String,
    },
    /// The picked table numbers; empty when the answer was 0, none of the tables fits. `params`: item key -> the picked
    /// option number, for the items of the picked tables (empty when the request listed none).
    Table {
        picks: Vec<usize>,
        params: BTreeMap<String, usize>,
    },
    /// Claim numbers as listed, across the tables.
    Claims {
        picks: Vec<usize>,
        relation: Option<usize>,
    },
    Text {
        text: BTreeMap<String, String>,
        names: BTreeMap<String, String>,
    },
    /// Issues as {severity, code, module_id?, evidence, recommendation}, already checked.
    Vision {
        score: u64,
        confidence: f64,
        rubric: BTreeMap<String, u64>,
        issues: Vec<Value>,
    },
}

/// One breakdown option of a listed table (t<n>.breakdown = `option`, 2 or more): the dimension it opens, the years options
/// whose fetch gives a shape a filled template draws (the only ones allowed with it), and whether t<n>.<dim> is an item,
/// which the answer then leaves out (the breakdown takes every code of it).
#[derive(Clone, Debug, PartialEq)]
pub struct Split {
    pub option: usize,
    pub dim: String,
    pub years: Vec<usize>,
    pub member: bool,
}

/// A listed table's held-series probe as the table pick checks it: after the answer, the fetch it asks for must hold a
/// series the probe found (next_params::holds_series), since the per-dimension codes miss gaps between open dimensions (q3:
/// unit PC is held, siec TOTAL is held, TOTAL in PC is not).
#[derive(Clone, Debug, PartialEq)]
pub struct HeldCheck {
    pub draft: next_params::Draft,
    pub places: Vec<Place>,
    pub this_year: i32,
    pub held: next_knowledge::Held,
}

/// Single changes of the answer tried for an example before every combination is walked.
const HELD_EXAMPLE_TRIES: usize = 4096;

impl HeldCheck {
    fn holds(&self, n: usize, params: &BTreeMap<String, usize>) -> bool {
        next_params::holds_series(
            &self.draft,
            n,
            params,
            &self.places,
            self.this_year,
            &self.held,
        )
    }

    /// The codes the answer fixes in each dimension the probe left open, as "dim=code".
    fn asked(&self, n: usize, params: &BTreeMap<String, usize>) -> String {
        let Ok(filled) = next_params::fill(&self.draft, n, params, &self.places, self.this_year)
        else {
            return String::new();
        };
        let open: Vec<&str> = self
            .draft
            .breakdown
            .iter()
            .map(String::as_str)
            .chain(self.draft.members.iter().map(|(d, _, _)| d.as_str()))
            .collect();
        filled.args["filters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["dimension"].as_str().is_some_and(|d| open.contains(&d)))
            .map(|f| {
                format!(
                    "{}={}",
                    f["dimension"].as_str().unwrap_or(""),
                    f["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("+")
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The nearest answer that holds a series: one item changed first, then every combination of the items but the years
    /// (a split that takes a member item leaves it out, and keeps only the years it draws with). None when none holds.
    fn example(
        &self,
        n: usize,
        given: &BTreeMap<String, usize>,
        items: &[(String, usize)],
        splits: &[Split],
    ) -> Option<BTreeMap<String, usize>> {
        let years_key = format!("t{n}.{}", next_params::YEARS_KEY);
        let asked: Vec<&(String, usize)> = items.iter().filter(|(k, _)| *k != years_key).collect();
        let shaped = |mut params: BTreeMap<String, usize>| -> Option<BTreeMap<String, usize>> {
            if let Some(split) = splits
                .iter()
                .find(|s| Some(&s.option) == params.get(&format!("t{n}.breakdown")))
            {
                if split.member {
                    params.remove(&format!("t{n}.{}", split.dim));
                }
                if !params
                    .get(&years_key)
                    .is_some_and(|y| split.years.contains(y))
                {
                    params.insert(years_key.clone(), *split.years.first()?);
                }
            }
            Some(params)
        };
        let base: BTreeMap<String, usize> = items
            .iter()
            .map(|(k, _)| (k.clone(), given.get(k).copied().unwrap_or(1)))
            .collect();
        for (key, count) in &asked {
            for option in (1..=*count).filter(|o| Some(o) != base.get(key)) {
                let mut params = base.clone();
                params.insert(key.clone(), option);
                if let Some(params) = shaped(params).filter(|p| self.holds(n, p)) {
                    return Some(params);
                }
            }
        }
        let mut odometer = vec![1usize; asked.len()];
        for _ in 0..HELD_EXAMPLE_TRIES {
            let mut params = base.clone();
            for ((key, _), option) in asked.iter().zip(&odometer) {
                params.insert(key.clone(), *option);
            }
            if let Some(params) = shaped(params).filter(|p| self.holds(n, p)) {
                return Some(params);
            }
            let i = (0..asked.len()).find(|&i| odometer[i] < asked[i].1)?;
            odometer[i] += 1;
            odometer[..i].fill(1);
        }
        None
    }
}

/// A refused answer: what is wrong, what is allowed and one example; the check itself is never loosened.
#[derive(Clone, Debug, PartialEq)]
pub struct Refused {
    pub problem: String,
    pub allowed: Value,
    pub example: Value,
}

impl Refused {
    /// The text the model gets back.
    pub fn message(&self) -> String {
        json!({"problem": self.problem, "allowed": self.allowed, "example": self.example})
            .to_string()
    }
}

/// Claims picked from each table: the candidate sheet's own bounds (claim_candidates.mjs PICK_MIN, PICK_MAX).
pub const CLAIMS_MIN: usize = 3;
pub const CLAIMS_MAX: usize = 5;

/// Each table's claim numbers (1-based, numbered on across the tables) and how many of them to pick at most.
fn claim_ranges(groups: &[usize]) -> Vec<(std::ops::RangeInclusive<usize>, usize)> {
    let mut first = 1;
    groups
        .iter()
        .map(|&n| {
            let range = first..=first + n - 1;
            first += n;
            (range, n.min(CLAIMS_MAX))
        })
        .collect()
}

/// The pick rule in words, with each table's range when there are several.
fn claims_rule(groups: &[usize]) -> String {
    let ranges = claim_ranges(groups);
    if let [(_, most)] = ranges.as_slice() {
        return format!("pick must list {CLAIMS_MIN} to {most} different claim numbers");
    }
    let parts: Vec<String> = ranges
        .iter()
        .enumerate()
        .map(|(i, (range, most))| {
            format!(
                "{CLAIMS_MIN} to {most} of claims {}-{} (table {})",
                range.start(),
                range.end(),
                i + 1
            )
        })
        .collect();
    format!(
        "pick must list different claim numbers: {}",
        parts.join(", ")
    )
}

impl Ask {
    fn step(&self) -> &'static str {
        match self {
            Ask::Search => "search",
            Ask::Table { .. } => "table",
            Ask::Claims { .. } => "claims",
            Ask::Text { .. } => "text",
            Ask::Vision { .. } => "vision",
        }
    }

    /// The tool's parameters for this request.
    pub fn schema(&self) -> Value {
        let step = json!({"type": "string", "enum": [self.step()]});
        match self {
            Ask::Search => {
                json!({"type": "object", "additionalProperties": false, "required": ["step", "query"],
                "properties": {"step": step, "query": {"type": "string", "pattern": SEARCH_PATTERN, "maxLength": SEARCH_MAX_CHARS,
                    "description": format!("English words (letters, digits, spaces, hyphens, + and .: CO2, aged 65+), at most {SEARCH_MAX_CHARS} characters; used only to search the catalogue")}}})
            }
            Ask::Table {
                count, most, items, ..
            } => {
                let mut schema = json!({"type": "object", "additionalProperties": false, "required": ["step", "pick"],
                "properties": {"step": step, "pick": {"type": "array", "minItems": 1, "maxItems": most, "uniqueItems": true,
                    "items": {"type": "integer", "enum": (0..=*count).collect::<Vec<_>>()},
                    "description": format!("the numbers of the tables, at most {most}; [0] if none of them fits")}}});
                if !items.is_empty() {
                    schema["required"] = json!(["step", "pick", "params"]);
                    schema["properties"]["params"] = json!({"type": "object", "additionalProperties": false,
                        "properties": items.iter().flatten().map(|(k, count)| (k.clone(), json!({"type": "integer", "enum": (1..=*count).collect::<Vec<_>>()}))).collect::<Map<_, _>>(),
                        "description": "item -> the number of the option that fits the question, for every item of each picked table and no other, except an item its breakdown says to leave out"});
                }
                schema
            }
            Ask::Claims { groups, relations } => {
                let total: usize = groups.iter().sum();
                let most: usize = claim_ranges(groups).iter().map(|(_, most)| most).sum();
                let mut properties = json!({"step": step, "pick": {"type": "array", "minItems": CLAIMS_MIN * groups.len(), "maxItems": most,
                    "uniqueItems": true, "items": {"type": "integer", "enum": (1..=total).collect::<Vec<_>>()},
                    "description": claims_rule(groups).replacen("pick must list", "the numbers of the claims:", 1)}});
                let mut required = vec!["step", "pick"];
                if *relations > 1 {
                    properties["relation"] = json!({"type": "integer", "enum": (1..=*relations).collect::<Vec<_>>(),
                        "description": "the number of the relation"});
                    required.push("relation");
                }
                json!({"type": "object", "additionalProperties": false, "required": required, "properties": properties})
            }
            Ask::Text {
                fields,
                slots,
                numbers,
                periods,
            } => {
                json!({"type": "object", "additionalProperties": false, "required": ["step", "text", "names"],
                "properties": {"step": step,
                    "text": {"type": "object", "additionalProperties": false,
                        "properties": fields.keys().map(|k| (k.clone(), json!({"type": "string"}))).collect::<Map<_, _>>(),
                        "description": format!("field number -> revised wording; leave a field out to keep the draft; keep every {{placeholder}}; {}; {NUMBER_WORD_RULE}{}", typed_rule(numbers), period_rule(periods))},
                    "names": {"type": "object", "additionalProperties": false, "required": slots,
                        "properties": slots.iter().map(|k| (k.clone(), json!({"type": "string"}))).collect::<Map<_, _>>(),
                        "description": format!("untranslated slot number -> Chinese name, at most {NAME_MAX_CHARS} characters, no number; {NUMBER_WORD_RULE}")}}})
            }
            Ask::Vision { modules } => {
                let mark = json!({"type": "integer", "minimum": 0, "maximum": 100});
                json!({"type": "object", "additionalProperties": false, "required": ["step", "score", "confidence", "rubric", "issues"],
                "properties": {"step": step, "score": {"type": "integer", "minimum": 0, "maximum": 100, "description": "the whole page, 0-100"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "rubric": {"type": "object", "additionalProperties": false, "required": VISION_RUBRIC,
                        "properties": VISION_RUBRIC.iter().map(|k| (k.to_string(), mark.clone())).collect::<Map<_, _>>()},
                    "issues": {"type": "array", "maxItems": VISION_ISSUES_MAX, "items": {"type": "object", "additionalProperties": false,
                        "required": ["severity", "code", "evidence", "recommendation"],
                        "properties": {"severity": {"type": "string", "enum": VISION_SEVERITIES},
                            "code": {"type": "string", "pattern": "^[a-z_]{1,40}$"},
                            "module_id": {"type": "string", "enum": modules},
                            "evidence": {"type": "string", "maxLength": VISION_TEXT_MAX, "description": "what is visible in the image"},
                            "recommendation": {"type": "string", "maxLength": VISION_TEXT_MAX}}},
                        "description": "visible defects only; blocker only for clipping, unreadable text, severe overlap or broken hierarchy"}}})
            }
        }
    }

    fn example(&self) -> Value {
        match self {
            Ask::Search => json!({"step": "search", "query": "<english words>"}),
            Ask::Table { items, .. } => table_answer(&[1], items, |_| json!(1)),
            Ask::Claims { groups, relations } => {
                let pick: Vec<usize> = claim_ranges(groups)
                    .into_iter()
                    .flat_map(|(range, _)| range.take(CLAIMS_MIN))
                    .collect();
                let mut example = json!({"step": "claims", "pick": pick});
                if *relations > 1 {
                    example["relation"] = json!(1);
                }
                example
            }
            Ask::Text { slots, .. } => json!({"step": "text", "text": {},
                "names": slots.iter().map(|k| (k.clone(), json!("<中文名>"))).collect::<Map<_, _>>()}),
            Ask::Vision { .. } => json!({"step": "vision", "score": 85, "confidence": 0.8,
                "rubric": VISION_RUBRIC.iter().map(|k| (k.to_string(), json!(80))).collect::<Map<_, _>>(),
                "issues": [{"severity": "warning", "code": "label_overlap", "evidence": "<what the image shows>", "recommendation": "<what to change>"}]}),
        }
    }

    fn allowed(&self) -> Value {
        match self {
            Ask::Search => {
                json!({"step": "search", "query": SEARCH_PATTERN, "max_chars": SEARCH_MAX_CHARS})
            }
            Ask::Table {
                count, most, items, ..
            } => {
                let mut allowed = table_answer(&(0..=*count).collect::<Vec<_>>(), items, |count| {
                    json!((1..=count).collect::<Vec<_>>())
                });
                allowed["most"] = json!(most);
                allowed
            }
            Ask::Claims { groups, relations } => {
                let total: usize = groups.iter().sum();
                let mut allowed = json!({"step": "claims", "pick": (1..=total).collect::<Vec<_>>(),
                    "per_table": claim_ranges(groups).into_iter().map(|(range, most)|
                        json!({"claims": [range.start(), range.end()], "min": CLAIMS_MIN, "max": most})).collect::<Vec<_>>()});
                if *relations > 1 {
                    allowed["relation"] = json!((1..=*relations).collect::<Vec<_>>());
                }
                allowed
            }
            Ask::Text {
                fields,
                slots,
                numbers,
                periods,
            } => {
                let mut allowed = json!({"step": "text",
                "text": fields.iter().map(|(k, draft)| (k.clone(), json!(draft))).collect::<Map<_, _>>(), "names": slots,
                "name_max_chars": NAME_MAX_CHARS, "numbers": numbers});
                if !periods.is_empty() {
                    allowed["periods"] = json!(periods);
                }
                allowed
            }
            Ask::Vision { modules } => {
                json!({"step": "vision", "score": [0, 100], "confidence": [0, 1], "rubric": VISION_RUBRIC,
                "rubric_item": [0, 100], "issues_max": VISION_ISSUES_MAX, "severity": VISION_SEVERITIES, "module_id": modules,
                "text_max_chars": VISION_TEXT_MAX})
            }
        }
    }

    fn refuse(&self, problem: impl Into<String>) -> Refused {
        Refused {
            problem: problem.into(),
            allowed: self.allowed(),
            example: self.example(),
        }
    }

    /// The answer with each value the schema types as an object, sent instead as a string holding exactly one JSON object,
    /// decoded once (a tool-call transport may stringify a nested object); returns the decoded keys. Nothing else changes:
    /// the check runs on the decoded answer as on any other.
    pub fn decode(&self, args: &Value) -> (Value, Vec<String>) {
        let objects: &[&str] = match self {
            Ask::Text { .. } => &["text", "names"],
            Ask::Table { items, .. } if !items.is_empty() => &["params"],
            _ => &[],
        };
        let mut args = args.clone();
        let mut decoded = Vec::new();
        for key in objects {
            let Some(Value::String(text)) = args.get(*key) else {
                continue;
            };
            if let Ok(object @ Value::Object(_)) = serde_json::from_str::<Value>(text) {
                args[*key] = object;
                decoded.push(key.to_string());
            }
        }
        (args, decoded)
    }

    /// Checks one answer against this request; every rule of the schema is checked here again.
    pub fn check(&self, args: &Value) -> Result<Choice, Refused> {
        let (args, _) = self.decode(args);
        let Value::Object(map) = &args else {
            return Err(self.refuse("the answer is not an object"));
        };
        if map.get("step").and_then(Value::as_str) != Some(self.step()) {
            return Err(self.refuse(format!("step must be \"{}\"", self.step())));
        }
        let keys: &[&str] = match self {
            Ask::Search => &["step", "query"],
            Ask::Table { items, .. } if !items.is_empty() => &["step", "pick", "params"],
            Ask::Table { .. } => &["step", "pick"],
            Ask::Claims { relations, .. } if *relations > 1 => &["step", "pick", "relation"],
            Ask::Claims { .. } => &["step", "pick"],
            Ask::Text { .. } => &["step", "text", "names"],
            Ask::Vision { .. } => &["step", "score", "confidence", "rubric", "issues"],
        };
        if let Some(key) = map.keys().find(|k| !keys.contains(&k.as_str())) {
            return Err(self.refuse(format!("unknown key '{key}'")));
        }
        if let Some(key) = keys.iter().find(|k| !map.contains_key(**k)) {
            return Err(self.refuse(format!("missing key '{key}'")));
        }
        match self {
            Ask::Search => {
                let query = map["query"].as_str().unwrap_or("");
                if !search_query_ok(query) {
                    return Err(self.refuse(format!(
                        "query must be English words: letters, digits, spaces, hyphens, + and .{}",
                        search_offenders(query)
                    )));
                }
                if query.chars().count() > SEARCH_MAX_CHARS {
                    return Err(self.refuse(format!(
                        "query must be at most {SEARCH_MAX_CHARS} characters"
                    )));
                }
                Ok(Choice::Search {
                    query: query.to_string(),
                })
            }
            Ask::Table {
                count,
                most,
                items,
                splits,
                held,
            } => {
                let picks = numbers(&map["pick"]).unwrap_or_default();
                let unique: BTreeSet<_> = picks.iter().collect();
                let picks = match picks.as_slice() {
                    [0] => Vec::new(),
                    _ if (1..=*most).contains(&picks.len())
                        && unique.len() == picks.len()
                        && picks.iter().all(|n| (1..=*count).contains(n)) =>
                    {
                        picks
                    }
                    _ => {
                        return Err(self.refuse(format!(
                            "pick must list one table number, or up to {most} different ones, or only 0 for none"
                        )))
                    }
                };
                if items.is_empty() {
                    return Ok(Choice::Table {
                        picks,
                        params: BTreeMap::new(),
                    });
                }
                // A refused params is answered with the items of the picked tables only.
                let refuse = |problem: String| Refused {
                    problem,
                    allowed: table_answer(&picks, items, |count| {
                        json!((1..=count).collect::<Vec<_>>())
                    }),
                    example: table_answer(&picks, items, |_| json!(1)),
                };
                let wanted = picked_items(&picks, items);
                let Value::Object(given) = &map["params"] else {
                    return Err(refuse(
                        "params must map every item of each picked table to an option number"
                            .into(),
                    ));
                };
                if let Some(key) = given.keys().find(|k| !wanted.iter().any(|(i, _)| i == *k)) {
                    return Err(refuse(format!(
                        "params has no item '{key}' among the items of the picked tables"
                    )));
                }
                // A picked split: its dimension's item is left out, and only the years options it draws with are allowed.
                let mut left_out = Vec::new();
                for &n in &picks {
                    let breakdown = given
                        .get(&format!("t{n}.breakdown"))
                        .and_then(Value::as_u64);
                    let Some(split) = splits
                        .get(n - 1)
                        .into_iter()
                        .flatten()
                        .find(|s| Some(s.option as u64) == breakdown)
                    else {
                        continue;
                    };
                    let (item, years_key) = (
                        format!("t{n}.{}", split.dim),
                        format!("t{n}.{}", next_params::YEARS_KEY),
                    );
                    let refuse_split = |problem: String| {
                        let mut refused = refuse(problem);
                        if let Some(params) = refused.allowed["params"].as_object_mut() {
                            params.remove(&item);
                            params.insert(years_key.clone(), json!(split.years));
                            params.insert(format!("t{n}.breakdown"), json!(split.option));
                        }
                        refused
                    };
                    if split.member && given.contains_key(&item) {
                        return Err(refuse_split(format!(
                            "t{n}.breakdown {} ({}) takes every {} code, so {item} has no place: leave it out, or keep it and set t{n}.breakdown 1",
                            split.option, split.dim, split.dim
                        )));
                    }
                    if let Some(years) = given.get(&years_key).and_then(Value::as_u64).filter(|y| {
                        (1..=next_params::YEARS_OPTIONS.len() as u64).contains(y)
                            && !split.years.contains(&(*y as usize))
                    }) {
                        return Err(refuse_split(format!(
                            "t{n}.breakdown {} ({}) with {years_key} {years} gives a page no filled chart can draw: set {years_key} to one of {:?}, or t{n}.breakdown 1",
                            split.option, split.dim, split.years
                        )));
                    }
                    if split.member {
                        left_out.push(item);
                    }
                }
                let mut params = BTreeMap::new();
                for (key, count) in wanted
                    .into_iter()
                    .filter(|(key, _)| !left_out.contains(key))
                {
                    match given.get(key).and_then(Value::as_u64).map(|n| n as usize) {
                        Some(n) if (1..=*count).contains(&n) => {
                            params.insert(key.clone(), n);
                        }
                        _ => {
                            return Err(refuse(format!(
                            "params needs item '{key}' as one of its option numbers 1 to {count}"
                        )))
                        }
                    }
                }
                // The fetch the answer asks for must hold a series the probe found; refused only with an example that does.
                for &n in &picks {
                    let Some(Some(check)) = held.get(n - 1) else {
                        continue;
                    };
                    let prefix = format!("t{n}.");
                    let mine: BTreeMap<String, usize> = params
                        .iter()
                        .filter(|(k, _)| k.starts_with(&prefix))
                        .map(|(k, v)| (k.clone(), *v))
                        .collect();
                    if check.holds(n, &mine) {
                        continue;
                    }
                    let Some(example) = check.example(
                        n,
                        &mine,
                        &items[n - 1],
                        splits.get(n - 1).map_or(&[][..], Vec::as_slice),
                    ) else {
                        continue;
                    };
                    let mut refused = refuse(format!(
                        "t{n}: Eurostat holds no series for {} (probed before the pick): pick a combination it holds, for example {}",
                        check.asked(n, &mine),
                        example.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")
                    ));
                    if let Some(shown) = refused.example["params"].as_object_mut() {
                        shown.retain(|k, _| !k.starts_with(&prefix));
                        shown.extend(example.iter().map(|(k, v)| (k.clone(), json!(v))));
                    }
                    return Err(refused);
                }
                Ok(Choice::Table { picks, params })
            }
            Ask::Claims { groups, relations } => {
                let picks = numbers(&map["pick"]).unwrap_or_default();
                let unique: BTreeSet<_> = picks.iter().collect();
                let ranges = claim_ranges(groups);
                let in_range = |n: &usize| ranges.iter().any(|(range, _)| range.contains(n));
                let counted = ranges.iter().all(|(range, most)| {
                    (CLAIMS_MIN..=*most)
                        .contains(&picks.iter().filter(|n| range.contains(n)).count())
                });
                if unique.len() != picks.len() || !picks.iter().all(in_range) || !counted {
                    return Err(self.refuse(claims_rule(groups)));
                }
                let relation = if *relations > 1 {
                    match map["relation"].as_u64().map(|n| n as usize) {
                        Some(n) if (1..=*relations).contains(&n) => Some(n),
                        _ => {
                            return Err(
                                self.refuse("relation must be one of the listed relation numbers")
                            )
                        }
                    }
                } else {
                    None
                };
                Ok(Choice::Claims { picks, relation })
            }
            Ask::Text {
                fields,
                slots,
                numbers,
                periods,
            } => {
                let text = strings(&map["text"])
                    .ok_or_else(|| self.refuse("text must map field numbers to wording"))?;
                for (id, revised) in &text {
                    let Some(draft) = fields.get(id) else {
                        return Err(self.refuse(format!("text has no field '{id}'")));
                    };
                    if let Err(why) = same_placeholders(draft, revised) {
                        return Err(self.refuse(format!("field '{id}': {why}")));
                    }
                    // Every number on the page comes from the data: a row value through a placeholder, or a label of the picked tables.
                    if let Some(typed) = number_not_allowed(revised, numbers) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{typed}' is a typed number; {}; keep the drafted {{placeholders}}",
                            typed_rule(numbers)
                        )));
                    }
                    if let Some(word) = worded_number(revised) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{word}' is a number in words (a count, a multiple, a share, a half) that no data gave; {NUMBER_WORD_RULE}; keep the drafted {{placeholders}} and leave it out"
                        )));
                    }
                    if let Some(written) =
                        year_after_period(revised).filter(|_| !periods.is_empty())
                    {
                        return Err(self
                            .refuse(format!("field '{id}': '{written}'{}", period_rule(periods))));
                    }
                }
                let names = strings(&map["names"])
                    .ok_or_else(|| self.refuse("names must map slot numbers to Chinese names"))?;
                if let Some(id) = names.keys().find(|k| !slots.contains(k)) {
                    return Err(self.refuse(format!("names has no slot '{id}'")));
                }
                if let Some(id) = slots
                    .iter()
                    .find(|k| names.get(*k).is_none_or(|n| n.trim().is_empty()))
                {
                    return Err(self.refuse(format!("names needs slot '{id}'")));
                }
                // Names go on the page as written: a digit there would be a number no data gave, a brace a placeholder.
                if let Some(id) = names.iter().find_map(|(id, name)| {
                    name.chars()
                        .any(|c| c.is_numeric() || c == '{' || c == '}')
                        .then_some(id)
                }) {
                    return Err(self.refuse(format!(
                        "names: slot '{id}' must be a name only, with no digit or brace"
                    )));
                }
                for (id, name) in &names {
                    if let Some(word) = worded_number(name) {
                        return Err(self.refuse(format!("names: slot '{id}' has '{word}', a number in words; a name holds no number: {NUMBER_WORD_RULE}")));
                    }
                    if name.trim().chars().count() > NAME_MAX_CHARS {
                        return Err(self.refuse(format!(
                            "names: slot '{id}' is longer than {NAME_MAX_CHARS} characters"
                        )));
                    }
                    if !name.chars().any(is_han) {
                        return Err(
                            self.refuse(format!("names: slot '{id}' must be a Chinese name"))
                        );
                    }
                }
                Ok(Choice::Text { text, names })
            }
            Ask::Vision { modules } => {
                let mark = |v: &Value| v.as_u64().filter(|n| *n <= 100);
                let score = mark(&map["score"])
                    .ok_or_else(|| self.refuse("score must be a whole number 0 to 100"))?;
                let confidence = map["confidence"]
                    .as_f64()
                    .filter(|c| (0.0..=1.0).contains(c))
                    .ok_or_else(|| self.refuse("confidence must be a number 0 to 1"))?;
                let Value::Object(given) = &map["rubric"] else {
                    return Err(
                        self.refuse("rubric must map every rubric item to a whole number 0 to 100")
                    );
                };
                if let Some(key) = given.keys().find(|k| !VISION_RUBRIC.contains(&k.as_str())) {
                    return Err(self.refuse(format!("rubric has no item '{key}'")));
                }
                let mut rubric = BTreeMap::new();
                for key in VISION_RUBRIC {
                    let value = given.get(key).and_then(mark).ok_or_else(|| {
                        self.refuse(format!("rubric needs '{key}' as a whole number 0 to 100"))
                    })?;
                    rubric.insert(key.to_string(), value);
                }
                let issues = map["issues"]
                    .as_array()
                    .filter(|l| l.len() <= VISION_ISSUES_MAX)
                    .ok_or_else(|| {
                        self.refuse(format!(
                            "issues must be a list of at most {VISION_ISSUES_MAX}"
                        ))
                    })?;
                for (n, issue) in issues.iter().enumerate() {
                    let Value::Object(fields) = issue else {
                        return Err(self.refuse(format!("issue {} is not an object", n + 1)));
                    };
                    if let Some(key) = fields.keys().find(|k| {
                        ![
                            "severity",
                            "code",
                            "module_id",
                            "evidence",
                            "recommendation",
                        ]
                        .contains(&k.as_str())
                    }) {
                        return Err(self.refuse(format!("issue {}: unknown key '{key}'", n + 1)));
                    }
                    if !fields
                        .get("severity")
                        .and_then(Value::as_str)
                        .is_some_and(|s| VISION_SEVERITIES.contains(&s))
                    {
                        return Err(self.refuse(format!(
                            "issue {}: severity must be one of blocker, warning, nit",
                            n + 1
                        )));
                    }
                    let code = fields.get("code").and_then(Value::as_str).unwrap_or("");
                    if code.is_empty()
                        || code.len() > 40
                        || !code.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                    {
                        return Err(self.refuse(format!(
                            "issue {}: code must be 1 to 40 lowercase letters or underscores",
                            n + 1
                        )));
                    }
                    if fields.get("module_id").is_some_and(|m| {
                        !m.as_str().is_some_and(|m| modules.iter().any(|id| id == m))
                    }) {
                        return Err(self.refuse(format!(
                            "issue {}: module_id must be one of the page's modules or left out",
                            n + 1
                        )));
                    }
                    for key in ["evidence", "recommendation"] {
                        let text = fields.get(key).and_then(Value::as_str).unwrap_or("");
                        if text.trim().is_empty() || text.chars().count() > VISION_TEXT_MAX {
                            return Err(self.refuse(format!(
                                "issue {}: {key} must be text of 1 to {VISION_TEXT_MAX} characters",
                                n + 1
                            )));
                        }
                    }
                }
                Ok(Choice::Vision {
                    score,
                    confidence,
                    rubric,
                    issues: issues.clone(),
                })
            }
        }
    }
}

/// The items of the picked tables (1-based table numbers), in pick order.
fn picked_items<'a>(
    picks: &[usize],
    items: &'a [Vec<(String, usize)>],
) -> Vec<&'a (String, usize)> {
    picks
        .iter()
        .filter_map(|n| items.get(n.wrapping_sub(1)))
        .flatten()
        .collect()
}

/// A table answer over `picks`: with items, `params` holds each item of those tables with `value(option count)`.
fn table_answer(
    picks: &[usize],
    items: &[Vec<(String, usize)>],
    value: impl Fn(usize) -> Value,
) -> Value {
    let mut answer = json!({"step": "table", "pick": picks});
    if !items.is_empty() {
        answer["params"] = Value::Object(
            picked_items(picks, items)
                .into_iter()
                .map(|(k, count)| (k.clone(), value(*count)))
                .collect(),
        );
    }
    answer
}

/// English letters, digits, spaces, hyphens, + and . (CO2, 65+, PM2.5), at least one letter. The words reach the catalogue
/// and its event only, so a digit here is a search word and never a number on the page.
pub const SEARCH_PATTERN: &str = "^[A-Za-z0-9 +.-]*[A-Za-z][A-Za-z0-9 +.-]*$";
/// The longest search text: a few words, so it cannot carry a sentence of claims.
pub const SEARCH_MAX_CHARS: usize = 80;

fn search_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '+' | '.')
}

fn search_query_ok(query: &str) -> bool {
    query.chars().any(|c| c.is_ascii_alphabetic()) && query.chars().all(search_char)
}

/// The words of a refused query that hold a character outside the pattern, with those characters, so the refusal names them.
fn search_offenders(query: &str) -> String {
    let bad: Vec<String> = query
        .split_whitespace()
        .filter_map(|word| {
            let chars: BTreeSet<char> = word.chars().filter(|c| !search_char(*c)).collect();
            (!chars.is_empty()).then(|| {
                format!(
                    "'{word}' has {}",
                    chars
                        .iter()
                        .map(|c| format!("'{c}'"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
        })
        .collect();
    if bad.is_empty() {
        "; the query holds no letter".to_string()
    } else {
        format!("; {}", bad.join("; "))
    }
}

fn numbers(value: &Value) -> Option<Vec<usize>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_u64().map(|n| n as usize))
        .collect()
}

fn strings(value: &Value) -> Option<BTreeMap<String, String>> {
    value
        .as_object()?
        .iter()
        .map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
        .collect()
}

/// The `{...}` placeholders of a text, or why its braces do not pair (the claim template rule of claim_candidates.mjs).
pub fn placeholders(text: &str) -> Result<BTreeSet<String>, String> {
    let mut out = BTreeSet::new();
    let mut rest = text;
    while let Some(open) = rest.find(['{', '}']) {
        if rest[open..].starts_with('}') {
            return Err("a } has no {".into());
        }
        let body = &rest[open + 1..];
        let Some(close) = body
            .find(['{', '}'])
            .filter(|i| body[*i..].starts_with('}'))
        else {
            return Err("a { has no }".into());
        };
        out.insert(body[..close].to_string());
        rest = &body[close + 1..];
    }
    Ok(out)
}

/// The numbers a text types outside its `{...}` placeholders (a digit in `{max.v|1}` is the placeholder's own): runs of
/// numeric characters, with a '.' or ',' between two of them kept in the run ("65.4", "1,200").
pub fn typed_numbers(text: &str) -> Vec<String> {
    let outside = outside_placeholders(text);
    let mut runs = Vec::new();
    let mut run = String::new();
    for (i, c) in outside.iter().enumerate() {
        let joins = matches!(c, '.' | ',')
            && !run.is_empty()
            && outside.get(i + 1).is_some_and(|n| n.is_numeric());
        if c.is_numeric() || joins {
            run.push(*c);
        } else if !run.is_empty() {
            runs.push(std::mem::take(&mut run));
        }
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs
}

/// The text with every `{...}` placeholder blanked, one space per character of it.
fn outside_placeholders(text: &str) -> Vec<char> {
    let mut outside = Vec::new();
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => outside.push(c),
            _ => {}
        }
        if depth > 0 || c == '}' {
            outside.push(' ');
        }
    }
    outside
}

/// Chinese numerals. Outside placeholders a run of two or more types a number (五千亿, 二零二三, 十几), and so does one
/// alone but 一 and 几 (两国, 近十年); a run of them or of digits before a RATIO_AFTER word types a multiple or a share.
const NUMERALS: &str = "零〇一二两三四五六七八九十百千万亿几";
/// What makes the numeral before it a multiple or a share (一倍, 一成, 三分之一, 5%, 三个百分点).
const RATIO_AFTER: [&str; 6] = ["倍", "成", "％", "%", "分之", "个百分点"];
/// A multiple or a share with no numeral of its own. 数成 is left out: it is in 少数成员国, 多数成为.
const RATIO_WORDS: [&str; 11] = [
    "一半", "过半", "大半", "半数", "减半", "近半", "逾半", "超半", "翻番", "翻倍", "数倍",
];
/// Words with a numeral that type no number (an adverb, a unit, a term); blanked before the scan, but only after a word:
/// not after a numeral, a QUANTITY_BEFORE word or a placeholder, spaces aside (一千万, 数千万, {x}千万 are numbers). Any
/// other such word is refused, a false refusal the model words around: the page keeps the drafts after REFUSED_ROUNDS,
/// the run goes on.
const NUMBER_FREE: [&str; 11] = [
    "二氧化碳",
    "统一成",
    "一成不变",
    "十分",
    "万一",
    "千万",
    "一一",
    "两者",
    "千瓦",
    "百分比",
    "零售",
];
/// Words that make the numeral after them a number (数千万, 上千万, 近千万).
const QUANTITY_BEFORE: &str = "数上近逾超余多几";

/// The first number a text types in words outside its placeholders: a RATIO_WORDS word; a run of NUMERALS or digits
/// before a RATIO_AFTER word (spaces aside); or a run of NUMERALS, two or more long or one alone but 一 and 几. An
/// ordinal (第一, 第十二) and the NUMBER_FREE words are no number; digits alone are number_not_allowed's.
pub fn worded_number(text: &str) -> Option<String> {
    let numeral = |c: char| c.is_numeric() || NUMERALS.contains(c);
    let mut chars = outside_placeholders(text);
    // outside_placeholders keeps one char per char of the text: a blank where the text has none is a placeholder's.
    let held: Vec<bool> = chars
        .iter()
        .zip(text.chars())
        .map(|(o, t)| *o == ' ' && t != ' ')
        .collect();
    let words: Vec<Vec<char>> = NUMBER_FREE.iter().map(|w| w.chars().collect()).collect();
    for pos in 0..chars.len() {
        let Some(word) = words.iter().find(|w| chars[pos..].starts_with(w)) else {
            continue;
        };
        let before = (0..pos)
            .rev()
            .find(|&j| held[j] || !chars[j].is_whitespace());
        if before
            .is_none_or(|j| !held[j] && !numeral(chars[j]) && !QUANTITY_BEFORE.contains(chars[j]))
        {
            chars[pos..pos + word.len()].fill(' ');
        }
    }
    let outside: String = chars.iter().collect();
    if let Some(word) = RATIO_WORDS.iter().find(|w| outside.contains(*w)) {
        return Some(word.to_string());
    }
    let mut i = 0;
    while i < chars.len() {
        if !numeral(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && (numeral(chars[i])
                || (matches!(chars[i], '.' | ',') && chars.get(i + 1).is_some_and(|&n| numeral(n))))
        {
            i += 1;
        }
        if start > 0 && chars[start - 1] == '第' {
            continue;
        }
        let run: String = chars[start..i].iter().collect();
        let rest: String = chars[i..].iter().collect();
        if let Some(after) = RATIO_AFTER
            .iter()
            .find(|a| rest.trim_start().starts_with(*a))
        {
            return Some(format!("{run}{after}"));
        }
        let chinese = run.chars().any(|c| NUMERALS.contains(c));
        if chinese && (run.chars().count() > 1 || !matches!(run.as_str(), "一" | "几")) {
            return Some(run);
        }
    }
    None
}

/// The first time placeholder of a text written with 年 right after it ("{first.year}年"), as written; a time
/// placeholder is one whose column (its last part) is a TIME_COLUMNS column.
pub fn year_after_period(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let close = open + rest[open..].find('}')?;
        let name = &rest[open + 1..close];
        let column = name.rsplit('.').next().unwrap_or(name);
        let after = rest[close + 1..].trim_start();
        if crate::next_page::TIME_COLUMNS.contains(&column) && after.starts_with('年') {
            return Some(format!("{}年", &rest[open..=close]));
        }
        rest = &rest[close + 1..];
    }
    None
}

/// The rule of a page whose time values are not years, said to the model in the ask and in a refusal; empty on an
/// annual page.
/// TYPED_NUMBER_RULE, or for an ask that lists numbers a wording may type, those numbers.
fn typed_rule(numbers: &[String]) -> String {
    if numbers.is_empty() {
        TYPED_NUMBER_RULE.to_string()
    } else {
        format!("type no number other than these: [{}]", numbers.join(", "))
    }
}

fn period_rule(periods: &[String]) -> String {
    match periods.first() {
        Some(one) => format!(
            "; this page's times are periods, not years (such as {one}): a time placeholder prints the whole period, so write no 年 after it (e.g. '{{first.year}}最高', not '{{first.year}}年最高')"
        ),
        None => String::new(),
    }
}

/// The typed-number rule of the page text, the same as the design pack's claim-template check (newsroom.ts: "every number,
/// years included, must be a placeholder"), with one example; the request, the schema and the refusal all say it in these words.
pub const TYPED_NUMBER_RULE: &str =
    "type no number, years included: a year goes through a {placeholder} or is left out (write 从起始到最近, not 从2016年到2024年)";
/// The number-word rule of the page text, with the examples it refuses.
pub const NUMBER_WORD_RULE: &str = "no number in words either (二十七, 两国, 三倍, 两成, 过半)";
/// Every wording the rules above suggest, each of which must pass the text and the names checks it is offered for.
#[cfg(test)]
pub const RULE_SUGGESTIONS: [&str; 1] = ["从起始到最近"];

/// The first number a text types that is not one of `allowed`.
pub fn number_not_allowed(text: &str, allowed: &[String]) -> Option<String> {
    typed_numbers(text)
        .into_iter()
        .find(|n| !allowed.contains(n))
}

/// A revised field keeps exactly the draft's placeholder set.
pub fn same_placeholders(draft: &str, revised: &str) -> Result<(), String> {
    let want = placeholders(draft)?;
    let got = placeholders(revised)?;
    if want == got {
        return Ok(());
    }
    let missing: Vec<_> = want.difference(&got).map(|p| format!("{{{p}}}")).collect();
    let extra: Vec<_> = got.difference(&want).map(|p| format!("{{{p}}}")).collect();
    Err(format!(
        "the placeholders must stay as drafted (missing: [{}]; not in the draft: [{}])",
        missing.join(", "),
        extra.join(", ")
    ))
}

/// How the replies reach the run, by kind only (never the address). Only `Real` can make a pick count as the model's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelRoute {
    /// The stand-in client of the agent child (agent_serve.rs `standin_model`), whatever its address.
    Standin,
    /// The real client, handed a loopback address (a stand-in relay on this machine).
    Loopback,
    /// The real client, handed an https address that is not loopback.
    Real,
    /// The real client with any other address; the agent child refuses to start with one, so this only names it.
    Other,
}

impl ModelRoute {
    pub fn of(standin: bool, base_url: &str) -> Self {
        if standin {
            ModelRoute::Standin
        } else if crate::anthropic_model::is_loopback(base_url) {
            ModelRoute::Loopback
        } else if base_url
            .get(..8)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        {
            ModelRoute::Real
        } else {
            ModelRoute::Other
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ModelRoute::Standin => "standin",
            ModelRoute::Loopback => "loopback",
            ModelRoute::Real => "real",
            ModelRoute::Other => "other",
        }
    }
}

/// The model as this route uses it: each request is the history and the one tool offered for this step, whose allowed values differ
/// by step. Replies are the loop's assistant messages (`{content:[text|thinking|toolCall], stopReason, usage, errorMessage?}`).
#[async_trait]
pub trait Asker: Send {
    fn route(&self) -> ModelRoute;
    async fn ask(
        &mut self,
        history: &[Value],
        tools: &[ToolDef],
        cancel: &AtomicBool,
    ) -> Option<Value>;
}

const CHOOSE_DESCRIPTION: &str = "Answer the program's current question. `step` names it; give only the listed numbers, or for \
the text step wording that keeps every {placeholder} and has no number. A refused answer comes back with what is allowed and an example.";
/// Answers refused in a row before the step stops; nothing is guessed or retried beyond this.
pub const REFUSED_ROUNDS: usize = 2;
/// The longest Chinese name a Text slot takes (a chart's measure name goes into its title, 40 characters at most).
pub const NAME_MAX_CHARS: usize = 20;

/// A Chinese character (CJK unified ideographs and extension A).
fn is_han(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}')
}
/// The run-folder directory of the request and reply text of each model exchange.
pub const EXCHANGE_DIR: &str = "runtime/model-exchanges";
pub const EXCHANGE_EVENT: &str = "next_model_exchange";

/// What kind of secret an exchange holds; the content itself is never reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretKind {
    /// The handed-over key, or the proxy address or a part of its credentials.
    Handoff,
    AuthorizationHeader,
    BearerToken,
    ApiKeyHeader,
    ApiKeyField,
}

impl SecretKind {
    pub fn name(self) -> &'static str {
        match self {
            SecretKind::Handoff => "handoff secret",
            SecretKind::AuthorizationHeader => "Authorization header",
            SecretKind::BearerToken => "Bearer token",
            SecretKind::ApiKeyHeader => "x-api-key header",
            SecretKind::ApiKeyField => "api key field",
        }
    }
}

/// A Bearer credential is at least this many token characters; "bearer bonds" is a table name, not a credential.
const BEARER_MIN: usize = 20;

/// Whether a listed secret is in a text: as a substring, except an IPv4 address, which counts only where it is not part of a
/// longer number ("110.1.2.35" and "10.1.2.3.5" do not hold 10.1.2.3; "10.1.2.3:443", "(10.1.2.3)" and "10.1.2.3." do).
fn listed_in(text: &str, secret: &str) -> bool {
    if secret.parse::<std::net::Ipv4Addr>().is_err() {
        return text.contains(secret);
    }
    let bytes = text.as_bytes();
    // a neighbour joins the address when it is a digit, or a dot with a digit beyond it
    let joins = |near: Option<&u8>, beyond: Option<&u8>| match near {
        Some(b) if b.is_ascii_digit() => true,
        Some(b'.') => beyond.is_some_and(u8::is_ascii_digit),
        _ => false,
    };
    text.match_indices(secret).any(|(at, _)| {
        let end = at + secret.len();
        let before = joins(
            at.checked_sub(1).map(|i| &bytes[i]),
            at.checked_sub(2).map(|i| &bytes[i]),
        );
        let after = joins(bytes.get(end), bytes.get(end + 1));
        !before && !after
    })
}

/// The first secret found in a text: a listed secret as a whole string, or a header written out; never a lone word.
fn secret_in_text(text: &str, secrets: &[String]) -> Option<SecretKind> {
    if secrets
        .iter()
        .any(|secret| !secret.is_empty() && listed_in(text, secret))
    {
        return Some(SecretKind::Handoff);
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("authorization:") {
        return Some(SecretKind::AuthorizationHeader);
    }
    if lower.match_indices("bearer ").any(|(at, word)| {
        lower[at + word.len()..]
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(b))
            .count()
            >= BEARER_MIN
    }) {
        return Some(SecretKind::BearerToken);
    }
    if lower.contains("x-api-key:") {
        return Some(SecretKind::ApiKeyHeader);
    }
    let field = |name: &str| {
        text.match_indices(name)
            .any(|(at, _)| text[at + name.len()..].trim_start().starts_with(':'))
    };
    if field("\"api_key\"") || field("\"apiKey\"") {
        return Some(SecretKind::ApiKeyField);
    }
    None
}

/// Every string of a value: its keys and leaf strings as they read unescaped.
fn strings_of<'v>(value: &'v Value, out: &mut Vec<&'v str>) {
    match value {
        Value::String(s) => out.push(s),
        Value::Array(list) => list.iter().for_each(|v| strings_of(v, out)),
        Value::Object(map) => map.iter().for_each(|(k, v)| {
            out.push(k);
            strings_of(v, out);
        }),
        _ => {}
    }
}

/// The first secret in the serialized value or in any of its strings.
pub fn secret_in(value: &Value, secrets: &[String]) -> Option<SecretKind> {
    let mut texts = Vec::new();
    strings_of(value, &mut texts);
    let whole = value.to_string();
    std::iter::once(whole.as_str())
        .chain(texts)
        .find_map(|text| secret_in_text(text, secrets))
}

/// A tool call id that can name a file in the run folder.
fn file_safe(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn text_content(text: &str) -> Vec<Value> {
    vec![json!({"type": "text", "text": text})]
}

/// A program call as it came back.
#[derive(Clone, Debug)]
pub struct Called {
    pub content: Vec<Value>,
    pub details: Option<Value>,
    pub is_error: bool,
}

/// Writes the route's events in the agent loop's shapes. Every model reply gets one `turn_end` (program calls never do); every tool call
/// in a reply is an ordinary call (no `auto`); every program call is `auto` with the id `<accepted model call>:auto:<n>` and that call as
/// `auto_parent_call_id`, its result kept whole (`{content, details}`). Before a reply is acted on, the request and reply are scanned for
/// secrets, stored under `runtime/model-exchanges/`, and named with their hashes in a `next_model_exchange` event.
pub struct Recorder<'a> {
    sink: &'a mut (dyn FnMut(Value) + Send),
    run_dir: PathBuf,
    secrets: Vec<String>,
    history: Vec<Value>,
    /// The accepted model call program calls hang under; cleared when the next step is asked.
    parent: Option<String>,
    /// The last accepted model call, kept when a later step is refused (`resume_under_last_accepted`).
    last_accepted: Option<String>,
    /// Where the history of the step asked last begins.
    step_from: usize,
    serial: u64,
    turns: usize,
}

impl<'a> Recorder<'a> {
    /// `secrets`: the handed-over key and the proxy's pieces (llm/client.rs `proxy_secrets`); empty strings are ignored.
    pub fn new(
        sink: &'a mut (dyn FnMut(Value) + Send),
        run_dir: &Path,
        secrets: Vec<String>,
        history: Vec<Value>,
    ) -> Self {
        Self {
            sink,
            run_dir: run_dir.to_path_buf(),
            secrets: secrets.into_iter().filter(|s| !s.is_empty()).collect(),
            history,
            parent: None,
            last_accepted: None,
            step_from: 0,
            serial: 0,
            turns: 0,
        }
    }

    /// After a step that may not stop the run was refused in every round: later program calls hang under the last accepted
    /// model call again, numbered on from its own (no id repeats). False when no step was accepted yet.
    pub fn resume_under_last_accepted(&mut self) -> bool {
        self.parent = self.last_accepted.clone();
        self.parent.is_some()
    }

    pub fn history(&self) -> &[Value] {
        &self.history
    }

    /// The arguments of every tool call the model made in the step asked last, newest first.
    pub fn step_answers(&self) -> Vec<Value> {
        self.history[self.step_from..]
            .iter()
            .rev()
            .filter(|m| m["role"] == "assistant")
            .flat_map(|m| m["content"].as_array().into_iter().flatten().rev())
            .filter(|b| b["type"] == "toolCall")
            .map(|call| call.get("arguments").cloned().unwrap_or(Value::Null))
            .collect()
    }

    pub fn run_dir(&self) -> &Path {
        &self.run_dir
    }

    /// Asks one step: `prompt` goes in as a user message, the model answers with one newsroom_choose call checked against `ask`. A
    /// refused answer goes back with what is allowed and an example; the second refusal in a row stops. Returns the accepted call's id,
    /// which later program calls hang under, and the checked choice.
    pub async fn ask_step(
        &mut self,
        model: &mut (dyn Asker + '_),
        ask: &Ask,
        prompt: &str,
        cancel: &AtomicBool,
    ) -> Result<(String, Choice), Stop> {
        self.ask_step_seeing(model, ask, prompt, &[], cancel).await
    }

    /// ask_step with `images` (image blocks a tool returned, {type: image, data, mimeType}) after the prompt in the user message.
    pub async fn ask_step_seeing(
        &mut self,
        model: &mut (dyn Asker + '_),
        ask: &Ask,
        prompt: &str,
        images: &[Value],
        cancel: &AtomicBool,
    ) -> Result<(String, Choice), Stop> {
        let step = ask.step();
        self.parent = None;
        self.step_from = self.history.len();
        let mut content = text_content(prompt);
        content.extend(images.iter().cloned());
        self.history
            .push(json!({"role": "user", "content": content, "timestamp": now_ms()}));
        let tool = ToolDef {
            name: CHOOSE_TOOL.to_string(),
            description: CHOOSE_DESCRIPTION.to_string(),
            parameters: ask.schema(),
        };
        let mut round = 0;
        loop {
            round += 1;
            let request = json!({
                "tools": [{"name": tool.name, "description": tool.description, "parameters": tool.parameters}],
                "history": self.history,
            });
            let Some(mut reply) = model
                .ask(&self.history, std::slice::from_ref(&tool), cancel)
                .await
            else {
                return Err(Stop::NoReply { step });
            };
            reply["role"] = json!("assistant");
            let calls: Vec<Value> = reply["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| block["type"] == "toolCall")
                .cloned()
                .collect();
            self.turns += 1;
            let single = match calls.as_slice() {
                [call] => Some(call["id"].as_str().unwrap_or("").to_string()),
                _ => None,
            };
            self.record_exchange(single.as_deref(), step, model.route(), &request, &reply)?;
            self.history.push(reply.clone());
            if matches!(reply["stopReason"].as_str(), Some("error" | "aborted")) {
                (self.sink)(json!({"type": "turn_end", "message": reply, "toolResults": []}));
                let error = reply["errorMessage"]
                    .as_str()
                    .unwrap_or("aborted")
                    .to_string();
                return Err(Stop::ModelFailed { step, error });
            }
            let mut accepted = None;
            let mut refused = None;
            let mut results = Vec::new();
            for call in &calls {
                let id = call["id"].as_str().unwrap_or("").to_string();
                let name = call["name"].as_str().unwrap_or("").to_string();
                let args = call.get("arguments").cloned().unwrap_or(json!({}));
                (self.sink)(
                    json!({"type": "tool_execution_start", "toolCallId": id, "toolName": name, "args": args}),
                );
                let mut decoded = Vec::new();
                let outcome = if calls.len() != 1 {
                    Err(ask.refuse(format!(
                        "answer with exactly one {CHOOSE_TOOL} call; this reply has {}",
                        calls.len()
                    )))
                } else if name != CHOOSE_TOOL {
                    Err(ask.refuse(format!("the only tool of this step is {CHOOSE_TOOL}")))
                } else {
                    decoded = ask.decode(&args).1;
                    ask.check(&args)
                };
                let (text, is_error) = match outcome {
                    Ok(choice) => {
                        accepted = Some((id.clone(), choice));
                        ("accepted".to_string(), false)
                    }
                    Err(why) => {
                        let text = why.message();
                        refused = Some(why.problem);
                        (text, true)
                    }
                };
                let content = text_content(&text);
                let mut end = json!({"type": "tool_execution_end", "toolCallId": id, "toolName": name,
                    "result": {"content": content}, "isError": is_error});
                if !decoded.is_empty() {
                    end["decoded"] = json!(decoded);
                }
                (self.sink)(end);
                let message = json!({"role": "toolResult", "toolCallId": id, "toolName": name, "content": content,
                    "isError": is_error, "timestamp": now_ms()});
                self.history.push(message.clone());
                results.push(message);
            }
            (self.sink)(json!({"type": "turn_end", "message": reply, "toolResults": results}));
            if let Some((id, choice)) = accepted {
                self.parent = Some(id.clone());
                self.last_accepted = Some(id.clone());
                self.serial = 0;
                return Ok((id, choice));
            }
            let problem = refused.unwrap_or_else(|| {
                let why = ask.refuse(format!("answer with one {CHOOSE_TOOL} call"));
                let text = why.message();
                self.history.push(
                    json!({"role": "user", "content": text_content(&text), "timestamp": now_ms()}),
                );
                why.problem
            });
            if round >= REFUSED_ROUNDS {
                return Err(Stop::Refused { step, problem });
            }
        }
    }

    /// Scans, stores and names one exchange. A reply with exactly one tool call is filed under that call's id, any other under its turn.
    fn record_exchange(
        &mut self,
        call_id: Option<&str>,
        step: &'static str,
        route: ModelRoute,
        request: &Value,
        reply: &Value,
    ) -> Result<(), Stop> {
        if let Some(id) = call_id.filter(|id| !file_safe(id)) {
            return Err(Stop::Exchange {
                step,
                why: format!("the tool call id cannot name a file ({} bytes)", id.len()),
            });
        }
        let record = json!({"request": request, "reply": reply});
        if let Some(kind) = secret_in(&record, &self.secrets) {
            return Err(Stop::SecretInExchange { step, kind });
        }
        let name = call_id.map_or_else(|| format!("turn-{}", self.turns), str::to_string);
        let file = format!("{EXCHANGE_DIR}/{name}.json");
        let dir = self.run_dir.join(EXCHANGE_DIR);
        // Never over an earlier exchange: its event names it by hash, and a rewrite would break the replay.
        crate::group_guard::create_dir_all(&self.run_dir, &dir)
            .and_then(|()| {
                use std::io::Write;
                crate::group_guard::create_new(&self.run_dir, &self.run_dir.join(&file))?
                    .write_all(record.to_string().as_bytes())
            })
            .map_err(|e| Stop::Exchange {
                step,
                why: format!("{file}: {e}"),
            })?;
        (self.sink)(json!({
            "type": EXCHANGE_EVENT,
            "tool_call_id": call_id,
            "step": step,
            "route": route.name(),
            "request_sha256": crate::hash::sha256_bytes(request.to_string().as_bytes()),
            "reply_sha256": crate::hash::sha256_bytes(reply.to_string().as_bytes()),
            "file": file,
        }));
        Ok(())
    }

    /// One program event that is not a tool call (the catalogue's search), hung under the accepted model call of this step like a
    /// program call; with none there it is not written.
    pub fn program_event(&mut self, kind: &str, mut event: Value) -> Result<(), Stop> {
        let Some(parent) = self.parent.clone() else {
            return Err(Stop::NoModelParent {
                tool: kind.to_string(),
            });
        };
        event["type"] = json!(kind);
        event["auto_parent_call_id"] = json!(parent);
        (self.sink)(event);
        Ok(())
    }

    /// One program call, hung under the accepted model call of this step; with none there it does not run. A tool of
    /// another group is not run here but through that group's command (`prepare` for the knowledge group's fetch).
    pub async fn auto<R: ToolRunner + Send + ?Sized>(
        &mut self,
        tools: &mut R,
        tool: &str,
        args: Value,
        cancel: &AtomicBool,
    ) -> Result<Called, Stop> {
        let (parent, id) = self.begin(tool, &args)?;
        let mut progress = Vec::new();
        let outcome = tools.run(tool, &args, cancel, &mut progress).await;
        let run = ToolRun {
            outcome,
            progress,
            notes: tools.take_notes(),
        };
        Ok(self.finish(&parent, &id, tool, &args, run))
    }

    /// The knowledge group's fetch (`DATA_PREPARE_TOOL`), run through that group's command and recorded as a program call
    /// like any other; the command's own call is kept as a `GROUP_CALL_EVENT` (record_group_calls).
    pub async fn prepare<R: ToolRunner + Send + ?Sized>(
        &mut self,
        catalogue: &dyn Catalogue,
        tools: &mut R,
        args: Value,
        cancel: &AtomicBool,
    ) -> Result<Called, Stop> {
        let (parent, id) = self.begin(DATA_PREPARE_TOOL, &args)?;
        let run = catalogue
            .data_prepare(lend(tools, cancel), args.clone())
            .await;
        Ok(self.finish(&parent, &id, DATA_PREPARE_TOOL, &args, run))
    }

    /// The visual group's image-aware critic (`next_visual::VISION_CRITIC_TOOL`), run through that group's command and
    /// recorded like `prepare`.
    pub async fn vision_critic<R: ToolRunner + Send + ?Sized>(
        &mut self,
        catalogue: &dyn Catalogue,
        tools: &mut R,
        args: Value,
        cancel: &AtomicBool,
    ) -> Result<Called, Stop> {
        let (parent, id) = self.begin(next_visual::VISION_CRITIC_TOOL, &args)?;
        let run = catalogue
            .vision_critic(lend(tools, cancel), args.clone())
            .await;
        Ok(self.finish(&parent, &id, next_visual::VISION_CRITIC_TOOL, &args, run))
    }

    fn begin(&mut self, tool: &str, args: &Value) -> Result<(String, String), Stop> {
        let Some(parent) = self.parent.clone() else {
            return Err(Stop::NoModelParent {
                tool: tool.to_string(),
            });
        };
        self.serial += 1;
        let id = format!("{parent}:auto:{}", self.serial);
        (self.sink)(
            json!({"type": "tool_execution_start", "toolCallId": id, "toolName": tool, "args": args,
            "auto": true, "auto_parent_call_id": parent}),
        );
        Ok((parent, id))
    }

    fn finish(&mut self, parent: &str, id: &str, tool: &str, args: &Value, run: ToolRun) -> Called {
        let ToolRun {
            outcome,
            progress,
            notes,
        } = run;
        for partial in progress {
            (self.sink)(
                json!({"type": "tool_execution_update", "toolCallId": id, "toolName": tool, "args": args,
                "partialResult": partial, "auto": true, "auto_parent_call_id": parent}),
            );
        }
        let (mut content, details, is_error) = match outcome {
            Ok(CallOutcome::Result {
                content,
                details,
                is_error,
            }) => (content, details, is_error),
            Ok(CallOutcome::Error { message, .. }) => (text_content(&message), None, true),
            Err(error) => (text_content(&error.to_string()), None, true),
        };
        for note in notes {
            content.push(json!({"type": "text", "text": format!("\n{note}")}));
        }
        let mut result = json!({"content": content});
        if let Some(details) = &details {
            result["details"] = details.clone();
        }
        (self.sink)(
            json!({"type": "tool_execution_end", "toolCallId": id, "toolName": tool, "result": result,
            "isError": is_error, "auto": true, "auto_parent_call_id": parent}),
        );
        Called {
            content,
            details,
            is_error,
        }
    }
}

/// The knowledge group's fetch tool; the route runs it only as a program call through that group's command.
pub const DATA_PREPARE_TOOL: &str = next_knowledge::DATA_PREPARE_TOOL;

/// One run of a tool on the host, as the host gave it back: its outcome, its progress updates and the host's notes.
pub struct ToolRun {
    pub outcome: anyhow::Result<CallOutcome>,
    pub progress: Vec<Value>,
    pub notes: Vec<String>,
}

/// A run of a tool on the host, which the caller awaits.
pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = ToolRun> + Send + 'a>>;

/// The host lent for one run to the group that owns the tool: that group names the tool and its arguments.
pub type HostRun<'a> = Box<dyn FnOnce(&'static str, Value) -> ToolFuture<'a> + Send + 'a>;

/// Lends the host for one run.
fn lend<'a, R: ToolRunner + Send + ?Sized>(
    tools: &'a mut R,
    cancel: &'a AtomicBool,
) -> HostRun<'a> {
    Box::new(move |tool, args| {
        Box::pin(async move {
            let mut progress = Vec::new();
            let outcome = tools.run(tool, &args, cancel, &mut progress).await;
            ToolRun {
                outcome,
                progress,
                notes: tools.take_notes(),
            }
        })
    })
}
/// Tables the catalogue offers to the table pick.
pub const OFFERED_TABLES: usize = 5;
/// Modes in which newsroom_data_prepare asks for a narrower request; the step's narrowed request is sent once.
const NARROWING_MODES: [&str; 3] = ["too_large", "too_open", "needs_narrowing"];

/// The directory of the catalogue's original files (l5geo.rs); no default.
pub const CATALOGUE_ENV: &str = "NEWS_CATALOG_DIR";
/// The event that keeps what the catalogue returned for the search, whole, for the replay.
pub const CATALOGUE_EVENT: &str = "next_catalogue";
/// The event that keeps how the fetch parameters of the picked tables were filled when no spec was given.
pub const PARAMS_EVENT: &str = "next_params";
/// The event that keeps, before the table pick, each listed table's breakdown options: the ones offered (with the years
/// they draw with) and the ones left out because no filled template draws the shape their fetch would give.
pub const BREAKDOWN_EVENT: &str = "next_breakdown_options";
/// The event that keeps, before the table pick, each listed table's held-series probe: its key and URL, what came back
/// (series, none, or unprobed and why), its milliseconds, the codes it left out and whether the table was dropped.
pub const HELD_EVENT: &str = "next_held_series";
/// Where each probe's reply is saved whole (one file per table), for the replay.
pub const HELD_DIR: &str = "runtime/held-series";
/// A finished run's folder: each probe is answered from the reply saved there and never from the network (a table with no
/// saved reply is unprobed, as an archive from before the probe replays).
pub const HELD_FROM_ENV: &str = "NEXT_HELD_FROM";

/// The event of one call of another group's command: the group, the request's kind, the hashes of the request and the reply,
/// its milliseconds and whether it answered. What came back is kept whole in the events above, as before.
pub const GROUP_CALL_EVENT: &str = "next_group_call";

/// The table catalogue the table pick reads. Ids are as the catalogue names them (a Eurostat code; World Bank "<indicator>@2").
pub trait Catalogue: Sync {
    /// The first five tables for the Chinese question and the English search texts, with the scope and places it judged.
    fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking;
    /// English place names in the search texts that the question does not name. Flagged in the event, never refused.
    fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String>;
    /// SOURCE.json of the catalogue directory: the original files it was made from and their hashes.
    fn source(&self) -> &Value;
    /// The dimensions and codes of one listed table, which the fetch parameters are filled from; None when it has none.
    fn table(&self, _id: &str) -> Option<TableMeta> {
        None
    }
    /// The places the Chinese question names.
    fn places(&self, _question_zh: &str) -> Vec<Place> {
        Vec::new()
    }
    /// The shape of the slice a fetched file varies over, read by the knowledge group against the table's own metadata.
    fn shape(&self, _table: &TableMeta, _csv: &str) -> Result<Shape, String> {
        Err("this catalogue reads no fetched file".into())
    }
    /// One run of the knowledge group's fetch tool on the host, through its door. Here its call is not kept; the product's
    /// catalogue keeps it as a `GROUP_CALL_EVENT`.
    fn data_prepare<'a>(&self, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
        data_prepare_run(&Default::default(), host, args)
    }
    /// One run of the visual group's image-aware critic on the host, through its door; kept as `data_prepare` is.
    fn vision_critic<'a>(&self, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
        vision_critic_run(&Default::default(), host, args)
    }
    /// The tables worth a fetch as companions of `main`, best first, with their catalogue titles (D8); none here.
    fn companion_shortlist(
        &self,
        _main: &str,
    ) -> Vec<(next_knowledge::CompanionCandidate, String)> {
        Vec::new()
    }
    /// A fetched file's rows as the companion overlap reads them.
    fn companion_rows(
        &self,
        _table: &TableMeta,
        _csv: &str,
    ) -> Result<Vec<next_knowledge::CompanionRow>, String> {
        Err("this catalogue reads no fetched file".into())
    }
    /// A fetched file's rows as series rows (the knowledge group's SeriesRows).
    fn series_rows(&self, _table: &TableMeta, _csv: &str) -> Result<Vec<Value>, String> {
        Err("this catalogue reads no fetched file".into())
    }
    /// The companions kept from the fetched rows of the main and of each fetched candidate.
    fn companions(
        &self,
        _main: &str,
        _rows: &BTreeMap<String, Vec<next_knowledge::CompanionRow>>,
    ) -> Vec<next_knowledge::Companion> {
        Vec::new()
    }
    /// Whether a Eurostat unit code adds up (the knowledge group's unit rule, through its door); None when it does not say.
    fn unit_additive(&self, code: &str) -> Option<bool> {
        match knowledge_call(
            &Mutex::new(Vec::new()),
            "unit_additive",
            json!({"code": code}),
            next_knowledge::Request::UnitAdditive { code },
        ) {
            Ok(next_knowledge::Reply::UnitAdditive(additive)) => additive,
            _ => None,
        }
    }
    /// The finest split of `dim` into codes adding up to `total` in a fetched file (the knowledge group's partition, through
    /// its door). Err names why there is none, or why the file could not be read.
    #[allow(dead_code)] // to be wired: the composition chart's split (2e6b6189)
    fn partition(
        &self,
        table: &TableMeta,
        csv: &str,
        dim: &str,
        total: &str,
    ) -> Result<next_knowledge::Partition, String> {
        match knowledge_call(
            &Mutex::new(Vec::new()),
            "partition",
            json!({"table": table.id, "csv_sha256": crate::hash::sha256_bytes(csv.as_bytes()), "dim": dim, "total": total}),
            next_knowledge::Request::Partition {
                table,
                csv,
                dim,
                total,
            },
        )? {
            next_knowledge::Reply::Partition(found) => found,
            _ => Err("the knowledge group answered partition with another reply".into()),
        }
    }
    /// The visual group's ranking of the relations for a shape (next_visual's `call`, through its door).
    fn rank(&self, shape: &Shape, registered: &[&str], used_before: &[Relation]) -> Matched {
        matched_reply(visual_call(
            &Mutex::new(Vec::new()),
            "rank",
            next_visual::Request::Rank {
                shape,
                registered,
                used_before,
            },
        ))
    }
    /// The same in the first-to-last view only, whatever the slice's size (next_visual's `call`, through its door).
    fn rank_first_to_last(
        &self,
        shape: &Shape,
        registered: &[&str],
        used_before: &[Relation],
    ) -> Matched {
        matched_reply(visual_call(
            &Mutex::new(Vec::new()),
            "rank_first_to_last",
            next_visual::Request::RankFirstToLast {
                shape,
                registered,
                used_before,
            },
        ))
    }
    /// The visual group's page plan row for each chart's relation and view, in chart order (next_visual's `call`, through its door).
    fn page_plans(&self, forms: &[(Relation, View)]) -> Vec<&'static PagePlan> {
        page_plans_reply(visual_call(
            &Mutex::new(Vec::new()),
            "page_plan",
            next_visual::Request::PagePlan { forms },
        ))
    }
    /// The Chinese name of each code in the name table's scheme, through the knowledge group's command; Err lists the codes the
    /// table does not hold (a name is never translated, and a code is never shown in its place).
    fn zh_names(
        &self,
        scheme: &str,
        codes: &[String],
    ) -> Result<BTreeMap<String, String>, Vec<String>> {
        zh_names_reply(knowledge_call(
            &Mutex::new(Vec::new()),
            "zh_names",
            json!({"scheme": scheme, "codes": codes}),
            next_knowledge::Request::ZhNames { scheme, codes },
        ))
    }
    /// Which of the codes name a country (the knowledge group's Countries, through its door), in the order asked; Err when
    /// this catalogue opens no reference lists.
    fn countries(&self, _codes: &[String]) -> Result<Vec<String>, String> {
        Err("this catalogue opens no reference lists".into())
    }
    /// The members of an aggregate geo code (the knowledge group's Members, through its door); Err when the member list has
    /// none, or this catalogue opens no reference lists.
    fn members(&self, _aggregate: &str) -> Result<Vec<String>, String> {
        Err("this catalogue opens no reference lists".into())
    }
    /// The `GROUP_CALL_EVENT`s of the group calls made since the last take; none for a catalogue that calls no group.
    fn take_calls(&self) -> Vec<Value> {
        Vec::new()
    }
    /// The held-series probe of a Eurostat table under `key` (the knowledge group's HeldSeries): its URL and the GET to await.
    /// None for a catalogue that probes nothing; the table then keeps its metabase codes.
    fn held_probe(
        &self,
        _table: &str,
        _key: &[(String, Vec<String>)],
    ) -> Option<(String, next_knowledge::HeldFuture)> {
        None
    }
    /// A probe's reply read by the knowledge group (ReadHeld).
    fn read_held(&self, status: u16, body: &str) -> next_knowledge::Held {
        held_reply(knowledge_call(
            &Mutex::new(Vec::new()),
            "read_held",
            json!({"status": status, "body_sha256": crate::hash::sha256_bytes(body.as_bytes())}),
            next_knowledge::Request::ReadHeld { status, body },
        ))
    }
}

fn held_reply(reply: Result<next_knowledge::Reply, String>) -> next_knowledge::Held {
    match reply {
        Ok(next_knowledge::Reply::Held(held)) => held,
        Ok(_) => unreachable!("the knowledge group answered read_held with another reply"),
        Err(e) => next_knowledge::Held::Unprobed(e),
    }
}

/// The directory of classify's reference lists (iso2.txt, nuts.tsv, ...); without it no fetched file is read into a shape.
pub const CLASSIFY_REFS_ENV: &str = "NEWS_CLASSIFY_REFS";

/// The catalogue read from the directory NEWS_CATALOG_DIR names, once per run, through the knowledge group's command
/// (next_knowledge::call) only: this group keeps the opened handle and every call's `GROUP_CALL_EVENT`, which wait here until
/// the flow records them under the step that asked (`take_calls`).
pub struct GroupCatalogue {
    opened: next_knowledge::Opened,
    /// The classify reference files CLASSIFY_REFS_ENV names, opened with the catalogue: unset or unreadable is a configuration
    /// error before any table is fetched, never a stop after the data is in.
    refs: next_knowledge::OpenedRefs,
    source: Value,
    calls: Calls,
    /// HELD_FROM_ENV: the run whose saved probe replies answer every probe.
    held_from: Option<PathBuf>,
}

impl GroupCatalogue {
    /// Opens the directory (about 1.4 seconds) and the classify references. Either unset, unreadable or not what it should be:
    /// a configuration error.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self, Stop> {
        let dir = get(CATALOGUE_ENV)
            .filter(|d| !d.is_empty())
            .ok_or_else(|| Stop::CatalogueNotConfigured(format!("{CATALOGUE_ENV} is not set")))?;
        let refs_dir = get(CLASSIFY_REFS_ENV)
            .filter(|d| !d.is_empty())
            .ok_or_else(|| {
                Stop::CatalogueNotConfigured(format!("{CLASSIFY_REFS_ENV} is not set"))
            })?;
        let calls = Calls::default();
        let dir = Path::new(&dir);
        let reply = knowledge_call(
            &calls,
            "open_catalogue",
            json!({"dir": dir}),
            next_knowledge::Request::OpenCatalogue { dir },
        )
        .map_err(|e| Stop::CatalogueNotConfigured(format!("{CATALOGUE_ENV}: {e}")))?;
        let next_knowledge::Reply::Opened { catalogue, source } = reply else {
            unreachable!("the knowledge group answered open_catalogue with another reply")
        };
        let dir = Path::new(&refs_dir);
        let request = next_knowledge::Request::OpenRefs { dir };
        let refs = match knowledge_call(&calls, "open_refs", json!({"dir": dir}), request)
            .map_err(|e| Stop::CatalogueNotConfigured(format!("{CLASSIFY_REFS_ENV}: {e}")))?
        {
            next_knowledge::Reply::Refs(refs) => refs,
            _ => unreachable!("the knowledge group answered open_refs with another reply"),
        };
        Ok(Self {
            opened: *catalogue,
            refs,
            source,
            calls,
            held_from: get(HELD_FROM_ENV)
                .filter(|d| !d.is_empty())
                .map(PathBuf::from),
        })
    }

    fn call<'a>(
        &self,
        kind: &'static str,
        args: Value,
        request: next_knowledge::Request<'a>,
    ) -> next_knowledge::Reply<'a> {
        knowledge_call(&self.calls, kind, args, request).unwrap_or_else(|e| {
            unreachable!("the knowledge group refused {kind}, which only reads: {e}")
        })
    }
}

fn zh_names_reply(
    reply: Result<next_knowledge::Reply, String>,
) -> Result<BTreeMap<String, String>, Vec<String>> {
    match reply {
        Ok(next_knowledge::Reply::ZhNames { names, missing }) if missing.is_empty() => Ok(names),
        Ok(next_knowledge::Reply::ZhNames { missing, .. }) => Err(missing),
        Ok(_) => unreachable!("the knowledge group answered zh_names with another reply"),
        Err(e) => Err(vec![e]),
    }
}

/// The group calls a catalogue made and has not handed over yet; a host tool's run adds its own when it ends.
type Calls = std::sync::Arc<Mutex<Vec<Value>>>;

/// A group's host tool run handed back by its door, kept as a `GROUP_CALL_EVENT` once it ends: the run's own time and whether
/// the tool gave a result that is not an error, so the door of every group reads the same in the measure table.
fn door_run<'a>(
    calls: &Calls,
    group: &'static str,
    tool: &'static str,
    args: &Value,
    run: ToolFuture<'a>,
) -> ToolFuture<'a> {
    let calls = calls.clone();
    let request = json!({"request": tool, "args": args});
    Box::pin(async move {
        let started = std::time::Instant::now();
        let run = run.await;
        let ms = started.elapsed().as_millis() as u64;
        let ok = matches!(
            run.outcome,
            Ok(CallOutcome::Result {
                is_error: false,
                ..
            })
        );
        let kept = json!({"run": tool, "ok": ok});
        calls.lock().unwrap_or_else(|e| e.into_inner()).push(json!({"group": group, "request": tool,
            "request_sha256": crate::hash::sha256_bytes(request.to_string().as_bytes()),
            "reply_sha256": crate::hash::sha256_bytes(kept.to_string().as_bytes()), "ms": ms, "ok": ok}));
        run
    })
}

/// The visual group's answer to a run of its critic: the run, which the caller awaits.
fn vision_critic_run<'a>(calls: &Calls, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
    let request = next_visual::Request::VisionCritic {
        host,
        args: args.clone(),
    };
    match visual_call(calls, "vision_critic", request) {
        Ok(next_visual::Reply::Run(run)) => {
            door_run(calls, "visual", next_visual::VISION_CRITIC_TOOL, &args, run)
        }
        Ok(_) => unreachable!("the visual group answered vision_critic with another reply"),
        Err(e) => unreachable!(
            "the visual group refused vision_critic, which only hands back the run: {e}"
        ),
    }
}

/// The knowledge group's answer to a run of its fetch tool: the run, which the caller awaits.
fn data_prepare_run<'a>(calls: &Calls, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
    let request = next_knowledge::Request::DataPrepare {
        host,
        args: args.clone(),
    };
    match knowledge_call(calls, "data_prepare", args.clone(), request) {
        Ok(next_knowledge::Reply::Run(run)) => {
            door_run(calls, "knowledge", DATA_PREPARE_TOOL, &args, run)
        }
        Ok(_) => unreachable!("the knowledge group answered data_prepare with another reply"),
        Err(e) => unreachable!(
            "the knowledge group refused data_prepare, which only hands back the run: {e}"
        ),
    }
}

/// One call of the knowledge group's command, as the system group's door for it (group_guard), timed and kept as a
/// `GROUP_CALL_EVENT` with the hashes of what was asked and what came back. A host tool's run is kept by door_run when it
/// ends, with its own time; the run itself is the program call's own events.
fn knowledge_call<'a>(
    calls: &Mutex<Vec<Value>>,
    kind: &'static str,
    args: Value,
    request: next_knowledge::Request<'a>,
) -> Result<next_knowledge::Reply<'a>, String> {
    use next_knowledge::Reply;
    let started = std::time::Instant::now();
    let reply = crate::group_guard::as_knowledge_call(|| next_knowledge::call(request));
    let ms = started.elapsed().as_millis() as u64;
    let kept = match &reply {
        Err(e) => json!({"error": e}),
        Ok(Reply::Opened { source, .. }) => json!({"source": source}),
        Ok(Reply::Ranking(ranking)) => {
            serde_json::to_value(ranking).unwrap_or_else(|e| json!({"unrecorded": e.to_string()}))
        }
        Ok(Reply::Names(names)) => json!(names),
        Ok(Reply::Members(members)) => json!({"members": members}),
        Ok(Reply::Countries(countries)) => json!({"countries": countries}),
        Ok(Reply::Table(meta)) => json!(meta.as_ref().map(
            |m| json!({"id": m.id, "worldbank": m.worldbank, "dims": m.dims,
            "end_year": m.end_year, "places": m.places})
        )),
        Ok(Reply::Places(places)) => json!(places
            .iter()
            .map(|p| match p {
                Place::Country(iso2) => json!(iso2),
                Place::Region => json!({"region": true}),
            })
            .collect::<Vec<_>>()),
        Ok(Reply::Refs(_)) => json!({"refs": "opened"}),
        // A shape is not JSON; its debug text is kept, as the visual group's calls keep theirs.
        Ok(Reply::Shape(shape)) => json!({"shape": format!("{shape:?}")}),
        Ok(Reply::ZhNames { names, missing }) => json!({"names": names, "missing": missing}),
        Ok(Reply::HeldProbe { url, .. }) => json!({"url": url}),
        Ok(Reply::Held(held)) => json!({"held": format!("{held:?}")}),
        Ok(Reply::UnitAdditive(additive)) => json!(additive),
        Ok(Reply::Partition(Ok(p))) => json!(p),
        Ok(Reply::Partition(Err(reason))) => json!({"none": reason}),
        Ok(Reply::Run(_)) => json!({"run": next_knowledge::DATA_PREPARE_TOOL}),
        Ok(Reply::Shortlist(found)) => json!(found
            .iter()
            .map(|(c, _)| json!({"table": c.id, "adds": c.adds, "grain": c.grain}))
            .collect::<Vec<_>>()),
        Ok(Reply::Rows(rows)) => json!({"rows": rows.len()}),
        Ok(Reply::SeriesRows(rows)) => json!({"rows": rows.len()}),
        Ok(Reply::Companions(found)) => json!(format!("{found:?}")),
    };
    let request = json!({"request": kind, "args": args});
    let event = json!({"group": "knowledge", "request": kind,
        "request_sha256": crate::hash::sha256_bytes(request.to_string().as_bytes()),
        "reply_sha256": crate::hash::sha256_bytes(kept.to_string().as_bytes()), "ms": ms, "ok": reply.is_ok()});
    if !matches!(reply, Ok(Reply::Run(_))) {
        calls.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    }
    reply
}

/// One call of the visual group's command, through the system group's door for it (group_guard), timed and kept as a
/// `GROUP_CALL_EVENT` like the knowledge group's calls. Neither a shape nor a ranking is JSON, so their debug text is hashed.
pub(crate) fn visual_call<'a>(
    calls: &Mutex<Vec<Value>>,
    kind: &'static str,
    request: next_visual::Request<'a>,
) -> Result<next_visual::Reply<'a>, String> {
    use next_visual::{Reply, Request};
    let asked = match &request {
        Request::Rank {
            shape,
            registered,
            used_before,
        }
        | Request::RankFirstToLast {
            shape,
            registered,
            used_before,
        } => format!("{kind} {shape:?} {registered:?} {used_before:?}"),
        Request::PagePlan { forms } => format!("{kind} {forms:?}"),
        Request::VisionCritic { args, .. } => format!("{kind} {args}"),
        Request::Page { spec } => format!("{kind} {spec:?}"),
        Request::LeafPage { page } => format!("{kind} {} {:?}", page.frame, page.ledger),
        Request::LeafFill { knobs, order, runtime, .. } => format!("{kind} {order:?} {} {}", knobs["spec"], runtime.display()),
        Request::BrowserCheck { html, html_sha256, .. } => format!("{kind} {} {html_sha256}", html.display()),
    };
    let started = std::time::Instant::now();
    let reply = crate::group_guard::as_visual_call(|| next_visual::call(request));
    let ms = started.elapsed().as_millis() as u64;
    let kept = match &reply {
        Err(e) => format!("error {e}"),
        Ok(Reply::Matched(matched)) => format!("{matched:?}"),
        Ok(Reply::Plans(plans)) => format!(
            "{:?}",
            plans
                .iter()
                .map(|p| (p.relation, p.grammar, p.visual_grammar))
                .collect::<Vec<_>>()
        ),
        Ok(Reply::Run(_)) => String::new(),
        Ok(Reply::Page(page)) => format!("{} {:?}", page.html, page.ledger),
        Ok(Reply::Leaf(page)) => format!("{} {:?}", page.html, page.records),
        Ok(Reply::Filled(page)) => format!("{:?} {:?}", page.ledger, page.refs),
        Ok(Reply::Checked(report)) => report.to_string(),
    };
    let event = json!({"group": "visual", "request": kind,
        "request_sha256": crate::hash::sha256_bytes(asked.as_bytes()),
        "reply_sha256": crate::hash::sha256_bytes(kept.as_bytes()), "ms": ms, "ok": reply.is_ok()});
    // a host tool's run is kept by door_run when it ends
    if !matches!(reply, Ok(Reply::Run(_))) {
        calls.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    }
    reply
}

/// A published leaf page: its HTML (run-folder relative) and the sha256 of the bytes written there, which the browser
/// check's PASS report and the manifest both name.
#[derive(Debug)]
pub struct Published {
    pub html_ref: String,
    pub html_sha256: String,
}

/// The leaf page published at publications/<slug>/ of the run folder at `root`. The visual group draws and bakes it; its
/// bytes are hashed once and written as they are to index.html, the visual group's browser check spec (QA_SPEC) beside the
/// report folder publications/qa/<slug>/; the visual group runs the check on that file, and only when it says the report is
/// a PASS for the same sha256 is the manifest written, which is what completion counts (artifact.rs
/// measured_publication_gap). Every write is the visual group's, inside its door (group_guard::as_visual_call): one refused
/// leaves no page and nothing after it runs. A FAIL, a PASS for other bytes or no report leaves the page and its report for
/// replay, with no manifest: not published. A slug is written once: when either folder is already there the page is refused
/// before it is drawn, so no new bytes ever sit beside an earlier report or manifest.
pub fn publish_leaf_page(
    calls: &Mutex<Vec<Value>>,
    root: &Path,
    slug: &str,
    page: &next_visual::LeafPage<'_>,
    qa: &crate::next_leaf::Runner,
) -> Result<Published, String> {
    use crate::group_guard::{as_visual_call, create_dir_all, write};
    use next_visual::{Reply, Request};
    let named = !slug.is_empty() && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !named || matches!(slug, "plans" | "qa" | "rejected") {
        return Err(format!("publish: {slug:?} is not a publication folder name"));
    }
    let (dir, out) = (root.join("publications").join(slug), root.join("publications/qa").join(slug));
    if dir.exists() || out.exists() {
        return Err(format!("publish: publications/{slug} was written before; a page is published once, under a new name"));
    }
    let Reply::Leaf(drawn) = visual_call(calls, "leaf_page", Request::LeafPage { page })? else {
        unreachable!("the visual group answered a leaf page with another reply")
    };
    let html_sha256 = crate::hash::sha256_bytes(drawn.html.as_bytes());
    let html_ref = format!("publications/{slug}/index.html");
    let io = |e: std::io::Error| format!("publish: {e}");
    as_visual_call(|| {
        create_dir_all(root, &dir)?;
        write(root, &root.join(&html_ref), &drawn.html)?;
        create_dir_all(root, &out)?;
        write(root, &out.join("spec.json"), next_visual::QA_SPEC)
    })
    .map_err(io)?;
    let check = Request::BrowserCheck {
        qa,
        html: &root.join(&html_ref),
        out: &out,
        html_sha256: &html_sha256,
    };
    visual_call(calls, "browser_check", check)?;
    let manifest = json!({"kind": "leaf_page", "html_ref": html_ref, "html_sha256": html_sha256,
        "qa_ref": format!("publications/qa/{slug}/browser-qa.json")});
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| format!("publish: {e}"))? + "\n";
    as_visual_call(|| write(root, &dir.join("manifest.json"), text)).map_err(io)?;
    Ok(Published { html_ref, html_sha256 })
}

fn matched_reply(reply: Result<next_visual::Reply, String>) -> Matched {
    match reply {
        Ok(next_visual::Reply::Matched(matched)) => matched,
        Ok(_) => unreachable!("the visual group answered rank with another reply"),
        Err(e) => unreachable!("the visual group's ranking cannot fail: {e}"),
    }
}

fn page_plans_reply(reply: Result<next_visual::Reply, String>) -> Vec<&'static PagePlan> {
    match reply {
        Ok(next_visual::Reply::Plans(plans)) => plans,
        Ok(_) => unreachable!("the visual group answered page_plan with another reply"),
        Err(e) => unreachable!("the visual group's page plans cannot fail: {e}"),
    }
}

impl Catalogue for GroupCatalogue {
    fn data_prepare<'a>(&self, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
        data_prepare_run(&self.calls, host, args)
    }

    fn vision_critic<'a>(&self, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
        vision_critic_run(&self.calls, host, args)
    }

    fn companion_shortlist(&self, main: &str) -> Vec<(next_knowledge::CompanionCandidate, String)> {
        let request = next_knowledge::Request::CompanionShortlist {
            catalogue: &self.opened,
            main,
        };
        match self.call("companion_shortlist", json!({"main": main}), request) {
            next_knowledge::Reply::Shortlist(found) => found,
            _ => {
                unreachable!("the knowledge group answered companion_shortlist with another reply")
            }
        }
    }

    fn companion_rows(
        &self,
        table: &TableMeta,
        csv: &str,
    ) -> Result<Vec<next_knowledge::CompanionRow>, String> {
        let request = next_knowledge::Request::CompanionRows {
            refs: &self.refs,
            table,
            csv,
        };
        match knowledge_call(
            &self.calls,
            "companion_rows",
            json!({"table": table.id, "csv_sha256": crate::hash::sha256_bytes(csv.as_bytes())}),
            request,
        )? {
            next_knowledge::Reply::Rows(rows) => Ok(rows),
            _ => unreachable!("the knowledge group answered companion_rows with another reply"),
        }
    }

    fn series_rows(&self, table: &TableMeta, csv: &str) -> Result<Vec<Value>, String> {
        let request = next_knowledge::Request::SeriesRows { table, csv };
        match knowledge_call(
            &self.calls,
            "series_rows",
            json!({"table": table.id, "csv_sha256": crate::hash::sha256_bytes(csv.as_bytes())}),
            request,
        )? {
            next_knowledge::Reply::SeriesRows(rows) => Ok(rows),
            _ => unreachable!("the knowledge group answered series_rows with another reply"),
        }
    }

    fn countries(&self, codes: &[String]) -> Result<Vec<String>, String> {
        let request = next_knowledge::Request::Countries {
            refs: &self.refs,
            codes,
        };
        match knowledge_call(&self.calls, "countries", json!({"codes": codes}), request)? {
            next_knowledge::Reply::Countries(found) => Ok(found),
            _ => unreachable!("the knowledge group answered countries with another reply"),
        }
    }

    fn members(&self, aggregate: &str) -> Result<Vec<String>, String> {
        let request = next_knowledge::Request::Members {
            refs: &self.refs,
            aggregate,
        };
        match knowledge_call(&self.calls, "members", json!({"aggregate": aggregate}), request)? {
            next_knowledge::Reply::Members(found) => Ok(found),
            _ => unreachable!("the knowledge group answered members with another reply"),
        }
    }

    fn companions(
        &self,
        main: &str,
        rows: &BTreeMap<String, Vec<next_knowledge::CompanionRow>>,
    ) -> Vec<next_knowledge::Companion> {
        let request = next_knowledge::Request::Companions {
            catalogue: &self.opened,
            main,
            rows,
        };
        let counts: BTreeMap<&String, usize> = rows.iter().map(|(id, r)| (id, r.len())).collect();
        match self.call("companions", json!({"main": main, "rows": counts}), request) {
            next_knowledge::Reply::Companions(found) => found,
            _ => unreachable!("the knowledge group answered companions with another reply"),
        }
    }

    fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
        let request = next_knowledge::Request::Top5 {
            catalogue: &self.opened,
            question: question_zh,
            texts,
        };
        match self.call(
            "top5",
            json!({"question": question_zh, "texts": texts}),
            request,
        ) {
            next_knowledge::Reply::Ranking(ranking) => ranking,
            _ => unreachable!("the knowledge group answered top5 with another reply"),
        }
    }

    fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
        let request = next_knowledge::Request::PlacesOutside {
            catalogue: &self.opened,
            question: question_zh,
            texts,
        };
        match self.call(
            "places_outside",
            json!({"question": question_zh, "texts": texts}),
            request,
        ) {
            next_knowledge::Reply::Names(names) => names,
            _ => unreachable!("the knowledge group answered places_outside with another reply"),
        }
    }

    fn source(&self) -> &Value {
        &self.source
    }

    fn table(&self, id: &str) -> Option<TableMeta> {
        let request = next_knowledge::Request::Table {
            catalogue: &self.opened,
            id,
        };
        match self.call("table", json!({"id": id}), request) {
            next_knowledge::Reply::Table(meta) => meta,
            _ => unreachable!("the knowledge group answered table with another reply"),
        }
    }

    fn places(&self, question_zh: &str) -> Vec<Place> {
        let request = next_knowledge::Request::Places {
            catalogue: &self.opened,
            question: question_zh,
        };
        match self.call("places", json!({"question": question_zh}), request) {
            next_knowledge::Reply::Places(places) => places,
            _ => unreachable!("the knowledge group answered places with another reply"),
        }
    }

    fn shape(&self, table: &TableMeta, csv: &str) -> Result<Shape, String> {
        let request = next_knowledge::Request::Shape {
            refs: &self.refs,
            table,
            csv,
            ask: None,
        };
        match knowledge_call(
            &self.calls,
            "shape",
            json!({"table": table.id, "csv_sha256": crate::hash::sha256_bytes(csv.as_bytes())}),
            request,
        )? {
            next_knowledge::Reply::Shape(shape) => Ok(shape),
            _ => unreachable!("the knowledge group answered shape with another reply"),
        }
    }

    fn held_probe(
        &self,
        table: &str,
        key: &[(String, Vec<String>)],
    ) -> Option<(String, next_knowledge::HeldFuture)> {
        let request = next_knowledge::Request::HeldSeries {
            table,
            filters: key,
        };
        let reply = knowledge_call(
            &self.calls,
            "held_series",
            json!({"table": table, "key": key}),
            request,
        );
        let (url, live) = match reply {
            Ok(next_knowledge::Reply::HeldProbe { url, reply }) => (url, reply),
            Ok(_) => unreachable!("the knowledge group answered held_series with another reply"),
            Err(e) => (
                String::new(),
                Box::pin(async move { Err(e) }) as next_knowledge::HeldFuture,
            ),
        };
        let Some(from) = &self.held_from else {
            return Some((url, live));
        };
        // A replay: the saved reply, never the network.
        let saved = from.join(HELD_DIR).join(format!("{table}.json"));
        Some((
            url,
            Box::pin(async move {
                let text =
                    std::fs::read_to_string(&saved).map_err(|e| format!("no saved reply: {e}"))?;
                let record: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("the saved reply is not JSON: {e}"))?;
                match (
                    &record["reply"]["status"],
                    &record["reply"]["body"],
                    &record["error"],
                ) {
                    (Value::Number(status), Value::String(body), _) => {
                        Ok((status.as_u64().unwrap_or(0) as u16, body.clone()))
                    }
                    (_, _, Value::String(error)) => Err(error.clone()),
                    _ => Err("the saved reply has neither a reply nor an error".into()),
                }
            }),
        ))
    }

    fn read_held(&self, status: u16, body: &str) -> next_knowledge::Held {
        held_reply(knowledge_call(
            &self.calls,
            "read_held",
            json!({"status": status, "body_sha256": crate::hash::sha256_bytes(body.as_bytes())}),
            next_knowledge::Request::ReadHeld { status, body },
        ))
    }

    fn zh_names(
        &self,
        scheme: &str,
        codes: &[String],
    ) -> Result<BTreeMap<String, String>, Vec<String>> {
        zh_names_reply(knowledge_call(
            &self.calls,
            "zh_names",
            json!({"scheme": scheme, "codes": codes}),
            next_knowledge::Request::ZhNames { scheme, codes },
        ))
    }

    fn rank(&self, shape: &Shape, registered: &[&str], used_before: &[Relation]) -> Matched {
        matched_reply(visual_call(
            &self.calls,
            "rank",
            next_visual::Request::Rank {
                shape,
                registered,
                used_before,
            },
        ))
    }

    fn rank_first_to_last(
        &self,
        shape: &Shape,
        registered: &[&str],
        used_before: &[Relation],
    ) -> Matched {
        matched_reply(visual_call(
            &self.calls,
            "rank_first_to_last",
            next_visual::Request::RankFirstToLast {
                shape,
                registered,
                used_before,
            },
        ))
    }

    fn page_plans(&self, forms: &[(Relation, View)]) -> Vec<&'static PagePlan> {
        page_plans_reply(visual_call(
            &self.calls,
            "page_plan",
            next_visual::Request::PagePlan { forms },
        ))
    }

    fn take_calls(&self) -> Vec<Value> {
        std::mem::take(&mut *self.calls.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Records the group calls the catalogue made since the last time, each as a program event under the current step.
pub fn record_group_calls(
    recorder: &mut Recorder<'_>,
    catalogue: &dyn Catalogue,
) -> Result<(), Stop> {
    for event in catalogue.take_calls() {
        recorder.program_event(GROUP_CALL_EVENT, event)?;
    }
    Ok(())
}

/// One table after the claims pick: the fetch arguments its sheet was made from, the sheet key, and the verified claims
/// newsroom_data_prepare registered (`{candidate, claim_id}` as it returned them).
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    /// The catalogue id of the table.
    pub id: String,
    /// The catalogue title of the table, as the ranking listed it.
    pub title: String,
    /// The fetched file under the run folder (the fetch's filePath).
    pub file: String,
    pub args: Map<String, Value>,
    pub sheet: String,
    pub claims: Vec<Value>,
    /// The place words the catalogue read in the question (the ranking's places_zh, 欧盟 for an EU question): the scope the
    /// table was fetched for, which the page title names.
    pub places_zh: Vec<String>,
    /// The kept companions' fetched files under the run folder as (table, filePath), picked from or not: on the main table
    /// only, empty on every other.
    pub companions: Vec<(String, String)>,
}

/// The spec step that fetches this catalogue table: same dataset, and for a World Bank id the indicator before "@2".
fn step_for<'s>(id: &str, steps: &'s [PrepareStep]) -> Option<&'s PrepareStep> {
    steps.iter().find(|step| {
        let dataset = step.args.get("dataset").and_then(Value::as_str);
        let worldbank = step.args.get("provider").and_then(Value::as_str) == Some("worldbank");
        let code = if worldbank {
            id.strip_suffix("@2")
        } else {
            Some(id)
        };
        dataset.is_some() && dataset == code
    })
}

/// The candidates of a sheet newsroom_data_prepare wrote under the run folder, as (id, text); read from the file, never from the tool text.
fn read_sheet(run_dir: &Path, dataset: &str, key: &str) -> Result<Vec<(String, String)>, Stop> {
    let not_prepared = |mode: &str| Stop::NotPrepared {
        dataset: dataset.to_string(),
        mode: mode.to_string(),
        why: String::new(),
    };
    if key.len() != 16 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(not_prepared(
            "candidates (the sheet key is not 16 hex digits)",
        ));
    }
    let path = run_dir.join(format!("shadow/candidate_sheet-{key}.json"));
    let sheet: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| not_prepared("candidates (the sheet file cannot be read)"))?;
    if sheet["kind"] != "candidate_sheet" || sheet["candidate_only"] != true {
        return Err(not_prepared(
            "candidates (the file is not a candidate sheet)",
        ));
    }
    sheet["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| match (c["id"].as_str(), c["text"].as_str()) {
            (Some(id), Some(text)) => Ok((id.to_string(), text.to_string())),
            _ => Err(not_prepared("candidates (a candidate has no id or text)")),
        })
        .collect()
}

/// How much of a tool's own text a stop keeps.
pub const REASON_MAX_CHARS: usize = 200;

/// The start of a tool result's text, each address (http:// or https:// up to the next space) replaced by <address>.
fn reason(called: &Called) -> String {
    let text = called
        .content
        .iter()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let words: Vec<&str> = text
        .split_whitespace()
        .map(|w| {
            if w.contains("http://") || w.contains("https://") {
                "<address>"
            } else {
                w
            }
        })
        .collect();
    words.join(" ").chars().take(REASON_MAX_CHARS).collect()
}

/// The waits before the second and the third fetch of one request when the source did not answer (source_unreachable); with the
/// first fetch that is the source circuit's own limit of 3 (evidence_gate.mjs createSourceAccessCircuit), which stays as it is.
pub const FETCH_RETRY_WAITS_MS: [u64; 2] = [2_000, 4_000];
/// The event of one more fetch of the same request: the try it starts, the dataset, the last failure (addresses removed) and the wait.
pub const FETCH_RETRY_EVENT: &str = "next_fetch_retry";
/// The event of a fetch that held no row in the years asked and was moved back by newsroom_data_prepare (its details.years_back): the
/// dataset, the years asked, the window looked at and the year fetched instead.
pub const YEARS_BACK_EVENT: &str = "next_years_back";
/// The event of the companion stage (D8): the main table, each candidate the catalogue offered with its seconds and what
/// came of it (fetched, or why it was dropped), the companions kept with their role, and the stage's seconds.
pub const COMPANION_EVENT: &str = "next_companions";
/// The event of a companion whose picked claims did not register: the table and why. The companion is left off the page; the
/// page goes on with the main table and any other companion.
pub const COMPANION_PICKS_EVENT: &str = "next_companion_picks";
/// Tables one page takes, the main table's included (D8).
pub const PAGE_TABLES_MAX: usize = 3;
/// One companion fetch may take this long; past it the fetch is asked to stop, and the host ends it the normal way.
/// Set on the filtered fetch times of 10-28 (research/d8-1028: 12 of 14 tables 0.2-4.8 s, p95 about 5 s).
pub const COMPANION_FETCH_LIMIT: Duration = Duration::from_secs(10);
/// The whole companion stage may take this long: a candidate it has no time left for is not fetched.
pub const COMPANION_STAGE_LIMIT: Duration = Duration::from_secs(20);

/// Whether a failed fetch is the source not answering, and whether one more fetch may help. The words are the source circuit's
/// (evidence_gate.mjs; shared vocabulary): a timeout, a connection that failed, HTTP 429 or 5xx may pass; any other HTTP status is the
/// source's answer, and a host the circuit blocked or marked unreachable is not tried again in this run.
fn source_unreachable(called: &Called) -> Option<bool> {
    if mode_of(called) != "failed" {
        return None;
    }
    let text = called
        .content
        .iter()
        .filter_map(|c| c["text"].as_str())
        .collect::<String>();
    if text.contains("SOURCE_ACCESS_BLOCKED") || text.contains("SOURCE_HOST_UNREACHABLE") {
        return Some(false);
    }
    if !text.contains("SOURCE_ACCESS_FAILED") {
        return None;
    }
    let status = text
        .split("returned HTTP ")
        .nth(1)
        .and_then(|rest| rest.get(..3))
        .and_then(|code| code.parse::<u16>().ok());
    match status {
        Some(code) if code != 429 && code < 500 => None,
        _ => Some(!text.contains("This host will not be tried again in this run.")),
    }
}

/// newsroom_data_prepare with `args`, fetched again with the same args after each FETCH_RETRY_WAITS_MS wait while the source does not
/// answer; one FETCH_RETRY_EVENT per further fetch. A source still not answering stops as SourceUnreachable.
async fn prepare_fetch<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    tools: &mut R,
    catalogue: &dyn Catalogue,
    dataset: &str,
    args: &Map<String, Value>,
    cancel: &AtomicBool,
) -> Result<Called, Stop> {
    let mut called = recorder
        .prepare(catalogue, tools, Value::Object(args.clone()), cancel)
        .await?;
    record_group_calls(recorder, catalogue)?;
    let mut tries = 1;
    while let Some(again) = source_unreachable(&called) {
        let Some(&wait) = FETCH_RETRY_WAITS_MS
            .get(tries - 1)
            .filter(|_| again && !cancel.load(std::sync::atomic::Ordering::Relaxed))
        else {
            return Err(Stop::SourceUnreachable {
                dataset: dataset.to_string(),
                tries,
                why: reason(&called),
            });
        };
        tries += 1;
        recorder.program_event(
            FETCH_RETRY_EVENT,
            json!({"dataset": dataset, "try": tries, "after": reason(&called), "waited_ms": wait}),
        )?;
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
        called = recorder
            .prepare(catalogue, tools, Value::Object(args.clone()), cancel)
            .await?;
        record_group_calls(recorder, catalogue)?;
    }
    Ok(called)
}

/// One fetch through the knowledge group's door, asked to stop once it has taken `limit` (its own stop flag, so the run's
/// is never raised; the run's is mirrored into it). The host ends a stopped call the normal way, so the run's events stay
/// whole. True when the limit was reached.
async fn timed_prepare<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    tools: &mut R,
    catalogue: &dyn Catalogue,
    args: Value,
    cancel: &AtomicBool,
    limit: Duration,
) -> Result<(Called, bool), Stop> {
    let own = AtomicBool::new(false);
    let began = Instant::now();
    let mut stopped = false;
    let run = recorder.prepare(catalogue, tools, args, &own);
    tokio::pin!(run);
    loop {
        tokio::select! {
            done = &mut run => return Ok((done?, stopped)),
            () = tokio::time::sleep(Duration::from_millis(25)) => {
                if !stopped && began.elapsed() > limit {
                    stopped = true;
                    own.store(true, Ordering::SeqCst);
                }
                if cancel.load(Ordering::SeqCst) {
                    own.store(true, Ordering::SeqCst);
                }
            }
        }
    }
}

/// The codes the tool kept when it narrowed the main's open dimension (its `narrow` argument): the members it ranked
/// first, and the total when the fetch held one (Eurostat). A companion is fetched in these, not with that dimension open.
#[derive(Clone, Debug, PartialEq)]
struct Cut {
    dimension: String,
    codes: Vec<String>,
}

/// The main's cut, from its fetch arguments (the dimension: a World Bank narrow record names none) and the tool's
/// details.narrow (the members, and the total when total_held). None when the main was not narrowed.
fn main_cut(args: &Map<String, Value>, details: Option<&Value>) -> Option<Cut> {
    let dimension = args.get("narrow")?["dimension"].as_str()?.to_string();
    let narrow = &details?["narrow"];
    let mut codes: Vec<String> = narrow["members"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect();
    if narrow["total_held"] == json!(true) {
        codes.extend(narrow["total"].as_str().map(String::from));
    }
    (!codes.is_empty()).then_some(Cut { dimension, codes })
}

/// A companion's fetch arguments: the main's years, and each of the main's filters on a dimension the companion also has,
/// fixed to the same codes in the companion's own code list; the main's cut the same way (a World Bank companion's
/// countries are its places). None when one of them cannot be fixed (the companion lists none of the main's codes): open,
/// it would fetch every code of a dimension the main fixed or cut.
fn companion_args(
    main: &Map<String, Value>,
    cut: Option<&Cut>,
    table: &TableMeta,
) -> Option<Map<String, Value>> {
    let mut args = Map::new();
    if table.worldbank {
        args.insert("provider".into(), json!("worldbank"));
    }
    args.insert(
        "dataset".into(),
        json!(table.id.strip_suffix("@2").unwrap_or(&table.id)),
    );
    let mut filters = Vec::new();
    for filter in main
        .get("filters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let dim = filter["dimension"].as_str().unwrap_or("");
        let Some((_, codes)) = table.dims.iter().find(|(d, _)| d == dim) else {
            continue;
        };
        let mut kept: Vec<String> = Vec::new();
        for code in filter["values"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(own) = own_code(dim, code, codes).filter(|c| !kept.contains(c)) {
                kept.push(own);
            }
        }
        if kept.is_empty() {
            return None;
        }
        filters.push(json!({"dimension": dim, "values": kept}));
    }
    if let Some(cut) = cut {
        let kept: Option<Vec<String>> = if table.worldbank {
            (cut.dimension == next_params::WB_PLACE_DIM).then(|| {
                cut.codes
                    .iter()
                    .filter(|c| table.places.iter().any(|(_, id)| id == *c))
                    .cloned()
                    .collect()
            })
        } else {
            table
                .dims
                .iter()
                .find(|(d, _)| *d == cut.dimension)
                .map(|(_, codes)| {
                    let mut kept: Vec<String> = Vec::new();
                    for own in cut
                        .codes
                        .iter()
                        .filter_map(|c| own_code(&cut.dimension, c, codes))
                    {
                        if !kept.contains(&own) {
                            kept.push(own);
                        }
                    }
                    kept
                })
        };
        if let Some(kept) = kept {
            if kept.is_empty() {
                return None;
            }
            filters.push(json!({"dimension": cut.dimension, "values": kept}));
        }
    }
    if !filters.is_empty() {
        args.insert("filters".into(), Value::Array(filters));
    }
    if let Some(years) = main.get("years") {
        args.insert("years".into(), years.clone());
    }
    Some(args)
}

/// The companion's code for one of the main's: the same code when it lists it; for a place, else its one listed version
/// of the same aggregate (EA20 where it lists EA21: the letters before the version, and only when one code has them).
fn own_code(dim: &str, code: &str, codes: &[(String, String)]) -> Option<String> {
    if codes.iter().any(|(c, _)| c == code) {
        return Some(code.to_string());
    }
    let stem = code.trim_end_matches(|c: char| c.is_ascii_digit() || c == '_');
    if dim != "geo" || stem.is_empty() || stem.len() == code.len() {
        return None;
    }
    let mut versions = codes.iter().map(|(c, _)| c).filter(|c| {
        c.strip_prefix(stem)
            .is_some_and(|rest| rest.starts_with(|ch: char| ch.is_ascii_digit()))
    });
    match (versions.next(), versions.next()) {
        (Some(one), None) => Some(one.clone()),
        _ => None,
    }
}

/// A companion the stage kept: its fetch, its candidate sheet, its catalogue title and its role in words.
struct Kept {
    id: String,
    args: Map<String, Value>,
    sheet: String,
    candidates: Vec<(String, String)>,
    title: String,
    role: String,
    /// The fetched file under the run folder (the fetch's filePath).
    file: String,
}

/// What a companion adds to the page, in words for the claims ask and the event.
fn companion_role(companion: &next_knowledge::Companion) -> String {
    match (companion.grain, companion.adds.as_slice()) {
        (Some("M"), _) => "by month".into(),
        (Some(grain), _) => format!("by period {grain}"),
        (None, []) => "a related indicator".into(),
        (None, adds) => format!("by {}", adds.join(", ")),
    }
}

/// The companion stage (D8): the catalogue's shortlist for the main table, each fetched in turn through the knowledge
/// group's door under the main's filters (COMPANION_FETCH_LIMIT each, COMPANION_STAGE_LIMIT in all), and the ones whose
/// rows overlap the main's kept, at most `room`. A candidate that cannot be fetched (a refusal or a queued answer is not
/// data: the tool answers it in another mode than candidates), comes back with no candidate claims, or shares no
/// country-level row is dropped, its reason kept in the event; none stops the page.
#[allow(clippy::too_many_arguments)]
async fn companion_tables<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    tools: &mut R,
    catalogue: &dyn Catalogue,
    main: &str,
    main_args: &Map<String, Value>,
    main_narrowed: Option<&Map<String, Value>>,
    cut: Option<&Cut>,
    main_file: &str,
    room: usize,
    cancel: &AtomicBool,
) -> Result<Vec<Kept>, Stop> {
    let shortlist = catalogue.companion_shortlist(main);
    record_group_calls(recorder, catalogue)?;
    if shortlist.is_empty() || room == 0 {
        return Ok(Vec::new());
    }
    let began = Instant::now();
    let run_dir = recorder.run_dir.clone();
    let read_rows =
        |table: &TableMeta, file: &str| -> Result<Vec<next_knowledge::CompanionRow>, String> {
            let csv = std::fs::read_to_string(run_dir.join(file))
                .map_err(|e| format!("the fetched file cannot be read: {e}"))?;
            let rows = catalogue.companion_rows(table, &csv)?;
            if rows.is_empty() {
                return Err("the fetched file holds no row with a value".into());
            }
            Ok(rows)
        };
    let mut rows = BTreeMap::new();
    let main_rows = catalogue
        .table(main)
        .ok_or_else(|| "the main table is not in the catalogue".to_string())
        .and_then(|meta| read_rows(&meta, main_file));
    record_group_calls(recorder, catalogue)?;
    let mut entries = Vec::new();
    let mut fetched = BTreeMap::new();
    match main_rows {
        Ok(found) => {
            rows.insert(main.to_string(), found);
        }
        Err(why) => {
            entries.push(json!({"table": main, "outcome": format!("main rows unread: {why}")}))
        }
    }
    let shortlist = if rows.contains_key(main) {
        shortlist
    } else {
        Vec::new()
    };
    for (candidate, title) in shortlist {
        let started = Instant::now();
        let meta = catalogue.table(&candidate.id);
        let args = meta
            .as_ref()
            .and_then(|m| companion_args(main_args, cut, m));
        let outcome = match (meta, args) {
            _ if began.elapsed() >= COMPANION_STAGE_LIMIT => {
                Err("the companion stage is out of time".to_string())
            }
            (None, _) => Err("not in the catalogue".to_string()),
            (Some(_), None) => {
                Err("cannot be fixed to the main's codes on a dimension both have".to_string())
            }
            (Some(meta), Some(args)) => {
                // A request the tool finds too large is sent once more as the main's narrowed request, cut to this table.
                let narrowed = main_narrowed
                    .and_then(|n| companion_args(n, cut, &meta))
                    .filter(|n| *n != args);
                let mut result = Err("not fetched".to_string());
                for args in std::iter::once(args).chain(narrowed) {
                    let limit = COMPANION_FETCH_LIMIT
                        .saturating_sub(started.elapsed())
                        .min(COMPANION_STAGE_LIMIT.saturating_sub(began.elapsed()));
                    if limit.is_zero() {
                        result = Err("out of time before the narrowed request".to_string());
                        break;
                    }
                    let (called, stopped) = timed_prepare(
                        recorder,
                        tools,
                        catalogue,
                        Value::Object(args.clone()),
                        cancel,
                        limit,
                    )
                    .await?;
                    record_group_calls(recorder, catalogue)?;
                    let details = called.details.clone().unwrap_or(Value::Null);
                    let key = details["sheet"].as_str().unwrap_or("").to_string();
                    let mode = mode_of(&called);
                    // The tool counts every failed data step since the last candidates and, at two, marks its result runStop. Past the
                    // main's fetches that count can only be reached on companion fetches, which are optional: the companion is dropped
                    // and the page goes on. Every later call is a picks registration, which fails the page on any result but picks.
                    let tool_stop = details["runStop"]["reason"].as_str().map(String::from);
                    result = match mode.as_str() {
                        _ if stopped => Err(format!("stopped at {} s", limit.as_secs_f64())),
                        _ if tool_stop.is_some() => Err(format!(
                            "mode {mode}: the tool's stop {} was reached on companion fetches; the companion stage does not apply it to the page",
                            tool_stop.as_deref().unwrap_or("")
                        )),
                        "candidates" => read_sheet(&recorder.run_dir, &candidate.id, &key)
                            .map_err(|e| format!("the candidate sheet cannot be read: {e:?}"))
                            .and_then(|c| {
                                if c.len() < CLAIMS_MIN {
                                    Err(format!("{} candidate claims", c.len()))
                                } else {
                                    Ok(c)
                                }
                            })
                            .and_then(|c| {
                                let file = details["filePath"].as_str().unwrap_or("");
                                read_rows(&meta, file).map(|r| (c, r, file.to_string()))
                            })
                            .map(|(candidates, found, file)| {
                                rows.insert(candidate.id.clone(), found);
                                fetched.insert(
                                    candidate.id.clone(),
                                    (args, key, candidates, title.clone(), file),
                                );
                            }),
                        mode => Err(format!("mode {mode}: {}", reason(&called))),
                    };
                    if stopped || tool_stop.is_some() || !NARROWING_MODES.contains(&mode.as_str()) {
                        break;
                    }
                }
                result
            }
        };
        entries.push(
            json!({"table": candidate.id, "adds": candidate.adds, "grain": candidate.grain,
            "seconds": started.elapsed().as_secs_f64(),
            "outcome": outcome.err().unwrap_or_else(|| "fetched".into())}),
        );
    }
    let mut kept = catalogue.companions(main, &rows);
    record_group_calls(recorder, catalogue)?;
    kept.truncate(room);
    recorder.program_event(
        COMPANION_EVENT,
        json!({"main": main, "cut": cut.map(|c| json!({"dimension": c.dimension, "codes": c.codes})), "tables": entries,
            "kept": kept.iter().map(|c| json!({"table": c.id, "role": companion_role(c),
                "overlap": {"countries": c.overlap.countries, "aggregates": c.overlap.aggregates, "year": c.overlap.year},
                "axis": format!("{:?}", c.axis)})).collect::<Vec<_>>(),
            "seconds": began.elapsed().as_secs_f64()}),
    )?;
    Ok(kept
        .into_iter()
        .filter_map(|c| {
            let (args, key, candidates, title, file) = fetched.remove(&c.id)?;
            Some(Kept {
                role: companion_role(&c),
                id: c.id,
                args,
                sheet: key,
                candidates,
                title,
                file,
            })
        })
        .collect())
}

/// The mode newsroom_data_prepare returned, or "error" for an error result.
fn mode_of(called: &Called) -> String {
    if called.is_error {
        return "error".into();
    }
    called
        .details
        .as_ref()
        .and_then(|d| d["mode"].as_str())
        .unwrap_or("none")
        .to_string()
}

/// The breakdown options of table `n` the table pick offers: for each, the years options whose fetch (next_params::predicted_shape)
/// has a shape the visual group's rank draws with a filled template (next_run::FILLED_TEMPLATES). An option no years option
/// draws is taken out of the draft, so the items and the fill number the rest from 2 on; a table left with none has no
/// breakdown item. The event keeps the offered options and, for each left out, the shape and the reasons rank gave.
fn drawable_splits(
    draft: &mut next_params::Draft,
    n: usize,
    places: &[Place],
    this_year: i32,
    catalogue: &dyn Catalogue,
) -> (Vec<Split>, Value) {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for (i, dim) in draft.breakdown.iter().enumerate() {
        let mut years = Vec::new();
        let mut why = Vec::new();
        for y in 1..=next_params::YEARS_OPTIONS.len() {
            let picks = BTreeMap::from([
                (format!("t{n}.breakdown"), i + 2),
                (format!("t{n}.{}", next_params::YEARS_KEY), y),
            ]);
            let additive = |code: &str| catalogue.unit_additive(code);
            match next_params::predicted_shape(draft, n, &picks, places, this_year, &additive) {
                Ok(shape) => {
                    let matched = catalogue.rank(&shape, &crate::next_run::FILLED_TEMPLATES, &[]);
                    if matched.candidates.is_empty() {
                        why.push(json!({"years": y, "shape": shape.dims.iter().map(|d| json!([d.dim, d.members])).collect::<Vec<_>>(),
                            "rejected": matched.rejected.iter().map(|r| format!("{:?}: {}", r.relation, r.reason)).collect::<Vec<_>>()}));
                    } else {
                        years.push(y);
                    }
                }
                Err(e) => why.push(json!({"years": y, "error": e})),
            }
        }
        if years.is_empty() {
            dropped.push(json!({"dim": dim, "why": why}));
        } else {
            kept.push((dim.clone(), years));
        }
    }
    draft.breakdown = kept.iter().map(|(dim, _)| dim.clone()).collect();
    let splits: Vec<Split> = kept
        .into_iter()
        .enumerate()
        .map(|(i, (dim, years))| Split {
            option: i + 2,
            member: draft.members.iter().any(|(m, _, _)| *m == dim),
            dim,
            years,
        })
        .collect();
    let offered: Vec<Value> = splits
        .iter()
        .map(|s| json!({"option": s.option, "dim": s.dim, "years": s.years, "member": s.member}))
        .collect();
    (splits, json!({"offered": offered, "dropped": dropped}))
}

/// One listed table after its held-series probe: its metadata with the codes no series holds left out (as listed when it
/// was not probed), what the probe found when it answered, and whether it holds no series at all.
struct Probed {
    meta: Option<TableMeta>,
    held: Option<next_knowledge::Held>,
    none: bool,
}

/// Before the table pick, each listed Eurostat table whose fetch the program fills is probed at once for the series it holds
/// under the fixed part of that fetch (next_params::probe_key), each for at most HELD_TIMEOUT. A probe that times out, errs
/// or gets anything but a csvdata 200 is unprobed: the table keeps its metabase codes, so a probe never stops a run. Each
/// reply is saved under HELD_DIR (error text redacted with the run's secrets) and kept in one HELD_EVENT.
async fn held_tables(
    recorder: &mut Recorder<'_>,
    ids: &[String],
    texts: &[String],
    places: &[Place],
    this_year: i32,
    catalogue: &dyn Catalogue,
) -> Result<Vec<Probed>, Stop> {
    let metas: Vec<Option<TableMeta>> = ids.iter().map(|id| catalogue.table(id)).collect();
    let keys: Vec<Option<next_params::Key>> = metas
        .iter()
        .map(|m| {
            m.as_ref().and_then(|m| {
                next_params::probe_key(
                    &next_params::draft(m.clone(), texts, places),
                    places,
                    this_year,
                )
            })
        })
        .collect();
    let mut probes = Vec::new();
    for (id, key) in ids.iter().zip(&keys) {
        let probe = key
            .as_ref()
            .filter(|_| file_safe(id))
            .and_then(|key| catalogue.held_probe(id, key));
        probes.push(probe.map(|(url, reply)| {
            (
                url,
                tokio::spawn(async move {
                    let started = std::time::Instant::now();
                    let reply = tokio::time::timeout(next_knowledge::HELD_TIMEOUT, reply).await;
                    (reply, started.elapsed().as_millis() as u64)
                }),
            )
        }));
    }
    let redact = |text: &str| {
        recorder.secrets.iter().fold(text.to_string(), |t, secret| {
            t.replace(secret.as_str(), "[REDACTED]")
        })
    };
    let mut out = Vec::new();
    let mut events = Vec::new();
    let mut records = Vec::new();
    for (((id, meta), key), probe) in ids.iter().zip(metas).zip(&keys).zip(probes) {
        let Some((url, task)) = probe else {
            events.push(json!({"table": id, "probed": false, "why": if meta.as_ref().is_some_and(|m| m.worldbank) { "a World Bank table" }
                else if meta.is_none() { "no dimensions listed" } else { "no key: fill refuses the table, or only freq would be fixed" }}));
            out.push(Probed {
                meta,
                held: None,
                none: false,
            });
            continue;
        };
        let key = key.as_ref().expect("a probe has a key");
        let (reply, ms) = match task.await {
            Ok((Ok(reply), ms)) => (reply.map_err(|e| redact(&e)), ms),
            Ok((Err(_), ms)) => (
                Err(format!(
                    "no reply within {} s",
                    next_knowledge::HELD_TIMEOUT.as_secs()
                )),
                ms,
            ),
            Err(e) => (Err(format!("the probe task failed: {e}")), 0),
        };
        let held = match &reply {
            Ok((status, body)) => catalogue.read_held(*status, &redact(body)),
            Err(e) => next_knowledge::Held::Unprobed(e.clone()),
        };
        records.push((id.clone(), match &reply {
            Ok((status, body)) => json!({"url": url, "key": key, "ms": ms, "reply": {"status": status, "body": redact(body)}}),
            Err(e) => json!({"url": url, "key": key, "ms": ms, "error": e}),
        }));
        let mut event = json!({"table": id, "probed": true, "url": url, "key": key, "ms": ms});
        let meta = match (&held, meta) {
            (next_knowledge::Held::Unprobed(why), meta) => {
                event["unprobed"] = json!(why);
                meta
            }
            (next_knowledge::Held::Series { keys, .. }, Some(m)) => {
                event["series"] = json!(keys.len());
                match next_params::held_table(&m, key, &held) {
                    Ok((narrowed, left_out)) => {
                        event["narrowed"] = left_out;
                        Some(narrowed)
                    }
                    Err(why) => {
                        event["no_series"] = json!(why);
                        out.push(Probed {
                            meta: Some(m),
                            held: Some(held),
                            none: true,
                        });
                        events.push(event);
                        continue;
                    }
                }
            }
            (_, None) => None,
        };
        out.push(Probed {
            meta,
            held: Some(held),
            none: false,
        });
        events.push(event);
    }
    // A table that holds no series is dropped before the ask, unless every listed table would be (then the fetch says so, as before).
    let dropping = out.iter().any(|p| !p.none);
    for (event, p) in events.iter_mut().zip(&out) {
        if p.none {
            event["dropped"] = json!(dropping);
        }
    }
    for (id, record) in records {
        let file = recorder.run_dir.join(HELD_DIR).join(format!("{id}.json"));
        let written =
            crate::group_guard::create_dir_all(&recorder.run_dir, &recorder.run_dir.join(HELD_DIR))
                .and_then(|()| {
                    use std::io::Write;
                    crate::group_guard::create_new(&recorder.run_dir, &file)?
                        .write_all(record.to_string().as_bytes())
                });
        if let (Err(e), Some(event)) =
            (written, events.iter_mut().find(|e| e["table"] == json!(id)))
        {
            event["record"] = json!(format!("not saved: {e}"));
        }
    }
    record_group_calls(recorder, catalogue)?;
    // A catalogue that probes nothing (a test's) keeps the events as they were.
    if out.iter().any(|p| p.held.is_some()) {
        recorder.program_event(HELD_EVENT, json!({"tables": events}))?;
    }
    Ok(out)
}

/// With no prepare spec: the fetch arguments of the picked tables (1-based numbers into `drafts`, one per listed table),
/// filled from the catalogue (next_params) with the option numbers the table pick gave, and one PARAMS_EVENT that keeps
/// how each table was filled.
fn fill_steps(
    recorder: &mut Recorder<'_>,
    question: &str,
    picks: &[usize],
    drafts: &[(&String, Option<next_params::Draft>)],
    params: &BTreeMap<String, usize>,
    catalogue: &dyn Catalogue,
) -> Result<Vec<PrepareStep>, Stop> {
    let places = catalogue.places(question);
    record_group_calls(recorder, catalogue)?;
    let this_year = chrono::Datelike::year(&chrono::Local::now());
    let mut steps = Vec::new();
    let mut events = Vec::new();
    for &n in picks {
        let (id, draft) = &drafts[n - 1];
        let draft = draft.as_ref().ok_or_else(|| {
            Stop::TablePickNotWired(format!("the catalogue lists no dimensions for {id}"))
        })?;
        let filled =
            next_params::fill(draft, n, params, &places, this_year).map_err(Stop::NoTable)?;
        events.push(filled.event);
        steps.push(PrepareStep {
            args: filled.args,
            narrowed: None,
        });
    }
    recorder.program_event(
        PARAMS_EVENT,
        json!({"params": if params.is_empty() { "program-only" } else { "model" }, "picks": params, "tables": events}),
    )?;
    Ok(steps)
}

/// From the question to verified claims, in the fixed order: the search words (model) → the catalogue's first five tables, kept whole
/// in a program event →
/// the table pick (model) → for each picked table its fetch with the spec's parameters, narrowed once if asked → its candidate
/// sheet → one claims pick over every table (model) → for each table the fetch again with its sheet and picks, which registers
/// and verifies the claims. Three model calls whatever the number of tables: with no prepare spec the table pick also lists
/// under each table what its fetch parameters leave to the question, answered in the same call (fill_steps). With a spec, a
/// picked table with no step there stops as not wired.
pub async fn prepare_claims<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    tools: &mut R,
    question: &str,
    steps: &[PrepareStep],
    catalogue: &dyn Catalogue,
    cancel: &AtomicBool,
) -> Result<Vec<Prepared>, Stop> {
    let prompt = format!(
        "Question: {question}\nWrite English words to search the data catalogue for tables that answer it."
    );
    let query = match recorder
        .ask_step(model, &Ask::Search, &prompt, cancel)
        .await?
    {
        (_, Choice::Search { query }) => query,
        (_, other) => unreachable!("the search step was answered with {other:?}"),
    };
    // The search words go to the catalogue and into this event only: no later prompt, fetch or page reads them.
    let texts = vec![query];
    let ranking = catalogue.top5(question, &texts);
    recorder.program_event(
        CATALOGUE_EVENT,
        json!({"question": question, "texts": texts, "places_outside": catalogue.places_outside(question, &texts),
            "source": catalogue.source(),
            "ranking": serde_json::to_value(&ranking).map_err(|e| Stop::Exchange {
                step: "search",
                why: format!("the catalogue's ranking cannot be recorded: {e}"),
            })?}),
    )?;
    record_group_calls(recorder, catalogue)?;
    if let Some(uncovered) = &ranking.uncovered {
        return Err(Stop::NoTable(format!(
            "the question asks for {} in {}, which no catalogue has",
            uncovered.level_zh, uncovered.place_zh
        )));
    }
    let mut offers = ranking.candidates;
    offers.truncate(OFFERED_TABLES);
    if offers.is_empty() {
        return Err(Stop::NoTable("the catalogue offers no table".into()));
    }
    // With no spec, each listed table's fetch parameters are drafted from the catalogue before the pick, from the codes its
    // held-series probe found (no fetch).
    let places = if steps.is_empty() {
        catalogue.places(question)
    } else {
        Vec::new()
    };
    let this_year = chrono::Datelike::year(&chrono::Local::now());
    let mut probed = if steps.is_empty() {
        let ids: Vec<String> = offers.iter().map(|t| t.id.clone()).collect();
        held_tables(recorder, &ids, &texts, &places, this_year, catalogue).await?
    } else {
        Vec::new()
    };
    if probed.iter().any(|p| !p.none) {
        let mut none = probed.iter().map(|p| p.none);
        offers.retain(|_| !none.next().unwrap_or(false));
        probed.retain(|p| !p.none);
    }
    let mut drafts: Vec<(&String, Option<next_params::Draft>)> = offers
        .iter()
        .zip(probed.iter_mut())
        .map(|(t, p)| {
            (
                &t.id,
                p.meta
                    .take()
                    .map(|meta| next_params::draft(meta, &texts, &places)),
            )
        })
        .collect();
    record_group_calls(recorder, catalogue)?;
    // Each breakdown option is offered only when the fetch it leads to has a shape a filled template draws (the visual group's rank).
    let splits: Vec<Vec<Split>> = if drafts.is_empty() {
        Vec::new()
    } else {
        let mut events = Vec::new();
        let splits = drafts
            .iter_mut()
            .enumerate()
            .map(|(i, (id, d))| {
                let Some(d) = d.as_mut() else {
                    return Vec::new();
                };
                let (splits, event) = drawable_splits(d, i + 1, &places, this_year, catalogue);
                events.push(
                    json!({"table": id, "offered": event["offered"], "dropped": event["dropped"]}),
                );
                splits
            })
            .collect();
        record_group_calls(recorder, catalogue)?;
        recorder.program_event(BREAKDOWN_EVENT, json!({"tables": events}))?;
        splits
    };
    let items: Vec<Vec<(String, Vec<String>)>> = drafts
        .iter()
        .enumerate()
        .map(|(i, (_, d))| {
            d.as_ref()
                .map_or_else(Vec::new, |d| next_params::items(i + 1, d))
        })
        .collect();
    let mut listed = Vec::new();
    for (i, t) in offers.iter().enumerate() {
        listed.push(format!("{}. {} ({})", i + 1, t.title, t.id));
        if let (Some(table_items), Some((_, Some(d)))) = (items.get(i), drafts.get(i)) {
            listed.extend(next_params::lines(i + 1, d, table_items));
        }
    }
    let most = steps.len().clamp(1, offers.len());
    let params_rule = if items.is_empty() {
        ""
    } else {
        "\nFor each picked table also give params: for each of its items t<n>.<item>, the number of the option that fits the question."
    };
    let prompt = format!(
        "Question: {question}\nTables:\n{}\nPick the table, or up to {most} tables, that answer the question; 0 if none fits.{params_rule}",
        listed.join("\n")
    );
    let ask = Ask::Table {
        count: offers.len(),
        most,
        items: items
            .iter()
            .map(|table_items| {
                table_items
                    .iter()
                    .map(|(k, o)| (k.clone(), o.len()))
                    .collect()
            })
            .collect(),
        splits,
        held: drafts
            .iter()
            .zip(probed.iter_mut())
            .map(|((_, d), p)| {
                Some(HeldCheck {
                    draft: d.clone()?,
                    places: places.clone(),
                    this_year,
                    held: p.held.take()?,
                })
            })
            .collect(),
    };
    let (picks, params) = match recorder.ask_step(model, &ask, &prompt, cancel).await? {
        (_, Choice::Table { picks, params }) => (picks, params),
        (_, other) => unreachable!("the table step was answered with {other:?}"),
    };
    if picks.is_empty() {
        return Err(Stop::NoTable(
            "the model answered that none of the listed tables fits".into(),
        ));
    }
    let ids: Vec<&String> = picks.iter().map(|n| &offers[n - 1].id).collect();
    let chosen: Vec<(&String, PrepareStep)> = if steps.is_empty() {
        ids.iter()
            .copied()
            .zip(fill_steps(
                recorder, question, &picks, &drafts, &params, catalogue,
            )?)
            .collect()
    } else {
        ids.iter()
            .map(|id| {
                step_for(id, steps).cloned().map(|step| (*id, step)).ok_or_else(|| {
                    Stop::TablePickNotWired(format!(
                        "the fetch parameters of {id} are not wired: no {PREPARE_SPEC_ARG} step has that dataset"
                    ))
                })
            })
            .collect::<Result<_, _>>()?
    };
    let mut tables = Vec::new();
    let mut main_file: Option<String> = None;
    let mut main_narrowed: Option<Map<String, Value>> = None;
    let mut cut: Option<Cut> = None;
    for (id, step) in chosen {
        let mut args = step.args.clone();
        let mut called = prepare_fetch(recorder, tools, catalogue, id, &args, cancel).await?;
        if let Some(narrowed) = step
            .narrowed
            .as_ref()
            .filter(|_| NARROWING_MODES.contains(&mode_of(&called).as_str()))
        {
            args = narrowed.clone();
            called = prepare_fetch(recorder, tools, catalogue, id, &args, cancel).await?;
        }
        if let Some(back) = called
            .details
            .as_ref()
            .map(|d| &d["years_back"])
            .filter(|b| b.is_object())
        {
            recorder.program_event(
                YEARS_BACK_EVENT,
                json!({"dataset": id, "asked": back["asked"], "window": back["window"], "used": back["used"], "why": "no row in the years asked"}),
            )?;
        }
        match mode_of(&called).as_str() {
            "candidates" => {}
            "no_candidates" => {
                return Err(Stop::TooFewClaims {
                    dataset: id.clone(),
                })
            }
            mode => {
                return Err(Stop::NotPrepared {
                    dataset: id.clone(),
                    mode: mode.to_string(),
                    why: reason(&called),
                })
            }
        }
        let key = called
            .details
            .as_ref()
            .and_then(|d| d["sheet"].as_str())
            .unwrap_or("")
            .to_string();
        let candidates = read_sheet(&recorder.run_dir, id, &key)?;
        if candidates.len() < CLAIMS_MIN {
            return Err(Stop::TooFewClaims {
                dataset: id.clone(),
            });
        }
        if tables.is_empty() {
            main_narrowed = step.narrowed.clone();
            cut = main_cut(&args, called.details.as_ref());
            main_file = called
                .details
                .as_ref()
                .and_then(|d| d["filePath"].as_str())
                .map(String::from);
        }
        tables.push((id.clone(), args, key, candidates));
    }
    let mut companion_titles = BTreeMap::new();
    let mut companion_files = Vec::new();
    if let (Some((main, main_args, _, _)), Some(file)) = (tables.first().cloned(), main_file) {
        let room = PAGE_TABLES_MAX.saturating_sub(tables.len());
        let found = companion_tables(
            recorder,
            tools,
            catalogue,
            &main,
            &main_args,
            main_narrowed.as_ref(),
            cut.as_ref(),
            &file,
            room,
            cancel,
        )
        .await?;
        for kept in found {
            companion_titles.insert(kept.id.clone(), (kept.title, kept.role));
            companion_files.push((kept.id.clone(), kept.file));
            tables.push((kept.id, kept.args, kept.sheet, kept.candidates));
        }
    }
    let mut lines = vec![format!("Question: {question}")];
    let mut n = 0;
    for (i, (id, _, _, candidates)) in tables.iter().enumerate() {
        let role = companion_titles
            .get(id)
            .map_or(String::new(), |(_, role)| format!(", companion {role}"));
        lines.push(format!("Table {} ({id}{role}):", i + 1));
        for (_, text) in candidates {
            n += 1;
            lines.push(format!("{n}. {text}"));
        }
    }
    let groups: Vec<usize> = tables.iter().map(|(_, _, _, c)| c.len()).collect();
    lines.push(format!(
        "Pick the claims the page should tell, the one that answers the question first: {}.",
        claims_rule(&groups).replacen("pick must list ", "", 1)
    ));
    let ask = Ask::Claims {
        groups,
        relations: 1,
    };
    let picked = match recorder
        .ask_step(model, &ask, &lines.join("\n"), cancel)
        .await?
    {
        (_, Choice::Claims { picks, .. }) => picks,
        (_, other) => unreachable!("the claims step was answered with {other:?}"),
    };
    let mut prepared = Vec::new();
    let mut first = 1;
    for (id, args, key, candidates) in tables {
        let ids: Vec<&str> = picked
            .iter()
            .filter(|p| (first..first + candidates.len()).contains(*p))
            .map(|p| candidates[p - first].0.as_str())
            .collect();
        first += candidates.len();
        let mut with_picks = args.clone();
        with_picks.insert("sheet".into(), json!(key));
        with_picks.insert("picks".into(), json!(ids));
        let called = recorder
            .prepare(catalogue, tools, Value::Object(with_picks), cancel)
            .await?;
        record_group_calls(recorder, catalogue)?;
        let details = called.details.clone().unwrap_or(Value::Null);
        // In the order the model picked them: the first is the claim that answers the question (the page's hero).
        let mut claims = details["claims"].as_array().cloned().unwrap_or_default();
        claims.sort_by_key(|c| {
            c["candidate"]
                .as_str()
                .and_then(|k| ids.iter().position(|id| *id == k))
                .unwrap_or(usize::MAX)
        });
        let mode = mode_of(&called);
        let registered: BTreeSet<&str> = claims
            .iter()
            .filter_map(|c| c["candidate"].as_str())
            .collect();
        let wanted: BTreeSet<&str> = ids.iter().copied().collect();
        let failed =
            if mode != "picks" || !details["runStop"].is_null() || claims.len() != ids.len() {
                let counted = format!(
                    "mode {mode}, {} of {} claims registered",
                    claims.len(),
                    ids.len()
                );
                Some(match details["runStop"]["reason"].as_str() {
                    Some(reason) if mode == "picks" => format!("the run stopped: {reason}"),
                    // a failed step's count may include the companion fetches before it: the mode is what failed here
                    Some(reason) => format!("{counted}; the tool's stop: {reason}"),
                    None => counted,
                })
            } else if registered != wanted {
                Some(format!(
                    "registered candidates {registered:?} are not the picked {wanted:?}"
                ))
            } else {
                None
            };
        if let Some(why) = failed {
            if !companion_titles.contains_key(&id) {
                return Err(Stop::NotRegistered { dataset: id, why });
            }
            recorder.program_event(COMPANION_PICKS_EVENT, json!({"table": id, "why": why}))?;
            continue;
        }
        prepared.push(Prepared {
            file: details["filePath"].as_str().unwrap_or("").to_string(),
            title: offers
                .iter()
                .find(|o| o.id == id)
                .map(|o| o.title.clone())
                .or_else(|| companion_titles.get(&id).map(|(title, _)| title.clone()))
                .unwrap_or_default(),
            id,
            args,
            sheet: key,
            claims,
            places_zh: ranking.places_zh.clone(),
            companions: if prepared.is_empty() {
                std::mem::take(&mut companion_files)
            } else {
                Vec::new()
            },
        });
    }
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::l5geo::{Candidate, Coverage, Scope, Uncovered};

    fn q3_like() -> Value {
        json!([
            {"dataset": "nrg_bal_peh",
             "filters": [{"dimension": "nrg_bal", "values": ["GEP"]}, {"dimension": "geo", "values": ["DE", "FR"]}],
             "years": {"start": 2024, "end": 2024},
             "narrowed": {"dataset": "nrg_bal_peh", "filters": [{"dimension": "geo", "values": ["DE"]}], "years": {"start": 2024, "end": 2024}}},
            {"provider": "worldbank", "dataset": "SP.POP.65UP.TO.ZS", "years": {"start": 2015, "end": 2025}}
        ])
    }

    #[test]
    fn only_exactly_one_turns_the_route_on() {
        assert!(next_selected(Some("1")));
        for off in [None, Some(""), Some("0"), Some("true"), Some(" 1")] {
            assert!(!next_selected(off), "{off:?}");
        }
    }

    #[test]
    fn off_takes_the_model_loop_and_refuses_a_spec() {
        assert_eq!(route(false, None), Ok(Route::ModelLoop));
        let err = route(false, Some(Path::new("spec.json"))).unwrap_err();
        assert!(
            err.contains(PREPARE_SPEC_ARG) && err.contains(NEXT_ENV),
            "{err}"
        );
        assert_eq!(
            route(true, Some(Path::new("spec.json"))),
            Ok(Route::NextFlow {
                prepare_spec: Some(PathBuf::from("spec.json"))
            })
        );
        assert_eq!(
            route(true, None),
            Ok(Route::NextFlow { prepare_spec: None })
        );
    }

    #[test]
    fn each_legacy_switch_is_named_when_it_is_not_what_the_route_needs() {
        let good = |name: &str| match name {
            "NEWSROOM_AGENT" => Some("rust".to_string()),
            "NEWSROOM_SPEED_RECIPES" | "NEWSROOM_LEAN_GATES" => None,
            _ => Some("1".to_string()),
        };
        assert_eq!(legacy_problem(good), None);
        for (name, need) in LEGACY_SWITCHES {
            let bad = |asked: &str| {
                if asked == name {
                    match need {
                        Need::Exactly(_) => None,
                        Need::Off => Some("1".to_string()),
                    }
                } else {
                    good(asked)
                }
            };
            let problem = legacy_problem(bad).unwrap();
            assert!(problem.contains(name), "{problem}");
        }
        // recipes set to anything but "1" is off
        assert_eq!(
            legacy_problem(|n| if n == "NEWSROOM_SPEED_RECIPES" {
                Some("0".into())
            } else {
                good(n)
            }),
            None
        );
    }

    #[test]
    fn no_spec_stops_as_table_pick_not_wired() {
        assert!(matches!(
            prepare_steps(None),
            Err(Stop::TablePickNotWired(_))
        ));
    }

    #[test]
    fn a_two_step_spec_reads_into_two_tables() {
        let steps = prepare_steps(Some(&q3_like().to_string())).unwrap();
        assert_eq!(steps.len(), 2);
        assert!(!steps[0].args.contains_key("narrowed"));
        assert_eq!(steps[0].args["dataset"], "nrg_bal_peh");
        assert_eq!(
            steps[0].narrowed.as_ref().unwrap()["filters"][0]["values"][0],
            "DE"
        );
        assert_eq!(steps[1].args["provider"], "worldbank");
        assert_eq!(steps[1].narrowed, None);
    }

    #[test]
    fn an_unexpanded_reference_is_refused_by_place() {
        let mut spec = q3_like();
        spec[0]["filters"][1]["values"] = json!("$eu27");
        let err = parse_prepare_spec(&spec.to_string()).unwrap_err();
        assert_eq!(
            err,
            Stop::BadSpec("step 1 has an unexpanded reference at /filters/1/values".into())
        );
        let mut inner = q3_like();
        inner[1]["years"] = json!({"start": "$from", "end": 2025});
        assert!(
            matches!(parse_prepare_spec(&inner.to_string()), Err(Stop::BadSpec(why)) if why.contains("step 2") && why.contains("/years/start"))
        );
    }

    #[test]
    fn a_key_outside_the_five_is_refused_not_dropped() {
        for key in ["chart", "measurer_note", "narrowed_note", "search"] {
            let mut spec = q3_like();
            spec[0][key] = json!("x");
            let err = parse_prepare_spec(&spec.to_string()).unwrap_err();
            assert!(
                matches!(&err, Stop::BadSpec(why) if why.contains(&format!("'{key}'"))),
                "{err:?}"
            );
        }
        let mut narrowed = q3_like();
        narrowed[0]["narrowed"]["chart"] = json!({});
        assert!(
            matches!(parse_prepare_spec(&narrowed.to_string()), Err(Stop::BadSpec(why)) if why.contains("narrowed") && why.contains("'chart'"))
        );
        let mut nested = q3_like();
        nested[0]["narrowed"]["narrowed"] = json!({});
        assert!(matches!(
            parse_prepare_spec(&nested.to_string()),
            Err(Stop::BadSpec(_))
        ));
    }

    #[test]
    fn a_search_only_step_stops_as_table_pick_not_wired() {
        let spec = json!([{"search": "China province house prices"}]);
        assert_eq!(
            parse_prepare_spec(&spec.to_string()),
            Err(Stop::TablePickNotWired(
                "step 1 is only a catalogue search".into()
            ))
        );
    }

    #[test]
    fn a_spec_that_is_not_a_list_of_objects_is_refused() {
        for text in [
            "",
            "{}",
            "[]",
            "[1]",
            "[{\"dataset\": \"x\", \"narrowed\": []}]",
        ] {
            assert!(
                matches!(parse_prepare_spec(text), Err(Stop::BadSpec(_))),
                "{text}"
            );
        }
    }

    fn text_ask() -> Ask {
        Ask::Text {
            fields: BTreeMap::from([
                ("1".to_string(), "{max.v.geo}最多（{max.v}）".to_string()),
                ("2".to_string(), "各国发电量".to_string()),
            ]),
            slots: vec!["s1".to_string()],
            numbers: vec!["2023".to_string()],
            periods: Vec::new(),
        }
    }

    #[test]
    fn a_search_query_outside_the_format_is_refused_with_the_format_and_an_example() {
        // Digits, + and . are search words (a formula, an age band); the words reach the catalogue only.
        for good in [
            "EU wind power by country",
            "CO2 emissions per capita",
            "population aged 65+ share",
            "PM2.5 exposure",
            "wind 2024",
        ] {
            assert_eq!(
                Ask::Search.check(&json!({"step": "search", "query": good})),
                Ok(Choice::Search { query: good.into() }),
                "{good}"
            );
        }
        for bad in ["风电", "", "  - ", "65+", "wind_power", "CO2 (tonnes)"] {
            let refused = Ask::Search
                .check(&json!({"step": "search", "query": bad}))
                .unwrap_err();
            assert_eq!(
                refused.example,
                json!({"step": "search", "query": "<english words>"}),
                "{bad}"
            );
            assert!(
                refused
                    .message()
                    .contains("letters, digits, spaces, hyphens, + and ."),
                "{bad}"
            );
        }
        let refused = Ask::Search
            .check(&json!({"step": "search", "query": "CO2 emissions per_capita (t)"}))
            .unwrap_err();
        assert!(
            refused
                .problem
                .ends_with("; 'per_capita' has '_'; '(t)' has '(', ')'"),
            "{}",
            refused.problem
        );
        assert_eq!(refused.allowed["query"], json!(SEARCH_PATTERN));
        assert!(Ask::Search
            .check(&json!({"step": "search", "query": " - "}))
            .unwrap_err()
            .problem
            .ends_with("; the query holds no letter"));
        let longest = "a".repeat(SEARCH_MAX_CHARS);
        assert!(Ask::Search
            .check(&json!({"step": "search", "query": longest}))
            .is_ok());
        let refused = Ask::Search
            .check(&json!({"step": "search", "query": format!("{longest}b")}))
            .unwrap_err();
        assert!(refused.message().contains("at most 80 characters"));
        assert_eq!(refused.allowed["max_chars"], SEARCH_MAX_CHARS);
        assert_eq!(
            Ask::Search.schema()["properties"]["query"]["maxLength"],
            SEARCH_MAX_CHARS
        );
    }

    fn two_tables_with_items() -> Ask {
        Ask::Table {
            count: 2,
            most: 1,
            items: vec![
                vec![("t1.years".into(), 2), ("t1.unit".into(), 3)],
                vec![("t2.years".into(), 2), ("t2.breakdown".into(), 3)],
            ],
            splits: vec![Vec::new(), Vec::new()],
            held: Vec::new(),
        }
    }

    #[test]
    fn a_picked_split_leaves_its_item_out_and_allows_only_the_years_it_draws_with() {
        // sdg_07_40 as in the 13:1x stand-ins: t1.breakdown 2 is nrg_bal, which is also the item t1.nrg_bal; it draws only with the latest year
        let ask = Ask::Table {
            count: 1,
            most: 1,
            items: vec![vec![
                ("t1.years".into(), 2),
                ("t1.breakdown".into(), 2),
                ("t1.nrg_bal".into(), 4),
            ]],
            splits: vec![vec![Split {
                option: 2,
                dim: "nrg_bal".into(),
                years: vec![1],
                member: true,
            }]],
            held: Vec::new(),
        };
        let pair = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 1, "t1.breakdown": 2, "t1.nrg_bal": 1}})).unwrap_err();
        assert_eq!(pair.problem, "t1.breakdown 2 (nrg_bal) takes every nrg_bal code, so t1.nrg_bal has no place: leave it out, or keep it and set t1.breakdown 1");
        assert_eq!(
            pair.allowed["params"],
            json!({"t1.years": [1], "t1.breakdown": 2})
        );
        assert_eq!(
            pair.example,
            json!({"step": "table", "pick": [1], "params": {"t1.years": 1, "t1.breakdown": 1, "t1.nrg_bal": 1}})
        );
        let years = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 2, "t1.breakdown": 2}})).unwrap_err();
        assert_eq!(years.problem, "t1.breakdown 2 (nrg_bal) with t1.years 2 gives a page no filled chart can draw: set t1.years to one of [1], or t1.breakdown 1");
        assert_eq!(
            ask.check(
                &json!({"step": "table", "pick": [1], "params": {"t1.years": 1, "t1.breakdown": 2}})
            )
            .unwrap(),
            Choice::Table {
                picks: vec![1],
                params: BTreeMap::from([("t1.breakdown".into(), 2), ("t1.years".into(), 1)])
            }
        );
        // with no split picked every item is still asked, as before
        let missing = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 1, "t1.breakdown": 1}})).unwrap_err();
        assert_eq!(
            missing.problem,
            "params needs item 't1.nrg_bal' as one of its option numbers 1 to 4"
        );
        assert!(ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 2, "t1.breakdown": 1, "t1.nrg_bal": 1}})).is_ok());
        // out of range stays the range refusal
        let range = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 3, "t1.breakdown": 2}})).unwrap_err();
        assert_eq!(
            range.problem,
            "params needs item 't1.years' as one of its option numbers 1 to 2"
        );
    }

    #[test]
    fn table_params_give_every_item_of_the_picked_tables() {
        let ask = two_tables_with_items();
        assert_eq!(
            ask.check(
                &json!({"step": "table", "pick": [2], "params": {"t2.years": 2, "t2.breakdown": 3}})
            ),
            Ok(Choice::Table {
                picks: vec![2],
                params: BTreeMap::from([
                    ("t2.breakdown".to_string(), 3),
                    ("t2.years".to_string(), 2)
                ])
            })
        );
        assert_eq!(
            ask.check(&json!({"step": "table", "pick": [0], "params": {}})),
            Ok(Choice::Table {
                picks: vec![],
                params: BTreeMap::new()
            })
        );
        let refused = ask
            .check(&json!({"step": "table", "pick": [2]}))
            .unwrap_err();
        assert_eq!(refused.problem, "missing key 'params'");
        assert_eq!(ask.schema()["required"], json!(["step", "pick", "params"]));
        assert_eq!(
            ask.schema()["properties"]["params"]["properties"]["t1.unit"]["enum"],
            json!([1, 2, 3])
        );
    }

    #[test]
    fn table_params_of_a_table_not_picked_are_refused_with_the_picked_tables_items_only() {
        let refused = two_tables_with_items()
            .check(&json!({"step": "table", "pick": [2], "params": {"t1.years": 1, "t2.years": 1, "t2.breakdown": 1}}))
            .unwrap_err();
        assert_eq!(
            refused.problem,
            "params has no item 't1.years' among the items of the picked tables"
        );
        assert_eq!(
            refused.allowed,
            json!({"step": "table", "pick": [2], "params": {"t2.years": [1, 2], "t2.breakdown": [1, 2, 3]}})
        );
        assert_eq!(
            refused.example,
            json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1}})
        );
    }

    #[test]
    fn table_params_missing_or_out_of_range_name_the_item_and_its_numbers() {
        let ask = two_tables_with_items();
        for params in [
            json!({"t2.years": 1}),
            json!({"t2.years": 1, "t2.breakdown": 4}),
            json!({"t2.years": 1, "t2.breakdown": "3"}),
        ] {
            let refused = ask
                .check(&json!({"step": "table", "pick": [2], "params": params}))
                .unwrap_err();
            assert_eq!(
                refused.problem,
                "params needs item 't2.breakdown' as one of its option numbers 1 to 3",
                "{params}"
            );
            assert_eq!(refused.allowed["params"]["t2.breakdown"], json!([1, 2, 3]));
        }
        let refused = ask
            .check(&json!({"step": "table", "pick": [2], "params": [1, 3]}))
            .unwrap_err();
        assert!(
            refused.problem.starts_with("params must map"),
            "{}",
            refused.problem
        );
        // a bad pick is refused before the params, with every listed table's items
        let refused = ask
            .check(&json!({"step": "table", "pick": [3], "params": {}}))
            .unwrap_err();
        assert_eq!(refused.allowed["pick"], json!([0, 1, 2]));
        assert_eq!(refused.allowed["params"].as_object().unwrap().len(), 4);
    }

    #[test]
    fn a_table_pick_is_up_to_most_listed_numbers_and_only_zero_means_none() {
        let one = Ask::Table {
            count: 5,
            most: 1,
            items: vec![],
            splits: vec![],
            held: Vec::new(),
        };
        assert_eq!(
            one.check(&json!({"step": "table", "pick": [0]})),
            Ok(Choice::Table {
                picks: vec![],
                params: BTreeMap::new()
            })
        );
        assert_eq!(
            one.check(&json!({"step": "table", "pick": [5]})),
            Ok(Choice::Table {
                picks: vec![5],
                params: BTreeMap::new()
            })
        );
        for bad in [json!([6]), json!([1, 2]), json!([]), json!(1), json!(["1"])] {
            let refused = one
                .check(&json!({"step": "table", "pick": bad}))
                .unwrap_err();
            assert_eq!(refused.allowed["pick"], json!([0, 1, 2, 3, 4, 5]));
        }
        assert_eq!(
            one.schema()["properties"]["pick"]["items"]["enum"],
            json!([0, 1, 2, 3, 4, 5])
        );
        // two tables are picked in one answer
        let two = Ask::Table {
            count: 5,
            most: 2,
            items: vec![],
            splits: vec![],
            held: Vec::new(),
        };
        assert_eq!(
            two.check(&json!({"step": "table", "pick": [4, 2]})),
            Ok(Choice::Table {
                picks: vec![4, 2],
                params: BTreeMap::new()
            })
        );
        for bad in [json!([1, 1]), json!([0, 1]), json!([1, 2, 3])] {
            let refused = two
                .check(&json!({"step": "table", "pick": bad}))
                .unwrap_err();
            assert!(refused.problem.contains("up to 2"), "{bad}");
            assert_eq!(refused.allowed["most"], 2);
        }
        assert_eq!(two.schema()["properties"]["pick"]["maxItems"], 2);
    }

    #[test]
    fn claims_are_three_to_five_of_each_table_and_the_relation_is_asked_only_when_unclear() {
        let one = Ask::Claims {
            groups: vec![6],
            relations: 1,
        };
        assert_eq!(
            one.check(&json!({"step": "claims", "pick": [3, 1, 6]})),
            Ok(Choice::Claims {
                picks: vec![3, 1, 6],
                relation: None
            })
        );
        assert!(one
            .check(&json!({"step": "claims", "pick": [1, 2, 3, 4, 5]}))
            .is_ok());
        assert!(one
            .check(&json!({"step": "claims", "pick": [1, 2, 3], "relation": 1}))
            .is_err());
        for bad in [
            json!([]),
            json!([1, 2]),
            json!([0, 1, 2]),
            json!([1, 2, 7]),
            json!([1, 1, 2]),
            json!([1, 2, 3, 4, 5, 6]),
        ] {
            let refused = one
                .check(&json!({"step": "claims", "pick": bad}))
                .unwrap_err();
            assert_eq!(
                refused.problem, "pick must list 3 to 5 different claim numbers",
                "{bad}"
            );
        }
        assert_eq!(one.schema()["properties"]["pick"]["minItems"], 3);
        assert_eq!(one.schema()["properties"]["pick"]["maxItems"], 5);
        // with four candidates no more than four can be picked
        let four = Ask::Claims {
            groups: vec![4],
            relations: 1,
        };
        assert!(four
            .check(&json!({"step": "claims", "pick": [1, 2, 3, 4]}))
            .is_ok());
        assert_eq!(four.schema()["properties"]["pick"]["maxItems"], 4);
        // two tables, numbered on: each table is counted on its own
        let tables = Ask::Claims {
            groups: vec![4, 6],
            relations: 1,
        };
        assert!(tables
            .check(&json!({"step": "claims", "pick": [1, 2, 3, 5, 6, 10]}))
            .is_ok());
        let refused = tables
            .check(&json!({"step": "claims", "pick": [1, 2, 3, 4, 5]}))
            .unwrap_err();
        assert_eq!(
            refused.problem,
            "pick must list different claim numbers: 3 to 4 of claims 1-4 (table 1), 3 to 5 of claims 5-10 (table 2)"
        );
        assert_eq!(
            refused.allowed["per_table"],
            json!([{"claims": [1, 4], "min": 3, "max": 4}, {"claims": [5, 10], "min": 3, "max": 5}])
        );
        assert_eq!(refused.example["pick"], json!([1, 2, 3, 5, 6, 7]));
        assert!(tables
            .check(&json!({"step": "claims", "pick": refused.example["pick"]}))
            .is_ok());
        let schema = tables.schema();
        assert_eq!(schema["properties"]["pick"]["minItems"], 6);
        assert_eq!(schema["properties"]["pick"]["maxItems"], 9);
        let two = Ask::Claims {
            groups: vec![4],
            relations: 3,
        };
        assert_eq!(
            two.check(&json!({"step": "claims", "pick": [2, 3, 4], "relation": 3})),
            Ok(Choice::Claims {
                picks: vec![2, 3, 4],
                relation: Some(3)
            })
        );
        let refused = two
            .check(&json!({"step": "claims", "pick": [2, 3, 4]}))
            .unwrap_err();
        assert_eq!(
            refused.example,
            json!({"step": "claims", "pick": [1, 2, 3], "relation": 1})
        );
        assert!(two
            .check(&json!({"step": "claims", "pick": [2, 3, 4], "relation": 4}))
            .is_err());
        assert_eq!(
            two.schema()["required"],
            json!(["step", "pick", "relation"])
        );
    }

    #[test]
    fn the_wrong_step_or_an_unknown_key_is_refused() {
        let ask = Ask::Table {
            count: 2,
            most: 1,
            items: vec![],
            splits: vec![],
            held: Vec::new(),
        };
        assert!(ask.check(&json!({"step": "claims", "pick": [1]})).is_err());
        assert!(ask
            .check(&json!({"step": "table", "pick": [1], "why": "x"}))
            .is_err());
        assert!(ask.check(&json!([1])).is_err());
    }

    #[test]
    fn on_a_page_of_periods_no_year_word_follows_a_time_placeholder() {
        // A monthly table's time prints whole ("2026-08"), so "{first.year}年" would print "2026-08年": refused with the
        // rule and an example. On an annual page, and for a placeholder that is no time, nothing changes.
        let fields = BTreeMap::from([(
            "1".to_string(),
            "{first.name}在{first.year}最高".to_string(),
        )]);
        let ask = |periods: &[&str]| Ask::Text {
            fields: fields.clone(),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: periods.iter().map(|p| p.to_string()).collect(),
        };
        let answer = |t: &str| json!({"step": "text", "text": {"1": t}, "names": {}});
        let monthly = ask(&["2026-08"]);
        let why = monthly
            .check(&answer("{first.name}在{first.year} 年最高"))
            .unwrap_err();
        assert!(why.problem.contains("'{first.year}年'"), "{}", why.problem);
        assert!(why.problem.contains("such as 2026-08"), "{}", why.problem);
        assert_eq!(why.allowed["periods"], json!(["2026-08"]));
        assert!(monthly
            .check(&answer("{first.year}，{first.name}最高"))
            .is_ok());
        assert!(monthly
            .check(&answer("{first.name}年度最高，{first.year}"))
            .is_ok());
        assert!(ask(&[])
            .check(&answer("{first.name}在{first.year}年最高"))
            .is_ok());
        assert!(ask(&[]).allowed().get("periods").is_none());
        assert_eq!(
            year_after_period("{a.from_year}年至{a.to_year}"),
            Some("{a.from_year}年".into())
        );
        assert_eq!(year_after_period("{first.yearly}年"), None);
    }

    #[test]
    fn text_keeps_the_drafted_placeholders_and_fills_every_slot() {
        let ask = text_ask();
        let ok = ask.check(&json!({"step": "text", "text": {"1": "{max.v.geo}居首（{max.v}）"}, "names": {"s1": "德国"}}));
        assert!(ok.is_ok(), "{ok:?}");
        assert!(ask
            .check(&json!({"step": "text", "text": {}, "names": {"s1": "德国"}}))
            .is_ok());
        assert!(ask
            .check(&json!({"step": "text", "text": {"2": "2023 年各国发电量"}, "names": {"s1": "德国"}}))
            .is_ok());
        for (text, names) in [
            (json!({"1": "德国最多（{max.v}）"}), json!({"s1": "德国"})),
            (
                json!({"1": "{max.v.geo}最多，{min.v}"}),
                json!({"s1": "德国"}),
            ),
            (
                json!({"1": "{max.v.geo}最多（{max.v"}),
                json!({"s1": "德国"}),
            ),
            (json!({"3": "x"}), json!({"s1": "德国"})),
            (
                json!({"1": "{max.v.geo}居首（{max.v}），2024年"}),
                json!({"s1": "德国"}),
            ),
            (json!({"2": "各国发电量前５"}), json!({"s1": "德国"})),
            (json!({"2": "过半国家的发电量"}), json!({"s1": "德国"})),
            (
                json!({"1": "{max.v.geo}是末位的三倍（{max.v}）"}),
                json!({"s1": "德国"}),
            ),
            (json!({}), json!({})),
            (json!({}), json!({"s1": " "})),
            (json!({}), json!({"s1": "德国", "s2": "法国"})),
            (json!({}), json!({"s1": "德国 2024"})),
            (json!({}), json!({"s1": "德国３"})),
            (json!({}), json!({"s1": "{max.v}"})),
            (json!({}), json!({"s1": "Renewable share"})),
            (json!({}), json!({"s1": "两国发电量"})),
            (
                json!({}),
                json!({"s1": "欧盟各成员国可再生能源在最终能源消费总量中所占的比例"}),
            ),
        ] {
            let refused = ask
                .check(&json!({"step": "text", "text": text, "names": names}))
                .unwrap_err();
            assert_eq!(refused.example["names"], json!({"s1": "<中文名>"}));
            assert_eq!(refused.allowed["text"]["1"], "{max.v.geo}最多（{max.v}）");
        }
    }

    #[test]
    fn placeholder_sets_compare_exactly() {
        assert_eq!(
            placeholders("{a}和{b.c}，{a}").unwrap(),
            BTreeSet::from(["a".to_string(), "b.c".to_string()])
        );
        assert!(same_placeholders("{a}{b}", "{b}居前，{a}").is_ok());
        assert!(typed_numbers("{max.v|1}居首，{a}").is_empty());
        assert_eq!(
            typed_numbers("{a}比2023年多3成，65.4与1,200。"),
            ["2023", "3", "65.4", "1,200"]
        );
        assert_eq!(typed_numbers("前３名{max.v}7"), ["３", "7"]);
        assert_eq!(
            number_not_allowed("2023年{a}多3成", &["2023".to_string()]),
            Some("3".to_string())
        );
        // Numbers in words: a numeral before a ratio word, the ratio words with no numeral, a numeral run, a lone numeral.
        for (text, word) in [
            ("德国是法国的三倍", "三倍"),
            ("{a}比{b}多两成", "两成"),
            ("约三分之一来自风电", "三分之"),
            ("百分之四十", "百分之"),
            ("上升了三个百分点", "三个百分点"),
            ("高出 3 倍", "3倍"),
            ("{a}达５％", "５％"),
            ("过半国家", "过半"),
            ("几乎翻了一倍", "一倍"),
            ("十几倍", "十几倍"),
            ("排名第三成为焦点之外，增长两成", "两成"),
            ("发电五千亿千瓦时", "五千亿千"),
            ("欧盟二十七国", "二十七"),
            ("二零二三年", "二零二三"),
            ("近十年来", "十"),
            ("两国之间", "两"),
            ("产量减半", "减半"),
            ("近半来自煤电", "近半"),
            ("逾半国家", "逾半"),
            ("超半数", "半数"),
            ("高出数倍", "数倍"),
            ("三千瓦", "三千"),
            ("一千万", "一千万"),
            ("数千万人", "千万"),
            ("上千万", "千万"),
            ("近千万", "千万"),
            ("一千瓦时", "一千"),
            ("三十分", "三十"),
            ("一 千万", "千万"),
            ("{a}千万人", "千万"),
        ] {
            assert_eq!(worded_number(text).as_deref(), Some(word), "{text}");
        }
        // No number: an ordinal, a lone 一 or 几, a placeholder before a ratio word, digits alone, and the NUMBER_FREE words
        // by name. Taken on purpose: another word with a numeral (四川, 百姓) is refused and reworded.
        for text in [
            "德国第一，法国第二",
            "排第十二",
            "一些国家",
            "统一口径",
            "几乎持平",
            "统一成同一单位",
            "格局一成不变",
            "{first.ratio}倍",
            "变成",
            "{a}成为最大",
            "十分接近",
            "十分明显",
            "千万别漏",
            "万一缺数",
            "千万注意",
            "一一列出",
            "两者之间",
            "单位是千瓦时",
            "千瓦时",
            "按百分比计",
            "零售额",
            "少数成员国",
            "2025年",
        ] {
            assert_eq!(worded_number(text), None, "{text}");
        }
        let why = same_placeholders("{a}{b}", "{a}{c}").unwrap_err();
        assert!(
            why.contains("missing: [{b}]") && why.contains("not in the draft: [{c}]"),
            "{why}"
        );
        for bad in ["{a", "a}", "{a{b}}", "}{"] {
            assert!(placeholders(bad).is_err(), "{bad}");
        }
    }

    /// Replays scripted replies, one per request, and keeps what each request offered.
    /// A value the schema types as an object, sent as a string holding exactly one JSON object, is decoded once and then
    /// checked as usual; any other string, and every other key, is left as sent.
    #[test]
    fn a_stringified_object_is_decoded_once_and_only_where_an_object_is_due() {
        let text = Ask::Text {
            fields: BTreeMap::from([("1".to_string(), "{first.name}最高".to_string())]),
            slots: vec!["s1".into()],
            numbers: Vec::new(),
            periods: Vec::new(),
        };
        let good = json!({"step": "text", "text": json!({"1": "{first.name}居首"}).to_string(), "names": json!({"s1": "占比"}).to_string()});
        assert_eq!(text.decode(&good).1, vec!["text", "names"]);
        assert!(text.check(&good).is_ok());
        // decoded, the content checks still run: a dropped placeholder is refused
        let dropped = json!({"step": "text", "text": json!({"1": "居首"}).to_string(), "names": {"s1": "占比"}});
        assert!(text
            .check(&dropped)
            .unwrap_err()
            .problem
            .starts_with("field '1'"));
        for not_one in [
            json!("[1]"),
            json!("{\"s1\": \"占比\"} {}"),
            json!(json!(json!({"s1": "占比"}).to_string()).to_string()),
            json!("占比"),
        ] {
            let args = json!({"step": "text", "text": {}, "names": not_one});
            assert!(text.decode(&args).1.is_empty(), "{args}");
            assert!(text.check(&args).is_err(), "{args}");
        }
        let claims = Ask::Claims {
            groups: vec![4],
            relations: 1,
        };
        let pick = json!({"step": "claims", "pick": "[1, 2, 3]"});
        assert!(claims.decode(&pick).1.is_empty());
        assert!(claims.check(&pick).is_err());
        let table = Ask::Table {
            count: 2,
            most: 1,
            items: vec![vec![("t1.years".into(), 2)], Vec::new()],
            splits: vec![],
            held: Vec::new(),
        };
        let params = json!({"step": "table", "pick": [1], "params": "{\"t1.years\": 2}"});
        assert_eq!(table.decode(&params).1, vec!["params"]);
        assert_eq!(
            table.check(&params),
            Ok(Choice::Table {
                picks: vec![1],
                params: BTreeMap::from([("t1.years".to_string(), 2)])
            })
        );
        assert!(Ask::Table {
            count: 2,
            most: 1,
            items: Vec::new(),
            splits: vec![],
            held: Vec::new(),
        }
        .decode(&json!({"step": "table", "pick": "[1]"}))
        .1
        .is_empty());
    }

    struct ScriptedAsker {
        replies: std::collections::VecDeque<Value>,
        route: ModelRoute,
        offered: Vec<Value>,
    }

    impl ScriptedAsker {
        fn new(replies: Vec<Value>) -> Self {
            Self {
                replies: replies.into(),
                route: ModelRoute::Standin,
                offered: Vec::new(),
            }
        }
    }

    #[async_trait]
    impl Asker for ScriptedAsker {
        fn route(&self) -> ModelRoute {
            self.route
        }
        async fn ask(
            &mut self,
            _history: &[Value],
            tools: &[ToolDef],
            _cancel: &AtomicBool,
        ) -> Option<Value> {
            self.offered.push(tools[0].parameters.clone());
            self.replies.pop_front()
        }
    }

    fn call(id: &str, args: Value) -> Value {
        json!({"content": [{"type": "toolCall", "id": id, "name": CHOOSE_TOOL, "arguments": args}],
            "stopReason": "toolUse", "usage": {}})
    }

    /// Answers every tool with its name in the text and fixed details.
    struct FakeTools {
        ran: Vec<String>,
    }

    #[async_trait]
    impl ToolRunner for FakeTools {
        async fn run(
            &mut self,
            name: &str,
            _args: &Value,
            _cancel: &AtomicBool,
            progress: &mut Vec<Value>,
        ) -> anyhow::Result<CallOutcome> {
            self.ran.push(name.to_string());
            progress.push(json!({"content": [{"type": "text", "text": "working"}]}));
            Ok(CallOutcome::Result {
                content: text_content(&format!("{name} done")),
                details: Some(json!({"tool": name, "rows": 3})),
                is_error: false,
            })
        }
        fn exposes(&self, _name: &str) -> bool {
            true
        }
    }

    type Events = std::sync::Arc<std::sync::Mutex<Vec<Value>>>;

    fn collector() -> (Events, impl FnMut(Value) + Send) {
        let events: Events = Default::default();
        let into = events.clone();
        (events, move |event| into.lock().unwrap().push(event))
    }

    fn of_type(events: &Events, kind: &str) -> Vec<Value> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == kind)
            .cloned()
            .collect()
    }

    /// Two tables, each asked as a table pick and a claims pick with program calls under each; one refused answer on the way.
    async fn two_tables(dir: &Path) -> (Events, ScriptedAsker, FakeTools) {
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            call("toolu_t1", json!({"step": "table", "pick": [1]})),
            call("toolu_c1a", json!({"step": "claims", "pick": [9]})),
            call("toolu_c1", json!({"step": "claims", "pick": [1, 2, 3]})),
            call("toolu_t2", json!({"step": "table", "pick": [1]})),
            call("toolu_c2", json!({"step": "claims", "pick": [3, 2, 1]})),
        ]);
        let mut tools = FakeTools { ran: Vec::new() };
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, dir, vec!["sk-handoff-key".into()], Vec::new());
        for _table in 0..2 {
            let (_, choice) = recorder
                .ask_step(
                    &mut model,
                    &Ask::Table {
                        count: 1,
                        most: 1,
                        items: vec![],
                        splits: vec![],
                        held: Vec::new(),
                    },
                    "pick the table",
                    &cancel,
                )
                .await
                .unwrap();
            assert_eq!(
                choice,
                Choice::Table {
                    picks: vec![1],
                    params: BTreeMap::new()
                }
            );
            recorder
                .auto(
                    &mut tools,
                    "newsroom_data_prepare",
                    json!({"dataset": "x"}),
                    &cancel,
                )
                .await
                .unwrap();
            let claims = Ask::Claims {
                groups: vec![3],
                relations: 1,
            };
            recorder
                .ask_step(&mut model, &claims, "pick the claims", &cancel)
                .await
                .unwrap();
            recorder
                .auto(
                    &mut tools,
                    "newsroom_data_prepare",
                    json!({"sheet": "s", "picks": [1]}),
                    &cancel,
                )
                .await
                .unwrap();
            recorder
                .auto(&mut tools, "newsroom_update_plan", json!({}), &cancel)
                .await
                .unwrap();
        }
        drop(recorder);
        (events, model, tools)
    }

    fn write_events(dir: &Path, events: &Events) -> PathBuf {
        let path = dir.join("events.jsonl");
        let text: String = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| format!("{e}\n"))
            .collect();
        std::fs::write(&path, text).unwrap();
        path
    }

    #[tokio::test]
    async fn every_model_reply_is_one_turn_end_and_program_calls_are_none() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, model, tools) = two_tables(dir.path()).await;
        assert_eq!(model.offered.len(), 5);
        assert_eq!(of_type(&events, "turn_end").len(), 5);
        assert_eq!(tools.ran.len(), 6);
        // the refused reply's result says what is allowed and gives an example; the step is asked again with the same schema
        let refused: Vec<Value> = of_type(&events, "tool_execution_end")
            .into_iter()
            .filter(|e| e["isError"] == true)
            .collect();
        assert_eq!(refused.len(), 1);
        let text: Value =
            serde_json::from_str(refused[0]["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        assert_eq!(text["allowed"]["pick"], json!([1, 2, 3]));
        assert_eq!(
            text["example"],
            json!({"step": "claims", "pick": [1, 2, 3]})
        );
        assert_eq!(model.offered[1], model.offered[2]);
    }

    #[tokio::test]
    async fn the_audit_traces_every_program_call_to_the_model_answer_it_followed() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, _, _) = two_tables(dir.path()).await;
        let path = write_events(dir.path(), &events);
        let audit = crate::audit::build(&path, &dir.path().join("tools.json")).unwrap();
        assert_eq!(audit.auto_calls, 6);
        assert!(
            audit.auto_order_problems.is_empty(),
            "{:?}",
            audit.auto_order_problems
        );
        assert!(!audit.autonomous_execution_observed);
        assert_eq!(audit.turns, 5);
        let models: BTreeSet<&str> = audit
            .calls
            .iter()
            .filter(|c| !c.auto)
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(
            models,
            BTreeSet::from(["toolu_t1", "toolu_c1a", "toolu_c1", "toolu_t2", "toolu_c2"])
        );
        let autos: Vec<_> = audit.calls.iter().filter(|c| c.auto).collect();
        for auto in &autos {
            let parent = auto.auto_parent_call_id.as_deref().unwrap();
            assert!(
                models.contains(parent) && parent != "toolu_c1a",
                "{}",
                auto.id
            );
        }
        assert_eq!(
            autos.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            [
                "toolu_t1:auto:1",
                "toolu_c1:auto:1",
                "toolu_c1:auto:2",
                "toolu_t2:auto:1",
                "toolu_c2:auto:1",
                "toolu_c2:auto:2"
            ]
        );
        // the program call's result is kept whole, details included
        let ends = of_type(&events, "tool_execution_end");
        let end = ends
            .iter()
            .find(|e| e["toolCallId"] == "toolu_c1:auto:2")
            .unwrap();
        assert_eq!(
            end["result"]["details"],
            json!({"tool": "newsroom_update_plan", "rows": 3})
        );
        assert_eq!(end["auto_parent_call_id"], "toolu_c1");
    }

    #[tokio::test]
    async fn each_exchange_is_stored_and_named_with_its_hashes_and_route() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, _, _) = two_tables(dir.path()).await;
        let exchanges = of_type(&events, EXCHANGE_EVENT);
        assert_eq!(exchanges.len(), 5);
        for event in &exchanges {
            assert_eq!(event["route"], "standin");
            let id = event["tool_call_id"].as_str().unwrap();
            assert_eq!(event["file"], format!("{EXCHANGE_DIR}/{id}.json"));
            let record: Value = serde_json::from_str(
                &std::fs::read_to_string(dir.path().join(event["file"].as_str().unwrap())).unwrap(),
            )
            .unwrap();
            assert_eq!(
                event["request_sha256"],
                crate::hash::sha256_bytes(record["request"].to_string().as_bytes())
            );
            assert_eq!(
                event["reply_sha256"],
                crate::hash::sha256_bytes(record["reply"].to_string().as_bytes())
            );
            // the request is what this route sent: the one tool and the history; the reply holds the call the event names
            assert_eq!(record["request"]["tools"][0]["name"], CHOOSE_TOOL);
            assert!(record["request"]["history"].is_array());
            assert_eq!(record["reply"]["content"][0]["id"], id);
        }
        assert_eq!(exchanges[1]["step"], "claims");
        // each exchange event comes before anything the reply led to
        let all = events.lock().unwrap();
        let at = |pred: &dyn Fn(&Value) -> bool| all.iter().position(pred).unwrap();
        assert!(
            at(&|e| e["type"] == EXCHANGE_EVENT && e["tool_call_id"] == "toolu_t1")
                < at(&|e| e["type"] == "tool_execution_start" && e["toolCallId"] == "toolu_t1")
        );
    }

    #[tokio::test]
    async fn a_program_call_with_no_accepted_answer_does_not_run() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut tools = FakeTools { ran: Vec::new() };
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let err = recorder
            .auto(&mut tools, "newsroom_data_prepare", json!({}), &cancel)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            Stop::NoModelParent {
                tool: "newsroom_data_prepare".into()
            }
        );
        // nor after a step that was asked and refused twice
        let mut model = ScriptedAsker::new(vec![
            call("toolu_a", json!({"step": "table", "pick": [4]})),
            json!({"content": [{"type": "text", "text": "the first one"}], "stopReason": "stop", "usage": {}}),
        ]);
        let stop = recorder
            .ask_step(
                &mut model,
                &Ask::Table {
                    count: 2,
                    most: 1,
                    items: vec![],
                    splits: vec![],
                    held: Vec::new(),
                },
                "pick",
                &cancel,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&stop, Stop::Refused { step: "table", problem } if problem.contains("one")),
            "{stop:?}"
        );
        assert!(recorder
            .auto(&mut tools, "newsroom_data_prepare", json!({}), &cancel)
            .await
            .is_err());
        drop(recorder);
        assert!(tools.ran.is_empty());
        assert_eq!(of_type(&events, "turn_end").len(), 2);
        // the reply without a call is filed under its turn, with no call id
        let exchanges = of_type(&events, EXCHANGE_EVENT);
        assert_eq!(exchanges[1]["tool_call_id"], Value::Null);
        assert_eq!(exchanges[1]["file"], format!("{EXCHANGE_DIR}/turn-2.json"));
    }

    #[tokio::test]
    async fn a_failed_reply_ends_its_turn_and_stops_the_step() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![json!({"content": [], "stopReason": "error",
            "errorMessage": "overloaded", "usage": {}})]);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let stop = recorder
            .ask_step(
                &mut model,
                &Ask::Table {
                    count: 1,
                    most: 1,
                    items: vec![],
                    splits: vec![],
                    held: Vec::new(),
                },
                "pick",
                &AtomicBool::new(false),
            )
            .await
            .unwrap_err();
        assert_eq!(
            stop,
            Stop::ModelFailed {
                step: "table",
                error: "overloaded".into()
            }
        );
        let mut empty = ScriptedAsker::new(Vec::new());
        assert_eq!(
            recorder
                .ask_step(
                    &mut empty,
                    &Ask::Table {
                        count: 1,
                        most: 1,
                        items: vec![],
                        splits: vec![],
                        held: Vec::new(),
                    },
                    "pick",
                    &AtomicBool::new(false)
                )
                .await
                .unwrap_err(),
            Stop::NoReply { step: "table" }
        );
        drop(recorder);
        let turns = of_type(&events, "turn_end");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["message"]["stopReason"], "error");
    }

    #[tokio::test]
    async fn an_exchange_with_a_secret_is_not_written_and_the_step_stops() {
        let _command = crate::group_guard::command_for_test("investigate");
        for (reply_text, kind) in [
            ("the key is sk-handoff-key", SecretKind::Handoff),
            ("send Authorization: x", SecretKind::AuthorizationHeader),
            (
                "use Bearer abcdefghijklmnopqrstuvwxyz0123",
                SecretKind::BearerToken,
            ),
            ("X-Api-Key: abc", SecretKind::ApiKeyHeader),
            ("{\"apiKey\" : \"abc\"}", SecretKind::ApiKeyField),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (events, mut sink) = collector();
            let mut reply = call("toolu_s", json!({"step": "table", "pick": [1]}));
            reply["content"]
                .as_array_mut()
                .unwrap()
                .insert(0, json!({"type": "text", "text": reply_text}));
            let mut model = ScriptedAsker::new(vec![reply]);
            let mut recorder = Recorder::new(
                &mut sink,
                dir.path(),
                vec!["sk-handoff-key".into()],
                Vec::new(),
            );
            let stop = recorder
                .ask_step(
                    &mut model,
                    &Ask::Table {
                        count: 1,
                        most: 1,
                        items: vec![],
                        splits: vec![],
                        held: Vec::new(),
                    },
                    "pick",
                    &AtomicBool::new(false),
                )
                .await
                .unwrap_err();
            assert_eq!(
                stop,
                Stop::SecretInExchange {
                    step: "table",
                    kind
                },
                "{reply_text}"
            );
            assert!(!stop.to_string().contains("sk-handoff-key"));
            drop(recorder);
            assert!(!dir.path().join(EXCHANGE_DIR).join("toolu_s.json").exists());
            assert!(events.lock().unwrap().is_empty(), "{reply_text}");
        }
    }

    #[tokio::test]
    async fn ordinary_words_like_bearer_bonds_are_not_a_secret() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model =
            ScriptedAsker::new(vec![call("toolu_b", json!({"step": "table", "pick": [1]}))]);
        let mut recorder = Recorder::new(
            &mut sink,
            dir.path(),
            vec!["sk-handoff-key".into()],
            Vec::new(),
        );
        let prompt = "1. US bearer bonds outstanding; 2. authorization rates; api_key column";
        recorder
            .ask_step(
                &mut model,
                &Ask::Table {
                    count: 1,
                    most: 1,
                    items: vec![],
                    splits: vec![],
                    held: Vec::new(),
                },
                prompt,
                &AtomicBool::new(false),
            )
            .await
            .unwrap();
        drop(recorder);
        assert!(dir.path().join(EXCHANGE_DIR).join("toolu_b.json").exists());
        assert_eq!(of_type(&events, EXCHANGE_EVENT).len(), 1);
    }

    #[tokio::test]
    async fn a_call_id_that_cannot_name_a_file_stops_before_anything_is_written() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model =
            ScriptedAsker::new(vec![call("../x", json!({"step": "table", "pick": [1]}))]);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let stop = recorder
            .ask_step(
                &mut model,
                &Ask::Table {
                    count: 1,
                    most: 1,
                    items: vec![],
                    splits: vec![],
                    held: Vec::new(),
                },
                "pick",
                &AtomicBool::new(false),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(stop, Stop::Exchange { step: "table", .. }),
            "{stop:?}"
        );
        drop(recorder);
        assert!(events.lock().unwrap().is_empty());
        assert!(!dir.path().join(EXCHANGE_DIR).exists());
    }

    #[tokio::test]
    async fn a_repeated_call_id_stops_and_leaves_the_first_exchange_as_written() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            call("c1", json!({"step": "table", "pick": [1]})),
            call("c1", json!({"step": "table", "pick": [2]})),
        ]);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let ask = Ask::Table {
            count: 2,
            most: 1,
            items: vec![],
            splits: vec![],
            held: Vec::new(),
        };
        let cancel = AtomicBool::new(false);
        recorder
            .ask_step(&mut model, &ask, "pick", &cancel)
            .await
            .unwrap();
        let file = dir.path().join(EXCHANGE_DIR).join("c1.json");
        let first = std::fs::read(&file).unwrap();
        let stop = recorder
            .ask_step(&mut model, &ask, "pick again", &cancel)
            .await
            .unwrap_err();
        assert!(
            matches!(stop, Stop::Exchange { step: "table", .. }),
            "{stop:?}"
        );
        drop(recorder);
        assert_eq!(std::fs::read(&file).unwrap(), first);
        assert_eq!(of_type(&events, EXCHANGE_EVENT).len(), 1);
    }

    #[test]
    fn the_route_is_named_by_the_client_and_the_address_kind() {
        assert_eq!(
            ModelRoute::of(true, "https://relay.example"),
            ModelRoute::Standin
        );
        assert_eq!(
            ModelRoute::of(false, "http://127.0.0.1:8123"),
            ModelRoute::Loopback
        );
        assert_eq!(
            ModelRoute::of(false, "HTTPS://relay.example/v1"),
            ModelRoute::Real
        );
        assert_eq!(
            ModelRoute::of(false, "http://relay.example"),
            ModelRoute::Other
        );
        assert_eq!(ModelRoute::Real.name(), "real");
    }

    #[tokio::test]
    async fn two_calls_in_one_reply_are_both_refused() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut two = call("toolu_x", json!({"step": "table", "pick": [1]}));
        two["content"].as_array_mut().unwrap().push(
            json!({"type": "toolCall", "id": "toolu_y", "name": CHOOSE_TOOL, "arguments": {"step": "table", "pick": [1]}}),
        );
        let mut model = ScriptedAsker::new(vec![
            two,
            call("toolu_z", json!({"step": "table", "pick": [1]})),
        ]);
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let (id, _) = recorder
            .ask_step(
                &mut model,
                &Ask::Table {
                    count: 1,
                    most: 1,
                    items: vec![],
                    splits: vec![],
                    held: Vec::new(),
                },
                "pick",
                &AtomicBool::new(false),
            )
            .await
            .unwrap();
        assert_eq!(id, "toolu_z");
        // every call of the refused reply has its result, so the next request is well formed
        let results: Vec<_> = recorder
            .history()
            .iter()
            .filter(|m| m["role"] == "toolResult")
            .map(|m| {
                (
                    m["toolCallId"].as_str().unwrap().to_string(),
                    m["isError"] == true,
                )
            })
            .collect();
        assert_eq!(
            results,
            [
                ("toolu_x".to_string(), true),
                ("toolu_y".to_string(), true),
                ("toolu_z".to_string(), false)
            ]
        );
        drop(recorder);
        assert_eq!(
            of_type(&events, EXCHANGE_EVENT)[0]["tool_call_id"],
            Value::Null
        );
    }

    /// Answers newsroom_data_prepare with scripted details, one per call, and keeps each call's arguments.
    struct ScriptedTools {
        details: std::collections::VecDeque<Value>,
        args: Vec<Value>,
    }

    #[async_trait]
    impl ToolRunner for ScriptedTools {
        async fn run(
            &mut self,
            name: &str,
            args: &Value,
            _cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> anyhow::Result<CallOutcome> {
            assert_eq!(name, DATA_PREPARE_TOOL);
            self.args.push(args.clone());
            // a scripted "text" stands for the tool's own words (a fetch failure's), "prepared" otherwise
            let details = self.details.pop_front();
            Ok(CallOutcome::Result {
                content: text_content(
                    details
                        .as_ref()
                        .and_then(|d| d["text"].as_str())
                        .unwrap_or("prepared"),
                ),
                details,
                is_error: false,
            })
        }
        fn exposes(&self, _name: &str) -> bool {
            true
        }
    }

    const SHEET_A: &str = "aaaaaaaaaaaaaaaa";
    const SHEET_B: &str = "bbbbbbbbbbbbbbbb";

    fn write_sheet(dir: &Path, key: &str, ids: &[&str]) {
        let candidates: Vec<Value> = ids
            .iter()
            .map(|id| json!({"id": id, "kind": "rank_top", "sql": "SELECT 1", "template": "t", "text": format!("claim {id}")}))
            .collect();
        std::fs::create_dir_all(dir.join("shadow")).unwrap();
        std::fs::write(
            dir.join(format!("shadow/candidate_sheet-{key}.json")),
            json!({"schema_version": "0.1.0", "kind": "candidate_sheet", "candidate_only": true, "candidates": candidates}).to_string(),
        )
        .unwrap();
    }

    fn offers() -> Vec<Candidate> {
        [
            "nrg_bal_c",
            "nrg_bal_peh",
            "nrg_ind_ren",
            "SP.POP.65UP.TO.ZS@2",
            "nrg_cb_e",
            "nrg_bal_s",
        ]
        .iter()
        .enumerate()
        .map(|(i, id)| Candidate {
            id: id.to_string(),
            title: format!("title of {id}"),
            score: 1.0 - i as f64 / 10.0,
            s: 2.0,
            v: 0.5,
            coverage: Coverage::World,
        })
        .collect()
    }

    /// A catalogue that returns these tables (or the uncovered level), flags "japan", and keeps what it was asked.
    struct FakeCatalogue {
        candidates: Vec<Candidate>,
        uncovered: Option<Uncovered>,
        source: Value,
        searched: std::sync::Mutex<Vec<(String, Vec<String>)>>,
    }

    impl FakeCatalogue {
        fn ranking(&self) -> Ranking {
            Ranking {
                scope: Scope::Europe,
                places_zh: vec!["德国".into(), "法国".into()],
                uncovered: self.uncovered.clone(),
                candidates: self.candidates.clone(),
            }
        }
    }

    impl Catalogue for FakeCatalogue {
        fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
            self.searched
                .lock()
                .unwrap()
                .push((question_zh.to_string(), texts.to_vec()));
            let mut ranking = self.ranking();
            ranking.candidates.truncate(5);
            ranking
        }

        fn places_outside(&self, _question_zh: &str, _texts: &[String]) -> Vec<String> {
            vec!["japan".into()]
        }

        fn source(&self) -> &Value {
            &self.source
        }
    }

    #[tokio::test]
    async fn a_fetch_moved_back_to_an_earlier_year_is_kept_as_one_program_event() {
        let _command = crate::group_guard::command_for_test("investigate");
        let fetch = |details: Vec<Value>| {
            drive(
                &[],
                vec![
                    search_reply(),
                    call("toolu_r", json!({"step": "table", "pick": [4]})),
                ],
                details,
                offers(),
            )
        };
        let back = json!({"asked": {"start": 2024, "end": 2024, "filePath": "data/a.csv"}, "window": {"start": 2019, "end": 2024, "filePath": "data/b.csv", "rows": 6},
            "latest": "2023", "used": 2023});
        let drove = fetch(vec![json!({"mode": "no_candidates", "years_back": back})]).await;
        assert!(
            matches!(drove.result, Err(Stop::TooFewClaims { .. })),
            "{:?}",
            drove.result
        );
        assert_eq!(
            drove.tools.args.len(),
            1,
            "the tool moves back inside its one call; the route fetches nothing more"
        );
        let events = of_type(&drove.events, YEARS_BACK_EVENT);
        assert_eq!(events.len(), 1);
        assert_eq!(
            (
                events[0]["asked"]["end"].clone(),
                events[0]["window"]["start"].clone(),
                events[0]["used"].clone()
            ),
            (json!(2024), json!(2019), json!(2023))
        );
        // nothing in the window either: the tool's no_rows stops the table with what it said, after the one event
        let drove = fetch(vec![json!({"mode": "no_rows", "text": "These codes have no values in these years.", "years_back": {"used": null}})]).await;
        assert!(
            matches!(&drove.result, Err(Stop::NotPrepared { mode, why, .. }) if mode == "no_rows" && why.contains("no values in these years")),
            "{:?}",
            drove.result
        );
        assert_eq!(of_type(&drove.events, YEARS_BACK_EVENT).len(), 1);
        // no years_back: no event
        let drove = fetch(vec![json!({"mode": "no_candidates"})]).await;
        assert!(of_type(&drove.events, YEARS_BACK_EVENT).is_empty());
    }

    #[tokio::test]
    async fn a_source_that_does_not_answer_is_fetched_again_twice_then_stops_as_unreachable() {
        let _command = crate::group_guard::command_for_test("investigate");
        let failed = |why: &str| json!({"mode": "failed", "text": format!("Data preparation failed: SOURCE_ACCESS_FAILED: network evidence fetch {why}. Do not substitute synthetic data; try a bounded alternative source.")});
        let timeout = || failed("timed out or was cancelled (1/3)");
        let fetch = |details: Vec<Value>| {
            drive(
                &[],
                vec![
                    search_reply(),
                    call("toolu_r", json!({"step": "table", "pick": [4]})),
                ],
                details,
                offers(),
            )
        };
        // q5 of the bench: a timeout, then the source answers on the second fetch with the same request
        let drove = fetch(vec![timeout(), json!({"mode": "no_candidates"})]).await;
        assert_eq!(
            drove.result,
            Err(Stop::TooFewClaims {
                dataset: "SP.POP.65UP.TO.ZS@2".into()
            })
        );
        assert_eq!(drove.tools.args.len(), 2);
        assert_eq!(drove.tools.args[0], drove.tools.args[1]);
        let retries = of_type(&drove.events, FETCH_RETRY_EVENT);
        assert_eq!(retries.len(), 1);
        assert_eq!(
            (retries[0]["try"].clone(), retries[0]["waited_ms"].clone()),
            (json!(2), json!(2_000))
        );
        assert!(retries[0]["after"].as_str().unwrap().contains("timed out"));
        // the source's own answer is not retried: 404 and 403 stop as before, after one fetch
        for status in ["404", "403"] {
            let drove = fetch(vec![failed(&format!("returned HTTP {status} (1/3)"))]).await;
            assert!(
                matches!(&drove.result, Err(Stop::NotPrepared { mode, .. }) if mode == "failed"),
                "{:?}",
                drove.result
            );
            assert_eq!(drove.tools.args.len(), 1);
            assert!(of_type(&drove.events, FETCH_RETRY_EVENT).is_empty());
        }
        // 503 and 429 are retried like a timeout
        let drove = fetch(vec![
            failed("returned HTTP 503 (1/3)"),
            failed("returned HTTP 429 (2/3)"),
            json!({"mode": "no_candidates"}),
        ])
        .await;
        assert!(
            matches!(drove.result, Err(Stop::TooFewClaims { .. })),
            "{:?}",
            drove.result
        );
        assert_eq!(drove.tools.args.len(), 3);
        // three timeouts: three fetches in all (the circuit's limit), two retry events, and the infrastructure stop
        let drove = fetch(vec![timeout(), timeout(), timeout()]).await;
        assert!(
            matches!(&drove.result, Err(Stop::SourceUnreachable { tries: 3, .. })),
            "{:?}",
            drove.result
        );
        assert!(drove
            .result
            .as_ref()
            .unwrap_err()
            .to_string()
            .starts_with("source unreachable: "));
        assert_eq!(drove.tools.args.len(), 3);
        assert_eq!(
            of_type(&drove.events, FETCH_RETRY_EVENT)
                .iter()
                .map(|e| e["waited_ms"].clone())
                .collect::<Vec<_>>(),
            [json!(2_000), json!(4_000)]
        );
        // a host the circuit blocked or marked unreachable is not fetched again
        let marked = failed(
            "could not resolve the host name (1/3). This host will not be tried again in this run.",
        );
        let blocked = json!({"mode": "failed", "text": "Data preparation failed: SOURCE_ACCESS_BLOCKED: 3 consecutive source-access attempts failed."});
        for (details, fetches) in [(vec![marked], 1), (vec![timeout(), blocked], 2)] {
            let drove = fetch(details).await;
            assert!(
                matches!(&drove.result, Err(Stop::SourceUnreachable { tries, .. }) if *tries == fetches),
                "{:?}",
                drove.result
            );
            assert_eq!(drove.tools.args.len(), fetches);
        }
    }

    struct Drove {
        result: Result<Vec<Prepared>, Stop>,
        model: ScriptedAsker,
        tools: ScriptedTools,
        events: Events,
        history: Vec<Value>,
        searched: Vec<(String, Vec<String>)>,
    }

    /// Runs the fixed order on the q3-like spec in a fresh run folder holding these sheets, with scripted model replies, scripted
    /// fetch details and this catalogue.
    async fn drive(
        sheets: &[(&str, &[&str])],
        replies: Vec<Value>,
        details: Vec<Value>,
        catalogue: Vec<Candidate>,
    ) -> Drove {
        drive_in(
            sheets,
            replies,
            details,
            FakeCatalogue {
                candidates: catalogue,
                uncovered: None,
                source: json!({"sha256_16": {"toc.txt": "9848059bc5d88da8"}}),
                searched: Default::default(),
            },
        )
        .await
    }

    async fn drive_in(
        sheets: &[(&str, &[&str])],
        replies: Vec<Value>,
        details: Vec<Value>,
        catalogue: FakeCatalogue,
    ) -> Drove {
        let run = tempfile::tempdir().unwrap();
        let dir = run.path();
        for (key, ids) in sheets {
            write_sheet(dir, key, ids);
        }
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(replies);
        let mut tools = ScriptedTools {
            details: details.into(),
            args: Vec::new(),
        };
        let steps = parse_prepare_spec(&q3_like().to_string()).unwrap();
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, dir, Vec::new(), Vec::new());
        let result = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "德国和法国的发电量",
            &steps,
            &catalogue,
            &cancel,
        )
        .await;
        let history = recorder.history().to_vec();
        drop(recorder);
        Drove {
            result,
            model,
            tools,
            events,
            history,
            searched: catalogue.searched.into_inner().unwrap(),
        }
    }

    fn search_reply() -> Value {
        call(
            "toolu_s",
            json!({"step": "search", "query": "electricity generation"}),
        )
    }

    #[tokio::test]
    async fn two_tables_take_three_model_calls_and_each_table_registers_its_own_picks() {
        let _command = crate::group_guard::command_for_test("investigate");
        let drove = drive(
            &[(SHEET_A, &["c1", "c2", "c3", "c4"]), (SHEET_B, &["w1", "w2", "w3"])],
            vec![
                search_reply(),
                call("toolu_t", json!({"step": "table", "pick": [2, 4]})),
                call("toolu_c", json!({"step": "claims", "pick": [4, 1, 2, 5, 6, 7]})),
            ],
            vec![
                json!({"mode": "too_large", "estimate": 90000}),
                json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 4}),
                json!({"mode": "candidates", "sheet": SHEET_B, "conclusions": 3}),
                json!({"mode": "picks", "claims": [{"candidate": "c4", "claim_id": "k1"}, {"candidate": "c1", "claim_id": "k2"}, {"candidate": "c2", "claim_id": "k3"}]}),
                json!({"mode": "picks", "claims": [{"candidate": "w1", "claim_id": "k4"}, {"candidate": "w2", "claim_id": "k5"}, {"candidate": "w3", "claim_id": "k6"}]}),
            ],
            offers(),
        )
        .await;
        let prepared = drove.result.unwrap();
        // search, tables, claims: the pick of each is one model call whatever the number of tables
        assert_eq!(drove.model.offered.len(), 3);
        assert!(drove.model.offered.len() <= 5);
        assert_eq!(
            drove.searched,
            [(
                "德国和法国的发电量".to_string(),
                vec!["electricity generation".to_string()]
            )]
        );
        // what the catalogue returned is kept whole, under the search answer, with the places flagged (not refused)
        let searched = of_type(&drove.events, CATALOGUE_EVENT);
        assert_eq!(searched.len(), 1);
        let fake = FakeCatalogue {
            candidates: offers(),
            uncovered: None,
            source: json!({"sha256_16": {"toc.txt": "9848059bc5d88da8"}}),
            searched: Default::default(),
        };
        let mut five = fake.ranking();
        five.candidates.truncate(5);
        assert_eq!(searched[0]["ranking"], serde_json::to_value(&five).unwrap());
        assert_eq!(
            searched[0]["ranking"]["candidates"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(searched[0]["ranking"]["candidates"][0]["s"], 2.0);
        assert_eq!(searched[0]["ranking"]["scope"], "europe");
        assert_eq!(searched[0]["source"], fake.source);
        assert_eq!(searched[0]["texts"], json!(["electricity generation"]));
        assert_eq!(searched[0]["places_outside"], json!(["japan"]));
        assert_eq!(searched[0]["auto_parent_call_id"], "toolu_s");
        // the search words are used only to search: no later prompt, fetch or result holds them
        let later: Vec<&Value> = drove
            .history
            .iter()
            .skip(1)
            .filter(|m| m["role"] == "user")
            .collect();
        assert!(!later.is_empty());
        for value in later.into_iter().chain(&drove.tools.args) {
            assert!(
                !value.to_string().contains("electricity generation"),
                "{value}"
            );
        }
        for table in &prepared {
            assert!(!format!("{table:?}").contains("electricity generation"));
        }
        let steps = q3_like();
        let narrowed = &steps[0]["narrowed"];
        let mut picks_a = narrowed.clone();
        picks_a["sheet"] = json!(SHEET_A);
        picks_a["picks"] = json!(["c4", "c1", "c2"]);
        let mut picks_b = steps[1].clone();
        picks_b["sheet"] = json!(SHEET_B);
        picks_b["picks"] = json!(["w1", "w2", "w3"]);
        let mut first = steps[0].clone();
        first.as_object_mut().unwrap().remove("narrowed");
        // the step's own request, the narrowed one once when asked, the second table; then each sheet with its picks
        assert_eq!(
            drove.tools.args,
            [first, narrowed.clone(), steps[1].clone(), picks_a, picks_b]
        );
        assert_eq!(prepared.len(), 2);
        assert_eq!(Value::Object(prepared[0].args.clone()), *narrowed);
        assert_eq!(prepared[0].sheet, SHEET_A);
        assert_eq!(prepared[1].claims.len(), 3);
        // fetches hang under the table answer, the registering ones under the claims answer
        let parents: Vec<String> = of_type(&drove.events, "tool_execution_start")
            .iter()
            .filter(|e| e["auto"] == true)
            .map(|e| e["auto_parent_call_id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            parents,
            ["toolu_t", "toolu_t", "toolu_t", "toolu_c", "toolu_c"]
        );
        // the model sees the first five tables and the claims numbered on across the tables, read from the sheet files
        let prompts: Vec<&str> = drove
            .history
            .iter()
            .filter(|m| m["role"] == "user")
            .map(|m| m["content"][0]["text"].as_str().unwrap())
            .collect();
        assert!(
            prompts[1].contains("5. title of nrg_cb_e (nrg_cb_e)")
                && !prompts[1].contains("nrg_bal_s")
        );
        assert!(prompts[1].contains("up to 2 tables"));
        assert!(prompts[2].contains("Table 2 (SP.POP.65UP.TO.ZS@2):\n5. claim w1"));
        assert!(
            prompts[2].contains("3 to 4 of claims 1-4 (table 1), 3 to 3 of claims 5-7 (table 2)")
        );
        assert_eq!(drove.model.offered[2]["properties"]["pick"]["minItems"], 6);
    }

    #[tokio::test]
    async fn the_order_stops_where_the_question_cannot_be_answered() {
        let _command = crate::group_guard::command_for_test("investigate");
        // the catalogue offers nothing: one model call, no fetch
        let drove = drive(&[], vec![search_reply()], vec![], vec![]).await;
        assert!(
            matches!(drove.result, Err(Stop::NoTable(_))),
            "{:?}",
            drove.result
        );
        assert_eq!(drove.model.offered.len(), 1);
        assert!(drove.tools.args.is_empty());
        // the model answers that no table fits
        let drove = drive(
            &[],
            vec![
                search_reply(),
                call("toolu_t0", json!({"step": "table", "pick": [0]})),
            ],
            vec![],
            offers(),
        )
        .await;
        assert!(
            matches!(drove.result, Err(Stop::NoTable(_))),
            "{:?}",
            drove.result
        );
        assert!(drove.tools.args.is_empty());
        // a picked table the spec has no parameters for: not wired, nothing fetched
        let drove = drive(
            &[],
            vec![
                search_reply(),
                call("toolu_t1", json!({"step": "table", "pick": [1]})),
            ],
            vec![],
            offers(),
        )
        .await;
        assert!(
            matches!(&drove.result, Err(Stop::TablePickNotWired(why)) if why.contains("nrg_bal_c")),
            "{:?}",
            drove.result
        );
        assert!(drove.tools.args.is_empty());
        // a sheet with two candidates, or the tool's own no_candidates: too few claims, the claims pick is never asked
        for details in [
            json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 2}),
            json!({"mode": "no_candidates"}),
        ] {
            let drove = drive(
                &[(SHEET_A, &["c1", "c2"])],
                vec![
                    search_reply(),
                    call("toolu_t2", json!({"step": "table", "pick": [4]})),
                ],
                vec![details],
                offers(),
            )
            .await;
            assert_eq!(
                drove.result,
                Err(Stop::TooFewClaims {
                    dataset: "SP.POP.65UP.TO.ZS@2".into()
                })
            );
            assert_eq!(drove.model.offered.len(), 2);
        }
        // any other mode, or a sheet key the run folder has no file for, is no sheet
        for details in [
            json!({"mode": "years_missing"}),
            json!({"mode": "candidates", "sheet": SHEET_B, "conclusions": 3}),
        ] {
            let drove = drive(
                &[],
                vec![
                    search_reply(),
                    call("toolu_t3", json!({"step": "table", "pick": [4]})),
                ],
                vec![details],
                offers(),
            )
            .await;
            assert!(
                matches!(drove.result, Err(Stop::NotPrepared { .. })),
                "{:?}",
                drove.result
            );
        }
        // a pick that does not verify stops the run; nothing after it is called
        let drove = drive(
            &[(SHEET_B, &["w1", "w2", "w3"])],
            vec![
                search_reply(),
                call("toolu_t4", json!({"step": "table", "pick": [4]})),
                call("toolu_c4", json!({"step": "claims", "pick": [1, 2, 3]})),
            ],
            vec![
                json!({"mode": "candidates", "sheet": SHEET_B, "conclusions": 3}),
                json!({"mode": "picks", "runStop": {"reason": "claim_replay_failed", "step": "picks"}}),
            ],
            offers(),
        )
        .await;
        assert_eq!(
            drove.result,
            Err(Stop::NotRegistered {
                dataset: "SP.POP.65UP.TO.ZS@2".into(),
                why: "the run stopped: claim_replay_failed".into()
            })
        );
        assert_eq!(drove.tools.args.len(), 2);
        // as many claims as picks, but not the picked candidates: not registered
        let drove = drive(
            &[(SHEET_B, &["w1", "w2", "w3"])],
            vec![
                search_reply(),
                call("toolu_t5", json!({"step": "table", "pick": [4]})),
                call("toolu_c5", json!({"step": "claims", "pick": [1, 2, 3]})),
            ],
            vec![
                json!({"mode": "candidates", "sheet": SHEET_B, "conclusions": 3}),
                json!({"mode": "picks", "claims": [{"candidate": "w1", "claim_id": "k1"}, {"candidate": "w2", "claim_id": "k2"}, {"candidate": "w9", "claim_id": "k3"}]}),
            ],
            offers(),
        )
        .await;
        assert!(
            matches!(&drove.result, Err(Stop::NotRegistered { why, .. }) if why.contains("w9")),
            "{:?}",
            drove.result
        );
        // a level the catalogues lack: cannot be answered, named, after one model call and no fetch; the ranking is still kept
        let drove = drive_in(
            &[],
            vec![search_reply()],
            vec![],
            FakeCatalogue {
                candidates: Vec::new(),
                uncovered: Some(Uncovered {
                    place_zh: "日本".into(),
                    level_zh: "各县".into(),
                }),
                source: json!({}),
                searched: Default::default(),
            },
        )
        .await;
        assert!(
            matches!(&drove.result, Err(Stop::NoTable(why)) if why.contains("各县") && why.contains("日本")),
            "{:?}",
            drove.result
        );
        assert_eq!(drove.model.offered.len(), 1);
        assert!(drove.tools.args.is_empty());
        let searched = of_type(&drove.events, CATALOGUE_EVENT);
        assert_eq!(searched[0]["ranking"]["uncovered"]["level_zh"], "各县");
    }

    /// The real catalogue: NEWS_CATALOG_DIR=<registry>/l5geo/catalog NEWS_CLASSIFY_REFS=<registry>/classify/refs cargo test next_flow::tests::the_real -- --include-ignored
    #[test]
    #[ignore]
    fn the_real_catalogue_loads_and_offers_five_tables() {
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        assert!(catalogue.source()["sha256_16"]["toc.txt"].is_string());
        let ranking = catalogue.top5(
            "德国和法国的发电量",
            &["electricity generation".to_string()],
        );
        println!("{}", serde_json::to_string(&ranking).unwrap());
        assert_eq!(ranking.candidates.len(), OFFERED_TABLES);
        assert!(ranking.uncovered.is_none());
        let texts = ["japan electricity".to_string()];
        assert_eq!(
            catalogue.places_outside("德国和法国的发电量", &texts),
            ["japan"]
        );
    }

    /// Every call of the knowledge group's command is kept as a GROUP_CALL_EVENT, a refused one too; record_group_calls hangs
    /// them under the step that asked and empties the queue.
    #[test]
    fn every_knowledge_group_call_is_kept_and_recorded_under_its_step() {
        let _command = crate::group_guard::command_for_test("investigate");
        let calls = Mutex::new(Vec::new());
        let dir = tempfile::tempdir().unwrap();
        let refused = knowledge_call(
            &calls,
            "open_catalogue",
            json!({"dir": dir.path()}),
            next_knowledge::Request::OpenCatalogue { dir: dir.path() },
        );
        assert!(matches!(&refused, Err(why) if why.contains("SOURCE.json")));
        let kept = calls.lock().unwrap().clone();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["group"], "knowledge");
        assert_eq!(kept[0]["request"], "open_catalogue");
        assert_eq!(kept[0]["ok"], false);
        assert!(kept[0]["ms"].is_u64());
        for hash in ["request_sha256", "reply_sha256"] {
            assert_eq!(kept[0][hash].as_str().map(str::len), Some(64), "{hash}");
        }
        struct Queued(Mutex<Vec<Value>>);
        impl Catalogue for Queued {
            fn top5(&self, _: &str, _: &[String]) -> Ranking {
                unreachable!()
            }
            fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
                unreachable!()
            }
            fn source(&self) -> &Value {
                unreachable!()
            }
            fn take_calls(&self) -> Vec<Value> {
                std::mem::take(&mut *self.0.lock().unwrap())
            }
        }
        let queued = Queued(calls);
        let mut events = Vec::new();
        let mut sink = |e: Value| events.push(e);
        let run = tempfile::tempdir().unwrap();
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        // no step asked yet: nothing to hang the call under
        assert!(matches!(
            record_group_calls(&mut recorder, &queued),
            Err(Stop::NoModelParent { .. })
        ));
        queued.0.lock().unwrap().extend(kept.clone());
        recorder.parent = Some("call-1".into());
        record_group_calls(&mut recorder, &queued).unwrap();
        record_group_calls(&mut recorder, &queued).unwrap();
        drop(recorder);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], GROUP_CALL_EVENT);
        assert_eq!(events[0]["auto_parent_call_id"], "call-1");
        assert_eq!(events[0]["request_sha256"], kept[0]["request_sha256"]);
    }

    #[test]
    fn a_visual_group_call_answers_as_the_matcher_and_is_kept() {
        use crate::shape_registry::{rank, Relation, Role, Shape, VaryingDim};
        let _command = crate::group_guard::command_for_test("investigate");
        let dim = |name: &str, members, roles: &[Role], place| VaryingDim {
            dim: name.into(),
            members,
            roles: roles.to_vec(),
            is_place: place,
            iso_countries: place,
            total_member: None,
        };
        let shape = Shape {
            dims: vec![
                dim("geo", 27, &[Role::Place], true),
                dim("time", 1, &[Role::Time], false),
            ],
            unit_additive: false,
            official_flow: None,
        };
        let registered: Vec<&str> = crate::shape_registry::RELATIONS
            .iter()
            .map(|r| r.template(crate::shape_registry::View::Slice))
            .collect();
        let calls = Mutex::new(Vec::new());
        let ask = |used_before: &[Relation]| {
            let request = next_visual::Request::Rank {
                shape: &shape,
                registered: &registered,
                used_before,
            };
            match visual_call(&calls, "rank", request).unwrap() {
                next_visual::Reply::Matched(matched) => matched,
                _ => unreachable!("rank answers Matched"),
            }
        };
        let first = ask(&[]);
        assert_eq!(first, rank(&shape, &registered, &[]));
        assert!(!first.candidates.is_empty());
        let used = [first.candidates[0].relation];
        assert_eq!(ask(&used), rank(&shape, &registered, &used));
        let kept = calls.lock().unwrap().clone();
        assert_eq!(kept.len(), 2);
        for event in &kept {
            assert_eq!(event["group"], "visual");
            assert_eq!(event["request"], "rank");
            assert_eq!(event["ok"], true);
            assert!(event["ms"].is_u64());
        }
        // a different page so far is a different request
        assert_ne!(kept[0]["request_sha256"], kept[1]["request_sha256"]);
    }

    #[test]
    fn a_missing_catalogue_is_a_configuration_error_not_cannot_be_answered() {
        let unset = GroupCatalogue::from_env(|_| None).err().unwrap();
        assert!(
            matches!(&unset, Stop::CatalogueNotConfigured(why) if why.contains(CATALOGUE_ENV)),
            "{unset:?}"
        );
        assert!(unset.to_string().starts_with("configuration error"));
        let empty = GroupCatalogue::from_env(|_| Some(String::new()))
            .err()
            .unwrap();
        assert!(
            matches!(empty, Stop::CatalogueNotConfigured(_)),
            "{empty:?}"
        );
        // a directory with no SOURCE.json, and one with SOURCE.json but no catalogue files
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        let only_catalogue = |key: &str| (key == CATALOGUE_ENV).then(|| path.clone());
        let no_refs = GroupCatalogue::from_env(only_catalogue).err().unwrap();
        assert!(
            matches!(&no_refs, Stop::CatalogueNotConfigured(why) if why.contains(CLASSIFY_REFS_ENV)),
            "{no_refs:?}"
        );
        let get = |key: &str| {
            [CATALOGUE_ENV, CLASSIFY_REFS_ENV]
                .contains(&key)
                .then(|| path.clone())
        };
        let no_source = GroupCatalogue::from_env(get).err().unwrap();
        assert!(
            matches!(&no_source, Stop::CatalogueNotConfigured(why) if why.contains("SOURCE.json")),
            "{no_source:?}"
        );
        std::fs::write(dir.path().join("SOURCE.json"), "{}").unwrap();
        let no_files = GroupCatalogue::from_env(get).err().unwrap();
        assert!(
            matches!(&no_files, Stop::CatalogueNotConfigured(why) if why.contains("cannot be read")),
            "{no_files:?}"
        );
        for stop in [unset, empty, no_refs, no_source, no_files] {
            assert!(!matches!(stop, Stop::NoTable(_)));
        }
    }

    /// A FakeCatalogue that also lists the dimensions of one table.
    struct WithTable(FakeCatalogue, TableMeta);

    impl Catalogue for WithTable {
        fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
            self.0.top5(question_zh, texts)
        }
        fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
            self.0.places_outside(question_zh, texts)
        }
        fn source(&self) -> &Value {
            self.0.source()
        }
        fn table(&self, id: &str) -> Option<TableMeta> {
            (id == self.1.id).then(|| self.1.clone())
        }
    }

    #[tokio::test]
    async fn with_no_spec_the_table_pick_carries_the_params_and_fill_steps_fills_the_fetch() {
        let _command = crate::group_guard::command_for_test("investigate");
        // one place: a split by nrg_bal or siec is one varying dimension (two with ten years), which a filled template draws
        let dims = [
            ("nrg_bal", vec!["GEP", "GHP"]),
            ("siec", vec!["TOTAL", "RA000", "G3000"]),
            ("geo", vec!["DE"]),
            ("unit", vec!["GWH"]),
        ];
        let meta = TableMeta {
            id: "nrg_bal_peh".into(),
            worldbank: false,
            dims: dims
                .into_iter()
                .map(|(d, codes)| {
                    (
                        d.to_string(),
                        codes
                            .into_iter()
                            .map(|c| (c.to_string(), String::new()))
                            .collect(),
                    )
                })
                .collect(),
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        let catalogue = WithTable(
            FakeCatalogue {
                candidates: offers(),
                uncovered: None,
                source: json!({}),
                searched: Default::default(),
            },
            meta,
        );
        let run = tempfile::tempdir().unwrap();
        write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            // table 2 is nrg_bal_peh; t1.years is an item of a table not picked
            call(
                "toolu_t0",
                json!({"step": "table", "pick": [2], "params": {"t1.years": 1}}),
            ),
            call(
                "toolu_t",
                json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 3, "t2.nrg_bal": 1}}),
            ),
            call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
        ]);
        let mut tools = ScriptedTools {
            details: vec![
                json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 3}),
                json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]}),
            ]
            .into(),
            args: Vec::new(),
        };
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        let result = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "德国的发电结构",
            &[],
            &catalogue,
            &cancel,
        )
        .await;
        let history = serde_json::to_string(recorder.history()).unwrap();
        drop(recorder);
        result.unwrap();
        // search, the table pick with its params (refused once), claims: no params call of its own
        assert_eq!(model.offered.len(), 4);
        assert!(model.offered[1]["properties"]["params"]["properties"]["t2.nrg_bal"].is_object());
        assert!(history.contains("t2.breakdown:"), "{history}");
        assert!(history.contains("split by nrg_bal: each place × all 2 nrg_bal codes (e.g. GEP; GHP); leave out t2.nrg_bal"), "{history}");
        assert!(
            history.contains("t2.nrg_bal (only when t2.breakdown is not nrg_bal):"),
            "{history}"
        );
        assert!(
            history.contains("params has no item 't1.years'"),
            "{history}"
        );
        assert_eq!(
            tools.args[0],
            json!({"dataset": "nrg_bal_peh", "filters": [
                {"dimension": "freq", "values": ["A"]}, {"dimension": "nrg_bal", "values": ["GEP"]},
                {"dimension": "unit", "values": ["GWH"]}, {"dimension": "geo", "values": ["DE"]}],
                "years": {"start": 2024, "end": 2024}})
        );
        let events = events.lock().unwrap();
        let params = events.iter().find(|e| e["type"] == PARAMS_EVENT).unwrap();
        assert_eq!(params["params"], "model");
        assert_eq!(
            params["picks"],
            json!({"t2.years": 1, "t2.breakdown": 3, "t2.nrg_bal": 1})
        );
        assert_eq!(params["tables"][0]["open"], "siec");
        let breakdown = events
            .iter()
            .find(|e| e["type"] == BREAKDOWN_EVENT)
            .unwrap();
        assert_eq!(
            breakdown["tables"],
            json!([{"table": "nrg_bal_peh", "dropped": [], "offered": [
                {"option": 2, "dim": "nrg_bal", "years": [1, 2], "member": true}, {"option": 3, "dim": "siec", "years": [1, 2], "member": false}]}]),
            "only the tables the catalogue lists dimensions for"
        );
    }

    /// WithTable for a question that names Germany, whose held-series probe answers `reply` (None: never).
    struct Probing(WithTable, Option<(u16, &'static str)>);

    impl Catalogue for Probing {
        fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
            self.0.top5(question_zh, texts)
        }
        fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
            self.0.places_outside(question_zh, texts)
        }
        fn source(&self) -> &Value {
            self.0.source()
        }
        fn table(&self, id: &str) -> Option<TableMeta> {
            self.0.table(id)
        }
        fn places(&self, _question_zh: &str) -> Vec<Place> {
            vec![Place::Country("DE".into())]
        }
        fn held_probe(
            &self,
            table: &str,
            _key: &[(String, Vec<String>)],
        ) -> Option<(String, next_knowledge::HeldFuture)> {
            let url = format!("probe of {table}");
            Some(match self.1 {
                Some((status, body)) => {
                    (url, Box::pin(async move { Ok((status, body.to_string())) }))
                }
                None => (url, Box::pin(std::future::pending())),
            })
        }
    }

    /// q3's table (nrg_cb_pem, cut): monthly only; TOTAL is held in GWH only, the fuels in GWH and PC.
    fn q3_probing(reply: Option<(u16, &'static str)>) -> Probing {
        let dims = [
            ("geo", vec!["DE", "FR"]),
            ("siec", vec!["TOTAL", "C0000", "RA100"]),
            ("unit", vec!["GWH", "PC"]),
        ];
        let meta = TableMeta {
            id: "nrg_bal_peh".into(),
            worldbank: false,
            dims: dims
                .into_iter()
                .map(|(d, codes)| {
                    (
                        d.to_string(),
                        codes
                            .into_iter()
                            .map(|c| (c.to_string(), format!("label {c}")))
                            .collect(),
                    )
                })
                .collect(),
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: vec![("M".into(), "2008M01".into(), "2024M12".into())],
            unit: None,
        };
        Probing(
            WithTable(
                FakeCatalogue {
                    candidates: offers(),
                    uncovered: None,
                    source: json!({}),
                    searched: Default::default(),
                },
                meta,
            ),
            reply,
        )
    }

    const Q3_HELD: &str = "STRUCTURE,STRUCTURE_ID,freq,siec,unit,geo\r\n\
        dataflow,ESTAT:X(1.0),M,TOTAL,GWH,DE\r\ndataflow,ESTAT:X(1.0),M,C0000,GWH,DE\r\ndataflow,ESTAT:X(1.0),M,C0000,PC,DE\r\n\
        dataflow,ESTAT:X(1.0),M,RA100,GWH,DE\r\ndataflow,ESTAT:X(1.0),M,RA100,PC,DE\r\n";

    fn claims_tools() -> ScriptedTools {
        ScriptedTools {
            details: vec![
                json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 3}),
                json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]}),
            ]
            .into(),
            args: Vec::new(),
        }
    }

    /// q3's second stop (unit PC with no breakdown: TOTAL in PC has no series): the probe's series keys refuse that answer
    /// with an example that holds, the answer after it fetches, and the probe's reply is saved for the replay.
    #[tokio::test]
    async fn a_picked_combination_the_probe_found_no_series_for_is_refused_with_one_that_holds() {
        let _command = crate::group_guard::command_for_test("investigate");
        let catalogue = q3_probing(Some((200, Q3_HELD)));
        let run = tempfile::tempdir().unwrap();
        write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            call(
                "toolu_t0",
                json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1, "t2.unit": 2}}),
            ),
            call(
                "toolu_t",
                json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1, "t2.unit": 1}}),
            ),
            call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
        ]);
        let mut tools = claims_tools();
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        let result = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "德国各能源发电量",
            &[],
            &catalogue,
            &cancel,
        )
        .await;
        let history = serde_json::to_string(recorder.history()).unwrap();
        drop(recorder);
        result.unwrap();
        assert!(
            history.contains(
                "t2: Eurostat holds no series for siec=TOTAL, unit=PC (probed before the pick)"
            ),
            "{history}"
        );
        assert!(
            history.contains("for example t2.breakdown 2, t2.unit 2, t2.years 1"),
            "{history}"
        );
        assert_eq!(
            tools.args[0]["filters"][1],
            json!({"dimension": "siec", "values": ["TOTAL"]})
        );
        assert_eq!(
            tools.args[0]["filters"][2],
            json!({"dimension": "unit", "values": ["GWH"]})
        );
        let held = &of_type(&events, HELD_EVENT)[0]["tables"][1];
        assert_eq!(
            (held["table"].as_str(), &held["series"]),
            (Some("nrg_bal_peh"), &json!(5))
        );
        assert_eq!(held["key"], json!([["freq", ["M"]], ["geo", ["DE"]]]));
        let saved: Value = serde_json::from_str(
            &std::fs::read_to_string(run.path().join(HELD_DIR).join("nrg_bal_peh.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["reply"], json!({"status": 200, "body": Q3_HELD}));
    }

    /// A probe that never answers is unprobed after HELD_TIMEOUT and the run goes on with the metabase codes: the same
    /// fetch as with no probe at all.
    #[tokio::test]
    async fn a_probe_past_the_timeout_is_unprobed_and_never_stops_the_run() {
        let _command = crate::group_guard::command_for_test("investigate");
        let answers = || {
            vec![
                search_reply(),
                call(
                    "toolu_t",
                    json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1, "t2.unit": 2}}),
                ),
                call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
            ]
        };
        let mut fetched = Vec::new();
        for reply in [None, Some((400, "<S:Fault/>"))] {
            let catalogue = q3_probing(reply);
            let run = tempfile::tempdir().unwrap();
            write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
            let (events, mut sink) = collector();
            let mut model = ScriptedAsker::new(answers());
            let mut tools = claims_tools();
            let cancel = AtomicBool::new(false);
            let started = std::time::Instant::now();
            let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
            prepare_claims(
                &mut recorder,
                &mut model,
                &mut tools,
                "德国各能源发电量",
                &[],
                &catalogue,
                &cancel,
            )
            .await
            .unwrap();
            drop(recorder);
            let table = &of_type(&events, HELD_EVENT)[0]["tables"][1];
            match reply {
                None => {
                    assert_eq!(table["unprobed"], "no reply within 3 s");
                    assert!(
                        started.elapsed()
                            < next_knowledge::HELD_TIMEOUT + std::time::Duration::from_secs(2)
                    );
                }
                Some(_) => assert_eq!(
                    table["unprobed"], "HTTP 400",
                    "a 400 is never read as no series"
                ),
            }
            fetched.push(tools.args[0].clone());
        }
        assert_eq!(
            fetched[0]["filters"][2],
            json!({"dimension": "unit", "values": ["PC"]}),
            "the metabase codes, as before"
        );
        assert_eq!(fetched[0], fetched[1]);
    }

    /// A listed table the probe found no series in is dropped before the ask while another table is listed.
    #[tokio::test]
    async fn a_table_with_no_series_is_dropped_before_the_ask() {
        let _command = crate::group_guard::command_for_test("investigate");
        let catalogue = q3_probing(Some((200, "STRUCTURE,STRUCTURE_ID,freq,siec,unit,geo\r\n")));
        let run = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            call("toolu_t", json!({"step": "table", "pick": [0]})),
        ]);
        let mut tools = claims_tools();
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        let result = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "德国各能源发电量",
            &[],
            &catalogue,
            &cancel,
        )
        .await;
        let history = serde_json::to_string(recorder.history()).unwrap();
        drop(recorder);
        assert!(
            result.is_err(),
            "the fake's other tables list no dimensions"
        );
        assert!(!history.contains("(nrg_bal_peh)"), "{history}");
        assert!(history.contains("(nrg_bal_c)"), "{history}");
        let table = &of_type(&events, HELD_EVENT)[0]["tables"][1];
        assert_eq!(
            (table["table"].as_str(), &table["dropped"]),
            (Some("nrg_bal_peh"), &json!(true))
        );
    }

    /// Measurement, not a check (ignored; live Eurostat, no relay): the held-series probe as a run makes it, over recorded runs
    /// (NEXT_HELD_RUNS=<events.jsonl>,..; the catalogue's env as for a run). Per question the five listed tables, each line the
    /// table, whether it was probed, its milliseconds and what came back; then the question's wall time and the totals.
    #[tokio::test]
    #[ignore]
    async fn measure_held_series_over_recorded_runs() {
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let this_year = chrono::Datelike::year(&chrono::Local::now());
        let (mut probed, mut unprobed, mut walls) = (0, 0, Vec::new());
        for path in std::env::var("NEXT_HELD_RUNS").unwrap().split(',') {
            let text = std::fs::read_to_string(path).unwrap();
            let event: Value = text
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .find(|e| e["type"] == CATALOGUE_EVENT)
                .unwrap();
            let question = event["question"].as_str().unwrap();
            let texts: Vec<String> = serde_json::from_value(event["texts"].clone()).unwrap();
            let ids: Vec<String> = event["ranking"]["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .take(OFFERED_TABLES)
                .map(|c| c["id"].as_str().unwrap().to_string())
                .collect();
            let places = catalogue.places(question);
            let loading = std::time::Instant::now();
            let metas: Vec<Option<TableMeta>> = ids.iter().map(|id| catalogue.table(id)).collect();
            let load = loading.elapsed().as_millis();
            let started = std::time::Instant::now();
            let mut tasks = Vec::new();
            for (id, meta) in ids.iter().zip(metas) {
                let key = meta.as_ref().and_then(|m| {
                    next_params::probe_key(
                        &next_params::draft(m.clone(), &texts, &places),
                        &places,
                        this_year,
                    )
                });
                let probe = key.as_ref().and_then(|k| catalogue.held_probe(id, k));
                tasks.push((
                    id,
                    meta,
                    key,
                    probe.map(|(_, reply)| {
                        tokio::spawn(async move {
                            let t = std::time::Instant::now();
                            (
                                tokio::time::timeout(next_knowledge::HELD_TIMEOUT, reply).await,
                                t.elapsed().as_millis(),
                            )
                        })
                    }),
                ));
            }
            let mut any = false;
            for (id, meta, key, task) in tasks {
                let Some(task) = task else {
                    println!(
                        "{question}\t{id}\tnot probed\t-\t{}",
                        if meta.as_ref().is_some_and(|m| m.worldbank) {
                            "World Bank"
                        } else {
                            "no key"
                        }
                    );
                    continue;
                };
                any = true;
                probed += 1;
                let (reply, ms) = task.await.unwrap();
                let held = match reply {
                    Ok(Ok((status, body))) => catalogue.read_held(status, &body),
                    Ok(Err(e)) => next_knowledge::Held::Unprobed(e),
                    Err(_) => next_knowledge::Held::Unprobed("no reply within 3 s".into()),
                };
                let what = match &held {
                    next_knowledge::Held::Unprobed(why) => {
                        unprobed += 1;
                        format!("unprobed: {}", why.chars().take(80).collect::<String>())
                    }
                    next_knowledge::Held::Series { keys, .. } => match next_params::held_table(
                        meta.as_ref().unwrap(),
                        key.as_ref().unwrap(),
                        &held,
                    ) {
                        Ok((_, narrowed)) => format!("{} series; narrowed {narrowed}", keys.len()),
                        Err(why) => format!("dropped: {why}"),
                    },
                };
                println!("{question}\t{id}\tprobed {:?}\t{ms}\t{what}", key.unwrap());
            }
            let wall = started.elapsed().as_millis();
            println!(
                "{question}\twall\tprobes {wall} ms, tables loaded before in {load} ms{}",
                if any { "" } else { " (nothing probed)" }
            );
            if any {
                walls.push(wall);
            }
        }
        println!("probed {probed}, unprobed {unprobed}, walls {walls:?}");
    }

    /// Replay, not a check (ignored; live Eurostat, no relay): for each table a recorded run fetched rows from, with the
    /// filters it used (NEXT_HELD_CASES=<json [{run, events, table, filters: {dim: [codes]}}]>; events gives the question),
    /// the probe this commit makes for it. A line per case: whether the table would be dropped, which fetched codes the
    /// narrowing would leave out, and whether some held series matches the fetched codes on the dims the key left open
    /// (none = the combination check would refuse that pick). The catalogue's env as for a run.
    #[tokio::test]
    #[ignore]
    async fn replay_held_series_over_fetched_tables() {
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let this_year = chrono::Datelike::year(&chrono::Local::now());
        let cases: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("NEXT_HELD_CASES").unwrap()).unwrap(),
        )
        .unwrap();
        let mut false_stops = 0;
        for case in &cases {
            let (run, id) = (
                case["run"].as_str().unwrap(),
                case["table"].as_str().unwrap(),
            );
            let event: Value = std::fs::read_to_string(case["events"].as_str().unwrap())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .find(|e| e["type"] == CATALOGUE_EVENT)
                .unwrap();
            let question = event["question"].as_str().unwrap();
            let texts: Vec<String> = serde_json::from_value(event["texts"].clone()).unwrap();
            let fetched: BTreeMap<String, Vec<String>> =
                serde_json::from_value(case["filters"].clone()).unwrap();
            let places = catalogue.places(question);
            let Some(meta) = catalogue.table(id) else {
                println!("{run}\t{id}\tnot in the catalogue");
                continue;
            };
            let draft = next_params::draft(meta.clone(), &texts, &places);
            let Some(key) = next_params::probe_key(&draft, &places, this_year) else {
                println!("{run}\t{id}\tno probe key (unprobed: today's codes)");
                continue;
            };
            let Some((_, reply)) = catalogue.held_probe(id, &key) else {
                println!("{run}\t{id}\tno probe (unprobed: today's codes)");
                continue;
            };
            let held = match tokio::time::timeout(next_knowledge::HELD_TIMEOUT, reply).await {
                Ok(Ok((status, body))) => catalogue.read_held(status, &body),
                Ok(Err(e)) => next_knowledge::Held::Unprobed(e),
                Err(_) => next_knowledge::Held::Unprobed("no reply within 3 s".into()),
            };
            let fixed: Vec<String> = key
                .iter()
                .filter_map(|(d, v)| {
                    let used = fetched.get(d)?;
                    (used != v).then(|| format!("{d} key {v:?} run {used:?}"))
                })
                .collect();
            let next_knowledge::Held::Series { dims, keys } = &held else {
                println!("{run}\t{id}\tunprobed (today's codes)\t{key:?}");
                continue;
            };
            let narrowed = match next_params::held_table(&meta, &key, &held) {
                Ok((narrowed, _)) => narrowed,
                Err(why) => {
                    false_stops += 1;
                    println!("{run}\t{id}\tFALSE STOP dropped: {why}\t{key:?}");
                    continue;
                }
            };
            let left_out: Vec<String> = fetched
                .iter()
                .filter_map(|(d, used)| {
                    let before = &meta.dims.iter().find(|(m, _)| m == d)?.1;
                    let after = &narrowed.dims.iter().find(|(m, _)| m == d)?.1;
                    let out: Vec<&String> = used
                        .iter()
                        .filter(|c| before.iter().any(|(b, _)| b == *c))
                        .filter(|c| !after.iter().any(|(a, _)| a == *c))
                        .collect();
                    (!out.is_empty()).then(|| format!("{d} {out:?}"))
                })
                .collect();
            let wanted: Vec<(usize, &Vec<String>)> = fetched
                .iter()
                .filter(|(d, _)| !key.iter().any(|(k, _)| k == *d))
                .filter_map(|(d, used)| Some((dims.iter().position(|c| c == d)?, used)))
                .collect();
            let combination = keys.iter().any(|k| {
                wanted
                    .iter()
                    .all(|(col, used)| k.get(*col).is_some_and(|c| used.contains(c)))
            });
            if !left_out.is_empty() || !combination {
                false_stops += 1;
            }
            println!(
                "{run}\t{id}\t{} series\tleft out {left_out:?}\tcombination {}\tkey differs {fixed:?}",
                keys.len(),
                if combination { "held" } else { "FALSE STOP refused" }
            );
        }
        println!("cases {}, false stops {false_stops}", cases.len());
    }

    /// Replay, not a check (ignored; the catalogue's env as for a run, no network): for each table a recorded run fetched rows from
    /// (NEXT_HELD_CASES, as above), whether its latest-year fetch would be summed. A summed fetch the run made at its own annual freq
    /// is a changed fill, so a regression; the family's tables named in NEXT_SUM_FAMILY (comma-separated) are printed too.
    #[test]
    #[ignore]
    fn replay_summed_year_over_fetched_tables() {
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let cases: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("NEXT_HELD_CASES").unwrap()).unwrap(),
        )
        .unwrap();
        let mut changed = 0;
        for case in &cases {
            let id = case["table"].as_str().unwrap();
            let Some(meta) = catalogue.table(id) else {
                println!("{}\t{id}\tnot in the catalogue", case["run"]);
                continue;
            };
            let summed = next_params::sum_year(&meta);
            changed += usize::from(summed.is_some());
            println!(
                "{}\t{id}\tfreq {:?}\tsummed {summed:?}",
                case["run"],
                meta.freq()
            );
        }
        for id in std::env::var("NEXT_SUM_FAMILY")
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
        {
            let meta = catalogue.table(id);
            println!(
                "family\t{id}\tfreq {:?}\tsummed {:?}",
                meta.as_ref().map(|m| m.freq().map(str::to_string)),
                meta.as_ref().and_then(next_params::sum_year)
            );
        }
        println!("cases {}, changed fills {changed}", cases.len());
        assert_eq!(changed, 0);
    }

    /// WithTable for a question that names the EU.
    struct InTheEu(WithTable);

    impl Catalogue for InTheEu {
        fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
            self.0.top5(question_zh, texts)
        }
        fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
            self.0.places_outside(question_zh, texts)
        }
        fn source(&self) -> &Value {
            self.0.source()
        }
        fn table(&self, id: &str) -> Option<TableMeta> {
            self.0.table(id)
        }
        fn places(&self, _question_zh: &str) -> Vec<Place> {
            vec![Place::Region]
        }
    }

    /// q1 (欧盟各国可再生能源占比) on sdg_07_40: split by nrg_bal, the EU's 27 members × 4 codes vary in two dimensions, which no
    /// filled template draws with either years option, so the table pick offers no breakdown. The 07:30 stand-in's table answer,
    /// kept byte for byte, names t1.breakdown and is refused; the second answer, without it, fetches one nrg_bal code for the 27.
    #[tokio::test]
    async fn a_split_no_filled_template_draws_is_not_offered_and_the_0730_answer_is_refused_once() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut geo: Vec<&str> = next_params::EU27.to_vec();
        geo.extend(["EU27_2020", "NO", "IS"]);
        let dims = [
            ("nrg_bal", vec!["REN", "REN_TRA", "REN_ELC", "REN_HEAT_CL"]),
            ("geo", geo),
            ("unit", vec!["PC"]),
        ];
        let meta = TableMeta {
            id: "sdg_07_40".into(),
            worldbank: false,
            dims: dims
                .into_iter()
                .map(|(d, codes)| {
                    (
                        d.to_string(),
                        codes
                            .into_iter()
                            .map(|c| (c.to_string(), String::new()))
                            .collect(),
                    )
                })
                .collect(),
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        let mut candidates = offers();
        candidates[0].id = "sdg_07_40".into();
        let catalogue = InTheEu(WithTable(
            FakeCatalogue {
                candidates,
                uncovered: None,
                source: json!({}),
                searched: Default::default(),
            },
            meta,
        ));
        let run = tempfile::tempdir().unwrap();
        write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
        let (events, mut sink) = collector();
        let at_0730: Value = serde_json::from_str(r#"{"step":"table","pick":[1],"params":{"t1.years":1,"t1.breakdown":1,"t1.nrg_bal":1}}"#).unwrap();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            call("toolu_t0", at_0730),
            call(
                "toolu_t",
                json!({"step": "table", "pick": [1], "params": {"t1.years": 1, "t1.nrg_bal": 1}}),
            ),
            call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
        ]);
        let mut tools = ScriptedTools {
            details: vec![
                json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 3}),
                json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]}),
            ]
            .into(),
            args: Vec::new(),
        };
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        let result = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "欧盟各国可再生能源占比",
            &[],
            &catalogue,
            &cancel,
        )
        .await;
        let history = serde_json::to_string(recorder.history()).unwrap();
        drop(recorder);
        result.unwrap();
        assert_eq!(model.offered.len(), 4);
        let params = &model.offered[1]["properties"]["params"]["properties"];
        assert!(
            params["t1.breakdown"].is_null() && params["t1.nrg_bal"].is_object(),
            "{params}"
        );
        assert!(!history.contains("t1.breakdown:"), "{history}");
        assert!(
            history
                .contains("params has no item 't1.breakdown' among the items of the picked tables"),
            "{history}"
        );
        assert_eq!(
            tools.args[0]["filters"][1],
            json!({"dimension": "nrg_bal", "values": ["REN"]})
        );
        assert_eq!(
            tools.args[0]["filters"][3]["values"]
                .as_array()
                .unwrap()
                .len(),
            27
        );
        let events = events.lock().unwrap();
        let breakdown = events
            .iter()
            .find(|e| e["type"] == BREAKDOWN_EVENT)
            .unwrap();
        assert_eq!(breakdown["tables"][0]["offered"], json!([]));
        let dropped = &breakdown["tables"][0]["dropped"][0];
        assert_eq!(dropped["dim"], "nrg_bal");
        assert_eq!(
            dropped["why"][0]["shape"],
            json!([["geo", 27], ["nrg_bal", 4]])
        );
        assert_eq!(
            dropped["why"][1]["shape"],
            json!([["geo", 27], ["nrg_bal", 4], ["time", 10]])
        );
    }

    /// Measurement, not a check (ignored; NEXT_SPLIT_ASKS=<tsv of label, question, search words> and the catalogue's env as for
    /// a run): each recorded table ask rebuilt on the real catalogue; per listed table, the breakdown dimensions that are also an
    /// item (the pair the ask allowed), and whether drawable_splits leaves it no breakdown item. One line per ask, then the totals.
    #[test]
    #[ignore]
    fn measure_splits_over_recorded_table_asks() {
        let _command = crate::group_guard::command_for_test("investigate");
        let Ok(path) = std::env::var("NEXT_SPLIT_ASKS") else {
            return;
        };
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let this_year = chrono::Datelike::year(&chrono::Local::now());
        let mut total = BTreeMap::from([
            ("asks", 0),
            ("asks_with_pair", 0),
            ("asks_losing_an_item", 0),
            ("tables", 0),
            ("tables_with_pair", 0),
            ("tables_with_breakdown", 0),
            ("tables_losing_the_item", 0),
            ("options_before", 0),
            ("options_dropped", 0),
        ]);
        let mut add = |key: &'static str, n: usize| *total.get_mut(key).unwrap() += n;
        for line in std::fs::read_to_string(path).unwrap().lines() {
            let [label, question, words] = line.split('\t').collect::<Vec<_>>()[..] else {
                continue;
            };
            let texts = vec![words.to_string()];
            let ranking = catalogue.top5(question, &texts);
            let places = catalogue.places(question);
            let mut rows = Vec::new();
            for (i, t) in ranking.candidates.iter().take(OFFERED_TABLES).enumerate() {
                let Some(meta) = catalogue.table(&t.id) else {
                    continue;
                };
                let mut d = next_params::draft(meta, &texts, &places);
                let pair: Vec<String> = d
                    .breakdown
                    .iter()
                    .filter(|b| d.members.iter().any(|(m, _, _)| m == *b))
                    .cloned()
                    .collect();
                let before = d.breakdown.len();
                let (splits, event) =
                    drawable_splits(&mut d, i + 1, &places, this_year, &catalogue);
                let lost = before > 0 && splits.is_empty();
                for (key, n) in [
                    ("tables", 1),
                    ("tables_with_pair", usize::from(!pair.is_empty())),
                    ("tables_with_breakdown", usize::from(before > 0)),
                    ("tables_losing_the_item", usize::from(lost)),
                    ("options_before", before),
                    ("options_dropped", before - splits.len()),
                ] {
                    add(key, n);
                }
                rows.push(json!({"table": t.id, "pair": pair, "options_before": before, "offered": event["offered"],
                    "dropped": event["dropped"].as_array().unwrap().iter().map(|d| d["dim"].clone()).collect::<Vec<_>>(), "lost_item": lost}));
            }
            add("asks", 1);
            add(
                "asks_with_pair",
                usize::from(
                    rows.iter()
                        .any(|r| r["pair"].as_array().is_some_and(|p| !p.is_empty())),
                ),
            );
            add(
                "asks_losing_an_item",
                usize::from(rows.iter().any(|r| r["lost_item"] == true)),
            );
            println!(
                "SPLITS {}",
                json!({"ask": label, "question": question, "places": places.len(), "tables": rows})
            );
        }
        println!("SPLITS_TOTAL {}", json!(total));
    }

    /// The tools another group owns (groups.json `tools`), and the source of the flow group's own files with their tests cut.
    fn flow_sources_and_tools(group: &str) -> (Vec<(String, String)>, Vec<String>) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let groups: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("runtime/pi/groups.json")).unwrap(),
        )
        .unwrap();
        let tools: Vec<String> = groups["tools"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, t)| t["group"] == group)
            .map(|(name, _)| name.clone())
            .collect();
        let sources = groups["files"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(path, f)| path.starts_with("src/next_") && f["group"] == "agent")
            .map(|(path, _)| {
                let text = std::fs::read_to_string(root.join(path)).unwrap();
                let product = text
                    .split("#[cfg(test)]\nmod tests")
                    .next()
                    .unwrap()
                    .to_string();
                (path.clone(), product)
            })
            .collect();
        (sources, tools)
    }

    /// The text of every call `.{method}(...)` in `source`, parentheses balanced.
    fn calls_of<'s>(source: &'s str, method: &str) -> Vec<&'s str> {
        let open = format!(".{method}(");
        source
            .match_indices(&open)
            .map(|(at, _)| {
                let rest = &source[at + open.len()..];
                let mut depth = 1;
                let end = rest
                    .char_indices()
                    .find(|&(_, c)| {
                        depth += match c {
                            '(' => 1,
                            ')' => -1,
                            _ => 0,
                        };
                        depth == 0
                    })
                    .map_or(rest.len(), |(i, _)| i);
                &rest[..end]
            })
            .collect()
    }

    /// The names the flow could hold one of these tools under: its string, a constant set to it or to another group's constant
    /// of it, and a `let` bound to any of those.
    fn tool_names(sources: &[(String, String)], tools: &[String]) -> Vec<String> {
        let mut names: Vec<String> = tools.iter().map(|t| format!("\"{t}\"")).collect();
        // constants are looked for in every new-route file: the owning group's own file names its tools too
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let every: Vec<String> = std::fs::read_dir(root.join("src"))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("next_")
            })
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        let lines: Vec<&str> = sources
            .iter()
            .map(|(_, s)| s.as_str())
            .chain(every.iter().map(String::as_str))
            .flat_map(str::lines)
            .map(str::trim)
            .collect();
        for _ in 0..2 {
            for line in &lines {
                let Some((name, value)) = line
                    .strip_prefix("pub const ")
                    .or_else(|| line.strip_prefix("const "))
                    .and_then(|l| l.split_once(": &str = "))
                else {
                    continue;
                };
                let value = value.trim_end_matches(';').trim();
                let last = value.rsplit("::").next().unwrap_or(value);
                if !names.iter().any(|n| n == name) && names.iter().any(|n| n == value || n == last)
                {
                    names.push(name.to_string());
                }
            }
        }
        // a let is the flow's own: only its files
        for line in sources.iter().flat_map(|(_, s)| s.lines()).map(str::trim) {
            let Some((name, value)) = line.strip_prefix("let ").and_then(|l| l.split_once(" = "))
            else {
                continue;
            };
            let name = name.split(':').next().unwrap().trim();
            let value = value.trim_end_matches(';');
            let last = value.rsplit("::").next().unwrap_or(value);
            if names.iter().any(|n| n == value || n == last) {
                names.push(name.to_string());
            }
        }
        names
    }

    /// Every run of one of these names straight on the host: `.auto(`, `.run(`, or a lent host called on the spot.
    fn direct_runs(sources: &[(String, String)], names: &[String]) -> Vec<String> {
        let names_one = |call: &str| {
            names.iter().any(|n| {
                call.match_indices(n.as_str()).any(|(at, _)| {
                    !call[at + n.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_')
                        && !call[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_')
                })
            })
        };
        let mut direct = Vec::new();
        for (path, source) in sources {
            for call in ["auto", "run"].iter().flat_map(|m| calls_of(source, m)) {
                if names_one(call) {
                    direct.push(format!("{path}: .({call})"));
                }
            }
            // a lent host is only ever handed to a group's door; called on the spot it runs whatever it is given
            let spaced = format!(" {source}");
            for lent in calls_of(
                &spaced
                    .replace(" lend(", " .lend(")
                    .replace("(lend(", "(.lend("),
                "lend",
            ) {
                let after = spaced
                    .split(&format!("lend({lent})"))
                    .skip(1)
                    .any(|rest| rest.trim_start().starts_with('('));
                if after {
                    direct.push(format!("{path}: lend({lent})(..)"));
                }
            }
        }
        direct
    }

    #[test]
    fn the_flow_runs_another_groups_tool_only_through_that_groups_command() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let groups: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("runtime/pi/groups.json")).unwrap(),
        )
        .unwrap();
        let others: Vec<&str> = groups["groups"]
            .as_object()
            .map(|g| g.keys().map(String::as_str).collect())
            .unwrap_or_else(|| {
                groups["groups"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g.as_str().unwrap())
                    .collect()
            });
        let others: Vec<&str> = others.into_iter().filter(|g| *g != "agent").collect();
        assert!(
            others.contains(&"knowledge") && others.contains(&"visual"),
            "{others:?}"
        );
        for group in others {
            let (sources, tools) = flow_sources_and_tools(group);
            let names = tool_names(&sources, &tools);
            assert_eq!(
                direct_runs(&sources, &names),
                Vec::<String>::new(),
                "{group}"
            );
        }
        let (sources, tools) = flow_sources_and_tools("visual");
        assert!(tool_names(&sources, &tools)
            .iter()
            .any(|n| n == "VISION_CRITIC_TOOL"));
        let (sources, tools) = flow_sources_and_tools("knowledge");
        assert!(tool_names(&sources, &tools)
            .iter()
            .any(|n| n == "DATA_PREPARE_TOOL"));
        // the check sees a direct run, a lent host called on the spot, and a tool name bound by let first
        for planted in [
            "fn f() { recorder.auto(tools, DATA_PREPARE_TOOL, json!({}), cancel) }",
            "fn f() { let run = lend(tools, cancel)(VISION_CRITIC_TOOL, json!({})); }",
            "fn f() { let run = lend(tools, cancel)(\"anything\", json!({})); }",
            "fn f() {\n    let tool = VISION_CRITIC_TOOL;\n    recorder.auto(tools, tool, json!({}), cancel)\n}",
            "fn f() {\n    let tool: &str = crate::next_visual::VISION_CRITIC_TOOL;\n    recorder.auto(tools, tool, json!({}), cancel)\n}",
        ] {
            let mut planted_sources = sources.clone();
            planted_sources.push(("planted".into(), planted.into()));
            let mut all_tools = tools.clone();
            all_tools.push(next_visual::VISION_CRITIC_TOOL.into());
            let names = tool_names(&planted_sources, &all_tools);
            // the planted line is caught (a let-bound name may also catch the flow's own generic runs of `tool`)
            let found = direct_runs(&planted_sources, &names);
            assert_eq!(found.iter().filter(|f| f.starts_with("planted: ")).count(), 1, "{planted}: {found:?}");
        }
    }

    /// A door keeps a host tool's run when it ends, with the run's own time and the tool's own verdict.
    #[tokio::test]
    async fn a_doors_event_holds_the_runs_own_time_and_ok() {
        let calls = Calls::default();
        let run: ToolFuture<'_> = Box::pin(async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            ToolRun {
                outcome: Ok(CallOutcome::Result {
                    content: Vec::new(),
                    details: None,
                    is_error: true,
                }),
                progress: Vec::new(),
                notes: Vec::new(),
            }
        });
        let run = door_run(
            &calls,
            "visual",
            next_visual::VISION_CRITIC_TOOL,
            &json!({}),
            run,
        );
        assert!(calls.lock().unwrap().is_empty());
        run.await;
        let kept = calls.lock().unwrap().clone();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["group"], "visual");
        assert_eq!(kept[0]["ok"], false);
        assert!(kept[0]["ms"].as_u64().unwrap() >= 30, "{kept:?}");
        // through the knowledge door: no event when the run is handed back, one when it ends
        let host: HostRun<'_> = Box::new(|_, _| {
            Box::pin(async {
                ToolRun {
                    outcome: Ok(CallOutcome::Result {
                        content: Vec::new(),
                        details: None,
                        is_error: false,
                    }),
                    progress: Vec::new(),
                    notes: Vec::new(),
                }
            })
        });
        let _command = crate::group_guard::command_for_test("investigate");
        let calls = Calls::default();
        let run = data_prepare_run(&calls, host, json!({"dataset": "x"}));
        assert!(calls.lock().unwrap().is_empty());
        run.await;
        let kept = calls.lock().unwrap().clone();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            (kept[0]["group"].as_str(), kept[0]["ok"].as_bool()),
            (Some("knowledge"), Some(true))
        );
    }

    /// The fake catalogue with two companion candidates of nrg_bal_peh: a by-month twin and a table with the same dimensions.
    struct WithCompanions(FakeCatalogue);

    impl Catalogue for WithCompanions {
        fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
            self.0.top5(question_zh, texts)
        }
        fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
            self.0.places_outside(question_zh, texts)
        }
        fn source(&self) -> &Value {
            self.0.source()
        }
        fn table(&self, id: &str) -> Option<TableMeta> {
            let codes = |c: &[&str]| c.iter().map(|c| (c.to_string(), String::new())).collect();
            let dims: Vec<(String, Vec<(String, String)>)> = match id {
                "nrg_bal_peh" | "comp_x" => vec![
                    ("geo".into(), codes(&["DE", "FR"])),
                    ("nrg_bal".into(), codes(&["GEP"])),
                ],
                "comp_m" => vec![
                    ("geo".into(), codes(&["DE", "FR", "IT"])),
                    ("partner".into(), codes(&["RU"])),
                ],
                _ => return None,
            };
            Some(TableMeta {
                id: id.into(),
                worldbank: false,
                dims,
                end_year: Some(2024),
                places: Vec::new(),
                place_members: Vec::new(),
                freqs: Vec::new(),
                unit: None,
            })
        }
        fn companion_shortlist(
            &self,
            main: &str,
        ) -> Vec<(next_knowledge::CompanionCandidate, String)> {
            assert_eq!(main, "nrg_bal_peh");
            vec![
                (
                    next_knowledge::CompanionCandidate {
                        id: "comp_m".into(),
                        adds: vec!["partner".into()],
                        grain: Some("M"),
                    },
                    "Monthly imports".into(),
                ),
                (
                    next_knowledge::CompanionCandidate {
                        id: "comp_x".into(),
                        adds: Vec::new(),
                        grain: None,
                    },
                    "Another unit".into(),
                ),
            ]
        }
        fn companion_rows(
            &self,
            _table: &TableMeta,
            csv: &str,
        ) -> Result<Vec<next_knowledge::CompanionRow>, String> {
            Ok(csv
                .lines()
                .map(|geo| next_knowledge::CompanionRow {
                    geo: geo.into(),
                    year: 2024,
                    unit: None,
                    country: true,
                })
                .collect())
        }
        fn companions(
            &self,
            main: &str,
            rows: &BTreeMap<String, Vec<next_knowledge::CompanionRow>>,
        ) -> Vec<next_knowledge::Companion> {
            assert!(rows.contains_key(main));
            rows.keys()
                .filter(|id| *id != main)
                .map(|id| next_knowledge::Companion {
                    id: id.clone(),
                    adds: vec!["partner".into()],
                    grain: Some("M"),
                    overlap: crate::next_companion::Overlap {
                        countries: rows[id].len(),
                        aggregates: 0,
                        year: 2024,
                    },
                    axis: crate::next_companion::Axis::Same,
                })
                .collect()
        }
    }

    #[tokio::test]
    async fn a_companion_is_fetched_under_the_main_filters_and_one_that_cannot_be_is_dropped_with_its_reason(
    ) {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let dir = run.path();
        write_sheet(dir, SHEET_A, &["c1", "c2", "c3"]);
        write_sheet(dir, SHEET_B, &["m1", "m2", "m3"]);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data/main.csv"), "DE\nFR").unwrap();
        std::fs::write(dir.join("data/m.csv"), "DE\nFR").unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            call("toolu_t", json!({"step": "table", "pick": [2]})),
            call(
                "toolu_c",
                json!({"step": "claims", "pick": [1, 2, 3, 4, 5, 6]}),
            ),
        ]);
        let mut tools = ScriptedTools {
            details: vec![
                json!({"mode": "candidates", "sheet": SHEET_A, "filePath": "data/main.csv"}),
                json!({"mode": "candidates", "sheet": SHEET_B, "filePath": "data/m.csv"}),
                json!({"mode": "too_large", "estimate": 90000}),
                json!({"mode": "failed", "text": "Data preparation failed: HTTP 413"}),
                json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]}),
                json!({"mode": "picks", "claims": [{"candidate": "m1", "claim_id": "k4"}, {"candidate": "m2", "claim_id": "k5"}, {"candidate": "m3", "claim_id": "k6"}]}),
            ]
            .into(),
            args: Vec::new(),
        };
        let steps = parse_prepare_spec(&q3_like().to_string()).unwrap();
        let catalogue = WithCompanions(FakeCatalogue {
            candidates: offers(),
            uncovered: None,
            source: json!({}),
            searched: Default::default(),
        });
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, dir, Vec::new(), Vec::new());
        let prepared = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "德国和法国的发电量",
            &steps,
            &catalogue,
            &cancel,
        )
        .await
        .unwrap();
        let prompts: Vec<String> = recorder
            .history()
            .iter()
            .filter(|m| m["role"] == "user")
            .map(|m| m["content"][0]["text"].as_str().unwrap().to_string())
            .collect();
        drop(recorder);
        // the twin is fetched under the main's places and years (the filter on a dimension it lacks left out); the other
        // one too, and once more as the main's narrowed request when the tool finds it too large
        let years = json!({"start": 2024, "end": 2024});
        assert_eq!(
            tools.args[1],
            json!({"dataset": "comp_m", "filters": [{"dimension": "geo", "values": ["DE", "FR"]}], "years": years})
        );
        assert_eq!(
            tools.args[2],
            json!({"dataset": "comp_x", "filters": [{"dimension": "nrg_bal", "values": ["GEP"]}, {"dimension": "geo", "values": ["DE", "FR"]}], "years": years})
        );
        assert_eq!(
            tools.args[3],
            json!({"dataset": "comp_x", "filters": [{"dimension": "geo", "values": ["DE"]}], "years": years})
        );
        assert_eq!(tools.args.len(), 6);
        assert_eq!(prepared.len(), 2);
        assert_eq!(prepared[1].id, "comp_m");
        assert_eq!(prepared[1].title, "Monthly imports");
        assert_eq!(prepared[1].claims.len(), 3);
        assert!(
            prompts[2].contains("Table 2 (comp_m, companion by month):\n4. claim m1"),
            "{}",
            prompts[2]
        );
        let stage = of_type(&events, COMPANION_EVENT);
        assert_eq!(stage.len(), 1);
        assert_eq!(stage[0]["main"], "nrg_bal_peh");
        assert_eq!(
            stage[0]["cut"],
            Value::Null,
            "a main not narrowed has no cut"
        );
        assert_eq!(stage[0]["tables"][0]["outcome"], "fetched");
        assert!(stage[0]["tables"][1]["outcome"]
            .as_str()
            .unwrap()
            .starts_with("mode failed: "));
        assert!(stage[0]["tables"][1]["seconds"].as_f64().is_some());
        assert_eq!(
            stage[0]["kept"],
            json!([{"table": "comp_m", "role": "by month", "overlap": {"countries": 2, "aggregates": 0, "year": 2024}, "axis": "Same"}])
        );
        // every companion fetch is a program call under the table answer, like the main's
        let parents: Vec<String> = of_type(&events, "tool_execution_start")
            .iter()
            .filter(|e| e["auto"] == true)
            .map(|e| e["auto_parent_call_id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            parents,
            ["toolu_t", "toolu_t", "toolu_t", "toolu_t", "toolu_c", "toolu_c"]
        );
    }

    #[test]
    fn a_companion_is_fixed_to_the_main_codes_in_its_own_list_or_not_fetched() {
        let main: Map<String, Value> = serde_json::from_value(json!({"dataset": "a",
            "filters": [{"dimension": "geo", "values": ["DE", "EA20"]}, {"dimension": "sex", "values": ["F"]}],
            "years": {"start": 2024, "end": 2024}, "sum_year": {"n": 12}}))
        .unwrap();
        let table = |dims: &[(&str, &[&str])]| TableMeta {
            id: "b".into(),
            worldbank: false,
            dims: dims
                .iter()
                .map(|(d, c)| {
                    (
                        d.to_string(),
                        c.iter().map(|c| (c.to_string(), String::new())).collect(),
                    )
                })
                .collect(),
            end_year: None,
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        // a dimension the companion lacks is left out; EA20 is its one version of the euro area; what is the main's own
        // (its summing) is not carried over
        assert_eq!(
            Value::Object(
                companion_args(&main, None, &table(&[("geo", &["DE", "FR", "EA21"])])).unwrap()
            ),
            json!({"dataset": "b", "filters": [{"dimension": "geo", "values": ["DE", "EA21"]}], "years": {"start": 2024, "end": 2024}})
        );
        // no shared place, or a shared dimension with none of the main's codes: not fetched rather than fetched open
        assert_eq!(
            companion_args(&main, None, &table(&[("geo", &["FR"])])),
            None
        );
        assert_eq!(
            companion_args(&main, None, &table(&[("geo", &["DE"]), ("sex", &["T"])])),
            None
        );
        // two versions of the aggregate: neither is guessed; only a place is mapped
        assert_eq!(
            own_code(
                "geo",
                "EA20",
                &table(&[("geo", &["EA19", "EA21"])]).dims[0].1
            ),
            None
        );
        assert_eq!(
            own_code("sex", "F2", &table(&[("sex", &["F1"])]).dims[0].1),
            None
        );
    }

    #[test]
    fn a_companion_is_fetched_in_the_codes_the_main_was_cut_to() {
        let meta = |worldbank: bool, dims: &[(&str, &[&str])], places: &[(&str, &str)]| TableMeta {
            id: "b".into(),
            worldbank,
            dims: dims
                .iter()
                .map(|(d, c)| {
                    (
                        d.to_string(),
                        c.iter().map(|c| (c.to_string(), String::new())).collect(),
                    )
                })
                .collect(),
            end_year: None,
            places: places
                .iter()
                .map(|(i, id)| (i.to_string(), id.to_string()))
                .collect(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        // Eurostat (q6): citizen cut to its top codes, the total held; sex fixed by a filter
        let main: Map<String, Value> = serde_json::from_value(json!({"dataset": "migr_asyappctza",
            "filters": [{"dimension": "sex", "values": ["T"]}],
            "narrow": {"dimension": "citizen", "rule": "top", "n": 20, "exclude": [], "total": "TOTAL"},
            "years": {"start": 2024, "end": 2024}}))
        .unwrap();
        let details = json!({"narrow": {"dimension": "citizen", "members": ["SY", "AF", "VE"], "total": "TOTAL", "total_held": true}});
        let cut = main_cut(&main, Some(&details)).unwrap();
        assert_eq!(cut.codes, ["SY", "AF", "VE", "TOTAL"]);
        let mut unheld = details.clone();
        unheld["narrow"]["total_held"] = json!(false);
        assert_eq!(
            main_cut(&main, Some(&unheld)).unwrap().codes,
            ["SY", "AF", "VE"],
            "a total the fetch did not hold is not asked"
        );
        let companion = meta(
            false,
            &[
                ("sex", &["T", "F"]),
                ("citizen", &["TOTAL", "SY", "VE", "IQ"]),
                ("withdraw", &["TOTAL", "EXPLC"]),
            ],
            &[],
        );
        assert_eq!(
            Value::Object(companion_args(&main, Some(&cut), &companion).unwrap()),
            json!({"dataset": "b", "filters": [{"dimension": "sex", "values": ["T"]}, {"dimension": "citizen", "values": ["SY", "VE", "TOTAL"]}],
                "years": {"start": 2024, "end": 2024}}),
            "only the cut codes it lists; its own added dimension stays open"
        );
        assert_eq!(
            companion_args(
                &main,
                Some(&cut),
                &meta(false, &[("citizen", &["IQ"])], &[])
            ),
            None,
            "none of the cut codes: not fetched rather than fetched open"
        );
        let without = meta(false, &[("sex", &["T"]), ("geo", &["DE"])], &[]);
        assert_eq!(
            companion_args(&main, Some(&cut), &without),
            companion_args(&main, None, &without),
            "a companion without the cut dimension is fetched as before"
        );
        // World Bank (q5): every country open, cut to the top economies by their ids; the record names no dimension
        let main: Map<String, Value> = serde_json::from_value(
            json!({"provider": "worldbank", "dataset": "SP.POP.65UP.TO.ZS",
            "narrow": {"dimension": "country", "rule": "top", "n": 8, "exclude": []},
            "years": {"start": 2016, "end": 2025}}),
        )
        .unwrap();
        let details = json!({"narrow": {"record": "data/origins/x.json", "option": "top", "at": "2025", "members": ["MCO", "JPN", "DEU"]}});
        let cut = main_cut(&main, Some(&details)).unwrap();
        assert_eq!(
            cut,
            Cut {
                dimension: "country".into(),
                codes: vec!["MCO".into(), "JPN".into(), "DEU".into()]
            }
        );
        let sibling = meta(true, &[], &[("JP", "JPN"), ("DE", "DEU"), ("FR", "FRA")]);
        assert_eq!(
            Value::Object(companion_args(&main, Some(&cut), &sibling).unwrap()),
            json!({"provider": "worldbank", "dataset": "b", "filters": [{"dimension": "country", "values": ["JPN", "DEU"]}],
                "years": {"start": 2016, "end": 2025}})
        );
        assert_eq!(
            companion_args(&main, Some(&cut), &meta(true, &[], &[("FR", "FRA")])),
            None
        );
        // no narrow: no cut, the companion as before
        let mut plain = main.clone();
        plain.remove("narrow");
        assert_eq!(main_cut(&plain, Some(&details)), None);
        assert_eq!(main_cut(&main, None), None);
        assert_eq!(
            main_cut(&main, Some(&json!({"narrow": {"members": []}}))),
            None
        );
    }

    /// prepare_claims on the companion catalogue (comp_m, then comp_x) with these tool results after the main's candidates,
    /// the model picking these claims: the result, the events and the arguments of every tool call.
    async fn with_companion_results(
        results: Vec<Value>,
        picks: Value,
    ) -> (Result<Vec<Prepared>, Stop>, Events, Vec<Value>) {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let dir = run.path();
        write_sheet(dir, SHEET_A, &["c1", "c2", "c3"]);
        write_sheet(dir, SHEET_B, &["m1", "m2", "m3"]);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data/main.csv"), "DE\nFR").unwrap();
        std::fs::write(dir.join("data/m.csv"), "DE\nFR").unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            call("toolu_t", json!({"step": "table", "pick": [2]})),
            call("toolu_c", json!({"step": "claims", "pick": picks})),
        ]);
        let mut details =
            vec![json!({"mode": "candidates", "sheet": SHEET_A, "filePath": "data/main.csv"})];
        details.extend(results);
        let mut tools = ScriptedTools {
            details: details.into(),
            args: Vec::new(),
        };
        let steps = parse_prepare_spec(&q3_like().to_string()).unwrap();
        let catalogue = WithCompanions(offers_catalogue());
        let mut recorder = Recorder::new(&mut sink, dir, Vec::new(), Vec::new());
        let prepared = prepare_claims(
            &mut recorder,
            &mut model,
            &mut tools,
            "德国和法国的发电量",
            &steps,
            &catalogue,
            &AtomicBool::new(false),
        )
        .await;
        drop(recorder);
        (prepared, events, tools.args)
    }

    #[tokio::test]
    async fn the_tools_stop_reached_on_companion_fetches_drops_them_and_the_main_still_registers() {
        // as the tool counts: comp_m too large (1), its narrowed request failed (2, runStop), comp_x failed (3, runStop)
        let stop = json!({"reason": "data_failed", "step": "data_prepare"});
        let text = "Data preparation failed: HTTP 413\nSTOPPED data_failed at data_prepare: 2 data steps in a row failed (the last: failed); the run ends here.";
        let main_picks = json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]});
        let companion_failures = vec![
            json!({"mode": "too_large", "estimate": 90000}),
            json!({"mode": "failed", "text": text, "runStop": stop}),
            json!({"mode": "failed", "text": text, "runStop": stop}),
        ];
        let mut results = companion_failures.clone();
        results.push(main_picks);
        let (prepared, events, args) = with_companion_results(results, json!([1, 2, 3])).await;
        let prepared = prepared.unwrap();
        assert_eq!(args.len(), 5);
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].claims.len(), 3);
        let stage = of_type(&events, COMPANION_EVENT);
        let says = "mode failed: the tool's stop data_failed was reached on companion fetches; the companion stage does not apply it to the page";
        for table in stage[0]["tables"].as_array().unwrap() {
            assert_eq!(table["outcome"], says);
        }
        assert_eq!(stage[0]["kept"], json!([]));
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] != "tool_execution_end")
            .any(|e| e.to_string().contains("run ends here")));
        // the main's own failed registration still stops the run, named by what failed
        let mut results = companion_failures;
        results.push(json!({"mode": "no_rows", "runStop": stop}));
        let (prepared, _, _) = with_companion_results(results, json!([1, 2, 3])).await;
        assert_eq!(
            prepared.unwrap_err(),
            Stop::NotRegistered {
                dataset: "nrg_bal_peh".into(),
                why: "mode no_rows, 0 of 3 claims registered; the tool's stop: data_failed".into()
            }
        );
    }

    #[tokio::test]
    async fn a_companion_whose_picks_do_not_register_is_left_off_and_the_page_goes_on() {
        let (prepared, events, args) = with_companion_results(vec![
            json!({"mode": "candidates", "sheet": SHEET_B, "filePath": "data/m.csv"}),
            json!({"mode": "failed", "text": "Data preparation failed: HTTP 500"}),
            json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]}),
            json!({"mode": "no_rows"}),
        ], json!([1, 2, 3, 4, 5, 6]))
        .await;
        let prepared = prepared.unwrap();
        assert_eq!(args.len(), 5);
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].id, "nrg_bal_peh");
        assert_eq!(
            of_type(&events, COMPANION_PICKS_EVENT),
            [
                json!({"type": COMPANION_PICKS_EVENT, "auto_parent_call_id": "toolu_c", "table": "comp_m", "why": "mode no_rows, 0 of 3 claims registered"})
            ]
        );
    }

    /// A host whose fetch answers only once it is asked to stop.
    struct UntilStopped;

    #[async_trait]
    impl ToolRunner for UntilStopped {
        async fn run(
            &mut self,
            _name: &str,
            _args: &Value,
            cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> anyhow::Result<CallOutcome> {
            while !cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Ok(CallOutcome::Result {
                content: text_content("cancelled"),
                details: Some(json!({"mode": "cancelled"})),
                is_error: false,
            })
        }
        fn exposes(&self, _name: &str) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn a_companion_fetch_past_its_limit_is_asked_to_stop_and_ends_the_normal_way() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        recorder.parent = Some("toolu_t".into());
        let cancel = AtomicBool::new(false);
        let catalogue = offers_catalogue();
        let (called, stopped) = timed_prepare(
            &mut recorder,
            &mut UntilStopped,
            &catalogue,
            json!({"dataset": "comp_m"}),
            &cancel,
            Duration::from_millis(50),
        )
        .await
        .unwrap();
        drop(recorder);
        assert!(stopped && mode_of(&called) == "cancelled");
        // the run's own stop flag is never raised, and the call has its end event
        assert!(!cancel.load(Ordering::SeqCst));
        assert_eq!(of_type(&events, "tool_execution_end").len(), 1);
    }

    #[tokio::test]
    async fn a_page_takes_no_more_companions_than_it_has_room_for() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let dir = run.path();
        write_sheet(dir, SHEET_B, &["m1", "m2", "m3"]);
        write_sheet(dir, SHEET_A, &["x1", "x2", "x3"]);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        for file in ["main", "m", "x"] {
            std::fs::write(dir.join(format!("data/{file}.csv")), "DE").unwrap();
        }
        let (events, mut sink) = collector();
        let mut recorder = Recorder::new(&mut sink, dir, Vec::new(), Vec::new());
        recorder.parent = Some("toolu_t".into());
        let mut tools = ScriptedTools {
            details: vec![
                json!({"mode": "candidates", "sheet": SHEET_B, "filePath": "data/m.csv"}),
                json!({"mode": "candidates", "sheet": SHEET_A, "filePath": "data/x.csv"}),
            ]
            .into(),
            args: Vec::new(),
        };
        let main: Map<String, Value> = serde_json::from_value(
            json!({"dataset": "nrg_bal_peh", "years": {"start": 2024, "end": 2024}}),
        )
        .unwrap();
        let kept = companion_tables(
            &mut recorder,
            &mut tools,
            &WithCompanions(offers_catalogue()),
            "nrg_bal_peh",
            &main,
            None,
            None,
            "data/main.csv",
            1,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        drop(recorder);
        assert_eq!(tools.args.len(), 2);
        assert_eq!(kept.len(), 1);
        assert_eq!(
            of_type(&events, COMPANION_EVENT)[0]["kept"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    fn offers_catalogue() -> FakeCatalogue {
        FakeCatalogue {
            candidates: offers(),
            uncovered: None,
            source: json!({}),
            searched: Default::default(),
        }
    }

    /// An echo page (fixtures/next_leaf: one svg layer, one html layer) published into a fresh run folder, the doors as
    /// `open` says, the browser check the twin (fixtures/next_visual/qa_twin.py) in `qa` mode: the reply and the run.
    fn publish_with(open: bool, qa: &str) -> (Result<Published, String>, crate::artifact::InvestigationBundle, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let bundle = {
            let _command = crate::group_guard::command_for_test("investigate");
            crate::artifact::InvestigationBundle::create(dir.path(), "leaf page").unwrap()
        };
        (publish_into(&bundle.dir, open, qa), bundle, dir)
    }

    /// The same echo page published as "leaf" into the run folder at `root`.
    fn publish_into(root: &Path, open: bool, qa: &str) -> Result<Published, String> {
        use crate::next_leaf::{Layer, Runner};
        let _command = crate::group_guard::command_for_test("investigate");
        let _doors = crate::group_guard::doors_for_test(open);
        let draw = Runner::python(Path::new("fixtures/next_leaf/echo.py"));
        let bake = Runner::python(Path::new("fixtures/next_leaf/bake_twin.py"));
        let mut check = Runner::python(Path::new("fixtures/next_visual/qa_twin.py"));
        check.args.push(qa.into());
        let layers = [
            Layer::twin("echo", "events", json!({})),
            Layer::twin("echo", "legend", json!({"html": "<div>图例</div>"})),
        ];
        let spec = crate::next_facts::Spec {
            facts: Vec::new(),
            fmts: json!({}),
            members: None,
        };
        let ledger = BTreeMap::new();
        let page = next_visual::LeafPage {
            draw: &draw,
            bake: &bake,
            w: 900.0,
            h: 460.0,
            frame: json!({}),
            layers: &layers,
            ledger: &ledger,
            refs: &[],
            facts: (&spec, &[], &[]),
        };
        publish_leaf_page(&Mutex::new(Vec::new()), root, "leaf", &page, &check)
    }

    /// The visual door is not measured today, so the page write is refused: no page, no report, no manifest, nothing counted.
    /// Once measured, the baked bytes are written once, the PASS report names their sha256 and the manifest binds them.
    #[test]
    fn a_leaf_page_is_published_only_through_an_open_door_and_a_passing_browser_check_of_its_bytes() {
        let (reply, bundle, _dir) = publish_with(false, "pass");
        let why = reply.unwrap_err();
        assert!(why.starts_with("publish: boundary:") && why.contains("visual_command"), "{why}");
        assert!(!bundle.dir.join("publications/leaf").exists() && !bundle.dir.join("publications/qa").exists());
        assert!(bundle.measured_publication_gap().unwrap().is_some());

        let (reply, bundle, _dir) = publish_with(true, "pass");
        let published = reply.unwrap();
        let html = std::fs::read(bundle.dir.join(&published.html_ref)).unwrap();
        assert_eq!(crate::hash::sha256_bytes(&html), published.html_sha256);
        let html = String::from_utf8(html).unwrap();
        assert!(html.contains("<div>图例</div>") && html.contains(&format!("<script>{}</script>", crate::next_ledger::READY_JS)));
        let manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(bundle.dir.join("publications/leaf/manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["html_ref"], "publications/leaf/index.html");
        assert_eq!(manifest["html_sha256"].as_str(), Some(published.html_sha256.as_str()));
        assert_eq!(bundle.measured_publication_gap().unwrap(), None);

        std::fs::write(bundle.dir.join(&published.html_ref), html.replacen("图例", "图列", 1)).unwrap();
        assert!(bundle.measured_publication_gap().unwrap().is_some(), "a byte changed after the PASS is not published");
    }

    /// A FAIL, a PASS for other bytes or no report at all leaves the page and whatever report there is for replay, with no
    /// manifest and nothing counted.
    #[test]
    fn a_leaf_page_the_browser_check_does_not_pass_for_its_bytes_is_kept_unpublished() {
        for (qa, says) in [
            ("fail", "browser check: FAIL: overflow:1440"),
            ("other", "not the page written"),
            ("silent", "browser check: it wrote no readable browser-qa.json"),
        ] {
            let (reply, bundle, _dir) = publish_with(true, qa);
            let why = reply.unwrap_err();
            assert!(why.contains(says), "{qa}: {why}");
            assert!(bundle.dir.join("publications/leaf/index.html").is_file(), "{qa}");
            assert_eq!(bundle.dir.join("publications/qa/leaf/browser-qa.json").is_file(), qa != "silent", "{qa}");
            assert!(!bundle.dir.join("publications/leaf/manifest.json").exists(), "{qa}");
            assert!(bundle.measured_publication_gap().unwrap().is_some(), "{qa}");
        }
    }

    /// A slug is published once: publishing to it again is refused before anything is drawn, so a check that leaves no report
    /// is never read as the earlier one, and a page that failed is not passed later under the same name.
    #[test]
    fn a_leaf_page_is_not_published_twice_under_one_name() {
        let (reply, bundle, _dir) = publish_with(true, "pass");
        let first = reply.unwrap();
        let files = ["publications/leaf/index.html", "publications/leaf/manifest.json", "publications/qa/leaf/browser-qa.json"];
        let read = |root: &Path| -> Vec<Vec<u8>> { files.iter().map(|f| std::fs::read(root.join(f)).unwrap()).collect() };
        let before = read(&bundle.dir);
        let why = publish_into(&bundle.dir, true, "silent").unwrap_err();
        assert!(why.contains("publications/leaf was written before"), "{why}");
        assert_eq!(read(&bundle.dir), before, "the refused publish changed nothing");
        assert_eq!(crate::hash::sha256_bytes(&before[0]), first.html_sha256);

        let (reply, bundle, _dir) = publish_with(true, "fail");
        assert!(reply.is_err());
        let why = publish_into(&bundle.dir, true, "pass").unwrap_err();
        assert!(why.contains("publications/leaf was written before"), "{why}");
        assert!(!bundle.dir.join("publications/leaf/manifest.json").exists());
        assert!(bundle.measured_publication_gap().unwrap().is_some());
    }

    /// Every file under `root` (run-folder relative, `/` separated) with its bytes.
    fn files_of(root: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut dirs = vec![root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                } else {
                    let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    files.insert(rel, std::fs::read(&path).unwrap());
                }
            }
        }
        files
    }

    /// The visual door's whole footprint (the condition for measuring its handoffs.rust row, 10-29): a publish, passing or not,
    /// adds or changes files only under publications/<slug>/ and publications/qa/<slug>/ of the run folder; through a closed
    /// door the only change is the guard's own refusal record, naming the door.
    #[test]
    fn the_visual_door_writes_only_the_page_folder_and_its_report_folder() {
        for (open, qa) in [(false, "pass"), (true, "pass"), (true, "fail"), (true, "other"), (true, "silent")] {
            let dir = tempfile::tempdir().unwrap();
            let bundle = {
                let _command = crate::group_guard::command_for_test("investigate");
                crate::artifact::InvestigationBundle::create(dir.path(), "leaf page").unwrap()
            };
            let before = files_of(&bundle.dir);
            let reply = publish_into(&bundle.dir, open, qa);
            assert_eq!(reply.is_ok(), open && qa == "pass", "{open} {qa}: {reply:?}");
            let after = files_of(&bundle.dir);
            let touched: Vec<&String> = after.iter().filter(|(k, v)| before.get(*k) != Some(*v)).map(|(k, _)| k).collect();
            let gone: Vec<&String> = before.keys().filter(|k| !after.contains_key(*k)).collect();
            assert!(gone.is_empty(), "{open} {qa}: removed {gone:?}");
            if !open {
                assert_eq!(touched, [crate::group_guard::REFUSAL_LOG_PATH], "{qa}: a closed door changed {touched:?}");
                let refusals = String::from_utf8_lossy(&after[crate::group_guard::REFUSAL_LOG_PATH]).into_owned();
                assert!(refusals.contains("visual_command"), "{refusals}");
                continue;
            }
            let outside: Vec<&&String> =
                touched.iter().filter(|k| !k.starts_with("publications/leaf/") && !k.starts_with("publications/qa/leaf/")).collect();
            assert!(outside.is_empty(), "{open} {qa}: written outside the two folders {outside:?}");
            assert!(!touched.is_empty(), "{qa}: an open door wrote nothing");
        }
    }
}
