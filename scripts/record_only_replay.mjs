#!/usr/bin/env node
// Replay the record-only detectors over saved result folders, read only.
//
//   node scripts/record_only_replay.mjs <out-dir> <result-folder>...
//
// Result folders are only read: claims, computations, data and origins,
// visualizations, page plans and lints. Conversation, prompt, session, config
// and per-turn files are never opened. Everything the detectors write goes to
// <out-dir>/<n>/shadow/, and the two verifier records come from a verifier run
// on a copy of the artifact folders only. Prints one JSON summary on stdout.
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPageLint, recordVizLint } from "../runtime/pi/record_only.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PARTS = ["story.json", "claims.jsonl", "data", "sources", "computations", "visualizations", "infographics", "publications", "run_metrics.json"];
const env = Object.fromEntries(["EXTREME_WORDS", "CAVEATS", "ASOF_LISTS", "NUMBERS", "THIN_RESULT", "DROPPED_CONTENT", "ORIGIN_HASH", "CRITIC_VISION"].map((name) => [`NEWSROOM_RECORD_${name}`, "1"]));

const [outDir, ...folders] = process.argv.slice(2);
if (!outDir || !folders.length) { console.error("usage: record_only_replay.mjs <out-dir> <result-folder>..."); process.exit(2); }

async function json(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function names(dir) { try { return (await readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch { return []; } }

const summary = { folders: [], per_detector: {} };
let index = 0;
for (const folder of folders.map((f) => resolve(f))) {
  index += 1;
  const out = join(resolve(outDir), String(index));
  await mkdir(out, { recursive: true });
  const entry = { folder, out, charts: 0, pages: 0 };
  // Charts: every visualization lint (passed or not) with its plan and computation.
  for (const name of await names(join(folder, "visualizations", "lints"))) {
    const lint = await json(join(folder, "visualizations", "lints", name));
    if (!lint?.plan_ref) continue;
    const spec = await json(join(folder, lint.plan_ref));
    const computation = lint.computation_ref ? await json(join(folder, lint.computation_ref)) : null;
    if (!spec) continue;
    entry.charts += 1;
    await recordVizLint({ root: folder, out, spec, planRef: lint.plan_ref, rows: Array.isArray(computation?.rows) ? computation.rows : [], computationRef: lint.computation_ref }, env);
  }
  // Pages: every page plan.
  for (const name of await names(join(folder, "infographics", "plans"))) {
    const planRef = `infographics/plans/${name}`;
    const spec = await json(join(folder, planRef));
    if (!spec) continue;
    entry.pages += 1;
    await recordPageLint({ root: folder, out, spec, planRef }, env);
  }
  // Verifier records, from a copy that holds artifact folders only.
  const copy = await mkdtemp(join(tmpdir(), "record-replay-"));
  for (const part of ARTIFACT_PARTS) { try { await cp(join(folder, part), join(copy, part), { recursive: true }); } catch {} }
  const run = spawnSync("python3", [join(here, "verify_artifact.py"), copy], { env: { PATH: process.env.PATH, HOME: copy, ...env }, encoding: "utf8", timeout: 300000 });
  entry.verifier_exit = run.status;
  try { await cp(join(copy, "shadow"), join(out, "shadow"), { recursive: true }); } catch {}
  await rm(copy, { recursive: true, force: true });
  // Collect this folder's records.
  entry.records = {};
  for (const name of await names(join(out, "shadow"))) {
    const record = await json(join(out, "shadow", name));
    if (!record?.kind) continue;
    const kind = record.kind.replace(/^record_/, "");
    const bucket = (entry.records[kind] ??= []);
    bucket.push({ file: name, counts: record.counts ?? null, would_refuse: record.counts?.would_refuse ?? null, record });
  }
  summary.folders.push(entry);
}

// Per detector totals.
const refuseOf = (kind, record) => {
  const c = record.counts ?? {};
  switch (kind) {
    case "extreme_words": return c.would_refuse ?? 0;
    case "caveats": return (c.not_printed ?? 0) + (c.overwritten ?? 0);
    case "asof_lists": return c.status_filtered_sets ?? 0;
    case "numbers": return c.unmatched ?? c.mismatch ?? 0;
    case "thin_result": return c.thin_result ?? 0;
    case "dropped_content": return (c.sampled_queries ?? 0) + (c.series_misses ?? 0) + (c.dropped_modules ?? 0);
    case "origin_hash": return c.mismatches ?? 0;
    default: return 0;
  }
};
for (const entry of summary.folders) {
  for (const [kind, list] of Object.entries(entry.records)) {
    const slot = (summary.per_detector[kind] ??= { folders_with_records: 0, records: 0, would_refuse: 0, examples: [] });
    slot.folders_with_records += 1;
    for (const item of list) {
      slot.records += 1;
      const n = refuseOf(kind, item.record);
      slot.would_refuse += n;
      if (n > 0 && slot.examples.length < 3) slot.examples.push({ path: `${basename(entry.folder)}/shadow/${item.file}`, counts: item.counts });
    }
  }
  for (const list of Object.values(entry.records)) for (const item of list) delete item.record;
}
summary.needs_a_run = ["critic_vision (K124): reads the live model object", "dropped_content (b) when a folder has no refused plan before the final one"];
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
