// Shadow checks: observation without consequence.
//
// A shadow check measures something that might one day become a gate (numbers
// in prose that no computation backs; subject-set SQL that ignores its as-of
// date) without ever changing what a run produces. The contract:
//
// - OFF by default. `NEWSROOM_SHADOW_CHECKS=1` turns it on; with the switch
//   off nothing here is called and nothing is computed.
// - It never touches `lint.warnings`, `lint.blockers`, a lint/computation
//   artifact, the model-visible text, or any gate. The only things it writes
//   are side files under `<artifact root>/shadow/`, keyed by the hash of the
//   shadow's OWN inputs, so a rerun writes the same name (the file is created
//   once and never rewritten) and no immutable artifact can collide.
// - The only thing a tool's `details` may carry is `{ path, counts }`.
// - Any failure inside a shadow is swallowed: a shadow can cost time, never a
//   result.
//
// `shadow/` sits beside data/, sources/, computations/ and visualizations/.
// Nothing enumerates the artifact root: the evidence snapshot fingerprints only
// data/*.meta.json and sources/*.json, the Rust and Python verifiers and the
// publication file lists read named subdirectories only. test_shadow_side_file
// proves this rather than asserting it.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { cutoffCoverage, probeAsOf } from "./asof_probe.mjs";
import { claimComputationStates, computationInputState, strictResultHashMatches } from "./claim_binding.mjs";
import { buildCandidates, checkField, summarizeChecks } from "./number_shadow.mjs";

export const SHADOW_DIR = "shadow";
export const SHADOW_SCHEMA_VERSION = "1.0.0";

