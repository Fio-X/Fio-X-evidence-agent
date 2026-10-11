// K99 stage 1 (NEWSROOM_FETCH_SPLIT_PROBE): a report-only split planner for slow downloads.
// Offline: the planner/runner take an injected single-request function and a virtual clock; the download_data path
// uses a stubbed fetch (a public-looking IP literal, so no DNS) and a 150 ms stand-in for the 30 s timer.
//   1. planner: which URL grammars split, in what order, with what cap; everything else is "none"
//   2. replay of the recorded T13 / T5 downloads: baseline 90.4 s, serial after-timeout 65.49 s, before-request 35.49 s,
//      T5 4 x 30 s = 120 s -> about 60.5 s (a shorter wait, not the same result)
//   3. user cancel is not a timeout; the circuit is read, never reset; failure types stay apart; budgets stop the run
//   4. the real tool: off-states write nothing and return the same text/error; on writes one diagnostic, no secrets
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
const check = (name) => { results.push(name); };
const probe = await import(join(ROOT, "runtime/pi/fetch_split_probe.mjs"));
const { createSourceAccessCircuit } = await import(join(ROOT, "runtime/pi/evidence_gate.mjs"));
const { planSplit, runSplitPlan, createVirtualClock, classifyRequest, diagnosticRecord, familyTimeline, failureTypeOf, fetchSplitProbeEnabled, FAMILY_LIMITS, FAILURE_TYPES } = probe;

const ECB = (series) => `https://data-api.ecb.europa.eu/service/data/EXR/D.${series}.EUR.SP00.A?startPeriod=2023-01-01&format=csvdata`;
const T13_PARENT = ECB("USD+JPY+GBP+CHF+CNY+AUD+CAD+KRW+INR+BRL+MXN+TRY");
const WB = (date) => `https://api.worldbank.org/v2/country/all/indicator/FP.CPI.TOTL.ZG?format=json&per_page=20000&date=${date}`;

// ---------------------------------------------------------------- 1. planner
{
  const plan = planSplit(T13_PARENT);
  assert.equal(plan.splittable, true);
  assert.equal(plan.kind, "sdmx_key");
  assert.equal(plan.chunk_count ?? plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.interval), ["series USD+JPY+GBP+CHF", "series CNY+AUD+CAD+KRW", "series INR+BRL+MXN+TRY"]);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.url), [ECB("USD+JPY+GBP+CHF"), ECB("CNY+AUD+CAD+KRW"), ECB("INR+BRL+MXN+TRY")], "the pieces keep the parent's query verbatim (no detail=dataonly added)");
  assert.equal(plan.capped, false);
  check("T13: 12 currencies plan as three pieces of 4 in parent order, query unchanged");

  const wb = planSplit(WB("2015:2024"));
  assert.deepEqual(wb.chunks.map((chunk) => chunk.interval), ["2015:2019", "2020:2024"]);
  assert.deepEqual(wb.chunks.map((chunk) => chunk.url), [WB("2015:2019"), WB("2020:2024")]);
  assert.deepEqual(planSplit(WB("2015:2019")).chunks.map((chunk) => chunk.interval), ["2015:2016", "2017:2019"], "depth 1 of the child, shown only because the planner is asked");
  assert.equal(planSplit(WB("2020:2020")).splittable, false, "a single year is atomic");
  check("T5: a World Bank year range halves at the midpoint; a single year is not split");

  for (const url of [
    "https://ourworldindata.org/grapher/x.csv?v=1&csvType=full",
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/demo_pjan?geo=PL&geo=DE&time=2014&time=2024",
    ECB("USD+JPY"), ECB("USD"),
    "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+JPY.EUR+GBP.SP00.A",
    "ftp://x.example/data/EXR/D.A+B+C+D+E.EUR",
    "not a url",
  ]) {
    const info = planSplit(url);
    assert.equal(info.splittable, false, url);
    assert.deepEqual(info.chunks, []);
  }
  assert.equal(classifyRequest("https://x.example/data/EXR/D.A+B.EUR.X.Y+Z").kind, "none", "two series lists: unknown grammar, old path");
  check("other URLs (csv, repeated geo/time, two lists, small lists, non-http, garbage) are not split");

  const many = planSplit(ECB(Array.from({ length: 40 }, (_, i) => `S${i}`).join("+")));
  assert.equal(many.chunks.length, FAMILY_LIMITS.maxChunks);
  assert.equal(many.capped, true);
  assert.equal(many.uncovered.length, 10 - FAMILY_LIMITS.maxChunks, "the pieces above the cap are reported as uncovered, never dropped silently");
  assert.deepEqual(planSplit(ECB(Array.from({ length: 40 }, (_, i) => `S${i}`).join("+")), { ...FAMILY_LIMITS, maxChunks: 99 }).chunks.length, 10);
  check("total-piece cap: 40 series give maxChunks pieces and a named uncovered remainder");
}

