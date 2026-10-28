#!/usr/bin/env node
// The offline driver's prepared-set mode (scripts/drive_local_fetch.mjs): a compact TSV answers the dataset's SDMX-CSV data requests
// with the key's series in the periods asked, every value as written, a ":" cell giving no row, other URLs left to the records.
import assert from "node:assert/strict";
import { originRecords, readSetTsv, setFor, setList, tsvAnswer } from "./drive_local_fetch.mjs";
import { buildRoot } from "./drive_tsv_set.mjs";

const tsv = ["freq,unit,airpol,geo\\TIME_PERIOD\t2022 \t2023 \t2024 ", "A,MIO_T,GHG,AT\t70.1 \t68.67406 \t66.63783 p", "A,MIO_T,GHG,DE\t700 \t: \t649.76952 ", "A,THS_T,GHG,AT\t70100 \t68674.06 \t66637.83 p", "A,MIO_T,CH4,AT\t1 \t2 \t3 "].join("\n") + "\n";
const set = { dataset: "env_air_gge" };
const base = "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data";
const csv = tsvAnswer(`${base}/env_air_gge/A.MIO_T.GHG.AT+DE?format=SDMX-CSV&startPeriod=2023&endPeriod=2024`, set, tsv);
assert.deepEqual(csv.trim().split("\n"), [
  "DATAFLOW,LAST UPDATE,freq,unit,airpol,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG,CONF_STATUS",
  "ESTAT:ENV_AIR_GGE(1.0),,A,MIO_T,GHG,AT,2023,68.67406,,",
  "ESTAT:ENV_AIR_GGE(1.0),,A,MIO_T,GHG,AT,2024,66.63783,p,",
  "ESTAT:ENV_AIR_GGE(1.0),,A,MIO_T,GHG,DE,2024,649.76952,,",
]);
// an empty key part is every code of that dimension; no period bound is every period
assert.equal(tsvAnswer(`${base}/ENV_AIR_GGE/A..GHG.AT?format=SDMX-CSV`, set, tsv).trim().split("\n").length, 1 + 6);
assert.throws(() => tsvAnswer(`${base}/env_air_gge/A.MIO_T.AT?format=SDMX-CSV`, set, tsv), /3 parts and env_air_gge has 4 dimensions/);
for (const other of [`${base}/sdg_07_40/A.REN.PC.AT?format=SDMX-CSV`, `${base}/env_air_gge/A.MIO_T.GHG.AT?format=TSV`, "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/codelist/ESTAT/GEO/latest"]) {
  assert.equal(tsvAnswer(other, set, tsv), null, other);
}
assert.equal(tsvAnswer(`${base}/env_air_gge/A.MIO_T.GHG.AT?format=SDMX-CSV`, null, tsv), null, "no prepared set: the records only");
// the TSV's hash is computed from the file: a set whose stated hash differs is refused
{
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-fetch-"));
  const file = path.join(dir, "set.tsv");
  fs.writeFileSync(file, tsv);
  const good = { dataset: "env_air_gge", tsv: file, sha256: createHash("sha256").update(tsv).digest("hex") };
  assert.equal(readSetTsv(good), tsv);
  assert.throws(() => readSetTsv({ ...good, sha256: "0".repeat(64) }), /hashes to [0-9a-f]{64}, the set says 0{64}/);
  fs.rmSync(dir, { recursive: true });
}
// several sets: a data URL goes to its own dataset's set, any other URL to none; one set object is a list of one; a dataset twice is refused
{
  const two = setList({ sets: [{ dataset: "env_air_gge" }, { dataset: "sdg_07_40" }] });
  assert.equal(setFor(`${base}/SDG_07_40/A.REN.PC.AT?format=SDMX-CSV`, two).dataset, "sdg_07_40");
  assert.equal(setFor(`${base}/env_air_gge/A.MIO_T.GHG.AT?format=SDMX-CSV`, two).dataset, "env_air_gge");
  assert.equal(setFor(`${base}/nrg_ind_ren/A.REN.PC.AT?format=SDMX-CSV`, two), null);
  assert.equal(setFor("https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/datastructure/ESTAT/sdg_07_40/latest", two), null);
  assert.deepEqual(setList({ dataset: "env_air_gge" }), [{ dataset: "env_air_gge" }]);
  assert.throws(() => setList({ sets: [{ dataset: "sdg_07_40" }, { dataset: "SDG_07_40" }] }), /lists SDG_07_40 twice/);
}
// the root builder: structure and codelist records copied with their files, the data TSV named with its checked hash, a URL held by two
// dirs kept from the first and a differing second body listed
{
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drive-set-"));
  const api = "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1";
  const dir = (dataset, files) => {
    const d = path.join(tmp, "v2", dataset);
    fs.mkdirSync(path.join(d, "data", "origins"), { recursive: true });
    const downloads = [];
    for (const [url, ext, body] of files) {
      const h = sha(body);
      fs.writeFileSync(path.join(d, "data", `${h}.${ext}`), body);
      fs.writeFileSync(path.join(d, "data", "origins", `${sha(url)}.json`), JSON.stringify({ requested_url: url, final_url: url, content_type: "text/plain", sha256: h, file: `data/${h}.${ext}` }));
      downloads.push({ url, sha256: h, downloaded_at: "2026-10-27T00:00:00+08:00" });
    }
    fs.writeFileSync(path.join(d, "downloads.json"), JSON.stringify(downloads));
    return d;
  };
  const geo = `${api}/codelist/ESTAT/GEO/latest?format=TSV&compressed=false&lang=en`;
  const a = dir("env_air_gge", [[`${api}/datastructure/ESTAT/env_air_gge/latest`, "xml", "<a/>"], [geo, "tsv", "AT\tAustria\n"], [`${api}/data/ENV_AIR_GGE/?format=TSV&compressed=false`, "tsv", tsv]]);
  const b = dir("sdg_07_40", [[`${api}/datastructure/ESTAT/sdg_07_40/latest`, "xml", "<b/>"], [geo, "tsv", "AT\tAustria\nDE\tGermany\n"], [`${api}/data/SDG_07_40/?format=TSV&compressed=false`, "tsv", "x\n"]]);
  const out = path.join(tmp, "root");
  const { sets, differing } = buildRoot(out, [a, b]);
  assert.deepEqual(sets.map((s) => [s.dataset, s.sha256]), [["env_air_gge", sha(tsv)], ["sdg_07_40", sha("x\n")]]);
  assert.deepEqual(setList(JSON.parse(fs.readFileSync(path.join(out, "tsv-set.json"), "utf8"))).map((s) => s.tsv), [path.join(a, "data", `${sha(tsv)}.tsv`), path.join(b, "data", `${sha("x\n")}.tsv`)]);
  const records = fs.readdirSync(path.join(out, "data", "origins")).map((n) => JSON.parse(fs.readFileSync(path.join(out, "data", "origins", n), "utf8")));
  assert.equal(records.length, 3, "two structures and one GEO, no data TSV");
  assert.ok(records.every((r) => fs.readFileSync(path.join(out, r.file), "utf8").length > 0 && !/\/data\//.test(r.requested_url)));
  assert.equal(fs.readFileSync(path.join(out, records.find((r) => r.requested_url === geo).file), "utf8"), "AT\tAustria\n");
  assert.deepEqual(differing.map((d) => [d.url, d.from]), [[geo, "sdg_07_40"]]);
  assert.throws(() => buildRoot(out, [a]), /is not empty/);
  fs.writeFileSync(path.join(b, "data", `${sha("x\n")}.tsv`), "changed\n");
  assert.throws(() => buildRoot(path.join(tmp, "root2"), [b]), /hashes to [0-9a-f]{64}, downloads.json says/);
  fs.rmSync(tmp, { recursive: true });
}
// a run that downloaded nothing (q7 of b2: none of the tables fits) has no data/origins: no records, and node still starts with the
// driver loaded against it, so each fetch gets its 404 instead of the tool host dying at start
{
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "drive-empty-"));
  assert.equal(originRecords(run).size, 0);
  assert.equal(originRecords(undefined).size, 0);
  // a mistyped run path is refused, never read as a run that downloaded nothing
  assert.throws(() => originRecords(path.join(run, "no-such-run")), /no-such-run does not exist/);
  const started = spawnSync(process.execPath, [`--import=${new URL("./drive_local_fetch.mjs", import.meta.url).pathname}`, "-e", "console.log('started')"], { env: { ...process.env, NEXT_DRIVE_FETCH_FROM: run }, encoding: "utf8" });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout.trim(), "started");
  fs.rmSync(run, { recursive: true });
}
console.log("test_drive_local_fetch: ok");
