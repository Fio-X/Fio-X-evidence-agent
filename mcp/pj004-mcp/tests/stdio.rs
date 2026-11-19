//! The server over stdio, as a host drives it: one JSON-RPC message per line on stdin and stdout. Offline: the run folders come from
//! the scripted mock Pi (as scripts/test_verify_json.py makes its complete run), and the failure paths use a fake `news`.
//! Needs a built `news`: NEWS_BIN=<path>; there is no default, so a missing one fails loudly. `python3` must be on PATH (the mock).
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn news_bin() -> PathBuf {
    let path =
        std::env::var_os("NEWS_BIN").expect("set NEWS_BIN to a built `news` (target/debug/news)");
    let path = PathBuf::from(path);
    assert!(path.is_file(), "NEWS_BIN {} is not a file", path.display());
    path
}

struct Host {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

impl Host {
    fn start(runs: &Path, news: &Path) -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pj004-mcp"))
            .arg("--runs")
            .arg(runs)
            .arg("--news")
            .arg(news)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Host {
            child,
            stdin,
            lines,
            next_id: 1,
        }
    }

    fn send(&mut self, message: &Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Sends a request and returns its response; every line the server writes must be a JSON-RPC message (stdout carries nothing else).
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(90))
                .expect("no reply from the server");
            let message: Value = serde_json::from_str(&line)
                .unwrap_or_else(|_| panic!("stdout line is not JSON: {line}"));
            assert_eq!(message["jsonrpc"], json!("2.0"), "{line}");
            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    /// The handshake of the revisions up to 2025-11-25: `initialize`, then the `initialized` notification.
    fn initialize(&mut self) -> Value {
        let reply = self.request(
            "initialize",
            json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "pj004-test", "version": "0"}}),
        );
        self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        reply
    }

    fn verify(&mut self, run_id: &str) -> Value {
        self.request(
            "tools/call",
            json!({"name": "pj004_verify", "arguments": {"run_id": run_id}}),
        )["result"]
            .clone()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn run(program: &Path, args: &[&str], cwd: &Path) -> std::process::Output {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("NEWSROOM_AGENT", "pi")
        .env("NEWSROOM_RPC_STARTUP_MS", "10000")
        .env("NEWSROOM_RPC_IDLE_MS", "8000")
        .env("NEWSROOM_RPC_FINISH_MS", "8000")
        .env("NEWSROOM_RPC_TOTAL_MS", "30000")
        .output()
        .unwrap()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A run root holding a complete run (the mock Pi's happy path, which ends VERIFIED) and a broken copy of it. Returns (root, id, broken id).
fn run_root() -> (tempfile::TempDir, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let runs = temp.path().join("runs");
    std::fs::create_dir(&runs).unwrap();
    let repo = repo();
    let mock = repo.join("scripts/mock_pi.py");
    let made = run(
        &news_bin(),
        &[
            "investigate",
            "--pi-bin",
            mock.to_str().unwrap(),
            "--out",
            runs.to_str().unwrap(),
            "happy path",
        ],
        &repo,
    );
    assert_eq!(
        made.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let ids: Vec<String> = std::fs::read_dir(&runs)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| entry.file_name().into_string().unwrap())
        .collect();
    assert_eq!(ids.len(), 1, "{ids:?}");
    let id = ids[0].clone();
    let broken = format!("{id}-broken");
    copy_dir(&runs.join(&id), &runs.join(&broken));
    std::fs::write(runs.join(&broken).join("claims.jsonl"), "{not json\n").unwrap();
    (temp, id, broken)
}

fn text_of(result: &Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[test]
fn verify_relays_the_news_verdict_for_a_complete_run_and_a_broken_copy() {
    let (temp, id, broken) = run_root();
    let runs = temp.path().join("runs");
    let news = news_bin();
    let mut host = Host::start(&runs, &news);

    let hello = host.initialize();
    assert!(
        hello["result"]["capabilities"]["tools"].is_object(),
        "{hello}"
    );

    // the one tool, with a closed input schema that has no path, key or url field
    let listed = host.request("tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1, "{listed}");
    assert_eq!(tools[0]["name"], json!("pj004_verify"));
    let schema = &tools[0]["inputSchema"];
    assert_eq!(schema["additionalProperties"], json!(false), "{schema}");
    let mut fields: Vec<&str> = schema["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    fields.sort();
    assert_eq!(fields, ["recompute", "run_id"]);
    assert_eq!(schema["required"], json!(["run_id"]));

    // the complete run: what the server returns is what `news verify --json` prints, and what verification.json records
    let good = host.verify(&id);
    assert_ne!(good["isError"], json!(true), "{good}");
    let relayed = &good["structuredContent"];
    assert_eq!(relayed["passed"], json!(true), "{good}");
    assert_eq!(relayed["errors"], json!([]));
    assert_eq!(relayed["report"], json!(format!("{id}/verification.json")));
    let direct = run(
        &news,
        &["verify", runs.join(&id).to_str().unwrap(), "--json"],
        &repo(),
    );
    assert_eq!(direct.status.code(), Some(0));
    let direct: Value = serde_json::from_slice(&direct.stdout).unwrap();
    let record: Value =
        serde_json::from_slice(&std::fs::read(runs.join(&id).join("verification.json")).unwrap())
            .unwrap();
    for field in ["passed", "checks", "integrity"] {
        assert_eq!(relayed[field], direct[field], "{field}");
    }
    assert_eq!(relayed["checks"], record["checks"]);
    assert_eq!(relayed["integrity"], record["integrity"]);
    assert!(relayed["checks"].as_u64().unwrap() > 0);
    assert!(
        text_of(&good).contains("\"passed\":true"),
        "the text block repeats the JSON: {good}"
    );

    // the broken copy: a verdict (passed=false with errors), not a tool failure
    let bad = host.verify(&broken);
    assert_ne!(bad["isError"], json!(true), "{bad}");
    assert_eq!(bad["structuredContent"]["passed"], json!(false), "{bad}");
    assert!(
        !bad["structuredContent"]["errors"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{bad}"
    );
    let direct = run(
        &news,
        &["verify", runs.join(&broken).to_str().unwrap(), "--json"],
        &repo(),
    );
    assert_eq!(direct.status.code(), Some(1));
    let direct: Value = serde_json::from_slice(&direct.stdout).unwrap();
    assert_eq!(bad["structuredContent"]["errors"], direct["errors"]);
    assert_eq!(bad["structuredContent"]["checks"], direct["checks"]);

    // a run_id that is not a plain folder name under the run root never reaches `news`
    for bad_id in ["../runs", "a/b", "", ".", "..", "no-such-run"] {
        let refused = host.verify(bad_id);
        assert_eq!(refused["isError"], json!(true), "{bad_id:?}: {refused}");
        assert!(
            !text_of(&refused).contains(temp.path().to_str().unwrap()),
            "no absolute path in {refused}"
        );
    }
    // an argument the schema does not have is refused as well
    let extra = host.request(
        "tools/call",
        json!({"name": "pj004_verify", "arguments": {"run_id": id, "path": "/etc"}}),
    );
    assert!(
        extra["error"].is_object() || extra["result"]["isError"] == json!(true),
        "{extra}"
    );
}

fn fake_news(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn verify_that_ends_before_a_verdict_or_contradicts_its_exit_code_is_a_tool_error() {
    let temp = tempfile::tempdir().unwrap();
    let runs = temp.path().join("runs");
    std::fs::create_dir_all(runs.join("r")).unwrap();
    let cases = [
        (
            "exit2",
            "echo \"error: could not read $2\" >&2; exit 2",
            "exit code 2",
        ),
        ("not-json", "echo hello; exit 0", "no JSON"),
        (
            "contradiction",
            "echo '{\"passed\":true,\"checks\":1,\"errors\":[]}'; exit 1",
            "disagrees",
        ),
    ];
    for (name, body, expect) in cases {
        let news = fake_news(temp.path(), name, body);
        let mut host = Host::start(&runs, &news);
        host.initialize();
        let result = host.verify("r");
        assert_eq!(result["isError"], json!(true), "{name}: {result}");
        assert!(text_of(&result).contains(expect), "{name}: {result}");
        assert!(
            result.get("structuredContent").is_none() || result["structuredContent"].is_null(),
            "{name}: {result}"
        );
    }
}

/// Follows MCP spec revision 2026-07-28 (the handshake-less one): no `initialize`, each request carries its version in `_meta`, and
/// `server/discover` is the probe. The message shapes come from the spec text (basic/versioning, basic/transports/stdio) only: this test
/// is UNVERIFIED against rmcp 3.8 until it has been run, and against any real host (Claude Code, Codex, Cursor) until one is tried.
#[test]
fn verify_also_works_without_the_initialize_handshake() {
    let (temp, id, _broken) = run_root();
    let mut host = Host::start(&temp.path().join("runs"), &news_bin());
    let meta = json!({"io.modelcontextprotocol/protocolVersion": "2026-07-28",
                      "io.modelcontextprotocol/clientInfo": {"name": "pj004-test", "version": "0"},
                      "io.modelcontextprotocol/clientCapabilities": {}});
    let found = host.request("server/discover", json!({"_meta": meta}));
    assert!(found["result"]["supportedVersions"].is_array(), "{found}");
    let called = host.request(
        "tools/call",
        json!({"_meta": meta, "name": "pj004_verify", "arguments": {"run_id": id}}),
    );
    assert_eq!(
        called["result"]["structuredContent"]["passed"],
        json!(true),
        "{called}"
    );
}
