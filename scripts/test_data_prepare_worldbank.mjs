// NEWSROOM_NEXT=1 (exact "1", default off): newsroom_data_prepare with provider=worldbank, offline. The country list and two indicator answers
// are real World Bank answers saved unchanged under scripts/fixtures/data_prepare/worldbank (SOURCE.json holds their URLs and sha256); fetch is a
// stub. The provider host is swapped for a literal IP in the test copy only, so no DNS lookup happens. Each mutant patches the copy's source text
// and must turn exactly the check that guards that rule red.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "scripts/fixtures/data_prepare/worldbank");
const fixture = (name) => readFileSync(join(FX, name));
const SOURCE_FILES = JSON.parse(readFileSync(join(FX, "SOURCE.json"), "utf8")).files;
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const tmp = mkdtempSync(join(tmpdir(), "data-prepare-wb-"));
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
const HOST = "https://api.worldbank.org";
const IP = "http://8.8.8.8";
const swap = (from, to) => (text) => { assert.ok(text.includes(from), `mutant anchor missing: ${from}`); return text.split(from).join(to); };
let variant = 0;
const load = async (patch = (text) => text) => {
  const file = join(piDir, `newsroom.wb-test-copy-${variant++}.mjs`);
  writeFileSync(file, stripTypeScriptTypes(patch(SOURCE).split(HOST).join(IP), { mode: "strip" }));
  return import(file);
};

// ---- stubbed network: the saved answers, served by their recorded URL (host swapped) -------------------------------------------------------
const REFUSED = Buffer.from('[{"message":[{"id":"120","key":"Invalid value","value":"The provided parameter value is not valid"}]}]');
const routes = new Map(Object.entries(SOURCE_FILES).map(([name, entry]) => [entry.url.split(HOST).join(IP), () => fixture(name)]));
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const bytes = routes.get(String(url))?.() ?? (/\/indicator\/NO\.SUCH\.CODE\?/.test(String(url)) ? REFUSED : null);
  if (!bytes) return new Response("nope", { status: 404 });
  const res = new Response(bytes, { status: 200, headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  Object.defineProperty(res, "url", { value: String(url) });
  return res;
};
let runNumber = 0;
const newRun = () => {
  const dir = join(tmp, `run-${runNumber++}`);
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(dir, d), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  fetchCalls = [];
  return dir;
};
const registered = (mod) => { const tools = new Map(); mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) })); return tools; };
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (out) => out.content.map((c) => c.text).join("\n");
const refuses = async (promise) => { try { await promise; return null; } catch (error) { return String(error?.message ?? error); } };
const csvRows = (dir, file) => readFileSync(join(dir, file), "utf8").trimEnd().split("\n").map((line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, 5));
const originOf = (dir, file) => readdirSync(join(dir, "data/origins")).map((name) => ({ name, record: JSON.parse(readFileSync(join(dir, "data/origins", name), "utf8")) })).find((item) => item.record.file === file);
const Q4 = { provider: "worldbank", dataset: "EN.GHG.CO2.PC.CE.AR5", filters: [{ dimension: "country", values: ["IND", "CHN", "USA", "IDN", "PAK", "NGA", "BRA", "BGD", "RUS", "ETH"] }], years: { start: 2014, end: 2024 } };
const Q5 = { provider: "worldbank", dataset: "SP.POP.65UP.TO.ZS", years: { start: 2015, end: 2025 } };
const INCOME_GROUPS = ["XD", "XM", "XN", "XT", "XY"];
const TOPIC_WORDS = ["energy", "gas", "oil", "coal", "population", "trade", "health", "climate", "wage", "inflation", "carbon", "emissions", "aged", "能源", "人口", "贸易"];
process.env.NEWSROOM_DATA_PREPARE = "1";
delete process.env.NEWSROOM_DOWNLOAD_FROZEN;

