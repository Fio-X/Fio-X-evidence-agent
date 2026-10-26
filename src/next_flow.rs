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
use crate::shape_registry::{Matched, Relation, Shape};
use crate::tool_host::CallOutcome;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

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

#[derive(Debug, PartialEq)]
pub enum Route {
    /// The model loop, exactly as before.
    ModelLoop,
    /// The fixed flow; the spec is the transitional prepare spec when one was given.
    NextFlow { prepare_spec: Option<PathBuf> },
}

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

/// The keys of one prepare step that go to newsroom_data_prepare.
pub const TOOL_KEYS: [&str; 4] = ["provider", "dataset", "filters", "years"];
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
    NotPrepared { dataset: String, mode: String, why: String },
    /// The picked claims were not all registered as verified claims; the text says what came back.
    NotRegistered { dataset: String, why: String },
    /// A page step after the claims (next_run) cannot go on; the text says what is missing.
    Page { step: &'static str, why: String },
}

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stop::TablePickNotWired(why) => write!(f, "table pick not wired: {why}"),
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
            Stop::NotRegistered { dataset, why } => {
                write!(f, "the picked claims of {dataset} were not registered: {why}")
            }
            Stop::Page { step, why } => write!(f, "the page step {step} stopped: {why}"),
        }
    }
}

/// The steps of the run, or why it stops. No spec stops as "table pick not wired"; nothing else is tried.
pub fn prepare_steps(spec_text: Option<&str>) -> Result<Vec<PrepareStep>, Stop> {
    match spec_text {
        None => Err(Stop::TablePickNotWired(format!(
            "no {PREPARE_SPEC_ARG} was given and the catalogue pick is not wired yet"
        ))),
        Some(text) => parse_prepare_spec(text),
    }
}

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
    /// one option number for every item of each picked table and no other.
    Table {
        count: usize,
        most: usize,
        items: Vec<Vec<(String, usize)>>,
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
    Text {
        fields: BTreeMap<String, String>,
        slots: Vec<String>,
        numbers: Vec<String>,
    },
    /// The image-aware critic's verdict on the previewed page: a 0-100 score, every rubric item 0-100, a 0-1 confidence and up to
    /// VISION_ISSUES_MAX issues, each on one of `modules` (the page's module ids) or the whole page. The record can only veto the page.
    Vision {
        modules: Vec<String>,
    },
}

