// 1012f: NEWSROOM_XLS_CONVERT=1 (exact "1", default off) converts a downloaded .xls/.ods to CSV in the program, with python-calamine
// from a pinned bundle. Fixtures are written from scratch (scripts/xls_fixture.py). Needs: a Python 3.13 (NEWSROOM_PYTHON_BIN, default the
// product venv's interpreter, used read-only) and the cp313 wheel (CALAMINE_TEST_WHEEL); otherwise SKIP. Nothing is installed anywhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PY313 = process.env.NEWSROOM_PYTHON_BIN || join(homedir(), "code/PJ004-local-docs/venv/rt-py313/bin/python3");
const WHEEL = process.env.CALAMINE_TEST_WHEEL || "";
if (!existsSync(PY313) || !WHEEL || !existsSync(WHEEL)) { console.log("SKIP: set CALAMINE_TEST_WHEEL (cp313 wheel) and a Python 3.13 in NEWSROOM_PYTHON_BIN"); process.exit(0); }
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

const tmp = mkdtempSync(join(tmpdir(), "xls-convert-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

// fixtures + bundle (offline from the local wheel)
const fx = join(tmp, "fx");
assert.equal(sh("python3", [join(ROOT, "scripts/xls_fixture.py"), fx]).status, 0);
const bundle = join(tmp, "bundle");
const fetched = sh("python3", [join(ROOT, "scripts/fetch_calamine.py"), "--out", bundle, "--from-whl", WHEEL]);
eq(fetched.status, 0, fetched.stderr); ok(existsSync(join(bundle, "cp313/python_calamine")), "cp313 package unpacked");
ok(/^[0-9a-f]{64}  python_calamine-0\.8\.3-cp313/.test(readFileSync(join(bundle, "cp313/WHEEL.sha256"), "utf8")), "wheel hash recorded");
// a pin that does not match the wheel fails and leaves nothing behind
const wrong = join(tmp, "wrong");
const bad = sh("python3", [join(ROOT, "scripts/fetch_calamine.py"), "--out", wrong, "--tag", "cp314", "--from-whl", WHEEL]);
ok(bad.status !== 0 && /sha256 mismatch/.test(bad.stderr), bad.stderr); ok(!existsSync(wrong), "nothing left behind");

// load newsroom.ts like the other tests
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
const { convertSpreadsheetToCsv, xlsConvertEnabled } = mod;

const KEYS = ["NEWSROOM_XLS_CONVERT", "NEWSROOM_XLS_CONVERT_DIR", "NEWSROOM_PYTHON_BIN"];
const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };
for (const [v, want] of [[undefined, false], ["0", false], ["true", false], ["", false], ["1", true]]) { setEnv(v === undefined ? {} : { NEWSROOM_XLS_CONVERT: v }); eq(xlsConvertEnabled(), want, `switch ${v}`); }

// direct conversion: both formats, numbers intact, whole floats and decimals normalised, dates as ISO, empty cell empty, comma quoted
const EXPECT = 'Age,Total,Share,Date\n0,1811000,0.256,2024-03-05\n1,3162567,-12.5,1999-12-31\n"Note, with comma",7,,2000-01-01\n';
setEnv({ NEWSROOM_PYTHON_BIN: PY313, NEWSROOM_XLS_CONVERT_DIR: bundle });
for (const name of ["sample.xls", "sample.ods"]) {
  const r = await convertSpreadsheetToCsv(join(fx, name));
  eq(r.sheets.length, 1, name); eq(r.sheets[0].sheet, "Data"); eq(r.sheets[0].csv, EXPECT, name); eq([r.sheets[0].rows, r.sheets[0].cols], [4, 4]);
  eq([r.converter, r.version, r.python], ["python-calamine", "0.8.3", "cp313"]); ok(/^[0-9a-f]{64}$/.test(r.wheel_sha256));
}
// bad file: explicit error, not an empty table
await assert.rejects(convertSpreadsheetToCsv(join(fx, "bad.xls")), /^Error: XLS_CONVERT_FAILED: the file is not a readable spreadsheet/); n++;
// missing / relative bundle dir and ABI mismatch (this python3 is not 3.13) are explicit errors
setEnv({ NEWSROOM_PYTHON_BIN: PY313 });
await assert.rejects(convertSpreadsheetToCsv(join(fx, "sample.xls")), /XLS_CONVERT_UNAVAILABLE: NEWSROOM_XLS_CONVERT_DIR/); n++;
setEnv({ NEWSROOM_PYTHON_BIN: PY313, NEWSROOM_XLS_CONVERT_DIR: join(tmp, "empty") });
await assert.rejects(convertSpreadsheetToCsv(join(fx, "sample.xls")), /XLS_CONVERT_UNAVAILABLE: no python-calamine bundle for this interpreter \(cp313\)/); n++;
const other = sh("python3", ["-c", "import sys;print('cp%d%d' % sys.version_info[:2])"]).stdout.trim();
if (other !== "cp313") {
  setEnv({ NEWSROOM_PYTHON_BIN: "python3", NEWSROOM_XLS_CONVERT_DIR: bundle });
  await assert.rejects(convertSpreadsheetToCsv(join(fx, "sample.xls")), new RegExp(`XLS_CONVERT_UNAVAILABLE: no python-calamine bundle for this interpreter \\(${other}\\)`)); n++;
}

// download_data end to end (mocked fetch), switch on and off
const art = join(tmp, "artifact");
for (const dir of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(art, dir), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
const served = new Map([["xls", "sample.xls"], ["ods", "sample.ods"], ["bad.xls", "bad.xls"]].map(([k, f]) => [`http://8.8.8.8/t/${k === "bad.xls" ? "bad.xls" : "sample." + k}`, readFileSync(join(fx, f))]));
globalThis.fetch = async (url) => {
  const body = served.get(String(url));
  if (!body) return new Response("nope", { status: 404 });
  const res = new Response(body, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(body.length) } });
  Object.defineProperty(res, "url", { value: String(url) });
  return res;
};
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const download = tools.get("download_data"), query = tools.get("duckdb_query");
const listing = () => readdirSync(art, { recursive: true }).sort();