// ---- the checks every mutant is run against; each returns true when the rule holds -------------------------------------------------------
const checks = {
  // switch off: the old refusal word for word, nothing requested
  offRefusal: async (m) => {
    delete process.env.NEWSROOM_NEXT;
    newRun();
    const message = await refuses(registered(m).get("newsroom_data_prepare").execute("a", Q4));
    return message === "DATA_PREPARE_PROVIDER: unknown provider worldbank; known: eurostat" && fetchCalls.length === 0;
  },
  // the prompt's provider list is read from the first DATA_PREPARE_PROVIDERS table up to its "};" (src/prompt.rs data_prepare_providers)
  promptKeys: async () => {
    const start = SOURCE.indexOf("const DATA_PREPARE_PROVIDERS");
    const keys = [];
    for (const line of SOURCE.slice(start).split("\n").slice(1)) { if (line.startsWith("};")) break; const name = line.match(/^  ([A-Za-z0-9_]+): \{$/)?.[1]; if (name) keys.push(name); }
    return JSON.stringify(keys) === '["eurostat"]';
  },
  nextSources: async (m) => Object.values(m.__dataPrepareForTest.providersNext).every((fields) => Object.values(fields).every((f) => typeof f.source === "string" && f.source.length > 0)),
  nextNoTopicWords: async (m) => JSON.stringify(m.__dataPrepareForTest.providersNext).toLowerCase().split(/[^a-z一-鿿]+/).every((w) => !TOPIC_WORDS.includes(w)),
  // q4: the measured URL, 110 rows, the CSV and its conversion record bound to both downloaded files
  q4: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    const dir = newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", Q4);
    const d = out.details;
    const rows = csvRows(dir, d.filePath);
    const origin = originOf(dir, d.filePath);
    return fetchCalls.includes(SOURCE_FILES["q4.json"].url.split(HOST).join(IP))
      && d.rows === 110 && rows.length === 111 && rows[0].join(",") === "country,country_name,region,date,value"
      && sha256Of(readFileSync(join(dir, d.filePath))) === d.sha256
      && origin && origin.name === `${sha256Of(JSON.stringify(origin.record))}.json`
      && origin.record.origin === "worldbank_json_conversion" && origin.record.source_sha256 === SOURCE_FILES["q4.json"].sha256 && origin.record.country_list_sha256 === SOURCE_FILES["countries.json"].sha256
      && origin.record.series_title.length > 0 && /^Program-measured data preparation \(not evidence/.test(text(out));
  },
  // q5: the income groups (no countryiso3code) still get the list's code and region, so they sit with the aggregates; 217 members, 49 aggregates
  q5Places: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    const dir = newRun();
    const d = (await registered(m).get("newsroom_data_prepare").execute("a", Q5)).details;
    const list = JSON.parse(fixture("countries.json"))[1];
    const income = new Set(list.filter((e) => INCOME_GROUPS.includes(e.iso2Code)).map((e) => e.id));
    const rows = csvRows(dir, d.filePath).slice(1);
    const places = new Map(rows.map((row) => [row[0], row[2]]));
    const removed = originOf(dir, d.filePath).record.removed_without_value.map((item) => item.split(" ")[0]);
    for (const code of removed) if (!places.has(code)) places.set(code, list.find((e) => e.id === code)?.region?.value);
    const members = [...places.values()].filter((region) => region !== "Aggregates").length;
    const aggregates = [...places.values()].filter((region) => region === "Aggregates").length;
    return income.size === 5 && [...income].every((code) => places.get(code) === "Aggregates") && members === 217 && aggregates === 49 && d.unmatched.length === 0;
  },
  // q5: the 11 rows without a value are left out and named, not kept as empty rows
  q5Removed: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    const dir = newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", Q5);
    const rows = csvRows(dir, out.details.filePath).slice(1);
    return out.details.rows === 2926 - 11 && rows.length === 2915 && rows.every((row) => row[4] !== "" && Number.isFinite(Number(row[4])))
      && out.details.removedWithoutValue === 1 && /Left out 11 rows without a value: /.test(text(out));
  },
  // a second identical call reads both files from the run and writes the same CSV
  reuse: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    newRun();
    const tool = registered(m).get("newsroom_data_prepare");
    const first = (await tool.execute("a", Q4)).details;
    const calls = fetchCalls.length;
    const second = (await tool.execute("b", Q4)).details;
    return calls === 2 && fetchCalls.length === 2 && first.filePath === second.filePath && first.sha256 === second.sha256;
  },
  // a word that is not exactly a code or name downloads nothing and lists nearby
  exactOnly: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", { ...Q4, filters: [{ dimension: "country", values: ["Indi"] }] });
    return out.details.mode === "unresolved" && /IND = India/.test(text(out)) && !fetchCalls.some((u) => u.includes("/indicator/"));
  },
  refusedAnswer: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    newRun();
    const message = await refuses(registered(m).get("newsroom_data_prepare").execute("a", { ...Q4, dataset: "NO.SUCH.CODE" }));
    return /^DATA_PREPARE_WORLDBANK_ANSWER: .* was refused: Invalid value/.test(message ?? "");
  },
  // page build: the program's candidates come out of the CSV (one place dimension, date, value), so q4 reaches the sheet
  pageBuild: async (m) => {
    process.env.NEWSROOM_NEXT = "1";
    process.env.NEWSROOM_SPEED_PAGE_BUILD = "1";
    process.env.NEWSROOM_AGENT = "rust";
    try {
      newRun();
      const out = await registered(m).get("newsroom_data_prepare").execute("a", Q4);
      return out.details.mode === "candidates" && out.details.conclusions >= 3 && /^c1: /m.test(text(out));
    } finally { delete process.env.NEWSROOM_SPEED_PAGE_BUILD; delete process.env.NEWSROOM_AGENT; }
  },
};
const runChecks = async (m, only = Object.keys(checks)) => {
  const failed = [];
  for (const name of only) { let held = false; try { held = await checks[name](m); } catch (error) { if (process.env.WB_DEBUG) console.error(name, error); held = false; } if (!held) failed.push(name); }
  return failed;
};

