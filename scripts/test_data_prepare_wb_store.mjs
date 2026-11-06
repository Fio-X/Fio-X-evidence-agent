// NEWSROOM_NEXT=1 with NEWSROOM_WB_STORE: newsroom_data_prepare reads a World Bank indicator from the local store, offline. The store is built
// here from the real answers saved under scripts/fixtures/data_prepare/worldbank (as the store's own writer keeps them: rows with a value,
// values as given); fetch is a stub serving the same answers. The rule held: the CSV the page reads has the same rows whether the indicator
// came from the store or from the provider; a copy that is missing, stale or changed is fetched whole again and written back; the run keeps
// the store file it read. Each mutant patches the copy's source text and must turn exactly the check that guards that rule red.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "scripts/fixtures/data_prepare/worldbank");
const fixture = (name) => readFileSync(join(FX, name));
const SOURCE_FILES = JSON.parse(readFileSync(join(FX, "SOURCE.json"), "utf8")).files;
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const tmp = mkdtempSync(join(tmpdir(), "data-prepare-wb-store-"));
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
  const file = join(piDir, `newsroom.wb-store-test-copy-${variant++}.mjs`);
  writeFileSync(file, stripTypeScriptTypes(patch(SOURCE).split(HOST).join(IP), { mode: "strip" }));
  return import(file);
};

