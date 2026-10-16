// Record-only detectors: observation without consequence.
//
// Each detector looks for something that might one day become a refusal and
// writes what it finds to a side file under shadow/ (the same place and the
// same writer as the other shadow checks, see shadow.mjs). Nothing reads these
// records to decide anything:
//
// - every detector has its own switch that only the exact value `1` turns on;
//   off, nothing here is called and nothing is written;
// - a detector never changes a gate verdict, a lint warning or blocker, a
//   tool result or definition, a prompt, or any artifact other than its own
//   side file;
// - a failure inside a detector is swallowed (runShadow), so it can cost time
//   and never a result;
// - a record holds paths, ids, counts and short reasons only: no prompt or
//   conversation text, no provider diagnostics, no secrets. The only page text
//   it quotes is the matched word itself.
//
// The detectors are pure: they take already-read artifacts. The live call
// sites (newsroom.ts) and scripts/record_only_replay.mjs (saved runs) both
// feed them the same way.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { runShadow, writeShadowRecord } from "./shadow.mjs";
import { trackExport } from "./groups.mjs";
import { buildCandidates, checkField, summarizeChecks } from "./number_shadow.mjs";

export const RECORD_SWITCHES = Object.freeze({
  extreme_words: "NEWSROOM_RECORD_EXTREME_WORDS",
  caveats: "NEWSROOM_RECORD_CAVEATS",
  asof_lists: "NEWSROOM_RECORD_ASOF_LISTS",
  numbers: "NEWSROOM_RECORD_NUMBERS",
  thin_result: "NEWSROOM_RECORD_THIN_RESULT",
  dropped_content: "NEWSROOM_RECORD_DROPPED_CONTENT",
  origin_hash: "NEWSROOM_RECORD_ORIGIN_HASH",
  critic_vision: "NEWSROOM_RECORD_CRITIC_VISION",
});

export const recordOn = (kind, env = process.env) => String(env?.[RECORD_SWITCHES[kind]] ?? "") === "1";

/** Write one record (once, keyed by its own inputs) when the switch is on. Never throws. */
export async function recordOnly(kind, { root, keyInputs, record }, env = process.env) {
  if (!recordOn(kind, env) || !root) return null;
  return runShadow(() => writeShadowRecord(root, `record_${kind}`, keyInputs, record));
}

const asText = (value) => (typeof value === "string" ? value : "");
const idsOf = (...values) => [...new Set(values.flat().filter((id) => typeof id === "string" && id).map(String))];

// ---- A7: extreme, first and only words --------------------------------------

const HIGH = { words: ["最高", "最大", "峰值", "最多"], en: ["highest", "largest", "greatest", "peak", "most"] };
const LOW = { words: ["最低", "最小", "最少"], en: ["lowest", "smallest", "least", "fewest"] };
const OTHER = { words: ["首次", "唯一", "纪录", "记录以来"], en: ["first", "only", "record"] };

function classOf(word) {
  const lower = word.toLowerCase();
  if (HIGH.words.includes(word) || HIGH.en.includes(lower)) return "high";
  if (LOW.words.includes(word) || LOW.en.includes(lower)) return "low";
  return "other";
}

const EXTREME_RE = new RegExp(`(${[...HIGH.words, ...LOW.words, ...OTHER.words].join("|")})|\\b(${[...HIGH.en, ...LOW.en, ...OTHER.en].join("|")})\\b`, "gi");

/** Phrases that use these words without ranking anything (the claim lint skips the same ones). */
const NOT_A_RANKING = /\b(?:most\s+recent(?:ly)?|at\s+most|at\s+least|least\s+developed|first\s+name|only\s+if)\b/gi;

const hasPlaceholder = (claim, kind) => new RegExp(`\\{\\s*${kind}\\.`).test(asText(claim?.claim_template));

/**
 * `surfaces`: [{ where, text, claim_ids }]. `claims`: Map claim_id -> record.
 * A word is bound when a cited claim backs it: a max placeholder for a high
 * word, a min placeholder for a low word, or (any class) the cited claim's own
 * recorded text uses the same word, so the claim's checks already covered it.
 * Anything else is unbound and would be refused.
 */
