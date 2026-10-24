// Mutation check for scripts/test_source_host_fast_fail.mjs: each rule of NEWSROOM_FAST_FAIL is weakened once, in a temp copy, and the
// test must go red AND print that rule's own assertion text (a crash or a syntax error cannot pass as a catch). Two groups: the circuit
// (runtime/pi/evidence_gate.mjs) and the lines in runtime/pi/newsroom.ts that hand it the switch, ask it before every request and decide
// what a redirect hop, a body read or the 30 s timer may tell it.
import { runMutants } from "./mutant_lib.mjs";

const TEST = "test_source_host_fast_fail.mjs";
const esc = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const CONTROL = /test_source_host_fast_fail: ok \(\d+ checks\)/;

// the closed list, one mutant per code: dropping any single entry must be noticed by the code's own assertion
const LIST = [
  ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "refused"],
  ["EHOSTUNREACH", "no_route"],
  ["ENETUNREACH", "no_route"],
];

// the gate that decides when to read the code of an error, written once so the two chain-depth mutants share the anchor
const LOOP = `  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {\n    if (typeof current.code === "string") return`;
const FIRST_CODE = `    if (typeof current.code === "string") return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? null;`;
const LABELLING = `const category = fastFail && !http ? unreachableCategory(error) : null;`;
const MARK_COND = `if (category && key != null && !succeededKeys.has(normalizedKey)) {`;
const MARK_SET = `unreachableByKey.set(normalizedKey, category);`;
// the sentence of the first failure sits inside the product's template literal, so the slot and its variants are plain strings
const NOTE_SLOT = "${marked ? `${UNREACHABLE_NOTE} ` : \"\"}";
// with the switch off, the last allowed failure is answered before the error is read (two lines, swapped together)
const OFF_RETURN = "      if (!fastFail && failures >= boundedLimit) return blocked(normalizedKey);\n      const message = String(error?.message ?? error ?? \"\");";
const FAST_FAIL_ON = `const fastFailOn = () => typeof options?.fastFail === "function" && options.fastFail() === true;`;
// download_data's count of a body read that failed, written once so the guard mutant and the constructed mutant share the anchor
const COUNTED = `const counted = timedOut && bodyPhase ? sourceAccessCircuit.recordFailure("download_data body read", error, answeredHost) : error;`;
const LISTED_ERROR = `Object.assign(new Error("timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" })`;

