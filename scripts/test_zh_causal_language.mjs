import assert from "node:assert/strict";
import { evaluateClaimSupport } from "../runtime/pi/evidence_gate.mjs";

const BLOCK = "claim_contains_unbound_causal_or_motive_language";
const check = (claim) => evaluateClaimSupport({ requested_status: "supported", claim_kind: "descriptive", claim });

// Chinese causal wording the gate must refuse without a separate causal claim.
for (const claim of [
  "由于疫情冲击，出生率连续三年下降",
  "老龄化加速造成劳动年龄人口持续萎缩",
  "房价上涨引起年轻人迁出一线城市",
  "出口下滑可归因于海外需求走弱",
  "能源价格飙升致使制造业成本抬升",
  "补贴退坡促使新能源车销量增速放缓",
  "这一波降温主要是极端天气所致",
  "人口流出源于就业机会减少",
]) {
  assert.ok(check(claim).reasons.includes(BLOCK), `must block: ${claim}`);
}

// Method notes about data handling and plain descriptions must pass.
for (const claim of [
  "由于统计口径调整，2019 年起不可比",
  "由于四舍五入，合计不等于 100%",
  "由于数据缺失，2020 年部分国家未列入",
  "2023 年出生率为 6.4‰，较 2013 年下降 3.2 个千分点",
  "德国进口量居欧盟第一，占进口总量的三分之一左右",
]) {
  assert.ok(!check(claim).reasons.includes(BLOCK), `must pass: ${claim}`);
}

// English causal phrases added in the same batch.
for (const claim of [
  "Fertility fell due to later marriage",
  "Higher prices led to weaker demand",
  "The policy will result in fewer births",
]) {
  assert.ok(check(claim).reasons.includes(BLOCK), `must block: ${claim}`);
}
for (const claim of [
  "Totals may not add to 100 due to rounding",
  "Figures differ from earlier releases due to data revisions",
  "Some countries are omitted due to missing data",
  "Germany ranks first in EU imports, about one third of the total.",
]) {
  assert.ok(!check(claim).reasons.includes(BLOCK), `must pass: ${claim}`);
}

// Existing words still block.
for (const claim of ["导致出生率下降", "战争冲击了供应", "Output was caused by demand"]) {
  assert.ok(check(claim).reasons.includes(BLOCK), `still blocks: ${claim}`);
}
console.log("zh causal language gate -- PASS");
