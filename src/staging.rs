//! Per-call staging for the Rust agent (1011ah step 7a, `NEWSROOM_AGENT=rust`, test-only module).
//!
//! Each tool call gets its own folder `<run>/staging/<callId>/`; the tool host is told its path in the `go` message and the Node write entry points
//! write there instead of into the run folder. A call a tool starts itself (a chain, parallel tasks) has its own sibling folder named
//! `<callId>:<inner tool>...`, so its writes belong to the inner tool, not to the call that started it.
//!
//! Layout inside a call folder, fixed by `stagedWriteRoot` in `runtime/pi/groups.mjs`: `<own | writer-NAME>/<write | append | once>/<run-relative path>`.
//!
//! After the call, `finish` lists every file in the call's folders, judges each with `group_guard::judge_staged` (same `groups.json`, the writing
//! group being the group of the tool that wrote it, or a hand-off writer's group), and moves each file that passes into the run folder; a file that
//! does not pass is dropped and logged on its own (1011ai: what each write did on its own is what the call does now). A judge that runs past the limit,
//! a file that is not a plain file or a name outside the layout refuses that file. Step 7b adds the three protocol operations in `ops.jsonl` (see `one_op`). The refusal goes to `runtime/boundary-refusals.jsonl` in the format the Pi side writes.
//! Program bookkeeping and temp names (`group_guard::is_exempt`, E1) are moved without a judgement; the metrics file is outside the run folder and
//! never staged, and the session file is written by Rust itself (`session_store`), not through the host.

use crate::group_guard::{self, Commit, Origin};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Folder of the staging areas inside a run folder.
pub const DIR: &str = "staging";
/// The call folder's journal of protocol operations, one JSON line each; written by `stageOp` in `runtime/pi/groups.mjs`.
pub const OPS_FILE: &str = "ops.jsonl";
/// Node's boundary-report records for the call (one JSON line each), left in the call folder for Rust to count (1011aj step 8).
pub const REPORT_FILE: &str = "report.jsonl";
/// Per-file judging limit; the same 250 ms the Pi side allows a check.
pub const LIMIT: Duration = Duration::from_millis(250);

/// What `finish` did with a call's files.
#[derive(Debug, Default, PartialEq)]
pub struct Finished {
    /// Run-relative paths moved in, in the order they were moved.
    pub kept: Vec<String>,
    /// The protocol operations that were executed, as `unlink a` / `rename a -> b`, in the order they ran (before the files were moved in).
    pub ops: Vec<String>,
    /// One text per file (or folder) that was not kept: what the model is told, as the failed write would have told it.
    pub refusals: Vec<String>,
}

/// Judging settings. `delay` only exists in tests (a judge that is too slow).
pub struct Check {
    pub limit: Duration,
    /// `Some(status_computed)`: add the passed items to `runtime/group-boundary-report.json` (the host was told `counted`); `None`: Node counts them.
    pub report: Option<bool>,
    #[cfg(test)]
    pub delay: Duration,
}

impl Default for Check {
    fn default() -> Self {
        Self {
            limit: LIMIT,
            report: None,
            #[cfg(test)]
            delay: Duration::ZERO,
        }
    }
}

fn origin<'a>(
    tool: &'a str,
    group: &'a str,
    writer: Option<&'a str>,
    tools_of: &'a dyn Fn(&str) -> Vec<String>,
) -> Origin<'a> {
    Origin {
        tool,
        group,
        writer,
        tools_of,
    }
}

fn staging_root(run_dir: &Path) -> PathBuf {
    run_dir.join(DIR)
}

/// Opens `<run>/staging/<call_id>/` and returns its path (for the `go` message). A call id with a path separator is refused.
pub fn begin(run_dir: &Path, call_id: &str) -> io::Result<PathBuf> {
    if call_id.is_empty() || call_id.contains(['/', '\\']) || call_id == "." || call_id == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a call id may not be empty or hold a path separator",
        ));
    }
    let dir = staging_root(run_dir).join(call_id);
    group_guard::create_staging_dir(run_dir, &dir)?;
    Ok(dir)
}

/// The folders that belong to `call_id`: its own and the ones its inner calls opened (`<call_id>:...`), with the tool each one ran.
fn call_dirs(run_dir: &Path, call_id: &str, tool: &str) -> io::Result<Vec<(PathBuf, String)>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(staging_root(run_dir))? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == call_id {
            found.push((entry.path(), tool.to_string()));
        } else if name.starts_with(&format!("{call_id}:")) {
            // inner call ids are `<outer id>:<tool name>`; a chain inside a chain repeats the pattern, the innermost tool is the last piece
            let inner = name.rsplit(':').next().unwrap_or("").to_string();
            found.push((entry.path(), inner));
        }
    }
    found.sort();
    Ok(found)
}

fn plain_files(dir: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("a staging folder cannot be read ({e})"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("a staging folder cannot be read ({e})"))?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if prefix.is_empty() && (name == OPS_FILE || name == REPORT_FILE) {
            continue; // the call's operations journal and Node's report lines, read by `finish` itself
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry
            .file_type()
            .map_err(|e| format!("a staged file cannot be inspected ({e})"))?;
        if kind.is_dir() {
            plain_files(&entry.path(), &rel, out)?;
        } else if kind.is_file() {
            out.push((entry.path(), rel));
        } else {
            return Err(format!(
                "{rel} is not a plain file (a link or special file is never kept)"
            ));
        }
    }
    Ok(())
}

/// What one call's judging needs besides the files: where, the limits, how tools map to groups and back, and the items that passed (for the report).
struct Ctx<'a> {
    run_dir: &'a Path,
    check: &'a Check,
    tools_of: &'a dyn Fn(&str) -> Vec<String>,
    passed: Vec<group_guard::Passed>,
}

impl Ctx<'_> {
    fn origin<'b>(&'b self, tool: &'b str, group: &'b str, writer: Option<&'b str>) -> Origin<'b> {
        origin(tool, group, writer, self.tools_of)
    }

    fn refuse(
        &self,
        tool: &str,
        group: &str,
        writer: Option<&str>,
        rel: &str,
        why: &str,
    ) -> String {
        group_guard::refuse_staged_check(self.run_dir, &self.origin(tool, group, writer), rel, why)
    }

    /// The judgement of one path (with the time limit); exempt bookkeeping and temp names pass without one (judge_staged_op lets them through). On a pass the item is kept for the report.
    fn judge(
        &mut self,
        tool: &str,
        group: &str,
        writer: Option<&str>,
        rel: &str,
        op: &'static str,
    ) -> Result<(), String> {
        let started = Instant::now();
        #[cfg(test)]
        std::thread::sleep(self.check.delay);
        let verdict =
            group_guard::judge_staged_op(self.run_dir, &self.origin(tool, group, writer), rel, op);
        if started.elapsed() > self.check.limit {
            return Err(self.refuse(
                tool,
                group,
                writer,
                rel,
                "the check ran past its time limit",
            ));
        }
        verdict?;
        self.passed.push(group_guard::Passed {
            tool: tool.to_string(),
            group: group.to_string(),
            writer: writer.map(str::to_string),
            op,
            rel: rel.to_string(),
        });
        Ok(())
    }
}

