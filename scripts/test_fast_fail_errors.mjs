// Fast-fail errors (one bounded round): a model that hits a wall should be able
// to fix it in one turn. No network, no model API: fetch is a stub and the 30 s
// download timer is shortened by wrapping setTimeout for that one delay.
//   1. download_data: a timeout is a structured DOWNLOAD_TIMEOUT (host, elapsed
//      seconds, one generic hint). The first timeout allows one identical retry; after the
//      second the exact request (query order and fragment aside) is refused for the rest of
//      the run. The error carries no cause, query string or body; a body-read timeout counts
//      toward the host circuit like a header timeout.
//   2. EDITORIAL_GRAMMAR_BLOCKED also names the relations that accept the chosen
//      chart type, read from the same table; the block itself is unchanged.
//   3. One explanatory_dimension vocabulary: every tool that takes it for a module
//      accepts every value the story graph accepts, the publication plan maps
//      relationship -> network through one shared function, and every
//      "unsupported explanatory_dimension" error lists the allowed values.
//      Semantic novelty scoring is pinned by a digest taken on the commit before
//      the change (regenerate with: node scripts/test_fast_fail_errors.mjs
//      --novelty-digest <dir holding editorial.mjs>).
//   4. quantity_kind (infographic plan) carries one clause of at most 160 bytes
//      mapping the values a model reaches for onto the enum; the enum is unchanged.
//   5. Each tool's explanatory_dimension enum is pinned exactly, with the set it had before 83d5ad1.
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import { withoutRunTraces } from "./lib_run_traces.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
const check = (name) => { results.push(name); };

// Semantic novelty scoring over the ten dimensions the tool accepted before item 3: every ordered
// pair x six overlap profiles x a third module. The digest of the full artifacts is pinned below.
const NOVELTY_ORIGINAL_DIMENSIONS = ["trend", "rank", "spatial", "mechanism", "comparison", "distribution", "uncertainty", "human_scale", "method", "context"];
function noveltyMatrixDigest(scoreSemanticNovelty) {
  const same = { q: "q1", claims: ["c1", "c2"], text: "tariff share of exports by partner" };
  const profiles = [
    { a: same, b: { q: "q2", claims: ["c3"], text: "port congestion delays shipments" } },
    { a: same, b: same },
    { a: same, b: { ...same, claims: ["c3", "c4"], text: "something else entirely" } },
    { a: same, b: { ...same, claims: ["c1", "c3"], text: "tariff share of imports by partner" } },
    { a: same, b: { ...same }, dependent: true },
    { a: same, b: { ...same }, justified: true },
  ];
  const artifacts = [];
  for (let i = 0; i < NOVELTY_ORIGINAL_DIMENSIONS.length; i++) {
    for (let j = 0; j < NOVELTY_ORIGINAL_DIMENSIONS.length; j++) {
      for (const p of profiles) {
        const module = (id, side, dimension, extra = {}) => ({ id, reader_question_id: side.q, claim_set: side.claims, new_information: side.text, explanatory_dimension: dimension, ...extra });
        artifacts.push(scoreSemanticNovelty({
          concept_ref: "editorial/concepts/x.json",
          modules: [
            module("a", p.a, NOVELTY_ORIGINAL_DIMENSIONS[i]),
            module("b", p.b, NOVELTY_ORIGINAL_DIMENSIONS[j], { ...(p.dependent ? { dependency_on: ["a"] } : {}), ...(p.justified ? { justification: "kept on purpose" } : {}) }),
            module("c", { q: "q1", claims: ["c2", "c9"], text: "tariff share of exports" }, NOVELTY_ORIGINAL_DIMENSIONS[(i + j) % NOVELTY_ORIGINAL_DIMENSIONS.length]),
          ],
        }));
      }
    }
  }
  return { count: artifacts.length, digest: createHash("sha256").update(JSON.stringify(artifacts)).digest("hex") };
}
if (process.argv[2] === "--novelty-digest") {
  const editorial = await import(pathToFileURL(join(process.argv[3], "editorial.mjs")).href);
  console.log(JSON.stringify(noveltyMatrixDigest(editorial.scoreSemanticNovelty)));
  process.exit(0);
}

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
// One copy of runtime/ and config/ with the two Pi packages stubbed. Importing the test copy
// with a different query string gives a fresh newsroom.ts instance (fresh module-level state).
const treeDir = makeTestTmp("fast-fail-tree-");
cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
stub(treeDir, "typebox", TYPEBOX);
stub(treeDir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const testCopy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(testCopy, stripTypeScriptTypes(readFileSync(join(treeDir, "runtime", "pi", "newsroom.ts"), "utf8"), { mode: "strip" }));
let instance = 0;
async function freshTools(extraEnv = {}) {
  const mod = await import(`${pathToFileURL(testCopy).href}?instance=${++instance}`);
  const env = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_MOBILE_PAGES: undefined, ...extraEnv };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);

const evidenceGate = await import(join(ROOT, "runtime/pi/evidence_gate.mjs"));
const { DOWNLOAD_TIMEOUT_HINT, createDownloadTimeoutGuard, createSourceAccessCircuit, downloadRequestKey } = evidenceGate;

// ---------------------------------------------------------------- 1. download timeout
const HINT = "One identical retry is allowed; after a second timeout that exact request is refused for the rest of this run. Prefer splitting it into smaller requests (fewer series or a shorter period each) and combining them in SQL, but every series and period the question needs must still be fetched. For SDMX APIs (ECB, Eurostat, OECD, IMF, BIS) add `detail=dataonly`; or use another source.";
assert.equal(DOWNLOAD_TIMEOUT_HINT, HINT, "the hint is the one generic text");
for (const part of ["One identical retry is allowed", "after a second timeout that exact request is refused for the rest of this run", "splitting it into smaller requests", "combining them in SQL", "every series and period the question needs must still be fetched", "`detail=dataonly`", "or use another source"]) assert.ok(HINT.includes(part), `the hint says: ${part}`);

