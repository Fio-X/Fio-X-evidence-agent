// With the five patch-era switches off, the tool definitions newsroom.ts registers must be
// byte-identical to the base (8a75560, which this branch sits on; 7f44952 for the commits
// before the merge) for every tool profile, with the older speed switches off and on.
// Compared as canonical JSON (sorted keys) of name, label, description, promptSnippet,
// promptGuidelines and parameters; the golden file holds one sha256 per tool per case.
//
// Run: node scripts/test_tool_defs_unchanged.mjs
// Regenerate (only from an export of the base): node scripts/test_tool_defs_unchanged.mjs --root=<export> --write
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
const OLDER = ["NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PREFLIGHT", "NEWSROOM_SPEED_PLAN_EDIT", "NEWSROOM_SPEED_COMPUTE_BATCH", "NEWSROOM_SPEED_PARALLEL_HINTS", "NEWSROOM_SHADOW_CHECKS", "NEWSROOM_HIDE_LIEFLAT", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_EDITORIAL_HINTS", "NEWSROOM_SPEED_RULE_HINTS", "NEWSROOM_SPEED_COMPACT_SETUP", "NEWSROOM_CLAIM_SQL_LINT"];
const NEWER = ["NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL", "NEWSROOM_SPEED_FILL_COPIED_REFS", "NEWSROOM_SPEED_FIRST_TRY_TEXT", "NEWSROOM_SPEED_PRECHECK_ALL", "NEWSROOM_SPEED_VIZ_REPORT_ALL"];
const MODES = {
  "older-off": {},
  "older-on": Object.fromEntries(OLDER.map((k) => [k, "1"])),
  "older-on-hero-off": { ...Object.fromEntries(OLDER.map((k) => [k, "1"])), NEWSROOM_HERO_VALUE_GATE: "0" },
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
const TREE = mkdtempSync(join(tmpdir(), "tool-defs-tree-"));
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sha = (s) => createHash("sha256").update(s).digest("hex");

let n = 0;
const cases = {};
for (const profile of PROFILES) {
  for (const [mode, env] of Object.entries(MODES)) {
    for (const k of [...OLDER, ...NEWER, "NEWSROOM_HERO_VALUE_GATE", "NEWSROOM_PHASE"]) delete process.env[k];
    process.env.NEWSROOM_TOOL_PROFILE = profile;
    Object.assign(process.env, env);
    const tools = {};
    const mod = await import(`${pathToFileURL(COPY).href}?v=${++n}`);
    mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => { tools[tool.name] = sha(JSON.stringify(canon(Object.fromEntries(KEYS.map((k) => [k, tool[k] ?? null]))))); } : () => {}) }));
    cases[`${profile}/${mode}`] = canon(tools);
  }
}

if (WRITE) {
  writeFileSync(GOLDEN, JSON.stringify(cases, null, 1) + "\n");
  console.log(`wrote ${Object.keys(cases).length} cases`);
  process.exit(0);
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const bad = [];
for (const key of new Set([...Object.keys(golden), ...Object.keys(cases)])) {
  const a = golden[key] ?? {}, b = cases[key] ?? {};
  for (const tool of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[tool] !== b[tool]) bad.push(`${key} ${tool}: ${a[tool] ? "changed" : "added"}${b[tool] ? "" : " (missing)"}`);
}
if (bad.length) { console.error(`tool definitions differ from the base:\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`tool definitions: PASS (${Object.keys(cases).length} cases, byte-identical to the base with the five newer switches off)`);