/// Judges what the call left in its folders, file by file, and moves every file that passes into the run folder (a file that does not pass is
/// dropped and logged; the others are not affected, as when each write was judged on its own). `group_of` gives the group of a tool by name
/// (`None` for a tool the host did not list: its files are refused, never guessed); `tools_of` the tools of a group the model can call (for the
/// refusal text). The call's protocol operations (`ops.jsonl`) run first, each judged on its destination only. The folders are removed in every
/// case. Called after a result and after an error or a cancel alike: what a failed call wrote is kept like any other legal write (failure evidence
/// is kept). With `check.report` the passed items are counted in the boundary report.
pub fn finish(
    run_dir: &Path,
    call_id: &str,
    tool: &str,
    group_of: &dyn Fn(&str) -> Option<String>,
    tools_of: &dyn Fn(&str) -> Vec<String>,
    check: &Check,
) -> Finished {
    let mut done = Finished::default();
    let mut ctx = Ctx {
        run_dir,
        check,
        tools_of,
        passed: Vec::new(),
    };
    let dirs = match call_dirs(run_dir, call_id, tool) {
        Ok(dirs) => dirs,
        Err(error) => {
            let group = group_of(tool).unwrap_or_default();
            done.refusals.push(ctx.refuse(
                tool,
                &group,
                None,
                DIR,
                &format!("the staging folder cannot be read ({error})"),
            ));
            return done;
        }
    };
    for (dir, inner) in &dirs {
        let group = group_of(inner).unwrap_or_default();
        one_folder(&mut ctx, &mut done, dir, inner, &group);
    }
    // what Node judged itself inside the calls (report.jsonl): read before the folders go; a line that cannot be read is left out, not guessed
    let lines: Vec<serde_json::Value> = dirs
        .iter()
        .filter_map(|(dir, _)| fs::read_to_string(dir.join(REPORT_FILE)).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<serde_json::Value>>()
        })
        .collect();
    for (dir, _) in &dirs {
        let _ = group_guard::clear_staging_dir(run_dir, dir);
    }
    if let Some(status_computed) = check.report {
        let _ = group_guard::count_passed(run_dir, &ctx.passed, &lines, status_computed);
    }
    done
}

fn one_folder(ctx: &mut Ctx, done: &mut Finished, dir: &Path, tool: &str, group: &str) {
    for op in read_ops(dir) {
        match op {
            Ok((op, writer)) => match one_op(ctx, dir, tool, group, writer.as_deref(), &op) {
                Ok(text) => done.ops.push(text),
                Err(text) => done.refusals.push(text),
            },
            Err(reason) => done
                .refusals
                .push(ctx.refuse(tool, group, None, OPS_FILE, &reason)),
        }
    }
    let mut files = Vec::new();
    if let Err(reason) = plain_files(dir, "", &mut files) {
        done.refusals
            .push(ctx.refuse(tool, group, None, DIR, &reason));
    }
    for (staged, inside) in files {
        match one_file(ctx, tool, group, &staged, &inside) {
            Ok(rel) => done.kept.push(rel),
            Err(text) => done.refusals.push(text),
        }
    }
}

/// A run-relative path an operation may name: no empty part, no `..`, not absolute, not inside `staging/`.
fn clean_rel(text: &str) -> Result<String, String> {
    let bad = text.is_empty()
        || text.starts_with('/')
        || text.contains('\\')
        || text
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || text == DIR
        || text.starts_with("staging/");
    if bad {
        Err(format!("{text:?} is not a run-relative path"))
    } else {
        Ok(text.to_string())
    }
}

/// The lines of the call folder's `ops.jsonl`, each with the hand-off writer its line names (a string `writer` key, written by the program inside a writer; none
/// otherwise); a line that cannot be read, or whose `writer` is not a string, is an `Err` (that operation is refused, the others still run).
fn read_ops(dir: &Path) -> Vec<Result<(group_guard::StagedOp, Option<String>), String>> {
    let Ok(text) = fs::read_to_string(dir.join(OPS_FILE)) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line)
                .map_err(|e| format!("an operation line cannot be read ({e})"))?;
            let field =
                |key: &str| clean_rel(value.get(key).and_then(|v| v.as_str()).unwrap_or(""));
            let writer = match value.get("writer") {
                None => None,
                Some(w) => match w.as_str() {
                    Some(name) if !name.is_empty() => Some(name.to_string()),
                    _ => {
                        return Err(
                            "an operation line names a writer that is not a non-empty string"
                                .to_string(),
                        )
                    }
                },
            };
            let op = match value.get("op").and_then(|v| v.as_str()) {
                Some("unlink") => group_guard::StagedOp::Unlink {
                    from: field("from")?,
                },
                Some("rename") => group_guard::StagedOp::Rename {
                    from: field("from")?,
                    to: field("to")?,
                },
                other => {
                    return Err(format!(
                        "an operation named {other:?} is not one of unlink, rename"
                    ))
                }
            };
            Ok((op, writer))
        })
        .collect()
}

/// One protocol operation. Judged on the path it ends up at: the path itself for a delete, the destination for a rename (the source is not judged and
/// a renamed folder's files are not judged one by one: what the tools do today, kept in step 7b). A refused operation is not executed.
fn one_op(
    ctx: &mut Ctx,
    dir: &Path,
    tool: &str,
    group: &str,
    writer: Option<&str>,
    op: &group_guard::StagedOp,
) -> Result<String, String> {
    use group_guard::StagedOp;
    let (judged, name, text) = match op {
        StagedOp::Unlink { from } => (from, "unlink", format!("unlink {from}")),
        StagedOp::Rename { from, to } => (to, "rename", format!("rename {from} -> {to}")),
    };
    ctx.judge(tool, group, writer, judged, name)?;
    group_guard::apply_staged_op(ctx.run_dir, dir, op).map_err(|error| {
        ctx.refuse(
            tool,
            group,
            writer,
            judged,
            &format!("{name} could not be done ({error})"),
        )
    })?;
    Ok(text)
}

