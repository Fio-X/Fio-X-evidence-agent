// NEWSROOM_TOOL_ERROR_HINTS (default off, only "1" turns it on), third batch: a missing or too-short object field is listed with its whole subtree of required
// fields in the same error, read from the schema the check ran against (runtime/pi/tool_host_schema.mjs); the accessibility fields say before the call which
// module types require them. Only text changes: the errors, and so the refused inputs, are the same on and off; off the text and the tool schema are what
// they were. The fixtures are real failing calls from a recorded German run (scripts/fixtures/k1589: the tool's schema of that run and the arguments
// as sent, long text values replaced by "x"): the later errors of that run name fields the first error did not; here the first error already names them.
// Each mutant changes one line of product code in a temporary copy of runtime/pi; the run of this same file against it must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOT = process.env.K_ROOT ?? REPO;

const HOST = "runtime/pi/tool_host_schema.mjs";
const MUTANTS = {
  "subtree-hint-always": [HOST, '...(process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? subtreeLines(errors, notes) : [])', "...(true ? subtreeLines(errors, notes) : [])"],
  "subtree-hint-never": [HOST, '...(process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? subtreeLines(errors, notes) : [])', "...(false ? subtreeLines(errors, notes) : [])"],
  "subtree-cap-off-by-one": [HOST, "const shown = fields.slice(0, SUBTREE_LINES_MAX);", "const shown = fields.slice(0, SUBTREE_LINES_MAX + 1);"],
  "subtree-cap-count-wrong": [HOST, "(+${fields.length - shown.length} more)", "(+${fields.length - shown.length - 1} more)"],
  "subtree-no-min-items": [HOST, 'if (child?.type === "array" && child.minItems !== undefined) bits.push(', "if (false) bits.push("],
  "subtree-no-enum-values": [HOST, 'if (child?.type === "array" && Array.isArray(child.items?.enum)) bits.push(', "if (false) bits.push("],
  "subtree-no-recursion": [HOST, "if (child && (child.type === \"object\" || (child.type === \"array\" && child.items?.type === \"object\"))) subtreeFields(", "if (false) subtreeFields("],
  "subtree-no-array-items": [HOST, 'const node = sub.type === "array" && sub.items ? sub.items : sub;', "const node = sub;"],
  "subtree-short-array-skipped": [HOST, 'message.startsWith("Expected array length >=")', "false"],
  "subtree-hand-shape": [HOST, "out.push(`${into}${key}${shape}", "out.push(`${into}${key}(string)"],
  "check-relaxed": [HOST, 'if (key in value) continue;\n      const at', "if (true) continue;\n      const at"],
  "a11y-hint-never": ["runtime/pi/newsroom.ts", 'Type.String(process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? { description: accessibilityRequiredText("summary") } : {})', "Type.String({})"],
  "a11y-hint-always": ["runtime/pi/newsroom.ts", 'Type.String(process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? { description: accessibilityRequiredText("summary") } : {})', 'Type.String({ description: accessibilityRequiredText("summary") })'],
  "a11y-list-diverges": ["runtime/pi/publication.mjs", "export const ACCESSIBILITY_EXEMPT_TYPES=['text'];", "export const ACCESSIBILITY_EXEMPT_TYPES=['text','stat'];"],
  "a11y-validator-hand-copied": ["runtime/pi/publication.mjs", "const dataBearing=!ACCESSIBILITY_EXEMPT_TYPES.includes(m.type);", "const dataBearing=!['text','stat'].includes(m.type);"],
  "a11y-check-site-hand-copied": ["runtime/pi/newsroom.ts", "!ACCESSIBILITY_EXEMPT_TYPES.includes(m?.type) && (!String", 'm?.type !== "text" && (!String'],
};

const check = (name) => console.log(`  ok  ${name}`);
const withHints = (value, fn) => {
  const before = process.env.NEWSROOM_TOOL_ERROR_HINTS;
  if (value === undefined) delete process.env.NEWSROOM_TOOL_ERROR_HINTS; else process.env.NEWSROOM_TOOL_ERROR_HINTS = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_TOOL_ERROR_HINTS; else process.env.NEWSROOM_TOOL_ERROR_HINTS = before; }
};
const fixture = (label) => JSON.parse(readFileSync(join(REPO, `scripts/fixtures/k1589/${label}.json`), "utf8"));
const head = (text) => text.split("\n\nArguments as sent")[0];

