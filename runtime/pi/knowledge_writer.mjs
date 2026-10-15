// The knowledge group's writer for the records a visual tool needs saved: the claim record, a computation record and the query-row tables.
// With NEWSROOM_GROUP_HANDOFF=1 (exact value, default off) the flow layer passes each of these to this writer instead of the visual tool writing
// the file itself. The writer runs the very same store calls on the same arguments in the same order, so paths, bytes and the number of writes do
// not change; only who the boundary report names as the writer does (the asking tool stays listed as requested_by). A record the store rejects fails
// here exactly as it does today. Nothing here repairs, adds or fills in a record.
import { asHandoffWriter, groupEnforceEnabled, crossCallReportEnabled, trackExport } from "./groups.mjs";

export let handoffEnabled = () => process.env.NEWSROOM_GROUP_HANDOFF !== "0";
export const KNOWLEDGE_WRITER = "knowledge_writer";

const inKnowledge = (fn) => asHandoffWriter(KNOWLEDGE_WRITER, fn);

function assertRef(ref, prefix, what) {
  if (typeof ref !== "string" || !ref.startsWith(prefix) || ref.includes("..")) throw new Error(`KNOWLEDGE_WRITER_REF: ${what} must be saved under ${prefix}`);
}

// With the refusal on (NEWSROOM_GROUP_ENFORCE, on unless exactly "0"; K214 part B): before it writes, this writer checks what it is asked to write, using the flow layer's own functions
// (deps.verifyComputation: path = content address, rows hash to result_hash, the SQL re-run on the recorded inputs gives the same hash;
// deps.verifyQueryRows: the table equals the rows of the computation it is named after). A record that fails is not written. Off: no check, same calls.
const checked = (verify, run) => (groupEnforceEnabled() && verify ? Promise.resolve().then(verify).then(run) : run());

/** deps: { writeArtifactIfAbsent(ref, value), recordClaimArtifact(input, signal), verifyComputation?(ref, record, signal), verifyQueryRows?(ref, rows) } from the flow layer. */
export function knowledgeWriter(deps) {
  return {
    writeComputation(ref, record, signal) { assertRef(ref, "computations/", "a computation record"); return checked(deps.verifyComputation && (() => deps.verifyComputation(ref, record, signal)), () => inKnowledge(() => deps.writeArtifactIfAbsent(ref, record))); },
    writeQueryRows(ref, rows) { assertRef(ref, "runtime/query-rows/", "a query-rows table"); return checked(deps.verifyQueryRows && (() => deps.verifyQueryRows(ref, rows)), () => inKnowledge(() => deps.writeArtifactIfAbsent(ref, rows))); },
    recordClaim(input, signal) { return inKnowledge(() => deps.recordClaimArtifact(input, signal)); },
  };
}

// K315 (NEWSROOM_GROUP_CALL_REPORT, default on; off only when exactly "0"): report-only record of tools reaching this module's exports (key knowledge_writer.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  handoffEnabled = trackExport("knowledge_writer.mjs::handoffEnabled", handoffEnabled);
  knowledgeWriter = trackExport("knowledge_writer.mjs::knowledgeWriter", knowledgeWriter);
}
