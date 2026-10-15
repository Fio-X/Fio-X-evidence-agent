#!/usr/bin/env node
// #91: two different unit scales on one side of a Sankey node are refused (NEWSROOM_SANKEY_MIXED_UNITS=1, exact, default off).
// The spec names the column that holds each edge's unit in the optional field flow_unit_field.
import assert from "node:assert/strict";
import { lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";

const spec = { schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "Coal feeds power", chart_type: "sankey", title: "Energy flow", alt: "A sankey of energy flow", source_note: "Fixture", claim_id: "claim-91", sql: "SELECT 1", unit: "Mt", source_field: "source", target_field: "target", value_field: "value", flow_unit_field: "unit", note: "Fixture.", language: "en" };
const edge = (source, target, value, unit) => ({ source, target, value, unit });
const blockersOf = (s, rows) => lintVizSpec(s, rows).blockers.filter((b) => /different units/.test(b));
const KEY = "NEWSROOM_SANKEY_MIXED_UNITS";
const withSwitch = (value, fn) => { const old = process.env[KEY]; if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value; try { return fn(); } finally { if (old === undefined) delete process.env[KEY]; else process.env[KEY] = old; } };

const mixedOut = [edge("Coal", "Power", 5, "Gt"), edge("Coal", "Heat", 400, "Mt"), edge("Power", "Homes", 3, "Gt"), edge("Heat", "Homes", 4, "Gt")];
const mixedIn = [edge("Coal", "Homes", 5, "Gt"), edge("Gas", "Homes", 400, "Mt")];
const single = [edge("Coal", "Power", 5, "Gt"), edge("Coal", "Heat", 4, "Gt"), edge("Power", "Homes", 5, "Gt"), edge("Heat", "Homes", 4, "Gt")];
const perNode = [edge("Coal", "Power", 5, "Gt"), edge("Coal", "Heat", 4, "Gt"), edge("Power", "Homes", 500, "Mt"), edge("Heat", "Homes", 400, "Mt")];

// 1 mixed units on one node's outgoing edges are refused, naming node, side and units
const outBlockers = withSwitch("1", () => blockersOf(spec, mixedOut));
assert.equal(outBlockers.length, 1);
assert.match(outBlockers[0], /'Coal'.*outgoing.*'Gt'.*'Mt'/);
// 2 mixed units on one node's incoming edges are refused
const inBlockers = withSwitch("1", () => blockersOf(spec, mixedIn));
assert.equal(inBlockers.length, 1);
assert.match(inBlockers[0], /'Homes'.*incoming.*'Gt'.*'Mt'/);
// 3 a single unit is accepted
assert.deepEqual(withSwitch("1", () => blockersOf(spec, single)), []);
// 4 different units on different nodes (each node uniform) are accepted: not layer-wide
assert.deepEqual(withSwitch("1", () => blockersOf(spec, perNode)), []);
// 5 spaces around a unit do not make a second unit; an empty unit is not a unit
assert.deepEqual(withSwitch("1", () => blockersOf(spec, [edge("Coal", "Power", 5, "Gt"), edge("Coal", "Heat", 4, " Gt "), edge("Coal", "Gas", 1, "")])), []);
// 6 field absent: nothing is checked
const { flow_unit_field: _drop, ...noField } = spec;
assert.deepEqual(withSwitch("1", () => blockersOf(noField, mixedOut)), []);
// 7 switch off, or any value other than exactly "1": not refused
for (const value of [undefined, "0", "", "true", "yes", "2", " 1"]) assert.deepEqual(withSwitch(value, () => blockersOf(spec, mixedOut)), [], `switch value ${JSON.stringify(value)}`);
// 8 the optional field on a sankey does not break validation
assert.deepEqual(validateVizSpec(spec), []);
// 9 a clean flow draws byte-identically with the switch on and off
const off = withSwitch(undefined, () => renderVizBundle(spec, single));
const on = withSwitch("1", () => renderVizBundle(spec, single));
assert.equal(on.desktop, off.desktop);
assert.deepEqual(on, off);
console.log("ok: sankey mixed units");