// ---------------------------------------------------------------- 2. replay of the recorded runs (virtual clock)
// Recorded outcome per request (URL without detail=): seconds, bytes, result. T13 pieces: 12.86, 11.94, 10.69 s (the
// third from the resend). T5: 2015:2019 timed out, 2020:2024 returned in 0.50 s.
const norm = (url) => { const u = new URL(url); u.searchParams.delete("detail"); return u.toString(); };
const RECORDED = new Map([
  [norm(ECB("USD+JPY+GBP+CHF")), { ms: 12856.785, ok: true, bytes: 219420 }],
  [norm(ECB("CNY+AUD+CAD+KRW")), { ms: 10693.993, ok: true, bytes: 219703 }],
  [norm(ECB("INR+BRL+MXN+TRY")), { ms: 11939.956, ok: true, bytes: 221628 }],
  [norm(WB("2015:2019")), { ms: 30003, ok: false, failure: "timeout" }],
  [norm(WB("2020:2024")), { ms: 503.959, ok: true, bytes: 305740 }],
]);
function replayFetch(clock, seen = []) {
  return async (url, { timeoutMs }) => {
    const hit = RECORDED.get(norm(url));
    assert.ok(hit, `no recorded outcome for ${url}`);
    seen.push(url);
    clock.advance(Math.min(hit.ms, timeoutMs));
    return hit;
  };
}
{
  const clock = createVirtualClock();
  const seen = [];
  const run = await runSplitPlan({ plan: planSplit(T13_PARENT), fetchOnce: replayFetch(clock, seen), clock });
  assert.equal(run.stopped_by, null);
  assert.equal(run.sends, 3);
  assert.equal(run.seconds, 35.49, "before-request, serial");
  assert.equal(familyTimeline({ parentSeconds: 30, pieceSeconds: run.results.map((r) => r.seconds), mode: "after_timeout" }), 65.49, "after-timeout, serial: 30 s parent + 35.49 s");
  // baseline: first start to last end of the recorded T13 download calls (seconds, as recorded)
  const baseline = Math.round((101420.287 - 11021.124) / 10) / 100;
  assert.equal(baseline, 90.4);
  assert.equal(Math.round((baseline - 65.49) * 100) / 100, 24.91);
  assert.equal(Math.round((baseline - 35.49) * 100) / 100, 54.91);
  assert.deepEqual(seen, planSplit(T13_PARENT).chunks.map((c) => c.url), "pieces were asked for in plan order, one at a time");
  check("replay T13: baseline 90.4 s, serial after-timeout 65.49 s (saves 24.91), before-request 35.49 s (saves 54.91)");

  const clock5 = createVirtualClock();
  const run5 = await runSplitPlan({ plan: planSplit(WB("2015:2024")), fetchOnce: replayFetch(clock5), clock: clock5 });
  assert.deepEqual(run5.results.map((r) => [r.interval, r.ok, r.failure ?? null]), [["2015:2019", false, "timeout"], ["2020:2024", true, null]]);
  const after5 = familyTimeline({ parentSeconds: 30, pieceSeconds: run5.results.map((r) => r.seconds), mode: "after_timeout" });
  assert.equal(after5, 60.5);
  const baseline5 = 4 * 30;
  assert.ok(after5 < baseline5 && after5 > 60 - 1, "4 x 30 s = 120 s becomes about 60 s");
  assert.equal(run5.results[0].ok, false, "2015:2019 is still not fetched: a shorter wait, not the same result");
  check("replay T5: 4 x 30 s = 120 s becomes about 60.5 s and the 2015:2019 piece is still missing (not a same-result speed-up)");
}

