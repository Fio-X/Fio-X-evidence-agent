// Offline end-to-end test of the downloaded-PDF evidence chain:
//   download_data (mocked fetch) -> data/derived row table -> duckdb_query
//   -> record_claim judged verified -> Rust `news verify` passes.
// Altering the derived file (or the chain around it) must make the JS gate
// and the Rust verifier fail. Two synthetic PDF layouts (English, Chinese),
// each with repeated page headers, a unit row and subtotal rows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPdf, reportPages } from "./pdf_fixtures.mjs";
import { extractPdfText } from "../runtime/pi/pdf_extract.mjs";
import { verifyDerivedInput } from "../runtime/pi/computation_rows.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const probe = await extractPdfText({ bytes: buildPdf([[{ x: 10, y: 10, text: "probe" }]]) });
if (probe.extraction?.unavailable_reason === "pdftotext_not_found") { console.log("SKIP: pdftotext not found"); process.exit(0); }
const newsBin = join(ROOT, "target", "debug", "news");
const haveRust = existsSync(newsBin);
if (!haveRust) console.log("SKIP rust assertions: target/debug/news not built");

// Layout A (English): label then amount, unit row on page 1 only.
const english = buildPdf(reportPages({
  header: "Annual Statistical Report", columns: ["Region", "Amount"], colX: [40, 320],
  rowsByPage: [
    [["(USD million)", ""], ["Alpha", "10"], ["Beta", "20"], ["Subtotal", "30"]],
    [["Gamma", "5"], ["Delta", "1,250"], ["Subtotal", "1,255"]],
    [["Epsilon", "7"], ["Subtotal", "7"]],
  ],
}));
// Layout B (Chinese): amount column first, indented, different order.
const chinese = buildPdf(reportPages({
  header: "年度统计报告", columns: ["金额", "地区"], colX: [90, 300], leftX: 90,
  rowsByPage: [
    [["单位：百万元", ""], ["10", "甲"], ["20", "乙"], ["30", "小计"]],
    [["5", "丙"], ["1,250", "丁"], ["1,255", "小计"]],
  ],
}));
const SUBTOTALS = "('Subtotal', '小计')";
const NUM = "-?[0-9][0-9,]*(?:\\.[0-9]+)?";
const sqlFor = (rowsPath, amountFirst) => {
  const label = amountFirst ? `regexp_extract(text, '^(${NUM})\\s{2,}(.*)$', 2)` : `regexp_extract(text, '^(.*?)\\s{2,}(${NUM})$', 1)`;
  const amount = amountFirst ? `regexp_extract(text, '^(${NUM})\\s{2,}(.*)$', 1)` : `regexp_extract(text, '^(.*?)\\s{2,}(${NUM})$', 2)`;
  return `WITH raw AS (SELECT page, line, text FROM read_json_auto('${rowsPath}')),
pages AS (SELECT count(DISTINCT page) AS n FROM raw),
repeated AS (SELECT text FROM raw GROUP BY text HAVING count(DISTINCT page) = (SELECT n FROM pages)),
body AS (SELECT * FROM raw WHERE text NOT IN (SELECT text FROM repeated)),
parsed AS (SELECT page, trim(${label}) AS label, TRY_CAST(replace(${amount}, ',', '') AS DOUBLE) AS amount, text FROM body),
unit AS (SELECT min(text) AS unit_text FROM parsed WHERE amount IS NULL),
sums AS (SELECT page, sum(amount) FILTER (WHERE label NOT IN ${SUBTOTALS}) AS items_sum, sum(amount) FILTER (WHERE label IN ${SUBTOTALS}) AS subtotal FROM parsed WHERE amount IS NOT NULL GROUP BY page)
SELECT page, items_sum, subtotal, items_sum = subtotal AS reconciles, (SELECT unit_text FROM unit) AS unit FROM sums ORDER BY page`;
};

