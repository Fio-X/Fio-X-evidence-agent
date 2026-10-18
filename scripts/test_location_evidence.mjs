#!/usr/bin/env node
// NEWSROOM_LOCATION_EVIDENCE (default off): a choropleth writes what its own name join proved; checkLocationEvidence and locationProofFor say whether it counts.
// Run: node scripts/test_location_evidence.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const R = new URL("../runtime/pi/", import.meta.url);
const le = await import(new URL("location_evidence.mjs", R));
const lp = await import(new URL("location_proof.mjs", R));
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const SW = "NEWSROOM_LOCATION_EVIDENCE";
const withSwitch = (v, fn) => { const old = process.env[SW]; if (v === undefined) delete process.env[SW]; else process.env[SW] = v; try { return fn(); } finally { if (old === undefined) delete process.env[SW]; else process.env[SW] = old; } };
const on = (fn) => withSwitch("1", fn), off = (fn) => withSwitch(undefined, fn);
const refusal = (fn) => { try { fn(); return ""; } catch (e) { return String(e.message); } };
const sha = (t) => createHash("sha256").update(t).digest("hex");

// ---- the evidence itself (choropleth only; the join is the renderer's own) ----
// The Eurostat gas-import countries of the Germany page (iso2), then the Eurostat-only codes EL and UK that the table aliases.
const spec = (names, field = "iso2") => ({ chart_type: "choropleth", category_field: field, category_names: names });
const DE = ["NO", "NL", "BE", "US", "FR"].map((c, i) => ({ iso2: c, value: 100 - i }));
const evDE = le.buildLocationEvidence(DE, spec("iso2"));
ok(evDE.join_status === "all_matched" && evDE.unmatched.length === 0 && evDE.matched_count === 5, "Germany page rows (iso2) all join to the world basemap");
ok(evDE.rows.every((r) => r.iso3 && r.feature_indices.length > 0), "every row names an iso3 and at least one basemap feature");
ok(evDE.rows.find((r) => r.raw === "FR").iso3 === "FRA" && evDE.rows.find((r) => r.raw === "NO").iso3 === "NOR", "France and Norway (Natural Earth ISO_A3 = -99) resolve through ISO_A3_EH");
ok(evDE.basemap_id === "naturalearth_admin0_50m" && /^[0-9a-f]{64}$/.test(evDE.basemap_content_hash), "it names the registered world basemap and its content hash");
const evEU = le.buildLocationEvidence([{ iso2: "EL", value: 1 }, { iso2: "UK", value: 2 }, { iso2: "DE", value: 3 }], spec("iso2"));
ok(evEU.join_status === "all_matched" && evEU.rows[0].iso3 === "GRC" && evEU.rows[1].iso3 === "GBR", "Eurostat EL and UK join through the table aliases");
ok(le.locationEvidenceText(evDE).text === le.locationEvidenceText(le.buildLocationEvidence(DE, spec("iso2"))).text, "same rows and spec give the same bytes (replayable)");
const evBad = le.buildLocationEvidence([{ iso2: "NO", value: 1 }, { iso2: "ZZ", value: 2 }], spec("iso2"));
ok(evBad.join_status === "has_unmatched" && evBad.unmatched.join() === "ZZ" && evBad.matched_count === 1, "an unknown code is listed as unmatched, not dropped");
const evAgg = le.buildLocationEvidence([{ iso3: "WLD", value: 1 }], spec("iso3", "iso3"));
ok(evAgg.join_status === "has_unmatched", "an aggregate (World) is not a place: unmatched");
ok(le.buildLocationEvidence([], spec("iso2")).join_status === "empty", "no rows: empty");
process.env.NEWSROOM_US_STATES = "1";
const states = ["CA", "TX", "NY", "DC"].map((c, i) => ({ st: c, value: i }));
const evUS = le.buildLocationEvidence(states, spec("us_state", "st"));
ok(evUS.join_status === "all_matched" && evUS.basemap_id === "naturalearth_admin1_us_110m" && evUS.rows[0].iso3 === "US-CA", "us_state: USPS codes join to the state basemap");
ok(le.buildLocationEvidence([{ st: "CA", value: 1 }, { st: "PR", value: 2 }], spec("us_state", "st")).join_status === "has_unmatched", "us_state: a code that is not one of the 50 states and DC is unmatched");
delete process.env.NEWSROOM_US_STATES;
// coordinate maps never have this join
for (const t of ["cartographic_flow_map", "geo_flow_map", "sankey"]) ok(le.buildLocationEvidence(DE, { ...spec("iso2"), chart_type: t }) === null, `${t}: no evidence is written`);

