// NEWSROOM_REFUSED_OPTIONS_FIX=1 (default off): options the checks always refuse
// under the current settings are no longer offered, and the conditions the checks
// enforce are written into the descriptions the model reads before it calls.
//  - not offered: newsroom_illustration_generate when NEWSROOM_ILLUSTRATION_ADAPTER
//    is unset (it always throws then). The narrow span stays in the shared enum
//    (text and hero_stat modules legitimately use it); its condition is a sentence.
//  - sentences: page-top hero number, hand-typed hero value, span, scene slots,
//    claim kind and causal words in page text. No check changes.
//  1. Off: tool definitions of every profile are byte-identical to the commit before the switch.
//  2. On: the difference is exactly the removal and those sentences (asserted
//     path by path, and printed).
//  3. The causal-word and claim-kind sentences agree with the evidence gate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The commit before the switch was added (7deb682); the hero value gate is already on by default there, as it is now and always.
const BASELINE = "6a6a69a";
const scratch = mkdtempSync(join(tmpdir(), "refused-options-fix-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];
for (const name of ["NEWSROOM_REFUSED_OPTIONS_FIX", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_ILLUSTRATION_ADAPTER"]) delete process.env[name];
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN", "NEWSROOM_HIDE_LIEFLAT"]) delete process.env[name];

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf, opts = {}) => ({ anyOf, ...opts }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
async function loadTree(label, source) {
  const dir = mkdtempSync(join(scratch, `tree-${label}-`));
  cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(source, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return await import(join(pi, "newsroom.test-copy.mjs"));
}
function baselineSource() {
  const dir = mkdtempSync(join(scratch, "baseline-"));
  const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASELINE, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) return null;
  writeFileSync(join(dir, "baseline.tar"), archive.stdout);
  return spawnSync("tar", ["-xf", join(dir, "baseline.tar"), "-C", dir]).status === 0 ? dir : null;
}
// Tools read the environment when they register, so it is set right before.
const CONTROLLED = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_REFUSED_OPTIONS_FIX", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_ILLUSTRATION_ADAPTER"];
function definitions(mod, env) {
  for (const k of CONTROLLED) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return Object.fromEntries([...tools].map(([name, tool]) => [name, JSON.parse(JSON.stringify({ ...tool, execute: undefined }))]));
}
// Every path where two JSON values differ, with both sides.
function diff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => diff(a[key], b[key], `${path}/${key}`));
  }
  return [{ path, before: a, after: b }];
}

const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
const ON = { NEWSROOM_REFUSED_OPTIONS_FIX: "1" };
const T = {
  heroType: ["/type/description", "hero_stat needs a claim the plan tool recorded from a claim template in the same plan call; otherwise open the page with the lead visual."],
  heroValue: ["/value/description", "Leave empty on a hero_stat; the runtime writes it from value_from."],
  span: ["/span/description", "Mobile pages are off: a visual or illustration module must be 'full'; the other spans are for text and hero_stat modules."],
  scenePattern: ["/pattern/description", "Mobile pages are off: an illustration fits only as the anchor or sole sidecar of hero_with_rail; a visual only there, or as the hero_sidecar_stack anchor when it has a compact variant."],
  claimKind: ["/record_claim/parameters/properties/claim_kind/description", "Only descriptive, quantitative, comparative and uncertainty claims with status supported can be verified; causal, mechanistic and predictive kinds and hypothesis or contested status stay draft only."],
  causalWords: ["/newsroom_infographic_plan/description", "Editorial text may not use causal or motive wording (cause, drive, because, war, conflict, labour; 导致, 因为, 驱动, 战争, 冲突, 劳动力) unless a verified claim covers it; state what the data shows."],
};
const current = await loadTree("current", ROOT);

// The expected change set for one setting: [{key, tail, text}] plus whether the tool goes away.
function expectedKinds({ mobile, adapter }) {
  return { span: !mobile, scenePattern: !mobile, heroValue: true, heroType: true, claimKind: true, causalWords: true, removed: !adapter };
}
function classify(before, after, kinds) {
  const seen = new Set();
  let removed = false;
  for (const change of diff(before, after)) {
    if (change.path === "/newsroom_illustration_generate") {
      assert.ok(change.before && change.after === undefined, "the illustration tool is only removed");
      removed = true;
      continue;
    }
    const key = Object.keys(T).find((k) => change.path.endsWith(T[k][0]) && change.after === (change.before === undefined ? T[k][1] : `${change.before} ${T[k][1]}`));
    assert.ok(key, `unexpected change at ${change.path}: ${JSON.stringify(change).slice(0, 300)}`);
    assert.ok(kinds[key], `${key} must not change here (${change.path})`);
    seen.add(key);
  }
  return { seen, removed };
}

const SETTINGS = [];
for (const mobile of [false, true]) for (const adapter of [false, true]) SETTINGS.push({ mobile, adapter });
const envOf = (profile, s, on) => ({ NEWSROOM_TOOL_PROFILE: profile, ...(s.mobile ? { NEWSROOM_MOBILE_PAGES: "1" } : {}), ...(s.adapter ? { NEWSROOM_ILLUSTRATION_ADAPTER: "/bin/true" } : {}), ...(on ? ON : {}) });

