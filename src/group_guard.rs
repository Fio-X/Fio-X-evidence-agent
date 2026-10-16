//! Rust side of NEWSROOM_GROUP_TOOLS (on unless exactly "0", #64 step 4): every file the program writes into a run folder is judged by the same table the Pi side reads
//! (`runtime/pi/groups.json`, `artifact_kinds`, included at build time; no second copy, no new dependency).
//!
//! The judge: the write's path gives its kind and owning group (first matching rule, exact or prefix); the writing group is the group of the current
//! command in `cli::command_groups()`, or the group of a hand-off writer (`as_writer`) the call site runs inside, with the asking command kept as
//! `requested_by` (K214: the writer, its group and the asking command must be a row of `handoffs.rust` in groups.json, else the write is refused). Owner equals writing group: allowed. Anything else is refused before the file is touched: a path in another group's kind, a path
//! no rule matches (待查), no command and no writer (no context is never a default allow), a path outside the run folder, a table that cannot be
//! read. Nothing here has a "let it through on error" branch.
//!
//! Off (the switch is not exactly "1"): every function below is the plain std::fs call, byte for byte the same behavior.
//! With the switch on, `NEWSROOM_GROUP_ENFORCE` must not be "0" (`startup_check`; on unless exactly "0" since #64 step 3), as on the Pi side.
//!
//! The only writes not judged (E1, fixed and pinned by a test): the program's own scratch folders for the recompute step
//! (`std::env::temp_dir()/newsroom-recompute-*`, outside the run folder). Reads are not judged (E2). Files a child process keeps inside
//! itself are not visible here (E3). The Rust commands do start one such child: `pi.rs` runs Pi with `--session-dir` pointing at `<run>/session/` (pi.rs:896-897; set at artifact.rs:202,
//! investigate.rs:453, continue_investigation.rs:345). The session files Pi writes there are E3 and are not judged here; Pi's own tools go through the Pi-side checks.

use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path};
use std::sync::{Mutex, OnceLock};

const GROUPS_JSON: &str = include_str!("../runtime/pi/groups.json");
pub const TOOLS_SWITCH: &str = "NEWSROOM_GROUP_TOOLS";
pub const ENFORCE_SWITCH: &str = "NEWSROOM_GROUP_ENFORCE";
/// `NEWSROOM_GROUP_CALL_REFUSE` is on unless it is exactly "0" (#64 step 2, #66 step 2). The hand-off to the group writers and the call record are always on: no variable turns them off.
pub const CALL_REFUSE_SWITCH: &str = "NEWSROOM_GROUP_CALL_REFUSE";
/// `NEWSROOM_GROUP_CALL_REFUSE_ALL` is on unless it is exactly "0" (#66 step 2); it needs the same chain as `CALL_REFUSE_SWITCH`.
pub const CALL_REFUSE_ALL_SWITCH: &str = "NEWSROOM_GROUP_CALL_REFUSE_ALL";
/// `NEWSROOM_GROUP_CALL_CHECK` is on unless it is exactly "0"; the refusal needs its rows.
pub const CALL_CHECK_SWITCH: &str = "NEWSROOM_GROUP_CALL_CHECK";
/// `NEWSROOM_GROUP_HANDOFF_OBSERVE=1` (exactly "1", default off): the command side's second gate (the `handoffs.rust` rows) only records, it never refuses.
pub const OBSERVE_SWITCH: &str = "NEWSROOM_GROUP_HANDOFF_OBSERVE";
/// Where the command-side hand-offs are recorded while the observe switch is on (one JSON line per hand-off write).
pub const OBSERVED_LOG_PATH: &str = "runtime/handoff-observed.jsonl";
/// `NEWSROOM_GROUP_EXEMPT_RECORD=1` (exactly "1", default off): a write that skips the judgement because of an exemption (`is_exempt`) is appended to the call report as one
/// `exempt_write` row. Record only: it never refuses and never changes a write.
pub const EXEMPT_RECORD_SWITCH: &str = "NEWSROOM_GROUP_EXEMPT_RECORD";
/// The call report the Pi side writes (same file); the exempt-write rows go here.
pub const CALL_REPORT_PATH: &str = "runtime/cross-call-report.jsonl";
/// Where a refused write is noted (same file the Pi side uses).
pub const REFUSAL_LOG_PATH: &str = "runtime/boundary-refusals.jsonl";
/// E1: the recompute scratch folders. Fixed prefix, pinned by a test.
pub const SCRATCH_PREFIX: &str = "newsroom-recompute-";

static COMMAND: OnceLock<(&'static str, Option<&'static str>)> = OnceLock::new();
static TABLE: OnceLock<Option<Table>> = OnceLock::new();
static EXEMPT_NOTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

thread_local! {
    static WRITER: RefCell<Option<Handoff>> = const { RefCell::new(None) };
}
#[cfg(test)]
type TestCommand = Option<(&'static str, Option<&'static str>)>;
#[cfg(test)]
thread_local! {
    static TEST_ACTIVE: RefCell<Option<bool>> = const { RefCell::new(None) };
    static TEST_OBSERVE: RefCell<Option<bool>> = const { RefCell::new(None) };
    static TEST_EXEMPT_RECORD: RefCell<Option<bool>> = const { RefCell::new(None) };
    static TEST_REVIEW_SPLIT: RefCell<Option<bool>> = const { RefCell::new(None) };
    static TEST_COMMAND: RefCell<Option<TestCommand>> = const { RefCell::new(None) };
    static TEST_TABLE: RefCell<Option<String>> = const { RefCell::new(None) };
    static TEST_LOG: RefCell<Vec<Verdict>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone, Copy)]
struct Handoff {
    group: &'static str,
    writer: &'static str,
    requested_by: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub path: String,
    pub kind: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub writer: Option<String>,
    pub requested_by: Option<String>,
    pub allowed: bool,
}

struct Rule {
    exact: Option<String>,
    prefix: Option<String>,
    kind: String,
    tag: Option<String>,
}

struct Table {
    rules: Vec<Rule>,
    owners: Vec<(String, String)>,
    /// `handoffs.rust` rows: (writer, group, commands that may ask for it; the not_measured ones are in `unmeasured`). Required: a table without them cannot be read.
    handoffs: Vec<(String, String, Vec<String>)>,
    // (writer, command) pairs a row keeps in not_measured: listed from reading the code, never seen in a run, refused until a run measures them
    unmeasured: Vec<(String, String)>,
    #[cfg_attr(not(test), allow(dead_code))]
    /// `handoffs.writers`: writer name -> its group (the tool-side writers a staged call may name).
    tool_writers: Vec<(String, String)>,
    /// `handoffs.rows`: (writer, paths, requesters, not_measured) for the tool-side writers; empty when a table has none.
    #[cfg_attr(not(test), allow(dead_code))]
    tool_rows: Vec<ToolRow>,
    /// `tools.<name>`: (tool, the reason its decision record is a model quality verdict, whether the status in its decision record is supplied by the model); for the report counts.
    #[cfg_attr(not(test), allow(dead_code))]
    tool_flags: Vec<(String, Option<String>, bool)>,
    /// `review_split` (NEWSROOM_REVIEW_SPLIT on (the default)): the draw tools, the review tools, the path prefixes of review records and the writer that moves a rejected manifest.
    draw_tools: Vec<String>,
    review_tools: Vec<String>,
    review_prefixes: Vec<String>,
    reject_writer: String,
    /// `boundary_report.note` and `.not_traced`, and `artifact_kinds.ownership` as it is: the fixed header of the boundary report.
    #[cfg_attr(not(test), allow(dead_code))]
    report_note: String,
    #[cfg_attr(not(test), allow(dead_code))]
    not_traced: Vec<String>,
    #[cfg_attr(not(test), allow(dead_code))]
    ownership: Value,
}

#[cfg_attr(not(test), allow(dead_code))]
struct ToolRow {
    writer: String,
    paths: Vec<String>,
    requesters: Vec<String>,
    not_measured: Vec<String>,
}

