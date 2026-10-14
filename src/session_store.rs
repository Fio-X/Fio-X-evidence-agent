//! The Rust agent's own session file (1011af step 5, agent-spec 7.1 and 7.2): one linear JSONL file per run folder, appended one record at
//! a time. It lives in `agent-session/`, never in the old `session/` folder, and nothing here reads an old-format session: a run folder
//! that only has one is refused for follow-up questions. No key, header or request body is ever written: a record is a message.
//!
//! Layout of `agent-session/session.jsonl`:
//! - line 1, the header: `{"type":"session-header","format":"newsroom-agent-linear","version":1,"id","createdAt","cwd"}`;
//! - every later line: `{"type":"message","message":{role, content, usage?, stopReason?, timestamp, ...}}`.
//!
//! Each record is flushed to disk when it is written. A crash can leave one half line at the end; loading ignores it and the next open
//! cuts it off, so what was written whole before the crash is always read back.

use crate::group_guard;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const DIR: &str = "agent-session";
pub const FILE: &str = "session.jsonl";
/// The folder the old runtime wrote its sessions to. Only looked at to refuse a follow-up question.
const OLD_DIR: &str = "session";
/// How many `session.jsonl.torn-<n>` copies a run folder may hold; each name is a fixed row in groups.json.
pub const MAX_TORN_COPIES: usize = 5;
pub const FORMAT: &str = "newsroom-agent-linear";
pub const VERSION: u64 = 1;

