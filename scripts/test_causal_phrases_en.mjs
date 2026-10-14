// NEWSROOM_CAUSAL_PHRASES_EN (default off, exact "1"): the English causal-phrase refusal also names "as a result of".
// Off: byte-identical to today. On: only ever refuses more. Already refused today (switch off): due to, owing to, thanks to, because (of).
import assert from "node:assert/strict";
import { evaluateClaimSupport } from "../runtime/pi/evidence_gate.mjs";
import { lintInfographicSpec } from "../runtime/pi/infographic.mjs";

const BLOCK = "claim_contains_unbound_causal_or_motive_language";
const NAME = "NEWSROOM_CAUSAL_PHRASES_EN";
const withSwitch = (value, fn) => {
  const before = process.env[NAME];
  if (value === undefined) delete process.env[NAME]; else process.env[NAME] = value;
  try { return fn(); } finally { if (before === undefined) delete process.env[NAME]; else process.env[NAME] = before; }
};
const verdict = (claim, kind = "descriptive") => evaluateClaimSupport({ requested_status: "supported", claim_kind: kind, claim });
const blocked = (claim) => verdict(claim).reasons.includes(BLOCK);

// The phrases the rule already refuses with the switch off (so the item's other three phrases need no change).
for (const claim of ["Output fell due to weak demand", "Sales rose thanks to a new subsidy", "Output fell because of weak demand", "Output fell owing to weak demand"]) {
  withSwitch(undefined, () => assert.ok(blocked(claim), `already refused off: ${claim}`));
}

// 4 refused with the switch on and no supporting claim, each hitting only the new phrase (not refused with it off).
const NEW = [
  "Output fell as a result of weak demand",
  "As a result of the new subsidy, sales rose 12%.",
  "Prices rose 4% as  a  result of the tariff.",
  "Enrolment grew AS A RESULT OF the reform.",
];
for (const claim of NEW) {
  withSwitch(undefined, () => assert.ok(!blocked(claim), `off: not refused, as today: ${claim}`));
  withSwitch("1", () => assert.ok(blocked(claim), `on: refused by 'as a result of': ${claim}`));
  for (const other of ["true", "yes", "0", "", "11", " 1"]) withSwitch(other, () => assert.ok(!blocked(claim), `${JSON.stringify(other)} is off: ${claim}`));
}

// Off is byte-identical to today, on only adds: no claim refused with it off passes with it on; plain text is untouched either way.
const PROBES = [...NEW, "Output fell due to weak demand", "Conflict caused migration.", "Germany ranks first in EU imports.", "The selected sum increased by 89%.",
  "Totals may not add to 100 due to rounding", "The result of the vote was 52%.", "A result of 4 was recorded as a rule of thumb.", "由于疫情冲击，出生率下降", "导致出生率下降"];
for (const claim of PROBES) {
  const off = withSwitch(undefined, () => JSON.stringify(verdict(claim)));
  const on = withSwitch("1", () => JSON.stringify(verdict(claim)));
  if (!NEW.includes(claim)) assert.equal(on, off, `unrelated text unchanged: ${claim}`);
  const offBlocked = JSON.parse(off).reasons.includes(BLOCK);
  if (offBlocked) assert.ok(JSON.parse(on).reasons.includes(BLOCK), `on never refuses fewer: ${claim}`);
}

// With a cited causal claim recorded, editorial text using the new phrase is accepted; without it, refused (the page gate that already
// handles "driven"/"caused"). The records are system-verified, publishable causal ones, exactly what that gate reads.
const spec = { title: "Weather and rain", dek: "Output fell as a result of weak demand.", modules: [] };
const records = (kind) => [{ claim_id: "c1", claim_kind: kind, verification: { authority: "system", publishable: true } }];
const lint = (kind) => lintInfographicSpec(spec, {}, { verified_claim_records: records(kind) }).blockers.filter((b) => b.startsWith("unbound_causal_editorial_language"));
withSwitch("1", () => {
  assert.deepEqual(lint("quantitative"), ["unbound_causal_editorial_language:dek"], "no supporting causal claim: refused");
  assert.deepEqual(lint("causal"), [], "cited causal claim: accepted (1)");
  assert.deepEqual(lint("mechanistic"), [], "cited mechanistic claim: accepted (2)");
});
withSwitch(undefined, () => assert.deepEqual(lint("quantitative"), [], "off: as today, not refused"));
console.log("causal phrases en gate -- PASS");