/// One staged file: layout, judgement (with the time limit), then the move. `Ok(run-relative path)` or the text the model gets.
fn one_file(
    ctx: &mut Ctx,
    tool: &str,
    group: &str,
    staged: &Path,
    inside: &str,
) -> Result<String, String> {
    // <own | writer-NAME>/<mode>/<run-relative path>
    let mut parts = inside.splitn(3, '/');
    let (who, mode, rel) = (parts.next(), parts.next(), parts.next());
    let writer = match who {
        Some("own") => None,
        Some(w) if w.starts_with("writer-") && w.len() > 7 => Some(&w[7..]),
        _ => {
            return Err(ctx.refuse(
                tool,
                group,
                None,
                inside,
                "the file is not under own/ or writer-NAME/ in the call's folder",
            ))
        }
    };
    let (mode, op) = match mode {
        Some("write") => (Commit::Write, "write"),
        Some("append") => (Commit::Append, "append"),
        Some("once") => (Commit::Once, "write_if_absent"),
        _ => {
            return Err(ctx.refuse(
                tool,
                group,
                writer,
                inside,
                "the file is not under write/, append/ or once/",
            ))
        }
    };
    let Some(rel) = rel.filter(|r| !r.is_empty()) else {
        return Err(ctx.refuse(tool, group, writer, inside, "the file has no path"));
    };
    ctx.judge(tool, group, writer, rel, op)?;
    match group_guard::commit_staged(ctx.run_dir, staged, rel, mode) {
        Ok(()) => Ok(rel.to_string()),
        // an immutable file that already exists with other bytes: the tool reports it itself today (it throws), so the model gets that sentence and nothing is logged as a boundary refusal
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(error.to_string()),
        Err(error) => Err(ctx.refuse(
            tool,
            group,
            writer,
            rel,
            &format!("the file could not be moved into the run folder ({error})"),
        )),
    }
}

/// Group lookup from the host's tool list.
pub fn group_lookup(tools: &BTreeMap<String, String>) -> impl Fn(&str) -> Option<String> + '_ {
    move |tool| tools.get(tool).cloned()
}

