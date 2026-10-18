#!/usr/bin/env node
// K1017b: the `kind === "economy"` term of buildLocationEvidence's matched rule is guarded directly. A real table never gives a non-economy entry
// a basemap feature, so this test runs a COPY of runtime/pi whose US-state table is tampered to kind "aggregate" (states keep iso3 and features):
// they must come out unmatched. Without the term in location_evidence.mjs every row would be matched (red). Rows are hand-written fixtures.
// Run: node scripts/test_location_evidence_kind.mjs
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
process.env.NEWSROOM_US_STATES = "1";
const SRC = new URL("../runtime/pi/", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "k1017b-"));
try {
  cpSync(SRC, dir, { recursive: true });
  const f = join(dir, "economy_names.mjs");
  const text = readFileSync(f, "utf8");
  const needle = 'iso3: `US-${row.usps}`, kind: "economy" }';
  ok(text.includes(needle), "the US-state table line this test tampers with still exists");
  writeFileSync(f, text.replace(needle, 'iso3: `US-${row.usps}`, kind: "aggregate" }'));
  const spec = (chart_type) => ({ chart_type, category_field: "st", category_names: "us_state" });
  const rows = [{ st: "CA", value: 3 }, { st: "TX", value: 2 }];
  const real = await import(new URL("location_evidence.mjs", SRC));
  const fake = await import(pathToFileURL(join(dir, "location_evidence.mjs")).href);
  for (const t of ["symbol_map", "choropleth"]) {
    const a = real.buildLocationEvidence(rows, spec(t));
    ok(a.join_status === "all_matched" && a.matched_count === 2, `${t}: real table, both states match`);
    const b = fake.buildLocationEvidence(rows, spec(t));
    ok(b.rows.every((r) => r.iso3 && r.feature_indices.length > 0), `${t}: tampered table still gives iso3 and basemap features`);
    ok(b.join_status === "has_unmatched" && b.matched_count === 0 && b.unmatched.join() === "CA,TX", `${t}: a non-economy entry is unmatched although it has features`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`test_location_evidence_kind: ${checks} checks passed`);
