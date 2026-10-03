// newsroom_viz_plan must register the full measure_semantics schema (a duplicate key once let a weaker one win),
// and newsroom.ts must not hold duplicate property names in any object literal.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeMeasureSemantic } from "../runtime/pi/measure_semantics.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- 1. duplicate-key guard: TypeScript's own TS1117 over newsroom.ts ----------
{
  const which = spawnSync("tsc", ["-v"], { encoding: "utf8" });
  if (which.status !== 0) console.log("SKIP duplicate-key guard: tsc not found on PATH");
  else {
    const run = spawnSync("tsc", ["--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", join(ROOT, "runtime/pi/newsroom.ts")], { encoding: "utf8" });
    const dup = `${run.stdout}${run.stderr}`.split("\n").filter((l) => l.includes("TS1117"));
    must(!dup.length, `duplicate property names in newsroom.ts:\n${dup.join("\n")}`);
    console.log("PASS no duplicate object-literal keys in runtime/pi/newsroom.ts");
  }
}

// ---- 2. the registered viz_plan schema ---------------------------------------
const tree = mkdtempSync(join(tmpdir(), "viz-plan-schema-"));
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
const stub = (name, source) => {
  mkdirSync(join(tree, "node_modules", name), { recursive: true });
  writeFileSync(join(tree, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tree, "node_modules", name, "index.js"), source);
};
stub("typebox", `const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(tree, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

let n = 0;
async function tools(env = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_")) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  Object.assign(process.env, env);
  const out = new Map();
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (t) => out.set(t.name, t) : () => {}) }));
  return out;
}

const plan = (await tools()).get("newsroom_viz_plan");
must(plan, "newsroom_viz_plan is not registered");
const ms = plan.parameters.properties.measure_semantics;
must(ms?.type === "array" && ms.minItems === 1 && ms.maxItems === 24, "measure_semantics must be an array of 1..24 entries");
must(/plain integer/.test(ms.description ?? ""), "measure_semantics description lost the plain-integer sentence");
const item = ms.items;
for (const k of ["id", "phenomenon", "unit", "measure_kind", "temporal_basis"]) must(item.required.includes(k), `measure_semantics item must require ${k}`);
const KINDS = ["level", "flow", "stock", "rate", "share", "capacity", "change", "cumulative", "count", "index", "duration", "distance", "price"];
const TYPES = ["point_in_time", "period", "annual_average", "rolling", "structural", "cumulative", "timeless"];
must(JSON.stringify(item.properties.measure_kind.enum) === JSON.stringify(KINDS), "measure_kind enum differs from the normalizer's");
must(JSON.stringify(item.properties.temporal_basis.properties.type.enum) === JSON.stringify(TYPES), "temporal_basis.type enum differs from the normalizer's");
// every enum value the schema lists must be accepted by the normalizer, and the normalizer's refusals stay refusals
const base = { id: "m", phenomenon: "p", unit: "u", measure_kind: "level", temporal_basis: { type: "period" } };
for (const k of KINDS) normalizeMeasureSemantic({ ...base, measure_kind: k });
for (const t of TYPES) normalizeMeasureSemantic({ ...base, temporal_basis: { type: t } });
for (const bad of [{ measure_kind: "year" }, { temporal_basis: { type: "point" } }]) {
  let refused = false;
  try { normalizeMeasureSemantic({ ...base, ...bad }); } catch { refused = true; }
  must(refused, `normalizer accepted ${JSON.stringify(bad)}`);
}
console.log("PASS newsroom_viz_plan registers the full measure_semantics schema (required fields, both enums)");

// ---- 3. rule hints: off = byte-identical tool definitions, on = descriptions only ------------
{
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const ref = process.env.RULE_HINTS_BASE_REF; // optional: compare the switch-off definitions against a baseline commit
  const dump = async (env) => JSON.stringify([...(await tools(env)).values()].map((t) => ({ name: t.name, description: t.description, promptGuidelines: t.promptGuidelines, parameters: t.parameters })));
  const off1 = await dump({}), off2 = await dump({ NEWSROOM_SPEED_RULE_HINTS: "0" });
  must(off1 === off2, "switch off (unset vs 0) changed the tool definitions");
  if (ref) {
    const base = git(["show", `${ref}:runtime/pi/newsroom.ts`]);
    must(base.status === 0, `cannot read newsroom.ts at ${ref}`);
    writeFileSync(COPY, stripTypeScriptTypes(base.stdout, { mode: "strip" }));
    const baseline = await dump({});
    writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
    must(baseline === off1, `switch off differs from the definitions at ${ref}`);
    console.log(`PASS switch off is byte-identical to ${ref}`);
  }
  const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "description" ? undefined : x)));
  const on = await tools({ NEWSROOM_SPEED_RULE_HINTS: "1" });
  const offT = await tools({});
  for (const [name, t] of offT) {
    must(JSON.stringify(strip(t.parameters)) === JSON.stringify(strip(on.get(name).parameters)), `${name}: switch on changed more than descriptions`);
  }
  const desc = (name, ...path) => path.reduce((o, k) => o?.[k], on.get(name).parameters.properties);
  const vp = "newsroom_viz_plan";
  must(/240 rows/.test(desc(vp, "sql").description), "sql hint missing");
  must(/Required by chart_type/.test(desc(vp, "value_field").description), "value_field hint missing");
  must(/editorial grammar/.test(desc(vp, "claim_spec", "properties", "relation").description), "relation hint missing");
  must(/at least 3 questions/.test(desc("newsroom_editorial_discovery", "candidate_questions").description), "discovery hint missing");
  console.log("PASS rule hints: off is stable, on changes descriptions only");
}

// ---- 4. the round-3 opt-in fields: exact definitions pinned (this file does not import the implementation's text) ----
// A changed type, range or description must change this file too. map_extent is absent unless NEWSROOM_MAP_WORLD is exactly "1".
{
  const clean = (field) => JSON.parse(JSON.stringify(field, (k, x) => (k === "__optional" ? undefined : x)));
  const PINNED = {
    rank_cutoff: { type: "integer", minimum: 2, maximum: 30, description: "slope only: set when start_field and end_field hold ranks (1 = best, positive integers; an empty end means outside the ranking). Draws a bump chart with rank 1 on top, one row per rank up to N, and anyone outside the top N on an N+1 row with their true rank." },
    index_base: { type: "number", exclusiveMinimum: 0, description: "small_multiples line only: set when value_field is an index rebased to this value (for example 100): one x value (the base period) must equal it in every panel, so rebase in SQL. Draws a base line labelled with that period, y tick labels and an end value in each panel." },
  };
  const PINNED_WORLD = { type: "string", enum: ["world"], description: "Choropleth-only. \"world\" draws every economy with data on a fixed Equal Earth world map (no Antarctica) and lifts the 60-row cap; the SQL must return all economies (no LIMIT). Text labels only the lowest and highest value plus highlight_values (at most 8)." };
  const same = (got, want, what) => must(JSON.stringify(got) === JSON.stringify(want), `${what} definition changed:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  const off = (await tools()).get("newsroom_viz_plan").parameters.properties;
  for (const [name, want] of Object.entries(PINNED)) same(clean(off[name]), want, name);
  must(!("map_extent" in off), "map_extent is in the plan schema with NEWSROOM_MAP_WORLD unset");
  for (const value of ["0", "true", "yes", ""]) must(!("map_extent" in (await tools({ NEWSROOM_MAP_WORLD: value })).get("newsroom_viz_plan").parameters.properties), `map_extent is in the plan schema with NEWSROOM_MAP_WORLD=${JSON.stringify(value)}`);
  const on = (await tools({ NEWSROOM_MAP_WORLD: "1" })).get("newsroom_viz_plan").parameters.properties;
  same(clean(on.map_extent), PINNED_WORLD, "map_extent (NEWSROOM_MAP_WORLD=1)");
  for (const [name, want] of Object.entries(PINNED)) same(clean(on[name]), want, `${name} (NEWSROOM_MAP_WORLD=1)`);
  console.log("PASS rank_cutoff, index_base and map_extent definitions are pinned");
}