fn strings(row: &Value, key: &str) -> Vec<String> {
    row.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn parse_table(text: &str) -> Option<Table> {
    let value: Value = serde_json::from_str(text).ok()?;
    let kinds = value.get("artifact_kinds")?;
    let owners = kinds
        .get("ownership")?
        .as_object()?
        .iter()
        .filter_map(|(kind, row)| Some((kind.clone(), row.get("owner")?.as_str()?.to_string())))
        .collect();
    let rules = kinds
        .get("rules")?
        .as_array()?
        .iter()
        .map(|row| {
            Some(Rule {
                exact: row.get("exact").and_then(Value::as_str).map(str::to_string),
                prefix: row
                    .get("prefix")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                kind: row.get("kind")?.as_str()?.to_string(),
                tag: row.get("tag").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let handoffs = value
        .get("handoffs")?
        .get("rust")?
        .as_array()?
        .iter()
        .map(|row| {
            let commands: Vec<String> = row
                .get("commands")?
                .as_array()?
                .iter()
                .filter_map(|c| c.as_str().map(str::to_string))
                .collect();
            Some((
                row.get("writer")?.as_str()?.to_string(),
                row.get("group")?.as_str()?.to_string(),
                commands,
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    let mut unmeasured = Vec::new();
    for row in value.get("handoffs")?.get("rust")?.as_array()? {
        let writer = row.get("writer")?.as_str()?.to_string();
        for command in row
            .get("not_measured")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            unmeasured.push((writer.clone(), command.to_string()));
        }
    }
    let tool_writers = value["handoffs"]
        .get("writers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, row)| Some((name.clone(), row.get("group")?.as_str()?.to_string())))
        .collect();
    let tool_rows = value["handoffs"]
        .get("rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some(ToolRow {
                writer: row.get("writer")?.as_str()?.to_string(),
                paths: strings(row, "paths"),
                requesters: strings(row, "requesters"),
                not_measured: strings(row, "not_measured"),
            })
        })
        .collect();
    let tool_flags = value
        .get("tools")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, row)| {
            let verdict = row
                .get("model_quality_verdict")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                .then(|| {
                    row.get("verdict_reason")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                });
            let supplied = row
                .get("model_supplied_pass")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (name.clone(), verdict, supplied)
        })
        .collect();
    let split = value.get("review_split").cloned().unwrap_or(Value::Null);
    Some(Table {
        rules,
        owners,
        handoffs,
        unmeasured,
        tool_writers,
        tool_rows,
        tool_flags,
        draw_tools: strings(&split, "draw_tools"),
        review_tools: strings(&split, "review_tools"),
        review_prefixes: strings(&split, "review_path_prefixes"),
        reject_writer: split
            .get("reject_writer")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        report_note: value["boundary_report"]["note"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        not_traced: strings(&value["boundary_report"], "not_traced"),
        ownership: kinds.get("ownership").cloned().unwrap_or_default(),
    })
}

/// NEWSROOM_REVIEW_SPLIT (default on, off only at exactly "0"); a test sets it per thread so the environment is never touched.
fn review_split_enabled() -> bool {
    #[cfg(test)]
    if let Some(on) = TEST_REVIEW_SPLIT.with(|c| *c.borrow()) {
        return on;
    }
    std::env::var("NEWSROOM_REVIEW_SPLIT")
        .map(|v| v != "0")
        .unwrap_or(true)
}

impl Table {
    /// The same two rules as `reviewSplitProblem` in groups.mjs (the caller checks NEWSROOM_REVIEW_SPLIT on (the default)): a draw tool may not write a review record; a review
    /// tool may not unlink, rename or write into rejected/ itself (the reject writer does that for it). `requester` is the tool that asked.
    fn review_split_problem(
        &self,
        requester: &str,
        writer: Option<&str>,
        rel: &str,
        op: &str,
    ) -> Option<(&'static str, String)> {
        if self.draw_tools.iter().any(|t| t == requester)
            && self
                .review_prefixes
                .iter()
                .any(|p| rel.starts_with(p.as_str()))
        {
            return Some((
                "review_path_by_draw_tool",
                format!(
                    "{requester} draws; {rel} is a review record, which only a review tool writes"
                ),
            ));
        }
        let moves = op == "unlink"
            || op == "rename"
            || rel.starts_with("rejected/")
            || rel.contains("/rejected/");
        if self.review_tools.iter().any(|t| t == requester)
            && writer != Some(self.reject_writer.as_str())
            && moves
        {
            return Some((
                "draw_path_by_review_tool",
                format!(
                    "{requester} reviews; {op} {rel} changes a draw product, which {} does for a review tool",
                    self.reject_writer
                ),
            ));
        }
        None
    }
    /// First rule that matches wins; a rule is an exact path or a non-empty prefix. A rule whose kind has no owner matches nothing.
    fn classify(&self, rel: &str) -> Option<(String, String, Option<String>)> {
        // same normalization as the Pi side: separators, then one leading "./"
        let rel = rel.replace('\\', "/");
        let rel = rel.strip_prefix("./").unwrap_or(&rel);
        for rule in &self.rules {
            let hit = match (&rule.exact, &rule.prefix) {
                (Some(exact), _) => rel == exact,
                (None, Some(prefix)) => !prefix.is_empty() && rel.starts_with(prefix.as_str()),
                _ => false,
            };
            if !hit {
                continue;
            }
            if let Some((_, owner)) = self.owners.iter().find(|(kind, _)| *kind == rule.kind) {
                return Some((rule.kind.clone(), owner.clone(), rule.tag.clone()));
            }
        }
        None
    }
}

/// Run `f` with the parsed table; `None` when the table cannot be read.
fn with_table<T>(f: impl FnOnce(Option<&Table>) -> T) -> T {
    #[cfg(test)]
    {
        if let Some(text) = TEST_TABLE.with(|cell| cell.borrow().clone()) {
            return f(parse_table(&text).as_ref());
        }
    }
    f(TABLE.get_or_init(|| parse_table(GROUPS_JSON)).as_ref())
}

/// The path -> kind answer for a run-folder-relative path (for the cross-language test).
#[cfg(test)]
pub fn classify(rel: &str) -> Option<(String, String)> {
    with_table(|table| table?.classify(rel)).map(|(kind, owner, _)| (kind, owner))
}

pub fn enabled() -> bool {
    #[cfg(test)]
    {
        if let Some(value) = TEST_ACTIVE.with(|cell| *cell.borrow()) {
            return value;
        }
    }
    tools_on_from_env()
}

/// #64 step 4, the same rule as `groupToolsEnabled` in groups.mjs: "0" is off; "1" is on; anything else follows the effective refusal switch.
fn tools_on_from_env() -> bool {
    tools_on_from(
        std::env::var(TOOLS_SWITCH).ok().as_deref(),
        std::env::var(ENFORCE_SWITCH).ok().as_deref(),
    )
}

/// The pure rule behind `tools_on_from_env`: a function of the two values, so a test can check it without touching the process environment.
fn tools_on_from(tools: Option<&str>, enforce: Option<&str>) -> bool {
    match tools {
        Some("0") => false,
        Some("1") => true,
        _ => enforce_on_from(enforce),
    }
}

/// #64 step 3, the same rule as `groupEnforceEnabled` in groups.mjs: on unless exactly "0".
/// A function of the value, so a test can check it without touching the process environment.
fn enforce_on_from(enforce: Option<&str>) -> bool {
    enforce != Some("0")
}

/// The observe switch of the command side's second gate (see `OBSERVE_SWITCH`). Only the exact value "1" counts.
pub fn observe_enabled() -> bool {
    #[cfg(test)]
    {
        if let Some(value) = TEST_OBSERVE.with(|cell| *cell.borrow()) {
            return value;
        }
    }
    std::env::var(OBSERVE_SWITCH).ok().as_deref() == Some("1")
}

/// The exempt-record switch (see `EXEMPT_RECORD_SWITCH`). Only the exact value "1" counts.
pub fn exempt_record_enabled() -> bool {
    #[cfg(test)]
    {
        if let Some(value) = TEST_EXEMPT_RECORD.with(|cell| *cell.borrow()) {
            return value;
        }
    }
    exempt_record_value(std::env::var(EXEMPT_RECORD_SWITCH).ok().as_deref())
}

/// Only the exact value "1" turns the record on.
fn exempt_record_value(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Test only: force the exempt-record switch for this thread until the guard is dropped.
#[cfg(test)]
pub struct ExemptRecordGuard;
#[cfg(test)]
impl Drop for ExemptRecordGuard {
    fn drop(&mut self) {
        TEST_EXEMPT_RECORD.with(|c| *c.borrow_mut() = None);
    }
}
#[cfg(test)]
pub fn exempt_record_for_test(on: bool) -> ExemptRecordGuard {
    TEST_EXEMPT_RECORD.with(|c| *c.borrow_mut() = Some(on));
    ExemptRecordGuard
}

/// Record one write that skipped the judgement because of an exemption (same four names as groups.mjs `exemptionOf`). Best effort, never throws, never changes
/// the verdict; a repeat of the same tool, path, exemption and op in one run folder is written once. Off: nothing is read or written.
pub fn note_exempt(root: &Path, tool: &str, rel: &str, op: &str) {
    if !exempt_record_enabled() || rel == CALL_REPORT_PATH {
        return;
    }
    let Some(exemption) = exempt_reason(rel) else {
        return;
    };
    let key = format!("{}\0{tool}\0{rel}\0{exemption}\0{op}", root.display());
    let seen = EXEMPT_NOTED.get_or_init(|| Mutex::new(HashSet::new()));
    match seen.lock() {
        Ok(mut seen) => {
            if !seen.insert(key) {
                return;
            }
        }
        Err(_) => return,
    }
    let log = root.join(CALL_REPORT_PATH);
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log) {
        let line = serde_json::json!({
            "kind": "exempt_write",
            "side": "rust",
            "tool": tool,
            "path": rel,
            "exemption": exemption,
            "op": op,
        });
        let _ = writeln!(file, "{line}");
    }
}

/// One line of the observed log: a command-side hand-off write and what the table said about it. `decision` is `listed` (a row lets it),
/// `unlisted` (no row, or the pair is in not_measured: it would have been refused without the observe switch) or `not_owned` (the first gate
/// refuses it whatever the table says). Best effort, never throws, never changes the verdict.
fn note_observed(root: &Path, handoff: Handoff, command: Option<&str>, path: &str, decision: &str) {
    let log = root.join(OBSERVED_LOG_PATH);
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log) {
        let line = serde_json::json!({
            "side": "rust-command",
            "writer": handoff.writer,
            "group": handoff.group,
            "requested_by": handoff.requested_by,
            "command": command.unwrap_or(""),
            "path": path,
            "decision": decision,
        });
        let _ = writeln!(file, "{line}");
    }
}

/// `NEWSROOM_GROUP_BOUNDARY=1`: the boundary report is kept (the Rust agent counts the passed items then, Node leaves them out).
pub fn report_enabled() -> bool {
    std::env::var("NEWSROOM_GROUP_BOUNDARY").ok().as_deref() == Some("1")
}

/// The review-from-records switch of the report (same two names as `groups.mjs`).
pub fn status_computed_enabled() -> bool {
    [
        "NEWSROOM_GROUP_REVIEW_FROM_RECORDS",
        "NEWSROOM_MODEL_PASS_SELFREPORT",
    ]
    .iter()
    .any(|name| std::env::var(name).ok().as_deref() == Some("1"))
}

/// The switch chain, as on the Pi side: TOOLS needs ENFORCE. A missing link stops the program at start-up. Only an explicit TOOLS "1" can stop it (TOOLS unset follows ENFORCE, #64 step 4); ENFORCE is on unless exactly "0".
pub fn startup_check() -> anyhow::Result<()> {
    startup_check_from(&Switches::from_env())
}

/// The values the start-up rules read (each `None` when the variable is unset). A test builds one instead of changing the process environment.
#[derive(Default)]
struct Switches {
    tools: Option<String>,
    enforce: Option<String>,
    call_refuse: Option<String>,
    call_refuse_all: Option<String>,
    call_check: Option<String>,
}

impl Switches {
    fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Switches {
            tools: read(TOOLS_SWITCH),
            enforce: read(ENFORCE_SWITCH),
            call_refuse: read(CALL_REFUSE_SWITCH),
            call_refuse_all: read(CALL_REFUSE_ALL_SWITCH),
            call_check: read(CALL_CHECK_SWITCH),
        }
    }
}

/// The pure rule behind `startup_check`.
fn startup_check_from(s: &Switches) -> anyhow::Result<()> {
    let on = |value: &Option<String>| value.as_deref() == Some("1");
    let enforce_on = enforce_on_from(s.enforce.as_deref());
    if on(&s.tools) && !enforce_on {
        anyhow::bail!("GROUP_TOOLS_NEEDS_ENFORCE: checking each write against its group only works with the refusal of cross-group writes on");
    }
    let refuse_on = s.call_refuse.as_deref() != Some("0");
    let refuse_all_on = s.call_refuse_all.as_deref() != Some("0");
    if (refuse_on || refuse_all_on) && (!enforce_on || s.call_check.as_deref() == Some("0")) {
        anyhow::bail!("GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK: refusing a call off its tool list only works with the refusal on (ENFORCE) and the call record on (CALL_CHECK), so every refused call is recorded first. Remove NEWSROOM_GROUP_ENFORCE=0 / NEWSROOM_GROUP_CALL_CHECK=0, or set NEWSROOM_GROUP_CALL_REFUSE=0 and NEWSROOM_GROUP_CALL_REFUSE_ALL=0");
    }
    Ok(())
}

/// A one-line note (not an error) for the combination refusal on, TOOLS off: the refusal then judges the JavaScript side only, and the Rust agent's own writes
/// are not judged. Since #64 step 4 TOOLS follows the refusal, so this can only be an explicit TOOLS=0. Pure function of the two effective states so it can be tested without the environment.
fn enforce_alone_hint(enforce: bool, tools: bool) -> Option<&'static str> {
    if enforce && !tools {
        return Some("note: NEWSROOM_GROUP_TOOLS=0 with the refusal of cross-group writes on refuses cross-group writes made by the JavaScript tools only; writes made by the Rust side are not judged");
    }
    None
}

/// Called by `main` after `startup_check`: the note for the refusal on with an explicit TOOLS=0, or None. Printed to stderr; nothing is refused and nothing else changes.
pub fn startup_hint() -> Option<&'static str> {
    startup_hint_from(&Switches::from_env())
}

/// The pure rule behind `startup_hint`.
fn startup_hint_from(s: &Switches) -> Option<&'static str> {
    let (tools, enforce) = (s.tools.as_deref(), s.enforce.as_deref());
    enforce_alone_hint(enforce_on_from(enforce), tools_on_from(tools, enforce))
}

/// Called once by `main` for the command that runs. One command per process, so this is process-wide and survives the async runtime.
/// `group` is the command's group in `cli::command_groups()` (None for a command that has none).
pub fn enter_command(name: &'static str, group: Option<&'static str>) {
    let _ = COMMAND.set((name, group));
}

fn current_command() -> Option<(&'static str, Option<&'static str>)> {
    #[cfg(test)]
    {
        if let Some(value) = TEST_COMMAND.with(|cell| *cell.borrow()) {
            return value;
        }
    }
    COMMAND.get().copied()
}

/// Test-only: give the rest of this test the command context its code path really runs under (`name` must be in groups.json `commands`).
/// The guard is not touched: an unknown command is still refused; this only says which command is running, as `main` does with `enter_command`.
#[cfg(test)]
pub(crate) struct CommandForTest;
#[cfg(test)]
pub(crate) fn command_for_test(name: &'static str) -> CommandForTest {
    let group = crate::cli::group_of(name);
    assert!(group.is_some(), "{name} must be in groups.json commands");
    TEST_COMMAND.with(|c| *c.borrow_mut() = Some(Some((name, group))));
    CommandForTest
}
#[cfg(test)]
impl Drop for CommandForTest {
    fn drop(&mut self) {
        TEST_COMMAND.with(|c| *c.borrow_mut() = None);
    }
}

/// Sets NEWSROOM_REVIEW_SPLIT for this test thread (the environment is never touched); dropping the guard clears it.
#[cfg(test)]
pub(crate) struct ReviewSplitForTest;
#[cfg(test)]
pub(crate) fn review_split_for_test(on: bool) -> ReviewSplitForTest {
    TEST_REVIEW_SPLIT.with(|c| *c.borrow_mut() = Some(on));
    ReviewSplitForTest
}
#[cfg(test)]
impl Drop for ReviewSplitForTest {
    fn drop(&mut self) {
        TEST_REVIEW_SPLIT.with(|c| *c.borrow_mut() = None);
    }
}

pub fn command_name() -> &'static str {
    current_command().map_or("", |(name, _)| name)
}

fn command_group() -> Option<&'static str> {
    current_command().and_then(|(_, group)| group)
}

struct WriterScope(Option<Handoff>);
impl Drop for WriterScope {
    fn drop(&mut self) {
        WRITER.with(|cell| *cell.borrow_mut() = self.0.take());
    }
}

/// Run `f` as a group's own writer: the writes inside belong to `group`, reported under `writer`, with `requested_by` kept. The writes are judged
/// like any other (the path's owner must be `group`), and the writer, group and asking command must be a `handoffs.rust` row. Private: only the
/// five `as_*` doors below exist, so no call site picks its own writer. No await may happen inside `f`.
fn as_writer<T>(
    group: &'static str,
    writer: &'static str,
    requested_by: &'static str,
    f: impl FnOnce() -> T,
) -> T {
    let previous = WRITER.with(|cell| {
        cell.borrow_mut().replace(Handoff {
            group,
            writer,
            requested_by,
        })
    });
    let _scope = WriterScope(previous);
    f()
}

/// Run-bundle bookkeeping the program writes (transcripts, event and metric logs, the folder skeleton): the system group's writer.
pub fn as_run_bundle<T>(f: impl FnOnce() -> T) -> T {
    as_writer("system", "run_bundle_writer", command_name(), f)
}
/// Data files imported into the run folder: the knowledge group's writer, asked by the running command (investigate, ...).
pub fn as_data_import<T>(f: impl FnOnce() -> T) -> T {
    as_writer("knowledge", "knowledge_writer", command_name(), f)
}
/// The verification result file: the knowledge group's writer.
pub fn as_verification_record<T>(f: impl FnOnce() -> T) -> T {
    as_writer("knowledge", "verification_writer", command_name(), f)
}
/// Copying the program's own runtime and config into the run folder (runtime.rs materialization functions only): the system group's writer.
pub fn as_materialize<T>(f: impl FnOnce() -> T) -> T {
    as_writer("system", "materialize_writer", command_name(), f)
}
/// The record-only side files in shadow/ (verify.rs write_record_only only): observation, owned by the knowledge group. A knowledge command (`verify`)
/// writes its own files as itself; the post-run verify inside investigate / continue asks the knowledge group's shadow writer (a `handoffs.rust` row).
pub fn as_shadow_writer<T>(f: impl FnOnce() -> T) -> T {
    if command_group() == Some("knowledge") {
        f()
    } else {
        as_writer("knowledge", "shadow_writer", command_name(), f)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    File,
    Dir,
}

/// Relative path of `path` under `root`, with `/` separators and a trailing `/` for a folder. `None` if it is not under the root or leaves it.
fn relative(root: &Path, path: &Path, op: Op) -> Option<String> {
    let strip = |root: &Path, path: &Path| path.strip_prefix(root).ok().map(Path::to_path_buf);
    let rel = strip(root, path).or_else(|| {
        // the root may be given canonical and the path not (or the reverse)
        let root = fs::canonicalize(root).ok()?;
        let mut existing = path.to_path_buf();
        let mut tail = Vec::new();
        while !existing.exists() {
            tail.push(existing.file_name()?.to_os_string());
            existing = existing.parent()?.to_path_buf();
        }
        let mut real = fs::canonicalize(&existing).ok()?;
        for part in tail.iter().rev() {
            real.push(part);
        }
        strip(&root, &real)
    })?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    let mut text = parts.join("/");
    if op == Op::Dir && !text.is_empty() {
        text.push('/');
    }
    Some(text)
}

fn writer_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "evidence" => Some("knowledge_writer"),
        "observation" => Some("shadow_writer"),
        "pass_decision" => Some("decision_writer"),
        "project_state" => Some("agent_record_writer"),
        _ => None,
    }
}

