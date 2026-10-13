#!/usr/bin/env node
// K330: cross_calls.tool_pin pins the class-B rows of K320 (K325 wave 1) per tool: today's static closure, shrink only, read by the ratchet and the replay
// checker only. Checks: the real table is green; a call added from a tool outside a list is red (mutation proof on the real newsroom.ts); stale/shrink-only;
// the two write exceptions (recordedInputState, materializeComputationRowTables) go red when their module code gains a direct write other than the injected
// writer; deriveClaimVerification outside recordClaimArtifact is called only with the literal {} and that gives publishable=false; the run-time record for a
// pinned function keeps its old shape (no tool_allowed); the checker exits 1 on a tool outside a pin.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const scratch = makeTestTmp("k330-");
const groupsJson = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const known = groupsJson.cross_calls;
const { analyze, blank, topLevel, compareToolPin, runtimeOnlyProblems, RUNTIME_ONLY_KEY, pinnedTools, shrinkBaseline, writeExceptionProblems } = await import(pathToFileURL(join(ROOT, "scripts/test_group_cross_calls.mjs")).href);
const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const readModule = (spec) => {
  const base = join(ROOT, "runtime/pi", spec);
  for (const candidate of [base, base.replace(/\.js$/, ".mjs"), base.replace(/\.js$/, ".ts")]) if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  return null;
};
const run = (text) => analyze({ src: text, groupsJson, readModule });
const KEYS = {
  "computation_rows.mjs::deriveComputationInputs": "#1, #28",
  "computation_rows.mjs::materializeComputationRowTables": "#3, #30",
  "computation_rows.mjs::recordedInputState": "#4, #31",
  "decision_writer.mjs::decisionWriter": "#23",
  "evidence_gate.mjs::assertComputationBoundToSources": "#36",
  "evidence_gate.mjs::assertDatasetPayload": "#37",
  "evidence_gate.mjs::assertEvidenceBackedStatus": "#38",
  "evidence_gate.mjs::deriveClaimVerification": "#40",
  knowledgeSide: "#44",
  "knowledge_writer.mjs::knowledgeWriter": "#46",
  "record_only.mjs::recordCriticVision": "#51",
  "record_only.mjs::recordPageLint": "#52",
  "record_only.mjs::recordVizLint": "#53",
  "shadow.mjs::runShadow": "#55",
  duckDbRun: "K335",
};

// 1. the table: exactly the 17 K320 rows (14 keys), each with its owner, a why and a sorted list of real tools outside the owner group
assert.deepEqual(Object.keys(known.tool_pin).sort(), Object.keys(KEYS).sort(), "tool_pin holds exactly the class-B keys");
assert.equal(Object.values(KEYS).filter((v) => v !== "K335").join(", ").split(", ").length, 17, "the keys cover the 17 K320 rows (duckDbRun is the K335 row)");
for (const [key, rows] of Object.entries(KEYS)) {
  const row = known.tool_pin[key];
  const line = key.includes("::") ? known.imported[key] : known.functions[key];
  assert.ok(line, `${key} is a cross_calls line`);
  assert.equal(row.owner, line.owner ?? "knowledge", `${key}: owner is the line's owner`);
  assert.ok(row.why.startsWith(rows === "K335" ? "K335 10-13 baseline = static closure today; shrink only" : `K330 10-13 baseline = static closure today; shrink only (K325 wave 1); K320 ${rows}`), `${key} says why`);
  assert.ok(row.tools.length > 0 && row.tools.every((t) => groupsJson.tools[t] && groupsJson.tools[t].group !== row.owner), `${key}: every listed tool exists and is outside the owner group`);
  assert.deepEqual([...row.tools].sort(), row.tools, `${key}: the list is sorted`);
  assert.ok(!known.tool_allow[key.split("::").pop()] && !known.tool_allow[key], `${key} is not a tool_allow name (the run-time list is unchanged)`);
}
assert.deepEqual(known.tool_pin["evidence_gate.mjs::deriveClaimVerification"].tools, ["newsroom_viz_lint", "newsroom_viz_plan", "newsroom_viz_render"], "row 40: the three viz tools");
assert.equal(known.tool_pin["shadow.mjs::runShadow"].tools.length, 17, "row 55: runShadow pinned to its 17 tools");
assert.ok(known.imported["shadow.mjs::runShadow"] && !known.imported["shadow.mjs::runShadow"].why.startsWith("设计上共用"), "row 55: the import line stays (not reclassified to A): the tripwire");
const current = run(src);
assert.deepEqual(current.problems, [], "every tool is recognised");
assert.deepEqual(compareToolPin(current, known), [], "the real table is green");
console.log("table -- PASS");

