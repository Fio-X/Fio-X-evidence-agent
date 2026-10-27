#!/usr/bin/env node
// Offline driver only: node scripts/drive_tsv_set.mjs <out root> <dataset dir>... builds the "finished run" NEXT_DRIVE_FETCH_FROM
// reads (scripts/drive_local_fetch.mjs) from whole-dataset downloads, one dir per dataset in a run's data/ layout (data/<sha>.<ext>,
// data/origins/*.json, downloads.json). Every structure and codelist record is copied with its file; the data TSV stays where it is
// and is named in tsv-set.json with its hash, which is checked against the file here and again by the shim. A URL two dirs both
// hold is kept from the first; a different body under it is listed, never merged.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Builds the root; returns the sets written and the URLs whose second body differed from the first. */
export function buildRoot(out, dirs) {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
  fs.mkdirSync(path.join(out, "data", "origins"), { recursive: true });
  const kept = new Map();
  const differing = [];
  const sets = [];
  for (const dir of dirs) {
    const dataset = path.basename(path.resolve(dir));
    const downloads = JSON.parse(fs.readFileSync(path.join(dir, "downloads.json"), "utf8"));
    const data = downloads.filter((d) => /\/sdmx\/2\.1\/data\//.test(d.url));
    if (data.length !== 1) throw new Error(`${dir} has ${data.length} data downloads, not one`);
    const [download] = data;
    for (const name of fs.readdirSync(path.join(dir, "data", "origins")).sort()) {
      const origin = JSON.parse(fs.readFileSync(path.join(dir, "data", "origins", name), "utf8"));
      if (origin.requested_url === download.url) continue;
      const bytes = fs.readFileSync(path.join(dir, origin.file));
      if (sha256(bytes) !== origin.sha256) throw new Error(`${dir}/${origin.file} does not hash to its record's ${origin.sha256}`);
      const first = kept.get(origin.requested_url);
      if (first) {
        if (first !== origin.sha256) differing.push({ url: origin.requested_url, kept: first, dropped: origin.sha256, from: dataset });
        continue;
      }
      kept.set(origin.requested_url, origin.sha256);
      fs.writeFileSync(path.join(out, origin.file), bytes);
      fs.writeFileSync(path.join(out, "data", "origins", `${sha256(origin.requested_url)}.json`), JSON.stringify(origin, null, 1) + "\n");
    }
    const tsv = path.resolve(dir, "data", `${download.sha256}.tsv`);
    const actual = sha256(fs.readFileSync(tsv));
    if (actual !== download.sha256) throw new Error(`${tsv} hashes to ${actual}, downloads.json says ${download.sha256}`);
    sets.push({ dataset, tsv, sha256: download.sha256, source_url: download.url, downloaded_at: download.downloaded_at });
  }
  fs.writeFileSync(path.join(out, "tsv-set.json"), JSON.stringify({ sets }, null, 1) + "\n");
  return { sets, differing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [out, ...dirs] = process.argv.slice(2);
  if (!out || !dirs.length) {
    console.error("usage: drive_tsv_set.mjs <out root> <dataset dir>...");
    process.exit(2);
  }
  const { sets, differing } = buildRoot(out, dirs);
  console.log(JSON.stringify({ sets: sets.map((s) => s.dataset), records: fs.readdirSync(path.join(out, "data", "origins")).length, differing }));
}
