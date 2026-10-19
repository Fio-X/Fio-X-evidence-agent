// NEWSROOM_SPEED_VIZ_REPORT_ALL=1: newsroom_viz_plan lists every independent problem in one refusal.
// Differential: the same case table runs against newsroom.ts at the baseline commit (83de204, the code before the switch), against the head with
// the switch off, and against the head with it on. Verdict (accepted / refused) must agree in all three; off must equal the baseline's message
// exactly; on must start with the baseline's message (the first problem keeps its text) and may only add independent problems. A refused call
// must not run SQL or write anything (artifact root listing unchanged), and a refusal never records the inline claim.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutApprovedIllustration, withoutApprovedLieflat, loadPinPatches } from "./lib_pin_patch.mjs";
import { REPORT as CALL_REPORT, reportRows, callRows, expectRows, expectRowsDelta } from "./call_report_expect.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_REF = process.env.VIZ_REPORT_ALL_BASE_REF || "83de204";
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`;
const TREE = makeTestTmp("viz-report-all-");
const stub = (name, source) => {
  mkdirSync(join(TREE, "node_modules", name), { recursive: true });
  writeFileSync(join(TREE, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(TREE, "node_modules", name, "index.js"), source);
};
stub("typebox", TYPEBOX);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
const headSource = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const baseSource = execFileSync("git", ["show", `${BASELINE_REF}:runtime/pi/newsroom.ts`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
const COPY_BASE = join(TREE, "runtime/pi/newsroom.base-copy.mjs");
const COPY_HEAD = join(TREE, "runtime/pi/newsroom.head-copy.mjs");
// The baseline newsroom.ts imports shadow-check exports that were since removed; it gets the shadow.mjs of the same baseline ref, as its own file.
assert.ok(baseSource.includes('from "./shadow.mjs"'), "the baseline imports ./shadow.mjs");
writeFileSync(join(TREE, "runtime/pi/shadow.base-copy.mjs"), execFileSync("git", ["show", `${BASELINE_REF}:runtime/pi/shadow.mjs`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }));
writeFileSync(COPY_BASE, stripTypeScriptTypes(baseSource.split('from "./shadow.mjs"').join('from "./shadow.base-copy.mjs"'), { mode: "strip" }));
writeFileSync(COPY_HEAD, stripTypeScriptTypes(headSource, { mode: "strip" }));

let n = 0;
async function load(file, env) {
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_") && k !== "NEWSROOM_ARTIFACT_DIR") delete process.env[k];
  process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; // the off-table call refusal is on by default; this test is about something else, so both are pinned off
  process.env.NEWSROOM_REFUSAL_FIELDS = "0"; // the refusal fields are on by default and add a line after the text; this test pins the refusal text itself, so the old text is pinned
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  Object.assign(process.env, env);
  const tools = new Map();
  const mod = await import(`${pathToFileURL(file).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const listing = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).sort().map((f) => [f, sha(readFileSync(f.startsWith("/") ? f : join(art, f)))]));

