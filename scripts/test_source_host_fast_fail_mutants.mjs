// Mutation check for scripts/test_source_host_fast_fail.mjs: each rule of NEWSROOM_FAST_FAIL is weakened once, in a temp copy, and the
// test must go red AND print that rule's own assertion text (a crash or a syntax error cannot pass as a catch). Two groups: the circuit
// (runtime/pi/evidence_gate.mjs) and the lines in runtime/pi/newsroom.ts that hand it the switch and ask it before every request.
import { runMutants } from "./mutant_lib.mjs";

const TEST = "test_source_host_fast_fail.mjs";
const esc = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const CONTROL = /test_source_host_fast_fail: ok \(\d+ checks\)/;

// the closed list, one mutant per code: dropping any single entry must be noticed by the code's own assertion
const LIST = [
  ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "refused_or_reset"],
  ["ECONNRESET", "refused_or_reset"],
  ["EHOSTUNREACH", "no_route"],
  ["ENETUNREACH", "no_route"],
];

// the gate that decides when to read the code of an error, written once so the two chain-depth mutants share the anchor
const LOOP = `  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {\n    if (typeof current.code === "string") return`;
const FIRST_CODE = `    if (typeof current.code === "string") return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? null;`;
const MARK = `if (category && key != null) unreachableByKey.set(normalizedKey, category);`;
const LABELLING = `const category = fastFailOn() && !http ? unreachableCategory(error) : null;`;
const FAST_FAIL_ON = `const fastFailOn = () => typeof options?.fastFail === "function" && options.fastFail() === true;`;

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
    { name: "B2 a failure that carries an HTTP status can mark", find: LABELLING, replace: `const category = fastFailOn() ? unreachableCategory(error) : null;`, mustSay: esc("and marks nothing") },
    { name: "B3 a failure without a host key marks the shared bucket", find: MARK, replace: `if (category) unreachableByKey.set(normalizedKey, category);`, mustSay: esc("but there is no host to mark") },
    { name: "B4 every failure marks its host", find: MARK, replace: `if (key != null) unreachableByKey.set(normalizedKey, category ?? "connect_timeout");`, mustSay: esc(`"ETIMEDOUT" marks nothing`) },

    // the closed list
    ...LIST.map(([code, category]) => ({ name: `C1 ${code} dropped from the list`, find: `  ["${code}", "${category}"],\n`, replace: ``, mustSay: esc(`${code}: text of its category`) })),
    { name: "C2 ETIMEDOUT added to the list", find: `["ENETUNREACH", "no_route"],`, replace: `["ENETUNREACH", "no_route"],\n  ["ETIMEDOUT", "connect_timeout"],`, mustSay: esc(`"ETIMEDOUT" is not on the list`) },
    { name: "C3 every code is accepted", find: `return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? null;`, replace: `return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? "connect_timeout";`, mustSay: esc(`"ETIMEDOUT" is not on the list`) },
    { name: "C4 two categories share a text", find: `dns: { reason: "could not resolve the host name"`, replace: `dns: { reason: "found no route to the host"`, mustSay: esc("ENOTFOUND: text of its category") },

    // how the chain is read
    { name: "D1 an abort in the chain no longer wins over a code", find: `if (abortInChain(error)) return null;`, replace: ``, mustSay: esc("abort-0 marks nothing") },
    { name: "D2 the chain is read three levels deep", find: LOOP, replace: LOOP.replace("depth < 4", "depth < 3"), mustSay: esc("depth 3") },
    { name: "D3 the chain is read five levels deep", find: LOOP, replace: LOOP.replace("depth < 4", "depth < 5"), mustSay: esc("the listed code four levels down") },
    { name: "D4 the errors of an AggregateError are walked", find: FIRST_CODE, replace: `    const inner = Array.isArray(current.errors) ? current.errors.find((e) => typeof e?.code === "string") : undefined;\n    if (typeof current.code !== "string" && inner) return UNREACHABLE_CATEGORY_BY_CODE.get(inner.code) ?? null;\n${FIRST_CODE}`, mustSay: esc("an AggregateError whose own code is missing (its errors are not walked)") },
    { name: "D5 the first code found no longer decides", find: FIRST_CODE, replace: `    if (UNREACHABLE_CATEGORY_BY_CODE.has(current.code)) return UNREACHABLE_CATEGORY_BY_CODE.get(current.code);`, mustSay: esc("an outer code outside the list over an inner listed one (the first code decides)") },

    // how the switch is read
    { name: "E1 any function counts as the switch on", find: FAST_FAIL_ON, replace: `const fastFailOn = () => typeof options?.fastFail === "function";`, mustSay: esc("fastFail returns false: UND_ERR_CONNECT_TIMEOUT keeps the generic text") },
    { name: "E2 a truthy value counts as the switch on", find: FAST_FAIL_ON, replace: `const fastFailOn = () => typeof options?.fastFail === "function" && !!options.fastFail();`, mustSay: esc("fastFail returns a truthy value that is not true: UND_ERR_CONNECT_TIMEOUT keeps the generic text") },
    { name: "E3 the switch is read once, at creation", find: FAST_FAIL_ON, replace: `const fastFailOn = ((on) => () => on)(typeof options?.fastFail === "function" && options.fastFail() === true);`, mustSay: esc("off again: the memory is ignored, main's behaviour") },

    // how long a mark lasts
    { name: "H1 a later success clears the mark", find: `failuresByKey.delete(keyOf(key));`, replace: `failuresByKey.delete(keyOf(key));\n      unreachableByKey.delete(keyOf(key));`, mustSay: esc("a later success does not clear the mark: it lasts for the run") },

    // what the model reads
    { name: "F1 the first failure keeps the raw error as cause", find: `aborted ? { request_aborted: true } : {},`, replace: `aborted ? { request_aborted: true, cause: error } : { cause: error },`, mustSay: /nothing of the raw error is carried|the raw error is not kept as cause/ },
  ],
});

console.log("-- the switch and the question before every request: runtime/pi/newsroom.ts");
runMutants({
  test: TEST,
  controlMustSay: CONTROL,
  mutants: [
    { name: "G1 every value but 0 turns the switch on", find: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" }`, replace: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL !== "0" }`, mustSay: esc("value undefined: main's text") },
    { name: "G2 the switch is always on", find: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" }`, replace: `{ fastFail: () => true }`, mustSay: esc("value undefined: main's text") },
    { name: "G3 the switch is read once, when the module loads", find: `{ fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" }`, replace: `{ fastFail: ((on) => () => on)(process.env.NEWSROOM_FAST_FAIL === "1") }`, mustSay: esc("value undefined: main's text") },
    { name: "G4 the switch is not handed to the circuit", find: `createSourceAccessCircuit(3, { fastFail: () => process.env.NEWSROOM_FAST_FAIL === "1" })`, replace: `createSourceAccessCircuit(3)`, mustSay: esc("tools: the first failure has the connect timeout text") },
    { name: "G5 safeFetch no longer asks the circuit before a request", find: `      sourceAccessCircuit.assertAvailable(current.hostname.toLowerCase());\n`, replace: ``, mustSay: esc("refusal 0: never the stop instruction") },
    { name: "G6 safeFetch records a failure without the host", find: `      current?.hostname?.toLowerCase(),\n    );`, replace: `      undefined,\n    );`, mustSay: esc("refusal 0: never the stop instruction") },
  ],
});
