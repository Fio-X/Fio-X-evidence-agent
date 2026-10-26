#!/usr/bin/env node
// The offline driver's prepared-set mode (scripts/drive_local_fetch.mjs): a compact TSV answers the dataset's SDMX-CSV data requests
// with the key's series in the periods asked, every value as written, a ":" cell giving no row, other URLs left to the records.
import assert from "node:assert/strict";
import { readSetTsv, tsvAnswer } from "./drive_local_fetch.mjs";

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
console.log("test_drive_local_fetch: ok");
