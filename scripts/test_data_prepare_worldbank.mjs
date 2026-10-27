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
// The narrow's reference tables were saved for 2016-2025; Q5 asks 2015-2025, so the test serves the same answer for that URL (as if 2015 had no rows yet).
// SYNTH is invented, not a World Bank answer: 10 economies with a value in 2024 and 2 in 2025, for the rank-year and no-shared-year rules.
const wide = (name, code) => [`${IP}/v2/country/all/indicator/${code}?format=json&date=2015:2025&per_page=20000`, () => fixture(name)];
const SYNTH_ECONOMIES = JSON.parse(fixture("countries.json"))[1].filter((e) => e.region.value !== "Aggregates").slice(0, 10);
const synthRow = (e, date, value) => ({ indicator: { id: "XX.SYNTH", value: "Invented test series" }, country: { id: e.iso2Code, value: e.name }, countryiso3code: e.id, date, value, unit: "", obs_status: "", decimal: 1 });
const SYNTH = Buffer.from(JSON.stringify([{ page: 1, pages: 1, per_page: 20000, total: 12 }, [...SYNTH_ECONOMIES.map((e, i) => synthRow(e, "2024", 10 + i)), ...SYNTH_ECONOMIES.slice(0, 2).map((e, i) => synthRow(e, "2025", 50 - i))]]));
routes.set(...wide("pop.json", "SP.POP.TOTL"));
routes.set(...wide("gdp.json", "NY.GDP.MKTP.CD"));
routes.set(`${IP}/v2/country/all/indicator/XX.SYNTH15?format=json&date=2015:2025&per_page=20000`, () => Buffer.from(JSON.stringify([{ page: 1, pages: 1, per_page: 20000, total: 10 }, SYNTH_ECONOMIES.map((e, i) => ({ ...synthRow(e, "2015", 10 + i), indicator: { id: "XX.SYNTH15", value: "Invented test series" } }))])));
routes.set(`${IP}/v2/country/all/indicator/XX.SYNTH?format=json&date=2015:2025&per_page=20000`, () => SYNTH);
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
// ---- narrow (page build, new route): every country fetched, then only the registered option's economies kept -------------------------------
const pageBuildOn = async (fn) => {
  process.env.NEWSROOM_NEXT = "1";
  process.env.NEWSROOM_SPEED_PAGE_BUILD = "1";
  process.env.NEWSROOM_AGENT = "rust";
  try { return await fn(); } finally { delete process.env.NEWSROOM_SPEED_PAGE_BUILD; delete process.env.NEWSROOM_AGENT; }
};
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "runtime/pi/assets/wb-rank-by.json"), "utf8"));
const narrowed = (m, args, narrow) => pageBuildOn(async () => {
  const dir = newRun();
  const out = await registered(m).get("newsroom_data_prepare").execute("a", { ...args, narrow: { dimension: "country", n: 8, exclude: [], ...narrow } });
  const d = out.details;
  const record = d.narrow ? originOf(dir, d.filePath) : undefined;
  return { dir, out, d, record: record?.record, recordName: record?.name, rows: d.filePath ? csvRows(dir, d.filePath).slice(1) : [] };
});
const regionOf = new Map(JSON.parse(fixture("countries.json"))[1].map((e) => [e.id, e.region.value]));
const holdsRecord = ({ dir, d, record, recordName, rows }, members, at) => record && recordName === `${sha256Of(JSON.stringify(record))}.json` && record.origin === "worldbank_narrow"
  && JSON.stringify(record.members) === JSON.stringify(members) && record.at === at && d.narrow.record === `data/origins/${recordName}`
  && sha256Of(readFileSync(join(dir, record.file))) === record.sha256 && record.file === d.filePath
  && sha256Of(readFileSync(join(dir, record.inputs.full.file))) === record.inputs.full.sha256 && csvRows(dir, record.inputs.full.file).length > rows.length
  && new Set(rows.map((row) => row[0])).size === members.length && rows.every((row) => members.includes(row[0]))
  && record.left_out.every((id) => !members.includes(id) && regionOf.get(id) !== "Aggregates");
const scoped = ({ out }, prefix) => out.details.mode === "candidates" && out.details.conclusions >= 3
  && text(out).split("\n").filter((line) => /^c\d+: /.test(line)).every((line) => line.replace(/^c\d+: /, "").startsWith(prefix));
