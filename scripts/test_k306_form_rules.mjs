// Locks the K306 convention for config/form-rules.json (proposal data, not wired into the flow):
// a rule marked 推断 may only warn; reject needs basis 成文 and a computable condition; pending rules never act.
import fs from "node:fs";
import assert from "node:assert/strict";
const doc = JSON.parse(fs.readFileSync(new URL("../config/form-rules.json", import.meta.url), "utf8"));
const ACTIONS = ["reject", "warn"], BASES = ["成文", "推断"], SCOPES = ["form", "page"];
const computableStatus = new Set(["computed_today", "derivable"]);
let checks = 0;
const ok = (cond, msg) => { checks += 1; assert.ok(cond, msg); };
const ids = new Set();
for (const group of ["rules", "pending_rules"]) {
  for (const r of doc[group]) {
    ok(!ids.has(r.rule_id), `duplicate rule_id ${r.rule_id}`); ids.add(r.rule_id);
    ok(BASES.includes(r.basis), `${r.rule_id}: basis must be 成文 or 推断`);
    ok(SCOPES.includes(r.scope), `${r.rule_id}: bad scope`);
    ok(Array.isArray(r.sources) && r.sources.length > 0, `${r.rule_id}: needs a source`);
    for (const s of r.sources) ok(s.cite && s.read_status, `${r.rule_id}: source needs cite and read_status`);
    for (const f of r.condition.fields) ok(f in doc.fields || f in doc.missing_fields, `${r.rule_id}: unknown field ${f}`);
    const allComputable = r.condition.fields.every((f) => f in doc.fields && computableStatus.has(doc.fields[f].status));
    if (group === "rules") {
      ok(ACTIONS.includes(r.action), `${r.rule_id}: action must be reject or warn`);
      ok(r.computable === true && allComputable, `${r.rule_id}: listed as computable but a condition field is not`);
      ok(r.condition.fields.length > 0, `${r.rule_id}: needs condition fields`);
      if (r.basis === "推断") ok(r.action === "warn", `${r.rule_id}: 推断 may only warn`);
      if (r.action === "reject") ok(r.basis === "成文" && allComputable, `${r.rule_id}: reject needs 成文 and a computable condition`);
    } else {
      ok(r.action === null, `${r.rule_id}: pending rules do not act`);
      ok(r.computable === false, `${r.rule_id}: pending rules are not computable`);
      ok(Array.isArray(r.missing) && r.missing.length > 0 && r.missing.every((m) => m in doc.missing_fields), `${r.rule_id}: missing must name entries of missing_fields`);
      ok([...ACTIONS, null].includes(r.intended_action), `${r.rule_id}: bad intended_action`);
      if (r.basis === "推断") ok(r.intended_action !== "reject", `${r.rule_id}: 推断 may not intend reject`);
    }
  }
}
// every K305 row is present, with the basis K305 gave it
const k305 = { T1: "推断", T2: "推断", T3: "推断", T4a: "成文", T4b: "推断", T5: "推断", T6: "推断", T7a: "成文", T7b: "成文", T8: "成文",
  C1: "成文", C2: "成文", C3: "成文", C4: "成文", C5: "推断", C6: "推断", C7: "成文", C8: "推断" };
const all = [...doc.rules, ...doc.pending_rules];
for (const [k, basis] of Object.entries(k305)) {
  const r = all.find((x) => x.rule_id.startsWith(`${k}-`));
  ok(r && r.basis === basis, `K305 ${k} missing or wrong basis`);
}
// rules mirroring the live runtime table keep its ids' meaning
const mirror = doc.rules.filter((r) => r.mirrors_runtime).map((r) => r.rule_id).sort();
ok(mirror.length === 3, "three rules mirror runtime FORM_RULES");
ok(doc.reserved_slots.length >= 2, "K305 slots kept");
console.log(`test_k306_form_rules: ${checks} checks PASS (${doc.rules.length} rules, ${doc.pending_rules.length} pending)`);
