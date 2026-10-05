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
  must(/240 rows \(strip_plot: 600\)/.test(desc(vp, "sql").description), "sql hint lost the strip_plot 600-row exception (viz.mjs caps every other chart type at 240 rows)");
  must(/Required by chart_type/.test(desc(vp, "value_field").description), "value_field hint missing");
  must(/editorial grammar/.test(desc(vp, "claim_spec", "properties", "relation").description), "relation hint missing");
  must(/at least 3 questions/.test(desc("newsroom_editorial_discovery", "candidate_questions").description), "discovery hint missing");
  console.log("PASS rule hints: off is stable, on changes descriptions only");
}

// ---- 4. strip_plot, stacked_bar_100 and mirrored_bar are wired into the plan path --------------------------
// Names, enums and ranges of each form's own fields equal schemas/newsroom-viz-spec.schema.json (the descriptions are the tool's own, shorter
// text); viz.mjs validateVizSpec and lintVizSpec stay the authority on every data rule, the tool schema only has to let the fields through.
{
  const { CHART_TYPES } = await import(pathToFileURL(join(ROOT, "runtime/pi/viz.mjs")).href);
  const { FORM_CHART_TYPES, FORM_FIELDS } = await import("./lib_viz_form_wiring.mjs");
  const spec = JSON.parse(readFileSync(join(ROOT, "schemas/newsroom-viz-spec.schema.json"), "utf8"));
  const chain = (await tools({ NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1" })).get("newsroom_viz_chain");
  must(chain, "newsroom_viz_chain is not registered with the chain switches on");
  const planProps = plan.parameters.properties, chainProps = chain.parameters.properties;

  // chart_type: every value is a real chart type, the three forms are in the tool, the JSON schema and CHART_TYPES
  const toolTypes = planProps.chart_type.enum;
  must(new Set(toolTypes).size === toolTypes.length, "the chart_type enum lists a value twice");
  for (const type of toolTypes) must(CHART_TYPES.includes(type), `chart_type ${type} is not a viz.mjs chart type`);
  for (const form of FORM_CHART_TYPES) {
    must(toolTypes.includes(form), `the chart_type enum lacks ${form}`);
    must(spec.properties.chart_type.enum.includes(form), `${form} is not in the JSON schema chart_type enum`);
    must(CHART_TYPES.includes(form), `${form} is not in viz.mjs CHART_TYPES`);
  }
  must(JSON.stringify(chainProps.chart_type) === JSON.stringify(planProps.chart_type), "newsroom_viz_chain's chart_type differs from newsroom_viz_plan's");

  // fields: present and optional in plan and chain, equal to the JSON schema once descriptions and the TypeBox wrapping are dropped
  const canon = (v) => (Array.isArray(v) ? (v.every((x) => typeof x !== "object") ? [...v].sort() : v.map(canon)) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const asJsonSchema = ({ description, __optional, ...rest }) => {
    if (Array.isArray(rest.enum) && rest.type === "string") delete rest.type; // the JSON schema lists an enum without a type
    if (Array.isArray(rest.anyOf)) { // Union(String(minLength 1), Number) is the JSON schema's type ["string","number"] with minLength 1
      const { anyOf, ...others } = rest;
      return { ...others, ...Object.assign({}, ...anyOf.map(({ type, ...o }) => o)), type: anyOf.map((x) => x.type) };
    }
    return rest;
  };
  for (const field of FORM_FIELDS) {
    must(spec.properties[field], `${field} is not a property of the JSON schema`);
    for (const [label, props, tool] of [["newsroom_viz_plan", planProps, plan], ["newsroom_viz_chain", chainProps, chain]]) {
      must(props[field], `${label} lacks the field ${field}`);
      must(props[field].__optional === true && !tool.parameters.required.includes(field), `${label}: ${field} must be optional`);
      const [got, want] = [canon(asJsonSchema(props[field])), canon(Object.fromEntries(Object.entries(spec.properties[field]).filter(([k]) => k !== "description")))];
      must(JSON.stringify(got) === JSON.stringify(want), `${label}: ${field} differs from the JSON schema\n  tool:   ${JSON.stringify(got)}\n  schema: ${JSON.stringify(want)}`);
    }
  }
  // the JSON schema documents nine of the fields with a "<form>:" description: none of those may be left out of the tool
  const documented = Object.entries(spec.properties).filter(([, v]) => typeof v.description === "string" && FORM_CHART_TYPES.some((form) => v.description.startsWith(`${form}:`))).map(([k]) => k);
  must(documented.length >= 9, `expected at least 9 form-documented JSON schema properties, found ${documented.length}`);
  // decimals is documented for stacked_bar_100 but deliberately not on the plan path (value labels use the shared formatter)
  const NOT_ON_PLAN_PATH = ["decimals"];
  for (const field of NOT_ON_PLAN_PATH) must(!planProps[field] && !chainProps[field], `${field} must not be a property of newsroom_viz_plan or newsroom_viz_chain`);
  for (const field of documented.filter((f) => !NOT_ON_PLAN_PATH.includes(f))) must(FORM_FIELDS.includes(field), `the JSON schema documents ${field} for one of the three forms but the tool does not expose it (add it to the tool and to scripts/lib_viz_form_wiring.mjs)`);
  // category_names names the forms whose category_field the renderer localizes (viz.mjs categoryNamesField); mirrored_bar is not one of them
  const categoryNames = planProps.category_names.description;
  must(/strip_plot\/stacked_bar_100/.test(categoryNames) && !/mirrored_bar/.test(categoryNames), "category_names must list strip_plot and stacked_bar_100, not mirrored_bar");
  console.log(`PASS the plan path wires ${FORM_CHART_TYPES.join(", ")}: chart_type enum, ${FORM_FIELDS.length} optional fields equal to the JSON schema in newsroom_viz_plan and newsroom_viz_chain`);

  // layout defaults: each form's default layout is what the field's description (tool and JSON schema) calls "(<value>, default)" and
  // the opt-in alternative is never called a default. viz.mjs and the form tests pin the behaviour; this pins what the model is told.
  const DEFAULT_LAYOUTS = {
    point_layout: { value: "beeswarm", optIn: "jitter" }, // strip_plot
    segment_values: { value: "highlight_column", optIn: "in_bar" }, // stacked_bar_100
    compare_layout: { value: "overlay", optIn: "side_by_side" }, // mirrored_bar
  };
  for (const [field, { value, optIn }] of Object.entries(DEFAULT_LAYOUTS)) {
    for (const [label, props] of [["newsroom_viz_plan", planProps], ["newsroom_viz_chain", chainProps]]) {
      const text = props[field].description ?? "";
      must(props[field].enum.includes(value) && props[field].enum.includes(optIn), `${label}: ${field} must offer both ${value} and ${optIn}`);
      must(text.includes(`(${value}, default)`), `${label}: the ${field} description must name ${value} as the default: "${text}"`);
      must(!text.includes(`${optIn}, default`) && !text.includes(`${optIn} (default`), `${label}: the ${field} description calls the opt-in ${optIn} a default`);
    }
    const schemaText = spec.properties[field].description ?? "";
    must(new RegExp(`${value}(, default| \\(default\\))`).test(schemaText), `the JSON schema description of ${field} must name ${value} as the default: "${schemaText}"`);
  }
  console.log(`PASS the layout defaults are named in the tool and schema descriptions: ${Object.entries(DEFAULT_LAYOUTS).map(([field, { value }]) => `${field}=${value}`).join(", ")}`);

  // guidance (default on): exactly one sentence per form, naming the required fields and quoting viz.mjs's own limits, so a changed
  // limit fails here instead of leaving a stale hint
  const vizSource = readFileSync(join(ROOT, "runtime/pi/viz.mjs"), "utf8");
  const limit = (pattern, what) => { const m = vizSource.match(pattern); must(m, `viz.mjs no longer defines ${what}`); return m[1]; };
  const GUIDANCE = {
    strip_plot: { fields: ["category_field", "value_field", "label_field", "label_extremes"], limits: [limit(/const STRIP_MAX_GROUPS = (\d+);/, "STRIP_MAX_GROUPS"), limit(/const STRIP_MAX_POINTS = (\d+);/, "STRIP_MAX_POINTS")] },
    stacked_bar_100: { fields: ["unit='%'", "category_field", "series_field", "value_field", "highlight_segment", "sort='desc'"], limits: [limit(/const STACKED_MAX_BARS = (\d+);/, "STACKED_MAX_BARS"), limit(/const STACKED_MAX_SEGMENTS = (\d+);/, "STACKED_MAX_SEGMENTS"), `+/- ${limit(/const STACKED_SUM_TOLERANCE = (\d+);/, "STACKED_SUM_TOLERANCE")}`] },
    mirrored_bar: { fields: ["category_field", "series_field", "value_field", "period_field"], limits: [limit(/mirrored_bar has \$\{categories\.length\} categories; maximum is (\d+)/, "the mirrored_bar category cap"), "exactly 2", "at most 2"] },
  };
  const guidelines = plan.promptGuidelines;
  must(guidelines.filter((line) => /^Use chart_type='(strip_plot|stacked_bar_100|mirrored_bar)'/.test(line)).length === FORM_CHART_TYPES.length, "newsroom_viz_plan must carry exactly one 'Use chart_type=...' guideline per new form");
  for (const form of FORM_CHART_TYPES) {
    const line = guidelines.filter((g) => g.startsWith(`Use chart_type='${form}'`));
    must(line.length === 1, `newsroom_viz_plan must carry exactly one guideline for ${form}, found ${line.length}`);
    must(!/\. [A-Z]/.test(line[0]) && line[0].endsWith("."), `the ${form} guideline must be a single sentence`);
    for (const word of [...GUIDANCE[form].fields, ...GUIDANCE[form].limits]) must(line[0].includes(word), `the ${form} guideline must mention ${word}`);
    for (const field of GUIDANCE[form].fields.filter((f) => /^[a-z_]+$/.test(f))) must(field in planProps || field === "unit", `the ${form} guideline names ${field}, which the tool does not take`);
  }
  console.log("PASS one single-sentence guideline per new form, with its required fields and viz.mjs's limits");
}
