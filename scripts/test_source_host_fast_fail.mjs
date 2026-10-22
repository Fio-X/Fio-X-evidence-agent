// NEWSROOM_FAST_FAIL=1 (exact "1", default off): a host that could not be reached at all (name not resolved, connection
// refused, no route, connect timeout) is refused for the rest of the run instead of being tried again. No network,
// no model API: fetch is a stub and every host in the tool tests is an IP literal, so nothing is looked up.
//   1. switch off, or no options: every text is the one main writes, whatever the error, nothing is remembered, and the third
//      failure is answered before the error is read.
//   2. switch on, the closed list of codes: each category has its own text and marks the host, and the failure that marks it
//      says so (only that one does); a code outside the list (a reset connection too), no code, an HTTP status, or an abort
//      anywhere in the chain gets no label and marks nothing, and a host that already answered in this run is never marked.
//   3. the refusal: new code, "use a different host", not counted as a failure, other hosts untouched, BLOCKED wins.
//   4. through download_data and fetch_url (a copy of newsroom.ts, fetch stubbed): the second request is refused before it
//      is sent, a redirect hop to a marked host is refused at that hop, and HTTP statuses, the 30 s download timeout,
//      body-read errors, a caller's abort, a reset connection, an unlisted code and a host that answered earlier never mark
//      a host. Only the exact value "1" turns it on.
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
const check = (name) => { results.push(name); };
const { createSourceAccessCircuit } = await import(pathToFileURL(join(ROOT, "runtime/pi/evidence_gate.mjs")).href);

// The texts are written out here, not read from the product, so a wording change has to be made on purpose.
const TAIL = "Do not substitute synthetic data; try a bounded alternative source.";
const NOTE = "This host will not be tried again in this run.";
const failed = (reason, n) => `SOURCE_ACCESS_FAILED: network evidence fetch ${reason} (${n}/3). ${TAIL}`;
// The failure that marked its host says so, between the count and the tail.
const failedMarked = (reason, n) => `SOURCE_ACCESS_FAILED: network evidence fetch ${reason} (${n}/3). ${NOTE} ${TAIL}`;
const blockedText = (n) => `SOURCE_ACCESS_BLOCKED: ${n} consecutive source-access attempts failed. Stop source-dependent reporting; do not substitute synthetic data. Report the access blocker or use a user-supplied local dataset.`;
const BLOCKED3 = blockedText(3);
const GENERIC = "could not reach a public source";
const REASON = {
  connect_timeout: "hit the connect timeout: the host did not accept a connection in time",
  dns: "could not resolve the host name",
  refused: "was refused: the host refused the connection",
  no_route: "found no route to the host",
};
const LABEL = {
  connect_timeout: "connect timeout",
  dns: "host name did not resolve",
  refused: "connection refused",
  no_route: "no route to the host",
};
const refusedText = (host, category) => `SOURCE_HOST_UNREACHABLE: ${host} could not be reached earlier in this run (${LABEL[category]}), so this request was not sent. Use a different host; do not substitute synthetic data.`;
// The final list: which code belongs to which category.
const CATEGORY_OF = {
  UND_ERR_CONNECT_TIMEOUT: "connect_timeout",
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  ECONNREFUSED: "refused",
  EHOSTUNREACH: "no_route",
  ENETUNREACH: "no_route",
};
const RAW = "10.9.8.7:4433 raw-message-marker https://h.example/p?q=raw-query-marker";
const coded = (code, message = `connect ${code} ${RAW}`) => Object.assign(new Error(message), { code });
const fetchFailed = (cause) => Object.assign(new TypeError("fetch failed"), { cause });
const nested = (code, depth) => { let error = coded(code); for (let i = 0; i < depth; i++) error = Object.assign(new TypeError(`wrap ${i}`), { cause: error }); return error; };
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
const fail = (circuit, error, host) => circuit.recordFailure("network evidence fetch", error, host);
const refusalOf = (circuit, host) => { try { circuit.assertAvailable(host); return null; } catch (error) { return error; } };
const on = () => createSourceAccessCircuit(3, { fastFail: () => true });

// ---------------------------------------------------------------- 1. off: the texts of main
for (const [how, make] of [
  ["no options", () => createSourceAccessCircuit(3)],
  ["fastFail returns false", () => createSourceAccessCircuit(3, { fastFail: () => false })],
  ["fastFail returns a truthy value that is not true", () => createSourceAccessCircuit(3, { fastFail: () => "1" })],
  ["fastFail is not a function", () => createSourceAccessCircuit(3, { fastFail: "1" })],
  ["options is null", () => createSourceAccessCircuit(3, null)],
]) {
  const circuit = make();
  for (const code of Object.keys(CATEGORY_OF)) {
    const host = `off-${code}`;
    assert.equal(fail(circuit, fetchFailed(coded(code)), host).message, failed(GENERIC, 1), `${how}: ${code} keeps the generic text`);
    assert.equal(refusalOf(circuit, host), null, `${how}: ${code} leaves the host open`);
    assert.equal(circuit.failureCount(host), 1);
  }
  const aborted = fail(circuit, abortError(), "off-abort");
  assert.equal(aborted.message, failed("timed out or was cancelled", 1));
  assert.equal(aborted.request_aborted, true);
  assert.equal(fail(circuit, new Error("HTTP 403"), "off-http").message, failed("returned HTTP 403", 1));
  assert.equal(fail(circuit, new Error("HTTP 404"), "off-http").message, failed("returned HTTP 404", 2));
  assert.equal(fail(circuit, new Error("HTTP 429"), "off-http").message, BLOCKED3);
  assert.throws(() => circuit.assertAvailable("off-http"), (e) => e.message === BLOCKED3);
  for (const host of ["off-three"]) {
    for (let i = 1; i <= 2; i++) assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), host).message, failed(GENERIC, i));
    assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), host).message, BLOCKED3);
  }
}
check("off (no options, false, a truthy non-true value, no function, null): the generic, abort, HTTP and BLOCKED texts are main's, every listed code leaves the host open");