// ---- stubbed network: the saved answers by their recorded URL, and the same answers for the store's whole-indicator URL ------------------
const whole = (code) => `${IP}/v2/country/all/indicator/${code}?format=json&per_page=20000&date=1960:2025`;
const routes = new Map(Object.entries(SOURCE_FILES).map(([name, entry]) => [entry.url.split(HOST).join(IP), () => fixture(name)]));
routes.set(`${IP}/v2/country/all/indicator/SP.POP.TOTL?format=json&date=2015:2025&per_page=20000`, () => fixture("pop.json"));
for (const [code, name] of [["SP.POP.65UP.TO.ZS", "q5.json"], ["EN.GHG.CO2.PC.CE.AR5", "q4.json"], ["SP.POP.TOTL", "pop.json"]]) routes.set(whole(code), () => fixture(name));
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const bytes = routes.get(String(url))?.();
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
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAN = "indicator\tdownloaded_at\trows\tsha256\twb_lastupdated\n";
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
// A store as the store's writer leaves it: one gzip per indicator (rows with a value), the country list unchanged, one manifest line each.
let storeNumber = 0;
const makeStore = (entries, { daysAgo = 1, list = true } = {}) => {
  const dir = join(tmp, `store-${storeNumber++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  let manifest = MAN;
  for (const [code, name] of entries) {
    const rows = JSON.parse(fixture(name))[1].filter((o) => o.value !== null);
    const text = "indicator\tcountry_id\tiso3\tyear\tvalue\tobs_status\n" + rows.map((o) => [code, o.country.id, o.countryiso3code || "", o.date, typeof o.value === "number" && !Number.isInteger(o.value) ? String(o.value) : String(o.value), o.obs_status || ""].join("\t") + "\n").join("");
    const gz = gzipSync(Buffer.from(text));
    writeFileSync(join(dir, "data", `${code}.tsv.gz`), gz);
    manifest += [code, iso(daysAgo), rows.length, sha256Of(gz), "2026-10-08"].join("\t") + "\n";
  }
  if (list) {
    writeFileSync(join(dir, "country-list.json"), fixture("countries.json"));
    manifest += ["_country_list", iso(daysAgo), JSON.parse(fixture("countries.json"))[1].length, sha256Of(fixture("countries.json")), ""].join("\t") + "\n";
  }
  writeFileSync(join(dir, "manifest.tsv"), manifest);
  return dir;
};
const registered = (mod) => { const tools = new Map(); mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) })); return tools; };
const text = (out) => out.content.map((c) => c.text).join("\n");
const csvLines = (dir, file) => readFileSync(join(dir, file), "utf8").trimEnd().split("\n");
const originOf = (dir, file) => readdirSync(join(dir, "data/origins")).map((name) => JSON.parse(readFileSync(join(dir, "data/origins", name), "utf8"))).find((record) => record.file === file && record.origin !== "worldbank_narrow");
const Q4 = { provider: "worldbank", dataset: "EN.GHG.CO2.PC.CE.AR5", filters: [{ dimension: "country", values: ["IND", "CHN", "USA", "IDN", "PAK", "NGA", "BRA", "BGD", "RUS", "ETH"] }], years: { start: 2014, end: 2024 } };
const Q5 = { provider: "worldbank", dataset: "SP.POP.65UP.TO.ZS", years: { start: 2015, end: 2025 } };
process.env.NEWSROOM_DATA_PREPARE = "1";
delete process.env.NEWSROOM_DOWNLOAD_FROZEN;
const prepare = async (m, args, store) => {
  process.env.NEWSROOM_NEXT = "1";
  if (store) process.env.NEWSROOM_WB_STORE = store; else delete process.env.NEWSROOM_WB_STORE;
  try {
    const dir = newRun();
    const out = await registered(m).get("newsroom_data_prepare").execute("a", args);
    return { dir, out, d: out.details, calls: [...fetchCalls] };
  } finally { delete process.env.NEWSROOM_WB_STORE; }
};
const sameRows = (a, b) => JSON.stringify(csvLines(a.dir, a.d.filePath).slice(1).sort()) === JSON.stringify(csvLines(b.dir, b.d.filePath).slice(1).sort())
  && csvLines(a.dir, a.d.filePath)[0] === csvLines(b.dir, b.d.filePath)[0];
const noIndicatorFetch = (r) => !r.calls.some((u) => u.includes("/indicator/")) && !r.calls.some((u) => u.includes("/v2/country?"));

// ---- the checks every mutant is run against; each returns true when the rule holds -------------------------------------------------------
const checks = {
  // q4 (ten places asked, 2014-2024): the store's rows give the same CSV rows as the provider's answer, with nothing requested
  q4Same: async (m) => {
    const online = await prepare(m, Q4);
    const local = await prepare(m, Q4, makeStore([["EN.GHG.CO2.PC.CE.AR5", "q4.json"]]));
    return local.d.mode === "data" && local.d.rows === online.d.rows && sameRows(online, local) && noIndicatorFetch(local);
  },
  // q5 (every place): same rows; the run keeps the store file it read (by the manifest's sha256) and its record; the conversion's URL is the provider's
  q5Same: async (m) => {
    const store = makeStore([["SP.POP.65UP.TO.ZS", "q5.json"]]);
    const online = await prepare(m, Q5);
    const local = await prepare(m, Q5, store);
    const conversion = originOf(local.dir, local.d.filePath);
    const manifestSha = readFileSync(join(store, "manifest.tsv"), "utf8").split("\n").find((l) => l.startsWith("SP.POP.65UP.TO.ZS\t")).split("\t")[3];
    const copy = originOf(local.dir, conversion.source_file);
    return local.d.rows === online.d.rows && sameRows(online, local) && noIndicatorFetch(local)
      && conversion.source_sha256 === manifestSha && sha256Of(readFileSync(join(local.dir, conversion.source_file))) === manifestSha
      && copy?.origin === "worldbank_local_copy" && copy.requested_url.startsWith(`${IP}/v2/country/all/indicator/SP.POP.65UP.TO.ZS?`)
      && new URL(conversion.requested_url).host === new URL(IP).host && conversion.local_copy?.downloaded_at && conversion.series_title === "Population ages 65 and above (% of total population)"
      && /rows from the local copy downloaded /.test(text(local.out));
  },
  // a year outside the request is never kept from the whole copy
  yearsCut: async (m) => {
    const local = await prepare(m, { ...Q5, years: { start: 2020, end: 2022 } }, makeStore([["SP.POP.65UP.TO.ZS", "q5.json"]]));
    const years = new Set(csvLines(local.dir, local.d.filePath).slice(1).map((l) => l.split(",").at(-2)));
    return local.d.mode === "data" && [...years].sort().join() === "2020,2021,2022";
  },
  // a place not asked is never kept from the whole copy
  placesCut: async (m) => {
    const local = await prepare(m, { ...Q5, filters: [{ dimension: "country", values: ["JPN", "DEU"] }] }, makeStore([["SP.POP.65UP.TO.ZS", "q5.json"]]));
    const codes = new Set(csvLines(local.dir, local.d.filePath).slice(1).map((l) => l.split(",")[0]));
    return local.d.mode === "data" && [...codes].sort().join() === "DEU,JPN" && local.d.rows === 22;
  },
  // an empty store: the whole indicator and the country list are fetched once and written back; a second run requests nothing and writes the same CSV
  writeBack: async (m) => {
    const store = join(tmp, `store-${storeNumber++}`);
    const first = await prepare(m, Q5, store);
    const manifest = readFileSync(join(store, "manifest.tsv"), "utf8").trimEnd().split("\n");
    const second = await prepare(m, Q5, store);
    const online = await prepare(m, Q5);
    return first.calls.includes(whole("SP.POP.65UP.TO.ZS")) && first.calls.some((u) => u.includes("/v2/country?")) && manifest.length === 3
      && existsSync(join(store, "data/SP.POP.65UP.TO.ZS.tsv.gz")) && existsSync(join(store, "country-list.json"))
      && second.calls.length === 0 && second.d.sha256 === first.d.sha256 && sameRows(online, second)
      && originOf(first.dir, originOf(first.dir, first.d.filePath).source_file)?.origin === "download";
  },
  // a copy older than the limit is fetched again (and the newer line read after)
  stale: async (m) => {
    const store = makeStore([["SP.POP.65UP.TO.ZS", "q5.json"]], { daysAgo: 40 });
    const first = await prepare(m, Q5, store);
    const second = await prepare(m, Q5, store);
    return first.calls.includes(whole("SP.POP.65UP.TO.ZS")) && /older than 30 days/.test(text(first.out)) && second.calls.length === 0;
  },
  // a copy whose bytes no longer match the manifest is not read
  changed: async (m) => {
    const store = makeStore([["SP.POP.65UP.TO.ZS", "q5.json"]]);
    const file = join(store, "data/SP.POP.65UP.TO.ZS.tsv.gz");
    writeFileSync(file, gzipSync(Buffer.from("indicator\tcountry_id\tiso3\tyear\tvalue\tobs_status\nSP.POP.65UP.TO.ZS\tJP\tJPN\t2024\t99\t\n")));
    const r = await prepare(m, Q5, store);
    return r.calls.includes(whole("SP.POP.65UP.TO.ZS")) && /does not match the manifest's sha256/.test(text(r.out)) && !csvLines(r.dir, r.d.filePath).some((l) => l.startsWith("JPN,") && l.endsWith(",2024,99"));
  },
  // the route switch off: the store is never read
  switchOff: async (m) => {
    delete process.env.NEWSROOM_NEXT;
    process.env.NEWSROOM_WB_STORE = makeStore([["SP.POP.65UP.TO.ZS", "q5.json"]]);
    try {
      newRun();
      let message = null;
      try { await registered(m).get("newsroom_data_prepare").execute("a", Q5); } catch (error) { message = String(error?.message ?? error); }
      return /unknown provider worldbank/.test(message ?? "");
    } finally { delete process.env.NEWSROOM_WB_STORE; }
  },
  // the narrow (page build) ranks the same economies from the store as from the provider
  narrowSame: async (m) => {
    process.env.NEWSROOM_SPEED_PAGE_BUILD = "1";
    process.env.NEWSROOM_AGENT = "rust";
    try {
      const args = { ...Q5, narrow: { dimension: "country", rule: "top", by: "SP.POP.TOTL", n: 8, exclude: [] } };
      const online = await prepare(m, args);
      const local = await prepare(m, args, makeStore([["SP.POP.65UP.TO.ZS", "q5.json"], ["SP.POP.TOTL", "pop.json"]]));
      const members = (r) => JSON.stringify(readdirSync(join(r.dir, "data/origins")).map((name) => JSON.parse(readFileSync(join(r.dir, "data/origins", name), "utf8"))).find((x) => x.origin === "worldbank_narrow")?.members);
      return members(online) !== undefined && members(online) === members(local) && noIndicatorFetch(local) && sameRows(online, local);
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
  ["reads a copy whatever its sha256", swap('if (sha256Hex(bytes) !== entry.sha256) return { miss: "its file does not match the manifest\'s sha256" };', ""), "changed"],
  ["reads a copy whatever its age", swap("if (!(age >= 0 && age <= limit * 86400000))", "if (false)"), "stale"],
  ["keeps every year of the copy", swap("Number(row.date) >= start && Number(row.date) <= end && ", ""), "yearsCut"],
  ["keeps every place of the copy", swap("(!wanted || wanted.has(placeOf(row)?.id ?? \"\"))", "true"), "placesCut"],
  ["does not write the fetched indicator back", swap("const kept = await wbStoreWrite(dir, code, file, bytes, lines.length, last)", "const kept = await Promise.resolve()"), "writeBack"],
  ["keeps no copy of the store file in the run", swap('source = await wbStoreCopyIntoRun(bytes, "gz",', 'source = await (async (b) => ({ relativeFile: "data/none.gz", sha256: entry.sha256, bytes: b, reused: false }))(bytes, "gz",'), "q5Same"],
];
for (const [name, patch, check] of mutants) {
  const red = await runChecks(await load(patch), [check]);
  ok(red.includes(check), `mutant "${name}" must turn ${check} red`);
}
console.log(`PASS test_data_prepare_wb_store: ${n} checks, ${mutants.length} mutants went red`);