#[derive(Debug, PartialEq)]
pub enum SessionError {
    /// The run folder holds a session from the old runtime: it can be viewed and checked, not continued.
    OldFormat,
    /// A file in `agent-session/` that is not this format, or a damaged line before the end.
    Unreadable(String),
    Io(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OldFormat => write!(f, "This run folder holds a session in the old format: it can be viewed and checked, but a follow-up question cannot continue it."),
            Self::Unreadable(why) => write!(f, "The session file cannot be read: {why}"),
            Self::Io(why) => write!(f, "The session file cannot be written: {why}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<io::Error> for SessionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

pub struct SessionWriter {
    file: fs::File,
    path: PathBuf,
    id: String,
}

/// What a resumed session gives back: the writer to go on with and the history so far.
pub struct Resumed {
    pub writer: SessionWriter,
    pub history: Vec<Value>,
}

fn file_in(run_dir: &Path) -> PathBuf {
    run_dir.join(DIR).join(FILE)
}

/// Text of the error result put after a tool call the crash left without an answer.
pub const INTERRUPTED: &str =
    "The session was interrupted before this tool call finished; it was not run.";

impl SessionWriter {
    /// Test hook: from now on every write fails (the handle is read-only).
    #[cfg(test)]
    pub fn poison(&mut self) {
        self.file = fs::File::open(&self.path).unwrap();
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// A new session in the run folder; refuses to overwrite one that already exists.
    pub fn create(run_dir: &Path, cwd: &str) -> Result<Self, SessionError> {
        let path = file_in(run_dir);
        group_guard::create_dir_all(run_dir, &run_dir.join(DIR))?;
        let file = group_guard::create_new(run_dir, &path)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut writer = Self { file, path, id };
        let header = json!({"type": "session-header", "format": FORMAT, "version": VERSION, "id": writer.id,
                            "createdAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "cwd": cwd});
        writer.write_line(&header)?;
        Ok(writer)
    }

    /// Appends one message as a record and flushes it to disk.
    pub fn append(&mut self, message: &Value) -> Result<(), SessionError> {
        self.write_line(&json!({"type": "message", "message": message}))
    }

    fn write_line(&mut self, record: &Value) -> Result<(), SessionError> {
        let mut line = serde_json::to_vec(record).map_err(|e| SessionError::Io(e.to_string()))?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.file.sync_data()?;
        Ok(())
    }

    /// True when the run folder has a session of this format: the only kind the Rust agent can continue. Anything else (a session of the
    /// old runtime, an empty or cleared `session/`, no session at all) is a result it cannot take a follow-up question on.
    pub fn has_session(run_dir: &Path) -> bool {
        file_in(run_dir).exists()
    }

    /// True when the run folder holds a session from the old runtime and none of this format.
    pub fn only_old_session(run_dir: &Path) -> bool {
        !file_in(run_dir).exists()
            && fs::read_dir(run_dir.join(OLD_DIR))
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
    }

    /// The run folder's session for a follow-up question: its history is loaded and new records go on after it. A run folder with no
    /// session of this format starts a new one, unless it holds an old-format session, which is refused.
    pub fn resume(run_dir: &Path) -> Result<Option<Resumed>, SessionError> {
        let path = file_in(run_dir);
        if !path.exists() {
            return if Self::only_old_session(run_dir) {
                Err(SessionError::OldFormat)
            } else {
                Ok(None)
            };
        }
        let bytes = fs::read(&path)?;
        let whole = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |at| at + 1);
        let text = std::str::from_utf8(&bytes[..whole])
            .map_err(|_| SessionError::Unreadable("not valid UTF-8".into()))?;
        let mut lines = text.lines();
        let header: Value = lines
            .next()
            .and_then(|l| serde_json::from_str(l).ok())
            .ok_or_else(|| SessionError::Unreadable("no header line".into()))?;
        if header["type"] != "session-header"
            || header["format"] != FORMAT
            || header["version"] != VERSION
        {
            return Err(SessionError::Unreadable(
                "the header is not of this format and version".into(),
            ));
        }
        let mut history = Vec::new();
        for (number, line) in lines.enumerate() {
            let record: Value = serde_json::from_str(line)
                .map_err(|_| SessionError::Unreadable(format!("line {} is damaged", number + 2)))?;
            if record["type"] == "message" {
                history.push(record["message"].clone());
            }
        }
        if whole < bytes.len() {
            // The crash left half a line. Keep the file as it was in a numbered copy beside it (never overwriting one), then rewrite
            // the original without the half line so the next record does not run into it. If the rewrite is cut short, the copy has it all.
            let copy = (1..=MAX_TORN_COPIES)
                .map(|n| path.with_file_name(format!("{FILE}.torn-{n}")))
                .find(|candidate| !candidate.exists())
                .ok_or_else(|| {
                    SessionError::Unreadable(format!(
                        "{MAX_TORN_COPIES} torn copies already exist beside the session"
                    ))
                })?;
            group_guard::copy(run_dir, &path, &copy)?;
            group_guard::write(run_dir, &path, &bytes[..whole])?;
        }
        let file = group_guard::open_append(run_dir, &path)?;
        let id = header["id"].as_str().unwrap_or("").to_string();
        let mut writer = Self { file, path, id };
        for result in interrupted_results(&history) {
            writer.append(&result)?;
            history.push(result);
        }
        Ok(Some(Resumed { writer, history }))
    }
}

/// Error results for the tool calls of the last assistant message that have no result (the crash came between the call and its answer).
fn interrupted_results(history: &[Value]) -> Vec<Value> {
    let Some(last) = history.iter().rposition(|m| m["role"] == "assistant") else {
        return vec![];
    };
    if matches!(
        history[last]["stopReason"].as_str(),
        Some("error" | "aborted")
    ) {
        return vec![];
    }
    let answered: Vec<&str> = history[last + 1..]
        .iter()
        .filter(|m| m["role"] == "toolResult")
        .filter_map(|m| m["toolCallId"].as_str())
        .collect();
    history[last]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "toolCall")
        .filter(|b| !b["id"].as_str().is_some_and(|id| answered.contains(&id)))
        .map(|b| {
            json!({"role": "toolResult", "toolCallId": b["id"], "toolName": b["name"],
                        "content": [{"type": "text", "text": INTERRUPTED}], "isError": true,
                        "timestamp": chrono::Utc::now().timestamp_millis()})
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, text: &str) -> Value {
        json!({"role": role, "content": [{"type": "text", "text": text}]})
    }

    fn lines(run: &Path) -> Vec<String> {
        fs::read_to_string(file_in(run))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn what_is_written_reads_back_in_order_with_a_header() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let mut writer = SessionWriter::create(run.path(), "/work").unwrap();
        let first = msg("user", "one");
        let second = json!({"role": "assistant", "content": [{"type": "text", "text": "two"}], "stopReason": "stop", "usage": {"input": 4}});
        writer.append(&first).unwrap();
        writer.append(&second).unwrap();
        let id = writer.id().to_string();
        drop(writer);
        let header: Value = serde_json::from_str(&lines(run.path())[0]).unwrap();
        assert_eq!(header["format"], FORMAT);
        assert_eq!(header["version"], VERSION);
        assert_eq!(header["id"], id.as_str());
        assert_eq!(header["cwd"], "/work");
        let resumed = SessionWriter::resume(run.path()).unwrap().unwrap();
        assert_eq!(resumed.history, vec![first, second]);
        assert_eq!(resumed.writer.id(), id);
    }

    #[test]
    fn the_file_is_new_and_never_overwritten_and_the_old_folder_is_not_touched() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        SessionWriter::create(run.path(), "/w").unwrap();
        assert!(SessionWriter::create(run.path(), "/w").is_err());
        assert!(!run.path().join("session").exists());
        assert!(run.path().join(DIR).join(FILE).exists());
    }

    #[test]
    fn a_torn_last_line_is_ignored_and_cut_so_the_next_record_starts_clean() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let mut writer = SessionWriter::create(run.path(), "/w").unwrap();
        writer.append(&msg("user", "kept")).unwrap();
        writer
            .append(&msg("assistant", "this record is cut"))
            .unwrap();
        drop(writer);
        let path = file_in(run.path());
        let bytes = fs::read(&path).unwrap();
        let cut = bytes.len() - 20;
        fs::write(&path, &bytes[..cut]).unwrap();
        let mut resumed = SessionWriter::resume(run.path()).unwrap().unwrap();
        assert_eq!(resumed.history, vec![msg("user", "kept")]);
        resumed.writer.append(&msg("user", "after")).unwrap();
        drop(resumed);
        let again = SessionWriter::resume(run.path()).unwrap().unwrap();
        assert_eq!(
            again.history,
            vec![msg("user", "kept"), msg("user", "after")]
        );
        assert!(fs::read_to_string(&path)
            .unwrap()
            .lines()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()));
    }

    #[test]
    fn a_damaged_complete_line_or_a_foreign_header_is_an_error_not_a_silent_start() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let mut writer = SessionWriter::create(run.path(), "/w").unwrap();
        writer.append(&msg("user", "x")).unwrap();
        drop(writer);
        let path = file_in(run.path());
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{not json}\n");
        fs::write(&path, &text).unwrap();
        assert!(matches!(
            SessionWriter::resume(run.path()),
            Err(SessionError::Unreadable(_))
        ));
        fs::write(
            &path,
            "{\"type\":\"session-header\",\"format\":\"other\",\"version\":1}\n",
        )
        .unwrap();
        assert!(matches!(
            SessionWriter::resume(run.path()),
            Err(SessionError::Unreadable(_))
        ));
    }

    #[test]
    fn an_old_format_session_folder_is_refused_and_left_as_it_was() {
        let run = tempfile::tempdir().unwrap();
        let old = run.path().join("session");
        fs::create_dir_all(&old).unwrap();
        fs::write(
            old.join("a.jsonl"),
            "{\"type\":\"session\",\"version\":3}\n",
        )
        .unwrap();
        let error = SessionWriter::resume(run.path()).err().unwrap();
        assert!(matches!(error, SessionError::OldFormat));
        assert!(error.to_string().contains("old format"));
        assert!(!run.path().join(DIR).exists(), "no new session was started");
        assert_eq!(fs::read_dir(&old).unwrap().count(), 1);
    }

    #[test]
    fn an_empty_run_folder_or_an_empty_old_folder_has_nothing_to_continue() {
        let run = tempfile::tempdir().unwrap();
        assert!(SessionWriter::resume(run.path()).unwrap().is_none());
        fs::create_dir_all(run.path().join("session")).unwrap();
        assert!(SessionWriter::resume(run.path()).unwrap().is_none());
    }

    #[test]
    fn a_tool_call_the_crash_left_unanswered_gets_an_error_result_once() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let mut writer = SessionWriter::create(run.path(), "/w").unwrap();
        writer.append(&msg("user", "go")).unwrap();
        writer
            .append(
                &json!({"role": "assistant", "stopReason": "toolUse", "content": [
                {"type": "toolCall", "id": "a", "name": "echo", "arguments": {}},
                {"type": "toolCall", "id": "b", "name": "echo", "arguments": {}}]}),
            )
            .unwrap();
        writer
            .append(&json!({"role": "toolResult", "toolCallId": "a", "toolName": "echo", "content": [], "isError": false}))
            .unwrap();
        drop(writer);
        let resumed = SessionWriter::resume(run.path()).unwrap().unwrap();
        let last = resumed.history.last().unwrap();
        assert_eq!(last["toolCallId"], "b");
        assert_eq!(last["isError"], true);
        assert_eq!(last["content"][0]["text"], INTERRUPTED);
        drop(resumed);
        let again = SessionWriter::resume(run.path()).unwrap().unwrap();
        assert_eq!(again.history.len(), 4, "the second resume adds nothing");
    }

