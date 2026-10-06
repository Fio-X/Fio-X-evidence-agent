// Opt-in turn-saving prompt guidance (NEWSROOM_SPEED_PARALLEL_HINTS,
// NEWSROOM_SPEED_COMPUTE_BATCH). With every switch off, every tool definition the
// model can read is byte-identical to the baseline newsroom.ts (git bc1ccfd) in
// every profile; with a switch on, only that switch's tools change, and only by
// appended promptGuidelines sentences. Loads the real extension from type-stripped
// temporary copies (same approach as test_hide_lieflat_runtime.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { revertNameLocalization } from "./lib_name_localization_baseline.mjs";
import { formWiringMask } from "./lib_viz_form_wiring.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_REF = "bc1ccfd";
const SWITCHES = {
  NEWSROOM_SPEED_PARALLEL_HINTS: ["newsroom_update_plan", "fetch_url", "download_data"],
  NEWSROOM_SPEED_COMPUTE_BATCH: ["duckdb_query", "record_claim"],
};
const ALL_SWITCHES = Object.keys(SWITCHES);
const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
// NEWSROOM_HERO_VALUE_GATE=0: the hero value gate is on by default now; this test compares with bc1ccfd, which has the old typed-hero path.
process.env.NEWSROOM_HERO_VALUE_GATE = "0";
// fix/page-top-1003 adds three one-sentence guidelines on purpose: duckdb_query (relative windows) and newsroom_infographic_plan (page top,
// hero label). With the hero value gate off (NEWSROOM_HERO_VALUE_GATE=0, the old typed-hero path, which this test sets) they are the only difference
// from the older commit, so exactly those three sentences are masked here; everything else is still compared byte for byte.
const PAGE_TOP_SENTENCES = [/^A relative window such as /, /^The first content module after the title and dek is /, /^A hero_stat label names the subject, the measure and the period/];
const withoutPageTopSentences = (tool) => (Array.isArray(tool?.promptGuidelines) ? { ...tool, promptGuidelines: tool.promptGuidelines.filter((entry) => !PAGE_TOP_SENTENCES.some((re) => re.test(String(entry)))) } : tool);

