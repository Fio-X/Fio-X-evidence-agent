//! New route (`NEWSROOM_NEXT=1`, exactly; default off): the program drives a fixed order and the model only answers
//! with numbers and words. This part holds what decides whether the route runs at all: the one switch, the older
//! switches the route stands on, the choice between this route and the model loop, and the transitional prepare
//! spec (`--prepare-spec <file>`, the table and fetch parameters given on the command line until the table pick is
//! wired). Those parts are pure. The recorder below is the one place that talks to the model and runs the program's own calls: it
//! writes every model turn, every call and every model exchange as events, so the audit can trace each program call to the model
//! answer it followed.

use crate::agent_loop::ToolRunner;
use crate::anthropic_model::ToolDef;
use crate::l5geo::{Place, RankAsked, Ranking, TableMeta};
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

/// One table of the spec: what goes to newsroom_data_prepare, the narrowed request used once when the tool asks to narrow,
/// and the ring's window when the program set its years (next_params::Draft::window; never from a spec).
#[derive(Clone, Debug, PartialEq)]
pub struct PrepareStep {
    pub args: Map<String, Value>,
    pub narrowed: Option<Map<String, Value>>,
    pub window: Option<next_params::Window>,
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
        /// probe gave no answer, and then nothing is checked until a fetch of it comes back with no row (no_rows_refused).
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
    /// `changes`: the fields that state a change (the title of a page whose bars draw the change between its two ends,
    /// next_page Drafts::change_title): a wording there that asks a level with no change word is refused (level_question);
    /// empty on any other page.
    /// `levels`: the fields that may not name a change (the title of a page that draws one period's levels of a measure that
    /// is no change itself, next_page Drafts::level_title): a wording there with a CHANGE_WORDS word is refused
    /// (change_word); empty on any other page.
    /// `scoped`: the fields of a page whose chart shows only the places the program kept (next_page Drafts::has_scope): a
    /// wording there that differs from its draft and ranks (ranking_word) is refused; empty on any other page.
    /// `titles`: the page title's field (next_page Drafts::titles): a wording there that asks (question_word) is refused,
    /// a title being a label or a conclusion (TITLE_RULE); empty when the ask holds no title.
    Text {
        fields: BTreeMap<String, String>,
        slots: Vec<String>,
        numbers: Vec<String>,
        periods: Vec<String>,
        changes: Vec<String>,
        levels: Vec<String>,
        scoped: Vec<String>,
        titles: Vec<String>,
        /// The page's scope phrase as its drafts hold it (next_page Drafts::scope_mark: the compared set's words from the
        /// registry, its count a fact placeholder): on a `scoped` field whose draft holds it, a reword that drops it is
        /// refused. Empty on a page with no set.
        mark: String,
        /// The number of distinct places the page draws (next_page Drafts::places_drawn): a count of places of that number
        /// (四国, 两个国家) is no typed number (place_count_free); None, none is.
        places: Option<usize>,
        /// The names of the places and parts the page prints (next_page Drafts::members, the fill's labels), each printed
        /// through its name placeholder: a reworded field that types one the question does not write (`unasked`) and its
        /// draft does not type is refused (MEMBER_RULE); a reworded title that types any of them with a finding_words() word
        /// its draft does not hold is refused (TITLE_FINDING_RULE). Empty when the run does not know them.
        members: Vec<String>,
        /// The `members` the question does not write.
        unasked: Vec<String>,
    },
    /// The image review of the published page's screenshot: each of VISION_QUESTIONS answered yes or no, with a one-line
    /// reason for a no. Advice only: the answer is recorded, it never stops a run and never verifies a page.
    Vision,
    /// The question's shape (owner 11-14 16:0x item 5, 16:5x item 2): one of the many-block shapes the knowledge group
    /// offers (answer_plan::SPLIT_TERMS, its preselected one first with the words that point to it) or 0, none of them;
    /// with a shape, the question's quantities by number in the order its blocks take them (empty: the question's order).
    /// A 0 keeps the one-block flow; the blocks, their tables and years are the program's.
    Split { ask: crate::answer_plan::SplitAsk },
}

/// The image review's yes/no questions, id -> the definition shown to the model, in the order asked and recorded. Whether
/// the illustration fits the topic is left to a later step.
pub const VISION_QUESTIONS: [(&str, &str); 6] = [
    ("headline_finding", "the headline states one finding (a claim about the data), not just a topic"),
    ("single_focus", "the page has one visual focal point and uses one accent colour for it"),
    ("notes_answer_so_what", "every short note says why its number matters, not only what it is"),
    ("legend_matches_marks", "every legend entry matches the marks it explains (colour, shape, size)"),
    ("headline_matches_chart", "the headline and the main chart tell the same story"),
    ("no_unreadable_encoding", "there is no encoding a reader cannot decode at a glance"),
];
/// The longest reason of a no.
pub const VISION_TEXT_MAX: usize = 200;

/// One image review question's answer as the program read it: anything but an exact yes, or an exact no with a one-line
/// reason, is Unanswered (with why), never a yes.
#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Yes,
    No { reason: String },
    Unanswered { why: String },
}

impl Verdict {
    /// The answer as recorded: yes, no or unanswered.
    pub fn word(&self) -> &'static str {
        match self {
            Verdict::Yes => "yes",
            Verdict::No { .. } => "no",
            Verdict::Unanswered { .. } => "unanswered",
        }
    }
}

/// One image review answer (`id` a VISION_QUESTIONS id, `value` what the answer gave for it, None when it gave nothing),
/// read strictly: an object of `answer` and, for a no, `reason`; answer exactly "yes" or "no"; a no's reason one line of 1
/// to VISION_TEXT_MAX characters; no other key.
fn verdict_of(value: Option<&Value>) -> Verdict {
    let unanswered = |why: &str| Verdict::Unanswered { why: why.to_string() };
    let Some(value) = value else {
        return unanswered("not answered");
    };
    let Value::Object(fields) = value else {
        return unanswered("the answer is not an object of answer and reason");
    };
    if let Some(key) = fields.keys().find(|k| !["answer", "reason"].contains(&k.as_str())) {
        return Verdict::Unanswered { why: format!("unknown key '{key}'") };
    }
    let reason = match fields.get("reason") {
        None => None,
        Some(Value::String(text)) => Some(text.as_str()),
        Some(_) => return unanswered("reason is not text"),
    };
    match fields.get("answer").and_then(Value::as_str) {
        Some("yes") => Verdict::Yes,
        Some("no") => match reason.map(str::trim) {
            Some(text)
                if !text.is_empty() && !text.contains(['\n', '\r']) && text.chars().count() <= VISION_TEXT_MAX =>
            {
                Verdict::No { reason: text.to_string() }
            }
            _ => Verdict::Unanswered { why: format!("a no needs a one-line reason of 1 to {VISION_TEXT_MAX} characters") },
        },
        _ => unanswered("answer is not exactly yes or no"),
    }
}

/// The model's answer, checked.
#[derive(Clone, Debug, PartialEq)]
pub enum Choice {
    Search {
        query: String,
    },
    /// The picked table numbers; empty when the answer was 0, none of the tables fits. `params`: item key -> the picked
    /// option number, for the items of the picked tables (empty when the request listed none). `relation`: the number the
    /// answer gave as its optional relation, as given (table_relation keeps or drops it).
    Table {
        picks: Vec<usize>,
        params: BTreeMap<String, usize>,
        relation: Option<usize>,
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
    /// Every VISION_QUESTIONS id with its verdict, in that order.
    Vision {
        answers: Vec<(&'static str, Verdict)>,
    },
    Split {
        reply: crate::answer_plan::SplitReply,
    },
}

/// One breakdown option of a listed table (t<n>.breakdown = `option`, 2 or more): the dimension it opens, the years options
/// whose fetch gives a shape a filled template draws (the only ones allowed with it; none when the table asks no years,
/// next_params::Draft::window), and whether t<n>.<dim> is an item, which the answer then leaves out (the breakdown takes
/// every code of it). A flow split ("siec>nrg_bal", next_params::flow_split) takes the leaves of both its dimensions: it is
/// `member` when either is an item, and the answer leaves out each that is.
#[derive(Clone, Debug, PartialEq)]
pub struct Split {
    pub option: usize,
    pub dim: String,
    pub years: Vec<usize>,
    pub member: bool,
}

impl Split {
    /// The items of table `n` the split leaves out (its dimensions' t<n>.<dim>, next_params::split_dims), among `items`;
    /// empty when it is no member split.
    pub fn left_items(&self, n: usize, items: &[(String, usize)]) -> Vec<String> {
        if !self.member {
            return Vec::new();
        }
        next_params::split_dims(&self.dim)
            .into_iter()
            .map(|d| format!("t{n}.{d}"))
            .filter(|key| items.iter().any(|(k, _)| k == key))
            .collect()
    }

    /// The years option the program gives an answer with this split when the years are no item of its table (an annual
    /// table: next_params fills its last ten years): the split's own when it draws only with the latest year; None when it
    /// takes the ring's years or draws with the ten.
    pub fn program_years(&self) -> Option<usize> {
        (!self.years.is_empty() && !self.years.contains(&next_params::ANNUAL_YEARS)).then(|| self.years[0])
    }
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
    /// The answers of this table (its t<n>. params, as the pick accepted them) whose fetch came back with no row
    /// (prepare_claims): each holds no series whatever the probe said or whether it answered.
    pub empty: Vec<BTreeMap<String, usize>>,
}

/// Single changes of the answer tried for an example before every combination is walked.
const HELD_EXAMPLE_TRIES: usize = 4096;

impl HeldCheck {
    fn holds(&self, n: usize, params: &BTreeMap<String, usize>) -> bool {
        // past a fetch of no row the probe may be unprobed (holds_series then answers true): an answer offered in its
        // place must at least fill
        let fills = self.empty.is_empty()
            || next_params::fill(&self.draft, n, params, &self.places, self.this_year).is_ok();
        !self.empty.contains(params)
            && fills
            && next_params::holds_series(
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
        let years_asked = items.iter().any(|(k, _)| *k == years_key);
        let asked: Vec<&(String, usize)> = items.iter().filter(|(k, _)| *k != years_key).collect();
        let shaped = |mut params: BTreeMap<String, usize>| -> Option<BTreeMap<String, usize>> {
            if let Some(split) = splits
                .iter()
                .find(|s| Some(&s.option) == params.get(&format!("t{n}.breakdown")))
            {
                for item in split.left_items(n, items) {
                    params.remove(&item);
                }
                if !years_asked {
                    // the program's years, as the answer gets them (Split::program_years)
                    match split.program_years() {
                        Some(y) => params.insert(years_key.clone(), y),
                        None => params.remove(&years_key),
                    };
                } else if split.years.is_empty() {
                    // a split that takes the ring's years leaves the years item out
                    params.remove(&years_key);
                } else if !params
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

/// The table pick's refusal of table `n` in the answer `params` (every table's, as the pick accepted them) when the fetch
/// it asks for holds no series (HeldCheck::holds): an answer fetched with no row (HeldCheck::empty) is said so, any other
/// as the probe found it; `refuse` gives what is allowed. None when the answer holds, or when no other answer does (then
/// nothing is refused here: the fetch itself says what it finds).
fn held_refused(
    n: usize,
    params: &BTreeMap<String, usize>,
    check: &HeldCheck,
    items: &[Vec<(String, usize)>],
    splits: &[Vec<Split>],
    refuse: &dyn Fn(String) -> Refused,
) -> Option<Refused> {
    let prefix = format!("t{n}.");
    let mine: BTreeMap<String, usize> =
        params.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(k, v)| (k.clone(), *v)).collect();
    if check.holds(n, &mine) {
        return None;
    }
    let table_items = items.get(n - 1).map_or(&[][..], Vec::as_slice);
    let example = check.example(n, &mine, table_items, splits.get(n - 1).map_or(&[][..], Vec::as_slice))?;
    // the example names the items the model answers, not the years the program gives
    let example: BTreeMap<String, usize> =
        example.into_iter().filter(|(k, _)| table_items.iter().any(|(i, _)| i == k)).collect();
    let shown = example.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ");
    let mut refused = refuse(if check.empty.contains(&mine) {
        let asked = check.asked(n, &mine);
        let asked = if asked.is_empty() {
            mine.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")
        } else {
            asked
        };
        format!(
            "t{n}: the fetch of {asked} came back with no row (fetched after the pick): pick another combination, for example {shown}"
        )
    } else {
        format!(
            "t{n}: Eurostat holds no series for {} (probed before the pick): pick a combination it holds, for example {shown}",
            check.asked(n, &mine)
        )
    });
    if let Some(given) = refused.example["params"].as_object_mut() {
        given.retain(|k, _| !k.starts_with(&prefix));
        given.extend(example.iter().map(|(k, v)| (k.clone(), json!(v))));
    }
    Some(refused)
}

/// After the fetch of table `n` came back with no row: that answer (its t<n>. params in `params`, as the pick accepted them)
/// joins the table's empty answers in `ask` (a table with no probe gets a HeldCheck that holds every other answer, as an
/// unprobed one does), and the refusal the pick gives it then (held_refused), with what is allowed and an example. None,
/// and `ask` as it was, when the table has no draft (its fetch was not filled from the pick) or no other answer is left.
fn no_rows_refused(
    ask: &mut Ask,
    n: usize,
    params: &BTreeMap<String, usize>,
    draft: Option<&next_params::Draft>,
    places: &[Place],
    this_year: i32,
) -> Option<Refused> {
    let Ask::Table { items, splits, held, .. } = ask else {
        return None;
    };
    let (items, splits): (&Vec<Vec<(String, usize)>>, &Vec<Vec<Split>>) = (items, splits);
    let draft = draft?;
    let prefix = format!("t{n}.");
    let mine: BTreeMap<String, usize> =
        params.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(k, v)| (k.clone(), *v)).collect();
    let mut check = held.get(n - 1).cloned().flatten().unwrap_or_else(|| HeldCheck {
        draft: draft.clone(),
        places: places.to_vec(),
        this_year,
        held: next_knowledge::Held::Unprobed("no probe".into()),
        empty: Vec::new(),
    });
    check.empty.push(mine);
    let picks = [n];
    let refuse = |problem: String| Refused {
        problem,
        allowed: table_answer(&picks, items, |count| json!((1..=count).collect::<Vec<_>>())),
        example: table_answer(&picks, items, |_| json!(1)),
    };
    let refused = held_refused(n, params, &check, items, splits, &refuse)?;
    if held.len() < n {
        held.resize(n, None);
    }
    held[n - 1] = Some(check);
    Some(refused)
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

/// The table step's optional answer key: the number of the data relation the page should draw (1 to 6, by RELATIONS).
const RELATION_KEY: &str = "relation";
const RELATIONS: [Relation; 6] = crate::shape_registry::RELATIONS;

/// The relation key's rule as the table step's schema words it: the numbered relations, Composition only with a table
/// whose card says what it splits into (next_params::parts_line).
fn relation_rule() -> String {
    let named: Vec<String> = RELATIONS.iter().enumerate().map(|(i, r)| format!("{} {r:?}", i + 1)).collect();
    format!("optional: the number of the data relation the page should draw, {}; Composition only with a table that has a 'splits into' line", named.join(", "))
}

/// The relation number an answer gives, as given (any other value is none); never a refusal.
fn relation_of(map: &Map<String, Value>) -> Option<usize> {
    map.get(RELATION_KEY).and_then(Value::as_u64).map(|n| n as usize)
}

/// The table step's relation, by the picked main table's data shape only (P4b-4; the question's words are never read): a
/// number outside RELATIONS is dropped; Composition is kept only for a table whose registry has composition groups
/// (next_params::grouped_dim), else dropped; any other is kept. The pick, its tables and params are never changed, nothing
/// is refused or stopped, and no round is added.
fn table_relation(relation: Option<usize>, table: &str) -> Option<Relation> {
    let r = *RELATIONS.get(relation?.checked_sub(1)?)?;
    (r != Relation::Composition || next_params::grouped_dim(table).is_some()).then_some(r)
}

impl Ask {
    fn step(&self) -> &'static str {
        match self {
            Ask::Search => "search",
            Ask::Table { .. } => "table",
            Ask::Claims { .. } => "claims",
            Ask::Text { .. } => "text",
            Ask::Vision => "vision",
            Ask::Split { .. } => "split",
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
                schema["properties"]["relation"] =
                    json!({"type": "integer", "enum": (1..=RELATIONS.len()).collect::<Vec<_>>(), "description": relation_rule()});
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
                changes,
                levels,
                scoped,
                titles,
                members,
                unasked,
                ..
            } => {
                json!({"type": "object", "additionalProperties": false, "required": ["step", "text", "names"],
                "properties": {"step": step,
                    "text": {"type": "object", "additionalProperties": false,
                        "properties": fields.keys().map(|k| (k.clone(), json!({"type": "string"}))).collect::<Map<_, _>>(),
                        "description": format!("field number -> revised wording; leave a field out to keep the draft; keep every {{placeholder}}; {}; {NUMBER_WORD_RULE}{}{}{}{}{}{}", typed_rule(numbers), period_rule(periods), change_rule(changes), level_rule(levels), scope_rule(scoped), title_rule(titles), member_rule(unasked, titles, members))},
                    "names": {"type": "object", "additionalProperties": false, "required": slots,
                        "properties": slots.iter().map(|k| (k.clone(), json!({"type": "string"}))).collect::<Map<_, _>>(),
                        "description": format!("untranslated slot number -> Chinese name, at most {NAME_MAX_CHARS} characters, no number; {NUMBER_WORD_RULE}")}}})
            }
            Ask::Vision => {
                json!({"type": "object", "additionalProperties": false, "required": ["step", "answers"],
                "properties": {"step": step, "answers": {"type": "object", "additionalProperties": false,
                    "required": VISION_QUESTIONS.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
                    "properties": VISION_QUESTIONS.iter().map(|(id, definition)| (id.to_string(), json!({"type": "object",
                        "additionalProperties": false, "required": ["answer"], "description": format!("yes if {definition}"),
                        "properties": {"answer": {"type": "string", "enum": ["yes", "no"]},
                            "reason": {"type": "string", "maxLength": VISION_TEXT_MAX,
                                "description": "with no only: one line on what the image shows"}}}))).collect::<Map<_, _>>(),
                    "description": "question id -> yes or no, judged only on what is visible in the image"}}})
            }
            Ask::Split { ask } => {
                let count = ask.quantities.len();
                let mut quantities = json!({"type": "array", "uniqueItems": true, "maxItems": count,
                    "description": format!("the question's quantities by number, in the order the blocks take them; [] keeps the question's order: {}", quantity_list(ask))});
                quantities["items"] = if count == 0 { json!({"type": "integer"}) } else { json!({"type": "integer", "minimum": 0, "maximum": count - 1}) };
                let mut properties = json!({SPLIT_KEY: {"type": "integer", "enum": split_numbers(ask), "description": split_rule(ask)},
                    QUANTITIES_KEY: quantities});
                properties[STEP_KEY] = step;
                json!({"type": "object", "additionalProperties": false, "required": [STEP_KEY, SPLIT_KEY, QUANTITIES_KEY], "properties": properties})
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
            Ask::Vision => {
                let mut answers: Map<String, Value> =
                    VISION_QUESTIONS.iter().map(|(id, _)| (id.to_string(), json!({"answer": "yes"}))).collect();
                answers.insert(
                    VISION_QUESTIONS[5].0.to_string(),
                    json!({"answer": "no", "reason": "<one line: what the image shows>"}),
                );
                json!({"step": "vision", "answers": answers})
            }
            // the preselected shape when the knowledge group gave one (its words point there), else none of them
            Ask::Split { ask } => split_answer(match ask.offered.first() {
                Some((first, Some(_))) => *first as u8,
                _ => 0,
            }),
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
                changes,
                levels,
                scoped,
                titles,
                places,
                members,
                unasked,
                ..
            } => {
                let mut allowed = json!({"step": "text",
                "text": fields.iter().map(|(k, draft)| (k.clone(), json!(draft))).collect::<Map<_, _>>(), "names": slots,
                "name_max_chars": NAME_MAX_CHARS, "numbers": numbers});
                if !periods.is_empty() {
                    allowed["periods"] = json!(periods);
                }
                if !changes.is_empty() {
                    allowed["changes"] = json!({"fields": changes, "words": CHANGE_WORDS});
                }
                if !levels.is_empty() {
                    allowed["levels"] = json!({"fields": levels, "words": CHANGE_WORDS, "rule": LEVEL_RULE});
                }
                if !scoped.is_empty() {
                    allowed["scoped"] = json!({"fields": scoped, "words": crate::next_page::SUPERLATIVES});
                }
                if !titles.is_empty() {
                    allowed["titles"] = json!({"fields": titles, "words": QUESTION_WORDS});
                }
                if !unasked.is_empty() {
                    allowed["members"] = json!({"unasked": unasked, "rule": MEMBER_RULE});
                }
                if !members.is_empty() && !titles.is_empty() {
                    allowed["title_findings"] = json!({"fields": titles, "members": members, "words": finding_words(), "rule": TITLE_FINDING_RULE});
                }
                if let Some(n) = places {
                    allowed["place_count"] = json!({"places": n, "nouns": free_words().place_counts.iter().map(|w| w.iter().collect::<String>()).collect::<Vec<_>>()});
                }
                allowed
            }
            Ask::Vision => json!({"step": "vision",
                "answers": VISION_QUESTIONS.iter().map(|(id, _)| (id.to_string(), json!(["yes", "no"]))).collect::<Map<_, _>>(),
                "reason_max_chars": VISION_TEXT_MAX}),
            Ask::Split { ask } => json!({STEP_KEY: self.step(), SPLIT_KEY: split_numbers(ask),
                QUANTITIES_KEY: (0..ask.quantities.len()).collect::<Vec<_>>(),
                "least_quantities": crate::answer_plan::SPLIT_TERMS.iter().map(|(n, _, _, least)| (n.to_string(), json!(least))).collect::<Map<_, _>>()}),
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
            Ask::Vision => &["answers"],
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
        if map.get(STEP_KEY).and_then(Value::as_str) != Some(self.step()) {
            return Err(self.refuse(format!("step must be \"{}\"", self.step())));
        }
        // every step's answer holds the step key, then the step's own keys
        let own: &[&str] = match self {
            Ask::Search => &["query"],
            Ask::Table { items, .. } if !items.is_empty() => &["pick", "params"],
            Ask::Table { .. } => &["pick"],
            Ask::Claims { relations, .. } if *relations > 1 => &["pick", "relation"],
            Ask::Claims { .. } => &["pick"],
            Ask::Text { .. } => &["text", "names"],
            Ask::Vision => &["answers"],
            Ask::Split { .. } => &[SPLIT_KEY, QUANTITIES_KEY],
        };
        let keys: Vec<&str> = std::iter::once(STEP_KEY).chain(own.iter().copied()).collect();
        // the table step's relation is optional and never refused (table_relation reads it after every check)
        let optional = |k: &str| matches!(self, Ask::Table { .. }) && k == RELATION_KEY;
        if let Some(key) = map.keys().find(|k| !keys.contains(&k.as_str()) && !optional(k)) {
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
                        relation: relation_of(map),
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
                    let (taken, years_key) = (
                        split.left_items(n, items.get(n - 1).map_or(&[][..], Vec::as_slice)),
                        format!("t{n}.{}", next_params::YEARS_KEY),
                    );
                    let refuse_split = |problem: String| {
                        let mut refused = refuse(problem);
                        if let Some(params) = refused.allowed["params"].as_object_mut() {
                            for item in &taken {
                                params.remove(item);
                            }
                            if split.years.is_empty() {
                                params.remove(&years_key);
                            } else if params.contains_key(&years_key) {
                                params.insert(years_key.clone(), json!(split.years));
                            }
                            params.insert(format!("t{n}.breakdown"), json!(split.option));
                        }
                        refused
                    };
                    if split.years.is_empty() {
                        // the split takes the ring's years (next_params::Draft::window): the years item has no place
                        if given.contains_key(&years_key) {
                            return Err(refuse_split(format!(
                                "t{n}.breakdown {} ({}) takes the ring's years, so {years_key} has no place: leave it out, or set another t{n}.breakdown",
                                split.option, split.dim
                            )));
                        }
                        left_out.push(years_key.clone());
                    }
                    if let Some(item) = taken.iter().find(|item| given.contains_key(*item)) {
                        let dim = &item[format!("t{n}.").len()..];
                        // a flow split takes its dimensions' registered leaves, any other split every code of its one
                        let takes = if next_params::flow_split(&split.dim).is_some() {
                            format!("the registered {dim} leaves")
                        } else {
                            format!("every {dim} code")
                        };
                        return Err(refuse_split(format!(
                            "t{n}.breakdown {} ({}) takes {takes}, so {item} has no place: leave it out, or keep it and set t{n}.breakdown 1",
                            split.option, split.dim
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
                    left_out.extend(taken.iter().cloned());
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
                // A table whose years are no item (an annual one) takes the program's: a picked split that draws only with
                // the latest year gets that option here, never from the model.
                for &n in &picks {
                    let years_key = format!("t{n}.{}", next_params::YEARS_KEY);
                    if items.get(n - 1).is_some_and(|its| its.iter().any(|(k, _)| *k == years_key)) {
                        continue;
                    }
                    let breakdown = params.get(&format!("t{n}.breakdown")).copied();
                    let split = splits.get(n - 1).into_iter().flatten().find(|s| Some(s.option) == breakdown);
                    if let Some(y) = split.and_then(Split::program_years) {
                        params.insert(years_key, y);
                    }
                }
                // The fetch the answer asks for must hold a series the probe found, and must not be one fetched with no
                // row; refused only with an example that does.
                for &n in &picks {
                    let Some(Some(check)) = held.get(n - 1) else {
                        continue;
                    };
                    if let Some(refused) = held_refused(n, &params, check, items, splits, &refuse) {
                        return Err(refused);
                    }
                }
                Ok(Choice::Table { picks, params, relation: relation_of(map) })
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
                changes,
                levels,
                scoped,
                titles,
                mark,
                places,
                members,
                unasked,
            } => {
                let text = strings(&map["text"])
                    .ok_or_else(|| self.refuse("text must map field numbers to wording"))?;
                for (id, revised) in &text {
                    let Some(draft) = fields.get(id) else {
                        return Err(self.refuse(format!("text has no field '{id}'")));
                    };
                    // A draft that ranks under the scope's own words (the page's set phrase, `mark`, its count a placeholder)
                    // keeps them, with the draft as the example: said first, before the placeholder its count is.
                    let mark = mark.as_str();
                    if scoped.contains(id) && revised != draft && !mark.is_empty() && draft.contains(mark) && !revised.contains(mark) {
                        return Err(self.refuse(format!("field '{id}': drops '{mark}'{}, e.g. '{draft}'", scope_rule(scoped))));
                    }
                    if let Err(why) = same_placeholders(draft, revised) {
                        return Err(self.refuse(format!("field '{id}': {why}")));
                    }
                    // A count of the places the page draws (四国 on a page of four) is the data's own count (user 11-07).
                    let counted = place_count_free(revised, *places);
                    // Every number on the page comes from the data: a row value through a placeholder, or a label of the picked tables.
                    if let Some(typed) = number_not_allowed(&number_free_text(&counted), numbers) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{typed}' is a typed number; {}; keep the drafted {{placeholders}}",
                            typed_rule(numbers)
                        )));
                    }
                    if let Some(word) = worded_number(&counted) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{word}' is a number in words (a count, a multiple, a share, a half) that no data gave; {NUMBER_WORD_RULE}; keep the drafted {{placeholders}} and leave it out"
                        )));
                    }
                    if let Some(word) = unanswered_word(revised) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{word}' says a part cannot be answered; only the program says that, on its own line, when no table holds the part; leave it out"
                        )));
                    }
                    if let Some(written) =
                        year_after_period(revised).filter(|_| !periods.is_empty())
                    {
                        return Err(self
                            .refuse(format!("field '{id}': '{written}'{}", period_rule(periods))));
                    }
                    if let Some(written) = year_after_fact_period(revised) {
                        return Err(self.refuse(format!("field '{id}': '{written}'; {FACT_PERIOD_RULE}")));
                    }
                    if let Some(level) = level_question(revised).filter(|_| changes.contains(id)) {
                        return Err(self.refuse(format!("field '{id}': '{level}' asks a level{}", change_rule(changes))));
                    }
                    if let Some(word) = change_word(revised).filter(|_| levels.contains(id)) {
                        return Err(self.refuse(format!("field '{id}': '{word}' names a change{}, e.g. '{draft}'", level_rule(levels))));
                    }
                    // On a scoped page a ranking word holds only among the kept places: refused here, so the model words
                    // it again, rather than put back after acceptance (next_page Drafts::scoped).
                    // the set phrase is the registry's words, which may rank the set itself (人口最多的): read without it
                    let unmarked = if mark.is_empty() { revised.clone() } else { revised.replace(mark, "") };
                    if let Some(word) =
                        ranking_word(&unmarked).filter(|_| scoped.contains(id) && revised != draft)
                    {
                        return Err(self.refuse(format!("field '{id}': '{word}' ranks{}", scope_rule(scoped))));
                    }
                    // A title is a label or a conclusion: a question there is refused with the field's own draft, a title
                    // of this page's kind that passes every check above.
                    if let Some(word) = question_word(revised).filter(|_| titles.contains(id)) {
                        return Err(self.refuse(format!(
                            "field '{id}': '{word}' makes it a question{}, e.g. '{draft}'",
                            title_rule(titles)
                        )));
                    }
                    // A place or part the page draws is named through its placeholder, which the program fills from the
                    // data: one the question does not write, typed where the draft does not, names what no fact gave.
                    if let Some(name) = typed_member(revised, draft, unasked) {
                        return Err(self.refuse(format!("field '{id}': '{name}' {MEMBER_RULE}, e.g. '{draft}'")));
                    }
                    // A title that names a drawn place or part says no standing of it: the finding is the program's headline.
                    if titles.contains(id) {
                        if let Some(word) = typed_member(revised, draft, members).and_then(|_| finding_word(revised, draft)) {
                            return Err(self.refuse(format!("field '{id}': '{word}' {TITLE_FINDING_RULE}, e.g. '{draft}'")));
                        }
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
                    number_free_text(name)
                        .chars()
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
                    if let Some(word) = unanswered_word(name) {
                        return Err(self.refuse(format!("names: slot '{id}' has '{word}'; only the program says a part cannot be answered")));
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
            // the reply's frame is refused as any other step's; within it, each question is read on its own (verdict_of)
            Ask::Vision => {
                let Value::Object(given) = &map["answers"] else {
                    return Err(self.refuse("answers must map each question id to {answer, reason}"));
                };
                if let Some(key) = given.keys().find(|k| !VISION_QUESTIONS.iter().any(|(id, _)| id == k)) {
                    return Err(self.refuse(format!("answers has no question '{key}'")));
                }
                Ok(Choice::Vision {
                    answers: VISION_QUESTIONS.iter().map(|(id, _)| (*id, verdict_of(given.get(*id)))).collect(),
                })
            }
            Ask::Split { ask } => {
                let number = match map[SPLIT_KEY].as_u64() {
                    Some(n) if split_numbers(ask).contains(&n) => n as u8,
                    _ => return Err(self.refuse("split must be 0 or one of the offered numbers")),
                };
                let Some(given) = map[QUANTITIES_KEY].as_array() else {
                    return Err(self.refuse("quantities must be a list of quantity numbers"));
                };
                let mut quantities = Vec::new();
                for v in given {
                    match v.as_u64() {
                        Some(i) if (i as usize) < ask.quantities.len() && !quantities.contains(&(i as usize)) => quantities.push(i as usize),
                        Some(i) if quantities.contains(&(i as usize)) => return Err(self.refuse(format!("quantities lists {i} twice"))),
                        _ => return Err(self.refuse(format!("quantities: {v} is not a listed quantity number"))),
                    }
                }
                if number != 0 {
                    let n = if quantities.is_empty() { ask.quantities.len() } else { quantities.len() };
                    if let Some((_, name, _, least)) = crate::answer_plan::SPLIT_TERMS.iter().find(|t| t.0 == number) {
                        if n < *least {
                            return Err(self.refuse(format!("split {number} ({name}) takes {least} quantities or more, and the answer gives {n}; answer 0 when the question names fewer")));
                        }
                    }
                }
                Ok(Choice::Split { reply: crate::answer_plan::SplitReply { number, quantities } })
            }
        }
    }
}

