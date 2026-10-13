// The agent group's writer for the decision records the visual-side tools produce: the expert-preference record, the award-mode status, the
// competition preflight and the vision critic's record. With NEWSROOM_GROUP_HANDOFF=1 (exact value, default off) the flow layer passes each of them to this writer instead of the
// tool writing the file itself. Same store call, same arguments, same order: paths, bytes and the number of writes do not change; only who the
// boundary report names as the writer does (the asking tool stays listed as requested_by). A record the store rejects fails here exactly as it
// does today. Handing a record over never changes what its status means: a status the model supplied is still reported as model-supplied.
import { asHandoffWriter, crossCallReportEnabled, trackExport } from "./groups.mjs";

export const DECISION_WRITER = "decision_writer";
export const DECISION_FOLDERS = ["editorial/preferences/", "editorial/award-runs/", "infographics/competition-preflight/", "infographics/vision-critics/"];

/** deps: { writeArtifactIfAbsent(ref, value) } from the flow layer. */
export function decisionWriter(deps) {
  return {
    writeDecision(ref, record) {
      if (typeof ref !== "string" || ref.includes("..") || !DECISION_FOLDERS.some((folder) => ref.startsWith(folder))) {
        throw new Error(`DECISION_WRITER_REF: a decision record must be saved under ${DECISION_FOLDERS.join(", ")}`);
      }
      return asHandoffWriter(DECISION_WRITER, () => deps.writeArtifactIfAbsent(ref, record));
    },
  };
}

// K315 (NEWSROOM_GROUP_CALL_REPORT=1, default off): report-only record of tools reaching this module's exports (key decision_writer.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  decisionWriter = trackExport("decision_writer.mjs::decisionWriter", decisionWriter);
}