// ---- one artifact root with a verified claim, shared by every call (refusals must leave it unchanged) -----------------------
const art = join(makeTestTmp("viz-report-all-art-"), "run");
for (const d of ["data", "sources", "computations", "runtime/query-rows", "visualizations/plans", "visualizations/lints", "visualizations/critics", "editorial/story-graphs"]) mkdirSync(join(art, d), { recursive: true });
cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
const csv = Buffer.from("region,amount\nn,4\ns,9\nw,6\n");
const data = `data/${sha(csv)}.csv`;
writeFileSync(join(art, data), csv);
writeFileSync(join(art, `${data}.meta.json`), JSON.stringify({ file: data, sha256: sha(csv), bytes: csv.length, label: "fixture" }));
const setup = await load(COPY_BASE, { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "0" });
const SQL = `SELECT region, amount FROM read_csv_auto('${data}')`;
const q = await setup.get("duckdb_query").execute("q", { sql: SQL });
await setup.get("record_claim").execute("c", { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [relative(art, q.details.path)] });
const claimId = readFileSync(join(art, "claims.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1).claim_id;
assert.ok(claimId, "fixture claim recorded");
// a story graph that exists but has not passed, and one that has passed with node n1
writeFileSync(join(art, "editorial/story-graphs/open.json"), JSON.stringify({ passed: false, nodes: [{ id: "n1" }] }));
writeFileSync(join(art, "editorial/story-graphs/ok.json"), JSON.stringify({ passed: true, nodes: [{ id: "n1" }] }));

const good = {
  reader_task: "sequence", title: "Amounts by region", alt: "A horizontal bar chart of the amount recorded for each region in the fixture data.",
  takeaway: "Regions differ in amount.", source_note: "fixture", subtitle: "fixture", unit: "units", visual_family: "statistical", data_topology: "tabular",
  chart_type: "horizontal_bar", category_field: "region", value_field: "amount", sort: "desc", highlight_values: [], annotations: [], sql: SQL, claim_id: claimId,
};
const ms = [{ id: "amt", field: "amount", phenomenon: "amount by region", unit: "units", measure_kind: "level", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }];
const ranked = { ...good, reader_task: "ranking", measure_semantics: ms, claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "amt", measure_ids: ["amt"], claim_id: claimId } };
const { category_field, ...noCategory } = good;
const module_ = { delivery_role: "infographic_module" };
const CASES = {
  "valid plain plan": good,
  "valid ranking plan with declarations": ranked,
  "rule 5 alone: horizontal_bar without category_field": noCategory,
  "sql write refused alone": { ...good, sql: "DELETE FROM x" },
  "sql write + rule 5": { ...noCategory, sql: "DELETE FROM x" },
  "rule 2 alone: module without story graph": { ...good, ...module_ },
  "rule 2 + rule 5": { ...noCategory, ...module_ },
  "unreadable story graph + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/missing.json", story_node_ids: ["n1"] },
  "story graph not passed + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/open.json", story_node_ids: ["n1"] },
  "unknown story node + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/ok.json", story_node_ids: ["zz"] },
  "story binding fine, rule 5 only": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/ok.json", story_node_ids: ["n1"] },
  "declaration required alone (ranking without semantics)": { ...good, reader_task: "ranking" },
  "declaration required + rule 5": { ...noCategory, reader_task: "ranking" },
  "declaration required + story binding + rule 5": { ...noCategory, reader_task: "ranking", ...module_ },
  "rule 3 alone: target_measure is a field name": { ...ranked, claim_spec: { ...ranked.claim_spec, target_measure: "amount" } },
  "rule 3 + rule 5": { ...noCategory, ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, target_measure: "amount" } },
  "rule 4 alone: claim_spec.claim_id empty": { ...ranked, claim_spec: { ...ranked.claim_spec, claim_id: "" } },
  "rule 4 + rule 5": { ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, claim_id: "" } },
  "rule 4 + story binding + rule 5": { ...ranked, category_field: undefined, ...module_, claim_spec: { ...ranked.claim_spec, claim_id: "" } },
  "grammar block alone: rank claim on a line chart": { ...ranked, chart_type: "line", x_field: "region", category_field: undefined },
  "claim_id differs from the plan's, plus rule 5": { ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, claim_id: "other" } },
  "unknown claim_id (lookup) alone": { ...good, claim_id: "no-such-claim" },
  "unknown claim_id + rule 5 (lookup comes last)": { ...noCategory, claim_id: "no-such-claim" },
  "whitespace claim_id": { ...good, claim_id: "  " },
  "draft plan (no claim_id) valid": { ...good, claim_id: undefined },
  "draft plan + rule 5": { ...noCategory, claim_id: undefined },
};
// A fresh copy of the fixture root per call, so every variant starts from the same state and its side effects can be compared exactly.
const NORM_DROP = /(_at|timestamp|elapsed_ms|duration_ms)$/;
const dropTimes = (k, v) => (NORM_DROP.test(k) ? undefined : v);
const norm = (buf) => {
  try { return JSON.stringify(JSON.parse(buf), dropTimes); } catch { /* not one JSON document */ }
  try { return String(buf).trim().split("\n").map((line) => JSON.stringify(JSON.parse(line), dropTimes)).join("\n"); } catch { return sha(buf); } // JSON lines (claims.jsonl)
};
const trace = (root) => Object.fromEntries(walk(root).map((f) => relative(root, f)).filter((f) => f !== CALL_REPORT).sort().map((f) => [f, norm(readFileSync(join(root, f)))]));
const run = async (tools, params, flag, { env = {}, signal, tool = "newsroom_viz_plan", times = 1 } = {}) => {
  if (flag === undefined) delete process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL; else process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL = flag; // read at call time, so set it per call
  const root = join(makeTestTmp("viz-report-all-run-"), "run");
  cpSync(art, root, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = root;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const before = trace(root);
  let out;
  for (let i = 0; i < times; i++) {
    try { const res = await tools.get(tool).execute("t", JSON.parse(JSON.stringify(params)), signal); out = { ok: true, text: res.content[0].text }; }
    catch (e) { out = { ok: false, message: String(e?.message ?? e), name: e?.name, code: e?.code }; }
  }
  const after = trace(root);
  for (const k of Object.keys(env)) delete process.env[k];
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
  const unroot = (t) => (typeof t === "string" ? t.split(root).join("<root>").split("$ARTIFACT").join("<root>") : t); // the per-call root's path is in some messages; #198 shows the model "$ARTIFACT" for it, and only that placeholder is folded into <root>
  return { ...out, rows: reportRows(root), message: unroot(out.message), text: unroot(out.text), changed, written: Object.fromEntries(changed.map((f) => [f, unroot(after[f])])) };
};
// The call report is always written now, and the copy of the old newsroom.ts reports through the head's groups.mjs too: each arm's rows are stated, never left out.
// ROWS_AT: shape lists by label (lines, see call_report_expect.mjs callRows); a delta label holds { onlyInA, onlyInB }.
const ROWS_1 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_2 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual artifactTmpDir - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual chartPlanStamp knowledge t",
  "newsroom_viz_plan visual createViaLink - t",
  "newsroom_viz_plan visual ensureParent - t",
  "newsroom_viz_plan visual evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::requireVerifiedClaim knowledge t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_plan visual groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual latestClaimRecords - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual textResult - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual verifiedClaimFor knowledge t",
  "newsroom_viz_plan visual verifiedClaimRecords knowledge t",
  "newsroom_viz_plan visual writeArtifactIfAbsent - t",
];
const ROWS_3 = [
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
];
const ROWS_4 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_5 = [
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
];
const ROWS_6 = [
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
];
const ROWS_7 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual readArtifactJson - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
];
const ROWS_8 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_9 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::requireVerifiedClaim knowledge t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual latestClaimRecords - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual verifiedClaimFor knowledge t",
  "newsroom_viz_plan visual verifiedClaimRecords knowledge t",
];
const ROWS_10 = [
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
];
const ROWS_11 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual readArtifactJson - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
];
const ROWS_12 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_13 = [
  "newsroom_viz_plan visual appendArtifact - t",
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual artifactTmpDir - t",
  "newsroom_viz_plan visual assertDataBytesMatchRecord - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual buildComputationRecord - t",
  "newsroom_viz_plan visual chartPlanStamp knowledge t",
  "newsroom_viz_plan visual claimIdFor - t",
  "newsroom_viz_plan visual claimSqlLintEnabled - t",
  "newsroom_viz_plan visual claimTemplateNumber - t",
  "newsroom_viz_plan visual computationSql - t",
  "newsroom_viz_plan visual computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_plan visual computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_plan visual computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_plan visual computation_rows.mjs::recordedInputState knowledge t tool_allowed=true",
  "newsroom_viz_plan visual createViaLink - t",
  "newsroom_viz_plan visual deriveInputsForSql - t",
  "newsroom_viz_plan visual duckDbRun - t tool_allowed=true",
  "newsroom_viz_plan visual ensureParent - t",
  "newsroom_viz_plan visual evidenceSnapshot - t",
  "newsroom_viz_plan visual evidence_gate.mjs::assertComputationBoundToSources knowledge t tool_allowed=true",
  "newsroom_viz_plan visual evidence_gate.mjs::assertDatasetPayload knowledge t tool_allowed=true",
  "newsroom_viz_plan visual evidence_gate.mjs::assertEvidenceBackedStatus knowledge t tool_allowed=true",
  "newsroom_viz_plan visual evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::deriveClaimVerification knowledge t tool_allowed=true",
  "newsroom_viz_plan visual evidence_gate.mjs::evaluateClaimSupport knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::requireVerifiedClaim knowledge t",
  "newsroom_viz_plan visual groups.mjs::asHandoffWriter system t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_plan visual groups.mjs::runDeclared system t",
  "newsroom_viz_plan visual groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual knowledgeSide knowledge t tool_allowed=true",
  "newsroom_viz_plan visual knowledge_writer.mjs::knowledgeWriter knowledge t tool_allowed=true",
  "newsroom_viz_plan visual latestClaimRecords - t",
  "newsroom_viz_plan visual lintClaimSql - t",
  "newsroom_viz_plan visual literalNumberIn - t",
  "newsroom_viz_plan visual normalizeArtifactRefs - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual process.mjs::runProcess system t",
  "newsroom_viz_plan visual provenance.mjs::computationRelativePath knowledge t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_plan visual readArtifactJson - t",
  "newsroom_viz_plan visual readRunFile - t",
  "newsroom_viz_plan visual recordClaimArtifact knowledge t tool_allowed=true",
  "newsroom_viz_plan visual replayComputationEvidence knowledge t tool_allowed=true",
  "newsroom_viz_plan visual replayRecordedComputation - t",
  "newsroom_viz_plan visual serializeSqlAst - t",
  "newsroom_viz_plan visual stableId - t",
  "newsroom_viz_plan visual statRunFile - t",
  "newsroom_viz_plan visual textResult - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual validateSourceEvidence knowledge t tool_allowed=true",
  "newsroom_viz_plan visual verifiedClaimFor knowledge t",
  "newsroom_viz_plan visual verifiedClaimRecords knowledge t",
  "newsroom_viz_plan visual verifyComputationForWrite - t",
  "newsroom_viz_plan visual viz.mjs::hashRows visual t",
  "newsroom_viz_plan visual writeArtifactIfAbsent - t",
];
const ROWS_14 = [
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
];
const ROWS_15 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_16 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual assertDataBytesMatchRecord - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual buildComputationRecord - t",
  "newsroom_viz_plan visual claimIdFor - t",
  "newsroom_viz_plan visual claimSqlLintEnabled - t",
  "newsroom_viz_plan visual claimTemplateNumber - t",
  "newsroom_viz_plan visual computationSql - t",
  "newsroom_viz_plan visual computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_plan visual computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_plan visual computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_plan visual deriveInputsForSql - t",
  "newsroom_viz_plan visual duckDbRun - t tool_allowed=true",
  "newsroom_viz_plan visual evidenceSnapshot - t",
  "newsroom_viz_plan visual evidence_gate.mjs::assertDatasetPayload knowledge t tool_allowed=true",
  "newsroom_viz_plan visual evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::evaluateClaimSupport knowledge t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual groups.mjs::runDeclared system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual lintClaimSql - t",
  "newsroom_viz_plan visual literalNumberIn - t",
  "newsroom_viz_plan visual normalizeArtifactRefs - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual process.mjs::runProcess system t",
  "newsroom_viz_plan visual provenance.mjs::computationRelativePath knowledge t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_plan visual readRunFile - t",
  "newsroom_viz_plan visual serializeSqlAst - t",
  "newsroom_viz_plan visual stableId - t",
  "newsroom_viz_plan visual statRunFile - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual validateSourceEvidence knowledge t tool_allowed=true",
  "newsroom_viz_plan visual viz.mjs::hashRows visual t",
];
const ROWS_17 = [
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
];
const ROWS_18 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_19 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual buildComputationRecord - t",
  "newsroom_viz_plan visual claimSqlLintEnabled - t",
  "newsroom_viz_plan visual computationSql - t",
  "newsroom_viz_plan visual computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_plan visual computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_plan visual computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_plan visual deriveInputsForSql - t",
  "newsroom_viz_plan visual duckDbRun - t tool_allowed=true",
  "newsroom_viz_plan visual evidenceSnapshot - t",
  "newsroom_viz_plan visual evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge t",
  "newsroom_viz_plan visual groups.mjs::runDeclared system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual lintClaimSql - t",
  "newsroom_viz_plan visual literalNumberIn - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual process.mjs::runProcess system t",
  "newsroom_viz_plan visual provenance.mjs::computationRelativePath knowledge t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_plan visual serializeSqlAst - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual viz.mjs::hashRows visual t",
];
const ROWS_20 = [
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
];
const ROWS_21 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_22 = [
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual computationSql - t",
  "newsroom_viz_plan visual computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_plan visual deriveInputsForSql - t",
  "newsroom_viz_plan visual evidenceSnapshot - t",
  "newsroom_viz_plan visual evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge t",
  "newsroom_viz_plan visual groups.mjs::runDeclared system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual process.mjs::runProcess system t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual serializeSqlAst - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
];
const ROWS_23 = [
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
];
const ROWS_24 = [
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
];
const ROWS_25 = [
  "newsroom_viz_chain agent agentRecordSide - t",
  "newsroom_viz_chain agent agent_record_writer.mjs::agentRecordWriter agent t",
  "newsroom_viz_chain agent appendArtifact - t",
  "newsroom_viz_chain agent artifactRoot - t",
  "newsroom_viz_chain agent ensureParent - t",
  "newsroom_viz_chain agent groups.mjs::asHandoffWriter system t",
  "newsroom_viz_chain agent groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_chain agent groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_chain agent saveChainEvent - t",
  "newsroom_viz_chain agent tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
];
const ROWS_26 = [
  "- - artifactRoot - n requester=\"none\"",
  "- - artifactTmpDir - n requester=\"none\"",
  "- - atomicArtifactWritesEnabled - n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - economy_names.mjs::resolveEconomyDisplayName knowledge n requester=\"none\"",
  "- - economy_names.mjs::unmappedEconomyNameValues knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertComputationBoundToSources knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertDatasetPayload knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertEvidenceBackedStatus knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::deriveClaimVerification knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::evaluateClaimSupport knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - fillCopiedEnabled - n requester=\"none\"",
  "- - firstTry - n requester=\"none\"",
  "- - firstTryTextEnabled - n requester=\"none\"",
  "- - inlineClaimEnabled - n requester=\"none\"",
  "- - normalizedNewsroomPhase - n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - refusedOption - n requester=\"none\"",
  "- - refusedOptionsFixOn - n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
  "- - withRefusedOption - n requester=\"none\"",
];
const ROWS_27 = [
  "newsroom_viz_chain agent agentRecordSide - t",
  "newsroom_viz_chain agent agent_record_writer.mjs::agentRecordWriter agent t",
  "newsroom_viz_chain agent appendArtifact - t",
  "newsroom_viz_chain agent artifactRoot - t",
  "newsroom_viz_chain agent claimBindingDeps - t",
  "newsroom_viz_chain agent computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_chain agent computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_chain agent computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_chain agent computation_rows.mjs::recordedInputState knowledge t tool_allowed=true",
  "newsroom_viz_chain agent deriveInputsForSql - t",
  "newsroom_viz_chain agent duckDbRun - t tool_allowed=true",
  "newsroom_viz_chain agent ensureParent - t",
  "newsroom_viz_chain agent evidenceSnapshot - t",
  "newsroom_viz_chain agent evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_chain agent groups.mjs::asHandoffWriter system t",
  "newsroom_viz_chain agent groups.mjs::readThroughStaging system t",
  "newsroom_viz_chain agent groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_chain agent groups.mjs::runDeclared system t",
  "newsroom_viz_chain agent groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_chain agent latestClaimRecords - t",
  "newsroom_viz_chain agent process.mjs::runProcess system t",
  "newsroom_viz_chain agent provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_chain agent queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_chain agent readArtifactJson - t",
  "newsroom_viz_chain agent saveChainEvent - t",
  "newsroom_viz_chain agent serializeSqlAst - t",
  "newsroom_viz_chain agent textResult - t",
  "newsroom_viz_chain agent tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_chain agent validateReadOnlySql - t",
  "newsroom_viz_chain agent verifiedClaimIds knowledge t",
  "newsroom_viz_chain agent verifiedClaimRecords knowledge t",
  "newsroom_viz_chain agent vizClaimBindings - t",
  "newsroom_viz_critic visual artifactRoot - t",
  "newsroom_viz_critic visual artifactTmpDir - t",
  "newsroom_viz_critic visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_critic visual createViaLink - t",
  "newsroom_viz_critic visual economy_names.mjs::resolveEconomyDisplayName knowledge t",
  "newsroom_viz_critic visual ensureParent - t",
  "newsroom_viz_critic visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_critic visual groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_critic visual groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_critic visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_critic visual readArtifactJson - t",
  "newsroom_viz_critic visual readArtifactText - t",
  "newsroom_viz_critic visual readManifestOrRejected - t",
  "newsroom_viz_critic visual textResult - t",
  "newsroom_viz_critic visual writeArtifactIfAbsent - t",
  "newsroom_viz_lint visual artifactRoot - t",
  "newsroom_viz_lint visual artifactTmpDir - t",
  "newsroom_viz_lint visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_lint visual buildComputationRecord - t",
  "newsroom_viz_lint visual chartLintStatus knowledge t",
  "newsroom_viz_lint visual claimBindingDeps - t",
  "newsroom_viz_lint visual computationSql - t",
  "newsroom_viz_lint visual computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_lint visual computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_lint visual computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_lint visual computation_rows.mjs::recordedInputState knowledge t tool_allowed=true",
  "newsroom_viz_lint visual createViaLink - t",
  "newsroom_viz_lint visual deriveInputsForSql - t",
  "newsroom_viz_lint visual duckDbRun - t tool_allowed=true",
  "newsroom_viz_lint visual economy_names.mjs::resolveEconomyDisplayName knowledge t",
  "newsroom_viz_lint visual economy_names.mjs::unmappedEconomyNameValues knowledge t",
  "newsroom_viz_lint visual ensureParent - t",
  "newsroom_viz_lint visual evidenceSnapshot - t",
  "newsroom_viz_lint visual evidence_gate.mjs::deriveClaimVerification knowledge t tool_allowed=true",
  "newsroom_viz_lint visual evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_lint visual groups.mjs::asHandoffWriter system t",
  "newsroom_viz_lint visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_lint visual groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_lint visual groups.mjs::runDeclared system t",
  "newsroom_viz_lint visual groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_lint visual knowledgeSide knowledge t tool_allowed=true",
  "newsroom_viz_lint visual knowledge_writer.mjs::knowledgeWriter knowledge t tool_allowed=true",
  "newsroom_viz_lint visual latestClaimRecords - t",
  "newsroom_viz_lint visual process.mjs::runProcess system t",
  "newsroom_viz_lint visual provenance.mjs::computationRelativePath knowledge t",
  "newsroom_viz_lint visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_lint visual queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_lint visual readArtifactJson - t",
  "newsroom_viz_lint visual record_only.mjs::recordVizLint knowledge t tool_allowed=true",
  "newsroom_viz_lint visual replayRecordedComputation - t",
  "newsroom_viz_lint visual serializeSqlAst - t",
  "newsroom_viz_lint visual shadow.mjs::runShadow knowledge t tool_allowed=true",
  "newsroom_viz_lint visual textResult - t",
  "newsroom_viz_lint visual validateReadOnlySql - t",
  "newsroom_viz_lint visual verifiedClaimIds knowledge t",
  "newsroom_viz_lint visual verifiedClaimRecords knowledge t",
  "newsroom_viz_lint visual verifyComputationForWrite - t",
  "newsroom_viz_lint visual viz.mjs::hashRows visual t",
  "newsroom_viz_lint visual vizClaimBindings - t",
  "newsroom_viz_lint visual writeArtifactIfAbsent - t",
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual artifactTmpDir - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual chartPlanStamp knowledge t",
  "newsroom_viz_plan visual createViaLink - t",
  "newsroom_viz_plan visual ensureParent - t",
  "newsroom_viz_plan visual evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::requireVerifiedClaim knowledge t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_plan visual groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual latestClaimRecords - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual textResult - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual verifiedClaimFor knowledge t",
  "newsroom_viz_plan visual verifiedClaimRecords knowledge t",
  "newsroom_viz_plan visual writeArtifactIfAbsent - t",
  "newsroom_viz_render visual artifactRoot - t",
  "newsroom_viz_render visual artifactTmpDir - t",
  "newsroom_viz_render visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_render visual chartRenderStatus knowledge t",
  "newsroom_viz_render visual computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_render visual computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_render visual createViaLink - t",
  "newsroom_viz_render visual duckDbRun - t tool_allowed=true",
  "newsroom_viz_render visual economy_names.mjs::resolveEconomyDisplayName knowledge t",
  "newsroom_viz_render visual economy_names.mjs::unmappedEconomyNameValues knowledge t",
  "newsroom_viz_render visual ensureParent - t",
  "newsroom_viz_render visual evidence_gate.mjs::isSystemVerifiedClaim knowledge t",
  "newsroom_viz_render visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_render visual groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_render visual groups.mjs::runDeclared system t",
  "newsroom_viz_render visual groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_render visual latestClaimRecords - t",
  "newsroom_viz_render visual process.mjs::runProcess system t",
  "newsroom_viz_render visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_render visual queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_render visual readArtifactJson - t",
  "newsroom_viz_render visual textResult - t",
  "newsroom_viz_render visual validateReadOnlySql - t",
  "newsroom_viz_render visual verifiedClaimRecords knowledge t",
  "newsroom_viz_render visual viz.mjs::hashRows visual t",
  "newsroom_viz_render visual writeArtifactIfAbsent - t",
];
const ROWS_28 = [
  "- - computation_rows.mjs::deriveComputationInputs knowledge n requester=\"none\"",
  "- - computation_rows.mjs::materializeComputationRowTables knowledge n requester=\"none\"",
  "- - computation_rows.mjs::recordedInputState knowledge n requester=\"none\"",
  "- - economy_names.mjs::resolveEconomyDisplayName knowledge n requester=\"none\"",
  "- - economy_names.mjs::unmappedEconomyNameValues knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::isSystemVerifiedClaim knowledge n requester=\"none\"",
  "- - evidence_gate.mjs::requireVerifiedClaim knowledge n requester=\"none\"",
  "- - process.mjs::runProcess system n requester=\"none\"",
  "- - provenance.mjs::computationRelativePath knowledge n requester=\"none\"",
  "- - provenance.mjs::sha256Hex knowledge n requester=\"none\"",
  "- - tool_phase_policy.mjs::toolEnabled agent n requester=\"none\"",
  "- - viz.mjs::hashRows visual n requester=\"none\"",
];
const ROWS_29 = [
  "newsroom_viz_chain agent agentRecordSide - t",
  "newsroom_viz_chain agent agent_record_writer.mjs::agentRecordWriter agent t",
  "newsroom_viz_chain agent appendArtifact - t",
  "newsroom_viz_chain agent artifactRoot - t",
  "newsroom_viz_chain agent ensureParent - t",
  "newsroom_viz_chain agent groups.mjs::asHandoffWriter system t",
  "newsroom_viz_chain agent groups.mjs::recordBoundaryWrite system t",
  "newsroom_viz_chain agent groups.mjs::stagedWriteRoot system t",
  "newsroom_viz_chain agent saveChainEvent - t",
  "newsroom_viz_chain agent tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual artifactRoot - t",
  "newsroom_viz_plan visual assertDataBytesMatchRecord - t",
  "newsroom_viz_plan visual atomicArtifactWritesEnabled - t",
  "newsroom_viz_plan visual buildComputationRecord - t",
  "newsroom_viz_plan visual claimIdFor - t",
  "newsroom_viz_plan visual claimSqlLintEnabled - t",
  "newsroom_viz_plan visual claimTemplateNumber - t",
  "newsroom_viz_plan visual computationSql - t",
  "newsroom_viz_plan visual computation_rows.mjs::deriveComputationInputs knowledge t tool_allowed=true",
  "newsroom_viz_plan visual computation_rows.mjs::duckdbBundledExtensionArgs knowledge t",
  "newsroom_viz_plan visual computation_rows.mjs::materializeComputationRowTables knowledge t tool_allowed=true",
  "newsroom_viz_plan visual deriveInputsForSql - t",
  "newsroom_viz_plan visual duckDbRun - t tool_allowed=true",
  "newsroom_viz_plan visual evidenceSnapshot - t",
  "newsroom_viz_plan visual evidence_gate.mjs::assertDatasetPayload knowledge t tool_allowed=true",
  "newsroom_viz_plan visual evidence_gate.mjs::assertInlineRowsHaveEvidence knowledge t",
  "newsroom_viz_plan visual evidence_gate.mjs::evaluateClaimSupport knowledge t",
  "newsroom_viz_plan visual groups.mjs::readThroughStaging system t",
  "newsroom_viz_plan visual groups.mjs::runDeclared system t",
  "newsroom_viz_plan visual inlineClaimEnabled - t",
  "newsroom_viz_plan visual lintClaimSql - t",
  "newsroom_viz_plan visual literalNumberIn - t",
  "newsroom_viz_plan visual normalizeArtifactRefs - t",
  "newsroom_viz_plan visual normalizedNewsroomPhase - t",
  "newsroom_viz_plan visual process.mjs::runProcess system t",
  "newsroom_viz_plan visual provenance.mjs::computationRelativePath knowledge t",
  "newsroom_viz_plan visual provenance.mjs::sha256Hex knowledge t",
  "newsroom_viz_plan visual queryDuckDb knowledge t tool_allowed=true",
  "newsroom_viz_plan visual readRunFile - t",
  "newsroom_viz_plan visual serializeSqlAst - t",
  "newsroom_viz_plan visual stableId - t",
  "newsroom_viz_plan visual statRunFile - t",
  "newsroom_viz_plan visual tool_phase_policy.mjs::toolEnabled agent t",
  "newsroom_viz_plan visual validateReadOnlySql - t",
  "newsroom_viz_plan visual validateSourceEvidence knowledge t tool_allowed=true",
  "newsroom_viz_plan visual viz.mjs::hashRows visual t",
];
const ROWS_AT = {
  "valid plain plan | base": ROWS_1,
  "valid plain plan | off vs base": { onlyInA: ROWS_2, onlyInB: ROWS_3 },
  "valid plain plan | on vs off": {},
  "valid ranking plan with declarations | base": ROWS_1,
  "valid ranking plan with declarations | off vs base": { onlyInA: ROWS_2, onlyInB: ROWS_3 },
  "valid ranking plan with declarations | on vs off": {},
  "rule 5 alone: horizontal_bar without category_field | base": ROWS_4,
  "rule 5 alone: horizontal_bar without category_field | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 5 alone: horizontal_bar without category_field | on vs off": {},
  "sql write refused alone | base": ROWS_4,
  "sql write refused alone | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "sql write refused alone | on vs off": {},
  "sql write + rule 5 | base": ROWS_4,
  "sql write + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "sql write + rule 5 | on vs off": {},
  "rule 2 alone: module without story graph | base": ROWS_4,
  "rule 2 alone: module without story graph | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 2 alone: module without story graph | on vs off": {},
  "rule 2 + rule 5 | base": ROWS_4,
  "rule 2 + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 2 + rule 5 | on vs off": {},
  "unreadable story graph + rule 5 | base": ROWS_4,
  "unreadable story graph + rule 5 | off vs base": { onlyInA: ROWS_7, onlyInB: ROWS_6 },
  "unreadable story graph + rule 5 | on vs off": {},
  "story graph not passed + rule 5 | base": ROWS_4,
  "story graph not passed + rule 5 | off vs base": { onlyInA: ROWS_7, onlyInB: ROWS_6 },
  "story graph not passed + rule 5 | on vs off": {},
  "unknown story node + rule 5 | base": ROWS_4,
  "unknown story node + rule 5 | off vs base": { onlyInA: ROWS_7, onlyInB: ROWS_6 },
  "unknown story node + rule 5 | on vs off": {},
  "story binding fine, rule 5 only | base": ROWS_4,
  "story binding fine, rule 5 only | off vs base": { onlyInA: ROWS_7, onlyInB: ROWS_6 },
  "story binding fine, rule 5 only | on vs off": {},
  "declaration required alone (ranking without semantics) | base": ROWS_4,
  "declaration required alone (ranking without semantics) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "declaration required alone (ranking without semantics) | on vs off": {},
  "declaration required + rule 5 | base": ROWS_4,
  "declaration required + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "declaration required + rule 5 | on vs off": {},
  "declaration required + story binding + rule 5 | base": ROWS_4,
  "declaration required + story binding + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "declaration required + story binding + rule 5 | on vs off": {},
  "rule 3 alone: target_measure is a field name | base": ROWS_4,
  "rule 3 alone: target_measure is a field name | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 3 alone: target_measure is a field name | on vs off": {},
  "rule 3 + rule 5 | base": ROWS_4,
  "rule 3 + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 3 + rule 5 | on vs off": {},
  "rule 4 alone: claim_spec.claim_id empty | base": ROWS_4,
  "rule 4 alone: claim_spec.claim_id empty | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 4 alone: claim_spec.claim_id empty | on vs off": {},
  "rule 4 + rule 5 | base": ROWS_4,
  "rule 4 + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 4 + rule 5 | on vs off": {},
  "rule 4 + story binding + rule 5 | base": ROWS_4,
  "rule 4 + story binding + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "rule 4 + story binding + rule 5 | on vs off": {},
  "grammar block alone: rank claim on a line chart | base": ROWS_4,
  "grammar block alone: rank claim on a line chart | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "grammar block alone: rank claim on a line chart | on vs off": {},
  "claim_id differs from the plan's, plus rule 5 | base": ROWS_4,
  "claim_id differs from the plan's, plus rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "claim_id differs from the plan's, plus rule 5 | on vs off": {},
  "unknown claim_id (lookup) alone | base": ROWS_8,
  "unknown claim_id (lookup) alone | off vs base": { onlyInA: ROWS_9, onlyInB: ROWS_10 },
  "unknown claim_id (lookup) alone | on vs off": {},
  "unknown claim_id + rule 5 (lookup comes last) | base": ROWS_4,
  "unknown claim_id + rule 5 (lookup comes last) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "unknown claim_id + rule 5 (lookup comes last) | on vs off": {},
  "whitespace claim_id | base": ROWS_4,
  "whitespace claim_id | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "whitespace claim_id | on vs off": {},
  "draft plan (no claim_id) valid | base": ROWS_4,
  "draft plan (no claim_id) valid | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "draft plan (no claim_id) valid | on vs off": {},
  "draft plan + rule 5 | base": ROWS_4,
  "draft plan + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "draft plan + rule 5 | on vs off": {},
  "malformed measures (entry without fields) | base": ROWS_4,
  "malformed measures (entry without fields) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "malformed measures (entry without fields) | on vs off": {},
  "malformed measures + rule 5 | base": ROWS_4,
  "malformed measures + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "malformed measures + rule 5 | on vs off": {},
  "unknown measure id in measure_ids | base": ROWS_4,
  "unknown measure id in measure_ids | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "unknown measure id in measure_ids | on vs off": {},
  "unknown target_measure + claim_id mismatch + rule 5 | base": ROWS_4,
  "unknown target_measure + claim_id mismatch + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "unknown target_measure + claim_id mismatch + rule 5 | on vs off": {},
  "empty claim_id string (draft) | base": ROWS_4,
  "empty claim_id string (draft) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "empty claim_id string (draft) | on vs off": {},
  "empty claim_id + rule 5 | base": ROWS_4,
  "empty claim_id + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "empty claim_id + rule 5 | on vs off": {},
  "legacy declaration (reader_task sequence, no claim_spec) + rule 5 | base": ROWS_4,
  "legacy declaration (reader_task sequence, no claim_spec) + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "legacy declaration (reader_task sequence, no claim_spec) + rule 5 | on vs off": {},
  "draft with a claim_spec id that differs | base": ROWS_4,
  "draft with a claim_spec id that differs | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "draft with a claim_spec id that differs | on vs off": {},
  "incompatible grammar + rule 5 | base": ROWS_4,
  "incompatible grammar + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "incompatible grammar + rule 5 | on vs off": {},
  "map defaults: cartographic_flow_map with missing fields | base": ROWS_4,
  "map defaults: cartographic_flow_map with missing fields | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "map defaults: cartographic_flow_map with missing fields | on vs off": {},
  "map defaults + sql write | base": ROWS_4,
  "map defaults + sql write | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "map defaults + sql write | on vs off": {},
  "map defaults + declaration required + story binding | base": ROWS_4,
  "map defaults + declaration required + story binding | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "map defaults + declaration required + story binding | on vs off": {},
  "story node ids empty array | base": ROWS_4,
  "story node ids empty array | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "story node ids empty array | on vs off": {},
  "story graph ref outside the story-graph folder | base": ROWS_4,
  "story graph ref outside the story-graph folder | off vs base": { onlyInA: ROWS_11, onlyInB: ROWS_6 },
  "story graph ref outside the story-graph folder | on vs off": {},
  "story graph malformed json | base": ROWS_4,
  "story graph malformed json | off vs base": { onlyInA: ROWS_7, onlyInB: ROWS_6 },
  "story graph malformed json | on vs off": {},
  "story graph without nodes + rule 5 | base": ROWS_4,
  "story graph without nodes + rule 5 | off vs base": { onlyInA: ROWS_7, onlyInB: ROWS_6 },
  "story graph without nodes + rule 5 | on vs off": {},
  "scatter without declarations (K110 off) | base": ROWS_1,
  "scatter without declarations (K110 off) | off vs base": { onlyInA: ROWS_2, onlyInB: ROWS_3 },
  "scatter without declarations (K110 off) | on vs off": {},
  "scatter without declarations (K110 on) | base": ROWS_4,
  "scatter without declarations (K110 on) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter without declarations (K110 on) | on vs off": {},
  "scatter, declared, one measure only (K110 off) | base": ROWS_1,
  "scatter, declared, one measure only (K110 off) | off vs base": { onlyInA: ROWS_2, onlyInB: ROWS_3 },
  "scatter, declared, one measure only (K110 off) | on vs off": {},
  "scatter, declared, one measure only (K110 on) | base": ROWS_4,
  "scatter, declared, one measure only (K110 on) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter, declared, one measure only (K110 on) | on vs off": {},
  "scatter, two measures on one field (K110 off) | base": ROWS_1,
  "scatter, two measures on one field (K110 off) | off vs base": { onlyInA: ROWS_2, onlyInB: ROWS_3 },
  "scatter, two measures on one field (K110 off) | on vs off": {},
  "scatter, two measures on one field (K110 on) | base": ROWS_4,
  "scatter, two measures on one field (K110 on) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter, two measures on one field (K110 on) | on vs off": {},
  "scatter, missing y axis (K110 off) | base": ROWS_4,
  "scatter, missing y axis (K110 off) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter, missing y axis (K110 off) | on vs off": {},
  "scatter, missing y axis (K110 on) | base": ROWS_4,
  "scatter, missing y axis (K110 on) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter, missing y axis (K110 on) | on vs off": {},
  "scatter, claim_id mismatch (K110 off) | base": ROWS_4,
  "scatter, claim_id mismatch (K110 off) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter, claim_id mismatch (K110 off) | on vs off": {},
  "scatter, claim_id mismatch (K110 on) | base": ROWS_4,
  "scatter, claim_id mismatch (K110 on) | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "scatter, claim_id mismatch (K110 on) | on vs off": {},
  "aborted signal + rule 5 | base": ROWS_4,
  "aborted signal + rule 5 | off vs base": { onlyInA: ROWS_5, onlyInB: ROWS_6 },
  "aborted signal + rule 5 | on vs off": {},
  "inline: valid | base": ROWS_12,
  "inline: valid | off vs base": { onlyInA: ROWS_13, onlyInB: ROWS_14 },
  "inline: valid | on vs off": {},
  "inline: valid preparation, then rule 5 | base": ROWS_15,
  "inline: valid preparation, then rule 5 | off vs base": { onlyInA: ROWS_16, onlyInB: ROWS_17 },
  "inline: valid preparation, then rule 5 | on vs off": {},
  "inline: valid preparation, then story binding + rule 5 | base": ROWS_15,
  "inline: valid preparation, then story binding + rule 5 | off vs base": { onlyInA: ROWS_16, onlyInB: ROWS_17 },
  "inline: valid preparation, then story binding + rule 5 | on vs off": {},
  "inline: valid preparation, then declaration required | base": ROWS_15,
  "inline: valid preparation, then declaration required | off vs base": { onlyInA: ROWS_16, onlyInB: ROWS_17 },
  "inline: valid preparation, then declaration required | on vs off": {},
  "inline: template with typed digits refused in preparation | base": ROWS_18,
  "inline: template with typed digits refused in preparation | off vs base": { onlyInA: ROWS_19, onlyInB: ROWS_20 },
  "inline: template with typed digits refused in preparation | on vs off": {},
  "inline: no source evidence refused in preparation | base": ROWS_21,
  "inline: no source evidence refused in preparation | off vs base": { onlyInA: ROWS_22, onlyInB: ROWS_23 },
  "inline: no source evidence refused in preparation | on vs off": {},
  "inline: claim and claim_id together | base": ROWS_4,
  "inline: claim and claim_id together | off vs base": { onlyInA: ROWS_24, onlyInB: ROWS_6 },
  "inline: claim and claim_id together | on vs off": {},
  "inline: claim_kind without claim | base": ROWS_4,
  "inline: claim_kind without claim | off vs base": { onlyInA: ROWS_24, onlyInB: ROWS_6 },
  "inline: claim_kind without claim | on vs off": {},
  "inline: claim_spec with the claim id of its own, plus a rule 5 | base": ROWS_15,
  "inline: claim_spec with the claim id of its own, plus a rule 5 | off vs base": { onlyInA: ROWS_16, onlyInB: ROWS_17 },
  "inline: claim_spec with the claim id of its own, plus a rule 5 | on vs off": {},
  "inline: ranking with the runtime's claim id | base": ROWS_12,
  "inline: ranking with the runtime's claim id | off vs base": { onlyInA: ROWS_13, onlyInB: ROWS_14 },
  "inline: ranking with the runtime's claim id | on vs off": {},
  "inline: ranking with an unknown target_measure and rule 5 | base": ROWS_15,
  "inline: ranking with an unknown target_measure and rule 5 | off vs base": { onlyInA: ROWS_16, onlyInB: ROWS_17 },
  "inline: ranking with an unknown target_measure and rule 5 | on vs off": {},
  "inline: the same plan twice (the claim is reused) | base": ROWS_12,
  "inline: the same plan twice (the claim is reused) | off vs base": { onlyInA: ROWS_13, onlyInB: ROWS_14 },
  "inline: the same plan twice (the claim is reused) | on vs off": {},
  "chain rule 5 | base": ROWS_4,
  "chain rule 5 | off vs base": { onlyInA: ROWS_25, onlyInB: ROWS_6 },
  "chain rule 5 | on vs off": {},
  "chain story binding + rule 5 | base": ROWS_4,
  "chain story binding + rule 5 | off vs base": { onlyInA: ROWS_25, onlyInB: ROWS_6 },
  "chain story binding + rule 5 | on vs off": {},
  "chain sql write + rule 5 | base": ROWS_4,
  "chain sql write + rule 5 | off vs base": { onlyInA: ROWS_25, onlyInB: ROWS_6 },
  "chain sql write + rule 5 | on vs off": {},
  "chain rule 4 + rule 5 | base": ROWS_4,
  "chain rule 4 + rule 5 | off vs base": { onlyInA: ROWS_25, onlyInB: ROWS_6 },
  "chain rule 4 + rule 5 | on vs off": {},
  "chain valid | base": ROWS_26,
  "chain valid | off vs base": { onlyInA: ROWS_27, onlyInB: ROWS_28 },
  "chain valid | on vs off": {},
  "chain inline + rule 5 | base": ROWS_15,
  "chain inline + rule 5 | off vs base": { onlyInA: ROWS_29, onlyInB: ROWS_17 },
  "chain inline + rule 5 | on vs off": {},
};
const rowsAt = (label) => { if (!(label in ROWS_AT)) { throw new Error(`no call-report rows stated for: ${label}`); } return callRows(ROWS_AT[label]); };
const deltaAt = (label) => { if (!(label in ROWS_AT)) { throw new Error(`no call-report rows stated for: ${label}`); } const { onlyInA = [], onlyInB = [] } = ROWS_AT[label]; return { onlyInA: callRows(onlyInA), onlyInB: callRows(onlyInB) }; };
const base = await load(COPY_BASE, {});
const off = await load(COPY_HEAD, {});
const on = off; // the switch is read when the tool runs, so one registration serves both
const CHAIN_ENV = { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1" };
const baseChain = await load(COPY_BASE, CHAIN_ENV);
const headChain = await load(COPY_HEAD, CHAIN_ENV);
let refused = 0, accepted = 0, multi = 0, traced = 0;
// One differential: verdict, first error (text, class, code), side-effect trace (the files each variant wrote, with their normalized content), and for acceptance the written plan.
async function differential(name, params, { sets = { base, head: off }, ...opts } = {}) {
  const b = await run(sets.base, params, undefined, opts);
  const o = await run(sets.head, params, undefined, opts);
  const r = await run(sets.head, params, "1", opts);
  assert.equal(o.ok, b.ok, `${name}: switch off verdict differs from ${BASELINE_REF}`);
  assert.equal(r.ok, b.ok, `${name}: switch on verdict differs from ${BASELINE_REF}`);
  // same preparation effects as the old code: the same files with the same content, accepted or refused (the inline path queries and may write query-rows)
  for (const [label, x] of [["off", o], ["on", r]]) { assert.deepEqual(x.written, b.written, `${name}: ${label} side effects differ from ${BASELINE_REF}`); traced++; }
  expectRows(b.rows, rowsAt(`${name} | base`), `${name} | base`);
  expectRowsDelta(o.rows, b.rows, deltaAt(`${name} | off vs base`), `${name} | off vs base`);
  expectRowsDelta(r.rows, o.rows, deltaAt(`${name} | on vs off`), `${name} | on vs off`);
  if (b.ok) {
    accepted++;
    assert.equal(o.text, b.text, `${name}: switch off result differs`); assert.equal(r.text, b.text, `${name}: switch on result differs for an accepted call`);
    return { b, o, r };
  }
  refused++;
  assert.equal(o.message, b.message, `${name}: switch off message differs from ${BASELINE_REF}`);
  assert.equal(o.name, b.name); assert.equal(o.code, b.code);
  assert.ok(r.message.startsWith(b.message), `${name}: first problem lost its text.\n baseline: ${b.message.slice(0, 200)}\n on: ${r.message.slice(0, 200)}`);
  assert.equal(r.name, b.name, `${name}: first problem lost its class`); assert.equal(r.code, b.code, `${name}: first problem lost its code`);
  // a refusal records no plan and no claim beyond what the old code wrote
  assert.ok(!r.changed.some((f) => f.startsWith("visualizations/plans/")), `${name}: a refusal wrote a plan`);
  if (!params.claim) assert.deepEqual(r.changed.filter((f) => f === "claims.jsonl"), [], `${name}: a refusal wrote a claim`);
  for (const bad of ["0", "", "true"]) { const x = await run(sets.head, params, bad, opts); assert.equal(x.message, b.message, `${name}: a non-"1" value changed the message`); expectRowsDelta(x.rows, o.rows, {}, `${name} | non-1 value vs off`); }
  if (r.message !== b.message) { multi++; assert.match(r.message, /\nAlso refused in this call \(\d+ more independent problems?; no claim or plan was recorded[^)]*\):\n\(2\) /); }
  console.log(`  ${name}: ${r.message === b.message ? "one problem, same text" : `${r.message.split("\n").length - 2} more listed`}`);
  return { b, o, r };
}
for (const [name, params] of Object.entries(CASES)) await differential(name, params);
// ---- more inputs: malformed declarations, map defaults, K110 on and off, abort, the inline path and the chain ----
const EXTRA = {
  "malformed measures (entry without fields)": { ...ranked, measure_semantics: [{ id: "amt" }] },
  "malformed measures + rule 5": { ...noCategory, ...ranked, category_field: undefined, measure_semantics: [{ id: "amt" }] },
  "unknown measure id in measure_ids": { ...ranked, claim_spec: { ...ranked.claim_spec, measure_ids: ["nope"] } },
  "unknown target_measure + claim_id mismatch + rule 5": { ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, target_measure: "zz", claim_id: "other" } },
  "empty claim_id string (draft)": { ...good, claim_id: "" },
  "empty claim_id + rule 5": { ...noCategory, claim_id: "" },
  "legacy declaration (reader_task sequence, no claim_spec) + rule 5": { ...noCategory, reader_task: "sequence" },
  "draft with a claim_spec id that differs": { ...ranked, claim_id: undefined, claim_spec: { ...ranked.claim_spec, claim_id: "other" } },
  "incompatible grammar + rule 5": { ...ranked, chart_type: "line", x_field: "region", category_field: undefined },
  "map defaults: cartographic_flow_map with missing fields": { ...good, chart_type: "cartographic_flow_map" },
  "map defaults + sql write": { ...good, chart_type: "cartographic_flow_map", sql: "DELETE FROM x" },
  "map defaults + declaration required + story binding": { ...good, chart_type: "cartographic_flow_map", reader_task: "ranking", ...module_ },
  "story node ids empty array": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/ok.json", story_node_ids: [] },
  "story graph ref outside the story-graph folder": { ...noCategory, ...module_, story_graph_ref: "../claims.jsonl", story_node_ids: ["n1"] },
  "story graph malformed json": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/bad.json", story_node_ids: ["n1"] },
  "story graph without nodes + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/nonodes.json", story_node_ids: ["n1"] },
};
writeFileSync(join(art, "editorial/story-graphs/bad.json"), "{not json");
writeFileSync(join(art, "editorial/story-graphs/nonodes.json"), JSON.stringify({ passed: true }));
for (const [name, params] of Object.entries(EXTRA)) await differential(name, params);
// K110: a scatter pairing, switch on and off, with declarations missing, unpaired and paired, and a missing axis
const scatter = { ...good, chart_type: "scatter", category_field: undefined, x_field: "amount", y_field: "amount", reader_task: "relationship" };
const K110 = { NEWSROOM_SCATTER_PAIRED_MEASURES: "1" };
const scatterMs = [{ ...ms[0], id: "xm", field: "amount" }, { ...ms[0], id: "ym", field: "amount" }];
const scatterSpec = { relation: "relationship", reader_task: "relationship", target_measure: "ym", measure_ids: ["xm", "ym"], claim_id: claimId };
const SCATTERS = {
  "scatter without declarations": scatter,
  "scatter, declared, one measure only": { ...scatter, measure_semantics: [scatterMs[0]], claim_spec: { ...scatterSpec, measure_ids: ["xm"], target_measure: "xm" } },
  "scatter, two measures on one field": { ...scatter, measure_semantics: scatterMs, claim_spec: scatterSpec },
  "scatter, missing y axis": { ...scatter, y_field: undefined, measure_semantics: scatterMs, claim_spec: scatterSpec },
  "scatter, claim_id mismatch": { ...scatter, measure_semantics: scatterMs, claim_spec: { ...scatterSpec, claim_id: "other" } },
};
for (const [name, params] of Object.entries(SCATTERS)) for (const [label, env] of [["K110 off", {}], ["K110 on", K110]]) await differential(`${name} (${label})`, params, { env });
// a cancelled call: the first problem is rethrown as it was (an abort is not listed as a validation message)
{
  const ac = new AbortController(); ac.abort();
  const { r } = await differential("aborted signal + rule 5", noCategory, { signal: ac.signal });
  assert.ok(!/Also refused/.test(r.message), "an aborted call listed more problems");
}
// a cancel in the middle of collection: the abort rethrows at once and replaces the earlier collected error (current behaviour, not a validation message)
{
  const sqlAndRule5 = { ...noCategory, sql: "DELETE FROM x" };
  const first = (await run(off, sqlAndRule5, "1")).message;
  assert.match(first, /\nAlso refused in this call/, "the fixture must collect two problems without an abort");
  let reads = 0;
  const lateAbort = { get aborted() { reads++; return reads > 1; } }; // clean on the first check, aborted when the second failure is kept
  const r = await run(off, sqlAndRule5, "1", { signal: lateAbort });
  assert.equal(r.ok, false);
  assert.ok(!/Also refused/.test(r.message), "an abort in the middle still listed the earlier problem");
  assert.notEqual(r.message, first.split("\nAlso refused")[0], "the abort did not replace the earlier collected error");
}
// the inline claim path: the preparation (query, claim text) runs once, before the checks, as before; the claim and plan are recorded only after every check passed
const TEMPLATE = "Region {max.amount.region} has the largest amount at {max.amount} units and {min.amount.region} the smallest at {min.amount} units.";
const { claim_id: _drop, takeaway: _t, alt: _a, ...inlineBase } = good;
const inline = { ...inlineBase, claim: TEMPLATE, claim_kind: "comparative" };
const INLINE_CASES = {
  "inline: valid": inline,
  "inline: valid preparation, then rule 5": { ...inline, category_field: undefined },
  "inline: valid preparation, then story binding + rule 5": { ...inline, category_field: undefined, ...module_ },
  "inline: valid preparation, then declaration required": { ...inline, reader_task: "ranking" },
  "inline: template with typed digits refused in preparation": { ...inline, claim: "Region n has 9 units." },
  "inline: no source evidence refused in preparation": { ...inline, sql: "SELECT 'n' AS region, 4 AS amount" },
  "inline: claim and claim_id together": { ...inline, claim_id: claimId },
  "inline: claim_kind without claim": { ...good, claim_kind: "comparative" },
  "inline: claim_spec with the claim id of its own, plus a rule 5": { ...inline, category_field: undefined, ranked: undefined, claim_spec: { relation: "rank", reader_task: "ranking", claim_id: "x" } },
  "inline: ranking with the runtime's claim id": { ...inline, reader_task: "ranking", measure_semantics: ms, claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "amt", measure_ids: ["amt"] } },
  "inline: ranking with an unknown target_measure and rule 5": { ...inline, category_field: undefined, reader_task: "ranking", measure_semantics: ms, claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "amount", measure_ids: ["amt"] } },
};
// INLINE_CLAIM on with an existing claim_id: alt and source_note stay required (validateVizSpec), on every arm
for (const [name, params] of Object.entries({ "inline on, claim_id given, no alt": { ...good, alt: undefined }, "inline on, claim_id given, no source_note": { ...good, source_note: undefined } })) {
  const o = await run(headChain, params, undefined, { env: CHAIN_ENV }), r = await run(headChain, params, "1", { env: CHAIN_ENV });
  assert.equal(o.ok, false, `${name}: accepted`); assert.equal(r.ok, false, `${name}: accepted with the list-all switch`);
  assert.deepEqual(r.changed.filter((f) => /plans?\//.test(f)), [], `${name}: a plan was written`);
}
for (const [name, params] of Object.entries(INLINE_CASES)) await differential(name, params, { sets: { base: baseChain, head: headChain }, env: CHAIN_ENV });
// a duplicate claim is reused: the second call of the same inline plan gives the same verdict and the same files as the old code
await differential("inline: the same plan twice (the claim is reused)", inline, { sets: { base: baseChain, head: headChain }, env: CHAIN_ENV, times: 2 });
// the chain: the same refusals reach the model through newsroom_viz_chain's plan step; the chain stops there, nothing later runs
{
  const stopMessage = (text) => /\(STEP_ERROR\): ([\s\S]*?)\nCompleted steps:/.exec(text)?.[1];
  for (const [name, params, fixed] of [["rule 5", noCategory], ["story binding + rule 5", { ...noCategory, ...module_ }], ["sql write + rule 5", { ...noCategory, sql: "DELETE FROM x" }], ["rule 4 + rule 5", CASES["rule 4 + rule 5"]], ["valid", good], ["inline + rule 5", { ...inline, category_field: undefined }]]) {
    const b = await run(baseChain, params, undefined, { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
    const o = await run(headChain, params, undefined, { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
    const r = await run(headChain, params, "1", { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
    assert.equal(o.ok, b.ok, `chain ${name}: off verdict`); assert.equal(r.ok, b.ok, `chain ${name}: on verdict`);
    // the baseline predates the review split: a chain that runs the draw step differs from it only in where the render-QA record lives (the critic's, not the draw step's),
    // so for those the render-QA line and the qa/critic/manifest files are the layout and are left out of the comparison; every runtime file but the one named in LAYOUT_RUNTIME is still compared,
    // and the call rows are compared against the delta pinned in ROWS_AT
    const complete = b.ok && /COMPLETE/.test(b.text);
    const qaLine = (t) => t.replace(/Render QA: PASS \([^)]*\)/g, "Render QA: PASS (<where>)");
    const LAYOUT_RUNTIME = ["runtime/tool-chain-events.jsonl"]; // the chain's event log carries the step text, which names the render-QA line
    const sameLayout = (w) => Object.fromEntries(Object.entries(w).filter(([f]) => !/^visualizations\/(qa\/|critics\/|[0-9a-f]{64}\.json$)/.test(f) && !LAYOUT_RUNTIME.includes(f)));
    if (b.ok) { assert.equal(complete ? qaLine(o.text) : o.text, complete ? qaLine(b.text) : b.text, `chain ${name}: off text`); if (/STOPPED/.test(b.text)) { const first = stopMessage(b.text); assert.ok(first, `chain ${name}: stop message found`); assert.ok(r.text.includes(first), `chain ${name}: first problem lost`); assert.equal(stopMessage(o.text), first); } }
    assert.deepEqual(complete ? sameLayout(o.written) : o.written, complete ? sameLayout(b.written) : b.written, `chain ${name}: off side effects`);
    expectRows(b.rows, rowsAt(`chain ${name} | base`), `chain ${name} | base`);
    expectRowsDelta(o.rows, b.rows, deltaAt(`chain ${name} | off vs base`), `chain ${name} | off vs base`);
    expectRowsDelta(r.rows, o.rows, deltaAt(`chain ${name} | on vs off`), `chain ${name} | on vs off`);
    // the chain's own event log records the plan step's error text, which is the longer list when the switch is on; every other file is the same
    const { "runtime/tool-chain-events.jsonl": logOn, ...writtenOn } = r.written, { "runtime/tool-chain-events.jsonl": logBase, ...writtenBase } = b.written;
    assert.deepEqual(complete ? sameLayout(writtenOn) : writtenOn, complete ? sameLayout(writtenBase) : writtenBase, `chain ${name}: on side effects`); assert.equal(Boolean(logOn), Boolean(logBase), `chain ${name}: event log presence`);
    if (b.ok && /STOPPED/.test(b.text)) assert.ok(!/## newsroom_viz_lint/.test(r.text), `chain ${name}: a step after the plan ran`);
    traced += 2;
  }
}
// the review split is always on: the draw step reports render QA as the critic's job and its manifest carries no render-QA record
{
  const split = await run(headChain, good, undefined, { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
  assert.ok(split.ok, "the valid chain ran");
  assert.ok(split.text.includes("Render QA: PASS (in memory; viz_critic records it)"), `the render-QA line names the critic:\n${split.text}`);
  assert.ok(!/Render QA: PASS \(visualizations\/qa\//.test(split.text), "the old-layout render-QA line is back");
  const manifests = Object.entries(split.written).filter(([f]) => /^visualizations\/[^/]+\.json$/.test(f));
  assert.ok(manifests.length > 0, "the draw step wrote a manifest");
  for (const [f, text] of manifests) assert.ok(!/"render_qa(_ref)?"/.test(text), `${f} carries a render-QA record`);
  traced++;
}
// the cases the switch exists for must list more than one problem, and the ones whose checks depend on each other must not
const msg = async (name) => (await run(on, CASES[name], "1")).message ?? "";
assert.match(await msg("rule 2 + rule 5"), /INFOGRAPHIC_MODULE_BINDING_REQUIRED[\s\S]*\(2\) Invalid visualization plan: .*category_field/);
assert.match(await msg("unreadable story graph + rule 5"), /\(2\) Invalid visualization plan: .*category_field/);
assert.match(await msg("sql write + rule 5"), /\(2\) Invalid visualization plan:/);
assert.match(await msg("declaration required + story binding + rule 5"), /SEMANTIC_DECLARATION_REQUIRED|INFOGRAPHIC_MODULE_BINDING_REQUIRED/);
assert.match(await msg("rule 3 + rule 5"), /\(2\) Invalid visualization plan:/);
assert.match(await msg("rule 4 + rule 5"), /claim_spec\.claim_id[\s\S]*\(2\) Invalid visualization plan:/);
// dependent checks are skipped when the check they read failed: no claim_id compare after a declaration or target_measure failure
assert.ok(!/claim_spec\.claim_id/.test(await msg("rule 3 + rule 5")), "claim_id compare ran although the semantic gate failed");
assert.ok(!/claim_spec\.claim_id/.test(await msg("declaration required + rule 5")), "claim_id compare ran although the declaration was missing");
// the claim lookup runs last: an unknown claim_id is listed only when nothing else is wrong
assert.ok(!/\(2\)/.test(await msg("unknown claim_id + rule 5 (lookup comes last)")), "the claim lookup was listed with other problems");
assert.ok(multi >= 8, `only ${multi} multi-problem cases`);
console.log(`PASS viz_plan report-all: ${refused} refused and ${accepted} accepted cases agree with ${BASELINE_REF} (off: identical text; on: first problem unchanged, ${multi} list more; ${traced} side-effect traces equal the baseline's; a refusal wrote no plan and no claim)`);

// ---- tool definitions: both switches off = byte-identical to the baseline; RULE_HINTS on = descriptions only; VIZ_REPORT_ALL changes no definition ----
{
  const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
  const defs = async (file, env, profile) => {
    delete process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL;
    const tools = await load(file, { ...env, NEWSROOM_TOOL_PROFILE: profile });
    return new Map([...tools].map(([name, t]) => [name, JSON.stringify(t)]));
  };
  // The baseline's visual-story set, reduced by the approved default change (no Lieflat tools, no "lieflat-charts" skill value).
  const baseOf = async (env, profile) => {
    const parsed = new Map([...(await defs(COPY_BASE, env, profile))].map(([name, text]) => [name, JSON.parse(text)]));
    return new Map([...withoutApprovedIllustration(withoutApprovedLieflat(parsed, profile), { ...process.env, ...env })].map(([name, tool]) => [name, JSON.stringify(tool)]));
  };
  const stripDescriptions = (text) => JSON.stringify(JSON.parse(text), (k, v) => (k === "description" ? undefined : v));
  let tools = 0, changedByHints = new Set();
  // Off differs from the baseline only by the approved description changes listed in the pin list (exact old and new text); the later checks compare with that off state.
  const pins = loadPinPatches("viz_report_all", { baseline: BASELINE_REF });
  const asTools = (m) => new Map([...m].map(([name, text]) => [name, JSON.parse(text)]));
  for (const profile of PROFILES) {
    const baseDefs = await baseOf({}, profile);
    const offDefs = await defs(COPY_HEAD, {}, profile);
    assert.deepEqual([...offDefs.keys()], [...baseDefs.keys()], `${profile}: same tools in the same order`);
    pins.check(asTools(baseDefs), asTools(offDefs), `${profile}: switches off, against ${BASELINE_REF}`);
    tools += baseDefs.size;
    const reportAll = await defs(COPY_HEAD, { NEWSROOM_SPEED_VIZ_REPORT_ALL: "1" }, profile);
    for (const [name, text] of offDefs) assert.equal(reportAll.get(name), text, `${profile}/${name}: VIZ_REPORT_ALL changed a definition`);
    const hints = await defs(COPY_HEAD, { NEWSROOM_SPEED_RULE_HINTS: "1" }, profile);
    for (const [name, text] of offDefs) {
      const now = JSON.parse(hints.get(name)), was = JSON.parse(text), off = JSON.parse(offDefs.get(name));
      assert.deepEqual(JSON.parse(stripDescriptions(hints.get(name))), JSON.parse(stripDescriptions(offDefs.get(name))), `${profile}/${name}: RULE_HINTS on changed more than descriptions (enum, required, min/max)`);
      assert.equal(JSON.stringify(now.promptGuidelines), JSON.stringify(off.promptGuidelines), `${profile}/${name}: RULE_HINTS changed the guidelines`);
      if (hints.get(name) !== text) changedByHints.add(name);
    }
  }
  pins.finish();
  const planDesc = async (env, ...path) => path.reduce((o, k) => o?.[k], (await load(COPY_HEAD, { ...env, NEWSROOM_TOOL_PROFILE: "full" })).get("newsroom_viz_plan").parameters.properties)?.description ?? "";
  const hintsOn = { NEWSROOM_SPEED_RULE_HINTS: "1" };
  assert.ok(!/trend/.test(await planDesc(hintsOn, "claim_spec", "properties", "reader_task")), "the contradictory example is still there with RULE_HINTS on");
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "reader_task"), /part_to_whole/);
  assert.match(await planDesc({}, "claim_spec", "properties", "reader_task"), /trend/, "off keeps the old text");
  assert.match(await planDesc(hintsOn, "story_graph_ref"), /infographic_module/);
  assert.match(await planDesc(hintsOn, "story_node_ids"), /infographic_module/);
  assert.match(await planDesc(hintsOn, "story_graph_ref"), /passed narrative closure/);
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "target_measure"), /Optional\. When given.*measure_semantics\[\]\.id/);
  assert.ok(!/field name/.test(await planDesc(hintsOn, "claim_spec", "properties", "target_measure")), "a valid measure id may be spelled like a field");
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "claim_id"), /claim_spec is declared and the plan is verified.*present and equal to claim_id.*draft plan it is compared only when both/);
  assert.match(await planDesc(hintsOn, "category_field"), /present and nonempty/);
  const bindingHint = await planDesc(hintsOn, "claim_id");
  assert.match(bindingHint, /shared compatible evidence/); assert.match(bindingHint, /permitted computation relation/); assert.match(bindingHint, /no CTE, JOIN/); assert.ok(!/same hashes/.test(bindingHint)); assert.match(bindingHint, /read_json\('computations/); assert.match(bindingHint, /never reword the claim/);
  const enumText = await planDesc(hintsOn, "claim_spec", "properties", "reader_task");
  assert.ok(!/…|\.\.\./.test(enumText), "the enum is written out in full");
  for (const v of (await load(COPY_HEAD, { NEWSROOM_TOOL_PROFILE: "full" })).get("newsroom_viz_plan").parameters.properties.reader_task.enum) assert.ok(enumText.includes(v), `${v} missing from the written-out enum`);
  console.log(`PASS tool definitions: ${tools} definitions over ${PROFILES.length} profiles are byte-identical to ${BASELINE_REF} with the switches off and with VIZ_REPORT_ALL on; RULE_HINTS on changes only descriptions (${[...changedByHints].join(", ")}), and the claim_spec.reader_task example no longer lists a value outside the enum`);
}
