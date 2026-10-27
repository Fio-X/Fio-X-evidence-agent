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
 * The candidate specs for a prepared data file: { ref: "data/<file>", dimensions: [varying columns, 1 to MAX_ENTITY_DIMS], measure, time? } (column names only; no rows are read here).
 * Returns [{ kind, claim_kind, sql, template, series_sql? }]. One rule builds every candidate: a SLICE (the rows an operator reads: one row per entity, at the latest time, or one
 * row per entity holding its move between the first and the last time; no aggregate, no ORDER BY ... LIMIT) and an OPERATOR over the slice (rank, gap, ratio, change, share). The
 * candidate SQL is the operator over `(slice)`; its series_sql is the slice itself, so a chart that shows the slice binds to the claim by the same SQL whatever the operator is.
 * An entity is the combination of the varying columns (a code, a country, a flow's origin and destination, a pair of dimensions); the module never asks what the chart will be.
 * Which specs exist depends only on whether a time column is given. Same input, same specs, same order.
 */
export const MAX_ENTITY_DIMS = 3;
// The entity column is called `name` unless the caller passes one of these: the new route names a place dimension whose codes the data side shows to be
// ISO 3166-1 country codes, so the chart checks read the codes as countries (alpha-2 for Eurostat, alpha-3 for the World Bank).
export const ENTITY_ALIASES = Object.freeze(["country_iso2", "country_iso3"]);
// A CUT table holds only the top codes of its one open dimension (newsroom_data_prepare's narrow): its slice keeps those members only, and a claim about the
// lowest, a gap, a ratio or a change would be read off the cut, so it offers only the highest and two shares whose denominator is the table's own total row.
export const CUT_KINDS = Object.freeze(["rank_top", "cut_top_share", "cut_members_share"]);
const CODE = /^[A-Za-z0-9_-]{1,40}$/;
export function buildCandidates(spec) {
  const { ref, measure, time, entity: alias, cut } = spec ?? {};
  if (alias !== undefined && !ENTITY_ALIASES.includes(alias)) throw new Error(`candidate entity column must be one of ${ENTITY_ALIASES.join(", ")}, not ${String(alias).slice(0, 40)}`);
  const n = alias ?? "name";
  const dims = Array.isArray(spec?.dimensions) ? spec.dimensions : [spec?.dimension];
  if (!DATA_REF.test(String(ref))) throw new Error(`candidate data reference must be a data/ file name: ${String(ref).slice(0, 60)}`);
  if (dims.length < 1 || dims.length > MAX_ENTITY_DIMS) throw new Error(`candidates take 1 to ${MAX_ENTITY_DIMS} varying columns, not ${dims.length}`);
  const ds = dims.map(quote);
  const m = quote(measure);
  const t = time ? quote(time) : null;
  const src = `'${ref}'`;
  const word = label(measure);
  const latest = t ? `(SELECT MAX(${t}) FROM ${src})` : null;
  const earliest = t ? `(SELECT MIN(${t}) FROM ${src})` : null;
  const entity = (alias = "") => (ds.length === 1 ? `${alias}${ds[0]}` : ds.map((d) => `CAST(${alias}${d} AS VARCHAR)`).join(" || ' / ' || "));
  const inYear = t ? " in {first.year}" : "";
  const yearCol = t ? ", year" : "";
  if (cut !== undefined) {
    const members = Array.isArray(cut?.members) ? cut.members.map(String) : [];
    if (ds.length !== 1) throw new Error("a cut table takes one varying column");
    if (!members.length || !members.every((code) => CODE.test(code))) throw new Error("a cut names its member codes (letters, digits, _ and -)");
    const total = cut.total ?? null;
    if (total !== null && (typeof total !== "string" || !CODE.test(total) || members.includes(total))) throw new Error("a cut's total is one code outside its members, or null");
  }
  const where = [t ? `${t} = ${latest}` : null, cut ? `${ds[0]} IN (${cut.members.map((code) => `'${code}'`).join(", ")})` : null].filter(Boolean);
  // slice 1: every entity at the latest time (or the whole file when there is no time); a cut keeps its members only
  const level = `SELECT ${entity()} AS ${n}, ${m} AS value${t ? `, ${t} AS year` : ""} FROM ${src}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${n}`;
  // slice 2: every entity's move from the first to the last time
  const on = ds.map((d) => `a.${d} = b.${d}`).join(" AND ");
  const move = t ? `SELECT ${entity("a.")} AS ${n}, a.${m} AS from_value, b.${m} AS to_value, b.${m} - a.${m} AS change, a.${t} AS from_year, b.${t} AS to_year FROM ${src} a JOIN ${src} b ON ${on} WHERE a.${t} = ${earliest} AND b.${t} = ${latest} ORDER BY ${n}` : null;
  const out = [];
  const add = (kind, claim_kind, sql, template, series_sql = null) => out.push({ kind, claim_kind, sql, template, ...(series_sql ? { series_sql } : {}) });
  const over = (slice, select, tail = "") => `SELECT ${select} FROM (${slice}) s${tail}`;
  const top = (dir) => over(level, `${n}, value${yearCol}`, ` ORDER BY value ${dir}, ${n} LIMIT 1`);
  add("rank_top", "comparative", top("DESC"), `{first.${n}} has the highest ${word}${inYear}: {first.value}.`, level);
  if (cut) {
    if ((cut.total ?? null) === null) return out;
    // The denominator is the total row of the same file at the same time; the numerator only the members, so an aggregate code in the file never adds in.
    const total = `(SELECT ${m} FROM ${src} WHERE ${ds[0]} = '${cut.total}'${t ? ` AND ${t} = ${latest}` : ""})`;
    add("cut_top_share", "quantitative", over(level, `${n}, ROUND(value / NULLIF(${total}, 0) * 100, 1) AS share${yearCol}`, ` ORDER BY value DESC, ${n} LIMIT 1`), `{first.${n}} accounts for {first.share} percent of the total${inYear}.`, level);
    add("cut_members_share", "quantitative", over(level, `COUNT(*) AS members, ROUND(SUM(value) / NULLIF(${total}, 0) * 100, 1) AS share${t ? ", MAX(year) AS year" : ""}`), `The top {first.members} by ${word} together account for {first.share} percent of the total${inYear}.`, level);
    return out;
  }
  add("rank_bottom", "comparative", top("ASC"), `{first.${n}} has the lowest ${word}${inYear}: {first.value}.`, level);
  add("extreme_gap", "quantitative", over(level, `MAX(value) - MIN(value) AS gap${t ? ", MAX(year) AS year" : ""}`), `The gap between the highest and the lowest ${word}${inYear} is {first.gap}.`, level);
  // "N times the lowest" reads only over positive values: a lowest at or below zero gives no ratio (null), so the filler drops it.
  add("top_to_bottom_ratio", "quantitative", over(level, `ROUND(MAX(value) / CASE WHEN MIN(value) > 0 THEN MIN(value) END, 1) AS ratio${t ? ", MAX(year) AS year" : ""}`), `The highest ${word}${inYear} is {first.ratio} times the lowest.`, level);
  add("share_of_total", "quantitative", over(level, `${n}, ROUND(value / NULLIF((SELECT SUM(value) FROM (${level})), 0) * 100, 1) AS share${yearCol}`, ` ORDER BY value DESC, ${n} LIMIT 1`), `{first.${n}} accounts for {first.share} percent of the total${inYear}.`);
  if (t) {
    const by = (dir) => over(move, "*", ` ORDER BY change ${dir}, ${n} LIMIT 1`);
    add("change_largest_rise", "quantitative", by("DESC"), `{first.${n}} changed the most upward from {first.from_year} to {first.to_year}: from {first.from_value} to {first.to_value}.`, move);
    add("change_largest_fall", "quantitative", by("ASC"), `{first.${n}} changed the most downward, or rose the least, from {first.from_year} to {first.to_year}: from {first.from_value} to {first.to_value}.`, move);
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
    candidates.push({ id: `c${candidates.length + 1}`, kind: spec.kind, claim_kind: spec.claim_kind, sql: spec.sql, template: spec.template, ...(spec.series_sql ? { series_sql: spec.series_sql } : {}), text });
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
/** The refusal text for a pick list that is not 3 to 5 distinct literal candidate ids, or null. */
export function validatePicks(candidates, picks) {
  if (!Array.isArray(picks) || picks.length < PICK_MIN || picks.length > PICK_MAX) return `pick ${PICK_MIN} to ${PICK_MAX} candidate ids`;
  const ids = new Set(candidates.map((c) => c.id));
  const seen = new Set();
  for (const pick of picks) {
    if (typeof pick !== "string" || !ids.has(pick)) return `picks must be literal candidate ids from the sheet; ${typeof pick === "string" ? `"${pick.slice(0, 20)}"` : "a non-string"} is not one`;
    if (seen.has(pick)) return `candidate ${pick} is picked twice`;
    seen.add(pick);
  }
  return null;
}

export async function pickCandidates({ candidates, picks, register }) {
  const problem = validatePicks(candidates, picks);
  if (problem) return { status: "refused", problem };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const claims = [];
  for (const id of picks) {
    let result;
    try { result = await register(byId.get(id)); } catch (error) { result = { claim_id: null, verified: false, detail: String(error?.message ?? error).slice(0, 200) }; }
    if (!result || result.verified !== true) return stoppedState("claim_replay_failed", "picks", { candidate: id, claim_id: result?.claim_id ?? null, registered: claims.map((c) => c.claim_id), ...(result?.detail ? { detail: result.detail } : {}) });
    claims.push({ candidate: id, claim_id: result.claim_id });
  }
  return { status: "ok", claims };
}

/** Candidate kinds that add every row of the dimension. A dimension often holds aggregate codes (EU27_2020, TOTAL) beside its members, so a sum would be double counted and
 *  still be written as "verified"; they come back only when a later order lets the model name one total code. */
export const SUM_KINDS = Object.freeze(["share_of_total", "change_total"]);

/**
 * The roles of a downloaded SDMX-style table, read from its rows, never from the request. `header`: column names; `rows`: arrays of cells without the header;
 * `dimensions`: the dimension column names in key order; `time` and `measure`: the provider's time and value columns. Every dimension that holds more than one
 * code varies (1 to MAX_ENTITY_DIMS of them); together they name the entity, and (the varying dimensions, time) must be unique. `qualifiers`: the dimensions the provider
 * table names as qualifiers of the number (its unit, its frequency); one that varies is never part of an entity, because a ranking across units or frequencies compares
 * numbers that are not alike. Anything else gives { ok:false, problem } saying how to narrow.
 */
export function detectRoles({ header, rows, dimensions, time, measure, qualifiers = [] }) {
  const at = new Map(header.map((name, i) => [name, i]));
  for (const name of [...dimensions, time, measure]) if (!at.has(name)) return { ok: false, problem: `the column ${name} is not in the data file` };
  if (rows.length === 0) return { ok: false, varying: [], empty: true, problem: "the file holds no rows: these codes have no values in these years" };
  const varying = dimensions.filter((name) => new Set(rows.map((row) => row[at.get(name)])).size > 1);
  const mixed = varying.filter((name) => qualifiers.includes(name));
  if (mixed.length > 0) return { ok: false, varying, problem: `${mixed.join(" and ")} can keep only one code: ${mixed.join(" and ")} qualif${mixed.length > 1 ? "y" : "ies"} the number (the numbers of different codes are not alike), so it is not something to rank or compare` };
  if (varying.length === 0) return { ok: false, varying, problem: "every dimension holds one code in the rows, so there is nothing to rank or compare: leave one dimension empty (all codes) and give the others one code each" };
  if (varying.length > MAX_ENTITY_DIMS) return { ok: false, varying, problem: `${varying.length} dimensions hold more than one code (${varying.join(", ")}): keep at most ${MAX_ENTITY_DIMS} of them open and give each of the others one code` };
  const d = varying.map((name) => at.get(name)), t = at.get(time);
  const seen = new Set();
  for (const row of rows) {
    const key = `${d.map((i) => row[i]).join("\u0000")}\u0000${row[t]}`;
    if (seen.has(key)) return { ok: false, varying, problem: `the rows hold two values for ${varying.map((name, i) => `${name}=${row[d[i]]}`).join(", ")} at ${time}=${row[t]}: another dimension still varies in a way the table cannot tell apart` };
    seen.add(key);
  }
  return { ok: true, dimensions: varying, time, measure, varying, times: new Set(rows.map((row) => row[t])).size };
}

/** The candidates for a prepared data file, without the sum kinds. Same inputs and same data, same candidates, same ids. `dropped` says why a kind is missing. */
export async function programCandidates({ ref, dimensions, measure, time, times, runSql, fill, seriesMaxRows, entity, cut }) {
  const specs = buildCandidates({ ref, dimensions, measure, time, ...(entity ? { entity } : {}), ...(cut ? { cut } : {}) });
  // A change between the first and the last time needs two of them; with one, "from 2015 to 2015" would be written as a finding.
  const flat = (spec) => spec.kind.startsWith("change_") && times === 1;
  const offered = specs.filter((spec) => !SUM_KINDS.includes(spec.kind) && !flat(spec));
  if (cut) {
    for (let i = offered.length - 1; i >= 0; i -= 1) if (!CUT_KINDS.includes(offered[i].kind)) offered.splice(i, 1);
  }
  // The series a chart of a candidate shows must fit the chart's row limit; say so now, not when the pick is registered.
  if (Number.isInteger(seriesMaxRows)) {
    for (const sql of new Set(offered.map((spec) => spec.series_sql).filter(Boolean))) {
      const rows = await runSql(sql);
      if (Array.isArray(rows) && rows.length > seriesMaxRows) return { conclusions: [], dropped: [], narrowing: `the series behind the conclusions has ${rows.length} rows and a chart shows at most ${seriesMaxRows}: narrow the filters (fewer codes in the open dimensions, or fewer years)` };
    }
  }
  const out = await materializeCandidates({ specs: offered, runSql, fill });
  const sums = specs.filter((spec) => SUM_KINDS.includes(spec.kind)).map((spec) => ({ kind: spec.kind, why: "sums every code of the dimension, which can include aggregate codes; not offered" }));
  const flats = specs.filter((spec) => !SUM_KINDS.includes(spec.kind) && flat(spec)).map((spec) => ({ kind: spec.kind, why: "the file holds one time value, so there is no change to report" }));
  const cuts = cut ? [...CUT_KINDS.filter((kind) => !specs.some((spec) => spec.kind === kind)).map((kind) => ({ kind, why: "the table holds no total row to divide by; not offered" })),
    ...buildCandidates({ ref, dimensions, measure, time }).map((spec) => spec.kind).filter((kind) => !CUT_KINDS.includes(kind)).map((kind) => ({ kind, why: `the table holds only the top ${cut.members.length} codes, so this would be read off the cut; not offered` }))] : [];
  return { conclusions: out.candidates, dropped: [...out.dropped, ...(cut ? [] : [...flats, ...sums]), ...cuts] };
}

/**
 * Register the picked candidates. For each pick the program reruns the candidate SQL and refills the template with the injected `fill`; the claim is the REFILLED
 * sentence, never the sheet's text, and a refilled sentence that differs from the candidate's stops the run. All picks are replayed this way before the first is
 * registered, so a stop leaves nothing registered. Registration then queries (`query(sql)` returns { ref, rows } of the recorded computation; the SQL is the candidate's),
 * refills the template from THOSE rows (the claim is that text; a text that differs from the sheet's stops the run) and records (`record(params)` returns { claim_id, verified }).
 * A pick list that is not literal ids is refused (status "refused"), not a stop.
 */
export async function registerPicks({ conclusions, picks, sourceRef, runSql, fill, query, record }) {
  const problem = validatePicks(conclusions, picks);
  if (problem) return { status: "refused", problem };
  const byId = new Map(conclusions.map((c) => [c.id, c]));
  const refilled = async (c) => fill(c.template, await runSql(c.sql)).text;
  const differs = (id) => `the sentence refilled from a rerun of ${id} differs from the sheet's sentence`;
  for (const id of picks) {
    let text;
    try { text = await refilled(byId.get(id)); } catch (error) { return stoppedState("claim_replay_failed", "picks", { candidate: id, claim_id: null, registered: [], detail: String(error?.message ?? error).slice(0, 200) }); }
    if (text !== byId.get(id).text) return stoppedState("claim_replay_failed", "picks", { candidate: id, claim_id: null, registered: [], detail: differs(id) });
  }
  return pickCandidates({
    candidates: conclusions,
    picks,
    register: async (c) => {
      // the claim is filled from the rows the recorded query returned, so the sentence and the computation record agree by construction
      const computed = await query(c.sql);
      const filled = fill(c.template, computed.rows);
      const text = filled.text;
      if (text !== c.text) return { claim_id: null, verified: false, detail: differs(c.id) };
      const computationRef = computed.ref;
      // a chart of this conclusion binds to the claim by the rows it shows: the claim cites the candidate's own result first, the chart's rows second
      const refs = c.series_sql ? [computationRef, (await query(c.series_sql)).ref] : [computationRef];
      // the template and what the fill bound go along so the caller can bind the claim's numbers (it does on the new route only)
      return record({ claim: text, claim_kind: c.claim_kind, status: "supported", source_refs: [sourceRef], computation_refs: refs }, { template: c.template, text, bindings: filled.bindings ?? [] });
    },
  });
}

/** Two failed data calls in a row, with no candidates made between them, stop the run (the count is the caller's). */
export const failureStop = (failures) => (failures >= 2 ? stoppedState("data_failed", "data_prepare", { failures }) : null);

// ---- The fill and the call book of the knowledge group ---------------------------------------------------------------------------------------------------------------------
// The knowledge group fills its own candidate sentences with the minimum it needs and does not call the other groups' fillers. Each function below has a twin elsewhere; a test
// (test_page_build_wiring.mjs) feeds both the same inputs and compares the output byte for byte, so a change on one side alone turns it red.
const CANDIDATE_STRING_MAX_CHARS = 80;
const candidateError = (message) => new Error(`CLAIM_TEMPLATE_ERROR: ${message}`);

/** TWIN of fillClaimTemplate in runtime/pi/newsroom.ts (visual and agent groups), restricted to the {first.<column>} placeholder and no |N or |u suffix. Same text for the same rows,
 *  the same error message when the rows cannot fill it. Any other placeholder is refused here, never filled differently. */
export function fillCandidate(template, rows) {
  if (typeof template !== "string" || !template.trim()) throw candidateError("the claim is empty");
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""))) throw candidateError("the claim has an unmatched { or }");
  if (!Array.isArray(rows) || rows.length === 0) throw candidateError("the plan SQL returned no rows, so no placeholder can be filled");
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))];
  // bindings: what each placeholder showed, in fillClaimTemplate's shape (the twin test compares both), so a hero can take its number from it
  const bindings = [];
  const text = template.replace(/\{([^{}]*)\}/g, (placeholder, body) => {
    const parts = body.trim().split(".").map((part) => part.trim());
    if (parts.length !== 2 || parts[0] !== "first" || !IDENT.test(parts[1])) throw candidateError(`${placeholder} is not a {first.<column>} placeholder, the only one the candidate fill takes`);
    if (!columns.includes(parts[1])) throw candidateError(`${placeholder}: the SQL result has no column '${parts[1]}'; result columns: ${columns.join(", ")}`);
    const value = rows[0]?.[parts[1]];
    const shown = candidateValueText(placeholder, value, 0);
    bindings.push({ placeholder, column: parts[1], row_index: 0, value, text: shown });
    return shown;
  });
  return { text, bindings };
}