// ---- the check a reader of the manifest makes ----
const good = le.locationEvidenceText(evDE);
const manifest = (over = {}) => ({ chart_type: "choropleth", row_count: 5, location_evidence_ref: "visualizations/locations/k.json", location_evidence_sha256: good.sha256, ...over });
ok(le.checkLocationEvidence(manifest(), good.text).ok, "intact evidence passes");
ok(le.checkLocationEvidence(manifest(), good.text.replace("FRA", "DEU")).reason === "hash_mismatch", "a hand-edited evidence file fails the manifest hash");
const forged = JSON.stringify({ ...evDE, basemap_content_hash: "0".repeat(64) }, null, 2) + "\n";
ok(le.checkLocationEvidence(manifest({ location_evidence_sha256: sha(forged) }), forged).reason === "basemap_mismatch", "evidence naming a different basemap hash fails");
ok(le.checkLocationEvidence(manifest({ row_count: 6 }), good.text).reason === "row_count_mismatch", "evidence for another row count fails");
const bad = le.locationEvidenceText(evBad);
ok(le.checkLocationEvidence(manifest({ row_count: 2, location_evidence_sha256: bad.sha256 }), bad.text).reason === "not_all_matched", "evidence with an unmatched row fails");
ok(le.checkLocationEvidence(manifest({ location_evidence_sha256: undefined }), good.text).reason === "no_evidence", "a manifest without the hash fails");
ok(le.checkLocationEvidence(manifest({ chart_type: "cartographic_flow_map" }), good.text).reason === "not_a_choropleth", "a coordinate map manifest never passes");


