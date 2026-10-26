// Offline driver only (src/next_drive.rs, NEXT_DRIVE_FETCH_FROM): node loads this before the tool host, so every fetch is answered
// from a finished run's downloads (its data/origins records, by requested URL) and nothing goes to the network. A URL with no record
// gets a 404 and a line in NEXT_DRIVE_FETCH_LOG, so a missing download shows as one, never as a guess.
// A prepared set (tsv-set.json next to data/: one Eurostat compact TSV of a whole dataset) also answers that dataset's SDMX-CSV data
// requests: the series the key selects, in the periods asked, are moved cell by cell into SDMX-CSV rows (no value is changed or
// computed; a ":" cell has no observation and gives no row), and the log line names the TSV's hash and the answer's.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.env.NEXT_DRIVE_FETCH_FROM;
const log = process.env.NEXT_DRIVE_FETCH_LOG;
const byUrl = new Map();
for (const name of root ? fs.readdirSync(path.join(root, "data", "origins")) : []) {
  const origin = JSON.parse(fs.readFileSync(path.join(root, "data", "origins", name), "utf8"));
  byUrl.set(origin.requested_url, origin);
}
const setFile = root && path.join(root, "tsv-set.json");
const set = setFile && fs.existsSync(setFile) ? JSON.parse(fs.readFileSync(setFile, "utf8")) : null;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The SDMX-CSV answer to a data URL of the prepared set's dataset, or null for any other URL. */
export function tsvAnswer(url, set, tsvText) {
  const m = /\/sdmx\/2\.1\/data\/([^/?]+)\/([^?]*)(?:\?(.*))?$/.exec(url);
  if (!set || !m || m[1].toLowerCase() !== set.dataset.toLowerCase()) return null;
  const params = new URLSearchParams(m[3] ?? "");
  if (params.get("format") !== "SDMX-CSV") return null;
  const [head, ...lines] = tsvText.split("\n").filter((line) => line.trim());
  const [dimCell, ...periodCells] = head.split("\t");
  const dims = dimCell.split("\\")[0].split(",");
  const periods = periodCells.map((p) => p.trim());
  const key = m[2].split(".");
  if (key.length !== dims.length) throw new Error(`the key ${m[2]} has ${key.length} parts and ${set.dataset} has ${dims.length} dimensions`);
  const allowed = key.map((part) => (part ? new Set(part.split("+")) : null));
  const [start, end] = [params.get("startPeriod"), params.get("endPeriod")];
  const inPeriod = (p) => (!start || p >= start) && (!end || p <= end);
  const rows = [["DATAFLOW", "LAST UPDATE", ...dims, "TIME_PERIOD", "OBS_VALUE", "OBS_FLAG", "CONF_STATUS"].join(",")];
  for (const line of lines) {
    const [codeCell, ...cells] = line.split("\t");
    const codes = codeCell.split(",");
    if (!codes.every((code, i) => !allowed[i] || allowed[i].has(code))) continue;
    cells.forEach((cell, i) => {
      const [value, flag = ""] = cell.trim().split(/\s+/);
      if (value === ":" || !inPeriod(periods[i])) return;
      rows.push([`ESTAT:${set.dataset.toUpperCase()}(1.0)`, "", ...codes, periods[i], value, flag, ""].join(","));
    });
  }
  return rows.join("\n") + "\n";
}

let tsvText = null;
// Imported by a test without a run: the converter only, the real fetch stays.
if (root) globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  const origin = byUrl.get(url);
  if (!origin && set) {
    tsvText ??= fs.readFileSync(set.tsv, "utf8");
    const csv = tsvAnswer(url, set, tsvText);
    if (csv !== null) {
      if (log) fs.appendFileSync(log, `converted ${url} from ${set.sha256} (${set.source_url}) to ${sha256(csv)}\n`);
      const response = new Response(csv, { status: 200, headers: { "content-type": "application/vnd.sdmx.data+csv;version=1.0.0" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
  }
  if (log) fs.appendFileSync(log, `${origin ? "local" : "missing"} ${url}\n`);
  const response = origin
    ? new Response(fs.readFileSync(path.join(root, origin.file)), { status: 200, headers: { "content-type": origin.content_type } })
    : new Response("not in the local downloads", { status: 404, headers: { "content-type": "text/plain" } });
  // A built Response has no url; the runtime reads it (the final address after redirects).
  Object.defineProperty(response, "url", { value: origin?.final_url ?? url });
  return response;
};