const mod = await load();
const failed = await runChecks(mod);
for (const name of Object.keys(checks)) ok(!failed.includes(name), `check ${name} holds on the real source`);

const mutants = [
  ["switch off still reads the new table", swap("const nextProvider = nextRouteEnabled() && ", "const nextProvider = "), "offRefusal"],
  ["matches places by countryiso3code, else country.id, against the three-letter id", swap("const place = byIso2.get(String(row?.country?.id ?? \"\"));", "const place = places.find((item) => item.id === (row?.countryiso3code || row?.country?.id));"), "q5Places"],
  ["keeps rows without a value as empty cells", swap("if (value === null) { withoutValue.set(", "if (value === null) { lines.push([place.id, quote(place.name), quote(place.region), year, \"\"].join(\",\")); withoutValue.set("), "q5Removed"],
  ["drops the conversion record", swap("await writeArtifactIfAbsent(originPath, origin);", ""), "q4"],
  ["hands the page build the downloaded JSON instead of the CSV", swap("ref: csv.relativeFile, qualifiers: []", "ref: data.relativeFile, qualifiers: []"), "pageBuild"],
  ["adopts a near word", swap("if (result.adopted) adopted.push(result.adopted);", "if (result.adopted || result.nearby[0]) adopted.push(result.adopted ?? result.nearby[0].code);"), "exactOnly"],
];
for (const [name, patch, check] of mutants) {
  const red = await runChecks(await load(patch), [check]);
  ok(red.includes(check), `mutant "${name}" must turn ${check} red`);
}

console.log(`PASS test_data_prepare_worldbank: ${n} checks, ${mutants.length} mutants went red`);