console.log("-- circuit: runtime/pi/evidence_gate.mjs");
runMutants({
  test: TEST,
  target: "runtime/pi/evidence_gate.mjs",
  controlMustSay: CONTROL,
  mutants: [
    // the refusal and its order
    { name: "A1 the refusal ignores the switch", find: `const category = fastFailOn() ? unreachableByKey.get(keyOf(key)) : undefined;`, replace: `const category = unreachableByKey.get(keyOf(key));`, mustSay: esc("off again: the memory is ignored, main's behaviour") },
    { name: "A2 the refusal is checked before BLOCKED", find: `      if (countFor(key) >= boundedLimit) throw blocked(key);\n      // The stronger stop above wins; this softer refusal only tells the model to pick another host.\n      const category = fastFailOn() ? unreachableByKey.get(keyOf(key)) : undefined;\n      if (category) throw refusal(keyOf(key), category);`, replace: `      const category = fastFailOn() ? unreachableByKey.get(keyOf(key)) : undefined;\n      if (category) throw refusal(keyOf(key), category);\n      if (countFor(key) >= boundedLimit) throw blocked(key);`, mustSay: esc("BLOCKED wins over the refusal for a host that is both") },
    { name: "A3 a refusal is counted as a failure of the host", find: `if (ownRefusals.has(error)) return error;`, replace: ``, mustSay: esc("returned as it is") },
    { name: "A4 the refusal says to stop instead of to change host", find: `Use a different host; do not substitute synthetic data.`, replace: `Stop source-dependent reporting; do not substitute synthetic data.`, mustSay: esc("UND_ERR_CONNECT_TIMEOUT: the host is refused afterwards") },
    { name: "A5 the refusal has the code of the stop instruction", find: `{ code: "SOURCE_HOST_UNREACHABLE", host: key }`, replace: `{ code: "SOURCE_ACCESS_BLOCKED", host: key }`, mustSay: esc("the refusal has its own code") },

    // what marks a host
    { name: "B1 a listed code is labelled and marks with the switch off", find: LABELLING, replace: `const category = !http ? unreachableCategory(error) : null;`, mustSay: esc("keeps the generic text") },
    { name: "B2 a failure that carries an HTTP status can mark", find: LABELLING, replace: `const category = fastFail ? unreachableCategory(error) : null;`, mustSay: esc("an error that says it carried a status keeps the HTTP text") },
    { name: "B3 a failure without a host key marks the shared bucket", find: MARK_COND, replace: `if (category && !succeededKeys.has(normalizedKey)) {`, mustSay: esc("a failure without a host still gets its text, and says nothing about the host") },
    { name: "B4 every failure with the switch on marks its host", edits: [{ find: MARK_COND, replace: `if (fastFail && key != null && !succeededKeys.has(normalizedKey)) {` }, { find: MARK_SET, replace: `unreachableByKey.set(normalizedKey, category ?? "connect_timeout");` }], mustSay: esc(`"ETIMEDOUT" is not on the list`) },

    // the closed list
    ...LIST.map(([code, category]) => ({ name: `C1 ${code} dropped from the list`, find: `  ["${code}", "${category}"],\n`, replace: ``, mustSay: esc(`${code}: text of its category`) })),
    { name: "C2 ETIMEDOUT added to the list", find: `["ENETUNREACH", "no_route"],`, replace: `["ENETUNREACH", "no_route"],\n  ["ETIMEDOUT", "connect_timeout"],`, mustSay: esc(`"ETIMEDOUT" is not on the list`) },
    { name: "C3 every code is accepted", find: `return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? null;`, replace: `return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? "connect_timeout";`, mustSay: esc(`"ETIMEDOUT" is not on the list`) },
    { name: "C4 two categories share a text", find: `dns: { reason: "could not resolve the host name"`, replace: `dns: { reason: "found no route to the host"`, mustSay: esc("ENOTFOUND: text of its category") },
    { name: "C5 ECONNRESET put back on the list", find: `["ENETUNREACH", "no_route"],`, replace: `["ENETUNREACH", "no_route"],\n  ["ECONNRESET", "refused"],`, mustSay: esc("ECONNRESET 1: the generic text, no word about the host") },

    // how the chain is read
    { name: "D1 an abort in the chain no longer wins over a code", find: `if (abortInChain(error)) return null;`, replace: ``, mustSay: esc("abort-0: the abort text, with no word about the host") },
    { name: "D2 the chain is read three levels deep", find: LOOP, replace: LOOP.replace("depth < 4", "depth < 3"), mustSay: esc("depth 3") },
    { name: "D3 the chain is read five levels deep", find: LOOP, replace: LOOP.replace("depth < 4", "depth < 5"), mustSay: esc("the listed code four levels down") },
    { name: "D4 the errors of an AggregateError are walked", find: FIRST_CODE, replace: `    const inner = Array.isArray(current.errors) ? current.errors.find((e) => typeof e?.code === "string") : undefined;\n    if (typeof current.code !== "string" && inner) return UNREACHABLE_CATEGORY_BY_CODE.get(inner.code) ?? null;\n${FIRST_CODE}`, mustSay: esc("an AggregateError whose own code is missing (its errors are not walked)") },
    { name: "D5 the first code found no longer decides", find: FIRST_CODE, replace: `    if (UNREACHABLE_CATEGORY_BY_CODE.has(current.code)) return UNREACHABLE_CATEGORY_BY_CODE.get(current.code);`, mustSay: esc("an outer code outside the list over an inner listed one (the first code decides)") },

    // how the switch is read
    { name: "E1 any function counts as the switch on", find: FAST_FAIL_ON, replace: `const fastFailOn = () => typeof options?.fastFail === "function";`, mustSay: esc("fastFail returns false: UND_ERR_CONNECT_TIMEOUT keeps the generic text") },
    { name: "E2 a truthy value counts as the switch on", find: FAST_FAIL_ON, replace: `const fastFailOn = () => typeof options?.fastFail === "function" && !!options.fastFail();`, mustSay: esc("fastFail returns a truthy value that is not true: UND_ERR_CONNECT_TIMEOUT keeps the generic text") },
    { name: "E3 the switch is read once, at creation", find: FAST_FAIL_ON, replace: `const fastFailOn = ((on) => () => on)(typeof options?.fastFail === "function" && options.fastFail() === true);`, mustSay: esc("off again: the memory is ignored, main's behaviour") },
    { name: "E4 the switch is read a second time inside one failure", find: LABELLING, replace: `const category = fastFailOn() && !http ? unreachableCategory(error) : null;`, mustSay: esc("one failure reads the switch once") },
    { name: "E5 with the switch off the error is read before the third failure is answered", find: OFF_RETURN, replace: "      const message = String(error?.message ?? error ?? \"\");\n      if (!fastFail && failures >= boundedLimit) return blocked(normalizedKey);", mustSay: esc("the error is not read for the third failure") },

    // the third failure with the switch on is still the stop instruction
    { name: "L1 with the switch on the third failure is no longer the stop instruction", find: `if (failures >= boundedLimit) return blocked(normalizedKey);`, replace: ``, mustSay: esc("the third reset is the stop instruction, as for any failure") },

    // how long a mark lasts
    { name: "H1 a later success clears the mark", find: `failuresByKey.delete(keyOf(key));`, replace: `failuresByKey.delete(keyOf(key));\n      unreachableByKey.delete(keyOf(key));`, mustSay: esc("a later success does not clear the mark: it lasts for the run") },

    // a host that answered in this run is never marked
    { name: "U1 a host that answered can be marked", find: MARK_COND, replace: `if (category && key != null) {`, mustSay: esc("a host that answered earlier gets its text, without a word about marking it") },
    { name: "U2 a success is not remembered", find: `succeededKeys.add(keyOf(key));`, replace: ``, mustSay: esc("a host that answered earlier gets its text, without a word about marking it") },
    { name: "U3 a success is remembered under the raw key", find: `succeededKeys.add(keyOf(key));`, replace: `succeededKeys.add(key);`, mustSay: esc(`a success recorded under the number 7 covers the host key "7"`) },
    { name: "U4 a failure looks the success up under the raw key", find: MARK_COND, replace: `if (category && key != null && !succeededKeys.has(key)) {`, mustSay: esc(`a success recorded under "9" covers the host key 9`) },

    // the sentence that the host will not be tried again
    { name: "S1 the sentence is never said", find: NOTE_SLOT, replace: "", mustSay: esc("UND_ERR_CONNECT_TIMEOUT: text of its category, and it says the host will not be tried again") },
    { name: "S2 the sentence follows the label, not the mark", find: NOTE_SLOT, replace: "${category ? `${UNREACHABLE_NOTE} ` : \"\"}", mustSay: esc("a listed code without a host key: the sentence is there exactly when the failure marked the host") },
    { name: "S3 the sentence is said for every failure with the switch on", find: NOTE_SLOT, replace: "${fastFail ? `${UNREACHABLE_NOTE} ` : \"\"}", mustSay: esc("a code outside the list: the sentence is there exactly when the failure marked the host") },
    { name: "S4 the sentence is said with the switch off too", find: NOTE_SLOT, replace: "${UNREACHABLE_NOTE} ", mustSay: esc("keeps the generic text") },

    // what the model reads
    { name: "F1 the first failure keeps the raw error as cause", find: `aborted ? { request_aborted: true } : {},`, replace: `aborted ? { request_aborted: true, cause: error } : { cause: error },`, mustSay: /nothing of the raw error is carried|the raw error is not kept as cause/ },
  ],
});