export function extremeWordFindings({ surfaces, claims }) {
  const findings = [];
  for (const surface of surfaces ?? []) {
    const text = asText(surface.text).replace(NOT_A_RANKING, (match) => " ".repeat(match.length));
    if (!text) continue;
    const cited = (surface.claim_ids ?? []).map((id) => claims?.get?.(id)).filter(Boolean);
    for (const match of text.matchAll(EXTREME_RE)) {
      const word = match[0];
      const kind = classOf(word);
      let via = null;
      for (const claim of cited) {
        if ((kind === "high" && hasPlaceholder(claim, "max")) || (kind === "low" && hasPlaceholder(claim, "min"))) { via = { claim_id: claim.claim_id, how: kind === "high" ? "max_placeholder" : "min_placeholder" }; break; }
        if (asText(claim.claim).toLowerCase().includes(word.toLowerCase())) { via = { claim_id: claim.claim_id, how: "claim_text" }; break; }
      }
      findings.push({ where: surface.where, word, class: kind, bound: via !== null, ...(via ? { via } : {}), cited_claims: cited.length, would_refuse: via === null });
    }
  }
  return findings;
}

// ---- A8: caveats that never reach the page -----------------------------------

const squash = (text) => asText(text).replace(/\s+/g, "").toLowerCase();

/**
 * `cited`: [{ where, claim_ids }] chart and page modules that cite claims.
 * `pageTexts`: every text the page prints (chart notes, module notes, source
 * area, headings, bodies). `history`: claim records in file order, duplicates
 * kept, for the overwrite path.
 */