// ---------------------------------------------------------------- 3. cancel, circuit, failure types, budgets
{
  // User cancel is not a timeout: aborted before the send, and aborted while a piece runs.
  const before = new AbortController(); before.abort();
  const clockA = createVirtualClock();
  const runA = await runSplitPlan({ plan: planSplit(T13_PARENT), fetchOnce: replayFetch(clockA), clock: clockA, signal: before.signal });
  assert.equal(runA.sends, 0);
  assert.equal(runA.stopped_by, "cancelled");

  const during = new AbortController();
  const clockB = createVirtualClock();
  let calls = 0;
  const runB = await runSplitPlan({
    plan: planSplit(T13_PARENT), clock: clockB, signal: during.signal,
    fetchOnce: async () => { calls += 1; clockB.advance(2000); if (calls === 2) during.abort(); return calls === 2 ? { ok: false, failure: "timeout" } : { ok: true, bytes: 10 }; },
  });
  assert.equal(runB.stopped_by, "cancelled");
  assert.equal(runB.sends, 2, "no third piece after the cancel");
  assert.deepEqual(runB.results.map((r) => r.failure ?? null), [null, "cancelled"], "a failure reported while the signal is aborted is a cancel, not a timeout");
  assert.equal(runB.results.filter((r) => r.failure === "timeout").length, 0);
  check("a user cancel (before or during a piece) stops the run and is never recorded as a timeout; finished pieces are kept");

  // The circuit is read through isBlocked and never touched.
  const circuit = createSourceAccessCircuit(3);
  const host = "data-api.ecb.europa.eu";
  circuit.recordFailure("t", new Error("x"), host);
  circuit.recordFailure("t", new Error("x"), host);
  const clockC = createVirtualClock();
  const runC = await runSplitPlan({ plan: planSplit(T13_PARENT), fetchOnce: replayFetch(clockC), clock: clockC, isBlocked: (h) => circuit.isBlocked(h) });
  assert.equal(runC.sends, 3);
  assert.equal(circuit.failureCount(host), 2, "a probe run neither adds to nor resets the count");
  circuit.recordFailure("t", new Error("x"), host);
  const clockD = createVirtualClock();
  const runD = await runSplitPlan({ plan: planSplit(T13_PARENT), fetchOnce: replayFetch(clockD), clock: clockD, isBlocked: (h) => circuit.isBlocked(h) });
  assert.equal(runD.sends, 0);
  assert.equal(runD.stopped_by, "circuit_blocked");
  assert.equal(circuit.failureCount(host), 3, "still blocked afterwards; no piece routed round the circuit");
  const clockE = createVirtualClock();
  const runE = await runSplitPlan({
    plan: planSplit(T13_PARENT), clock: clockE,
    fetchOnce: async () => { clockE.advance(2344); return { ok: false, failure: "circuit_blocked" }; },
  });
  assert.equal(runE.sends, 1, "a piece answered with the blocked stop ends the family");
  assert.equal(runE.stopped_by, "circuit_blocked");
  check("circuit unchanged: the runner only reads isBlocked, never resets it, and stops at the blocked stop");

  // Failure types stay apart.
  assert.deepEqual(
    [{ cancelled: true, timedOut: true }, { blocked: true }, { timedOut: true }, { tooLarge: true }, { httpStatus: "500" }, { bodyPhase: true }, {}].map(failureTypeOf),
    ["cancelled", "circuit_blocked", "timeout", "too_large", "http", "body", "no_http"],
  );
  assert.equal(new Set(FAILURE_TYPES).size, FAILURE_TYPES.length);
  const clockF = createVirtualClock();
  const types = ["http", "body", "no_http", "timeout", "weird"];
  let n = 0;
  const runF = await runSplitPlan({
    plan: planSplit(ECB(Array.from({ length: 20 }, (_, i) => `S${i}`).join("+"))), clock: clockF, limits: { ...FAMILY_LIMITS, maxChunks: 5, maxSends: 5 },
    fetchOnce: async () => { clockF.advance(100); return { ok: false, failure: types[n++] }; },
  });
  assert.deepEqual(runF.results.map((r) => r.failure), ["http", "body", "no_http", "timeout", "no_http"], "unknown failure text falls to no_http; nothing is flattened into one type");
  check("failure types stay separate: http / body / no_http / timeout / cancelled / circuit_blocked / too_large");

  // Budgets: sends, deadline, bytes; and strictly one request at a time.
  let inFlight = 0; let maxInFlight = 0;
  const clockG = createVirtualClock();
  const runG = await runSplitPlan({
    plan: planSplit(ECB(Array.from({ length: 24 }, (_, i) => `S${i}`).join("+"))), clock: clockG,
    fetchOnce: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); clockG.advance(1000); inFlight -= 1; return { ok: true, bytes: 100 }; },
  });
  assert.equal(maxInFlight, 1, "serial: one piece in flight at a time");
  assert.equal(runG.sends, 6);
  assert.equal(FAMILY_LIMITS.concurrency, 1);
  const runH = await runSplitPlan({ plan: planSplit(T13_PARENT), clock: createVirtualClock(), limits: { ...FAMILY_LIMITS, maxSends: 2 }, fetchOnce: async () => ({ ok: true, bytes: 1 }) });
  assert.deepEqual([runH.sends, runH.stopped_by], [2, "budget"]);
  const clockI = createVirtualClock();
  const runI = await runSplitPlan({ plan: planSplit(T13_PARENT), clock: clockI, limits: { ...FAMILY_LIMITS, parentDeadlineMs: 20_000 }, fetchOnce: async () => { clockI.advance(15_000); return { ok: true, bytes: 1 }; } });
  assert.deepEqual([runI.sends, runI.stopped_by], [2, "budget"], "the parent deadline stops further pieces");
  const runJ = await runSplitPlan({ plan: planSplit(T13_PARENT), clock: createVirtualClock(), limits: { ...FAMILY_LIMITS, maxFamilyBytes: 150 }, fetchOnce: async () => ({ ok: true, bytes: 100 }) });
  assert.deepEqual([runJ.sends, runJ.stopped_by], [2, "too_large"]);
  check("family budgets: one at a time, send cap, parent deadline, parent byte cap");

  // The diagnostic keeps type, URL path, intervals, chunk count and time; no query string and nothing else.
  const record = diagnosticRecord({ plan: planSplit(T13_PARENT), mode: "after_timeout", parentSeconds: 30.01, parentOutcome: "timeout" });
  const text = JSON.stringify(record);
  for (const leak of ["startPeriod", "format=", "csvdata", "?", "header", "cookie", "authorization"]) assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `diagnostic has no ${leak}`);
  assert.deepEqual(Object.keys(record).sort(), ["capped", "chunk_count", "family_budget", "host", "intervals", "kind", "mode", "parent", "probe_version", "schema_version", "splittable", "url_path"]);
  assert.equal(record.url_path, "/service/data/EXR/D.USD+JPY+GBP+CHF+CNY+AUD+CAD+KRW+INR+BRL+MXN+TRY.EUR.SP00.A");
  assert.equal(record.chunk_count, 3);
  check("the diagnostic holds only kind, host, URL path, intervals, chunk count, outcome type and time (no query, headers or error text)");
}