// 2. mutation proof: a tool outside a list (and outside the owner group) gets a call to the function -> red for exactly that tool and key
const localOf = (key) => current.importLocal.get(key) ?? key;
for (const key of Object.keys(KEYS)) {
  const row = known.tool_pin[key];
  const outsider = Object.keys(groupsJson.tools).find((t) => groupsJson.tools[t].group !== row.owner && groupsJson.tools[t].group !== "knowledge" && !row.tools.includes(t) && !(row.runtime_only ?? []).includes(t) && new RegExp(`name: "${t}"`).test(src));
  assert.ok(outsider, `fixture: a tool outside ${key}`);
  const at = src.indexOf(`name: "${outsider}"`);
  const open = src.indexOf("{", src.indexOf(")", src.indexOf("async execute(", at)));
  const mutated = run(`${src.slice(0, open + 1)}\n      await ${localOf(key)}();${src.slice(open + 1)}`);
  const red = compareToolPin(mutated, known);
  assert.ok(red.includes(`NEW tool reaches ${key}: ${outsider} (${groupsJson.tools[outsider].group}) is not in cross_calls.tool_pin.${key}`), `${key} called from ${outsider} is red: ${red.slice(0, 3)}`);
  assert.ok(red.every((m) => !/^STALE/.test(m)), "nothing turns stale");
}
console.log("mutation (extra tool) -- PASS");

// 2b. runtime_only (K335): one row only, subset of the pre-K335 list, tools outside tools + runtime_only red, a statically visible entry red
{
  assert.deepEqual(runtimeOnlyProblems(known), [], "the real table is green");
  assert.deepEqual(Object.keys(known.tool_pin).filter((k) => known.tool_pin[k].runtime_only !== undefined), [RUNTIME_ONLY_KEY], "only one row carries runtime_only");
  const copy = () => JSON.parse(JSON.stringify(known));
  const other = copy(); other.tool_pin["computation_rows.mjs::deriveComputationInputs"].runtime_only = ["newsroom_infographic_lint"];
  assert.ok(runtimeOnlyProblems(other).some((m) => /allowed only on/.test(m)), "runtime_only on another row is red");
  const grown = copy(); grown.tool_pin[RUNTIME_ONLY_KEY].runtime_only.push("newsroom_visual_skill");
  assert.ok(runtimeOnlyProblems(grown).some((m) => /not in the pre-K335 list/.test(m)), "an addition outside the pre-K335 list is red");
  const noWhy = copy(); noWhy.tool_pin[RUNTIME_ONLY_KEY].runtime_only_why = "because";
  assert.ok(runtimeOnlyProblems(noWhy).length > 0, "a why that does not name computationInputState / K312 is red");
  // a tool outside tools + runtime_only: dropping an entry from runtime_only while the tool is not static is not detectable statically, but a static tool outside both is red
  const dropped = copy(); dropped.tool_pin[RUNTIME_ONLY_KEY].tools = dropped.tool_pin[RUNTIME_ONLY_KEY].tools.filter((t) => t !== "newsroom_viz_plan");
  assert.ok(compareToolPin(current, dropped).some((m) => m.startsWith(`NEW tool reaches ${RUNTIME_ONLY_KEY}: newsroom_viz_plan`)), "a static tool outside tools + runtime_only is red");
  const visible = copy(); visible.tool_pin[RUNTIME_ONLY_KEY].runtime_only.push("newsroom_viz_plan");
  assert.ok(compareToolPin(current, visible).some((m) => /runtime_only: newsroom_viz_plan is statically visible/.test(m)), "a runtime_only entry that is statically visible is red");
  console.log("mutation (runtime_only) -- PASS");
}

