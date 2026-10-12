#!/usr/bin/env node
// 1011aj step 8: reads that may follow a write in the same staged call. The evidence checks (a computation reference, a source snapshot, a data file
// and its sidecar) must see a file the call itself just wrote (still in its staging folder), must not see a parallel sibling's or another call's
// staging, and must be unchanged outside a staged call. Loads newsroom.ts from a type-stripped copy (same approach as test_atomic_artifact_runtime).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("staging-reads-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { runInStagedCall } = await import(join(pi, "groups.mjs"));
const { sourceContentHash } = await import(join(pi, "provenance.mjs"));

const run = join(tmp, "run");
mkdirSync(run, { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = run;
const staging = join(run, "staging");
const inCall = (id, fn) => runInStagedCall(id, join(staging, id), fn);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// the files each check needs
const comp = { a: 1 };
const sourceBody = { final_url: "https://example.org/a", status: 200, content_type: "text/plain", truncated: false, text: "hello" };
const source = { ...sourceBody, content_hash: sourceContentHash({ finalUrl: sourceBody.final_url, status: 200, contentType: "text/plain", truncated: false, text: "hello" }) };
const csv = Buffer.from("a,b\n1,2\n");
const hash = sha(csv);
const dataRef = `data/${hash}.csv`;
const writeAll = async () => {
  await mod.__writeArtifactIfAbsentForTest("computations/x.json", comp);
  await mod.__writeArtifactIfAbsentForTest("sources/s.json", source);
  await mod.__writeArtifactBytesIfAbsentForTest(dataRef, csv);
  await mod.__writeArtifactIfAbsentForTest(`${dataRef}.meta.json`, { schema_version: "0.7.0", bytes: csv.byteLength, sha256: hash, file: dataRef });
};
const ref = { comp: "computations/x.json", source: "sources/s.json", data: dataRef };
const checks = async () => {
  assert.deepEqual(await mod.__normalizeArtifactRefsForTest([ref.comp], "computation"), [ref.comp]);
  await mod.__validateSourceEvidenceForTest([ref.source]);
  await mod.__validateSourceEvidenceForTest([ref.data]);
};

// (1) same call: write, then every check sees it (reference stat, snapshot read, data stat + bytes + sidecar)
await inCall("c1", async () => { await writeAll(); await checks(); });

// (2) the files are only in the call's staging folder, not in the run folder yet
const { existsSync } = await import("node:fs");
assert.equal(existsSync(join(run, ref.comp)), false);
assert.equal(existsSync(join(staging, "c1", "own", "once", ref.comp)), true);

// (3) another call (a parallel sibling, or later) does not see them; the checks refuse as before
await inCall("c2", async () => {
  await assert.rejects(() => mod.__normalizeArtifactRefsForTest([ref.comp], "computation"), /computation reference does not exist/);
  await assert.rejects(() => mod.__validateSourceEvidenceForTest([ref.source]), /source snapshot is not valid JSON/);
  await assert.rejects(() => mod.__validateSourceEvidenceForTest([ref.data]), /ENOENT/);
});

// (4) a nested call sees its outer call's writes (chain visibility)
await inCall("c3", async () => {
  await mod.__writeArtifactIfAbsentForTest("computations/y.json", comp);
  await inCall("c3:inner", async () => assert.deepEqual(await mod.__normalizeArtifactRefsForTest(["computations/y.json"], "computation"), ["computations/y.json"]));
});

// (5) a staged data file whose sidecar disagrees is still refused (the check is not weakened by reading through the staging)
await inCall("c4", async () => {
  const bad = Buffer.from("x,y\n3,4\n");
  const badHash = sha(bad);
  const badRef = `data/${badHash}.csv`;
  await mod.__writeArtifactBytesIfAbsentForTest(badRef, bad);
  await mod.__writeArtifactIfAbsentForTest(`${badRef}.meta.json`, { schema_version: "0.7.0", bytes: 999, sha256: badHash, file: badRef });
  await assert.rejects(() => mod.__validateSourceEvidenceForTest([badRef]), /sidecar byte count differs/);
});

// (6) outside a staged call: plain run-folder reads (a file only in a staging folder is not there)
await assert.rejects(() => mod.__normalizeArtifactRefsForTest([ref.comp], "computation"), /computation reference does not exist/);
mkdirSync(join(run, "computations"), { recursive: true });
writeFileSync(join(run, ref.comp), JSON.stringify(comp));
assert.deepEqual(await mod.__normalizeArtifactRefsForTest([ref.comp], "computation"), [ref.comp]);

console.log("test_staging_reads: ok");