const prefixOf = (key) => REGISTRY.options.find((o) => o.key === key).prefix;
Object.assign(checks, {
  // q5 by its own value: the 8 highest at 2025 (217 of 217), every year up to 2025 kept, the record bound to both files, the candidates scoped and with no sum kind
  narrowTop: async (m) => {
    const r = await narrowed(m, Q5, { rule: "top" });
    const members = ["MCO", "JPN", "PRI", "ITA", "PRT", "GRC", "FIN", "DEU"];
    return holdsRecord(r, members, "2025") && r.record.with_value === 217 && r.record.of === 217 && r.rows.length === csvRows(r.dir, r.record.inputs.full.file).filter((row) => members.includes(row[0])).length
      && scoped(r, prefixOf("top")) && !/share of the total|total value changed/i.test(text(r.out)) && /Narrowed country by the program: the 8 economies/.test(text(r.out));
  },
  narrowBottom: async (m) => holdsRecord(await narrowed(m, Q5, { rule: "bottom" }), ["QAT", "ARE", "ZMB", "TCD", "CAF", "UGA", "MLI", "AFG"], "2025"),
  // by population: the reference fetched for every place and the same years, its own CSV and conversion record, its sha in the narrow record
  narrowByPop: async (m) => {
    const r = await narrowed(m, Q5, { rule: "top", by: "SP.POP.TOTL" });
    const by = r.record?.inputs?.by;
    return holdsRecord(r, ["IND", "CHN", "USA", "IDN", "PAK", "NGA", "BRA", "BGD"], "2025") && by && sha256Of(readFileSync(join(r.dir, by.file))) === by.sha256
      && originOf(r.dir, by.file)?.record.source_sha256 === SOURCE_FILES["pop.json"].sha256 && scoped(r, prefixOf("SP.POP.TOTL"));
  },
  // by GDP: the aggregates (World, High income ...) top the raw answer; none is ranked
  narrowByGdp: async (m) => holdsRecord(await narrowed(m, Q5, { rule: "top", by: "NY.GDP.MKTP.CD" }), ["USA", "CHN", "DEU", "JPN", "GBR", "IND", "FRA", "RUS"], "2025"),
  // the rank year is the latest year most economies have (2024: 10 of 10), not a year only 2 have (2025)
  narrowYear: async (m) => {
    const r = await narrowed(m, { ...Q5, dataset: "XX.SYNTH" }, { rule: "top", n: 3 });
    return holdsRecord(r, SYNTH_ECONOMIES.slice(7).map((e) => e.id).reverse(), "2024") && r.record.with_value === 10 && r.record.of === 10;
  },
  // the narrowed file stops at the rank year: the 2 members with a 2025 value keep only their 2024 row, so no claim reads 2025 over 2 economies
  narrowStopsAtRankYear: async (m) => {
    const r = await narrowed(m, { ...Q5, dataset: "XX.SYNTH" }, { rule: "bottom", n: 3 });
    const members = SYNTH_ECONOMIES.slice(0, 3).map((e) => e.id);
    const later = csvRows(r.dir, r.record.inputs.full.file).filter((row) => members.includes(row[0]) && row[3] === "2025");
    return holdsRecord(r, members, "2024") && r.rows.length === 3 && r.rows.every((row) => row[3] === "2024") && later.length === 2
      && r.record.rows_after_at === 2 && /years up to 2024 only \(2 later rows left out\)/.test(text(r.out));
  },
  // no year both tables have a value in: refused, both files named, nothing ranked
  narrowNoSharedYear: async (m) => {
    const r = await narrowed(m, { ...Q5, dataset: "XX.SYNTH15" }, { rule: "top", by: "SP.POP.TOTL" });
    return r.d.mode === "needs_narrowing" && !r.d.narrow && /Not narrowed: no year in data\/\S+\.csv and data\/\S+\.csv has a value/.test(text(r.out));
  },
  // every value outside the registry is refused before any indicator is fetched, with the allowed values and one example
  narrowRefused: async (m) => {
    const bad = [{ rule: "middle" }, { rule: "top", by: "SP.URB.TOTL" }, { rule: "bottom", by: "SP.POP.TOTL" }, { rule: "top", n: 0 }, { rule: "top", n: 9 }, { rule: "top", n: 2.5 },
      { rule: "top", exclude: ["WLD"] }, { rule: "top", dimension: "geo" }, { rule: "top", total: "WLD" }];
    for (const narrow of bad) {
      const r = await narrowed(m, Q5, narrow);
      if (r.d.mode !== "unresolved" || !/Example: narrow=\{dimension: "country", rule: "top", by: "SP.POP.TOTL"/.test(text(r.out)) || fetchCalls.some((u) => u.includes("/indicator/"))) return false;
    }
    const filtered = await narrowed(m, Q4, { rule: "top" });
    return filtered.d.mode === "unresolved" && /takes no country filter/.test(text(filtered.out)) && !fetchCalls.some((u) => u.includes("/indicator/"));
  },
});

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
mutants.push(
  ["ranks the aggregates too", swap('places.filter((place) => place.region !== "Aggregates")', "places"), "narrowByGdp"],
  ["ranks bottom as top", swap('option.rule === "bottom" ? 1 : -1', "-1"), "narrowBottom"],
  ["takes the latest year any economy has", swap("holding(year).length >= registry.year_share * counted.length", "true"), "narrowYear"],
  ["keeps the members' years after the rank year", swap("Number(row.year) <= Number(at)", "true"), "narrowStopsAtRankYear"],
  ["keeps every country in the narrowed file", swap(".filter((row) => keep.has(row.id))", ""), "narrowTop"],
  ["writes no narrow record", swap("const recordPath = await writeOrigin(record);", 'const recordPath = "data/origins/none.json";'), "narrowTop"],
  ["hands the candidates no scope", swap("scope: { prefix: option.prefix } });", "});"), "narrowTop"],
  ["takes an unregistered by", swap(": !option ? `narrow.rule", ": false ? `narrow.rule"), "narrowRefused"],
  ["takes a country filter with narrow", swap(": Array.isArray(params.filters) && params.filters.length ?", ": false ?"), "narrowRefused"],
);
for (const [name, patch, check] of mutants) {
  const red = await runChecks(await load(patch), [check]);
  ok(red.includes(check), `mutant "${name}" must turn ${check} red`);
}

console.log(`PASS test_data_prepare_worldbank: ${n} checks, ${mutants.length} mutants went red`);