// 3. shrink only
const KEY = "shadow.mjs::runShadow";
const ghostTool = Object.keys(groupsJson.tools).find((t) => groupsJson.tools[t].group === "visual" && !known.tool_pin[KEY].tools.includes(t));
const withGhost = { ...known, tool_pin: { ...known.tool_pin, [KEY]: { ...known.tool_pin[KEY], tools: [...known.tool_pin[KEY].tools, ghostTool] } } };
assert.ok(compareToolPin(current, withGhost).includes(`STALE tool_pin.${KEY}: ${ghostTool} no longer reaches it; please delete it from the list`), "a listed tool that does not reach the function is stale");
const shrunk = shrinkBaseline(current, withGhost);
assert.deepEqual(shrunk.tool_pin[KEY], known.tool_pin[KEY], "--write-baseline drops it");
assert.deepEqual(shrunk.tool_pin, known.tool_pin, "the others stay as they are");
const dropped = { ...known, tool_pin: { ...known.tool_pin, [KEY]: { ...known.tool_pin[KEY], tools: known.tool_pin[KEY].tools.slice(1) } } };
assert.ok(compareToolPin(current, dropped).some((m) => m.startsWith(`NEW tool reaches ${KEY}`)), "a tool missing from the list is red");
assert.throws(() => shrinkBaseline(current, dropped), /only get shorter/, "--write-baseline refuses to add a tool to the list");
assert.deepEqual(pinnedTools(current, KEY, "knowledge"), known.tool_pin[KEY].tools);
console.log("shrink only -- PASS");

// 4. the two write exceptions: real code holds; a direct write anywhere in the function or a module helper it reaches is red; the injected writer is allowed
const EXC = { "computation_rows.mjs::materializeComputationRowTables": ["writeRows"], "computation_rows.mjs::recordedInputState": [] };
for (const [key, injected] of Object.entries(EXC)) {
  assert.deepEqual(known.tool_pin[key].write_exception, { module: "computation_rows.mjs", injected }, `${key} carries its exception`);
  assert.deepEqual(writeExceptionProblems(key, known.tool_pin[key].write_exception, readModule), [], `${key}: the exception holds today`);
  assert.equal(known.imported[key].write, true, `${key}: the ratchet line keeps its write mark (the exception does not drop it)`);
}
const rowsText = readModule("computation_rows.mjs");
const inject = (fn, stmt) => {
  const d = topLevel(blank(rowsText)).find((x) => x.name === fn);
  assert.ok(d, `fixture: ${fn} is in computation_rows.mjs`);
  const open = rowsText.indexOf("{", rowsText.indexOf(")", rowsText.indexOf(`function ${fn}(`)));
  assert.ok(open > d.start && open < d.end);
  return `${rowsText.slice(0, open + 1)}\n  ${stmt}${rowsText.slice(open + 1)}`;
};
const mutatedModule = (text) => (spec) => (spec === "computation_rows.mjs" ? text : readModule(spec));
const WRITES = ['await writeFile("x", "y");', 'appendFileSync("x", "y");', 'await mkdir("x");', 'renameSync("a", "b");', 'await rm("x");', 'unlinkSync("x");', 'await writeArtifactBytes("x", "y");', "await saveQueryRows(1, 2);", "await knowledgeWriter().writeQueryRows(1);", "await decisionWriter().write(1);", 'createWriteStream("x");'];
for (const [key, injected] of Object.entries(EXC)) {
  const fn = key.split("::").pop();
  for (const stmt of WRITES) {
    const red = writeExceptionProblems(key, known.tool_pin[key].write_exception, mutatedModule(inject(fn, stmt)));
    assert.ok(red.length && red[0].includes("gained a direct write"), `${fn} + ${stmt} is red: ${red}`);
  }
  for (const p of injected) assert.deepEqual(writeExceptionProblems(key, known.tool_pin[key].write_exception, mutatedModule(inject(fn, `await ${p}("runtime/query-rows/x", []);`))), [], `${fn}: a further call to the injected ${p} stays green`);
}
// a helper it reaches counts too: recordedInputState -> classifyInputs
const viaHelper = writeExceptionProblems("computation_rows.mjs::recordedInputState", known.tool_pin["computation_rows.mjs::recordedInputState"].write_exception, mutatedModule(inject("classifyInputs", 'await rename("a", "b");')));
assert.ok(viaHelper.some((m) => m.includes("classifyInputs") && m.includes("rename")), `a write in a reached helper is red: ${viaHelper}`);
// the injected name is only a pass for that name: writeRows is not injected into recordedInputState, but it is not a write primitive either; a renamed writer is
const renamed = writeExceptionProblems("computation_rows.mjs::materializeComputationRowTables", { module: "computation_rows.mjs", injected: [] }, mutatedModule(inject("materializeComputationRowTables", "await saveQueryRows(1, 2);")));
assert.ok(renamed.length, "an empty injected list allows nothing");
console.log("write exceptions -- PASS");