async function main() {
  const base = pathToFileURL(join(ROOT, "runtime/pi")).href;
  const host = await import(`${base}/tool_host_schema.mjs`);
  const { validationFailure, validate, SUBTREE_LINES_MAX } = host;
  const text = (name, schema, args, setting) => withHints(setting, () => validationFailure(name, schema, args));

  // ---- 1. nested subtrees ------------------------------------------------------------------------------------------------------
  // What the schema requires below a field, walked here independently of the product code: every dotted path of a required field, arrays as [].
  const requiredBelow = (sub, prefix, out = []) => {
    const node = sub.type === "array" && sub.items ? sub.items : sub;
    const into = node === sub ? `${prefix}.` : `${prefix}[].`;
    for (const key of node.required ?? []) {
      out.push(`${into}${key}`);
      const child = node.properties[key];
      if (child.type === "object" || (child.type === "array" && child.items?.type === "object")) requiredBelow(child, `${into}${key}`, out);
    }
    return out;
  };
  const later = {
    // fields the recorded run's later errors named although the first error did not
    r16: ["story_graph.nodes[].summary", "story_graph.nodes[].explanatory_dimension", "story_graph.nodes[].kind", "story_graph.edges[].relation"],
    r26: ["editorial_grammar.project_id", "editorial_grammar.available_renderer_capabilities", "scene_graph.schema_version", "scene_graph.scenes[].pattern", "scene_graph.scenes[].sidecar_module_ids", "scene_graph.scenes[].scene_budget.max_supporting_objects"],
    r37: ["modules[].explanatory_dimension", "modules[].type", "modules[].story_node_ids"],
  };
  for (const label of ["r16", "r26", "r37"]) {
    const { tool, schema, arguments: args } = fixture(label);
    const off = text(tool, schema, args, undefined), on = text(tool, schema, args, "1");
    assert.equal(off.ok, false); assert.equal(on.ok, false);
    assert.ok(!head(off.text).includes("needs these required fields"), `${label} off: no subtree lines`);
    // on = off plus lines at the end of the error list; nothing of the off text changes
    const offLines = head(off.text).split("\n"), onLines = head(on.text).split("\n");
    assert.deepEqual(onLines.slice(0, offLines.length), offLines, `${label}: the off lines come first, unchanged`);
    const extra = onLines.slice(offLines.length);
    assert.ok(extra.length >= 1 && extra.every((line) => /^ {2}- \S+ needs these required fields: /.test(line)), `${label}: only subtree lines are added`);
    assert.equal(on.text.slice(on.text.indexOf("\n\nArguments as sent")), off.text.slice(off.text.indexOf("\n\nArguments as sent")), `${label}: the echo of the arguments is the same`);
    const shown = extra.join("\n");
    for (const path of later[label]) assert.ok(shown.includes(`${path} (`) || shown.includes(`${path};`) || shown.endsWith(path), `${label}: the first error already names ${path}`);
    // completeness against the schema, walked independently: every required path below every listed parent is named
    const parents = extra.map((line) => /^ {2}- (\S+) needs/.exec(line)[1]);
    for (const parent of parents) {
      const walk = (sub, segs) => segs.length ? walk(((sub.type === "array" ? sub.items : sub).properties)[segs[0]], segs.slice(1)) : sub;
      const sub = walk(schema, parent.split("."));
      const wanted = requiredBelow(sub, parent);
      if (wanted.length <= SUBTREE_LINES_MAX) for (const path of wanted) assert.ok(shown.includes(path), `${label}: ${parent} lists ${path}`);
    }
    // the same inputs are refused on and off: errors are untouched
    const errorsOf = (setting) => withHints(setting, () => validate(schema, host.convert(schema, args)));
    assert.deepEqual(errorsOf("1"), errorsOf(undefined), `${label}: same error list`);
  }
  check("subtrees: for the three recorded failing calls the first error already names the fields the later errors named; the off lines are unchanged and come first");

  // off text, pinned byte for byte on the shortest fixture
  const r37 = fixture("r37");
  const offText = text(r37.tool, r37.schema, r37.arguments, undefined).text;
  assert.equal(head(offText), 'Tool "newsroom_publication_plan" rejected its arguments:\n  - title: Expected required property (string)\n  - dek: Expected required property (string)\n  - reader_question: Expected required property (string)\n  - visual_thesis: Expected required property (string)\n  - modules: Expected required property (array of object)');
  for (const value of ["0", "", "true", "2", " 1"]) assert.equal(text(r37.tool, r37.schema, r37.arguments, value).text, offText, `switch value ${JSON.stringify(value)} keeps the old text`);
  check("subtrees: off text pinned byte for byte; only the exact value 1 turns the lines on");

  // the refused set: every field of the recorded arguments dropped in turn, and the call fixed up, is refused or accepted alike on and off
  const { schema: s26, arguments: a26, tool: t26 } = fixture("r26");
  const variants = [a26, {}, { ...a26, modules: [] }, { ...a26, scene_graph: {} }, { ...a26, editorial_grammar: {} }];
  for (const key of Object.keys(a26)) { const copy = { ...a26 }; delete copy[key]; variants.push(copy); }
  for (const variant of variants) assert.equal(text(t26, s26, variant, "1").ok, text(t26, s26, variant, undefined).ok, "same accept/refuse");
  check("subtrees: the same arguments are refused on and off (recorded call, emptied parents, each field dropped in turn)");

  // too-short arrays: the item subtree is listed when the array is present but shorter than minItems
  const short = { type: "object", required: ["rows"], properties: { rows: { type: "array", minItems: 2, items: { type: "object", required: ["id", "kind"], properties: { id: { type: "string" }, kind: { type: "string", enum: ["a", "b"] } } } } } };
  const tagged = { type: "object", required: ["box"], properties: { box: { type: "object", required: ["tags"], properties: { tags: { type: "array", minItems: 2, items: { type: "string", enum: ["x1", "x2"] } } } } } };
  const taggedOn = head(text("t", tagged, {}, "1").text);
  assert.ok(taggedOn.includes("box.tags (array of string) [at least 2 items; each one of \"x1\", \"x2\"]"), taggedOn);
  const shortOn = text("t", short, { rows: [{ id: "1", kind: "a" }] }, "1").text;
  assert.ok(shortOn.includes("rows needs these required fields: rows[].id (string); rows[].kind (string; one of \"a\", \"b\")"), shortOn);
  assert.ok(!text("t", short, { rows: [{ id: "1", kind: "a" }] }, undefined).text.includes("needs these"), "off: nothing added");
  check("subtrees: a present but too short array lists its item fields");

  // the cap: a constant, with the rest counted
  const wide = { type: "object", required: ["box"], properties: { box: { type: "object", required: Array.from({ length: SUBTREE_LINES_MAX + 7 }, (_, i) => `f${i}`), properties: Object.fromEntries(Array.from({ length: SUBTREE_LINES_MAX + 7 }, (_, i) => [`f${i}`, { type: "string" }])) } } };
  const cut = text("t", wide, {}, "1").text;
  const line = head(cut).split("\n").find((l) => l.includes("box needs these"));
  assert.equal(line.split("; ").length - 1, SUBTREE_LINES_MAX, "exactly the cap listed, plus the count");
  assert.ok(line.endsWith("; (+7 more)"), line);
  assert.ok(line.includes(`box.f${SUBTREE_LINES_MAX - 1} (string)`) && !line.includes(`box.f${SUBTREE_LINES_MAX} (string)`), "the cap cuts at the constant");
  const exact = { ...wide, properties: { box: { ...wide.properties.box, required: wide.properties.box.required.slice(0, SUBTREE_LINES_MAX) } } };
  assert.ok(!head(text("t", exact, {}, "1").text).includes("more)"), "a subtree of exactly the cap is listed whole");
  assert.equal(SUBTREE_LINES_MAX, 40, "the cap is the registered constant");
  check("subtrees: capped at SUBTREE_LINES_MAX with a '+N more' count; exactly the cap is listed whole");

  // ---- 2. accessibility fields ---------------------------------------------------------------------------------------------------
  const { ACCESSIBILITY_EXEMPT_TYPES, MODULE_TYPES, accessibilityRequiredText } = await import(`${base}/publication.mjs`);
  assert.deepEqual(ACCESSIBILITY_EXEMPT_TYPES, ["text"], "text modules carry no data and are the only type the plan tool exempts");
  const sentence = accessibilityRequiredText("summary");
  const listed = sentence.split("whose type is ")[1].split(";")[0].split(", ");
  assert.deepEqual(listed, [...MODULE_TYPES].filter((type) => !ACCESSIBILITY_EXEMPT_TYPES.includes(type)), "the text lists exactly the types the list requires it of");
  // the checks in the plan tool read the same list: no hand-written "text" test is left beside it
  const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.equal(source.split("ACCESSIBILITY_EXEMPT_TYPES.includes(").length - 1, 4, "the four checks read the list");
  assert.equal(/type !== "text"/.test(source), false, "no check is written beside the list");
  check("accessibility: the text lists the types the list requires it of; every check reads the same list");
  // the publication validator reads the same list: the types it asks accessibility text of are exactly MODULE_TYPES minus the list
  const { validatePublicationSpec } = await import(`${base}/publication.mjs`);
  const asked = [...MODULE_TYPES].filter((type) => validatePublicationSpec({ schema_version: "0.3.0", modules: [1, 2].map((n) => ({ id: `m${n}`, type, story_node_ids: ["n1"] })) }).some((e) => e.includes("accessibility summary and long_description required")));
  assert.deepEqual(asked, listed, "the validator asks accessibility text of exactly the types the text lists");
  check("accessibility: the publication validator asks it of exactly the listed types");

  const tmp = mkdtempSync(join(tmpdir(), "k1589-"));
  try {
    cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
    cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
    const stub = (name, body) => { mkdirSync(join(tmp, "node_modules", name), { recursive: true }); writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" })); writeFileSync(join(tmp, "node_modules", name, "index.js"), body); };
    stub("typebox", "const builder = (kind) => (...args) => ({ kind, args });\nexport const Type = new Proxy({}, { get: (_, kind) => builder(kind) });\n");
    stub("@earendil-works/pi-ai", "export const StringEnum = (values, options) => ({ kind: 'enum', values, options });\n");
    const pi = join(tmp, "runtime", "pi");
    writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
    const mod = await import(pathToFileURL(join(pi, "newsroom.test-copy.mjs")).href);
    const publicationPlan = (setting) => withHints(setting, () => {
      process.env.NEWSROOM_TOOL_PROFILE = "full";
      const tools = new Map();
      mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
      const tool = tools.get("newsroom_publication_plan");
      return JSON.stringify({ description: tool.description, parameters: tool.parameters });
    });
    const off = publicationPlan(undefined), on = publicationPlan("1");
    assert.ok(!off.includes("Without it the plan is refused"), "off: no accessibility sentence");
    assert.equal(on.split("Without it the plan is refused").length - 1, 2, "on: once on each of the two fields");
    for (const value of ["0", "", "true", "2", " 1"]) assert.equal(publicationPlan(value), off, `switch value ${JSON.stringify(value)}: the schema is the off schema`);
    check("accessibility: on adds one sentence to each of the two fields; off, and every other switch value, is the off schema");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

await main();
if (!process.env.K_MUTANT) {
  const names = Object.keys(MUTANTS);
  const results = [];
  for (const name of names) {
    const [file, from, to] = MUTANTS[name];
    const dir = mkdtempSync(join(tmpdir(), "k1589m-"));
    try {
      cpSync(join(REPO, "runtime/pi"), join(dir, "runtime/pi"), { recursive: true });
      cpSync(join(REPO, "config"), join(dir, "config"), { recursive: true });
      const path = join(dir, file);
      const source = readFileSync(path, "utf8");
      if (source.split(from).length !== 2) { console.error(`could not apply mutant ${name}: anchor occurs ${source.split(from).length - 1} times`); process.exit(2); }
      writeFileSync(path, source.replace(from, () => to));
      const run = spawnSync(process.execPath, [SELF], { env: { ...process.env, K_ROOT: dir, K_MUTANT: name }, encoding: "utf8" });
      results.push([name, run.status !== 0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  for (const [name, red] of results) console.log(`  ${red ? "red " : "GREEN"} ${name}`);
  assert.ok(results.every(([, red]) => red), "every mutant must turn the test red");
  console.log(`tool error hints (nested subtrees, accessibility): PASS (${names.length} mutants red)`);
}
