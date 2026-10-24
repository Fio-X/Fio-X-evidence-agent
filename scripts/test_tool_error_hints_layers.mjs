// NEWSROOM_TOOL_ERROR_HINTS (default off, only "1" turns it on): the map layer-type refusal and the three reader-question closure
// refusals say which values are allowed and where the missing ids go. Only the text changes: the set of refused inputs is the same on and
// off. The allowed values in the text are read back against the validators themselves, not against a copy. Each mutant changes one line
// of product code in a temporary copy of runtime/pi; the run of this same file against it must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOT = process.env.K_ROOT ?? REPO;

const MUTANTS = {
  "layer-hint-always": ["runtime/pi/map_spec.mjs", "process.env.NEWSROOM_TOOL_ERROR_HINTS==='1'?", "true?"],
  "layer-hint-never": ["runtime/pi/map_spec.mjs", "process.env.NEWSROOM_TOOL_ERROR_HINTS==='1'?", "false?"],
  "layer-allowed-hand-copied": ["runtime/pi/map_spec.mjs", "use one of ${[...LAYER_TYPES].filter(t=>t!=='polygon').join(', ')}", "use one of observations, line, reference_points, reference_lines, area"],
  "layer-polygon-offered": ["runtime/pi/map_spec.mjs", "[...LAYER_TYPES].filter(t=>t!=='polygon')", "[...LAYER_TYPES]"],
  "layer-check-relaxed": ["runtime/pi/map_spec.mjs", "if(!LAYER_TYPES.has(l.type))errors.push(", "if(false)errors.push("],
  "layer-check-tightened": ["runtime/pi/map_spec.mjs", "const LAYER_TYPES=new Set(['observations','line','polygon','reference_points','reference_lines']);", "const LAYER_TYPES=new Set(['observations','polygon','reference_points','reference_lines']);"],
  "closure-hint-always": ["runtime/pi/infographic.mjs", 'process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? `${code}', "true ? `${code}"],
  "closure-hint-never": ["runtime/pi/infographic.mjs", 'process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? `${code}', "false ? `${code}"],
  "closure-no-missing-ids": ["runtime/pi/infographic.mjs", "Missing: ${missing.join(\", \")}.", "Missing: none."],
  "closure-entry-check-relaxed": ["runtime/pi/infographic.mjs", "if (closure.covered_entry_node_ids.length !== (storyGraph.entry_node_ids ?? []).length) blockers.push(", "if (false) blockers.push("],
  "closure-answer-check-relaxed": ["runtime/pi/infographic.mjs", "if (closure.covered_answer_node_ids.length !== (storyGraph.answer_node_ids ?? []).length) blockers.push(", "if (false) blockers.push("],
  "closure-resolution-check-relaxed": ["runtime/pi/infographic.mjs", "if (closure.resolved_answer_node_ids.length !== (storyGraph.answer_node_ids ?? []).length) blockers.push(", "if (false) blockers.push("],
  "closure-roles-list-diverges": ["runtime/pi/infographic.mjs", 'const RESOLUTION_STORY_ROLES = ["resolution", "explanation"];', 'const RESOLUTION_STORY_ROLES = ["resolution", "explanation", "context"];'],
  "closure-hint-roles-hand-copied": ["runtime/pi/infographic.mjs", "one of ${RESOLUTION_STORY_ROLES.join(\", \")}", "one of resolution, conclusion"],
};

