// NEWSROOM_DATA_PREPARE=1 (exact "1", default off): newsroom_data_prepare, offline. The catalog, structure, code lists and data files are
// real Eurostat answers saved under scripts/fixtures/data_prepare (the code lists are trimmed to the lines the tests use); fetch is a stub.
// The provider host is swapped for a literal IP in the test copy only, so no DNS lookup happens. Each mutant patches the copy's source
// text and must turn exactly the check that guards that rule red.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "scripts/fixtures/data_prepare");
const fixture = (name) => readFileSync(join(FX, name));
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const tmp = mkdtempSync(join(tmpdir(), "data-prepare-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const piDir = join(tmp, "runtime", "pi");
const SOURCE = readFileSync(join(piDir, "newsroom.ts"), "utf8");
const HOST = "https://ec.europa.eu";
// the patch must change the source, or the mutant tests nothing
const swap = (from, to) => (text) => { assert.ok(text.includes(from), `mutant anchor missing: ${from}`); return text.split(from).join(to); };
let variant = 0;
const load = async (patch = (text) => text) => {
  // the 30 s download timer is shortened so a hanging request can be timed out twice inside the test
  const text = swap("const DOWNLOAD_TIMEOUT_MS = 30_000;", "const DOWNLOAD_TIMEOUT_MS = 60;")(patch(SOURCE)).split(HOST).join("http://8.8.8.8");
  const file = join(piDir, `newsroom.test-copy-${variant++}.mjs`);
  writeFileSync(file, stripTypeScriptTypes(text, { mode: "strip" }));
  return import(file);
};

// ---- stubbed network -------------------------------------------------------------------------------------------------------------------
const TOY_XML = (dims) => `<?xml version="1.0"?><m:Structure xmlns:m="x" xmlns:s="y" xmlns:c="z"><m:Header><m:ID>t</m:ID></m:Header><m:Structures><s:DataStructures><s:DataStructure id="toy"><s:DataStructureComponents><s:DimensionList>${dims.map(([id, cl], i) => `<s:Dimension id="${id}" position="${i + 1}">${cl ? `<s:LocalRepresentation><s:Enumeration><Ref id="${cl}" class="Codelist"/></s:Enumeration></s:LocalRepresentation>` : ""}</s:Dimension>`).join("")}<s:TimeDimension id="TIME_PERIOD" position="${dims.length + 1}"/></s:DimensionList></s:DataStructureComponents></s:DataStructure></s:DataStructures></m:Structures></m:Structure>`;
const routes = [
  [/\/catalogue\/toc\/txt/, () => fixture("toc.txt")],
  [/\/datastructure\/ESTAT\/nrg_bal_c\//, () => fixture("nrg_dsd.xml")],
  [/\/contentconstraint\/ESTAT\/nrg_bal_c/, () => fixture("nrg_constraint.xml")],
  [/\/data\/nrg_bal_c\/A\.GIC\.TOTAL\.\.DE\?/, () => Buffer.from("DATAFLOW,freq,nrg_bal,siec,unit,geo,TIME_PERIOD,OBS_VALUE\nT,A,GIC,TOTAL,TJ,DE,2023,10\nT,A,GIC,TOTAL,KTOE,DE,2023,0.2\n")],
  [/\/codelist\/ESTAT\/(NRG_BAL|SIEC|UNIT|GEO|FREQ)\//, (m) => fixture(`cl_${m[1]}.tsv`)],
  [/\/data\/nrg_bal_c\/A\.GIC\.TOTAL\.TJ\.DE\?/, () => fixture("nrg_ts.csv")],
  [/\/data\/nrg_bal_c\/A\.GIC\.TOTAL\.TJ\.\?/, () => fixture("nrg_rank.csv")],
  [/\/datastructure\/ESTAT\/toy_two\//, () => Buffer.from(TOY_XML([["colour", "CL_A"], ["shape", "CL_B"]]))],
  [/\/datastructure\/ESTAT\/toy_odd\//, () => Buffer.from(TOY_XML([["colour", "CL_A"]]).replace("<s:DimensionList>", "<s:DimensionList><s:Surprise/>"))],
  [/\/datastructure\/ESTAT\/toy_nocl\//, () => Buffer.from(TOY_XML([["colour", "CL_A"], ["shape", null]]))],
  [/\/codelist\/ESTAT\/CL_A\//, () => Buffer.from("X1\tRed\r\nA2\tBlue\r\n")],
  [/\/codelist\/ESTAT\/CL_B\//, () => Buffer.from("X1\tRound\r\nB2\tSquare\r\n")],
  [/\/data\/toy_two\/X1\.B2\?/, () => Buffer.from("DATAFLOW,colour,shape,TIME_PERIOD,OBS_VALUE\nT,X1,B2,2020,1\nT,A2,B2,2020,2\n")],
  [/\/data\/toy_two\/A2\.B2\?/, () => Buffer.from("DATAFLOW,shape,colour,TIME_PERIOD,OBS_VALUE\nT,B2,A2,2020,1\n")],
];
// sum_year: MONTHS is invented, not a Eurostat answer. Five dimensions (partner is the one a summed year must not sum across), 8 series,
// 2025-01..2026-08; value of series i in month mm is "<100 i + mm>.1", so a whole 2025 is 1200 i + 79.2 exactly. In toy_month one series
// lacks 2025-07 (7 of 8 whole, at least 0.8); toy_thin also has an empty 2025-03 value in another (6 of 8 whole, under 0.8).
const MONTH_SERIES = ["TOTAL", "C0100"].flatMap((siec) => ["X1", "A2"].flatMap((partner) => ["DE", "FR"].map((geo) => [siec, partner, geo])));
const MONTHS = (gaps) => Buffer.from(["DATAFLOW,freq,siec,unit,partner,geo,TIME_PERIOD,OBS_VALUE", ...MONTH_SERIES.flatMap(([siec, partner, geo], i) =>
  [...Array.from({ length: 12 }, (_, k) => `2025-${String(k + 1).padStart(2, "0")}`), ...Array.from({ length: 8 }, (_, k) => `2026-${String(k + 1).padStart(2, "0")}`)]
    .flatMap((time) => { const gap = gaps[`${siec}.${partner}.${geo}.${time}`]; return gap === "absent" ? [] : [`T,M,${siec},TJ,${partner},${geo},${time},${gap === "empty" ? "" : `${100 * (i + 1) + Number(time.slice(5))}.1`}`]; }))].join("\n") + "\n");
const MONTH_GAP = { "C0100.A2.FR.2025-07": "absent" };
const MONTH_DIMS = [["freq", "FREQ"], ["siec", "SIEC"], ["unit", "UNIT"], ["partner", "CL_A"], ["geo", "GEO"]];
for (const [id, gaps] of [["toy_month", MONTH_GAP], ["toy_thin", { ...MONTH_GAP, "C0100.X1.FR.2025-03": "empty" }]]) {
  routes.push([new RegExp(`/datastructure/ESTAT/${id}/`), () => Buffer.from(TOY_XML(MONTH_DIMS))]);
  routes.push([new RegExp(`/data/${id}/M\\.TOTAL\\+C0100\\.TJ\\.X1\\+A2\\.DE\\+FR\\?`), () => MONTHS(gaps)]);
}
let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url));
  if (/hang_ds/.test(String(url))) return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))));
  for (const [pattern, body] of routes) {
    const m = pattern.exec(String(url));
    if (!m) continue;
    const bytes = body(m);
    const res = new Response(bytes, { status: 200, headers: { "content-type": "text/plain", "content-length": String(bytes.length) } });
    Object.defineProperty(res, "url", { value: String(url) });
    return res;
  }
  return new Response("nope", { status: 404 });
};
const THIS_RUN = () => process.env.NEWSROOM_ARTIFACT_DIR;
let runNumber = 0;
const newRun = () => {
  const dir = join(tmp, `run-${runNumber++}`);
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(dir, d), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  fetchCalls = [];
  return dir;
};
const registered = (mod) => { const tools = new Map(); mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) })); return tools; };
const sha256OfFile = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const text = (out) => out.content.map((c) => c.text).join("\n");
const refuses = async (promise) => { try { await promise; return null; } catch (error) { return String(error?.message ?? error); } };
const TS = { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "nrg_bal", values: ["Gross inland consumption"] }, { dimension: "siec", values: ["total"] }, { dimension: "unit", values: ["TJ"] }, { dimension: "geo", values: ["Germany"] }], years: { start: 2018, end: 2023 } };
const TOPIC_WORDS = ["energy", "gas", "oil", "coal", "population", "trade", "health", "climate", "wage", "inflation", "population", "能源", "人口", "贸易"];

