#!/usr/bin/env node
// Writes scripts/fixtures/flow-base/flow-base.json: hashes of the OLD code's own output, for the two tests whose base commits are not in the pushed history.
// Usage: node scripts/gen_flow_base_fixture.mjs <worktree at 1296164> <worktree at 76f6b1b>   (make them with `git worktree add --detach <dir> <commit>` from a full local clone)
// The old code is run on the same inputs the tests use; the fixture holds only sha256 + byte counts, the source commit ids and the input hash.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rows, spec, clusterRows } from "./fixtures/flow-base/trunk_cap_inputs.mjs";
import { toolDefLoader } from "./fixtures/flow-base/tool_defs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [trunkWt, extentWt] = process.argv.slice(2);
if (!trunkWt || !extentWt) throw new Error("usage: gen_flow_base_fixture.mjs <worktree at 1296164> <worktree at 76f6b1b>");
const head = (wt) => execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sha = (text) => createHash("sha256").update(text).digest("hex");
const entry = (text) => ({ sha256: sha(text), bytes: Buffer.byteLength(text) });
const must = (wt, prefix) => { if (!head(wt).startsWith(prefix)) throw new Error(`${wt} is not at ${prefix}`); return prefix; };

// trunk cap: render with the base viz.mjs under the env the test sets
const baseViz = await import(pathToFileURL(join(trunkWt, "runtime/pi/viz.mjs")).href);
Object.assign(process.env, { NEWSROOM_FLOW_MAP_LABELS: "1", NEWSROOM_FLOW_STYLE_TRUNK: "1" });
const trunk = { source_commit: must(trunkWt, "1296164"), inputs_sha256: sha(JSON.stringify({ spec, rows, clusterRows })), outputs: {} };
for (const env of [{}, { NEWSROOM_FLOW_STYLE_CIRCLES: "1" }, { NEWSROOM_FLOW_STYLE_TRUNK: "true" }, { NEWSROOM_FLOW_STYLE_TRUNK: "0" }]) {
  delete process.env.NEWSROOM_FLOW_STYLE_TRUNK; delete process.env.NEWSROOM_FLOW_STYLE_CIRCLES; Object.assign(process.env, env);
  for (const [name, r] of [["rows", rows], ["clusterRows", clusterRows]]) trunk.outputs[`${JSON.stringify(env)}|${name}`] = entry(baseViz.renderVizBundle(spec, r).desktop);
}

// extent hint: base tool definitions per profile and extra switches (post-rewrite of the one K190 string, as the test allowed)
const scratch = mkdtempSync(join(tmpdir(), "flow-base-gen-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const { load, tools, plain } = toolDefLoader(scratch);
const base = await load(extentWt);
const extent = { source_commit: must(extentWt, "76f6b1b"), outputs: {}, thresholds: {} };
for (const profile of ["investigate", "visual", "visual-story", "publication", "competition", "full"]) for (const extra of [{}, { NEWSROOM_HELD_CHART_TYPES: "1", NEWSROOM_FLOW_MAPS_BACK: "1" }, { NEWSROOM_SPEED_RULE_HINTS: "1" }]) {
  const text = JSON.stringify(plain(await tools(base, { NEWSROOM_TOOL_PROFILE: profile, ...extra })));
  const was = extra.NEWSROOM_FLOW_MAPS_BACK === "1" ? text.split("chord, geographic flow map, adjacency matrix, timeline").join("chord, cartographic flow map, adjacency matrix, timeline") : text;
  extent.outputs[`${profile}|${JSON.stringify(extra)}`] = entry(was);
}
const vizText = readFileSync(join(extentWt, "runtime/pi/viz.mjs"), "utf8");
for (const name of ["AUTO_EXTENT_MAX_LON", "AUTO_EXTENT_MAX_LAT"]) extent.thresholds[name] = vizText.match(new RegExp(`${name}\\s*=\\s*[\\d.]+`))?.[0];

writeFileSync(join(ROOT, "scripts/fixtures/flow-base/flow-base.json"), JSON.stringify({ trunk_cap: trunk, extent_hint: extent }, null, 1) + "\n");
console.log("wrote flow-base.json", { trunk: Object.keys(trunk.outputs).length, extent: Object.keys(extent.outputs).length });
