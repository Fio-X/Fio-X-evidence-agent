// The claims step over a fixture file, for tests of what comes after it (a fixture has no run, so its claims come from here). The file is
// kept to the rows a fetch key would return (--where) and narrowed by the data step's own rule (--narrow: newsroom_data_prepare's narrow
// arguments); then the knowledge group's programCandidates offers the conclusions and registerPicks registers the fixed picks (a stand-in
// reply) through the runtime's own duckdb_query and record_claim, as newsroom_data_prepare does. Out: a run folder whose claims.jsonl holds
// the claims with their claim_bindings. Nothing here writes a claim, a number or a year.
// Usage: node scripts/claims_step_fixture.mjs <file.csv> --picks c1,c2,c3 [--where dim=code]... [--narrow dim:n[:total[:code,code...]]] [--provider eurostat]
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cell = (value) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };

let loaded;
// The runtime as test_claim_candidates.mjs loads it: a copy with its two type-only packages stubbed, newsroom.ts stripped of types.
async function runtime() {
  if (loaded) return loaded;
  const tmp = makeTestTmp("claims-step-");
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const mod = await import(join(pi, "newsroom.test-copy.mjs"));
  const cand = await import(join(pi, "claim_candidates.mjs"));
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  loaded = { mod, cand, tools };
  return loaded;
}

/**
 * `csv`: the fixture file's path. `where`: { dim: code } kept as a fetch key would. `narrow`: { dimension, n, total?, exclude } as
 * newsroom_data_prepare takes it. `picks`: the candidate ids to register. `dimensions`: the key's dimensions, by default the SDMX-CSV
 * columns between LAST UPDATE and TIME_PERIOD. Returns { art, ref, cut, conclusions, dropped, outcome, claims } (claims read back from
 * the run's claims.jsonl) or { art, ref, stop } when the step stops before the picks.
 */
export async function claimsFromFixture({ csv, where = {}, narrow, picks, provider = "eurostat", dimensions, time = "TIME_PERIOD", measure = "OBS_VALUE" }) {
  process.env.NEWSROOM_NEXT = "1";
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  const { mod, cand, tools } = await runtime();
  const dp = mod.__dataPrepareForTest;
  const parsed = dp.parseCsvText(readFileSync(csv, "utf8"));
  const header = parsed[0];
  const columnAt = new Map(header.map((name, i) => [name, i]));
  for (const name of Object.keys(where)) if (!columnAt.has(name)) throw new Error(`--where ${name}: not a column of ${csv}`);
  let rows = [header, ...parsed.slice(1).filter((row) => Object.entries(where).every(([d, c]) => row[columnAt.get(d)] === c))];
  let cut;
  if (narrow) {
    const { total, members } = dp.narrowMembers(rows, columnAt, time, measure, narrow);
    const keep = new Set([...members, ...(total ? [total] : [])]);
    rows = [header, ...rows.slice(1).filter((row) => keep.has(row[columnAt.get(narrow.dimension)]))];
    cut = { members, total };
  }
  const art = join(makeTestTmp("claims-step-run-"), "run");
  for (const dir of ["data", "computations", "sources", "runtime/query-rows", "shadow"]) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const text = rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
  const ref = `data/${sha(text)}.csv`;
  writeFileSync(join(art, ref), text);
  writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ schema_version: "0.7.0", bytes: Buffer.byteLength(text), sha256: sha(text), file: ref }, null, 2) + "\n");

  const keyDims = dimensions ?? header.slice(header.indexOf("LAST UPDATE") + 1, header.indexOf(time));
  const roles = cand.detectRoles({ header, rows: rows.slice(1), dimensions: keyDims, time, measure, qualifiers: dp.dataPrepareQualifiers(provider), emptyStop: true });
  if (!roles.ok) return { art, ref, stop: roles.problem };
  const runSql = async (sql) => {
    const r = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["-json", ":memory:", "-c", sql], { cwd: art, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`DUCKDB_QUERY_FAILED: ${String(r.stderr).split("\n")[0]}`);
    return JSON.parse(r.stdout.trim() || "[]");
  };
  const fill = (template, rowsIn) => cand.fillCandidate(template, rowsIn);
  const made = await cand.programCandidates({ ref, dimensions: roles.dimensions, measure: roles.measure, time: roles.time, times: roles.times, runSql, fill, seriesMaxRows: dp.maxChartRows, entity: dp.nextEntityAlias({ provider, header, rows: rows.slice(1), ...(cut ? { cut } : {}) }, roles.dimensions), ...(cut ? { cut } : {}) });
  if (made.narrowing) return { art, ref, cut, stop: made.narrowing };
  let n = 0;
  const outcome = await cand.registerPicks({
    conclusions: made.conclusions,
    picks,
    sourceRef: ref,
    runSql,
    fill,
    query: async (sql) => {
      const q = await tools.get("duckdb_query").execute(`fixture-q${(n += 1)}`, { sql });
      const body = JSON.parse(String(q.content?.[0]?.text ?? "{}"));
      return { ref: body.artifact ?? body.artifact_ref ?? relative(art, q.details.path ?? q.details.artifact), rows: body.rows ?? body.preview_rows };
    },
    record: async (claimParams, filled) => {
      const extra = filled ? dp.pickedClaimBindings(claimParams.claim, filled) : undefined;
      const rec = await tools.get("record_claim").execute(`fixture-c${(n += 1)}`, claimParams, undefined, undefined, undefined, extra ? { claimRecordExtra: extra } : {});
      return { claim_id: rec.details?.claimId ?? null, verified: rec.details?.verification?.publishable === true };
    },
  });
  const file = join(art, "claims.jsonl");
  const claims = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { art, ref, cut, conclusions: made.conclusions.map(({ id, kind, text: t }) => ({ id, kind, text: t })), dropped: made.dropped, outcome, claims };
}

function args(argv) {
  const out = { csv: argv[0], where: {} };
  for (let i = 1; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--picks") out.picks = value.split(",");
    else if (flag === "--where") { const [d, c] = value.split("="); out.where[d] = c; }
    else if (flag === "--narrow") { const [dimension, n, total, exclude] = value.split(":"); out.narrow = { dimension, n: Number(n), ...(total ? { total } : {}), exclude: exclude ? exclude.split(",") : [] }; }
    else if (flag === "--provider") out.provider = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!out.csv || !out.picks) throw new Error("usage: claims_step_fixture.mjs <file.csv> --picks c1,c2,c3 [--where dim=code]... [--narrow dim:n[:total[:codes]]]");
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const got = await claimsFromFixture(args(process.argv.slice(2)));
  console.log(JSON.stringify({ ...got, claims: got.claims?.map((c) => ({ claim_id: c.claim_id, claim: c.claim, claim_bindings: c.claim_bindings })) }, null, 2));
}