process.env.NEWSROOM_DATA_PREPARE = "1";
delete process.env.NEWSROOM_DOWNLOAD_FROZEN;
const mod = await load();
const tools = registered(mod);
const prepare = tools.get("newsroom_data_prepare");
ok(prepare, "1: switch on: the tool is registered");
const hooks = mod.__dataPrepareForTest;

const pageBuildOn = async (fn) => {
  process.env.NEWSROOM_NEXT = "1";
  process.env.NEWSROOM_SPEED_PAGE_BUILD = "1";
  process.env.NEWSROOM_AGENT = "rust";
  try { return await fn(); } finally { delete process.env.NEWSROOM_NEXT; delete process.env.NEWSROOM_SPEED_PAGE_BUILD; delete process.env.NEWSROOM_AGENT; }
};
const MONTH_ASK = (dataset) => ({ dataset, filters: [{ dimension: "freq", values: ["M"] }, { dimension: "siec", values: ["TOTAL", "C0100"] }, { dimension: "unit", values: ["TJ"] }, { dimension: "partner", values: ["X1", "A2"] }, { dimension: "geo", values: ["DE", "FR"] }], years: { start: 2025, end: 2026 }, sum_year: { n: 12, share: 0.8 } });

// ---- the checks every mutant is run against; each returns true when the rule holds -------------------------------------------------------
const checks = {
  notEvidence: async (m, t) => { newRun(); return text(await t.get("newsroom_data_prepare").execute("a", TS)).startsWith("Program-measured data preparation (not evidence"); },
  providerSources: async (m) => Object.values(m.__dataPrepareForTest.providers).every((fields) => Object.values(fields).every((f) => typeof f.source === "string" && f.source.length > 0)),
  noTopicWords: async (m) => JSON.stringify(Object.entries(m.__dataPrepareForTest.providers)).toLowerCase().split(/[^a-z一-鿿]+/).every((w) => !TOPIC_WORDS.includes(w)),
  exactOnly: async (m, t) => {
    newRun();
    const out = await t.get("newsroom_data_prepare").execute("a", { ...TS, filters: [{ dimension: "geo", values: ["german"] }], years: { start: 2020, end: 2020 } });
    return !fetchCalls.some((u) => u.includes("/data/")) && /nothing downloaded/.test(text(out)) && /DE = Germany/.test(text(out));
  },
  ambiguity: async (m, t) => {
    newRun();
    const out = text(await t.get("newsroom_data_prepare").execute("a", { dataset: "toy_two", terms: ["X1"], years: { start: 2020, end: 2020 } }));
    return /AMBIGUOUS/.test(out) && /colour/.test(out) && /shape/.test(out) && !fetchCalls.some((u) => u.includes("/data/"));
  },
  unknownElement: async (m, t) => {
    newRun();
    const message = await refuses(t.get("newsroom_data_prepare").execute("a", { dataset: "toy_odd", filters: [{ dimension: "colour", values: ["X1"] }], years: { start: 2020, end: 2020 } }));
    return /DATA_PREPARE_UNKNOWN_ELEMENT.*Surprise/.test(message ?? "");
  },
  rowCheck: async (m, t) => {
    newRun();
    const message = await refuses(t.get("newsroom_data_prepare").execute("a", { dataset: "toy_two", filters: [{ dimension: "colour", values: ["X1"] }, { dimension: "shape", values: ["B2"] }], years: { start: 2020, end: 2020 } }));
    return /DATA_PREPARE_COLUMN_MISMATCH: row 2 column colour is A2/.test(message ?? "");
  },
  headerCheck: async (m, t) => {
    newRun();
    const message = await refuses(t.get("newsroom_data_prepare").execute("a", { dataset: "toy_two", filters: [{ dimension: "colour", values: ["A2"] }, { dimension: "shape", values: ["B2"] }], years: { start: 2020, end: 2020 } }));
    return /DATA_PREPARE_COLUMN_MISMATCH: header column/.test(message ?? "");
  },
  reusesDownloads: async (m, t) => {
    newRun();
    await t.get("newsroom_data_prepare").execute("a", TS);
    const before = fetchCalls.length;
    const again = text(await t.get("newsroom_data_prepare").execute("b", TS));
    return fetchCalls.length === before && /not requested again/.test(again);
  },
  repeatStaysRefused: async (m, t) => {
    // download_data refuses the third identical request after two timeouts; the command's own requests go through the same guard,
    // so two timeouts inside the command make the model's download_data of that URL a refused repeat
    newRun();
    const call = () => refuses(t.get("newsroom_data_prepare").execute("a", { dataset: "hang_ds" }));
    const first = await call(), second = await call();
    const url = fetchCalls.find((u) => u.includes("hang_ds"));
    const third = await refuses(t.get("download_data").execute("c", { url, filename: "s.xml" }));
    return /DOWNLOAD_TIMEOUT/.test(first ?? "") && /DOWNLOAD_TIMEOUT/.test(second ?? "") && /DOWNLOAD_TIMEOUT_REPEAT/.test(third ?? "");
  },
  noQueryRecords: async (m, t) => {
    // the command must not start DuckDB at all (queryDuckDb writes query rows and computation records; duckDbRun is pinned to it):
    // a recorder stands in for the duckdb binary and leaves a marker if it is ever started
    const dir = newRun();
    const marker = join(tmp, `duckdb-started-${runNumber}`);
    const recorder = join(tmp, `duckdb-recorder-${runNumber}.sh`);
    writeFileSync(recorder, `#!/bin/sh\necho started >> '${marker}'\necho '[]'\n`, { mode: 0o755 });
    const before = process.env.NEWSROOM_DUCKDB_BIN;
    process.env.NEWSROOM_DUCKDB_BIN = recorder;
    try {
      await t.get("newsroom_data_prepare").execute("a", TS);
    } finally { if (before === undefined) delete process.env.NEWSROOM_DUCKDB_BIN; else process.env.NEWSROOM_DUCKDB_BIN = before; }
    return !existsSync(marker) && readdirSync(join(dir, "computations")).length === 0 && readdirSync(join(dir, "runtime/query-rows")).length === 0;
  },
  fileChanged: async (m, t) => {
    // a downloaded file that no longer matches its recorded sha256 is refused, not read
    const dir = newRun();
    const first = await t.get("newsroom_data_prepare").execute("a", TS);
    writeFileSync(join(dir, first.details.filePath), "tampered\n");
    const message = await refuses(t.get("newsroom_data_prepare").execute("b", TS));
    return /DATA_PREPARE_FILE_CHANGED/.test(message ?? "");
  },
  originOutsideData: async (m, t) => {
    // an origin record that points outside data/ is refused before the file is read
    const dir = newRun();
    const outside = join(dir, "..", `outside-${runNumber}.tsv`);
    writeFileSync(outside, "x\ty\n");
    mkdirSync(join(dir, "data/origins"), { recursive: true });
    const url = m.__dataPrepareForTest.providers.eurostat.catalog_url.value;
    writeFileSync(join(dir, "data/origins/forged.json"), JSON.stringify({ origin: "download", requested_url: url, file: `../outside-${runNumber}.tsv`, sha256: createHash("sha256").update("x\ty\n").digest("hex") }));
    const message = await refuses(t.get("newsroom_data_prepare").execute("a", { search: "energy" }));
    return /DATA_PREPARE_FILE_OUTSIDE/.test(message ?? "");
  },
  summaryCap: async (m, t) => {
    // a summary that would be longer than 6 KB is cut, the cut is stated, and the whole text including the note stays within 6 KB
    newRun();
    const many = Array.from({ length: 400 }, (_, i) => `zz${i}`);
    const out = text(await t.get("newsroom_data_prepare").execute("a", { dataset: "nrg_bal_c", filters: [{ dimension: "geo", values: many }], years: { start: 2020, end: 2020 } }));
    return Buffer.byteLength(out, "utf8") <= 6000 && /\[summary cut at 6 KB by the program\]$/.test(out);
  },
  noCodeListSkipped: async (m, t) => {
    // a dimension without a code list is skipped for word matching, the summary says which, and nothing is guessed for it
    newRun();
    const out = text(await t.get("newsroom_data_prepare").execute("a", { dataset: "toy_nocl", terms: ["Red"] }));
    const stated = /Not checked: dimension shape has no code list/.test(out) && /colour=X1/.test(out) === false;
    const pinned = await refuses(t.get("newsroom_data_prepare").execute("b", { dataset: "toy_nocl", filters: [{ dimension: "shape", values: ["B2"] }], years: { start: 2020, end: 2020 } }));
    return stated && /DATA_PREPARE_STRUCTURE.*shape has no code list/.test(pinned ?? "");
  },
  switchOffXml: async (m) => {
    // with the switch off the structure file is still stored as .data and the tool does not exist
    delete process.env.NEWSROOM_DATA_PREPARE;
    try {
      const off = registered(m);
      const dir = newRun();
      const url = "http://8.8.8.8/eurostat/api/dissemination/sdmx/2.1/datastructure/ESTAT/nrg_bal_c/latest";
      await off.get("download_data").execute("a", { url, filename: "s.xml" });
      return !off.has("newsroom_data_prepare") && readdirSync(join(dir, "data")).some((f) => f.endsWith(".data")) && !readdirSync(join(dir, "data")).some((f) => f.endsWith(".xml"));
    } finally { process.env.NEWSROOM_DATA_PREPARE = "1"; }
  },
  // sum_year (page build, new route): each series summed over its 12 months, no dimension summed across, a series missing a month left out
  // and named, nothing filled; the fetched file kept
  sumYear: async (m) => pageBuildOn(async () => {
    const dir = newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", MONTH_ASK("toy_month"));
    const s = out.details.sum_year;
    if (!s || s.year !== 2025 || s.series !== 8 || s.whole !== 7) return false;
    if (JSON.stringify(s.left_out) !== JSON.stringify([{ freq: "M", siec: "C0100", unit: "TJ", partner: "A2", geo: "FR", held: 11 }])) return false;
    const summed = readFileSync(join(dir, out.details.filePath), "utf8").trimEnd().split("\n");
    const want = ["freq,siec,unit,partner,geo,TIME_PERIOD,OBS_VALUE", ...MONTH_SERIES.map(([siec, partner, geo], i) => [siec, partner, geo, 1200 * (i + 1) + 79.2])
      .filter(([siec, partner, geo]) => `${siec}.${partner}.${geo}` !== "C0100.A2.FR").map(([siec, partner, geo, v]) => `M,${siec},TJ,${partner},${geo},2025,${Number(v).toFixed(1)}`).sort()];
    const record = JSON.parse(readFileSync(join(dir, s.record), "utf8"));
    return JSON.stringify([summed[0], ...summed.slice(1).sort()]) === JSON.stringify(want)
      && record.origin === "eurostat_sum_year" && record.inputs.file === s.fetched.filePath && existsSync(join(dir, s.fetched.filePath)) && s.fetched.rows === 159
      && /GROUP BY "freq", "siec", "unit", "partner", "geo", y/.test(record.sql) && /Write 2025 on the page/.test(text(out));
  }),
  // no year that 0.8 of the series hold whole: a stop that says so, with nothing summed or filled
  sumYearStops: async (m) => pageBuildOn(async () => {
    const dir = newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", MONTH_ASK("toy_thin"));
    return out.details.mode === "no_full_year" && out.details.sum_year.series === 8 && /\(series whole per year: 2025: 6\); nothing was filled in/.test(text(out))
      && readdirSync(join(dir, "data/origins")).every((f) => !readFileSync(join(dir, "data/origins", f), "utf8").includes("eurostat_sum_year"));
  }),
  // sum_year is the program's: a wrong n for the freq is refused before any fetch; the old route ignores it
  sumYearChecked: async (m) => pageBuildOn(async () => {
    newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", { ...MONTH_ASK("toy_month"), sum_year: { n: 4, share: 0.8 } });
    return out.details.mode === "unresolved" && /sum_year\.n 4 needs the one freq Q/.test(text(out)) && !fetchCalls.some((u) => u.includes("/data/"));
  }),
};
routes.push([/\/eurostat\/api\/dissemination\/sdmx\/2\.1\/datastructure\/ESTAT\/nrg_bal_c\/latest/, () => fixture("nrg_dsd.xml")]);
const runChecks = async (m, names = Object.keys(checks)) => {
  const t = registered(m);
  const failed = [];
  for (const name of names) { let good = false; try { good = await checks[name](m, t); } catch (error) { good = false; } if (!good) failed.push(name); }
  return failed;
};