// Off, the third failure is answered before the error is read, as in main: an error whose message getter throws still gets the
// stop instruction.
for (const [how, make] of [
  ["no options", () => createSourceAccessCircuit(3)],
  ["fastFail returns false", () => createSourceAccessCircuit(3, { fastFail: () => false })],
]) {
  const circuit = make();
  for (let i = 1; i <= 2; i++) assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), "unread").message, failed(GENERIC, i));
  const hostile = { get message() { throw new Error("the error must not be read for the third failure"); } };
  let third;
  assert.doesNotThrow(() => { third = fail(circuit, hostile, "unread"); }, `${how}: the error is not read for the third failure`);
  assert.equal(third.message, BLOCKED3, `${how}: and the answer is the stop instruction`);
}
check("off: the third failure is answered with the stop instruction before the error is read, so an error whose message getter throws still gets it");

// ---------------------------------------------------------------- 2. on: the closed list
for (const [code, category] of Object.entries(CATEGORY_OF)) {
  const circuit = on();
  const host = `on-${code}`;
  const error = fail(circuit, fetchFailed(coded(code)), host);
  assert.equal(error.message, failedMarked(REASON[category], 1), `${code}: text of its category, and it says the host will not be tried again`);
  assert.ok(!("request_aborted" in error), `${code}: no abort flag`);
  assert.equal(refusalOf(circuit, host)?.message, refusedText(host, category), `${code}: the host is refused afterwards`);
}
assert.deepEqual([...new Set(Object.values(CATEGORY_OF))], ["connect_timeout", "dns", "refused", "no_route"]);
assert.equal(new Set(Object.values(REASON)).size, 4, "four different reasons");
assert.equal(new Set(Object.values(LABEL)).size, 4, "four different labels");
check("on: each of the six listed codes gets the text of its category (connect timeout, DNS, refused, no route), says the host will not be tried again, and marks its host");

// The sentence is there exactly when this very call marked the host (the next request is refused): not for a code outside the
// list, an HTTP status, an abort, a missing host key or a host that answered earlier, whatever else those failures say.
{
  const cases = [
    ["a listed code", (c) => [fail(c, fetchFailed(coded("ECONNREFUSED")), "said-listed"), "said-listed"]],
    ["a code outside the list", (c) => [fail(c, fetchFailed(coded("ETIMEDOUT")), "said-unlisted"), "said-unlisted"]],
    ["a reset connection", (c) => [fail(c, fetchFailed(coded("ECONNRESET")), "said-reset"), "said-reset"]],
    ["an HTTP status", (c) => [fail(c, new Error("HTTP 503"), "said-http"), "said-http"]],
    ["an abort over a listed code", (c) => [fail(c, Object.assign(coded("ECONNREFUSED"), { name: "AbortError" }), "said-abort"), "said-abort"]],
    ["a listed code that also says HTTP", (c) => [fail(c, coded("ECONNREFUSED", "read ECONNREFUSED after HTTP 502 from upstream"), "said-mixed"), "said-mixed"]],
    ["a listed code without a host key", (c) => [fail(c, fetchFailed(coded("ECONNREFUSED")), undefined), undefined]],
    ["a listed code on a host that answered earlier", (c) => { c.recordSuccess("said-answered"); return [fail(c, fetchFailed(coded("ECONNREFUSED")), "said-answered"), "said-answered"]; }],
  ];
  let markedCases = 0;
  for (const [what, run] of cases) {
    const circuit = on();
    const [error, host] = run(circuit);
    // One failure per host, so any refusal afterwards is the mark (the stop instruction needs three).
    const marked = refusalOf(circuit, host) !== null;
    if (marked) markedCases += 1;
    assert.equal(error.message.includes(NOTE), marked, `${what}: the sentence is there exactly when the failure marked the host`);
  }
  assert.ok(markedCases >= 1, "the table holds a failure that marks");
}
check("on: the sentence that the host will not be tried again is said exactly when that failure marked the host, never for an unlisted code, an HTTP status, an abort, a missing host key or a host that answered earlier");

