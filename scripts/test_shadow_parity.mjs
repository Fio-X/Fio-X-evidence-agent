// Shadow check B (numbers in prose) must be invisible:
//
//   switch OFF  : tool definitions, model-visible text, `details` and every
//                 artifact byte equal the baseline 327de35 (before the claim
//                 binding and the shadow code), for charts the binding accepts;
//   switch ON   : model-visible text and artifact bytes are still identical,
//                 `details` differs only by `shadow: { path, counts }`, lint
//                 warnings and blockers are unchanged, and the only new files
//                 are side files under shadow/.
//
// The same scripted run (data, query, claim, viz lint x2, viz render,
// infographic lint) is replayed three times against the real tool handlers and
// real DuckDB; the artifacts are compared file by file.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadNewsroom, REPO } from "./precision_harness.mjs";

const BASELINE = "327de35";
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
  const h = await loadNewsroom({ prefix: "shadow-parity-", baselineRev, env: { NEWSROOM_SHADOW_CHECKS: shadow ? "1" : undefined, NEWSROOM_MOBILE_PAGES: "1" } });
  try {
    const defs = JSON.stringify([...h.tools.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, tool]) => ({ ...tool, execute: undefined })));
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
    const files = walk(h.art);
    return { defs, calls, files, claimId: claim.claim_id };
  } finally {
    rmSync(h.tmp, { recursive: true, force: true });
  }
}

const base = await scenario({ baselineRev: BASELINE, shadow: false });
const off = await scenario({ shadow: false });
const on = await scenario({ shadow: true });
delete process.env.NEWSROOM_SHADOW_CHECKS;

const withoutShadowDetails = (call) => ({ ...call, details: call.details && typeof call.details === "object" ? Object.fromEntries(Object.entries(call.details).filter(([key]) => key !== "shadow")) : call.details });
const comparable = (files) => new Map([...files].filter(([path]) => path !== "claims.jsonl" && !path.startsWith("shadow/")));

// OFF == baseline, byte for byte.
assert.equal(off.defs, base.defs, "tool definitions identical to the baseline with the switch off");
assert.equal(off.claimId, base.claimId);
assert.deepEqual(off.calls, base.calls, "model-visible text and details identical to the baseline with the switch off");
assert.deepEqual([...comparable(off.files).keys()], [...comparable(base.files).keys()], "same artifact file set as the baseline");
for (const [path, bytes] of comparable(base.files)) assert.ok(bytes.equals(comparable(off.files).get(path)), `artifact bytes differ from the baseline: ${path}`);
assert.equal([...off.files.keys()].some((path) => path.startsWith("shadow/")), false, "off: nothing is written under shadow/");
for (const call of off.calls) assert.equal("shadow" in (call.details ?? {}), false, "off: details carry no shadow key");

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
assert.equal(shadowFiles.length, 3, "one side file per shadowed lint call");
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