// the real code passes every check
const failedReal = await runChecks(mod);
assert.deepEqual(failedReal, [], `real code fails: ${failedReal}`);
n += Object.keys(checks).length;

// ---- the walk a model takes, and what the summary holds --------------------------------------------------------------------------------
{
  const dir = newRun();
  const search = text(await prepare.execute("s", { search: "complete energy balances" }));
  ok(/nrg_bal_c: Complete energy balances/.test(search) && search.split("\n").filter((l) => l.startsWith("- ")).length <= 10, "2: search finds the dataset, at most 10 hits");
  const structure = text(await prepare.execute("d", { dataset: "nrg_bal_c" }));
  ok(/1\. freq/.test(structure) && /5\. geo \(code list GEO\)/.test(structure), "3: dimensions come out in key order with their code lists");
  const found = text(await prepare.execute("c", { dataset: "nrg_bal_c", filters: [{ dimension: "nrg_bal", values: ["gross inland"] }], years: { start: 2018, end: 2023 } }));
  ok(/GIC = Gross inland consumption/.test(found) && /nothing downloaded/.test(found), "4: an approximate word lists candidates and downloads nothing");
  ok(fetchCalls.every((u) => !u.includes("/data/nrg_bal_c/")), "5: no data request before every word is exact");
  const final = await prepare.execute("f", TS);
  const body = text(final);
  ok(Buffer.byteLength(body, "utf8") <= 6000, "6: summary is at most 6 KB");
  ok(/key A\.GIC\.TOTAL\.TJ\.DE, years 2018-2023/.test(body) && /downloaded 6 rows/.test(body), "7: key and row count are stated");
  ok(/nrg_bal=GIC/.test(body) && /geo=DE/.test(body), "8: adopted codes are listed");
  ok(!/^Starter SQL.*LAST UPDATE/m.test(body), "9: the starter SQL does not use the LAST UPDATE column");
  const sql = body.split("Starter SQL:\n")[1].split("\n")[0];
  ok(/^SELECT /.test(sql) && !/LAST UPDATE/.test(sql), "10: starter SQL is one SELECT");
  const file = final.details.filePath;
  ok(existsSync(join(dir, file)) && createHash("sha256").update(readFileSync(join(dir, file))).digest("hex") === final.details.sha256, "11: the data file is stored content-addressed");
  ok(file.endsWith(".csv"), "12: the data file keeps the csv extension");
  // the read-only check and DuckDB accept the starter SQL and return the rows
  const rows = await tools.get("duckdb_query").execute("q", { sql });
  ok(/OBS_VALUE/.test(text(rows)) && /13182628/.test(text(rows)), "13: duckdb_query runs the starter SQL and returns the rows");
  const rank = text(await prepare.execute("r", { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "nrg_bal", values: ["GIC"] }, { dimension: "siec", values: ["TOTAL"] }, { dimension: "unit", values: ["TJ"] }], years: { start: 2023, end: 2023 } }));
  ok(/key A\.GIC\.TOTAL\.TJ\., years 2023-2023/.test(rank) && /left empty \(all codes\): geo/.test(rank) && /downloaded 39 rows/.test(rank), "14: one empty dimension takes every code (ranking shape)");
  const open = text(await prepare.execute("o", { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2023, end: 2023 } }));
  ok(/leave at most one dimension empty/.test(open), "15: two or more empty dimensions are refused before any data request");
  const big = text(await prepare.execute("b", { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "siec", values: ["TOTAL"] }, { dimension: "unit", values: ["TJ"] }, { dimension: "geo", values: ["DE"] }], years: { start: 1000, end: 3000 } }));
  ok(/the request could reach about/.test(big), "16: a request whose row estimate is over the limit is refused");
  ok(!existsSync(join(dir, "boundary-refusals.jsonl")) && !readdirSync(dir).some((f) => /refus/i.test(f)), "17: no group refusal file with the group checks at their defaults");
}