/// Fixed refusal text: command, its group, the path, its kind and owner, the writer to use. Nothing else (no switch names, no way around it).
fn refusal_text(
    command: &str,
    group: &str,
    path: &str,
    kind: Option<&str>,
    owner: Option<&str>,
) -> String {
    let writer = kind
        .and_then(writer_for_kind)
        .unwrap_or("no writer: the path has no owning group yet");
    format!(
        "boundary: {}（{}）may not write {}（{}, owner {}）. Use {}.",
        if command.is_empty() {
            "unknown command"
        } else {
            command
        },
        if group.is_empty() {
            "unknown group"
        } else {
            group
        },
        path,
        kind.unwrap_or("unclassified"),
        owner.unwrap_or("none"),
        writer
    )
}

fn note_refusal(root: &Path, op: &str, text: &str, path: &str) {
    // best effort, never throws, never lets the write through
    let log = root.join(REFUSAL_LOG_PATH);
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log) {
        let line = serde_json::json!({ "op": op, "side": "rust", "path": path, "status": "refused", "text": text });
        let _ = writeln!(file, "{line}");
    }
}

/// The decision for one write. `Ok(())` only when the writing group owns the path's kind.
fn judge(root: &Path, path: &Path, op: Op) -> io::Result<()> {
    if !enabled() {
        return Ok(());
    }
    let command = current_command().map(|(name, _)| name);
    let handoff = WRITER.with(|cell| *cell.borrow());
    let group = match handoff {
        Some(h) => Some(h.group),
        None => command_group(),
    };
    let rel = relative(root, path, op);
    let classified = rel
        .as_deref()
        .and_then(|rel| with_table(|table| table?.classify(rel)));
    let owned = matches!((&group, &classified, &rel), (Some(group), Some((_, owner, _)), Some(_)) if owner == group);
    // a hand-off must also be a row of handoffs.rust (writer, group, asking command); no row, no write
    let row_listed = handoff.is_none_or(|h| {
        with_table(|table| {
            table.is_some_and(|t| {
                t.handoffs.iter().any(|(w, g, c)| {
                    w == h.writer && g == h.group && c.iter().any(|x| x == h.requested_by)
                }) && !t
                    .unmeasured
                    .iter()
                    .any(|(w, c)| w == h.writer && c == h.requested_by)
            })
        })
    });
    // NEWSROOM_GROUP_HANDOFF_OBSERVE=1: the rows only record, they never refuse (the first gate, the owner, is not touched)
    let observing = handoff.is_some() && observe_enabled();
    if let (true, Some(h)) = (observing, handoff) {
        let decision = if !owned {
            "not_owned"
        } else if row_listed {
            "listed"
        } else {
            "unlisted"
        };
        note_observed(
            root,
            h,
            command,
            rel.as_deref().unwrap_or(&path.display().to_string()),
            decision,
        );
    }
    let listed = row_listed || observing;
    let allowed = owned && listed;
    let verdict = Verdict {
        path: rel.clone().unwrap_or_else(|| path.display().to_string()),
        kind: classified.as_ref().map(|c| c.0.clone()),
        owner: classified.as_ref().map(|c| c.1.clone()),
        group: group.map(str::to_string),
        writer: handoff.map(|h| h.writer.to_string()),
        requested_by: handoff.map(|h| h.requested_by.to_string()),
        allowed,
    };
    #[cfg(test)]
    TEST_LOG.with(|cell| cell.borrow_mut().push(verdict.clone()));
    if allowed {
        return Ok(());
    }
    let shown = handoff.map(|h| h.writer).or(command).unwrap_or("");
    let text = match handoff {
        Some(h) if owned && !listed => format!(
            "boundary: {} may not ask {} to write {}.",
            if h.requested_by.is_empty() {
                "an unknown command"
            } else {
                h.requested_by
            },
            h.writer,
            verdict.path
        ),
        _ => refusal_text(
            shown,
            group.unwrap_or(""),
            &verdict.path,
            verdict.kind.as_deref(),
            verdict.owner.as_deref(),
        ),
    };
    note_refusal(
        root,
        if op == Op::Dir { "mkdir" } else { "write" },
        &text,
        &verdict.path,
    );
    Err(io::Error::new(io::ErrorKind::PermissionDenied, text))
}

// ---- staged calls (NEWSROOM_AGENT=rust, 1011ah step 7a) ----------------------------------------------------------------------
// A tool call writes into `<run>/staging/<callId>/`; after the call `src/staging.rs` hands every new file to `judge_staged` (same table, same
// owner-equals-group rule as `judge`, the writing group being the calling tool's group or a tool-side hand-off writer's) and only then `commit_staged`
// moves it into the run folder. Not gated by the group-tools switch: the staging itself is the switch (NEWSROOM_AGENT=rust). The knowledge group's records go through the hand-off, which is always on.

/// Where a staged file came from: the tool that made the call, its group (the host's list), and the hand-off writer it wrote as, if any.
pub struct Origin<'a> {
    pub tool: &'a str,
    pub group: &'a str,
    pub writer: Option<&'a str>,
    /// The tools of a group the model can actually call (the host's `ready` list), for the refusal text; any order, the text sorts and cuts it.
    pub tools_of: &'a dyn Fn(&str) -> Vec<String>,
}

/// How a staged file is put into the run folder (the folder name the write entry point used).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Commit {
    Write,
    Append,
    Once,
}

/// Program bookkeeping and temp names that no tool is judged on (E1, same lists as groups.mjs).
pub fn is_exempt(rel: &str) -> bool {
    exempt_reason(rel).is_some()
}

/// Which exemption lets this path through (`None`: none does). Checked in the same order as groups.mjs `exemptionOf`.
pub fn exempt_reason(rel: &str) -> Option<&'static str> {
    const FILES: &[&str] = &[
        "events.jsonl",
        "run-metrics.jsonl",
        "conversation.md",
        "plan-progress.json",
        "runtime/group-boundary-report.json",
        "runtime/boundary-refusals.jsonl",
        "runtime/tool-chain-events.jsonl",
        "runtime/cross-call-report.jsonl",
    ];
    if rel.starts_with("runtime/preview-tmp/") {
        Some("preview_tmp")
    } else if rel.ends_with(".tmp") || rel.ends_with(".write-tmp") {
        Some("temp_suffix")
    } else if rel.starts_with("session/") {
        Some("session_folder")
    } else if FILES.contains(&rel) {
        Some("bookkeeping_file")
    } else {
        None
    }
}

/// Why a hand-off writer may not write this path for this tool (the same four reasons as groups.mjs `handoffProblem`); `None` when the table lets it.
fn handoff_problem(
    table: &Table,
    writer: &str,
    group: &str,
    rel: &str,
    tool: &str,
) -> Option<String> {
    if !table
        .tool_writers
        .iter()
        .any(|(name, g)| name == writer && g == group)
    {
        return Some("writer is not in the handoffs table".into());
    }
    let rows: Vec<&ToolRow> = table
        .tool_rows
        .iter()
        .filter(|r| {
            r.writer == writer
                && r.paths.iter().any(|p| {
                    if p.ends_with('/') {
                        rel.starts_with(p.as_str())
                    } else {
                        rel == p
                    }
                })
        })
        .collect();
    if rows.is_empty() {
        return Some(format!("no handoffs row lets {writer} write {rel}"));
    }
    if !rows.iter().any(|r| r.requesters.iter().any(|x| x == tool)) {
        return Some(format!(
            "{tool} is not a listed requester of {writer} for {rel}"
        ));
    }
    if !rows.iter().any(|r| {
        r.requesters.iter().any(|x| x == tool) && !r.not_measured.iter().any(|x| x == tool)
    }) {
        return Some(format!("{tool} is listed for {writer} on {rel} but not measured yet (not_measured): refused until a run has seen it"));
    }
    None
}

fn note_staged_refusal(
    root: &Path,
    origin: &Origin,
    op: &str,
    verdict: &Verdict,
    status: &str,
    reason: &str,
    text: &str,
) {
    // same file and fields as the Pi side's refusal line, plus `side` and `text` as the Rust side already writes them; best effort like `note_refusal`
    let log = root.join(REFUSAL_LOG_PATH);
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log) {
        let mut line = serde_json::json!({
            "op": op, "side": "rust", "tool": origin.tool, "group": origin.group, "path": verdict.path,
            "kind": verdict.kind, "owner": verdict.owner, "writer": origin.writer, "status": status, "text": text,
        });
        if !reason.is_empty() {
            line["reason"] = Value::String(reason.to_string());
        }
        let _ = writeln!(file, "{line}");
    }
}

/// The refusal text of the Rust path. It names the owning group and at most 3 tools the model can call in that group, taken from the host's list: first
/// the ones groups.json records as asking for that file (the requesters of the `handoffs` rows that list it), then the rest alphabetically; the hand-off writers are not tools the model can call, so they are never named here. A group with no such tool, or a path with no owner, says
/// the call should not write the file at all.
fn staged_refusal_text(origin: &Origin, group: &str, rel: &str, verdict: &Verdict) -> String {
    let head = format!(
        "boundary: {}（{}）may not write {}（{}, owner {}）.",
        origin.tool,
        if group.is_empty() {
            "unknown group"
        } else {
            group
        },
        rel,
        verdict.kind.as_deref().unwrap_or("unclassified"),
        verdict.owner.as_deref().unwrap_or("none"),
    );
    let Some(owner) = verdict.owner.as_deref() else {
        return format!("{head} This call should not write this file.");
    };
    let mut names = (origin.tools_of)(owner);
    names.sort();
    names.dedup();
    let asking: Vec<String> = with_table(|table| {
        table
            .map(|t| {
                t.tool_rows
                    .iter()
                    .filter(|r| {
                        r.paths.iter().any(|p| {
                            if p.ends_with('/') {
                                rel.starts_with(p.as_str())
                            } else {
                                rel == p
                            }
                        })
                    })
                    .flat_map(|r| r.requesters.clone())
                    .collect()
            })
            .unwrap_or_default()
    });
    // stable: requesters first (alphabetical among themselves), then the others alphabetically
    names.sort_by_key(|n| !asking.contains(n));
    names.truncate(3);
    if names.is_empty() {
        format!("{head} This call should not write this file.")
    } else {
        format!(
            "{head} That file belongs to the {owner} group; the tools you can call there: {}.",
            names.join(", ")
        )
    }
}

/// The decision for one staged file `rel` (run-relative, `/`-separated). `Ok(())` only when the writing group owns the path's kind (and, for a
/// hand-off writer, the table lists the path and the tool). Refused: another group's kind (`cross_group`), a path no rule matches or no group
/// (`待查`), an unlisted hand-off (`handoff_not_listed`), a path under `staging/`, a table that cannot be read (`check_failed`). The refusal is
/// logged (with the operation's name: `write`, `append`, `write_if_absent`, `unlink`, `rename`) and its text (for the model) returned. Nothing here lets a
/// path through on an error. The one pass without a judgement is an exempt path (`is_exempt`: bookkeeping files, temp names, `session/`), which is let through
/// as before and noted when the exempt-record switch is on.
pub fn judge_staged_op(root: &Path, origin: &Origin, rel: &str, op: &str) -> Result<(), String> {
    // the verification result is computed by the program (`write_verification_record`), never taken from a tool call's files, whichever group asks
    if rel == "verification.json" {
        let text = "boundary: a tool call may not write verification.json; only the program's own check computes it.".to_string();
        let verdict = Verdict {
            path: rel.to_string(),
            kind: Some("verification_record".into()),
            owner: Some("knowledge".into()),
            group: Some(origin.group.to_string()),
            writer: origin.writer.map(str::to_string),
            requested_by: None,
            allowed: false,
        };
        #[cfg(test)]
        TEST_LOG.with(|cell| cell.borrow_mut().push(verdict.clone()));
        note_staged_refusal(
            root,
            origin,
            op,
            &verdict,
            "cross_group",
            "model_supplied_pass",
            &text,
        );
        return Err(text);
    }
    // program bookkeeping and temp names are not judged (the same lists as groups.mjs); with the record switch on the pass is noted, nothing else changes
    if is_exempt(rel) {
        note_exempt(root, origin.tool, rel, op);
        return Ok(());
    }
    let table_ok = with_table(|table| table.is_some());
    let classified = with_table(|table| table?.classify(rel));
    // a hand-off writer writes as its own group (from the table, not from the caller); an unlisted writer has none and is refused
    let writing_group: String = match origin.writer {
        Some(w) => with_table(|table| {
            table
                .and_then(|t| t.tool_writers.iter().find(|(name, _)| name == w))
                .map(|(_, g)| g.clone())
                .unwrap_or_default()
        }),
        None => origin.group.to_string(),
    };
    let writing_group = writing_group.as_str();
    let problem = with_table(|table| {
        origin.writer.and_then(|w| {
            table.and_then(|t| handoff_problem(t, w, writing_group, rel, origin.tool))
        })
    });
    let owned = !writing_group.is_empty()
        && classified.as_ref().is_some_and(|c| c.1 == writing_group)
        && !rel.starts_with("staging/")
        && !rel.is_empty();
    let split = if review_split_enabled() {
        with_table(|table| {
            table.and_then(|t| t.review_split_problem(origin.tool, origin.writer, rel, op))
        })
    } else {
        None
    };
    let allowed = table_ok && owned && problem.is_none() && split.is_none();
    let verdict = Verdict {
        path: rel.to_string(),
        kind: classified.as_ref().map(|c| c.0.clone()),
        owner: classified.as_ref().map(|c| c.1.clone()),
        group: Some(writing_group.to_string()),
        writer: origin.writer.map(str::to_string),
        requested_by: origin.writer.map(|_| origin.tool.to_string()),
        allowed,
    };
    #[cfg(test)]
    TEST_LOG.with(|cell| cell.borrow_mut().push(verdict.clone()));
    if allowed {
        return Ok(());
    }
    let (status, reason) = if !table_ok {
        ("check_failed", "the group list cannot be read".to_string())
    } else if let Some((split_status, why)) = &split {
        (*split_status, why.clone())
    } else if writing_group.is_empty() {
        ("待查", "tool is not in groups.json".to_string())
    } else if classified.is_none() || rel.starts_with("staging/") {
        ("待查", "path matches no artifact kind".to_string())
    } else if !owned {
        ("cross_group", String::new())
    } else {
        ("handoff_not_listed", problem.clone().unwrap_or_default())
    };
    let text = match (&problem, owned) {
        _ if split.is_some() => format!(
            "boundary: {} may not write {} under the review/draw split: {}.",
            origin.tool,
            rel,
            split.as_ref().map(|s| s.1.as_str()).unwrap_or("")
        ),
        (Some(why), true) => format!(
            "boundary: {} may not ask {} to write {}: {why}.",
            origin.tool,
            origin.writer.unwrap_or(""),
            rel
        ),
        _ => staged_refusal_text(origin, writing_group, rel, &verdict),
    };
    note_staged_refusal(root, origin, op, &verdict, status, &reason, &text);
    Err(text)
}

