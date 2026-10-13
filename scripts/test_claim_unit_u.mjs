// 1012g part 2: the |u claim-template suffix (NEWSROOM_UNIT_AWARE_LABELS=1, exact "1", default off).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let n = 0;
const dir = mkdtempSync(join(tmpdir(), "claim-unit-u-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const stub = (name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
stub("typebox", `const f = () => ({}); export const Type = new Proxy({}, { get: () => f });`);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const copy = join(dir, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const { fillClaimTemplate, claimTemplateProblems, claimUnitsOf } = await import(copy);
const rows = [{ country: "A", value: 1200 }, { country: "B", value: 4835.3 }];
const planZh = { language: "zh", measure_semantics: [{ field: "value", unit: "百万吨" }] };
const planEn = { language: "en", measure_semantics: [{ field: "value", unit: "million tonnes" }] };
const KEY = "NEWSROOM_UNIT_AWARE_LABELS";
const T = "Output reached {max.value|u} in {max.value.country}.";
const fill = (plan, on, template = T) => { if (on === undefined) delete process.env[KEY]; else process.env[KEY] = on; return fillClaimTemplate(template, rows, ["value"], null, claimUnitsOf(plan)); };
const r = fill(planZh, "1");
assert.equal(r.text, "Output reached 48.4 亿吨 in B."); n += 1;
assert.equal(r.bindings[0].value, 4835.3); assert.equal(r.bindings[0].raw_text, "4835.3"); assert.equal(r.bindings[0].unit_aware, true); n += 3;
assert.equal(fill(planEn, "1").text, "Output reached 4.84bn tonnes in B."); n += 1;
assert.equal(fill(planZh, "1", "Output {max.value} 百万吨.").text, "Output 4835.3 百万吨."); n += 1;
assert.equal(fillClaimTemplate(T, rows, ["value"], null, null, true).text, "Output reached 4835.3 in B."); n += 1;
for (const typed of ["Output reached 48.4 亿吨.", "Output reached 48 亿吨 in {max.value.country}."]) assert.throws(() => fill(planZh, "1", typed), /typed number/);
n += 2;
for (const on of [undefined, "0", "true", ""]) {
  assert.throws(() => fill(planZh, on), /CLAIM_TEMPLATE_ERROR: .*\|N suffix takes 0 to 4 decimals/);
  assert.equal(claimUnitsOf(planZh), null);
  assert.equal(claimTemplateProblems(T, rows, ["value"], null, claimUnitsOf(planZh)).length, 1);
  n += 3;
}
assert.equal(fill(planZh, undefined, "Output {max.value} 百万吨 in {max.value.country}.").text, "Output 4835.3 百万吨 in B."); n += 1;
process.env[KEY] = "1";
assert.throws(() => fill({ language: "zh", measure_semantics: [] }, "1"), /needs the SQL unit/);
assert.throws(() => fill({ language: "zh", measure_semantics: [{ field: "value", unit: "吨" }] }, "1"), /carries no magnitude/);
assert.throws(() => fill(planZh, "1", "{max.value.country|u} leads."), /applies only to numbers/);
n += 3;
// the tool hint: only with the switch on (and where the inline claim exists), one guideline on newsroom_viz_plan, nothing else changes
const tools = async (value) => {
  for (const k of ["NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT"]) process.env[k] = "1";
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
  const out = new Map();
  const mod = await import(`${copy}?v=${++loaded}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => out.set(tool.name, JSON.stringify(tool)) : () => {}) }));
  return out;
};
let loaded = 0;
const base = await tools(undefined);
assert.ok(base.has("newsroom_viz_plan"), "viz_plan registered with the inline claim on"); n += 1;
for (const off of ["0", "true", ""]) { const o = await tools(off); assert.deepEqual([...o], [...base], `switch ${JSON.stringify(off)}: every tool definition byte-identical`); n += 1; }
const on = await tools("1");
assert.match(on.get("newsroom_viz_plan"), /\{max\.col\|u\}/); n += 1;
for (const [name, def] of base) if (name !== "newsroom_viz_plan") assert.equal(on.get(name), def, `${name} unchanged`);
assert.ok(!base.get("newsroom_viz_plan").includes("|u"), "no |u hint when off"); n += 2;
delete process.env[KEY];
console.log(`ok test_claim_unit_u (${n} checks)`);
