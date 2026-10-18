// Fixture inputs for the schema-refusal wording tests (K814): inline schemas with raw arguments, and the 99-line visual-concepts refusal
// rebuilt from the registered tool's own schema. The base verdicts in fixtures/schema-refusal/verdicts-ab2f9bf6.json were produced from the
// tool_host_schema.mjs of ab2f9bf6 with these same inputs (scripts/test_schema_refusal_expected.mjs replays them).
import { mkdirSync, readFileSync, writeFileSync, cpSync, mkdtempSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const S = (extra = {}) => ({ type: "string", ...extra });
const OBJ = (properties, required, extra = {}) => ({ type: "object", properties, required, ...extra });
const LONG = Array.from({ length: 15 }, (_, i) => `v${i}`);
const ITEM = OBJ({ x: S({ enum: ["a", "b"] }), y: { type: "array", items: S() }, z: { type: "integer" } }, ["x", "y", "z"]);

export const INLINE_CASES = [
  { name: "flat: wrong number, missing string", schema: OBJ({ n: { type: "number" }, i: { type: "integer", minimum: 1 }, b: { type: "boolean" }, s: S() }, ["n", "i", "b", "s"]), raw: { n: "x", i: 1, b: true } },
  { name: "valid after conversion", schema: OBJ({ n: { type: "number" }, s: S() }, ["n", "s"]), raw: { n: "3", s: 7 } },
  { name: "missing enum field", schema: OBJ({ kind: S({ enum: ["a", "b", "c"] }), note: S() }, ["kind"]), raw: { note: "q" } },
  { name: "long enum is capped", schema: OBJ({ pick: S({ enum: LONG }) }, ["pick"]), raw: {} },
  { name: "missing const", schema: OBJ({ v: S({ const: "0.2.0" }) }, ["v"]), raw: {} },
  { name: "wrong const and wrong enum value", schema: OBJ({ v: S({ const: "0.2.0" }), kind: S({ enum: ["a", "b"] }) }, ["v", "kind"]), raw: { v: "0.1", kind: "zz" } },
  { name: "union failure", schema: OBJ({ u: { anyOf: [S(), { type: "number" }] }, w: { anyOf: [S(), { type: "number" }] } }, ["u", "w"]), raw: { u: [], w: true } },
  { name: "required union property has no type", schema: OBJ({ u: { anyOf: [S(), { type: "number" }] } }, ["u"]), raw: {} },
  { name: "additionalProperties false", schema: OBJ({ a: S() }, ["a"], { additionalProperties: false }), raw: { a: "x", b: 1, c: 2 } },
  { name: "array items missing in several positions", schema: OBJ({ items: { type: "array", items: ITEM } }, ["items"]), raw: { items: [{}, { y: [] }, {}, {}, {}, { x: "a", z: 1 }] } },
  { name: "two index levels, full product", schema: OBJ({ m: { type: "array", items: OBJ({ c: { type: "array", items: OBJ({ role: S() }, ["role"]) } }, ["c"]) } }, ["m"]), raw: { m: [{ c: [{}, {}] }, { c: [{}, {}] }] } },
  { name: "two index levels, not a product", schema: OBJ({ m: { type: "array", items: OBJ({ c: { type: "array", items: OBJ({ role: S() }, ["role"]) } }, ["c"]) } }, ["m"]), raw: { m: [{ c: [{}, {}] }, { c: [{ role: "r" }, {}] }] } },
  { name: "root array", schema: { type: "array", items: OBJ({ id: S() }, ["id"]) }, raw: [{}, {}, {}] },
  { name: "digit-named object keys are not indexes", schema: OBJ({ by: { type: "object", additionalProperties: OBJ({ id: S() }, ["id"]) } }, ["by"]), raw: { by: { 2024: {}, 2025: {} } } },
  { name: "array of enum strings, wrong items", schema: OBJ({ tags: { type: "array", items: S({ enum: ["p", "q"] }) } }, ["tags"]), raw: { tags: ["p", "z", "y", "x"] } },
  { name: "nulls on optional and required fields", schema: OBJ({ a: S(), b: { type: "number" } }, ["a", "b"]), raw: { a: null, b: null } },
];

const OPT = "__optional";
const TYPEBOX = `const OPT="${OPT}";const mk=(b)=>(o={})=>({...b,...(o&&typeof o==="object"&&!Array.isArray(o)?o:{})});export const Type={String:mk({type:"string"}),Number:mk({type:"number"}),Integer:mk({type:"integer"}),Boolean:mk({type:"boolean"}),Any:()=>({}),Null:()=>({type:"null"}),Unknown:()=>({}),Literal:(v)=>({const:v}),Optional:(s)=>({...s,[OPT]:true}),Array:(i,o={})=>({type:"array",items:i,...o}),Union:(a)=>({anyOf:a}),Record:()=>({type:"object"}),Object:(p={},o={})=>({type:"object",properties:p,required:Object.keys(p).filter(k=>!p[k][OPT]),...o})};`;

/** The registered parameters schema of one tool, from a tree's runtime/ (type-stripped newsroom.ts with typebox stubs), plus that tree's tool_host_schema.mjs. */
export async function loadTree(root, tmpDir, toolName) {
  const dir = mkdtempSync(join(tmpDir, "refusal-tree-"));
  cpSync(join(root, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(root, "config"), join(dir, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  stub("typebox", TYPEBOX);
  stub("@earendil-works/pi-ai", "export const StringEnum=(v,o={})=>({type:'string',enum:[...v],...o});");
  writeFileSync(join(dir, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  const tools = new Map();
  (await import(`${pathToFileURL(join(dir, "runtime/pi/newsroom.test-copy.mjs")).href}?t=${Math.random()}`)).default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const host = await import(`${pathToFileURL(join(dir, "runtime/pi/tool_host_schema.mjs")).href}?t=${Math.random()}`);
  return { schema: tools.get(toolName).parameters, host };
}

/** A value that satisfies a schema node (required fields only), built from the schema alone. */
export function sampleValue(schema) {
  if (schema.enum) return schema.enum[0];
  if ("const" in schema) return schema.const;
  if (schema.anyOf) return sampleValue(schema.anyOf[0]);
  const type = [].concat(schema.type ?? "string")[0];
  if (type === "object") return Object.fromEntries((schema.required ?? []).map((k) => [k, sampleValue(schema.properties[k] ?? {})]));
  if (type === "array") return [];
  if (type === "number" || type === "integer") return Math.max(schema.minimum ?? 0, 0);
  if (type === "boolean") return false;
  return "x";
}

/** The 99-line case: top-level discovery_ref missing, seven empty concepts (7 x 13) and an eighth concept missing exactly seven of its 13 required fields. */
export function visualConceptsRaw(schema) {
  const item = schema.properties.concepts.items, keep = item.required.slice(0, item.required.length - 7);
  const eighth = Object.fromEntries(keep.map((k) => [k, sampleValue(item.properties[k])]));
  return { concepts: [{}, {}, {}, {}, {}, {}, {}, eighth] };
}

export function runInline(host, { schema, raw }) {
  const normalized = host.convert(schema, raw);
  const errors = host.validate(schema, normalized);
  const failure = host.validationFailure("t", schema, raw);
  return failure.ok ? { ok: true, args: failure.args, errors } : { ok: false, errors, text: failure.text };
}
