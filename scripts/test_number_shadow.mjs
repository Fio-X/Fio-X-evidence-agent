// Pure rules of shadow check B (runtime/pi/number_shadow.mjs) and the side-file
// writer (runtime/pi/shadow.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCandidates, checkField, extractNumbers, summarizeChecks } from "../runtime/pi/number_shadow.mjs";
import { loadNewsroom, REPO } from "./precision_harness.mjs";
import { runInTool } from "../runtime/pi/groups.mjs";
import { runShadow, shadowChecksEnabled, shadowKey, writeShadowRecord } from "../runtime/pi/shadow.mjs";

const skipped = (text) => Object.fromEntries(extractNumbers(text).filter((entry) => entry.skipped).map((entry) => [entry.raw, entry.skipped]));
const kept = (text) => extractNumbers(text).filter((entry) => !entry.skipped).map((entry) => entry.raw);

// What is not a claim about the data.
assert.equal(skipped("In 2019 and 1999 it rose")["2019"], "year");
assert.equal(skipped("From 2010-2020 it rose")["2010-2020"], "year_range");
assert.equal(skipped("Signed on 2024-03-01")["2024-03-01"], "date");
assert.equal(skipped("the 3rd round and 21st century")["3"], "ordinal");
assert.equal(skipped("as shown in [12] and (3)")["12"], "citation");
assert.equal(skipped("G20 members")["20"], "name_or_code");
assert.equal(skipped("5G networks")["5"], "name_or_code");
assert.equal(skipped("COVID-19 cases")["19"], "name_or_code");
assert.equal(skipped("see Article 5 and Chapter 7")["5"], "name_or_code");
assert.equal(skipped("第3章")["3"], "ordinal");
assert.deepEqual(kept("grew 12.3% to 4.5 million, 1,234 people, 5亿"), ["12.3", "4.5", "1,234", "5"]);
assert.equal(kept("a 2020 figure").length, 0);
assert.deepEqual(kept("a 2020% jump"), ["2020"], "a percent is never a year");

// Display precision.
const c = buildCandidates([[{ k: "a", v: 11.23 }, { k: "b", v: 20 }]], [30]);
const status = (text) => checkField("f", text, c).map((entry) => entry.status);
assert.deepEqual(status("11.2"), ["matched_rows"], "11.23 displays as 11.2");
assert.deepEqual(status("11.23"), ["matched_rows"]);
assert.deepEqual(status("11"), ["matched_rows"], "and as 11");
assert.deepEqual(status("11.3"), ["unmatched"], "11.3 is not 11.23 at one decimal");
assert.deepEqual(status("11.5"), ["unmatched"]);
assert.deepEqual(status("31.2"), ["matched_derived"], "the sum 31.23, shown at one decimal");
assert.deepEqual(status("30"), ["matched_spec"], "a number the spec itself declares (reference line)");
assert.deepEqual(status("99"), ["unmatched"]);
// Scales and percent.
const big = buildCandidates([[{ v: 4_500_000 }, { v: 5_500_000 }]]);
assert.deepEqual(checkField("f", "4.5 million, 5.5m, 10 million", big).map((entry) => entry.status), ["matched_rows", "matched_rows", "matched_derived"]);
assert.deepEqual(checkField("f", "55%", big).map((entry) => entry.status), ["matched_derived"], "a share of the total, times 100");
assert.deepEqual(checkField("f", "77%", big).map((entry) => entry.status), ["unmatched"]);
// No rows at all: nothing to compare, not a false accusation.
assert.deepEqual(checkField("f", "42", buildCandidates([])).map((entry) => entry.status), ["no_candidates"]);
assert.equal(summarizeChecks(checkField("f", "In 2020, 11.2 and 99", c)).unmatched, 1);
// The derived set is bounded.
const large = buildCandidates([Array.from({ length: 5000 }, (_, i) => ({ a: i, b: i * 2 }))]);
assert.ok(large.derived.length <= 20000);