const OUTSIDE = ["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "ECONNABORTED", "EPIPE", "EADDRNOTAVAIL", "EACCES", "ENOENT", "ERR_INVALID_URL", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "econnrefused", "ECONNREFUSED ", "UND_ERR_CONNECT_TIMEOUT_X", ""];
for (const code of OUTSIDE) {
  const circuit = on();
  assert.equal(fail(circuit, fetchFailed(coded(code)), "out").message, failed(GENERIC, 1), `${JSON.stringify(code)} is not on the list`);
  assert.equal(refusalOf(circuit, "out"), null, `${JSON.stringify(code)} marks nothing`);
}
check(`on: ${OUTSIDE.length} codes outside the list (ETIMEDOUT, header, body and socket timeouts, abort codes, TLS, wrong case, near misses) keep the generic text and mark nothing`);

// A reset connection usually comes back quickly, so recording the host would save little time, and a proxy blip would also hit a
// host that works: ECONNRESET is deliberately not on the list.
{
  const circuit = on();
  for (let i = 1; i <= 2; i++) {
    assert.equal(fail(circuit, fetchFailed(coded("ECONNRESET")), "reset.example").message, failed(GENERIC, i), `ECONNRESET ${i}: the generic text, no word about the host`);
    assert.equal(refusalOf(circuit, "reset.example"), null, `ECONNRESET ${i}: the host is not marked, the next request goes out as usual`);
  }
  assert.equal(circuit.failureCount("reset.example"), 2, "ECONNRESET is counted like any other failure");
  assert.equal(fail(circuit, nested("ECONNRESET", 2), "reset-deep.example").message, failed(GENERIC, 1), "ECONNRESET two levels down is not on the list either");
  assert.equal(refusalOf(circuit, "reset-deep.example"), null, "and marks nothing there");
  assert.equal(fail(circuit, fetchFailed(coded("ECONNRESET")), "reset.example").message, BLOCKED3, "the third reset is the stop instruction, as for any failure");
}
check("on: ECONNRESET is not on the list: the generic text, no mark, counted like any other failure, and the third one is the stop instruction");

for (const [what, error] of [
  ["a plain error", new Error("fetch failed")],
  ["fetch failed over a plain cause", fetchFailed(new Error("inner"))],
  ["a numeric code", Object.assign(new Error("x"), { code: 111 })],
  ["an array code", Object.assign(new Error("x"), { code: ["ECONNREFUSED"] })],
  ["a thrown string", "boom"],
  ["undefined", undefined],
  ["null", null],
  ["an empty object", {}],
  ["an AggregateError whose own code is missing (its errors are not walked)", new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")], "all failed")],
  ["an outer code outside the list over an inner listed one (the first code decides)", Object.assign(new Error("outer"), { code: "ETIMEDOUT", cause: coded("ECONNREFUSED") })],
  ["the listed code four levels down", nested("ECONNREFUSED", 4)],
]) {
  const circuit = on();
  assert.equal(fail(circuit, error, "no-label").message, failed(GENERIC, 1), what);
  assert.equal(refusalOf(circuit, "no-label"), null, `${what}: marks nothing`);
}
check("on: no code, a non-string code, a thrown string, undefined, null, an AggregateError without its own code, an outer unlisted code and a code four levels down get no label");

for (const depth of [0, 1, 2, 3]) {
  const circuit = on();
  assert.equal(fail(circuit, nested("ECONNREFUSED", depth), "deep").message, failedMarked(REASON.refused, 1), `depth ${depth}`);
  assert.ok(refusalOf(circuit, "deep"), `depth ${depth} marks`);
}
{
  const circuit = on();
  const aggregate = Object.assign(new AggregateError([coded("ECONNREFUSED", "a"), coded("ECONNREFUSED", "b")], "all failed"), { code: "ECONNREFUSED" });
  assert.equal(fail(circuit, fetchFailed(aggregate), "agg").message, failedMarked(REASON.refused, 1), "the AggregateError's own code counts");
  const outerFirst = Object.assign(new Error("outer"), { code: "ECONNREFUSED", cause: coded("ETIMEDOUT") });
  assert.equal(fail(circuit, outerFirst, "outer").message, failedMarked(REASON.refused, 1), "the first code found decides, a listed outer code over an unlisted inner one");
  const loop = coded("ECONNREFUSED"); loop.cause = loop;
  assert.equal(fail(circuit, loop, "loop").message, failedMarked(REASON.refused, 1), "a listed code on the error itself decides at once, even when its cause points back at it");
  const loopNoCode = new Error("loop"); loopNoCode.cause = loopNoCode;
  assert.equal(fail(circuit, loopNoCode, "loop2").message, failed(GENERIC, 1), "a cause that points at itself and has no code ends at the depth limit, with the generic text");
}
check("on: the cause chain is read four levels deep (levels 0 to 3), an AggregateError's own code counts, the first code found decides, a cyclic cause ends");

{
  const circuit = on();
  const direct = Object.assign(coded("ECONNREFUSED"), { name: "AbortError" });
  const aborted = fail(circuit, direct, "abort-0");
  assert.equal(aborted.message, failed("timed out or was cancelled", 1), "abort-0: the abort text, with no word about the host");
  assert.equal(aborted.request_aborted, true);
  const deep = Object.assign(coded("ECONNREFUSED"), { cause: Object.assign(new Error("mid"), { cause: abortError() }) });
  assert.equal(fail(circuit, deep, "abort-2").message, failed("timed out or was cancelled", 1), "an abort two levels down wins over a listed code on top");
  const domException = fetchFailed(new DOMException("This operation was aborted", "AbortError"));
  assert.equal(fail(circuit, domException, "abort-dom").message, failed("timed out or was cancelled", 1));
  for (const host of ["abort-0", "abort-2", "abort-dom"]) assert.equal(refusalOf(circuit, host), null, `${host} marks nothing`);
}
check("on: an abort anywhere in the chain wins over a listed code, keeps the abort text and flag, and marks nothing");

{
  const circuit = on();
  for (const [status, host] of [[403, "s403"], [404, "s404"], [429, "s429"], [500, "s500"], [503, "s503"]]) {
    assert.equal(fail(circuit, new Error(`HTTP ${status}`), host).message, failed(`returned HTTP ${status}`, 1), `HTTP ${status}`);
    assert.equal(refusalOf(circuit, host), null, `HTTP ${status} marks nothing`);
  }
  const mixed = fail(circuit, coded("ECONNREFUSED", "read ECONNREFUSED after HTTP 502 from upstream"), "mixed");
  assert.equal(mixed.message, failed("returned HTTP 502", 1), "an error that says it carried a status keeps the HTTP text");
  assert.equal(refusalOf(circuit, "mixed"), null, "and marks nothing");
}
check("on: HTTP statuses (403, 404, 429, 500, 503) keep their text and mark nothing, even when the error also carries a listed code");

{
  const circuit = on();
  const secretish = fail(circuit, fetchFailed(coded("ECONNREFUSED")), "raw.example");
  const refusal = refusalOf(circuit, "raw.example");
  for (const error of [secretish, refusal]) {
    const visible = [error.message, JSON.stringify(error), String(error.stack), Object.keys(error).join(",")].join("\n");
    for (const marker of ["raw-message-marker", "raw-query-marker", "10.9.8.7", "4433", "fetch failed", "ECONNREFUSED", "TypeError"]) assert.ok(!visible.includes(marker), `nothing of the raw error is carried: ${marker}`);
    assert.ok(!("cause" in error), "the raw error is not kept as cause");
  }
  assert.deepEqual(Object.keys(refusal).sort(), ["code", "host"]);
}
check("on: neither the first failure nor the refusal carries the raw message, address, query, code or cause");

// ---------------------------------------------------------------- 3. the refusal
{
  const circuit = on();
  fail(circuit, fetchFailed(coded("UND_ERR_CONNECT_TIMEOUT")), "a.example");
  assert.equal(circuit.failureCount("a.example"), 1);
  let last;
  for (let i = 0; i < 6; i++) {
    const refusal = refusalOf(circuit, "a.example");
    assert.equal(refusal.message, refusedText("a.example", "connect_timeout"));
    last = fail(circuit, refusal, "a.example");   // safeFetch hands the refusal it caught back to recordFailure
    assert.equal(last, refusal, "returned as it is");
  }
  assert.equal(circuit.failureCount("a.example"), 1, "six refusals did not count as failures");
  assert.equal(circuit.isBlocked("a.example"), false, "so the host never turns BLOCKED");
  assert.equal(last.code, "SOURCE_HOST_UNREACHABLE", "the refusal has its own code");
  assert.equal(last.host, "a.example");
  assert.match(last.message, /^SOURCE_HOST_UNREACHABLE: /);
  assert.match(last.message, /Use a different host/);
  assert.ok(!/Stop source-dependent reporting|SOURCE_ACCESS_BLOCKED/.test(last.message), "not the stop instruction");
  assert.equal(refusalOf(circuit, "b.example"), null, "another host is open");
  assert.equal(circuit.failureCount("b.example"), 0);
  fail(circuit, new Error("HTTP 500"), "b.example");
  assert.equal(refusalOf(circuit, "b.example"), null, "an HTTP failure on another host marks nothing there either");
  assert.equal(refusalOf(circuit, "a.example")?.code, "SOURCE_HOST_UNREACHABLE", "and the first host stays marked");
  const key = fail(circuit, fetchFailed(coded("ECONNREFUSED")), undefined);
  assert.equal(key.message, failed(REASON.refused, 1), "a failure without a host still gets its text, and says nothing about the host");
  assert.equal(refusalOf(circuit, undefined), null, "but there is no host to mark");
  assert.equal(refusalOf(circuit, "global"), null);
}
check("refusal: new code and host, 'use a different host', never the stop instruction; six refusals are not failures; another host and a missing host key are untouched");

{
  const circuit = on();
  for (let i = 1; i <= 2; i++) assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), "x.example").message, failedMarked(REASON.refused, i));
  assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), "x.example").message, BLOCKED3, "the third failure is the stop instruction");
  assert.equal(refusalOf(circuit, "x.example")?.message, BLOCKED3, "BLOCKED wins over the refusal for a host that is both");
  for (let i = 0; i < 3; i++) fail(circuit, new Error("HTTP 500"), "y.example");
  assert.equal(circuit.isBlocked("y.example"), true);
  fail(circuit, fetchFailed(coded("ECONNREFUSED")), "y.example");
  assert.match(refusalOf(circuit, "y.example")?.message ?? "", /^SOURCE_ACCESS_BLOCKED: /, "a listed failure after BLOCKED does not soften it");
}
check("refusal: a host that is blocked by three failures answers with SOURCE_ACCESS_BLOCKED, never with the softer refusal");