// 5. row 40: deriveClaimVerification outside recordClaimArtifact is only ever called with the literal {} (all gates false, publishable=false)
const { deriveClaimVerification } = await import(pathToFileURL(join(ROOT, "runtime/pi/evidence_gate.mjs")).href);
const empty = deriveClaimVerification({});
assert.equal(empty.publishable, false, "deriveClaimVerification({}) is not publishable");
for (const gate of ["source_resolved", "extraction_passed", "computation_replayed", "claim_supported"]) assert.equal(empty[gate], false, `{}: ${gate} is false`);
export function verificationSites(text) {
  const clean = blank(text);
  const decls = topLevel(clean);
  const problems = [];
  const sites = [];
  for (const m of clean.matchAll(/\bderiveClaimVerification\s*\(/g)) {
    if (/import\s*\{[^}]*$/.test(clean.slice(Math.max(0, m.index - 2000), m.index))) continue;
    const owner = decls.find((d) => d.start <= m.index && m.index < d.end)?.name ?? null;
    let depth = 0, end = m.index + m[0].length - 1;
    for (; end < text.length; end++) { if (clean[end] === "(") depth++; else if (clean[end] === ")" && --depth === 0) break; }
    const arg = text.slice(m.index + m[0].length, end).trim();
    sites.push({ owner, arg });
    if (owner === "recordClaimArtifact") continue;
    if (owner !== "chartVerificationStamp") problems.push(`deriveClaimVerification is called in ${owner}: only chartVerificationStamp (with {}) and recordClaimArtifact may call it`);
    else if (arg !== "{}") problems.push(`chartVerificationStamp passes ${arg} to deriveClaimVerification: only the literal {} is allowed (model output cannot grant verification)`);
  }
  if (!sites.some((s) => s.owner === "chartVerificationStamp")) problems.push("chartVerificationStamp no longer calls deriveClaimVerification({}): re-check row 40");
  return { sites, problems };
}
const real = verificationSites(src);
assert.deepEqual(real.problems, [], `row 40 call sites: ${real.problems}`);
assert.deepEqual(real.sites.map((s) => s.owner).sort(), ["chartVerificationStamp", "recordClaimArtifact"], "exactly two call sites");
// viz_lint and viz_render reach it, but never recordClaimArtifact: their only route is the {} site
const viaClaim = current.toolsByFunction("recordClaimArtifact");
for (const t of ["newsroom_viz_lint", "newsroom_viz_render"]) {
  assert.ok(current.toolsByFunction(current.importLocal.get("evidence_gate.mjs::deriveClaimVerification")).includes(t), `${t} reaches deriveClaimVerification`);
  assert.ok(!viaClaim.includes(t), `${t} does not reach recordClaimArtifact`);
}
assert.ok(current.toolsByFunction("chartVerificationStamp").includes("newsroom_viz_lint") && current.toolsByFunction("chartVerificationStamp").includes("newsroom_viz_render"), "both reach chartVerificationStamp");
const SITE = "verification: record?.verification ?? deriveClaimVerification({}),";
assert.equal(src.split(SITE).length, 2, "fixture: the stamp line is there once");
for (const arg of ["{ source_resolved: true }", "record", "{ ...record }", "input.verification", "{ claim_supported: true, publishable: true }"]) {
  const bad = verificationSites(src.replace(SITE, `verification: record?.verification ?? deriveClaimVerification(${arg}),`));
  assert.ok(bad.problems.some((m) => m.includes("only the literal {}")), `deriveClaimVerification(${arg}) is red`);
}
const extra = verificationSites(src.replace("function chartVerificationStamp(", "function strayStamp() { return deriveClaimVerification({}); }\nfunction chartVerificationStamp("));
assert.ok(extra.problems.some((m) => m.includes("called in strayStamp")), "a new call site elsewhere is red, even with {}");
console.log("row 40 call sites -- PASS");

// 6. the run-time record of a pinned function keeps its old shape (tool_pin is not read at run time), and the checker judges it from the table
const groups = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const outsider = Object.keys(groupsJson.tools).find((t) => groupsJson.tools[t].group === "visual" && !known.tool_pin[KEY].tools.includes(t) && known.imported[KEY].groups.includes("visual"));
const listed = known.tool_pin[KEY].tools.find((t) => groupsJson.tools[t].group === "visual");
const newRun = (name) => { const dir = join(scratch, name); mkdirSync(dir, { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = dir; return dir; };
const rowsOf = (dir) => { const p = join(dir, "runtime/cross-call-report.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []; };
process.env.NEWSROOM_GROUP_CALL_REPORT = "1";
let dir = newRun("on");
groups.runInTool(outsider, () => groups.noteCrossCall(dir, KEY));
const lines = rowsOf(dir);
assert.equal(lines.length, 1, "one line");
assert.deepEqual(Object.keys(JSON.parse(lines[0])), ["tool", "tool_group", "function", "callee_owner", "declared"], "a pinned function's line has no tool_allowed field (run-time bytes unchanged)");
delete process.env.NEWSROOM_GROUP_CALL_REPORT;
const checker = (target) => spawnSync(process.execPath, [join(ROOT, "scripts/check_cross_call_report.mjs"), target, "--groups", join(ROOT, "runtime/pi/groups.json")], { encoding: "utf8" });
let result = checker(dir);
assert.equal(result.status, 1, `the checker fails on a tool outside the pin: ${result.stdout}`);
assert.match(result.stdout, new RegExp(`NOT ALLOWED visual ${outsider} -> ${KEY.replace(/[.]/g, "\\.")}: tool is not in cross_calls\\.tool_pin`));
const clean = newRun("clean");
mkdirSync(join(clean, "runtime"), { recursive: true });
writeFileSync(join(clean, "runtime/cross-call-report.jsonl"), JSON.stringify({ tool: listed, tool_group: "visual", function: KEY, callee_owner: "knowledge", declared: true }) + "\n");
result = checker(clean);
assert.equal(result.status, 0, `a pinned tool is green: ${result.stdout}`);
assert.match(result.stdout, /1 record\(s\), 0 undeclared pair\(s\), 0 tool-not-allowed pair\(s\)/);
console.log("run-time record and checker -- PASS");
console.log("K330 tool_pin -- PASS");
