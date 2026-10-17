// NEWSROOM_ONE_CHART_ROUTING (K729): the page plan tool's guidelines gain exactly one sentence unless the
// switch is exactly "0"; with "0" they are the text from before the switch existed.
// The request routing itself is tested in src/prompt.rs.
//
// Run: node scripts/test_one_chart_text.mjs
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

const SENTENCE = "If the user asks for one chart, pair it with one explanatory module (illustration, map or cutaway), not a second chart of the same kind.";
let n = 0;
const guidelines = async (value) => {
  delete process.env.NEWSROOM_ONE_CHART_ROUTING;
  if (value !== undefined) process.env.NEWSROOM_ONE_CHART_ROUTING = value;
  process.env.NEWSROOM_TOOL_PROFILE = "visual-story";
  let found = null;
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => { if (tool.name === "newsroom_infographic_plan") found = JSON.stringify(tool.promptGuidelines); } : () => {}) }));
  if (!found) throw new Error("newsroom_infographic_plan was not registered");
  return JSON.parse(found);
};

const off = await guidelines("0");
if (off.includes(SENTENCE)) { console.error("the sentence is present with the switch at 0"); process.exit(1); }
const on = await guidelines(undefined);
const extra = on.filter((line) => !off.includes(line));
if (extra.length !== 1 || extra[0] !== SENTENCE || on.length !== off.length + 1) { console.error("by default, exactly the one sentence must be added", extra); process.exit(1); }
if (JSON.stringify(on.filter((line) => line !== SENTENCE)) !== JSON.stringify(off)) { console.error("the other guidelines changed"); process.exit(1); }
for (const value of ["", "1", "true", " 0", "00"]) {
  const g = await guidelines(value);
  if (JSON.stringify(g) !== JSON.stringify(on)) { console.error(`value ${JSON.stringify(value)} did not give the default text`); process.exit(1); }
}
console.log("one-chart text: PASS (on unless exactly 0; the 0 text lacks only the one sentence)");