/// The rubric of the image-aware critic (vision.mjs VISION_RUBRIC_KEYS).
pub const VISION_RUBRIC: [&str; 10] = [
    "hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality",
    "illustration_integration", "color_contrast", "editorial_distinctiveness",
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
                    "description": format!("English words only (letters, spaces, hyphens; no digits), at most {SEARCH_MAX_CHARS} characters; used only to search the catalogue")}}})
            }
            Ask::Table { count, most, items } => {
                let mut schema = json!({"type": "object", "additionalProperties": false, "required": ["step", "pick"],
                "properties": {"step": step, "pick": {"type": "array", "minItems": 1, "maxItems": most, "uniqueItems": true,
                    "items": {"type": "integer", "enum": (0..=*count).collect::<Vec<_>>()},
                    "description": format!("the numbers of the tables, at most {most}; [0] if none of them fits")}}});
                if !items.is_empty() {
                    schema["required"] = json!(["step", "pick", "params"]);
                    schema["properties"]["params"] = json!({"type": "object", "additionalProperties": false,
                        "properties": items.iter().flatten().map(|(k, count)| (k.clone(), json!({"type": "integer", "enum": (1..=*count).collect::<Vec<_>>()}))).collect::<Map<_, _>>(),
                        "description": "item -> the number of the option that fits the question, for every item of each picked table and no other"});
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
            Ask::Text { fields, slots, numbers } => {
                json!({"type": "object", "additionalProperties": false, "required": ["step", "text", "names"],
                "properties": {"step": step,
                    "text": {"type": "object", "additionalProperties": false,
                        "properties": fields.keys().map(|k| (k.clone(), json!({"type": "string"}))).collect::<Map<_, _>>(),
                        "description": format!("field number -> revised wording; leave a field out to keep the draft; keep every {{placeholder}}; type no number other than these: [{}]; no number in words either (二十七, 两国, 三倍, 两成, 过半)", numbers.join(", "))},
                    "names": {"type": "object", "additionalProperties": false, "required": slots,
                        "properties": slots.iter().map(|k| (k.clone(), json!({"type": "string"}))).collect::<Map<_, _>>(),
                        "description": format!("untranslated slot number -> Chinese name, at most {NAME_MAX_CHARS} characters, no number")}}})
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
            Ask::Table { count, most, items } => {
                let mut allowed = table_answer(&(0..=*count).collect::<Vec<_>>(), items, |count| json!((1..=count).collect::<Vec<_>>()));
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
            Ask::Text { fields, slots, numbers } => json!({"step": "text",
                "text": fields.iter().map(|(k, draft)| (k.clone(), json!(draft))).collect::<Map<_, _>>(), "names": slots,
                "name_max_chars": NAME_MAX_CHARS, "numbers": numbers}),
            Ask::Vision { modules } => json!({"step": "vision", "score": [0, 100], "confidence": [0, 1], "rubric": VISION_RUBRIC,
                "rubric_item": [0, 100], "issues_max": VISION_ISSUES_MAX, "severity": VISION_SEVERITIES, "module_id": modules,
                "text_max_chars": VISION_TEXT_MAX}),
        }
    }

    fn refuse(&self, problem: impl Into<String>) -> Refused {
        Refused {
            problem: problem.into(),
            allowed: self.allowed(),
            example: self.example(),
        }
    }

    /// Checks one answer against this request; every rule of the schema is checked here again.
    pub fn check(&self, args: &Value) -> Result<Choice, Refused> {
        let Value::Object(map) = args else {
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
                        "query must be English words: letters, spaces and hyphens, no digits{}",
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
            Ask::Table { count, most, items } => {
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
                    return Ok(Choice::Table { picks, params: BTreeMap::new() });
                }
                // A refused params is answered with the items of the picked tables only.
                let refuse = |problem: String| Refused {
                    problem,
                    allowed: table_answer(&picks, items, |count| json!((1..=count).collect::<Vec<_>>())),
                    example: table_answer(&picks, items, |_| json!(1)),
                };
                let wanted = picked_items(&picks, items);
                let Value::Object(given) = &map["params"] else {
                    return Err(refuse("params must map every item of each picked table to an option number".into()));
                };
                if let Some(key) = given.keys().find(|k| !wanted.iter().any(|(i, _)| i == *k)) {
                    return Err(refuse(format!("params has no item '{key}' among the items of the picked tables")));
                }
                let mut params = BTreeMap::new();
                for (key, count) in wanted {
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
            Ask::Text { fields, slots, numbers } => {
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
                            "field '{id}': '{typed}' is a typed number not in the allowed numbers [{}]; keep the drafted {{placeholders}}",
                            numbers.join(", ")
                        )));
                    }
                    if let Some(word) = worded_number(revised) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{word}' is a number in words (a count, a multiple, a share, a half) that no data gave; keep the drafted {{placeholders}} and leave it out"
                        )));
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
                        return Err(self.refuse(format!("names: slot '{id}' has '{word}', a number in words; a name holds no number")));
                    }
                    if name.trim().chars().count() > NAME_MAX_CHARS {
                        return Err(self.refuse(format!("names: slot '{id}' is longer than {NAME_MAX_CHARS} characters")));
                    }
                    if !name.chars().any(is_han) {
                        return Err(self.refuse(format!("names: slot '{id}' must be a Chinese name")));
                    }
                }
                Ok(Choice::Text { text, names })
            }
            Ask::Vision { modules } => {
                let mark = |v: &Value| v.as_u64().filter(|n| *n <= 100);
                let score = mark(&map["score"]).ok_or_else(|| self.refuse("score must be a whole number 0 to 100"))?;
                let confidence = map["confidence"]
                    .as_f64()
                    .filter(|c| (0.0..=1.0).contains(c))
                    .ok_or_else(|| self.refuse("confidence must be a number 0 to 1"))?;
                let Value::Object(given) = &map["rubric"] else {
                    return Err(self.refuse("rubric must map every rubric item to a whole number 0 to 100"));
                };
                if let Some(key) = given.keys().find(|k| !VISION_RUBRIC.contains(&k.as_str())) {
                    return Err(self.refuse(format!("rubric has no item '{key}'")));
                }
                let mut rubric = BTreeMap::new();
                for key in VISION_RUBRIC {
                    let value = given.get(key).and_then(mark).ok_or_else(|| self.refuse(format!("rubric needs '{key}' as a whole number 0 to 100")))?;
                    rubric.insert(key.to_string(), value);
                }
                let issues = map["issues"].as_array().filter(|l| l.len() <= VISION_ISSUES_MAX).ok_or_else(|| {
                    self.refuse(format!("issues must be a list of at most {VISION_ISSUES_MAX}"))
                })?;
                for (n, issue) in issues.iter().enumerate() {
                    let Value::Object(fields) = issue else { return Err(self.refuse(format!("issue {} is not an object", n + 1))) };
                    if let Some(key) = fields.keys().find(|k| !["severity", "code", "module_id", "evidence", "recommendation"].contains(&k.as_str())) {
                        return Err(self.refuse(format!("issue {}: unknown key '{key}'", n + 1)));
                    }
                    if !fields.get("severity").and_then(Value::as_str).is_some_and(|s| VISION_SEVERITIES.contains(&s)) {
                        return Err(self.refuse(format!("issue {}: severity must be one of blocker, warning, nit", n + 1)));
                    }
                    let code = fields.get("code").and_then(Value::as_str).unwrap_or("");
                    if code.is_empty() || code.len() > 40 || !code.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                        return Err(self.refuse(format!("issue {}: code must be 1 to 40 lowercase letters or underscores", n + 1)));
                    }
                    if fields.get("module_id").is_some_and(|m| !m.as_str().is_some_and(|m| modules.iter().any(|id| id == m))) {
                        return Err(self.refuse(format!("issue {}: module_id must be one of the page's modules or left out", n + 1)));
                    }
                    for key in ["evidence", "recommendation"] {
                        let text = fields.get(key).and_then(Value::as_str).unwrap_or("");
                        if text.trim().is_empty() || text.chars().count() > VISION_TEXT_MAX {
                            return Err(self.refuse(format!("issue {}: {key} must be text of 1 to {VISION_TEXT_MAX} characters", n + 1)));
                        }
                    }
                }
                Ok(Choice::Vision { score, confidence, rubric, issues: issues.clone() })
            }
        }
    }
}

