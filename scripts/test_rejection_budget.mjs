// K260 (NEWSROOM_SPEED_FIRST_TRY_ALL): refusal text only. R1-: each class from the run-7 rejection budget. Off is byte-identical; every wrong call stays refused.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_FIRST_TRY_TEXT", "NEWSROOM_SPEED_FIRST_TRY_SHAPES", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL"];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const { applyJsonPatch, PatchError, sha256Of } = await import(join(ROOT, "runtime/pi/patch_retry.mjs"));
const { checkSchema } = await import(join(ROOT, "runtime/pi/tool_chain.mjs"));
// ---- loader: one type-stripped copy of the runtime, a fresh module instance per configuration -----------
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
// One type-stripped copy of the runtime per tree. withCompile=false leaves typebox/compile out (it can only be missing there).
function makeTree(withCompile) {
  const TREE = makeTestTmp("patch-tree-");
  cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
  stub(TREE, "typebox", TYPEBOX);
  if (withCompile) {
    writeFileSync(join(TREE, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
    writeFileSync(join(TREE, "node_modules", "typebox", "compile.js"), `import { checkSchema } from ${JSON.stringify(pathToFileURL(join(ROOT, "runtime/pi/tool_chain.mjs")).href)};
export const Compile = (schema) => ({ Check: (v) => checkSchema(schema, v).length === 0, Errors: (v) => checkSchema(schema, v).map((message) => ({ instancePath: "", message })) });\n`);
  }
  stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return COPY;
}
const COPY_WITH = makeTree(true);
const COPY_WITHOUT = makeTree(false);
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));