{
  let flag = true;
  const circuit = createSourceAccessCircuit(3, { fastFail: () => flag });
  fail(circuit, fetchFailed(coded("ENOTFOUND")), "flip.example");
  assert.equal(refusalOf(circuit, "flip.example")?.code, "SOURCE_HOST_UNREACHABLE");
  flag = false;
  assert.equal(refusalOf(circuit, "flip.example"), null, "off again: the memory is ignored, main's behaviour");
  assert.equal(fail(circuit, fetchFailed(coded("ENOTFOUND")), "flip2.example").message, failed(GENERIC, 1), "off again: no label");
  flag = true;
  assert.equal(refusalOf(circuit, "flip2.example"), null, "a failure recorded while off marked nothing");
  assert.equal(refusalOf(circuit, "flip.example")?.code, "SOURCE_HOST_UNREACHABLE", "the earlier mark is back when it is on again");
  const hostile = createSourceAccessCircuit(3, { fastFail() { throw new Error("must not be called with the switch off"); } });
  assert.throws(() => fail(hostile, new Error("x"), "z"), /must not be called/, "the switch is read at every call");
}
check("the switch is read at every call: off ignores the memory and labels nothing, on brings the earlier marks back");

// One failure reads the switch once: the label, the mark and the sentence all follow that one reading (the stub says on for the
// first read and off for every later one).
{
  let reads = 0;
  const circuit = createSourceAccessCircuit(3, { fastFail: () => ++reads === 1 });
  assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), "once.example").message, failedMarked(REASON.refused, 1), "one failure reads the switch once: the text, the mark and the sentence all come from that one reading");
  assert.equal(reads, 1, "the switch is read once for one failure");
}
check("the switch is read once per failure: the label, the mark and the sentence all follow the one reading");