/// The items of the picked tables (1-based table numbers), in pick order.
fn picked_items<'a>(picks: &[usize], items: &'a [Vec<(String, usize)>]) -> Vec<&'a (String, usize)> {
    picks.iter().filter_map(|n| items.get(n.wrapping_sub(1))).flatten().collect()
}

/// A table answer over `picks`: with items, `params` holds each item of those tables with `value(option count)`.
fn table_answer(picks: &[usize], items: &[Vec<(String, usize)>], value: impl Fn(usize) -> Value) -> Value {
    let mut answer = json!({"step": "table", "pick": picks});
    if !items.is_empty() {
        answer["params"] = Value::Object(picked_items(picks, items).into_iter().map(|(k, count)| (k.clone(), value(*count))).collect());
    }
    answer
}

/// English letters, spaces and hyphens, at least one letter.
pub const SEARCH_PATTERN: &str = "^[A-Za-z -]*[A-Za-z][A-Za-z -]*$";
/// The longest search text: a few words, so it cannot carry a sentence of claims.
pub const SEARCH_MAX_CHARS: usize = 80;

fn search_query_ok(query: &str) -> bool {
    query.chars().any(|c| c.is_ascii_alphabetic())
        && query
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '-')
}

/// The words of a refused query that hold a character outside the pattern, with those characters, so the refusal names them.
fn search_offenders(query: &str) -> String {
    let bad: Vec<String> = query
        .split_whitespace()
        .filter_map(|word| {
            let chars: BTreeSet<char> = word.chars().filter(|c| !c.is_ascii_alphabetic() && *c != '-').collect();
            (!chars.is_empty()).then(|| format!("'{word}' has {}", chars.iter().map(|c| format!("'{c}'")).collect::<Vec<_>>().join(", ")))
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
const RATIO_WORDS: [&str; 11] = ["一半", "过半", "大半", "半数", "减半", "近半", "逾半", "超半", "翻番", "翻倍", "数倍"];
/// Words with a numeral that type no number (an adverb, a unit, a term); blanked before the scan, but only after a word:
/// not after a numeral, a QUANTITY_BEFORE word or a placeholder, spaces aside (一千万, 数千万, {x}千万 are numbers). Any
/// other such word is refused, a false refusal the model words around: the page keeps the drafts after REFUSED_ROUNDS,
/// the run goes on.
const NUMBER_FREE: [&str; 10] = ["统一成", "一成不变", "十分", "万一", "千万", "一一", "两者", "千瓦", "百分比", "零售"];
/// Words that make the numeral after them a number (数千万, 上千万, 近千万).
const QUANTITY_BEFORE: &str = "数上近逾超余多几";

/// The first number a text types in words outside its placeholders: a RATIO_WORDS word; a run of NUMERALS or digits
/// before a RATIO_AFTER word (spaces aside); or a run of NUMERALS, two or more long or one alone but 一 and 几. An
/// ordinal (第一, 第十二) and the NUMBER_FREE words are no number; digits alone are number_not_allowed's.
pub fn worded_number(text: &str) -> Option<String> {
    let numeral = |c: char| c.is_numeric() || NUMERALS.contains(c);
    let mut chars = outside_placeholders(text);
    // outside_placeholders keeps one char per char of the text: a blank where the text has none is a placeholder's.
    let held: Vec<bool> = chars.iter().zip(text.chars()).map(|(o, t)| *o == ' ' && t != ' ').collect();
    let words: Vec<Vec<char>> = NUMBER_FREE.iter().map(|w| w.chars().collect()).collect();
    for pos in 0..chars.len() {
        let Some(word) = words.iter().find(|w| chars[pos..].starts_with(w)) else {
            continue;
        };
        let before = (0..pos).rev().find(|&j| held[j] || !chars[j].is_whitespace());
        if before.is_none_or(|j| !held[j] && !numeral(chars[j]) && !QUANTITY_BEFORE.contains(chars[j])) {
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
            && (numeral(chars[i]) || (matches!(chars[i], '.' | ',') && chars.get(i + 1).is_some_and(|&n| numeral(n))))
        {
            i += 1;
        }
        if start > 0 && chars[start - 1] == '第' {
            continue;
        }
        let run: String = chars[start..i].iter().collect();
        let rest: String = chars[i..].iter().collect();
        if let Some(after) = RATIO_AFTER.iter().find(|a| rest.trim_start().starts_with(*a)) {
            return Some(format!("{run}{after}"));
        }
        let chinese = run.chars().any(|c| NUMERALS.contains(c));
        if chinese && (run.chars().count() > 1 || !matches!(run.as_str(), "一" | "几")) {
            return Some(run);
        }
    }
    None
}

/// The first number a text types that is not one of `allowed`.
pub fn number_not_allowed(text: &str, allowed: &[String]) -> Option<String> {
    typed_numbers(text).into_iter().find(|n| !allowed.contains(n))
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
        let before = joins(at.checked_sub(1).map(|i| &bytes[i]), at.checked_sub(2).map(|i| &bytes[i]));
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
    pub id: String,
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
        let mut content = text_content(prompt);
        content.extend(images.iter().cloned());
        self.history.push(json!({"role": "user", "content": content, "timestamp": now_ms()}));
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
                let outcome = if calls.len() != 1 {
                    Err(ask.refuse(format!(
                        "answer with exactly one {CHOOSE_TOOL} call; this reply has {}",
                        calls.len()
                    )))
                } else if name != CHOOSE_TOOL {
                    Err(ask.refuse(format!("the only tool of this step is {CHOOSE_TOOL}")))
                } else {
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
                (self.sink)(
                    json!({"type": "tool_execution_end", "toolCallId": id, "toolName": name,
                    "result": {"content": content}, "isError": is_error}),
                );
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

    /// One program call, hung under the accepted model call of this step; with none there it does not run.
    pub async fn auto<R: ToolRunner + Send + ?Sized>(
        &mut self,
        tools: &mut R,
        tool: &str,
        args: Value,
        cancel: &AtomicBool,
    ) -> Result<Called, Stop> {
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
        let mut progress = Vec::new();
        let outcome = tools.run(tool, &args, cancel, &mut progress).await;
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
        for note in tools.take_notes() {
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
        Ok(Called {
            id,
            content,
            details,
            is_error,
        })
    }
}

/// The data group's fetch tool; the route calls it only as a program call.
pub const DATA_PREPARE_TOOL: &str = "newsroom_data_prepare";
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
    /// The visual group's ranking of the relations for a shape (next_visual's `call`, through its door).
    fn rank(&self, shape: &Shape, registered: &[&str], used_before: &[Relation]) -> Matched {
        let calls = Mutex::new(Vec::new());
        match visual_call(&calls, "rank", next_visual::Request::Rank { shape, registered, used_before }) {
            Ok(next_visual::Reply::Matched(matched)) => matched,
            Err(e) => unreachable!("the visual group's ranking cannot fail: {e}"),
        }
    }
    /// The Chinese name of each code in the name table's scheme, through the knowledge group's command; Err lists the codes the
    /// table does not hold (a name is never translated, and a code is never shown in its place).
    fn zh_names(&self, scheme: &str, codes: &[String]) -> Result<BTreeMap<String, String>, Vec<String>> {
        zh_names_reply(knowledge_call(&Mutex::new(Vec::new()), "zh_names", json!({"scheme": scheme, "codes": codes}), next_knowledge::Request::ZhNames { scheme, codes }))
    }
    /// The `GROUP_CALL_EVENT`s of the group calls made since the last take; none for a catalogue that calls no group.
    fn take_calls(&self) -> Vec<Value> {
        Vec::new()
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
    calls: Mutex<Vec<Value>>,
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
            .ok_or_else(|| Stop::CatalogueNotConfigured(format!("{CLASSIFY_REFS_ENV} is not set")))?;
        let calls = Mutex::new(Vec::new());
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
            opened: catalogue,
            refs,
            source,
            calls,
        })
    }

    fn call(&self, kind: &'static str, args: Value, request: next_knowledge::Request<'_>) -> next_knowledge::Reply {
        knowledge_call(&self.calls, kind, args, request)
            .unwrap_or_else(|e| unreachable!("the knowledge group refused {kind}, which only reads: {e}"))
    }
}

fn zh_names_reply(reply: Result<next_knowledge::Reply, String>) -> Result<BTreeMap<String, String>, Vec<String>> {
    match reply {
        Ok(next_knowledge::Reply::ZhNames { names, missing }) if missing.is_empty() => Ok(names),
        Ok(next_knowledge::Reply::ZhNames { missing, .. }) => Err(missing),
        Ok(_) => unreachable!("the knowledge group answered zh_names with another reply"),
        Err(e) => Err(vec![e]),
    }
}

/// One call of the knowledge group's command, as the system group's door for it (group_guard), timed and kept as a
/// `GROUP_CALL_EVENT` with the hashes of what was asked and what came back.
fn knowledge_call(
    calls: &Mutex<Vec<Value>>,
    kind: &'static str,
    args: Value,
    request: next_knowledge::Request<'_>,
) -> Result<next_knowledge::Reply, String> {
    use next_knowledge::Reply;
    let started = std::time::Instant::now();
    let reply = crate::group_guard::as_knowledge_call(|| next_knowledge::call(request));
    let ms = started.elapsed().as_millis() as u64;
    let kept = match &reply {
        Err(e) => json!({"error": e}),
        Ok(Reply::Opened { source, .. }) => json!({"source": source}),
        Ok(Reply::Ranking(ranking)) => serde_json::to_value(ranking).unwrap_or_else(|e| json!({"unrecorded": e.to_string()})),
        Ok(Reply::Names(names)) => json!(names),
        Ok(Reply::Table(meta)) => json!(meta.as_ref().map(|m| json!({"id": m.id, "worldbank": m.worldbank, "dims": m.dims,
            "end_year": m.end_year, "places": m.places}))),
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
    };
    let request = json!({"request": kind, "args": args});
    let event = json!({"group": "knowledge", "request": kind,
        "request_sha256": crate::hash::sha256_bytes(request.to_string().as_bytes()),
        "reply_sha256": crate::hash::sha256_bytes(kept.to_string().as_bytes()), "ms": ms, "ok": reply.is_ok()});
    calls.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    reply
}

/// One call of the visual group's command, through the system group's door for it (group_guard), timed and kept as a
/// `GROUP_CALL_EVENT` like the knowledge group's calls. Neither a shape nor a ranking is JSON, so their debug text is hashed.
fn visual_call(
    calls: &Mutex<Vec<Value>>,
    kind: &'static str,
    request: next_visual::Request<'_>,
) -> Result<next_visual::Reply, String> {
    use next_visual::{Reply, Request};
    let asked = match &request {
        Request::Rank {
            shape,
            registered,
            used_before,
        } => format!("{kind} {shape:?} {registered:?} {used_before:?}"),
    };
    let started = std::time::Instant::now();
    let reply = crate::group_guard::as_visual_call(|| next_visual::call(request));
    let ms = started.elapsed().as_millis() as u64;
    let kept = match &reply {
        Err(e) => format!("error {e}"),
        Ok(Reply::Matched(matched)) => format!("{matched:?}"),
    };
    let event = json!({"group": "visual", "request": kind,
        "request_sha256": crate::hash::sha256_bytes(asked.as_bytes()),
        "reply_sha256": crate::hash::sha256_bytes(kept.as_bytes()), "ms": ms, "ok": reply.is_ok()});
    calls.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    reply
}

impl Catalogue for GroupCatalogue {
    fn top5(&self, question_zh: &str, texts: &[String]) -> Ranking {
        let request = next_knowledge::Request::Top5 { catalogue: &self.opened, question: question_zh, texts };
        match self.call("top5", json!({"question": question_zh, "texts": texts}), request) {
            next_knowledge::Reply::Ranking(ranking) => ranking,
            _ => unreachable!("the knowledge group answered top5 with another reply"),
        }
    }

    fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
        let request = next_knowledge::Request::PlacesOutside { catalogue: &self.opened, question: question_zh, texts };
        match self.call("places_outside", json!({"question": question_zh, "texts": texts}), request) {
            next_knowledge::Reply::Names(names) => names,
            _ => unreachable!("the knowledge group answered places_outside with another reply"),
        }
    }

    fn source(&self) -> &Value {
        &self.source
    }

    fn table(&self, id: &str) -> Option<TableMeta> {
        let request = next_knowledge::Request::Table { catalogue: &self.opened, id };
        match self.call("table", json!({"id": id}), request) {
            next_knowledge::Reply::Table(meta) => meta,
            _ => unreachable!("the knowledge group answered table with another reply"),
        }
    }

    fn places(&self, question_zh: &str) -> Vec<Place> {
        let request = next_knowledge::Request::Places { catalogue: &self.opened, question: question_zh };
        match self.call("places", json!({"question": question_zh}), request) {
            next_knowledge::Reply::Places(places) => places,
            _ => unreachable!("the knowledge group answered places with another reply"),
        }
    }

    fn shape(&self, table: &TableMeta, csv: &str) -> Result<Shape, String> {
        let request = next_knowledge::Request::Shape { refs: &self.refs, table, csv, ask: None };
        match knowledge_call(&self.calls, "shape", json!({"table": table.id, "csv_sha256": crate::hash::sha256_bytes(csv.as_bytes())}), request)? {
            next_knowledge::Reply::Shape(shape) => Ok(shape),
            _ => unreachable!("the knowledge group answered shape with another reply"),
        }
    }

    fn zh_names(&self, scheme: &str, codes: &[String]) -> Result<BTreeMap<String, String>, Vec<String>> {
        zh_names_reply(knowledge_call(&self.calls, "zh_names", json!({"scheme": scheme, "codes": codes}), next_knowledge::Request::ZhNames { scheme, codes }))
    }

    fn rank(&self, shape: &Shape, registered: &[&str], used_before: &[Relation]) -> Matched {
        match visual_call(&self.calls, "rank", next_visual::Request::Rank { shape, registered, used_before }) {
            Ok(next_visual::Reply::Matched(matched)) => matched,
            Err(e) => unreachable!("the visual group's ranking cannot fail: {e}"),
        }
    }

    fn take_calls(&self) -> Vec<Value> {
        std::mem::take(&mut *self.calls.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Records the group calls the catalogue made since the last time, each as a program event under the current step.
pub fn record_group_calls(recorder: &mut Recorder<'_>, catalogue: &dyn Catalogue) -> Result<(), Stop> {
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
    let text = called.content.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join(" ");
    let words: Vec<&str> = text.split_whitespace().map(|w| if w.contains("http://") || w.contains("https://") { "<address>" } else { w }).collect();
    words.join(" ").chars().take(REASON_MAX_CHARS).collect()
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
        let filled = next_params::fill(draft, n, params, &places, this_year).map_err(Stop::NoTable)?;
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
    // With no spec, each listed table's fetch parameters are drafted from the catalogue before the pick (pure, no fetch).
    let drafts: Vec<(&String, Option<next_params::Draft>)> = if steps.is_empty() {
        offers
            .iter()
            .map(|t| (&t.id, catalogue.table(&t.id).map(|meta| next_params::draft(meta, &texts))))
            .collect()
    } else {
        Vec::new()
    };
    record_group_calls(recorder, catalogue)?;
    let items: Vec<Vec<(String, Vec<String>)>> = drafts
        .iter()
        .enumerate()
        .map(|(i, (_, d))| d.as_ref().map_or_else(Vec::new, |d| next_params::items(i + 1, d)))
        .collect();
    let mut listed = Vec::new();
    for (i, t) in offers.iter().enumerate() {
        listed.push(format!("{}. {} ({})", i + 1, t.title, t.id));
        if let Some(table_items) = items.get(i) {
            listed.extend(next_params::lines(table_items));
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
            .map(|table_items| table_items.iter().map(|(k, o)| (k.clone(), o.len())).collect())
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
            .zip(fill_steps(recorder, question, &picks, &drafts, &params, catalogue)?)
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
    for (id, step) in chosen {
        let mut args = step.args.clone();
        let mut called = recorder
            .auto(
                tools,
                DATA_PREPARE_TOOL,
                Value::Object(args.clone()),
                cancel,
            )
            .await?;
        if let Some(narrowed) = step
            .narrowed
            .as_ref()
            .filter(|_| NARROWING_MODES.contains(&mode_of(&called).as_str()))
        {
            args = narrowed.clone();
            called = recorder
                .auto(
                    tools,
                    DATA_PREPARE_TOOL,
                    Value::Object(args.clone()),
                    cancel,
                )
                .await?;
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
        tables.push((id.clone(), args, key, candidates));
    }
    let mut lines = vec![format!("Question: {question}")];
    let mut n = 0;
    for (i, (id, _, _, candidates)) in tables.iter().enumerate() {
        lines.push(format!("Table {} ({id}):", i + 1));
        for (_, text) in candidates {
            n += 1;
            lines.push(format!("{n}. {text}"));
        }
    }
    let groups: Vec<usize> = tables.iter().map(|(_, _, _, c)| c.len()).collect();
    lines.push(format!(
        "Pick the claims the page should tell: {}.",
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
            .auto(tools, DATA_PREPARE_TOOL, Value::Object(with_picks), cancel)
            .await?;
        let details = called.details.clone().unwrap_or(Value::Null);
        let claims = details["claims"].as_array().cloned().unwrap_or_default();
        let mode = mode_of(&called);
        let registered: BTreeSet<&str> = claims
            .iter()
            .filter_map(|c| c["candidate"].as_str())
            .collect();
        let wanted: BTreeSet<&str> = ids.iter().copied().collect();
        if mode != "picks" || !details["runStop"].is_null() || claims.len() != ids.len() {
            let why = match details["runStop"]["reason"].as_str() {
                Some(reason) => format!("the run stopped: {reason}"),
                None => format!(
                    "mode {mode}, {} of {} claims registered",
                    claims.len(),
                    ids.len()
                ),
            };
            return Err(Stop::NotRegistered { dataset: id, why });
        }
        if registered != wanted {
            return Err(Stop::NotRegistered {
                dataset: id,
                why: format!("registered candidates {registered:?} are not the picked {wanted:?}"),
            });
        }
        prepared.push(Prepared {
            file: details["filePath"].as_str().unwrap_or("").to_string(),
            title: offers.iter().find(|o| o.id == id).map(|o| o.title.clone()).unwrap_or_default(),
            id,
            args,
            sheet: key,
            claims,
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
        }
    }

    #[test]
    fn a_search_query_with_a_digit_is_refused_with_the_format_and_an_example() {
        assert_eq!(
            Ask::Search.check(&json!({"step": "search", "query": "EU wind power by country"})),
            Ok(Choice::Search {
                query: "EU wind power by country".into()
            })
        );
        for bad in ["wind 2024", "风电", "", "  - ", "wind_power"] {
            let refused = Ask::Search
                .check(&json!({"step": "search", "query": bad}))
                .unwrap_err();
            assert_eq!(
                refused.example,
                json!({"step": "search", "query": "<english words>"}),
                "{bad}"
            );
            assert!(refused.message().contains("no digits"), "{bad}");
        }
        let refused = Ask::Search
            .check(&json!({"step": "search", "query": "CO2 emissions per_capita"}))
            .unwrap_err();
        assert!(refused.problem.ends_with("; 'CO2' has '2'; 'per_capita' has '_'"), "{}", refused.problem);
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
        }
    }

    #[test]
    fn table_params_give_every_item_of_the_picked_tables() {
        let ask = two_tables_with_items();
        assert_eq!(
            ask.check(&json!({"step": "table", "pick": [2], "params": {"t2.years": 2, "t2.breakdown": 3}})),
            Ok(Choice::Table {
                picks: vec![2],
                params: BTreeMap::from([("t2.breakdown".to_string(), 3), ("t2.years".to_string(), 2)])
            })
        );
        assert_eq!(
            ask.check(&json!({"step": "table", "pick": [0], "params": {}})),
            Ok(Choice::Table { picks: vec![], params: BTreeMap::new() })
        );
        let refused = ask.check(&json!({"step": "table", "pick": [2]})).unwrap_err();
        assert_eq!(refused.problem, "missing key 'params'");
        assert_eq!(ask.schema()["required"], json!(["step", "pick", "params"]));
        assert_eq!(ask.schema()["properties"]["params"]["properties"]["t1.unit"]["enum"], json!([1, 2, 3]));
    }

    #[test]
    fn table_params_of_a_table_not_picked_are_refused_with_the_picked_tables_items_only() {
        let refused = two_tables_with_items()
            .check(&json!({"step": "table", "pick": [2], "params": {"t1.years": 1, "t2.years": 1, "t2.breakdown": 1}}))
            .unwrap_err();
        assert_eq!(refused.problem, "params has no item 't1.years' among the items of the picked tables");
        assert_eq!(
            refused.allowed,
            json!({"step": "table", "pick": [2], "params": {"t2.years": [1, 2], "t2.breakdown": [1, 2, 3]}})
        );
        assert_eq!(refused.example, json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1}}));
    }

    #[test]
    fn table_params_missing_or_out_of_range_name_the_item_and_its_numbers() {
        let ask = two_tables_with_items();
        for params in [json!({"t2.years": 1}), json!({"t2.years": 1, "t2.breakdown": 4}), json!({"t2.years": 1, "t2.breakdown": "3"})] {
            let refused = ask.check(&json!({"step": "table", "pick": [2], "params": params})).unwrap_err();
            assert_eq!(refused.problem, "params needs item 't2.breakdown' as one of its option numbers 1 to 3", "{params}");
            assert_eq!(refused.allowed["params"]["t2.breakdown"], json!([1, 2, 3]));
        }
        let refused = ask.check(&json!({"step": "table", "pick": [2], "params": [1, 3]})).unwrap_err();
        assert!(refused.problem.starts_with("params must map"), "{}", refused.problem);
        // a bad pick is refused before the params, with every listed table's items
        let refused = ask.check(&json!({"step": "table", "pick": [3], "params": {}})).unwrap_err();
        assert_eq!(refused.allowed["pick"], json!([0, 1, 2]));
        assert_eq!(refused.allowed["params"].as_object().unwrap().len(), 4);
    }

    #[test]
    fn a_table_pick_is_up_to_most_listed_numbers_and_only_zero_means_none() {
        let one = Ask::Table { count: 5, most: 1, items: vec![] };
        assert_eq!(
            one.check(&json!({"step": "table", "pick": [0]})),
            Ok(Choice::Table { picks: vec![], params: BTreeMap::new() })
        );
        assert_eq!(
            one.check(&json!({"step": "table", "pick": [5]})),
            Ok(Choice::Table { picks: vec![5], params: BTreeMap::new() })
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
        let two = Ask::Table { count: 5, most: 2, items: vec![] };
        assert_eq!(
            two.check(&json!({"step": "table", "pick": [4, 2]})),
            Ok(Choice::Table { picks: vec![4, 2], params: BTreeMap::new() })
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
        let ask = Ask::Table { count: 2, most: 1, items: vec![] };
        assert!(ask.check(&json!({"step": "claims", "pick": [1]})).is_err());
        assert!(ask
            .check(&json!({"step": "table", "pick": [1], "why": "x"}))
            .is_err());
        assert!(ask.check(&json!([1])).is_err());
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
            (json!({"1": "{max.v.geo}居首（{max.v}），2024年"}), json!({"s1": "德国"})),
            (json!({"2": "各国发电量前５"}), json!({"s1": "德国"})),
            (json!({"2": "过半国家的发电量"}), json!({"s1": "德国"})),
            (json!({"1": "{max.v.geo}是末位的三倍（{max.v}）"}), json!({"s1": "德国"})),
            (json!({}), json!({})),
            (json!({}), json!({"s1": " "})),
            (json!({}), json!({"s1": "德国", "s2": "法国"})),
            (json!({}), json!({"s1": "德国 2024"})),
            (json!({}), json!({"s1": "德国３"})),
            (json!({}), json!({"s1": "{max.v}"})),
            (json!({}), json!({"s1": "Renewable share"})),
            (json!({}), json!({"s1": "两国发电量"})),
            (json!({}), json!({"s1": "欧盟各成员国可再生能源在最终能源消费总量中所占的比例"})),
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
        assert_eq!(typed_numbers("{a}比2023年多3成，65.4与1,200。"), ["2023", "3", "65.4", "1,200"]);
        assert_eq!(typed_numbers("前３名{max.v}7"), ["３", "7"]);
        assert_eq!(number_not_allowed("2023年{a}多3成", &["2023".to_string()]), Some("3".to_string()));
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
                    &Ask::Table { count: 1, most: 1, items: vec![] },
                    "pick the table",
                    &cancel,
                )
                .await
                .unwrap();
            assert_eq!(choice, Choice::Table { picks: vec![1], params: BTreeMap::new() });
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
                &Ask::Table { count: 2, most: 1, items: vec![] },
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
                &Ask::Table { count: 1, most: 1, items: vec![] },
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
                    &Ask::Table { count: 1, most: 1, items: vec![] },
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
                    &Ask::Table { count: 1, most: 1, items: vec![] },
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
                &Ask::Table { count: 1, most: 1, items: vec![] },
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
                &Ask::Table { count: 1, most: 1, items: vec![] },
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
        let ask = Ask::Table { count: 2, most: 1, items: vec![] };
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
                &Ask::Table { count: 1, most: 1, items: vec![] },
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
            Ok(CallOutcome::Result {
                content: text_content("prepared"),
                details: self.details.pop_front(),
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
        assert!(matches!(record_group_calls(&mut recorder, &queued), Err(Stop::NoModelParent { .. })));
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
            dims: vec![dim("geo", 27, &[Role::Place], true), dim("time", 1, &[Role::Time], false)],
            unit_additive: false,
            official_flow: None,
        };
        let registered: Vec<&str> = crate::shape_registry::RELATIONS.iter().map(|r| r.template()).collect();
        let calls = Mutex::new(Vec::new());
        let ask = |used_before: &[Relation]| {
            let request = next_visual::Request::Rank { shape: &shape, registered: &registered, used_before };
            match visual_call(&calls, "rank", request).unwrap() {
                next_visual::Reply::Matched(matched) => matched,
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
        let get = |key: &str| [CATALOGUE_ENV, CLASSIFY_REFS_ENV].contains(&key).then(|| path.clone());
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
        let dims = [("nrg_bal", vec!["GEP", "GHP"]), ("siec", vec!["TOTAL", "RA000", "G3000"]), ("geo", vec!["DE", "FR"]), ("unit", vec!["GWH"])];
        let meta = TableMeta {
            id: "nrg_bal_peh".into(),
            worldbank: false,
            dims: dims
                .into_iter()
                .map(|(d, codes)| (d.to_string(), codes.into_iter().map(|c| (c.to_string(), String::new())).collect()))
                .collect(),
            end_year: Some(2024),
            places: Vec::new(),
        };
        let catalogue = WithTable(
            FakeCatalogue { candidates: offers(), uncovered: None, source: json!({}), searched: Default::default() },
            meta,
        );
        let run = tempfile::tempdir().unwrap();
        write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            // table 2 is nrg_bal_peh; t1.years is an item of a table not picked
            call("toolu_t0", json!({"step": "table", "pick": [2], "params": {"t1.years": 1}})),
            call("toolu_t", json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 3, "t2.nrg_bal": 1}})),
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
        let result = prepare_claims(&mut recorder, &mut model, &mut tools, "德国和法国的发电结构", &[], &catalogue, &cancel).await;
        let history = serde_json::to_string(recorder.history()).unwrap();
        drop(recorder);
        result.unwrap();
        // search, the table pick with its params (refused once), claims: no params call of its own
        assert_eq!(model.offered.len(), 4);
        assert!(model.offered[1]["properties"]["params"]["properties"]["t2.nrg_bal"].is_object());
        assert!(history.contains("t2.breakdown:"), "{history}");
        assert!(history.contains("params has no item 't1.years'"), "{history}");
        assert_eq!(
            tools.args[0],
            json!({"dataset": "nrg_bal_peh", "filters": [
                {"dimension": "freq", "values": ["A"]}, {"dimension": "nrg_bal", "values": ["GEP"]},
                {"dimension": "unit", "values": ["GWH"]}, {"dimension": "geo", "values": ["DE", "FR"]}],
                "years": {"start": 2024, "end": 2024}})
        );
        let events = events.lock().unwrap();
        let params = events.iter().find(|e| e["type"] == PARAMS_EVENT).unwrap();
        assert_eq!(params["params"], "model");
        assert_eq!(params["picks"], json!({"t2.years": 1, "t2.breakdown": 3, "t2.nrg_bal": 1}));
        assert_eq!(params["tables"][0]["open"], "siec");
    }
}
