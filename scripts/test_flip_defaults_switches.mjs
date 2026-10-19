// The four switches that are on unless the value is exactly "0" (NEWSROOM_SYMBOL_MAP, NEWSROOM_LOCATION_EVIDENCE on the Node side; NEWSROOM_SPEED_AUTO_CHECKS,
// NEWSROOM_TOOL_RESULT_IMAGES on the Rust side), K1122-v3 / K1140s. Four checks, each with mutants that must turn it red:
//   A consistency: the Node readers of the two Node switches agree for ten values, each value in a FRESH node process (the grammar table is read at load);
//   B strict names: only the exact name NEWSROOM_SYMBOL_MAP gets the "on unless 0" rule; TILE_MAP, STORY_FORMS and SYMBOL_MAP_CROP stay exactly "1";
//   D two copies: the Node side reads NEWSROOM_SYMBOL_MAP in exactly two files, symbol_map_switch.mjs and newsroom.ts (its inline copy in the grammar table, no import: K1199, so the
//     agent group makes no new cross-group call); both answer the same for every gated name and twelve values. Removing the "0" later means changing BOTH copies;
//   C source scan: the four full names (and the Rust constants AUTO_CHECKS_ENV, TOOL_RESULT_IMAGES_ENV) occur in code only in an allowlisted place.
// Run: node scripts/test_flip_defaults_switches.mjs   (the worker mode is internal)
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), "..");
const PI = join(ROOT, "runtime/pi");

// newsroom.ts holds the rule inline in its grammar table filter (not imported from symbol_map_switch.mjs, which would be a cross-group call). The expression is cut out of the
// source and run here as (name, env) => ...
const NEWS_FILE = join(PI, "newsroom.ts");
const newsSource = readFileSync(NEWS_FILE, "utf8");
const newsroomRule = (text) => {
  const m = text.match(/\.filter\(\(\[, name\]\) => \(([^\n]*?)\)\)\.map\(\(\[form\]\) => form\)/);
  assert.ok(m, "D: newsroom.ts has no inline gated-form rule in the grammar table");
  return new Function("name", "env", `return ${m[1].replaceAll("process.env", "env").replaceAll(" as string", "")};`);
};

if (process.argv[2] === "worker") {
  const sw = await import(pathToFileURL(join(PI, "symbol_map_switch.mjs")).href);
  const choro = await import(pathToFileURL(join(PI, "choropleth.mjs")).href);
  const info = await import(pathToFileURL(join(PI, "infographic.mjs")).href);
  const lp = await import(pathToFileURL(join(PI, "location_proof.mjs")).href);
  console.log(JSON.stringify({
    switch_fn: sw.symbolMapOn(process.env),
    newsroom_rule: newsroomRule(newsSource)("NEWSROOM_SYMBOL_MAP", process.env),
    choropleth: choro.symbolMapEnabled(),
    page_table: info.SYMBOL_MAP_GRAMMAR_ON,
    location_evidence: lp.locationEvidenceEnabled(process.env),
  }));
  process.exit(0);
}

const NAMES = ["NEWSROOM_SYMBOL_MAP", "NEWSROOM_LOCATION_EVIDENCE", "NEWSROOM_TILE_MAP", "NEWSROOM_STORY_FORMS", "NEWSROOM_SYMBOL_MAP_CROP"];