console.log("-- the switch, the question before every request and what a hop, a body read or the timer may tell the circuit: runtime/pi/newsroom.ts");
runMutants({
  test: TEST,
  controlMustSay: CONTROL,
  mutants: [
    // the switch
    { name: "G1 every value but 0 turns the switch on", find: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" }`, replace: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL !== "0" }`, mustSay: esc("value undefined: main's text") },
    { name: "G2 the switch is always on", find: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" }`, replace: `{ fastFail: () => true }`, mustSay: esc("value undefined: main's text") },
    { name: "G3 the switch is read once, when the module loads", find: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" }`, replace: `{ fastFail: ((on) => () => on)(process.env.NEWSROOM_FAST_FAIL === "1") }`, mustSay: esc("value undefined: main's text") },
    { name: "G4 the switch is not handed to the circuit", find: `createSourceAccessCircuit(3, { fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" })`, replace: `createSourceAccessCircuit(3)`, mustSay: esc("tools: the first failure has the connect timeout text") },

    // safeFetch: the question before every request and the host a failure belongs to
    { name: "G5 safeFetch no longer asks the circuit before a request", find: `      sourceAccessCircuit.assertAvailable(current.hostname.toLowerCase());\n`, replace: ``, mustSay: esc("refusal 0: never the stop instruction") },
    { name: "G6 safeFetch records a failure without the host", find: `      current?.hostname?.toLowerCase(),\n    );`, replace: `      undefined,\n    );`, mustSay: esc("tools: the first failure has the connect timeout text") },
    { name: "G7 safeFetch records the failure of a hop under the host the request started with", find: `      current?.hostname?.toLowerCase(),\n    );`, replace: `      new URL(urlText).hostname.toLowerCase(),\n    );`, mustSay: esc("the host that redirected is still asked: the failure of its hop did not mark it") },
    { name: "G8 safeFetch asks the circuit for the first URL only, not for the hops", find: `      sourceAccessCircuit.assertAvailable(current.hostname.toLowerCase());\n`, replace: `      if (redirect === 0) sourceAccessCircuit.assertAvailable(current.hostname.toLowerCase());\n`, mustSay: esc("refused at the hop, and it names the host of the hop") },

    // download_data: a body that fails after the headers. Two defences stack: the guard `timedOut &&` keeps a body error that is not the
    // tool's own timeout away from the circuit, and the success record in the catch makes the host count as having answered (the circuit's
    // own `succeededKeys` then refuses to mark it). G11 removes both.
    { name: "G9 download_data counts a body error that is not the 30 s timeout (guard removed)", find: COUNTED, replace: `const counted = bodyPhase ? sourceAccessCircuit.recordFailure("download_data body read", error, answeredHost) : error;`, mustSay: esc("download_data: after a body error the host has answered: a later connect timeout is its first failure") },
    { name: "G10 download_data no longer records the host as answered when its body read fails", find: `        if (bodyPhase && !timedOut) sourceAccessCircuit.recordSuccess(answeredHost);\n`, replace: ``, mustSay: esc("download_data: after a body error the host has answered: a later connect timeout is its first failure") },
    {
      name: "G11 download_data: both defences removed, a body error marks the host",
      edits: [
        { find: COUNTED, replace: `const counted = bodyPhase ? sourceAccessCircuit.recordFailure("download_data body read", error, answeredHost) : error;` },
        { find: `        if (bodyPhase && !timedOut) sourceAccessCircuit.recordSuccess(answeredHost);\n`, replace: `` },
      ],
      mustSay: esc("download_data: the host is not marked by its body, the next request is sent"),
    },

    // the success records
    { name: "G12 download_data no longer records the success of a download", find: `        if (!frozen) sourceAccessCircuit.recordSuccess(answeredHost);\n`, replace: ``, mustSay: esc("tools: a connect timeout after an earlier answer gets its text but does not mark the host") },
    { name: "G13 safeFetch no longer records the success of a fetch_url request", find: `        if (!options.deferSuccess) sourceAccessCircuit.recordSuccess(current.hostname.toLowerCase());\n`, replace: ``, mustSay: esc("fetch_url: a host that answered (its body then broke) is not marked by a later connect timeout") },

    // fetch_url: the body read stays out of the circuit (its other defence is the success record of safeFetch, G13)
    { name: "G14 fetch_url hands a failed body read to the circuit", find: `await readBodyBytes(response.body, maxBytes, { truncate: true });`, replace: `await readBodyBytes(response.body, maxBytes, { truncate: true }).catch((error: any) => { throw sourceAccessCircuit.recordFailure("fetch_url body read", error, new URL(urlText).hostname.toLowerCase()); });`, mustSay: esc("fetch_url: a body error is not turned into a source-access failure") },

    // The 30 s timer. The real abort reason is the platform's AbortError (numeric code 20), which the circuit rejects twice (an abort anywhere in the
    // chain, and only string codes), so no real slip lets a listed code reach it from here; these two are constructed: the timer aborts with a
    // reason that carries a listed code, and the circuit is handed a listed-coded error for the body timeout.
    { name: "G15 [constructed] the 30 s timer aborts with a reason that carries a listed code", find: `const timeout = setTimeout(() => { timedOut = !signal?.aborted; controller.abort(); }, DOWNLOAD_TIMEOUT_MS);`, replace: `const timeout = setTimeout(() => { timedOut = !signal?.aborted; controller.abort(${LISTED_ERROR}); }, DOWNLOAD_TIMEOUT_MS);`, mustSay: esc("the structured timeout, as before") },
    { name: "G16 [constructed] the circuit is handed a listed-coded error for a body timeout", find: COUNTED, replace: `const counted = timedOut && bodyPhase ? sourceAccessCircuit.recordFailure("download_data body read", ${LISTED_ERROR}, answeredHost) : error;`, mustSay: esc("the structured timeout after the headers, as before") },
  ],
});
