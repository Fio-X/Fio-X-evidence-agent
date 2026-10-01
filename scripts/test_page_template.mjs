#!/usr/bin/env node
// Page-template rules: continuous module numbering (hero_stat takes no
// number), one-time footer sources, and bar emphasis lint.
import assert from "node:assert/strict";
import { composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { lintVizSpec } from "../runtime/pi/viz.mjs";

const claim = "claim-page-template";
const spec = {
  schema_version: "1.0.0", kicker: "K", title: "Template rules", dek: "d", alt: "A four-module fixture checking page numbering and source lines.", byline: "n", date_label: "x",
  layout: "feature", complexity_budget: "low", language: "zh",
  source_note: "机构甲《统计公报》；机构乙清单",
  modules: [
    { id: "a", type: "text", span: "full", label: "一", heading: "H1", body: "b1", claim_ids: [claim] },
    { id: "s", type: "hero_stat", span: "third", tone: "accent", value: "5", unit: "个", label: "L", detail: "D", claim_id: claim },
    { id: "b", type: "text", span: "full", label: "二", heading: "H2", body: "b2", claim_ids: [claim] },
    { id: "c", type: "text", span: "full", label: "三", heading: "H3", body: "b3", claim_ids: [claim] },
  ],
};
const svg = composeInfographicBundle(structuredClone(spec), {}).desktop.svg;
const ordinals = [...svg.matchAll(/letter-spacing="1.5" fill="#[0-9A-Fa-f]{6}">(\d\d)(?: ·|<)/g)].map((m) => m[1]);
assert.deepEqual(ordinals, ["01", "02", "03"], `ordinals must be continuous, got ${ordinals}`);
const footer = svg.slice(svg.indexOf("统计公报"));
assert.equal((svg.match(/机构乙清单/g) ?? []).length, 1, "a repeated citation is written once");

// bar emphasis: an unmatched highlight is surfaced, a matched one is not.
const base = { chart_type: "horizontal_bar", category_field: "c", value_field: "v", title: "t", subtitle: "s", source_note: "n", unit: "u", language: "zh" };
const rows = [{ c: "A", v: 3 }, { c: "B", v: 1 }];
const warn = (highlight_values) => (lintVizSpec({ ...base, highlight_values }, rows, {}).warnings ?? []).join("|");
assert.match(warn(["Z"]), /match no 'c' value/);
assert.doesNotMatch(warn(["A"]), /match no/);
assert.doesNotMatch(warn([]), /match no/);
console.log("page template OK");