/// A refusal that is not about one path's owner (a check that ran too long, a file that is not a plain file, an unreadable staging folder): the
/// same log line and text shape, status `check_failed`.
pub fn refuse_staged_check(root: &Path, origin: &Origin, rel: &str, reason: &str) -> String {
    let text = format!(
        "boundary: {}（{}）call refused: {reason} ({rel}). Nothing from this call was kept.",
        origin.tool, origin.group
    );
    let verdict = Verdict {
        path: rel.to_string(),
        kind: None,
        owner: None,
        group: Some(origin.group.to_string()),
        writer: origin.writer.map(str::to_string),
        requested_by: None,
        allowed: false,
    };
    #[cfg(test)]
    TEST_LOG.with(|cell| cell.borrow_mut().push(verdict.clone()));
    note_staged_refusal(
        root,
        origin,
        "write",
        &verdict,
        "check_failed",
        reason,
        &text,
    );
    text
}

/// Puts one judged staged file into the run folder. `Write` replaces, `Append` adds the bytes to the end, `Once` keeps an existing identical file
/// and refuses a different one (the immutable-artifact rule). Only called after `judge_staged` said yes for `rel`.
pub fn commit_staged(root: &Path, staged: &Path, rel: &str, mode: Commit) -> io::Result<()> {
    let target = root.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match mode {
        Commit::Write => {
            fs::copy(staged, &target)?;
        }
        Commit::Append => {
            let mut file = OpenOptions::new().create(true).append(true).open(&target)?;
            file.write_all(&fs::read(staged)?)?;
        }
        Commit::Once => match fs::read(&target) {
            Ok(existing) if existing == fs::read(staged)? => {}
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("Immutable artifact collision: existing bytes differ at {rel}"),
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::copy(staged, &target)?;
            }
            Err(error) => return Err(error),
        },
    }
    Ok(())
}

/// Creates the call's staging folder `<root>/staging/<call_id>/` (judged like any run-folder folder).
pub fn create_staging_dir(root: &Path, dir: &Path) -> io::Result<()> {
    create_dir_all(root, dir)
}

/// Removes a call's staging folder and everything in it. Only a folder directly under `<root>/staging/` is removed; anything else is refused.
pub fn clear_staging_dir(root: &Path, dir: &Path) -> io::Result<()> {
    let ok = dir.parent() == Some(root.join("staging").as_path())
        && dir.file_name().is_some_and(|n| !n.is_empty());
    if !ok {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "boundary: only a call's own folder under staging/ may be removed",
        ));
    }
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// What a staged call asked for besides files (the three protocol operations; paths are run-relative and already checked).
#[derive(Clone, Debug, PartialEq)]
pub enum StagedOp {
    Unlink { from: String },
    Rename { from: String, to: String },
}

fn staged_homes(folder: &Path) -> Vec<std::path::PathBuf> {
    let mut homes = Vec::new();
    let Ok(whos) = fs::read_dir(folder) else {
        return homes;
    };
    for who in whos.flatten() {
        let name = who.file_name().to_string_lossy().into_owned();
        if name != "own" && !name.starts_with("writer-") {
            continue;
        }
        for mode in ["write", "append", "once"] {
            let home = who.path().join(mode);
            if home.is_dir() {
                homes.push(home);
            }
        }
    }
    homes.sort();
    homes
}

/// Does a staged operation, after it was judged. What this call staged under the path moves or goes first (so a file written and then renamed in the
/// same call is renamed as well), then the run folder's own file or folder. A missing source of a delete is not an error (the tools ignore that today, too); a rename whose
/// source is nowhere (not staged, not in the run folder) is `NotFound`, as `rename(2)` is today (1011aj gap 7). A rename onto a folder that is not empty fails, as `rename(2)` does.
pub fn apply_staged_op(root: &Path, folder: &Path, op: &StagedOp) -> io::Result<()> {
    let missing = |e: io::Error| {
        if e.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(e)
        }
    };
    match op {
        StagedOp::Unlink { from } => {
            for home in staged_homes(folder) {
                let path = home.join(from);
                if fs::symlink_metadata(&path).is_ok() {
                    fs::remove_file(&path).or_else(missing)?;
                }
            }
            fs::remove_file(root.join(from)).or_else(missing)
        }
        StagedOp::Rename { from, to } => {
            let mut found = false;
            for home in staged_homes(folder) {
                let src = home.join(from);
                if fs::symlink_metadata(&src).is_ok() {
                    found = true;
                    let dst = home.join(to);
                    if let Some(parent) = dst.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::rename(&src, &dst)?;
                }
            }
            let src = root.join(from);
            if fs::symlink_metadata(&src).is_ok() {
                found = true;
                let dst = root.join(to);
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(&src, &dst)?;
            }
            if found {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no such file or directory: {from}"),
                ))
            }
        }
    }
}

/// One judged-and-passed item for the boundary report: who asked, the operation's name in the report (`write`, `append`, `write_if_absent`,
/// `unlink`, `rename`) and the run-relative path (the destination for a rename).
pub struct Passed {
    pub tool: String,
    /// The group of `tool` (the host's list); a hand-off writer's own group comes from the table.
    pub group: String,
    pub writer: Option<String>,
    pub op: &'static str,
    pub rel: String,
}

pub const REPORT_PATH: &str = "runtime/group-boundary-report.json";

/// One record Node left for Rust (`report.jsonl` in the call folder) added to the records: found by the same key as everywhere else (tool,
/// requested_by, op, kind, status, reason), counted once, the path kept as an example (at most 5), the flags it carries (`known`, the
/// `model_supplied_pass` / `status_computed_by_program` tag) set on the record.
fn add_line(records: &mut Vec<Value>, line: &Value) {
    let text = |key: &str| line[key].as_str().map(str::to_string);
    let same = |r: &Value| {
        r["tool"].as_str() == line["tool"].as_str()
            && r["requested_by"].as_str() == line["requested_by"].as_str()
            && r["op"].as_str() == line["op"].as_str()
            && r["kind"].as_str() == line["kind"].as_str()
            && r["status"].as_str() == line["status"].as_str()
            && r["reason"].as_str().unwrap_or("") == line["reason"].as_str().unwrap_or("")
    };
    let at = match records.iter().position(same) {
        Some(at) => at,
        None => {
            let mut record = serde_json::json!({
                "tool": line["tool"], "tool_group": line["tool_group"], "op": line["op"], "kind": line["kind"],
                "owner": line["owner"], "status": line["status"], "count": 0, "examples": [],
            });
            for key in ["requested_by", "reason"] {
                if let Some(value) = text(key).filter(|v| !v.is_empty() || key == "requested_by") {
                    record[key] = Value::String(value);
                }
            }
            records.push(record);
            records.len() - 1
        }
    };
    let record = &mut records[at];
    record["count"] = Value::from(record["count"].as_u64().unwrap_or(0) + 1);
    if let Some(path) = text("path") {
        let examples = record["examples"].as_array_mut().expect("examples");
        if examples.len() < 5 && !examples.iter().any(|e| e.as_str() == Some(path.as_str())) {
            examples.push(Value::String(path));
        }
    }
    if let Some(known) = line.get("known").filter(|v| !v.is_null()) {
        record["known"] = known.clone();
    }
    if let Some(tag) = text("tag") {
        record[tag] = Value::Bool(true);
    }
}

/// Adds the passed items to `runtime/group-boundary-report.json`, in the format `groups.mjs` writes (same record key, same totals, same summary), so the
/// check scripts read it as before. The Node side leaves these items out of its own count when the host was told they are counted here (`go.counted`),
/// and rereads the file when it changed, so nothing is counted twice. `status_computed` is the review-from-records switch (see `groups.mjs`).
/// 1011aj step 8: Rust is the only writer of the report when it counts. `lines` are the records Node worked out itself inside the call (what it
/// judged and Rust did not: a direct write, a child process's file) and left in the call folder; they are added as they are (the same record key,
/// one count each). The whole read-change-write runs under one lock, so calls finishing at the same time lose no count, and the file always has
/// the full header (note, ownership, not_traced from groups.json `boundary_report`).
pub fn count_passed(
    root: &Path,
    items: &[Passed],
    lines: &[Value],
    status_computed: bool,
) -> io::Result<()> {
    if items.is_empty() && lines.is_empty() {
        return Ok(());
    }
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = root.join(REPORT_PATH);
    let mut report: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| {
            serde_json::json!({
                "schema_version": "0.1.0", "mode": "report", "complete": false,
                "records": [],
            })
        });
    let (note, not_traced, ownership) = with_table(|t| {
        t.map(|t| {
            (
                t.report_note.clone(),
                t.not_traced.clone(),
                t.ownership.clone(),
            )
        })
        .unwrap_or_default()
    });
    report["note"] = Value::String(note);
    report["not_traced"] = Value::Array(not_traced.into_iter().map(Value::String).collect());
    report["ownership"] = ownership;
    let mut records: Vec<Value> = report["records"].as_array().cloned().unwrap_or_default();
    for item in items {
        let (name, requested_by) = match &item.writer {
            Some(w) => (w.clone(), Some(item.tool.clone())),
            None => (item.tool.clone(), None),
        };
        let requester = requested_by.clone().unwrap_or_else(|| name.clone());
        let group = with_table(|t| {
            let t = t?;
            if item.writer.is_some() {
                t.tool_writers
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, g)| g.clone())
            } else {
                None
            }
        });
        let group = if item.writer.is_some() {
            group
        } else {
            (!item.group.is_empty()).then(|| item.group.clone())
        };
        let classified = with_table(|t| t?.classify(&item.rel));
        let (mut status, mut reason) = match (&group, &classified) {
            (None, _) => ("待查", "tool is not in groups.json".to_string()),
            (_, None) => ("待查", "path matches no artifact kind".to_string()),
            (Some(g), Some(c)) if *g == c.1 => ("ok", String::new()),
            _ => ("cross_group", String::new()),
        };
        let kind = classified.as_ref().map(|c| c.0.clone());
        let flags = with_table(|t| t?.tool_flags.iter().find(|f| f.0 == requester).cloned());
        let decision = kind.as_deref() == Some("pass_decision");
        let mut tag = None;
        if matches!(status, "ok" | "cross_group") && decision {
            if let Some((_, Some(why), _)) = &flags {
                status = "model_quality_verdict";
                reason = why.clone();
            }
        }
        if matches!(status, "ok" | "cross_group") && decision && flags.as_ref().is_some_and(|f| f.2)
        {
            let name = if status_computed {
                "status_computed_by_program"
            } else {
                "model_supplied_pass"
            };
            tag = Some(name);
            if status == "ok" && name == "model_supplied_pass" {
                status = "model_supplied_pass";
                reason = "The status in this record is supplied by the model; writing the file through the owning group does not make it fine.".to_string();
            }
        }
        let same = |r: &Value| {
            r["tool"].as_str() == Some(name.as_str())
                && r["requested_by"].as_str() == requested_by.as_deref()
                && r["op"].as_str() == Some(item.op)
                && r["kind"].as_str() == kind.as_deref()
                && r["status"].as_str() == Some(status)
                && r["reason"].as_str().unwrap_or("") == reason
        };
        let at = match records.iter().position(same) {
            Some(at) => at,
            None => {
                let mut record = serde_json::json!({
                    "tool": name, "tool_group": group, "op": item.op, "kind": kind,
                    "owner": classified.as_ref().map(|c| c.1.clone()), "status": status, "count": 0, "examples": [],
                });
                if let Some(by) = &requested_by {
                    record["requested_by"] = Value::String(by.clone());
                }
                if !reason.is_empty() {
                    record["reason"] = Value::String(reason.clone());
                }
                records.push(record);
                records.len() - 1
            }
        };
        let record = &mut records[at];
        record["count"] = Value::from(record["count"].as_u64().unwrap_or(0) + 1);
        let examples = record["examples"].as_array_mut().expect("examples");
        if examples.len() < 5
            && !examples
                .iter()
                .any(|e| e.as_str() == Some(item.rel.as_str()))
        {
            examples.push(Value::String(item.rel.clone()));
        }
        if let Some(tag) = tag {
            record[tag] = Value::Bool(true);
        }
    }
    for line in lines {
        add_line(&mut records, line);
    }
    let count = |status: &str| -> u64 {
        records
            .iter()
            .filter(|r| r["status"].as_str() == Some(status))
            .map(|r| r["count"].as_u64().unwrap_or(0))
            .sum()
    };
    let handed = |group: &str| -> u64 {
        records
            .iter()
            .filter(|r| !r["requested_by"].is_null() && r["tool_group"].as_str() == Some(group))
            .map(|r| r["count"].as_u64().unwrap_or(0))
            .sum()
    };
    let writes: u64 = records
        .iter()
        .map(|r| r["count"].as_u64().unwrap_or(0))
        .sum();
    let mut totals = serde_json::json!({
        "writes": writes, "ok": count("ok"), "cross_group": count("cross_group"), "to_check": count("待查"),
    });
    for (key, value) in [
        ("handed_to_knowledge", handed("knowledge")),
        ("handed_to_agent", handed("agent")),
        ("handoff_not_listed", count("handoff_not_listed")),
        ("model_quality_verdict", count("model_quality_verdict")),
        ("model_supplied_pass", count("model_supplied_pass")),
    ] {
        if value > 0 {
            totals[key] = Value::from(value);
        }
    }
    let verdicts = count("model_quality_verdict");
    let passes = count("model_supplied_pass");
    report["summary"] = Value::String(format!(
        "{writes} writes seen: {} in the owning group, {} cross-group, {} 待查 (could not be classified){}{}. Report only; not_traced lists what this report cannot see.",
        count("ok"),
        count("cross_group"),
        count("待查"),
        if verdicts > 0 { format!(", {verdicts} model quality verdict (listed apart, not counted as fixed)") } else { String::new() },
        if passes > 0 { format!(", {passes} with a model-supplied pass (listed apart, not counted as fine)") } else { String::new() },
    ));
    report["totals"] = totals;
    report["records"] = Value::Array(records);
    let text = serde_json::to_string_pretty(&report).map_err(io::Error::other)? + "\n";
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.write-tmp");
    fs::write(&temp, text)?;
    fs::rename(&temp, &path)
}