// off: original behaviour (xls saved as .data, no conversion, nothing extra)
setEnv({ NEWSROOM_PYTHON_BIN: PY313, NEWSROOM_XLS_CONVERT_DIR: bundle });
const xlsBytes = readFileSync(join(fx, "sample.xls"));
const off = await download.execute("d", { url: "http://8.8.8.8/t/sample.xls" });
eq(off.details.filePath, `data/${sha(xlsBytes)}.data`); eq(readFileSync(join(art, off.details.filePath)), xlsBytes);
ok(!/converted by the program/.test(off.content[0].text), "no conversion note when off");
const offFiles = listing(); ok(!offFiles.some((f) => f.endsWith(".csv")), "no csv when off");
const offOrigin = JSON.parse(readFileSync(off.details.originPath, "utf8")); ok(!("derived_tables" in offOrigin), "off origin unchanged");

// on
setEnv({ NEWSROOM_XLS_CONVERT: "1", NEWSROOM_PYTHON_BIN: PY313, NEWSROOM_XLS_CONVERT_DIR: bundle });
const on = await download.execute("d", { url: "http://8.8.8.8/t/sample.xls" });
eq(on.details.filePath, `data/${sha(xlsBytes)}.xls`, "original kept under its own hash"); eq(readFileSync(join(art, on.details.filePath)), xlsBytes);
const csvRef = `data/${sha(Buffer.from(EXPECT))}.csv`;
eq(readFileSync(join(art, csvRef), "utf8"), EXPECT); ok(on.content[0].text.includes(`Sheet 'Data' (4 rows x 4 columns) converted by the program to CSV: ${csvRef}`), on.content[0].text);
const origin = JSON.parse(readFileSync(on.details.originPath, "utf8"));
eq(origin.derived_tables, [{ file: csvRef, sheet: "Data", sha256: sha(Buffer.from(EXPECT)), rows: 4, cols: 4 }]); eq(origin.sha256, sha(xlsBytes));
const derived = readdirSync(join(art, "data/origins")).map((f) => JSON.parse(readFileSync(join(art, "data/origins", f), "utf8"))).find((o) => o.origin === "spreadsheet_conversion");
ok(derived, "conversion origin record"); eq([derived.source_file, derived.source_sha256, derived.sheet, derived.converter], [on.details.filePath, sha(xlsBytes), "Data", "python-calamine 0.8.3"]);
ok(/^[0-9a-f]{64}$/.test(derived.converter_wheel_sha256), "wheel hash in provenance");
const ods = await download.execute("d", { url: "http://8.8.8.8/t/sample.ods" });
eq(ods.details.filePath, `data/${sha(readFileSync(join(fx, "sample.ods")))}.ods`); ok(ods.content[0].text.includes(csvRef), "ods gives the same CSV file");
// bad file when on: explicit error
await assert.rejects(download.execute("d", { url: "http://8.8.8.8/t/bad.xls" }), /XLS_CONVERT_FAILED/); n++;
ok(listing().filter((f) => f.endsWith(".csv")).length === 1, "bad file made no csv");

// the converted CSV is readable by duckdb_query
const duck = join(homedir(), ".local/bin/duckdb");
if (existsSync(duck)) {
  process.env.NEWSROOM_DUCKDB_BIN = duck;
  const run = await query.execute("q", { sql: `SELECT sum(Total) AS t, count(*) AS c, max(CAST(Date AS DATE)) AS d FROM read_csv_auto('${csvRef}')` });
  const rec = JSON.parse(readFileSync(run.details.path, "utf8"));
  eq(rec.rows.length, 1); eq([Number(rec.rows[0].t), Number(rec.rows[0].c)], [1811000 + 3162567 + 7, 3]);
} else console.log("SKIP duckdb read: no duckdb binary");
console.log(`test_xls_convert: ${n} checks passed`);