export function shadowChecksEnabled(env = process.env) {
  return String(env?.NEWSROOM_SHADOW_CHECKS ?? "") === "1";
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export const shadowKey = (inputs) => createHash("sha256").update(stable(inputs)).digest("hex");

/**
 * Write a shadow record once under shadow/. Returns the relative path. An
 * existing file is left alone (it was produced by identical inputs).
 */
export async function writeShadowRecord(root, kind, keyInputs, record) {
  const key = shadowKey({ kind, ...keyInputs });
  const relativePath = `${SHADOW_DIR}/${kind}-${key}.json`;
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify({ schema_version: SHADOW_SCHEMA_VERSION, kind, key, ...record }, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return relativePath;
}

/** Run `compute`; return its { path, counts } or null. Never throws, never blocks a result. */
export async function runShadow(compute) {
  try {
    return await compute();
  } catch {
    return null;
  }
}

// ---- B: numbers in prose ---------------------------------------------------

const VIZ_TEXT_FIELDS = ["title", "subtitle", "note", "source_note", "takeaway", "alt"];

async function claimRows(claimIds, claimRecords, deps) {
  const rowSets = [];
  const states = new Map();
  for (const claimId of claimIds) {
    const claim = claimRecords?.get?.(claimId);
    if (!claim) continue;
    const claimStates = await claimComputationStates(claim, deps);
    states.set(claimId, claimStates);
    for (const ref of Array.isArray(claim.computation_refs) ? claim.computation_refs : []) {
      try {
        const record = await deps.readComputation(String(ref));
        if (Array.isArray(record?.rows)) rowSets.push(record.rows);
      } catch {}
    }
  }
  return { rowSets, states };
}

const withSources = (claimSide, chartSide, spec) => ({
  rows: claimSide.rows, derived: claimSide.derived, chart_rows: chartSide.rows, chart_derived: chartSide.derived, spec,
});

/**
 * Viz lint shadow. `chart` = { rows, data_hash }. Writes shadow/prose_numbers-<key>.json.
 * Returns { path, counts } for tool `details`.
 */
export async function shadowVizNumbers({ root, spec, planRef, chart, claimRecords, deps }) {
  const started = performance.now();
  const annotations = Array.isArray(spec.annotations) ? spec.annotations : [];
  const claimIds = [...new Set([spec.claim_id, ...annotations.map((annotation) => annotation?.claim_id)].filter(Boolean).map(String))];
  const { rowSets, states } = await claimRows(claimIds, claimRecords, deps);
  const specValues = [
    ...annotations.filter((annotation) => annotation?.type === "reference_line").map((annotation) => annotation.value),
    ...(Array.isArray(spec.highlight_values) ? spec.highlight_values : []),
  ];
  const candidates = withSources(buildCandidates(rowSets), buildCandidates([chart.rows]), buildCandidates([], specValues).spec);
  const records = [];
  const fields = [];
  for (const field of VIZ_TEXT_FIELDS) if (typeof spec[field] === "string" && spec[field]) fields.push([field, spec[field]]);
  annotations.forEach((annotation, index) => {
    if (typeof annotation?.text === "string" && annotation.text) fields.push([`annotations[${index}].${annotation.type === "reference_line" ? "reference_line.text" : "text"}`, annotation.text]);
  });
  for (const [field, text] of fields) records.push(...checkField(field, text, candidates));
  const strict = [...states.entries()].map(([claimId, claimStates]) => ({ subject: "chart", claim_id: claimId, ...strictResultHashMatches(chart.data_hash, claimStates) }));
  const counts = summarizeChecks(records);
  const computeMs = Math.round((performance.now() - started) * 100) / 100;
  const path = await writeShadowRecord(root, "prose_numbers", {
    surface: "viz_lint", plan_ref: planRef, data_hash: chart.data_hash, fields,
    claims: [...states.entries()].map(([claimId, claimStates]) => [claimId, claimStates.map((state) => [state.ref, state.result_hash])]),
  }, { surface: "viz_lint", plan_ref: planRef, compute_ms: computeMs, counts, numbers: records, strict_result_hash: strict });
  return { path, counts };
}

/**
 * Infographic lint shadow. Each hero_stat/text/pull_quote module is checked
 * against the rows of its own claims; title and dek against all cited claims.
 */
export async function shadowInfographicNumbers({ root, spec, planRef, assets, claimRecords, deps }) {
  const started = performance.now();
  const modules = Array.isArray(spec.modules) ? spec.modules : [];
  const idsOf = (module) => [...new Set([module.claim_id, ...(Array.isArray(module.claim_ids) ? module.claim_ids : [])].filter(Boolean).map(String))];
  const cache = new Map();
  const candidatesFor = async (claimIds) => {
    const key = claimIds.join("|");
    if (!cache.has(key)) {
      const { rowSets, states } = await claimRows(claimIds, claimRecords, deps);
      cache.set(key, { candidates: withSources(buildCandidates(rowSets), { rows: [], derived: [] }, []), states });
    }
    return cache.get(key);
  };
  const records = [];
  const strict = [];
  const allClaims = [...new Set(modules.flatMap(idsOf))];
  const pageFields = [["title", spec.title], ["dek", spec.dek], ["alt", spec.alt]].filter(([, text]) => typeof text === "string" && text);
  const { candidates: pageCandidates } = await candidatesFor(allClaims);
  for (const [field, text] of pageFields) records.push(...checkField(field, text, pageCandidates));
  const fieldKeys = [];
  for (const module of modules) {
    const claimIds = idsOf(module);
    const id = String(module.id ?? module.type);
    if (module.type === "visual") {
      const manifest = assets?.[String(module.manifest_ref ?? "")]?.manifest;
      if (manifest?.claim_id) {
        const { states } = await candidatesFor([String(manifest.claim_id)]);
        for (const [claimId, claimStates] of states.entries()) strict.push({ subject: `visual:${id}`, claim_id: claimId, ...strictResultHashMatches(manifest.data_hash, claimStates) });
      }
      continue;
    }
    const texts = module.type === "hero_stat"
      ? [["value", [module.value, module.unit].filter((part) => part !== undefined && part !== null && part !== "").join(" ")], ["label", module.label], ["detail", module.detail]]
      : module.type === "text" ? [["heading", module.heading], ["body", module.body]]
        : module.type === "pull_quote" ? [["text", module.text]] : [];
    if (!texts.length) continue;
    const { candidates } = await candidatesFor(claimIds);
    for (const [name, text] of texts) {
      if (typeof text !== "string" || !text) continue;
      fieldKeys.push([`${module.type}:${id}.${name}`, text, claimIds]);
      records.push(...checkField(`${module.type}:${id}.${name}`, text, candidates));
    }
  }
  const counts = summarizeChecks(records);
  const computeMs = Math.round((performance.now() - started) * 100) / 100;
  const path = await writeShadowRecord(root, "prose_numbers", {
    surface: "infographic_lint", plan_ref: planRef, fields: [...pageFields, ...fieldKeys],
    visuals: modules.filter((module) => module.type === "visual").map((module) => [module.id, assets?.[String(module.manifest_ref ?? "")]?.manifest?.data_hash ?? null]),
    claims: [...cache.entries()].map(([key, value]) => [key, [...value.states.entries()].map(([claimId, claimStates]) => [claimId, claimStates.map((state) => [state.ref, state.result_hash])])]),
  }, { surface: "infographic_lint", plan_ref: planRef, compute_ms: computeMs, counts, numbers: records, strict_result_hash: strict });
  return { path, counts };
}

// ---- A: as-of leaks in subject-set SQL ------------------------------------

/**
 * Probe the page's subject set against its source files (asof_probe.mjs) and
 * record cutoff coverage by module type. Runs only when the switch is on, from
 * the resolveSubjectSets glue. `deps`: readComputation, root, describe, query,
 * registryDate, serializeSql. Returns { path, counts } for tool `details`.
 */
export async function shadowAsOf({ root, spec, assets, planRef, members, deps }) {
  const started = performance.now();
  const declared = spec?.subject_set && typeof spec.subject_set === "object" ? spec.subject_set : null;
  const coverage = cutoffCoverage(spec, assets);
  let probe = { status: "skipped", reason: "no_subject_set", classification: "skipped" };
  let keyInputs = { surface: "subject_set", plan_ref: planRef, subject_set: null };
  if (declared) {
    let record = null;
    try { record = await deps.readComputation(String(declared.computation_ref ?? "")); } catch { record = null; }
    if (!record || typeof record.sql !== "string") probe = { status: "skipped", reason: "set_computation_unreadable", classification: "skipped" };
    else {
      const state = await computationInputState(String(declared.computation_ref), deps);
      const inputs = state.effective_inputs.filter((path) => path.startsWith("data/") || path.startsWith("sources/"));
      let ast = null;
      try { ast = await deps.serializeSql(record.sql); } catch { ast = null; }
      const memberSet = new Set([...(members ?? [])].map(String));
      // The registry's reference dates are probe inputs too: when a source
      // is re-registered with a different date the key changes, so the side
      // file on disk always belongs to the counts returned with it.
      const registry = [];
      for (const path of inputs) { let date = null; try { date = (await deps.registryDate?.(path)) ?? null; } catch { date = null; } registry.push([path, date]); }
      probe = await probeAsOf({ subjectSet: declared, members: memberSet, sql: record.sql, inputs, ast, describe: deps.describe, query: deps.query, registryDate: deps.registryDate });
      keyInputs = {
        surface: "subject_set", plan_ref: planRef,
        subject_set: { key_field: declared.key_field ?? null, cutoff_date: declared.cutoff_date ?? null, computation_ref: declared.computation_ref ?? null },
        sql: record.sql, inputs: (record.read_inputs ?? []).map((input) => [input.path, input.sha256]), members: [...memberSet].sort(),
        input_refs: inputs, registry_reference: registry,
      };
    }
  }
  const files = Array.isArray(probe.files) ? probe.files : [];
  const counts = {
    probed_files: files.filter((file) => file.status === "probed").length,
    crossers_missing: Number(probe.crossers_missing ?? 0),
    open_active_missing: Number(probe.open_active_missing ?? 0),
    skipped_modules: Object.values(coverage.skipped_by_type).reduce((a, b) => a + b, 0),
  };
  const computeMs = Math.round((performance.now() - started) * 100) / 100;
  const path = await writeShadowRecord(root, "asof_probe", { ...keyInputs, coverage }, { surface: "subject_set", plan_ref: planRef, compute_ms: computeMs, counts, coverage, probe });
  return { path, counts };
}
