// Opt-in turn-saving prompt guidance (NEWSROOM_SPEED_PARALLEL_HINTS,
// NEWSROOM_SPEED_COMPUTE_BATCH). With every switch off, every tool definition the
// model can read is byte-identical to the baseline newsroom.ts (git bc1ccfd) in
// every profile; with a switch on, only that switch's tools change, and only by
// appended promptGuidelines sentences. Loads the real extension from type-stripped
// temporary copies (same approach as test_hide_lieflat_runtime.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { definitionOf, loadPinPatches } from "./lib_pin_patch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_REF = "bc1ccfd";
const SWITCHES = {
  NEWSROOM_SPEED_PARALLEL_HINTS: ["newsroom_update_plan", "fetch_url", "download_data"],
  NEWSROOM_SPEED_COMPUTE_BATCH: ["duckdb_query", "record_claim"],
  NEWSROOM_SPEED_PLAN_PROGRESS: ["newsroom_update_plan"],
};
const ALL_SWITCHES = Object.keys(SWITCHES);
const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
// The approved differences from the baseline (the page top, the fast-fail vocabulary, the three chart forms, zh names, measure_semantics) are the
// entries of scripts/fixtures/pin_patches/speed_prompt_hints_runtime.json, each with the commit that made it. This suite's Type stand-in keeps every
// option and its StringEnum keeps only the values, so the lists carry what is visible here. Each entry is asserted exactly, the list is reversed
// on a copy of the head, and the whole definition must equal the baseline's byte for byte (scripts/lib_pin_patch.mjs).
const pins = loadPinPatches("speed_prompt_hints_runtime", { baseline: BASELINE_REF });

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
  const currentSource = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  const baseline = await load("base", baselineSource);
  const current = await load("cur", currentSource);

  const definitions = (extension, profile, on) => {
    process.env.NEWSROOM_TOOL_PROFILE = profile;
    delete process.env.NEWSROOM_HIDE_LIEFLAT; // ambient setting must not leak into the baseline comparison
    for (const name of ALL_SWITCHES) delete process.env[name];
    for (const name of on) process.env[name] = "1";
    const tools = new Map();
    extension(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
    for (const name of ALL_SWITCHES) delete process.env[name];
    return tools;
  };
  // Everything the model reads of a tool (all fields except the handler).
  const visible = (tool) => definitionOf(tool);

  let compared = 0;
  for (const profile of PROFILES) {
    const base = definitions(baseline, profile, []);
    const off = definitions(current, profile, []);
    assert.deepEqual([...off.keys()], [...base.keys()], `${profile}: same tools in the same order`);
    pins.check(base, off, `${profile}: switch off, against ${BASELINE_REF}`);
    compared += base.size;
    for (const [env, tools] of Object.entries(SWITCHES)) {
      for (const bad of ["0", "", "true"]) {
        process.env.NEWSROOM_TOOL_PROFILE = profile;
        process.env[env] = bad;
        const probe = new Map();
        current(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => probe.set(tool.name, tool) : () => {}) }));
        delete process.env[env];
        for (const name of base.keys()) assert.equal(visible(probe.get(name)), visible(off.get(name)), `${profile}/${name}: ${env}=${JSON.stringify(bad)} changes nothing`);
      }
      const on = definitions(current, profile, [env]);
      for (const name of base.keys()) {
        if (!tools.includes(name)) {
          assert.equal(visible(on.get(name)), visible(off.get(name)), `${profile}/${name}: untouched by ${env}`);
          continue;
        }
        const after = on.get(name), before = off.get(name);
        const { promptGuidelines: beforeGuidelines = [], ...beforeRest } = before;
        const { promptGuidelines: afterGuidelines, ...afterRest } = after;
        assert.equal(visible(afterRest), visible(beforeRest), `${profile}/${name}: only promptGuidelines may change`);
        assert.deepEqual(afterGuidelines.slice(0, beforeGuidelines.length), beforeGuidelines, `${profile}/${name}: original guidelines kept first`);
        assert.equal(afterGuidelines.length, beforeGuidelines.length + 1, `${profile}/${name}: exactly one sentence added`);
      }
    }
  }
  pins.finish();
  // The tools carrying the guidance exist in the profiles that matter.
  const inv = definitions(current, "investigate", ["NEWSROOM_SPEED_PARALLEL_HINTS"]);
  assert.match(inv.get("fetch_url").promptGuidelines.at(-1), /same assistant message/);
  assert.match(inv.get("newsroom_update_plan").promptGuidelines.at(-1), /same assistant message/);
  assert.match(inv.get("download_data").promptGuidelines.at(-1), /same assistant message/);
  const batch = definitions(current, "investigate", ["NEWSROOM_SPEED_COMPUTE_BATCH"]);
  assert.match(batch.get("duckdb_query").promptGuidelines.at(-1), /never send two identical SQL/);
  assert.match(batch.get("record_claim").promptGuidelines.at(-1), /computation_ref/);
  assert.equal(visible(batch.get("fetch_url")), visible(definitions(baseline, "investigate", []).get("fetch_url")), "compute batch leaves research tools alone (fetch_url has no listed change)");
  const both = definitions(current, "investigate", ALL_SWITCHES);
  for (const name of new Set(Object.values(SWITCHES).flat())) {
    const added = Object.values(SWITCHES).filter((tools) => tools.includes(name)).length;
    assert.equal(both.get(name).promptGuidelines.length, (definitions(current, "investigate", []).get(name).promptGuidelines ?? []).length + added, `${name}: each switch that names it adds one sentence`);
  }
  const progress = definitions(current, "investigate", ["NEWSROOM_SPEED_PLAN_PROGRESS"]);
  assert.match(progress.get("newsroom_update_plan").promptGuidelines.at(-1), /recorded by the program/);
  console.log(JSON.stringify({ status: "PASS", definitions_compared: compared }));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