// Shadow plumbing.
assert.equal(shadowChecksEnabled({}), false, "off by default");
assert.equal(shadowChecksEnabled({ NEWSROOM_SHADOW_CHECKS: "0" }), false);
assert.equal(shadowChecksEnabled({ NEWSROOM_SHADOW_CHECKS: "true" }), false, "only the exact value 1 turns it on");
assert.equal(shadowChecksEnabled({ NEWSROOM_SHADOW_CHECKS: "1" }), true);
assert.equal(shadowKey({ b: 1, a: [1, { y: 2, x: 3 }] }), shadowKey({ a: [1, { x: 3, y: 2 }], b: 1 }), "key ignores object key order");
assert.notEqual(shadowKey({ a: 1 }), shadowKey({ a: 2 }));
assert.equal(await runShadow(async () => { throw new Error("boom"); }), null, "a failing shadow never throws into the tool");
const root = mkdtempSync(join(tmpdir(), "shadow-writer-"));
try {
  const first = await runInTool("newsroom_infographic_lint", () => writeShadowRecord(root, "prose_numbers", { plan_ref: "p" }, { compute_ms: 1 }));
  const bytes = readFileSync(join(root, first), "utf8");
  const second = await runInTool("newsroom_infographic_lint", () => writeShadowRecord(root, "prose_numbers", { plan_ref: "p" }, { compute_ms: 999 }));
  assert.equal(second, first, "same inputs, same file");
  assert.equal(readFileSync(join(root, second), "utf8"), bytes, "never rewritten (no collision, no churn)");
  const other = await runInTool("newsroom_infographic_lint", () => writeShadowRecord(root, "prose_numbers", { plan_ref: "q" }, {}));
  assert.notEqual(other, first);
  assert.deepEqual(readdirSync(root), ["shadow"]);
  assert.match(first, /^shadow\/prose_numbers-[0-9a-f]{64}\.json$/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Column names that state their unit: "63亿" for 63.2 bn is a unit slip and
// must stay unmatched, "632亿" and "63.2 billion" must match.
const unitRows = buildCandidates([[{ country: "SG", fdi_2017_bn_usd: 63.2 }, { country: "KZ", fdi_2017_bn_usd: 20.7 }]]);
const statusOf = (text) => checkField("takeaway", text, unitRows).map((entry) => entry.status);
assert.deepEqual(statusOf("新加坡约63亿美元"), ["unmatched"], "the unit slip is caught");
assert.deepEqual(statusOf("新加坡约632亿美元"), ["matched_rows"], "the right amount in the stated unit matches");
assert.deepEqual(statusOf("Singapore took 63.2 billion dollars"), ["matched_rows"]);
assert.deepEqual(statusOf("Singapore took 63.2"), ["matched_rows"]);
// Records carry no surrounding text, only a position.
for (const record of checkField("f", "see /Users/sentinel-home/x.csv sk-SENTINEL123456 for 7 items and 99%", unitRows)) {
  assert.deepEqual(Object.keys(record).filter((key) => !["field", "raw", "offset", "status", "skipped_reason"].includes(key)), [], "no context copied into a record");
}

// Real viz lint with the switch on: takeaway and alt are checked, and the side
// file carries neither the prose around a number nor a path or token-like
// string (artificial sentinels; no real secret is read).
{
  const { readFileSync: read } = await import("node:fs");
  const h = await loadNewsroom({ prefix: "number-shadow-", env: { NEWSROOM_SHADOW_CHECKS: "1" } });
  try {
    const timeline = JSON.parse(read(join(REPO, "fixtures", "complex", "timeline.json"), "utf8"));
    const file = h.addData("A", ["date,event", ...timeline.rows.map((row) => `${row.date},${row.event}`)].join("\n") + "\n");
    const q = await h.query(`SELECT date, event FROM read_csv_auto('${file}')`);
    const claim = await h.recordClaim("The timeline has dated milestones", [file], [q]);
    const planRef = "visualizations/plans/p.json";
    writeFileSync(join(h.art, planRef), JSON.stringify({
      ...timeline.spec, claim_id: claim.claim_id, sql: `SELECT date, event FROM read_csv_auto('${file}') ORDER BY date`,
      takeaway: "Singapore took about 63亿美元 of it.",
      alt: "A timeline of four milestones, the last on a ladder of 9 steps.",
      source_note: "Data: /Users/sentinel-home/secret-project/raw.csv, key sk-SENTINEL1234567890abcdef, bearer SENTINELTOKEN-XYZ, covering 7 itemsandmore.",
    }));
    const result = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
    const sidePath = join(h.art, result.details.shadow.path);
    const raw = read(sidePath, "utf8");
    const record = JSON.parse(raw);
    const byField = (name) => record.numbers.filter((entry) => entry.field === name);
    assert.equal(byField("takeaway").find((entry) => entry.raw.startsWith("63"))?.status, "unmatched", "takeaway is checked");
    assert.ok(byField("alt").some((entry) => entry.raw === "9"), "alt is checked");
    assert.ok(byField("source_note").some((entry) => entry.raw === "7"), "source_note numbers are still checked");
    for (const forbidden of ["sentinel-home", "secret-project", "raw.csv", "SENTINEL", "sk-", "bearer", "itemsandmore", "Singapore", "ladder", "milestones", "/Users/"]) {
      assert.equal(raw.includes(forbidden), false, `the side file must not contain '${forbidden}'`);
    }
    assert.equal(JSON.stringify(result.details).includes("SENTINEL"), false);
    assert.equal(result.content[0].text.includes("SENTINEL"), false, "nothing new reaches the model text (the plan text is not echoed either way)");
  } finally {
    rmSync(h.tmp, { recursive: true, force: true });
  }
}
console.log("test_number_shadow.mjs ok");