    #[test]
    fn the_session_paths_belong_to_the_agent_group_as_project_state() {
        assert_eq!(
            crate::group_guard::classify("agent-session/session.jsonl"),
            Some(("project_state".into(), "agent".into()))
        );
        assert_eq!(
            crate::group_guard::classify("agent-session/"),
            Some(("project_state".into(), "agent".into()))
        );
    }

    #[test]
    fn a_torn_file_is_kept_whole_beside_the_session_before_it_is_rewritten() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        let mut writer = SessionWriter::create(run.path(), "/w").unwrap();
        writer.append(&msg("user", "kept")).unwrap();
        writer.append(&msg("assistant", "cut off here")).unwrap();
        drop(writer);
        let path = file_in(run.path());
        let torn = fs::read(&path).unwrap();
        let torn = &torn[..torn.len() - 9];
        fs::write(&path, torn).unwrap();
        let mut resumed = SessionWriter::resume(run.path()).unwrap().unwrap();
        let first = path.with_file_name(format!("{FILE}.torn-1"));
        assert_eq!(
            fs::read(&first).unwrap(),
            torn,
            "the original, byte for byte"
        );
        resumed.writer.append(&msg("user", "after")).unwrap();
        drop(resumed);
        // Tear it again: the next copy gets the next number and the first one is left alone.
        let mut text = fs::read(&path).unwrap();
        text.extend_from_slice(b"{\"type\":\"mess");
        fs::write(&path, &text).unwrap();
        let again = SessionWriter::resume(run.path()).unwrap().unwrap();
        assert_eq!(
            again.history,
            vec![msg("user", "kept"), msg("user", "after")]
        );
        assert_eq!(fs::read(&first).unwrap(), torn);
        assert_eq!(
            fs::read(path.with_file_name(format!("{FILE}.torn-2"))).unwrap(),
            text
        );
    }

    #[test]
    fn a_clean_file_leaves_no_copy_and_the_copies_have_a_limit_and_a_group_row() {
        let _command = crate::group_guard::command_for_test("investigate");
        let run = tempfile::tempdir().unwrap();
        SessionWriter::create(run.path(), "/w").unwrap();
        SessionWriter::resume(run.path()).unwrap().unwrap();
        let dir = run.path().join(DIR);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        for n in 1..=MAX_TORN_COPIES {
            fs::write(dir.join(format!("{FILE}.torn-{n}")), "x").unwrap();
            assert_eq!(
                crate::group_guard::classify(&format!("agent-session/{FILE}.torn-{n}")),
                Some(("project_state".into(), "agent".into()))
            );
        }
        let path = file_in(run.path());
        let mut text = fs::read(&path).unwrap();
        text.extend_from_slice(b"{\"ty");
        fs::write(&path, &text).unwrap();
        assert!(matches!(
            SessionWriter::resume(run.path()),
            Err(SessionError::Unreadable(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), text, "refused before any rewrite");
    }
}