// ---------------------------------------------------------------- 4. the real download_data path
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
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "fetch-split-probe-"));
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;
try {
  const treeDir = join(base, "tree");
  mkdirSync(treeDir);
  cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
  stub(treeDir, "typebox", TYPEBOX);
  stub(treeDir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const testCopy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
  writeFileSync(testCopy, stripTypeScriptTypes(readFileSync(join(treeDir, "runtime", "pi", "newsroom.ts"), "utf8"), { mode: "strip" }));
  let instance = 0;
  async function freshTools(env) {
    const mod = await import(`${pathToFileURL(testCopy).href}?instance=${++instance}`);
    for (const key of ["NEWSROOM_FETCH_SPLIT_PROBE", "NEWSROOM_GROUP_BOUNDARY", "NEWSROOM_PHASE"]) delete process.env[key];
    process.env.NEWSROOM_TOOL_PROFILE = "full";
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const tools = new Map();
    mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
    return tools;
  }
  const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
  // The 30 s timer is shortened to 150 ms, and the clock the tool measures it with moves in step: time stands still inside one
  // attempt (frozen at its start) and jumps by exactly 30 s when the shortened timer fires. Without this the two timeouts of the
  // scenario measured 150 ms plus scheduler jitter, the rounded seconds in the two diagnostic records differed now and then, and
  // the records (named by their content hash) came out as two files instead of one.
  let frozenNow = realDateNow();
  let skew = 0;
  Date.now = () => frozenNow + skew;
  globalThis.setTimeout = (fn, delay, ...rest) => (delay === 30_000 ? realSetTimeout(() => { skew += 30_000; fn(...rest); }, 150) : realSetTimeout(fn, delay, ...rest));
  const abortError = () => new DOMException("This operation was aborted", "AbortError");
  const withUrl = (response, url) => { Object.defineProperty(response, "url", { value: url }); return response; };
  const hangs = (signal) => new Promise((_, reject) => { if (signal.aborted) reject(abortError()); else signal.addEventListener("abort", () => reject(abortError()), { once: true }); });
  const SPLITTABLE = "http://203.0.113.7/service/data/EXR/D.USD+JPY+GBP+CHF+CNY+AUD+CAD+KRW.EUR.SP00.A?startPeriod=2023-01-01&format=csvdata&secret=abc";
  const SMALL = "http://203.0.113.7/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2023-01-01";
  const mask = (text, root = "\u0000") => String(text).split(root).join("ROOT").replace(/\d+\.\d s/g, "N s").replace(/[0-9a-f]{64}/g, "H");

  // One scripted scenario per configuration; it returns everything the model could see plus the files written.
  async function scenario(env) {
    const artifact = join(base, `run-${String(++instance).padStart(4, "0")}`);
    mkdirSync(artifact, { recursive: true });
    const tools = await freshTools({ NEWSROOM_ARTIFACT_DIR: artifact, ...env });
    const download = tools.get("download_data");
    frozenNow = realDateNow(); skew = 0;
    const seen = [];
    const out = [];
    const attempt = async (url, behaviour, signal) => {
      globalThis.fetch = (u, init) => { seen.push(String(u)); return behaviour(String(u), init); };
      try { const r = await download.execute("id", { url }, signal); out.push(["ok", mask(r.content[0].text, artifact), mask(JSON.stringify(r.details ?? null), artifact)]); }
      catch (e) { out.push(["error", e.code ?? e.name, mask(e.message, artifact)]); }
    };
    const stalled = (u, init) => Promise.resolve(withUrl(new Response(new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(abortError()), { once: true }); } }), { status: 200, headers: { "content-type": "text/csv" } }), u));
    const good = (u) => Promise.resolve(withUrl(new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv", "content-length": "8" } }), u));
    const http500 = () => Promise.resolve(new Response("nope", { status: 500 }));
    await attempt(SPLITTABLE, stalled);       // timeout 1
    await attempt(SPLITTABLE, stalled);       // timeout 2 (the allowed retry)
    await attempt(SPLITTABLE, stalled);       // refused: DOWNLOAD_TIMEOUT_REPEAT, nothing sent
    await attempt(SMALL, good);               // small list: nothing to report
    await attempt(SPLITTABLE.replace("secret=abc", "secret=def"), good); // a changed request, succeeds
    await attempt(SPLITTABLE.replace("secret=abc", "secret=ghi"), http500);
    const cancel = new AbortController(); cancel.abort();
    await attempt(SPLITTABLE.replace("secret=abc", "secret=jkl"), (_u, init) => hangs(init.signal), cancel.signal);
    const files = walk(artifact).map((f) => f.slice(artifact.length + 1)).filter((f) => !/^data\/(origins\/)?[0-9a-f]{64}/.test(f));
    const dataFiles = walk(artifact).map((f) => f.slice(artifact.length + 1)).filter((f) => /^data\//.test(f)).map((f) => f.replace(/[0-9a-f]{64}/g, "H")).sort();
    return { out, seen, files, dataFiles, artifact };
  }

  const off = await scenario({});
  assert.deepEqual(off.files, [], "off: nothing but the data files was written");
  assert.deepEqual(off.out.slice(0, 5).map((o) => (o[0] === "error" ? o[1] : "ok")), ["DOWNLOAD_TIMEOUT", "DOWNLOAD_TIMEOUT", "DOWNLOAD_TIMEOUT_REPEAT", "ok", "ok"]);
  for (const value of [undefined, "0", "", "yes", " 1", "on", "true", "11"]) {
    const other = await scenario({ NEWSROOM_FETCH_SPLIT_PROBE: value });
    assert.deepEqual(other.out, off.out, `off-state ${JSON.stringify(value)}: same results and errors`);
    assert.deepEqual(other.seen, off.seen, `off-state ${JSON.stringify(value)}: same requests sent`);
    assert.deepEqual(other.files, [], `off-state ${JSON.stringify(value)}: no new file`);
    assert.deepEqual(other.dataFiles, off.dataFiles);
    assert.equal(fetchSplitProbeEnabled({ NEWSROOM_FETCH_SPLIT_PROBE: value }), false);
  }
  assert.equal(fetchSplitProbeEnabled({ NEWSROOM_FETCH_SPLIT_PROBE: "1" }), true);
  check("off-states (unset, 0, empty, yes, ' 1', on, true, 11): same results, same errors, same requests, no new file");

  const on = await scenario({ NEWSROOM_FETCH_SPLIT_PROBE: "1" });
  assert.deepEqual(on.out, off.out, "on: every result and error the model sees is identical");
  assert.deepEqual(on.seen, off.seen, "on: no extra request is sent and none is removed");
  assert.deepEqual(on.dataFiles, off.dataFiles, "on: the data files, metadata and origins are the same");
  assert.equal(off.out[2][1], "DOWNLOAD_TIMEOUT_REPEAT", "the old guard still refuses the third identical request");
  const probeFiles = on.files;
  assert.ok(probeFiles.length >= 1 && probeFiles.every((f) => /^runtime\/fetch-split-probe\/[0-9a-f]{64}\.json$/.test(f)), `only diagnostics were added: ${probeFiles.join(",")}`);
  const records = probeFiles.map((f) => JSON.parse(readFileSync(join(on.artifact, f), "utf8")));
  const outcomes = records.map((r) => `${r.mode}:${r.parent.outcome}`).sort();
  assert.deepEqual(outcomes, ["after_timeout:timeout", "observed:cancelled", "observed:http", "observed:ok"].sort(), "timeout / ok / http / cancel are separate types; the refused repeat sent nothing and wrote nothing; the small request wrote nothing");
  for (const record of records) {
    const text = JSON.stringify(record);
    for (const leak of ["secret", "startPeriod", "csvdata", "203.0.113.7/service", "user-agent", "nope"]) assert.ok(!text.includes(leak), `diagnostic holds no ${leak}`);
    assert.equal(record.chunk_count, 2);
    assert.deepEqual(record.intervals, ["series USD+JPY+GBP+CHF", "series CNY+AUD+CAD+KRW"]);
  }
  check("on: results, errors, requests and data files are identical; only runtime/fetch-split-probe/<hash>.json diagnostics are added, one per splittable request, with the four outcome types apart");

  // One probe run with NEWSROOM_GROUP_BOUNDARY=1: the diagnostic is written by the flow group's writer (probe_writer.mjs, K117 pattern), so the
  // report row is ok, names download_data as requested_by, and neither cross_group nor 待查 grows against the same scenario with the probe off.
  {
    const rowsOf = (artifact) => {
      const report = JSON.parse(readFileSync(join(artifact, "runtime/group-boundary-report.json"), "utf8"));
      return (report.records ?? report.entries ?? report.rows ?? []);
    };
    const count = (rows, status) => rows.filter((r) => r.status === status).reduce((sum, r) => sum + (r.count ?? 1), 0);
    const withBoundary = await scenario({ NEWSROOM_FETCH_SPLIT_PROBE: "1", NEWSROOM_GROUP_BOUNDARY: "1" });
    assert.ok(existsSync(join(withBoundary.artifact, "runtime/group-boundary-report.json")), "the boundary report was written");
    const rows = rowsOf(withBoundary.artifact);
    if (process.env.K99_PRINT_BOUNDARY === "1") console.log(JSON.stringify(rows));
    const probeRows = rows.filter((r) => r.kind === "project_state");
    assert.equal(probeRows.length, 1, "exactly one report row for the diagnostic write");
    const probeRow = probeRows[0];
    assert.equal(probeRow.tool, "probe_writer");
    assert.equal(probeRow.requested_by, "download_data", "the asking tool stays visible");
    assert.equal(probeRow.tool_group, "agent");
    assert.equal(probeRow.owner, "agent");
    assert.equal(probeRow.status, "ok", "the flow group's writer writing under runtime/ (project_state, agent) is ok");
    const plain = await scenario({ NEWSROOM_GROUP_BOUNDARY: "1" });
    const plainRows = rowsOf(plain.artifact);
    assert.ok(!plainRows.some((r) => r.kind === "project_state"), "with the probe off the same scenario adds no project_state row");
    assert.equal(count(rows, "cross_group"), count(plainRows, "cross_group"), "cross_group does not grow");
    assert.equal(count(rows, "待查"), count(plainRows, "待查"), "待查 does not grow");
    check("boundary run (NEWSROOM_GROUP_BOUNDARY=1): the probe write is one ok row by probe_writer (requested_by download_data); cross_group and 待查 equal the probe-off run");
  }

  const groupsMod = await import(pathToFileURL(join(treeDir, "runtime/pi/groups.mjs")).href);
  const classified = groupsMod.classifyArtifact(`runtime/fetch-split-probe/${"a".repeat(64)}.json`);
  assert.deepEqual(classified, { kind: "project_state", owner: "agent" });
  check("boundary: the diagnostic path classifies as project_state (owner agent), which the flow group's probe_writer owns");

  // The writer accepts only its own folder.
  {
    const writerMod = await import(pathToFileURL(join(treeDir, "runtime/pi/probe_writer.mjs")).href);
    const writes = [];
    const w = writerMod.probeWriter({ writeArtifactIfAbsent: async (ref, value) => { writes.push(ref); return ref; } });
    await w.writeDiagnostic("runtime/fetch-split-probe/x.json", { a: 1 });
    for (const bad of ["claims.jsonl", "runtime/fetch-split-probe/../claims.jsonl", "data/x.json", 5]) {
      await assert.rejects(async () => w.writeDiagnostic(bad, {}), /PROBE_WRITER_REF/);
    }
    assert.deepEqual(writes, ["runtime/fetch-split-probe/x.json"]);
    check("probe_writer: accepts only runtime/fetch-split-probe/, refuses any other path");
  }
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Date.now = realDateNow;
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log(`test_fetch_split_probe: ${results.length} checks`);
for (const name of results) console.log(`  ok - ${name}`);
