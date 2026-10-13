#!/usr/bin/env node
// V568: with the D (trunk) style on, the widest trunk is 12 px in every case, and render QA reports any trunk wider than that.
//  - the 15-source fixture and a 15-branch cluster whose minimum widths alone used to give an 18 px trunk both stay at <= 12 px;
//  - the one width scale (trunk width = sum of its branch widths) still holds;
//  - render QA fails a trunk path wider than 12 px (red test with an 18 px SVG) and leaves every SVG without trunks untouched;
//  - the trunk cap is fixed: no environment variable sets a trunk width or maximum;
//  - D off (default, C only, labels off): byte-identical to 1296164.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rows, spec, clusterRows } from "./fixtures/flow-base/trunk_cap_inputs.mjs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
Object.assign(process.env, { NEWSROOM_FLOW_MAP_LABELS: "1", NEWSROOM_FLOW_STYLE_TRUNK: "1" });
delete process.env.NEWSROOM_FLOW_STYLE_CIRCLES;
const render = (r = rows) => renderVizBundle(spec, r).desktop;
const trunkWidths = (svg) => [...svg.matchAll(/<path data-role="cartographic-flow-trunk" [^>]*stroke-width="([\d.]+)"/g)].map((m) => +m[1]);
const branchWidths = (svg) => [...svg.matchAll(/<path data-role="cartographic-flow" [^>]*stroke-width="([\d.]+)"/g)].map((m) => +m[1]);

const wFixture = Math.max(...trunkWidths(render()));
assert.ok(wFixture <= 12.01 && wFixture > 11, `fixture: the widest trunk is the 12 px one (${wFixture})`);
const cluster = render(clusterRows);
const clusterTrunks = trunkWidths(cluster);
assert.ok(clusterTrunks.length >= 1, "the cluster fixture draws a trunk");
const wCluster = Math.max(...clusterTrunks);
assert.ok(wCluster <= 12.01 && wCluster > 11, `cluster of 15: the widest trunk is 12, not 18 (${wCluster})`);
// the one scale: the trunk is the sum of its branches' widths (to the 1-decimal rounding of each printed width)
const sum = branchWidths(cluster).reduce((t, w) => t + w, 0);
assert.ok(Math.abs(sum - wCluster) <= 0.05 * branchWidths(cluster).length + 0.1, `trunk ${wCluster} is the sum of its branches ${sum.toFixed(2)}`);
// the cap is not tunable: the renderer reads no env var that names a trunk maximum or width
assert.doesNotMatch(readFileSync(join(ROOT, "runtime/pi/viz.mjs"), "utf8"), /process\.env\.\w*TRUNK\w*(?:MAX|WIDTH|_W)\b/);

// render QA: a trunk wider than 12 px is reported; 12 passes; an SVG with no trunk is not touched
const qa = (svg) => runRenderQa({ desktop: svg });
const withTrunk = (w) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#fff"/><path data-role="cartographic-flow-trunk" data-trunk-members="3" d="M50,100 Q100,100 150,100" fill="none" stroke="#4c647c" stroke-width="${w}"/></svg>`;
const wide = qa(withTrunk("18.0"));
assert.equal(wide.passed, false, "an 18 px trunk fails render QA");
assert.ok(wide.viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), JSON.stringify(wide.viewports.desktop.geometry.failures));
assert.equal(qa(withTrunk("12.0")).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), false, "12 px is allowed");
assert.equal(qa(withTrunk("12.01")).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), false, "rounding of the printed width is allowed");
assert.equal(qa(withTrunk("12.2")).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), true, "12.2 px fails");
assert.equal(qa(render(clusterRows)).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), false, "the renderer's own 15-branch trunk passes");

// D off: byte-identical to 1296164 (the default style, circles only, and the trunk fallback with one source each).
// 1296164 is not in the pushed history, so the comparison is against its recorded output (scripts/gen_flow_base_fixture.mjs renders it from that commit's own tree).
// A missing or different fixture fails the test; there is no skip path.
const fixture = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/flow-base/flow-base.json"), "utf8")).trunk_cap;
assert.equal(fixture.source_commit, "1296164", "the fixture was made from the base commit this test names");
const sha = (text) => createHash("sha256").update(text).digest("hex");
assert.equal(fixture.inputs_sha256, sha(JSON.stringify({ spec, rows, clusterRows })), "the fixture was made from these inputs");
for (const env of [{}, { NEWSROOM_FLOW_STYLE_CIRCLES: "1" }, { NEWSROOM_FLOW_STYLE_TRUNK: "true" }, { NEWSROOM_FLOW_STYLE_TRUNK: "0" }]) {
  delete process.env.NEWSROOM_FLOW_STYLE_TRUNK; delete process.env.NEWSROOM_FLOW_STYLE_CIRCLES; Object.assign(process.env, env);
  for (const [name, r] of [["rows", rows], ["clusterRows", clusterRows]]) {
    const want = fixture.outputs[`${JSON.stringify(env)}|${name}`];
    assert.ok(want, `the fixture has the base output for ${JSON.stringify(env)} ${name}`);
    assert.equal(sha(render(r)), want.sha256, `D off ${JSON.stringify(env)} is byte-identical to 1296164`);
  }
}
console.log("flow trunk cap: ok", { wFixture, wCluster });