/// `fs::write` for a file in the run folder.
pub fn write(root: &Path, path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    judge(root, path, Op::File)?;
    fs::write(path, contents)
}

/// `fs::create_dir_all` for a folder in the run folder (judged with a trailing `/`, covered by the folder-skeleton rows).
pub fn create_dir_all(root: &Path, path: &Path) -> io::Result<()> {
    judge(root, path, Op::Dir)?;
    fs::create_dir_all(path)
}

/// `fs::copy` into the run folder (the destination is judged).
pub fn copy(root: &Path, from: &Path, to: &Path) -> io::Result<u64> {
    judge(root, to, Op::File)?;
    fs::copy(from, to)
}

/// Open a file in the run folder for appending, creating it.
pub fn open_append(root: &Path, path: &Path) -> io::Result<File> {
    judge(root, path, Op::File)?;
    OpenOptions::new().create(true).append(true).open(path)
}

/// Create a new file in the run folder (fails if it exists), for writing.
pub fn create_new(root: &Path, path: &Path) -> io::Result<File> {
    judge(root, path, Op::File)?;
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// E1: is this path inside one of the program's own recompute scratch folders? (Only these are exempt, and only outside the run folder.)
pub fn is_scratch(path: &Path) -> bool {
    let temp = std::env::temp_dir();
    let Ok(rest) = path.strip_prefix(&temp) else {
        return false;
    };
    let mut parts = rest.components();
    let ok_first = matches!(parts.next(), Some(Component::Normal(name)) if name.to_str().is_some_and(|n| n.starts_with(SCRATCH_PREFIX)));
    ok_first && parts.all(|c| matches!(c, Component::Normal(_)))
}

/// `create_dir_all` for a recompute scratch folder (E1); anything else is refused, the switch on or off.
pub fn create_scratch_dir(path: &Path) -> io::Result<()> {
    if !is_scratch(path) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "boundary: only the program's recompute scratch folder may be created outside the run folder"));
    }
    fs::create_dir_all(path)
}

/// `fs::write` into a recompute scratch folder (E1).
pub fn write_scratch(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    if !is_scratch(path) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "boundary: only the program's recompute scratch folder may be written outside the run folder"));
    }
    fs::write(path, contents)
}

/// Remove a recompute scratch folder (E1, its own cleanup).
pub fn remove_scratch_dir(path: &Path) {
    if is_scratch(path) {
        let _ = fs::remove_dir_all(path);
    }
}

/// The verification result file, written with the outcome `verify_and_record` computed. `record["passed"]` must equal it; a record that carries
/// any other value (for example one a model supplied) is refused and nothing is written. Only the verify module can make a `VerifiedOutcome`,
/// so a "passed" record exists only where the checks computed it, whoever asked (the verify command or the check at the end of investigate).
/// The write itself is the knowledge group's (verification_record).
pub fn write_verification_record(
    root: &Path,
    path: &Path,
    record: &Value,
    outcome: &crate::commands::verify::VerifiedOutcome,
) -> io::Result<()> {
    // Only with the switch on (K213 fe review): off, the write is the one the program always made.
    if enabled() && record.get("passed").and_then(Value::as_bool) != Some(outcome.passed()) {
        let text = "boundary: the pass value of a verification record must be the one the program computed; this record carries another value and was not written.".to_string();
        note_refusal(root, "write", &text, "verification.json");
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, text));
    }
    write_record_text(root, path, record)
}

/// The record a command outside verify may leave on its own (continue's round status): it must say not passed. A passed one needs an outcome.
pub fn write_not_passed_record(root: &Path, path: &Path, record: &Value) -> io::Result<()> {
    if enabled() && record.get("passed").and_then(Value::as_bool) != Some(false) {
        let text = "boundary: this path may only write a verification record that says not passed; a passed record is written by verify.".to_string();
        note_refusal(root, "write", &text, "verification.json");
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, text));
    }
    write_record_text(root, path, record)
}

fn write_record_text(root: &Path, path: &Path, record: &Value) -> io::Result<()> {
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(record).map_err(io::Error::other)?
    );
    if command_group() == Some("knowledge") {
        write(root, path, text)
    } else {
        as_verification_record(|| write(root, path, text))
    }
}

/// K214 part B: an imported data file must be stored under its own content address. `actual` is the hash of the stored file, `expected` the one
/// the name was made from. Only with the switch on; off, nothing is checked and nothing changes.
pub fn check_imported_data(
    root: &Path,
    relative_file: &str,
    expected: &str,
    actual: &str,
) -> io::Result<()> {
    if !enabled() {
        return Ok(());
    }
    let stem_ok = relative_file
        .strip_prefix("data/")
        .and_then(|name| name.split('.').next())
        .is_some_and(|stem| stem == expected);
    if stem_ok && expected == actual {
        return Ok(());
    }
    let text = format!("boundary: the imported data file {relative_file} does not hash to the address it is stored under; its metadata and origin were not written.");
    note_refusal(root, "write", &text, relative_file);
    Err(io::Error::new(io::ErrorKind::PermissionDenied, text))
}

