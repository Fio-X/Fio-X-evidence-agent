//! Rust side of NEWSROOM_GROUP_TOOLS=1: every file the program writes into a run folder is judged by the same table the Pi side reads
//! (`runtime/pi/groups.json`, `artifact_kinds`, included at build time; no second copy, no new dependency).
//!
//! The judge: the write's path gives its kind and owning group (first matching rule, exact or prefix); the writing group is the group of the current
//! command in `cli::COMMAND_GROUPS`, or the group of a hand-off writer (`as_writer`) the call site runs inside, with the asking command kept as
//! `requested_by` (K214: the writer, its group and the asking command must be a row of `handoffs.rust` in groups.json, else the write is refused). Owner equals writing group: allowed. Anything else is refused before the file is touched: a path in another group's kind, a path
//! no rule matches (待查), no command and no writer (no context is never a default allow), a path outside the run folder, a table that cannot be
//! read. Nothing here has a "let it through on error" branch.
//!
//! Off (the switch is not exactly "1"): every function below is the plain std::fs call, byte for byte the same behavior.
//! With the switch on, `NEWSROOM_GROUP_ENFORCE` must be exactly "1" too (`startup_check`), as on the Pi side.
//!
//! The only writes not judged (E1, fixed and pinned by a test): the program's own scratch folders for the recompute step
//! (`std::env::temp_dir()/newsroom-recompute-*`, outside the run folder). Reads are not judged (E2). Files a child process keeps inside
//! itself are not visible here (E3). The Rust commands do start one such child: `pi.rs` runs Pi with `--session-dir` pointing at `<run>/session/` (pi.rs:896-897; set at artifact.rs:202,
//! investigate.rs:453, continue_investigation.rs:345, investigate_v2.rs:346). The session files Pi writes there are E3 and are not judged here; Pi's own tools go through the Pi-side checks.

use serde_json::Value;
use std::cell::RefCell;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path};
use std::sync::OnceLock;

const GROUPS_JSON: &str = include_str!("../runtime/pi/groups.json");
pub const TOOLS_SWITCH: &str = "NEWSROOM_GROUP_TOOLS";
pub const ENFORCE_SWITCH: &str = "NEWSROOM_GROUP_ENFORCE";
/// Where a refused write is noted (same file the Pi side uses).
pub const REFUSAL_LOG_PATH: &str = "runtime/boundary-refusals.jsonl";
/// E1: the recompute scratch folders. Fixed prefix, pinned by a test.
pub const SCRATCH_PREFIX: &str = "newsroom-recompute-";

static COMMAND: OnceLock<(&'static str, Option<&'static str>)> = OnceLock::new();
static TABLE: OnceLock<Option<Table>> = OnceLock::new();

thread_local! {
    static WRITER: RefCell<Option<Handoff>> = const { RefCell::new(None) };
}
#[cfg(test)]
thread_local! {
    static TEST_ACTIVE: RefCell<Option<bool>> = const { RefCell::new(None) };
    static TEST_COMMAND: RefCell<Option<Option<(&'static str, Option<&'static str>)>>> = const { RefCell::new(None) };
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
                prefix: row.get("prefix").and_then(Value::as_str).map(str::to_string),
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
            let commands: Vec<String> = row.get("commands")?.as_array()?.iter().filter_map(|c| c.as_str().map(str::to_string)).collect();
            Some((row.get("writer")?.as_str()?.to_string(), row.get("group")?.as_str()?.to_string(), commands))
        })
        .collect::<Option<Vec<_>>>()?;
    let mut unmeasured = Vec::new();
    for row in value.get("handoffs")?.get("rust")?.as_array()? {
        let writer = row.get("writer")?.as_str()?.to_string();
        for command in row.get("not_measured").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            unmeasured.push((writer.clone(), command.to_string()));
        }
    }
    Some(Table { rules, owners, handoffs, unmeasured })
}

impl Table {
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

/// The path -> kind answer for a run-folder-relative path (for the cross-language test and the report).
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
    std::env::var(TOOLS_SWITCH).ok().as_deref() == Some("1")
}

