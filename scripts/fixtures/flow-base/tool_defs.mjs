// Shared by test_flow_extent_hint.mjs and gen_flow_base_fixture.mjs: load a tree's newsroom.ts with stub packages and read its tool definitions.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function toolDefLoader(scratch) {
  let n = 0;
  const stub = (dir, name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  const TYPEBOX = `const OPT = "__optional";
  const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
  export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
    Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
    Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
    Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`;
  async function load(source) {
    const dir = mkdtempSync(join(scratch, "tree-"));
    cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
    cpSync(join(source, "config"), join(dir, "config"), { recursive: true });
    stub(dir, "typebox", TYPEBOX);
    stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
    const file = join(dir, "runtime/pi/newsroom.test-copy.mjs");
    writeFileSync(file, stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
    return file;
  }
  const artifacts = mkdtempSync(join(scratch, "art-"));
  async function tools(file, env = {}) {
    for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_")) delete process.env[key];
    Object.assign(process.env, { NEWSROOM_ARTIFACT_DIR: artifacts, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" }, env);
    const out = new Map();
    const mod = await import(`${pathToFileURL(file).href}?v=${++n}`);
    mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => out.set(tool.name, tool) : () => {}) }));
    return out;
  }
  const plain = (map) => Object.fromEntries([...map].map(([k, t]) => [k, JSON.parse(JSON.stringify({ ...t, execute: undefined }))]));

  return { load, tools, plain };
}
