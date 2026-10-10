#!/usr/bin/env node
// The 14 existing fixtures that went red with NEWSROOM_QA_NO_EMPTY_PASS=1 (cd's finding B on d36d7ff), run with the switch on.
// kind 1 = no chart shapes (now "not applicable"); kind 2 = chart marks without a data role (now counted); other = red for its own reason.
// Off, all 14 pass (checked too). Needs no provider; a fixture that needs a tool missing here is reported, not skipped silently.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TABLE = [
  ["cjk_viz", "1 no chart shapes", true], ["headline_wrap", "1 no chart shapes", true], ["hero_stat_kicker_dedupe", "1 no chart shapes", true],
  ["hero_stat_restyle", "1 no chart shapes", true], ["house_style_fonts", "1 no chart shapes", true], ["infographic_house_style", "1 no chart shapes", true],
  ["infographic_source_quote", "1 no chart shapes", true],
  ["treemap", "2 treemap tiles", true], ["waffle_chart", "2 waffle cells", true], ["viz_snapshots", "2 waffle/treemap", true], ["viz_stacked_bar_100", "2 stacked segments", true],
  // red for their own reasons, not the two ordered kinds:
  ["render_qa", "other: a rotated label is unmeasured, so no text was proven", false],
  ["viz_mirrored_bar", "all zero: the all-zero chart is asserted to be rejected, with both ways out in the message", true],
  ["shadow_parity", "other: byte comparison with the baseline differs by design, the switch adds extra_checks", false],
];
const run = (name, on) => {
  const env = { ...process.env };
  delete env.NEWSROOM_QA_NO_EMPTY_PASS;
  if (on) env.NEWSROOM_QA_NO_EMPTY_PASS = "1";
  return spawnSync("node", [`scripts/test_${name}.mjs`], { cwd: ROOT, env, encoding: "utf8", timeout: 240000 }).status === 0;
};
let rows = "";
for (const [name, kind, expected] of TABLE) {
  assert.equal(run(name, false), true, `${name}: passes with the switch off`);
  const on = run(name, true);
  assert.equal(on, expected, `${name} (${kind}): switch on should be ${expected ? "green" : "red"}`);
  rows += `${name.padEnd(26)} ${on ? "green" : "red  "}  ${kind}\n`;
}
console.log(rows.trimEnd());
console.log("PASS qa no-empty-pass fixture table");