// Pure guard: shape, repeat key, pass-through rules.
{
  const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const guard = createDownloadTimeoutGuard(30_000);
  const ecb = { method: "GET", url: "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2000", body: "" };
  const error = guard.recordTimeout(ecb, 30_120, abort);
  assert.equal(error.code, "DOWNLOAD_TIMEOUT");
  assert.equal(error.host, "data-api.ecb.europa.eu");
  assert.equal(error.elapsed_seconds, 30.1);
  assert.equal(error.message, `DOWNLOAD_TIMEOUT: data-api.ecb.europa.eu did not finish the download in 30.1 s (limit 30 s). ${HINT}`);
  check("timeout error carries code, host, elapsed seconds and the one generic hint");

  const repeat = (request) => { try { guard.assertNotRepeat(request); return null; } catch (e) { return e; } };
  assert.equal(repeat(ecb), null, "after the first timeout one identical retry is allowed");
  assert.equal(guard.recordTimeout(ecb, 31_000, abort).code, "DOWNLOAD_TIMEOUT", "the retry that times out again is still the structured timeout");
  const refused = repeat(ecb);
  assert.equal(refused?.code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.match(refused.message, /^DOWNLOAD_TIMEOUT_REPEAT: this exact request to data-api\.ecb\.europa\.eu timed out 2 times \(the last after 31\.0 s\), so it is refused for the rest of this run and was not sent again; the count starts over with the next CLI run\. /);
  assert.ok(refused.message.endsWith(HINT));
  assert.equal(repeat(ecb)?.code, "DOWNLOAD_TIMEOUT_REPEAT", "and it stays refused");
  check("first timeout allows one identical retry; the second timeout refuses the exact request for the rest of the run");

  const timedTwice = (request) => { guard.recordTimeout(request, 5, abort); guard.recordTimeout(request, 5, abort); };
  timedTwice({ method: "GET", url: "https://k.example/x?b=2&a=1&a=0" });
  assert.ok(repeat({ method: "GET", url: "https://k.example/x?a=1&a=0&b=2" }), "moving a different name is the same request (repeated names keep their own order)");
  assert.ok(repeat({ method: "get", url: "HTTPS://K.EXAMPLE:443/x?a=1&a=0&b=2#frag" }), "scheme and host case, a default port and a fragment do not make a new request");
  assert.equal(repeat({ method: "GET", url: "https://k.example/x?a=0&a=2&b=2" }), null, "a different value is a different request");
  assert.equal(repeat({ method: "GET", url: "https://k.example/x?a=1&b=2" }), null, "a repeated name that is dropped is a different request");
  assert.equal(repeat({ method: "GET", url: "https://k.example:8443/x?a=0&a=1&b=2" }), null, "a non-default port is a different request");
  assert.equal(repeat({ method: "GET", url: "https://k.example/X?a=0&a=1&b=2" }), null, "the path stays case-sensitive");
  assert.equal(repeat({ method: "POST", url: "https://k.example/x?a=0&a=1&b=2" }), null);
  assert.equal(repeat({ method: "GET", url: "https://k.example/x?a=0&a=1&b=2", body: "{}" }), null);
  assert.equal(downloadRequestKey({ method: "GET", url: "https://k.example/x?b=2&a=1" }), downloadRequestKey({ method: "GET", url: "https://k.example/x?a=1&b=2" }));
  assert.notEqual(downloadRequestKey({ method: "GET", url: "https://k.example/x?a=1&b=2" }), downloadRequestKey({ method: "GET", url: "https://k.example/x?a=1&b=3" }));
  assert.notEqual(downloadRequestKey({ method: "GET", url: "https://k.example/x?a=1&a=2" }), downloadRequestKey({ method: "GET", url: "https://k.example/x?a=2&a=1" }), "repeated names keep their order: a first- or last-value server sees two requests");
  assert.equal(downloadRequestKey({ method: "GET", url: "https://k.example/x?b=1&a=1" }), downloadRequestKey({ method: "GET", url: "https://k.example/x?a=1&b=1" }), "different names still sort");
  assert.equal(repeat({ method: "GET", url: "https://k.example/x?a=0&b=2&a=1" }), null, "a=1 then a=0 is a different request from a=0 then a=1 (the timed one was b=2&a=1&a=0)");
  assert.equal(downloadRequestKey({ method: "GET", url: "not a url" }), "GET not a url\n", "an unparsable URL keeps its raw text");
  check("request key: query order, scheme and host case, default port and fragment are normalised; a changed value, name, port, path, method or body is a new request");

  const blocked = new Error("SOURCE_ACCESS_BLOCKED: 3 consecutive source-access attempts failed. Stop.");
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/blocked" }, 1, blocked), blocked, "the stop instruction is never softened");
  const other = new Error("HTTP 500 while downloading");
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/other" }, 1, other), other, "an error that is not the abort keeps its own text");
  assert.equal(repeat({ method: "GET", url: "https://a.example/other" }), null, "and does not poison the key");
  assert.equal(repeat({ method: "GET", url: "https://a.example/blocked" }), null);
  const flagged = Object.assign(new Error("SOURCE_ACCESS_FAILED: network evidence fetch timed out or was cancelled (1/3)."), { request_aborted: true });
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/wrapped" }, 5, flagged).code, "DOWNLOAD_TIMEOUT", "the circuit's abort is recognised through its flag");
  const unflagged = new Error("SOURCE_ACCESS_FAILED: network evidence fetch timed out or was cancelled (1/3).", { cause: abort });
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/unflagged" }, 5, unflagged), unflagged, "a cause is no longer walked: only the flag or the error's own name counts");
  check("SOURCE_ACCESS_BLOCKED and non-abort errors pass through unchanged");

  const circuit = createSourceAccessCircuit(2);
  assert.equal(circuit.isBlocked("h"), false);
  circuit.recordFailure("t", abort, "h");
  assert.equal(circuit.isBlocked("h"), false);
  const second = circuit.recordFailure("t", abort, "h");
  assert.equal(circuit.isBlocked("h"), true);
  assert.match(second.message, /^SOURCE_ACCESS_BLOCKED: 2 consecutive/);
  const failed = circuit.recordFailure("t", Object.assign(new Error("boom https://x.example/data?secret=1"), { name: "AbortError" }), "other");
  assert.equal(failed.request_aborted, true);
  assert.ok(!("cause" in failed), "the raw error is not kept as cause");
  assert.ok(!JSON.stringify(failed).includes("secret") && !failed.message.includes("secret") && !String(failed.stack).includes("secret"), "nothing of the raw error is carried");
  assert.ok(!("request_aborted" in circuit.recordFailure("t", new Error("HTTP 404"), "third")), "a non-abort failure carries no flag");
  assert.throws(() => circuit.assertAvailable("h"), /SOURCE_ACCESS_BLOCKED/);
  check("circuit gains a read-only isBlocked and carries a boolean abort flag instead of the raw cause; its messages are unchanged");
}

// Through download_data: fetch is a stub, the 30 s timer fires after 150 ms.
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const timerDelays = [];
globalThis.setTimeout = (fn, delay, ...rest) => {
  if (delay === 30_000) { timerDelays.push(delay); return realSetTimeout(fn, 150, ...rest); }
  return realSetTimeout(fn, delay, ...rest);
};
const abortError = () => new DOMException("This operation was aborted", "AbortError");
const hangsUntilAborted = (signal) => new Promise((_, reject) => {
  if (signal.aborted) reject(abortError());
  else signal.addEventListener("abort", () => reject(abortError()), { once: true });
});
const withUrl = (response, url) => { Object.defineProperty(response, "url", { value: url }); return response; };
const stalledBody = (url, signal) => withUrl(new Response(new ReadableStream({ start(c) { signal.addEventListener("abort", () => c.error(abortError()), { once: true }); } }), { status: 200, headers: { "content-type": "text/csv" } }), url);
let fetchCalls = [];
const stubFetch = (handler) => { fetchCalls = []; globalThis.fetch = (url, init) => { fetchCalls.push(String(url)); return handler(String(url), init); }; };

try {
  const artifact = join(makeTestTmp("fast-fail-art-"), "run");
  mkdirSync(artifact, { recursive: true });
  const tools = await freshTools({ NEWSROOM_ARTIFACT_DIR: artifact });
  const download = tools.get("download_data");
  assert.ok(download, "download_data is registered");
  const run = (url, extra = {}, signal) => download.execute("id", { url, ...extra }, signal);
  const message = async (promise) => { try { await promise; } catch (error) { return error; } assert.fail("expected the download to throw"); };

  // Body phase: headers arrive, the body never finishes (the round-2 symptom: a raw AbortError).
  const base = "http://203.0.113.7/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2000";
  stubFetch((url, init) => Promise.resolve(stalledBody(url, init.signal)));
  const first = await message(run(base));
  assert.equal(first.code, "DOWNLOAD_TIMEOUT");
  assert.notEqual(first.name, "AbortError");
  assert.match(first.message, /^DOWNLOAD_TIMEOUT: 203\.0\.113\.7 did not finish the download in \d+\.\d s \(limit 30 s\)\. /);
  assert.ok(first.message.endsWith(HINT));
  assert.equal(first.host, "203.0.113.7");
  assert.ok(first.elapsed_seconds >= 0.1 && first.elapsed_seconds < 5, `elapsed seconds are measured (${first.elapsed_seconds})`);
  assert.deepEqual(timerDelays, [30_000], "the abort timer is still 30 s");
  assert.equal(fetchCalls.length, 1);
  check("body-phase timeout: structured DOWNLOAD_TIMEOUT with host, elapsed seconds and hint, no raw AbortError");

  // The first timeout allows one identical retry; it goes to the network.
  const second = await message(run(base));
  assert.equal(second.code, "DOWNLOAD_TIMEOUT", "the allowed retry that times out again is the structured timeout");
  assert.equal(fetchCalls.length, 2, "the identical retry was sent");
  check("first timeout, then one identical retry is allowed and sent");

  // The second timeout refuses the exact request for the rest of the run; nothing reaches the network.
  const t0 = Date.now();
  const repeated = await message(run(base));
  assert.equal(repeated.code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.match(repeated.message, /timed out 2 times .* for the rest of this run .* next CLI run\. /);
  assert.ok(repeated.message.endsWith(HINT));
  assert.ok(Date.now() - t0 < 30, "refused before any network wait");
  assert.equal(fetchCalls.length, 2, "no third request was sent");
  assert.equal((await message(run(base, { filename: "other.csv" }))).code, "DOWNLOAD_TIMEOUT_REPEAT", "a new filename does not change what the server is asked");
  assert.equal((await message(run(`${base}#top`))).code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.equal(fetchCalls.length, 2);
  check("second timeout, then the exact request is refused at once with DOWNLOAD_TIMEOUT_REPEAT and the same hint");

  // The key is process memory only.
  assert.deepEqual(walk(artifact), [], "nothing was written to the investigation directory");
  check("the repeat key is never written to disk");

  // A changed request is allowed, and a download that finishes still works end to end.
  stubFetch((url) => Promise.resolve(withUrl(new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv", "content-length": "8" } }), url)));
  const lighter = `${base}&detail=dataonly`;
  const ok = await run(lighter);
  assert.match(ok.content[0].text, /^Downloaded 8 bytes\.\nData file: data\/[0-9a-f]{64}\.data\n/);
  assert.deepEqual(fetchCalls, [lighter]);
  check("a changed request (detail=dataonly) is sent and downloads normally");

  // Pre-header phase: nothing answers. The circuit still counts it; the model sees DOWNLOAD_TIMEOUT.
  const host2 = "http://203.0.113.8";
  stubFetch((url, init) => hangsUntilAborted(init.signal));
  const pre1 = await message(run(`${host2}/a.csv`));
  assert.equal(pre1.code, "DOWNLOAD_TIMEOUT");
  assert.ok(pre1.message.endsWith(HINT));
  assert.equal((await message(run(`${host2}/a.csv`))).code, "DOWNLOAD_TIMEOUT", "the one allowed retry of a pre-header timeout is sent");
  assert.equal(fetchCalls.length, 2);
  assert.equal((await message(run(`${host2}/a.csv`))).code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.equal(fetchCalls.length, 2, "the third attempt of a pre-header timeout is not sent");
  // Two failures counted so far (the refusal sent nothing and added none). The third consecutive failure on this
  // host: the stop instruction wins and is not rewritten.
  const pre3 = await message(run(`${host2}/b.csv`));
  assert.match(pre3.message, /^SOURCE_ACCESS_BLOCKED: 3 consecutive source-access attempts failed\. Stop source-dependent reporting/);
  assert.equal(pre3.code, undefined);
  // The blocked host answers with the stronger instruction even to an identical retry.
  assert.match((await message(run(`${host2}/b.csv`))).message, /^SOURCE_ACCESS_BLOCKED:/);
  assert.match((await message(run(`${host2}/a.csv`))).message, /^SOURCE_ACCESS_BLOCKED:/);
  check("pre-header timeout: DOWNLOAD_TIMEOUT; circuit counting and SOURCE_ACCESS_BLOCKED precedence are unchanged");

  // A user cancel is not a timeout: it keeps its own error and records no repeat key.
  const host3 = "http://203.0.113.9/slow.csv";
  stubFetch((url, init) => hangsUntilAborted(init.signal));
  const cancel = new AbortController();
  const cancelled = run(host3, {}, cancel.signal);
  realSetTimeout(() => cancel.abort(), 5);
  const cancelError = await message(cancelled);
  assert.notEqual(cancelError.code, "DOWNLOAD_TIMEOUT");
  assert.doesNotMatch(cancelError.message, /DOWNLOAD_TIMEOUT/);
  stubFetch((url) => Promise.resolve(withUrl(new Response("x\n1\n", { status: 200, headers: { "content-type": "text/csv" } }), url)));
  assert.match((await run(host3)).content[0].text, /^Downloaded 4 bytes/, "the same URL is not refused after a cancel");
  check("a user cancel is not recorded as a timeout");

  // Every other download check is unchanged.
  stubFetch((url) => Promise.resolve(withUrl(new Response("nope", { status: 404 }), url)));
  assert.match((await message(run("http://203.0.113.10/missing.csv"))).message, /^SOURCE_ACCESS_FAILED: network evidence fetch returned HTTP 404 \(1\/3\)\. Do not substitute synthetic data/);
  stubFetch((url) => Promise.resolve(withUrl(new Response("x", { status: 200, headers: { "content-length": String(25_000_001) } }), url)));
  assert.match((await message(run("http://203.0.113.11/huge.csv"))).message, /^Dataset exceeds the 25 MB download limit$/);
  // The scheme and private-host checks run inside safeFetch, which has always reported them as an unreachable source.
  const scheme = await message(run("ftp://203.0.113.12/x.csv"));
  assert.match(scheme.message, /^SOURCE_ACCESS_FAILED: network evidence fetch could not reach a public source \(1\/3\)\./);
  assert.ok(!("cause" in scheme), "no raw cause on the thrown error");
  const privateHost = await message(run("http://127.0.0.1/x.csv"));
  assert.match(privateHost.message, /^SOURCE_ACCESS_FAILED: network evidence fetch could not reach a public source \(1\/3\)\./);
  assert.ok(!("cause" in privateHost), "no raw cause on the thrown error");
  assert.equal(scheme.code, undefined);
  assert.equal(privateHost.code, undefined);
  check("HTTP status, 25 MB cap, scheme and private-host checks keep their messages and are not rewritten as timeouts");

  // ---- host circuit and error hygiene (fresh process state, own artifact folder) ----
  const art2 = join(makeTestTmp("fast-fail-circuit-"), "run");
  mkdirSync(art2, { recursive: true });
  const download2 = (await freshTools({ NEWSROOM_ARTIFACT_DIR: art2 })).get("download_data");
  const run2 = (url) => download2.execute("id", { url });
  const SECRET = "token=SECRET-QUERY-VALUE";
  const clean = (error, label) => {
    assert.ok(!("cause" in error), `${label}: no cause`);
    for (const [name, text] of [["message", error.message], ["json", JSON.stringify(error)], ["stack", String(error.stack)]]) {
      assert.ok(!text.includes("token=") && !text.includes("SECRET") && (name === "stack" || !text.includes("?")), `${label}: no query string or secret in the ${name}`);
    }
  };
  const byPath = (handlers) => stubFetch((url, init) => handlers[new URL(url).pathname](url, init));
  const header = (url, init) => hangsUntilAborted(init.signal);
  const body = (url, init) => Promise.resolve(stalledBody(url, init.signal));

  // A header timeout counts: two of them, then the third request on the host meets the stop instruction.
  let h = "http://203.0.113.30";
  byPath({ "/a": header, "/b": header, "/c": header });
  const h1 = await message(run2(`${h}/a?${SECRET}`));
  assert.equal(h1.code, "DOWNLOAD_TIMEOUT"); clean(h1, "header timeout");
  assert.equal((await message(run2(`${h}/b?${SECRET}`))).code, "DOWNLOAD_TIMEOUT");
  assert.match((await message(run2(`${h}/c?${SECRET}`))).message, /^SOURCE_ACCESS_BLOCKED: 3 consecutive/, "the third failure on the host is the stop instruction");
  check("header timeout counts toward the host circuit; the error carries no cause, query string or body");

  // A body-read timeout counts the same way (the host answered the headers, then stalled).
  h = "http://203.0.113.31";
  byPath({ "/a": body, "/b": body, "/c": body, "/d": body });
  const b1 = await message(run2(`${h}/a?${SECRET}`));
  assert.equal(b1.code, "DOWNLOAD_TIMEOUT"); clean(b1, "body timeout");
  assert.equal((await message(run2(`${h}/b?${SECRET}`))).code, "DOWNLOAD_TIMEOUT");
  assert.equal(fetchCalls.length, 2);
  assert.match((await message(run2(`${h}/c?${SECRET}`))).message, /^SOURCE_ACCESS_BLOCKED: 3 consecutive/, "after two body timeouts the third failure is the stop instruction");
  assert.equal(fetchCalls.length, 3);
  assert.match((await message(run2(`${h}/d?${SECRET}`))).message, /^SOURCE_ACCESS_BLOCKED:/);
  assert.equal(fetchCalls.length, 3, "the blocked host is not asked a fourth time");
  check("body-read timeout counts toward the host circuit; the error carries no cause, query string or body");

  // Header and body timeouts add up on one host.
  h = "http://203.0.113.32";
  byPath({ "/a": header, "/b": body, "/c": header });
  assert.equal((await message(run2(`${h}/a`))).code, "DOWNLOAD_TIMEOUT");
  assert.equal((await message(run2(`${h}/b`))).code, "DOWNLOAD_TIMEOUT");
  assert.match((await message(run2(`${h}/c`))).message, /^SOURCE_ACCESS_BLOCKED:/);
  // A body that finishes resets the count, as a finished header used to.
  h = "http://203.0.113.33";
  byPath({ "/a": body, "/ok": (url) => Promise.resolve(withUrl(new Response("a\n1\n", { status: 200, headers: { "content-type": "text/csv" } }), url)), "/c": header, "/d": header });
  assert.equal((await message(run2(`${h}/a`))).code, "DOWNLOAD_TIMEOUT");
  assert.match((await run2(`${h}/ok`)).content[0].text, /^Downloaded 4 bytes/);
  assert.equal((await message(run2(`${h}/c`))).code, "DOWNLOAD_TIMEOUT");
  assert.equal((await message(run2(`${h}/d`))).code, "DOWNLOAD_TIMEOUT", "after a completed download the count started again");
  check("header and body timeouts add up on one host; a completed body resets the count");

  // A repeat refusal sends nothing and is not a failure: the host still answers the next request.
  h = "http://203.0.113.34";
  byPath({ "/a": body, "/b": header });
  const r1 = await message(run2(`${h}/a?${SECRET}`));
  const r2 = await message(run2(`${h}/a?${SECRET}`));
  assert.equal(r1.code, "DOWNLOAD_TIMEOUT"); assert.equal(r2.code, "DOWNLOAD_TIMEOUT");
  const callsBefore = fetchCalls.length;
  const refusal = await message(run2(`${h}/a?${SECRET}`));
  assert.equal(refusal.code, "DOWNLOAD_TIMEOUT_REPEAT"); clean(refusal, "repeat refusal");
  assert.equal(fetchCalls.length, callsBefore, "the refusal sent nothing");
  const next = await message(run2(`${h}/b`));
  assert.equal(fetchCalls.length, callsBefore + 1, "the host was not blocked by the refusal: the next request was sent");
  assert.match(next.message, /^SOURCE_ACCESS_BLOCKED: 3 consecutive/, "and its timeout is the third counted failure");
  check("a repeat refusal is clean (no cause, query string or body) and does not count against the host, so the smaller request it asks for is still sent");

  // Nothing about any of this reaches the disk: no failure record, no repeat key.
  // The only files are the three of the one download that finished on purpose (data, its metadata, its origin).
  const written = withoutRunTraces(art2, walk(art2), { label: "failure tree" });
  assert.equal(written.length, 3, "no file was written for any failure");
  assert.ok(written.every((file) => /\/data\/(?:origins\/[0-9a-f]{64}\.json|[0-9a-f]{64}\.data(?:\.meta\.json)?)$/.test(file)), "and those three are the finished download's");
  check("no failure record or repeat key is written to disk");

  // A redirect counts against the host that answered: three entry hosts that all redirect to B and stall there
  // block B, and never A1-A3.
  {
    const B = "http://203.0.113.50";
    const entries = ["http://203.0.113.41", "http://203.0.113.42", "http://203.0.113.43"];
    const viaB = (url, init) => Promise.resolve(stalledBody(`${B}/data.csv`, init.signal));
    byPath({ "/a": viaB, "/b": viaB, "/c": viaB, "/d": header });
    // A1 and A2 time out through B (counted on B), then A3's request meets B's stop instruction at the entry check or after.
    assert.equal((await message(run2(`${entries[0]}/a`))).code, "DOWNLOAD_TIMEOUT");
    assert.equal((await message(run2(`${entries[1]}/b`))).code, "DOWNLOAD_TIMEOUT");
    assert.match((await message(run2(`${entries[2]}/c`))).message, /^SOURCE_ACCESS_BLOCKED: 3 consecutive/, "the third body timeout through B is the stop instruction");
    assert.match((await message(run2(`${B}/data.csv`))).message, /^SOURCE_ACCESS_BLOCKED:/, "B is blocked");
    for (const entry of entries) {
      byPath({ "/d": (url) => Promise.resolve(withUrl(new Response("a\n1\n", { status: 200, headers: { "content-type": "text/csv" } }), url)) });
      assert.match((await run2(`${entry}/d`)).content[0].text, /^Downloaded 4 bytes/, `${entry} is not blocked by B's failures`);
    }
    check("a redirect's body timeout counts against the host that answered, not the entry host");
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- 2. grammar hint
{
  const artifact = join(makeTestTmp("fast-fail-grammar-"), "run");
  mkdirSync(artifact, { recursive: true });
  const tools = await freshTools({ NEWSROOM_ARTIFACT_DIR: artifact });
  const plan = tools.get("newsroom_viz_plan");
  assert.ok(plan, "newsroom_viz_plan is registered");
  const declared = (relation, chart_type, measure_kind = "level") => ({
    sql: "select 'A' as category, 1 as value",
    chart_type,
    reader_task: relation === "rank" ? "ranking" : relation === "anomaly" ? "comparison" : relation,
    title: "Exports by partner",
    takeaway: "A leads.",
    category_field: "category",
    value_field: "value",
    measure_semantics: [{ id: "m1", phenomenon: "exports", unit: "USD", measure_kind }],
    claim_spec: { relation, reader_task: relation === "rank" ? "ranking" : relation, target_measure: "m1" },
  });
  const blockOf = async (relation, chart) => { try { await plan.execute("id", declared(relation, chart)); } catch (error) { return error.message; } return null; };

  // The block is byte-for-byte what it was, plus one trailing clause.
  assert.equal(
    await blockOf("comparison", "diverging_bar"),
    "EDITORIAL_GRAMMAR_BLOCKED: relation 'comparison' requires one of horizontal_bar, dot, dumbbell, slope, small_multiples, mirrored_bar; got 'diverging_bar'; diverging_bar fits: anomaly",
  );
  assert.equal(
    await blockOf("rank", "small_multiples"),
    "EDITORIAL_GRAMMAR_BLOCKED: relation 'rank' requires one of horizontal_bar, dot; got 'small_multiples'; small_multiples fits: comparison, trend, anomaly",
  );
  assert.equal(
    await blockOf("rank", "dumbbell"),
    "EDITORIAL_GRAMMAR_BLOCKED: relation 'rank' requires one of horizontal_bar, dot; got 'dumbbell'; dumbbell fits: comparison, change, benchmark",
  );
  // A chart no relation lists says so instead of an empty list.
  assert.equal(
    await blockOf("rank", "treemap"),
    "EDITORIAL_GRAMMAR_BLOCKED: relation 'rank' requires one of horizontal_bar, dot; got 'treemap'; treemap fits: no relation in the strict grammar",
  );
  check("EDITORIAL_GRAMMAR_BLOCKED keeps its text and appends 'X fits: <relations>' read from the same table");

  // The clause comes from the same table the gate uses: every relation it names accepts the chart.
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  const table = Object.fromEntries([...src.match(/const STRICT_GRAMMAR_FORMS[^{]*\{([\s\S]*?)\n\};/)[1].matchAll(/^\s*(\w+): \[([^\]]*)\]/gm)].map((m) => [m[1], m[2].split(",").map((x) => x.trim().replace(/"/g, ""))]));
  assert.ok(Object.keys(table).length >= 10);
  for (const chart of new Set(Object.values(table).flat())) {
    const fits = Object.keys(table).filter((relation) => table[relation].includes(chart));
    for (const relation of Object.keys(table)) {
      if (table[relation].includes(chart)) continue;
      const message = await blockOf(relation === "relationship" ? "relationship" : relation, chart);
      // NEWSROOM_SCATTER_PAIRED_MEASURES=1: a scatter that is not a pair is refused first by the scatter check, which names the same wrong relation.
      if (chart === "scatter" && process.env.NEWSROOM_SCATTER_PAIRED_MEASURES === "1") { assert.ok(message?.startsWith("SCATTER_PAIRING_REQUIRED:") && message.includes(`relation is '${relation}'`), `${relation} blocks scatter: ${message}`); continue; }
      assert.ok(message?.startsWith(`EDITORIAL_GRAMMAR_BLOCKED: relation '${relation}' requires one of ${table[relation].join(", ")}; got '${chart}'`), `${relation} blocks ${chart}: ${message}`);
      assert.ok(message.endsWith(`; ${chart} fits: ${fits.join(", ")}`), message);
    }
  }
  check("every blocked relation x chart pair names exactly the relations that list the chart");
  // Accepted pairs get past the grammar gate and stop at the next check (the fixture has no alt text or source note).
  assert.match(String(await blockOf("comparison", "dumbbell")), /^Invalid visualization plan: Missing required field 'alt'/);
  assert.match(String(await blockOf("rank", "horizontal_bar")), /^Invalid visualization plan: Missing required field 'alt'/);
  check("a chart the relation accepts is not blocked");
}

// ---------------------------------------------------------------- 3. one dimension vocabulary
{
  const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  const story = await import(join(ROOT, "runtime/pi/story_graph.mjs"));
  const editorial = await import(join(ROOT, "runtime/pi/editorial.mjs"));
  const infographic = await import(join(ROOT, "runtime/pi/infographic.mjs"));
  const publicationPi = await import(join(ROOT, "runtime/pi/publication.mjs"));
  const publicationWeb = await import(join(ROOT, "runtime/web/publication.mjs"));

  // What "the story graph accepts" means is the story graph's own published contract, not our constant.
  const findEnums = (node, key) => {
    const found = [];
    if (Array.isArray(node)) { for (const item of node) found.push(...findEnums(item, key)); return found; }
    if (!node || typeof node !== "object") return found;
    for (const [k, v] of Object.entries(node)) {
      if (k === key && v && typeof v === "object" && Array.isArray(v.enum)) found.push(v.enum);
      else found.push(...findEnums(v, key));
    }
    return found;
  };
  const STORY_CONTRACT = findEnums(readJson("schemas/story-graph.schema.json"), "explanatory_dimension");
  assert.equal(STORY_CONTRACT.length, 1);
  const STORY = STORY_CONTRACT[0];
  assert.equal(STORY.length, 12);
  assert.deepEqual([...story.STORY_DIMENSIONS], STORY, "STORY_DIMENSIONS is the story graph schema's enum");
  const PUBLICATION = [...story.PUBLICATION_DIMENSIONS];
  assert.equal(PUBLICATION.length, 16);
  assert.deepEqual(PUBLICATION, ["trend", "rank", "spatial", "mechanism", "comparison", "distribution", "uncertainty", "human_scale", "method", "context", "outcome", "flow", "network", "relationship", "hierarchy", "model"], "the publication tools list the values in the order their schema had on abd9d8b, so their definitions do not change");
  assert.ok(STORY.every((d) => PUBLICATION.includes(d)));
  assert.deepEqual(PUBLICATION.filter((d) => !STORY.includes(d)), ["flow", "network", "hierarchy", "model"]);
  const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
  check("one definition: STORY_DIMENSIONS equals the story-graph schema enum; the publication list is that plus flow, network, hierarchy, model");

  // Every tool that takes explanatory_dimension for a module, read from the registered schemas.
  const tools = await freshTools({});
  const enumsByTool = {};
  for (const [name, tool] of tools) {
    const found = findEnumsInParameters(tool.parameters);
    if (found.length) enumsByTool[name] = found;
  }
  function findEnumsInParameters(node) {
    const found = [];
    if (!node || typeof node !== "object") return found;
    if (node.properties && typeof node.properties === "object") {
      for (const [key, value] of Object.entries(node.properties)) {
        if (key === "explanatory_dimension") found.push(value.enum);
        found.push(...findEnumsInParameters(value));
      }
    }
    if (node.items) found.push(...findEnumsInParameters(node.items));
    for (const key of ["anyOf", "allOf", "oneOf"]) if (Array.isArray(node[key])) for (const sub of node[key]) found.push(...findEnumsInParameters(sub));
    return found;
  }
  // The chain tool is registered only with NEWSROOM_SPEED_CHAIN_INFOGRAPHIC=1 and NEWSROOM_SPEED_ATOMIC_ARTIFACT=1 (newsroom.ts registerInfographicChain)
  // and copies the plan tool's parameters, so the expected set follows both switches.
  const chainRegistered = process.env.NEWSROOM_SPEED_CHAIN_INFOGRAPHIC === "1" && process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT === "1";
  const expectedEnumTools = ["newsroom_infographic_plan", "newsroom_portable_publication", "newsroom_publication_plan", "newsroom_semantic_novelty", "newsroom_story_graph", ...(chainRegistered ? ["newsroom_infographic_chain"] : [])].sort();
  assert.deepEqual(Object.keys(enumsByTool).sort(), expectedEnumTools, "a new tool taking explanatory_dimension must join this test");
  for (const [name, found] of Object.entries(enumsByTool)) {
    assert.equal(found.length, 1, `${name} declares explanatory_dimension once`);
    for (const value of STORY) assert.ok(found[0].includes(value), `${name} accepts '${value}'`);
    const publication = name.includes("publication");
    assert.deepEqual(found[0], publication ? PUBLICATION : STORY, `${name} takes the shared list`);
  }
  check("story graph, semantic novelty, infographic plan and both publication tools accept every story-graph value");

  // The JSON schemas that describe the artifacts these tools write agree with the same lists.
  const infographicSchema = findEnums(readJson("schemas/infographic-spec.schema.json"), "explanatory_dimension");
  assert.equal(infographicSchema.length, 1);
  assert.deepEqual(infographicSchema[0], STORY);
  const publicationSchema = findEnums(readJson("schemas/publication-spec.schema.json"), "explanatory_dimension");
  assert.equal(publicationSchema.length, 1);
  sameSet(publicationSchema[0], PUBLICATION);
  for (const file of ["runtime/pi/publication.mjs", "runtime/web/publication.mjs"]) {
    const declared = readFileSync(join(ROOT, file), "utf8").match(/const DIMENSIONS=new Set\(\[([^\]]*)\]\)/);
    assert.ok(declared, `${file} declares DIMENSIONS`);
    sameSet(declared[1].split(",").map((x) => x.trim().replace(/'/g, "")), PUBLICATION);
  }
  check("infographic and publication JSON schemas and both publication.mjs copies list the same values");

  // The boundary mapping: one function, the plan's existing relationship -> network.
  assert.equal(story.mapExplanatoryDimension("relationship"), "network");
  for (const value of PUBLICATION.filter((d) => d !== "relationship")) assert.equal(story.mapExplanatoryDimension(value), value, `${value} is left alone`);
  for (const value of [undefined, null, "", "Relationship", " relationship", 7, "constructor", "__proto__"]) assert.equal(story.mapExplanatoryDimension(value), value, `${String(value)} is left alone`);
  assert.ok(PUBLICATION.includes(story.mapExplanatoryDimension("relationship")), "the mapped value is one the publication plan accepts");
  const styles = readJson("config/editorial-style-mappings.json");
  const styleDimensions = new Set(Object.values(styles.profiles).flatMap((profile) => profile.compatible_dimensions));
  assert.ok(!styleDimensions.has("relationship") && styleDimensions.has("network"), "the style registry has no relationship profile: that is why the plan maps it to network");
  const newsroomSource = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.doesNotMatch(newsroomSource, /=== "relationship" \? "network"/, "no inline relationship -> network ternary is left");
  assert.equal((newsroomSource.match(/explanatory_dimension: mapExplanatoryDimension\(module\.explanatory_dimension\)/g) ?? []).length, 2, "both publication boundaries call the shared function");
  assert.equal((newsroomSource.match(/explanatory_dimension: (?:Type\.Optional\()?StringEnum\(\[/g) ?? []).length, 4, "four spread-from-shared enums");
  assert.doesNotMatch(newsroomSource, /explanatory_dimension: (?:Type\.Optional\()?StringEnum\(\["/, "no tool carries its own literal dimension list");
  check("relationship -> network lives in one shared function, used at both publication boundaries; no tool keeps its own literal list");

  // Values with no defined handling stay refused, and every refusal lists the allowed values.
  const allowed = (list) => `; allowed: ${list.join(", ")}`;
  const nodes = (dimension) => [
    { id: "n1", kind: "evidence", summary: "s1", explanatory_dimension: "trend" },
    { id: "n2", kind: "claim", summary: "s2", explanatory_dimension: dimension },
    { id: "n3", kind: "mechanism", summary: "s3", explanatory_dimension: "rank" },
  ];
  const storyInput = (dimension) => ({ story_id: "s", reader_question: "q", visual_thesis: "t", nodes: nodes(dimension), edges: [{ from: "n1", to: "n2", relation: "supports" }, { from: "n2", to: "n3", relation: "causes" }], entry_node_ids: ["n1"], answer_node_ids: ["n3"] });
  const noveltyInput = (dimension) => ({ concept_ref: "editorial/concepts/x.json", modules: [
    { id: "m1", reader_question_id: "q1", claim_set: ["c1"], new_information: "tariffs fell", explanatory_dimension: dimension },
    { id: "m2", reader_question_id: "q2", claim_set: ["c2"], new_information: "ports filled", explanatory_dimension: dimension === "rank" ? "trend" : "rank" },
  ] });
  const infographicInput = (dimension) => ({ schema_version: infographic.INFOGRAPHIC_SCHEMA_VERSIONS[0], title: "t", modules: [{ id: "m1", type: "text", explanatory_dimension: dimension }, { id: "m2", type: "text" }, { id: "m3", type: "text" }] });
  const publicationInput = (dimension) => ({ schema_version: "0.3.0", modules: [{ id: "a", type: "text", story_node_ids: ["n1"], explanatory_dimension: dimension }, { id: "b", type: "text", story_node_ids: ["n2"], explanatory_dimension: "trend" }] });
  const dimensionErrors = (errors) => errors.filter((error) => /explanatory_dimension/.test(error));
  // scoreSemanticNovelty throws every problem it found as one message; only m1 can be wrong here.
  const noveltyErrors = (dimension) => { try { editorial.scoreSemanticNovelty(noveltyInput(dimension)); return []; } catch (error) { return dimensionErrors([error.message]); } };
  const sites = {
    "story graph": { run: (d) => dimensionErrors(story.validateStoryGraph(storyInput(d))), message: (d) => `story node 'n2' has unsupported explanatory_dimension '${d}'${allowed(STORY)}`, accepts: STORY },
    "semantic novelty": { run: noveltyErrors, message: (d) => `module 'm1' has unsupported explanatory_dimension '${d}'${allowed(STORY)}`, accepts: STORY },
    "infographic plan": { run: (d) => dimensionErrors(infographic.validateInfographicSpec(infographicInput(d))), message: (d) => `module 'm1' has unsupported explanatory_dimension '${d}'${allowed(STORY)}`, accepts: STORY },
  };
  for (const [name, site] of Object.entries(sites)) {
    for (const value of site.accepts) assert.deepEqual(site.run(value), [], `${name} accepts '${value}'`);
    for (const value of ["flow", "network", "hierarchy", "model", "bogus"]) assert.deepEqual(site.run(value), [site.message(value)], `${name} refuses '${value}' and lists what is allowed`);
  }
  for (const [name, module] of [["publication (pi)", publicationPi], ["publication (web)", publicationWeb]]) {
    for (const value of PUBLICATION) assert.deepEqual(dimensionErrors(module.validatePublicationSpec(publicationInput(value))), [], `${name} accepts '${value}'`);
    const refused = dimensionErrors(module.validatePublicationSpec(publicationInput("bogus")));
    assert.equal(refused.length, 1);
    const match = refused[0].match(/^modules\[0\]\.explanatory_dimension unsupported; allowed: (.*)$/);
    assert.ok(match, refused[0]);
    sameSet(match[1].split(", "), PUBLICATION);
  }
  check("flow, network, hierarchy, model and unknown values are still refused by story graph, novelty and infographic plan; each refusal lists the allowed values");

  // Every error text for this field in the runtime is a list-carrying one.
  const runtimeFiles = walk(join(ROOT, "runtime")).filter((file) => /\.(mjs|ts)$/.test(file));
  const texts = runtimeFiles.flatMap((file) => readFileSync(file, "utf8").split("\n").filter((line) => /unsupported explanatory_dimension|explanatory_dimension unsupported/.test(line)).map((line) => `${file}: ${line.trim()}`));
  assert.ok(texts.length >= 3, "the error texts were found");
  for (const text of texts) assert.match(text, /allowed/, `error text without the allowed values: ${text}`);
  check("no 'unsupported explanatory_dimension' error text in runtime/ is without the allowed values");

  // Semantic novelty: the scoring function is untouched. Digest of 600 full artifacts taken on abd9d8b.
  const NOVELTY_DIGEST_PIN = { count: 600, digest: "bf234211bffbf56dfea063c8e996f62f314dc8838c7055d297f2918b7773b8b5" };
  assert.deepEqual(noveltyMatrixDigest(editorial.scoreSemanticNovelty), NOVELTY_DIGEST_PIN, "scoring over the ten original dimensions is byte-identical to abd9d8b");
  assert.deepEqual(NOVELTY_ORIGINAL_DIMENSIONS, STORY.slice(0, 10));
  // The two newly accepted values are compared exactly like the others: equality only, weight 0.05.
  for (const value of STORY) {
    const other = value === "trend" ? "rank" : "trend";
    const overlap = (dimensionA, dimensionB) => editorial.scoreSemanticNovelty({ concept_ref: "c", modules: [
      { id: "a", reader_question_id: "q1", claim_set: ["c1"], new_information: "alpha beta", explanatory_dimension: dimensionA },
      { id: "b", reader_question_id: "q2", claim_set: ["c2"], new_information: "gamma delta", explanatory_dimension: dimensionB },
    ] }).pairwise[0].overlap;
    assert.equal(overlap(value, value), 0.05, `${value} vs itself`);
    assert.equal(overlap(value, other), 0, `${value} vs ${other}`);
  }
  check("semantic novelty scoring is unchanged for the ten original values (600-artifact digest equals abd9d8b) and equality-only for outcome and relationship");
}

// ---------------------------------------------------------------- 4. quantity_kind guidance
{
  const tools = await freshTools({});
  const encoding = tools.get("newsroom_infographic_plan").parameters.properties.modules.items.properties.quantitative_encoding;
  const kind = encoding.properties.quantity_kind;
  // Wording only: the enum is what it was on abd9d8b, so the values a model reaches for are still refused by the schema.
  assert.deepEqual(kind.enum, ["observed_flow", "estimated_flow", "stock", "stock_change", "count", "rate", "share", "index", "other"]);
  for (const reached of ["level", "change", "rate_of_change", "measure"]) assert.ok(!kind.enum.includes(reached), `${reached} is still not a value`);
  assert.ok(Buffer.byteLength(kind.description) <= 160, `the clause is at most 160 bytes (${Buffer.byteLength(kind.description)})`);
  // What the clause names must exist: a renamed enum value makes this fail instead of leaving a stale hint.
  for (const named of kind.description.match(/\b(?:stock_change|stock|count|rate|share|index|other)\b/g)) assert.ok(kind.enum.includes(named), `the clause names '${named}', which is in the enum`);
  const CLAUSE = "Level of a stock (people, money): stock; its change: stock_change; items or events: count; ratio: rate; part of whole: share; true index: index; else other.";
  assert.equal(kind.description, CLAUSE);
  assert.equal(Buffer.byteLength(CLAUSE), 156, "156 bytes, 43 more than the 113-byte clause it replaces");
  assert.deepEqual([...new Set(kind.description.match(/\b(?:stock_change|stock|count|rate|share|index|other)\b/g))].sort(), ["count", "index", "other", "rate", "share", "stock", "stock_change"].sort(), "the clause names exactly the seven values that carry meaning for a measured quantity");
  // NEWSROOM_SPEED_CONTRACT_TEXT=1 (wording only) gives scale_type exactly one sentence; every other field still has none.
  const SCALE_TYPE_CONTRACT_TEXT = "log needs domain_min > 0 and domain_max > domain_min; horizontal_bar and diverging_bar need baseline_policy zero or symmetric_zero.";
  for (const [key, field] of Object.entries(encoding.properties)) if (key !== "quantity_kind") assert.equal(field.description, key === "scale_type" && process.env.NEWSROOM_SPEED_CONTRACT_TEXT === "1" ? SCALE_TYPE_CONTRACT_TEXT : undefined, `${key} gained no description`);
  check("quantity_kind carries one clause of 156 bytes that maps a level of a stock to stock, its change to stock_change, items or events to count, a ratio to rate, a part of a whole to share and a true index to index; the enum is unchanged");
}

// ---------------------------------------------------------------- 5. the widened vocabularies, pinned
{
  const story = await import(join(ROOT, "runtime/pi/story_graph.mjs"));
  const tools = await freshTools({});
  const enumsOf = (name) => {
    const found = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      for (const [key, value] of Object.entries(node)) {
        if (key === "explanatory_dimension" && value && Array.isArray(value.enum)) found.push(value.enum);
        else visit(value);
      }
    };
    visit(tools.get(name).parameters);
    assert.equal(found.length, 1, `${name} declares explanatory_dimension once`);
    return found[0];
  };
  const T10 = ["trend", "rank", "spatial", "mechanism", "comparison", "distribution", "uncertainty", "human_scale", "method", "context"];
  const T12 = [...T10, "outcome", "relationship"];
  const T16 = [...T10, "outcome", "flow", "network", "relationship", "hierarchy", "model"];
  // before: the literal list of each tool on abd9d8b (read from that commit's newsroom.ts); added: what 83d5ad1 meant to add.
  const PINS = {
    newsroom_story_graph: { before: T12, added: [], after: T12 },
    newsroom_semantic_novelty: { before: T10, added: ["outcome", "relationship"], after: T12 },
    newsroom_infographic_plan: { before: [...T10, "outcome"], added: ["relationship"], after: T12 },
    newsroom_publication_plan: { before: T16, added: [], after: T16 },
    newsroom_portable_publication: { before: T16, added: [], after: T16 },
  };
  // Every value a model could send: all sixteen, and the near misses that were never valid.
  const CANDIDATES = [...new Set([...T16, "Relationship", "Outcome", " outcome", "", "level", "bogus", "constructor", "__proto__"])];
  for (const [name, pin] of Object.entries(PINS)) {
    const actual = enumsOf(name);
    assert.deepEqual([...actual], pin.after, `${name} enum is exactly the pinned list, in order`);
    assert.deepEqual(actual.filter((v) => !pin.before.includes(v)), pin.added, `${name} gained exactly the intended additions`);
    assert.ok(pin.before.every((v) => actual.includes(v)), `${name} lost nothing it accepted before`);
    const refusedBefore = CANDIDATES.filter((v) => !pin.before.includes(v));
    const stillRefused = refusedBefore.filter((v) => !actual.includes(v));
    assert.deepEqual(refusedBefore.filter((v) => actual.includes(v)), pin.added, `${name}: every value refused before is still refused, except the additions`);
    assert.ok(stillRefused.length === refusedBefore.length - pin.added.length);
  }
  for (const name of ["newsroom_story_graph", "newsroom_semantic_novelty", "newsroom_infographic_plan"]) assert.deepEqual([...enumsOf(name)], [...story.STORY_DIMENSIONS]);
  assert.deepEqual(PINS.newsroom_publication_plan.after, [...story.PUBLICATION_DIMENSIONS]);
  console.log("explanatory_dimension before/after:");
  for (const [name, pin] of Object.entries(PINS)) console.log(`  ${name}: ${pin.before.length} -> ${pin.after.length}${pin.added.length ? ` (+${pin.added.join(", ")})` : ""}`);
  check("each tool's explanatory_dimension enum is pinned exactly; every value refused before 83d5ad1 is still refused except semantic_novelty +outcome,+relationship and infographic_plan +relationship");
}

for (const name of results) console.log(`${name} -- PASS`);
console.log(`fast-fail errors: PASS (${results.length} checks)`);
