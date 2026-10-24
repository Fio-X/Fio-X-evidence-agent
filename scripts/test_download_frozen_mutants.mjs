// Mutation check for the frozen-hit lines of download_data (scripts/test_download_frozen.mjs, cases 8a-8f): a frozen hit clears the host's
// failure count like a real success, is refused by a blocked or unreachable host through the circuit's own two calls, and a copy refused before
// the body phase leaves the count alone. Each line is weakened once, in a temp copy; the test must go red AND print that case's own text.
import { runMutants } from "./mutant_lib.mjs";

const esc = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

runMutants({
  test: "test_download_frozen.mjs",
  controlMustSay: /test_download_frozen: ok \(\d+ assertions\)/,
  mutants: [
    { name: "F1 a frozen hit no longer records the success", find: `    sourceAccessCircuit.recordSuccess(answeredHost);\n`, replace: `    if (!frozen) sourceAccessCircuit.recordSuccess(answeredHost);\n`, mustSay: esc("8a: after the frozen hit the next failure is 1/3 again") },
    { name: "F2 a frozen hit skips the circuit's availability question", find: `        try { sourceAccessCircuit.assertAvailable(host); } catch (error: any) { throw sourceAccessCircuit.recordFailure("network evidence fetch", error, host); }\n`, replace: ``, mustSay: esc("8d: a frozen hit on a blocked host is refused and counted once more") },
    { name: "F3 the refusal skips recordFailure (a hand-made throw)", find: `throw sourceAccessCircuit.recordFailure("network evidence fetch", error, host); }\n      }\n    }\n    const response`, replace: `throw error; }\n      }\n    }\n    const response`, mustSay: esc("8d: a frozen hit on a blocked host is refused and counted once more") },
    { name: "F4 the switch no longer gates the frozen copy", find: `const frozen = downloadFrozenEnabled() ? await readFrozenEntry(root, params.url) : null;`, replace: `const frozen = await readFrozenEntry(root, params.url);`, mustSay: esc("1: value '0' is not on: fetch is called") },
    { name: "F5 any failure clears the count, not only one after the headers", find: `if (bodyPhase && !timedOut) sourceAccessCircuit.recordSuccess(answeredHost);`, replace: `if (!timedOut) sourceAccessCircuit.recordSuccess(answeredHost);`, mustSay: esc("8a: second failure is 2/3") },
    { name: "F6 an oversize frozen copy counts as a request that answered", find: `if (frozenBytes.byteLength > MAX_DATASET_BYTES) throw new Error("Dataset exceeds the 25 MB download limit");`, replace: `if (frozenBytes.byteLength > MAX_DATASET_BYTES) { bodyPhase = true; throw new Error("Dataset exceeds the 25 MB download limit"); }`, mustSay: esc("8f: the oversize refusal did not clear the count") },
  ],
});
