// NEWSROOM_DOWNLOAD_FROZEN=1 (exact "1", default off, replay tests only): download_data serves a URL listed in the run's own
// frozen-downloads/index.json from the frozen copy after checking its sha256; the data file's meta and the publication manifest carry
// the mark. Offline: fetch is a stub, bytes are local fixtures. The Rust side (verify finding, warning/error) is tested in src/verify.rs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

const tmp = mkdtempSync(join(tmpdir(), "download-frozen-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));

const URL_A = "http://8.8.8.8/data/a.csv", URL_B = "http://8.8.8.8/data/b.csv";
const BYTES_A = Buffer.from("year,total\n2020,10\n2021,12\n"), BYTES_B = Buffer.from("k,v\nx,1\n");
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const body = String(url) === URL_A ? BYTES_A : String(url) === URL_B ? BYTES_B : null;
  if (!body) return new Response("nope", { status: 404 });
  const res = new Response(body, { status: 200, headers: { "content-type": "text/csv", "content-length": String(body.length) } });
  Object.defineProperty(res, "url", { value: String(url) });
  return res;
};
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const download = tools.get("download_data");
ok(download, "download_data registered");
const newRun = (name) => {
  const dir = join(tmp, name);
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(dir, d), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  return dir;
};
const meta = (dir, bytes) => JSON.parse(readFileSync(join(dir, `data/${sha(bytes)}.csv.meta.json`), "utf8"));
const text = (out) => out.content.map((c) => c.text).join("\n");
const OLD_KEYS = ["bytes", "file", "schema_version", "sha256"];

// recorded run (live, stub fetch) = what a frozen folder is built from
const recorded = newRun("recorded-20260101T000000000Z-topic");
delete process.env.NEWSROOM_DOWNLOAD_FROZEN;
const liveOut = await download.execute("d", { url: URL_A });
eq(Object.keys(meta(recorded, BYTES_A)).sort(), OLD_KEYS, "1: switch unset: meta has the four old fields");
eq(fetchCalls, [URL_A], "1: switch unset: fetch is called");
const originRef = /Origin: (\S+)/.exec(text(liveOut))[1].replace(`${recorded}/`, "");
// the tool text names files by absolute path; the replay driver masks the run folder, so do the same
const masked = (out, dir) => text(out).split(dir).join("<RUN>");
const recordedOrigin = readFileSync(join(recorded, originRef), "utf8");

// frozen folder, as the relay puts it into a new run before request 1
const freeze = (dir, entries) => {
  mkdirSync(join(dir, "frozen-downloads/files"), { recursive: true });
  mkdirSync(join(dir, "frozen-downloads/origins"), { recursive: true });
  writeFileSync(join(dir, "frozen-downloads/files", `${sha(BYTES_A)}.csv`), BYTES_A);
  writeFileSync(join(dir, "frozen-downloads/origins", originRef.split("/").pop()), recordedOrigin);
  writeFileSync(join(dir, "frozen-downloads/index.json"), JSON.stringify({ schema_version: "1", entries }));
};
const entryA = { url: URL_A, file: `files/${sha(BYTES_A)}.csv`, sha256: sha(BYTES_A), origin_file: `origins/${originRef.split("/").pop()}`, recorded_run_id: "recorded-20260101T000000000Z-topic" };

for (const v of ["0", "true", "", "yes"]) {
  const dir = newRun(`off-${v || "empty"}`); freeze(dir, [entryA]); process.env.NEWSROOM_DOWNLOAD_FROZEN = v; fetchCalls = [];
  await download.execute("d", { url: URL_A });
  eq(fetchCalls, [URL_A], `1: value '${v}' is not on: fetch is called`);
  eq(Object.keys(meta(dir, BYTES_A)).sort(), OLD_KEYS, `1: value '${v}': meta unchanged`);
}

// 2: switch 1, URL not listed: still downloads
process.env.NEWSROOM_DOWNLOAD_FROZEN = "1";
const run2 = newRun("unlisted"); freeze(run2, [entryA]); fetchCalls = [];
await download.execute("d", { url: URL_B });
eq(fetchCalls, [URL_B], "2: unlisted URL is fetched");
eq(Object.keys(meta(run2, BYTES_B)).sort(), OLD_KEYS, "2: unlisted URL: plain meta");

// 3: switch 1, listed: no fetch, identical result text, meta marks
const run3 = newRun("replay"); freeze(run3, [entryA]); fetchCalls = [];
const frozenOut = await download.execute("d", { url: URL_A });
eq(fetchCalls, [], "3: no fetch for a listed URL");
eq(masked(frozenOut, run3), masked(liveOut, recorded), "3: model-visible result is byte-identical to the recording (run folder masked)");
const m3 = meta(run3, BYTES_A);
eq(m3.served_from, "frozen_copy"); eq(m3.frozen_sha256, sha(BYTES_A)); eq(m3.recorded_run_id, entryA.recorded_run_id);
ok(!Object.keys(m3).some((k) => /time|date|fetched/i.test(k)), "3: no fetch time is written");
eq(readFileSync(join(run3, originRef), "utf8"), recordedOrigin, "3: origin record equals the recorded one (so the record-origin-hash check still matches its name)");
eq(sha(JSON.stringify(JSON.parse(recordedOrigin))), originRef.split("/").pop().replace(/\.json$/, ""), "3: the recorded origin hash equals its file name");
eq(JSON.parse(readFileSync(join(run3, originRef), "utf8")).origin, "download", "3: origin record still says download");

// 4: listed file whose bytes differ from the index sha256: refused, nothing written
const run4 = newRun("mismatch"); freeze(run4, [entryA]);
writeFileSync(join(run4, "frozen-downloads", entryA.file), Buffer.from("tampered"));
fetchCalls = [];
await assert.rejects(() => download.execute("d", { url: URL_A }), /FROZEN_COPY_MISMATCH/); n++;
eq(fetchCalls, [], "4: refusal does not fall back to the network");
eq(readdirSync(join(run4, "data")), [], "4: nothing written under data/");

// 4c: a recorded origin record that does not match its name is refused; so is a frozen copy over the size limit
const run4c = newRun("origin-tamper"); freeze(run4c, [entryA]);
writeFileSync(join(run4c, "frozen-downloads", entryA.origin_file), JSON.stringify({ ...JSON.parse(recordedOrigin), final_url: "http://8.8.8.8/other" }));
await assert.rejects(() => download.execute("d", { url: URL_A }), /FROZEN_COPY_MISMATCH/); n++;
eq(readdirSync(join(run4c, "data")), [], "4c: origin tamper: nothing written");
const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
const run4d = newRun("too-big"); freeze(run4d, [{ ...entryA, sha256: sha(big) }]);
writeFileSync(join(run4d, "frozen-downloads", entryA.file), big);
await assert.rejects(() => download.execute("d", { url: URL_A }), /25 MB/); n++;
eq(readdirSync(join(run4d, "data")), [], "4d: over the size limit: nothing written");

// 4b: an index entry that points outside frozen-downloads/ is not listed (the URL downloads)
const run4b = newRun("escape"); freeze(run4b, [{ ...entryA, file: "../data/x.csv" }]); fetchCalls = [];
await download.execute("d", { url: URL_A });
eq(fetchCalls, [URL_A], "4b: unsafe index path: treated as unlisted");

// 7: the manifest mark comes from the run's meta files only
const mark = mod.__frozenDataMarkForTest;
eq(await mark(run3), { replay: "frozen_data", frozen_data_sha256: [sha(BYTES_A)] }, "7: frozen run is marked with the sorted sha list");
eq(await mark(recorded), {}, "7: live run: neither field");
eq(await mark(run2), {}, "7: run whose only download was unlisted: neither field");
delete process.env.NEWSROOM_DOWNLOAD_FROZEN;
eq(await mark(run3), { replay: "frozen_data", frozen_data_sha256: [sha(BYTES_A)] }, "7: unsetting the switch cannot remove the mark");
const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const writers = src.match(/writeArtifactIfAbsent\(manifestRef, \{ \.\.\.rendered\.manifest,[^\n]*/g) ?? [];
eq(writers.length, 2, "7: two publication manifest writers");
ok(writers.every((line) => line.includes("...(await frozenDataMark(artifactRoot()))")), "7: both writers add the mark");

console.log(`test_download_frozen: ok (${n} assertions)`);