export function caveatFindings({ cited, pageTexts, claims, history }) {
  const printed = squash((pageTexts ?? []).join(" "));
  const missing = [];
  const seen = new Set();
  for (const entry of cited ?? []) {
    for (const id of entry.claim_ids ?? []) {
      const claim = claims?.get?.(id);
      const caveat = asText(claim?.caveat).trim();
      if (!caveat) continue;
      const key = `${entry.where}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!printed.includes(squash(caveat))) missing.push({ where: entry.where, claim_id: id, caveat_chars: caveat.length, printed: false, would_refuse: true });
    }
  }
  const versions = new Map();
  for (const record of history ?? []) {
    const id = asText(record?.claim_id);
    if (!id) continue;
    const list = versions.get(id) ?? [];
    list.push(asText(record.caveat).trim() || null);
    versions.set(id, list);
  }
  const overwritten = [];
  for (const [id, list] of [...versions.entries()].sort()) {
    const distinct = [...new Set(list)];
    if (distinct.length > 1) overwritten.push({ claim_id: id, versions: list.length, distinct_caveats: distinct.length, last_has_caveat: list[list.length - 1] !== null, dropped: list.some((value) => value !== null) && list[list.length - 1] === null, would_refuse: true });
  }
  return { missing, overwritten };
}

// ---- Q1: a subject list cut off by date but filtered on a status column -------

const STATUS_COLUMN = /(?:^|_)(status|state|active|current|is_member|member|membership|incumbent|在任|现任|现状|状态|是否)(?:_|$)|^(status|state|active|current|member|在任|现任|状态)/i;
const DATE_COLUMN = /(start|begin|join|enter|accession|from|since|effective|end|exit|leave|left|withdraw|terminat|expire|until|thru|depart|date|year|加入|开始|生效|退出|终止|结束|截止|日期|年)/i;

/**
 * The narrowest case that can be read from the SQL text alone: the page
 * declares a cutoff date, and the set's WHERE clause compares a status-like
 * column (status, active, current, member...) while comparing no start or end
 * date column at all. That set describes who holds the status today, not who
 * held it at the cutoff. Other leaks (a set that filters on dates but on the
 * wrong ones) stay with the existing as-of probe, which reads the source files.
 */
export function statusFilteredSetFindings({ subjectSet, sql }) {
  const cutoff = asText(subjectSet?.cutoff_date).trim();
  const text = asText(sql);
  if (!cutoff || !text) return [];
  const where = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|$)/i.exec(text)?.[1] ?? "";
  if (!where) return [];
  const comparisons = [...where.matchAll(/("[^"]+"|[A-Za-z_一-鿿][\w一-鿿.]*)\s*(?:=|<>|!=|<=|>=|<|>|\bis\b|\bin\b|\blike\b)/gi)].map((m) => m[1].replace(/"/g, "").split(".").pop());
  const statusColumns = [...new Set(comparisons.filter((column) => STATUS_COLUMN.test(column)))].sort();
  const dateColumns = [...new Set(comparisons.filter((column) => DATE_COLUMN.test(column) && !STATUS_COLUMN.test(column)))].sort();
  if (!statusColumns.length || dateColumns.length) return [];
  return [{ cutoff_date: cutoff, key_field: asText(subjectSet?.key_field) || null, status_filters: statusColumns, date_filters: dateColumns, would_refuse: true }];
}

// ---- Q2: numbers in positions the existing comparison does not read -----------

/** Text positions the existing page and chart comparisons (shadow.mjs) already read. */
export const COVERED_NUMBER_POSITIONS = Object.freeze([
  "page: title, dek, alt", "hero_stat: value+unit, label, detail", "text: heading, body", "pull_quote: text",
  "chart: title, subtitle, note, source_note, takeaway, alt, annotation text",
]);

/**
 * Page positions that carry prose but are not compared today. `spec` is the
 * page plan; returns [{ where, text, claim_ids }]. The big-number check that
 * reads the claim's own result is a separate, default-off check and is left
 * alone: hero_stat is not listed here.
 */
export function uncoveredNumberPositions(spec) {
  const out = [];
  const all = idsOf(...(spec?.modules ?? []).map((module) => [module.claim_id, ...(module.claim_ids ?? [])]));
  const add = (where, text, claimIds) => { if (asText(text)) out.push({ where, text, claim_ids: claimIds }); };
  add("kicker", spec?.kicker, all);
  add("source_note", spec?.source_note, all);
  add("byline", spec?.byline, all);
  for (const module of spec?.modules ?? []) {
    const id = String(module.id ?? module.type);
    const claimIds = idsOf(module.claim_id, module.claim_ids ?? []);
    const scope = claimIds.length ? claimIds : all;
    if (module.type === "section_header") { add(`section_header:${id}.eyebrow`, module.eyebrow, scope); add(`section_header:${id}.heading`, module.heading, scope); add(`section_header:${id}.deck`, module.deck, scope); }
    if (module.type === "illustration") { add(`illustration:${id}.caption`, module.caption, scope); add(`illustration:${id}.label`, module.label, scope); add(`illustration:${id}.alt`, module.alt, scope); }
    if (module.type === "visual") add(`visual:${id}.label`, module.label, claimIds.length ? claimIds : all);
    if (module.type === "hero_stat") add(`hero_stat:${id}.source_note`, module.source_note, scope);
    if (module.type === "pull_quote") { add(`pull_quote:${id}.attribution`, module.attribution, scope); add(`pull_quote:${id}.source`, module.source, scope); }
    if (module.type === "text") add(`text:${id}.label`, module.label, scope);
  }
  return out;
}

/** `candidatesFor(claimIds)` -> number_shadow candidates for those claims' rows. */
export function uncoveredNumberFindings({ positions, candidatesFor }) {
  const records = [];
  for (const position of positions ?? []) records.push(...checkField(position.where, position.text, candidatesFor(position.claim_ids ?? [])));
  const counts = summarizeChecks(records);
  return { counts, unmatched: records.filter((record) => record.status === "unmatched").map((record) => ({ where: record.field, raw: record.raw, would_refuse: true })), no_candidates: counts.no_candidates };
}

export const candidatesFromRowSets = (rowSets) => ({ ...buildCandidates(rowSets), chart_rows: [], chart_derived: [], spec: [] });

// ---- K109: content that disappears without a refusal -------------------------

export const SQL_ROW_CAP = 240;
const YEAR = /^-?\d{4}$/;
const num = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));

function periodColumn(rows) {
  const first = rows?.[0];
  if (!first || typeof first !== "object") return null;
  for (const key of Object.keys(first)) {
    if (/(^|_)(year|date|period|time|quarter|month|年|日期|时间)(_|$)/i.test(key) || rows.every((row) => YEAR.test(String(row[key] ?? "")))) return key;
  }
  return null;
}

const strideOf = (periods) => {
  const years = [...new Set(periods.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < years.length; i += 1) min = Math.min(min, years[i] - years[i - 1]);
  return Number.isFinite(min) ? min : null;
};

/**
 * (a) A query's rows are sampled against its source: over the same span the
 * source has more distinct periods and a finer step than the rows do (every
 * fifth year, quarter ends). `sourceRows` are the rows of the source file the
 * query read; the caller restricts them to the same entities when it can.
 */
export function sampledQueryFindings({ ref, rows, sourceRows, cap = SQL_ROW_CAP }) {
  const column = periodColumn(rows);
  if (!column || !Array.isArray(sourceRows) || !sourceRows.length || !(column in (sourceRows[0] ?? {}))) return [];
  const periods = rows.map((row) => Number(row[column])).filter(Number.isFinite);
  if (periods.length < 2) return [];
  const [lo, hi] = [Math.min(...periods), Math.max(...periods)];
  const inSpan = [...new Set(sourceRows.map((row) => Number(row[column])).filter((p) => Number.isFinite(p) && p >= lo && p <= hi))];
  const chartDistinct = new Set(periods).size;
  const stride = strideOf(periods);
  const sourceStride = strideOf(inSpan);
  if (inSpan.length <= chartDistinct || !stride || !sourceStride || stride <= sourceStride) return [];
  return [{ ref, period_field: column, span: [lo, hi], periods_in_rows: chartDistinct, periods_in_source: inSpan.length, row_step: stride, source_step: sourceStride, source_over_cap: inSpan.length > cap, would_refuse: true }];
}

/**
 * (c) The series misses the source's maximum, minimum or latest period within
 * the span the page states for it (the 4-digit years in its title, subtitle
 * and note; its own span when none). One value field, one period field, the
 * entity fields the rows and the source share restricted to the rows' values.
 */
export function seriesSpanFindings({ ref, spec, rows, sourceRows, valueField }) {
  const period = periodColumn(rows);
  if (!period || !valueField || !Array.isArray(sourceRows) || !sourceRows.length) return [];
  if (!(period in sourceRows[0]) || !(valueField in sourceRows[0]) || !(valueField in rows[0])) return [];
  const years = [...[spec?.title, spec?.subtitle, spec?.note].map(asText).join(" ").matchAll(/\b(1[5-9]\d\d|20\d\d)\b/g)].map((m) => Number(m[1]));
  const own = rows.map((row) => Number(row[period])).filter(Number.isFinite);
  const lo = years.length ? Math.min(...years) : Math.min(...own);
  const hi = years.length ? Math.max(...years) : Math.max(...own);
  const entityFields = Object.keys(rows[0]).filter((key) => key !== period && key !== valueField && typeof rows[0][key] === "string" && key in sourceRows[0]);
  const allowed = entityFields.map((key) => [key, new Set(rows.map((row) => String(row[key])))]);
  const subset = sourceRows.filter((row) => Number(row[period]) >= lo && Number(row[period]) <= hi && allowed.every(([key, set]) => set.has(String(row[key]))) && Number.isFinite(num(row[valueField])));
  if (!subset.length) return [];
  const have = rows.filter((row) => Number.isFinite(num(row[valueField])));
  const haveMax = Math.max(...have.map((row) => num(row[valueField])));
  const haveMin = Math.min(...have.map((row) => num(row[valueField])));
  const havePeriods = new Set(own);
  const out = [];
  const sourceMax = Math.max(...subset.map((row) => num(row[valueField])));
  const sourceMin = Math.min(...subset.map((row) => num(row[valueField])));
  const latest = Math.max(...subset.map((row) => Number(row[period])));
  if (sourceMax > haveMax) out.push({ missing: "max", source_value: sourceMax, series_value: haveMax });
  if (sourceMin < haveMin) out.push({ missing: "min", source_value: sourceMin, series_value: haveMin });
  if (!havePeriods.has(latest)) out.push({ missing: "latest_period", source_period: latest, series_last_period: Math.max(...own) });
  return out.map((item) => ({ ref, span: [lo, hi], period_field: period, value_field: valueField, ...item, would_refuse: true }));
}

/**
 * (b) Content of an earlier page-plan attempt that the later plan no longer
 * has, after the earlier one failed its lint. `earlier` and `later` are page
 * plans; a module counts by id, a chart by its manifest_ref.
 */
export function droppedModuleFindings({ earlier, later, earlierRef, laterRef }) {
  if (!earlier || !later) return [];
  const keyOf = (module) => String(module.type === "visual" ? `visual:${module.manifest_ref ?? module.id}` : `${module.type}:${module.id}`);
  const kept = new Set((later.modules ?? []).map(keyOf));
  const dropped = (earlier.modules ?? []).map((module) => ({ key: keyOf(module), type: module.type })).filter((module) => !kept.has(module.key));
  return dropped.map((module) => ({ earlier_plan: earlierRef, later_plan: laterRef, module: module.key, type: module.type, would_refuse: true }));
}

// ---- K124: can the reviewing model see the preview ---------------------------

/** `model` is the in-process model object (never Pi's config files). */
export function criticVisionRecord({ stage, requestedModel, model, imagesReturned, reviewSubmitted }) {
  const input = Array.isArray(model?.input) ? model.input.map(String) : null;
  const declares = input === null ? null : input.includes("image");
  return {
    stage,
    requested_model: requestedModel ?? null,
    process_model: model?.id ?? null,
    declares_image_input: declares,
    preview_images_returned: imagesReturned ?? null,
    // Pi sends tool-result images only to a model that declares image input.
    image_reached_model: declares === null || imagesReturned === null ? null : Boolean(declares && imagesReturned),
    review_submitted: reviewSubmitted ?? null,
    would_refuse: declares === false || (reviewSubmitted === true && imagesReturned === false),
  };
}

// ---- Reading a run folder, shared by the live call sites and the replay -------
//
// Everything below reads artifacts under `root` and nothing else: claims,
// computations, data files, visualization manifests and plans, page plans and
// their lints. It never opens a conversation, prompt, session or config file.

async function readJson(root, ref) {
  try { return JSON.parse(await readFile(join(root, ref), "utf8")); } catch { return null; }
}

/** claims.jsonl: the latest record per claim_id that is system-verified, and every record in file order. */
export async function readClaims(root) {
  const history = [];
  let text = "";
  try { text = await readFile(join(root, "claims.jsonl"), "utf8"); } catch { return { claims: new Map(), history }; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const record = JSON.parse(line); if (record?.claim_id) history.push(record); } catch {}
  }
  const claims = new Map();
  for (const record of history) {
    if (record.status === "verified" && record.verification?.authority === "system") claims.set(record.claim_id, record);
    else claims.delete(record.claim_id);
  }
  return { claims, history };
}

async function rowsOfClaims(root, claimIds, claims) {
  const rowSets = [];
  for (const id of claimIds) {
    for (const ref of claims.get(id)?.computation_refs ?? []) {
      const record = await readJson(root, String(ref));
      if (Array.isArray(record?.rows)) rowSets.push(record.rows);
    }
  }
  return rowSets;
}

/** A small CSV reader (quotes, doubled quotes, CRLF) for the data files a run downloaded; null for anything else or over 8 MB. */
export async function readCsvRows(root, ref) {
  if (!/\.csv$/i.test(String(ref))) return null;
  try {
    if ((await stat(join(root, ref))).size > 8 * 1024 * 1024) return null;
    const text = (await readFile(join(root, ref), "utf8")).replace(/^\uFEFF/, "");
    const records = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i += 1; row.push(cell); cell = ""; if (row.length > 1 || row[0] !== "") records.push(row); row = []; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); records.push(row); }
    const [header, ...body] = records;
    if (!header) return null;
    return body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
  } catch { return null; }
}

const textOfSvg = (svg) => asText(svg).replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const VIZ_FIELDS = ["title", "subtitle", "note", "source_note", "takeaway", "alt"];

function vizSurfaces(spec) {
  const claimId = asText(spec?.claim_id);
  const out = VIZ_FIELDS.filter((field) => asText(spec?.[field])).map((field) => ({ where: field, text: spec[field], claim_ids: idsOf(claimId) }));
  (spec?.annotations ?? []).forEach((annotation, index) => {
    if (asText(annotation?.text)) out.push({ where: `annotations[${index}]`, text: annotation.text, claim_ids: idsOf(claimId, annotation.claim_id) });
  });
  return out;
}

function valueFieldOf(spec, rows) {
  const period = periodColumn(rows);
  for (const key of [spec?.value_field, spec?.y_field, spec?.value]) if (typeof key === "string" && key in (rows?.[0] ?? {})) return key;
  return Object.keys(rows?.[0] ?? {}).find((key) => key !== period && rows.every((row) => Number.isFinite(num(row[key])))) ?? null;
}

/**
 * One chart: A7 (title, subtitle, notes, annotations), A8 (is the cited
 * claim's caveat printed on the chart) and K109 (a) and (c). `rows` are the
 * chart's own rows; `computationRef` names the computation they came from.
 */
export async function recordVizLint({ root, out, spec, planRef, rows, computationRef }, env = process.env) {
  if (!root || !spec || !["extreme_words", "caveats", "dropped_content"].some((kind) => recordOn(kind, env))) return [];
  const written = [];
  const { claims, history } = await readClaims(root);
  const surfaces = vizSurfaces(spec);
  if (recordOn("extreme_words", env)) {
    const findings = extremeWordFindings({ surfaces, claims });
    written.push(await recordOnly("extreme_words", { root: out ?? root, keyInputs: { surface: "viz", plan_ref: planRef, surfaces: surfaces.map((s) => [s.where, s.text]) }, record: { surface: "viz", plan_ref: planRef, counts: { words: findings.length, would_refuse: findings.filter((f) => f.would_refuse).length }, findings } }, env));
  }
  if (recordOn("caveats", env)) {
    const printed = surfaces.map((s) => s.text);
    const found = caveatFindings({ cited: [{ where: "chart", claim_ids: idsOf(spec.claim_id) }], pageTexts: printed, claims, history });
    written.push(await recordOnly("caveats", { root: out ?? root, keyInputs: { surface: "viz", plan_ref: planRef, claim: spec.claim_id ?? null }, record: { surface: "viz", plan_ref: planRef, counts: { not_printed: found.missing.length, overwritten: found.overwritten.length }, ...found } }, env));
  }
  if (recordOn("dropped_content", env) && Array.isArray(rows) && rows.length) {
    const computation = computationRef ? await readJson(root, computationRef) : null;
    const sources = [];
    for (const input of computation?.read_inputs ?? []) { const csv = await readCsvRows(root, input.path); if (csv) sources.push({ path: input.path, rows: csv }); }
    const valueField = valueFieldOf(spec, rows);
    const sampled = [], span = [];
    for (const source of sources) {
      sampled.push(...sampledQueryFindings({ ref: computationRef, rows, sourceRows: source.rows }).map((f) => ({ ...f, source: source.path })));
      if (valueField) span.push(...seriesSpanFindings({ ref: computationRef, spec, rows, sourceRows: source.rows, valueField }).map((f) => ({ ...f, source: source.path })));
    }
    written.push(await recordOnly("dropped_content", { root: out ?? root, keyInputs: { surface: "viz", plan_ref: planRef, computation: computationRef ?? null, sources: sources.map((s) => s.path) }, record: { surface: "viz", plan_ref: planRef, counts: { sampled_queries: sampled.length, series_misses: span.length, unreadable_sources: Math.max(0, (computation?.read_inputs ?? []).length - sources.length) }, sampled_queries: sampled, series_misses: span } }, env));
  }
  return written.filter(Boolean);
}

/**
 * The page: A7 (page text), A8 (every cited claim's caveat against everything
 * the page and its charts print), Q2 (numbers in positions the existing check
 * does not read) and K109 (b) (content an earlier, refused plan had).
 */
export async function recordPageLint({ root, out, spec, planRef }, env = process.env) {
  if (!root || !spec || !["extreme_words", "caveats", "numbers", "asof_lists", "dropped_content"].some((kind) => recordOn(kind, env))) return [];
  const written = [];
  const { claims, history } = await readClaims(root);
  const modules = spec.modules ?? [];
  const allClaims = idsOf(...modules.map((m) => [m.claim_id, ...(m.claim_ids ?? [])]));
  const pageSurfaces = [];
  const push = (where, text, claimIds) => { if (asText(text)) pageSurfaces.push({ where, text, claim_ids: claimIds }); };
  for (const field of ["title", "dek", "alt"]) push(field, spec[field], allClaims);
  for (const module of modules) {
    const id = String(module.id ?? module.type);
    const ids = idsOf(module.claim_id, module.claim_ids ?? []);
    for (const field of ["label", "detail", "heading", "body", "text", "deck", "eyebrow", "caption"]) push(`${module.type}:${id}.${field}`, module[field], ids.length ? ids : allClaims);
  }
  if (recordOn("extreme_words", env)) {
    const findings = extremeWordFindings({ surfaces: pageSurfaces, claims });
    written.push(await recordOnly("extreme_words", { root: out ?? root, keyInputs: { surface: "page", plan_ref: planRef, surfaces: pageSurfaces.map((s) => [s.where, s.text]) }, record: { surface: "page", plan_ref: planRef, counts: { words: findings.length, would_refuse: findings.filter((f) => f.would_refuse).length }, findings } }, env));
  }
  if (recordOn("caveats", env)) {
    const chartTexts = [];
    for (const module of modules) {
      if (module.type !== "visual" || !module.manifest_ref) continue;
      const manifest = await readJson(root, String(module.manifest_ref));
      for (const field of ["title", "subtitle", "note", "source_note", "takeaway"]) if (asText(manifest?.[field])) chartTexts.push(manifest[field]);
      try { chartTexts.push(textOfSvg(await readFile(join(root, String(manifest?.svg ?? String(module.manifest_ref).replace(/\.json$/, ".svg"))), "utf8"))); } catch {}
    }
    const cited = modules.filter((m) => idsOf(m.claim_id, m.claim_ids ?? []).length).map((m) => ({ where: `${m.type}:${m.id ?? m.type}`, claim_ids: idsOf(m.claim_id, m.claim_ids ?? []) }));
    const found = caveatFindings({ cited, pageTexts: [...pageSurfaces.map((s) => s.text), spec.source_note, spec.kicker, ...chartTexts], claims, history });
    written.push(await recordOnly("caveats", { root: out ?? root, keyInputs: { surface: "page", plan_ref: planRef, cited }, record: { surface: "page", plan_ref: planRef, counts: { not_printed: found.missing.length, overwritten: found.overwritten.length }, ...found } }, env));
  }
  if (recordOn("numbers", env)) {
    const positions = uncoveredNumberPositions(spec);
    const cache = new Map();
    const rowSetsByKey = new Map();
    for (const position of positions) { const key = (position.claim_ids ?? []).join("|"); if (!rowSetsByKey.has(key)) rowSetsByKey.set(key, await rowsOfClaims(root, position.claim_ids ?? [], claims)); }
    const candidatesFor = (ids) => { const key = ids.join("|"); if (!cache.has(key)) cache.set(key, candidatesFromRowSets(rowSetsByKey.get(key) ?? [])); return cache.get(key); };
    const found = uncoveredNumberFindings({ positions, candidatesFor });
    written.push(await recordOnly("numbers", { root: out ?? root, keyInputs: { surface: "page_uncovered", plan_ref: planRef, positions: positions.map((p) => [p.where, p.text]) }, record: { surface: "page_uncovered", plan_ref: planRef, covered_elsewhere: COVERED_NUMBER_POSITIONS, positions: positions.map((p) => p.where), counts: { ...found.counts }, unmatched: found.unmatched } }, env));
  }
  if (recordOn("asof_lists", env)) {
    const computation = spec.subject_set?.computation_ref ? await readJson(root, String(spec.subject_set.computation_ref)) : null;
    written.push(await recordSubjectSet({ root, out, spec, planRef, sql: computation?.sql }, env));
  }
  if (recordOn("dropped_content", env)) {
    const plans = await earlierRefusedPlans(root, planRef);
    const findings = [];
    for (const earlier of plans) findings.push(...droppedModuleFindings({ earlier: earlier.spec, later: spec, earlierRef: earlier.ref, laterRef: planRef }));
    written.push(await recordOnly("dropped_content", { root: out ?? root, keyInputs: { surface: "page", plan_ref: planRef, earlier: plans.map((p) => p.ref) }, record: { surface: "page", plan_ref: planRef, order: "plan file modification time", counts: { earlier_refused_plans: plans.length, dropped_modules: findings.length }, dropped_modules: findings } }, env));
  }
  return written.filter(Boolean);
}

/** Plans whose own page lint failed and that were written before `planRef` (file modification time; ties are not compared). */
export async function earlierRefusedPlans(root, planRef) {
  let names = [];
  try { names = (await readdir(join(root, "infographics", "lints"))).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const failed = new Set();
  for (const name of names) {
    const lint = await readJson(root, `infographics/lints/${name}`);
    if (lint && lint.passed === false && typeof lint.plan_ref === "string") failed.add(lint.plan_ref);
  }
  let self = null;
  try { self = (await stat(join(root, planRef))).mtimeMs; } catch { return []; }
  const out = [];
  for (const ref of [...failed].sort()) {
    if (ref === planRef) continue;
    try {
      const time = (await stat(join(root, ref))).mtimeMs;
      if (time < self) { const spec = await readJson(root, ref); if (spec) out.push({ ref, spec, time }); }
    } catch {}
  }
  return out.sort((a, b) => a.time - b.time || a.ref.localeCompare(b.ref, "en-US"));
}

/** Q1, from the subject-set glue: `sql` is the declared computation's SQL. */
export async function recordSubjectSet({ root, out, spec, planRef, sql }, env = process.env) {
  if (!recordOn("asof_lists", env) || !root) return null;
  const subjectSet = spec?.subject_set && typeof spec.subject_set === "object" ? spec.subject_set : null;
  const findings = subjectSet ? statusFilteredSetFindings({ subjectSet, sql }) : [];
  return recordOnly("asof_lists", { root: out ?? root, keyInputs: { surface: "subject_set", plan_ref: planRef, subject_set: subjectSet ? [subjectSet.key_field ?? null, subjectSet.cutoff_date ?? null, subjectSet.computation_ref ?? null] : null, sql: asText(sql) }, record: { surface: "subject_set", plan_ref: planRef, declared: Boolean(subjectSet), counts: { status_filtered_sets: findings.length }, findings } }, env);
}

/** K124: `stage` is "preview" (images returned) or "review" (verdict submitted). */
export async function recordCriticVision({ root, out, stage, ref, requestedModel, model, imagesReturned, reviewSubmitted }, env = process.env) {
  if (!recordOn("critic_vision", env) || !(out ?? root)) return null;
  const record = criticVisionRecord({ stage, requestedModel, model, imagesReturned, reviewSubmitted });
  return recordOnly("critic_vision", { root: out ?? root, keyInputs: { stage, ref, ...record }, record: { ref, ...record } }, env);
}

// K315: report-only record of tools reaching this module's exports (key record_only.mjs::name). test_k315_export_wrap pins this list.
{
  recordCriticVision = trackExport("record_only.mjs::recordCriticVision", recordCriticVision);
  recordPageLint = trackExport("record_only.mjs::recordPageLint", recordPageLint);
  recordVizLint = trackExport("record_only.mjs::recordVizLint", recordVizLint);
}