// ---------------------------------------------------------------- A consistency (fresh process per value, per switch)
const VALUES = [undefined, "0", "1", "", "false", "off", "no", "2", " 0", "00"];
function workerFor(symbol, evidence, mutateDir) {
  const env = { ...process.env };
  for (const k of NAMES) delete env[k];
  if (symbol !== undefined) env.NEWSROOM_SYMBOL_MAP = symbol;
  if (evidence !== undefined) env.NEWSROOM_LOCATION_EVIDENCE = evidence;
  const r = spawnSync(process.execPath, ["--no-warnings", SELF, "worker"], { env, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `worker failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
function consistencyProblems() {
  const bad = [];
  for (const v of VALUES) {
    const label = v === undefined ? "unset" : JSON.stringify(v);
    const on = v !== "0";
    const s = workerFor(v, undefined);
    for (const k of ["switch_fn", "newsroom_rule", "choropleth", "page_table"]) if (s[k] !== on) bad.push(`NEWSROOM_SYMBOL_MAP ${label}: ${k} is ${s[k]}, expected ${on}`);
    const e = workerFor(undefined, v);
    if (e.location_evidence !== on) bad.push(`NEWSROOM_LOCATION_EVIDENCE ${label}: location_evidence is ${e.location_evidence}, expected ${on}`);
  }
  return bad;
}
assert.deepEqual(consistencyProblems(), [], "A: the readers disagree");
console.log(`A consistency: ${VALUES.length} values x (symbol map: 4 readers, location evidence: 1 reader), each in a fresh process -- PASS`);

// ---------------------------------------------------------------- B strict names
async function strictProblems(file) {
  const { gatedFormOn } = await import(`${pathToFileURL(file).href}?v=${Math.random()}`);
  const bad = [];
  for (const name of ["NEWSROOM_TILE_MAP", "NEWSROOM_STORY_FORMS", "NEWSROOM_SYMBOL_MAP_CROP"]) {
    if (gatedFormOn(name, {}) !== false) bad.push(`${name} unset must be off`);
    if (gatedFormOn(name, { [name]: "1" }) !== true) bad.push(`${name}=1 must be on`);
    for (const v of ["0", "true", "", "false"]) if (gatedFormOn(name, { [name]: v }) !== false) bad.push(`${name}=${JSON.stringify(v)} must be off (exactly "1" only)`);
  }
  if (gatedFormOn("NEWSROOM_SYMBOL_MAP", {}) !== true) bad.push("NEWSROOM_SYMBOL_MAP unset must be on");
  if (gatedFormOn("NEWSROOM_SYMBOL_MAP", { NEWSROOM_SYMBOL_MAP: "0" }) !== false) bad.push('NEWSROOM_SYMBOL_MAP "0" must be off');
  return bad;
}
const SWITCH_FILE = join(PI, "symbol_map_switch.mjs");
assert.deepEqual(await strictProblems(SWITCH_FILE), [], "B: strict names");
const switchSource = readFileSync(SWITCH_FILE, "utf8");
const tmp = makeTestTmp("flip-defaults-");
const STRICT_MUTANTS = [
  ["startsWith instead of whole-name equality", "envName === SYMBOL_MAP_NAME ?", "envName.startsWith(SYMBOL_MAP_NAME) ?"],
  ["every gated form on unless 0", 'env[envName] === "1"', 'env[envName] !== "0"'],
  ["symbol map back to exactly 1", 'env[SYMBOL_MAP_NAME] !== "0"', 'env[SYMBOL_MAP_NAME] === "1"'],
];
const caught = [];
for (const [label, from, to] of STRICT_MUTANTS) {
  assert.equal(switchSource.split(from).length, 2, `B mutant "${label}": the text to change is not where this test expects it`);
  const file = join(tmp, `mutant-${caught.length}.mjs`);
  writeFileSync(file, switchSource.replace(from, to));
  const bad = await strictProblems(file);
  assert.ok(bad.length > 0, `B mutant "${label}" stayed green`);
  caught.push(`${label}: red at ${bad[0]}`);
}
console.log(`B strict names: PASS; mutants red -- ${caught.join(" | ")}`);

// ---------------------------------------------------------------- D two copies of the rule (K1199)
const infoTable = (await import(pathToFileURL(join(PI, "infographic.mjs")).href)).VISUAL_GRAMMAR_FORMS;
// the gated names come from the real table; one longer name that starts with the symbol map's, and one unknown name, are added
const GATED_NAMES = [...new Set(Object.values(infoTable.gatedForms).flatMap((forms) => Object.values(forms)))];
assert.ok(GATED_NAMES.includes("NEWSROOM_SYMBOL_MAP") && GATED_NAMES.length >= 3, "D: the gated table no longer lists the symbol map and the other forms");
const D_NAMES = [...GATED_NAMES, "NEWSROOM_SYMBOL_MAP_CROP", "NEWSROOM_NOT_A_SWITCH"];
// each answer is pinned on its own, so two copies that are wrong the same way still fail: the symbol map is on for every value except exactly "0"; every other gated name only for exactly "1"
const expectedOn = (name, v) => (name === "NEWSROOM_SYMBOL_MAP" ? v !== "0" : v === "1");
const D_VALUES = [undefined, "", "0", "1", " 0", "00", "false", "off", "no", "true", " 1", "1 "];
async function twoCopyProblems(switchFile, newsText) {
  const { gatedFormOn: fromSwitch } = await import(`${pathToFileURL(switchFile).href}?v=${Math.random()}`);
  const fromNews = newsroomRule(newsText);
  const bad = [];
  for (const name of D_NAMES) for (const v of D_VALUES) {
    const env = v === undefined ? {} : { [name]: v };
    for (const [who, got] of [["symbol_map_switch.mjs", fromSwitch(name, env)], ["newsroom.ts", fromNews(name, env)]]) if (got !== expectedOn(name, v)) bad.push(`${name}=${v === undefined ? "unset" : JSON.stringify(v)}: ${who} says ${got}, expected ${expectedOn(name, v)}`);
    if (fromSwitch(name, env) !== fromNews(name, env)) bad.push(`${name}=${v === undefined ? "unset" : JSON.stringify(v)}: symbol_map_switch.mjs says ${fromSwitch(name, env)}, newsroom.ts says ${fromNews(name, env)}`);
  }
  return bad;
}
assert.deepEqual(await twoCopyProblems(SWITCH_FILE, newsSource), [], "D: the two copies of the rule disagree");
const NEWS_MUTANTS = [
  ["newsroom: symbol map back to exactly 1", 'process.env[name as string] !== "0"', 'process.env[name as string] === "1"'],
  ["newsroom: prefix match instead of the whole name", 'name === "NEWSROOM_SYMBOL_MAP" ?', '(name as string).startsWith("NEWSROOM_SYMBOL_MAP") ?'],
  ["newsroom: every gated form on unless 0", 'process.env[name as string] === "1"', 'process.env[name as string] !== "0"'],
  ["newsroom: trim before the 0 test", 'process.env[name as string] !== "0"', 'process.env[name as string]?.trim() !== "0"'],
  // one value answered the other way: dropping any value from D_VALUES would let the matching mutant live
  ...D_VALUES.map((v) => [`newsroom: the symbol map answers the other way for ${v === undefined ? "unset" : JSON.stringify(v)}`, 'process.env[name as string] !== "0"', v === undefined ? '(process.env[name as string] === undefined ? false : process.env[name as string] !== "0")' : `(process.env[name as string] === ${JSON.stringify(v)} ? !(process.env[name as string] !== "0") : process.env[name as string] !== "0")`]),
];
const SWITCH_MUTANTS = [
  ["switch file: symbol map back to exactly 1", 'env[SYMBOL_MAP_NAME] !== "0"', 'env[SYMBOL_MAP_NAME] === "1"'],
  ["switch file: prefix match instead of the whole name", "envName === SYMBOL_MAP_NAME ?", "envName.startsWith(SYMBOL_MAP_NAME) ?"],
  ["switch file: trim before the 0 test", 'env[SYMBOL_MAP_NAME] !== "0"', 'env[SYMBOL_MAP_NAME]?.trim() !== "0"'],
  ["switch file: false counts as off", 'env[SYMBOL_MAP_NAME] !== "0"', 'env[SYMBOL_MAP_NAME] !== "0" && env[SYMBOL_MAP_NAME] !== "false"'],
];
const twoCopyCaught = [];
for (const [label, from, to] of NEWS_MUTANTS) {
  assert.equal(newsSource.split(from).length, 2, `D mutant "${label}": the text to change is not where this test expects it`);
  const bad = await twoCopyProblems(SWITCH_FILE, newsSource.replace(from, to));
  assert.ok(bad.length > 0, `D mutant "${label}" stayed green`);
  twoCopyCaught.push(label);
}
for (const [label, from, to] of SWITCH_MUTANTS) {
  assert.equal(switchSource.split(from).length, 2, `D mutant "${label}": the text to change is not where this test expects it`);
  const file = join(tmp, `two-copy-mutant-${twoCopyCaught.length}.mjs`);
  writeFileSync(file, switchSource.replace(from, to));
  const bad = await twoCopyProblems(file, newsSource);
  assert.ok(bad.length > 0, `D mutant "${label}" stayed green`);
  twoCopyCaught.push(label);
}
console.log(`D two copies: ${D_NAMES.length} names x ${D_VALUES.length} values agree; ${twoCopyCaught.length} mutants red -- PASS`);

// ---------------------------------------------------------------- C source scan
const FULL = /NEWSROOM_(?:SYMBOL_MAP|LOCATION_EVIDENCE|SPEED_AUTO_CHECKS|TOOL_RESULT_IMAGES)(?![A-Za-z0-9_])/;
const RUST_CONST = /\b(?:AUTO_CHECKS_ENV|TOOL_RESULT_IMAGES_ENV)\b/;
// where a code line may name them. JS: the three reader files, the grammar table line, and a message string in viz.mjs. Rust: the files that own or test the switches.
const JS_ALLOWED = [
  ["symbol_map_switch.mjs", () => true],
  ["location_proof.mjs", () => true],
  ["infographic.mjs", (line) => /^\s*spatial: Object\.freeze\(\{ tile_map: "NEWSROOM_TILE_MAP", symbol_map: "NEWSROOM_SYMBOL_MAP" \}\),\s*$/.test(line)],
  ["newsroom.ts", (line) => /^const ACTIVE_GRAMMAR_FORMS = Object\.freeze\(/.test(line) && line.includes('.filter(([, name]) => (name === "NEWSROOM_SYMBOL_MAP" ? process.env[name as string] !== "0" : process.env[name as string] === "1"))')], // K1199: its inline copy of the rule, pinned equal by section D
  ["viz.mjs", (line) => /errors\.push\("focus_place is only for chart_type symbol_map \(NEWSROOM_SYMBOL_MAP\); drop it"\)/.test(line)],
];
const RUST_ALLOWED = ["auto_checks.rs", "pi.rs", "anthropic_model.rs", "verify.rs", "tool_host.rs", "commands/continue_investigation.rs"];
const codePart = (line) => line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, "").replace(/\s\/\/\s.*$/, "");
function walk(dir, ext, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext, base));
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p.slice(base.length + 1));
  }
  return out;
}
function scan(files) { // files: [[kind, relpath, text]]
  const bad = [];
  for (const [kind, rel, text] of files) {
    text.split("\n").forEach((raw, i) => {
      const line = codePart(raw);
      if (kind === "js") {
        if (!FULL.test(line)) return;
        const rule = JS_ALLOWED.find(([f]) => rel === f);
        if (!rule || !rule[1](line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      } else {
        if (!FULL.test(line) && !RUST_CONST.test(line)) return;
        if (!RUST_ALLOWED.includes(rel)) bad.push(`src/${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  return bad;
}
const files = [
  ...walk(PI, [".mjs", ".ts"]).map((rel) => ["js", rel, readFileSync(join(PI, rel), "utf8")]),
  ...walk(join(ROOT, "src"), [".rs"]).map((rel) => ["rs", rel, readFileSync(join(ROOT, "src", rel), "utf8")]),
];
assert.ok(files.some(([, rel]) => rel === "newsroom.ts") && files.some(([, rel]) => rel === "agent_serve.rs"), "C: the scan is not looking at the code any more");
assert.deepEqual(scan(files), [], "C: a switch name is read outside the allowlisted places");
// a name that only shares a prefix is not a read of the switch
assert.deepEqual(scan([...files, ["js", "choropleth.mjs", 'const crop = process.env.NEWSROOM_SYMBOL_MAP_CROP === "1";']]), [], "C: NEWSROOM_SYMBOL_MAP_CROP must not be reported");
const withLine = (kind, rel, line) => scan([...files, [kind, rel, line]]);
const SCAN_MUTANTS = [
  ["bracket read of NEWSROOM_SYMBOL_MAP", "js", "choropleth.mjs", 'const on = process.env["NEWSROOM_SYMBOL_MAP"] === "1";'],
  ["dot read of NEWSROOM_SYMBOL_MAP", "js", "newsroom.ts", 'const on = process.env.NEWSROOM_SYMBOL_MAP === "1";'],
  ["destructured read", "js", "viz.mjs", "const { NEWSROOM_SYMBOL_MAP } = process.env;"],
  ["env parameter read of NEWSROOM_LOCATION_EVIDENCE", "js", "newsroom.ts", 'const on = env.NEWSROOM_LOCATION_EVIDENCE === "1";'],
  ["second table line in infographic.mjs", "js", "infographic.mjs", 'const gate = process.env["NEWSROOM_SYMBOL_MAP"];'],
  ["a second, different rule line in newsroom.ts", "js", "newsroom.ts", 'const on = name === "NEWSROOM_SYMBOL_MAP" ? process.env[name] === "1" : false;'],
  ["the grammar table line with the rule changed", "js", "newsroom.ts", 'const ACTIVE_GRAMMAR_FORMS = Object.freeze(x.filter(([, name]) => (name === "NEWSROOM_SYMBOL_MAP" ? process.env[name as string] === "1" : process.env[name as string] === "1")));'],
  ["Rust env::var of the location evidence name", "rs", "agent_serve.rs", 'let on = std::env::var("NEWSROOM_LOCATION_EVIDENCE").is_ok();'],
  ["Rust constant AUTO_CHECKS_ENV outside the owners", "rs", "agent_serve.rs", "let on = std::env::var(AUTO_CHECKS_ENV).as_deref() == Ok(\"1\");"],
  ["Rust constant TOOL_RESULT_IMAGES_ENV outside the owners", "rs", "agent_loop.rs", "let on = std::env::var(TOOL_RESULT_IMAGES_ENV).is_ok();"],
];
const scanCaught = [];
for (const [label, kind, rel, line] of SCAN_MUTANTS) {
  const found = withLine(kind, rel, line);
  assert.ok(found.length > 0, `C mutant "${label}" stayed green`);
  scanCaught.push(label);
}
console.log(`C source scan: ${files.length} files, no read outside the allowlist; CROP not reported; ${scanCaught.length} mutants red -- PASS`);