// ---- the TS switch and the Rust --tools list are one rule: the tool exists only where download_data does, behind the same switch ----------
const RUST = readFileSync(join(ROOT, "src/pi.rs"), "utf8");
const linkProblems = (rust) => {
  const problems = [];
  const toolConst = /pub const DATA_PREPARE_TOOL: &str = "([^"]+)"/.exec(rust)?.[1];
  const envConst = /pub const DATA_PREPARE_ENV: &str = "([^"]+)"/.exec(rust)?.[1];
  if (toolConst !== "newsroom_data_prepare") problems.push(`rust tool name ${toolConst}`);
  if (envConst !== "NEWSROOM_DATA_PREPARE") problems.push(`rust env name ${envConst}`);
  if (!/if self\.speed\.data_prepare && names\.contains\(&"download_data"\) \{\s*names\.push\(DATA_PREPARE_TOOL\);/.test(rust)) problems.push("rust adds the tool without the download_data condition");
  if (!/data_prepare: exact_one\(DATA_PREPARE_ENV\)/.test(rust)) problems.push("rust switch is not exact_one");
  return problems;
};
{
  const groups = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
  ok(tools.has("newsroom_data_prepare") && groups.tools["newsroom_data_prepare"]?.group === "knowledge" && groups.tools["newsroom_data_prepare"]?.conditional === true, "18: the TS tool name is registered in groups.json as a conditional knowledge tool");
  ok(linkProblems(RUST).length === 0, `19: the Rust --tools list uses the same tool name and switch name as TS, only where download_data is: ${linkProblems(RUST)}`);
  ok(/NEWSROOM_DATA_PREPARE === "1"/.test(SOURCE), "20: TS reads the same switch name, exact 1");
  // the source table (prompt.rs) learns the handled providers by reading the top-level keys of DATA_PREPARE_PROVIDERS with the rule below; the same rule here must give the table's own keys
  const keysByRustRule = (text) => {
    const start = text.indexOf("const DATA_PREPARE_PROVIDERS");
    const names = [];
    for (const line of text.slice(start).split("\n").slice(1)) {
      if (line.startsWith("};")) break;
      const m = /^ {2}([A-Za-z0-9_]+): \{$/.exec(line);
      if (m) names.push(m[1]);
    }
    return names;
  };
  ok(JSON.stringify(keysByRustRule(SOURCE)) === JSON.stringify(Object.keys(mod.__dataPrepareForTest.providers)), "28: the provider names prompt.rs derives are the keys of the real provider table");
  const PROMPT_RS = readFileSync(join(ROOT, "src/prompt.rs"), "utf8");
  ok(PROMPT_RS.includes('line.starts_with("};")') && PROMPT_RS.includes('rest.strip_suffix(": {")') && PROMPT_RS.includes('strip_prefix("  ")'), "29: prompt.rs reads the provider keys with the rule this test mirrors");
  const swapped = SOURCE.replace("  eurostat: {", "  eurostat:{");
  ok(swapped !== SOURCE && JSON.stringify(keysByRustRule(swapped)) !== JSON.stringify(Object.keys(mod.__dataPrepareForTest.providers)), "30: a reformatted key line is noticed (the rule is exact)");
  for (const [name, patch] of [
    ["rust renames the tool", (r) => r.replace('"newsroom_data_prepare"', '"newsroom_data_prep"')],
    ["rust drops the download_data condition", (r) => r.replace('self.speed.data_prepare && names.contains(&"download_data")', "self.speed.data_prepare")],
    ["rust reads a different switch", (r) => r.replace('"NEWSROOM_DATA_PREPARE"', '"NEWSROOM_DATA_PREP"')],
    ["rust switch is not exact", (r) => r.replace("data_prepare: exact_one(DATA_PREPARE_ENV)", "data_prepare: std::env::var(DATA_PREPARE_ENV).is_ok()")],
  ]) {
    const mutated = patch(RUST);
    assert.notEqual(mutated, RUST, `link mutant anchor missing: ${name}`);
    ok(linkProblems(mutated).length > 0, `link mutant "${name}" must be caught`);
  }
}

// ---- units and names (K1692) ------------------------------------------------------------------------------------------------------------
// Returns the numbers of the failed checks, so the same list runs against mutated copies.
const unitNameChecks = async (m) => {
  const t = registered(m);
  const prep = t.get("newsroom_data_prepare");
  const failed = [];
  const ok2 = (cond, label) => { if (!cond) failed.push(label); };
  const dir = newRun();
  const dims = text(await prep.execute("u1", { dataset: "nrg_bal_c" }));
  ok2(/Units this dataset holds[^\n]*TJ = Terajoule/.test(dims) && /Units this dataset holds[^\n]*KTOE = Thousand tonnes/.test(dims) && !/Units this dataset holds[^\n]*EUR_TOE/.test(dims), "21");
  const wrong = await refuses(prep.execute("u2", { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "nrg_bal", values: ["GIC"] }, { dimension: "siec", values: ["TOTAL"] }, { dimension: "unit", values: ["TJ_NCV"] }, { dimension: "geo", values: ["DE"] }], years: { start: 2023, end: 2023 } }));
  ok2(wrong && /does not hold what was asked/.test(wrong) && /unit: TJ_NCV not held/.test(wrong) && /holds [^\n]*KTOE = Thousand tonnes/.test(wrong) && /holds [^\n]*TJ = Terajoule/.test(wrong) && !/EUR_TOE/.test(wrong), "22");
  const many = await prep.execute("u3", { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "nrg_bal", values: ["GIC"] }, { dimension: "siec", values: ["TOTAL"] }, { dimension: "geo", values: ["DE"] }], years: { start: 2023, end: 2023 } });
  const manyText = text(many);
  ok2(/Units: this file holds 2 units \(KTOE = Thousand tonnes.*TJ = Terajoule\); 1 combination\(s\)/.test(manyText) && /converts nothing/.test(manyText), "23");
  const sql = manyText.split("Starter SQL:\n")[1].split("\n")[0];
  ok2(/LEFT JOIN \(SELECT code, any_value\(name\) AS name FROM read_csv\('data\/[0-9a-f]{64}\.tsv', delim='\\t', quote=''/.test(sql) && /GROUP BY code\) AS n_unit/.test(sql) && /AS unit_name/.test(sql), "24");
  let named = ""; try { named = text(await t.get("duckdb_query").execute("q2", { sql })); } catch { /* the check below fails */ }
  ok2(/Terajoule/.test(named) && /Thousand tonnes/.test(named), "25");
  ok2(sha256OfFile(join(dir, many.details.filePath)) === many.details.sha256 && !/Terajoule/.test(readFileSync(join(dir, many.details.filePath), "utf8")), "26");
  // two datasets with different units in one run: the second answer says so
  routes.push([/\/datastructure\/ESTAT\/toy_unit\//, () => Buffer.from(TOY_XML([["unit", "CL_U"], ["geo", "CL_G"]]))]);
  routes.push([/\/codelist\/ESTAT\/CL_U\//, () => Buffer.from("MIO_M3\tMillion cubic metres\r\nTJ\tTerajoule\r\n")]);
  routes.push([/\/codelist\/ESTAT\/CL_G\//, () => Buffer.from("DE\tGermany\r\n")]);
  routes.push([/\/data\/toy_unit\/MIO_M3\.DE\?/, () => Buffer.from("DATAFLOW,unit,geo,TIME_PERIOD,OBS_VALUE\nT,MIO_M3,DE,2023,5\n")]);
  const dir2 = newRun();
  await prep.execute("v1", { dataset: "nrg_bal_c", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "nrg_bal", values: ["GIC"] }, { dimension: "siec", values: ["TOTAL"] }, { dimension: "unit", values: ["TJ"] }, { dimension: "geo", values: ["DE"] }], years: { start: 2023, end: 2023 } });
  const second = text(await prep.execute("v2", { dataset: "toy_unit", filters: [{ dimension: "unit", values: ["MIO_M3"] }, { dimension: "geo", values: ["DE"] }], years: { start: 2023, end: 2023 } }));
  ok2(/Units differ across datasets in this run: nrg_bal_c has TJ; toy_unit has MIO_M3\. Do not compare or add them/.test(second), "27");
  void dir2;
  // a code list that repeats a code must not multiply the rows
  routes.push([/\/datastructure\/ESTAT\/toy_dup\//, () => Buffer.from(TOY_XML([["unit", "CL_D"], ["geo", "CL_G"]]))]);
  routes.push([/\/codelist\/ESTAT\/CL_D\//, () => Buffer.from("MIO_M3\tMillion cubic metres\r\nTJ\tTerajoule\r\nTJ\tTerajoule again\r\n")]);
  routes.push([/\/data\/toy_dup\/\.DE\?/, () => Buffer.from("DATAFLOW,unit,geo,TIME_PERIOD,OBS_VALUE\nT,MIO_M3,DE,2023,5\nT,TJ,DE,2023,7\n")]);
  newRun();
  const dup = text(await prep.execute("v3", { dataset: "toy_dup", filters: [{ dimension: "geo", values: ["DE"] }], years: { start: 2023, end: 2023 } }));
  const dupSql = dup.split("Starter SQL:\n")[1].split("\n")[0];
  let dupRows = "";
  try { dupRows = text(await t.get("duckdb_query").execute("q3", { sql: dupSql })); } catch { /* the check below fails */ }
  ok2(/GROUP BY code/.test(dupSql) && (dupRows.match(/OBS_VALUE|\b[57]\b/g) ?? []).filter((x) => x !== "OBS_VALUE").length === 2, "31");
  return failed;
};
{
  const failed = await unitNameChecks(mod);
  assert.deepEqual(failed, [], `unit/name checks fail: ${failed}`);
  n += 8;
}

// ---- mutants ---------------------------------------------------------------------------------------------------------------------------
const mutants = [
  ["drops the not-evidence wording", swap("not evidence: it is not a recorded query", "it is not a recorded query"), "notEvidence"],
  ["adopts an approximate code", swap("return { adopted: null as string | null, nearby };", "return { adopted: nearby[0]?.code ?? null, nearby };"), "exactOnly"],
  ["drops the row check", swap("if (wanted && !wanted.includes(cell)) throw", "if (false) throw"), "rowCheck"],
  ["drops the header check", swap("if (index === undefined || index <= last) throw", "if (false) throw"), "headerCheck"],
  ["a provider field without a source", swap("max_rows: { value: 50000, source:", "max_rows: { value: 50000, source: \"\", was:"), "providerSources"],
  ["a topic word in the provider table", swap("time_dimension: { value: \"TIME_PERIOD\"", "topic: { value: \"energy\", source: \"x\" }, time_dimension: { value: \"TIME_PERIOD\""), "noTopicWords"],
  ["picks one dimension for a code valid in two", (text) => swap("exactIn.length === 1", "exactIn.length >= 1")(swap("exactIn.length > 1", "exactIn.length > 99")(text)), "ambiguity"],
  ["skips unknown structure elements", swap("if (!DATA_PREPARE_ELEMENTS.has(name)) throw new Error(", "if (false) throw new Error("), "unknownElement"],
  ["requests a URL again instead of reading the file", swap("origin?.origin !== \"download\" ||", "true ||"), "reusesDownloads"],
  ["bypasses the repeat guard", swap("if (!sourceAccessCircuit.isBlocked(requestHost)) downloadTimeoutGuard.assertNotRepeat(request);", "void 0;"), "repeatStaysRefused"],
  ["builds repeat state anew on every call", swap("downloadTimeoutGuard.assertNotRepeat(request);", "createDownloadTimeoutGuard(DOWNLOAD_TIMEOUT_MS).assertNotRepeat(request);"), "repeatStaysRefused"],
  ["calls queryDuckDb from the command", swap("const provider = String(params.provider ?? \"eurostat\");", "await queryDuckDb(\"select 1\"); const provider = String(params.provider ?? \"eurostat\");"), "noQueryRecords"],
  ["trusts a changed data file", swap("if (sha256Hex(bytes) !== origin.sha256) throw", "if (false) throw"), "fileChanged"],
  ["reads an origin file outside data/", swap("if (!full.startsWith(resolve(root, \"data\") + sep)) throw", "if (false) throw"), "originOutsideData"],
  ["does not cut a long summary", swap("text = Buffer.from(text, \"utf8\").subarray(0, room)", "text = Buffer.from(text, \"utf8\").subarray(0, 1e9)"), "summaryCap"],
  ["lets the cut note push the summary over 6 KB", swap("const room = DATA_PREPARE_SUMMARY_BYTES - Buffer.byteLength(cutNote, \"utf8\");", "const room = DATA_PREPARE_SUMMARY_BYTES;"), "summaryCap"],
  ["fails on a dimension without a code list instead of skipping it", swap("if (!dimension.codelist) {\n        const note", "if (false) {\n        const note"), "noCodeListSkipped"],
  ["skips a dimension without a code list silently", swap("if (!notes.includes(note)) notes.push(note);", ""), "noCodeListSkipped"],
  ["allows xml with the switch off", swap("...(dataPrepareEnabled() ? [\"xml\"] : [])", "\"xml\""), "switchOffXml"],
  ["sums a summed year across a dimension", swap("const sql = sumYearSql(data.relativeFile, keys,", "const sql = sumYearSql(data.relativeFile, keys.filter((k) => k !== \"partner\"),"), "sumYear"],
  ["keeps a series missing a month", swap("HAVING COUNT(DISTINCT t) = ${n} AND COUNT(*) = ${n}), `\n    + `pick", "), `\n    + `pick"), "sumYear"],
  ["sums a summed year in floating point", swap("CAST(${q(value)} AS DECIMAL(38, 10))", "CAST(${q(value)} AS DOUBLE)"), "sumYear"],
  ["picks a year fewer than the share hold whole", swap("WHERE c >= ${share} * (SELECT", "WHERE c >= 0 * (SELECT"), "sumYearStops"],
  ["takes any n for the freq", swap("freq?.length !== 1 || freq[0] !== SUM_YEAR_PERIODS[String(sumYear.n)] ?", "false ?"), "sumYearChecked"],
];
const unitMutants = [
  ["drops the held-units line", swap("Units this dataset holds (read from the dataset itself", "Units (read from the dataset itself"), "21"],
  ["drops the held-codes hint from a refused request", swap("does not hold what was asked", "refused"), "22"],
  ["drops the several-units note", swap("Units: this file holds", "File holds"), "23"],
  ["drops the name join from the starter SQL", swap("LEFT JOIN (SELECT code, any_value(name) AS name FROM read_csv(", "LEFT JOIN (SELECT 1 AS code, 1 AS name) AS skip_ -- read_csv("), "24"],
  ["joins the code list without removing repeated codes", swap("SELECT code, any_value(name) AS name FROM read_csv(", "SELECT code, name FROM read_csv("), "31"],
  ["drops the cross-dataset unit note", swap("Units differ across datasets in this run", "Units"), "27"],
];
for (const [name, patch, check] of unitMutants) {
  const failed = await unitNameChecks(await load(patch));
  ok(failed.includes(check), `mutant "${name}" must turn unit check ${check} red`);
}
for (const [name, patch, check] of mutants) {
  const failed = await runChecks(await load(patch), [check]);
  ok(failed.includes(check), `mutant "${name}" must turn ${check} red`);
}

console.log(`PASS test_data_prepare: ${n} checks, ${mutants.length + unitMutants.length} mutants went red`);