/// The key every answer names its step with.
const STEP_KEY: &str = "step";
/// The split step's keys: the number of the shape the question takes (it sets the page's blocks), and the question's
/// quantities in the order the blocks take them.
const SPLIT_KEY: &str = "split";
const QUANTITIES_KEY: &str = "quantities";

/// A split answer with that shape number and the question's quantities in its own order: the example of a split ask, and
/// the answer of a run recorded before the step was asked (0, the one-block flow it ran on).
pub fn split_answer(number: u8) -> Value {
    json!({STEP_KEY: "split", SPLIT_KEY: number, QUANTITIES_KEY: []})
}

/// The shape numbers a shape answer may give: 0 (none of them), then the offered ones in the order offered.
fn split_numbers(ask: &crate::answer_plan::SplitAsk) -> Vec<u64> {
    std::iter::once(0).chain(ask.offered.iter().map(|(offered, _)| *offered as u64)).collect()
}

/// The question's quantities as the shape request lists them: number, then printed name.
fn quantity_list(ask: &crate::answer_plan::SplitAsk) -> String {
    if ask.quantities.is_empty() {
        return "the question names none".into();
    }
    ask.quantities.iter().enumerate().map(|(i, (_, zh))| format!("{i} {zh}")).collect::<Vec<_>>().join(", ")
}

/// The shape rule: 0, then each offered shape with what it answers (answer_plan::SPLIT_TERMS), the words of the question
/// that point to one written after it.
fn split_rule(ask: &crate::answer_plan::SplitAsk) -> String {
    let offered: Vec<String> = ask
        .offered
        .iter()
        .filter_map(|(offered, words)| {
            let (n, name, what, least) = crate::answer_plan::SPLIT_TERMS.iter().find(|t| t.0 == *offered as u8)?;
            let pointed = words.map_or(String::new(), |w| format!("; the question's words \"{w}\" point here"));
            Some(format!("{n} {name}: {what} (takes {least} quantities or more{pointed})"))
        })
        .collect();
    format!("how the question splits into the page's blocks: 0 none of these (one block answers it); {}", offered.join("; "))
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

/// number-free-words.json, the knowledge group's word list read as data, built by a tool from World Bank indicator names in
/// Chinese and the unit table only (user 11-07 「全按推荐」⑤, 11-08 item 3: no word typed in by hand; a count is still checked).
struct FreeWords {
    terms: Vec<Vec<char>>,
    si_units: Vec<Vec<char>>,
    rates: Vec<Vec<char>>,
    ages: Vec<String>,
    scales: Vec<Vec<char>>,
    scale_open: Vec<Vec<char>>,
    scale_close: Vec<Vec<char>>,
    age_range: Vec<char>,
    /// The nouns that make the numeral right before them a count of places (四国, 两个国家), longest first.
    place_counts: Vec<Vec<char>>,
    /// The row dimensions whose codes are places (next_run places_drawn).
    pub place_dims: Vec<String>,
}

fn free_words() -> &'static FreeWords {
    static W: std::sync::OnceLock<FreeWords> = std::sync::OnceLock::new();
    W.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../runtime/pi/assets/number-free-words.json"))
            .expect("number-free-words.json parses");
        let words = |k: &str| -> Vec<String> {
            v[k].as_array().expect("a word list").iter().map(|w| w.as_str().expect("a word").to_string()).collect()
        };
        let list = |k: &str| -> Vec<Vec<char>> { words(k).iter().map(|w| w.chars().collect()).collect() };
        FreeWords {
            terms: list("terms"),
            si_units: list("si_units"),
            rates: list("rates"),
            ages: words("ages"),
            scales: list("scales"),
            scale_open: list("scale_open"),
            scale_close: list("scale_close"),
            age_range: words("age_range").iter().flat_map(|w| w.chars()).collect(),
            place_counts: {
                let mut nouns = list("place_counts");
                nouns.sort_by_key(|n| std::cmp::Reverse(n.len()));
                nouns
            },
            place_dims: words("place_dims"),
        }
    })
}

/// The row dimensions whose codes are places (number-free-words.json place_dims), for counting the places a page draws.
pub fn place_dims() -> &'static [String] {
    &free_words().place_dims
}

/// The value of a run of NUMERALS (四 4, 两 2, 十二 12, 二十七 27); None for a run with 几 or a digit.
fn numeral_value(run: &[char]) -> Option<usize> {
    let (mut total, mut section, mut digit) = (0usize, 0usize, None::<usize>);
    for &c in run {
        let unit = match c {
            '十' => 10,
            '百' => 100,
            '千' => 1000,
            '万' => 10_000,
            '亿' => 100_000_000,
            '〇' => {
                digit = Some(0);
                continue;
            }
            '两' => {
                digit = Some(2);
                continue;
            }
            '零' => {
                digit = Some(0);
                continue;
            }
            '一' => {
                digit = Some(1);
                continue;
            }
            '二' => {
                digit = Some(2);
                continue;
            }
            '三' => {
                digit = Some(3);
                continue;
            }
            '四' => {
                digit = Some(4);
                continue;
            }
            '五' => {
                digit = Some(5);
                continue;
            }
            '六' => {
                digit = Some(6);
                continue;
            }
            '七' => {
                digit = Some(7);
                continue;
            }
            '八' => {
                digit = Some(8);
                continue;
            }
            '九' => {
                digit = Some(9);
                continue;
            }
            _ => return None,
        };
        if unit >= 10_000 {
            total = total.checked_add((section + digit.unwrap_or(0)).max(1).checked_mul(unit)?)?;
            section = 0;
        } else {
            section += digit.unwrap_or(1) * unit;
        }
        digit = None;
    }
    Some(total + section + digit.unwrap_or(0))
}

/// Which chars of `chars` (a text outside its placeholders, `held` marking a placeholder's blank) count the places the page
/// draws: a run of NUMERALS right before a place_counts noun (四国, 两个国家, 四个经济体) whose value is `places`, not after
/// 第, a QUANTITY_BEFORE word or a placeholder (user 11-07: a count of places is a number, allowed only when it is the count
/// the page draws). Digits stay a typed number: the core's schema refuses any digit in a literal word. None marks none.
fn place_count(chars: &[char], held: &[bool], places: Option<usize>) -> Vec<bool> {
    let mut free = vec![false; chars.len()];
    let Some(places) = places else { return free };
    let w = free_words();
    let numeral = |c: char| NUMERALS.contains(c);
    let mut i = 0;
    while i < chars.len() {
        if !numeral(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && numeral(chars[i]) {
            i += 1;
        }
        let before = (0..start).rev().find(|&j| held[j] || !chars[j].is_whitespace());
        let free_before = before.is_none_or(|j| !held[j] && chars[j] != '第' && !QUANTITY_BEFORE.contains(chars[j]));
        let noun = w.place_counts.iter().any(|n| chars.get(i..i + n.len()) == Some(n.as_slice()));
        if free_before && noun && numeral_value(&chars[start..i]) == Some(places) {
            free[start..i].iter_mut().for_each(|f| *f = true);
        }
    }
    free
}

/// The text with each count of the places the page draws blanked (place_count), one space per char, placeholders kept as
/// written; any other numeral as written.
pub fn place_count_free(text: &str, places: Option<usize>) -> String {
    let outside = outside_placeholders(text);
    let held: Vec<bool> = outside.iter().zip(text.chars()).map(|(o, t)| *o == ' ' && t != ' ').collect();
    let free = place_count(&outside, &held, places);
    text.chars().zip(free).map(|(c, f)| if f { ' ' } else { c }).collect()
}

/// Which chars of `chars` (a text outside its placeholders, `held` marking a placeholder's blank) write a FreeWords word:
/// a term or a rate's base not right after a numeral, a QUANTITY_BEFORE word or a placeholder; an SI unit not right after
/// a numeral or a QUANTITY_BEFORE word (after a placeholder it is the value's unit); a scale label alone in brackets
/// (（百万吨）, not （百万以上）); an age or an age band of the list, its range mark read as '-' (15至24岁 as 15-24岁).
fn number_free(chars: &[char], held: &[bool]) -> Vec<bool> {
    let w = free_words();
    let numeral = |c: char| c.is_numeric() || NUMERALS.contains(c);
    let at = |i: usize, word: &[char]| !word.is_empty() && chars.get(i..i + word.len()) == Some(word);
    let before = |i: usize| (0..i).rev().find(|&j| held[j] || !chars[j].is_whitespace());
    let counted = |j: usize| numeral(chars[j]) || QUANTITY_BEFORE.contains(chars[j]);
    let run_end = |i: usize| {
        let mut e = i;
        while e < chars.len() && (numeral(chars[e]) || (chars[e] == '.' && chars.get(e + 1).is_some_and(|&n| numeral(n)))) {
            e += 1;
        }
        e
    };
    let mut free = vec![false; chars.len()];
    for i in 0..chars.len() {
        let mut mark = |from: usize, to: usize| free[from..to].iter_mut().for_each(|f| *f = true);
        // a coded term stands alone among Latin letters and digits (M2 is not in PM2.5)
        let alone = |t: &[char]| {
            let code = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '.');
            !code(i.checked_sub(1).and_then(|j| chars.get(j))) && !code(chars.get(i + t.len()))
        };
        if let Some(t) = w.terms.iter().chain(&w.rates).find(|t| at(i, t) && alone(t)) {
            if before(i).is_none_or(|j| !held[j] && !counted(j)) {
                mark(i, i + t.len());
            }
        }
        if let Some(u) = w.si_units.iter().find(|u| at(i, u)) {
            if before(i).is_none_or(|j| held[j] || !counted(j)) {
                mark(i, i + u.len());
            }
        }
        if let Some(o) = w.scale_open.iter().find(|o| at(i, o)) {
            let closed = |s: &[char]| w.scale_close.iter().any(|c| at(i + o.len() + s.len(), c));
            if let Some(s) = w.scales.iter().find(|s| at(i + o.len(), s) && closed(s)) {
                mark(i + o.len(), i + o.len() + s.len());
            }
        }
        if numeral(chars[i]) && (i == 0 || !numeral(chars[i - 1])) && before(i).is_none_or(|j| !held[j]) {
            let e = run_end(i);
            let mut end = e;
            if chars.get(e).is_some_and(|c| w.age_range.contains(c)) && run_end(e + 1) > e + 1 {
                end = run_end(e + 1);
            }
            if chars.get(end) == Some(&'岁') {
                let band: String =
                    chars[i..=end].iter().map(|&c| if w.age_range.contains(&c) { '-' } else { c }).collect();
                // an age band alone, or a single age with the words its official name writes after it (5岁以下); a bare age
                // (增加了5岁) is a number
                let rest: String = chars[end + 1..].iter().collect();
                let named = w.ages.iter().filter(|a| a.starts_with(band.as_str()) && rest.starts_with(&a[band.len()..]));
                if let Some(a) = named.max_by_key(|a| a.len()) {
                    mark(i, end + 1 + a[band.len()..].chars().count());
                }
            }
        }
    }
    free
}

/// The text with each number_free span blanked, one space per char (placeholders kept as written), for the digit checks.
pub fn number_free_text(text: &str) -> String {
    let outside = outside_placeholders(text);
    let held: Vec<bool> = outside.iter().zip(text.chars()).map(|(o, t)| *o == ' ' && t != ' ').collect();
    let free = number_free(&outside, &held);
    text.chars().zip(free).map(|(c, f)| if f { ' ' } else { c }).collect()
}

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
    let free = number_free(&chars, &held);
    chars.iter_mut().zip(free).filter(|(_, f)| *f).for_each(|(c, _)| *c = ' ');
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
/// A word that says a part of the question cannot be answered (runtime/pi/assets/unanswered-words.tsv, the knowledge group's
/// word list, read as data): whether a part is answered is the program's call and its line is the program's (user 11-05
/// 10:2x), so a model's wording that holds one is refused and worded again.
pub fn unanswered_word(text: &str) -> Option<String> {
    include_str!("../runtime/pi/assets/unanswered-words.tsv")
        .lines()
        .map(str::trim)
        .filter(|w| !w.is_empty() && !w.starts_with('#'))
        .find(|w| text.chars().filter(|c| !c.is_whitespace()).collect::<String>().contains(w))
        .map(str::to_string)
}

pub fn year_after_period(text: &str) -> Option<String> {
    year_after(text, |column| crate::next_page::TIME_COLUMNS.contains(&column))
}

/// The first fact period placeholder ("{lead1.t}", next_run finding_of) of a text written with 年 right after it, as
/// written: the leaf prints a fact's period with its own 年 ("2024 年"), on every page.
pub fn year_after_fact_period(text: &str) -> Option<String> {
    year_after(text, |column| column == "t")
}

/// The first placeholder whose last part `timed` holds, written with 年 right after it (spaces aside), as written.
fn year_after(text: &str, timed: impl Fn(&str) -> bool) -> Option<String> {
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let close = open + rest[open..].find('}')?;
        let name = &rest[open + 1..close];
        let column = name.rsplit('.').next().unwrap_or(name);
        let after = rest[close + 1..].trim_start();
        if timed(column) && after.starts_with('年') {
            return Some(format!("{}年", &rest[open..=close]));
        }
        rest = &rest[close + 1..];
    }
    None
}

/// The rule of a fact period placeholder, said in a refusal of year_after_fact_period.
pub const FACT_PERIOD_RULE: &str = "a {<fact>.t} placeholder prints its year with 年 already, so write no 年 after it";

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

/// The rule of the fields that state a change (Ask::Text changes), said to the model in the ask and in a refusal; empty
/// when no field does.
/// LEVEL_RULE with the fields it holds for; empty when the page draws no levels.
fn level_rule(levels: &[String]) -> String {
    if levels.is_empty() {
        String::new()
    } else {
        format!("; {LEVEL_RULE} (field {})", levels.join(", "))
    }
}

/// Why a level page's title names no change: the page ranks one period, the change between periods is not drawn.
pub const LEVEL_RULE: &str = "this page ranks the places in one period and draws no change between periods: name what it ranks, with no change word";

fn change_rule(changes: &[String]) -> String {
    if changes.is_empty() {
        String::new()
    } else {
        format!("; {CHANGE_TITLE_RULE} (field {})", changes.join(", "))
    }
}

/// The title rule of a page whose bars draw the change between its two ends, with its examples, a label and a conclusion
/// (none ranks or asks, so they pass on a scoped page and under TITLE_RULE too).
pub const CHANGE_TITLE_RULE: &str = "this page draws how much each changed between its two ends, not who is highest, so its title names a \
     change, as a label or a conclusion: it holds 变化, 增, 减, 升, 降, 涨, 跌 or 从…到, e.g. '各方数值的变化' or \
     '少数地区升幅居前', not '各地数值最高'";
/// Words a title asks a level with (who is highest, most, first).
pub const LEVEL_WORDS: [&str; 10] = ["最高", "最低", "最多", "最少", "最大", "最小", "领先", "垫底", "第一", "居首"];
/// Words that name a change; 从 with 到 after it (从起始到最近) names one too.
pub const CHANGE_WORDS: [&str; 10] = ["变", "增", "减", "升", "降", "涨", "跌", "提高", "扩大", "缩小"];

/// The rule of the fields of a scoped page (Ask::Text scoped), said to the model in the ask and in a refusal, with an
/// example that passes; the words are next_page SUPERLATIVES.
pub const SCOPE_RULE: &str = "this page's chart shows only the places the program kept, not all of them, so a ranking word \
     (最高, 最低, 领先, 垫底, 第一, 最多, 最少) holds only among those: a reworded field names none outside the draft's set phrase (在…中, which says which places), e.g. '各地的高低分布', \
     and keeps that set phrase word for word where its draft says it";

/// The rule of the title field (Ask::Text titles), said to the model in the ask and in a refusal, with a label and a
/// conclusion that pass (neither ranks, asks a level nor types a number); the words are QUESTION_WORDS.
pub const TITLE_RULE: &str = "the title is a label (what the page is about, e.g. '各地的高低分布') or a conclusion (what \
     the chart shows, e.g. '少数地区明显偏高'), never a question: no ？ or ?, and none of 为什么, 什么, 为何, 怎么, 怎样, 如何, 多少, \
     多大, 谁, 哪, 吗, 几";
/// Words that make a wording ask; 几乎 (almost) is none of them. Longest first, so a refusal names the whole word.
pub const QUESTION_WORDS: [&str; 12] = ["为什么", "什么", "为何", "怎么", "怎样", "如何", "多少", "多大", "谁", "哪", "吗", "几"];

/// TITLE_RULE with the field it holds for; empty when the ask holds no title.
fn title_rule(titles: &[String]) -> String {
    if titles.is_empty() {
        String::new()
    } else {
        format!("; {TITLE_RULE} (field {})", titles.join(", "))
    }
}

/// What makes a wording a question, if anything: a question mark (？ or ?) anywhere, else its first QUESTION_WORDS word
/// (哪里, 哪些 and 哪国 ask as 哪 does; 几乎 is no question).
pub fn question_word(text: &str) -> Option<&'static str> {
    if let Some(mark) = ["？", "?"].into_iter().find(|m| text.contains(*m)) {
        return Some(mark);
    }
    let text = text.replace("几乎", "");
    QUESTION_WORDS.iter().copied().find(|w| text.contains(*w))
}

/// SCOPE_RULE with the fields it holds for; empty when the page is not scoped.
fn scope_rule(scoped: &[String]) -> String {
    if scoped.is_empty() {
        String::new()
    } else {
        format!("; {SCOPE_RULE} (field {})", scoped.join(", "))
    }
}

/// The SUPERLATIVES word a wording ranks with, if any.
pub fn ranking_word(text: &str) -> Option<&'static str> {
    crate::next_page::SUPERLATIVES
        .iter()
        .copied()
        .find(|w| text.contains(*w))
}

/// Why a reworded field may not type a drawn place's or part's name (Ask::Text members): said after the name in a refusal.
pub const MEMBER_RULE: &str = "is a place or part the page draws, which the program names from the data through its {name.<code>} \
     placeholder: a reworded field types none of the page's names the question does not write, where its draft does not";
/// Why a reworded title may not say a drawn place's or part's standing (Ask::Text members, titles): said after the word.
pub const TITLE_FINDING_RULE: &str = "says where a place or part the title names stands: the title is a label (what the page \
     is about), and the program's headline says the finding from the data; name no standing of a place or part there";
/// The words that say a place's or part's standing (next_knowledge::TITLE_FINDINGS_ZH), read once. A file that does not
/// parse or holds no word fails loud here (a test reads it), never a check that silently holds no word.
pub fn finding_words() -> &'static [String] {
    static WORDS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| {
        let v: Value = serde_json::from_str(crate::next_knowledge::TITLE_FINDINGS_ZH).expect("title-findings-zh.json parses");
        let words: Vec<String> = v["words"]
            .as_array()
            .expect("title-findings-zh.json holds words")
            .iter()
            .filter_map(Value::as_str)
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect();
        assert!(!words.is_empty(), "title-findings-zh.json holds no word");
        words
    })
}

/// A text read for its own words: without its placeholders (a name placeholder prints the data's name, a value one the
/// data's number) and without the knowledge group's level terms (a measure's name such as 最低工资 holds no standing).
fn own_words(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    level_terms().iter().fold(out, |t, term| t.replace(term.as_str(), ""))
}

/// The first of `names` (longest first) a reworded field types in its own words that its draft does not type.
pub fn typed_member(revised: &str, draft: &str, names: &[String]) -> Option<String> {
    let (said, drafted) = (own_words(revised), own_words(draft));
    let mut names: Vec<&String> = names.iter().filter(|n| !n.trim().is_empty()).collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
    names.into_iter().find(|n| said.contains(n.as_str()) && !drafted.contains(n.as_str())).cloned()
}

/// The first finding_words() word a reworded field holds in its own words that its draft does not.
pub fn finding_word(revised: &str, draft: &str) -> Option<&'static str> {
    let (said, drafted) = (own_words(revised), own_words(draft));
    finding_words().iter().map(String::as_str).find(|w| said.contains(*w) && !drafted.contains(*w))
}

/// MEMBER_RULE with the names it holds for, and TITLE_FINDING_RULE with the title field; empty when the ask knows no names.
fn member_rule(unasked: &[String], titles: &[String], members: &[String]) -> String {
    let mut rule = String::new();
    if !unasked.is_empty() {
        rule += &format!("; a name such as {} {MEMBER_RULE}", unasked.iter().take(6).cloned().collect::<Vec<_>>().join(", "));
    }
    if !members.is_empty() && !titles.is_empty() {
        let words = finding_words().iter().take(6).cloned().collect::<Vec<_>>().join(", ");
        rule += &format!("; a title that names one, with a word such as {words}, {TITLE_FINDING_RULE} (field {})", titles.join(", "));
    }
    rule
}

/// The first CHANGE_WORDS word a wording holds, read without the knowledge group's level terms (a measure's name such as
/// value added holds a change word's character and names no change): on a page that draws one period's levels, such a
/// title names a change the page does not show.
pub fn change_word(text: &str) -> Option<&'static str> {
    let read = level_terms().iter().fold(text.to_string(), |t, term| t.replace(term.as_str(), ""));
    CHANGE_WORDS.iter().copied().find(|w| read.contains(*w))
}

/// The terms of next_knowledge::LEVEL_TERMS_ZH, read once; a file that does not parse gives none, so every change word
/// is refused as before (the check never loosens on a bad file).
fn level_terms() -> &'static [String] {
    static TERMS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    TERMS.get_or_init(|| {
        serde_json::from_str::<Value>(crate::next_knowledge::LEVEL_TERMS_ZH)
            .ok()
            .and_then(|v| {
                v["terms"].as_array().map(|ts| {
                    ts.iter().filter_map(|t| t["zh"].as_str()).filter(|t| !t.is_empty()).map(str::to_string).collect()
                })
            })
            .unwrap_or_default()
    })
}

/// The LEVEL_WORDS word a wording asks with when it names no change (no CHANGE_WORDS word, no 从 before a 到): on a page
/// that draws the change, such a title asks what the page does not show.
pub fn level_question(text: &str) -> Option<&'static str> {
    let level = *LEVEL_WORDS.iter().find(|w| text.contains(**w))?;
    let from_to = text.find('从').is_some_and(|at| text[at..].contains('到'));
    (!from_to && !CHANGE_WORDS.iter().any(|w| text.contains(*w))).then_some(level)
}

/// The typed-number rule of the page text, the same as the design pack's claim-template check (newsroom.ts: "every number,
/// years included, must be a placeholder"), with one example; the request, the schema and the refusal all say it in these words.
pub const TYPED_NUMBER_RULE: &str =
    "type no number, years included: a year goes through a {placeholder} the draft holds, or is left out (write 各地的高低分布, not 2024年各地的高低分布)";
/// The number-word rule of the page text, with the examples it refuses.
pub const NUMBER_WORD_RULE: &str = "no number in words either (二十七, 两国, 三倍, 两成, 过半)";
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

