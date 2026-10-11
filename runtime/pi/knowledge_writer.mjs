// The knowledge group's writer for the records a visual tool needs saved: the claim record, a computation record and the query-row tables.
// With NEWSROOM_GROUP_HANDOFF=1 (exact value, default off) the flow layer passes each of these to this writer instead of the visual tool writing
// the file itself. The writer runs the very same store calls on the same arguments in the same order, so paths, bytes and the number of writes do
// not change; only who the boundary report names as the writer does (the asking tool stays listed as requested_by). A record the store rejects fails
// here exactly as it does today. Nothing here repairs, adds or fills in a record.
import { asHandoffWriter } from "./groups.mjs";

export const handoffEnabled = () => process.env.NEWSROOM_GROUP_HANDOFF === "1";
export const KNOWLEDGE_WRITER = "knowledge_writer";

const inKnowledge = (fn) => asHandoffWriter(KNOWLEDGE_WRITER, fn);

function assertRef(ref, prefix, what) {
  if (typeof ref !== "string" || !ref.startsWith(prefix) || ref.includes("..")) throw new Error(`KNOWLEDGE_WRITER_REF: ${what} must be saved under ${prefix}`);
}

/** deps: { writeArtifactIfAbsent(ref, value), recordClaimArtifact(input, signal) } from the flow layer. */
export function knowledgeWriter(deps) {
  return {
    writeComputation(ref, record) { assertRef(ref, "computations/", "a computation record"); return inKnowledge(() => deps.writeArtifactIfAbsent(ref, record)); },
    writeQueryRows(ref, rows) { assertRef(ref, "runtime/query-rows/", "a query-rows table"); return inKnowledge(() => deps.writeArtifactIfAbsent(ref, rows)); },
    recordClaim(input, signal) { return inKnowledge(() => deps.recordClaimArtifact(input, signal)); },
  };
}
