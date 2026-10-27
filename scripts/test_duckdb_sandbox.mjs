// duckdb_query must only read data/, sources/, computations/ and runtime/query-rows
// under the artifact root. Tries absolute paths, `..`, `~`, globs, root-level files
// and a symlink planted inside data/. The "secret" is a fake file in a temp dir.
//
// Drives the real duckdb_query handler (runtime/pi/newsroom.ts with types stripped,
// Pi packages stubbed) against real DuckDB.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "duckdb-sandbox-"));
const FAKE_SECRET = "FAKE-SECRET-NOT-A-REAL-KEY";
try {
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));

  const outside = join(tmp, "outside");
  mkdirSync(outside);
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, `${FAKE_SECRET}\n`);
  writeFileSync(join(outside, "secret.csv"), `k\n${FAKE_SECRET}\n`);

  const art = join(tmp, "artifact");
  for (const dir of ["data", "sources", "computations", "runtime/query-rows"]) mkdirSync(join(art, dir), { recursive: true });
  writeFileSync(join(art, "prompt.md"), `${FAKE_SECRET}-ROOT-LEVEL\n`);
  writeFileSync(join(art, "data", "ok.csv"), "k,v\na,1\n");
  symlinkSync(secret, join(art, "data", "link.txt"));
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  const query = tools.get("duckdb_query");
  assert.ok(query, "duckdb_query must register");

  const ok = await query.execute("q", { sql: "select k, v from read_csv('data/ok.csv') order by k" });
  // With NEWSROOM_DEFAULT_RESULT_BUDGET=1 the same rows come back as preview_rows; each setting reads exactly its own shape.
  const okBody = JSON.parse(ok.content[0].text);
  assert.deepEqual(process.env.NEWSROOM_DEFAULT_RESULT_BUDGET === "1" ? okBody.preview_rows : okBody.rows, [{ k: "a", v: 1 }], "legitimate read under data/ must still work");

  const attempts = {
    "read_text absolute": `select content from read_text('${secret}')`,
    "read_blob absolute": `select content from read_blob('${secret}')`,
    "read_csv absolute": `select * from read_csv('${join(outside, "secret.csv")}')`,
    "read_text ../ out of the root": "select content from read_text('../outside/secret.txt')",
    "read_text data/../ escape": "select content from read_text('data/../../outside/secret.txt')",
    "read_text tilde": "select content from read_text('~/.zshrc')",
    "read_text root-level file": "select content from read_text('prompt.md')",
    "read_text data/../ root file": "select content from read_text('data/../prompt.md')",
    "glob outside": `select * from glob('${outside}/*')`,
    "glob root": "select * from glob('*')",
    "symlink inside data/": "select content from read_text('data/link.txt')",
    "read_text file:// url": `select content from read_text('file://${secret}')`,
  };
  const results = {};
  const reasons = {};
  for (const [name, sql] of Object.entries(attempts)) {
    let leaked = null;
    try {
      const res = await query.execute("q", { sql });
      leaked = JSON.stringify(res);
    } catch (error) { reasons[name] = String(error?.message ?? error).split("\n")[0].slice(0, 160); }
    results[name] = leaked === null ? "blocked" : leaked.includes(FAKE_SECRET) ? "LEAKED" : "returned-no-secret";
  }
  for (const [name, reason] of Object.entries(reasons)) {
    assert.match(reason, /Permission Error: Cannot access file/, `${name} must be rejected by the file-access sandbox, got: ${reason}`);
  }
  const bad = Object.entries(results).filter(([, v]) => v !== "blocked");
  assert.deepEqual(bad, [], `these reads were not blocked: ${JSON.stringify(bad)}`);
  console.log(JSON.stringify({ status: "PASS", attempts: Object.keys(attempts).length }));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