{
  const circuit = on();
  fail(circuit, fetchFailed(coded("ENOTFOUND")), "sticky.example");
  circuit.recordSuccess("sticky.example");
  assert.equal(circuit.failureCount("sticky.example"), 0, "a success clears the failure count, as before");
  assert.equal(refusalOf(circuit, "sticky.example")?.code, "SOURCE_HOST_UNREACHABLE", "a later success does not clear the mark: it lasts for the run");
}
check("a success clears the failure count as before but not the mark: a marked host stays refused for the rest of the run");

// A host that answered in this run was not unreachable at all, so a later connection failure (a dropped keep-alive socket, a
// proxy blip) is a failure like any other: counted, with its text, never marked. Success and failure meet under the same key
// (a number and its text are one host key).
{
  const circuit = on();
  circuit.recordSuccess("answered.example");
  assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), "answered.example").message, failed(REASON.refused, 1), "a host that answered earlier gets its text, without a word about marking it");
  assert.equal(refusalOf(circuit, "answered.example"), null, "a host that answered earlier in the run is not marked by a later connection failure");
  assert.equal(circuit.failureCount("answered.example"), 1, "and the failure is counted as usual");
  circuit.recordSuccess(7);
  assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), "7").message, failed(REASON.refused, 1), "a success recorded under the number 7 covers the host key \"7\": its text, without a word about marking it");
  assert.equal(refusalOf(circuit, "7"), null, "a success recorded under the number 7 covers the host key \"7\"");
  circuit.recordSuccess("9");
  assert.equal(fail(circuit, fetchFailed(coded("ECONNREFUSED")), 9).message, failed(REASON.refused, 1), "a success recorded under \"9\" covers the host key 9: its text, without a word about marking it");
  assert.equal(refusalOf(circuit, 9), null, "a success recorded under \"9\" covers the host key 9");
}
check("a host that answered earlier in the run is not marked by a later listed failure (the same key normalisation on both sides), and the failure is counted as usual");

