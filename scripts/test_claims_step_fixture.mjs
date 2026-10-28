// The fixture claims step (claims_step_fixture.mjs) on a small SDMX-CSV file: the where filter keeps the key's rows, the narrow keeps the data
// step's members, and the picked conclusions register through duckdb_query and record_claim with their claim_bindings. With FIXTURE_CSV
// (and FIXTURE_WHERE, FIXTURE_NARROW, FIXTURE_PICKS as on the command line) it also prints what a stored fixture gives, without asserting it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTmp } from "./tmp_helper.mjs";
import { claimsFromFixture } from "./claims_step_fixture.mjs";

const head = "DATAFLOW,LAST UPDATE,freq,siec,partner,unit,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG,CONF_STATUS";
const values = { 2021: { RU: 150, NO: 80, US: 5, DZ: 30, QA: 15, EUR_OTH: 99, TOTAL: 300 }, 2024: { RU: 30, NO: 90, US: 60, DZ: 20, QA: 10, EUR_OTH: 95, TOTAL: 305 } };
const lines = [head];
for (const geo of ["EU27_2020", "DE"]) {
  for (const [year, byPartner] of Object.entries(values)) {
    for (const [partner, v] of Object.entries(byPartner)) lines.push(`ESTAT:NRG_TI_GAS(1.0),01/01/26 00:00:00,A,G3000,${partner},MIO_M3,${geo},${year},${geo === "DE" ? v / 10 : v},,`);
  }
}
const csv = join(makeTestTmp("claims-step-fixture-"), "flows.csv");
writeFileSync(csv, lines.join("\n") + "\n");

const got = await claimsFromFixture({ csv, where: { geo: "EU27_2020" }, narrow: { dimension: "partner", n: 3, total: "TOTAL", exclude: ["EUR_OTH"] }, picks: ["c1", "c2", "c3"] });
assert.equal(got.stop, undefined, got.stop);
assert.deepEqual(got.cut, { members: ["NO", "US", "RU"], total: "TOTAL" }, "the data step's rule: latest year, total and excluded codes out, by value");
const file = readFileSync(join(got.art, got.ref), "utf8");
assert.doesNotMatch(file, /,DE,/, "the where filter keeps the key's rows only");
assert.doesNotMatch(file, /,(DZ|QA|EUR_OTH),/, "the narrow keeps the members and the total");
console.log("PASS the file is kept to the key's rows and narrowed by the data step's own rule");

assert.equal(got.outcome.status, "ok", JSON.stringify(got.outcome));
assert.equal(got.claims.length, 3);
for (const claim of got.claims) {
  const sheet = got.conclusions.find((c) => c.text === claim.claim);
  assert.ok(sheet, `${claim.claim} is a conclusion's sentence, word for word`);
  assert.ok(Array.isArray(claim.claim_bindings) && claim.claim_bindings.length > 0, `${claim.claim} carries claim_bindings`);
  assert.equal(claim.recorded_by, "newsroom_data_prepare");
}
console.log(`PASS 3 picks register through duckdb_query and record_claim with claim_bindings: ${got.claims.map((c) => c.claim).join(" | ")}`);

if (process.env.FIXTURE_CSV) {
  const where = Object.fromEntries((process.env.FIXTURE_WHERE ?? "").split(";").filter(Boolean).map((kv) => kv.split("=")));
  const [dimension, n, total, exclude] = (process.env.FIXTURE_NARROW ?? "").split(":");
  const narrow = dimension ? { dimension, n: Number(n), ...(total ? { total } : {}), exclude: exclude ? exclude.split(",") : [] } : undefined;
  const t0 = Date.now();
  const fixture = await claimsFromFixture({ csv: process.env.FIXTURE_CSV, where, narrow, picks: (process.env.FIXTURE_PICKS ?? "c1,c2,c3").split(",") });
  console.log(`FIXTURE ${process.env.FIXTURE_CSV} ms ${Date.now() - t0} run ${fixture.art}`);
  console.log(JSON.stringify({ stop: fixture.stop, cut: fixture.cut, conclusions: fixture.conclusions, dropped: fixture.dropped, outcome: fixture.outcome?.status, claims: fixture.claims?.map((c) => ({ claim: c.claim, claim_bindings: c.claim_bindings })) }, null, 2));
}
