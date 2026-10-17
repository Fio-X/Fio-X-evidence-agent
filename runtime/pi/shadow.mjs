// Shadow records: observation without consequence.
//
// A shadow record measures something that might one day become a gate
// without ever changing what a run produces. The contract:
//
// - It never touches `lint.warnings`, `lint.blockers`, a lint/computation
//   artifact, the model-visible text, or any gate. The only things it writes
//   are side files under `<artifact root>/shadow/`, keyed by the hash of the
//   shadow's OWN inputs, so a rerun writes the same name (the file is created
//   once and never rewritten) and no immutable artifact can collide.
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
import { recordBoundaryWrite, trackExport } from "./groups.mjs";
import { asShadowWriter } from "./shadow_writer.mjs";

export const SHADOW_DIR = "shadow";
export const SHADOW_SCHEMA_VERSION = "1.0.0";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export let shadowKey = (inputs) => createHash("sha256").update(stable(inputs)).digest("hex");

/**
 * Write a shadow record once under shadow/. Returns the relative path. An
 * existing file is left alone (it was produced by identical inputs).
 */
export function writeShadowRecord(root, kind, keyInputs, record) {
  // the knowledge group's shadow_writer saves the file for the asking tool (kept as requested_by). Same path, same bytes.
  return asShadowWriter(() => saveShadowRecord(root, kind, keyInputs, record));
}

async function saveShadowRecord(root, kind, keyInputs, record) {
  const key = shadowKey({ kind, ...keyInputs });
  const relativePath = `${SHADOW_DIR}/${kind}-${key}.json`;
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  recordBoundaryWrite(root, relativePath, "write_if_absent");
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

// K315: report-only record of tools reaching this module's exports (key shadow.mjs::name). test_k315_export_wrap pins this list.
{
  shadowKey = trackExport("shadow.mjs::shadowKey", shadowKey);
  runShadow = trackExport("shadow.mjs::runShadow", runShadow);
}
