#!/usr/bin/env node
// The English compact choropleth labels (1.2k / 2.4m / 1.5bn) pinned both ways: fixtures/compact-label-cases.json holds what the
// real renderer (choroplethValueText) prints for a grid of values, this test fails if the renderer's text drifts from it, and the
// Rust test compact_labels_from_the_renderer_are_all_read_back (src/verify.rs) reads the same file through scaled_label_matches.
// Run: node scripts/test_compact_label_cases.mjs        Regenerate: node scripts/test_compact_label_cases.mjs --write
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { choroplethValueText } from "../runtime/pi/viz.mjs";

const FILE = new URL("../fixtures/compact-label-cases.json", import.meta.url);
const mantissas = [1, 1.04999, 1.05, 1.0501, 1.1557, 1.15, 1.25, 1.2499, 2.431, 4.949, 5, 9.95, 9.99, 99.94, 99.95, 500.5, 999.94];
const values = [];
for (const scale of [1e3, 1e6, 1e9]) for (const m of mantissas) { const v = m * scale; if (v < scale * 1000) values.push(v, -v); }
values.push(1155.7, 1250, 999.96, 999999.5);
const cases = [...new Set(values)].map((value) => ({ value, label: choroplethValueText(value, "") }));
if (process.argv.includes("--write")) { writeFileSync(FILE, JSON.stringify(cases, null, 1) + "\n"); console.log(`wrote ${cases.length} cases`); process.exit(0); }
assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")), cases, "fixtures/compact-label-cases.json differs from what choroplethValueText prints; regenerate with --write and re-run the Rust tests");
assert.ok(cases.some((c) => c.value === 1155.7 && c.label === "1.2k"), "the Germany page's Norway pair is in the grid");
console.log(`test_compact_label_cases: ${cases.length} renderer labels match the pinned file -- PASS`);