/// The first secret in the serialized value or in any of its strings, a listed secret found anywhere coming before any
/// header: a listed secret with a quote or a backslash in it reads escaped in the serialized value and only unescaped in
/// its own string, after a header the serialized value shows, and the handed-over secret is the one kind the image review
/// stops on (next_run.rs leaf_vision), so it must never be reported as a header seen first.
pub fn secret_in(value: &Value, secrets: &[String]) -> Option<SecretKind> {
    let mut texts = Vec::new();
    strings_of(value, &mut texts);
    let whole = value.to_string();
    let all: Vec<&str> = std::iter::once(whole.as_str()).chain(texts).collect();
    let listed = |text: &&str| {
        secrets
            .iter()
            .any(|secret| !secret.is_empty() && listed_in(text, secret))
    };
    if all.iter().any(listed) {
        return Some(SecretKind::Handoff);
    }
    all.into_iter().find_map(|text| secret_in_text(text, secrets))
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

/// Every step's prompt ends naming the step value its answer gives, from the step registry the check reads (Ask::step,
/// the schema's one `step` enum value), never written by hand (stand-ins answered the image review with "image").
fn with_step_line(prompt: &str, step: &str) -> String {
    format!("{prompt}\nAnswer with step {step:?}.")
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
        self.ask_in(model, ask, prompt, images, false, cancel).await
    }

    /// ask_step_seeing without the run's history: each request of this step holds only this step's own messages (the prompt
    /// with its images and, after a refusal, the refused reply and what the program sent back), nothing asked or answered
    /// before it. The run's history still records the step as any other.
    pub async fn ask_step_alone(
        &mut self,
        model: &mut (dyn Asker + '_),
        ask: &Ask,
        prompt: &str,
        images: &[Value],
        cancel: &AtomicBool,
    ) -> Result<(String, Choice), Stop> {
        self.ask_in(model, ask, prompt, images, true, cancel).await
    }

    /// One step asked over the whole history, or with `alone` over this step's own messages only (ask_step_alone).
    async fn ask_in(
        &mut self,
        model: &mut (dyn Asker + '_),
        ask: &Ask,
        prompt: &str,
        images: &[Value],
        alone: bool,
        cancel: &AtomicBool,
    ) -> Result<(String, Choice), Stop> {
        let step = ask.step();
        self.parent = None;
        self.step_from = self.history.len();
        let mut content = text_content(&with_step_line(prompt, step));
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
            let sent = &self.history[if alone { self.step_from } else { 0 }..];
            let request = json!({
                "tools": [{"name": tool.name, "description": tool.description, "parameters": tool.parameters}],
                "history": sent,
            });
            let Some(mut reply) = model
                .ask(sent, std::slice::from_ref(&tool), cancel)
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
    /// Program events hang under `call_id` from here on, as under an accepted model answer of that id (a page refilled
    /// from a finished run hangs its events under that run's claims step, next_drive replay): it is the last accepted call
    /// too, so a later step refused in every round resumes under it as the run did (resume_under_last_accepted).
    #[cfg(test)]
    pub fn hang_under(&mut self, call_id: &str) {
        self.parent = Some(call_id.to_string());
        self.last_accepted = Some(call_id.to_string());
    }

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
/// The event that keeps the question's shape answer and the plan the knowledge group made of it (the blocks, each block's
/// relation, focus, quantity and years), whole; a 0 answer keeps the answer and no plan.
pub const PLAN_EVENT: &str = "next_answer_plan";
/// The event that keeps each block's table as the program set it (block_tables): the block's quantity and the table, or
/// null when no offered table holds it.
pub const BLOCK_TABLES_EVENT: &str = "next_block_tables";
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
    /// The first five tables for the Chinese question and the English search texts, with the scope and places it judged;
    /// `months` when the question asks for months (next_params::question_months), so a monthly-only table is offered as
    /// itself, not as its annual twin, and `latest_year` the latest year it names (next_params::question_latest_year), so
    /// one is not offered as an annual twin that ends before that year.
    fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking;
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
    /// The ranking the Chinese question asks for in place of named places (the most populous economies): the reference
    /// indicator and the count it writes, read by the knowledge group from the question's words; None when it asks for none.
    fn rank_asked(&self, _question_zh: &str) -> Option<RankAsked> {
        None
    }
    /// The whole class of question the knowledge group refuses from its words before any search (scope-refusal-zh.json, user
    /// 11-08 item 1); None when no class takes it.
    fn scope_refused(&self, _question_zh: &str, _this_year: i32) -> Option<crate::l5geo::ScopeRefusal> {
        None
    }
    /// The shape request of a question the scope refusal let through (the knowledge group's answer_plan, through its door);
    /// None when this catalogue reads none, and then no shape step is asked.
    fn split_ask(&self, _question_zh: &str) -> Option<crate::answer_plan::SplitAsk> {
        None
    }
    /// The plan of the question for a checked shape answer, the answer held once more against the request by the knowledge
    /// group (Err with its words when it does not hold); None when this catalogue reads none.
    fn answer_plan(
        &self,
        _question_zh: &str,
        _reply: &crate::answer_plan::SplitReply,
    ) -> Option<Result<crate::answer_plan::Plan, String>> {
        None
    }
    /// What a page drawn for the group the Chinese question names counts (the knowledge group's GroupBasis, through its
    /// door), from the page's first and last years, its place codes and those with a row at the last: the members of the
    /// year the page counts, the places to leave out and the words of the line that says so; None when the question names
    /// no group, or this catalogue reads none.
    fn group_basis(&self, _question_zh: &str, _years: (Option<i32>, i32), _places: (&[String], &[String])) -> Option<crate::l5geo::GroupBasis> {
        None
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
    /// The companions kept from the fetched rows of the main and of each fetched candidate, and each shortlisted candidate
    /// not kept with why.
    fn companions(
        &self,
        _main: &str,
        _rows: &BTreeMap<String, Vec<next_knowledge::CompanionRow>>,
    ) -> (Vec<next_knowledge::Companion>, Vec<(String, next_knowledge::DropWhy)>) {
        (Vec::new(), Vec::new())
    }
    /// Whether a table is a hub table (the knowledge group's hub_origin, through its door): `dims` holds each dimension's
    /// codes, `countries` and `aggregates` what Countries and Members say of them.
    fn hub_origin(
        &self,
        dims: &BTreeMap<String, BTreeSet<String>>,
        countries: &BTreeSet<String>,
        aggregates: &BTreeSet<String>,
    ) -> Result<next_knowledge::HubOrigin, next_knowledge::HubMiss> {
        hub_origin_call(&Mutex::new(Vec::new()), dims, countries, aggregates)
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
    /// A number knob's default from the leaf registry (next_visual's `call`, through its door); Err when it has none.
    fn knob(&self, node: &str, knob: &str) -> Result<f64, String> {
        knob_reply(visual_call(
            &Mutex::new(Vec::new()),
            "knob",
            next_visual::Request::Knob { node, knob },
        ))
    }
    /// The leaf registry's page recipes, in the order the flow tries them (next_visual's `call`, through its door).
    fn recipes(&self) -> &'static [crate::next_leaf::Recipe] {
        recipes_reply(visual_call(&Mutex::new(Vec::new()), "recipes", next_visual::Request::Recipes))
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
    /// The reviewed Chinese name of a catalogue table through the knowledge group's command (TableZh); none when it lists
    /// none, and the source line keeps the English title.
    fn table_zh(&self, id: &str) -> Result<Option<String>, String> {
        table_zh_reply(knowledge_call(&Mutex::new(Vec::new()), "table_zh", json!({"id": id}), next_knowledge::Request::TableZh { id }))
    }
    /// The ids of the quantities the Chinese question asks for once `table` is chosen, through the knowledge group's
    /// command (AskedBeside): the table's reviewed name said whole in the question is one quantity.
    fn asked_beside(&self, question: &str, table: &str) -> Result<Vec<String>, String> {
        asked_beside_reply(knowledge_call(
            &Mutex::new(Vec::new()),
            "asked_beside",
            json!({"question": question, "table": table}),
            next_knowledge::Request::AskedBeside { question, table },
        ))
    }
    /// The map point [lon, lat] of each code: its iso3 through the knowledge group's command (Iso3Of), then its point through
    /// the visual group's (PlacePoints), from the pinned Natural Earth attributes table only (NE_POINTS_SHA256); Err names the
    /// codes either step has nothing for, or a table that is not the pinned one.
    fn place_points(&self, codes: &[String]) -> Result<BTreeMap<String, [f64; 2]>, String> {
        place_points_call(&Mutex::new(Vec::new()), codes)
    }
    /// The iso3 code of each iso2 code by the knowledge group's name table (Iso3Of, through its door); a code it has none
    /// for is left out.
    fn iso3_of(&self, codes: &[String]) -> Result<BTreeMap<String, String>, String> {
        match knowledge_call(&Mutex::new(Vec::new()), "iso3_of", json!({"codes": codes}), next_knowledge::Request::Iso3Of { codes })? {
            next_knowledge::Reply::Iso3 { iso3, .. } => Ok(iso3),
            _ => unreachable!("the knowledge group answered iso3_of with another reply"),
        }
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

/// The sha256 of the Natural Earth attributes table a map point may come from (runtime/pi/assets/
/// naturalearth-admin0-50m-attributes.json, the bytes the visual group embeds): a point from any other table is refused,
/// so the points a page drew are the ones a replay of this table gives.
pub const NE_POINTS_SHA256: &str = "206fbe5e671c3c3f19db0709a7d85093ed935b2490b25b4d5b50a3c0a4120d1a";

/// Catalogue::place_points through the two group commands, kept in `calls`: the knowledge group says each code's iso3, the
/// visual group each iso3's point, and the points come back under the codes asked.
fn place_points_call(calls: &Mutex<Vec<Value>>, codes: &[String]) -> Result<BTreeMap<String, [f64; 2]>, String> {
    // a code with no iso3 is not in the map, so it is named with the codes that have no point
    let iso3_of = match knowledge_call(calls, "iso3_of", json!({"codes": codes}), next_knowledge::Request::Iso3Of { codes }) {
        Ok(next_knowledge::Reply::Iso3 { iso3, .. }) => iso3,
        Ok(_) => unreachable!("the knowledge group answered iso3_of with another reply"),
        Err(e) => return Err(e),
    };
    let iso3: Vec<String> = iso3_of.values().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let reply = visual_call(calls, "place_points", next_visual::Request::PlacePoints { iso3: &iso3 });
    place_points_reply(codes, &iso3_of, reply)
}

/// The words a refusal of the map points starts with when the table has no point for a code (an aggregate), the only
/// refusal a recipe on the map reads as not its shape (next_run on_the_map).
pub const NO_POINT: &str = "the map point table has no point for";

/// The visual group's points under the codes asked (`iso3_of`, the knowledge group's map), when the table it read them from
/// hashes to NE_POINTS_SHA256; a code with no iso3 or no point refuses by name, in the order asked.
fn place_points_reply(
    codes: &[String],
    iso3_of: &BTreeMap<String, String>,
    reply: Result<next_visual::Reply, String>,
) -> Result<BTreeMap<String, [f64; 2]>, String> {
    let (points, missing) = match reply {
        Ok(next_visual::Reply::Points { table, .. }) if crate::hash::sha256_bytes(table.as_bytes()) != NE_POINTS_SHA256 => {
            return Err(format!(
                "the map points come from a table of sha256 {}, not the pinned {NE_POINTS_SHA256}",
                crate::hash::sha256_bytes(table.as_bytes())
            ))
        }
        Ok(next_visual::Reply::Points { points, missing, .. }) => (points, missing),
        Ok(_) => unreachable!("the visual group answered place_points with another reply"),
        Err(e) => return Err(e),
    };
    let (mut found, mut none) = (BTreeMap::new(), Vec::<&str>::new());
    for code in codes.iter().map(|c| c.trim()) {
        match iso3_of.get(code).filter(|i| !missing.contains(i)).and_then(|i| points.get(i)) {
            Some(p) => {
                found.insert(code.to_string(), *p);
            }
            None if !none.contains(&code) => none.push(code),
            None => {}
        }
    }
    if none.is_empty() {
        Ok(found)
    } else {
        Err(format!("{NO_POINT} {}", none.join(", ")))
    }
}

fn asked_beside_reply(reply: Result<next_knowledge::Reply, String>) -> Result<Vec<String>, String> {
    match reply? {
        next_knowledge::Reply::AskedIds(ids) => Ok(ids),
        _ => unreachable!("the knowledge group answered asked_beside with another reply"),
    }
}

fn table_zh_reply(reply: Result<next_knowledge::Reply, String>) -> Result<Option<String>, String> {
    match reply? {
        next_knowledge::Reply::TableZh(name) => Ok(name),
        _ => unreachable!("the knowledge group answered table_zh with another reply"),
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

/// The knowledge group's hub_origin through its door, kept in `calls`.
fn hub_origin_call(
    calls: &Mutex<Vec<Value>>,
    dims: &BTreeMap<String, BTreeSet<String>>,
    countries: &BTreeSet<String>,
    aggregates: &BTreeSet<String>,
) -> Result<next_knowledge::HubOrigin, next_knowledge::HubMiss> {
    let request = next_knowledge::Request::HubOrigin { dims, countries, aggregates };
    let args = json!({"dims": dims, "countries": countries, "aggregates": aggregates});
    match knowledge_call(calls, "hub_origin", args, request) {
        Ok(next_knowledge::Reply::HubOrigin(found)) => found,
        Ok(_) => unreachable!("the knowledge group answered hub_origin with another reply"),
        Err(e) => unreachable!("the knowledge group refused hub_origin, which is pure: {e}"),
    }
}

/// One call of the knowledge group's command, as the system group's door for it (group_guard), timed and kept as a
/// `GROUP_CALL_EVENT` with the hashes of what was asked and what came back. A host tool's run is kept by door_run when it
/// ends, with its own time; the run itself is the program call's own events.
pub(crate) fn knowledge_call<'a>(
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
        Ok(Reply::GroupBasis(basis)) => json!(basis),
        Ok(Reply::Refs(_)) => json!({"refs": "opened"}),
        // A shape is not JSON; its debug text is kept, as the visual group's calls keep theirs.
        Ok(Reply::Shape(shape)) => json!({"shape": format!("{shape:?}")}),
        Ok(Reply::ZhNames { names, missing }) => json!({"names": names, "missing": missing}),
        Ok(Reply::TableZh(name)) => json!({"zh": name}),
        Ok(Reply::AskedIds(ids)) => json!({"asked": ids}),
        Ok(Reply::Iso3 { iso3, missing }) => json!({"iso3": iso3, "missing": missing}),
        Ok(Reply::RankAsked(asked)) => json!({"rank_asked": asked}),
        Ok(Reply::ScopeRefused(refused)) => json!({"scope_refused": refused}),
        Ok(Reply::SplitAsk(ask)) => json!({"shape_ask": ask}),
        Ok(Reply::AnswerPlan(Ok(plan))) => json!({"plan": plan}),
        Ok(Reply::AnswerPlan(Err(why))) => json!({"refused": why}),
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
        Ok(Reply::Companions(found, dropped)) => json!({"kept": format!("{found:?}"),
            "dropped": dropped.iter().map(|(t, why)| json!({"table": t, "why": why})).collect::<Vec<_>>()}),
        Ok(Reply::HubOrigin(found)) => json!(format!("{found:?}")),
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
        Request::Page { spec } => format!("{kind} {spec:?}"),
        Request::LeafPage { page } => format!("{kind} {} {:?}", page.frame, page.ledger),
        Request::Stack { title, pages } => format!("{kind} {title:?} {pages:?}"),
        Request::LeafFill { recipe, knobs, order, runtime, .. } => {
            format!("{kind} {recipe} {order:?} {} {}", knobs["spec"], runtime.display())
        }
        Request::BrowserCheck { html, html_sha256, .. } => format!("{kind} {} {html_sha256}", html.display()),
        Request::Knob { node, knob } => format!("{kind} {node}.{knob}"),
        Request::Recipes => kind.to_string(),
        Request::RecipeLayers { recipe } => format!("{kind} {recipe}"),
        Request::LeafRecheck { recipe, html, ledger, .. } => {
            format!("{kind} {recipe} {} {ledger:?}", crate::hash::sha256_bytes(html.as_bytes()))
        }
        Request::PlacePoints { iso3 } => format!("{kind} {iso3:?}"),
        Request::IllusStrip { tables, width, runtime } => format!("{kind} {tables:?} {width} {}", runtime.display()),
        Request::NodeDeclare { layer, page_in } => format!("{kind} {layer} {page_in}"),
        Request::NodeDraw { fill, page_in, layers, runtime } => format!("{kind} {layers:?} {fill} {page_in} {}", runtime.display()),
    };
    let node = match &request {
        Request::NodeDeclare { layer, .. } => Some(layer.to_string()),
        Request::NodeDraw { layers, .. } => Some(layers.join(",")),
        _ => None,
    };
    let started = std::time::Instant::now();
    let reply = crate::group_guard::as_visual_call(|| next_visual::call(request));
    let ms = started.elapsed().as_millis() as u64;
    let kept = match &reply {
        Err(e) => format!("error {e}"),
        Ok(Reply::Matched(matched)) => format!("{matched:?}"),
        Ok(Reply::Stacked(html)) => format!("stacked {}", crate::hash::sha256_bytes(html.as_bytes())),
        Ok(Reply::Plans(plans)) => format!(
            "{:?}",
            plans
                .iter()
                .map(|p| (p.relation, p.grammar, p.visual_grammar))
                .collect::<Vec<_>>()
        ),
        Ok(Reply::Page(page)) => format!("{} {:?}", page.html, page.ledger),
        Ok(Reply::Leaf(page)) => format!("{} {:?} {:?}", page.html, page.records, page.dropped),
        Ok(Reply::Filled(page)) => format!("{:?} {:?}", page.ledger, page.refs),
        Ok(Reply::Checked(report)) => report.to_string(),
        Ok(Reply::Knob { default, min, max }) => format!("{default} {min} {max}"),
        Ok(Reply::Recipes(recipes)) => recipes.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(" "),
        Ok(Reply::Layers(layers)) => format!("{layers:?}"),
        Ok(Reply::Rechecked(off)) => off.join("\n"),
        Ok(Reply::Points { points, missing, table }) => {
            format!("{points:?} {missing:?} {}", crate::hash::sha256_bytes(table.as_bytes()))
        }
        Ok(Reply::Strip { strip, note }) => format!("{} {note}", strip.as_ref().map_or("", |s| s.svg.as_str())),
        Ok(Reply::NodeDeclared(declared)) => format!("{declared:?}"),
        Ok(Reply::NodesDrawn(drawn)) => format!("{drawn:?}"),
    };
    let mut event = json!({"group": "visual", "request": kind,
        "request_sha256": crate::hash::sha256_bytes(asked.as_bytes()),
        "reply_sha256": crate::hash::sha256_bytes(kept.as_bytes()), "ms": ms, "ok": reply.is_ok()});
    // the strip is the page's only piece that may be left off: what was drawn, or why none, is kept in its own words
    match &reply {
        Ok(Reply::Strip { note, .. }) => event["note"] = json!(note),
        Err(why) if kind == "illus_strip" => event["note"] = json!(why),
        _ => {}
    }
    // an external node's call: which node, the child's and the core's milliseconds, and how many failure lines stopped it
    if let Some(node) = node {
        event["node"] = json!(node);
        let (child, recheck, failures) = match &reply {
            Ok(Reply::NodesDrawn(drawn)) => (
                json!(drawn.timing.iter().map(|t| t.1).sum::<u64>()),
                json!(drawn.timing.iter().map(|t| t.2).sum::<u64>()),
                0,
            ),
            Ok(_) => (Value::Null, Value::Null, 0),
            Err(why) => (Value::Null, Value::Null, why.lines().count()),
        };
        event["child_ms"] = child;
        event["recheck_ms"] = recheck;
        event["failures"] = json!(failures);
        // a layer left to its leaf, which refuses it before drawing (next_tree_gen leaf_stops), and by which rule
        if let Ok(Reply::NodesDrawn(drawn)) = &reply {
            let left: Vec<Value> = drawn.timing.iter().filter_map(|t| t.3.as_ref().map(|r| json!({"layer": t.0, "rule": r}))).collect();
            if !left.is_empty() {
                event["left_to_leaf"] = json!(left);
            }
        }
    }
    calls.lock().unwrap_or_else(|e| e.into_inner()).push(event);
    reply
}

/// What the page was checked against at its bake (spec, rows, facts, ledger, refs), written beside its index.html so the
/// completion gate (next_gate::leaf_gate) reruns the same check on the published bytes.
pub const LEAF_REQUEST: &str = "request.json";

/// A published leaf page: its HTML (run-folder relative) and the sha256 of the bytes written there, which the browser
/// check's PASS report and the manifest both name.
#[derive(Debug)]
pub struct Published {
    pub html_ref: String,
    pub html_sha256: String,
    /// What the layers dropped (next_ledger::dropped_entry: src, why), as kept in the request's ledger, for the run's event.
    pub dropped: Vec<(String, String)>,
    /// What the bake measured of the page's type (next_leaf::Baked), for the page checks; none, both of them fail.
    pub type_measured: Option<Value>,
    /// The radius scales the layers drew at (next_leaf Panel::scales: layer, r_used, r_steps, r_min_lifted, r_min_codes), for the run's event.
    pub scales: Vec<Value>,
    /// What the visual group's drawn check compared on each external layer (next_visual LeafDrawn), for the run's event.
    pub drawn_checked: Vec<Value>,
    /// Whether the page's h1 states a relation its checks read (next_visual LeafDrawn): the leaf's own headline.
    pub headed: bool,
}

/// The stacked page's file, beside the first block's page in its publication folder.
pub const STACKED_PAGE: &str = "stacked.html";

/// The stacked page of a many-block page (owner 11-14 20:5x item 1), written through the visual door as
/// publications/<first block's folder>/stacked.html: the visual group's Stack of the question and each block's published
/// page in block order (`blocks`: folder, width, height), the first on top, each page referred to and never changed, so
/// the stacked page holds no word or number its blocks' checks did not read. Refused when the file is there already.
/// Ok is its path from the run folder and its sha256.
pub fn publish_stack(
    calls: &Mutex<Vec<Value>>,
    root: &Path,
    question: &str,
    blocks: &[(String, f64, f64)],
) -> Result<(String, String), String> {
    use crate::group_guard::{as_visual_call, write};
    use next_visual::{Reply, Request};
    let Some((first, _, _)) = blocks.first() else {
        return Err("stack: no block page".into());
    };
    let pages: Vec<(String, f64, f64)> = blocks
        .iter()
        .enumerate()
        .map(|(i, (dir, w, h))| (if i == 0 { "index.html".to_string() } else { format!("../{dir}/index.html") }, *w, *h))
        .collect();
    let Reply::Stacked(html) = visual_call(calls, "stack", Request::Stack { title: question, pages: &pages })? else {
        unreachable!("the visual group answered stack with another reply")
    };
    let rel = format!("publications/{first}/{STACKED_PAGE}");
    if root.join(&rel).exists() {
        return Err(format!("stack: {rel} was written before"));
    }
    as_visual_call(|| write(root, &root.join(&rel), &html)).map_err(|e| format!("stack: {e}"))?;
    Ok((rel, crate::hash::sha256_bytes(html.as_bytes())))
}

/// The leaf page published at publications/<slug>/ of the run folder at `root`. The visual group draws and bakes it; its
/// bytes are hashed once and written as they are to index.html (what they were checked against beside it, LEAF_REQUEST), the visual group's browser check spec (QA_SPEC) beside the
/// report folder publications/qa/<slug>/; the visual group runs the check on that file, and only when it says the report is
/// a PASS for the same sha256 is the manifest written, which is what completion counts (artifact.rs
/// measured_publication_gap). Every write is the visual group's, inside its door (group_guard::as_visual_call): one refused
/// leaves no page and nothing after it runs. A FAIL, a PASS for other bytes or no report leaves the page and its report for
/// replay, with no manifest: not published. With the manifest the page's plan is written to publications/plans/<slug>.json
/// (the run's plans folder, the visual group's; verify reads a publication's plan there). A slug is written once: when
/// either folder or its plan is already there the page is refused before it is drawn, so no new bytes ever sit beside an
/// earlier report, manifest or plan. What a layer dropped (a note with no free place) does not stop the page: each item is
/// written into the request's ledger beside it as a never-printed entry (next_ledger::DROPPED_SRC) with why.
pub fn publish_leaf_page(
    calls: &Mutex<Vec<Value>>,
    root: &Path,
    slug: &str,
    (page, plan): (&next_visual::LeafPage<'_>, &Value),
    qa: &crate::next_leaf::Runner,
) -> Result<Published, String> {
    use crate::group_guard::{as_visual_call, create_dir_all, write};
    use next_visual::{Reply, Request};
    let named = !slug.is_empty() && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !named || matches!(slug, "plans" | "qa" | "rejected") {
        return Err(format!("publish: {slug:?} is not a publication folder name"));
    }
    let (dir, out) = (root.join("publications").join(slug), root.join("publications/qa").join(slug));
    let plan_file = root.join("publications/plans").join(format!("{slug}.json"));
    if dir.exists() || out.exists() || plan_file.exists() {
        return Err(format!("publish: publications/{slug} was written before; a page is published once, under a new name"));
    }
    let Reply::Leaf(drawn) = visual_call(calls, "leaf_page", Request::LeafPage { page })? else {
        unreachable!("the visual group answered a leaf page with another reply")
    };
    let html_sha256 = crate::hash::sha256_bytes(drawn.html.as_bytes());
    let html_ref = format!("publications/{slug}/index.html");
    let (spec, rows, facts) = page.facts;
    // what a layer dropped is kept with the request as never-printed entries, so a replay knows what the page leaves out
    let mut ledger = page.ledger.clone();
    ledger.extend(drawn.dropped.iter().cloned());
    // and the knobs its layers were given, from which the recheck reads what a reference layer draws
    let request = serde_json::to_string_pretty(&json!({"spec": spec, "rows": rows, "facts": facts, "ledger": ledger,
        "refs": page.refs, "knobs": drawn.knobs}))
    .map_err(|e| format!("publish: {e}"))?;
    let io = |e: std::io::Error| format!("publish: {e}");
    as_visual_call(|| {
        create_dir_all(root, &dir)?;
        write(root, &root.join(&html_ref), &drawn.html)?;
        write(root, &dir.join(LEAF_REQUEST), &request)?;
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
    let plan_text = serde_json::to_string_pretty(plan).map_err(|e| format!("publish: {e}"))? + "\n";
    as_visual_call(|| {
        create_dir_all(root, &root.join("publications/plans"))?;
        write(root, &plan_file, plan_text)?;
        write(root, &dir.join("manifest.json"), text)
    })
    .map_err(io)?;
    Ok(Published {
        html_ref,
        html_sha256,
        dropped: drawn.dropped,
        type_measured: drawn.type_measured,
        scales: drawn.scales,
        headed: drawn.headed,
        drawn_checked: drawn.drawn_checked,
    })
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

fn recipes_reply(reply: Result<next_visual::Reply, String>) -> &'static [crate::next_leaf::Recipe] {
    match reply {
        Ok(next_visual::Reply::Recipes(recipes)) => recipes,
        _ => unreachable!("the visual group answered recipes with another reply"),
    }
}

fn knob_reply(reply: Result<next_visual::Reply, String>) -> Result<f64, String> {
    match reply? {
        next_visual::Reply::Knob { default, .. } => Ok(default),
        _ => unreachable!("the visual group answered knob with another reply"),
    }
}

impl Catalogue for GroupCatalogue {
    fn data_prepare<'a>(&self, host: HostRun<'a>, args: Value) -> ToolFuture<'a> {
        data_prepare_run(&self.calls, host, args)
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

    fn hub_origin(
        &self,
        dims: &BTreeMap<String, BTreeSet<String>>,
        countries: &BTreeSet<String>,
        aggregates: &BTreeSet<String>,
    ) -> Result<next_knowledge::HubOrigin, next_knowledge::HubMiss> {
        hub_origin_call(&self.calls, dims, countries, aggregates)
    }

    fn companions(
        &self,
        main: &str,
        rows: &BTreeMap<String, Vec<next_knowledge::CompanionRow>>,
    ) -> (Vec<next_knowledge::Companion>, Vec<(String, next_knowledge::DropWhy)>) {
        let request = next_knowledge::Request::Companions {
            catalogue: &self.opened,
            main,
            rows,
        };
        let counts: BTreeMap<&String, usize> = rows.iter().map(|(id, r)| (id, r.len())).collect();
        match self.call("companions", json!({"main": main, "rows": counts}), request) {
            next_knowledge::Reply::Companions(found, dropped) => (found, dropped),
            _ => unreachable!("the knowledge group answered companions with another reply"),
        }
    }

    fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking {
        let request = next_knowledge::Request::Top5 {
            catalogue: &self.opened,
            question: question_zh,
            texts,
            months,
            latest_year,
            first_year,
        };
        // "months", "latest_year" and "first_year" only when set, so a call without them hashes as before.
        let mut args = json!({"question": question_zh, "texts": texts});
        if months {
            args["months"] = json!(true);
        }
        if let Some(year) = latest_year {
            args["latest_year"] = json!(year);
        }
        if let Some(year) = first_year {
            args["first_year"] = json!(year);
        }
        match self.call("top5", args, request) {
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

    fn scope_refused(&self, question_zh: &str, this_year: i32) -> Option<crate::l5geo::ScopeRefusal> {
        let request = next_knowledge::Request::ScopeRefused { question: question_zh, this_year };
        match self.call("scope_refused", json!({"question": question_zh, "this_year": this_year}), request) {
            next_knowledge::Reply::ScopeRefused(refused) => refused,
            _ => unreachable!("the knowledge group answered scope_refused with another reply"),
        }
    }

    fn split_ask(&self, question_zh: &str) -> Option<crate::answer_plan::SplitAsk> {
        let request = next_knowledge::Request::SplitAsk { catalogue: &self.opened, question: question_zh };
        match self.call("split_ask", json!({"question": question_zh}), request) {
            next_knowledge::Reply::SplitAsk(ask) => Some(ask),
            _ => unreachable!("the knowledge group answered shape_ask with another reply"),
        }
    }

    fn answer_plan(
        &self,
        question_zh: &str,
        reply: &crate::answer_plan::SplitReply,
    ) -> Option<Result<crate::answer_plan::Plan, String>> {
        let request = next_knowledge::Request::AnswerPlan { catalogue: &self.opened, question: question_zh, reply };
        match self.call("answer_plan", json!({"question": question_zh, "reply": reply}), request) {
            next_knowledge::Reply::AnswerPlan(plan) => Some(plan),
            _ => unreachable!("the knowledge group answered answer_plan with another reply"),
        }
    }

    fn rank_asked(&self, question_zh: &str) -> Option<RankAsked> {
        let request = next_knowledge::Request::RankAsked {
            question: question_zh,
        };
        match self.call("rank_asked", json!({"question": question_zh}), request) {
            next_knowledge::Reply::RankAsked(asked) => asked,
            _ => unreachable!("the knowledge group answered rank_asked with another reply"),
        }
    }

    fn group_basis(&self, question_zh: &str, years: (Option<i32>, i32), places: (&[String], &[String])) -> Option<crate::l5geo::GroupBasis> {
        let request = next_knowledge::Request::GroupBasis {
            catalogue: &self.opened,
            question: question_zh,
            years,
            places,
        };
        let args = json!({"question": question_zh, "t0": years.0, "t1": years.1, "places": places.0, "at_t1": places.1});
        match self.call("group_basis", args, request) {
            next_knowledge::Reply::GroupBasis(basis) => basis,
            _ => unreachable!("the knowledge group answered group_basis with another reply"),
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

    fn table_zh(&self, id: &str) -> Result<Option<String>, String> {
        table_zh_reply(knowledge_call(&self.calls, "table_zh", json!({"id": id}), next_knowledge::Request::TableZh { id }))
    }

    fn asked_beside(&self, question: &str, table: &str) -> Result<Vec<String>, String> {
        asked_beside_reply(knowledge_call(
            &self.calls,
            "asked_beside",
            json!({"question": question, "table": table}),
            next_knowledge::Request::AskedBeside { question, table },
        ))
    }

    fn place_points(&self, codes: &[String]) -> Result<BTreeMap<String, [f64; 2]>, String> {
        place_points_call(&self.calls, codes)
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

    fn knob(&self, node: &str, knob: &str) -> Result<f64, String> {
        knob_reply(visual_call(
            &self.calls,
            "knob",
            next_visual::Request::Knob { node, knob },
        ))
    }

    fn recipes(&self) -> &'static [crate::next_leaf::Recipe] {
        recipes_reply(visual_call(&self.calls, "recipes", next_visual::Request::Recipes))
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

/// The shape step (owner 11-14 16:5x item 2): asked of every question the scope refusal let through, when the catalogue
/// reads shapes; the answer and the knowledge group's plan of it are kept as a PLAN_EVENT. A 0 answer, or a catalogue
/// that reads none, gives None and the one-block flow goes on as before.
pub async fn split_step(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    question: &str,
    catalogue: &dyn Catalogue,
    cancel: &AtomicBool,
) -> Result<Option<crate::answer_plan::Plan>, Stop> {
    let Some(ask) = catalogue.split_ask(question) else {
        return Ok(None);
    };
    record_group_calls(recorder, catalogue)?;
    let prompt = format!(
        "Question: {question}\nWhich shape does the question take? A shape sets the page's blocks; answer 0 when none of them fits."
    );
    let reply = match recorder.ask_step(model, &Ask::Split { ask }, &prompt, cancel).await? {
        (_, Choice::Split { reply }) => reply,
        (_, other) => unreachable!("the split step was answered with {other:?}"),
    };
    if reply.number == 0 {
        recorder.program_event(PLAN_EVENT, json!({"reply": reply, "plan": null}))?;
        return Ok(None);
    }
    let plan = catalogue.answer_plan(question, &reply);
    record_group_calls(recorder, catalogue)?;
    match plan {
        None => Ok(None),
        Some(Err(why)) => Err(Stop::Exchange { step: "split", why: format!("the knowledge group refused the checked shape answer: {why}") }),
        Some(Ok(plan)) => {
            recorder.program_event(PLAN_EVENT, json!({"reply": reply, "plan": plan}))?;
            Ok(Some(plan))
        }
    }
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
    /// The quantities the catalogue read in the question (the ranking's asked, each with the offered tables that hold it),
    /// as recorded in the catalogue event; an empty array when it read none.
    pub asked: Value,
    /// The data relation the table step kept for the main table (table_relation): on the main table only, None on every
    /// other and when the answer gave none or it was dropped. The page step passes over a recipe that answers another.
    pub relation: Option<Relation>,
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

/// A tool result's words: its text parts, joined by a space.
fn words_of(called: &Called) -> String {
    called.content.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join(" ")
}

/// The start of a tool result's text, each address (http:// or https:// up to the next space) replaced by <address>.
fn reason(called: &Called) -> String {
    let said = words_of(called);
    let words: Vec<&str> = said
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
/// The event of a table pick asked again after its fetch came back with no row (prepare_claims): the dataset, its table
/// number, the answer, what the tool said and the refusal the model got back.
pub const REPICK_EVENT: &str = "next_table_repick";
/// The event of a table pick that gave its optional relation (prepare_claims, table_relation): the main table, the number
/// given and the relation kept by the table's shape (none when dropped). An answer with none records no such event.
pub const TABLE_RELATION_EVENT: &str = "next_table_relation";
/// The event of the companion stage (D8): the main table, each candidate the catalogue offered with its seconds and what
/// came of it (fetched, or why it was dropped), the companions kept with their role, and the stage's seconds.
pub const COMPANION_EVENT: &str = "next_companions";
/// The event of a companion whose picked claims did not register: the table and why. The companion is left off the page; the
/// page goes on with the main table and any other companion.
pub const COMPANION_PICKS_EVENT: &str = "next_companion_picks";
/// The event of a composition's second fetch (composition_fetch): the table, the dimension, the codes asked per group, the
/// places asked (the first fetch's countries with the largest total at the year, at most next_params::NARROW_TOP), the
/// year, the total code they were ranked by, how many countries were left out, and the file it gave.
pub const COMPOSITION_FETCH_EVENT: &str = "next_composition_fetch";
/// The mode newsroom_data_prepare answers a fetch the program marked sum_input with: rows kept as a file only.
pub const SUM_INPUT_MODE: &str = "sum_input";

/// The places a composition's second fetch asks past its bars (next_params::NARROW_TOP), the next by total: a place whose
/// groups do not add up to its total is left out of the bars and said, and the next takes its bar (next_run
/// the stacked100 declaration, node-bindings.json); more left out than these, a quarter of the bars, stops the page.
pub const COMPOSITION_RESERVE: usize = next_params::NARROW_TOP / 4;

/// The place dimension a composition ranks and asks its countries by.
const COMPOSITION_PLACE: &str = "geo";

/// The filter values a fetch's args ask dimension `dim` for (None when it asks no filter of it: every code).
fn asked_values(args: &Map<String, Value>, dim: &str) -> Option<Vec<String>> {
    let filter = args.get("filters")?.as_array()?.iter().find(|f| f["dimension"] == dim)?;
    filter["values"].as_array()?.iter().map(|v| v.as_str().map(str::to_string)).collect()
}

/// The dimension of a Eurostat main whose fetch asked for its total code alone and whose registry has composition groups,
/// with that total code and each group's input codes (next_params::group_inputs); None for any other fetch, and for one
/// whose place dimension asks one code only (a composition across places needs two or more).
fn composition_dim(main: &Prepared) -> Result<Option<(String, String, Vec<(String, Vec<String>)>)>, String> {
    if main.id.ends_with("@2") || asked_values(&main.args, COMPOSITION_PLACE).is_some_and(|v| v.len() < 2) {
        return Ok(None);
    }
    let dims: Vec<String> = main.args.get("filters").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|f| f["dimension"].as_str().map(str::to_string)).collect();
    for dim in dims {
        let total = next_params::parts(&main.id, &dim).into_iter().find(|p| p.level == next_params::PART_LEVELS[0]);
        let Some(total) = total.filter(|t| asked_values(&main.args, &dim).is_some_and(|v| v == [t.code.clone()])) else {
            continue;
        };
        let inputs = next_params::group_inputs(&main.id, &dim)?;
        if !inputs.is_empty() {
            return Ok(Some((dim, total.code, inputs)));
        }
    }
    Ok(None)
}

/// The second fetch of a composition, made by the program after the claims pick, never chosen by a model: when the main's
/// fetch asked a dimension with registered groups (next_params::group_inputs) for its total code alone, it asks the same
/// table for each group's input codes (official codes the table publishes, at most one level under the total in the
/// registry's tree), at the latest year any country holds a total at in the main's rows, for the countries with the largest
/// total there (next_params::NARROW_TOP of them and COMPOSITION_RESERVE more, largest first, a tie to code order; aggregates
/// are no country), marked
/// sum_input with the main's file and candidate sheet, so its rows become no candidate, sheet or claim (newsroom.ts
/// sumInputProblem). The first fetch is unchanged and carries every claim. None when the main is no such fetch: a World
/// Bank table, no dimension asked for its grouped total alone, or fewer than two countries with a total. Ok is the args and
/// the event's fields beside the file.
pub fn composition_fetch(
    main: &Prepared,
    rows: &[Value],
    catalogue: &dyn Catalogue,
) -> Result<Option<(Map<String, Value>, Value)>, String> {
    let Some((dim, total, inputs)) = composition_dim(main)? else {
        return Ok(None);
    };
    let filters: Vec<Value> = main.args.get("filters").and_then(Value::as_array).cloned().unwrap_or_default();
    let place = COMPOSITION_PLACE;
    let held: Vec<&Value> = rows
        .iter()
        .filter(|r| r["dims"][&dim] == total.as_str() && r["dims"][place].is_string())
        .filter(|r| r["value"].as_str().and_then(|v| v.parse::<f64>().ok()).is_some_and(f64::is_finite))
        .collect();
    let codes: Vec<String> =
        held.iter().filter_map(|r| r["dims"][place].as_str().map(str::to_string)).collect::<BTreeSet<_>>().into_iter().collect();
    let countries = catalogue.countries(&codes)?;
    let of_country = |r: &&&Value| r["dims"][place].as_str().is_some_and(|c| countries.iter().any(|k| k == c));
    let Some(year) = held.iter().filter(of_country).filter_map(|r| r["time"].as_str()).max().map(str::to_string) else {
        return Ok(None);
    };
    let mut ranked: Vec<(f64, String)> = held
        .iter()
        .filter(of_country)
        .filter(|r| r["time"] == year.as_str())
        .filter_map(|r| Some((r["value"].as_str()?.parse::<f64>().ok()?, r["dims"][place].as_str()?.to_string())))
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    if ranked.len() < 2 {
        return Ok(None);
    }
    let asked = next_params::NARROW_TOP + COMPOSITION_RESERVE;
    let left_out = ranked.len().saturating_sub(asked);
    let top: Vec<String> = ranked.into_iter().take(asked).map(|(_, c)| c).collect();
    let all: Vec<String> = inputs.iter().flat_map(|(_, c)| c.iter().cloned()).collect();
    let mut filters: Vec<Value> = filters.into_iter().filter(|f| f["dimension"] != dim.as_str() && f["dimension"] != place).collect();
    filters.push(json!({"dimension": dim, "values": all}));
    filters.push(json!({"dimension": place, "values": top}));
    let mut args = main.args.clone();
    for key in ["sheet", "picks", "narrow", "sum_year"] {
        args.remove(key);
    }
    args.insert("filters".into(), Value::Array(filters));
    let y: i64 = year.parse().map_err(|_| format!("{} has a total at {year}, not a year", main.id))?;
    args.insert("years".into(), json!({"start": y, "end": y}));
    args.insert("sum_input".into(), json!({"main": main.file, "sheet": main.sheet}));
    let event = json!({"table": main.id, "dim": dim, "groups": inputs, "places": top, "year": year, "ranked_by": total,
        "top": next_params::NARROW_TOP, "reserve": COMPOSITION_RESERVE, "left_out": left_out});
    Ok(Some((args, event)))
}

/// Tables one page takes, the main table's included (D8); a by-month twin of the main takes a place besides.
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
    let text = words_of(called);
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

/// Whether a failed fetch is the host's structured download timeout (evidence_gate.mjs DOWNLOAD_TIMEOUT: the request ran past the
/// download limit), which the host allows one identical retry; its refusal of a repeat (DOWNLOAD_TIMEOUT_REPEAT) is not one.
fn download_timed_out(called: &Called) -> bool {
    mode_of(called) == "failed"
        && words_of(called).contains(next_knowledge::DOWNLOAD_TIMEOUT_WORDS)
}

/// Further fetches a download timeout may take: one, the same request again (a cold request the source's cache answers after).
pub const DOWNLOAD_TIMEOUT_RETRIES: usize = 1;

/// newsroom_data_prepare with `args`, fetched again with the same args after each FETCH_RETRY_WAITS_MS wait while the source does not
/// answer, a download timeout at most DOWNLOAD_TIMEOUT_RETRIES times; one FETCH_RETRY_EVENT per further fetch. A source still not
/// answering stops as SourceUnreachable.
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
    let mut timeouts = 0;
    loop {
        let again = if download_timed_out(&called) {
            timeouts += 1;
            timeouts <= DOWNLOAD_TIMEOUT_RETRIES
        } else if let Some(again) = source_unreachable(&called) {
            again
        } else {
            break;
        };
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

/// A companion's fetch arguments: the main's years (with `months`, a monthly twin's: the years holding that many months
/// up to its last month, twin_years), and each of the main's filters on a dimension the companion also has,
/// fixed to the same codes in the companion's own code list; the main's cut the same way (a World Bank companion's
/// countries are its places). A World Bank main's countries go to a World Bank companion as they are (the catalogue lists
/// no dimension for either: the same codes in the same place dimension). None when one of them cannot be fixed (the
/// companion lists none of the main's codes, or lacks the main's place dimension): open, it would fetch every code of a
/// dimension the main fixed or cut, every place of the world where the main asked for some.
fn companion_args(
    main: &Map<String, Value>,
    cut: Option<&Cut>,
    table: &TableMeta,
    months: Option<i64>,
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
    let main_wb = main.get("provider").and_then(Value::as_str) == Some("worldbank");
    let place_dim = if main_wb { next_params::WB_PLACE_DIM } else { next_params::GEO_DIM };
    for filter in main
        .get("filters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let dim = filter["dimension"].as_str().unwrap_or("");
        if main_wb && table.worldbank && dim == place_dim {
            // the main's cut, when it cuts this dimension, is the narrower list and goes in below
            if cut.is_none_or(|c| c.dimension != dim) {
                filters.push(json!({"dimension": dim, "values": filter["values"].clone()}));
            }
            continue;
        }
        let Some((_, codes)) = table.dims.iter().find(|(d, _)| d == dim) else {
            if dim == place_dim {
                return None;
            }
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
    match months.and_then(|m| twin_years(table, m)) {
        Some(years) => {
            args.insert("years".into(), years);
        }
        None => {
            if let Some(years) = main.get("years") {
                args.insert("years".into(), years.clone());
            }
        }
    }
    Some(args)
}

/// The years a monthly table is fetched for to hold `months` months up to its last month (the catalogue's monthly span,
/// "2026M08"), that month counted; None when the catalogue gives it no monthly span.
fn twin_years(table: &TableMeta, months: i64) -> Option<Value> {
    let (_, _, last) = table.freqs.iter().find(|(f, _, _)| f == "M")?;
    let (y, m) = last.split_once('M')?;
    let (y, m): (i64, i64) = (y.parse().ok()?, m.parse().ok()?);
    let first = y * 12 + m - 1 - (months - 1);
    Some(json!({"start": first.div_euclid(12), "end": y}))
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
/// rows overlap the main's kept, at most `room` and a by-month twin (kept first). A candidate that cannot be fetched (a refusal or a queued answer is not
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
    twin_months: Option<i64>,
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
        // The main's window gives a monthly twin its own months (ring.months), not the main's years.
        let months = twin_months.filter(|_| candidate.grain == Some("M"));
        let args = meta
            .as_ref()
            .and_then(|m| companion_args(main_args, cut, m, months));
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
                    .and_then(|n| companion_args(n, cut, &meta, months))
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
            json!({"table": candidate.id, "adds": candidate.adds, "grain": candidate.grain, "months": months,
            "seconds": started.elapsed().as_secs_f64(),
            "outcome": outcome.err().unwrap_or_else(|| "fetched".into())}),
        );
    }
    let (mut kept, mut dropped) = catalogue.companions(main, &rows);
    record_group_calls(recorder, catalogue)?;
    let room = room + usize::from(kept.first().is_some_and(|c| c.grain.is_some()));
    dropped.extend(kept.drain(kept.len().min(room)..).map(|c| (c.id, next_knowledge::DropWhy::NoRoom)));
    recorder.program_event(
        COMPANION_EVENT,
        json!({"main": main, "cut": cut.map(|c| json!({"dimension": c.dimension, "codes": c.codes})), "tables": entries,
            "kept": kept.iter().map(|c| json!({"table": c.id, "role": companion_role(c),
                "overlap": {"countries": c.overlap.countries, "aggregates": c.overlap.aggregates, "year": c.overlap.year},
                "axis": format!("{:?}", c.axis)})).collect::<Vec<_>>(),
            "dropped": dropped.iter().map(|(t, why)| json!({"table": t, "why": why})).collect::<Vec<_>>(),
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

/// The window of a listed table whose years the program sets instead of the model (next_params::Draft::window): an annual
/// Eurostat table whose companion shortlist (knowledge group) has a monthly twin, for the answers whose fetch, as the places
/// fill it, fixes geo to one code that has members (the hub): every answer (no years item), or only some breakdowns when
/// no breakdown does not. Its years and the twin's months are the ring's knobs (visual group). None for any other table,
/// when the hub is the no-breakdown answer's but not every breakdown's, or when a knob cannot be read: the years item is
/// asked as before.
fn ring_window(
    draft: &next_params::Draft,
    n: usize,
    places: &[Place],
    this_year: i32,
    catalogue: &dyn Catalogue,
) -> Option<next_params::Window> {
    if draft.table.worldbank || draft.table.freq().ok()? != "A" {
        return None;
    }
    let geo_of = |picks: BTreeMap<String, usize>| -> Option<String> {
        let filled = next_params::fill(draft, n, &picks, places, this_year).ok()?;
        let geo = filled.args.get("filters")?.as_array()?.iter().find(|f| f["dimension"] == "geo")?;
        match geo["values"].as_array()?.as_slice() {
            [one] => one.as_str().map(String::from),
            _ => None,
        }
    };
    let plain = geo_of(BTreeMap::new());
    let splits: Vec<(&String, Option<String>)> = draft
        .breakdown
        .iter()
        .enumerate()
        .map(|(i, dim)| (dim, geo_of(BTreeMap::from([(format!("t{n}.breakdown"), i + 2)]))))
        .collect();
    let (hub, only) = match plain {
        Some(hub) if splits.iter().all(|(_, g)| g.as_ref() == Some(&hub)) => (hub, None),
        Some(_) => return None,
        None => {
            let hub = splits.iter().find_map(|(_, g)| g.clone())?;
            let only = splits.iter().filter(|(_, g)| g.as_ref() == Some(&hub)).map(|(d, _)| d.to_string()).collect();
            (hub, Some(only))
        }
    };
    catalogue.members(&hub).ok()?;
    let twin = catalogue
        .companion_shortlist(&draft.table.id)
        .into_iter()
        .find(|(c, _)| c.grain == Some("M"))?
        .0
        .id;
    Some(next_params::Window {
        years: catalogue.knob("ring", "years").ok()? as i32,
        months: catalogue.knob("ring", "months").ok()? as i64,
        hub,
        twin,
        only,
    })
}

/// The breakdown options of table `n` the table pick offers: for each, the years options whose fetch (next_params::predicted_shape)
/// has a shape the visual group's rank draws with a filled template (next_run::FILLED_TEMPLATES), a flow split with the flow
/// recipe's (next_run::FLOW_TEMPLATES). An option no years option
/// draws is taken out of the draft, so the items and the fill number the rest from 2 on; a table left with none has no
/// breakdown item. The event keeps the offered options and, for each left out, the shape and the reasons rank gave.
///
/// A split that takes the ring's window and draws with no filled template there (16 citizens over 5 years: more lines
/// than a line chart holds) is tried once more without the window, for years option 1: the fill's years for a table with
/// no window, the ones the question names, else the table's last year. When that draws (one varying dimension: a
/// ranking), the split is kept with years option 1 and leaves the window (window_without), so the answer is filled as
/// predicted; the offered option keeps both tries ("tried"). A split left out then keeps both in its "why", each marked
/// with the "window" it was tried in.
fn drawable_splits(
    draft: &mut next_params::Draft,
    n: usize,
    places: &[Place],
    this_year: i32,
    catalogue: &dyn Catalogue,
) -> (Vec<Split>, Value) {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    // The splits kept only without the window: they leave it once every split is tried.
    let mut unwindowed: Vec<String> = Vec::new();
    let additive = |code: &str| catalogue.unit_additive(code);
    // The fetch of split `i` with years option `y` under `draft`: Ok with its shape and the templates that draw it, Err with
    // its shape and the reasons rank gave (or the fill's error).
    let tried_years = |draft: &next_params::Draft, i: usize, y: usize| -> Result<Value, Value> {
        let picks = BTreeMap::from([
            (format!("t{n}.breakdown"), i + 2),
            (format!("t{n}.{}", next_params::YEARS_KEY), y),
        ]);
        match next_params::predicted_shape(draft, n, &picks, places, this_year, &additive) {
            Ok(shape) => {
                // a flow split is drawn by the flow recipe's sankey only; any other split by the filled templates
                let templates: &[&str] = if next_params::flow_split(&draft.breakdown[i]).is_some() {
                    &crate::next_run::FLOW_TEMPLATES
                } else {
                    &crate::next_run::FILLED_TEMPLATES
                };
                let matched = catalogue.rank(&shape, templates, &[]);
                let dims = shape.dims.iter().map(|d| json!([d.dim, d.members])).collect::<Vec<_>>();
                if matched.candidates.is_empty() {
                    Err(json!({"years": y, "shape": dims,
                        "rejected": matched.rejected.iter().map(|r| format!("{:?}: {}", r.relation, r.reason)).collect::<Vec<_>>()}))
                } else {
                    Ok(json!({"years": y, "shape": dims,
                        "drawn": matched.candidates.iter().map(|c| c.template()).collect::<Vec<_>>()}))
                }
            }
            Err(e) => Err(json!({"years": y, "error": e})),
        }
    };
    for (i, dim) in draft.breakdown.iter().enumerate() {
        let mut years = Vec::new();
        let mut why = Vec::new();
        // A split that takes the draft's window asks no years: its one fetch is tried, and when drawable it keeps no years options.
        let windowed = draft.window_for(Some(dim.as_str())).is_some();
        let tried = if windowed { 1 } else { next_params::YEARS_OPTIONS.len() };
        for y in 1..=tried {
            match tried_years(&*draft, i, y) {
                Ok(_) => years.push(y),
                Err(w) => why.push(w),
            }
        }
        let mut both = Value::Null;
        if windowed && years.is_empty() {
            for w in &mut why {
                w["window"] = json!("ring");
            }
            let window = draft.window.as_ref().expect("a windowed split has the draft's window");
            match window_without(window, std::slice::from_ref(dim)) {
                Ok(left) => {
                    let own = next_params::Draft { window: left, ..draft.clone() };
                    match tried_years(&own, i, 1) {
                        Ok(mut w) => {
                            w["window"] = json!("none");
                            both = json!([why[0], w]);
                            years.push(1);
                            unwindowed.push(dim.clone());
                        }
                        Err(mut w) => {
                            w["window"] = json!("none");
                            why.push(w);
                        }
                    }
                }
                Err(e) => why.push(json!({"years": 1, "window": "none", "error": e})),
            }
        }
        if years.is_empty() {
            dropped.push(json!({"dim": dim, "why": why}));
        } else {
            let in_window = !unwindowed.contains(dim);
            kept.push((dim.clone(), if windowed && in_window { Vec::new() } else { years }, both));
        }
    }
    let left = draft
        .window
        .as_ref()
        .filter(|_| !unwindowed.is_empty())
        .map(|w| window_without(w, &unwindowed));
    if let Some(Ok(left)) = left {
        draft.window = left;
    }
    draft.breakdown = kept.iter().map(|(dim, _, _)| dim.clone()).collect();
    let mut offered = Vec::new();
    let splits: Vec<Split> = kept
        .into_iter()
        .enumerate()
        .map(|(i, (dim, years, both))| {
            let split = Split {
                option: i + 2,
                // a flow split's two dimensions: either one a member item
                member: next_params::split_dims(&dim).iter().any(|d| draft.members.iter().any(|(m, _, _)| m == d)),
                dim,
                years,
            };
            let mut entry = json!({"option": split.option, "dim": split.dim, "years": split.years, "member": split.member});
            if !both.is_null() {
                entry["tried"] = both;
            }
            offered.push(entry);
            split
        })
        .collect();
    (splits, json!({"offered": offered, "dropped": dropped}))
}

/// The window with the breakdowns `dims` left out of it, so their answers take the years the fill gives a table with no
/// window; None when no answer is left to take it. Err when every answer takes the window (`only` is None): a Window
/// cannot leave one split out and keep the no-breakdown answer in, so such a split keeps the ring's years.
fn window_without(
    window: &next_params::Window,
    dims: &[String],
) -> Result<Option<next_params::Window>, String> {
    let Some(only) = &window.only else {
        return Err("every answer of this table takes the ring's years, so a split cannot leave them".into());
    };
    let left: Vec<String> = only.iter().filter(|d| !dims.contains(*d)).cloned().collect();
    Ok((!left.is_empty()).then(|| next_params::Window {
        only: Some(left),
        ..window.clone()
    }))
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
            window: filled.window,
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
/// picked table with no step there stops as not wired. The flow runs prepare_planned; this is its tests' entry.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn prepare_claims<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    tools: &mut R,
    question: &str,
    steps: &[PrepareStep],
    catalogue: &dyn Catalogue,
    cancel: &AtomicBool,
) -> Result<Vec<Prepared>, Stop> {
    Ok(prepare_planned(recorder, model, tools, question, steps, catalogue, cancel).await?.prepared)
}

/// What prepare_planned gives: the prepared tables, the question's plan when the split step gave one, and the table of each
/// block the program set (block_tables; empty when it set none), in block order.
pub struct Planned {
    pub prepared: Vec<Prepared>,
    pub plan: Option<crate::answer_plan::Plan>,
    pub block_tables: Vec<String>,
}

/// prepare_claims with the question's plan, when the split step gave one (owner 11-14 16:5x item 2): for a plan whose
/// blocks each take their own quantity (名次对照), the program sets each block's table, the first offered table that holds
/// the block's quantity (block_tables), and only those are offered, in block order, the model picking all of them.
pub async fn prepare_planned<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    model: &mut (dyn Asker + '_),
    tools: &mut R,
    question: &str,
    steps: &[PrepareStep],
    catalogue: &dyn Catalogue,
    cancel: &AtomicBool,
) -> Result<Planned, Stop> {
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
    // a whole class the new route cannot answer, read by the knowledge group from the question's words (user 11-08 item 1):
    // stopped before the catalogue is searched, nothing searched or fetched; the group's call is recorded under the search
    // answer, as every group call follows a model answer (the program never calls on its own, Stop::NoModelParent)
    if steps.is_empty() {
        let refused = catalogue.scope_refused(question, chrono::Datelike::year(&chrono::Local::now()));
        record_group_calls(recorder, catalogue)?;
        if let Some(r) = refused {
            return Err(Stop::NoTable(format!("the question is out of scope ({}, \"{}\"): {}", r.class, r.hit, r.reason_zh)));
        }
    }
    let plan = if steps.is_empty() { split_step(recorder, model, question, catalogue, cancel).await? } else { None };
    // The search words go to the catalogue and into this event only: no later prompt, fetch or page reads them.
    let texts = vec![query];
    let this_year = chrono::Datelike::year(&chrono::Local::now());
    let ranking = catalogue.top5(
        question,
        &texts,
        next_params::question_months(question),
        next_params::question_latest_year(question, this_year),
        next_params::question_first_year(question, this_year),
    );
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
    if let Some(unread) = &ranking.unread {
        return Err(Stop::NoTable(format!(
            "the question asks for {} places as \"{}\", and the program reads {} of them from it",
            unread.asked, unread.word_zh, unread.read
        )));
    }
    let mut offers = ranking.candidates;
    offers.truncate(OFFERED_TABLES);
    if offers.is_empty() {
        return Err(Stop::NoTable("the catalogue offers no table".into()));
    }
    // each block of a plan that names its own quantity per block gets its table from the program; a block whose quantity
    // no offered table holds is left out and kept as such (the page answers part of the question)
    let blocks = plan
        .as_ref()
        .and_then(|p| block_tables(p, &ranking.asked))
        .filter(|blocks| blocks.iter().any(|(_, t)| t.as_ref().is_some_and(|t| offers.iter().any(|o| &o.id == t))));
    if let Some(blocks) = &blocks {
        recorder.program_event(
            BLOCK_TABLES_EVENT,
            json!({"blocks": blocks.iter().map(|(q, t)| json!({"quantity": q, "table": t})).collect::<Vec<_>>()}),
        )?;
        // a table two blocks share is offered once, at the first of them
        let mut order: Vec<&String> = Vec::new();
        for t in blocks.iter().filter_map(|(_, t)| t.as_ref()) {
            if !order.contains(&t) {
                order.push(t);
            }
        }
        offers = order.iter().filter_map(|id| offers.iter().find(|o| &&o.id == id).cloned()).collect();
    }
    // With no spec, each listed table's fetch parameters are drafted from the catalogue before the pick, from the codes its
    // held-series probe found (no fetch).
    let places = if steps.is_empty() {
        catalogue.places(question)
    } else {
        Vec::new()
    };
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
    // A ranking the question asks for (the ten most populous economies) fixes which economies a table with every country
    // open keeps: the program's pick, from the question's words, not the model's.
    let rank_asked = if steps.is_empty() {
        catalogue.rank_asked(question)
    } else {
        None
    };
    record_group_calls(recorder, catalogue)?;
    for (i, (_, d)) in drafts.iter_mut().enumerate() {
        if let Some(d) = d.as_mut() {
            d.window = ring_window(d, i + 1, &places, this_year, catalogue);
            d.named_years = next_params::question_years(question, this_year);
            d.ranked = rank_asked.clone();
        }
    }
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
        // under a table whose registry has composition groups, what each place's total splits into (every question)
        listed.extend(next_params::parts_line(i + 1, &t.id));
    }
    let most = if blocks.is_some() { offers.len() } else { steps.len().clamp(1, offers.len()) };
    let params_rule = if items.is_empty() {
        ""
    } else {
        "\nFor each picked table also give params: for each of its items t<n>.<item>, the number of the option that fits the question."
    };
    let pick_rule = if blocks.is_some() {
        format!("The page has {most} blocks and the program set one table for each, listed in block order: pick all {most} of them.")
    } else {
        format!("Pick the table, or up to {most} tables, that answer the question; 0 if none fits.")
    };
    let prompt = format!(
        "Question: {question}\nTables:\n{}\n{pick_rule}{params_rule}\nrelation ({})",
        listed.join("\n"),
        relation_rule()
    );
    let mut ask = Ask::Table {
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
                    empty: Vec::new(),
                })
            })
            .collect(),
    };
    // A fetch of no row from an answer the pick filled is refused once as a combination with no series is before the fetch
    // (held_refused, with that answer among the table's empty ones) and the pick is asked again; a second fetch of no row,
    // or one with no other answer to offer, stops as before.
    let asked = prompt;
    let mut prompt = asked.clone();
    let mut repicked = false;
    let (mut tables, main_file, main_narrowed, main_window, cut, kept_relation) = 'pick: loop {
        let (picks, params, relation) = match recorder.ask_step(model, &ask, &prompt, cancel).await? {
            (_, Choice::Table { picks, params, relation }) => (picks, params, relation),
            (_, other) => unreachable!("the table step was answered with {other:?}"),
        };
        if picks.is_empty() {
            return Err(Stop::NoTable(
                "the model answered that none of the listed tables fits".into(),
            ));
        }
        let ids: Vec<&String> = picks.iter().map(|n| &offers[n - 1].id).collect();
        // an answer's relation, kept or dropped by the main table's shape, for the run's record (the claims step here asks no
        // relation); an answer with none records nothing
        // and kept on the main table's Prepared, where the page step passes over a recipe that answers another relation
        let kept_relation = table_relation(relation, ids[0]);
        if relation.is_some() {
            let kept = kept_relation.map(|r| format!("{r:?}"));
            recorder.program_event(TABLE_RELATION_EVENT, json!({"table": ids[0], "relation": relation, "kept": kept}))?;
        }
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
        let mut main_window: Option<next_params::Window> = None;
        let mut cut: Option<Cut> = None;
        for (k, (id, step)) in chosen.into_iter().enumerate() {
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
                    if mode == "no_rows" && steps.is_empty() && !repicked {
                        let n = picks[k];
                        let draft = drafts[n - 1].1.as_ref();
                        if let Some(refused) = no_rows_refused(&mut ask, n, &params, draft, &places, this_year) {
                            repicked = true;
                            recorder.program_event(
                                REPICK_EVENT,
                                json!({"dataset": id, "table": n, "params": params, "why": reason(&called), "refused": refused.problem}),
                            )?;
                            prompt = format!("The table pick was fetched and refused: {}\n{asked}", refused.message());
                            continue 'pick;
                        }
                    }
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
                main_window = step.window.clone();
                cut = main_cut(&args, called.details.as_ref());
                main_file = called
                    .details
                    .as_ref()
                    .and_then(|d| d["filePath"].as_str())
                    .map(String::from);
            }
            tables.push((id.clone(), args, key, candidates));
        }
        break 'pick (tables, main_file, main_narrowed, main_window, cut, kept_relation);
    };
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
            main_window.as_ref().map(|w| w.months),
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
            asked: json!(ranking.asked),
            relation: if prepared.is_empty() { kept_relation } else { None },
            companions: if prepared.is_empty() {
                std::mem::take(&mut companion_files)
            } else {
                Vec::new()
            },
        });
    }
    if let Some(main) = prepared.first_mut() {
        composition_inputs(recorder, tools, catalogue, main, cancel).await?;
    }
    let block_tables = blocks.iter().flatten().filter_map(|(_, t)| t.clone()).fold(Vec::new(), |mut seen, t| {
        if !seen.contains(&t) {
            seen.push(t);
        }
        seen
    });
    Ok(Planned { prepared, plan, block_tables })
}

/// The table of each block of a plan whose blocks each take their own quantity (名次对照: two or more blocks, no quantity
/// twice), in block order: the block's quantity id and the first offered table that holds it (Ranking::asked, best first),
/// None when no offered table does. None for any other plan: its blocks share the table the model picks.
fn block_tables(plan: &crate::answer_plan::Plan, asked: &[crate::l5geo::Asked]) -> Option<Vec<(String, Option<String>)>> {
    let ids: Vec<&String> = plan.blocks.iter().filter_map(|b| b.quantity.first().map(|(id, _)| id)).collect();
    let distinct: BTreeSet<&&String> = ids.iter().collect();
    if ids.len() < 2 || ids.len() != plan.blocks.len() || distinct.len() != ids.len() {
        return None;
    }
    Some(ids.into_iter().map(|id| (id.clone(), asked.iter().find(|a| &a.id == id).and_then(|a| a.offered.first().cloned()))).collect())
}

/// The composition's second fetch (composition_fetch) of the main, when it is one: fetched by the program, its file kept
/// among the main's companions under the main's own id (a companion of the table itself is its sum inputs, read by the
/// composition only: next_run sum_inputs), one COMPOSITION_FETCH_EVENT. A fetch that answers anything but SUM_INPUT_MODE
/// stops the run as not prepared; nothing is fetched in its place.
async fn composition_inputs<R: ToolRunner + Send + ?Sized>(
    recorder: &mut Recorder<'_>,
    tools: &mut R,
    catalogue: &dyn Catalogue,
    main: &mut Prepared,
    cancel: &AtomicBool,
) -> Result<(), Stop> {
    let not_prepared = |why: String| Stop::NotPrepared { dataset: main.id.clone(), mode: SUM_INPUT_MODE.into(), why };
    // a fetch that asks no grouped total alone, across places, asks for no second fetch and reads no file for it
    if composition_dim(main).map_err(not_prepared)?.is_none() {
        return Ok(());
    }
    let meta = catalogue.table(&main.id).ok_or_else(|| not_prepared(format!("the catalogue lists no {}", main.id)))?;
    let csv = std::fs::read_to_string(recorder.run_dir.join(&main.file))
        .map_err(|e| not_prepared(format!("the fetched file {}: {e}", main.file)))?;
    let rows = catalogue.series_rows(&meta, &csv).map_err(not_prepared)?;
    let fetch = composition_fetch(main, &rows, catalogue).map_err(not_prepared);
    record_group_calls(recorder, catalogue)?;
    let Some((args, mut event)) = fetch? else {
        return Ok(());
    };
    let called = prepare_fetch(recorder, tools, catalogue, &main.id, &args, cancel).await?;
    let (mode, file) = (mode_of(&called), called.details.as_ref().and_then(|d| d["filePath"].as_str()).map(String::from));
    let (true, Some(file)) = (mode == SUM_INPUT_MODE, file) else {
        return Err(Stop::NotPrepared { dataset: main.id.clone(), mode, why: reason(&called) });
    };
    event["file"] = json!(file);
    recorder.program_event(COMPOSITION_FETCH_EVENT, event)?;
    main.companions.push((main.id.clone(), file));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the program says a part cannot be answered (user 11-05 10:2x): the word list catches a model's wording, and
    /// leaves a chart's reading words (a map's 灰色是没有数据) and the drafted fields alone.
    #[test]
    fn a_wording_that_says_a_part_cannot_be_answered_is_found() {
        assert_eq!(unanswered_word("失业率这一半答不了"), Some("答不了".to_string()));
        assert_eq!(unanswered_word("目录里没有这张表"), Some("目录里没有".to_string()));
        assert_eq!(unanswered_word("暂时无法回答"), Some("无法回答".to_string()));
        assert_eq!(unanswered_word("读图：颜色越深，数值越高，灰色是没有数据。"), None);
        assert_eq!(unanswered_word("{first.name}居首"), None);
    }
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

    /// The pinned table's hash is the vendored file's own, recomputed here, and the file says the geometry beside it is the
    /// vendored geometry's bytes (checked, not taken on its word); the points come back under the codes asked (EL is Greece's
    /// through the knowledge group's iso3), a code either group has nothing for refuses by name, and a reply from any other
    /// table refuses whatever points it holds.
    #[test]
    fn map_points_come_from_the_pinned_natural_earth_table_only() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/pi/assets");
        let file = std::fs::read(dir.join("naturalearth-admin0-50m-attributes.json")).unwrap();
        assert_eq!(NE_POINTS_SHA256, crate::hash::sha256_bytes(&file));
        let said: Value = serde_json::from_slice(&file).unwrap();
        let geometry = std::fs::read(dir.join("naturalearth-admin0-50m.geojson")).unwrap();
        assert_eq!(said["vendored_geometry"]["content_hash"], crate::hash::sha256_bytes(&geometry));
        let codes: Vec<String> = ["SE", "EL", "DE", "DEU"].iter().map(|c| c.to_string()).collect();
        let fake = FakeCatalogue { candidates: Vec::new(), uncovered: None, source: Value::Null, searched: Default::default() };
        let calls = Mutex::new(Vec::new());
        let points = place_points_call(&calls, &codes).unwrap();
        assert_eq!(points.keys().collect::<Vec<_>>(), ["DE", "DEU", "EL", "SE"]);
        assert_eq!(points["EL"], [21.72568, 39.492763]);
        assert_eq!(points["DE"], points["DEU"]);
        // one call through each group's door, the knowledge group's first
        let asked: Vec<(String, String)> = calls.lock().unwrap().iter().map(|e| (e["group"].as_str().unwrap().to_string(), e["request"].as_str().unwrap().to_string())).collect();
        assert_eq!(asked, [("knowledge".to_string(), "iso3_of".to_string()), ("visual".to_string(), "place_points".to_string())]);
        assert_eq!(fake.place_points(&["EU27_2020".to_string()]).unwrap_err(), "the map point table has no point for EU27_2020");
        let some: Vec<String> = ["XX", "DE", "WLD", "EU27_2020"].iter().map(|c| c.to_string()).collect();
        assert_eq!(fake.place_points(&some).unwrap_err(), "the map point table has no point for XX, WLD, EU27_2020");
        let iso3_of = BTreeMap::from([("SE".to_string(), "SWE".to_string())]);
        let other = next_visual::Reply::Points { points: BTreeMap::from([("SWE".to_string(), [18.0, 60.0])]), missing: Vec::new(), table: "{}" };
        assert!(place_points_reply(&codes[..1], &iso3_of, Ok(other)).unwrap_err().contains("not the pinned"));
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
            changes: Vec::new(),
            levels: Vec::new(),
            scoped: Vec::new(),
            titles: Vec::new(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
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
                relation: None,
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

    /// q2's flow split (siec>nrg_bal) fills both dimensions with their registered leaves, so the member item t1.nrg_bal was
    /// asked and its answer ignored by the fill: a wasted answer. It is left out with the flow picked, and refused with the
    /// allowed values and an example when given; with no split, or nrg_bal's own split, the items are as before.
    #[test]
    fn a_picked_flow_split_leaves_out_the_member_items_of_both_its_dimensions() {
        let ask = Ask::Table {
            count: 1,
            most: 1,
            items: vec![vec![("t1.breakdown".into(), 4), ("t1.nrg_bal".into(), 5)]],
            splits: vec![vec![
                Split { option: 2, dim: "nrg_bal".into(), years: vec![1, 2], member: true },
                Split { option: 3, dim: "siec".into(), years: vec![1, 2], member: false },
                Split { option: 4, dim: "siec>nrg_bal".into(), years: vec![1], member: true },
            ]],
            held: Vec::new(),
        };
        let given = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 4, "t1.nrg_bal": 2}})).unwrap_err();
        assert_eq!(
            given.problem,
            "t1.breakdown 4 (siec>nrg_bal) takes the registered nrg_bal leaves, so t1.nrg_bal has no place: leave it out, or keep it and set t1.breakdown 1"
        );
        assert_eq!(given.allowed["params"], json!({"t1.breakdown": 4}));
        assert_eq!(given.example, json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 1, "t1.nrg_bal": 1}}));
        // left out, the program gives the flow's years (the latest only)
        assert_eq!(
            ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 4}})),
            Ok(Choice::Table { relation: None, picks: vec![1], params: BTreeMap::from([("t1.breakdown".into(), 4), ("t1.years".into(), 1)]) })
        );
        // the split by siec alone takes no member item: t1.nrg_bal is still asked
        let missing = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 3}})).unwrap_err();
        assert_eq!(missing.problem, "params needs item 't1.nrg_bal' as one of its option numbers 1 to 5");
        assert!(ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 1, "t1.nrg_bal": 3}})).is_ok());
        let own = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 2, "t1.nrg_bal": 3}})).unwrap_err();
        assert!(own.problem.starts_with("t1.breakdown 2 (nrg_bal) takes every nrg_bal code"), "{}", own.problem);
    }

    #[test]
    fn an_annual_table_s_split_that_draws_only_with_the_latest_year_gets_it_from_the_program() {
        // the same table annual: no years item; a split that draws only with the latest year takes it, one that draws with
        // ten years and no split take none (next_params fills the last ten)
        let ask = |years: Vec<usize>| Ask::Table {
            count: 1,
            most: 1,
            items: vec![vec![("t1.breakdown".into(), 2), ("t1.nrg_bal".into(), 4)]],
            splits: vec![vec![Split { option: 2, dim: "nrg_bal".into(), years, member: true }]],
            held: Vec::new(),
        };
        let split = json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 2}});
        assert_eq!(
            ask(vec![1]).check(&split).unwrap(),
            Choice::Table { relation: None, picks: vec![1], params: BTreeMap::from([("t1.breakdown".into(), 2), ("t1.years".into(), 1)]) }
        );
        assert_eq!(
            ask(vec![1, 2]).check(&split).unwrap(),
            Choice::Table { relation: None, picks: vec![1], params: BTreeMap::from([("t1.breakdown".into(), 2)]) }
        );
        let none = json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 1, "t1.nrg_bal": 1}});
        assert_eq!(
            ask(vec![1]).check(&none).unwrap(),
            Choice::Table { relation: None, picks: vec![1], params: BTreeMap::from([("t1.breakdown".into(), 1), ("t1.nrg_bal".into(), 1)]) }
        );
        // the model's years for it is no item
        let years = json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 2, "t1.years": 1}});
        assert_eq!(ask(vec![1]).check(&years).unwrap_err().problem, "params has no item 't1.years' among the items of the picked tables");
    }

    #[test]
    fn a_picked_split_that_takes_the_ring_s_years_leaves_the_years_item_out() {
        // q6's shape: t1.breakdown 2 (citizen) fills geo with the hub and takes the ring's years (no years options);
        // breakdown 1 fetches the members and keeps the years item.
        let ask = Ask::Table {
            count: 1,
            most: 1,
            items: vec![vec![("t1.years".into(), 2), ("t1.breakdown".into(), 2)]],
            splits: vec![vec![Split { option: 2, dim: "citizen".into(), years: Vec::new(), member: false }]],
            held: Vec::new(),
        };
        let given = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 1, "t1.breakdown": 2}})).unwrap_err();
        assert_eq!(
            given.problem,
            "t1.breakdown 2 (citizen) takes the ring's years, so t1.years has no place: leave it out, or set another t1.breakdown"
        );
        assert_eq!(given.allowed["params"], json!({"t1.breakdown": 2}));
        assert_eq!(
            ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 2}})),
            Ok(Choice::Table { relation: None, picks: vec![1], params: BTreeMap::from([("t1.breakdown".into(), 2)]) })
        );
        assert_eq!(
            ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.years": 2, "t1.breakdown": 1}})),
            Ok(Choice::Table { relation: None, picks: vec![1], params: BTreeMap::from([("t1.breakdown".into(), 1), ("t1.years".into(), 2)]) })
        );
        let missing = ask.check(&json!({"step": "table", "pick": [1], "params": {"t1.breakdown": 1}})).unwrap_err();
        assert_eq!(missing.problem, "params needs item 't1.years' as one of its option numbers 1 to 2");
    }

    #[test]
    fn table_params_give_every_item_of_the_picked_tables() {
        let ask = two_tables_with_items();
        assert_eq!(
            ask.check(
                &json!({"step": "table", "pick": [2], "params": {"t2.years": 2, "t2.breakdown": 3}})
            ),
            Ok(Choice::Table {
                relation: None,
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
                relation: None,
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
                relation: None,
                picks: vec![],
                params: BTreeMap::new()
            })
        );
        assert_eq!(
            one.check(&json!({"step": "table", "pick": [5]})),
            Ok(Choice::Table {
                relation: None,
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
                relation: None,
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

    /// Every step's prompt ends with the step value the check takes, read from the same registry (Ask::step, the schema's
    /// enum), so the step name is never hand-written; an answer with another name ("image") is still refused.
    #[test]
    fn every_prompt_names_the_step_the_check_takes() {
        for ask in [Ask::Search, Ask::Vision] {
            let step = ask.schema()["properties"]["step"]["enum"][0].as_str().unwrap().to_string();
            assert_eq!(step, ask.step());
            assert!(with_step_line("p", ask.step()).ends_with(&format!("\nAnswer with step \"{step}\".")));
        }
        let refused = Ask::Vision.check(&json!({"step": "image", "answers": {}})).unwrap_err();
        assert_eq!(refused.problem, "step must be \"vision\"");
    }

    /// The image review's answer, read strictly: every question yes; a no with its one-line reason; anything else on a
    /// question (no such answer, a near-yes, a no without a one-line reason, another key) is that question unanswered,
    /// never a yes. Only the reply's frame is refused: no answers object, or a question id that is not one of the six.
    #[test]
    fn the_image_review_reads_each_question_yes_no_or_unanswered() {
        let reply = |answers: Vec<(&str, Value)>| {
            json!({"step": "vision", "answers": answers.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Map<_, _>>()})
        };
        let ids: Vec<&str> = VISION_QUESTIONS.iter().map(|(id, _)| *id).collect();
        let all_yes = || ids.iter().map(|id| (*id, json!({"answer": "yes"}))).collect::<Vec<_>>();
        let verdicts = |args: &Value| match Ask::Vision.check(args) {
            Ok(Choice::Vision { answers }) => answers,
            other => panic!("expected a vision choice, got {other:?}"),
        };
        let got = verdicts(&reply(all_yes()));
        assert_eq!(got.iter().map(|(id, _)| *id).collect::<Vec<_>>(), ids);
        assert!(got.iter().all(|(_, v)| *v == Verdict::Yes), "{got:?}");
        // a no with its reason, trimmed
        let mut answers = all_yes();
        answers[3].1 = json!({"answer": "no", "reason": " the red dots have no legend entry "});
        let got = verdicts(&reply(answers));
        assert_eq!(got[3], ("legend_matches_marks", Verdict::No { reason: "the red dots have no legend entry".into() }));
        assert_eq!(got.iter().filter(|(_, v)| *v == Verdict::Yes).count(), 5);
        // malformed answers: each of them unanswered, the rest read as given
        let long = "x".repeat(VISION_TEXT_MAX + 1);
        for bad in [
            json!("yes"),
            json!({"answer": "Yes"}),
            json!({"answer": "yes "}),
            json!({"answer": true}),
            json!({"answer": "maybe"}),
            json!({}),
            json!({"answer": "no"}),
            json!({"answer": "no", "reason": "  "}),
            json!({"answer": "no", "reason": "two\nlines"}),
            json!({"answer": "no", "reason": long}),
            json!({"answer": "yes", "reason": 3}),
            json!({"answer": "yes", "score": 90}),
        ] {
            let mut answers = all_yes();
            answers[0].1 = bad.clone();
            let got = verdicts(&reply(answers));
            assert!(matches!(&got[0], ("headline_finding", Verdict::Unanswered { .. })), "{bad}: {got:?}");
            assert!(got[1..].iter().all(|(_, v)| *v == Verdict::Yes), "{bad}: {got:?}");
        }
        // a question left out is unanswered
        let got = verdicts(&reply(all_yes()[1..].to_vec()));
        assert_eq!(got[0], ("headline_finding", Verdict::Unanswered { why: "not answered".into() }));
        // the frame is refused: no answers object, an id not asked, the old score shape
        assert!(Ask::Vision.check(&json!({"step": "vision", "answers": "yes"})).is_err());
        assert!(Ask::Vision.check(&json!({"step": "vision", "answers": [true]})).is_err());
        let mut extra = all_yes();
        extra.push(("illustration_fits", json!({"answer": "yes"})));
        let why = Ask::Vision.check(&reply(extra)).unwrap_err();
        assert!(why.problem.contains("illustration_fits"), "{}", why.problem);
        assert!(Ask::Vision.check(&json!({"step": "vision", "score": 95, "confidence": 0.9, "rubric": {}, "issues": []})).is_err());
        // an answers object sent as JSON text is decoded once, as any object-typed value
        let text = reply(all_yes())["answers"].to_string();
        assert!(verdicts(&json!({"step": "vision", "answers": text})).iter().all(|(_, v)| *v == Verdict::Yes));
        // the schema shows every question with its definition
        let schema = Ask::Vision.schema();
        assert_eq!(schema["properties"]["answers"]["required"], json!(ids));
        assert_eq!(
            schema["properties"]["answers"]["properties"]["single_focus"]["description"],
            "yes if the page has one visual focal point and uses one accent colour for it"
        );
    }

    /// The shape answer (owner 11-14 16:5x item 2): 0 or an offered shape, the question's quantities by number with none
    /// twice, and as many as the shape takes (answer_plan::SPLIT_TERMS); the example the refusal sends is itself accepted.
    #[test]
    fn a_shape_answer_is_zero_or_an_offered_shape_with_enough_quantities() {
        use crate::answer_plan::{Shape, SplitAsk, SplitReply};
        let two = || vec![("population".to_string(), "人口".to_string()), ("gdp_pc".to_string(), "人均GDP".to_string())];
        let ask = Ask::Split {
            ask: SplitAsk {
                offered: vec![(Shape::RankCompare, Some("是不是也")), (Shape::ThresholdTime, None), (Shape::TotalToParts, None)],
                quantities: two(),
            },
        };
        let answer = |shape: u64, quantities: Value| json!({"step": "split", "split": shape, "quantities": quantities});
        let reply = |shape: u8, quantities: Vec<usize>| Choice::Split { reply: SplitReply { number: shape, quantities } };
        assert_eq!(ask.check(&answer(0, json!([]))).unwrap(), reply(0, vec![]));
        assert_eq!(ask.check(&answer(1, json!([1, 0]))).unwrap(), reply(1, vec![1, 0]));
        assert_eq!(ask.check(&answer(1, json!([]))).unwrap(), reply(1, vec![]), "[] keeps the question's two");
        for bad in [answer(4, json!([])), answer(1, json!([0])), answer(1, json!([0, 0])), answer(2, json!([2])), answer(1, json!("0,1"))] {
            let refused = ask.check(&bad).unwrap_err();
            assert!(refused.allowed["split"] == json!([0, 1, 2, 3]), "{bad}: {:?}", refused.allowed);
            assert!(ask.check(&refused.example).is_ok(), "the example is accepted: {}", refused.example);
        }
        assert!(ask.check(&json!({"step": "split", "split": 0})).is_err(), "quantities is required");
        assert_eq!(ask.schema()["properties"]["split"]["enum"], json!([0, 1, 2, 3]));
        assert!(ask.schema()["properties"]["split"]["description"].as_str().unwrap().contains("\"是不是也\" point here"));
        // a question that names one quantity cannot take 名次对照, and the example offers nothing else when none is preselected
        let one = Ask::Split {
            ask: SplitAsk { offered: vec![(Shape::RankCompare, None), (Shape::ThresholdTime, None), (Shape::TotalToParts, None)], quantities: two()[..1].to_vec() },
        };
        assert!(one.check(&answer(1, json!([]))).is_err());
        assert_eq!(one.check(&answer(2, json!([]))).unwrap(), reply(2, vec![]));
        assert_eq!(one.example(), answer(0, json!([])));
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
            changes: Vec::new(),
            levels: Vec::new(),
            scoped: Vec::new(),
            titles: Vec::new(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
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

    /// q1's and q6's stand-in titles asked a level on a page whose bars drew the change: a LEVEL_WORDS word with no change
    /// word (CHANGE_WORDS, or 从 before 到) is a level question, refused only in a field `changes` lists, with the rule, the
    /// change words and the drafts in the reply; the schema says the rule on such a page only.
    #[test]
    fn a_level_question_is_refused_only_in_a_field_that_states_a_change() {
        assert_eq!(level_question("哪国可再生能源占比最高"), Some("最高"));
        assert_eq!(level_question("哪些国籍的人申请庇护最多"), Some("最多"));
        assert_eq!(level_question("谁领先，谁垫底"), Some("领先"));
        for change in [
            "谁的变化最大",
            "哪国升得最多",
            "申请人数增加最多的国籍",
            "从起始到最近，谁领先",
            "走势如何",
            "各国可再生能源占比",
        ] {
            assert_eq!(level_question(change), None, "{change}");
        }
        let ask = |changes: &[&str]| Ask::Text {
            fields: BTreeMap::from([
                ("1".to_string(), "变化多大".to_string()),
                ("2".to_string(), "各自变了多少".to_string()),
            ]),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: Vec::new(),
            changes: changes.iter().map(|c| c.to_string()).collect(),
            levels: Vec::new(),
            scoped: Vec::new(),
            titles: Vec::new(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
        };
        let answer = |n: &str, t: &str| json!({"step": "text", "text": {n: t}, "names": {}});
        let refused = ask(&["1"]).check(&answer("1", "哪国最高")).unwrap_err();
        assert!(
            refused.problem.starts_with("field '1': '最高' asks a level; "),
            "{}",
            refused.problem
        );
        assert!(refused.problem.contains(CHANGE_TITLE_RULE), "{}", refused.problem);
        assert_eq!(
            refused.allowed["changes"],
            json!({"fields": ["1"], "words": CHANGE_WORDS})
        );
        assert_eq!(refused.allowed["text"]["1"], "变化多大");
        assert_eq!(refused.example, json!({"step": "text", "text": {}, "names": {}}));
        assert!(ask(&["1"]).check(&answer("1", "哪国升得最多")).is_ok());
        assert!(ask(&["1"]).check(&answer("2", "哪国最高")).is_ok());
        assert!(ask(&[]).check(&answer("1", "哪国最高")).is_ok());
        assert!(ask(&[]).allowed().get("changes").is_none());
        let described = |a: &Ask| a.schema()["properties"]["text"]["description"].as_str().unwrap().to_string();
        assert!(described(&ask(&["1"])).contains(CHANGE_TITLE_RULE));
        assert!(!described(&ask(&[])).contains(CHANGE_TITLE_RULE));
    }

    #[test]
    fn every_level_term_holds_a_change_word_and_no_number() {
        // a term is listed only because it holds a change word's character; one that holds none would loosen nothing
        let terms = level_terms();
        assert!(terms.len() >= 2, "{terms:?}");
        for term in terms {
            assert!(CHANGE_WORDS.iter().any(|w| term.contains(*w)), "{term}");
            assert!(!term.chars().any(|c| c.is_ascii_digit()), "{term}");
            assert_eq!(change_word(term), None, "{term}");
            // a bare change word (增长, 变化) would free every such word: a term keeps two characters besides its change word
            let rest = CHANGE_WORDS.iter().fold(term.clone(), |t, w| t.replace(*w, ""));
            assert!(rest.chars().count() >= 2, "{term}");
        }
    }

    /// Plan v4 item 7 (n47, t4): a level page's title named a change (各国温室气体排放的水平与变化) over one year's ranking. On
    /// a field `levels` lists, a wording with a CHANGE_WORDS word is refused with the word, the rule and the field's draft
    /// as the example; a wording with none passes, and so does every field of a page with no level title.
    #[test]
    fn a_change_word_is_refused_in_a_level_title() {
        let ask = |levels: &[&str]| Ask::Text {
            fields: BTreeMap::from([("1".to_string(), "各国温室气体排放量".to_string())]),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: Vec::new(),
            changes: Vec::new(),
            levels: levels.iter().map(|c| c.to_string()).collect(),
            scoped: Vec::new(),
            titles: Vec::new(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
        };
        let answer = |t: &str| json!({"step": "text", "text": {"1": t}, "names": {}});
        for (title, word) in [("各国温室气体排放的水平与变化", "变"), ("各国房价指数的涨幅", "涨"), ("欧盟各国排放下降了吗", "降")] {
            let refused = ask(&["1"]).check(&answer(title)).unwrap_err();
            assert!(refused.problem.starts_with(&format!("field '1': '{word}' names a change; ")), "{}", refused.problem);
            assert!(refused.problem.contains(LEVEL_RULE) && refused.problem.contains("各国温室气体排放量"), "{}", refused.problem);
            assert_eq!(refused.allowed["levels"], json!({"fields": ["1"], "words": CHANGE_WORDS, "rule": LEVEL_RULE}));
        }
        assert!(ask(&["1"]).check(&answer("德国温室气体排放量居首")).is_ok());
        assert!(ask(&[]).check(&answer("各国温室气体排放的水平与变化")).is_ok());
        let described = |a: &Ask| a.schema()["properties"]["text"]["description"].as_str().unwrap().to_string();
        assert!(described(&ask(&["1"])).contains(LEVEL_RULE) && !described(&ask(&[])).contains(LEVEL_RULE));
        // A measure's name that holds a change word's character and names no change passes (round 10 q7: value added, which
        // the stand-in reworded to a wrong name when refused); a change word beside it is still refused.
        assert!(ask(&["1"]).check(&answer("欧盟各国对华出口的国内增加值排名")).is_ok());
        assert!(ask(&["1"]).check(&answer("不含土地利用变化的人均排放")).is_ok());
        let grew = ask(&["1"]).check(&answer("国内增加值增长最快的国家")).unwrap_err();
        assert!(grew.problem.starts_with("field '1': '增' names a change; "), "{}", grew.problem);
        // n47 (round 9, user 11-11 item 2): freeing 土地利用变化 leaves the 变化 of a title that names a change refused
        let n47 = ask(&["1"]).check(&answer("各国温室气体排放的水平与变化")).unwrap_err();
        assert!(n47.problem.starts_with("field '1': '变' names a change; "), "{}", n47.problem);
        assert_eq!(change_word("各国温室气体排放的水平与变化"), Some("变"));
        assert_eq!(change_word("不含土地利用变化的人均排放量的变化"), Some("变"));
        // A wording a rule offers on every page passes on a level page; only the change rule's own examples name a change,
        // and that rule is said only on a change page.
        for suggested in RULE_SUGGESTIONS {
            let on_change_pages = CHANGE_TITLE_RULE.contains(suggested);
            assert_eq!(ask(&["1"]).check(&answer(suggested)).is_ok(), !on_change_pages, "{suggested}");
        }
    }

    /// A scoped stand-in title ranked and was put back after acceptance, unsaid: on a field `scoped` lists, a wording that
    /// differs from its draft and holds a SUPERLATIVES word is refused with the word, the rule and its example; a field as
    /// drafted, and every field of a page not scoped, pass as before.
    #[test]
    fn a_ranking_word_is_refused_only_in_a_reworded_field_of_a_scoped_page() {
        let ask = |scoped: &[&str]| Ask::Text {
            fields: BTreeMap::from([
                ("1".to_string(), "变化多大".to_string()),
                ("2".to_string(), "{max.v.geo}最多".to_string()),
            ]),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: Vec::new(),
            changes: vec!["1".to_string()],
            levels: Vec::new(),
            scoped: scoped.iter().map(|s| s.to_string()).collect(),
            titles: Vec::new(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
        };
        let answer = |n: &str, t: &str| json!({"step": "text", "text": {n: t}, "names": {}});
        let both = ask(&["1", "2"]);
        let refused = both.check(&answer("1", "从起始到最近，谁升得最多")).unwrap_err();
        assert!(refused.problem.starts_with("field '1': '最多' ranks; "), "{}", refused.problem);
        assert!(refused.problem.contains(SCOPE_RULE), "{}", refused.problem);
        assert!(refused.problem.contains("'各地的高低分布'"), "{}", refused.problem);
        assert_eq!(
            refused.allowed["scoped"],
            json!({"fields": ["1", "2"], "words": crate::next_page::SUPERLATIVES})
        );
        assert!(both.check(&answer("1", "各方数值的变化")).is_ok());
        assert!(both.check(&answer("2", "{max.v.geo}最多")).is_ok(), "the draft as it stands");
        assert!(both.check(&answer("2", "{max.v.geo}居首")).is_ok());
        assert!(both.check(&answer("2", "{max.v.geo}领先")).is_err());
        assert!(ask(&[]).check(&answer("1", "从起始到最近，谁升得最多")).is_ok());
        assert!(ask(&[]).allowed().get("scoped").is_none());
        let described = |a: &Ask| a.schema()["properties"]["text"]["description"].as_str().unwrap().to_string();
        assert!(described(&both).contains(SCOPE_RULE));
        assert!(!described(&ask(&[])).contains(SCOPE_RULE));
        // The rule says every SUPERLATIVES word, and no wording a rule suggests ranks.
        assert!(crate::next_page::SUPERLATIVES.iter().all(|w| SCOPE_RULE.contains(w)));
        for suggested in RULE_SUGGESTIONS {
            assert_eq!(ranking_word(suggested), None, "{suggested}");
            assert!(both.check(&answer("1", suggested)).is_ok(), "{suggested}");
        }
    }

    /// The four stand-in titles asked ("…谁升得更快", "…谁的变化最大", "…从哪里来"): on the field `titles` lists, a wording
    /// with a question mark or a QUESTION_WORDS word is refused with the field, the word, the rule and the field's draft as
    /// the example; a label and a conclusion pass, and so does a question in any other field. Every wording a rule suggests
    /// passes the title check on a change page that is scoped, so on every page kind.
    #[test]
    fn a_question_in_the_title_field_is_refused_and_a_label_or_a_conclusion_passes() {
        let ask = |titles: &[&str], changes: &[&str], scoped: &[&str]| Ask::Text {
            fields: BTreeMap::from([
                ("1".to_string(), "各方的变化".to_string()),
                ("2".to_string(), "各自变化的方向和幅度".to_string()),
            ]),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: Vec::new(),
            changes: changes.iter().map(|c| c.to_string()).collect(),
            levels: Vec::new(),
            scoped: scoped.iter().map(|s| s.to_string()).collect(),
            titles: titles.iter().map(|t| t.to_string()).collect(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
        };
        let answer = |n: &str, t: &str| json!({"step": "text", "text": {n: t}, "names": {}});
        let titled = ask(&["1"], &[], &[]);
        for (asked, word) in [
            ("欧盟各国可再生能源占比：谁升得更快", "谁"),
            ("欧盟庇护申请人从哪里来", "哪"),
            ("各国占比变化多大", "多大"),
            ("占比为什么升了", "为什么"),
            ("占比升了吗", "吗"),
            ("各国占比升了多少", "多少"),
            ("各国占比的变化？", "？"),
            ("各国占比的变化?", "?"),
        ] {
            let refused = titled.check(&answer("1", asked)).unwrap_err();
            assert!(
                refused.problem.starts_with(&format!("field '1': '{word}' makes it a question; ")),
                "{asked}: {}",
                refused.problem
            );
            assert!(refused.problem.contains(TITLE_RULE), "{}", refused.problem);
            assert!(refused.problem.ends_with(", e.g. '各方的变化'"), "{}", refused.problem);
            assert_eq!(refused.allowed["titles"], json!({"fields": ["1"], "words": QUESTION_WORDS}));
            // only the title is a title: the dek may ask, and an ask with no title field refuses none of it
            assert!(titled.check(&answer("2", asked)).is_ok(), "{asked}");
            assert!(ask(&[], &[], &[]).check(&answer("1", asked)).is_ok(), "{asked}");
        }
        for (label_or_conclusion, kind) in [
            ("欧盟各国可再生能源占比", "a label"),
            ("各国庇护申请的来源", "a label"),
            ("北欧国家占比升幅居前", "a conclusion"),
            ("几乎每国的占比都在上升", "几乎 is no question"),
        ] {
            assert!(titled.check(&answer("1", label_or_conclusion)).is_ok(), "{kind}: {label_or_conclusion}");
        }
        assert!(ask(&[], &[], &[]).allowed().get("titles").is_none());
        let described = |a: &Ask| a.schema()["properties"]["text"]["description"].as_str().unwrap().to_string();
        assert!(described(&titled).contains(TITLE_RULE));
        assert!(!described(&ask(&[], &[], &[])).contains(TITLE_RULE));
        // The rule names every word it refuses for; a wording a rule suggests asks nothing and passes as the title of a
        // scoped change page, the title check, the level check and the scope check together.
        assert!(QUESTION_WORDS.iter().all(|w| TITLE_RULE.contains(w)));
        let every = ask(&["1"], &["1"], &["1", "2"]);
        for suggested in RULE_SUGGESTIONS {
            assert_eq!(question_word(suggested), None, "{suggested}");
            assert!(every.check(&answer("1", suggested)).is_ok(), "{suggested}");
        }
        // The rules' own examples (each after " '", and TYPED_NUMBER_RULE's after "write ") are the suggestions, but the one
        // a rule says not to write; every suggestion is a rule's example.
        let mut examples: Vec<&str> = Vec::new();
        for rule in [TITLE_RULE, CHANGE_TITLE_RULE, SCOPE_RULE] {
            let quoted: Vec<&str> = rule.split(" '").skip(1).filter_map(|q| q.split('\'').next()).collect();
            assert!(!quoted.is_empty(), "{rule}");
            examples.extend(quoted.into_iter().filter(|q| !q.contains('最')));
        }
        examples.extend(TYPED_NUMBER_RULE.split("write ").nth(1).and_then(|w| w.split(',').next()));
        for example in &examples {
            assert!(RULE_SUGGESTIONS.contains(example), "{example}");
        }
        for suggested in RULE_SUGGESTIONS {
            assert!(examples.contains(&suggested), "{suggested} is no rule's example");
        }
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
        // number-free-words.json (user 11-07 ⑤, 11-08 item 3: built from World Bank indicator names in Chinese and the unit
        // table only): a rate's base, an SI unit (after a value too), a bracketed scale label, an age band and a coded term
        // are no number; the drafts the stand-ins wrote in rounds 2-5 that the old check refused.
        for text in [
            "每百人移动电话签约数",
            "粗出生率（每千人）的变化",
            "每十万人口自杀死亡率",
            "{min.value.country_iso3}单产最低，为{min.value}千克每公顷。",
            "二氧化碳排放总量的变化（百万吨）",
            "五岁以下儿童死亡率的高低排名",
        ] {
            assert_eq!(worded_number(text), None, "{text}");
        }
        for (text, typed) in [
            ("五岁以下儿童死亡率", "    儿童死亡率"),
            ("{a}增加2000人", "{a}增加2000人"),
            // a word with ASCII digits as an official name writes it is a free word (user 11-08 item 4; the page tree prints it
            // as a term run)
            ("各国PM2.5浓度的高低与下降", "各国     浓度的高低与下降"),
            // a single age only with the words its official name writes after it (65岁以上, 5岁以下; review 11-08)
            ("65岁以上人口占比的变化", "     人口占比的变化"),
            ("5岁以下儿童死亡率", "    儿童死亡率"),
            ("青年失业率（15至24岁，地图）", "青年失业率（      ，地图）"),
        ] {
            assert_eq!(number_free_text(text), typed, "{text}");
        }
        let w = free_words();
        assert!(w.terms.iter().any(|t| t.iter().collect::<String>() == "PM2.5"), "the digit terms are taken in bulk too");
        assert!(w.ages.iter().any(|a| a == "15-24岁"));
        // Still numbers: a count, a span, a rate's base that is a count, a scale after a value or a count, an SI unit after
        // a numeral, a term after a placeholder, and the words no source writes (an age band in Chinese numerals, 零排放,
        // 七国集团: hand-added on 11-07, taken out on 11-08).
        for (text, word) in [
            ("四国外债总额的涨幅", "四"),
            ("把两国放在同一把尺子上", "两"),
            ("从十年前到最近", "十"),
            ("每三人中有一人", "三"),
            ("{a}百万吨", "百万"),
            ("人口过百万人", "百万"),
            ("三千克", "三千"),
            ("青年失业率（十五至二十四岁）", "十五"),
            ("零排放汽车占比", "零"),
            ("七国集团经济增长的高低排名", "七"),
            // a scale word in a bracket that does not close right after it is a threshold, not a label (review 11-08)
            ("人口（百万以上）的城市", "百万"),
            ("（千人以上企业）", "千"),
            // a bare age, or an age with words no official name writes after it, is a number (review 11-08)
            ("预期寿命增加了五岁", "五"),
            ("劳动参与率（五岁以上人口）", "五"),
        ] {
            assert_eq!(worded_number(text).as_deref(), Some(word), "{text}");
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

    /// User 11-07: a count of places (三国, 两国, 四个经济体, 5个国家) is a number, allowed on the text step only when it is the
    /// number of places the page draws; at any other count, or an unknown one, it is refused as before, and a numeral that
    /// counts no place stays a number.
    #[test]
    fn a_count_of_places_passes_only_when_the_page_draws_that_many() {
        let ask = |places: Option<usize>| Ask::Text {
            fields: BTreeMap::from([("1".to_string(), "{first.name}最高".to_string())]),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: Vec::new(),
            changes: Vec::new(),
            levels: Vec::new(),
            scoped: Vec::new(),
            titles: Vec::new(),
            mark: String::new(),
            places,
            members: Vec::new(),
            unasked: Vec::new(),
        };
        let said = |text: &str| json!({"step": "text", "text": {"1": text}, "names": {}});
        for (text, n) in [
            ("三国中{first.name}最高", 3),
            ("两国相比，{first.name}最高", 2),
            ("四个经济体里{first.name}最高", 4),
            ("二十七国中{first.name}最高", 27),
            ("三方之中{first.name}最高", 3),
        ] {
            assert!(ask(Some(n)).check(&said(text)).is_ok(), "{text} on a page of {n}");
            assert!(ask(Some(n + 1)).check(&said(text)).is_err(), "{text} on a page of {}", n + 1);
            assert!(ask(None).check(&said(text)).is_err(), "{text} with no count");
        }
        assert_eq!(ask(Some(3)).allowed()["place_count"]["places"], 3);
        // digits stay a typed number: the core's schema refuses a digit in a literal word
        assert!(ask(Some(5)).check(&said("5个国家里{first.name}最高")).is_err());
        // still numbers on a page of three: a span, a share, a count after a quantity word or a placeholder
        for text in ["十年前{first.name}最高", "三国中{first.name}占三成", "近三国{first.name}最高", "{first.name}三国最高"] {
            assert!(ask(Some(3)).check(&said(text)).is_err(), "{text}");
            assert!(ask(Some(10)).check(&said(text)).is_err(), "{text}");
        }
        assert_eq!(place_count_free("三国与两国", Some(3)), " 国与两国");
        for (run, n) in [("两", Some(2)), ("十", Some(10)), ("十二", Some(12)), ("二十七", Some(27)), ("一百零五", Some(105)), ("27", None), ("几", None), ("2十", None)] {
            assert_eq!(numeral_value(&run.chars().collect::<Vec<_>>()), n, "{run}");
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
            changes: Vec::new(),
            levels: Vec::new(),
            scoped: Vec::new(),
            titles: Vec::new(),
            mark: String::new(),
            places: None,
            members: Vec::new(),
            unasked: Vec::new(),
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
                relation: None,
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

    /// Two tables, each asked as a table pick and a claims pick with program calls (the knowledge group's fetch, through its
    /// command) under each; one refused answer on the way.
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
        let catalogue = offers_catalogue();
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
                    relation: None,
                    picks: vec![1],
                    params: BTreeMap::new()
                }
            );
            recorder
                .prepare(&catalogue, &mut tools, json!({"dataset": "x"}), &cancel)
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
                .prepare(&catalogue, &mut tools, json!({"sheet": "s", "picks": [1]}), &cancel)
                .await
                .unwrap();
            recorder
                .prepare(&catalogue, &mut tools, json!({"sheet": "s", "picks": [2]}), &cancel)
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
            json!({"tool": "newsroom_data_prepare", "rows": 3})
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
        let catalogue = offers_catalogue();
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        let err = recorder
            .prepare(&catalogue, &mut tools, json!({}), &cancel)
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
            .prepare(&catalogue, &mut tools, json!({}), &cancel)
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

    /// Keeps every history it was asked over, and answers with the scripted replies.
    struct HistoryAsker {
        replies: std::collections::VecDeque<Value>,
        asked: Vec<Vec<Value>>,
    }

    #[async_trait]
    impl Asker for HistoryAsker {
        fn route(&self) -> ModelRoute {
            ModelRoute::Standin
        }
        async fn ask(&mut self, history: &[Value], _tools: &[ToolDef], _cancel: &AtomicBool) -> Option<Value> {
            self.asked.push(history.to_vec());
            self.replies.pop_front()
        }
    }

    /// A step asked alone goes without the run's history: after a run history and an earlier step, each of its requests
    /// holds only its own prompt (with its image) and, after a refusal, its refused reply and what the program sent back;
    /// the request filed for it holds the same. The run's history still records the step.
    #[tokio::test]
    async fn a_step_asked_alone_sends_none_of_the_runs_history() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (_events, mut sink) = collector();
        let cancel = AtomicBool::new(false);
        let earlier = vec![json!({"role": "user", "content": text_content("the question"), "timestamp": 1})];
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), earlier);
        let yes: Map<String, Value> = VISION_QUESTIONS.iter().map(|(id, _)| (id.to_string(), json!({"answer": "yes"}))).collect();
        let mut model = HistoryAsker {
            replies: vec![
                call("toolu_s", json!({"step": "search", "query": "renewable energy"})),
                call("toolu_r", json!({"step": "vision", "answers": "all good"})),
                call("toolu_v", json!({"step": "vision", "answers": yes})),
            ]
            .into(),
            asked: Vec::new(),
        };
        recorder.ask_step(&mut model, &Ask::Search, "search", &cancel).await.unwrap();
        let image = json!({"type": "image", "data": "AAEC", "mimeType": "image/png"});
        let (id, choice) = recorder
            .ask_step_alone(&mut model, &Ask::Vision, "review the page", std::slice::from_ref(&image), &cancel)
            .await
            .unwrap();
        assert_eq!(id, "toolu_v");
        assert!(matches!(choice, Choice::Vision { .. }));
        // the search went over the run's history; the review never did
        assert_eq!(model.asked[0].len(), 2);
        let first = &model.asked[1];
        assert_eq!(first.len(), 1, "{first:?}");
        assert_eq!(first[0]["content"], json!([{"type": "text", "text": with_step_line("review the page", "vision")}, image]));
        let second = &model.asked[2];
        let roles: Vec<&str> = second.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["user", "assistant", "toolResult"]);
        assert_eq!(second[0], first[0]);
        assert!(!second.iter().any(|m| m.to_string().contains("the question") || m.to_string().contains("toolu_s")));
        let filed: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(EXCHANGE_DIR).join("toolu_v.json")).unwrap()).unwrap();
        assert_eq!(filed["request"]["history"], json!(second));
        // the run's history keeps it all
        assert_eq!(recorder.history().len(), 1 + 3 + 5);
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

    /// A listed secret is reported as the handed-over secret even where a header comes first: one with a quote in it reads
    /// escaped in the serialized value, which shows the header, and only unescaped in its own string.
    #[test]
    fn a_listed_secret_is_reported_before_a_header_seen_first() {
        let secrets = vec!["pa\"ss-0123".to_string()];
        let value = json!({"text": "Authorization: x pa\"ss-0123"});
        assert!(!value.to_string().contains("pa\"ss-0123"));
        assert_eq!(secret_in(&value, &secrets), Some(SecretKind::Handoff));
        assert_eq!(
            secret_in(&json!({"text": "Authorization: x"}), &secrets),
            Some(SecretKind::AuthorizationHeader)
        );
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
            twin_of: None,
        })
        .collect()
    }

    /// One top5 call as the fake catalogue kept it: the question, the texts, the months flag and the latest year.
    type Searched = (String, Vec<String>, bool, Option<i32>);

    /// A catalogue that returns these tables (or the uncovered level), flags "japan", and keeps what it was asked.
    struct FakeCatalogue {
        candidates: Vec<Candidate>,
        uncovered: Option<Uncovered>,
        source: Value,
        searched: std::sync::Mutex<Vec<Searched>>,
    }

    impl FakeCatalogue {
        fn ranking(&self) -> Ranking {
            Ranking {
                scope: Scope::Europe,
                places_zh: vec!["德国".into(), "法国".into()],
                uncovered: self.uncovered.clone(),
                unread: None,
                candidates: self.candidates.clone(),
                twins_refused: Vec::new(),
                unproven: Vec::new(),
                asked: Vec::new(),
            }
        }
    }

    impl Catalogue for FakeCatalogue {
        fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, _first_year: Option<i32>) -> Ranking {
            self.searched
                .lock()
                .unwrap()
                .push((question_zh.to_string(), texts.to_vec(), months, latest_year));
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
        // the host's structured download timeout (a cold request): one identical retry, logged, then the source answers
        let cold = || json!({"mode": "failed", "text": "Data preparation failed: DOWNLOAD_TIMEOUT: api.worldbank.org did not finish the download in 30.0 s (limit 30 s). One identical retry is allowed."});
        let drove = fetch(vec![cold(), json!({"mode": "no_candidates"})]).await;
        assert!(matches!(drove.result, Err(Stop::TooFewClaims { .. })), "{:?}", drove.result);
        assert_eq!((drove.tools.args.len(), drove.tools.args[0] == drove.tools.args[1]), (2, true));
        let retries = of_type(&drove.events, FETCH_RETRY_EVENT);
        assert_eq!(retries.len(), 1);
        assert!(retries[0]["after"].as_str().unwrap().contains("DOWNLOAD_TIMEOUT"), "{:?}", retries[0]);
        // a second timeout still refuses the page, after two fetches and one retry event; a third detail is never asked
        let drove = fetch(vec![cold(), cold(), json!({"mode": "no_candidates"})]).await;
        assert!(matches!(&drove.result, Err(Stop::SourceUnreachable { tries: 2, why, .. }) if why.contains("DOWNLOAD_TIMEOUT")), "{:?}", drove.result);
        assert_eq!((drove.tools.args.len(), of_type(&drove.events, FETCH_RETRY_EVENT).len()), (2, 1));
        // the host's refusal of a repeat is not retried
        let repeat = json!({"mode": "failed", "text": "Data preparation failed: DOWNLOAD_TIMEOUT_REPEAT: this exact request to api.worldbank.org timed out 2 times."});
        let drove = fetch(vec![repeat]).await;
        assert!(matches!(&drove.result, Err(Stop::NotPrepared { mode, .. }) if mode == "failed"), "{:?}", drove.result);
        assert_eq!(drove.tools.args.len(), 1);
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
        searched: Vec<Searched>,
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
        drive_asking("德国和法国的发电量", sheets, replies, details, catalogue).await
    }

    /// As drive_in, for this question.
    async fn drive_asking(
        question: &str,
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
            question,
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

    /// P4b-4 (table pick by data shape): the table card says under each table with composition groups what each place's
    /// total splits into, whatever the question, and offers an optional relation. An answer with a relation fetches, picks
    /// and prepares exactly as the same answer without one (no round, no refusal, no stop, no table or param changed); the
    /// run records the number and what the main table's shape keeps: Composition on a table with groups (nrg_bal_peh),
    /// dropped on one with none (a World Bank table) and a number outside 1-6 dropped. An answer with none records nothing.
    #[tokio::test]
    async fn a_table_answer_with_a_relation_takes_todays_path_and_the_shape_keeps_or_drops_it() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = |table: Value| async move {
            drive(
                &[(SHEET_A, &["c1", "c2", "c3", "c4"]), (SHEET_B, &["w1", "w2", "w3"])],
                vec![search_reply(), call("toolu_t", table), call("toolu_c", json!({"step": "claims", "pick": [4, 1, 2, 5, 6, 7]}))],
                vec![
                    json!({"mode": "too_large", "estimate": 90000}),
                    json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 4}),
                    json!({"mode": "candidates", "sheet": SHEET_B, "conclusions": 3}),
                    json!({"mode": "picks", "claims": [{"candidate": "c4", "claim_id": "k1"}, {"candidate": "c1", "claim_id": "k2"}, {"candidate": "c2", "claim_id": "k3"}]}),
                    json!({"mode": "picks", "claims": [{"candidate": "w1", "claim_id": "k4"}, {"candidate": "w2", "claim_id": "k5"}, {"candidate": "w3", "claim_id": "k6"}]}),
                ],
                offers(),
            )
            .await
        };
        let today = run(json!({"step": "table", "pick": [2, 4]})).await;
        assert!(of_type(&today.events, TABLE_RELATION_EVENT).is_empty());
        let card = today.history.iter().filter(|m| m["role"] == "user").map(|m| m["content"].to_string()).find(|c| c.contains("Tables:")).unwrap();
        assert!(card.contains("t2: each place's siec TOTAL splits into the registered groups fossil, renewable, other, nuclear"), "{card}");
        assert!(!card.contains("t4: each place's"), "a World Bank table has no groups");
        assert!(card.contains("2 Composition") && card.contains("Composition only with a table that has a 'splits into' line"), "{card}");
        let prepared = format!("{:?}", today.result.as_ref().unwrap());
        for (answer, kept) in [
            (json!({"step": "table", "pick": [2, 4], "relation": 2}), json!("Composition")),
            (json!({"step": "table", "pick": [2, 4], "relation": 5}), json!("Ranking")),
            (json!({"step": "table", "pick": [2, 4], "relation": 7}), Value::Null),
            (json!({"step": "table", "pick": [2, 4], "relation": "two"}), Value::Null),
        ] {
            let drove = run(answer.clone()).await;
            // the same tables and claims; the main table carries the kept relation, every other none
            let mut got = drove.result.as_ref().unwrap().clone();
            let carried: Vec<Option<String>> = got.iter().map(|p| p.relation.map(|r| format!("{r:?}"))).collect();
            assert_eq!(carried, [kept.as_str().map(str::to_string), None], "{answer}");
            got.iter_mut().for_each(|p| p.relation = None);
            assert_eq!(format!("{got:?}"), prepared, "{answer}");
            assert_eq!(drove.tools.args, today.tools.args, "{answer}: the fetches");
            assert_eq!(drove.model.offered.len(), today.model.offered.len(), "{answer}: no round added");
            let ev = of_type(&drove.events, TABLE_RELATION_EVENT);
            if answer["relation"].is_u64() {
                assert_eq!((ev.len(), &ev[0]["table"], &ev[0]["kept"]), (1, &json!("nrg_bal_peh"), &kept), "{answer}");
            } else {
                assert!(ev.is_empty(), "{answer}: a relation that is no number is none");
            }
        }
    }

    /// P4b-4: the rule by the main table's shape alone, never the question's words (P0-P5 of the design): Composition kept
    /// on a table with composition groups, dropped on one with none; any other relation kept; none, 0 and a number past the
    /// six dropped. The table step's check takes an answer with any relation (or none) as the same pick and params.
    #[test]
    fn the_table_relation_is_kept_or_dropped_by_the_tables_shape_only() {
        assert_eq!(table_relation(Some(2), "nrg_bal_peh"), Some(Relation::Composition));
        assert_eq!(table_relation(Some(2), "nrg_cb_pem"), None);
        assert_eq!(table_relation(Some(2), "SP.POP.65UP.TO.ZS@2"), None);
        assert_eq!(table_relation(Some(5), "nrg_cb_pem"), Some(Relation::Ranking));
        for none in [None, Some(0), Some(7)] {
            assert_eq!(table_relation(none, "nrg_bal_peh"), None, "{none:?}");
        }
        let ask = Ask::Table { count: 2, most: 1, items: Vec::new(), splits: Vec::new(), held: Vec::new() };
        assert!(ask.schema()["properties"]["relation"].is_object());
        assert_eq!(ask.schema()["required"], json!(["step", "pick"]), "the relation is optional");
        let plain = ask.check(&json!({"step": "table", "pick": [1]})).unwrap();
        for (r, given) in [(json!(2), Some(2)), (json!(9), Some(9)), (json!("x"), None)] {
            let Choice::Table { picks, params, relation } = ask.check(&json!({"step": "table", "pick": [1], "relation": r})).unwrap() else { panic!() };
            assert_eq!((Choice::Table { picks, params, relation: None }, relation), (plain.clone(), given));
        }
        assert!(ask.check(&json!({"step": "table", "pick": [1], "other": 1})).is_err(), "another key is still refused");
        let claims = Ask::Claims { groups: vec![2], relations: 1 };
        assert!(claims.check(&json!({"step": "claims", "pick": [1, 2], "relation": 1})).is_err(), "the claims step asks no relation here");
    }

    /// P4b-4 replay (design 4.2 (a), (c)): every recorded table-step answer of the bank's last runs (P4B_TABLE_REPLIES,
    /// exported from their relay/reply-*.json with the tables each card listed), as recorded and with each relation 1-6
    /// added: the check gives the same pick and params (or the same refusal) as today, the table the program fetches is the
    /// model's, and the rule keeps only what the table's shape allows. Prints one line per run and a total.
    ///
    ///     P4B_TABLE_REPLIES=<table-replies.json> cargo test --bins table_relation_replay -- --ignored --nocapture
    #[test]
    #[ignore]
    fn table_relation_replay() {
        let runs: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(std::env::var("P4B_TABLE_REPLIES").unwrap()).unwrap()).unwrap();
        let (mut cases, mut equal, mut changed) = (0, 0, 0);
        for run in &runs {
            let mut line = Vec::new();
            for r in run["replies"].as_array().unwrap().iter().filter(|r| r["args"]["step"] == "table") {
                let args = &r["args"];
                let listed = r["listed"].as_object().unwrap();
                // the check as the step asked it: its listed tables, one pick, an item per param given (its options at least
                // the number given), no held-series probe
                let params = args["params"].as_object().cloned().unwrap_or_default();
                let items: Vec<Vec<(String, usize)>> = (1..=listed.len().max(1))
                    .map(|n| params.iter().filter(|(k, _)| k.starts_with(&format!("t{n}."))).map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(1).max(4) as usize)).collect())
                    .collect();
                let items = if items.iter().all(Vec::is_empty) { Vec::new() } else { items };
                let ask = Ask::Table { count: listed.len().max(1), most: 1, items, splits: Vec::new(), held: Vec::new() };
                let plain = ask.check(args).map_err(|e| e.problem);
                assert!(args.get("relation").is_none(), "{}: a recorded answer gives a relation", run["q"]);
                for rel in 1..=7usize {
                    cases += 1;
                    let mut with = args.clone();
                    with["relation"] = json!(rel);
                    let got = ask.check(&with).map_err(|e| e.problem);
                    let same = match (&plain, &got) {
                        (Ok(Choice::Table { picks: p0, params: q0, .. }), Ok(Choice::Table { picks, params, relation })) => {
                            p0 == picks && q0 == params && *relation == Some(rel)
                        }
                        (Err(a), Err(b)) => a == b,
                        _ => false,
                    };
                    equal += usize::from(same);
                    // the table the program fetches is the model's main pick, whatever the rule keeps
                    if let Ok(Choice::Table { picks, .. }) = &got {
                        let main = picks.first().and_then(|n| listed.get(&n.to_string())).and_then(Value::as_str).unwrap_or("");
                        let kept = table_relation(Some(rel), main);
                        changed += usize::from(kept.is_some_and(|k| k == Relation::Composition) && next_params::grouped_dim(main).is_none());
                        if rel == 2 {
                            line.push(format!("t{} {main} composition {}", picks.first().unwrap_or(&0), if kept.is_some() { "kept" } else { "dropped" }));
                        }
                    }
                }
            }
            println!("TABLEREPLAY {} {}: {}", run["q"].as_str().unwrap(), run["run"].as_str().unwrap(), line.join("; "));
        }
        println!("TABLEREPLAY cases {cases} same as today {equal} composition kept on a table with no groups {changed} refusals added 0 stops 0");
        assert_eq!((equal, changed), (cases, 0));
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
                vec!["electricity generation".to_string()],
                false,
                None
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

    /// The catalogue is told when the question asks for months (next_params::question_months), so a monthly-only table keeps
    /// its place; a question naming a year alone is not, and its monthly-only table is offered as its annual twin.
    #[tokio::test]
    async fn the_catalogue_is_told_when_the_question_asks_for_months() {
        let _command = crate::group_guard::command_for_test("investigate");
        for (question, months, year) in [
            ("2026 年 3 月德国和法国的发电量", true, Some(2026)),
            ("最近几个月德国和法国的发电量", true, None),
            ("2024 年德国和法国的发电量", false, Some(2024)),
        ] {
            let drove = drive_asking(
                question,
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
            assert!(matches!(&drove.result, Err(Stop::NoTable(_))), "{:?}", drove.result);
            assert_eq!(
                drove.searched,
                [(question.to_string(), vec!["electricity generation".to_string()], months, year)],
                "{question}"
            );
        }
    }

    /// The catalogue is told the latest year the question names (next_params::question_latest_year), so a monthly-only table
    /// keeps its place when its annual twin ends before that year; the last n years, or no year, tell it none.
    #[tokio::test]
    async fn the_catalogue_is_told_the_latest_year_the_question_names() {
        let _command = crate::group_guard::command_for_test("investigate");
        for (question, year) in [
            ("2026 年欧盟庇护申请的来源国", Some(2026)),
            ("2015 年到 2024 年欧盟庇护申请的来源国", Some(2024)),
            ("近五年欧盟庇护申请的来源国", None),
            ("欧盟庇护申请的来源国", None),
        ] {
            let drove = drive_asking(
                question,
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
            assert!(matches!(&drove.result, Err(Stop::NoTable(_))), "{:?}", drove.result);
            assert_eq!(
                drove.searched,
                [(question.to_string(), vec!["electricity generation".to_string()], false, year)],
                "{question}"
            );
        }
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
            false,
            None,
            None,
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
    /// User 11-08 item 1, as run: the knowledge group's scope call is a group call like any other, recorded under a model
    /// answer. A question the group refuses stops as out of scope after the search answer, its call recorded under that
    /// answer, never stopped as a call with no model answer (round 7's first three questions all stopped so: the call was
    /// made and recorded before any step); nothing is searched or fetched.
    #[tokio::test]
    async fn the_scope_call_is_recorded_under_the_search_answer() {
        let _command = crate::group_guard::command_for_test("investigate");
        struct Scoped(Mutex<Vec<Value>>, bool);
        impl Catalogue for Scoped {
            fn top5(&self, _: &str, _: &[String], _: bool, _: Option<i32>, _: Option<i32>) -> Ranking {
                unreachable!("an out-of-scope question is not searched")
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
            fn scope_refused(&self, _: &str, _: i32) -> Option<crate::l5geo::ScopeRefusal> {
                self.0.lock().unwrap().push(json!({"group": "knowledge", "request": "scope_refused"}));
                self.1.then(|| crate::l5geo::ScopeRefusal { class: "cause".into(), reason_zh: "原因".into(), hit: "为什么".into() })
            }
        }
        let catalogue = Scoped(Mutex::new(Vec::new()), true);
        let run = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![search_reply()]);
        let mut tools = claims_tools();
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        let result = prepare_claims(&mut recorder, &mut model, &mut tools, "为什么日本的老龄化更严重？", &[], &catalogue, &cancel).await;
        drop(recorder);
        let why = result.unwrap_err().to_string();
        assert!(why.contains("out of scope (cause"), "{why}");
        let calls = of_type(&events, GROUP_CALL_EVENT);
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0]["request"], "scope_refused");
        assert!(calls[0]["auto_parent_call_id"].is_string(), "{calls:?}");
        assert!(tools.args.is_empty(), "nothing fetched");
    }

    /// Each block of a 名次对照 plan gets the first offered table that holds its quantity, in block order, None for one no
    /// offered table holds; a plan whose blocks share one quantity (过线和时间, 由总到分) sets no tables.
    #[test]
    fn a_rank_compare_block_takes_the_first_offered_table_of_its_quantity() {
        use crate::answer_plan::{Block, Focus, Plan, Rel};
        let block = |id: &str| Block {
            rel: Rel::Ranking,
            focus: Focus::Max,
            places: Vec::new(),
            place_words: Vec::new(),
            years: None,
            quantity: vec![(id.to_string(), String::new())],
            sentence: String::new(),
        };
        let asked = |id: &str, offered: &[&str]| crate::l5geo::Asked {
            id: id.into(),
            zh: String::new(),
            tables: Vec::new(),
            offered: offered.iter().map(|t| t.to_string()).collect(),
        };
        let listed = [asked("population", &["SP.POP.TOTL", "demo_pjan"]), asked("gdp_pc", &["NY.GDP.PCAP.CD"]), asked("urban", &[])];
        let plan = Plan { blocks: vec![block("population"), block("gdp_pc"), block("urban")], partial: false };
        assert_eq!(
            block_tables(&plan, &listed),
            Some(vec![
                ("population".into(), Some("SP.POP.TOTL".into())),
                ("gdp_pc".into(), Some("NY.GDP.PCAP.CD".into())),
                ("urban".into(), None)
            ])
        );
        let shared = Plan { blocks: vec![block("population"), block("population")], partial: false };
        assert_eq!(block_tables(&shared, &listed), None);
        assert_eq!(block_tables(&Plan { blocks: vec![block("population")], partial: false }, &listed), None);
    }

    /// The split step (owner 11-14 16:5x item 2), asked after the search answer: the knowledge group's request, the model's
    /// answer, and for a shape the group's plan of it kept as a PLAN_EVENT, every group call under a model answer. A 0
    /// answer keeps the answer and no plan, and the one-block flow goes on (None); a catalogue that reads no splits asks
    /// nothing.
    #[tokio::test]
    async fn the_split_step_keeps_the_answer_and_the_plan_under_model_answers() {
        use crate::answer_plan::{Plan, Shape, SplitAsk, SplitReply};
        let _command = crate::group_guard::command_for_test("investigate");
        struct Splits(Mutex<Vec<Value>>);
        impl Catalogue for Splits {
            fn top5(&self, _: &str, _: &[String], _: bool, _: Option<i32>, _: Option<i32>) -> Ranking {
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
            fn split_ask(&self, _: &str) -> Option<SplitAsk> {
                self.0.lock().unwrap().push(json!({"group": "knowledge", "request": "split_ask"}));
                Some(SplitAsk {
                    offered: vec![(Shape::RankCompare, Some("是不是也")), (Shape::ThresholdTime, None), (Shape::TotalToParts, None)],
                    quantities: vec![("population".into(), "人口".into()), ("gdp_pc".into(), "人均GDP".into())],
                })
            }
            fn answer_plan(&self, _: &str, reply: &SplitReply) -> Option<Result<Plan, String>> {
                self.0.lock().unwrap().push(json!({"group": "knowledge", "request": "answer_plan"}));
                assert_eq!(reply, &SplitReply { number: 1, quantities: vec![1, 0] });
                Some(Ok(Plan { blocks: Vec::new(), partial: false }))
            }
        }
        for (answer, planned) in [(json!({"step": "split", "split": 1, "quantities": [1, 0]}), true), (split_answer(0), false)] {
            let catalogue = Splits(Mutex::new(Vec::new()));
            let run = tempfile::tempdir().unwrap();
            let (events, mut sink) = collector();
            // the first split answer names a quantity twice and is refused; the second is taken
            let mut model = ScriptedAsker::new(vec![
                search_reply(),
                call("toolu_x0", json!({"step": "split", "split": 1, "quantities": [0, 0]})),
                call("toolu_x1", answer.clone()),
            ]);
            let cancel = AtomicBool::new(false);
            let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
            recorder.ask_step(&mut model, &Ask::Search, "search", &cancel).await.unwrap();
            let plan = split_step(&mut recorder, &mut model, "人最多的，是不是也最富？", &catalogue, &cancel).await.unwrap();
            drop(recorder);
            assert_eq!(plan.is_some(), planned, "{answer}");
            let kept = of_type(&events, PLAN_EVENT);
            assert_eq!(kept.len(), 1, "{kept:?}");
            assert_eq!(kept[0]["reply"]["number"], answer["split"]);
            assert_eq!(kept[0]["plan"].is_null(), !planned);
            let calls = of_type(&events, GROUP_CALL_EVENT);
            assert_eq!(calls.len(), if planned { 2 } else { 1 }, "{calls:?}");
            assert!(calls.iter().all(|c| c["auto_parent_call_id"].is_string()), "{calls:?}");
        }
        // a catalogue that reads no splits: nothing asked, nothing kept
        struct NoSplits;
        impl Catalogue for NoSplits {
            fn top5(&self, _: &str, _: &[String], _: bool, _: Option<i32>, _: Option<i32>) -> Ranking {
                unreachable!()
            }
            fn places_outside(&self, _: &str, _: &[String]) -> Vec<String> {
                unreachable!()
            }
            fn source(&self) -> &Value {
                unreachable!()
            }
        }
        let catalogue = NoSplits;
        let run = tempfile::tempdir().unwrap();
        let (events, mut sink) = collector();
        let mut model = ScriptedAsker::new(vec![search_reply()]);
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        recorder.ask_step(&mut model, &Ask::Search, "search", &cancel).await.unwrap();
        assert!(split_step(&mut recorder, &mut model, "德国的人口", &catalogue, &cancel).await.unwrap().is_none());
        drop(recorder);
        assert!(of_type(&events, PLAN_EVENT).is_empty());
    }

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
            fn top5(&self, _: &str, _: &[String], _: bool, _: Option<i32>, _: Option<i32>) -> Ranking {
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
        fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking {
            self.0.top5(question_zh, texts, months, latest_year, first_year)
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
            // table 2 is nrg_bal_peh; t1.years is no item (the tables are annual: their years are the program's)
            call(
                "toolu_t0",
                json!({"step": "table", "pick": [2], "params": {"t1.years": 1}}),
            ),
            call(
                "toolu_t",
                json!({"step": "table", "pick": [2], "params": {"t2.breakdown": 3, "t2.nrg_bal": 1}}),
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
                {"dimension": "siec", "values": ["TOTAL", "G3000", "RA000"]},
                {"dimension": "unit", "values": ["GWH"]}, {"dimension": "geo", "values": ["DE"]}],
                "years": {"start": 2015, "end": 2024}})
        );
        let events = events.lock().unwrap();
        let params = events.iter().find(|e| e["type"] == PARAMS_EVENT).unwrap();
        assert_eq!(params["params"], "model");
        // the siec split draws with ten years, so the program gives it no years option of its own
        assert_eq!(params["picks"], json!({"t2.breakdown": 3, "t2.nrg_bal": 1}));
        assert_eq!(params["tables"][0]["years"]["rule"], "annual");
        // siec's parts are registered (estat-parts.tsv), so the split fetches the ones the table lists, in the file's order
        assert_eq!(params["tables"][0]["open"], Value::Null);
        assert_eq!(params["tables"][0]["parts"][0]["codes"], 3);
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
        fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking {
            self.0.top5(question_zh, texts, months, latest_year, first_year)
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

    /// q3's stop at the fetch (10-31: every probe past HELD_TIMEOUT, so nothing refused TOTAL in PC before it): the fetch's
    /// no row refuses that answer through the table pick's own check, with what is allowed and an example; the same answer
    /// again is refused by the check, and the one after it fetches. The probe here answers 400 (unprobed).
    #[tokio::test]
    async fn a_pick_fetched_with_no_row_is_refused_once_and_picked_again() {
        let _command = crate::group_guard::command_for_test("investigate");
        let catalogue = q3_probing(Some((400, "<S:Fault/>")));
        let run = tempfile::tempdir().unwrap();
        write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
        let (events, mut sink) = collector();
        let in_pc = json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1, "t2.unit": 2}});
        let mut model = ScriptedAsker::new(vec![
            search_reply(),
            call("toolu_t", in_pc.clone()),
            call("toolu_t1", in_pc),
            call(
                "toolu_t2",
                json!({"step": "table", "pick": [2], "params": {"t2.years": 1, "t2.breakdown": 1, "t2.unit": 1}}),
            ),
            call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
        ]);
        let mut tools = claims_tools();
        tools.details.push_front(json!({"mode": "no_rows", "text": "These codes have no values in these years."}));
        let cancel = AtomicBool::new(false);
        let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
        let result = prepare_claims(&mut recorder, &mut model, &mut tools, "德国各能源发电量", &[], &catalogue, &cancel).await;
        let history = serde_json::to_string(recorder.history()).unwrap();
        drop(recorder);
        result.unwrap();
        assert_eq!(of_type(&events, HELD_EVENT)[0]["tables"][1]["unprobed"], "HTTP 400");
        let refused = "t2: the fetch of siec=TOTAL, unit=PC came back with no row (fetched after the pick)";
        assert_eq!(history.matches(refused).count(), 2, "once after the fetch, once by the check: {history}");
        assert!(history.contains("The table pick was fetched and refused"), "{history}");
        let unit = |args: &Value| args["filters"].as_array().unwrap().iter().find(|f| f["dimension"] == "unit").unwrap()["values"].clone();
        assert_eq!(tools.args.len(), 3, "the fetch of no row, the fetch after the second pick, the claims");
        assert_eq!((unit(&tools.args[0]), unit(&tools.args[1])), (json!(["PC"]), json!(["GWH"])));
        let repick = of_type(&events, REPICK_EVENT);
        assert_eq!(repick.len(), 1);
        assert_eq!((repick[0]["dataset"].as_str(), &repick[0]["table"]), (Some("nrg_bal_peh"), &json!(2)));
        assert_eq!(repick[0]["params"], json!({"t2.breakdown": 1, "t2.unit": 2, "t2.years": 1}));
    }

    /// Another table and dimension with holes, which no probe covers (an annual table with no probe): heat in nrg_bal
    /// fetched with no row is refused once and the pick asked again; when the second pick's fetch has no row either, the
    /// table stops as before, after two fetches and one repick (a no row is never taken as rows).
    #[tokio::test]
    async fn a_second_fetch_with_no_row_stops_as_before() {
        let _command = crate::group_guard::command_for_test("investigate");
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
                .map(|(d, codes)| (d.to_string(), codes.into_iter().map(|c| (c.to_string(), String::new())).collect()))
                .collect(),
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        let catalogue = WithTable(
            FakeCatalogue { candidates: offers(), uncovered: None, source: json!({}), searched: Default::default() },
            meta,
        );
        let no_row = || json!({"mode": "no_rows", "text": "These codes have no values in these years."});
        for second in [json!({"mode": "candidates", "sheet": SHEET_A, "conclusions": 3}), no_row()] {
            let run = tempfile::tempdir().unwrap();
            write_sheet(run.path(), SHEET_A, &["c1", "c2", "c3"]);
            let (events, mut sink) = collector();
            let mut model = ScriptedAsker::new(vec![
                search_reply(),
                call("toolu_t", json!({"step": "table", "pick": [2], "params": {"t2.breakdown": 3, "t2.nrg_bal": 2}})),
                call("toolu_t2", json!({"step": "table", "pick": [2], "params": {"t2.breakdown": 3, "t2.nrg_bal": 1}})),
                call("toolu_c", json!({"step": "claims", "pick": [1, 2, 3]})),
            ]);
            let stops = second["mode"] == "no_rows";
            let mut tools = ScriptedTools {
                details: vec![
                    no_row(),
                    second,
                    json!({"mode": "picks", "claims": [{"candidate": "c1", "claim_id": "k1"}, {"candidate": "c2", "claim_id": "k2"}, {"candidate": "c3", "claim_id": "k3"}]}),
                ]
                .into(),
                args: Vec::new(),
            };
            let cancel = AtomicBool::new(false);
            let mut recorder = Recorder::new(&mut sink, run.path(), Vec::new(), Vec::new());
            let result = prepare_claims(&mut recorder, &mut model, &mut tools, "德国的发电结构", &[], &catalogue, &cancel).await;
            let history = serde_json::to_string(recorder.history()).unwrap();
            drop(recorder);
            assert!(of_type(&events, HELD_EVENT).is_empty(), "this catalogue probes nothing");
            assert!(history.contains("came back with no row (fetched after the pick)"), "{history}");
            let nrg_bal =
                |args: &Value| args["filters"].as_array().unwrap().iter().find(|f| f["dimension"] == "nrg_bal").unwrap()["values"].clone();
            assert_eq!((nrg_bal(&tools.args[0]), nrg_bal(&tools.args[1])), (json!(["GHP"]), json!(["GEP"])));
            assert_eq!(of_type(&events, REPICK_EVENT).len(), 1);
            if stops {
                assert!(
                    matches!(&result, Err(Stop::NotPrepared { mode, .. }) if mode == "no_rows"),
                    "{result:?}"
                );
                assert_eq!(tools.args.len(), 2, "two fetches, no third pick");
            } else {
                result.unwrap();
                assert_eq!(tools.args.len(), 3);
            }
        }
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

    /// Measurement, not a check (ignored; the catalogue's env as for a run): over recorded runs (NEXT_FILL_RUNS=<events.jsonl>,..)
    /// the places the question names as this build reads them, and for each of the five tables the run's catalogue step
    /// listed, the place filters the fetch would ask for with the default picks (or why the fill refuses), one line each.
    #[test]
    #[ignore]
    fn measure_fill_places_over_recorded_runs() {
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let this_year = chrono::Datelike::year(&chrono::Local::now());
        for path in std::env::var("NEXT_FILL_RUNS").unwrap().split(',') {
            let text = std::fs::read_to_string(path).unwrap();
            let Some(event) = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|e| e["type"] == CATALOGUE_EVENT) else {
                println!("FILL\t{path}\tno catalogue event");
                continue;
            };
            let question = event["question"].as_str().unwrap_or_default();
            let texts: Vec<String> = serde_json::from_value(event["texts"].clone()).unwrap_or_default();
            let places = catalogue.places(question);
            println!("PLACES\t{question}\t{places:?}");
            let ids = event["ranking"]["candidates"].as_array().into_iter().flatten().take(OFFERED_TABLES).filter_map(|c| c["id"].as_str());
            for id in ids {
                let Some(meta) = catalogue.table(id) else {
                    println!("FILL\t{id}\tno meta");
                    continue;
                };
                let draft = next_params::draft(meta, &texts, &places);
                match next_params::fill(&draft, 1, &BTreeMap::new(), &places, this_year) {
                    Ok(filled) => {
                        let place_filters: Vec<String> = filled.args["filters"].as_array().into_iter().flatten()
                            .filter(|f| matches!(f["dimension"].as_str(), Some("geo" | "country" | "partner" | "c_orig" | "c_dest")))
                            .map(|f| format!("{}={}", f["dimension"].as_str().unwrap_or(""), f["values"]))
                            .collect();
                        println!("FILL\t{id}\t{}", place_filters.join(" "));
                    }
                    Err(why) => println!("FILL\t{id}\trefused: {}", why.chars().take(160).collect::<String>()),
                }
            }
        }
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
        fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking {
            self.0.top5(question_zh, texts, months, latest_year, first_year)
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
                // the table is annual: its years are the program's, no item of the answer
                json!({"step": "table", "pick": [1], "params": {"t1.nrg_bal": 1}}),
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
            let ranking = catalogue.top5(
                question,
                &texts,
                next_params::question_months(question),
                next_params::question_latest_year(question, this_year),
                next_params::question_first_year(question, this_year),
            );
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
        let (sources, tools) = flow_sources_and_tools("knowledge");
        assert!(tool_names(&sources, &tools)
            .iter()
            .any(|n| n == "DATA_PREPARE_TOOL"));
        // the check sees a direct run, a lent host called on the spot, and a tool name bound by let first, the name also through
        // a constant of another group's tool (planted with it: the visual group names no host tool of its own)
        let critic = "const VISION_CRITIC_TOOL: &str = \"newsroom_infographic_vision_critic\";\n";
        for planted in [
            "fn f() { recorder.auto(tools, DATA_PREPARE_TOOL, json!({}), cancel) }".to_string(),
            format!("{critic}fn f() {{ let run = lend(tools, cancel)(VISION_CRITIC_TOOL, json!({{}})); }}"),
            "fn f() { let run = lend(tools, cancel)(\"anything\", json!({})); }".to_string(),
            format!("{critic}fn f() {{\n    let tool = VISION_CRITIC_TOOL;\n    recorder.auto(tools, tool, json!({{}}), cancel)\n}}"),
            format!("{critic}fn f() {{\n    let tool: &str = crate::next_visual::VISION_CRITIC_TOOL;\n    recorder.auto(tools, tool, json!({{}}), cancel)\n}}"),
        ] {
            let mut planted_sources = sources.clone();
            planted_sources.push(("planted".into(), planted.clone()));
            let mut all_tools = tools.clone();
            all_tools.push("newsroom_infographic_vision_critic".into());
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
        let run = door_run(&calls, "knowledge", DATA_PREPARE_TOOL, &json!({}), run);
        assert!(calls.lock().unwrap().is_empty());
        run.await;
        let kept = calls.lock().unwrap().clone();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["group"], "knowledge");
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
        fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking {
            self.0.top5(question_zh, texts, months, latest_year, first_year)
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
                    via: None,
                })
                .collect())
        }
        fn companions(
            &self,
            main: &str,
            rows: &BTreeMap<String, Vec<next_knowledge::CompanionRow>>,
        ) -> (Vec<next_knowledge::Companion>, Vec<(String, next_knowledge::DropWhy)>) {
            assert!(rows.contains_key(main));
            let kept = rows.keys()
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
                .collect();
            (kept, Vec::new())
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
                companion_args(&main, None, &table(&[("geo", &["DE", "FR", "EA21"])]), None).unwrap()
            ),
            json!({"dataset": "b", "filters": [{"dimension": "geo", "values": ["DE", "EA21"]}], "years": {"start": 2024, "end": 2024}})
        );
        // no shared place, or a shared dimension with none of the main's codes: not fetched rather than fetched open
        assert_eq!(
            companion_args(&main, None, &table(&[("geo", &["FR"])]), None),
            None
        );
        assert_eq!(
            companion_args(&main, None, &table(&[("geo", &["DE"]), ("sex", &["T"])]), None),
            None
        );
        // a companion lacking the main's place dimension is not fetched rather than fetched for every place
        assert_eq!(companion_args(&main, None, &table(&[("unit", &["PC"])]), None), None);
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
            Value::Object(companion_args(&main, Some(&cut), &companion, None).unwrap()),
            json!({"dataset": "b", "filters": [{"dimension": "sex", "values": ["T"]}, {"dimension": "citizen", "values": ["SY", "VE", "TOTAL"]}],
                "years": {"start": 2024, "end": 2024}}),
            "only the cut codes it lists; its own added dimension stays open"
        );
        assert_eq!(
            companion_args(
                &main,
                Some(&cut),
                &meta(false, &[("citizen", &["IQ"])], &[]),
                None
            ),
            None,
            "none of the cut codes: not fetched rather than fetched open"
        );
        let without = meta(false, &[("sex", &["T"]), ("geo", &["DE"])], &[]);
        assert_eq!(
            companion_args(&main, Some(&cut), &without, None),
            companion_args(&main, None, &without, None),
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
            Value::Object(companion_args(&main, Some(&cut), &sibling, None).unwrap()),
            json!({"provider": "worldbank", "dataset": "b", "filters": [{"dimension": "country", "values": ["JPN", "DEU"]}],
                "years": {"start": 2016, "end": 2025}})
        );
        assert_eq!(
            companion_args(&main, Some(&cut), &meta(true, &[], &[("FR", "FRA")]), None),
            None
        );
        // World Bank (r1): the countries the main was fixed to by a filter go to a World Bank companion as they are, and
        // the cut, when there is one on the same dimension, in their place; a Eurostat companion has no country dimension
        // and is not fetched rather than fetched for every place
        let fixed: Map<String, Value> = serde_json::from_value(json!({"provider": "worldbank", "dataset": "SH.XPD.CHEX.PC.CD",
            "filters": [{"dimension": "country", "values": ["AUT", "BEL", "EUU"]}], "years": {"start": 2015, "end": 2024}}))
        .unwrap();
        assert_eq!(
            Value::Object(companion_args(&fixed, None, &sibling, None).unwrap()),
            json!({"provider": "worldbank", "dataset": "b", "filters": [{"dimension": "country", "values": ["AUT", "BEL", "EUU"]}],
                "years": {"start": 2015, "end": 2024}})
        );
        let mut fixed_cut = fixed.clone();
        fixed_cut.insert("narrow".into(), main["narrow"].clone());
        assert_eq!(
            Value::Object(companion_args(&fixed_cut, Some(&cut), &sibling, None).unwrap()),
            json!({"provider": "worldbank", "dataset": "b", "filters": [{"dimension": "country", "values": ["JPN", "DEU"]}],
                "years": {"start": 2015, "end": 2024}})
        );
        assert_eq!(companion_args(&fixed, None, &meta(false, &[("geo", &["AT", "BE"])], &[]), None), None);
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
            None,
            "data/main.csv",
            1,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        drop(recorder);
        assert_eq!(tools.args.len(), 2);
        // Room for one: the by-month twin takes its own place, so the one that adds a dimension stays too.
        assert_eq!(kept.len(), 2);
        assert_eq!(
            of_type(&events, COMPANION_EVENT)[0]["kept"]
                .as_array()
                .unwrap()
                .len(),
            2
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

    /// The same echo page published into the run folder at `root`: as "column", the one recipe folder the visual door is
    /// measured for, through an open door; as "leaf", a folder outside its paths, through the real table (closed).
    fn publish_into(root: &Path, open: bool, qa: &str) -> Result<Published, String> {
        publish_layers(root, open, qa, json!({}))
    }

    /// The same, the svg layer's knobs `events` (what it says it dropped, say).
    fn publish_layers(root: &Path, open: bool, qa: &str, events: Value) -> Result<Published, String> {
        use crate::next_leaf::{Layer, Runner};
        let _command = crate::group_guard::command_for_test("investigate");
        let _doors = crate::group_guard::doors_for_test(open);
        let draw = Runner::python(Path::new("fixtures/next_leaf/echo.py"));
        let bake = Runner::python(Path::new("fixtures/next_leaf/bake_twin.py"));
        let mut check = Runner::python(Path::new("fixtures/next_visual/qa_twin.py"));
        check.args.push(qa.into());
        let layers = [
            Layer::twin("echo", "events", events),
            Layer::twin("echo", "legend", json!({"html": "<div>图例</div>"})),
        ];
        let spec = crate::next_facts::Spec {
            facts: Vec::new(),
            fmts: json!({}),
            members: None,
            asked_places: None,
            basis: None,
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
            strip: None,
        };
        let plan = json!({"kind": "leaf_plan", "recipe": "column"});
        publish_leaf_page(&Mutex::new(Vec::new()), root, if open { "column" } else { "leaf" }, (&page, &plan), &check)
    }

    /// The visual door is measured for publications/column/ and publications/qa/column/ only, so a page under any other name is
    /// refused: no page, no report, no manifest, nothing counted. Through the door, the baked bytes are written once, the PASS
    /// report names their sha256 and the manifest binds them.
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
            serde_json::from_str(&std::fs::read_to_string(bundle.dir.join("publications/column/manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["html_ref"], "publications/column/index.html");
        assert_eq!(manifest["html_sha256"].as_str(), Some(published.html_sha256.as_str()));
        assert_eq!(bundle.measured_publication_gap().unwrap(), None);

        std::fs::write(bundle.dir.join(&published.html_ref), html.replacen("图例", "图列", 1)).unwrap();
        assert!(bundle.measured_publication_gap().unwrap().is_some(), "a byte changed after the PASS is not published");
    }

    /// A layer that could not place either of its two notes (it draws nothing) does not stop the page: it is published, and
    /// its request's ledger holds exactly the two, each as a never-printed dropped entry with why, and nothing else beside the
    /// page's own entries.
    #[test]
    fn a_leaf_page_with_dropped_notes_is_published_and_its_ledger_names_them() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = {
            let _command = crate::group_guard::command_for_test("investigate");
            crate::artifact::InvestigationBundle::create(dir.path(), "leaf page").unwrap()
        };
        let events = json!({"dropped": [{"id": "AT", "why": "no free place for the note"}, {"id": "LU", "why": "past label_count"}]});
        let published = publish_layers(&bundle.dir, true, "pass", events).unwrap();
        assert!(bundle.dir.join(&published.html_ref).is_file());
        assert_eq!(bundle.measured_publication_gap().unwrap(), None);
        let request: Value =
            serde_json::from_str(&std::fs::read_to_string(bundle.dir.join("publications/column").join(LEAF_REQUEST)).unwrap()).unwrap();
        assert_eq!(
            request["ledger"],
            json!({"dropped:events:AT": "no free place for the note", "dropped:events:LU": "past label_count"})
        );
        let html = std::fs::read_to_string(bundle.dir.join(&published.html_ref)).unwrap();
        assert!(!html.contains("dropped:") && !html.contains("no free place"), "a dropped entry is never printed");
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
            assert!(bundle.dir.join("publications/column/index.html").is_file(), "{qa}");
            assert_eq!(bundle.dir.join("publications/qa/column/browser-qa.json").is_file(), qa != "silent", "{qa}");
            assert!(!bundle.dir.join("publications/column/manifest.json").exists(), "{qa}");
            assert!(bundle.measured_publication_gap().unwrap().is_some(), "{qa}");
        }
    }

    /// A slug is published once: publishing to it again is refused before anything is drawn, so a check that leaves no report
    /// is never read as the earlier one, and a page that failed is not passed later under the same name.
    #[test]
    fn a_leaf_page_is_not_published_twice_under_one_name() {
        let (reply, bundle, _dir) = publish_with(true, "pass");
        let first = reply.unwrap();
        let files = ["publications/column/index.html", "publications/column/manifest.json", "publications/qa/column/browser-qa.json"];
        let read = |root: &Path| -> Vec<Vec<u8>> { files.iter().map(|f| std::fs::read(root.join(f)).unwrap()).collect() };
        let before = read(&bundle.dir);
        let why = publish_into(&bundle.dir, true, "silent").unwrap_err();
        assert!(why.contains("publications/column was written before"), "{why}");
        assert_eq!(read(&bundle.dir), before, "the refused publish changed nothing");
        assert_eq!(crate::hash::sha256_bytes(&before[0]), first.html_sha256);

        let (reply, bundle, _dir) = publish_with(true, "fail");
        assert!(reply.is_err());
        let why = publish_into(&bundle.dir, true, "pass").unwrap_err();
        assert!(why.contains("publications/column was written before"), "{why}");
        assert!(!bundle.dir.join("publications/column/manifest.json").exists());
        assert!(bundle.measured_publication_gap().unwrap().is_some());
    }

    /// Every file under `root` (run-folder relative, `/` separated) with its bytes, and every folder as "<rel>/" with none,
    /// since the guard judges a folder made as it judges a file written.
    fn files_of(root: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut dirs = vec![root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                if path.is_dir() {
                    files.insert(format!("{rel}/"), Vec::new());
                    dirs.push(path);
                } else {
                    files.insert(rel, std::fs::read(&path).unwrap());
                }
            }
        }
        files
    }

    /// The visual door's whole footprint (the condition for measuring its handoffs.rust row, 10-29): a publish, passing or not,
    /// adds or changes files only under publications/column/ and publications/qa/column/ of the run folder, and the page's plan
    /// publications/plans/column.json (no other file of publications/plans/); through a closed
    /// door (another name) the only change is the guard's own refusal record (and its runtime/ folder if new), grown by a line naming the door.
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
                let log = crate::group_guard::REFUSAL_LOG_PATH;
                assert!(touched.iter().all(|k| *k == log || (k.ends_with('/') && log.starts_with(k.as_str()))), "{qa}: a closed door changed {touched:?}");
                let earlier = before.get(log).map_or(&[][..], Vec::as_slice);
                assert!(after[log].starts_with(earlier), "{qa}: the refusal record was rewritten, not grown");
                let added = String::from_utf8_lossy(&after[log][earlier.len()..]).into_owned();
                assert!(added.contains("visual_command"), "{added}");
                continue;
            }
            // inside a folder, the plan itself, or a folder on the way to one (publications/, publications/qa/, publications/plans/ when new)
            let plan = crate::next_run::leaf_plan_ref("column");
            let within = |k: &str| {
                k == plan
                    || ["publications/column/", "publications/qa/column/", plan.as_str()]
                        .iter()
                        .any(|p| (k.ends_with('/') && p.starts_with(k)) || (p.ends_with('/') && k.starts_with(p)))
            };
            let outside: Vec<&&String> = touched.iter().filter(|k| !within(k)).collect();
            assert!(outside.is_empty(), "{open} {qa}: written outside the two folders and the plan {outside:?}");
            assert!(!touched.is_empty(), "{qa}: an open door wrote nothing");
        }
    }

    /// A catalogue whose geo EU27_2020 has members and whose shortlist holds an annual sibling and, with `twin`, a
    /// monthly twin; the knobs are the leaf registry's, through the visual door.
    struct HubTables {
        twin: bool,
        inner: FakeCatalogue,
    }

    impl Catalogue for HubTables {
        fn top5(&self, question_zh: &str, texts: &[String], months: bool, latest_year: Option<i32>, first_year: Option<i32>) -> Ranking {
            self.inner.top5(question_zh, texts, months, latest_year, first_year)
        }
        fn places_outside(&self, question_zh: &str, texts: &[String]) -> Vec<String> {
            self.inner.places_outside(question_zh, texts)
        }
        fn source(&self) -> &Value {
            self.inner.source()
        }
        fn places(&self, _question_zh: &str) -> Vec<Place> {
            vec![Place::Region]
        }
        fn members(&self, aggregate: &str) -> Result<Vec<String>, String> {
            match aggregate {
                "EU27_2020" => Ok(vec!["DE".into(), "FR".into()]),
                _ => Err(format!("{aggregate} has no members")),
            }
        }
        fn companion_shortlist(&self, _main: &str) -> Vec<(next_knowledge::CompanionCandidate, String)> {
            let candidate = |id: &str, grain| next_knowledge::CompanionCandidate { id: id.into(), adds: Vec::new(), grain };
            let mut shortlist = vec![(candidate("asy_x", None), "Another unit".to_string())];
            if self.twin {
                shortlist.push((candidate("asy_m", Some("M")), "Monthly applications".into()));
            }
            shortlist
        }
    }

    fn hub_table(freqs: &[(&str, &str, &str)]) -> TableMeta {
        let codes = |c: &[&str]| c.iter().map(|c| (c.to_string(), String::new())).collect();
        TableMeta {
            id: "asy_a".into(),
            worldbank: false,
            dims: vec![
                ("sex".into(), codes(&["T", "M", "F"])),
                ("geo".into(), codes(&["EU27_2020", "DE", "FR"])),
                ("citizen".into(), codes(&["TOTAL", "AF", "SY", "VE", "TR", "CO", "UA"])),
            ],
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: freqs.iter().map(|(f, a, b)| (f.to_string(), a.to_string(), b.to_string())).collect(),
            unit: None,
        }
    }

    /// Only an annual table whose shortlist has a monthly twin gets a window, for the answers whose geo is a hub: its numbers
    /// are the registry's ring knobs. A country geo, no twin, or a monthly main keeps the years item for every answer.
    #[test]
    fn only_a_hub_table_with_a_monthly_twin_gets_the_ring_s_window() {
        let window = |twin: bool, table: TableMeta, places: &[Place]| {
            let catalogue = HubTables { twin, inner: offers_catalogue() };
            let draft = next_params::draft(table, &[], places);
            ring_window(&draft, 1, places, 2026, &catalogue)
        };
        let region = [Place::Region];
        let ring = |only: Option<Vec<String>>| {
            Some(next_params::Window { years: 5, months: 60, hub: "EU27_2020".into(), twin: "asy_m".into(), only })
        };
        // geo holds the members too: no breakdown, or a split by sex, fetches the members; a split by citizen the hub.
        assert_eq!(window(true, hub_table(&[]), &region), ring(Some(vec!["citizen".into()])));
        // geo is the hub alone: every answer fetches it.
        let mut whole = hub_table(&[]);
        whole.dims[1].1.retain(|(c, _)| c == "EU27_2020");
        assert_eq!(window(true, whole, &region), ring(None));
        assert_eq!(window(false, hub_table(&[]), &region), None, "no monthly twin on the shortlist");
        assert_eq!(window(true, hub_table(&[]), &[Place::Country("DE".into())]), None, "geo DE is no hub");
        assert_eq!(window(true, hub_table(&[("M", "2008M01", "2026M08")]), &region), None, "a monthly main");
    }

    /// Replay (5c-2 part 2): for each stored run's question and tables (NEXT_WINDOW_CASES, a JSON list of {run, question,
    /// texts, tables}), the window ring_window gives each table with the real catalogue, and for a windowed one the main's
    /// and its monthly twin's fetch years before (the model's latest year, the twin copying it) and after. One JSON line each.
    #[test]
    #[ignore]
    fn replay_ring_window_over_recorded_runs() {
        let catalogue = GroupCatalogue::from_env(|key| std::env::var(key).ok()).unwrap();
        let this_year = chrono::Datelike::year(&chrono::Local::now());
        let cases: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(std::env::var("NEXT_WINDOW_CASES").unwrap()).unwrap()).unwrap();
        let (mut tables, mut windowed) = (0, 0);
        for case in &cases {
            let question = case["question"].as_str().unwrap();
            let texts: Vec<String> = serde_json::from_value(case["texts"].clone()).unwrap();
            let places = catalogue.places(question);
            for id in case["tables"].as_array().unwrap().iter().filter_map(Value::as_str) {
                let Some(meta) = catalogue.table(id) else {
                    continue;
                };
                tables += 1;
                let mut draft = next_params::draft(meta, &texts, &places);
                let window = ring_window(&draft, 1, &places, this_year, &catalogue);
                let mut line = json!({"run": case["run"], "table": id, "window": window.as_ref().map(|w| format!("{w:?}"))});
                if let Some(w) = window {
                    windowed += 1;
                    let mut picks = BTreeMap::from([("t1.years".to_string(), 1)]);
                    if let Some(dim) = w.only.as_ref().and_then(|o| o.first()) {
                        let k = draft.breakdown.iter().position(|d| d == dim).unwrap() + 2;
                        picks.insert("t1.breakdown".into(), k);
                    }
                    let before = next_params::fill(&draft, 1, &picks, &places, this_year).unwrap();
                    draft.window = Some(w.clone());
                    let after = next_params::fill(&draft, 1, &picks, &places, this_year).unwrap();
                    let twin = catalogue.table(&w.twin).unwrap();
                    let twin_years = |args: &Map<String, Value>, months| {
                        companion_args(args, None, &twin, months).map(|a| a["years"].clone())
                    };
                    line["main_years"] = json!({"before": before.args["years"], "after": after.args["years"]});
                    line["twin_years"] =
                        json!({"before": twin_years(&before.args, None), "after": twin_years(&after.args, Some(w.months))});
                    line["after_event"] = after.event["years"].clone();
                }
                println!("{line}");
            }
        }
        println!("{}", json!({"cases": cases.len(), "tables": tables, "windowed": windowed}));
    }

    /// A window on the citizen split only goes to the step of that answer: no breakdown (or sex) fetches the main for the
    /// years item and its twin for the main's years, not ring.months.
    #[test]
    fn a_split_window_follows_the_breakdown_picked() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (_events, mut sink) = collector();
        let mut recorder = Recorder::new(&mut sink, dir.path(), Vec::new(), Vec::new());
        recorder.parent = Some("toolu_t".into());
        let catalogue = HubTables { twin: true, inner: offers_catalogue() };
        let window = next_params::Window {
            years: 5,
            months: 60,
            hub: "EU27_2020".into(),
            twin: "asy_m".into(),
            only: Some(vec!["citizen".into()]),
        };
        let draft = next_params::Draft { window: Some(window.clone()), ..next_params::draft(hub_table(&[]), &[], &[Place::Region]) };
        let citizen = draft.breakdown.iter().position(|d| d == "citizen").unwrap() + 2;
        let id = "asy_a".to_string();
        let drafts = [(&id, Some(draft))];
        let twin = TableMeta { id: "asy_m".into(), ..hub_table(&[("M", "2008M01", "2026M08")]) };
        let mut step = |breakdown: usize| {
            let params = BTreeMap::from([("t1.breakdown".to_string(), breakdown), ("t1.years".to_string(), 1)]);
            fill_steps(&mut recorder, "q", &[1], &drafts, &params, &catalogue).unwrap().remove(0)
        };
        let split = step(citizen);
        assert_eq!(split.window, Some(window));
        assert_eq!(split.args["years"], json!({"start": 2020, "end": 2024}));
        let none = step(1);
        assert_eq!(none.window, None);
        assert_eq!(none.args["years"], json!({"start": 2024, "end": 2024}));
        let twin_years = companion_args(&none.args, None, &twin, none.window.as_ref().map(|w| w.months)).unwrap()["years"].clone();
        assert_eq!(twin_years, none.args["years"]);
    }

    /// With the main's window, a monthly twin is fetched for the years holding ring.months months up to its last month;
    /// without one, or with no monthly span in the catalogue, it takes the main's years as before.
    #[test]
    fn a_monthly_twin_is_fetched_for_the_ring_s_months() {
        let main: Map<String, Value> = serde_json::from_value(json!({"dataset": "asy_a", "years": {"start": 2020, "end": 2024}})).unwrap();
        let twin = TableMeta { id: "asy_m".into(), ..hub_table(&[("M", "2008M01", "2026M08")]) };
        let years = |table: &TableMeta, months| companion_args(&main, None, table, months).unwrap()["years"].clone();
        assert_eq!(years(&twin, Some(60)), json!({"start": 2021, "end": 2026}));
        assert_eq!(years(&twin, Some(24)), json!({"start": 2024, "end": 2026}));
        assert_eq!(years(&twin, None), json!({"start": 2020, "end": 2024}));
        assert_eq!(years(&hub_table(&[]), Some(60)), json!({"start": 2020, "end": 2024}), "no monthly span");
    }

    /// TOTAL and `count` two-letter codes: a place dimension (next_params::place_like) that has a total.
    fn place_codes(count: usize) -> Vec<(String, String)> {
        std::iter::once("TOTAL".to_string())
            .chain((b'A'..=b'Z').flat_map(|a| (b'A'..=b'Z').map(move |b| String::from_utf8(vec![a, b]).unwrap())).take(count))
            .map(|c| (c, String::new()))
            .collect()
    }

    /// The ring's window (the leaf registry's 5 years and 60 months) on the splits `only`.
    fn ring_on(only: Option<&[&str]>) -> next_params::Window {
        next_params::Window {
            years: 5,
            months: 60,
            hub: "EU27_2020".into(),
            twin: "asy_m".into(),
            only: only.map(|o| o.iter().map(|d| d.to_string()).collect()),
        }
    }

    /// drawable_splits on table 1 of a region question, with the window `window`.
    fn splits_with(draft: &mut next_params::Draft, window: next_params::Window) -> (Vec<Split>, Value) {
        let _command = crate::group_guard::command_for_test("investigate");
        let catalogue = HubTables { twin: true, inner: offers_catalogue() };
        draft.window = Some(window);
        drawable_splits(draft, 1, &[Place::Region], 2026, &catalogue)
    }

    /// The fetch an answer with this split gets, its years as the program gives them (Split::program_years).
    fn split_fetch(draft: &next_params::Draft, split: &Split) -> next_params::Filled {
        let mut picks = BTreeMap::from([("t1.breakdown".to_string(), split.option)]);
        if let Some(y) = split.program_years() {
            picks.insert("t1.years".into(), y);
        }
        next_params::fill(draft, 1, &picks, &[Place::Region], 2026).unwrap()
    }

    /// q2 (德国能源从来源到各部门) as the 10-31 stand-in's table pick held nrg_bal_s for DE: the pick offered splits by nrg_bal and
    /// by siec only, so a fuel x sector flow was never asked for. The table's flow is registered (estat-parts.tsv: siec -> nrg_bal),
    /// so a third split is offered, for the latest year only (with ten years a third dimension varies, which no flow holds): its
    /// fetch is ranked against the flow recipe's sankey alone, and the answer fills both dimensions with the registered
    /// leaves the flow asks for (nuclear heat left out by the registry), none open.
    #[test]
    fn q2_s_flow_split_is_offered_for_the_latest_year_and_fills_both_part_lists() {
        let _command = crate::group_guard::command_for_test("investigate");
        let codes = |c: &[&str]| c.iter().map(|c| (c.to_string(), String::new())).collect();
        let table = |id: &str| TableMeta {
            id: id.into(),
            worldbank: false,
            dims: vec![
                ("geo".into(), codes(&["EU27_2020", "DE", "FR"])),
                ("nrg_bal".into(), codes(&["PPRD", "GIC", "FC_E", "FC_IND_E", "FC_TRA_E", "FC_OTH_E", "FC_OTH_CP_E", "FC_OTH_HH_E",
                    "FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"])),
                ("siec".into(), codes(&["TOTAL", "C0000X0350-0370", "C0350-0370", "P1000", "S2000", "G3000", "O4000XBIO", "RA000",
                    "W6100_6220", "N900H", "E7000", "H8000"])),
                ("unit".into(), codes(&["KTOE", "GWH", "TJ"])),
            ],
            end_year: Some(2024),
            places: Vec::new(),
            place_members: Vec::new(),
            freqs: Vec::new(),
            unit: None,
        };
        let de = [Place::Country("DE".into())];
        let catalogue = offers_catalogue();
        let mut draft = next_params::draft(table("nrg_bal_s"), &[], &de);
        let (splits, event) = drawable_splits(&mut draft, 1, &de, 2026, &catalogue);
        assert_eq!(event["dropped"], json!([]));
        // nrg_bal is a member item (no total code), so the flow leaves t1.nrg_bal out as its own split does
        assert_eq!(event["offered"][2], json!({"option": 4, "dim": "siec>nrg_bal", "years": [1], "member": true}));
        let flow = &splits[2];
        let mut picks = BTreeMap::from([("t1.breakdown".to_string(), flow.option), ("t1.unit".to_string(), 1)]);
        picks.insert("t1.years".into(), flow.program_years().unwrap());
        let filled = next_params::fill(&draft, 1, &picks, &de, 2026).unwrap();
        let values = |dim: &str| {
            filled.args["filters"].as_array().unwrap().iter().find(|f| f["dimension"] == dim).map(|f| f["values"].clone())
        };
        // the leaves the flow asks for: nuclear heat is left out by the registry, so 10 x 7
        let leaves = |dim: &str| json!(next_params::flow_asked("nrg_bal_s", dim).unwrap().into_iter().map(|p| p.code).collect::<Vec<_>>());
        assert_eq!(values("siec"), Some(leaves("siec")));
        assert_eq!(values("nrg_bal"), Some(leaves("nrg_bal")));
        assert_eq!(values("geo"), Some(json!(["DE"])));
        assert_eq!(filled.args["years"], json!({"start": 2024, "end": 2024}));
        assert_eq!(filled.event["open"], Value::Null);
        assert_eq!(filled.event["estimate"], 70);
        // the same table under an id with no registered flow is offered the two splits it had
        let mut plain = next_params::draft(table("nrg_x"), &[], &de);
        assert_eq!(plain.breakdown, ["nrg_bal", "siec"]);
        let (_, event) = drawable_splits(&mut plain, 1, &de, 2026, &catalogue);
        let dims: Vec<&Value> = event["offered"].as_array().unwrap().iter().map(|o| &o["dim"]).collect();
        assert_eq!(dims, [&json!("nrg_bal"), &json!("siec")]);
    }

    /// q6: a citizen split fetched for the hub over the ring's 5 years is narrowed to 16 citizens, 16 lines no line chart
    /// holds, so it fell back to the total. Without the window, for the table's last year, it is one varying dimension a
    /// ranking draws: the split is kept with years option 1, leaves the window, and the answer is filled for that one year.
    /// Red before: the split was dropped after the windowed try alone, so no split was offered.
    #[test]
    fn a_citizen_split_the_ring_window_refuses_is_kept_for_one_year() {
        let mut table = hub_table(&[]);
        table.dims[2] = ("citizen".into(), place_codes(100));
        let mut draft = next_params::draft(table, &[], &[Place::Region]);
        let (splits, event) = splits_with(&mut draft, ring_on(Some(&["citizen"][..])));
        assert_eq!(splits, vec![Split { option: 2, dim: "citizen".into(), years: vec![1], member: false }]);
        let tried = &event["offered"][0]["tried"];
        assert_eq!(tried[0]["window"], "ring");
        assert_eq!(tried[0]["shape"], json!([["citizen", 16], ["time", 5]]));
        assert!(tried[0]["rejected"].as_array().unwrap().contains(&json!("Change: 16 lines; at most 8")), "{tried}");
        assert_eq!(tried[1]["window"], "none");
        assert_eq!(tried[1]["shape"], json!([["citizen", 20]]));
        assert!(tried[1]["drawn"].as_array().unwrap().contains(&json!("horizontal_bar")), "{tried}");
        assert_eq!(event["dropped"][0]["dim"], "sex");
        // the only split on the window left it: no answer takes the ring's years
        assert_eq!(draft.window, None);
        assert_eq!(draft.breakdown, vec!["citizen".to_string()]);
        let fetch = split_fetch(&draft, &splits[0]);
        assert_eq!(fetch.args["years"], json!({"start": 2024, "end": 2024}));
        assert_eq!(fetch.window, None);
        assert_eq!(fetch.event["years"]["rule"], "split");
        let geo = fetch.args["filters"].as_array().unwrap().iter().find(|f| f["dimension"] == "geo").unwrap().clone();
        assert_eq!(geo["values"], json!(["EU27_2020"]));
    }

    /// The same rule on another split and another shape: a place dimension of 12 codes is not narrowed, so over 5 years it
    /// is 12 lines; for one year a ranking draws it. A second split on the window that draws over 5 years (7 citizens) keeps
    /// it, and only that split's answer takes the ring's years. Red before: the 12-code split was dropped (only citizen offered).
    #[test]
    fn another_place_split_the_ring_window_refuses_is_kept_for_one_year_and_the_others_keep_the_window() {
        let mut table = hub_table(&[]);
        table.dims.push(("c_birth".into(), place_codes(11)));
        let mut draft = next_params::draft(table, &[], &[Place::Region]);
        let (splits, event) = splits_with(&mut draft, ring_on(Some(&["citizen", "c_birth"][..])));
        assert_eq!(
            splits,
            vec![
                Split { option: 2, dim: "citizen".into(), years: Vec::new(), member: false },
                Split { option: 3, dim: "c_birth".into(), years: vec![1], member: false },
            ]
        );
        assert_eq!(event["offered"][0], json!({"option": 2, "dim": "citizen", "years": [], "member": false}));
        let tried = &event["offered"][1]["tried"];
        assert_eq!(tried[0]["shape"], json!([["c_birth", 12], ["time", 5]]));
        assert!(tried[0]["rejected"].as_array().unwrap().contains(&json!("Change: 12 lines; at most 8")), "{tried}");
        assert_eq!(tried[1]["shape"], json!([["c_birth", 12]]));
        assert_eq!(draft.window, Some(ring_on(Some(&["citizen"][..]))));
        assert_eq!(split_fetch(&draft, &splits[1]).args["years"], json!({"start": 2024, "end": 2024}));
        let citizen = split_fetch(&draft, &splits[0]);
        assert_eq!(citizen.args["years"], json!({"start": 2020, "end": 2024}));
        assert_eq!(citizen.window, Some(ring_on(Some(&["citizen"][..]))));
    }

    /// A split no filled template draws over the ring's years nor for one year (a named partner pair varies too) is still
    /// left out, its "why" holding both tries; the window is unchanged.
    #[test]
    fn a_split_refused_with_and_without_the_ring_window_is_dropped_with_both_reasons() {
        let mut table = hub_table(&[]);
        table.dims[2] = ("citizen".into(), place_codes(11));
        table.dims.insert(2, ("partner".into(), ["TOTAL", "CN", "US", "JP"].iter().map(|c| (c.to_string(), String::new())).collect()));
        let mut draft = next_params::draft(table, &[], &[Place::Region]);
        draft.named = vec![("partner".into(), vec![("CN".into(), "CN".into()), ("US".into(), "US".into())])];
        draft.breakdown.retain(|d| d != "partner");
        let (splits, event) = splits_with(&mut draft, ring_on(Some(&["citizen"][..])));
        assert_eq!(splits, Vec::new());
        let citizen = event["dropped"].as_array().unwrap().iter().find(|d| d["dim"] == "citizen").unwrap().clone();
        let why = citizen["why"].as_array().unwrap();
        assert_eq!(why.len(), 2, "{citizen}");
        assert_eq!(why[0]["window"], "ring");
        assert_eq!(why[0]["shape"], json!([["partner", 2], ["citizen", 12], ["time", 5]]));
        assert_eq!(why[1]["window"], "none");
        assert_eq!(why[1]["shape"], json!([["partner", 2], ["citizen", 12]]));
        assert!(why[1]["rejected"].as_array().unwrap().contains(&json!("Ranking: a bar ranking holds 1 varying dimension, not 2")), "{citizen}");
        assert_eq!(draft.window, Some(ring_on(Some(&["citizen"][..]))));
    }

    /// A split the ring's window draws is offered as before: no second try, no "tried", the window unchanged; the splits
    /// with no window keep their reasons with no "window" mark.
    #[test]
    fn a_split_the_ring_window_draws_is_offered_as_before() {
        let mut draft = next_params::draft(hub_table(&[]), &[], &[Place::Region]);
        let (splits, event) = splits_with(&mut draft, ring_on(Some(&["citizen"][..])));
        assert_eq!(splits, vec![Split { option: 2, dim: "citizen".into(), years: Vec::new(), member: false }]);
        assert_eq!(event["offered"], json!([{"option": 2, "dim": "citizen", "years": [], "member": false}]));
        assert_eq!(draft.window, Some(ring_on(Some(&["citizen"][..]))));
        let sex = &event["dropped"][0];
        assert_eq!(sex["dim"], "sex");
        assert!(sex["why"].as_array().unwrap().iter().all(|w| w.get("window").is_none()), "{sex}");
    }

    /// When every answer takes the window (a table of the hub alone), a split cannot leave it without taking the
    /// no-breakdown answer out too: a category split the ring refuses (13 ages over 5 years) is left out as before, the
    /// second try recorded as not possible, and the window is unchanged.
    #[test]
    fn a_split_cannot_leave_a_window_every_answer_takes() {
        let mut table = hub_table(&[]);
        table.dims[1].1.retain(|(c, _)| c == "EU27_2020");
        table.dims[2] = (
            "age".into(),
            std::iter::once("TOTAL".to_string())
                .chain((1..=12).map(|k| format!("Y{k:02}")))
                .map(|c| (c, String::new()))
                .collect(),
        );
        let mut draft = next_params::draft(table, &[], &[Place::Region]);
        let (splits, event) = splits_with(&mut draft, ring_on(None));
        assert_eq!(splits, vec![Split { option: 2, dim: "sex".into(), years: Vec::new(), member: false }]);
        let age = &event["dropped"][0];
        assert_eq!(age["dim"], "age");
        assert_eq!(age["why"][0]["shape"], json!([["age", 13], ["time", 5]]));
        assert_eq!(age["why"][1]["window"], "none");
        assert!(age["why"][1]["error"].as_str().unwrap().contains("every answer"), "{age}");
        assert_eq!(draft.window, Some(ring_on(None)));
    }
    /// Round 12 q3 (works/devset-v3/round12-audit.md): the stand-in reworded the label of a composition page into
    /// "各国发电结构以化石能源为主要构成", typing a part's name no placeholder gave, a finding the data does not hold (3 of
    /// the 20 drawn countries are above half). A reworded field types no drawn name the question does not write; a reworded
    /// title that names a drawn place or part says no standing of it. Two shapes: a composition's parts, a ranking's places.
    #[test]
    fn a_reworded_field_types_no_drawn_name_the_question_does_not_write_and_a_title_says_no_standing() {
        let ask = |drafts: &[&str], members: &[&str], question: &str| Ask::Text {
            fields: drafts.iter().enumerate().map(|(i, d)| ((i + 1).to_string(), d.to_string())).collect(),
            slots: Vec::new(),
            numbers: Vec::new(),
            periods: Vec::new(),
            changes: Vec::new(),
            levels: Vec::new(),
            scoped: Vec::new(),
            titles: vec!["1".to_string()],
            mark: String::new(),
            places: None,
            members: members.iter().map(|m| m.to_string()).collect(),
            unasked: members.iter().filter(|m| !question.contains(**m)).map(|m| m.to_string()).collect(),
        };
        let answer = |n: &str, t: &str| json!({"step": "text", "text": {n: t}, "names": {}});
        // the composition (q3): parts and places, none of them written by the question
        let parts = ask(
            &["整体的构成与份额", "{lead1.t}，图中各国中，{name.PL}{name.fossil}占比居首，为{comp_top}", "整体由哪些部分构成？"],
            &["化石能源", "可再生能源", "核能", "波兰", "法国"],
            "欧盟各国发电结构",
        );
        let refused = parts.check(&answer("1", "各国发电结构以化石能源为主要构成")).unwrap_err();
        assert!(refused.problem.starts_with("field '1': '化石能源' is a place or part the page draws"), "{}", refused.problem);
        assert!(refused.problem.contains("e.g. '整体的构成与份额'"), "{}", refused.problem);
        assert_eq!(refused.allowed["members"]["unasked"], json!(["化石能源", "可再生能源", "核能", "波兰", "法国"]));
        assert!(parts.check(&answer("3", "可再生能源占多大份额？")).is_err(), "any field, not only the title");
        assert_eq!(typed_member("可再生能源的份额", "整体", &["可再生能源".into(), "能源".into()]), Some("可再生能源".into()), "longest first");
        for passes in ["各国发电结构的构成", "欧盟各国发电结构", "{lead1.t}，{name.PL}{name.fossil}占比居首，为{comp_top}"] {
            let n = if passes.contains('{') { "2" } else { "1" };
            assert!(parts.check(&answer(n, passes)).is_ok(), "{passes}");
        }
        // the ranking (round 11 n4, n5, n44): places the question writes may be named, a title names no standing of them
        let places = ask(
            &["各方的高低排名", "{lead1.t}，{name.ZAF}最高，为{hi}", "读者想知道在同样的口径下谁领先、谁落后，差距有多大。"],
            &["南非", "意大利", "西班牙", "印度", "中国"],
            "南非和南欧国家的青年失业率，印度和中国",
        );
        for (claim, word) in [("南非的青年失业率明显偏高", "偏高"), ("印度增速领先，中国相对较慢", "领先"), ("南非青年失业率居首", "居首")] {
            let refused = places.check(&answer("1", claim)).unwrap_err();
            assert!(refused.problem.starts_with(&format!("field '1': '{word}' says where a place or part the title names stands")), "{}", refused.problem);
            assert!(refused.problem.contains("e.g. '各方的高低排名'"), "{}", refused.problem);
        }
        for label in ["印度和中国青年失业率的高低排名", "南非与南欧各国青年失业率", "少数地区明显偏高", "各国最低工资的高低排名"] {
            assert!(places.check(&answer("1", label)).is_ok(), "{label}");
        }
        // a field that is no title may name the question's places with any word; the draft's own words stay
        assert!(places.check(&answer("3", "读者想知道南非是否明显领先，印度处在什么位置。")).is_ok());
        assert!(places.check(&answer("3", "读者想知道意大利处在什么位置。")).is_err(), "a place the question does not write");
        assert_eq!(finding_word("南非领先", "谁领先、谁落后"), None, "a word the draft holds");
        // no names known (a run that does not pass them): no member check, as before
        let none = ask(&["各方的高低排名"], &[], "南非");
        assert!(none.check(&answer("1", "南非的青年失业率明显偏高")).is_ok());
        assert!(none.allowed().get("members").is_none() && none.allowed().get("title_findings").is_none());
        // a change page (round 9 e7, exam h6 and h10): a title says no place's direction; the label of the change passes
        let change = ask(&["各方的变化", "{lead1.t}"], &["中国", "越南", "墨西哥", "印度"], "中国、越南、墨西哥和印度");
        for (claim, word) in [("制造业占比：中国下降，越南上升", "上升"), ("墨西哥外资增加，印度减少", "增加"), ("中国排放大增", "大增")] {
            let refused = change.check(&answer("1", claim)).unwrap_err();
            assert!(refused.problem.starts_with(&format!("field '1': '{word}' says where")), "{}", refused.problem);
        }
        for label in ["中国与越南制造业占比的变化", "墨西哥和印度吸引外资的变化", "出口增加值的变化"] {
            assert!(change.check(&answer("1", label)).is_ok(), "{label}");
        }
        // the words are the knowledge group's list (title-findings-zh.json), read once
        assert!(["为主", "居前", "偏高", "领先", "下降", "增加"].iter().all(|w| finding_words().iter().any(|f| f == w)));
        // the rule goes to the model with the names, and every wording a rule suggests passes it
        let described = places.schema()["properties"]["text"]["description"].as_str().unwrap().to_string();
        assert!(described.contains(TITLE_FINDING_RULE) && described.contains(MEMBER_RULE), "{described}");
        for suggested in RULE_SUGGESTIONS {
            assert!(places.check(&answer("1", suggested)).is_ok(), "{suggested}");
        }
    }
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
        steps.push(PrepareStep { args, narrowed, window: None });
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

/// Every wording the rules above suggest (TYPED_NUMBER_RULE, CHANGE_TITLE_RULE, SCOPE_RULE, TITLE_RULE), and only those, each
/// of which must pass the text and the names checks it is offered for, the title's on every page kind among them. The rules
/// go to the model on every question, so each is topic-neutral: no place, measure or topic of any one page.
#[cfg(test)]
pub const RULE_SUGGESTIONS: [&str; 4] = ["各方数值的变化", "少数地区升幅居前", "各地的高低分布", "少数地区明显偏高"];
