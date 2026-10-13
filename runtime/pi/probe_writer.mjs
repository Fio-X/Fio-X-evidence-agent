// The agent (flow) group's writer for the fetch-split diagnostic files (NEWSROOM_FETCH_SPLIT_PROBE=1). download_data belongs to the knowledge
// group, but the diagnostic lives under runtime/, which the flow group owns; the tool hands the finished record to this writer instead of writing
// it itself. Same store call, same arguments: path and bytes do not change; the boundary report names this writer and keeps the asking tool
// (download_data) as requested_by. Only the probe folder is accepted.
import { asHandoffWriter, crossCallReportEnabled, trackExport } from "./groups.mjs";

export const PROBE_WRITER = "probe_writer";
export const PROBE_FOLDER = "runtime/fetch-split-probe/";

/** deps: { writeArtifactIfAbsent(ref, value) } from the flow layer. */
export function probeWriter(deps) {
  return {
    writeDiagnostic(ref, record) {
      if (typeof ref !== "string" || ref.includes("..") || !ref.startsWith(PROBE_FOLDER)) {
        throw new Error(`PROBE_WRITER_REF: a split-probe diagnostic must be saved under ${PROBE_FOLDER}`);
      }
      return asHandoffWriter(PROBE_WRITER, () => deps.writeArtifactIfAbsent(ref, record));
    },
  };
}

// K315 (NEWSROOM_GROUP_CALL_REPORT=1, default off): report-only record of tools reaching this module's exports (key probe_writer.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  probeWriter = trackExport("probe_writer.mjs::probeWriter", probeWriter);
}
