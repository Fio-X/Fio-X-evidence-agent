// Record-only detectors: each fires on its own fixture with its switch on, writes
// nothing with it off, and changes no verifier output either way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  RECORD_SWITCHES, caveatFindings, criticVisionRecord, droppedModuleFindings, extremeWordFindings, recordCriticVision,
  recordPageLint, recordVizLint, sampledQueryFindings, seriesSpanFindings, statusFilteredSetFindings,
} from "../runtime/pi/record_only.mjs";

const REPO = join(fileURLToPath(import.meta.url), "..", "..");
const ON = Object.fromEntries(Object.values(RECORD_SWITCHES).map((name) => [name, "1"]));
const claim = (id, extra = {}) => ({ claim_id: id, status: "verified", verification: { authority: "system" }, claim: "x", ...extra });
const claims = (...list) => new Map(list.map((record) => [record.claim_id, record]));

// ---- A7: extreme words -------------------------------------------------------
{
  const unbound = extremeWordFindings({ surfaces: [{ where: "subtitle", text: "2023年为历史最高", claim_ids: ["c1"] }], claims: claims(claim("c1")) });
  assert.equal(unbound.length, 1); assert.equal(unbound[0].would_refuse, true);
  const bound = extremeWordFindings({ surfaces: [{ where: "subtitle", text: "2023年为历史最高", claim_ids: ["c1"] }], claims: claims(claim("c1", { claim_template: "{max.year} 最高" })) });
  assert.equal(bound[0].would_refuse, false);
  assert.equal(extremeWordFindings({ surfaces: [{ where: "n", text: "at least 3 and the most recent year", claim_ids: [] }], claims: claims() }).length, 0);
}
// ---- A8: caveats -------------------------------------------------------------
{
  const record = claim("c1", { caveat: "数据为估算值，不含未登记人口" });
  const missing = caveatFindings({ cited: [{ where: "chart", claim_ids: ["c1"] }], pageTexts: ["标题"], claims: claims(record), history: [record] });
  assert.equal(missing.missing.length, 1);
  const printed = caveatFindings({ cited: [{ where: "chart", claim_ids: ["c1"] }], pageTexts: ["注：数据为估算值，不含未登记人口。"], claims: claims(record), history: [record] });
  assert.equal(printed.missing.length, 0);
  const over = caveatFindings({ cited: [], pageTexts: [], claims: claims(), history: [record, claim("c1")] });
  assert.equal(over.overwritten.length, 1); assert.equal(over.overwritten[0].dropped, true);
}
// ---- Q1: status-filtered subject set ----------------------------------------
{
  const set = { key_field: "country", cutoff_date: "2010-01-01" };
  assert.equal(statusFilteredSetFindings({ subjectSet: set, sql: "SELECT country FROM t WHERE status = 'member'" }).length, 1);
  assert.equal(statusFilteredSetFindings({ subjectSet: set, sql: "SELECT country FROM t WHERE join_year <= 2010 AND status = 'member'" }).length, 0);
  assert.equal(statusFilteredSetFindings({ subjectSet: { key_field: "country" }, sql: "SELECT country FROM t WHERE status = 'member'" }).length, 0);
}
// ---- K109 (a), (b), (c) ------------------------------------------------------
{
  const source = []; for (let y = 1990; y <= 2020; y += 1) source.push({ year: String(y), v: String(y - 1900) });
  const sampled = source.filter((row) => Number(row.year) % 5 === 0);
  assert.equal(sampledQueryFindings({ ref: "c", rows: sampled, sourceRows: source }).length, 1);
  assert.equal(sampledQueryFindings({ ref: "c", rows: source, sourceRows: source }).length, 0);
  const cut = source.filter((row) => Number(row.year) < 2020);
  const miss = seriesSpanFindings({ ref: "c", spec: { title: "1990-2020" }, rows: cut, sourceRows: source, valueField: "v" });
  assert.deepEqual(miss.map((m) => m.missing).sort(), ["latest_period", "max"]);
  const earlier = { modules: [{ type: "visual", id: "a", manifest_ref: "m1" }, { type: "text", id: "t" }] };
  const later = { modules: [{ type: "text", id: "t" }] };
  assert.equal(droppedModuleFindings({ earlier, later, earlierRef: "e", laterRef: "l" }).length, 1);
}
// ---- K124 --------------------------------------------------------------------
{
  assert.equal(criticVisionRecord({ stage: "review", requestedModel: "m", model: { id: "m", input: ["text"] }, imagesReturned: true, reviewSubmitted: true }).would_refuse, true);
  const fine = criticVisionRecord({ stage: "review", requestedModel: "m", model: { id: "m", input: ["text", "image"] }, imagesReturned: true, reviewSubmitted: true });
  assert.equal(fine.would_refuse, false); assert.equal(fine.image_reached_model, true);
  assert.equal(criticVisionRecord({ stage: "review", model: undefined }).declares_image_input, null);
}

