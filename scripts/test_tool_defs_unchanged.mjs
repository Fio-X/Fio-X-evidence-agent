// With the five patch-era switches off, the tool definitions newsroom.ts registers must be
// byte-identical to the base (8a75560, which this branch sits on; 7f44952 for the commits
// before the merge) for every tool profile, with the older speed switches off and on.
// Compared as canonical JSON (sorted keys) of name, label, description, promptSnippet,
// promptGuidelines and parameters; the golden file holds one sha256 per tool per case.
//
// NEWSROOM_ONE_CHART_ROUTING (on unless "0") adds one sentence to newsroom_infographic_plan's guidelines, so the golden hashes of that tool were regenerated
// for the default text; the "0" text is pinned by scripts/test_one_chart_text.mjs and the pin-patch lists.
//
// The hero value gate is always on (no switch turns it off), so there is no gate-off case any more.
//
// Run: node scripts/test_tool_defs_unchanged.mjs
// Regenerate the main golden only: node scripts/test_tool_defs_unchanged.mjs --root=<tree> --write; <tree> is an export of the base for a no-change check,
// and for an approved default text change it is the branch tree that carries the change (K797 10cb9ce6 → this commit); never the one-chart-0 file.
import { makeTestTmp } from "./tmp_helper.mjs";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ROOT = arg("root") || HERE;
const WRITE = process.argv.includes("--write");
const GOLDEN = arg("golden") || join(HERE, "fixtures/speed-off/tool-defs-8a75560.json");

const PROFILES = ["investigate", "visual", "publication", "visual-story", "competition", "full"];
// The speed switches that exist at the base. The five newer ones stay unset in every case.
const OLDER = ["NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PREFLIGHT", "NEWSROOM_SPEED_PLAN_EDIT", "NEWSROOM_SPEED_COMPUTE_BATCH", "NEWSROOM_SPEED_PARALLEL_HINTS", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_EDITORIAL_HINTS", "NEWSROOM_SPEED_RULE_HINTS", "NEWSROOM_SPEED_COMPACT_SETUP", "NEWSROOM_CLAIM_SQL_LINT"];
const NEWER = ["NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL", "NEWSROOM_SPEED_FILL_COPIED_REFS", "NEWSROOM_SPEED_FIRST_TRY_TEXT", "NEWSROOM_SPEED_PRECHECK_ALL", "NEWSROOM_SPEED_VIZ_REPORT_ALL", "NEWSROOM_SPEED_PLAN_PROGRESS"];
const MODES = {
  "older-off": {},
  "older-on": Object.fromEntries(OLDER.map((k) => [k, "1"])),
};
const KEYS = ["name", "label", "description", "promptSnippet", "promptGuidelines", "parameters"];

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
// The same plain-JSON typebox stand-in as test_speed_switch_gates.mjs: it keeps every option given.
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
const TREE = makeTestTmp("tool-defs-tree-");
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sha = (s) => createHash("sha256").update(s).digest("hex");

let n = 0;
// One pass over every profile and mode; `extra` is added to the environment of every case (the one-chart switch at "0" in the second pass).
const buildCases = async (extra) => {
  const cases = {};
  for (const profile of PROFILES) {
    for (const [mode, env] of Object.entries(MODES)) {
      for (const k of [...OLDER, ...NEWER, "NEWSROOM_PHASE", "NEWSROOM_QA_LIMITS_PROGRAM", "NEWSROOM_REFUSED_OPTIONS_FIX", "NEWSROOM_GRAMMAR_HINT_ELIGIBLE", "NEWSROOM_NUMWORD_PROMPT", "NEWSROOM_ONE_CHART_ROUTING"]) delete process.env[k];
      process.env.NEWSROOM_TOOL_PROFILE = profile;
      Object.assign(process.env, env, extra);
      const tools = {};
      const mod = await import(`${pathToFileURL(COPY).href}?v=${++n}`);
      mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => { tools[tool.name] = sha(JSON.stringify(canon(Object.fromEntries(KEYS.map((k) => [k, tool[k] ?? null]))))); } : () => {}) }));
      cases[`${profile}/${mode}`] = canon(tools);
    }
  }
  return cases;
};
const cases = await buildCases({});
const casesOneChartOff = await buildCases({ NEWSROOM_ONE_CHART_ROUTING: "0" });

if (WRITE) {
  writeFileSync(GOLDEN, JSON.stringify(cases, null, 1) + "\n");
  console.log(`wrote ${Object.keys(cases).length} cases`);
  process.exit(0);
}
// The second golden is the file as it stood before the one-chart switch existed (never regenerated, 61a69167). It pins only the tools that the
// switch touches: with the switch at "0" those are byte-identical to it, so "0" is the text from before the switch. Every other tool is pinned
// to the main golden in both passes, so a default text change to any other tool (K797: publication plan/render/portable) is caught in both.
// The list is named (see test_one_chart_text.mjs) and must equal the tools whose text differs between pass 1 and pass 2, so a guard that
// ignores "0" (no tool differs) or a switch that starts touching another tool fails here.
const ONE_CHART_TOOLS = ["newsroom_infographic_plan"];
const ONE_CHART_OFF_GOLDEN = join(HERE, "fixtures/speed-off/tool-defs-8a75560-one-chart-0.json");
const bad = [];
const switched = new Set();
for (const key of Object.keys(cases)) for (const tool of new Set([...Object.keys(cases[key]), ...Object.keys(casesOneChartOff[key] ?? {})])) if (cases[key][tool] !== casesOneChartOff[key]?.[tool]) switched.add(tool);
if (JSON.stringify([...switched].sort()) !== JSON.stringify([...ONE_CHART_TOOLS].sort())) bad.push(`tools touched by the one-chart switch: [${[...switched].sort()}], expected [${ONE_CHART_TOOLS}]`);
const compare = (label, golden, actual, only) => {
  for (const key of new Set([...Object.keys(golden), ...Object.keys(actual)])) {
    const a = golden[key] ?? {}, b = actual[key] ?? {};
    for (const tool of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (only && !only(tool)) continue;
      if (a[tool] !== b[tool]) bad.push(`${key} ${tool}${label}: ${a[tool] ? "changed" : "added"}${b[tool] ? "" : " (missing)"}`);
    }
  }
};
const mainGolden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const oldGolden = JSON.parse(readFileSync(ONE_CHART_OFF_GOLDEN, "utf8"));
compare("", mainGolden, cases);
compare(" with the one-chart switch at 0", oldGolden, casesOneChartOff, (tool) => ONE_CHART_TOOLS.includes(tool));
compare(" with the one-chart switch at 0 (main golden)", mainGolden, casesOneChartOff, (tool) => !ONE_CHART_TOOLS.includes(tool));
if (bad.length) { console.error(`tool definitions differ from the base:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`tool definitions: PASS (${Object.keys(cases).length} cases, byte-identical to the base with the five newer switches off; with the one-chart switch at 0 byte-identical to the pre-switch golden)`);