/// Test-only access to what was judged on this thread.
#[cfg(test)]
pub fn take_log_for_test() -> Vec<Verdict> {
    TEST_LOG.with(|cell| std::mem::take(&mut *cell.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::verify::VerifiedOutcome;
    use std::path::Path;

    /// Switch on, a command set, the table as built (None) or replaced (Some(json text)); all undone when the guard drops.
    struct Setup;
    impl Setup {
        fn new(command: Option<&'static str>, table: Option<String>) -> Self {
            TEST_ACTIVE.with(|c| *c.borrow_mut() = Some(true));
            let with_group = command.map(|name| {
                let group = crate::cli::group_of(name);
                assert!(group.is_some(), "{name} must be in groups.json commands");
                (name, group)
            });
            TEST_COMMAND.with(|c| *c.borrow_mut() = Some(with_group));
            // None = the real groups.json with every handoffs.rust row treated as measured (as it will be after the compile-time run); Setup::real keeps it as it is
            TEST_TABLE.with(|c| *c.borrow_mut() = Some(table.unwrap_or_else(measured_groups)));
            let _ = take_log_for_test();
            Setup
        }
    }
    impl Setup {
        fn real(command: Option<&'static str>) -> Self {
            Self::new(command, Some(GROUPS_JSON.to_string()))
        }
    }
    fn measured_groups() -> String {
        let mut value: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        for row in value["handoffs"]["rust"].as_array_mut().unwrap() {
            row.as_object_mut().unwrap().remove("not_measured");
        }
        value.to_string()
    }
    impl Drop for Setup {
        fn drop(&mut self) {
            TEST_ACTIVE.with(|c| *c.borrow_mut() = None);
            TEST_COMMAND.with(|c| *c.borrow_mut() = None);
            TEST_TABLE.with(|c| *c.borrow_mut() = None);
            TEST_OBSERVE.with(|c| *c.borrow_mut() = None);
            TEST_REVIEW_SPLIT.with(|c| *c.borrow_mut() = None);
        }
    }

    #[test]
    fn the_refusal_text_names_the_tools_groups_json_records_as_asking_first() {
        let knowledge = |group: &str| -> Vec<String> {
            if group == "knowledge" {
                [
                    "record_claim",
                    "zeta_tool",
                    "alpha_tool",
                    "beta_tool",
                    "duckdb_query",
                ]
                .map(String::from)
                .to_vec()
            } else {
                Vec::new()
            }
        };
        let origin = Origin {
            tool: "newsroom_viz_plan",
            group: "visual",
            writer: None,
            tools_of: &knowledge,
        };
        let verdict = Verdict {
            path: "claims.jsonl".into(),
            kind: Some("evidence".into()),
            owner: Some("knowledge".into()),
            group: Some("visual".into()),
            writer: None,
            requested_by: None,
            allowed: false,
        };
        // the data as it is: the only requester of claims.jsonl is a visual tool, so no tool of the knowledge group is derived from it
        {
            let _setup = Setup::real(None);
            let text = staged_refusal_text(&origin, "visual", "claims.jsonl", &verdict);
            assert!(
                text.ends_with(
                    "the tools you can call there: alpha_tool, beta_tool, duckdb_query."
                ),
                "record_claim cannot be derived from the table and is not hard-coded: {text}"
            );
        }
        // a table that records a knowledge-group tool as asking for that file: it comes first, the rest fills up alphabetically, and the output is stable
        let mut value: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        for row in value["handoffs"]["rows"].as_array_mut().unwrap() {
            if row["paths"] == serde_json::json!(["claims.jsonl"]) {
                row["requesters"] = serde_json::json!(["newsroom_viz_plan", "zeta_tool"]);
            }
        }
        let _setup = Setup::new(None, Some(value.to_string()));
        let first = staged_refusal_text(&origin, "visual", "claims.jsonl", &verdict);
        assert!(
            first.ends_with("the tools you can call there: zeta_tool, alpha_tool, beta_tool."),
            "{first}"
        );
        for _ in 0..5 {
            assert_eq!(
                staged_refusal_text(&origin, "visual", "claims.jsonl", &verdict),
                first
            );
        }
        // a file no row lists keeps the plain alphabetical choice
        let other = staged_refusal_text(&origin, "visual", "runtime/other.json", &verdict);
        assert!(
            other.ends_with("the tools you can call there: alpha_tool, beta_tool, duckdb_query."),
            "{other}"
        );
    }

    fn refused<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        let error = result.expect_err("the write must be refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        error.to_string()
    }

    /// record-only side files (verify.rs write_record_only; K377 10-14): shadow/ is observation, owned by knowledge. A direct `news verify` is the
    /// knowledge command and writes them as itself; the post-run verify inside investigate / continue asks the knowledge group's shadow writer
    /// (`as_shadow_writer`, a `handoffs.rust` row). Any other write into shadow/ from those commands is still refused.
    #[test]
    fn record_only_side_files_go_through_the_shadow_writer() {
        let rel = "shadow/record_thin_result-abc.json";
        let write_through_door = |root: &Path| {
            as_shadow_writer(|| {
                create_dir_all(root, &root.join("shadow"))?;
                create_new(root, &root.join(rel)).map(|_| ())
            })
        };
        // the table with its rows measured: the door lets all three commands write, and the file is there
        for command in ["verify", "investigate", "continue"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let _setup = Setup::new(Some(command), None);
            write_through_door(root).unwrap_or_else(|e| panic!("{command}: {e}"));
            assert!(root.join(rel).is_file(), "{command}");
        }
        // a command with no row for the door is refused, and nothing is written
        for command in ["ask", "interactive"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let _setup = Setup::new(Some(command), None);
            let text = refused(write_through_door(root));
            assert!(
                text.contains("may not ask shadow_writer"),
                "{command}: {text}"
            );
            assert!(!root.join(rel).exists(), "{command}");
        }
        // the real table: both commands were seen writing these files, so neither is in not_measured and the door lets them write
        for command in ["investigate", "continue"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let _setup = Setup::real(Some(command));
            write_through_door(root).unwrap_or_else(|e| panic!("{command}: {e}"));
            assert!(root.join(rel).is_file(), "{command}");
        }
        // releasing these pairs opens nothing else: another not_measured pair (ask x run_bundle_writer) is still refused
        {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let _setup = Setup::real(Some("ask"));
            let text = refused(as_run_bundle(|| write(root, &root.join("answer.md"), "a")));
            assert!(text.contains("may not ask run_bundle_writer"), "{text}");
            assert!(!root.join("answer.md").exists());
        }
        // any other write into shadow/ is still refused: without the door, and from another group's door
        for command in ["investigate", "continue"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let _setup = Setup::new(Some(command), None);
            let text = refused(create_dir_all(root, &root.join("shadow")));
            assert!(text.contains("shadow"), "{command}: {text}");
            let text = refused(create_new(root, &root.join(rel)));
            assert!(text.contains("record_thin_result"), "{command}: {text}");
            let text = refused(as_run_bundle(|| create_dir_all(root, &root.join("shadow"))));
            assert!(text.contains("shadow"), "{command}: {text}");
            assert!(!root.join("shadow").exists(), "{command}");
        }
    }

    #[test]
    fn off_is_the_plain_call() {
        let dir = tempfile::tempdir().unwrap();
        TEST_ACTIVE.with(|c| *c.borrow_mut() = Some(false));
        TEST_COMMAND.with(|c| *c.borrow_mut() = Some(None));
        write(dir.path(), &dir.path().join("anything.bin"), "x").unwrap();
        create_dir_all(dir.path(), &dir.path().join("a/b")).unwrap();
        assert!(dir.path().join("anything.bin").is_file() && dir.path().join("a/b").is_dir());
        assert!(
            !dir.path().join("runtime").exists(),
            "off: no refusal log, nothing extra"
        );
        TEST_ACTIVE.with(|c| *c.borrow_mut() = None);
        TEST_COMMAND.with(|c| *c.borrow_mut() = None);
    }

    #[test]
    fn own_group_is_allowed_other_groups_and_unknown_paths_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let _setup = Setup::new(Some("investigate"), None);
        // agent command, agent-owned path
        write(root, &root.join("story.json"), "{}").unwrap();
        write(root, &root.join("plan.json"), "{}").unwrap();
        // agent command, knowledge-owned path: refused, nothing written, text names no switch
        let text = refused(write(root, &root.join("claims.jsonl"), "x"));
        assert!(
            text.contains("claims.jsonl")
                && text.contains("evidence")
                && text.contains("knowledge_writer"),
            "{text}"
        );
        assert!(!text.contains("NEWSROOM_"), "{text}");
        assert!(!root.join("claims.jsonl").exists());
        // run bookkeeping belongs to the system group
        refused(write(root, &root.join("answer.md"), "x"));
        // unclassified path: 待查, refused
        refused(write(root, &root.join("nowhere/odd.bin"), "x"));
        // outside the run folder
        let other = tempfile::tempdir().unwrap();
        refused(write(root, &other.path().join("x.json"), "x"));
        // a `..` escape
        refused(write(root, &root.join("sub/../../escape.json"), "x"));
        // the refusal log exists and holds the refusals
        let log = fs::read_to_string(root.join(REFUSAL_LOG_PATH)).unwrap();
        assert!(log.lines().count() >= 4 && log.contains("claims.jsonl"));
    }

    #[test]
    fn no_command_context_is_refused_not_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let _setup = Setup::new(None, None);
        let text = refused(write(dir.path(), &dir.path().join("story.json"), "{}"));
        assert!(text.contains("unknown command"), "{text}");
        assert!(!dir.path().join("story.json").exists());
        // a writer hand-off still needs a path its group owns, and an asking command in its handoffs.rust row (none here: refused)
        refused(as_run_bundle(|| {
            write(dir.path(), &dir.path().join("story.json"), "{}")
        }));
        let text = refused(as_run_bundle(|| {
            write(dir.path(), &dir.path().join("answer.md"), "x")
        }));
        assert!(text.contains("may not ask run_bundle_writer"), "{text}");
    }

    #[test]
    fn handoffs_keep_requested_by_and_cannot_write_what_the_group_does_not_own() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let _setup = Setup::new(Some("investigate"), None);
        // skeleton folder, system-owned: refused for the knowledge writer
        refused(as_data_import(|| {
            create_dir_all(root, &root.join("data/origins"))
        }));
        let log = take_log_for_test();
        assert_eq!(log.len(), 1);
        assert!(
            !log[0].allowed,
            "a knowledge hand-off may not create a system skeleton folder"
        );
        as_run_bundle(|| create_dir_all(root, &root.join("data/origins")).unwrap());
        as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b").unwrap());
        as_data_import(|| write(root, &root.join("data/origins/h.json"), "{}").unwrap());
        let log = take_log_for_test();
        let data: Vec<_> = log
            .iter()
            .filter(|v| v.path.starts_with("data/") && v.path != "data/origins/")
            .collect();
        assert!(
            data.iter().all(|v| v.allowed
                && v.writer.as_deref() == Some("knowledge_writer")
                && v.requested_by.as_deref() == Some("investigate")
                && v.kind.as_deref() == Some("evidence")),
            "{data:?}"
        );
        // the system writer may not write evidence
        refused(as_run_bundle(|| write(root, &root.join("data/x.csv"), "x")));
        // materialization: runtime code names only, requested_by is the running command
        as_materialize(|| create_dir_all(root, &root.join("runtime"))).unwrap();
        as_materialize(|| create_dir_all(root, &root.join("config"))).unwrap();
        as_materialize(|| write(root, &root.join("runtime/newsroom.ts"), "x")).unwrap();
        as_materialize(|| create_dir_all(root, &root.join("runtime/assets"))).unwrap();
        as_materialize(|| {
            write(
                root,
                &root.join("config/editorial-grammar-registry.json"),
                "{}",
            )
        })
        .unwrap();
        let log = take_log_for_test();
        assert!(log
            .iter()
            .filter(|v| v.writer.as_deref() == Some("materialize_writer"))
            .all(|v| v.allowed && v.requested_by.as_deref() == Some("investigate")));
        refused(as_materialize(|| {
            write(root, &root.join("runtime/query-rows/q.json"), "[]")
        }));
        refused(as_materialize(|| {
            write(root, &root.join("runtime/anything-else.py"), "x")
        }));
        refused(as_materialize(|| {
            write(root, &root.join("claims.jsonl"), "x")
        }));
        // the same path by the agent command itself is the agent's, not the system's
        refused(write(root, &root.join("runtime/newsroom.ts"), "x"));
        write(root, &root.join("runtime/tool-chain-events.jsonl"), "x").unwrap();
    }

    #[test]
    fn a_pass_value_the_program_did_not_compute_is_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = root.join("verification.json");
        // continue (agent) writes the record through the knowledge hand-off with the value the program computed
        let _setup = Setup::new(Some("continue"), None);
        let record = serde_json::json!({ "passed": false, "checks": 0 });
        write_not_passed_record(root, &path, &record).unwrap();
        assert!(path.is_file());
        fs::remove_file(&path).unwrap();
        // a model-supplied "passed": true against the program's false: refused, nothing written
        let supplied = serde_json::json!({ "passed": true, "checks": 0 });
        refused(write_verification_record(
            root,
            &path,
            &supplied,
            &VerifiedOutcome::for_test(false),
        ));
        // and the credential-less door refuses anything that says passed
        refused(write_not_passed_record(root, &path, &supplied));
        assert!(!path.exists());
        // a record without the field is refused too
        refused(write_verification_record(
            root,
            &path,
            &serde_json::json!({ "checks": 0 }),
            &VerifiedOutcome::for_test(false),
        ));
        // verify itself (knowledge) writes its own record directly
        let _verify = Setup::new(Some("verify"), None);
        write_verification_record(
            root,
            &path,
            &serde_json::json!({ "passed": true }),
            &VerifiedOutcome::for_test(true),
        )
        .unwrap();
        // investigate runs verify at its end: the same call, the same credential, a listed asking command
        let _investigate = Setup::new(Some("investigate"), None);
        fs::remove_file(&path).unwrap();
        write_verification_record(
            root,
            &path,
            &serde_json::json!({ "passed": true }),
            &VerifiedOutcome::for_test(true),
        )
        .unwrap();
        // a pass the checks did not compute is refused for it too
        refused(write_verification_record(
            root,
            &path,
            &serde_json::json!({ "passed": true }),
            &VerifiedOutcome::for_test(false),
        ));
        // and the plain write of verification.json by the agent command is refused: the only door is the hand-off above
        let _agent = Setup::new(Some("continue"), None);
        refused(write(root, &path, "{\"passed\":true}"));
    }

    /// Bare `news` runs as the agent group's launcher (fe, K213): story.json is its own, evidence needs the hand-off like any agent command.
    #[test]
    fn the_interactive_launcher_is_registered_as_the_agent_group() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(crate::cli::group_of("interactive"), Some("agent"));
        let _setup = Setup::new(Some("interactive"), None);
        write(root, &root.join("story.json"), "{}").unwrap();
        refused(write(root, &root.join("claims.jsonl"), "x"));
        // no verification write without the hand-off
        refused(write(root, &root.join("verification.json"), "{}"));
        // K389b: the hand-off row lists interactive (seen in a stand-in session), so the program's own record goes through; a pass the checks did not make still does not
        let record = serde_json::json!({ "passed": false });
        write_verification_record(
            root,
            &root.join("verification.json"),
            &record,
            &VerifiedOutcome::for_test(false),
        )
        .unwrap();
        refused(write_verification_record(
            root,
            &root.join("verification.json"),
            &serde_json::json!({ "passed": true }),
            &VerifiedOutcome::for_test(false),
        ));
    }

    #[test]
    fn switch_off_writes_the_record_as_the_program_always_did() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        TEST_ACTIVE.with(|c| *c.borrow_mut() = Some(false));
        let path = root.join("verification.json");
        write_verification_record(
            root,
            &path,
            &serde_json::json!({ "passed": true }),
            &VerifiedOutcome::for_test(false),
        )
        .unwrap();
        TEST_ACTIVE.with(|c| *c.borrow_mut() = None);
        assert!(path.is_file());
    }

    #[test]
    fn mutated_table_changes_the_answer_and_a_broken_table_refuses_everything() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut value: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        // delete the story.json row: the path becomes 待查 and the agent command is refused
        {
            let rules = value["artifact_kinds"]["rules"].as_array_mut().unwrap();
            rules.retain(|r| r["exact"] != "story.json");
        }
        let _setup = Setup::new(Some("investigate"), Some(value.to_string()));
        refused(write(root, &root.join("story.json"), "{}"));
        drop(_setup);
        // change the owner of project_state to knowledge: the agent command may no longer write story.json
        let mut value: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        value["artifact_kinds"]["ownership"]["project_state"]["owner"] = Value::from("knowledge");
        let _setup = Setup::new(Some("investigate"), Some(value.to_string()));
        refused(write(root, &root.join("story.json"), "{}"));
        drop(_setup);
        // a table that cannot be read refuses every write
        let _setup = Setup::new(Some("investigate"), Some("{not json".to_string()));
        refused(write(root, &root.join("story.json"), "{}"));
    }

    /// The same path samples the Pi side classifies (scripts/fixtures/group_path_samples.json): the answers must be identical.
    #[test]
    fn classification_matches_the_shared_samples() {
        let samples: Value =
            serde_json::from_str(include_str!("../scripts/fixtures/group_path_samples.json"))
                .unwrap();
        let rows = samples.as_array().unwrap();
        assert!(rows.len() >= 70, "{} samples", rows.len());
        for row in rows {
            let path = row["path"].as_str().unwrap();
            let expected = row["kind"].as_str();
            assert_eq!(
                classify(path).map(|c| c.0).as_deref(),
                expected,
                "path {path:?}"
            );
        }
    }

    /// K214: a hand-off must be a row of handoffs.rust. The path is the writer's own kind, so only the table can stop it.
    #[test]
    fn a_handoff_needs_its_row_and_an_asking_command_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("data")).unwrap();
        // ask is an agent command, data/ is knowledge evidence, the knowledge writer owns it: only the commands list keeps ask out
        let _setup = Setup::new(Some("ask"), None);
        let text = refused(as_data_import(|| {
            write(root, &root.join("data/abc.csv"), "a,b")
        }));
        assert!(text.contains("may not ask knowledge_writer"), "{text}");
        assert!(!root.join("data/abc.csv").exists());
        drop(_setup);
        // the same call from investigate is a listed pair
        let _setup = Setup::new(Some("investigate"), None);
        as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b")).unwrap();
        drop(_setup);
        // a table whose handoffs.rust is emptied refuses every hand-off, and one without the key cannot be read at all
        let mut value: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        value["handoffs"]["rust"] = Value::Array(Vec::new());
        let _setup = Setup::new(Some("investigate"), Some(value.to_string()));
        refused(as_data_import(|| {
            write(root, &root.join("data/def.csv"), "x")
        }));
        refused(as_run_bundle(|| write(root, &root.join("answer.md"), "x")));
        drop(_setup);
        let mut value: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        value.as_object_mut().unwrap().remove("handoffs");
        let _setup = Setup::new(Some("investigate"), Some(value.to_string()));
        refused(write(root, &root.join("story.json"), "{}"));
    }

    /// K214: a command kept in not_measured is listed but refused (and logged) until a run has seen it; the real table has not been measured for Rust yet.
    #[test]
    fn a_not_measured_command_is_refused_until_measured() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("data")).unwrap();
        // investigate was seen writing the run bundle (10-11 census); ask was not (interactive was measured in K389b and left not_measured)
        let _setup = Setup::real(Some("ask"));
        let text = refused(as_run_bundle(|| write(root, &root.join("answer.md"), "a")));
        assert!(text.contains("may not ask run_bundle_writer"), "{text}");
        assert!(!root.join("answer.md").exists());
        drop(_setup);
        let _setup = Setup::real(Some("investigate"));
        as_run_bundle(|| write(root, &root.join("answer.md"), "a")).unwrap();
        drop(_setup);
        let _setup = Setup::new(Some("ask"), None);
        as_run_bundle(|| write(root, &root.join("answer.md"), "b")).unwrap();
    }

    fn observed_lines(root: &Path) -> Vec<Value> {
        std::fs::read_to_string(root.join(OBSERVED_LOG_PATH))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn exempt_rows(root: &Path) -> Vec<Value> {
        std::fs::read_to_string(root.join(CALL_REPORT_PATH))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Each exemption has one name, in the order groups.mjs `exemptionOf` checks them; `is_exempt` agrees with it for every path.
    #[test]
    fn exempt_reason_names_each_exemption_and_is_exempt_agrees() {
        let cases = [
            ("runtime/preview-tmp/a.png", Some("preview_tmp")),
            ("runtime/preview-tmp/a.tmp", Some("preview_tmp")),
            ("charts/x.svg.tmp", Some("temp_suffix")),
            ("data/y.json.write-tmp", Some("temp_suffix")),
            ("session/a.jsonl", Some("session_folder")),
            ("events.jsonl", Some("bookkeeping_file")),
            ("runtime/cross-call-report.jsonl", Some("bookkeeping_file")),
            ("claims.jsonl", None),
            ("runtime/other.json", None),
        ];
        for (path, reason) in cases {
            assert_eq!(exempt_reason(path), reason, "{path}");
            assert_eq!(is_exempt(path), reason.is_some(), "{path}");
        }
    }

    /// Only the exact value "1" counts (the same rule as the observe switch).
    #[test]
    fn the_exempt_record_switch_is_exactly_one() {
        assert_eq!(EXEMPT_RECORD_SWITCH, "NEWSROOM_GROUP_EXEMPT_RECORD");
        assert!(exempt_record_value(Some("1")));
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some("yes"),
            Some("01"),
            Some(" 1"),
            Some("1 "),
            Some("11"),
        ] {
            assert!(!exempt_record_value(value), "{value:?}");
        }
    }

    /// Off: no file. On: one row per exemption and path (a repeat once), none for a judged path or for the report file itself; every row has the six fields.
    #[test]
    fn note_exempt_records_each_exemption_once_and_nothing_when_off() {
        let _off = exempt_record_for_test(false);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let paths = [
            "runtime/preview-tmp/a.png",
            "x.svg.tmp",
            "session/a.jsonl",
            "events.jsonl",
        ];
        for path in paths {
            note_exempt(root, "newsroom_viz_render", path, "write");
        }
        assert!(
            !root.join(CALL_REPORT_PATH).exists(),
            "off: nothing is written"
        );
        let _on = exempt_record_for_test(true);
        for path in paths {
            note_exempt(root, "newsroom_viz_render", path, "write");
            note_exempt(root, "newsroom_viz_render", path, "write");
        }
        note_exempt(root, "newsroom_viz_render", "claims.jsonl", "write");
        note_exempt(root, "newsroom_viz_render", CALL_REPORT_PATH, "append");
        let rows = exempt_rows(root);
        let got: Vec<(String, String)> = rows
            .iter()
            .map(|r| {
                (
                    r["path"].as_str().unwrap().to_string(),
                    r["exemption"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("runtime/preview-tmp/a.png", "preview_tmp"),
                ("x.svg.tmp", "temp_suffix"),
                ("session/a.jsonl", "session_folder"),
                ("events.jsonl", "bookkeeping_file"),
            ]
            .map(|(a, b)| (a.to_string(), b.to_string())),
        );
        for row in &rows {
            assert_eq!(row["kind"], "exempt_write");
            assert_eq!(row["side"], "rust");
            assert_eq!(row["tool"], "newsroom_viz_render");
            assert_eq!(row["op"], "write");
            assert_eq!(row.as_object().unwrap().len(), 6);
        }
    }

    /// Observe switch off: the verdicts are the old ones and no record file appears. On: nothing is refused for its row, both sorts are recorded, the first gate still refuses.
    #[test]
    fn the_observe_switch_records_the_command_side_rows_and_never_refuses_for_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("data")).unwrap();
        // off (the default): ask is refused as before and nothing is recorded
        let _setup = Setup::new(Some("ask"), None);
        assert!(!observe_enabled());
        let text = refused(as_data_import(|| {
            write(root, &root.join("data/abc.csv"), "a,b")
        }));
        assert!(text.contains("may not ask knowledge_writer"), "{text}");
        assert!(!root.join(OBSERVED_LOG_PATH).exists());
        // on: the same call goes through and is recorded as unlisted
        TEST_OBSERVE.with(|c| *c.borrow_mut() = Some(true));
        as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b")).unwrap();
        // a not-owned path is still refused by the first gate, and recorded as such
        refused(as_data_import(|| write(root, &root.join("answer.md"), "x")));
        drop(_setup);
        // a listed pair is recorded as listed
        let _setup = Setup::new(Some("investigate"), None);
        TEST_OBSERVE.with(|c| *c.borrow_mut() = Some(true));
        as_data_import(|| write(root, &root.join("data/def.csv"), "a,b")).unwrap();
        // a not_measured pair (the real table) is recorded as unlisted and let through
        drop(_setup);
        let _setup = Setup::real(Some("ask"));
        TEST_OBSERVE.with(|c| *c.borrow_mut() = Some(true));
        as_run_bundle(|| write(root, &root.join("answer.md"), "x")).unwrap();
        TEST_OBSERVE.with(|c| *c.borrow_mut() = None);
        let lines = observed_lines(root);
        let decisions: Vec<(&str, &str, &str)> = lines
            .iter()
            .map(|l| {
                (
                    l["command"].as_str().unwrap(),
                    l["path"].as_str().unwrap(),
                    l["decision"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            decisions,
            vec![
                ("ask", "data/abc.csv", "unlisted"),
                ("ask", "answer.md", "not_owned"),
                ("investigate", "data/def.csv", "listed"),
                ("ask", "answer.md", "unlisted"),
            ]
        );
        assert_eq!(lines[0]["writer"], "knowledge_writer");
        assert_eq!(lines[0]["group"], "knowledge");
        assert_eq!(lines[0]["side"], "rust-command");
        // the switch is exactly "1" in the environment, nothing else counts
        assert_eq!(OBSERVE_SWITCH, "NEWSROOM_GROUP_HANDOFF_OBSERVE");
    }

    /// NEWSROOM_REVIEW_SPLIT on (the default): the same two rules as groups.mjs, judged on a staged call. Off, none of it is refused.
    #[test]
    fn the_review_split_refuses_draw_on_review_paths_and_review_moving_draw_products() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let none = |_: &str| Vec::<String>::new();
        let origin = |tool: &'static str, writer: Option<&'static str>| Origin {
            tool,
            group: "visual",
            writer,
            tools_of: &none,
        };
        let _setup = Setup::real(None);
        let judge = |tool: &'static str, writer: Option<&'static str>, rel: &str, op: &str| {
            judge_staged_op(root, &origin(tool, writer), rel, op)
        };
        TEST_REVIEW_SPLIT.with(|c| *c.borrow_mut() = Some(false));
        assert!(
            judge(
                "newsroom_viz_render",
                None,
                "visualizations/qa/a.json",
                "write"
            )
            .is_ok(),
            "off: allowed as before"
        );
        assert!(
            judge(
                "newsroom_viz_critic",
                None,
                "visualizations/a.json",
                "unlink"
            )
            .is_ok(),
            "off: allowed as before"
        );
        TEST_REVIEW_SPLIT.with(|c| *c.borrow_mut() = Some(true));
        for rel in [
            "visualizations/qa/a.json",
            "visualizations/critics/a.json",
            "visualizations/lints/a.json",
            "infographics/qa/a.json",
            "infographics/vision-critics/a.json",
            "publications/qa/a/browser-qa.json",
        ] {
            let refused = judge("newsroom_viz_render", None, rel, "write");
            assert!(
                refused.as_ref().is_err_and(|t| t.contains("review record")),
                "{rel}: {refused:?}"
            );
        }
        assert!(
            judge("newsroom_viz_render", None, "visualizations/a.svg", "write").is_ok(),
            "a draw tool writes its own products"
        );
        assert!(
            judge(
                "newsroom_viz_critic",
                None,
                "visualizations/qa/a.json",
                "write"
            )
            .is_ok(),
            "a review tool writes its record"
        );
        assert!(judge(
            "newsroom_viz_critic",
            None,
            "visualizations/critics/a.json",
            "write"
        )
        .is_ok());
        assert!(
            judge(
                "newsroom_viz_critic",
                None,
                "visualizations/a.json",
                "unlink"
            )
            .is_err(),
            "a review tool may not unlink a manifest itself"
        );
        assert!(judge(
            "newsroom_viz_critic",
            None,
            "visualizations/rejected/a/manifest.json",
            "write"
        )
        .is_err());
        let log = std::fs::read_to_string(root.join(REFUSAL_LOG_PATH)).unwrap_or_default();
        assert!(
            log.contains("review_path_by_draw_tool") && log.contains("draw_path_by_review_tool"),
            "{log}"
        );
        TEST_REVIEW_SPLIT.with(|c| *c.borrow_mut() = None);
    }

    /// An exempt path passes `judge_staged_op` for any origin (as staging let it through before), and is noted only with the record switch on; a path that is
    /// not exempt is still judged.
    #[test]
    fn judge_staged_op_passes_exempt_paths_and_notes_them_only_with_the_switch_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let none = |_: &str| Vec::<String>::new();
        let origin = Origin {
            tool: "not_a_listed_tool",
            group: "visual",
            writer: None,
            tools_of: &none,
        };
        let _setup = Setup::real(None);
        let _off = exempt_record_for_test(false);
        for path in [
            "events.jsonl",
            "x.svg.tmp",
            "session/a.jsonl",
            "runtime/preview-tmp/a.png",
        ] {
            assert_eq!(
                judge_staged_op(root, &origin, path, "write"),
                Ok(()),
                "{path}"
            );
        }
        assert!(
            !root.join(CALL_REPORT_PATH).exists(),
            "off: nothing is written"
        );
        let _on = exempt_record_for_test(true);
        assert_eq!(
            judge_staged_op(root, &origin, "events.jsonl", "append"),
            Ok(())
        );
        let rows = exempt_rows(root);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["op"], "append");
        assert_eq!(rows[0]["tool"], "not_a_listed_tool");
        assert!(judge_staged_op(root, &origin, "claims.jsonl", "write").is_err());
        assert_eq!(
            exempt_rows(root).len(),
            1,
            "a judged path is not an exempt row"
        );
    }

    /// The observe switch is for the command side only: a tool-side hand-off that no row lists is still refused with it on.
    #[test]
    fn the_observe_switch_leaves_the_tool_side_rows_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let none = |_: &str| Vec::<String>::new();
        let origin = Origin {
            tool: "not_a_listed_tool",
            group: "visual",
            writer: Some("knowledge_writer"),
            tools_of: &none,
        };
        let _setup = Setup::real(None);
        let off = judge_staged_op(root, &origin, "claims.jsonl", "write");
        assert!(off.is_err(), "refused with the switch off");
        TEST_OBSERVE.with(|c| *c.borrow_mut() = Some(true));
        let on = judge_staged_op(root, &origin, "claims.jsonl", "write");
        TEST_OBSERVE.with(|c| *c.borrow_mut() = None);
        assert_eq!(on, off, "the same refusal with the switch on");
        assert!(!root.join(OBSERVED_LOG_PATH).exists());
    }

    #[test]
    fn imported_data_must_hash_to_its_address_and_continue_writes_only_not_passed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let _setup = Setup::new(Some("continue"), None);
        check_imported_data(root, "data/aa.csv", "aa", "aa").unwrap();
        refused(check_imported_data(root, "data/aa.csv", "aa", "bb"));
        refused(check_imported_data(root, "data/zz.csv", "aa", "aa"));
        // continue (agent group): a passed record is refused even when the program computed true; not passed goes through
        let path = root.join("verification.json");
        refused(write_not_passed_record(
            root,
            &path,
            &serde_json::json!({ "passed": true }),
        ));
        assert!(!path.exists());
        write_not_passed_record(root, &path, &serde_json::json!({ "passed": false })).unwrap();
        drop(_setup);
        TEST_ACTIVE.with(|c| *c.borrow_mut() = Some(false));
        check_imported_data(root, "data/zz.csv", "aa", "bb").unwrap();
        TEST_ACTIVE.with(|c| *c.borrow_mut() = None);
    }

    #[test]
    fn scratch_is_a_fixed_exception() {
        let temp = std::env::temp_dir();
        assert!(is_scratch(&temp.join("newsroom-recompute-abc")));
        assert!(is_scratch(
            &temp.join("newsroom-recompute-abc").join("rows.json")
        ));
        assert!(!is_scratch(&temp.join("other-abc")));
        assert!(!is_scratch(
            &temp.join("newsroom-recompute-abc").join("..").join("x")
        ));
        assert!(!is_scratch(Path::new("/etc/newsroom-recompute-abc")));
        assert!(!is_scratch(&temp));
        let bad = temp.join("not-a-scratch-dir");
        assert!(create_scratch_dir(&bad).is_err() && !bad.exists());
        assert!(write_scratch(&bad.join("x"), "x").is_err());
    }

    #[test]
    fn enforce_without_tools_gets_a_note_and_nothing_else() {
        assert!(enforce_alone_hint(true, false)
            .unwrap()
            .contains("Rust side are not judged"));
        assert!(
            enforce_alone_hint(false, false).is_none(),
            "all off: silent"
        );
        assert!(enforce_alone_hint(true, true).is_none(), "both on: silent");
        assert!(
            enforce_alone_hint(false, true).is_none(),
            "tools alone is stopped by startup_check, not hinted"
        );
    }

    /// The two chain switches as values (tools, enforce), so the tests never touch the process environment.
    /// These tests are about the TOOLS / ENFORCE chain, so both call refusals are turned off ("0"): they are on by default and would stop
    /// every combination with the refusal off before the rule under test is reached.
    fn sw(values: [Option<&str>; 2]) -> Switches {
        let own = |v: Option<&str>| v.map(str::to_string);
        Switches {
            tools: own(values[0]),
            enforce: own(values[1]),
            call_refuse: own(Some("0")),
            call_refuse_all: own(Some("0")),
            ..Switches::default()
        }
    }

    #[test]
    fn tools_default_follows_the_refusal_switch() {
        // pure functions of the values: no process environment is read or changed
        // #64 step 4: TOOLS "0" is off, "1" is on, anything else follows the effective refusal (ENFORCE)
        let said = |values: [Option<&str>; 2]| {
            let s = sw(values);
            (
                tools_on_from(values[0], values[1]),
                startup_check_from(&s).is_ok(),
            )
        };
        assert_eq!(said([None, None]), (true, true), "nothing set: on");
        assert_eq!(said([Some("0"), None]), (false, true), "TOOLS 0: off");
        assert_eq!(
            said([None, Some("0")]),
            (false, true),
            "ENFORCE 0 without TOOLS: off, and it starts"
        );
        assert_eq!(
            said([Some("1"), Some("0")]),
            (true, false),
            "TOOLS 1 with the refusal off stops"
        );
        assert_eq!(said([Some("0"), Some("1")]), (false, true));
        for other in ["", "false", " 0", "00", "no", "true"] {
            assert_eq!(
                said([Some(other), None]),
                (true, true),
                "{other:?}: only exact 0 turns it off"
            );
            assert_eq!(
                said([Some(other), Some("0")]),
                (false, true),
                "{other:?}: follows the refusal"
            );
        }
    }

    #[test]
    fn startup_follows_the_refusal_default() {
        // pure functions of the values: no process environment is read or changed
        // #64 step 3: ENFORCE is on unless exactly "0"
        let said = |values: [Option<&str>; 2]| {
            startup_check_from(&sw(values)).err().map(|e| e.to_string())
        };
        let hint = |values: [Option<&str>; 2]| startup_hint_from(&sw(values));
        // default: nothing set starts, TOOLS=1 alone starts (the refusal is on)
        assert!(said([None, None]).is_none());
        assert!(said([Some("1"), None]).is_none());
        // ENFORCE "0" with TOOLS=1 keeps the stop; without TOOLS it just starts
        assert!(said([Some("1"), Some("0")])
            .unwrap()
            .starts_with("GROUP_TOOLS_NEEDS_ENFORCE"));
        assert!(said([None, Some("0")]).is_none());
        // #64 step 4: the note for the refusal on with TOOLS off, which now needs an explicit TOOLS=0; a default-on run and ENFORCE=1 alone print nothing
        assert!(
            hint([None, None]).is_none(),
            "default-on run prints no note"
        );
        assert!(
            hint([None, Some("1")]).is_none(),
            "ENFORCE=1 alone: TOOLS follows it, so no note"
        );
        assert!(
            hint([Some("0"), None]).is_some(),
            "explicit TOOLS=0 prints it"
        );
        assert!(
            hint([Some("0"), Some("0")]).is_none(),
            "both off: nothing to say"
        );
        assert!(hint([None, Some("0")]).is_none());
    }

    #[test]
    fn startup_stops_when_a_link_of_the_switch_chain_is_missing() {
        // pure functions of the values: no process environment is read or changed
        let said = |values: [Option<&str>; 2]| {
            startup_check_from(&sw(values)).err().map(|e| e.to_string())
        };
        let hint = |values: [Option<&str>; 2]| startup_hint_from(&sw(values));
        assert!(said([None, None]).is_none(), "nothing set starts");
        assert!(said([Some("1"), Some("1")]).is_none());
        // #64 step 3: the refusal is on by default, so TOOLS=1 with ENFORCE unset starts; ENFORCE "0" stops it
        assert!(said([Some("1"), None]).is_none());
        assert!(said([Some("1"), Some("0")])
            .unwrap()
            .starts_with("GROUP_TOOLS_NEEDS_ENFORCE"));
        assert!(said([None, Some("1")]).is_none(), "ENFORCE alone starts");
        assert!(
            said([Some("true"), None]).is_none(),
            "TOOLS=true follows the refusal (on), so it does not stop"
        );
        assert!(said([None, Some("true")]).is_none());
        // K381 (B2), #64 step 4: the note for the refusal on with TOOLS off comes from the same variables, only the exact "0" of TOOLS counts, and it is never an error
        assert!(hint([Some("0"), Some("1")]).is_some());
        assert!(
            hint([Some("false"), Some("1")]).is_none(),
            "only the exact 0 turns TOOLS off"
        );
        assert!(hint([None, Some("true")]).is_none());
        assert!(hint([Some("1"), Some("1")]).is_none());
        assert!(hint([None, None]).is_none());
        // #66 step 2: both call refusals are on unless exactly "0". With ENFORCE or CALL_CHECK turned off and the refusals not turned off, the start stops
        let said_chain = |enforce: Option<&str>,
                          check: Option<&str>,
                          refuse: Option<&str>,
                          all: Option<&str>| {
            let s = Switches {
                enforce: enforce.map(str::to_string),
                call_check: check.map(str::to_string),
                call_refuse: refuse.map(str::to_string),
                call_refuse_all: all.map(str::to_string),
                ..Switches::default()
            };
            startup_check_from(&s).err().map(|e| e.to_string())
        };
        assert!(
            said_chain(None, None, None, None).is_none(),
            "defaults start"
        );
        assert!(said_chain(None, None, Some("1"), Some("1")).is_none());
        for (enforce, check) in [(Some("0"), None), (None, Some("0"))] {
            let text = said_chain(enforce, check, None, None).expect("must stop");
            assert!(
                text.starts_with("GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK"),
                "{text}"
            );
            assert!(
                text.contains("NEWSROOM_GROUP_CALL_REFUSE=0")
                    && text.contains("NEWSROOM_GROUP_CALL_REFUSE_ALL=0"),
                "{text}"
            );
            assert!(
                !text.contains(&["NEWSROOM_GROUP_", "HANDOFF"].concat())
                    && !text.contains(&["NEWSROOM_GROUP_", "CALL_REPORT"].concat()),
                "no message tells anyone to set the removed switches: {text}"
            );
            assert!(
                said_chain(enforce, check, Some("0"), None).is_some(),
                "ALL alone still stops"
            );
            assert!(
                said_chain(enforce, check, None, Some("0")).is_some(),
                "REFUSE alone still stops"
            );
            assert!(said_chain(enforce, check, Some("0"), Some("0")).is_none());
        }
    }

    /// The raw write calls the scan looks for, written the way the code names them.
    const RAW_WRITE_PATTERNS: [&str; 16] = [
        "fs::write(",
        "fs::create_dir_all(",
        "fs::create_dir(",
        "fs::copy(",
        "fs::rename(",
        "OpenOptions::new(",
        "File::create(",
        "File::create_new(",
        "fs::remove_file(",
        "fs::remove_dir_all(",
        "fs::remove_dir(",
        "fs::hard_link(",
        "fs::set_permissions(",
        "fs::symlink(",
        "tokio::fs::",
        ".set_len(",
    ];
    /// The std::fs (and tokio::fs, std::os::*::fs) functions that write; a call to one through an imported name is a raw write too.
    const FS_WRITE_FUNCTIONS: [&str; 11] = [
        "write",
        "create_dir_all",
        "create_dir",
        "copy",
        "rename",
        "remove_file",
        "remove_dir_all",
        "remove_dir",
        "hard_link",
        "set_permissions",
        "symlink",
    ];

    fn tokenize_use(tree: &str) -> Vec<String> {
        let chars: Vec<char> = tree.chars().collect();
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c.is_alphanumeric() || c == '_' {
                current.push(c);
            } else {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                if c == ':' && chars.get(i + 1) == Some(&':') {
                    tokens.push("::".to_string());
                    i += 1;
                } else if "{},*".contains(c) {
                    tokens.push(c.to_string());
                }
            }
            i += 1;
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        tokens
    }

    /// One use tree into its leaves: (full path, the name it binds). `self` binds its parent; `*` is kept as the last segment.
    fn use_leaves(
        tokens: &[String],
        pos: &mut usize,
        prefix: &[String],
        out: &mut Vec<(Vec<String>, String)>,
    ) {
        let mut path = prefix.to_vec();
        loop {
            match tokens.get(*pos).map(String::as_str) {
                Some("::") => *pos += 1,
                Some("{") => {
                    *pos += 1;
                    while *pos < tokens.len() && tokens[*pos] != "}" {
                        use_leaves(tokens, pos, &path, out);
                        if tokens.get(*pos).map(String::as_str) == Some(",") {
                            *pos += 1;
                        } else if tokens.get(*pos).map(String::as_str) != Some("}") {
                            break;
                        }
                    }
                    *pos += 1;
                    return;
                }
                Some("*") => {
                    *pos += 1;
                    path.push("*".to_string());
                    out.push((path, "*".to_string()));
                    return;
                }
                Some(segment) if segment != "," && segment != "}" => {
                    *pos += 1;
                    if segment != "self" {
                        path.push(segment.to_string());
                    }
                    if tokens.get(*pos).map(String::as_str) == Some("::") {
                        *pos += 1;
                        continue;
                    }
                    let mut name = path.last().cloned().unwrap_or_default();
                    if tokens.get(*pos).map(String::as_str) == Some("as") {
                        name = tokens.get(*pos + 1).cloned().unwrap_or_default();
                        *pos += 2;
                    }
                    out.push((path, name));
                    return;
                }
                _ => return,
            }
        }
    }

    /// True when `pattern` occurs in `code` with no identifier character (and, for a bare call, no `.` or `:`) right before it.
    fn contains_at_boundary(code: &str, pattern: &str, bare_call: bool) -> bool {
        code.match_indices(pattern)
            .any(|(at, _)| match code[..at].chars().next_back() {
                None => true,
                Some(c) => {
                    !(c.is_alphanumeric() || c == '_' || (bare_call && (c == '.' || c == ':')))
                }
            })
    }

    /// Every raw write in `code` (the non-test part of one source file) as (line index, line), including calls through an aliased
    /// or plain imported name: `use std::fs::write as w; w(..)`, `use std::fs as f; f::write(..)`, `use std::fs::{self, File as F}; F::create(..)`,
    /// an aliased `OpenOptions`, and any glob import of a fs module (the use line itself is reported).
    fn raw_write_hits(code: &str) -> Vec<(usize, String)> {
        let lines: Vec<&str> = code.lines().collect();
        let is_fs_module = |p: &[&str]| {
            matches!(
                p,
                ["std", "fs"]
                    | ["tokio", "fs"]
                    | ["std", "os", "unix", "fs"]
                    | ["std", "os", "windows", "fs"]
            )
        };
        // (pattern, bare call) found through imports
        let mut imported: Vec<(String, bool)> = Vec::new();
        let mut hits: Vec<(usize, String)> = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            let start = i;
            let mut first = lines[i].trim_start();
            for visibility in ["pub(crate) ", "pub(super) ", "pub "] {
                if let Some(rest) = first.strip_prefix(visibility) {
                    first = rest;
                }
            }
            i += 1;
            if !first.starts_with("use ") {
                continue;
            }
            let mut statement = first.to_string();
            while !statement.contains(';') && i < lines.len() {
                statement.push(' ');
                statement.push_str(lines[i].trim());
                i += 1;
            }
            let tree = statement["use ".len()..].split(';').next().unwrap_or("");
            let tokens = tokenize_use(tree);
            let mut leaves = Vec::new();
            let mut pos = 0;
            use_leaves(&tokens, &mut pos, &[], &mut leaves);
            for (path, name) in leaves {
                let p: Vec<&str> = path
                    .iter()
                    .map(String::as_str)
                    .filter(|s| *s != "crate")
                    .collect();
                let Some((last, parent)) = p.split_last() else {
                    continue;
                };
                if *last == "*" && is_fs_module(parent) {
                    hits.push((start, lines[start].trim_start().to_string()));
                } else if is_fs_module(p.as_slice()) {
                    if name != "fs" {
                        if p[0] == "tokio" {
                            imported.push((format!("{name}::"), false));
                        } else {
                            imported.extend(
                                FS_WRITE_FUNCTIONS
                                    .iter()
                                    .map(|f| (format!("{name}::{f}("), false)),
                            );
                        }
                    }
                } else if is_fs_module(parent) && FS_WRITE_FUNCTIONS.contains(last) {
                    imported.push((format!("{name}("), true));
                } else if is_fs_module(parent) && *last == "File" && name != "File" {
                    imported.push((format!("{name}::create("), false));
                    imported.push((format!("{name}::create_new("), false));
                } else if is_fs_module(parent) && *last == "OpenOptions" && name != "OpenOptions" {
                    imported.push((format!("{name}::new("), false));
                }
            }
        }
        for (index, line) in lines.iter().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            if RAW_WRITE_PATTERNS.iter().any(|p| code.contains(p))
                || imported
                    .iter()
                    .any(|(pattern, bare)| contains_at_boundary(code, pattern, *bare))
            {
                hits.push((index, code.to_string()));
            }
        }
        hits.sort();
        hits.dedup();
        hits
    }

    #[test]
    fn no_raw_write_calls_outside_this_module() {
        // The mutant "a call site goes back to a plain std::fs call" must turn this red: the only raw writes allowed in non-test code are
        // in this file (the wrappers, the refusal log, the scratch cleanup). Calls through an imported or aliased name count too (raw_write_hits).
        let mut found = Vec::new();
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs")
                    || path.ends_with("group_guard.rs")
                {
                    continue;
                }
                let text = fs::read_to_string(&path).unwrap();
                let lines: Vec<&str> = text.lines().collect();
                let end = (0..lines.len().saturating_sub(1))
                    .find(|&i| {
                        lines[i].trim() == "#[cfg(test)]"
                            && lines[i + 1].trim_start().starts_with("mod ")
                    })
                    .unwrap_or(lines.len());
                for (index, code) in raw_write_hits(&lines[..end].join("\n")) {
                    found.push(format!(
                        "{}:{}: {}",
                        path.strip_prefix(&base).unwrap().display(),
                        index + 1,
                        code
                    ));
                }
            }
        }
        assert!(
            found.is_empty(),
            "raw file writes outside group_guard: {found:#?}"
        );
    }

    /// One counterexample per import form: each must be caught. The clean samples (reads, File::open through an alias, io::Write
    /// methods, a method that shares an imported name) must not be.
    #[test]
    fn raw_write_scan_sees_aliased_imports() {
        let caught = [
            ("function alias", "use std::fs::write as w;\nfn g() { w(\"a\", \"b\").unwrap(); }"),
            ("plain function import", "use std::fs::write;\nfn g() { write(\"a\", \"b\").unwrap(); }"),
            ("module alias", "use std::fs as f;\nfn g() { f::write(\"a\", \"b\").unwrap(); }"),
            ("module alias, other function", "use std::fs as f;\nfn g() { f::remove_dir_all(\"a\").unwrap(); }"),
            ("self alias in a group", "use std::{fs::{self as files}, io};\nfn g() { files::create_dir_all(\"a\").unwrap(); }"),
            ("File alias in a group", "use std::fs::{self, File as F};\nfn g() { F::create(\"a\").unwrap(); }"),
            ("File alias, create_new", "use std::fs::File as Handle;\nfn g() { Handle::create_new(\"a\").unwrap(); }"),
            ("OpenOptions alias", "use std::fs::OpenOptions as O;\nfn g() { O::new().write(true).open(\"a\").unwrap(); }"),
            ("OpenOptions alias in a multi-line group", "use std::fs::{\n    File,\n    OpenOptions as Opts,\n};\nfn g() { Opts::new().append(true); }"),
            ("glob import", "use std::fs::*;\nfn g() {}"),
            ("tokio module alias", "use tokio::fs as tfs;\nasync fn g() { tfs::write(\"a\", \"b\").await.unwrap(); }"),
            ("pub(crate) function alias", "pub(crate) use std::fs::remove_file as rm;\nfn g() { rm(\"a\").unwrap(); }"),
            ("unix symlink alias", "use std::os::unix::fs::symlink as ln;\nfn g() { ln(\"a\", \"b\").unwrap(); }"),
        ];
        for (label, source) in caught {
            assert!(!raw_write_hits(source).is_empty(), "{label} must be caught");
        }
        let clean = [
            ("reads through fs", "use std::fs;\nfn g() { fs::read_to_string(\"a\").unwrap(); }"),
            ("File::open through an alias", "use std::fs::File as F;\nfn g() { F::open(\"a\").unwrap(); }"),
            ("io::Write methods", "use std::io::Write;\nfn g(out: &mut Vec<u8>) { out.write(b\"x\").unwrap(); writeln!(out).unwrap(); }"),
            ("a method sharing an imported name", "use std::fs::write as w;\nfn g(x: &X) { x.w(1); y::w(2); }"),
            ("module alias, read", "use std::fs as f;\nfn g() { f::read(\"a\").unwrap(); }"),
        ];
        for (label, source) in clean {
            assert!(
                raw_write_hits(source).is_empty(),
                "{label}: {:?}",
                raw_write_hits(source)
            );
        }
    }
}
