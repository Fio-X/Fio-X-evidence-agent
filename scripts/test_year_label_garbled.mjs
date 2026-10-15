#!/usr/bin/env node
// NEWSROOM_YEAR_LABEL_GARBLED=1 (exact "1", default off): a year label that prints a raw float or an escape-style suffix is
// refused before render; a clean year label is accepted; with the switch off the output is the same as before.
import assert from "node:assert/strict";
import { renderVizSvg } from "../runtime/pi/viz.mjs";

const spec = {
  schema_version: "0.7.0", reader_task: "change", takeaway: "Illustrative fixture for the year label check.", language: "en",
  alt: "placeholder alt text", source_note: "test data", claim_id: "claim-year-label", sql: "SELECT * FROM synthetic",
  chart_type: "line", title: "Year label check", unit: "%", x_field: "year", value_field: "value",
};
const mk = (years) => years.map((year, i) => ({ year, value: 10 + i * 3 }));
const clean = mk(["2019", "2020", "2021", "2022"]);
const withEnv = (value, fn) => {
  const prev = process.env.NEWSROOM_YEAR_LABEL_GARBLED;
  if (value === undefined) delete process.env.NEWSROOM_YEAR_LABEL_GARBLED; else process.env.NEWSROOM_YEAR_LABEL_GARBLED = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env.NEWSROOM_YEAR_LABEL_GARBLED; else process.env.NEWSROOM_YEAR_LABEL_GARBLED = prev; }
};

// 1. garbled labels are refused before render (switch on)
for (const bad of [["2019.0", "2020.0", "2021.0"], ["2019", "2019.5", "2020"], ["2019’", "2020", "2021"], ["2019\\u2019", "2020", "2021"], ["2019\\", "2020", "2021"]]) {
  assert.throws(() => withEnv("1", () => renderVizSvg(spec, mk(bad))), /YEAR_LABEL_GARBLED/, `refused: ${JSON.stringify(bad)}`);
}
assert.throws(() => withEnv("1", () => renderVizSvg(spec, mk([2019, 2019.5, 2020]))), /YEAR_LABEL_GARBLED/, "numeric 2019.5 refused");
assert.throws(() => withEnv("1", () => renderVizSvg(spec, mk([2019, 2019.5, 2020]))), /write the year as an integer, or a period as text such as 2019 H1 or 2019-12/, "message names both fixes");
// 2. a clean label is accepted (strings and integers)
withEnv("1", () => { assert.ok(renderVizSvg(spec, clean).startsWith("<svg")); assert.ok(renderVizSvg(spec, mk([2019, 2020, 2021])).startsWith("<svg")); });
// 3. switch off, or any value other than exactly "1": byte-identical to before, garbled label is not refused here
const garbled = mk(["2019.0", "2020.0", "2021.0"]);
for (const v of [undefined, "", "0", "true", "yes", "1 "]) {
  withEnv(v, () => { assert.doesNotThrow(() => renderVizSvg(spec, garbled), `off with ${JSON.stringify(v)}`); });
}
assert.equal(withEnv("1", () => renderVizSvg(spec, clean)), withEnv(undefined, () => renderVizSvg(spec, clean)), "clean render is identical on and off");
console.log("test_year_label_garbled: PASS");