const tmp = mkdtempSync(join(tmpdir(), "speed-hints-runtime-"));
try {
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "export const Type = new Proxy({}, { get: (_, kind) => (...args) => { while (args.length && args[args.length - 1] === undefined) args.pop(); return { kind, args }; } });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = (values) => ({ enum: values });\n");
  const load = async (label, source) => {
    const dir = join(tmp, label);
    cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
    cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    cpSync(join(tmp, "node_modules"), join(dir, "node_modules"), { recursive: true });
    const file = join(dir, "runtime", "pi", "newsroom.test-copy.mjs");
    writeFileSync(file, stripTypeScriptTypes(source, { mode: "strip" }));
    return (await import(file)).default;
  };
  const baselineSource = execFileSync("git", ["show", `${BASELINE_REF}:runtime/pi/newsroom.ts`], { cwd: ROOT, encoding: "utf8" });
  const currentSource = execFileSync("cat", [join(ROOT, "runtime/pi/newsroom.ts")], { encoding: "utf8" });
  const baseline = await load("base", baselineSource);
  const current = await load("cur", currentSource);

  const definitions = (extension, profile, on) => {
    process.env.NEWSROOM_TOOL_PROFILE = profile;
    delete process.env.NEWSROOM_HIDE_LIEFLAT; // ambient setting must not leak into the baseline comparison
    for (const name of ALL_SWITCHES) delete process.env[name];
    for (const name of on) process.env[name] = "1";
    const tools = new Map();
    extension(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, withoutPageTopSentences(tool)) : () => {}) }));
    for (const name of ALL_SWITCHES) delete process.env[name];
    return tools;
  };
  // Everything the model reads of a tool (all fields except the handler).
  // Two intended differences from the baseline, both only in viz_plan and viz_chain. measure_semantics is the full schema again (the
  // baseline registers a weaker duplicate). strip_plot, stacked_bar_100 and mirrored_bar are wired into the plan path: three chart_type
  // values, fourteen fields, three guideline sentences (scripts/lib_viz_form_wiring.mjs removes exactly those). Mask only these;
  // test_viz_plan_schema.mjs asserts the full measure_semantics schema and the form wiring.
  // Third intended difference (fast-fail-1003 item 3, one explanatory_dimension vocabulary): semantic novelty and the infographic plan take
  // every story-graph value. Mask only the enum of that field; the check after the loop below proves it really differs.
  const MASKED = new Set(["newsroom_viz_plan", "newsroom_viz_chain"]);
  const DIMENSION_ENUM_MASKED = new Set(["newsroom_semantic_novelty", "newsroom_infographic_plan"]);
  const maskViz = function (key, value) { return formWiringMask.call(this, key, key === "measure_semantics" ? "masked" : value); };
  const maskEnum = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (key === "enum" ? "masked" : inner)));
  const visibleWith = (tool, masks) => JSON.stringify({ ...tool, execute: undefined }, function (key, value) {
    if (masks && MASKED.has(tool.name)) return maskViz.call(this, key, value);
    if (masks && DIMENSION_ENUM_MASKED.has(tool.name) && key === "explanatory_dimension") return maskEnum(value);
    return value;
  });
  const visible = (tool) => visibleWith(tool, true);
  // The other declared difference from bc1ccfd: the category_names enum and two newsroom_viz_plan guideline sentences
  // (zh-names-1003). revertNameLocalization puts the old wording back and refuses a surface that lacks exactly those edits. This
  // suite's StringEnum stand-in keeps only the enum values (no options object), so the field description is not on this surface.
  const asBaseline = (tool) => revertNameLocalization(tool, { descriptions: false });

  let compared = 0;
  for (const profile of PROFILES) {
    const base = definitions(baseline, profile, []);
    const off = definitions(current, profile, []);
    assert.deepEqual([...off.keys()], [...base.keys()], `${profile}: same tools in the same order`);
    for (const [name, tool] of base) {
      assert.equal(visible(asBaseline(off.get(name))), visible(tool), `${profile}/${name}: switch off is byte-identical to ${BASELINE_REF}`);
      compared++;
    }
    for (const [env, tools] of Object.entries(SWITCHES)) {
      for (const bad of ["0", "", "true"]) {
        process.env.NEWSROOM_TOOL_PROFILE = profile;
        process.env[env] = bad;
        const probe = new Map();
        current(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => probe.set(tool.name, withoutPageTopSentences(tool)) : () => {}) }));
        delete process.env[env];
        for (const [name, tool] of base) assert.equal(visible(asBaseline(probe.get(name))), visible(tool), `${profile}/${name}: ${env}=${JSON.stringify(bad)} changes nothing`);
      }
      const on = definitions(current, profile, [env]);
      for (const [name, tool] of base) {
        if (!tools.includes(name)) {
          assert.equal(visible(asBaseline(on.get(name))), visible(tool), `${profile}/${name}: untouched by ${env}`);
          continue;
        }
        const after = on.get(name);
        const { promptGuidelines: beforeGuidelines = [], ...beforeRest } = tool;
        const { promptGuidelines: afterGuidelines, ...afterRest } = after;
        assert.equal(visible(afterRest), visible(beforeRest), `${profile}/${name}: only promptGuidelines may change`);
        assert.deepEqual(afterGuidelines.slice(0, beforeGuidelines.length), beforeGuidelines, `${profile}/${name}: original guidelines kept first`);
        assert.equal(afterGuidelines.length, beforeGuidelines.length + 1, `${profile}/${name}: exactly one sentence added`);
      }
    }
  }
  // The masked enum is a real, confined difference: unmasked, exactly these two tools differ from the baseline (drop the mask if it is reverted).
  {
    const [base, off] = [definitions(baseline, "full", []), definitions(current, "full", [])];
    const differing = [...base.keys()].filter((name) => visibleWith(off.get(name), false) !== visibleWith(base.get(name), false) && !MASKED.has(name));
    assert.deepEqual(differing.sort(), [...DIMENSION_ENUM_MASKED].sort(), "apart from viz_plan and viz_chain (measure_semantics), only the two dimension-enum tools differ from the baseline");
  }
  // The tools carrying the guidance exist in the profiles that matter.
  const inv = definitions(current, "investigate", ["NEWSROOM_SPEED_PARALLEL_HINTS"]);
  assert.match(inv.get("fetch_url").promptGuidelines.at(-1), /same assistant message/);
  assert.match(inv.get("newsroom_update_plan").promptGuidelines.at(-1), /same assistant message/);
  assert.match(inv.get("download_data").promptGuidelines.at(-1), /same assistant message/);
  const batch = definitions(current, "investigate", ["NEWSROOM_SPEED_COMPUTE_BATCH"]);
  assert.match(batch.get("duckdb_query").promptGuidelines.at(-1), /never send two identical SQL/);
  assert.match(batch.get("record_claim").promptGuidelines.at(-1), /computation_ref/);
  assert.equal(visible(batch.get("fetch_url")), visible(definitions(baseline, "investigate", []).get("fetch_url")), "compute batch leaves research tools alone");
  const both = definitions(current, "investigate", ALL_SWITCHES);
  for (const name of Object.values(SWITCHES).flat()) {
    assert.equal(both.get(name).promptGuidelines.length, (definitions(baseline, "investigate", []).get(name).promptGuidelines ?? []).length + 1, `${name}: both switches add one sentence each`);
  }
  console.log(JSON.stringify({ status: "PASS", definitions_compared: compared }));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
