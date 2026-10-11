// Shadow check B (numbers in prose) must be invisible:
//
//   switch OFF  : tool definitions, model-visible text, `details` and every
//                 artifact byte equal the baseline 327de35 (before the claim
//                 binding and the shadow code), for charts the binding accepts.
//                 The declared differences in the tool definitions are the
//                 entries of scripts/fixtures/pin_patches/shadow_parity.json
//                 (the page top, the chart forms, zh names and measure_semantics
//                 guidance, each with the commit that made it). Each is asserted
//                 exactly, the list is reversed on a copy of the head, and the
//                 whole definitions must then equal the baseline byte for byte;
//   switch ON   : model-visible text and artifact bytes are still identical,
//                 `details` differs only by `shadow: { path, counts }`, lint
//                 warnings and blockers are unchanged, and the only new files
//                 are side files under shadow/.
//
// The same scripted run (data, query, claim, viz lint x2, viz render,
// infographic lint) is replayed three times against the real tool handlers and
// real DuckDB; the artifacts are compared file by file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadNewsroom, REPO } from "./precision_harness.mjs";
import { loadPinPatches } from "./lib_pin_patch.mjs";
import { withoutRunTraces } from "./lib_run_traces.mjs";

const BASELINE = "327de35";
// This harness stubs the schema builders (every schema is {}), so the lists carry only what is visible here: tool names, descriptions, prompt
// snippets and prompt guidelines. The parameter-level changes are pinned by the tests whose stubs build real schemas.
const pins = loadPinPatches("shadow_parity", { baseline: BASELINE });
// fix/page-top-1003 also puts the lint policy version and the hero gate state into the page lint's record and key, so the page lint ref
// differs from the older commit's. Only that is masked, and only after it is checked: the page lints of the two runs are paired one to
// one by plan_ref (a different count or a repeated plan_ref fails); every older record must lack both added fields and every newer one must
// carry lint_policy_version "2" and hero_value_gate false (this test turns the gate off); then the two fields are deleted and the records
// are compared byte for byte. In the calls' text, only the page lint's own ref is replaced; every other byte is compared.
const PAGE_LINT_PATH = /^infographics\/lints\/[0-9a-f]{64}\.json$/;
const ADDED_LINT_FIELDS = ["lint_policy_version", "hero_value_gate"];
const POLICY_VERSION = "2";
function pageLints(files) {
  const byPlan = new Map();
  for (const [path, bytes] of files) {
    if (!PAGE_LINT_PATH.test(path)) continue;
    const record = JSON.parse(bytes.toString("utf8"));
    assert.equal(typeof record.plan_ref, "string", `page lint ${path} names its plan`);
    assert.equal(byPlan.has(record.plan_ref), false, `two page lints for one plan: ${record.plan_ref}`);
    byPlan.set(record.plan_ref, { path, record });
  }
  return byPlan;
}
/** The run with its page lints normalised to <plan_ref>-named files without the two added fields (checked first), and its calls with only those lint refs replaced. */
function withMaskedLints(run, { added }) {
  const lints = pageLints(run.files);
  const files = new Map([...run.files].filter(([path]) => !PAGE_LINT_PATH.test(path)));
  // The head ends the first footer note with a full stop (c6914ec: one "Note: " per block, every entry ends with one);
  // the baseline's chart SVGs are held to exactly that one change, so any other byte difference still fails. The files that
  // record an SVG's sha256 (render QA reports) follow the SVG.
  let movedHashes = new Map();
  if (!added) {
    const moved = new Map();
    for (const [path, bytes] of files) {
      if (!path.endsWith(".svg")) continue;
      const next = Buffer.from(bytes.toString("utf8").replace(/(>(?:Note: |\u6CE8\uFF1A)[^<]*[^<.\u3002!\uFF01?\uFF1F\s])<\/text>/g, (_m, body) => `${body}${body.startsWith(">Note: ") ? "." : "\u3002"}</text>`), "utf8");
      moved.set(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(next).digest("hex"));
      files.set(path, next);
    }
    movedHashes = moved;
  }
  let text = JSON.stringify(run.calls);
  for (const [planRef, { path, record }] of lints) {
    for (const key of ADDED_LINT_FIELDS) assert.equal(key in record, added, `${added ? "head" : "baseline"} page lint for ${planRef}: ${key} ${added ? "missing" : "present"}`);
    if (added) {
      assert.equal(record.lint_policy_version, POLICY_VERSION, `head page lint for ${planRef}: lint_policy_version`);
      assert.equal(record.hero_value_gate, false, `head page lint for ${planRef}: hero_value_gate (this test turns the gate off)`);
    }
    const bare = { ...record };
    for (const key of ADDED_LINT_FIELDS) delete bare[key];
    files.set(`infographics/lints/<${planRef}>.json`, Buffer.from(JSON.stringify(bare)));
    text = text.split(path).join(`infographics/lints/<${planRef}>.json`);
  }
  for (const [path, bytes] of files) {
    if (path.endsWith(".svg")) continue;
    let t = bytes.toString("utf8"), changed = false;
    for (const [from, to] of movedHashes) if (t.includes(from)) { t = t.split(from).join(to); changed = true; }
    if (changed) files.set(path, Buffer.from(t, "utf8"));
  }
  text = movedHashes.size ? [...movedHashes].reduce((acc, [from, to]) => acc.split(from).join(to), text) : text;
  return { calls: JSON.parse(text), files, plans: [...lints.keys()].sort() };
}
const timeline = JSON.parse(readFileSync(join(REPO, "fixtures", "complex", "timeline.json"), "utf8"));

