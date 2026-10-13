#!/usr/bin/env node
// NEWSROOM_FLOW_EXTENT_HINT=1 (exact "1", default off): the extent_mode plan field says to leave it out so the program picks the extent from the
// data, and to write world only when the story needs the whole world. Off (unset, 0, true, yes, "", " 1", 01): tool definitions of every profile
// are byte-identical to the commit before this switch. On: the only difference is that one description (shown path by path) in the plan and chain tools; the enum
// and the extent thresholds (AUTO_EXTENT_MAX_LON/LAT in viz.mjs) are untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolDefLoader } from "./fixtures/flow-base/tool_defs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = "76f6b1b"; // the commit before this switch (it already holds NEWSROOM_FLOW_MAPS_BACK, which 1296164 lacks)
const scratch = mkdtempSync(join(tmpdir(), "flow-back-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const { load, tools, plain } = toolDefLoader(scratch);
function diff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const flat = (v) => Array.isArray(v) && v.every((x) => typeof x === "string") && path.endsWith("/enum");
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b) && !(flat(a) && flat(b))) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => diff(a[key], b[key], `${path}/${key}`));
  }
  return [{ path, before: a, after: b }];
}
const FLOW = ["cartographic_flow_map"], STAY = ["hierarchy_tree", "trajectory_profile", "geo_flow_map"];
const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
const current = await load(ROOT);
// The base is a fixture of the base commit's own output (made by scripts/gen_flow_base_fixture.mjs from BASE's tree), because BASE is not in the pushed history.
// A missing or different fixture fails the test; there is no skip path.
const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/flow-base/flow-base.json"), "utf8")).extent_hint;
assert.equal(fixture.source_commit, BASE, "the fixture was made from the base commit this test names");
const sha = (text) => createHash("sha256").update(text).digest("hex");
let compared = 0;
for (const profile of PROFILES) for (const extra of [{}, { NEWSROOM_HELD_CHART_TYPES: "1", NEWSROOM_FLOW_MAPS_BACK: "1" }, { NEWSROOM_SPEED_RULE_HINTS: "1" }]) {
  const env = { NEWSROOM_TOOL_PROFILE: profile, ...extra };
  const key = `${profile}|${JSON.stringify(extra)}`;
  const want = fixture.outputs[key];
  assert.ok(want, `the fixture has the base output for ${key}`);
  for (const v of [undefined, "0", "true", "yes", "", " 1", "01", "11"]) {
    const got = JSON.stringify(plain(await tools(current, { ...env, ...(v === undefined ? {} : { NEWSROOM_FLOW_EXTENT_HINT: v }) })));
    assert.equal(sha(got), want.sha256, `${profile} ${JSON.stringify(extra)} NEWSROOM_FLOW_EXTENT_HINT=${JSON.stringify(v)} is byte-identical to ${BASE}`);
    compared++;
  }
  const on = plain(await tools(current, { ...env, NEWSROOM_FLOW_EXTENT_HINT: "1" }));
  // the off output was just shown byte-identical (by sha256) to the base output, so it stands for the base text here
  const off = JSON.parse(JSON.stringify(plain(await tools(current, env))));
  const changes = diff(off, on);
  for (const c of changes) assert.match(c.path, /^\/newsroom_viz_(plan|chain)\/parameters\/properties\/extent_mode\/description$/, `unexpected difference at ${c.path}`);
  const plan = on.newsroom_viz_plan?.parameters?.properties?.extent_mode;
  if (plan) {
    assert.deepEqual(plan.enum, ["world", "data"], "the enum is untouched");
    assert.match(plan.description, /Leave this out/);
    assert.match(plan.description, /program picks the extent from the data/);
    assert.match(plan.description, /world only when the story needs the whole world/);
    assert.ok(changes.some((c) => c.path.startsWith("/newsroom_viz_plan/")), `${profile}: the plan tool carries the hint`);
  }
}
// the thresholds are not changed
const viz = readFileSync(join(ROOT, "runtime/pi/viz.mjs"), "utf8");
for (const name of ["AUTO_EXTENT_MAX_LON", "AUTO_EXTENT_MAX_LAT"]) assert.equal(viz.match(new RegExp(`${name}\\s*=\\s*[\\d.]+`))?.[0], fixture.thresholds[name], `${name} unchanged`);
console.log("flow extent hint: ok", { compared });