// ---- Literal checks (no history needed) -------------------------------------
for (const notOne of ["0", "true", "yes", "", " 1", "01"]) {
  const base = definitions(current, envOf("full", SETTINGS[0], false));
  assert.equal(JSON.stringify(definitions(current, { ...envOf("full", SETTINGS[0], false), NEWSROOM_REFUSED_OPTIONS_FIX: notOne })), JSON.stringify(base), `value ${JSON.stringify(notOne)} is off`);
}
const full = definitions(current, envOf("full", SETTINGS[0], true));
assert.ok(!full.newsroom_illustration_generate, "no adapter: illustration generation is not offered");
assert.ok(definitions(current, { ...envOf("full", { ...SETTINGS[0], adapter: true }, true) }).newsroom_illustration_generate, "adapter set: it is offered");
assert.ok(definitions(current, envOf("full", SETTINGS[0], false)).newsroom_illustration_generate, "off: it is offered");
const span = JSON.stringify(full.newsroom_infographic_plan);
assert.ok(span.includes('"enum":["full","two_thirds","half","third"]'), "the narrow span stays in the enum (text and hero_stat modules use it)");

// ---- 3. The sentences agree with the evidence gate ---------------------------
const gate = await import(join(ROOT, "runtime", "pi", "evidence_gate.mjs"));
const causalList = T.causalWords[1].match(/\(([^)]*)\)/)[1].split(/[;,]\s*/).filter(Boolean);
assert.equal(causalList.length, 12, "twelve example words");
for (const word of causalList) {
  const r = gate.evaluateClaimSupport({ requested_status: "supported", claim_kind: "descriptive", claim: `the series ${word} the change` });
  assert.ok(r.reasons.includes("claim_contains_unbound_causal_or_motive_language"), `'${word}' is refused by the evidence gate`);
}
assert.ok(!gate.evaluateClaimSupport({ requested_status: "supported", claim_kind: "descriptive", claim: "The series rose 4 per cent in 2020." }).reasons.length, "a plain descriptive claim passes");
for (const kind of ["descriptive", "quantitative", "comparative", "uncertainty"]) assert.equal(gate.evaluateClaimSupport({ requested_status: "supported", claim_kind: kind, claim: "x rose" }).passed, true, `${kind} can be verified`);
for (const kind of ["causal", "mechanistic", "predictive"]) assert.equal(gate.evaluateClaimSupport({ requested_status: "supported", claim_kind: kind, claim: "x rose" }).passed, false, `${kind} cannot`);
assert.equal(gate.evaluateClaimSupport({ requested_status: "hypothesis", claim_kind: "descriptive", claim: "x rose" }).passed, false, "hypothesis cannot");
assert.equal(gate.evaluateClaimSupport({ requested_status: "contested", claim_kind: "descriptive", claim: "x rose" }).passed, false, "contested cannot");

// ---- 1 and 2. Against the commit before the switch -----------------------------------------------
const baselineDir = baselineSource();
if (!baselineDir) {
  console.log(`${BASELINE} history unavailable; skipped the byte comparison with it`);
} else {
  const baseline = await loadTree("baseline", baselineDir);
  let compared = 0;
  let maxAdded = 0;
  for (const profile of PROFILES) for (const s of SETTINGS) {
    const before = definitions(baseline, envOf(profile, s, false));
    assert.equal(JSON.stringify(definitions(current, envOf(profile, s, false))), JSON.stringify(before), `${profile} ${JSON.stringify(s)}: off is byte-identical to ${BASELINE}`);
    const after = definitions(current, envOf(profile, s, true));
    const kinds = expectedKinds(s);
    const { seen, removed } = classify(before, after, kinds);
    assert.equal(removed, kinds.removed && Boolean(before.newsroom_illustration_generate), `${profile} ${JSON.stringify(s)}: illustration tool removal`);
    if (before.newsroom_infographic_plan) for (const key of ["span", "scenePattern", "heroValue", "heroType", "causalWords"]) {
      if (kinds[key]) assert.ok(seen.has(key), `${profile} ${JSON.stringify(s)}: ${key} sentence is added`);
    }
    if (before.record_claim) assert.ok(seen.has("claimKind"), `${profile}: claimKind sentence is added`);
    const delta = JSON.stringify(after).length - JSON.stringify(before).length;
    if (s.mobile === false && s.adapter === false) console.log(`${profile}: serialized definitions ${delta >= 0 ? "+" : ""}${delta} bytes${removed ? ` (net: sentences +${delta + JSON.stringify(before.newsroom_illustration_generate).length}, removed tool -${JSON.stringify(before.newsroom_illustration_generate).length})` : ""}; sentences ${[...seen].join(",") || "none"}`);
    maxAdded = Math.max(maxAdded, Buffer.byteLength([...seen].map((k) => T[k][1]).join(" ")));
    compared += 1;
  }
  const textBytes = Object.values(T).reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
  console.log(`sentence text: ${textBytes} bytes in total (written once each; repeated wherever the same field is registered)`);
  console.log(`ok: off is byte-identical to ${BASELINE}; on differs by the removal and the sentences only (${compared} profile/setting combinations)`);
}
console.log("ok: refused options switch");
