// Fast-fail errors (one bounded round): a model that hits a wall should be able
// to fix it in one turn. No network, no model API: fetch is a stub and the 30 s
// download timer is shortened by wrapping setTimeout for that one delay.
//   1. download_data: a timeout is a structured DOWNLOAD_TIMEOUT (host, elapsed
//      seconds, one generic hint) and an identical retry is refused at once.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
const check = (name) => { results.push(name); };

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
const treeDir = mkdtempSync(join(tmpdir(), "fast-fail-tree-"));
cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
stub(treeDir, "typebox", TYPEBOX);
stub(treeDir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const testCopy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(testCopy, stripTypeScriptTypes(readFileSync(join(treeDir, "runtime", "pi", "newsroom.ts"), "utf8"), { mode: "strip" }));
let instance = 0;
async function freshTools(extraEnv = {}) {
  const mod = await import(`${pathToFileURL(testCopy).href}?instance=${++instance}`);
  const env = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_HIDE_LIEFLAT: undefined, NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_MOBILE_PAGES: undefined, ...extraEnv };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);

const evidenceGate = await import(join(ROOT, "runtime/pi/evidence_gate.mjs"));
const { DOWNLOAD_TIMEOUT_HINT, createDownloadTimeoutGuard, createSourceAccessCircuit } = evidenceGate;

// ---------------------------------------------------------------- 1. download timeout
const HINT = "Retrying the same URL rarely helps. Make the request lighter: fewer series or a shorter period; for SDMX APIs (ECB, Eurostat, OECD, IMF, BIS) add `detail=dataonly`; or use another source.";
assert.equal(DOWNLOAD_TIMEOUT_HINT, HINT, "the hint is the one generic sentence from the work order");

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
  const refused = repeat(ecb);
  assert.equal(refused?.code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.match(refused.message, /^DOWNLOAD_TIMEOUT_REPEAT: this exact request to data-api\.ecb\.europa\.eu already timed out after 30\.1 s in this session, so it was not sent again\. /);
  assert.ok(refused.message.endsWith(HINT));
  assert.equal(repeat({ ...ecb, url: ecb.url.replace("startPeriod=2000", "startPeriod=2000&detail=dataonly") }), null, "a changed URL is a new request");
  assert.equal(repeat({ ...ecb, url: ecb.url.replace("startPeriod=2000", "startPeriod=2010") }), null, "a changed query value is a new request");
  assert.equal(repeat({ ...ecb, method: "POST" }), null, "a changed method is a new request");
  assert.equal(repeat({ ...ecb, body: "{}" }), null, "a changed body is a new request");
  assert.equal(repeat({ ...ecb, url: "https://data-api.ecb.europa.eu/service/data/EXR/D.GBP.EUR.SP00.A?startPeriod=2000" }), null, "a changed path is a new request");
  assert.ok(repeat({ ...ecb, method: "get" }), "method case does not change the request");
  assert.ok(repeat({ ...ecb, url: `${ecb.url}#fragment` }), "a fragment never reaches the server, so it does not change the request");
  assert.ok(repeat({ ...ecb, url: ecb.url.replace("data-api.ecb.europa.eu", "DATA-API.ECB.EUROPA.EU") }), "host case does not change the request");
  check("identical retry is refused; any changed URL, method or body passes");

  const blocked = new Error("SOURCE_ACCESS_BLOCKED: 3 consecutive source-access attempts failed. Stop.");
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/blocked" }, 1, blocked), blocked, "the stop instruction is never softened");
  const other = new Error("HTTP 500 while downloading");
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/other" }, 1, other), other, "an error that is not the abort keeps its own text");
  assert.equal(repeat({ method: "GET", url: "https://a.example/other" }), null, "and does not poison the key");
  assert.equal(repeat({ method: "GET", url: "https://a.example/blocked" }), null);
  const wrapped = new Error("SOURCE_ACCESS_FAILED: network evidence fetch timed out or was cancelled (1/3).", { cause: abort });
  assert.equal(guard.recordTimeout({ method: "GET", url: "https://a.example/wrapped" }, 5, wrapped).code, "DOWNLOAD_TIMEOUT", "the circuit's wrapped abort is recognised through its cause");
  check("SOURCE_ACCESS_BLOCKED and non-abort errors pass through unchanged");

  const circuit = createSourceAccessCircuit(2);
  assert.equal(circuit.isBlocked("h"), false);
  circuit.recordFailure("t", abort, "h");
  assert.equal(circuit.isBlocked("h"), false);
  const second = circuit.recordFailure("t", abort, "h");
  assert.equal(circuit.isBlocked("h"), true);
  assert.match(second.message, /^SOURCE_ACCESS_BLOCKED: 2 consecutive/);
  assert.equal(circuit.recordFailure("t", abort, "other").cause, abort);
  assert.throws(() => circuit.assertAvailable("h"), /SOURCE_ACCESS_BLOCKED/);
  check("circuit gains a read-only isBlocked and keeps the abort as cause; its messages are unchanged");
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
  const artifact = join(mkdtempSync(join(tmpdir(), "fast-fail-art-")), "run");
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

  // The identical retry never reaches the network and comes back at once.
  const t0 = Date.now();
  const repeated = await message(run(base));
  assert.equal(repeated.code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.ok(repeated.message.endsWith(HINT));
  assert.ok(Date.now() - t0 < 30, "refused before any network wait");
  assert.equal(fetchCalls.length, 1, "no second request was sent");
  assert.equal((await message(run(base, { filename: "other.csv" }))).code, "DOWNLOAD_TIMEOUT_REPEAT", "a new filename does not change what the server is asked");
  assert.equal((await message(run(`${base}#top`))).code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.equal(fetchCalls.length, 1);
  check("identical retry (same URL) is refused at once with DOWNLOAD_TIMEOUT_REPEAT and the same hint");

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
  assert.equal((await message(run(`${host2}/a.csv`))).code, "DOWNLOAD_TIMEOUT_REPEAT");
  assert.equal(fetchCalls.length, 1, "the repeat of a pre-header timeout is not sent either");
  const pre2 = await message(run(`${host2}/b.csv`));
  assert.equal(pre2.code, "DOWNLOAD_TIMEOUT", "a different request to the same host is allowed");
  // Third consecutive failure on this host: the stop instruction wins and is not rewritten.
  const pre3 = await message(run(`${host2}/c.csv`));
  assert.match(pre3.message, /^SOURCE_ACCESS_BLOCKED: 3 consecutive source-access attempts failed\. Stop source-dependent reporting/);
  assert.equal(pre3.code, undefined);
  // The blocked host answers with the stronger instruction even to an identical retry.
  assert.match((await message(run(`${host2}/c.csv`))).message, /^SOURCE_ACCESS_BLOCKED:/);
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
  assert.match(scheme.cause.message, /^Only http\/https URLs are allowed$/);
  const privateHost = await message(run("http://127.0.0.1/x.csv"));
  assert.match(privateHost.message, /^SOURCE_ACCESS_FAILED: network evidence fetch could not reach a public source \(1\/3\)\./);
  assert.match(privateHost.cause.message, /^Private and local network hosts are blocked$/);
  assert.equal(scheme.code, undefined);
  assert.equal(privateHost.code, undefined);
  check("HTTP status, 25 MB cap, scheme and private-host checks keep their messages and are not rewritten as timeouts");
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.fetch = realFetch;
}

for (const name of results) console.log(`${name} -- PASS`);
console.log(`fast-fail errors: PASS (${results.length} checks)`);