// ---------------------------------------------------------------- 4. through the tools
const stubPackage = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const treeDir = makeTestTmp("fast-fail-host-tree-");
cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
stubPackage(treeDir, "typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stubPackage(treeDir, "@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const testCopy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(testCopy, stripTypeScriptTypes(readFileSync(join(treeDir, "runtime", "pi", "newsroom.ts"), "utf8"), { mode: "strip" }));
process.env.NEWSROOM_TOOL_PROFILE = "full";
delete process.env.NEWSROOM_PHASE;
// Left unset, as CI has them, whatever the caller's shell holds.
delete process.env.NEWSROOM_FAULT_INJECT_TOOL_ONCE;
delete process.env.NEWSROOM_REFUSAL_FIELDS;
process.env.NEWSROOM_SYMBOL_MAP = "0";
// A fresh newsroom.ts instance per scenario: its circuit and its download guard start empty.
let instance = 0;
async function freshTools() {
  const mod = await import(`${pathToFileURL(testCopy).href}?instance=${++instance}`);
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return { download: tools.get("download_data"), fetchUrl: tools.get("fetch_url") };
}
const runsDir = makeTestTmp("fast-fail-host-runs-");
let runs = 0;
const newRun = () => {
  const dir = join(runsDir, `run-${++runs}`);
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(dir, d), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  return dir;
};

const H1 = "203.0.113.7", H2 = "203.0.113.8", H3 = "203.0.113.9";
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
// The tool's own 30 s timer fires after 150 ms; every other timer is untouched.
globalThis.setTimeout = (fn, delay, ...rest) => realSetTimeout(fn, delay === 30_000 ? 150 : delay, ...rest);
const withUrl = (response, url) => { Object.defineProperty(response, "url", { value: url }); return response; };
const csv = (url) => withUrl(new Response("year,total\n2020,10\n2021,12\n", { status: 200, headers: { "content-type": "text/csv" } }), url);
// A fetch that is aborted rejects with the reason it was aborted with (the platform's own AbortError when none was given).
const abortReject = (signal) => new Promise((_, reject) => {
  const fail = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
  if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
});
let fetchCalls = [];
const stubFetch = (handler) => { fetchCalls = []; globalThis.fetch = (url, init) => { fetchCalls.push(String(url)); return handler(String(url), init); }; };
const caught = async (promise) => { try { await promise; } catch (error) { return error; } assert.fail("expected the call to throw"); };
// For a request that should go through: a refusal comes back as a value, so the check says so in its own words.
const settle = async (promise) => { try { return { value: await promise }; } catch (error) { return { error }; } };
const connectTimeout = () => Promise.reject(fetchFailed(Object.assign(new Error(`Connect Timeout Error ${RAW}`), { code: "UND_ERR_CONNECT_TIMEOUT" })));
const SWITCH = "NEWSROOM_FAST_FAIL";
const setSwitch = (value) => { if (value === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = value; };

try {
  // 4.1 connect timeout: the second request to the host is refused before it is sent
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    stubFetch((url) => (url.startsWith(`http://${H1}/`) ? connectTimeout() : Promise.resolve(csv(url))));
    const first = await caught(download.execute("id", { url: `http://${H1}/a.csv?q=raw-query-marker` }));
    assert.equal(first.message, failedMarked(REASON.connect_timeout, 1), "tools: the first failure has the connect timeout text and says the host will not be tried again");
    assert.deepEqual(fetchCalls, [`http://${H1}/a.csv?q=raw-query-marker`]);
    for (let i = 0; i < 6; i++) {
      const refused = await caught(download.execute("id", { url: `http://${H1}/b${i}.csv` }));
      assert.equal(refused.message, refusedText(H1, "connect_timeout"), `refusal ${i}: never the stop instruction`);
      assert.equal(refused.code, "SOURCE_HOST_UNREACHABLE");
    }
    assert.equal(fetchCalls.length, 1, "the six refused requests were not sent");
    const other = await download.execute("id", { url: `http://${H2}/ok.csv` });
    assert.match(other.content[0].text, /^Downloaded \d+ bytes\./, "another host still downloads");
    assert.equal(fetchCalls.length, 2);
    const visible = [first.message, JSON.stringify(first), String(first.stack)].join("\n");
    for (const marker of ["raw-message-marker", "raw-query-marker", "10.9.8.7", "4433", "Connect Timeout Error"]) assert.ok(!visible.includes(marker), `first failure: no ${marker}`);
    check("tools: a connect timeout gives the new text, the next six requests to that host are refused without a fetch and never turn BLOCKED, another host downloads");
  }

  // 4.2 redirect hops
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    stubFetch((url) => {
      if (url.startsWith(`http://${H2}/`) || url.startsWith(`http://${H3}/`)) return connectTimeout();
      return Promise.resolve(url.endsWith("/start.csv") ? new Response(null, { status: 302, headers: { location: `http://${H2}/hop.csv` } }) : csv(url));
    });
    await caught(download.execute("id", { url: `http://${H2}/direct.csv` }));
    fetchCalls = [];
    const hop = await caught(download.execute("id", { url: `http://${H1}/start.csv` }));
    assert.equal(hop.message, refusedText(H2, "connect_timeout"), "refused at the hop, and it names the host of the hop");
    assert.deepEqual(fetchCalls, [`http://${H1}/start.csv`], "the first host answered with a redirect; the marked host was never contacted");

    // a hop that cannot be reached marks that host only
    const second = await freshTools();
    stubFetch((url) => {
      if (url.startsWith(`http://${H3}/`)) return connectTimeout();
      return Promise.resolve(url.endsWith("/start.csv") ? new Response(null, { status: 302, headers: { location: `http://${H3}/hop.csv` } }) : csv(url));
    });
    const lost = await caught(second.download.execute("id", { url: `http://${H1}/start.csv` }));
    assert.equal(lost.message, failedMarked(REASON.connect_timeout, 1), "the hop that could not be reached has the connect timeout text and says its host will not be tried again");
    // The failure of the hop belongs to the host of the hop: the host that redirected is asked again, not refused.
    const probe = await settle(second.download.execute("id", { url: `http://${H1}/probe.csv` }));
    assert.equal(probe.error?.code, undefined, "the host that redirected is still asked: the failure of its hop did not mark it");
    const ok = await second.download.execute("id", { url: `http://${H1}/plain.csv` });
    assert.match(ok.content[0].text, /^Downloaded \d+ bytes\./, "the host that redirected is not marked");
    const again = await caught(second.download.execute("id", { url: `http://${H3}/x.csv` }));
    assert.equal(again.message, refusedText(H3, "connect_timeout"), "the host that could not be reached is");
    check("tools: a redirect to a marked host is refused at that hop, and a hop that cannot be reached marks that host, not the one that redirected");
  }

  // 4.3 HTTP statuses
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    const hosts = { 403: "203.0.113.21", 404: "203.0.113.22", 429: "203.0.113.23", 500: "203.0.113.24" };
    let answer = 403;
    stubFetch((url) => Promise.resolve(answer ? new Response("no", { status: answer }) : csv(url)));
    for (const [status, host] of Object.entries(hosts)) {
      answer = Number(status);
      const error = await caught(download.execute("id", { url: `http://${host}/a.csv` }));
      assert.equal(error.message, failed(`returned HTTP ${status}`, 1));
      answer = 0;
      const calls = fetchCalls.length;
      const next = await download.execute("id", { url: `http://${host}/b.csv` });
      assert.equal(fetchCalls.length, calls + 1, `HTTP ${status}: the next request is sent`);
      assert.match(next.content[0].text, /^Downloaded/);
    }
    check("tools: HTTP 403, 404, 429 and 500 are not recorded, the next request to the host is sent and downloads");
  }

  // 4.4 the 30 s download timeout, in the header phase and in the body phase
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    stubFetch((_url, init) => abortReject(init.signal));
    const header = await caught(download.execute("id", { url: `http://${H1}/slow.csv` }));
    assert.equal(header.code, "DOWNLOAD_TIMEOUT", "the structured timeout, as before");
    const calls = fetchCalls.length;
    stubFetch((url, init) => Promise.resolve(withUrl(new Response(new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(new DOMException("This operation was aborted", "AbortError")), { once: true }); } }), { status: 200, headers: { "content-type": "text/csv" } }), url)));
    const body = await caught(download.execute("id", { url: `http://${H1}/slow2.csv` }));
    assert.equal(fetchCalls.length, 1, "after a header timeout the next request to the host is sent");
    assert.equal(body.code, "DOWNLOAD_TIMEOUT", "the structured timeout after the headers, as before");
    stubFetch((url) => Promise.resolve(csv(url)));
    const after = await download.execute("id", { url: `http://${H1}/fine.csv` });
    assert.equal(fetchCalls.length, 1, "after a body timeout too");
    assert.match(after.content[0].text, /^Downloaded/);
    assert.equal(calls, 1);
    check("tools: the 30 s download timeout, before and after the headers, keeps its text and does not mark the host");
  }

  // 4.5 a body-read error that carries a listed code
  {
    setSwitch("1"); newRun();
    const { download, fetchUrl } = await freshTools();
    const brokenBody = (url) => withUrl(new Response(new ReadableStream({ start(c) { c.error(Object.assign(new TypeError("terminated"), { cause: coded("ECONNREFUSED") })); } }), { status: 200, headers: { "content-type": "text/csv" } }), url);
    stubFetch((url) => Promise.resolve(brokenBody(url)));
    const viaDownload = await caught(download.execute("id", { url: `http://${H1}/cut.csv` }));
    assert.ok(!/SOURCE_HOST_UNREACHABLE/.test(viaDownload.message), "download_data: the body error does not mark the host");
    // The host that answered but whose body broke is asked again at once (a refusal comes back as a value, not a crash).
    await settle(download.execute("id", { url: `http://${H1}/cut2.csv` }));
    assert.equal(fetchCalls.length, 2, "download_data: the host is not marked by its body, the next request is sent");
    // ... the broken body is not counted against it, and the host did answer, so a later connect timeout is its first failure and
    // does not mark it.
    stubFetch(() => connectTimeout());
    const counted = await caught(download.execute("id", { url: `http://${H1}/count.csv` }));
    assert.equal(counted.message, failed(REASON.connect_timeout, 1), "download_data: after a body error the host has answered: a later connect timeout is its first failure (1/3) and does not mark it");
    stubFetch((url) => Promise.resolve(csv(url)));
    const next = await download.execute("id", { url: `http://${H1}/next.csv` });
    assert.equal(fetchCalls.length, 1, "download_data: the host is not marked by its body");
    assert.match(next.content[0].text, /^Downloaded/);
    check("tools: download_data: a body read that fails with a listed code does not mark the host and is not counted against it, and the host counts as having answered");

    stubFetch((url) => Promise.resolve(withUrl(new Response(new ReadableStream({ start(c) { c.error(Object.assign(new TypeError("terminated"), { cause: coded("ECONNREFUSED") })); } }), { status: 200, headers: { "content-type": "text/html" } }), url)));
    const viaFetchUrl = await caught(fetchUrl.execute("id", { url: `http://${H2}/page.html` }));
    assert.ok(!/SOURCE_HOST_UNREACHABLE|SOURCE_ACCESS_/.test(viaFetchUrl.message), "fetch_url: a body error is not turned into a source-access failure");
    stubFetch(() => Promise.resolve(new Response("no", { status: 404 })));
    const after = await caught(fetchUrl.execute("id", { url: `http://${H2}/other.html` }));
    assert.equal(after.message, failed("returned HTTP 404", 1), "fetch_url: the next request to the host is sent, and the body error was not counted against it (1/3)");
    assert.equal(fetchCalls.length, 1);
    // The headers arrived, so the host answered: a later connect timeout is its second failure (after the 404) and does not mark it.
    stubFetch(() => connectTimeout());
    const later = await caught(fetchUrl.execute("id", { url: `http://${H2}/gone.html` }));
    assert.equal(later.message, failed(REASON.connect_timeout, 2), "fetch_url: a host that answered (its body then broke) is not marked by a later connect timeout: counted as the second failure, without the sentence");
    assert.equal(fetchCalls.length, 1);
    check("tools: fetch_url: a body read that fails with a listed code is not recorded as a source-access failure and does not mark the host, and the host counts as having answered");
  }

  // 4.6 an unlisted code, no code, a private address and a caller's abort: main's behaviour with the switch on
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    stubFetch(() => Promise.reject(fetchFailed(coded("ETIMEDOUT"))));
    const one = await caught(download.execute("id", { url: `http://${H1}/a.csv` }));
    const two = await caught(download.execute("id", { url: `http://${H1}/b.csv` }));
    const three = await caught(download.execute("id", { url: `http://${H1}/c.csv` }));
    assert.deepEqual([one.message, two.message, three.message], [failed(GENERIC, 1), failed(GENERIC, 2), BLOCKED3], "ETIMEDOUT: counted three times, then the stop instruction, as before");
    assert.equal(fetchCalls.length, 3, "all three attempts were sent");
    const four = await caught(download.execute("id", { url: `http://${H1}/d.csv` }));
    assert.equal(four.message, blockedText(4), "the fourth is the stop instruction, as before (main counts the refused request too)");
    assert.equal(fetchCalls.length, 3, "and it is stopped before any fetch");

    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    assert.equal((await caught(download.execute("id", { url: `http://${H2}/a.csv` }))).message, failed(GENERIC, 1), "no code");
    assert.equal((await caught(download.execute("id", { url: `http://${H2}/b.csv` }))).message, failed(GENERIC, 2), "no code: sent again");
    assert.equal(fetchCalls.length, 2);

    stubFetch((url) => Promise.resolve(csv(url)));
    assert.equal((await caught(download.execute("id", { url: "http://10.9.8.7/p.csv" }))).message, failed(GENERIC, 1), "a private address");
    assert.equal((await caught(download.execute("id", { url: "http://10.9.8.7/q.csv" }))).message, failed(GENERIC, 2), "a private address: asked again, not refused as a host");
    assert.equal(fetchCalls.length, 0, "a private address is stopped before any fetch");

    const caller = new AbortController();
    stubFetch((_url, init) => { queueMicrotask(() => caller.abort()); return abortReject(init.signal); });
    const cancelled = await caught(download.execute("id", { url: `http://${H3}/a.csv` }, caller.signal));
    assert.equal(cancelled.message, failed("timed out or was cancelled", 1));
    stubFetch((url) => Promise.resolve(csv(url)));
    await download.execute("id", { url: `http://${H3}/b.csv` });
    assert.equal(fetchCalls.length, 1, "a caller's abort: the next request is sent");
    check("tools: an unlisted code, no code, a private address and a caller's abort behave as with the switch off: counted, never refused as an unreachable host, the third failure is the stop instruction");
  }

  // 4.7 only the exact value "1" turns it on
  {
    newRun();
    const { download } = await freshTools();
    let n = 0;
    for (const value of [undefined, "0", "", "true", "yes", "2", "01", " 1", "1 ", "on"]) {
      setSwitch(value);
      const host = `203.0.113.${100 + n++}`;
      stubFetch(() => connectTimeout());
      const first = await caught(download.execute("id", { url: `http://${host}/a.csv` }));
      const second = await caught(download.execute("id", { url: `http://${host}/b.csv` }));
      assert.equal(first.message, failed(GENERIC, 1), `value ${JSON.stringify(value)}: main's text`);
      assert.equal(second.message, failed(GENERIC, 2), `value ${JSON.stringify(value)}: the second request is sent`);
      assert.equal(fetchCalls.length, 2);
    }
    setSwitch("1");
    const host = `203.0.113.${100 + n}`;
    stubFetch(() => connectTimeout());
    assert.equal((await caught(download.execute("id", { url: `http://${host}/a.csv` }))).message, failedMarked(REASON.connect_timeout, 1));
    assert.equal((await caught(download.execute("id", { url: `http://${host}/b.csv` }))).message, refusedText(host, "connect_timeout"));
    assert.equal(fetchCalls.length, 1);
    // flipping it off in the middle of a run: main's behaviour at once, and the memory is back when it is on again
    setSwitch("0");
    stubFetch(() => connectTimeout());
    assert.equal((await caught(download.execute("id", { url: `http://${host}/c.csv` }))).message, failed(GENERIC, 2), "off again: sent, main's text (the labelled failure was counted as well)");
    assert.equal(fetchCalls.length, 1);
    setSwitch("1");
    assert.equal((await caught(download.execute("id", { url: `http://${host}/d.csv` }))).code, "SOURCE_HOST_UNREACHABLE");
    check("tools: unset, 0, empty, true, yes, 2, 01, ' 1', '1 ' and on are off; only the exact 1 is on, and it is read at every request");
  }

  // 4.8 a host that answered in this run is not marked by a later connect timeout
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    let reachable = true;
    stubFetch((url) => (reachable ? Promise.resolve(csv(url)) : connectTimeout()));
    const answered = await download.execute("id", { url: `http://${H1}/a.csv` });
    assert.match(answered.content[0].text, /^Downloaded/, "the host answers first");
    reachable = false;
    const lost = await caught(download.execute("id", { url: `http://${H1}/b.csv` }));
    assert.equal(lost.message, failed(REASON.connect_timeout, 1), "tools: a connect timeout after an earlier answer gets its text but does not mark the host");
    const again = await caught(download.execute("id", { url: `http://${H1}/c.csv` }));
    assert.equal(fetchCalls.length, 3, "tools: the next request to a host that answered earlier is sent");
    assert.equal(again.message, failed(REASON.connect_timeout, 2), "tools: and it is counted as the second failure, not refused");
    check("tools: a host that answered earlier in the run is not marked by a later connect timeout: its text without the sentence about the host, the next request is sent and counted");
  }

  // 4.9 a reset connection is not on the list
  {
    setSwitch("1"); newRun();
    const { download } = await freshTools();
    stubFetch(() => Promise.reject(fetchFailed(coded("ECONNRESET"))));
    const one = await caught(download.execute("id", { url: `http://${H1}/a.csv` }));
    const two = await caught(download.execute("id", { url: `http://${H1}/b.csv` }));
    assert.equal(one.message, failed(GENERIC, 1), "tools: a reset connection gets the generic text");
    assert.equal(two.message, failed(GENERIC, 2), "tools: the next request to the host goes out as usual and is counted as the second failure");
    assert.equal(fetchCalls.length, 2, "tools: both requests were sent");
    const three = await caught(download.execute("id", { url: `http://${H1}/c.csv` }));
    assert.equal(three.message, BLOCKED3, "tools: the third reset is the stop instruction, as for any failure");
    assert.equal(fetchCalls.length, 3, "tools: and it was sent too");
    check("tools: a reset connection (ECONNRESET) is not on the list: the generic text, the next request goes out as usual, the third failure is the stop instruction");
  }
} finally {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  setSwitch(undefined);
}

console.log(`test_source_host_fast_fail: ok (${results.length} checks)`);
