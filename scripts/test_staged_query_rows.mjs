// 1012h (K235): in a staged call (NEWSROOM_AGENT=rust) the query-rows table a duckdb read of computations/<hash>.json needs is written to the call's
// staging folder, so DuckDB must read that copy in the same call. Only this call's own query-rows folder is added to allowed_directories; outside a
// staged call nothing changes.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const duck = join(homedir(), ".local/bin/duckdb");
if (!existsSync(duck)) { console.log("SKIP: no duckdb binary"); process.exit(0); }
const tmp = mkdtempSync(join(tmpdir(), "staged-query-rows-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
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
const art = join(tmp, "run");
for (const dir of ["data", "sources", "computations", "runtime/query-rows", "session", "staging"]) mkdirSync(join(art, dir), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
process.env.NEWSROOM_DUCKDB_BIN = duck;
const HASH = "a".repeat(64);
const REF = `computations/${HASH}.json`;
writeFileSync(join(art, REF), JSON.stringify({ rows: [{ k: "x", v: 3 }, { k: "y", v: 4 }] }));

const { runInStagedCall } = await import(join(pi, "groups.mjs"));
const tools = new Map();
const { default: ext } = await import(join(pi, "newsroom.test-copy.mjs"));
ext(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const query = tools.get("duckdb_query");
const sql = `SELECT sum(v) AS total FROM read_json('${REF}')`;
const total = async (id) => Number(JSON.parse(readFileSync((await query.execute(id, { sql })).details.path, "utf8")).rows[0].total);

// staged call: the rows only exist in the call's staging folder, and the query still reads them in the same call
const call = join(art, "staging", "c1");
mkdirSync(call, { recursive: true });
assert.equal(await runInStagedCall("c1", call, () => total("c1")), 7); n++;
ok(!existsSync(join(art, "runtime/query-rows", `${HASH}.json`)), "the run folder is untouched until Rust moves the staged files in");
ok(existsSync(join(call, "own/once/runtime/query-rows", `${HASH}.json`)), "the table is in the call's staging folder");
// a second staged call (rows already in the run folder, as after finish) and an unstaged call both still work
writeFileSync(join(art, "runtime/query-rows", `${HASH}.json`), JSON.stringify([{ k: "x", v: 3 }, { k: "y", v: 4 }], null, 2) + "\n");
const call2 = join(art, "staging", "c2"); mkdirSync(call2, { recursive: true });
assert.equal(await runInStagedCall("c2", call2, () => total("c2")), 7); n++;
assert.equal(await total("plain"), 7); n++;
// the staged folder is the only extra directory: a read of another path under the staging folder is still refused
const other = join(art, "staging", "c1", "own/once/data"); mkdirSync(other, { recursive: true }); writeFileSync(join(other, "x.json"), "[{\"v\":1}]");
await assert.rejects(runInStagedCall("c1", call, () => query.execute("c1", { sql: `SELECT * FROM read_json('staging/c1/own/once/data/x.json')` })), /DUCKDB_QUERY_FAILED/); n++;
console.log(`test_staged_query_rows: ${n} checks passed`);
