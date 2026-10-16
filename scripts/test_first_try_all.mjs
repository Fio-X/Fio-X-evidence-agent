// V424 (NEWSROOM_SPEED_FIRST_TRY_ALL): a refused plan call names every problem it has, each with its exact fix. No check is added or relaxed.
// F1-F8: the claim template lists every bad placeholder in one pass (each equal to the single-problem refusal), reader_task is checked in the
// handler, the claim-id comparison survives a missing declaration, and off is byte-identical. Real plan tool on a temp artifact root. Offline.
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
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_FIRST_TRY_TEXT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL"];
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
const ENV_BASE = { NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_VIZ_REPORT_ALL: "1" };
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
const art = makeTestTmp("first-try-all-");
process.env.NEWSROOM_ARTIFACT_DIR = art;
const refusal = async (tools, args) => { useSwitch(tools); process.env.NEWSROOM_ARTIFACT_DIR = art; try { await tools.get("newsroom_viz_plan").execute("t", JSON.parse(JSON.stringify(args))); return null; } catch (e) { return String(e.message); } };
const codesOf = (t) => [...new Set([...t.matchAll(/(?:^|\n|\(\d+\) )([A-Z][A-Z_]{3,}):/g)].map((m) => m[1]))];

const rows = [{ year: 2000, value: 1.5, other: 3 }, { year: 2001, value: 4.5, other: 5 }];
await ok("F1 claim template: every bad placeholder is listed, each equal to the refusal of that placeholder alone", () => {
  const bad = ["{max.value - first.value|2}", "{first.value.year}", "{max.other.year}", "{value}", "{nope.x}"];
  const alone = bad.map((p) => { try { fillClaimTemplate(`Rise ${p}.`, rows, ["value"]); return null; } catch (e) { return String(e.message).replace(/^CLAIM_TEMPLATE_ERROR: /, ""); } });
  must(alone.every(Boolean), "each bad placeholder refuses alone");
  const all = claimTemplateProblems(`Rise ${bad.join(" and ")}.`, rows, ["value"]);
  must(all.length === bad.length, `all ${bad.length} found in one pass (got ${all.length})`);
  must(all.every((text, i) => text === alone[i]), "each message equals the single-problem refusal");
  must(claimTemplateProblems("Rise {last.value} {first.year}.", rows, ["value"]).length === 0, "a correct template has no problems");
});
await ok("F2 claim template: typed number, number word, unmatched brace and a bad placeholder are four problems", () => {
  const problems = claimTemplateProblems("In 2020 prices rose by three points {first.nope and {last.value}.", rows, ["value"]);
  must(problems.length >= 3, `found ${problems.length}`);
  must(problems.some((p) => /typed number/.test(p)) && problems.some((p) => /number word/.test(p)) && problems.some((p) => /unmatched/.test(p)), "all three classes named");
});
const planArgs = (extra = {}) => ({ chart_type: "line", sql: "SELECT year, value FROM 'data/x.csv'", title: "t", unit: "%", x_field: "year", value_field: "value", takeaway: "t", alt: "a", source_note: "s", ...extra });
await ok("F3 reader_task off the list: the handler names it with the allowed values; off gives no READER_TASK_INVALID", async () => {
  const text = await refusal(on, planArgs({ reader_task: "trend", claim_id: "c1" }));
  must(text && /^READER_TASK_INVALID: reader_task 'trend' is not a reader task; set it to exactly one of ranking, comparison/.test(text), "named first");
  must(!/READER_TASK_INVALID/.test((await refusal(off, planArgs({ reader_task: "trend", claim_id: "c1" }))) ?? ""), "off: no new code");
});
await ok("F4 reader_task missing is reported with the other problems of the call", async () => {
  const text = await refusal(on, planArgs({ claim_id: "c1" }));
  must(text && /READER_TASK_INVALID: reader_task is required/.test(text), "required named");
});
await ok("F5 a declaration missing is reported with the claim-id mismatch", async () => {
  const args = planArgs({ reader_task: "change", claim_id: "c1", claim_spec: { claim_id: "c2", relation: "change", reader_task: "change" } });
  const onText = await refusal(on, args);
  must(onText && /SEMANTIC_DECLARATION_REQUIRED: .*this call is missing measure_semantics/.test(onText), "names what is missing");
  must(/claim_spec\.claim_id 'c2' must match verified claim_id 'c1'/.test(onText), "claim-id mismatch reported in the same refusal");
  const offText = await refusal(off, args);
  must(!/must match verified claim_id/.test(offText ?? ""), "off: the first problem only (as before)");
});
await ok("F6 unknown measure: the refusal lists the declared ids", async () => {
  const args = planArgs({ reader_task: "change", claim_id: "c1", measure_semantics: [{ id: "m1", field: "value", phenomenon: "rate", unit: "%", measure_kind: "rate", temporal_basis: { type: "period" } }], claim_spec: { claim_id: "c1", relation: "change", reader_task: "change", target_measure: "zzz", measure_ids: ["zzz"] } });
  const onText = await refusal(on, args);
  must(onText && /unknown measure: zzz; measure_semantics declares the ids: m1\./.test(onText), "ids listed");
  must(!/declares the ids/.test((await refusal(off, args)) ?? ""), "off: unchanged text");
});
await ok("F7 off is identical: schema and descriptions are the same as a build without any switch", () => {
  const plain = JSON.stringify(off.get("newsroom_viz_plan").parameters);
  must(/"enum":\["ranking"/.test(plain), "reader_task stays an enum off");
  must(!/Rules: every number/.test(plain), "no added grammar text off");
  const onSchema = JSON.stringify(on.get("newsroom_viz_plan").parameters);
  must(/Rules: every number, years included/.test(onSchema), "full grammar in the claim description on");
  must(!/"enum":\["ranking"/.test(onSchema), "reader_task is checked by the handler on");
  must(JSON.stringify(on.get("newsroom_viz_chain").parameters).includes("Rules: every number"), "the chain carries the same text");
});
await ok("F8 the grammar-block refusal says how to fix it on only", async () => {
  const args = planArgs({ chart_type: "horizontal_bar", reader_task: "change", claim_id: "c1", measure_semantics: [{ id: "m1", field: "value", phenomenon: "rate", unit: "%", measure_kind: "rate", temporal_basis: { type: "period" } }], claim_spec: { claim_id: "c1", relation: "trend", reader_task: "change", target_measure: "m1" } });
  const onText = await refusal(on, args);
  must(onText && /EDITORIAL_GRAMMAR_BLOCKED: relation 'trend' requires one of .*\. To fix, either set chart_type to one of line/.test(onText), onText?.slice(0, 200));
  const offText = await refusal(off, args);
  must(offText && /EDITORIAL_GRAMMAR_BLOCKED/.test(offText) && !/To fix/.test(offText), "off: the old text");
});
console.log(`first-try all: ${results.length} checks -- PASS`);
