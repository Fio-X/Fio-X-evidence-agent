// Shared harness for the claim-binding and shadow-check tests: loads the real
// runtime/pi/newsroom.ts (types stripped, Pi packages stubbed) from a temporary
// copy of runtime/, registers its tools through a Proxy `pi`, and gives the
// caller a fresh artifact directory with a verified claim to hang charts on.
// Real DuckDB runs the SQL (NEWSROOM_DUCKDB_BIN, default `duckdb`).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// `newsroomSource` lets a test load another revision of newsroom.ts (for the
// byte-for-byte comparison against the baseline) next to the working copy.
export async function loadNewsroom({ prefix = "precision-", newsroomSource, env = {}, dirs = [] } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(REPO, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(REPO, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  const source = newsroomSource ?? readFileSync(join(pi, "newsroom.ts"), "utf8");
  const copy = join(pi, "newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(source, { mode: "strip" }));
  const art = join(tmp, "artifact");
  for (const dir of ["data", "sources", "computations", "runtime/query-rows", "visualizations/plans", "visualizations/lints", "infographics/plans", ...dirs]) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(REPO, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: extension } = await import(`${pathToFileURL(copy).href}?v=${Math.random()}`);
  extension(piApi);

  const addData = (name, text) => {
    const bytes = Buffer.from(text);
    const ref = `data/${sha256(bytes)}.csv`;
    writeFileSync(join(art, ref), bytes);
    writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ file: ref, sha256: sha256(bytes), bytes: bytes.length, label: name }));
    return ref;
  };
  const query = async (sql) => relative(art, (await tools.get("duckdb_query").execute("q", { sql })).details.path);
  const claimsOnDisk = () => {
    try { return readFileSync(join(art, "claims.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  };
  const recordClaim = async (claim, sourceRefs, computationRefs) => {
    await tools.get("record_claim").execute("c", { claim, claim_kind: "quantitative", status: "supported", source_refs: sourceRefs, computation_refs: computationRefs });
    return claimsOnDisk().at(-1);
  };
  return { tmp, art, pi, tools, addData, query, recordClaim, claimsOnDisk };
}