let loadN = 0;
async function registerFor(cfg, { copy = COPY_WITH, profile = "full" } = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = profile;
  delete process.env.NEWSROOM_PHASE;
  for (const [k, v] of Object.entries(cfg.env)) process.env[k] = v;
  const tools = new Map();
  const mod = await import(`${pathToFileURL(copy).href}?v=${++loadN}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}

const SW = "NEWSROOM_SPEED_FIRST_TRY_ALL";
const results = [];
const ok = async (name, f) => { await f(); results.push(name); console.log(`  ok  ${name}`); };
const ENV_BASE = { NEWSROOM_MOBILE_PAGES: "0", NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_VIZ_REPORT_ALL: "1" };
const load = async (value) => {
  const tools = await registerFor({ env: { ...ENV_BASE, ...(value === undefined ? {} : { [SW]: value }) } });
  tools.switchValue = value;
  return tools;
};
const useSwitch = (tools) => { if (tools.switchValue === undefined) delete process.env[SW]; else process.env[SW] = tools.switchValue; };
const off = await load(undefined);
const on = await load("1");
const mod = await import(`${pathToFileURL(COPY_WITH).href}?v=${++loadN}`);
const { claimTemplateProblems, fillClaimTemplate } = mod;
const fs = await import(pathToFileURL(join(ROOT, "runtime/pi/form_selection.mjs")).href);
const art = makeTestTmp("first-try-all-");
process.env.NEWSROOM_ARTIFACT_DIR = art;
const refusal = async (tools, args, tool = "newsroom_viz_plan") => { useSwitch(tools); process.env.NEWSROOM_ARTIFACT_DIR = art; try { await tools.get(tool).execute("t", JSON.parse(JSON.stringify(args))); return null; } catch (e) { return String(e.message); } };
const codesOf = (t) => [...new Set([...t.matchAll(/(?:^|\n|\(\d+\) )([A-Z][A-Z_]{3,}):/g)].map((m) => m[1]))];

// ---- C: form selection reason names what it found ------------------------------------------------------------
const cands = (reasons) => reasons.map((r, i) => ({ class: ["change", "big_number", "one_sentence"][i % 3], form: ["multi_line", "big_number", "one_sentence"][i % 3], one_line_reason: r }));
const fsParams = (reasons) => ({ chart_type: "multi_line", chosen: "multi_line", candidates: cands(reasons) });
await ok("R1 form selection: a digit and a number word are named on only; off is the old text byte for byte", () => {
  const p = fsParams(["两条线一起看起落", "只看首尾会丢掉 2022 年的高峰", "一句话"]);
  const old = fs.formSelectionRefusal(p);
  must(old.startsWith("FORM_SELECTION: candidates[0] one_line_reason must not carry a number or number word; candidates[1] one_line_reason must not carry a number or number word\n"), old.slice(0, 260));
  must(fs.formSelectionRefusal(p, {}) === old && fs.formSelectionRefusal(p, { nameHit: false }) === old, "off is unchanged");
  const named = fs.formSelectionRefusal(p, { nameHit: true });
  must(/candidates\[1\] one_line_reason must not carry a number or number word: near "[^"]*2022[^"]*"/.test(named), named.slice(0, 400));
  must(/candidates\[0\] one_line_reason must not carry a number or number word: near "[^"]*两条/.test(named), "number word named");
  must(named.replace(/: near "[^"]*"; reword it without any number or number word/g, "") === old, "the only difference is the added clause");
});
await ok("R2 form selection: a clean reason is still accepted either way", () => {
  const p = fsParams(["一起看起落", "只看首尾", "说一句"]);
  must(fs.formSelectionRefusal(p, { nameHit: true }) === fs.formSelectionRefusal(p) , "same");
});

// ---- E / F: grammar and declaration refusals ------------------------------------------------------------------
const MS = [{ id: "m1", field: "value", phenomenon: "rate", unit: "%", measure_kind: "rate", temporal_basis: { type: "period" } }];
const planArgs2 = (extra = {}) => ({ chart_type: "line", sql: "SELECT year, value FROM 'data/x.csv'", title: "t", unit: "%", x_field: "year", value_field: "value", takeaway: "t", alt: "a", source_note: "s", ...extra });
await ok("R3 a chart that fits no relation: the refusal no longer offers 'none' on; off has no fix text at all", async () => {
  const args = planArgs2({ chart_type: "clock_dial", reader_task: "comparison", claim_id: "c1", measure_semantics: MS, claim_spec: { claim_id: "c1", relation: "comparison", reader_task: "comparison", target_measure: "m1", measure_ids: ["m1"] } });
  const onText = await refusal(on, args);
  must(onText && /EDITORIAL_GRAMMAR_BLOCKED: relation 'comparison' requires one of .*got 'clock_dial'; clock_dial fits: no relation in the strict grammar\. To fix, either set chart_type to one of /.test(onText), onText?.slice(0, 500));
  must(!/such as none/.test(onText), "no 'none' suggested");
  must(/claim_spec\.relation has no 'none' value, so only the chart_type change applies/.test(onText), "says why");
  const offText = await refusal(off, args);
  must(offText && /EDITORIAL_GRAMMAR_BLOCKED/.test(offText) && !/To fix/.test(offText) && !/'none'/.test(offText), "off: the old text");
});
await ok("R4 a chart that does fit a relation keeps the old fix text on", async () => {
  const args = planArgs2({ chart_type: "horizontal_bar", reader_task: "change", claim_id: "c1", measure_semantics: MS, claim_spec: { claim_id: "c1", relation: "trend", reader_task: "change", target_measure: "m1" } });
  const onText = await refusal(on, args);
  must(/\(a relation value such as .*, not a reader_task\)/.test(onText ?? ""), onText?.slice(0, 500));
});
await ok("R5 missing declaration: the reader_tasks that require both are listed on only", async () => {
  const args = planArgs2({ reader_task: "comparison", claim_id: "c1" });
  const onText = await refusal(on, args), offText = await refusal(off, args);
  must(/SEMANTIC_DECLARATION_REQUIRED: reader_task 'comparison' requires measure_semantics and claim_spec; this call is missing measure_semantics \(one entry per measure\) and claim_spec; the reader_tasks that require both are ranking, comparison, change, distribution, correlation, part_to_whole, and measure_semantics without claim_spec is refused/.test(onText ?? ""), onText?.slice(0, 500));
  must(offText && offText.startsWith("SEMANTIC_DECLARATION_REQUIRED: reader_task 'comparison' requires measure_semantics and claim_spec") && !/the reader_tasks that require both/.test(offText) && !/this call is missing/.test(offText), "off: old text");
});
await ok("R6 measure_semantics without claim_spec: the refusal says what to add on only", async () => {
  const args = planArgs2({ reader_task: "sequence", claim_id: "c1", measure_semantics: MS });
  const onText = await refusal(on, args), offText = await refusal(off, args);
  must(/claim_spec is required when measure_semantics are declared; add claim_spec with relation, reader_task, measure_ids and target_measure/.test(onText ?? ""), onText?.slice(0, 400));
  must(offText && /claim_spec is required when measure_semantics are declared/.test(offText) && !/add claim_spec/.test(offText), "off: old text");
});

// ---- D1: visual_family mismatch names the derived family --------------------------------------------------------
await ok("R7 visual_family that does not match chart_type: the refusal names the family to use on only; the plan stays refused", async () => {
  for (const [chart, wrong, right] of [["multi_line", "temporal", "statistical"], ["clock_dial", "explanatory", "statistical"]]) {
    const args = planArgs2({ chart_type: chart, visual_family: wrong, reader_task: "sequence", claim_id: "c1" });
    const onText = await refusal(on, args), offText = await refusal(off, args);
    must(offText && offText.includes(`visual_family '${wrong}' does not match chart_type '${chart}'`) && !/leave visual_family out/.test(offText), `off: old text (${chart})`);
    must(onText && onText.includes(`visual_family '${wrong}' does not match chart_type '${chart}'; use '${right}' or leave visual_family out`), `${chart}: ${onText?.slice(0, 400)}`);
  }
  const fine = await refusal(on, planArgs2({ chart_type: "multi_line", visual_family: "statistical", reader_task: "sequence", claim_id: "c1" }));
  must(!/does not match chart_type/.test(fine ?? ""), "a matching family is not refused for it");
});

// ---- A: field shapes in the tool descriptions -------------------------------------------------------------------
await ok("R8 tool definitions: field shapes are written only under NEWSROOM_SPEED_FIRST_TRY_SHAPES=1; FIRST_TRY_ALL alone and off are unchanged", async () => {
  const shp = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_FIRST_TRY_SHAPES: "1" } });
  const notOne = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_FIRST_TRY_SHAPES: "true" } });
  const without = (value, text) => JSON.parse(JSON.stringify(value, (k, v) => (k === "description" && v === text ? undefined : k === "reader_task" && v && v.type === "string" ? "RT" : v)));
  const pick = {
    newsroom_update_plan: [(t) => t.get("newsroom_update_plan").parameters.properties.steps, "Each step is an object {id, action, status}, never a plain string."],
    newsroom_viz_plan: [(t) => t.get("newsroom_viz_plan").parameters.properties.claim_spec, "claim_spec.relation is exactly one of its listed values (a relation, not a reader_task); there is no 'none' or 'level'."],
    newsroom_viz_chain: [(t) => t.get("newsroom_viz_chain").parameters.properties.claim_spec, "claim_spec.relation is exactly one of its listed values (a relation, not a reader_task); there is no 'none' or 'level'."],
  };
  for (const [name, [get, text]] of Object.entries(pick)) {
    must(get(shp).description === text, `${name}: on carries the text`);
    for (const t of [off, on, notOne]) must(!JSON.stringify(get(t)).includes(text), `${name}: no text off, with FIRST_TRY_ALL alone, or with a value other than 1`);
    must(JSON.stringify(without(get(shp), text)) === JSON.stringify(without(get(off), text)), `${name}: nothing but the sentence differs`);
  }
  const nodeSchema = (t) => t.get("newsroom_story_graph").parameters.properties.nodes.items.properties;
  must(/any other word \(for example magnitude\) is refused/.test(nodeSchema(shp).explanatory_dimension.description) && /Exactly one of: evidence/.test(nodeSchema(shp).kind.description), "story node: on carries the text");
  for (const t of [off, on, notOne]) must(nodeSchema(t).explanatory_dimension.description === undefined && nodeSchema(t).kind.description === undefined, "story node: no text off, with FIRST_TRY_ALL alone, or with a value other than 1");
  must(JSON.stringify(nodeSchema(shp).explanatory_dimension.enum) === JSON.stringify(nodeSchema(off).explanatory_dimension.enum), "enum values unchanged");
});

console.log(`rejection budget: ${results.length} checks -- PASS`);