// ---- the page-level rule: only intact choropleth evidence proves locations ----
const mods = (mapChart = "choropleth") => [{ id: "f", type: "visual", visual_grammar: "flow" }, { id: "m", type: "visual", visual_grammar: "spatial", chart: mapChart }];
const proofFor = (modules, checks) => lp.locationProofFor(modules, checks);
const chk = (okm, type = "choropleth") => ({ f: { chart_type: "sankey", ok: false }, m: { chart_type: type, ok: okm } });
ok(proofFor(mods(), chk(true)) === true, "proof: the one map module has intact evidence");
ok(proofFor(mods(), chk(false)) === false, "proof: the map module's evidence failed");
ok(proofFor(mods(), { f: { chart_type: "sankey", ok: false } }) === false, "proof: a module with no check is unproven");
ok(proofFor([mods()[0]], { f: { chart_type: "sankey", ok: false } }) === false, "proof: a page with no map has nothing proven");
ok(proofFor(mods(), chk(true, "cartographic_flow_map")) === false, "LOCK: a coordinate map on the page never proves locations, even when marked ok");
ok(proofFor(mods(), chk(true, "geo_flow_map")) === false, "LOCK: geo_flow_map either");
const two = [...mods(), { id: "m2", type: "visual", visual_grammar: "spatial" }];
ok(proofFor(two, { ...chk(true), m2: { chart_type: "cartographic_flow_map", ok: true } }) === false, "LOCK: one proven choropleth plus one coordinate map is not proven");
const noEntry = [{ id: "m", type: "visual", chart: "choropleth" }, { id: "c", type: "visual", chart: "cartographic_flow_map" }];
ok(proofFor(noEntry, { m: { chart_type: "choropleth", ok: true } }) === false, "LOCK: a coordinate map with no check entry keeps the page unproven");
const noEntrySpatial = [{ id: "m", type: "visual", chart: "choropleth" }, { id: "c", type: "visual", visual_grammar: "spatial" }];
ok(proofFor(noEntrySpatial, { m: { chart_type: "choropleth", ok: true } }) === false, "LOCK: a spatial module with no check entry keeps the page unproven");
ok(proofFor([noEntry[0]], { m: { chart_type: "choropleth", ok: true } }) === true, "a lone choropleth with intact evidence still proves");
ok(!lp.locationEvidenceEnabled({ NEWSROOM_LOCATION_EVIDENCE: "2" }) && lp.locationEvidenceEnabled({ NEWSROOM_LOCATION_EVIDENCE: "1" }) && !lp.locationEvidenceEnabled({}), "only the exact value 1 turns it on");
// ---- symbol_map (K1013): same join, same checks. TEST FIXTURE rows (hand-written ISO2 codes), not real data. ----
const symSpec = { ...spec("iso2"), chart_type: "symbol_map" };
const evSym = le.buildLocationEvidence(DE, symSpec);
ok(evSym && evSym.chart_type === "symbol_map" && evSym.join_status === "all_matched" && evSym.matched_count === 5, "symbol_map: evidence is written and all rows join");
ok(JSON.stringify(evSym.rows) === JSON.stringify(evDE.rows) && evSym.basemap_content_hash === evDE.basemap_content_hash, "symbol_map: the same join as the choropleth, row for row");
const symText = le.locationEvidenceText(evSym);
const symManifest = (over = {}) => manifest({ chart_type: "symbol_map", location_evidence_sha256: symText.sha256, ...over });
ok(le.checkLocationEvidence(symManifest(), symText.text).ok, "symbol_map: intact evidence passes");
ok(le.checkLocationEvidence(symManifest(), symText.text.replace("FRA", "DEU")).reason === "hash_mismatch", "symbol_map: hand-edited evidence fails the hash");
const symForged = JSON.stringify({ ...evSym, basemap_content_hash: "0".repeat(64) }, null, 2) + "\n";
ok(le.checkLocationEvidence(symManifest({ location_evidence_sha256: sha(symForged) }), symForged).reason === "basemap_mismatch", "symbol_map: another basemap hash fails");
ok(le.checkLocationEvidence(symManifest({ row_count: 6 }), symText.text).reason === "row_count_mismatch", "symbol_map: another row count fails");
const symBad = le.locationEvidenceText(le.buildLocationEvidence([{ iso2: "NO", value: 1 }, { iso2: "ZZ", value: 2 }], symSpec));
ok(le.checkLocationEvidence(symManifest({ row_count: 2, location_evidence_sha256: symBad.sha256 }), symBad.text).reason === "not_all_matched", "symbol_map: an unmatched row fails");
ok(le.checkLocationEvidence(symManifest({ location_evidence_sha256: undefined }), symText.text).reason === "no_evidence", "symbol_map: no hash fails");
ok(le.checkLocationEvidence(symManifest({ chart_type: "choropleth" }), symText.text).reason === "wrong_schema", "a choropleth manifest does not accept symbol_map evidence");
ok(le.checkLocationEvidence(symManifest({ location_evidence_sha256: good.sha256 }), good.text).reason === "wrong_schema", "a symbol_map manifest does not accept choropleth evidence");
const symChk = (okm, type = "symbol_map") => ({ f: { chart_type: "sankey", ok: false }, m: { chart_type: type, ok: okm } });
ok(proofFor(mods("symbol_map"), symChk(true)) === true, "proof: a symbol_map module with intact evidence proves the page");
ok(proofFor(mods("symbol_map"), symChk(false)) === false, "proof: a symbol_map module whose evidence failed does not");
ok(proofFor(mods("symbol_map"), { f: { chart_type: "sankey", ok: false } }) === false, "proof: a symbol_map module with no check entry is unproven");
ok(proofFor(two.map((m) => (m.id === "m" ? { ...m, chart: "symbol_map" } : m)), { ...symChk(true), m2: { chart_type: "cartographic_flow_map", ok: true } }) === false, "LOCK: a proven symbol_map plus a coordinate map is not proven");
console.log(`test_location_evidence: ${checks} checks passed`);