/// The tools of a group, from the same list (the ones the model can call).
pub fn tools_in_group(tools: &BTreeMap<String, String>) -> impl Fn(&str) -> Vec<String> + '_ {
    move |group| {
        tools
            .iter()
            .filter(|(_, g)| g.as_str() == group)
            .map(|(name, _)| name.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn put(run: &Path, call: &str, inside: &str, bytes: &str) {
        let path = run.join(DIR).join(call).join(inside);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn groups() -> BTreeMap<String, String> {
        [
            ("record_claim", "knowledge"),
            ("newsroom_viz_plan", "visual"),
            ("newsroom_viz_chain", "visual"),
            ("artifact_inventory", "agent"),
        ]
        .into_iter()
        .map(|(t, g)| (t.to_string(), g.to_string()))
        .collect()
    }

    fn run_finish(run: &Path, call: &str, tool: &str, check: &Check) -> Finished {
        let g = groups();
        let tools = tools_in_group(&g);
        let found = finish(run, call, tool, &group_lookup(&g), &tools, check);
        found
    }

    fn refusal_lines(run: &Path) -> Vec<Value> {
        fs::read_to_string(run.join(group_guard::REFUSAL_LOG_PATH))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    impl Finished {
        fn is_kept(&self) -> bool {
            self.refusals.is_empty()
        }
        fn is_refused(&self) -> bool {
            !self.refusals.is_empty()
        }
        fn joined(&self) -> String {
            assert!(
                !self.refusals.is_empty(),
                "something must have been refused: {self:?}"
            );
            self.refusals.join("\n")
        }
    }

    fn open(run: &Path, call: &str) {
        begin(run, call).unwrap();
    }

    #[test]
    fn a_legal_write_moves_into_the_run_folder_and_the_staging_is_gone() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "own/write/data/a.csv", "x,y\n1,2\n");
        put(run, "c1", "own/write/claims.jsonl", "{}\n");
        // record_claim is a knowledge tool: data/ and claims.jsonl are knowledge kinds
        let result = run_finish(run, "c1", "record_claim", &Check::default());
        assert!(result.is_kept(), "{result:?} {:?}", refusal_lines(run));
        assert_eq!(result.kept.len(), 2);
        assert_eq!(
            fs::read_to_string(run.join("data/a.csv")).unwrap(),
            "x,y\n1,2\n"
        );
        assert!(!run.join("staging/c1").exists());
    }

    #[test]
    fn a_cross_group_write_is_refused_the_run_folder_is_unchanged_and_the_staging_cleared() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        // a visual tool may not write evidence (claims.jsonl) even next to a file it may write
        put(run, "c1", "own/write/claims.jsonl", "{\"forged\":true}\n");
        let result = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        let text = (result).joined();
        assert!(
            text.contains("newsroom_viz_plan（visual）may not write claims.jsonl")
                && text.contains("owner knowledge")
                && text.contains("the tools you can call there: record_claim")
                && !text.contains("Use knowledge_writer"),
            "{text}"
        );
        assert!(!run.join("claims.jsonl").exists());
        assert!(!run.join("staging/c1").exists());
        let log = refusal_lines(run);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["status"], "cross_group");
        assert_eq!(log[0]["tool"], "newsroom_viz_plan");
        assert_eq!(log[0]["side"], "rust");
        assert_eq!(log[0]["path"], "claims.jsonl");
    }

    #[test]
    fn a_refused_file_does_not_take_the_legal_files_of_the_same_call_with_it() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        // record_claim (knowledge) may write data/, not a visual spec
        put(run, "c1", "own/write/data/a.csv", "1\n");
        put(run, "c1", "own/write/visualizations/x.svg", "<svg/>");
        let result = run_finish(run, "c1", "record_claim", &Check::default());
        assert_eq!(result.kept, ["data/a.csv"]);
        assert_eq!(result.refusals.len(), 1);
        assert!(result.refusals[0].contains("may not write visualizations/x.svg"));
        assert!(run.join("data/a.csv").is_file() && !run.join("visualizations").exists());
        assert!(!run.join("staging/c1").exists());
        assert_eq!(refusal_lines(run).len(), 1);
    }

    #[test]
    fn undeclared_outputs_are_refused() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "own/write/some/unlisted/thing.bin", "?");
        let text = (run_finish(run, "c1", "record_claim", &Check::default())).joined();
        assert!(
            text.contains("unclassified") && text.contains("This call should not write this file."),
            "{text}"
        );
        assert_eq!(refusal_lines(run)[0]["status"], "待查");
        assert!(!run.join("some").exists());
    }

    #[test]
    fn a_tool_the_host_did_not_list_is_refused() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "own/write/data/a.csv", "1\n");
        assert!(run_finish(run, "c1", "no_such_tool", &Check::default()).is_refused());
        assert!(!run.join("data/a.csv").exists());
        assert_eq!(refusal_lines(run)[0]["status"], "待查");
    }

    #[test]
    fn two_parallel_calls_are_attributed_to_their_own_tool() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        open(run, "c2");
        // c1 (knowledge) and c2 (visual) are both open; each wrote the other's kind
        put(run, "c1", "own/write/claims.jsonl", "{}\n");
        put(run, "c2", "own/write/claims.jsonl", "{}\n");
        assert!((run_finish(run, "c1", "record_claim", &Check::default())).is_kept());
        assert!(
            run.join("staging/c2").exists(),
            "finishing c1 leaves c2's folder alone"
        );
        assert!((run_finish(run, "c2", "newsroom_viz_plan", &Check::default())).is_refused());
        let log = refusal_lines(run);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0]["tool"], "newsroom_viz_plan");
        assert_eq!(
            fs::read_to_string(run.join("claims.jsonl")).unwrap(),
            "{}\n"
        );
    }

    #[test]
    fn a_chained_calls_writes_belong_to_the_inner_call() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        // the chain (visual) started record_claim (knowledge): the inner call's claims.jsonl is the knowledge tool's own write
        put(run, "c1:record_claim", "own/write/claims.jsonl", "{}\n");
        let result = run_finish(run, "c1", "newsroom_viz_chain", &Check::default());
        assert!((result).is_kept(), "{result:?}");
        assert!(run.join("claims.jsonl").is_file());
        assert!(!run.join("staging/c1:record_claim").exists());
        // the same file written by the chain itself is refused
        let run2 = tempfile::tempdir().unwrap();
        let run2 = run2.path();
        open(run2, "c1");
        put(run2, "c1", "own/write/claims.jsonl", "{}\n");
        assert!((run_finish(run2, "c1", "newsroom_viz_chain", &Check::default())).is_refused());
        // and an inner call's cross-group write refuses that file only; the outer call's own legal file is kept
        let run3 = tempfile::tempdir().unwrap();
        let run3 = run3.path();
        open(run3, "c1");
        put(run3, "c1", "own/write/visualizations/ok.svg", "<svg/>");
        put(
            run3,
            "c1:newsroom_viz_plan",
            "own/write/claims.jsonl",
            "{}\n",
        );
        assert!((run_finish(run3, "c1", "newsroom_viz_chain", &Check::default())).is_refused());
        assert!(
            run3.join("visualizations/ok.svg").is_file() && !run3.join("claims.jsonl").exists()
        );
        assert_eq!(refusal_lines(run3)[0]["tool"], "newsroom_viz_plan");
    }

    #[test]
    fn a_judge_that_runs_past_the_limit_is_a_refusal() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "own/write/data/a.csv", "1\n");
        let slow = Check {
            limit: Duration::from_millis(5),
            report: None,
            delay: Duration::from_millis(40),
        };
        let text = (run_finish(run, "c1", "record_claim", &slow)).joined();
        assert!(text.contains("time limit"), "{text}");
        assert!(!run.join("data/a.csv").exists() && !run.join("staging/c1").exists());
        assert_eq!(refusal_lines(run)[0]["status"], "check_failed");
    }

    #[test]
    fn exempt_files_pass_and_temp_names_are_not_judged() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        // bookkeeping and a temp name: no tool owns them, and they are still let through (E1)
        put(run, "c1", "own/append/events.jsonl", "{}\n");
        put(run, "c1", "own/write/runtime/preview-tmp/p.svg", "<svg/>");
        put(run, "c1", "own/write/charts/x.svg.tmp", "partial");
        let result = run_finish(run, "c1", "artifact_inventory", &Check::default());
        assert!(result.is_kept() && result.kept.len() == 3, "{result:?}");
        assert!(run.join("events.jsonl").is_file());
        assert!(refusal_lines(run).is_empty());
    }

    /// The exempt-record switch only records: the same files with the same bytes are kept with it on or off, and only on writes the rows. The off phase does
    /// not depend on the environment: the test override beats the variable, and the variable is cleared so a developer's shell cannot leak in.
    #[test]
    fn exempt_writes_are_recorded_only_with_the_switch_on_and_are_kept_either_way() {
        fn kept_files(root: &Path) -> Vec<(String, Vec<u8>)> {
            fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
                for entry in fs::read_dir(dir).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        walk(root, &path, out);
                        continue;
                    }
                    let rel = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    if rel != group_guard::CALL_REPORT_PATH {
                        out.push((rel, fs::read(&path).unwrap()));
                    }
                }
            }
            let mut out = Vec::new();
            walk(root, root, &mut out);
            out.sort();
            out
        }
        let _command = crate::group_guard::command_for_test("investigate");
        std::env::remove_var("NEWSROOM_GROUP_EXEMPT_RECORD");
        let mut kept_by_phase: Vec<Vec<(String, Vec<u8>)>> = Vec::new();
        for on in [false, true] {
            let _switch = crate::group_guard::exempt_record_for_test(on);
            let dir = tempfile::tempdir().unwrap();
            let run = dir.path();
            open(run, "c1");
            put(run, "c1", "own/append/events.jsonl", "{}\n");
            put(run, "c1", "own/write/runtime/preview-tmp/p.svg", "<svg/>");
            put(run, "c1", "own/write/charts/x.svg.tmp", "partial");
            put(run, "c1", "own/write/charts/y.svg.write-tmp", "partial two");
            put(run, "c1", "own/write/session/s.jsonl", "{\"s\":1}\n");
            let result = run_finish(run, "c1", "artifact_inventory", &Check::default());
            assert!(
                result.is_kept() && result.kept.len() == 5,
                "on={on}: {result:?}"
            );
            assert!(refusal_lines(run).is_empty());
            let kept = kept_files(run);
            for (name, bytes) in [
                ("events.jsonl", "{}\n"),
                ("runtime/preview-tmp/p.svg", "<svg/>"),
                ("charts/x.svg.tmp", "partial"),
                ("charts/y.svg.write-tmp", "partial two"),
                ("session/s.jsonl", "{\"s\":1}\n"),
            ] {
                assert!(
                    kept.iter().any(|(n, b)| n == name && b == bytes.as_bytes()),
                    "on={on}: {name} kept with its bytes"
                );
            }
            kept_by_phase.push(kept);
            let report = run.join(group_guard::CALL_REPORT_PATH);
            if !on {
                assert!(!report.exists(), "off: no report file");
                continue;
            }
            let mut rows: Vec<(String, String)> = fs::read_to_string(&report)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .map(|r| {
                    (
                        r["path"].as_str().unwrap().to_string(),
                        r["exemption"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            rows.sort();
            assert_eq!(
                rows,
                [
                    ("charts/x.svg.tmp", "temp_suffix"),
                    ("charts/y.svg.write-tmp", "temp_suffix"),
                    ("events.jsonl", "bookkeeping_file"),
                    ("runtime/preview-tmp/p.svg", "preview_tmp"),
                    ("session/s.jsonl", "session_folder"),
                ]
                .map(|(a, b)| (a.to_string(), b.to_string())),
            );
        }
        assert_eq!(
            kept_by_phase[0], kept_by_phase[1],
            "the kept file names and bytes are the same with the switch on and off"
        );
    }

    #[test]
    fn append_adds_to_the_existing_file_and_once_keeps_identical_and_refuses_different() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        fs::write(run.join("claims.jsonl"), "one\n").unwrap();
        open(run, "c1");
        put(run, "c1", "own/append/claims.jsonl", "two\n");
        assert!((run_finish(run, "c1", "record_claim", &Check::default())).is_kept());
        assert_eq!(
            fs::read_to_string(run.join("claims.jsonl")).unwrap(),
            "one\ntwo\n"
        );
        fs::create_dir_all(run.join("data")).unwrap();
        fs::write(run.join("data/a.csv"), "same\n").unwrap();
        open(run, "c2");
        put(run, "c2", "own/once/data/a.csv", "same\n");
        assert!((run_finish(run, "c2", "record_claim", &Check::default())).is_kept());
        open(run, "c3");
        put(run, "c3", "own/once/data/a.csv", "different\n");
        put(run, "c3", "own/write/data/b.csv", "b\n");
        let text = (run_finish(run, "c3", "record_claim", &Check::default())).joined();
        assert!(text.contains("Immutable artifact collision"), "{text}");
        assert_eq!(
            text, "Immutable artifact collision: existing bytes differ at data/a.csv",
            "the model gets the sentence the tool itself reports"
        );
        assert!(
            run.join("data/b.csv").is_file(),
            "the call's other legal file is kept"
        );
        assert!(
            refusal_lines(run).is_empty(),
            "a collision is not a boundary refusal"
        );
        assert_eq!(
            fs::read_to_string(run.join("data/a.csv")).unwrap(),
            "same\n"
        );
    }

    #[test]
    fn a_hand_off_writer_is_judged_as_its_group_and_must_be_in_the_table() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        // newsroom_viz_plan (visual) as knowledge_writer may write claims.jsonl: the table lists it as a requester
        open(run, "c1");
        put(
            run,
            "c1",
            "writer-knowledge_writer/once/claims.jsonl",
            "{}\n",
        );
        let result = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert!((result).is_kept(), "{result:?} {:?}", refusal_lines(run));
        // a writer that is not in the table is refused
        open(run, "c2");
        put(
            run,
            "c2",
            "writer-made_up_writer/write/claims.jsonl",
            "{}\n",
        );
        assert!((run_finish(run, "c2", "newsroom_viz_plan", &Check::default())).is_refused());
        // a listed writer asked by a tool that is not a listed requester for that path is refused
        open(run, "c3");
        put(
            run,
            "c3",
            "writer-knowledge_writer/write/claims.jsonl",
            "{}\n",
        );
        let text = (run_finish(run, "c3", "newsroom_viz_chain", &Check::default())).joined();
        assert!(text.contains("may not ask knowledge_writer"), "{text}");
        let log = refusal_lines(run);
        assert!(
            log.iter()
                .all(|l| l["status"] == "handoff_not_listed" || l["status"] == "待查"),
            "{log:?}"
        );
        // a listed writer cannot write another group's path (agent_record_writer is the agent group's)
        open(run, "c4");
        put(
            run,
            "c4",
            "writer-agent_record_writer/write/claims.jsonl",
            "{}\n",
        );
        assert!((run_finish(run, "c4", "artifact_inventory", &Check::default())).is_refused());
    }

    #[test]
    fn names_outside_the_layout_links_and_the_staging_folder_itself_are_refused() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "stray.txt", "x");
        assert!((run_finish(run, "c1", "record_claim", &Check::default())).is_refused());
        open(run, "c2");
        put(run, "c2", "own/rename/data/a.csv", "x");
        assert!((run_finish(run, "c2", "record_claim", &Check::default())).is_refused());
        open(run, "c3");
        std::os::unix::fs::symlink("/etc/hosts", run.join("staging/c3/own")).unwrap();
        assert!((run_finish(run, "c3", "record_claim", &Check::default())).is_refused());
        open(run, "c4");
        put(
            run,
            "c4",
            "own/write/staging/c9/own/write/claims.jsonl",
            "{}\n",
        );
        assert!((run_finish(run, "c4", "newsroom_viz_plan", &Check::default())).is_refused());
        assert!(!run.join("staging/c9").exists());
        assert!(begin(run, "../x").is_err() && begin(run, "a/b").is_err());
    }

    #[test]
    fn a_tool_call_can_never_write_the_verification_result() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        for (call, tool, inside) in [
            ("c1", "record_claim", "own/write/verification.json"),
            ("c2", "newsroom_viz_plan", "own/once/verification.json"),
            (
                "c3",
                "newsroom_viz_plan",
                "writer-knowledge_writer/write/verification.json",
            ),
        ] {
            open(run, call);
            put(run, call, inside, "{\"passed\":true}");
            let text = (run_finish(run, call, tool, &Check::default())).joined();
            assert!(text.contains("verification.json"), "{text}");
        }
        assert!(!run.join("verification.json").exists());
    }

    #[test]
    fn only_a_call_folder_directly_under_staging_can_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        fs::create_dir_all(run.join("data")).unwrap();
        assert!(group_guard::clear_staging_dir(run, &run.join("data")).is_err());
        assert!(group_guard::clear_staging_dir(run, &run.join("staging")).is_err());
        assert!(group_guard::clear_staging_dir(run, &run.join("staging/a/b")).is_err());
        assert!(run.join("data").is_dir());
    }

    #[test]
    fn the_staging_folder_has_a_rule_and_belongs_to_the_agent_group() {
        assert_eq!(
            group_guard::classify("staging/c1/"),
            Some(("project_state".into(), "agent".into()))
        );
        assert_eq!(
            group_guard::classify("staging/c1:record_claim/own/write/x"),
            Some(("project_state".into(), "agent".into()))
        );
    }

    fn ops(run: &Path, call: &str, lines: &[&str]) {
        put(run, call, OPS_FILE, &(lines.join("\n") + "\n"));
    }

    fn real(run: &Path, rel: &str, bytes: &str) {
        let path = run.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_staged_delete_runs_when_the_path_passes_and_a_refused_one_does_not_run() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "visualizations/old.json", "{}");
        real(run, "claims.jsonl", "{}\n");
        open(run, "c1");
        ops(
            run,
            "c1",
            &[r#"{"op":"unlink","from":"visualizations/old.json"}"#],
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert_eq!(done.ops, ["unlink visualizations/old.json"]);
        assert!(!run.join("visualizations/old.json").exists());
        // a visual tool may not delete evidence: judged on the path, refused, not run
        open(run, "c2");
        ops(run, "c2", &[r#"{"op":"unlink","from":"claims.jsonl"}"#]);
        let done = run_finish(run, "c2", "newsroom_viz_plan", &Check::default());
        assert!(
            done.joined().contains("may not write claims.jsonl"),
            "{done:?}"
        );
        assert!(done.ops.is_empty() && run.join("claims.jsonl").exists());
        let log = refusal_lines(run);
        assert_eq!(
            (log[0]["op"].as_str(), log[0]["status"].as_str()),
            (Some("unlink"), Some("cross_group"))
        );
    }

    #[test]
    fn a_staged_rename_moves_a_folder_before_the_files_written_into_its_new_place() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "publications/k1/index.html", "<p/>");
        real(run, "publications/k1/manifest.json", "{}");
        open(run, "c1");
        ops(
            run,
            "c1",
            &[r#"{"op":"rename","from":"publications/k1","to":"publications/rejected/k1"}"#],
        );
        put(
            run,
            "c1",
            "own/once/publications/rejected/k1/rejection.json",
            "{\"reason\":\"x\"}",
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert_eq!(
            done.ops,
            ["rename publications/k1 -> publications/rejected/k1"]
        );
        assert!(!run.join("publications/k1").exists());
        assert!(run.join("publications/rejected/k1/index.html").exists());
        assert!(run.join("publications/rejected/k1/rejection.json").exists());
    }

    // The same literal lines scripts/test_staging_root.mjs asserts stageOp writes (one format for both languages).
    const RENAME_WRITER: &str = r#"{"op":"rename","from":"publications/k1","to":"publications/rejected/k1","writer":"review_reject_writer"}"#;
    const RENAME_PLAIN: &str =
        r#"{"op":"rename","from":"publications/k1","to":"publications/rejected/k1"}"#;
    const UNLINK_WRITER: &str =
        r#"{"op":"unlink","from":"visualizations/a.json","writer":"review_reject_writer"}"#;

    fn staged_publication(run: &Path) {
        real(run, "publications/k1/index.html", "<p/>");
        real(run, "publications/k1/manifest.json", "{}");
    }

    /// K575 3.5 a: with the review split on, the publication move named as the reject writer's passes and runs.
    #[test]
    fn a_staged_rename_named_for_the_reject_writer_passes_with_the_review_split_on() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        open(run, "c1");
        ops(run, "c1", &[RENAME_WRITER]);
        let done = run_finish(run, "c1", "newsroom_publication_qa", &Check::default());
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert!(!run.join("publications/k1").exists());
        assert!(run.join("publications/rejected/k1/index.html").exists());
    }

    /// K575 3.5 b: the same line without a writer is the review tool itself: refused, not run.
    #[test]
    fn the_same_rename_without_a_writer_is_refused_with_the_review_split_on() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        open(run, "c1");
        ops(run, "c1", &[RENAME_PLAIN]);
        let done = run_finish(run, "c1", "newsroom_publication_qa", &Check::default());
        assert!(!done.is_kept() && done.ops.is_empty(), "{done:?}");
        assert!(run.join("publications/k1/index.html").exists());
        assert_eq!(
            refusal_lines(run).last().unwrap()["status"],
            "draw_path_by_review_tool"
        );
    }

    /// K575 3.5 c: another review tool is not a requester of the publications/ row.
    #[test]
    fn a_writer_line_from_a_tool_the_row_does_not_list_is_refused() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        open(run, "c1");
        ops(run, "c1", &[RENAME_WRITER]);
        let done = run_finish(run, "c1", "newsroom_viz_critic", &Check::default());
        assert!(!done.is_kept() && done.ops.is_empty(), "{done:?}");
        assert!(run.join("publications/k1/index.html").exists());
    }

    /// K575 3.5 d: a writer name that is not in the table is refused (an unlisted writer has no group).
    #[test]
    fn a_writer_line_naming_an_unknown_writer_is_refused() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        open(run, "c1");
        ops(
            run,
            "c1",
            &[&RENAME_WRITER.replace("review_reject_writer", "made_up_writer")],
        );
        let done = run_finish(run, "c1", "newsroom_publication_qa", &Check::default());
        assert!(!done.is_kept() && done.ops.is_empty(), "{done:?}");
        assert!(run.join("publications/k1/index.html").exists());
    }

    /// K575 3.5 e: the critics' manifest unlink as the reject writer passes (and runs) for a critic; without the writer it is refused.
    #[test]
    fn a_critics_manifest_unlink_named_for_the_reject_writer_passes() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "visualizations/a.json", "{}");
        open(run, "c1");
        ops(run, "c1", &[UNLINK_WRITER]);
        let done = run_finish(run, "c1", "newsroom_viz_critic", &Check::default());
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert!(!run.join("visualizations/a.json").exists());
        real(run, "visualizations/a.json", "{}");
        open(run, "c2");
        ops(
            run,
            "c2",
            &[r#"{"op":"unlink","from":"visualizations/a.json"}"#],
        );
        let done = run_finish(run, "c2", "newsroom_viz_critic", &Check::default());
        assert!(!done.is_kept(), "{done:?}");
        assert!(run.join("visualizations/a.json").exists());
    }

    /// K575 3.5 f: with the split off a line without a writer is judged exactly as before; the QA tool is in its groups.json group (visual) here, as on the host.
    #[test]
    fn with_the_review_split_off_a_plain_rename_is_unchanged() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(false);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        open(run, "c1");
        ops(run, "c1", &[RENAME_PLAIN]);
        let mut g = groups();
        g.insert("newsroom_publication_qa".into(), "visual".into());
        let tools = tools_in_group(&g);
        let done = finish(
            run,
            "c1",
            "newsroom_publication_qa",
            &group_lookup(&g),
            &tools,
            &Check::default(),
        );
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert!(run.join("publications/rejected/k1/index.html").exists());
        assert!(!run.join("publications/k1/index.html").exists());
    }

    /// The full critic rejection on the agent path with the split on: the three copies as once/ files under writer-review_reject_writer/ for
    /// visualizations/rejected/k/, and the manifest unlink named for the writer. Everything is kept and the source is gone (pins the Rust `owned` check).
    #[test]
    fn a_critic_rejection_as_the_reject_writer_is_kept_with_the_review_split_on() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(true);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "visualizations/k.json", "{}");
        open(run, "c1");
        for name in ["manifest", "critic", "rejection"] {
            put(
                run,
                "c1",
                &format!("writer-review_reject_writer/once/visualizations/rejected/k/{name}.json"),
                "{}",
            );
        }
        ops(
            run,
            "c1",
            &[r#"{"op":"unlink","from":"visualizations/k.json","writer":"review_reject_writer"}"#],
        );
        let done = run_finish(run, "c1", "newsroom_viz_critic", &Check::default());
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert_eq!(done.ops, ["unlink visualizations/k.json"]);
        assert!(!run.join("visualizations/k.json").exists());
        for name in ["manifest", "critic", "rejection"] {
            assert!(
                run.join(format!("visualizations/rejected/k/{name}.json"))
                    .exists(),
                "{name}"
            );
        }
    }

    /// The row check does not depend on the split: with it off a writer line from the listed requester is kept, from another review tool refused.
    #[test]
    fn with_the_review_split_off_a_writer_line_is_still_judged_by_the_row() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(false);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        open(run, "c1");
        ops(run, "c1", &[RENAME_WRITER]);
        let done = run_finish(run, "c1", "newsroom_viz_critic", &Check::default());
        assert!(!done.is_kept() && done.ops.is_empty(), "{done:?}");
        assert!(run.join("publications/k1/index.html").exists());
        open(run, "c2");
        ops(run, "c2", &[RENAME_WRITER]);
        let done = run_finish(run, "c2", "newsroom_publication_qa", &Check::default());
        assert!(done.is_kept(), "{done:?} {:?}", refusal_lines(run));
        assert!(run.join("publications/rejected/k1/index.html").exists());
    }

    /// A `writer` key that is not a non-empty string refuses that op; it is never read as no writer.
    #[test]
    fn a_writer_key_that_is_not_a_string_refuses_the_operation() {
        let _command = crate::group_guard::command_for_test("investigate");
        let _split = crate::group_guard::review_split_for_test(false);
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        staged_publication(run);
        for (call, bad) in [
            ("c1", "7"),
            ("c2", "null"),
            ("c3", "[\"x\"]"),
            ("c4", "\"\""),
        ] {
            open(run, call);
            ops(
                run,
                call,
                &[&format!(
                    r#"{{"op":"rename","from":"publications/k1","to":"publications/rejected/k1","writer":{bad}}}"#
                )],
            );
            let done = run_finish(run, call, "newsroom_publication_qa", &Check::default());
            assert!(
                !done.is_kept() && done.joined().contains("writer"),
                "{bad}: {done:?}"
            );
            assert!(run.join("publications/k1/index.html").exists());
        }
    }

    #[test]
    fn a_rename_is_judged_on_its_destination_only_and_a_refused_one_is_not_run() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "claims.jsonl", "{}\n");
        real(run, "visualizations/a.json", "{}");
        open(run, "c1");
        // the source is not judged (a visual tool moving a knowledge file is let through today and stays a known gap), the destination is
        ops(
            run,
            "c1",
            &[r#"{"op":"rename","from":"claims.jsonl","to":"visualizations/c.json"}"#],
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert!(done.is_kept() && run.join("visualizations/c.json").exists());
        open(run, "c2");
        ops(
            run,
            "c2",
            &[r#"{"op":"rename","from":"visualizations/a.json","to":"claims.jsonl"}"#],
        );
        let done = run_finish(run, "c2", "newsroom_viz_plan", &Check::default());
        assert!(
            done.joined().contains("may not write claims.jsonl"),
            "{done:?}"
        );
        assert!(run.join("visualizations/a.json").exists());
        let log = refusal_lines(run);
        assert_eq!(log.last().unwrap()["op"], "rename");
    }

    #[test]
    fn a_file_written_and_renamed_in_the_same_call_is_renamed_and_a_missing_delete_source_is_not_an_error(
    ) {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "own/write/visualizations/q.json", "{}");
        ops(
            run,
            "c1",
            &[
                r#"{"op":"rename","from":"visualizations/q.json","to":"visualizations/q2.json"}"#,
                r#"{"op":"unlink","from":"visualizations/never.json"}"#,
            ],
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert!(done.is_kept(), "{done:?}");
        assert!(
            run.join("visualizations/q2.json").exists()
                && !run.join("visualizations/q.json").exists()
        );
    }

    #[test]
    fn a_rename_whose_source_is_nowhere_is_an_error_like_rename_2_but_a_delete_of_nothing_is_not() {
        let _split = crate::group_guard::review_split_for_test(false);
        let _command = crate::group_guard::command_for_test("investigate");
        // 1011aj gap 7: browser-qa.json -> startup-failure.json errors today when the source is missing; the staged path must too
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        ops(
            run,
            "c1",
            &[
                r#"{"op":"rename","from":"publications/qa/k/browser-qa.json","to":"publications/qa/k/startup-failure.json"}"#,
                r#"{"op":"unlink","from":"publications/qa/k/none.json"}"#,
            ],
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert_eq!(done.refusals.len(), 1, "{done:?}");
        assert!(
            done.refusals[0].contains("rename could not be done")
                && done.refusals[0].contains("no such file or directory"),
            "{done:?}"
        );
        assert_eq!(done.ops, ["unlink publications/qa/k/none.json"]);
        assert!(!run.join("publications/qa/k/startup-failure.json").exists());
        // with the source there, the same rename is done
        real(run, "publications/qa/k/browser-qa.json", "{}");
        open(run, "c2");
        ops(
            run,
            "c2",
            &[
                r#"{"op":"rename","from":"publications/qa/k/browser-qa.json","to":"publications/qa/k/startup-failure.json"}"#,
            ],
        );
        let done = run_finish(run, "c2", "newsroom_viz_plan", &Check::default());
        assert!(done.is_kept(), "{done:?}");
        assert!(run.join("publications/qa/k/startup-failure.json").exists());
    }

    #[test]
    fn a_file_appended_to_and_overwritten_in_one_call_is_saved_as_the_rewrite_alone_known_gap_6() {
        let _command = crate::group_guard::command_for_test("investigate");
        // pinned, not fixed (1011aj gap 6): appends are moved in before rewrites, so the rewrite wins; Node's read through the staging shows
        // rewrite + appended part (scripts/test_staging_root.mjs), which is not what a direct append-then-overwrite would read ("B" there too)
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "claims.jsonl", "base\n");
        open(run, "c1");
        put(run, "c1", "own/append/claims.jsonl", "A\n");
        put(run, "c1", "own/write/claims.jsonl", "B\n");
        let done = run_finish(run, "c1", "record_claim", &Check::default());
        assert!(done.is_kept(), "{done:?}");
        assert_eq!(fs::read_to_string(run.join("claims.jsonl")).unwrap(), "B\n");
    }

    #[test]
    fn a_bad_operation_line_is_refused_alone() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "visualizations/a.json", "{}");
        open(run, "c1");
        ops(
            run,
            "c1",
            &[
                r#"{"op":"rename","from":"../x","to":"visualizations/y.json"}"#,
                r#"{"op":"chmod","from":"visualizations/a.json"}"#,
                r#"{"op":"unlink","from":"visualizations/a.json"}"#,
            ],
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &Check::default());
        assert_eq!(done.refusals.len(), 2, "{done:?}");
        assert_eq!(done.ops, ["unlink visualizations/a.json"]);
    }

    #[test]
    fn passed_items_are_counted_once_in_the_report_next_to_what_node_already_wrote() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        real(run, "visualizations/old.json", "{}");
        // a report Node wrote earlier: one record for another tool
        real(run, group_guard::REPORT_PATH, &serde_json::json!({
            "schema_version": "0.1.0", "mode": "report", "complete": false,
            "totals": {"writes": 2, "ok": 2, "cross_group": 0, "to_check": 0},
            "records": [{"tool": "record_claim", "tool_group": "knowledge", "op": "write", "kind": "evidence", "owner": "knowledge", "status": "ok", "count": 2, "examples": ["claims.jsonl"]}],
            "not_traced": ["x"],
        }).to_string());
        let check = Check {
            report: Some(false),
            ..Check::default()
        };
        for call in ["c1", "c2"] {
            open(run, call);
            put(run, call, "own/write/visualizations/a.svg", "<svg/>");
            ops(
                run,
                call,
                &[r#"{"op":"unlink","from":"visualizations/old.json"}"#],
            );
            let done = run_finish(run, call, "newsroom_viz_plan", &check);
            assert!(done.is_kept(), "{done:?}");
        }
        let report: Value =
            serde_json::from_str(&fs::read_to_string(run.join(group_guard::REPORT_PATH)).unwrap())
                .unwrap();
        // 2 from Node + (1 write + 1 unlink) twice from Rust, the same record updated, not a second one
        assert_eq!(report["totals"]["writes"], 6, "{report}");
        assert_eq!(report["totals"]["ok"], 6);
        assert_eq!(report["records"].as_array().unwrap().len(), 3);
        // the header is Rust's own, from groups.json (boundary_report), whatever an older file said
        assert!(report["not_traced"][0]
            .as_str()
            .unwrap()
            .starts_with("Rust-side writes"));
        let write = report["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["tool"] == "newsroom_viz_plan" && r["op"] == "write")
            .unwrap();
        assert_eq!(write["count"], 2);
        assert_eq!(
            write["examples"],
            serde_json::json!(["visualizations/a.svg"])
        );
        assert!(report["summary"]
            .as_str()
            .unwrap()
            .starts_with("6 writes seen: 6 in the owning group"));
        // a refused item is not counted
        open(run, "c3");
        put(run, "c3", "own/write/claims.jsonl", "{}");
        run_finish(run, "c3", "newsroom_viz_plan", &check);
        let after: Value =
            serde_json::from_str(&fs::read_to_string(run.join(group_guard::REPORT_PATH)).unwrap())
                .unwrap();
        assert_eq!(after["totals"]["writes"], 6);
    }

    #[test]
    fn rust_writes_the_whole_report_and_counts_the_lines_node_left_in_the_call_folder() {
        let _command = crate::group_guard::command_for_test("investigate");
        // 1011aj step 8: with the host counting, Node never writes the report; it leaves report.jsonl in the call folder
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        let check = Check {
            report: Some(false),
            ..Check::default()
        };
        let node = |path: &str, status: &str, kind: &str| {
            serde_json::json!({"tool": "newsroom_viz_plan", "tool_group": "visual", "op": "write", "kind": kind, "owner": "visual",
                "status": status, "path": path}).to_string()
        };
        open(run, "c1");
        put(run, "c1", "own/write/visualizations/a.svg", "<svg/>");
        put(
            run,
            "c1",
            REPORT_FILE,
            &[
                node("data/x.csv", "ok", "visual_spec"),
                node("data/y.csv", "ok", "visual_spec"),
                node("zzz/unknown", "待查", "none"),
                "not json".to_string(),
            ]
            .join("\n"),
        );
        let done = run_finish(run, "c1", "newsroom_viz_plan", &check);
        assert!(done.is_kept(), "{done:?}");
        assert!(!run.join(REPORT_FILE).exists() && !run.join("report.jsonl").exists());
        let report: Value =
            serde_json::from_str(&fs::read_to_string(run.join(group_guard::REPORT_PATH)).unwrap())
                .unwrap();
        for key in ["note", "not_traced", "ownership", "schema_version", "mode"] {
            assert!(!report[key].is_null(), "{key} missing: {report}");
        }
        assert_eq!(report["ownership"]["evidence"]["owner"], "knowledge");
        // 1 file Rust moved in + 3 lines from Node (the unreadable line is left out)
        assert_eq!(report["totals"]["writes"], 4, "{report}");
        let node_ok = report["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| {
                r["tool"] == "newsroom_viz_plan" && r["kind"] == "visual_spec" && r["count"] == 3
            })
            .expect("two ok lines and Rust's own file share one record");
        assert_eq!(
            node_ok["examples"],
            serde_json::json!(["visualizations/a.svg", "data/x.csv", "data/y.csv"])
        );
        assert_eq!(report["totals"]["to_check"], 1);
    }

    #[test]
    fn calls_finishing_at_the_same_time_lose_no_count_in_the_report() {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path().to_path_buf();
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let run = run.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        let item = group_guard::Passed {
                            tool: "newsroom_viz_plan".into(),
                            group: "visual".into(),
                            writer: None,
                            op: "write",
                            rel: format!("visualizations/{n}-{i}.svg"),
                        };
                        let line = serde_json::json!({"tool": "record_claim", "tool_group": "knowledge", "op": "append",
                            "kind": "evidence", "owner": "knowledge", "status": "ok", "path": "claims.jsonl"});
                        group_guard::count_passed(&run, &[item], &[line], false).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let report: Value =
            serde_json::from_str(&fs::read_to_string(run.join(group_guard::REPORT_PATH)).unwrap())
                .unwrap();
        assert_eq!(report["totals"]["writes"], 400, "{report}");
        assert_eq!(report["totals"]["ok"], 400);
    }

    #[test]
    fn without_the_report_switch_nothing_is_written_to_the_report() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        open(run, "c1");
        put(run, "c1", "own/write/visualizations/a.svg", "<svg/>");
        assert!(run_finish(run, "c1", "newsroom_viz_plan", &Check::default()).is_kept());
        assert!(!run.join(group_guard::REPORT_PATH).exists());
    }

    #[test]
    fn the_refusal_names_the_owning_group_and_up_to_three_sorted_tools_never_a_writer() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path();
        let g = groups();
        let many = |group: &str| -> Vec<String> {
            if group == "knowledge" {
                ["zeta", "beta", "delta", "alpha"]
                    .map(String::from)
                    .to_vec()
            } else {
                Vec::new()
            }
        };
        open(run, "c1");
        put(run, "c1", "own/write/claims.jsonl", "{}");
        let text = finish(
            run,
            "c1",
            "newsroom_viz_plan",
            &group_lookup(&g),
            &many,
            &Check::default(),
        )
        .joined();
        assert!(
            text.contains(
                "belongs to the knowledge group; the tools you can call there: alpha, beta, delta."
            ),
            "{text}"
        );
        assert!(!text.contains("Use ") && !text.contains("writer"), "{text}");
        // an owner with no callable tool, and a path nobody owns: the call should not write it at all
        open(run, "c2");
        put(run, "c2", "own/write/visualizations/a.svg", "<svg/>");
        let text = finish(
            run,
            "c2",
            "record_claim",
            &group_lookup(&g),
            &many,
            &Check::default(),
        )
        .joined();
        assert!(
            text.contains("This call should not write this file.")
                && !text.contains("tools you can call"),
            "{text}"
        );
        open(run, "c3");
        put(run, "c3", "own/write/no-such-kind-xyz.bin", "1");
        let text = run_finish(run, "c3", "record_claim", &Check::default()).joined();
        assert!(
            text.contains("This call should not write this file."),
            "{text}"
        );
    }
}