async function main() {
  const base = pathToFileURL(join(ROOT, "runtime/pi")).href;
  // The modules read the switch when called, so one import serves both settings.
  const { validateMapSpec } = await import(`${base}/map_spec.mjs`);
  const { evaluateInfographicSynthesis } = await import(`${base}/infographic.mjs`);
  const withHints = (value, fn) => {
    const before = process.env.NEWSROOM_TOOL_ERROR_HINTS;
    if (value === undefined) delete process.env.NEWSROOM_TOOL_ERROR_HINTS; else process.env.NEWSROOM_TOOL_ERROR_HINTS = value;
    try { return fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_TOOL_ERROR_HINTS; else process.env.NEWSROOM_TOOL_ERROR_HINTS = before; }
  };
  const check = (name) => console.log(`  ok  ${name}`);

  // ---- map layer type --------------------------------------------------------------------------------------------------------
  const layerErrors = (type, setting) => withHints(setting, () => validateMapSpec({ schema_version: "0.2.0", layers: [{ id: "l1", type }] }).errors.filter((e) => e.startsWith("layers[0].type")));
  const pool = ["observations", "line", "polygon", "reference_points", "reference_lines", "area", "Polygon", "", undefined, 7];
  const refused = (setting) => pool.filter((t) => layerErrors(t, setting).some((e) => e.includes("unsupported")));
  const offSet = refused(undefined);
  assert.deepEqual(offSet, ["area", "Polygon", "", undefined, 7], "off: the refused layer types are the ones that were refused");
  for (const setting of ["1"]) assert.deepEqual(refused(setting), offSet, "on: the same layer types are refused");
  for (const off of ["0", "", "true", "yes", "2", " 1"]) assert.deepEqual(layerErrors("area", off), ["layers[0].type unsupported"], `switch value ${JSON.stringify(off)} keeps the old text`);
  assert.deepEqual(layerErrors("area", undefined), ["layers[0].type unsupported"], "off: the text is what it was, byte for byte");
  check("map layer type: the refused set is the same on and off; off text unchanged; only the exact value 1 turns the hint on");

  const hinted = layerErrors("area", "1");
  assert.equal(hinted.length, 1);
  assert.ok(hinted[0].startsWith("layers[0].type unsupported (got \"area\"; use one of "), hinted[0]);
  const listed = /use one of ([^)]*)\)/.exec(hinted[0])[1].split(", ");
  const accepted = pool.filter((t) => typeof t === "string" && !layerErrors(t, undefined).some((e) => e.includes("unsupported")));
  assert.deepEqual([...listed].sort(), accepted.filter((t) => t !== "polygon").sort(), "the listed values are exactly the types the validator accepts, polygon (refused with its own text) left out");
  assert.ok(hinted[0].includes('Example: {"id":"l1","type":"reference_points"'), "one correct example");
  assert.ok(withHints("1", () => validateMapSpec({ schema_version: "0.2.0", layers: [{ id: "l1", type: "polygon" }] }).errors.some((e) => e.includes("polygon is not rendered"))), "polygon keeps its own refusal");
  check("map layer type: the hint lists the accepted types read back from the validator, polygon left out, and gives one example");

  // ---- reader-question closure -----------------------------------------------------------------------------------------------
  const node = (id, dimension) => ({ id, label: id, dimension });
  const graph = { passed: true, reader_question: "q", visual_thesis: "t", nodes: [node("n1", "cause"), node("n2", "effect"), node("n3", "scale")], edges: [], entry_node_ids: ["n1"], answer_node_ids: ["n3"] };
  const spec = (modules) => ({ schema_version: "1.5.0", reader_question: "q", visual_thesis: "t", modules });
  const closure = (modules, setting) => withHints(setting, () => evaluateInfographicSynthesis(spec(modules), {}, graph).blockers.filter((b) => b.startsWith("reader_question_closure")));
  const none = [{ id: "m1", type: "text", story_node_ids: ["n2"], story_role: "context" }];
  const noResolution = [{ id: "m1", type: "text", story_node_ids: ["n1", "n3"], story_role: "context" }];
  const closed = [{ id: "m1", type: "text", story_node_ids: ["n1"], story_role: "context" }, { id: "m2", type: "text", story_node_ids: ["n3"], story_role: "resolution" }];
  const codesOf = (list) => list.map((b) => b.split(":")[0]);
  assert.deepEqual(closure(none, undefined), ["reader_question_closure_missing_entry_coverage", "reader_question_closure_missing_answer_coverage", "reader_question_closure_missing_resolution_module"], "off: bare codes, byte for byte");
  assert.deepEqual(closure(noResolution, undefined), ["reader_question_closure_missing_resolution_module"]);
  assert.deepEqual(closure(closed, undefined), []);
  for (const modules of [none, noResolution, closed]) {
    assert.deepEqual(codesOf(closure(modules, "1")), closure(modules, undefined), "on: the same closure refusals fire");
  }
  for (const off of ["0", "", "true", "2", " 1"]) assert.deepEqual(closure(none, off), closure(none, undefined), `switch value ${JSON.stringify(off)} keeps the old text`);
  check("closure: the same refusals fire on and off (three shapes); off text is the bare code; only the exact value 1 turns the hint on");

  const [entry, answer, resolution] = closure(none, "1");
  assert.ok(entry.startsWith("reader_question_closure_missing_entry_coverage: ") && entry.includes("Missing: n1.") && entry.includes('"story_node_ids": ["n1"]'), entry);
  assert.ok(answer.includes("Missing: n3.") && answer.includes('"story_node_ids": ["n3"]'), answer);
  assert.ok(resolution.includes("Missing: n3.") && resolution.includes("story_role is one of resolution, explanation, for example") && resolution.includes('"story_role": "resolution"'), resolution);
  assert.ok(closure(noResolution, "1")[0].includes("Missing: n3."), "a node mapped to a module that does not resolve is still missing for the resolution refusal");
  // The roles named in the text are the ones the check accepts, read back from the check.
  for (const role of ["resolution", "explanation"]) assert.deepEqual(closure([{ ...closed[0] }, { ...closed[1], story_role: role }], undefined), [], `role ${role} resolves`);
  assert.deepEqual(closure([closed[0], { ...closed[1], story_role: "context" }], undefined), ["reader_question_closure_missing_resolution_module"], "another role does not resolve");
  check("closure: the hint names the missing node ids, where they go and the roles the check accepts (read back from the check)");
}

await main();
if (!process.env.K_MUTANT) {
  // Mutant runs: a temporary copy of runtime/pi with one line changed; this file runs against it and must fail.
  const names = Object.keys(MUTANTS);
  const results = [];
  for (const name of names) {
    const [file, from, to] = MUTANTS[name];
    const dir = mkdtempSync(join(tmpdir(), "k1563-"));
    try {
      cpSync(join(REPO, "runtime/pi"), join(dir, "runtime/pi"), { recursive: true });
      cpSync(join(REPO, "config"), join(dir, "config"), { recursive: true });
      const path = join(dir, file);
      const text = readFileSync(path, "utf8");
      if (text.split(from).length !== 2) { console.error(`could not apply mutant ${name}: anchor occurs ${text.split(from).length - 1} times`); process.exit(2); }
      writeFileSync(path, text.replace(from, () => to));
      const run = spawnSync(process.execPath, [SELF], { env: { ...process.env, K_ROOT: dir, K_MUTANT: name }, encoding: "utf8" });
      results.push([name, run.status !== 0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  for (const [name, red] of results) console.log(`  ${red ? "red " : "GREEN"} ${name}`);
  assert.ok(results.every(([, red]) => red), "every mutant must turn the test red");
  console.log(`tool error hints (layers, closure): PASS (${names.length} mutants red)`);
}