// ---- Off writes nothing, on writes only under shadow/ -----------------------
const work = mkdtempSync(join(tmpdir(), "record-only-"));
try {
  const root = join(work, "run");
  mkdirSync(join(root, "computations"), { recursive: true });
  writeFileSync(join(root, "claims.jsonl"), `${JSON.stringify(claim("c1", { caveat: "估算值，不含未登记人口", computation_refs: [] }))}\n`);
  const spec = { claim_id: "c1", title: "历史最高", subtitle: "", note: "" };
  const page = { modules: [{ type: "visual", id: "v", claim_id: "c1", manifest_ref: "visualizations/none.json" }, { type: "text", id: "t", claim_ids: ["c1"], body: "无" }], title: "页面" };
  await recordVizLint({ root, spec, planRef: "visualizations/plans/p.json", rows: [] }, {});
  await recordPageLint({ root, spec: page, planRef: "infographics/plans/p.json" }, {});
  await recordCriticVision({ root, stage: "preview", ref: "x", model: { input: ["text"] }, imagesReturned: true }, {});
  assert.equal(existsSync(join(root, "shadow")), false, "switches off: nothing is written");
  await recordVizLint({ root, spec, planRef: "visualizations/plans/p.json", rows: [] }, ON);
  await recordCriticVision({ root, stage: "preview", ref: "x", model: { input: ["text"] }, imagesReturned: true }, ON);
  const names = readdirSync(join(root, "shadow")).sort();
  assert.ok(names.some((n) => n.startsWith("record_extreme_words-")) && names.some((n) => n.startsWith("record_caveats-")) && names.some((n) => n.startsWith("record_critic_vision-")), names.join(","));
  const words = JSON.parse(readFileSync(join(root, "shadow", names.find((n) => n.startsWith("record_extreme_words-"))), "utf8"));
  assert.equal(words.counts.would_refuse, 1);
  // One switch only turns on its own detector.
  const only = join(work, "run2"); mkdirSync(only, { recursive: true });
  writeFileSync(join(only, "claims.jsonl"), "");
  await recordVizLint({ root: only, spec, planRef: "p", rows: [] }, { NEWSROOM_RECORD_EXTREME_WORDS: "1", NEWSROOM_RECORD_CAVEATS: "true" });
  assert.deepEqual(readdirSync(join(only, "shadow")).map((n) => n.split("-")[0]), ["record_extreme_words"]);

  // Every switch alone writes exactly its own kind from the four entry points, and only the exact value `1` counts.
  const kindsFor = async (env, tag) => {
    const dir = join(work, `alone-${tag}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claims.jsonl"), "");
    await recordVizLint({ root: dir, spec, planRef: "p", rows: [{ a: 1 }] }, env);
    await recordPageLint({ root: dir, spec: page, planRef: "q" }, env);
    await recordCriticVision({ root: dir, stage: "preview", ref: "x", model: { input: ["text"] }, imagesReturned: true }, env);
    return existsSync(join(dir, "shadow")) ? [...new Set(readdirSync(join(dir, "shadow")).map((n) => n.split("-")[0]))].sort() : [];
  };
  for (const [kind, name] of Object.entries(RECORD_SWITCHES)) {
    const verifierOnly = kind === "thin_result" || kind === "origin_hash"; // written by the two verifiers, not by the runtime
    assert.deepEqual(await kindsFor({ [name]: "1" }, kind), verifierOnly ? [] : [`record_${kind}`], `${name} alone writes only its own kind`);
    for (const value of ["true", "0", "", "yes", " 1"]) assert.deepEqual(await kindsFor({ [name]: value }, `${kind}-${value.trim() || "empty"}-${value.length}`), [], `${name}=${JSON.stringify(value)} writes nothing`);
  }

  // Each entry point on its own: a switch that belongs to an entry point's list writes from it, and no other switch does. A kind
  // missing from one list would otherwise hide behind the other entry point writing it.
  const perEntry = async (call, env, tag) => {
    const dir = join(work, `entry-${tag}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claims.jsonl"), "");
    await call(dir, env);
    return existsSync(join(dir, "shadow")) ? [...new Set(readdirSync(join(dir, "shadow")).map((n) => n.split("-")[0]))].sort() : [];
  };
  const vizOnly = (dir, env) => recordVizLint({ root: dir, spec, planRef: "p", rows: [{ a: 1 }] }, env);
  const pageOnly = (dir, env) => recordPageLint({ root: dir, spec: page, planRef: "q" }, env);
  const VIZ_KINDS = ["extreme_words", "caveats", "dropped_content"], PAGE_KINDS = ["extreme_words", "caveats", "numbers", "asof_lists", "dropped_content"];
  for (const [kind, name] of Object.entries(RECORD_SWITCHES)) {
    assert.deepEqual(await perEntry(vizOnly, { [name]: "1" }, `viz-${kind}`), VIZ_KINDS.includes(kind) ? [`record_${kind}`] : [], `chart entry, ${name} alone`);
    assert.deepEqual(await perEntry(pageOnly, { [name]: "1" }, `page-${kind}`), PAGE_KINDS.includes(kind) ? [`record_${kind}`] : [], `page entry, ${name} alone`);
  }
  // A chart whose rows are a sample of a computation's source rows: the dropped-content record counts the sampled query.
  {
    const dir = join(work, "dropped-chart"); mkdirSync(join(dir, "computations"), { recursive: true }); mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "claims.jsonl"), "");
    const sourceRows = []; for (let y = 1990; y <= 2020; y += 1) sourceRows.push({ year: String(y), v: String(y - 1900) });
    writeFileSync(join(dir, "data", "s.csv"), `year,v\n${sourceRows.map((r) => `${r.year},${r.v}`).join("\n")}\n`);
    writeFileSync(join(dir, "computations", "c.json"), JSON.stringify({ read_inputs: [{ path: "data/s.csv" }] }));
    const sampled = sourceRows.filter((r) => Number(r.year) % 5 === 0);
    await recordVizLint({ root: dir, spec: { title: "1990-2020", value_field: "v" }, planRef: "p", rows: sampled, computationRef: "computations/c.json" }, { NEWSROOM_RECORD_DROPPED_CONTENT: "1" });
    const file = readdirSync(join(dir, "shadow")).find((n) => n.startsWith("record_dropped_content-"));
    assert.ok(file, "the chart entry writes a dropped-content record");
    const record = JSON.parse(readFileSync(join(dir, "shadow", file), "utf8"));
    assert.ok(JSON.stringify(record).includes("sampled"), "the record names the sampled query");
  }
  // Off never reads claims.jsonl: count the reads (a read that fails is still a read).
  {
    const fsp = createRequire(import.meta.url)("node:fs/promises"); const realRead = fsp.readFile; let claimReads = 0;
    fsp.readFile = (path, ...rest) => { if (String(path).endsWith("claims.jsonl")) claimReads += 1; return realRead(path, ...rest); }; syncBuiltinESMExports();
    try {
      const dir = join(work, "no-read"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "claims.jsonl"), "");
      for (const env of [{}, { NEWSROOM_RECORD_THIN_RESULT: "1" }, { NEWSROOM_RECORD_CRITIC_VISION: "1", NEWSROOM_RECORD_ORIGIN_HASH: "1" }]) { await vizOnly(dir, env); await pageOnly(dir, env); }
      assert.equal(claimReads, 0, "no claims read unless a switch that needs the claims is on");
      await vizOnly(dir, { NEWSROOM_RECORD_CAVEATS: "1" });
      assert.equal(claimReads, 1, "the counter sees a real read");
    } finally { fsp.readFile = realRead; syncBuiltinESMExports(); }
  }

  // ---- K106 / K176 in both verifiers -----------------------------------------
  const art = join(work, "art");
  mkdirSync(join(art, "data", "origins"), { recursive: true });
  writeFileSync(join(art, "story.json"), JSON.stringify({ kind: "investigation", schema_version: "0.6.0", files: {}, evidence: {} }));
  const payload = "a,b\n1,2\n"; writeFileSync(join(art, "data", "x.csv"), payload);
  writeFileSync(join(art, "data", "x.csv.meta.json"), JSON.stringify({ file: "data/x.csv", sha256: "0".repeat(64) }));
  writeFileSync(join(art, "data", "origins", `${"b".repeat(64)}.json`), JSON.stringify({ schema_version: "0.7.0", file: "data/x.csv", sha256: "0".repeat(64) }, null, 2));
  const pythonVerifier = join(REPO, "scripts", "verify_artifact.py");
  const binary = process.env.NEWS_BIN ?? join(REPO, "target", "debug", "news");
  const run = (kind, extra) => kind === "python"
    ? spawnSync("python3", [pythonVerifier, art], { encoding: "utf8", env: { PATH: process.env.PATH, ...extra } })
    : spawnSync(binary, ["verify", art], { encoding: "utf8", env: { PATH: process.env.PATH, ...extra } });
  const kinds = existsSync(binary) ? ["python", "rust"] : ["python"];
  if (!existsSync(binary)) { if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") throw new Error(`the Rust verifier is missing (${binary}) and the run requires none to be skipped`); console.log(`SKIP rust verifier half: ${binary} not built`); }
  for (const kind of kinds) {
    for (const [name, value, expect] of [["NEWSROOM_RECORD_THIN_RESULT", "true", []], ["NEWSROOM_RECORD_ORIGIN_HASH", "true", []], ["NEWSROOM_RECORD_THIN_RESULT", "0", []], ["NEWSROOM_RECORD_ORIGIN_HASH", "1", ["record_origin_hash"]], ["NEWSROOM_RECORD_THIN_RESULT", "1", ["record_thin_result"]], ["NEWSROOM_RECORD_EXTREME_WORDS", "1", []], ["NEWSROOM_RECORD_CAVEATS", "1", []], ["NEWSROOM_RECORD_ASOF_LISTS", "1", []], ["NEWSROOM_RECORD_NUMBERS", "1", []], ["NEWSROOM_RECORD_DROPPED_CONTENT", "1", []], ["NEWSROOM_RECORD_CRITIC_VISION", "1", []]]) {
      rmSync(join(art, "shadow"), { recursive: true, force: true });
      run(kind, { [name]: value });
      const got = existsSync(join(art, "shadow")) ? [...new Set(readdirSync(join(art, "shadow")).map((n) => n.split("-")[0]))].sort() : [];
      assert.deepEqual(got, expect, `${kind} verifier with ${name}=${value} writes ${JSON.stringify(expect)}`);
    }
  }
  const written = [];
  for (const kind of kinds) {
    rmSync(join(art, "shadow"), { recursive: true, force: true });
    const off = run(kind, {});
    assert.equal(existsSync(join(art, "shadow")), false, `${kind}: off writes nothing`);
    const on = run(kind, ON);
    assert.equal(on.stdout, off.stdout, `${kind}: stdout identical on and off`);
    assert.equal(on.stderr, off.stderr); assert.equal(on.status, off.status);
    const files = readdirSync(join(art, "shadow")).sort();
    const origin = JSON.parse(readFileSync(join(art, "shadow", files.find((n) => n.startsWith("record_origin_hash-"))), "utf8"));
    assert.equal(origin.counts.mismatches, 2, `${kind}: record-hash mismatch and data-file hash mismatch`);
    const thin = JSON.parse(readFileSync(join(art, "shadow", files.find((n) => n.startsWith("record_thin_result-"))), "utf8"));
    assert.equal(thin.thin_result, false); assert.ok(thin.checks_skipped_for_absent_input.includes("claims"));
    written.push(files);
  }
  if (written.length === 2) assert.deepEqual(written[0], written[1], "both verifiers write the same record names");
  // Only the run record: thin_result.
  const thinArt = join(work, "thin"); mkdirSync(thinArt);
  writeFileSync(join(thinArt, "story.json"), JSON.stringify({ kind: "investigation", schema_version: "0.6.0", files: {}, evidence: {} }));
  spawnSync("python3", [pythonVerifier, thinArt], { encoding: "utf8", env: { PATH: process.env.PATH, ...ON } });
  const thinFile = readdirSync(join(thinArt, "shadow")).find((n) => n.startsWith("record_thin_result-"));
  assert.equal(JSON.parse(readFileSync(join(thinArt, "shadow", thinFile), "utf8")).thin_result, true);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ---- The live call sites keep their results out of every tool result --------
{
  const source = readFileSync(join(REPO, "runtime", "pi", "newsroom.ts"), "utf8");
  const calls = source.split("\n").filter((line) => /record(Viz|Page)Lint\(|recordCriticVision\(/.test(line) && !line.startsWith("import"));
  assert.equal(calls.length, 4);
  for (const line of calls) assert.match(line, /^\s*await runShadow\(\(\) => record/, "a record call is a bare statement: its value is never used");
}
console.log("record-only detectors: ok");