const tmp = mkdtempSync(join(tmpdir(), "pdf-derived-chain-"));
try {
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const art = join(tmp, "artifact");
  for (const dir of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(art, dir), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";

  // Mocked network: two public-looking URLs served from memory.
  const served = new Map([["http://8.8.8.8/a/english.pdf", english], ["http://8.8.8.8/b/chinese.pdf", chinese]]);
  globalThis.fetch = async (url) => {
    const body = served.get(String(url));
    if (!body) return new Response("nope", { status: 404 });
    const res = new Response(body, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(body.length) } });
    Object.defineProperty(res, "url", { value: String(url) });
    return res;
  };

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: ext } = await import(join(pi, "newsroom.test-copy.mjs"));
  ext(piApi);
  const download = tools.get("download_data"), query = tools.get("duckdb_query"), claim = tools.get("record_claim");
  assert.ok(download && query && claim);
  const read = (ref) => readFileSync(join(art, ref), "utf8");
  const claimsOnDisk = () => { try { return read("claims.jsonl").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  const layouts = [];
  for (const [url, bytes, amountFirst, unitText] of [["http://8.8.8.8/a/english.pdf", english, false, "(USD million)"], ["http://8.8.8.8/b/chinese.pdf", chinese, true, "单位：百万元"]]) {
    const out = await download.execute("d", { url });
    const dataRef = out.details.filePath;
    assert.equal(dataRef, `data/${sha(bytes)}.data`, "the downloaded bytes stay content-addressed and unchanged");
    assert.deepEqual(readFileSync(join(art, dataRef)), bytes);
    const rowsRef = out.details.derivedRowsPath;
    assert.equal(rowsRef, `data/derived/${sha(bytes)}.pdf-rows.json`);
    layouts.push({ url, bytes, dataRef, rowsRef, amountFirst, unitText });
    // chain verifies as written
    assert.equal((await verifyDerivedInput(art, rowsRef)).ok, true);
  }

  // Query each table, derive the reconciliation, record a claim over it.
  const refs = [];
  for (const L of layouts) {
    const run = await query.execute("q", { sql: sqlFor(L.rowsRef, L.amountFirst) });
    const rec = JSON.parse(read(run.details.path.replace(`${art}/`, "")));
    assert.equal(rec.input_binding, "source_bound", "derived table read is source_bound");
    assert.deepEqual(rec.read_inputs.map((i) => i.path), [L.rowsRef]);
    // repeated headers stripped, subtotals reconcile on every page, unit row kept verbatim
    assert.ok(rec.rows.length >= 2 && rec.rows.every((r) => r.reconciles === true), JSON.stringify(rec.rows));
    assert.deepEqual(rec.rows.map((r) => Number(r.items_sum)), L.amountFirst ? [30, 1255] : [30, 1255, 7]);
    assert.ok(rec.rows.every((r) => r.unit === L.unitText), "unit row is carried as printed, never converted");
    L.compRef = run.details.path.slice(art.length + 1);
    refs.push(L.compRef);
    await claim.execute("c", { claim: "page subtotals reconcile", claim_kind: "quantitative", status: "supported", source_refs: [L.dataRef], computation_refs: [L.compRef] });
    const last = claimsOnDisk().at(-1);
    assert.equal(last.status, "verified", "claim over the derived table is judged verified");
    assert.equal(last.verification.computation_replayed, true);
  }

  // Literal VALUES stay rejected.
  await assert.rejects(query.execute("q", { sql: "SELECT * FROM (VALUES ('A', 1)) t(a, b)" }), /SYNTHETIC_DATA_BLOCKED/);

  // Minimal story so the Rust verifier can walk the artifact.
  const files = { prompt: "prompt.md", latest_answer: "answer.md", conversation: "conversation.md", events: "events.jsonl", tool_audit: "tools.json", session_stats: "session-stats.json", plan: "plan.json", claims: "claims.jsonl", run_metrics: "run-metrics.jsonl" };
  for (const f of Object.values(files)) if (!existsSync(join(art, f))) writeFileSync(join(art, f), f.endsWith(".jsonl") ? "" : f.endsWith(".json") ? "{}\n" : "fixture\n");
  writeFileSync(join(art, "run-metrics.jsonl"), JSON.stringify({ schema_version: "0.7.0", operation: "investigate", status: "draft", duration_ms: 1 }) + "\n");
  writeFileSync(join(art, "story.json"), JSON.stringify({
    schema_version: "0.7.0", id: "chain", kind: "investigation", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", topic: "fixture", status: "draft",
    runtime: { backend: "pi-rpc", provider: null, model: null, session_dir: "session/" }, files,
    autonomy: { persistent_session: true, multi_turn_context: false, observable_planning: true, agent_loop_observed: false, user_messages: 0, turns: 0, tool_calls: 0, capability_tool_calls: 0, distinct_tools: 0, plan_revisions: 0, failed_tool_calls: 0, automatic_retries: 0 },
    evidence: { searches: [], sources: [], datasets: layouts.map((L) => L.dataRef), computations: refs, claims: [], visualizations: [] },
  }));
  const rustVerify = () => spawnSync(newsBin, ["verify", art], { encoding: "utf8" });
  const rustMessage = (r) => `${r.stdout}${r.stderr}`;
  if (haveRust) {
    const ok = rustVerify();
    assert.equal(ok.status, 0, `Rust verify must pass on the untouched chain:\n${rustMessage(ok)}`);
  }

  // Tampering. Each case edits one link of the chain, expects the JS gate and
  // Rust verifier to fail, then restores the bytes.
  const target = layouts[0];
  const rowsPath = join(art, target.rowsRef);
  const metaPath = rowsPath.replace(/\.json$/, ".meta.json");
  const originPath = (() => {
    for (const name of readdirSync(join(art, "data", "origins"))) {
      const o = JSON.parse(read(`data/origins/${name}`));
      if (o.file === target.dataRef) return join(art, "data", "origins", name);
    }
    throw new Error("origin not found");
  })();
  const keep = { rows: readFileSync(rowsPath), meta: readFileSync(metaPath), origin: readFileSync(originPath) };
  const restore = () => { writeFileSync(rowsPath, keep.rows); writeFileSync(metaPath, keep.meta); writeFileSync(originPath, keep.origin); };
  // Every tampering case names the exact reason it must fail for, in the JS chain
  // check, the JS claim gate and the Rust verifier, so a case cannot start failing
  // for an unrelated reason and still pass.
  const jsFails = async (label, reason, boundAtSource = false) => {
    const chain = await verifyDerivedInput(art, target.rowsRef);
    assert.equal(chain.ok, false, `${label}: JS chain check must fail`);
    assert.ok(chain.reason.startsWith(reason), `${label}: JS chain reason was "${chain.reason}", expected "${reason}"`);
    await assert.rejects(
      claim.execute("c", { claim: "page subtotals reconcile", claim_kind: "quantitative", status: "supported", source_refs: [target.dataRef], computation_refs: [target.compRef] }),
      // Changed source bytes are now refused earlier, where the claim's data refs are checked against their sidecar hash.
      boundAtSource ? /INVALID_SOURCE_EVIDENCE: data bytes do not match their record/ : /COMPUTATION_PROVENANCE_REQUIRED: recorded read inputs do not match the SQL/, `${label}: JS claim gate must fail`);
  };
  const rustFails = (label, reason) => {
    if (!haveRust) return;
    const r = rustVerify();
    assert.notEqual(r.status, 0, `${label}: Rust verify must fail`);
    assert.ok(rustMessage(r).includes(`failed its provenance chain: ${reason}`), `${label}: Rust verify must report "${reason}", got:\n${rustMessage(r)}`);
  };
  const json = (b) => JSON.parse(b.toString("utf8"));

  const before = claimsOnDisk().length;
  // 1. alter a row in the derived file
  writeFileSync(rowsPath, keep.rows.toString("utf8").replace('"text":"Alpha', '"text":"Alphx'));
  { const why = "derived table bytes do not match rows_sha256"; await jsFails("edited derived row", why); rustFails("edited derived row", why); restore(); }
  // 2. alter the derived file AND make its metadata agree: the download record no longer matches
  const forged = keep.rows.toString("utf8").replace("Alpha", "Alphx");
  writeFileSync(rowsPath, forged);
  writeFileSync(metaPath, JSON.stringify({ ...json(keep.meta), rows_sha256: sha(Buffer.from(forged)) }));
  { const why = "no download record binds this table to the PDF"; await jsFails("forged derived+meta", why); rustFails("forged derived+meta", why); restore(); }
  // 3. metadata claims a different source PDF hash
  writeFileSync(metaPath, JSON.stringify({ ...json(keep.meta), source_sha256: "0".repeat(64) }));
  { const why = "derived table is not named for its source sha256"; await jsFails("wrong source_sha256", why); rustFails("wrong source_sha256", why); restore(); }
  // 4. the source PDF bytes changed
  const dataPath = join(art, target.dataRef);
  const pdfBytes = readFileSync(dataPath);
  writeFileSync(dataPath, Buffer.concat([pdfBytes, Buffer.from("\n%tampered\n")]));
  { const why = "source PDF bytes do not match source_sha256"; await jsFails("changed PDF", why, true); rustFails("changed PDF", why); writeFileSync(dataPath, pdfBytes); }
  // 5. no download record binds the table to the PDF
  writeFileSync(originPath, JSON.stringify({ ...json(keep.origin), derived_text: undefined }));
  { const why = "no download record binds this table to the PDF"; await jsFails("origin without derived_text", why); rustFails("origin without derived_text", why); restore(); }
  // 6. the metadata file is missing
  { rmSync(metaPath); await jsFails("missing meta", "derived chain unreadable: ENOENT"); rustFails("missing meta", "derived metadata unreadable:"); restore(); }
  // 7. rows_file in the metadata names another table
  { const why = "derived metadata does not describe this table"; writeFileSync(metaPath, JSON.stringify({ ...json(keep.meta), rows_file: `data/derived/${"1".repeat(64)}.pdf-rows.json` })); await jsFails("rows_file mismatch", why); rustFails("rows_file mismatch", why); restore(); }
  // 8. the download record is missing
  { const why = "no download record binds this table to the PDF"; rmSync(originPath); await jsFails("missing origin", why); rustFails("missing origin", why); restore(); }
  assert.equal(claimsOnDisk().length, before, "no claim recorded while the chain was broken");

  // Everything restored: chain verifies again (must-pass counterpart).
  assert.equal((await verifyDerivedInput(art, target.rowsRef)).ok, true);
  if (haveRust) assert.equal(rustVerify().status, 0, "restored chain passes Rust verify again");
  // A path under data/derived/ that is not a recognised table never verifies.
  writeFileSync(join(art, "data", "derived", "stray.csv"), "a\n1\n");
  assert.equal((await verifyDerivedInput(art, "data/derived/stray.csv")).reason, "not a recognised derived table path");
  rustFails("stray derived file", "not a recognised derived table path");
  console.log("test_pdf_derived_chain.mjs ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