function candidateValueText(placeholder, value, rowIndex) {
  if (value === null || value === undefined) throw candidateError(`${placeholder} selects a null value (row ${rowIndex})`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw candidateError(`${placeholder} selects a non-finite number (row ${rowIndex})`);
    if (Number.isInteger(value)) return String(value);
    if (Math.abs(value) >= 1) return value.toFixed(1);
    // Two significant digits without trailing zeros, as in 0.7 or -0.05.
    const short = String(Number(value.toPrecision(2)));
    return /e/i.test(short) ? value.toPrecision(2) : short;
  }
  if (typeof value === "string") return [...value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()].slice(0, CANDIDATE_STRING_MAX_CHARS).join("");
  if (typeof value === "boolean") return String(value);
  throw candidateError(`${placeholder} selects a value that is not a single number or text (row ${rowIndex})`);
}

/** TWIN of innerCallBook in runtime/pi/design_pack.mjs (agent group): the call ids and the finished-step list of the inner calls one outer call runs in order. */
export function candidateCallBook(outerId) {
  let seq = 0;
  const finished = [];
  return {
    next(tool, { nested = false } = {}) {
      seq += 1;
      const suffix = `s${seq}:${tool}`;
      return { callId: `${outerId}:${suffix}`, suffix, finished: [...finished], nested };
    },
    ok(call) { finished.push(call.nested ? `${call.suffix}:*` : call.suffix); },
    get seq() { return seq; },
  };
}
