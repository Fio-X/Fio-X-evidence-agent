// Candidate conclusions for the new route (knowledge group; pure and dependency-injected, nothing here is wired into a tool yet).
// The program, not the model, decides which fixed templates apply to a prepared data file (ranking, gap, share, change). Each candidate is a claim template
// (every number, years included, is a placeholder) plus one SQL that reads the data file itself and selects every column the template uses. The program runs
// that SQL (injected `runSql`) and fills the template with the runtime's own filler (injected `fill`), so the sentence on the sheet takes its numbers from
// the rows DuckDB returned and this module does no arithmetic. The model only picks literal candidate ids. Only picked candidates are handed to the claim
// registrar, and the registrar (the runtime's own claim path) alone decides VERIFIED. A candidate is text, never evidence: the sheet shown to the model is a
// side file under shadow/ (observation kind, owned by the knowledge group), written once and never read back, and the claim path's reference rules (sources/
// or data/ for sources, computations/ for computations) cannot name it.
import { createHash } from "node:crypto";

export const SHEET_PREFIX = "shadow/candidate_sheet-";
export const PICK_MIN = 3;
export const PICK_MAX = 5;
export const STOP_REASONS = Object.freeze(["claim_replay_failed", "data_failed", "no_candidates"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATA_REF = /^data\/[A-Za-z0-9._-]+$/;

const quote = (name) => {
  if (!IDENT.test(String(name))) throw new Error(`candidate column name is not a plain identifier: ${String(name).slice(0, 40)}`);
  return `"${name}"`;
};
// Words of a template come from a column name only when they hold no digit (a digit in a template is a typed number).
const label = (name) => (/^[A-Za-z_]+$/.test(name) ? name.replace(/_/g, " ") : "value");

/**
 * The candidate specs for a prepared data file: { ref: "data/<file>", dimension, measure, time? } (column names only; no rows are read here).
 * Returns [{ kind, claim_kind, sql, template }]. Which specs exist depends only on whether a time column is given. Same input, same specs, same order.
 */
export function buildCandidates(spec) {
  const { ref, dimension, measure, time } = spec ?? {};
  if (!DATA_REF.test(String(ref))) throw new Error(`candidate data reference must be a data/ file name: ${String(ref).slice(0, 60)}`);
  const d = quote(dimension);
  const m = quote(measure);
  const t = time ? quote(time) : null;
  const src = `'${ref}'`;
  const word = label(measure);
  const latest = t ? `(SELECT MAX(${t}) FROM ${src})` : null;
  const earliest = t ? `(SELECT MIN(${t}) FROM ${src})` : null;
  const at = (point) => (t ? ` WHERE ${t} = ${point}` : "");
  const yearSel = t ? `, ${t} AS year` : "";
  const inYear = t ? " in {first.year}" : "";
  const out = [];
  const add = (kind, claim_kind, sql, template) => out.push({ kind, claim_kind, sql, template });
  add("rank_top", "comparative", `SELECT ${d} AS name, ${m} AS value${yearSel} FROM ${src}${at(latest)} ORDER BY ${m} DESC, ${d} LIMIT 1`, `{first.name} has the highest ${word}${inYear}: {first.value}.`);
  add("rank_bottom", "comparative", `SELECT ${d} AS name, ${m} AS value${yearSel} FROM ${src}${at(latest)} ORDER BY ${m} ASC, ${d} LIMIT 1`, `{first.name} has the lowest ${word}${inYear}: {first.value}.`);
  add("extreme_gap", "quantitative", `SELECT MAX(${m}) - MIN(${m}) AS gap${t ? `, MAX(${t}) AS year` : ""} FROM ${src}${at(latest)}`, `The gap between the highest and the lowest ${word}${inYear} is {first.gap}.`);
  add("top_to_bottom_ratio", "quantitative", `SELECT ROUND(MAX(${m}) / NULLIF(MIN(${m}), 0), 1) AS ratio${t ? `, MAX(${t}) AS year` : ""} FROM ${src}${at(latest)}`, `The highest ${word}${inYear} is {first.ratio} times the lowest.`);
  add("share_of_total", "quantitative", `SELECT ${d} AS name, ROUND(${m} / NULLIF((SELECT SUM(${m}) FROM ${src}${at(latest)}), 0) * 100, 1) AS share${yearSel} FROM ${src}${at(latest)} ORDER BY ${m} DESC, ${d} LIMIT 1`, `{first.name} accounts for {first.share} percent of the total${inYear}.`);
  if (t) {
    const move = (dir) => `SELECT a.${d} AS name, a.${m} AS from_value, b.${m} AS to_value, b.${m} - a.${m} AS change, a.${t} AS from_year, b.${t} AS to_year FROM ${src} a JOIN ${src} b ON a.${d} = b.${d} WHERE a.${t} = ${earliest} AND b.${t} = ${latest} ORDER BY change ${dir}, a.${d} LIMIT 1`;
    add("change_largest_rise", "quantitative", move("DESC"), `{first.name} changed the most upward from {first.from_year} to {first.to_year}: from {first.from_value} to {first.to_value}.`);
    add("change_largest_fall", "quantitative", move("ASC"), `{first.name} changed the most downward, or rose the least, from {first.from_year} to {first.to_year}: from {first.from_value} to {first.to_value}.`);
    add("change_total", "quantitative", `WITH a AS (SELECT SUM(${m}) AS total FROM ${src} WHERE ${t} = ${earliest}), b AS (SELECT SUM(${m}) AS total FROM ${src} WHERE ${t} = ${latest}) SELECT ROUND((b.total - a.total) / NULLIF(a.total, 0) * 100, 1) AS pct, ${earliest} AS from_year, ${latest} AS to_year FROM a, b`, `The total ${word} changed by {first.pct} percent from {first.from_year} to {first.to_year}.`);
  }
  return out;
}

/**
 * Run each spec's SQL (`runSql(sql)` -> rows, nothing written) and fill its template (`fill(template, rows)` -> { text }, the runtime's fillClaimTemplate).
 * A spec whose SQL returns no rows, or whose template the filler refuses on those rows (a null from a zero total, say), is not a candidate: it is listed
 * in `dropped` with the reason. Ids are literal c1..cn over what is left. A failing `runSql` is not swallowed.
 */
export async function materializeCandidates({ specs, runSql, fill }) {
  const candidates = [];
  const dropped = [];
  for (const spec of specs) {
    const rows = await runSql(spec.sql);
    if (!Array.isArray(rows) || rows.length === 0) { dropped.push({ kind: spec.kind, why: "the SQL returned no rows" }); continue; }
    let text;
    try { text = fill(spec.template, rows).text; } catch (error) { dropped.push({ kind: spec.kind, why: String(error?.message ?? error).slice(0, 200) }); continue; }
    candidates.push({ id: `c${candidates.length + 1}`, kind: spec.kind, claim_kind: spec.claim_kind, sql: spec.sql, template: spec.template, text });
  }
  return { candidates, dropped };
}

const canonical = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** The record the model sees and the program keeps. Marked candidate_only; it records, it is never read back (there is no reader in this module). */
export function sheetRecord(candidates) {
  const list = candidates.map(({ id, kind, sql, template, text }) => ({ id, kind, sql, template, text }));
  const key = createHash("sha256").update(canonical(list)).digest("hex").slice(0, 16);
  return { path: `${SHEET_PREFIX}${key}.json`, record: { schema_version: "0.1.0", kind: "candidate_sheet", candidate_only: true, candidates: list } };
}

/** Write the sheet once through the caller's own write function (the tool's run-folder write: a path and the record object). The write is awaited. */
export async function writeSheet(candidates, write) {
  const { path, record } = sheetRecord(candidates);
  await write(path, record);
  return path;
}

/** The stop state: a reason code, where it stopped, and the promise that nothing already on disk is touched. The program sends no further request after it. */
export const stoppedState = (reason, step, detail = {}) => {
  if (!STOP_REASONS.includes(reason)) throw new Error(`unknown stop reason ${reason}`);
  return { status: "STOPPED", reason, step, kept_artifacts: true, ...detail };
};

/** The same data call failing twice with no new dataset to try is a stop, not a spin. `attempts`: [{ ok, dataset }]. */
export function dataStop(attempts) {
  const failed = attempts.filter((a) => a && a.ok === false);
  if (failed.length < 2) return null;
  const tried = new Set(attempts.map((a) => a?.dataset));
  const lastNew = attempts[attempts.length - 1];
  const repeated = failed.length >= 2 && attempts.filter((a) => a?.dataset === lastNew?.dataset).length >= 2;
  return repeated || tried.size === 1 ? stoppedState("data_failed", "data_prepare", { failures: failed.length }) : null;
}

/**
 * The pick step. `candidates` are rebuilt by the caller from the data file on disk (never read from the sheet). `picks` must be literal ids:
 * numbers, numbered forms and unknown ids are refused; 3 to 5, no repeats. Only the picked candidates reach `register` (the runtime's claim path),
 * in the order picked. A registered claim that is not VERIFIED stops the run before the page is built; nothing is repaired or retried.
 * `register(candidate)` returns { claim_id, verified }.
 */
export async function pickCandidates({ candidates, picks, register }) {
  if (!Array.isArray(picks) || picks.length < PICK_MIN || picks.length > PICK_MAX) return { status: "refused", problem: `pick ${PICK_MIN} to ${PICK_MAX} candidate ids` };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set();
  for (const pick of picks) {
    if (typeof pick !== "string" || !byId.has(pick)) return { status: "refused", problem: `picks must be literal candidate ids from the sheet; ${typeof pick === "string" ? `"${pick.slice(0, 20)}"` : "a non-string"} is not one` };
    if (seen.has(pick)) return { status: "refused", problem: `candidate ${pick} is picked twice` };
    seen.add(pick);
  }
  const claims = [];
  for (const id of picks) {
    let result;
    try { result = await register(byId.get(id)); } catch (error) { result = { claim_id: null, verified: false, detail: String(error?.message ?? error).slice(0, 200) }; }
    if (!result || result.verified !== true) return stoppedState("claim_replay_failed", "picks", { candidate: id, claim_id: result?.claim_id ?? null, registered: claims.map((c) => c.claim_id), ...(result?.detail ? { detail: result.detail } : {}) });
    claims.push({ candidate: id, claim_id: result.claim_id });
  }
  return { status: "ok", claims };
}
