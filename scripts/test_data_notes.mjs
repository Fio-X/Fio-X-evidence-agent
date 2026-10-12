// NEWSROOM_DATA_NOTES=1 (K118 part 1 batch 2): the status flags a data file carries (e estimated, p provisional, b break, d definition,
// f forecast) become one plain Chinese line under the chart, written by the program from the file, never by the model.
//   Part A: runtime/pi/data_notes.mjs on its own (reader, matcher, sentence, 40-character rule, number-word check, unknown codes).
//           DATA_NOTES_MODULE=<path> points part A at a mutated copy (scripts/ mutation runs); default is the repo file.
//   Part B: the real tool path (plan -> lint -> render) for a zh bar chart: off matrix byte-identical, on prints the note, the long form
//           prints 详见数据说明 and the full sentence reaches the page foot. Needs the duckdb binary; skipped without it.
// Offline, no provider. Loads runtime/pi/newsroom.ts from a type-stripped copy, as test_local_source_note_plan.mjs does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const results = [];
const scratch = []; // every temp directory this test makes; removed on exit unless NEWSROOM_TEST_KEEP_TMP=1
process.on("exit", () => { if (process.env.NEWSROOM_TEST_KEEP_TMP !== "1") for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const ok = (name) => { results.push(name); console.log(`${name} -- PASS`); };

// ---------------------------------------------------------------- Part A: the module
const dn = await import(process.env.DATA_NOTES_MODULE ? pathToFileURL(process.env.DATA_NOTES_MODULE).href : pathToFileURL(join(ROOT, "runtime/pi/data_notes.mjs")).href);
const { composeDataNote, flagCellsFromCsv, flagCellsFromJsonStat, splitFlag } = dn;

// A JSON-stat file shaped like Eurostat's: geo x time, flat position = geo * 2 + time.
const jsonStat = (status, value = { 0: 1, 1: 2, 2: 3, 3: 4 }) => JSON.stringify({
  version: "2.0", class: "dataset", id: ["geo", "time"], size: [2, 2],
  dimension: {
    geo: { category: { index: { DE: 0, FR: 1 }, label: { DE: "Germany", FR: "France" } } },
    time: { category: { index: { 2022: 0, 2023: 1 }, label: { 2022: "2022", 2023: "2023" } } },
  },
  status, value,
});
// four countries, one year: flat position = geo
const jsonStat4 = (status) => JSON.stringify({
  version: "2.0", class: "dataset", id: ["geo", "time"], size: [4, 1],
  dimension: { geo: { category: { index: { DE: 0, FR: 1, IT: 2, ES: 3 } } }, time: { category: { index: { 2023: 0 } } } },
  status, value: { 0: 1, 1: 2, 2: 3, 3: 4 },
});
const NAMES = { DE: "德国", FR: "法国", IT: "意大利" }; // ES has no Chinese display name on purpose
const OPTS = { categoryField: "country", display: (_column, value) => NAMES[value] ?? null };
const drawn = (status, rows, value, opts = OPTS) => composeDataNote(flagCellsFromJsonStat(jsonStat(status, value)), rows, opts);
const drawn4 = (status, rows, opts = OPTS) => composeDataNote(flagCellsFromJsonStat(jsonStat4(status)), rows, opts);
const row = (geo, time) => ({ country: geo, year: time, v: 1 });
const all4 = ["DE", "FR", "IT", "ES"].map((geo) => row(geo, "2023"));

{ // every code of the table, exact sentence; no raw code in the line
  const want = { e: "2023 年为估计值", p: "2023 年为初步数", f: "2023 年为预测值", b: "2023 年起统计口径改变，前后不宜直接比较", d: "2023 年口径与其余不同" };
  for (const [code, text] of Object.entries(want)) {
    const note = drawn({ 1: code }, [row("DE", "2023")]);
    assert.equal(note.text, text, code);
    assert.equal(note.truncated, false);
    assert.ok(!new RegExp(`(?:^|[^a-z])${code}(?:[^a-z]|$)`, "i").test(note.text), `${code}: the raw code is not printed`);
  }
  assert.equal(drawn({ 1: "E" }, [row("DE", "2023")]).text, want.e, "case does not matter");
  ok("A1 e/p/f/b/d each become the table's sentence, the year from the flagged cell's own period, no raw code");
}
{ // ep = estimated and provisional, merged; different years stay apart
  assert.equal(drawn({ 1: "ep" }, [row("DE", "2023")]).text, "2023 年为估计值、初步数");
  const two = drawn({ 0: "e", 1: "p" }, [row("DE", "2022"), row("DE", "2023")]);
  assert.equal(two.text, "2022 年为估计值，2023 年为初步数");
  const many = drawn({ 0: "p", 1: "p" }, [row("DE", "2022"), row("DE", "2023")]);
  assert.equal(many.text, "2022、2023 年为初步数");
  ok("A2 ep merges to one clause; e in one year and p in another stay two clauses; two years share one clause");
}
{ // 40 characters: the whole printed line, 「注：」 included; longer -> 详见数据说明 + the full sentence
  const long = drawn({ 0: "b", 1: "e", 2: "p", 3: "d" }, [row("DE", "2022"), row("DE", "2023"), row("FR", "2022"), row("FR", "2023")]);
  assert.ok(Array.from(`注：${long.full}`).length > 40, "the fixture sentence is over the limit");
  assert.equal(long.text, "详见数据说明");
  assert.equal(long.truncated, true);
  assert.ok(long.full.includes("统计口径改变"), "the full sentence is kept for the page foot");
  const read = flagCellsFromJsonStat(jsonStat({ 1: "p" }));
  const exact = Array.from("注：2023 年为初步数").length;
  assert.equal(composeDataNote(read, [row("DE", "2023")], { ...OPTS, lineMax: exact }).text, "2023 年为初步数", "exactly at the limit stays");
  const over = composeDataNote(read, [row("DE", "2023")], { ...OPTS, lineMax: exact - 1 });
  assert.equal(over.text, "详见数据说明", "one over the limit becomes the pointer");
  assert.equal(over.full, "2023 年为初步数");
  ok("A3 the 40-character rule counts the printed 注： and turns a longer sentence into 详见数据说明 with the full text kept");
}
{ // an unknown code is never translated: left out, recorded
  const none = drawn({ 1: "z" }, [row("DE", "2023")]);
  assert.equal(none.text, null);
  assert.deepEqual(none.diagnostics, [{ rule: "unknown_code", code: "z", count: 1 }]);
  const mixed = drawn({ 0: "z", 1: "p" }, [row("DE", "2022"), row("DE", "2023")]);
  assert.equal(mixed.text, "2023 年为初步数", "the known code is still written, the unknown one is not");
  assert.deepEqual(mixed.diagnostics, [{ rule: "unknown_code", code: "z", count: 1 }]);
  assert.equal(splitFlag("ee"), null, "a multi-letter code is split only when the table names the combination");
  assert.equal(splitFlag("xp"), null);
  assert.equal(drawn({ 1: "ee" }, [row("DE", "2023")]).text, null);
  ok("A4 unknown or unlisted codes are not written and are listed in the diagnostics");
}
{ // the year/object is the flagged cell's own, and only when the chart draws it
  assert.equal(drawn({ 1: "p" }, [row("DE", "2022")]), null, "a 2023 flag with only a 2022 row drawn says nothing");
  assert.equal(drawn({ 1: "p" }, [row("FR", "2023")]), null, "the flag is on Germany; a France row does not carry it");
  assert.equal(drawn({ 1: "p" }, [{ country: "Germany", year: "2023", v: 1 }]).text, "2023 年为初步数", "a drawn label ties the cell too");
  assert.equal(drawn({ 3: "p" }, [row("DE", "2023")]), null, "the flag is on France 2023, a Germany row does not carry it");
  assert.equal(drawn({ 1: "p" }, [{ year: "2023", v: 1 }]), null, "a row that does not name the country cannot be tied");
  assert.equal(drawn({ 1: "p" }, []), null);
  assert.equal(drawn({ 1: "p" }, [row("DE", "2023")], { 0: 1, 1: null, 2: 3, 3: 4 }), null, "a flag on a missing value draws nothing");
  ok("A5 the period and object come from the flagged cell and must both be in a drawn row; missing values and other rows carry nothing");
}
{ // the existing number-word check is applied to the final text
  const csv = "country,year,share,flag\nChad,三年,70,p\n";
  const note = composeDataNote(flagCellsFromCsv(csv), [{ country: "Chad", year: "三年", share: 70 }], OPTS);
  assert.equal(note.text, null);
  assert.equal(note.diagnostics.at(-1).rule, "number_word");
  ok("A6 a sentence the number-word check refuses is dropped and recorded");
}
{ // CSV flag column, and shapes that must not match
  const csv = "country,year,share,flag\nChad,2022,70,\nChad,2023,66,p\nNiger,2023,,e\nNiger,2022,80,\n";
  const read = flagCellsFromCsv(csv);
  assert.equal(read.cells.length, 3, "the row with no number is not a cell");
  assert.equal(read.cells.filter((c) => c.code).length, 1, "so the flag on it is gone");
  assert.equal(composeDataNote(read, [{ country: "Chad", year: "2023", share: 66 }], OPTS).text, "2023 年为初步数");
  assert.equal(flagCellsFromCsv("country,year,share\nChad,2023,66\n").cells.length, 0, "no flag column, no cells");
  assert.equal(flagCellsFromJsonStat("{}").cells.length, 0);
  assert.equal(flagCellsFromJsonStat("not json").cells.length, 0);
  ok("A7 CSV flag column read; no flag column, empty value or other JSON gives no cell");
}
{ // a status string for every cell (JSON-stat allows it) and an array form
  assert.equal(drawn("p", [row("DE", "2023")]).text, "2023 年为初步数");
  assert.equal(drawn(["", "", "", "e"], [row("FR", "2023")]).text, "2023 年为估计值");
  ok("A8 JSON-stat status as one string or as an array");
}
{ // K118 review 1: only some drawn rows flagged -> the rows are named with the chart's Chinese display names
  assert.equal(drawn4({ 0: "ep", 1: "ep", 2: "ep", 3: "ep" }, all4).text, "2023 年为估计值、初步数", "every drawn row flagged: no names");
  assert.equal(drawn4({ 0: "ep", 1: "ep", 2: "", 3: "" }, all4.slice(0, 3)).text, "德国、法国 2023 年为估计值、初步数", "two of three drawn rows flagged: named");
  assert.equal(drawn4({ 0: "e" }, all4.slice(0, 3)).text, "德国 2023 年为估计值", "one of three");
  assert.equal(drawn4({ 0: "ep", 1: "ep", 2: "ep" }, all4.slice(0, 3)).text, "2023 年为估计值、初步数", "the undrawn fourth row does not matter");
  assert.equal(drawn4({ 0: "ep" }, all4.slice(0, 1).concat([{ year: "2023", v: 9 }])).text, "德国 2023 年为估计值、初步数", "a drawn row that cannot be tied is not 'all rows': the flagged row is named");
  ok("A9 all drawn rows flagged -> no names; some flagged -> those rows by their Chinese display names");
}
{ // never a code as a name; the long named sentence falls back to the pointer
  const noName = drawn4({ 0: "e", 3: "e" }, all4);
  assert.equal(noName.text, null, "a flagged row with no Chinese display name leaves the sentence out");
  assert.deepEqual(noName.diagnostics, [{ rule: "no_display_name", period: "2023", letter: "e" }]);
  assert.ok(!JSON.stringify(noName).includes("ES"), "the code is not printed as a name");
  assert.equal(drawn4({ 0: "e" }, all4.slice(0, 3), { categoryField: "country" }).text, null, "no display mapping and a Latin value: no name");
  assert.equal(drawn4({ 0: "e" }, [{ country: "德国", year: "2023", v: 1 }, { country: "法国", year: "2023", v: 1 }], { categoryField: "country" }), null, "an unrelated Chinese value ties no cell");
  assert.equal(drawn4({ 0: "e" }, all4.slice(0, 3), { display: OPTS.display }).text, null, "without a category field the rows cannot be named");
  const long = drawn4({ 0: "ep", 1: "ep", 2: "ep" }, all4);
  assert.equal(long.text, "德国、法国、意大利 2023 年为估计值、初步数", "an unflagged row without a name is fine; the flagged ones have names");
  ok("A10 a flagged row with no Chinese display name (or no category field) leaves the sentence out; a code is never printed as a name");
}
{ // K118 review 2: a row built from cells of which only some carry the flag says 含, never 为
  const csv = ["country,year,product,value,flag", "Chad,2024,oil,10,e", "Chad,2024,gas,20,", "Niger,2024,oil,5,e", "Niger,2024,gas,6,e"].join("\n");
  const read = flagCellsFromCsv(csv);
  const rows = [{ country: "Chad", year: 2024, v: 30 }, { country: "Niger", year: 2024, v: 11 }];
  const sum = "SELECT country, year, SUM(value) AS v FROM 'data/x.csv' GROUP BY country, year";
  const names = { categoryField: "country", display: (_c, v) => ({ Chad: "乍得", Niger: "尼日尔" })[v] ?? null };
  assert.equal(composeDataNote(read, rows, { ...names, sql: sum }).text, "2024 年数据含估计值", "Chad is partly flagged, Niger wholly: 含");
  assert.equal(composeDataNote(read, rows.slice(1), { ...names, sql: sum }).text, "2024 年为估计值", "only the wholly flagged row drawn: 为");
  const csv2 = ["country,year,product,value,flag", "Chad,2024,oil,10,e", "Chad,2024,gas,20,", "Niger,2024,oil,5,", "Niger,2024,gas,6,"].join("\n");
  assert.equal(composeDataNote(flagCellsFromCsv(csv2), rows, { ...names, sql: sum }).text, "乍得 2024 年数据含估计值", "one of two rows, partly flagged: named and 含");
  assert.equal(composeDataNote(read, rows, { ...names }), null, "no aggregate in the SQL: the product dimension is not summed away, so the rows tie to no cell");
  assert.equal(composeDataNote(read, rows, { ...names, sql: `${sum.replace("GROUP BY", "WHERE product = 'oil' GROUP BY")}` }), null, "a literal filter on the dimension is not a sum");
  ok("A11 a row summed from partly flagged cells reads 含 (never 为); aggregation is accepted only when the SQL sums the dimension away");
}

// ---------------------------------------------------------------- Part B: the tool path
const probe = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" });
if (probe.error?.code === "ENOENT") {
  console.log("duckdb binary not found; skipping the real-chart checks");
} else {
  const stub = (dir, name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
  const tree = mkdtempSync(join(tmpdir(), "data-notes-tree-"));
  scratch.push(tree);
  cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
  stub(tree, "typebox", TYPEBOX);
  stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  writeFileSync(join(tree, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  const mod = await import(join(tree, "runtime/pi/newsroom.test-copy.mjs"));
  const { composeInfographicBundle } = await import(join(tree, "runtime/pi/infographic.mjs"));

  const ENV_KEYS = ["NEWSROOM_DATA_NOTES", "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_HIDE_LIEFLAT", "NEWSROOM_SPEED_ATOMIC_ARTIFACT"];
  function register(env) {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.NEWSROOM_TOOL_PROFILE = "full";
    process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1";
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const tools = new Map();
    mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
    return tools;
  }
  const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
  const MODEL_TEXT = "model wrote this note";
  const SQL = "SELECT country, year, share FROM 'data/africa.csv' WHERE year = 2024 ORDER BY country";

  // Eurostat-shaped synthetic data: one row per country for 2024, flagged `ep` for Niger and Chad, plus a 2023 row that is not drawn.
  const CSV_EP = ["country,year,share,flag", "Chad,2024,70.0,ep", "Guinea,2024,66.6,", "Liberia,2024,92.8,", "Niger,2024,79.6,ep", "Niger,2023,60.0,e"].join("\n") + "\n";
  const CSV_LONG = ["country,year,share,flag", "Chad,2024,70.0,b", "Guinea,2024,66.6,e", "Liberia,2024,92.8,d", "Niger,2024,79.6,p"].join("\n") + "\n";
  const CSV_ALL = ["country,year,share,flag", "Chad,2024,70.0,p", "Guinea,2024,66.6,p", "Liberia,2024,92.8,p", "Niger,2024,79.6,p"].join("\n") + "\n";
  const CSV_NONE = ["country,year,share,flag", "Chad,2024,70.0,", "Guinea,2024,66.6,", "Liberia,2024,92.8,"].join("\n") + "\n";

  const planParams = (claim_id) => ({
    reader_task: "sequence", title: "非洲部分国家的可再生能源占比", alt: "非洲部分国家可再生能源占比的横向条形图。", takeaway: "利比里亚的占比最高。",
    source_note: MODEL_TEXT, sql: SQL, unit: "%", chart_type: "horizontal_bar", language: "zh", category_field: "country", value_field: "share",
    highlight_values: [], annotations: [], claim_id,
  });
  async function run(env, csv) {
    const tools = register(env);
    const runDir = mkdtempSync(join(tmpdir(), "data-notes-run-"));
    scratch.push(runDir);
    const art = join(runDir, "run");
    for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data/origins", "sources"]) mkdirSync(join(art, d), { recursive: true });
    writeFileSync(join(art, "data", "africa.csv"), csv);
    writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256: sha256(csv) }));
    writeFileSync(join(art, "claims.jsonl"), "");
    process.env.NEWSROOM_ARTIFACT_DIR = art;
    const query = await tools.get("duckdb_query").execute("q", { sql: SQL });
    const ref = query.details.path.startsWith("/") ? query.details.path.slice(art.length + 1) : query.details.path;
    writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "claim-x", status: "verified", source_refs: ["data/africa.csv"], computation_refs: [ref], verification })}\n`);
    const plan = await tools.get("newsroom_viz_plan").execute("p", planParams("claim-x"));
    const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
    const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
    const manifestText = readFileSync(join(art, render.details.manifestRef), "utf8");
    const manifest = JSON.parse(manifestText);
    const svg = readFileSync(join(art, manifest.variants?.desktop ?? manifest.svg), "utf8");
    const compact = manifest.variants?.compact ? readFileSync(join(art, manifest.variants.compact), "utf8") : "";
    return { art, manifest, manifestText, svg, compact, planText: readFileSync(join(art, plan.details.planRef), "utf8") };
  }
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  // DATA_NOTES_EXPORT=<dir>: also write the rendered charts there (local review only; not used by the assertions)
  const exportSvg = (name, svg) => { if (process.env.DATA_NOTES_EXPORT) { mkdirSync(process.env.DATA_NOTES_EXPORT, { recursive: true }); writeFileSync(join(process.env.DATA_NOTES_EXPORT, name), svg); } };
  const keysOf = (manifest) => Object.keys(manifest).filter((key) => key.startsWith("data_note"));

  const base = await run({}, CSV_EP);
  exportSvg("off-ep.svg", base.svg);
  { // off: nothing about notes anywhere, whatever the flags say
    assert.deepEqual(keysOf(base.manifest), []);
    assert.ok(!base.svg.includes("初步数") && !base.svg.includes("估计值"), "no flag sentence when the switch is off");
    for (const [label, value] of [["0", "0"], ["empty", ""], ["yes", "yes"], ["space-1", " 1"], ["on", "on"], ["true", "true"]]) {
      const out = await run({ NEWSROOM_DATA_NOTES: value }, CSV_EP);
      assert.equal(out.svg, base.svg, `${label}: chart bytes equal the unset run`);
      assert.equal(out.compact, base.compact, `${label}: compact bytes equal`);
      assert.equal(out.manifestText.replace(/"plan_ref"[^\n]*\n/, ""), base.manifestText.replace(/"plan_ref"[^\n]*\n/, ""), `${label}: manifest equal`);
      assert.equal(out.planText, base.planText, `${label}: plan equal`);
    }
    ok("B1 switch unset, 0, empty, yes, ' 1', on, true: chart, compact chart, manifest and plan are byte-identical to the unset run and carry no note");
  }
  {
    const on = await run({ NEWSROOM_DATA_NOTES: "1" }, CSV_EP);
    exportSvg("on-ep.svg", on.svg);
    assert.equal(on.manifest.data_note, "乍得、尼日尔 2024 年为估计值、初步数");
    assert.deepEqual(keysOf(on.manifest), ["data_note"]);
    assert.ok(on.svg.includes("注：乍得、尼日尔 2024 年为估计值、初步数"), "the note names the two flagged of four drawn rows, by their Chinese names");
    assert.ok(!on.svg.includes("Chad 2024") && !on.svg.includes("Niger 2024"), "no Latin code as a name");
    assert.ok(!/注：[^<]*\bep\b/.test(on.svg), "the raw code is not printed");
    assert.ok(!on.svg.includes("2023 年"), "the undrawn 2023 row's flag is not mentioned");
    // the note comes before the model's note and the source line, on its own line
    const lines = texts(on.svg);
    const noteAt = lines.findIndex((x) => x.startsWith("注：乍得"));
    const modelAt = lines.findIndex((x) => x.includes(MODEL_TEXT));
    assert.ok(noteAt >= 0 && modelAt > noteAt, "the flag line is above the source line");
    // nothing else changed: every other text of the off chart is still there, in order
    const offTexts = texts(base.svg);
    const onTexts = texts(on.svg).filter((_x, i) => i !== noteAt);
    assert.deepEqual(onTexts, offTexts, "values, labels and axis are exactly the off chart's");
    ok("B2 on: the program note is printed above the source line, no raw code, undrawn rows add nothing, every other text equals the off chart");
  }
  {
    const long = await run({ NEWSROOM_DATA_NOTES: "1" }, CSV_LONG);
    exportSvg("on-long.svg", long.svg);
    assert.equal(long.manifest.data_note, "详见数据说明");
    assert.ok(long.manifest.data_note_full.includes("统计口径改变"), "the full sentence is in the manifest");
    assert.ok(long.svg.includes("注：详见数据说明") && !long.svg.includes("统计口径改变"), "the chart carries only the pointer");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#ccc"/></svg>';
    const spec = { schema_version: "1.0.0", kicker: "DATA", title: "A page", dek: "d", alt: "A synthetic page used to test the data-note block in the footer.", byline: "b", date_label: "d", layout: "feature", complexity_budget: "low", language: "en", source_note: "page note", modules: [{ id: "section-1", type: "section_header", span: "full", eyebrow: "Background", heading: "Where the data comes from", deck: "A short deck." }, { id: "v1", type: "visual", span: "full", manifest_ref: "m1", label: "v1" }, { id: "section-2", type: "section_header", span: "full", eyebrow: "Closing", heading: "What to read next", deck: "Another short deck." }] };
    const page = (manifest) => composeInfographicBundle(spec, { m1: { manifest, critic: null, renderQa: null, desktopSvg: svg, mobileSvg: svg } }, { mobilePages: false }).desktop;
    const withNote = page(long.manifest);
    const without = page({ source_note: long.manifest.source_note });
    assert.ok(texts(withNote.svg).join("").includes(`数据说明：${long.manifest.data_note_full}`), "the page foot prints the full sentence");
    assert.ok(!texts(without.svg).join("").includes("数据说明："), "a manifest without a full note adds nothing");
    assert.ok(withNote.height > without.height, "the page grows by the block");
    const short = page({ source_note: "x", data_note: "2024 年为初步数" });
    assert.equal(short.svg, page({ source_note: "x" }).svg, "a short note that fit its line adds nothing to the page foot");
    ok("B3 on, long sentence: the chart prints 详见数据说明, the manifest and the page foot hold the full sentence; short notes add nothing to the page");
  }
  {
    const none = await run({ NEWSROOM_DATA_NOTES: "1" }, CSV_NONE);
    assert.deepEqual(keysOf(none.manifest), []);
    const noneOff = await run({}, CSV_NONE);
    assert.equal(none.svg, noneOff.svg, "on with nothing flagged: the chart is the off chart");
    const unknown = await run({ NEWSROOM_DATA_NOTES: "1" }, CSV_EP.replace(/,ep\n/g, ",zz\n"));
    assert.deepEqual(keysOf(unknown.manifest), ["data_note_diagnostics"]);
    assert.ok(unknown.manifest.data_note_diagnostics.some((x) => x.rule === "unknown_code" && x.code === "zz"));
    assert.ok(!unknown.svg.includes("注：乍得") && !unknown.svg.includes("zz"), "an unknown code reaches neither the chart nor the page");
    const everyRow = await run({ NEWSROOM_DATA_NOTES: "1" }, CSV_ALL);
    assert.equal(everyRow.manifest.data_note, "2024 年为初步数", "every drawn row flagged: no names");
    ok("B4 on: nothing flagged = the off chart; an unknown code is recorded in the manifest's diagnostics and printed nowhere");
  }
}

console.log(`${results.length} checks -- PASS`);
