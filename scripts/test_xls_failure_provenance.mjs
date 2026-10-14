// NEWSROOM_XLS_FAILURE_PROVENANCE=1 (exact "1", default off, with NEWSROOM_XLS_CONVERT=1): a failed .xls/.ods conversion in download_data
// writes a record of the failure to data/origins (what was tried, the error kind, the source), still fails as before, and writes no success
// record, no CSV and no table. Off, the file listing is byte-identical to before. Needs no Python and no bundle: the missing bundle is the failure.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

const tmp = mkdtempSync(join(tmpdir(), "xls-failure-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const pi = join(tmp, "runtime", "pi");
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));

const KEYS = ["NEWSROOM_XLS_CONVERT", "NEWSROOM_XLS_CONVERT_DIR", "NEWSROOM_XLS_FAILURE_PROVENANCE"];
const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };
for (const [v, want] of [[undefined, false], ["0", false], ["true", false], ["", false], ["1", true]]) { setEnv(v === undefined ? {} : { NEWSROOM_XLS_FAILURE_PROVENANCE: v }); eq(mod.xlsFailureProvenanceEnabled(), want, `switch ${v}`); }

const art = join(tmp, "artifact");
for (const dir of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(art, dir), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
const bytes = Buffer.from("this is not a spreadsheet\n");
globalThis.fetch = async (url) => {
  const res = new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
  Object.defineProperty(res, "url", { value: String(url) });
  return res;
};
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const download = tools.get("download_data");
const listing = () => readdirSync(art, { recursive: true }).sort();
const origins = () => { try { return readdirSync(join(art, "data/origins")).map((f) => JSON.parse(readFileSync(join(art, "data/origins", f), "utf8"))); } catch { return []; } };
const URL_ = "http://8.8.8.8/t/broken.xls";

// conversion on, failure record off: fails, and nothing about the failure is written (the behaviour before)
setEnv({ NEWSROOM_XLS_CONVERT: "1" });
await assert.rejects(download.execute("d", { url: URL_ }), /XLS_CONVERT_UNAVAILABLE/); n++;
const before = listing();
eq(origins(), [], "no origin record without the failure switch");

// both on: same failure, plus one failure record
setEnv({ NEWSROOM_XLS_CONVERT: "1", NEWSROOM_XLS_FAILURE_PROVENANCE: "1" });
await assert.rejects(download.execute("d", { url: URL_ }), /XLS_CONVERT_UNAVAILABLE/); n++;
const after = listing();
const added = after.filter((f) => !before.includes(f) && f.endsWith(".json"));
eq(added.length, 1, `exactly one new file: ${added}`); ok(added[0].startsWith("data/origins/") || added[0].startsWith("data\\origins\\"), added[0]);
const rec = origins();
eq(rec.length, 1);
eq([rec[0].origin, rec[0].error_kind, rec[0].source_sha256, rec[0].source_file, rec[0].requested_url, rec[0].final_url],
  ["spreadsheet_conversion_failed", "XLS_CONVERT_UNAVAILABLE", sha(bytes), `data/${sha(bytes)}.xls`, URL_, URL_]);
ok(typeof rec[0].attempted === "string" && rec[0].attempted.includes("python-calamine"), "what was tried");
ok(!("sheet" in rec[0]) && !("sha256" in rec[0]) && !("derived_tables" in rec[0]), "no success fields");
ok(!after.some((f) => f.endsWith(".csv")), "no csv");
ok(!origins().some((o) => o.origin === "spreadsheet_conversion" || o.origin === "download"), "no success record");
// the same failure again writes the same record, not a second one
await assert.rejects(download.execute("d", { url: URL_ }), /XLS_CONVERT_UNAVAILABLE/); n++;
eq(origins().length, 1, "same failure, same record");

// the failure switch alone (conversion off) changes nothing: .xls is saved as .data and the usual origin record is written
setEnv({ NEWSROOM_XLS_FAILURE_PROVENANCE: "1" });
const off = await download.execute("d", { url: URL_ });
eq(off.details.filePath, `data/${sha(bytes)}.data`);
eq(origins().filter((o) => o.origin === "download").length, 1);
console.log(`test_xls_failure_provenance: ${n} checks passed`);