function walk(dir, root = dir, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.set(relative(root, path), readFileSync(path));
  }
  return out;
}

async function scenario({ baselineRev, shadow }) {
  const h = await loadNewsroom({ prefix: "shadow-parity-", baselineRev, env: { NEWSROOM_SHADOW_CHECKS: shadow ? "1" : undefined, NEWSROOM_MOBILE_PAGES: "1", NEWSROOM_HERO_VALUE_GATE: "0" } });
  try {
    const tools = new Map([...h.tools.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    const defs = JSON.stringify([...tools.values()].map((tool) => ({ ...tool, execute: undefined })));
    const csv = ["date,event", ...timeline.rows.map((row) => `${row.date},${row.event}`)].join("\n") + "\n";
    const fileA = h.addData("A", csv);
    const qa = await h.query(`SELECT date, event FROM read_csv_auto('${fileA}')`);
    const claim = await h.recordClaim("The timeline has 4 dated milestones, 25% in the first phase", [fileA], [qa]);
    const calls = [];
    const call = async (name, params) => {
      const result = await h.tools.get(name).execute("p", params);
      calls.push({ name, text: result.content[0].text, details: JSON.parse(JSON.stringify(result.details ?? null)) });
      return result;
    };
    let n = 0;
    const plan = (patch) => {
      const ref = `visualizations/plans/plan-${++n}.json`;
      writeFileSync(join(h.art, ref), JSON.stringify({ ...timeline.spec, sql: `SELECT date, event FROM read_csv_auto('${fileA}') ORDER BY date`, claim_id: claim.claim_id, title: "Policy milestones: 4 steps, 99% done", subtitle: "Since 2024", note: "Source: policy office, 2024", ...patch }));
      return ref;
    };
    const planA = plan({});
    const planB = plan({ annotations: [{ type: "point", match_field: "event", match_value: timeline.rows[0].event, text: "Announced, 25% in", claim_id: claim.claim_id }] });
    const lintA = await call("newsroom_viz_lint", { plan_ref: planA });
    await call("newsroom_viz_lint", { plan_ref: planB });
    const render = await call("newsroom_viz_render", { plan_ref: planA, lint_ref: lintA.details.lintRef });
    const igRef = "infographics/plans/plan-1.json";
    writeFileSync(join(h.art, igRef), JSON.stringify({
      schema_version: "1.0.0", title: "Four steps", dek: "A minimal fixture: 4 steps, 99 percent.", alt: "A header, a statistic and a chart.",
      modules: [
        { id: "m1", type: "section_header", span: "full", heading: "Overview" },
        { id: "m2", type: "hero_stat", span: "full", value: "25", unit: "%", label: "In the first phase", claim_id: claim.claim_id },
        { id: "m3", type: "visual", span: "full", manifest_ref: render.details.manifestRef },
      ],
    }));
    await call("newsroom_infographic_lint", { plan_ref: igRef });
    // Run traces (the boundary report, the chain event log) are not artifacts; lib_run_traces.mjs says which and checks them.
    const all = walk(h.art);
    const keep = new Set(withoutRunTraces(h.art, [...all.keys()], { chain: true, label: "artifact tree" }));
    const files = new Map([...all].filter(([path]) => keep.has(path)));
    return { defs, tools, calls, files, claimId: claim.claim_id };
  } finally {
    rmSync(h.tmp, { recursive: true, force: true });
  }
}

const base = await scenario({ baselineRev: BASELINE, shadow: false });
const off = await scenario({ shadow: false });
const on = await scenario({ shadow: true });
delete process.env.NEWSROOM_SHADOW_CHECKS;

const withoutShadowDetails = (call) => ({ ...call, details: call.details && typeof call.details === "object" ? Object.fromEntries(Object.entries(call.details).filter(([key]) => key !== "shadow" && key !== "shadow_asof")) : call.details });
const comparable = (files) => new Map([...files].filter(([path]) => path !== "claims.jsonl" && !path.startsWith("shadow/")));

// OFF == baseline, byte for byte.
pins.check(base.tools, off.tools, "switch off");
pins.finish();
assert.equal(off.claimId, base.claimId);
const baseMasked = withMaskedLints({ calls: base.calls, files: comparable(base.files) }, { added: false });
const offMasked = withMaskedLints({ calls: off.calls, files: comparable(off.files) }, { added: true });
assert.ok(baseMasked.plans.length >= 1, "the scenario writes at least one page lint");
assert.deepEqual(offMasked.plans, baseMasked.plans, "the same page lints (paired by plan_ref) in the baseline and the head");
assert.deepEqual(offMasked.calls, baseMasked.calls, "model-visible text and details identical to the baseline with the switch off (only the page lint ref replaced)");
assert.deepEqual([...offMasked.files.keys()], [...baseMasked.files.keys()], "same artifact file set as the baseline");
for (const [path, bytes] of baseMasked.files) assert.ok(bytes.equals(offMasked.files.get(path)), `artifact bytes differ from the baseline: ${path}`);
assert.equal([...off.files.keys()].some((path) => path.startsWith("shadow/")), false, "off: nothing is written under shadow/");
for (const call of off.calls) assert.equal("shadow" in (call.details ?? {}) || "shadow_asof" in (call.details ?? {}), false, "off: details carry no shadow key");

// ON: same model-visible text, same artifacts, details differ only by `shadow`.
assert.equal(on.defs, off.defs, "tool definitions identical with the switch on");
assert.deepEqual(on.calls.map((call) => call.text), off.calls.map((call) => call.text), "model-visible text byte-identical with the switch on");
assert.deepEqual(on.calls.map(withoutShadowDetails), off.calls.map(withoutShadowDetails), "details identical apart from details.shadow");
assert.deepEqual([...comparable(on.files).keys()], [...comparable(off.files).keys()]);
for (const [path, bytes] of comparable(off.files)) assert.ok(bytes.equals(comparable(on.files).get(path)), `artifact bytes differ with the switch on: ${path}`);
for (const call of on.calls.filter((entry) => ["newsroom_viz_lint", "newsroom_infographic_lint"].includes(entry.name))) {
  assert.ok(call.details.shadow?.path?.startsWith("shadow/prose_numbers-"), "on: details.shadow.path");
  assert.deepEqual(Object.keys(call.details.shadow).sort(), ["counts", "path"], "details carry only the side file path and counts");
  assert.ok(on.files.has(call.details.shadow.path), "the side file exists");
}
for (const call of on.calls.filter((entry) => !["newsroom_viz_lint", "newsroom_infographic_lint"].includes(entry.name))) assert.equal("shadow" in (call.details ?? {}), false);
const shadowFiles = [...on.files.keys()].filter((path) => path.startsWith("shadow/"));
assert.equal(shadowFiles.filter((path) => path.startsWith("shadow/prose_numbers-")).length, 3, "one prose-number side file per shadowed lint call");
assert.equal(shadowFiles.filter((path) => path.startsWith("shadow/asof_probe-")).length, 1, "one as-of side file for the infographic lint");
assert.equal(shadowFiles.length, 4);
// Warnings and blockers never carry shadow results.
for (const [index, call] of on.calls.entries()) {
  assert.deepEqual(call.details?.warnings, off.calls[index].details?.warnings);
  assert.deepEqual(call.details?.blockers, off.calls[index].details?.blockers);
}
// The side file holds what the prose says: 99% matches nothing, 25% is derivable.
const record = JSON.parse(on.files.get(on.calls[0].details.shadow.path).toString());
assert.equal(record.kind, "prose_numbers");
assert.equal(typeof record.compute_ms, "number");
assert.ok(record.numbers.some((entry) => entry.raw.startsWith("99") && entry.status === "unmatched"), "99% is not backed by the data");
assert.ok(record.numbers.some((entry) => entry.field === "title" && entry.raw === "4" && entry.status !== "unmatched"), "4 is the row count");
assert.ok(record.numbers.some((entry) => entry.raw === "2024" && entry.status === "skipped" && entry.skipped_reason === "year"));
assert.ok(Array.isArray(record.strict_result_hash), "strict result_hash equality goes to the shadow record only");
console.log("test_shadow_parity.mjs ok");