/// With the switch on the refusal switch must be on as well; otherwise the program stops at start-up.
pub fn startup_check() -> anyhow::Result<()> {
    if std::env::var(TOOLS_SWITCH).ok().as_deref() == Some("1")
        && std::env::var(ENFORCE_SWITCH).ok().as_deref() != Some("1")
    {
        anyhow::bail!("GROUP_TOOLS_NEEDS_ENFORCE: checking each write against its group only works with the refusal of cross-group writes on");
    }
    Ok(())
}

/// Called once by `main` for the command that runs. One command per process, so this is process-wide and survives the async runtime.
/// `group` is the command's group in `cli::COMMAND_GROUPS` (None for a command that has none).
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

fn command_name() -> &'static str {
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
/// four `as_*` doors below exist, so no call site picks its own writer. No await may happen inside `f`.
fn as_writer<T>(group: &'static str, writer: &'static str, requested_by: &'static str, f: impl FnOnce() -> T) -> T {
    let previous = WRITER.with(|cell| cell.borrow_mut().replace(Handoff { group, writer, requested_by }));
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
fn refusal_text(command: &str, group: &str, path: &str, kind: Option<&str>, owner: Option<&str>) -> String {
    let writer = kind
        .and_then(writer_for_kind)
        .unwrap_or("no writer: the path has no owning group yet");
    format!(
        "boundary: {}（{}）may not write {}（{}, owner {}）. Use {}.",
        if command.is_empty() { "unknown command" } else { command },
        if group.is_empty() { "unknown group" } else { group },
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
    let classified = rel.as_deref().and_then(|rel| with_table(|table| table?.classify(rel)));
    let owned = matches!((&group, &classified, &rel), (Some(group), Some((_, owner, _)), Some(_)) if owner == group);
    // a hand-off must also be a row of handoffs.rust (writer, group, asking command); no row, no write
    let listed = handoff.is_none_or(|h| with_table(|table| table.is_some_and(|t| t.handoffs.iter().any(|(w, g, c)| w == h.writer && g == h.group && c.iter().any(|x| x == h.requested_by)) && !t.unmeasured.iter().any(|(w, c)| w == h.writer && c == h.requested_by))));
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
        Some(h) if owned && !listed => format!("boundary: {} may not ask {} to write {}.", if h.requested_by.is_empty() { "an unknown command" } else { h.requested_by }, h.writer, verdict.path),
        _ => refusal_text(shown, group.unwrap_or(""), &verdict.path, verdict.kind.as_deref(), verdict.owner.as_deref()),
    };
    note_refusal(root, if op == Op::Dir { "mkdir" } else { "write" }, &text, &verdict.path);
    Err(io::Error::new(io::ErrorKind::PermissionDenied, text))
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
    let Ok(rest) = path.strip_prefix(&temp) else { return false };
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
pub fn write_verification_record(root: &Path, path: &Path, record: &Value, outcome: &crate::commands::verify::VerifiedOutcome) -> io::Result<()> {
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
    let text = format!("{}\n", serde_json::to_string_pretty(record).map_err(io::Error::other)?);
    if command_group() == Some("knowledge") {
        write(root, path, text)
    } else {
        as_verification_record(|| write(root, path, text))
    }
}

/// K214 part B: an imported data file must be stored under its own content address. `actual` is the hash of the stored file, `expected` the one
/// the name was made from. Only with the switch on; off, nothing is checked and nothing changes.
pub fn check_imported_data(root: &Path, relative_file: &str, expected: &str, actual: &str) -> io::Result<()> {
    if !enabled() {
        return Ok(());
    }
    let stem_ok = relative_file.strip_prefix("data/").and_then(|name| name.split('.').next()).is_some_and(|stem| stem == expected);
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
                let group = crate::cli::COMMAND_GROUPS.iter().find(|(n, _)| *n == name).map(|(_, g)| *g);
                assert!(group.is_some(), "{name} must be in COMMAND_GROUPS");
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
        }
    }

    fn refused<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        let error = result.expect_err("the write must be refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        error.to_string()
    }

    #[test]
    fn off_is_the_plain_call() {
        let dir = tempfile::tempdir().unwrap();
        TEST_ACTIVE.with(|c| *c.borrow_mut() = Some(false));
        TEST_COMMAND.with(|c| *c.borrow_mut() = Some(None));
        write(dir.path(), &dir.path().join("anything.bin"), "x").unwrap();
        create_dir_all(dir.path(), &dir.path().join("a/b")).unwrap();
        assert!(dir.path().join("anything.bin").is_file() && dir.path().join("a/b").is_dir());
        assert!(!dir.path().join("runtime").exists(), "off: no refusal log, nothing extra");
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
        assert!(text.contains("claims.jsonl") && text.contains("evidence") && text.contains("knowledge_writer"), "{text}");
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
        refused(as_run_bundle(|| write(dir.path(), &dir.path().join("story.json"), "{}")));
        let text = refused(as_run_bundle(|| write(dir.path(), &dir.path().join("answer.md"), "x")));
        assert!(text.contains("may not ask run_bundle_writer"), "{text}");
    }

    #[test]
    fn handoffs_keep_requested_by_and_cannot_write_what_the_group_does_not_own() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let _setup = Setup::new(Some("investigate"), None);
        // skeleton folder, system-owned: refused for the knowledge writer
        refused(as_data_import(|| create_dir_all(root, &root.join("data/origins"))));
        let log = take_log_for_test();
        assert_eq!(log.len(), 1);
        assert!(!log[0].allowed, "a knowledge hand-off may not create a system skeleton folder");
        as_run_bundle(|| create_dir_all(root, &root.join("data/origins")).unwrap());
        as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b").unwrap());
        as_data_import(|| write(root, &root.join("data/origins/h.json"), "{}").unwrap());
        let log = take_log_for_test();
        let data: Vec<_> = log.iter().filter(|v| v.path.starts_with("data/") && v.path != "data/origins/").collect();
        assert!(data.iter().all(|v| v.allowed && v.writer.as_deref() == Some("knowledge_writer") && v.requested_by.as_deref() == Some("investigate") && v.kind.as_deref() == Some("evidence")), "{data:?}");
        // the system writer may not write evidence
        refused(as_run_bundle(|| write(root, &root.join("data/x.csv"), "x")));
        // materialization: runtime code names only, requested_by is the running command
        as_materialize(|| create_dir_all(root, &root.join("runtime"))).unwrap();
        as_materialize(|| create_dir_all(root, &root.join("config"))).unwrap();
        as_materialize(|| write(root, &root.join("runtime/newsroom.ts"), "x")).unwrap();
        as_materialize(|| create_dir_all(root, &root.join("runtime/assets"))).unwrap();
        as_materialize(|| write(root, &root.join("config/editorial-grammar-registry.json"), "{}")).unwrap();
        let log = take_log_for_test();
        assert!(log.iter().filter(|v| v.writer.as_deref() == Some("materialize_writer")).all(|v| v.allowed && v.requested_by.as_deref() == Some("investigate")));
        refused(as_materialize(|| write(root, &root.join("runtime/query-rows/q.json"), "[]")));
        refused(as_materialize(|| write(root, &root.join("runtime/anything-else.py"), "x")));
        refused(as_materialize(|| write(root, &root.join("claims.jsonl"), "x")));
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
        refused(write_verification_record(root, &path, &supplied, &VerifiedOutcome::for_test(false)));
        // and the credential-less door refuses anything that says passed
        refused(write_not_passed_record(root, &path, &supplied));
        assert!(!path.exists());
        // a record without the field is refused too
        refused(write_verification_record(root, &path, &serde_json::json!({ "checks": 0 }), &VerifiedOutcome::for_test(false)));
        // verify itself (knowledge) writes its own record directly
        let _verify = Setup::new(Some("verify"), None);
        write_verification_record(root, &path, &serde_json::json!({ "passed": true }), &VerifiedOutcome::for_test(true)).unwrap();
        // investigate runs verify at its end: the same call, the same credential, a listed asking command
        let _investigate = Setup::new(Some("investigate"), None);
        fs::remove_file(&path).unwrap();
        write_verification_record(root, &path, &serde_json::json!({ "passed": true }), &VerifiedOutcome::for_test(true)).unwrap();
        // a pass the checks did not compute is refused for it too
        refused(write_verification_record(root, &path, &serde_json::json!({ "passed": true }), &VerifiedOutcome::for_test(false)));
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
        // no verification write without the hand-off; the hand-off row lists continue only, so the launcher cannot ask for it
        refused(write(root, &root.join("verification.json"), "{}"));
        let record = serde_json::json!({ "passed": false });
        refused(write_verification_record(root, &root.join("verification.json"), &record, &VerifiedOutcome::for_test(false)));
    }

    #[test]
    fn switch_off_writes_the_record_as_the_program_always_did() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        TEST_ACTIVE.with(|c| *c.borrow_mut() = Some(false));
        let path = root.join("verification.json");
        write_verification_record(root, &path, &serde_json::json!({ "passed": true }), &VerifiedOutcome::for_test(false)).unwrap();
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
        let samples: Value = serde_json::from_str(include_str!("../scripts/fixtures/group_path_samples.json")).unwrap();
        let rows = samples.as_array().unwrap();
        assert!(rows.len() >= 70, "{} samples", rows.len());
        for row in rows {
            let path = row["path"].as_str().unwrap();
            let expected = row["kind"].as_str();
            assert_eq!(classify(path).map(|c| c.0).as_deref(), expected, "path {path:?}");
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
        let text = refused(as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b")));
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
        refused(as_data_import(|| write(root, &root.join("data/def.csv"), "x")));
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
        // investigate was seen importing data (10-11 census); interactive was not
        let _setup = Setup::real(Some("interactive"));
        let text = refused(as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b")));
        assert!(text.contains("may not ask knowledge_writer"), "{text}");
        assert!(!root.join("data/abc.csv").exists());
        drop(_setup);
        let _setup = Setup::real(Some("investigate"));
        as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b")).unwrap();
        drop(_setup);
        let _setup = Setup::new(Some("interactive"), None);
        as_data_import(|| write(root, &root.join("data/abc.csv"), "a,b")).unwrap();
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
        refused(write_not_passed_record(root, &path, &serde_json::json!({ "passed": true })));
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
        assert!(is_scratch(&temp.join("newsroom-recompute-abc").join("rows.json")));
        assert!(!is_scratch(&temp.join("other-abc")));
        assert!(!is_scratch(&temp.join("newsroom-recompute-abc").join("..").join("x")));
        assert!(!is_scratch(Path::new("/etc/newsroom-recompute-abc")));
        assert!(!is_scratch(&temp));
        let bad = temp.join("not-a-scratch-dir");
        assert!(create_scratch_dir(&bad).is_err() && !bad.exists());
        assert!(write_scratch(&bad.join("x"), "x").is_err());
    }

    #[test]
    fn startup_needs_the_refusal_switch() {
        // pure function of two variables; set and restore under a lock-free single test
        let before = (std::env::var(TOOLS_SWITCH).ok(), std::env::var(ENFORCE_SWITCH).ok());
        std::env::set_var(TOOLS_SWITCH, "1");
        std::env::remove_var(ENFORCE_SWITCH);
        assert!(startup_check().is_err());
        std::env::set_var(ENFORCE_SWITCH, "1");
        assert!(startup_check().is_ok());
        std::env::set_var(TOOLS_SWITCH, "true");
        std::env::remove_var(ENFORCE_SWITCH);
        assert!(startup_check().is_ok(), "only the exact value 1 counts");
        for (name, value) in [(TOOLS_SWITCH, before.0), (ENFORCE_SWITCH, before.1)] {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
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
                if path.extension().and_then(|e| e.to_str()) != Some("rs") || path.ends_with("group_guard.rs") {
                    continue;
                }
                let text = fs::read_to_string(&path).unwrap();
                let lines: Vec<&str> = text.lines().collect();
                let end = (0..lines.len().saturating_sub(1))
                    .find(|&i| lines[i].trim() == "#[cfg(test)]" && lines[i + 1].trim_start().starts_with("mod "))
                    .unwrap_or(lines.len());
                for (index, code) in raw_write_hits(&lines[..end].join("\n")) {
                    found.push(format!("{}:{}: {}", path.strip_prefix(&base).unwrap().display(), index + 1, code));
                }
            }
        }
        assert!(found.is_empty(), "raw file writes outside group_guard: {found:#?}");
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
