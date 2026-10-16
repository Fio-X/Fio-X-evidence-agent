// Proof that shadow/ at the artifact root is invisible to the evidence chain.
//
// One artifact is built with the shadow switch ON (so shadow/ really exists),
// then compared with an exact copy that has shadow/ removed:
//   - the evidence snapshot, and with it every computation path, is unchanged
//     (a new query lands on the same content-addressed path in both);
//   - `news verify`, `news verify --recompute`, and scripts/verify_artifact.py
//     (default and --recompute) print and write identical reports;
//   - no report mentions shadow/.
// The Rust and Python file enumerations read named subdirectories only (static
// evidence in the report); this test is the dynamic evidence.
//
// Needs the debug binary (target/debug/news, built by `cargo build`/`cargo
// test`); without it only the Python and snapshot proofs run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNewsroom, REPO } from "./precision_harness.mjs";

// Both writers stamp the wall clock into verification.json (verify_artifact.py: isoformat with Z, microseconds when non-zero; verify.rs: whole seconds with Z),
// so two runs that straddle a second boundary differ in that one value. Everything else is compared exactly: the same key set, and the raw texts byte for byte once that one value is swapped for a fixed token;
// verified_at must be in a writer's exact UTC format in both reports (Python may print no fraction when the microseconds are 0, so the two are not required to match each other) and at most VERIFIED_AT_SLACK_MS apart.
const VERIFIED_AT_SLACK_MS = 5000;
const STAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?Z$/; // Python isoformat + Z, or Rust whole seconds + Z
const STAMP_TOKEN = "<verified_at>";
// The one value that is allowed to differ is swapped for the same token in each raw text; everything else, key order and whitespace included, is compared byte for byte.
const withStampToken = (text, stamp) => {
  const pattern = new RegExp(`("verified_at"\\s*:\\s*)${JSON.stringify(stamp).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  assert.match(text, pattern, "the raw text carries the verified_at value it parsed to");
  return text.replace(pattern, (_all, key) => `${key}${JSON.stringify(STAMP_TOKEN)}`);
};
function assertReportsMatch(textA, textB) {
  if (textA === null && textB === null) return; // the last command wrote no report in either copy (same as before)
  assert.ok(textA !== null && textB !== null, "verification.json exists in both copies or in neither");
  const a = JSON.parse(textA), b = JSON.parse(textB);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), "verification.json: same key set");
  assert.ok("verified_at" in a, "verification.json has verified_at");
  for (const stamp of [a.verified_at, b.verified_at]) assert.ok(typeof stamp === "string" && STAMP_FORMAT.test(stamp), `verified_at is an exact UTC stamp: ${stamp}`);
  assert.ok(Math.abs(Date.parse(a.verified_at) - Date.parse(b.verified_at)) <= VERIFIED_AT_SLACK_MS, "verified_at values are within the slack");
  assert.equal(withStampToken(textA, a.verified_at), withStampToken(textB, b.verified_at), "verification.json identical apart from the verified_at value");
}
{
  const base = { schema_version: "0.7.0", verified_at: "2026-10-14T10:00:06.123456Z", passed: true, checks: [{ name: "x", ok: true }], recomputed: false };
  const text = (o) => JSON.stringify(o, null, 2) + "\n";
  const green = (o) => assertReportsMatch(text(base), text(o));
  const red = (label, o, message) => assert.throws(() => assertReportsMatch(text(base), typeof o === "string" ? o : text(o)), message, `comparison mutant must be red: ${label}`);
  green({ ...base });
  green({ ...base, verified_at: "2026-10-14T10:00:07.000001Z" }); // a second boundary
  green({ ...base, verified_at: "2026-10-14T10:00:11.123456Z" }); // 5 s
  assertReportsMatch(text({ ...base, verified_at: "2026-10-14T10:00:06Z" }), text({ ...base, verified_at: "2026-10-14T10:00:07Z" })); // the Rust format
  red("another field changed", { ...base, passed: false }, /identical apart from the verified_at value/);
  red("a nested field changed", { ...base, checks: [{ name: "x", ok: false }] }, /identical apart from the verified_at value/);
  red("an extra key", { ...base, extra: 1 }, /same key set/);
  const { verified_at: _drop, ...without } = base;
  red("verified_at dropped", without, /same key set/);
  red("malformed timestamp", { ...base, verified_at: "2026-10-14 10:00:06" }, /exact UTC stamp/);
  red("timestamp without Z", { ...base, verified_at: "2026-10-14T10:00:06.123456+00:00" }, /exact UTC stamp/);
  red("not a string", { ...base, verified_at: 1760436006 }, /exact UTC stamp/);
  red("more than 5 s apart", { ...base, verified_at: "2026-10-14T10:00:12.000000Z" }, /within the slack/);
  // the raw text is still compared: key order, whitespace and a trailing newline are not forgiven
  red("keys in another order", JSON.stringify({ verified_at: base.verified_at, schema_version: base.schema_version, passed: true, checks: base.checks, recomputed: false }, null, 2) + "\n", /identical apart from the verified_at value/);
  red("other whitespace", JSON.stringify(base), /identical apart from the verified_at value/);
  red("no trailing newline", text(base).trimEnd(), /identical apart from the verified_at value/);
  assert.throws(() => assertReportsMatch(text(base), null), /exists in both copies or in neither/, "a report missing in one copy is red");
  assertReportsMatch(null, null);
}

const timeline = JSON.parse(readFileSync(join(REPO, "fixtures", "complex", "timeline.json"), "utf8"));
const h = await loadNewsroom({ prefix: "shadow-side-file-", env: { NEWSROOM_SHADOW_CHECKS: "1" } });
const work = mkdtempSync(join(tmpdir(), "shadow-side-copies-"));
try {
  const csv = ["date,event", ...timeline.rows.map((row) => `${row.date},${row.event}`)].join("\n") + "\n";
  const fileA = h.addData("A", csv);
  const qa = await h.query(`SELECT date, event FROM read_csv_auto('${fileA}')`);
  const claim = await h.recordClaim("The timeline has 4 dated milestones", [fileA], [qa]);
  const planRef = "visualizations/plans/plan.json";
  writeFileSync(join(h.art, planRef), JSON.stringify({ ...timeline.spec, sql: `SELECT date, event FROM read_csv_auto('${fileA}') ORDER BY date`, claim_id: claim.claim_id, title: "Four milestones, 99% complete" }));
  const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
  const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lint.details.lintRef });
  await h.tools.get("newsroom_viz_critic").execute("c", { plan_ref: planRef, lint_ref: lint.details.lintRef, manifest_ref: render.details.manifestRef });
  writeFileSync(join(h.art, "run-metrics.jsonl"), "");
  writeFileSync(join(h.art, "story.json"), JSON.stringify({
    schema_version: "0.8.0", id: "t", kind: "investigation", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    topic: "t", status: "draft", runtime: {}, files: { run_metrics: "run-metrics.jsonl" }, evidence: { searches: [], sources: [], datasets: [] }, delivery: null,
  }));
  assert.ok(readdirSync(join(h.art, "shadow")).length >= 1, "the switch is on, so shadow/ exists");

  const withShadow = join(work, "with");
  const without = join(work, "without");
  cpSync(h.art, withShadow, { recursive: true });
  cpSync(h.art, without, { recursive: true });
  rmSync(join(without, "shadow"), { recursive: true, force: true });
  assert.equal(existsSync(join(without, "shadow")), false);

  // Evidence snapshot: a fresh query reads the same snapshot hash and writes the same path.
  const fresh = async (dir) => {
    process.env.NEWSROOM_ARTIFACT_DIR = dir;
    const result = await h.tools.get("duckdb_query").execute("q", { sql: `SELECT count(*) AS n FROM read_csv_auto('${fileA}')` });
    const path = result.details.path.slice(dir.length + 1);
    return { path, record: JSON.parse(readFileSync(result.details.path, "utf8")) };
  };
  const a = await fresh(withShadow);
  const b = await fresh(without);
  assert.equal(a.path, b.path, "computation path unchanged by shadow/");
  assert.equal(a.record.input_snapshot_hash, b.record.input_snapshot_hash, "evidence snapshot unchanged by shadow/");
  assert.deepEqual(a.record.input_fingerprints, b.record.input_fingerprints);
  process.env.NEWSROOM_ARTIFACT_DIR = h.art;

  const normalize = (text, dir) => text.split(dir).join("<ART>");
  const run = (cmd, args, dir) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: join(work, "nohome") } });
    return { status: result.status, out: normalize(`${result.stdout}\n${result.stderr}`, dir) };
  };
  const readReport = (dir) => (existsSync(join(dir, "verification.json")) ? normalize(readFileSync(join(dir, "verification.json"), "utf8"), dir) : null);
  const binary = join(REPO, "target", "debug", "news");
  const pairs = [["python", ["python3", join(REPO, "scripts", "verify_artifact.py")], []], ["python --recompute", ["python3", join(REPO, "scripts", "verify_artifact.py")], ["--recompute"]], ["python --json", ["python3", join(REPO, "scripts", "verify_artifact.py")], ["--json"]]];
  if (existsSync(binary)) pairs.push(["news verify", [binary, "verify"], []], ["news verify --recompute", [binary, "verify"], ["--recompute"]]);
  else console.log("target/debug/news not built: the Rust verify proofs are skipped");
  for (const [label, [cmd, ...base], extra] of pairs) {
    const x = run(cmd, [...base, ...extra, withShadow].filter((arg) => arg !== undefined), withShadow);
    const y = run(cmd, [...base, ...extra, without].filter((arg) => arg !== undefined), without);
    assert.equal(x.status, y.status, `${label}: exit status`);
    assert.equal(x.out, y.out, `${label}: output identical with and without shadow/`);
    assert.equal(/shadow/i.test(x.out), false, `${label}: never mentions shadow/`);
    assert.match(x.out, /artifact integrity|"checks"|checks:/, `${label}: produced a real report`);
    const failures = x.out.split("\n").filter((line) => /^FAIL /.test(line));
    assert.ok(failures.every((line) => /run.metrics/i.test(line)), `${label}: the only failures are the (empty) run-metrics checks, got: ${failures.join(" | ")}`);
    console.log(`  ${label}: exit ${x.status}, ${x.out.split("\n").filter((line) => /integrity|PASS|FAIL/.test(line)).slice(0, 2).join(" / ")}`);
  }
  assertReportsMatch(readReport(withShadow), readReport(without));
  console.log("test_shadow_side_file.mjs ok");
} finally {
  rmSync(h.tmp, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
